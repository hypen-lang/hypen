import { describe, it, expect, afterEach } from "bun:test";
import { defineHypenWorker } from "../src/define-worker.js";
import { HypenDurableObject } from "../src/durable-object.js";
import { app } from "@hypen-space/core/app";
import type { CFWasmExports } from "../src/engine.js";
import { setPortableImpl } from "@hypen-space/core/portable";

/**
 * defineHypenWorker is the one-call entrypoint: `{ module, wasm, wasmModule }`
 * → `{ fetch, [doClassName] }`. These tests prove the worker shape (return
 * keys, fetch routing, DO class identity) with a fake wasm — the full session
 * protocol is covered by durable-object / remote-server tests.
 */

afterEach(() => {
  setPortableImpl(null);
  app.clear?.();
});

// Fake web-target exports whose WasmEngine answers any call as a no-op, so the
// DO can construct an engine without real WASM.
function makeFakeWasm(): CFWasmExports {
  const noopEngine = () => new Proxy({}, { get: () => () => undefined });
  return {
    WasmEngine: noopEngine as unknown as new () => any,
    initSync: () => undefined,
    diffPaths: () => "[]",
    matchPath: () => JSON.stringify({ matched: false, params: {} }),
    pathGet: () => "null",
    pathHas: () => "false",
    pathSet: (v: string) => v,
    pathDelete: (v: string) => JSON.stringify({ json: JSON.parse(v), removed: false }),
    encodeUriComponent: (s: string) => s,
    decodeUriComponent: (s: string) => s,
    parseQuery: (f: string) => JSON.stringify({ path: f, query: {} }),
    buildUrl: (p: string) => p,
  };
}

function makeModule() {
  return app
    .defineState({ count: 0 })
    .onAction("inc", ({ state }: any) => {
      state.count += 1;
    })
    .ui('module App { Text("@{state.count}") }');
}

describe("defineHypenWorker", () => {
  it("returns a fetch handler and the DO class under the given name", () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      doClassName: "CounterDO",
      binding: "COUNTER_DO",
    });

    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.CounterDO).toBe("function");
    expect(worker.CounterDO.prototype).toBeInstanceOf(HypenDurableObject);
  });

  it("defaults the DO export name to AppDO", () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
    });
    expect(typeof worker.AppDO).toBe("function");
  });

  it("fetch returns 426 for a non-WebSocket request", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      binding: "COUNTER_DO",
    });
    const res = await worker.fetch(new Request("http://x/"), {});
    expect(res.status).toBe(426);
  });

  it("fetch routes a WS upgrade to the DO via the configured binding", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      binding: "COUNTER_DO",
    });

    let routed = false;
    const env = {
      COUNTER_DO: {
        idFromName: (name: string) => ({ name }),
        get: (_id: unknown) => ({
          fetch: async () => {
            routed = true;
            return new Response(null, { status: 101 });
          },
        }),
      },
    };

    const res = await worker.fetch(
      new Request("http://x/ws", { headers: { Upgrade: "websocket" } }),
      env as never,
    );
    expect(routed).toBe(true);
    expect(res.status).toBe(101);
  });

  it("returns 500 when the binding is missing from env", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      binding: "COUNTER_DO",
    });
    const res = await worker.fetch(
      new Request("http://x/ws", { headers: { Upgrade: "websocket" } }),
      {} as never,
    );
    expect(res.status).toBe(500);
  });
});
