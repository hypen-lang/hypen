/**
 * @hypen-space/web-engine - Browser Engine for Hypen SPAs
 *
 * Connects the WASM engine with the DOM renderer for client-side rendering.
 *
 * @example
 * ```typescript
 * import { render } from "@hypen-space/web-engine";
 *
 * await render("Counter", "#app");
 * ```
 */

export { Hypen, render, renderWithComponents } from "./hypen.js";
export type { HypenConfig, ComponentLoaderLike } from "./hypen.js";

export { Engine } from "./engine.js";
export type { EngineInitOptions } from "./engine.js";
