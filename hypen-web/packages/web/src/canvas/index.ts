/**
 * Canvas Renderer for Hypen
 *
 * Browser-only module for rendering Hypen UI to Canvas
 */

export { CanvasRenderer } from "./renderer.js";
export {
  createCanvasClient as createHypenClient,
  createCanvasClient,
  type CanvasClient as HypenClient,
  type CanvasClient,
  type CanvasClientOptions as HypenClientOptions,
  type CanvasClientOptions,
} from "../client.js";
export { registerPainter } from "./paint.js";
export { CanvasEventManager } from "./events.js";
export { InputOverlay } from "./input.js";
export { AccessibilityLayer } from "./accessibility.js";
export { initTaffyLayout } from "./layout.js";
export { ScrollManager } from "./scroll.js";
export { DirtyRectTracker } from "./dirty.js";
export { SelectionManager } from "./selection.js";

export type {
  VirtualNode,
  Layout,
  Rectangle,
  Point,
  FontStyle,
  TextStyle,
  TextMetrics,
  ScrollState,
  CanvasRendererOptions,
  PainterFunction,
  LayoutFunction,
} from "./types.js";











