/**
 * Canvas: Heading painting/measuring and Image corner clipping.
 *
 * - A bare `Heading("Title", level: n)` used to fall through to the
 *   container painter (no glyphs) and measure 0×0, so section titles were
 *   missing on /canvas.
 * - Image clipping only honoured the uniform radius; per-corner radii
 *   (`rounded-t-xl` → `borderTopLeftRadius`/`borderTopRightRadius`, or the
 *   object form `.borderRadius(topLeft: …)`) left the image square. The
 *   image's own border was never stroked either.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { paintNode, resolveCornerRadii } from "../packages/web/src/canvas/paint.js";
import { computeLayout, initTaffyLayout, setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

class MockCtx {
  calls: Array<{ method: string; args: any[]; font?: string; strokeStyle?: any }> = [];
  fillStyle: any = "#000";
  strokeStyle: any = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  canvas = { dispatchEvent() {} };
  private rec(method: string, ...args: any[]) {
    this.calls.push({ method, args, font: this.font, strokeStyle: this.strokeStyle });
  }
  save() { this.rec("save"); }
  restore() { this.rec("restore"); }
  fillRect(...a: any[]) { this.rec("fillRect", ...a); }
  strokeRect(...a: any[]) { this.rec("strokeRect", ...a); }
  fillText(...a: any[]) { this.rec("fillText", ...a); }
  measureText(text: string) { return { width: text.length * 8 }; }
  beginPath() { this.rec("beginPath"); }
  closePath() { this.rec("closePath"); }
  moveTo(...a: any[]) { this.rec("moveTo", ...a); }
  lineTo(...a: any[]) { this.rec("lineTo", ...a); }
  arcTo(...a: any[]) { this.rec("arcTo", ...a); }
  arc(...a: any[]) { this.rec("arc", ...a); }
  rect(...a: any[]) { this.rec("rect", ...a); }
  fill() { this.rec("fill"); }
  stroke() { this.rec("stroke"); }
  clip() { this.rec("clip"); }
  setLineDash() {}
  drawImage(...a: any[]) { this.rec("drawImage", ...a); }
  count(m: string) { return this.calls.filter((c) => c.method === m).length; }
}

function makeNode(type: string, props: Record<string, any>, layout?: Partial<VirtualNode["layout"]>): VirtualNode {
  return {
    id: `${type}-${Math.random()}`,
    type,
    props,
    children: [],
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
    layout: layout
      ? {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 100,
          ...layout,
        } as any
      : undefined,
  } as VirtualNode;
}

describe("Canvas Heading", () => {
  test("a bare Heading paints its text at the level's default size and bold weight", () => {
    const ctx = new MockCtx();
    const node = makeNode("Heading", { 0: "Most read", level: 1, color: "#111" }, { width: 300, height: 40 });
    paintNode(ctx as any, node);
    const fills = ctx.calls.filter((c) => c.method === "fillText");
    expect(fills.map((c) => c.args[0]).join("")).toContain("Most read");
    expect(fills[0]!.font).toContain("bold");
    expect(fills[0]!.font).toContain("32px");
  });

  test("level 2 is the default and maps to 24px; named `text` works too", () => {
    const ctx = new MockCtx();
    const node = makeNode("heading", { text: "Section" }, { width: 300, height: 40 });
    paintNode(ctx as any, node);
    const fills = ctx.calls.filter((c) => c.method === "fillText");
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0]!.font).toContain("24px");
  });

  test("an explicit fontSize overrides the level default", () => {
    const ctx = new MockCtx();
    const node = makeNode("Heading", { 0: "Big", level: 3, fontSize: 40 }, { width: 300, height: 60 });
    paintNode(ctx as any, node);
    expect(ctx.calls.find((c) => c.method === "fillText")!.font).toContain("40px");
  });

  test("a Heading with children paints only its box; children paint themselves", () => {
    const ctx = new MockCtx();
    const heading = makeNode("Heading", { level: 1 }, { width: 300, height: 40 });
    const child = makeNode("Text", { 0: "Inner" }, { width: 300, height: 40 });
    child.parent = heading;
    heading.children = [child];
    paintNode(ctx as any, heading);
    const fills = ctx.calls.filter((c) => c.method === "fillText");
    expect(fills.map((c) => c.args[0]).join("")).toBe("Inner");
    // inherited from the heading
    expect(fills[0]!.font).toContain("32px");
  });

  for (const backend of ["fallback", "auto"] as const) {
    describe(`layout (${backend})`, () => {
      beforeAll(async () => {
        if (backend === "auto") await initTaffyLayout();
        setLayoutBackend(backend);
      });
      afterAll(() => setLayoutBackend("auto"));

      test("a bare Heading measures a non-empty box sized by its level", () => {
        const ctx = new MockCtx();
        const root = makeNode("Column", { width: 400, height: 400 });
        const h1 = makeNode("Heading", { 0: "Title", level: 1 });
        const h4 = makeNode("Heading", { 0: "Title", level: 4 });
        const after = makeNode("Text", { 0: "Body" });
        for (const c of [h1, h4, after]) c.parent = root;
        root.children = [h1, h4, after];
        computeLayout(ctx as any, root, 400, 400);
        expect(h1.layout!.width).toBeGreaterThan(0);
        expect(h1.layout!.height).toBeGreaterThanOrEqual(32);
        expect(h4.layout!.height).toBeGreaterThanOrEqual(16);
        expect(h4.layout!.height).toBeLessThan(h1.layout!.height);
        // Siblings flow below the heading instead of overlapping it.
        expect(h4.layout!.y).toBeGreaterThanOrEqual(h1.layout!.y + h1.layout!.height - 0.5);
        expect(after.layout!.y).toBeGreaterThanOrEqual(h4.layout!.y + h4.layout!.height - 0.5);
      });
    });
  }
});

describe("Canvas Image corner radii", () => {
  // paintImage starts a load for an uncached src; give it an inert Image.
  const g = globalThis as any;
  const hadImage = "Image" in g;
  const prevImage = g.Image;
  beforeAll(() => {
    g.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
    };
  });
  afterAll(() => {
    if (hadImage) g.Image = prevImage;
    else delete g.Image;
  });

  test("resolveCornerRadii keeps the uniform number when no corner is overridden", () => {
    expect(resolveCornerRadii({ borderRadius: 12 }, 12)).toBe(12);
    expect(resolveCornerRadii({}, 0)).toBe(0);
  });

  test("resolveCornerRadii reads directional longhands and the object form", () => {
    expect(resolveCornerRadii({ borderTopLeftRadius: "0.75rem", borderTopRightRadius: "12px" }, 0))
      .toEqual([12, 12, 0, 0]);
    expect(resolveCornerRadii({ borderRadius: 8, borderBottomLeftRadius: 0 }, 8)).toEqual([8, 8, 8, 0]);
    expect(resolveCornerRadii({ cornerRadius: { topLeft: 10, bottomRight: 4 } }, 0)).toEqual([10, 0, 4, 0]);
    expect(resolveCornerRadii({ borderRadius: { topStart: 6, bottomEnd: 2 } }, 0)).toEqual([6, 0, 2, 0]);
  });

  test("uniform radius still clips the image to a rounded rect", () => {
    const ctx = new MockCtx();
    const node = makeNode("Image", { src: "x.png", borderRadius: 20 }, {
      border: { width: 0, color: "transparent", radius: 20 },
    });
    paintNode(ctx as any, node);
    expect(ctx.count("clip")).toBe(1);
    expect(ctx.count("arcTo")).toBe(4);
  });

  test("per-corner radii (rounded-t-*) clip the image's top corners only", () => {
    const ctx = new MockCtx();
    const node = makeNode("Image", {
      src: "y.png",
      borderTopLeftRadius: "16px",
      borderTopRightRadius: "16px",
    }, {});
    paintNode(ctx as any, node);
    expect(ctx.count("clip")).toBe(1);
    const arcs = ctx.calls.filter((c) => c.method === "arcTo");
    expect(arcs.length).toBe(2);
    expect(arcs.every((c) => c.args[4] === 16)).toBe(true);
  });

  test("the object form .cornerRadius(topLeft:, …) clips the image", () => {
    const ctx = new MockCtx();
    const node = makeNode("Image", { src: "z.png", cornerRadius: { topLeft: 10, bottomRight: 10 } }, {});
    paintNode(ctx as any, node);
    expect(ctx.count("clip")).toBe(1);
    expect(ctx.count("arcTo")).toBe(2);
  });

  test("an Image border is stroked along the rounded outline after the clip closes", () => {
    const ctx = new MockCtx();
    const node = makeNode("Image", { src: "w.png", borderRadius: 12, borderColor: "#123456" }, {
      border: { width: 1, color: "#123456", radius: 12 },
    });
    paintNode(ctx as any, node);
    const strokeIdx = ctx.calls.findIndex((c) => c.method === "stroke" && c.strokeStyle === "#123456");
    expect(strokeIdx).toBeGreaterThan(-1);
    const clipIdx = ctx.calls.findIndex((c) => c.method === "clip");
    const restoreAfterClip = ctx.calls.findIndex((c, i) => i > clipIdx && c.method === "restore");
    expect(restoreAfterClip).toBeLessThan(strokeIdx);
  });

  test("containers honour per-corner radii too", () => {
    const ctx = new MockCtx();
    const node = makeNode("Column", { backgroundColor: "#f00", borderTopLeftRadius: 8 }, {});
    paintNode(ctx as any, node);
    expect(ctx.count("fill")).toBe(1);
    expect(ctx.count("arcTo")).toBe(1);
  });
});
