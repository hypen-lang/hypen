/**
 * Browser entry for the Phase 4 real-Chromium validation (RFC 001 §6).
 * Bundled by tests/device-browser.test.ts with Bun.build and served to a real
 * browser: a RemoteEngine with a WebDeviceHost attached, and app buttons
 * that dispatch the "pick" (gallery.pick) and "filePick" (file.pick) actions,
 * plus round-3 buttons (`data-action`: camera photo/video, mic.record,
 * bluetooth.select). Nothing here touches the host's consent dialog, capture
 * dialog or recording indicator — the test drives those with real (trusted)
 * clicks.
 */

import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer, CanvasRenderer } from "../../packages/web/src/index.ts";
import { browserMediaBackend, WebDeviceHost } from "../../packages/device-web/src/index.ts";

declare global {
  interface Window {
    __hypen: {
      connected: boolean;
      sessionAck: unknown;
      host: WebDeviceHost;
      engine: RemoteEngine;
      renderedTexts?: string[];
    };
  }
}

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws")!;

// `?audio=scriptprocessor` forces the ScriptProcessor capture fallback.
const media =
  params.get("audio") === "scriptprocessor" ? browserMediaBackend(window, { audioWorklet: false }) : undefined;
const host = new WebDeviceHost({ origin: new URL(wsUrl).origin, denialCooldownMs: 60_000, ...(media ? { media } : {}) });
const engine = new RemoteEngine(wsUrl, { device: host, autoReconnect: false });

window.__hypen = { connected: false, sessionAck: null, host, engine };

const rendererKind = params.get("renderer");
if (rendererKind) {
  const container = document.getElementById("renderer")!;
  const canvas = document.createElement("canvas");
  canvas.style.width = "400px";
  canvas.style.height = "180px";
  if (rendererKind === "canvas") container.append(canvas);
  const renderer = rendererKind === "canvas"
    ? new CanvasRenderer(canvas, engine)
    : new DOMRenderer(container, engine);
  window.__hypen.renderedTexts = [];
  engine.onPatches((patches) => {
    renderer.applyPatches(patches);
    for (const patch of patches) {
      if (patch.type === "setProp" && (patch.name === "text" || patch.name === "0")) {
        window.__hypen.renderedTexts!.push(String(patch.value));
      }
    }
  });
}

engine.onSessionEstablished((info) => {
  window.__hypen.sessionAck = info;
  window.__hypen.connected = true;
});

document.getElementById("pick")!.addEventListener("click", () => {
  engine.dispatchAction("pick");
});

document.getElementById("filepick")?.addEventListener("click", () => {
  engine.dispatchAction("filePick");
});

// Round 3 capture actions: any button carrying data-action dispatches it
// (camera photo/video, mic.record, bluetooth.select).
for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-action]"))) {
  el.addEventListener("click", () => engine.dispatchAction(el.dataset.action!));
}

// A chat box and a "click fast" game: every keystroke / click is an app
// action the (hostile) server answers with a device request mid-gesture.
document.getElementById("chat")?.addEventListener("keydown", () => {
  engine.dispatchAction("typing");
});
document.getElementById("game")?.addEventListener("click", () => {
  engine.dispatchAction("typing");
});

void engine.connect();
