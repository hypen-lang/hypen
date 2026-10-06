/**
 * Hypen Social on Cloudflare — the whole worker in one file.
 *
 * `@hypen-space/cf` provides the Durable Object + WS routing. This file wires in
 * the app, WASM engine, and shared browser clients explicitly:
 * the App module, the full `templates` map (App's route components live in
 * external `.hypen` files, so their registry `.template` is empty and the
 * runtime fills it from here), the SVG `resources` bundle, and an `onStorage`
 * hook that binds the DO's SQL into the `bun:sqlite` shim + seeds the schema.
 *
 * Hypengram is a real, shared app: every connection — the standalone page,
 * the canvas page and the Home launcher's embed — is routed to ONE Durable
 * Object, so posts, likes, comments and uploaded photos are the same for
 * everyone and survive reloads. Each socket still gets its own session.
 *
 * Uploads come in over the device plane (RFC 001 — on by default in
 * `defineHypenWorker`; the served client attaches a browser DeviceHost).
 * Photo bytes live in the `MEDIA` R2 bucket, metadata in the DO's SQLite
 * (see media.ts); `GET /media/<id>` streams straight from R2 in the Worker.
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
import { bindMediaBucket, serveMedia, type MediaBucket } from "./media";

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
  conversationModule,
  storyModule,
  createPostModule,
} from "./module";

void homePageModule;
void searchModule;
void notificationsModule;
void messagesModule;
void profileModule;
void userProfileModule;
void commentsModule;
void conversationModule;
void storyModule;
void createPostModule;

/** The one Durable Object every Hypengram connection (and media fetch) uses. */
const SHARED_DO = "hypengram";

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
  getRoutingKey: () => SHARED_DO,
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
    if (!seededStorages.has(storage as object)) {
      initSchema();
      seededStorages.add(storage as object);
    }
  },
});

type SocialEnv = { MEDIA: MediaBucket };

const BaseDO = worker.SocialDO as unknown as {
  new (ctx: unknown, env: SocialEnv): { fetch(request: Request): Promise<Response> };
};

/** The generated DO, plus the R2 bucket its upload handlers write to. */
export class SocialDO extends BaseDO {
  constructor(ctx: unknown, env: SocialEnv) {
    super(ctx, env);
    bindMediaBucket(env.MEDIA);
  }
}

export default {
  fetch(request: Request, env: SocialEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      return serveMedia(request, env.MEDIA);
    }
    return worker.fetch(request, env as never);
  },
};
