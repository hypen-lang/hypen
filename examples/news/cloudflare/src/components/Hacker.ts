import { app } from "@hypen-space/core";
import { openStory, startPolling, stopPolling, toggleSave } from "../actions";
import { plural } from "../format";
import { hub, loadLibrary, refreshSaved } from "../scope";
import { toRows, type StoryRow } from "../stories";
import { ACCENT, BORDER, DIM, MUTED, INSET, PAGE, SERIF, TEXT, skeletonRows, storyRow } from "../theme";
import { HN_KINDS, type HnKind } from "../upstream";

// The HN lists, live. While this screen is on, the module re-reads its list
// from the shared NewsHub every POLL_MS (the hub itself hits HN at most every
// 20 s, for everyone) and rewrites `stories`. The keyed reconciler turns that
// into Move / SetProp / Insert / Remove patches, so re-ranked rows glide
// (`.layout(spring)`), new entrants slide in and drop-outs fade.

const POLL_MS = 10_000;

const TAB_LABELS: Record<HnKind, string> = {
  top: "Top",
  new: "New",
  best: "Best",
  ask: "Ask",
  show: "Show",
  job: "Jobs",
};

interface Tab {
  id: HnKind;
  label: string;
  /** Precomputed: see the README's note on alias + state expressions. */
  active: boolean;
}

interface HackerState {
  kind: HnKind;
  tabs: Tab[];
  stories: StoryRow[];
  status: "loading" | "ready" | "error";
  liveLabel: string;
  changeLabel: string;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

async function refresh(state: HackerState, kind: HnKind = state.kind) {
  const [list, lib] = await Promise.all([hub().list(kind), loadLibrary()]);
  if (state.kind !== kind) return; // the user switched tabs meanwhile
  const prev = state.stories;
  const next = toRows(list.stories, lib, prev);
  const moved = next.filter((r) => r.delta.startsWith("▲") || r.delta.startsWith("▼")).length;
  const entered = next.filter((r) => r.delta === "NEW").length;
  const bumped = next.filter((r) => r.bumped).length;
  state.stories = next;
  state.status = "ready";
  state.liveLabel = `Live · synced ${clock(list.fetchedAt)} UTC`;
  if (prev.length > 0) {
    const parts = [
      moved && `${moved} moved`,
      entered && `${entered} new`,
      bumped && plural(bumped, "score update"),
    ].filter(Boolean);
    state.changeLabel = parts.length ? parts.join(" · ") : "No changes";
  }
  void refreshSaved(list.stories);
}

async function show(state: HackerState) {
  try {
    await refresh(state);
  } catch (err) {
    console.warn("news: HN list failed:", err instanceof Error ? err.message : err);
    if (state.stories.length === 0) state.status = "error";
  }
}

export default app
  .module("Hacker")
  .defineState<HackerState>({
    kind: "top",
    tabs: HN_KINDS.map((id) => ({ id, label: TAB_LABELS[id], active: id === "top" })),
    stories: [],
    status: "loading",
    liveLabel: "Connecting…",
    changeLabel: "",
  })
  .onActivated(async (state) => {
    void show(state);
    startPolling(state, POLL_MS, () => refresh(state));
  })
  .onDeactivated((state) => stopPolling(state))
  .onDestroyed((state) => stopPolling(state))
  .onAction<{ kind: HnKind }>("setKind", async ({ state, action }) => {
    const kind = action.payload?.kind;
    if (!kind || !HN_KINDS.includes(kind) || kind === state.kind) return;
    state.kind = kind;
    for (const t of state.tabs) t.active = t.id === kind;
    state.stories = [];
    state.status = "loading";
    state.changeLabel = "";
    await show(state);
  })
  .onAction<{ id: string }>("openStory", async ({ state, action, context }) => {
    await openStory(state.stories, action.payload?.id, context);
  })
  .onAction<{ id: string }>("toggleSave", async ({ state, action }) => {
    await toggleSave([state.stories], action.payload?.id);
  })
  .onAction("retry", async ({ state }) => {
    state.status = "loading";
    await show(state);
  })
  .ui(`
    module Hacker {
      Column {
        Column {
          Row {
            Heading("Hacker News", level: 1)
              .tw("flex-1 text-[26px] md:text-[32px] font-bold tracking-tight")
              .fontFamily("${SERIF}")
              .color("${TEXT}")
            Row {
              Box {}
                .tw("w-2 h-2 rounded-full")
                .backgroundColor("#34D399")
                .animate(pulse, repeat: loop, duration: 1600)
              Text("LIVE").tw("text-[10px] font-bold tracking-widest ml-1.5").color("#34D399")
            }
            .tw("items-center px-2.5 py-1 rounded-full border")
            .borderColor("rgba(52, 211, 153, 0.35)")
          }
          .tw("items-center")
          Text("@{state.liveLabel}")
            .tw("text-[12px] mt-1")
            .color("${DIM}")
          Text("@{state.changeLabel}")
            .tw("text-[12px] mt-0.5")
            .color("${MUTED}")
            .liveRegion("polite")
            .transition(300, easeOut)
        }
        .tw("px-4 pt-6 pb-3")
        ${PAGE}

        // Tabs
        Row {
          ForEach(items: @state.tabs, key: "id", as: "t") {
            Button {
              Text("@{t.label}")
                .tw("text-[13px] font-semibold")
                .color("@{t.active ? '#0E0E11' : '#C9C9D1'}")
            }
            .tw("mr-2 px-3.5 py-1.5 rounded-full border shrink-0")
            .backgroundColor("@{t.active ? '${ACCENT}' : 'rgba(255,255,255,0.04)'}")
            .borderColor("@{t.active ? '${ACCENT}' : '${BORDER}'}")
            .transition(200, easeOut)
            .opacity({ default: 1, active: 0.6 })
            .onClick(@actions.setKind, kind: "@{t.id}")
          }
        }
        .scrollable("horizontal")
        .tw("px-4 pb-2 flex-row")
        ${PAGE}

        If(condition: "@{state.status == 'error'}") {
          Column {
            Text("Couldn't reach Hacker News.").tw("text-[14px]").color("${TEXT}")
            Button { Text("Try again").tw("text-[13px] font-semibold").color("#0E0E11") }
              .tw("mt-3 px-4 py-2 rounded-xl border-0")
              .backgroundColor("${ACCENT}")
              .onClick(@actions.retry)
          }
          .tw("my-4 p-4 rounded-2xl border items-start")
          .borderColor("${BORDER}")
          ${INSET}
        }

        If(condition: "@{state.status == 'loading'}") {
          Column {
${skeletonRows(8)}
          }
          .exit(fade, duration: 150)
          ${PAGE}
        }

        Column {
          ForEach(items: @state.stories, key: "id", as: "s") {
${storyRow("s")}
          }
        }
        .tw("px-1 pb-28")
        ${PAGE}
      }
      .scrollable(true)
      .tw("flex-1")
    }
  `);
