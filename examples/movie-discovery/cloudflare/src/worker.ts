/**
 * Hypen Movie Discovery on Cloudflare.
 *
 * `@hypen-space/cf` supplies the Worker fetch handler, Durable Object, and
 * WebSocket transport. This file wires in the app graph, WASM engine, shared
 * browser clients, and routes anonymous BottomNav into the component resolver.
 */

import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";

import appModule from "./components/App";
import homeModule from "./components/Home";
import searchModule from "./components/Search";
import detailModule from "./components/MovieDetail";
import watchlistModule from "./components/Watchlist";
import profileModule from "./components/Profile";
import bottomNavModule from "./components/BottomNav";

void homeModule;
void searchModule;
void detailModule;
void watchlistModule;
void profileModule;

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app,
  componentTemplates: {
    BottomNav: (bottomNavModule as { template?: string }).template ?? "",
  },
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "MovieDiscoveryDO",
  binding: "MOVIE_DISCOVERY_DO",
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
    "/canvas": {
      js: genericClientJs as string,
      renderer: "canvas",
    },
  },
  title: "Cinebox — Hypen",
});

export const MovieDiscoveryDO = worker.MovieDiscoveryDO;
export default { fetch: worker.fetch };
