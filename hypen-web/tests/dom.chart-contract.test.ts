import { semanticAction } from "./helpers";
/**
 * Chart family contract on the DOM renderer.
 *
 * `Chart` hosts an <svg> coordinate space; marks (`Line`, `Area`, `Bars`,
 * `Points`, `Axis`, `Rule`, `Marker`, `Path`) speak data units and are laid
 * out by the chart. Events on a mark carry the datum, not pixels.
 *
 * Runs on the lightweight fake DOM: the fake reports a zero bounding rect,
 * so the chart falls back to its `width`/`height` props (or the defaults),
 * which makes every pixel below deterministic.
 */

import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import {
  CHART_DEFAULTS,
  inspectChart,
  niceDomain,
  normalizeData,
  ticks,
} from "../packages/web/src/dom/components/chart";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

// The generic payload extractor sniffs `event instanceof MouseEvent`; the fake
// DOM defines no event classes, so give it inert ones. The chart resolver reads
// `clientX`/`clientY` off the plain event object regardless.
for (const name of ["MouseEvent", "KeyboardEvent", "PointerEvent", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
  if (typeof (globalThis as any)[name] !== "function") (globalThis as any)[name] = class {};
}

class StubEngine {
  dispatched: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.dispatched.push(semanticAction(name, payload));
  }
}

type Def = [id: string, type: string, props?: Record<string, unknown>];

function render(definitions: Def[], inserts: Array<[parentId: string, id: string]>) {
  const engine = new StubEngine();
  const renderer = new DOMRenderer(
    document.createElement("div"),
    engine as unknown as Engine,
  );
  renderer.applyPatches([
    ...definitions.map(([id, elementType, props = {}]) => ({
      type: "create", id, elementType, props,
    }) as Patch),
    ...inserts.map(([parentId, id]) => ({ type: "insert", parentId, id }) as Patch),
  ]);
  const node = (id: string) => renderer.getNode(id) as unknown as FakeElement;
  return { renderer, engine, node };
}

const byTag = (el: FakeElement, tag: string) => el.children.filter((c) => c.tagName === tag);
const attr = (el: FakeElement, name: string) => el.attributes[name];
const num = (el: FakeElement, name: string) => Number(el.attributes[name]);

// Default chart: 320x200, bare inset 4 (no axes) → plot 4..316 × 4..196.
const PLOT_LEFT = CHART_DEFAULTS.bareInset;
const PLOT_RIGHT = CHART_DEFAULTS.width - CHART_DEFAULTS.bareInset;
const PLOT_TOP = CHART_DEFAULTS.bareInset;
const PLOT_BOTTOM = CHART_DEFAULTS.height - CHART_DEFAULTS.bareInset;

describe("Chart host", () => {
  test("Chart is an <svg> that fills its parent's width", () => {
    const { node } = render([["c", "Chart"]], [["root", "c"]]);
    const svg = node("c");
    expect(svg.tagName).toBe("svg");
    expect(svg.dataset.hypenType).toBe("chart");
    expect(svg.style.width).toBe("100%");
    expect(svg.style.height).toBe(`${CHART_DEFAULTS.height}px`);
  });

  test("width/height props size the host (numbers are px)", () => {
    const { node } = render([["c", "Chart", { width: 400, height: "12rem" }]], [["root", "c"]]);
    expect(node("c").style.width).toBe("400px");
    expect(node("c").style.height).toBe("12rem");
  });

  test("marks are SVG groups; Marker is a foreignObject so it can host Hypen children", () => {
    const { node } = render(
      [
        ["c", "Chart"],
        ["l", "Line", { points: [1, 2] }],
        ["m", "Marker", { x: 1, y: 2 }],
        ["t", "Text", { text: "peak" }],
      ],
      [["root", "c"], ["c", "l"], ["c", "m"], ["m", "t"]],
    );
    expect(node("l").tagName).toBe("g");
    expect(node("l").dataset.hypenType).toBe("line");
    expect(node("m").tagName).toBe("foreignobject");
    expect(node("t").parentNode).toBe(node("m"));
  });
});

