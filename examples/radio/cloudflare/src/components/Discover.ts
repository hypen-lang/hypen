import { app } from "@hypen-space/core";
import { countryName, flagEmoji, searchStations, type Station } from "../radio-browser";
import { EMPTY_STATION, openPlayer, shell, startStation } from "../player";
import { currentCountry } from "../visitor";
import { back, openStation, play } from "../screen-actions";
import { C, MONO, art, dial, kicker, notice, screen, skeletonRows, skeletonTiles, stationRows, stationTiles } from "../ui";

// Discover: popular near you (request.cf country), top clicked, trending, and
// entry points into genres / countries / languages.
//
// Layout: a masthead with the FM dial; the most-played local station as a
// featured card in its own colour; local and trending stations as artwork
// carousels; the worldwide top as a numbered chart.

interface Chip {
  id: string;
  name: string;
}

type Ranked = Station & { rank: string };

interface DiscoverState {
  country: string;
  countryLabel: string;
  /** The most-played local station, shown large. */
  featured: Station;
  hasFeatured: boolean;
  local: Station[];
  top: Ranked[];
  trending: Station[];
  loading: boolean;
  failed: boolean;
  error: string;
  hasLocal: boolean;
  genres: Chip[];
}

// A handful of real, high-volume Radio Browser tags as quick shortcuts; the
// full live tag list is one tap away on /browse/genres.
const QUICK_GENRES: Chip[] = [
  { id: "pop", name: "Pop" },
  { id: "rock", name: "Rock" },
  { id: "jazz", name: "Jazz" },
  { id: "news", name: "News" },
  { id: "classical", name: "Classical" },
  { id: "electronic", name: "Electronic" },
  { id: "hiphop", name: "Hip-hop" },
  { id: "talk", name: "Talk" },
  { id: "dance", name: "Dance" },
  { id: "80s", name: "80s" },
];

const CAROUSEL_SIZE = 10;
const CHART_SIZE = 6;

export const rank = (i: number) => String(i + 1).padStart(2, "0");

