/**
 * Example: Embedded Remote App in Local Hypen App
 *
 * Shows how to embed a remote Hypen app within a local Hypen app
 */

import { Engine } from "../../../packages/core/src/index.js";
import { createHypenClient } from "../../../packages/web/src/dom/index.js";
import { HypenAppComponent } from "../../../packages/core/src/remote/component.js";

async function main() {
  console.log("=== Embedded Remote App Example ===\n");

  // Create local engine
  const engine = new Engine();
  await engine.init();

  // Create DOM renderer
  const appContainer = document.getElementById("app");
  if (!appContainer) {
    console.error("No #app element found");
    return;
  }

  createHypenClient(appContainer, engine);

  // Create a local UI with embedded remote app
  const localUI = `
    Column {
      Text("Local Hypen App")
        .fontSize(24)
        .fontWeight("bold")
        .padding(10)

      Text("This content is rendered locally")
        .padding(10)
        .color("gray")

      Divider()
        .height(1)
        .backgroundColor("lightgray")
        .margin(20)

      Text("Remote Counter App (from ws://localhost:3000)")
        .fontSize(18)
        .fontWeight("bold")
        .padding(10)

      Container { }
        .id("remote-container")
        .padding(20)
        .border("2px solid blue")
        .borderRadius(8)

      Divider()
        .height(1)
        .backgroundColor("lightgray")
        .margin(20)

      Text("More local content below")
        .padding(10)
        .color("gray")
    }
  `;

  // Render local UI
  engine.renderSource(localUI);

  // Find the remote container and embed the remote app
  setTimeout(() => {
    const remoteContainer = document.querySelector('[data-hypen-id*="remote-container"]') as HTMLElement;
    if (remoteContainer) {
      // Create embedded remote app
      const remoteApp = new HypenAppComponent(remoteContainer, {
        url: "ws://localhost:3000",
        autoReconnect: true,
      });

      console.log("✓ Remote app embedded in local app");

      // Store reference for cleanup
      (window as any).remoteApp = remoteApp;
    } else {
      console.error("Could not find remote container");
    }
  }, 100);
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
