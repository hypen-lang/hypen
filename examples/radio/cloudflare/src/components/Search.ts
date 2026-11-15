import { app } from "@hypen-space/core";
import { searchStations, type Station } from "../radio-browser";
import { back, openStation, play } from "../screen-actions";
import { C, MONO, errorCard, kicker, notice, screen, skeletonRows, stationRows } from "../ui";

// /search — station name search against Radio Browser, debounced on input.

interface SearchState {
  query: string;
  results: Station[];
  searching: boolean;
  failed: boolean;
  error: string;
  hint: string;
  hintTitle: string;
  /** Nothing typed yet: show the suggestions. */
  idle: boolean;
  /** "12 STATIONS" over the results. */
  count: string;
  suggestions: { id: string; name: string }[];
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
  state.idle = q === "";
  state.count = "";
  if (q.length < 2) {
    state.results = [];
    state.searching = false;
    state.hintTitle = "Keep typing";
    state.hint = q ? "A station name needs at least two letters." : "";
    return;
  }
  state.searching = true;
  state.hint = "";
  try {
    const results = await searchStations({ kind: "top", name: q }, 40);
    if (my !== state.seq) return;
    state.results = results;
    state.count = results.length ? `${results.length} ${results.length === 1 ? "STATION" : "STATIONS"}` : "";
    state.hintTitle = "No match";
    state.hint = results.length ? "" : `No playable station is called “${q}”. Check the spelling, or try part of the name.`;
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
    hint: "",
    hintTitle: "",
    idle: true,
    count: "",
    suggestions: ["Jazz", "BBC", "Lofi", "Classic rock", "News", "Reggae", "KEXP", "Deep house"].map((name) => ({ id: name, name })),
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
    state.hint = "";
    state.idle = true;
    state.count = "";
  })
  // A suggestion chip: fill the box and search straight away.
  .onAction<{ q?: string }>("suggest", async ({ action, state }) => {
    if (!action.payload?.q) return;
    state.query = action.payload.q;
    await run(state, true);
  })
  .onAction("play", play)
  .onAction("openStation", openStation)
  .onAction("back", back)
  .ui(
    screen(
      "Search",
      `
          Heading("Search", level: 1)
            .tw("text-[44px] font-black text-left leading-none tracking-tight pt-6 mb-5 w-full")
            .color("${C.text}")

          Row {
            Icon(@resources.search)
              .size(18)
              .color("${C.text}")
            Input(placeholder: "Station name")
              .bind(@state.query)
              .onInput(@actions.typed)
              .onKey(@actions.submit)
              .label("Search stations")
              .tw("flex-1 min-w-0 h-[52px] ml-3 text-base bg-transparent border-0")
              .color("${C.text}")
            If(condition: "@{state.query != ''}") {
              Button {
                Icon(@resources.x)
                  .size(16)
                  .color("${C.text}")
              }
              .tw("w-8 h-8 rounded-full border-0 items-center justify-center shrink-0 p-0")
              .backgroundColor("${C.raised}")
              .onClick(@actions.clear)
              .label("Clear search")
            }
          }
          .tw("w-full pl-5 pr-3 rounded-full items-center")
          .backgroundColor("${C.surface}")
          .border("1px solid ${C.lineStrong}")

          If(condition: "@{state.idle}") {
            Column {
${kicker("TRY ONE OF THESE", C.faint, "mb-3")}
              Grid(@state.suggestions, key: "id") {
                Button {
                  Row {
                    Text("@{item.name}")
                      .tw("flex-1 min-w-0 text-[15px] font-bold text-left")
                      .color("${C.text}")
                      .maxLines(1)
                      .textOverflow("ellipsis")
                    Icon(@resources.arrow-right)
                      .size(16)
                      .color("${C.faint}")
                  }
                  .tw("items-center w-full")
                }
                .tw("h-[52px] px-4 rounded-[16px] items-stretch justify-center min-w-0")
                .border("1px solid ${C.line}")
                .backgroundColor({ default: "${C.surface}", hover: "${C.raised}" })
                .opacity({ default: 1, active: 0.6 })
                .onClick(@actions.suggest, q: "@{item.name}")
              }
              .gridColumns({ default: 2, md: 4 })
              .tw("gap-2.5 w-full")
              Text("Search looks at station names in the Radio Browser directory. For a whole genre, country or language, browse from Discover.")
                .tw("text-[13px] mt-6 text-left leading-5")
                .color("${C.muted}")
            }
            .tw("w-full mt-7 items-start")
          }

          If(condition: "@{state.searching}") {
            Column {
${skeletonRows(6)}
            }
            .tw("w-full mt-4")
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }
          If(condition: "@{state.hint != ''}") {
            Column {
${notice("search", "@{state.hintTitle}", "@{state.hint}")}
            }
            .tw("w-full mt-3")
          }
          If(condition: "@{state.count != ''}") {
            Text("@{state.count}")
              .tw("text-[11px] font-bold tracking-widest text-left mt-6 mb-1 w-full")
              ${MONO}
              .color("${C.faint}")
          }
          Column {
${stationRows("results", false, "state.count != ''")}
          }
          .tw("w-full mt-1")
`,
    ),
  );
