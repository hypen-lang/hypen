/**
 * Canvas variant (responsive breakpoint + interaction state) tests.
 *
 * Covers:
 *  - the shared, renderer-agnostic resolver in packages/web/src/variants.ts
 *    (parse + precedence), and
 *  - the canvas-side application pass in packages/web/src/canvas/variants.ts
 *    (stamping winners onto base props from a VirtualNode, reversibly).
 *
 * These intentionally avoid importing the full CanvasRenderer (which pulls in
 * text.ts -> @chenglou/pretext, an optional dep not installed in CI).
 */

import { describe, expect, test } from "bun:test";
import {
  parseVariantKey,
  resolveVariantProps,
  hasVariantProps,
  BREAKPOINTS,
  VALID_STATES,
} from "../packages/web/src/variants.js";
import {
  applyVariants,
  deriveNodeComputed,
  invalidateVariantCache,
} from "../packages/web/src/canvas/variants.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

// --- Test helpers -----------------------------------------------------------

function makeNode(props: Record<string, unknown>): VirtualNode {
  return {
    id: "n1",
    type: "Column",
    props,
    children: [],
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: true,
    focusable: false,
    focused: false,
    hovered: false,
  };
}

// --- Shared resolver: parsing ----------------------------------------------

describe("parseVariantKey", () => {
  test("plain key with arg suffix", () => {
    expect(parseVariantKey("padding.0")).toEqual({
      base: "padding",
      breakpoint: null,
      state: null,
      arg: "0",
    });
  });

  test("breakpoint between base and arg suffix (the fixed bug)", () => {
    expect(parseVariantKey("padding@md.0")).toEqual({
      base: "padding",
      breakpoint: "md",
      state: null,
      arg: "0",
    });
  });

  test("state variant with arg suffix", () => {
    expect(parseVariantKey("backgroundColor:hover.0")).toEqual({
      base: "backgroundColor",
      breakpoint: null,
      state: "hover",
      arg: "0",
    });
  });

  test("combined breakpoint + state with arg suffix", () => {
    expect(parseVariantKey("backgroundColor@md:hover.0")).toEqual({
      base: "backgroundColor",
      breakpoint: "md",
      state: "hover",
      arg: "0",
    });
  });

  test("hyphenated state (focus-within) is recognised, not split on its dash", () => {
    expect(parseVariantKey("borderColor:focus-within.0")).toEqual({
      base: "borderColor",
      breakpoint: null,
      state: "focus-within",
      arg: "0",
    });
  });

  test("no arg suffix", () => {
    expect(parseVariantKey("backgroundColor@md:hover")).toEqual({
      base: "backgroundColor",
      breakpoint: "md",
      state: "hover",
      arg: null,
    });
  });

  test("unknown breakpoint is left attached to base (never matches a real bp)", () => {
    const p = parseVariantKey("padding@invalid.0");
    expect(p.breakpoint).toBeNull();
    expect(p.base).toBe("padding@invalid");
  });

  test("breakpoint table matches Tailwind px", () => {
    expect(BREAKPOINTS).toEqual({ sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 });
  });

  test("state set matches the DOM list", () => {
    expect([...VALID_STATES].sort()).toEqual(
      ["active", "disabled", "focus", "focus-visible", "focus-within", "hover"].sort(),
    );
  });
});

describe("hasVariantProps", () => {
  test("true when a variant key is present", () => {
    expect(hasVariantProps({ "padding@md": 16, padding: 8 })).toBe(true);
    expect(hasVariantProps({ "backgroundColor:hover": "red" })).toBe(true);
  });
  test("false for plain props only", () => {
    expect(hasVariantProps({ padding: 8, "padding.0": 8, backgroundColor: "red" })).toBe(false);
  });
});

// --- Shared resolver: breakpoint resolution --------------------------------

describe("resolveVariantProps - breakpoints", () => {
  const props = { padding: 8, "padding@md": 16, "padding@lg": 24 };

  test("narrow width keeps base", () => {
    expect(resolveVariantProps(props, 500, {}).padding).toBe(8);
  });

  test("md width applies md", () => {
    expect(resolveVariantProps(props, 800, {}).padding).toBe(16);
  });

  test("lg width applies lg (highest matching breakpoint wins)", () => {
    expect(resolveVariantProps(props, 1100, {}).padding).toBe(24);
  });

  test("exact breakpoint boundary is inclusive (width >= min-width)", () => {
    expect(resolveVariantProps(props, 768, {}).padding).toBe(16);
  });
});

