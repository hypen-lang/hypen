/**
 * Device Capability Protocol — transport scheduling (RFC 001 §2.3).
 *
 * Server: control/lease/request JSON and UI messages go out immediately;
 * bulk binary drains through the Rust broker's scheduler in ≤ 64 KiB turns,
 * round-robin across requests, never while the transport reports ≥ 256 KiB
 * pending, from a finite queue (overflow cancels the request `throttled`).
 * The DevicePlane reports the transport's buffered bytes before every poll
 * and runs each further due turn as its own deferred task (here: manual).
 *
 * Client: `DeviceClient` yields between upload chunks and waits while its
 * transport's `bufferedAmount()` reports ≥ 256 KiB.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import {
  RemoteSession,
  type DeviceOutgoing,
  type OutgoingMessage,
  type SessionHost,
  type SessionTransport,
} from "@hypen-space/core/remote";
import {
  DeviceClient,
  decodeFrame,
  sha256Hex,
  type DeviceDriver,
  type DeviceEvent,
  type DeviceResponse,
  type DeviceSettlement,
} from "@hypen-space/core/remote/device";
import { FakeClock, makeHost, makePlane, spec } from "./device-srv-harness";

/** Manual deferred turns: nothing runs until the test says so. */
class ManualTurns {
  private q: Array<() => void> = [];
  readonly defer = (fn: () => void) => {
    this.q.push(fn);
  };
  get size() {
    return this.q.length;
  }
  /** Run exactly one pending turn. */
  step(): boolean {
    const fn = this.q.shift();
    if (!fn) return false;
    fn();
    return true;
  }
  run(max = 100) {
    for (let i = 0; i < max && this.step(); i++);
  }
}

const KIB = 1024;
const payloadLen = (f: Uint8Array) => {
  const d = decodeFrame(f);
  return d.ok ? d.payload.byteLength : -1;
};
const idOf = (f: Uint8Array) => (decodeFrame(f) as { header: { requestId: number } }).header.requestId;
const seqOf = (f: Uint8Array) => (decodeFrame(f) as { header: { seq: number } }).header.seq;

const announce = async (bytes: Uint8Array) => ({
  channel: 0,
  name: "a.bin",
  contentType: "application/octet-stream",
  bytes: bytes.byteLength,
  sha256: await sha256Hex(bytes),
});

/** A plane whose transport reports `io.buffered` and whose turns are manual. */
function scheduled(opts: { maxQueuedBytes?: number } = {}) {
  const turns = new ManualTurns();
  const io = { buffered: 0 };
  const h = makePlane({
    defer: turns.defer,
    bufferedAmount: () => io.buffered,
    ...(opts.maxQueuedBytes ? { config: { scheduler: { maxQueuedBytes: opts.maxQueuedBytes } } } : {}),
  });
  const save = async (bytes: number) => {
    const data = new Uint8Array(bytes);
    return h.plane.open(spec("file.save", await announce(data), { timeoutMs: 60_000, download: data }));
  };
  const grant = (id: number | null, n: number) => h.receive({ type: "deviceEvent", id, control: { grant: n } });
  /** Let the saturated-transport re-check (retryMs on the clock) fire. */
  const recheck = () => h.clock.advance(10);
  return { ...h, turns, io, save, grant, recheck };
}

// ---------------------------------------------------------------------------

