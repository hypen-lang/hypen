/**
 * Device Capability Protocol — client runtime (`DeviceClient`) admission,
 * liveness and credit rules (RFC 001 §2.1–§2.3, §2.6 step 1, §2.7).
 *
 * Covers: generated-schema validation of every incoming message (known-id
 * invalid ⇒ terminal invalidParams, unknown id ⇒ ignored), the request-id
 * high-water mark, negotiated-revision admission, owner/lifetime/limits
 * checks, per-request leases on a fake monotonic clock (initial 15 s lease,
 * strictly increasing renewals, duplicate re-ack without extension, unknown
 * ids never acked, expiry ⇒ connectionLost), the local deadline for every
 * driver, server cancel ⇒ terminal cancelled with no late upload, JSON-event
 * credit with each overflow policy.
 */

import { describe, expect, test } from "bun:test";
import {
  DeviceClient,
  type DeviceClientClock,
  type DeviceClientOptions,
  type DeviceDriver,
  type DriverContext,
} from "../packages/core/src/remote/device/runtime.ts";
import { withRevisionOverride } from "../packages/core/src/remote/device/registry.ts";
import type {
  DeviceEvent,
  DeviceRequest,
  DeviceResponse,
} from "../packages/core/src/remote/device/generated.ts";

class FakeClock implements DeviceClientClock {
  t = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  get pending() {
    return this.timers.size;
  }
  /** Advance virtual time, firing due one-shot timers in order. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) {
        if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = target;
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}

type Sent = DeviceResponse | DeviceEvent;

function harness(drivers: Record<string, DeviceDriver>, options: DeviceClientOptions = {}) {
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const frames: Uint8Array[] = [];
  const client = new DeviceClient(
    { sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) },
    new Map(Object.entries(drivers)),
    { clock, ...options }
  );
  const responses = () => sent.filter((m): m is DeviceResponse => m.type === "deviceResponse");
  const acks = (id: number) =>
    sent
      .filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && !!m.control && "leaseAck" in m.control)
      .map((m) => (m.control as { leaseAck: number }).leaseAck);
  const events = (id: number) =>
    sent
      .filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && !!m.event)
      .map((m) => m.event!);
  const controls = (id: number, key: string) =>
    sent
      .filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && !!m.control && key in m.control)
      .map((m) => (m.control as Record<string, unknown>)[key]);
  return { client, clock, sent, frames, responses, acks, events, controls };
}

/** A driver that runs until the runtime stops it; records that it stopped. */
function blockingDriver() {
  const state = { runs: 0, stopped: 0, ctx: null as DriverContext | null };
  const driver: DeviceDriver = async (ctx) => {
    state.runs += 1;
    state.ctx = ctx;
    await ctx.cancelled;
    state.stopped += 1;
    return { kind: "error", code: "cancelled" };
  };
  return { driver, state };
}

function req(over: Partial<DeviceRequest> & { id: number }): DeviceRequest {
  return {
    type: "deviceRequest",
    capability: "permission.query",
    version: 1,
    owner: { moduleInstanceId: "m1", activationId: 1 },
    lifetime: "activation",
    timeoutMs: 30_000,
    initialCredit: 0,
    params: { permission: "camera" },
    ...over,
  };
}

const galleryReq = (id: number, over: Partial<DeviceRequest> = {}): DeviceRequest =>
  req({
    id,
    capability: "gallery.pick",
    timeoutMs: 300_000,
    initialCredit: 65_536,
    params: { mediaTypes: ["photo"], maxCount: 1 },
    ...over,
  });

const scanReq = (id: number, initialCredit: number): DeviceRequest =>
  req({ id, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit, params: {} });

const capsReq = (id: number, initialCredit: number): DeviceRequest =>
  req({
    id,
    capability: "core.capabilities",
    owner: { connection: true },
    lifetime: "connection",
    timeoutMs: 86_400_000,
    initialCredit,
    params: {},
  });

const control = (id: number, c: Record<string, unknown>) =>
  ({ type: "deviceEvent", id, control: c }) as unknown as DeviceEvent;

// ---------------------------------------------------------------------------

describe("validation (RFC 001 §1.9 / §2.1)", () => {
  test("a malformed deviceRequest with a fresh id is refused invalidParams without running the driver", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    // Owner mixes two shapes; no oneOf branch matches.
    h.client.handleMessage(
      req({ id: 1, owner: { moduleInstanceId: "m1", connection: true } as never })
    );
    // Missing timeoutMs.
    const { timeoutMs: _omit, ...noTimeout } = req({ id: 2 });
    h.client.handleMessage(noTimeout as DeviceRequest);
    await ticks(2);
    expect(b.state.runs).toBe(0);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
    ]);
  });

  test("params violating the selected revision's schema are invalidParams", async () => {
    const b = blockingDriver();
    const h = harness({ "gallery.pick": b.driver });
    h.client.handleMessage(galleryReq(1, { params: { mediaTypes: ["photo"], maxCount: 99 } }));
    h.client.handleMessage(galleryReq(2, { params: { mediaTypes: ["photo"], maxCount: 1, extra: 1 } }));
    await ticks(2);
    expect(b.state.runs).toBe(0);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["invalidParams", "invalidParams"]);
  });

  test("owner/lifetime shape, timeoutMs and initialCredit are checked against the revision", async () => {
    const b = blockingDriver();
    const h = harness({ "gallery.pick": b.driver, "permission.query": b.driver });
    // activation lifetime with a connection owner
    h.client.handleMessage(galleryReq(1, { owner: { connection: true } }));
    // lifetime the revision does not allow (v1 is activation-only)
    h.client.handleMessage(galleryReq(2, { lifetime: "background", owner: { moduleInstanceId: "m1" } }));
    // activationId must be ≥ 1
    h.client.handleMessage(galleryReq(3, { owner: { moduleInstanceId: "m1", activationId: 0 } }));
    // timeoutMs beyond the revision bound (gallery.pick: 300 s)
    h.client.handleMessage(galleryReq(4, { timeoutMs: 300_001 }));
    // initialCredit beyond maxInitialCredit (gallery.pick: 4 MiB)
    h.client.handleMessage(galleryReq(5, { initialCredit: 4 * 1024 * 1024 + 1 }));
    // no data plane: initialCredit must be 0
    h.client.handleMessage(req({ id: 6, initialCredit: 1 }));
    await ticks(2);
    expect(b.state.runs).toBe(0);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
      [3, "invalidParams"],
      [4, "invalidParams"],
      [5, "invalidParams"],
      [6, "invalidParams"],
    ]);
  });

  test("a malformed deviceEvent on a live id terminates it invalidParams; on an unknown id it is ignored", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    h.client.handleMessage(req({ id: 1 }));
    await tick();
    // Unknown id: ignored entirely.
    h.client.handleMessage(control(9, { leaseAck: 1, grant: 5 }));
    // Control with two variants on the live id.
    h.client.handleMessage(control(1, { leaseAck: 1, grant: 5 }));
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[1, "invalidParams"]]);
    expect(b.state.stopped).toBe(1);
    expect(h.client.liveCount).toBe(0);
  });

  test("cancel must be exactly true; renewLease/grant must be ≥ 1", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    for (let id = 1; id <= 3; id++) h.client.handleMessage(req({ id }));
    await tick();
    h.client.handleMessage(control(1, { cancel: false }));
    h.client.handleMessage(control(2, { renewLease: 0 }));
    h.client.handleMessage(control(3, { grant: 0 }));
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
      [3, "invalidParams"],
    ]);
  });

  test("a server event payload (direction) or a grant on a data plane 'none' (credit) terminates invalidParams", async () => {
    // Shared fixtures: violation-event-from-server, violation-grant-without-data-plane.
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    h.client.handleMessage(req({ id: 1 }));
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    h.client.handleMessage({ type: "deviceEvent", id: 1, event: { kind: "progress", state: "running" } });
    h.client.handleMessage(control(2, { grant: 1 }));
    // Unknown ids stay ignored.
    h.client.handleMessage({ type: "deviceEvent", id: 9, event: { kind: "progress" } });
    h.client.handleMessage(control(9, { grant: 1 }));
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
    ]);
    expect(b.state.stopped).toBe(2);
    expect(h.client.liveCount).toBe(0);
  });

  test("wrong-direction controls (leaseAck, paused on a non-download) terminate invalidParams", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    h.client.handleMessage(req({ id: 1 }));
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    h.client.handleMessage(control(1, { leaseAck: 1 }));
    h.client.handleMessage(control(2, { paused: true }));
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
    ]);
  });

  test("handleMalformed: live id ⇒ invalidParams; fresh request id consumed and refused; unknown event ignored", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver });
    h.client.handleMessage(req({ id: 1 }));
    await tick();
    h.client.handleMalformed({ type: "deviceEvent", id: 1, control: { grant: 1 } }, "duplicate JSON key");
    h.client.handleMalformed({ type: "deviceEvent", id: 7, control: { grant: 1 } }, "duplicate JSON key");
    h.client.handleMalformed(req({ id: 2 }), "duplicate JSON key");
    // The consumed id can never execute afterwards.
    h.client.handleMessage(req({ id: 2 }));
    await ticks(2);
    expect(b.state.runs).toBe(1);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
    ]);
  });
});

