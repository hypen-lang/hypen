/**
 * Chart components — data-space drawing for the DOM renderer.
 *
 * `Chart` is an `<svg>` that owns a coordinate space. Its children are marks
 * (`Line`, `Area`, `Bars`, `Points`, `Axis`, `Rule`, `Marker`, `Path`) whose
 * props are written in DATA units, never pixels. The chart resolves the x/y
 * domains — explicit `x: [min, max]` / `y: [min, max]` ranges, or the union
 * of its marks' data — lays every mark out in pixels, and lays out again on
 * prop changes, child changes and resize. That keeps Hypen's "no absolute
 * positioning" rule intact: nothing in the DSL ever names a pixel.
 *
 * Data. `points:` / `data:` (or the positional argument) accepts three shapes
 * and normalises them all to `{x, y}`:
 *   - `[3, 5, 2]`                  → x is the index
 *   - `[[1, 3], [2, 5]]`           → `[x, y]` tuples
 *   - `[{month: "Jan", count: 3}]` → objects, field names from `x:` / `y:`
 * A string x anywhere in the chart switches the x scale to categorical bands.
 *
 * Interaction. Every mark installs a payload resolver (see element-data) so
 * the ordinary event applicators — `.onClick`, `.onPress`, `.onLongPress`,
 * `.onHover`, `.onMove`, `.onMouseLeave` — dispatch the nearest datum:
 * `{series, index, x, y, datum}` in data units. Module handlers therefore
 * stay platform-agnostic; a renderer that draws with Canvas 2D or SwiftUI
 * must produce the same payload.
 *
 * Styling rides the CSS fallback of the applicator registry: `.stroke()`,
 * `.fill()`, `.strokeWidth()`, `.fillOpacity()`, `.color()` land as inline
 * CSS on the mark's `<g>` and inherit into the geometry. Defaults are written
 * as presentation attributes on the same `<g>`, which inline CSS overrides.
 */

import type { ComponentHandler } from "./index.js";
import { hasProp, toBool } from "./index.js";
import { setPayloadResolver } from "../element-data.js";

const SVG_NS = "http://www.w3.org/2000/svg";

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

/** Marks that carry data and therefore take part in domain resolution. */
const DATA_MARKS: ReadonlySet<MarkKind> = new Set(["line", "area", "bars", "points"]);

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

export interface Datum {
  x: number | string;
  y: number;
  index: number;
  raw: unknown;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
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

interface ChartState {
  props: Record<string, any>;
  width: number;
  height: number;
  plot: Rect;
  x: Scale;
  y: Scale;
  observer?: { disconnect(): void };
  layingOut: boolean;
}

interface MarkState {
  kind: MarkKind;
  props: Record<string, any>;
  data: Datum[];
}

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
} as const;

// ============================================================================
// Per-element state
// ============================================================================

const charts = new WeakMap<object, ChartState>();
const marks = new WeakMap<object, MarkState>();

function chartStateOf(svg: HTMLElement): ChartState {
  let state = charts.get(svg);
  if (!state) {
    state = {
      props: {},
      width: CHART_DEFAULTS.width,
      height: CHART_DEFAULTS.height,
      plot: { left: 0, top: 0, width: CHART_DEFAULTS.width, height: CHART_DEFAULTS.height },
      x: linearScale(0, 1, [0, CHART_DEFAULTS.width]),
      y: linearScale(0, 1, [CHART_DEFAULTS.height, 0]),
      layingOut: false,
    };
    charts.set(svg, state);
  }
  return state;
}

function markStateOf(el: HTMLElement, kind: MarkKind): MarkState {
  let state = marks.get(el);
  if (!state) {
    state = { kind, props: {}, data: [] };
    marks.set(el, state);
  }
  return state;
}

/** Nearest `Chart` ancestor, walking `parentNode` (fake DOM has no `closest`). */
function chartOf(el: HTMLElement): HTMLElement | null {
  let node: any = el.parentNode;
  while (node) {
    if (node.dataset?.hypenType === "chart") return node as HTMLElement;
    node = node.parentNode;
  }
  return null;
}

