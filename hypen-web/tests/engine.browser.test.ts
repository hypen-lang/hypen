import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ResolverArgs = { name: string; context: string | null };

type ModuleInit = {
  name: string;
  actions: string[];
  stateKeys: string[];
  initialState: Record<string, unknown>;
};

class FakeWasmEngine {
  static instances: FakeWasmEngine[] = [];

  public renderCallback: ((patches: unknown[]) => void) | null = null;
  public componentResolver: ((name: string, context: string | null) => unknown) | null = null;
  public renderSources: string[] = [];
  public renderLazySources: string[] = [];
  public renderIntoCalls: Array<{ source: string; parentId: string; state: Record<string, unknown> }> = [];
  public updateStateCalls: Record<string, unknown>[] = [];
  public dispatchCalls: Array<{ name: string; payload: unknown }> = [];
  public actionHandlers: Map<string, (action: any) => void> = new Map();
  public moduleInit: ModuleInit | null = null;
  public resolverCalls: ResolverArgs[] = [];
  public revision = 1;

  constructor() {
    FakeWasmEngine.instances.push(this);
  }

  registerDefaultPrimitives() {
    // no-op for tests
  }

  setRenderCallback(callback: (patches: unknown[]) => void) {
    this.renderCallback = callback;
  }

  setComponentResolver(resolver: (name: string, context: string | null) => unknown) {
    this.componentResolver = (name, context) => {
      this.resolverCalls.push({ name, context });
      return resolver(name, context);
    };
  }

  renderSource(source: string) {
    this.renderSources.push(source);
  }

  renderLazyComponent(source: string) {
    this.renderLazySources.push(source);
  }

  // The real WasmEngine deserializes each argument synchronously at the
  // boundary (serde_wasm_bindgen::from_value) and retains no JS reference,
  // which is why `unwrapForWasm` may pass already-plain values through by
  // reference. Snapshot at receipt to mirror that: later caller-side
  // mutations must not show up in what "crossed".
  renderInto(source: string, parentId: string, state: Record<string, unknown>) {
    this.renderIntoCalls.push({ source, parentId, state: structuredClone(state) });
  }

  updateState(_scope: string, state: Record<string, unknown>) {
    this.updateStateCalls.push(structuredClone(state));
  }

  updateStateSparse(_scope: string, _paths: string[], values: Record<string, unknown>) {
    this.updateStateCalls.push(structuredClone(values));
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

  registerModule(name: string, actions: string[], stateKeys: string[], initialState: Record<string, unknown>) {
    this.moduleInit = { name, actions, stateKeys, initialState };
  }

  getRevision(): number {
    return this.revision;
  }
}

const wasmInitMock = mock(() => Promise.resolve());

// Mock the WASM module - use absolute path to match the actual import path
import { resolve } from "path";
const wasmPath = resolve(import.meta.dir, "../packages/web-engine/wasm-browser/hypen_engine.js");
mock.module(wasmPath, () => ({
  WasmEngine: FakeWasmEngine,
  default: wasmInitMock,
}));

// The init options to use in all tests - routes init() to our mocked WASM module
const mockInitOptions = {
  jsUrl: wasmPath,
  wasmUrl: "/hypen_engine_bg.wasm",
};

let Engine: any;
let engineAvailable = false;
try {
  const mod = require("../packages/web-engine/src/engine");
  Engine = mod.Engine;
  engineAvailable = typeof Engine === "function";
} catch {
  // Engine import failed (e.g., mock interference in full suite)
}

const describeFn = engineAvailable ? describe : describe.skip;

/**
 * NOTE: These tests use mock.module() which affects the global module cache.
 * If running the full test suite and the WASM mock interferes with other tests,
 * run in isolation: bun test tests/engine.browser.test.ts
 */
describeFn("Engine (browser)", () => {
  beforeEach(() => {
    FakeWasmEngine.instances.length = 0;
    wasmInitMock.mockReset();
  });

  afterEach(() => {
    FakeWasmEngine.instances.length = 0;
  });

  test("init only loads wasm once and uses provided path", async () => {
    const engine = new Engine();

    await engine.init(mockInitOptions);
    await engine.init(mockInitOptions);

    expect(FakeWasmEngine.instances.length).toBe(1);
    expect(wasmInitMock.mock.calls.length).toBe(1);
    expect(wasmInitMock.mock.calls[0]).toEqual([mockInitOptions.wasmUrl]);
  });

  test("propagates wasm init failure", async () => {
    wasmInitMock.mockImplementationOnce(() => Promise.reject(new Error("load failed")));

    const engine = new Engine();

    await expect(engine.init(mockInitOptions)).rejects.toThrowError("load failed");
    expect(FakeWasmEngine.instances.length).toBe(0);

    // Next call succeeds with default mock implementation
    await engine.init(mockInitOptions);
    expect(FakeWasmEngine.instances.length).toBe(1);
  });

  test("guards all public APIs before init", () => {
    const engine = new Engine();

    expect(() => engine.setRenderCallback(() => {}))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.setComponentResolver(() => null))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.renderSource("Column {}"))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.renderLazyComponent("Lazy {}"))
      .toThrowError("Engine not initialized. Call init() first.");
    expect(() => engine.renderInto("Text(\"Hi\")", "root", {}))
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

  test("setRenderCallback forwards patches", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const handler = mock(() => {});
    engine.setRenderCallback(handler);

    const wasm = FakeWasmEngine.instances[0];
    const patches = [{ type: "create", id: "root" }];
    wasm.renderCallback?.(patches);

    expect(handler).toHaveBeenCalledWith(patches);
  });