describe("request ids and revision selection (RFC 001 §2.1 / §2.2 / §2.6)", () => {
  test("duplicate and older ids are dropped without executing again", async () => {
    let runs = 0;
    const h = harness({
      "permission.query": async () => {
        runs += 1;
        return { kind: "result", result: { status: "granted" } };
      },
    });
    h.client.handleMessage(req({ id: 7 }));
    h.client.handleMessage(req({ id: 7 }));
    h.client.handleMessage(req({ id: 3 }));
    await ticks(3);
    expect(runs).toBe(1);
    expect(h.responses().map((r) => r.id)).toEqual([7]);
  });

  test("only the negotiated (capability, version) is admitted; others are unsupported", async () => {
    let runs = 0;
    const ok: DeviceDriver = async () => {
      runs += 1;
      return { kind: "result", result: { status: "granted" } };
    };
    // A registry that knows a gallery.pick v2 (so only the selection refuses it).
    const registry = withRevisionOverride("gallery.pick", 2, { data: "binaryUpload", maxItems: 16, maxItemBytes: 1024, maxInitialCredit: 1024, maxOutstandingCredit: 1024 });
    const h = harness({ "permission.query": ok, "permission.request": ok, "gallery.pick": ok }, { registry });
    h.client.setSelection({
      protocolVersion: 1,
      binary: true,
      capabilities: [
        { name: "permission.query", version: 1 },
        { name: "gallery.pick", version: 1 },
      ],
    });
    h.client.handleMessage(req({ id: 1 })); // selected → runs
    h.client.handleMessage(req({ id: 2, capability: "permission.request" })); // not selected
    h.client.handleMessage(galleryReq(3, { version: 2, initialCredit: 0 })); // unadvertised revision
    h.client.handleMessage(galleryReq(4, { version: 99, initialCredit: 0 }));
    await ticks(3);
    expect(runs).toBe(1);
    expect(h.responses().map((r) => [r.id, r.error?.code ?? "ok"])).toEqual([
      [2, "unsupported"],
      [3, "unsupported"],
      [4, "unsupported"],
      [1, "ok"],
    ]);
  });

  test("a disabled device plane (ack undefined) refuses everything unsupported", async () => {
    let runs = 0;
    const h = harness({ "permission.query": async () => (runs++, { kind: "result", result: { status: "granted" } }) });
    h.client.setSelection(undefined);
    h.client.handleMessage(req({ id: 1 }));
    await ticks(2);
    expect(runs).toBe(0);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["unsupported"]);
  });

  test("without a selection, an unregistered revision is still unsupported (never the v1 driver)", async () => {
    let runs = 0;
    const h = harness({ "permission.query": async () => (runs++, { kind: "result", result: { status: "granted" } }) });
    h.client.handleMessage(req({ id: 1, version: 2 }));
    await ticks(2);
    expect(runs).toBe(0);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["unsupported"]);
  });
});

