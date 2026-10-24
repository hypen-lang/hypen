/**
 * Hibernation WAKE regressions (QA: examples/simple + examples/food-ordering
 * on `wrangler dev`): after the Durable Object is evicted, the next client
 * message must find
 *
 *   - every module's state restored — the primary, and route modules (live
 *     or cached) — WITHOUT any `.persist()` store configured;
 *   - the router back on the route the client was showing;
 *   - its action applied, although it addresses the PREVIOUS engine's node
 *     ids (it is re-targeted onto the rebuilt tree by structural position,
 *     never dropped as a "stale UI action target").
 *
 * Eviction is simulated by constructing a fresh DO over the same storage
 * and the same (attachment-carrying) socket.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { HypenDurableObject, type HypenDurableObjectConfig } from "../packages/cf/src/durable-object";
import { Engine } from "../packages/server/src/engine";
import { app, HypenApp } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";

function createSharedStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return structuredClone(data.get(key)); },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    async delete(key: string) { return data.delete(key); },
    async list(opts?: { prefix?: string }) {
      const out = new Map<string, unknown>();
      for (const [k, v] of data) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      return out;
    },
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
type MockWS = ReturnType<typeof createMockWebSocket>;

function createCtx(storage: ReturnType<typeof createSharedStorage>) {
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

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * A client-side mirror of the tree (what a renderer would hold): applies
 * initialTree (replacing everything) and patches, so tests can find node
 * ids the way a real client would and read rendered text.
 */
class ClientTree {
  types = new Map<string, string>();
  props = new Map<string, Record<string, unknown>>();
  children = new Map<string, string[]>();
  parent = new Map<string, string>();
  private consumed = 0;

  sync(ws: MockWS): void {
    for (; this.consumed < ws.sent.length; this.consumed++) {
      const msg = JSON.parse(ws.sent[this.consumed]!);
      if (msg.type === "initialTree") {
        this.types.clear(); this.props.clear(); this.children.clear(); this.parent.clear();
        this.apply(msg.patches);
      } else if (msg.type === "patch") {
        this.apply(msg.patches);
      }
    }
  }

  private unlink(id: string) {
    const p = this.parent.get(id);
    if (p === undefined) return;
    const list = this.children.get(p) ?? [];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    this.parent.delete(id);
  }

  private apply(patches: any[]) {
    for (const p of patches) {
      switch (p.type) {
        case "create":
          this.types.set(p.id, p.elementType);
          this.props.set(p.id, { ...(p.props ?? {}) });
          break;
        case "setProp":
          this.props.get(p.id) && (this.props.get(p.id)![p.name] = p.value);
          break;
        case "insert": case "move": case "attach": {
          this.unlink(p.id);
          const list = this.children.get(p.parentId) ?? [];
          this.children.set(p.parentId, list);
          const at = p.beforeId ? list.indexOf(p.beforeId) : -1;
          if (at >= 0) list.splice(at, 0, p.id); else list.push(p.id);
          this.parent.set(p.id, p.parentId);
          break;
        }
        case "detach": this.unlink(p.id); break;
        case "remove": this.unlink(p.id); break;
      }
    }
  }

  /** Attached ids in document order. */
  attached(): string[] {
    const out: string[] = [];
    const walk = (id: string) => {
      for (const c of this.children.get(id) ?? []) { out.push(c); walk(c); }
    };
    walk("root");
    return out;
  }

  /** Visible text of attached nodes. */
  texts(): string[] {
    return this.attached()
      .map((id) => this.props.get(id)?.["0"] ?? this.props.get(id)?.text)
      .filter((t): t is string => typeof t === "string");
  }

  /** The attached element whose subtree (or itself) shows `label`, of type `type`. */
  find(type: string, label: string): string {
    for (const id of this.attached()) {
      if (this.types.get(id)?.toLowerCase() !== type.toLowerCase()) continue;
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        const props = this.props.get(cur) ?? {};
        if (Object.values(props).some((v) => v === label)) return id;
        stack.push(...(this.children.get(cur) ?? []));
      }
    }
    throw new Error(`no ${type} showing "${label}" in ${JSON.stringify(this.texts())}`);
  }
}

