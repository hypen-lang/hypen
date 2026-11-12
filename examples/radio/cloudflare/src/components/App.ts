import { app } from "@hypen-space/core";
import {
  disposeIcy,
  EMPTY_STATION,
  findStation,
  startStation,
  stopIcy,
  stopStation,
  toggleFavourite,
  togglePlayback,
  type PlayerState,
} from "../player";
import { libraryStore } from "../library-store";
import type { GlobalContext } from "@hypen-space/core";
import { C, art, stationRows } from "../ui";

// App shell: Router + the persistent player.
//
// The single `Video` that plays audio lives here, outside the Router, so it
// keeps playing while the listener browses. It is mounted only while a
// station is live (`If(state.live)`), zero-sized, with no native chrome — the
// mini-player bar and the /player screen are its controls. Its onPlay /
// onPause / onError events drive `state.phase`.
//
// Why events and not `.bind(@state.playback)`: with the published client the
// bind reports `playing: false` while autoplay is still pending, and the
// engine's echo of that report pauses the element a few ms later (play/pause
// ping-pong, ending paused). Events have no echo path. See README.
//
// Favourites, recently played and the last station persist per visitor in
// the Durable Object (library-store.ts); nothing playback-related does, so a
// reload never starts audio on its own.

type AppState = PlayerState & {
  /** Where the full player was opened from (its close button returns there). */
  returnTo: string;
};

/**
 * The primary module's handler context has no `router` in this SDK build
 * (only routed screen modules get one), so the shell navigates by writing
 * the router mirror `state.location`, which the engine's Router matches.
 */
function navigate(state: AppState, context: GlobalContext | undefined, to: string) {
  if (context?.router) context.router.push(to);
  else state.location = to;
}

const initial: AppState = {
  location: "/",
  now: { ...EMPTY_STATION },
  hasStation: false,
  live: false,
  streamUrl: "",
  phase: "idle",
  muted: false,
  hasError: false,
  error: "",
  nowTitle: "",
  hasNowTitle: false,
  isFavourite: false,
  favourites: [],
  recents: [],
  hasFavourites: false,
  hasRecents: false,
  token: "",
  returnTo: "/",
};

// Status line under the station name.
const STATUS =
  "@{state.hasError ? state.error : (state.live ? (state.phase == 'playing' ? (state.hasNowTitle ? state.nowTitle : 'Live') : (state.phase == 'paused' ? 'Paused' : 'Connecting…')) : 'Tap play to listen')}";

const playIcon = (size: number, color: string) => `
                If(condition: "@{state.live}") {
                  Icon(@resources.stop)
                    .size(${size})
                    .color("${color}")
                }
                If(condition: "@{!state.live}") {
                  Icon(@resources.play)
                    .size(${size})
                    .color("${color}")
                }`;

const heartIcon = (size: number) => `
                If(condition: "@{state.isFavourite}") {
                  Icon(@resources.heart-filled)
                    .size(${size})
                    .color("${C.accent}")
                }
                If(condition: "@{!state.isFavourite}") {
                  Icon(@resources.heart)
                    .size(${size})
                    .color("${C.text}")
                }`;

const tab = (label: string, icon: string, to: string, active: string) => `
          Button {
            Column {
              Icon(@resources.${icon})
                .size(20)
                .color("@{${active} ? '${C.accent}' : '${C.muted}'}")
              Text("${label}")
                .tw("text-[10px] font-semibold mt-1")
                .color("@{${active} ? '${C.accent}' : '${C.muted}'}")
            }
            .tw("items-center")
          }
          .tw("flex-1 h-14 bg-transparent border-0 items-center justify-center")
          .opacity({ default: 1, active: 0.6 })
          .onClick(@actions.go, to: "${to}")`;

