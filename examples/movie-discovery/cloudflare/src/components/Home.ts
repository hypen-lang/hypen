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
  /**
   * Which poster on this screen is the shared-element source for the next
   * navigation into `/movie/:id` — `"featured"` for the hero card, else the
   * tapped movie's id.
   *
   * MovieDetail's hero carries a *constant* `movie-hero` key because its own
   * state lands a patch batch after the navigation renders. So the "exactly
   * twice" rule has to be enforced here: exactly one poster resolves its key
   * to `movie-hero`, every other one resolves to `""` (which the renderer
   * treats as no identity at all, silently). `openMovie` writes this
   * synchronously *before* pushing, so the mark is already applied by the
   * time the navigation batch snapshots its sources.
   *
   * The featured card needs the `"featured"` token rather than its movie id
   * because the featured movie is also `trending[0]` — keying both would be
   * a duplicate source (first wins, plus a dev warning).
   */
  openingId: string;
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

// The hero card shows `tagline`, which OMDb fills with the full plot — clamp
// it to the first sentence (or ~150 chars) so the featured card stays compact.
function shortTagline(text: string): string {
  const sentence = text.match(/^.{20,150}?\./);
  if (sentence) return sentence[0];
  return text.length > 150 ? `${text.slice(0, 147).trimEnd()}…` : text;
}