async function load(state: DiscoverState) {
  state.loading = true;
  state.failed = false;
  const country = currentCountry();
  state.country = country;
  state.countryLabel = `${flagEmoji(country)} ${countryName(country)}`.trim();
  try {
    const [local, top, trending] = await Promise.all([
      searchStations({ kind: "country", value: country }, CAROUSEL_SIZE + 1),
      searchStations({ kind: "top" }, CHART_SIZE),
      searchStations({ kind: "trending" }, CAROUSEL_SIZE),
    ]);
    state.hasFeatured = local.length > 0;
    state.featured = local[0] ?? { ...EMPTY_STATION };
    state.local = local.slice(1);
    state.hasLocal = state.local.length > 0;
    state.top = top.map((s, i) => ({ ...s, rank: rank(i) }));
    state.trending = trending;
  } catch (err) {
    state.failed = true;
    state.error = `Couldn't reach Radio Browser (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    state.loading = false;
  }
}

const sectionHead = (label: string, title: string, seeAll: string) => `
          Row {
            Column {
${kicker(label)}
              Heading("${title}", level: 2)
                .tw("text-[22px] font-black text-left mt-1 tracking-tight")
                .color("${C.text}")
                .maxLines(1)
                .textOverflow("ellipsis")
            }
            .tw("flex-1 min-w-0 items-start")
            Button {
              Text("See all")
                .tw("text-xs font-bold")
                .color("${C.text}")
            }
            .tw("h-8 px-3.5 ml-3 rounded-full items-center justify-center shrink-0")
            .border("1px solid ${C.lineStrong}")
            .tw("bg-transparent hover:bg-white/10")
            .opacity({ default: 1, active: 0.6 })
            .onClick(@actions.seeAll, to: "${seeAll}")
          }
          .tw("items-end mt-9 mb-4 w-full")`;

const browseTile = (label: string, hint: string, icon: string, to: string) => `
            Button {
              Column {
                Icon(@resources.${icon})
                  .size(20)
                  .color("${C.accent}")
                Text("${label}")
                  .tw("text-[15px] font-bold mt-3 text-left")
                  .color("${C.text}")
                Text("${hint}")
                  .tw("text-[11px] mt-0.5 text-left")
                  ${MONO}
                  .color("${C.faint}")
              }
              .tw("items-start w-full")
            }
            .tw("flex-1 min-w-0 px-3.5 py-3.5 rounded-[20px] items-stretch")
            .border("1px solid ${C.line}")
            .backgroundColor({ default: "${C.surface}", hover: "${C.raised}" })
            .opacity({ default: 1, active: 0.6 })
            .transition(140, easeOut)
            .onClick(@actions.seeAll, to: "${to}")`;

const featured = `
          Row {
            Column {
${kicker("NO. 1 NEAR YOU", C.text)}
              Heading("@{state.featured.name}", level: 2)
                .tw("text-[26px] font-black text-left mt-2 leading-tight tracking-tight w-full")
                .color("${C.text}")
                .maxLines(2)
                .textOverflow("ellipsis")
              Text("@{state.featured.subtitle}")
                .tw("text-[13px] mt-1 text-left w-full")
                .color("rgba(244, 238, 225, 0.82)")
                .maxLines(1)
                .textOverflow("ellipsis")
              Row {
                Button {
                  Row {
                    Icon(@resources.play)
                      .size(14)
                      .color("${C.ink}")
                    Text("Listen live")
                      .tw("text-sm font-bold ml-2")
                      .color("${C.ink}")
                  }
                  .tw("items-center")
                }
                .tw("h-11 px-5 rounded-full border-0 items-center justify-center shrink-0")
                .backgroundColor({ default: "${C.text}", hover: "#FFFFFF" })
                .opacity({ default: 1, active: 0.72 })
                .transition(140, easeOut)
                .onClick(@actions.playFeatured)
                Button {
                  Text("Details")
                    .tw("text-sm font-bold")
                    .color("${C.text}")
                }
                .tw("h-11 px-4 ml-2 rounded-full items-center justify-center shrink-0")
                .border("1px solid rgba(244, 238, 225, 0.35)")
                .tw("bg-transparent hover:bg-white/10")
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.openStation, id: "@{state.featured.id}")
              }
              .tw("items-center mt-4")
            }
            .tw("flex-1 min-w-0 items-start")
${art("@{state.featured.art}", 104, 22, "@{state.featured.name} logo")}
              .tw("ml-4")
              .boxShadow("0 14px 30px rgba(0, 0, 0, 0.4)")
          }
          .tw("items-center w-full p-5 mt-6 rounded-[28px]")
          .background("linear-gradient(135deg, @{state.featured.tint} 0%, ${C.surface} 100%)")
          .border("1px solid ${C.line}")
          .enter(fade, duration: 240)`;

export default app
  .module("Discover")
  .defineState<DiscoverState>({
    country: "",
    countryLabel: "",
    featured: { ...EMPTY_STATION },
    hasFeatured: false,
    local: [],
    top: [],
    trending: [],
    loading: true,
    failed: false,
    error: "",
    hasLocal: false,
    genres: QUICK_GENRES,
  })
  .onCreated(async (state) => {
    await load(state);
  })
  .onAction("retry", async ({ state }) => {
    await load(state);
  })
  .onAction("play", play)
  .onAction("playFeatured", ({ state, context }) => {
    const player = shell(context);
    if (!player || !state.hasFeatured) return;
    startStation(player, state.featured);
    openPlayer(context);
  })
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
            Box {}
              .tw("w-2 h-2 rounded-full mr-2")
              .backgroundColor("${C.accent}")
              .animate(pulse, duration: 1600)
              .hidden()
${kicker("LIVE RADIO", C.accent, "flex-1")}
            Text("@{state.countryLabel}")
              .tw("text-[11px] font-bold")
              ${MONO}
              .color("${C.muted}")
          }
          .tw("items-center pt-6 w-full")
          Heading("Discover", level: 1)
            .tw("text-[44px] font-black text-left leading-none tracking-tight mt-3 mb-5 w-full")
            .color("${C.text}")
${dial()}

          Button {
            Row {
              Icon(@resources.search)
                .size(18)
                .color("${C.text}")
              Text("Search stations by name")
                .tw("text-[15px] ml-3 text-left flex-1")
                .color("${C.muted}")
            }
            .tw("items-center w-full")
          }
          .tw("w-full h-[52px] px-5 mt-6 rounded-full items-stretch justify-center")
          .border("1px solid ${C.lineStrong}")
          .backgroundColor({ default: "${C.surface}", hover: "${C.raised}" })
          .opacity({ default: 1, active: 0.7 })
          .onClick(@actions.search)

          If(condition: "@{state.loading}") {
            Column {
              Box {}.tw("w-full h-[176px] rounded-[28px] mt-6").backgroundColor("${C.surface}").animate(shimmer)
              Box {}.tw("h-5 w-48 rounded mt-9 mb-4").backgroundColor("${C.surface}")
${skeletonTiles(4)}
            }
            .tw("w-full")
          }

          If(condition: "@{state.failed}") {
            Column {
${notice("alert", "Lost the signal", "@{state.error}", ["Try again", ".onClick(@actions.retry)"], C.accent)}
            }
            .tw("w-full mt-3")
          }

          If(condition: "@{state.hasFeatured}") {
${featured}
          }

          If(condition: "@{state.hasLocal}") {
            Column {
${sectionHead("POPULAR NEAR YOU", "@{state.countryLabel}", "/list/country/local")}
${stationTiles("local")}
            }
            .tw("w-full")
          }

          Column {
${kicker("BROWSE THE DIAL", C.accent, "mb-4")}
            Row {
${browseTile("Genres", "by sound", "tag", "/browse/genres")}
${browseTile("Countries", "by place", "globe", "/browse/countries")}
${browseTile("Languages", "by tongue", "language", "/browse/languages")}
            }
            .tw("gap-2.5 w-full")
            Row {
              ForEach(items: @state.genres, key: "id") {
                Button {
                  Text("@{item.name}")
                    .tw("text-[13px] font-bold")
                    .color("${C.text}")
                }
                .tw("h-9 px-4 mr-2 rounded-full items-center justify-center shrink-0")
                .border("1px solid ${C.lineStrong}")
                .tw("bg-transparent hover:bg-white/10")
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.genre, id: "@{item.id}")
              }
            }
            .scrollable("horizontal")
            .tw("mt-3.5 flex-row w-full pb-1")
          }
          .tw("w-full mt-9 items-start")

          If(condition: "@{!state.loading && !state.failed}") {
            Column {
${sectionHead("THE CHART", "Top clicked worldwide", "/list/top/all")}
${stationRows("top", true)}
${sectionHead("CLIMBING · LAST 24 HOURS", "Trending now", "/list/trending/all")}
${stationTiles("trending", 132)}
            }
            .tw("w-full")
          }

          If(condition: "@{state.loading}") {
            Column {
${skeletonRows(4)}
            }
            .tw("mt-8 w-full")
          }

          Text("Station data from the community-run Radio Browser directory (radio-browser.info). Audio streams play directly from each broadcaster.")
            .tw("text-[11px] mt-10 text-center leading-4 w-full")
            .color("${C.faint}")
`,
    ),
  );
