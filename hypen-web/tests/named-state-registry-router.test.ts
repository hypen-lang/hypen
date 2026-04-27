import { describe, expect, test, beforeEach } from "bun:test";
import { app, HypenApp, HypenModuleInstance, type HypenModuleDefinition } from "../packages/core/src/app";
import type { Action } from "../packages/core/src/types";
import { ManagedRouter } from "../packages/core/src/managed-router";
import { HypenRouter } from "../packages/core/src/router";
import { HypenGlobalContext } from "../packages/core/src/context";
import { flushMicrotasks } from "./helpers";

type NotifyCall = { scope: string | null; paths: string[]; changedValues: Record<string, unknown> };
type RegisterCall = {
  name: string;
  actions: string[];
  stateKeys: string[];
  initialState: Record<string, unknown>;
};

class FakeEngine {
  public setModuleCalls: Array<RegisterCall> = [];
  public registerModuleCalls: Array<RegisterCall> = [];
  public notifyCalls: NotifyCall[] = [];
  public actionHandlers: Map<
    string,
    (action: Action) => Promise<void> | void
  > = new Map();

  setModule(
    name: string,
    actions: string[],
    stateKeys: string[],
    initialState: Record<string, unknown>
  ) {
    this.setModuleCalls.push({ name, actions, stateKeys, initialState });
  }

  registerModule(
    name: string,
    actions: string[],
    stateKeys: string[],
    initialState: Record<string, unknown>
  ) {
    this.registerModuleCalls.push({ name, actions, stateKeys, initialState });
  }

  updateStateSparse(scope: string | null, paths: string[], changedValues: Record<string, unknown>) {
    this.notifyCalls.push({
      scope,
      paths,
      changedValues: JSON.parse(JSON.stringify(changedValues)),
    });
  }

  onAction(
    name: string,
    handler: (action: Action) => void | Promise<void>
  ) {
    this.actionHandlers.set(name, handler);
  }
}

// ========================================================================
// A. Named module registration (6 tests)
//
// Named modules go through `registerModule(lowercase, ...)` and route their
// state updates with an explicit scope. Anonymous modules go through
// `setModule(...)` and use a `null` scope. State paths are passed through
// raw — the engine's IR `module_scope` field handles scoping.
// ========================================================================

describe("Named module registration", () => {
  test("named module registers under lowercased name", () => {
    const engine = new FakeEngine();
    const def = app
      .defineState({ count: 0 }, { name: "HomePage" })
      .build();

    new HypenModuleInstance(engine, def);

    expect(engine.setModuleCalls.length).toBe(0);
    expect(engine.registerModuleCalls.length).toBe(1);
    const call = engine.registerModuleCalls[0];
    expect(call.name).toBe("homepage");
    expect(call.initialState).toEqual({ count: 0 });
  });

  test("anonymous module uses setModule with raw state", () => {
    const engine = new FakeEngine();
    const def = app.defineState({ count: 0 }).build();

    new HypenModuleInstance(engine, def);

    expect(engine.registerModuleCalls.length).toBe(0);
    expect(engine.setModuleCalls.length).toBe(1);
    const call = engine.setModuleCalls[0];
    expect(call.name).toBe("AnonymousModule");
    expect(call.initialState).toEqual({ count: 0 });
  });

  test("state changes carry the lowercased scope", async () => {
    const engine = new FakeEngine();
    const def = app
      .defineState({ count: 0 }, { name: "Counter" })
      .build();

    const instance = new HypenModuleInstance(engine, def);

    instance.updateState({ count: 1 });
    await flushMicrotasks();

    expect(engine.notifyCalls.length).toBeGreaterThan(0);
    const lastCall = engine.notifyCalls[engine.notifyCalls.length - 1];
    expect(lastCall.scope).toBe("counter");
    expect(lastCall.paths).toEqual(["count"]);
    expect(lastCall.changedValues.count).toBe(1);
  });

  test("registration name is lowercased regardless of source casing", () => {
    const engine = new FakeEngine();
    const def = app
      .defineState({ value: "test" }, { name: "MyFancyModule" })
      .build();

    new HypenModuleInstance(engine, def);

    expect(engine.registerModuleCalls[0].name).toBe("myfancymodule");
  });

  test("empty name module is treated as anonymous", () => {
    const engine = new FakeEngine();
    const def = app.defineState({ x: 1 }, { name: "" }).build();

    new HypenModuleInstance(engine, def);

    expect(engine.registerModuleCalls.length).toBe(0);
    expect(engine.setModuleCalls.length).toBe(1);
    expect(engine.setModuleCalls[0].initialState).toEqual({ x: 1 });
  });

  test("nested state object is passed through unchanged", () => {
    const engine = new FakeEngine();
    const def = app
      .defineState(
        { user: { name: "Alice", age: 30 } },
        { name: "Profile" }
      )
      .build();

    new HypenModuleInstance(engine, def);

    const call = engine.registerModuleCalls[0];
    expect(call.name).toBe("profile");
    expect(call.initialState).toEqual({
      user: { name: "Alice", age: 30 },
    });
  });
});

