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
import { tintFor } from "../tint";
import type { Station } from "../radio-browser";
import { C, MONO, SANS, art, dial, eqBars, iconButton, kicker, notice, stationRows } from "../ui";

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
// Layout: on a phone the tab bar sits under the screens; from the md
// breakpoint the same bar turns into a rail on the left (the shell is a
// reversed column that becomes a row, so no node is shown or hidden per
// breakpoint). The tab bar steps aside on /player, which is a full-screen
// surface with its own close button.
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

/** Play / stop glyph; the button behind it is cream when idle, red on air. */
const playIcon = (size: number) => `
                If(condition: "@{state.live}") {
                  Icon(@resources.stop)
                    .size(${size})
                    .color("${C.ink}")
                }
                If(condition: "@{!state.live}") {
                  Icon(@resources.play)
                    .size(${size})
                    .color("${C.ink}")
                }`;
const PLAY_BG = `.backgroundColor("@{state.live ? '${C.accent}' : '${C.text}'}")`;

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

const roundButton = (content: string, action: string, label: string, size = 44) => `
              Button {
${content}
              }
              .tw("rounded-full items-center justify-center shrink-0 p-0")
              .width(${size})
              .height(${size})
              .border("1px solid ${C.line}")
              .backgroundColor({ default: "rgba(244, 238, 225, 0.06)", hover: "rgba(244, 238, 225, 0.14)" })
              .opacity({ default: 1, active: 0.6 })
              .transition(140, easeOut)
              .onClick(@actions.${action})
              .label("${label}")`;

/** "ON AIR" / "TUNING" / "OFF AIR" capsule with the live dot. */
const onAir = `
              Row {
                If(condition: "@{state.phase == 'playing'}") {
                  Box {}
                    .tw("w-2 h-2 rounded-full mr-2")
                    .backgroundColor("${C.accent}")
                    .animate(pulse, duration: 1400)
                    .hidden()
                }
                If(condition: "@{state.phase != 'playing'}") {
                  Box {}
                    .tw("w-2 h-2 rounded-full mr-2")
                    .backgroundColor("${C.faint}")
                    .hidden()
                }
                Text("@{state.phase == 'playing' ? 'ON AIR' : (state.live ? 'TUNING' : 'OFF AIR')}")
                  .tw("text-[11px] font-bold tracking-widest")
                  ${MONO}
                  .color("@{state.phase == 'playing' ? '${C.text}' : '${C.muted}'}")
              }
              .tw("items-center h-8 px-3.5 rounded-full")
              .border("1px solid ${C.lineStrong}")
              .backgroundColor("rgba(13, 11, 9, 0.35)")`;

const tab = (label: string, icon: string, to: string, active: string) => `
          Button {
            Column {
              Icon(@resources.${icon})
                .size(22)
                .color("@{${active} ? '${C.text}' : '${C.faint}'}")
              Text("${label}")
                .tw("text-[11px] font-bold mt-1")
                .color("@{${active} ? '${C.text}' : '${C.faint}'}")
              Box {}
                .tw("w-1 h-1 rounded-full mt-1")
                .backgroundColor("@{${active} ? '${C.accent}' : 'rgba(255, 81, 38, 0)'}")
                .hidden()
            }
            .tw("items-center")
          }
          .tw("h-16 md:h-[76px] shrink-0 bg-transparent border-0 items-center justify-center p-0")
          .width({ default: "33.33%", md: "100%" })
          .opacity({ default: 1, active: 0.6 })
          .onClick(@actions.go, to: "${to}")`;

const libraryHead = (label: string, title: string, trailing = "") => `
              Row {
                Column {
${kicker(label)}
                  Heading("${title}", level: 2)
                    .tw("text-[22px] font-black text-left mt-1 tracking-tight")
                    .color("${C.text}")
                }
                .tw("flex-1 min-w-0 items-start")
                ${trailing}
              }
              .tw("items-end mt-8 mb-3 w-full")`;

