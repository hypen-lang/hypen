/**
 * List virtualization — the renderer side of the `__virt.window` contract
 * (docs/virtualization.md). Pure functions shared by every TypeScript
 * renderer; native renderers port them and keep their tests aligned with
 * tests/virtualization-math.test.ts.
 *
 * Sizes are in the renderer's unit along the list's scroll axis (px / pt).
 * Items are counted in ITEMS, not children: a multi-node template renders
 * several children per item (`childrenPerItem`).
 */

/** Reserved prop the engine sets on a windowed list's element. */
export const VIRT_WINDOW_PROP = "__virt.window";

/** Size used for unmeasured items when nothing better is known. */
export const DEFAULT_ITEM_SIZE = 48;

/** Minimum overscan, in items, on each side of the visible range. */
export const MIN_OVERSCAN_ITEMS = 5;

/** The decoded `__virt.window` value: children are items `[start, end)`. */
export interface VirtWindow {
  total: number;
  start: number;
  end: number;
  estimatedSize?: number;
}

/** An item range `[start, end)`. */
export interface ItemRange {
  start: number;
  end: number;
}

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Decode a `__virt.window` prop value; `null` for anything malformed. */
export function parseVirtWindow(value: unknown): VirtWindow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.total) || !isCount(v.start) || !isCount(v.end)) return null;
  if (v.start > v.end || v.end > v.total) return null;
  const window: VirtWindow = { total: v.total, start: v.start, end: v.end };
  if (typeof v.estimatedSize === "number" && v.estimatedSize > 0) {
    window.estimatedSize = v.estimatedSize;
  }
  return window;
}

/**
 * Size to assume per item: the average measured size of the materialized
 * items, else the template's estimate, else {@link DEFAULT_ITEM_SIZE}.
 *
 * @param measuredTotal summed extent of the materialized items (0 if unknown)
 * @param measuredCount how many items that sum covers
 */
export function itemSize(
  window: VirtWindow,
  measuredTotal: number,
  measuredCount: number
): number {
  if (measuredCount > 0 && measuredTotal > 0) return measuredTotal / measuredCount;
  return window.estimatedSize ?? DEFAULT_ITEM_SIZE;
}

/**
 * Padding standing in for the items before and after the window. For a grid
 * with `columns > 1`, items lay out in rows of `columns` and `size` is a row's
 * extent.
 */
export function windowPadding(
  window: VirtWindow,
  size: number,
  columns = 1
): { leading: number; trailing: number } {
  const cols = Math.max(1, Math.floor(columns));
  const rowsBefore = Math.ceil(window.start / cols);
  const rowsTotal = Math.ceil(window.total / cols);
  const rowsAfter = Math.max(0, rowsTotal - rowsBefore - windowRows(window, cols));
  return { leading: rowsBefore * size, trailing: rowsAfter * size };
}

/**
 * Rows the materialized items occupy: `end - start` for a list; for a grid
 * with `columns > 1`, every row any of them touches. Divide the measured
 * extent of the children by this to get the row size for {@link itemSize}.
 */
export function windowRows(window: VirtWindow, columns = 1): number {
  const cols = Math.max(1, Math.floor(columns));
  return Math.ceil(window.end / cols) - Math.floor(window.start / cols);
}

/**
 * Children per item (§1): a multi-node template renders several children
 * for each item. Never less than 1, so `start + floor(childIndex / n)` is
 * always the item a child belongs to.
 */
export function childrenPerItem(window: VirtWindow, childCount: number): number {
  const items = window.end - window.start;
  if (items <= 0 || childCount <= 0) return 1;
  return Math.max(1, Math.round(childCount / items));
}

/**
 * Items the user can see.
 *
 * @param scrolledPast how far the scroll container has scrolled past the
 *   list's leading edge (0 when it hasn't reached the list)
 * @param viewportExtent the scroll container's visible extent
 */
export function visibleRange(
  total: number,
  size: number,
  scrolledPast: number,
  viewportExtent: number,
  columns = 1
): ItemRange {
  const cols = Math.max(1, Math.floor(columns));
  const s = size > 0 ? size : DEFAULT_ITEM_SIZE;
  const past = Math.max(0, scrolledPast);
  const firstRow = Math.floor(past / s);
  const lastRow = Math.ceil((past + Math.max(0, viewportExtent)) / s);
  return {
    start: clamp(firstRow * cols, 0, total),
    end: clamp(lastRow * cols, 0, total),
  };
}

/**
 * The range to ask the engine for: the visible range widened on both sides by
 * one viewport's worth of items, at least {@link MIN_OVERSCAN_ITEMS}.
 */
export function wantedRange(visible: ItemRange, total: number): ItemRange {
  const overscan = Math.max(MIN_OVERSCAN_ITEMS, visible.end - visible.start);
  return {
    start: clamp(visible.start - overscan, 0, total),
    end: clamp(visible.end + overscan, 0, total),
  };
}

/**
 * Whether to report `wanted` given the current window and the last report.
 * Report when the visible range is not covered by the window, or the window is
 * more than three times what is wanted (shrink after a fling) — never the same
 * range twice in a row.
 */
export function shouldReport(
  window: VirtWindow,
  visible: ItemRange,
  wanted: ItemRange,
  lastReported: ItemRange | null
): boolean {
  if (
    lastReported &&
    lastReported.start === wanted.start &&
    lastReported.end === wanted.end
  ) {
    return false;
  }
  const covered = visible.start >= window.start && visible.end <= window.end;
  const wantedSize = Math.max(1, wanted.end - wanted.start);
  const oversized = window.end - window.start > 3 * wantedSize;
  return !covered || oversized;
}

/**
 * Whether a newly received `__virt.window` differs in value from the previous
 * one (`null` = none yet). §3 step 4: when it does, forget `lastReported` —
 * the engine may have moved the window on its own (e.g. `total` changed) to
 * exactly the range last reported, and the renderer must be able to ask for
 * it again. An identical re-send is not a change.
 */
export function windowChanged(previous: VirtWindow | null | undefined, next: VirtWindow): boolean {
  return (
    !previous ||
    previous.total !== next.total ||
    previous.start !== next.start ||
    previous.end !== next.end ||
    previous.estimatedSize !== next.estimatedSize
  );
}

/** Where the list sits in its scroll container, for {@link viewportReport}. */
export interface ViewportGeometry {
  /** Extent of one item (one row of items for a grid). */
  size: number;
  /**
   * How far the scroll container has scrolled past the list's leading edge;
   * negative when the list starts below the top of the viewport.
   */
  scrolledPast: number;
  /** The scroll container's visible extent. */
  viewportExtent: number;
  columns?: number;
}

/**
 * §3 steps 2–4 in one call: the visible range, widened by overscan, if it
 * should be reported now — else `null`. The caller sends it with
 * `setListViewport` and keeps it as `lastReported` for the next call, and
 * resets `lastReported` to `null` when {@link windowChanged}.
 *
 * While the list starts below the top of the viewport (`scrolledPast < 0`)
 * only the part of the viewport over the list counts as visible.
 */
export function viewportReport(
  window: VirtWindow,
  geometry: ViewportGeometry,
  lastReported: ItemRange | null
): ItemRange | null {
  const { size, scrolledPast, viewportExtent, columns } = geometry;
  const extent = viewportExtent + Math.min(0, scrolledPast);
  const visible = visibleRange(window.total, size, scrolledPast, extent, columns);
  const wanted = wantedRange(visible, window.total);
  return shouldReport(window, visible, wanted, lastReported) ? wanted : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
