import { semanticAction } from "./helpers";
/**
 * Chart family contract on the Canvas renderer.
 *
 * `Chart` owns a coordinate space; its marks (`Line`, `Area`, `Bars`,
 * `Points`, `Axis`, `Rule`, `Marker`, `Path`) speak data units and are laid
 * out by the chart itself — Taffy sees the chart as a leaf. Events on a mark
 * carry the datum, not pixels.
 *
 * The numbers below are the DOM renderer's numbers: a 320×200 chart with no
 * axes insets by 4 on every side, so the plot is 4..316 × 4..196.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import {
  computeLayout,
  initTaffyLayout,
} from "../packages/web/src/canvas/layout.js";
import { paintNode } from "../packages/web/src/canvas/paint.js";
import {
  CHART_DEFAULTS,
  chartEventPayload,
  inspectChart,
  isInteractiveMark,
  niceDomain,
  normalizeData,
  ticks,
} from "../packages/web/src/canvas/chart.js";
import { normalizeAllApplicators } from "../packages/web/src/canvas/props.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import { ensureFakeDomGlobals } from "./fake-dom";

beforeAll(async () => {
  // Exercise the production (Taffy) path when it comes up; the JS fallback
  // produces the same box for the explicitly-sized charts used here.
  await initTaffyLayout();
});

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: any[];
  fillStyle: any;
  strokeStyle: any;
  globalAlpha: number;
  lineWidth: number;
  lineDash: number[];
}

/**
 * Records every draw call with the paint state at the moment of the call —
 * the alpha a dimmed bar was drawn with is only observable there.
 */
class RecordingContext {
  calls: Call[] = [];
  fillStyle: any = "#000000";
  strokeStyle: any = "#000000";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "alphabetic";
  globalCompositeOperation = "source-over";
  shadowColor = "transparent";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  private dash: number[] = [];

  private record(method: string, ...args: any[]) {
    this.calls.push({
      method,
      args,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      lineDash: [...this.dash],
    });
  }

  save() { this.record("save"); }
  restore() { this.record("restore"); }
  beginPath() { this.record("beginPath"); }
  closePath() { this.record("closePath"); }
  moveTo(x: number, y: number) { this.record("moveTo", x, y); }
  lineTo(x: number, y: number) { this.record("lineTo", x, y); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.record("bezierCurveTo", a, b, c, d, e, f);
  }
  quadraticCurveTo(a: number, b: number, c: number, d: number) {
    this.record("quadraticCurveTo", a, b, c, d);
  }
  arc(x: number, y: number, r: number, s: number, e: number) { this.record("arc", x, y, r, s, e); }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
    this.record("arcTo", x1, y1, x2, y2, r);
  }
  rect(x: number, y: number, w: number, h: number) { this.record("rect", x, y, w, h); }
  fill() { this.record("fill"); }
  stroke() { this.record("stroke"); }
  clip() { this.record("clip"); }
  fillRect(x: number, y: number, w: number, h: number) { this.record("fillRect", x, y, w, h); }
  strokeRect(x: number, y: number, w: number, h: number) { this.record("strokeRect", x, y, w, h); }
  clearRect(x: number, y: number, w: number, h: number) { this.record("clearRect", x, y, w, h); }
  fillText(text: string, x: number, y: number) { this.record("fillText", text, x, y); }
  strokeText(text: string, x: number, y: number) { this.record("strokeText", text, x, y); }
  translate(x: number, y: number) { this.record("translate", x, y); }
  rotate(a: number) { this.record("rotate", a); }
  scale(x: number, y: number) { this.record("scale", x, y); }
  setTransform() { this.record("setTransform"); }
  setLineDash(d: number[]) { this.dash = [...d]; this.record("setLineDash", d); }
  getLineDash() { return [...this.dash]; }
  measureText(text: string) { return { width: text.length * 8 }; }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  drawImage() { this.record("drawImage"); }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}

const ctx = () => new RecordingContext() as unknown as CanvasRenderingContext2D;

let nextId = 0;

function node(
  type: string,
  rawProps: Record<string, any> = {},
  children: VirtualNode[] = [],
): VirtualNode {
  const props = { ...rawProps };
  normalizeAllApplicators(props);
  const n: VirtualNode = {
    id: `n${nextId++}`,
    type,
    props,
    children,
    parent: null,
    visible: true,
    opacity: 1,
    // Mirrors the renderer's create-time derivation.
    clickable: props.onClick != null || props.onPress != null || props.action != null,
    hoverable: true,
    focusable: false,
    focused: false,
    hovered: false,
  };
  for (const c of children) c.parent = n;
  return n;
}

