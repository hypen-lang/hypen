/**
 * RemoteSession - Transport-agnostic per-client session for Hypen remote apps.
 *
 * One `RemoteSession` owns one logical client: a dedicated engine instance,
 * a module instance, a session id, and the logic that drives the Hypen remote
 * protocol (hello → sessionAck → initialTree → streaming patches).
 *
 * It does NOT know how bytes reach the client. That is the job of the
 * `SessionTransport` interface — a minimal `{ send, close }` contract that
 * can be backed by a Bun `ServerWebSocket`, an SSE `ReadableStream`, an
 * in-memory queue (see `AsyncQueueTransport`), or anything else.
 *
 * Backend devs can plug Hypen into an existing Express/Fastify/ws/uWebSockets
 * setup by:
 *
 *   1. Calling `server.prepare()` once (discovery + session manager init).
 *   2. Calling `server.createSession(transport)` per client.
 *   3. Forwarding incoming JSON messages via `session.receive(msg)`.
 *   4. Calling `session.destroy()` when the transport closes.
 *
 * Or, for a pure async-iterator style:
 *
 *   const transport = new AsyncQueueTransport();
 *   const session = server.createSession(transport);
 *   for await (const out of transport.stream()) { ...forward to client... }
 */

import type {
  HypenApp,
  HypenModule,
  HypenModuleDefinition,
} from "../app.js";
import { HypenModuleInstance, HypenApp as HypenAppClass } from "../app.js";
import { HypenGlobalContext } from "../context.js";
import { HypenRouter } from "../router.js";
import { ManagedRouter } from "../managed-router.js";
import type {
  DispatchActionMessage,
  HelloMessage,
  InitialTreeMessage,
  PatchMessage,
  RemoteClient,
  RemoteMessage,
  Session,
  SessionAckMessage,
  SessionExpiredMessage,
  StateUpdateMessage,
  UpdateStateMessage,
} from "./types.js";
import { SessionManager } from "./session.js";
import type { Patch } from "../types.js";
import { TemplateExpander } from "../patch-expand.js";
import { frameworkLoggers } from "../logger.js";
import { BaseEngine } from "../engine-base.js";

const log = frameworkLoggers.remote;

/**
 * Server → client messages emitted by a `RemoteSession`.
 */
export type OutgoingMessage =
  | InitialTreeMessage
  | PatchMessage
  | StateUpdateMessage
  | SessionAckMessage
  | SessionExpiredMessage;

/**
 * Minimal contract a `RemoteSession` needs to reach the client. Implement
 * this to plug Hypen into any transport.
 *
 * `send` receives a structured message — serialize however you like
 * (JSON, MessagePack, protobuf). Built-in adapters use `JSON.stringify`.
 */
export interface SessionTransport {
  send(message: OutgoingMessage): void;
  close(code?: number, reason?: string): void;
}

/**
 * The subset of `RemoteServer` state a session needs. Kept as an interface so
 * sessions can be used standalone in tests and so alternate hosts (e.g. a
 * Cloudflare Durable Object wrapper) can satisfy it without subclassing
 * `RemoteServer`.
 */
export interface SessionHost {
  readonly module: HypenModule<any>;
  readonly moduleName: string;
  readonly ui: string;
  readonly resources: Record<string, string>;
  readonly app: HypenApp | null;
  readonly syncActions: boolean;
  readonly sessionManager: SessionManager;
  readonly discoveredComponents: Map<
    string,
    { template: string; module?: HypenModuleDefinition<any> }
  >;

  /**
   * Construct a fresh engine for this session. Called once per session.
   *
   * Each session owns its own engine instance, so this must return a new
   * engine every call (not a shared singleton). This is the seam that keeps
   * `RemoteSession` engine-agnostic: `@hypen-space/server` returns
   * `new Engine()` (Node/Bun WASM), a Cloudflare Durable Object returns a
   * `CFEngine`, etc. The returned engine may be un-initialised — the session
   * calls `init()` itself.
   */
  createEngine(): BaseEngine;

  /** Other live sessions (for syncActions fan-out and allow-multiple peer broadcast). */
  otherSessions(self: RemoteSession): Iterable<RemoteSession>;

  /** Sessions that currently share `sessionId` (for kick-old / reject-new). */
  sessionsForId(sessionId: string): Iterable<RemoteSession>;

