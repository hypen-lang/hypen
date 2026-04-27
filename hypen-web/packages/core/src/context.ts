/**
 * Global Context - Cross-module communication and state access
 */

import type { HypenModuleInstance } from "./app.js";
import { getStateSnapshot } from "./state.js";
import { TypedEventEmitter, type HypenFrameworkEvents } from "./events.js";
import { frameworkLoggers } from "./logger.js";

const log = frameworkLoggers.context;

export type ModuleReference<T = unknown> = {
  /**
   * Live proxy state - mutations are tracked and trigger re-renders.
   * Use `getState()` for a snapshot if you only need to read values.
   */
  state: T;
  setState: (patch: Partial<T>) => void;
  /**
   * Returns a deep-cloned snapshot of the current state.
   * Unlike `state`, mutations to the returned object are NOT tracked.
   */
  getState: () => T;
};

export type EventHandler = (payload?: unknown) => void;

/**
 * Global Context - Provides access to all modules and cross-module communication
 *
 * @template TEvents - Custom event map (extends HypenFrameworkEvents)
 */
export class HypenGlobalContext<TEvents extends Record<string, unknown> = HypenFrameworkEvents> {
  private modules = new Map<string, HypenModuleInstance>();
  private typedEvents: TypedEventEmitter<TEvents & Record<string, unknown>>;

  constructor() {
    this.typedEvents = new TypedEventEmitter<TEvents & Record<string, unknown>>();
  }

  /**
   * Get the typed event emitter for type-safe event handling
   */
  get events(): TypedEventEmitter<TEvents & Record<string, unknown>> {
    return this.typedEvents;
  }

  /**
   * Register a module instance with an ID
   */
  registerModule(id: string, instance: HypenModuleInstance) {
    if (this.modules.has(id)) {
      log.warn(`Module "${id}" is already registered. Overwriting.`);
    }
    this.modules.set(id, instance);
    log.debug(`Registered module: ${id}`);
  }

  /**
   * Unregister a module
   */
  unregisterModule(id: string) {
    this.modules.delete(id);
    log.debug(`Unregistered module: ${id}`);
  }

  /**
   * Get a module by ID with type safety
   */
  getModule<T = unknown>(id: string): ModuleReference<T> {
    const module = this.modules.get(id);
    if (!module) {
      throw new Error(
        `Module "${id}" not found. Available modules: ${Array.from(this.modules.keys()).join(", ")}`
      );
    }

    return {
      state: module.getLiveState() as T,
      setState: (patch: Partial<T>) => module.updateState(patch),
      getState: () => module.getState() as T,
    };
  }

  /**
   * Check if a module exists
   */
  hasModule(id: string): boolean {
    return this.modules.has(id);
  }

  /**
   * Get all registered module IDs
   */
  getModuleIds(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Get the entire app state tree (snapshot)
   */
  getGlobalState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    this.modules.forEach((module, id) => {
      state[id] = module.getState();
    });
    return state;
  }

  /**
   * Emit an event. Delegates to the TypedEventEmitter.
   */
  emit(event: string, payload?: unknown): void {
    if (this.typedEvents.listenerCount(event) === 0) {
      log.debug(`Event "${event}" emitted but no listeners`);
      return;
    }
    log.debug(`Emitting event: ${event}`, payload);
    this.typedEvents.emit(event, payload as TEvents[string]);
  }

  /**
   * Subscribe to an event. Delegates to the TypedEventEmitter.
   * Returns an unsubscribe function.
   */
  on(event: string, handler: EventHandler): () => void {
    log.debug(`Listening to event: ${event}`);
    return this.typedEvents.on(event, handler);
  }

  /**
   * Unsubscribe a specific handler from an event.
   * Delegates to the TypedEventEmitter.
   */
  off(event: string, handler: EventHandler): void {
    this.typedEvents.off(event, handler);
  }

  /**
   * Remove all listeners for a specific event.
   * Delegates to the TypedEventEmitter.
   */
  clearEvent(event: string): void {
    this.typedEvents.removeAllListeners(event);
  }

  /**
   * Remove all listeners for all events.
   * Delegates to the TypedEventEmitter.
   */
  clearAllEvents(): void {
    this.typedEvents.clearAll();
  }

  /**
   * Get debug info about the context
   */
  debug(): {
    modules: string[];
    events: Array<keyof TEvents | string>;
    state: Record<string, unknown>;
  } {
    return {
      modules: this.getModuleIds(),
      events: this.typedEvents.eventNames() as Array<keyof TEvents | string>,
      state: this.getGlobalState(),
    };
  }
}
