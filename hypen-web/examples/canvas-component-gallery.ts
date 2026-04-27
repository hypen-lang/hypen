/**
 * Canvas Component Gallery Example
 *
 * Showcases many Hypen components rendered entirely to canvas via the
 * Canvas component routing feature. Demonstrates Text, Button, Column,
 * Row, Stack, Checkbox, Switch, Slider, Progress, Divider, Avatar,
 * Badge, Icon, and more — all inside a single <canvas>.
 *
 * Uses the regular DOMRenderer; wrapping the UI in `Canvas { ... }` is
 * what triggers the canvas-subtree routing.
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { HypenModuleInstance } from "../packages/core/src/app.js";
import { createHypenClient } from "../packages/web/src/dom/index.js";

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

type GalleryState = {
  counter: number;
  agreed: boolean;
  darkMode: boolean;
  volume: number;
  progress: number;
  loading: boolean;
  selectedTab: string;
};

const galleryModule = app
  .defineState<GalleryState>({
    counter: 0,
    agreed: false,
    darkMode: false,
    volume: 50,
    progress: 65,
    loading: false,
    selectedTab: "buttons",
  })
  .onCreated(async () => {
    console.log("Canvas component gallery initialised");
  })
  .onAction("increment", async ({ state }) => {
    state.counter += 1;
  })
  .onAction("decrement", async ({ state }) => {
    state.counter -= 1;
  })
  .onAction("reset", async ({ state }) => {
    state.counter = 0;
  })
  .onAction("toggleAgreed", async ({ state }) => {
    state.agreed = !state.agreed;
  })
  .onAction("toggleDarkMode", async ({ state }) => {
    state.darkMode = !state.darkMode;
  })
  .onAction("volumeUp", async ({ state }) => {
    state.volume = Math.min(state.volume + 10, 100);
  })
  .onAction("volumeDown", async ({ state }) => {
    state.volume = Math.max(state.volume - 10, 0);
  })
  .onAction("stepProgress", async ({ state }) => {
    state.progress = (state.progress + 10) % 110;
  })
  .onAction("toggleLoading", async ({ state }) => {
    state.loading = !state.loading;
  })
  .onAction("selectTab", async ({ state, action }) => {
    const tab = String(action.payload?.tab ?? "buttons");
    state.selectedTab = tab;
  })
  .build();

// ---------------------------------------------------------------------------
// Hypen DSL
// ---------------------------------------------------------------------------

const ui = `
Canvas(width: 720, height: 960) {
  Column {
    // === Header ==========================================================
    Column {
      Text("Canvas Component Gallery")
        .fontSize(26)
        .fontWeight("bold")
        .color("#1a1a1a")

      Text("Every component below is rendered to a single <canvas>")
        .fontSize(13)
        .color("#6b7280")
        .marginTop(4)
    }
      .padding(20)
      .backgroundColor("#ffffff")
      .borderWidth(1)
      .borderColor("#e5e7eb")

    // === Scrollable showcase =============================================
    Column {
      // ---- Typography ---------------------------------------------------
      Column {
        Text("Typography")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Text("Heading 1 — 32px bold")
          .fontSize(32)
          .fontWeight("bold")
          .color("#111827")

        Text("Heading 2 — 24px semibold")
          .fontSize(24)
          .fontWeight("600")
          .color("#1f2937")
          .marginTop(6)

        Text("Body text — 16px regular")
          .fontSize(16)
          .color("#374151")
          .marginTop(6)

        Text("Caption — 12px muted")
          .fontSize(12)
          .color("#6b7280")
          .marginTop(6)

        Text("Selectable multi-language text: 你好 こんにちは مرحبا")
          .fontSize(14)
          .color("#374151")
          .marginTop(8)
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // ---- Buttons ------------------------------------------------------
      Column {
        Text("Buttons")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Row {
          Button {
            Text("−")
              .color("#ffffff")
              .fontSize(18)
              .fontWeight("bold")
          }
            .padding(12)
            .backgroundColor("#ef4444")
            .borderRadius(6)
            .marginRight(10)
            .action("@actions.decrement")

          Text("@{state.counter}")
            .fontSize(24)
            .fontWeight("bold")
            .color("#2563eb")
            .paddingLeft(16)
            .paddingRight(16)
            .paddingTop(10)

          Button {
            Text("+")
              .color("#ffffff")
              .fontSize(18)
              .fontWeight("bold")
          }
            .padding(12)
            .backgroundColor("#10b981")
            .borderRadius(6)
            .marginLeft(10)
            .action("@actions.increment")

          Button {
            Text("Reset")
              .color("#ffffff")
              .fontSize(14)
          }
            .padding(12)
            .backgroundColor("#6b7280")
            .borderRadius(6)
            .marginLeft(10)
            .action("@actions.reset")
        }
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // ---- Form controls ------------------------------------------------
      Column {
        Text("Form Controls")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Row {
          Checkbox {}
            .bind(@state.agreed)
            .marginRight(10)

          Text("I agree to the terms")
            .fontSize(14)
            .color("#374151")
        }
          .marginBottom(12)

        Row {
          Switch {}
            .bind(@state.darkMode)
            .marginRight(10)

          Text("@{state.darkMode ? 'Dark mode on' : 'Dark mode off'}")
            .fontSize(14)
            .color("#374151")
        }
          .marginBottom(12)

        Text("Volume: @{state.volume}")
          .fontSize(14)
          .color("#374151")
          .marginBottom(6)

        Row {
          Button {
            Text("−")
              .color("#ffffff")
          }
            .padding(8)
            .backgroundColor("#6b7280")
            .borderRadius(4)
            .marginRight(8)
            .action("@actions.volumeDown")

          Slider {}
            .bind(@state.volume)
            .width(220)
            .marginRight(8)

          Button {
            Text("+")
              .color("#ffffff")
          }
            .padding(8)
            .backgroundColor("#6b7280")
            .borderRadius(4)
            .action("@actions.volumeUp")
        }
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // ---- Progress & loading -------------------------------------------
      Column {
        Text("Progress & Loading")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Text("Progress: @{state.progress}%")
          .fontSize(14)
          .color("#374151")
          .marginBottom(6)

        Progress {}
          .width(400)
          .height(10)
          .marginBottom(12)

        Row {
          Button {
            Text("Step progress")
              .color("#ffffff")
              .fontSize(14)
          }
            .padding(10)
            .backgroundColor("#3b82f6")
            .borderRadius(6)
            .marginRight(10)
            .action("@actions.stepProgress")

          Button {
            Text("@{state.loading ? 'Stop' : 'Start'} loading")
              .color("#ffffff")
              .fontSize(14)
          }
            .padding(10)
            .backgroundColor("#8b5cf6")
            .borderRadius(6)
            .action("@actions.toggleLoading")
        }
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // ---- Layout primitives --------------------------------------------
      Column {
        Text("Layout Primitives")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Text("Row with gap(12):")
          .fontSize(13)
          .color("#6b7280")
          .marginBottom(6)

        Row {
          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#ef4444")
            .borderRadius(6)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#f59e0b")
            .borderRadius(6)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#10b981")
            .borderRadius(6)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#3b82f6")
            .borderRadius(6)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#8b5cf6")
            .borderRadius(6)
        }
          .gap(12)
          .marginBottom(16)

        Text("Divider:")
          .fontSize(13)
          .color("#6b7280")
          .marginBottom(6)

        Column {}
          .height(1)
          .width(400)
          .backgroundColor("#e5e7eb")
          .marginBottom(12)

        Text("Stack (avatars overlapping):")
          .fontSize(13)
          .color("#6b7280")
          .marginBottom(6)

        Stack {
          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#f0b4d8")
            .borderRadius(20)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#a5d8ff")
            .borderRadius(20)
            .marginLeft(24)

          Column {}
            .width(40)
            .height(40)
            .backgroundColor("#c3fae8")
            .borderRadius(20)
            .marginLeft(48)
        }
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // ---- Cards --------------------------------------------------------
      Column {
        Text("Cards")
          .fontSize(18)
          .fontWeight("bold")
          .color("#111827")
          .marginBottom(12)

        Column {
          Text("Featured post")
            .fontSize(16)
            .fontWeight("bold")
            .color("#ffffff")

          Text("Rendered entirely to canvas with gradients and shadows")
            .fontSize(13)
            .color("#e5e7eb")
            .marginTop(6)
        }
          .padding(16)
          .backgroundColor("#1f2937")
          .borderRadius(8)
          .marginBottom(8)

        Column {
          Text("Another card")
            .fontSize(16)
            .fontWeight("bold")
            .color("#111827")

          Text("With border and no background")
            .fontSize(13)
            .color("#6b7280")
            .marginTop(6)
        }
          .padding(16)
          .borderWidth(1)
          .borderColor("#e5e7eb")
          .borderRadius(8)
      }
        .padding(20)
        .backgroundColor("#ffffff")
        .marginBottom(8)

      // Bottom padding so scroll can reach the last section comfortably
      Column {}
        .height(40)
    }
      .flexGrow(1)
      .overflow("scroll")
      .backgroundColor("#f9fafb")
  }
    .flexGrow(1)
    .backgroundColor("#f9fafb")
}
`;

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

async function main() {
  console.log("Starting canvas component gallery example...");

  const header = document.createElement("div");
  header.style.cssText = "text-align: center; padding: 16px; font-family: system-ui, sans-serif;";
  header.innerHTML = `
    <h1 style="margin: 0 0 4px; color: #111827;">Canvas Component Gallery</h1>
    <p style="margin: 0; color: #6b7280; font-size: 14px;">
      All components below are rendered to a single &lt;canvas&gt; via the
      Canvas component routing. Scroll, click, and interact.
    </p>
  `;
  document.body.appendChild(header);

  const container = document.createElement("div");
  container.style.cssText = "max-width: 720px; margin: 0 auto; border: 1px solid #e5e7eb;";
  document.body.appendChild(container);

  const engine = new Engine();
  await engine.init();

  createHypenClient(container, engine);

  new HypenModuleInstance(engine, galleryModule);

  await engine.renderSource(ui);
  console.log("Component gallery rendered to canvas");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
