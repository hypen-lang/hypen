/**
 * HypenDurableObject — base class for running Hypen apps inside Cloudflare
 * Durable Objects with Hibernation WebSocket support.
 *
 * A thin host around `RemoteSession` (in `@hypen-space/core`), which owns the
 * remote protocol, nested-module registration, resources, and router
 * auto-wiring. This class provides only the Cloudflare-specific parts: the WS
 * upgrade + Hibernation acceptance, the `CFTransport`, and per-DO storage
 * binding. Subclasses implement `getConfig()` and `createEngine()`.
 *
 * Hibernation: the runtime can evict the DO (and all in-memory sessions)
 * between messages while the socket stays alive at the edge. `ensureSession`
 * lazily rebuilds on the next message; since the client won't re-send `hello`,
 * a non-hello first message synthesises one so the initial tree is re-sent
 * before the message is processed.
 */

import type { HypenApp, HypenModule, HypenModuleDefinition } from "@hypen-space/core/app";
import type { BaseEngine } from "@hypen-space/core/engine-base";
import type { RemoteClient, RemoteMessage } from "@hypen-space/core/remote";
import {
  RemoteSession,
  SessionManager,
  type SessionHost,
  type SessionTransport,
  type OutgoingMessage,
} from "@hypen-space/core/remote";
import type { DurableObjectStorage, DurableObjectStateStore } from "./durable-object-store.js";

// Minimal Cloudflare type stubs — shadowed at runtime by `cloudflare:workers`
// (which only resolves inside wrangler).

/** Minimal stub for Cloudflare's DurableObjectState */
export interface DurableObjectState {
  storage: DurableObjectStorage;
  /** Accept a WebSocket for the Hibernation API */
  acceptWebSocket(ws: WebSocket): void;
  /** Get all accepted WebSockets (survives hibernation) */
  getWebSockets(): WebSocket[];
}

// workerd provides `WebSocketPair` at runtime. We avoid `declare global` (a
// consumer also pulling in `@cloudflare/workers-types` would hit a
// duplicate-declaration error) and cast locally instead.
type WebSocketPairCtor = { new (): { 0: WebSocket; 1: WebSocket } };

/** Data carried on a hibernatable socket across a DO eviction. */
type HibernationAttachment = { hypenSessionId?: string };
function getWebSocketPair(): WebSocketPairCtor {
  return (globalThis as unknown as { WebSocketPair: WebSocketPairCtor }).WebSocketPair;
}

/**
 * Wrap a Cloudflare (hibernatable) WebSocket as a `SessionTransport`. Each
 * outgoing protocol message is JSON-serialised. Closing is best-effort — a
 * socket already closed by the edge throws, which we swallow.
 */
export class CFTransport implements SessionTransport {
  constructor(private readonly ws: WebSocket) {}

  send(message: OutgoingMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* socket already closed at the edge */
    }
  }
}

export interface HypenDurableObjectConfig {
  /** The primary module definition (built via `app.defineState(...).build()`). */
  module: HypenModuleDefinition<any>;
  /** Hypen DSL template string for the primary UI. */
  template: string;
  /** Module name used in protocol messages (default: "App"). */
  moduleName?: string;
  /**
   * The `HypenApp` registry of named modules. Required for multi-module apps:
   * nested-module state registration and `Router {}` auto-wiring resolve
   * route targets against it. Omit for a single-module app.
   */
  app?: HypenApp;
  /**
   * Templates for components that are NOT registered on `app` — e.g. a
   * stateless `BottomNav` built with bare `app.defineState({})` so its
   * `@state.*` falls through to the primary module. The Bun server discovers
   * these by filename; a DO has no filesystem, so they're listed here.
   * Name → Hypen DSL template.
   */
  componentTemplates?: Record<string, string>;
  /**
   * SVG resource bundle for `Icon(@resources.foo)` references. Name → raw SVG.
   */
  resources?: Record<string, string>;
  /** Mirror actions/state to other sockets sharing this DO (default false). */
  syncActions?: boolean;
}

