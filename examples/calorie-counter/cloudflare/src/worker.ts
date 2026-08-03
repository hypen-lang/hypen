/**
 * Hypen Calorie Counter on Cloudflare — the whole worker in one file.
 *
 * `@hypen-space/cf` provides the Durable Object + WS routing. This file wires in
 * the app, WASM engine, and shared browser clients:
 *
 *   - the component modules (imported for their side-effect registration on
 *     the shared `app` registry — Home/Diary/AddFood/Stats/Profile);
 *   - the App module, the registry, and the BottomNav anonymous fallback;
 *   - `clients`, serving the prebuilt DOM/Canvas clients;
 *   - `onStorage`, which binds the DO's `state.storage.sql` into the
 *     `bun:sqlite` shim and seeds the schema (runs on connect + every wake).
 */

import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";

import { bindSql } from "./db";
import { initSchema } from "./seed";

// Side-effect imports — each registers itself on the shared `app` registry.
import appModule from "./components/App";
import homeModule from "./components/Home";
import addFoodModule from "./components/AddFood";
import diaryModule from "./components/Diary";
import statsModule from "./components/Stats";
import profileModule from "./components/Profile";
import bottomNavModule from "./components/BottomNav";

void homeModule;
void addFoodModule;
void diaryModule;
void statsModule;
void profileModule;

// Per-storage, not per-module: `onStorage` fires once per Durable Object
// instance, but a module-level boolean is shared across every DO in the
// isolate. The first session seeded its own storage and set the flag, so
// every later session bound a fresh, empty storage and skipped
// `initSchema()` entirely — leaving a DO with no tables at all and a UI
// with no data. A WeakSet keyed on the storage object scopes readiness to
// the thing actually being initialised, and lets the DO be collected.
const seededStorages = new WeakSet<object>();

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app, // Home/Diary/AddFood/Stats/Profile self-register here.
  // BottomNav skips `app.module(...)` so its `@state.location` falls through to
  // App's state — so it isn't in the registry and needs an explicit template
  // (no filesystem discovery inside a DO).
  componentTemplates: {
    BottomNav: (bottomNavModule as { template?: string }).template ?? "",
  },
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "CalorieCounterDO",
  binding: "CALORIE_DO",
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
  // Bind the DO's synchronous SQL into the bun:sqlite shim + seed the schema
  // before any module handler (which calls into queries.ts) runs. Re-runs on
  // every message so it survives hibernation.
  onStorage: (storage) => {
    bindSql(storage as never);
    if (!seededStorages.has(storage as object)) {
      initSchema();
      seededStorages.add(storage as object);
    }
  },
});

export const CalorieCounterDO = worker.CalorieCounterDO;
export default { fetch: worker.fetch };
