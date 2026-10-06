/**
 * DOM drag-and-drop runtime (`__dnd.*` channel consumption, plan §6).
 *
 * Drives the renderer with raw Patch arrays over fake-dom + StubEngine (the
 * dom.scrub.test.ts pattern): the `props` blocks mirror the byte-exact
 * Create wire pinned by `engine-compatibility-tests/fixtures/dnd/*.json`,
 * pointer events go through fake-dom's `dispatchEvent`, geometry through
 * the settable `getBoundingClientRect` hook, and the post-drop hold runs on
 * a short real timer via the runtime's public `cleanupTimeoutMs`.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { configureLogger, getLogLevel, setLogLevel } from "../packages/core/src/logger";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];

  rawDispatches: any[] = [];
  dispatchAction(name: string, payload: any): void {
    if (name === "__hypen_dispatch") { this.rawDispatches.push(payload); name = payload.action; payload = payload.payload; }

    this.dispatchCalls.push({ name, payload });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "root-1" } as Patch,
  ]);
  const dnd = renderer.getDnd();
  dnd.cleanupTimeoutMs = 30;
  return { container: container as unknown as FakeElement, engine, renderer, dnd };
};

type Rect = { left: number; top: number; width: number; height: number };

const setRect = (el: FakeElement, r: Rect) => {
  el.getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
  });
};

const styleOf = (el: FakeElement, prop: string): string | undefined =>
  (el.style as unknown as Record<string, string | undefined>)[prop];

/** Inline transform, "" when never written (fake-dom reports unset as undefined). */
const tf = (el: FakeElement): string => el.style.transform ?? "";

/** Inline style keys the runtime would have leaked (reserved / junk props). */
const junkStyleKeys = (el: FakeElement): string[] =>
  Object.keys(el.style).filter((k) => k.startsWith("__") || /dnd|anim|sort|pin|zone|source|state/i.test(k));

const SOURCE = (group: string | null = null, extra: Record<string, unknown> = {}) => ({
  group,
  handle: false,
  activation: "auto",
  ...extra,
});

/**
 * Mount a sortable list (`Column.sortable(...).bind(...)`) with `ForEach`
 * rows shaped like the sortable-lowering fixture: a plain Row wrapper whose
 * inner Text carries `__dnd.key` + `__dnd.source` (+ payload). Rows are
 * 100px tall, stacked from `top`.
 */
const mountList = (
  renderer: DOMRenderer,
  opts: {
    id: string;
    keys: string[];
    group?: string | null;
    axis?: "x" | "y";
    bind?: string | null;
    idProp?: string;
    listProps?: Record<string, unknown>;
    rowProps?: (key: string) => Record<string, unknown>;
    sourceProps?: (key: string) => Record<string, unknown>;
    left?: number;
    top?: number;
    parent?: string;
  }
) => {
  const {
    id,
    keys,
    group = null,
    axis = "y",
    bind = "tasks",
    idProp,
    listProps = {},
    rowProps = () => ({}),
    sourceProps = () => ({}),
    left = 0,
    top = 0,
    parent = "root-1",
  } = opts;
  const props: Record<string, unknown> = { "__dnd.sort": { group, axis }, ...listProps };
  if (bind !== null) props.bind = bind;
  if (idProp) props["id.0"] = idProp;
  const patches: Patch[] = [
    { type: "create", id, elementType: "Column", props } as Patch,
    { type: "insert", parentId: parent, id } as Patch,
  ];
  keys.forEach((key) => {
    patches.push(
      { type: "create", id: `${id}-row-${key}`, elementType: "Row", props: rowProps(key) } as Patch,
      { type: "insert", parentId: id, id: `${id}-row-${key}` } as Patch,
      {
        type: "create",
        id: `${id}-src-${key}`,
        elementType: "Text",
        props: {
          "0": key,
          "__dnd.key": key,
          "__dnd.source": SOURCE(group),
          "__dnd.sourcePayload": { id: key },
          ...sourceProps(key),
        },
      } as Patch,
      { type: "insert", parentId: `${id}-row-${key}`, id: `${id}-src-${key}` } as Patch
    );
  });
  renderer.applyPatches(patches);
  const list = renderer.getNode(id) as FakeElement;
  const size = keys.length * 100;
  setRect(list, {
    left,
    top,
    width: axis === "y" ? 200 : size,
    height: axis === "y" ? size : 100,
  });
  keys.forEach((key, i) => {
    const row = renderer.getNode(`${id}-row-${key}`) as FakeElement;
    const src = renderer.getNode(`${id}-src-${key}`) as FakeElement;
    const rect =
      axis === "y"
        ? { left, top: top + i * 100, width: 200, height: 100 }
        : { left: left + i * 100, top, width: 100, height: 100 };
    setRect(row, rect);
    setRect(src, rect);
  });
  return {
    list,
    row: (key: string) => renderer.getNode(`${id}-row-${key}`) as FakeElement,
    src: (key: string) => renderer.getNode(`${id}-src-${key}`) as FakeElement,
  };
};

const down = (el: FakeElement, x: number, y: number, extra: Record<string, unknown> = {}) =>
  el.dispatchEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, ...extra });
const move = (el: FakeElement, x: number, y: number) =>
  el.dispatchEvent("pointermove", { clientX: x, clientY: y, pointerId: 1 });
const up = (el: FakeElement, x: number, y: number) =>
  el.dispatchEvent("pointerup", { clientX: x, clientY: y, pointerId: 1 });

/** Capture logger WARN output at the default ("info") level. */
const captureWarns = (run: (warns: string[]) => void) => {
  const warns: string[] = [];
  const previousLevel = getLogLevel();
  setLogLevel("info");
  configureLogger({
    handler: {
      debug: () => {},
      info: () => {},
      warn: (_tag: string, ...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
      error: () => {},
    },
  });
  try {
    run(warns);
  } finally {
    configureLogger({ handler: undefined });
    setLogLevel(previousLevel);
  }
};

describe("sortable reorder (same list)", () => {
  test("drag t1 below t3: preview shifts, then reorder → onSort → onDragEnd, transforms held until the Move", async () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2", "t3"],
      idProp: "todo",
      listProps: { "onSort.0": "@reorder", "onDragEnd.0": "@dragEnded", "onDragStart.0": "@dragBegan" },
    });

    down(src("t1"), 100, 50);
    expect(engine.dispatchCalls).toEqual([]); // pending: nothing yet
    move(src("t1"), 100, 250); // travel 200 → claim, pointer over row t3's lower half
    // onDragStart is the only engine touch during the drag.
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1" },
      from: { zone: "todo", index: 0 },
      to: { zone: "todo", index: 0 },
    });
    // Ghost: the ROW (the sortable's direct child) moves, prepended translate.
    expect(row("t1").style.transform).toBe("translate(0px, 200px)");
    // Siblings open the gap: t2 and t3 shift up by the item size.
    expect(row("t2").style.transform).toBe("translateY(-100px)");
    expect(row("t3").style.transform).toBe("translateY(-100px)");
    expect(src("t1").attributes["aria-grabbed"]).toBe("true");
    move(src("t1"), 100, 260);
    expect(engine.dispatchCalls.length).toBe(1); // zero traffic per move

    up(src("t1"), 100, 260);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual([
      "dragBegan",
      "__hypen_reorder",
      "reorder",
      "dragEnded",
    ]);
    expect(engine.dispatchCalls[1]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
    expect(engine.dispatchCalls[2]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1" },
      from: { zone: "todo", index: 0 },
      to: { zone: "todo", index: 2 },
    });
    expect(engine.dispatchCalls[3]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1" },
      from: { zone: "todo", index: 0 },
      to: { zone: "todo", index: 2 },
      dropped: true,
    });

    // Held: nothing released yet (no flash before the engine re-renders).
    expect(row("t1").style.transform).toBe("translate(0px, 210px)");
    expect(row("t2").style.transform).toBe("translateY(-100px)");

    // The engine's Move for the dragged row lands: everything is released.
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(tf(row("t1"))).toBe("");
    expect(tf(row("t2"))).toBe("");
    expect(tf(row("t3"))).toBe("");
    expect(src("t1").attributes["aria-grabbed"]).toBe("false");
    // Nothing else was dispatched by the release.
    expect(engine.dispatchCalls.length).toBe(4);
  });

  test("hold falls back to the timeout when no Move arrives", async () => {
    const { renderer, dnd } = makeRenderer();
    dnd.cleanupTimeoutMs = 20;
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    down(src("t2"), 100, 150);
    move(src("t2"), 100, 20);
    up(src("t2"), 100, 20);
    expect(row("t2").style.transform).toBe("translate(0px, -130px)");
    await sleep(40);
    expect(tf(row("t2"))).toBe("");
    expect(tf(row("t1"))).toBe("");
  });

  test("dropping back on the origin slot writes nothing and only reports onDragEnd", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onSort.0": "@reorder", "onDragEnd.0": "@dragEnded" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 60);
    up(src("t1"), 100, 60);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload.dropped).toBe(true);
    // No engine write to wait for: released immediately.
    expect(tf(row("t1"))).toBe("");
  });

  test("an unbound sortable dispatches onSort only (escape hatch)", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      bind: null,
      listProps: { "onSort.0": "@taskMoved" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["taskMoved"]);
    expect(engine.dispatchCalls[0]!.payload.to).toEqual({ zone: "todo", index: 1 });
  });

  test("horizontal axis previews along x", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "strip", keys: ["a", "b", "c"], axis: "x" });
    down(src("c"), 250, 50);
    move(src("c"), 20, 50);
    expect(row("c").style.transform).toBe("translate(-230px, 0px)");
    expect(row("a").style.transform).toBe("translateX(100px)");
    expect(row("b").style.transform).toBe("translateX(100px)");
    up(src("c"), 20, 50);
    expect(engine.dispatchCalls[0]).toEqual({
      name: "__hypen_reorder",
      payload: { path: "tasks", from: 2, to: 0 },
    });
  });
});

