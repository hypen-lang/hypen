import { app } from "@hypen-space/core";

// App — the shell module. Now a bare Router with param'd routes; the
// URL is the single source of truth for "which day / which meal" each
// screen is showing. No cross-module state reads, no shared App state
// beyond `location` (which the client mirrors from the URL via the
// engine's `navigation.viewStateKey` wiring).
//
// Routes:
//   /                    Home — always "today"
//   /diary               Diary — today
//   /diary/:date         Diary — specific YYYY-MM-DD
//   /add/:meal           Add Food — meal from path, logs against today
//   /stats               Stats — local anchor/mode state on the screen
//   /profile             Profile

export interface AppState {
  // Mirrored from the URL by `navigation.viewStateKey: "location"` on
  // the client. Read by BottomNav's tab-highlight expression.
  location: string;
}

export default app
  .defineState<AppState>({ location: "/" })
  .ui(`
    module App {
      Column {
        Router {
          Route(path: "/") {
            Column {
              Home()
                .tw("flex-1")
              BottomNav()
            }
            .tw("flex-1 bg-white")
          }

          Route(path: "/diary") {
            Column {
              Diary()
                .tw("flex-1")
              BottomNav()
            }
            .tw("flex-1 bg-white")
          }

          Route(path: "/diary/:date") {
            Column {
              Diary()
                .tw("flex-1")
              BottomNav()
            }
            .tw("flex-1 bg-white")
          }

          Route(path: "/add/:meal") {
            AddFood()
              .tw("flex-1")
          }

          Route(path: "/stats") {
            Column {
              Stats()
                .tw("flex-1")
              BottomNav()
            }
            .tw("flex-1 bg-white")
          }

          Route(path: "/profile") {
            Column {
              Profile()
                .tw("flex-1")
              BottomNav()
            }
            .tw("flex-1 bg-white")
          }
        }
        .tw("flex-1 w-full h-full")
      }
      .tw("flex-1 w-full min-h-screen bg-white")
    }
  `);
