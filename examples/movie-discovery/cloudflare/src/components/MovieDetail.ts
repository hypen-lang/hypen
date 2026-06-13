import { app } from "@hypen-space/core";
import { getMovie, getPrimaryUser, setSaved, type Movie } from "../queries";

interface DetailState {
  movie: Movie;
  loaded: boolean;
  saveLabel: string;
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
  posterBg: "#111827",
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

async function refresh(state: DetailState, movieId: string) {
  const user = getPrimaryUser();
  const movie = await getMovie(user.id, movieId);
  state.loaded = Boolean(movie);
  state.movie = movie ?? EMPTY_MOVIE;
  state.saveLabel = state.movie.saved ? "✓ Added to watchlist" : "Add to watchlist";
}

export default app
  .module("MovieDetail")
  .defineState<DetailState>({
    movie: EMPTY_MOVIE,
    loaded: false,
    saveLabel: "Add to watchlist",
  })
  .onActivated(async (state, context) => {
    const path = context?.router?.getCurrentPath() ?? "/";
    const match = context?.router?.matchPath("/movie/:id", path);
    await refresh(state, match?.params.id ?? "");
  })
  .onAction("back", async ({ context }) => {
    context?.router?.push("/");
  })
  .onAction("toggleSaved", async ({ state }) => {
    const user = getPrimaryUser();
    setSaved(user.id, state.movie.id, !state.movie.saved);
    await refresh(state, state.movie.id);
  })
  .ui(`
    module MovieDetail {
      Column {
        Row {
          Button {
            Text("‹")
              .tw("text-3xl leading-none")
              .color("#F8FAFC")
          }
          .tw("w-11 h-11 rounded-full bg-slate-900 border-0 items-center justify-center")
          .onClick(@actions.back)

          Box {}
            .tw("flex-1")

          Button {
            Text("@{state.movie.saved ? '✓' : '+'}")
              .tw("text-xl font-black")
              .color("@{state.movie.saved ? '#052E16' : '#F8FAFC'}")
          }
          .tw("w-11 h-11 rounded-full border border-slate-700 items-center justify-center")
          .backgroundColor("@{state.movie.saved ? '#22C55E' : '#2A0B1B'}")
          .onClick(@actions.toggleSaved)
        }
        .tw("px-5 pt-6 pb-3 items-center")
        .maxWidth(900)
        .width("100%")
        .alignSelf("center")

        Image(src: "@{state.movie.posterUrl}")
          .objectFit("cover")
          .objectPosition("center")
          .aspectRatio(0.675)
          .tw("self-center mt-2 w-56 md:w-64 lg:w-72 rounded-3xl border border-white/10")
          .backgroundColor("@{state.movie.posterBg}")

        Column {
          Text("@{state.movie.title}")
            .tw("text-4xl md:text-5xl font-black mt-6")
            .color("#F8FAFC")
          Text("@{state.movie.tagline}")
            .tw("text-base md:text-lg mt-3")
            .color("#CBD5E1")

          Row {
            Text("★ @{state.movie.ratingLabel}")
              .tw("text-sm font-bold mr-3 px-3 py-1 rounded-full bg-yellow-300")
              .color("#0F172A")
            Text("@{state.movie.meta}")
              .tw("text-sm")
              .color("#94A3B8")
          }
          .tw("mt-4 items-center")

          Row {
            Text("@{state.movie.genre}")
              .tw("text-xs font-bold mr-2 px-3 py-2 rounded-full bg-slate-800")
              .color("#CBD5E1")
            Text("@{state.movie.mood}")
              .tw("text-xs font-bold px-3 py-2 rounded-full bg-slate-800")
              .color("#CBD5E1")
          }
          .tw("mt-4")

          Button {
            Text("@{state.saveLabel}")
              .tw("text-base font-black")
              .color("@{state.movie.saved ? '#052E16' : '#0F172A'}")
          }
          .tw("mt-6 h-14 rounded-2xl border-0 items-center justify-center")
          .backgroundColor("@{state.movie.saved ? '#22C55E' : '#FACC15'}")
          .boxShadow("@{state.movie.saved ? '0 18px 38px rgba(34, 197, 94, 0.24)' : '0 18px 38px rgba(250, 204, 21, 0.22)'}")
          .onClick(@actions.toggleSaved)

          Text("Synopsis")
            .tw("text-xl font-bold mt-8")
            .color("#F8FAFC")
          Text("@{state.movie.synopsis}")
            .tw("text-sm md:text-base mt-3 leading-6")
            .color("#CBD5E1")

          Text("Cast")
            .tw("text-xl font-bold mt-7")
            .color("#F8FAFC")
          Text("@{state.movie.cast}")
            .tw("text-sm md:text-base mt-3 mb-10")
            .color("#CBD5E1")
        }
        .tw("px-5")
        .maxWidth(760)
        .width("100%")
        .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .linearGradient("180deg, #050505 0%, #190812 54%, #050505 100%")
    }
  `);
