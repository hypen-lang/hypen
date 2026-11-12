import { app } from "@hypen-space/core";
import { stationById, tagList, type Station } from "../radio-browser";
import { EMPTY_STATION, isFavourite, openPlayer, shell, startStation, toggleFavourite } from "../player";
import { back, routeParam } from "../screen-actions";
import { C, art, errorCard, screen, subHeader } from "../ui";

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
  /** "1,234 votes · 56,789 clicks" */
  stats: string;
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
    state.stats = `${fmt.format(station.votes)} votes · ${fmt.format(station.clicks)} clicks`;
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
    stats: "",
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
  .ui(
    screen(
      "StationDetail",
      `
${subHeader("Station")}

          If(condition: "@{state.loading}") {
            Column {
              Box {}.tw("w-40 h-40 rounded-3xl").backgroundColor("${C.surface}")
              Box {}.tw("h-5 w-48 mt-5 rounded").backgroundColor("${C.surface}")
              Box {}.tw("h-3 w-32 mt-3 rounded").backgroundColor("${C.surface}")
            }
            .tw("items-center py-6 w-full")
            .animate(shimmer)
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }

          If(condition: "@{state.ready}") {
            Column {
              Column {
${art("@{state.station.art}", 168, 28, "@{state.station.name} logo")}
                  .boxShadow("0 18px 40px rgba(0, 0, 0, 0.45)")
                Heading("@{state.station.name}", level: 2)
                  .tw("text-2xl font-bold mt-5 text-center")
                  .color("${C.text}")
                Text("@{state.station.quality}")
                  .tw("text-xs mt-1.5 text-center")
                  .color("${C.muted}")
                Text("@{state.stats}")
                  .tw("text-[11px] mt-1 text-center")
                  .color("${C.faint}")
              }
              .tw("items-center w-full pt-2")

              Row {
                Button {
                  Row {
                    Icon(@resources.play)
                      .size(16)
                      .color("#FFFFFF")
                    Text("Listen live")
                      .tw("text-sm font-bold ml-2")
                      .color("#FFFFFF")
                  }
                  .tw("items-center")
                }
                .tw("flex-1 h-12 rounded-2xl border-0 items-center justify-center")
                .backgroundColor("@{state.station.playable ? '${C.accent}' : '${C.surface2}'}")
                .opacity({ default: 1, active: 0.7 })
                .disabled("@{!state.station.playable}")
                .onClick(@actions.play)

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
                .tw("w-12 h-12 ml-3 rounded-2xl border-0 items-center justify-center")
                .backgroundColor("${C.surface}")
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.favourite)
                .label("Favourite")
              }
              .tw("w-full mt-6 items-center")

              If(condition: "@{!state.station.playable}") {
                Text("@{state.station.unplayableReason}")
                  .tw("text-xs mt-3 text-center")
                  .color("${C.accent}")
              }

              Column {
                Text("DETAILS")
                  .tw("text-[11px] font-bold tracking-widest text-left")
                  .color("${C.faint}")
                Button {
                  Row {
                    Text("@{state.station.flag}").tw("text-base")
                    Text("@{state.station.country}")
                      .tw("flex-1 ml-2 text-sm text-left")
                      .color("${C.text}")
                    Icon(@resources.chevron-right).size(16).color("${C.faint}")
                  }
                  .tw("items-center w-full")
                }
                .tw("w-full py-3 bg-transparent border-0 px-0 items-stretch")
                .borderBottom("1px solid ${C.line}")
                .onClick(@actions.country)
                If(condition: "@{state.hasLanguage}") {
                  Button {
                    Row {
                      Icon(@resources.language).size(16).color("${C.muted}")
                      Text("@{state.station.language}")
                        .tw("flex-1 ml-2 text-sm text-left")
                        .color("${C.text}")
                        .textTransform("capitalize")
                      Icon(@resources.chevron-right).size(16).color("${C.faint}")
                    }
                    .tw("items-center w-full")
                  }
                  .tw("w-full py-3 bg-transparent border-0 px-0 items-stretch")
                  .borderBottom("1px solid ${C.line}")
                  .onClick(@actions.language)
                }
                If(condition: "@{state.station.hasHomepage}") {
                  Row {
                    Icon(@resources.external).size(16).color("${C.muted}")
                    Text("@{state.website}")
                      .tw("flex-1 ml-2 text-sm text-left")
                      .color("${C.text}")
                      .maxLines(1)
                      .textOverflow("ellipsis")
                  }
                  .tw("items-center w-full py-3")
                }
              }
              .tw("w-full mt-7 items-stretch")

              Text("TAGS")
                .tw("text-[11px] font-bold tracking-widest text-left mt-6 mb-3 w-full")
                .color("${C.faint}")
              Row {
                ForEach(items: @state.tags, key: "id") {
                  Button {
                    Text("#@{item.name}")
                      .tw("text-xs font-semibold")
                      .color("${C.text}")
                  }
                  .tw("h-8 px-3.5 mr-2 mb-2 rounded-full border-0 items-center justify-center")
                  .backgroundColor({ default: "${C.accentSoft}", hover: "rgba(255, 90, 54, 0.28)" })
                  .onClick(@actions.tag, slug: "@{item.slug}")
                }
              }
              .tw("w-full flex-wrap")
            }
            .tw("w-full items-center")
            .enter(fade, duration: 200)
          }
`,
    ),
  );