describe("cross-list reorder (shared group)", () => {
  test("drop into a sibling list dispatches the two-path reorder and onSort on the destination", () => {
    const { renderer, engine } = makeRenderer();
    const a = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      group: "board",
      bind: "todo",
      listProps: { "onSort.0": "@persistBoard" },
    });
    const b = mountList(renderer, {
      id: "doing",
      keys: ["d1"],
      group: "board",
      bind: "doing",
      left: 300,
      listProps: { "onSort.0": "@persistBoard" },
    });

    down(a.src("t2"), 100, 150);
    move(a.src("t2"), 400, 90); // over doing, below d1's midpoint → append (index 1)
    // Foreign list opens no gap for an append; origin list closes its gap.
    expect(tf(a.row("t1"))).toBe("");
    expect(tf(b.row("d1"))).toBe("");
    move(a.src("t2"), 400, 20); // above d1's midpoint → index 0, d1 shifts down
    expect(b.row("d1").style.transform).toBe("translateY(100px)");
    up(a.src("t2"), 400, 20);

    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder", "persistBoard"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      fromPath: "todo",
      from: 1,
      toPath: "doing",
      to: 0,
    });
    expect(engine.dispatchCalls[1]!.payload).toEqual({
      item: "t2",
      payload: { id: "t2" },
      from: { zone: "board", index: 1 },
      to: { zone: "board", index: 0 },
    });

    // A Remove of the dragged row (the item left list A) releases the hold.
    renderer.applyPatches([{ type: "remove", id: "todo-row-t2" } as Patch]);
    expect(tf(b.row("d1"))).toBe("");
    expect(engine.dispatchCalls.length).toBe(2);
  });

  test("lists with different groups never accept each other's items", () => {
    const { renderer, engine } = makeRenderer();
    const a = mountList(renderer, { id: "todo", keys: ["t1"], group: "alpha", bind: "todo" });
    mountList(renderer, { id: "other", keys: ["o1"], group: "beta", bind: "other", left: 300 });
    down(a.src("t1"), 100, 50);
    move(a.src("t1"), 400, 50);
    up(a.src("t1"), 400, 50); // no target → cancel
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(a.row("t1"))).toBe("");
  });
});

describe("activation", () => {
  test("a tap is a total no-op", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onDragStart.0": "@dragBegan", "onDragEnd.0": "@dragEnded" },
    });
    const captured: number[] = [];
    (src("t1") as any).setPointerCapture = (id: number) => captured.push(id);
    down(src("t1"), 100, 50);
    up(src("t1"), 100, 50);
    expect(engine.dispatchCalls).toEqual([]);
    expect(captured).toEqual([]);
    expect(tf(row("t1"))).toBe("");
    expect(styleOf(row("t1"), "cursor")).toBeUndefined();
    expect(src("t1").attributes["aria-grabbed"]).toBe("false");
  });

  test("below-slop travel does not claim; crossing the slop claims and captures the pointer", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onDragStart.0": "@dragBegan" },
    });
    const captured: number[] = [];
    (src("t1") as any).setPointerCapture = (id: number) => captured.push(id);
    down(src("t1"), 100, 50);
    move(src("t1"), 103, 53);
    expect(tf(row("t1"))).toBe("");
    expect(engine.dispatchCalls).toEqual([]);
    expect(captured).toEqual([]);
    move(src("t1"), 100, 57);
    expect(captured).toEqual([1]);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    expect(row("t1").style.transform).toBe("translate(0px, 7px)");
  });

  test("touch in an axis-constrained sortable: main-axis travel scrolls (abandons), cross-axis lifts", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onDragStart.0": "@dragBegan" },
    });
    down(src("t1"), 100, 50, { pointerType: "touch" });
    move(src("t1"), 100, 70); // vertical = the list's scroll axis
    up(src("t1"), 100, 70);
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(row("t1"))).toBe("");

    down(src("t1"), 100, 50, { pointerType: "touch" });
    move(src("t1"), 110, 52); // horizontal = the cross axis
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    up(src("t1"), 110, 52);
  });

  test("press activation lifts after the delay and abandons on early travel", async () => {
    const { renderer, engine, dnd } = makeRenderer();
    dnd.pressDelayMs = 20;
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: () => ({ "__dnd.source": SOURCE(null, { activation: "press" }) }),
      listProps: { "onDragStart.0": "@dragBegan" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 80); // moved before the press fired → scroll
    await sleep(40);
    expect(engine.dispatchCalls).toEqual([]);
    up(src("t1"), 100, 80);

    down(src("t1"), 100, 50);
    await sleep(40);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    move(src("t1"), 100, 60);
    expect(row("t1").style.transform).toBe("translate(0px, 10px)");
    up(src("t1"), 100, 60);
  });

  test("immediate activation claims on pointerdown", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1"],
      sourceProps: () => ({ "__dnd.source": SOURCE(null, { activation: "immediate" }) }),
      listProps: { "onDragStart.0": "@dragBegan" },
    });
    down(src("t1"), 100, 50);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    up(src("t1"), 100, 50);
  });

  test("a disabled source (__dnd.sourceEnabled false) never lifts; re-enabling via SetProp arms it", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: (key) => (key === "t1" ? { "__dnd.sourceEnabled": false } : {}),
      listProps: { "onDragStart.0": "@dragBegan" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 150);
    up(src("t1"), 100, 150);
    expect(engine.dispatchCalls).toEqual([]);
    renderer.applyPatches([
      { type: "setProp", id: "todo-src-t1", name: "__dnd.sourceEnabled", value: true } as Patch,
    ]);
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 150);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    up(src("t1"), 100, 150);
  });

  test("a second pointer is noise", () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 150);
    src("t1").dispatchEvent("pointermove", { clientX: 100, clientY: 10, pointerId: 2 });
    expect(row("t1").style.transform).toBe("translate(0px, 100px)");
    src("t1").dispatchEvent("pointerup", { clientX: 100, clientY: 10, pointerId: 2 });
    expect(row("t1").style.transform).toBe("translate(0px, 100px)"); // still dragging
    up(src("t1"), 100, 150);
  });
});

