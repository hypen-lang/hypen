/**
 * @hypen-space/web - Hypen Web Renderers
 *
 * Browser-only package providing DOM and Canvas rendering for Hypen applications.
 * This entry point is WASM-free — it only contains renderers and the remote UI
 * embed component.
 *
 * For client-side rendering (with WASM engine), use "@hypen-space/web-engine":
 *
 * ```typescript
 * import { render } from "@hypen-space/web-engine";
 * await render("Counter", "#app");
 * ```
 *
 * For remote UI (no WASM needed in the browser):
 *
 * ```typescript
 * import { DOMRenderer } from "@hypen-space/web";
 * ```
 */

// ============================================================================
// DOM RENDERER
// ============================================================================

export { DOMRenderer } from "./dom/renderer.js";
export { ComponentRegistry } from "./dom/components/index.js";
export { ApplicatorRegistry } from "./dom/applicators/index.js";
export { EventManager } from "./dom/events.js";
export { RerenderTracker, type DebugConfig, defaultDebugConfig } from "./dom/debug.js";

// HypenApp - Embed remote Hypen apps
export { hypenAppHandler, disconnectHypenApp } from "./dom/components/hypenapp.js";

// ============================================================================
// CANVAS RENDERER
// ============================================================================

export { CanvasRenderer } from "./canvas/renderer.js";
export { canvasHandler, canvasApplicators } from "./dom/canvas/index.js";
