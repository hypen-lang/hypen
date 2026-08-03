/**
 * Hypen Home on Cloudflare — a phone-style home screen for Hypen apps.
 *
 * All the interesting bits (the APPS list and the generated home-screen DSL)
 * live in launcher.ts. This entry wires in the WASM engine and shared browser
 * client explicitly so it matches the other deployed CF examples.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import launcher, { resources } from "./launcher";

const worker = defineHypenWorker({
  module: launcher,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "HomeScreenDO",
  binding: "HOME_SCREEN_DO",
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Home",
});

export const HomeScreenDO = worker.HomeScreenDO;
export default { fetch: worker.fetch };
