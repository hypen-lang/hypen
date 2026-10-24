/**
 * Regression: the canonical TypeScript server snippet (README "What It Looks
 * Like", landing page, docs Remote App page, TS SDK Quick Start) must run as
 * written. Each case below was a first-run blocker:
 *
 *   - `.ui(tpl).build()` threw because `.ui()` already returns the built
 *     definition (no `build` on it);
 *   - `new RemoteServer().app(myApp)` threw "Module not set";
 *   - `.module(name, def)` ignored `def.template` ("UI not set");
 *   - a NAMED module (`myApp.module("Counter")…`) served as the entry
 *     rendered a literal `@{state.count}` and dropped its actions, because
 *     it was mounted in the engine's named slot while the unwrapped template
 *     binds against the primary slot;
 *   - an unbuilt builder passed to `.module()` / `serve()` crashed in
 *     `setModule` (`array.length`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RemoteServer, serve } from "./server.ts";
import { AsyncQueueTransport } from "./session.ts";
import { HypenApp, resolveModuleDefinition } from "@hypen-space/core/app";

const COUNTER_UI = `
    Column {
      Text("Count: @{state.count}")
      Button("@actions.increment") { Text("+") }
    }
  `;

/** The README snippet's module, on a fresh registry. */
function readmeApp(): HypenApp {
  const myApp = new HypenApp();
  myApp
    .module("Counter")
    .defineState<{ count: number }>({ count: 0 })
    .onAction("increment", ({ state }) => {
      state.count += 1;
    })
    .onAction<{ amount: number }>("add", ({ action, state }) => {
      state.count += action.payload?.amount ?? 0;
    })
    .ui(COUNTER_UI)
    .build();
  return myApp;
}

const servers: RemoteServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

/** Prepare `server`, open one in-process session, return a text reader + dispatch. */
async function connect(server: RemoteServer) {
  servers.push(server);
  await server.prepare();
  const transport = new AsyncQueueTransport();
  const messages: any[] = [];
  void (async () => {
    for await (const m of transport.stream()) messages.push(m);
  })();
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello" } as any);
  await session.ready;
  await new Promise((r) => setTimeout(r, 20));

  // Track the latest text per node id across the initial tree and patches.
  const texts = () => {
    const byId = new Map<string, string>();
    for (const m of messages) {
      const patches = m.type === "initialTree" || m.type === "patch" ? m.patches : [];
      for (const p of patches) {
        if (p.type === "create" && p.elementType === "Text") byId.set(p.id, String(p.props["0"]));
        if (p.type === "setProp" && p.name === "0" && byId.has(p.id)) byId.set(p.id, String(p.value));
      }
    }
    return [...byId.values()];
  };
  const dispatch = async (action: string, payload?: unknown) => {
    await session.receive({ type: "dispatchAction", action, payload } as any);
    await new Promise((r) => setTimeout(r, 20));
  };
  return { session, messages, texts, dispatch };
}