describe("bulk scheduling in the Rust broker (unit, through the plane)", () => {
  test("≤ 64 KiB of payload per turn; round-robin across requests; FIFO within one", async () => {
    const h = scheduled();
    const a = await h.save(3 * 64 * KIB);
    const b = await h.save(2 * 64 * KIB);
    h.io.buffered = 300 * KIB; // queue everything first
    h.grant(a.id, 3 * 64 * KIB);
    h.grant(b.id, 2 * 64 * KIB);
    expect(h.frames.length).toBe(0);
    h.io.buffered = 0;
    h.recheck(); // one turn
    expect(h.frames.length).toBe(1);
    h.turns.run();
    expect(h.frames.map(idOf)).toEqual([a.id, b.id, a.id, b.id, a.id]);
    expect(h.frames.filter((f) => idOf(f) === a.id).map(seqOf)).toEqual([0, 1, 2]);
    expect(h.frames.every((f) => payloadLen(f) === 64 * KIB)).toBe(true);
    expect(h.plane.info()!.bulkTurns).toBe(5);
  });

  test("small frames are batched up to the turn budget", async () => {
    const h = scheduled();
    const a = await h.save(100 * KIB);
    h.io.buffered = 300 * KIB;
    for (let i = 0; i < 10; i++) h.grant(a.id, 10 * KIB); // ten 10 KiB frames
    h.io.buffered = 0;
    h.recheck();
    expect(h.frames.length).toBe(6); // 60 KiB ≤ 64 KiB; a 7th would exceed it
    h.turns.step();
    expect(h.frames.length).toBe(10);
  });

  test("nothing is handed to a transport reporting ≥ 256 KiB pending", async () => {
    const h = scheduled();
    const a = await h.save(2 * 64 * KIB);
    h.io.buffered = 300 * KIB;
    h.grant(a.id, 2 * 64 * KIB);
    for (let i = 0; i < 20; i++) h.recheck();
    expect(h.frames.length).toBe(0);
    expect(h.turns.size).toBe(0); // one timer re-check at a time, no pile-up
    h.io.buffered = 256 * KIB - 1;
    h.recheck();
    expect(h.frames.length).toBe(1);
    h.io.buffered = 256 * KIB; // reached the bound: stop again
    h.turns.run(10);
    h.recheck();
    expect(h.frames.length).toBe(1);
    h.io.buffered = 0;
    h.recheck();
    expect(h.frames.length).toBe(2);
  });

  test("finite queue: a download that would pass the bound is cancelled throttled; its frames are freed", async () => {
    const h = scheduled({ maxQueuedBytes: 100 * KIB });
    const a = await h.save(128 * KIB);
    h.io.buffered = 300 * KIB;
    h.grant(a.id, 128 * KIB);
    expect(await a.settled).toEqual({ error: { code: "throttled", platformDetail: "bulk queue bound reached" } });
    expect(h.plane.info()!.queuedBulkBytes).toBe(0);
    // The freed queue takes another download.
    const b = await h.save(64 * KIB);
    h.grant(b.id, 64 * KIB);
    expect(h.plane.info()!.queuedBulkBytes).toBe(64 * KIB + 12);
    h.io.buffered = 0;
    h.recheck();
    expect(h.frames.map(idOf)).toEqual([b.id]);
  });
});

// ---------------------------------------------------------------------------
// RemoteSession integration

const hello = {
  type: "hello" as const,
  device: {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "file.save", versions: [1] },
      { name: "gallery.pick", versions: [1] },
    ],
  },
};

async function session(opts: { maxQueuedBytes?: number } = {}) {
  const turns = new ManualTurns();
  const clock = new FakeClock();
  const ui: OutgoingMessage[] = [];
  const device: DeviceOutgoing[] = [];
  const binary: Uint8Array[] = [];
  const io = { buffered: 0 };
  const transport: SessionTransport = {
    send: (m) => ui.push(m),
    sendDevice: (m) => device.push(m),
    sendBinary: (f) => binary.push(f),
    bufferedAmount: () => io.buffered,
    close: () => {},
  };
  const module = app.defineState({}).build() as unknown as SessionHost["module"];
  const s = new RemoteSession(makeHost(module), transport, {
    helloGraceMs: null,
    deviceClock: clock,
    deviceDefer: turns.defer,
    ...(opts.maxQueuedBytes ? { deviceBrokerConfig: { scheduler: { maxQueuedBytes: opts.maxQueuedBytes } } } : {}),
  });
  await s.receive(hello);
  await s.ready;
  await new Promise((r) => setTimeout(r, 0));
  // The primary module is active (activation 1) and owns handler work.
  const owner = { moduleInstanceId: s.moduleInstance!.deviceInstanceId, activationId: 1 };
  return { s, turns, clock, ui, device, binary, io, owner };
}

const openSave = async (s: RemoteSession, owner: { moduleInstanceId: string; activationId: number }, bytes: number) => {
  const data = new Uint8Array(bytes);
  return s.deviceBroker!.open({ capability: "file.save", params: await announce(data), ...owner, timeoutMs: 60_000, download: data });
};

