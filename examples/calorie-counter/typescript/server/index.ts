import { RemoteServer } from "@hypen-space/server/remote";
import { app } from "@hypen-space/core/app";
import { watch } from "fs";
import { resolve } from "path";
import "./db";

// Side-effect imports — each module self-registers on the shared
// `HypenApp` the moment it's evaluated. We keep live references below
// so the bundler doesn't tree-shake them out; the server then looks
// them up by name through the app registry + source discovery.
import appModule from "./components/App";
import homeModule from "./components/Home";
import addFoodModule from "./components/AddFood";
import statsModule from "./components/Stats";
import diaryModule from "./components/Diary";
import profileModule from "./components/Profile";
import bottomNavModule from "./components/BottomNav";

void homeModule;
void addFoodModule;
void statsModule;
void diaryModule;
void profileModule;
void bottomNavModule;

const PORT = Number(process.env.PORT) || 3000;
const componentsDir = resolve(import.meta.dir, "./components");

// The App module's inline template (set via `.ui(...)`) owns the
// top-level Router. `source(componentsDir)` lets the engine's
// component resolver find each screen's template when the Router
// swaps routes.
const server = new RemoteServer()
  .app(app)
  .module("App", appModule)
  .ui(appModule.template ?? "")
  .source(componentsDir);

server
  .config({ port: PORT })
  .session({ ttl: 3600 })
  .onConnection((client) => console.log(`Client connected: ${client.id}`))
  .onDisconnection((client) => console.log(`Client disconnected: ${client.id}`));

await server.listen();
console.log(`Calorie Counter server (TypeScript) running on ws://localhost:${PORT}`);

// ---------------------------------------------------------------------------
// Hot reload — re-render on any .ts change under components/. Because our
// templates live inside .ts files (inline `.ui(...)`), we need Bun to
// re-import them on reload. Bun's cache busts automatically for freshly
// changed files, so a `server.reload()` is enough to pick up new UI.
// ---------------------------------------------------------------------------
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleReload = (filename: string) => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      // Reset _ui so discoverFromSource picks up the latest App template.
      (server as any)._ui = "";
      await server.reload();
      console.log(`🔄 Hot-reloaded after change: ${filename}`);
    } catch (e) {
      console.error("Hot-reload failed:", e);
    }
  }, 80);
};

watch(componentsDir, { recursive: true }, (_eventType, filename) => {
  if (!filename) return;
  if (!filename.endsWith(".ts")) return;
  scheduleReload(filename);
});
console.log(`👀 Watching ${componentsDir} for component changes`);
