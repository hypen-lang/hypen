/**
 * RemoteServer - Stream Hypen apps over WebSocket with Session Management
 *
 * Usage with inline UI:
 * ```typescript
 * import { RemoteServer } from "@hypen-space/server/remote";
 * import { app } from "@hypen-space/core";
 *
 * const counter = app
 *   .defineState({ count: 0 })
 *   .onAction("increment", ({ state }) => state.count++)
 *   .build();
 *
 * new RemoteServer()
 *   .module("Counter", counter)
 *   .ui(`Column { Text("Count: @{state.count}") }`)
 *   .listen(3000);
 * ```
 *
 * Usage with directory-based discovery (auto-resolves imports):
 * ```typescript
 * import { RemoteServer } from "@hypen-space/server/remote";
 * import chatModule from "./apps/chat/Chat/component.js";
 *
 * await new RemoteServer()
 *   .source("./apps/chat")
 *   .module("Chat", chatModule)
 *   .listen(3001);
 * ```
 */

import type { HypenModule, HypenModuleDefinition, HypenApp } from "@hypen-space/core/app";
import type {
  RemoteMessage,
  RemoteClient,
  RemoteServerConfig,
  SessionConfig,
} from "@hypen-space/core/remote";
import { readFile, readdir } from "fs/promises";
import { resolve, join, extname, basename } from "path";
import type { ServerWebSocket } from "bun";
import { SessionManager } from "@hypen-space/core/remote";
import {
  DEFAULT_PROCESS_RETAINED_BYTES,
  type DeviceBrokerConfig,
} from "@hypen-space/core/remote/device";
import { createWasmDeviceBrokerFactory, type WasmDeviceBrokerFactory } from "../device-broker.js";
import { frameworkLoggers } from "@hypen-space/core/logger";
import {
  discoverComponents,
  loadDiscoveredComponents,
} from "../discovery.js";
import { Engine } from "../engine.js";
import {
  RemoteSession,
  createBunWebSocketTransport,
  type OutgoingMessage,
  type SessionHost,
  type SessionTransport,
} from "./session.js";
import {
  getWebClientBundle,
  renderClientHtml,
  renderFallbackHtml,
} from "./web-client.js";
import { AgentSurface, type AgentOptions } from "./agent-http.js";
import { AgentHandle } from "./agent-handle.js";

const log = frameworkLoggers.remote;

/**
 * Device Capability Protocol (RFC 001) tuning for a `RemoteServer` — see
 * `RemoteServer.configureDevice()`. Every field is optional; the defaults
 * are the protocol's.
 */
export interface RemoteDeviceOptions {
  /**
   * Aggregate retained device upload bytes across every connection of this
   * process (default 1 GiB), next to each connection's own budget.
   */
  processRetainedBytes?: number;
  /** Retained device upload bytes per connection (default 128 MiB). */
  connectionRetainedBytes?: number;
  /**
   * Extra broker configuration for every device connection: bulk
   * scheduling, rates, violation budget, revision overrides. A per-session
   * `createSession(…, { deviceBrokerConfig })` takes precedence.
   */
  broker?: Omit<DeviceBrokerConfig, "ack" | "serverCapabilities" | "maxRetainedBytes">;
}

/** Logged once at startup when the upgrade admits every client. */
export const OPEN_ADMISSION_WARNING =
  "no allowedOrigins/authenticate configured — any client can connect; set them in production";

/**
 * Normalize an Origin for allowlist comparison: lowercase scheme + host,
 * default ports dropped, no path. Invalid input normalizes to itself so it
 * simply never matches.
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return origin.trim().toLowerCase();
  }
}

/**
 * WebSocket upgrade admission (RFC 001 §5, decision D1). `Origin` is a
 * browser-only defence (cross-site WebSocket hijacking); native clients send
 * none and authenticate through the app's `authenticate` hook instead.
 * Enforced exactly when configured, independent of the device plane:
 *
 *   - an allowlist is configured → an `Origin` must be in it, else 403; a
 *     request without `Origin` is admitted only by `authenticate` returning
 *     true (no authenticator ⇒ 403, fail closed);
 *   - a configured `authenticate` runs for every upgrade (also those WITH an
 *     allowed Origin);
 *   - neither configured → every upgrade is admitted (the server logs one
 *     startup warning, {@link OPEN_ADMISSION_WARNING}).
 *
 * Returns null to admit, or the refusal response.
 */
