import type { KeyStrategy } from "./strategies.js";
import type { StateStore } from "@hypen-space/core/persistence";

/**
 * Cloudflare Durable Object storage interface.
 * Matches the DurableObjectStorage API from cloudflare:workers.
 */
export interface DurableObjectStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Optional (present on Cloudflare): used to sweep expired session snapshots. */
  list?(options?: { prefix?: string }): Promise<Map<string, unknown>>;
}

export interface DurableObjectStateStore<T> extends StateStore<T> {
  /**
   * @internal -- a copy of this store permanently bound to `storage`.
   *
   * `HypenDurableObject` gives every module instance of a session the copy
   * bound to ITS OWN storage. Every Durable Object of a class shares one
   * isolate and one module definition (so one store object); a store whose
   * storage is a shared mutable slot would let a save that runs after an
   * `await` land in whichever DO bound last — another visitor's storage.
   */
  __forStorage(storage: DurableObjectStorage): StateStore<T>;
  /**
   * @internal @deprecated -- sets the fallback storage used when this store
   * is called directly rather than through a module instance of a
   * `HypenDurableObject` session (which uses `__forStorage`). Shared by every
   * DO of the class: do not rely on it across `await`s.
   */
  __bindStorage(storage: DurableObjectStorage): void;
}

// ---------------------------------------------------------------------------
// Ambient storage scope — for custom stores that do not implement
// `__forStorage` (a wrapper written by hand around a `durableObjectStore`).
// ---------------------------------------------------------------------------

interface StorageScope {
  run<R>(storage: DurableObjectStorage, fn: () => R): R;
  getStore(): DurableObjectStorage | undefined;
}

let scopeProbe: StorageScope | null | undefined;

/**
 * An `AsyncLocalStorage` for the ambient storage, when the runtime has one
 * (`nodejs_compat` on Workers; Bun/Node). Probed through
 * `process.getBuiltinModule` so this module never imports `node:*` — a
 * Worker without `nodejs_compat` still bundles, and simply gets the
 * synchronous fallback below.
 */
function storageScope(): StorageScope | null {
  if (scopeProbe !== undefined) return scopeProbe;
  scopeProbe = null;
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const mod = proc?.getBuiltinModule?.("node:async_hooks") as
      | { AsyncLocalStorage?: new () => StorageScope }
      | undefined;
    if (mod?.AsyncLocalStorage) scopeProbe = new mod.AsyncLocalStorage();
  } catch {
    scopeProbe = null;
  }
  return scopeProbe;
}

/** Storage set for the synchronous part of a scoped call (no-ALS fallback). */
let syncAmbient: DurableObjectStorage | null = null;

/**
 * The storage of the Durable Object whose store call is running, if any:
 * set by {@link withStorageScope} (which `HypenDurableObject` wraps around
 * every call into a custom store). With `AsyncLocalStorage` it follows the
 * call across `await`s; without it, only the call's synchronous prefix.
 */
export function ambientStorage(): DurableObjectStorage | null {
  return storageScope()?.getStore() ?? syncAmbient;
}

/** Whether {@link ambientStorage} follows a scoped call across `await`s. */
export function hasAsyncStorageScope(): boolean {
  return storageScope() !== null;
}

/**
 * Run `fn` with `storage` as the ambient storage: every `durableObjectStore`
 * called inside it (directly or through a wrapper) resolves to `storage`
 * rather than its shared fallback.
 */
export function withStorageScope<R>(storage: DurableObjectStorage, fn: () => R): R {
  const prev = syncAmbient;
  syncAmbient = storage;
  try {
    const scope = storageScope();
    return scope ? scope.run(storage, fn) : fn();
  } finally {
    syncAmbient = prev;
  }
}

/**
 * `store` with every call run inside `storage`'s scope. How
 * `HypenDurableObject` binds a custom store that does not implement
 * `__forStorage`: the `durableObjectStore`s it wraps resolve to THIS DO's
 * storage instead of the class-wide fallback.
 */
