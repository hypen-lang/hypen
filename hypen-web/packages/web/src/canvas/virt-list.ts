/**
 * Windowed lists on the canvas — the renderer side of the `__virt.window`
 * contract (docs/virtualization.md §1–§3).
 *
 * The engine materializes only items `[start, end)` of a List/Grid/lazy
 * ForEach and describes the window in the reserved `__virt.window` prop on
 * the list's element. This controller:
 *
 * 1. keeps that prop OUT of `node.props` (it is neither style nor echoed),
 *    queueing it per node and applying it after the batch's structural
 *    patches (`flush`);
 * 2. turns the window into stand-in space along the scroll axis — layout
 *    padding on the list's box (`addVirtPadding` in layout.ts), or, for a
 *    list that scrolls itself, a post-layout shift of its rows plus extra
 *    scroll extent (`afterLayout`, `ScrollManager.updateScrollBounds`);
 * 3. measures the laid-out rows to refine the per-item size, anchoring the
 *    first visible row when the leading space changes;
 * 4. reports the visible range + overscan through the engine's
 *    `setListViewport` after each frame (`report`), deduplicated by the
 *    shared `shouldReport` rule.
 *
 * All range/padding math is the shared `@hypen-space/core/virtualization`.
 */

import {
  VIRT_WINDOW_PROP,
  DEFAULT_ITEM_SIZE,
  parseVirtWindow,
  itemSize,
  windowPadding,
  visibleRange,
  wantedRange,
  shouldReport,
  type VirtWindow,
} from "@hypen-space/core/virtualization";
import type { Layout, VirtualNode, VirtListState } from "./types.js";
import { getScrollAxes } from "./scroll.js";
import { isColumnFlow, mainAxisGap } from "./layout.js";
import { trackCount } from "../grid-tracks.js";

export { VIRT_WINDOW_PROP };

/** What the controller needs from its renderer. */
export interface VirtListHost {
  getNode(id: string): VirtualNode | undefined;
  /** Whether `node` is in the live (rendered) tree. */
  isAttached(node: VirtualNode): boolean;
  /** The root viewport (canvas size in layout units). */
  viewport(): { width: number; height: number };
  /** Forward a viewport report to the engine. */
  setListViewport(listId: string, start: number, end: number): void;
  /** The accessibility-mirror element of a node, if any. */
  mirrorElement(id: string): { setAttribute?(n: string, v: string): void; removeAttribute?(n: string): void } | undefined;
}

/** Size change (px) below which a measured item size is not re-applied. */
const SIZE_EPSILON = 0.5;

export class VirtListController {
  /** Windowed list nodes by id. */
  private lists = new Map<string, VirtualNode>();
  /** Windows set during the current batch; `null` = removed. */
  private pending = new Map<string, VirtWindow | null>();

  constructor(private host: VirtListHost) {}

  /** Is `name` the reserved window prop (handled here, never stored in props)? */
  static isWindowProp(name: string): boolean {
    return name === VIRT_WINDOW_PROP;
  }

  /** A `setProp` of `__virt.window`; applied at {@link flush}. Malformed values are ignored. */
  noteSet(id: string, value: unknown): void {
    const window = parseVirtWindow(value);
    if (window) this.pending.set(id, window);
  }

  /** A `removeProp` of `__virt.window`: the list renders as a normal container again. */
  noteRemove(id: string): void {
    this.pending.set(id, null);
  }

  /** Whether any windowed list exists (skips per-frame work otherwise). */
  get active(): boolean {
    return this.lists.size > 0;
  }

  /**
   * Apply the batch's queued windows — called after every structural patch
   * of the batch landed, so the children are exactly the window's items.
   */
  flush(): void {
    if (this.pending.size === 0) return;
    for (const [id, window] of this.pending) {
      const node = this.host.getNode(id);
      if (!node) {
        this.lists.delete(id);
        continue;
      }
      if (window === null) {
        this.clearAria(node);
        delete node.virt;
        this.lists.delete(id);
        continue;
      }
      const v = node.virt;
      if (v) {
        v.window = window;
        if (!v.measured) v.itemSize = window.estimatedSize ?? DEFAULT_ITEM_SIZE;
      } else {
        node.virt = {
          window,
          horizontal: false,
          columns: 1,
          itemSize: window.estimatedSize ?? DEFAULT_ITEM_SIZE,
          measured: false,
          leading: 0,
          trailing: 0,
          selfScroll: false,
          lastReported: null,
          laidOutLeading: null,
          anchor: null,
        };
      }
      this.lists.set(id, node);
      this.syncAria(node);
    }
    this.pending.clear();
  }

