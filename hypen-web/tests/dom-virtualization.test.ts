/**
 * DOM renderer side of list virtualization (docs/virtualization.md §1–§3):
 * `__virt.window` → padding stand-ins, row aria positions, scroll anchoring,
 * and `setListViewport` reports from the list's scroll container.
 *
 * fake-dom has no layout, so `FakeLayout` below is a tiny block layout for
 * one list: rows stack along the scroll axis after the list's leading
 * padding (or in grid rows), and the list or one ancestor scrolls.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { Engine } from "../packages/server/src/engine";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const box = (top: number, height: number, left = 0, width = 300): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});
const px = (v: string | undefined) => (v ? parseFloat(v) : 0);

class FakeLayout {
  /** The scrolling element (the list itself or an ancestor); null = window. */
  scroller: FakeElement | null = null;
  /** The list's offset inside the scroller's content (ancestor case). */
  listOffset = 0;
  viewport = 500;
  cols = 1;
  rowHeight: (row: FakeElement) => number = () => 50;

  constructor(public list: () => FakeElement | undefined) {}

  rect(el: FakeElement): Rect | null {
    const list = this.list();
    if (!list) return null;
    const scroll = this.scroller ? (this.scroller as any).scrollTop ?? 0 : 0;
    const listTop = this.scroller === list ? 0 : this.listOffset - scroll;
    if (el === this.scroller) return box(0, this.viewport);
    if (el === list) {
      let h = px(list.style.paddingTop) + px(list.style.paddingBottom);
      for (const c of list.children) h += this.rowHeight(c);
      return box(listTop, this.scroller === list ? this.viewport : h);
    }
    if (el.parentNode === list) {
      const i = list.children.indexOf(el);
      let y = listTop + px(list.style.paddingTop) - (this.scroller === list ? scroll : 0);
      if (this.cols > 1) {
        y += Math.floor(i / this.cols) * this.rowHeight(el);
      } else {
        for (let k = 0; k < i; k++) y += this.rowHeight(list.children[k]!);
      }
      return box(y, this.rowHeight(el));
    }
    return null;
  }
}

class SpyEngine {
  reports: Array<[string, number, number]> = [];
  dispatchAction(): void {}
  setListViewport(id: string, start: number, end: number): void {
    this.reports.push([id, start, end]);
  }
}

let frames: Array<() => void> = [];
const g = globalThis as any;
let savedRaf: unknown;
let savedCaf: unknown;
let savedRO: unknown;

beforeEach(() => {
  ensureFakeDomGlobals();
  frames = [];
  savedRaf = g.requestAnimationFrame;
  savedCaf = g.cancelAnimationFrame;
  savedRO = g.ResizeObserver;
  g.requestAnimationFrame = (cb: () => void) => frames.push(cb);
  g.cancelAnimationFrame = (h: number) => {
    frames[h - 1] = () => {};
  };
});

afterEach(() => {
  FakeElement.layoutHook = null;
  g.requestAnimationFrame = savedRaf;
  g.cancelAnimationFrame = savedCaf;
  g.ResizeObserver = savedRO;
});

function runFrames(): void {
  const pending = frames;
  frames = [];
  for (const f of pending) f();
}

const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

const rowPatches = (from: number, to: number, parent = "list"): Patch[] => {
  const out: Patch[] = [];
  for (let i = from; i < to; i++) {
    out.push({ type: "create", id: `r${i}`, elementType: "Text", props: { 0: `row ${i}` } } as Patch);
    out.push({ type: "insert", parentId: parent, id: `r${i}` } as Patch);
  }
  return out;
};
const win = (total: number, start: number, end: number, extra: Record<string, unknown> = {}): Patch =>
  ({ type: "setProp", id: "list", name: "__virt.window", value: { total, start, end, ...extra } }) as Patch;