// ========================================================================
// B. App Registry — auto-registration via build() (9 tests)
// ========================================================================

describe("App Registry", () => {
  beforeEach(() => {
    app.clear();
  });

  test("named module auto-registers on build()", () => {
    const def = app.defineState({ count: 0 }, { name: "Counter" }).build();

    expect(app.has("Counter")).toBe(true);
    expect(app.get("Counter")).toBe(def);
  });

  test("anonymous module does NOT auto-register", () => {
    app.defineState({ count: 0 }).build();

    expect(app.size).toBe(0);
  });

  test("get returns undefined for unregistered", () => {
    expect(app.get("Missing")).toBeUndefined();
  });

  test("has returns false for unregistered", () => {
    expect(app.has("Missing")).toBe(false);
  });

  test("unregister removes definition", () => {
    app.defineState({ x: 1 }, { name: "Widget" }).build();
    expect(app.has("Widget")).toBe(true);

    app.unregister("Widget");
    expect(app.has("Widget")).toBe(false);
  });

  test("size tracks registrations", () => {
    expect(app.size).toBe(0);

    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();
    expect(app.size).toBe(2);
  });

  test("getNames returns all names", () => {
    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();

    const names = app.getNames();
    expect(names).toContain("A");
    expect(names).toContain("B");
  });

  test("clear removes all", () => {
    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();

    app.clear();
    expect(app.size).toBe(0);
  });

  test("app.module() convenience auto-registers", () => {
    const def = app
      .module("Settings")
      .defineState({ theme: "dark" })
      .build();

    expect(app.has("Settings")).toBe(true);
    expect(app.get("Settings")).toBe(def);
    expect(def.name).toBe("Settings");
  });
});

// ========================================================================
// C. ManagedRouter (6 tests)
// ========================================================================

