/**
 * Canvas drag-and-drop runtime tests (`packages/web/src/canvas/dnd.ts`,
 * plus the `hitTestNode` translate fix in `canvas/events.ts` and the ghost /
 * offset paint plumbing in `canvas/paint.ts`).
 *
 * Pure patch-consumer tests (plan §0: no wasm-pack here): the renderer is
 * fed `create`/`insert`/`setProp` patches carrying the byte-exact `__dnd.*`
 * wire from `engine-compatibility-tests/fixtures/dnd/*.json`, and the
 * gesture is driven with synthetic mouse events on the mock canvas — the
 * `canvas-anim.test.ts` / `canvas-video-v2.test.ts` idiom. In Bun there is
 * no `requestAnimationFrame`, so every `applyPatches` / redraw request
 * renders (and lays out) synchronously.
 */

import { test, expect, describe } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { DND_REORDER_ACTION, DND_PIN_ACTION } from "../packages/core/src/dnd";

// ---------------------------------------------------------------------------
// Mocks (canvas-anim.test.ts pattern)
// ---------------------------------------------------------------------------

class MockCanvasContext {
  fillStyle: any = "#000000";
  strokeStyle: any = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  shadowColor = "";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;

  /** Every `translate(x, y)` call, in order (paint-order assertions). */
  translates: Array<[number, number]> = [];
  /** Every `fillText` call (which node painted, and when). */
  texts: string[] = [];
  private stack: any[] = [];
  depth = 0;

  save() {
    this.depth++;
    this.stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, font: this.font });
  }
  restore() {
    this.depth--;
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
  }
  scale() {}
  translate(x: number, y: number) {
    this.translates.push([x, y]);
  }
  rotate() {}
  transform() {}
  setTransform() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  fillText(text: string) {
    this.texts.push(text);
  }
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
  context = new MockCanvasContext();
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
    if (list) {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    }
  }
  dispatchEvent(event: any) {
    for (const h of [...(this.listeners.get(event.type) ?? [])]) h(event);
    return true;
  }
  get parentElement() {
    return { appendChild: () => {} };
  }
}

class MockEngine {
  dispatched: Array<{ name: string; payload: any }> = [];
  rawDispatches: any[] = [];
  dispatchAction(name: string, payload?: any) {
    if (name === "__hypen_dispatch") { this.rawDispatches.push(payload); name = payload.action; payload = payload.payload; }

    this.dispatched.push({ name, payload });
  }
}

function createHarness() {
  const canvas = new MockCanvas();
  const engine = new MockEngine();
  const renderer = new CanvasRenderer(canvas as any, engine as any, {
    devicePixelRatio: 1,
    backgroundColor: "#ffffff",
    enableAccessibility: false,
    enableHitTesting: true,
  });
  const animator = renderer.getAnimator();
  let now = 0;
  animator.now = () => now;
  animator.manualFrameDriver = true;
  const render = () => (renderer as any).render();
  const advance = (ms: number) => {
    now += ms;
    render();
  };
  const node = (id: string): VirtualNode => {
    const n = renderer.getNode(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  };
  /** Pointer-space centre of a node's painted box (layout + translates). */
  const center = (id: string, dx = 0, dy = 0) => {
    const n = node(id);
    const l = n.layout!;
    let tx = 0;
    let ty = 0;
    for (let a: VirtualNode | null = n; a; a = a.parent) {
      tx += (parseFloat(a.props.translateX) || 0) + (a.dndOffset?.x ?? 0);
      ty += (parseFloat(a.props.translateY) || 0) + (a.dndOffset?.y ?? 0);
    }
    return { x: l.x + tx + l.width / 2 + dx, y: l.y + ty + l.height / 2 + dy };
  };
  const down = (p: { x: number; y: number }) =>
    canvas.dispatchEvent({ type: "mousedown", clientX: p.x, clientY: p.y, button: 0, preventDefault() {} });
  const move = (p: { x: number; y: number }, buttons = 1) =>
    canvas.dispatchEvent({ type: "mousemove", clientX: p.x, clientY: p.y, buttons });
  const up = (p: { x: number; y: number }) =>
    canvas.dispatchEvent({ type: "mouseup", clientX: p.x, clientY: p.y, button: 0 });
  const click = (p: { x: number; y: number }) =>
    canvas.dispatchEvent({ type: "click", clientX: p.x, clientY: p.y, button: 0 });
  const names = () => engine.dispatched.map((d) => d.name);
  return { canvas, engine, renderer, animator, render, advance, node, center, down, move, up, click, names };
}

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "insert", parentId, id, beforeId }) as any;
const setProp = (id: string, name: string, value: any): Patch =>
  ({ type: "setProp", id, name, value }) as any;
const move = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "move", parentId, id, beforeId }) as any;
const remove = (id: string): Patch => ({ type: "remove", id }) as any;

