/**
 * JSON event streams on the server (#10, RFC 001 §2.3/§4; Swift review #9):
 *  - the server advertises only capabilities it has an API for (no
 *    binary-upload streams such as mic.record);
 *  - `context.device.stream()` delivers schema-validated events to the
 *    handler and returns a cancellable handle with one terminal outcome;
 *  - JSON stream credit counts events: the server grants `initialCredit`,
 *    replenishes as the handler consumes, and an event beyond credit is a
 *    violation;
 *  - per-request and per-connection token buckets bound the event rate.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import {
  DeviceContext,
  type DeviceResult,
  type DeviceStreamHandle,
} from "@hypen-space/core/remote/device";
import { FakeDeviceHost } from "@hypen-space/device-fake";
import {
  CAPS_ALL,
  controlsFor,
  deviceHello,
  flush,
  loopback,
  makeHost,
  makePlane,
  makeTransport,
  requestsOf,
  spec,
} from "./device-srv-harness";

const owner = { moduleInstanceId: "m1", activationId: 1 };
const scanEvent = (id: string, rssi = -40) => ({ device: { id, rssi } });

describe("advertisement (#10)", () => {
  test("mic.record (binary-upload stream, consumed via device.stream(…, { onData }) since round 3) and bluetooth.scan are selected; an unknown name never is", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(
      JSON.stringify(deviceHello([...CAPS_ALL, { name: "teleport", versions: [1] }]))
    );
    await session.ready;
    const ack = t.ui.find((m) => m.type === "sessionAck") as any;
    const names = ack.device.capabilities.map((c: any) => c.name);
    expect(names).toContain("bluetooth.scan");
    expect(names).toContain("mic.record");
    expect(names).not.toContain("teleport");
    await session.destroy();
  });
});

/** A session whose "scan" action opens a bluetooth.scan stream. */
async function scanSession(initialCredit: number, consume: (ev: any) => void | Promise<unknown>) {
  const out: { handle: DeviceStreamHandle | null; result: DeviceResult<any> | null; events: any[] } = {
    handle: null,
    result: null,
    events: [],
  };
  const module = app
    .defineState({})
    .onAction("scan", async ({ context }) => {
      out.handle = context.device.stream("bluetooth.scan", {}, { initialCredit }, (ev) => {
        out.events.push(ev);
        return consume(ev);
      });
      out.result = await out.handle.settled;
    })
    .build() as unknown as SessionHost["module"];
  const t = makeTransport();
  const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
  await session.receive(JSON.stringify(deviceHello()));
  await session.ready;
  await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "scan" }));
  await flush();
  const req = requestsOf(t.device, "bluetooth.scan")[0]!;
  const emit = (event: unknown) => session.receive(JSON.stringify({ type: "deviceEvent", id: req.id, event }));
  return { ...t, session, out, req, emit };
}

