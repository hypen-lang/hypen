import { describe, test, expect, beforeEach } from "bun:test";
import {
  HypenDurableObject,
  CFTransport,
  mergeComponentTemplates,
  type HypenDurableObjectConfig,
  type DurableObjectState,
} from "../src/index.js";
import { durableObjectStore } from "../src/durable-object-store.js";
import { global as globalStrategy } from "../src/strategies.js";
import { app } from "@hypen-space/core/app";
import type { BaseEngine } from "@hypen-space/core/engine-base";

/**
 * Glue-level tests for the RemoteSession-hosting HypenDurableObject.
 *
 * This class is now a thin Cloudflare adapter around `RemoteSession` (which
 * lives in @hypen-space/core and owns the whole remote protocol). These tests
 * cover the Cloudflare-specific contract this class actually owns —
 * `CFTransport` framing, the `fetch` upgrade handshake, the message
 * parse-guard, and per-DO storage binding — without standing up a WASM engine.
 *
 * The end-to-end protocol (hello -> sessionAck -> initialTree -> streaming
 * patches) is RemoteSession's responsibility and is exercised against the real
 * engine by the main suite's remote-server / remote-session tests. Asserting
 * it again here would require a full fake engine and would really be testing
 * core, not this adapter.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockState() {
  const sockets: WebSocket[] = [];
  const puts: Array<[string, unknown]> = [];
  return {
    storage: {
      get: async () => undefined,
      put: async (k: string, v: unknown) => {
        puts.push([k, v]);
      },
      delete: async () => false,
    },
    acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
    _puts: puts,
  };
}

function createMockWebSocket() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    sent,
    get closed() {
      return closed;
    },
    send: (data: string) => sent.push(data),
    close: (code?: number, reason?: string) => {
      closed = { code, reason };
    },
    readyState: 1,
  };
}

// A DO whose engine factory throws — proving the paths under test (fetch,
// parse-guard, storage binding) never construct an engine.
class NoEngineDO extends HypenDurableObject {
  constructor(ctx: any, env: any, private cfg: HypenDurableObjectConfig) {
    super(ctx, env);
  }
  getConfig(): HypenDurableObjectConfig {
    return this.cfg;
  }
  createEngine(): BaseEngine {
    throw new Error("createEngine must not be called on this path");
  }
}

function singleModuleConfig(): HypenDurableObjectConfig {
  return {
    // `.ui()` builds and returns the definition (it calls build() internally).
    module: app.defineState({ count: 0 }).ui('Text("hi")'),
    template: 'Text("hi")',
    moduleName: "App",
  };
}

// ---------------------------------------------------------------------------
// CFTransport
// ---------------------------------------------------------------------------

describe("CFTransport", () => {
  test("JSON-serialises outgoing messages to ws.send", () => {
    const ws = createMockWebSocket();
    const t = new CFTransport(ws as unknown as WebSocket);
    t.send({ type: "sessionAck", sessionId: "x", isNew: true, isRestored: false } as any);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "sessionAck", sessionId: "x" });
  });

  test("forwards close with code and reason", () => {
    const ws = createMockWebSocket();
    const t = new CFTransport(ws as unknown as WebSocket);
    t.close(1001, "bye");
    expect(ws.closed).toEqual({ code: 1001, reason: "bye" });
  });

  test("swallows errors from an already-closed socket", () => {
    const ws = {
      close() {
        throw new Error("already closed");
      },
    };
    const t = new CFTransport(ws as unknown as WebSocket);
    expect(() => t.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HypenDurableObject — Cloudflare glue
// ---------------------------------------------------------------------------

describe("HypenDurableObject (Cloudflare glue)", () => {
  beforeEach(() => {
    app.clear?.();
    // Polyfill WebSocketPair for the Bun test runner (CF provides it at runtime).
    (globalThis as any).WebSocketPair = class {
      0 = createMockWebSocket();
      1 = createMockWebSocket();
    };
  });

  describe("fetch()", () => {
    test("returns 426 without a websocket upgrade header", async () => {
      const ctx = createMockState();
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      const res = await dObj.fetch(new Request("http://x/"));
      expect(res.status).toBe(426);
      expect(await res.text()).toBe("Expected WebSocket upgrade");
    });

    test("accepts the server socket and returns 101 on upgrade", async () => {
      const ctx = createMockState();
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      const res = await dObj.fetch(
        new Request("http://x/", { headers: { Upgrade: "websocket" } }),
      );
      expect(res.status).toBe(101);
      expect(res.body).toBeNull();
      expect(ctx.getWebSockets()).toHaveLength(1);
    });
  });

  describe("webSocketMessage parse-guard", () => {
    test("ignores unparseable frames without constructing an engine", async () => {
      const ctx = createMockState();
      const ws = createMockWebSocket();
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      // createEngine throws; a non-JSON frame must be dropped before reaching it.
      await expect(dObj.webSocketMessage(ws as any, "not json {")).resolves.toBeUndefined();
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe("webSocketClose()", () => {
    test("is a no-op when no session exists for the socket", async () => {
      const ctx = createMockState();
      const ws = createMockWebSocket();
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      await expect(
        dObj.webSocketClose(ws as any, 1000, "normal"),
      ).resolves.toBeUndefined();
    });
  });

  describe("webSocketError()", () => {
    test("is a no-op when no session exists for the socket", async () => {
      const ctx = createMockState();
      const ws = createMockWebSocket();
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      await expect(
        dObj.webSocketError(ws as any, new Error("connection reset")),
      ).resolves.toBeUndefined();
    });
  });

  describe("storage binding", () => {
    test("binds DO storage to the primary module's persistence store on fetch", async () => {
      const ctx = createMockState();
      const store = durableObjectStore(globalStrategy());
      // `.persist(store)` attaches the DO store; `.ui(...)` builds the def.
      const module = app.defineState({ count: 0 }).persist(store).ui('Text("hi")');

      const dObj = new NoEngineDO(ctx as any, {}, {
        module,
        template: 'Text("hi")',
        moduleName: "App",
      });
      await dObj.fetch(new Request("http://x/", { headers: { Upgrade: "websocket" } }));

      // After binding, a save reaches DO storage instead of throwing
      // "storage not bound".
      await store.save("k", { count: 1 });
      expect(ctx._puts.map(([k]) => k)).toContain("hypen:k");
    });

    test("binds storage for named modules on the app registry too", async () => {
      const ctx = createMockState();
      const namedStore = durableObjectStore(globalStrategy());
      // A named module registers itself on the shared `app` registry.
      app
        .module("Sidebar")
        .defineState({ open: false })
        .persist(namedStore)
        .ui('Text("side")');

      const primary = app.defineState({ count: 0 }).ui('Text("hi")');

      const dObj = new NoEngineDO(ctx as any, {}, {
        module: primary,
        template: 'Text("hi")',
        moduleName: "App",
        app,
      });
      await dObj.fetch(new Request("http://x/", { headers: { Upgrade: "websocket" } }));

      await namedStore.save("named-k", { open: true });
      expect(ctx._puts.map(([k]) => k)).toContain("hypen:named-k");
    });
  });

  describe("DurableObjectState typing", () => {
    test("config and base class accept a minimal DurableObjectState", () => {
      // Compile-time guard: the public DurableObjectState stub is enough to
      // construct a subclass. (Construction alone touches no engine.)
      const ctx: DurableObjectState = createMockState() as any;
      const dObj = new NoEngineDO(ctx as any, {}, singleModuleConfig());
      expect(dObj).toBeInstanceOf(HypenDurableObject);
    });
  });
});

describe("mergeComponentTemplates", () => {
  beforeEach(() => {
    app.clear?.();
  });

  test("componentTemplates fills an empty registry template (external .hypen)", () => {
    // A named module that registers on `app` but whose UI is external (no
    // inline .ui), so its registry `.template` is empty — the social-example
    // shape. The explicit template must win.
    app.module("HomePage").defineState({ feed: [] }).build();
    const merged = mergeComponentTemplates(app, {
      HomePage: 'Column { Text("home") }',
    });
    expect(merged.get("HomePage")?.template).toBe('Column { Text("home") }');
    // …and the registry module def is preserved (for nested-module state).
    expect(merged.get("HomePage")?.module?.name).toBe("HomePage");
  });

  test("a non-empty inline .ui() registry template is NOT overridden", () => {
    app.module("Inline").defineState({}).ui('Text("inline")');
    const merged = mergeComponentTemplates(app, {
      Inline: 'Text("SHOULD NOT WIN")',
    });
    expect(merged.get("Inline")?.template).toBe('Text("inline")');
  });

  test("anonymous fallback (not on registry) is added", () => {
    const merged = mergeComponentTemplates(app, {
      BottomNav: 'Row { Text("nav") }',
    });
    expect(merged.get("BottomNav")).toEqual({ template: 'Row { Text("nav") }' });
  });

  test("no app + no templates yields an empty map", () => {
    expect(mergeComponentTemplates(null, undefined).size).toBe(0);
  });
});
