/**
 * Reserved drag-and-drop outcome actions at the module-instance level
 * (hypen-web/docs/dnd.md): `__hypen_reorder` and
 * `__hypen_pin` are auto-registered next to `__hypen_bind` and MUST write
 * through the module's state Proxy so tracking (engine `updateStateSparse`)
 * and persistence fire. `__dnd` is ordinary state and round-trips through
 * the StateStore snapshot/restore path unchanged (§6.5 / §6.7).
 */
import { describe, expect, test } from "bun:test";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Action } from "../packages/core/src/types";
import type { StateStore } from "../packages/core/src/persistence";
import { DND_REORDER_ACTION, DND_PIN_ACTION } from "../packages/core/src/dnd";
import { flushMicrotasks } from "./helpers";

type NotifyCall = { scope: string | null; paths: string[]; changedValues: Record<string, unknown> };
type RegisterCall = { name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> };

// Same shape as app.test.ts's FakeEngine: records updateStateSparse calls
// and reconstructs the engine-side state from the sparse paths so a test
// can assert the engine's view converged on the Proxy's.
class FakeEngine {
  public setModuleCalls: RegisterCall[] = [];
  public registerModuleCalls: RegisterCall[] = [];
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

  updateStateSparse(scope: string | null, paths: string[], changedValues: Record<string, unknown>) {
    for (const path of paths) {
      if (path in changedValues) {
        this._setValueAtPath(this._currentState, path, changedValues[path]);
      } else {
        this._deleteAtPath(this._currentState, path);
      }
    }
    this.notifyCalls.push({ scope, paths, changedValues: JSON.parse(JSON.stringify(changedValues)) });
  }

  private _setValueAtPath(obj: any, path: string, value: any) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i]! in current)) current[parts[i]!] = {};
      current = current[parts[i]!];
    }
    current[parts[parts.length - 1]!] = value;
  }

  private _deleteAtPath(obj: any, path: string) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      current = current?.[parts[i]!];
      if (current == null) return;
    }
    const last = parts[parts.length - 1]!;
    if (Array.isArray(current)) current.splice(Number(last), 1);
    else delete current[last];
  }

  getCurrentState(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this._currentState));
  }

  onAction(name: string, handler: (action: Action) => void | Promise<void>) {
    this.actionHandlers.set(name, handler);
  }

  dispatchRegistered(name: string, payload?: unknown, scope?: string) {
    const matches = [...this.actionHandlers.keys()].filter(key => key.endsWith(`:${name}`));
    const key = scope ? `__hypen_scoped:${scope.toLowerCase()}:${name}` : matches.length === 1 ? matches[0]! : name;
    const handler = this.actionHandlers.get(key);
    if (!handler) throw new Error(`no unambiguous handler for ${name}`);
    return handler({ name, payload });
  }
}

function createMockStore<T>(stored?: T): StateStore<T> & { saves: Array<{ key: string; state: T }> } {
  const saves: Array<{ key: string; state: T }> = [];
  return {
    saves,
    resolveKey: (_state, moduleName) => `test:${moduleName}`,
    load: async () => stored ?? null,
    save: async (key, state) => {
      saves.push({ key, state: structuredClone(state) });
    },
    delete: async () => {},
  };
}

type BoardState = {
  tasks: string[];
  columns: { todo: string[]; done: string[] };
  notes: Array<{ id: string; x?: number; y?: number; left?: number; top?: number }>;
  scalar: number;
  __dnd?: Record<string, Record<string, Record<string, number>>>;
};

const initial = (): BoardState => ({
  tasks: ["a", "b", "c", "d"],
  columns: { todo: ["t1", "t2"], done: ["d1"] },
  notes: [{ id: "n1" }, { id: "n2" }],
  scalar: 7,
});

async function makeInstance(name = "Board") {
  const engine = new FakeEngine();
  const definition = app.defineState<BoardState>(initial(), { name }).build();
  const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
  await instance.waitForReady();
  // Drain any construction-time flush so notifyCalls only reflect the test.
  await flushMicrotasks(2);
  engine.notifyCalls.length = 0;
  return { engine, instance };
}

