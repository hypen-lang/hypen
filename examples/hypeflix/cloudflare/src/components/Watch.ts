import { app } from "@hypen-space/core";
import {
  getMovie,
  MARATHON_ID,
  MARATHON_TITLE,
  resolveMarathon,
  resolveStream,
} from "../queries";

// The player screen is the Video-component showcase:
//
// - The server resolves the archive.org stream endpoint and validates it with
//   a ranged probe BEFORE the client ever sees a URL. Restricted/removed items
//   (HTTP 403/404) become a structured error state instead of a dead player.
// - Only the resolved URL string crosses the wire — never video bytes.
// - The Video element reports runtime failures back through `onError`
//   (payload carries the HTTP status when the platform can determine it), and
//   playlist progress through `onTrackChange` / `onEnded`.

interface WatchState {
  title: string;
  subtitle: string;
  poster: string;
  streamUrl: string;
  playlist: string[];
  playlistTitles: string[];
  nowPlaying: string;
  isPlaylist: boolean;
  loading: boolean;
  playing: boolean;
  failed: boolean;
  ended: boolean;
  errorTitle: string;
  errorDetail: string;
  // v2 playback bind: the renderer keeps this in sync (throttled position
  // reports, immediate transitions); writing `playing`/`position` from a
  // handler drives the player. Must be initialized before the bind's
  // first write lands — __hypen_bind drops writes whose parent is missing.
  playback: {
    playing: boolean;
    position: number;
    duration: number;
    state: string;
  };
  // Theater mode: expand the player to the full app frame (header hidden,
  // width cap lifted). Not native fullscreen — that's a v2 non-goal.
  theater: boolean;
  playerMaxWidth: number | string;
}

const INITIAL: WatchState = {
  title: "",
  subtitle: "",
  poster: "",
  streamUrl: "",
  playlist: [],
  playlistTitles: [],
  nowPlaying: "",
  isPlaylist: false,
  loading: true,
  playing: false,
  failed: false,
  ended: false,
  errorTitle: "",
  errorDetail: "",
  playback: { playing: true, position: 0, duration: 0, state: "idle" },
  theater: false,
  playerMaxWidth: 1100,
};

function fail(state: WatchState, title: string, detail: string) {
  state.loading = false;
  state.playing = false;
  state.failed = true;
  state.errorTitle = title;
  state.errorDetail = detail;
}

async function load(state: WatchState, id: string) {
  Object.assign(state, INITIAL, { loading: true });

  if (id === MARATHON_ID) {
    state.title = MARATHON_TITLE;
    state.isPlaylist = true;
    const { urls, titles, failures } = await resolveMarathon();
    if (urls.length === 0) {
      fail(
        state,
        "Marathon unavailable",
        failures.length ? `No track validated: ${failures.join(", ")}` : "No tracks could be resolved.",
      );
      return;
    }
    state.playlist = urls;
    state.playlistTitles = titles;
    state.subtitle = `${titles.length} features · plays continuously`;
    state.nowPlaying = `Now playing 1/${titles.length}: ${titles[0]}`;
    if (failures.length) {
      state.subtitle += ` · skipped: ${failures.join(", ")}`;
    }
    state.loading = false;
    state.playing = true;
    return;
  }

  const movie = getMovie(id, new Set());
  if (!movie) {
    fail(state, "Title not found", `No catalog entry for "${id}".`);
    return;
  }
  state.title = movie.title;
  state.subtitle = movie.meta;
  state.poster = movie.posterUrl;

  const resolution = await resolveStream(id);
  if (!resolution.ok || !resolution.url) {
    fail(
      state,
      resolution.status ? `Stream unavailable (HTTP ${resolution.status})` : "Stream unavailable",
      resolution.message ?? "The stream endpoint could not be validated.",
    );
    return;
  }

  state.streamUrl = resolution.url;
  state.loading = false;
  state.playing = true;
}

