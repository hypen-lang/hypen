import { app } from "@hypen-space/core";
import { searchStations, type Station } from "../radio-browser";
import { back, openStation, play } from "../screen-actions";
import { C, errorCard, screen, skeletonRows, stationRows } from "../ui";

// /search — station name search against Radio Browser, debounced on input.

interface SearchState {
  query: string;
  results: Station[];
  searching: boolean;
  failed: boolean;
  error: string;
  hint: string;
  /** Debounce generation (never rendered). */
  seq: number;
  lastQuery: string;
}

const DEBOUNCE_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(state: SearchState, immediate: boolean) {
  const my = ++state.seq;
  if (!immediate) await sleep(DEBOUNCE_MS);
  if (my !== state.seq) return; // a newer keystroke superseded this one
  const q = state.query.trim();
  if (q === state.lastQuery && !state.failed) return;
  state.lastQuery = q;
  state.failed = false;
  if (q.length < 2) {
    state.results = [];
    state.searching = false;
    state.hint = "Type at least two letters of a station name.";
    return;
  }
  state.searching = true;
  state.hint = "";
  try {
    const results = await searchStations({ kind: "top", name: q }, 40);
    if (my !== state.seq) return;
    state.results = results;
    state.hint = results.length ? "" : `No playable stations match “${q}”.`;
  } catch (err) {
    if (my !== state.seq) return;
    state.failed = true;
    state.error = `Search failed (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    if (my === state.seq) state.searching = false;
  }
}

export default app
  .module("Search")
  .defineState<SearchState>({
    query: "",
    results: [],
    searching: false,
    failed: false,
    error: "",
    hint: "Search by station name — e.g. “jazz”, “BBC”, “lofi”.",
    seq: 0,
    lastQuery: "",
  })
  .onAction("typed", async ({ state }) => run(state, false))
  .onAction("submit", async ({ state }) => run(state, true))
  .onAction("retry", async ({ state }) => run(state, true))
  .onAction("clear", ({ state }) => {
    state.seq++;
    state.query = "";
    state.lastQuery = "";
    state.results = [];
    state.searching = false;
    state.hint = "Search by station name — e.g. “jazz”, “BBC”, “lofi”.";
  })
  .onAction("play", play)
  .onAction("openStation", openStation)
  .onAction("back", back)
  .ui(
    screen(
      "Search",
      `
          Heading("Search", level: 1)
            .tw("text-[26px] font-bold text-left pt-6 pb-4")
            .color("${C.text}")

          Row {
            Icon(@resources.search)
              .size(16)
              .color("${C.muted}")
            Input(placeholder: "Station name")
              .bind(@state.query)
              .onInput(@actions.typed)
              .onKey(@actions.submit)
              .label("Search stations")
              .tw("flex-1 min-w-0 h-11 ml-2.5 text-sm bg-transparent border-0")
              .color("${C.text}")
            If(condition: "@{state.query != ''}") {
              Button {
                Icon(@resources.x)
                  .size(16)
                  .color("${C.muted}")
              }
              .tw("w-8 h-8 rounded-full border-0 items-center justify-center bg-transparent")
              .onClick(@actions.clear)
              .label("Clear search")
            }
          }
          .tw("w-full px-4 rounded-xl items-center")
          .backgroundColor("${C.surface}")
          .border("1px solid ${C.line}")

          If(condition: "@{state.searching}") {
            Column {
${skeletonRows(6)}
            }
            .tw("w-full mt-2")
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }
          If(condition: "@{state.hint != ''}") {
            Text("@{state.hint}")
              .tw("text-sm py-10 text-center")
              .color("${C.muted}")
          }
          Column {
${stationRows("results")}
          }
          .tw("w-full mt-2")
`,
    ),
  );
