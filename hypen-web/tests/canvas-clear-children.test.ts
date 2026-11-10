/**
 * Canvas renderer — the `clearChildren` patch (docs/clear-children.md).
 *
 * `{ type: "clearChildren", id }` is exactly a plain `remove` (no
 * transition) of each current child of `id`: every child subtree is torn
 * down (id table, animator, a11y mirror), `id` keeps its props and can be
 * refilled in the same batch, an unknown id is a no-op. Synthetic batches:
 * the checked-in WASM engine predates the patch.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

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
  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  setPointerCapture() {}
  get parentElement() {
    return { appendChild: () => {} };
  }
}

const engine = { dispatchAction() {}, setListViewport() {} };

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string): Patch => ({ type: "insert", parentId, id }) as any;
const remove = (id: string, transition?: boolean): Patch =>
  ({ type: "remove", id, ...(transition ? { transition: true } : {}) }) as any;
const clearChildren = (id: string): Patch => ({ type: "clearChildren", id }) as any;

function harness(canvas: any = new MockCanvas(), a11y = false) {
  const renderer = new CanvasRenderer(canvas, engine as any, {
    devicePixelRatio: 1,
    enableAccessibility: a11y,
  });
  const node = (id: string) => renderer.getNode(id) as VirtualNode | undefined;
  const kids = (id: string) => node(id)!.children.map((n) => n.id);
  return { renderer, node, kids };
}

/** root > list(gap) > rows r0..r{n-1}, each row with one Text child. */
function mountList(renderer: CanvasRenderer, n: number) {
  const patches: Patch[] = [
    create("root", "Column"),
    insert("root", "root"),
    create("header", "Text", { 0: "header" }),
    insert("root", "header"),
    create("list", "Column", { gap: 4 }),
    insert("root", "list"),
  ];
  for (let i = 0; i < n; i++) {
    patches.push(create(`r${i}`, "Row"), insert("list", `r${i}`));
    patches.push(create(`r${i}t`, "Text", { 0: `row ${i}` }), insert(`r${i}`, `r${i}t`));
  }
  renderer.applyPatches(patches);
}

describe("canvas clearChildren", () => {
  test("tears down every child subtree and keeps the element with its props", () => {
    const h = harness();
    mountList(h.renderer, 3);
    const list = h.node("list")!;
    const r1 = h.node("r1")!;
    expect(h.kids("list")).toEqual(["r0", "r1", "r2"]);

    h.renderer.applyPatches([clearChildren("list")]);

    expect(h.node("list")).toBe(list);
    expect(list.props.gap).toBe(4);
    expect(list.children).toEqual([]);
    for (const id of ["r0", "r0t", "r1", "r1t", "r2", "r2t"]) expect(h.node(id)).toBeUndefined();
    expect(r1.parent).toBeNull();
    // Siblings of the cleared element are untouched.
    expect(h.kids("root")).toEqual(["header", "list"]);
  });

  test("clear then refill in the same batch", () => {
    const h = harness();
    mountList(h.renderer, 4);
    h.renderer.applyPatches([
      clearChildren("list"),
      create("n0", "Row"),
      insert("list", "n0"),
      create("n1", "Row"),
      insert("list", "n1"),
    ]);
    expect(h.kids("list")).toEqual(["n0", "n1"]);
    expect(h.node("r0")).toBeUndefined();
    expect(h.node("n1")!.parent).toBe(h.node("list")!);
  });

  test("unknown id and an already-empty element are no-ops", () => {
    const h = harness();
    mountList(h.renderer, 2);
    h.renderer.applyPatches([clearChildren("nope")]);
    expect(h.kids("list")).toEqual(["r0", "r1"]);
    h.renderer.applyPatches([clearChildren("r0t")]);
    expect(h.node("r0t")).toBeDefined();
  });

  test("a large list clears in one pass", () => {
    const h = harness();
    mountList(h.renderer, 2000);
    h.renderer.applyPatches([clearChildren("list")]);
    expect(h.node("list")!.children.length).toBe(0);
    expect(h.node("r1999t")).toBeUndefined();
  });

  test("cuts short a child still playing an exit from an earlier flagged remove", () => {
    const h = harness();
    const exit = { presets: ["fade"], duration: 1000, curve: "linear" };
    h.renderer.applyPatches([create("root", "Column"), insert("root", "root")]);
    h.renderer.applyPatches([
      create("list", "Column"),
      insert("root", "list"),
      create("a", "Row", { "__anim.exit": exit }),
      insert("list", "a"),
      create("b", "Row"),
      insert("list", "b"),
      create("c", "Row"),
      insert("list", "c"),
    ]);
    h.renderer.getAnimator().manualFrameDriver = true;
    h.renderer.applyPatches([remove("a", true)]);
    expect(h.node("a")?.exiting).toBe(true);

    h.renderer.applyPatches([clearChildren("list")]);
    expect(h.node("list")!.children).toEqual([]);
    for (const id of ["a", "b", "c"]) expect(h.node(id)).toBeUndefined();
  });
});

describe("canvas clearChildren accessibility mirror", () => {
  beforeEach(() => ensureFakeDomGlobals());

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
  function mirrorEl(id: string): FakeElement | undefined {
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

  test("drops the mirror elements of every cleared row, keeps the container's", () => {
    const h = harness(makeCanvas(), true);
    h.renderer.applyPatches([
      create("list", "Column"),
      insert("root", "list"),
      create("b1", "Button", { onClick: "@actions.a" }),
      insert("list", "b1"),
      create("b2", "Button", { onClick: "@actions.b" }),
      insert("list", "b2"),
    ]);
    expect(mirrorEl("b1")).toBeDefined();
    expect(mirrorEl("b2")).toBeDefined();

    h.renderer.applyPatches([clearChildren("list")]);
    expect(mirrorEl("b1")).toBeUndefined();
    expect(mirrorEl("b2")).toBeUndefined();
    expect(h.node("list")).toBeDefined();
  });
});
