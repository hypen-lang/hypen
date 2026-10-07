/**
 * Device Capability Protocol — broker + replay firewall (RFC 001 §2.1/§2.7).
 *
 * The broker is the Rust `DeviceBroker` (wasm-node `WasmDeviceBroker`)
 * reached through the WASM-free port and driven by a `DevicePlane` with a
 * deterministic fake clock: no real timers, so lease/timeout behavior is
 * exercised by advancing virtual time. `start()` opens the connection-owned
 * `core.capabilities` stream first (id 1), so handler requests start at 2;
 * its lease is acknowledged wherever a test advances time, so only the
 * request under test can expire.
 */

import { describe, expect, test } from "bun:test";
import { DeviceContext, deniedDeviceContext } from "@hypen-space/core/remote/device";
import { makePlane, spec } from "./device-srv-harness";

const gallery = (mi = "m1", act = 1) =>
  spec("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, { moduleInstanceId: mi, activationId: act });
const permission = () => spec("permission.request", { permission: "camera" });

/** Advance `ms` in 1 s steps, acknowledging the control stream's lease. */
function advanceKeepingCore(h: ReturnType<typeof makePlane>, ms: number) {
  for (let t = 0; t < ms; t += 1000) {
    h.ackLeases(h.core!);
    h.clock.advance(Math.min(1000, ms - t));
  }
}

describe("id allocation", () => {
  test("monotone after core.capabilities, never reused across completed requests", async () => {
    const h = makePlane();
    expect(h.core).toBe(1);
    const h1 = h.plane.open(gallery());
    const h2 = h.plane.open(gallery());
    expect(h1.id).toBe(2);
    expect(h2.id).toBe(3);

    // Complete h1; the next request still advances past its id.
    h.receive({ type: "deviceResponse", id: h1.id, result: { items: [] } });
    await h1.settled;
    const h3 = h.plane.open(gallery());
    expect(h3.id).toBe(4);

    const requestIds = h.sent.filter((m) => m.type === "deviceRequest").map((m) => m.id);
    expect(requestIds).toEqual([1, 2, 3, 4]);
  });

  test("nothing is admitted before the plane started (core.capabilities first)", async () => {
    const h = makePlane({ start: false, owners: [] });
    const r = h.plane.open(gallery());
    expect(r.id).toBeNull();
    expect(await r.settled).toMatchObject({ error: { code: "unavailable" } });
    expect(h.sent).toEqual([]);
  });
});

describe("terminal settlement", () => {
  test("result settles ok exactly once; later messages ignored", async () => {
    const h = makePlane();
    const r = h.plane.open(permission());
    h.receive({ type: "deviceResponse", id: r.id, result: { status: "granted" } });
    const s = await r.settled;
    expect(s).toEqual({ result: { status: "granted" }, blobs: [] });
    // A second terminal for a retired id is dropped (unknown id).
    expect(h.receive({ type: "deviceResponse", id: r.id, error: { code: "denied" } })).toBe(false);
    expect(h.plane.liveCount).toBe(1); // only core.capabilities
  });

  test("a blob result naming items that were never announced is invalidParams", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    h.receive({
      type: "deviceResponse",
      id: r.id,
      result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3, sha256: "a".repeat(64) }] },
    });
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("error settles err", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    h.receive({ type: "deviceResponse", id: r.id, error: { code: "denied", platformDetail: "user-declined" } });
    expect(await r.settled).toEqual({ error: { code: "denied", platformDetail: "user-declined" } });
  });

  test("unknown/stale ids are ignored, never throw", () => {
    const h = makePlane();
    expect(h.receive({ type: "deviceResponse", id: 999, result: {} })).toBe(false);
    expect(h.receive({ type: "deviceEvent", id: 999, control: { leaseAck: 1 } })).toBe(false);
    expect(h.closes).toEqual([]);
  });
});

describe("cancellation", () => {
  test("server cancel retires id, sends control.cancel, settles cancelled, no waiting", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    r.cancel();
    expect(await r.settled).toEqual({ error: { code: "cancelled" } });
    expect(h.sent.some((m) => m.type === "deviceEvent" && m.id === r.id && m.control?.cancel === true)).toBe(true);
    // A late client success for the retired id is ignored (§2.1 cancel race).
    expect(h.receive({ type: "deviceResponse", id: r.id, result: {} })).toBe(false);
  });
});

