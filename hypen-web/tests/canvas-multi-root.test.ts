/**
 * Canvas renderer — several ordered root children.
 *
 * When control flow (Router / If / ForEach) sits at the IR root next to
 * siblings, the engine addresses more than one node to the reserved
 * `"root"` parent: `insert`/`move`/`attach` with `parentId: "root"` and a
 * `beforeId` anchor, plus `remove`/`detach` of a root child (engine
 * `tests/test_control_flow_order.rs` `root_*`). The DOM renderer keeps them
 * as ordered children of its container; the desktop renderer as ordered
 * children of an implicit viewport-sized flex column. The canvas renderer
 * matches: root children are an ordered list laid out top-to-bottom in an
 * implicit canvas-sized column, and every tree walk (layout, paint, hit
 * testing, scroll targeting, the a11y mirror, windowed lists) sees all of
 * them. A single root keeps its old behaviour (pinned to the canvas).
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import { initTaffyLayout, setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { semanticAction } from "./helpers";

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

class RecordingEngine {
  actions: string[] = [];
  reports: Array<[string, number, number]> = [];
  dispatchAction(name: string, payload?: any) {
    this.actions.push(semanticAction(name, payload).name);
  }
  setListViewport(id: string, start: number, end: number) {
    this.reports.push([id, start, end]);
  }
}

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "insert", parentId, id, ...(beforeId ? { beforeId } : {}) }) as any;
const move = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "move", parentId, id, ...(beforeId ? { beforeId } : {}) }) as any;
const attach = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "attach", parentId, id, ...(beforeId ? { beforeId } : {}) }) as any;
const detach = (id: string): Patch => ({ type: "detach", id }) as any;
const remove = (id: string, transition?: boolean): Patch =>
  ({ type: "remove", id, ...(transition ? { transition: true } : {}) }) as any;
const setProp = (id: string, name: string, value: any): Patch =>
  ({ type: "setProp", id, name, value }) as any;

function harness(opts: { a11y?: boolean; canvas?: any } = {}) {
  const canvas = opts.canvas ?? new MockCanvas();
  const engine = new RecordingEngine();
  const renderer = new CanvasRenderer(canvas as any, engine as any, {
    devicePixelRatio: 1,
    enableAccessibility: opts.a11y ?? false,
  });
  const node = (id: string) => renderer.getNode(id) as VirtualNode;
  const roots = () => renderer.getRootNodes().map((n) => n.id);
  const hitTest = (x: number, y: number) =>
    (renderer as any).eventManager.hitTest({ x, y }) as VirtualNode | null;
  const click = (x: number, y: number) => {
    const base = { clientX: x, clientY: y, button: 0, preventDefault() {} };
    canvas.dispatchEvent({ type: "mousedown", ...base });
    canvas.dispatchEvent({ type: "mouseup", ...base });
    canvas.dispatchEvent({ type: "click", ...base });
  };
  const wheel = (deltaY: number, x: number, y: number) =>
    canvas.dispatchEvent({
      type: "wheel",
      clientX: x,
      clientY: y,
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      preventDefault() {},
    });
  return { canvas, engine, renderer, node, roots, hitTest, click, wheel };
}

/** A fixed-height root-level row. */
const row = (id: string, height = 100, extra: Record<string, any> = {}): Patch =>
  create(id, "Column", { height, ...extra });

