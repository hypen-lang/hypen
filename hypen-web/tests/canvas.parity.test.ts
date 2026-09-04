/**
 * Canvas parity with the other renderers.
 *
 * Two contracts the canvas was silently breaking:
 *
 * - `VisuallyHidden` — the standard sr-only wrapper (documented in
 *   hypen-docs/content/docs/guide/accessibility.mdx, implemented on DOM as a
 *   clipped span). The canvas had no handler at all, so the subtree PAINTED
 *   and reserved layout space — the exact inverse of the contract.
 * - `foregroundColor` — the registered text-colour applicator on Swift and
 *   Android. The canvas only ever inherited `color`, so a
 *   `.foregroundColor()` subtree painted black.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { computeLayout } from "../packages/web/src/canvas/layout.js";
import { paintNode } from "../packages/web/src/canvas/paint.js";
import { inheritedTextProp } from "../packages/web/src/canvas/utils.js";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { VirtualNode, Layout } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

// ---------------------------------------------------------------------------
// Virtual-tree helpers
// ---------------------------------------------------------------------------

function node(
  id: string,
  type: string,
  props: Record<string, any> = {},
  children: VirtualNode[] = [],
): VirtualNode {
  const n = {
    id,
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
  } as VirtualNode;
  for (const child of children) child.parent = n;
  return n;
}

/** A fully-formed box, so paint tests don't depend on the layout pass. */
function withLayout(n: VirtualNode, x: number, y: number, w: number, h: number): VirtualNode {
  n.layout = {
    x,
    y,
    width: w,
    height: h,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: w,
    contentHeight: h,
  } satisfies Layout;
  return n;
}

/**
 * Records every draw call and snapshots `fillStyle` at the moment of the
 * call — the colour a text run actually painted with is only observable
 * there, since `renderText` sets the field and immediately draws.
 */
class RecordingContext {
  calls: Array<{ method: string; args: any[]; fillStyle: any }> = [];