describe("RemoteServer entry module", () => {
  test("README snippet: .app(myApp) alone serves the only (named) module", async () => {
    const { session, texts, dispatch } = await connect(new RemoteServer().app(readmeApp()));
    expect(texts()).toContain("Count: 0");
    await dispatch("increment");
    expect(texts()).toContain("Count: 1");
    await dispatch("add", { amount: 5 });
    expect(texts()).toContain("Count: 6");
    await session.destroy();
  });

  test(".module(name, def) uses def.template when no .ui()/.source()", async () => {
    const def = new HypenApp()
      .defineState({ count: 0 })
      .onAction("increment", ({ state }) => {
        state.count += 1;
      })
      .ui(COUNTER_UI);
    const { session, texts, dispatch } = await connect(new RemoteServer().module("Counter", def));
    expect(texts()).toContain("Count: 0");
    await dispatch("increment");
    expect(texts()).toContain("Count: 1");
    await session.destroy();
  });

  test("named module as the explicit primary resolves state and actions", async () => {
    const myApp = readmeApp();
    const def = myApp.get("Counter")!;
    for (const ui of [COUNTER_UI, `module Counter { ${COUNTER_UI} }`]) {
      const server = new RemoteServer().app(myApp).module("Counter", def).ui(ui);
      const { session, texts, dispatch } = await connect(server);
      expect(texts()).toContain("Count: 0");
      expect(texts().some((t) => t.includes("@{"))).toBe(false);
      await dispatch("increment");
      expect(texts()).toContain("Count: 1");
      await session.destroy();
    }
  });

  test(".app() picks the module named App among several", async () => {
    const myApp = readmeApp();
    myApp.module("App").defineState({ title: "home" }).ui(`Column { Text("@{state.title}") }`);
    const server = new RemoteServer().app(myApp);
    const { session, texts } = await connect(server);
    expect(texts()).toEqual(["home"]);
    await session.destroy();
  });

  test(".app() with several modules and no App is a clear error", async () => {
    const myApp = readmeApp();
    myApp.module("Other").defineState({}).ui(`Text("x")`);
    await expect(new RemoteServer().app(myApp).prepare()).rejects.toThrow(/ambiguous \(Counter, Other\)/);
  });

  test("no module, app or source still fails fast", async () => {
    await expect(new RemoteServer().prepare()).rejects.toThrow(/Module not set/);
  });

  test(".app(myApp).source(dir) takes the template from discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-entry-"));
    try {
      mkdirSync(join(dir, "Counter"));
      writeFileSync(
        join(dir, "Counter", "component.hypen"),
        `Column { Text("Disc: @{state.count}") Button("@actions.increment") { Text("+") } }`
      );
      const myApp = new HypenApp();
      myApp
        .module("Counter")
        .defineState({ count: 0 })
        .onAction("increment", ({ state }) => {
          state.count += 1;
        })
        .build();
      const { session, texts, dispatch } = await connect(
        new RemoteServer().app(myApp).source(dir)
      );
      expect(texts()).toContain("Disc: 0");
      await dispatch("increment");
      expect(texts()).toContain("Disc: 1");
      await session.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("module definition contract", () => {
  test(".ui(tpl).build() is a no-op returning the same definition", () => {
    const def = new HypenApp().defineState({ n: 1 }).ui(`Text("x")`);
    expect(def.build()).toBe(def);
    expect(def.build().template).toBe(`Text("x")`);
    // Not part of the data: spreads / JSON never carry it.
    expect(Object.keys(def)).not.toContain("build");
    expect(JSON.stringify({ ...def, handlers: undefined })).not.toContain("build");
  });

  test("resolveModuleDefinition builds a builder and passes a definition through", () => {
    const myApp = new HypenApp();
    const builder = myApp.module("Lazy").defineState({ n: 1 }).onAction("go", () => {});
    const def = resolveModuleDefinition(builder);
    expect(def.actions).toEqual(["go"]);
    expect(myApp.has("Lazy")).toBe(true);
    expect(resolveModuleDefinition(def)).toBe(def);
  });

  test(".module() accepts an unbuilt builder", async () => {
    const builder = new HypenApp()
      .defineState({ count: 0 })
      .onAction("increment", ({ state }) => {
        state.count += 1;
      });
    const server = new RemoteServer().module("Counter", builder).ui(COUNTER_UI);
    const { session, texts, dispatch } = await connect(server);
    expect(texts()).toContain("Count: 0");
    await dispatch("increment");
    expect(texts()).toContain("Count: 1");
    await session.destroy();
  });

  test("serve() accepts an unbuilt builder", async () => {
    const builder = new HypenApp().defineState({ count: 0 });
    const server = await serve({ module: builder, ui: COUNTER_UI, port: 4651, hostname: "127.0.0.1" });
    servers.push(server);
    const res = await fetch("http://127.0.0.1:4651/health");
    expect(res.status).toBe(200);
  });
});