describe("leases (RFC 001 §2.7)", () => {
  test("the initial 15 s lease runs from receipt, even while the driver awaits consent; expiry ⇒ connectionLost + driver stopped", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request", timeoutMs: 300_000 }));
    await tick();
    h.clock.advance(14_999);
    await tick();
    expect(h.responses()).toEqual([]);
    h.clock.advance(1);
    await ticks(2);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 1, error: { code: "connectionLost", platformDetail: "lease expired" } },
    ]);
    expect(b.state.stopped).toBe(1);
    expect(h.client.liveCount).toBe(0);
    expect(h.clock.pending).toBe(0); // timers released
  });

  test("renewals start at 1, strictly increase (skips allowed), extend the lease and are acked", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request", timeoutMs: 300_000 }));
    await tick();
    h.client.handleMessage(control(1, { renewLease: 1 })); // t=0 → expires 15 000
    h.clock.advance(10_000);
    h.client.handleMessage(control(1, { renewLease: 3 })); // t=10 000 → expires 25 000 (2 was replaced)
    expect(h.acks(1)).toEqual([1, 3]);
    h.clock.advance(14_999);
    await tick();
    expect(h.responses()).toEqual([]);
    h.clock.advance(1); // 25 000
    await ticks(2);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["connectionLost"]);
    expect(b.state.stopped).toBe(1);
  });

  test("a repeated or decreasing renewal, or a first renewal other than 1, terminates invalidParams (shared fixtures)", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    for (const id of [1, 2, 3]) h.client.handleMessage(req({ id, capability: "permission.request" }));
    await tick();
    h.client.handleMessage(control(1, { renewLease: 1 }));
    h.client.handleMessage(control(1, { renewLease: 1 })); // repeat
    h.client.handleMessage(control(2, { renewLease: 1 }));
    h.client.handleMessage(control(2, { renewLease: 2 }));
    h.client.handleMessage(control(2, { renewLease: 1 })); // decrease
    h.client.handleMessage(control(3, { renewLease: 2 })); // does not start at 1
    await ticks(2);
    expect(h.acks(1)).toEqual([1]);
    expect(h.acks(2)).toEqual([1, 2]);
    expect(h.acks(3)).toEqual([]);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [1, "invalidParams"],
      [2, "invalidParams"],
      [3, "invalidParams"],
    ]);
    expect(b.state.stopped).toBe(3);
  });

  test("lease sequences are u32: 4294967295 is acked, 4294967296 terminates invalidParams", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request" }));
    h.client.handleMessage(req({ id: 2, capability: "permission.request" }));
    await tick();
    h.client.handleMessage(control(1, { renewLease: 1 }));
    h.client.handleMessage(control(1, { renewLease: 0xffff_ffff }));
    h.client.handleMessage(control(2, { renewLease: 0x1_0000_0000 }));
    await ticks(2);
    expect(h.acks(1)).toEqual([1, 0xffff_ffff]);
    expect(h.acks(2)).toEqual([]);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[2, "invalidParams"]]);
    expect(h.client.liveCount).toBe(1);
  });

  test("renewals for unknown or retired ids are never acked and never revive anything", async () => {
    const h = harness({
      "permission.query": async () => ({ kind: "result", result: { status: "granted" } }),
    });
    h.client.handleMessage(control(999, { renewLease: 1 }));
    h.client.handleMessage(req({ id: 1 }));
    await ticks(3); // completes
    h.client.handleMessage(control(1, { renewLease: 1 }));
    await ticks(1);
    expect(h.acks(999)).toEqual([]);
    expect(h.acks(1)).toEqual([]);
    expect(h.responses().length).toBe(1);
    expect(h.client.liveCount).toBe(0);
  });

  test("a renewal queued after expiry (timers suspended) is not acked: the op ends connectionLost", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request", timeoutMs: 300_000 }));
    await tick();
    h.clock.t = 16_000; // time moved on without the timer firing
    h.client.handleMessage(control(1, { renewLease: 1 }));
    await ticks(2);
    expect(h.acks(1)).toEqual([]);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["connectionLost"]);
  });

  test("grants and data never refresh the lease", async () => {
    const b = blockingDriver();
    const h = harness({ "bluetooth.scan": b.driver });
    h.client.handleMessage(scanReq(1, 0));
    await tick();
    h.clock.advance(10_000);
    h.client.handleMessage(control(1, { grant: 4 }));
    b.state.ctx!.emit({ device: { id: "a", rssi: -40 } });
    h.clock.advance(5_000);
    await ticks(2);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["connectionLost"]);
  });
});

