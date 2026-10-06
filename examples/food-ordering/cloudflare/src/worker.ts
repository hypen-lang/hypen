import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";

import { appModule } from "./module";
import { appTemplate, templates } from "./templates";
import { resources } from "./resources";

const worker = defineHypenWorker({
  module: appModule,
  template: appTemplate,
  moduleName: "App",
  app,
  componentTemplates: templates,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "FoodOrderingDurableObject",
  binding: "FOOD_ORDERING_DO",
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Crave Cart",
});

export const FoodOrderingDurableObject = worker.FoodOrderingDurableObject;
export default { fetch: worker.fetch };
