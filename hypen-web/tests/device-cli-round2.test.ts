/**
 * Device Capability Protocol — client-side regression tests for the second
 * adversarial review (review2-ts) and the round-2 lead decisions D1–D8.
 *
 * - D2 / finding 2: a zero-byte item is announced (`blobStart{bytes:0}`) and
 *   sends NO frame; an empty download frame is a violation.
 * - D5: items may stream without a declared size; `maxItemBytes` is enforced
 *   as bytes are produced; declared sizes are exact; incremental SHA-256;
 *   `mic.record`'s single `item` + a `complete()` hook for `durationMs`.
 * - D8: a server `deviceResponse` on a live id terminates it invalidParams.
 * - finding 11 (client parts): nothing is admitted before the sessionAck,
 *   and a later ack cannot change the selection (D6: an ack without
 *   `device` may still be followed by one carrying it); the connection
 *   model (core stream first, one live core stream) closes the connection.
 * - D3/D4: JSON-limit breaches and bad frame headers are connection-level
 *   (counted, never terminating a request; repeated ⇒ close).
 * - Lease renewals start at 1 and strictly increase; activationIds never go
 *   backwards; progress never regresses and spends no credit.
 * - RemoteEngine: deviceResponse routing, oversize device text never parsed,
 *   ack finality per socket, `close` → ws.close(1002), upgrade headers /
 *   protocols / socket factory (D1).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DeviceClient,
  Sha256,
  type DeviceClientClock,
  type DeviceClientOptions,
  type DeviceDriver,
  type DriverContext,
  type DriverOutcome,
} from "../packages/core/src/remote/device/runtime.ts";
import { sha256Hex } from "../packages/core/src/remote/device/blob.ts";
import { decodeFrame, encodeFrame } from "../packages/core/src/remote/device/frames.ts";
import { withRevisionOverride } from "../packages/core/src/remote/device/registry.ts";
import { RemoteEngine } from "../packages/core/src/remote/client.ts";
import type {
  DeviceAck,
  DeviceEvent,
  DeviceRequest,
  DeviceResponse,
} from "../packages/core/src/remote/device/generated.ts";
import type { DeviceClientTransport, DeviceEndpoint } from "../packages/core/src/remote/device/runtime.ts";
import { FakeDeviceHost } from "../packages/device-fake/src/index.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}

class FakeClock implements DeviceClientClock {
  t = 0;
  now() {
    return this.t;
  }
  setTimeout() {
    return 0;
  }
  clearTimeout() {}
}

type Sent = DeviceResponse | DeviceEvent;

const FULL_ACK: DeviceAck = {
  protocolVersion: 1,
  binary: true,
  capabilities: [
    "core.capabilities",
    "gallery.pick",
    "file.pick",
    "file.save",
    "permission.query",
    "permission.request",
    "bluetooth.scan",
    "mic.record",
  ].map((name) => ({ name, version: 1 })),
};

function harness(drivers: Record<string, DeviceDriver>, options: DeviceClientOptions = {}) {
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const frames: Uint8Array[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const io: DeviceClientTransport = {
    sendMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))),
    sendBinary: (f) => frames.push(f.slice()),
    close: (code, reason) => closes.push({ code, reason }),
  };
  const client = new DeviceClient(io, new Map(Object.entries(drivers)), {
    clock,
    yieldTurn: () => Promise.resolve(),
    ...options,
  });
  const responses = () => sent.filter((m): m is DeviceResponse => m.type === "deviceResponse");
  const events = (id: number) =>
    sent.filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && !!m.event).map((m) => m.event!);
  const controls = (id: number, key: string) =>
    sent
      .filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && !!m.control && key in m.control)
      .map((m) => (m.control as Record<string, unknown>)[key]);
  const payloads = (id: number, channel = 0) =>
    frames
      .map((f) => decodeFrame(f))
      .filter((d) => d.ok && d.header.requestId === id && d.header.channel === channel)
      .map((d) => (d.ok ? d.payload : new Uint8Array()));
  return { client, clock, sent, frames, closes, responses, events, controls, payloads };
}

/** A connected endpoint-mode client: ack applied, core stream open (id 1). */
function connected(drivers: Record<string, DeviceDriver>, options: DeviceClientOptions = {}) {
  const core: DeviceDriver = async ({ cancelled }) => {
    await cancelled;
    return { kind: "result", result: {} };
  };
  const h = harness({ "core.capabilities": core, ...drivers }, { requireHandshake: true, ...options });
  h.client.setSelection(FULL_ACK);
  h.client.handleMessage(capsReq(1));
  return h;
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

const capsReq = (id: number, initialCredit = 8): DeviceRequest =>
  req({
    id,
    capability: "core.capabilities",
    owner: { connection: true },
    lifetime: "connection",
    timeoutMs: 86_400_000,
    initialCredit,
    params: {},
  });

const galleryReq = (id: number, initialCredit = 65_536, over: Partial<DeviceRequest> = {}): DeviceRequest =>
  req({ id, capability: "gallery.pick", timeoutMs: 300_000, initialCredit, params: { mediaTypes: ["photo"], maxCount: 2 }, ...over });

const micReq = (id: number, initialCredit = 262_144): DeviceRequest =>
  req({
    id,
    capability: "mic.record",
    timeoutMs: 600_000,
    initialCredit,
    params: { sampleRate: 16_000, format: "pcm16", maxDurationMs: 60_000 },
  });

const control = (id: number, c: Record<string, unknown>) =>
  ({ type: "deviceEvent", id, control: c }) as unknown as DeviceEvent;

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}