const library = `
          Column {
            Column {
              Heading("Library", level: 1)
                .tw("text-[44px] font-black text-left leading-none tracking-tight pt-6 w-full")
                .color("${C.text}")
              Text("Kept on this server for this browser. No account needed.")
                .tw("text-[13px] mt-2 text-left w-full")
                .color("${C.muted}")

${libraryHead("SAVED", "Favourites")}
              If(condition: "@{!state.hasFavourites}") {
${notice("heart", "No favourites yet", "Tap the heart on a station or in the player and it stays here, ready to tune.", ["Find a station", '.onClick(@actions.go, to: "/")'])}
              }
${stationRows("favourites", false, "state.hasFavourites")}

${libraryHead("HISTORY", "Recently played", `If(condition: "@{state.hasRecents}") {
                  Button {
                    Text("Clear")
                      .tw("text-xs font-bold")
                      .color("${C.text}")
                  }
                  .tw("h-8 px-3.5 ml-3 rounded-full items-center justify-center shrink-0")
                  .border("1px solid ${C.lineStrong}")
                  .tw("bg-transparent hover:bg-white/10")
                  .onClick(@actions.clearRecents)
                }`)}
              If(condition: "@{!state.hasRecents}") {
${notice("clock", "Nothing played yet", "Every station you start is logged here, most recent first.")}
              }
${stationRows("recents", false, "state.hasRecents")}
            }
            .tw("w-full px-5 md:px-10 pb-8")
            .maxWidth(1080)
          }
          .horizontalAlignment("center")
          .scrollable(true)
          .tw("flex-1 w-full min-h-0")
          .backgroundColor("${C.bg}")`;