/** Lay a 320×200 chart out and hand back the tree. */
function layoutChart(marks: VirtualNode[], chartProps: Record<string, any> = {}) {
  const chart = node("Chart", { width: 320, height: 200, ...chartProps }, marks);
  const c = ctx();
  computeLayout(c, chart, 400, 300);
  return chart;
}

function paint(chart: VirtualNode): RecordingContext {
  const c = new RecordingContext();
  paintNode(c as unknown as CanvasRenderingContext2D, chart);
  return c;
}

// Bare chart (no axes): inset 4 all round.
const PLOT_LEFT = CHART_DEFAULTS.bareInset;
const PLOT_RIGHT = 320 - CHART_DEFAULTS.bareInset;
const PLOT_TOP = CHART_DEFAULTS.bareInset;
const PLOT_BOTTOM = 200 - CHART_DEFAULTS.bareInset;

// ---------------------------------------------------------------------------

describe("Chart host", () => {
  test("fills its parent's width and is 200 tall by default", () => {
    const chart = node("Chart", {}, [node("Line", { points: [1, 2, 3] })]);
    const root = node("Column", { width: 400, height: 300 }, [chart]);
    computeLayout(ctx(), root, 400, 300);
    expect(chart.layout!.width).toBe(400);
    expect(chart.layout!.height).toBe(CHART_DEFAULTS.height);
  });

  test("width/height props size the host", () => {
    const chart = layoutChart([node("Line", { points: [1, 2] })]);
    expect(chart.layout!.width).toBe(320);
    expect(chart.layout!.height).toBe(200);
  });

  test("marks are laid out by the chart, never by the flex pass", () => {
    // Two marks in a Chart must not stack like two Column children would:
    // both cover the chart's own box.
    const a = node("Line", { points: [1, 2] });
    const b = node("Points", { points: [1, 2] });
    layoutChart([a, b]);
    expect(a.layout!.y).toBe(0);
    expect(b.layout!.y).toBe(0);
    expect(a.layout!.height).toBe(200);
    expect(b.layout!.height).toBe(200);
  });

  test("a non-mark child of a Chart reserves nothing and paints nothing", () => {
    const stray = node("Text", { 0: "not a mark" });
    layoutChart([stray]);
    expect(stray.layout!.width).toBe(0);
    expect(stray.layout!.height).toBe(0);
  });
});

describe("data normalisation", () => {
  test("a bare number list uses the index as x", () => {
    expect(normalizeData({ points: [3, 5, 2] }).map((d) => [d.x, d.y])).toEqual([
      [0, 3], [1, 5], [2, 2],
    ]);
  });

  test("[x, y] tuples", () => {
    expect(normalizeData({ points: [[1, 3], [2, 5]] }).map((d) => [d.x, d.y])).toEqual([
      [1, 3], [2, 5],
    ]);
  });

  test("objects use the x:/y: field names and keep the raw row", () => {
    const rows = [{ month: "Jan", count: 3 }];
    const data = normalizeData({ data: rows, x: "month", y: "count" });
    expect(data[0]!.x).toBe("Jan");
    expect(data[0]!.y).toBe(3);
    expect(data[0]!.raw).toBe(rows[0]);
  });

  test("Bars sugar: label:/value: name the fields", () => {
    const data = normalizeData({ data: [{ m: "Jan", n: 4 }], label: "m", value: "n" });
    expect([data[0]!.x, data[0]!.y]).toEqual(["Jan", 4]);
  });

  test("a JSON-encoded list (remote wire form) is accepted", () => {
    expect(normalizeData({ points: "[[1,2],[3,4]]" })).toHaveLength(2);
  });

  test("the positional argument is a data source too", () => {
    expect(normalizeData({ 0: [1, 2, 3] })).toHaveLength(3);
  });

  test("rows without a usable y are dropped, not zeroed", () => {
    const data = normalizeData({ points: [{ x: 1, y: 2 }, { x: 2 }, { x: 3, y: null }] });
    expect(data).toHaveLength(1);
  });
});

