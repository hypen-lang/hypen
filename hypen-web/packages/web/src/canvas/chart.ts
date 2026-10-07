/**
 * Chart family — data-space drawing for the Canvas renderer.
 *
 * `Chart` owns a coordinate space. Its children are marks (`Line`, `Area`,
 * `Bars`, `Points`, `Axis`, `Rule`, `Marker`, `Path`) whose props are written
 * in DATA units, never pixels. The chart resolves the x/y domains — explicit
 * `x: [min, max]` / `y: [min, max]` ranges, or the union of its marks' data —
 * and lays every mark out against the plot rect. Marks are therefore NOT laid
 * out by Taffy: the chart is a layout leaf (see `layout.ts`), and
 * {@link layoutCharts} places its children itself, exactly the way a Video
 * places its composition slots.
 *
 * This mirrors the DOM renderer's `dom/components/chart.ts` line for line —
 * same normalisation, same nice-tick algorithm, same insets, same geometry,
 * same event payload — so a module handler cannot tell the two apart.
 *
 * Interaction. Hit testing is geometric, not box-based: a bar, a point, or a
 * line vertex resolves to its own datum (with a 12px invisible touch radius),
 * anything else on a data mark resolves to the datum nearest the pointer
 * along x. Marks with no event applicator are pointer-transparent so a
 * tooltip's `Points`/`Marker` cannot steal the pointer from the `Line` being
 * hovered.
 */

import type { VirtualNode, Rectangle } from "./types.js";
import { cssLengthToPx, inheritedTextProp, isLayoutHidden } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export type MarkKind =
  | "line"
  | "area"
  | "bars"
  | "points"
  | "axis"
  | "rule"
  | "marker"
  | "path";

export const CHART_MARK_TYPES: ReadonlyArray<MarkKind> = [
  "line",
  "area",
  "bars",
  "points",
  "axis",
  "rule",
  "marker",
  "path",
];

const MARK_KINDS: ReadonlySet<string> = new Set(CHART_MARK_TYPES);

/** Marks that carry data and therefore take part in domain resolution. */
const DATA_MARKS: ReadonlySet<MarkKind> = new Set(["line", "area", "bars", "points"]);

export const CHART_DEFAULTS = {
  width: 320,
  height: 200,
  /** Plot inset when no axis asks for label room (sparkline mode). */
  bareInset: 4,
  insetTop: 10,
  insetRight: 12,
  /** Room for a y axis' tick labels. */
  insetLeft: 44,
  /** Room for an x axis' tick labels. */
  insetBottom: 28,
  ticks: 5,
  pointRadius: 3.5,
  /** Invisible touch target radius around a point or line vertex. */
  hitRadius: 12,
  barWidth: 0.7,
  dimmedOpacity: 0.45,
  fontSize: 11,
  /** Gap between a Marker's anchor point and its content. */
  markerGap: 8,
} as const;

export interface Datum {
  x: number | string;
  y: number;
  index: number;
  raw: unknown;
}

interface Scale {
  kind: "linear" | "band";
  min: number;
  max: number;
  categories: string[];
  /** Pixel range; y runs bottom→top so range[0] > range[1]. */
  range: [number, number];
  /** Data → pixel. Null for a category the scale does not know. */
  map(value: number | string): number | null;
  /** Pixel → data (numeric position; band index for categorical). */
  invert(px: number): number;
  /** Width of one categorical band, or the pixel step implied by bar count. */
  band: number;
}

export interface MarkState {
  node: VirtualNode;
  kind: MarkKind;
  data: Datum[];
}

export interface ChartGeometry {
  /** The chart's own box, in absolute layout pixels. */
  rect: Rectangle;
  /** The plot area inside the insets, in absolute layout pixels. */
  plot: Rectangle;
  x: Scale;
  y: Scale;
  marks: MarkState[];
}

/** Resolved geometry per chart node, refreshed by every layout pass. */
const geometries = new WeakMap<VirtualNode, ChartGeometry>();

/** Per-mark normalised data, refreshed alongside the chart geometry. */
const markStates = new WeakMap<VirtualNode, MarkState>();

// ============================================================================
// Node predicates
// ============================================================================

export function isChartNode(node: VirtualNode): boolean {
  // Nodes reach the dispatcher from the accessibility mirror and from tests
  // as partial shapes; a missing type is "not a chart", never a crash.
  return typeof node?.type === "string" && node.type.toLowerCase() === "chart";
}

/** The mark kind of a DIRECT child of a Chart, or null for anything else. */
export function chartMarkKind(node: VirtualNode): MarkKind | null {
  if (typeof node?.type !== "string") return null;
  const type = node.type.toLowerCase();
  if (!MARK_KINDS.has(type)) return null;
  if (!node.parent || !isChartNode(node.parent)) return null;
  return type as MarkKind;
}

/** True for a node the chart lays out itself (any direct child of a Chart). */
export function isChartMarkNode(node: VirtualNode): boolean {
  return node.parent !== null && isChartNode(node.parent);
}

// ============================================================================
// Prop reading
// ============================================================================

/**
 * Read a prop under both the flat name and the single-positional applicator
 * form. Constructor arguments (`points:`, `smooth:`) arrive flat; applicators
 * (`.stroke("#f00")`) arrive as `stroke.0` and are additionally flattened by
 * `normalizeAllApplicators` — reading both keeps a mark working whichever
 * shape the engine emitted.
 */
function prop(props: Record<string, any>, name: string): any {
  const flat = props[name];
  if (flat !== undefined) return flat;
  return props[`${name}.0`];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** x keeps strings (categories); anything else must be numeric. */
function toX(value: unknown): number | string | null {
  const n = toNumber(value);
  if (n !== null) return n;
  if (typeof value === "string" && value !== "") return value;
  return null;
}

function toBool(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value === "true" || value === "";
  if (typeof value === "number") return value !== 0;
  return false;
}

function readList(props: Record<string, any>): unknown[] {
  const candidates = [prop(props, "points"), prop(props, "data"), prop(props, "values"), props["0"]];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (typeof c === "string") {
      // A list literal can arrive JSON-encoded over the wire.
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not JSON */
      }
    }
  }
  return [];
}