/** A loose draggable Card (group "cards") under the root plus a trash zone. */
const mountCardAndZone = (
  renderer: DOMRenderer,
  zoneProps: Record<string, unknown> = {},
  cardProps: Record<string, unknown> = {}
) => {
  renderer.applyPatches([
    {
      type: "create",
      id: "card",
      elementType: "Card",
      props: { "__dnd.key": "task-17", "__dnd.source": SOURCE("cards"), ...cardProps },
    } as Patch,
    { type: "insert", parentId: "root-1", id: "card" } as Patch,
    {
      type: "create",
      id: "trash",
      elementType: "Column",
      props: {
        "__dnd.zone": { group: "cards", band: 0.5 },
        "__dnd.zoneId": "trash",
        "onDrop.0": "@deleteFile",
        ...zoneProps,
      },
    } as Patch,
    { type: "insert", parentId: "root-1", id: "trash" } as Patch,
  ]);
  const card = renderer.getNode("card") as FakeElement;
  const trash = renderer.getNode("trash") as FakeElement;
  setRect(card, { left: 0, top: 0, width: 100, height: 50 });
  setRect(trash, { left: 300, top: 0, width: 100, height: 100 });
  return { card, trash };
};

describe("drop zones", () => {
  test("dropping into a zone dispatches onDrop with to.index null, then onDragEnd", () => {
    const { renderer, engine } = makeRenderer();
    const { card } = mountCardAndZone(renderer, {}, { "onDragEnd.0": "@dragEnded" });
    down(card, 50, 25);
    move(card, 350, 50);
    up(card, 350, 50);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["deleteFile", "dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "task-17",
      from: { zone: "root-1", index: null },
      to: { zone: "trash", index: null },
    });
    expect(engine.dispatchCalls[1]!.payload.dropped).toBe(true);
    // No `payload` key when the source carries no __dnd.sourcePayload.
    expect("payload" in engine.dispatchCalls[0]!.payload).toBe(false);
  });

  test("the over pose is overlaid on hover and restored on leave/release", async () => {
    const { renderer } = makeRenderer();
    const { card, trash } = mountCardAndZone(renderer, {
      "backgroundColor.0": "#fff",
      "__anim.states": { label: null, runtime: true },
      "__anim.statePoses": { over: { "backgroundColor.0": "#eee" } },
    });
    expect(styleOf(trash, "background-color")).toBe("#fff");
    down(card, 50, 25);
    move(card, 350, 50);
    expect(styleOf(trash, "background-color")).toBe("#eee");
    move(card, 200, 200); // leave
    expect(styleOf(trash, "background-color")).toBe("#fff");
    move(card, 350, 50);
    expect(styleOf(trash, "background-color")).toBe("#eee");
    up(card, 350, 50);
    await sleep(50); // hold releases on timeout (no Remove arrives in this test)
    expect(styleOf(trash, "background-color")).toBe("#fff");
  });

  test("a disabled zone (__dnd.zoneEnabled false) is never a target", () => {
    const { renderer, engine } = makeRenderer();
    const { card } = mountCardAndZone(renderer, { "__dnd.zoneEnabled": false });
    down(card, 50, 25);
    move(card, 350, 50);
    up(card, 350, 50);
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("onDragOver fires once per zone entry after the dwell, with dwell stripped from the payload", async () => {
    const { renderer, engine } = makeRenderer();
    const { card } = mountCardAndZone(renderer, {
      "onDragOver.0": "@openFolder",
      "onDragOver.dwell": 20,
    });
    down(card, 50, 25);
    move(card, 350, 50);
    move(card, 200, 200); // leave before the dwell
    await sleep(30);
    expect(engine.dispatchCalls).toEqual([]);
    move(card, 350, 50);
    move(card, 360, 60); // moving inside the zone does not restart the dwell
    await sleep(30);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["openFolder"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "task-17",
      from: { zone: "root-1", index: null },
      to: { zone: "trash", index: null },
    });
    await sleep(30);
    expect(engine.dispatchCalls.length).toBe(1); // coalesced
    up(card, 360, 60);
  });

  test("a drop outside every zone cancels: onDragEnd {dropped: false} only, styles restored", () => {
    const { renderer, engine } = makeRenderer();
    const { card } = mountCardAndZone(renderer, {}, { "onDragEnd.0": "@dragEnded" });
    down(card, 50, 25);
    move(card, 200, 200);
    expect(card.style.transform).toBe("translate(150px, 175px)");
    up(card, 200, 200);
    expect(engine.dispatchCalls).toEqual([
      {
        name: "dragEnded",
        payload: {
          item: "task-17",
          from: { zone: "root-1", index: null },
          to: { zone: "root-1", index: null },
          dropped: false,
        },
      },
    ]);
    expect(tf(card)).toBe("");
  });

  test("pointercancel mid-drag cancels with onDragEnd {dropped: false}", () => {
    const { renderer, engine } = makeRenderer();
    const { card } = mountCardAndZone(renderer, {}, { "onDragEnd.0": "@dragEnded" });
    down(card, 50, 25);
    move(card, 350, 50);
    card.dispatchEvent("pointercancel", { pointerId: 1 });
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload.dropped).toBe(false);
    expect(engine.dispatchCalls[0]!.payload.to).toEqual({ zone: "trash", index: null });
    expect(tf(card)).toBe("");
  });
});

describe("zone on a sortable item (band arbitration)", () => {
  const mountFolders = (renderer: DOMRenderer) =>
    mountList(renderer, {
      id: "fs",
      keys: ["f1", "f2", "f3"],
      group: "fs",
      bind: "entries",
      listProps: { "onSort.0": "@sorted" },
      rowProps: (key) => ({
        "__dnd.zone": { group: "fs", band: 0.5 },
        "__dnd.zoneId": key,
        "onDrop.0": "@moveInto",
      }),
    });

  test("the middle band resolves 'into' the row's zone", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountFolders(renderer);
    down(src("f3"), 100, 250);
    move(src("f3"), 100, 50); // row f1 spans 0..100; band 0.5 → into between 25 and 75
    up(src("f3"), 100, 50);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["moveInto"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "f3",
      payload: { id: "f3" },
      from: { zone: "fs", index: 2 },
      to: { zone: "f1", index: null },
    });
  });

  test("the outer bands fall through to the sortable's before/after slots", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountFolders(renderer);
    down(src("f3"), 100, 250);
    move(src("f3"), 100, 10); // top band of f1 → before f1 → index 0
    expect(row("f1").style.transform).toBe("translateY(100px)");
    up(src("f3"), 100, 10);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder", "sorted"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ path: "entries", from: 2, to: 0 });

    // Bottom band of f1 → after f1 → index 1.
    const second = makeRenderer();
    const b = mountFolders(second.renderer);
    down(b.src("f3"), 100, 250);
    move(b.src("f3"), 100, 90);
    up(b.src("f3"), 100, 90);
    expect(second.engine.dispatchCalls[0]!.payload).toEqual({ path: "entries", from: 2, to: 1 });
  });

  test("a source is never a zone for itself", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountFolders(renderer);
    down(src("f2"), 100, 150);
    move(src("f2"), 100, 160); // over its own row's middle band
    up(src("f2"), 100, 160);
    // Resolved as the sortable slot it already occupies → no-op drop, no onDrop.
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual([]);
  });
});

