import { app } from "@hypen-space/core";
import { stationById, tagList, type Station } from "../radio-browser";
import { EMPTY_STATION, isFavourite, openPlayer, shell, startStation, toggleFavourite } from "../player";
import { back, routeParam } from "../screen-actions";
import { C, MONO, errorCard, iconButton, kicker } from "../ui";

// /station/:id — full station record from Radio Browser by UUID.

interface TagChip {
  id: string;
  name: string;
  slug: string;
}

interface DetailState {
  station: Station;
  tags: TagChip[];
  loading: boolean;
  ready: boolean;
  failed: boolean;
  error: string;
  favourite: boolean;
  hasLanguage: boolean;
  language: string;
  /** Formatted figures for the stat strip. */
  votes: string;
  clicks: string;
  bitrate: string;
  /** "🇺🇸 UNITED STATES" */
  origin: string;
  /** Homepage host, shown as text ("Link" isn't a registered primitive in the published engine). */
  website: string;
}

const fmt = new Intl.NumberFormat("en");

async function load(state: DetailState, id: string, favourite: boolean) {
  state.loading = true;
  state.ready = false;
  state.failed = false;
  state.station = { ...EMPTY_STATION };
  state.tags = [];
  try {
    const station = await stationById(id);
    if (!station) {
      state.failed = true;
      state.error = "This station isn't in the Radio Browser directory any more.";
      return;
    }
    state.station = station;
    state.tags = tagList(station).map((t) => ({ id: t, name: t, slug: encodeURIComponent(t) }));
    state.hasLanguage = station.language !== "";
    // The first listed language, capitalised (text-transform isn't portable).
    state.language = (station.language.split(",")[0] ?? "").trim().replace(/\b\w/g, (m) => m.toUpperCase());
    state.votes = fmt.format(station.votes);
    state.clicks = fmt.format(station.clicks);
    state.bitrate = station.bitrate > 0 ? String(station.bitrate) : "—";
    state.origin = `${station.flag} ${station.country.toUpperCase()}`.trim();
    state.website = station.homepage ? station.homepage.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : "";
    state.favourite = favourite;
    state.ready = true;
  } catch (err) {
    state.failed = true;
    state.error = `Couldn't load this station (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    state.loading = false;
  }
}

export default app
  .module("StationDetail")
  .defineState<DetailState>({
    station: { ...EMPTY_STATION },
    tags: [],
    loading: true,
    ready: false,
    failed: false,
    error: "",
    favourite: false,
    hasLanguage: false,
    language: "",
    votes: "",
    clicks: "",
    bitrate: "",
    origin: "",
    website: "",
  })
  .onActivated(async (state, context) => {
    const id = routeParam(context, "/station/:id", "id");
    const player = shell(context);
    const fav = player ? isFavourite(player, id) : false;
    if (id === state.station.id && state.ready) {
      state.favourite = fav;
      return;
    }
    await load(state, id, fav);
  })
  .onAction("retry", async ({ state, context }) => {
    const id = routeParam(context, "/station/:id", "id");
    const player = shell(context);
    await load(state, id, player ? isFavourite(player, id) : false);
  })
  .onAction("back", back)
  .onAction("play", ({ state, context }) => {
    const player = shell(context);
    if (!player || !state.station.playable) return;
    startStation(player, state.station);
    openPlayer(context);
  })
  .onAction("favourite", ({ state, context }) => {
    const player = shell(context);
    if (!player || !state.station.id) return;
    state.favourite = toggleFavourite(player, state.station);
  })
  .onAction<{ slug?: string }>("tag", ({ action, context }) => {
    if (action.payload?.slug) context?.router?.push(`/list/tag/${action.payload.slug}`);
  })
  .onAction("country", ({ state, context }) => {
    if (state.station.countrycode) context?.router?.push(`/list/country/${state.station.countrycode}`);
  })
  .onAction("language", ({ state, context }) => {
    const lang = state.station.language.split(",")[0]?.trim();
    if (lang) context?.router?.push(`/list/language/${encodeURIComponent(lang)}`);
  })
  .ui(`
    module StationDetail {
      Column {
        Column {
          Column {
            Row {
${iconButton("chevron-left", "back", "Back")}
${kicker("STATION", "rgba(244, 238, 225, 0.8)", "ml-3.5 flex-1")}
              If(condition: "@{state.ready}") {
                Button {
                  If(condition: "@{state.favourite}") {
                    Icon(@resources.heart-filled)
                      .size(20)
                      .color("${C.accent}")
                  }
                  If(condition: "@{!state.favourite}") {
                    Icon(@resources.heart)
                      .size(20)
                      .color("${C.text}")
                  }
                }
                .tw("w-11 h-11 rounded-full items-center justify-center shrink-0 p-0")
                .border("1px solid ${C.line}")
                .backgroundColor({ default: "rgba(244, 238, 225, 0.06)", hover: "rgba(244, 238, 225, 0.14)" })
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.favourite)
                .label("Favourite")
              }
            }
            .tw("items-center pt-5 w-full")

            If(condition: "@{state.loading}") {
              Column {
                Box {}.tw("w-44 h-44 rounded-[32px]").backgroundColor("${C.surface}")
                Box {}.tw("h-6 w-56 mt-7 rounded").backgroundColor("${C.surface}")
                Box {}.tw("h-3 w-36 mt-3 rounded").backgroundColor("${C.surface}")
                Box {}.tw("h-[52px] w-full mt-8 rounded-full").backgroundColor("${C.surface}")
              }
              .tw("items-center pt-6 w-full")
              .animate(shimmer)
            }
            If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
            }

            If(condition: "@{state.ready}") {
              Column {
                Column {
                  Image(src: "@{state.station.art}", alt: "@{state.station.name} logo")
                    .objectFit("cover")
                    .width(148)
                    .height(148)
                    .borderRadius(30)
                    .backgroundColor("${C.raised}")
                    .boxShadow("0 24px 48px rgba(0, 0, 0, 0.5)")
                    .border("1px solid ${C.line}")
                  Text("@{state.origin}")
                    .tw("text-[11px] font-bold tracking-widest mt-6 text-left w-full")
                    ${MONO}
                    .color("rgba(244, 238, 225, 0.8)")
                  Heading("@{state.station.name}", level: 1)
                    .tw("text-[32px] font-black mt-1.5 text-left leading-tight tracking-tight w-full")
                    .color("${C.text}")
                    .maxLines(3)
                    .textOverflow("ellipsis")
                  Text("@{state.station.tags}")
                    .tw("text-sm mt-2 text-left w-full")
                    .color("${C.muted}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                }
                .tw("items-start w-full pt-6")

                Button {
                  Row {
                    Icon(@resources.play)
                      .size(16)
                      .color("${C.ink}")
                    Text("Listen live")
                      .tw("text-base font-bold ml-2.5")
                      .color("${C.ink}")
                  }
                  .tw("items-center")
                }
                .tw("w-full h-14 mt-7 rounded-full border-0 items-center justify-center")
                .backgroundColor("@{state.station.playable ? '${C.text}' : '${C.faint}'}")
                .opacity({ default: 1, active: 0.72 })
                .transition(140, easeOut)
                .disabled("@{!state.station.playable}")
                .onClick(@actions.play)

                If(condition: "@{!state.station.playable}") {
                  Row {
                    Icon(@resources.alert).size(16).color("${C.accent}")
                    Text("@{state.station.unplayableReason}")
                      .tw("flex-1 min-w-0 text-[13px] ml-2.5 text-left leading-5")
                      .color("${C.text}")
                  }
                  .tw("w-full items-start mt-3 px-4 py-3 rounded-[16px]")
                  .backgroundColor("${C.accentSoft}")
                }

                Row {
                Column {
                  Text("@{state.votes}")
                    .tw("text-xl font-black text-center")
                    .color("${C.text}")
                  Text("VOTES")
                    .tw("text-[10px] font-bold tracking-widest mt-1 text-center")
                    ${MONO}
                    .color("${C.faint}")
                }
                .tw("flex-1 items-center")
                Box {}.width(1).height(28).backgroundColor("${C.line}")
                Column {
                  Text("@{state.clicks}")
                    .tw("text-xl font-black text-center")
                    .color("${C.text}")
                  Text("CLICKS")
                    .tw("text-[10px] font-bold tracking-widest mt-1 text-center")
                    ${MONO}
                    .color("${C.faint}")
                }
                .tw("flex-1 items-center")
                Box {}.width(1).height(28).backgroundColor("${C.line}")
                Column {
                  Text("@{state.bitrate}")
                    .tw("text-xl font-black text-center")
                    .color("${C.text}")
                  Text("KBPS")
                    .tw("text-[10px] font-bold tracking-widest mt-1 text-center")
                    ${MONO}
                    .color("${C.faint}")
                }
                .tw("flex-1 items-center")
                Box {}.width(1).height(28).backgroundColor("${C.line}")
                Column {
                  Text("@{state.station.codec}")
                    .tw("text-xl font-black text-center")
                    .color("${C.text}")
                  Text("CODEC")
                    .tw("text-[10px] font-bold tracking-widest mt-1 text-center")
                    ${MONO}
                    .color("${C.faint}")
                }
                .tw("flex-1 items-center")
                }
                .tw("w-full items-center mt-6 py-4 rounded-[20px]")
                .border("1px solid ${C.line}")
                .backgroundColor("rgba(13, 11, 9, 0.35)")
              }
              .tw("w-full items-center")
              .enter(fade, duration: 220)
            }
          }
          .tw("w-full px-5 md:px-10 pb-7")
          .maxWidth(640)
        }
        .tw("w-full items-center")
        .background("linear-gradient(180deg, @{state.station.tint} 0%, ${C.bg} 100%)")

        If(condition: "@{state.ready}") {
          Column {
${kicker("FIND MORE LIKE IT", C.faint, "mb-3")}
            Column {
                Button {
                  Row {
                    Icon(@resources.map-pin).size(18).color("${C.muted}").tw("w-6")
                    Text("More from @{state.station.country}")
                      .tw("flex-1 min-w-0 ml-3 text-[15px] text-left")
                      .color("${C.text}")
                      .maxLines(1)
                      .textOverflow("ellipsis")
                    Icon(@resources.chevron-right).size(16).color("${C.faint}")
                  }
                  .tw("items-center w-full")
                }
                .tw("w-full h-[52px] px-4 bg-transparent border-0 items-stretch justify-center")
                .tw("bg-transparent hover:bg-white/10")
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.country)
              If(condition: "@{state.hasLanguage}") {
                Column {
                  Box {}.tw("w-full").height(1).backgroundColor("${C.line}")
                Button {
                  Row {
                    Icon(@resources.language).size(18).color("${C.muted}").tw("w-6")
                    Text("Stations in @{state.language}")
                      .tw("flex-1 min-w-0 ml-3 text-[15px] text-left")
                      .color("${C.text}")
                      .maxLines(1)
                      .textOverflow("ellipsis")
                    Icon(@resources.chevron-right).size(16).color("${C.faint}")
                  }
                  .tw("items-center w-full")
                }
                .tw("w-full h-[52px] px-4 bg-transparent border-0 items-stretch justify-center")
                .tw("bg-transparent hover:bg-white/10")
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.language)
                }
                .tw("w-full")
              }
            }
            .tw("w-full rounded-[20px] overflow-hidden")
            .border("1px solid ${C.line}")
            .backgroundColor("${C.surface}")

            If(condition: "@{state.station.hasHomepage}") {
              Row {
                Icon(@resources.external).size(16).color("${C.muted}")
                Text("@{state.website}")
                  .tw("flex-1 min-w-0 ml-3 text-sm text-left")
                  ${MONO}
                  .color("${C.muted}")
                  .maxLines(1)
                  .textOverflow("ellipsis")
              }
              .tw("items-center w-full px-4 mt-4")
            }

${kicker("TAGS", C.faint, "mt-8 mb-3")}
            Grid(@state.tags, key: "id") {
              Button {
                Text("@{item.name}")
                  .tw("text-[13px] font-bold text-center w-full")
                  .color("${C.text}")
                  .maxLines(1)
                  .textOverflow("ellipsis")
              }
              .tw("h-10 px-3 rounded-full items-center justify-center min-w-0")
              .border("1px solid ${C.lineStrong}")
              .tw("bg-transparent hover:bg-white/10")
              .opacity({ default: 1, active: 0.6 })
              .onClick(@actions.tag, slug: "@{item.slug}")
            }
            .gridColumns(3)
            .tw("gap-2 w-full")
          }
          .tw("w-full px-5 md:px-10 pt-2 pb-10 items-start")
          .maxWidth(640)
          .enter(fade, duration: 220)
        }
      }
      .horizontalAlignment("center")
      .scrollable(true)
      .tw("flex-1 w-full min-h-0")
      .backgroundColor("${C.bg}")
    }
  `);