  test("setComponentResolver proxies calls and responses", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.setComponentResolver((name, context) => ({
      source: `Text(\"${name}\")`,
      path: context,
    }));

    const wasm = FakeWasmEngine.instances[0];
    const component = wasm.componentResolver?.("Widget", "/src/routes");

    expect(component).toEqual({ source: "Text(\"Widget\")", path: "/src/routes" });
    expect(wasm.resolverCalls).toEqual([{ name: "Widget", context: "/src/routes" }]);
  });

  test("component resolver handles null result and throws", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const resolver = mock((name: string) => {
      if (name === "Missing") return null;
      if (name === "Boom") throw new Error("resolver failed");
      return { source: "Text(\"Ok\")", path: null };
    });

    engine.setComponentResolver((name, context) => resolver(name, context));

    const wasm = FakeWasmEngine.instances[0];
    expect(wasm.componentResolver?.("Missing", null)).toBeNull();
    expect(() => wasm.componentResolver?.("Boom", null)).toThrowError("resolver failed");
    expect(resolver.mock.calls).toHaveLength(2);
  });

  test("renderSource forwards to wasm", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.renderSource("Column {}");
    expect(FakeWasmEngine.instances[0].renderSources).toEqual(["Column {}"]);
  });

  test("renderLazyComponent forwards to wasm", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.renderLazyComponent("LazyButton {}");
    expect(FakeWasmEngine.instances[0].renderLazySources).toEqual(["LazyButton {}"]);
  });

  test("renderInto forwards source, parent id and state", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.renderInto("Text(\"Counter\")", "route-1", { count: 7 });

    const wasm = FakeWasmEngine.instances[0];
    expect(wasm.renderIntoCalls.length).toBe(1);
    expect(wasm.renderIntoCalls[0]).toEqual({
      source: "Text(\"Counter\")",
      parentId: "route-1",
      state: { count: 7 },
    });
  });

  test("renderInto clones state argument", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const state = { nested: { value: 1 } };
    engine.renderInto("Text(\"State\")", "route-1", state);

    const wasm = FakeWasmEngine.instances[0];
    const recorded = wasm.renderIntoCalls[0].state as any;

    expect(recorded).toEqual({ nested: { value: 1 } });
    recorded.nested.value = 99;
    expect(state.nested.value).toBe(1);
  });

  test("notifyStateChange clones payload", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const state = { count: 1 };
    engine.updateStateSparse(null, ["count"], state);
    state.count = 42;

    const wasm = FakeWasmEngine.instances[0];
    expect(wasm.updateStateCalls[0]).toEqual({ count: 1 });
  });

  test("notifyStateChange skips update when no paths", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.updateStateSparse(null, [], { value: 1 });

    const wasm = FakeWasmEngine.instances[0];
    expect(wasm.updateStateCalls.length).toBe(0);
  });

  test("updateState clones patch", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const patch = { value: { nested: true } };
    engine.updateState(null, patch);
    patch.value.nested = false;

    expect(FakeWasmEngine.instances[0].updateStateCalls[0]).toEqual({ value: { nested: true } });
  });

  test("dispatchAction delegates to wasm", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    engine.dispatchAction("save", { id: 1 });
    expect(FakeWasmEngine.instances[0].dispatchCalls).toEqual([
      { name: "save", payload: { id: 1 } },
    ]);
  });

  test("onAction wraps handler and logs errors", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

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
    await engine.init(mockInitOptions);

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
    await engine.init(mockInitOptions);

    engine.setModule("Counter", ["increment"], ["count"], { count: 0 });
    expect(FakeWasmEngine.instances[0].moduleInit).toEqual({
      name: "Counter",
      actions: ["increment"],
      stateKeys: ["count"],
      initialState: { count: 0 },
    });
  });

  test("getRevision reflects wasm value", async () => {
    const engine = new Engine();
    await engine.init(mockInitOptions);

    const wasm = FakeWasmEngine.instances[0];
    wasm.revision = 99;
    expect(engine.getRevision()).toBe(99);
  });
});








