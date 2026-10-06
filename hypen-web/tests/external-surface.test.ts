/**
 * External capability surface — the guarded entry points for callers that
 * are NOT the rendered UI (MCP servers, REST APIs, CLIs, agents).
 *
 * The rule these tests hold to the fire: **nothing is externally reachable
 * that a developer did not declare.** Three surfaces, each an allowlist
 * derived from a declaration — `.onAction()` for actions, `Router { Route }`
 * for navigation, `.bind(@state.x)` for inputs. The guard itself lives in
 * the engine (`hypen-engine-rs/src/agent.rs`); what's under test here is
 * that the SDK reaches it and never routes around it.
 *
 * These run against the real WASM engine, because a fake engine could only
 * ever prove that we called a method — not that the guard refused.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import {
  AGENT_NAVIGATE,
  AGENT_SET_INPUT,
  type Action,
} from "../packages/core/src/types";
import { ManagedRouter } from "../packages/core/src/managed-router";
import { HypenRouter } from "../packages/core/src/router";
import { HypenGlobalContext } from "../packages/core/src/context";
import { flushMicrotasks } from "./helpers";

/**
 * Boot a real engine over a DSL source. The engine retains the expanded
 * root IR, which is what `listRoutes` / `listBindings` read — so the
 * declared surface only exists once something has been rendered.
 */
async function boot(source: string): Promise<Engine> {
  const engine = new Engine();
  await engine.init();
  engine.setRenderCallback(() => {});
  engine.renderSource(source);
  return engine;
}

const actionNames = (engine: Engine): string[] =>
  engine.listActions().map((a) => a.name);

describe("External capability surface — actions", () => {
  beforeEach(() => {
    app.clear();
  });

  test("a listed module action dispatches through dispatchExternal", async () => {
    const engine = await boot(`module Counter { Text("@{state.count}") }`);

    const def = app
      .defineState({ count: 0 }, { name: "Counter" })
      .onAction("increment", ({ state }) => {
        state.count += 1;
      })
      .build();
    const instance = new HypenModuleInstance(engine, def);
    await instance.waitForReady();

    const listed = engine.listActions().find((a) => a.name === "increment");
    expect(listed).toBeDefined();
    expect(listed!.module).toBe("counter");
    expect(listed!.builtin).toBe(false);

    engine.dispatchExternal("increment");
    await flushMicrotasks(4);

    expect((instance.getState() as { count: number }).count).toBe(1);
  });

  test("an undeclared action name is refused", async () => {
    const engine = await boot(`module Counter { Text("@{state.count}") }`);
    const def = app
      .defineState({ count: 0 }, { name: "Counter" })
      .onAction("increment", ({ state }) => {
        state.count += 1;
      })
      .build();
    await new HypenModuleInstance(engine, def).waitForReady();

    expect(() => engine.dispatchExternal("wipeDatabase")).toThrow();
  });

  test("__hypen_bind is refused by name and cannot write state", async () => {
    // The arbitrary-write primitive: it takes a caller-supplied path and
    // assigns straight into state. Reachable by the renderer, never by
    // name from outside — `set_input` is the only door, and it validates.
    const engine = await boot(
      `module Secrets { Input(placeholder: "Name").bind(@state.name) }`,
    );
    const def = app
      .defineState({ name: "", authToken: "sekrit" }, { name: "Secrets" })
      .build();
    const instance = new HypenModuleInstance(engine, def);
    await instance.waitForReady();

    expect(actionNames(engine)).not.toContain("__hypen_bind");
    expect(() =>
      engine.dispatchExternal("__hypen_bind", {
        path: "authToken",
        value: "stolen",
      }),
    ).toThrow();

    await flushMicrotasks(4);
    expect((instance.getState() as { authToken: string }).authToken).toBe(
      "sekrit",
    );
  });

  test("router.replace and router.forward are refused even where navigation is declared", async () => {
    // `navigate` / `back` are an exact-match built-in table, never a
    // `router.` prefix rule — so history manipulation with no external
    // meaning stays out of reach even in a routed app.
    const engine = await boot(
      `module Shell { Router { Route(path: "/") { Text("home") } } }`,
    );

    const reached: string[] = [];
    engine.onAction("router.replace", () => reached.push("router.replace"));
    engine.onAction("router.forward", () => reached.push("router.forward"));

    expect(actionNames(engine)).not.toContain("router.replace");
    expect(actionNames(engine)).not.toContain("router.forward");
    expect(() =>
      engine.dispatchExternal("router.replace", { to: "/admin" }),
    ).toThrow();
    expect(() => engine.dispatchExternal("router.forward")).toThrow();

    await flushMicrotasks(4);
    expect(reached).toEqual([]);
  });
});