describe("local deadline for every driver (RFC 001 §2.1)", () => {
  test("min(timeoutMs, local maximum) from receipt ⇒ terminal timeout, driver stopped", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.query": b.driver, "bluetooth.scan": b.driver }, { maxTimeoutMs: 2_000 });
    h.client.handleMessage(req({ id: 1, timeoutMs: 5_000 })); // host-supplied-style driver, no prompt
    h.client.handleMessage(req({ id: 2, capability: "bluetooth.scan", timeoutMs: 1_000, initialCredit: 0, params: {} }));
    await tick();
    h.clock.advance(1_000);
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[2, "timeout"]]);
    h.clock.advance(1_000); // local maximum wins over timeoutMs 5 000
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([
      [2, "timeout"],
      [1, "timeout"],
    ]);
    expect(b.state.stopped).toBe(2);
  });

  test("renewals never extend the overall deadline", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request", timeoutMs: 12_000 }));
    await tick();
    for (let seq = 1; seq <= 3; seq++) {
      h.client.handleMessage(control(1, { renewLease: seq }));
      h.clock.advance(5_000);
      await tick();
    }
    expect(h.responses().map((r) => r.error?.code)).toEqual(["timeout"]);
  });

  test("the connection-owned control stream is bounded by its revision, not the host's per-request maximum", async () => {
    const b = blockingDriver();
    const h = harness({ "core.capabilities": b.driver }, { maxTimeoutMs: 2_000 });
    h.client.handleMessage(capsReq(1, 8));
    await tick();
    for (let seq = 1; seq <= 2; seq++) {
      h.client.handleMessage(control(1, { renewLease: seq }));
      h.clock.advance(5_000);
    }
    await ticks(2);
    expect(h.responses()).toEqual([]);
    expect(h.client.liveCount).toBe(1);
  });
});

