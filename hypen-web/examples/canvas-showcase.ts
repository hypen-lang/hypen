/**
 * Canvas Showcase Example
 *
 * Demonstrates all canvas renderer features:
 * - Stack component
 * - Shadows (boxShadow, textShadow)
 * - Gradients (linear and radial)
 * - Transforms (translate, rotate, scale)
 * - All standard components (Column, Row, Text, Button)
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { HypenModuleInstance } from "../packages/core/src/app.js";
import { createHypenClient } from "../packages/web/src/canvas/index.js";

// Define showcase state
type ShowcaseState = {
  rotation: number;
  scale: number;
};

// Create showcase module
const showcaseModule = app
  .defineState<ShowcaseState>({ rotation: 0, scale: 1 })
  .onCreated(async (state) => {
    console.log("Canvas showcase created");
  })
  .onAction("rotateMore", async ({ state }) => {
    state.rotation = (state.rotation + 15) % 360;
    console.log(`Rotation: ${state.rotation}°`);
  })
  .onAction("scaleUp", async ({ state }) => {
    state.scale = Math.min(state.scale + 0.1, 2);
    console.log(`Scale: ${state.scale.toFixed(1)}`);
  })
  .onAction("scaleDown", async ({ state }) => {
    state.scale = Math.max(state.scale - 0.1, 0.5);
    console.log(`Scale: ${state.scale.toFixed(1)}`);
  })
  .onAction("reset", async ({ state }) => {
    state.rotation = 0;
    state.scale = 1;
    console.log("Reset transforms");
  })
  .build();

// Hypen UI definition
const ui = `
Column {
  Text("Canvas Renderer Showcase")
    .fontSize(28)
    .fontWeight("bold")
    .color("#222222")
    .textShadow("2 2 4 rgba(0,0,0,0.2)")
    .marginBottom(20)

  Row {
    Column {
      Text("Gradients")
        .fontSize(18)
        .fontWeight("bold")
        .marginBottom(10)

      Container {
        Text("Linear Gradient")
          .fontSize(14)
          .color("white")
          .fontWeight("bold")
      }
        .width(150)
        .height(80)
        .backgroundColor("linear-gradient(to right, #667eea, #764ba2)")
        .borderRadius(8)
        .padding(10)
        .marginBottom(10)
        .shadow("0 4 8 rgba(0,0,0,0.15)")

      Container {
        Text("Radial Gradient")
          .fontSize(14)
          .color("white")
          .fontWeight("bold")
      }
        .width(150)
        .height(80)
        .backgroundColor("radial-gradient(#f093fb, #f5576c)")
        .borderRadius(8)
        .padding(10)
        .shadow("0 4 8 rgba(0,0,0,0.15)")
    }
      .marginRight(20)

    Column {
      Text("Shadows")
        .fontSize(18)
        .fontWeight("bold")
        .marginBottom(10)

      Container {
        Text("Box Shadow")
          .fontSize(14)
          .color("#333333")
      }
        .width(150)
        .height(80)
        .backgroundColor("#ffffff")
        .borderRadius(8)
        .padding(10)
        .marginBottom(10)
        .shadow("0 8 16 rgba(0,0,0,0.3)")

      Text("Text Shadow")
        .fontSize(20)
        .fontWeight("bold")
        .color("#ff6b6b")
        .textShadow("2 2 6 rgba(255,107,107,0.5)")
    }
      .marginRight(20)

    Column {
      Text("Stack Overlay")
        .fontSize(18)
        .fontWeight("bold")
        .marginBottom(10)

      Stack {
        Container {}
          .width(150)
          .height(80)
          .backgroundColor("#4ecdc4")
          .borderRadius(8)

        Container {}
          .width(120)
          .height(60)
          .backgroundColor("#ff6b6b")
          .borderRadius(6)
          .opacity(0.8)

        Text("Stacked!")
          .fontSize(16)
          .fontWeight("bold")
          .color("white")
          .textShadow("1 1 3 rgba(0,0,0,0.5)")
      }
        .width(150)
        .height(80)
        .verticalAlignment("center")
        .horizontalAlignment("center")
        .shadow("0 4 8 rgba(0,0,0,0.15)")
    }
  }
    .gap(20)
    .marginBottom(30)

  Text("Transforms")
    .fontSize(18)
    .fontWeight("bold")
    .marginBottom(10)

  Row {
    Container {
      Text("Rotated")
        .fontSize(14)
        .color("white")
        .fontWeight("bold")
    }
      .width(120)
      .height(120)
      .backgroundColor("linear-gradient(135deg, #667eea, #764ba2)")
      .borderRadius(8)
      .padding(10)
      .rotate("@{state.rotation}")
      .shadow("0 6 12 rgba(0,0,0,0.2)")
      .marginRight(20)

    Container {
      Text("Scaled")
        .fontSize(14)
        .color("white")
        .fontWeight("bold")
    }
      .width(100)
      .height(100)
      .backgroundColor("linear-gradient(135deg, #f093fb, #f5576c)")
      .borderRadius(8)
      .padding(10)
      .scale("@{state.scale}")
      .shadow("0 6 12 rgba(0,0,0,0.2)")
  }
    .gap(20)
    .marginBottom(20)

  Row {
    Button {
      Text("Rotate +15°")
        .color("white")
        .fontSize(14)
        .fontWeight("bold")
    }
      .padding(12)
      .backgroundColor("linear-gradient(to right, #667eea, #764ba2)")
      .borderRadius(6)
      .shadow("0 4 8 rgba(102,126,234,0.3)")
      .marginRight(10)
      .onClick("@actions.rotateMore")

    Button {
      Text("Scale +")
        .color("white")
        .fontSize(14)
        .fontWeight("bold")
    }
      .padding(12)
      .backgroundColor("#28a745")
      .borderRadius(6)
      .shadow("0 4 8 rgba(40,167,69,0.3)")
      .marginRight(10)
      .onClick("@actions.scaleUp")

    Button {
      Text("Scale -")
        .color("white")
        .fontSize(14)
        .fontWeight("bold")
    }
      .padding(12)
      .backgroundColor("#dc3545")
      .borderRadius(6)
      .shadow("0 4 8 rgba(220,53,69,0.3)")
      .marginRight(10)
      .onClick("@actions.scaleDown")

    Button {
      Text("Reset")
        .color("white")
        .fontSize(14)
        .fontWeight("bold")
    }
      .padding(12)
      .backgroundColor("#6c757d")
      .borderRadius(6)
      .shadow("0 4 8 rgba(108,117,125,0.3)")
      .onClick("@actions.reset")
  }
    .gap(10)

  Text("All UI rendered with Canvas 2D API!")
    .fontSize(12)
    .color("#666666")
    .marginTop(20)
}
  .padding(30)
  .gap(10)
  .backgroundColor("#f8f9fa")
`;

// Setup example page
async function main() {
  console.log("Starting canvas showcase example...");

  // Create canvas element
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 800;
  canvas.style.border = "1px solid #cccccc";
  canvas.style.display = "block";
  canvas.style.margin = "20px auto";
  canvas.style.boxShadow = "0 10px 30px rgba(0,0,0,0.1)";
  canvas.style.borderRadius = "8px";
  document.body.appendChild(canvas);

  // Initialize engine
  const engine = new Engine();
  await engine.init();
  console.log("Engine initialized");

  // Create canvas renderer + wire patches in one call
  createHypenClient(canvas, engine, {
    devicePixelRatio: window.devicePixelRatio,
    backgroundColor: "#ffffff",
    enableAccessibility: true,
    enableHitTesting: true,
    enableInputOverlay: true,
    showLayoutBounds: false,
    logPerformance: true,
  });

  console.log("Canvas renderer created");

  // Create module instance
  const instance = new HypenModuleInstance(engine, showcaseModule);
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
  instructions.style.maxWidth = "800px";
  instructions.style.margin = "20px auto";
  instructions.innerHTML = `
    <h2 style="color: #222222;">Canvas Renderer Feature Showcase</h2>
    <p>This demo showcases all the advanced features of the canvas renderer:</p>
    <ul style="text-align: left; display: inline-block;">
      <li><strong>Stack Component:</strong> Overlays elements on top of each other with alignment control</li>
      <li><strong>Gradients:</strong> Linear and radial gradients for backgrounds</li>
      <li><strong>Shadows:</strong> Box shadows and text shadows with blur and color</li>
      <li><strong>Transforms:</strong> Rotation and scaling with transform origin support</li>
      <li><strong>Interactive Buttons:</strong> Click to control transforms in real-time</li>
    </ul>
    <p style="margin-top: 20px; font-style: italic;">
      All UI elements are rendered using pure Canvas 2D API - no DOM elements except the canvas itself!
    </p>
  `;
  document.body.appendChild(instructions);
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
