/**
 * Canvas renderer — windowed lists (`__virt.window`, docs/virtualization.md
 * §1–§3): stand-in padding along the scroll axis, scroll extents, the
 * viewport report through `engine.setListViewport`, hit-testing past the
 * padding, the a11y mirror's set size / position, and `removeProp`.
 *
 * In Bun there is no `requestAnimationFrame`, so every patch batch and every
 * scroll renders a frame synchronously. Most tests pin the JS layout
 * backend (deterministic, no WASM); the Grid tests run on Taffy, which is
 * the backend that implements grid tracks.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import { initTaffyLayout, setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { visibleRange, wantedRange } from "../packages/core/src/virtualization";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockContext {
  fillStyle: any = "#000";
  strokeStyle: any = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  save() {}
  restore() {}
  scale() {}
  translate() {}
  rotate() {}
  transform() {}
  setTransform() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  fillText() {}
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  fill() {}
  stroke() {}
  clip() {}
  rect() {}
  setLineDash() {}
  drawImage() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
}

class MockCanvas {
  width = 800;
  height = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  private context = new MockContext();
  private listeners = new Map<string, Function[]>();
  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener(event: string, handler: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }
  removeEventListener(event: string, handler: Function) {
    const list = this.listeners.get(event);
    if (list) list.splice(list.indexOf(handler), 1);
  }
  dispatchEvent(event: any) {
    for (const h of this.listeners.get(event.type) ?? []) h(event);
    return true;
  }
  setPointerCapture() {}
  get parentElement() {
    return { appendChild: () => {} };
  }
}

/** Records viewport reports; `onReport` lets a test answer like an engine. */
class ReportingEngine {
  reports: Array<[string, number, number]> = [];
  onReport: ((id: string, start: number, end: number) => void) | null = null;
  dispatchAction() {}
  setListViewport(id: string, start: number, end: number) {
    this.reports.push([id, start, end]);
    this.onReport?.(id, start, end);
  }
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "insert", parentId, id, beforeId }) as any;
const setProp = (id: string, name: string, value: any): Patch =>
  ({ type: "setProp", id, name, value }) as any;
const removeProp = (id: string, name: string): Patch =>
  ({ type: "removeProp", id, name }) as any;
const remove = (id: string): Patch => ({ type: "remove", id }) as any;

// The JS backend sizes an auto root to its content; pin it to the canvas.
const ROOT = { width: 800, height: 600 };
const ROW = 40;
const rowId = (i: number) => `r${i}`;

/** Create + insert rows `[start, end)` under `listId`. */
function rows(listId: string, start: number, end: number, props: Record<string, any> = { height: ROW, width: 200 }): Patch[] {
  const out: Patch[] = [];
  for (let i = start; i < end; i++) {
    out.push(create(rowId(i), "Container", { ...props }), insert(listId, rowId(i)));
  }
  return out;
}

/** The batch an engine sends when it moves a window from `[a0,a1)` to `[b0,b1)`. */
function moveWindow(listId: string, total: number, a: [number, number], b: [number, number]): Patch[] {
  const out: Patch[] = [];
  for (let i = a[0]; i < a[1]; i++) if (i < b[0] || i >= b[1]) out.push(remove(rowId(i)));
  // Rows above the old window are inserted before its first kept row.
  const firstKept = Math.max(a[0], b[0]);
  for (let i = b[0]; i < b[1]; i++) {
    if (i >= a[0] && i < a[1]) continue;
    out.push(create(rowId(i), "Container", { height: ROW, width: 200 }));
    out.push(insert(listId, rowId(i), i < a[0] && firstKept < a[1] ? rowId(firstKept) : undefined));
  }
  out.push(setProp(listId, "__virt.window", { total, start: b[0], end: b[1] }));
  return out;
}

