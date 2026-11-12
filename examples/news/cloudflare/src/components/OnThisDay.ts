import { app } from "@hypen-space/core";
import { monthDay, pad2 } from "../format";
import { hub } from "../scope";
import { ACCENT, BORDER, DIM, MUTED, INSET, PAGE, SERIF, TEXT, skeletonRows } from "../theme";
import type { OtdEvent, OtdKind } from "../upstream";

type Kind = "selected" | OtdKind;

interface Entry extends OtdEvent {
  hasThumb: boolean;
  hasPage: boolean;
  /** Shared-element key: "wiki-hero" on the entry being opened, else "". */
  hero: string;
}

interface OtdState {
  dateLabel: string;
  kind: Kind;
  tabs: { id: Kind; label: string; active: boolean }[];
  events: Entry[];
  status: "loading" | "ready" | "error";
  countLabel: string;
}

const TABS: { id: Kind; label: string; active: boolean }[] = [
  { id: "selected", label: "Selected", active: true },
  { id: "events", label: "Events", active: false },
  { id: "births", label: "Births", active: false },
  { id: "deaths", label: "Deaths", active: false },
];

function markHero(state: OtdState, token: string) {
  for (const e of state.events) {
    const hero = token !== "" && e.id === token ? "wiki-hero" : "";
    if (e.hero !== hero) e.hero = hero;
  }
}

async function load(state: OtdState, kind: Kind) {
  const now = new Date();
  const month = pad2(now.getUTCMonth() + 1);
  const day = pad2(now.getUTCDate());
  try {
    const events =
      kind === "selected"
        ? (await hub().featured(now.toISOString().slice(0, 10))).onThisDay
        : await hub().onThisDay(kind, month, day);
    if (state.kind !== kind) return;
    state.events = events.map((e) => ({ ...e, hasThumb: e.thumb !== "", hasPage: e.title !== "", hero: "" }));
    state.countLabel = `${events.length} entries · newest first`;
    state.status = "ready";
  } catch (err) {
    console.warn("news: on this day failed:", err instanceof Error ? err.message : err);
    if (state.kind === kind) state.status = "error";
  }
}

export default app
  .module("OnThisDay")
  .defineState<OtdState>({
    dateLabel: monthDay(new Date()),
    kind: "selected",
    tabs: TABS.map((t) => ({ ...t })),
    events: [],
    status: "loading",
    countLabel: "",
  })
  .onActivated((state) => {
    markHero(state, "");
    const label = monthDay(new Date());
    if (label !== state.dateLabel || state.events.length === 0) {
      state.dateLabel = label;
      void load(state, state.kind);
    }
  })
  .onAction<{ kind: Kind }>("setKind", async ({ state, action }) => {
    const kind = action.payload?.kind;
    if (!kind || kind === state.kind || !TABS.some((t) => t.id === kind)) return;
    state.kind = kind;
    for (const t of state.tabs) t.active = t.id === kind;
    state.events = [];
    state.status = "loading";
    await load(state, kind);
  })
  .onAction("retry", async ({ state }) => {
    state.status = "loading";
    await load(state, state.kind);
  })
  .onAction<{ title: string; token: string }>("openWiki", ({ state, action, context }) => {
    const title = action.payload?.title;
    if (!title) return;
    markHero(state, action.payload?.token ?? "");
    context?.router?.push(`/wiki/${encodeURIComponent(title)}`);
  })
  .ui(`
    module OnThisDay {
      Column {
        Column {
          Text("ON THIS DAY").tw("text-[12px] font-semibold tracking-widest").color("${ACCENT}")
          Heading("@{state.dateLabel}", level: 1)
            .tw("text-[30px] md:text-[38px] font-bold tracking-tight mt-1")
            .fontFamily("${SERIF}")
            .color("${TEXT}")
          Text("@{state.countLabel}").tw("text-[12px] mt-1").color("${DIM}")
        }
        .tw("px-4 pt-6 pb-3")
        ${PAGE}

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
        .tw("px-4 pb-3 flex-row")
        ${PAGE}

        If(condition: "@{state.status == 'loading'}") {
          Column {
${skeletonRows(6)}
          }
          .exit(fade, duration: 150)
          ${PAGE}
        }

        If(condition: "@{state.status == 'error'}") {
          Column {
            Text("Wikipedia didn't answer (it rate-limits bursts).").tw("text-[14px]").color("${TEXT}")
            Button { Text("Try again").tw("text-[13px] font-semibold").color("#0E0E11") }
              .tw("mt-3 px-4 py-2 rounded-xl border-0")
              .backgroundColor("${ACCENT}")
              .onClick(@actions.retry)
          }
          .tw("my-4 p-4 rounded-2xl border items-start")
          .borderColor("${BORDER}")
          ${INSET}
        }

        // The timeline: a rail down the left, a dot per entry.
        Column {
          ForEach(items: @state.events, key: "id", as: "e") {
            Row {
              Column {
                Box {}
                  .tw("w-2.5 h-2.5 rounded-full mt-2 border-2")
                  .borderColor("${ACCENT}")
                  .backgroundColor("#0E0E11")
                Box {}.tw("w-px flex-1 mt-1").backgroundColor("rgba(255,122,26,0.25)")
              }
              .tw("w-2.5 items-center self-stretch mr-3 shrink-0")

              Button {
                Column {
                  Text("@{e.yearLabel}")
                    .tw("text-[20px] font-bold leading-none text-left")
                    .fontFamily("${SERIF}")
                    .color("${ACCENT}")
                  Row {
                    Column {
                      Text("@{e.text}")
                        .tw("text-[14px] leading-snug text-left")
                        .color("#DADAE0")
                      If(condition: @e.hasPage) {
                        Text("@{e.name} →").tw("text-[12px] mt-1.5 text-left").color("${MUTED}")
                      }
                    }
                    .tw("flex-1 min-w-0 items-start")
                    If(condition: @e.hasThumb) {
                      Image(src: "@{e.thumb}", alt: "@{e.name}")
                        .objectFit("cover")
                        .tw("w-16 h-16 rounded-xl ml-3 shrink-0 border")
                        .borderColor("${BORDER}")
                        .backgroundColor("#1A1A20")
                        .sharedElement("@{e.hero}", curve: spring, duration: 340)
                    }
                  }
                  .tw("mt-1.5 items-start w-full")
                }
                .tw("items-start w-full")
              }
              .tw("flex-1 min-w-0 bg-transparent border-0 p-0 pb-5 text-left")
              .opacity({ default: 1, active: 0.6 })
              .disabled("@{e.hasPage == false}")
              .label("@{e.yearLabel}: @{e.text}")
              .onClick(@actions.openWiki, title: "@{e.title}", token: "@{e.id}")
            }
            .tw("px-4 items-stretch")
            .enter(fade, slide, from: bottom, duration: 260)
            // An exit on every row also keeps tab switches on per-row Removes:
            // the published 0.6.7 engine collapses "every row went away" into
            // a clearChildren patch that the published generic client ignores
            // (see README, "Known issues").
            .exit(fade, duration: 120)
          }
        }
        .tw("pb-28")
        ${PAGE}
      }
      .scrollable(true)
      .tw("flex-1")
    }
  `);
