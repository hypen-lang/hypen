import { describe, it, expect, afterEach } from "bun:test";
import {
  createCFEngine,
  installCFPortable,
  makeCFPortableImpl,
  type CFWasmExports,
} from "../src/engine.js";
import { BaseEngine } from "@hypen-space/core/engine-base";
import { portable, setPortableImpl } from "@hypen-space/core/portable";

/**
 * CFEngine ships in @hypen-space/cf with the WASM injected, so the package
 * itself stays WASM-free (no .wasm import, typecheckable + testable without
 * wrangler). These tests use a fake CFWasmExports to prove the wiring:
 * portable gets installed from the injected exports, the engine constructs
 * over the injected WasmEngine, and the portable helpers route through wasm.
 */

// A fake WasmEngine that records the calls CFEngine makes on construction.
class FakeWasmEngine {
  static instances: FakeWasmEngine[] = [];
  registeredPrimitives = false;
  constructor() {
    FakeWasmEngine.instances.push(this);
  }
  registerDefaultPrimitives() {
    this.registeredPrimitives = true;
  }
}

// Fake web-target exports. The portable free-functions return the JSON shapes
// the real wasm-bindgen build returns, so makeCFPortableImpl can parse them.
function makeFakeWasm(): CFWasmExports & { initCalls: number } {
  const w = {
    initCalls: 0,
    WasmEngine: FakeWasmEngine as unknown as new () => any,
    initSync(_init: { module: WebAssembly.Module }) {
      w.initCalls++;
    },
    diffPaths: (_o: string, _n: string) =>
      JSON.stringify([{ path: "count", value: 1 }]),
    matchPath: (pattern: string, path: string) =>
      JSON.stringify(
        pattern === path
          ? { matched: true, params: {} }
          : { matched: false, params: {} },
      ),
    pathGet: (_v: string, _p: string) => JSON.stringify("got"),
    pathHas: (_v: string, _p: string) => "true",
    pathSet: (v: string, _p: string, _nv: string) => v,
    pathDelete: (v: string, _p: string) =>
      JSON.stringify({ json: JSON.parse(v), removed: true }),
    encodeUriComponent: (s: string) => `enc(${s})`,
    decodeUriComponent: (s: string) => `dec(${s})`,
    parseQuery: (full: string) => JSON.stringify({ path: full, query: {} }),
    buildUrl: (path: string, _q: string) => path,
  };
  return w;
}

afterEach(() => {
  setPortableImpl(null);
  FakeWasmEngine.instances.length = 0;
});

describe("makeCFPortableImpl", () => {
  it("builds a PortableImpl that routes through the injected wasm", () => {
    const wasm = makeFakeWasm();
    const impl = makeCFPortableImpl(wasm);

    expect(impl.matchPath("/x", "/x")).toEqual({ params: {} });
    expect(impl.matchPath("/x", "/y")).toBeNull();
    expect(impl.diffState({ count: 0 }, { count: 1 })).toEqual({
      paths: ["count"],
      newValues: { count: 1 },
    });
    expect(impl.pathHas({}, "a")).toBe(true);
    expect(impl.encodeUriComponent("a b")).toBe("enc(a b)");
  });

  it("diffState swallows un-serialisable input and reports no change", () => {
    const wasm = makeFakeWasm();
    const impl = makeCFPortableImpl(wasm);
    const circular: any = {};
    circular.self = circular;
    expect(impl.diffState(circular, circular)).toEqual({ paths: [], newValues: {} });
  });
});

describe("installCFPortable", () => {
  it("installs the impl into @hypen-space/core (once) and runs initSync", () => {
    const wasm = makeFakeWasm();
    const mod = {} as WebAssembly.Module;
    installCFPortable(wasm, mod);
    installCFPortable(wasm, mod); // idempotent

    expect(wasm.initCalls).toBe(1);
    // The live core proxy now routes to the installed impl.
    expect(portable.matchPath("/a", "/a")).toEqual({ params: {} });
  });
});

describe("createCFEngine", () => {
  it("returns a BaseEngine subclass that constructs over the injected WasmEngine", () => {
    const wasm = makeFakeWasm();
    const CFEngine = createCFEngine(wasm, {} as WebAssembly.Module);
    const engine = new CFEngine();

    expect(engine).toBeInstanceOf(BaseEngine);
    expect(FakeWasmEngine.instances).toHaveLength(1);
    expect(FakeWasmEngine.instances[0]!.registeredPrimitives).toBe(true);
  });

  it("installs portable before the engine is constructed", () => {
    const wasm = makeFakeWasm();
    // createCFEngine installs eagerly (before any construction), so core's
    // portable is usable immediately — this is what lets module-graph
    // defineState() calls run.
    createCFEngine(wasm, {} as WebAssembly.Module);
    expect(portable.matchPath("/z", "/z")).toEqual({ params: {} });
  });

  it("inherits BaseEngine's default Map→object normalizeAction (no override)", () => {
    // The web target returns Map payloads; the base default converts them.
    // CFEngine must NOT re-declare normalizeAction — assert it isn't its own.
    const wasm = makeFakeWasm();
    const CFEngine = createCFEngine(wasm, {} as WebAssembly.Module);
    const proto = Object.getPrototypeOf(CFEngine.prototype);
    // CFEngine.prototype's own proto is BaseEngine.prototype; normalizeAction
    // should be found on BaseEngine, not as an own property of CFEngine.
    expect(
      Object.prototype.hasOwnProperty.call(CFEngine.prototype, "normalizeAction"),
    ).toBe(false);
    expect(typeof (proto as any).normalizeAction).toBe("function");
  });
});