  /** Forget everything (renderer `clear()`). */
  reset(): void {
    this.lists.clear();
    this.pending.clear();
  }

  /**
   * Before layout: resolve each list's axis, columns and scroll mode from
   * its current props and size its stand-in space from `itemSize`.
   */
  beforeLayout(): void {
    for (const [id, node] of this.lists) {
      if (!node.virt || this.host.getNode(id) !== node) {
        this.lists.delete(id);
        continue;
      }
      const v = node.virt;
      v.horizontal = !isColumnFlow(node);
      v.columns = gridColumns(node);
      const axes = getScrollAxes(node);
      v.selfScroll = v.horizontal ? axes.x : axes.y;
      this.applyPadding(v);
    }
  }

  /**
   * After layout: measure the materialized rows; when the measured row size
   * moves the stand-in space, re-run layout once (`relayout`) with the new
   * padding. Then shift self-scrolling lists' rows past their leading space
   * and keep the anchored row in place when the leading space changed.
   */
  afterLayout(relayout: () => void): void {
    if (this.lists.size === 0) return;
    let changed = false;
    for (const node of this.lists.values()) {
      const v = node.virt!;
      const measured = measureItemSize(node, v);
      if (measured === null) continue;
      v.measured = true;
      if (Math.abs(measured - v.itemSize) > SIZE_EPSILON) {
        v.itemSize = measured;
        const before = v.leading + v.trailing;
        this.applyPadding(v);
        if (!v.selfScroll && v.leading + v.trailing !== before) changed = true;
      }
    }
    if (changed) relayout();

    for (const node of this.lists.values()) {
      const v = node.virt!;
      if (v.selfScroll && v.leading !== 0) {
        for (const child of node.children) {
          shiftSubtree(child, v.horizontal ? v.leading : 0, v.horizontal ? 0 : v.leading);
        }
      }
      this.anchor(node, v);
      v.laidOutLeading = v.leading;
    }
  }

  /**
   * Report each attached list's wanted range when the shared rule says so.
   * Called once per frame after layout + paint; also records the scroll
   * anchor (first visible materialized row) for the next layout.
   */
  report(): void {
    for (const [id, node] of this.lists) {
      const v = node.virt;
      if (!v || !node.layout || !this.host.isAttached(node)) continue;
      const frame = this.visibleFrame(node, v);
      const visible = visibleRange(
        v.window.total,
        v.itemSize,
        frame.scrolledPast,
        frame.extent,
        v.columns,
      );
      v.anchor = this.findAnchor(node, v, frame.viewStart);
      const wanted = wantedRange(visible, v.window.total);
      if (shouldReport(v.window, visible, wanted, v.lastReported)) {
        v.lastReported = wanted;
        this.host.setListViewport(id, wanted.start, wanted.end);
      }
    }
  }

  // ---------------------------------------------------------------------------

  private applyPadding(v: VirtListState): void {
    const { leading, trailing } = windowPadding(v.window, v.itemSize, v.columns);
    v.leading = leading;
    v.trailing = trailing;
  }

  /**
   * The scroll container's visible span along the list's axis, in the
   * list's (unscrolled) layout coordinates, and how far it is past the
   * list's first item (§3.1–§3.2). The container is the list when it
   * scrolls itself, else its nearest ancestor scrolling on that axis, else
   * the root viewport.
   */
  private visibleFrame(
    node: VirtualNode,
    v: VirtListState,
  ): { viewStart: number; extent: number; scrolledPast: number } {
    const h = v.horizontal;
    const layout = node.layout!;
    const container = scrollContainer(node, h);
    const vp = this.host.viewport();
    const vpExtent = h ? vp.width : vp.height;
    let viewStart: number;
    let extent: number;
    if (container?.layout) {
      const cl = container.layout;
      const scroll = h ? container.scrollState?.scrollX ?? 0 : container.scrollState?.scrollY ?? 0;
      viewStart = axisPos(cl, h) + cl.border.width + scroll;
      // Nothing beyond the canvas is visible, however tall the container.
      extent = Math.min(vpExtent, Math.max(0, (h ? cl.width : cl.height) - 2 * cl.border.width));
    } else {
      viewStart = 0;
      extent = vpExtent;
    }
    // Where item 0 would sit: the content edge, minus the leading stand-in
    // when it is layout padding (a self-scrolling list's rows are shifted
    // instead, so its content edge already is item 0's).
    const contentStart = h ? layout.contentX : layout.contentY;
    const firstItem = axisPos(layout, h) + contentStart - (v.selfScroll ? 0 : v.leading);
    return { viewStart, extent, scrolledPast: viewStart - firstItem };
  }