export abstract class HypenDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;

  /**
   * Live sessions keyed by WebSocket identity. Emptied on hibernation —
   * `ensureSession` lazily re-creates entries when the DO wakes.
   */
  private sessions = new Map<WebSocket, RemoteSession>();

  /** One session manager per DO; created lazily once the config is known. */
  private _sessionManager: SessionManager | null = null;

  /** Built-once `SessionHost` shared across this DO's sessions. */
  private _host: SessionHost | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  /** Subclass must provide the app config (module + template + registry). */
  abstract getConfig(): HypenDurableObjectConfig;

  /** Subclass must provide an engine factory (WASM creation is platform-specific). */
  abstract createEngine(): BaseEngine;

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Create a WebSocketPair — client goes to the caller, server stays here.
    //
    // Compression: there is no per-socket knob here. workerd handles
    // permessage-deflate transparently when the Worker sets the
    // `web_socket_compression` compatibility flag in wrangler.jsonc; without
    // it, frames are always sent uncompressed. It is negotiated per-connection,
    // so clients that don't offer the extension are unaffected.
    const pair = new (getWebSocketPair())();
    const client = pair[0];
    const server = pair[1];

    // Accept the server-side socket through the Hibernation API so CF can
    // evict this DO from memory while keeping the WebSocket alive at the edge.
    this.ctx.acceptWebSocket(server);

    // Bind DO storage so persistence calls route to this DO's storage.
    this.bindStorage();

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  /**
   * Message arrived on an accepted WebSocket. After hibernation the DO is
   * reconstructed, so the session is lazily re-created and fed to
   * `RemoteSession.receive`.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    let msg: RemoteMessage;
    try {
      msg = JSON.parse(text) as RemoteMessage;
    } catch {
      return; // ignore unparseable messages
    }

    // Re-bind storage on every message — after a wake the storage handle may
    // be freshly recreated, and the session we're about to (re)build needs it
    // in place before any load/save runs.
    this.bindStorage();

    const session = this.ensureSession(ws);

    // A client that believes it is still connected (post-hibernation, or a
    // legacy client that never sent `hello`) sends a non-hello first message.
    // Synthesise the handshake so the session renders and ships its initial
    // tree before the real message is processed.
    //
    // The synthesised hello MUST carry the session id the client already
    // established. Without it the wake path asks for a brand-new session
    // (`sessionId: new` in the logs), so the engine restarts from its initial
    // state, module state is discarded, and the client is sent a fresh
    // `initialTree` that re-creates its entire element tree — which, being a
    // first batch, also suppresses every enter animation. With it, the
    // session RESUMES and the wake is invisible to the client.
    if (msg.type !== "hello" && !session.helloReceived) {
      await session.receive({
        type: "hello",
        sessionId: this.rememberedSessionId(ws),
      } as RemoteMessage);
    }

    await session.receive(msg);

    // Keep the id beside the socket so the NEXT hibernation can resume too.
    this.rememberSessionId(ws, session);
  }

  /**
   * Called by the CF runtime when a WebSocket closes. Tears the session down —
   * `RemoteSession.destroy` runs the disconnect hook and flushes persisted
   * state via the bound store.
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.destroySession(ws);
  }

  /**
   * Cloudflare reports abnormal socket termination separately from a clean
   * close. Treat both paths identically so session state, timers, and module
   * lifecycle resources cannot leak inside a long-lived DO isolate.
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.destroySession(ws);
  }

  private async destroySession(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    await session.destroy();
  }

  /** Lazily create (once) the per-DO session manager. */
  private getSessionManager(): SessionManager {
    if (!this._sessionManager) {
      this._sessionManager = new SessionManager();
    }
    return this._sessionManager;
  }

  /**
   * Build (once) the `SessionHost` adapter `RemoteSession` consumes. Mirrors
   * `RemoteServer.getHost()` but sources its module/template/registry from
   * `getConfig()` and its engine from the subclass's `createEngine()`.
   */
  private getHost(): SessionHost {
    if (this._host) return this._host;

    const config = this.getConfig();
    const self = this;

    const discoveredComponents = mergeComponentTemplates(
      config.app ?? null,
      config.componentTemplates,
    );

    this._host = {
      module: config.module as HypenModule<any>,
      moduleName: config.moduleName ?? "App",
      ui: config.template,
      resources: config.resources ?? {},
      app: config.app ?? null,
      syncActions: config.syncActions ?? false,
      sessionManager: this.getSessionManager(),
      discoveredComponents,
      createEngine() {
        return self.createEngine();
      },
      *otherSessions(current: RemoteSession) {
        for (const s of self.sessions.values()) if (s !== current) yield s;
      },
      *sessionsForId(sessionId: string) {
        for (const s of self.sessions.values()) if (s.sessionId === sessionId) yield s;
      },
      onSessionReady(_session: RemoteSession, _client: RemoteClient) {
        /* no-op: the DO has no per-connection hooks to fire */
      },
      onSessionDestroyed(_session: RemoteSession, _client: RemoteClient) {
        /* webSocketClose owns map removal */
      },
    };
    return this._host;
  }

  /**
   * Store the established session id beside the hibernatable socket.
   *
   * The DO's in-memory `sessions` map is emptied when the runtime evicts it,
   * but the socket stays open at the edge — so the wake path has to rebuild
   * the session, and needs the id to rebuild it as a RESUME rather than a
   * fresh one. Cloudflare's hibernation attachment is the sanctioned place to
   * keep a few bytes that outlive the eviction.
   *
   * Best-effort throughout: a host without the attachment API (tests, the
   * non-CF stubs) simply degrades to the old reset-on-wake behaviour rather
   * than failing a message.
   */
  private rememberSessionId(ws: WebSocket, session: RemoteSession): void {
    const id = session.sessionId;
    if (!id) return;
    const sock = ws as WebSocket & {
      serializeAttachment?: (value: unknown) => void;
      deserializeAttachment?: () => unknown;
    };
    if (typeof sock.serializeAttachment !== "function") return;
    try {
      const current =
        typeof sock.deserializeAttachment === "function"
          ? ((sock.deserializeAttachment() as HibernationAttachment | null) ?? {})
          : {};
      if (current.hypenSessionId === id) return; // already current
      sock.serializeAttachment({ ...current, hypenSessionId: id });
    } catch {
      // Attachment is an optimisation, never a correctness requirement.
    }
  }

  /** The session id stashed by [rememberSessionId], if this host supports it. */
  private rememberedSessionId(ws: WebSocket): string | undefined {
    const sock = ws as WebSocket & { deserializeAttachment?: () => unknown };
    if (typeof sock.deserializeAttachment !== "function") return undefined;
    try {
      return (sock.deserializeAttachment() as HibernationAttachment | null)?.hypenSessionId;
    } catch {
      return undefined;
    }
  }

  /** Get or lazily (re)create the session for a WebSocket. */
  private ensureSession(ws: WebSocket): RemoteSession {
    let session = this.sessions.get(ws);
    if (session) return session;

    const transport = new CFTransport(ws);
    // `helloGraceMs: null` disables the auto-init timer — initialisation is
    // driven explicitly (real or synthesised `hello`) so it always completes
    // before the triggering message is dispatched, and no timer dangles
    // across a hibernation boundary.
    session = new RemoteSession(this.getHost(), transport, {
      helloGraceMs: null,
      recoverySessionId: this.rememberedSessionId(ws),
    });
    this.sessions.set(ws, session);
    return session;
  }

  /**
   * Bind this DO's storage to every `.persist(durableObjectStore(...))` state
   * store — the primary module plus any named modules on the registry. Called
   * on `fetch` and on every message so the store always references the
   * current (possibly post-wake) storage instance.
   */
  private bindStorage(): void {
    const config = this.getConfig();
    bindStore(config.module.stateStore, this.ctx.storage);
    if (config.app) {
      for (const def of config.app.components.values()) {
        bindStore(def.stateStore, this.ctx.storage);
      }
    }
    this.onStorageBound(this.ctx.storage);
  }

  /**
   * Hook called after persistence stores are bound, on `fetch` and on every
   * message (so it runs again post-hibernation). Override to wire app-specific
   * storage — e.g. binding the DO's `state.storage.sql` into a `bun:sqlite`
   * shim and seeding the schema. Default no-op. Idempotent work should guard
   * itself (the schema seed is run-once in the examples).
   */
  protected onStorageBound(_storage: DurableObjectStorage): void {
    // no-op by default
  }
}

