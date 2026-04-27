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
}

export interface DurableObjectStateStore<T> extends StateStore<T> {
  /** @internal -- called by HypenDurableObject to inject DO storage */
  __bindStorage(storage: DurableObjectStorage): void;
}

export function durableObjectStore<T>(
  strategy: KeyStrategy<T>,
): DurableObjectStateStore<T> {
  let storage: DurableObjectStorage | null = null;

  return {
    __bindStorage(s: DurableObjectStorage) {
      storage = s;
    },

    resolveKey(state, moduleName, sessionId) {
      return strategy.resolve(state, moduleName, sessionId);
    },

    async load(key) {
      if (!storage)
        throw new Error(
          "DurableObject storage not bound. Call __bindStorage() first.",
        );
      const data = await storage.get(`hypen:${key}`);
      return (data as T) ?? null;
    },

    async save(key, state) {
      if (!storage)
        throw new Error(
          "DurableObject storage not bound. Call __bindStorage() first.",
        );
      await storage.put(`hypen:${key}`, state);
    },

    async delete(key) {
      if (!storage)
        throw new Error(
          "DurableObject storage not bound. Call __bindStorage() first.",
        );
      await storage.delete(`hypen:${key}`);
    },
  };
}