const bytesOf = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

// ---------------------------------------------------------------------------

describe("D2 / review2 #2: zero-byte items", () => {
  test("an empty in-memory item is announced with bytes:0 and sends no frame", async () => {
    const h = harness({
      "file.pick": async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, name: "empty.txt", contentType: "text/plain", bytes: new Uint8Array(0) }],
      }),
    });
    h.client.handleMessage(req({ id: 1, capability: "file.pick", timeoutMs: 300_000, initialCredit: 65_536, params: { accept: [], maxCount: 1 } }));
    await ticks(4);
    expect(h.frames).toEqual([]);
    expect(h.events(1)).toEqual([{ kind: "blobStart", channel: 0, contentType: "text/plain", bytes: 0 }]);
    expect(h.responses()).toEqual([
      {
        type: "deviceResponse",
        id: 1,
        result: {
          items: [{ channel: 0, name: "empty.txt", contentType: "text/plain", bytes: 0, sha256: await sha256Hex(new Uint8Array(0)) }],
        },
      },
    ]);
  });

  test("an empty undeclared stream is announced without bytes and sends no frame", async () => {
    const h = harness({
      "gallery.pick": async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/png", stream: chunks() }] }),
    });
    h.client.handleMessage(galleryReq(1));
    await ticks(4);
    expect(h.frames).toEqual([]);
    expect(h.events(1)).toEqual([{ kind: "blobStart", channel: 0, contentType: "image/png" }]);
    expect(h.responses()[0]!.result).toEqual({
      items: [{ channel: 0, contentType: "image/png", bytes: 0, sha256: await sha256Hex(new Uint8Array(0)) }],
    });
  });

  test("a zero-length download frame terminates the download invalidParams", async () => {
    const payload = bytesOf(40);
    let ctx!: DriverContext;
    const h = harness({
      "file.save": async (c) => {
        ctx = c;
        await c.download!.receiveAll().catch(() => undefined);
        await c.cancelled;
        return { kind: "result", result: { bytesWritten: 40 } };
      },
    });
    h.client.handleMessage(
      req({ id: 1, capability: "file.save", timeoutMs: 300_000, params: { channel: 0, name: "a.bin", contentType: "application/octet-stream", bytes: 40, sha256: await sha256Hex(payload) } })
    );
    await ticks(2);
    expect(ctx.download).toBeDefined();
    expect(h.controls(1, "grant")).toEqual([40]);
    h.client.handleFrame(encodeFrame({ version: 1, flags: 0, channel: 0, requestId: 1, seq: 0 }, new Uint8Array(0)));
    await ticks(2);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 1, error: { code: "invalidParams", platformDetail: "zero-length download frame" } },
    ]);
  });
});