describe("data normalisation", () => {
  test("a bare number list uses the index as x", () => {
    expect(normalizeData({ points: [3, 5, 2] }).map((d) => [d.x, d.y])).toEqual([[0, 3], [1, 5], [2, 2]]);
  });

  test("[x, y] tuples", () => {
    expect(normalizeData({ "0": [[10, 1], [20, 4]] }).map((d) => [d.x, d.y])).toEqual([[10, 1], [20, 4]]);
  });

  test("objects use the x:/y: field names and keep the raw row", () => {
    const rows = [{ month: "Jan", count: 3 }, { month: "Feb", count: 7 }];
    const data = normalizeData({ data: rows, x: "month", y: "count" });
    expect(data.map((d) => [d.x, d.y])).toEqual([["Jan", 3], ["Feb", 7]]);
    expect(data[1]!.raw).toBe(rows[1]);
  });

  test("Bars sugar: label:/value: name the fields", () => {
    const data = normalizeData({ data: [{ day: "Mon", kcal: 1800 }], label: "day", value: "kcal" });
    expect(data.map((d) => [d.x, d.y])).toEqual([["Mon", 1800]]);
  });

  test("a JSON-encoded list (remote wire form) is accepted", () => {
    expect(normalizeData({ points: "[[1,2],[3,4]]" }).length).toBe(2);
  });

  test("rows without a usable y are dropped, not zeroed", () => {
    expect(normalizeData({ points: [1, null, "x", 4] }).map((d) => d.index)).toEqual([0, 3]);
  });
});

describe("domain resolution", () => {
  test("explicit x:/y: ranges on the Chart win", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 10], y: [0, 100] }], ["l", "Line", { points: [[2, 50]] }]],
      [["root", "c"], ["c", "l"]],
    );
    const info = inspectChart(node("c") as unknown as HTMLElement)!;
    expect([info.x.min, info.x.max]).toEqual([0, 10]);
    expect([info.y.min, info.y.max]).toEqual([0, 100]);
  });

  test("without ranges the y domain is the nice-rounded union of the marks", () => {
    const { node } = render(
      [
        ["c", "Chart"],
        ["a", "Line", { points: [[0, 12], [1, 47]] }],
        ["b", "Points", { points: [[0, 63]] }],
      ],
      [["root", "c"], ["c", "a"], ["c", "b"]],
    );
    const info = inspectChart(node("c") as unknown as HTMLElement)!;
    expect([info.x.min, info.x.max]).toEqual([0, 1]);
    expect([info.y.min, info.y.max]).toEqual(niceDomain(12, 63, CHART_DEFAULTS.ticks));
    expect(info.y.min).toBeLessThanOrEqual(12);
    expect(info.y.max).toBeGreaterThanOrEqual(63);
  });

  test("Bars always include zero so bar heights are honest", () => {
    const { node } = render(
      [["c", "Chart"], ["b", "Bars", { data: [40, 50, 60] }]],
      [["root", "c"], ["c", "b"]],
    );
    expect(inspectChart(node("c") as unknown as HTMLElement)!.y.min).toBe(0);
  });

  test("a string x anywhere switches x to categorical bands", () => {
    const { node } = render(
      [["c", "Chart"], ["b", "Bars", { data: [{ x: "Jan", y: 1 }, { x: "Feb", y: 2 }] }]],
      [["root", "c"], ["c", "b"]],
    );
    const info = inspectChart(node("c") as unknown as HTMLElement)!;
    expect(info.x.kind).toBe("band");
    expect(info.x.categories).toEqual(["Jan", "Feb"]);
  });

  test("axes reserve label room; a bare chart is edge-to-edge (sparkline)", () => {
    const bare = render([["c", "Chart"], ["l", "Line", { points: [1, 2] }]], [["root", "c"], ["c", "l"]]);
    expect(inspectChart(bare.node("c") as unknown as HTMLElement)!.plot.left).toBe(CHART_DEFAULTS.bareInset);

    const axes = render(
      [["c", "Chart"], ["ax", "Axis", { "0": "x" }], ["ay", "Axis", { "0": "y" }], ["l", "Line", { points: [1, 2] }]],
      [["root", "c"], ["c", "ax"], ["c", "ay"], ["c", "l"]],
    );
    const plot = inspectChart(axes.node("c") as unknown as HTMLElement)!.plot;
    expect(plot.left).toBe(CHART_DEFAULTS.insetLeft);
    expect(plot.top + plot.height).toBe(CHART_DEFAULTS.height - CHART_DEFAULTS.insetBottom);
  });

  test("nice ticks", () => {
    expect(ticks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(ticks(0, 7, 5)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(niceDomain(12, 63, 5)).toEqual([10, 70]);
  });
});

