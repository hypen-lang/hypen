/**
 * Hypen Todo on Cloudflare — the hypen-landing todo sample as a worker.
 *
 * This entry wires in the WASM engine and shared browser client explicitly.
 * The hosted client gives each browser session its own Durable Object. If a
 * session has multiple sockets, `syncActions: true` mirrors updates between
 * those sockets without mixing unrelated visitors' todo state.
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