describe("owner sweeps", () => {
  test("deactivation cancels that activation's requests only", async () => {
    const h = makePlane({ owners: [["m1", 1], ["m2", 1]] });
    const a = h.plane.open(gallery("m1", 1));
    const b = h.plane.open(gallery("m2", 1));
    h.plane.ownerDeactivated("m1", 1);
    expect(await a.settled).toEqual({ error: { code: "cancelled" } });
    expect(h.plane.isLive(b.id!)).toBe(true); // b survives
    h.receive({ type: "deviceResponse", id: b.id, result: { items: [] } });
    expect(await b.settled).toMatchObject({ result: { items: [] } });
  });

  test("a new activation ends the previous one's authority and sweeps its work", async () => {
    const h = makePlane();
    const a = h.plane.open(gallery("m1", 1));
    expect(h.plane.ownerActivated("m1", 2)).toBe(true);
    expect(await a.settled).toEqual({ error: { code: "cancelled" } });
    // Stale and repeated activations are refused.
    expect(h.plane.ownerActivated("m1", 2)).toBe(false);
    expect(h.plane.ownerActivated("m1", 1)).toBe(false);
    const stale = h.plane.open(gallery("m1", 1));
    expect(await stale.settled).toEqual({ error: { code: "unavailable", platformDetail: "owner-inactive" } });
  });

  test("destroy sweep also cancels background owners", async () => {
    const h = makePlane({
      config: { revisionOverrides: [{ capability: "mic.record", version: 1, lifetimes: ["activation", "background"] }] },
    });
    const bg = h.plane.open(
      spec("mic.record", { sampleRate: 48000, format: "pcm16" }, { lifetime: "background", onData: () => {} })
    );
    expect(bg.id).not.toBeNull();
    h.plane.ownerDeactivated("m1", 1);
    expect(h.plane.isLive(bg.id!)).toBe(true); // background survives deactivation
    expect(h.plane.hasBackgroundWork("m1")).toBe(true);
    h.plane.ownerDestroyed("m1"); // destroy
    expect(await bg.settled).toEqual({ error: { code: "cancelled" } });
    expect(h.plane.hasBackgroundWork("m1")).toBe(false);
  });
});

describe("leases", () => {
  test("renewLease seq 1 sent immediately; acks keep a request live past 15 s", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    const renews = () =>
      h.sent.filter((m) => m.id === r.id && m.control?.renewLease !== undefined).map((m) => m.control.renewLease as number);
    expect(renews()).toEqual([1]);
    // Echo every renewal as the client would; 40 s of healthy silence.
    for (let t = 0; t < 40; t++) {
      h.ackLeases(r.id!);
      h.ackLeases(h.core!);
      h.clock.advance(1000);
    }
    expect(h.plane.isLive(r.id!)).toBe(true);
    expect(renews().length).toBeGreaterThanOrEqual(8);
    // Without acks from here on, the lease expires within 15 s + one tick.
    advanceKeepingCore(h, 16_000);
    expect(await r.settled).toEqual({ error: { code: "connectionLost" } });
    expect(h.closes).toEqual([]);
  });

  test("no ack progress for 15s expires the request as connectionLost", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    advanceKeepingCore(h, 16_000); // silence past LEASE_EXPIRY_MS
    expect(await r.settled).toEqual({ error: { code: "connectionLost" } });
  });

  test("a fabricated/future ack is invalidParams + cancel (§2.1/§2.7)", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    h.receive({ type: "deviceEvent", id: r.id, control: { leaseAck: 999 } });
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
    expect(h.sent.some((m) => m.type === "deviceEvent" && m.id === r.id && m.control?.cancel)).toBe(true);
  });

  test("duplicate/older acks do not refresh liveness", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    h.receive({ type: "deviceEvent", id: r.id, control: { leaseAck: 1 } });
    // Keep re-acking seq 1 only: it never advances, so liveness is not refreshed.
    for (let t = 0; t < 16; t++) {
      h.ackLeases(h.core!);
      h.clock.advance(1000);
      h.receive({ type: "deviceEvent", id: r.id, control: { leaseAck: 1 } });
    }
    expect(await r.settled).toEqual({ error: { code: "connectionLost" } });
  });

  test("the control stream's own lease failure closes the device plane (1012)", async () => {
    const h = makePlane();
    const r = h.plane.open(gallery());
    // Keep the request alive; never acknowledge core.capabilities.
    for (let t = 0; t < 16; t++) {
      h.ackLeases(r.id!);
      h.clock.advance(1000);
    }
    expect(h.closes.length).toBe(1);
    expect(h.closes[0]!.code).toBe(1012);
    expect(h.plane.isClosed).toBe(true);
    expect(await r.settled).toEqual({ error: { code: "connectionLost" } });
  });
});

