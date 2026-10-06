/**
 * Canvas Tailwind/layout coverage.
 *
 * Every fixture below reproduces props in the exact namespaced shape the
 * engine emits for a `.tw("…")` applicator (`hypen-engine-rs/src/ir/expand.rs`
 * lowers Tailwind to camelCased CSS props with a `.0` arg suffix, plus
 * `@md`-style variant markers), so a regression in the lowering contract
 * fails here rather than silently degrading the rendered page.
 *
 * Both layout backends are exercised:
 *   - Taffy (WASM) — what a deployment that serves `taffy_wasm_bg.wasm` uses.
 *   - The JS fallback — what every deployment WITHOUT reachable WASM uses,
 *     which is the path the Hypeflix canvas page actually runs on.
 *
 * The suites are split into two files so each can pick its backend: this
 * file covers the Taffy path (see `canvas-tw-fallback.test.ts` for the JS
 * one), because `initTaffyLayout()` is process-global and irreversible.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { computeLayout, initTaffyLayout } from "../packages/web/src/canvas/layout.js";
import { normalizeAllApplicators } from "../packages/web/src/canvas/props.js";
import { applyVariants } from "../packages/web/src/canvas/variants.js";
import {
  cssLengthToPx,
  cssLengthToDimension,
  cssLengthToPxForFont,
  cssLineHeightToPx,
  parseCalcLength,
  setCssViewport,
} from "../packages/web/src/canvas/utils.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

beforeAll(async () => {
  const ok = await initTaffyLayout();
  if (!ok) {
    throw new Error(
      "Taffy WASM failed to initialise; this suite pins the production (Taffy) layout path",
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

/** Build a VirtualNode from raw engine-shaped props. */
function makeNode(
  type: string,
  rawProps: Record<string, any>,
  children: VirtualNode[] = [],
): VirtualNode {
  const props = { ...rawProps };
  normalizeAllApplicators(props);
  const node: VirtualNode = {
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
  };
  for (const c of children) c.parent = node;
  return node;
}

/** Resolve `@md` variants for `width`, then lay the tree out. */
function layout(root: VirtualNode, w = 1280, h = 900): void {
  applyVariants(root, w);
  computeLayout(ctx, root, w, h, 0, 0);
}

// ---------------------------------------------------------------------------
// Length parsing: viewport units, calc(), em tracking, unitless line-height
// ---------------------------------------------------------------------------