function suite(backend: "fallback" | "auto") {
  describe(`canvas multi-root (${backend} layout)`, () => {
    beforeAll(async () => {
      if (backend === "auto") await initTaffyLayout();
      setLayoutBackend(backend);
    });
    afterAll(() => setLayoutBackend("auto"));

    test("two root siblings inserted in order stack top-to-bottom", () => {
      const h = harness();
      h.renderer.applyPatches([row("a"), insert("root", "a"), row("b", 50), insert("root", "b")]);
      expect(h.roots()).toEqual(["a", "b"]);
      const a = h.node("a").layout!;
      const b = h.node("b").layout!;
      expect(a.y).toBe(0);
      expect(a.height).toBe(100);
      expect(b.y).toBe(100);
      expect(b.height).toBe(50);
      // Both are painted at full canvas width (implicit column stretches).
      expect(a.width).toBe(800);
      expect(b.width).toBe(800);
      // Neither root child is reparented to another root child.
      expect(h.node("a").children).toEqual([]);
    });

    test("insert with beforeId lands before its anchor", () => {
      const h = harness();
      h.renderer.applyPatches([row("a"), insert("root", "a"), row("c"), insert("root", "c")]);
      h.renderer.applyPatches([row("b"), insert("root", "b", "c")]);
      expect(h.roots()).toEqual(["a", "b", "c"]);
      expect(h.node("b").layout!.y).toBe(100);
      expect(h.node("c").layout!.y).toBe(200);
    });

    test("move at root reorders (anchored and to-the-end)", () => {
      const h = harness();
      h.renderer.applyPatches([
        row("a"), insert("root", "a"),
        row("b"), insert("root", "b"),
        row("c"), insert("root", "c"),
      ]);
      h.renderer.applyPatches([move("root", "c", "a")]);
      expect(h.roots()).toEqual(["c", "a", "b"]);
      expect(h.node("c").layout!.y).toBe(0);
      expect(h.node("a").layout!.y).toBe(100);
      h.renderer.applyPatches([move("root", "c")]);
      expect(h.roots()).toEqual(["a", "b", "c"]);
      expect(h.node("c").layout!.y).toBe(200);
    });

    test("detach + attach at root with beforeId keeps the same subtree", () => {
      const h = harness();
      h.renderer.applyPatches([
        row("a"), insert("root", "a"),
        row("b"), insert("root", "b"),
        create("bt", "Text", { 0: "kept" }), insert("b", "bt"),
        row("c"), insert("root", "c"),
      ]);
      const b = h.node("b");
      h.renderer.applyPatches([detach("b")]);
      expect(h.roots()).toEqual(["a", "c"]);
      expect(h.node("c").layout!.y).toBe(100);
      h.renderer.applyPatches([attach("root", "b", "c")]);
      expect(h.roots()).toEqual(["a", "b", "c"]);
      expect(h.node("b")).toBe(b);
      expect(b.children.map((n) => n.id)).toEqual(["bt"]);
      expect(h.node("c").layout!.y).toBe(200);
    });

    test("remove one of several roots", () => {
      const h = harness();
      h.renderer.applyPatches([
        row("a"), insert("root", "a"),
        row("b"), insert("root", "b"),
        row("c"), insert("root", "c"),
      ]);
      h.renderer.applyPatches([remove("b")]);
      expect(h.roots()).toEqual(["a", "c"]);
      expect(h.node("b")).toBeUndefined();
      expect(h.node("c").layout!.y).toBe(100);
      // Removing down to one root returns to the pinned single-root layout.
      h.renderer.applyPatches([remove("a")]);
      expect(h.roots()).toEqual(["c"]);
      expect(h.node("c").layout!.y).toBe(0);
    });

    test("hit-testing and click dispatch reach a non-first root", () => {
      const h = harness();
      h.renderer.applyPatches([
        row("a"), insert("root", "a"),
        create("b", "Button", { height: 60, onClick: "@actions.tapB" }), insert("root", "b"),
      ]);
      expect(h.hitTest(10, 50)?.id).toBe("a");
      expect(h.hitTest(10, 130)?.id).toBe("b");
      // Empty canvas below the last root hits nothing (no implicit node).
      expect(h.hitTest(10, 500)).toBeNull();
      h.click(10, 130);
      expect(h.engine.actions).toEqual(["tapB"]);
    });

    test("scroll targeting finds a scrollable non-first root", () => {
      const h = harness();
      h.renderer.applyPatches([
        row("a"), insert("root", "a"),
        create("s", "Column", { height: 200, scrollable: "vertical" }), insert("root", "s"),
        create("tall", "Column", { height: 2000 }), insert("s", "tall"),
      ]);
      h.wheel(300, 10, 150);
      expect(h.node("s").scrollState?.scrollY).toBe(300);
    });

    test("a windowed list under a non-first root reports its viewport", () => {
      const h = harness();
      const patches: Patch[] = [
        row("a"), insert("root", "a"),
        create("L", "List", { height: 400, scrollable: "vertical" }), insert("root", "L"),
      ];
      for (let i = 0; i < 30; i++) {
        patches.push(create(`r${i}`, "Container", { height: 40, width: 200 }), insert("L", `r${i}`));
      }
      patches.push(setProp("L", "__virt.window", { total: 1000, start: 0, end: 30 }));
      h.renderer.applyPatches(patches);
      expect(h.node("L").layout!.y).toBe(100);
      h.wheel(4000, 10, 200);
      expect(h.engine.reports.length).toBe(1);
      expect(h.engine.reports[0]![0]).toBe("L");
    });

    test("animated exit of a root child keeps its slot until finalize, unhittable", () => {
      const h = harness();
      const animator = h.renderer.getAnimator();
      let now = 0;
      animator.now = () => now;
      animator.manualFrameDriver = true;
      h.renderer.applyPatches([
        row("a", 100, { "__anim.exit": { presets: ["fade"], duration: 1000, curve: "linear" } }),
        insert("root", "a"),
        create("b", "Button", { height: 60, onClick: "@actions.tapB" }), insert("root", "b"),
      ]);
      h.renderer.applyPatches([remove("a", true)]);
      expect(h.roots()).toEqual(["a", "b"]);
      expect(h.hitTest(10, 50)).toBeNull();
      expect(h.hitTest(10, 130)?.id).toBe("b");
      now += 1100;
      (h.renderer as any).render();
      expect(h.roots()).toEqual(["b"]);
      expect(h.node("a")).toBeUndefined();
    });

    test("single root keeps the pinned canvas-sized layout", () => {
      const h = harness();
      h.renderer.applyPatches([create("r", "Column", {}), insert("root", "r")]);
      expect(h.roots()).toEqual(["r"]);
      if (backend === "auto") {
        expect(h.node("r").layout!.width).toBe(800);
        expect(h.node("r").layout!.height).toBe(600);
      }
      expect(h.hitTest(10, 500)?.id).toBe("r");
    });
  });
}

