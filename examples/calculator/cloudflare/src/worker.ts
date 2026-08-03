/**
 * Hypen Calculator on Cloudflare — the hypen-landing calculator sample as a
 * worker. This entry wires in the WASM engine and shared browser client
 * explicitly so it matches the other deployed CF examples.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import calculator from "./calculator";

const worker = defineHypenWorker({
  module: calculator,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "CalculatorDO",
  binding: "CALCULATOR_DO",
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Calculator",
});

export const CalculatorDO = worker.CalculatorDO;
export default { fetch: worker.fetch };