describe("server cancel (RFC 001 §2.1)", () => {
  test("cancel on a live op stops the driver and sends terminal cancelled once", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request" }));
    await tick();
    h.client.handleMessage(control(1, { cancel: true }));
    h.client.handleMessage(control(1, { cancel: true })); // retired: ignored
    await ticks(2);
    expect(h.responses()).toEqual([{ type: "deviceResponse", id: 1, error: { code: "cancelled" } }]);
    expect(b.state.stopped).toBe(1);
  });

  test("an OS dialog that finishes after cancel never uploads", async () => {
    let finishPicker!: () => void;
    const pickerDone = new Promise<void>((r) => (finishPicker = r));
    const h = harness({
      // Undismissable picker: ignores cancellation, returns a photo later.
      "gallery.pick": async () => {
        await pickerDone;
        return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: new Uint8Array(32) }] };
      },
    });
    h.client.handleMessage(galleryReq(1));
    await tick();
    h.client.handleMessage(control(1, { cancel: true }));
    finishPicker();
    await ticks(4);
    expect(h.frames.length).toBe(0);
    expect(h.events(1)).toEqual([]); // no blobStart
    expect(h.responses()).toEqual([{ type: "deviceResponse", id: 1, error: { code: "cancelled" } }]);
  });

  test("detach stops every driver silently and releases timers", async () => {
    const b = blockingDriver();
    const h = harness({ "permission.request": b.driver });
    h.client.handleMessage(req({ id: 1, capability: "permission.request" }));
    h.client.handleMessage(req({ id: 2, capability: "permission.request" }));
    await tick();
    h.client.detach();
    h.client.detach(); // idempotent
    await ticks(2);
    expect(b.state.stopped).toBe(2);
    expect(h.responses()).toEqual([]);
    expect(h.clock.pending).toBe(0);
  });
});

