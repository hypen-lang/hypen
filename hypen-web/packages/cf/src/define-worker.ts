/**
 * `defineHypenWorker` — the whole Cloudflare app in one call.
 *
 * Collapses the worker + Durable Object + engine wiring into a single export so
 * a simple app is just one `worker.ts`. It builds a `HypenDurableObject`
 * subclass (engine from `createCFEngine`, config from the args) and a fetch
 * handler that routes WS upgrades to it, and returns both. The DO must be a
 * statically named export for wrangler, so the result is keyed by
 * `doClassName` — re-export it under that name.
 *
 * ```ts
 * // worker.ts — the entire app
 * import { defineHypenWorker } from "@hypen-space/cf";
 * import { app } from "@hypen-space/core";
 * import * as wasm from "hypen-engine";
 * import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
 *
 * const module = app.defineState({ count: 0 })
 *   .onAction("inc", ({ state }) => { state.count += 1; })
 *   .ui(`module App { Text("@{state.count}") }`);
 *
 * const worker = defineHypenWorker({ module, wasm, wasmModule, doClassName: "AppDO" });
 * export const AppDO = worker.AppDO;
 * export default { fetch: worker.fetch };
 * ```
 *
 * The two `hypen-engine` imports stay in user code on purpose: they resolve
 * only under wrangler's bundler (CompiledWasm + web-target glue), so the
 * package can't make them itself. Everything else is handled here.
 */

import type { HypenApp, HypenModuleDefinition } from "@hypen-space/core/app";
import { HypenDurableObject, type HypenDurableObjectConfig, type DurableObjectState } from "./durable-object.js";
import { createCFEngine, type CFWasmExports } from "./engine.js";
import type { DurableObjectStorage } from "./durable-object-store.js";
import { createWorkerHandler } from "./worker.js";
import {
  buildClientPages,
  servePage,
  type ClientBundle,
} from "./client-pages.js";

export interface DefineHypenWorkerOptions {
  /** Primary module (built via `app.defineState(...).ui(...)`). */
  module: HypenModuleDefinition<any>;
  /**
   * UI template. Defaults to the module's own `.ui(...)` template, so a
   * single-file inline app never needs to pass this.
   */
  template?: string;
  /** Module name used in protocol messages (default: "App"). */
  moduleName?: string;
  /** App registry, for multi-module apps (route targets / nested state). */
  app?: HypenApp;
  /** Templates for components not on the registry (e.g. an anonymous nav). */
  componentTemplates?: Record<string, string>;
  /** SVG resource bundle for `Icon(@resources.foo)`. */
  resources?: Record<string, string>;
  /** Mirror actions/state across sockets sharing a DO (default false). */
  syncActions?: boolean;

  /** web-target wasm exports (`import * as wasm from "hypen-engine"`). */
  wasm: CFWasmExports;
  /** the compiled module (`import m from "hypen-engine/...wasm"`). */
  wasmModule: WebAssembly.Module;

  /**
   * The exported DO class name — must equal the `class_name` in
   * `wrangler.jsonc`. The returned object is keyed by it. Default `"AppDO"`.
   */
  doClassName?: string;
  /**
   * The DO binding name from `wrangler.jsonc`. Default: `<doClassName upper>`
   * mapping is NOT applied — defaults to `"HYPEN_DO"`. Set to match your config.
   */
  binding?: string;
  /** Extract the DO routing key (default: ?sessionId / cookie / path / uuid). */
  getRoutingKey?: (request: Request) => string | Promise<string>;
  /**
   * Called after the DO's persistence stores are bound — on `fetch` and on
   * every message (so it re-runs post-hibernation). Use it to wire
   * app-specific storage, e.g. bind `state.storage.sql` into a `bun:sqlite`
   * shim and seed the schema. Make the work idempotent / run-once.
   */
  onStorage?: (storage: DurableObjectStorage) => void;

  /**
   * Serve browser clients from this worker. Map of route path → built client
   * bundle (a JS string + which renderer it drives). Each path serves an HTML
   * shell; the bundle is served at `<path>/client.js` (or `/client.js` for
   * "/"). Paths are yours to choose:
   *
   * ```ts
   * clients: {
   *   "/":       { js: domBundle },                      // DOM at /
   *   "/canvas": { js: canvasBundle, renderer: "canvas" } // Canvas at /canvas
   * }
   * ```
   *
   * The batteries-included `@hypen-space/cf/worker` entry exposes a simpler
   * `serveClient` that fills this in with a prebuilt generic client.
   */
  clients?: Record<string, ClientBundle>;
  /** `<title>` for served client pages. Default "Hypen". */
  title?: string;
}

type WorkerExports = {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
} & {
  [doClassName: string]: new (ctx: DurableObjectState, env: unknown) => HypenDurableObject;
};

/**
 * Build a one-file Hypen-on-Cloudflare worker. Returns `{ fetch, [doClassName] }`.
 */
export function defineHypenWorker(opts: DefineHypenWorkerOptions): WorkerExports {
  const doClassName = opts.doClassName ?? "AppDO";
  const binding = opts.binding ?? "HYPEN_DO";

  const config: HypenDurableObjectConfig = {
    module: opts.module,
    template: opts.template ?? opts.module.template ?? "",
    ...(opts.moduleName !== undefined ? { moduleName: opts.moduleName } : {}),
    ...(opts.app !== undefined ? { app: opts.app } : {}),
    ...(opts.componentTemplates !== undefined
      ? { componentTemplates: opts.componentTemplates }
      : {}),
    ...(opts.resources !== undefined ? { resources: opts.resources } : {}),
    ...(opts.syncActions !== undefined ? { syncActions: opts.syncActions } : {}),
  };

  const Engine = createCFEngine(opts.wasm, opts.wasmModule);

  const onStorage = opts.onStorage;

  class HypenWorkerDO extends HypenDurableObject {
    getConfig(): HypenDurableObjectConfig {
      return config;
    }
    createEngine() {
      return new Engine();
    }
    protected override onStorageBound(storage: DurableObjectStorage): void {
      onStorage?.(storage);
    }
  }

  const wsFetch = createWorkerHandler({
    binding,
    ...(opts.getRoutingKey !== undefined ? { getRoutingKey: opts.getRoutingKey } : {}),
  }) as WorkerExports["fetch"];

  // If the app serves browser clients, the worker handles GET pages itself and
  // delegates WS upgrades to the Hypen handler. Otherwise it's WS-only.
  const pages =
    opts.clients && Object.keys(opts.clients).length > 0
      ? buildClientPages({
          routes: opts.clients,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
        })
      : null;

  const fetch: WorkerExports["fetch"] = pages
    ? async (request, env) => {
        if (request.headers.get("Upgrade") === "websocket") {
          return wsFetch(request, env);
        }
        const page = servePage(pages, request);
        if (page) return page;
        return wsFetch(request, env);
      }
    : wsFetch;

  return { fetch, [doClassName]: HypenWorkerDO } as WorkerExports;
}
