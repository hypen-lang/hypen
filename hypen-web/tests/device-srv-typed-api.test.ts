/**
 * Device Capability Protocol — round 3 server side (RFC 001 §4, P1/C2/C3/C4).
 *
 *   - streamed binary uploads (`device.stream(…, { onData })`, `mic.record`):
 *     bytes delivered in order and never buffered, credit replenished as
 *     `onData` returns, the terminal `sha256` verified over everything
 *     delivered, success settled only after the last chunk was delivered,
 *     budgets charged only while a chunk awaits its consumer;
 *   - `camera.capture` as a unary one-item upload whose content type must fit
 *     the requested mode;
 *   - `bluetooth.select` (JSON result, no data plane);
 *   - the typed surface at runtime: `requestUntyped` / `streamUntyped`, the
 *     convenience wrappers, the closed permission enum;
 *   - the advertisement (every v1 capability now has a consuming API) and a
 *     full RemoteSession ↔ DeviceClient run with a module handler.
 *
 * Compile-time behaviour (unknown names, `{ permission: "camra" }`, photo +
 * maxDurationMs …) is pinned by packages/server/typetests/device-api.typetest.ts,
 * which `bun run typecheck` compiles.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import {
  DeviceContext,
  DEVICE_PERMISSIONS,
  encodeFrame,
  sha256Hex,
  DEVICE_REGISTRY,
  type DeviceAck,
  type DeviceBrokerConfig,
  type DevicePlane,
  type DeviceRequest,
  type DeviceResult,
  type DeviceSettlement,
} from "@hypen-space/core/remote/device";
import { FakeDeviceHost } from "@hypen-space/device-fake";
import { WasmRetainedBytesPool } from "../packages/server/src/device-broker";
import {
  deviceConstants,
  deviceServerAdvertisement,
  deviceServerConsumes,
} from "../packages/server/wasm-node/hypen_engine.js";
import {
  FakeClock,
  controlsFor,
  deviceHello,
  flush,
  fullAck,
  loopback,
  makeHost,
  makePlane,
  makeTransport,
  requestsOf,
  spec,
} from "./device-srv-harness";

const owner = { moduleInstanceId: "profile-7", activationId: 3 };
const micParams = { format: "pcm16", sampleRate: 16_000 };
/** The broker's default drain deadline: Rust owns it (`deviceConstants()`). */
const STREAM_DRAIN_TIMEOUT_MS = (deviceConstants() as { streamDrainTimeoutMs: number }).streamDrainTimeoutMs;

const frame = (id: number | null, seq: number, payload: Uint8Array, channel = 0) =>
  encodeFrame({ version: 1, flags: 0, channel, requestId: id!, seq }, payload);
const blobStart = (id: number | null, contentType: string, bytes?: number, channel = 0) => ({
  type: "deviceEvent",
  id,
  event: { kind: "blobStart", channel, contentType, ...(bytes !== undefined ? { bytes } : {}) },
});
const bytesOf = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 7 + seed) & 0xff);
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};
const grantsOf = (sent: any[], id: number | null) =>
  sent.filter((m: any) => m.id === id && m.control?.grant !== undefined).map((m: any) => m.control.grant as number);
const cancelsOf = (sent: any[], id: number | null) =>
  sent.filter((m: any) => m.id === id && m.control?.cancel === true).length;

type Broker = DevicePlane & { receive: (m: object | string) => boolean };

/**
 * The Rust broker through the port (plane + fake clock) with the owners
 * these tests use registered; the control stream's lease is acknowledged so
 * long clock advances only exercise the request under test.
 */
