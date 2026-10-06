import { app } from "../packages/core/src/app";
import { describe, it, expect } from "bun:test";
import {
  RemoteSession,
  AsyncQueueTransport,
  SessionManager,
  type SessionHost,
} from "@hypen-space/core/remote";
import { BaseEngine } from "@hypen-space/core/engine-base";

/**
 * Proves RemoteSession works with a hand-rolled SessionHost — i.e. without
 * @hypen-space/server's RemoteServer. This is the path a Cloudflare Durable
 * Object (or any non-Node runtime) takes: satisfy SessionHost and inject the
 * engine via `createEngine`. Guards the keystone of the core extraction: the
 * session no longer constructs a Node-only `Engine` itself.
 */
class FakeEngine extends BaseEngine {
  async init(): Promise<void> {
    // A Proxy whose every member is a no-op fn satisfies whatever the
    // session calls during construction (setComponentResolver, etc.)
    // without binding the test to constructor internals.
    this.wasmEngine = new Proxy({}, { get: () => () => {} });
    this.initialized = true;
  }
  protected unwrapForWasm<T>(value: T): T {
    return value;
  }
}

function makeHost(createEngine: () => BaseEngine): SessionHost {
  return {
    module: { handlers: {} } as unknown as SessionHost["module"],
    moduleName: "Test",
    ui: 'Text("hi")',
    resources: {},
    app: null,
    syncActions: false,
    sessionManager: new SessionManager(),
    discoveredComponents: new Map(),
    createEngine,
    otherSessions: () => [],
    sessionsForId: () => [],
    onSessionReady: () => {},
    onSessionDestroyed: () => {},
  };
}

describe("RemoteSession standalone (CF-style host)", () => {
  it("uses the engine returned by SessionHost.createEngine", () => {
    let created = 0;
    const engine = new FakeEngine();
    const host = makeHost(() => {
      created++;
      return engine;
    });

    const session = new RemoteSession(host, new AsyncQueueTransport(), {
      helloGraceMs: null,
    });

    expect(created).toBe(1);
    expect(session.engine).toBe(engine);
  });

  it("constructs a fresh engine per session", () => {
    const host = makeHost(() => new FakeEngine());

    const a = new RemoteSession(host, new AsyncQueueTransport(), {
      helloGraceMs: null,
    });
    const b = new RemoteSession(host, new AsyncQueueTransport(), {
      helloGraceMs: null,
    });

    expect(a.engine).not.toBe(b.engine);
  });
});

/**
 * Inline-router regression: a single-module app (no `app` registry) with an
 * inline `Router { Route(path) { ...markup... } }` and a `location` state key
 * must still get its `@router.push` handler installed and `state.location`
 * mirrored. Previously `autoWireManagedRouter` bailed when `host.app` was null,
 * so navigation in such apps silently no-op'd (the simple/cf example bug).
 */
class RouterFakeEngine extends BaseEngine {
  readonly actions = new Set<string>();
  readonly sparseUpdates: Array<Record<string, unknown>> = [];

  async init(): Promise<void> {
    const self = this;
    this.wasmEngine = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "onAction") {
            return (name: string, _h: unknown) => self.actions.add(name);
          }
          if (prop === "updateStateSparse") {
            return (_scope: unknown, _paths: unknown, values: Record<string, unknown>) =>
              self.sparseUpdates.push(values);
          }
          if (prop === "discoverRouters") {
            // One inline Router block, routes with no component element names.
            return () => [
              {
                moduleScope: null,
                routes: [
                  { path: "/", elementNames: ["Text"] },
                  { path: "/about", elementNames: ["Text"] },
                ],
              },
            ];
          }
          return () => undefined;
        },
      },
    );
    this.initialized = true;
  }
  protected unwrapForWasm<T>(value: T): T {
    return value;
  }
}

function makeInlineRouterHost(engine: BaseEngine): SessionHost {
  const onAction = new Map<string, unknown>();
  return {
    // A primary module whose initial state carries `location` (drives inline
    // routes) and registers no actions of its own.
    module: {
      name: "App",
      actions: [],
      stateKeys: ["location"],
      initialState: { location: "/" },
      handlers: { onAction },
    } as unknown as SessionHost["module"],
    moduleName: "App",
    ui: 'module App { Router { Route(path: "/") { Text("home") } Route(path: "/about") { Text("about") } } }',
    resources: {},
    app: null, // ← the key condition: no registry
    syncActions: false,
    sessionManager: new SessionManager(),
    discoveredComponents: new Map(),
    createEngine: () => engine,
    otherSessions: () => [],
    sessionsForId: () => [],
    onSessionReady: () => {},
    onSessionDestroyed: () => {},
  };
}

