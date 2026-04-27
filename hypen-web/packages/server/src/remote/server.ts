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
import { frameworkLoggers } from "@hypen-space/core/logger";
import {
  discoverComponents,
  loadDiscoveredComponents,
} from "../discovery.js";
import {
  RemoteSession,
  createBunWebSocketTransport,
  type OutgoingMessage,
  type SessionHost,
  type SessionTransport,
} from "./session.js";

const log = frameworkLoggers.remote;

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
      get sessionManager() {
        if (!server._sessionManager) {
          throw new Error(
            "RemoteServer not prepared. Call `await server.prepare()` or `.listen()` first."
          );
        }
        return server._sessionManager;
      },
      get discoveredComponents() { return server._discoveredComponents; },
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
   */
  syncActions(): this {
    this._syncActions = true;
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
   * Register disconnection callback
   */
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
    }
    if (!this._ui) {
      throw new Error("UI not set. Call .ui() or .source() before prepare()/listen()");
    }
    this._sessionManager = new SessionManager(this._sessionConfig);
    this._prepared = true;
    return this;
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
    options?: { clientId?: string; helloGraceMs?: number | null; socketHandle?: unknown }
  ): RemoteSession {
    if (!this._prepared) {
      throw new Error(
        "RemoteServer not prepared. Call `await server.prepare()` before `createSession()`."
      );
    }
    const session = new RemoteSession(this.getHost(), transport, options);
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

    this.server = Bun.serve({
      port: finalPort,
      hostname,
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
      fetch: (req, server) => {
        const url = new URL(req.url);

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

        return new Response("Hypen Remote Server", { status: 200 });
      },
    });

    log.info(`Hypen app streaming on ws://${hostname}:${finalPort}`);

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
   * Bun WebSocket `message` adapter. Forwards raw messages to the session.
   */
  private handleMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    const session = this._wsToSession.get(ws);
    if (!session) return;
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
   * Reload components from the source directory and re-render all connected clients.
   * Call this when source files change to implement hot reload.
   *
   * The engine's reconciler diffs the old tree against the new one, producing
   * minimal patches (Create/Remove/SetProp) that are streamed to clients.
   */
  async reload(): Promise<void> {
    if (this._sourceDir) {
      // Reset _ui so discoverFromSource picks up the latest entry template
      this._ui = "";
      await this.discoverFromSource();
    }

    if (!this._ui) {
      log.warn("Reload skipped: no UI template available");
      return;
    }

    // Re-render all connected clients — reconciler diffs old vs new tree
    for (const session of this._sessions) {
      if (!session.helloReceived) continue;

      // Re-apply component resolver with newly discovered components.
      // The session installed its own on construction; re-install so it sees
      // the updated `_discoveredComponents` map (same map reference, but
      // calling setComponentResolver also invalidates internal caches).
      session.engine.setComponentResolver((componentName, _ctx) => {
        const comp = this._discoveredComponents.get(componentName);
        if (!comp) return null;
        return { source: comp.template, path: componentName };
      });

      // Clear cached component definitions so the engine re-resolves from fresh sources
      session.engine.clearResolvedComponents();

      try {
        session.engine.renderSource(this._ui);
        log.info(`Hot-reloaded client ${session.id}`);
      } catch (e: any) {
        log.error(`Failed to hot-reload client ${session.id}:`, e);
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

  if (options.port || options.hostname) {
    server.config({
      port: options.port,
      hostname: options.hostname,
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