describe("RemoteSession scheduling", () => {
  test("a slow transport blocks bulk while control, request and UI messages still go out", async () => {
    const { s, turns, clock, ui, device, binary, io, owner } = await session();
    const h = await openSave(s, owner, 200 * KIB);
    io.buffered = 300 * KIB; // stalled socket
    await s.receive({ type: "deviceEvent", id: h.id, control: { grant: 200 * KIB } });
    for (let i = 0; i < 10; i++) {
      clock.advance(10);
      turns.step();
    }
    expect(binary.length).toBe(0);

    // Control/request JSON is not queued behind bulk.
    const before = device.length;
    const other = s.deviceBroker!.open({
      capability: "gallery.pick",
      ...owner,
      timeoutMs: 60_000,
      initialCredit: 1024,
      params: { mediaTypes: ["photo"], maxCount: 1 },
    });
    expect(device.length).toBe(before + 2); // deviceRequest + renewLease 1
    other.cancel();
    expect(device.at(-1)).toEqual({ type: "deviceEvent", id: other.id!, control: { cancel: true } });
    // UI messages are synchronous too.
    const uiBefore = ui.length;
    s.send({ type: "stateUpdate", state: {} } as unknown as OutgoingMessage);
    expect(ui.length).toBe(uiBefore + 1);
    expect(binary.length).toBe(0);

    // Drain: one ≤ 64 KiB chunk per turn.
    io.buffered = 0;
    clock.advance(10);
    expect(binary.map(payloadLen)).toEqual([64 * KIB]);
    turns.step();
    expect(binary.map(payloadLen)).toEqual([64 * KIB, 64 * KIB]);

    // Cancelling discards the rest of the queue for that id.
    h.cancel();
    turns.run();
    clock.advance(10);
    expect(binary.length).toBe(2);
    expect(await h.settled).toEqual({ error: { code: "cancelled" } });
    await s.destroy();
  });

  test("queued bulk past the finite bound cancels the request throttled", async () => {
    const { s, turns, clock, device, binary, io, owner } = await session({ maxQueuedBytes: 100 * KIB });
    io.buffered = 300 * KIB;
    const h = await openSave(s, owner, 300 * KIB);
    await s.receive({ type: "deviceEvent", id: h.id, control: { grant: 256 * KIB } });
    const settled: DeviceSettlement = await h.settled;
    expect(settled).toEqual({ error: { code: "throttled", platformDetail: "bulk queue bound reached" } });
    expect(device.some((m) => m.type === "deviceEvent" && m.id === h.id && m.control && "cancel" in m.control)).toBe(true);
    io.buffered = 0;
    turns.run();
    clock.advance(10);
    expect(binary.length).toBe(0); // queued frames discarded with the request
    await s.destroy();
  });
});

// ---------------------------------------------------------------------------

describe("DeviceClient upload pacing", () => {
  test("yields between chunks and waits while bufferedAmount ≥ 256 KiB", async () => {
    const frames: Uint8Array[] = [];
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const yields: Array<() => void> = [];
    const io = { buffered: 300 * KIB };
    const photo = new Uint8Array(3 * 64 * KIB);
    const driver: DeviceDriver = async () => ({
      kind: "result",
      result: {},
      blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }],
    });
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f), bufferedAmount: () => io.buffered },
      new Map([["gallery.pick", driver]]),
      { yieldTurn: () => new Promise<void>((r) => yields.push(r)), drainPollMs: 1 }
    );
    client.handleMessage({
      type: "deviceRequest",
      id: 1,
      capability: "gallery.pick",
      version: 1,
      owner: { moduleInstanceId: "m", activationId: 1 },
      lifetime: "activation",
      timeoutMs: 60_000,
      initialCredit: 4 * 1024 * 1024,
      params: { mediaTypes: ["photo"], maxCount: 1 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.length).toBe(0); // saturated socket: waiting
    io.buffered = 0;
    await new Promise((r) => setTimeout(r, 10));
    expect(frames.length).toBe(1); // one chunk, then a yield
    expect(yields.length).toBe(1);
    yields.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    expect(frames.length).toBe(2);
    yields.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    expect(frames.length).toBe(3);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.some((m) => m.type === "deviceResponse")).toBe(true);
  });
});
