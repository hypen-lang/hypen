/**
 * @hypen-space - Main entry point
 * Re-exports from core, web, and web-engine packages for convenience
 */

// Core exports (platform-agnostic)
export * from "./packages/core/src/index.js";

// Web exports (renderers only)
export {
  DOMRenderer,
  ComponentRegistry,
  ApplicatorRegistry,
  EventManager,
  RerenderTracker,
  type DebugConfig,
  defaultDebugConfig,
  CanvasRenderer,
  canvasHandler,
  canvasApplicators,
} from "./packages/web/src/index.js";

// Web-engine exports (browser WASM engine + Hypen orchestrator)
export {
  Hypen,
  render,
  renderWithComponents,
  type HypenConfig,
} from "./packages/web-engine/src/index.js";