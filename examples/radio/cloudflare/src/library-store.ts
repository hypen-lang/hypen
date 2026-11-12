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
  // `__bindStorage` is how HypenDurableObject injects DO storage; forward it.
  return Object.assign(
    {
      resolveKey: (state: T, moduleName: string, sessionId: string) =>
        inner.resolveKey(pick(state), moduleName, sessionId),
      load: async (key: string) => ((await inner.load(key)) as T | null) ?? null,
      save: (key: string, state: T) => inner.save(key, pick(state)),
      delete: (key: string) => inner.delete(key),
    },
    { __bindStorage: (s: Parameters<typeof inner.__bindStorage>[0]) => inner.__bindStorage(s) },
  ) as StateStore<T>;
}
