import { app } from "@hypen-space/core";
import { countryName, flagEmoji, searchStations, type ListKind, type Station } from "../radio-browser";
import { back, openStation, play, routeParam } from "../screen-actions";
import { errorCard, notice, screen, skeletonRows, stationRows, subHeader } from "../ui";

// /list/:kind/:value — top | trending | country/<CC> | tag/<tag> | language/<name>

interface StationListState {
  key: string;
  title: string;
  subtitle: string;
  /** Kicker over the title: "GENRE", "COUNTRY", "THE CHART"… */
  label: string;
  stations: (Station & { rank: string })[];
  loading: boolean;
  failed: boolean;
  empty: boolean;
  error: string;
}

const KINDS: ListKind[] = ["top", "trending", "country", "tag", "language"];

const LABELS: Record<ListKind, string> = {
  top: "THE CHART",
  trending: "CLIMBING",
  country: "COUNTRY",
  language: "LANGUAGE",
  tag: "GENRE",
};

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
  state.label = LABELS[kind];
  state.stations = [];
  state.loading = true;
  state.failed = false;
  state.empty = false;
  try {
    const stations = await searchStations({ kind, value }, 50);
    state.stations = stations.map((s, i) => ({ ...s, rank: String(i + 1).padStart(2, "0") }));
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
    label: "",
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
  .onAction("home", ({ context }) => {
    context?.router?.push("/");
  })
  .ui(
    screen(
      "StationList",
      `
${subHeader("@{state.title}", "@{state.subtitle}", "@{state.label}")}

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
${notice("radio", "Nothing we can tune", "No station here streams over HTTPS in a format every platform can play.", ["Back to Discover", ".onClick(@actions.home)"])}
          }
${stationRows("stations", true, "!state.loading && !state.failed && !state.empty")}
`,
    ),
  );