describe("mark geometry", () => {
  test("Bars: one <rect> per datum, indexed, heights proportional to value", () => {
    const { node } = render(
      [["c", "Chart", { y: [0, 100] }], ["b", "Bars", { data: [25, 100] }]],
      [["root", "c"], ["c", "b"]],
    );
    const rects = byTag(node("b"), "rect");
    expect(rects.length).toBe(2);
    expect(attr(rects[0]!, "data-index")).toBe("0");
    expect(attr(rects[1]!, "data-index")).toBe("1");
    const plotHeight = PLOT_BOTTOM - PLOT_TOP;
    expect(num(rects[1]!, "height")).toBeCloseTo(plotHeight, 1);
    expect(num(rects[0]!, "height")).toBeCloseTo(plotHeight / 4, 1);
    // Bars sit on the zero line.
    expect(num(rects[0]!, "y") + num(rects[0]!, "height")).toBeCloseTo(PLOT_BOTTOM, 1);
  });

  test("Bars: highlight keeps the chosen bars and dims the rest", () => {
    const { node } = render(
      [["c", "Chart"], ["b", "Bars", { data: [1, 2, 3], highlight: 1 }]],
      [["root", "c"], ["c", "b"]],
    );
    const rects = byTag(node("b"), "rect");
    expect(attr(rects[1]!, "data-highlight")).toBe("true");
    expect(attr(rects[1]!, "fill-opacity")).toBeUndefined();
    expect(num(rects[0]!, "fill-opacity")).toBe(CHART_DEFAULTS.dimmedOpacity);
  });

  test("Line: a polyline path plus an invisible touch target per vertex", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 2], y: [0, 10] }], ["l", "Line", { points: [0, 10, 5] }]],
      [["root", "c"], ["c", "l"]],
    );
    const path = byTag(node("l"), "path")[0]!;
    const d = attr(path, "d")!;
    expect(d.startsWith(`M${PLOT_LEFT},${PLOT_BOTTOM}`)).toBe(true);
    expect(d.split(" ").length).toBe(3);
    expect(attr(path, "fill")).toBe("none");
    const hits = byTag(node("l"), "circle");
    expect(hits.length).toBe(3);
    expect(attr(hits[2]!, "data-index")).toBe("2");
    expect(num(hits[2]!, "r")).toBe(CHART_DEFAULTS.hitRadius);
  });

  test("Line: smooth emits cubic segments", () => {
    const { node } = render(
      [["c", "Chart"], ["l", "Line", { points: [1, 3, 2, 4], smooth: true }]],
      [["root", "c"], ["c", "l"]],
    );
    expect(attr(byTag(node("l"), "path")[0]!, "d")).toContain(" C");
  });

  test("Area closes back down to the zero line", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 1], y: [0, 10] }], ["a", "Area", { points: [5, 10] }]],
      [["root", "c"], ["c", "a"]],
    );
    const d = attr(byTag(node("a"), "path")[0]!, "d")!;
    expect(d.endsWith(`L${PLOT_LEFT},${PLOT_BOTTOM} Z`)).toBe(true);
  });

  test("Points: a visible circle and a larger touch target per datum", () => {
    const { node } = render(
      [["c", "Chart"], ["p", "Points", { points: [[1, 1]], radius: 5 }]],
      [["root", "c"], ["c", "p"]],
    );
    const circles = byTag(node("p"), "circle");
    expect(circles.map((c) => num(c, "r"))).toEqual([5, CHART_DEFAULTS.hitRadius]);
  });

  test("Axis(x) labels every category; Axis(y) labels nice ticks", () => {
    const { node } = render(
      [
        ["c", "Chart", { y: [0, 100] }],
        ["ax", "Axis", { "0": "x", label: "Month" }],
        ["ay", "Axis", { "0": "y", ticks: 2 }],
        ["b", "Bars", { data: [{ x: "Jan", y: 10 }, { x: "Feb", y: 90 }] }],
      ],
      [["root", "c"], ["c", "ax"], ["c", "ay"], ["c", "b"]],
    );
    const xLabels = node("ax").children.find((g) => g.attributes["data-part"] === "labels")!;
    expect(byTag(xLabels, "text").map((t) => t.textContent)).toEqual(["Jan", "Feb", "Month"]);
    const yLabels = node("ay").children.find((g) => g.attributes["data-part"] === "labels")!;
    expect(byTag(yLabels, "text").map((t) => t.textContent)).toEqual(["0", "50", "100"]);
  });

  test("Axis grid lines span the plot", () => {
    const { node } = render(
      [["c", "Chart", { y: [0, 10] }], ["ay", "Axis", { "0": "y", grid: true, ticks: 1 }], ["l", "Line", { points: [1] }]],
      [["root", "c"], ["c", "ay"], ["c", "l"]],
    );
    const ticksGroup = node("ay").children.find((g) => g.attributes["data-part"] === "ticks")!;
    const grid = byTag(ticksGroup, "line").filter((l) => l.attributes["data-part"] === "grid");
    expect(grid.length).toBeGreaterThan(0);
    expect(num(grid[0]!, "x2")).toBe(CHART_DEFAULTS.width - CHART_DEFAULTS.insetRight);
  });

  test("Rule(y:) is a full-width dashed line at the data value", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 1], y: [0, 10] }], ["r", "Rule", { y: 5 }], ["l", "Line", { points: [1] }]],
      [["root", "c"], ["c", "r"], ["c", "l"]],
    );
    const line = byTag(node("r"), "line")[0]!;
    expect(num(line, "x1")).toBe(PLOT_LEFT);
    expect(num(line, "x2")).toBe(PLOT_RIGHT);
    expect(num(line, "y1")).toBeCloseTo((PLOT_TOP + PLOT_BOTTOM) / 2, 1);
    expect(attr(node("r"), "stroke-dasharray")).toBe("4 4");
  });

  test("Marker sits at the data coordinate and records its anchor", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 10], y: [0, 10] }], ["m", "Marker", { x: 10, y: 10, anchor: "left" }], ["l", "Line", { points: [1] }]],
      [["root", "c"], ["c", "m"], ["c", "l"]],
    );
    expect(num(node("m"), "x")).toBe(PLOT_RIGHT);
    expect(num(node("m"), "y")).toBe(PLOT_TOP);
    expect(node("m").dataset.anchor).toBe("left");
  });

  test("Marker with no coordinates is hidden; one coordinate centres the other axis", () => {
    const { renderer, node } = render(
      [["c", "Chart", { x: [0, 10], y: [0, 10] }], ["m", "Marker", {}], ["l", "Line", { points: [1] }]],
      [["root", "c"], ["c", "m"], ["c", "l"]],
    );
    expect(attr(node("m"), "visibility")).toBe("hidden");
    renderer.applyPatches([{ type: "setProp", id: "m", name: "y", value: 5 } as Patch]);
    expect(attr(node("m"), "visibility")).toBeUndefined();
    expect(num(node("m"), "x")).toBeCloseTo((PLOT_LEFT + PLOT_RIGHT) / 2, 1);
    expect(num(node("m"), "y")).toBeCloseTo((PLOT_TOP + PLOT_BOTTOM) / 2, 1);
  });

  test("Path(d:) is drawn in data units through one affine transform", () => {
    const { node } = render(
      [["c", "Chart", { x: [0, 10], y: [0, 10] }], ["p", "Path", { d: "M0,0 L10,10" }]],
      [["root", "c"], ["c", "p"]],
    );
    const path = byTag(node("p"), "path")[0]!;
    expect(attr(path, "d")).toBe("M0,0 L10,10");
    const sx = (PLOT_RIGHT - PLOT_LEFT) / 10;
    const sy = (PLOT_TOP - PLOT_BOTTOM) / 10;
    expect(attr(path, "transform")).toBe(`matrix(${sx} 0 0 ${sy} ${PLOT_LEFT} ${PLOT_BOTTOM})`);
    expect(attr(path, "vector-effect")).toBe("non-scaling-stroke");
  });
});

