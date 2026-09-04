import { app } from "@hypen-space/core";
import { durableObjectStore, session } from "@hypen-space/cf";

// App — the shell module. The bounded root hosts the param'd Router; the
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
  // Persist `location` to DO storage so a reconnecting client lands
  // on the route they were on. The DO is keyed per session in
  // src/worker.ts, so `session()` and `global()` are equivalent here;
  // we pick `session()` to express intent ("one slot per session").
  // The DO's `state.storage` is wired into this store by
  // `bindAppStateStore(...)` in src/do.ts on every fetch / wake.
  .persist(durableObjectStore<AppState>(session<AppState>()))
  .ui(`
    module App {
      Column {
        Router {
            Route(path: "/") {
              Column {
                Home()
                  .tw("flex-1 min-h-0")
                BottomNav()
                  .tw("shrink-0")
              }
              .tw("flex-1 h-full min-h-0 overflow-hidden bg-white")
            }

            Route(path: "/diary") {
              Column {
                Diary()
                  .tw("flex-1 min-h-0")
                BottomNav()
                  .tw("shrink-0")
              }
              .tw("flex-1 h-full min-h-0 overflow-hidden bg-white")
            }

            Route(path: "/diary/:date") {
              Column {
                Diary()
                  .tw("flex-1 min-h-0")
                BottomNav()
                  .tw("shrink-0")
              }
              .tw("flex-1 h-full min-h-0 overflow-hidden bg-white")
            }

            Route(path: "/add/:meal") {
              AddFood()
                .tw("flex-1 min-h-0")
            }

            Route(path: "/stats") {
              Column {
                Stats()
                  .tw("flex-1 min-h-0")
                BottomNav()
                  .tw("shrink-0")
              }
              .tw("flex-1 h-full min-h-0 overflow-hidden bg-white")
            }

            Route(path: "/profile") {
              Column {
                Profile()
                  .tw("flex-1 min-h-0")
                BottomNav()
                  .tw("shrink-0")
              }
              .tw("flex-1 h-full min-h-0 overflow-hidden bg-white")
            }
        }
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden bg-white")
    }
  `);
