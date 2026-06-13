/**
 * Hypen Social on Cloudflare — the whole worker in one file.
 *
 * `@hypen-space/cf/worker` provides the engine + WASM + Durable Object + WS
 * routing + the browser clients (`serveClient`); this file declares the app:
 * the App module, the full `templates` map (App's route components live in
 * external `.hypen` files, so their registry `.template` is empty and the
 * runtime fills it from here), the SVG `resources` bundle, and an `onStorage`
 * hook that binds the DO's SQL into the `bun:sqlite` shim + seeds the schema.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import { app } from "@hypen-space/core";

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
  doClassName: "SocialDO",
  binding: "SOCIAL_DO",
  // Browser clients from the prebuilt generic client: DOM at `/`, Canvas at
  // `/canvas`. (Pass `clients: {...}` with your own bundles to customise.)
  serveClient: { dom: "/", canvas: "/canvas" },
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