describe("context.device.stream() (#10)", () => {
  test("events validated and delivered in order; terminal result settles the handle", async () => {
    const t = await scanSession(8, () => {});
    expect(t.req.initialCredit).toBe(8);
    expect(t.req.lifetime).toBe("activation");
    await t.emit(scanEvent("aa"));
    await t.emit(scanEvent("bb", -70));
    expect(t.out.events).toEqual([scanEvent("aa"), scanEvent("bb", -70)]);
    await t.session.receive(JSON.stringify({ type: "deviceResponse", id: t.req.id, result: {} }));
    await flush();
    expect(t.out.result).toEqual({ ok: true, value: {} });
    await t.session.destroy();
  });

  test("an event that fails the revision's event schema → invalidParams + cancel, never delivered", async () => {
    const t = await scanSession(8, () => {});
    await t.emit({ device: { id: "aa", rssi: 99999 } });
    await flush();
    expect(t.out.events).toEqual([]);
    expect(t.out.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(1);
    await t.session.destroy();
  });

  test("progress events are accepted, not delivered, and consume no credit", async () => {
    const t = await scanSession(1, () => {});
    for (let i = 0; i < 5; i++) await t.emit({ kind: "progress", state: "running" });
    expect(t.out.events).toEqual([]);
    expect(t.session.deviceBroker!.outstandingEventCredit(t.req.id)).toBe(1);
    await t.session.destroy();
  });

  test("cancel() sends control.cancel and settles cancelled", async () => {
    const t = await scanSession(8, () => {});
    t.out.handle!.cancel();
    await flush();
    expect(t.out.result).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(1);
    await t.session.destroy();
  });

  test("owner deactivation sweeps the stream", async () => {
    const t = await scanSession(8, () => {});
    await t.session.moduleInstance!.deactivate();
    await flush();
    expect(t.out.result).toEqual({ ok: false, error: { code: "cancelled" } });
    await t.session.destroy();
  });

  test("request() on a stream and stream() on a unary capability are refused locally", async () => {
    const results: Array<DeviceResult<any>> = [];
    const module = app
      .defineState({})
      .onAction("misuse", async ({ context }) => {
        results.push(await context.device.request("bluetooth.scan", {}));
        results.push(await context.device.stream("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, {}, () => {}).settled);
        results.push(await context.device.stream("bluetooth.scan", {}, { initialCredit: 0 }, () => {}).settled);
        results.push(await context.device.stream("bluetooth.scan", { extra: 1 }, {}, () => {}).settled);
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    const before = requestsOf(t.device).length;
    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "misuse" }));
    await flush();
    expect(results.map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "invalidParams",
      "invalidParams",
      "invalidParams",
      "invalidParams",
    ]);
    expect(requestsOf(t.device).length).toBe(before);
    await session.destroy();
  });
});

describe("JSON event credit (#10)", () => {
  test("credit is granted back only as the handler consumes; an event beyond credit is a violation", async () => {
    const resolvers: Array<() => void> = [];
    const t = await scanSession(4, () => new Promise<void>((r) => resolvers.push(r)));
    for (let i = 0; i < 4; i++) await t.emit(scanEvent(`d${i}`));
    expect(t.out.events.length).toBe(4);
    expect(controlsFor(t.device, t.req.id, "grant")).toEqual([]); // nothing consumed yet

    // The handler finishes two events: credit comes back (immediately when
    // exhausted, otherwise batched), never more than was consumed.
    resolvers[0]!();
    resolvers[1]!();
    await flush();
    const granted = controlsFor(t.device, t.req.id, "grant").reduce((n, m) => n + m.control.grant, 0);
    expect(granted).toBeGreaterThanOrEqual(1);
    expect(granted).toBeLessThanOrEqual(2);
    const outstanding = t.session.deviceBroker!.outstandingEventCredit(t.req.id)!;
    expect(outstanding).toBe(granted);
    for (let i = 0; i < outstanding; i++) await t.emit(scanEvent(`e${i}`));
    expect(t.out.events.length).toBe(4 + outstanding);
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);

    // Credit is exhausted again (0 outstanding): one more is a violation.
    await t.emit(scanEvent("over"));
    await flush();
    expect(t.out.events.length).toBe(4 + outstanding);
    expect(t.out.result).toMatchObject({ ok: false, error: { code: "invalidParams", platformDetail: expect.stringMatching(/credit/) } });
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(1);
    await t.session.destroy();
  });

  test("a grant from the client on a JSON stream is wrong-direction", async () => {
    const t = await scanSession(4, () => {});
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: t.req.id, control: { grant: 4 } }));
    await flush();
    expect(t.out.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    await t.session.destroy();
  });

  test("paused reports transitions only; a repeated paused:true is a violation", async () => {
    const t = await scanSession(4, () => {});
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: t.req.id, control: { paused: true } }));
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: t.req.id, control: { paused: false } }));
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    await t.session.receive(JSON.stringify({ type: "deviceEvent", id: t.req.id, control: { paused: false } }));
    await flush();
    expect(t.out.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    await t.session.destroy();
  });
});

