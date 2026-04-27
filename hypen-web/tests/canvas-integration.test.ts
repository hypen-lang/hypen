/**
 * Canvas Renderer Integration Tests
 * 
 * Tests basic rendering pipeline with mock canvas
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { Patch } from "../packages/core/src/types";

// Mock canvas and context
class MockCanvasContext {
  fillStyle: string = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "10px sans-serif";
  textAlign: string = "left";
  textBaseline: string = "top";
  globalAlpha: number = 1;

  private state: any[] = [];

  save() {
    this.state.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      globalAlpha: this.globalAlpha,
    });
  }

  restore() {
    const state = this.state.pop();
    if (state) {
      Object.assign(this, state);
    }
  }

  scale(x: number, y: number) {}
  fillRect(x: number, y: number, width: number, height: number) {}
  strokeRect(x: number, y: number, width: number, height: number) {}
  clearRect(x: number, y: number, width: number, height: number) {}
  fillText(text: string, x: number, y: number) {}
  measureText(text: string) {
    return { width: text.length * 8 }; // Rough estimate
  }
  beginPath() {}
  closePath() {}
  moveTo(x: number, y: number) {}
  lineTo(x: number, y: number) {}
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {}
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {}
  fill() {}
  stroke() {}
  clip() {}
  drawImage(...args: any[]) {}
  rect(x: number, y: number, width: number, height: number) {}
}

class MockCanvas {
  width: number = 800;
  height: number = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  
  private context: MockCanvasContext;
  private eventListeners: Map<string, Function[]> = new Map();

  constructor() {
    this.context = new MockCanvasContext();
  }

  getContext(type: string): MockCanvasContext | null {
    return type === "2d" ? this.context : null;
  }

  getBoundingClientRect() {
    return {
      width: 800,
      height: 600,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
    };
  }

  addEventListener(event: string, handler: Function) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(handler);
  }

  dispatchEvent(event: any) {
    const handlers = this.eventListeners.get(event.type) || [];
    handlers.forEach(h => h(event));
    return true;
  }

  get parentElement() {
    return {
      appendChild: () => {},
    };
  }
}

// Mock engine
class MockEngine {
  private renderCallback: ((patches: Patch[]) => void) | null = null;
  private actionHandlers = new Map<string, Function>();

  async init() {
    return Promise.resolve();
  }

  setRenderCallback(callback: (patches: Patch[]) => void) {
    this.renderCallback = callback;
  }

  dispatchAction(name: string, payload?: any) {
    const handler = this.actionHandlers.get(name);
    if (handler) {
      handler(payload);
    }
  }

  onAction(name: string, handler: Function) {
    this.actionHandlers.set(name, handler);
  }

  // Helper to simulate patches
  emitPatches(patches: Patch[]) {
    if (this.renderCallback) {
      this.renderCallback(patches);
    }
  }
}

describe("Canvas Renderer Integration", () => {
  let canvas: MockCanvas;
  let engine: MockEngine;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    canvas = new MockCanvas();
    engine = new MockEngine();
    renderer = new CanvasRenderer(canvas as any, engine as any, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: false,
      enableHitTesting: true,
    });
  });

  test("creates renderer instance", () => {
    expect(renderer).toBeDefined();
  });

  test("handles create patch", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "node1",
        elementType: "column",
        props: { padding: 10 },
      } as any,
    ];

    renderer.applyPatches(patches);
    const node = renderer.getNode("node1");
    
    expect(node).toBeDefined();
    expect(node?.type).toBe("column");
    expect(node?.props.padding).toBe(10);
  });

  test("handles setProp patch", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "node1",
        elementType: "text",
        props: {},
      } as any,
      {
        type: "setProp",
        id: "node1",
        name: "color",
        value: "#ff0000",
      } as any,
    ];

    renderer.applyPatches(patches);
    const node = renderer.getNode("node1");
    
    expect(node?.props.color).toBe("#ff0000");
  });

  test("handles setText patch", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "node1",
        elementType: "text",
        props: {},
      } as any,
      {
        type: "setText",
        id: "node1",
        text: "Hello, Canvas!",
      } as any,
    ];

    renderer.applyPatches(patches);
    const node = renderer.getNode("node1");
    
    expect(node?.props[0]).toBe("Hello, Canvas!");
  });

  test("handles insert patch - root node", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "root",
        elementType: "column",
        props: {},
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "root",
      } as any,
    ];

    renderer.applyPatches(patches);
    const node = renderer.getNode("root");
    
    expect(node).toBeDefined();
  });

  test("handles insert patch - child node", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "parent",
        elementType: "column",
        props: {},
      } as any,
      {
        type: "create",
        id: "child",
        elementType: "text",
        props: {},
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "parent",
      } as any,
      {
        type: "insert",
        parentId: "parent",
        id: "child",
      } as any,
    ];

    renderer.applyPatches(patches);
    const parent = renderer.getNode("parent");
    const child = renderer.getNode("child");
    
    expect(parent?.children).toContain(child);
    expect(child?.parent).toBe(parent);
  });

  test("handles remove patch", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "node1",
        elementType: "text",
        props: {},
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "node1",
      } as any,
      {
        type: "remove",
        id: "node1",
      } as any,
    ];

    renderer.applyPatches(patches);
    const node = renderer.getNode("node1");
    
    expect(node).toBeUndefined();
  });

  test("handles complete UI tree", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "root",
        elementType: "column",
        props: { padding: 20, gap: 10 },
      } as any,
      {
        type: "create",
        id: "text1",
        elementType: "text",
        props: { fontSize: 24 },
      } as any,
      {
        type: "setText",
        id: "text1",
        text: "Counter",
      } as any,
      {
        type: "create",
        id: "button1",
        elementType: "button",
        props: { padding: 10 },
      } as any,
      {
        type: "create",
        id: "button-text",
        elementType: "text",
        props: {},
      } as any,
      {
        type: "setText",
        id: "button-text",
        text: "Click Me",
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "root",
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "text1",
      } as any,
      {
        type: "insert",
        parentId: "root",
        id: "button1",
      } as any,
      {
        type: "insert",
        parentId: "button1",
        id: "button-text",
      } as any,
    ];

    renderer.applyPatches(patches);
    
    const root = renderer.getNode("root");
    expect(root).toBeDefined();
    expect(root?.children.length).toBe(2); // text1 and button1
    
    const button = renderer.getNode("button1");
    expect(button?.children.length).toBe(1); // button-text
  });

  test("clear removes all nodes", () => {
    const patches: Patch[] = [
      {
        type: "create",
        id: "node1",
        elementType: "text",
        props: {},
      } as any,
    ];

    renderer.applyPatches(patches);
    expect(renderer.getNode("node1")).toBeDefined();
    
    renderer.clear();
    expect(renderer.getNode("node1")).toBeUndefined();
  });
});









