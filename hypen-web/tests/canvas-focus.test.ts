/**
 * Canvas Focus Bridge Tests
 *
 * DOM focus on mirror elements (canvas fallback content) is the single
 * source of truth for canvas focus. Keyboard focus (element.focus(), as Tab
 * would produce), the pointer path (FocusManager.requestFocus), and
 * keyboard/AT activation must all flow through the same state.
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

class RecordingEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any) {
    this.actions.push({ name, payload });
  }
}

function create(id: string, elementType: string, props: Record<string, any> = {}): Patch {
  return { type: "create", id, elementType, props } as any;
}
function insert(parentId: string, id: string, beforeId?: string): Patch {
  return { type: "insert", parentId, id, beforeId } as any;
}

function mirrorEl(canvas: any, id: string): FakeElement {
  const find = (el: FakeElement): FakeElement | undefined => {
    if (el.attributes["data-hypen-id"] === id) return el;
    for (const child of el.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return undefined;
  };
  const body = (document as any).body as FakeElement;
  const overlay = body.children.find(
    (el: FakeElement) => "data-hypen-a11y-overlay" in el.attributes,
  );
  if (!overlay) throw new Error("no a11y overlay mounted");
  const found = find(overlay);
  if (!found) throw new Error(`no mirror element for ${id}`);
  return found;
}

describe("canvas focus bridge", () => {
  let canvas: any;
  let engine: RecordingEngine;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    ensureFakeDomGlobals();
    canvas = makeCanvas();
    engine = new RecordingEngine();
    renderer = new CanvasRenderer(canvas, engine as any, {
      devicePixelRatio: 1,
      enableAccessibility: true,
    });
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("b1", "Button", { onClick: "@actions.save", onKeyDown: "@actions.keys" }),
      insert("root", "b1"),
      create("b2", "Button", { onClick: "@actions.cancel" }),
      insert("root", "b2"),
      create("i1", "Input", { value: "hi" }),
      insert("root", "i1"),
    ]);
  });

  test("DOM focus on a mirror element drives node.focused (Tab path)", () => {
    mirrorEl(canvas, "b1").focus();
    expect(renderer.getNode("b1")!.focused).toBe(true);

    // Focus moving to a sibling clears the previous node.
    mirrorEl(canvas, "b2").focus();
    expect(renderer.getNode("b1")!.focused).toBe(false);
    expect(renderer.getNode("b2")!.focused).toBe(true);
  });

  test("blur (focus leaving the mirror) clears node.focused", () => {
    mirrorEl(canvas, "b1").focus();
    expect(renderer.getNode("b1")!.focused).toBe(true);

    mirrorEl(canvas, "b1").blur();
    expect(renderer.getNode("b1")!.focused).toBe(false);
  });

  test("pointer path focuses through the mirror (single focus truth)", () => {
    const fm = (renderer as any).focusManager;

    // Non-editable: DOM focus rests on the mirror element itself.
    fm.requestFocus(renderer.getNode("b1"));
    expect((document as any).activeElement).toBe(mirrorEl(canvas, "b1"));
    expect(fm.getFocusedNode()!.id).toBe("b1");

    // Editable: focus is handed to the IME proxy, node stays focused.
    fm.requestFocus(renderer.getNode("i1"));
    const proxy = (renderer as any).textEditor.getProxyElement();
    expect((document as any).activeElement).toBe(proxy);
    expect(renderer.getNode("i1")!.focused).toBe(true);
    expect(fm.getFocusedNode()!.id).toBe("i1");
  });

  test("pointer on nothing focusable blurs the mirror and clears state", () => {
    const fm = (renderer as any).focusManager;
    fm.requestFocus(renderer.getNode("b1"));
    expect(renderer.getNode("b1")!.focused).toBe(true);

    fm.requestFocus(null);
    expect(renderer.getNode("b1")!.focused).toBe(false);
    expect((document as any).activeElement).toBe(null);
  });

  test("mirror click (Enter/Space or AT activation) dispatches the node action", () => {
    const el = mirrorEl(canvas, "b1");
    el.bubbleEvent("click", { target: el });

    const action = engine.actions.find((a) => a.name === "save");
    expect(action).toBeDefined();
    expect(action!.payload.nodeId).toBe("b1");
    expect(action!.payload.type).toBe("click");
  });

  test("mirror keydown on the focused node dispatches onKeyDown", () => {
    const el = mirrorEl(canvas, "b1");
    el.focus();
    el.bubbleEvent("keydown", { target: el, key: "ArrowDown", code: "ArrowDown" });

    const action = engine.actions.find((a) => a.name === "keys");
    expect(action).toBeDefined();
    expect(action!.payload.key).toBe("ArrowDown");
    expect(action!.payload.nodeId).toBe("b1");
  });

  test("nodes without a matching action prop dispatch nothing on click", () => {
    const el = mirrorEl(canvas, "i1");
    el.bubbleEvent("click", { target: el });
    expect(engine.actions.filter((a) => a.payload?.type === "click")).toHaveLength(0);
  });
});