describe("D5: blob sizes are optional; streams are enforced as bytes arrive", () => {
  test("an undeclared stream omits blobStart.bytes; the result states actual bytes and sha256", async () => {
    const parts = [bytesOf(700, 1), bytesOf(900, 2), bytesOf(70_000, 3), bytesOf(5, 4)];
    const h = harness({
      "gallery.pick": async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", stream: chunks(...parts) }] }),
    });
    h.client.handleMessage(galleryReq(1, 1_048_576));
    await ticks(8);
    const all = concat(parts);
    expect(h.events(1)[0]).toEqual({ kind: "blobStart", channel: 0, contentType: "image/jpeg" });
    const sent = h.payloads(1);
    expect(concat(sent)).toEqual(all);
    for (const p of sent) {
      expect(p.byteLength).toBeGreaterThan(0);
      expect(p.byteLength).toBeLessThanOrEqual(64 * 1024);
    }
    // Tiny source chunks are coalesced: no frame below the 1 KiB per-frame
    // charge except the item's last one.
    for (const p of sent.slice(0, -1)) expect(p.byteLength).toBeGreaterThanOrEqual(1024);
    expect(h.responses()[0]!.result).toEqual({
      items: [{ channel: 0, contentType: "image/jpeg", bytes: all.byteLength, sha256: await sha256Hex(all) }],
    });
  });

  test("a declared stream is announced with its size and must produce exactly that many bytes", async () => {
    const data = bytesOf(3000);
    const ok = harness({
      "gallery.pick": async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "image/jpeg", stream: chunks(data.subarray(0, 1000), data.subarray(1000)), declaredBytes: 3000 }],
      }),
    });
    ok.client.handleMessage(galleryReq(1));
    await ticks(6);
    expect(ok.events(1)[0]).toEqual({ kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 3000 });
    expect(ok.responses()[0]!.result).toEqual({
      items: [{ channel: 0, contentType: "image/jpeg", bytes: 3000, sha256: await sha256Hex(data) }],
    });

    const over = harness({
      "gallery.pick": async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "image/jpeg", stream: chunks(data), declaredBytes: 2999 }],
      }),
    });
    over.client.handleMessage(galleryReq(1));
    await ticks(6);
    expect(over.frames).toEqual([]); // never sends past the declaration
    expect(over.responses()[0]!.error?.code).toBe("internal");

    const short = harness({
      "gallery.pick": async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "image/jpeg", stream: chunks(data), declaredBytes: 3001 }],
      }),
    });
    short.client.handleMessage(galleryReq(1));
    await ticks(6);
    expect(short.responses()[0]!.error?.code).toBe("internal");
    expect(short.responses()[0]!.result).toBeUndefined();
  });

  test("maxItemBytes is enforced as the stream produces bytes: nothing past the limit is sent", async () => {
    const registry = withRevisionOverride("gallery.pick", 1, { maxItemBytes: 4096 });
    let released = false;
    async function* source() {
      try {
        for (let i = 0; i < 100; i++) yield bytesOf(1024, i);
      } finally {
        released = true;
      }
    }
    const h = harness(
      { "gallery.pick": async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", stream: source() }] }) },
      { registry }
    );
    h.client.handleMessage(galleryReq(1));
    await ticks(8);
    const sent = h.payloads(1).reduce((n, p) => n + p.byteLength, 0);
    expect(sent).toBeLessThanOrEqual(4096);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 1, error: { code: "throttled", platformDetail: "item exceeds size limit" } },
    ]);
    expect(released).toBe(true);
  });

  test("streams are credit-paced (paused/resumed) and a server cancel releases the source", async () => {
    let released = false;
    let produced = 0;
    async function* live() {
      try {
        for (;;) {
          produced += 1;
          yield bytesOf(2048, produced);
          await tick();
        }
      } finally {
        released = true;
      }
    }
    const h = harness({
      "mic.record": async () => ({ kind: "result", result: { durationMs: 5 }, blobs: [{ channel: 0, contentType: "audio/L16", stream: live() }] }),
    });
    h.client.handleMessage(micReq(1, 4096));
    await ticks(10);
    expect(h.controls(1, "paused")).toEqual([true]);
    expect(h.payloads(1).reduce((n, p) => n + p.byteLength, 0)).toBe(4096);
    h.client.handleMessage(control(1, { grant: 2048 }));
    await ticks(10);
    expect(h.controls(1, "paused")).toEqual([true, false, true]);
    expect(h.payloads(1).reduce((n, p) => n + p.byteLength, 0)).toBe(6144);
    h.client.handleMessage(control(1, { cancel: true }));
    await ticks(4);
    expect(released).toBe(true);
    expect(h.responses()).toEqual([{ type: "deviceResponse", id: 1, error: { code: "cancelled" } }]);
  });

  test("mic.record: one `item`, blobStart without bytes, `complete()` supplies durationMs after the stream ends", async () => {
    const audio = [bytesOf(1500, 7), bytesOf(700, 8)];
    let ended = false;
    async function* recorder() {
      yield* audio;
      ended = true;
    }
    const h = harness({
      "mic.record": async () => ({
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "audio/L16", stream: recorder() }],
        complete: () => {
          expect(ended).toBe(true);
          return { durationMs: 1250 };
        },
      }),
    });
    h.client.handleMessage(micReq(1));
    await ticks(8);
    const all = concat(audio);
    expect(h.events(1)).toEqual([{ kind: "blobStart", channel: 0, contentType: "audio/L16" }]);
    expect(h.responses()).toEqual([
      {
        type: "deviceResponse",
        id: 1,
        result: { durationMs: 1250, item: { channel: 0, contentType: "audio/L16", bytes: all.byteLength, sha256: await sha256Hex(all) } },
      },
    ]);
  });

  test("a stream error ends the request with the error's code (or internal)", async () => {
    async function* broken() {
      yield bytesOf(10);
      throw Object.assign(new Error("mic unplugged"), { code: "unavailable" });
    }
    const h = harness({
      "mic.record": async () => ({ kind: "result", result: { durationMs: 1 }, blobs: [{ channel: 0, contentType: "audio/L16", stream: broken() }] }),
    });
    h.client.handleMessage(micReq(1));
    await ticks(6);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 1, error: { code: "unavailable", platformDetail: "mic unplugged" } },
    ]);
  });

  test("a blob must carry exactly one of bytes / stream", async () => {
    const h = harness({
      "gallery.pick": async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/png" }] }),
    });
    h.client.handleMessage(galleryReq(1));
    await ticks(4);
    expect(h.responses()[0]!.error?.code).toBe("internal");
    expect(h.sent.some((m) => m.type === "deviceEvent" && m.event)).toBe(false);
  });

  test("incremental SHA-256 equals Web Crypto at every padding boundary and split", async () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const data = bytesOf(n, n);
      for (const split of [1, 7, 64, 65, 1000, 4096]) {
        const h = new Sha256();
        for (let off = 0; off < n; off += split) h.update(data.subarray(off, Math.min(n, off + split)));
        expect(h.byteLength).toBe(n);
        expect(h.hex()).toBe(await sha256Hex(data));
      }
    }
  });

  test("incremental SHA-256 is single-use: update after hex and a second hex throw", async () => {
    const h = new Sha256().update(new Uint8Array([1]));
    expect(h.hex()).toBe(await sha256Hex(new Uint8Array([1])));
    expect(() => h.update(new Uint8Array([2]))).toThrow(/after hex/);
    expect(() => h.hex()).toThrow(/twice/);
  });
});