function brokerWith(
  config: Omit<DeviceBrokerConfig, "ack"> = {},
  opts: { pool?: WasmRetainedBytesPool; clock?: FakeClock } = {}
) {
  const h = makePlane({
    config,
    autoAck: "core",
    owners: [["profile-7", 3], ["someone-else", 1]],
    ...(opts.pool ? { pool: opts.pool } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const broker = Object.assign(h.plane, { receive: h.receive }) as Broker;
  return { broker, sent: h.sent, clock: h.clock };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Open a streamed mic.record upload on a bare broker. */
function openMic(
  broker: DevicePlane,
  onData: (chunk: Uint8Array) => void | Promise<unknown>,
  initialCredit = 262_144,
  params: Record<string, unknown> = micParams
) {
  let settled: DeviceSettlement | null = null;
  const h = broker.open(spec("mic.record", params, { ...owner, timeoutMs: 600_000, initialCredit, onData }));
  void h.settled.then((s) => (settled = s));
  return { h, settled: () => settled };
}

const micResult = async (id: number | null, payload: Uint8Array, durationMs = 5) => ({
  type: "deviceResponse",
  id,
  result: {
    durationMs,
    item: { channel: 0, contentType: "audio/L16", bytes: payload.byteLength, sha256: await sha256Hex(payload) },
  },
});

// ---------------------------------------------------------------------------
// C3 — streamed uploads (onData)
// ---------------------------------------------------------------------------

describe("streamed upload (onData): delivery, credit, verification", () => {
  test("bytes arrive in order, unbuffered; success settles with the verified result; nothing stays charged", async () => {
    const { broker } = brokerWith();
    const got: Uint8Array[] = [];
    const { h, settled } = openMic(broker, (c) => void got.push(c));
    broker.receive(blobStart(h.id, "audio/L16"));
    const payload = bytesOf(200_000);
    let seq = 0;
    for (let off = 0; off < payload.byteLength; off += 65_536) {
      expect(broker.receiveFrame(frame(h.id, seq++, payload.subarray(off, off + 65_536)))).toBe(true);
      // A synchronous consumer is done at once: nothing is retained.
      expect(broker.retainedBytes).toBe(0);
    }
    broker.receive(await micResult(h.id, payload, 6_250));
    await flush();
    const s = settled()!;
    expect("result" in s).toBe(true);
    if (!("result" in s)) return;
    expect(s.result).toEqual({
      durationMs: 6_250,
      item: { channel: 0, contentType: "audio/L16", bytes: payload.byteLength, sha256: await sha256Hex(payload) },
    });
    expect(s.blobs).toEqual([]); // the bytes went to onData, not a buffer
    expect(concat(got)).toEqual(payload);
    expect(got.length).toBe(4);
    expect(broker.retainedBytes).toBe(0);
  });

  test("credit is replenished only as onData returns (a slow consumer backpressures the recorder)", async () => {
    const { broker, sent } = brokerWith();
    const gates: Array<ReturnType<typeof deferred>> = [];
    const { h } = openMic(broker, () => {
      const d = deferred();
      gates.push(d);
      return d.promise;
    }, 16);
    broker.receive(blobStart(h.id, "audio/L16"));
    expect(broker.receiveFrame(frame(h.id, 0, bytesOf(8)))).toBe(true);
    expect(broker.receiveFrame(frame(h.id, 1, bytesOf(8)))).toBe(true);
    // 16 of 16 credit spent, the consumer is still on chunk 1: no grant.
    expect(broker.outstandingCredit(h.id)).toBe(0);
    expect(grantsOf(sent, h.id)).toEqual([]);
    expect(gates.length).toBe(1); // one call at a time
    gates[0]!.resolve();
    await flush();
    expect(gates.length).toBe(2); // chunk 2 now delivered
    expect(grantsOf(sent, h.id)).toEqual([8]); // chunk 1 consumed: half window
    gates[1]!.resolve();
    await flush();
    expect(grantsOf(sent, h.id)).toEqual([8, 8]);
    expect(broker.outstandingCredit(h.id)).toBe(16);
    h.cancel();
  });

  test("a paused sender gets the window topped up only once the consumer caught up", async () => {
    const { broker, sent } = brokerWith();
    const gate = deferred();
    const { h } = openMic(broker, () => gate.promise, 16);
    broker.receive(blobStart(h.id, "audio/L16"));
    expect(broker.receiveFrame(frame(h.id, 0, bytesOf(16)))).toBe(true);
    broker.receive({ type: "deviceEvent", id: h.id, control: { paused: true } });
    expect(grantsOf(sent, h.id)).toEqual([]); // consumer still busy: no top-up
    gate.resolve();
    await flush();
    // 16 consumed → re-granted, then the paused sender is widened to one
    // maximum-size chunk so a chunk larger than the initial credit fits.
    expect(grantsOf(sent, h.id).reduce((a, b) => a + b, 0)).toBe(65_536);
    expect(broker.outstandingCredit(h.id)).toBe(65_536);
    broker.receive({ type: "deviceEvent", id: h.id, control: { paused: false } });
    expect(broker.receiveFrame(frame(h.id, 1, bytesOf(19)))).toBe(true);
    h.cancel();
  });

  test("the terminal waits for queued chunks: settled resolves after the last onData", async () => {
    const { broker } = brokerWith();
    const gates: Array<ReturnType<typeof deferred>> = [];
    const got: Uint8Array[] = [];
    const { h, settled } = openMic(broker, (c) => {
      got.push(c);
      const d = deferred();
      gates.push(d);
      return d.promise;
    });
    broker.receive(blobStart(h.id, "audio/L16"));
    const parts = [bytesOf(100, 1), bytesOf(100, 2), bytesOf(100, 3)];
    parts.forEach((p, i) => expect(broker.receiveFrame(frame(h.id, i, p))).toBe(true));
    broker.receive(await micResult(h.id, concat(parts)));
    await flush();
    expect(broker.isLive(h.id)).toBe(false); // id retired at the terminal
    expect(settled()).toBeNull(); // …but not settled while chunks are pending
    expect(broker.retainedBytes).toBeGreaterThan(0); // queued chunks are charged
    for (let i = 0; i < 3; i++) {
      expect(settled()).toBeNull();
      gates[i]!.resolve();
      await flush();
    }
    expect(settled()).toMatchObject({ result: { item: { bytes: 300 } } });
    expect(concat(got)).toEqual(concat(parts));
    expect(broker.retainedBytes).toBe(0);
  });

  test("a sha256 that does not match what was delivered settles invalidParams (no cancel: the client's own terminal)", async () => {
    const { broker, sent } = brokerWith();
    const { h, settled } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16"));
    const payload = bytesOf(64);
    broker.receiveFrame(frame(h.id, 0, payload));
    const res = await micResult(h.id, payload);
    res.result.item.sha256 = await sha256Hex(bytesOf(64, 9));
    broker.receive(res);
    await flush();
    expect(settled()).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/sha256/) } });
    expect(cancelsOf(sent, h.id)).toBe(0);
  });

  test("a byte count that differs from what was delivered is invalidParams", async () => {
    const { broker } = brokerWith();
    const { h, settled } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16"));
    broker.receiveFrame(frame(h.id, 0, bytesOf(64)));
    const res = await micResult(h.id, bytesOf(65));
    broker.receive(res);
    await flush();
    expect(settled()).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("cancel discards undelivered chunks: onData is not called again and every charge is released", async () => {
    const { broker } = brokerWith();
    let calls = 0;
    const gate = deferred();
    const { h, settled } = openMic(broker, () => {
      calls += 1;
      return gate.promise;
    });
    broker.receive(blobStart(h.id, "audio/L16"));
    for (let i = 0; i < 3; i++) broker.receiveFrame(frame(h.id, i, bytesOf(2048, i)));
    expect(calls).toBe(1);
    expect(broker.retainedBytes).toBe(3 * 2048);
    h.cancel();
    await flush();
    expect(settled()).toEqual({ error: { code: "cancelled" } });
    expect(broker.retainedBytes).toBe(0);
    gate.resolve();
    await flush();
    expect(calls).toBe(1);
    expect(broker.retainedBytes).toBe(0);
  });

  test("chunks awaiting the consumer count against the connection budget (throttled beyond it)", async () => {
    const { broker } = brokerWith({ maxRetainedBytes: 4096, minFrameCharge: 1024 });
    const { h, settled } = openMic(broker, () => new Promise(() => {})); // never done
    broker.receive(blobStart(h.id, "audio/L16"));
    let accepted = 0;
    for (let seq = 0; seq < 10; seq++) {
      if (broker.receiveFrame(frame(h.id, seq, bytesOf(1000)))) accepted++;
      else break;
    }
    expect(accepted).toBe(4); // 4 × max(1000, 1024) = 4096
    await flush();
    expect(settled()).toMatchObject({ error: { code: "throttled" } });
    expect(broker.retainedBytes).toBe(0);
  });

  test("a declared size is checked but not reserved: the stream retains nothing up front", () => {
    const { broker } = brokerWith({ maxRetainedBytes: 1024 * 1024 });
    const { h } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16", 60 * 1024 * 1024));
    expect(broker.isLive(h.id)).toBe(true);
    expect(broker.retainedBytes).toBe(0);
    h.cancel();
  });

  test("maxItemBytes is enforced as bytes arrive", async () => {
    const { broker } = brokerWith({ revisionOverrides: [{ capability: "mic.record", version: 1, maxItemBytes: 100 }] });
    const { h, settled } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16"));
    expect(broker.receiveFrame(frame(h.id, 0, bytesOf(60)))).toBe(true);
    expect(broker.receiveFrame(frame(h.id, 1, bytesOf(60)))).toBe(false);
    await flush();
    expect(settled()).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/max item bytes/) } });
  });

  test("a throwing consumer still consumed its chunk (credit keeps flowing, the hash covers it)", async () => {
    const { broker, sent } = brokerWith();
    const { h, settled } = openMic(broker, () => {
      throw new Error("app bug");
    }, 64);
    broker.receive(blobStart(h.id, "audio/L16"));
    const parts = [bytesOf(64, 1), bytesOf(64, 2)];
    expect(broker.receiveFrame(frame(h.id, 0, parts[0]!))).toBe(true);
    expect(broker.receiveFrame(frame(h.id, 1, parts[1]!))).toBe(true);
    expect(grantsOf(sent, h.id)).toEqual([64, 64]);
    broker.receive(await micResult(h.id, concat(parts)));
    await flush();
    expect(settled()).toMatchObject({ result: { item: { bytes: 128 } } });
  });

  test("thousands of tiny frames through a synchronous consumer (iterative delivery, batched grants)", async () => {
    const { broker, sent } = brokerWith();
    let n = 0;
    const { h, settled } = openMic(broker, (c) => void (n += c.byteLength), 4096);
    broker.receive(blobStart(h.id, "audio/L16"));
    const payload = bytesOf(20_000);
    for (let i = 0; i < payload.byteLength; i++) {
      expect(broker.receiveFrame(frame(h.id, i, payload.subarray(i, i + 1)))).toBe(true);
    }
    expect(grantsOf(sent, h.id).every((g) => g === 2048)).toBe(true);
    broker.receive(await micResult(h.id, payload));
    await flush();
    expect(n).toBe(20_000);
    expect(settled()).toMatchObject({ result: { item: { bytes: 20_000 } } });
  });

  test("an empty recording (no frames) verifies against the empty hash", async () => {
    const { broker } = brokerWith();
    const { h, settled } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16"));
    broker.receive(await micResult(h.id, new Uint8Array(0), 0));
    await flush();
    expect(settled()).toMatchObject({ result: { item: { bytes: 0, sha256: await sha256Hex(new Uint8Array(0)) } } });
  });

  test("a second item on mic.record (maxItems 1) is a violation", async () => {
    const { broker, sent } = brokerWith();
    const { h, settled } = openMic(broker, () => {});
    broker.receive(blobStart(h.id, "audio/L16"));
    broker.receive(blobStart(h.id, "audio/L16", undefined, 1));
    await flush();
    expect(settled()).toMatchObject({ error: { code: "invalidParams" } });
    expect(cancelsOf(sent, h.id)).toBe(1);
  });

  test("without onData a binary stream never buffers: its bytes are consumed at once and the result still verifies", async () => {
    // The Rust broker streams every binary-upload STREAM revision; a plane
    // without a consumer takes each chunk and hands its credit back.
    const { broker, sent } = brokerWith();
    const h = broker.open(spec("mic.record", micParams, { ...owner, timeoutMs: 600_000, initialCredit: 1024 }));
    broker.receive(blobStart(h.id, "audio/L16"));
    const payload = bytesOf(1024);
    expect(broker.receiveFrame(frame(h.id, 0, payload))).toBe(true);
    expect(broker.retainedBytes).toBe(0);
    expect(grantsOf(sent, h.id).reduce((a, b) => a + b, 0)).toBe(1024); // credit came back
    broker.receive(await micResult(h.id, payload));
    const s = await h.settled;
    expect("result" in s && s.blobs).toEqual([]);
    expect(s).toMatchObject({ result: { item: { bytes: 1024, sha256: await sha256Hex(payload) } } });
  });
});

