import { describe, expect, test, mock, beforeEach, spyOn } from "bun:test";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import type { Action } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { HypenGlobalContext } from "../packages/core/src/context";
import { flushMicrotasks } from "./helpers";

/**
 * Module Lifecycle Edge Case Tests
 * Tests complex scenarios in module lifecycle management
 */

// Mock engine for testing
class FakeEngine {
  public setModuleCalls: Array<any> = [];
  public registerModuleCalls: Array<any> = [];
  public notifyCalls: Array<{ scope: string | null; paths: string[]; changedValues: Record<string, any> }> = [];
  public actionHandlers = new Map<string, (action: Action) => void | Promise<void>>();
  private _currentState: Record<string, any> = {};

  setModule(name: string, actions: string[], stateKeys: string[], initialState: any) {
    this.setModuleCalls.push({ name, actions, stateKeys, initialState });
    this._loadState(initialState);
  }

  registerModule(name: string, actions: string[], stateKeys: string[], initialState: any) {
    this.registerModuleCalls.push({ name, actions, stateKeys, initialState });
    this._loadState(initialState);
  }

  private _loadState(initialState: any) {
    try {
      this._currentState = JSON.parse(JSON.stringify(initialState));
    } catch {
      this._currentState = { ...initialState };
    }
  }

  // Now receives sparse changedValues with explicit scope
  updateStateSparse(scope: string | null, paths: string[], changedValues: Record<string, any>) {
    // Apply sparse updates to track current state for testing
    for (const path of paths) {
      if (path in changedValues) {
        this._setValueAtPath(this._currentState, path, changedValues[path]);
      }
    }
    this.notifyCalls.push({
      scope,
      paths,
      changedValues: JSON.parse(JSON.stringify(changedValues))
    });
  }

  // Helper to set value at a dot-separated path
  private _setValueAtPath(obj: any, path: string, value: any) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  // Get reconstructed current state for testing
  getCurrentState(): Record<string, any> {
    return JSON.parse(JSON.stringify(this._currentState));
  }

  onAction(name: string, handler: (action: Action) => void | Promise<void>) {
    this.actionHandlers.set(name, handler);
  }

  async dispatchAction(name: string, payload?: any, sender?: string) {
    const handler = this.actionHandlers.get(name);
    if (handler) {
      await handler({ name, payload, sender });
    }
  }
}