describe("reserved DnD actions are auto-registered", () => {
  test("__hypen_reorder and __hypen_pin sit next to __hypen_bind", async () => {
    const { engine } = await makeInstance();
    expect(engine.actionHandlers.has(`__hypen_scoped:board:${"__hypen_bind"}`)).toBe(true);
    expect(engine.actionHandlers.has(`__hypen_scoped:board:${DND_REORDER_ACTION}`)).toBe(true);
    expect(engine.actionHandlers.has(`__hypen_scoped:board:${DND_PIN_ACTION}`)).toBe(true);
  });
});

describe(`${DND_REORDER_ACTION}`, () => {
  test("`path` shorthand reorders within one array through the Proxy (tracked)", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 3, to: 0 });
    await flushMicrotasks(2);

    // (a) state mutated
    expect(instance.getState().tasks).toEqual(["d", "a", "b", "c"]);
    // (b) tracked: the observable flushed to the engine under the module scope
    expect(engine.notifyCalls.length).toBe(1);
    const call = engine.notifyCalls[0]!;
    expect(call.scope).toBe("board");
    expect(call.paths.some((p) => p === "tasks" || p.startsWith("tasks."))).toBe(true);
    // and the engine's reconstructed view converged on the same array
    expect(engine.getCurrentState().tasks).toEqual(["d", "a", "b", "c"]);
  });

  test("long form moves across arrays; `to` is the final index", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_REORDER_ACTION, {
      fromPath: "columns.todo",
      from: 0,
      toPath: "columns.done",
      to: 1,
    });
    await flushMicrotasks(2);
    expect(instance.getState().columns).toEqual({ todo: ["t2"], done: ["d1", "t1"] });
    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.getCurrentState().columns).toEqual({ todo: ["t2"], done: ["d1", "t1"] });
  });

  test("fromPath without toPath falls back to a same-array move", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_REORDER_ACTION, { fromPath: "tasks", from: 0, to: 2 });
    await flushMicrotasks(2);
    expect(instance.getState().tasks).toEqual(["b", "c", "a", "d"]);
  });

  test("from == to is a tracked no-op (nothing flushed)", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 1, to: 1 });
    await flushMicrotasks(2);
    expect(instance.getState().tasks).toEqual(["a", "b", "c", "d"]);
    expect(engine.notifyCalls.length).toBe(0);
  });

  test("`to` beyond length clamps to the end", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 0, to: 100 });
    await flushMicrotasks(2);
    expect(instance.getState().tasks).toEqual(["b", "c", "d", "a"]);
  });

  test("malformed payloads warn and leave state untouched (never throw)", async () => {
    const { engine, instance } = await makeInstance();
    const before = instance.getState();
    const bad: unknown[] = [
      undefined,
      null,
      "tasks",
      {},
      { path: "tasks" },
      { path: "tasks", from: "0", to: 1 },
      { path: "scalar", from: 0, to: 1 }, // not an array
      { path: "missing", from: 0, to: 1 },
      { path: "tasks", from: 9, to: 0 }, // out of range
      { path: "tasks", from: -1, to: 0 },
      { fromPath: "tasks", from: 0, toPath: "scalar", to: 0 },
    ];
    for (const payload of bad) {
      expect(() => engine.dispatchRegistered(DND_REORDER_ACTION, payload)).not.toThrow();
    }
    await flushMicrotasks(2);
    expect(instance.getState()).toEqual(before);
    expect(engine.notifyCalls.length).toBe(0);
  });
});