suite("fallback");
suite("auto");

describe("canvas multi-root accessibility mirror and focus", () => {
  function overlay(): FakeElement {
    const body = (document as any).body as FakeElement;
    const root = body.children.find((el: FakeElement) => "data-hypen-a11y-overlay" in el.attributes);
    if (!root) throw new Error("no a11y overlay mounted");
    return root;
  }
  function mirrorEl(id: string): FakeElement | undefined {
    const find = (el: FakeElement): FakeElement | undefined => {
      if (el.attributes["data-hypen-id"] === id) return el;
      for (const child of el.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(overlay());
  }
  function makeCanvas(): any {
    const canvas: any = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = new MockContext();
    canvas.getContext = (type: string) => (type === "2d" ? ctx : null);
    canvas.getBoundingClientRect = () => ({
      width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0,
    });
    return canvas;
  }

  beforeEach(() => ensureFakeDomGlobals());

  test("mirror order follows root order; positions sync for every root; focus works on a later root", () => {
    const h = harness({ a11y: true, canvas: makeCanvas() });
    h.renderer.applyPatches([
      create("a", "Button", { height: 100, onClick: "@actions.a" }), insert("root", "a"),
      create("c", "Button", { height: 100, onClick: "@actions.c" }), insert("root", "c"),
    ]);
    h.renderer.applyPatches([
      create("b", "Button", { height: 100, onClick: "@actions.b" }), insert("root", "b", "c"),
    ]);
    const ids = overlay().children.map((el: FakeElement) => el.attributes["data-hypen-id"]);
    expect(ids).toEqual(["a", "b", "c"]);
    expect((mirrorEl("c")!.style as any).top).toBe("200px");

    mirrorEl("c")!.focus();
    expect(h.node("c").focused).toBe(true);

    // Re-enabling the mirror rebuilds from every root, in order.
    h.renderer.setOptions({ enableAccessibility: false });
    h.renderer.setOptions({ enableAccessibility: true });
    const rebuilt = overlay().children.map((el: FakeElement) => el.attributes["data-hypen-id"]);
    expect(rebuilt).toEqual(["a", "b", "c"]);
    expect((mirrorEl("b")!.style as any).top).toBe("100px");
  });
});