// --- Shared resolver: state resolution & precedence ------------------------

describe("resolveVariantProps - state precedence", () => {
  const props = {
    backgroundColor: "white",
    "backgroundColor:hover": "gray",
    "backgroundColor:active": "black",
    "backgroundColor:disabled": "lightgray",
  };

  test("base when no states active", () => {
    expect(resolveVariantProps(props, 1000, {}).backgroundColor).toBe("white");
  });

  test("hover beats base", () => {
    expect(resolveVariantProps(props, 1000, { hover: true }).backgroundColor).toBe("gray");
  });

  test("active beats hover", () => {
    expect(
      resolveVariantProps(props, 1000, { hover: true, active: true }).backgroundColor,
    ).toBe("black");
  });

  test("disabled is the lowest state tier (hover beats disabled)", () => {
    expect(
      resolveVariantProps(props, 1000, { disabled: true, hover: true }).backgroundColor,
    ).toBe("gray");
  });

  test("state outranks breakpoint", () => {
    const p = { color: "a", "color@2xl": "b", "color:hover": "c" };
    expect(resolveVariantProps(p, 2000, { hover: true }).color).toBe("c");
  });
});

describe("resolveVariantProps - combined @bp:state", () => {
  const props = {
    backgroundColor: "base",
    "backgroundColor:hover": "hover",
    "backgroundColor@md:hover": "mdHover",
  };

  test("requires BOTH md width AND hover", () => {
    // hover only, narrow -> plain hover
    expect(resolveVariantProps(props, 500, { hover: true }).backgroundColor).toBe("hover");
    // md width but no hover -> base
    expect(resolveVariantProps(props, 900, {}).backgroundColor).toBe("base");
    // both -> combined wins (higher breakpoint tier within the hover state tier)
    expect(resolveVariantProps(props, 900, { hover: true }).backgroundColor).toBe("mdHover");
  });
});

// --- Canvas application pass -----------------------------------------------

describe("applyVariants (canvas) - stamps winners onto base props", () => {
  test("breakpoint winner stamped onto base key for layout/paint to read", () => {
    const node = makeNode({ padding: 8, "padding@md": 16 });

    applyVariants(node, 500);
    expect(node.props.padding).toBe(8);

    applyVariants(node, 900);
    expect(node.props.padding).toBe(16);
  });

  test("reversible: shrinking back below breakpoint restores base", () => {
    const node = makeNode({ padding: 8, "padding@md": 16 });
    applyVariants(node, 900);
    expect(node.props.padding).toBe(16);
    applyVariants(node, 500);
    expect(node.props.padding).toBe(8);
  });

  test("hover state from node.hovered resolves backgroundColor", () => {
    const node = makeNode({ backgroundColor: "white", "backgroundColor:hover": "gray" });

    applyVariants(node, 1000);
    expect(node.props.backgroundColor).toBe("white");

    node.hovered = true;
    applyVariants(node, 1000);
    expect(node.props.backgroundColor).toBe("gray");

    node.hovered = false;
    applyVariants(node, 1000);
    expect(node.props.backgroundColor).toBe("white");
  });

  test("active (pressed) beats hover", () => {
    const node = makeNode({
      backgroundColor: "white",
      "backgroundColor:hover": "gray",
      "backgroundColor:active": "black",
    });
    node.hovered = true;
    node.pressed = true;
    applyVariants(node, 1000);
    expect(node.props.backgroundColor).toBe("black");
  });

  test("disabled derived from disabled prop", () => {
    const node = makeNode({
      opacity: 1,
      "opacity:disabled": 0.5,
      disabled: true,
    });
    applyVariants(node, 1000);
    expect(node.props.opacity).toBe(0.5);
  });

  test("variant-only base (no plain value) is removed when no variant applies", () => {
    // backgroundColor exists ONLY as a hover variant; with hover off it should
    // not leak a value onto the base key.
    const node = makeNode({ "backgroundColor:hover": "gray" });
    applyVariants(node, 1000);
    expect("backgroundColor" in node.props).toBe(false);
    node.hovered = true;
    applyVariants(node, 1000);
    expect(node.props.backgroundColor).toBe("gray");
    node.hovered = false;
    applyVariants(node, 1000);
    expect("backgroundColor" in node.props).toBe(false);
  });

  test("plain nodes are untouched (no variant keys)", () => {
    const node = makeNode({ padding: 8, backgroundColor: "white" });
    applyVariants(node, 2000);
    expect(node.props).toEqual({ padding: 8, backgroundColor: "white" });
  });

  test("recurses into children", () => {
    const parent = makeNode({});
    const child = makeNode({ padding: 8, "padding@md": 16 });
    child.parent = parent;
    parent.children = [child];
    applyVariants(parent, 900);
    expect(child.props.padding).toBe(16);
  });

  test("normalized `.0` keys also resolve (engine wire format)", () => {
    // After applicator normalization the node carries both `padding@md` and
    // `padding@md.0`; the resolver must pick the same winner regardless.
    const node = makeNode({
      padding: 8,
      "padding.0": 8,
      "padding@md": 16,
      "padding@md.0": 16,
    });
    applyVariants(node, 900);
    expect(node.props.padding).toBe(16);
  });
});

