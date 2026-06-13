/**
 * `@hypen-space/cf/worker` — the batteries-included entry.
 *
 * This is a separate entry point from the package root on purpose: it does the
 * two `hypen-engine` imports itself (the web-target glue + the compiled
 * `.wasm`), so an app never has to. Those imports resolve only under wrangler's
 * bundler — wrangler's `CompiledWasm` rule turns the `.wasm` into a
 * `WebAssembly.Module` (bundle-wide, so it applies here inside the package too)
 * — which is also why this lives behind a subpath: the package ROOT
 * (`@hypen-space/cf`) stays WASM-free and typecheckable/testable without
 * wrangler, while apps that just want it to work import from here.
 *
 * ```ts
 * // worker.ts — the entire app, zero wasm lines
 * import { defineHypenWorker } from "@hypen-space/cf/worker";
 * import { app } from "@hypen-space/core";
 *
 * const module = app.defineState({ count: 0 })
 *   .onAction("inc", ({ state }) => { state.count += 1; })
 *   .ui(`module App { Text("@{state.count}") }`);
 *
 * const worker = defineHypenWorker({ module, doClassName: "AppDO", binding: "APP_DO" });
 * export const AppDO = worker.AppDO;
 * export default { fetch: worker.fetch };
 * ```
 *
 * Advanced apps that need to pin or supply their own engine build can import
 * the wasm-injected `defineHypenWorker` from the package root instead.
 */

import {
  defineHypenWorker as defineHypenWorkerInjected,
  type DefineHypenWorkerOptions,
} from "./define-worker.js";
import type { ClientBundle } from "./client-pages.js";
// @ts-ignore — wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore — the web-target glue; initSync(module) accepts a compiled module.
import * as wasm from "hypen-engine";
// @ts-ignore — wrangler's Text rule turns the prebuilt generic client (built by
// the package's `build:client` step) into a string. One bundle drives both DOM
// and Canvas; the HTML shell's `data-hypen-renderer` picks which.
import genericClientJs from "../dist/client/generic.js";

/**
 * Where to serve the prebuilt generic browser client. `true` → DOM at `/`.
 * An object chooses paths per renderer (set either to a path string):
 *
 * ```ts
 * serveClient: true                          // DOM at "/"
 * serveClient: { dom: "/" }                   // DOM at "/"
 * serveClient: { dom: "/", canvas: "/canvas" } // both, custom paths
 * serveClient: { canvas: "/" }                // Canvas at "/"
 * ```
 */
export type ServeClient =
  | boolean
  | { dom?: string; canvas?: string };

/** Options for the batteries-included worker — root options minus wasm, plus serveClient. */
export type DefineHypenWorkerWorkerOptions = Omit<
  DefineHypenWorkerOptions,
  "wasm" | "wasmModule"
> & {
  /** Serve the package's prebuilt generic browser client. See {@link ServeClient}. */
  serveClient?: ServeClient;
};

function clientsFromServeClient(serve: ServeClient): Record<string, ClientBundle> {
  const js = genericClientJs as string;
  if (serve === true) return { "/": { js, renderer: "dom" } };
  if (serve === false) return {};
  const routes: Record<string, ClientBundle> = {};
  if (serve.dom) routes[serve.dom] = { js, renderer: "dom" };
  if (serve.canvas) routes[serve.canvas] = { js, renderer: "canvas" };
  return routes;
}

/**
 * Build a one-file Hypen-on-Cloudflare worker with the engine WASM wired in.
 * Returns `{ fetch, [doClassName] }` — re-export the DO under the
 * `wrangler.jsonc` `class_name`. Pass `serveClient` to also serve a browser UI.
 */
export function defineHypenWorker(opts: DefineHypenWorkerWorkerOptions) {
  const { serveClient, clients, ...rest } = opts;
  // Explicit `clients` (bring-your-own bundles) wins; otherwise expand
  // `serveClient` into the prebuilt generic client.
  const resolvedClients =
    clients ?? (serveClient ? clientsFromServeClient(serveClient) : undefined);

  return defineHypenWorkerInjected({
    ...rest,
    ...(resolvedClients ? { clients: resolvedClients } : {}),
    wasm: wasm as never,
    wasmModule: wasmModule as WebAssembly.Module,
  });
}

export type { DefineHypenWorkerOptions } from "./define-worker.js";

