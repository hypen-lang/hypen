import { semanticAction } from "./helpers";
/**
 * Canvas Native Text Editing Tests
 *
 * Focus lands on the mirror <input> (canvas fallback content) but the
 * browser edits in the hidden IME proxy textarea — fallback content has no
 * layout box, so engines won't run text editing there. The canvas paints
 * value, selection, and caret from the proxy's state. These tests drive
 * the proxy the way a browser would (input/composition events +
 * value/selection mutation) and assert the resulting state, engine
 * dispatches, and paint calls.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

/** Recording 2D context: len*8 measureText + a call log for paint checks. */
class MockContext {
  fillStyle: any = "#000";
  strokeStyle: any = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  calls: Array<{ method: string; args: any[] }> = [];

  private log(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }
  save() {}
  restore() {}
  scale() {}
  fillRect(...args: any[]) {
    this.log("fillRect", ...args);
  }
  strokeRect() {}
  clearRect() {}
  fillText(...args: any[]) {
    this.log("fillText", ...args);
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
  fill() {}
  stroke() {}
  clip() {
    this.log("clip");
  }
  rect() {}
  setLineDash() {}
  drawImage() {}
}

function makeCanvas(ctx: MockContext): any {
  const canvas: any = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
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
    this.actions.push(semanticAction(name, payload));
  }
  binds() {
    return this.actions.filter((a) => a.name === "__hypen_bind");
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

describe("canvas native text editing", () => {
  let ctx: MockContext;
  let canvas: any;
  let engine: RecordingEngine;
  let renderer: CanvasRenderer;
  let input: FakeElement;

  function editor(): any {
    return (renderer as any).textEditor;
  }

  beforeEach(() => {
    ensureFakeDomGlobals();
    ctx = new MockContext();
    canvas = makeCanvas(ctx);
    engine = new RecordingEngine();
    renderer = new CanvasRenderer(canvas, engine as any, {
      devicePixelRatio: 1,
      enableAccessibility: true,
    });
    editor().blinkIntervalMs = 0; // no timers in tests

    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("i1", "Input", { value: "hi", bind: "form.name" }),
      insert("root", "i1"),
    ]);
    input = mirrorEl(canvas, "i1");
  });

  /** The hidden IME proxy — the element the browser actually edits. */
  function proxy(): FakeElement {
    return editor().getProxyElement() as FakeElement;
  }

  function type(value: string, caret: number) {
    const p = proxy();
    (p as any).value = value;
    (p as any).selectionStart = caret;
    (p as any).selectionEnd = caret;
    p.dispatchEvent("input", { target: p });
  }

  test("focusing the mirror input starts an edit session on the IME proxy", () => {
    input.focus();

    const state = editor().getStateFor(renderer.getNode("i1"));
    expect(state).not.toBeNull();
    expect(state.value).toBe("hi"); // seeded from props.value
    // Keyboard focus is handed to the proxy; node.focused stays true.
    expect((document as any).activeElement).toBe(proxy());
    expect(renderer.getNode("i1")!.focused).toBe(true);
  });

  test("typing updates props.value and dispatches __hypen_bind with the bind path", () => {
    input.focus();
    type("hi!", 3);

    expect(renderer.getNode("i1")!.props.value).toBe("hi!");
    const binds = engine.binds();
    expect(binds).toHaveLength(1);
    expect(binds[0].payload).toEqual({ path: "form.name", value: "hi!" });
  });

  test("engine echo of the same value leaves the element (and caret) alone", () => {
    input.focus();
    type("hi!", 1); // caret deliberately mid-string

    renderer.applyPatches([
      { type: "setProp", id: "i1", name: "value", value: "hi!" } as any,
    ]);

    expect((proxy() as any).value).toBe("hi!");
    expect((proxy() as any).selectionStart).toBe(1);
    // The mirror input (AT surface) also carries the confirmed value.
    expect((input as any).value).toBe("hi!");
  });

  test("engine rewrite (formatting) re-seeds the element and clamps selection", () => {
    input.focus();
    type("hi there", 8);

    renderer.applyPatches([
      { type: "setProp", id: "i1", name: "value", value: "HI" } as any,
    ]);

    expect((proxy() as any).value).toBe("HI");
    expect((proxy() as any).selectionStart).toBe(2); // clamped to new length
    expect(editor().getStateFor(renderer.getNode("i1")).value).toBe("HI");
  });

  test("IME composition suppresses bind dispatch until compositionend", () => {
    input.focus();
    proxy().dispatchEvent("compositionstart", { target: proxy() });
    type("hiか", 3);
    expect(engine.binds()).toHaveLength(0); // mid-composition: no bind

    proxy().dispatchEvent("compositionend", { target: proxy() });
    const binds = engine.binds();
    expect(binds).toHaveLength(1);
    expect(binds[0].payload.value).toBe("hiか");
    expect(renderer.getNode("i1")!.props.value).toBe("hiか");
  });

  test("Enter on a single-line input blurs and ends the session", () => {
    input.focus();
    expect(editor().isActive()).toBe(true);

    proxy().dispatchEvent("keydown", {
      target: proxy(),
      key: "Enter",
      preventDefault() {},
    });

    expect(editor().isActive()).toBe(false);
    expect(renderer.getNode("i1")!.focused).toBe(false);
    expect((document as any).activeElement).toBe(null);
  });

  test("focus moving away ends the session", () => {
    input.focus();
    expect(editor().isActive()).toBe(true);

    proxy().blur();
    expect(editor().isActive()).toBe(false);
    expect(renderer.getNode("i1")!.focused).toBe(false);
  });

  test("pointer caret placement: far-right click puts the caret at the end", () => {
    input.focus();
    const node = renderer.getNode("i1")!;
    editor().placeCaretFromPoint(node, { x: 9999, y: 10 });
    expect((proxy() as any).selectionStart).toBe("hi".length);

    editor().placeCaretFromPoint(node, { x: -9999, y: 10 });
    expect((proxy() as any).selectionStart).toBe(0);
  });

  test("while editing, paint clips the box and draws the caret", () => {
    input.focus();
    ctx.calls.length = 0;
    type("hi!", 3);

    expect(ctx.calls.some((c) => c.method === "clip")).toBe(true);
    // Caret: the only 1.5px-wide fillRect.
    expect(ctx.calls.some((c) => c.method === "fillRect" && c.args[2] === 1.5)).toBe(true);
  });

  test("selection ranges paint a highlight instead of a caret", () => {
    input.focus();
    (proxy() as any).value = "hi!";
    (proxy() as any).selectionStart = 0;
    (proxy() as any).selectionEnd = 3;
    proxy().dispatchEvent("select", { target: proxy() });

    ctx.calls.length = 0;
    (renderer as any).render();

    const caret = ctx.calls.filter((c) => c.method === "fillRect" && c.args[2] === 1.5);
    expect(caret).toHaveLength(0);
    // Highlight: a fillRect spanning 3 chars * 8px = 24px.
    expect(ctx.calls.some((c) => c.method === "fillRect" && c.args[2] === 24)).toBe(true);
  });

  test("removing the edited subtree ends the session", () => {
    input.focus();
    expect(editor().isActive()).toBe(true);

    renderer.applyPatches([{ type: "remove", id: "i1" } as any]);
    expect(editor().isActive()).toBe(false);
  });
});
