import { app } from "@hypen-space/core";
import { getMovie, type Movie } from "../queries";

interface DetailState {
  movie: Movie;
  loaded: boolean;
  saveLabel: string;
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

// Saved-list membership lives in the Browse module's per-session state;
// read it through the global context (empty set when Browse isn't up yet).
function browseSaved(context: any): { ids: string[]; write: ((ids: string[]) => void) | null } {
  try {
    if (context?.hasModule?.("Browse")) {
      const mod = context.getModule("Browse");
      const ids: string[] = mod.getState()?.savedIds ?? [];
      return { ids, write: (next) => mod.setState({ savedIds: next }) };
    }
  } catch {
    // Browse not registered yet — fall through.
  }
  return { ids: [], write: null };
}

function refresh(state: DetailState, movieId: string, saved: ReadonlySet<string>) {
  const movie = getMovie(movieId, saved);
  state.loaded = Boolean(movie);
  state.movie = movie ?? EMPTY_MOVIE;
  state.saveLabel = state.movie.saved ? "In my list" : "+ My list";
}

export default app
  .module("MovieDetail")
  .defineState<DetailState>({
    movie: EMPTY_MOVIE,
    loaded: false,
    saveLabel: "+ My list",
  })
  .onActivated(async (state, context) => {
    const path = context?.router?.getCurrentPath() ?? "/";
    const match = context?.router?.matchPath("/movie/:id", path);
    refresh(state, match?.params.id ?? "", new Set(browseSaved(context).ids));
  })
  .onAction("back", ({ context }) => {
    context?.router?.push("/");
  })
  .onAction("play", ({ state, context }) => {
    context?.router?.push(`/watch/${state.movie.id}`);
  })
  .onAction("toggleSaved", ({ state, context }) => {
    const { ids, write } = browseSaved(context);
    const next = ids.includes(state.movie.id)
      ? ids.filter((s) => s !== state.movie.id)
      : [...ids, state.movie.id];
    write?.(next);
    refresh(state, state.movie.id, new Set(next));
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
        }
        .tw("px-5 pt-6 pb-3 items-center")
        .maxWidth(900)
        .width("100%")

        Image(src: "@{state.movie.posterUrl}")
          .objectFit("cover")
          .aspectRatio(0.72)
          .tw("mt-2 w-52 md:w-64 rounded-3xl border border-white/10")
          .backgroundColor("#16161E")
          .boxShadow("0 24px 48px rgba(0, 0, 0, 0.55)")

        Column {
          Text("@{state.movie.title}")
            .tw("text-3xl md:text-4xl font-bold mt-6 text-center tracking-tight")
            .color("#F8FAFC")

          Row {
            Text("@{state.movie.meta}")
              .tw("text-sm")
              .color("#8E8E9A")
          }
          .tw("mt-3 w-full items-center justify-center")

          Row {
            Button {
              Row {
                Icon(@resources.play)
                  .size(16)
                  .color("#0A0A0F")
                Text("Play")
                  .tw("text-[15px] font-bold ml-2")
                  .color("#0A0A0F")
              }
              .tw("items-center justify-center")
            }
            .tw("flex-1 h-12 rounded-2xl border-0 items-center justify-center")
            .backgroundColor("#F8FAFC")
            .opacity({ default: 1, active: 0.75 })
            .transition(200, easeOut)
            .onClick(@actions.play)

            Button {
              Text("@{state.saveLabel}")
                .tw("text-[15px] font-semibold")
                .color("@{state.movie.saved ? '#34D399' : '#F8FAFC'}")
            }
            .tw("flex-1 h-12 ml-3 rounded-2xl border items-center justify-center")
            .backgroundColor("@{state.movie.saved ? 'rgba(52, 211, 153, 0.10)' : 'rgba(255, 255, 255, 0.08)'}")
            .borderColor("@{state.movie.saved ? 'rgba(52, 211, 153, 0.35)' : 'rgba(255, 255, 255, 0.15)'}")
            .opacity({ default: 1, active: 0.7 })
            .transition(200, easeOut)
            .onClick(@actions.toggleSaved)
          }
          .tw("mt-6 w-full")

          Text("About this film")
            .tw("text-lg font-bold mt-8")
            .color("#F8FAFC")
          Text("@{state.movie.blurb}")
            .tw("text-sm md:text-[15px] mt-2.5 leading-6")
            .color("#A6A6B3")

          Text("Streamed as a direct MP4 from archive.org — the server resolves and validates the stream URL, the player streams it with HTTP range requests.")
            .tw("text-xs mt-8 mb-10 leading-5")
            .color("#4A4A55")
        }
        .tw("px-5")
        .maxWidth(680)
        .width("100%")
        .enter(fade, duration: 320)
      }
      .horizontalAlignment("center")
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0A0A0F")
    }
  `);
