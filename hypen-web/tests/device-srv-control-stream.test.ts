/**
 * The connection-owned `core.capabilities` stream (#3), hello.device
 * validation (#7) and late device hellos reaching routed modules (#9) —
 * RFC 001 §2.2/§2.5.
 */

import { describe, expect, test } from "bun:test";
import { app, HypenApp } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import type { DeviceResult } from "@hypen-space/core/remote/device";
import {
  CAPS_ALL,
  FakeClock,
  controlsFor,
  deviceHello,
  flush,
  makeHost,
  makeTransport,
  requestsOf,
} from "./device-srv-harness";

type Probe = { supports: boolean[]; results: Array<DeviceResult<any>> };

async function start(opts: { clock?: FakeClock; controlTimeoutMs?: number; hello?: unknown } = {}) {
  const probe: Probe = { supports: [], results: [] };
  let t!: ReturnType<typeof makeTransport>;
  const coreRequestsSeenOnActivated: number[] = [];
  const module = app
    .defineState({})
    .onActivated(() => {
      coreRequestsSeenOnActivated.push(requestsOf(t.device, "core.capabilities").length);
    })
    .onAction("check", async ({ context }) => {
      probe.supports.push(context.device.supports("gallery.pick"));
    })
    .onAction("pick", async ({ context }) => {
      probe.results.push(await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
    })
    .build() as unknown as SessionHost["module"];
  t = makeTransport();
  const session = new RemoteSession(makeHost(module), t.transport, {
    helloGraceMs: null,
    ...(opts.clock ? { deviceClock: opts.clock } : {}),
    ...(opts.controlTimeoutMs ? { deviceControlStreamTimeoutMs: opts.controlTimeoutMs } : {}),
  });
  await session.receive(JSON.stringify(opts.hello ?? deviceHello()));
  await session.ready;
  await flush();
  const core = () => requestsOf(t.device, "core.capabilities").at(-1);
  const act = async (name: string) => {
    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: name }));
    await flush();
  };
  const event = (id: number, capabilities: unknown) =>
    session.receive(JSON.stringify({ type: "deviceEvent", id, event: { capabilities } }));
  return { ...t, session, probe, core, act, event, coreRequestsSeenOnActivated };
}

const offer = (...names: string[]) => names.map((name) => ({ name, versions: [1] }));

describe("core.capabilities replacement events (#3)", () => {
  test("a replacement removes a capability from supports() and from request()", async () => {
    const t = await start();
    await t.act("check");
    expect(t.probe.supports).toEqual([true]);

    await t.event(t.core().id, offer("core.capabilities"));
    await t.act("check");
    expect(t.probe.supports).toEqual([true, false]);
    await t.act("pick");
    expect(t.probe.results.at(-1)).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(requestsOf(t.device, "gallery.pick").length).toBe(0);

    // A later replacement brings it back.
    await t.event(t.core().id, offer("core.capabilities", "gallery.pick"));
    await t.act("check");
    expect(t.probe.supports).toEqual([true, false, true]);
    expect(t.closes).toEqual([]);
    await t.session.destroy();
  });

  test("a replacement can only select what the server advertises (no unknown names)", async () => {
    // Since round 3 every registry revision has a server API (mic.record via
    // device.stream(…, { onData }), camera.capture, bluetooth.select), so the
    // advertisement is the whole registry; unknown names are never selected.
    const t = await start({ hello: deviceHello([...CAPS_ALL, { name: "camera.capture", versions: [1] }]) });
    await t.event(t.core().id, offer("core.capabilities", "camera.capture", "teleport"));
    // The live selection lives in the Rust broker.
    const selected = t.session.deviceBroker!.info()!.selection.map((c) => c.name);
    expect(selected.sort()).toEqual(["camera.capture", "core.capabilities"]);
    await t.session.destroy();
  });

  test("a replacement never widens the selection beyond the negotiated ack (§2.2)", async () => {
    // The hello lacked camera.capture, so the ack omits it although the server
    // advertises it: a later snapshot listing it cannot add it (every client
    // answers such a request with unsupported), and restoring gallery.pick
    // within the ack still works.
    const t = await start();
    await t.event(t.core().id, offer("core.capabilities", "camera.capture"));
    expect(t.session.deviceBroker!.info()!.selection.map((c) => c.name)).toEqual(["core.capabilities"]);
    await t.act("check");
    expect(t.probe.supports).toEqual([false]);
    await t.event(t.core().id, offer("core.capabilities", "camera.capture", "gallery.pick"));
    const selected = t.session.deviceBroker!.info()!.selection.map((c) => c.name);
    expect(selected.sort()).toEqual(["core.capabilities", "gallery.pick"]);
    await t.act("check");
    expect(t.probe.supports).toEqual([false, true]);
    expect(t.closes).toEqual([]);
    await t.session.destroy();
  });

  test("the broker replenishes snapshot credit on its own (no app handler involved)", async () => {
    const t = await start();
    const id = t.core().id;
    for (let i = 0; i < 20; i++) await t.event(id, offer("core.capabilities", "gallery.pick"));
    // 20 events against an initial credit of 8: only possible with grants.
    const grants = controlsFor(t.device, id, "grant").reduce((n, m) => n + m.control.grant, 0);
    expect(grants).toBeGreaterThanOrEqual(12);
    expect(t.closes).toEqual([]);
    expect(t.session.deviceBroker!.isLive(id)).toBe(true);
    await t.session.destroy();
  });

  test("an invalid event closes the device connection", async () => {
    const t = await start();
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: t.core().id, event: { capabilities: "all" } }));
    await flush();
    expect(t.closes[0]?.code).toBe(1012);
    expect(t.session.deviceBroker).toBeNull();
    await t.session.destroy();
  });

  test("withdrawing core.capabilities itself closes the device connection", async () => {
    const t = await start();
    await t.event(t.core().id, offer("gallery.pick"));
    await flush();
    expect(t.closes[0]?.code).toBe(1012);
    expect(t.session.deviceBroker).toBeNull();
    await t.session.destroy();
  });
});

