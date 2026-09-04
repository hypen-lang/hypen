import { RemoteServer } from "@hypen-space/server/remote";
import { app } from "@hypen-space/core/app";
import { readFileSync, watch } from "fs";
import { resolve } from "path";
import "./db";
// Side-effect imports: each module self-registers on the shared `HypenApp`
// as soon as it's evaluated.
import {
  appModule,
  homePageModule,
  searchModule,
  notificationsModule,
  messagesModule,
  conversationModule,
  profileModule,
  userProfileModule,
  commentsModule,
  storyModule,
} from "./module";

// Keep the module references from being tree-shaken — the registry
// lookup is the only consumer for these after their side-effect
// registrations fire.
void homePageModule;
void searchModule;
void notificationsModule;
void messagesModule;
void conversationModule;
void profileModule;
void userProfileModule;
void commentsModule;
void storyModule;

const PORT = Number(process.env.PORT) || 3000;
const componentsDir = resolve(import.meta.dir, "../../components");
const appTemplate = readFileSync(resolve(componentsDir, "App/component.hypen"), "utf-8");
const resourcesDir = resolve(import.meta.dir, "../../resources");

// Zero routing wiring here. `RemoteServer` auto-discovers every
// `Router { Route(path) { Component() } }` block in the primary
// template, matches each route's inner component name against the
// `HypenApp` registry, and spins up a ManagedRouter per session —
// mirroring the path into `App.state.location` so the engine-side
// Router IR reconciles to the right subtree. Opt out via
// `.disableAutoRouter()` if a host wants bespoke wiring.
const server = new RemoteServer()
  .app(app)
  .module("App", appModule)
  .ui(appTemplate)
  .source(componentsDir);

await server.resourcesDir(resourcesDir);

server
  .config({ port: PORT })
  .session({ ttl: 3600 })
  .onConnection((client) => console.log(`Client connected: ${client.id}`))
  .onDisconnection((client) => console.log(`Client disconnected: ${client.id}`));

await server.listen();
console.log(`Instagram server (TypeScript) running on ws://localhost:${PORT}`);

// ---------------------------------------------------------------------------
// Hot reload: re-read App template + re-render on any .hypen change.
// ---------------------------------------------------------------------------
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleReload = (filename: string) => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      const refreshedAppTemplate = readFileSync(
        resolve(componentsDir, "App/component.hypen"),
        "utf-8",
      );
      (server as any)._ui = refreshedAppTemplate;
      await server.reload();
      console.log(`🔄 Hot-reloaded after change: ${filename}`);
    } catch (e) {
      console.error("Hot-reload failed:", e);
    }
  }, 80);
};

watch(componentsDir, { recursive: true }, (_eventType, filename) => {
  if (!filename) return;
  if (!filename.endsWith(".hypen")) return;
  scheduleReload(filename);
});
console.log(`👀 Watching ${componentsDir} for .hypen changes`);