function harness() {
  const canvas = new MockCanvas();
  const engine = new ReportingEngine();
  const renderer = new CanvasRenderer(canvas as any, engine as any, {
    devicePixelRatio: 1,
    enableAccessibility: false,
  });
  const node = (id: string) => renderer.getNode(id) as VirtualNode;
  const render = () => (renderer as any).render();
  const wheel = (deltaY: number, x = 100, y = 100) =>
    canvas.dispatchEvent({
      type: "wheel",
      clientX: x,
      clientY: y,
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      preventDefault() {},
    });
  const hitTest = (x: number, y: number) =>
    (renderer as any).eventManager.hitTest({ x, y }) as VirtualNode | null;
  return { canvas, engine, renderer, node, render, wheel, hitTest };
}

/**
 * A 1,000-item windowed list. `rootScrolls`: the root column scrolls and the
 * list is padded inside it; otherwise the list scrolls itself (fixed height).
 */
function mountList(h: ReturnType<typeof harness>, rootScrolls: boolean, total = 1000, end = 30) {
  h.renderer.applyPatches([
    create("root", "Column", { ...ROOT, ...(rootScrolls ? { scrollable: "vertical" } : {}) }),
    insert("root", "root"),
    create("L", "List", rootScrolls ? {} : { height: 400, scrollable: "vertical" }),
    insert("root", "L"),
    ...rows("L", 0, end),
    setProp("L", "__virt.window", { total, start: 0, end }),
  ]);
}

// ---------------------------------------------------------------------------
// JS layout backend
// ---------------------------------------------------------------------------