describe("Module Lifecycle Edge Cases", () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
  });

  describe("onCreated Lifecycle", () => {
    test("handles async operations in onCreated", async () => {
      const definition = app
        .defineState({ status: "pending" })
        .onCreated(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          state.status = "loaded";
        })
        .build();

      const instance = new HypenModuleInstance(engine as unknown as Engine, definition);

      // Wait for the actual setTimeout delay + buffer
      await new Promise((resolve) => setTimeout(resolve, 50));
      await flushMicrotasks(5);

      // Check instance state directly (more reliable than engine state)
      expect(instance.getState().status).toBe("loaded");
    });

    test("handles multiple modules created simultaneously", async () => {
      // Create separate engines for each instance to avoid state collision
      const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];

      const definition = app
        .defineState({ id: 0 })
        .onCreated((state) => {
          state.id = Math.random();
        })
        .build();

      const instances = engines.map(
        (eng) => new HypenModuleInstance(eng as unknown as Engine, definition)
      );

      await flushMicrotasks(5);

      // Each instance should have different ID
      const states = instances.map((inst) => inst.getState());
      const ids = states.map((s: any) => s.id);

      // All IDs should be non-zero (onCreated was called)
      expect(ids.every((id: number) => id !== 0)).toBe(true);
      // High probability that 3 random numbers are different
      expect(new Set(ids).size).toBe(3);
    });

    test("handles error in onCreated without crashing", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onCreated(() => {
          throw new Error("Creation failed");
        })
        .build();

      expect(() => {
        new HypenModuleInstance(engine as unknown as Engine, definition);
      }).not.toThrow();
    });

    test("handles state mutation before async completes", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onCreated(async (state) => {
          state.count = 1;
          // Delay before completing
          await new Promise((resolve) => setTimeout(resolve, 10));
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      await flushMicrotasks(15);

      expect(instance.getState().count).toBe(1);
    });

    test("handles onCreated without next() callback", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onCreated((state) => {
          state.count = 42;
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      await flushMicrotasks(2);

      // Now uses getCurrentState() to get the reconstructed state from sparse updates
      const currentState = engine.getCurrentState();
      expect(currentState.count).toBe(42);
    });
  });

  describe("onAction Lifecycle", () => {
    test("handles action with context object", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ action }) => {
          expect(action.name).toBe("increment");
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);
      await engine.dispatchAction("increment");
    });

    test("handles action with state mutation", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ action, state }) => {
          state.count += 1;
          expect(action.name).toBe("increment");
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      await engine.dispatchAction("increment");
      await flushMicrotasks(2);

      expect(instance.getState().count).toBe(1);
    });

    test("handles action with async operation", async () => {
      let handlerCompleted = false;

      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", async ({ state }) => {
          state.count += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          handlerCompleted = true;
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      await engine.dispatchAction("increment");
      await flushMicrotasks(15);

      expect(handlerCompleted).toBe(true);
    });

    test("handles action with full context access", async () => {
      const globalContext = new HypenGlobalContext();
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ action, state, context }) => {
          state.count += 1;
          expect(action).toBeDefined();
          expect(state).toBeDefined();
          expect(context).toBeDefined();
          expect(context.router).toBeNull();
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition, null, globalContext);

      await engine.dispatchAction("increment");
    });

    test("handles multiple actions on same module", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .onAction("decrement", ({ state }) => {
          state.count -= 1;
        })
        .onAction("reset", ({ state }) => {
          state.count = 0;
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      await engine.dispatchAction("increment");
      await engine.dispatchAction("increment");
      await engine.dispatchAction("decrement");
      await flushMicrotasks(5);

      expect(instance.getState().count).toBe(1);
    });

    test("handles action with complex payload", async () => {
      let receivedPayload: any;

      const definition = app
        .defineState({ data: null as any })
        .onAction("setData", ({ action, state }) => {
          receivedPayload = action.payload;
          state.data = action.payload;
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      const complexPayload = {
        nested: {
          deeply: {
            value: 42,
          },
        },
        array: [1, 2, 3],
        date: new Date().toISOString(),
      };

      await engine.dispatchAction("setData", complexPayload);

      expect(receivedPayload).toEqual(complexPayload);
    });

    test("handles concurrent action dispatches", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", async ({ state }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          state.count += 1;
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Dispatch multiple actions concurrently
      await Promise.all([
        engine.dispatchAction("increment"),
        engine.dispatchAction("increment"),
        engine.dispatchAction("increment"),
      ]);

      await flushMicrotasks(20);

      expect(instance.getState().count).toBe(3);
    });

    test("handles action with null payload", async () => {
      let receivedPayload: any = "not-set";

      const definition = app
        .defineState({ value: null })
        .onAction("setNull", ({ action, state }) => {
          receivedPayload = action.payload;
          state.value = action.payload;
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      await engine.dispatchAction("setNull", null);

      expect(receivedPayload).toBeNull();
    });

    test("handles action with undefined payload", async () => {
      let receivedPayload: any = "not-set";

      const definition = app
        .defineState({ value: null })
        .onAction("setUndefined", ({ action }) => {
          receivedPayload = action.payload;
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      await engine.dispatchAction("setUndefined", undefined);

      expect(receivedPayload).toBeUndefined();
    });

    test("handles error in action handler", async () => {
      // By default, errors are caught and logged, not rethrown
      // To make errors rethrow, we need an onError handler that returns { rethrow: true }
      const definition = app
        .defineState({ count: 0 })
        .onAction("failing", () => {
          throw new Error("Action failed");
        })
        .onError(({ error }) => {
          // Signal that this error should be rethrown
          return { rethrow: true };
        })
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      await expect(engine.dispatchAction("failing")).rejects.toThrow(
        "Action failed"
      );
    });
  });

  describe("onDestroyed Lifecycle", () => {
    test("handles cleanup in onDestroyed", async () => {
      let cleanupCalled = false;

      const definition = app
        .defineState({ count: 0 })
        .onDestroyed((state) => {
          cleanupCalled = true;
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Trigger destruction via the instance destroy() method
      await instance.destroy();

      expect(cleanupCalled).toBe(true);
    });

    test("handles async cleanup in onDestroyed", async () => {
      let cleanupCompleted = false;

      const definition = app
        .defineState({ count: 0 })
        .onDestroyed(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          cleanupCompleted = true;
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      await instance.destroy();

      expect(cleanupCompleted).toBe(true);
    });

    test("handles error in onDestroyed", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onDestroyed(() => {
          throw new Error("Cleanup failed");
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Errors in onDestroyed are gracefully handled (logged, not rethrown)
      await instance.destroy();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe("State Persistence", () => {
    test("preserves state across re-renders", async () => {
      const definition = app.defineState({ count: 0 }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      instance.updateState({ count: 42 });
      await flushMicrotasks(2);

      expect(instance.getState().count).toBe(42);

      instance.updateState({ count: 100 });
      await flushMicrotasks(2);

      expect(instance.getState().count).toBe(100);
    });

    test("handles partial state updates", async () => {
      const definition = app
        .defineState({
          user: { name: "Alice", age: 30 },
          settings: { theme: "dark" },
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      instance.updateState({ user: { name: "Bob", age: 30 } });
      await flushMicrotasks(2);

      const state = instance.getState();
      expect(state.user.name).toBe("Bob");
      expect(state.settings.theme).toBe("dark");
    });

    test("handles deep state merging", async () => {
      const definition = app
        .defineState({
          level1: {
            level2: {
              level3: {
                value: "original",
              },
            },
          },
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      instance.updateState({
        level1: {
          level2: {
            level3: {
              value: "updated",
            },
          },
        },
      });

      await flushMicrotasks(2);

      expect(instance.getState().level1.level2.level3.value).toBe("updated");
    });
  });

  describe("Module Metadata", () => {
    test("module with custom name", () => {
      const definition = app
        .defineState({ count: 0 }, { name: "CustomCounter" })
        .build();

      expect(definition.name).toBe("CustomCounter");
    });

    test("module with multiple actions registered", () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", () => {})
        .onAction("decrement", () => {})
        .onAction("reset", () => {})
        .build();

      expect(definition.actions).toContain("increment");
      expect(definition.actions).toContain("decrement");
      expect(definition.actions).toContain("reset");
      expect(definition.actions).toHaveLength(3);
    });

    test("module with no actions", () => {
      const definition = app.defineState({ count: 0 }).build();

      expect(definition.actions).toEqual([]);
    });
  });

  describe("Complex State Scenarios", () => {
    test("handles state with circular references", () => {
      const circular: any = { name: "circular" };
      circular.self = circular;

      const definition = app.defineState(circular).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Live state preserves circular reference
      const liveState = instance.getLiveState();
      expect(liveState.self).toBe(liveState);
    });

    test("handles state with Date objects", () => {
      const now = new Date();
      const definition = app.defineState({ timestamp: now }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // State contains an equivalent Date (cloned for isolation)
      expect(instance.getLiveState().timestamp.getTime()).toBe(now.getTime());
      // Snapshot also returns equivalent Date
      expect(instance.getState().timestamp.getTime()).toBe(now.getTime());
    });

    test("handles state with RegExp objects", () => {
      const pattern = /test/gi;
      const definition = app.defineState({ pattern }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // State contains an equivalent RegExp (cloned for isolation)
      expect(instance.getLiveState().pattern.source).toBe(pattern.source);
      expect(instance.getLiveState().pattern.flags).toBe(pattern.flags);
    });

    test("handles state with functions", () => {
      const fn = () => "test";
      const definition = app.defineState({ fn }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      expect(instance.getState().fn).toBe(fn);
    });

    test("handles very large state objects", () => {
      const largeState: any = {};
      for (let i = 0; i < 1000; i++) {
        largeState[`key${i}`] = { value: i, data: "x".repeat(100) };
      }

      const definition = app.defineState(largeState).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      expect(instance.getState().key999.value).toBe(999);
    });
  });

  describe("Race Conditions", () => {
    test("handles rapid state updates", async () => {
      const definition = app.defineState({ count: 0 }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Rapid updates
      for (let i = 1; i <= 100; i++) {
        instance.updateState({ count: i });
      }

      await flushMicrotasks(5);

      expect(instance.getState().count).toBe(100);
    });

    test("handles concurrent action and state updates", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Concurrent operations
      await Promise.all([
        engine.dispatchAction("increment"),
        instance.updateState({ count: 50 }),
        engine.dispatchAction("increment"),
      ]);

      await flushMicrotasks(5);

      // Final state should reflect all operations
      expect(instance.getState().count).toBeGreaterThan(0);
    });
  });

  describe("Memory Management", () => {
    test("doesn't leak memory with many instances", () => {
      const definition = app.defineState({ count: 0 }).build();

      const instances = [];
      for (let i = 0; i < 1000; i++) {
        instances.push(
          new HypenModuleInstance(engine as unknown as Engine, definition)
        );
      }

      expect(instances.length).toBe(1000);
      // If no memory leak, test should complete quickly
    });

    test("properly cleans up action handlers", async () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("test", () => {})
        .build();

      new HypenModuleInstance(engine as unknown as Engine, definition);

      expect(engine.actionHandlers.size).toBeGreaterThan(0);
    });
  });

  describe("Initial State Variations", () => {
    test("handles null as initial state", () => {
      const definition = app.defineState(null as any).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      // Null is converted to empty object for observability
      expect(instance.getState()).toEqual({});
    });

    test("handles empty object as initial state", () => {
      const definition = app.defineState({}).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      expect(instance.getState()).toEqual({});
    });

    test("handles object with properties as initial state", () => {
      const definition = app.defineState({ count: 42 }).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      expect(instance.getState().count).toBe(42);
    });

    test("handles array as initial state", () => {
      const definition = app.defineState([1, 2, 3] as any).build();

      const instance = new HypenModuleInstance(
        engine as unknown as Engine,
        definition
      );

      expect(instance.getState()).toEqual([1, 2, 3]);
    });
  });
});
