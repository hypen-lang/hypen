import { app } from "@hypen-space/core";
import { countryName, flagEmoji, searchStations, type ListKind, type Station } from "../radio-browser";
import { back, openStation, play, routeParam } from "../screen-actions";
import { C, errorCard, screen, skeletonRows, stationRows, subHeader } from "../ui";

// /list/:kind/:value — top | trending | country/<CC> | tag/<tag> | language/<name>

interface StationListState {
  key: string;
  title: string;
  subtitle: string;
  stations: Station[];
  loading: boolean;
  failed: boolean;
  empty: boolean;
  error: string;
}

const KINDS: ListKind[] = ["top", "trending", "country", "tag", "language"];

function describe(kind: ListKind, value: string): { title: string; subtitle: string } {
  switch (kind) {
    case "top":
      return { title: "Top clicked", subtitle: "Most played stations worldwide" };
    case "trending":
      return { title: "Trending now", subtitle: "Climbing fastest in the last 24 hours" };
    case "country":
      return { title: `${flagEmoji(value)} ${countryName(value)}`.trim(), subtitle: "Most played stations" };
    case "language":
      return { title: value.replace(/\b\w/g, (m) => m.toUpperCase()), subtitle: "Stations broadcasting in this language" };
    default:
      return { title: `#${value}`, subtitle: "Stations tagged with this genre" };
  }
}

async function load(state: StationListState, kind: ListKind, value: string) {
  const { title, subtitle } = describe(kind, value);
  state.title = title;
  state.subtitle = subtitle;
  state.stations = [];
  state.loading = true;
  state.failed = false;
  state.empty = false;
  try {
    state.stations = await searchStations({ kind, value }, 50);
    state.empty = state.stations.length === 0;
  } catch (err) {
    state.failed = true;
    state.error = `Couldn't load stations (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    state.loading = false;
  }
}

export default app
  .module("StationList")
  .defineState<StationListState>({
    key: "",
    title: "",
    subtitle: "",
    stations: [],
    loading: true,
    failed: false,
    empty: false,
    error: "",
  })
  .onActivated(async (state, context) => {
    const rawKind = routeParam(context, "/list/:kind/:value", "kind") as ListKind;
    const kind = KINDS.includes(rawKind) ? rawKind : "top";
    const value = routeParam(context, "/list/:kind/:value", "value");
    const key = `${kind}/${value}`;
    // The module instance persists across navigations: only refetch when the
    // list it shows actually changed.
    if (key === state.key && !state.failed) return;
    state.key = key;
    await load(state, kind, value);
  })
  .onAction("retry", async ({ state }) => {
    const [kind, ...rest] = state.key.split("/");
    await load(state, kind as ListKind, rest.join("/"));
  })
  .onAction("play", play)
  .onAction("openStation", openStation)
  .onAction("back", back)
  .ui(
    screen(
      "StationList",
      `
${subHeader("@{state.title}", "@{state.subtitle}")}

          If(condition: "@{state.loading}") {
            Column {
${skeletonRows(8)}
            }
            .tw("w-full")
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }
          If(condition: "@{state.empty}") {
            Text("No stations here stream over HTTPS in a format every platform can play.")
              .tw("text-sm py-10 text-center")
              .color("${C.muted}")
          }
${stationRows("stations")}
`,
    ),
  );