describe("reactivity", () => {
  test("a SetProp on a mark's data re-lays the whole chart out", () => {
    const { renderer, node } = render(
      [["c", "Chart"], ["b", "Bars", { data: [1, 2] }]],
      [["root", "c"], ["c", "b"]],
    );
    expect(byTag(node("b"), "rect").length).toBe(2);
    renderer.applyPatches([{ type: "setProp", id: "b", name: "data", value: [1, 2, 3, 4] } as Patch]);
    expect(byTag(node("b"), "rect").length).toBe(4);
    expect(inspectChart(node("c") as unknown as HTMLElement)!.y.max).toBeGreaterThanOrEqual(4);
  });

  test("a SetProp on the Chart's range moves existing marks", () => {
    const { renderer, node } = render(
      [["c", "Chart", { y: [0, 10] }], ["b", "Bars", { data: [5] }]],
      [["root", "c"], ["c", "b"]],
    );
    const before = num(byTag(node("b"), "rect")[0]!, "height");
    renderer.applyPatches([{ type: "setProp", id: "c", name: "y", value: [0, 20] } as Patch]);
    const after = num(byTag(node("b"), "rect")[0]!, "height");
    expect(after).toBeCloseTo(before / 2, 1);
  });

  test("removing a mark re-resolves the domain", () => {
    const { renderer, node } = render(
      [["c", "Chart"], ["a", "Line", { points: [1] }], ["b", "Line", { points: [100] }]],
      [["root", "c"], ["c", "a"], ["c", "b"]],
    );
    expect(inspectChart(node("c") as unknown as HTMLElement)!.y.max).toBeGreaterThanOrEqual(100);
    renderer.applyPatches([{ type: "remove", id: "b" } as Patch]);
    expect(inspectChart(node("c") as unknown as HTMLElement)!.y.max).toBeLessThan(100);
  });

  test("unitless SVG props stay unitless through the CSS fallback", () => {
    const { node } = render(
      [["c", "Chart"], ["a", "Area", { points: [1, 2], "fillOpacity.0": 0.2, "strokeOpacity.0": 0.5 }]],
      [["root", "c"], ["c", "a"]],
    );
    expect(node("a").style.getPropertyValue("fill-opacity")).toBe("0.2");
    expect(node("a").style.getPropertyValue("stroke-opacity")).toBe("0.5");
  });

  test("shadow-family applicators become a drop-shadow filter on SVG marks", () => {
    const { node } = render(
      [
        ["c", "Chart"],
        ["l", "Line", { points: [1, 2], "shadow.0": { y: 2, blur: 8, color: "#000" } }],
        ["p", "Points", { points: [[0, 1]], "elevation.0": 2 }],
        ["b", "Bars", { data: [1], "boxShadow.0": "0 0 4px red" }],
        ["r", "Rule", { y: 1, "glow.0": "#10b981" }],
        ["q", "Path", { d: "M0,0", "glow.0": { color: "gold", radius: 10 } }],
      ],
      [["root", "c"], ["c", "l"], ["c", "p"], ["c", "b"], ["c", "r"], ["c", "q"]],
    );
    expect(node("l").style.filter).toBe("drop-shadow(0px 2px 8px #000)");
    expect(node("l").style.boxShadow).toBeUndefined();
    expect(node("p").style.filter).toContain("drop-shadow(0 2px 3px");
    expect(node("b").style.filter).toBe("drop-shadow(0 0 4px red)");
    expect(node("r").style.filter).toBe("drop-shadow(0 0 6px #10b981)");
    expect(node("q").style.filter).toBe("drop-shadow(0 0 10px gold)");
  });

  test("glow composes with other filter functions and can be cleared", () => {
    const { renderer, node } = render(
      [["c", "Chart"], ["l", "Line", { points: [1, 2], "glow.0": 8, "saturate.0": 1.4 }]],
      [["root", "c"], ["c", "l"]],
    );
    expect(node("l").style.filter).toContain("drop-shadow(0 0 8px currentColor)");
    expect(node("l").style.filter).toContain("saturate(1.4)");
    renderer.applyPatches([{ type: "setProp", id: "l", name: "glow.0", value: null } as Patch]);
    expect(node("l").style.filter).not.toContain("drop-shadow");
    expect(node("l").style.filter).toContain("saturate(1.4)");
  });

  test("style applicators land on the mark group as inheritable CSS", () => {
    const { node } = render(
      [["c", "Chart"], ["l", "Line", { points: [1, 2], "stroke.0": "#3b82f6", "strokeWidth.0": 3 }]],
      [["root", "c"], ["c", "l"]],
    );
    expect(node("l").style.stroke).toBe("#3b82f6");
    expect(node("l").style.getPropertyValue("stroke-width")).toBe("3px");
  });
});

