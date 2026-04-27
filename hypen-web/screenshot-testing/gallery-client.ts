/**
 * Gallery Client - Uses the real @hypen-space/web DOM Renderer
 *
 * Receives patches from the component-gallery-server and renders them
 * using the same DOMRenderer that production Hypen apps use.
 */

// Import directly from the DOM renderer to avoid pulling in WASM engine
import { DOMRenderer } from "../packages/web/src/dom/renderer.ts";

// ============================================================================
// MAIN
// ============================================================================

const params = new URLSearchParams(window.location.search);
let componentName = params.get("name") || params.get("component");

if (!componentName && window.location.hash) {
  componentName = window.location.hash.slice(1);
}

const loadingEl = document.getElementById("loading")!;
const errorEl = document.getElementById("error")!;
const appContainer = document.getElementById("app")!;

function showError(message: string) {
  loadingEl.classList.add("hidden");
  errorEl.classList.add("show");
  errorEl.textContent = message;
}

if (!componentName) {
  showError("No component specified. Use ?name=button or #button");
  throw new Error("No component name");
}

// WebSocket URL
const wsHost = params.get("host") || "localhost";
const wsPort = params.get("port") || "6555";
const wsUrl = `ws://${wsHost}:${wsPort}/${componentName}`;

console.log(`[Gallery] Connecting to: ${wsUrl}`);

let ws: WebSocket;

// Create a minimal engine interface that forwards actions to the server
const remoteEngine = {
  dispatchAction(name: string, payload?: any) {
    console.log(`[Gallery] Dispatching action: ${name}`, payload);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "dispatchAction",
        action: name,
        payload,
      }));
    }
  }
};

// Create the real DOMRenderer
const renderer = new DOMRenderer(appContainer, remoteEngine);

let reconnectAttempts = 0;
const maxReconnectAttempts = 3;

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[Gallery] Connected");
    reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log(`[Gallery] Received: ${message.type}`);

      if (message.type === "initialTree") {
        loadingEl.classList.add("hidden");
        renderer.clear();
        if (message.patches) {
          renderer.applyPatches(message.patches);
        }
        if (message.state) {
          renderer.updateState(message.state);
        }
        document.title = `Hypen Gallery - ${message.module || componentName}`;
      } else if (message.type === "patch") {
        if (message.patches) {
          renderer.applyPatches(message.patches);
        }
      } else if (message.type === "stateUpdate") {
        if (message.state) {
          renderer.updateState(message.state);
        }
      }
    } catch (err) {
      console.error("[Gallery] Error processing message:", err);
    }
  };

  ws.onerror = (error) => {
    console.error("[Gallery] WebSocket error:", error);
  };

  ws.onclose = (event) => {
    console.log("[Gallery] Disconnected:", event.code, event.reason);

    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`[Gallery] Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(connect, 1000 * reconnectAttempts);
    } else {
      showError(`Failed to connect to ${wsUrl}. Is the gallery server running?`);
    }
  };
}

connect();