describe(`${DND_PIN_ACTION}`, () => {
  test("reserved mode auto-vivifies __dnd.<group>.<key> and writes both fields in ONE flush", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_PIN_ACTION, {
      path: "__dnd.board.n1",
      x: 296,
      y: 200,
      xKey: "x",
      yKey: "y",
    });
    await flushMicrotasks(2);

    // (a) state mutated, intermediates created
    expect(instance.getState().__dnd).toEqual({ board: { n1: { x: 296, y: 200 } } });
    // (b) tracked as a single batched flush
    expect(engine.notifyCalls.length).toBe(1);
    const call = engine.notifyCalls[0]!;
    expect(call.scope).toBe("board");
    expect(call.paths.some((p) => p === "__dnd" || p.startsWith("__dnd."))).toBe(true);
    expect(engine.getCurrentState().__dnd).toEqual({ board: { n1: { x: 296, y: 200 } } });
  });

  test("second pin of another key extends the existing group; re-pin updates in place", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n1", x: 1, y: 2, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n2", x: 3, y: 4, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n1", x: 10, y: 20, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    expect(instance.getState().__dnd).toEqual({
      board: { n1: { x: 10, y: 20 }, n2: { x: 3, y: 4 } },
    });
    expect(engine.notifyCalls.length).toBe(3);
    expect(engine.getCurrentState().__dnd).toEqual(instance.getState().__dnd);
  });

  test("user-field mode writes <bind>.<index>.<xKey>/<yKey> on the existing item", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_PIN_ACTION, {
      path: "notes.1",
      x: 40,
      y: 512,
      xKey: "left",
      yKey: "top",
    });
    await flushMicrotasks(2);
    expect(instance.getState().notes).toEqual([{ id: "n1" }, { id: "n2", left: 40, top: 512 }]);
    expect(engine.notifyCalls.length).toBe(1);
    const paths = engine.notifyCalls[0]!.paths;
    expect(paths).toContain("notes.1.left");
    expect(paths).toContain("notes.1.top");
    expect(engine.getCurrentState().notes).toEqual(instance.getState().notes);
  });

  test("missing xKey/yKey default to x/y", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.g.k", x: 5, y: 6 });
    await flushMicrotasks(2);
    expect(instance.getState().__dnd).toEqual({ g: { k: { x: 5, y: 6 } } });
  });

  test("malformed payloads warn and leave state untouched (never throw)", async () => {
    const { engine, instance } = await makeInstance();
    const before = instance.getState();
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      { path: "", x: 1, y: 2 },
      { path: "__dnd.g.k", x: "1", y: 2 },
      { path: "__dnd.g.k", x: 1 },
      { path: "__dnd.g.k", x: Number.NaN, y: 2 },
      { path: "__dnd.g.k", x: 1, y: Number.POSITIVE_INFINITY },
      { path: "scalar.k", x: 1, y: 2 }, // primitive where a container is needed
    ];
    for (const payload of bad) {
      expect(() => engine.dispatchRegistered(DND_PIN_ACTION, payload)).not.toThrow();
    }
    await flushMicrotasks(2);
    expect(instance.getState()).toEqual(before);
    expect(engine.notifyCalls.length).toBe(0);
  });
});

describe("__dnd persistence (§6.5 / §6.7)", () => {
  test("a pin write is persisted through the StateStore and restored into a fresh instance", async () => {
    const store = createMockStore<BoardState>();
    const definition = app.defineState<BoardState>(initial(), { name: "Pinned" }).persist(store).build();
    const engine = new FakeEngine();
    const instance = new HypenModuleInstance(engine as unknown as Engine, definition);
    await instance.waitForReady();

    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 0, to: 3 });
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n1", x: 296, y: 200, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    // The persist save is debounced (50ms) — wait it out.
    await new Promise((r) => setTimeout(r, 120));

    const saved = store.saves[store.saves.length - 1]!.state;
    expect(saved.__dnd).toEqual({ board: { n1: { x: 296, y: 200 } } });
    expect(saved.tasks).toEqual(["b", "c", "d", "a"]);

    // Snapshot → restore: a fresh instance hydrated from the saved snapshot
    // sees the same __dnd subtree before onCreated runs.
    const createdSaw: unknown[] = [];
    const restoreStore = createMockStore<BoardState>(saved);
    const restoreDef = app
      .defineState<BoardState>(initial(), { name: "Pinned" })
      .persist(restoreStore)
      .onCreated((state) => {
        createdSaw.push(JSON.parse(JSON.stringify(state.__dnd)));
      })
      .build();
    const engine2 = new FakeEngine();
    const instance2 = new HypenModuleInstance(engine2 as unknown as Engine, restoreDef);
    await instance2.waitForReady();

    expect(createdSaw).toEqual([{ board: { n1: { x: 296, y: 200 } } }]);
    expect(instance2.getState().__dnd).toEqual({ board: { n1: { x: 296, y: 200 } } });
    expect(instance2.getState().tasks).toEqual(["b", "c", "d", "a"]);

    // Restore-then-pin keeps working through the same channel.
    engine2.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n2", x: 1, y: 2, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    expect(instance2.getState().__dnd).toEqual({ board: { n1: { x: 296, y: 200 }, n2: { x: 1, y: 2 } } });

    await instance.destroy();
    await instance2.destroy();
  });

  test("getState() snapshot → updateState() restore keeps __dnd intact", async () => {
    const { engine, instance } = await makeInstance();
    engine.dispatchRegistered(DND_PIN_ACTION, { path: "__dnd.board.n1", x: 9, y: 8, xKey: "x", yKey: "y" });
    await flushMicrotasks(2);
    const snapshot = structuredClone(instance.getState());

    const { instance: fresh } = await makeInstance("Board2");
    expect(fresh.getState().__dnd).toBeUndefined();
    fresh.updateState(snapshot);
    await flushMicrotasks(2);
    expect(fresh.getState()).toEqual(snapshot);
    expect(fresh.getState().__dnd).toEqual({ board: { n1: { x: 9, y: 8 } } });
  });
});