/**
 * Normalise a mark's list prop into `{x, y}` data. Field names for object
 * rows come from `x:` / `y:` (Bars also accepts `label:` / `value:`).
 */
export function normalizeData(props: Record<string, any>): Datum[] {
  const list = readList(props);
  const xRaw = prop(props, "x");
  const yRaw = prop(props, "y");
  const labelRaw = prop(props, "label");
  const valueRaw = prop(props, "value");
  const xField = typeof xRaw === "string" ? xRaw : typeof labelRaw === "string" ? labelRaw : "x";
  const yField = typeof yRaw === "string" ? yRaw : typeof valueRaw === "string" ? valueRaw : "y";
  const out: Datum[] = [];
  list.forEach((raw, index) => {
    let x: number | string | null = null;
    let y: number | null = null;
    if (Array.isArray(raw)) {
      x = toX(raw[0]);
      y = toNumber(raw[1]);
    } else if (raw && typeof raw === "object") {
      const row = raw as Record<string, unknown>;
      x = toX(row[xField]);
      y = toNumber(row[yField]);
      if (x === null && !(xField in row)) x = index;
    } else {
      x = index;
      y = toNumber(raw);
    }
    if (x === null || y === null) return;
    out.push({ x, y, index, raw });
  });
  return out;
}

// ============================================================================
// Scales
// ============================================================================

function linearScale(min: number, max: number, range: [number, number]): Scale {
  const span = max - min || 1;
  const px = range[1] - range[0];
  return {
    kind: "linear",
    min,
    max,
    categories: [],
    range,
    band: 0,
    map(value) {
      const n = toNumber(value);
      if (n === null) return null;
      return range[0] + ((n - min) / span) * px;
    },
    invert(p) {
      return min + ((p - range[0]) / (px || 1)) * span;
    },
  };
}

function bandScale(categories: string[], range: [number, number]): Scale {
  const n = Math.max(categories.length, 1);
  const width = range[1] - range[0];
  const band = width / n;
  const index = new Map(categories.map((c, i) => [c, i] as const));
  return {
    kind: "band",
    min: 0,
    max: n,
    categories,
    range,
    band,
    map(value) {
      const i = index.get(String(value));
      if (i === undefined) return null;
      return range[0] + (i + 0.5) * band;
    },
    invert(p) {
      return (p - range[0]) / (band || 1);
    },
  };
}

/** Round a domain out to tick-friendly bounds. */
export function niceDomain(min: number, max: number, count: number): [number, number] {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return [min - pad, max + pad];
  }
  const step = niceStep(min, max, count);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

function niceStep(min: number, max: number, count: number): number {
  const raw = (max - min) / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // d3's thresholds: pick the 1/2/5 step whose tick count lands nearest `count`.
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

export function ticks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const step = niceStep(min, max, count);
  const out: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 1e-9; v += step) {
    out.push(round(v));
  }
  return out;
}

function round(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(12));
}

export function formatTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(3)));
}

function readRange(value: unknown): [number, number] | null {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length < 2) return null;
  const a = toNumber(list[0]);
  const b = toNumber(list[1]);
  if (a === null || b === null) return null;
  return a <= b ? [a, b] : [b, a];
}

// ============================================================================
// Geometry
// ============================================================================

function axisOf(props: Record<string, any>): "x" | "y" {
  const raw = prop(props, "axis") ?? props["0"];
  return String(raw ?? "x").toLowerCase() === "y" ? "y" : "x";
}

function hasAxis(marks: MarkState[], which: "x" | "y"): boolean {
  return marks.some((m) => m.kind === "axis" && axisOf(m.node.props) === which);
}

function insets(
  props: Record<string, any>,
  marks: MarkState[],
): { top: number; right: number; bottom: number; left: number } {
  const p = toNumber(prop(props, "padding"));
  if (p !== null) return { top: p, right: p, bottom: p, left: p };
  const xAxis = hasAxis(marks, "x");
  const yAxis = hasAxis(marks, "y");
  if (!xAxis && !yAxis) {
    const b = CHART_DEFAULTS.bareInset;
    return { top: b, right: b, bottom: b, left: b };
  }
  return {
    top: CHART_DEFAULTS.insetTop,
    right: CHART_DEFAULTS.insetRight,
    bottom: xAxis ? CHART_DEFAULTS.insetBottom : CHART_DEFAULTS.bareInset,
    left: yAxis ? CHART_DEFAULTS.insetLeft : CHART_DEFAULTS.bareInset,
  };
}

function collectMarks(chart: VirtualNode): MarkState[] {
  const out: MarkState[] = [];
  for (const child of chart.children) {
    const kind = chartMarkKind(child);
    if (kind === null) continue;
    const state: MarkState = {
      node: child,
      kind,
      data: DATA_MARKS.has(kind) ? normalizeData(child.props) : [],
    };
    markStates.set(child, state);
    out.push(state);
  }
  return out;
}

