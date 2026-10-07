import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web/dom";
import { CanvasRenderer } from "@hypen-space/web/canvas";
const params = new URLSearchParams(location.search);
const mode = params.get("renderer") === "canvas" ? "canvas" : "dom";
const engine = new RemoteEngine(params.get("ws") || "ws://localhost:3188", {
  session: { id: localStorage.getItem(`orbit-${mode}`) || undefined, props: { platform: "web" } },
});
const host = document.querySelector<HTMLDivElement>("#app")!;
let renderer: DOMRenderer | CanvasRenderer;
if (mode === "canvas") {
  const canvas = document.createElement("canvas"); canvas.style.width = "100%"; canvas.style.height = "100%";
  host.appendChild(canvas); renderer = new CanvasRenderer(canvas, engine, { backgroundColor: "#111213" });
} else renderer = new DOMRenderer(host, engine);
engine.onSessionEstablished(({ sessionId }) => localStorage.setItem(`orbit-${mode}`, sessionId));
engine.onPatches(patches => renderer.applyPatches(patches));
engine.connect();
// Development inspection hook for repeatable cross-renderer action checks.
Object.assign(window, { orbit: { engine, renderer } });
