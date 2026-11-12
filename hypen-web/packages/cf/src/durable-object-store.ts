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
    ...boundStore(strategy, () => fallback),

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
