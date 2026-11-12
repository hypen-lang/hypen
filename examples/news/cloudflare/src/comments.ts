// The HN comment tree, server side.
//
// HN threads are recursive and can run to hundreds of items, so the tree is
// loaded lazily: the first page of top-level comments up front, deeper levels
// only when a reader expands them (the hub fetches each batch with bounded
// concurrency and caches it). The UI never sees the tree itself — `flatten`
// turns the visible part into one keyed list of rows with a `depth`, which a
// single ForEach renders with indentation. Expanding, collapsing and paging
// are then just keyed inserts/removes in that list, so they animate.

import { timeAgo } from "./format";
import { htmlToRichText, type TextLink } from "./html";
import type { HnItem } from "./upstream";

export const TOP_PAGE = 12;
const MAX_INDENT_DEPTH = 6;
const RAILS = ["#FF7A1A", "#60A5FA", "#34D399", "#F472B6", "#FBBF24", "#A78BFA"];

interface Node {
  item: HnItem;
  text: string;
  links: TextLink[];
  /** null until this node's replies were fetched. */
  children: number[] | null;
  expanded: boolean;
  collapsed: boolean;
  loading: boolean;
}

export interface CommentRow {
  id: string;
  depth: number;
  indent: number;
  rail: string;
  by: string;
  byColor: string;
  op: boolean;
  age: string;
  text: string;
  links: TextLink[];
  hasLinks: boolean;
  showBody: boolean;
  collapseLabel: string;
  hasReplies: boolean;
  toggleLabel: string;
  toggleColor: string;
}

function replyCountLabel(n: number): string {
  return n === 1 ? "1 reply" : `${n} replies`;
}

export class CommentTree {
  private nodes = new Map<number, Node>();
  /** Top-level comment ids, in HN's ranked order. */
  readonly topIds: number[];
  /** How many of `topIds` are loaded into view. */
  shown = 0;

  constructor(readonly storyId: number, readonly opBy: string, kids: number[] = []) {
    this.topIds = kids.slice();
  }

  get remaining(): number {
    return Math.max(0, this.topIds.length - this.shown);
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  add(items: HnItem[]): void {
    for (const item of items) {
      if (this.nodes.has(item.id)) continue;
      const rich = item.deleted ? { text: "[deleted]", links: [] } : item.dead ? { text: "[flagged]", links: [] } : htmlToRichText(item.text);
      this.nodes.set(item.id, {
        item,
        text: rich.text,
        links: rich.links,
        children: (item.kids?.length ?? 0) === 0 ? [] : null,
        expanded: false,
        collapsed: false,
        loading: false,
      });
    }
  }

  /** Ids of the next page of top-level comments (not yet fetched). */
  nextTopPage(size = TOP_PAGE): number[] {
    return this.topIds.slice(this.shown, this.shown + size);
  }

  /** Commit a fetched top-level page. Missing (deleted) ids are skipped. */
  showTop(items: HnItem[], requested: number): void {
    this.add(items);
    this.shown = Math.min(this.topIds.length, this.shown + requested);
  }

  /** The kid ids whose replies must be fetched before `id` can expand, else null. */
  needsFetch(id: number): number[] | null {
    const node = this.nodes.get(id);
    if (!node || node.children !== null) return null;
    return node.item.kids ?? [];
  }

  setLoading(id: number, loading: boolean): void {
    const node = this.nodes.get(id);
    if (node) node.loading = loading;
  }

  /** Attach fetched replies and expand. */
  attach(id: number, replies: HnItem[]): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.add(replies);
    node.children = replies.map((r) => r.id);
    node.loading = false;
    node.expanded = true;
    node.collapsed = false;
  }

  toggleReplies(id: number): void {
    const node = this.nodes.get(id);
    if (node && node.children !== null) {
      node.expanded = !node.expanded;
      if (node.expanded) node.collapsed = false;
    }
  }

  toggleCollapse(id: number): void {
    const node = this.nodes.get(id);
    if (node) node.collapsed = !node.collapsed;
  }

  /** Count of loaded descendants (for the collapsed "[+N]" label). */
  private hiddenCount(node: Node): number {
    const kids = node.item.kids?.length ?? 0;
    if (!node.children) return kids;
    let n = 0;
    for (const id of node.children) {
      const child = this.nodes.get(id);
      n += 1 + (child ? this.hiddenCount(child) : 0);
    }
    return Math.max(n, kids);
  }

  flatten(now = Date.now()): CommentRow[] {
    const rows: CommentRow[] = [];
    const walk = (id: number, depth: number) => {
      const node = this.nodes.get(id);
      if (!node) return;
      const it = node.item;
      const kids = it.kids?.length ?? 0;
      const op = !!it.by && it.by === this.opBy;
      rows.push({
        id: String(it.id),
        depth,
        indent: Math.min(depth, MAX_INDENT_DEPTH) * 12,
        rail: depth === 0 ? "rgba(255,255,255,0.10)" : RAILS[(depth - 1) % RAILS.length]!,
        by: it.by ?? "[deleted]",
        byColor: op ? "#FF7A1A" : "#C9C9D1",
        op,
        age: it.time ? timeAgo(it.time, now) : "",
        text: node.text,
        links: node.links,
        hasLinks: node.links.length > 0 && !node.collapsed,
        showBody: !node.collapsed,
        collapseLabel: node.collapsed ? `[+${this.hiddenCount(node) + 1}]` : "[–]",
        hasReplies: kids > 0 && !node.collapsed,
        toggleLabel: node.loading ? "Loading replies…" : node.expanded ? "Hide replies" : replyCountLabel(kids),
        toggleColor: node.expanded ? "#8E8E99" : "#FF7A1A",
      });
      if (!node.collapsed && node.expanded && node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    };
    for (const id of this.topIds.slice(0, this.shown)) walk(id, 0);
    return rows;
  }
}
