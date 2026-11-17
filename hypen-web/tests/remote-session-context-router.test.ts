/**
 * `context.router` for the modules of a remote session.
 *
 * The primary module used to be constructed with no router (`undefined`), so
 * `context.router` was null and `context.router.push()` did nothing in a
 * single-module Durable Object app. Every module of a session now shares the
 * session's `HypenRouter`, whose navigation is mirrored into the primary
 * `state.location` (the generic web client mirrors that to the URL).
 *
 * Exercised through `HypenDurableObject` with the real WASM engine — the DO
 * is a thin host over core's `RemoteSession`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { HypenDurableObject, type HypenDurableObjectConfig } from "../packages/cf/src/durable-object";
import { Engine } from "../packages/server/src/engine";
import { app, HypenApp } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";

function createStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return data.get(key); },
    async put(key: string, value: unknown) { data.set(key, value); },
    async delete(key: string) { return data.delete(key); },
  };
}

function createMockWebSocket() {
  const sent: string[] = [];
  return { sent, send: (s: string) => sent.push(s), close: () => {}, readyState: 1 };
}

class TestDO extends HypenDurableObject {
  constructor(ctx: any, env: any, private cfg: HypenDurableObjectConfig) {
    super(ctx, env);
  }
  getConfig() { return this.cfg; }
  createEngine(): BaseEngine { return new Engine(); }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function start(config: HypenDurableObjectConfig) {
  const d = new TestDO({ storage: createStorage(), acceptWebSocket() {}, getWebSockets: () => [] } as any, {}, config);
  const ws = createMockWebSocket();
  const send = async (msg: unknown) => {
    await d.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
    await settle();
  };
  await send({ type: "hello", props: {} });
  const session = () => [...((d as any).sessions as Map<unknown, any>).values()][0];
  const state = () => session().moduleInstance.getState() as Record<string, unknown>;
  const texts = () => {
    const out: string[] = [];
    for (const raw of ws.sent) {
      const m = JSON.parse(raw);
      for (const p of m.patches ?? []) {
        if (p.type === "create" && typeof p.props?.["0"] === "string") out.push(p.props["0"]);
        if (p.type === "setProp" && p.name === "0" && typeof p.value === "string") out.push(p.value);
      }
    }
    return out;
  };
  const router = () => session()._router as {
    getCurrentPath(): string;
    serverHistory: string[];
  };
  return { d, ws, send, state, texts, router, close: () => d.webSocketClose(ws as unknown as WebSocket, 1000, "") };
}

const action = (name: string, payload: unknown = null) => ({ type: "dispatchAction", action: name, payload });

// A server session has no `window` (a Durable Object never does); other
// test files may leave a partial global one behind, which would put
// `HypenRouter` on its browser-history path.
let savedWindow: unknown;
beforeEach(() => {
  app.clear?.();
  savedWindow = (globalThis as any).window;
  delete (globalThis as any).window;
});
afterEach(() => {
  if (savedWindow !== undefined) (globalThis as any).window = savedWindow;
});

describe("context.router in remote sessions", () => {
  test("single-module app: the primary module's context.router navigates state.location", async () => {
    let routerSeen: unknown = "unset";
    const module = app
      .defineState<{ location: string }>({ location: "/" })
      .onAction("go", ({ context }: any) => {
        routerSeen = context?.router ?? null;
        context.router.push("/settings");
      })
      .onAction("swap", ({ context }: any) => { context.router.replace("/about"); })
      .onAction("back", ({ context }: any) => { context.router.back(); })
      .ui('Text("at:@{state.location}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("go"));
    expect(routerSeen).not.toBeNull();
    expect(s.state().location).toBe("/settings");
    expect(s.texts()).toContain("at:/settings");

    await s.send(action("swap"));
    expect(s.state().location).toBe("/about");

    // `replace` overwrote /settings, so back returns to "/".
    await s.send(action("back"));
    expect(s.state().location).toBe("/");
    await s.close();
  });

  test("single-module app without a location key: push creates state.location", async () => {
    const module = app
      .defineState<{ n: number }>({ n: 0 })
      .onAction("go", ({ context }: any) => { context.router.push("/x"); })
      .ui('Text("n:@{state.n}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    expect(s.state().location).toBeUndefined();
    await s.send(action("go"));
    expect(s.state().location).toBe("/x");
    await s.close();
  });

  test("a state.location mutation keeps the router in step (back returns to it)", async () => {
    const module = app
      .defineState<{ location: string }>({ location: "/" })
      .onAction("navigate", ({ state, action }: any) => { state.location = action.payload.to; })
      .onAction("back", ({ context }: any) => { context.router.back(); })
      .ui('Text("at:@{state.location}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("navigate", { to: "/a" }));
    await s.send(action("navigate", { to: "/b" }));
    expect(s.state().location).toBe("/b");
    await s.send(action("back"));
    expect(s.state().location).toBe("/a");
    await s.close();
  });

  test("a screen module's router.push to an inline route (no module) navigates", async () => {
    const registry = new HypenApp();
    registry
      .module("Home")
      .defineState({ ok: true })
      .onAction("openAbout", ({ context }: any) => { context.router.push("/about"); })
      .ui('Text("HOME")');
    const primary = registry
      .module("App")
      .defineState({ location: "/" })
      .ui(`module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/about") { Text("ABOUT") }
        }
      }`);
    const s = await start({ module: primary, template: primary.template!, moduleName: "App", app: registry });
    expect(s.texts()).toContain("HOME");

    await s.send(action("openAbout"));
    expect(s.state().location).toBe("/about");
    expect(s.texts()).toContain("ABOUT");
    await s.close();
  });

  test("a screen module's router.push works when the primary declares no location", async () => {
    const registry = new HypenApp();
    registry
      .module("Home")
      .defineState({ ok: true })
      .onAction("openAbout", ({ context }: any) => { context.router.push("/about"); })
      .ui('Text("HOME")');
    const primary = registry
      .module("App")
      .defineState({})
      .ui(`module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/about") { Text("ABOUT") }
        }
      }`);
    const s = await start({ module: primary, template: primary.template!, moduleName: "App", app: registry });

    await s.send(action("openAbout"));
    expect(s.state().location).toBe("/about");
    expect(s.texts()).toContain("ABOUT");
    await s.close();
  });

  // ── `state.location` that is app data, not a route ──────────────────────
  // Without a Router block, `location` is only a route when it holds a path
  // ("/..."). Anything else (a city, an object) is the app's own data: never
  // pushed to the router, never normalised, never overwritten.

  test("no Router block, location: \"Paris\": state changes leave it alone and never move the router", async () => {
    const module = app
      .defineState<{ location: string; temp: number }>({ location: "Paris", temp: 10 })
      .onAction("tick", ({ state }: any) => { state.temp += 1; })
      .onAction("city", ({ state, action }: any) => { state.location = action.payload.to; })
      .ui('Text("@{state.location}:@{state.temp}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    expect(s.state().location).toBe("Paris");
    expect(s.router().getCurrentPath()).toBe("/");
    await s.send(action("tick"));
    await s.send(action("tick"));
    await s.send(action("city", { to: "London" }));
    await s.send(action("tick"));
    expect(s.state().location).toBe("London");
    expect(s.state().temp).toBe(13);
    expect(s.router().getCurrentPath()).toBe("/");
    expect(s.router().serverHistory).toEqual([]);
    expect(s.texts()).toContain("London:13");
    await s.close();
  });

  test("no Router block, object location: left untouched", async () => {
    const loc = { city: "Paris", lat: 48.85 };
    const module = app
      .defineState<{ location: { city: string; lat: number }; n: number }>({ location: loc, n: 0 })
      .onAction("tick", ({ state }: any) => { state.n += 1; })
      .onAction("move", ({ state }: any) => { state.location.city = "Lyon"; })
      .ui('Text("n:@{state.n}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("tick"));
    await s.send(action("move"));
    await s.send(action("tick"));
    expect(s.state().location).toEqual({ city: "Lyon", lat: 48.85 });
    expect(s.state().n).toBe(2);
    expect(s.router().getCurrentPath()).toBe("/");
    expect(s.router().serverHistory).toEqual([]);
    await s.close();
  });

  test("no Router block, non-path location: context.router.push does not clobber it", async () => {
    const module = app
      .defineState<{ location: string }>({ location: "Paris" })
      .onAction("go", ({ context }: any) => { context.router.push("/x"); })
      .ui('Text("@{state.location}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("go"));
    // The router moved (the app asked it to) but `location` is app data.
    expect(s.router().getCurrentPath()).toBe("/x");
    expect(s.state().location).toBe("Paris");
    await s.close();
  });

  test("no Router block, path location: context.router.push moves state.location", async () => {
    const module = app
      .defineState<{ location: string; n: number }>({ location: "/", n: 0 })
      .onAction("go", ({ context }: any) => { context.router.push("/x"); })
      .onAction("tick", ({ state }: any) => { state.n += 1; })
      .ui('Text("at:@{state.location}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("tick"));
    expect(s.router().getCurrentPath()).toBe("/");
    await s.send(action("go"));
    expect(s.state().location).toBe("/x");
    expect(s.texts()).toContain("at:/x");
    await s.close();
  });

  test("no Router block, @router.push action moves state.location", async () => {
    const module = app
      .defineState<{ n: number }>({ n: 0 })
      .ui('Text("n:@{state.n}")');
    const s = await start({ module, template: module.template ?? "", moduleName: "App" });

    await s.send(action("router.push", { to: "/y" }));
    expect(s.state().location).toBe("/y");
    await s.close();
  });
});
