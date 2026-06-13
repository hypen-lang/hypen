/**
 * Hypen Calorie Counter on Cloudflare — the whole worker in one file.
 *
 * `@hypen-space/cf/worker` provides the engine + WASM + Durable Object + WS
 * routing + the browser clients (`serveClient`); this file just declares the
 * app:
 *
 *   - the component modules (imported for their side-effect registration on
 *     the shared `app` registry — Home/Diary/AddFood/Stats/Profile);
 *   - the App module, the registry, and the BottomNav anonymous fallback;
 *   - `serveClient`, serving the prebuilt DOM/Canvas clients;
 *   - `onStorage`, which binds the DO's `state.storage.sql` into the
 *     `bun:sqlite` shim and seeds the schema (runs on connect + every wake).
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import { app } from "@hypen-space/core";

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

let schemaReady = false;

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
  doClassName: "CalorieCounterDO",
  binding: "CALORIE_DO",
  // Browser clients from the prebuilt generic client: DOM at `/`, Canvas at
  // `/canvas`. (Pass `clients: {...}` with your own bundles to customise.)
  serveClient: { dom: "/", canvas: "/canvas" },
  // Bind the DO's synchronous SQL into the bun:sqlite shim + seed the schema
  // before any module handler (which calls into queries.ts) runs. Re-runs on
  // every message so it survives hibernation.
  onStorage: (storage) => {
    bindSql(storage as never);
    if (!schemaReady) {
      initSchema();
      schemaReady = true;
    }
  },
});

export const CalorieCounterDO = worker.CalorieCounterDO;
export default { fetch: worker.fetch };