/** A reserved-mode pinboard: `Stack.pinboard(group: "board")` with two Notes. */
const mountBoard = (
  renderer: DOMRenderer,
  pin: Record<string, unknown> = {},
  opts: { bind?: string; boardProps?: Record<string, unknown> } = {}
) => {
  const boardProps: Record<string, unknown> = {
    "__dnd.pin": { group: "board", xKey: "x", yKey: "y", grid: null, bounds: "clamp", units: "px", ...pin },
    "onPin.0": "@pinned",
    ...opts.boardProps,
  };
  if (opts.bind) boardProps.bind = opts.bind;
  const noteProps = (key: string, x: number | null, y: number | null): Record<string, unknown> => ({
    "0": key,
    "__dnd.key": key,
    "__dnd.source": SOURCE(null),
    ...(opts.bind ? {} : { "__dnd.pinGroup": "board" }),
    "translateX.0": x,
    "translateY.0": y,
  });
  renderer.applyPatches([
    { type: "create", id: "board", elementType: "Stack", props: boardProps } as Patch,
    { type: "insert", parentId: "root-1", id: "board" } as Patch,
    { type: "create", id: "n1", elementType: "Note", props: noteProps("n1", 40, 60) } as Patch,
    { type: "insert", parentId: "board", id: "n1" } as Patch,
    { type: "create", id: "n2", elementType: "Note", props: noteProps("n2", null, null) } as Patch,
    { type: "insert", parentId: "board", id: "n2" } as Patch,
  ]);
  const board = renderer.getNode("board") as FakeElement;
  const n1 = renderer.getNode("n1") as FakeElement;
  const n2 = renderer.getNode("n2") as FakeElement;
  setRect(board, { left: 0, top: 0, width: 400, height: 300 });
  setRect(n1, { left: 40, top: 60, width: 100, height: 50 });
  setRect(n2, { left: 0, top: 0, width: 100, height: 50 });
  return { board, n1, n2 };
};

describe("pinboard", () => {
  test("null translate injection renders as 0 (never an invalid translateX())", () => {
    const { renderer } = makeRenderer();
    const { n1, n2 } = mountBoard(renderer);
    expect(n1.style.transform).toBe("translateX(40px) translateY(60px)");
    expect(n2.style.transform).toBe("translateX(0px) translateY(0px)");
  });

  test("reserved mode: __hypen_pin on __dnd.<group>.<key>, then onPin, then onDragEnd; hold until the translate SetProps", () => {
    const { renderer, engine } = makeRenderer();
    const { n1 } = mountBoard(renderer, {}, { boardProps: { "onDragEnd.0": "@dragEnded" } });
    down(n1, 90, 85);
    move(n1, 190, 135); // +100, +50
    expect(n1.style.transform).toBe("translate(100px, 50px) translateX(40px) translateY(60px)");
    up(n1, 190, 135);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_pin", "pinned", "dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      path: "__dnd.board.n1",
      x: 140,
      y: 110,
      xKey: "x",
      yKey: "y",
    });
    expect(engine.dispatchCalls[1]!.payload).toEqual({
      item: "n1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 0 },
      x: 140,
      y: 110,
    });
    expect(engine.dispatchCalls[2]!.payload).toEqual({
      item: "n1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 0 },
      dropped: true,
    });
    // Held at the drop position…
    expect(n1.style.transform).toBe("translate(100px, 50px) translateX(40px) translateY(60px)");
    // …until the engine's re-resolved translates land (deferred → release → applied).
    renderer.applyPatches([
      { type: "setProp", id: "n1", name: "translateX.0", value: 140 } as Patch,
      { type: "setProp", id: "n1", name: "translateY.0", value: 110 } as Patch,
    ]);
    expect(n1.style.transform).toBe("translateX(140px) translateY(110px)");
    expect(engine.dispatchCalls.length).toBe(3);
  });

  test("engine translate writes to the dragged node are deferred mid-drag and applied at release", () => {
    const { renderer, engine } = makeRenderer();
    const { n1 } = mountBoard(renderer);
    down(n1, 90, 85);
    move(n1, 100, 95);
    renderer.applyPatches([{ type: "setProp", id: "n1", name: "translateX.0", value: 999 } as Patch]);
    expect(n1.style.transform).toBe("translate(10px, 10px) translateX(40px) translateY(60px)");
    n1.dispatchEvent("pointercancel", { pointerId: 1 });
    expect(n1.style.transform).toBe("translateX(999px) translateY(60px)");
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("user-field mode: path is <bind>.<index>", () => {
    const { renderer, engine } = makeRenderer();
    const { n2 } = mountBoard(renderer, { group: null, grid: 8 }, { bind: "seats" });
    down(n2, 50, 25);
    move(n2, 153, 74); // +103, +49 → raw (103, 49) → grid 8 → (104, 48)
    up(n2, 153, 74);
    expect(engine.dispatchCalls[0]).toEqual({
      name: "__hypen_pin",
      payload: { path: "seats.1", x: 104, y: 48, xKey: "x", yKey: "y" },
    });
    // The ghost snaps to the resolved position during the hold.
    expect(n2.style.transform).toBe("translate(104px, 48px) translateX(0px) translateY(0px)");
  });

  test("clamp keeps the item inside the content box; free does not", () => {
    const { renderer, engine } = makeRenderer();
    const { n1 } = mountBoard(renderer);
    down(n1, 90, 85);
    move(n1, 399, 299); // +309, +214 → raw (349, 274) → clamp to (300, 250) for a 100×50 item
    up(n1, 399, 299);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      path: "__dnd.board.n1",
      x: 300,
      y: 250,
      xKey: "x",
      yKey: "y",
    });

    const free = makeRenderer();
    const b = mountBoard(free.renderer, { bounds: "free" });
    down(b.n1, 90, 85);
    move(b.n1, 399, 299);
    up(b.n1, 399, 299);
    expect(free.engine.dispatchCalls[0]!.payload.x).toBe(349);
    expect(free.engine.dispatchCalls[0]!.payload.y).toBe(274);
  });

  test("units: fraction divides by the content size", () => {
    const { renderer, engine } = makeRenderer();
    const { n1 } = mountBoard(renderer, { units: "fraction" });
    down(n1, 90, 85);
    move(n1, 190, 135); // → px (140, 110) of 400×300
    up(n1, 190, 135);
    expect(engine.dispatchCalls[0]!.payload.x).toBe(0.35);
    expect(engine.dispatchCalls[0]!.payload.y).toBeCloseTo(0.3667, 3);
  });

  test("custom xKey/yKey travel on the __hypen_pin payload", () => {
    const { renderer, engine } = makeRenderer();
    const { n1 } = mountBoard(renderer, { xKey: "left", yKey: "top" });
    down(n1, 90, 85);
    move(n1, 100, 95);
    up(n1, 100, 95);
    expect(engine.dispatchCalls[0]!.payload.xKey).toBe("left");
    expect(engine.dispatchCalls[0]!.payload.yKey).toBe("top");
  });
});

describe("cancel on Remove / Detach", () => {
  test("a Remove of the dragged row mid-drag dispatches nothing and restores siblings", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onDragEnd.0": "@dragEnded", "onSort.0": "@reorder" },
    });
    const released: number[] = [];
    const source = src("t1");
    (source as any).releasePointerCapture = (id: number) => released.push(id);
    down(source, 100, 50);
    move(source, 100, 170);
    expect(row("t2").style.transform).toBe("translateY(-100px)");
    renderer.applyPatches([{ type: "remove", id: "todo-row-t1" } as Patch]);
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(row("t2"))).toBe("");
    expect(released).toEqual([1]);
    // The pointer that keeps moving/releasing on the dead element is ignored.
    move(source, 100, 200);
    up(source, 100, 200);
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("a Detach of an ancestor mid-drag cancels silently", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "route", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "route" } as Patch,
    ]);
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      parent: "route",
      listProps: { "onDragEnd.0": "@dragEnded" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(row("t1"))).toBe("");
    expect(tf(row("t2"))).toBe("");
    expect(src("t1").attributes["aria-grabbed"]).toBe("false");
    // Re-attached: the source is live again.
    renderer.applyPatches([{ type: "attach", parentId: "root-1", id: "route" } as Patch]);
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    expect(row("t1").style.transform).toBe("translate(0px, 120px)");
    up(src("t1"), 100, 170);
  });
});

