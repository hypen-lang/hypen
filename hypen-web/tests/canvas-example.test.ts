/**
 * Canvas Counter Example Test
 *
 * Verifies that the canvas-counter example can render without errors
 *
 * NOTE: These tests are skipped because they require a browser environment
 * with fetch and URL support for loading WASM files. The browser WASM
 * initialization fails in the test environment.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Engine } from "../packages/web-engine/src/engine.js";
import { app, HypenModuleInstance } from "../packages/core/src/app.js";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import { JSDOM } from "jsdom";

describe.skip("Canvas Counter Example", () => {
  let dom: JSDOM;
  let canvas: HTMLCanvasElement;
  let engine: Engine;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    // Create a DOM environment
    dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    global.document = dom.window.document as any;
    global.window = dom.window as any;

    // Create canvas element
    canvas = dom.window.document.createElement("canvas") as any;
    canvas.width = 800;
    canvas.height = 600;
  });

  test("creates engine and renderer without errors", async () => {
    engine = new Engine();
    await engine.init();
    expect(engine).toBeDefined();

    renderer = new CanvasRenderer(canvas, engine, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: true,
      enableHitTesting: true,
      showLayoutBounds: false,
      logPerformance: false,
    });

    expect(renderer).toBeDefined();
  });

  test("creates counter module without errors", async () => {
    type CounterState = {
      count: number;
    };

    const counterModule = app
      .defineState<CounterState>({ count: 0 })
      .onCreated(async (state, context) => {
        // Lifecycle handler receives (state, context?)
      })
      .onAction("increment", async ({ state }) => {
        state.count++;
      })
      .onAction("decrement", async ({ state }) => {
        state.count--;
      })
      .onAction("reset", async ({ state }) => {
        state.count = 0;
      })
      .build();

    expect(counterModule).toBeDefined();
  });

  test("renders counter UI without errors", async () => {
    engine = new Engine();
    await engine.init();

    renderer = new CanvasRenderer(canvas, engine, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: false,
      enableHitTesting: true,
      showLayoutBounds: false,
      logPerformance: false,
    });

    let patchesReceived = 0;
    engine.setRenderCallback((patches) => {
      patchesReceived += patches.length;
      renderer.applyPatches(patches);
    });

    type CounterState = {
      count: number;
    };

    const counterModule = app
      .defineState<CounterState>({ count: 0 })
      .onCreated(async (state, context) => {
        // Lifecycle handler receives (state, context?)
      })
      .onAction("increment", async ({ state }) => {
        state.count++;
      })
      .build();

    const instance = new HypenModuleInstance(engine, counterModule);

    const ui = `
Column {
  padding: 20
  gap: 10
  backgroundColor: #f5f5f5
  
  Text("Canvas Counter") {
    fontSize: 24
    fontWeight: bold
    color: #333333
  }
  
  Row {
    gap: 10
    
    Button("@actions.decrement") {
      padding: 10
      backgroundColor: #dc3545
      borderRadius: 4
      
      Text("-") {
        color: white
        fontSize: 18
        fontWeight: bold
      }
    }
    
    Text("@{state.count}") {
      fontSize: 32
      fontWeight: bold
      color: #007bff
      padding: 10
    }
    
    Button("@actions.increment") {
      padding: 10
      backgroundColor: #28a745
      borderRadius: 4
      
      Text("+") {
        color: white
        fontSize: 18
        fontWeight: bold
      }
    }
  }
  
  Button("@actions.reset") {
    padding: 10
    backgroundColor: #6c757d
    borderRadius: 4
    
    Text("Reset") {
      color: white
      fontSize: 16
    }
  }
}
`;

    await engine.renderSource(ui);

    // Verify patches were received
    expect(patchesReceived).toBeGreaterThan(0);

    // Verify renderer has nodes
    const nodes = (renderer as any).nodes;
    expect(Object.keys(nodes).length).toBeGreaterThan(0);
  });

  test("handles state updates and re-renders", async () => {
    engine = new Engine();
    await engine.init();

    renderer = new CanvasRenderer(canvas, engine, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: false,
      enableHitTesting: true,
      showLayoutBounds: false,
      logPerformance: false,
    });

    let renderCount = 0;
    engine.setRenderCallback((patches) => {
      renderCount++;
      renderer.applyPatches(patches);
    });

    type CounterState = {
      count: number;
    };

    const counterModule = app
      .defineState<CounterState>({ count: 0 })
      .onAction("increment", async ({ state }) => {
        state.count++;
      })
      .build();

    const instance = new HypenModuleInstance(engine, counterModule);

    const ui = `
Column {
  Text("@{state.count}")
}
`;

    await engine.renderSource(ui);
    const initialRenderCount = renderCount;

    // Dispatch increment action
    await engine.dispatchAction("increment", {});

    // Wait for re-render
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have re-rendered after state change
    expect(renderCount).toBeGreaterThan(initialRenderCount);
  });

  test("computes layout for counter UI", async () => {
    engine = new Engine();
    await engine.init();

    renderer = new CanvasRenderer(canvas, engine, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: false,
      enableHitTesting: true,
      showLayoutBounds: false,
      logPerformance: false,
    });

    engine.setRenderCallback((patches) => {
      renderer.applyPatches(patches);
    });

    type CounterState = { count: number };
    const counterModule = app.defineState<CounterState>({ count: 0 }).build();
    const instance = new HypenModuleInstance(engine, counterModule);

    const ui = `
Column {
  padding: 20
  Text("Counter: @{state.count}")
  Button("@actions.increment") {
    Text("+")
  }
}
`;

    await engine.renderSource(ui);

    // Verify root node has layout
    const rootNode = (renderer as any).root;
    expect(rootNode).toBeDefined();
    expect(rootNode.layout).toBeDefined();
    expect(rootNode.layout.width).toBeGreaterThan(0);
    expect(rootNode.layout.height).toBeGreaterThan(0);
  });
});









