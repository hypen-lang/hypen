import { app } from "@hypen-space/core";
import {
  getFeatured,
  getMyList,
  getRails,
  MARATHON_ID,
  type Movie,
} from "../queries";

// Nested ForEach over an outer item's field doesn't resolve at runtime (see
// skills/hypen-ui), so each rail is a top-level state array and the template
// repeats one rail block per genre.
interface BrowseState {
  featured: Movie;
  open: Movie[];
  trending: Movie[];
  noir: Movie[];
  horror: Movie[];
  scifi: Movie[];
  comedy: Movie[];
  myList: Movie[];
  savedIds: string[];
  hasMyList: boolean;
}

const EMPTY_MOVIE: Movie = {
  id: "",
  title: "",
  year: "",
  genre: "",
  blurb: "",
  file: "",
  posterUrl: "",
  saved: false,
  meta: "",
};

function refresh(state: BrowseState) {
  const saved = new Set(state.savedIds);
  state.featured = getFeatured(saved);
  const rails = new Map(getRails(saved).map((r) => [r.key, r.movies]));
  state.open = rails.get("open") ?? [];
  state.trending = rails.get("trending") ?? [];
  state.noir = rails.get("noir") ?? [];
  state.horror = rails.get("horror") ?? [];
  state.scifi = rails.get("scifi") ?? [];
  state.comedy = rails.get("comedy") ?? [];
  state.myList = getMyList(saved);
  state.hasMyList = state.myList.length > 0;
}

/** One horizontally-scrolling poster rail. */
const rail = (title: string, binding: string) => `
        Text("${title}")
          .tw("px-5 md:px-10 pt-7 pb-3 text-lg font-bold")
          .color("#F8FAFC")
          .maxWidth(1280)
          .width("100%")
          .alignSelf("center")
        Row {
          ForEach(items: @state.${binding}, key: "id") {
            Button {
              Column {
                Image(src: "@{item.posterUrl}")
                  .objectFit("cover")
                  .tw("w-32 h-44 md:w-40 md:h-56 rounded-xl border border-white/10")
                  .backgroundColor("#16161E")
                  .boxShadow("0 12px 26px rgba(0, 0, 0, 0.4)")
                Text("@{item.title}")
                  .tw("w-32 md:w-40 text-xs font-semibold mt-2 text-left")
                  .color("#E4E4EB")
                Text("@{item.meta}")
                  .tw("w-32 md:w-40 text-[11px] mt-0.5 text-left")
                  .color("#6B6B78")
              }
              .tw("items-start")
            }
            .tw("mr-3 bg-transparent border-0 p-0 shrink-0")
            .enter(fade, duration: 280)
            .opacity({ default: 1, active: 0.7 })
            .transition(160, easeOut)
            .onClick(@actions.openMovie, movieId: "@{item.id}")
          }
        }
        .scrollable("horizontal")
        .tw("px-5 md:px-10 flex-row")
        .maxWidth(1280)
        .width("100%")
        .alignSelf("center")`;

