import { describe, expect, test } from "bun:test";
import { app, HypenModuleInstance, type HypenModuleDefinition } from "../packages/core/src/app";
import type { Action } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { flushMicrotasks } from "./helpers";

type NotifyCall = { scope: string | null; paths: string[]; changedValues: Record<string, unknown> };
type RegisterCall = { name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> };

class FakeEngine {
  public setModuleCalls: Array<RegisterCall> = [];
  public registerModuleCalls: Array<RegisterCall> = [];
  public notifyCalls: NotifyCall[] = [];
  public actionHandlers: Map<string, (action: Action) => Promise<void> | void> = new Map();
  private _currentState: Record<string, unknown> = {};

  setModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.setModuleCalls.push({ name, actions, stateKeys, initialState });
    this._currentState = JSON.parse(JSON.stringify(initialState));
  }

  registerModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.registerModuleCalls.push({ name, actions, stateKeys, initialState });
    this._currentState = JSON.parse(JSON.stringify(initialState));
  }

  // Receives sparse changedValues with explicit scope
  updateStateSparse(scope: string | null, paths: string[], changedValues: Record<string, unknown>) {
    // Apply sparse updates to track current state
    for (const path of paths) {
      if (path in changedValues) {
        this._setValueAtPath(this._currentState, path, changedValues[path]);
      }
    }
    this.notifyCalls.push({ scope, paths, changedValues: JSON.parse(JSON.stringify(changedValues)) });
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

  // Get reconstructed current state
  getCurrentState(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this._currentState));
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

describe("HypenModuleInstance", () => {
  test("registers module and runs onCreated", async () => {
    const engine = new FakeEngine();
    const definition = app
      .defineState({ count: 0 }, { name: "Counter" })
      .onCreated(async (state) => {
        await Promise.resolve();
        state.count = 1;
      })
      .onAction("increment", ({ action, state }) => {
        state.count += (action.payload as number) ?? 1;
      })
      .build();

    new HypenModuleInstance(engine as unknown as Engine, definition);

    await flushMicrotasks(2);

    // Named module "Counter" registers as a secondary module under its
    // lowercase name. The engine handles scoping via the IR's `module_scope`
    // field — the SDK no longer prefixes state paths.
    expect(engine.setModuleCalls.length).toBe(0);
    expect(engine.registerModuleCalls[0]).toEqual({
      name: "counter",
      actions: ["increment"],
      stateKeys: ["count"],
      initialState: { count: 0 },
    });

    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].scope).toBe("counter");
    expect(engine.notifyCalls[0].paths).toEqual(["count"]);
    expect(engine.notifyCalls[0].changedValues.count).toBe(1);
  });

  test("action handlers receive context and propagate state changes", async () => {
    const engine = new FakeEngine();
    const definition = app
      .defineState({ count: 0 })
      .onAction("increment", ({ action, state }) => {
        expect(action.name).toBe("increment");
        expect(action.payload).toBe(3);
        expect(action.sender).toBe("ui");
        state.count += action.payload as number;
      })
      .build();

    const instance = new HypenModuleInstance(engine as unknown as Engine, definition);

    await engine.dispatchRegistered("increment", 3, "ui");
    await flushMicrotasks(2);

    expect(engine.notifyCalls.at(-1)?.paths).toEqual(["count"]);
    expect(instance.getLiveState().count).toBe(3);
  });

  test("destroy invokes onDestroyed once", async () => {
    const engine = new FakeEngine();
    let destroyed = 0;
    const definition: HypenModuleDefinition = app
      .defineState({ active: true })
      .onDestroyed(() => {
        destroyed += 1;
      })
      .build();

    const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
    await instance.destroy();
    await instance.destroy();

    expect(destroyed).toBe(1);
  });

  test("updateState merges patch and triggers notification", async () => {
    const engine = new FakeEngine();
    const definition = app.defineState({ count: 0, label: "" }).build();
    const instance = new HypenModuleInstance(engine as unknown as Engine, definition);

    instance.updateState({ count: 10 });
    await flushMicrotasks();

    expect(engine.notifyCalls.at(-1)?.paths).toEqual(["count"]);
    expect(instance.getState()).toEqual({ count: 10, label: "" });
  });

  test("getState returns snapshot isolated from live proxy", async () => {
    const engine = new FakeEngine();
    const definition = app.defineState({ value: 1 }).build();
    const instance = new HypenModuleInstance(engine as unknown as Engine, definition);

    const snapshot = instance.getState();
    instance.getLiveState().value = 2;
    await flushMicrotasks();

    expect(snapshot.value).toBe(1);
    expect(engine.notifyCalls.at(-1)?.paths).toEqual(["value"]);
  });
});

describe("HypenAppBuilder", () => {
  test("build captures options and handlers", () => {
    const definition = app
      .defineState({ flag: false }, { persist: true, version: 2, name: "Toggle" })
      .onCreated(() => {})
      .onAction("flip", () => {})
      .onDestroyed(() => {})
      .build();

    expect(definition).toMatchObject({
      name: "Toggle",
      persist: true,
      version: 2,
      actions: ["flip"],
      stateKeys: ["flag"],
    });
    expect(definition.handlers.onAction.size).toBe(1);
  });

  test("build captures session lifecycle hooks", () => {
    const definition = app
      .defineState({ items: [] })
      .onDisconnect(async ({ state, session }) => {
        // Save state to storage
      })
      .onReconnect(async ({ session, restore }) => {
        // Restore state from storage
      })
      .onExpire(async ({ session }) => {
        // Clean up storage
      })
      .build();

    expect(definition.handlers.onDisconnect).toBeDefined();
    expect(definition.handlers.onReconnect).toBeDefined();
    expect(definition.handlers.onExpire).toBeDefined();
  });

  test("session lifecycle hooks receive correct context", async () => {
    const mockSession = {
      id: "test-session",
      ttl: 3600,
      createdAt: new Date(),
      lastConnectedAt: new Date(),
    };

    let disconnectState: any = null;
    let disconnectSession: any = null;
    let reconnectSession: any = null;
    let expireSession: any = null;
    let restoredState: any = null;

    const definition = app
      .defineState({ count: 42 })
      .onDisconnect(async ({ state, session }) => {
        disconnectState = { ...state };
        disconnectSession = session;
      })
      .onReconnect(async ({ session, restore }) => {
        reconnectSession = session;
        restore({ count: 100 });
      })
      .onExpire(async ({ session }) => {
        expireSession = session;
      })
      .build();

    // Test onDisconnect
    if (definition.handlers.onDisconnect) {
      await definition.handlers.onDisconnect({
        state: { count: 42 },
        session: mockSession,
      });
    }
    expect(disconnectState).toEqual({ count: 42 });
    expect(disconnectSession.id).toBe("test-session");

    // Test onReconnect
    if (definition.handlers.onReconnect) {
      await definition.handlers.onReconnect({
        session: mockSession,
        restore: (state: any) => { restoredState = state; },
      });
    }
    expect(reconnectSession.id).toBe("test-session");
    expect(restoredState).toEqual({ count: 100 });

    // Test onExpire
    if (definition.handlers.onExpire) {
      await definition.handlers.onExpire({
        session: mockSession,
      });
    }
    expect(expireSession.id).toBe("test-session");
  });
});