describe("interaction — events carry the datum in data units", () => {
  const rows = [
    { month: "Jan", count: 10 },
    { month: "Feb", count: 30 },
    { month: "Mar", count: 20 },
  ];

  test("tapping a bar dispatches {series, index, x, y, datum}", () => {
    const { engine, node } = render(
      [
        ["c", "Chart"],
        ["b", "Bars", { data: rows, x: "month", y: "count", series: "units", "onClick.0": "@actions.pick" }],
      ],
      [["root", "c"], ["c", "b"]],
    );
    const rect = byTag(node("b"), "rect")[1]!;
    node("b").dispatchEvent("click", { type: "click", target: rect });
    expect(engine.dispatched.length).toBe(1);
    const { name, payload } = engine.dispatched[0]!;
    expect(name).toBe("pick");
    expect(payload.series).toBe("units");
    expect(payload.index).toBe(1);
    expect(payload.x).toBe("Feb");
    expect(payload.y).toBe(30);
    expect(payload.datum).toBe(rows[1]);
  });

  test("static action args and the datum travel together", () => {
    const { engine, node } = render(
      [["c", "Chart"], ["p", "Points", { points: [[1, 5]], "onClick.0": "@actions.pick", "onClick.tag": "targets" }]],
      [["root", "c"], ["c", "p"]],
    );
    node("p").dispatchEvent("click", { type: "click", target: byTag(node("p"), "circle")[0] });
    const payload = engine.dispatched[0]!.payload;
    expect(payload.tag).toBe("targets");
    expect(payload.x).toBe(1);
    expect(payload.y).toBe(5);
  });

  test("a hit on the line itself resolves the datum nearest the pointer", () => {
    const { engine, node } = render(
      [["c", "Chart", { x: [0, 2], y: [0, 10] }], ["l", "Line", { points: [1, 5, 9], "onHover.0": "@actions.hover" }]],
      [["root", "c"], ["c", "l"]],
    );
    // Pointer just right of centre: x=1 is nearest (plot is 4..316).
    const mid = (PLOT_LEFT + PLOT_RIGHT) / 2;
    node("l").dispatchEvent("mouseenter", { type: "mouseenter", target: node("l"), clientX: mid + 10, clientY: 50 });
    const payload = engine.dispatched[0]!.payload;
    expect(payload.series).toBe("line");
    expect(payload.index).toBe(1);
    expect(payload.x).toBe(1);
    expect(payload.y).toBe(5);
  });

  test("a pointer past the last vertex clamps to the last datum", () => {
    const { engine, node } = render(
      [["c", "Chart", { x: [0, 2] }], ["l", "Line", { points: [1, 5, 9], "onClick.0": "@actions.pick" }]],
      [["root", "c"], ["c", "l"]],
    );
    node("l").dispatchEvent("click", { type: "click", target: node("l"), clientX: 9999, clientY: 0 });
    expect(engine.dispatched[0]!.payload.index).toBe(2);
  });

  test("Chart-level events resolve the pointer to data coordinates", () => {
    const { engine, node } = render(
      [["c", "Chart", { x: [0, 100], y: [0, 10], "onClick.0": "@actions.plot" }], ["l", "Line", { points: [[0, 0]] }]],
      [["root", "c"], ["c", "l"]],
    );
    node("c").dispatchEvent("click", {
      type: "click",
      target: node("c"),
      clientX: (PLOT_LEFT + PLOT_RIGHT) / 2,
      clientY: PLOT_TOP,
    });
    const payload = engine.dispatched[0]!.payload;
    expect(payload.x).toBeCloseTo(50, 5);
    expect(payload.y).toBeCloseTo(10, 5);
  });

  test("onMove is a pointermove applicator (touch and mouse alike)", () => {
    const { engine, node } = render(
      [["c", "Chart", { x: [0, 1] }], ["l", "Line", { points: [3, 4], "onMove.0": "@actions.track" }]],
      [["root", "c"], ["c", "l"]],
    );
    node("l").dispatchEvent("pointermove", { type: "pointermove", target: node("l"), clientX: PLOT_RIGHT, clientY: 0 });
    expect(engine.dispatched[0]!.name).toBe("track");
    expect(engine.dispatched[0]!.payload.index).toBe(1);
  });

  test("marks with an event applicator are stamped interactive; decorative marks are not", () => {
    // The chart stylesheet keys pointer-events off this stamp so a tooltip's
    // Points/Marker never steal the pointer from the Line being hovered.
    const { node } = render(
      [
        ["c", "Chart"],
        ["l", "Line", { points: [1, 2], "onMove.0": "@actions.track" }],
        ["p", "Points", { points: [[0, 1]] }],
      ],
      [["root", "c"], ["c", "l"], ["c", "p"]],
    );
    expect(node("l").dataset.hypenInteractive).toBe("true");
    expect(node("p").dataset.hypenInteractive).toBeUndefined();
  });

  test("an event without pointer or target index still names the series", () => {
    const { engine, node } = render(
      [["c", "Chart"], ["l", "Line", { points: [1], name: "revenue", "onClick.0": "@actions.pick" }]],
      [["root", "c"], ["c", "l"]],
    );
    node("l").dispatchEvent("click", { type: "click", target: node("l") });
    const payload = engine.dispatched[0]!.payload;
    expect(payload.series).toBe("revenue");
    expect(payload.index).toBeUndefined();
  });
});
