/**
 * Regression: server-based apps (modules registered programmatically via
 * `app.module("Name")...ui(hypen`...`)` with NO `.source()` discovery) must
 * resolve child component references like `Home()` from the HypenApp
 * registry. Before the fix the session resolver only consulted
 * `discoveredComponents`, so every `.ui()`-registered child rendered as an
 * opaque Create the renderer dropped ("Component did not resolve" warnings
 * on a freshly `hypen init`-ed server-based project).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/core/src/remote/remote-session";
import { app } from "../packages/core/src/app";

const APP_TEMPLATE = `module RegApp {
  Router {
    Route(path: "/") {
      RegHome()
    }
    Route(path: "/counter") {
      RegCounter()
    }
  }
}`;

function buildRegistryModules() {
  const appModule = app
    .defineState<{ location: string }>({ location: "/" })
    .onAction("navigate", ({ action, state }) => {
      const to = (action.payload as { to?: string } | undefined)?.to;
      if (to) state.location = to;
    })
    .ui(APP_TEMPLATE);

  app
    .module("RegHome")
    .defineState({ greeting: "Welcome to Hypen" })
    .onAction("tap", () => {})
    .ui(`module RegHome { Column { Text("@{state.greeting}") } }`);

  app
    .module("RegCounter")
    .defineState({ count: 0 })
    .onAction("increment", ({ state }) => {
      state.count += 1;
    })
    .ui(`module RegCounter { Column { Text("@{state.count}") } }`);

  return appModule;
}

describe("RemoteServer app-registry component resolution", () => {
  let server: RemoteServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    app.unregister("RegApp");
    app.unregister("RegHome");
    app.unregister("RegCounter");
  });

  test("resolves .ui()-registered modules without .source()", async () => {
    const appModule = buildRegistryModules();
    server = new RemoteServer()
      .app(app)
      .module("RegApp", appModule)
      .ui(APP_TEMPLATE);
    await server.prepare();

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });
    await session.receive({ type: "hello" } as any);
    await session.ready;

    expect(session.engine.getUnresolvedComponents()).toEqual([]);
    await session.destroy();
  });

});

describe("Auto-router state-driven navigation", () => {
  let server: RemoteServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    app.unregister("RegApp");
    app.unregister("RegHome");
    app.unregister("RegCounter");
  });

  // Regression: navigating by mutating `state.location` (the scaffold's
  // `@actions.navigate`) rendered the new route but never mounted its
  // module, so route-module actions like `increment` were dead.
  test("mounts route modules when state.location changes", async () => {
    const appModule = buildRegistryModules();
    server = new RemoteServer()
      .app(app)
      .module("RegApp", appModule)
      .ui(APP_TEMPLATE);
    await server.prepare();

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });

    const messages: any[] = [];
    (async () => {
      for await (const m of transport.stream()) messages.push(m);
    })();

    await session.receive({ type: "hello" } as any);
    await session.ready;
    await new Promise((r) => setTimeout(r, 100));

    await session.receive({
      type: "dispatchAction",
      action: "navigate",
      payload: { to: "/counter" },
    } as any);
    await new Promise((r) => setTimeout(r, 300));

    await session.receive({ type: "dispatchAction", action: "increment" } as any);
    await new Promise((r) => setTimeout(r, 300));

    // The increment must produce a patch updating the count Text to 1 —
    // proof the RegCounter module mounted and its handler ran.
    const patchMessages = messages.filter((m) => m.type === "patch");
    const countUpdate = patchMessages
      .flatMap((m) => m.patches)
      .find((p: any) => p.type === "setProp" && p.value === 1);
    expect(countUpdate).toBeDefined();

    await session.destroy();
  });
});
