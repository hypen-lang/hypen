/**
 * Canvas Renderer for Hypen
 *
 * Browser-only module for rendering Hypen UI to Canvas
 */

export { CanvasRenderer } from "./renderer.js";
export { CanvasAnimator, EXIT_SETTLE_GRACE_MS } from "./anim.js";
export { registerPainter } from "./paint.js";
export { CanvasEventManager } from "./events.js";
export { AccessibilityLayer } from "./accessibility.js";
export { FocusManager } from "./focus.js";
export { TextEditController } from "./editing.js";
export { initTaffyLayout } from "./layout.js";
export { ScrollManager } from "./scroll.js";
export { DirtyRectTracker } from "./dirty.js";
export { SelectionManager } from "./selection.js";
export {
  pointToOffset,
  offsetToCaretRect,
  rangeToRects,
  type TextGeometry,
} from "./text-geometry.js";

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