describe("canvas windowed list (JS layout)", () => {
  beforeAll(() => setLayoutBackend("fallback"));
  afterAll(() => setLayoutBackend("auto"));

  test("__virt.window becomes trailing padding sized from measured rows, never a prop", () => {
    const h = harness();
    mountList(h, true);
    const list = h.node("L");

    expect(list.props["__virt.window"]).toBeUndefined();
    expect(Object.keys(list.props).some((k) => k.startsWith("__virt"))).toBe(false);
    expect(list.virt!.itemSize).toBe(ROW);
    expect(list.layout!.padding.top).toBe(0);
    expect(list.layout!.padding.bottom).toBe(970 * ROW);
    // Rows lay out at their own size from the top of the list.
    expect(h.node(rowId(0)).layout!.y).toBe(0);
    expect(h.node(rowId(29)).layout!.y).toBe(29 * ROW);
    // Total scroll extent = padding + rows = every item.
    expect(list.layout!.height).toBe(1000 * ROW);
    expect(h.node("root").scrollState!.scrollHeight).toBe(1000 * ROW);
    // The initial window covers what is visible: no report.
    expect(h.engine.reports).toEqual([]);
  });

  test("scrolling reports the overscanned range once, then the new window lays out after leading padding", () => {
    const h = harness();
    mountList(h, true);

    h.wheel(4000);
    const visible = visibleRange(1000, ROW, 4000, 600);
    const wanted = wantedRange(visible, 1000);
    expect(wanted).toEqual({ start: 85, end: 130 });
    expect(h.engine.reports).toEqual([["L", 85, 130]]);

    // Further frames with nothing new: never the same range twice.
    h.render();
    h.render();
    expect(h.engine.reports.length).toBe(1);

    h.renderer.applyPatches(moveWindow("L", 1000, [0, 30], [85, 130]));
    const list = h.node("L");
    expect(h.node(rowId(0))).toBeUndefined();
    expect(list.children.length).toBe(45);
    expect(list.layout!.padding.top).toBe(85 * ROW);
    expect(list.layout!.padding.bottom).toBe((1000 - 130) * ROW);
    expect(h.node(rowId(85)).layout!.y).toBe(85 * ROW);
    expect(h.node("root").scrollState!.scrollHeight).toBe(1000 * ROW);
    expect(h.node("root").scrollState!.scrollY).toBe(4000);
    // The new window covers the visible range: still exactly one report.
    expect(h.engine.reports.length).toBe(1);
  });

  test("a window the engine moves on its own may be asked for the last-reported range again", () => {
    const h = harness();
    mountList(h, true);
    h.wheel(4000);
    expect(h.engine.reports).toEqual([["L", 85, 130]]);

    // The engine moves the window itself (total changed) before answering:
    // [0,30) still misses the visible range and the range to ask is the
    // same [85,130). It must be asked again, not wait for the next scroll.
    h.renderer.applyPatches([setProp("L", "__virt.window", { total: 1001, start: 0, end: 30 })]);
    h.render();
    expect(h.engine.reports).toEqual([
      ["L", 85, 130],
      ["L", 85, 130],
    ]);

    // An identical re-send is not a change: no report.
    h.renderer.applyPatches([setProp("L", "__virt.window", { total: 1001, start: 0, end: 30 })]);
    h.render();
    expect(h.engine.reports.length).toBe(2);
  });

  test("a report the engine answers with no window change is not repeated", () => {
    const h = harness();
    mountList(h, true);
    h.wheel(4000);
    expect(h.engine.reports).toEqual([["L", 85, 130]]);
    // No window comes back: frames never re-send the report.
    for (let i = 0; i < 5; i++) h.render();
    expect(h.engine.reports).toEqual([["L", 85, 130]]);
  });

  test("hit-testing lands on the row under the pointer after the leading padding", () => {
    const h = harness();
    mountList(h, true);
    h.wheel(4000);
    h.renderer.applyPatches(moveWindow("L", 1000, [0, 30], [85, 130]));

    // Scrolled 4000px: screen y 0..40 is item 100, y 50 is item 101.
    expect(h.hitTest(10, 20)?.id).toBe(rowId(100));
    expect(h.hitTest(10, 50)?.id).toBe(rowId(101));
  });

  test("a list that scrolls itself shifts its rows and extends its own scroll extent", () => {
    const h = harness();
    mountList(h, false);
    const list = h.node("L");

    expect(list.virt!.selfScroll).toBe(true);
    // No layout padding: the fixed-height box keeps its size.
    expect(list.layout!.height).toBe(400);
    expect(list.layout!.padding.bottom).toBe(0);
    expect(list.scrollState!.scrollHeight).toBe(1000 * ROW);

    h.wheel(2000);
    expect(h.engine.reports).toEqual([["L", 40, 70]]);

    h.renderer.applyPatches(moveWindow("L", 1000, [0, 30], [40, 70]));
    expect(h.node(rowId(40)).layout!.y).toBe(40 * ROW);
    expect(list.scrollState!.scrollHeight).toBe(1000 * ROW);
    expect(list.scrollState!.scrollY).toBe(2000);
    // Scrolled 2000px inside the list: screen y 10 is item 50.
    expect(h.hitTest(10, 10)?.id).toBe(rowId(50));
    expect(h.engine.reports.length).toBe(1);
  });

  test("scrolling back above the window reports again (one report per new range)", () => {
    const h = harness();
    mountList(h, false);
    h.wheel(20000);
    expect(h.engine.reports).toEqual([["L", 490, 520]]);
    h.renderer.applyPatches(moveWindow("L", 1000, [0, 30], [490, 520]));
    h.wheel(-19000);
    expect(h.engine.reports).toEqual([
      ["L", 490, 520],
      ["L", 15, 45],
    ]);
  });

  test("the engine answering synchronously converges without nested frames", () => {
    const h = harness();
    mountList(h, true);
    let window: [number, number] = [0, 30];
    h.engine.onReport = (id, start, end) => {
      const next: [number, number] = [start, end];
      h.renderer.applyPatches(moveWindow(id, 1000, window, next));
      window = next;
    };
    h.wheel(4000);
    expect(h.engine.reports).toEqual([["L", 85, 130]]);
    expect(h.node(rowId(100)).layout!.y).toBe(100 * ROW);
    h.wheel(4000);
    expect(h.engine.reports.at(-1)).toEqual(["L", 185, 230]);
    expect(h.hitTest(10, 20)?.id).toBe(rowId(200));
  });

  test("scroll anchoring: a window change that moves the leading padding keeps the first visible row in place", () => {
    const h = harness();
    mountList(h, false);
    const list = h.node("L");
    h.wheel(600); // item 15 at the top; [0, 30) still covers what is visible
    expect(h.engine.reports).toEqual([]);
    expect(h.hitTest(10, 5)?.id).toBe(rowId(15));

    // The window drops 0..9 and adds 30..39, which are taller: the average
    // row grows to 60px, so the leading padding becomes 10 × 60 = 600 and
    // item 15 would jump from y 600 to 800 without anchoring.
    const patches: Patch[] = [];
    for (let i = 0; i < 10; i++) patches.push(remove(rowId(i)));
    for (let i = 30; i < 40; i++) {
      patches.push(create(rowId(i), "Container", { height: 100, width: 200 }), insert("L", rowId(i)));
    }
    patches.push(setProp("L", "__virt.window", { total: 1000, start: 10, end: 40 }));
    h.renderer.applyPatches(patches);

    expect(list.virt!.itemSize).toBe(60);
    expect(h.node(rowId(15)).layout!.y).toBe(800);
    expect(list.scrollState!.scrollY).toBe(800);
    expect(h.hitTest(10, 5)?.id).toBe(rowId(15));
  });

  test("removeProp of __virt.window restores normal container layout", () => {
    const h = harness();
    mountList(h, true);
    h.renderer.applyPatches([removeProp("L", "__virt.window")]);
    const list = h.node("L");
    expect(list.virt).toBeUndefined();
    expect(list.layout!.padding.bottom).toBe(0);
    expect(list.layout!.height).toBe(30 * ROW);
    expect(h.node("root").scrollState!.scrollHeight).toBe(30 * ROW);
    h.wheel(500);
    expect(h.engine.reports).toEqual([]);
  });

  test("window and rows in one batch: the window applies after the structural patches", () => {
    const h = harness();
    h.renderer.applyPatches([
      create("root", "Column", { ...ROOT, scrollable: "vertical" }),
      insert("root", "root"),
      // The window arrives in the list's create props, BEFORE its rows.
      create("L", "List", { "__virt.window": { total: 100, start: 0, end: 10 } }),
      insert("root", "L"),
      ...rows("L", 0, 10),
    ]);
    const list = h.node("L");
    expect(list.props["__virt.window"]).toBeUndefined();
    expect(list.virt!.window).toEqual({ total: 100, start: 0, end: 10 });
    expect(list.layout!.padding.bottom).toBe(90 * ROW);
  });

  test("estimatedSize seeds the padding until rows are measured; malformed windows are ignored", () => {
    const h = harness();
    h.renderer.applyPatches([
      create("root", "Column", { ...ROOT, scrollable: "vertical" }),
      insert("root", "root"),
      create("L", "List"),
      insert("root", "L"),
      setProp("L", "__virt.window", { total: 100, start: 0, end: 0, estimatedSize: 25 }),
    ]);
    const list = h.node("L");
    expect(list.layout!.padding.bottom).toBe(100 * 25);
    h.renderer.applyPatches([setProp("L", "__virt.window", { total: 5, start: 4, end: 9 })]);
    expect(list.virt!.window.total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Accessibility mirror
// ---------------------------------------------------------------------------

describe("canvas windowed list — accessibility mirror", () => {
  beforeAll(() => setLayoutBackend("fallback"));
  afterAll(() => setLayoutBackend("auto"));

  function findMirror(id: string): FakeElement | undefined {
    const body = (document as any).body as FakeElement;
    const find = (el: FakeElement): FakeElement | undefined => {
      if (el.attributes["data-hypen-id"] === id) return el;
      for (const child of el.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(body);
  }

  test("rows carry aria-setsize = total and aria-posinset = item index + 1", () => {
    ensureFakeDomGlobals();
    const canvas: any = (document as any).createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = new MockContext();
    canvas.getContext = (type: string) => (type === "2d" ? ctx : null);
    canvas.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 });
    const engine = new ReportingEngine();
    const renderer = new CanvasRenderer(canvas, engine as any, { devicePixelRatio: 1, enableAccessibility: true });

    renderer.applyPatches([
      create("root", "Column", { ...ROOT, scrollable: "vertical" }),
      insert("root", "root"),
      create("L", "List"),
      insert("root", "L"),
      ...rows("L", 40, 50),
      setProp("L", "__virt.window", { total: 1000, start: 40, end: 50 }),
    ]);
    expect(findMirror(rowId(40))!.attributes["aria-setsize"]).toBe("1000");
    expect(findMirror(rowId(40))!.attributes["aria-posinset"]).toBe("41");
    expect(findMirror(rowId(49))!.attributes["aria-posinset"]).toBe("50");
    // The mirror boxes sit where the rows paint: after the leading padding.
    expect(findMirror(rowId(40))!.style.top).toBe(`${40 * ROW}px`);

    // A reorder inside the window changes no __virt.window: positions still follow.
    renderer.applyPatches([{ type: "move", parentId: "L", id: rowId(49), beforeId: rowId(40) } as Patch]);
    expect(findMirror(rowId(49))!.attributes["aria-posinset"]).toBe("41");
    expect(findMirror(rowId(40))!.attributes["aria-posinset"]).toBe("42");

    renderer.applyPatches([removeProp("L", "__virt.window")]);
    expect(findMirror(rowId(40))!.attributes["aria-setsize"]).toBeUndefined();
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Taffy backend (grid tracks)
// ---------------------------------------------------------------------------

describe("canvas windowed list (Taffy)", () => {
  let taffy = false;
  beforeAll(async () => {
    taffy = await initTaffyLayout();
    setLayoutBackend("auto");
  });

  test("a Grid pads by rows of `columns` items", () => {
    expect(taffy).toBe(true);
    const h = harness();
    h.renderer.applyPatches([
      create("root", "Column", { ...ROOT, scrollable: "vertical" }),
      insert("root", "root"),
      create("G", "Grid", { columns: 3 }),
      insert("root", "G"),
      ...rows("G", 0, 30, { height: 50 }),
      setProp("G", "__virt.window", { total: 300, start: 0, end: 30 }),
    ]);
    const grid = h.node("G");
    expect(grid.virt!.columns).toBe(3);
    expect(grid.virt!.itemSize).toBe(50);
    expect(grid.layout!.padding.bottom).toBe(90 * 50);
    expect(grid.layout!.height).toBe(100 * 50);
    // Item 4 is the second cell of the second row.
    expect(h.node(rowId(4)).layout!.y).toBe(50);

    h.wheel(1000);
    const wanted = wantedRange(visibleRange(300, 50, 1000, 600, 3), 300);
    expect(wanted).toEqual({ start: 24, end: 132 });
    // 12 rows (36 items) are visible but the initial window holds 30: the
    // first frame already asked for [0, 72); the scroll asks for more.
    expect(h.engine.reports).toEqual([
      ["G", 0, 72],
      ["G", 24, 132],
    ]);

    const patches: Patch[] = [];
    for (let i = 0; i < 24; i++) patches.push(remove(rowId(i)));
    for (let i = 30; i < 132; i++) patches.push(create(rowId(i), "Container", { height: 50 }), insert("G", rowId(i)));
    patches.push(setProp("G", "__virt.window", { total: 300, start: 24, end: 132 }));
    h.renderer.applyPatches(patches);

    expect(grid.layout!.padding.top).toBe(8 * 50);
    expect(h.node(rowId(24)).layout!.y).toBe(8 * 50);
    // Scrolled 1000px: screen y 10 is grid row 20 → items 60..62.
    expect(h.hitTest(10, 10)?.id).toBe(rowId(60));
    expect(h.engine.reports.length).toBe(2);
  });

  test("a vertical List pads on Taffy too", () => {
    expect(taffy).toBe(true);
    const h = harness();
    mountList(h, true);
    const list = h.node("L");
    expect(list.layout!.padding.bottom).toBe(970 * ROW);
    expect(list.layout!.height).toBe(1000 * ROW);
    h.wheel(4000);
    expect(h.engine.reports).toEqual([["L", 85, 130]]);
  });
});