  /** First materialized child whose far edge is past the visible start. */
  private findAnchor(
    node: VirtualNode,
    v: VirtListState,
    viewStart: number,
  ): { node: VirtualNode; pos: number } | null {
    for (const child of node.children) {
      const cl = child.layout;
      if (!cl) continue;
      const pos = axisPos(cl, v.horizontal);
      if (pos + (v.horizontal ? cl.width : cl.height) > viewStart) return { node: child, pos };
    }
    return null;
  }

  /**
   * Scroll anchoring (§2): when a window change altered the leading space,
   * move the scroll container by however far the anchored row moved so it
   * stays at the same screen position.
   */
  private anchor(node: VirtualNode, v: VirtListState): void {
    const a = v.anchor;
    if (v.laidOutLeading === null || v.laidOutLeading === v.leading || !a) return;
    if (a.node.parent !== node || !a.node.layout) return;
    const container = scrollContainer(node, v.horizontal);
    const ss = container?.scrollState;
    if (!ss) return;
    const delta = axisPos(a.node.layout, v.horizontal) - a.pos;
    if (Math.abs(delta) < SIZE_EPSILON) return;
    if (v.horizontal) ss.scrollX += delta;
    else ss.scrollY += delta;
    a.pos += delta;
  }

  /** `aria-setsize` / `aria-posinset` on each row's mirror element (§2). */
  private syncAria(node: VirtualNode): void {
    const v = node.virt!;
    const per = childrenPerItem(node, v);
    if (per === 0) return;
    const total = String(v.window.total);
    node.children.forEach((child, i) => {
      const el = this.host.mirrorElement(child.id);
      el?.setAttribute?.("aria-setsize", total);
      el?.setAttribute?.("aria-posinset", String(v.window.start + Math.floor(i / per) + 1));
    });
  }

  private clearAria(node: VirtualNode): void {
    for (const child of node.children) {
      const el = this.host.mirrorElement(child.id);
      el?.removeAttribute?.("aria-setsize");
      el?.removeAttribute?.("aria-posinset");
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function axisPos(layout: Layout, horizontal: boolean): number {
  return horizontal ? layout.x : layout.y;
}

/** Children per item (multi-node templates, §1); 0 for an empty window. */
function childrenPerItem(node: VirtualNode, v: VirtListState): number {
  const count = v.window.end - v.window.start;
  if (count <= 0 || node.children.length === 0) return 0;
  return Math.max(1, Math.round(node.children.length / count));
}

/** A Grid's column count (`columns` / `.gridColumns(n)`), else 1. */
function gridColumns(node: VirtualNode): number {
  const type = node.type.toLowerCase();
  if (type !== "grid" && node.props.display !== "grid") return 1;
  const p = node.props;
  return trackCount(p.gridColumns ?? p.columns ?? p["columns.0"]) ?? 1;
}

/** The list itself if it scrolls on `horizontal`'s axis, else the nearest such ancestor. */
function scrollContainer(node: VirtualNode, horizontal: boolean): VirtualNode | null {
  let current: VirtualNode | null = node;
  while (current) {
    const axes = getScrollAxes(current);
    if (horizontal ? axes.x : axes.y) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Average extent of one row of items along the scroll axis, from the laid-
 * out children: the span from the first row's leading edge to the last
 * row's trailing edge (margins included) plus one main-axis gap, over the
 * number of rows. `null` when nothing is laid out yet.
 */
function measureItemSize(node: VirtualNode, v: VirtListState): number | null {
  const count = v.window.end - v.window.start;
  if (count <= 0) return null;
  const h = v.horizontal;
  let min = Infinity;
  let max = -Infinity;
  for (const child of node.children) {
    const cl = child.layout;
    if (!cl || child.props.position === "absolute") continue;
    const start = axisPos(cl, h) - (h ? cl.margin.left : cl.margin.top);
    const end = axisPos(cl, h) + (h ? cl.width + cl.margin.right : cl.height + cl.margin.bottom);
    if (start < min) min = start;
    if (end > max) max = end;
  }
  if (!(max > min)) return null;
  const rows = Math.ceil(count / v.columns);
  const size = itemSize(v.window, max - min + mainAxisGap(node.props, !h), rows);
  return size > 0 ? size : null;
}

/** Translate a laid-out subtree (layouts are absolute). */
function shiftSubtree(node: VirtualNode, dx: number, dy: number): void {
  if (node.layout) {
    node.layout.x += dx;
    node.layout.y += dy;
  }
  for (const child of node.children) shiftSubtree(child, dx, dy);
}
