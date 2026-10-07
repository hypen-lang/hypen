/**
 * `.dropZone(files: true, accept:)` and `.onFileDragEnter` on the Canvas
 * renderer (docs/dnd.md, "Files from the OS"). The canvas element receives
 * the native drag events; the pointer is hit-tested to the innermost enabled
 * files zone, which gets the runtime `over` pose through the canvas pose
 * path. `.onFileDragEnter` fires once per entry; a release is swallowed.
 *
 * Mock canvas + synthetic drag events (the canvas-dnd.test.ts idiom).
 */

import { test, expect, describe } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";

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
  const node = (id: string): VirtualNode => {
    const n = renderer.getNode(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  };
  const center = (id: string) => {
    const l = node(id).layout!;
    return { x: l.x + l.width / 2, y: l.y + l.height / 2 };
  };
  type Item = { kind: string; type: string };
  const drag = (
    type: string,
    p: { x: number; y: number },
    opts: { items?: Item[] | { length: number }; types?: string[] } = {}
  ) => {
    const event: any = {
      type,
      clientX: p.x,
      clientY: p.y,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      dataTransfer: {
        types: opts.types ?? ["Files"],
        items: opts.items ?? [{ kind: "file", type: "image/png" }],
        dropEffect: "copy",
      },
    };
    canvas.dispatchEvent(event);
    return event;
  };
  const down = (p: { x: number; y: number }) =>
    canvas.dispatchEvent({ type: "mousedown", clientX: p.x, clientY: p.y, button: 0, preventDefault() {} });
  const move = (p: { x: number; y: number }, buttons = 1) =>
    canvas.dispatchEvent({ type: "mousemove", clientX: p.x, clientY: p.y, buttons });
  const up = (p: { x: number; y: number }) =>
    canvas.dispatchEvent({ type: "mouseup", clientX: p.x, clientY: p.y, button: 0 });
  return { canvas, engine, renderer, node, center, drag, down, move, up };
}

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string): Patch => ({ type: "insert", parentId, id }) as any;
const setProp = (id: string, name: string, value: any): Patch => ({ type: "setProp", id, name, value }) as any;

const POSE = {
  "backgroundColor.0": "#fff",
  "__anim.states": { label: null, runtime: true },
  "__anim.statePoses": { over: { "backgroundColor.0": "#eef" } },
};

const filesZone = (extra: Record<string, any> = {}, zone: Record<string, any> = {}) => ({
  "__dnd.zone": { group: null, band: 0.5, files: true, accept: null, ...zone },
  ...POSE,
  ...extra,
});

/**
 * root (800×600 column)
 *   outer (400×300 files zone, padding 50)
 *     inner (200×100, props per test)
 *   side (400×200, props per test)
 */
function mount(h: ReturnType<typeof createHarness>, outer: Record<string, any>, inner: Record<string, any> = {}, side: Record<string, any> = {}) {
  h.renderer.applyPatches([
    create("root", "column", { width: 800, height: 600 }),
    insert("root", "root"),
    create("outer", "column", { width: 400, height: 300, padding: 50, ...outer }),
    insert("root", "outer"),
    create("inner", "column", { width: 200, height: 100, ...inner }),
    insert("outer", "inner"),
    create("side", "column", { width: 400, height: 200, ...side }),
    insert("root", "side"),
  ]);
}

const bg = (n: VirtualNode) => n.props.backgroundColor;

