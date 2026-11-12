import { app } from "@hypen-space/core";
import { openStory, toggleSave } from "../actions";
import { mapLimit, plural } from "../format";
import { clearRead, currentScope, loadLibrary, refreshSaved } from "../scope";
import { toRows, type StoryRow } from "../stories";
import { ACCENT, BORDER, CARD, DIM, MUTED, INSET, PAGE, SERIF, TEXT, storyRow } from "../theme";
import { toStoryLite, type StoryLite } from "../upstream";

// Bookmarks and read history, persisted per visitor in their Durable Object
// (scope.ts). Unsaving a story removes its row with an exit animation.

interface SavedState {
  stories: StoryRow[];
  empty: boolean;
  ready: boolean;
  countLabel: string;
  readLabel: string;
  hasRead: boolean;
}

async function refresh(state: SavedState, live = false) {
  const scope = currentScope();
  let lib = await loadLibrary(scope);
  if (live && lib.saved.length > 0) {
    // Freshen scores/comment counts through the hub's cache (bounded).
    const fresh = await mapLimit(lib.saved.slice(0, 20), 4, (s) => scope.hub.story(s.id).catch(() => null));
    const lites = fresh.filter((x): x is NonNullable<typeof x> => !!x).map(toStoryLite);
    await refreshSaved(lites, scope);
    lib = await loadLibrary(scope);
  }
  const saved: StoryLite[] = lib.saved;
  state.stories = toRows(saved, lib).map((r) => ({ ...r, delta: "" }));
  state.empty = saved.length === 0;
  state.countLabel = saved.length === 0 ? "Nothing saved yet" : `${plural(saved.length, "story", "stories")} saved`;
  state.readLabel = `${plural(lib.readIds.size, "story", "stories")} marked read`;
  state.hasRead = lib.readIds.size > 0;
  state.ready = true;
}

export default app
  .module("Saved")
  .defineState<SavedState>({
    stories: [],
    empty: false,
    ready: false,
    countLabel: "",
    readLabel: "",
    hasRead: false,
  })
  .onActivated((state) => {
    void refresh(state, true).catch((err) => console.warn("news: saved refresh failed:", err));
  })
  .onAction<{ id: string }>("openStory", async ({ state, action, context }) => {
    await openStory(state.stories, action.payload?.id, context);
  })
  .onAction<{ id: string }>("toggleSave", async ({ state, action }) => {
    await toggleSave([state.stories], action.payload?.id);
    await refresh(state);
  })
  .onAction("clearRead", async ({ state }) => {
    await clearRead();
    await refresh(state);
  })
  .ui(`
    module Saved {
      Column {
        Column {
          Heading("Saved", level: 1)
            .tw("text-[30px] md:text-[38px] font-bold tracking-tight")
            .fontFamily("${SERIF}")
            .color("${TEXT}")
          Text("@{state.countLabel}").tw("text-[13px] mt-1").color("${MUTED}")
        }
        .tw("px-4 pt-6 pb-3")
        ${PAGE}

        If(condition: "@{state.ready && state.empty}") {
          Column {
            Icon(@resources.bookmark).size(28).color("${ACCENT}")
            Text("Your reading list is empty")
              .tw("text-[16px] font-semibold mt-3")
              .fontFamily("${SERIF}")
              .color("${TEXT}")
            Text("Tap the bookmark on any Hacker News story to keep it here. Saved stories live in your own Durable Object.")
              .tw("text-[13px] mt-1.5 text-center leading-snug")
              .color("${MUTED}")
            Button { Text("Browse Hacker News").tw("text-[13px] font-semibold").color("#0E0E11") }
              .tw("mt-5 px-4 py-2.5 rounded-xl border-0")
              .backgroundColor("${ACCENT}")
              .opacity({ default: 1, active: 0.7 })
              .onClick(@router.push, to: "/hn")
          }
          .tw("mt-4 p-7 rounded-3xl border items-center")
          .borderColor("${BORDER}")
          .backgroundColor("${CARD}")
          .enter(fade, duration: 260)
          .exit(fade, duration: 140)
          ${INSET}
        }

        Column {
          ForEach(items: @state.stories, key: "id", as: "s") {
${storyRow("s", { rank: false })}
          }
        }
        .tw("px-1")
        ${PAGE}

        If(condition: @state.hasRead) {
          Row {
            Text("@{state.readLabel}").tw("flex-1 text-[12px]").color("${DIM}")
            Button { Text("Clear history").tw("text-[12px] font-semibold").color("${ACCENT}") }
              .tw("bg-transparent border-0 p-1")
              .opacity({ default: 1, active: 0.5 })
              .onClick(@actions.clearRead)
          }
          .tw("mt-6 pt-4 border-t items-center")
          .borderColor("${BORDER}")
          ${INSET}
        }

        Box {}.tw("h-28")
      }
      .scrollable(true)
      .tw("flex-1")
    }
  `);