function setup(opts: { elementType?: string; listProps?: Record<string, unknown>; wrap?: boolean } = {}) {
  const engine = new SpyEngine();
  const renderer = new DOMRenderer(document.createElement("div") as any, engine as any);
  const list = () => renderer.getNode("list") as unknown as FakeElement | undefined;
  const layout = new FakeLayout(list);
  FakeElement.layoutHook = (el) => layout.rect(el);
  const base: Patch[] = [
    { type: "create", id: "page", elementType: "Column", props: {} } as Patch,
    { type: "create", id: "list", elementType: opts.elementType ?? "List", props: opts.listProps ?? {} } as Patch,
    { type: "insert", parentId: "root", id: "page" } as Patch,
    { type: "insert", parentId: "page", id: "list" } as Patch,
  ];
  renderer.applyPatches(base);
  return {
    engine,
    renderer,
    layout,
    list: () => list()!,
    page: () => renderer.getNode("page") as unknown as FakeElement,
  };
}

/** Make the list itself the scroll container. */
function selfScroll(s: ReturnType<typeof setup>, scrollHeight = 50_000) {
  const list = s.list() as any;
  list.clientHeight = s.layout.viewport;
  list.scrollHeight = scrollHeight;
  list.scrollTop = 0;
  s.layout.scroller = s.list();
}