const library = `
          Column {
            Column {
              Heading("Library", level: 1)
                .tw("text-[26px] font-bold text-left pt-6 pb-1")
                .color("${C.text}")
              Text("Saved on this server for this browser.")
                .tw("text-xs text-left")
                .color("${C.faint}")

              Row {
                Icon(@resources.heart-filled).size(16).color("${C.accent}")
                Heading("Favourites", level: 2)
                  .tw("flex-1 ml-2 text-base font-bold text-left")
                  .color("${C.text}")
              }
              .tw("items-center mt-6 mb-1")
              If(condition: "@{!state.hasFavourites}") {
                Text("Tap the heart on any station to keep it here.")
                  .tw("text-sm py-6 text-center")
                  .color("${C.muted}")
              }
${stationRows("favourites")}

              Row {
                Icon(@resources.clock).size(16).color("${C.accent}")
                Heading("Recently played", level: 2)
                  .tw("flex-1 ml-2 text-base font-bold text-left")
                  .color("${C.text}")
                If(condition: "@{state.hasRecents}") {
                  Button {
                    Text("Clear")
                      .tw("text-xs font-semibold")
                      .color("${C.accent}")
                  }
                  .tw("bg-transparent border-0 px-2 py-1")
                  .onClick(@actions.clearRecents)
                }
              }
              .tw("items-center mt-8 mb-1")
              If(condition: "@{!state.hasRecents}") {
                Text("Stations you play show up here.")
                  .tw("text-sm py-6 text-center")
                  .color("${C.muted}")
              }
${stationRows("recents")}
            }
            .tw("w-full px-4 pb-6")
            .maxWidth(720)
          }
          .horizontalAlignment("center")
          .scrollable(true)
          .tw("flex-1 w-full min-h-0")
          .backgroundColor("${C.bg}")`;

const fullPlayer = `
          Column {
            Row {
              Button {
                Icon(@resources.chevron-down)
                  .size(22)
                  .color("${C.text}")
              }
              .tw("w-10 h-10 rounded-full border-0 items-center justify-center")
              .backgroundColor("${C.surface}")
              .onClick(@actions.back)
              .label("Close player")
              Text("NOW PLAYING")
                .tw("flex-1 text-[11px] font-bold tracking-widest text-center")
                .color("${C.muted}")
              Button {
${heartIcon(20)}
              }
              .tw("w-10 h-10 rounded-full border-0 items-center justify-center")
              .backgroundColor("${C.surface}")
              .onClick(@actions.favouriteNow)
              .label("Favourite")
            }
            .tw("w-full items-center pt-5")

            If(condition: "@{!state.hasStation}") {
              Column {
                Icon(@resources.radio).size(40).color("${C.faint}")
                Text("Nothing playing yet")
                  .tw("text-base font-semibold mt-4")
                  .color("${C.text}")
                Button {
                  Text("Discover stations")
                    .tw("text-sm font-semibold")
                    .color("#FFFFFF")
                }
                .tw("mt-5 h-11 px-6 rounded-xl border-0 items-center justify-center")
                .backgroundColor("${C.accent}")
                .onClick(@actions.go, to: "/")
              }
              .tw("flex-1 items-center justify-center w-full")
            }

            If(condition: "@{state.hasStation}") {
              Column {
${art("@{state.now.art}", 220, 32, "@{state.now.name} logo")}
                  .maxWidth("70vw")
                  .maxHeight("70vw")
                  .boxShadow("0 24px 60px rgba(255, 90, 54, 0.18)")
                  .opacity("@{state.phase == 'playing' ? 1 : 0.6}")
                  .transition(240, easeOut)

                Heading("@{state.now.name}", level: 2)
                  .tw("text-2xl font-bold mt-7 text-center")
                  .color("${C.text}")
                  .maxLines(2)
                Text("@{state.now.subtitle}")
                  .tw("text-sm mt-1.5 text-center")
                  .color("${C.muted}")
                  .maxLines(1)
                  .textOverflow("ellipsis")

                Row {
                  Text("@{state.now.quality}")
                    .tw("text-[11px] font-semibold px-2.5 py-1 rounded-full")
                    .color("${C.text}")
                    .backgroundColor("${C.surface2}")
                  Text("@{state.now.flag} @{state.now.countrycode}")
                    .tw("text-[11px] font-semibold px-2.5 py-1 rounded-full ml-2")
                    .color("${C.text}")
                    .backgroundColor("${C.surface2}")
                }
                .tw("mt-3 items-center")

                Column {
                  Text("@{state.hasNowTitle ? 'ON AIR · from the stream' : (state.live ? 'STATUS' : 'STOPPED')}")
                    .tw("text-[10px] font-bold tracking-widest text-center")
                    .color("${C.accent}")
                  Text("${STATUS}")
                    .tw("text-sm font-semibold mt-1.5 text-center")
                    .color("@{state.hasError ? '${C.accent}' : '${C.text}'}")
                    .maxLines(2)
                    .liveRegion("polite")
                }
                .tw("w-full mt-6 px-4 py-3.5 rounded-2xl items-center")
                .backgroundColor("${C.surface}")

                Row {
                  Button {
                    If(condition: "@{state.muted}") {
                      Icon(@resources.volume-x).size(22).color("${C.accent}")
                    }
                    If(condition: "@{!state.muted}") {
                      Icon(@resources.volume).size(22).color("${C.text}")
                    }
                  }
                  .tw("w-12 h-12 rounded-full border-0 items-center justify-center")
                  .backgroundColor("${C.surface}")
                  .opacity({ default: 1, active: 0.6 })
                  .onClick(@actions.toggleMute)
                  .label("Mute")

                  Button {
${playIcon(28, "#FFFFFF")}
                  }
                  .tw("w-20 h-20 mx-7 rounded-full border-0 items-center justify-center")
                  .backgroundColor("${C.accent}")
                  .boxShadow("0 12px 30px rgba(255, 90, 54, 0.4)")
                  .opacity({ default: 1, active: 0.75 })
                  .transition(160, easeOut)
                  .onClick(@actions.toggle)
                  .label("Play or stop")

                  Button {
                    Icon(@resources.chevron-right).size(22).color("${C.text}")
                  }
                  .tw("w-12 h-12 rounded-full border-0 items-center justify-center")
                  .backgroundColor("${C.surface}")
                  .opacity({ default: 1, active: 0.6 })
                  .onClick(@actions.openStation, id: "@{state.now.id}")
                  .label("Station details")
                }
                .tw("mt-7 items-center")

                Text("Live radio has no seek bar: stop releases the stream, play reconnects at the live edge. Volume follows your device; the speaker button mutes.")
                  .tw("text-[11px] mt-8 text-center leading-4")
                  .color("${C.faint}")
              }
              .tw("w-full items-center pt-6")
              .enter(fade, duration: 220)
            }
          }
          .tw("flex-1 w-full min-h-0 px-6 pb-6 items-center")
          .maxWidth(560)
          .scrollable(true)`;