/** Resolve domains: explicit chart ranges win, else the union of mark data. */
function resolveScales(
  props: Record<string, any>,
  plot: Rectangle,
  marks: MarkState[],
): { x: Scale; y: Scale } {
  const xRange: [number, number] = [plot.x, plot.x + plot.width];
  const yRange: [number, number] = [plot.y + plot.height, plot.y];

  const categories: string[] = [];
  const seen = new Set<string>();
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let anyData = false;
  let bars = 0;

  for (const mark of marks) {
    if (mark.kind === "bars") {
      bars = Math.max(bars, mark.data.length);
      // Bars grow from zero: a bar chart whose data never touches 0 still
      // has to show 0 or the bar heights lie.
      yMin = Math.min(yMin, 0);
      yMax = Math.max(yMax, 0);
    }
    if (DATA_MARKS.has(mark.kind)) {
      for (const d of mark.data) {
        anyData = true;
        if (typeof d.x === "string") {
          if (!seen.has(d.x)) {
            seen.add(d.x);
            categories.push(d.x);
          }
        } else {
          xMin = Math.min(xMin, d.x);
          xMax = Math.max(xMax, d.x);
        }
        yMin = Math.min(yMin, d.y);
        yMax = Math.max(yMax, d.y);
      }
    }
    if (mark.kind === "rule" || mark.kind === "marker") {
      const y = toNumber(prop(mark.node.props, "y"));
      if (y !== null) {
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
      const x = toX(prop(mark.node.props, "x"));
      if (typeof x === "number") {
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
      }
    }
  }

  const explicitX = readRange(prop(props, "x"));
  const explicitY = readRange(prop(props, "y"));

  let x: Scale;
  if (categories.length > 0) {
    x = bandScale(categories, xRange);
  } else {
    let [lo, hi] = explicitX ?? (Number.isFinite(xMin) ? [xMin, xMax] : [0, 1]);
    if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
    x = linearScale(lo, hi, xRange);
    // Numeric bars need a step to size their width from.
    x.band = bars > 1 ? (xRange[1] - xRange[0]) / bars : bars === 1 ? (xRange[1] - xRange[0]) / 2 : 0;
  }

  let y: Scale;
  if (explicitY) {
    y = linearScale(explicitY[0], explicitY[1], yRange);
  } else if (Number.isFinite(yMin)) {
    const [lo, hi] = anyData || bars > 0 ? niceDomain(yMin, yMax, CHART_DEFAULTS.ticks) : [yMin, yMax];
    y = linearScale(lo, hi, yRange);
  } else {
    y = linearScale(0, 1, yRange);
  }
  return { x, y };
}

/**
 * Recompute (and cache) a chart's plot rect, scales and per-mark data from
 * its current box. Returns null when the chart has not been laid out yet.
 */
export function computeChartGeometry(chart: VirtualNode): ChartGeometry | null {
  const layout = chart.layout;
  if (!layout) return null;
  const rect: Rectangle = {
    x: layout.x,
    y: layout.y,
    width: layout.width > 0 ? layout.width : CHART_DEFAULTS.width,
    height: layout.height > 0 ? layout.height : CHART_DEFAULTS.height,
  };
  const marks = collectMarks(chart);
  const inset = insets(chart.props, marks);
  const plot: Rectangle = {
    x: rect.x + inset.left,
    y: rect.y + inset.top,
    width: Math.max(rect.width - inset.left - inset.right, 1),
    height: Math.max(rect.height - inset.top - inset.bottom, 1),
  };
  const scales = resolveScales(chart.props, plot, marks);
  const geometry: ChartGeometry = { rect, plot, x: scales.x, y: scales.y, marks };
  geometries.set(chart, geometry);
  return geometry;
}

/**
 * The chart's resolved geometry, computed on demand when a paint or hit test
 * runs before (or without) a layout pass.
 */
export function chartGeometry(chart: VirtualNode): ChartGeometry | null {
  const cached = geometries.get(chart);
  if (cached) return cached;
  return computeChartGeometry(chart);
}

/** Read-only view of a chart's resolved scales, for tests and tooling. */
export function inspectChart(chart: VirtualNode): {
  plot: Rectangle;
  x: { kind: string; min: number; max: number; categories: string[] };
  y: { kind: string; min: number; max: number };
} | null {
  const g = chartGeometry(chart);
  if (!g) return null;
  return {
    plot: { ...g.plot },
    x: { kind: g.x.kind, min: g.x.min, max: g.x.max, categories: [...g.x.categories] },
    y: { kind: g.y.kind, min: g.y.min, max: g.y.max },
  };
}

function markStateOf(node: VirtualNode): MarkState | null {
  const chart = node.parent;
  if (!chart || !isChartNode(chart)) return null;
  // Geometry resolution refreshes every mark's normalised data.
  chartGeometry(chart);
  return markStates.get(node) ?? null;
}

// ============================================================================
// Projection
// ============================================================================

type Projected = [number, number, Datum];

function project(data: Datum[], g: ChartGeometry): Projected[] {
  const out: Projected[] = [];
  for (const d of data) {
    const px = g.x.map(d.x);
    const py = g.y.map(d.y);
    if (px === null || py === null) continue;
    out.push([px, py, d]);
  }
  return out;
}

/** The pixel y of the zero line, clamped into the y domain. */
function zeroLine(g: ChartGeometry): number {
  const value = Math.min(Math.max(0, g.y.min), g.y.max);
  return g.y.map(value) ?? g.plot.y + g.plot.height;
}

function barMetrics(mark: MarkState, g: ChartGeometry, count: number): number {
  const ratio = toNumber(prop(mark.node.props, "barWidth")) ?? CHART_DEFAULTS.barWidth;
  const step = g.x.band > 0 ? g.x.band : g.plot.width / Math.max(count, 1);
  return Math.max(step * Math.min(Math.max(ratio, 0.05), 1), 1);
}

function highlightSet(value: unknown): Set<number> | null {
  if (value === undefined || value === null || value === "" || value === false) return null;
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  const items = Array.isArray(list) ? list : [list];
  const out = new Set<number>();
  for (const item of items) {
    const n = toNumber(item);
    if (n !== null) out.add(n);
  }
  return out;
}

/** Catmull-Rom → cubic Bézier control points, the usual "smooth" line. */
function smoothSegments(
  pts: Array<[number, number]>,
): Array<[number, number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(i + 2, pts.length - 1)]!;
    out.push([
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    ]);
  }
  return out;
}

// ============================================================================
// Layout
// ============================================================================

/** Lay a subtree out at its intrinsic size; supplied by `layout.ts`. */
export type SubtreeLayout = (
  node: VirtualNode,
  maxWidth: number,
  maxHeight: number,
  x: number,
  y: number,
) => void;

/** Collapse a subtree to a zero box — laid out, never painted, never hit. */
function collapseSubtree(node: VirtualNode, x: number, y: number): void {
  node.layout = {
    x,
    y,
    width: 0,
    height: 0,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: 0,
    contentHeight: 0,
  };
  for (const child of node.children) collapseSubtree(child, x, y);
}

