/**
 * Hosted modules across sessions: prepare once / instantiate per session
 * (D2), storage owners (D3), lifecycle under ManagedRouter and crash
 * recovery (D4), effects (D6).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HypenApp } from "../packages/core/src/app";
import { RemoteServer } from "../packages/server/src/remote/server";
import { MemoryHostedStorage, wasmModule, type HostedModulesOptions } from "../packages/server/src/hosted";
import type { HostedModuleDefinition } from "../packages/core/src/hosted-module";
import {
  connect,
  eventually,
  failureLog,
  fixture,
  flush,
  hasFixtures,
  hasServerEngine,
} from "./hosted-modules-harness";

const skip =
  !hasServerEngine ||
  !hasFixtures("counter_module.wasm", "limits_module.wasm", "effects_module.wasm", "seeded_module.wasm");

const TALLY_UI = `Column {
  Text("Tally: @{state.count}")
  Button { Text("Tally +1") }.onClick(@actions.increment)
}`;

const tally = (extra: Partial<Parameters<typeof wasmModule>[0]> = {}): HostedModuleDefinition =>
  wasmModule({
    name: "Tally",
    component: fixture("counter_module.wasm"),
    ui: TALLY_UI,
    grants: { storage: ["cloud"] },
    ...extra,
  });

function serverWith(
  ui: string,
  modules: HostedModuleDefinition[],
  options: HostedModulesOptions = {},
  entryState: Record<string, unknown> = { ready: true }
) {
  const app = new HypenApp();
  const entry = app.module("App").defineState(entryState).ui(ui);
  const log = failureLog();
  const prepares: string[] = [];
  const server = new RemoteServer()
    .app(app)
    .module("App", entry)
    .wasmModules(modules)
    .hostedModules({
      onError: log.onError,
      // Count the expensive step: `prepareComponent` runs once per component.
      loadModuleHost: async () => {
        const pkg = await import("@hypen-space/module-host");
        return {
          ...pkg,
          prepareComponent: (name: string, bytes: Uint8Array) => {
            prepares.push(name);
            return pkg.prepareComponent(name, bytes);
          },
        };
      },
      ...options,
    });
  return { server, failures: log.failures, prepares };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(skip)("hosted modules: sessions and storage", () => {
  test("components are prepared once; concurrent sessions have separate instances and state", async () => {
    const { server, prepares, failures } = serverWith(`module App { Column { Tally {} } }`, [tally()]);
    await server.prepare();
    expect(prepares).toEqual(["tally"]);

    const a = await connect(server);
    const b = await connect(server);
    cleanups.push(() => a.close(), () => b.close());
    expect(prepares).toEqual(["tally"]);

    // Interleaved clicks on two live sessions.
    await a.click(a.button("Tally +1"), "increment");
    await b.click(b.button("Tally +1"), "increment");
    await a.click(a.button("Tally +1"), "increment");
    await a.click(a.button("Tally +1"), "increment");
    expect(a.state("tally")).toEqual({ count: 3 });
    expect(b.state("tally")).toEqual({ count: 1 });
    expect(a.texts()).toContain("Tally: 3");
    expect(b.texts()).toContain("Tally: 1");

    // The module persists its count in `local` storage and warm-starts from
    // it: a third session — a different owner by default — starts at zero.
    const c = await connect(server);
    cleanups.push(() => c.close());
    expect(c.state("tally")).toEqual({ count: 0 });
    expect(failures).toEqual([]);
  });

  test("default storage is private to the session and comes back when the session is resumed", async () => {
    const { server } = serverWith(`module App { Column { Tally {} } }`, [tally()]);
    await server.prepare();
    const first = await connect(server);
    await first.click(first.button("Tally +1"), "increment");
    await first.click(first.button("Tally +1"), "increment");
    const sessionId = first.session.sessionId!;
    await first.close();

    // Same session id (a reconnect): its own store, so the module warm-starts.
    const resumed = await connect(server, { sessionId });
    cleanups.push(() => resumed.close());
    expect(resumed.session.sessionId).toBe(sessionId);
    expect(resumed.state("tally")).toEqual({ count: 2 });
  });

  test("owner keys: different owners are isolated, the same owner shares and survives a new session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-hosted-storage-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const options: HostedModulesOptions = {
      storage: (session) => ({ key: String(session.props?.user ?? "anonymous") }),
      storageDir: dir,
    };
    const { server } = serverWith(`module App { Column { Tally {} } }`, [tally()], options);
    await server.prepare();

    const alice = await connect(server, { props: { user: "alice" } });
    const bob = await connect(server, { props: { user: "bob" } });
    await alice.click(alice.button("Tally +1"), "increment");
    await alice.click(alice.button("Tally +1"), "increment");
    await bob.click(bob.button("Tally +1"), "increment");
    expect(alice.state("tally")).toEqual({ count: 2 });
    expect(bob.state("tally")).toEqual({ count: 1 });
    await alice.close();
    await bob.close();

    // A brand-new session of the same owner starts from the owner's data.
    const aliceAgain = await connect(server, { props: { user: "alice" } });
    const carol = await connect(server, { props: { user: "carol" } });
    cleanups.push(() => aliceAgain.close(), () => carol.close());
    expect(aliceAgain.state("tally")).toEqual({ count: 2 });
    expect(carol.state("tally")).toEqual({ count: 0 });

    // One file pair per owner, named by a hash — the key never is a path.
    const files = readdirSync(dir).sort();
    expect(files.some((f) => f.includes("alice"))).toBe(false);
    expect(files.filter((f) => !f.endsWith(".cloud.json")).length).toBe(2);

    // ...and it survives the process: a second server over the same directory.
    const second = serverWith(`module App { Column { Tally {} } }`, [tally()], options);
    await second.server.prepare();
    const afterRestart = await connect(second.server, { props: { user: "alice" } });
    cleanups.push(() => afterRestart.close());
    expect(afterRestart.state("tally")).toEqual({ count: 2 });
  });

  test("an app-provided backend is used as given (shared only when the app shares it)", async () => {
    const shared = new MemoryHostedStorage();
    const { server } = serverWith(`module App { Column { Tally {} } }`, [tally()], {
      storage: (session) => (session.props?.team === "red" ? shared : new MemoryHostedStorage()),
    });
    await server.prepare();
    const one = await connect(server, { props: { team: "red" } });
    await one.click(one.button("Tally +1"), "increment");
    const two = await connect(server, { props: { team: "red" } });
    const other = await connect(server, { props: { team: "blue" } });
    cleanups.push(() => one.close(), () => two.close(), () => other.close());
    expect(two.state("tally")).toEqual({ count: 1 });
    expect(other.state("tally")).toEqual({ count: 0 });
  });

  test("init config comes from the declaration", async () => {
    const seeded = wasmModule({
      name: "Seeded",
      component: fixture("seeded_module.wasm"),
      ui: `Text("Seeded: @{state.count}")`,
      config: { start: 7 },
    });
    const { server } = serverWith(`module App { Column { Seeded {} } }`, [seeded]);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    expect(client.state("seeded")).toEqual({ count: 7 });
    expect(client.texts()).toContain("Seeded: 7");
  });
});

describe.skipIf(skip)("hosted modules: lifecycle and crash recovery", () => {
  const ROUTED_UI = `module App {
  Column {
    Button { Text("Go tally") }.onClick(@router.push, to: "/tally")
    Button { Text("Go home") }.onClick(@router.push, to: "/")
    Router {
      Route(path: "/") { Home {} }
      Route(path: "/tally") { Tally {} }
    }
  }
}`;

  /** A server whose `/tally` route is the hosted module; engine lifecycle calls are recorded per session. */
  async function routed(persist: boolean) {
    const app = new HypenApp();
    const entry = app.module("App").defineState({ location: "/" }).ui(ROUTED_UI);
    app.module("Home").defineState({ title: "home" }).ui(`Text("Home")`);
    const log = failureLog();
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(tally(persist ? {} : { persist: false }))
      .hostedModules({ onError: log.onError });
    const calls: string[] = [];
    server.onSessionCreate((session) => {
      const engine = session.engine as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ["registerHostedModule", "activateHostedModule", "deactivateHostedModule", "destroyHostedModule"]) {
        const original = engine[method]!.bind(engine);
        engine[method] = (...args: unknown[]) => {
          calls.push(`${method.replace("HostedModule", "")}:${String(args[0])}`);
          return original(...args);
        };
      }
    });
    await server.prepare();
    const client = await connect(server);
    // What a renderer sends for `.onClick(@router.push, to: ...)`.
    const go = async (label: string) => {
      const to = label === "Go tally" ? "/tally" : "/";
      await client.send("router.push", { to });
      await eventually(() => expect(client.state("app").location).toBe(to));
      await flush(30);
    };
    return { server, client, calls, go, failures: log.failures };
  }

  test("route activation maps to activate/deactivate; a persisted module keeps its instance", async () => {
    const { client, calls, go, failures } = await routed(true);
    cleanups.push(() => client.close());
    expect(calls).toEqual([]); // not mounted until its route is visited

    await go("Go tally");
    expect(calls).toEqual(["register:tally", "activate:tally"]);
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 1 });

    await go("Go home");
    await go("Go tally");
    expect(calls).toEqual([
      "register:tally",
      "activate:tally",
      "deactivate:tally",
      "activate:tally",
    ]);
    // Same instance: state kept without going through storage.
    expect(client.state("tally")).toEqual({ count: 1 });

    await client.close();
    expect(calls.slice(4)).toEqual(["deactivate:tally", "destroy:tally"]);
    expect(failures).toEqual([]);
  });

  test("persist: false destroys the module on leaving the route and starts a fresh one on return", async () => {
    const { client, calls, go } = await routed(false);
    cleanups.push(() => client.close());
    await go("Go tally");
    await go("Go home");
    expect(calls).toEqual(["register:tally", "activate:tally", "deactivate:tally", "destroy:tally"]);
    expect((client.session as any)._globalContext.hasModule("tally")).toBe(false);
    await go("Go tally");
    expect(calls.slice(4)).toEqual(["register:tally", "activate:tally"]);
  });

  test("a crashed instance fails that action, is reported, and is re-instantiated on its next use", async () => {
    const limits = wasmModule({
      name: "Limits",
      component: fixture("limits_module.wasm"),
      ui: `Column {
  Text("Limits: @{state.count}")
  Button { Text("Trap") }.onClick(@actions.trap)
  Button { Text("Noop") }.onClick(@actions.noop)
}`,
      grants: { storage: ["app"] },
    });
    const { server, failures } = serverWith(`module App { Column { Limits {} Tally {} } }`, [limits, tally()]);
    await server.prepare();
    const client = await connect(server);
    const bystander = await connect(server);
    cleanups.push(() => client.close(), () => bystander.close());

    await client.click(client.button("Tally +1"), "increment");
    await client.click(client.button("Trap"), "trap");
    await flush();
    // The failing action surfaced as structured failures: the crash, and the action that hit it.
    expect(failures.map((f) => f.kind)).toContain("crash");
    const crash = failures.find((f) => f.kind === "crash")!;
    expect(crash).toMatchObject({ module: "Limits", scope: "limits" });
    expect(crash.message).toMatch(/trapped/);
    expect(failures.every((f) => f.sessionId === client.session.sessionId)).toBe(true);

    // The same module on another session is unaffected (its own instance).
    await bystander.click(bystander.button("Noop"), "noop");
    await bystander.click(bystander.button("Tally +1"), "increment");
    expect(bystander.state("tally")).toEqual({ count: 1 });
    expect(failures.filter((f) => f.sessionId === bystander.session.sessionId)).toEqual([]);

    // The session's next action: a fresh instance (state reset to init),
    // logged as recovered — and the action itself runs on it.
    failures.length = 0;
    await client.click(client.button("Noop"), "noop");
    await flush();
    expect(failures.map((f) => f.kind)).toEqual(["recovered"]);
    expect(failures[0]!.message).toMatch(/state was reset/);
    expect(client.state("limits")).toEqual({ count: 0 });
    // Other modules of the session never noticed.
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 2 });
    // ...and it keeps working afterwards.
    failures.length = 0;
    await client.click(client.button("Noop"), "noop");
    await flush();
    expect(failures).toEqual([]);
  });
});

