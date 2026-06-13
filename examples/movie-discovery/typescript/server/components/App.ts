import { app } from "@hypen-space/core";

export interface AppState {
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
                .tw("flex-1 min-h-0")
              BottomNav()
                .tw("shrink-0")
            }
            .tw("flex-1 h-full min-h-0 overflow-hidden bg-slate-950")
          }

          Route(path: "/search") {
            Column {
              Search()
                .tw("flex-1 min-h-0")
              BottomNav()
                .tw("shrink-0")
            }
            .tw("flex-1 h-full min-h-0 overflow-hidden bg-slate-950")
          }

          Route(path: "/watchlist") {
            Column {
              Watchlist()
                .tw("flex-1 min-h-0")
              BottomNav()
                .tw("shrink-0")
            }
            .tw("flex-1 h-full min-h-0 overflow-hidden bg-slate-950")
          }

          Route(path: "/profile") {
            Column {
              Profile()
                .tw("flex-1 min-h-0")
              BottomNav()
                .tw("shrink-0")
            }
            .tw("flex-1 h-full min-h-0 overflow-hidden bg-slate-950")
          }

          Route(path: "/movie/:id") {
            MovieDetail()
              .tw("flex-1 min-h-0")
          }
        }
        .tw("flex-1 w-full h-full min-h-0 overflow-hidden")
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden bg-slate-950")
    }
  `);
