/**
 * Canvas Counter Example
 * 
 * Demonstrates the canvas renderer with a simple counter
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { HypenModuleInstance } from "../packages/core/src/app.js";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";

// Define counter state
type CounterState = {
  count: number;
};

// Create counter module
const counterModule = app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state) => {
    console.log("Counter created with canvas renderer");
  })
  .onAction("increment", async ({ state }) => {
    state.count++;
    console.log(`Count: ${state.count}`);
  })
  .onAction("decrement", async ({ state }) => {
    state.count--;
    console.log(`Count: ${state.count}`);
  })
  .onAction("reset", async ({ state }) => {
    state.count = 0;
    console.log("Counter reset");
  })
  .build();

// Hypen UI definition
const ui = `
Column {
  Text("Canvas Counter")
    .fontSize(24)
    .fontWeight("bold")
    .color("#333333")
    .marginBottom(16)
  
  Row {
    Button {
      Text("-")
        .color("white")
        .fontSize(18)
        .fontWeight("bold")
    }
      .padding(10)
      .backgroundColor("#dc3545")
      .borderRadius(4)
      .marginRight(10)
      .onClick("@actions.decrement")
    
    Text("@{state.count}")
      .fontSize(32)
      .fontWeight("bold")
      .color("#007bff")
      .padding(10)
      .marginRight(10)
    
    Button {
      Text("+")
        .color("white")
        .fontSize(18)
        .fontWeight("bold")
    }
      .padding(10)
      .backgroundColor("#28a745")
      .borderRadius(4)
      .onClick("@actions.increment")
  }
    .gap(10)
    .marginBottom(10)
  
  Button {
    Text("Reset")
      .color("white")
      .fontSize(16)
  }
    .padding(10)
    .backgroundColor("#6c757d")
    .borderRadius(4)
    .onClick("@actions.reset")
    .marginBottom(10)
  
  Text("Rendered with Canvas")
    .fontSize(12)
    .color("#666666")
}
  .padding(20)
  .gap(10)
  .backgroundColor("#f5f5f5")
`;

// Setup example page
async function main() {
  console.log("Starting canvas counter example...");

  // Create canvas element
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.style.border = "1px solid #cccccc";
  canvas.style.display = "block";
  canvas.style.margin = "20px auto";
  document.body.appendChild(canvas);

  // Initialize engine
  const engine = new Engine();
  await engine.init();
  console.log("Engine initialized");

  // Create canvas renderer
  const renderer = new CanvasRenderer(canvas, engine, {
    devicePixelRatio: window.devicePixelRatio,
    backgroundColor: "#ffffff",
    enableAccessibility: true,
    enableHitTesting: true,
    enableInputOverlay: true,
    showLayoutBounds: false, // Set to true to debug layout
    logPerformance: true,
  });

  console.log("Canvas renderer created");

  // Set render callback
  engine.setRenderCallback((patches) => {
    console.log(`Applying ${patches.length} patches`);
    console.log("Patches:", patches);
    renderer.applyPatches(patches);
    
    // Debug: Check if root node is set
    console.log("Root node:", (renderer as any).rootNode);
    console.log("Total nodes:", (renderer as any).nodes.size);
  });

  // Create module instance
  const instance = new HypenModuleInstance(engine, counterModule);
  console.log("Module instance created");

  // Render UI
  await engine.renderSource(ui);
  console.log("UI rendered");

  // Add instructions
  const instructions = document.createElement("div");
  instructions.style.textAlign = "center";
  instructions.style.marginTop = "20px";
  instructions.style.fontFamily = "system-ui, sans-serif";
  instructions.style.color = "#666666";
  instructions.innerHTML = `
    <h2>Canvas Renderer Demo</h2>
    <p>Click the buttons to interact with the counter.</p>
    <p>All UI is rendered using Canvas 2D API - no DOM elements!</p>
  `;
  document.body.appendChild(instructions);
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

