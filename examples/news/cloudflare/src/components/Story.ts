import { app } from "@hypen-space/core";
import { startPolling, stopPolling } from "../actions";
import { CommentTree, TOP_PAGE, type CommentRow } from "../comments";
import { compact, domainOf, plural, timeAgo } from "../format";
import { htmlToRichText, type TextLink } from "../html";
import { currentScope, hub, loadLibrary, markRead, toggleSaved } from "../scope";
import { ACCENT, BORDER, CARD, DIM, MUTED, INSET, PAGE, SERIF, TEXT, skeletonRows } from "../theme";
import { hnUrl, toStoryLite, type HnItem } from "../upstream";

// One story and its comment thread. The tree (comments.ts) lives server
// side; the template renders its visible slice as one flat keyed list.

interface StoryHeader {
  id: string;
  title: string;
  url: string;
  hnUrl: string;
  domain: string;
  scoreLabel: string;
  commentsLabel: string;
  byline: string;
  text: string;
  links: TextLink[];
  hasText: boolean;
  hasLinks: boolean;
  hasUrl: boolean;
  saved: boolean;
}

interface StoryState {
  status: "loading" | "ready" | "missing";
  story: StoryHeader;
  comments: CommentRow[];
  commentsStatus: "idle" | "loading" | "ready";
  hasMore: boolean;
  moreLabel: string;
  loadingMore: boolean;
  noComments: boolean;
}

const EMPTY: StoryHeader = {
  id: "",
  title: "",
  url: "",
  hnUrl: "",
  domain: "",
  scoreLabel: "",
  commentsLabel: "",
  byline: "",
  text: "",
  links: [],
  hasText: false,
  hasLinks: false,
  hasUrl: false,
  saved: false,
};

const trees = new WeakMap<object, CommentTree>();
/** The story id each instance is currently opening (drops stale loads). */
const opening = new WeakMap<object, number>();

function header(item: HnItem, saved: boolean): StoryHeader {
  const rich = htmlToRichText(item.text);
  const isJob = item.type === "job";
  return {
    id: String(item.id),
    title: toStoryLite(item).title,
    url: item.url ?? hnUrl(item.id),
    hnUrl: hnUrl(item.id),
    domain: item.url ? domainOf(item.url) : "news.ycombinator.com",
    scoreLabel: isJob ? "Job posting" : `${compact(item.score ?? 0)} points`,
    commentsLabel: isJob ? "" : plural(item.descendants ?? 0, "comment"),
    byline: [item.by && `by ${item.by}`, item.time && `${timeAgo(item.time)} ago`].filter(Boolean).join(" · "),
    text: rich.text,
    links: rich.links,
    hasText: rich.text !== "",
    hasLinks: rich.links.length > 0,
    hasUrl: !!item.url,
    saved,
  };
}

function render(state: StoryState, tree: CommentTree) {
  if (trees.get(state) !== tree) return; // a newer story replaced this tree
  state.comments = tree.flatten();
  state.hasMore = tree.remaining > 0;
  state.moreLabel = `Show ${Math.min(TOP_PAGE, tree.remaining)} more of ${tree.remaining} threads`;
  state.noComments = tree.topIds.length === 0;
}

async function loadTopPage(state: StoryState, tree: CommentTree) {
  const ids = tree.nextTopPage();
  if (ids.length === 0) return;
  const items = await hub().comments(ids);
  tree.showTop(items, ids.length);
  render(state, tree);
}

async function expand(state: StoryState, tree: CommentTree, id: number) {
  const kids = tree.needsFetch(id);
  if (kids === null) {
    tree.toggleReplies(id);
    render(state, tree);
    return;
  }
  tree.setLoading(id, true);
  render(state, tree);
  const replies = await hub().comments(kids);
  tree.attach(id, replies);
  render(state, tree);
}