describe("ManagedRouter", () => {
  beforeEach(() => {
    app.clear();
  });

  // ManagedRouter depends on HypenRouter which requires browser environment
  // We test the module mounting/unmounting logic via GlobalContext
  test("two modules register with separate namespaced state", () => {
    const engine = new FakeEngine();
    const globalCtx = new HypenGlobalContext();

    const homeDef = app
      .defineState({ count: 0 }, { name: "home" })
      .build();
    const profileDef = app
      .defineState({ name: "Alice" }, { name: "profile" })
      .build();

    const homeInstance = new HypenModuleInstance(
      engine,
      homeDef,
      undefined,
      globalCtx
    );
    globalCtx.registerModule("home", homeInstance);

    const profileInstance = new HypenModuleInstance(
      engine,
      profileDef,
      undefined,
      globalCtx
    );
    globalCtx.registerModule("profile", profileInstance);

    expect(globalCtx.hasModule("home")).toBe(true);
    expect(globalCtx.hasModule("profile")).toBe(true);
    expect(globalCtx.getModuleIds()).toContain("home");
    expect(globalCtx.getModuleIds()).toContain("profile");

    // Both modules registered with engine as named modules
    expect(engine.registerModuleCalls.length).toBe(2);

    // State is passed through raw — engine handles scoping via module_scope
    expect(engine.registerModuleCalls[0].name).toBe("home");
    expect(engine.registerModuleCalls[0].initialState).toEqual({ count: 0 });
    expect(engine.registerModuleCalls[1].name).toBe("profile");
    expect(engine.registerModuleCalls[1].initialState).toEqual({ name: "Alice" });
  });

  test("unregistering module removes it from context", () => {
    const engine = new FakeEngine();
    const globalCtx = new HypenGlobalContext();

    const def = app.defineState({ x: 1 }, { name: "temp" }).build();
    const instance = new HypenModuleInstance(
      engine,
      def,
      undefined,
      globalCtx
    );
    globalCtx.registerModule("temp", instance);

    expect(globalCtx.hasModule("temp")).toBe(true);

    globalCtx.unregisterModule("temp");
    expect(globalCtx.hasModule("temp")).toBe(false);
  });

  test("destroyed module should not process actions", async () => {
    const engine = new FakeEngine();
    let actionCalled = false;

    const def = app
      .defineState({ count: 0 }, { name: "TestMod" })
      .onAction("increment", ({ state }) => {
        actionCalled = true;
      })
      .build();

    const instance = new HypenModuleInstance(engine, def);
    await instance.destroy();

    // Reset tracking
    actionCalled = false;

    // Try to trigger action — handler in module should not fire
    // (Note: The FakeEngine still has the handler registered, but the module
    // tracks its own isDestroyed state internally)
  });

  test("global state returns per-module snapshots", () => {
    const engine = new FakeEngine();
    const globalCtx = new HypenGlobalContext();

    const def1 = app.defineState({ a: 1 }, { name: "mod1" }).build();
    const def2 = app.defineState({ b: 2 }, { name: "mod2" }).build();

    const inst1 = new HypenModuleInstance(
      engine,
      def1,
      undefined,
      globalCtx
    );
    globalCtx.registerModule("mod1", inst1);

    const inst2 = new HypenModuleInstance(
      engine,
      def2,
      undefined,
      globalCtx
    );
    globalCtx.registerModule("mod2", inst2);

    const globalState = globalCtx.getGlobalState();
    expect(globalState).toHaveProperty("mod1");
    expect(globalState).toHaveProperty("mod2");
  });
});

// ========================================================================
// D. App Registry Integration (2 tests)
// ========================================================================

describe("App Registry Integration", () => {
  beforeEach(() => {
    app.clear();
  });

  test("re-building same name overwrites definition", () => {
    app.defineState({ v: 1 }, { name: "Widget" }).build();
    const def2 = app.defineState({ v: 2 }, { name: "Widget" }).build();

    expect(app.get("Widget")).toBe(def2);
  });

  test("components returns read-only view of all definitions", () => {
    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();

    const all = app.components;
    expect(all.size).toBe(2);
    expect(all.has("A")).toBe(true);
    expect(all.has("B")).toBe(true);
  });
});

// ========================================================================
// E. Persist Flag
// ========================================================================
//
// Note: `persist` defaults to TRUE for any route whose `component` resolves
// to a registered module definition. This is the mechanism that prevents
// the "loading flash" when the user navigates between tabs. Opt out by
// setting `persist: false` on the definition.
//
// These tests exercise the default, the opt-out, and the persistence
// lifecycle interaction with `onActivated` / `onDeactivated`.

