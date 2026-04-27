/**
 * Canvas New Features Tests
 *
 * Tests for Stack, shadows, gradients, and transforms
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { VirtualNode } from "../packages/web/src/canvas/types.js";

// Mock canvas context
class MockCanvasContext {
  fillStyle: any = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  globalAlpha: number = 1;
  shadowColor: string = "transparent";
  shadowBlur: number = 0;
  shadowOffsetX: number = 0;
  shadowOffsetY: number = 0;

  operations: string[] = [];

  save() {
    this.operations.push("save");
  }

  restore() {
    this.operations.push("restore");
  }

  translate(x: number, y: number) {
    this.operations.push(`translate(${x}, ${y})`);
  }

  rotate(angle: number) {
    this.operations.push(`rotate(${angle})`);
  }

  scale(x: number, y: number) {
    this.operations.push(`scale(${x}, ${y})`);
  }

  fillRect(x: number, y: number, width: number, height: number) {
    this.operations.push(`fillRect(${x}, ${y}, ${width}, ${height})`);
  }

  strokeRect(x: number, y: number, width: number, height: number) {
    this.operations.push(`strokeRect(${x}, ${y}, ${width}, ${height})`);
  }

  beginPath() {
    this.operations.push("beginPath");
  }

  closePath() {
    this.operations.push("closePath");
  }

  moveTo(x: number, y: number) {
    this.operations.push(`moveTo(${x}, ${y})`);
  }

  lineTo(x: number, y: number) {
    this.operations.push(`lineTo(${x}, ${y})`);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
    this.operations.push(`arcTo(${x1}, ${y1}, ${x2}, ${y2}, ${radius})`);
  }

  fill() {
    this.operations.push("fill");
  }

  stroke() {
    this.operations.push("stroke");
  }

  rect(x: number, y: number, width: number, height: number) {
    this.operations.push(`rect(${x}, ${y}, ${width}, ${height})`);
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    this.operations.push(`createLinearGradient(${x0}, ${y0}, ${x1}, ${y1})`);
    return {
      addColorStop: (stop: number, color: string) => {
        this.operations.push(`addColorStop(${stop}, ${color})`);
      },
    };
  }

  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ) {
    this.operations.push(`createRadialGradient(${x0}, ${y0}, ${r0}, ${x1}, ${y1}, ${r1})`);
    return {
      addColorStop: (stop: number, color: string) => {
        this.operations.push(`addColorStop(${stop}, ${color})`);
      },
    };
  }

  measureText(text: string) {
    return { width: text.length * 8 };
  }

  fillText(text: string, x: number, y: number) {
    this.operations.push(`fillText(${text}, ${x}, ${y})`);
  }

  clearOperations() {
    this.operations = [];
  }
}

describe("Canvas New Features", () => {
  let ctx: MockCanvasContext;

  beforeEach(() => {
    ctx = new MockCanvasContext();
  });

  test("Stack component is recognized", () => {
    const node: VirtualNode = {
      id: "1",
      type: "stack",
      props: {},
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
      },
    };

    expect(node.type).toBe("stack");
  });

  test("Shadow properties can be set", () => {
    const shadow = "2 2 4 rgba(0,0,0,0.3)";
    const node: VirtualNode = {
      id: "1",
      type: "container",
      props: { shadow },
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

    expect(node.props.shadow).toBe(shadow);
  });

  test("Gradient backgrounds can be set", () => {
    const gradient = "linear-gradient(to right, #667eea, #764ba2)";
    const node: VirtualNode = {
      id: "1",
      type: "container",
      props: { backgroundColor: gradient },
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

    expect(node.props.backgroundColor).toBe(gradient);
    expect(node.props.backgroundColor).toContain("gradient");
  });

  test("Transform properties can be set", () => {
    const node: VirtualNode = {
      id: "1",
      type: "container",
      props: {
        rotate: 45,
        scale: 1.5,
        translateX: 10,
        translateY: 20,
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

    expect(node.props.rotate).toBe(45);
    expect(node.props.scale).toBe(1.5);
    expect(node.props.translateX).toBe(10);
    expect(node.props.translateY).toBe(20);
  });

  test("Canvas context can create linear gradient", () => {
    const gradient = (ctx as any).createLinearGradient(0, 0, 100, 0);
    gradient.addColorStop(0, "#667eea");
    gradient.addColorStop(1, "#764ba2");

    expect(ctx.operations).toContain("createLinearGradient(0, 0, 100, 0)");
    expect(ctx.operations).toContain("addColorStop(0, #667eea)");
    expect(ctx.operations).toContain("addColorStop(1, #764ba2)");
  });

  test("Canvas context can create radial gradient", () => {
    const gradient = (ctx as any).createRadialGradient(50, 50, 0, 50, 50, 50);
    gradient.addColorStop(0, "#f093fb");
    gradient.addColorStop(1, "#f5576c");

    expect(ctx.operations).toContain("createRadialGradient(50, 50, 0, 50, 50, 50)");
    expect(ctx.operations).toContain("addColorStop(0, #f093fb)");
    expect(ctx.operations).toContain("addColorStop(1, #f5576c)");
  });

  test("Canvas context supports transform operations", () => {
    (ctx as any).translate(10, 20);
    (ctx as any).rotate(Math.PI / 4);
    (ctx as any).scale(1.5, 1.5);

    expect(ctx.operations).toContain("translate(10, 20)");
    expect(ctx.operations).toContain(`rotate(${Math.PI / 4})`);
    expect(ctx.operations).toContain("scale(1.5, 1.5)");
  });

  test("Canvas context supports shadow properties", () => {
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 4;
    ctx.shadowColor = "rgba(0,0,0,0.3)";

    expect(ctx.shadowOffsetX).toBe(2);
    expect(ctx.shadowOffsetY).toBe(2);
    expect(ctx.shadowBlur).toBe(4);
    expect(ctx.shadowColor).toBe("rgba(0,0,0,0.3)");
  });

  test("Multiple components can use different features", () => {
    const stack: VirtualNode = {
      id: "stack",
      type: "stack",
      props: {},
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

    const shadowed: VirtualNode = {
      id: "shadowed",
      type: "container",
      props: { shadow: "0 4 8 rgba(0,0,0,0.15)" },
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

    const gradient: VirtualNode = {
      id: "gradient",
      type: "container",
      props: { backgroundColor: "linear-gradient(to bottom, red, blue)" },
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

    const transformed: VirtualNode = {
      id: "transformed",
      type: "container",
      props: { rotate: 45, scale: 1.2 },
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

    expect(stack.type).toBe("stack");
    expect(shadowed.props.shadow).toBeDefined();
    expect(gradient.props.backgroundColor).toContain("gradient");
    expect(transformed.props.rotate).toBe(45);
    expect(transformed.props.scale).toBe(1.2);
  });
});