describe("CSS save/restore (§6.7) and precedence", () => {
  test("lift sets touch-action/user-select/cursor/will-change and restores prior inline values", async () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    row("t1").style.setProperty("cursor", "pointer");
    row("t1").style.setProperty("z-index", "3");
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    expect(styleOf(row("t1"), "touch-action")).toBe("none");
    expect(styleOf(row("t1"), "user-select")).toBe("none");
    expect(styleOf(row("t1"), "cursor")).toBe("grabbing");
    expect(styleOf(row("t1"), "will-change")).toBe("transform");
    expect(styleOf(row("t1"), "z-index")).toBe("1000");
    up(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(styleOf(row("t1"), "cursor")).toBe("pointer");
    expect(styleOf(row("t1"), "z-index")).toBe("3");
    expect(styleOf(row("t1"), "touch-action")).toBeUndefined();
    expect(styleOf(row("t1"), "user-select")).toBeUndefined();
    expect(styleOf(row("t1"), "will-change")).toBeUndefined();
  });

  test("sibling shift transitions are restored", () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    row("t2").style.setProperty("transition", "opacity 1s");
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    expect(styleOf(row("t2"), "transition")).toBe("transform 150ms ease-out");
    up(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(styleOf(row("t2"), "transition")).toBe("opacity 1s");
  });

  test("a static rotate applicator survives the ghost transform", () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      rowProps: () => ({ "rotate.0": "3deg" }),
    });
    expect(row("t1").style.transform).toBe("rotate(3deg)");
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    expect(row("t1").style.transform).toBe("translate(0px, 120px) rotate(3deg)");
    up(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(row("t1").style.transform).toBe("rotate(3deg)");
  });

  test("dnd owns the dragged node and shifted siblings for the animator (dnd > scrub)", () => {
    const { renderer, dnd } = makeRenderer();
    const { src } = mountList(renderer, { id: "todo", keys: ["t1", "t2", "t3"] });
    expect(dnd.ownsNode("todo-row-t1")).toBe(false);
    down(src("t1"), 100, 50);
    expect(dnd.ownsNode("todo-row-t1")).toBe(false); // pending owns nothing
    expect(dnd.isInteracting("todo-src-t1")).toBe(true); // …but suspends a scrub
    move(src("t1"), 100, 170);
    expect(dnd.ownsNode("todo-row-t1")).toBe(true);
    expect(dnd.ownsNode("todo-src-t1")).toBe(true);
    expect(dnd.ownsNode("todo-row-t2")).toBe(true); // shifted
    expect(dnd.ownsNode("todo-row-t3")).toBe(false); // untouched
    up(src("t1"), 100, 170);
    expect(dnd.ownsNode("todo-row-t1")).toBe(true); // holding
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(dnd.ownsNode("todo-row-t1")).toBe(false);
  });
});

describe("header-less .states poses (§2.1)", () => {
  test("the lifted pose overlays the source while dragging and the base is restored on release", () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: () => ({
        "opacity.0": 1,
        "__anim.states": { label: null, runtime: true },
        "__anim.statePoses": {
          lifted: { "opacity.0": 0.6, "scale.0": 1.04 },
          over: { "backgroundColor.0": "#eee" },
        },
        "__anim.transition": { curve: "easeOut", duration: 250, props: ["opacity", "scale", "backgroundColor"] },
      }),
    });
    expect(styleOf(src("t1"), "opacity")).toBe("1");
    expect(tf(src("t1"))).toBe("");
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    expect(styleOf(src("t1"), "opacity")).toBe("0.6");
    expect(src("t1").style.transform).toBe("scale(1.04)");
    expect(styleOf(src("t1"), "background-color")).toBeUndefined(); // two labels never apply at once
    up(src("t1"), 100, 170);
    // Held through the drop…
    expect(styleOf(src("t1"), "opacity")).toBe("0.6");
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(styleOf(src("t1"), "opacity")).toBe("1");
    expect(tf(src("t1"))).toBe("");
    expect(tf(row("t1"))).toBe("");
  });

  test("when the source is the ghost, the pose transform survives the drag translate", () => {
    const { renderer } = makeRenderer();
    const { card } = mountCardAndZone(
      renderer,
      {},
      {
        "__anim.states": { label: null, runtime: true },
        "__anim.statePoses": { lifted: { "scale.0": 1.04 } },
      }
    );
    down(card, 50, 25);
    move(card, 60, 35);
    expect(card.style.transform).toBe("translate(10px, 10px) scale(1.04)");
    card.dispatchEvent("pointercancel", { pointerId: 1 });
    expect(tf(card)).toBe("");
  });

  test("an engine write to a pose-overridden prop is deferred until the label clears", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: () => ({
        "opacity.0": 1,
        "__anim.statePoses": { lifted: { "opacity.0": 0.6 } },
      }),
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "setProp", id: "todo-src-t1", name: "opacity.0", value: 0.3 } as Patch]);
    expect(styleOf(src("t1"), "opacity")).toBe("0.6");
    src("t1").dispatchEvent("pointercancel", { pointerId: 1 });
    expect(styleOf(src("t1"), "opacity")).toBe("0.3");
  });

  test("statePoses is ignored by the applicators (no junk CSS) and tolerated when malformed", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: () => ({ "__anim.statePoses": "nonsense" }),
    });
    expect(junkStyleKeys(src("t1"))).toEqual([]);
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
  });
});

describe("prop routing and degradation", () => {
  test("__dnd.* props never reach the applicators' CSS fallback", () => {
    const { renderer } = makeRenderer();
    const { list, src } = mountList(renderer, { id: "todo", keys: ["t1"] });
    expect(junkStyleKeys(list)).toEqual([]);
    expect(junkStyleKeys(src("t1"))).toEqual([]);
  });

  test("the bind applicator returns early on a sortable/pinboard (no unsupported-type warning)", () => {
    captureWarns((warns) => {
      const { renderer } = makeRenderer();
      mountList(renderer, { id: "todo", keys: ["t1"] });
      renderer.applyPatches([
        {
          type: "create",
          id: "board",
          elementType: "Stack",
          props: {
            "__dnd.pin": { group: null, xKey: "x", yKey: "y", grid: 8, bounds: "clamp", units: "px" },
            bind: "seats",
          },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "board" } as Patch,
      ]);
      expect(warns.filter((w) => w.includes(".bind() is not supported"))).toEqual([]);
      expect(warns).toEqual([]);
    });
  });

  test("malformed __dnd.source warns and degrades to static UI", () => {
    captureWarns((warns) => {
      const { renderer, engine } = makeRenderer();
      renderer.applyPatches([
        { type: "create", id: "bad", elementType: "Card", props: { "__dnd.source": 42 } } as Patch,
        { type: "insert", parentId: "root-1", id: "bad" } as Patch,
      ]);
      const bad = renderer.getNode("bad") as FakeElement;
      expect(warns.some((w) => w.includes("malformed __dnd.source"))).toBe(true);
      down(bad, 0, 0);
      move(bad, 100, 100);
      up(bad, 100, 100);
      expect(engine.dispatchCalls).toEqual([]);
      expect(tf(bad)).toBe("");
    });
  });

  test("__dnd.key falls back to the node id outside a ForEach", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "lone", elementType: "Card", props: { "__dnd.source": SOURCE("cards") } } as Patch,
      { type: "insert", parentId: "root-1", id: "lone" } as Patch,
      {
        type: "create",
        id: "zone",
        elementType: "Column",
        props: { "__dnd.zone": { group: "cards", band: 0.5 }, "onDrop.0": "@dropped" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "zone" } as Patch,
    ]);
    const lone = renderer.getNode("lone") as FakeElement;
    const zone = renderer.getNode("zone") as FakeElement;
    setRect(lone, { left: 0, top: 0, width: 50, height: 50 });
    setRect(zone, { left: 200, top: 0, width: 100, height: 100 });
    down(lone, 10, 10);
    move(lone, 250, 50);
    up(lone, 250, 50);
    expect(engine.dispatchCalls[0]!.payload.item).toBe("lone");
    // zoneId absent → node id.
    expect(engine.dispatchCalls[0]!.payload.to).toEqual({ zone: "zone", index: null });
  });

  test("extra named args on an event applicator merge under the §4.2 payload; animate stamps the dispatch", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      listProps: { "onSort.0": "@reorder", "onSort.list": "primary", "onSort.animate": "spring" },
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
    const sort = engine.dispatchCalls.find((c) => c.name === "reorder")!;
    expect(sort.payload.list).toBe("primary");
    expect(sort.payload.item).toBe("t1");
    expect(sort.payload.__hypenAnimate).toBe("spring");
  });
});