export default app
  .module("Watch")
  .defineState<WatchState>({ ...INITIAL })
  .onActivated(async (state, context) => {
    const path = context?.router?.getCurrentPath() ?? "/";
    const match = context?.router?.matchPath("/watch/:id", path);
    await load(state, match?.params.id ?? "");
  })
  .onAction("back", ({ context }) => {
    // Server-side routers keep an internal back stack (HypenRouter's
    // windowless history). If there's nothing to pop — deep link straight
    // into /watch — fall back to browsing.
    const router = context?.router;
    if (!router) return;
    const before = router.getCurrentPath();
    router.back();
    if (router.getCurrentPath() === before) router.push("/");
  })
  // Runtime playback failure reported by the Video component itself — e.g. the
  // stream died mid-play, or validation raced a permission change. The payload
  // carries the HTTP status when the renderer could determine it.
  .onAction<{ status?: number; code?: number; message?: string; src?: string }>(
    "playbackError",
    ({ state, action }) => {
      const status = action.payload?.status;
      fail(
        state,
        status ? `Playback failed (HTTP ${status})` : "Playback failed",
        action.payload?.message ??
          "The player could not fetch or decode this stream.",
      );
    },
  )
  .onAction<{ index?: number }>("trackChanged", ({ state, action }) => {
    const index = action.payload?.index ?? 0;
    const title = state.playlistTitles[index] ?? `Track ${index + 1}`;
    state.nowPlaying = `Now playing ${index + 1}/${state.playlistTitles.length}: ${title}`;
  })
  .onAction<{ completed?: boolean }>("playbackEnded", ({ state, action }) => {
    if (action.payload?.completed === false) return; // queue advancing, not done
    state.playing = false;
    state.ended = true;
  })
  // v2 playback bind demo: a module-authoritative play/pause toggle. The
  // write flows down through the binding; the renderer plays/pauses and
  // reports the transition back into state.playback.
  .onAction("togglePlay", ({ state }) => {
    state.playback.playing = !state.playback.playing;
  })
  .onAction("toggleTheater", ({ state }) => {
    state.theater = !state.theater;
    state.playerMaxWidth = state.theater ? "100%" : 1100;
  })
  .ui(`
    module Watch {
      Column {
        // Header hides in theater mode so the player owns the app frame.
        If(condition: "@{!state.theater}") {
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

          Column {
            Text("@{state.title}")
              .tw("text-[15px] font-bold text-left")
              .color("#F8FAFC")
            Text("@{state.subtitle}")
              .tw("text-[11px] mt-0.5 text-left")
              .color("#8E8E9A")
          }
          .tw("flex-1 min-w-0 ml-3 items-start")
        }
        .tw("px-5 pt-5 pb-4 items-center")
        .maxWidth(1100)
        .width("100%")
        .alignSelf("center")
        }

        // ---- Resolving the stream ------------------------------------------
        If(condition: "@{state.loading}") {
          Column {
            Box {}
              .tw("w-full aspect-video rounded-2xl")
              .backgroundColor("rgba(255, 255, 255, 0.05)")
              .animate(shimmer)
            Text("Resolving stream…")
              .tw("text-xs mt-3")
              .color("#8E8E9A")
          }
          .tw("px-5 items-center")
          .maxWidth(1100)
          .width("100%")
          .alignSelf("center")
          .exit(fade, duration: 140)
        }

        // ---- Single-title playback -----------------------------------------
        // v2 showcase: bound playback + composition slots. The controls slot
        // replaces native chrome — its Button drives playback through the
        // module (togglePlay writes state.playback.playing), and the Scrubber
        // wires itself to the enclosing player, committing seeks through the
        // same bind on release. The loading slot shows during buffering.
        If(condition: "@{state.playing && !state.isPlaylist}") {
          Video(
            src: "@{state.streamUrl}",
            poster: "@{state.poster}",
            title: "@{state.title}",
            autoplay: true,
            onError: @actions.playbackError,
            onEnded: @actions.playbackEnded
          ) {
            // Controls bar: scrim + light-on-dark widgets. The Scrubber
            // paints its progress/thumb with currentColor, so the Row's
            // .color is load-bearing — without it the scrubber inherits
            // near-black and disappears against the video.
            Row {
              Button {
                If(condition: "@{state.playback.playing}") {
                  Icon(@resources.pause)
                    .size(18)
                    .color("#0A0A0F")
                }
                If(condition: "@{!state.playback.playing}") {
                  Icon(@resources.play)
                    .size(18)
                    .color("#0A0A0F")
                }
              }
              .tw("w-11 h-11 rounded-full border-0 items-center justify-center")
              .backgroundColor("#F8FAFC")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@actions.togglePlay)
              .label("Play or pause")

              Scrubber()
                .tw("flex-1 ml-4")

              Button {
                Icon(@resources.fullscreen)
                  .size(18)
                  .color("#0A0A0F")
              }
              .tw("w-11 h-11 ml-4 rounded-full border-0 items-center justify-center")
              .backgroundColor("#F8FAFC")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .videoIntent("fullscreen")
              .label("Toggle fullscreen")

              Button {
                If(condition: "@{!state.theater}") {
                  Icon(@resources.expand)
                    .size(18)
                    .color("#0A0A0F")
                }
                If(condition: "@{state.theater}") {
                  Icon(@resources.shrink)
                    .size(18)
                    .color("#0A0A0F")
                }
              }
              .tw("w-11 h-11 ml-4 rounded-full border-0 items-center justify-center")
              .backgroundColor("#F8FAFC")
              .opacity({ default: 1, active: 0.7 })
              .transition(160, easeOut)
              .onClick(@actions.toggleTheater)
              .label("Toggle theater mode")
            }
            .tw("px-5 py-4 items-center self-end w-full rounded-b-2xl")
            .backgroundColor("rgba(5, 5, 8, 0.72)")
            .color("#F8FAFC")
            .slot("controls")

            Column {
              Spinner()
              Text("Buffering…")
                .tw("text-xs mt-2")
                .color("#8E8E9A")
            }
            .tw("items-center justify-center w-full h-full")
            .slot("loading")
          }
            .bind(@state.playback)
            .tw("mx-5 w-full aspect-video rounded-2xl border border-white/10 overflow-hidden")
            .backgroundColor("#000000")
            .maxWidth("@{state.playerMaxWidth}")
            .alignSelf("center")
            .enter(fade, duration: 240)
        }

        // ---- Marathon playback (playlist) ----------------------------------
        If(condition: "@{state.playing && state.isPlaylist}") {
          Column {
            Video(
              playlist: @state.playlist,
              controls: true,
              autoplay: true,
              onError: @actions.playbackError,
              onTrackChange: @actions.trackChanged,
              onEnded: @actions.playbackEnded
            )
              .tw("w-full aspect-video rounded-2xl border border-white/10 overflow-hidden")
              .backgroundColor("#000000")
            Text("@{state.nowPlaying}")
              .tw("text-xs mt-3")
              .color("#E50914")
          }
          .tw("px-5 items-center")
          .maxWidth(1100)
          .width("100%")
          .alignSelf("center")
          .enter(fade, duration: 240)
        }

        // ---- Failure state (403/404/network) -------------------------------
        If(condition: "@{state.failed}") {
          Column {
            Icon(@resources.alert)
              .size(34)
              .color("#E50914")
            Text("@{state.errorTitle}")
              .tw("text-lg font-bold mt-4 text-center")
              .color("#F8FAFC")
            Text("@{state.errorDetail}")
              .tw("text-[13px] mt-2 text-center leading-5")
              .color("#8E8E9A")
            Button {
              Text("Back to browsing")
                .tw("text-sm font-semibold")
                .color("#0A0A0F")
            }
            .tw("mt-6 h-11 px-6 rounded-xl border-0 items-center justify-center")
            .backgroundColor("#F8FAFC")
            .opacity({ default: 1, active: 0.75 })
            .transition(160, easeOut)
            .onClick(@actions.back)
          }
          .tw("mx-5 py-14 px-6 rounded-2xl border border-white/10 items-center justify-center")
          .backgroundColor("rgba(229, 9, 20, 0.05)")
          .maxWidth(680)
          .alignSelf("center")
          .enter(fade, duration: 240)
        }

        // ---- Finished ------------------------------------------------------
        If(condition: "@{state.ended}") {
          Column {
            Text("That's a wrap")
              .tw("text-lg font-bold text-center")
              .color("#F8FAFC")
            Text("@{state.title} finished playing.")
              .tw("text-[13px] mt-2 text-center")
              .color("#8E8E9A")
            Button {
              Text("Back to browsing")
                .tw("text-sm font-semibold")
                .color("#0A0A0F")
            }
            .tw("mt-6 h-11 px-6 rounded-xl border-0 items-center justify-center")
            .backgroundColor("#F8FAFC")
            .opacity({ default: 1, active: 0.75 })
            .transition(160, easeOut)
            .onClick(@actions.back)
          }
          .tw("mx-5 mt-6 py-10 px-6 rounded-2xl border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.04)")
          .maxWidth(680)
          .alignSelf("center")
          .enter(fade, duration: 240)
        }
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#050508")
    }
  `);