describe.skipIf(skip)("hosted modules: effects", () => {
  const EFFECTS_UI = `Column {
  Text("Ticks: @{state.count}")
  Button { Text("Go") }.onClick(@actions.go)
  Button { Text("Debounce") }.onClick(@actions.debounce)
}`;
  const effects = () =>
    wasmModule({ name: "Effects", component: fixture("effects_module.wasm"), ui: EFFECTS_UI });

  test("navigate goes to the session's router", async () => {
    const app = new HypenApp();
    const entry = app
      .module("App")
      .defineState({ location: "/" })
      .ui(`module App {
  Column {
    Effects {}
    Router {
      Route(path: "/") { Text("Home page") }
      Route(path: "/next") { Text("Next page") }
    }
  }
}`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(effects());
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    expect(client.texts()).toContain("Home page");

    await client.click(client.button("Go"), "go");
    await eventually(() => expect(client.state("app").location).toBe("/next"));
    await eventually(() => expect(client.texts()).toContain("Next page"));
  });

  test("navigate without a router is reported, not thrown", async () => {
    const { server, failures } = serverWith(`module App { Column { Effects {} } }`, [effects()]);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Go"), "go");
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "effect", module: "Effects" });
    expect(failures[0]!.message).toMatch(/no router/);
  });

  test("delay dispatches `then` to the module later; pending delays are capped and cleared on session end", async () => {
    const { server, failures } = serverWith(`module App { Column { Effects {} } }`, [effects()], {
      maxPendingDelays: 3,
    });
    await server.prepare();
    const client = await connect(server);
    const runtime = client.session.hostedModules as unknown as { pendingDelays(scope: string): number };

    await client.click(client.button("Debounce"), "debounce");
    expect(client.state("effects")).toEqual({ count: 0 });
    expect(runtime.pendingDelays("effects")).toBe(1);
    await eventually(() => expect(client.state("effects")).toEqual({ count: 1 }));
    expect(client.texts()).toContain("Ticks: 1");
    expect(runtime.pendingDelays("effects")).toBe(0);

    // Cap: the 4th pending delay is dropped and reported.
    for (let i = 0; i < 4; i++) await client.session.receive({
      type: "dispatchAction",
      module: "App",
      action: "__hypen_dispatch",
      payload: { node: client.button("Debounce"), action: "debounce", payload: {} },
    } as never);
    await flush(5);
    expect(runtime.pendingDelays("effects")).toBe(3);
    expect(failures.filter((f) => f.kind === "effect")).toHaveLength(1);
    expect(failures[0]!.message).toMatch(/3 pending delays/);

    // Session end cancels what is pending: no tick lands afterwards.
    await client.close();
    expect(runtime.pendingDelays("effects")).toBe(0);
    await flush(200);
  });
});