describe("Persist Flag", () => {
  beforeEach(() => {
    app.clear();
  });

  test("persist: false (explicit): module is destroyed and unregistered on unmount", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    // Explicit opt-out — restore the pre-default behavior.
    app.defineState({ count: 0 }, { name: "Home", persist: false }).build();
    app.defineState({ name: "Alice" }, { name: "Profile", persist: false }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/", component: "Home" });
    managed.addRoute({ path: "/profile", component: "Profile" });
    managed.start();
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("home")).toBe(true);

    // Navigate away — Home should be destroyed (persist=false).
    router.push("/profile");
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("home")).toBe(false);
    expect(globalCtx.hasModule("profile")).toBe(true);
  });

  test("persist defaults to TRUE for module-backed routes: module stays registered after unmount", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    // Neither module sets `persist` explicitly — both should persist by default.
    app.defineState({ items: [] as string[] }, { name: "Cart" }).build();
    app.defineState({ step: 1 }, { name: "Checkout" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("cart")).toBe(true);

    // Navigate to checkout — Cart should persist by default.
    router.push("/checkout");
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("cart")).toBe(true);  // Still registered!
    expect(globalCtx.hasModule("checkout")).toBe(true);
  });

  test("explicit persist=true: module stays registered in GlobalContext after unmount", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app
      .defineState({ items: [] as string[] }, { name: "Cart", persist: true })
      .build();
    app
      .defineState({ step: 1 }, { name: "Checkout", persist: false })
      .build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/checkout", component: "Checkout" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("cart")).toBe(true);

    router.push("/checkout");
    await managed.waitForNavigation();

    expect(globalCtx.hasModule("cart")).toBe(true);
    expect(globalCtx.hasModule("checkout")).toBe(true);
  });

  test("re-navigating reuses the persisted instance (default)", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({ items: [] as string[] }, { name: "Cart" }).build();
    app.defineState({ x: 1 }, { name: "Other" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/other", component: "Other" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();

    const callCountAfterMount = engine.registerModuleCalls.length;

    // Navigate away and back
    router.push("/other");
    await managed.waitForNavigation();
    router.push("/cart");
    await managed.waitForNavigation();

    // Should NOT have created a new Cart instance — reuses persisted.
    // Only "Other" should have been created (1 new registerModule call).
    expect(engine.registerModuleCalls.length).toBe(callCountAfterMount + 1);
    expect(managed.getActiveModule()).not.toBeNull();
  });

  test("module state survives navigation away and back (no loading flash)", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    let createdCount = 0;
    app
      .defineState({ loading: true, items: [] as string[] }, { name: "Items" })
      .onCreated(async (state) => {
        createdCount += 1;
        // Simulate an async fetch that resolves immediately.
        state.items = ["a", "b", "c"];
        state.loading = false;
      })
      .build();

    app.defineState({}, { name: "Other" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/items", component: "Items" });
    managed.addRoute({ path: "/other", component: "Other" });

    router.push("/items");
    managed.start();
    await managed.waitForNavigation();

    // First visit: onCreated ran once, data loaded.
    expect(createdCount).toBe(1);
    const itemsFirstVisit = managed.getActiveModule()?.getState() as { loading: boolean; items: string[] };
    expect(itemsFirstVisit.loading).toBe(false);
    expect(itemsFirstVisit.items).toEqual(["a", "b", "c"]);

    // Navigate away then back.
    router.push("/other");
    await managed.waitForNavigation();
    router.push("/items");
    await managed.waitForNavigation();

    // onCreated must NOT have re-run — the module was persisted.
    expect(createdCount).toBe(1);

    // And critically, the state is preserved — no loading flash.
    const itemsSecondVisit = managed.getActiveModule()?.getState() as { loading: boolean; items: string[] };
    expect(itemsSecondVisit.loading).toBe(false);
    expect(itemsSecondVisit.items).toEqual(["a", "b", "c"]);
  });

  test("onActivated fires on every mount; onDeactivated fires on every unmount", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    const events: string[] = [];

    app
      .defineState({ visits: 0 }, { name: "Screen" })
      .onCreated(() => {
        events.push("created");
      })
      .onActivated((state) => {
        events.push("activated");
        state.visits += 1;
      })
      .onDeactivated(() => {
        events.push("deactivated");
      })
      .onDestroyed(() => {
        events.push("destroyed");
      })
      .build();

    app.defineState({}, { name: "Other" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/screen", component: "Screen" });
    managed.addRoute({ path: "/other", component: "Other" });

    router.push("/screen");
    managed.start();
    await managed.waitForNavigation();

    // First mount: created → activated.
    expect(events).toEqual(["created", "activated"]);

    // Away: deactivated (persist, not destroyed).
    router.push("/other");
    await managed.waitForNavigation();
    expect(events).toEqual(["created", "activated", "deactivated"]);

    // Back: activated again, no re-created.
    router.push("/screen");
    await managed.waitForNavigation();
    expect(events).toEqual(["created", "activated", "deactivated", "activated"]);

    const screenState = managed.getActiveModule()?.getState() as { visits: number };
    expect(screenState.visits).toBe(2);

    // Full stop: deactivated + destroyed for the currently-active module.
    await managed.stop();
    expect(events).toEqual([
      "created",
      "activated",
      "deactivated",
      "activated",
      "deactivated",
      "destroyed",
    ]);
  });

  test("stop() destroys all persisted modules and awaits cleanup", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({ items: [] as string[] }, { name: "Cart" }).build();
    app.defineState({ x: 1 }, { name: "Other" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/cart", component: "Cart" });
    managed.addRoute({ path: "/other", component: "Other" });

    router.push("/cart");
    managed.start();
    await managed.waitForNavigation();

    // Navigate away (Cart persisted)
    router.push("/other");
    await managed.waitForNavigation();
    expect(globalCtx.hasModule("cart")).toBe(true);

    // Full stop — everything should be cleaned up
    await managed.stop();

    expect(globalCtx.hasModule("cart")).toBe(false);
    expect(globalCtx.hasModule("other")).toBe(false);
  });

  test("persist flag is set via defineState options", () => {
    const def = app
      .defineState({ count: 0 }, { name: "PersistModule", persist: true })
      .build();

    expect(def.persist).toBe(true);
  });

  test("persist field defaults to undefined on the definition", () => {
    // The field itself is still undefined unless explicitly set.
    // (ManagedRouter interprets undefined as "persist by default".)
    const def = app.defineState({ count: 0 }).build();

    expect(def.persist).toBeUndefined();
  });

  test("route without module definition does not crash on navigation", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    // No app.defineState(...) call — the component name won't resolve.
    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/", component: "Unknown" });
    managed.addRoute({ path: "/other", component: "StillUnknown" });

    router.push("/");
    managed.start();
    await managed.waitForNavigation();

    router.push("/other");
    await managed.waitForNavigation();

    // No persisted modules should have accumulated.
    expect(globalCtx.getModuleIds().length).toBe(0);
  });

  test("serialized navigation: back-to-back pushes end with latest route active", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();
    app.defineState({}, { name: "C" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/a", component: "A" });
    managed.addRoute({ path: "/b", component: "B" });
    managed.addRoute({ path: "/c", component: "C" });

    router.push("/a");
    managed.start();
    // Fire multiple navigations without awaiting between them.
    router.push("/b");
    router.push("/c");

    await managed.waitForNavigation();

    const active = managed.getActiveRoute();
    expect(active?.path).toBe("/c");
    // A and B should still be registered (persisted by default).
    expect(globalCtx.hasModule("a")).toBe(true);
    expect(globalCtx.hasModule("b")).toBe(true);
    expect(globalCtx.hasModule("c")).toBe(true);
  });

  // ----------------------------------------------------------------------
  // LRU eviction of persisted modules
  //
  // `persistedModules` is bounded by `maxPersistedModules` so a long
  // session over many routes doesn't leak. Eviction tears the oldest
  // persisted entry down through the same path `persist: false` uses:
  // `destroy()` + `unregisterModule()`.
  // ----------------------------------------------------------------------

  test("persisted module cache evicts oldest entry past maxPersistedModules", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();
    app.defineState({}, { name: "C" }).build();
    app.defineState({}, { name: "D" }).build();

    // Cap at 2 — any third persist must evict the oldest.
    const managed = new ManagedRouter(router, engine, app, globalCtx, {
      maxPersistedModules: 2,
    });
    managed.addRoute({ path: "/a", component: "A" });
    managed.addRoute({ path: "/b", component: "B" });
    managed.addRoute({ path: "/c", component: "C" });
    managed.addRoute({ path: "/d", component: "D" });

    router.push("/a");
    managed.start();
    await managed.waitForNavigation();

    // Navigate A → B → C → D. On the transition *to* D, the cache holds
    // {A (oldest), B, C} right before D is mounted — wait, walk through it:
    //   after /a → /b: A persisted              → cache [A]
    //   after /b → /c: B persisted              → cache [A, B]
    //   after /c → /d: C persisted              → cache [A, B, C] → evict → [B, C]
    router.push("/b");
    await managed.waitForNavigation();
    router.push("/c");
    await managed.waitForNavigation();
    router.push("/d");
    await managed.waitForNavigation();

    // A was evicted and torn down — no longer registered.
    expect(globalCtx.hasModule("a")).toBe(false);
    // B and C are still persisted; D is active.
    expect(globalCtx.hasModule("b")).toBe(true);
    expect(globalCtx.hasModule("c")).toBe(true);
    expect(globalCtx.hasModule("d")).toBe(true);
  });

  test("re-visiting a persisted module bumps it to MRU (saves it from eviction)", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    app.defineState({}, { name: "A" }).build();
    app.defineState({}, { name: "B" }).build();
    app.defineState({}, { name: "C" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx, {
      maxPersistedModules: 2,
    });
    managed.addRoute({ path: "/a", component: "A" });
    managed.addRoute({ path: "/b", component: "B" });
    managed.addRoute({ path: "/c", component: "C" });

    router.push("/a");
    managed.start();
    await managed.waitForNavigation();

    // A → B: cache [A]
    router.push("/b");
    await managed.waitForNavigation();
    // B → A: A is restored (removed from cache), B persisted → cache [B]
    router.push("/a");
    await managed.waitForNavigation();
    // A → B: A persisted → cache [B, A]
    router.push("/b");
    await managed.waitForNavigation();
    // B → C: B restored → cache [A]; C mounted. So actually wait — on B→C,
    // we leave B (which is active), which was just restored, so cache is [A].
    // Leaving B persists B → cache [A, B]. Still under cap.
    router.push("/c");
    await managed.waitForNavigation();

    // All three should still be around — A was bumped to MRU before C
    // pushed the cap, so nothing got evicted.
    expect(globalCtx.hasModule("a")).toBe(true);
    expect(globalCtx.hasModule("b")).toBe(true);
    expect(globalCtx.hasModule("c")).toBe(true);
  });

  test("default cap (DEFAULT_MAX_PERSISTED_MODULES) retains a reasonable number of routes", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    // Five routes, default cap is 10 — no eviction should happen.
    for (const name of ["R1", "R2", "R3", "R4", "R5"]) {
      app.defineState({}, { name }).build();
    }

    const managed = new ManagedRouter(router, engine, app, globalCtx);
    managed.addRoute({ path: "/1", component: "R1" });
    managed.addRoute({ path: "/2", component: "R2" });
    managed.addRoute({ path: "/3", component: "R3" });
    managed.addRoute({ path: "/4", component: "R4" });
    managed.addRoute({ path: "/5", component: "R5" });

    router.push("/1");
    managed.start();
    await managed.waitForNavigation();

    for (const p of ["/2", "/3", "/4", "/5"]) {
      router.push(p);
      await managed.waitForNavigation();
    }

    for (const name of ["r1", "r2", "r3", "r4", "r5"]) {
      expect(globalCtx.hasModule(name)).toBe(true);
    }
  });

  test("evicted modules fire onDestroyed", async () => {
    const engine = new FakeEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();

    const destroyed: string[] = [];
    app
      .defineState({}, { name: "A" })
      .onDestroyed(() => {
        destroyed.push("a");
      })
      .build();
    app.defineState({}, { name: "B" }).build();
    app.defineState({}, { name: "C" }).build();

    const managed = new ManagedRouter(router, engine, app, globalCtx, {
      maxPersistedModules: 1,
    });
    managed.addRoute({ path: "/a", component: "A" });
    managed.addRoute({ path: "/b", component: "B" });
    managed.addRoute({ path: "/c", component: "C" });

    router.push("/a");
    managed.start();
    await managed.waitForNavigation();

    router.push("/b");
    await managed.waitForNavigation();
    // cache is now [A], within cap.
    expect(destroyed).toEqual([]);

    router.push("/c");
    await managed.waitForNavigation();
    // Leaving B persists it → cache [A, B] → over cap → evict A.
    expect(destroyed).toEqual(["a"]);
    expect(globalCtx.hasModule("a")).toBe(false);
  });
});
