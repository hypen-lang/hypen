import { app } from "@hypen-space/core";
import { countryName, flagEmoji, searchStations, type Station } from "../radio-browser";
import { currentCountry } from "../visitor";
import { back, openStation, play } from "../screen-actions";
import { C, skeletonRows, screen, stationRows } from "../ui";

// Discover: popular near you (request.cf country), top clicked, trending, and
// entry points into genres / countries / languages.

interface Chip {
  id: string;
  name: string;
}

interface DiscoverState {
  country: string;
  countryLabel: string;
  local: Station[];
  top: Station[];
  trending: Station[];
  loading: boolean;
  failed: boolean;
  error: string;
  hasLocal: boolean;
  genres: Chip[];
}

// A handful of real, high-volume Radio Browser tags as quick shortcuts; the
// full live tag list is one tap away on /browse/genres.
const QUICK_GENRES = ["pop", "rock", "jazz", "news", "classical", "electronic", "hiphop", "talk", "dance", "80s"];

const SECTION_SIZE = 5;

async function load(state: DiscoverState) {
  state.loading = true;
  state.failed = false;
  const country = currentCountry();
  state.country = country;
  state.countryLabel = `${flagEmoji(country)} ${countryName(country)}`.trim();
  try {
    const [local, top, trending] = await Promise.all([
      searchStations({ kind: "country", value: country }, SECTION_SIZE),
      searchStations({ kind: "top" }, SECTION_SIZE),
      searchStations({ kind: "trending" }, SECTION_SIZE),
    ]);
    state.local = local;
    state.hasLocal = local.length > 0;
    state.top = top;
    state.trending = trending;
  } catch (err) {
    state.failed = true;
    state.error = `Couldn't reach Radio Browser (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    state.loading = false;
  }
}

const section = (title: string, icon: string, binding: string, seeAll: string) => `
          Row {
            Icon(@resources.${icon})
              .size(16)
              .color("${C.accent}")
            Heading("${title}", level: 2)
              .tw("flex-1 ml-2 text-base font-bold text-left")
              .color("${C.text}")
            Button {
              Text("See all")
                .tw("text-xs font-semibold")
                .color("${C.accent}")
            }
            .tw("bg-transparent border-0 px-2 py-1")
            .onClick(@actions.seeAll, to: "${seeAll}")
          }
          .tw("items-center mt-6 mb-1")
${stationRows(binding)}`;

const browseTile = (label: string, icon: string, to: string) => `
            Button {
              Column {
                Icon(@resources.${icon})
                  .size(20)
                  .color("${C.accent}")
                Text("${label}")
                  .tw("text-[13px] font-semibold mt-2")
                  .color("${C.text}")
              }
              .tw("items-center")
            }
            .tw("flex-1 py-3.5 rounded-2xl border-0 items-center justify-center")
            .backgroundColor({ default: "${C.surface}", hover: "${C.surface2}" })
            .opacity({ default: 1, active: 0.6 })
            .onClick(@actions.seeAll, to: "${to}")`;

export default app
  .module("Discover")
  .defineState<DiscoverState>({
    country: "",
    countryLabel: "",
    local: [],
    top: [],
    trending: [],
    loading: true,
    failed: false,
    error: "",
    hasLocal: false,
    genres: QUICK_GENRES.map((g) => ({ id: g, name: g })),
  })
  .onCreated(async (state) => {
    await load(state);
  })
  .onAction("retry", async ({ state }) => {
    await load(state);
  })
  .onAction("play", play)
  .onAction("openStation", openStation)
  .onAction("back", back)
  .onAction<{ to?: string }>("seeAll", ({ action, state, context }) => {
    let to = action.payload?.to ?? "/";
    if (to === "/list/country/local") to = `/list/country/${state.country}`;
    context?.router?.push(to);
  })
  .onAction<{ id?: string }>("genre", ({ action, context }) => {
    if (action.payload?.id) context?.router?.push(`/list/tag/${encodeURIComponent(action.payload.id)}`);
  })
  .onAction("search", ({ context }) => {
    context?.router?.push("/search");
  })
  .ui(
    screen(
      "Discover",
      `
          Row {
            Column {
              Text("RADIO")
                .tw("text-[11px] font-bold tracking-widest text-left")
                .color("${C.accent}")
              Heading("Discover", level: 1)
                .tw("text-[26px] font-bold text-left")
                .color("${C.text}")
            }
            .tw("flex-1 items-start")
            Icon(@resources.radio)
              .size(26)
              .color("${C.accent}")
          }
          .tw("items-center pt-6 pb-4")

          Button {
            Row {
              Icon(@resources.search)
                .size(16)
                .color("${C.muted}")
              Text("Search stations by name")
                .tw("text-sm ml-2.5 text-left")
                .color("${C.muted}")
            }
            .tw("items-center")
          }
          .tw("w-full h-11 px-4 rounded-xl border-0 items-start justify-center")
          .backgroundColor("${C.surface}")
          .opacity({ default: 1, active: 0.7 })
          .onClick(@actions.search)

          Row {
${browseTile("Genres", "tag", "/browse/genres")}
${browseTile("Countries", "globe", "/browse/countries")}
${browseTile("Languages", "language", "/browse/languages")}
          }
          .tw("mt-4 gap-2.5")

          Row {
            ForEach(items: @state.genres, key: "id") {
              Button {
                Text("#@{item.name}")
                  .tw("text-xs font-semibold")
                  .color("${C.text}")
              }
              .tw("h-8 px-3.5 mr-2 rounded-full border-0 items-center justify-center shrink-0")
              .backgroundColor({ default: "${C.accentSoft}", hover: "rgba(255, 90, 54, 0.28)" })
              .opacity({ default: 1, active: 0.6 })
              .onClick(@actions.genre, id: "@{item.id}")
            }
          }
          .scrollable("horizontal")
          .tw("mt-4 flex-row w-full")

          If(condition: "@{state.loading}") {
            Column {
${skeletonRows(6)}
            }
            .tw("mt-6 w-full")
          }

          If(condition: "@{state.failed}") {
${errorBlock()}
          }

          If(condition: "@{state.hasLocal}") {
            Column {
${section("Popular in @{state.countryLabel}", "map-pin", "local", "/list/country/local")}
            }
            .tw("w-full")
          }
          If(condition: "@{!state.loading && !state.failed}") {
            Column {
${section("Top clicked worldwide", "flame", "top", "/list/top/all")}
${section("Trending now", "trending", "trending", "/list/trending/all")}
            }
            .tw("w-full")
          }

          Text("Station data from the community-run Radio Browser directory (radio-browser.info). Audio streams play directly from each broadcaster.")
            .tw("text-[11px] mt-8 text-center")
            .color("${C.faint}")
`,
    ),
  );

function errorBlock(): string {
  return `
            Column {
              Icon(@resources.alert)
                .size(26)
                .color("${C.accent}")
              Text("@{state.error}")
                .tw("text-sm mt-3 text-center")
                .color("${C.muted}")
              Button {
                Text("Try again")
                  .tw("text-sm font-semibold")
                  .color("${C.text}")
              }
              .tw("mt-4 h-10 px-5 rounded-xl border-0 items-center justify-center")
              .backgroundColor("${C.surface2}")
              .onClick(@actions.retry)
            }
            .tw("items-center py-10 px-6 mt-6 rounded-2xl w-full")
            .backgroundColor("${C.surface}")`;
}
