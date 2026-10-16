/**
 * List virtualization — the DOM renderer's side of the `__virt.window`
 * contract (hypen-web/docs/virtualization.md §1–§3).
 *
 * The engine materializes only a window `[start, end)` of a lazy list's
 * items and describes it with the reserved `__virt.window` prop on the
 * list's element. This runtime:
 *
 * - stands in for the items outside the window with leading/trailing
 *   PADDING on the list element (added to any author padding), sized from
 *   the measured average row extent (`itemSize` / `windowPadding`);
 * - keeps the first visible materialized row still when a window change
 *   alters the leading padding (scroll anchoring);
 * - stamps `aria-setsize` / `aria-posinset` on every materialized row;
 * - computes the visible range in the list's scroll container (the list
 *   itself, a scrolling ancestor, or the window) and reports the overscanned
 *   range with `engine.setListViewport` per `viewportReport` — after layout,
 *   on scroll (once per frame), on resize, and on every window change.
 *
 * All of the math is the shared `@hypen-space/core/virtualization`.
 */

import {
  VIRT_WINDOW_PROP,
  childrenPerItem,
  itemSize,
  parseVirtWindow,
  viewportReport,
  windowPadding,
  windowRows,
  type ItemRange,
  type VirtWindow,
} from "@hypen-space/core/virtualization";
import { trackCount } from "../grid-tracks.js";

export { VIRT_WINDOW_PROP };

/** The engine surface the runtime reports to (local BaseEngine or RemoteEngine). */
export interface ViewportEngine {
  setListViewport?(listId: string, start: number, end: number): void;
}

type Axis = "y" | "x";

/** One padding edge: the author's own value plus what the runtime last wrote. */
interface EdgeState {
  /** Author padding on this edge (CSS length), "" when none. */
  base: string;
  /** Whether `base` came from an inline longhand we must restore on removal. */
  baseInline: boolean;
  /** The inline value the runtime last wrote, to tell author writes apart. */
  written: string | null;
}

interface Anchor {
  element: HTMLElement;
  offset: number;
}

interface ListState {
  id: string;
  element: HTMLElement;
  window: VirtWindow;
  axis: Axis;
  /** Extent assumed per item (per row of items for grids). */
  itemSize: number;
  leading: EdgeState;
  trailing: EdgeState;
  /** CSS edges the leading/trailing padding were written to. */
  edges: [string, string] | null;
  /** Inline `overflow-anchor` before we disabled native anchoring. */
  prevOverflowAnchor: string | undefined;
  /** Resolved scroll container; `null` = the window. `undefined` = unresolved. */
  scroller: HTMLElement | null | undefined;
  onScroll: (() => void) | null;
  resizeObserver: { disconnect(): void; observe(el: Element): void } | null;
  /** Elements whose rows carry our aria stamps (for removal). */
  stamped: Set<HTMLElement>;
  lastReported: ItemRange | null;
  frame: number | null;
  frameCancel: ((handle: number) => void) | null;
  needsLayout: boolean;
  checkQueued: boolean;
  anchor: Anchor | null;
  laidOut: boolean;
}

const SCROLLING = /^(auto|scroll|overlay)$/;