const miniPlayer = `
        If(condition: "@{state.hasStation && state.location != '/player'}") {
          Row {
            Button {
              Row {
${art("@{state.now.art}", 44, 10, "@{state.now.name} logo")}
                Column {
                  Text("@{state.now.name}")
                    .tw("text-sm font-semibold text-left")
                    .color("${C.text}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("${STATUS}")
                    .tw("text-xs mt-0.5 text-left")
                    .color("@{state.hasError ? '${C.accent}' : '${C.muted}'}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                }
                .tw("flex-1 min-w-0 ml-3 items-start")
              }
              .tw("items-center w-full")
            }
            .tw("flex-1 min-w-0 bg-transparent border-0 p-0 items-stretch")
            .onClick(@actions.go, to: "/player")
            .label("Open player")

            Button {
${heartIcon(18)}
            }
            .tw("w-10 h-10 ml-2 rounded-full border-0 items-center justify-center bg-transparent shrink-0")
            .onClick(@actions.favouriteNow)
            .label("Favourite")

            Button {
${playIcon(16, "#FFFFFF")}
            }
            .tw("w-11 h-11 ml-1 rounded-full border-0 items-center justify-center shrink-0")
            .backgroundColor("${C.accent}")
            .opacity({ default: 1, active: 0.7 })
            .onClick(@actions.toggle)
            .label("Play or stop")
          }
          .tw("w-full px-3 py-2 items-center")
          .backgroundColor("${C.surface}")
          .borderTop("1px solid ${C.line}")
          .enter(slide, fade, from: bottom)
        }`;

