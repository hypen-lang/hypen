import { app } from "@hypen-space/core";
import { durableObjectStore, session } from "@hypen-space/cf";

export interface AppState {
  location: string;
}

export default app
  .defineState<AppState>({ location: "/" })
  .persist(durableObjectStore<AppState>(session<AppState>()))
  .ui(`
    module App {
      Column {
        // Router renders no DOM element of its own — wrap it in a Column so
        // Attach patches for cached routes land inside a stable container.
        Column {
          Router {
            Route(path: "/") {
              Browse().tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0A0A0F]")
            }
            Route(path: "/movie/:id") {
              MovieDetail().tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0A0A0F]")
            }
            Route(path: "/watch/:id") {
              Watch().tw("flex-1 h-full min-h-0 overflow-hidden bg-[#050508]")
            }
          }
        }
        .tw("flex-1 w-full min-h-0 overflow-hidden")
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden bg-[#0A0A0F]")
    }
  `);