describe("canvas files drop zone", () => {
  test("over pose applies while files hover the zone and clears on leave", () => {
    const h = createHarness();
    mount(h, filesZone());
    const outer = h.node("outer");
    expect(bg(outer)).toBe("#fff");
    h.drag("dragenter", h.center("outer"));
    expect(bg(outer)).toBe("#eef");
    // Moving over a child stays lit.
    h.drag("dragover", h.center("inner"));
    expect(bg(outer)).toBe("#eef");
    // Moving off the zone (still on the canvas) clears it.
    h.drag("dragover", h.center("side"));
    expect(bg(outer)).toBe("#fff");
    h.drag("dragover", h.center("outer"));
    expect(bg(outer)).toBe("#eef");
    // Leaving the canvas clears it.
    h.drag("dragleave", h.center("outer"));
    expect(bg(outer)).toBe("#fff");
  });

  test("a release is swallowed (dropEffect none) and clears the pose; nothing dispatched", () => {
    const h = createHarness();
    mount(h, filesZone({ "onDrop.0": "@dropped" }));
    const over = h.drag("dragover", h.center("outer"));
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    const drop = h.drag("drop", h.center("outer"));
    expect(drop.defaultPrevented).toBe(true);
    expect(bg(h.node("outer"))).toBe("#fff");
    expect(h.engine.dispatched).toEqual([]);
    // Off every zone: the default is left alone.
    const elsewhere = h.drag("dragover", h.center("side"));
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  test("innermost enabled files zone wins, one at a time", () => {
    const h = createHarness();
    mount(h, filesZone(), filesZone());
    h.drag("dragover", h.center("inner"));
    expect(bg(h.node("inner"))).toBe("#eef");
    expect(bg(h.node("outer"))).toBe("#fff");
    h.drag("dragover", { x: 60, y: 250 }); // inside outer's padding, off inner
    expect(bg(h.node("inner"))).toBe("#fff");
    expect(bg(h.node("outer"))).toBe("#eef");
  });

  test("a disabled zone is ignored; disabling a lit zone clears it", () => {
    const h = createHarness();
    mount(h, filesZone(), filesZone({ "__dnd.zoneEnabled": false }));
    h.drag("dragover", h.center("inner"));
    expect(bg(h.node("inner"))).toBe("#fff");
    expect(bg(h.node("outer"))).toBe("#eef");
    h.renderer.applyPatches([setProp("outer", "__dnd.zoneEnabled", false)]);
    expect(bg(h.node("outer"))).toBe("#fff");
    const over = h.drag("dragover", h.center("inner"));
    expect(bg(h.node("outer"))).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("accept: match lights, mismatch stays dark (falls through outward), unknown types light", () => {
    const h = createHarness();
    mount(h, filesZone(), filesZone({}, { accept: "image/*" }));
    const inner = h.node("inner");
    const outer = h.node("outer");
    h.drag("dragover", h.center("inner"), { items: [{ kind: "file", type: "application/pdf" }] });
    expect(bg(inner)).toBe("#fff");
    expect(bg(outer)).toBe("#eef");
    h.drag("dragover", h.center("inner"), { items: [{ kind: "file", type: "image/webp" }] });
    expect(bg(inner)).toBe("#eef");
    expect(bg(outer)).toBe("#fff");
    h.drag("dragleave", h.center("inner"));
    h.drag("dragover", h.center("inner"), { items: [{ kind: "file", type: "" }] });
    expect(bg(inner)).toBe("#eef");
    h.drag("dragleave", h.center("inner"));
    h.drag("dragover", h.center("inner"), { items: { length: 2 } });
    expect(bg(inner)).toBe("#eef");
  });

  test("drags without files never light a zone", () => {
    const h = createHarness();
    mount(h, filesZone());
    const over = h.drag("dragover", h.center("outer"), { types: ["text/plain"] });
    expect(bg(h.node("outer"))).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("an in-app-only zone (no files key) ignores OS file drags", () => {
    const h = createHarness();
    mount(h, { "__dnd.zone": { group: null, band: 0.5 }, ...POSE });
    const over = h.drag("dragover", h.center("outer"));
    expect(bg(h.node("outer"))).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("onFileDragEnter on the zone fires once per entry with the default payload", () => {
    const h = createHarness();
    mount(h, filesZone({ "onFileDragEnter.0": "@incoming" }));
    const items = [
      { kind: "file", type: "image/png" },
      { kind: "file", type: "image/gif" },
    ];
    h.drag("dragenter", h.center("outer"), { items });
    h.drag("dragover", h.center("outer"), { items });
    h.drag("dragover", h.center("inner"), { items });
    expect(h.engine.dispatched.length).toBe(1);
    expect(h.engine.dispatched[0]!.name).toBe("incoming");
    expect(h.engine.dispatched[0]!.payload).toMatchObject({ type: "filedragenter", items: 2 });
    expect(Object.keys(h.engine.dispatched[0]!.payload).sort()).toEqual(["items", "timestamp", "type"]);
    // Leave the zone (still on the canvas) and come back: a new entry.
    h.drag("dragover", h.center("side"));
    h.drag("dragover", h.center("outer"));
    expect(h.engine.dispatched.length).toBe(2);
    // Leaving the canvas, then entering again: a new entry.
    h.drag("dragleave", h.center("outer"));
    h.drag("dragenter", h.center("outer"));
    expect(h.engine.dispatched.length).toBe(3);
  });

  test("onFileDragEnter custom named args replace the payload", () => {
    const h = createHarness();
    mount(h, filesZone({ "onFileDragEnter.0": "@incoming", "onFileDragEnter.slot": "avatar" }));
    h.drag("dragenter", h.center("outer"));
    expect(h.engine.dispatched).toEqual([{ name: "incoming", payload: { slot: "avatar" } }]);
  });

  test("onFileDragEnter on a zone that can't light (accept mismatch / disabled) does not fire", () => {
    const h = createHarness();
    mount(
      h,
      filesZone({ "onFileDragEnter.0": "@outerIncoming", "__dnd.zoneEnabled": false }),
      filesZone({ "onFileDragEnter.0": "@innerIncoming" }, { accept: "image/*" })
    );
    h.drag("dragenter", h.center("inner"), { items: [{ kind: "file", type: "application/pdf" }] });
    expect(h.engine.dispatched).toEqual([]);
  });

  test("onFileDragEnter without a files zone is inert (fires nothing, swallows nothing)", () => {
    const h = createHarness();
    mount(h, {}, {}, { "onFileDragEnter.0": "@incoming" });
    h.drag("dragenter", h.center("side"));
    h.drag("dragover", h.center("side"));
    expect(h.engine.dispatched.map((d) => d.name)).toEqual([]);
    const drop = h.drag("drop", h.center("side"));
    expect(drop.defaultPrevented).toBe(false);
  });

  test("in-app drag onto a files zone is unaffected (over pose + onDrop)", () => {
    const h = createHarness();
    mount(
      h,
      filesZone({ "__dnd.zoneId": "inbox", "onDrop.0": "@dropped" }, { group: "cards", accept: "image/*" }),
      {},
      { "__dnd.key": "c1", "__dnd.source": { group: "cards", handle: false, activation: "auto" } }
    );
    const start = h.center("side");
    h.down(start);
    h.move({ x: start.x + 10, y: start.y });
    h.move(h.center("inner"));
    expect(bg(h.node("outer"))).toBe("#eef");
    h.up(h.center("inner"));
    expect(h.engine.dispatched.map((d) => d.name)).toEqual(["dropped"]);
  });
});