function translateSubtree(node: VirtualNode, dx: number, dy: number): void {
  if (node.layout) {
    node.layout.x += dx;
    node.layout.y += dy;
  }
  for (const child of node.children) translateSubtree(child, dx, dy);
}

/** Give a mark the chart's own box, so paint culling and dirty rects work. */
function fillMarkBox(mark: VirtualNode, rect: Rectangle): void {
  mark.layout = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: rect.width,
    contentHeight: rect.height,
  };
}

const MARKER_ANCHORS = new Set(["top", "bottom", "left", "right", "center"]);

/**
 * Place one Marker: its Hypen children are laid out normally (intrinsic
 * size, like any other subtree) and the whole box is then moved to the data
 * point per the anchor rule. Both coordinates missing hides it; one missing
 * centres it on that axis.
 */
function layoutMarker(mark: VirtualNode, g: ChartGeometry, layoutSubtree: SubtreeLayout): void {
  const plot = g.plot;
  const x = toX(prop(mark.props, "x"));
  const y = toNumber(prop(mark.props, "y"));
  const px = x === null ? plot.x + plot.width / 2 : g.x.map(x);
  const py = y === null ? plot.y + plot.height / 2 : g.y.map(y);
  if ((x === null && y === null) || px === null || py === null) {
    collapseSubtree(mark, plot.x, plot.y);
    return;
  }

  layoutSubtree(mark, plot.width, plot.height, 0, 0);
  const box = mark.layout;
  if (!box) return;
  const w = box.width;
  const h = box.height;
  const gap = CHART_DEFAULTS.markerGap;
  const raw = String(prop(mark.props, "anchor") ?? "top").toLowerCase();
  const anchor = MARKER_ANCHORS.has(raw) ? raw : "top";

  let left: number;
  let top: number;
  switch (anchor) {
    case "bottom":
      left = px - w / 2;
      top = py + gap;
      break;
    case "left":
      left = px - w - gap;
      top = py - h / 2;
      break;
    case "right":
      left = px + gap;
      top = py - h / 2;
      break;
    case "center":
      left = px - w / 2;
      top = py - h / 2;
      break;
    default:
      left = px - w / 2;
      top = py - h - gap;
      break;
  }
  translateSubtree(mark, left - box.x, top - box.y);
}

/**
 * Lay out every Chart in the tree: resolve its geometry, then place its
 * marks. Called at the end of the layout pass (the chart itself is a Taffy
 * leaf, so nothing below it has a box yet).
 */
export function layoutCharts(root: VirtualNode, layoutSubtree: SubtreeLayout): void {
  if (isChartNode(root) && root.layout) {
    const g = computeChartGeometry(root);
    if (g) {
      for (const child of root.children) {
        if (isLayoutHidden(child)) {
          collapseSubtree(child, g.plot.x, g.plot.y);
          continue;
        }
        const kind = chartMarkKind(child);
        if (kind === "marker") {
          layoutMarker(child, g, layoutSubtree);
          continue;
        }
        // Non-Marker marks draw across the whole chart box; anything that is
        // not a mark at all renders nothing and reserves nothing.
        if (kind === null) collapseSubtree(child, g.plot.x, g.plot.y);
        else fillMarkBox(child, g.rect);
      }
    }
  }
  for (const child of root.children) layoutCharts(child, layoutSubtree);
}

// ============================================================================
// Paint style resolution
// ============================================================================

interface MarkStyle {
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  dash: number[] | null;
  lineCap: CanvasLineCap;
  blend: string | null;
}

const MARK_STYLE_DEFAULTS: Record<
  MarkKind,
  { stroke: boolean; fill: boolean; strokeWidth: number; fillOpacity: number; strokeOpacity: number; dash: number[] | null }
> = {
  line: { stroke: true, fill: false, strokeWidth: 2, fillOpacity: 1, strokeOpacity: 1, dash: null },
  area: { stroke: false, fill: true, strokeWidth: 0, fillOpacity: 0.15, strokeOpacity: 1, dash: null },
  bars: { stroke: false, fill: true, strokeWidth: 0, fillOpacity: 1, strokeOpacity: 1, dash: null },
  points: { stroke: false, fill: true, strokeWidth: 0, fillOpacity: 1, strokeOpacity: 1, dash: null },
  axis: { stroke: true, fill: true, strokeWidth: 1, fillOpacity: 0.75, strokeOpacity: 0.5, dash: null },
  rule: { stroke: true, fill: false, strokeWidth: 1, fillOpacity: 1, strokeOpacity: 0.7, dash: [4, 4] },
  marker: { stroke: false, fill: false, strokeWidth: 0, fillOpacity: 1, strokeOpacity: 1, dash: null },
  path: { stroke: true, fill: false, strokeWidth: 2, fillOpacity: 1, strokeOpacity: 1, dash: null },
};

function parseDash(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const out = value.map((v) => toNumber(v) ?? 0);
    return out.length > 0 ? out : null;
  }
  if (typeof value === "number") return [value];
  if (typeof value === "string" && value.trim() !== "") {
    if (value.trim() === "none") return null;
    const out = value
      .split(/[\s,]+/)
      .map((part) => toNumber(part))
      .filter((n): n is number => n !== null);
    return out.length > 0 ? out : null;
  }
  return null;
}

function isNone(value: unknown): boolean {
  return value === "none" || value === false || value === null;
}

/**
 * The mark's resolved paint. `stroke`/`fill` default to the inherited text
 * colour (the chart's `.color()`), exactly as `currentColor` does on SVG.
 */