const fullPlayer = `
          Column {
            Row {
${roundButton(`                Icon(@resources.chevron-down).size(22).color("${C.text}")`, "back", "Close player")}
              Row {
${onAir}
              }
              .tw("flex-1 justify-center")
${roundButton(heartIcon(20), "favouriteNow", "Favourite")}
            }
            .tw("w-full items-center pt-5")

            If(condition: "@{!state.hasStation}") {
              Column {
                Column {
${dial(33, 16, true)}
                }
                .tw("w-full mb-9")
                .maxWidth(280)
                Heading("Nothing on air", level: 1)
                  .tw("text-[30px] font-black text-center tracking-tight")
                  .color("${C.text}")
                Text("Pick a station and it plays here.")
                  .tw("text-sm mt-2 text-center")
                  .color("${C.muted}")
                Button {
                  Text("Discover stations")
                    .tw("text-sm font-bold")
                    .color("${C.ink}")
                }
                .tw("mt-6 h-12 px-7 rounded-full border-0 items-center justify-center")
                .backgroundColor({ default: "${C.text}", hover: "#FFFFFF" })
                .onClick(@actions.go, to: "/")
              }
              .tw("flex-1 items-center justify-center w-full")
            }

            If(condition: "@{state.hasStation}") {
              Column {
                Image(src: "@{state.now.art}", alt: "@{state.now.name} logo")
                  .objectFit("cover")
                  .width({ default: 232, md: 340 })
                  .height({ default: 232, md: 340 })
                  .tw("shrink-0")
                  .borderRadius(36)
                  .backgroundColor("${C.raised}")
                  .border("1px solid ${C.line}")
                  .boxShadow("0 30px 60px rgba(0, 0, 0, 0.55)")
                  .opacity("@{state.live ? 1 : 0.72}")
                  .transition(240, easeOut)
                  .sharedElement("now-art", curve: spring, duration: 360)

                Column {
                  Heading("@{state.now.name}", level: 1)
                    .tw("text-[28px] md:text-[40px] font-black text-left leading-tight tracking-tight w-full")
                    .color("${C.text}")
                    .maxLines(2)
                    .textOverflow("ellipsis")
                  Text("@{state.now.subtitle}")
                    .tw("text-sm mt-1.5 text-left w-full")
                    .color("${C.muted}")
                    .maxLines(1)
                    .textOverflow("ellipsis")

                  Column {
                    Row {
                      Text("@{state.hasError ? 'NO SIGNAL' : (state.hasNowTitle ? 'NOW PLAYING · FROM THE STREAM' : (state.live ? 'STATUS' : 'STOPPED'))}")
                        .tw("flex-1 text-[10px] font-bold tracking-widest text-left")
                        ${MONO}
                        .color("${C.accent}")
                      If(condition: "@{state.phase == 'playing'}") {
${eqBars(14)}
                      }
                    }
                    .tw("w-full items-center")
                    Text("${STATUS}")
                      .tw("text-base font-bold mt-2 text-left w-full leading-snug")
                      .color("${C.text}")
                      .maxLines(2)
                      .textOverflow("ellipsis")
                      .liveRegion("polite")
                  }
                  .tw("w-full mt-5 px-4 py-3.5 rounded-[20px] items-start")
                  .border("1px solid ${C.line}")
                  .backgroundColor("rgba(13, 11, 9, 0.45)")

                  Column {
${dial(45, 28, false)}
                  }
                  .tw("w-full mt-6")

                  Row {
                    Button {
                      If(condition: "@{state.muted}") {
                        Icon(@resources.volume-x).size(22).color("${C.accent}")
                      }
                      If(condition: "@{!state.muted}") {
                        Icon(@resources.volume).size(22).color("${C.text}")
                      }
                    }
                    .tw("w-14 h-14 rounded-full items-center justify-center p-0")
                    .border("1px solid ${C.lineStrong}")
                    .backgroundColor({ default: "rgba(244, 238, 225, 0.06)", hover: "rgba(244, 238, 225, 0.14)" })
                    .opacity({ default: 1, active: 0.6 })
                    .onClick(@actions.toggleMute)
                    .label("Mute")

                    Button {
${playIcon(30)}
                    }
                    .tw("w-[84px] h-[84px] mx-7 rounded-full border-0 items-center justify-center p-0")
                    ${PLAY_BG}
                    .boxShadow("0 14px 34px rgba(0, 0, 0, 0.45)")
                    .opacity({ default: 1, active: 0.72 })
                    .transition(180, easeOut)
                    .onClick(@actions.toggle)
                    .label("Play or stop")

                    Button {
                      Icon(@resources.info).size(22).color("${C.text}")
                    }
                    .tw("w-14 h-14 rounded-full items-center justify-center p-0")
                    .border("1px solid ${C.lineStrong}")
                    .backgroundColor({ default: "rgba(244, 238, 225, 0.06)", hover: "rgba(244, 238, 225, 0.14)" })
                    .opacity({ default: 1, active: 0.6 })
                    .onClick(@actions.openStation, id: "@{state.now.id}")
                    .label("Station details")
                  }
                  .tw("mt-6 items-center justify-center md:justify-start w-full")

                  Text("@{state.now.flag} @{state.now.countrycode}  ·  @{state.now.quality}  ·  LIVE EDGE")
                    .tw("text-[11px] mt-6 text-left w-full")
                    ${MONO}
                    .color("${C.muted}")
                    .maxLines(1)
                  Text("Stop releases the stream. Play rejoins at the live edge.")
                    .tw("text-xs mt-2 text-left w-full")
                    .color("${C.faint}")
                    .maxLines(1)
                  Text("Volume follows your device; the speaker button mutes.")
                    .tw("text-xs mt-0.5 text-left w-full")
                    .color("${C.faint}")
                    .maxLines(1)
                }
                .tw("w-full md:flex-1 md:min-w-0 mt-7 md:mt-0 md:ml-14 items-center md:items-start")
                .maxWidth(460)
              }
              .tw("w-full flex-1 flex-col md:flex-row items-center justify-center pt-6 md:pt-0")
              .enter(fade, duration: 220)
            }
          }
          .tw("flex-1 w-full min-h-0 px-6 pb-7 items-center")
          .maxWidth(960)
          .scrollable(true)`;