describe("transform applicator re-resolution", () => {
  test("a repeated translateX SetProp replaces its term in place instead of accumulating", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "t",
        elementType: "Column",
        props: { "translateX.0": 10, "rotate.0": "5deg", "translateY.0": 20 },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "t" } as Patch,
    ]);
    const el = renderer.getNode("t") as FakeElement;
    expect(el.style.transform).toBe("translateX(10px) rotate(5deg) translateY(20px)");
    renderer.applyPatches([
      { type: "setProp", id: "t", name: "translateX.0", value: 30 } as Patch,
      { type: "setProp", id: "t", name: "translateX.0", value: 40 } as Patch,
      { type: "setProp", id: "t", name: "translateY.0", value: null } as Patch,
    ]);
    expect(el.style.transform).toBe("translateX(40px) rotate(5deg) translateY(0px)");
  });
});

describe("pre-claim abandonment (§6.11)", () => {
  test("a pointer leaving the source before the slop abandons the pending drag; the runtime is not wedged", () => {
    const { renderer, engine, dnd } = makeRenderer();
    const { src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"], listProps: { "onDragStart.0": "@began" } });
    down(src("t1"), 100, 50);
    expect(dnd.isInteracting("todo-src-t1")).toBe(true);
    // Mouse leaves the element below the slop: no capture yet, so its `up`
    // would land elsewhere and never reach the source.
    src("t1").dispatchEvent("pointerleave", { clientX: 210, clientY: 50, pointerId: 1 });
    expect(dnd.isInteracting("todo-src-t1")).toBe(false);
    src("t2").dispatchEvent("pointerup", { clientX: 210, clientY: 50, pointerId: 1 });
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(src("t1"))).toBe("");
    // A brand-new drag on another source lifts normally.
    down(src("t2"), 100, 150);
    move(src("t2"), 100, 250);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["began"]);
    up(src("t2"), 100, 250);
  });

  test("lostpointercapture before the claim abandons too; after the claim neither event ends the drag", () => {
    const { renderer, engine, dnd } = makeRenderer();
    const { src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"], listProps: { "onDragEnd.0": "@ended" } });
    down(src("t1"), 100, 50);
    src("t1").dispatchEvent("lostpointercapture", { pointerId: 1 });
    expect(dnd.isInteracting("todo-src-t1")).toBe(false);
    expect(engine.dispatchCalls).toEqual([]);
    // Claimed drag: the source holds capture, so a stray leave is noise.
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    src("t1").dispatchEvent("pointerleave", { clientX: 500, clientY: 500, pointerId: 1 });
    expect(dnd.isInteracting("todo-src-t1")).toBe(true);
    expect(tf(src("t1"))).toBe("");
    expect(tf(renderer.getNode("todo-row-t1") as FakeElement)).toBe("translate(0px, 120px)");
    src("t1").dispatchEvent("pointercancel", { pointerId: 1 });
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["ended"]);
  });
});

describe("foreign pinboard as an 'into' target (§6.11)", () => {
  test("to.zone follows the sortable rule (group → id → node id), not the dropZone id", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, { id: "todo", keys: ["t1"], group: "board", bind: "todo" });
    renderer.applyPatches([
      {
        type: "create",
        id: "pb",
        elementType: "Stack",
        props: {
          "__dnd.pin": { group: "board", xKey: "x", yKey: "y", grid: null, bounds: "clamp", units: "px" },
          "id.0": "myBoard",
          "onDrop.0": "@dropped",
          "onPin.0": "@pinned",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "pb" } as Patch,
    ]);
    setRect(renderer.getNode("pb") as FakeElement, { left: 300, top: 0, width: 400, height: 300 });
    down(src("t1"), 100, 50);
    move(src("t1"), 400, 50);
    up(src("t1"), 400, 50);
    // A plain "into" drop: onDrop, never a pin write.
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dropped"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1" },
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: null },
    });
  });
});

describe("mid-drag re-renders of the ORIGIN list (§6.3)", () => {
  test("a Remove after the dragged item rebuilds the slots: the write's `to` is the live index", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2", "t3"] });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 250); // below t3 → t2, t3 shifted up
    expect(tf(row("t2"))).toBe("translateY(-100px)");
    expect(tf(row("t3"))).toBe("translateY(-100px)");
    // The engine drops t2. t3's ON-SCREEN rect is what a browser reports:
    // its new layout top (100) plus its live shift (-100).
    setRect(row("t3"), { left: 0, top: 0, width: 200, height: 100 });
    renderer.applyPatches([{ type: "remove", id: "todo-row-t2" } as Patch]);
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(row("t3"))).toBe("translateY(-100px)"); // re-resolved at the last pointer position
    up(src("t1"), 100, 250);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ path: "tasks", from: 0, to: 1 });
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(tf(row("t1"))).toBe("");
    expect(tf(row("t3"))).toBe("");
  });

  test("a Remove before the dragged item updates the write's `from`; dropping on the live slot is a no-op", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2", "t3"], listProps: { "onDragEnd.0": "@ended" } });
    down(src("t2"), 100, 150);
    move(src("t2"), 100, 160);
    renderer.applyPatches([{ type: "remove", id: "todo-row-t1" } as Patch]);
    setRect(row("t3"), { left: 0, top: 100, width: 200, height: 100 });
    move(src("t2"), 100, 260); // below t3 → live index 1
    expect(tf(row("t3"))).toBe("translateY(-100px)");
    up(src("t2"), 100, 260);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder", "ended"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ path: "tasks", from: 0, to: 1 });
    // The event payload keeps the lift location.
    expect(engine.dispatchCalls[1]!.payload.from).toEqual({ zone: "todo", index: 1 });
    // The engine's Move for "lands last" carries no anchor: t2 goes to the end.
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t2" } as Patch]);

    // Same shape, but dropping back where the item now lives writes nothing.
    engine.dispatchCalls.length = 0;
    setRect(row("t3"), { left: 0, top: 0, width: 200, height: 100 });
    setRect(row("t2"), { left: 0, top: 100, width: 200, height: 100 });
    renderer.applyPatches([
      { type: "create", id: "todo-row-t0", elementType: "Row", props: {} } as Patch,
      { type: "insert", parentId: "todo", id: "todo-row-t0", beforeId: "todo-row-t3" } as Patch,
      {
        type: "create",
        id: "todo-src-t0",
        elementType: "Text",
        props: { "0": "t0", "__dnd.key": "t0", "__dnd.source": SOURCE(null) },
      } as Patch,
      { type: "insert", parentId: "todo-row-t0", id: "todo-src-t0" } as Patch,
    ]);
    down(src("t2"), 100, 150);
    move(src("t2"), 100, 160);
    renderer.applyPatches([{ type: "remove", id: "todo-row-t0" } as Patch]);
    move(src("t2"), 100, 170); // below t3's midpoint → live index 1 = where it now is
    up(src("t2"), 100, 170);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["ended"]);
    expect(tf(row("t2"))).toBe("");
    expect(tf(row("t3"))).toBe("");
  });

  test("an Insert under the origin mid-drag becomes a live slot", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 60);
    renderer.applyPatches([
      { type: "create", id: "todo-row-t3", elementType: "Row", props: {} } as Patch,
      { type: "insert", parentId: "todo", id: "todo-row-t3" } as Patch,
      {
        type: "create",
        id: "todo-src-t3",
        elementType: "Text",
        props: { "0": "t3", "__dnd.key": "t3", "__dnd.source": SOURCE(null) },
      } as Patch,
      { type: "insert", parentId: "todo-row-t3", id: "todo-src-t3" } as Patch,
    ]);
    // The row was inserted top-down (before its draggable child), so the
    // child's own insert is what makes t3 a slot. Layout after the insert:
    setRect(renderer.getNode("todo") as FakeElement, { left: 0, top: 0, width: 200, height: 300 });
    setRect(row("t3"), { left: 0, top: 200, width: 200, height: 100 });
    move(src("t1"), 100, 250);
    expect(tf(row("t2"))).toBe("translateY(-100px)");
    expect(tf(row("t3"))).toBe("translateY(-100px)");
    up(src("t1"), 100, 250);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
  });
});