describe("D8: server deviceResponse", () => {
  test("on a live id: the operation terminates invalidParams and the driver stops", async () => {
    let stopped = false;
    const h = harness({
      "permission.query": async ({ cancelled }) => {
        await cancelled;
        stopped = true;
        return { kind: "result", result: { status: "granted" } };
      },
    });
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    h.client.handleText('{"type":"deviceResponse","id":2,"result":{"status":"granted"}}');
    await ticks(2);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 2, error: { code: "invalidParams", platformDetail: "wrong-direction deviceResponse from server" } },
    ]);
    expect(stopped).toBe(true);
    // Later messages for the retired id are ignored.
    h.client.handleText('{"type":"deviceEvent","id":2,"control":{"renewLease":1}}');
    await tick();
    expect(h.sent.length).toBe(1);
  });

  test("on an unknown id it is ignored; a malformed one on a live id is invalidParams too", async () => {
    const h = harness({ "permission.query": async ({ cancelled }) => (await cancelled, { kind: "error", code: "cancelled" }) });
    h.client.handleMessage({ type: "deviceResponse", id: 77, result: {} });
    h.client.handleMessage(req({ id: 3 }));
    await tick();
    h.client.handleText('{"type":"deviceResponse","id":3}'); // neither result nor error
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[3, "invalidParams"]]);
  });
});

