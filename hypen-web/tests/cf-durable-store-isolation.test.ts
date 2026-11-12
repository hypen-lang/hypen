/**
 * Cross-visitor isolation of `durableObjectStore`.
 *
 * Every Durable Object of one class runs in the same isolate, and they all
 * share ONE module definition — and so one `.persist(durableObjectStore(...))`
 * store object. The store used to keep its storage handle in a single
 * mutable slot that each DO rebound on every message, so a save that ran
 * after an `await` (the 50 ms persistence debounce, a slow action handler)
 * wrote into whichever DO had bound last: one visitor's state landed in
 * another visitor's storage.
 *
 * These tests run two DOs (two storages) over the same config and
 * interleave their messages around awaits; each DO's persisted state must
 * stay in its own storage.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { HypenDurableObject, type HypenDurableObjectConfig } from "../packages/cf/src/durable-object";
import { durableObjectStore } from "../packages/cf/src/durable-object-store";
import { global as globalStrategy } from "../packages/cf/src/strategies";
import { Engine } from "../packages/server/src/engine";
import { app, HypenApp } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";

function createStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return data.get(key); },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    async delete(key: string) { return data.delete(key); },
    _data: data,
  };
}

function createMockWebSocket() {
  const sent: string[] = [];
  let attachment: unknown;
  return {
    sent,
    send: (s: string) => sent.push(s),
    close: () => {},
    readyState: 1,
    serializeAttachment: (value: unknown) => { attachment = structuredClone(value); },
    deserializeAttachment: () => structuredClone(attachment),
  };
}

function createCtx(storage: ReturnType<typeof createStorage>) {
  const sockets: WebSocket[] = [];
  return {
    storage,
    acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  };
}

class TestDO extends HypenDurableObject {
  constructor(ctx: any, env: any, private cfg: HypenDurableObjectConfig) {
    super(ctx, env);
  }
  getConfig() { return this.cfg; }
  createEngine(): BaseEngine { return new Engine(); }
}

const send = (d: TestDO, ws: ReturnType<typeof createMockWebSocket>, msg: unknown) =>
  d.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));

const persisted = (s: ReturnType<typeof createStorage>) =>
  s._data.get("hypen:global:AnonymousModule") as { counter: number; label: string } | undefined;

beforeEach(() => {
  app.clear?.();
});

describe("durableObjectStore isolation across Durable Objects", () => {
  test("a debounced save lands in the DO that made the change, not the last one to bind", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // ONE config shared by both DOs — exactly what `defineHypenWorker`
    // builds: a single module definition (and store) per DO class.
    const module = app
      .defineState<{ counter: number; label: string }>({ counter: 0, label: "" })
      .onAction("inc", ({ state }: any) => { state.counter += 1; })
      .onAction<{ label: string }>("slowLabel", async ({ state, action }: any) => {
        await gate;
        state.label = action.payload.label;
      })
      .persist(durableObjectStore(globalStrategy()))
      .ui('Text("@{state.counter}")');
    const config: HypenDurableObjectConfig = { module, template: module.template ?? "", moduleName: "App" };

    const storageA = createStorage();
    const storageB = createStorage();
    const a = new TestDO(createCtx(storageA) as any, {}, config);
    const b = new TestDO(createCtx(storageB) as any, {}, config);
    const wsA = createMockWebSocket();
    const wsB = createMockWebSocket();

    await send(a, wsA, { type: "hello", props: {} });
    await send(b, wsB, { type: "hello", props: {} });
    await new Promise((r) => setTimeout(r, 80));

    // A changes state; its debounced save fires ~50 ms later. Before it
    // does, B handles a message (and, before the fix, rebound the store).
    await send(a, wsA, { type: "dispatchAction", action: "inc", payload: null });
    await send(b, wsB, { type: "dispatchAction", action: "noop", payload: null });
    await new Promise((r) => setTimeout(r, 120));

    expect(persisted(storageA)?.counter).toBe(1);
    expect(persisted(storageB)?.counter ?? 0).toBe(0);

    // An action handler that awaits: B starts it, A binds in the meantime,
    // then B's mutation commits.
    const pending = send(b, wsB, { type: "dispatchAction", action: "slowLabel", payload: { label: "from-b" } });
    await new Promise((r) => setTimeout(r, 10));
    await send(a, wsA, { type: "dispatchAction", action: "inc", payload: null });
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 120));

    expect(persisted(storageB)?.label).toBe("from-b");
    expect(persisted(storageA)?.label).toBe("");
    expect(persisted(storageA)?.counter).toBe(2);
    expect(persisted(storageB)?.counter ?? 0).toBe(0);

    await a.webSocketClose(wsA as unknown as WebSocket, 1000, "");
    await b.webSocketClose(wsB as unknown as WebSocket, 1000, "");
  });

  test("the destroy flush writes to the closing DO's storage", async () => {
    const module = app
      .defineState<{ counter: number; label: string }>({ counter: 0, label: "" })
      .onAction("inc", ({ state }: any) => { state.counter += 1; })
      .persist(durableObjectStore(globalStrategy()))
      .ui('Text("@{state.counter}")');
    const config: HypenDurableObjectConfig = { module, template: module.template ?? "", moduleName: "App" };

    const storageA = createStorage();
    const storageB = createStorage();
    const a = new TestDO(createCtx(storageA) as any, {}, config);
    const b = new TestDO(createCtx(storageB) as any, {}, config);
    const wsA = createMockWebSocket();
    const wsB = createMockWebSocket();

    await send(a, wsA, { type: "hello", props: {} });
    await send(a, wsA, { type: "dispatchAction", action: "inc", payload: null });
    await send(b, wsB, { type: "hello", props: {} });
    // A closes before its debounce fires: the destroy flush must still
    // reach A's storage although B bound last.
    await a.webSocketClose(wsA as unknown as WebSocket, 1000, "");

    expect(persisted(storageA)?.counter).toBe(1);
    expect(persisted(storageB)?.counter ?? 0).toBe(0);

    await b.webSocketClose(wsB as unknown as WebSocket, 1000, "");
  });

  test("route modules mounted by the auto-wired router persist into their own DO", async () => {
    const registry = new HypenApp();
    registry
      .module("Home")
      .defineState({ visits: 0, who: "" })
      .onCreated((state: any) => { state.visits += 1; })
      .persist(durableObjectStore(globalStrategy()))
      .ui('Text("Visits: @{state.visits}")');
    const primary = registry
      .module("App")
      .defineState({ location: "/" })
      .ui(`module App { Router { Route(path: "/") { Home() } } }`);
    const config: HypenDurableObjectConfig = {
      module: primary,
      template: primary.template!,
      moduleName: "App",
      app: registry,
    };

    const storageA = createStorage();
    const storageB = createStorage();
    const a = new TestDO(createCtx(storageA) as any, {}, config);
    const b = new TestDO(createCtx(storageB) as any, {}, config);
    const wsA = createMockWebSocket();
    const wsB = createMockWebSocket();

    // Both route modules change state within one persistence debounce.
    await send(a, wsA, { type: "hello", props: {} });
    await send(b, wsB, { type: "hello", props: {} });
    await new Promise((r) => setTimeout(r, 120));

    const home = (s: ReturnType<typeof createStorage>) =>
      s._data.get("hypen:global:Home") as { visits: number } | undefined;
    expect(home(storageA)?.visits).toBe(1);
    expect(home(storageB)?.visits).toBe(1);

    await a.webSocketClose(wsA as unknown as WebSocket, 1000, "");
    await b.webSocketClose(wsB as unknown as WebSocket, 1000, "");
  });
});
