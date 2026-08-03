/**
 * Canvas Accessibility Mirror Tests
 *
 * The mirror is a transparent positioned overlay above the canvas (screen
 * reader browse modes are geometry-driven, so elements need real boxes) and
 * is synced incrementally from the patch stream. The load-bearing
 * guarantee: mirror elements keep their identity across patches — a screen
 * reader's virtual cursor or keyboard focus must survive reactive updates,
 * including router detach/attach cycles.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

class MockContext {
  fillStyle = "#000";
  strokeStyle = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  save() {}
  restore() {}
  scale() {}
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
  fill() {}
  stroke() {}
  clip() {}
  rect() {}
  setLineDash() {}
  drawImage() {}
}

function makeCanvas(): any {
  const canvas: any = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  const ctx = new MockContext();
  canvas.getContext = (type: string) => (type === "2d" ? ctx : null);
  canvas.getBoundingClientRect = () => ({
    width: 800,
    height: 600,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
  });
  return canvas;
}

const engine = { dispatchAction() {} };

function create(id: string, elementType: string, props: Record<string, any> = {}): Patch {
  return { type: "create", id, elementType, props } as any;
}
function insert(parentId: string, id: string, beforeId?: string): Patch {
  return { type: "insert", parentId, id, beforeId } as any;
}

/** The mirror root is the transparent overlay mounted on document.body. */
function mirrorRoot(_canvas?: any): FakeElement {
  const body = (document as any).body as FakeElement;
  const root = body.children.find(
    (el: FakeElement) => "data-hypen-a11y-overlay" in el.attributes,
  );
  if (!root) throw new Error("no a11y overlay mounted");
  return root;
}
function mirrorEl(canvas: any, id: string): FakeElement | undefined {
  const find = (el: FakeElement): FakeElement | undefined => {
    if (el.attributes["data-hypen-id"] === id) return el;
    for (const child of el.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(mirrorRoot(canvas));
}

describe("canvas accessibility mirror", () => {
  let canvas: any;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    ensureFakeDomGlobals();
    canvas = makeCanvas();
    renderer = new CanvasRenderer(canvas, engine as any, {
      devicePixelRatio: 1,
      enableAccessibility: true,
    });
  });

  test("mounts a transparent positioned overlay; canvas is aria-hidden", () => {
    const root = mirrorRoot(canvas);
    expect(root).toBeDefined();
    // Deliberately roleless: role="application" would switch screen
    // readers out of virtual-cursor mode (arrow-key browsing breaks).
    expect("role" in root.attributes).toBe(false);
    expect((root.style as any).position).toBe("absolute");
    expect((root.style as any).pointerEvents).toBe("none");
    // Semantics live in the overlay; the bitmap element stays out of AT.
    expect(canvas.attributes["aria-hidden"]).toBe("true");
  });

  test("elements get their painted bounds after a render", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("b1", "button"),
      insert("root", "b1"),
    ]);

    const el = mirrorEl(canvas, "b1")! as any;
    expect(el.style.position).toBe("absolute");
    // Layout ran synchronously (no rAF in tests) and syncPositions wrote
    // pixel boxes — exact values depend on the layout engine; assert shape.
    expect(String(el.style.width)).toEndWith("px");
    expect(String(el.style.height)).toEndWith("px");
  });

  test("create+insert builds semantic mirror elements in tree order", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("t1", "text", { 0: "Hello" }),
      insert("root", "t1"),
      create("b1", "button"),
      insert("root", "b1"),
    ]);

    const rootEl = mirrorEl(canvas, "root")!;
    expect(rootEl.tagName).toBe("DIV");
    expect(rootEl.children.map((c) => c.attributes["data-hypen-id"])).toEqual(["t1", "b1"]);
    expect(mirrorEl(canvas, "t1")!.tagName).toBe("SPAN");
    expect(mirrorEl(canvas, "t1")!.textContent).toBe("Hello");
    expect(mirrorEl(canvas, "b1")!.tagName).toBe("BUTTON");
  });

  test("insert honors beforeId; unknown beforeId appends", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("a", "text", { 0: "a" }),
      insert("root", "a"),
      create("b", "text", { 0: "b" }),
      insert("root", "b", "a"),
      create("c", "text", { 0: "c" }),
      insert("root", "c", "nonexistent"),
    ]);

    const order = mirrorEl(canvas, "root")!.children.map(
      (c) => c.attributes["data-hypen-id"],
    );
    expect(order).toEqual(["b", "a", "c"]);
  });

  test("element identity survives setText and setProp patches", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("t1", "text", { 0: "before" }),
      insert("root", "t1"),
    ]);
    const before = mirrorEl(canvas, "t1")!;

    renderer.applyPatches([
      { type: "setText", id: "t1", text: "after" } as any,
      { type: "setProp", id: "t1", name: "color", value: "red" } as any,
    ]);

    const after = mirrorEl(canvas, "t1")!;
    expect(after).toBe(before);
    expect(after.textContent).toBe("after");
  });

  test("element identity survives an unrelated patch batch (no rebuild)", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("b1", "button"),
      insert("root", "b1"),
    ]);
    const button = mirrorEl(canvas, "b1")!;

    renderer.applyPatches([
      create("t9", "text", { 0: "new sibling" }),
      insert("root", "t9"),
    ]);

    expect(mirrorEl(canvas, "b1")).toBe(button);
  });

  test("move reorders the same element", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("a", "text", { 0: "a" }),
      insert("root", "a"),
      create("b", "text", { 0: "b" }),
      insert("root", "b"),
    ]);
    const a = mirrorEl(canvas, "a")!;

    renderer.applyPatches([{ type: "move", parentId: "root", id: "b", beforeId: "a" } as any]);

    const order = mirrorEl(canvas, "root")!.children.map(
      (c) => c.attributes["data-hypen-id"],
    );
    expect(order).toEqual(["b", "a"]);
    expect(mirrorEl(canvas, "a")).toBe(a);
  });

  test("remove drops the element", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("t1", "text", { 0: "x" }),
      insert("root", "t1"),
    ]);
    renderer.applyPatches([{ type: "remove", id: "t1" } as any]);

    expect(mirrorEl(canvas, "t1")).toBeUndefined();
  });

  test("detach keeps the element alive; attach reinserts the SAME element", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("page", "column"),
      insert("root", "page"),
      create("b1", "button"),
      insert("page", "b1"),
    ]);
    const page = mirrorEl(canvas, "page")!;
    const button = mirrorEl(canvas, "b1")!;

    renderer.applyPatches([{ type: "detach", id: "page" } as any]);
    expect(mirrorEl(canvas, "page")).toBeUndefined(); // out of the tree
    // ...but the subtree is intact, awaiting re-attach
    expect(page.children[0]).toBe(button);

    renderer.applyPatches([{ type: "attach", parentId: "root", id: "page" } as any]);
    expect(mirrorEl(canvas, "page")).toBe(page);
    expect(mirrorEl(canvas, "b1")).toBe(button);
  });

  test("focusable nodes get tabIndex 0", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("b1", "Button"),
      insert("root", "b1"),
      create("i1", "Input", { placeholder: "name" }),
      insert("root", "i1"),
    ]);

    expect((mirrorEl(canvas, "b1") as any).tabIndex).toBe(0);
    expect((mirrorEl(canvas, "i1") as any).tabIndex).toBe(0);
    expect((mirrorEl(canvas, "i1") as any).placeholder).toBe("name");
  });

  test("semantics.hidden hides via display:none instead of omission", () => {
    renderer.applyPatches([
      { type: "create", id: "root", elementType: "column", props: {} } as any,
      insert("root", "root"),
      {
        type: "create",
        id: "deco",
        elementType: "image",
        props: {},
        semantics: { hidden: true },
      } as any,
      insert("root", "deco"),
      create("t1", "text", { 0: "visible" }),
      insert("root", "t1"),
    ]);

    const deco = mirrorEl(canvas, "deco")!;
    expect((deco.style as any).display).toBe("none");
    // Sibling order in the mirror still matches the virtual tree exactly.
    const order = mirrorEl(canvas, "root")!.children.map(
      (c) => c.attributes["data-hypen-id"],
    );
    expect(order).toEqual(["deco", "t1"]);
  });

  test("input value updates flow to the mirror without recreating it", () => {
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("i1", "Input", { value: "a" }),
      insert("root", "i1"),
    ]);
    const input = mirrorEl(canvas, "i1")! as any;
    expect(input.value).toBe("a");

    renderer.applyPatches([{ type: "setProp", id: "i1", name: "value", value: "ab" } as any]);
    expect(mirrorEl(canvas, "i1")).toBe(input);
    expect(input.value).toBe("ab");
  });
});
