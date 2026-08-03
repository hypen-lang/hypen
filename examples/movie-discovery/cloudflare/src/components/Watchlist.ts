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
              .tw("text-2xl md:text-3xl font-bold tracking-tight")
              .color("#F8FAFC")
            Text("@{state.countLabel}")
              .tw("text-[13px] mt-0.5")
              .color("#8E8E9A")
          }
          .tw("flex-1")

          Button {
            Icon(@resources.plus)
              .size(18)
              .color("#F8FAFC")
          }
          .tw("w-10 h-10 rounded-full border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.07)")
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
                    .tw("w-16 h-24 rounded-xl mr-3.5 border border-white/10")
                    .backgroundColor("@{item.posterBg}")
                    .sharedElement("@{item.id == state.openingId ? 'movie-hero' : ''}", curve: spring, duration: 340)

                  Column {
                    Text("@{item.title}")
                      .tw("text-[15px] font-semibold")
                      .color("#F8FAFC")
                    Row {
                      Icon(@resources.star)
                        .size(11)
                        .color("#F5C518")
                      Text("@{item.ratingLabel} · @{item.genre}")
                        .tw("text-xs ml-1 truncate")
                        .color("#8E8E9A")
                    }
                    .tw("mt-1.5 items-center w-full")
                    Text("@{item.runtimeMin} min")
                      .tw("text-xs mt-1")
                      .color("#8E8E9A")
                  }
                  .tw("flex-1 items-start min-w-0")
                }
                .tw("flex-1 items-center")
              }
              .tw("flex-1 min-w-0 bg-transparent border-0 p-0")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@actions.openMovie, movieId: "@{item.id}")

              Button {
                Icon(@resources.x)
                  .size(15)
                  .color("#8E8E9A")
              }
              .tw("w-9 h-9 rounded-full border border-white/10 items-center justify-center shrink-0 ml-2")
              .backgroundColor("rgba(255, 255, 255, 0.05)")
              .opacity({ default: 1, active: 0.55 })
              .transition(160, easeOut)
              .onClick(@actions.remove, movieId: "@{item.id}")
            }
            .tw("mb-3 p-3 rounded-2xl border border-white/10 items-center")
            .backgroundColor("rgba(255, 255, 255, 0.04)")
            .enter(slide, fade, from: bottom, duration: 300)
            .exit(fade, duration: 220)
            .layout(spring)
          }

          If(condition: @state.empty) {
            Column {
              Text("Your watchlist is empty")
                .tw("text-[15px] font-semibold")
                .color("#F8FAFC")
              Text("Save a few movies from Search or Home.")
                .tw("text-[13px] mt-1.5 text-center")
                .color("#8E8E9A")
              Button {
                Text("Browse movies")
                  .tw("text-sm font-semibold")
                  .color("#0B0B10")
              }
              .tw("mt-5 px-5 py-2.5 rounded-xl border-0")
              .backgroundColor("#F5C518")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@router.push, to: "/search")
            }
            .tw("mt-10 p-8 rounded-2xl border border-white/10 items-center")
            .backgroundColor("rgba(255, 255, 255, 0.04)")
            .enter(fade, duration: 320)
            .exit(fade, duration: 140)
          }
        }
        .tw("px-5 pb-8")
      }
      .scrollable(true)
      .tw("flex-1 bg-[#0B0B10]")
    }
  `);