describe("event token buckets (#10)", () => {
  function broker(rate: { requestBurst?: number; requestPerSecond?: number; connectionBurst?: number; connectionPerSecond?: number }) {
    const h = makePlane({ config: { eventRate: rate } });
    const open = (onEvent: (ev: unknown) => unknown = () => {}, initialCredit = 256) =>
      h.plane.open(spec("bluetooth.scan", {}, { timeoutMs: 600_000, initialCredit, onEvent: onEvent as () => void }));
    const ev = (id: number | null) => h.receive({ type: "deviceEvent", id, event: scanEvent("x") });
    return { b: h.plane, clock: h.clock, open, ev, sent: h.sent, h };
  }

  test("per-request bucket: a burst beyond it is throttled even with credit to spare", async () => {
    const { open, ev } = broker({ requestBurst: 3, requestPerSecond: 1 });
    const h = open();
    ev(h.id);
    ev(h.id);
    ev(h.id);
    ev(h.id);
    expect(await h.settled).toEqual({ error: { code: "throttled", platformDetail: "event rate limit" } });
  });

  test("per-request bucket refills with time", async () => {
    const { b, clock, open, ev } = broker({ requestBurst: 2, requestPerSecond: 2 });
    const h = open();
    for (let i = 0; i < 10; i++) {
      ev(h.id);
      clock.advance(600);
    }
    expect(b.isLive(h.id!)).toBe(true);
    h.cancel();
  });

  test("per-connection bucket: spreading a flood over requests does not escape it", async () => {
    const { open, ev } = broker({ requestBurst: 100, connectionBurst: 5, connectionPerSecond: 1 });
    const hs = [open(), open(), open()];
    for (let i = 0; i < 6; i++) ev(hs[i % 3]!.id);
    const outcomes = await Promise.all(hs.map((h) => Promise.race([h.settled, Promise.resolve(null)])));
    expect(outcomes.filter((o) => o && "error" in o && o.error.code === "throttled").length).toBe(1);
    for (const h of hs) h.cancel();
  });

  test("the old repro: 100k events on a credit-8 stream stop at the 9th", async () => {
    const { b, open } = broker({});
    // A consumer that never catches up: no credit ever comes back.
    const h = open(() => new Promise(() => {}), 8);
    let accepted = 0;
    for (let i = 0; i < 100_000 && b.isLive(h.id!); i++) {
      b.receiveText(JSON.stringify({ type: "deviceEvent", id: h.id, event: scanEvent(`d${i}`) }));
      if (b.isLive(h.id!)) accepted += 1;
    }
    expect(accepted).toBe(8);
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("the control stream's snapshots are consumed by the broker itself: credit comes back at once", async () => {
    const { h } = broker({});
    const snapshot = { capabilities: [{ name: "core.capabilities", versions: [1] }, { name: "bluetooth.scan", versions: [1] }] };
    for (let i = 0; i < 20; i++) h.receive({ type: "deviceEvent", id: h.core, event: snapshot });
    expect(h.plane.isLive(h.core!)).toBe(true);
    expect(controlsFor(h.sent, h.core!, "grant").length).toBeGreaterThan(0);
    expect(h.plane.supports("bluetooth.scan")).toBe(true);
    expect(h.plane.supports("gallery.pick")).toBe(false);
    expect(h.closes).toEqual([]);
  });
});

describe("bluetooth.scan end to end with the DeviceClient runtime", () => {
  test("a driver's events reach the handler under credit; the terminal result settles the stream", async () => {
    const host = new FakeDeviceHost().driver("bluetooth.scan", async ({ emit }) => {
      for (let i = 0; i < 6; i++) emit(scanEvent(`dev-${i}`, -30 - i));
      await new Promise((r) => setTimeout(r, 30));
      return { kind: "result", result: {} };
    });
    const h = loopback((t) => host.client(t));
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const seen: string[] = [];
    const handle = ctx.stream<{ device: { id: string } }>("bluetooth.scan", {}, { initialCredit: 2 }, async (ev) => {
      seen.push(ev.device.id);
      await new Promise((r) => setTimeout(r, 1)); // a handler that takes a moment
    });
    const result = await handle.settled;
    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    // Order is preserved and every delivered event is one the driver emitted.
    for (const id of seen) expect(id).toMatch(/^dev-[0-5]$/);
    expect([...seen].sort()).toEqual(seen);
  });
});
