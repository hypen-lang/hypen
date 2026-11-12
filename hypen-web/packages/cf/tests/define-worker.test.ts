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

describe("defineHypenWorker routing", () => {
  function routingEnv() {
    const names: string[] = [];
    const env = {
      HYPEN_DO: {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async () => {
            names.push(id.name);
            return new Response(null, { status: 101 });
          },
        }),
      },
    };
    return { env: env as never, names };
  }
  const ws = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { headers: { Upgrade: "websocket", ...headers } });
  const visitorOf = (res: Response) =>
    res.headers.get("Set-Cookie")?.match(/hypen_visitor=([^;]+)/)?.[1] ?? null;

  it("default (visitor): bare /ws embeds do NOT share one DO, and each gets a visitor cookie on the 101", async () => {
    const worker = defineHypenWorker({ module: makeModule(), wasm: makeFakeWasm(), wasmModule: {} as WebAssembly.Module });
    const { env, names } = routingEnv();

    const a = await worker.fetch(ws("https://x/ws"), env);
    const b = await worker.fetch(ws("https://x/ws"), env);
    expect(a.status).toBe(101);
    const va = visitorOf(a);
    const vb = visitorOf(b);
    expect(va).toBeTruthy();
    expect(vb).toBeTruthy();
    expect(va).not.toBe(vb);
    expect(names).toEqual([`visitor:${va}`, `visitor:${vb}`]);
    const cookie = a.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    // The same browser reconnecting (cookie now set) reaches the same DO, and
    // its own per-load ?sessionId does not split it off.
    const again = await worker.fetch(ws("https://x/ws?sessionId=web-123", { Cookie: `hypen_visitor=${va}` }), env);
    expect(names[2]).toBe(`visitor:${va}`);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  it("default (visitor): the served page mints the cookie its socket then routes on", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      clients: { "/": { js: "console.log(1)" } },
    });
    const page = await worker.fetch(new Request("http://x/"), {} as never);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type") ?? "").toContain("text/html");
    const visitor = visitorOf(page);
    expect(visitor).toBeTruthy();
    expect(page.headers.get("Set-Cookie")).not.toContain("Secure"); // http

    // A page request that already carries the cookie is not re-minted.
    const again = await worker.fetch(new Request("http://x/", { headers: { Cookie: `hypen_visitor=${visitor}` } }), {} as never);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  it("default (visitor): a cookieless native client keeps its ?sessionId key and gets no cookie", async () => {
    const worker = defineHypenWorker({ module: makeModule(), wasm: makeFakeWasm(), wasmModule: {} as WebAssembly.Module });
    const { env, names } = routingEnv();
    const res = await worker.fetch(ws("http://x/ws?sessionId=ios-abc"), env);
    expect(names).toEqual(["ios-abc"]);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it('routing: "shared" puts every client in one DO', async () => {
    const worker = defineHypenWorker({ module: makeModule(), wasm: makeFakeWasm(), wasmModule: {} as WebAssembly.Module, routing: "shared" });
    const { env, names } = routingEnv();
    const res = await worker.fetch(ws("http://x/ws?sessionId=a"), env);
    await worker.fetch(ws("http://x/ws"), env);
    expect(names).toEqual(["shared", "shared"]);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("getRoutingKey overrides routing and sets no cookie", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      getRoutingKey: () => "mine",
      clients: { "/": { js: "1" } },
    });
    const { env, names } = routingEnv();
    const res = await worker.fetch(ws("http://x/ws"), env);
    expect(names).toEqual(["mine"]);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const page = await worker.fetch(new Request("http://x/"), {} as never);
    expect(page.headers.get("Set-Cookie")).toBeNull();
  });

  it("visitorCookie options rename the cookie", async () => {
    const worker = defineHypenWorker({
      module: makeModule(),
      wasm: makeFakeWasm(),
      wasmModule: {} as WebAssembly.Module,
      visitorCookie: { name: "my_app", sameSite: "None" },
    });
    const { env, names } = routingEnv();
    const res = await worker.fetch(ws("http://x/ws"), env);
    const cookie = res.headers.get("Set-Cookie")!;
    const id = cookie.match(/^my_app=([^;]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(cookie).toContain("SameSite=None; Secure");
    expect(names).toEqual([`visitor:${id}`]);
    await worker.fetch(ws("http://x/ws", { Cookie: `my_app=${id}` }), env);
    expect(names[1]).toBe(`visitor:${id}`);
  });
});
