/**
 * Device Capability Protocol — background lifetime and LRU pin caps
 * (RFC 001 §2.7).
 *
 * Under the real v1 registry no revision lists `background`, so a background
 * request fails locally `unsupported`. With a broker configured with a
 * revision override that allows it (the Rust broker, through the port), the
 * owner becomes `{moduleInstanceId}`: the work survives
 * `deactivate()`, is swept on `destroy()`, pins the module against
 * `ManagedRouter` LRU eviction — within a hard cap — and the eviction loop
 * terminates when every candidate is pinned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import { ManagedRouter } from "../packages/core/src/managed-router";
import { HypenRouter } from "../packages/core/src/router";
import { HypenGlobalContext } from "../packages/core/src/context";
import type { Action } from "../packages/core/src/types";
import {
  DeviceContext,
  type DeviceRequest,
  type DeviceResult,
} from "@hypen-space/core/remote/device";
import { makePlane } from "./device-srv-harness";

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
  async dispatch(moduleKey: string, action: string) {
    await this.actionHandlers.get(`__hypen_scoped:${moduleKey}:${action}`)!({ name: action });
  }
}

const params = { mediaTypes: ["photo"], maxCount: 1 };

/** The Rust broker with gallery.pick@1 allowing `background` (owners register by activation). */
function makeBroker(opts: { background?: boolean; owners?: Array<[string, number]> } = {}) {
  const h = makePlane({
    owners: opts.owners ?? [],
    ...(opts.background === false
      ? {}
      : {
          config: {
            revisionOverrides: [{ capability: "gallery.pick", version: 1, lifetimes: ["activation", "background"] }],
          },
        }),
  });
  return { broker: h.plane, sent: h.sent };
}

const backgroundOwners = (broker: ReturnType<typeof makeBroker>["broker"]) => new Set(broker.info()!.backgroundOwners);

/** App requests (the connection-owned core.capabilities stream excluded). */
const requests = (sent: any[]) =>
  sent.filter((m): m is DeviceRequest => m.type === "deviceRequest" && m.capability !== "core.capabilities");
const cancelled = (sent: any[], id: number) =>
  sent.some((m) => m.type === "deviceEvent" && m.id === id && "cancel" in ((m as { control?: object }).control ?? {}));
const appLive = (broker: ReturnType<typeof makeBroker>["broker"]) => broker.liveCount - 1;

/** A module whose `bg` action opens a background gallery.pick. */
function bgModule(name: string, results: Array<Promise<DeviceResult<unknown>>>) {
  return app
    .defineState({ n: 0 }, { name })
    .onAction("bg", ({ context }) => {
      results.push(context!.device.request("gallery.pick", params, { lifetime: "background" }));
    })
    .build();
}

beforeEach(() => {
  app.clear();
});

describe("background lifetime under the real v1 registry", () => {
  test("refused locally with unsupported and a clear platformDetail; nothing sent", async () => {
    const { broker, sent } = makeBroker({ background: false, owners: [["m1", 1]] });
    const ctx = new DeviceContext(broker, { moduleInstanceId: "m1", activationId: 1 }, "origin");
    for (const cap of ["gallery.pick", "mic.record"]) {
      const res = await ctx.requestUntyped(cap, {}, { lifetime: "background" });
      expect(res).toEqual({
        ok: false,
        error: {
          code: "unsupported",
          platformDetail: `lifetime "background" is not allowed by ${cap} v1`,
        },
      });
    }
    // App code cannot claim the protocol-internal connection lifetime either.
    const conn = await ctx.request("gallery.pick", params, { lifetime: "connection" });
    expect(conn.ok).toBe(false);
    if (!conn.ok) expect(conn.error.code).toBe("unsupported");
    expect(requests(sent).length).toBe(0);
  });
});

