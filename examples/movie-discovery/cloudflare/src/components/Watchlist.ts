import { app } from "@hypen-space/core";
import { getPrimaryUser, getWatchlist, setSaved, type Movie } from "../queries";

interface WatchlistState {
  movies: Movie[];
  countLabel: string;
  empty: boolean;
  /**
   * The row that is the shared-element source for the next navigation into
   * `/movie/:id`. MovieDetail's hero uses a constant `movie-hero` key (its
   * own state lands a batch after the navigation renders), so the "key
   * appears exactly twice" rule is enforced here: exactly one poster
   * resolves to `movie-hero`, the rest resolve to `""` — no identity, no
   * warning. `openMovie` writes it synchronously before pushing.
   */
  openingId: string;
}

async function refresh(state: WatchlistState) {
  const user = getPrimaryUser();
  state.movies = await getWatchlist(user.id);
  state.empty = state.movies.length === 0;
  state.countLabel = `${state.movies.length} saved`;
}

export default app
  .module("Watchlist")
  .defineState<WatchlistState>({
    movies: [],
    countLabel: "0 saved",
    empty: true,
    openingId: "",
  })
  .onActivated(async (state) => {
    // Consume the shared-element mark — see Home.ts for the full reasoning.
    state.openingId = "";
    await refresh(state);
  })
  .onAction<{ movieId: string }>("openMovie", ({ state, action, context }) => {
    if (!action.payload) return;
    state.openingId = action.payload.movieId;
    context?.router?.push(`/movie/${action.payload.movieId}`);
  })
  .onAction<{ movieId: string }>("remove", async ({ state, action }) => {
    if (!action.payload) return;
    const user = getPrimaryUser();
    setSaved(user.id, action.payload.movieId, false);
    await refresh(state);
  })
  .ui(`
    module Watchlist {
      Column {
        Row {
          Column {
            Text("Watchlist")
              .tw("text-3xl md:text-4xl font-black")
              .color("#F8FAFC")
            Text("@{state.countLabel}")
              .tw("text-sm mt-1")
              .color("#94A3B8")
          }
          .tw("flex-1")

          Button {
            Text("＋")
              .tw("text-2xl")
              .color("#0F172A")
          }
          .tw("w-12 h-12 rounded-full bg-yellow-300 border-0 items-center justify-center")
          .opacity({ default: 1, active: 0.6 })
          .transition(160, easeOut)
          .onClick(@router.push, to: "/search")
        }
        .tw("px-5 pt-6 pb-4 items-center")

        Column {
          List(@state.movies, key: "id") {
            Row {
              Button {
                Row {
                  Image(src: "@{item.posterUrl}")
                    .tw("w-20 h-28 rounded-2xl mr-4")
                    .backgroundColor("@{item.posterBg}")
                    .sharedElement("@{item.id == state.openingId ? 'movie-hero' : ''}", curve: spring, duration: 340)

                  Column {
                    Text("@{item.title}")
                      .tw("text-lg md:text-xl font-black")
                      .color("#F8FAFC")
                    Text("@{item.tagline}")
                      .tw("text-xs md:text-sm mt-1")
                      .color("#CBD5E1")
                    Text("★ @{item.ratingLabel} · @{item.genre} · @{item.runtimeMin} min")
                      .tw("text-xs mt-2")
                      .color("#94A3B8")
                  }
                  .tw("flex-1")
                }
                .tw("flex-1 items-center")
              }
              .tw("flex-1 bg-transparent border-0 p-0")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@actions.openMovie, movieId: "@{item.id}")

              Button {
                Text("−")
                  .tw("text-2xl font-black")
                  .color("#F8FAFC")
              }
              .tw("w-10 h-10 rounded-full bg-slate-800 border border-slate-700 items-center justify-center")
              .opacity({ default: 1, active: 0.55 })
              .transition(160, easeOut)
              .onClick(@actions.remove, movieId: "@{item.id}")
            }
            .tw("mx-5 mb-3 p-3 rounded-2xl bg-slate-900 border border-slate-800 items-center")
            .enter(slide, fade, from: bottom, duration: 300)
            .exit(fade, duration: 220)
            .layout(spring)
          }

          If(condition: @state.empty) {
            Column {
              Text("Your watchlist is empty")
                .tw("text-xl font-black")
                .color("#F8FAFC")
              Text("Save a few movies from Search or Home.")
                .tw("text-sm mt-2 text-center")
                .color("#94A3B8")
              Button {
                Text("Browse movies")
                  .tw("text-base font-black")
                  .color("#0F172A")
              }
              .tw("mt-5 px-5 py-3 rounded-2xl bg-yellow-300 border-0")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@router.push, to: "/search")
            }
            .tw("mx-5 mt-10 p-8 rounded-3xl bg-slate-900 border border-slate-800 items-center")
            .enter(fade, duration: 320)
            .exit(fade, duration: 140)
          }
        }
        .tw("pb-8")
      }
      .scrollable(true)
      .tw("flex-1 bg-slate-950")
    }
  `);
