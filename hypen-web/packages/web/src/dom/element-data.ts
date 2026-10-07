/**
 * Type-Safe Element Data
 *
 * Provides strongly-typed access to Hypen-specific data attached to DOM elements.
 * Eliminates `as any` casts throughout the codebase.
 */

import {
  type DisposableStack,
  disposeElement,
  getElementDisposables,
  hasElementDisposables,
} from "@hypen-space/core/disposable";

// ============================================================================
// Types
// ============================================================================

/**
 * Engine interface for dispatching actions
 */
export interface IEngine {
  dispatchAction(name: string, payload?: unknown): void;
}

/**
 * All Hypen-specific data attached to an element
 */
export interface HypenElementData {
  /** Engine reference for action dispatch */
  engine?: IEngine;
  /** Target key for keyboard events (e.g., "Enter", "Escape") */
  keyTarget?: string;
  /** Set of registered event type:action pairs */
  registeredEvents?: Set<string>;
  /** Custom element metadata */
  meta?: Record<string, unknown>;
}

// ============================================================================
// Private Storage
// ============================================================================

/**
 * WeakMap to store Hypen data without polluting the element
 */
const elementDataMap = new WeakMap<HTMLElement, HypenElementData>();

// ============================================================================
// Core API
// ============================================================================

/**
 * Get Hypen data for an element, creating if needed
 */
export function getHypenData(element: HTMLElement): HypenElementData {
  let data = elementDataMap.get(element);
  if (!data) {
    data = {};
    elementDataMap.set(element, data);
  }
  return data;
}

/**
 * Check if element has Hypen data
 */
export function hasHypenData(element: HTMLElement): boolean {
  return elementDataMap.has(element);
}

/**
 * Clear Hypen data from an element
 */
export function clearHypenData(element: HTMLElement): void {
  elementDataMap.delete(element);
}

// ============================================================================
// Engine Access
// ============================================================================

/**
 * Get the engine for an element: its own, or the nearest ancestor's.
 *
 * Template-instantiated nodes (list rows) carry no engine entry of their
 * own — stamping one was a WeakMap write per node, ~17k per 1,000-row
 * create — and resolve through the tree they are mounted in instead. Every
 * caller runs from an event listener or an animation completion, i.e. on
 * a mounted element; the walk is a handful of steps on a hot path that is
 * one click.
 */
export function getEngine(element: HTMLElement): IEngine | undefined {
  let current: HTMLElement | null = element;
  while (current) {
    const engine = elementDataMap.get(current)?.engine;
    if (engine) return engine;
    current = current.parentNode as HTMLElement | null;
  }
  return undefined;
}

/**
 * Set the engine on an element
 */
export function setEngine(element: HTMLElement, engine: IEngine): void {
  getHypenData(element).engine = engine;
}

/**
 * Find engine by walking up the DOM tree
 */
export function findEngine(element: HTMLElement): IEngine | undefined {
  let current: HTMLElement | null = element;
  while (current) {
    const engine = getEngine(current);
    if (engine) return engine;
    current = current.parentElement;
  }
  return undefined;
}

// ============================================================================
// Event Registration Tracking
// ============================================================================

/**
 * Get registered events set for an element
 */
export function getRegisteredEvents(element: HTMLElement): Set<string> {
  const data = getHypenData(element);
  if (!data.registeredEvents) {
    data.registeredEvents = new Set();
  }
  return data.registeredEvents;
}

/**
 * Check if an event handler is registered
 */
export function isEventRegistered(element: HTMLElement, eventKey: string): boolean {
  return getRegisteredEvents(element).has(eventKey);
}

/**
 * Mark an event handler as registered
 */
export function registerEvent(element: HTMLElement, eventKey: string): void {
  getRegisteredEvents(element).add(eventKey);
}

/**
 * Unregister an event handler
 */
export function unregisterEvent(element: HTMLElement, eventKey: string): void {
  getRegisteredEvents(element).delete(eventKey);
}

// ============================================================================
// Keyboard Event Key Target
// ============================================================================

/**
 * Get the target key for keyboard events
 */
export function getKeyTarget(element: HTMLElement): string | undefined {
  return getHypenData(element).keyTarget;
}

/**
 * Set the target key for keyboard events
 */
export function setKeyTarget(element: HTMLElement, key: string): void {
  getHypenData(element).keyTarget = key;
}

// ============================================================================
// Metadata
// ============================================================================

/**
 * Get custom metadata value
 */
export function getMeta<T>(element: HTMLElement, key: string): T | undefined {
  return getHypenData(element).meta?.[key] as T | undefined;
}

/**
 * Set custom metadata value
 */
export function setMeta<T>(element: HTMLElement, key: string, value: T): void {
  const data = getHypenData(element);
  if (!data.meta) {
    data.meta = {};
  }
  data.meta[key] = value;
}

// ============================================================================
// Event payload resolvers
// ============================================================================

/**
 * Extra payload an element contributes to every action dispatched from it.
 *
 * Installed by components whose events mean more than "this element was hit"
 * — a chart mark resolves the datum under the pointer, in data units — and
 * merged by the event applicators on top of the extracted/static payload, so
 * `.onClick(@actions.pick)` and `.onClick(@actions.pick, tag: "x")` both carry it.
 */
export type PayloadResolver = (event: Event) => Record<string, unknown> | undefined;

const PAYLOAD_RESOLVER_KEY = "payload:resolver";

export function setPayloadResolver(element: HTMLElement, resolver: PayloadResolver | null): void {
  setMeta(element, PAYLOAD_RESOLVER_KEY, resolver ?? undefined);
}

export function getPayloadResolver(element: HTMLElement): PayloadResolver | undefined {
  return getMeta<PayloadResolver>(element, PAYLOAD_RESOLVER_KEY);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Dispose all resources attached to an element and clear data
 * Call this when removing an element from the DOM
 */
export function disposeHypenElement(element: HTMLElement): void {
  // Dispose any registered disposables. Probe first: `getElementDisposables`
  // creates a stack when none exists, and most elements never register one
  // — tearing down a 1,000-row list allocated ~17k stacks just to dispose
  // them empty.
  if (hasElementDisposables(element)) {
    try {
      disposeElement(element);
    } catch {
      // A throwing disposer must not abort the rest of the teardown.
    }
  }

  // Clear Hypen data
  clearHypenData(element);
}

// ============================================================================
// Legacy Compatibility Layer
// ============================================================================

/**
 * Symbol-based legacy accessor (for backwards compatibility)
 * Use the typed functions above instead when possible
 */
const HYPEN_ENGINE_SYMBOL = Symbol.for("hypen.engine");
const REGISTERED_EVENTS_SYMBOL = Symbol.for("hypen.registeredEvents");
const KEY_TARGET_SYMBOL = Symbol.for("hypen.keyTarget");

/**
 * Legacy accessor for engine (backwards compatible with existing code)
 */
export function getLegacyEngine(element: HTMLElement): IEngine | undefined {
  // Try new storage first
  const engine = getEngine(element);
  if (engine) return engine;

  // Fall back to legacy storage
  return (element as any)[HYPEN_ENGINE_SYMBOL] ??
    (element as any).__hypenEngine;
}

/**
 * Legacy setter for engine (backwards compatible)
 */
export function setLegacyEngine(element: HTMLElement, engine: IEngine): void {
  // Set in both locations for compatibility
  setEngine(element, engine);
  (element as any).__hypenEngine = engine;
}