// ---------------------------------------------------------------------------
// C3 — a consumer that never returns after the success terminal
// ---------------------------------------------------------------------------

/** Accept `parts` for a streamed mic.record, then its verified success terminal. */
async function streamThenTerminal(broker: Broker, id: number | null, parts: Uint8Array[]) {
  broker.receive(blobStart(id, "audio/L16"));
  parts.forEach((p, i) => expect(broker.receiveFrame(frame(id, i, p))).toBe(true));
  broker.receive(await micResult(id, concat(parts)));
  await flush();
}

describe("streamed upload (onData): a consumer that never returns after the success terminal", () => {
  const hung = () => new Promise<never>(() => {});

  test("cancel() abandons the drain: settles cancelled, releases every charge, sends nothing (the id is retired)", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const { broker, sent } = brokerWith({}, { pool });
    const gate = deferred();
    let calls = 0;
    const { h, settled } = openMic(broker, () => {
      calls += 1;
      return gate.promise;
    });
    await streamThenTerminal(broker, h.id, [bytesOf(2000, 1), bytesOf(2000, 2)]);
    expect(settled()).toBeNull();
    expect(broker.isLive(h.id!)).toBe(false);
    expect(broker.drainingCount).toBe(1);
    expect(broker.retainedBytes).toBe(4000); // 2 × max(2000, 1 KiB)
    expect(pool.inUse()).toBe(4000);
    const sentBefore = sent.length;

    h.cancel();
    await flush();
    expect(settled()).toEqual({ error: { code: "cancelled" } });
    expect(broker.retainedBytes).toBe(0);
    expect(pool.inUse()).toBe(0);
    expect(broker.drainingCount).toBe(0);
    expect(sent.length).toBe(sentBefore); // no cancel for a retired id (§2.1)

    // The stalled call finally returns: nothing is delivered or released twice.
    gate.resolve();
    await flush();
    expect(calls).toBe(1);
    expect(broker.retainedBytes).toBe(0);
    expect(pool.inUse()).toBe(0);
    h.cancel(); // idempotent
    broker.close();
    await flush();
    expect(settled()).toEqual({ error: { code: "cancelled" } });
    expect(pool.inUse()).toBe(0);
  });

  test("close() reaches a draining request: settles connectionLost and returns the shared pool to 0", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const { broker } = brokerWith({}, { pool });
    const { h, settled } = openMic(broker, hung);
    await streamThenTerminal(broker, h.id, [bytesOf(3000)]);
    expect(pool.inUse()).toBe(3000);
    expect(broker.retainedBytes).toBe(3000);
    expect(settled()).toBeNull();

    broker.close();
    await flush();
    expect(settled()).toEqual({ error: { code: "connectionLost" } });
    expect(broker.retainedBytes).toBe(0);
    expect(pool.inUse()).toBe(0);
    expect(broker.drainingCount).toBe(0);
  });

  test("close(code) settles the drain with that code; another connection's pool charge is untouched", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const a = brokerWith({}, { pool });
    const b = brokerWith({}, { pool });
    const ra = openMic(a.broker, hung);
    const rb = openMic(b.broker, hung);
    await streamThenTerminal(a.broker, ra.h.id, [bytesOf(1500)]);
    await streamThenTerminal(b.broker, rb.h.id, [bytesOf(2500)]);
    expect(pool.inUse()).toBe(4000);
    a.broker.close("revoked");
    await flush();
    expect(ra.settled()).toEqual({ error: { code: "revoked" } });
    expect(rb.settled()).toBeNull();
    expect(pool.inUse()).toBe(2500);
    b.broker.close();
    await flush();
    expect(rb.settled()).toEqual({ error: { code: "connectionLost" } });
    expect(pool.inUse()).toBe(0);
  });

  test("sweepActivation (deactivate / destroy) reaches a draining request of that owner only", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const { broker } = brokerWith({}, { pool });
    const mine = openMic(broker, hung);
    let otherSettled: DeviceSettlement | null = null;
    const other = broker.open(
      spec("mic.record", micParams, {
        moduleInstanceId: "someone-else",
        activationId: 1,
        timeoutMs: 600_000,
        initialCredit: 262_144,
        onData: hung,
      })
    );
    void other.settled.then((s) => (otherSettled = s));
    await streamThenTerminal(broker, mine.h.id, [bytesOf(1024)]);
    await streamThenTerminal(broker, other.id, [bytesOf(2048)]);
    expect(broker.drainingCount).toBe(2);

    broker.ownerDeactivated("profile-7", 3); // deactivate: that activation only
    await flush();
    expect(mine.settled()).toEqual({ error: { code: "cancelled" } });
    expect(otherSettled).toBeNull();
    expect(broker.retainedBytes).toBe(2048);
    expect(pool.inUse()).toBe(2048);

    broker.ownerDestroyed("someone-else"); // destroy: every activation
    await flush();
    expect(otherSettled).toEqual({ error: { code: "cancelled" } });
    expect(broker.retainedBytes).toBe(0);
    expect(pool.inUse()).toBe(0);
    expect(broker.drainingCount).toBe(0);
  });

  test("the drain deadline: no consumer progress for drainTimeoutMs settles timeout and releases everything", async () => {
    expect(STREAM_DRAIN_TIMEOUT_MS).toBe(30_000);
    const pool = new WasmRetainedBytesPool(1 << 20);
    const c = new FakeClock();
    const { broker } = brokerWith({ drainTimeoutMs: 5_000 }, { pool, clock: c });
    const { h, settled } = openMic(broker, hung);
    await streamThenTerminal(broker, h.id, [bytesOf(4000)]);
    expect(settled()).toBeNull();
    expect(c.pending).toBe(1); // one timer per connection, re-armed from the next deadline
    c.advance(4_000);
    await flush();
    expect(settled()).toBeNull();
    expect(pool.inUse()).toBe(4000);
    c.advance(1_000);
    await flush();
    expect(settled()).toEqual({ error: { code: "timeout" } });
    expect(broker.retainedBytes).toBe(0);
    expect(pool.inUse()).toBe(0);
    expect(broker.drainingCount).toBe(0);
    expect(c.pending).toBeLessThanOrEqual(1);
  });

  test("the default drain deadline applies without options", async () => {
    const c = new FakeClock();
    const { broker } = brokerWith({}, { clock: c });
    const { h, settled } = openMic(broker, hung);
    await streamThenTerminal(broker, h.id, [bytesOf(1000)]);
    c.advance(STREAM_DRAIN_TIMEOUT_MS - 1_000);
    await flush();
    expect(settled()).toBeNull();
    c.advance(1_000);
    await flush();
    expect(settled()).toEqual({ error: { code: "timeout" } });
    expect(broker.retainedBytes).toBe(0);
  });

  test("the drain deadline is progress-based: a slow consumer that keeps finishing chunks still settles with the result", async () => {
    const c = new FakeClock();
    const { broker } = brokerWith({ drainTimeoutMs: 5_000 }, { clock: c });
    const gates: Array<ReturnType<typeof deferred>> = [];
    const got: Uint8Array[] = [];
    const { h, settled } = openMic(broker, (chunk) => {
      got.push(chunk);
      const d = deferred();
      gates.push(d);
      return d.promise;
    });
    const parts = [bytesOf(1000, 1), bytesOf(1000, 2), bytesOf(1000, 3), bytesOf(1000, 4)];
    await streamThenTerminal(broker, h.id, parts);
    // Each chunk takes 4 s — 16 s in all, far past the 5 s window, but never
    // 5 s without progress.
    for (let i = 0; i < parts.length; i++) {
      c.advance(4_000);
      await flush();
      expect(settled()).toBeNull();
      gates[i]!.resolve();
      await flush();
    }
    expect(settled()).toMatchObject({ result: { item: { bytes: 4000 } } });
    expect(concat(got)).toEqual(concat(parts));
    expect(broker.retainedBytes).toBe(0);
    expect(broker.drainingCount).toBe(0);
    expect(c.pending).toBeLessThanOrEqual(1);
  });

  test("the request's overall deadline still applies while draining", async () => {
    const c = new FakeClock();
    const { broker } = brokerWith({ drainTimeoutMs: 60_000 }, { clock: c });
    let settled: DeviceSettlement | null = null;
    const h = broker.open(spec("mic.record", micParams, { ...owner, timeoutMs: 3_000, initialCredit: 262_144, onData: hung }));
    void h.settled.then((s) => (settled = s));
    await streamThenTerminal(broker, h.id, [bytesOf(2000)]);
    c.advance(2_000);
    await flush();
    expect(settled).toBeNull();
    c.advance(1_000);
    await flush();
    expect(settled).toEqual({ error: { code: "timeout" } });
    expect(broker.retainedBytes).toBe(0);
  });

  test("a failure terminal while the consumer is stalled still discards and releases at once (unchanged)", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const { broker } = brokerWith({}, { pool });
    const { h, settled } = openMic(broker, hung);
    broker.receive(blobStart(h.id, "audio/L16"));
    broker.receiveFrame(frame(h.id, 0, bytesOf(2000)));
    broker.receive({ type: "deviceResponse", id: h.id, error: { code: "denied" } });
    await flush();
    expect(settled()).toEqual({ error: { code: "denied" } });
    expect(broker.drainingCount).toBe(0);
    expect(pool.inUse()).toBe(0);
  });

  test("DeviceContext stream cancel() reaches the drain (the typed API path)", async () => {
    const pool = new WasmRetainedBytesPool(1 << 20);
    const { broker } = brokerWith({}, { pool });
    const ctx = new DeviceContext(broker, owner, "origin");
    const rec = ctx.stream("mic.record", { format: "pcm16", sampleRate: 16_000 }, {}, { onData: hung });
    let outcome: unknown = null;
    void rec.settled.then((r) => (outcome = r));
    await streamThenTerminal(broker, rec.id, [bytesOf(2000)]);
    expect(outcome).toBeNull();
    expect(pool.inUse()).toBe(2000);
    rec.cancel();
    await flush();
    expect(outcome).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(pool.inUse()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C2 — camera.capture: unary upload, one item, content type fits the mode
// ---------------------------------------------------------------------------

function openCamera(broker: DevicePlane, params: Record<string, unknown>) {
  return broker.open(spec("camera.capture", params, { ...owner, timeoutMs: 600_000, initialCredit: 65_536 }));
}

describe("camera.capture on the broker", () => {
  for (const [mode, ok, bad] of [
    ["photo", ["image/jpeg", "image/heic"], ["video/mp4", "video/quicktime", "video/webm"]],
    ["video", ["video/mp4", "video/quicktime", "video/webm"], ["image/jpeg", "image/heic"]],
  ] as const) {
    test(`${mode}: ${ok.join(", ")} fit; ${bad.join(", ")} are blob violations`, async () => {
      for (const ct of ok) {
        const { broker } = brokerWith();
        const h = openCamera(broker, { mode });
        broker.receive(blobStart(h.id, ct));
        expect(broker.isLive(h.id!)).toBe(true);
        h.cancel();
      }
      for (const ct of bad) {
        const { broker, sent } = brokerWith();
        const h = openCamera(broker, { mode });
        broker.receive(blobStart(h.id, ct));
        expect(await h.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/does not fit/) } });
        expect(cancelsOf(sent, h.id)).toBe(1);
      }
    });
  }

  test("a content type outside the camera set fails the event schema", async () => {
    const { broker } = brokerWith();
    const h = openCamera(broker, { mode: "photo" });
    broker.receive(blobStart(h.id, "image/png"));
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("exactly one item: a second blobStart is a violation; the photo arrives verified", async () => {
    const { broker } = brokerWith();
    const h = openCamera(broker, { mode: "photo" });
    broker.receive(blobStart(h.id, "image/jpeg", 5));
    broker.receive(blobStart(h.id, "image/jpeg", 5, 1));
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams" } });

    const b = brokerWith();
    const h2 = openCamera(b.broker, { mode: "video", maxDurationMs: 2000 });
    const video = bytesOf(40_000);
    b.broker.receive(blobStart(h2.id, "video/webm")); // undeclared: live recording
    b.broker.receiveFrame(frame(h2.id, 0, video));
    b.broker.receive({
      type: "deviceResponse",
      id: h2.id,
      result: { items: [{ channel: 0, contentType: "video/webm", bytes: video.byteLength, sha256: await sha256Hex(video) }] },
    });
    const s = await h2.settled;
    expect("result" in s && s.blobs.find((x) => x.channel === 0)?.bytes).toEqual(video);
  });

  test("a result with a different content type than announced is a violation", async () => {
    const { broker } = brokerWith();
    const h = openCamera(broker, { mode: "photo" });
    const jpeg = bytesOf(10);
    broker.receive(blobStart(h.id, "image/jpeg"));
    broker.receiveFrame(frame(h.id, 0, jpeg));
    broker.receive({
      type: "deviceResponse",
      id: h.id,
      result: { items: [{ channel: 0, contentType: "image/heic", bytes: 10, sha256: await sha256Hex(jpeg) }] },
    });
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams" } });
  });
});

// ---------------------------------------------------------------------------
// DeviceContext end to end against a real DeviceClient (FakeDeviceHost)
// ---------------------------------------------------------------------------

/**
 * The fake host's client ↔ the Rust broker (plane) over in-process queues.
 * `serverSent` holds app requests and their traffic (the connection-owned
 * core.capabilities stream stays server-side).
 */
function connect(host: FakeDeviceHost) {
  const h = loopback((t) => host.client(t), { owners: [[owner.moduleInstanceId, owner.activationId]] });
  const serverSent = h.sent.filter(() => false);
  const core = h.core;
  const original = h.sent.push.bind(h.sent);
  h.sent.push = (...ms: any[]) => {
    for (const m of ms) if (m.id !== core) serverSent.push(m);
    return original(...ms);
  };
  const ctx = new DeviceContext(h.plane, owner, "origin");
  return { broker: h.plane, ctx, serverSent };
}

async function* pcmStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, 1));
    yield c;
  }
}