async function refresh(state: HomeState) {
  const user = getPrimaryUser();
  state.greeting = `For ${user.name}`;
  const featured = await getFeaturedMovie(user.id);
  state.featured = { ...featured, tagline: shortTagline(featured.tagline) };
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
    openingId: "",
  })
  .onActivated(async (state) => {
    // Consume the shared-element mark. Coming back from the detail route the
    // reverse FLIP has already matched by the time this lands (module state
    // writes flush a batch after the navigation renders), so clearing here
    // keeps a stale `movie-hero` source from following the user onto the
    // next tab and warning about an unmatched key.
    state.openingId = "";
    await refresh(state);
  })
  .onAction<{ movieId: string; token?: string }>("openMovie", ({ state, action, context }) => {
    if (!action.payload) return;
    // Synchronous, then push: the mark flushes in its own render before the
    // router's location write triggers the navigation batch.
    state.openingId = action.payload.token || action.payload.movieId;
    context?.router?.push(`/movie/${action.payload.movieId}`);
  })
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
              .tw("text-2xl md:text-3xl font-bold tracking-tight")
              .color("#F8FAFC")
            Text("@{state.greeting}")
              .tw("text-[13px] mt-0.5")
              .color("#8E8E9A")
          }
          .tw("flex-1")

          Button {
            Icon(@resources.search)
              .size(18)
              .color("#F8FAFC")
          }
          .tw("w-10 h-10 md:w-11 md:h-11 rounded-full border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.07)")
          .opacity({ default: 1, active: 0.6 })
          .transition(160, easeOut)
          .onClick(@router.push, to: "/search")
        }
        .tw("px-5 md:px-8 pt-6 pb-5 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Button {
          Row {
            Column {
              Text("FEATURED TONIGHT")
                .tw("text-[10px] font-bold tracking-widest text-left")
                .color("#F5C518")
              Text("@{state.featured.title}")
                .tw("text-3xl md:text-4xl lg:text-5xl font-bold mt-2 text-left tracking-tight")
                .color("#F8FAFC")

              Row {
                Icon(@resources.star)
                  .size(13)
                  .color("#F5C518")
                Text("@{state.featured.ratingLabel}")
                  .tw("text-[13px] font-semibold ml-1")
                  .color("#F5C518")
                Text("@{state.featured.meta}")
                  .tw("text-[13px] ml-2")
                  .color("#8E8E9A")
              }
              .tw("mt-3 items-center")

              Text("@{state.featured.tagline}")
                .tw("text-[13px] md:text-sm mt-3 leading-5 text-left")
                .color("#A6A6B3")

              Text("@{state.featured.genre}")
                .tw("text-xs mt-3")
                .color("#8E8E9A")
            }
            .tw("flex-1 min-w-0 pr-4 md:pr-8 items-start")

            Image(src: "@{state.featured.posterUrl}")
              .objectFit("cover")
              .tw("w-28 h-[168px] md:w-40 md:h-60 lg:w-48 lg:h-72 rounded-2xl shrink-0 border border-white/10")
              .backgroundColor("@{state.featured.posterBg}")
              .boxShadow("0 20px 44px rgba(0, 0, 0, 0.5)")
              .sharedElement("@{state.openingId == 'featured' ? 'movie-hero' : ''}", curve: spring, duration: 340)
          }
          .tw("p-5 md:p-7 rounded-3xl border border-white/10 items-center")
          .backgroundColor("rgba(255, 255, 255, 0.04)")
        }
        .tw("bg-transparent border-0 px-5 md:px-8 py-0")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
        .opacity({ default: 1, active: 0.82 })
        .transition(180, easeOut)
        .onClick(@actions.openMovie, movieId: "@{state.featured.id}", token: "featured")

        Row {
          Text("Trending now")
            .tw("flex-1 text-lg md:text-xl font-bold")
            .color("#F8FAFC")
          Text("Top 8")
            .tw("text-xs font-semibold")
            .color("#F5C518")
        }
        .tw("px-5 md:px-8 pt-7 pb-4 items-center")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        If(condition: "@{length(state.trending) == 0}") {
          Row {
            Box {}
              .tw("w-32 h-48 md:w-40 md:h-60 rounded-2xl mr-4 shrink-0")
              .backgroundColor("rgba(255, 255, 255, 0.05)")
              .animate(shimmer)
            Box {}
              .tw("w-32 h-48 md:w-40 md:h-60 rounded-2xl mr-4 shrink-0")
              .backgroundColor("rgba(255, 255, 255, 0.05)")
              .animate(shimmer, delay: 120)
            Box {}
              .tw("w-32 h-48 md:w-40 md:h-60 rounded-2xl mr-4 shrink-0")
              .backgroundColor("rgba(255, 255, 255, 0.05)")
              .animate(shimmer, delay: 240)
          }
          .tw("px-5 md:px-8 flex-row")
          .maxWidth(1180)
          .width("100%")
          .alignSelf("center")
          .exit(fade, duration: 160)
        }

        Row {
          ForEach(items: @state.trending, key: "id") {
            Button {
              Column {
                Image(src: "@{item.posterUrl}")
                  .objectFit("cover")
                  .tw("w-32 h-48 md:w-40 md:h-60 rounded-2xl border border-white/10")
                  .backgroundColor("@{item.posterBg}")
                  .boxShadow("0 14px 30px rgba(0, 0, 0, 0.4)")
                  .sharedElement("@{item.id == state.openingId ? 'movie-hero' : ''}", curve: spring, duration: 340)

                Text("@{item.title}")
                  .tw("w-32 md:w-40 text-[13px] font-semibold mt-2.5 text-left")
                  .color("#F8FAFC")
                Row {
                  Icon(@resources.star)
                    .size(11)
                    .color("#F5C518")
                  Text("@{item.ratingLabel} · @{item.year}")
                    .tw("text-xs ml-1")
                    .color("#8E8E9A")
                }
                .tw("w-32 md:w-40 mt-1 items-center")
              }
              .tw("items-start")
            }
            .tw("mr-4 bg-transparent border-0 p-0 shrink-0")
            .enter(fade, duration: 320)
            .opacity({ default: 1, active: 0.7 })
            .transition(160, easeOut)
            .onClick(@actions.openMovie, movieId: "@{item.id}")
          }
        }
        .scrollable("horizontal")
        .tw("px-5 md:px-8 flex-row")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Row {
          Text("Recommended for you")
            .tw("flex-1 text-lg md:text-xl font-bold")
            .color("#F8FAFC")
        }
        .tw("px-5 md:px-8 pt-7 pb-4")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")

        Grid(@state.recommended, key: "id") {
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
          .enter(fade, duration: 300)
        }
        .gridColumns({default: 2, md: 3, lg: 4})
        .gap(14)
        .tw("px-5 md:px-8 pb-8")
        .maxWidth(1180)
        .width("100%")
        .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0B0B10")
    }
  `);