export function resolveMarkStyle(node: VirtualNode, kind: MarkKind): MarkStyle {
  const props = node.props;
  const defaults = MARK_STYLE_DEFAULTS[kind];
  const inherited = inheritedTextProp(node, "color");
  const base = typeof inherited === "string" && inherited !== "" ? inherited : "#000000";

  const strokeRaw = prop(props, "stroke");
  const fillRaw = prop(props, "fill");
  const stroke = strokeRaw !== undefined
    ? (isNone(strokeRaw) ? null : String(strokeRaw))
    : defaults.stroke ? base : null;
  const fill = fillRaw !== undefined
    ? (isNone(fillRaw) ? null : String(fillRaw))
    : defaults.fill ? base : null;

  const capRaw = prop(props, "strokeLinecap");
  return {
    stroke,
    fill,
    strokeWidth: cssLengthToPx(prop(props, "strokeWidth")) ?? defaults.strokeWidth,
    fillOpacity: toNumber(prop(props, "fillOpacity")) ?? defaults.fillOpacity,
    strokeOpacity: toNumber(prop(props, "strokeOpacity")) ?? defaults.strokeOpacity,
    dash: prop(props, "strokeDasharray") !== undefined
      ? parseDash(prop(props, "strokeDasharray"))
      : defaults.dash,
    lineCap: (typeof capRaw === "string" ? capRaw : "round") as CanvasLineCap,
    blend: typeof prop(props, "mixBlendMode") === "string" ? String(prop(props, "mixBlendMode")) : null,
  };
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * `glow(...)` and the shadow family both mean "a shadow of the painted
 * shape" on a mark — a box shadow would be invisible around geometry — so
 * both land on the 2D context's shadow API.
 */
function applyMarkEffects(
  ctx: CanvasRenderingContext2D,
  props: Record<string, any>,
  defaultColor: string,
): void {
  const glow = prop(props, "glow");
  if (glow !== undefined && glow !== null && glow !== false) {
    let color = defaultColor;
    let radius = 6;
    if (typeof glow === "number") radius = glow;
    else if (typeof glow === "string") color = glow;
    else if (typeof glow === "object") {
      const obj = glow as Record<string, unknown>;
      if (obj.color != null) color = String(obj.color);
      if (obj.radius != null) radius = toNumber(obj.radius) ?? radius;
      else if (obj.blur != null) radius = toNumber(obj.blur) ?? radius;
    }
    ctx.shadowColor = color;
    ctx.shadowBlur = radius;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return;
  }

  const elevation = toNumber(prop(props, "elevation"));
  if (elevation !== null && elevation > 0) {
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = elevation * 2;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = elevation / 2;
    return;
  }

  const shadow =
    prop(props, "shadow") ?? prop(props, "boxShadow") ?? prop(props, "dropShadow");
  if (shadow === undefined || shadow === null || shadow === false) return;
  if (typeof shadow === "string") {
    const parts = shadow.trim().split(/\s+/);
    ctx.shadowOffsetX = toNumber(parts[0]) ?? 0;
    ctx.shadowOffsetY = toNumber(parts[1]) ?? 0;
    ctx.shadowBlur = toNumber(parts[2]) ?? 0;
    ctx.shadowColor = parts.slice(3).join(" ") || "rgba(0,0,0,0.3)";
  } else if (typeof shadow === "object") {
    const obj = shadow as Record<string, unknown>;
    ctx.shadowOffsetX = toNumber(obj.offsetX) ?? 0;
    ctx.shadowOffsetY = toNumber(obj.offsetY) ?? 0;
    ctx.shadowBlur = toNumber(obj.blur) ?? 0;
    ctx.shadowColor = obj.color != null ? String(obj.color) : "rgba(0,0,0,0.3)";
  }
}

function setDash(ctx: CanvasRenderingContext2D, dash: number[] | null): void {
  if (typeof ctx.setLineDash !== "function") return;
  ctx.setLineDash(dash ?? []);
}

// ============================================================================
// Paint
// ============================================================================

/**
 * Paint one chart mark. Called from the painter dispatch in `paint.ts` for
 * every direct child of a Chart; a Marker paints nothing itself (its Hypen
 * children are ordinary nodes and paint themselves).
 *
 * Returns false when the node is not a mark of a Chart at all, so the
 * dispatcher can fall back to the ordinary container paint — `Line` outside
 * a `Chart` is just an unknown component, not a chart mark.
 */
export function paintChartMark(ctx: CanvasRenderingContext2D, node: VirtualNode): boolean {
  const chart = node.parent;
  if (!chart || !isChartNode(chart)) return false;
  const kind = chartMarkKind(node);
  if (kind === null) return false;
  if (kind === "marker") return true;
  const g = chartGeometry(chart);
  if (!g) return true;
  const mark = markStates.get(node);
  if (!mark) return true;

  const style = resolveMarkStyle(node, kind);
  const alpha = ctx.globalAlpha;

  ctx.save();
  if (style.blend) {
    try {
      ctx.globalCompositeOperation = style.blend as GlobalCompositeOperation;
    } catch {
      /* unsupported blend mode */
    }
  }
  applyMarkEffects(ctx, node.props, style.stroke ?? style.fill ?? "#000000");
  setDash(ctx, style.dash);
  ctx.lineWidth = style.strokeWidth;
  ctx.lineCap = style.lineCap;
  ctx.lineJoin = "round";

  switch (kind) {
    case "line":
      paintLine(ctx, mark, g, style, alpha);
      break;
    case "area":
      paintArea(ctx, mark, g, style, alpha);
      break;
    case "bars":
      paintBars(ctx, mark, g, style, alpha);
      break;
    case "points":
      paintPoints(ctx, mark, g, style, alpha);
      break;
    case "axis":
      paintAxis(ctx, mark, g, style, alpha);
      break;
    case "rule":
      paintRule(ctx, mark, g, style, alpha);
      break;
    case "path":
      paintPath(ctx, mark, g, style, alpha);
      break;
  }

  setDash(ctx, null);
  clearShadow(ctx);
  ctx.globalAlpha = alpha;
  ctx.restore();
  return true;
}

function tracePolyline(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]>,
  smooth: boolean,
): void {
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  if (smooth && pts.length >= 3) {
    for (const [c1x, c1y, c2x, c2y, x, y] of smoothSegments(pts)) {
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    }
    return;
  }
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
}

function paintLine(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const pts = project(mark.data, g).map(([x, y]) => [x, y] as [number, number]);
  if (pts.length === 0 || !style.stroke) return;
  ctx.beginPath();
  tracePolyline(ctx, pts, toBool(prop(mark.node.props, "smooth")));
  ctx.strokeStyle = style.stroke;
  ctx.globalAlpha = alpha * style.strokeOpacity;
  ctx.stroke();
  ctx.globalAlpha = alpha;
}