export async function admitUpgrade(
  req: Request,
  policy: {
    allowedOrigins: ReadonlySet<string> | null;
    authenticate?: (request: Request) => boolean | Promise<boolean>;
  }
): Promise<Response | null> {
  const origin = req.headers.get("origin");
  const forbidden = (why: string) => {
    log.warn(`Rejected WebSocket upgrade: ${why}`);
    return new Response("Forbidden", { status: 403 });
  };
  if (origin !== null) {
    if (policy.allowedOrigins && !policy.allowedOrigins.has(normalizeOrigin(origin))) {
      return forbidden(`origin ${origin} not allowed`);
    }
  } else if (!policy.authenticate && policy.allowedOrigins) {
    return forbidden("no Origin and no authenticator configured");
  }
  if (policy.authenticate) {
    let ok = false;
    try {
      ok = (await policy.authenticate(req)) === true;
    } catch (err) {
      log.warn("authenticate() threw — upgrade refused", err);
      ok = false;
    }
    if (!ok) return forbidden("authenticate() refused the connection");
  }
  return null;
}

/**
 * Builder pattern for hosting Hypen apps over WebSocket.
 *
 * Backs the turnkey `.listen(port)` entry point, but also exposes
 * transport-agnostic primitives — `prepare()`, `createSession(transport)` and
 * `createHandler()` — for plugging Hypen into an existing Express/Fastify/ws
 * setup or into alternate transports (SSE, gRPC, in-process testing).
 */
export class RemoteServer {
  private _module: HypenModule<any> | null = null;
  private _moduleName: string = "App";
  private _ui: string = "";
  private _sourceDir: string | null = null;
  private _discoveredComponents: Map<string, { template: string; module?: HypenModuleDefinition<any> }> = new Map();
  private _config: RemoteServerConfig = {};
  private _sessionConfig: SessionConfig = {};
  private _onConnectionCallbacks: Array<(client: RemoteClient) => void> = [];
  private _onDisconnectionCallbacks: Array<(client: RemoteClient) => void> = [];
  // Session-scoped hook: fires the instant a `RemoteSession` is constructed
  // (before hello / initial render). Callbacks get the session directly and
  // can await `session.ready` / `session.closed` for phase-scoped setup
  // (e.g. per-session `ManagedRouter`, HypenRouter, HypenGlobalContext).
  private _onSessionCreateCallbacks: Array<
    (session: RemoteSession) => void | Promise<void>
  > = [];
  private _sessions: Set<RemoteSession> = new Set();
  private _wsToSession: Map<ServerWebSocket<unknown>, RemoteSession> = new Map();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private _sessionManager: SessionManager | null = null;
  private _prepared = false;
  private _syncActions: boolean = false;
  /**
   * Device Capability Protocol (RFC 001) opt-out — the plane is on by
   * default. See `disableDevice()`.
   */
  private _deviceDisabled: boolean = false;
  /**
   * Why the device plane is off for this server (`disableDevice()` or an
   * incompatible setting), resolved at `prepare()` / `listen()`; null while
   * it is on.
   */
  private _deviceOffReason: string | null = null;
  private _deviceOptions: RemoteDeviceOptions = {};
  private _deviceBrokerFactory: WasmDeviceBrokerFactory | null = null;
  private _resources: Record<string, string> = {};
  private _app: HypenApp | null = null;
  private _host: SessionHost | null = null;
  /**
   * When true (default), each new session auto-wires a ManagedRouter
   * from any `Router { Route … }` blocks in the primary template. Flip
   * off via `disableAutoRouter()` when the host wants bespoke wiring.
   */
  private _autoRouter: boolean = true;
  /**
   * Options for the agent REST surface, or `null` — which is the default and
   * stays the default until `agent()` is called. See `agent-http.ts` for why
   * nothing enables it implicitly. Held separately from `_agent` so a
   * `stop()` / `listen()` cycle keeps the grant the caller made instead of
   * silently dropping the surface on restart.
   */
  private _agentOptions: AgentOptions | null = null;
  private _agent: AgentSurface | null = null;