describe("deferral of every transform kind on the lifted node (§6.6)", () => {
  test("engine rotate/scale/transform SetProps on the dragged item or source survive a cancel", () => {
    const { renderer, engine } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    renderer.applyPatches([
      { type: "setProp", id: "todo-row-t1", name: "rotate.0", value: "5deg" } as Patch,
      { type: "setProp", id: "todo-src-t1", name: "scale.0", value: 1.1 } as Patch,
    ]);
    // Deferred: the ghost keeps its lane.
    expect(tf(row("t1"))).toBe("translate(0px, 120px)");
    expect(tf(src("t1"))).toBe("");
    src("t1").dispatchEvent("pointercancel", { pointerId: 1 });
    expect(tf(row("t1"))).toBe("rotate(5deg)");
    expect(tf(src("t1"))).toBe("scale(1.1)");
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("a raw transform SetProp during the drop hold lands at release (only translateX/Y release the hold)", async () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
    renderer.applyPatches([{ type: "setProp", id: "todo-row-t1", name: "transform.0", value: "skewX(3deg)" } as Patch]);
    expect(tf(row("t1"))).toBe("translate(0px, 120px)"); // still holding
    await sleep(60);
    expect(tf(row("t1"))).toBe("skewX(3deg)");
  });

  test("a RemoveProp of a translate key on the lifted node is deferred until release", () => {
    const { renderer } = makeRenderer();
    const { n1 } = mountBoard(renderer);
    down(n1, 90, 85);
    move(n1, 100, 95);
    renderer.applyPatches([{ type: "removeProp", id: "n1", name: "translateX.0" } as Patch]);
    expect(n1.style.transform).toBe("translate(10px, 10px) translateX(40px) translateY(60px)");
    n1.dispatchEvent("pointercancel", { pointerId: 1 });
    expect(n1.style.transform).toBe("translateY(60px)");
  });

  test("a RemoveProp of a pose-overridden key is deferred until the label clears", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: () => ({
        "opacity.0": 1,
        "__anim.statePoses": { lifted: { "opacity.0": 0.6 } },
      }),
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    renderer.applyPatches([
      { type: "removeProp", id: "todo-src-t1", name: "opacity.0" } as Patch,
      { type: "removeProp", id: "todo-src-t2", name: "opacity.0" } as Patch, // idle control
    ]);
    expect(styleOf(src("t1"), "opacity")).toBe("0.6");
    src("t1").dispatchEvent("pointercancel", { pointerId: 1 });
    // The deferred removal lands exactly as the idle one did.
    expect(styleOf(src("t1"), "opacity")).toBe(styleOf(src("t2"), "opacity"));
    expect(styleOf(src("t1"), "opacity")).not.toBe("0.6");
    expect(styleOf(src("t1"), "opacity")).not.toBe("1");
  });
});

describe("touch-action is written at ARM time (before any touch starts)", () => {
  test("auto inside an axis-constrained sortable allows the main-axis pan; press/slop/immediate and loose sources get none", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2", "t3"],
      sourceProps: (key) =>
        key === "t2"
          ? { "__dnd.source": SOURCE(null, { activation: "press" }) }
          : key === "t3"
            ? { "__dnd.source": SOURCE(null, { activation: "slop" }) }
            : {},
    });
    // Written when the row landed under its sortable, long before a touch.
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-y");
    expect(styleOf(src("t2"), "touch-action")).toBe("none");
    expect(styleOf(src("t3"), "touch-action")).toBe("none");

    const { src: hsrc } = mountList(renderer, { id: "lanes", keys: ["l1"], axis: "x", bind: "lanes" });
    expect(styleOf(hsrc("l1"), "touch-action")).toBe("pan-x");

    // A loose draggable / pinboard note under `auto` is a 300ms press on
    // touch: the UA must not start a pan.
    const { n1 } = mountBoard(renderer);
    expect(styleOf(n1, "touch-action")).toBe("none");
  });

  test("a container axis change re-resolves it; disarming restores the prior inline value", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, { id: "todo", keys: ["t1"] });
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-y");
    renderer.applyPatches([
      { type: "setProp", id: "todo", name: "__dnd.sort", value: { group: null, axis: "x" } } as Patch,
    ]);
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-x");
    // Disarmed (disabled): the runtime's value is gone. An inline value the
    // author sets while disarmed is saved on re-arm and restored on disarm.
    renderer.applyPatches([{ type: "setProp", id: "todo-src-t1", name: "__dnd.sourceEnabled", value: false } as Patch]);
    expect(styleOf(src("t1"), "touch-action")).toBeUndefined();
    src("t1").style.setProperty("touch-action", "manipulation");
    renderer.applyPatches([{ type: "setProp", id: "todo-src-t1", name: "__dnd.sourceEnabled", value: true } as Patch]);
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-x");
    renderer.applyPatches([{ type: "removeProp", id: "todo-src-t1", name: "__dnd.source" } as Patch]);
    expect(styleOf(src("t1"), "touch-action")).toBe("manipulation");
  });

  test("a lift still hardens the moving item to none and the release restores it", () => {
    const { renderer } = makeRenderer();
    const { row, src } = mountList(renderer, { id: "todo", keys: ["t1", "t2"] });
    expect(styleOf(row("t1"), "touch-action")).toBeUndefined(); // the row is not the source
    down(src("t1"), 100, 50, { pointerType: "touch" });
    move(src("t1"), 110, 50, { pointerType: "touch" }); // cross-axis claim
    expect(styleOf(row("t1"), "touch-action")).toBe("none");
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-y");
    up(src("t1"), 110, 50);
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "todo-row-t1" } as Patch]);
    expect(styleOf(row("t1"), "touch-action")).toBeUndefined();
    expect(styleOf(src("t1"), "touch-action")).toBe("pan-y");
  });

  test("contextmenu is suppressed only while a press timer or a drag is live", async () => {
    const { renderer, dnd } = makeRenderer();
    dnd.pressDelayMs = 20;
    const { n1 } = mountBoard(renderer);
    const menu = () => {
      let prevented = false;
      n1.dispatchEvent("contextmenu", { preventDefault: () => (prevented = true) });
      return prevented;
    };
    expect(menu()).toBe(false);
    down(n1, 90, 85, { pointerType: "touch" });
    expect(menu()).toBe(true); // press timer live
    await sleep(40);
    expect(menu()).toBe(true); // dragging
    up(n1, 90, 85);
    await sleep(60);
    expect(menu()).toBe(false);
  });
});

describe("the click that trails a drop is swallowed", () => {
  test("after a claimed drag the source's .onClick does not fire; a tap keeps its click", () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: (key) => ({ "onClick.0": "@openCard", "onClick.id": key }),
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder"]);
    let prevented = false;
    src("t1").dispatchEvent("click", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder"]);
    // Only the ONE trailing click is eaten.
    src("t1").dispatchEvent("click", {});
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder", "openCard"]);

    engine.dispatchCalls.length = 0;
    down(src("t2"), 100, 150);
    up(src("t2"), 102, 151); // below-slop tap: a total no-op
    src("t2").dispatchEvent("click", {});
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["openCard"]);
  });

  test("the guard lapses on its own when no click follows", async () => {
    const { renderer, engine } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: (key) => ({ "onClick.0": "@openCard", "onClick.id": key }),
    });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 170);
    up(src("t1"), 100, 170);
    await sleep(5);
    src("t1").dispatchEvent("click", {});
    expect(engine.dispatchCalls.map((c) => c.name)).toContain("openCard");
  });
});

