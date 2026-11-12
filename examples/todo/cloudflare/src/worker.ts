/**
 * Hypen Todo on Cloudflare — the hypen-landing todo sample as a worker.
 *
 * This entry wires in the WASM engine and shared browser client explicitly.
 * The list is deliberately ONE list per deployment: every client — page
 * loads and `HypenApp` embeds alike — is routed to the same Durable Object
 * (the explicit `getRoutingKey` below; on @hypen-space/cf >= 0.6.8 this is
 * `routing: "shared"`, and the default would give each visitor their own
 * DO). `syncActions: true` mirrors every change to all connected sockets,
 * live in all tabs. The device plane stays on with it: only the socket that
 * dispatched an action can start device work (`context.device`); its
 * mirrored copies are refused with `syncActions.replay`.
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
  // One shared Durable Object (and so one `.persist(global())` list) for
  // every client of the deployment.
  getRoutingKey: () => "shared",
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