function markChildren(svg: HTMLElement): Array<[HTMLElement, MarkState]> {
  const out: Array<[HTMLElement, MarkState]> = [];
  const children: ArrayLike<any> = (svg as any).children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as HTMLElement;
    const state = marks.get(child);
    if (state) out.push([child, state]);
  }
  return out;
}

// ============================================================================
// Data normalisation
// ============================================================================

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

function readList(props: Record<string, any>): unknown[] {
  const candidates = [props.points, props.data, props.values, props["0"]];
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
 * Normalise the mark's list prop into `{x, y}` data. Field names for object
 * rows come from `x:` / `y:` (Bars also accepts `label:` / `value:`).
 */
export function normalizeData(props: Record<string, any>): Datum[] {
  const list = readList(props);
  const xField = typeof props.x === "string" ? props.x : typeof props.label === "string" ? props.label : "x";
  const yField = typeof props.y === "string" ? props.y : typeof props.value === "string" ? props.value : "y";
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
// Layout
// ============================================================================

function cssLength(value: unknown): string | null {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.trim() !== "") {
    return /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}px` : value;
  }
  return null;
}

function measure(svg: HTMLElement, props: Record<string, any>): { width: number; height: number } {
  let width = 0;
  let height = 0;
  try {
    const rect = svg.getBoundingClientRect?.();
    if (rect) {
      width = rect.width;
      height = rect.height;
    }
  } catch {
    /* detached / non-browser */
  }
  if (!(width > 0)) width = toNumber(props.width) ?? CHART_DEFAULTS.width;
  if (!(height > 0)) height = toNumber(props.height) ?? CHART_DEFAULTS.height;
  return { width, height };
}

function hasAxis(markList: Array<[HTMLElement, MarkState]>, which: "x" | "y"): boolean {
  return markList.some(([, m]) => m.kind === "axis" && axisOf(m.props) === which);
}

function axisOf(props: Record<string, any>): "x" | "y" {
  const raw = props.axis ?? props["0"];
  return String(raw ?? "x").toLowerCase() === "y" ? "y" : "x";
}

function insets(
  props: Record<string, any>,
  markList: Array<[HTMLElement, MarkState]>,
): { top: number; right: number; bottom: number; left: number } {
  const p = toNumber(props.padding);
  if (p !== null) return { top: p, right: p, bottom: p, left: p };
  const xAxis = hasAxis(markList, "x");
  const yAxis = hasAxis(markList, "y");
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

/** Resolve domains: explicit chart ranges win, else the union of mark data. */
function resolveScales(
  state: ChartState,
  markList: Array<[HTMLElement, MarkState]>,
): { x: Scale; y: Scale } {
  const plot = state.plot;
  const xRange: [number, number] = [plot.left, plot.left + plot.width];
  const yRange: [number, number] = [plot.top + plot.height, plot.top];

  const categories: string[] = [];
  const seen = new Set<string>();
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let anyData = false;
  let bars = 0;

  for (const [, mark] of markList) {
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
      const y = toNumber(mark.props.y);
      if (y !== null) {
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
      const x = toX(mark.props.x);
      if (typeof x === "number") {
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
      }
    }
  }

  const explicitX = readRange(state.props.x);
  const explicitY = readRange(state.props.y);

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
 * Lay the whole chart out: measure, resolve scales, redraw every mark.
 * Cheap enough to run synchronously on every trigger; guarded against
 * re-entry because a mark redraw can itself notify the chart.
 */
export function layoutChart(svg: HTMLElement): void {
  const state = chartStateOf(svg);
  if (state.layingOut) return;
  state.layingOut = true;
  try {
    const markList = markChildren(svg);
    const size = measure(svg, state.props);
    state.width = size.width;
    state.height = size.height;
    const inset = insets(state.props, markList);
    state.plot = {
      left: inset.left,
      top: inset.top,
      width: Math.max(size.width - inset.left - inset.right, 1),
      height: Math.max(size.height - inset.top - inset.bottom, 1),
    };
    const scales = resolveScales(state, markList);
    state.x = scales.x;
    state.y = scales.y;
    for (const [el, mark] of markList) {
      renderMark(el, mark, state);
    }
  } finally {
    state.layingOut = false;
  }
}

function relayoutFrom(el: HTMLElement): void {
  const chart = chartOf(el);
  if (chart) layoutChart(chart);
}

// ============================================================================
// SVG helpers
// ============================================================================

function svgEl(tag: string, attrs: Record<string, string | number> = {}): HTMLElement {
  const el = document.createElementNS(SVG_NS, tag) as unknown as HTMLElement;
  for (const key in attrs) el.setAttribute(key, String(attrs[key]));
  return el;
}

function clear(el: HTMLElement): void {
  // Real DOM and the test fake both detach every child on this write.
  el.textContent = "";
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Catmull-Rom → cubic Bézier, the usual "smooth" line. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 3) return linePath(pts);
  let d = `M${fmt(pts[0]![0])},${fmt(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(i + 2, pts.length - 1)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(p2[0])},${fmt(p2[1])}`;
  }
  return d;
}

function linePath(pts: Array<[number, number]>): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p[0])},${fmt(p[1])}`).join(" ");
}

function project(data: Datum[], state: ChartState): Array<[number, number, Datum]> {
  const out: Array<[number, number, Datum]> = [];
  for (const d of data) {
    const px = state.x.map(d.x);
    const py = state.y.map(d.y);
    if (px === null || py === null) continue;
    out.push([px, py, d]);
  }
  return out;
}

// ============================================================================
// Mark rendering
// ============================================================================

function renderMark(el: HTMLElement, mark: MarkState, state: ChartState): void {
  switch (mark.kind) {
    case "line":
      return renderLine(el, mark, state);
    case "area":
      return renderArea(el, mark, state);
    case "bars":
      return renderBars(el, mark, state);
    case "points":
      return renderPoints(el, mark, state);
    case "axis":
      return renderAxis(el, mark, state);
    case "rule":
      return renderRule(el, mark, state);
    case "marker":
      return renderMarker(el, mark, state);
    case "path":
      return renderPath(el, mark, state);
  }
}

function hitTarget(px: number, py: number, index: number): HTMLElement {
  return svgEl("circle", {
    cx: fmt(px),
    cy: fmt(py),
    r: CHART_DEFAULTS.hitRadius,
    fill: "transparent",
    stroke: "none",
    "data-index": index,
  });
}

function renderLine(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const pts = project(mark.data, state);
  if (pts.length === 0) return;
  const xy = pts.map(([x, y]) => [x, y] as [number, number]);
  const d = toBool(mark.props.smooth) ? smoothPath(xy) : linePath(xy);
  el.appendChild(
    svgEl("path", { d, fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }),
  );
  for (const [px, py, datum] of pts) el.appendChild(hitTarget(px, py, datum.index));
}

function renderArea(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const pts = project(mark.data, state);
  if (pts.length === 0) return;
  const xy = pts.map(([x, y]) => [x, y] as [number, number]);
  const top = toBool(mark.props.smooth) ? smoothPath(xy) : linePath(xy);
  const baseValue = Math.min(Math.max(0, state.y.min), state.y.max);
  const base = state.y.map(baseValue) ?? state.plot.top + state.plot.height;
  const last = xy[xy.length - 1]!;
  const first = xy[0]!;
  const d = `${top} L${fmt(last[0])},${fmt(base)} L${fmt(first[0])},${fmt(base)} Z`;
  el.appendChild(svgEl("path", { d, stroke: "none" }));
  for (const [px, py, datum] of pts) el.appendChild(hitTarget(px, py, datum.index));
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

function renderBars(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const pts = project(mark.data, state);
  if (pts.length === 0) return;
  const ratio = toNumber(mark.props.barWidth) ?? CHART_DEFAULTS.barWidth;
  const step = state.x.band > 0 ? state.x.band : state.plot.width / Math.max(pts.length, 1);
  const width = Math.max(step * Math.min(Math.max(ratio, 0.05), 1), 1);
  const zero = state.y.map(Math.min(Math.max(0, state.y.min), state.y.max)) ?? state.plot.top + state.plot.height;
  const radius = toNumber(mark.props.radius) ?? 0;
  const highlight = highlightSet(mark.props.highlight);
  for (const [px, py, datum] of pts) {
    const top = Math.min(py, zero);
    const height = Math.abs(zero - py);
    const attrs: Record<string, string | number> = {
      x: fmt(px - width / 2),
      y: fmt(top),
      width: fmt(width),
      height: fmt(height),
      "data-index": datum.index,
    };
    if (radius > 0) {
      attrs.rx = radius;
      attrs.ry = radius;
    }
    if (highlight) {
      if (highlight.has(datum.index)) attrs["data-highlight"] = "true";
      else attrs["fill-opacity"] = CHART_DEFAULTS.dimmedOpacity;
    }
    el.appendChild(svgEl("rect", attrs));
  }
}

function renderPoints(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const pts = project(mark.data, state);
  const r = toNumber(mark.props.radius) ?? CHART_DEFAULTS.pointRadius;
  const highlight = highlightSet(mark.props.highlight);
  for (const [px, py, datum] of pts) {
    const attrs: Record<string, string | number> = {
      cx: fmt(px),
      cy: fmt(py),
      r,
      "data-index": datum.index,
    };
    if (highlight) {
      if (highlight.has(datum.index)) attrs["data-highlight"] = "true";
      else attrs["fill-opacity"] = CHART_DEFAULTS.dimmedOpacity;
    }
    el.appendChild(svgEl("circle", attrs));
    if (r < CHART_DEFAULTS.hitRadius) el.appendChild(hitTarget(px, py, datum.index));
  }
}

function renderAxis(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const which = axisOf(mark.props);
  const plot = state.plot;
  const count = toNumber(mark.props.ticks) ?? CHART_DEFAULTS.ticks;
  const grid = toBool(mark.props.grid);
  const label = typeof mark.props.label === "string" ? mark.props.label : null;
  const fontSize = CHART_DEFAULTS.fontSize;

  const ticksGroup = svgEl("g", { "data-part": "ticks" });
  const labelsGroup = svgEl("g", {
    "data-part": "labels",
    "font-size": fontSize,
    stroke: "none",
    "fill-opacity": 1,
  });

  if (which === "x") {
    const y = plot.top + plot.height;
    el.appendChild(svgEl("line", { x1: fmt(plot.left), y1: fmt(y), x2: fmt(plot.left + plot.width), y2: fmt(y) }));
    const entries: Array<[number, string]> =
      state.x.kind === "band"
        ? state.x.categories.map((c) => [state.x.map(c) ?? 0, c] as [number, string])
        : ticks(state.x.min, state.x.max, count).map((v) => [state.x.map(v) ?? 0, formatTick(v)] as [number, string]);
    for (const [px, text] of entries) {
      ticksGroup.appendChild(svgEl("line", { x1: fmt(px), y1: fmt(y), x2: fmt(px), y2: fmt(y + 4) }));
      if (grid) {
        ticksGroup.appendChild(
          svgEl("line", { x1: fmt(px), y1: fmt(plot.top), x2: fmt(px), y2: fmt(y), "data-part": "grid", "stroke-opacity": 0.15 }),
        );
      }
      const t = svgEl("text", { x: fmt(px), y: fmt(y + 6 + fontSize), "text-anchor": "middle" });
      t.textContent = text;
      labelsGroup.appendChild(t);
    }
    if (label) {
      const t = svgEl("text", {
        x: fmt(plot.left + plot.width / 2),
        y: fmt(Math.min(state.height - 2, y + 8 + fontSize * 2)),
        "text-anchor": "middle",
        "data-part": "title",
      });
      t.textContent = label;
      labelsGroup.appendChild(t);
    }
  } else {
    const x = plot.left;
    el.appendChild(svgEl("line", { x1: fmt(x), y1: fmt(plot.top), x2: fmt(x), y2: fmt(plot.top + plot.height) }));
    for (const v of ticks(state.y.min, state.y.max, count)) {
      const py = state.y.map(v) ?? 0;
      ticksGroup.appendChild(svgEl("line", { x1: fmt(x - 4), y1: fmt(py), x2: fmt(x), y2: fmt(py) }));
      if (grid) {
        ticksGroup.appendChild(
          svgEl("line", { x1: fmt(x), y1: fmt(py), x2: fmt(plot.left + plot.width), y2: fmt(py), "data-part": "grid", "stroke-opacity": 0.15 }),
        );
      }
      const t = svgEl("text", { x: fmt(x - 7), y: fmt(py + fontSize / 3), "text-anchor": "end" });
      t.textContent = formatTick(v);
      labelsGroup.appendChild(t);
    }
    if (label) {
      const cy = plot.top + plot.height / 2;
      const t = svgEl("text", {
        x: fmt(fontSize),
        y: fmt(cy),
        "text-anchor": "middle",
        transform: `rotate(-90 ${fmt(fontSize)} ${fmt(cy)})`,
        "data-part": "title",
      });
      t.textContent = label;
      labelsGroup.appendChild(t);
    }
  }
  el.appendChild(ticksGroup);
  el.appendChild(labelsGroup);
}

function renderRule(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const plot = state.plot;
  const y = toNumber(mark.props.y);
  const x = toX(mark.props.x);
  if (y !== null) {
    const py = state.y.map(y);
    if (py === null) return;
    el.appendChild(svgEl("line", { x1: fmt(plot.left), y1: fmt(py), x2: fmt(plot.left + plot.width), y2: fmt(py) }));
  } else if (x !== null) {
    const px = state.x.map(x);
    if (px === null) return;
    el.appendChild(svgEl("line", { x1: fmt(px), y1: fmt(plot.top), x2: fmt(px), y2: fmt(plot.top + plot.height) }));
  }
}

const MARKER_ANCHORS = new Set(["top", "bottom", "left", "right", "center"]);

function renderMarker(el: HTMLElement, mark: MarkState, state: ChartState): void {
  // Marker keeps its Hypen children; only its own position changes.
  const plot = state.plot;
  const x = toX(mark.props.x);
  const y = toNumber(mark.props.y);
  // No coordinates at all (a tooltip bound to `state.hover` while it is
  // null) hides the marker. One missing coordinate centres it on that axis
  // (`Marker(y: 80) { Text("goal") }` sits mid-plot at the goal level).
  const px = x === null ? plot.left + plot.width / 2 : state.x.map(x);
  const py = y === null ? plot.top + plot.height / 2 : state.y.map(y);
  if ((x === null && y === null) || px === null || py === null) {
    el.setAttribute("visibility", "hidden");
    return;
  }
  el.removeAttribute?.("visibility");
  el.setAttribute("x", fmt(px));
  el.setAttribute("y", fmt(py));
  const anchor = String(mark.props.anchor ?? "top").toLowerCase();
  el.dataset.anchor = MARKER_ANCHORS.has(anchor) ? anchor : "top";
}

function renderPath(el: HTMLElement, mark: MarkState, state: ChartState): void {
  clear(el);
  const d = mark.props.d ?? mark.props["0"];
  if (typeof d !== "string" || d.trim() === "") return;
  // Data → pixel as one affine transform; y flips because SVG grows down.
  const sx = (state.x.range[1] - state.x.range[0]) / ((state.x.max - state.x.min) || 1);
  const sy = (state.y.range[1] - state.y.range[0]) / ((state.y.max - state.y.min) || 1);
  const tx = state.x.range[0] - state.x.min * sx;
  const ty = state.y.range[0] - state.y.min * sy;
  el.appendChild(
    svgEl("path", {
      d,
      transform: `matrix(${fmt(sx)} 0 0 ${fmt(sy)} ${fmt(tx)} ${fmt(ty)})`,
      "vector-effect": "non-scaling-stroke",
    }),
  );
}

// ============================================================================
// Interaction — nearest datum in data units
// ============================================================================

export interface MarkPayload extends Record<string, unknown> {
  series: string;
  index?: number;
  x?: number | string;
  y?: number;
  datum?: unknown;
}

function seriesName(el: HTMLElement, mark: MarkState): string {
  const explicit = mark.props.series ?? mark.props.name;
  return typeof explicit === "string" && explicit !== "" ? explicit : mark.kind;
}

/** Pointer position in plot pixels, or null when the event carries none. */
function pointerPx(svg: HTMLElement, event: any): { x: number; y: number } | null {
  const cx = event?.clientX;
  const cy = event?.clientY;
  if (typeof cx !== "number" || typeof cy !== "number") return null;
  let left = 0;
  let top = 0;
  try {
    const rect = svg.getBoundingClientRect?.();
    if (rect) {
      left = rect.left;
      top = rect.top;
    }
  } catch {
    /* fake DOM */
  }
  return { x: cx - left, y: cy - top };
}

function indexFromTarget(event: any): number | null {
  let node: any = event?.target;
  while (node && node.dataset) {
    const raw = node.dataset.index ?? node.getAttribute?.("data-index") ?? node.attributes?.["data-index"];
    if (raw !== undefined && raw !== null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    if (marks.has(node)) break;
    node = node.parentNode;
  }
  return null;
}

/**
 * Resolve the datum an event refers to: an explicit `data-index` on the hit
 * target wins (bars, points, line vertices); otherwise the datum nearest the
 * pointer along x. Exposed for tests and for other renderers to mirror.
 */
export function resolveMarkPayload(el: HTMLElement, event: Event): MarkPayload {
  const mark = marks.get(el);
  if (!mark) return { series: "" };
  const payload: MarkPayload = { series: seriesName(el, mark) };
  if (!DATA_MARKS.has(mark.kind) || mark.data.length === 0) return payload;

  let datum: Datum | undefined;
  const byIndex = indexFromTarget(event);
  if (byIndex !== null) datum = mark.data.find((d) => d.index === byIndex);

  if (!datum) {
    const chart = chartOf(el);
    const state = chart ? charts.get(chart) : undefined;
    const p = chart && state ? pointerPx(chart, event) : null;
    if (p && state) {
      let best = Infinity;
      for (const d of mark.data) {
        const px = state.x.map(d.x);
        if (px === null) continue;
        const dist = Math.abs(px - p.x);
        if (dist < best) {
          best = dist;
          datum = d;
        }
      }
    }
  }

  if (datum) {
    payload.index = datum.index;
    payload.x = datum.x;
    payload.y = datum.y;
    payload.datum = datum.raw;
  }
  return payload;
}

/** Chart-level events carry the pointer position in data units. */
export function resolveChartPayload(svg: HTMLElement, event: Event): Record<string, unknown> {
  const state = charts.get(svg);
  const p = state ? pointerPx(svg, event) : null;
  if (!state || !p) return {};
  const xv = state.x.invert(p.x);
  const x = state.x.kind === "band" ? state.x.categories[Math.min(Math.max(Math.floor(xv), 0), state.x.categories.length - 1)] : xv;
  return { x, y: state.y.invert(p.y) };
}

// ============================================================================
// Chart stylesheet
// ============================================================================
//
// Two jobs, both CSS so they track the DOM live:
//  - Marks without an event applicator are pointer-transparent. A tooltip's
//    `Points`/`Marker` appears under the pointer and would otherwise steal it
//    from the `Line` being hovered (its `onMouseLeave` fired at once). Event
//    applicators stamp `data-hypen-interactive`, which switches hits back on.
//  - Marker children are anchored around the data point without touching
//    the child's own inline style.

let chartStylesInstalled = false;

function installChartStyles(): void {
  if (chartStylesInstalled) return;
  chartStylesInstalled = true;
  try {
    const style = document.createElement("style");
    style.setAttribute("data-hypen-chart", "styles");
    style.textContent = [
      'svg[data-hypen-type="chart"]>g:not([data-hypen-interactive]){pointer-events:none}',
      'foreignObject[data-hypen-type="marker"]{overflow:visible;pointer-events:none}',
      'foreignObject[data-hypen-type="marker"]>*{position:absolute;white-space:nowrap;pointer-events:none}',
      'foreignObject[data-hypen-type="marker"] [data-hypen-interactive]{pointer-events:auto}',
      'foreignObject[data-hypen-type="marker"][data-anchor="top"]>*{transform:translate(-50%,calc(-100% - 8px))}',
      'foreignObject[data-hypen-type="marker"][data-anchor="bottom"]>*{transform:translate(-50%,8px)}',
      'foreignObject[data-hypen-type="marker"][data-anchor="left"]>*{transform:translate(calc(-100% - 8px),-50%)}',
      'foreignObject[data-hypen-type="marker"][data-anchor="right"]>*{transform:translate(8px,-50%)}',
      'foreignObject[data-hypen-type="marker"][data-anchor="center"]>*{transform:translate(-50%,-50%)}',
    ].join("\n");
    document.head?.appendChild(style);
  } catch {
    chartStylesInstalled = false;
  }
}

// ============================================================================
// Handlers
// ============================================================================

function observeResize(svg: HTMLElement, state: ChartState): void {
  const RO = (globalThis as any).ResizeObserver;
  if (typeof RO !== "function" || state.observer) return;
  try {
    const observer = new RO(() => layoutChart(svg));
    observer.observe(svg);
    state.observer = observer;
  } catch {
    /* unsupported */
  }
}

export const chartHandler: ComponentHandler = {
  create(): HTMLElement {
    installChartStyles();
    const svg = svgEl("svg", { xmlns: SVG_NS, overflow: "visible" });
    svg.dataset.hypenType = "chart";
    svg.style.display = "block";
    svg.style.width = "100%";
    svg.style.height = `${CHART_DEFAULTS.height}px`;
    svg.style.overflow = "visible";
    // Line/point strokes and fills default to the text colour so a chart
    // picks up `.color()` like any other component.
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("fill", "currentColor");
    const state = chartStateOf(svg);
    setPayloadResolver(svg, (event) => resolveChartPayload(svg, event));
    observeResize(svg, state);
    return svg;
  },
  applyProps(svg, props) {
    const state = chartStateOf(svg);
    state.props = { ...props };
    if (hasProp(props, "width")) {
      const w = cssLength(props.width);
      svg.style.width = w ?? "100%";
    }
    if (hasProp(props, "height")) {
      const h = cssLength(props.height);
      svg.style.height = h ?? `${CHART_DEFAULTS.height}px`;
    }
    layoutChart(svg);
  },
  onChildrenChanged(svg) {
    layoutChart(svg);
  },
  adopt(svg) {
    chartStateOf(svg);
    setPayloadResolver(svg, (event) => resolveChartPayload(svg, event));
    observeResize(svg, chartStateOf(svg));
  },
};

/** Presentation defaults per mark, written on the `<g>` so inline CSS wins. */
const MARK_DEFAULT_ATTRS: Record<MarkKind, Record<string, string | number>> = {
  line: { fill: "none", "stroke-width": 2 },
  area: { stroke: "none", "fill-opacity": 0.15 },
  bars: { stroke: "none" },
  points: { stroke: "none" },
  axis: { "stroke-width": 1, "stroke-opacity": 0.5, "fill-opacity": 0.75 },
  rule: { fill: "none", "stroke-width": 1, "stroke-dasharray": "4 4", "stroke-opacity": 0.7 },
  marker: {},
  path: { fill: "none", "stroke-width": 2 },
};

function markHandler(kind: MarkKind): ComponentHandler {
  const tag = kind === "marker" ? "foreignObject" : "g";
  return {
    create(): HTMLElement {
      const el = svgEl(tag, MARK_DEFAULT_ATTRS[kind]);
      el.dataset.hypenType = kind;
      if (kind === "marker") {
        el.setAttribute("width", "1");
        el.setAttribute("height", "1");
        el.dataset.anchor = "top";
      }
      markStateOf(el, kind);
      setPayloadResolver(el, (event) => resolveMarkPayload(el, event));
      return el;
    },
    applyProps(el, props) {
      const state = markStateOf(el, kind);
      state.props = { ...props };
      if (DATA_MARKS.has(kind)) state.data = normalizeData(props);
      relayoutFrom(el);
    },
    adopt(el) {
      markStateOf(el, kind);
      setPayloadResolver(el, (event) => resolveMarkPayload(el, event));
    },
  };
}

export const lineHandler = markHandler("line");
export const areaHandler = markHandler("area");
export const barsHandler = markHandler("bars");
export const pointsHandler = markHandler("points");
export const axisHandler = markHandler("axis");
export const ruleHandler = markHandler("rule");
export const markerHandler = markHandler("marker");
export const pathHandler = markHandler("path");

/** Read-only view of a chart's resolved scales, for tests and tooling. */
export function inspectChart(svg: HTMLElement): {
  plot: Rect;
  x: { kind: string; min: number; max: number; categories: string[] };
  y: { kind: string; min: number; max: number };
} | null {
  const state = charts.get(svg);
  if (!state) return null;
  return {
    plot: { ...state.plot },
    x: { kind: state.x.kind, min: state.x.min, max: state.x.max, categories: [...state.x.categories] },
    y: { kind: state.y.kind, min: state.y.min, max: state.y.max },
  };
}
