/**
 * Canvas → DOM parity fixtures.
 *
 * Each test reproduces a real engine-output shape (props in the
 * applicator-namespaced form the engine actually emits) and pins the
 * expected layout/paint behaviour against the DOM renderer's contract.
 *
 * Backs PARITY.md. New fixtures land here when a new gap is found.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import {
  computeLayout,
  initTaffyLayout,
} from "../packages/web/src/canvas/layout.js";
import { normalizeAllApplicators } from "../packages/web/src/canvas/props.js";
import { setImageNaturalSize } from "../packages/web/src/canvas/paint.js";
import {
  ScrollManager,
  isScrollable,
  getScrollAwareBounds,
  getScrollAxes,
} from "../packages/web/src/canvas/scroll.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // The Taffy path is what the production renderer uses; the fallback is
  // covered by canvas-layout.test.ts. We want to assert the production path
  // matches the engine's expectations. Fail loudly if Taffy didn't come up —
  // otherwise the suite silently runs the JS fallback and produces a wall of
  // misleading layout mismatches.
  const ok = await initTaffyLayout();
  if (!ok) {
    throw new Error(
      "Taffy WASM failed to initialise; canvas parity tests require the production (Taffy) layout path"
    );
  }
});

class MockCtx {
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  save() {}
  restore() {}
  set font(_v: string) {}
}
const ctx = new MockCtx() as unknown as CanvasRenderingContext2D;

/**
 * Build a VirtualNode mirroring the patches the engine emits. Children are
 * passed in their own raw-prop form; parent links are wired up.
 */
function makeNode(
  id: string,
  type: string,
  rawProps: Record<string, any>,
  children: VirtualNode[] = [],
): VirtualNode {
  const props = { ...rawProps };
  normalizeAllApplicators(props);
  const node: VirtualNode = {
    id,
    type,
    props,
    children,
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: true,
    focusable: false,
    focused: false,
    hovered: false,
  };
  for (const c of children) c.parent = node;
  return node;
}

describe("Row justify-content applicator values", () => {
  test("camel-case space variants distribute children across a finite Row", () => {
    const expected: Record<string, number[]> = {
      spaceBetween: [0, 135, 270],
      spaceAround: [35, 135, 235],
      // Taffy pixel-rounds the mathematical 52.5 / 217.5 positions.
      spaceEvenly: [53, 135, 218],
    };

    for (const [alignment, positions] of Object.entries(expected)) {
      const children = ["a", "b", "c"].map((id) =>
        makeNode(`${alignment}-${id}`, "Stack", { width: 30, height: 20 }),
      );
      const row = makeNode(`row-${alignment}`, "Row", {
        width: 300,
        height: 40,
        horizontalAlignment: alignment,
      }, children);

      computeLayout(ctx, row, 300, 40);
      expect(children.map((child) => child.layout!.x)).toEqual(positions);
    }
  });
});

// ---------------------------------------------------------------------------
// Stack absolute positioning
// ---------------------------------------------------------------------------

