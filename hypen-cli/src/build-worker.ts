/**
 * Worker half of the `hypen build` runtime (see build-client.ts for the
 * page half and the overall design).
 *
 * Runs what `RemoteServer` runs under `hypen dev`: one `RemoteSession` per
 * connection, owning the WASM engine and every module instance (primary,
 * nested, routed), with the auto-wired router and scoped `@actions`. It runs
 * in a dedicated worker, like the dev server runs in its own process, so it
 * sees the same environment (no `window`/`document`): the session's router
 * stays windowless, and the page alone owns the URL.
 *
 * `hypen build` copies this file into the build's temp directory so its
 * `@hypen-space/*` imports resolve from the project's node_modules: one
 * `@hypen-space/core` shared with the project's components.
 */

import {
  RemoteSession,
  SessionManager,
  type SessionHost,
  type SessionTransport,
} from "@hypen-space/core/remote";
import {
  app as appRegistry,
  resolveModuleDefinition,
  type HypenModuleDefinition,
} from "@hypen-space/core/app";
import { configureLogger } from "@hypen-space/core/logger";
import { Engine, type EngineInitOptions } from "@hypen-space/web-engine/engine";

export interface BuiltComponent {
  module?: HypenModuleDefinition<any>;
  template: string;
}

export interface WorkerOptions {
  /** Every discovered component: name -> { module, template }. */
  components: Record<string, BuiltComponent>;
  /** Entry (primary) component name, e.g. "App". */
  entry: string;
  /** Where the engine's WASM glue and binary are served from. */
  wasm: Required<EngineInitOptions>;
}

/** page -> worker */
export type ToWorker =
  | { t: "open"; id: number }
  | { t: "msg"; id: number; data: string }
  | { t: "close"; id: number };

/** worker -> page */
export type FromWorker =
  | { t: "msg"; id: number; data: string }
  | { t: "close"; id: number }
  | { t: "error"; message: string };

/**
 * Load the engine WASM once (from the build's own copy, not a CDN) and
 * return an `Engine` class whose `init()` completes synchronously.
 *
 * `RemoteSession` calls `engine.init()` without awaiting it and renders
 * right after (the server engine initialises synchronously), so every
 * per-session engine must be ready by the time `init()` returns.
 */
async function loadEngineClass(wasm: Required<EngineInitOptions>) {
  const glue: any = await import(/* @vite-ignore */ wasm.jsUrl);
  // Object form: the positional form logs a wasm-bindgen deprecation warning.
  await glue.default({ module_or_path: wasm.wasmUrl });
  // A regular init() too: it installs the engine's portable helpers into
  // @hypen-space/core (path matching, diff) exactly as in other hosts.
  // The WASM is already instantiated, so this only reuses the module.
  await new Engine().init(wasm);

  return class BundledEngine extends Engine {
    override async init(): Promise<void> {
      if (this.initialized) return;
      this.wasmEngine = new glue.WasmEngine();
      this.wasmEngine.registerDefaultPrimitives();
      this.initialized = true;
    }
  };
}

function createHost(options: WorkerOptions, EngineClass: new () => Engine): SessionHost {
  const discovered = new Map<string, { template: string; module?: HypenModuleDefinition<any> }>();
  for (const [name, comp] of Object.entries(options.components)) {
    if (!comp || typeof comp.template !== "string") continue;
    discovered.set(name, { template: comp.template, module: comp.module });
  }
  const entry = discovered.get(options.entry);
  if (!entry?.module) {
    throw new Error(
      `Entry component "${options.entry}" not found. Available: ${[...discovered.keys()].join(", ") || "(none)"}`
    );
  }
  const sessions = new Set<RemoteSession>();
  return {
    module: resolveModuleDefinition(entry.module),
    moduleName: options.entry,
    ui: entry.template || entry.module.template || "",
    resources: {},
    app: appRegistry,
    syncActions: false,
    // The device plane needs a broker on the far side of a real connection.
    deviceDisabled: true,
    sessionManager: new SessionManager(),
    discoveredComponents: discovered,
    createEngine: () => new EngineClass(),
    *otherSessions(self) {
      for (const s of sessions) if (s !== self) yield s;
    },
    *sessionsForId(id) {
      for (const s of sessions) if (s.sessionId === id) yield s;
    },
    onSessionReady() {},
    onSessionDestroyed(session) {
      sessions.delete(session);
    },
  };
}

/** Serve sessions to the page over `postMessage`. Call once, in the worker. */
export function runHypenWorker(options: WorkerOptions): void {
  const scope = globalThis as unknown as {
    postMessage(message: FromWorker): void;
    addEventListener(type: "message", listener: (ev: MessageEvent<ToWorker>) => void): void;
  };
  const post = (message: FromWorker) => scope.postMessage(message);
  // Per-session framework info logs are dev noise; keep warnings and errors
  // (`hypen dev` is likewise quiet unless --debug).
  configureLogger({ level: "warn" });

  const hostReady = loadEngineClass(options.wasm).then((EngineClass) =>
    createHost(options, EngineClass)
  );
  hostReady.catch((err) => post({ t: "error", message: String(err?.message ?? err) }));

  const sessions = new Map<number, RemoteSession>();
  // Messages that arrive while the WASM is still loading, in order.
  let queue: Promise<unknown> = hostReady.catch(() => {});

  scope.addEventListener("message", (ev) => {
    const msg = ev.data;
    queue = queue.then(async () => {
      if (msg.t === "open") {
        const host = await hostReady;
        const transport: SessionTransport = {
          send: (message) => post({ t: "msg", id: msg.id, data: JSON.stringify(message) }),
          close: () => {
            sessions.get(msg.id)?.destroy().catch(() => {});
            sessions.delete(msg.id);
            post({ t: "close", id: msg.id });
          },
        };
        sessions.set(msg.id, new RemoteSession(host, transport, { helloGraceMs: null }));
      } else if (msg.t === "msg") {
        // Not awaited: like a socket server, a slow action handler must not
        // hold up later messages.
        sessions.get(msg.id)?.receive(msg.data).catch((err) => console.error("[hypen]", err));
      } else if (msg.t === "close") {
        const session = sessions.get(msg.id);
        sessions.delete(msg.id);
        await session?.destroy();
      }
    }).catch((err) => console.error("[hypen]", err));
  });
}
