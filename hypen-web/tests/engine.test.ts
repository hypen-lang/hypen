import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setLogLevel } from "../packages/core/src/logger";

class FakeWasmEngine {
  static instances: FakeWasmEngine[] = [];

  public renderCallback: ((patches: unknown[]) => void) | null = null;
  public renderSources: string[] = [];
  public updateStateCalls: Array<{ scope: string; state: Record<string, unknown> }> = [];
  public updateStateSparseCalls: Array<{ scope: string; paths: string[]; values: Record<string, unknown> }> = [];
  public dispatchCalls: Array<{ name: string; payload: unknown }> = [];
  public actionHandlers: Map<string, (action: any) => void> = new Map();
  public moduleInit: { name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> } | null = null;
  public registeredModules: Array<{ name: string; actions: string[]; stateKeys: string[]; initialState: Record<string, unknown> }> = [];
  public revision = 1;

  constructor() {
    FakeWasmEngine.instances.push(this);
  }

  setRenderCallback(callback: (patches: unknown[]) => void) {
    this.renderCallback = callback;
  }

  renderSource(source: string) {
    this.renderSources.push(source);
  }

  updateState(scope: string, state: Record<string, unknown>) {
    this.updateStateCalls.push({ scope, state });
  }

  updateStateSparse(scope: string, paths: string[], values: Record<string, unknown>) {
    this.updateStateSparseCalls.push({ scope, paths, values });
  }

  registerModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.registeredModules.push({ name, actions, stateKeys, initialState });
  }

  dispatchAction(name: string, payload: unknown) {
    this.dispatchCalls.push({ name, payload });
  }

  onAction(name: string, handler: (action: any) => void) {
    this.actionHandlers.set(name, handler);
  }

  setModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.moduleInit = { name, actions, stateKeys, initialState };
  }

  getRevision(): number {
    return this.revision;
  }

  registerDefaultPrimitives() {
    // no-op for testing
  }
}

// Mock the WASM module - use absolute path to match the actual import path
import { resolve } from "path";
const wasmPath = resolve(import.meta.dir, "../packages/server/wasm-node/hypen_engine.js");

// Try to load the real WASM module so we can restore it after tests.
// If the WASM binary hasn't been built, fall back gracefully.
let realWasmModule: any;
let wasmAvailable = false;
try {
  realWasmModule = require(wasmPath);
  wasmAvailable = true;
} catch {
  realWasmModule = { WasmEngine: FakeWasmEngine };
}

mock.module(wasmPath, () => ({
  WasmEngine: FakeWasmEngine,
}));

const { Engine } = await import("../packages/server/src/engine");

// Restore the real WASM module after all tests in this file complete,
// so other test files that run later get the real engine.
afterAll(() => {
  mock.module(wasmPath, () => realWasmModule);
});

