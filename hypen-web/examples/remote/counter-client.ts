/**
 * Example: Remote Counter Client (Programmatic)
 *
 * Connect to a remote counter app using RemoteEngine
 */

import { RemoteEngine } from "../../../packages/core/src/remote/client.js";
import { createHypenClient } from "../../../packages/web/src/dom/index.js";

async function main() {
  console.log("=== Hypen Remote Counter Client ===\n");

  // Create DOM container
  const app = document.getElementById("app");
  if (!app) {
    console.error("No #app element found");
    return;
  }

  // Create remote engine
  const remoteEngine = new RemoteEngine("ws://localhost:3000", {
    autoReconnect: true,
    reconnectInterval: 3000,
    maxReconnectAttempts: 10,
  });

  // Wire renderer + patch subscription in one call
  createHypenClient(app, remoteEngine);

  // Set up connection handlers
  remoteEngine.onConnect(() => {
    console.log("✓ Connected to remote app");
    app.classList.add("connected");
  });

  remoteEngine.onDisconnect(() => {
    console.log("✗ Disconnected from remote app");
    app.classList.remove("connected");
  });

  remoteEngine.onError((error) => {
    console.error("Remote app error:", error);
  });

  // Connect
  console.log("Connecting to ws://localhost:3000...");
  await remoteEngine.connect();

  // Set up click event forwarding (example)
  // In a real app, this would be handled by the renderer
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.getAttribute("data-action");
    if (action) {
      remoteEngine.dispatchAction(action);
    }
  });
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
