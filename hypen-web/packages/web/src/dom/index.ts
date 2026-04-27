/**
 * DOM Renderer for Hypen
 *
 * Browser-only module for rendering Hypen UI to the DOM
 */

export { DOMRenderer } from "./renderer.js";
export { ComponentRegistry } from "./components/index.js";
export { ApplicatorRegistry } from "./applicators/index.js";
export { EventManager } from "./events.js";
export { RerenderTracker, type DebugConfig, defaultDebugConfig } from "./debug.js";
export {
  createDomClient as createHypenClient,
  createDomClient,
  type DomClient as HypenClient,
  type DomClient,
  type DomClientOptions as HypenClientOptions,
  type DomClientOptions,
} from "../client.js";
