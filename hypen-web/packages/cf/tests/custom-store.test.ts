import { describe, test, expect, beforeEach } from "bun:test";
import {
  HypenDurableObject,
  deriveStore,
  durableObjectStore,
  withKey,
  type HypenDurableObjectConfig,
  type DurableObjectStorage,
  type StateStore,
} from "../src/index.js";
import { stateStoreForStorage } from "../src/durable-object.js";
import { app } from "@hypen-space/core/app";
import type { BaseEngine } from "@hypen-space/core/engine-base";

/**
 * Custom StateStores under `HypenDurableObject`.
 *
 * Every DO of a class shares one isolate and one module definition, so one
 * store object. `durableObjectStore` hands each DO a copy bound to its own
 * storage (`__forStorage`); a hand-written wrapper around one does not have
 * that hook. These tests pin that such a wrapper still reads and writes the
 * storage of the DO whose module instance calls it — also when its call
 * crosses an `await` while another DO re-binds the class-wide fallback.
 */

function memStorage(): DurableObjectStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => data.get(k),
    put: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => data.delete(k),
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

interface Prefs {
  unit: string;
  scratch?: string;
}

/** The pre-`deriveStore` example pattern: a wrapper that awaits before delegating. */
function handWrittenStore() {
  const base = durableObjectStore<Prefs>(withKey<Prefs>(() => "prefs"));
  const store: StateStore<Prefs> & { __bindStorage(s: DurableObjectStorage): void } = {
    __bindStorage: (s) => base.__bindStorage(s),
    resolveKey: (state, m, id) => base.resolveKey(state, m, id),
    async load(key) {
      await tick();
      return base.load(key);
    },
    async save(key, state) {
      await tick(); // e.g. a debounce, a validation fetch, ...
      await base.save(key, { unit: state.unit });
    },
    delete: (key) => base.delete(key),
  };
  return store;
}

describe("custom StateStore without __forStorage", () => {
  test("control: called as-is, a save after an await lands in the DO that bound last", async () => {
    const a = memStorage();
    const b = memStorage();
    const store = handWrittenStore();
    store.__bindStorage(a); // DO A handles a message...
    const pending = store.save("prefs", { unit: "F" });
    store.__bindStorage(b); // ...DO B handles one while A's save awaits.
    await pending;
    // This was the host's behaviour for such stores: A's save went to B.
    expect(a.data.size).toBe(0);
    expect(b.data.get("hypen:prefs")).toEqual({ unit: "F" });
  });

  test("through the DO host, saves and loads stay in each DO's own storage", async () => {
    const a = memStorage();
    const b = memStorage();
    const store = handWrittenStore();
    const forA = stateStoreForStorage(store, a);
    const forB = stateStoreForStorage(store, b);

    store.__bindStorage(a);
    const saveA = forA.save("prefs", { unit: "F" });
    store.__bindStorage(b); // the class-wide fallback moves to B mid-save
    const saveB = forB.save("prefs", { unit: "C" });
    store.__bindStorage(a);
    await Promise.all([saveA, saveB]);

    expect(a.data.get("hypen:prefs")).toEqual({ unit: "F" });
    expect(b.data.get("hypen:prefs")).toEqual({ unit: "C" });

    store.__bindStorage(b);
    const [loadA, loadB] = await Promise.all([forA.load("prefs"), forB.load("prefs")]);
    expect(loadA).toEqual({ unit: "F" });
    expect(loadB).toEqual({ unit: "C" });
  });

  test("works with no fallback bound at all", async () => {
    const a = memStorage();
    const store = handWrittenStore();
    await stateStoreForStorage(store, a).save("prefs", { unit: "F" });
    expect(a.data.get("hypen:prefs")).toEqual({ unit: "F" });
  });

  test("the scoped copy is stable per (store, storage)", () => {
    const a = memStorage();
    const b = memStorage();
    const store = handWrittenStore();
    expect(stateStoreForStorage(store, a)).toBe(stateStoreForStorage(store, a));
    expect(stateStoreForStorage(store, a)).not.toBe(stateStoreForStorage(store, b));
  });

  test("a durableObjectStore still gets its __forStorage copy", async () => {
    const a = memStorage();
    const store = durableObjectStore<Prefs>(withKey<Prefs>(() => "k"));
    expect(stateStoreForStorage(store, a)).toBe(store.__forStorage(a));
  });
});

