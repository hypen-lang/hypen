import { describe, test, expect } from "bun:test";
import { app, HypenModuleInstance, type HypenModuleDefinition } from "../packages/core/src/app";
import type { StateStore } from "../packages/core/src/persistence";
import type { Action } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { flushMicrotasks } from "./helpers";

class FakeEngine {
  public setModuleCalls: Array<{ name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> }> = [];
  public registerModuleCalls: Array<{ name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> }> = [];
  public notifyCalls: Array<{ scope: string | null; paths: string[]; changedValues: Record<string, unknown> }> = [];
  public actionHandlers: Map<string, (action: Action) => Promise<void> | void> = new Map();

  setModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.setModuleCalls.push({ name, actions, stateKeys, initialState });
  }

  registerModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.registerModuleCalls.push({ name, actions, stateKeys, initialState });
  }

  updateStateSparse(scope: string | null, paths: string[], changedValues: Record<string, unknown>) {
    this.notifyCalls.push({ scope, paths, changedValues: JSON.parse(JSON.stringify(changedValues)) });
  }

  onAction(name: string, handler: (action: Action) => void | Promise<void>) {
    this.actionHandlers.set(name, handler);
  }

  dispatchRegistered(name: string, payload?: unknown, sender?: string) {
    const handler = this.actionHandlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler({ name, payload, sender });
  }
}

function createMockStore<T>(stored?: T): StateStore<T> & { saves: Array<{ key: string; state: T }>; loads: string[]; deletes: string[] } {
  const saves: Array<{ key: string; state: T }> = [];
  const loads: string[] = [];
  const deletes: string[] = [];
  return {
    saves,
    loads,
    deletes,
    resolveKey: (_state, moduleName, _sessionId) => `test:${moduleName}`,
    load: async (key) => {
      loads.push(key);
      return stored ?? null;
    },
    save: async (key, state) => {
      saves.push({ key, state: structuredClone(state) });
    },
    delete: async (key) => {
      deletes.push(key);
    },
  };
}

describe("StateStore persistence", () => {
  describe("HypenAppBuilder", () => {
    test(".persist() adds stateStore to definition", () => {
      const store = createMockStore<{ count: number }>();
      const definition = app
        .defineState({ count: 0 }, { name: "Counter" })
        .persist(store)
        .build();

      expect(definition.stateStore).toBe(store);
    });

    test("definition without .persist() has no stateStore", () => {
      const definition = app
        .defineState({ count: 0 }, { name: "Counter" })
        .build();

      expect(definition.stateStore).toBeUndefined();
    });
  });

  describe("HypenModuleInstance", () => {
    test("loads persisted state before onCreated fires", async () => {
      const store = createMockStore<{ count: number }>({ count: 42 });
      const createdStates: number[] = [];

      const definition = app
        .defineState({ count: 0 }, { name: "Counter" })
        .persist(store)
        .onCreated((state) => {
          createdStates.push(state.count);
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // onCreated should have seen the restored state
      expect(createdStates).toEqual([42]);
      expect(store.loads).toContain("test:Counter");
    });

    test("merges stored state over initialState", async () => {
      const store = createMockStore<{ count: number; label: string }>({ count: 10 } as any);

      const definition = app
        .defineState({ count: 0, label: "default" }, { name: "Merger" })
        .persist(store)
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      const state = instance.getState();
      // count comes from stored, label from initialState
      expect(state.count).toBe(10);
      expect(state.label).toBe("default");
    });

    test("calls save() on state mutation (debounced)", async () => {
      const store = createMockStore<{ count: number }>();

      const definition = app
        .defineState({ count: 0 }, { name: "Saver" })
        .persist(store)
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // Clear loads from initialization
      store.saves.length = 0;

      // Trigger a state mutation via action
      await engine.dispatchRegistered("increment");

      // Wait for the debounce timer (50ms) to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(store.saves.length).toBeGreaterThanOrEqual(1);
      const lastSave = store.saves[store.saves.length - 1];
      expect(lastSave.key).toBe("test:Saver");
      expect(lastSave.state.count).toBe(1);
    });

    test("key transition: null to value activates persistence", async () => {
      type State = { userId: string | null; data: string };
      const storedData: State = { userId: "u-1", data: "persisted" };
      const store = createMockStore<State>(storedData);
      // Override resolveKey to use userId as key (null when no user)
      store.resolveKey = (state, _moduleName, _sessionId) => {
        return state.userId ? `user:${state.userId}` : null;
      };

      const definition = app
        .defineState<State>({ userId: null, data: "initial" }, { name: "WithKey" })
        .persist(store)
        .onAction("login", ({ state }) => {
          state.userId = "u-1";
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // No key resolved initially (userId is null), so no load yet
      expect(store.loads.length).toBe(0);

      // Simulate login — sets userId, which triggers persistIfNeeded
      await engine.dispatchRegistered("login");

      // Wait for activatePersistence async load
      await flushMicrotasks(5);
      await new Promise((r) => setTimeout(r, 50));

      // Should have loaded from the store
      expect(store.loads).toContain("user:u-1");
      // State should have merged stored data
      expect(instance.getState().data).toBe("persisted");
    });

    test("key transition: value to null deactivates persistence (no delete)", async () => {
      type State = { userId: string | null; count: number };
      const store = createMockStore<State>({ userId: "u-1", count: 5 });
      store.resolveKey = (state, _moduleName, _sessionId) => {
        return state.userId ? `user:${state.userId}` : null;
      };

      const definition = app
        .defineState<State>({ userId: "u-1", count: 0 }, { name: "Logout" })
        .persist(store)
        .onAction("logout", ({ state }) => {
          state.userId = null;
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // Initially loaded
      expect(store.loads).toContain("user:u-1");

      // Logout — key becomes null
      await engine.dispatchRegistered("logout");
      await flushMicrotasks(3);
      await new Promise((r) => setTimeout(r, 100));

      // No delete should have been called
      expect(store.deletes.length).toBe(0);
    });

    test("destroy() flushes pending writes", async () => {
      const store = createMockStore<{ count: number }>();

      const definition = app
        .defineState({ count: 0 }, { name: "Flusher" })
        .persist(store)
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // Trigger a mutation (debounce timer starts)
      await engine.dispatchRegistered("increment");

      // Destroy immediately — should flush the pending save
      await instance.destroy();

      // Should have a save with count: 1
      const flushSave = store.saves.find((s) => s.state.count === 1);
      expect(flushSave).toBeDefined();
      expect(flushSave!.key).toBe("test:Flusher");
    });

    test("no stateStore = no persistence behavior", async () => {
      const definition = app
        .defineState({ count: 0 }, { name: "NoPersist" })
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .build();

      const engine = new FakeEngine();
      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
      await instance.waitForReady();

      // Trigger mutation
      await engine.dispatchRegistered("increment");
      await flushMicrotasks(3);

      // No persistence-related behavior — just verify it works normally
      expect(instance.getState().count).toBe(1);

      // Destroy should work without errors
      await instance.destroy();
    });
  });
});