describe("__virt.window layout", () => {
  test("padding stands in for the rows outside the window; never a plain prop", async () => {
    const s = setup();
    selfScroll(s);
    s.layout.rowHeight = () => 0; // unmeasured: falls back to the default 48
    s.renderer.applyPatches([...rowPatches(0, 10), win(100, 0, 10)]);
    const list = s.list();
    expect(list.style.paddingTop).toBe("0px");
    expect(list.style.paddingBottom).toBe(`${90 * 48}px`);
    expect(list.attributes["__virt.window"]).toBeUndefined();
    expect((list.style as any)["__virt.window"]).toBeUndefined();
    expect(list.style.overflow).toBe("auto"); // List stays a scroll container

    // Measured rows (50px) drive the size from then on.
    s.layout.rowHeight = () => 50;
    s.renderer.applyPatches([
      ...Array.from({ length: 10 }, (_, i) => ({ type: "remove", id: `r${i}` }) as Patch),
      ...rowPatches(20, 30),
      win(100, 20, 30),
    ]);
    expect(list.style.paddingTop).toBe("1000px");
    expect(list.style.paddingBottom).toBe("3500px");
  });

  test("estimatedSize is used for unmeasured rows", () => {
    const s = setup();
    s.layout.rowHeight = () => 0;
    s.renderer.applyPatches([...rowPatches(0, 5), win(20, 0, 5, { estimatedSize: 30 })]);
    expect(s.list().style.paddingBottom).toBe(`${15 * 30}px`);
  });

  test("a malformed window is ignored; the current one stays", () => {
    const s = setup();
    s.renderer.applyPatches([...rowPatches(0, 5), win(50, 0, 5)]);
    s.renderer.applyPatches([win(5, 4, 9)]); // end > total
    expect(s.list().style.paddingBottom).toBe(`${45 * 50}px`);
    expect(s.list().children[0]!.attributes["aria-setsize"]).toBe("50");
  });

  test("rows evicted by a window move disappear; aria positions follow the window", () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 10), win(1000, 0, 10)]);
    const list = s.list();
    expect(list.children.map((c) => c.attributes["aria-posinset"])).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1))
    );
    expect(list.children.every((c) => c.attributes["aria-setsize"] === "1000")).toBe(true);

    s.renderer.applyPatches([
      ...Array.from({ length: 5 }, (_, i) => ({ type: "remove", id: `r${i}` }) as Patch),
      ...rowPatches(10, 15),
      win(1000, 5, 15),
    ]);
    expect(list.children.map((c) => c.dataset.hypenId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${i + 5}`)
    );
    expect(s.renderer.getNode("r0")).toBeUndefined();
    expect(list.children[0]!.attributes["aria-posinset"]).toBe("6");
    expect(list.children[9]!.attributes["aria-posinset"]).toBe("15");
    expect(list.style.paddingTop).toBe(`${5 * 50}px`);
  });

  test("multi-node templates group children into items", () => {
    const s = setup();
    s.layout.rowHeight = () => 25; // two 25px nodes per item
    s.renderer.applyPatches([...rowPatches(0, 20), win(100, 10, 20)]);
    const list = s.list();
    expect(list.children.map((c) => c.attributes["aria-posinset"]).slice(0, 4)).toEqual(["11", "11", "12", "12"]);
    // 20 nodes × 25px = 500px over 10 items → 50px per item.
    expect(list.style.paddingTop).toBe("500px");
    expect(list.style.paddingBottom).toBe(`${80 * 50}px`);
  });

  test("grid pads whole rows of `columns` items", () => {
    const s = setup({ elementType: "Grid", listProps: { columns: 3 } });
    s.layout.cols = 3;
    s.layout.rowHeight = () => 100;
    s.renderer.applyPatches([...rowPatches(9, 18), win(30, 9, 18)]);
    const list = s.list();
    expect(list.style.paddingTop).toBe("300px");
    expect(list.style.paddingBottom).toBe("400px");
  });

  test("grid columns from the applicator spelling", () => {
    const s = setup({ elementType: "Grid", listProps: { "columns.0": 2 } });
    s.layout.cols = 2;
    s.layout.rowHeight = () => 100;
    s.renderer.applyPatches([...rowPatches(4, 8), win(20, 4, 8)]);
    expect(s.list().style.paddingTop).toBe("200px");
    expect(s.list().style.paddingBottom).toBe("600px");
  });

  test("author padding is preserved and added to", () => {
    const s = setup({ listProps: { "padding.0": 16 } });
    s.renderer.applyPatches([...rowPatches(10, 20), win(100, 10, 20)]);
    const list = s.list();
    expect(list.style.paddingTop).toBe(`${16 + 500}px`);
    expect(list.style.paddingBottom).toBe(`${16 + 80 * 50}px`);

    // An author longhand written later becomes the new base.
    s.renderer.applyPatches([{ type: "setProp", id: "list", name: "paddingTop", value: 8 } as Patch]);
    expect(list.style.paddingTop).toBe(`${8 + 500}px`);

    s.renderer.applyPatches([{ type: "removeProp", id: "list", name: "__virt.window" } as Patch]);
    expect(list.style.paddingTop).toBe("8px");
    expect(list.style.padding).toBe("16px");
  });

  test("horizontal lists pad left/right", () => {
    const s = setup({ listProps: { direction: "horizontal" } });
    FakeElement.layoutHook = null; // unmeasured
    s.renderer.applyPatches([...rowPatches(0, 5), win(10, 2, 7)]);
    const list = s.list();
    expect(list.style.paddingLeft).toBe(`${2 * 48}px`);
    expect(list.style.paddingRight).toBe(`${3 * 48}px`);
    expect(list.style.paddingTop).toBeUndefined();
  });

  test("a windowed Column (sole lazy ForEach) is handled like a List", () => {
    const s = setup({ elementType: "Column" });
    s.renderer.applyPatches([...rowPatches(0, 5), win(50, 0, 5)]);
    expect(s.list().style.paddingBottom).toBe(`${45 * 50}px`);
  });
});

describe("viewport reports", () => {
  test("scroll reports exactly once with the overscanned range, never twice", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    // visible [0,10) wanted [0,20): covered, nothing to report.
    expect(s.engine.reports).toEqual([]);

    (s.list() as any).scrollTop = 2000;
    s.list().dispatchEvent("scroll");
    s.list().dispatchEvent("scroll"); // same frame: throttled
    expect(frames.length).toBe(1);
    runFrames();
    // visible [40,50) → overscan one viewport (10) each side.
    expect(s.engine.reports).toEqual([["list", 30, 60]]);

    s.list().dispatchEvent("scroll");
    runFrames();
    expect(s.engine.reports.length).toBe(1);
  });

  test("a window the engine moves on its own may be asked for the last-reported range again", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    (s.list() as any).scrollTop = 2000;
    s.list().dispatchEvent("scroll");
    runFrames();
    expect(s.engine.reports).toEqual([["list", 30, 60]]);

    // Before answering, the engine moves the window itself (total changed):
    // [0,20) still does not cover [40,50), and the range to ask is [30,60]
    // again. The renderer must not stall until the next scroll.
    s.renderer.applyPatches([win(1001, 0, 20)]);
    await tick();
    runFrames();
    expect(s.engine.reports).toEqual([
      ["list", 30, 60],
      ["list", 30, 60],
    ]);

    // An identical re-send is not a change: no report.
    s.renderer.applyPatches([win(1001, 0, 20)]);
    await tick();
    runFrames();
    expect(s.engine.reports.length).toBe(2);
  });

  test("a report the engine answers with no window change is not repeated", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    (s.list() as any).scrollTop = 2000;
    s.list().dispatchEvent("scroll");
    runFrames();
    expect(s.engine.reports).toEqual([["list", 30, 60]]);
    // The engine sends nothing back; scrolling within the range, layout
    // passes and frames never re-send it.
    for (let i = 0; i < 3; i++) {
      s.list().dispatchEvent("scroll");
      runFrames();
      await tick();
      runFrames();
    }
    expect(s.engine.reports).toEqual([["list", 30, 60]]);
  });

  test("first layout reports when the window does not cover the viewport", async () => {
    const s = setup();
    s.layout.viewport = 1000; // 20 visible rows of 50px, 5 materialized
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 5), win(1000, 0, 5)]);
    expect(s.engine.reports).toEqual([]); // never inside the batch
    await tick();
    expect(s.engine.reports).toEqual([["list", 0, 40]]);
  });

  test("the window shrinking/growing re-checks after the batch", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    expect(s.engine.reports).toEqual([]);
    // Window far larger than needed (an engine-side change): shrink it.
    s.renderer.applyPatches([...rowPatches(20, 100), win(1000, 0, 100)]);
    await tick();
    expect(s.engine.reports).toEqual([["list", 0, 20]]);
  });

  test("a nested scrolling ancestor is the scroll container", async () => {
    const s = setup({ listProps: {} });
    const page = s.page() as any;
    page.style.overflowY = "auto";
    page.clientHeight = 500;
    page.scrollHeight = 60_000;
    page.scrollTop = 0;
    s.layout.scroller = s.page();
    s.layout.listOffset = 100;
    // The List grows with its content: it does not scroll itself.
    const list = s.list() as any;
    list.clientHeight = 50_000;
    list.scrollHeight = 50_000;
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    expect(s.engine.reports).toEqual([]);

    page.scrollTop = 1100; // 1000px past the list's top edge
    list.dispatchEvent("scroll"); // the list's own scroll is not listened to
    expect(frames.length).toBe(0);
    page.dispatchEvent("scroll");
    runFrames();
    // visible [20,30) → wanted [10,40)
    expect(s.engine.reports).toEqual([["list", 10, 40]]);
  });

  test("removeProp drops padding, aria, and listeners", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    const list = s.list();
    s.renderer.applyPatches([{ type: "removeProp", id: "list", name: "__virt.window" } as Patch]);
    expect(list.style.paddingTop).toBeUndefined();
    expect(list.style.paddingBottom).toBeUndefined();
    expect(list.style.overflowAnchor).toBeUndefined();
    expect(list.children[0]!.attributes["aria-posinset"]).toBeUndefined();
    expect(list.children[0]!.attributes["aria-setsize"]).toBeUndefined();

    (list as any).scrollTop = 5000;
    list.dispatchEvent("scroll");
    runFrames();
    await tick();
    expect(frames.length).toBe(0);
    expect(s.engine.reports).toEqual([]);
  });

  test("removing the list element stops its listeners", async () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    await tick();
    const list = s.list();
    s.renderer.applyPatches([{ type: "remove", id: "page" } as Patch]);
    (list as any).scrollTop = 5000;
    list.dispatchEvent("scroll");
    runFrames();
    expect(s.engine.reports).toEqual([]);
  });

  test("a resize re-measures rows and re-pads", async () => {
    const observers: Array<() => void> = [];
    g.ResizeObserver = class {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    };
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(10, 20), win(100, 10, 20)]);
    expect(s.list().style.paddingTop).toBe("500px");
    s.layout.rowHeight = () => 80;
    for (const fire of observers) fire();
    runFrames();
    expect(s.list().style.paddingTop).toBe("800px");
  });

  test("scroll anchoring keeps the first visible row in place when padding changes", () => {
    const s = setup();
    selfScroll(s);
    s.renderer.applyPatches([...rowPatches(0, 20), win(1000, 0, 20)]);
    const list = s.list() as any;
    list.scrollTop = 620; // row 12 is first visible, 20px cut off
    const anchor = s.renderer.getNode("r12") as unknown as FakeElement;
    const before = anchor.getBoundingClientRect().top;
    // The new rows are taller, so the average (and leading padding) moves.
    s.layout.rowHeight = (row) => (Number(row.dataset.hypenId!.slice(1)) >= 20 ? 150 : 50);
    s.renderer.applyPatches([
      ...Array.from({ length: 10 }, (_, i) => ({ type: "remove", id: `r${i}` }) as Patch),
      ...rowPatches(20, 30),
      win(1000, 10, 30),
    ]);
    expect(list.style.paddingTop).not.toBe("500px");
    expect(anchor.getBoundingClientRect().top).toBe(before);
    // Leading padding 0 → 1000px (average 100px); r12 sat 480px lower, so
    // the scroll offset moved with it.
    expect(list.scrollTop).toBe(1120);
  });
});

describe("virtualized List end to end (wasm engine + DOMRenderer)", () => {
  test("a 1,000-row List renders a window and follows the scroll", async () => {
    const engine = new Engine();
    await engine.init();
    const renderer = new DOMRenderer(document.createElement("div") as any, engine as any);
    let listId = "";
    engine.setRenderCallback((patches) => {
      const batch = typeof patches === "string" ? JSON.parse(patches) : patches;
      for (const p of batch as Patch[]) {
        if (p.type === "setProp" && (p as any).name === "__virt.window") listId = (p as any).id;
      }
      renderer.applyPatches(batch);
    });
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `row ${i}` }));
    engine.setModule("Test", [], ["items"], { items });

    const layout = new FakeLayout(() => (listId ? (renderer.getNode(listId) as unknown as FakeElement) : undefined));
    FakeElement.layoutHook = (el) => layout.rect(el);

    engine.renderSource(`List(@state.items, key: "id") { Text("@{item.name}") }`);
    expect(listId).not.toBe("");
    const list = renderer.getNode(listId) as unknown as FakeElement & Record<string, any>;
    list.clientHeight = 500;
    list.scrollHeight = 50_000;
    list.scrollTop = 0;
    layout.scroller = list;

    // initialCount defaults to 30.
    expect(list.children.length).toBe(30);
    expect(list.style.paddingTop).toBe("0px");
    expect(list.style.paddingBottom).toBe(`${970 * 50}px`);
    await tick();

    list.scrollTop = 10_000; // item 200 at the top
    list.dispatchEvent("scroll");
    runFrames();
    await tick();

    // visible [200,210) → wanted [190,220)
    expect(list.children.length).toBe(30);
    expect(list.children[0]!.textContent).toBe("row 190");
    expect(list.children[29]!.textContent).toBe("row 219");
    expect(list.children[0]!.attributes["aria-posinset"]).toBe("191");
    expect(list.style.paddingTop).toBe(`${190 * 50}px`);
    expect(list.style.paddingBottom).toBe(`${780 * 50}px`);
  });
});