  /**
   * Build (once) the `SessionHost` adapter that `RemoteSession` consumes.
   * Kept as a separate object because `RemoteServer`'s builder methods
   * (`.module(...)`, `.ui(...)`, `.app(...)`, `.resources(...)`,
   * `.syncActions()`) collide name-wise with the `SessionHost` accessors —
   * so we cannot have the class directly implement the interface.
   */
  private getHost(): SessionHost {
    if (this._host) return this._host;
    const server = this;
    this._host = {
      get module() {
        if (!server._module) throw new Error("Module not set");
        return server._module;
      },
      get moduleName() { return server._moduleName; },
      get ui() { return server._ui; },
      get resources() { return server._resources; },
      get app() { return server._app; },
      get syncActions() { return server._syncActions; },
      get deviceDisabled() { return server._deviceOffReason !== null; },
      get deviceMaxRetainedBytes() { return server._deviceOptions.connectionRetainedBytes; },
      // The Rust device broker, one per device connection; the factory's pool
      // is one aggregate retained-bytes budget for every device connection
      // this server hosts (RFC 001 §2.4/§5), next to each connection's own.
      get deviceBrokerFactory() { return server.deviceBrokerFactory(); },
      get sessionManager() {
        if (!server._sessionManager) {
          throw new Error(
            "RemoteServer not prepared. Call `await server.prepare()` or `.listen()` first."
          );
        }
        return server._sessionManager;
      },
      get discoveredComponents() { return server._discoveredComponents; },
      createEngine() {
        return new Engine();
      },
      *otherSessions(self) {
        for (const s of server._sessions) {
          if (s !== self) yield s;
        }
      },
      *sessionsForId(sessionId) {
        for (const s of server._sessions) {
          if (s.sessionId === sessionId) yield s;
        }
      },
      onSessionReady(_session, client) {
        for (const cb of server._onConnectionCallbacks) {
          try { cb(client); } catch (err) { log.error("onConnection callback threw:", err); }
        }
      },
      onSessionDestroyed(session, client) {
        server._sessions.delete(session);
        for (const cb of server._onDisconnectionCallbacks) {
          try { cb(client); } catch (err) { log.error("onDisconnection callback threw:", err); }
        }
      },
    };
    return this._host;
  }

  /**
   * Set the module for this app
   */
  module(name: string, module: HypenModule<any>): this {
    this._moduleName = name;
    this._module = module;
    return this;
  }

  /**
   * Set the app instance for auto-discovering named modules.
   *
   * Named modules registered via `app.module("Search").defineState(...).build()`
   * are automatically discovered and registered with each client's engine on
   * connect. The primary module (set via `.module()`) is excluded from
   * auto-registration.
   *
   * @example
   * ```typescript
   * import { app } from "@hypen-space/core";
   *
   * const searchModule = app.module("Search").defineState({ query: "" }).build();
   * const mainModule = app.defineState({ ... }).build();
   *
   * new RemoteServer()
   *   .app(app)
   *   .module("App", mainModule)
   *   .source("./components")
   *   .listen(3000);
   * ```
   */
  app(appInstance: HypenApp): this {
    this._app = appInstance;
    return this;
  }

  /**
   * Set the UI DSL string
   */
  ui(dsl: string): this {
    this._ui = dsl;
    return this;
  }

  /**
   * Set a source directory for automatic component discovery.
   *
   * All .hypen and .ts components in the directory (and subdirectories) are
   * discovered automatically. The entry component's template is used as the
   * UI, so calling .ui() is optional when .source() is set.
   *
   * @example
   * ```typescript
   * new RemoteServer()
   *   .source("./apps/chat")
   *   .module("Chat", chatModule)
   *   .listen(3001);
   * ```
   */
  source(dir: string): this {
    this._sourceDir = dir;
    return this;
  }

  /**
   * Set server configuration
   */
  config(config: RemoteServerConfig): this {
    this._config = { ...this._config, ...config };
    return this;
  }

  /**
   * Configure session management
   */
  session(config: SessionConfig): this {
    this._sessionConfig = config;
    return this;
  }

  /**
   * Enable action synchronization across all connected clients.
   * When enabled, an action dispatched by any client is also dispatched
   * to every other client's engine, keeping all clients in sync.
   *
   * The device plane stays on. Replayed dispatches must never initiate
   * device work (RFC 001 §1.7): a dispatch replayed onto another session
   * runs with replay provenance, so its `context.device` refuses with
   * `unavailable` (`syncActions.replay`). Only the client that actually
   * dispatched can start device work.
   */
  syncActions(): this {
    this._syncActions = true;
    return this;
  }

  /**
   * Tune the Device Capability Protocol (RFC 001). The device plane is on by
   * default — every session whose client's hello offers `device` gets one and
   * module handlers reach it through `context.device` — so this is only for
   * budgets and broker limits; omitted fields keep their defaults. Merges
   * with earlier calls.
   */
  configureDevice(options: RemoteDeviceOptions): this {
    this._deviceOptions = { ...this._deviceOptions, ...options };
    return this;
  }

  /**
   * Opt out of the Device Capability Protocol (RFC 001): no session gets a
   * device plane, whatever its client offers, and the server behaves exactly
   * like a UI-only server (Bun's default payload cap). Compression is the
   * same either way: on by default, one message at a time.
   */
  disableDevice(): this {
    this._deviceDisabled = true;
    return this;
  }

