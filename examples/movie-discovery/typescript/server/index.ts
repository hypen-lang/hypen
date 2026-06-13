import { RemoteServer } from "@hypen-space/server/remote";
import { app } from "@hypen-space/core/app";
import { watch } from "fs";
import { resolve } from "path";

import appModule from "./components/App";
import homeModule from "./components/Home";
import searchModule from "./components/Search";
import detailModule from "./components/MovieDetail";
import watchlistModule from "./components/Watchlist";
import profileModule from "./components/Profile";
import bottomNavModule from "./components/BottomNav";

void homeModule;
void searchModule;
void detailModule;
void watchlistModule;
void profileModule;
void bottomNavModule;

const PORT = Number(process.env.PORT) || 3000;
const componentsDir = resolve(import.meta.dir, "./components");

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
console.log(`Movie Discovery server running on ws://localhost:${PORT}`);
if (!process.env.OMDB_API_KEY && !process.env.OMDB_KEY) {
  console.log("Set OMDB_API_KEY to load live OMDb data. Falling back to bundled demo titles for now.");
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleReload = (filename: string) => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      (server as any)._ui = "";
      await server.reload();
      console.log(`Hot-reloaded after change: ${filename}`);
    } catch (e) {
      console.error("Hot-reload failed:", e);
    }
  }, 80);
};

watch(componentsDir, { recursive: true }, (_eventType, filename) => {
  if (!filename || !filename.endsWith(".ts")) return;
  scheduleReload(filename);
});
console.log(`Watching ${componentsDir} for component changes`);
