/**
 * Hibernation regression for `@hypen-space/cf`'s `HypenDurableObject`.
 *
 * Cloudflare evicts a DO's in-memory state between messages while keeping
 * the WebSocket alive at the edge. When the next message arrives the DO
 * class is reconstructed from scratch — `this.sessions` is empty, the
 * engine is gone, `bindStorage` has never run on this instance. The class
 * has to recover transparently:
 *
 *   1. Re-bind the (possibly recreated) storage handle so any
 *      `.persist(durableObjectStore(...))` store reaches the right DO.
 *   2. Lazily rebuild the `RemoteSession` for the existing WebSocket.
 *   3. If the post-wake message isn't `hello`, synthesise one so the
 *      client (which still thinks it's connected) sees `sessionAck` +
 *      `initialTree` before the action it just sent is dispatched.
 *   4. Persisted module state has to survive: a value mutated before
 *      hibernation must be visible after wake.
 *
 * These tests stand up a real WASM engine (via `@hypen-space/server`'s
 * `Engine`, which the bun preload already arms) so the full protocol
 * runs. The DO is exercised directly through `webSocketMessage` /
 * `webSocketClose` — no fetch handshake — because hibernation
 * recovery is the entire point.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { HypenDurableObject, type HypenDurableObjectConfig } from "../packages/cf/src/durable-object";
import { durableObjectStore } from "../packages/cf/src/durable-object-store";
import {
  global as globalStrategy,
  session as sessionStrategy,
} from "../packages/cf/src/strategies";
import { Engine } from "../packages/server/src/engine";
import { app } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";

// ---------------------------------------------------------------------------
// In-memory mocks — minimal stand-ins for the workerd surfaces the DO uses.
// ---------------------------------------------------------------------------

/** Mock the DO storage. Shared across DO incarnations to simulate disk. */
function createSharedStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return data.get(key); },
    async put(key: string, value: unknown) { data.set(key, value); },
    async delete(key: string) { return data.delete(key); },
    /** raw access for assertions */
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

function createCtx(sharedStorage: ReturnType<typeof createSharedStorage>) {
  const sockets: WebSocket[] = [];
  return {
    storage: sharedStorage,
    acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  };
}

/** Parse all WS frames a mock captured. */
function frames(ws: { sent: string[] }) {
  return ws.sent.map((s) => JSON.parse(s));
}

// ---------------------------------------------------------------------------
// Module under test: a tiny App with persisted state. The bug we'd catch
// is anything that breaks restoration of `counter` after the DO is recycled.
// ---------------------------------------------------------------------------

interface AppState { counter: number }

function makeConfig(): HypenDurableObjectConfig {
  const module = app
    .defineState<AppState>({ counter: 0 })
    .onAction("inc", ({ state }: any) => { state.counter += 1; })
    .persist(durableObjectStore(globalStrategy<AppState>()))
    .ui('module App { Text("counter:@{state.counter}") }');
  return { module, template: module.template ?? "", moduleName: "App" };
}

class TestDO extends HypenDurableObject {
  constructor(ctx: any, env: any, private cfg: HypenDurableObjectConfig) {
    super(ctx, env);
  }
  getConfig() { return this.cfg; }
  createEngine(): BaseEngine { return new Engine(); }
}

beforeEach(() => {
  app.clear?.();
  (globalThis as any).WebSocketPair = class {
    0 = createMockWebSocket();
    1 = createMockWebSocket();
  };
});