export default app
  .module("Browse")
  .defineState<BrowseState>({
    featured: EMPTY_MOVIE,
    open: [],
  trending: [],
    noir: [],
    horror: [],
    scifi: [],
    comedy: [],
    myList: [],
    savedIds: [],
    hasMyList: false,
  })
  .onActivated(async (state) => {
    refresh(state);
  })
  .onAction<{ movieId: string }>("openMovie", ({ action, context }) => {
    if (!action.payload) return;
    context?.router?.push(`/movie/${action.payload.movieId}`);
  })
  .onAction("playFeatured", ({ state, context }) => {
    context?.router?.push(`/watch/${state.featured.id}`);
  })
  .onAction("playMarathon", ({ context }) => {
    context?.router?.push(`/watch/${MARATHON_ID}`);
  })
  .onAction<{ movieId: string }>("toggleSaved", ({ state, action }) => {
    if (!action.payload) return;
    const id = action.payload.movieId;
    state.savedIds = state.savedIds.includes(id)
      ? state.savedIds.filter((s) => s !== id)
      : [...state.savedIds, id];
    refresh(state);
  })
  .ui(`
    module Browse {
      Column {
        Row {
          Text("HYPEFLIX")
            .tw("flex-1 text-2xl md:text-3xl font-black tracking-[0.2em]")
            .color("#E50914")
          Text("Public-domain cinema, streamed from the Internet Archive")
            .tw("text-[11px] text-right")
            .color("#6B6B78")
        }
        .tw("px-5 md:px-10 pt-6 pb-4 items-center")
        .maxWidth(1280)
        .width("100%")
        .alignSelf("center")

        // ---- Featured hero -------------------------------------------------
        Row {
          Column {
            Text("FEATURED TONIGHT")
              .tw("text-[10px] font-bold tracking-widest text-left")
              .color("#E50914")
            Text("@{state.featured.title}")
              .tw("text-3xl md:text-5xl font-bold mt-2 text-left tracking-tight")
              .color("#F8FAFC")
            Text("@{state.featured.meta}")
              .tw("text-[13px] mt-2")
              .color("#8E8E9A")
            Text("@{state.featured.blurb}")
              .tw("text-[13px] md:text-sm mt-3 leading-5 text-left")
              .color("#A6A6B3")

            Row {
              Button {
                Row {
                  Icon(@resources.play)
                    .size(16)
                    .color("#0A0A0F")
                  Text("Play")
                    .tw("text-sm font-bold ml-2")
                    .color("#0A0A0F")
                }
                .tw("items-center")
              }
              .tw("h-11 px-6 rounded-xl border-0 items-center justify-center")
              .backgroundColor("#F8FAFC")
              .opacity({ default: 1, active: 0.75 })
              .transition(160, easeOut)
              .onClick(@actions.playFeatured)

              Button {
                Text("More info")
                  .tw("text-sm font-semibold")
                  .color("#F8FAFC")
              }
              .tw("h-11 px-5 ml-3 rounded-xl border border-white/15 items-center justify-center")
              .backgroundColor("rgba(255, 255, 255, 0.08)")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@actions.openMovie, movieId: "@{state.featured.id}")
            }
            .tw("mt-5 items-center")
          }
          .tw("flex-1 min-w-0 pr-4 md:pr-10 items-start")

          Image(src: "@{state.featured.posterUrl}")
            .objectFit("cover")
            .tw("w-28 h-[168px] md:w-44 md:h-64 rounded-2xl shrink-0 border border-white/10")
            .backgroundColor("#16161E")
            .boxShadow("0 20px 44px rgba(0, 0, 0, 0.55)")
        }
        .tw("mx-5 md:mx-10 p-5 md:p-8 rounded-3xl border border-white/10 items-center")
        .backgroundColor("rgba(229, 9, 20, 0.06)")
        .maxWidth(1200)
        .alignSelf("center")

        // ---- Marathon banner (playlist showcase) ---------------------------
        Button {
          Row {
            Icon(@resources.queue)
              .size(22)
              .color("#E50914")
            Column {
              Text("Midnight Creature Marathon")
                .tw("text-[15px] font-bold text-left")
                .color("#F8FAFC")
              Text("Three creature features, one continuous stream — a Video playlist demo")
                .tw("text-xs mt-0.5 text-left")
                .color("#8E8E9A")
            }
            .tw("flex-1 min-w-0 ml-3 items-start")
            Icon(@resources.play)
              .size(16)
              .color("#F8FAFC")
          }
          .tw("items-center")
        }
        .tw("mx-5 md:mx-10 mt-4 p-4 rounded-2xl border border-white/10 items-stretch")
        .backgroundColor("rgba(255, 255, 255, 0.04)")
        .maxWidth(1200)
        .alignSelf("center")
        .opacity({ default: 1, active: 0.7 })
        .transition(160, easeOut)
        .onClick(@actions.playMarathon)

        // ---- My list -------------------------------------------------------
        If(condition: "@{state.hasMyList}") {
          Column {
            Text("My list")
              .tw("px-5 md:px-10 pt-7 pb-3 text-lg font-bold")
              .color("#F8FAFC")
            Row {
              ForEach(items: @state.myList, key: "id") {
                Button {
                  Column {
                    Image(src: "@{item.posterUrl}")
                      .objectFit("cover")
                      .tw("w-32 h-44 md:w-36 md:h-52 rounded-xl border border-white/10")
                      .backgroundColor("#16161E")
                    Text("@{item.title}")
                      .tw("w-32 md:w-36 text-xs font-semibold mt-2 text-left")
                      .color("#E4E4EB")
                  }
                  .tw("items-start")
                }
                .tw("mr-3 bg-transparent border-0 p-0 shrink-0")
                .opacity({ default: 1, active: 0.7 })
                .transition(160, easeOut)
                .onClick(@actions.openMovie, movieId: "@{item.id}")
              }
            }
            .scrollable("horizontal")
            .tw("px-5 md:px-10 flex-row")
          }
          .maxWidth(1280)
          .width("100%")
          .alignSelf("center")
        }

        // ---- Genre rails ---------------------------------------------------
${rail("Blender open movies — always on", "open")}
${rail("Trending now", "trending")}
${rail("Film noir", "noir")}
${rail("Horror & chills", "horror")}
${rail("Sci-fi B-movies", "scifi")}
${rail("Comedy classics", "comedy")}

        Text("All titles are public-domain or freely licensed films served directly by the Internet Archive (archive.org).")
          .tw("px-5 md:px-10 pt-10 pb-8 text-[11px]")
          .color("#4A4A55")
          .maxWidth(1280)
          .width("100%")
          .alignSelf("center")
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0A0A0F")
    }
  `);