function cssLengthPx(value: string | undefined | null): number | null {
  if (!value) return 0;
  const m = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * The padding on one edge from an inline `padding` shorthand
 * (1–4 values, CSS order top/right/bottom/left).
 */
function shorthandEdge(shorthand: string | undefined, edge: string): string {
  if (!shorthand) return "";
  const parts = shorthand.trim().split(/\s+(?![^(]*\))/);
  if (parts.length === 0 || parts[0] === "") return "";
  const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
  switch (edge) {
    case "padding-top":
      return t;
    case "padding-right":
      return r!;
    case "padding-bottom":
      return b!;
    default:
      return l!;
  }
}

const camel = (edge: string) => edge.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function readInline(element: HTMLElement, edge: string): string {
  const style = element.style as unknown as Record<string, string | undefined>;
  return style[camel(edge)] ?? "";
}

function writeInline(element: HTMLElement, edge: string, value: string | null): void {
  const style = element.style as unknown as Record<string, string> & {
    removeProperty?(name: string): void;
  };
  if (value === null || value === "") {
    if (typeof style.removeProperty === "function") style.removeProperty(edge);
    else style[camel(edge)] = "";
  } else {
    style[camel(edge)] = value;
  }
}

function computed(element: Element): CSSStyleDeclaration | null {
  const w = (globalThis as { window?: { getComputedStyle?: (e: Element) => CSSStyleDeclaration } }).window;
  try {
    return w?.getComputedStyle ? w.getComputedStyle(element) : null;
  } catch {
    return null;
  }
}

function raf(cb: () => void): { handle: number; cancel: ((h: number) => void) | null } {
  const g = globalThis as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame === "function") {
    return { handle: g.requestAnimationFrame(cb), cancel: g.cancelAnimationFrame ?? null };
  }
  return {
    handle: setTimeout(cb, 16) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

function isConnected(element: HTMLElement): boolean {
  const connected = (element as { isConnected?: boolean }).isConnected;
  return connected === undefined ? true : connected;
}

/** Element children in order (no live collection kept). */
function childElements(element: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let c = element.firstElementChild as HTMLElement | null; c; c = c.nextElementSibling as HTMLElement | null) {
    out.push(c);
  }
  return out;
}

export class DomVirtualizer {
  private lists = new Map<string, ListState>();
  private byElement = new Map<HTMLElement, ListState>();
  /** Grid column counts by node id (`columns` / `columns.0` / `gridColumns`). */
  private columns = new Map<string, number>();
  private dirty = new Set<ListState>();

  constructor(private readonly getEngine: () => ViewportEngine) {}

  /** Record a column-count prop (Grid). Returns nothing; never consumes the prop. */
  noteProp(id: string, name: string, value: unknown): void {
    if (name === "columns" || name === "columns.0" || name === "gridColumns" || name === "gridColumns.0") {
      const n = trackCount(value);
      if (n === null) this.columns.delete(id);
      else this.columns.set(id, n);
    }
    const state = this.lists.get(id);
    // Any prop write on a windowed element may be the author's padding, a
    // gap, a direction or a column change: re-lay it out after the batch.
    if (state) this.dirty.add(state);
  }

  /** Initial props of a created element (column counts). */
  noteCreate(id: string, props: Record<string, unknown>): void {
    for (const key of ["columns", "columns.0", "gridColumns", "gridColumns.0"]) {
      if (key in props) this.noteProp(id, key, props[key]);
    }
  }

  /**
   * Before a batch mutates the DOM: snapshot the scroll anchor of every
   * windowed list whose window the batch moves, so the first visible row
   * can be held in place after the new padding lands.
   */
  prepareBatch(patches: ReadonlyArray<{ type: string; id?: string; name?: string }>): void {
    if (this.lists.size === 0) return;
    for (const p of patches) {
      if (p.type !== "setProp" || p.name !== VIRT_WINDOW_PROP || !p.id) continue;
      const state = this.lists.get(p.id);
      if (state && state.laidOut && !state.anchor && isConnected(state.element)) {
        state.anchor = this.captureAnchor(state);
      }
    }
  }

  /**
   * `setProp __virt.window`. Applied in `flush` after the batch's structure.
   * A malformed value is ignored (the current window, if any, stays).
   */
  setWindow(id: string, element: HTMLElement, value: unknown): void {
    const window = parseVirtWindow(value);
    if (!window) return;
    let state = this.lists.get(id);
    if (state && state.element !== element) {
      this.removeWindow(id);
      state = undefined;
    }
    if (!state) {
      state = {
        id,
        element,
        window,
        axis: "y",
        itemSize: 0,
        leading: { base: "", baseInline: false, written: null },
        trailing: { base: "", baseInline: false, written: null },
        edges: null,
        prevOverflowAnchor: undefined,
        scroller: undefined,
        onScroll: null,
        resizeObserver: null,
        stamped: new Set(),
        lastReported: null,
        frame: null,
        frameCancel: null,
        needsLayout: false,
        checkQueued: false,
        anchor: null,
        laidOut: false,
      };
      this.lists.set(id, state);
      this.byElement.set(element, state);
      // Native CSS scroll anchoring would fight the runtime's own anchoring
      // when the padding changes; opt this subtree out of it.
      const style = element.style as unknown as Record<string, string | undefined>;
      state.prevOverflowAnchor = style.overflowAnchor;
      style.overflowAnchor = "none";
    } else {
      state.window = window;
    }
    this.dirty.add(state);
  }

  /** `removeProp __virt.window`: back to a plain container. */
  removeWindow(id: string): void {
    const state = this.lists.get(id);
    if (!state) return;
    this.teardown(state, true);
  }

  /** A child of `parent` was inserted, moved or removed. */
  noteChildrenChanged(parent: unknown): void {
    if (this.byElement.size === 0) return;
    const state = this.byElement.get(parent as HTMLElement);
    if (state) this.dirty.add(state);
  }

  /** A cached subtree was re-attached: its lists need a layout + report. */
  noteAttach(root: HTMLElement): void {
    for (const state of this.lists.values()) {
      if (root === state.element || root.contains?.(state.element)) {
        state.scroller = undefined; // ancestors may differ now
        this.dirty.add(state);
      }
    }
  }

  /** The element `id` is gone for good. */
  forget(id: string): void {
    this.columns.delete(id);
    const state = this.lists.get(id);
    if (state) this.teardown(state, false);
  }

  reset(): void {
    for (const state of [...this.lists.values()]) this.teardown(state, false);
    this.columns.clear();
    this.dirty.clear();
  }

  /**
   * After a batch's structural patches: lay out every list the batch
   * touched (padding, aria, anchoring) and queue its viewport check.
   */
  flush(): void {
    if (this.dirty.size === 0) return;
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const state of dirty) {
      if (this.lists.get(state.id) !== state) continue;
      this.layout(state);
      this.bindScroller(state);
      this.queueCheck(state);
    }
  }

  // ── layout ─────────────────────────────────────────────────────────

  private axisOf(state: ListState): Axis {
    const el = state.element;
    const type = el.dataset?.hypenType;
    if (type === "grid") return "y";
    if (type === "row") return "x";
    const dir = (el.style as unknown as Record<string, string | undefined>).flexDirection;
    return typeof dir === "string" && dir.startsWith("row") ? "x" : "y";
  }

  private columnsOf(state: ListState): number {
    if (state.element.dataset?.hypenType !== "grid") return 1;
    return this.columns.get(state.id) ?? 1;
  }

  /** Average extent of a materialized row (item, or grid row), or 0 when unknown. */
  private measure(state: ListState, children: HTMLElement[]): { total: number; count: number } {
    const { start, end } = state.window;
    if (children.length === 0 || end <= start) return { total: 0, count: 0 };
    const cols = this.columnsOf(state);
    const rows = windowRows(state.window, cols);
    const first = children[0]!.getBoundingClientRect?.();
    const last = children[children.length - 1]!.getBoundingClientRect?.();
    if (!first || !last) return { total: 0, count: 0 };
    const y = state.axis === "y";
    let span = y ? last.bottom - first.top : last.right - first.left;
    if (!(span > 0)) {
      // Rows not laid out (detached, display: contents …): sum the boxes.
      span = 0;
      for (const child of children) {
        const r = child.getBoundingClientRect?.();
        if (r) span += y ? r.height : r.width;
      }
      if (cols > 1) span = span / cols;
    }
    if (!(span > 0)) return { total: 0, count: 0 };
    // `rows` rows span `rows - 1` gaps: count one gap into every row.
    const style = state.element.style as unknown as Record<string, string | undefined>;
    const gap = cssLengthPx(y ? style.rowGap ?? style.gap : style.columnGap ?? style.gap) ?? 0;
    return { total: span + gap, count: rows };
  }

  private layout(state: ListState): void {
    const el = state.element;
    state.needsLayout = false;
    const axis = this.axisOf(state);
    const edges: [string, string] = axis === "y" ? ["padding-top", "padding-bottom"] : ["padding-left", "padding-right"];
    if (state.edges && (state.edges[0] !== edges[0])) {
      // Direction flipped: restore the old edges before writing the new.
      this.restoreEdge(el, state.edges[0], state.leading);
      this.restoreEdge(el, state.edges[1], state.trailing);
      state.leading = { base: "", baseInline: false, written: null };
      state.trailing = { base: "", baseInline: false, written: null };
    }
    state.axis = axis;
    state.edges = edges;

    const children = childElements(el);
    const measured = this.measure(state, children);
    // Grid rows: the measured extent is per ROW; the estimate is per item
    // and a grid row is one item tall, so either feeds `windowPadding`.
    state.itemSize = itemSize(state.window, measured.total, measured.count);
    const { leading, trailing } = windowPadding(state.window, state.itemSize, this.columnsOf(state));

    this.writeEdge(el, edges[0], state.leading, leading);
    this.writeEdge(el, edges[1], state.trailing, trailing);

    this.stampAria(state, children);
    this.restoreAnchor(state);
    state.laidOut = true;
  }

  /** Re-read the author's padding when it is not what we last wrote. */
  private refreshBase(el: HTMLElement, edge: string, s: EdgeState): void {
    const inline = readInline(el, edge);
    if (s.written !== null && inline === s.written) return;
    if (inline) {
      s.base = inline;
      s.baseInline = true;
      return;
    }
    const style = el.style as unknown as Record<string, string | undefined>;
    const fromShorthand = shorthandEdge(style.padding, edge);
    if (fromShorthand) {
      s.base = fromShorthand;
      s.baseInline = false;
      return;
    }
    // Stylesheet padding (classes): fold the computed value in, since an
    // inline longhand would otherwise override it.
    const cs = computed(el) as unknown as Record<string, string | undefined> | null;
    const value = cs?.[camel(edge)];
    s.base = value && cssLengthPx(value) !== 0 ? value : "";
    s.baseInline = false;
  }

  private writeEdge(el: HTMLElement, edge: string, s: EdgeState, px: number): void {
    this.refreshBase(el, edge, s);
    const basePx = cssLengthPx(s.base);
    const value =
      s.base === "" || basePx === 0
        ? `${px}px`
        : basePx !== null
          ? `${basePx + px}px`
          : `calc(${s.base} + ${px}px)`;
    if (readInline(el, edge) !== value) writeInline(el, edge, value);
    s.written = readInline(el, edge) || value;
  }

  private restoreEdge(el: HTMLElement, edge: string, s: EdgeState): void {
    if (s.written === null) return;
    const inline = readInline(el, edge);
    // The author overwrote it since: leave theirs.
    if (inline !== s.written) return;
    writeInline(el, edge, s.baseInline ? s.base : null);
  }

  /** Aria: every child carries its item's position in the full list. */
  private stampAria(state: ListState, children: HTMLElement[]): void {
    const cpi = childrenPerItem(state.window, children.length);
    const total = String(state.window.total);
    const next = new Set<HTMLElement>();
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const pos = String(state.window.start + Math.floor(i / cpi) + 1);
      if (child.getAttribute?.("aria-setsize") !== total) child.setAttribute("aria-setsize", total);
      if (child.getAttribute?.("aria-posinset") !== pos) child.setAttribute("aria-posinset", pos);
      next.add(child);
    }
    // A child moved out of the list keeps no stale position.
    for (const old of state.stamped) {
      if (!next.has(old) && old.parentNode !== state.element) {
        old.removeAttribute("aria-setsize");
        old.removeAttribute("aria-posinset");
      }
    }
    state.stamped = next;
  }

  // ── scroll container + anchoring ───────────────────────────────────

  private scrollsOnAxis(el: HTMLElement, axis: Axis): boolean {
    const y = axis === "y";
    const pick = (src: Record<string, string | undefined> | null): string | undefined => {
      if (!src) return undefined;
      const longhand = y ? src.overflowY : src.overflowX;
      if (longhand) return longhand;
      const parts = src.overflow?.trim().split(/\s+/);
      if (!parts || parts[0] === "") return undefined;
      // `overflow: <x> <y>`; one value applies to both axes.
      return y ? (parts[1] ?? parts[0]) : parts[0];
    };
    const overflow =
      pick(el.style as unknown as Record<string, string | undefined>) ??
      pick(computed(el) as unknown as Record<string, string | undefined> | null);
    if (!overflow || !SCROLLING.test(overflow)) return false;
    // A container that is as big as its content does not scroll (a List
    // without a height grows with its rows; its ancestor scrolls instead).
    const sh = (el as { scrollHeight?: number; scrollWidth?: number })[axis === "y" ? "scrollHeight" : "scrollWidth"];
    const ch = (el as { clientHeight?: number; clientWidth?: number })[axis === "y" ? "clientHeight" : "clientWidth"];
    if (typeof sh === "number" && typeof ch === "number" && sh <= ch + 1) return false;
    return true;
  }

  private resolveScroller(state: ListState): HTMLElement | null {
    const doc = (globalThis as { document?: Document }).document;
    let el: HTMLElement | null = state.element;
    while (el) {
      if (doc && (el === (doc.body as unknown) || el === (doc.documentElement as unknown))) return null;
      if (this.scrollsOnAxis(el, state.axis)) return el;
      const parent: unknown = el.parentNode;
      el = parent && (parent as { nodeType?: number }).nodeType !== 9 && (parent as HTMLElement).style ? (parent as HTMLElement) : null;
    }
    return null;
  }

  private bindScroller(state: ListState): void {
    const scroller = this.resolveScroller(state);
    if (state.scroller === scroller && state.onScroll) return;
    this.unbindScroller(state);
    state.scroller = scroller;
    const onScroll = () => this.scheduleFrame(state, false);
    state.onScroll = onScroll;
    const target = scroller ?? ((globalThis as { window?: EventTarget }).window as EventTarget | undefined);
    target?.addEventListener?.("scroll", onScroll, { passive: true } as AddEventListenerOptions);
    if (!scroller) {
      (globalThis as { window?: EventTarget }).window?.addEventListener?.("resize", onScroll, { passive: true } as AddEventListenerOptions);
    }
    const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => ListState["resizeObserver"] }).ResizeObserver;
    if (typeof RO === "function") {
      const ro = new RO(() => this.scheduleFrame(state, true));
      ro!.observe(state.element);
      if (scroller && scroller !== state.element) ro!.observe(scroller);
      state.resizeObserver = ro;
    }
  }

  private unbindScroller(state: ListState): void {
    if (state.onScroll) {
      const target = state.scroller ?? ((globalThis as { window?: EventTarget }).window as EventTarget | undefined);
      target?.removeEventListener?.("scroll", state.onScroll);
      if (!state.scroller) {
        (globalThis as { window?: EventTarget }).window?.removeEventListener?.("resize", state.onScroll);
      }
    }
    state.onScroll = null;
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    state.scroller = undefined;
  }

  /** Start of the scroll viewport, in client coordinates on the axis. */
  private viewportStart(state: ListState): number {
    const s = state.scroller;
    if (!s) return 0;
    const r = s.getBoundingClientRect?.();
    const border = (state.axis === "y" ? (s as { clientTop?: number }).clientTop : (s as { clientLeft?: number }).clientLeft) ?? 0;
    return (r ? (state.axis === "y" ? r.top : r.left) : 0) + (border || 0);
  }

  private viewportExtent(state: ListState): number {
    const s = state.scroller;
    const y = state.axis === "y";
    if (s) {
      const c = (y ? (s as { clientHeight?: number }).clientHeight : (s as { clientWidth?: number }).clientWidth) ?? 0;
      if (c > 0) return c;
      const r = s.getBoundingClientRect?.();
      return r ? (y ? r.height : r.width) : 0;
    }
    const w = (globalThis as { window?: { innerHeight?: number; innerWidth?: number } }).window;
    return (y ? w?.innerHeight : w?.innerWidth) ?? 0;
  }

  private captureAnchor(state: ListState): Anchor | null {
    const top = this.viewportStart(state);
    const y = state.axis === "y";
    for (const child of childElements(state.element)) {
      const r = child.getBoundingClientRect?.();
      if (!r) return null;
      if ((y ? r.bottom : r.right) > top) {
        return { element: child, offset: (y ? r.top : r.left) - top };
      }
    }
    return null;
  }

  /**
   * Scroll anchoring (§2): scroll by however far the row captured before the
   * padding changed has moved, so it stays at the same screen position.
   */
  private restoreAnchor(state: ListState): void {
    const anchor = state.anchor;
    state.anchor = null;
    if (!anchor || anchor.element.parentNode !== state.element) return;
    const delta = this.anchorOffset(state, anchor.element) - anchor.offset;
    if (Math.abs(delta) >= 0.5) this.scrollBy(state, delta);
  }

  private anchorOffset(state: ListState, element: HTMLElement): number {
    const r = element.getBoundingClientRect?.();
    return (r ? (state.axis === "y" ? r.top : r.left) : 0) - this.viewportStart(state);
  }

  private scrollBy(state: ListState, delta: number): void {
    const s = state.scroller === undefined ? this.resolveScroller(state) : state.scroller;
    if (s) {
      if (state.axis === "y") s.scrollTop = (s.scrollTop || 0) + delta;
      else s.scrollLeft = (s.scrollLeft || 0) + delta;
    } else {
      const w = (globalThis as { window?: { scrollBy?: (x: number, y: number) => void } }).window;
      if (state.axis === "y") w?.scrollBy?.(0, delta);
      else w?.scrollBy?.(delta, 0);
    }
  }

  // ── reporting ──────────────────────────────────────────────────────

  /** Report after the current call stack (never re-entrantly inside a batch). */
  private queueCheck(state: ListState): void {
    if (state.checkQueued) return;
    state.checkQueued = true;
    queueMicrotask(() => {
      state.checkQueued = false;
      if (this.lists.get(state.id) === state) this.check(state);
    });
  }

  private scheduleFrame(state: ListState, relayout: boolean): void {
    if (relayout) state.needsLayout = true;
    if (state.frame !== null) return;
    const { handle, cancel } = raf(() => {
      state.frame = null;
      state.frameCancel = null;
      if (this.lists.get(state.id) !== state) return;
      if (state.needsLayout) {
        state.anchor = state.laidOut ? this.captureAnchor(state) : null;
        this.layout(state);
      }
      this.check(state);
    });
    state.frame = handle;
    state.frameCancel = cancel;
  }

  /** How far the scroll container has scrolled past the list's first item. */
  private scrolledPast(state: ListState): number {
    const y = state.axis === "y";
    const el = state.element;
    const leadBase = cssLengthPx(state.leading.base) ?? 0;
    if (state.scroller === el) {
      const pos = (y ? el.scrollTop : el.scrollLeft) || 0;
      return pos - leadBase;
    }
    const r = el.getBoundingClientRect?.();
    const border = (y ? (el as { clientTop?: number }).clientTop : (el as { clientLeft?: number }).clientLeft) || 0;
    const contentStart = (r ? (y ? r.top : r.left) : 0) + border + leadBase;
    return this.viewportStart(state) - contentStart;
  }

  /** Compute the wanted range and report it when the contract says so. */
  private check(state: ListState): void {
    if (!isConnected(state.element)) return;
    if (state.scroller === undefined) this.bindScroller(state);
    const wanted = viewportReport(
      state.window,
      {
        size: state.itemSize,
        scrolledPast: this.scrolledPast(state),
        viewportExtent: this.viewportExtent(state),
        columns: this.columnsOf(state),
      },
      state.lastReported,
    );
    const engine = this.getEngine();
    if (!wanted || typeof engine.setListViewport !== "function") return;
    state.lastReported = wanted;
    engine.setListViewport(state.id, wanted.start, wanted.end);
  }

  // ── teardown ───────────────────────────────────────────────────────

  private teardown(state: ListState, restore: boolean): void {
    this.lists.delete(state.id);
    this.byElement.delete(state.element);
    this.dirty.delete(state);
    this.unbindScroller(state);
    if (state.frame !== null) state.frameCancel?.(state.frame);
    state.frame = null;
    if (!restore) return;
    const el = state.element;
    if (state.edges) {
      this.restoreEdge(el, state.edges[0], state.leading);
      this.restoreEdge(el, state.edges[1], state.trailing);
    }
    const style = el.style as unknown as Record<string, string | undefined> & { removeProperty?(n: string): void };
    if (state.prevOverflowAnchor) style.overflowAnchor = state.prevOverflowAnchor;
    else if (typeof style.removeProperty === "function") style.removeProperty("overflow-anchor");
    for (const child of state.stamped) {
      child.removeAttribute("aria-setsize");
      child.removeAttribute("aria-posinset");
    }
    state.stamped.clear();
  }
}
