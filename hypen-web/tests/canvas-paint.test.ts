/**
 * Canvas Paint System Tests
 * 
 * Tests the painting/drawing functionality
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { paintNode } from "../packages/web/src/canvas/paint.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";

// Mock canvas context that records draw calls
class MockCanvasContext {
  calls: Array<{ method: string; args: any[] }> = [];
  
  fillStyle: string = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "10px sans-serif";
  textAlign: string = "left";
  textBaseline: string = "top";
  globalAlpha: number = 1;

  // Record method calls
  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }

  // Canvas methods
  save() { this.record("save"); }
  restore() { this.record("restore"); }
  fillRect(x: number, y: number, w: number, h: number) {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.record("strokeRect", x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.record("clearRect", x, y, w, h);
  }
  fillText(text: string, x: number, y: number) {
    this.record("fillText", text, x, y);
  }
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  beginPath() { this.record("beginPath"); }
  closePath() { this.record("closePath"); }
  moveTo(x: number, y: number) { this.record("moveTo", x, y); }
  lineTo(x: number, y: number) { this.record("lineTo", x, y); }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
    this.record("arcTo", x1, y1, x2, y2, radius);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
    this.record("arc", x, y, radius, startAngle, endAngle);
  }
  fill() { this.record("fill"); }
  stroke() { this.record("stroke"); }
  clip() { this.record("clip"); }
  rect(x: number, y: number, w: number, h: number) {
    this.record("rect", x, y, w, h);
  }

  // Helper to check if method was called
  wasCalled(method: string): boolean {
    return this.calls.some(call => call.method === method);
  }

  // Helper to count calls
  countCalls(method: string): number {
    return this.calls.filter(call => call.method === method).length;
  }

  // Helper to get last call
  getLastCall(method: string) {
    const calls = this.calls.filter(call => call.method === method);
    return calls[calls.length - 1];
  }

  // Clear recorded calls
  clearCalls() {
    this.calls = [];
  }
}

describe("Canvas Paint System", () => {
  let ctx: MockCanvasContext;

  beforeEach(() => {
    ctx = new MockCanvasContext();
  });

  describe("Container/Box Painting", () => {
    test("paints simple container", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { backgroundColor: "#ff0000" },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 50,
        },
      };

      paintNode(ctx as any, node);

      expect(ctx.wasCalled("save")).toBe(true);
      expect(ctx.wasCalled("restore")).toBe(true);
      expect(ctx.wasCalled("fillRect")).toBe(true);
      expect(ctx.fillStyle).toBe("#ff0000");
    });

    test("paints container with border", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: {
          backgroundColor: "#ffffff",
          borderWidth: 2,
          borderColor: "#000000",
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
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 2, color: "#000000", radius: 0 },
          contentX: 2,
          contentY: 2,
          contentWidth: 96,
          contentHeight: 46,
        },
      };

      paintNode(ctx as any, node);

      expect(ctx.wasCalled("fillRect")).toBe(true); // Background
      expect(ctx.wasCalled("strokeRect")).toBe(true); // Border
      expect(ctx.strokeStyle).toBe("#000000");
      expect(ctx.lineWidth).toBe(2);
    });

    test("paints container with rounded corners", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: {
          backgroundColor: "#ffffff",
          borderRadius: 10,
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
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 10 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 50,
        },
      };

      paintNode(ctx as any, node);

      // Should use path drawing for rounded corners
      expect(ctx.wasCalled("beginPath")).toBe(true);
      expect(ctx.wasCalled("fill")).toBe(true);
      expect(ctx.wasCalled("arcTo")).toBe(true); // Rounded corners
    });

    test("skips invisible nodes", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { backgroundColor: "#ff0000" },
        children: [],
        parent: null,
        visible: false, // Not visible
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 50,
        },
      };

      paintNode(ctx as any, node);

      // Should not paint anything
      expect(ctx.wasCalled("fillRect")).toBe(false);
    });

    test("applies opacity", () => {
      const node: VirtualNode = {
        id: "box1",
        type: "container",
        props: { backgroundColor: "#ff0000" },
        children: [],
        parent: null,
        visible: true,
        opacity: 0.5,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 50,
        },
      };

      paintNode(ctx as any, node);

      expect(ctx.globalAlpha).toBe(0.5);
    });
  });

  describe("Text Painting", () => {
    test("paints text node", () => {
      const node: VirtualNode = {
        id: "text1",
        type: "text",
        props: {
          0: "Hello",
          color: "#000000",
          fontSize: 16,
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
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 20,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 20,
        },
      };

      paintNode(ctx as any, node);

      expect(ctx.wasCalled("fillText")).toBe(true);
      // Text should be rendered (possibly on multiple lines if wrapped)
      expect(ctx.countCalls("fillText")).toBeGreaterThan(0);
    });
  });

  describe("Button Painting", () => {
    test("paints button", () => {
      const node: VirtualNode = {
        id: "btn1",
        type: "button",
        props: {
          backgroundColor: "#007bff",
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: true,
        hoverable: true,
        focusable: true,
        focused: false,
        hovered: false,
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 40,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 10, right: 10, bottom: 10, left: 10 },
          border: { width: 0, color: "transparent", radius: 4 },
          contentX: 10,
          contentY: 10,
          contentWidth: 80,
          contentHeight: 20,
        },
      };

      paintNode(ctx as any, node);

      // Button should draw background with rounded corners
      expect(ctx.wasCalled("beginPath")).toBe(true);
      expect(ctx.wasCalled("fill")).toBe(true);
      expect(ctx.fillStyle).toBe("#007bff");
    });

    test("paints button with hover state", () => {
      const node: VirtualNode = {
        id: "btn1",
        type: "button",
        props: {
          backgroundColor: "#007bff",
          hoverColor: "#0056b3",
        },
        children: [],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: true,
        hoverable: true,
        focusable: true,
        focused: false,
        hovered: true, // Hovered state
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 40,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 10, right: 10, bottom: 10, left: 10 },
          border: { width: 0, color: "transparent", radius: 4 },
          contentX: 10,
          contentY: 10,
          contentWidth: 80,
          contentHeight: 20,
        },
      };

      paintNode(ctx as any, node);

      // Should use hover color
      expect(ctx.fillStyle).toBe("#0056b3");
    });
  });

  describe("Children Painting", () => {
    test("paints children recursively", () => {
      const child: VirtualNode = {
        id: "child",
        type: "container",
        props: { backgroundColor: "#00ff00" },
        children: [],
        parent: null as any,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
        layout: {
          x: 15,
          y: 25,
          width: 50,
          height: 25,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 50,
          contentHeight: 25,
        },
      };

      const parent: VirtualNode = {
        id: "parent",
        type: "container",
        props: { backgroundColor: "#ff0000" },
        children: [child],
        parent: null,
        visible: true,
        opacity: 1,
        clickable: false,
        hoverable: false,
        focusable: false,
        focused: false,
        hovered: false,
        layout: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          border: { width: 0, color: "transparent", radius: 0 },
          contentX: 0,
          contentY: 0,
          contentWidth: 100,
          contentHeight: 50,
        },
      };

      child.parent = parent;

      paintNode(ctx as any, parent);

      // Should paint both parent and child
      expect(ctx.countCalls("fillRect")).toBeGreaterThanOrEqual(2);
    });
  });
});

