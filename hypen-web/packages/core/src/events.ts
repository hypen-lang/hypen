/**
 * Type-safe Event System
 *
 * Provides strongly-typed event emission and subscription with autocomplete support.
 */

import { frameworkLoggers } from "./logger.js";

const log = frameworkLoggers.events;

export type EventHandler<T = unknown> = (payload: T) => void;

/**
 * Type-safe event emitter with generics
 */
export class TypedEventEmitter<TEvents extends Record<string, unknown> = Record<string, unknown>> {
  private eventBus = new Map<keyof TEvents, Set<EventHandler<any>>>();

  /**
   * Emit an event with type-safe payload
   */
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const handlers = this.eventBus.get(event);
    if (!handlers || handlers.size === 0) {
      return;
    }

    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        log.error(`Error in event handler for "${String(event)}":`, error);
      }
    });
  }

  /**
   * Subscribe to an event with type-safe payload
   * Returns an unsubscribe function
   */
  on<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    if (!this.eventBus.has(event)) {
      this.eventBus.set(event, new Set());
    }

    const handlers = this.eventBus.get(event)!;
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventBus.delete(event);
      }
    };
  }

  /**
   * Subscribe to an event once (auto-unsubscribe after first emit)
   */
  once<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    const wrappedHandler = (payload: TEvents[K]) => {
      handler(payload);
      unsubscribe();
    };

    const unsubscribe = this.on(event, wrappedHandler);
    return unsubscribe;
  }

  /**
   * Unsubscribe a specific handler from an event
   */
  off<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    const handlers = this.eventBus.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventBus.delete(event);
      }
    }
  }

  /**
   * Remove all listeners for a specific event
   */
  removeAllListeners<K extends keyof TEvents>(event: K): void {
    this.eventBus.delete(event);
  }

  /**
   * Remove all listeners for all events
   */
  clearAll(): void {
    this.eventBus.clear();
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount<K extends keyof TEvents>(event: K): number {
    return this.eventBus.get(event)?.size ?? 0;
  }

  /**
   * Get all registered event names
   */
  eventNames(): Array<keyof TEvents> {
    return Array.from(this.eventBus.keys());
  }
}

/**
 * Default events for Hypen framework (can be extended by users)
 */
export type HypenFrameworkEvents = {
  'module:created': { moduleId: string };
  'module:destroyed': { moduleId: string };
  'route:changed': { from: string | null; to: string };
  'state:updated': { moduleId: string; paths: string[] };
  'action:dispatched': { moduleId: string; actionName: string; payload?: unknown };
  'error': { message: string; error?: Error; context?: string };
};

/**
 * Create a typed event emitter with custom event map
 */
export function createEventEmitter<TEvents extends Record<string, unknown> = HypenFrameworkEvents>(): TypedEventEmitter<TEvents> {
  return new TypedEventEmitter<TEvents>();
}