const miniPlayer = `
        If(condition: "@{state.hasStation && state.location != '/player'}") {
          Column {
            Row {
              Button {
                Row {
                  Image(src: "@{state.now.art}", alt: "@{state.now.name} logo")
                    .objectFit("cover")
                    .width(44)
                    .height(44)
                    .minWidth(44)
                    .borderRadius(12)
                    .backgroundColor("${C.raised}")
                    .sharedElement("now-art", curve: spring, duration: 360)
                  Column {
                    Text("@{state.now.name}")
                      .tw("text-[15px] font-bold text-left w-full")
                      .color("${C.text}")
                      .maxLines(1)
                      .textOverflow("ellipsis")
                    Row {
                      If(condition: "@{state.phase == 'playing'}") {
                        Row {
${eqBars(10)}
                        }
                        .tw("mr-2 shrink-0")
                      }
                      Text("${STATUS}")
                        .tw("flex-1 min-w-0 text-xs text-left")
                        .color("@{state.hasError ? '${C.accent}' : '${C.muted}'}")
                        .maxLines(1)
                        .textOverflow("ellipsis")
                    }
                    .tw("items-center w-full mt-0.5")
                  }
                  .tw("flex-1 min-w-0 ml-3 items-start")
                }
                .tw("items-center w-full")
              }
              .tw("flex-1 min-w-0 bg-transparent border-0 p-0 items-stretch")
              .onClick(@actions.go, to: "/player")
              .label("Open player")

              Button {
${heartIcon(20)}
              }
              .tw("w-11 h-11 ml-1 rounded-full border-0 items-center justify-center bg-transparent shrink-0 p-0")
              .opacity({ default: 1, active: 0.6 })
              .onClick(@actions.favouriteNow)
              .label("Favourite")

              Button {
${playIcon(16)}
              }
              .tw("w-11 h-11 ml-1 rounded-full border-0 items-center justify-center shrink-0 p-0")
              ${PLAY_BG}
              .opacity({ default: 1, active: 0.72 })
              .transition(160, easeOut)
              .onClick(@actions.toggle)
              .label("Play or stop")
            }
            .tw("w-full pl-2 pr-2 py-2 items-center rounded-[22px]")
            .backgroundColor("${C.raised}")
            .border("1px solid ${C.lineStrong}")
            .boxShadow("0 10px 30px rgba(0, 0, 0, 0.5)")
          }
          .tw("w-full px-3 pb-2 pt-1 items-center")
          .backgroundColor("${C.bg}")
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
    // Stations saved before stations carried a colour: give them theirs.
    const tinted = (s: Station): Station => (s.tint ? s : { ...s, ...tintFor(s.id) });
    state.favourites = state.favourites.map(tinted);
    state.recents = state.recents.map(tinted);
    if (state.hasStation) state.now = tinted(state.now);
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
        If(condition: "@{state.location != '/player'}") {
          Row {
${tab("Discover", "compass", "/", "(state.location == '/' || state.location == '/browse/genres' || state.location == '/browse/countries' || state.location == '/browse/languages')")}
${tab("Search", "search", "/search", "(state.location == '/search')")}
${tab("Library", "library", "/library", "(state.location == '/library')")}
          }
          .tw("flex-row md:flex-col w-full md:w-[92px] md:h-full md:pt-6 items-center md:items-stretch shrink-0")
          .backgroundColor("${C.bg}")
          .borderTop({ default: "1px solid ${C.line}", md: "0px solid ${C.line}" })
          .borderRight({ default: "0px solid ${C.line}", md: "1px solid ${C.line}" })
        }

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
                .background("linear-gradient(180deg, @{state.now.tint} 0%, ${C.bg} 62%)")
              }
            }
          }
          .tw("flex-1 w-full min-h-0 overflow-hidden")

${miniPlayer}
        }
        .tw("flex-1 min-w-0 min-h-0 w-full md:h-full")

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
      .tw("flex-col-reverse md:flex-row flex-1 w-full h-screen min-h-0 overflow-hidden")
      .backgroundColor("${C.bg}")
      .color("${C.text}")
      .fontFamily("${SANS}")
    }
  `);