describe("background lifetime with an injected registry", () => {
  test("owner is the module instance; survives deactivate(); swept on destroy()", async () => {
    const { broker, sent } = makeBroker();
    const engine = new RecordingEngine();
    const results: Array<Promise<DeviceResult<unknown>>> = [];
    const instance = new HypenModuleInstance(engine as never, bgModule("Player", results));
    instance.attachDevice(broker);
    await instance.activate();
    await engine.dispatch("player", "bg");

    const [req] = requests(sent);
    expect(req!.lifetime).toBe("background");
    expect(req!.owner).toEqual({ moduleInstanceId: instance.deviceInstanceId });
    expect(instance.hasLiveBackgroundDeviceWork).toBe(true);

    await instance.deactivate();
    expect(appLive(broker)).toBe(1);
    expect(cancelled(sent, req!.id)).toBe(false);
    expect(instance.hasLiveBackgroundDeviceWork).toBe(true);

    await instance.destroy();
    expect(cancelled(sent, req!.id)).toBe(true);
    expect(await results[0]).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(instance.hasLiveBackgroundDeviceWork).toBe(false);
  });

  test("activation work is still swept on deactivate while background work survives", async () => {
    const { broker } = makeBroker();
    const engine = new RecordingEngine();
    let fg!: Promise<DeviceResult<unknown>>;
    let bg!: Promise<DeviceResult<unknown>>;
    const def = app
      .defineState({}, { name: "Mixed" })
      .onAction("go", async ({ context }) => {
        fg = context!.device.request("gallery.pick", params);
        bg = context!.device.request("gallery.pick", params, { lifetime: "background" });
        // The handler consumes its activation-owned result (an unawaited
        // one would be cancelled when the handler returns, RFC 001 §2.4).
        await fg;
      })
      .build();
    const instance = new HypenModuleInstance(engine as never, def);
    instance.attachDevice(broker);
    await instance.activate();
    const dispatched = engine.dispatch("mixed", "go");
    await Promise.resolve();
    expect(appLive(broker)).toBe(2);
    await instance.deactivate();
    expect(await fg).toEqual({ ok: false, error: { code: "cancelled" } });
    await dispatched;
    expect(appLive(broker)).toBe(1);
    await instance.destroy();
    expect(await bg).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  test("pin cap: a third module's background request is refused throttled", async () => {
    const { broker, sent } = makeBroker({ owners: [["a", 1], ["b", 1], ["c", 1]] });
    const mk = (id: string) => new DeviceContext(broker, { moduleInstanceId: id, activationId: 1 }, "origin");
    void mk("a").request("gallery.pick", params, { lifetime: "background" });
    void mk("b").request("gallery.pick", params, { lifetime: "background" });
    const third = await mk("c").request("gallery.pick", params, { lifetime: "background" });
    expect(third).toEqual({
      ok: false,
      error: { code: "throttled", platformDetail: "background pin cap reached (2 modules)" },
    });
    // An already-pinned module may add work; activation work is unaffected.
    void mk("a").request("gallery.pick", params, { lifetime: "background" });
    void mk("c").request("gallery.pick", params);
    expect(requests(sent).length).toBe(4);
    expect(backgroundOwners(broker)).toEqual(new Set(["a", "b"]));
    broker.close();
  });
});

describe("ManagedRouter LRU pinning", () => {
  function setup(opts: { maxPinnedModules?: number } = {}) {
    const { broker, sent } = makeBroker();
    const engine = new RecordingEngine();
    const router = new HypenRouter();
    const globalCtx = new HypenGlobalContext();
    const results: Array<Promise<DeviceResult<unknown>>> = [];
    for (const name of ["One", "Two", "Three", "Four"]) bgModule(name, results);
    const managed = new ManagedRouter(router, engine as never, app, globalCtx, {
      maxPersistedModules: 1,
      ...opts,
      onModuleCreated: (instance) => instance.attachDevice(broker),
    });
    for (const name of ["One", "Two", "Three", "Four"]) {
      managed.addRoute({ path: `/${name.toLowerCase()}`, component: name });
    }
    const go = async (path: string) => {
      router.push(path);
      await managed.waitForNavigation();
    };
    return { broker, sent, engine, router, managed, results, go };
  }

  test("a module with live background work is skipped by eviction", async () => {
    const { broker, engine, managed, router, go } = setup();
    router.push("/one");
    managed.start();
    await managed.waitForNavigation();
    await engine.dispatch("one", "bg"); // One pins itself
    await go("/two");
    await go("/three"); // cache [one(pinned), two] > 1 → evict two, not one
    expect(engine.unregistered).toEqual(["two"]);
    expect(appLive(broker)).toBe(1);
    await managed.stop();
    expect(appLive(broker)).toBe(0); // stop() destroys persisted → swept
  });

  test("eviction terminates (no spin) when every candidate is pinned", async () => {
    const { broker, engine, managed, router, go } = setup();
    router.push("/one");
    managed.start();
    await managed.waitForNavigation();
    await engine.dispatch("one", "bg");
    await go("/two");
    await engine.dispatch("two", "bg");
    // cache [one(pinned), two(pinned)] = 2 > 1, both pinned, within cap 2.
    await go("/three");
    expect(engine.unregistered).toEqual([]);
    expect(backgroundOwners(broker).size).toBe(2);
    // Navigation keeps working afterwards (the loop did not wedge the chain).
    await go("/four");
    expect(engine.unregistered).toEqual(["three"]);
    expect(managed.getActiveRoute()?.path).toBe("/four");
    await managed.stop();
  });

  test("past the hard pin cap the oldest pinned module is evicted and its work cancelled", async () => {
    const { broker, engine, managed, router, go, results } = setup({ maxPinnedModules: 1 });
    router.push("/one");
    managed.start();
    await managed.waitForNavigation();
    await engine.dispatch("one", "bg");
    await go("/two");
    await engine.dispatch("two", "bg");
    await go("/three"); // [one(p), two(p)]: 2 pinned > cap 1 → evict one
    expect(engine.unregistered).toEqual(["one"]);
    expect(await results[0]).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(backgroundOwners(broker).size).toBe(1);
    await managed.stop();
  });
});