describe("typed DeviceContext against a DeviceClient", () => {
  test("device.mic.record streams PCM to onData and settles with the verified result", async () => {
    const pcm = [bytesOf(4000, 1), bytesOf(4000, 2), bytesOf(1234, 3)];
    const host = new FakeDeviceHost().driver("mic.record", async () => ({
      kind: "result",
      result: {},
      blobs: [{ channel: 0, contentType: "audio/L16", stream: pcmStream(pcm) }],
      complete: () => ({ durationMs: 290 }),
    }));
    const { ctx, serverSent } = connect(host);
    const got: Uint8Array[] = [];
    const rec = ctx.mic.record({ format: "pcm16", sampleRate: 16_000, channels: 1 }, async (chunk) => {
      await new Promise((r) => setTimeout(r, 1)); // a slow sink
      got.push(chunk);
    });
    expect(rec.id).not.toBeNull();
    const res = await rec.settled;
    expect(res).toMatchObject({
      ok: true,
      value: { durationMs: 290, item: { channel: 0, contentType: "audio/L16", bytes: 9234, sha256: await sha256Hex(concat(pcm)) } },
    });
    expect(concat(got)).toEqual(concat(pcm));
    const req = serverSent.find((m) => m.type === "deviceRequest") as DeviceRequest;
    expect(req).toMatchObject({ capability: "mic.record", version: 1, params: { format: "pcm16", sampleRate: 16_000, channels: 1 } });
    expect(req.initialCredit).toBe(262_144); // default upload credit, clamped to the revision
  });

  test("a recording that ends with an error settles as an error value (nothing verified)", async () => {
    const host = new FakeDeviceHost().driver("mic.record", async () => ({ kind: "error", code: "denied" }));
    const { ctx } = connect(host);
    const rec = ctx.stream("mic.record", micParams as { format: "pcm16"; sampleRate: number }, {}, { onData: () => {} });
    expect(await rec.settled).toEqual({ ok: false, error: { code: "denied" } });
  });

  test("device.camera.capture resolves with exactly one verified item", async () => {
    const jpeg = bytesOf(70_000, 5);
    const host = new FakeDeviceHost().driver("camera.capture", async ({ request }) => {
      expect(request.params).toEqual({ mode: "photo", facing: "back" });
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: jpeg }] };
    });
    const { ctx } = connect(host);
    const res = await ctx.camera.capture({ mode: "photo", facing: "back" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.length).toBe(1);
    expect(res.value.items[0]!.contentType).toBe("image/jpeg");
    expect(res.value.items[0]!.bytes).toEqual(jpeg);
  });

  test("camera.capture photo + maxDurationMs is refused locally (invalidParams), nothing sent", async () => {
    const host = new FakeDeviceHost();
    const { ctx, serverSent } = connect(host);
    const res = await ctx.requestUntyped("camera.capture", { mode: "photo", maxDurationMs: 10 });
    // The Rust broker's refusal reaches the handler as worded, with the path.
    expect(res).toMatchObject({
      ok: false,
      error: { code: "invalidParams", platformDetail: expect.stringMatching(/^params \$\.maxDurationMs: /) },
    });
    expect(serverSent.length).toBe(0);
  });

  test("device.bluetooth.select returns the chosen identity; a bad UUID never leaves the server", async () => {
    const host = new FakeDeviceHost().driver("bluetooth.select", async ({ request }) => {
      expect(request.params).toEqual({ services: ["0000180d-0000-1000-8000-00805f9b34fb"], namePrefix: "HR" });
      return { kind: "result", result: { device: { id: "dev-1", name: "HR Strap" } } };
    });
    const { ctx, serverSent } = connect(host);
    const res = await ctx.bluetooth.select({ services: ["0000180d-0000-1000-8000-00805f9b34fb"], namePrefix: "HR" });
    expect(res).toMatchObject({ ok: true, value: { device: { id: "dev-1", name: "HR Strap" } } });
    const sentBefore = serverSent.length;
    const bad = await ctx.bluetooth.select({ services: ["0x180d"] });
    expect(bad).toMatchObject({
      ok: false,
      error: { code: "invalidParams", platformDetail: expect.stringMatching(/^params \$\.services\[0\]: /) },
    });
    expect(serverSent.length).toBe(sentBefore);
  });

  test("bluetooth.select results are schema-checked on the server before the handler sees them", async () => {
    // A hostile client (not the TS runtime, which validates its own drivers)
    // answering with an empty id and a GATT field the schema does not have.
    let core: number | undefined;
    const h = makePlane({
      owners: [[owner.moduleInstanceId, owner.activationId]],
      onSend: (m) => {
        if (m.type !== "deviceRequest" || core === undefined || m.id === core) return;
        queueMicrotask(() =>
          h.receive({ type: "deviceResponse", id: m.id, result: { device: { id: "", rssi: -40 } } })
        );
      },
    });
    core = h.core;
    const ctx = new DeviceContext(h.plane, owner, "origin");
    expect(await ctx.bluetooth.select()).toMatchObject({ ok: false, error: { code: "invalidParams" } });
  });

  test("device.permissions.query/request send the closed enum; anything else is refused locally", async () => {
    const host = new FakeDeviceHost().permissionReturns("prompt");
    const { ctx, serverSent } = connect(host);
    for (const permission of DEVICE_PERMISSIONS) {
      expect(await ctx.permissions.query(permission)).toMatchObject({ ok: true, value: { status: "prompt" } });
    }
    expect(await ctx.permissions.request("microphone")).toMatchObject({ ok: true, value: { status: "prompt" } });
    const requests = serverSent.filter((m) => m.type === "deviceRequest") as DeviceRequest[];
    expect(requests.map((r) => r.params)).toEqual([...DEVICE_PERMISSIONS, "microphone"].map((permission) => ({ permission })));
    const before = serverSent.length;
    for (const typo of ["camra", "geolocation"]) {
      expect(await (ctx.permissions.query as (p: string) => Promise<DeviceResult<unknown>>)(typo)).toMatchObject({
        ok: false,
        error: { code: "invalidParams" },
      });
    }
    expect(serverSent.length).toBe(before);
  });

  test("requestUntyped / streamUntyped are the same checks without compile-time types", async () => {
    const host = new FakeDeviceHost().permissionReturns("granted");
    const { ctx, serverSent } = connect(host);
    expect(await ctx.requestUntyped("permission.query", { permission: "camera" })).toMatchObject({
      ok: true,
      value: { status: "granted" },
    });
    expect(await ctx.requestUntyped("camera.snap", {})).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(await ctx.requestUntyped("mic.record", micParams)).toMatchObject({
      ok: false,
      error: { code: "invalidParams", platformDetail: expect.stringMatching(/stream/) },
    });
    const before = serverSent.length;
    // Wrong consumer kind for the stream's data plane.
    const a = ctx.streamUntyped("mic.record", micParams, {}, () => {});
    expect(a.id).toBeNull();
    expect(await a.settled).toMatchObject({ ok: false, error: { code: "invalidParams", platformDetail: expect.stringMatching(/onData/) } });
    const b = ctx.streamUntyped("bluetooth.scan", {}, {}, { onData: () => {} });
    expect(await b.settled).toMatchObject({ ok: false, error: { code: "invalidParams", platformDetail: expect.stringMatching(/onEvent/) } });
    const c = ctx.streamUntyped("camera.capture", { mode: "photo" }, {}, { onData: () => {} });
    expect(await c.settled).toMatchObject({ ok: false, error: { code: "invalidParams", platformDetail: expect.stringMatching(/not a stream/) } });
    const d = ctx.streamUntyped("mic.record", { format: "pcm16", sampleRate: 16_000, channels: 3 }, {}, { onData: () => {} });
    expect(await d.settled).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(serverSent.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Advertisement + a full RemoteSession ↔ DeviceClient run
// ---------------------------------------------------------------------------

describe("advertisement: every v1 capability has a consuming server API", () => {
  // The server's advertisement and what it consumes are the Rust broker's
  // (`server_advertisement` / `server_consumes`, through the WASM binding):
  // TS has no table of its own.
  test("the Rust broker consumes every registry revision it enforces", () => {
    const broker = makePlane().port;
    for (const [name, revisions] of DEVICE_REGISTRY) {
      for (const { version } of revisions) {
        const rev = broker.revision(name, version);
        expect(rev, `${name}@${version}`).not.toBeNull();
        expect(`${name}@${version}:${deviceServerConsumes(rev)}`).toBe(`${name}@${version}:true`);
      }
    }
    // No consuming API: a stream without a data plane or with a server →
    // client byte stream (a host error for an unknown mode/data plane).
    expect(deviceServerConsumes({ mode: "stream", data: "none" })).toBe(false);
    expect(deviceServerConsumes({ mode: "stream", data: "binaryDownload" })).toBe(false);
    expect(deviceServerConsumes({ mode: "stream", data: "jsonEvents" })).toBe(true);
    expect(deviceServerConsumes({ mode: "unary", data: "binaryDownload" })).toBe(true);
    expect(() => deviceServerConsumes({ mode: "bidi", data: "none" })).toThrow();
    broker.free();
  });

  test("the advertisement is the Rust one: every registry capability, all its revisions, one row per name", () => {
    const adv: Array<{ name: string; versions: number[] }> = deviceServerAdvertisement();
    const names = adv.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...DEVICE_REGISTRY.keys()].sort());
    for (const { name, versions } of adv) {
      expect(versions).toEqual(DEVICE_REGISTRY.get(name)!.map((r) => r.version));
    }
  });

  test("a RemoteSession negotiates against exactly that advertisement", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    const adv: Array<{ name: string; versions: number[] }> = deviceServerAdvertisement();
    // The client offers every advertised revision plus ones no server has
    // (an unknown name, a future gallery.pick revision).
    const offered = [
      ...adv.map((c) => (c.name === "gallery.pick" ? { name: c.name, versions: [...c.versions, 2] } : c)),
      { name: "x.unknown", versions: [1] },
    ];
    await session.receive(JSON.stringify(deviceHello(offered)));
    await session.ready;
    await flush();
    const ack = t.ui.find((m) => m.type === "sessionAck") as { device?: DeviceAck } | undefined;
    // Exactly the advertisement, in its order; nothing the server lacks.
    expect(ack?.device?.capabilities).toEqual(adv.map((c) => ({ name: c.name, version: Math.max(...c.versions) })));
    await session.destroy();
  });

  const ROUND3 = [
    { name: "core.capabilities", versions: [1] },
    { name: "camera.capture", versions: [1] },
    { name: "mic.record", versions: [1] },
    { name: "bluetooth.select", versions: [1] },
    { name: "permission.query", versions: [1] },
  ];

  async function ackFor(binary: boolean) {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    const hello = deviceHello(ROUND3);
    hello.device.binary = binary;
    await session.receive(JSON.stringify(hello));
    await session.ready;
    await flush();
    const ack = t.ui.find((m) => m.type === "sessionAck") as { device?: DeviceAck } | undefined;
    await session.destroy();
    return ack?.device;
  }

  // The selection follows the server's advertisement order — the Rust
  // registry's, identical in every server SDK.
  test("camera.capture, mic.record and bluetooth.select are selected", async () => {
    expect((await ackFor(true))?.capabilities).toEqual([
      { name: "core.capabilities", version: 1 },
      { name: "bluetooth.select", version: 1 },
      { name: "camera.capture", version: 1 },
      { name: "mic.record", version: 1 },
      { name: "permission.query", version: 1 },
    ]);
  });

  test("without the binary profile the upload capabilities drop out; bluetooth.select stays", async () => {
    expect((await ackFor(false))?.capabilities).toEqual([
      { name: "core.capabilities", version: 1 },
      { name: "bluetooth.select", version: 1 },
      { name: "permission.query", version: 1 },
    ]);
  });
});

