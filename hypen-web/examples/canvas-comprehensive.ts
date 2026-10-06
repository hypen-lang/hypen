/**
 * Canvas Comprehensive Demo
 *
 * Demonstrates ALL canvas renderer components and features:
 * - All new components (Spacer, Divider, Checkbox, Radio, Switch, Slider, Progress, Spinner, Card, Badge, Avatar, Icon, Link)
 * - Individual margins/padding
 * - Flex properties (flexGrow, flexShrink, flexBasis)
 * - Text decoration (underline, line-through, textTransform, letterSpacing)
 * - Shadows, gradients, transforms (including skew)
 * - Overflow clipping
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { HypenModuleInstance } from "../packages/core/src/app.js";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";

// Define state
type DemoState = {
  checkbox1: boolean;
  checkbox2: boolean;
  radio: string;
  switch1: boolean;
  switch2: boolean;
  slider1: number;
  slider2: number;
  progress: number;
  rotation: number;
  skew: number;
};

// Create demo module
const demoModule = app
  .defineState<DemoState>({
    checkbox1: false,
    checkbox2: true,
    radio: "option1",
    switch1: false,
    switch2: true,
    slider1: 50,
    slider2: 75,
    progress: 0,
    rotation: 0,
    skew: 0,
  })
  .onCreated(async (state) => {
    console.log("Comprehensive demo created");

    // Animate progress
    setInterval(() => {
      state.progress = ((state.progress + 1) % 100);
    }, 100);
  })
  .onAction("toggleCheckbox1", async ({ state }) => {
    state.checkbox1 = !state.checkbox1;
  })
  .onAction("toggleCheckbox2", async ({ state }) => {
    state.checkbox2 = !state.checkbox2;
  })
  .onAction("setRadio", async ({ action, state }) => {
    state.radio = action.payload || "option1";
  })
  .onAction("toggleSwitch1", async ({ state }) => {
    state.switch1 = !state.switch1;
  })
  .onAction("toggleSwitch2", async ({ state }) => {
    state.switch2 = !state.switch2;
  })
  .onAction("rotateMore", async ({ state }) => {
    state.rotation = (state.rotation + 15) % 360;
  })
  .onAction("skewMore", async ({ state }) => {
    state.skew = (state.skew + 5) % 45;
  })
  .build();

// Hypen UI definition
const ui = `
Column {
  Text("Canvas Comprehensive Demo")
    .fontSize(32)
    .fontWeight("bold")
    .color("#222222")
    .textShadow("2 2 4 rgba(0,0,0,0.1)")
    .marginBottom(20)
    .textDecoration("underline")

  Row {
    Column {
      Card {
        Text("Layout Components")
          .fontSize(18)
          .fontWeight("bold")
          .marginBottom(10)
          .textTransform("uppercase")
          .letterSpacing(1)

        Row {
          Container {}.width(30).height(30).backgroundColor("#ff6b6b")
          Spacer {}.flex(1)
          Container {}.width(30).height(30).backgroundColor("#4ecdc4")
        }
          .marginBottom(10)

        Divider {}.color("#e0e0e0").marginBottom(10)

        Text("Flex Example:")
          .fontSize(12)
          .marginBottom(5)

        Row {
          Container {}.width(40).height(20).backgroundColor("#95e1d3").flexGrow(1)
          Container {}.width(40).height(20).backgroundColor("#f38181").flexGrow(2)
          Container {}.width(40).height(20).backgroundColor("#aa96da").flexGrow(1)
        }
          .gap(5)
      }
        .width(300)
        .padding(15)
        .marginRight(15)
        .marginBottom(15)

      Card {
        Text("Interactive Components")
          .fontSize(18)
          .fontWeight("bold")
          .marginBottom(10)

        Row {
          Checkbox {}.checked("@{state.checkbox1}").onClick("@actions.toggleCheckbox1")
          Text("Checkbox 1")
            .fontSize(14)
            .marginLeft(8)
        }
          .marginBottom(10)

        Row {
          Checkbox {}.checked("@{state.checkbox2}").onClick("@actions.toggleCheckbox2")
          Text("Checkbox 2 (Pre-checked)")
            .fontSize(14)
            .marginLeft(8)
        }
          .marginBottom(15)

        Row {
          Radio {}.checked("true").value("option1")
          Text("Option 1")
            .fontSize(14)
            .marginLeft(8)
        }
          .marginBottom(5)

        Row {
          Radio {}.checked("false").value("option2")
          Text("Option 2")
            .fontSize(14)
            .marginLeft(8)
        }
          .marginBottom(15)

        Row {
          Switch {}.checked("@{state.switch1}").onClick("@actions.toggleSwitch1")
          Text("Toggle 1")
            .fontSize(14)
            .marginLeft(10)
        }
          .marginBottom(10)

        Row {
          Switch {}.checked("@{state.switch2}").onClick("@actions.toggleSwitch2")
          Text("Toggle 2 (On)")
            .fontSize(14)
            .marginLeft(10)
        }
      }
        .width(300)
        .padding(15)
        .marginRight(15)
        .marginBottom(15)
    }

    Column {
      Card {
        Text("Sliders & Progress")
          .fontSize(18)
          .fontWeight("bold")
          .marginBottom(10)

        Text("Slider 1: 50")
          .fontSize(12)
          .marginBottom(5)
        Slider {}.value("50").min("0").max("100")
          .marginBottom(15)

        Text("Slider 2: 75")
          .fontSize(12)
          .marginBottom(5)
        Slider {}.value("75").min("0").max("100")
          .fillColor("linear-gradient(to right, #f093fb, #f5576c)")
          .marginBottom(15)

        Text("Progress: @{state.progress}%")
          .fontSize(12)
          .marginBottom(5)
        Progress {}.value("@{state.progress}").min("0").max("100")
          .fillColor("linear-gradient(to right, #667eea, #764ba2)")
          .marginBottom(10)

        Row {
          Spinner {}.size("24").color("#007bff")
          Text("Loading...")
            .fontSize(14)
            .marginLeft(10)
        }
      }
        .width(300)
        .padding(15)
        .marginBottom(15)

      Card {
        Text("Display Components")
          .fontSize(18)
          .fontWeight("bold")
          .marginBottom(10)

        Row {
          Avatar {}.text("JD").size("40").backgroundColor("#667eea")
          Avatar {}.text("AB").size("40").backgroundColor("#f093fb").marginLeft(10)
          Avatar {}.text("XY").size("40").backgroundColor("#4ecdc4").marginLeft(10)
        }
          .marginBottom(15)

        Row {
          Badge {}.text("5").backgroundColor("#dc3545")
          Badge {}.text("99+").backgroundColor("#28a745").marginLeft(10)
          Badge {}.text("NEW").backgroundColor("#007bff").marginLeft(10)
        }
          .marginBottom(15)

        Row {
          Icon {}.icon("star").color("#ffc107").size("24")
          Icon {}.icon("check").color("#28a745").size("24").marginLeft(10)
          Icon {}.icon("close").color("#dc3545").size("24").marginLeft(10)
        }
          .marginBottom(10)

        Link {}.text("Click here to learn more").onClick("@actions.doSomething")
      }
        .width(300)
        .padding(15)
        .marginBottom(15)
    }
  }
    .gap(0)
    .marginBottom(20)

  Card {
    Text("Transforms & Effects")
      .fontSize(18)
      .fontWeight("bold")
      .marginBottom(15)

    Row {
      Column {
        Text("Rotated")
          .fontSize(12)
          .marginBottom(5)
        Container {
          Text("45°").color("white").fontSize(14).fontWeight("bold")
        }
          .width(80)
          .height(80)
          .backgroundColor("linear-gradient(135deg, #667eea, #764ba2)")
          .borderRadius(8)
          .rotate("@{state.rotation}")
          .shadow("0 6 12 rgba(102,126,234,0.4)")
      }
        .marginRight(20)

      Column {
        Text("Skewed")
          .fontSize(12)
          .marginBottom(5)
        Container {
          Text("Skew").color("white").fontSize(14).fontWeight("bold")
        }
          .width(80)
          .height(80)
          .backgroundColor("linear-gradient(135deg, #f093fb, #f5576c)")
          .borderRadius(8)
          .skewX("@{state.skew}")
          .shadow("0 6 12 rgba(240,147,251,0.4)")
      }
        .marginRight(20)

      Column {
        Text("Scaled")
          .fontSize(12)
          .marginBottom(5)
        Container {
          Text("Big").color("white").fontSize(14).fontWeight("bold")
        }
          .width(60)
          .height(60)
          .backgroundColor("linear-gradient(135deg, #4facfe, #00f2fe)")
          .borderRadius(8)
          .scale("1.3")
          .shadow("0 6 12 rgba(79,172,254,0.4)")
      }
        .marginRight(20)

      Column {
        Text("Overflow Hidden")
          .fontSize(12)
          .marginBottom(5)
        Container {
          Container {}.width(100).height(100).backgroundColor("#ff6b6b")
        }
          .width(80)
          .height(80)
          .backgroundColor("#f0f0f0")
          .borderRadius(8)
          .overflow("hidden")
      }
    }
      .marginBottom(15)

    Row {
      Button {
        Text("Rotate +15°").color("white").fontSize(14).fontWeight("bold")
      }
        .padding(10)
        .backgroundColor("linear-gradient(to right, #667eea, #764ba2)")
        .borderRadius(6)
        .shadow("0 4 8 rgba(102,126,234,0.3)")
        .marginRight(10)
        .onClick("@actions.rotateMore")

      Button {
        Text("Skew +5°").color("white").fontSize(14).fontWeight("bold")
      }
        .padding(10)
        .backgroundColor("linear-gradient(to right, #f093fb, #f5576c)")
        .borderRadius(6)
        .shadow("0 4 8 rgba(240,147,251,0.3)")
        .onClick("@actions.skewMore")
    }
  }
    .width(650)
    .padding(20)
    .marginBottom(20)

  Row {
    Text("Text Styles:")
      .fontSize(14)
      .fontWeight("bold")
      .marginRight(15)

    Text("UPPERCASE")
      .fontSize(14)
      .textTransform("uppercase")
      .marginRight(10)

    Text("underlined")
      .fontSize(14)
      .textDecoration("underline")
      .marginRight(10)

    Text("strikethrough")
      .fontSize(14)
      .textDecoration("line-through")
      .marginRight(10)

    Text("spaced out")
      .fontSize(14)
      .letterSpacing(2)
  }
    .marginBottom(10)

  Text("All components rendered with Canvas 2D API!")
    .fontSize(12)
    .color("#666666")
    .fontStyle("italic")
}
  .padding(30)
  .backgroundColor("#f8f9fa")
`;

// Setup example page
async function main() {
  console.log("Starting comprehensive canvas demo...");

  // Create canvas element
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 1200;
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

  // Create canvas renderer
  const renderer = new CanvasRenderer(canvas, engine, {
    devicePixelRatio: window.devicePixelRatio,
    backgroundColor: "#ffffff",
    enableAccessibility: true,
    enableHitTesting: true,
    showLayoutBounds: false,
    logPerformance: true,
  });

  console.log("Canvas renderer created");

  // Set render callback
  engine.setRenderCallback((patches) => {
    console.log(`Applying ${patches.length} patches`);
    renderer.applyPatches(patches);
  });

  // Create module instance
  const instance = new HypenModuleInstance(engine, demoModule);
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
  instructions.style.maxWidth = "900px";
  instructions.style.margin = "20px auto";
  instructions.innerHTML = `
    <h2 style="color: #222222;">Canvas Renderer - Comprehensive Feature Demo</h2>
    <p>This showcases ALL features of the canvas renderer:</p>
    <div style="text-align: left; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
      <div>
        <h3>Components:</h3>
        <ul>
          <li>Spacer, Divider</li>
          <li>Checkbox, Radio, Switch</li>
          <li>Slider, Progress, Spinner</li>
          <li>Card, Badge, Avatar, Icon, Link</li>
        </ul>
      </div>
      <div>
        <h3>Features:</h3>
        <ul>
          <li>Individual margins/padding</li>
          <li>Flex properties (flexGrow, flexShrink)</li>
          <li>Text decorations & transforms</li>
          <li>Shadows, gradients, transforms</li>
          <li>Overflow clipping, skew transform</li>
        </ul>
      </div>
    </div>
    <p style="margin-top: 20px; font-style: italic;">
      100% rendered with Canvas 2D API - no DOM elements except the canvas!
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
