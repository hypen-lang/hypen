/**
 * Canvas Tailwind paint coverage.
 *
 * Pins the paint-side halves of the layout work: a horizontally scrollable
 * rail must clip its overflowing children to the strip, a `display: none`
 * (`hidden`) node must not paint at all, and `tracking-[Xem]` must be
 * measured against the element's own font size rather than the root's.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { paintNode } from "../packages/web/src/canvas/paint.js";
import { normalizeAllApplicators } from "../packages/web/src/canvas/props.js";
import type { VirtualNode, Layout } from "../packages/web/src/canvas/types.js";

class MockCtx {
  calls: Array<{ method: string; args: any[] }> = [];
  fillStyle: any = "#000";
  strokeStyle = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  shadowColor = "transparent";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  canvas = { width: 800, height: 600 };

  private rec(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }
  save() { this.rec("save"); }
  restore() { this.rec("restore"); }
  fillRect(...a: any[]) { this.rec("fillRect", ...a); }
  strokeRect(...a: any[]) { this.rec("strokeRect", ...a); }
  clearRect(...a: any[]) { this.rec("clearRect", ...a); }
  fillText(...a: any[]) { this.rec("fillText", ...a); }
  measureText(text: string) { return { width: text.length * 8 }; }
  beginPath() { this.rec("beginPath"); }
  closePath() { this.rec("closePath"); }
  moveTo(...a: any[]) { this.rec("moveTo", ...a); }
  lineTo(...a: any[]) { this.rec("lineTo", ...a); }
  arcTo(...a: any[]) { this.rec("arcTo", ...a); }
  arc(...a: any[]) { this.rec("arc", ...a); }
  fill() { this.rec("fill"); }
  stroke() { this.rec("stroke"); }
  clip() { this.rec("clip"); }
  rect(...a: any[]) { this.rec("rect", ...a); }
  translate(...a: any[]) { this.rec("translate", ...a); }
  drawImage(...a: any[]) { this.rec("drawImage", ...a); }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }

  wasCalled(m: string) { return this.calls.some((c) => c.method === m); }
  countCalls(m: string) { return this.calls.filter((c) => c.method === m).length; }
  textsDrawn() {
    return this.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
  }
}

function boxLayout(x: number, y: number, width: number, height: number): Layout {
  return {
    x,
    y,
    width,
    height,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: width,
    contentHeight: height,
  };
}

function node(
  type: string,
  rawProps: Record<string, any>,
  layout: Layout,
  children: VirtualNode[] = [],
): VirtualNode {
  const props = { ...rawProps };
  normalizeAllApplicators(props);
  const n: VirtualNode = {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    props,
    children,
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
    layout,
  };
  for (const c of children) c.parent = n;
  return n;
}

describe("scrollable rail clipping", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = new MockCtx();
  });

  test("a .scrollable('horizontal') Row clips its children to the strip", () => {
    const rail = node(
      "Row",
      { "scrollable.0": "horizontal" },
      boxLayout(0, 100, 400, 200),
      [node("Column", { "backgroundColor.0": "#fff" }, boxLayout(600, 100, 160, 200))],
    );
    paintNode(ctx as any, rail);
    expect(ctx.wasCalled("clip")).toBe(true);
    const rects = ctx.calls.filter((c) => c.method === "rect").map((c) => c.args);
    expect(rects).toContainEqual([0, 100, 400, 200]);
  });

  test("a plain Row does not install a clip", () => {
    const row = node("Row", {}, boxLayout(0, 0, 400, 200), [
      node("Column", { "backgroundColor.0": "#fff" }, boxLayout(0, 0, 100, 100)),
    ]);
    paintNode(ctx as any, row);
    expect(ctx.wasCalled("clip")).toBe(false);
  });

  test("overflow-hidden still clips", () => {
    const box = node("Column", { "overflow.0": "hidden" }, boxLayout(5, 5, 100, 100), [
      node("Column", { "backgroundColor.0": "#fff" }, boxLayout(5, 5, 400, 400)),
    ]);
    paintNode(ctx as any, box);
    expect(ctx.wasCalled("clip")).toBe(true);
  });
});

describe("display:none is not painted", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = new MockCtx();
  });

  test("a hidden subtree draws nothing", () => {
    const hidden = node("Column", { "display.0": "none" }, boxLayout(0, 0, 0, 0), [
      node("Text", { 0: "invisible" }, boxLayout(0, 0, 100, 20)),
    ]);
    paintNode(ctx as any, hidden);
    expect(ctx.textsDrawn()).toEqual([]);
    expect(ctx.wasCalled("fillRect")).toBe(false);
  });

  test("a hidden child inside a painted parent is skipped, its sibling is not", () => {
    const parent = node("Column", {}, boxLayout(0, 0, 200, 100), [
      node("Text", { 0: "gone", "display.0": "none" }, boxLayout(0, 0, 100, 20)),
      node("Text", { 0: "kept" }, boxLayout(0, 0, 100, 20)),
    ]);
    paintNode(ctx as any, parent);
    expect(ctx.textsDrawn()).toContain("kept");
    expect(ctx.textsDrawn()).not.toContain("gone");
  });
});

describe("tracking (letter-spacing)", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = new MockCtx();
  });

  test("tracking-[0.2em] on text-2xl advances by 0.2 * 24px per glyph", () => {
    const text = node(
      "Text",
      {
        0: "AB",
        "fontSize.0": "1.5rem",
        "letterSpacing.0": "0.2em",
        "color.0": "#fff",
      },
      boxLayout(0, 0, 200, 40),
    );
    paintNode(ctx as any, text);
    const glyphs = ctx.calls.filter((c) => c.method === "fillText");
    expect(glyphs.length).toBe(2);
    // Advance = glyph width (mock: 8px) + 0.2em of 24px = 4.8.
    expect(glyphs[1].args[1] - glyphs[0].args[1]).toBeCloseTo(8 + 4.8, 5);
  });
});