describe("RemoteSession ↔ DeviceClient: module handlers use the typed API", () => {
  test("mic.record, camera.capture, bluetooth.select and permissions from one handler, hash-verified server-side", async () => {
    const pcm = [bytesOf(3000, 4), bytesOf(3000, 5)];
    const photo = bytesOf(90_000, 6);
    const fake = new FakeDeviceHost()
      .permissionReturns("granted")
      .driver("mic.record", async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "audio/L16", stream: pcmStream(pcm) }],
        complete: () => ({ durationMs: 187 }),
      }))
      .driver("camera.capture", async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }],
      }))
      .driver("bluetooth.select", async () => ({ kind: "result", result: { device: { id: "ble-42" } } }));
    const endpoint = fake.endpoint();

    const outcomes: Record<string, unknown> = {};
    const received: Uint8Array[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const module = app
      .defineState({})
      .onAction("capture", async ({ context }) => {
        const device = context.device;
        outcomes.perm = await device.permissions.query("microphone");
        const rec = device.mic.record({ format: "pcm16", sampleRate: 16_000 }, (chunk) => void received.push(chunk));
        outcomes.rec = await rec.settled;
        const shot = await device.camera.capture({ mode: "photo" });
        outcomes.photoOk = shot.ok && shot.value.items[0]!.bytes.byteLength === photo.byteLength;
        outcomes.photoSha = shot.ok ? await sha256Hex(shot.value.items[0]!.bytes) : null;
        outcomes.bt = await device.bluetooth.select({});
        done();
      })
      .build() as unknown as SessionHost["module"];

    let session!: RemoteSession;
    const ui: any[] = [];
    session = new RemoteSession(
      makeHost(module),
      {
        send: (m) => {
          ui.push(m);
          if ((m as any).type === "sessionAck") endpoint.onAck((m as any).device);
        },
        sendDevice: (m) => queueMicrotask(() => endpoint.handleText!(JSON.stringify(m))),
        sendBinary: (f) => queueMicrotask(() => endpoint.handleFrame(f)),
        close: () => {},
      },
      { helloGraceMs: null }
    );
    endpoint.attach({
      sendMessage: (m) => queueMicrotask(() => void session.receive(JSON.stringify(m))),
      sendBinary: (f) => queueMicrotask(() => session.receiveBinary(f)),
    });
    await session.receive(JSON.stringify({ type: "hello", device: endpoint.advertisement }));
    await session.ready;
    await flush();
    const ack = ui.find((m) => m.type === "sessionAck");
    expect(ack.device.capabilities.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(["camera.capture", "mic.record", "bluetooth.select", "permission.query"])
    );

    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "capture" }));
    await finished;

    expect(outcomes.perm).toMatchObject({ ok: true, value: { status: "granted" }, simulated: true });
    expect(outcomes.rec).toMatchObject({
      ok: true,
      value: { durationMs: 187, item: { bytes: 6000, sha256: await sha256Hex(concat(pcm)) } },
    });
    expect(concat(received)).toEqual(concat(pcm));
    expect(outcomes.photoOk).toBe(true);
    expect(outcomes.photoSha).toBe(await sha256Hex(photo));
    expect(outcomes.bt).toMatchObject({ ok: true, value: { device: { id: "ble-42" } } });
    expect(session.deviceBroker?.retainedBytes).toBe(0);
    await session.destroy();
  });
});

