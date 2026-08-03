import { app } from "@hypen-space/core";
import {
  getFeaturedMovie,
  getPrimaryUser,
  getRecommendedMovies,
  getTrendingMovies,
  setSaved,
  type Movie,
} from "../queries";

interface HomeState {
  greeting: string;
  featured: Movie;
  trending: Movie[];
  recommended: Movie[];
}

const EMPTY_MOVIE: Movie = {
  id: "",
  title: "",
  year: 0,
  runtimeMin: 0,
  rating: 0,
  maturity: "",
  genre: "",
  mood: "",
  posterEmoji: "",
  posterUrl: "",
  posterBg: "#1A0813",
  accent: "#FACC15",
  tagline: "",
  synopsis: "",
  cast: "",
  isFeatured: false,
  isTrending: false,
  rank: 0,
  saved: false,
  meta: "",
  ratingLabel: "",
};

async function refresh(state: HomeState) {
  const user = getPrimaryUser();
  state.greeting = `For ${user.name}`;
  state.featured = await getFeaturedMovie(user.id);
  state.trending = await getTrendingMovies(user.id);
  state.recommended = await getRecommendedMovies(user.id);
}

export default app
  .module("Home")
  .defineState<HomeState>({
    greeting: "For you",
    featured: EMPTY_MOVIE,
    trending: [],
    recommended: [],
  })
  .onActivated(async (state) => refresh(state))
  .onAction<{ movieId: string }>("saveMovie", async ({ state, action }) => {
    if (!action.payload) return;
    const user = getPrimaryUser();
    setSaved(user.id, action.payload.movieId, true);
    await refresh(state);
  })
  .ui(`
    module Home {
      Column {
        Row {
          Column {
            Text("Cinebox")
              .tw("text-3xl md:text-4xl lg:text-5xl font-black")
              .color("#F8FAFC")
            Text("@{state.greeting}")
              .tw("text-sm md:text-base mt-1")
              .color("#FBCFE8")
          }
          .tw("flex-1")

          Button {
            Text("⌕")
              .tw("text-2xl")
              .color("#111827")
          }
          .tw("w-12 h-12 md:w-14 md:h-14 rounded-full border-0 items-center justify-center")
          .linearGradient("135deg, #EC4899 0%, #F472B6 100%")
          .boxShadow("0 18px 42px rgba(236, 72, 153, 0.36)")
          .onClick(@router.push, to: "/search")
        }
        .tw("px-5 md:px-8 pt-6 pb-4 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Button {
          Row {
            Column {
              Text("FEATURED TONIGHT")
                .tw("text-xs font-black tracking-wide text-left")
                .color("#FDE68A")
              Text("@{state.featured.title}")
                .tw("text-4xl md:text-5xl lg:text-6xl font-black mt-2 text-left")
                .color("#F8FAFC")
              Text("@{state.featured.tagline}")
                .tw("text-sm md:text-base lg:text-lg mt-3 leading-6 text-left")
                .color("#FFF7ED")
              Row {
                Text("★ @{state.featured.ratingLabel}")
                  .tw("text-sm font-black mr-3 px-3 py-1 rounded-full bg-yellow-300")
                  .color("#0F172A")
                Text("@{state.featured.genre}")
                  .tw("text-sm font-bold px-3 py-1 rounded-full")
                  .backgroundColor("rgba(236, 72, 153, 0.16)")
                  .color("#FBCFE8")
              }
              .tw("mt-4 items-center")
              Text("@{state.featured.meta}")
                .tw("text-sm mt-3")
                .color("#FBCFE8")
            }
            .tw("flex-1 min-w-0 pr-3 md:pr-8 items-start")

            Image(src: "@{state.featured.posterUrl}")
              .objectFit("cover")
              .tw("w-28 h-40 md:w-40 md:h-60 lg:w-48 lg:h-72 rounded-3xl shadow-2xl shrink-0")
              .backgroundColor("@{state.featured.posterBg}")
              .boxShadow("0 24px 48px rgba(0, 0, 0, 0.45)")
          }
          .tw("p-5 md:p-7 rounded-3xl border-0 items-center")
          .linearGradient("135deg, rgba(236, 72, 153, 0.38) 0%, rgba(8, 8, 8, 0.98) 42%, rgba(244, 114, 182, 0.20) 100%")
          .boxShadow("0 28px 72px rgba(236, 72, 153, 0.18)")
        }
        .tw("bg-transparent border-0 px-5 md:px-8 py-0")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
        .onClick(@router.push, to: "/movie/@{state.featured.id}")

        Row {
          Text("Trending now")
            .tw("flex-1 text-2xl md:text-[28px] lg:text-3xl font-black")
            .color("#F8FAFC")
          Text("Top 8")
            .tw("text-sm md:text-base font-bold")
            .color("#F9A8D4")
        }
        .tw("px-5 md:px-8 pt-8 pb-4 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Row {
          ForEach(items: @state.trending, key: "id") {
            Button {
              Column {
                Image(src: "@{item.posterUrl}")
                  .objectFit("cover")
                  .tw("w-36 h-52 md:w-40 md:h-60 lg:w-44 lg:h-64 rounded-3xl shadow-2xl")
                  .backgroundColor("@{item.posterBg}")
                  .boxShadow("0 22px 44px rgba(0, 0, 0, 0.42)")

                Text("@{item.title}")
                  .tw("w-36 md:w-40 lg:w-44 text-base md:text-base lg:text-lg font-black mt-3 text-center")
                  .color("#F8FAFC")
                Text("★ @{item.ratingLabel}")
                  .tw("w-36 md:w-40 lg:w-44 text-sm font-bold mt-1 text-center")
                  .color("#FACC15")
                Text("@{item.genre}")
                  .tw("w-36 md:w-40 lg:w-44 text-xs mt-1 text-center")
                  .color("#FBCFE8")
              }
              .tw("items-center")
            }
            .tw("mr-4 md:mr-5 bg-transparent border-0 p-0 shrink-0")
            .onClick(@router.push, to: "/movie/@{item.id}")
          }
        }
        .scrollable("horizontal")
        .tw("px-5 md:px-8 flex-row")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Row {
          Text("Because you like smart stories")
            .tw("flex-1 text-2xl md:text-[28px] lg:text-3xl font-black")
            .color("#F8FAFC")
        }
        .tw("px-5 md:px-8 pt-8 pb-4")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Grid(@state.recommended, key: "id") {
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
        .tw("px-5 md:px-8 pb-8")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .linearGradient("180deg, #050505 0%, #190812 54%, #050505 100%")
    }
  `);
