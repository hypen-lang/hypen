/**
 * State management with observer pattern and diffing
 *
 * Uses a proxy-based approach with self-detection to avoid
 * creating nested proxies repeatedly.
 */

import { portable } from "./portable";

// Symbol for proxy detection (more robust than string property)
const IS_PROXY = Symbol.for('hypen.isProxy');
const RAW_TARGET = Symbol.for('hypen.rawTarget');

export type StatePath = string; // e.g., "user.name", "items.0.title"

/**
 * Represents a change in state with full path information
 */
export interface StateChange {
  paths: StatePath[];
  newValues: Record<StatePath, any>;
}

/**
 * Options for state observer
 */
export interface StateObserverOptions {
  onChange: (change: StateChange) => void;
  pathPrefix?: string; // For nested observers
}

/**
 * Deep clone an object, using structuredClone when available.
 * Handles proxy objects, circular references, and special types.
 */
function deepClone<T>(obj: T): T {
  // Handle primitives and null
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Handle functions (pass through, can't be cloned)
  if (typeof obj === 'function') {
    return obj;
  }

  // Handle proxy objects with snapshot method
  if (typeof (obj as any).__getSnapshot === 'function') {
    return (obj as any).__getSnapshot() as T;
  }

  // Handle types that can't be cloned (return as-is)
  if (obj instanceof WeakMap || obj instanceof WeakSet) {
    return obj;
  }

  // Use a WeakMap to track visited objects and handle circular references
  const visited = new WeakMap();

  function cloneInternal(value: any): any {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Functions can't be cloned, pass through
    if (typeof value === 'function') {
      return value;
    }

    // Check for circular reference
    if (visited.has(value)) {
      return visited.get(value);
    }

    // Handle types that can't be cloned
    if (value instanceof WeakMap || value instanceof WeakSet) {
      return value;
    }

    // Try structuredClone for supported types (Date, Map, Set, etc.)
    // This is faster than manual cloning for these types
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Map ||
      value instanceof Set ||
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer
    ) {
      try {
        return structuredClone(value);
      } catch {
        // If structuredClone fails, fall through to manual handling
      }
    }

    // Handle arrays
    if (Array.isArray(value)) {
      const arrClone: any[] = [];
      visited.set(value, arrClone);
      for (let i = 0; i < value.length; i++) {
        arrClone[i] = cloneInternal(value[i]);
      }
      return arrClone;
    }

    // Handle plain objects
    const objClone: any = {};
    visited.set(value, objClone);

    // Clone string keys
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        objClone[key] = cloneInternal(value[key]);
      }
    }

    // Clone Symbol keys
    const symbolKeys = Object.getOwnPropertySymbols(value);
    for (const sym of symbolKeys) {
      objClone[sym] = cloneInternal(value[sym]);
    }

    return objClone;
  }

  return cloneInternal(obj);
}

/**
 * Compare two values and detect changes with full paths.
 *
 * Thin wrapper over [`portable.diffState`] — the algorithm lives in
 * the Rust engine at `hypen-engine-rs/src/portable/diff.rs` and is
 * called through the WASM installed by `@hypen-space/server` /
 * `@hypen-space/web-engine`. When `@hypen-space/core` is used
 * standalone (no WASM available), a byte-identical TS fallback in
 * `portable.ts` takes over.
 */
function diffState(
  oldState: any,
  newState: any,
  basePath: string = ""
): StateChange {
  return portable.diffState(oldState, newState, basePath);
}

/**
 * Create an observable state object that tracks changes
 */
