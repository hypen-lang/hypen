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
        // The Router lives inside its own Column rather than sitting as a
        // bare sibling of the tab bar: the Router itself renders no DOM
        // element, so an \`Attach\`ed route would be appended after the nav
        // bar instead of before it, and the tab bar would jump to the top of
        // the screen on every navigation.
        Column {
          Router {
            Route(path: "/") {
              Home()
                .tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0B0B10]")
            }

            Route(path: "/search") {
              Search()
                .tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0B0B10]")
            }

            Route(path: "/watchlist") {
              Watchlist()
                .tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0B0B10]")
            }

            Route(path: "/profile") {
              Profile()
                .tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0B0B10]")
            }

            Route(path: "/movie/:id") {
              MovieDetail()
                .tw("flex-1 h-full min-h-0 overflow-hidden bg-[#0B0B10]")
            }
          }
        }
        .tw("flex-1 w-full min-h-0 overflow-hidden")

        // The tab bar is part of the persistent shell, not repeated inside
        // each route. Keeping one element alive across navigations is what
        // lets BottomNav's selected-tab pose actually animate — a per-route
        // copy is created already in the right pose and can only snap. The
        // detail route is full-bleed, so the shell hides the bar there.
        If(condition: "@{state.location == '/' || state.location == '/search' || state.location == '/watchlist' || state.location == '/profile'}") {
          BottomNav()
            .tw("shrink-0")
            .enter(slide, fade, from: bottom, duration: 260)
            .exit(fade, duration: 140)
        }
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden bg-[#0B0B10]")
    }
  `);