async function open(state: StoryState, id: number) {
  opening.set(state, id);
  const stale = () => opening.get(state) !== id;
  trees.delete(state);
  state.status = "loading";
  state.story = EMPTY;
  state.comments = [];
  state.hasMore = false;
  state.noComments = false;
  state.commentsStatus = "idle";
  const scope = currentScope();
  const [item, lib] = await Promise.all([scope.hub.story(id), loadLibrary(scope)]);
  if (stale()) return;
  if (!item || item.deleted) {
    state.status = "missing";
    return;
  }
  state.story = header(item, lib.savedIds.has(id));
  state.status = "ready";
  void markRead(id, scope);

  const tree = new CommentTree(id, item.by ?? "", item.kids ?? []);
  trees.set(state, tree);
  state.commentsStatus = "loading";
  await loadTopPage(state, tree);
  if (stale()) return;
  // Open the first two threads one level deep so the tree reads as a tree;
  // everything deeper waits for a tap.
  const first = tree.topIds.slice(0, 2).filter((t) => tree.has(t));
  await Promise.all(first.map((t) => (tree.needsFetch(t)?.length ? expand(state, tree, t) : undefined)));
  render(state, tree);
  state.commentsStatus = "ready";
}

/** Live score/comment-count refresh for the open story. */
async function refreshHeader(state: StoryState) {
  const id = Number(state.story.id);
  if (!id) return;
  const item = await hub().story(id);
  if (!item || String(item.id) !== state.story.id) return;
  const next = header(item, state.story.saved);
  if (next.scoreLabel !== state.story.scoreLabel) state.story.scoreLabel = next.scoreLabel;
  if (next.commentsLabel !== state.story.commentsLabel) state.story.commentsLabel = next.commentsLabel;
}

function routeId(context: { router?: { getCurrentPath(): string; matchPath(p: string, path: string): { params: Record<string, string> } | null } | null } | undefined): number {
  const path = context?.router?.getCurrentPath() ?? "";
  const match = context?.router?.matchPath("/story/:id", path);
  return Number(match?.params.id ?? 0);
}

