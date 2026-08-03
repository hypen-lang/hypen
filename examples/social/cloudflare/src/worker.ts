/**
 * Hypen Social on Cloudflare — the whole worker in one file.
 *
 * `@hypen-space/cf` provides the Durable Object + WS routing. This file wires in
 * the app, WASM engine, and shared browser clients explicitly:
 * the App module, the full `templates` map (App's route components live in
 * external `.hypen` files, so their registry `.template` is empty and the
 * runtime fills it from here), the SVG `resources` bundle, and an `onStorage`
 * hook that binds the DO's SQL into the `bun:sqlite` shim + seeds the schema.
 */

import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../../../../hypen-web/packages/cf/dist/client/generic.js";

import { bindSql } from "./db";
import { initSchema } from "./seed";
import { appTemplate, templates } from "./templates";
import { resources } from "./resources";

// Side-effect imports — each registers itself on the shared `app` registry.
import {
  appModule,
  homePageModule,
  searchModule,
  notificationsModule,
  messagesModule,
  profileModule,
  userProfileModule,
  commentsModule,
  storyModule,
} from "./module";

void homePageModule;
void searchModule;
void notificationsModule;
void messagesModule;
void profileModule;
void userProfileModule;
void commentsModule;
void storyModule;

let schemaReady = false;

const worker = defineHypenWorker({
  module: appModule,
  template: appTemplate,
  moduleName: "App",
  // Route modules self-register on `app`, but their UI is in external `.hypen`
  // files — so their registry `.template` is empty and the runtime fills it
  // from `templates`. `resources` backs `Icon(@resources.*)`.
  app,
  componentTemplates: templates,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "SocialDO",
  binding: "SOCIAL_DO",
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
  onStorage: (storage) => {
    bindSql(storage as never);
    if (!schemaReady) {
      initSchema();
      schemaReady = true;
    }
  },
});

export const SocialDO = worker.SocialDO;
export default { fetch: worker.fetch };