describe("pinboard on a board that scrolls its own content", () => {
  test("(x, y) are content-space: the board's scroll offset is added back and the clamp uses the scroll size", () => {
    const { renderer, engine } = makeRenderer();
    const { board, n1 } = mountBoard(renderer);
    // A 400×300 scrollport over 400×900 of content, scrolled down 300px.
    // n1 (translateY 500 in content space) is drawn at box.top + 200.
    renderer.applyPatches([{ type: "setProp", id: "n1", name: "translateY.0", value: 500 } as Patch]);
    (board as unknown as { scrollTop: number; scrollHeight: number; scrollWidth: number }).scrollTop = 300;
    (board as unknown as { scrollHeight: number }).scrollHeight = 900;
    (board as unknown as { scrollWidth: number }).scrollWidth = 400;
    setRect(n1, { left: 40, top: 200, width: 100, height: 50 });
    down(n1, 90, 225);
    move(n1, 90, 235); // +10 down
    up(n1, 90, 235);
    expect(engine.dispatchCalls[0]).toEqual({
      name: "__hypen_pin",
      payload: { path: "__dnd.board.n1", x: 40, y: 510, xKey: "x", yKey: "y" },
    });
    // The held ghost stays where the user left it (the visible +10), not
    // at the content-space number.
    expect(n1.style.transform).toBe("translate(0px, 10px) translateX(40px) translateY(500px)");

    // The clamp bounds are the scrollable content (900 tall), not the
    // 300px scrollport: a note released at content y=590 (visible y=290,
    // inside the board) is NOT pulled up to 250 (= 300 - 50).
    engine.dispatchCalls.length = 0;
    renderer.applyPatches([{ type: "setProp", id: "n1", name: "translateY.0", value: 510 } as Patch]);
    setRect(n1, { left: 40, top: 210, width: 100, height: 50 });
    down(n1, 90, 215);
    move(n1, 90, 295); // +80 → visible top 290 (pointer still inside the board), content top 590
    up(n1, 90, 295);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      path: "__dnd.board.n1",
      x: 40,
      y: 590,
      xKey: "x",
      yKey: "y",
    });
  });
});

describe("a disabled draggable is not a dead tab stop", () => {
  test("sourceEnabled=false removes the runtime tabindex and aria-grabbed; re-enabling restores them; removing the source drops the tabindex", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1", "t2"],
      sourceProps: (key) => (key === "t1" ? { "__dnd.sourceEnabled": false } : {}),
    });
    expect(src("t1").attributes.tabindex).toBeUndefined();
    expect(src("t1").attributes["aria-grabbed"]).toBeUndefined();
    expect(src("t2").attributes.tabindex).toBe("0");
    expect(src("t2").attributes["aria-grabbed"]).toBe("false");
    renderer.applyPatches([
      { type: "setProp", id: "todo-src-t1", name: "__dnd.sourceEnabled", value: true } as Patch,
    ]);
    expect(src("t1").attributes.tabindex).toBe("0");
    expect(src("t1").attributes["aria-grabbed"]).toBe("false");
    renderer.applyPatches([
      { type: "setProp", id: "todo-src-t2", name: "__dnd.sourceEnabled", value: false } as Patch,
    ]);
    expect(src("t2").attributes.tabindex).toBeUndefined();
    expect(src("t2").attributes["aria-grabbed"]).toBeUndefined();
    renderer.applyPatches([{ type: "removeProp", id: "todo-src-t1", name: "__dnd.source" } as Patch]);
    expect(src("t1").attributes.tabindex).toBeUndefined();
  });

  test("an author tabindex is never the runtime's to remove", () => {
    const { renderer } = makeRenderer();
    const { src } = mountList(renderer, {
      id: "todo",
      keys: ["t1"],
      sourceProps: () => ({ "__dnd.sourceEnabled": false }),
    });
    src("t1").setAttribute("tabindex", "-1");
    renderer.applyPatches([{ type: "setProp", id: "todo-src-t1", name: "__dnd.sourceEnabled", value: true } as Patch]);
    expect(src("t1").attributes.tabindex).toBe("-1");
    renderer.applyPatches([{ type: "removeProp", id: "todo-src-t1", name: "__dnd.source" } as Patch]);
    expect(src("t1").attributes.tabindex).toBe("-1");
  });
});

describe("mid-drag structural re-renders are rebuilt once per batch", () => {
  test("a batch inserting K rows under a hovered list measures the list once, after the batch", () => {
    const { renderer, engine } = makeRenderer();
    const keys = Array.from({ length: 40 }, (_, i) => `t${i + 1}`);
    const { row, src } = mountList(renderer, { id: "todo", keys });
    down(src("t1"), 100, 50);
    move(src("t1"), 100, 60);
    let reads = 0;
    for (const k of keys) {
      const el = row(k);
      const real = el.getBoundingClientRect;
      el.getBoundingClientRect = () => {
        reads += 1;
        return real();
      };
    }
    const patches: Patch[] = [];
    for (let i = 0; i < 10; i++) {
      const key = `n${i}`;
      patches.push(
        { type: "create", id: `todo-row-${key}`, elementType: "Row", props: {} } as Patch,
        { type: "insert", parentId: "todo", id: `todo-row-${key}` } as Patch,
        {
          type: "create",
          id: `todo-src-${key}`,
          elementType: "Text",
          props: { "0": key, "__dnd.key": key, "__dnd.source": SOURCE(null) },
        } as Patch,
        { type: "insert", parentId: `todo-row-${key}`, id: `todo-src-${key}` } as Patch
      );
    }
    renderer.applyPatches(patches);
    // One rebuild: each surviving row measured once (the dragged row keeps
    // its lift rect), not once per Insert patch.
    expect(reads).toBeLessThanOrEqual(keys.length);
    expect(reads).toBeGreaterThan(0);
    // The new rows are live slots regardless.
    for (let i = 0; i < 10; i++) {
      setRect(row(`n${i}`), { left: 0, top: (keys.length + i) * 100, width: 200, height: 100 });
    }
    setRect(renderer.getNode("todo") as FakeElement, { left: 0, top: 0, width: 200, height: 5000 });
    move(src("t1"), 100, 4950);
    up(src("t1"), 100, 4950);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ path: "tasks", from: 0, to: 49 });
  });
});

describe("fractional pin projection", () => {
  test("projects persisted fractions against the board and resizes without a state write", () => {
    const { renderer, engine } = makeRenderer();
    const { board, n2 } = mountBoard(renderer, { units: "fraction" });
    renderer.applyPatches([
      { type: "setProp", id: "n2", name: "__dnd.pinX", value: 0.5 } as Patch,
      { type: "setProp", id: "n2", name: "__dnd.pinY", value: 0.25 } as Patch,
    ]);
    expect(n2.style.translate).toBe("200px 75px");
    setRect(board, { left: 0, top: 0, width: 600, height: 400 });
    (renderer as any).dnd.flushStructural();
    expect(n2.style.translate).toBe("300px 100px");
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("reserved writes identify the source binding owner and event identifies the board", () => {
    const { renderer, engine } = makeRenderer();
    const { n2 } = mountBoard(renderer);
    down(n2, 20, 20);
    move(n2, 40, 40);
    up(n2, 40, 40);
    expect(engine.rawDispatches[0].node).toBe("n2");
    expect(engine.rawDispatches[0].action).toBe("__hypen_pin");
    expect(engine.rawDispatches[1].node).toBe("board");
  });
});
