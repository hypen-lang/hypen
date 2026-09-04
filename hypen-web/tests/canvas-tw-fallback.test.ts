/**
 * Canvas Tailwind/layout coverage — JS fallback backend.
 *
 * `setLayoutBackend("fallback")` pins the pure-JS flex path for this file.
 * That is not a test-only curiosity: the browser build resolves the Taffy
 * WASM over the network, so any deployment that does not serve
 * `taffy_wasm_bg.wasm` (the Hypeflix Cloudflare worker, for one) renders
 * every frame through this code. Pinning is required because Bun shares one
 * process across test files and `initTaffyLayout()` is a one-way, global
 * switch — without the pin these assertions would silently run against Taffy
 * depending on file order.
 *
 * The regression this file exists for: the fallback used to *measure* a child
 * by laying it out at the origin and only afterwards move the child itself,
 * so grandchildren kept coordinates relative to (0,0) and every nested
 * subtree painted in a band at the top of the canvas.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { computeLayout, setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import { normalizeAllApplicators } from "../packages/web/src/canvas/props.js";
import { applyVariants } from "../packages/web/src/canvas/variants.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

beforeAll(() => setLayoutBackend("fallback"));
afterAll(() => setLayoutBackend("auto"));

class MockCtx {
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  save() {}
  restore() {}
  set font(_v: string) {}
}
const ctx = new MockCtx() as unknown as CanvasRenderingContext2D;

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

function layout(root: VirtualNode, w = 1280, h = 900): void {
  applyVariants(root, w);
  computeLayout(ctx, root, w, h, 0, 0);
}

// ---------------------------------------------------------------------------
// Absolute coordinates through nesting — the core fallback regression
// ---------------------------------------------------------------------------

describe("nested subtree positions are absolute", () => {
  test("a grandchild is offset by every ancestor, not left at the origin", () => {
    const leaf = makeNode("Column", { "width.0": "40px", "height.0": "40px" });
    const mid = makeNode("Column", { "padding.0": "10px" }, [leaf]);
    const outer = makeNode("Column", { "padding.0": "20px" }, [mid]);
    const root = makeNode("Column", { "padding.0": "5px", "width.0": "400px" }, [outer]);

    layout(root, 400, 400);

    expect(root.layout!.x).toBe(0);
    expect(outer.layout!.x).toBe(5);
    expect(mid.layout!.x).toBe(25);
    expect(leaf.layout!.x).toBe(35);
    expect(leaf.layout!.y).toBe(35);
  });

  test("a section pushed down the page carries its whole subtree with it", () => {
    const title = makeNode("Text", { 0: "Trending now", "fontSize.0": "18px" });
    const rail = makeNode("Row", { "height.0": "200px" }, [
      makeNode("Image", { src: "a.jpg", "width.0": "10rem", "height.0": "14rem" }),
    ]);
    const spacerA = makeNode("Column", { "height.0": "300px" });
    const spacerB = makeNode("Column", { "height.0": "150px" });
    const page = makeNode("Column", { "width.0": "1280px" }, [
      spacerA,
      spacerB,
      title,
      rail,
    ]);

    layout(page, 1280, 900);

    expect(title.layout!.y).toBe(450);
    expect(rail.layout!.y).toBe(450 + title.layout!.height);
    // The rail's poster must sit inside the rail, not at the top of the page.
    expect(rail.children[0].layout!.y).toBe(rail.layout!.y);
    expect(rail.children[0].layout!.y).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// Flex sizing on the fallback path
// ---------------------------------------------------------------------------

describe("fallback flex sizing", () => {
  test("h-screen fills the canvas", () => {
    const root = makeNode("Column", {
      "flex.0": "1",
      "width.0": "100%",
      "height.0": "100vh",
      "minHeight.0": "0px",
      "overflow.0": "hidden",
    });
    layout(root, 1280, 900);
    expect(root.layout!.height).toBe(900);
  });

  test("flex-1 distributes the free main-axis space", () => {
    const header = makeNode("Column", { "height.0": "80px" });
    const body = makeNode("Column", { "flex.0": "1" });
    const footer = makeNode("Column", { "height.0": "60px" });
    const root = makeNode("Column", { "height.0": "100vh" }, [header, body, footer]);
    layout(root, 1280, 900);
    expect(body.layout!.height).toBe(900 - 80 - 60);
    expect(footer.layout!.y).toBe(840);
  });

  test("two flex-1 siblings in a Row split the width evenly", () => {
    const a = makeNode("Column", { "flex.0": "1" });
    const b = makeNode("Column", { "flex.0": "1" });
    const row = makeNode("Row", { "width.0": "600px", "height.0": "100px" }, [a, b]);
    layout(row, 800, 400);
    expect(a.layout!.width).toBe(300);
    expect(b.layout!.width).toBe(300);
    expect(b.layout!.x).toBe(300);
  });

  test("shrink-0 protects a poster next to a flex-1 text column", () => {
    const textCol = makeNode("Column", { "flex.0": "1", "minWidth.0": "0px" });
    const poster = makeNode("Image", {
      src: "p.jpg",
      "width.0": "11rem",
      "height.0": "16rem",
      "flexShrink.0": "0",
    });
    const row = makeNode("Row", { "width.0": "400px", "height.0": "300px" }, [
      textCol,
      poster,
    ]);
    layout(row, 1280, 900);
    expect(poster.layout!.width).toBe(176);
    expect(textCol.layout!.width).toBe(224);
    expect(poster.layout!.x).toBe(224);
  });

  test("max-w + w-full + self-center centres a page section", () => {
    const section = makeNode("Row", {
      "maxWidth.0": 1280,
      "width.0": "100%",
      "alignSelf.0": "center",
      "height.0": "80px",
    });
    const root = makeNode("Column", { "width.0": "100%" }, [section]);
    layout(root, 1600, 900);
    expect(section.layout!.width).toBe(1280);
    expect(section.layout!.x).toBe(160);
  });

  test("an auto-width self-center card shrinks to fit a narrow viewport", () => {
    // Hypeflix's hero: mx-5, max-w-[1200], self-center, content-sized.
    const card = makeNode(
      "Row",
      {
        "marginLeft.0": "1.25rem",
        "marginRight.0": "1.25rem",
        "maxWidth.0": 1200,
        "alignSelf.0": "center",
        "height.0": "200px",
      },
      [makeNode("Column", { "width.0": "3000px", "height.0": "10px" })],
    );
    const root = makeNode("Column", { "width.0": "100%" }, [card]);
    layout(root, 640, 800);
    // 640 viewport − 20px margins on each side.
    expect(card.layout!.width).toBe(600);
    expect(card.layout!.x).toBe(20);
  });

  test("percentage and calc widths resolve against the parent content box", () => {
    const half = makeNode("Column", { "width.0": "50%", "height.0": "10px" });
    const calc = makeNode("Column", { "width.0": "calc(100% - 40px)", "height.0": "10px" });
    const root = makeNode("Column", { "width.0": "500px", "padding.0": "0px" }, [half, calc]);
    layout(root, 800, 600);
    expect(half.layout!.width).toBe(250);
    expect(calc.layout!.width).toBe(460);
  });

  test("min/max constraints clamp a flexed item", () => {
    const item = makeNode("Column", { "flex.0": "1", "maxWidth.0": "120px" });
    const rest = makeNode("Column", { "flex.0": "1" });
    const row = makeNode("Row", { "width.0": "600px", "height.0": "50px" }, [item, rest]);
    layout(row, 800, 400);
    expect(item.layout!.width).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

describe("fallback alignment", () => {
  test("items-center centres children on the cross axis of a Row", () => {
    const child = makeNode("Column", { "width.0": "50px", "height.0": "40px" });
    const row = makeNode(
      "Row",
      { "width.0": "300px", "height.0": "100px", "alignItems.0": "center" },
      [child],
    );
    layout(row, 800, 400);
    expect(child.layout!.y).toBe(30);
  });

  test("justify-center centres children on the main axis", () => {
    const child = makeNode("Column", { "width.0": "100px", "height.0": "40px" });
    const row = makeNode(
      "Row",
      { "width.0": "300px", "height.0": "100px", "justifyContent.0": "center" },
      [child],
    );
    layout(row, 800, 400);
    expect(child.layout!.x).toBe(100);
  });

  test("Column children stretch to the container width by default", () => {
    const child = makeNode("Column", { "height.0": "40px" });
    const col = makeNode("Column", { "width.0": "300px", "height.0": "100px" }, [child]);
    layout(col, 800, 400);
    expect(child.layout!.width).toBe(300);
  });

  test("items-start opts a Column's children out of the stretch", () => {
    const child = makeNode("Column", { "height.0": "40px", "width.0": "60px" });
    const col = makeNode(
      "Column",
      { "width.0": "300px", "height.0": "100px", "alignItems.0": "start" },
      [child],
    );
    layout(col, 800, 400);
    expect(child.layout!.width).toBe(60);
    expect(child.layout!.x).toBe(0);
  });

  test("gap separates children", () => {
    const a = makeNode("Column", { "height.0": "20px" });
    const b = makeNode("Column", { "height.0": "20px" });
    const col = makeNode("Column", { "width.0": "200px", "gap.0": "12px" }, [a, b]);
    layout(col, 400, 400);
    expect(b.layout!.y).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Flow direction for wrapper components
// ---------------------------------------------------------------------------

describe("fallback flow direction", () => {
  test("module wrappers and Router/Route stack children vertically", () => {
    for (const wrapper of ["Router", "Route", "Browse", "Container", "App"]) {
      const a = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
      const b = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
      const root = makeNode(wrapper, { "width.0": "400px", "height.0": "400px" }, [a, b]);
      layout(root, 800, 600);
      expect(`${wrapper}:${b.layout!.y}`).toBe(`${wrapper}:50`);
    }
  });

  test("Row flows horizontally", () => {
    const a = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const b = makeNode("Column", { "height.0": "50px", "width.0": "100px" });
    const row = makeNode("Row", { "width.0": "400px", "height.0": "400px" }, [a, b]);
    layout(row, 800, 600);
    expect(b.layout!.x).toBe(100);
    expect(b.layout!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Responsive, aspect-ratio, display:none on the fallback path
// ---------------------------------------------------------------------------

describe("fallback tailwind utilities", () => {
  test("md: sizes resolve against the canvas width", () => {
    const props = {
      src: "a.jpg",
      "width.0": "8rem",
      "height.0": "11rem",
      "width@md.0": "10rem",
      "height@md.0": "14rem",
    };
    const narrow = makeNode("Image", { ...props });
    layout(makeNode("Column", {}, [narrow]), 640, 800);
    expect(narrow.layout!.width).toBe(128);

    const wide = makeNode("Image", { ...props });
    layout(makeNode("Column", {}, [wide]), 1280, 900);
    expect(wide.layout!.width).toBe(160);
  });

  test("aspect-video and aspect-[2/3] derive the missing axis", () => {
    const video = makeNode("Column", { "aspectRatio.0": "16 / 9", "width.0": "320px" });
    const poster = makeNode("Column", { "aspectRatio.0": "2/3", "width.0": "200px" });
    layout(makeNode("Column", { "alignItems.0": "start" }, [video, poster]), 800, 600);
    expect(video.layout!.height).toBeCloseTo(180, 0);
    expect(poster.layout!.height).toBeCloseTo(300, 0);
  });

  test("display:none takes no space and md:flex restores it", () => {
    const hidden = makeNode("Column", { "display.0": "none", "height.0": "200px" });
    const after = makeNode("Column", { "height.0": "50px" });
    layout(makeNode("Column", { "height.0": "400px" }, [hidden, after]), 800, 400);
    expect(hidden.layout!.height).toBe(0);
    expect(after.layout!.y).toBe(0);

    const shown = makeNode("Column", {
      "display.0": "none",
      "display@md.0": "flex",
      "height.0": "200px",
    });
    layout(makeNode("Column", { "height.0": "400px" }, [shown]), 1280, 400);
    expect(shown.layout!.height).toBe(200);
  });

  test("unitless line-height gives a text-5xl heading a real line box", () => {
    // text-5xl → font-size 3rem, line-height "1" (a multiplier, not 1px).
    const heading = makeNode("Text", {
      0: "Night of the Living Dead",
      "fontSize.0": "3rem",
      "lineHeight.0": "1",
    });
    const after = makeNode("Text", { 0: "1968 · Horror", "fontSize.0": "13px" });
    const col = makeNode("Column", { "width.0": "1200px", "alignItems.0": "start" }, [
      heading,
      after,
    ]);
    layout(col, 1280, 900);
    expect(heading.layout!.height).toBeGreaterThanOrEqual(48);
    expect(after.layout!.y).toBeGreaterThanOrEqual(48);
  });

  test("tracking widens a heading's measured box", () => {
    const base = makeNode("Text", { 0: "HYPEFLIX", "fontSize.0": "1.5rem" });
    const tracked = makeNode("Text", {
      0: "HYPEFLIX",
      "fontSize.0": "1.5rem",
      "letterSpacing.0": "0.2em",
    });
    layout(makeNode("Column", { "alignItems.0": "start" }, [base]), 1280, 900);
    layout(makeNode("Column", { "alignItems.0": "start" }, [tracked]), 1280, 900);
    expect(tracked.layout!.width).toBeGreaterThan(base.layout!.width);
  });
});

// ---------------------------------------------------------------------------
// Scrollable rails
// ---------------------------------------------------------------------------

describe("fallback scrollable rails", () => {
  test("posters keep their width and overflow the strip", () => {
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

    expect(rail.layout!.width).toBe(800);
    for (const p of posters) expect(p.layout!.width).toBe(160);
    // 8 posters at 160 + 12px margins = 1376 > 800, so the tail overflows.
    expect(posters[7].layout!.x).toBeGreaterThan(800);
    // …and each poster is still positioned inside the rail vertically.
    expect(posters[7].layout!.y).toBe(rail.layout!.y);
  });

  test("the rail does not inflate the page column that holds it", () => {
    const rail = makeNode(
      "Row",
      { "scrollable.0": "horizontal", "flexDirection.0": "row", "width.0": "100%" },
      Array.from({ length: 10 }, () =>
        makeNode("Image", { src: "a.jpg", "width.0": "10rem", "height.0": "14rem" }),
      ),
    );
    const page = makeNode("Column", { "width.0": "100%", "height.0": "100vh" }, [rail]);
    layout(page, 800, 600);
    expect(page.layout!.width).toBe(800);
    expect(rail.layout!.width).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// Absolute positioning
// ---------------------------------------------------------------------------

describe("fallback absolute positioning", () => {
  test("an absolute child is placed against the parent's content box", () => {
    const overlay = makeNode("Column", {
      "position.0": "absolute",
      "top.0": "10px",
      "left.0": "20px",
      "width.0": "50px",
      "height.0": "30px",
    });
    const flow = makeNode("Column", { "height.0": "40px" });
    const parent = makeNode(
      "Column",
      { "width.0": "300px", "height.0": "200px", "padding.0": "5px" },
      [overlay, flow],
    );
    layout(parent, 800, 400);
    expect(overlay.layout!.x).toBe(25);
    expect(overlay.layout!.y).toBe(15);
    // Out of flow: the in-flow sibling still starts at the content origin.
    expect(flow.layout!.y).toBe(5);
  });

  test("opposite insets pin both edges", () => {
    const stretched = makeNode("Column", {
      "position.0": "absolute",
      "left.0": "10px",
      "right.0": "10px",
      "top.0": "0px",
      "bottom.0": "0px",
    });
    const parent = makeNode("Column", { "width.0": "300px", "height.0": "200px" }, [
      stretched,
    ]);
    layout(parent, 800, 400);
    expect(stretched.layout!.width).toBe(280);
    expect(stretched.layout!.height).toBe(200);
  });
});
