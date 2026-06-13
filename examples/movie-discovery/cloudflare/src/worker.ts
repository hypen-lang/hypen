/**
 * Hypen Movie Discovery on Cloudflare.
 *
 * `@hypen-space/cf/worker` supplies the Worker fetch handler, Durable Object,
 * WASM engine wiring, WebSocket transport, and generic browser client. This
 * file declares only the app module graph and routes anonymous BottomNav into
 * the component resolver.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import { app } from "@hypen-space/core";

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

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app,
  componentTemplates: {
    BottomNav: (bottomNavModule as { template?: string }).template ?? "",
  },
  doClassName: "MovieDiscoveryDO",
  binding: "MOVIE_DISCOVERY_DO",
  serveClient: { dom: "/", canvas: "/canvas" },
  title: "Cinebox — Hypen",
});

export const MovieDiscoveryDO = worker.MovieDiscoveryDO;
export default { fetch: worker.fetch };
