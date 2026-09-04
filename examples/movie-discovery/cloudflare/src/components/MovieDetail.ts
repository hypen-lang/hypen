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
  state.saveLabel = state.movie.saved ? "Saved to watchlist" : "Add to watchlist";
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
            Icon(@resources.chevron-left)
              .size(20)
              .color("#F8FAFC")
          }
          .tw("w-10 h-10 rounded-full border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.07)")
          .opacity({ default: 1, active: 0.6 })
          .transition(160, easeOut)
          .onClick(@actions.back)

          Box {}
            .tw("flex-1")

          Button {
            Icon(@resources.bookmark)
              .size(17)
              .color("@{state.movie.saved ? '#34D399' : '#F8FAFC'}")
          }
          .tw("w-10 h-10 rounded-full border items-center justify-center")
          .backgroundColor("@{state.movie.saved ? 'rgba(52, 211, 153, 0.12)' : 'rgba(255, 255, 255, 0.07)'}")
          .borderColor("@{state.movie.saved ? 'rgba(52, 211, 153, 0.35)' : 'rgba(255, 255, 255, 0.10)'}")
          .opacity({ default: 1, active: 0.6 })
          .transition(260, easeOut)
          .onClick(@actions.toggleSaved)
        }
        .tw("px-5 pt-6 pb-3 items-center")
        .maxWidth(900)
        .width("100%")
        .alignSelf("center")

        // The hero's shared key is STATIC on purpose. A key bound to
        // \`state.movie.id\` would be a batch too late: the route's DOM is
        // created in the navigation patch batch — the only batch in which
        // the renderer matches shared-element keys — while this module's
        // \`onActivated\` state write lands in the batch after it. The
        // ambiguity a constant key would normally cause is resolved on the
        // *source* side instead: the list module marks exactly one poster
        // as "movie-hero" (via its own \`openingId\`) before it pushes.
        Image(src: "@{state.movie.posterUrl}")
          .objectFit("cover")
          .objectPosition("center")
          .aspectRatio(0.675)
          .tw("self-center mt-2 w-56 md:w-64 lg:w-72 rounded-3xl border border-white/10")
          .backgroundColor("@{state.movie.posterBg}")
          .sharedElement("movie-hero", curve: spring, duration: 340)

        Column {
          Text("@{state.movie.title}")
            .tw("text-3xl md:text-4xl font-bold mt-6 text-center tracking-tight")
            .color("#F8FAFC")

          Row {
            Icon(@resources.star)
              .size(14)
              .color("#F5C518")
            Text("@{state.movie.ratingLabel}")
              .tw("text-sm font-semibold ml-1")
              .color("#F5C518")
            Text("@{state.movie.meta}")
              .tw("text-sm ml-2")
              .color("#8E8E9A")
          }
          .tw("mt-3 items-center justify-center self-center")

          Row {
            Text("@{state.movie.genre}")
              .tw("text-xs font-medium mr-2 px-3 py-1.5 rounded-full border border-white/10")
              .backgroundColor("rgba(255, 255, 255, 0.06)")
              .color("#C6C6D0")
            Text("@{state.movie.mood}")
              .tw("text-xs font-medium px-3 py-1.5 rounded-full border border-white/10")
              .backgroundColor("rgba(255, 255, 255, 0.06)")
              .color("#C6C6D0")
          }
          .tw("mt-4 self-center")

          Button {
            Text("@{state.saveLabel}")
              .tw("text-[15px] font-semibold")
              .color("@{state.movie.saved ? '#052E16' : '#0B0B10'}")
          }
          .tw("mt-6 h-12 rounded-2xl border-0 items-center justify-center")
          // This is the full CTA, not the icon-sized bookmark above. Declare
          // its width explicitly; unsized Buttons are content-width.
          .width("100%")
          .backgroundColor("@{state.movie.saved ? '#34D399' : '#F5C518'}")
          .opacity({ default: 1, active: 0.75 })
          .transition(280, easeOut)
          .onClick(@actions.toggleSaved)

          Text("Synopsis")
            .tw("text-lg font-bold mt-8")
            .color("#F8FAFC")
          Text("@{state.movie.synopsis}")
            .tw("text-sm md:text-[15px] mt-2.5 leading-6")
            .color("#A6A6B3")

          Text("Cast")
            .tw("text-lg font-bold mt-7")
            .color("#F8FAFC")
          Text("@{state.movie.cast}")
            .tw("text-sm md:text-[15px] mt-2.5 mb-10")
            .color("#A6A6B3")
        }
        .tw("px-5")
        .maxWidth(760)
        .width("100%")
        .alignSelf("center")
        .enter(fade, duration: 320)
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0B0B10")
    }
  `);