// ============================================================================
// Multi-module routing
// ============================================================================
//
// Each module registers a separate reserved handler. Engine ownership
// resolution is covered end to end by dnd-ownership.test.ts.
describe("multi-module registration of reserved DnD actions", () => {
  async function makeTwo() {
    const engine = new FakeEngine();
    const a = new HypenModuleInstance(
      engine as unknown as Engine,
      app.defineState<BoardState>(initial(), { name: "Alpha" }).build()
    );
    const b = new HypenModuleInstance(
      engine as unknown as Engine,
      app.defineState<BoardState>(initial(), { name: "Beta" }).build()
    );
    await a.waitForReady();
    await b.waitForReady();
    await flushMicrotasks(2);
    engine.notifyCalls.length = 0;
    return { engine, a, b };
  }

  test("scoped reorder reaches Alpha even though Beta registered last", async () => {
    const { engine, a, b } = await makeTwo();
    // Each owner retains its own handler.
    expect(engine.actionHandlers.has(`__hypen_scoped:alpha:${DND_REORDER_ACTION}`)).toBe(true);
    expect(engine.actionHandlers.has(`__hypen_scoped:beta:${DND_REORDER_ACTION}`)).toBe(true);

    // A drop that (semantically) belongs to Alpha's `.sortable` …
    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 3, to: 0 }, "Alpha");
    await flushMicrotasks(2);

    // Beta remains untouched.
    expect(a.getState().tasks).toEqual(["d", "a", "b", "c"]);
    expect(b.getState().tasks).toEqual(["a", "b", "c", "d"]);
    expect(engine.notifyCalls).toHaveLength(1);
    expect(engine.notifyCalls[0]!.scope).toBe("alpha");

    await a.destroy();
    await b.destroy();
  });

  test("scoped pin creates reserved state only in its owner", async () => {
    const { engine, a, b } = await makeTwo();
    engine.dispatchRegistered(
      DND_PIN_ACTION,
      { path: "__dnd.board.n1", x: 10, y: 20, xKey: "x", yKey: "y" },
      "Alpha"
    );
    await flushMicrotasks(2);

    expect(a.getState().__dnd).toEqual({ board: { n1: { x: 10, y: 20 } } });
    expect(b.getState().__dnd).toBeUndefined();
    expect(engine.notifyCalls).toHaveLength(1);
    expect(engine.notifyCalls[0]!.scope).toBe("alpha");

    await a.destroy();
    await b.destroy();
  });

  test("single-module apps are unaffected (the common case routes correctly)", async () => {
    const { engine, instance } = await makeInstance("Solo");
    engine.dispatchRegistered(DND_REORDER_ACTION, { path: "tasks", from: 0, to: 3 });
    await flushMicrotasks(2);
    expect(instance.getState().tasks).toEqual(["b", "c", "d", "a"]);
    expect(engine.notifyCalls[0]!.scope).toBe("solo");
    await instance.destroy();
  });
});