describe("review2 #11: handshake before admission; the selection is final per connection", () => {
  test("with requireHandshake, a request before the sessionAck is refused unsupported and never runs", async () => {
    let runs = 0;
    const h = harness({ "permission.query": async () => (runs++, { kind: "result", result: { status: "granted" } }) }, { requireHandshake: true });
    h.client.handleMessage(req({ id: 1 }));
    await ticks(2);
    expect(runs).toBe(0);
    expect(h.responses()[0]!.error?.code).toBe("unsupported");
  });

  test("the first selection carrying device is final: a later ack can neither widen nor narrow it", async () => {
    const h = connected({ "permission.query": async () => ({ kind: "result", result: { status: "granted" } }) });
    h.client.setSelection({ protocolVersion: 1, binary: true, capabilities: [{ name: "core.capabilities", version: 1 }] });
    h.client.setSelection(undefined);
    h.client.handleMessage(req({ id: 2 }));
    await ticks(3);
    expect(h.responses()).toEqual([{ type: "deviceResponse", id: 2, result: { status: "granted" } }]);

    const narrow = harness(
      { "core.capabilities": async ({ cancelled }) => (await cancelled, { kind: "result", result: {} }), "permission.query": async () => ({ kind: "result", result: { status: "granted" } }) },
      { requireHandshake: true }
    );
    narrow.client.setSelection({ protocolVersion: 1, binary: true, capabilities: [{ name: "core.capabilities", version: 1 }] });
    narrow.client.setSelection(FULL_ACK); // a second ack cannot widen it
    narrow.client.handleMessage(capsReq(1));
    narrow.client.handleMessage(req({ id: 2 }));
    await ticks(3);
    expect(narrow.responses().map((r) => [r.id, r.error?.code])).toEqual([[2, "unsupported"]]);
  });

  test("D6: an ack without device may be followed by one carrying it", async () => {
    const h = harness(
      { "core.capabilities": async ({ cancelled }) => (await cancelled, { kind: "result", result: {} }), "permission.query": async () => ({ kind: "result", result: { status: "prompt" } }) },
      { requireHandshake: true }
    );
    h.client.setSelection(undefined);
    h.client.setSelection(FULL_ACK);
    h.client.handleMessage(capsReq(1));
    h.client.handleMessage(req({ id: 2 }));
    await ticks(3);
    expect(h.responses()).toEqual([{ type: "deviceResponse", id: 2, result: { status: "prompt" } }]);
  });

  test("duplicate names make an ack invalid (D7); binary:false removes binary-plane revisions", async () => {
    const dup = harness({ "permission.query": async () => ({ kind: "result", result: { status: "granted" } }) });
    dup.client.setSelection({
      protocolVersion: 1,
      binary: true,
      capabilities: [
        { name: "permission.query", version: 1 },
        { name: "permission.query", version: 1 },
      ],
    });
    dup.client.handleMessage(req({ id: 1 }));
    await ticks(2);
    expect(dup.responses()[0]!.error?.code).toBe("unsupported");

    const json = harness({ "gallery.pick": async () => ({ kind: "result", result: { items: [] } }) });
    json.client.setSelection({ ...FULL_ACK, binary: false });
    json.client.handleMessage(galleryReq(1));
    await ticks(2);
    expect(json.responses()[0]!.error?.code).toBe("unsupported");
  });
});

describe("connection model (RFC 001 §2.2)", () => {
  test("an app request before core.capabilities opened closes the device connection", async () => {
    let runs = 0;
    const h = harness({ "permission.query": async () => (runs++, { kind: "result", result: { status: "granted" } }) }, { requireHandshake: true });
    h.client.setSelection(FULL_ACK);
    h.client.handleMessage(req({ id: 1 }));
    await ticks(2);
    expect(runs).toBe(0);
    expect(h.closes).toEqual([{ code: 1002, reason: "app request before core.capabilities opened" }]);
    expect(h.client.closed).toBe(true);
    h.client.handleMessage(capsReq(2));
    await tick();
    expect(h.sent).toEqual([]);
  });

  test("a second live core stream closes; a planned reopen (cancel first) does not", async () => {
    const h = connected({});
    h.client.handleMessage(control(1, { cancel: true }));
    h.client.handleMessage(capsReq(2));
    await ticks(2);
    expect(h.closes).toEqual([]);
    h.client.handleMessage(capsReq(3));
    await ticks(2);
    expect(h.closes).toEqual([{ code: 1002, reason: "a second live core.capabilities stream" }]);
  });

  test("the live selection follows the snapshots the core stream sent; in-flight work keeps its revision", async () => {
    let emit!: (e: Record<string, unknown>) => void;
    const h = harness(
      {
        "core.capabilities": async (ctx) => {
          emit = ctx.emit;
          await ctx.cancelled;
          return { kind: "result", result: {} };
        },
        "permission.query": async () => ({ kind: "result", result: { status: "granted" } }),
        "permission.request": async ({ cancelled }) => (await cancelled, { kind: "error", code: "cancelled" }),
      },
      { requireHandshake: true }
    );
    h.client.setSelection(FULL_ACK);
    h.client.handleMessage(capsReq(1));
    await tick();
    h.client.handleMessage(req({ id: 2, capability: "permission.request", timeoutMs: 300_000 }));
    emit({ capabilities: [{ name: "core.capabilities", versions: [1] }] });
    h.client.handleMessage(req({ id: 3 }));
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[3, "unsupported"]]);
    expect(h.client.liveCount).toBe(2); // core + the pinned permission.request
    emit({ capabilities: [{ name: "core.capabilities", versions: [1] }, { name: "permission.query", versions: [1] }] });
    h.client.handleMessage(req({ id: 4 }));
    await ticks(2);
    expect(h.responses().at(-1)).toEqual({ type: "deviceResponse", id: 4, result: { status: "granted" } });
  });

  test("activationIds never go backwards per moduleInstanceId", async () => {
    const h = harness({ "permission.query": async () => ({ kind: "result", result: { status: "granted" } }) });
    h.client.handleMessage(req({ id: 1, owner: { moduleInstanceId: "editor-1", activationId: 2 } }));
    h.client.handleMessage(req({ id: 2, owner: { moduleInstanceId: "editor-1", activationId: 1 } }));
    h.client.handleMessage(req({ id: 3, owner: { moduleInstanceId: "editor-2", activationId: 1 } }));
    h.client.handleMessage(req({ id: 4, owner: { moduleInstanceId: "editor-1", activationId: 2 } }));
    await ticks(3);
    expect(h.responses().map((r) => [r.id, r.error?.code ?? "ok"])).toEqual([
      [2, "invalidParams"],
      [1, "ok"],
      [3, "ok"],
      [4, "ok"],
    ]);
  });
});

