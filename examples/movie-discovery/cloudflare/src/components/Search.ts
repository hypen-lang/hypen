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
            Icon(@resources.chevron-left)
              .size(20)
              .color("#F8FAFC")
          }
          .tw("w-10 h-10 rounded-full border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.07)")
          .opacity({ default: 1, active: 0.6 })
          .transition(160, easeOut)
          .onClick(@router.push, to: "/")

          Text("Search")
            .tw("flex-1 text-lg md:text-xl font-bold text-center")
            .color("#F8FAFC")

          Box {}
            .tw("w-10 h-10")
        }
        .tw("px-5 pt-6 pb-4 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Row {
          Icon(@resources.search)
            .size(17)
            .color("#8E8E9A")
          Input(placeholder: "Title, mood, or genre")
            .bind(@state.query)
            .onInput(@actions.search)
            .tw("flex-1 bg-transparent border-0 outline-none ml-3")
            .color("#F8FAFC")
            .fontSize(15)
        }
        .tw("mx-5 px-4 py-3.5 rounded-2xl border border-white/10 items-center")
        .backgroundColor("rgba(255, 255, 255, 0.06)")
        .maxWidth(1120)
        .width("calc(100% - 40px)")
        .alignSelf("center")

        Row {
          ForEach(items: @state.tabs, key: "id") {
            Button {
              Text("@{item.label}")
                .tw("text-[13px] font-semibold")
                .color("@{item.active ? '#0B0B10' : '#C6C6D0'}")
                .transition(220, easeOut, props: [color])
            }
            .tw("mr-2 px-4 py-2 rounded-full border shrink-0")
            .backgroundColor("@{item.active ? '#F5C518' : 'rgba(255, 255, 255, 0.06)'}")
            .borderColor("@{item.active ? '#F5C518' : 'rgba(255, 255, 255, 0.10)'}")
            .opacity({ default: 1, active: 0.7 })
            .transition(220, easeOut)
            .onClick(@actions.selectGenre, genre: "@{item.id}", animate: spring)
          }
        }
        .scrollable("horizontal")
        .tw("px-5 md:px-8 pt-5 pb-3 flex-row")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Text("@{state.headline}")
          .tw("px-5 md:px-8 pt-4 pb-3 text-lg md:text-xl font-bold")
          .color("#F8FAFC")
          .maxWidth(1180)
          .width("100%")
          .alignSelf("center")

        Column {
          Grid(@state.results, key: "id") {
            Column {
              Image(src: "@{item.posterUrl}")
                .objectFit("cover")
                .tw("w-full aspect-[2/3] rounded-2xl border border-white/10")
                .backgroundColor("@{item.posterBg}")
                .boxShadow("0 14px 28px rgba(0, 0, 0, 0.35)")

              Text("@{item.title}")
                .tw("text-[13px] font-semibold mt-2.5")
                .color("#F8FAFC")
              Row {
                Icon(@resources.star)
                  .size(11)
                  .color("#F5C518")
                Text("@{item.ratingLabel} · @{item.year}")
                  .tw("text-xs ml-1")
                  .color("#8E8E9A")
              }
              .tw("mt-1 items-center")

              Button {
                Row {
                  Text("@{item.saved ? 'Saved' : '+ Watchlist'}")
                    .tw("text-xs font-semibold")
                    .color("@{item.saved ? '#34D399' : '#E4E4EB'}")
                }
                .tw("items-center")
              }
              .tw("mt-2.5 py-2.5 rounded-xl border items-center justify-center w-full")
              .backgroundColor("@{item.saved ? 'rgba(52, 211, 153, 0.10)' : 'rgba(255, 255, 255, 0.07)'}")
              .borderColor("@{item.saved ? 'rgba(52, 211, 153, 0.35)' : 'rgba(255, 255, 255, 0.12)'}")
              .opacity({ default: 1, active: 0.7 })
              .transition(260, easeOut)
              .onClick(@actions.saveMovie, movieId: "@{item.id}")
            }
            .tw("p-0 border-0 items-start")
            .enter(fade, duration: 260)
            .exit(fade, duration: 140)
            .layout(spring)
          }
          .gridColumns({default: 2, md: 3, lg: 4})
          .gap(14)
          .tw("px-5 md:px-8")
          .maxWidth(1180)
          .width("100%")
          .alignSelf("center")

          If(condition: @state.empty) {
            Column {
              Text("No movies found")
                .tw("text-[15px] font-semibold")
                .color("#F8FAFC")
              Text("Try another mood, genre, or title.")
                .tw("text-[13px] mt-1.5")
                .color("#8E8E9A")
            }
            .tw("mx-5 mt-6 p-6 rounded-2xl border border-white/10 items-center")
            .backgroundColor("rgba(255, 255, 255, 0.04)")
            .enter(slide, fade, from: bottom, duration: 280)
            .exit(fade, duration: 140)
          }
        }
        .tw("pb-8")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0B0B10")
    }
  `);
