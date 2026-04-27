import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  HypenDurableObject,
  type HypenDurableObjectConfig,
  type DurableObjectState,
  durableObjectStore,
  global,
  type DurableObjectStorage,
} from "../src/index.js";
import type { IEngine, HypenModuleDefinition } from "@hypen-space/core/app";
import type { Patch, RenderCallback } from "@hypen-space/core/types";

// ---------------------------------------------------------------------------
// Polyfill WebSocketPair for non-CF environments (Bun test runner).
// Must be defined before importing the DO module (which uses it at runtime).
// ---------------------------------------------------------------------------

if (typeof globalThis.WebSocketPair === "undefined") {
  (globalThis as any).WebSocketPair = class WebSocketPair {
    0: any;
    1: any;
    constructor() {
      const makeSock = () => ({
        sent: [] as string[],
        send(data: string) { this.sent.push(data); },
        close() {},
        readyState: 1,
      });
      this[0] = makeSock();
      this[1] = makeSock();
    }
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockStorage(): DurableObjectStorage & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      return data.delete(key);
    },
  };
}

function createMockWebSocket(): WebSocket & {
  sent: string[];
  closedWith?: { code: number; reason: string };
} {
  const ws = {
    sent: [] as string[],
    closedWith: undefined as { code: number; reason: string } | undefined,
    send(data: string) {
      ws.sent.push(data);
    },
    close(code?: number, reason?: string) {
      ws.closedWith = { code: code ?? 1000, reason: reason ?? "" };
    },
    // Minimal WebSocket stubs
    readyState: 1,
    url: "",
    protocol: "",
    extensions: "",
    bufferedAmount: 0,
    binaryType: "blob" as BinaryType,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    CONNECTING: 0 as const,
    OPEN: 1 as const,
    CLOSING: 2 as const,
    CLOSED: 3 as const,
  };
  return ws as any;
}

function createMockDurableObjectState(
  storage: DurableObjectStorage,
): DurableObjectState & { acceptedWebSockets: WebSocket[] } {
  const acceptedWebSockets: WebSocket[] = [];
  return {
    storage,
    acceptedWebSockets,
    acceptWebSocket(ws: WebSocket) {
      acceptedWebSockets.push(ws);
    },
    getWebSockets() {
      return acceptedWebSockets;
    },
  };
}

/**
 * Create a mock engine that tracks all calls.
 * Has the methods needed by both IEngine and the DO code (renderSource, etc.).
 */
function createMockEngine(): IEngine & {
  _renderCallback: RenderCallback | null;
  _module: { name: string; actions: string[]; stateKeys: string[]; state: unknown } | null;
  _actionHandlers: Map<string, (action: any) => void | Promise<void>>;
  _dispatched: Array<{ name: string; payload: unknown }>;
  _rendered: string[];
  setRenderCallback(cb: RenderCallback): void;
  renderSource(source: string): void;
  dispatchAction(name: string, payload?: unknown): void;
} {
  const engine = {
    _renderCallback: null as RenderCallback | null,
    _module: null as { name: string; actions: string[]; stateKeys: string[]; state: unknown } | null,
    _actionHandlers: new Map<string, (action: any) => void | Promise<void>>(),
    _dispatched: [] as Array<{ name: string; payload: unknown }>,
    _rendered: [] as string[],

    setModule(name: string, actions: string[], stateKeys: string[], initialState: unknown) {
      engine._module = { name, actions, stateKeys, state: initialState };
    },

    registerModule(name: string, actions: string[], stateKeys: string[], initialState: any) {
      engine._module = { name, actions, stateKeys, state: initialState };
    },

    onAction(actionName: string, handler: (action: any) => void | Promise<void>) {
      engine._actionHandlers.set(actionName, handler);
    },

    updateStateSparse(_scope: string | null, _paths: string[], _changedValues: Record<string, unknown>) {
      // no-op in mock
    },

    setRenderCallback(cb: RenderCallback) {
      engine._renderCallback = cb;
    },

    renderSource(source: string) {
      engine._rendered.push(source);
      // Emit some patches so the initial tree message has content
      if (engine._renderCallback) {
        engine._renderCallback([
          { type: "create", id: "root", elementType: "Column" } as unknown as Patch,
        ]);
      }
    },

    dispatchAction(name: string, payload?: unknown) {
      engine._dispatched.push({ name, payload });
      // Fire the registered action handler if any
      const handler = engine._actionHandlers.get(name);
      if (handler) {
        handler({ name, payload });
      }
      // Emit patches to simulate a re-render
      if (engine._renderCallback) {
        engine._renderCallback([
          { type: "setText", id: "text-1", text: "updated" } as unknown as Patch,
        ]);
      }
    },
  };

  return engine;
}