describe("External capability surface — inputs", () => {
  beforeEach(() => {
    app.clear();
  });

  test("set_input writes state for a .bind()-declared field", async () => {
    const engine = await boot(
      `module Form { Input(placeholder: "Name").bind(@state.name) }`,
    );
    const def = app
      .defineState({ name: "", authToken: "sekrit" }, { name: "Form" })
      .build();
    const instance = new HypenModuleInstance(engine, def);
    await instance.waitForReady();

    const declared = engine.listBindings().find((b) => b.path === "name");
    expect(declared).toBeDefined();
    expect(declared!.prop).toBe("value");
    expect(declared!.elementType).toBe("Input");
    expect(actionNames(engine)).toContain(AGENT_SET_INPUT);

    // A named definition is a *named* module (`registerModule("form", …)`),
    // and `set_input` addresses a field the way the manifest's schema says:
    // `{ module, field, value }`, with `module` absent only for the primary.
    // Without the scope the guard refuses rather than guess — the same field
    // name in two modules is two fields.
    expect(() =>
      engine.dispatchExternal(AGENT_SET_INPUT, { field: "name", value: "Ada" }),
    ).toThrow(/declared by module/);

    engine.dispatchExternal(AGENT_SET_INPUT, {
      module: "form",
      field: "name",
      value: "Ada",
    });
    await flushMicrotasks(4);

    expect((instance.getState() as { name: string }).name).toBe("Ada");
  });

  test("set_input is refused for a field no .bind() declares", async () => {
    // The whole point: set_input is not a general state writer.
    const engine = await boot(
      `module Form { Input(placeholder: "Name").bind(@state.name) }`,
    );
    const def = app
      .defineState({ name: "", authToken: "sekrit" }, { name: "Form" })
      .build();
    const instance = new HypenModuleInstance(engine, def);
    await instance.waitForReady();

    expect(engine.listBindings().map((b) => b.path)).not.toContain(
      "authToken",
    );
    expect(() =>
      engine.dispatchExternal(AGENT_SET_INPUT, {
        field: "authToken",
        value: "stolen",
      }),
    ).toThrow();

    await flushMicrotasks(4);
    expect((instance.getState() as { authToken: string }).authToken).toBe(
      "sekrit",
    );
  });

  test("set_input is not offered at all by an app that declares no binds", async () => {
    const engine = await boot(`module Plain { Text("nothing to fill in") }`);

    expect(engine.listBindings()).toEqual([]);
    expect(actionNames(engine)).not.toContain(AGENT_SET_INPUT);
    expect(() =>
      engine.dispatchExternal(AGENT_SET_INPUT, { field: "name", value: "Ada" }),
    ).toThrow();
  });
});

describe("External capability surface — navigation", () => {
  beforeEach(() => {
    app.clear();
  });

  test("navigate works when a Router is declared", async () => {
    const engine = await boot(`
      module Shell {
        Router {
          Route(path: "/") { Text("home") }
          Route(path: "/cart/:id") { Text("cart") }
        }
      }
    `);

    expect(engine.listRoutes().map((r) => r.path)).toEqual(["/", "/cart/:id"]);
    expect(engine.listRoutes()[1]!.params).toEqual(["id"]);
    expect(engine.listRoutes()[1]!.moduleScope).toBe("shell");
    expect(actionNames(engine)).toContain(AGENT_NAVIGATE);

    // `navigate` lowers to `router.push` with the payload untouched — the
    // same handler ManagedRouter installs.
    let pushed: unknown = null;
    engine.onAction("router.push", (action: Action) => {
      pushed = action.payload;
    });

    engine.dispatchExternal(AGENT_NAVIGATE, { to: "/cart/42" });
    await flushMicrotasks(4);

    expect(pushed).toEqual({ to: "/cart/42" });
  });

  test("navigate is refused when no Router is declared", async () => {
    const engine = await boot(`module Plain { Text("no router here") }`);

    const reached: string[] = [];
    engine.onAction("router.push", () => reached.push("router.push"));

    expect(engine.listRoutes()).toEqual([]);
    expect(actionNames(engine)).not.toContain(AGENT_NAVIGATE);
    expect(actionNames(engine)).not.toContain("hypen.back");
    expect(() => engine.dispatchExternal(AGENT_NAVIGATE, { to: "/cart" })).toThrow();

    await flushMicrotasks(4);
    expect(reached).toEqual([]);
  });
});