function click(node: string, action: string, payload?: unknown) {
  return JSON.stringify({
    type: "dispatchAction",
    action: "__hypen_dispatch",
    payload: { node, action, ...(payload !== undefined ? { payload } : {}) },
  });
}

beforeEach(() => {
  app.clear?.();
});

describe("HypenDurableObject hibernation wake", () => {
  test("simple counter (no .persist): state survives the wake and the waking click applies once", async () => {
    // examples/simple/cf, verbatim shape: primary module + inline routes.
    const counter = app
      .defineState({ count: 0, location: "/" })
      .onAction("inc", ({ state }: any) => { state.count += 1; })
      .ui(`
        module App {
          Column {
            Row {
              Button { Text("Home") }.onClick(@router.push, to: "/")
              Button { Text("About") }.onClick(@router.push, to: "/about")
            }
            Router {
              Route(path: "/") {
                Column {
                  Text("Count: @{state.count}")
                  Button("@actions.inc") { Text("Increment") }
                }
              }
              Route(path: "/about") { Text("About page") }
            }
          }
        }`);
    const config: HypenDurableObjectConfig = { module: counter, template: counter.template!, moduleName: "App" };
    const storage = createSharedStorage();
    const ws = createMockWebSocket();
    const tree = new ClientTree();

    const a = new TestDO(createCtx(storage) as any, {}, config);
    await a.webSocketMessage(ws as any, JSON.stringify({ type: "hello", props: {} }));
    tree.sync(ws);
    for (let i = 0; i < 2; i++) {
      await a.webSocketMessage(ws as any, click(tree.find("button", "Increment"), "inc"));
      await settle();
      tree.sync(ws);
    }
    expect(tree.texts()).toContain("Count: 2");
    const staleButton = tree.find("button", "Increment");

    // --- eviction: fresh DO over the same storage + socket ---
    const b = new TestDO(createCtx(storage) as any, {}, config);
    const before = ws.sent.length;
    await b.webSocketMessage(ws as any, click(staleButton, "inc"));
    await settle();
    const out = ws.sent.slice(before).map((s) => JSON.parse(s));
    const ack = out.find((m) => m.type === "sessionAck");
    const initial = out.find((m) => m.type === "initialTree");
    expect(ack).toMatchObject({ isNew: false, isRestored: true });
    // The rebuilt tree shows the state the client had — not {count: 0}.
    expect(initial.state).toMatchObject({ count: 2, location: "/" });
    tree.sync(ws);
    // ...and the waking click applied exactly once.
    expect(tree.texts()).toContain("Count: 3");

    // The next click (on the NEW tree's ids) keeps working.
    await b.webSocketMessage(ws as any, click(tree.find("button", "Increment"), "inc"));
    await settle();
    tree.sync(ws);
    expect(tree.texts()).toContain("Count: 4");
  });

  test("route modules: state of the active AND a cached route module survives; a stale-id click on the routed module applies", async () => {
    // The `hypen init` scaffold shape: primary App(location) + Home/Counter
    // route modules (their own state, their own handlers).
    const registry = new HypenApp();
    const home = registry
      .module("Home")
      .defineState({ taps: 0 })
      .onAction("tap", ({ state }: any) => { state.taps += 1; })
      .ui(`Column {
        Text("Taps: @{state.taps}")
        Button("@actions.tap") { Text("Tap") }
      }`);
    const counterMod = registry
      .module("Counter")
      .defineState({ count: 0 })
      .onAction("increment", ({ state }: any) => { state.count += 1; })
      .ui(`Column {
        Text("Counter: @{state.count}")
        Button("@actions.increment") { Text("Plus") }
      }`);
    void home; void counterMod;
    const primary = registry
      .module("App")
      .defineState({ location: "/" })
      .ui(`module App {
        Column {
          Row {
            Button { Text("GoHome") }.onClick(@router.push, to: "/")
            Button { Text("GoCounter") }.onClick(@router.push, to: "/counter")
          }
          Router {
            Route(path: "/") { Home() }
            Route(path: "/counter") { Counter() }
          }
        }
      }`);
    const config: HypenDurableObjectConfig = {
      module: primary,
      template: primary.template!,
      moduleName: "App",
      app: registry,
    };
    const storage = createSharedStorage();
    const ws = createMockWebSocket();
    const tree = new ClientTree();
    const send = async (d: TestDO, text: string) => {
      await d.webSocketMessage(ws as any, text);
      await settle();
      tree.sync(ws);
    };

    const a = new TestDO(createCtx(storage) as any, {}, config);
    await send(a, JSON.stringify({ type: "hello", props: {} }));
    await send(a, click(tree.find("button", "Tap"), "tap"));
    await send(a, click(tree.find("button", "Tap"), "tap"));
    expect(tree.texts()).toContain("Taps: 2");
    await send(a, click(tree.find("button", "GoCounter"), "router.push", { to: "/counter" }));
    await send(a, click(tree.find("button", "Plus"), "increment"));
    expect(tree.texts()).toContain("Counter: 1");
    const stalePlus = tree.find("button", "Plus");

    // --- eviction ---
    const b = new TestDO(createCtx(storage) as any, {}, config);
    const before = ws.sent.length;
    await send(b, click(stalePlus, "increment"));
    const out = ws.sent.slice(before).map((s) => JSON.parse(s));
    const initial = out.find((m) => m.type === "initialTree");
    expect(initial.state).toMatchObject({ location: "/counter" });
    // Rendered straight onto the restored route with the restored value.
    const initialTexts = initial.patches
      .filter((p: any) => p.type === "create")
      .flatMap((p: any) => Object.values(p.props ?? {}));
    expect(initialTexts).toContain("Counter: 1");
    // The waking click (old node id) applied.
    expect(tree.texts()).toContain("Counter: 2");

    // The cached Home module (not mounted on wake) kept its state too.
    await send(b, click(tree.find("button", "GoHome"), "router.push", { to: "/" }));
    expect(tree.texts()).toContain("Taps: 2");
    await send(b, click(tree.find("button", "Tap"), "tap"));
    expect(tree.texts()).toContain("Taps: 3");

    // A SECOND eviction keeps everything (the snapshot carried Counter's
    // state although it was cached, and Home's as live).
    const c = new TestDO(createCtx(storage) as any, {}, config);
    await send(c, click(tree.find("button", "GoCounter"), "router.push", { to: "/counter" }));
    expect(tree.texts()).toContain("Counter: 2");
    await send(c, click(tree.find("button", "GoHome"), "router.push", { to: "/" }));
    expect(tree.texts()).toContain("Taps: 3");
  });

  test("a new socket presenting the session id after an eviction resumes the stored snapshot", async () => {
    const counter = app
      .defineState({ count: 0 })
      .onAction("inc", ({ state }: any) => { state.count += 1; })
      .ui(`module App { Column { Text("Count: @{state.count}") Button("@actions.inc") { Text("Inc") } } }`);
    const config: HypenDurableObjectConfig = { module: counter, template: counter.template!, moduleName: "App" };
    const storage = createSharedStorage();
    const wsA = createMockWebSocket();
    const tree = new ClientTree();
    const a = new TestDO(createCtx(storage) as any, {}, config);
    await a.webSocketMessage(wsA as any, JSON.stringify({ type: "hello", props: {} }));
    tree.sync(wsA);
    await a.webSocketMessage(wsA as any, click(tree.find("button", "Inc"), "inc"));
    await settle();
    const sessionId = JSON.parse(wsA.sent[0]!).sessionId;

    const wsB = createMockWebSocket();
    const b = new TestDO(createCtx(storage) as any, {}, config);
    await b.webSocketMessage(wsB as any, JSON.stringify({ type: "hello", sessionId }));
    await settle();
    const out = wsB.sent.map((s) => JSON.parse(s));
    expect(out.find((m) => m.type === "sessionAck")).toMatchObject({ sessionId, isNew: false, isRestored: true });
    expect(out.find((m) => m.type === "initialTree").state).toMatchObject({ count: 1 });

    // An unknown id never adopts anything.
    const wsC = createMockWebSocket();
    const c = new TestDO(createCtx(storage) as any, {}, config);
    await c.webSocketMessage(wsC as any, JSON.stringify({ type: "hello", sessionId: "not-a-session" }));
    await settle();
    const ackC = JSON.parse(wsC.sent[0]!);
    expect(ackC.isNew).toBe(true);
    expect(ackC.sessionId).not.toBe("not-a-session");
  });
});