  /** Fired after hello → initialTree completes. */
  onSessionReady(session: RemoteSession, client: RemoteClient): void;

  /** Fired when the session is fully torn down. */
  onSessionDestroyed(session: RemoteSession, client: RemoteClient): void;
}

/**
 * Options passed when constructing a session.
 */
export interface RemoteSessionOptions {
  /** Internal client id (for logs and `RemoteClient.id`). Auto-generated if omitted. */
  clientId?: string;
  /**
   * Grace period in ms before a connected client that has not sent `hello`
   * is auto-initialised as a legacy (no-session-id) client. Set `null` to
   * disable the grace period entirely — useful for transports like SSE where
   * the first message may be deliberately delayed.
   * @default 1000
   */
  helloGraceMs?: number | null;
  /**
   * `socket` value stored on the `RemoteClient` record surfaced to
   * `onConnection`/`onDisconnection` callbacks. Pass through the raw
   * transport handle (e.g. a `ServerWebSocket`) so user code has the
   * escape hatch when it needs it.
   */
  socketHandle?: unknown;
}

let nextSessionCounter = 1;

/**
 * One client's worth of server-side state. Transport-agnostic.
 */
export class RemoteSession {
  readonly id: string;
  readonly connectedAt: Date;

  private readonly host: SessionHost;
  private readonly transport: SessionTransport;
  private readonly socketHandle: unknown;

  readonly engine: BaseEngine;
  private _moduleInstance: HypenModuleInstance<any> | null = null;

  /**
   * Session-lifetime template lowering: remote clients of any version
   * receive plain patches only, so every batch captured from the engine
   * is expanded before it is sent. ONE expander spans both capture
   * points (initial-tree and streaming) — a `registerTemplate` consumed
   * while building the initial tree must satisfy `instantiate`s arriving
   * in later streamed batches.
   */
  private readonly templateExpander = new TemplateExpander();

  private _sessionId: string | null = null;
  private _helloReceived = false;
  private _stateSubscribed = false;
  private _revision = 0;
  private _destroyed = false;
  private helloTimeout: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-session ManagedRouter auto-wired from `Router {}` blocks found
   * in the primary template. `null` when auto-wiring is disabled, no
   * Routers are present, or no registered modules matched any route's
   * element list. Torn down alongside the session in `destroy()`.
   */
  private _autoManagedRouter: ManagedRouter | null = null;
  /**
   * Toggled by `RemoteServer.disableAutoRouter()` when the host wants
   * to wire a ManagedRouter by hand via `onSessionCreate` instead.
   */
  autoRouterEnabled: boolean = true;

  // Promises that let callers hook into session lifecycle without racing
  // against the hello handshake or the transport close event.
  //   `ready`  — resolves after the hello handshake, primary module
  //              construction, and initial render have completed.
  //              `moduleInstance` is guaranteed non-null here.
  //   `closed` — resolves after `destroy()` has finished its teardown
  //              (onDisconnect hook, module teardown, session suspend).
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private _resolveReady!: () => void;
  private _resolveClosed!: () => void;

