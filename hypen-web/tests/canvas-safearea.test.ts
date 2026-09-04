/**
 * SafeArea — Canvas layout
 *
 * Canvas paints its own pixels, so it resolves the safe-area insets to
 * NUMBERS: the value probed from `env(safe-area-inset-*)` (0 outside a
 * browser), with the embedder's per-edge overrides merged over it.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { computeLayout, setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import {
  getEffectiveSafeAreaInsets,
  probeSafeAreaInsets,
  resetSafeAreaProbe,
  resolveSafeAreaEdges,
  setSafeAreaInsetOverrides,
} from "../packages/web/src/safe-area.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

class MockCanvasContext {
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  save() {}
  restore() {}
  set font(value: string) {}
}

function node(
  type: string,
  props: Record<string, any> = {},
  children: VirtualNode[] = [],
): VirtualNode {
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
  };
  for (const child of children) child.parent = n;
  return n;
}

// The JS flex backend is the one available in this runner (no Taffy WASM);
// pinning it for the file keeps the assertions about a single backend honest
// (same pattern as canvas-tw-fallback.test.ts).
beforeAll(() => setLayoutBackend("fallback"));
afterAll(() => setLayoutBackend("auto"));

describe("Canvas SafeArea layout", () => {
  let ctx: MockCanvasContext;

  beforeEach(() => {
    ctx = new MockCanvasContext();
    setSafeAreaInsetOverrides({ top: 44, right: 8, bottom: 34, left: 8 });
  });

  afterEach(() => {
    setSafeAreaInsetOverrides(null);
  });

  test("fills the available space like App", () => {
    const sa = node("SafeArea");

    computeLayout(ctx as any, sa, 800, 600, 0, 0);

    expect(sa.layout!.width).toBe(800);
    expect(sa.layout!.height).toBe(600);
  });

  test("pads every edge by default", () => {
    const sa = node("SafeArea");

    computeLayout(ctx as any, sa, 800, 600, 0, 0);

    expect(sa.layout!.padding).toEqual({ top: 44, right: 8, bottom: 34, left: 8 });
    expect(sa.layout!.contentWidth).toBe(800 - 8 - 8);
    expect(sa.layout!.contentHeight).toBe(600 - 44 - 34);
  });

  test("children are laid out inside the insets, vertically", () => {
    const first = node("container", { width: 100, height: 50 });
    const second = node("container", { width: 100, height: 50 });
    const sa = node("SafeArea", {}, [first, second]);

    computeLayout(ctx as any, sa, 800, 600, 0, 0);

    expect(first.layout!.x).toBe(8);
    expect(first.layout!.y).toBe(44);
    // Vertical stack: the second child sits below the first.
    expect(second.layout!.x).toBe(8);
    expect(second.layout!.y).toBe(94);
  });

  test("`edges` filters which edges are padded", () => {
    const sa = node("SafeArea", { edges: ["top", "bottom"] });

    computeLayout(ctx as any, sa, 800, 600, 0, 0);

    expect(sa.layout!.padding).toEqual({ top: 44, right: 0, bottom: 34, left: 0 });
  });

  test("an absent / empty `edges` prop means all four edges", () => {
    for (const edges of [undefined, [], ["", "  "]]) {
      const sa = node("SafeArea", edges === undefined ? {} : { edges });
      computeLayout(ctx as any, sa, 800, 600, 0, 0);
      expect(sa.layout!.padding).toEqual({ top: 44, right: 8, bottom: 34, left: 8 });
    }
  });

  test("an explicit list of only unknown edges insets nothing", () => {
    // Honored literally rather than widening back to all four — matches
    // the Swift, Android, and desktop renderers.
    const sa = node("SafeArea", { edges: ["diagonal"] });
    computeLayout(ctx as any, sa, 800, 600, 0, 0);
    expect(sa.layout!.padding).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("authored padding adds to the safe-area inset", () => {
    const sa = node("SafeArea", { padding: 16 });

    computeLayout(ctx as any, sa, 800, 600, 0, 0);

    expect(sa.layout!.padding).toEqual({
      top: 44 + 16,
      right: 8 + 16,
      bottom: 34 + 16,
      left: 8 + 16,
    });
  });

  test("nested SafeAreas each apply their own insets", () => {
    const inner = node("SafeArea", { edges: ["bottom"] });
    const outer = node("SafeArea", {}, [inner]);

    computeLayout(ctx as any, outer, 800, 600, 0, 0);

    expect(outer.layout!.padding.top).toBe(44);
    expect(inner.layout!.padding).toEqual({ top: 0, right: 0, bottom: 34, left: 0 });
  });

  test("other component types are untouched by the insets", () => {
    const col = node("Column", { width: 100, height: 100 });

    computeLayout(ctx as any, col, 800, 600, 0, 0);

    expect(col.layout!.padding).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("Safe-area inset resolution", () => {
  const g = globalThis as any;
  let savedDocument: any;
  let savedGetComputedStyle: any;

  beforeEach(() => {
    savedDocument = g.document;
    savedGetComputedStyle = g.getComputedStyle;
  });

  afterEach(() => {
    g.document = savedDocument;
    g.getComputedStyle = savedGetComputedStyle;
    setSafeAreaInsetOverrides(null);
    resetSafeAreaProbe();
  });

  test("no browser to probe → zeros", () => {
    delete g.document;
    delete g.getComputedStyle;
    resetSafeAreaProbe();

    expect(probeSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("overrides merge per edge over the probed defaults", () => {
    // Stand in for a browser that reports real insets from `env()`.
    resetSafeAreaProbe();
    g.document = {
      createElement: () => ({ style: { setProperty() {} }, remove() {} }),
      body: { appendChild() {} },
    };
    g.getComputedStyle = () => ({
      getPropertyValue: (name: string) =>
        ({
          "padding-top": "20px",
          "padding-right": "10px",
          "padding-bottom": "30px",
          "padding-left": "10px",
        })[name] ?? "",
    });

    expect(probeSafeAreaInsets()).toEqual({ top: 20, right: 10, bottom: 30, left: 10 });

    // An explicit 0 zeroes ONLY that edge; the rest keep the probed default.
    setSafeAreaInsetOverrides({ bottom: 0 });
    expect(getEffectiveSafeAreaInsets()).toEqual({
      top: 20,
      right: 10,
      bottom: 0,
      left: 10,
    });
  });

  test("edges parsing accepts arrays, JSON, and delimited strings", () => {
    expect([...resolveSafeAreaEdges(["top", "left"])].sort()).toEqual(["left", "top"]);
    expect([...resolveSafeAreaEdges('["bottom"]')]).toEqual(["bottom"]);
    expect([...resolveSafeAreaEdges("top, right")].sort()).toEqual(["right", "top"]);
    expect([...resolveSafeAreaEdges(undefined)].sort()).toEqual([
      "bottom",
      "left",
      "right",
      "top",
    ]);
  });
});