describe("driver output limits", () => {
  test("an item over the revision's maxItemBytes is refused throttled before any byte is sent", async () => {
    const registry = withRevisionOverride("gallery.pick", 1, { maxItemBytes: 4 });
    const h = harness(
      {
        "gallery.pick": async () => ({
          kind: "result",
          result: {},
          blobs: [{ channel: 0, contentType: "image/jpeg", bytes: new Uint8Array(5) }],
        }),
      },
      { registry }
    );
    h.client.handleMessage(galleryReq(1));
    await ticks(3);
    expect(h.frames.length).toBe(0);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["throttled"]);
  });

  test("a driver result violating the result schema degrades to internal", async () => {
    const h = harness({
      "permission.query": async () => ({ kind: "result", result: { status: "maybe" } }),
    });
    h.client.handleMessage(req({ id: 1 }));
    await ticks(3);
    expect(h.responses()[0]!.error?.code).toBe("internal");
  });
});

describe("JSON-stream event credit (RFC 001 §2.2 / §2.3)", () => {
  const snapshot = (n: number) => ({ capabilities: [{ name: `cap.${n}`, versions: [1] }] });

  test("core.capabilities: sends within credit, coalesces to one latest snapshot beyond it", async () => {
    const b = blockingDriver();
    const h = harness({ "core.capabilities": b.driver });
    h.client.handleMessage(capsReq(1, 1));
    await tick();
    const emit = b.state.ctx!.emit;
    emit(snapshot(1)); // spends the single credit
    emit(snapshot(2));
    emit(snapshot(3)); // replaces 2
    expect(h.events(1)).toEqual([snapshot(1)]);
    h.client.handleMessage(control(1, { grant: 4 }));
    expect(h.events(1)).toEqual([snapshot(1), snapshot(3)]);
    emit(snapshot(4)); // credit available now
    expect(h.events(1)).toEqual([snapshot(1), snapshot(3), snapshot(4)]);
    expect(h.controls(1, "paused")).toEqual([]);
  });

  test("bluetooth.scan (dropOldest): bounded queue drops the oldest; never sends beyond credit", async () => {
    const b = blockingDriver();
    const h = harness({ "bluetooth.scan": b.driver }, { maxQueuedEvents: 2 });
    h.client.handleMessage(scanReq(1, 0));
    await tick();
    const ev = (id: string) => ({ device: { id, rssi: -50 } });
    for (const id of ["a", "b", "c"]) b.state.ctx!.emit(ev(id));
    expect(h.events(1)).toEqual([]);
    h.client.handleMessage(control(1, { grant: 1 }));
    expect(h.events(1)).toEqual([ev("b")]);
    h.client.handleMessage(control(1, { grant: 5 }));
    expect(h.events(1)).toEqual([ev("b"), ev("c")]);
  });

  test("pause policy: reports paused once, resumes on grant, overflow of the bound ⇒ throttled", async () => {
    const b = blockingDriver();
    const h = harness(
      { "bluetooth.scan": b.driver },
      { maxQueuedEvents: 2, jsonEventOverflow: () => "pause" as const }
    );
    h.client.handleMessage(scanReq(2, 0));
    await tick();
    const ev = (id: string) => ({ device: { id, rssi: -50 } });
    const ctx2 = b.state.ctx!;
    ctx2.emit(ev("x"));
    ctx2.emit(ev("y"));
    expect(h.controls(2, "paused")).toEqual([true]);
    h.client.handleMessage(control(2, { grant: 2 }));
    expect(h.events(2)).toEqual([ev("x"), ev("y")]);
    expect(h.controls(2, "paused")).toEqual([true, false]);
    ctx2.emit(ev("1"));
    ctx2.emit(ev("2"));
    ctx2.emit(ev("3")); // bound 2 exceeded
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[2, "throttled"]]);
  });

  test("a grant overflowing max outstanding credit terminates invalidParams", async () => {
    const b = blockingDriver();
    const h = harness({ "core.capabilities": b.driver });
    h.client.handleMessage(capsReq(1, 8));
    await tick();
    h.client.handleMessage(control(1, { grant: 57 })); // 8 + 57 > 64
    await ticks(2);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["invalidParams"]);
  });

  test("an event violating the revision's event schema is never sent", async () => {
    const b = blockingDriver();
    const h = harness({ "bluetooth.scan": b.driver });
    h.client.handleMessage(scanReq(1, 4));
    await tick();
    b.state.ctx!.emit({ device: { id: "a" } }); // missing rssi
    await ticks(2);
    expect(h.events(1)).toEqual([]);
    expect(h.responses().map((r) => r.error?.code)).toEqual(["internal"]);
  });
});