export default app
  .module("Story")
  .defineState<StoryState>({
    status: "loading",
    story: EMPTY,
    comments: [],
    commentsStatus: "idle",
    hasMore: false,
    moreLabel: "",
    loadingMore: false,
    noComments: false,
  })
  .onActivated(async (state, context) => {
    const id = routeId(context ?? undefined);
    if (!id) {
      state.status = "missing";
      return;
    }
    // Same story as last time (route cache): keep the expanded tree.
    if (opening.get(state) !== id || state.status === "missing") {
      void open(state, id).catch((err) => {
        console.warn("news: story load failed:", err instanceof Error ? err.message : err);
        state.status = "missing";
      });
    }
    startPolling(state, 20_000, () => refreshHeader(state));
  })
  .onDeactivated((state) => stopPolling(state))
  .onDestroyed((state) => stopPolling(state))
  .onAction("back", ({ context }) => {
    const router = context?.router;
    if (!router) return;
    const before = router.getCurrentPath();
    router.back();
    if (router.getCurrentPath() === before) router.push("/hn");
  })
  .onAction<{ id: string }>("toggleReplies", async ({ state, action }) => {
    const tree = trees.get(state);
    const id = Number(action.payload?.id);
    if (!tree || !id) return;
    await expand(state, tree, id);
  })
  .onAction<{ id: string }>("toggleCollapse", ({ state, action }) => {
    const tree = trees.get(state);
    const id = Number(action.payload?.id);
    if (!tree || !id) return;
    tree.toggleCollapse(id);
    render(state, tree);
  })
  .onAction("loadMore", async ({ state }) => {
    const tree = trees.get(state);
    if (!tree || state.loadingMore) return;
    state.loadingMore = true;
    try {
      await loadTopPage(state, tree);
    } finally {
      state.loadingMore = false;
    }
  })
  .onAction("toggleSave", async ({ state }) => {
    const id = Number(state.story.id);
    const item = id ? await hub().story(id) : null;
    if (!item) return;
    state.story.saved = await toggleSaved(toStoryLite(item));
  })
  .ui(`
    module Story {
      Column {
        // Top bar
        Row {
          Button {
            Icon(@resources.chevron-left).size(20).color("${TEXT}")
          }
          .tw("w-10 h-10 rounded-full border items-center justify-center")
          .borderColor("${BORDER}")
          .backgroundColor("rgba(255,255,255,0.06)")
          .opacity({ default: 1, active: 0.6 })
          .label("Back")
          .onClick(@actions.back)

          Text("@{state.story.domain}")
            .tw("flex-1 text-center text-[13px] font-medium truncate px-3")
            .color("${MUTED}")

          Button {
            Icon(@resources.bookmark).size(18).color("@{state.story.saved ? '${ACCENT}' : '${TEXT}'}")
          }
          .tw("w-10 h-10 rounded-full border items-center justify-center")
          .borderColor("@{state.story.saved ? 'rgba(255,122,26,0.45)' : '${BORDER}'}")
          .backgroundColor("@{state.story.saved ? 'rgba(255,122,26,0.14)' : 'rgba(255,255,255,0.06)'}")
          .transition(220, easeOut)
          .opacity({ default: 1, active: 0.6 })
          .label("@{state.story.saved ? 'Remove bookmark' : 'Bookmark'}")
          .onClick(@actions.toggleSave, animate: spring)
        }
        .tw("px-4 pt-5 pb-3 items-center")
        ${PAGE}

        If(condition: "@{state.status == 'missing'}") {
          Text("This story isn't available.").tw("px-4 py-10 text-center text-[14px]").color("${MUTED}")
        }

        If(condition: "@{state.status == 'loading'}") {
          Column {
${skeletonRows(5)}
          }
          .exit(fade, duration: 150)
          ${PAGE}
        }

        If(condition: "@{state.status == 'ready'}") {
          Column {
            Heading("@{state.story.title}", level: 1)
              .tw("text-[24px] md:text-[30px] font-bold leading-tight tracking-tight")
              .fontFamily("${SERIF}")
              .color("${TEXT}")
            Row {
              Icon(@resources.arrow-up).size(14).color("${ACCENT}")
              Text("@{state.story.scoreLabel}")
                .tw("text-[13px] font-semibold ml-1")
                .color("${ACCENT}")
                .transition(300, easeOut)
              Text("@{state.story.commentsLabel}").tw("text-[13px] ml-3").color("${MUTED}")
            }
            .tw("mt-3 items-center")
            Text("@{state.story.byline}").tw("text-[12px] mt-1").color("${DIM}")

            If(condition: @state.story.hasText) {
              Text("@{state.story.text}")
                .tw("text-[15px] leading-relaxed mt-4")
                .whiteSpace("pre-wrap")
                .overflowWrap("anywhere")
                .color("#DADAE0")
            }

            Row {
              If(condition: @state.story.hasUrl) {
                Link(href: "@{state.story.url}", target: "_blank", rel: "noopener noreferrer") {
                  Row {
                    Icon(@resources.external).size(16).color("#0E0E11")
                    Text("Read article").tw("text-[14px] font-semibold ml-2").color("#0E0E11")
                  }
                  .tw("items-center justify-center")
                }
                .tw("flex-1 h-11 rounded-xl flex items-center justify-center no-underline mr-2")
                .backgroundColor("${ACCENT}")
                .opacity({ default: 1, active: 0.75 })
              }
              Link(href: "@{state.story.hnUrl}", target: "_blank", rel: "noopener noreferrer") {
                Row {
                  Icon(@resources.message).size(16).color("${TEXT}")
                  Text("On HN").tw("text-[14px] font-semibold ml-2").color("${TEXT}")
                }
                .tw("items-center justify-center")
              }
              .tw("flex-1 h-11 rounded-xl border flex items-center justify-center no-underline")
              .borderColor("${BORDER}")
              .backgroundColor("rgba(255,255,255,0.05)")
              .opacity({ default: 1, active: 0.75 })
            }
            .tw("mt-5 w-full")
          }
          .tw("px-4 pb-2")
          .enter(fade, duration: 260)
          ${PAGE}
        }

        // Comments
        If(condition: "@{state.status == 'ready'}") {
          Row {
            Text("Comments").tw("text-[18px] font-bold").fontFamily("${SERIF}").color("${TEXT}")
          }
          .tw("px-4 pt-6 pb-2 border-t mt-4")
          .borderColor("${BORDER}")
          ${PAGE}
        }

        If(condition: "@{state.commentsStatus == 'loading' && length(state.comments) == 0}") {
          Column {
${skeletonRows(4)}
          }
          .exit(fade, duration: 150)
          ${PAGE}
        }

        If(condition: @state.noComments) {
          Text("No comments yet.").tw("px-4 py-4 text-[14px]").color("${MUTED}")
        }

        Column {
          ForEach(items: @state.comments, key: "id", as: "c") {
            Column {
              Button {
                Row {
                  Text("@{c.by}").tw("text-[12px] font-semibold").color("@{c.byColor}")
                  If(condition: @c.op) {
                    Text("OP")
                      .tw("text-[9px] font-bold ml-1.5 px-1.5 py-0.5 rounded")
                      .color("#0E0E11")
                      .backgroundColor("${ACCENT}")
                  }
                  Text("@{c.age}").tw("text-[12px] ml-2").color("${DIM}")
                  Box {}.tw("flex-1")
                  Text("@{c.collapseLabel}").tw("text-[12px] font-mono").color("${DIM}")
                }
                .tw("items-center w-full")
              }
              .tw("w-full bg-transparent border-0 p-0 text-left")
              .opacity({ default: 1, active: 0.6 })
              .label("Collapse or expand comment by @{c.by}")
              .onClick(@actions.toggleCollapse, id: "@{c.id}", animate: spring)

              If(condition: @c.showBody) {
                Text("@{c.text}")
                  .tw("text-[14px] leading-relaxed mt-1.5")
                  .whiteSpace("pre-wrap")
                  .overflowWrap("anywhere")
                  .color("#D4D4DA")
              }

              If(condition: @c.hasLinks) {
                Row {
                  ForEach(items: @c.links, key: "id", as: "lnk") {
                    Link(href: "@{lnk.href}", target: "_blank", rel: "noopener noreferrer") {
                      Row {
                        Icon(@resources.link).size(11).color("#93C5FD")
                        Text("@{lnk.label}").tw("text-[11px] ml-1 truncate").color("#93C5FD")
                      }
                      .tw("items-center")
                    }
                    .tw("mr-1.5 mt-1.5 px-2 py-1 rounded-lg no-underline max-w-full")
                    .backgroundColor("rgba(96, 165, 250, 0.10)")
                  }
                }
                .tw("flex-wrap")
              }

              If(condition: @c.hasReplies) {
                Button {
                  Text("@{c.toggleLabel}").tw("text-[12px] font-semibold").color("@{c.toggleColor}")
                }
                .tw("mt-1.5 bg-transparent border-0 p-0")
                .opacity({ default: 1, active: 0.5 })
                .onClick(@actions.toggleReplies, id: "@{c.id}", animate: spring)
              }
            }
            .tw("py-2.5 pl-3 pr-3 border-l-2 items-start")
            .borderColor("@{c.rail}")
            .marginLeft("@{c.indent}")
            .enter(fade, slide, from: top, duration: 220)
            .exit(fade, duration: 150)
            .layout(spring)
          }
        }
        .tw("px-4 gap-1")
        ${PAGE}

        If(condition: @state.hasMore) {
          Button {
            Text("@{state.loadingMore ? 'Loading…' : state.moreLabel}")
              .tw("text-[13px] font-semibold")
              .color("${TEXT}")
          }
          .tw("mt-3 h-11 rounded-xl border items-center justify-center")
          .borderColor("${BORDER}")
          .backgroundColor("${CARD}")
          .opacity({ default: 1, active: 0.6 })
          .onClick(@actions.loadMore)
          ${INSET}
        }

        Box {}.tw("h-16")
      }
      .scrollable(true)
      .tw("flex-1")
    }
  `);