describe("close (connection loss)", () => {
  test("rejects all live work connectionLost, sends nothing", async () => {
    const h = makePlane({ owners: [["m1", 1], ["m2", 1]] });
    const h1 = h.plane.open(gallery("m1"));
    const h2 = h.plane.open(gallery("m2"));
    const before = h.sent.length;
    h.plane.close();
    expect(await h1.settled).toEqual({ error: { code: "connectionLost" } });
    expect(await h2.settled).toEqual({ error: { code: "connectionLost" } });
    expect(h.sent.length).toBe(before); // no cancellation frames after socket loss
    expect(h.plane.liveCount).toBe(0);
    expect(h.plane.isClosed).toBe(true);
    // Released: later calls are harmless no-ops / refusals.
    expect(h.plane.open(gallery()).id).toBeNull();
    h.plane.close();
  });
});

describe("replay firewall (DeviceContext)", () => {
  const owner = { moduleInstanceId: "m1", activationId: 1 };
  const onlyGallery = {
    protocolVersion: 1,
    binary: true,
    capabilities: [
      { name: "core.capabilities", version: 1 },
      { name: "gallery.pick", version: 1 },
    ],
  };

  test("origin dispatch produces exactly one deviceRequest", async () => {
    const h = makePlane({ ack: onlyGallery });
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const p = ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    const requests = h.sent.filter((m) => m.type === "deviceRequest" && m.capability === "gallery.pick");
    expect(requests.length).toBe(1);
    h.receive({ type: "deviceResponse", id: requests[0].id, result: { items: [] } });
    const res = await p;
    expect(res).toEqual({ ok: true, value: { items: [] } });
  });

  test("replayed dispatch fails synchronously with unavailable, no request sent", async () => {
    const h = makePlane({ ack: onlyGallery });
    const before = h.sent.length;
    const ctx = new DeviceContext(h.plane, owner, "replay");
    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    expect(res).toEqual({ ok: false, error: { code: "unavailable", platformDetail: "syncActions.replay" } });
    expect(h.sent.length).toBe(before);
  });

  test("the broker enforces the firewall too (replayed open → unavailable, nothing sent)", async () => {
    const h = makePlane({ ack: onlyGallery });
    const before = h.sent.length;
    const r = h.plane.open({ ...gallery(), replayed: true });
    expect(r.id).toBeNull();
    expect(await r.settled).toEqual({ error: { code: "unavailable", platformDetail: "syncActions.replay" } });
    expect(h.sent.length).toBe(before);
  });

  test("replay restriction survives await (deniedDeviceContext)", async () => {
    const ctx = deniedDeviceContext("replay");
    await Promise.resolve();
    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"] });
    expect(res.ok).toBe(false);
  });

  test("unsupported capability fails without opening a request", async () => {
    const h = makePlane({ ack: onlyGallery });
    const before = h.sent.length;
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const res = await ctx.requestUntyped("mic.record", { sampleRate: 48000, format: "pcm16" });
    expect(res).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(h.sent.length).toBe(before);
  });

  test("supports() reflects the live intersection, not consent", () => {
    const h = makePlane({ ack: onlyGallery });
    const ctx = new DeviceContext(h.plane, owner, "origin");
    expect(ctx.supports("gallery.pick")).toBe(true);
    expect(ctx.supports("bluetooth.scan")).toBe(false);
  });
});