describe("D3/D4: connection-level violations", () => {
  test("JSON-limit breaches are counted, never terminate the request they seem to name", async () => {
    const h = connected({ "permission.query": async ({ cancelled }) => (await cancelled, { kind: "error", code: "cancelled" }) });
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    const breaches = [
      '{"type":"deviceEvent","id":2,"id":2,"control":{"renewLease":1}}',
      '{"type":"deviceEvent","id":2,"control":{"renewLease":1.0}}',
      '{"type":"deviceEvent","id":2,"control":{"renewLease":1e0}}',
      '{"type":"deviceEvent","id":2,"control":{"renewLease":-0}}',
      '{"type":"deviceEvent","id":2,"control":{"renewLease":12345678901234567}}',
      `{"type":"deviceEvent","id":2,"control":{"renewLease":1},"x":${"[".repeat(32)}${"]".repeat(32)}}`,
      '{"type":"deviceEvent","id":2,"control":{"renewLease":1},"x":"\\ud800"}',
      '{"type":"deviceEvent","id":2,"control":{"renewLease":True}}',
    ];
    for (const text of breaches) h.client.handleText(text);
    await ticks(2);
    expect(h.sent).toEqual([]);
    expect(h.client.connectionViolations).toBe(breaches.length);
    expect(h.client.liveCount).toBe(2);
    h.client.handleText('{"type":"deviceEvent","id":2,"control":{"renewLease":1}}');
    expect(h.sent).toEqual([{ type: "deviceEvent", id: 2, control: { leaseAck: 1 } }]);
  });

  test("an oversize device message is refused before parsing", () => {
    const h = connected({});
    const parse = spyOn(JSON, "parse");
    try {
      h.client.handleText(`{"type":"deviceEvent","id":1,"control":{"grant":1},"pad":"${"a".repeat(1_048_576)}"}`);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(h.client.connectionViolations).toBe(1);
  });

  test("bad frame headers are dropped and counted; repeated violations close the connection", async () => {
    const h = connected({ "permission.query": async ({ cancelled }) => (await cancelled, { kind: "error", code: "cancelled" }) });
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    const bad = encodeFrame({ version: 1, flags: 0, channel: 0, requestId: 2, seq: 0 }, new Uint8Array([1]));
    bad[1] = 1; // nonzero flags
    h.client.handleFrame(bad);
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.client.liveCount).toBe(2);
    for (let i = 0; i < 40; i++) h.client.handleText("{not json");
    expect(h.closes).toEqual([{ code: 1002, reason: "repeated device protocol violations" }]);
  });

  test("an attributable schema-invalid message terminates its live id (known-id invalid)", async () => {
    const h = connected({ "permission.query": async ({ cancelled }) => (await cancelled, { kind: "error", code: "cancelled" }) });
    h.client.handleMessage(req({ id: 2 }));
    await tick();
    h.client.handleText('{"type":"deviceEvent","id":2,"control":{"cancel":false}}');
    await ticks(2);
    expect(h.responses().map((r) => [r.id, r.error?.code])).toEqual([[2, "invalidParams"]]);
    expect(h.client.connectionViolations).toBe(0);
  });
});

describe("download sender state", () => {
  async function download() {
    const payload = bytesOf(100);
    const h = harness({
      "file.save": async (c) => {
        await c.download!.receiveAll().catch(() => undefined);
        await c.cancelled;
        return { kind: "result", result: { bytesWritten: 100 } };
      },
    });
    h.client.handleMessage(
      req({ id: 1, capability: "file.save", timeoutMs: 300_000, params: { channel: 0, name: "a.bin", contentType: "application/octet-stream", bytes: 100, sha256: await sha256Hex(payload) } })
    );
    await ticks(2);
    return { h, payload };
  }

  test("paused repeating the current state is a violation", async () => {
    const { h } = await download();
    h.client.handleMessage(control(1, { paused: false }));
    await ticks(2);
    expect(h.responses()[0]!.error?.code).toBe("invalidParams");
  });

  test("data after the sender reported paused:true is a violation", async () => {
    const { h, payload } = await download();
    h.client.handleMessage(control(1, { paused: true }));
    h.client.handleFrame(encodeFrame({ version: 1, flags: 0, channel: 0, requestId: 1, seq: 0 }, payload.subarray(0, 10)));
    await ticks(2);
    expect(h.responses()[0]!.error?.code).toBe("invalidParams");
  });
});