describe("core.capabilities lifecycle (#3)", () => {
  test("opens BEFORE onActivated runs", async () => {
    const t = await start();
    expect(t.coreRequestsSeenOnActivated).toEqual([1]);
    await t.session.destroy();
  });

  test("an unexpected client terminal closes the device plane and fails in-flight work", async () => {
    const t = await start();
    await t.act("pick"); // in flight
    const coreId = t.core().id;
    await t.session.receive(JSON.stringify({ type: "deviceResponse", id: coreId, result: {} }));
    await flush();
    expect(t.closes[0]?.code).toBe(1012);
    expect(t.session.deviceBroker).toBeNull();
    expect(t.probe.results).toEqual([{ ok: false, error: { code: "connectionLost" } }]);
    // Handlers now see a disabled plane, not a stale broker.
    await t.act("check");
    expect(t.probe.supports.at(-1)).toBe(false);
    await t.session.destroy();
  });

  test("a client `unsupported` error for the stream closes the device plane", async () => {
    const t = await start();
    await t.session.receive(
      JSON.stringify({ type: "deviceResponse", id: t.core().id, error: { code: "unsupported" } })
    );
    await flush();
    expect(t.closes[0]?.code).toBe(1012);
    expect(t.session.deviceBroker).toBeNull();
    await t.session.destroy();
  });

  test("a lease failure of the stream closes the device plane", async () => {
    const clock = new FakeClock();
    const t = await start({ clock });
    clock.advance(16_000); // no leaseAcks at all
    await flush();
    expect(t.closes[0]?.code).toBe(1012);
    expect(t.session.deviceBroker).toBeNull();
    await t.session.destroy();
  });

  test("planned reopen before the finite deadline: old stream retired first, fresh snapshot applied", async () => {
    const clock = new FakeClock();
    const t = await start({ clock, controlTimeoutMs: 10_000 });
    const first = t.core();
    // Keep the first stream's lease healthy.
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: first.id, control: { leaseAck: 1 } }));
    await t.event(first.id, offer("core.capabilities"));
    const before = t.device.length;

    clock.advance(9_500); // reopen lead: 1 s before the 10 s deadline
    await flush();
    const after = t.device.slice(before);
    const cancelIdx = after.findIndex((m: any) => m.id === first.id && m.control?.cancel);
    const reopenIdx = after.findIndex((m: any) => m.type === "deviceRequest" && m.capability === "core.capabilities");
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(reopenIdx).toBeGreaterThan(cancelIdx);
    const second = t.core();
    expect(second.id).toBeGreaterThan(first.id);
    expect(t.closes).toEqual([]); // planned: the retired stream is not a failure

    // The retired stream's late events are ignored; the new snapshot applies.
    await t.event(first.id, offer("core.capabilities"));
    await t.event(second.id, offer("core.capabilities", "gallery.pick"));
    await t.act("check");
    expect(t.probe.supports.at(-1)).toBe(true);
    await t.session.destroy();
  });

  test("the stream is never allowed to reach its deadline (timeout would close the plane)", async () => {
    const clock = new FakeClock();
    const t = await start({ clock, controlTimeoutMs: 10_000 });
    // Ack every renewal of whatever stream is live, for 35 s.
    for (let s = 0; s < 35; s++) {
      for (const m of t.device) {
        const c = (m as any).control;
        if (m.type === "deviceEvent" && c && "renewLease" in c && t.session.deviceBroker?.isLive((m as any).id)) {
          await t.session.receive(JSON.stringify({ type: "deviceEvent", id: (m as any).id, control: { leaseAck: c.renewLease } }));
        }
      }
      clock.advance(1_000);
      await flush();
    }
    expect(t.closes).toEqual([]);
    expect(requestsOf(t.device, "core.capabilities").length).toBeGreaterThanOrEqual(4);
    expect(t.session.deviceBroker!.liveCount).toBe(1);
    await t.session.destroy();
  });
});