describe("HypenDurableObject hibernation", () => {
  test(
    "a session-persisted detail route survives hibernation when its first action updates a Grid item",
    async () => {
      interface FoodState {
        location: string;
        cartCount: number;
        menuItems: Array<{ id: string; cartQuantity: number }>;
      }

      const module = app
        .defineState<FoodState>({
          location: "/",
          cartCount: 0,
          menuItems: [{ id: "m101", cartQuantity: 0 }],
        })
        .onAction<{ itemId: string }>("addToCart", ({ state, action }) => {
          const item = state.menuItems.find((entry) => entry.id === action.payload?.itemId);
          if (!item) return;
          item.cartQuantity += 1;
          state.cartCount += 1;
        })
        .persist(durableObjectStore(sessionStrategy<FoodState>()))
        .build();

      const template = `module App {
        Router {
          Route(path: "/") { Text("HOME") }
          Route(path: "/restaurant/:id") {
            Column {
              Text("DETAIL")
              Grid(@state.menuItems, key: "id") {
                Text("quantity:@{item.cartQuantity}")
              }
            }
          }
        }
      }`;
      const config = { module, template, moduleName: "App" };
      const storage = createSharedStorage();
      const ws = createMockWebSocket();

      // First incarnation: enter the restaurant route and allow the
      // session-scoped persistence debounce to commit that location.
      const ctxA = createCtx(storage);
      ctxA.acceptWebSocket(ws as unknown as WebSocket);
      const a = new TestDO(ctxA as any, {}, config);
      await a.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ type: "hello", props: {} }),
      );
      await a.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({
          type: "dispatchAction",
          action: "router.push",
          payload: { to: "/restaurant/r1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 120));

      // Simulate eviction while the accepted socket stays alive. The very
      // first post-wake message is Add, matching the Food app failure.
      void a;
      ws.sent.length = 0;
      const ctxB = createCtx(storage);
      ctxB.acceptWebSocket(ws as unknown as WebSocket);
      const b = new TestDO(ctxB as any, {}, config);
      await b.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({
          type: "dispatchAction",
          action: "addToCart",
          payload: { itemId: "m101" },
        }),
      );
      await new Promise((r) => setTimeout(r, 120));

      const out = frames(ws);
      const ack = out.find((message) => message.type === "sessionAck");
      const initial = out.find((message) => message.type === "initialTree");
      expect(ack).toMatchObject({ isNew: false, isRestored: true });
      expect(initial?.state).toMatchObject({
        location: "/restaurant/r1",
        cartCount: 0,
      });

      const initialText = (initial?.patches ?? [])
        .filter((patch: any) => patch.type === "create")
        .flatMap((patch: any) => Object.values(patch.props ?? {}));
      expect(initialText).toContain("DETAIL");
      expect(initialText).not.toContain("HOME");

      // The action runs after the restored detail tree is installed and the
      // persisted snapshot proves it did not reset the route while updating
      // the Grid-bound item.
      const persisted = [...storage._data.values()].find(
        (value: any) => value?.cartCount === 1,
      ) as FoodState | undefined;
      expect(persisted).toMatchObject({
        location: "/restaurant/r1",
        cartCount: 1,
        menuItems: [{ id: "m101", cartQuantity: 1 }],
      });
    },
  );

  test(
    "a non-hello first message after wake synthesises hello and emits sessionAck + initialTree before the action runs",
    async () => {
      const storage = createSharedStorage();
      const ctxBefore = createCtx(storage);
      const ws = createMockWebSocket();

      const before = new TestDO(ctxBefore as any, {}, makeConfig());

      // Pretend the WebSocket was accepted on a previous incarnation —
      // CF's `getWebSockets()` would return it post-wake. We skip the
      // fetch handshake and prime the socket directly.
      ctxBefore.acceptWebSocket(ws as unknown as WebSocket);

      // Hibernation: drop the DO. `before` and its sessions/engine are GC.
      // (The mock storage is shared across the boundary on purpose.)
      void before;

      const ctxAfter = createCtx(storage);
      ctxAfter.acceptWebSocket(ws as unknown as WebSocket);
      const after = new TestDO(ctxAfter as any, {}, makeConfig());

      // Client believed it was still connected — sends `inc` directly.
      await after.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ type: "dispatchAction", action: "inc", payload: null }),
      );
      // Let the dispatch settle.
      await new Promise((r) => queueMicrotask(() => r(null)));
      await new Promise((r) => setTimeout(r, 30));

      const out = frames(ws);
      // Synthetic hello → must produce both before any post-action patch.
      const ackIdx = out.findIndex((m) => m.type === "sessionAck");
      const treeIdx = out.findIndex((m) => m.type === "initialTree");
      const patchIdx = out.findIndex((m) => m.type === "patch");
      expect(ackIdx).toBeGreaterThanOrEqual(0);
      expect(treeIdx).toBeGreaterThan(ackIdx);
      // A `patch` frame *may* appear if the action mutated state. The
      // important property is ordering: it must come after the
      // synthesised handshake, not before it.
      if (patchIdx !== -1) {
        expect(patchIdx).toBeGreaterThan(treeIdx);
      }
    },
  );

  test(
    "module state persisted via durableObjectStore survives hibernation",
    async () => {
      const storage = createSharedStorage();

      // --- pre-hibernation incarnation ---
      const ctxA = createCtx(storage);
      const wsA = createMockWebSocket();
      ctxA.acceptWebSocket(wsA as unknown as WebSocket);
      const a = new TestDO(ctxA as any, {}, makeConfig());

      await a.webSocketMessage(
        wsA as unknown as WebSocket,
        JSON.stringify({ type: "hello", props: {} }),
      );
      // Three increments.
      for (let i = 0; i < 3; i++) {
        await a.webSocketMessage(
          wsA as unknown as WebSocket,
          JSON.stringify({ type: "dispatchAction", action: "inc", payload: null }),
        );
      }
      // Settle persistence saves — there's a 50ms debounce in
      // HypenModuleInstance.persistIfNeeded, so wait past it.
      await new Promise((r) => setTimeout(r, 120));

      // Sanity: at least one `hypen:`-prefixed entry made it into storage.
      const keys = [...storage._data.keys()];
      const hypenKeys = keys.filter((k) => k.startsWith("hypen:"));
      expect(hypenKeys.length).toBeGreaterThan(0);

      // --- hibernate: drop `a`, build a fresh DO over the same storage ---
      void a;
      const ctxB = createCtx(storage);
      const wsB = createMockWebSocket();
      ctxB.acceptWebSocket(wsB as unknown as WebSocket);
      const b = new TestDO(ctxB as any, {}, makeConfig());

      await b.webSocketMessage(
        wsB as unknown as WebSocket,
        JSON.stringify({ type: "hello", props: {} }),
      );
      await new Promise((r) => setTimeout(r, 30));

      const out = frames(wsB);
      const initial = out.find((m) => m.type === "initialTree");
      expect(initial).toBeDefined();
      // The restored state on the new incarnation must reflect the three
      // pre-hibernation increments — not the module's `{counter: 0}` default.
      expect(initial.state.counter).toBe(3);
    },
  );

  test(
    "a new WebSocket on the post-wake DO doesn't trip over the previous incarnation's session map",
    async () => {
      // Defends against a bug shape where the post-wake DO would still
      // hold a stale entry keyed by an earlier `ws` identity, leak state
      // across sessions, or simply throw on `ensureSession`.
      const storage = createSharedStorage();
      const cfg = makeConfig();

      const ctxA = createCtx(storage);
      const wsA = createMockWebSocket();
      ctxA.acceptWebSocket(wsA as unknown as WebSocket);
      const a = new TestDO(ctxA as any, {}, cfg);
      await a.webSocketMessage(
        wsA as unknown as WebSocket,
        JSON.stringify({ type: "hello", props: {} }),
      );
      await new Promise((r) => setTimeout(r, 10));
      void a;

      // Fresh DO, fresh socket — no `wsA` rebuild.
      const ctxB = createCtx(storage);
      const wsB = createMockWebSocket();
      ctxB.acceptWebSocket(wsB as unknown as WebSocket);
      const b = new TestDO(ctxB as any, {}, makeConfig());
      await b.webSocketMessage(
        wsB as unknown as WebSocket,
        JSON.stringify({ type: "hello", props: {} }),
      );
      await new Promise((r) => setTimeout(r, 10));

      const out = frames(wsB);
      expect(out.find((m) => m.type === "sessionAck")).toBeDefined();
      expect(out.find((m) => m.type === "initialTree")).toBeDefined();
    },
  );
});