export function scopedStateStore<T>(
  store: StateStore<T>,
  storage: DurableObjectStorage,
): StateStore<T> {
  return {
    resolveKey: (state, moduleName, sessionId) =>
      withStorageScope(storage, () => store.resolveKey(state, moduleName, sessionId)),
    load: (key) => withStorageScope(storage, () => store.load(key)),
    save: (key, state) => withStorageScope(storage, () => store.save(key, state)),
    delete: (key) => withStorageScope(storage, () => store.delete(key)),
  };
}

function boundStore<T>(
  strategy: KeyStrategy<T>,
  getStorage: () => DurableObjectStorage | null,
): StateStore<T> {
  const storage = (): DurableObjectStorage => {
    const s = getStorage();
    if (!s)
      throw new Error(
        "DurableObject storage not bound. Call __bindStorage() first.",
      );
    return s;
  };
  return {
    resolveKey(state, moduleName, sessionId) {
      return strategy.resolve(state, moduleName, sessionId);
    },

    async load(key) {
      const data = await storage().get(`hypen:${key}`);
      return (data as T) ?? null;
    },

    async save(key, state) {
      await storage().put(`hypen:${key}`, state);
    },

    async delete(key) {
      await storage().delete(`hypen:${key}`);
    },
  };
}

export function durableObjectStore<T>(
  strategy: KeyStrategy<T>,
): DurableObjectStateStore<T> {
  let fallback: DurableObjectStorage | null = null;
  // One bound copy per storage handle (i.e. per DO incarnation).
  const copies = new WeakMap<DurableObjectStorage, StateStore<T>>();

  return {
    // Called directly (not through `__forStorage`): the ambient storage of a
    // scoped call (a custom wrapper store under `HypenDurableObject`), else
    // the deprecated class-wide fallback.
    ...boundStore(strategy, () => ambientStorage() ?? fallback),

    __forStorage(storage: DurableObjectStorage) {
      let copy = copies.get(storage);
      if (!copy) {
        copy = boundStore(strategy, () => storage);
        copies.set(storage, copy);
      }
      return copy;
    },

    __bindStorage(s: DurableObjectStorage) {
      fallback = s;
    },
  };
}

/** Whether `store` is a `durableObjectStore` (exposes `__forStorage`). */
export function isDurableObjectStore(
  store: unknown,
): store is DurableObjectStateStore<unknown> {
  return (
    !!store &&
    typeof (store as { __forStorage?: unknown }).__forStorage === "function"
  );
}

/**
 * Build a custom store on top of a `durableObjectStore` — e.g. one that
 * saves only some fields, or transforms the value on load — that stays bound
 * to each Durable Object's own storage.
 *
 * `wrap` receives a store bound to one storage and returns the custom store
 * over it. The result implements `__forStorage` by wrapping
 * `inner.__forStorage(storage)`, so `HypenDurableObject` gives every DO its
 * own wrapped copy (memoised per storage, so per-copy state such as a
 * "last saved" cache in `wrap`'s closure is per DO too).
 *
 * ```ts
 * const prefs = deriveStore(
 *   durableObjectStore<Prefs>(withKey(() => "prefs")),
 *   (inner) => ({
 *     resolveKey: (s, m, id) => inner.resolveKey(pick(s), m, id),
 *     load: (key) => inner.load(key),
 *     save: (key, state) => inner.save(key, pick(state)),
 *     delete: (key) => inner.delete(key),
 *   }),
 * );
 * ```
 */
export function deriveStore<T, I = T>(
  inner: DurableObjectStateStore<I>,
  wrap: (bound: StateStore<I>) => StateStore<T>,
): DurableObjectStateStore<T> {
  const copies = new WeakMap<DurableObjectStorage, StateStore<T>>();
  const unbound = wrap(inner);
  return {
    resolveKey: (state, moduleName, sessionId) => unbound.resolveKey(state, moduleName, sessionId),
    load: (key) => unbound.load(key),
    save: (key, state) => unbound.save(key, state),
    delete: (key) => unbound.delete(key),
    __forStorage(storage: DurableObjectStorage) {
      let copy = copies.get(storage);
      if (!copy) {
        copy = wrap(inner.__forStorage(storage));
        copies.set(storage, copy);
      }
      return copy;
    },
    __bindStorage(storage: DurableObjectStorage) {
      inner.__bindStorage(storage);
    },
  };
}