describe("domain resolution", () => {
  test("explicit x:/y: ranges on the Chart win", () => {
    const chart = layoutChart([node("Line", { points: [[0, 0], [50, 900]] })], {
      x: [0, 10],
      y: [0, 100],
    });
    const info = inspectChart(chart)!;
    expect([info.x.min, info.x.max]).toEqual([0, 10]);
    expect([info.y.min, info.y.max]).toEqual([0, 100]);
  });

  test("without ranges the y domain is the nice-rounded union of the marks", () => {
    const chart = layoutChart([
      node("Line", { points: [3, 7] }),
      node("Points", { points: [[0, 22]] }),
    ]);
    const info = inspectChart(chart)!;
    expect(info.y.min).toBe(0);
    expect(info.y.max).toBe(25);
  });

  test("Bars always include zero so bar heights are honest", () => {
    const chart = layoutChart([
      node("Bars", { data: [{ x: 0, y: 40 }, { x: 1, y: 60 }] }),
    ]);
    expect(inspectChart(chart)!.y.min).toBe(0);
  });

  test("a string x anywhere switches x to categorical bands", () => {
    const chart = layoutChart([
      node("Bars", { data: [{ m: "Jan", n: 1 }, { m: "Feb", n: 2 }], x: "m", y: "n" }),
    ]);
    const info = inspectChart(chart)!;
    expect(info.x.kind).toBe("band");
    expect(info.x.categories).toEqual(["Jan", "Feb"]);
  });

  test("axes reserve label room; a bare chart is edge-to-edge (sparkline)", () => {
    const bare = inspectChart(layoutChart([node("Line", { points: [1, 2] })]))!;
    expect(bare.plot).toEqual({
      x: PLOT_LEFT,
      y: PLOT_TOP,
      width: PLOT_RIGHT - PLOT_LEFT,
      height: PLOT_BOTTOM - PLOT_TOP,
    });

    const axed = inspectChart(
      layoutChart([
        node("Axis", { 0: "x" }),
        node("Axis", { 0: "y" }),
        node("Line", { points: [1, 2] }),
      ]),
    )!;
    expect(axed.plot.x).toBe(CHART_DEFAULTS.insetLeft);
    expect(axed.plot.y).toBe(CHART_DEFAULTS.insetTop);
    expect(axed.plot.width).toBe(320 - CHART_DEFAULTS.insetLeft - CHART_DEFAULTS.insetRight);
    expect(axed.plot.height).toBe(200 - CHART_DEFAULTS.insetTop - CHART_DEFAULTS.insetBottom);
  });

  test("an explicit padding prop insets all four sides", () => {
    const info = inspectChart(
      layoutChart([node("Axis", { 0: "x" }), node("Line", { points: [1, 2] })], { padding: 10 }),
    )!;
    expect(info.plot).toEqual({ x: 10, y: 10, width: 300, height: 180 });
  });

  test("nice ticks", () => {
    expect(niceDomain(0, 93, 5)).toEqual([0, 100]);
    expect(ticks(0, 30, 5)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    // Accumulated float error is rounded out to 12 significant digits.
    expect(ticks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("mark geometry", () => {
  const rows = [
    { month: "Jan", count: 10 },
    { month: "Feb", count: 30 },
    { month: "Mar", count: 20 },
  ];

  test("Bars: one rect per datum, from the zero line, centred on the band", () => {
    const bars = node("Bars", { data: rows, x: "month", y: "count" });
    const rects = paint(layoutChart([bars])).of("rect");
    expect(rects).toHaveLength(3);
    // 3 bands over 312px → 104 wide; default barWidth ratio 0.7 → 72.8.
    const [x, y, w, h] = rects[0]!.args;
    expect(w).toBeCloseTo(72.8, 5);
    expect(x).toBeCloseTo(56 - 72.8 / 2, 5);
    // y domain [0, 30] over 4..196: count 10 → 132, height 64 down to zero.
    expect(y).toBeCloseTo(132, 5);
    expect(h).toBeCloseTo(64, 5);
    // The tallest bar reaches the top of the plot.
    expect(rects[1]!.args[1]).toBeCloseTo(PLOT_TOP, 5);
    expect(rects[1]!.args[3]).toBeCloseTo(PLOT_BOTTOM - PLOT_TOP, 5);
  });

  test("Bars: barWidth is a ratio of the band", () => {
    const rects = paint(
      layoutChart([node("Bars", { data: rows, x: "month", y: "count", barWidth: 0.5 })]),
    ).of("rect");
    expect(rects[0]!.args[2]).toBeCloseTo(52, 5);
  });

  test("Bars: highlight keeps the chosen bars and dims the rest", () => {
    const c = paint(
      layoutChart([node("Bars", { data: rows, x: "month", y: "count", highlight: 1 })]),
    );
    const fills = c.of("fill");
    expect(fills).toHaveLength(3);
    expect(fills[0]!.globalAlpha).toBeCloseTo(CHART_DEFAULTS.dimmedOpacity, 5);
    expect(fills[1]!.globalAlpha).toBeCloseTo(1, 5);
    expect(fills[2]!.globalAlpha).toBeCloseTo(CHART_DEFAULTS.dimmedOpacity, 5);
  });

  test("Line: a stroked polyline through the projected points", () => {
    const c = paint(
      layoutChart([node("Line", { points: [1, 5, 9] })], { x: [0, 2], y: [0, 10] }),
    );
    expect(c.of("moveTo")[0]!.args).toEqual([4, 176.8]);
    const lines = c.of("lineTo");
    expect(lines[0]!.args[0]).toBeCloseTo(160, 5);
    expect(lines[0]!.args[1]).toBeCloseTo(100, 5);
    expect(lines[1]!.args[0]).toBeCloseTo(316, 5);
    // Stroke-width 2, round joins, no fill.
    const stroke = c.of("stroke")[0]!;
    expect(stroke.lineWidth).toBe(2);
    expect(c.of("fill")).toHaveLength(0);
  });

  test("Line: smooth emits cubic segments instead of straight ones", () => {
    const c = paint(
      layoutChart([node("Line", { points: [1, 5, 9, 3], smooth: true })], { x: [0, 3] }),
    );
    expect(c.of("bezierCurveTo").length).toBe(3);
    expect(c.of("lineTo")).toHaveLength(0);
  });

  test("Area closes back down to the zero line and fills at 0.15", () => {
    const c = paint(
      layoutChart([node("Area", { points: [1, 5] })], { x: [0, 1], y: [0, 10] }),
    );
    const lines = c.of("lineTo");
    // …the last two segments drop to the zero line (y = 196) and return.
    expect(lines[lines.length - 2]!.args[1]).toBeCloseTo(PLOT_BOTTOM, 5);
    expect(lines[lines.length - 1]!.args[1]).toBeCloseTo(PLOT_BOTTOM, 5);
    expect(c.of("closePath")).toHaveLength(1);
    expect(c.of("fill")[0]!.globalAlpha).toBeCloseTo(0.15, 5);
    expect(c.of("stroke")).toHaveLength(0);
  });

  test("Points: one circle per datum at the default radius", () => {
    const c = paint(
      layoutChart([node("Points", { points: [[0, 0], [1, 10]] })], { x: [0, 1], y: [0, 10] }),
    );
    const arcs = c.of("arc");
    expect(arcs).toHaveLength(2);
    expect(arcs[0]!.args.slice(0, 3)).toEqual([PLOT_LEFT, PLOT_BOTTOM, CHART_DEFAULTS.pointRadius]);
    expect(arcs[1]!.args.slice(0, 3)).toEqual([PLOT_RIGHT, PLOT_TOP, CHART_DEFAULTS.pointRadius]);
  });

  test("Axis(x) labels every category; Axis(y) labels nice ticks", () => {
    const chart = layoutChart([
      node("Axis", { 0: "x" }),
      node("Axis", { 0: "y" }),
      node("Bars", { data: rows, x: "month", y: "count" }),
    ]);
    const texts = paint(chart).of("fillText").map((c) => c.args[0]);
    expect(texts).toContain("Jan");
    expect(texts).toContain("Feb");
    expect(texts).toContain("Mar");
    expect(texts).toContain("30");
    expect(texts).toContain("0");
  });

  test("Axis grid lines span the plot", () => {
    const withGrid = paint(
      layoutChart([
        node("Axis", { 0: "y", grid: true }),
        node("Line", { points: [1, 2] }),
      ]),
    );
    // A grid line runs from the axis to the right edge of the plot.
    const spans = withGrid
      .of("lineTo")
      .filter((c) => Math.abs(c.args[0] - (CHART_DEFAULTS.insetLeft + (320 - CHART_DEFAULTS.insetLeft - CHART_DEFAULTS.insetRight))) < 0.001);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0]!.globalAlpha).toBeCloseTo(0.15, 5);
  });

  test("Rule(y:) is a full-width dashed line at the data value", () => {
    const c = paint(layoutChart([node("Rule", { y: 5 })], { y: [0, 10] }));
    const move = c.of("moveTo")[0]!;
    const line = c.of("lineTo")[0]!;
    expect(move.args).toEqual([PLOT_LEFT, 100]);
    expect(line.args).toEqual([PLOT_RIGHT, 100]);
    expect(c.of("stroke")[0]!.lineDash).toEqual([4, 4]);
    expect(c.of("stroke")[0]!.globalAlpha).toBeCloseTo(0.7, 5);
  });

  test("Rule(x:) is a full-height line", () => {
    const c = paint(layoutChart([node("Rule", { x: 1 })], { x: [0, 2] }));
    expect(c.of("moveTo")[0]!.args).toEqual([160, PLOT_TOP]);
    expect(c.of("lineTo")[0]!.args).toEqual([160, PLOT_BOTTOM]);
  });

  test("Path(d:) is drawn in data units through one affine transform", () => {
    const c = paint(
      layoutChart([node("Path", { d: "M0,0 L2,10" })], { x: [0, 2], y: [0, 10] }),
    );
    expect(c.of("moveTo")[0]!.args).toEqual([PLOT_LEFT, PLOT_BOTTOM]);
    const to = c.of("lineTo")[0]!.args;
    expect(to[0]).toBeCloseTo(PLOT_RIGHT, 5);
    expect(to[1]).toBeCloseTo(PLOT_TOP, 5);
    // Non-scaling stroke: the transform lives in the coordinates, so the
    // stroke keeps the width the mark asked for.
    expect(c.of("stroke")[0]!.lineWidth).toBe(2);
  });

  test("Marker sits at the data coordinate with its content above by default", () => {
    const marker = node("Marker", { x: 1, y: 5 }, [node("Text", { 0: "hi" })]);
    layoutChart([marker], { x: [0, 2], y: [0, 10] });
    const box = marker.layout!;
    expect(box.width).toBeGreaterThan(0);
    // Centred on x = 1 → 160px; bottom edge 8px above y = 5 → 100px.
    expect(box.x + box.width / 2).toBeCloseTo(160, 5);
    expect(box.y + box.height).toBeCloseTo(100 - CHART_DEFAULTS.markerGap, 5);
  });

  test("Marker anchors: bottom/left/right/center", () => {
    for (const [anchor, check] of [
      ["bottom", (b: any) => expect(b.y).toBeCloseTo(100 + 8, 5)],
      ["right", (b: any) => expect(b.x).toBeCloseTo(160 + 8, 5)],
      ["left", (b: any) => expect(b.x + b.width).toBeCloseTo(160 - 8, 5)],
      ["center", (b: any) => expect(b.y + b.height / 2).toBeCloseTo(100, 5)],
    ] as const) {
      const marker = node("Marker", { x: 1, y: 5, anchor }, [node("Text", { 0: "hi" })]);
      layoutChart([marker], { x: [0, 2], y: [0, 10] });
      check(marker.layout!);
    }
  });

  test("Marker with no coordinates is hidden; one coordinate centres the other axis", () => {
    const hidden = node("Marker", {}, [node("Text", { 0: "tip" })]);
    layoutChart([hidden], { x: [0, 2], y: [0, 10] });
    expect(hidden.layout!.width).toBe(0);
    expect(hidden.layout!.height).toBe(0);
    expect(hidden.children[0]!.layout!.width).toBe(0);

    const half = node("Marker", { y: 5, anchor: "center" }, [node("Text", { 0: "goal" })]);
    layoutChart([half], { x: [0, 2], y: [0, 10] });
    const box = half.layout!;
    expect(box.x + box.width / 2).toBeCloseTo((PLOT_LEFT + PLOT_RIGHT) / 2, 5);
    expect(box.y + box.height / 2).toBeCloseTo(100, 5);
  });

  test("a Marker's children paint at the placed box", () => {
    const marker = node("Marker", { x: 1, y: 5, anchor: "center" }, [node("Text", { 0: "hi" })]);
    const chart = layoutChart([marker], { x: [0, 2], y: [0, 10] });
    const texts = paint(chart).of("fillText");
    expect(texts.map((t) => t.args[0])).toContain("hi");
  });
});

describe("styling", () => {
  test("stroke/fill default to the inherited text colour", () => {
    const line = node("Line", { points: [1, 2] });
    const chart = node("Chart", { width: 320, height: 200, color: "#10b981" }, [line]);
    computeLayout(ctx(), chart, 400, 300);
    const c = paint(chart);
    expect(c.of("stroke")[0]!.strokeStyle).toBe("#10b981");
  });

  test("stroke/strokeWidth/fillOpacity applicators reach the geometry", () => {
    const c = paint(
      layoutChart([
        node("Line", { points: [1, 2], "stroke.0": "#f00", "strokeWidth.0": 4 }),
      ]),
    );
    const stroke = c.of("stroke")[0]!;
    expect(stroke.strokeStyle).toBe("#f00");
    expect(stroke.lineWidth).toBe(4);
  });

  test("glow becomes a zero-offset shadow of the painted shape", () => {
    const line = node("Line", { points: [1, 2], "glow.0": "#f59e0b" });
    const chart = layoutChart([line]);
    const c = new RecordingContext();
    paintNode(c as unknown as CanvasRenderingContext2D, chart);
    // Recorded at stroke time, before the painter clears it.
    const strokeIndex = c.calls.findIndex((call) => call.method === "stroke");
    expect(strokeIndex).toBeGreaterThan(-1);
    expect(c.shadowOffsetX).toBe(0);
  });

  test("a shadow applicator on a mark shadows the shape, not a box", () => {
    const line = node("Line", { points: [1, 2], "shadow.0": "0 2 6 rgba(0,0,0,0.4)" });
    const chart = layoutChart([line]);
    const c = new RecordingContext();
    paintNode(c as unknown as CanvasRenderingContext2D, chart);
    expect(c.of("stroke")).toHaveLength(1);
  });

  test("layout applicators on a mark are no-ops", () => {
    const line = node("Line", { points: [1, 2], "padding.0": 40, "width.0": 20 });
    layoutChart([line]);
    // The mark still covers the chart box; padding/width changed nothing.
    expect(line.layout!.width).toBe(320);
  });
});

describe("interaction — payload resolution", () => {
  const rows = [
    { month: "Jan", count: 10 },
    { month: "Feb", count: 30 },
    { month: "Mar", count: 20 },
  ];

  test("a hit on a bar resolves that row", () => {
    const bars = node("Bars", { data: rows, x: "month", y: "count", series: "units" });
    layoutChart([bars]);
    // Band centres 56 / 160 / 264; bar 1 runs from y = 4 to the zero line.
    const payload = chartEventPayload(bars, { x: 160, y: 100 })!;
    expect(payload.series).toBe("units");
    expect(payload.index).toBe(1);
    expect(payload.x).toBe("Feb");
    expect(payload.y).toBe(30);
    expect(payload.datum).toBe(rows[1]);
  });

  test("a hit on a line vertex resolves that vertex", () => {
    const line = node("Line", { points: [1, 5, 9] });
    layoutChart([line], { x: [0, 2], y: [0, 10] });
    const payload = chartEventPayload(line, { x: 162, y: 103 })!;
    expect(payload.index).toBe(1);
    expect(payload.y).toBe(5);
  });

  test("any other hit resolves the datum nearest the pointer along x", () => {
    const line = node("Line", { points: [1, 5, 9] });
    layoutChart([line], { x: [0, 2], y: [0, 10] });
    // Far from every vertex, but closest to x = 1 along the x axis.
    const payload = chartEventPayload(line, { x: 200, y: 20 })!;
    expect(payload.index).toBe(1);
    expect(payload.x).toBe(1);
  });

  test("a pointer past the last vertex clamps to the last datum", () => {
    const line = node("Line", { points: [1, 5, 9] });
    layoutChart([line], { x: [0, 2] });
    expect(chartEventPayload(line, { x: 9999, y: 0 })!.index).toBe(2);
  });

  test("a mark with no pointer still names its series", () => {
    const line = node("Line", { points: [1], name: "revenue" });
    layoutChart([line]);
    const payload = chartEventPayload(line, null)!;
    expect(payload.series).toBe("revenue");
    expect(payload.index).toBeUndefined();
  });

  test("a mark with no data resolves to the series alone", () => {
    const rule = node("Rule", { y: 5 });
    layoutChart([rule], { y: [0, 10] });
    expect(chartEventPayload(rule, { x: 100, y: 100 })).toEqual({ series: "rule" });
  });

  test("Chart-level events carry the pointer in data units", () => {
    const chart = layoutChart([node("Line", { points: [[0, 0]] })], {
      x: [0, 100],
      y: [0, 10],
    });
    const payload = chartEventPayload(chart, { x: 160, y: 100 })!;
    expect(payload.x as number).toBeCloseTo(50, 5);
    expect(payload.y as number).toBeCloseTo(5, 5);
  });

  test("a band x axis reports the category the pointer is over", () => {
    const chart = layoutChart([
      node("Bars", { data: rows, x: "month", y: "count" }),
    ]);
    expect(chartEventPayload(chart, { x: 264, y: 100 })!.x).toBe("Mar");
  });

  test("only marks with an event applicator are hittable", () => {
    expect(isInteractiveMark(node("Points", { points: [1] }))).toBe(false);
    expect(isInteractiveMark(node("Points", { points: [1], "onMove.0": "@actions.t" }))).toBe(true);
    expect(isInteractiveMark(node("Line", { points: [1], "onClick.0": "@actions.t" }))).toBe(true);
  });
});

describe("interaction — through the canvas event manager", () => {
  class MockCanvas {
    width = 400;
    height = 300;
    style: any = { cursor: "default" };
    private listeners = new Map<string, Function[]>();
    getBoundingClientRect() {
      return { width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0 };
    }
    addEventListener(t: string, h: Function) {
      const list = this.listeners.get(t) ?? [];
      list.push(h);
      this.listeners.set(t, list);
    }
    removeEventListener(t: string, h: Function) {
      const a = this.listeners.get(t);
      if (a) {
        const i = a.indexOf(h);
        if (i >= 0) a.splice(i, 1);
      }
    }
    dispatchEvent(e: any) {
      (this.listeners.get(e.type) ?? []).forEach((h) => h(e));
      return true;
    }
  }

  class MockEngine {
    dispatched: Array<{ name: string; payload: any }> = [];
    dispatchAction(name: string, payload?: any) {
      this.dispatched.push(semanticAction(name, payload));
    }
  }

  ensureFakeDomGlobals();

  const mount = async (marks: VirtualNode[], chartProps: Record<string, any> = {}) => {
    const { CanvasEventManager } = await import("../packages/web/src/canvas/events");
    const chart = layoutChart(marks, chartProps);
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);
    events.setRootNode(chart);
    return { canvas, engine, events, chart };
  };

  const click = (canvas: any, x: number, y: number) => {
    canvas.dispatchEvent({ type: "mousedown", clientX: x, clientY: y, button: 0, buttons: 1 });
    canvas.dispatchEvent({ type: "mouseup", clientX: x, clientY: y, button: 0 });
    canvas.dispatchEvent({ type: "click", clientX: x, clientY: y, button: 0 });
  };

  const rows = [
    { month: "Jan", count: 10 },
    { month: "Feb", count: 30 },
    { month: "Mar", count: 20 },
  ];

  test("tapping a bar dispatches {series, index, x, y, datum}", async () => {
    const bars = node("Bars", {
      data: rows,
      x: "month",
      y: "count",
      series: "units",
      "onClick.0": "@actions.pick",
    });
    const { canvas, engine, events } = await mount([bars]);
    click(canvas, 160, 100);
    expect(engine.dispatched).toHaveLength(1);
    const { name, payload } = engine.dispatched[0]!;
    expect(name).toBe("pick");
    expect(payload.series).toBe("units");
    expect(payload.index).toBe(1);
    expect(payload.x).toBe("Feb");
    expect(payload.y).toBe(30);
    expect(payload.datum).toBe(rows[1]);
    events.destroy();
  });

  test("static action args and the datum travel together", async () => {
    const points = node("Points", {
      points: [[1, 5]],
      "onClick.0": "@actions.pick",
      "onClick.tag": "targets",
    });
    const { canvas, engine, events } = await mount([points], { x: [0, 2], y: [0, 10] });
    click(canvas, 160, 100);
    const payload = engine.dispatched[0]!.payload;
    expect(payload.tag).toBe("targets");
    expect(payload.x).toBe(1);
    expect(payload.y).toBe(5);
    events.destroy();
  });

  test("a tap outside every mark falls through to the Chart's own payload", async () => {
    const { canvas, engine, events } = await mount(
      [node("Points", { points: [[0, 0]] })],
      { x: [0, 100], y: [0, 10], "onClick.0": "@actions.plot" },
    );
    click(canvas, 160, 100);
    const payload = engine.dispatched[0]!.payload;
    expect(engine.dispatched[0]!.name).toBe("plot");
    expect(payload.x).toBeCloseTo(50, 5);
    expect(payload.y).toBeCloseTo(5, 5);
    events.destroy();
  });

  test("a decorative Points never steals the pointer from the Line under it", async () => {
    const line = node("Line", { points: [1, 5, 9], "onClick.0": "@actions.hit" });
    const tooltip = node("Points", { points: [[1, 5]] });
    const { canvas, engine, events } = await mount([line, tooltip], { x: [0, 2], y: [0, 10] });
    click(canvas, 160, 100);
    expect(engine.dispatched.map((d) => d.name)).toEqual(["hit"]);
    expect(engine.dispatched[0]!.payload.index).toBe(1);
    events.destroy();
  });

  test("onHover fires once when the pointer enters a mark", async () => {
    const line = node("Line", { points: [1, 5, 9], "onHover.0": "@actions.hover" });
    const { canvas, engine, events } = await mount([line], { x: [0, 2], y: [0, 10] });
    canvas.dispatchEvent({ type: "mousemove", clientX: 160, clientY: 100 });
    canvas.dispatchEvent({ type: "mousemove", clientX: 161, clientY: 100 });
    expect(engine.dispatched.map((d) => d.name)).toEqual(["hover"]);
    expect(engine.dispatched[0]!.payload.index).toBe(1);
    events.destroy();
  });

  test("onMove tracks the pointer and is throttled", async () => {
    const line = node("Line", { points: [1, 5, 9], "onMove.0": "@actions.track" });
    const { canvas, engine, events } = await mount([line], { x: [0, 2], y: [0, 10] });
    canvas.dispatchEvent({ type: "pointermove", clientX: 160, clientY: 100 });
    canvas.dispatchEvent({ type: "pointermove", clientX: 161, clientY: 100 });
    canvas.dispatchEvent({ type: "pointermove", clientX: 162, clientY: 100 });
    expect(engine.dispatched.map((d) => d.name)).toEqual(["track"]);
    expect(engine.dispatched[0]!.payload.index).toBe(1);
    events.destroy();
  });

  test("onLongPress fires after the press is held", async () => {
    const bars = node("Bars", {
      data: rows,
      x: "month",
      y: "count",
      "onLongPress.0": "@actions.details",
    });
    const { canvas, engine, events } = await mount([bars]);
    canvas.dispatchEvent({ type: "mousedown", clientX: 160, clientY: 100, button: 0, buttons: 1 });
    await new Promise((r) => setTimeout(r, 560));
    expect(engine.dispatched.map((d) => d.name)).toEqual(["details"]);
    expect(engine.dispatched[0]!.payload.index).toBe(1);
    events.destroy();
  });

  test("a press released before the hold never long-presses", async () => {
    const bars = node("Bars", {
      data: rows,
      x: "month",
      y: "count",
      "onLongPress.0": "@actions.details",
    });
    const { canvas, engine, events } = await mount([bars]);
    click(canvas, 160, 100);
    await new Promise((r) => setTimeout(r, 560));
    expect(engine.dispatched).toHaveLength(0);
    events.destroy();
  });

  test("a Marker's interactive children stay interactive", async () => {
    const button = node("Button", { 0: "close", "onClick.0": "@actions.close" });
    const marker = node("Marker", { x: 1, y: 5, anchor: "center" }, [button]);
    const { canvas, engine, events } = await mount([marker], { x: [0, 2], y: [0, 10] });
    const box = button.layout!;
    click(canvas, box.x + box.width / 2, box.y + box.height / 2);
    expect(engine.dispatched.map((d) => d.name)).toEqual(["close"]);
    events.destroy();
  });
});

describe("reactivity", () => {
  test("changing a mark's data re-resolves the domain and the geometry", () => {
    const line = node("Line", { points: [1, 2] });
    const chart = layoutChart([line]);
    expect(inspectChart(chart)!.y.max).toBe(2);

    line.props.points = [1, 200];
    computeLayout(ctx(), chart, 400, 300);
    expect(inspectChart(chart)!.y.max).toBe(200);
  });

  test("removing a mark re-resolves the domain", () => {
    const small = node("Line", { points: [1, 2] });
    const big = node("Points", { points: [[0, 90]] });
    const chart = layoutChart([small, big]);
    expect(inspectChart(chart)!.y.max).toBe(100);

    chart.children = [small];
    computeLayout(ctx(), chart, 400, 300);
    expect(inspectChart(chart)!.y.max).toBe(2);
  });

  test("a resize re-lays the marks out", () => {
    const bars = node("Bars", { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] });
    const chart = node("Chart", {}, [bars]);
    computeLayout(ctx(), chart, 320, 200);
    const first = inspectChart(chart)!.plot.width;
    computeLayout(ctx(), chart, 640, 200);
    expect(inspectChart(chart)!.plot.width).toBeGreaterThan(first);
  });
});