describe("progress events", () => {
  test("spend no credit on a JSON stream and never regress to pendingConsent", async () => {
    let ctx!: DriverContext;
    const h = harness({
      "bluetooth.scan": async (c) => {
        ctx = c;
        await c.cancelled;
        return { kind: "result", result: {} };
      },
    });
    h.client.handleMessage(req({ id: 1, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit: 1, params: {} }));
    await tick();
    ctx.emit({ kind: "progress", state: "pendingConsent" });
    ctx.emit({ kind: "progress", state: "running" });
    ctx.emit({ kind: "progress", state: "pendingConsent" }); // regression: dropped
    ctx.emit({ device: { id: "a", rssi: -40 } }); // spends the one credit
    expect(h.events(1)).toEqual([
      { kind: "progress", state: "pendingConsent" },
      { kind: "progress", state: "running" },
      { device: { id: "a", rssi: -40 } },
    ]);
  });

  test("a non-progress event on a revision without a JSON stream ends the request internal", async () => {
    let ctx!: DriverContext;
    const h = harness({
      "permission.request": async (c) => {
        ctx = c;
        await c.cancelled;
        return { kind: "result", result: { status: "granted" } };
      },
    });
    h.client.handleMessage(req({ id: 1, capability: "permission.request" }));
    await tick();
    ctx.emit({ kind: "blobStart", channel: 0, contentType: "x/y" });
    await ticks(2);
    expect(h.responses()[0]!.error?.code).toBe("internal");
  });

  test("a driver outcome may mark its terminal simulated", async () => {
    const h = harness({ "permission.query": async () => ({ kind: "error", code: "denied", platformDetail: "", simulated: true }) });
    h.client.handleMessage(req({ id: 1 }));
    await ticks(2);
    expect(h.responses()).toEqual([
      { type: "deviceResponse", id: 1, error: { code: "denied", platformDetail: "" }, simulated: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// RemoteEngine (client.ts)
// ---------------------------------------------------------------------------

class MockWS extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  onopen: null | (() => void) = null;
  sent: Array<string | Uint8Array> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  args: unknown[];
  constructor(...args: unknown[]) {
    super();
    this.args = args;
    MockWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let savedWebSocket: unknown;
beforeEach(() => {
  savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
  MockWS.instances = [];
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
});

const sessionAck = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "sessionAck", sessionId: "s-1", isNew: true, isRestored: false, ...extra });

function recordingEndpoint() {
  const log = {
    acks: [] as Array<DeviceAck | undefined>,
    texts: [] as string[],
    messages: [] as unknown[],
    io: null as DeviceClientTransport | null,
  };
  const endpoint: DeviceEndpoint = {
    advertisement: { protocolVersions: [1], binary: true, capabilities: [{ name: "core.capabilities", versions: [1] }, { name: "gallery.pick", versions: [1] }] },
    attach: (io) => {
      log.io = io;
    },
    onAck: (a) => log.acks.push(a),
    handleMessage: (m) => log.messages.push(m),
    handleText: (t) => log.texts.push(t),
    handleFrame: () => {},
    detach: () => {},
  };
  return { endpoint, log };
}

describe("RemoteEngine device plumbing (round 2)", () => {
  test("a server deviceResponse is routed to the endpoint as exact text (D8)", async () => {
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const text = '{"type":"deviceResponse","id":2,"result":{"status":"granted"}}';
    MockWS.instances[0]!.receive(text);
    expect(log.texts).toEqual([text]);
    engine.disconnect();
  });

  test("an oversize device text is handed over unparsed; an oversize UI message still works", async () => {
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    const states: unknown[] = [];
    engine.onStateUpdate((s) => states.push(s));
    await engine.connect();
    const ws = MockWS.instances[0]!;
    const big = `{"type":"deviceEvent","id":2,"control":{"renewLease":1},"pad":"${"a".repeat(1_100_000)}"}`;
    const parse = spyOn(JSON, "parse");
    try {
      ws.receive(big);
      // Only the scanned keys are ever parsed, never the message.
      for (const call of parse.mock.calls) expect(String(call[0]).length).toBeLessThan(64);
    } finally {
      parse.mockRestore();
    }
    expect(log.texts).toEqual([big]);
    ws.receive(JSON.stringify({ type: "stateUpdate", state: { blob: "b".repeat(1_100_000) } }));
    expect(states.length).toBe(1);
    engine.disconnect();
  });

  test("the first ack carrying device is final per socket; an earlier device-less ack can be upgraded (D6)", async () => {
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const ws = MockWS.instances[0]!;
    const ack = { protocolVersion: 1, binary: true, capabilities: [{ name: "core.capabilities", version: 1 }, { name: "gallery.pick", version: 1 }] };
    ws.receive(sessionAck());
    ws.receive(sessionAck({ device: ack }));
    ws.receive(sessionAck({ device: { ...ack, capabilities: [{ name: "core.capabilities", version: 1 }] } }));
    ws.receive(sessionAck());
    expect(log.acks).toEqual([undefined, ack]);
    engine.disconnect();
  });

  test("the endpoint's close() closes the socket with its code and stops device routing", async () => {
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const ws = MockWS.instances[0]!;
    log.io!.close!(1002, "app request before core.capabilities opened");
    expect(ws.closedWith).toEqual({ code: 1002, reason: "app request before core.capabilities opened" });
    ws.receive('{"type":"deviceEvent","id":1,"control":{"renewLease":1}}');
    expect(log.texts).toEqual([]);
  });

  test("D1: upgrade headers (refreshed per connect), protocols and a socket factory", async () => {
    let calls = 0;
    const engine = new RemoteEngine("ws://app.test", {
      autoReconnect: false,
      headers: async () => ({ Authorization: `Bearer token-${++calls}` }),
      protocols: "hypen.v1",
    });
    await engine.connect();
    expect(MockWS.instances[0]!.args).toEqual(["ws://app.test", { headers: { Authorization: "Bearer token-1" }, protocols: ["hypen.v1"] }]);
    engine.disconnect();
    await engine.connect();
    expect(MockWS.instances[1]!.args[1]).toEqual({ headers: { Authorization: "Bearer token-2" }, protocols: ["hypen.v1"] });
    engine.disconnect();

    // Nothing configured: the URL alone (what a browser WebSocket accepts).
    const plain = new RemoteEngine("ws://app.test", { autoReconnect: false });
    await plain.connect();
    expect(MockWS.instances[2]!.args).toEqual(["ws://app.test"]);
    plain.disconnect();

    const seen: unknown[] = [];
    const custom = new RemoteEngine("ws://app.test", {
      autoReconnect: false,
      headers: { Authorization: "Bearer x" },
      webSocketFactory: (url, init) => {
        seen.push([url, init]);
        return new MockWS(url) as unknown as WebSocket;
      },
    });
    await custom.connect();
    expect(seen).toEqual([["ws://app.test", { headers: { Authorization: "Bearer x" } }]]);
    custom.disconnect();
  });

  test("a failing headers provider fails the connect with a ConnectionError", async () => {
    const engine = new RemoteEngine("ws://app.test", {
      autoReconnect: false,
      headers: () => {
        throw new Error("no token");
      },
    });
    const res = await engine.connect();
    expect(res.ok).toBe(false);
    expect(MockWS.instances.length).toBe(0);
  });

  test("FakeDeviceHost endpoint over RemoteEngine: refused before the ack, core stream served, app work after", async () => {
    const fake = new FakeDeviceHost().permissionReturns("granted");
    const endpoint = fake.endpoint();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const ws = MockWS.instances[0]!;
    const hello = JSON.parse(ws.sent[0] as string);
    expect(hello.device.capabilities[0]).toEqual({ name: "core.capabilities", versions: [1] });
    const out = () => ws.sent.filter((s): s is string => typeof s === "string").slice(1).map((s) => JSON.parse(s));
    // Before the sessionAck: refused, never executed.
    ws.receive(JSON.stringify(req({ id: 1 })));
    await ticks(2);
    expect(out()).toEqual([{ type: "deviceResponse", id: 1, error: { code: "unsupported", platformDetail: "no device selection yet (sessionAck pending)" }, simulated: true }]);
    ws.receive(sessionAck({ device: { protocolVersion: 1, binary: true, capabilities: hello.device.capabilities.map((c: { name: string }) => ({ name: c.name, version: 1 })) } }));
    ws.receive(JSON.stringify(capsReq(2)));
    ws.receive(JSON.stringify(req({ id: 3 })));
    await ticks(3);
    const msgs = out().slice(1);
    expect(msgs[0]).toMatchObject({ type: "deviceEvent", id: 2, event: { capabilities: hello.device.capabilities } });
    expect(msgs).toContainEqual({ type: "deviceResponse", id: 3, result: { status: "granted" }, simulated: true });
    engine.disconnect();
  });
});
