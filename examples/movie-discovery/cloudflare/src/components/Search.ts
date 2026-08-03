import { app } from "@hypen-space/core";
import {
  genreTabs,
  getPrimaryUser,
  searchMovies,
  setSaved,
  type GenreTab,
  type Movie,
} from "../queries";

interface SearchState {
  query: string;
  genre: string;
  tabs: GenreTab[];
  results: Movie[];
  empty: boolean;
  headline: string;
}

async function refresh(state: SearchState) {
  const user = getPrimaryUser();
  state.results = await searchMovies(user.id, state.query, state.genre);
  state.empty = state.results.length === 0;
  state.headline = state.query.trim() ? `Results for "${state.query.trim()}"` : "Browse movies";
}

export default app
  .module("Search")
  .defineState<SearchState>({
    query: "",
    genre: "All",
    tabs: genreTabs("All"),
    results: [],
    empty: false,
    headline: "Browse movies",
  })
  .onActivated(async (state) => {
    state.query = "";
    state.genre = "All";
    state.tabs = genreTabs("All");
    await refresh(state);
  })
  .onAction("search", async ({ state }) => refresh(state))
  .onAction<{ genre: string }>("selectGenre", async ({ state, action }) => {
    if (!action.payload) return;
    state.genre = action.payload.genre;
    state.tabs = genreTabs(state.genre);
    await refresh(state);
  })
  .onAction<{ movieId: string }>("saveMovie", async ({ state, action }) => {
    if (!action.payload) return;
    const user = getPrimaryUser();
    setSaved(user.id, action.payload.movieId, true);
    await refresh(state);
  })
  .ui(`
    module Search {
      Column {
        Row {
          Button {
            Text("‹")
              .tw("text-3xl leading-none")
              .color("#F8FAFC")
          }
          .tw("w-10 h-10 rounded-full border-0 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.12)")
          .boxShadow("0 16px 32px rgba(2, 6, 23, 0.45)")
          .onClick(@router.push, to: "/")

          Text("Search")
            .tw("flex-1 text-2xl md:text-[28px] lg:text-3xl font-black text-center")
            .color("#F8FAFC")

          Box {}
            .tw("w-10 h-10")
        }
        .tw("px-5 pt-6 pb-4 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Row {
          Text("⌕")
            .tw("text-xl mr-3")
            .color("#FACC15")
          Input(placeholder: "Title, mood, or genre")
            .bind(@state.query)
            .onInput(@actions.search)
            .tw("flex-1 bg-transparent border-0 outline-none")
            .color("#FFF7ED")
            .fontSize(16)
        }
        .tw("mx-5 px-4 py-4 rounded-3xl border-0 items-center")
        .backgroundColor("rgba(255, 255, 255, 0.10)")
        .boxShadow("0 18px 38px rgba(2, 6, 23, 0.38)")
        .maxWidth(1120)
        .width("calc(100% - 40px)")
        .alignSelf("center")

        Row {
          ForEach(items: @state.tabs, key: "id") {
            Button {
              Text("@{item.label}")
                .tw("text-sm md:text-sm lg:text-base font-black")
                .color("@{item.active ? '#0F172A' : '#CBD5E1'}")
            }
            .tw("mr-2 px-5 py-3 rounded-full border-0 shadow-lg shrink-0")
            .backgroundColor("@{item.active ? '#FACC15' : 'rgba(236, 72, 153, 0.14)'}")
            .boxShadow("@{item.active ? '0 16px 32px rgba(250, 204, 21, 0.24)' : '0 10px 24px rgba(236, 72, 153, 0.18)'}")
            .onClick(@actions.selectGenre, genre: "@{item.id}")
          }
        }
        .scrollable("horizontal")
        .tw("px-5 md:px-8 pt-7 pb-4 flex-row")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Text("@{state.headline}")
          .tw("px-5 md:px-8 pt-6 pb-3 text-2xl md:text-[28px] lg:text-3xl font-black")
          .color("#F8FAFC")
          .maxWidth(1180)
          .width("100%")
          .alignSelf("center")

        Column {
          Grid(@state.results, key: "id") {
            Column {
              Image(src: "@{item.posterUrl}")
                .objectFit("cover")
                .tw("w-full aspect-[2/3] rounded-3xl shadow-xl")
                .backgroundColor("@{item.posterBg}")
                .boxShadow("0 18px 34px rgba(0, 0, 0, 0.36)")

              Text("@{item.title}")
                .tw("text-base md:text-base lg:text-lg font-black mt-3")
                .color("#F8FAFC")
              Text("★ @{item.ratingLabel} · @{item.year}")
                .tw("text-xs font-bold mt-1")
                .color("#FACC15")
              Text("@{item.genre}")
                .tw("text-xs mt-1")
                .color("#FBCFE8")
              Button {
                Text("@{item.saved ? '✓ Added to watchlist' : '+ Watchlist'}")
                  .tw("text-xs font-black")
                  .color("@{item.saved ? '#052E16' : '#F8FAFC'}")
              }
              .tw("mt-3 py-3 rounded-2xl border-0 shadow-lg items-center justify-center")
              .backgroundColor("@{item.saved ? '#22C55E' : '#2A0B1B'}")
              .boxShadow("@{item.saved ? '0 14px 28px rgba(34, 197, 94, 0.24)' : '0 12px 24px rgba(236, 72, 153, 0.20)'}")
              .onClick(@actions.saveMovie, movieId: "@{item.id}")
            }
            .tw("p-0 border-0")
          }
          .gridColumns({default: 2, md: 3, lg: 4})
          .gap(12)
          .tw("px-5 md:px-8")
          .maxWidth(1180)
          .width("100%")
          .alignSelf("center")

          If(condition: @state.empty) {
            Column {
              Text("No movies found")
                .tw("text-lg font-bold")
                .color("#F8FAFC")
              Text("Try another mood, genre, or title.")
                .tw("text-sm mt-2")
                .color("#FBCFE8")
            }
            .tw("mx-5 mt-6 p-6 rounded-3xl border-0 items-center")
            .backgroundColor("rgba(255, 255, 255, 0.10)")
            .boxShadow("0 18px 42px rgba(2, 6, 23, 0.35)")
          }
        }
        .tw("pb-8")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .linearGradient("180deg, #050505 0%, #190812 54%, #050505 100%")
    }
  `);