describe("Stack: children overlap in the same box", () => {
  test("children share top-left origin, not stacked vertically", () => {
    // Mimics the social example's story avatar: a 56×56 ring with a 20×20 +
    // badge pinned to the corner. Both children should occupy the same box
    // (the Stack), not flow as Column.
    const ring = makeNode("ring", "container", {
      width: 56,
      height: 56,
      backgroundColor: "#eee",
    });
    const badge = makeNode("badge", "container", {
      width: 20,
      height: 20,
      backgroundColor: "#0d6efd",
    });
    const stack = makeNode("stack", "stack", { width: 56, height: 56 }, [
      ring,
      badge,
    ]);

    computeLayout(ctx, stack, 800, 600, 0, 0);

    // Both children paint at the same origin (Stack default = top-left).
    expect(ring.layout!.x).toBe(0);
    expect(ring.layout!.y).toBe(0);
    expect(badge.layout!.x).toBe(0);
    expect(badge.layout!.y).toBe(0);

    // The Stack itself stays at its declared size — children don't expand it.
    expect(stack.layout!.width).toBe(56);
    expect(stack.layout!.height).toBe(56);
  });

  test("horizontalAlignment / verticalAlignment center children in the box", () => {
    const dot = makeNode("dot", "container", { width: 20, height: 20 });
    const stack = makeNode(
      "stack",
      "stack",
      {
        width: 100,
        height: 100,
        horizontalAlignment: "center",
        verticalAlignment: "center",
      },
      [dot],
    );

    computeLayout(ctx, stack, 800, 600, 0, 0);

    // Centered dot in 100×100 stack: (100-20)/2 = 40 on each axis.
    expect(dot.layout!.x).toBe(40);
    expect(dot.layout!.y).toBe(40);
  });

  test("horizontalAlignment: end pins child to the right edge", () => {
    const dot = makeNode("dot", "container", { width: 20, height: 20 });
    const stack = makeNode(
      "stack",
      "stack",
      {
        width: 100,
        height: 100,
        horizontalAlignment: "end",
        verticalAlignment: "end",
      },
      [dot],
    );

    computeLayout(ctx, stack, 800, 600, 0, 0);

    // Bottom-right pin: x = 100-20 = 80, y = 80.
    expect(dot.layout!.x).toBe(80);
    expect(dot.layout!.y).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Image natural-size aspect-ratio fallback
// ---------------------------------------------------------------------------

describe("Image: implicit aspect from intrinsic size", () => {
  test("sets aspectRatio when src has a cached natural size and only one dim", async () => {
    const { setImageNaturalSize } = await import(
      "../packages/web/src/canvas/paint.js"
    );

    // Pretend the image has loaded with a 2:1 intrinsic aspect.
    setImageNaturalSize("https://example.com/banner.png", 400, 200);

    const img = makeNode("img", "image", {
      src: "https://example.com/banner.png",
      width: 100,
      // height intentionally omitted — should derive 100 / 2 = 50 from aspect.
    });
    // Wrap in a row so the parent has a definite content area.
    const row = makeNode("row", "row", { width: 800, height: 400 }, [img]);

    computeLayout(ctx, row, 800, 400, 0, 0);

    expect(img.layout!.width).toBe(100);
    expect(img.layout!.height).toBe(50);
  });

  test("an unsized standalone Image uses its decoded intrinsic dimensions", () => {
    setImageNaturalSize("https://example.com/raw.png", 200, 150);
    const img = makeNode("raw", "image", { src: "https://example.com/raw.png" });
    const column = makeNode("column", "column", { width: 382 }, [img]);

    computeLayout(ctx, column, 382, 400, 0, 0);

    expect(img.layout!.width).toBe(200);
    expect(img.layout!.height).toBe(150);
  });

  test("explicit Image width and height override its decoded natural size", () => {
    setImageNaturalSize("https://example.com/tile.png", 128, 128);
    const img = makeNode("tile", "image", {
      src: "https://example.com/tile.png",
      width: 80,
      height: 80,
    });
    const row = makeNode("row", "row", { width: 382 }, [img]);

    computeLayout(ctx, row, 382, 200, 0, 0);

    expect(img.layout!.width).toBe(80);
    expect(img.layout!.height).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Gallery applicator parity regressions
// ---------------------------------------------------------------------------

describe("Gallery sizing and border applicators", () => {

  test("a raw Row child keeps intrinsic height while fillMaxHeight fills", () => {
    const raw = makeNode("raw", "stack", { padding: 12 }, [
      makeNode("raw-text", "text", { 0: "Default", fontSize: 12 }),
    ]);
    const fill = makeNode("fill", "stack", { padding: 12, fillMaxHeight: true }, [
      makeNode("fill-text", "text", { 0: "Fill", fontSize: 12 }),
    ]);
    const row = makeNode("row", "row", { width: 200, height: 150, padding: 16 }, [raw, fill]);

    computeLayout(ctx, row, 200, 150, 0, 0);

    expect(raw.layout!.height).toBeLessThan(118);
    expect(fill.layout!.height).toBe(118);
  });

  test("weighted Row children shrink below their text min-content width", () => {
    const cards = ["one", "two", "three"].map((id) =>
      makeNode(id, "column", { weight: 1, padding: 16 }, [
        makeNode(`${id}-text`, "text", { 0: "A very long card label" }),
      ]),
    );
    const row = makeNode("row", "row", { width: 382, gap: 12 }, cards);

    computeLayout(ctx, row, 382, 200, 0, 0);

    expect(cards[2]!.layout!.x + cards[2]!.layout!.width).toBeLessThanOrEqual(382);
    expect(Math.abs(cards[0]!.layout!.width - cards[1]!.layout!.width)).toBeLessThanOrEqual(1);
  });

  test("Text inside a finite Stack wraps within its grid track", () => {
    const text = makeNode("text", "text", {
      0: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    });
    const stack = makeNode("stack", "stack", { width: 120, padding: 16 }, [text]);

    computeLayout(ctx, stack, 120, 300, 0, 0);

    expect(text.layout!.width).toBeLessThanOrEqual(88);
    expect(text.layout!.height).toBeGreaterThan(20);
  });

  test("fillMaxWidth supports fractional values", () => {
    const half = makeNode("half", "stack", {
      "fillMaxWidth.0": 0.5,
      "height.0": 20,
    });
    const parent = makeNode("parent", "column", { width: 200, height: 80 }, [half]);

    computeLayout(ctx, parent, 200, 80, 0, 0);

    expect(half.layout!.width).toBe(100);
    expect(half.layout!.height).toBe(20);
  });

  test("fillMaxSize fills the parent's content box on both axes", () => {
    const fill = makeNode("fill", "stack", { "fillMaxSize.0": true });
    const parent = makeNode(
      "parent",
      "stack",
      { width: 200, height: 100, padding: 10 },
      [fill],
    );

    computeLayout(ctx, parent, 200, 100, 0, 0);

    expect(fill.layout!.width).toBe(180);
    expect(fill.layout!.height).toBe(80);
  });

  test("size gives empty gradient boxes a real square layout", () => {
    const gradient = makeNode("gradient", "stack", {
      "size.0": 100,
      "linearGradient.0": "to bottom right, #fbbf24, #ef4444",
      "cornerRadius.0": 8,
    });
    const row = makeNode("row", "row", { width: 300, height: 120 }, [gradient]);

    computeLayout(ctx, row, 300, 120, 0, 0);

    expect(gradient.layout!.width).toBe(100);
    expect(gradient.layout!.height).toBe(100);
    expect(gradient.layout!.border.radius).toBe(8);
  });

  test("compound border and cornerRadius populate the Canvas box model", () => {
    const input = makeNode("input", "input", {
      "width.0": 180,
      "height.0": 44,
      "border.0": { width: 2, color: "#d1d5db" },
      "cornerRadius.0": 12,
    });

    computeLayout(ctx, input, 300, 100, 0, 0);

    expect(input.layout!.border).toEqual({
      width: 2,
      color: "#d1d5db",
      radius: 12,
    });
    expect(input.layout!.contentWidth).toBe(176);
    expect(input.layout!.contentHeight).toBe(40);
  });

  test("weight is the cross-platform alias for flex", () => {
    const first = makeNode("first", "stack", { "weight.0": 1, height: 20 });
    const second = makeNode("second", "stack", { "weight.0": 1, height: 20 });
    const row = makeNode("row", "row", { width: 200, height: 20 }, [first, second]);

    computeLayout(ctx, row, 200, 20, 0, 0);

    expect(first.layout!.width).toBe(100);
    expect(second.layout!.width).toBe(100);
  });

  test("Badge is content-sized with its DOM default padding", () => {
    const label = makeNode("label", "text", { 0: "Popular", fontSize: 12 });
    const badge = makeNode("badge", "badge", {}, [label]);
    const row = makeNode("row", "row", { width: 200, height: 40 }, [badge]);

    computeLayout(ctx, row, 200, 40, 0, 0);

    expect(badge.layout!.padding).toEqual({ top: 4, right: 8, bottom: 4, left: 8 });
    expect(badge.layout!.width).toBeGreaterThan(16);
    expect(badge.layout!.height).toBeGreaterThan(8);
  });

  test("an unsized Column carries a descendant fillMaxWidth demand", () => {
    const input = makeNode("input", "input", { "fillMaxWidth.0": true });
    const field = makeNode("field", "column", {}, [input]);
    const form = makeNode("form", "column", { width: 200, height: 80 }, [field]);

    computeLayout(ctx, form, 200, 80, 0, 0);

    expect(field.layout!.width).toBe(200);
    expect(input.layout!.width).toBe(200);
  });

  test("a Spacer makes its wrapping Row consume the available list width", () => {
    const label = makeNode("label", "text", { 0: "Item 1" });
    const spacer = makeNode("spacer", "spacer", {});
    const caret = makeNode("caret", "text", { 0: ">" });
    const row = makeNode("row", "row", { padding: 12 }, [label, spacer, caret]);
    const list = makeNode("list", "column", { width: 200 }, [row]);

    computeLayout(ctx, list, 200, 100, 0, 0);

    expect(row.layout!.width).toBe(200);
    expect(caret.layout!.x).toBeGreaterThan(170);
  });
});

// ---------------------------------------------------------------------------
// Per-axis scroll
// ---------------------------------------------------------------------------

describe("Scroll: axis is honored from `scrollable`", () => {
  test("scrollable: 'horizontal' allows X scroll only", () => {
    const node = makeNode("strip", "row", {
      width: 200,
      height: 50,
      scrollable: "horizontal",
    });
    const axes = getScrollAxes(node);
    expect(axes).toEqual({ x: true, y: false });
  });

  test("scrollable: 'vertical' allows Y scroll only", () => {
    const node = makeNode("list", "column", {
      width: 200,
      height: 400,
      scrollable: "vertical",
    });
    expect(getScrollAxes(node)).toEqual({ x: false, y: true });
  });

  test("scrollable: true allows both axes (back-compat)", () => {
    const node = makeNode("box", "container", {
      width: 200,
      height: 200,
      scrollable: true,
    });
    expect(getScrollAxes(node)).toEqual({ x: true, y: true });
  });

  test("overflow: 'scroll' allows both axes (CSS-style)", () => {
    const node = makeNode("box", "container", {
      width: 200,
      height: 200,
      overflow: "scroll",
    });
    expect(getScrollAxes(node)).toEqual({ x: true, y: true });
  });
});

describe("Scroll: bounds are clamped to the active axis", () => {
  test("horizontal-only strip never gains a Y scroll range", () => {
    // Build a horizontal strip with content overflowing both axes — the
    // taller-than-strip child should NOT make scrollY clampable beyond zero
    // because the strip is `scrollable: "horizontal"`.
    const items = [
      makeNode("a", "container", { width: 100, height: 200 }),
      makeNode("b", "container", { width: 100, height: 200 }),
      makeNode("c", "container", { width: 100, height: 200 }),
    ];
    const strip = makeNode(
      "strip",
      "row",
      { width: 150, height: 50, scrollable: "horizontal" },
      items,
    );

    computeLayout(ctx, strip, 800, 600, 0, 0);
    ScrollManager.updateScrollBounds(strip);

    const ss = strip.scrollState!;
    // X axis should have headroom: 3 children × 100 = 300 > 150 strip.
    expect(ss.scrollWidth).toBeGreaterThanOrEqual(300);
    // Y axis should be clamped — no vertical scroll on a horizontal strip.
    expect(ss.scrollHeight).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Scrolled hit-testing
// ---------------------------------------------------------------------------

describe("Hit testing: bounds account for ancestor scroll offset", () => {
  test("getScrollAwareBounds matches layout.x/y when no ancestor scroll", () => {
    // Sanity baseline: without scroll, the visible bounds are just the
    // node's already-absolute layout coords (no double-walk over parents).
    const child = makeNode("c", "container", { width: 50, height: 50 });
    const parent = makeNode(
      "p",
      "column",
      { width: 200, height: 200, padding: 10 },
      [child],
    );

    computeLayout(ctx, parent, 800, 600, 0, 0);

    const bounds = getScrollAwareBounds(child)!;
    expect(bounds.x).toBe(child.layout!.x);
    expect(bounds.y).toBe(child.layout!.y);
    expect(bounds.width).toBe(50);
    expect(bounds.height).toBe(50);
  });

  test("ancestor scrollY shifts visible bounds upward", () => {
    const child = makeNode("c", "container", { width: 50, height: 50 });
    const list = makeNode(
      "list",
      "column",
      { width: 200, height: 200, scrollable: "vertical" },
      [child],
    );

    computeLayout(ctx, list, 800, 600, 0, 0);

    // Simulate having scrolled the list down by 30px.
    list.scrollState = {
      scrollX: 0,
      scrollY: 30,
      velocityX: 0,
      velocityY: 0,
      scrollWidth: 0,
      scrollHeight: 0,
      touching: false,
      lastTouchTime: 0,
      scrollbarOpacity: 0,
    };

    const bounds = getScrollAwareBounds(child)!;
    // Child rendered with `ctx.translate(0, -30)`, so its visible top is
    // 30px above its layout-space top.
    expect(bounds.y).toBe(child.layout!.y - 30);
    expect(bounds.x).toBe(child.layout!.x);
  });
});

// ---------------------------------------------------------------------------
// Icon sizing inside transparent buttons
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stack inside larger layouts (regression coverage)
// ---------------------------------------------------------------------------

describe("Stack: doesn't inflate to fill its parent", () => {
  test("badge stays at declared size when Stack is in a fixed-width Column", () => {
    // Reproduces the Stories carousel "Your Story" cell: an outer Column
    // with explicit width contains a Stack with avatar + badge. The Stack
    // should size to its largest child, NOT take the parent Column's full
    // width — and the badge should stay 20×20, NOT stretch to fill the
    // whole grid cell (which Taffy would do under default `align-items:
    // stretch`).
    const avatar = makeNode("avatar", "container", {
      width: 56,
      height: 56,
    });
    const badge = makeNode("badge", "container", {
      width: 20,
      height: 20,
      backgroundColor: "#0d6efd",
      marginTop: 36,
      marginLeft: 36,
    });
    const stack = makeNode("stack", "stack", {}, [avatar, badge]);
    // Outer column matches the social example: w-24 (96px) cell.
    const cell = makeNode("cell", "column", { width: 96, height: 80 }, [
      stack,
    ]);

    computeLayout(ctx, cell, 470, 800, 0, 0);

    // Stack auto-sizes to its content, not the cell's full width or
    // height. Largest child is the avatar (56) or badge bottom edge
    // (36 + 20 = 56) — same on both axes here.
    expect(stack.layout!.width).toBeLessThanOrEqual(96);
    expect(stack.layout!.height).toBeLessThanOrEqual(80);

    // Badge keeps its declared 20×20 size.
    expect(badge.layout!.width).toBe(20);
    expect(badge.layout!.height).toBe(20);

    // Avatar keeps its declared 56×56 size.
    expect(avatar.layout!.width).toBe(56);
    expect(avatar.layout!.height).toBe(56);
  });

  test("badge with margins inside Stack stays at 20×20 — doesn't paint as full Stack box", () => {
    // This was the regression visible in the social example: the Stack's
    // bg-blue-500 badge appeared to fill the entire Stories row. Reproduces
    // the exact applicator-namespaced shape the engine emits (`marginTop`,
    // `marginLeft` as scalars; `width`/`height` from `w-5 h-5`).
    const avatar = makeNode("avatar", "image", {
      src: "https://example.com/avatar.png",
      width: 56,
      height: 56,
    });
    const badge = makeNode("badge", "column", {
      width: 20,
      height: 20,
      backgroundColor: "#3b82f6",
      marginTop: 36,
      marginLeft: 36,
    });
    const stack = makeNode("stack", "stack", {}, [avatar, badge]);
    // Outer "Your Story" cell — this is the size from `w-24` in the fixture
    // (96px) plus typical row padding height.
    const cell = makeNode("cell", "column", {
      width: 96,
      horizontalAlignment: "center",
      paddingTop: 4,
      paddingBottom: 4,
    }, [stack]);
    // Outer scrollable Row — the Stories carousel.
    const carousel = makeNode("carousel", "row", {
      width: 470,
      scrollable: "horizontal",
      paddingTop: 8,
      paddingBottom: 8,
    }, [cell]);

    computeLayout(ctx, carousel, 470, 800, 0, 0);

    // Badge stays at declared 20×20 — NOT inflated to the Stack box, NOT
    // inflated to the Stories row height.
    expect(badge.layout!.width).toBe(20);
    expect(badge.layout!.height).toBe(20);
    // And the Stack stays at content size (avatar 56 vs badge box-with-
    // margin 36+20=56), not the full row height.
    expect(stack.layout!.width).toBe(56);
    expect(stack.layout!.height).toBe(56);
  });

  test("Stack inside a tall flex row doesn't stretch its children vertically", () => {
    // The Stories Row is tall (~100px with padding). Without proper Stack
    // handling, the Stack stretches to fill the cross axis and then drags
    // children with it under Taffy's default align-items: stretch.
    const child = makeNode("c", "container", { width: 30, height: 30 });
    const stack = makeNode("stack", "stack", {}, [child]);
    const row = makeNode("row", "row", { width: 470, height: 200 }, [stack]);

    computeLayout(ctx, row, 470, 800, 0, 0);

    // The child must stay 30×30 even though the row is 200px tall.
    expect(child.layout!.width).toBe(30);
    expect(child.layout!.height).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Text inside flex column reports a non-zero height
// ---------------------------------------------------------------------------

describe("Absolute-positioned overlays render and hit-test on top", () => {
  test("an absolute child declared FIRST in the tree sits visually above an in-flow sibling", () => {
    // The Story page header is `position: absolute` and declared BEFORE
    // the full-screen Image. Without overlay-aware paint ordering, the
    // Image painted last covered the header (and its close button), so
    // the user couldn't get back from a story.
    //
    // Note: this test pins the SEMANTIC contract — overlays paint after
    // flow siblings — by verifying both children land in the layout. The
    // actual paint-order assertion lives in the live screenshot loop.
    const closeText = makeNode("ct", "Text", { "0": "✕", fontSize: 18 });
    const closeBtn = makeNode("close", "Button", {
      onClick: "@router.push",
    }, [closeText]);
    const header = makeNode(
      "h",
      "Row",
      {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        paddingTop: 12,
        paddingBottom: 12,
      },
      [closeBtn],
    );
    const photo = makeNode("img", "Image", {
      src: "https://x/img.jpg",
      width: "100%",
      height: "100%",
    });
    const story = makeNode("story", "Column", { width: 470, height: 720 }, [
      header,
      photo,
    ]);

    computeLayout(ctx, story, 470, 720, 0, 0);

    expect(header.layout!.y).toBe(0);
    expect(closeBtn.layout!.width).toBeGreaterThan(0);
    expect(closeBtn.layout!.height).toBeGreaterThan(0);
  });
});

describe("List defaults to a vertical stack", () => {
  test("children of a List stack vertically (matches DOM `flex-direction: column`)", () => {
    // Notifications uses `List(items, ...)` and expects items to stack
    // vertically. Without this, List fell through to the row default and
    // every notification sat beside the previous one instead of below.
    const a = makeNode("a", "Row", { height: 50 });
    const b = makeNode("b", "Row", { height: 50 });
    const c = makeNode("c", "Row", { height: 50 });
    const list = makeNode("list", "List", { width: 400 }, [a, b, c]);

    computeLayout(ctx, list, 400, 800, 0, 0);

    // Three 50-tall rows laid out vertically -> ys at 0, 50, 100.
    expect(a.layout!.y).toBe(0);
    expect(b.layout!.y).toBe(50);
    expect(c.layout!.y).toBe(100);
    // All three share the X origin (single column).
    expect(a.layout!.x).toBe(0);
    expect(b.layout!.x).toBe(0);
    expect(c.layout!.x).toBe(0);
  });
});

describe("Grid with columns:N expands to N equal tracks", () => {
  test("`gridColumns: 3` (engine applicator name) arranges 6 children in 3x2 grid", () => {
    // Mirrors the Search component's explore grid: `.gridColumns(3)` means
    // 3 columns of 1fr each. Items should wrap to the next row after 3.
    // The engine emits the applicator's own name on props (`gridColumns`),
    // not the CSS spec name — matching the DOM applicator at
    // `dom/applicators/advanced-layout.ts`.
    const items = Array.from({ length: 6 }, (_, i) =>
      makeNode(`i${i}`, "Column", { height: 60 }),
    );
    const grid = makeNode("g", "Grid", { gridColumns: 3, width: 300 }, items);

    computeLayout(ctx, grid, 300, 800, 0, 0);

    // First row: x = 0, 100, 200 (300 / 3 = 100 per cell)
    expect(items[0].layout!.x).toBe(0);
    expect(items[1].layout!.x).toBe(100);
    expect(items[2].layout!.x).toBe(200);
    // Second row: same xs, larger y
    expect(items[3].layout!.x).toBe(0);
    expect(items[4].layout!.x).toBe(100);
    expect(items[5].layout!.x).toBe(200);
    expect(items[3].layout!.y).toBeGreaterThan(items[0].layout!.y);
  });

  test("`gridColumns: \"3\"` (string number) expands the same way", () => {
    // The engine sometimes sends numeric applicator args as strings.
    const items = Array.from({ length: 3 }, (_, i) =>
      makeNode(`i${i}`, "Column", { height: 60 }),
    );
    const grid = makeNode("g", "Grid", { gridColumns: "3", width: 300 }, items);

    computeLayout(ctx, grid, 300, 800, 0, 0);

    expect(items[0].layout!.x).toBe(0);
    expect(items[1].layout!.x).toBe(100);
    expect(items[2].layout!.x).toBe(200);
  });
});

describe("HomePage hierarchy: width respects parent canvas", () => {
  test("Post in scrollable HomePage Column doesn't exceed canvas width", () => {
    // Mirrors the social example's app shell:
    //   Route Column (flex:1)
    //     HomePage Column (scrollable, flex:1, width:100%)
    //       Post Column (intrinsic) ← should be 470 wide, not wider
    //     BottomNav Row (intrinsic) ← should be visible at the bottom
    const post = makeNode("post", "Column", {
      // Bare Post with bg-white border-b mb-2 — no width prop.
      backgroundColor: "#ffffff",
      borderBottomWidth: "1px",
      marginBottom: 8,
    });
    const homepage = makeNode(
      "home",
      "Column",
      { scrollable: true, flex: "1", width: "100%" },
      [post],
    );
    const bottomNav = makeNode(
      "nav",
      "Row",
      { paddingTop: 4, paddingBottom: 24, paddingLeft: 12, paddingRight: 12 },
    );
    const route = makeNode("route", "Column", { flex: "1" }, [
      homepage,
      bottomNav,
    ]);

    computeLayout(ctx, route, 470, 720, 0, 0);

    expect(post.layout!.width).toBeLessThanOrEqual(470);
    // BottomNav must have a positive height — without this the user
    // can't see the navigation bar.
    expect(bottomNav.layout!.height).toBeGreaterThan(0);
  });
});

describe("Text in column flex reports its measured height", () => {
  test("Text node typed as `Text` (capitalised) becomes a Taffy leaf with measured height", () => {
    // The engine emits element types capitalised (`"Text"`, `"Button"`, …).
    // The buildTree text-leaf check used to compare `node.type === "text"`
    // and miss; the Text became an empty container with size 0×0 and the
    // next sibling overlapped it. Reproduces the social Post bug.
    const cap = makeNode("cap", "Text", {
      "0": "1,431 likes",
      fontSize: "0.875rem",
      lineHeight: "1.25rem",
      fontWeight: "600",
    });
    const row = makeNode("row", "Column", { width: 470 }, [cap]);

    computeLayout(ctx, row, 470, 1000, 0, 0);

    expect(cap.layout!.height).toBeGreaterThan(0);
  });

  test("single-line Text between two Rows doesn't collapse to height 0", () => {
    // Reproduces the social Post layout's likes/caption sequence:
    //   Row (action buttons)
    //   Text "1,431 likes"
    //   Row (username + caption)
    //
    // The bug saw the Text report layout.height = 0, so the caption Row
    // landed at the same Y as the likes Text and the two overlapped.
    const actionRow = makeNode("actions", "row", {
      width: 470,
      height: 40,
      paddingTop: 4,
      paddingBottom: 4,
    });
    const likes = makeNode("likes", "text", {
      "0": "1,431 likes",
      // Tailwind `text-sm` becomes both fontSize AND lineHeight props on
      // the engine — the lineHeight is what triggers the height collapse.
      fontSize: "0.875rem",
      lineHeight: "1.25rem",
      fontWeight: 600,
      paddingLeft: 16,
      paddingRight: 16,
    });
    const captionUser = makeNode("user", "text", {
      "0": "bob_brews",
      fontSize: 14,
      fontWeight: 600,
    });
    const captionText = makeNode("caption", "text", {
      "0": "Pour-over ritual. The beans are from a small farm in Guatemala.",
      fontSize: 14,
    });
    const captionRow = makeNode("caption-row", "row", {
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 16,
      paddingRight: 16,
    }, [captionUser, captionText]);
    const post = makeNode(
      "post",
      "column",
      { width: 470 },
      [actionRow, likes, captionRow],
    );

    computeLayout(ctx, post, 470, 1000, 0, 0);

    expect(likes.layout!.height).toBeGreaterThan(0);
    // Caption row's top must sit at or below the bottom of the likes text.
    const likesBottom = likes.layout!.y + likes.layout!.height;
    expect(captionRow.layout!.y).toBeGreaterThanOrEqual(likesBottom);
  });
});

describe("Icon: keeps intrinsic size inside flex parents", () => {
  test("icon does not shrink to 0 when parent has a tighter cross axis", () => {
    // Reproduces a transparent nav button that wraps an icon: the button has
    // only `padding.0` and no width, so Taffy gives the row a tight cross
    // axis. With default flexShrink=1, the icon collapses. The fix is to
    // give intrinsic-sized components flexShrink=0 by default.
    const icon = makeNode("icon", "icon", { name: "bell" });
    const button = makeNode(
      "btn",
      "button",
      {
        "padding.0": 8,
        backgroundColor: "transparent",
      },
      [icon],
    );

    computeLayout(ctx, button, 40, 40, 0, 0);

    // Icon defaults to 24×24 — must NOT shrink to 0 in a tight container.
    expect(icon.layout!.width).toBe(24);
    expect(icon.layout!.height).toBe(24);
  });

  test("avatar keeps its intrinsic size in a row that's narrower than its content", () => {
    const avatar = makeNode("a", "avatar", { size: 56 });
    const row = makeNode("r", "row", { width: 50, height: 56 }, [avatar]);

    computeLayout(ctx, row, 800, 600, 0, 0);

    // Avatar is 56×56; row is only 50 wide. Avatar must keep 56 (not shrink).
    expect(avatar.layout!.width).toBe(56);
    expect(avatar.layout!.height).toBe(56);
  });
});

// ---------------------------------------------------------------------------
// HiDPI hit testing (devicePixelRatio > 1)
// ---------------------------------------------------------------------------

describe("Form controls have an intrinsic height matching the DOM box", () => {
  test("Input box = line-height + padding + border (Search bar reads ~36px)", () => {
    // Reproduces the social Search route's bar:
    //   Input(placeholder: "Search").tw("flex-1 bg-gray-100 rounded-lg px-4 py-2 text-sm")
    // Without an intrinsic height, the Input collapsed to the padding-only
    // box (~4-tall content under border-box) and the bar looked nothing
    // like the iOS / Android version.
    const input = makeNode("inp", "Input", {
      placeholder: "Search",
      "flex.0": 1,
      paddingTop: "0.5rem", // py-2
      paddingBottom: "0.5rem",
      paddingLeft: "1rem", // px-4
      paddingRight: "1rem",
      fontSize: "0.875rem", // text-sm
      lineHeight: "1.25rem",
    });
    const row = makeNode("r", "Row", { width: 470 }, [input]);

    computeLayout(ctx, row, 470, 200, 0, 0);

    // Outer box: lineHeight (20) + padTop (8) + padBottom (8) = 36.
    expect(input.layout!.height).toBe(36);
  });

  test("Textarea defaults to ~3 rows when no `rows` prop is set", () => {
    const ta = makeNode("ta", "Textarea", {
      placeholder: "Bio",
      paddingTop: 8,
      paddingBottom: 8,
      fontSize: 16,
    });
    const row = makeNode("r", "Row", { width: 200 }, [ta]);

    computeLayout(ctx, row, 200, 200, 0, 0);

    // 3 rows × default lineHeight (16 * 1.5 = 24) + padding 16 = 88.
    expect(ta.layout!.height).toBe(88);
  });
});

describe("Grid with aspect-ratio image children sizes implicit rows", () => {
  test("decoded intrinsic ratios size gallery images without explicit dimensions", () => {
    const items = Array.from({ length: 6 }, (_, i) => {
      const src = `gallery-intrinsic-${i}.png`;
      setImageNaturalSize(src, 96, 96);
      return makeNode(`natural-${i}`, "Image", { src, cornerRadius: 8 });
    });
    const grid = makeNode("natural-grid", "Grid", {
      gridColumns: 3,
      gap: 4,
      width: 382,
    }, items);

    computeLayout(ctx, grid, 382, 400, 0, 0);

    expect(items[0].layout!.width).toBeGreaterThan(120);
    expect(items[0].layout!.height).toBe(items[0].layout!.width);
    expect(items[3].layout!.y - items[0].layout!.y)
      .toBeGreaterThanOrEqual(items[0].layout!.height + 3);
  });

  test("3 cols × N aspect-square images don't overlap (Search explore grid)", () => {
    // Reproduces the Search route: a `.gridColumns(3).gap(4).scrollable(true)`
    // grid of `Image.aspectRatio(1).width("100%")` items. Without the 2-pass
    // grid auto-row fix, Taffy treats each image leaf as max-content height = 0
    // (the leaf has no fixed height; aspect-ratio can't anchor without a known
    // width during track sizing) and the implicit rows collapse to gap-only,
    // making items overlap by ~150px each.
    const items = Array.from({ length: 9 }, (_, i) =>
      makeNode(`i${i}`, "Image", {
        src: `https://x/${i}.jpg`,
        aspectRatio: 1,
        width: "100%",
      }),
    );
    const grid = makeNode(
      "g",
      "Grid",
      { gridColumns: 3, gap: 4, width: 470 },
      items,
    );

    computeLayout(ctx, grid, 470, 800, 0, 0);

    // Three columns at 1fr each: (470 - 2*4) / 3 = 154 wide.
    const w = items[0].layout!.width;
    expect(w).toBe(154);
    expect(items[0].layout!.height).toBe(154);

    // First row at y=0; subsequent rows separated by item height + gap.
    expect(items[0].layout!.y).toBe(0);
    expect(items[1].layout!.y).toBe(0);
    expect(items[2].layout!.y).toBe(0);
    const rowDelta = items[3].layout!.y - items[0].layout!.y;
    // Row delta must be at least item height (no overlap). The PARITY bug
    // had this collapsing to ~8 (gap only).
    expect(rowDelta).toBeGreaterThanOrEqual(154);
  });
});

describe("Hit test stays in CSS pixels under HiDPI", () => {
  test("a click in the middle of a 100×100 button at dpr=2 hits that button", async () => {
    // Reproduces the Mac (dpr=2) bug where hit tests multiplied client coords
    // by `canvas.width / rect.width` (= dpr). The renderer scales the ctx by
    // dpr once at setup, so layout (and therefore the hit-test bounds) lives
    // in CSS pixels — multiplying again landed every click at 2× the bounds,
    // visibly: the cursor turned to a pointer above the actual element and
    // bottom-nav clicks fell off the bottom of the canvas entirely.
    const { CanvasEventManager } = await import(
      "../packages/web/src/canvas/events.js"
    );

    // Mock a HiDPI canvas: CSS box is 200×200 but the backing buffer is 400×400.
    const listeners = new Map<string, Function[]>();
    const canvas = {
      width: 400,
      height: 400,
      style: { cursor: "default" } as Record<string, string>,
      getBoundingClientRect: () => ({ left: 50, top: 30, width: 200, height: 200 }),
      addEventListener: (type: string, fn: Function) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)!.push(fn);
      },
      removeEventListener: () => {},
      dispatchEvent: (e: any) => {
        for (const fn of listeners.get(e.type) ?? []) fn(e);
        return true;
      },
    } as unknown as HTMLCanvasElement;

    const dispatched: Array<{ name: string; payload: any }> = [];
    const engine = {
      dispatchAction: (name: string, payload: any) => {
        dispatched.push({ name, payload });
      },
    };
    const mgr = new CanvasEventManager(canvas, engine);

    // 100×100 button positioned at logical (50, 60).
    const button: VirtualNode = {
      id: "btn",
      type: "Button",
      props: { onClick: "@router.push" },
      children: [],
      parent: null,
      visible: true,
      opacity: 1,
      clickable: true,
      hoverable: true,
      focusable: false,
      focused: false,
      hovered: false,
      layout: {
        x: 50,
        y: 60,
        width: 100,
        height: 100,
        contentX: 0,
        contentY: 0,
        contentWidth: 100,
        contentHeight: 100,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        border: { top: 0, right: 0, bottom: 0, left: 0, radius: 0 },
      } as any,
    };
    mgr.setRootNode(button);

    // Hover the visual centre of the button (logical 100, 110). At dpr=2 the
    // pre-fix code mapped this to canvas-pixel (100, 110) too — wait, it
    // multiplied by dpr → (200, 220), missing the bounds. Verify pointer.
    canvas.dispatchEvent({
      type: "mousemove",
      clientX: 50 + 100, // rect.left + 100 logical
      clientY: 30 + 110, // rect.top + 110 logical
      button: 0,
    });
    expect(canvas.style.cursor).toBe("pointer");

    // And a click on the same point dispatches the action.
    canvas.dispatchEvent({
      type: "mousedown",
      clientX: 50 + 100,
      clientY: 30 + 110,
      button: 0,
    });
    canvas.dispatchEvent({
      type: "mouseup",
      clientX: 50 + 100,
      clientY: 30 + 110,
      button: 0,
    });
    canvas.dispatchEvent({
      type: "click",
      clientX: 50 + 100,
      clientY: 30 + 110,
      button: 0,
    });
    expect(dispatched.some((d) => d.name === "router.push")).toBe(true);
  });
});
