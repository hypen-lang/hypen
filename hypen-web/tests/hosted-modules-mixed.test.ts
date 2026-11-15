/**
 * A TypeScript app with hosted (WASM-component) modules, through the real
 * server + session path (D1, D5, D7):
 *
 *   client message -> RemoteSession.receive -> strict client-action
 *   admission -> engine -> hosted subsystem -> the session's JsModuleHost
 *   -> component
 *
 * `App` (entry) and `Counter` are in-process TypeScript modules; `Tally`
 * (counter_module.wasm) and `Mirror` (mirror_module.wasm, cross-module
 * against a sibling named "counter") are hosted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { HypenApp } from "../packages/core/src/app";
import { RemoteServer } from "../packages/server/src/remote/server";
import { wasmModule } from "../packages/server/src/hosted";
import {
  connect,
  eventually,
  failureLog,
  fixture,
  flush,
  hasFixtures,
  hasServerEngine,
} from "./hosted-modules-harness";

const skip = !hasServerEngine || !hasFixtures("counter_module.wasm", "mirror_module.wasm");

const APP_UI = `module App {
  Column {
    Text("Checkouts: @{state.checkouts}")
    Button { Text("Checkout") }.onClick(@actions.checkout)
    Button { Text("Ask mirror") }.onClick(@actions.askMirror)
    Counter {}
    Tally {}
    Mirror {}
  }
}`;

const COUNTER_UI = `Column {
  Text("Counter: @{state.count}")
  Button { Text("+1") }.onClick(@actions.increment)
}`;

const TALLY_UI = `Column {
  Text("Tally: @{state.count}")
  Button { Text("Tally +1") }.onClick(@actions.increment)
}`;

const MIRROR_UI = `Column {
  Text("Seen: @{state.seen}")
  Button { Text("Pull") }.onClick(@actions.pull)
  Button { Text("Bump") }.onClick(@actions.bump)
}`;

interface Delivered {
  sender: string | undefined;
  payload: unknown;
  /** What the handler read from the hosted module synchronously. */
  mirrorSeen: unknown;
}

