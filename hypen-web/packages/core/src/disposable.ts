/**
 * Disposable Pattern for Resource Management
 *
 * Provides a consistent way to manage and clean up resources like
 * event listeners, timers, WebSocket connections, etc.
 */

import { frameworkLoggers } from "./logger.js";

const log = frameworkLoggers.lifecycle;

/**
 * Interface for objects that can be disposed
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Check if an object is Disposable
 */
export function isDisposable(obj: unknown): obj is Disposable {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'dispose' in obj &&
    typeof (obj as Disposable).dispose === 'function'
  );
}

/**
 * A stack of disposables that are disposed in LIFO order
 */
export class DisposableStack implements Disposable {
  private stack: Disposable[] = [];
  private disposed = false;

  /**
   * Add a disposable to the stack and return it
   */
  add<T extends Disposable>(disposable: T): T {
    if (this.disposed) {
      // If already disposed, immediately dispose the new item
      disposable.dispose();
      return disposable;
    }
    this.stack.push(disposable);
    return disposable;
  }

  /**
   * Add a cleanup callback to the stack
   */
  addCallback(callback: () => void): void {
    this.add({ dispose: callback });
  }

  /**
   * Add a value with a custom dispose function
   */
  addValue<T>(value: T, dispose: (value: T) => void): T {
    this.add({ dispose: () => dispose(value) });
    return value;
  }

  /**
   * Dispose all items in reverse order (LIFO)
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    while (this.stack.length > 0) {
      const item = this.stack.pop()!;
      try {
        item.dispose();
      } catch (error) {
        // Log but continue disposing other items
        log.error('Error during dispose:', error);
      }
    }
  }

  /**
   * Check if this stack has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Get the number of items in the stack
   */
  get size(): number {
    return this.stack.length;
  }
}

/**
 * Create a disposable from an event listener
 */
export function disposableListener(
  target: EventTarget,
  event: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions
): Disposable {
  target.addEventListener(event, handler, options);
  return {
    dispose: () => target.removeEventListener(event, handler, options),
  };
}

/**
 * Create a disposable from a timeout
 */
export function disposableTimeout(
  callback: () => void,
  ms: number
): Disposable & { id: ReturnType<typeof setTimeout> } {
  const id = setTimeout(callback, ms);
  return {
    id,
    dispose: () => clearTimeout(id),
  };
}

/**
 * Create a disposable from an interval
 */
export function disposableInterval(
  callback: () => void,
  ms: number
): Disposable & { id: ReturnType<typeof setInterval> } {
  const id = setInterval(callback, ms);
  return {
    id,
    dispose: () => clearInterval(id),
  };
}

/**
 * Create a disposable from a WebSocket
 */
export function disposableWebSocket(ws: WebSocket): Disposable {
  return {
    dispose: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}

/**
 * Create a disposable from an AbortController
 */
export function disposableAbortController(): Disposable & { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    dispose: () => controller.abort(),
  };
}

/**
 * Create a disposable subscription (for event emitters, observables, etc.)
 */
export function disposableSubscription(unsubscribe: () => void): Disposable {
  return { dispose: unsubscribe };
}

/**
 * Symbol used to store disposables on DOM elements
 */
const ELEMENT_DISPOSABLES = Symbol('hypen.disposables');

/**
 * Get or create a DisposableStack for an HTML element
 */
export function getElementDisposables(element: HTMLElement): DisposableStack {
  const existing = (element as any)[ELEMENT_DISPOSABLES];
  if (existing instanceof DisposableStack) {
    return existing;
  }
  const stack = new DisposableStack();
  (element as any)[ELEMENT_DISPOSABLES] = stack;
  return stack;
}

/**
 * Dispose all disposables attached to an element
 */
export function disposeElement(element: HTMLElement): void {
  const stack = (element as any)[ELEMENT_DISPOSABLES];
  if (stack instanceof DisposableStack) {
    stack.dispose();
    delete (element as any)[ELEMENT_DISPOSABLES];
  }
}

/**
 * Check if an element has disposables
 */
export function hasElementDisposables(element: HTMLElement): boolean {
  return (element as any)[ELEMENT_DISPOSABLES] instanceof DisposableStack;
}

/**
 * Decorator/helper to make a class disposable
 * Tracks all resources and disposes them when dispose() is called
 */
export class DisposableMixin {
  protected disposables = new DisposableStack();

  /**
   * Register a disposable to be cleaned up
   */
  protected track<T extends Disposable>(disposable: T): T {
    return this.disposables.add(disposable);
  }

  /**
   * Register a cleanup callback
   */
  protected onDispose(callback: () => void): void {
    this.disposables.addCallback(callback);
  }

  /**
   * Dispose all tracked resources
   */
  dispose(): void {
    this.disposables.dispose();
  }
}

/**
 * Create a composite disposable that disposes multiple items together
 */
export function compositeDisposable(...disposables: Disposable[]): Disposable {
  return {
    dispose: () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (error) {
          log.error('Error during dispose:', error);
        }
      }
    },
  };
}

/**
 * Run a function with automatic cleanup on exit
 * Similar to Python's context managers or C#'s using statement
 */
export async function using<T extends Disposable, R>(
  resource: T | (() => T),
  fn: (resource: T) => R | Promise<R>
): Promise<R> {
  const r = typeof resource === 'function' ? resource() : resource;
  try {
    return await fn(r);
  } finally {
    r.dispose();
  }
}

/**
 * Synchronous version of using()
 */
export function usingSync<T extends Disposable, R>(
  resource: T | (() => T),
  fn: (resource: T) => R
): R {
  const r = typeof resource === 'function' ? resource() : resource;
  try {
    return fn(r);
  } finally {
    r.dispose();
  }
}