void requestsOf;
void controlsFor;

describe("type-level tests are part of `bun run typecheck`", () => {
  test("packages/server/tsconfig.json includes typetests/ and the file pins the P1/C2/C3/C4 misuse cases", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const tsconfig = readFileSync(resolve(import.meta.dir, "../packages/server/tsconfig.json"), "utf-8");
    expect(tsconfig).toMatch(/"include":\s*\[[^\]]*"typetests\/\*\*\/\*"/);
    const build = readFileSync(resolve(import.meta.dir, "../packages/server/tsconfig.build.json"), "utf-8");
    expect(build).not.toContain("typetests"); // never built or shipped
    const src = readFileSync(resolve(import.meta.dir, "../packages/server/typetests/device-api.typetest.ts"), "utf-8");
    const expectErrorLines = src.split("\n").filter((l) => l.includes("@ts-expect-error"));
    expect(expectErrorLines.length).toBeGreaterThanOrEqual(25);
    for (const needle of [
      '{ permission: "camra" }',
      '"camera.snap"',
      '{ mode: "photo", maxDurationMs: 5_000 }',
      'device.request("mic.record"',
      'device.permissions.query("camra")',
      "requestUntyped(dynamicName",
    ]) {
      expect(src).toContain(needle);
    }
  });
});
