/**
 * Canvas Layout Engine Tests
 * 
 * Tests flexbox-like layout calculations
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { computeLayout } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

// Mock canvas context for text measurement
class MockCanvasContext {
  measureText(text: string) {
    // Simple estimation: 8px per character
    return { width: text.length * 8 };
  }

  save() {}
  restore() {}
  set font(value: string) {}
}

describe("Canvas Layout Engine", () => {
  let ctx: MockCanvasContext;

  beforeEach(() => {
    ctx = new MockCanvasContext();
  });

  describe("Basic Box Layout", () => {
    test("computes simple box with explicit size", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { width: 100, height: 50 },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout).toBeDefined();
      expect(node.layout!.width).toBe(100);
      expect(node.layout!.height).toBe(50);
      expect(node.layout!.x).toBe(0);
      expect(node.layout!.y).toBe(0);
    });

    test("computes box with padding", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { width: 100, height: 50, padding: 10 },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout!.padding).toEqual({
        top: 10,
        right: 10,
        bottom: 10,
        left: 10,
      });
      expect(node.layout!.contentWidth).toBe(80); // 100 - 10 - 10
      expect(node.layout!.contentHeight).toBe(30); // 50 - 10 - 10
    });

    test("computes box with margin", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { width: 100, height: 50, margin: 5 },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 10, 20);

      expect(node.layout!.margin).toEqual({
        top: 5,
        right: 5,
        bottom: 5,
        left: 5,
      });
      expect(node.layout!.x).toBe(15); // 10 + 5 (margin.left)
      expect(node.layout!.y).toBe(25); // 20 + 5 (margin.top)
    });

    test("computes box with border", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: {
          width: 100,
          height: 50,
          borderWidth: 2,
          borderColor: "#000000",
          borderRadius: 4,
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout!.border.width).toBe(2);
      expect(node.layout!.border.color).toBe("#000000");
      expect(node.layout!.border.radius).toBe(4);
      expect(node.layout!.contentWidth).toBe(96); // 100 - 2 - 2 (border)
      expect(node.layout!.contentHeight).toBe(46); // 50 - 2 - 2 (border)
    });

    test("respects min/max constraints", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: {
          width: 50,
          height: 50,
          minWidth: 100,
          maxHeight: 40,
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout!.width).toBe(100); // Applied minWidth
      expect(node.layout!.height).toBe(40); // Applied maxHeight
    });
  });

  describe("Text Layout", () => {
    test("computes text node size based on content", () => {
      const node: VirtualNode = {
        id: "text1",
        type: "text",
        props: {
          0: "Hello",
          fontSize: 16,
          fontWeight: "normal",
          fontFamily: "sans-serif",
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout).toBeDefined();
      expect(node.layout!.width).toBeGreaterThan(0);
      expect(node.layout!.height).toBeGreaterThan(0);
    });

    test("computes text with padding", () => {
      const node: VirtualNode = {
        id: "text1",
        type: "text",
        props: {
          0: "Hello",
          fontSize: 16,
          padding: 10,
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      computeLayout(ctx as any, node, 800, 600, 0, 0);

      expect(node.layout!.padding).toEqual({
        top: 10,
        right: 10,
        bottom: 10,
        left: 10,
      });
      // Width includes text + padding
      expect(node.layout!.width).toBeGreaterThan(40); // "Hello" = 40px + padding
    });
  });

  describe("Column Layout (Vertical Flex)", () => {
    test("lays out children vertically", () => {
      const child1: VirtualNode = {
        id: "child1",
        type: "container",
        props: { width: 100, height: 50 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const child2: VirtualNode = {
        id: "child2",
        type: "container",
        props: { width: 100, height: 30 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "column",
        type: "column",
        props: { width: 200, height: 200 },
        children: [child1, child2],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child1.parent = parent;
      child2.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Parent layout
      expect(parent.layout!.width).toBe(200);
      expect(parent.layout!.height).toBe(200);

      // Children should be stacked vertically
      expect(child1.layout!.y).toBe(0); // First child at top
      expect(child2.layout!.y).toBe(50); // Second child below first (50px down)
    });

    test("applies gap between children", () => {
      const child1: VirtualNode = {
        id: "child1",
        type: "container",
        props: { width: 100, height: 50 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const child2: VirtualNode = {
        id: "child2",
        type: "container",
        props: { width: 100, height: 30 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "column",
        type: "column",
        props: { width: 200, height: 200, gap: 10 },
        children: [child1, child2],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child1.parent = parent;
      child2.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Second child should be 50 + 10 (gap) = 60 pixels down
      expect(child2.layout!.y).toBe(60);
    });

    test("centers children horizontally with horizontalAlignment: center", () => {
      const child: VirtualNode = {
        id: "child",
        type: "container",
        props: { width: 100, height: 50 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "column",
        type: "column",
        props: { width: 200, height: 200, horizontalAlignment: "center" },
        children: [child],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Child should be centered: (200 - 100) / 2 = 50
      expect(child.layout!.x).toBe(50);
    });

    test("justifies content to center", () => {
      const child: VirtualNode = {
        id: "child",
        type: "container",
        props: { width: 100, height: 50 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "column",
        type: "column",
        props: { width: 200, height: 200, verticalAlignment: "center" },
        children: [child],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Child should be vertically centered: (200 - 50) / 2 = 75
      expect(child.layout!.y).toBe(75);
    });
  });

  describe("Row Layout (Horizontal Flex)", () => {
    test("lays out children horizontally", () => {
      const child1: VirtualNode = {
        id: "child1",
        type: "container",
        props: { width: 50, height: 100 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const child2: VirtualNode = {
        id: "child2",
        type: "container",
        props: { width: 30, height: 100 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "row",
        type: "row",
        props: { width: 200, height: 200 },
        children: [child1, child2],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child1.parent = parent;
      child2.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Children should be side by side
      expect(child1.layout!.x).toBe(0); // First child at left
      expect(child2.layout!.x).toBe(50); // Second child to the right (50px)
    });

    test("applies gap between children in row", () => {
      const child1: VirtualNode = {
        id: "child1",
        type: "container",
        props: { width: 50, height: 100 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const child2: VirtualNode = {
        id: "child2",
        type: "container",
        props: { width: 30, height: 100 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const parent: VirtualNode = {
        id: "row",
        type: "row",
        props: { width: 200, height: 200, gap: 10 },
        children: [child1, child2],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      child1.parent = parent;
      child2.parent = parent;

      computeLayout(ctx as any, parent, 800, 600, 0, 0);

      // Second child should be 50 + 10 (gap) = 60 pixels to the right
      expect(child2.layout!.x).toBe(60);
    });
  });

  describe("Nested Layouts", () => {
    test("computes nested column in column", () => {
      const innerChild: VirtualNode = {
        id: "innerChild",
        type: "container",
        props: { width: 50, height: 30 },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const innerColumn: VirtualNode = {
        id: "innerColumn",
        type: "column",
        props: { width: 100, height: 100 },
        children: [innerChild],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      const outerColumn: VirtualNode = {
        id: "outerColumn",
        type: "column",
        props: { width: 200, height: 200 },
        children: [innerColumn],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
      };

      innerChild.parent = innerColumn;
      innerColumn.parent = outerColumn;

      computeLayout(ctx as any, outerColumn, 800, 600, 0, 0);

      // All layouts should be computed
      expect(outerColumn.layout).toBeDefined();
      expect(innerColumn.layout).toBeDefined();
      expect(innerChild.layout).toBeDefined();

      // Positions should be relative to parents
      expect(outerColumn.layout!.x).toBe(0);
      expect(innerColumn.layout!.x).toBe(0);
      expect(innerChild.layout!.x).toBe(0);
    });
  });

  describe("Viewport units (vw / vh) resolve against the canvas size", () => {
    // Regression for the calculator-playground bug where `.height("8vh")`
    // collapsed every grid row to ~8px because cssLengthToPx had no
    // viewport reference and was treating `vh` as a unitless pixel value.
    // `computeLayout` now publishes the active viewport (the canvas's
    // own dimensions) so `vh`/`vw` resolve correctly during the pass.
    test("vh height resolves to a percentage of the available height", () => {
      const node: VirtualNode = {
        id: "vh-box",
        type: "container",
        props: { width: 100, height: "10vh" },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
      } as any;

      computeLayout(ctx as any, node, 400, 800, 0, 0);
      // 10vh of 800 = 80
      expect(node.layout!.height).toBe(80);
    });

    test("vw width resolves to a percentage of the available width", () => {
      const node: VirtualNode = {
        id: "vw-box",
        type: "container",
        props: { width: "25vw", height: 50 },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
      } as any;

      computeLayout(ctx as any, node, 400, 800, 0, 0);
      // 25vw of 400 = 100
      expect(node.layout!.width).toBe(100);
    });

    test("five 8vh rows in a column each measure 8% of the viewport", () => {
      // The exact regression from the calculator playground bug. Five
      // siblings each at height 8vh inside an 800px-tall canvas should
      // each measure 64px — not 8px (the unitless-pixel fallback).
      const makeChild = (id: string): VirtualNode =>
        ({
          id,
          type: "container",
          props: { width: 200, height: "8vh" },
          children: [],
          parent: null,
          visible: true,
          opacity: 1,
          clickable: false,
        }) as any;

      const children = ["a", "b", "c", "d", "e"].map(makeChild);
      const parent: VirtualNode = {
        id: "col",
        type: "container",
        props: { width: 200, height: 800, flexDirection: "column" },
        children,
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
      } as any;
      for (const c of children) (c as any).parent = parent;

      computeLayout(ctx as any, parent, 400, 800, 0, 0);

      for (const c of children) {
        expect(c.layout!.height).toBe(64); // 8vh of 800
      }
    });
  });
});









