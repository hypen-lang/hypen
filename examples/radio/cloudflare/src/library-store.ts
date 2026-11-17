// Persist only the visitor's library out of the App module's state.
//
// `.persist(store)` snapshots the WHOLE module state on every change. The App
// shell also holds transient playback state (stream URL, buffering status,
// ICY title) that must not come back on the next visit — a reload should
// never auto-start audio. This wrapper saves just the library fields and
// loads them back as a partial, which the runtime merges over initialState.

import { durableObjectStore, withKey } from "@hypen-space/cf";
import type { StateStore } from "@hypen-space/core/persistence";

/** Each visitor has their own DO (see visitor.ts), so one fixed key per DO. */
const LIBRARY_KEY = "radio-library";

export function libraryStore<T extends object, K extends keyof T>(fields: K[]): StateStore<T> {
  const inner = durableObjectStore<Pick<T, K>>(withKey<Pick<T, K>>(() => LIBRARY_KEY));
  const pick = (state: T): Pick<T, K> => {
    const out = {} as Pick<T, K>;
    for (const f of fields) out[f] = state[f];
    return out;
  };
  const over = (base: StateStore<Pick<T, K>>): StateStore<T> => ({
    resolveKey: (state: T, moduleName: string, sessionId: string) =>
      base.resolveKey(pick(state), moduleName, sessionId),
    load: async (key: string) => ((await base.load(key)) as T | null) ?? null,
    save: (key: string, state: T) => base.save(key, pick(state)),
    delete: (key: string) => base.delete(key),
  });
  // All visitors' DOs share this module (one isolate), so one store object.
  // HypenDurableObject gives each DO the copy bound to ITS OWN storage via
  // `__forStorage`; `__bindStorage` sets the class-wide fallback for direct
  // calls. (`deriveStore` in @hypen-space/cf > 0.6.7 builds this; spelled
  // out so the example also builds against the published 0.6.7.)
  type Storage = Parameters<typeof inner.__bindStorage>[0];
  const innerForStorage = (inner as {
    __forStorage?: (storage: Storage) => StateStore<Pick<T, K>>;
  }).__forStorage;
  const copies = new WeakMap<Storage, StateStore<T>>();
  return Object.assign(over(inner), {
    __bindStorage: (s: Storage) => inner.__bindStorage(s),
    __forStorage(s: Storage): StateStore<T> {
      let copy = copies.get(s);
      if (!copy) {
        copy = over(innerForStorage ? innerForStorage.call(inner, s) : inner);
        copies.set(s, copy);
      }
      return copy;
    },
  });
}
