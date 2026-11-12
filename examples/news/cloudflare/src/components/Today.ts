import { app } from "@hypen-space/core";
import { openStory, startPolling, stopPolling, toggleSave } from "../actions";
import { longDate } from "../format";
import { hub, loadLibrary } from "../scope";
import { toRows, type StoryRow } from "../stories";
import { ACCENT, BORDER, CARD, DIM, MUTED, INSET, PAGE, SERIF, TEXT, sectionHeader, skeletonRows, storyRow } from "../theme";
import type { FeaturedDigest, NewsItem, OtdEvent, WikiCard } from "../upstream";

// `hero` is the shared-element key: "wiki-hero" on exactly the thumbnail being
// opened, "" everywhere else. Precomputed per row rather than written as
// `state.openingId == n.id` in the template (see README: alias + state).
type NewsRow = NewsItem & { hasThumb: boolean; hero: string };
type CardRow = WikiCard & { hero: string };
type OtdRow = OtdEvent & { hasThumb: boolean };

interface TodayState {
  dateLabel: string;
  status: "loading" | "ready" | "error";
  hasPotd: boolean;
  potd: { title: string; thumb: string; aspect: number; caption: string; credit: string; page: string };
  news: NewsRow[];
  mostRead: CardRow[];
  otd: OtdRow[];
  top: StoryRow[];
  hnReady: boolean;
}

const EMPTY_POTD = { title: "", thumb: "", aspect: 1.5, caption: "", credit: "", page: "" };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's feed; parts that are not published yet fall back to yesterday's. */
async function loadDigest(): Promise<FeaturedDigest> {
  const now = new Date();
  const today = await hub().featured(isoDate(now)).catch(() => null);
  if (today && today.news.length > 0 && today.mostRead.length > 0 && today.potd) return today;
  const yesterday = await hub()
    .featured(isoDate(new Date(now.getTime() - 86_400_000)))
    .catch(() => null);
  if (!today && !yesterday) throw new Error("Wikipedia feed unavailable");
  return {
    date: (today ?? yesterday)!.date,
    potd: today?.potd ?? yesterday?.potd ?? null,
    news: today?.news.length ? today.news : yesterday?.news ?? [],
    mostRead: today?.mostRead.length ? today.mostRead : yesterday?.mostRead ?? [],
    onThisDay: today?.onThisDay.length ? today.onThisDay : yesterday?.onThisDay ?? [],
  };
}

/** Give exactly one thumbnail (or none) the shared-element key. */
function markHero(state: TodayState, token: string) {
  for (const n of state.news) {
    const hero = token !== "" && n.id === token ? "wiki-hero" : "";
    if (n.hero !== hero) n.hero = hero;
  }
  for (const a of state.mostRead) {
    const hero = token !== "" && a.title === token ? "wiki-hero" : "";
    if (a.hero !== hero) a.hero = hero;
  }
}

async function refreshTop(state: TodayState) {
  const [list, lib] = await Promise.all([hub().list("top"), loadLibrary()]);
  state.top = toRows(list.stories.slice(0, 6), lib, state.top);
  state.hnReady = true;
}

async function refreshWiki(state: TodayState) {
  try {
    const d = await loadDigest();
    if (d.potd) {
      state.potd = {
        title: d.potd.title,
        thumb: d.potd.thumb,
        aspect: Math.max(0.75, Math.min(2.2, d.potd.width / Math.max(1, d.potd.height))),
        caption: d.potd.caption,
        credit: d.potd.credit,
        page: d.potd.page,
      };
      state.hasPotd = true;
    }
    state.news = d.news.slice(0, 5).map((n) => ({ ...n, hasThumb: n.thumb !== "", hero: "" }));
    state.mostRead = d.mostRead.slice(0, 10).map((a) => ({ ...a, hero: "" }));
    state.otd = d.onThisDay.slice(0, 3).map((e) => ({ ...e, hasThumb: e.thumb !== "" }));
    state.status = "ready";
  } catch (err) {
    console.warn("news: today feed failed:", err instanceof Error ? err.message : err);
    if (state.status === "loading") state.status = "error";
  }
}