/**
 * initialTree accumulation must DROP `batchAnimation` preludes: the stamp's
 * wire contract scopes it to exactly ONE batch (first patch), and the
 * session concatenates every pre-ready render batch (initial tree + any
 * onCreated re-render) into a single initialTree array — a surviving
 * prelude would over-scope onto patches from other batches.
 */
class StampingFakeEngine extends BaseEngine {
  private renderCb: ((patches: unknown[]) => void) | null = null;

  async init(): Promise<void> {
    const self = this;
    this.wasmEngine = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "setRenderCallback") {
            return (cb: (patches: unknown[]) => void) => {
              self.renderCb = cb;
            };
          }
          if (prop === "renderSource") {
            return () => {
              // Two stamped batches accumulate into one initialTree array.
              self.renderCb?.([
                { type: "batchAnimation", spec: { curve: "spring", duration: 250 } },
                { type: "create", id: "n1", elementType: "Text", props: {} },
                { type: "insert", parentId: "root", id: "n1" },
              ]);
              self.renderCb?.([
                { type: "batchAnimation", spec: { curve: "linear", duration: 100 } },
                { type: "setProp", id: "n1", name: "opacity", value: 1 },
              ]);
            };
          }
          if (prop === "discoverRouters") {
            return () => [];
          }
          return () => undefined;
        },
      }
    );
    this.initialized = true;
  }
  protected unwrapForWasm<T>(value: T): T {
    return value;
  }
}

describe("RemoteSession initialTree accumulation", () => {
  it("strips batchAnimation preludes from accumulated initial batches", async () => {
    const engine = new StampingFakeEngine();
    const host = makeInlineRouterHost(engine);
    host.ui = 'Text("hi")';
    const transport = new AsyncQueueTransport();
    const session = new RemoteSession(host, transport, { helloGraceMs: null });

    await session.receive({ type: "hello" } as never);
    await session.ready;

    // Drain the outgoing queue and find initialTree.
    const messages: any[] = [];
    transport.close();
    for await (const msg of transport.stream()) {
      messages.push(msg);
    }
    const initial = messages.find((m) => m.type === "initialTree");
    expect(initial).toBeDefined();

    const types = initial.patches.map((p: any) => p.type);
    // The real content of BOTH batches survived…
    expect(types).toEqual(["create", "insert", "setProp"]);
    // …but no prelude did (mid-array stamps are contract violations).
    expect(types.includes("batchAnimation")).toBe(false);
  });
});

describe("RemoteSession inline router (no app registry)", () => {
  it("installs @router.push for an inline Router even with app:null", async () => {
    const engine = new RouterFakeEngine();
    const host = makeInlineRouterHost(engine);
    const session = new RemoteSession(host, new AsyncQueueTransport(), {
      helloGraceMs: null,
    });

    // Drive the handshake so initializeSession → autoWireManagedRouter runs.
    await session.receive({ type: "hello" } as never);
    await session.ready;

    // The router action handlers must be installed despite app:null.
    expect(engine.actions.has("router.push")).toBe(true);
  });
});

describe("scoped UI action fan-out", () => {
  it("resolves session-local node identity once before forwarding", async () => {
    class RoutingEngine extends FakeEngine {
      calls: Array<{ name: string; payload: unknown }> = [];
      resolved: unknown[] = [];
      override resolveUIAction(name: string, payload: unknown) {
        this.resolved.push({ name, payload });
        return { name: "__hypen_scoped:board:__hypen_pin", payload: { path: "__dnd.board.a", x: .5, y: .25 } };
      }
      override dispatchAction(name: string, payload: unknown) { this.calls.push({ name, payload }); }
    }
    const aEngine = new RoutingEngine(), bEngine = new RoutingEngine();
    let count = 0;
    const sessions: RemoteSession[] = [];
    const host = makeHost(() => count++ === 0 ? aEngine : bEngine);
    Object.assign(host, { module: app.defineState({}).build(), syncActions: true, otherSessions: (current: RemoteSession) => sessions.filter(s => s !== current) });
    for (let i = 0; i < 2; i++) sessions.push(new RemoteSession(host, new AsyncQueueTransport(), { helloGraceMs: null }));
    await Promise.all(sessions.map(async s => { await s.receive({ type: "hello" } as never); await s.ready; }));
    await sessions[0]!.receive({ type: "dispatchAction", module: "Board", action: "__hypen_dispatch", payload: { node: "source-session-only", action: "__hypen_pin", payload: { path: "__dnd.board.a", x: .5, y: .25 } } });
    expect(aEngine.resolved).toHaveLength(1);
    expect(bEngine.resolved).toHaveLength(0);
    expect(aEngine.calls).toEqual(bEngine.calls);
    expect(bEngine.calls).toEqual([{ name: "__hypen_scoped:board:__hypen_pin", payload: { path: "__dnd.board.a", x: .5, y: .25 } }]);
    await Promise.all(sessions.map(s => s.destroy()));
  });
});