  /**
   * Register resources (name → raw SVG string map) for server-side icon resolution.
   *
   * Each SVG string is parsed eagerly and passed to the WASM engine's
   * `registerResources()`. When the engine encounters `Icon("heart")` in the DSL,
   * it resolves the icon name from registered resources and injects SVG path data
   * into the Create patch.
   *
   * @example
   * ```typescript
   * new RemoteServer()
   *   .resources({ heart: '<svg>...</svg>', star: '<svg>...</svg>' })
   *   .listen(3000);
   * ```
   */
  resources(map: Record<string, string>): this {
    Object.assign(this._resources, map);
    return this;
  }

  /**
   * Load a JSON file containing a name → raw SVG string map and register
   * those resources with the engine.
   *
   * The JSON file should be a flat object: `{ "heart": "<svg>...</svg>", ... }`.
   *
   * This is async — call with `await` before `.listen()`, or chain via `.then()`.
   *
   * @example
   * ```typescript
   * const server = new RemoteServer().module("App", appModule);
   * await server.resourcesFile("./resources.json");
   * server.listen(3000);
   * ```
   */
  async resourcesFile(filePath: string): Promise<this> {
    const content = await readFile(resolve(filePath), "utf-8");
    const map: Record<string, string> = JSON.parse(content);
    return this.resources(map);
  }