function createMockModuleDefinition(): HypenModuleDefinition<{ count: number }> {
  return {
    name: "Counter",
    actions: ["increment"],
    stateKeys: ["count"],
    initialState: { count: 0 },
    handlers: {
      onAction: new Map([
        ["increment", ({ state }: any) => { state.count++; }],
      ]),
    },
  };
}

function createMockModuleDefinitionWithStore() {
  const store = durableObjectStore<{ count: number }>(global());
  const def = createMockModuleDefinition();
  def.stateStore = store;
  return { def, store };
}

// ---------------------------------------------------------------------------
// Concrete subclass for testing
// ---------------------------------------------------------------------------

class TestDurableObject extends HypenDurableObject {
  private config: HypenDurableObjectConfig;
  engineFactory: () => IEngine;

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    config: HypenDurableObjectConfig,
    engineFactory: () => IEngine,
  ) {
    super(ctx, env);
    this.config = config;
    this.engineFactory = engineFactory;
  }

  getConfig(): HypenDurableObjectConfig {
    return this.config;
  }

  createEngine(): IEngine {
    return this.engineFactory();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HypenDurableObject", () => {
  let storage: DurableObjectStorage & { data: Map<string, unknown> };
  let ctx: DurableObjectState & { acceptedWebSockets: WebSocket[] };
  let engine: ReturnType<typeof createMockEngine>;
  let moduleDef: HypenModuleDefinition<{ count: number }>;
  let dobj: TestDurableObject;

  beforeEach(() => {
    storage = createMockStorage();
    ctx = createMockDurableObjectState(storage);
    engine = createMockEngine();
    moduleDef = createMockModuleDefinition();
    dobj = new TestDurableObject(
      ctx,
      {},
      { module: moduleDef, template: 'Text("Hello")', moduleName: "Counter" },
      () => engine,
    );
  });

  // -------------------------------------------------------------------------
  // fetch()
  // -------------------------------------------------------------------------

  describe("fetch()", () => {
    test("returns 426 if not a WebSocket upgrade request", async () => {
      const request = new Request("http://localhost/");
      const response = await dobj.fetch(request);

      expect(response.status).toBe(426);
      const text = await response.text();
      expect(text).toBe("Expected WebSocket upgrade");
    });

    test("returns 101 for WebSocket upgrade", async () => {
      const request = new Request("http://localhost/", {
        headers: { Upgrade: "websocket" },
      });

      const response = await dobj.fetch(request);

      expect(response.status).toBe(101);
      // Body should be null for WebSocket upgrade responses
      expect(response.body).toBeNull();
    });

    test("accepts the server-side WebSocket via ctx.acceptWebSocket", async () => {
      const request = new Request("http://localhost/", {
        headers: { Upgrade: "websocket" },
      });

      await dobj.fetch(request);

      expect(ctx.acceptedWebSockets.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // webSocketMessage — "hello"
  // -------------------------------------------------------------------------

  describe('webSocketMessage with "hello"', () => {
    test("initializes session, sends sessionAck and initialTree", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));

      // Should have sent sessionAck and initialTree
      expect(ws.sent.length).toBeGreaterThanOrEqual(2);

      const sessionAck = JSON.parse(ws.sent[0]);
      expect(sessionAck.type).toBe("sessionAck");
      expect(sessionAck.isNew).toBe(true);
      expect(typeof sessionAck.sessionId).toBe("string");

      const initialTree = JSON.parse(ws.sent[1]);
      expect(initialTree.type).toBe("initialTree");
      expect(initialTree.module).toBe("Counter");
      expect(Array.isArray(initialTree.patches)).toBe(true);
      expect(initialTree.revision).toBe(0);
    });

    test("uses requested sessionId when provided", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(
        ws,
        JSON.stringify({ type: "hello", sessionId: "my-session-42" }),
      );

      const sessionAck = JSON.parse(ws.sent[0]);
      expect(sessionAck.sessionId).toBe("my-session-42");
    });

    test("renders the template from config", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));

      expect(engine._rendered).toContain('Text("Hello")');
    });

    test("only initializes once per WebSocket (idempotent)", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
      const firstSentCount = ws.sent.length;

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
      // Should not have sent additional sessionAck/initialTree
      expect(ws.sent.length).toBe(firstSentCount);
    });
  });

  // -------------------------------------------------------------------------
  // webSocketMessage — "dispatchAction"
  // -------------------------------------------------------------------------

  describe('webSocketMessage with "dispatchAction"', () => {
    test("dispatches action to engine", async () => {
      const ws = createMockWebSocket();

      // Initialize first
      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));

      // Clear sent messages from init
      ws.sent.length = 0;

      await dobj.webSocketMessage(
        ws,
        JSON.stringify({
          type: "dispatchAction",
          module: "Counter",
          action: "increment",
          payload: { amount: 1 },
        }),
      );

      expect(engine._dispatched.length).toBe(1);
      expect(engine._dispatched[0].name).toBe("increment");
      expect(engine._dispatched[0].payload).toEqual({ amount: 1 });
    });

    test("streams patches back via WebSocket", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
      ws.sent.length = 0;

      await dobj.webSocketMessage(
        ws,
        JSON.stringify({
          type: "dispatchAction",
          module: "Counter",
          action: "increment",
        }),
      );

      // Should have received a patch message
      expect(ws.sent.length).toBeGreaterThanOrEqual(1);
      const patchMsg = JSON.parse(ws.sent[0]);
      expect(patchMsg.type).toBe("patch");
      expect(patchMsg.module).toBe("Counter");
      expect(Array.isArray(patchMsg.patches)).toBe(true);
      expect(patchMsg.revision).toBe(1);
    });

    test("auto-initializes session if hello was never sent", async () => {
      const ws = createMockWebSocket();

      // Send dispatchAction without hello first
      await dobj.webSocketMessage(
        ws,
        JSON.stringify({
          type: "dispatchAction",
          module: "Counter",
          action: "increment",
        }),
      );

      // Session should have been auto-initialized
      // (sessionAck + initialTree + patch from dispatch)
      const messages = ws.sent.map((s) => JSON.parse(s));
      const types = messages.map((m: any) => m.type);
      expect(types).toContain("sessionAck");
      expect(types).toContain("initialTree");
    });
  });

  // -------------------------------------------------------------------------
  // webSocketClose
  // -------------------------------------------------------------------------

  describe("webSocketClose()", () => {
    test("destroys the module instance (flushes state)", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));

      // Close should not throw
      await dobj.webSocketClose(ws, 1000, "normal");
    });

    test("is safe to call without prior session", async () => {
      const ws = createMockWebSocket();
      // Should not throw even if no session was created
      await dobj.webSocketClose(ws, 1000, "normal");
    });
  });

  // -------------------------------------------------------------------------
  // Storage binding (__bindStorage)
  // -------------------------------------------------------------------------

  describe("storage binding", () => {
    test("binds DO storage to state store via __bindStorage on fetch()", async () => {
      const { def, store } = createMockModuleDefinitionWithStore();
      const doWithStore = new TestDurableObject(
        ctx,
        {},
        { module: def, template: 'Text("@{state.count}")', moduleName: "Counter" },
        () => createMockEngine(),
      );

      const request = new Request("http://localhost/", {
        headers: { Upgrade: "websocket" },
      });

      await doWithStore.fetch(request);

      // Store should now be bound — verify by calling load (won't throw)
      const result = await store.load("test-key");
      expect(result).toBeNull(); // no data yet, but no "not bound" error
    });

    test("binds storage on webSocketMessage (hibernation wake)", async () => {
      const { def, store } = createMockModuleDefinitionWithStore();
      const doWithStore = new TestDurableObject(
        ctx,
        {},
        { module: def, template: 'Text("@{state.count}")', moduleName: "Counter" },
        () => createMockEngine(),
      );

      const ws = createMockWebSocket();

      // Simulate hibernation wake — webSocketMessage called without prior fetch
      await doWithStore.webSocketMessage(
        ws,
        JSON.stringify({ type: "hello" }),
      );

      // Store should be bound after ensureSession re-binds
      const result = await store.load("test-key");
      expect(result).toBeNull(); // bound, just no data
    });
  });

  // -------------------------------------------------------------------------
  // Hibernation / re-creation
  // -------------------------------------------------------------------------

  describe("hibernation lifecycle", () => {
    test("creates new engine + module instance on wake (new WebSocket)", async () => {
      const engines: ReturnType<typeof createMockEngine>[] = [];
      const doObj = new TestDurableObject(
        ctx,
        {},
        { module: moduleDef, template: 'Text("Hello")', moduleName: "Counter" },
        () => {
          const e = createMockEngine();
          engines.push(e);
          return e;
        },
      );

      const ws1 = createMockWebSocket();
      await doObj.webSocketMessage(ws1, JSON.stringify({ type: "hello" }));

      const ws2 = createMockWebSocket();
      await doObj.webSocketMessage(ws2, JSON.stringify({ type: "hello" }));

      // Each WebSocket should get its own engine
      expect(engines.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("ignores unparseable messages", async () => {
      const ws = createMockWebSocket();

      // Should not throw
      await dobj.webSocketMessage(ws, "not json at all");
      expect(ws.sent.length).toBe(0);
    });

    test("ignores unknown message types", async () => {
      const ws = createMockWebSocket();

      await dobj.webSocketMessage(
        ws,
        JSON.stringify({ type: "unknownType", data: "test" }),
      );

      // Unknown type is silently ignored — no error, but engine is created
      // via ensureSession for the "dispatchAction" path. For truly unknown
      // types, no action messages are sent.
    });

    test("handles ArrayBuffer messages", async () => {
      const ws = createMockWebSocket();
      const encoder = new TextEncoder();
      const buffer = encoder.encode(JSON.stringify({ type: "hello" })).buffer;

      await dobj.webSocketMessage(ws, buffer as ArrayBuffer);

      expect(ws.sent.length).toBeGreaterThanOrEqual(2);
      const sessionAck = JSON.parse(ws.sent[0]);
      expect(sessionAck.type).toBe("sessionAck");
    });

    test("uses default moduleName 'App' when not specified", async () => {
      const doDefault = new TestDurableObject(
        ctx,
        {},
        { module: moduleDef, template: 'Text("Hello")' },
        () => createMockEngine(),
      );

      const ws = createMockWebSocket();
      await doDefault.webSocketMessage(ws, JSON.stringify({ type: "hello" }));

      const initialTree = JSON.parse(ws.sent[1]);
      expect(initialTree.module).toBe("App");
    });

    test("dispatchAction with null payload", async () => {
      const ws = createMockWebSocket();
      await dobj.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
      ws.sent.length = 0;

      await dobj.webSocketMessage(
        ws,
        JSON.stringify({
          type: "dispatchAction",
          module: "Counter",
          action: "increment",
        }),
      );

      // payload defaults to null
      expect(engine._dispatched[0].payload).toBeNull();
    });
  });
});