  constructor(
    host: SessionHost,
    transport: SessionTransport,
    options: RemoteSessionOptions = {}
  ) {
    this.host = host;
    this.transport = transport;
    this.id = options.clientId ?? `client_${nextSessionCounter++}`;
    this.connectedAt = new Date();
    this.socketHandle = options.socketHandle;

    this.ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
    this.closed = new Promise<void>((resolve) => {
      this._resolveClosed = resolve;
    });

    this.engine = host.createEngine();
    // init() is synchronous for wasm-node but declared async.
    this.engine.init().catch((err) => log.error("Engine init failed:", err));

    this.setupComponentResolver();
    if (Object.keys(host.resources).length > 0) {
      this.engine.registerResources(host.resources);
    }

    log.info(`Session ${this.id} created, engine initialized`);

    // Auto-initialise legacy clients that never send `hello`.
    const graceMs = options.helloGraceMs ?? 1000;
    if (graceMs !== null) {
      this.helloTimeout = setTimeout(() => {
        if (!this._helloReceived) {
          this.initializeSession(undefined, undefined).catch((err) =>
            log.error("Error initializing legacy session:", err)
          );
        }
      }, graceMs);
    }
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get moduleInstance(): HypenModuleInstance<any> | null {
    return this._moduleInstance;
  }

  get helloReceived(): boolean {
    return this._helloReceived;
  }

  get stateSubscribed(): boolean {
    return this._stateSubscribed;
  }

  get revision(): number {
    return this._revision;
  }

  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * The `RemoteClient` record surfaced to `onConnection`/`onDisconnection`
   * callbacks. Useful to construct consistently from both the Bun adapter
   * and custom transports.
   */
  toRemoteClient(): RemoteClient {
    return {
      id: this.id,
      socket: this.socketHandle,
      connectedAt: this.connectedAt,
    };
  }

  /**
   * Feed a client → server message into this session.
   *
   * Invoked by the transport adapter when it receives a message. Accepts
   * either a parsed `RemoteMessage` or a raw JSON string.
   */
  async receive(raw: RemoteMessage | string | Buffer): Promise<void> {
    if (this._destroyed) return;

    // `Buffer<ArrayBufferLike>`-as-narrowed-union doesn't reliably collapse
    // to `RemoteMessage` in the `else` branch under the current @types/node,
    // so we project the non-raw case through an explicit assertion.
    let msg: RemoteMessage;
    try {
      if (typeof raw === "string" || raw instanceof Buffer) {
        msg = JSON.parse(raw.toString()) as RemoteMessage;
      } else {
        msg = raw as RemoteMessage;
      }
    } catch (err) {
      log.error(`Invalid message on session ${this.id}:`, err);
      return;
    }

    try {
      switch (msg.type) {
        case "hello": {
          const hello = msg as HelloMessage;
          await this.initializeSession(hello.sessionId, hello.props);
          break;
        }

        case "dispatchAction": {
          const action = msg as DispatchActionMessage;
          this.engine.dispatchAction(action.action, action.payload);

          if (this.host.syncActions) {
            for (const other of this.host.otherSessions(this)) {
              if (!other._helloReceived) continue;
              other.engine.dispatchAction(action.action, action.payload);
            }
          }
          break;
        }

        case "updateState": {
          const stateMsg = msg as UpdateStateMessage;
          this._moduleInstance?.updateState(stateMsg.state);

          if (this.host.syncActions) {
            for (const other of this.host.otherSessions(this)) {
              if (!other._helloReceived || !other._moduleInstance) continue;
              other._moduleInstance.updateState(stateMsg.state);
            }
          }
          break;
        }

        case "subscribeState": {
          this._stateSubscribed = true;
          log.info(`Session ${this.id} subscribed to state updates`);
          break;
        }

        default:
          // Unknown message type — ignore.
          break;
      }
    } catch (err) {
      log.error(`Error handling message on session ${this.id}:`, err);
    }
  }

  /**
   * Send an outgoing message through this session's transport. Exposed so
   * peer sessions can broadcast to each other (allow-multiple) without
   * touching transport internals.
   */
  send(message: OutgoingMessage): void {
    if (this._destroyed) return;
    try {
      this.transport.send(message);
    } catch (err) {
      log.error(`Failed to send message on session ${this.id}:`, err);
    }
  }

  /**
   * Close the transport WITHOUT expiring the session, so the client's
   * auto-reconnect resumes it (same session id → suspended state restored)
   * against freshly loaded code. Used by hot reload: re-rendering into a
   * live session leaves stale router-cached subtrees and broken reactive
   * wiring, so the reliable reload is a fast reconnect. Close code 1012 =
   * "service restart".
   */
  disconnectForReload(): void {
    this.transport.close(1012, "Hot reload");
  }

  /**
   * Notify the client their session is gone and close the transport.
   */
  expireAndClose(reason: "ttl" | "kicked" | "manual"): void {
    if (!this._sessionId) {
      this.transport.close(1000, "Session closed");
      return;
    }
    const expired: SessionExpiredMessage = {
      type: "sessionExpired",
      sessionId: this._sessionId,
      reason,
    };
    this.send(expired);
    this.transport.close(1000, "Session " + reason);
  }

  /**
   * Tear down the session. Call this from the transport adapter when the
   * underlying connection closes, or manually to evict a client.
   *
   * Runs `onDisconnect`, suspends the session so it can be resumed later,
   * and fires the host's `onSessionDestroyed` hook.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }

    const currentState = this._moduleInstance?.getState() ?? {};

    // onDisconnect hook
    if (this._sessionId && this.host.module.handlers.onDisconnect) {
      const session = this.host.sessionManager.getActiveSession(this._sessionId);
      if (session) {
        try {
          await this.host.module.handlers.onDisconnect({
            state: currentState,
            session,
          });
        } catch (err) {
          log.error(`onDisconnect threw on session ${this.id}:`, err);
        }
      }
    }

    // Suspend session if no other connections remain for it
    if (this._sessionId) {
      this.host.sessionManager.untrackConnection(this._sessionId, this);
      if (this.host.sessionManager.getConnectionCount(this._sessionId) === 0) {
        const session = this.host.sessionManager.getActiveSession(
          this._sessionId
        );
        if (session) {
          this.host.sessionManager.suspendSession(
            this._sessionId,
            currentState,
            async (expiredSession) => {
              if (this.host.module.handlers.onExpire) {
                await this.host.module.handlers.onExpire({
                  session: expiredSession,
                });
              }
            }
          );
        }
      }
    }

    if (this._autoManagedRouter) {
      try {
        await this._autoManagedRouter.stop();
      } catch (err) {
        log.error(`Auto-router stop failed on ${this.id}:`, err);
      }
      this._autoManagedRouter = null;
    }

    if (this._moduleInstance) {
      try {
        await this._moduleInstance.destroy();
      } catch (err) {
        log.error(`ModuleInstance.destroy() failed on ${this.id}:`, err);
      }
    }

    this.host.onSessionDestroyed(this, this.toRemoteClient());
    // Ensure `ready` never dangles: if teardown happens before init (e.g.
    // transport dies before hello arrives), unblock any waiter so they can
    // observe `closed` and clean up without deadlocking.
    this._resolveReady();
    this._resolveClosed();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private setupComponentResolver(): void {
    this.engine.setComponentResolver((componentName, _contextPath) => {
      const comp = this.host.discoveredComponents.get(componentName);
      if (comp) return { source: comp.template, path: componentName };
      // Server-based apps register modules programmatically with inline
      // `.ui()` templates and never populate `discoveredComponents`, so
      // fall back to the HypenApp registry. Without this, a template
      // referencing `Home()` renders an opaque Create the renderer drops.
      const registered = this.host.app?.get(componentName);
      if (registered?.template) {
        return { source: registered.template, path: componentName };
      }
      return null;
    });
  }

  private registerNestedModules(): void {
    const primary = this.host.moduleName;
    const registered: string[] = [];

    if (this.host.app) {
      for (const [name, def] of this.host.app.components) {
        if (name === primary) continue;
        const stateKeys =
          def.initialState !== null && typeof def.initialState === "object"
            ? Object.keys(def.initialState as object)
            : [];
        const snapshot =
          def.initialState !== null && typeof def.initialState === "object"
            ? structuredClone(def.initialState)
            : {};
        this.engine.registerModule(
          name,
          def.actions ?? [],
          stateKeys,
          snapshot
        );
        log.debug(
          `Registered nested module "${name}" (${def.actions?.length ?? 0} actions, ${stateKeys.length} state keys)`
        );
        registered.push(name);
      }
    }

    for (const [name, comp] of this.host.discoveredComponents) {
      if (name === primary) continue;
      if (!comp.module) continue;
      if (this.host.app?.has(name)) continue;

      const def = comp.module;

      // Skip pure UI components (no state, no actions, no lifecycle).
      // `loadDiscoveredComponents` creates an auto-stateless module
      // (`app.defineState({}).build()`) for every .hypen file without a
      // sidecar .ts, which means pure UI components like Notifications,
      // Profile, Messages, BottomNav, Feed, etc. all get registered as
      // nested modules. That registration doesn't shadow unscoped
      // `@state.x` bindings (those still hit the primary module), but
      // it does occupy a scope slot the engine may otherwise route
      // dependency updates through — and every extra module carries
      // revision bookkeeping overhead per render. When the module has
      // no state and no actions, registering it is pure noise.
      const hasState =
        def.initialState !== null &&
        typeof def.initialState === "object" &&
        Object.keys(def.initialState as object).length > 0;
      const hasActions = (def.actions?.length ?? 0) > 0;
      if (!hasState && !hasActions) continue;

      const stateKeys =
        def.initialState !== null && typeof def.initialState === "object"
          ? Object.keys(def.initialState as object)
          : [];
      const snapshot =
        def.initialState !== null && typeof def.initialState === "object"
          ? JSON.parse(JSON.stringify(def.initialState))
          : {};
      this.engine.registerModule(name, def.actions ?? [], stateKeys, snapshot);
      log.debug(`Registered nested module "${name}" from discovery`);
      registered.push(name);
    }

    // One line per session instead of one per module, and only the
    // modules an app author actually wrote — framework builtins
    // (`__Router`, `__Route`, `__Link`, ...) self-register in the shared
    // app registry on import and are pure noise at info level; the
    // per-module lines above remain available under debug logging.
    const visible = registered.filter((name) => !name.startsWith("__"));
    if (visible.length > 0) {
      log.info(
        `Registered ${visible.length} nested module${visible.length === 1 ? "" : "s"}: ${visible.join(", ")}`
      );
    }
  }

  private async initializeSession(
    requestedSessionId: string | undefined,
    props: Record<string, any> | undefined
  ): Promise<void> {
    if (this._helloReceived || this._destroyed) return;
    this._helloReceived = true;
    log.info(
      `Initializing session for ${this.id} (sessionId: ${requestedSessionId ?? "new"})`
    );

    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }

    let session: Session;
    let isNew = true;
    let isRestored = false;
    let restoredState: unknown = null;

    const sm = this.host.sessionManager;

    if (requestedSessionId) {
      const resumed = sm.resumeSession(requestedSessionId);
      if (resumed) {
        session = resumed.session;
        restoredState = resumed.savedState;
        isNew = false;
        isRestored = true;
      } else {
        const activeSession = sm.getActiveSession(requestedSessionId);
        if (activeSession) {
          const allowed = this.resolveConcurrentConnection(
            activeSession,
            props
          );
          if (!allowed) return;
          session = activeSession;
          isNew = false;
        } else {
          session = sm.createSession(props);
        }
      }
    } else {
      session = sm.createSession(props);
    }

    this._sessionId = session.id;
    sm.trackConnection(session.id, this);

    const sessionAck: SessionAckMessage = {
      type: "sessionAck",
      sessionId: session.id,
      isNew,
      isRestored,
    };
    this.send(sessionAck);
    log.info(`Sent sessionAck to ${this.id} (session: ${session.id})`);

    // Create ModuleInstance HERE (not in constructor) so that onCreated fires
    // right before renderSource. See original server.ts comment for why.
    if (!this._moduleInstance) {
      this._moduleInstance = new HypenModuleInstance(
        this.engine,
        this.host.module
      );
    }

    if (isRestored) {
      await this.triggerReconnect(session, restoredState);
    }

    await this._moduleInstance.waitForReady();

    this.registerNestedModules();

    // Flush state proxy microtasks so onCreated mutations propagate.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Capture initial render patches (initial tree + any re-render from onCreated state).
    // `batchAnimation` preludes are dropped: a stamp scopes exactly ONE batch
    // (first-patch contract), and concatenating accumulated batches into a
    // single initialTree array would let a stray prelude over-scope onto
    // patches from other batches — the initial tree never animates anyway.
    const initialPatches: Patch[] = [];
    this.engine.setRenderCallback((patches) => {
      initialPatches.push(
        ...this.templateExpander
          .expand(patches)
          .filter((p) => p.type !== "batchAnimation")
      );
    });

    try {
      this.engine.renderSource(this.host.ui);
    } catch (err) {
      log.error(`Failed to render UI for ${this.id}:`, err);
      this.transport.close(1011, "Render failed");
      return;
    }

    // Switch to the streaming callback for subsequent patches.
    this.setupStreamingRenderCallback();

    const initialMessage: InitialTreeMessage = {
      type: "initialTree",
      module: this.host.moduleName,
      state: this._moduleInstance.getState(),
      patches: initialPatches,
      revision: 0,
    };
    this.send(initialMessage);
    log.info(
      `Sent initialTree to ${this.id} (${initialPatches.length} patches)`
    );

    this.host.onSessionReady(this, this.toRemoteClient());
    this._resolveReady();

    // Auto-wire a ManagedRouter from the template's own Router {} blocks.
    // The user gets routing "for free" from the DSL — no addRoute calls
    // in their server code. Guarded by `_autoRouterEnabled` so callers
    // that want bespoke wiring can opt out via
    // `RemoteServer.disableAutoRouter()`.
    if (this.autoRouterEnabled) {
      this.autoWireManagedRouter();
    }
  }

  /**
   * Parse Router {} blocks out of the primary template and spin up a
   * per-session ManagedRouter bound to the shared engine, auto-adding
   * one route per Route() — components resolved from the HypenApp
   * registry. The primary module's `location` field (if present) is
   * kept in sync with the router path so the Router IR re-renders on
   * navigation.
   *
   * Both top-level routers (`moduleScope` = primary / unscoped) and
   * routers nested inside per-route module templates are registered
   * here, flattened into a single route table against the session's
   * `HypenRouter`. The URL is a single string, so nested-router routes
   * share the parent's URL space — authors who want sub-path semantics
   * must spell out the full prefix in their `Route(path: ...)`. On
   * pattern conflicts (multiple routes matching the same path),
   * `ManagedRouter` picks first-match, and the engine emits routers
   * in outer→inner order so primary routes win ties naturally.
   */
  private autoWireManagedRouter(): void {
    // A registry is only needed to resolve component-backed routes; inline
    // routes (`Route(path) { ...markup... }`) need none. Fall back to an empty
    // registry so a single-module app with an inline `Router {}` still gets its
    // `@router.push` handler + `state.location` mirror wired.
    const app = this.host.app ?? new HypenAppClass();

    // Collect router blocks from both the primary template AND every
    // discovered child component template. `discoverRouters` walks a
    // single IR tree and does not resolve `Foo()` component references
    // — child templates live in separate source strings in
    // `host.discoveredComponents`. Running discover on each separately
    // and concatenating (primary first) gives us the true cross-tree
    // router inventory. Without this pass, a nested `module Home {
    // Router { ... } }` block declared in `Home/component.hypen`
    // (the canonical `.source()`-discovery shape) is silently
    // invisible to the SDK and the route never mounts.
    const discovered: ReturnType<BaseEngine["discoverRouters"]> = [];
    const runDiscover = (source: string, label: string): void => {
      try {
        const blocks = this.engine.discoverRouters(source);
        for (const b of blocks) discovered.push(b);
      } catch (err) {
        log.error(`Auto-router: discoverRouters failed on ${label}:`, err);
      }
    };
    runDiscover(this.host.ui, this.id);
    for (const [name, comp] of this.host.discoveredComponents) {
      if (comp.template) runDiscover(comp.template, `${this.id} / ${name}`);
    }
    // Server-based apps carry child templates in the HypenApp registry
    // (`.module("Name").ui(...)`) instead of `discoveredComponents` —
    // scan those too so their nested Router blocks mount.
    if (this.host.app) {
      for (const [name, def] of this.host.app.components) {
        if (name === this.host.moduleName) continue;
        if (this.host.discoveredComponents.has(name)) continue;
        if (def.template) runDiscover(def.template, `${this.id} / ${name}`);
      }
    }
    if (discovered.length === 0) return;

    const primaryScope = this.host.moduleName.toLowerCase();

    // Build a single top-level ManagedRouter covering every route from
    // every discovered router block (primary AND nested). Multiple
    // `Router {}` blocks flatten into one route list — the engine's
    // own Router IR still renders them independently, but the SDK only
    // needs a single `HypenRouter` per session.
    const router = new HypenRouter();
    const globalContext = new HypenGlobalContext();
    const managed = new ManagedRouter(router, this.engine, app, globalContext);

    const primary = this._moduleInstance;
    if (primary) {
      globalContext.registerModule(primaryScope, primary);
    }

    let added = 0;
    const seenPaths = new Set<string>();
    for (const block of discovered) {
      for (const route of block.routes) {
        // First path wins — outer Router blocks emit first.
        if (seenPaths.has(route.path)) {
          log.debug(
            `Auto-router: path "${route.path}" already registered; ignoring nested duplicate`
          );
          continue;
        }
        const component = this.pickComponent(route.elementNames);
        if (!component) {
          log.debug(
            `Auto-router: no registered module matched route "${route.path}" — skipping`
          );
          continue;
        }
        managed.addRoute({ path: route.path, component });
        seenPaths.add(route.path);
        added += 1;
      }
    }

    // `added` counts component-backed routes (mounted via ManagedRouter).
    // Routes can also be fully INLINE — `Route(path: "/x") { ...markup... }`
    // with no component — in which case the engine's own Router IR renders
    // them straight from `state.location`, and there's nothing for
    // ManagedRouter to mount. We still need the URL→`location` mirror and the
    // `@router.push` action handler so navigation works. So: bail only if no
    // Router blocks were discovered at all; otherwise wire the router even
    // when `added === 0`.
    const locationKey = this.primaryHasLocationKey() ? "location" : null;
    if (added === 0 && !locationKey) {
      // No component routes and no `location` state to drive inline routes —
      // nothing this router could affect.
      log.debug(`Auto-router: nothing to mount for ${this.id}`);
      return;
    }

    // Mirror router path into primary module state's `location` so the
    // engine-level Router IR reconciles to the matching Route subtree.
    // Deferring via `queueMicrotask` keeps the engine write off the
    // synchronous notify path (Rust rejects re-entrant WASM state
    // proxy calls).
    if (locationKey) {
      router.onNavigate((rs) => {
        const path = rs.currentPath;
        queueMicrotask(() => {
          try {
            const state = this._moduleInstance?.getState() as
              | Record<string, unknown>
              | undefined;
            // Skip when already in sync — this mirror and the state →
            // router one below would otherwise ping-pong.
            if (state?.[locationKey] === path) return;
            this._moduleInstance?.updateState({ [locationKey]: path });
          } catch (err) {
            log.error(`Auto-router: state.${locationKey} sync failed:`, err);
          }
        });
      });

      // Mirror the other direction too: templates commonly navigate by
      // mutating `state.location` from a module action (the scaffold's
      // `@actions.navigate`). The engine's Router IR follows that state
      // directly, but module mount/unmount and per-route action handlers
      // follow the HypenRouter — without this push, navigating via a state
      // mutation renders the new route while its module (and thus its
      // actions) never activates.
      if (primary) {
        primary.onStateChange(() => {
          try {
            const loc = (primary.getState() as Record<string, unknown>)?.[
              locationKey
            ];
            if (typeof loc === "string" && loc && loc !== router.getCurrentPath()) {
              router.push(loc);
            }
          } catch (err) {
            log.error(`Auto-router: ${locationKey} → router sync failed:`, err);
          }
        });
      }
    }

    // `start()` installs the `@router.push`/`@router.back`/... action handlers
    // and subscribes the router. Needed for both component and inline routes.
    managed.start();
    // HypenRouter doesn't fire onNavigate on subscribe; kick an
    // explicit push so the initial route mounts.
    router.push(router.getCurrentPath());

    this._autoManagedRouter = managed;
  }

  /** Pick the first element name that resolves to a registered module. */
  private pickComponent(elementNames: string[]): string | null {
    const app = this.host.app;
    if (!app) return null;
    for (const name of elementNames) {
      if (app.has(name)) return name;
    }
    return null;
  }

  /** Does the primary module's initial state have a `location` field? */
  private primaryHasLocationKey(): boolean {
    const state = this._moduleInstance?.getState();
    return (
      state !== null &&
      state !== undefined &&
      typeof state === "object" &&
      "location" in state
    );
  }

  private setupStreamingRenderCallback(): void {
    this.engine.setRenderCallback((patches) => {
      if (this._destroyed) return;
      // Lower template patches ONCE, before the message object is built —
      // the same patchMessage fans out to allow-multiple peers below.
      patches = this.templateExpander.expand(patches);
      this._revision++;
      log.info(
        `Streaming ${patches.length} patches to ${this.id} (rev ${this._revision})`
      );

      const patchMessage: PatchMessage = {
        type: "patch",
        module: this.host.moduleName,
        patches,
        revision: this._revision,
      };
      this.send(patchMessage);

      if (this._stateSubscribed && this._moduleInstance) {
        const stateMessage: StateUpdateMessage = {
          type: "stateUpdate",
          module: this.host.moduleName,
          state: this._moduleInstance.getState(),
          revision: this._revision,
        };
        this.send(stateMessage);
      }

      // allow-multiple: fan out to other sessions sharing our sessionId.
      if (
        this._sessionId &&
        this.host.sessionManager.getConcurrentPolicy() === "allow-multiple"
      ) {
        for (const peer of this.host.sessionsForId(this._sessionId)) {
          if (peer === this) continue;
          peer.send(patchMessage);
          if (peer._stateSubscribed && this._moduleInstance) {
            const stateMessage: StateUpdateMessage = {
              type: "stateUpdate",
              module: this.host.moduleName,
              state: this._moduleInstance.getState(),
              revision: this._revision,
            };
            peer.send(stateMessage);
          }
        }
      }
    });
  }

  private resolveConcurrentConnection(
    existingSession: Session,
    _props: Record<string, any> | undefined
  ): boolean {
    const policy = this.host.sessionManager.getConcurrentPolicy();

    switch (policy) {
      case "kick-old": {
        for (const peer of this.host.sessionsForId(existingSession.id)) {
          if (peer === this) continue;
          peer.expireAndClose("kicked");
        }
        return true;
      }
      case "reject-new": {
        this.expireAndClose("kicked");
        return false;
      }
      case "allow-multiple":
      default:
        return true;
    }
  }

  private async triggerReconnect(
    session: Session,
    savedState: unknown
  ): Promise<void> {
    const handler = this.host.module.handlers.onReconnect;
    if (!handler) {
      // No handler: restore the suspended state automatically — resuming a
      // session and then discarding the state it was suspended with would
      // make resume a no-op. Defining `onReconnect` takes over the
      // decision (call `restore()` yourself, or don't).
      if (savedState !== null && typeof savedState === "object") {
        this._moduleInstance?.updateState(
          savedState as Record<string, unknown>
        );
      }
      return;
    }

    const restore = (state: unknown) => {
      if (state === null || typeof state !== "object") {
        log.warn(
          "restore() called with non-object state, ignoring:",
          typeof state
        );
        return;
      }
      this._moduleInstance?.updateState(state as Record<string, unknown>);
    };

    await handler({ session, restore });
    // `savedState` is threaded through for handlers that don't call restore().
    void savedState;
  }
}

// ---------------------------------------------------------------------------
// Built-in transports
// ---------------------------------------------------------------------------

/**
 * Wrap a Bun `ServerWebSocket` as a `SessionTransport`.
 *
 * Each outgoing message is JSON-serialized. The caller is responsible for
 * calling `session.receive()` on incoming messages and `session.destroy()`
 * on close.
 */
export function createBunWebSocketTransport(
  ws: { send(data: string): void; close(code?: number, reason?: string): void }
): SessionTransport {
  return {
    send(message) {
      ws.send(JSON.stringify(message));
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

/**
 * In-memory transport that buffers outgoing messages and exposes them as
 * an async iterator via `.stream()`. Lets you drive a session from code
 * that prefers `for await` over callbacks — e.g. piping to SSE, HTTP/2
 * server push, or gRPC streaming.
 *
 * @example
 * ```ts
 * const transport = new AsyncQueueTransport();
 * const session = server.createSession(transport);
 * for await (const msg of transport.stream()) {
 *   res.write(`data: ${JSON.stringify(msg)}\n\n`); // SSE
 * }
 * ```
 */
export class AsyncQueueTransport implements SessionTransport {
  private queue: OutgoingMessage[] = [];
  private waiters: Array<
    (value: IteratorResult<OutgoingMessage, void>) => void
  > = [];
  private closed = false;

  send(message: OutgoingMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined, done: true });
    }
  }

  /**
   * Async iterator over outgoing messages. Completes once the transport is
   * closed and the queue is drained.
   */
  stream(): AsyncIterableIterator<OutgoingMessage> {
    const self = this;
    const iter: AsyncIterableIterator<OutgoingMessage> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next(): Promise<IteratorResult<OutgoingMessage, void>> {
        if (self.queue.length) {
          return { value: self.queue.shift()!, done: false };
        }
        if (self.closed) {
          return { value: undefined, done: true };
        }
        return new Promise((resolve) => {
          self.waiters.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<OutgoingMessage, void>> {
        self.close();
        return { value: undefined, done: true };
      },
    };
    return iter;
  }
}