export default app
  .defineState<AppState>({ ...initial })
  .persist(libraryStore<AppState, "favourites" | "recents" | "now" | "hasStation" | "hasFavourites" | "hasRecents">([
    "favourites",
    "recents",
    "now",
    "hasStation",
    "hasFavourites",
    "hasRecents",
  ]))
  .onCreated((state) => {
    state.token = crypto.randomUUID();
    state.isFavourite = state.favourites.some((s) => s.id === state.now.id);
  })
  .onDeactivated((state) => {
    // Shell never deactivates under the Router, but keep the poller honest.
    stopIcy(state);
  })
  .onDestroyed((state) => {
    disposeIcy(state);
  })
  .onAction<{ to?: string }>("go", ({ action, state, context }) => {
    const to = action.payload?.to;
    if (!to || to === state.location) return;
    if (to === "/player") state.returnTo = state.location;
    navigate(state, context, to);
  })
  // Close the full player: back to wherever it was opened from.
  .onAction("back", ({ state, context }) => {
    navigate(state, context, state.returnTo || "/");
  })
  .onAction<{ id?: string }>("openStation", ({ action, state, context }) => {
    if (action.payload?.id) navigate(state, context, `/station/${action.payload.id}`);
  })
  .onAction<{ id?: string }>("play", ({ action, state }) => {
    const station = findStation({ f: state.favourites, r: state.recents }, action.payload?.id);
    if (station) startStation(state, station);
  })
  .onAction("toggle", ({ state }) => togglePlayback(state))
  .onAction("toggleMute", ({ state }) => {
    state.muted = !state.muted;
  })
  .onAction("favouriteNow", ({ state }) => {
    if (state.hasStation) toggleFavourite(state, state.now);
  })
  .onAction("clearRecents", ({ state }) => {
    state.recents = [];
    state.hasRecents = false;
  })
  // The Video reports a failed stream (HTTP error, unsupported codec, CORS on
  // a redirect, …). Unmount it and say so — never retry silently.
  .onAction("streamPlaying", ({ state }) => {
    if (state.live) state.phase = "playing";
  })
  // A pause the module didn't ask for (OS audio focus, headphones unplugged,
  // a stalled stream the browser gave up on).
  .onAction("streamPaused", ({ state }) => {
    if (state.live) state.phase = "paused";
  })
  .onAction<{ status?: number; message?: string }>("streamError", ({ action, state }) => {
    if (!state.live) return; // a late event from a Video we already unmounted
    const status = action.payload?.status;
    stopStation(state);
    state.hasError = true;
    state.error = status ? `Stream unavailable (HTTP ${status})` : "This stream couldn't be played";
  })
  .ui(`
    module App {
      Column {
        Column {
          Router {
            Route(path: "/") {
              Discover().tw("flex-1 h-full min-h-0")
            }
            Route(path: "/search") {
              Search().tw("flex-1 h-full min-h-0")
            }
            Route(path: "/browse/:kind") {
              Categories().tw("flex-1 h-full min-h-0")
            }
            Route(path: "/list/:kind/:value") {
              StationList().tw("flex-1 h-full min-h-0")
            }
            Route(path: "/station/:id") {
              StationDetail().tw("flex-1 h-full min-h-0")
            }
            Route(path: "/library") {
${library}
            }
            Route(path: "/player") {
              Column {
${fullPlayer}
              }
              .tw("flex-1 w-full h-full min-h-0 items-center")
              .backgroundColor("${C.bg}")
            }
          }
        }
        .tw("flex-1 w-full min-h-0 overflow-hidden")

${miniPlayer}

        Row {
${tab("Discover", "compass", "/", "state.location == '/' || state.location == '/browse/genres' || state.location == '/browse/countries' || state.location == '/browse/languages'")}
${tab("Search", "search", "/search", "state.location == '/search'")}
${tab("Library", "library", "/library", "state.location == '/library'")}
        }
        .tw("w-full items-center")
        .backgroundColor("${C.bg}")
        .borderTop("1px solid ${C.line}")

        // The audio engine: a zero-size Video (audio-only streams play fine in
        // every renderer's video stack). Mounted only while live.
        If(condition: "@{state.live}") {
          Video(
            src: "@{state.streamUrl}",
            title: "@{state.now.name}",
            autoplay: true,
            controls: false,
            preload: "none",
            muted: @state.muted,
            onPlay: @actions.streamPlaying,
            onPause: @actions.streamPaused,
            onError: @actions.streamError
          )
            .width(0)
            .height(0)
            .overflow("hidden")
            .opacity(0)
        }
      }
      .tw("flex-1 w-full h-screen min-h-0 overflow-hidden")
      .backgroundColor("${C.bg}")
      .color("${C.text}")
    }
  `);
