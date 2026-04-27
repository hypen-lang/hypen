/**
 * createHypenClient — single-call wiring for renderer + engine.
 *
 * Replaces the boilerplate:
 *   const renderer = new DOMRenderer(container, engine);
 *   engine.onPatches((patches) => renderer.applyPatches(patches));
 *
 * Works with either a local Engine (`setRenderCallback`) or RemoteEngine
 * (`onPatches`) — they expose different APIs but the same intent.
 */

import type { Patch } from "@hypen-space/core/types";
import { DOMRenderer } from "./dom/renderer.js";
import type { DebugConfig } from "./dom/debug.js";
import { CanvasRenderer } from "./canvas/renderer.js";
import type { CanvasRendererOptions } from "./canvas/types.js";

interface PatchSourceLike {
  dispatchAction(name: string, payload?: unknown): void;
  onPatches?(callback: (patches: Patch[]) => void): unknown;
  setRenderCallback?(callback: (patches: Patch[]) => void): void;
}

function attachPatchListener(
  engine: PatchSourceLike,
  callback: (patches: Patch[]) => void,
): void {
  if (typeof engine.onPatches === "function") {
    engine.onPatches(callback);
    return;
  }
  if (typeof engine.setRenderCallback === "function") {
    engine.setRenderCallback(callback);
    return;
  }
  throw new Error(
    "createHypenClient: engine has neither onPatches() nor setRenderCallback() — cannot subscribe to patches.",
  );
}

export interface DomClientOptions {
  debug?: Partial<DebugConfig>;
}

export interface DomClient {
  renderer: DOMRenderer;
  destroy(): void;
}

export function createDomClient(
  container: HTMLElement,
  engine: PatchSourceLike,
  options?: DomClientOptions,
): DomClient {
  const renderer = new DOMRenderer(container, engine as any, options?.debug);
  attachPatchListener(engine, (patches) => renderer.applyPatches(patches));
  return {
    renderer,
    destroy() {
      // DOMRenderer has no destroy yet; clearing the container is the
      // closest approximation. Patch subscriptions live on the engine —
      // the caller controls engine lifetime, so we don't tear them down.
      container.innerHTML = "";
    },
  };
}

export interface CanvasClientOptions extends Partial<CanvasRendererOptions> {}

export interface CanvasClient {
  renderer: CanvasRenderer;
  destroy(): void;
}

export function createCanvasClient(
  canvas: HTMLCanvasElement,
  engine: PatchSourceLike,
  options?: CanvasClientOptions,
): CanvasClient {
  const renderer = new CanvasRenderer(canvas, engine as any, options);
  attachPatchListener(engine, (patches) => renderer.applyPatches(patches));
  return {
    renderer,
    destroy() {
      renderer.destroy();
    },
  };
}