/** Bind DO storage into a state store if it exposes the `__bindStorage` channel. */
function bindStore(store: unknown, storage: DurableObjectStorage): void {
  const s = store as DurableObjectStateStore<unknown> | undefined;
  if (s && typeof s.__bindStorage === "function") {
    s.__bindStorage(storage);
  }
}

/**
 * Build the `discoveredComponents` map `RemoteSession` reads — merging the
 * app registry with explicit `componentTemplates`. Exported for testing.
 *
 * `RemoteSession`'s component resolver reads `template`; its nested-module
 * state registration reads the `module` def. Two sources:
 *
 *   1. Named modules on `app` — carry their `module` def (for nested-module
 *      state) and, for inline `.ui(...)` components, a non-empty `.template`.
 *   2. `componentTemplates` — explicit name→template for components whose DSL
 *      lives outside the module def: anonymous fallbacks (e.g. BottomNav) AND
 *      named modules whose template is an external `.hypen` file (registry
 *      `.template` empty).
 *
 * An explicit template OVERRIDES an empty/absent registry template (so a named
 * module with an external `.hypen` resolves), but a non-empty registry
 * `.ui(...)` template is left intact, and the registry `module` def is always
 * preserved.
 */
export function mergeComponentTemplates(
  appRegistry: HypenApp | null,
  componentTemplates?: Record<string, string>,
): Map<string, { template: string; module?: HypenModuleDefinition<any> }> {
  const merged = new Map<
    string,
    { template: string; module?: HypenModuleDefinition<any> }
  >();
  if (appRegistry) {
    for (const [name, def] of appRegistry.components) {
      merged.set(name, { template: def.template ?? "", module: def });
    }
  }
  if (componentTemplates) {
    for (const [name, template] of Object.entries(componentTemplates)) {
      const existing = merged.get(name);
      if (!existing) {
        merged.set(name, { template });
      } else if (!existing.template) {
        existing.template = template;
      }
    }
  }
  return merged;
}