describe("deriveStore", () => {
  function prefsStore() {
    let wraps = 0;
    const store = deriveStore<Prefs>(durableObjectStore<Prefs>(withKey<Prefs>(() => "prefs")), (inner) => {
      wraps++;
      // Per-copy cache: must be per DO, never shared across visitors.
      let last: string | null = null;
      return {
        resolveKey: (s, m, id) => inner.resolveKey(s, m, id),
        async load(key) {
          await tick();
          return inner.load(key);
        },
        async save(key, state) {
          const json = JSON.stringify({ unit: state.unit });
          if (json === last) return;
          last = json;
          await tick();
          await inner.save(key, { unit: state.unit });
        },
        delete: (key) => inner.delete(key),
      };
    });
    return { store, wraps: () => wraps };
  }

  test("implements __forStorage, memoised per storage", () => {
    const a = memStorage();
    const b = memStorage();
    const { store, wraps } = prefsStore();
    const before = wraps();
    expect(store.__forStorage(a)).toBe(store.__forStorage(a));
    expect(store.__forStorage(a)).not.toBe(store.__forStorage(b));
    expect(wraps() - before).toBe(2);
    expect(stateStoreForStorage(store, a)).toBe(store.__forStorage(a));
  });

  test("each DO's copy saves to its own storage, with its own closure state", async () => {
    const a = memStorage();
    const b = memStorage();
    const { store } = prefsStore();
    const forA = store.__forStorage(a);
    const forB = store.__forStorage(b);
    // Identical values from two visitors: a shared "last saved" cache would
    // skip B's write.
    await Promise.all([forA.save("prefs", { unit: "F" }), forB.save("prefs", { unit: "F", scratch: "x" })]);
    expect(a.data.get("hypen:prefs")).toEqual({ unit: "F" });
    expect(b.data.get("hypen:prefs")).toEqual({ unit: "F" });
    expect(await forA.load("prefs")).toEqual({ unit: "F" });
  });

  test("called directly, it uses the bound fallback", async () => {
    const a = memStorage();
    const { store } = prefsStore();
    store.__bindStorage(a);
    await store.save("prefs", { unit: "C" });
    expect(a.data.get("hypen:prefs")).toEqual({ unit: "C" });
  });
});

describe("HypenDurableObject host", () => {
  class NoEngineDO extends HypenDurableObject {
    constructor(ctx: any, env: any, private cfg: HypenDurableObjectConfig) {
      super(ctx, env);
    }
    getConfig(): HypenDurableObjectConfig {
      return this.cfg;
    }
    createEngine(): BaseEngine {
      throw new Error("no engine");
    }
  }

  beforeEach(() => app.clear?.());

  test("stateStoreFor binds a hand-written store to each DO's own storage", async () => {
    const store = handWrittenStore();
    const module = app.defineState<Prefs>({ unit: "C" }).persist(store).ui('Text("hi")');
    const cfg = { module, template: 'Text("hi")', moduleName: "App" };
    const a = memStorage();
    const b = memStorage();
    const doA = new NoEngineDO({ storage: a, acceptWebSocket() {}, getWebSockets: () => [] }, {}, cfg);
    const doB = new NoEngineDO({ storage: b, acceptWebSocket() {}, getWebSockets: () => [] }, {}, cfg);
    const hostA = (doA as any).getHost();
    const hostB = (doB as any).getHost();

    store.__bindStorage(a);
    const saveA = hostA.stateStoreFor(store).save("prefs", { unit: "F" });
    store.__bindStorage(b);
    await Promise.all([saveA, hostB.stateStoreFor(store).save("prefs", { unit: "C" })]);
    expect(a.data.get("hypen:prefs")).toEqual({ unit: "F" });
    expect(b.data.get("hypen:prefs")).toEqual({ unit: "C" });
  });
});