  /**
   * Load every `.svg` file from a directory and register each as a resource
   * keyed by filename (without extension).
   *
   * e.g. `dir/heart.svg` → `Icon(@resources.heart)`.
   */
  async resourcesDir(dirPath: string): Promise<this> {
    const absDir = resolve(dirPath);
    const entries = await readdir(absDir, { withFileTypes: true });
    const map: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".svg") continue;
      const name = basename(entry.name, ".svg");
      map[name] = await readFile(join(absDir, entry.name), "utf-8");
    }
    return this.resources(map);
  }

  /**
   * Register connection callback
   */
  onConnection(callback: (client: RemoteClient) => void): this {
    this._onConnectionCallbacks.push(callback);
    return this;
  }

  /**
   * Enable the agent REST surface under `/__hypen__/agent`.
   *
   * Off until this is called, and off in every mode — there is no dev-mode
   * default-on. The surface lets an HTTP caller drive the app, so it is a
   * capability grant, and a grant nobody made is not a grant. Without this
   * call `/__hypen__/agent/*` is indistinguishable from any other unknown
   * path, so a probe cannot even learn the surface exists.
   *
   * Every dispatch goes through the engine's external guard
   * (`agent_core::resolve_external`), so enabling this exposes exactly what
   * the app declared — `.onAction()` names, `Router { Route }` targets,
   * `.bind()` fields, and the state paths the template renders — and nothing
   * the framework owns.
   *
   * @example
   * ```typescript
   * new RemoteServer()
   *   .module("App", appModule)
   *   .ui(template)
   *   .agent()
   *   .listen(3000);
   * ```
   */
  agent(options: AgentOptions = {}): this {
    this._agentOptions = options;
    this._agent = new AgentSurface(this, options);
    return this;
  }

  /**
   * Bind the agent surface to a live user session — attach mode.
   *
   * Returns an `AgentHandle` over the first session with this id that has
   * completed its hello handshake (`isReady`) and is not destroyed, or
   * `null` when there is none. Under `allow-multiple` several sessions may
   * share an id; the first ready one is chosen, and its streaming callback
   * already fans every patch out to its peers, so all of them see the
   * result.
   *
   * **No authorisation happens here.** The caller is the authoriser: a
   * server-side handler that holds this `RemoteServer` already holds every
   * session on it, and on a server without the device plane the session id
   * is also the resume credential of a UI-only session (a session with a
   * device plane is resumed only with its separate `resumeToken`, RFC 001
   * §5), so accept it only from a channel
   * you trust. The REST route
   * (`.agent({ authorize })`) is the one place a *remote* caller can reach
   * this, and it refuses unless an `authorize` callback says otherwise.
   *
   * The handle never owns the session: dropping it, sweeping it, or
   * stopping the agent surface leaves the user's session exactly as it was.
   *
   * @example
   * ```typescript
   * const handle = server.attach(sessionIdFromTrustedChannel);
   * handle?.dispatch("addToCart", { sku: "A1" }); // the user's browser re-renders
   * ```
   */
  attach(sessionId: string): AgentHandle | null {
    const host = this.getHost();
    for (const session of host.sessionsForId(sessionId)) {
      if (session.isReady && !session.isDestroyed) {
        return new AgentHandle(session, host);
      }
    }
    return null;
  }

  /**
   * Turn off automatic ManagedRouter wiring for new sessions. Use when
   * the host wants to construct its own `ManagedRouter` inside
   * `onSessionCreate` — e.g. to share a router across multiple
   * sessions, pre-register nested modules, or use a custom route
   * matcher. Auto-wiring is on by default so the common case needs
   * zero routing code on the server side.
   */
  disableAutoRouter(): this {
    this._autoRouter = false;
    return this;
  }

  /**
   * Register a callback that fires when a new `RemoteSession` is created —
   * synchronously, before the hello handshake completes and before the
   * initial render. Use this to wire per-session helpers (routers, shared
   * contexts, background workers) that need access to `session.engine`.
   *
   * Await `session.ready` inside the callback for anything that depends on
   * the primary module being constructed (e.g. registering it in a
   * `HypenGlobalContext` for sibling lookups). Await `session.closed` to
   * clean up on disconnect.
   */
  onSessionCreate(callback: (session: RemoteSession) => void | Promise<void>): this {
    this._onSessionCreateCallbacks.push(callback);
    return this;
  }

  onDisconnection(callback: (client: RemoteClient) => void): this {
    this._onDisconnectionCallbacks.push(callback);
    return this;
  }

  /**
   * Run one-time setup: component discovery (if `.source()` was set) and
   * session-manager initialisation.
   *
   * Call this once before `createSession()` if you're bypassing `.listen()`.
   * `.listen()` invokes it internally. Calling twice is a no-op.
   */
  async prepare(): Promise<this> {
    if (this._prepared) return this;
    if (!this._module) {
      throw new Error("Module not set. Call .module() before prepare()/listen()");
    }
    if (this._sourceDir) {
      await this.discoverFromSource();
      // Discovery imports each component's .ts module, and named modules
      // (`app.module("Home")...`) self-register in the shared HypenApp
      // singleton as a side effect. Default `_app` to that registry so the
      // auto-router can resolve component-backed routes without every
      // caller having to remember `.app(app)`.
      if (!this._app) {
        const { app } = await import("@hypen-space/core/app");
        this._app = app;
      }
    }
    if (!this._ui) {
      throw new Error("UI not set. Call .ui() or .source() before prepare()/listen()");
    }
    this._sessionManager = new SessionManager(this._sessionConfig);
    this.resolveDevicePolicy();
    this._prepared = true;
    return this;
  }

  /**
   * Decide (and log once) whether the device plane is on for this server.
   * It is on by default; `disableDevice()` turns it off, and so does
   * `allow-multiple` session fan-out, which it cannot coexist with. Never
   * throws: an incompatible setting keeps working, the device plane is
   * simply off, and one warning names the setting.
   *
   * Neither `syncActions()` (replayed dispatches carry replay provenance and
   * cannot start device work) nor compression (negotiated one message at a
   * time, see `listen()`) turns the device plane off.
   */
  private resolveDevicePolicy(): void {
    let reason: string | null = null;
    if (this._deviceDisabled) reason = "disableDevice()";
    else if ((this._sessionConfig.concurrent ?? "kick-old") === "allow-multiple") {
      reason = 'session({ concurrent: "allow-multiple" })';
    }
    const changed = reason !== this._deviceOffReason;
    this._deviceOffReason = reason;
    if (!changed || reason === null) return;
    if (reason === "disableDevice()") {
      log.info("Device plane disabled (disableDevice()) — UI-only server");
    } else {
      log.warn(
        `Device plane off: ${reason} is incompatible with the device plane ` +
          "(RFC 001 §1.7: fanned-out dispatches must never initiate device work) — " +
          "sessions stay UI-only"
      );
    }
  }

  /**
   * Create a session driven by the supplied transport.
   *
   * Use this to integrate Hypen with an existing HTTP/WebSocket server.
   * Forward incoming messages via `session.receive()` and call
   * `session.destroy()` when the underlying connection closes.
   *
   * @example Plugging into a third-party WebSocket library
   * ```ts
   * await server.prepare();
   *
   * ws.on("connection", (socket) => {
   *   const transport: SessionTransport = {
   *     send: (msg) => socket.send(JSON.stringify(msg)),
   *     close: (code, reason) => socket.close(code, reason),
   *   };
   *   const session = server.createSession(transport, { socketHandle: socket });
   *   socket.on("message", (raw) => session.receive(raw));
   *   socket.on("close", () => session.destroy());
   * });
   * ```
   */
  createSession(
    transport: SessionTransport,
    options?: {
      clientId?: string;
      helloGraceMs?: number | null;
      socketHandle?: unknown;
      deviceBrokerConfig?: RemoteDeviceOptions["broker"];
    }
  ): RemoteSession {
    if (!this._prepared) {
      throw new Error(
        "RemoteServer not prepared. Call `await server.prepare()` before `createSession()`."
      );
    }
    const broker = this._deviceOptions.broker;
    const session = new RemoteSession(
      this.getHost(),
      transport,
      broker && options?.deviceBrokerConfig === undefined
        ? { ...options, deviceBrokerConfig: broker }
        : options
    );
    session.autoRouterEnabled = this._autoRouter;
    this._sessions.add(session);
    for (const cb of this._onSessionCreateCallbacks) {
      try {
        const result = cb(session);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) =>
            log.error("onSessionCreate callback rejected:", err)
          );
        }
      } catch (err) {
        log.error("onSessionCreate callback threw:", err);
      }
    }
    return session;
  }

  /**
   * Return a framework-agnostic handler: given a transport, produce a
   * session-backed pair of `receive`/`destroy` functions. Useful for
   * plumbing Hypen into middleware-style HTTP/WebSocket stacks.
   *
   * @example
   * ```ts
   * await server.prepare();
   * const handle = server.createHandler();
   * // In your WS upgrade handler:
   * const { receive, destroy } = handle(transport);
   * socket.on("message", receive);
   * socket.on("close", destroy);
   * ```
   */
  createHandler(): (transport: SessionTransport, options?: { socketHandle?: unknown }) => {
    session: RemoteSession;
    receive: (msg: RemoteMessage | string | Buffer) => Promise<void>;
    destroy: () => Promise<void>;
  } {
    return (transport, options) => {
      const session = this.createSession(transport, options);
      return {
        session,
        receive: (msg) => session.receive(msg),
        destroy: () => session.destroy(),
      };
    };
  }

  /**
   * Start the default Bun WebSocket server. Convenience wrapper over
   * `prepare()` + `createSession()`; for custom integrations use those
   * primitives directly instead.
   */
  async listen(port?: number): Promise<this> {
    await this.prepare();

    const finalPort = port ?? this._config.port ?? 3000;
    const hostname = this._config.hostname ?? "0.0.0.0";
    // The device plane is on by default (RFC 001).
    this.resolveDevicePolicy();
    const deviceOn = this._deviceOffReason === null;
    // permessage-deflate, on unless `compression: false`: Bun negotiates it
    // during the upgrade handshake, so clients that don't offer the
    // extension just get uncompressed frames. It is negotiated ONE MESSAGE
    // AT A TIME — "shared" (de)compressors mean Bun answers with both
    // `server_no_context_takeover` and `client_no_context_takeover`, so no
    // message (device data included) ever shares a DEFLATE history with
    // another (RFC 001 §2.3: the CRIME/BREACH concern is cross-message
    // context). Never "dedicated": that is context takeover, and clients
    // then keep the connection UI-only.
    const compression = this._config.compression ?? true;
    const perMessageDeflate = compression
      ? ({ compress: "shared", decompress: "shared" } as const)
      : false;
    const allowedOrigins =
      this._config.allowedOrigins && this._config.allowedOrigins.length > 0
        ? new Set(this._config.allowedOrigins.map(normalizeOrigin))
        : null;
    const authenticate = this._config.authenticate;
    if (!allowedOrigins && typeof authenticate !== "function") {
      log.warn(OPEN_ADMISSION_WARNING);
    }
    // Device messages are capped at 1 MiB before parsing (RFC 001 §2.1); the
    // socket-level cap bounds what JSON.parse ever sees on a device server.
    const maxPayloadLength =
      this._config.maxPayloadLength ?? (deviceOn ? 4 * 1024 * 1024 : undefined);

    this.server = Bun.serve({
      port: finalPort,
      hostname,
      websocket: {
        perMessageDeflate,
        ...(maxPayloadLength !== undefined ? { maxPayloadLength } : {}),
        open: (ws) => this.handleOpen(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // Upgrade admission (RFC 001 §5, decision D1): Origin allowlist for
        // browsers, the app's authenticator for everyone else — before any
        // session exists.
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const refused = await admitUpgrade(req, { allowedOrigins, authenticate });
          if (refused) return refused;
        }

        // Upgrade to WebSocket
        if (server.upgrade(req, { data: undefined })) {
          return; // Connection upgraded
        }

        // Health check endpoint
        if (url.pathname === "/health") {
          return new Response("OK", { status: 200 });
        }

        // Stats endpoint
        if (url.pathname === "/stats") {
          const stats = this._sessionManager?.getStats() ?? {
            activeSessions: 0,
            pendingSessions: 0,
            totalConnections: 0,
          };
          return new Response(JSON.stringify(stats), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Agent REST surface. `null` unless `.agent()` was called, and
        // `handle()` returns null for any path outside its own mount point,
        // so a disabled surface falls through to the catch-all below exactly
        // as an unknown path does.
        if (this._agent) {
          const agentResponse = await this._agent.handle(req, url);
          if (agentResponse) return agentResponse;
        }

        // Default browser client (on unless config.webClient === false):
        // `/` serves the HTML shell, `/__hypen__/client.js` the bundled
        // RemoteEngine + DOMRenderer client that dials back over WebSocket.
        if (this._config.webClient !== false) {
          if (url.pathname === "/__hypen__/client.js") {
            const bundle = await getWebClientBundle();
            if (bundle) {
              return new Response(bundle, {
                headers: { "Content-Type": "application/javascript" },
              });
            }
            return new Response("Web client bundle unavailable", { status: 503 });
          }
          if (url.pathname === "/" || url.pathname === "/index.html") {
            const bundle = await getWebClientBundle();
            const wsProto = "ws";
            const html = bundle
              ? renderClientHtml()
              : renderFallbackHtml(`${wsProto}://${url.host}`);
            return new Response(html, {
              headers: { "Content-Type": "text/html" },
            });
          }
        }

        return new Response("Hypen Remote Server", { status: 200 });
      },
    });

    log.info(`Hypen app streaming on ws://${hostname}:${finalPort}`);
    if (this._config.webClient !== false) {
      const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
      log.info(`Web client at http://${displayHost}:${finalPort}`);
    }
    log.debug(
      `permessage-deflate ${compression ? "enabled (no context takeover)" : "disabled"}`
    );

    return this;
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    if (this._agent) {
      // Fire-and-forget: `stop()` is synchronous by contract, and every agent
      // session teardown is local bookkeeping plus the module's own destroy.
      this._agent
        .dispose()
        .catch((err) => log.error("Agent surface teardown failed:", err));
      // A disposed surface answers nothing, so a restart gets a fresh one
      // built from the same grant rather than a dead one.
      this._agent = this._agentOptions
        ? new AgentSurface(this, this._agentOptions)
        : null;
    }
    if (this._sessionManager) {
      this._sessionManager.destroy();
      this._sessionManager = null;
    }
    this._prepared = false;
  }

  /**
   * Get the server URL
   */
  get url(): string | null {
    if (!this.server) return null;
    const hostname = this._config.hostname ?? "localhost";
    const port = this._config.port ?? 3000;
    return `ws://${hostname}:${port}`;
  }

  /**
   * Discover components from the source directory.
   * Populates _discoveredComponents and sets _ui from the entry component
   * if not already set via .ui().
   */
  private async discoverFromSource(): Promise<void> {
    const dir = this._sourceDir!;
    log.info(`Discovering components from ${dir}...`);

    const discovered = await discoverComponents(dir);
    const loaded = await loadDiscoveredComponents(discovered);

    for (const [name, { module, template }] of loaded) {
      this._discoveredComponents.set(name, { template, module });
    }

    log.info(
      `Discovered ${this._discoveredComponents.size} components: ${Array.from(this._discoveredComponents.keys()).join(", ")}`
    );

    // If .ui() was not called, use the entry component's template
    if (!this._ui) {
      const entry = this._discoveredComponents.get(this._moduleName);
      if (entry) {
        this._ui = entry.template;
        log.info(`Set UI from discovered "${this._moduleName}" (${this._ui.length} bytes, first 80: ${JSON.stringify(this._ui.substring(0, 80))})`);
      }
    }
  }

  /**
   * Bun WebSocket `open` adapter. Creates a transport over the socket,
   * spins up a `RemoteSession`, and tracks both for dispatch.
   */
  private handleOpen(ws: ServerWebSocket<unknown>) {
    try {
      const transport = createBunWebSocketTransport(ws);
      const session = this.createSession(transport, { socketHandle: ws });
      this._wsToSession.set(ws, session);
    } catch (error) {
      log.error("Error handling WebSocket open:", error);
      ws.close(1011, "Internal server error");
    }
  }

  /**
   * The Rust device broker factory (lazily created): one `WasmDeviceBroker`
   * per device connection, all sharing one process-wide retained-bytes pool.
   */
  private deviceBrokerFactory(): WasmDeviceBrokerFactory {
    this._deviceBrokerFactory ??= createWasmDeviceBrokerFactory({
      poolBytes: this._deviceOptions.processRetainedBytes ?? DEFAULT_PROCESS_RETAINED_BYTES,
    });
    return this._deviceBrokerFactory;
  }

  /**
   * Bun WebSocket `message` adapter. Forwards raw messages to the session.
   */
  private handleMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    const session = this._wsToSession.get(ws);
    if (!session) return;
    // Bun delivers text frames as strings and binary frames as Buffers. A
    // binary frame is device-plane data (RFC 001 §2.3) when the session has a
    // broker; legacy clients never send binary, so the JSON path stays
    // exactly as before for strings.
    if (typeof message !== "string" && session.deviceBroker) {
      session.receiveBinary(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
      return;
    }
    session.receive(message).catch((err) =>
      log.error("Error handling WebSocket message:", err)
    );
  }

  /**
   * Bun WebSocket `close` adapter. Tears down the session.
   */
  private handleClose(ws: ServerWebSocket<unknown>): void {
    const session = this._wsToSession.get(ws);
    if (!session) return;
    this._wsToSession.delete(ws);
    session.destroy().catch((err) =>
      log.error("Error tearing down session:", err)
    );
  }

  /**
   * Hot reload: refresh discovery, then disconnect every connected client
   * so it reconnects into a fresh session built from the newly loaded
   * code (templates AND module definitions).
   *
   * Reconnect — not re-render-in-place: reconciling new source into a
   * live session proved unreliable (the Router's cached subtrees survive
   * `clearResolvedComponents`, producing empty diffs, and the re-render
   * left nested modules' reactive wiring dead). Disconnected clients
   * auto-reconnect with their session id; the suspended session resumes,
   * and its saved primary-module state is restored automatically (or via
   * the module's `onReconnect` handler when one is defined).
   */
  async reload(): Promise<void> {
    if (this._sourceDir) {
      // Reset _ui so discoverFromSource picks up the latest entry template
      this._ui = "";
      await this.discoverFromSource();
      // Refresh the primary module definition too — discovery re-imports
      // the entry's .ts (mtime-busted), so edited handlers/initial state
      // apply to resumed sessions without a server restart.
      const entry = this._discoveredComponents.get(this._moduleName);
      if (entry?.module) {
        this._module = entry.module as HypenModule<any>;
      }
    }

    if (!this._ui) {
      log.warn("Reload skipped: no UI template available");
      return;
    }

    for (const session of [...this._sessions]) {
      if (!session.helloReceived) continue;
      try {
        session.disconnectForReload();
      } catch (e: any) {
        log.error(`Failed to disconnect client ${session.id} for reload:`, e);
      }
    }
  }

  /**
   * Get current client count
   */
  getClientCount(): number {
    return this._sessions.size;
  }

  /**
   * Get session stats
   */
  getSessionStats(): {
    activeSessions: number;
    pendingSessions: number;
    totalConnections: number;
  } {
    return this._sessionManager?.getStats() ?? {
      activeSessions: 0,
      pendingSessions: 0,
      totalConnections: 0,
    };
  }

  /**
   * Broadcast a server→client message to all ready sessions.
   */
  broadcast(message: OutgoingMessage): void {
    for (const session of this._sessions) {
      if (!session.helloReceived) continue;
      session.send(message);
    }
  }
}

/**
 * Convenience function to create and start a RemoteServer
 */
export async function serve(options: {
  module: HypenModule<any>;
  moduleName?: string;
  ui?: string;
  source?: string;
  port?: number;
  hostname?: string;
  /** Negotiate permessage-deflate compression (default: true) */
  compression?: boolean;
  session?: SessionConfig;
  onConnection?: (client: RemoteClient) => void;
  onDisconnection?: (client: RemoteClient) => void;
}): Promise<RemoteServer> {
  const server = new RemoteServer()
    .module(options.moduleName ?? "App", options.module);

  if (options.source) {
    server.source(options.source);
  }

  if (options.ui) {
    server.ui(options.ui);
  }

  if (options.port || options.hostname || options.compression !== undefined) {
    server.config({
      port: options.port,
      hostname: options.hostname,
      compression: options.compression,
    });
  }

  if (options.session) {
    server.session(options.session);
  }

  if (options.onConnection) {
    server.onConnection(options.onConnection);
  }

  if (options.onDisconnection) {
    server.onDisconnection(options.onDisconnection);
  }

  return server.listen(options.port);
}