describe("length units", () => {
  test("h-screen (100vh) resolves against the canvas viewport, not as 100px", () => {
    setCssViewport(1280, 900);
    expect(cssLengthToPx("100vh")).toBe(900);
    expect(cssLengthToPx("100vw")).toBe(1280);
    expect(cssLengthToPx("50vh")).toBe(450);
    expect(cssLengthToPx("100vmin")).toBe(900);
    expect(cssLengthToPx("100vmax")).toBe(1280);
  });

  test("viewport units fall back to raw px when no viewport is published", () => {
    setCssViewport(0, 0);
    expect(cssLengthToPx("100vh")).toBe(100);
    setCssViewport(1280, 900);
  });

  test("rem/px/pt still resolve as before", () => {
    expect(cssLengthToPx("8rem")).toBe(128); // w-32
    expect(cssLengthToPx("11rem")).toBe(176); // h-44
    expect(cssLengthToPx("168px")).toBe(168); // h-[168px]
  });

  test("calc() reduces to percentage + absolute terms", () => {
    expect(parseCalcLength("calc(100% - 40px)")).toEqual({ pct: 100, px: -40 });
    expect(parseCalcLength("calc(50% + 1rem)")).toEqual({ pct: 50, px: 16 });
    expect(parseCalcLength("calc(100vh - 3rem)")).toEqual({ pct: 0, px: 900 - 48 });
    expect(parseCalcLength("12px")).toBeNull();
  });

  test("calc() with a basis resolves to px; without one it degrades to the percentage", () => {
    expect(cssLengthToDimension("calc(100% - 40px)", 800)).toBe(760);
    expect(cssLengthToDimension("calc(100% - 40px)")).toBe("100%");
    // A calc with no percentage term needs no basis at all.
    expect(cssLengthToDimension("calc(100vh - 3rem)")).toBe(852);
  });

  test("letter-spacing em is relative to the element's own font size", () => {
    // tracking-[0.2em] on text-2xl (24px) is 4.8px, not 0.2 * 16.
    expect(cssLengthToPxForFont("0.2em", 24)).toBeCloseTo(4.8, 5);
    expect(cssLengthToPxForFont("0.05em", 12)).toBeCloseTo(0.6, 5);
    expect(cssLengthToPxForFont("2px", 24)).toBe(2);
  });

  test("unitless line-height is a multiplier (text-5xl emits `1`)", () => {
    expect(cssLineHeightToPx("1", 48)).toBe(48);
    expect(cssLineHeightToPx("1.25", 16)).toBe(20); // leading-tight
    expect(cssLineHeightToPx("2rem", 24)).toBe(32); // text-2xl
    expect(cssLineHeightToPx("150%", 16)).toBe(24);
    // Large bare numbers keep the historical pixel reading.
    expect(cssLineHeightToPx(20, 16)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Flex sizing
// ---------------------------------------------------------------------------

describe("flex sizing", () => {
  test("h-screen fills the canvas instead of collapsing to a 100px band", () => {
    // App root: .tw("flex-1 w-full h-screen min-h-0 overflow-hidden")
    const root = makeNode("Column", {
      "flex.0": "1",
      "width.0": "100%",
      "height.0": "100vh",
      "minHeight.0": "0px",
      "overflow.0": "hidden",
    });
    layout(root, 1280, 900);
    expect(root.layout!.height).toBe(900);
    expect(root.layout!.width).toBe(1280);
  });

  test("flex-1 grows a child to fill the remaining main axis", () => {
    const fixed = makeNode("Column", { "height.0": "100px" });
    const grow = makeNode("Column", { "flex.0": "1" });
    const root = makeNode("Column", { "height.0": "100vh" }, [fixed, grow]);
    layout(root, 1280, 900);
    expect(fixed.layout!.height).toBe(100);
    expect(grow.layout!.height).toBe(800);
  });

  test("shrink-0 keeps a sibling at its declared size when space is tight", () => {
    // Featured hero: a flex-1 min-w-0 text column beside a shrink-0 poster.
    const textCol = makeNode("Column", { "flex.0": "1", "minWidth.0": "0px" });
    const poster = makeNode("Image", {
      src: "p.jpg",
      "width.0": "11rem",
      "height.0": "16rem",
      "flexShrink.0": "0",
    });
    const row = makeNode("Row", { "width.0": "400px" }, [textCol, poster]);
    layout(row, 1280, 900);
    expect(poster.layout!.width).toBe(176);
    expect(textCol.layout!.width).toBe(400 - 176);
  });

  test("w-full + max-w + self-center centres a page section", () => {
    // The Hypeflix page pattern: .maxWidth(1280).width("100%").alignSelf("center")
    const section = makeNode("Row", {
      "maxWidth.0": 1280,
      "width.0": "100%",
      "alignSelf.0": "center",
      "height.0": "80px",
    });
    const root = makeNode("Column", { "width.0": "100%" }, [section]);
    layout(root, 1600, 900);
    expect(section.layout!.width).toBe(1280);
    expect(section.layout!.x).toBe((1600 - 1280) / 2);
  });

  test("self-center does not stretch the item across the cross axis", () => {
    const item = makeNode("Column", {
      "alignSelf.0": "center",
      "width.0": "200px",
      "height.0": "50px",
    });
    const root = makeNode("Column", { "width.0": "600px" }, [item]);
    layout(root, 600, 400);
    expect(item.layout!.width).toBe(200);
    expect(item.layout!.x).toBe(200);
  });

  test("calc(100% - 40px) width resolves against the parent content box", () => {
    const child = makeNode("Column", { "width.0": "calc(100% - 40px)", "height.0": "20px" });
    const root = makeNode("Column", { "width.0": "500px" }, [child]);
    layout(root, 800, 600);
    expect(child.layout!.width).toBeCloseTo(460, 0);
  });
});

// ---------------------------------------------------------------------------
// Fixed utility sizes + aspect ratio
// ---------------------------------------------------------------------------

describe("fixed sizes and aspect-ratio", () => {
  test("w-32 h-44 lands as 128x176", () => {
    const poster = makeNode("Image", {
      src: "a.jpg",
      "width.0": "8rem",
      "height.0": "11rem",
      "borderRadius.0": "0.75rem",
    });
    const root = makeNode("Column", {}, [poster]);
    layout(root);
    expect(poster.layout!.width).toBe(128);
    expect(poster.layout!.height).toBe(176);
  });

  test("aspect-video derives height from a known width", () => {
    const box = makeNode("Column", { "aspectRatio.0": "16 / 9", "width.0": "320px" });
    const root = makeNode("Column", {}, [box]);
    layout(root);
    expect(box.layout!.width).toBe(320);
    expect(box.layout!.height).toBeCloseTo(180, 0);
  });

  test("aspect-[2/3] derives height from a known width", () => {
    const box = makeNode("Column", { "aspectRatio.0": "2/3", "width.0": "200px" });
    const root = makeNode("Column", {}, [box]);
    layout(root);
    expect(box.layout!.height).toBeCloseTo(300, 0);
  });
});

// ---------------------------------------------------------------------------
// Responsive md: variants
// ---------------------------------------------------------------------------

describe("responsive md: variants", () => {
  function poster() {
    // .tw("w-32 h-44 md:w-40 md:h-56")
    return makeNode("Image", {
      src: "a.jpg",
      "width.0": "8rem",
      "height.0": "11rem",
      "width@md.0": "10rem",
      "height@md.0": "14rem",
    });
  }

  test("below the md breakpoint the base size wins", () => {
    const p = poster();
    const root = makeNode("Column", {}, [p]);
    layout(root, 640, 800);
    expect(p.layout!.width).toBe(128);
    expect(p.layout!.height).toBe(176);
  });

  test("at/above md (768px) the md: size wins", () => {
    const p = poster();
    const root = makeNode("Column", {}, [p]);
    layout(root, 1280, 900);
    expect(p.layout!.width).toBe(160);
    expect(p.layout!.height).toBe(224);
  });

  test("md: padding widens the page gutter", () => {
    // .tw("px-5 md:px-10")
    const row = makeNode("Row", {
      "paddingLeft.0": "1.25rem",
      "paddingRight.0": "1.25rem",
      "paddingLeft@md.0": "2.5rem",
      "paddingRight@md.0": "2.5rem",
      "height.0": "40px",
      "width.0": "100%",
    });
    const narrow = makeNode("Column", {}, [row]);
    layout(narrow, 640, 400);
    expect(row.layout!.padding.left).toBe(20);

    const wide = makeNode("Column", {}, [makeNode("Row", { ...row.props })]);
    layout(wide, 1280, 400);
    expect(wide.children[0].layout!.padding.left).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// display: none (`hidden md:flex`)
// ---------------------------------------------------------------------------

describe("hidden / md:flex", () => {
  test("display:none takes no space", () => {
    const hidden = makeNode("Column", { "display.0": "none", "height.0": "200px" });
    const after = makeNode("Column", { "height.0": "50px" });
    const root = makeNode("Column", { "height.0": "400px" }, [hidden, after]);
    layout(root, 800, 400);
    expect(hidden.layout!.height).toBe(0);
    expect(after.layout!.y).toBe(0);
  });

  test("md:flex re-enables the node above the breakpoint", () => {
    const props = {
      "display.0": "none",
      "display@md.0": "flex",
      "height.0": "200px",
      "width.0": "100px",
    };
    const wideChild = makeNode("Column", props);
    layout(makeNode("Column", { "height.0": "400px" }, [wideChild]), 1280, 400);
    expect(wideChild.layout!.height).toBe(200);

    const narrowChild = makeNode("Column", props);
    layout(makeNode("Column", { "height.0": "400px" }, [narrowChild]), 640, 400);
    expect(narrowChild.layout!.height).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flow direction for wrapper components
// ---------------------------------------------------------------------------

describe("container flow direction", () => {
  test("Router/Route/unknown module wrappers stack children vertically", () => {
    for (const wrapper of ["Router", "Route", "Browse", "Container"]) {
      const a = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
      const b = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
      const root = makeNode(wrapper, { "width.0": "400px", "height.0": "400px" }, [a, b]);
      layout(root, 800, 600);
      expect(`${wrapper}:${b.layout!.y}`).toBe(`${wrapper}:50`);
      expect(`${wrapper}:${b.layout!.x}`).toBe(`${wrapper}:0`);
    }
  });

  test("Row still flows horizontally, and flex-row flips a Column", () => {
    const a = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const b = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const row = makeNode("Row", { "width.0": "400px", "height.0": "400px" }, [a, b]);
    layout(row, 800, 600);
    expect(b.layout!.x).toBe(100);

    const c = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const d = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const flipped = makeNode(
      "Column",
      { "flexDirection.0": "row", "width.0": "400px", "height.0": "400px" },
      [c, d],
    );
    layout(flipped, 800, 600);
    expect(d.layout!.x).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Horizontally scrollable rails
// ---------------------------------------------------------------------------

describe("scrollable('horizontal') rails", () => {
  test("children keep their full width and overflow the strip", () => {
    const posters = Array.from({ length: 8 }, () =>
      makeNode("Button", { "marginRight.0": "0.75rem" }, [
        makeNode("Image", { src: "a.jpg", "width.0": "10rem", "height.0": "14rem" }),
      ]),
    );
    const rail = makeNode(
      "Row",
      { "scrollable.0": "horizontal", "width.0": "100%", "flexDirection.0": "row" },
      posters,
    );
    const root = makeNode("Column", { "width.0": "100%" }, [rail]);
    layout(root, 800, 600);

    // The strip itself stays inside the viewport …
    expect(rail.layout!.width).toBe(800);
    // … while every poster keeps its declared 160px (no flex-shrink) and the
    // last ones sit past the right edge.
    for (const p of posters) expect(p.layout!.width).toBe(160);
    expect(posters[7].layout!.x).toBeGreaterThan(800);
  });

  test("a vertical page column is not inflated by a horizontal rail", () => {
    const rail = makeNode(
      "Row",
      { "scrollable.0": "horizontal", "width.0": "100%", "flexDirection.0": "row" },
      Array.from({ length: 10 }, () =>
        makeNode("Image", { src: "a.jpg", "width.0": "10rem", "height.0": "14rem" }),
      ),
    );
    const page = makeNode("Column", { "width.0": "100%", "height.0": "100vh" }, [rail]);
    layout(page, 800, 600);
    expect(page.layout!.width).toBe(800);
  });
});