  fillStyle: any = "#000000";
  strokeStyle: any = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  shadowColor = "transparent";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;

  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args, fillStyle: this.fillStyle });
  }

  save() {}
  restore() {}
  scale() {}
  translate() {}
  rotate() {}
  fillRect(x: number, y: number, w: number, h: number) {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect() {
    this.record("strokeRect");
  }
  clearRect() {}
  fillText(text: string, x: number, y: number) {
    this.record("fillText", text, x, y);
  }
  strokeText(text: string) {
    this.record("strokeText", text);
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
  fill() {
    this.record("fill");
  }
  stroke() {
    this.record("stroke");
  }
  clip() {}
  rect() {}
  setLineDash() {}
  drawImage() {
    this.record("drawImage");
  }

  painted(text: string) {
    return this.calls.find((c) => c.method === "fillText" && c.args[0] === text);
  }
}

// ---------------------------------------------------------------------------
// VisuallyHidden — layout
// ---------------------------------------------------------------------------

describe("Canvas VisuallyHidden: layout", () => {
  /** `[wrapper, following sibling]` inside a fixed column. */
  const column = (wrapperType: string): VirtualNode => {
    const wrapper = node(
      "wrapper",
      wrapperType,
      {},
      [node("label", "container", { width: 20, height: 30 })],
    );
    const after = node("after", "container", { width: 20, height: 10 });
    return node("root", "column", { width: 400, height: 400 }, [wrapper, after]);
  };

  const layoutOf = (root: VirtualNode) => {
    computeLayout(new RecordingContext() as any, root, 400, 400, 0, 0);
    return root;
  };

  test("a VisuallyHidden wrapper reserves no space in the flow", () => {
    const root = layoutOf(column("VisuallyHidden"));
    // The next sibling starts at the column's content origin: the sr-only
    // subtree contributed nothing, exactly as `display: none` would.
    expect(root.children[1].layout!.y).toBeCloseTo(0, 0);
  });

  test("a plain wrapper with the same children DOES reserve space", () => {
    // Control: proves the assertion above is measuring the wrapper, not an
    // unrelated quirk of the fixture.
    const root = layoutOf(column("container"));
    expect(root.children[1].layout!.y).toBeCloseTo(30, 0);
  });

  test("the VisuallyHidden node itself collapses to a zero box", () => {
    const root = layoutOf(column("VisuallyHidden"));
    expect(root.children[0].layout!.width).toBe(0);
    expect(root.children[0].layout!.height).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VisuallyHidden — paint
// ---------------------------------------------------------------------------

describe("Canvas VisuallyHidden: paint", () => {
  /**
   * Boxes are written by hand so this exercises the paint pass alone — a
   * layout-only fix would otherwise be enough to make the tree draw nothing.
   */
  const tree = (wrapperType: string): VirtualNode => {
    const label = withLayout(
      node("label", "text", { 0: "Skip to content", backgroundColor: "#ff0000" }),
      0,
      0,
      200,
      20,
    );
    const wrapper = withLayout(node("wrapper", wrapperType, {}, [label]), 0, 0, 200, 20);
    const after = withLayout(node("after", "text", { 0: "Visible heading" }), 0, 20, 200, 20);
    return withLayout(node("root", "column", {}, [wrapper, after]), 0, 0, 400, 400);
  };

  test("nothing in the subtree paints", () => {
    const ctx = new RecordingContext();
    paintNode(ctx as any, tree("VisuallyHidden"));
    expect(ctx.painted("Skip to content")).toBeUndefined();
    expect(ctx.calls.some((c) => c.method === "fillRect")).toBe(false);
  });

  test("a plain wrapper with the same children DOES paint", () => {
    const ctx = new RecordingContext();
    paintNode(ctx as any, tree("container"));
    expect(ctx.painted("Skip to content")).toBeDefined();
  });

  test("the following sibling still paints — the pass is skipped, not aborted", () => {
    const ctx = new RecordingContext();
    paintNode(ctx as any, tree("VisuallyHidden"));
    expect(ctx.painted("Visible heading")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VisuallyHidden — accessibility mirror
// ---------------------------------------------------------------------------

class MirrorContext extends RecordingContext {
  getContext() {
    return this;
  }
}

function makeCanvas(): any {
  const canvas: any = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  const ctx = new MirrorContext();
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

function create(id: string, elementType: string, props: Record<string, any> = {}): Patch {
  return { type: "create", id, elementType, props } as any;
}
function insert(parentId: string, id: string, beforeId?: string): Patch {
  return { type: "insert", parentId, id, beforeId } as any;
}

function mirrorEl(id: string): FakeElement | undefined {
  const body = (document as any).body as FakeElement;
  const root = body.children.find(
    (el: FakeElement) => "data-hypen-a11y-overlay" in el.attributes,
  );
  if (!root) throw new Error("no a11y overlay mounted");
  const find = (el: FakeElement): FakeElement | undefined => {
    if (el.attributes["data-hypen-id"] === id) return el;
    for (const child of el.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(root);
}

describe("Canvas VisuallyHidden: accessibility mirror", () => {
  let renderer: CanvasRenderer;

  beforeEach(() => {
    ensureFakeDomGlobals();
    renderer = new CanvasRenderer(makeCanvas(), { dispatchAction() {} } as any, {
      devicePixelRatio: 1,
      enableAccessibility: true,
    });
    renderer.applyPatches([
      create("root", "column"),
      insert("root", "root"),
      create("vh", "VisuallyHidden"),
      insert("root", "vh"),
      create("label", "text", { 0: "Skip to content" }),
      insert("vh", "label"),
    ]);
  });

  test("the subtree stays in the mirror, so its text is still announced", () => {
    const vh = mirrorEl("vh")!;
    expect(vh).toBeDefined();
    expect((vh.style as any).display).not.toBe("none");
    expect(mirrorEl("label")!.textContent).toBe("Skip to content");
  });

  test("it is mirrored as a span, matching the DOM renderer's sr-only host", () => {
    expect(mirrorEl("vh")!.tagName).toBe("SPAN");
  });

  test("it keeps a clipped 1px box, not the collapsed layout box", () => {
    // Browse modes are geometry-driven: a 0×0 element is skipped, so the
    // zero box the layout pass assigns must NOT reach the mirror.
    const style = mirrorEl("vh")!.style as any;
    expect(style.width).toBe("1px");
    expect(style.height).toBe("1px");
    expect(style.clip).toBe("rect(0, 0, 0, 0)");
  });
});

// ---------------------------------------------------------------------------
// foregroundColor
// ---------------------------------------------------------------------------

describe("Canvas foregroundColor", () => {
  test("is accepted as a spelling of color on the node itself", () => {
    const text = node("t", "text", { 0: "hi", foregroundColor: "#ff0000" });
    expect(inheritedTextProp(text, "color")).toBe("#ff0000");
  });

  test("inherits down the parent chain like color does", () => {
    const text = node("t", "text", { 0: "hi" });
    node("root", "column", { foregroundColor: "#00ff00" }, [text]);
    expect(inheritedTextProp(text, "color")).toBe("#00ff00");
  });

  test("color still wins over foregroundColor on the same node", () => {
    const text = node("t", "text", { 0: "hi", color: "#0000ff", foregroundColor: "#ff0000" });
    expect(inheritedTextProp(text, "color")).toBe("#0000ff");
  });

  test("the nearest ancestor still wins, whichever spelling it uses", () => {
    const text = node("t", "text", { 0: "hi" });
    const mid = node("mid", "column", { foregroundColor: "#ff0000" }, [text]);
    node("root", "column", { color: "#0000ff" }, [mid]);
    expect(inheritedTextProp(text, "color")).toBe("#ff0000");
  });

  test("text paints with an inherited foregroundColor", () => {
    const text = withLayout(node("t", "text", { 0: "Tinted" }), 0, 0, 200, 20);
    const root = withLayout(
      node("root", "column", { foregroundColor: "#ff0000" }, [text]),
      0,
      0,
      200,
      20,
    );

    const ctx = new RecordingContext();
    paintNode(ctx as any, root);
    expect(ctx.painted("Tinted")!.fillStyle).toBe("#ff0000");
  });
});
