/**
 * Canvas per-axis gaps.
 *
 * `rowGap` / `columnGap` are registered applicators on DOM, Android and
 * Swift. The canvas only ever read the `gap` shorthand, so a per-axis gap was
 * silently dropped and children packed flush against each other.
 */

import { test, expect, describe } from "bun:test";
import { computeLayout } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

class MockCanvasContext {
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  save() {}
  restore() {}
  set font(value: string) {}
}

const leaf = (id: string): VirtualNode =>
  ({
    id,
    type: "container",
    props: { width: 20, height: 10 },
    children: [],
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
  }) as VirtualNode;

const container = (type: string, props: Record<string, any>): VirtualNode => {
  const node = {
    id: "root",
    type,
    props: { width: 400, height: 400, ...props },
    children: [leaf("a"), leaf("b")],
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
  } as VirtualNode;
  for (const child of node.children) (child as any).parent = node;
  return node;
};

/** Distance between the two children along the container's main axis. */
const separation = (node: VirtualNode, axis: "x" | "y"): number => {
  const [a, b] = node.children as any[];
  return axis === "y"
    ? b.layout.y - (a.layout.y + a.layout.height)
    : b.layout.x - (a.layout.x + a.layout.width);
};

describe("Canvas per-axis gap", () => {
  test("rowGap separates children of a column", () => {
    const node = container("column", { rowGap: 24 });
    computeLayout(new MockCanvasContext() as any, node, 400, 400, 0, 0);
    expect(separation(node, "y")).toBeCloseTo(24, 0);
  });

  test("columnGap separates children of a row", () => {
    const node = container("row", { columnGap: 18 });
    computeLayout(new MockCanvasContext() as any, node, 400, 400, 0, 0);
    expect(separation(node, "x")).toBeCloseTo(18, 0);
  });

  test("the gap shorthand still works", () => {
    const node = container("column", { gap: 12 });
    computeLayout(new MockCanvasContext() as any, node, 400, 400, 0, 0);
    expect(separation(node, "y")).toBeCloseTo(12, 0);
  });

  test("a per-axis gap overrides the shorthand on that axis", () => {
    const node = container("column", { gap: 4, rowGap: 30 });
    computeLayout(new MockCanvasContext() as any, node, 400, 400, 0, 0);
    expect(separation(node, "y")).toBeCloseTo(30, 0);
  });

  test("the off-axis gap does not leak into the main axis", () => {
    // columnGap is the between-columns gap; a column flow must ignore it.
    const node = container("column", { columnGap: 40 });
    computeLayout(new MockCanvasContext() as any, node, 400, 400, 0, 0);
    expect(separation(node, "y")).toBeCloseTo(0, 0);
  });
});