function paintArea(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const pts = project(mark.data, g).map(([x, y]) => [x, y] as [number, number]);
  if (pts.length === 0 || !style.fill) return;
  const base = zeroLine(g);
  ctx.beginPath();
  tracePolyline(ctx, pts, toBool(prop(mark.node.props, "smooth")));
  ctx.lineTo(pts[pts.length - 1]![0], base);
  ctx.lineTo(pts[0]![0], base);
  ctx.closePath();
  ctx.fillStyle = style.fill;
  ctx.globalAlpha = alpha * style.fillOpacity;
  ctx.fill();
  ctx.globalAlpha = alpha;
  if (style.stroke) {
    ctx.strokeStyle = style.stroke;
    ctx.globalAlpha = alpha * style.strokeOpacity;
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function paintBars(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const pts = project(mark.data, g);
  if (pts.length === 0 || !style.fill) return;
  const width = barMetrics(mark, g, pts.length);
  const zero = zeroLine(g);
  const radius = toNumber(prop(mark.node.props, "radius")) ?? 0;
  const highlight = highlightSet(prop(mark.node.props, "highlight"));

  ctx.fillStyle = style.fill;
  for (const [px, py, datum] of pts) {
    const top = Math.min(py, zero);
    const height = Math.abs(zero - py);
    const dimmed = highlight !== null && !highlight.has(datum.index);
    ctx.globalAlpha = alpha * (dimmed ? CHART_DEFAULTS.dimmedOpacity : style.fillOpacity);
    ctx.beginPath();
    traceRoundedRect(ctx, px - width / 2, top, width, height, radius);
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
}

function paintPoints(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const pts = project(mark.data, g);
  if (pts.length === 0 || !style.fill) return;
  const r = toNumber(prop(mark.node.props, "radius")) ?? CHART_DEFAULTS.pointRadius;
  const highlight = highlightSet(prop(mark.node.props, "highlight"));

  ctx.fillStyle = style.fill;
  for (const [px, py, datum] of pts) {
    const dimmed = highlight !== null && !highlight.has(datum.index);
    ctx.globalAlpha = alpha * (dimmed ? CHART_DEFAULTS.dimmedOpacity : style.fillOpacity);
    ctx.beginPath();
    ctx.arc(px, py, Math.max(r, 0), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
}

function paintAxis(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const props = mark.node.props;
  const which = axisOf(props);
  const plot = g.plot;
  const count = toNumber(prop(props, "ticks")) ?? CHART_DEFAULTS.ticks;
  const grid = toBool(prop(props, "grid"));
  const labelRaw = prop(props, "label");
  const label = typeof labelRaw === "string" && labelRaw !== "" ? labelRaw : null;
  const fontSize = CHART_DEFAULTS.fontSize;
  const stroke = style.stroke;
  const fill = style.fill;

  const line = (x1: number, y1: number, x2: number, y2: number, opacity: number) => {
    if (!stroke) return;
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = alpha * opacity;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";

  if (which === "x") {
    const axisY = plot.y + plot.height;
    line(plot.x, axisY, plot.x + plot.width, axisY, style.strokeOpacity);
    const entries: Array<[number, string]> =
      g.x.kind === "band"
        ? g.x.categories.map((c) => [g.x.map(c) ?? 0, c] as [number, string])
        : ticks(g.x.min, g.x.max, count).map((v) => [g.x.map(v) ?? 0, formatTick(v)] as [number, string]);
    for (const [px] of entries) {
      line(px, axisY, px, axisY + 4, style.strokeOpacity);
      if (grid) line(px, plot.y, px, axisY, 0.15);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = alpha * style.fillOpacity;
      ctx.textAlign = "center";
      for (const [px, text] of entries) ctx.fillText(text, px, axisY + 6 + fontSize);
      if (label) {
        ctx.fillText(
          label,
          plot.x + plot.width / 2,
          Math.min(g.rect.y + g.rect.height - 2, axisY + 8 + fontSize * 2),
        );
      }
    }
  } else {
    const axisX = plot.x;
    line(axisX, plot.y, axisX, plot.y + plot.height, style.strokeOpacity);
    const values = ticks(g.y.min, g.y.max, count);
    for (const v of values) {
      const py = g.y.map(v) ?? 0;
      line(axisX - 4, py, axisX, py, style.strokeOpacity);
      if (grid) line(axisX, py, plot.x + plot.width, py, 0.15);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = alpha * style.fillOpacity;
      ctx.textAlign = "right";
      for (const v of values) {
        const py = g.y.map(v) ?? 0;
        ctx.fillText(formatTick(v), axisX - 7, py + fontSize / 3);
      }
      if (label) {
        const cy = plot.y + plot.height / 2;
        ctx.save();
        ctx.translate(g.rect.x + fontSize, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left";
}

function paintRule(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const seg = ruleSegment(mark.node.props, g);
  if (!seg || !style.stroke) return;
  ctx.strokeStyle = style.stroke;
  ctx.globalAlpha = alpha * style.strokeOpacity;
  ctx.beginPath();
  ctx.moveTo(seg[0], seg[1]);
  ctx.lineTo(seg[2], seg[3]);
  ctx.stroke();
  ctx.globalAlpha = alpha;
}

/** The rule's line in pixels: `[x1, y1, x2, y2]`, or null when off-scale. */
function ruleSegment(
  props: Record<string, any>,
  g: ChartGeometry,
): [number, number, number, number] | null {
  const plot = g.plot;
  const y = toNumber(prop(props, "y"));
  const x = toX(prop(props, "x"));
  if (y !== null) {
    const py = g.y.map(y);
    if (py === null) return null;
    return [plot.x, py, plot.x + plot.width, py];
  }
  if (x !== null) {
    const px = g.x.map(x);
    if (px === null) return null;
    return [px, plot.y, px, plot.y + plot.height];
  }
  return null;
}

function paintPath(
  ctx: CanvasRenderingContext2D,
  mark: MarkState,
  g: ChartGeometry,
  style: MarkStyle,
  alpha: number,
): void {
  const subpaths = pathSubpaths(mark.node.props, g);
  if (subpaths.length === 0) return;
  ctx.beginPath();
  for (const sub of subpaths) {
    if (sub.points.length === 0) continue;
    ctx.moveTo(sub.points[0]![0], sub.points[0]![1]);
    for (let i = 1; i < sub.points.length; i++) {
      ctx.lineTo(sub.points[i]![0], sub.points[i]![1]);
    }
    if (sub.closed) ctx.closePath();
  }
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.globalAlpha = alpha * style.fillOpacity;
    ctx.fill();
  }
  if (style.stroke) {
    ctx.strokeStyle = style.stroke;
    ctx.globalAlpha = alpha * style.strokeOpacity;
    // Non-scaling stroke: the DATA→pixel transform is baked into the
    // coordinates, never into the context, so the stroke keeps its width.
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
}

// ============================================================================
// Path parsing — SVG path data in DATA units
// ============================================================================

interface SubPath {
  points: Array<[number, number]>;
  closed: boolean;
}

/**
 * Parse `d` and map every coordinate through the chart's affine transform
 * (x scale, y scale flipped). Curves are flattened to line segments, which
 * is what the canvas needs anyway; elliptical arcs degrade to their end
 * point (the DSL's `Path` is for computed outlines, not arc art).
 */
export function pathSubpaths(props: Record<string, any>, g: ChartGeometry): SubPath[] {
  const raw = prop(props, "d") ?? props["0"];
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const sx = (g.x.range[1] - g.x.range[0]) / ((g.x.max - g.x.min) || 1);
  const sy = (g.y.range[1] - g.y.range[0]) / ((g.y.max - g.y.min) || 1);
  const tx = g.x.range[0] - g.x.min * sx;
  const ty = g.y.range[0] - g.y.min * sy;
  const map = (x: number, y: number): [number, number] => [x * sx + tx, y * sy + ty];

  const tokens = raw.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: SubPath[] = [];
  let current: SubPath | null = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let command = "";
  let i = 0;

  const num = (): number => {
    const v = Number(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  const push = (x: number, y: number) => {
    if (!current) {
      current = { points: [], closed: false };
      out.push(current);
    }
    current.points.push(map(x, y));
  };
  const CURVE_STEPS = 16;

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      i++;
      if (command === "Z" || command === "z") {
        if (current) current.closed = true;
        cx = startX;
        cy = startY;
        current = null;
        continue;
      }
    }
    if (!command) {
      i++;
      continue;
    }
    const rel = command === command.toLowerCase();
    const base = command.toUpperCase();

    switch (base) {
      case "M": {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        current = { points: [], closed: false };
        out.push(current);
        cx = x;
        cy = y;
        startX = x;
        startY = y;
        push(x, y);
        // Implicit subsequent pairs are line-tos.
        command = rel ? "l" : "L";
        break;
      }
      case "L": {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = x;
        cy = y;
        push(x, y);
        break;
      }
      case "H": {
        const x = num() + (rel ? cx : 0);
        cx = x;
        push(cx, cy);
        break;
      }
      case "V": {
        const y = num() + (rel ? cy : 0);
        cy = y;
        push(cx, cy);
        break;
      }
      case "C":
      case "S": {
        const c1x = base === "C" ? num() + (rel ? cx : 0) : cx;
        const c1y = base === "C" ? num() + (rel ? cy : 0) : cy;
        const c2x = num() + (rel ? cx : 0);
        const c2y = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const mt = 1 - t;
          push(
            mt * mt * mt * cx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x,
            mt * mt * mt * cy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y,
          );
        }
        cx = x;
        cy = y;
        break;
      }
      case "Q":
      case "T": {
        const qx = base === "Q" ? num() + (rel ? cx : 0) : cx;
        const qy = base === "Q" ? num() + (rel ? cy : 0) : cy;
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const mt = 1 - t;
          push(mt * mt * cx + 2 * mt * t * qx + t * t * x, mt * mt * cy + 2 * mt * t * qy + t * t * y);
        }
        cx = x;
        cy = y;
        break;
      }
      case "A": {
        // rx ry rotation large-arc sweep x y — flattened to its end point.
        num();
        num();
        num();
        num();
        num();
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = x;
        cy = y;
        push(x, y);
        break;
      }
      default:
        i++;
        break;
    }
  }
  return out.filter((s) => s.points.length > 0);
}

// ============================================================================
// Interaction
// ============================================================================

/** Event applicators that make a mark hittable. */
const MARK_EVENT_PROPS = [
  "onClick",
  "onPress",
  "onLongPress",
  "onHover",
  "onMouseEnter",
  "onMouseLeave",
  "onMove",
  "onMouseDown",
  "onMouseUp",
  "onDblClick",
  "onDoubleClick",
  "onContextMenu",
  "action",
];

/**
 * A mark with no event applicator is pointer-transparent — a tooltip's
 * `Points`/`Marker` must never steal the pointer from the `Line` under it.
 */
export function isInteractiveMark(node: VirtualNode): boolean {
  const props = node.props;
  for (const name of MARK_EVENT_PROPS) {
    if (props[name] != null) return true;
    if (props[`${name}.0`] != null) return true;
    const lower = name.toLowerCase();
    if (props[lower] != null) return true;
  }
  return false;
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function pointInPolygon(px: number, py: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The datum whose own drawn shape (or touch radius) covers the point. */
function datumAt(mark: MarkState, g: ChartGeometry, x: number, y: number): Datum | null {
  const pts = project(mark.data, g);
  if (pts.length === 0) return null;
  if (mark.kind === "bars") {
    const width = barMetrics(mark, g, pts.length);
    const zero = zeroLine(g);
    for (const [px, py, datum] of pts) {
      const top = Math.min(py, zero);
      const height = Math.abs(zero - py);
      if (x >= px - width / 2 && x <= px + width / 2 && y >= top && y <= top + height) {
        return datum;
      }
    }
    return null;
  }
  const radius =
    mark.kind === "points"
      ? Math.max(
          toNumber(prop(mark.node.props, "radius")) ?? CHART_DEFAULTS.pointRadius,
          CHART_DEFAULTS.hitRadius,
        )
      : CHART_DEFAULTS.hitRadius;
  let best: Datum | null = null;
  let bestDist = Infinity;
  for (const [px, py, datum] of pts) {
    const dist = Math.hypot(px - x, py - y);
    if (dist <= radius && dist < bestDist) {
      bestDist = dist;
      best = datum;
    }
  }
  return best;
}

/** The datum nearest the pointer along x — the fallback for any other hit. */
function nearestDatum(mark: MarkState, g: ChartGeometry, x: number): Datum | null {
  let best: Datum | null = null;
  let bestDist = Infinity;
  for (const d of mark.data) {
    const px = g.x.map(d.x);
    if (px === null) continue;
    const dist = Math.abs(px - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * Does the pointer land on this mark's drawn geometry? Only interactive
 * marks are ever asked; decorative ones are skipped by the caller.
 */
export function markContainsPoint(mark: VirtualNode, x: number, y: number): boolean {
  const chart = mark.parent;
  if (!chart || !isChartNode(chart)) return false;
  const g = chartGeometry(chart);
  if (!g) return false;
  const state = markStates.get(mark);
  if (!state) return false;

  switch (state.kind) {
    case "bars":
    case "points":
      return datumAt(state, g, x, y) !== null;
    case "line": {
      const pts = project(state.data, g);
      if (pts.length === 0) return false;
      if (datumAt(state, g, x, y) !== null) return true;
      const width = cssLengthToPx(prop(mark.props, "strokeWidth")) ?? 2;
      const tolerance = Math.max(width / 2, 3);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= tolerance) return true;
      }
      return false;
    }
    case "area": {
      const pts = project(state.data, g);
      if (pts.length === 0) return false;
      if (datumAt(state, g, x, y) !== null) return true;
      const base = zeroLine(g);
      const poly: Array<[number, number]> = pts.map(([px, py]) => [px, py]);
      poly.push([pts[pts.length - 1]![0], base]);
      poly.push([pts[0]![0], base]);
      return pointInPolygon(x, y, poly);
    }
    case "rule": {
      const seg = ruleSegment(mark.props, g);
      if (!seg) return false;
      return distanceToSegment(x, y, seg[0], seg[1], seg[2], seg[3]) <= 6;
    }
    case "axis": {
      const plot = g.plot;
      if (axisOf(mark.props) === "x") {
        const axisY = plot.y + plot.height;
        return x >= plot.x && x <= plot.x + plot.width && Math.abs(y - axisY) <= 6;
      }
      return y >= plot.y && y <= plot.y + plot.height && Math.abs(x - plot.x) <= 6;
    }
    case "path": {
      for (const sub of pathSubpaths(mark.props, g)) {
        for (let i = 0; i < sub.points.length - 1; i++) {
          const a = sub.points[i]!;
          const b = sub.points[i + 1]!;
          if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= 6) return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

// ============================================================================
// Event payloads
// ============================================================================

/**
 * Reserved key the event manager uses to hand the pointer position to the
 * dispatcher. Stripped from the payload before it reaches a module handler.
 */
export const CHART_POINTER_KEY = "__hypenChartPointer";

export interface MarkPayload extends Record<string, unknown> {
  series: string;
  index?: number;
  x?: number | string;
  y?: number;
  datum?: unknown;
}

function seriesName(node: VirtualNode, kind: MarkKind): string {
  const explicit = prop(node.props, "series") ?? prop(node.props, "name");
  return typeof explicit === "string" && explicit !== "" ? explicit : kind;
}

/**
 * Ancestors' accumulated scroll offset. Pointer coordinates arrive in canvas
 * space; layout (and therefore chart geometry) is unscrolled, so a chart
 * inside a scrolled container needs the offset added back.
 */
function scrollOffsetOf(node: VirtualNode): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let cur = node.parent; cur; cur = cur.parent) {
    x += cur.scrollState?.scrollX ?? 0;
    y += cur.scrollState?.scrollY ?? 0;
  }
  return { x, y };
}

/**
 * The chart-specific fields an event on `node` carries, or null when the
 * node is neither a Chart nor one of its marks.
 *
 * A hit on a bar / point / line vertex is that row; any other hit on a data
 * mark is the row nearest the pointer along x; a mark with no data (or an
 * event with no pointer) names only its series. Events on the Chart itself
 * carry the pointer in data units.
 */
export function chartEventPayload(
  node: VirtualNode,
  pointer?: { x: number; y: number } | null,
): Record<string, unknown> | null {
  if (isChartNode(node)) {
    const g = chartGeometry(node);
    if (!g || !pointer) return null;
    const offset = scrollOffsetOf(node);
    const px = pointer.x + offset.x;
    const py = pointer.y + offset.y;
    const xv = g.x.invert(px);
    const x =
      g.x.kind === "band"
        ? g.x.categories[Math.min(Math.max(Math.floor(xv), 0), g.x.categories.length - 1)]
        : xv;
    return { x, y: g.y.invert(py) };
  }

  const kind = chartMarkKind(node);
  if (kind === null || kind === "marker") return null;
  const mark = markStateOf(node);
  if (!mark) return null;
  const payload: MarkPayload = { series: seriesName(node, kind) };
  if (!DATA_MARKS.has(kind) || mark.data.length === 0) return payload;

  const chart = node.parent!;
  const g = chartGeometry(chart);
  if (!g || !pointer) return payload;
  const offset = scrollOffsetOf(chart);
  const px = pointer.x + offset.x;
  const py = pointer.y + offset.y;

  const datum = datumAt(mark, g, px, py) ?? nearestDatum(mark, g, px);
  if (datum) {
    payload.index = datum.index;
    payload.x = datum.x;
    payload.y = datum.y;
    payload.datum = datum.raw;
  }
  return payload;
}