function buildServer(extra: { mirrorGrants?: { reads?: string[]; dispatches?: string[] } } = {}) {
  const app = new HypenApp();
  const delivered: Delivered[] = [];
  const log = failureLog();

  const entry = app
    .module("App")
    .defineState({ checkouts: 0, lastTally: -1 })
    .onAction("checkout", async ({ state, context }) => {
      // Synchronously, inside the engine's dispatch: read a hosted
      // module's state and dispatch to it (deferred by the reference).
      const tally = context.getModule<{ count: number }>("tally");
      state.lastTally = tally.getState().count;
      state.checkouts += 1;
      await tally.dispatch("increment");
    })
    .onAction("askMirror", async ({ context }) => {
      await context.getModule("mirror").dispatch("pull");
    })
    .ui(APP_UI);

  app
    .module("Counter")
    .defineState({ count: 10 })
    .onAction("increment", ({ action, state, context }) => {
      delivered.push({
        sender: action.sender,
        payload: action.payload,
        mirrorSeen: context.hasModule("mirror") ? context.getModule("mirror").getState().seen : undefined,
      });
      state.count += 1;
    })
    .ui(COUNTER_UI);

  const server = new RemoteServer()
    .app(app)
    .module("App", entry)
    .wasmModules(
      wasmModule({
        name: "Tally",
        component: fixture("counter_module.wasm"),
        ui: TALLY_UI,
        grants: { storage: ["cloud"] },
      }),
      wasmModule({
        name: "Mirror",
        component: fixture("mirror_module.wasm"),
        ui: MIRROR_UI,
        grants: extra.mirrorGrants ?? { reads: ["Counter"], dispatches: ["Counter"] },
      })
    )
    .hostedModules({ onError: log.onError });
  return { server, delivered, failures: log.failures };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(skip)("hosted + TypeScript modules through RemoteServer", () => {
  test("a hosted module renders in a TS module's template and its button reaches the component", async () => {
    const { server, failures } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    expect(client.texts()).toEqual(
      expect.arrayContaining(["Checkouts: 0", "Counter: 10", "Tally: 0", "Seen: 0"])
    );
    expect(server.hostedModuleNames).toEqual(["Tally", "Mirror"]);

    // A real client click: an envelope on the node that declares the action.
    await client.click(client.button("Tally +1"), "increment");
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 2 });
    expect(client.texts()).toContain("Tally: 2");

    // The same action name on the TS module's own button goes to the TS handler.
    await client.click(client.button("+1"), "increment");
    expect(client.state("counter").count).toBe(11);
    expect(client.state("tally").count).toBe(2);
    expect(failures).toEqual([]);
  });

  test("strict admission holds for hosted modules: forged names never reach the component", async () => {
    const { server } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    // A pre-scoped name, a bare name, and an envelope on a node that does
    // not declare the action are all refused before the engine dispatches.
    await client.send("__hypen_scoped:tally:increment", {});
    await client.send("increment", {});
    await client.click(client.node("Tally: "), "increment");
    // `sync` is an action of the component no node declares.
    await client.click(client.button("Tally +1"), "sync");
    expect(client.state("tally")).toEqual({ count: 0 });
  });

  test("TS -> hosted: a handler reads hosted state and dispatches through context.getModule", async () => {
    const { server, failures } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    await client.click(client.button("Tally +1"), "increment");
    await client.click(client.button("Checkout"), "checkout");
    await eventually(() => expect(client.state("tally").count).toBe(2));
    // Read synchronously inside the handler: the value before its own dispatch.
    expect(client.state("app")).toMatchObject({ checkouts: 1, lastTally: 1 });
    expect(client.texts()).toEqual(expect.arrayContaining(["Checkouts: 1", "Tally: 2"]));

    const ref = (client.session as any)._globalContext.getModule("tally");
    expect(ref.kind).toBe("hosted");
    expect(Object.isFrozen(ref.state)).toBe(true);
    expect(() => ref.setState({ count: 99 })).toThrow(/hosted \(WASM\) module/);
    await expect(ref.dispatch("nope")).rejects.toMatchObject({ code: "actionNotAccepted" });
    await flush();
    expect(failures.map((f) => [f.kind, f.module, f.action])).toEqual([["action", "Tally", "nope"]]);
  });

  test("hosted -> TS: a granted cross-dispatch lands in the ordinary onAction handler with a sender", async () => {
    const { server, delivered, failures } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    await client.click(client.button("Bump"), "bump");
    await eventually(() => expect(client.state("counter").count).toBe(11));
    expect(delivered).toEqual([{ sender: "mirror", payload: {}, mirrorSeen: 0 }]);
    expect(client.texts()).toContain("Counter: 11");

    // A UI click on the TS module's own button has no sender.
    await client.click(client.button("+1"), "increment");
    expect(delivered[1]!.sender ?? null).toBeNull();
    expect(failures).toEqual([]);
  });

  test("hosted reads TS state under a grant, and follows it through a subscription", async () => {
    const { server, failures } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    // `pull` reads counter.count; on_activated subscribed Mirror to it.
    await client.click(client.button("Pull"), "pull");
    expect(client.state("mirror").seen).toBe(10);
    await client.click(client.button("+1"), "increment");
    await eventually(() => expect(client.state("mirror").seen).toBe(11));
    expect(client.texts()).toEqual(expect.arrayContaining(["Counter: 11", "Seen: 11"]));

    // TS -> hosted by reference, from a handler.
    await client.click(client.button("+1"), "increment");
    await client.click(client.button("Ask mirror"), "askMirror");
    await eventually(() => expect(client.state("mirror").seen).toBe(12));
    expect(failures).toEqual([]);
  });

  test("a hosted action failing mid-cascade is reported with the missing grant, and the app keeps running", async () => {
    const { server, failures, delivered } = buildServer({ mirrorGrants: { reads: ["Counter"] } });
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    await client.click(client.button("Bump"), "bump");
    await flush();
    expect(delivered).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ module: "Mirror", scope: "mirror", action: "bump" });
    expect(failures[0]!.hint).toMatch(/dispatches/);
    expect(failures[0]!.report).toBeDefined();

    // Everything else still works.
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally").count).toBe(1);
    await client.click(client.button("Pull"), "pull");
    expect(client.state("mirror").seen).toBe(10);
  });

  test("module-state subscribers and snapshots see hosted modules", async () => {
    const { server } = buildServer();
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    await client.click(client.button("Tally +1"), "increment");
    expect(client.session.moduleStates()).toMatchObject({
      app: { checkouts: 0 },
      counter: { count: 10 },
      tally: { count: 1 },
      mirror: { seen: 0 },
    });
    expect(client.session.takeSnapshot().modules).toMatchObject({ tally: { count: 1 } });
  });
});