function mountRoot(renderer: CanvasRenderer) {
  renderer.applyPatches([create("root", "column", { width: 800, height: 600 }), insert("root", "root")]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stand-in `window` recording the drag-scoped release listeners the event
 * manager arms (the canvas-video-v2 scrubber idiom). `restore()` puts the
 * previous global back so the other files' expectations are untouched.
 */
function installFakeWindowListeners() {
  const g = globalThis as any;
  const hadWindow = Object.prototype.hasOwnProperty.call(g, "window");
  const prev = g.window;
  const w: any = {};
  const listeners = new Map<string, Function[]>();
  w.addEventListener = (type: string, handler: Function) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(handler);
  };
  w.removeEventListener = (type: string, handler: Function) => {
    const arr = listeners.get(type);
    if (arr) {
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  w.dispatchEvent = (event: any) => {
    // Copy: a handler may remove listeners mid-dispatch (disarm-on-drop).
    [...(listeners.get(event.type) ?? [])].forEach((h) => h(event));
    return true;
  };
  g.window = w;
  return {
    count: (type: string) => listeners.get(type)?.length ?? 0,
    fire: (type: string, event: any = {}) => w.dispatchEvent({ type, ...event }),
    restore: () => {
      if (hadWindow) g.window = prev;
      else delete g.window;
    },
  };
}

/** `__dnd.source` wire (draggable-lowering fixture). */
const SOURCE = { group: null, handle: false, activation: "auto" };

/**
 * A `.sortable(axis: y).bind(@state.tasks)` Column of three ForEach rows,
 * exactly the `sortable-lowering` fixture wire: the container carries
 * `__dnd.sort` + `bind`, and the Text INSIDE each Row (not the Row) carries
 * `__dnd.key` + `__dnd.source` + `__dnd.sourcePayload`.
 */
function mountSortable(
  renderer: CanvasRenderer,
  opts: {
    listProps?: Record<string, any>;
    rowProps?: Record<string, any>;
    group?: string | null;
    /** The rows' own `__dnd.source.group` (defaults to the container's). */
    sourceGroup?: string | null;
  } = {}
) {
  const group = opts.group ?? null;
  const sourceGroup = opts.sourceGroup === undefined ? group : opts.sourceGroup;
  const patches: Patch[] = [
    create("list", "column", {
      width: 200,
      "__dnd.sort": { group, axis: "y" },
      bind: "tasks",
      "onSort.0": "@reorder",
      "onDragEnd.0": "@ended",
      ...(opts.listProps ?? {}),
    }),
    insert("root", "list"),
  ];
  for (const k of ["t1", "t2", "t3"]) {
    patches.push(
      create(`r-${k}`, "row", { width: 200, height: 40, ...(opts.rowProps ?? {}) }),
      insert("list", `r-${k}`),
      create(k, "text", {
        "0": k.toUpperCase(),
        "__dnd.key": k,
        "__dnd.source": { group: sourceGroup, handle: false, activation: "auto" },
        "__dnd.sourcePayload": { id: k, title: k.toUpperCase() },
      }),
      insert(`r-${k}`, k)
    );
  }
  renderer.applyPatches(patches);
}

// ---------------------------------------------------------------------------
// §6.10 hit-test translate fix (standalone regression)
// ---------------------------------------------------------------------------

describe("canvas hit-test honours translateX/translateY (§6.10)", () => {
  test("a translated node receives hits where it paints, not at its layout box", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("box", "column", {
        width: 100,
        height: 50,
        "translateX.0": 300,
        "translateY.0": 200,
        "onClick.0": "@boxTapped",
      }),
      insert("root", "box"),
    ]);
    const box = h.node("box");
    const l = box.layout!;
    // Untransformed layout position: nothing there any more (root gets it).
    const events = (h.renderer as any).eventManager;
    expect(events.hitTest({ x: l.x + 10, y: l.y + 10 })).toBe(h.node("root"));
    // Painted position: the box.
    expect(events.hitTest({ x: l.x + 300 + 10, y: l.y + 200 + 10 })).toBe(box);
    // End to end: a click at the painted position dispatches the box's action.
    const p = { x: l.x + 300 + 10, y: l.y + 200 + 10 };
    h.down(p);
    h.up(p);
    h.click(p);
    expect(h.names()).toEqual(["boxTapped"]);
  });

  test("children of a translated container shift with it; null translate is 0", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("card", "column", { width: 100, height: 100, "translateX.0": 150, "translateY.0": null }),
      insert("root", "card"),
      create("label", "text", { "0": "hi", width: 100, height: 20 }),
      insert("card", "label"),
      create("plain", "column", { width: 100, height: 100, "translateX.0": null, "translateY.0": null }),
      insert("root", "plain"),
    ]);
    const events = (h.renderer as any).eventManager;
    const card = h.node("card");
    const label = h.node("label");
    const plain = h.node("plain");
    const cl = card.layout!;
    // The label is inside the card's painted (translated) box.
    expect(events.hitTest({ x: cl.x + 150 + 5, y: cl.y + 5 })).toBe(label);
    // Not at its untransformed layout box (that is the root, or a sibling).
    expect(events.hitTest({ x: cl.x + 5, y: cl.y + 5 })).not.toBe(label);
    // `null` translate = 0: hits at the layout box exactly as before.
    const pl = plain.layout!;
    expect(events.hitTest({ x: pl.x + 5, y: pl.y + 5 })).toBe(plain);
  });

  test("paint scopes a node's transform to its subtree (children translate with the card)", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("card", "column", { width: 100, height: 100, "translateX.0": 150 }),
      insert("root", "card"),
      create("label", "text", { "0": "inside", width: 100, height: 20 }),
      insert("card", "label"),
    ]);
    const ctx = h.canvas.context;
    ctx.translates = [];
    ctx.texts = [];
    ctx.depth = 0;
    h.render();
    // The card's transform is applied (a translate to its origin), the label
    // paints afterwards while the transform is still on the stack, and the
    // save/restore pairs balance over the frame.
    expect(ctx.translates.length).toBeGreaterThan(0);
    expect(ctx.texts).toContain("inside");
    expect(ctx.depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sortable reorder
// ---------------------------------------------------------------------------

describe("canvas dnd: sortable", () => {
  test("drag t1 below t3: preview shifts siblings, drop dispatches reorder → onSort → onDragEnd in order", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const r1 = h.node("r-t1");
    const r2 = h.node("r-t2");
    const r3 = h.node("r-t3");
    expect(r2.layout!.y - r1.layout!.y).toBe(40);

    const start = h.center("t1");
    h.down(start);
    // Below slop: nothing claimed, nothing dispatched.
    h.move({ x: start.x + 2, y: start.y + 3 });
    expect(h.renderer.getDnd().isDragging()).toBe(false);
    expect(r1.dndGhost).toBeUndefined();
    expect(h.engine.dispatched).toEqual([]);

    // Past the last row's midpoint: claimed, ghost follows, siblings open the gap.
    const dest = { x: start.x, y: r3.layout!.y + 30 };
    h.move(dest);
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    expect(r1.dndGhost).toBe(true);
    expect(r1.dndOffset).toEqual({ x: 0, y: dest.y - start.y });
    expect(r2.dndOffset).toEqual({ x: 0, y: -40 });
    expect(r3.dndOffset).toEqual({ x: 0, y: -40 });
    // Zero engine traffic during the drag (no onDragStart/onDragOver bound).
    expect(h.engine.dispatched).toEqual([]);
    // The ghost is hit-transparent: the pointer sees the list beneath it.
    const events = (h.renderer as any).eventManager;
    expect(events.hitTest(dest)).not.toBe(r1);

    h.up(dest);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
    // §4.2 payload, byte for byte: item, payload, from, to.
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 2 },
    });
    expect(Object.keys(h.engine.dispatched[1]!.payload)).toEqual(["item", "payload", "from", "to"]);
    expect(h.engine.dispatched[2]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 2 },
      dropped: true,
    });

    // The click the browser fires after mouseup belongs to the drag.
    h.click(dest);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);

    // Hold: local transforms stay until the engine's Move for the item lands.
    expect(r1.dndGhost).toBe(true);
    expect(r2.dndOffset).toEqual({ x: 0, y: -40 });
    h.renderer.applyPatches([move("list", "r-t1")]);
    expect(r1.dndGhost).toBeUndefined();
    expect(r1.dndOffset).toBeUndefined();
    expect(r2.dndOffset).toBeUndefined();
    expect(r3.dndOffset).toBeUndefined();
    expect(h.node("list").children.map((c) => c.id)).toEqual(["r-t2", "r-t3", "r-t1"]);
  });

  test("the ghost paints last (above its siblings) and the in-tree pass skips it", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const start = h.center("t1");
    h.down(start);
    h.move({ x: start.x, y: start.y + 45 });
    const ctx = h.canvas.context;
    ctx.texts = [];
    ctx.depth = 0;
    h.render();
    // T1 is the lifted row's text: painted once, after T2 and T3.
    expect(ctx.texts.filter((t) => t === "T1")).toHaveLength(1);
    expect(ctx.texts.indexOf("T1")).toBeGreaterThan(ctx.texts.indexOf("T3"));
    expect(ctx.depth).toBe(0);
    h.up({ x: start.x, y: start.y + 45 });
  });

  test("hold releases on the 500ms fallback when no Move arrives", async () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    h.renderer.getDnd().cleanupTimeoutMs = 20;
    const r1 = h.node("r-t1");
    const start = h.center("t1");
    h.down(start);
    // Past row 2's midpoint (the Text sits near the top of its 40px row).
    const dest = { x: start.x, y: h.node("r-t2").layout!.y + 30 };
    h.move(dest);
    h.up(dest);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 0, to: 1 });
    expect(r1.dndGhost).toBe(true);
    await sleep(60);
    expect(r1.dndGhost).toBeUndefined();
    expect(h.node("r-t2").dndOffset).toBeUndefined();
  });

  test("dropping back on the origin slot writes nothing and fires only onDragEnd", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const start = h.center("t1");
    h.down(start);
    h.move({ x: start.x, y: start.y + 10 });
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    h.up({ x: start.x, y: start.y + 10 });
    expect(h.names()).toEqual(["ended"]);
    expect(h.engine.dispatched[0]!.payload.dropped).toBe(true);
    // No hold for a no-op drop.
    expect(h.node("r-t1").dndGhost).toBeUndefined();
  });

  test("a tap on a draggable is a total no-op for DnD and still clicks", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer, { rowProps: { "onClick.0": "@rowTapped" } });
    const p = h.center("t1");
    h.down(p);
    h.up(p);
    h.click(p);
    expect(h.names()).toEqual(["rowTapped"]);
    expect(h.node("r-t1").dndGhost).toBeUndefined();
    expect(h.node("r-t1").dndOffset).toBeUndefined();
    expect(h.renderer.getDnd().isActive()).toBe(false);
  });

  test("onDragStart fires on claim; a Remove of the dragged row mid-drag cancels with NO dispatch", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer, { listProps: { "onDragStart.0": "@began" } });
    const r2 = h.node("r-t2");
    const start = h.center("t1");
    h.down(start);
    const mid = { x: start.x, y: start.y + 60 };
    h.move(mid);
    expect(h.names()).toEqual(["began"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 0 },
    });
    expect(r2.dndOffset).toEqual({ x: 0, y: -40 });

    h.renderer.applyPatches([remove("r-t1")]);
    // Cancelled cleanly: no onDragEnd, no reorder; siblings restored.
    expect(h.names()).toEqual(["began"]);
    expect(r2.dndOffset).toBeUndefined();
    expect(h.renderer.getDnd().isActive()).toBe(false);
    // A later release dispatches nothing either.
    h.up(mid);
    h.click(mid);
    expect(h.names()).toEqual(["began"]);
  });

  test("a Detach of an ancestor mid-drag cancels with NO dispatch", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const start = h.center("t2");
    h.down(start);
    h.move({ x: start.x, y: start.y - 45 });
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    h.renderer.applyPatches([{ type: "detach", id: "list" } as any]);
    expect(h.engine.dispatched).toEqual([]);
    expect(h.renderer.getDnd().isActive()).toBe(false);
  });

  test("an engine insert under the ORIGIN list mid-drag rebuilds its slots and the reserved write's `from` is the live index", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const r1 = h.node("r-t1");
    const r2 = h.node("r-t2");
    const r3 = h.node("r-t3");
    // Lift t3 (index 2) and hover the top slot: t1/t2 open the gap below.
    const start = h.center("t3");
    const top = { x: start.x, y: 10 };
    h.down(start);
    h.move(top);
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    expect(r3.dndOffset).toEqual({ x: 0, y: top.y - start.y });
    expect(r1.dndOffset).toEqual({ x: 0, y: 40 });
    expect(r2.dndOffset).toEqual({ x: 0, y: 40 });

    // A handler (spring-loaded folder, websocket push) inserts a row at
    // index 0 while t3 is in the air. The engine inserts top-down: the Row
    // lands first (no source yet), the draggable Text under it in a later
    // batch — the second insert reaches the runtime with the ROW as parent.
    h.renderer.applyPatches([create("r-t0", "row", { width: 200, height: 40 }), insert("list", "r-t0", "r-t1")]);
    h.renderer.applyPatches([
      create("t0", "text", {
        "0": "T0",
        "__dnd.key": "t0",
        "__dnd.source": SOURCE,
        "__dnd.sourcePayload": { id: "t0", title: "T0" },
      }),
      insert("r-t0", "t0"),
    ]);
    const r0 = h.node("r-t0");
    expect(r0.layout!.y).toBe(0);
    expect(r3.layout!.y).toBe(120);
    // Still dragging, zero engine traffic.
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    expect(h.engine.dispatched).toEqual([]);
    // The ghost did not jump: its own layout box moved down a row, so its
    // offset absorbs that shift and it still paints at lift + pointer delta.
    expect(r3.dndOffset).toEqual({ x: 0, y: top.y - start.y - 40 });
    // The new row is a live slot: hovering the top slot shifts it too.
    expect(r0.dndOffset).toEqual({ x: 0, y: 40 });
    expect(r1.dndOffset).toEqual({ x: 0, y: 40 });
    expect(r2.dndOffset).toEqual({ x: 0, y: 40 });

    h.up(top);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    // `from` is t3's LIVE index (3) — path_move relocates t3, not t2.
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 3, to: 0 });
    // The EVENT payload keeps the lift location.
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "t3",
      payload: { id: "t3", title: "T3" },
      from: { zone: "list", index: 2 },
      to: { zone: "list", index: 0 },
    });
    // Hold releases on the engine's Move.
    h.renderer.applyPatches([move("list", "r-t3", "r-t0")]);
    expect(r3.dndGhost).toBeUndefined();
    expect(r0.dndOffset).toBeUndefined();
    expect(h.node("list").children.map((c) => c.id)).toEqual(["r-t3", "r-t0", "r-t1", "r-t2"]);
  });

  test("an engine Remove of a sibling above the dragged item mid-drag shrinks the origin list and `from` follows", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const r1 = h.node("r-t1");
    const r2 = h.node("r-t2");
    const r3 = h.node("r-t3");
    const start = h.center("t3");
    const top = { x: start.x, y: 10 };
    h.down(start);
    h.move(top);
    expect(r1.dndOffset).toEqual({ x: 0, y: 40 });

    h.renderer.applyPatches([remove("r-t1")]);
    expect(h.renderer.getDnd().isDragging()).toBe(true);
    expect(h.engine.dispatched).toEqual([]);
    // The departed row drops its preview shift; the survivors re-slot.
    expect(r1.dndOffset).toBeUndefined();
    expect(r2.layout!.y).toBe(0);
    expect(r3.layout!.y).toBe(40);
    expect(r3.dndOffset).toEqual({ x: 0, y: top.y - start.y + 40 });
    expect(r2.dndOffset).toEqual({ x: 0, y: 40 });

    h.up(top);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 1, to: 0 });
    expect(h.engine.dispatched[1]!.payload.from).toEqual({ zone: "list", index: 2 });
  });

  test("keyboard: an engine insert under the origin mid-drag replays the preview and the drop writes the live `from`", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const dnd = h.renderer.getDnd();
    const t3 = h.node("t3");
    const r3 = h.node("r-t3");
    expect(dnd.keyDown(t3, { key: " " })).toBe(true);
    expect(dnd.keyDown(t3, { key: "ArrowUp" })).toBe(true);
    // Slot 1: ghost slid up one row, t2 shifted down.
    expect(r3.dndOffset).toEqual({ x: 0, y: -40 });
    expect(h.node("r-t2").dndOffset).toEqual({ x: 0, y: 40 });

    h.renderer.applyPatches([
      create("r-t0", "row", { width: 200, height: 40 }),
      insert("list", "r-t0", "r-t1"),
      create("t0", "text", { "0": "T0", "__dnd.key": "t0", "__dnd.source": SOURCE }),
      insert("r-t0", "t0"),
    ]);
    expect(dnd.isDragging()).toBe(true);
    // The machine still says slot 1; the ghost paints at the LIVE slot 1
    // (y = 40) from its shifted layout box (y = 120).
    expect(r3.dndOffset).toEqual({ x: 0, y: -80 });
    expect(h.node("r-t1").dndOffset).toEqual({ x: 0, y: 40 });
    expect(h.node("r-t2").dndOffset).toEqual({ x: 0, y: 40 });

    expect(dnd.keyDown(t3, { key: " " })).toBe(true);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 3, to: 1 });
  });

  test("dropping outside every zone cancels with onDragEnd {dropped: false} only", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const start = h.center("t1");
    h.down(start);
    h.move({ x: 700, y: 500 });
    h.up({ x: 700, y: 500 });
    expect(h.names()).toEqual(["ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 0 },
      dropped: false,
    });
  });

  test("lifted pose overlays statePoses[lifted] on the source and restores the base on release", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("list", "column", { width: 200, "__dnd.sort": { group: null, axis: "y" }, bind: "tasks" }),
      insert("root", "list"),
    ]);
    for (const k of ["a", "b"]) {
      h.renderer.applyPatches([
        create(k, "column", {
          width: 200,
          height: 40,
          "opacity.0": 1,
          "__dnd.key": k,
          "__dnd.source": SOURCE,
          "__anim.states": { label: null, runtime: true },
          "__anim.statePoses": { lifted: { "opacity.0": 0.6, "scale.0": 1.04 }, over: { "backgroundColor.0": "#eee" } },
        }),
        insert("list", k),
      ]);
    }
    const a = h.node("a");
    const start = h.center("a");
    h.down(start);
    h.move({ x: start.x, y: start.y + 45 });
    // Pose landed through the ordinary applicator path (flat props refreshed).
    expect(a.props["opacity.0"]).toBe(0.6);
    expect(a.props.opacity).toBe(0.6);
    expect(a.opacity).toBe(0.6);
    expect(a.props.scale).toBe(1.04);
    // An engine write to an overridden key while the label is on is deferred.
    h.renderer.applyPatches([setProp("a", "opacity.0", 0.3)]);
    expect(a.props.opacity).toBe(0.6);
    h.up({ x: start.x, y: start.y + 45 });
    h.renderer.applyPatches([move("list", "a")]);
    // Base restored: the deferred engine value wins over the pre-lift base,
    // and the pose-only `scale` is gone again.
    expect(a.props.opacity).toBe(0.3);
    expect(a.props["scale.0"]).toBeUndefined();
    expect(a.props.scale).toBeUndefined();
    expect(h.engine.dispatched.map((d) => d.name)).toEqual([DND_REORDER_ACTION]);
  });

  test("a drop completed through the window pointerup suppresses the trailing click (§6.11)", () => {
    const win = installFakeWindowListeners();
    try {
      const h = createHarness();
      mountRoot(h.renderer);
      mountSortable(h.renderer, { rowProps: { "onClick.0": "@rowTapped" } });
      const start = h.center("t1");
      h.down(start);
      expect(win.count("pointerup")).toBe(1); // armed on press (scrub precedent)
      // Claimed, but still over the origin slot — the drop is a no-op write,
      // and press/release resolve to the same clickable row.
      const p = { x: start.x, y: start.y + 10 };
      h.move(p);
      expect(h.renderer.getDnd().isDragging()).toBe(true);
      expect(h.node("r-t1").pressed).toBe(true);
      // Browser order: the window pointerup runs BEFORE the canvas mouseup.
      win.fire("pointerup", { clientX: p.x, clientY: p.y, button: 0 });
      expect(h.names()).toEqual(["ended"]);
      expect(win.count("pointerup")).toBe(0); // disarmed on drop
      expect(h.node("r-t1").pressed).toBe(false);
      h.up(p);
      h.click(p);
      // The release and click were the drag's, not the row's.
      expect(h.names()).toEqual(["ended"]);
      // The next tap on the row clicks normally.
      h.down(p);
      h.up(p);
      h.click(p);
      expect(h.names()).toEqual(["ended", "rowTapped"]);
    } finally {
      win.restore();
    }
  });

  test("a grouped sortable accepts its own draggable children whatever their own group (§6.11)", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer, { group: "board", sourceGroup: "cards" });
    const start = h.center("t1");
    h.down(start);
    const dest = { x: start.x, y: h.node("r-t3").layout!.y + 30 };
    h.move(dest);
    // Own list previews (t2/t3 close the gap) even though "cards" ≠ "board".
    expect(h.node("r-t2").dndOffset).toEqual({ x: 0, y: -40 });
    expect(h.node("r-t3").dndOffset).toEqual({ x: 0, y: -40 });
    h.up(dest);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
    expect(h.engine.dispatched[1]!.payload.to).toEqual({ zone: "board", index: 2 });
  });

  test("cross-list drop between two bound sortables of one group dispatches the long form", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("wrap", "row", { width: 800, height: 200 }),
      insert("root", "wrap"),
      create("todo", "column", {
        width: 200,
        height: 200,
        "__dnd.sort": { group: "board", axis: "y" },
        bind: "todo",
        "onSort.0": "@persist",
      }),
      insert("wrap", "todo"),
      create("doing", "column", {
        width: 200,
        height: 200,
        "__dnd.sort": { group: "board", axis: "y" },
        bind: "doing",
        "onSort.0": "@persist",
      }),
      insert("wrap", "doing"),
      create("c1", "column", { width: 200, height: 40, "__dnd.key": "c1", "__dnd.source": SOURCE }),
      insert("todo", "c1"),
      create("c2", "column", { width: 200, height: 40, "__dnd.key": "c2", "__dnd.source": SOURCE }),
      insert("todo", "c2"),
      create("d1", "column", { width: 200, height: 40, "__dnd.key": "d1", "__dnd.source": SOURCE }),
      insert("doing", "d1"),
    ]);
    const start = h.center("c2");
    h.down(start);
    // Below d1's midpoint inside `doing`: append at index 1.
    const dest = { x: h.center("d1").x, y: h.node("d1").layout!.y + 35 };
    h.move(dest);
    // Source list closes its gap (c1 unaffected: it was before c2), dest opens none (append).
    expect(h.node("d1").dndOffset).toBeUndefined();
    h.up(dest);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "persist"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ fromPath: "todo", from: 1, toPath: "doing", to: 1 });
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "c2",
      from: { zone: "board", index: 1 },
      to: { zone: "board", index: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Drop zones
// ---------------------------------------------------------------------------

describe("canvas dnd: dropZone", () => {
  function mountWithTrash(h: ReturnType<typeof createHarness>, zoneProps: Record<string, any> = {}) {
    mountSortable(h.renderer, { group: "fs" });
    h.renderer.applyPatches([
      create("trash", "row", {
        width: 200,
        height: 60,
        "backgroundColor.0": "#fff",
        "__dnd.zone": { group: "fs", band: 0.5 },
        "__dnd.zoneId": "trash",
        "__dnd.zoneEnabled": true,
        "onDrop.0": "@deleteFile",
        "__anim.states": { label: null, runtime: true },
        "__anim.statePoses": { over: { "backgroundColor.0": "#eee" } },
        ...zoneProps,
      }),
      insert("root", "trash"),
    ]);
  }

  test("drop INTO a compatible zone: over pose while hovered, onDrop with index null, no reserved write", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountWithTrash(h);
    const trash = h.node("trash");
    const start = h.center("t1");
    h.down(start);
    const over = h.center("trash");
    h.move(over);
    expect(trash.props.backgroundColor).toBe("#eee");
    // Leaving clears the pose; re-entering re-applies it.
    h.move({ x: start.x, y: start.y + 20 });
    expect(trash.props.backgroundColor).toBe("#fff");
    h.move(over);
    expect(trash.props.backgroundColor).toBe("#eee");
    expect(h.engine.dispatched).toEqual([]);

    h.up(over);
    expect(h.names()).toEqual(["deleteFile", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "fs", index: 0 },
      to: { zone: "trash", index: null },
    });
    // The over pose lives through the post-drop hold (DOM parity) and is
    // restored when the engine's re-render lands — here the module deleted
    // the file, so the row leaves the origin list.
    expect(trash.props.backgroundColor).toBe("#eee");
    h.renderer.applyPatches([remove("r-t1")]);
    expect(trash.props.backgroundColor).toBe("#fff");
    expect(h.renderer.getDnd().isActive()).toBe(false);
  });

  test("a disabled zone is skipped; an incompatible group never matches", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountWithTrash(h, { "__dnd.zoneEnabled": false });
    const start = h.center("t1");
    h.down(start);
    const over = h.center("trash");
    h.move(over);
    expect(h.node("trash").props.backgroundColor).toBe("#fff");
    h.up(over);
    // Nothing accepts the drop: cancel semantics.
    expect(h.names()).toEqual(["ended"]);
    expect(h.engine.dispatched[0]!.payload.dropped).toBe(false);

    // Re-enable but change the group: still no match.
    h.renderer.applyPatches([setProp("trash", "__dnd.zoneEnabled", true), setProp("trash", "__dnd.zone", { group: "other", band: 0.5 })]);
    h.engine.dispatched = [];
    h.down(start);
    h.move(over);
    h.up(over);
    expect(h.names()).toEqual(["ended"]);
    expect(h.engine.dispatched[0]!.payload.dropped).toBe(false);
  });

  test("onDragOver fires once per zone entry after the dwell, with dwell stripped from the payload", async () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountWithTrash(h, { "onDragOver.0": "@peek", "onDragOver.dwell": 10, "onDragOver.folder": "bin" });
    const start = h.center("t1");
    h.down(start);
    const over = h.center("trash");
    h.move(over);
    h.move({ x: over.x + 1, y: over.y });
    await sleep(40);
    expect(h.names()).toEqual(["peek"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      folder: "bin",
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "fs", index: 0 },
      to: { zone: "trash", index: null },
    });
    h.up(over);
  });

  test("band rule on a sortable row that is also a zone: middle = into, edges = reorder", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("fs", "column", { width: 200, "__dnd.sort": { group: "fs", axis: "y" }, bind: "entries" }),
      insert("root", "fs"),
    ]);
    for (const k of ["file", "folder"]) {
      h.renderer.applyPatches([
        create(k, "row", {
          width: 200,
          height: 40,
          "__dnd.key": k,
          "__dnd.source": { group: "fs", handle: false, activation: "auto" },
          "__dnd.zone": { group: "fs", band: 0.5 },
          "__dnd.zoneId": k,
          "__dnd.zoneEnabled": k === "folder",
          "onDrop.0": "@moveInto",
        }),
        insert("fs", k),
      ]);
    }
    const folder = h.node("folder").layout!;
    const start = h.center("file");
    // Into: the middle 50% of the folder row.
    h.down(start);
    h.move({ x: start.x, y: folder.y + 20 });
    h.up({ x: start.x, y: folder.y + 20 });
    expect(h.names()).toEqual(["moveInto"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "file",
      from: { zone: "fs", index: 0 },
      to: { zone: "folder", index: null },
    });
    h.renderer.getDnd().reset();
    h.engine.dispatched = [];
    // After: the bottom 25% falls through to the sortable → reorder to index 1.
    h.down(start);
    h.move({ x: start.x, y: folder.y + 37 });
    h.up({ x: start.x, y: folder.y + 37 });
    expect(h.names()).toEqual([DND_REORDER_ACTION]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "entries", from: 0, to: 1 });
  });
});