// --- Cached computed fields refresh after variant resolution ---------------

describe("deriveNodeComputed (cache refresh after variant pass)", () => {
  test("derives visible/opacity defaults when props absent", () => {
    const node = makeNode({});
    node.visible = false; // stale
    node.opacity = 0.1; // stale
    deriveNodeComputed(node);
    expect(node.visible).toBe(true);
    expect(node.opacity).toBe(1);
  });

  test("opacity:0 is honored (not coerced to default 1)", () => {
    const node = makeNode({ opacity: 0 });
    deriveNodeComputed(node);
    expect(node.opacity).toBe(0);
  });

  test("visible:disabled variant refreshes the cached node.visible (the fixed bug)", () => {
    // Before the fix, applyVariants stamped props.visible=false but the cached
    // node.visible (read by paint/hit-test) stayed true, so the variant no-op'd.
    const node = makeNode({ visible: true, "visible:disabled": false });
    node.props = resolveVariantProps(node.props, 1000, { disabled: true });
    deriveNodeComputed(node);
    expect(node.props.visible).toBe(false);
    expect(node.visible).toBe(false);
  });

  test("visible@md variant refreshes the cached node.visible at wide width", () => {
    const node = makeNode({ visible: false, "visible@md": true });
    node.props = resolveVariantProps(node.props, 900, {});
    deriveNodeComputed(node);
    expect(node.visible).toBe(true);
  });

  test("opacity:disabled variant refreshes the cached node.opacity", () => {
    const node = makeNode({ opacity: 1, "opacity:disabled": 0.5 });
    node.props = resolveVariantProps(node.props, 1000, { disabled: true });
    deriveNodeComputed(node);
    expect(node.opacity).toBe(0.5);
  });
});

// --- SetProp on a base value must survive the per-frame variant restore ------

describe("invalidateVariantCache (base-value SetProp not clobbered)", () => {
  test("base SetProp wins after invalidation when the variant is inactive", () => {
    // padding base 8 + a @md variant; render narrow so md is inactive.
    const node = makeNode({ padding: 8, "padding@md": 16 });
    applyVariants(node, 500); // frame 1: snapshots originals { padding: 8 }
    expect(node.props.padding).toBe(8);

    // Engine sends SetProp updating the BASE value; renderer invalidates.
    node.props.padding = 20;
    invalidateVariantCache(node);

    applyVariants(node, 500); // frame 2: must keep 20, not restore stale 8
    expect(node.props.padding).toBe(20);
  });

  test("base SetProp is honored once the active variant later turns off", () => {
    const node = makeNode({ padding: 8, "padding@md": 16 });
    applyVariants(node, 900); // md active -> 16 wins
    expect(node.props.padding).toBe(16);

    node.props.padding = 20; // SetProp on base while variant active
    invalidateVariantCache(node);

    applyVariants(node, 900); // md still active -> variant still wins
    expect(node.props.padding).toBe(16);

    applyVariants(node, 500); // md inactive -> the NEW base (20), not stale 8
    expect(node.props.padding).toBe(20);
  });
});