describe("hello.device validation (#7)", () => {
  const bad: Array<[string, unknown]> = [
    ["protocolVersions is a number", { protocolVersions: 1, binary: true, capabilities: [] }],
    ["versions is a string", { protocolVersions: [1], binary: true, capabilities: [{ name: "core.capabilities", versions: "v1.2" }] }],
    ["duplicate capability names", {
      protocolVersions: [1],
      binary: true,
      capabilities: [
        { name: "core.capabilities", versions: [1] },
        { name: "gallery.pick", versions: [1] },
        { name: "gallery.pick", versions: [1] },
      ],
    }],
    ["unknown key", { protocolVersions: [1], binary: true, capabilities: [], extra: 1 }],
    ["missing core.capabilities (rule b)", { protocolVersions: [1], binary: true, capabilities: [{ name: "gallery.pick", versions: [1] }] }],
    ["not an object", "device please"],
  ];
  for (const [name, device] of bad) {
    test(`${name} ⇒ device disabled, session fully initialised, never a zombie`, async () => {
      const t = await start({ hello: { type: "hello", device } });
      expect(t.session.isReady).toBe(true);
      const ack = t.ui.find((m) => m.type === "sessionAck") as any;
      expect(ack).toBeDefined();
      expect(ack.device).toBeUndefined();
      expect(t.ui.some((m) => m.type === "initialTree")).toBe(true);
      expect(t.device.length).toBe(0);
      expect(t.session.deviceBroker).toBeNull();
      // A second (well-formed) hello cannot retro-enable the plane: the
      // handshake after an explicit hello is immutable (§2.2).
      await t.session.receive(JSON.stringify(deviceHello()));
      expect(t.session.deviceBroker).toBeNull();
      expect(t.ui.filter((m) => m.type === "sessionAck").length).toBe(1);
      await t.session.destroy();
    });
  }
});

describe("late device hello reaches routed modules (#9)", () => {
  test("a ManagedRouter route mounted under the grace path gets the broker", async () => {
    const registry = new HypenApp();
    const results: Array<DeviceResult<any>> = [];
    registry
      .module("Home")
      .defineState({})
      .onAction("homePick", async ({ context }: any) => {
        results.push(await context.device.request("permission.request", { permission: "camera" }));
      })
      .build();
    const primary = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(
      makeHost(primary, {
        app: registry,
        routers: [{ moduleScope: null, routes: [{ path: "/", elementNames: ["Home"] }] }],
      }),
      t.transport,
      { helloGraceMs: 5 }
    );
    await session.ready; // legacy grace-path initialisation
    await new Promise((r) => setTimeout(r, 20));
    const routed = (session as any)._autoManagedRouter.liveInstances();
    expect(routed.length).toBe(1);

    await session.receive(JSON.stringify(deviceHello()));
    await flush();
    const acks = t.ui.filter((m) => m.type === "sessionAck") as any[];
    expect(acks.at(-1).device).toBeDefined();

    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "homePick" }));
    await flush();
    const req = requestsOf(t.device, "permission.request")[0];
    expect(req).toBeDefined();
    expect(req.owner.moduleInstanceId).toBe(routed[0].deviceInstanceId);
    await session.receive(JSON.stringify({ type: "deviceResponse", id: req.id, result: { status: "granted" } }));
    await flush();
    expect(results).toEqual([{ ok: true, value: { status: "granted" } }]);
    await session.destroy();
  });
});