describe("External capability surface — module teardown", () => {
  beforeEach(() => {
    app.clear();
  });

  test("a destroyed module drops out of listActions; a persisted one does not", async () => {
    // The distinction `unregisterModule` exists to respect. Under the
    // default `persist: true` an off-screen module stays registered on
    // purpose — siblings still read its state — so it must keep listing.
    // A `persist: false` module is genuinely destroyed on unmount, and its
    // actions must stop being externally dispatchable with it.
    const engine = await boot(`
      module Shell {
        Router {
          Route(path: "/cart") { Text("cart") }
          Route(path: "/checkout") { Text("checkout") }
        }
      }
    `);

    app
      .defineState({ items: [] as string[] }, { name: "Cart" })
      .onAction("addToCart", ({ state }) => {
        state.items.push("thing");
      })
      .build();
    app
      .defineState({ step: 1 }, { name: "Checkout", persist: false })
      .onAction("nextStep", ({ state }) => {
        state.step += 1;
      })
      .build();

    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();
    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();
    expect(actionNames(engine)).toContain("addToCart");

    // Cart leaves the screen but persists (the default) — still listed,
    // still dispatchable, because its state is still readable by siblings.
    router.push("/checkout");
    await managed.waitForNavigation();
    expect(actionNames(engine)).toContain("addToCart");
    expect(actionNames(engine)).toContain("nextStep");
    expect(globalCtx.hasModule("cart")).toBe(true);
    expect(() => engine.dispatchExternal("addToCart")).not.toThrow();

    // Checkout opted out of persistence, so leaving destroys it.
    router.push("/cart");
    await managed.waitForNavigation();
    expect(actionNames(engine)).not.toContain("nextStep");
    expect(actionNames(engine)).toContain("addToCart");
    expect(globalCtx.hasModule("checkout")).toBe(false);
    expect(() => engine.dispatchExternal("nextStep")).toThrow();
  });

  test("stop() drops every persisted module's actions", async () => {
    const engine = await boot(`
      module Shell {
        Router {
          Route(path: "/cart") { Text("cart") }
          Route(path: "/checkout") { Text("checkout") }
        }
      }
    `);

    app
      .defineState({ items: [] as string[] }, { name: "Cart" })
      .onAction("addToCart", ({ state }) => {
        state.items.push("thing");
      })
      .build();
    app
      .defineState({ step: 1 }, { name: "Checkout" })
      .onAction("nextStep", ({ state }) => {
        state.step += 1;
      })
      .build();

    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();
    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();
    router.push("/checkout");
    await managed.waitForNavigation();
    expect(actionNames(engine)).toContain("addToCart");

    await managed.stop();

    expect(actionNames(engine)).not.toContain("addToCart");
    expect(actionNames(engine)).not.toContain("nextStep");
    expect(() => engine.dispatchExternal("addToCart")).toThrow();
  });
});

/**
 * The destroy-only rule, proved without WASM: a fake engine records every
 * `unregisterModule` call, so an accidental call on the ordinary
 * (persisting) unmount path shows up as a failure here rather than as a
 * mysteriously empty persist cache in someone's app.
 */
describe("ManagedRouter calls engine.unregisterModule on destroy paths only", () => {
  class RecordingEngine {
    public unregistered: string[] = [];
    public actionHandlers = new Map<string, (action: Action) => unknown>();

    setModule() {}
    registerModule() {}
    updateStateSparse() {}
    onAction(name: string, handler: (action: Action) => unknown) {
      this.actionHandlers.set(name, handler);
    }
    unregisterModule(name: string) {
      this.unregistered.push(name);
    }
  }

  beforeEach(() => {
    app.clear();
  });

  test("an ordinary persisting unmount does NOT unregister", async () => {
    const engine = new RecordingEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({ items: [] as string[] }, { name: "Cart" }).build();
    app.defineState({ step: 1 }, { name: "Checkout" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();
    router.push("/checkout");
    await managed.waitForNavigation();

    expect(engine.unregistered).toEqual([]);
  });

  test("a persist: false unmount unregisters exactly that module", async () => {
    const engine = new RecordingEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({ items: [] as string[] }, { name: "Cart", persist: false }).build();
    app.defineState({ step: 1 }, { name: "Checkout" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();
    router.push("/checkout");
    await managed.waitForNavigation();

    expect(engine.unregistered).toEqual(["cart"]);
  });

  test("LRU eviction unregisters the evicted module", async () => {
    const engine = new RecordingEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({ n: 1 }, { name: "One" }).build();
    app.defineState({ n: 2 }, { name: "Two" }).build();
    app.defineState({ n: 3 }, { name: "Three" }).build();

    // Cap of 1: persisting the second module evicts the first.
    const managed = new ManagedRouter(router, engine, app, globalCtx, {
      maxPersistedModules: 1,
    });
    managed.addRoute({ path: "/one", component: "One" });
    managed.addRoute({ path: "/two", component: "Two" });
    managed.addRoute({ path: "/three", component: "Three" });

    router.push("/one");
    managed.start();
    await managed.waitForNavigation();
    router.push("/two");
    await managed.waitForNavigation();
    expect(engine.unregistered).toEqual([]);

    router.push("/three");
    await managed.waitForNavigation();
    expect(engine.unregistered).toEqual(["one"]);
  });
});