export default app
  .module("Today")
  .defineState<TodayState>({
    dateLabel: longDate(new Date()),
    status: "loading",
    hasPotd: false,
    potd: EMPTY_POTD,
    news: [],
    mostRead: [],
    otd: [],
    top: [],
    hnReady: false,
  })
  .onActivated(async (state) => {
    markHero(state, "");
    state.dateLabel = longDate(new Date());
    // Never hold the first render behind upstream requests: Wikipedia and
    // HN load in parallel after activation and each half renders as it lands.
    void refreshWiki(state);
    void refreshTop(state).catch(() => undefined);
    startPolling(state, 15_000, () => refreshTop(state));
  })
  .onDeactivated((state) => stopPolling(state))
  .onDestroyed((state) => stopPolling(state))
  .onAction<{ id: string }>("openStory", async ({ state, action, context }) => {
    await openStory(state.top, action.payload?.id, context);
  })
  .onAction<{ id: string }>("toggleSave", async ({ state, action }) => {
    await toggleSave([state.top], action.payload?.id);
  })
  .onAction<{ title: string; token: string }>("openWiki", ({ state, action, context }) => {
    const title = action.payload?.title;
    if (!title) return;
    // Synchronous mark, then push — see movie-discovery's Home for why the
    // shared-element source must be resolved before the navigation batch.
    markHero(state, action.payload?.token ?? "");
    context?.router?.push(`/wiki/${encodeURIComponent(title)}`);
  })
  .onAction("retry", async ({ state }) => {
    state.status = "loading";
    await refreshWiki(state);
  })
  .ui(`
    module Today {
      Column {
        // Masthead
        Column {
          Text("@{state.dateLabel}")
            .tw("text-[12px] font-semibold uppercase tracking-widest")
            .color("${ACCENT}")
          Heading("The Daily Hypen", level: 1)
            .tw("text-[30px] md:text-[38px] font-bold tracking-tight mt-1")
            .fontFamily("${SERIF}")
            .color("${TEXT}")
          Text("Wikipedia's front page and Hacker News, live.")
            .tw("text-[13px] mt-1")
            .color("${MUTED}")
        }
        .tw("px-4 pt-6 pb-2")
        ${PAGE}

        If(condition: "@{state.status == 'error'}") {
          Column {
            Text("Wikipedia's feed is unavailable right now.")
              .tw("text-[14px]")
              .color("${TEXT}")
            Button { Text("Try again").tw("text-[13px] font-semibold").color("#0E0E11") }
              .tw("mt-3 px-4 py-2 rounded-xl border-0")
              .backgroundColor("${ACCENT}")
              .onClick(@actions.retry)
          }
          .tw("mt-4 p-4 rounded-2xl border items-start")
          .borderColor("${BORDER}")
          .backgroundColor("${CARD}")
          ${INSET}
        }

        // Picture of the day
        If(condition: @state.hasPotd) {
          Column {
          Link(href: "@{state.potd.page}", target: "_blank", rel: "noopener noreferrer") {
            Column {
              Image(src: "@{state.potd.thumb}", alt: "@{state.potd.caption}")
                .objectFit("cover")
                .aspectRatio("@{state.potd.aspect}")
                .maxHeight(300)
                .tw("w-full")
                .backgroundColor("#1A1A20")
              Column {
                Row {
                  Icon(@resources.image).size(13).color("${ACCENT}")
                  Text("PICTURE OF THE DAY")
                    .tw("text-[10px] font-bold tracking-widest ml-1.5")
                    .color("${ACCENT}")
                }
                .tw("items-center")
                Text("@{state.potd.caption}")
                  .tw("text-[14px] leading-snug mt-2")
                  .fontFamily("${SERIF}")
                  .color("${TEXT}")
                  .maxLines(3)
                Text("@{state.potd.credit}")
                  .tw("text-[11px] mt-1.5")
                  .color("${DIM}")
                  .maxLines(1)
              }
              .tw("p-4")
            }
            .tw("rounded-3xl overflow-hidden border")
            .borderColor("${BORDER}")
            .backgroundColor("${CARD}")
          }
          .tw("block no-underline w-full")
          .label("Picture of the day: @{state.potd.caption}")
          }
          .tw("px-4 mt-4")
          .enter(fade, duration: 400)
          ${PAGE}
        }

        If(condition: "@{state.status == 'loading'}") {
          Column {
            Box {}.tw("w-full rounded-3xl aspect-[3/2]").backgroundColor("rgba(255,255,255,0.05)").animate(shimmer)
${skeletonRows(3)}
          }
          .tw("px-4 mt-4")
          .exit(fade, duration: 160)
          ${PAGE}
        }

        // In the news
        If(condition: "@{length(state.news) > 0}") {
          ${sectionHeader("In the news")}
        }
        Column {
          ForEach(items: @state.news, key: "id", as: "n") {
            Button {
              Row {
                If(condition: @n.hasThumb) {
                  Image(src: "@{n.thumb}", alt: "@{n.title}")
                    .objectFit("cover")
                    .tw("w-14 h-14 rounded-xl shrink-0 mr-3 border")
                    .borderColor("${BORDER}")
                    .backgroundColor("#1A1A20")
                    .sharedElement("@{n.hero}", curve: spring, duration: 340)
                }
                Text("@{n.text}")
                  .tw("flex-1 text-[14px] leading-snug text-left")
                  .color("#DADAE0")
                  .maxLines(4)
              }
              .tw("items-start w-full")
            }
            .tw("w-full px-3 py-3 rounded-2xl border-0 text-left")
            .backgroundColor("rgba(255,255,255,0)")
            .opacity({ default: 1, active: 0.6 })
            .label("@{n.text}")
            .onClick(@actions.openWiki, title: "@{n.title}", token: "@{n.id}")
            .enter(fade, duration: 300)
            .exit(fade, duration: 120)
          }
        }
        .tw("px-1")
        ${PAGE}

        // Most read
        If(condition: "@{length(state.mostRead) > 0}") {
          ${sectionHeader("Most read yesterday")}
        }
        Row {
          ForEach(items: @state.mostRead, key: "title", as: "a") {
            Button {
              Column {
                Image(src: "@{a.thumb}", alt: "@{a.name}")
                  .objectFit("cover")
                  .tw("w-[150px] h-[104px] rounded-2xl border")
                  .borderColor("${BORDER}")
                  .backgroundColor("#1E1E25")
                  .sharedElement("@{a.hero}", curve: spring, duration: 340)
                Row {
                  Text("@{a.rank}")
                    .tw("text-[13px] font-bold mr-1.5")
                    .fontFamily("${SERIF}")
                    .color("${ACCENT}")
                  Text("@{a.meta}").tw("text-[11px]").color("${DIM}")
                }
                .tw("mt-2 items-center")
                Text("@{a.name}")
                  .tw("w-[150px] text-[13px] font-semibold leading-snug mt-0.5 text-left")
                  .color("${TEXT}")
                  .maxLines(2)
              }
              .tw("items-start")
            }
            .tw("mr-3 shrink-0 bg-transparent border-0 p-0")
            .opacity({ default: 1, active: 0.6 })
            .onClick(@actions.openWiki, title: "@{a.title}", token: "@{a.title}")
            .enter(fade, duration: 300)
            .exit(fade, duration: 120)
          }
        }
        .scrollable("horizontal")
        .tw("px-4 flex-row")
        ${PAGE}

        // Top of Hacker News, live
        ${sectionHeader("Top on Hacker News", "/hn", "Updates live as stories climb")}
        If(condition: "@{state.hnReady == false}") {
          Column {
${skeletonRows(4)}
          }
          ${PAGE}
        }
        Column {
          ForEach(items: @state.top, key: "id", as: "s") {
${storyRow("s")}
          }
        }
        .tw("px-1")
        ${PAGE}

        // On this day teaser
        If(condition: "@{length(state.otd) > 0}") {
          ${sectionHeader("On this day", "/onthisday")}
        }
        Column {
          ForEach(items: @state.otd, key: "id", as: "e") {
            Row {
              Text("@{e.yearLabel}")
                .tw("w-14 shrink-0 text-[17px] font-bold")
                .fontFamily("${SERIF}")
                .color("${ACCENT}")
              Text("@{e.text}")
                .tw("flex-1 text-[14px] leading-snug")
                .color("#DADAE0")
                .maxLines(3)
            }
            .tw("px-4 py-2.5 items-start")
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
