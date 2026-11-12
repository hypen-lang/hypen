import { app } from "@hypen-space/core";

export interface AppState {
  location: string;
}

// The shell: a Router in its own Column (the Router renders no DOM element of
// its own, so Attach patches for cached routes land inside a stable
// container) and a persistent BottomNav outside it, hidden on the full-bleed
// detail routes. Same structure as movie-discovery.
const SCREEN = `.tw("flex-1 h-full min-h-0 overflow-hidden").backgroundColor("#0E0E11")`;

export default app
  .defineState<AppState>({ location: "/" })
  .ui(`
    module App {
      Column {
        Column {
          Router {
            Route(path: "/") { Today()${SCREEN} }
            Route(path: "/hn") { Hacker()${SCREEN} }
            Route(path: "/onthisday") { OnThisDay()${SCREEN} }
            Route(path: "/saved") { Saved()${SCREEN} }
            Route(path: "/story/:id") { Story()${SCREEN} }
            Route(path: "/wiki/:title") { Article()${SCREEN} }
          }
        }
        .tw("flex-1 w-full min-h-0 overflow-hidden")

        If(condition: "@{state.location == '/' || state.location == '/hn' || state.location == '/onthisday' || state.location == '/saved'}") {
          BottomNav()
            .tw("shrink-0")
            .enter(slide, fade, from: bottom, duration: 240)
            .exit(fade, duration: 140)
        }
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden")
      .backgroundColor("#0E0E11")
      .fontFamily("Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif")
    }
  `);