describe("Engine", () => {
  beforeEach(() => {
    FakeWasmEngine.instances.length = 0;
  });

  afterEach(() => {
    FakeWasmEngine.instances.length = 0;
  });

  test("throws if used before init", () => {
    const engine = new Engine();
    expect(() => engine.renderSource("Column {}"))
      .toThrowError("Engine not initialized. Call init() first.");
  });

  test("guards all public APIs before init", () => {
    const engine = new Engine();

    expect(() => engine.setRenderCallback(() => {}))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.updateStateSparse(null, ["count"], { count: 1 }))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.updateState(null, { count: 1 }))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.dispatchAction("save", {}))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.onAction("increment", () => {}))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.setModule("Counter", [], [], {}))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.getRevision())
      .toThrowError("Engine not initialized. Call init() first.");
  });

  test("init is idempotent", async () => {
    const engine = new Engine();
    await engine.init();
    await engine.init();

    expect(FakeWasmEngine.instances.length).toBe(1);
  });

  test("setRenderCallback proxies patches", async () => {
    const engine = new Engine();
    await engine.init();

    const handler = mock(() => {});
    engine.setRenderCallback(handler);

    const wasm = FakeWasmEngine.instances[0];
    const patches = [{ type: "create" }];
    wasm.renderCallback?.(patches);

    expect(handler).toHaveBeenCalledWith(patches);
  });

  test("renderSource forwards to wasm", async () => {
    const engine = new Engine();
    await engine.init();
    engine.renderSource("Column {}");

    expect(FakeWasmEngine.instances[0].renderSources).toEqual(["Column {}"]);
  });

  test("notifyStateChange clones payload and logs paths", async () => {
    const engine = new Engine();
    await engine.init();

    const previousLevel = "info";
    setLogLevel("debug");

    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy;

    try {
      const state = { count: 1 };
      engine.updateStateSparse(null, ["count"], state);
      state.count = 99;

      expect(FakeWasmEngine.instances[0].updateStateSparseCalls[0]).toEqual({
        scope: "",
        paths: ["count"],
        values: { count: 1 },
      });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      setLogLevel(previousLevel);
    }
  });

  test("notifyStateChange skips debug for empty paths", async () => {
    const engine = new Engine();
    await engine.init();

    const previousLevel = "info";
    setLogLevel("debug");

    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy;

    try {
      engine.updateStateSparse(null, [], { value: 1 });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      setLogLevel(previousLevel);
    }
  });

  test("updateState clones payload", async () => {
    const engine = new Engine();
    await engine.init();

    const payload = { value: { nested: true } };
    engine.updateState(null, payload);
    payload.value.nested = false;

    expect(FakeWasmEngine.instances[0].updateStateCalls[0]).toEqual({
      scope: "",
      state: { value: { nested: true } },
    });
  });

  test("clones complex state shapes", async () => {
    const engine = new Engine();
    await engine.init();

    const complex = {
      list: [1, { nested: [2, 3] }],
      mapLike: new Map([["key", { deep: true }]]),
    } as any;

    engine.updateStateSparse(null, ["list", "mapLike"], complex);
    engine.updateState(null, complex);

    complex.list[1].nested[0] = 99;
    (complex.mapLike.get("key") as any).deep = false;

    const wasm = FakeWasmEngine.instances[0];
    // structuredClone preserves Maps correctly
    expect(wasm.updateStateSparseCalls[0].paths).toEqual(["list", "mapLike"]);
    expect(wasm.updateStateSparseCalls[0].values.list).toEqual([1, { nested: [2, 3] }]);
    expect(wasm.updateStateSparseCalls[0].values.mapLike.get("key")).toEqual({ deep: true });

    expect((wasm.updateStateCalls[0].state as any).list).toEqual([1, { nested: [2, 3] }]);
    expect((wasm.updateStateCalls[0].state as any).mapLike.get("key")).toEqual({ deep: true });
  });

  test("dispatchAction delegates", async () => {
    const engine = new Engine();
    await engine.init();

    engine.dispatchAction("save", { id: 1 });
    expect(FakeWasmEngine.instances[0].dispatchCalls).toEqual([
      { name: "save", payload: { id: 1 } },
    ]);
  });

  test("dispatchAction coerces undefined payload to null", async () => {
    const engine = new Engine();
    await engine.init();

    engine.dispatchAction("noop");
    expect(FakeWasmEngine.instances[0].dispatchCalls).toEqual([
      { name: "noop", payload: null },
    ]);
  });

  test("onAction wraps handler and catches errors", async () => {
    const engine = new Engine();
    await engine.init();

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const handler = mock(() => Promise.reject(new Error("boom")));

    try {
      engine.onAction("increment", handler);
      const wasm = FakeWasmEngine.instances[0];
      wasm.actionHandlers.get("increment")?.({ name: "increment", payload: 1 });

      await Promise.resolve();

      expect(handler).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });

  test("onAction resolves handler without logging", async () => {
    const engine = new Engine();
    await engine.init();

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const handler = mock(async () => {});

    try {
      engine.onAction("increment", handler);
      const wasm = FakeWasmEngine.instances[0];
      await wasm.actionHandlers.get("increment")?.({ name: "increment", payload: 1 });

      expect(handler).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });

  test("setModule forwards data", async () => {
    const engine = new Engine();
    await engine.init();

    engine.setModule("Counter", ["increment"], ["count"], { count: 0 });
    expect(FakeWasmEngine.instances[0].moduleInit).toEqual({
      name: "Counter",
      actions: ["increment"],
      stateKeys: ["count"],
      initialState: { count: 0 },
    });
  });

  test("setModule replaces previous module and revision stays current", async () => {
    const engine = new Engine();
    await engine.init();

    engine.setModule("Counter", ["increment"], ["count"], { count: 0 });
    engine.setModule("Cart", ["add"], ["items"], { items: [] });

    const wasm = FakeWasmEngine.instances[0];
    expect(wasm.moduleInit).toEqual({
      name: "Cart",
      actions: ["add"],
      stateKeys: ["items"],
      initialState: { items: [] },
    });

    wasm.revision = 5;
    expect(engine.getRevision()).toBe(5);
    wasm.revision = 9;
    expect(engine.getRevision()).toBe(9);
  });

  test("getRevision reflects wasm value", async () => {
    const engine = new Engine();
    await engine.init();

    const wasm = FakeWasmEngine.instances[0];
    wasm.revision = 42;
    expect(engine.getRevision()).toBe(42);
  });
});