// ---------------------------------------------------------------------------
// Pinboard
// ---------------------------------------------------------------------------

describe("canvas dnd: pinboard", () => {
  /** `pinboard-reserved-lowering` fixture wire. */
  function mountBoard(h: ReturnType<typeof createHarness>, boardProps: Record<string, any> = {}) {
    h.renderer.applyPatches([
      create("board", "stack", {
        width: 400,
        height: 300,
        "__dnd.pin": { group: "board", xKey: "x", yKey: "y", grid: null, bounds: "clamp", units: "px" },
        ...boardProps,
      }),
      insert("root", "board"),
      create("n1", "column", {
        width: 50,
        height: 50,
        "__dnd.key": "n1",
        "__dnd.pinGroup": "board",
        "__dnd.source": SOURCE,
        "translateX.0": 40,
        "translateY.0": 60,
      }),
      insert("board", "n1"),
      create("n2", "column", {
        width: 50,
        height: 50,
        "__dnd.key": "n2",
        "__dnd.pinGroup": "board",
        "__dnd.source": SOURCE,
        "translateX.0": null,
        "translateY.0": null,
      }),
      insert("board", "n2"),
    ]);
  }

  test("fractional projection updates hit testing when the board resizes", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountBoard(h);
    h.renderer.applyPatches([
      { type: "setProp", id: "n2", name: "__dnd.pinX", value: 0.5 } as Patch,
      { type: "setProp", id: "n2", name: "__dnd.pinY", value: 0.25 } as Patch,
    ]);
    const events = (h.renderer as any).eventManager;
    const note = h.node("n2");
    expect(events.hitTest({ x: note.layout!.x + 205, y: note.layout!.y + 80 })).toBe(note);
    h.renderer.applyPatches([{ type: "setProp", id: "board", name: "width", value: 600 } as Patch]);
    expect(events.hitTest({ x: note.layout!.x + 305, y: note.layout!.y + 80 })).toBe(note);
    expect(h.engine.dispatched).toEqual([]);
  });

  test("reserved mode: a pinned note is grabbed where it paints; drop writes __hypen_pin then onPin then onDragEnd", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountBoard(h, { "onPin.0": "@pinned", "onDragEnd.0": "@ended" });
    const n1 = h.node("n1");
    const board = h.node("board").layout!;
    // n1's layout box (untranslated) is at the board's origin; the pointer
    // must grab it at layout + (40, 60).
    const events = (h.renderer as any).eventManager;
    expect(events.hitTest({ x: n1.layout!.x + 40 + 5, y: n1.layout!.y + 60 + 5 })).toBe(n1);

    const start = h.center("n1");
    h.down(start);
    h.move({ x: start.x + 100, y: start.y + 20 });
    expect(n1.dndGhost).toBe(true);
    expect(n1.dndOffset).toEqual({ x: 100, y: 20 });
    // The author translate is untouched during the drag (offset composes on top).
    expect(n1.props.translateX).toBe(40);
    h.up({ x: start.x + 100, y: start.y + 20 });

    expect(h.names()).toEqual([DND_PIN_ACTION, "pinned", "ended"]);
    const contentX = board.x;
    const contentY = board.y;
    const expectX = n1.layout!.x + 40 + 100 - contentX;
    const expectY = n1.layout!.y + 60 + 20 - contentY;
    expect(h.engine.dispatched[0]!.payload).toEqual({
      path: "__dnd.board.n1",
      x: expectX,
      y: expectY,
      xKey: "x",
      yKey: "y",
    });
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "n1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 0 },
      x: expectX,
      y: expectY,
    });
    expect(h.engine.dispatched[2]!.payload.dropped).toBe(true);

    // Hold: the ghost sits at the resolved position until the engine's
    // re-render lands as SetProp translateX.0/translateY.0 on this node.
    expect(n1.dndGhost).toBe(true);
    h.renderer.applyPatches([setProp("n1", "translateX.0", expectX), setProp("n1", "translateY.0", expectY)]);
    expect(n1.dndGhost).toBeUndefined();
    expect(n1.dndOffset).toBeUndefined();
    expect(n1.props.translateX).toBe(expectX);
    expect(n1.props.translateY).toBe(expectY);
    // And it is now grabbable at the new position.
    expect(events.hitTest({ x: n1.layout!.x + expectX + 5, y: n1.layout!.y + expectY + 5 })).toBe(n1);
  });

  test("null translate is 0: the unpinned note sits at the board origin; clamp keeps it inside; grid snaps", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountBoard(h);
    h.renderer.applyPatches([
      setProp("board", "__dnd.pin", { group: "board", xKey: "x", yKey: "y", grid: 8, bounds: "clamp", units: "px" }),
    ]);
    const n2 = h.node("n2");
    const board = h.node("board").layout!;
    const events = (h.renderer as any).eventManager;
    expect(events.hitTest({ x: n2.layout!.x + 5, y: n2.layout!.y + 5 })).toBe(n2);

    const start = h.center("n2");
    h.down(start);
    // Pointer still inside the board (a release outside every zone is a
    // cancel) but the note's box would overhang the bottom-right corner:
    // clamped to content size minus the note.
    const corner = { x: board.x + board.width - 5, y: board.y + board.height - 5 };
    h.move(corner);
    h.up(corner);
    expect(h.names()).toEqual([DND_PIN_ACTION]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      path: "__dnd.board.n2",
      x: board.width - 50,
      y: board.height - 50,
      xKey: "x",
      yKey: "y",
    });
    // The held ghost snapped to the clamped position.
    expect(n2.dndOffset).toEqual({ x: board.width - 50 - (n2.layout!.x - board.x), y: board.height - 50 - (n2.layout!.y - board.y) });
    h.renderer.getDnd().reset();
    h.engine.dispatched = [];

    // Grid 8: (13, 5) → (16, 8).
    h.down(start);
    h.move({ x: start.x + 13, y: start.y + 5 });
    h.up({ x: start.x + 13, y: start.y + 5 });
    expect(h.engine.dispatched[0]!.payload.x).toBe(16);
    expect(h.engine.dispatched[0]!.payload.y).toBe(8);
  });

  test("user-field mode (bind present): path is <bind>.<index> and fraction units divide by the content box", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("board", "stack", {
        width: 400,
        height: 200,
        "__dnd.pin": { group: null, xKey: "px", yKey: "py", grid: null, bounds: "clamp", units: "fraction" },
        bind: "seats",
        "onPin.0": "@seatMoved",
      }),
      insert("root", "board"),
      create("s1", "column", { width: 40, height: 40, "__dnd.key": "s1", "__dnd.source": SOURCE, "translateX.0": 0, "translateY.0": 0 }),
      insert("board", "s1"),
      create("s2", "column", { width: 40, height: 40, "__dnd.key": "s2", "__dnd.source": SOURCE, "translateX.0": 100, "translateY.0": 0 }),
      insert("board", "s2"),
    ]);
    const start = h.center("s2");
    h.down(start);
    h.move({ x: start.x + 100, y: start.y + 100 });
    h.up({ x: start.x + 100, y: start.y + 100 });
    expect(h.names()).toEqual([DND_PIN_ACTION, "seatMoved"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "seats.1", x: 0.5, y: 0.5, xKey: "px", yKey: "py" });
    expect(h.engine.dispatched[1]!.payload.x).toBe(0.5);
    expect(h.engine.dispatched[1]!.payload.to).toEqual({ zone: "board", index: 1 });
  });

  test("a foreign compatible pinboard hit as 'into' reports to.zone by the sortable rule: its group (§6.11)", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("wrap", "row", { width: 800, height: 300 }),
      insert("root", "wrap"),
      create("list", "column", {
        width: 200,
        height: 300,
        "__dnd.sort": { group: "notes", axis: "y" },
        bind: "tasks",
      }),
      insert("wrap", "list"),
      create("a", "column", { width: 200, height: 40, "__dnd.key": "a", "__dnd.source": SOURCE }),
      insert("list", "a"),
      create("board", "stack", {
        width: 400,
        height: 300,
        id: "boardNode",
        "__dnd.pin": { group: "notes", xKey: "x", yKey: "y", grid: null, bounds: "clamp", units: "px" },
        "onDrop.0": "@dropped",
      }),
      insert("wrap", "board"),
    ]);
    const start = h.center("a");
    h.down(start);
    const dest = h.center("board");
    h.move(dest);
    h.up(dest);
    // A plain "into": no reserved write, `.onDrop` on the board with
    // `to.zone` = group (not the resolved `id` prop, not the node id).
    expect(h.names()).toEqual(["dropped"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "a",
      from: { zone: "notes", index: 0 },
      to: { zone: "notes", index: null },
    });
  });

  test("engine translate writes to the lifted note are deferred until release", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountBoard(h);
    const n1 = h.node("n1");
    const start = h.center("n1");
    h.down(start);
    h.move({ x: start.x + 30, y: start.y });
    h.renderer.applyPatches([setProp("n1", "translateX.0", 200)]);
    expect(n1.props.translateX).toBe(40); // deferred: the ghost base does not jump
    // Cancel via Remove: no dispatch, and the deferred write flushes.
    h.renderer.applyPatches([remove("n1")]);
    expect(h.engine.dispatched).toEqual([]);
    expect(h.renderer.getDnd().isActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keyboard (core KeyboardDragMachine wired to the focus manager's key path)
// ---------------------------------------------------------------------------

describe("canvas dnd: keyboard", () => {
  test("Space lifts, ArrowDown moves, Space drops through the same commit path", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const dnd = h.renderer.getDnd();
    const t1 = h.node("t1");
    const r1 = h.node("r-t1");
    const r2 = h.node("r-t2");
    // Sources are focusable (keyboard reachability through the mirror).
    expect(t1.focusable).toBe(true);
    expect(dnd.keyDown(t1, { key: " " })).toBe(true);
    expect(dnd.isDragging()).toBe(true);
    expect(r1.dndGhost).toBe(true);
    expect(dnd.describeKeyboard()).toBe("t1, position 1 of 3");
    expect(dnd.keyDown(t1, { key: "ArrowDown" })).toBe(true);
    expect(dnd.keyDown(t1, { key: "ArrowDown" })).toBe(true);
    // Preview mirrors the pointer path: ghost slid down, siblings shifted up.
    expect(r1.dndOffset).toEqual({ x: 0, y: 80 });
    expect(r2.dndOffset).toEqual({ x: 0, y: -40 });
    expect(h.engine.dispatched).toEqual([]);
    expect(dnd.keyDown(t1, { key: " " })).toBe(true);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "reorder", "ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 2 },
    });
    h.renderer.applyPatches([move("list", "r-t1")]);
    expect(r1.dndGhost).toBeUndefined();
  });

  test("Tab moves to the same-group sibling list by NODE identity and drops the long-form write (§6.11)", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    h.renderer.applyPatches([
      create("wrap", "row", { width: 800, height: 200 }),
      insert("root", "wrap"),
      create("todo", "column", {
        width: 200,
        height: 200,
        "__dnd.sort": { group: "board", axis: "y" },
        bind: "todo",
        "onSort.0": "@persist",
      }),
      insert("wrap", "todo"),
      create("doing", "column", {
        width: 200,
        height: 200,
        "__dnd.sort": { group: "board", axis: "y" },
        bind: "doing",
        "onSort.0": "@persist",
      }),
      insert("wrap", "doing"),
      create("c1", "column", { width: 200, height: 40, "__dnd.key": "c1", "__dnd.source": SOURCE }),
      insert("todo", "c1"),
      create("c2", "column", { width: 200, height: 40, "__dnd.key": "c2", "__dnd.source": SOURCE }),
      insert("todo", "c2"),
      create("d1", "column", { width: 200, height: 40, "__dnd.key": "d1", "__dnd.source": SOURCE }),
      insert("doing", "d1"),
    ]);
    const dnd = h.renderer.getDnd();
    const c1 = h.node("c1");
    expect(dnd.keyDown(c1, { key: " " })).toBe(true);
    expect(dnd.describeKeyboard()).toBe("c1, position 1 of 2");
    // Tab: the machine's zone is the destination NODE (both lists share the
    // "board" label, so a label lookup would fall back onto the origin).
    expect(dnd.keyDown(c1, { key: "Tab" })).toBe(true);
    expect(dnd.describeKeyboard()).toBe("c1, doing, position 2 of 2");
    // Append after d1: the DESTINATION list is the one previewed (nothing
    // shifts for an append) and the origin sibling is NOT shifted.
    expect(h.node("d1").dndOffset).toBeUndefined();
    expect(h.node("c2").dndOffset).toBeUndefined();
    // ArrowUp: before d1 — d1 opens the gap.
    expect(dnd.keyDown(c1, { key: "ArrowUp" })).toBe(true);
    expect(dnd.describeKeyboard()).toBe("c1, doing, position 1 of 2");
    expect(h.node("d1").dndOffset).toEqual({ x: 0, y: 40 });
    expect(h.node("c2").dndOffset).toBeUndefined();
    // Shift+Tab wraps back to the origin (own slot: nothing shifted).
    expect(dnd.keyDown(c1, { key: "Tab", shiftKey: true })).toBe(true);
    expect(dnd.describeKeyboard()).toBe("c1, position 1 of 2");
    expect(h.node("d1").dndOffset).toBeUndefined();
    // Tab, ArrowUp again, and drop: the same {fromPath,from,toPath,to} write
    // as the pointer path, then onSort on the DESTINATION list.
    dnd.keyDown(c1, { key: "Tab" });
    dnd.keyDown(c1, { key: "ArrowUp" });
    expect(h.engine.dispatched).toEqual([]);
    expect(dnd.keyDown(c1, { key: " " })).toBe(true);
    expect(h.names()).toEqual([DND_REORDER_ACTION, "persist"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({ fromPath: "todo", from: 0, toPath: "doing", to: 0 });
    expect(h.engine.dispatched[1]!.payload).toEqual({
      item: "c1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 0 },
    });
  });

  test("Escape cancels with onDragEnd {dropped:false}; unrelated keys pass through", () => {
    const h = createHarness();
    mountRoot(h.renderer);
    mountSortable(h.renderer);
    const dnd = h.renderer.getDnd();
    const t1 = h.node("t1");
    expect(dnd.keyDown(t1, { key: "a" })).toBe(false);
    dnd.keyDown(t1, { key: " " });
    dnd.keyDown(t1, { key: "ArrowDown" });
    expect(dnd.keyDown(t1, { key: "Escape" })).toBe(true);
    expect(h.names()).toEqual(["ended"]);
    expect(h.engine.dispatched[0]!.payload).toEqual({
      item: "t1",
      payload: { id: "t1", title: "T1" },
      from: { zone: "list", index: 0 },
      to: { zone: "list", index: 1 },
      dropped: false,
    });
    expect(h.node("r-t1").dndGhost).toBeUndefined();
    expect(h.node("r-t2").dndOffset).toBeUndefined();
  });
});