export function createObservableState<T extends object>(
  initialState: T,
  options?: StateObserverOptions
): T {
  // Use default options if not provided
  const opts: StateObserverOptions = options || { onChange: () => {} };

  // Handle null/undefined by using an empty object
  // This allows modules to start with null state
  if (initialState === null || initialState === undefined) {
    initialState = {} as T;
  }

  // Detect and reject primitive wrapper objects (Number, String, Boolean)
  // These cannot be properly proxied due to internal slots
  if (
    initialState instanceof Number ||
    initialState instanceof String ||
    initialState instanceof Boolean
  ) {
    throw new TypeError(
      "Cannot create observable state from primitive wrapper objects (Number, String, Boolean). " +
      "Use plain primitives or regular objects instead."
    );
  }

  // Clone the initial state to ensure each observable has its own copy
  // This prevents multiple modules from sharing the same underlying state object
  initialState = deepClone(initialState);

  // Keep a snapshot of the last known state
  let lastSnapshot = deepClone(initialState);
  const pathPrefix = opts.pathPrefix || "";

  // Track if we're in a batch update
  let batchDepth = 0;
  let pendingChange: StateChange | null = null;

  /**
   * Write the live value at each changed path into `lastSnapshot`,
   * cloning only those subtrees. Paths come from `diffState`, so every
   * parent container is guaranteed to exist in the snapshot: the diff
   * only reports a granular child path when both sides have the same
   * container there (container replacements arrive as one path for the
   * container itself). A path whose live value is gone (deleted key)
   * is deleted from the snapshot too — leaving a `null` behind would
   * make the next diff re-report the deletion forever.
   */
  function updateSnapshotAtPaths(paths: StatePath[]): void {
    const prefixLen = pathPrefix ? pathPrefix.length + 1 : 0;
    for (const fullPath of paths) {
      const segments = fullPath.slice(prefixLen).split(".");
      const last = segments.pop()!;

      // Walk both trees to the parent container (raw target, not the
      // proxy — this is bookkeeping, not an observable read).
      let src: any = initialState;
      let dst: any = lastSnapshot;
      let broken = false;
      for (const seg of segments) {
        src = src?.[seg];
        dst = dst?.[seg];
        if (src === null || typeof src !== "object" || dst === null || typeof dst !== "object") {
          broken = true;
          break;
        }
      }
      if (broken || dst === null || typeof dst !== "object") {
        // Structural surprise (shouldn't happen per the diff contract) —
        // fall back to a full clone for correctness.
        lastSnapshot = deepClone(state);
        return;
      }

      const liveValue = src?.[last];
      if (liveValue === undefined && !(src !== null && typeof src === "object" && last in src)) {
        if (Array.isArray(dst) && Array.isArray(src)) {
          // Index beyond the live array's new length: truncate rather
          // than delete, which would leave a hole and a stale length.
          dst.length = src.length;
        } else {
          delete dst[last];
        }
      } else {
        dst[last] = deepClone(liveValue);
      }
    }
  }

  function notifyChange() {
    if (batchDepth > 0) return;

    // Compare current state with last snapshot
    const change = diffState(lastSnapshot, state, pathPrefix);

    if (change.paths.length > 0) {
      // Bring the snapshot up to date at exactly the paths the diff
      // reported, instead of re-cloning the entire state tree. Unchanged
      // subtrees are value-equal by the diff's own contract (and already
      // decoupled from live state by the previous clone), so this is
      // O(changed values), not O(state) — the difference between ~0ms and
      // a full deep clone of a 1,000-row list on every mutation batch.
      updateSnapshotAtPaths(change.paths);

      // Merge with pending changes if any
      if (pendingChange) {
        change.paths.push(...pendingChange.paths);
        Object.assign(change.newValues, pendingChange.newValues);
        pendingChange = null;
      }

      // Notify
      opts.onChange(change);
    }
  }

  // Track if we have a pending microtask notification
  let notificationPending = false;

  /**
   * Run the queued notification NOW (and neutralize the queued microtask).
   * Exposed on the proxy as `__flushNow` so hosts can synchronously drain
   * mutations that predate an event — e.g. the module runtime flushes
   * pre-queued changes UNSTAMPED before arming a transaction-animation
   * stamp for a dispatch (Option D). No-op when nothing is pending.
   */
  function flushNow() {
    if (!notificationPending) return;
    notificationPending = false;
    if (batchDepth === 0) {
      notifyChange();
    }
    // Inside a batch the batch's __endBatch performs the notify.
  }

  function scheduleBatch() {
    if (batchDepth === 0) {
      // If not in a batch, schedule notification in next microtask to coalesce rapid changes
      if (!notificationPending) {
        notificationPending = true;
        queueMicrotask(() => {
          // Already drained synchronously via __flushNow (or re-queued):
          // this stale microtask stands down.
          if (!notificationPending) return;
          notificationPending = false;
          if (batchDepth === 0) {
            notifyChange();
          } else {
            // A batch started after we scheduled; the batch's __endBatch will
            // call notifyChange() when it completes, so nothing to do here.
          }
        });
      }
    } else {
      // Inside a batch — mark that changes occurred so __endBatch knows to notify
      pendingChange = pendingChange || { paths: [], newValues: {} };
    }
  }

  // WeakMap to cache proxies by their raw target
  // This is essential for circular reference handling
  const proxyCache = new WeakMap<object, any>();

  function createProxy(target: any, basePath: string): any {
    // Check cache first (handles circular references)
    const cached = proxyCache.get(target);
    if (cached) return cached;

    const proxy = new Proxy(target, {
      get(obj, prop) {
        // Self-detection: if checking IS_PROXY, return true
        // This allows us to detect if a value is already proxied
        if (prop === IS_PROXY) return true;

        // Allow access to raw target (useful for debugging/serialization)
        if (prop === RAW_TARGET) return obj;

        // Expose batch control methods
        if (prop === "__beginBatch") {
          return () => {
            batchDepth++;
          };
        }
        if (prop === "__endBatch") {
          return () => {
            batchDepth--;
            if (batchDepth === 0) {
              notifyChange();
            }
          };
        }
        if (prop === "__getSnapshot") {
          return () => deepClone(obj);
        }
        if (prop === "__flushNow") {
          return flushNow;
        }

        const value = obj[prop];

        // Return proxied nested objects/arrays, but NOT special types
        if (value && typeof value === "object") {
          // Fast path: if already a proxy, return as-is
          // This check is O(1) and avoids WeakMap lookup
          if ((value as any)[IS_PROXY]) {
            return value;
          }

          // Check for special object types that should not be proxied
          if (
            value instanceof Date ||
            value instanceof RegExp ||
            value instanceof Map ||
            value instanceof Set ||
            value instanceof WeakMap ||
            value instanceof WeakSet
          ) {
            return value;
          }

          // Check cache for this value (handles circular refs and repeated access)
          const cachedNested = proxyCache.get(value);
          if (cachedNested) {
            return cachedNested;
          }

          // Create proxy for nested object/array
          const nestedProxy = createProxy(value, basePath ? `${basePath}.${String(prop)}` : String(prop));
          return nestedProxy;
        }

        return value;
      },

      set(obj, prop, value) {
        const oldValue = obj[prop];

        // If setting an object that's already a proxy, unwrap it first
        // to store the raw value (prevents proxy-wrapping-proxy)
        if (value && typeof value === "object" && (value as any)[IS_PROXY]) {
          value = (value as any)[RAW_TARGET];
        }

        // Set the new value
        obj[prop] = value;

        if (oldValue !== value) {
          scheduleBatch();
        }

        return true;
      },

      deleteProperty(obj, prop) {
        const existed = Object.prototype.hasOwnProperty.call(obj, prop);
        const result = delete obj[prop];
        if (existed) {
          scheduleBatch();
        }
        return result;
      },
    });

    // Cache the proxy before returning
    proxyCache.set(target, proxy);
    return proxy;
  }

  const state = createProxy(initialState, pathPrefix);
  return state as T;
}

/**
 * Helper to batch multiple state updates
 */
export function batchStateUpdates<T>(state: T, fn: () => void): void {
  const s = state as any;
  if (s.__beginBatch && s.__endBatch) {
    s.__beginBatch();
    try {
      fn();
    } finally {
      s.__endBatch();
    }
  } else {
    fn();
  }
}

/**
 * Get a snapshot of the current state
 */
export function getStateSnapshot<T>(state: T): T {
  const s = state as any;
  if (s.__getSnapshot) {
    return s.__getSnapshot();
  }
  return deepClone(state);
}

/**
 * Check if a value is a Hypen state proxy
 */
export function isStateProxy(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as any)[IS_PROXY] === true;
}

/**
 * Get the raw (unwrapped) target from a proxy
 * Returns the value as-is if not a proxy
 */
export function unwrapProxy<T>(value: T): T {
  if (value !== null && typeof value === 'object' && (value as any)[IS_PROXY]) {
    return (value as any)[RAW_TARGET];
  }
  return value;
}
