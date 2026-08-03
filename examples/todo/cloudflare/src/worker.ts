/**
 * Hypen Todo on Cloudflare — the hypen-landing todo sample as a worker.
 *
 * This entry wires in the WASM engine and shared browser client explicitly.
 * The default worker routing keys every `/ws` connection to the SAME Durable
 * Object and `syncActions: true` mirrors state updates to every socket on it —
 * one shared todo list per deployment, live in all tabs.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import todo from "./todo";

const worker = defineHypenWorker({
  module: todo,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "TodoDO",
  binding: "TODO_DO",
  syncActions: true,
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Todo",
});

export const TodoDO = worker.TodoDO;
export default { fetch: worker.fetch };
