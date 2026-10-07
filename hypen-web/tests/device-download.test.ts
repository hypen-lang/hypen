/**
 * Device Capability Protocol — server → client download (`file.save`,
 * RFC 001 §2.4), end to end: `DeviceContext.save` ↔ `DeviceBroker` ↔
 * `DeviceClient` + an inline driver that uses `DriverContext.download`.
 *
 * The request is the announcement and carries `initialCredit: 0`; the broker
 * sends ≤ 64 KiB channel-0 frames only within credit the client grants, and
 * the client grants nothing until the driver calls `receiveAll()` (after
 * consent / destination selection).
 */

import { describe, expect, test } from "bun:test";
import {
  DeviceClient,
  DeviceContext,
  decodeFrame,
  encodeFrame,
  sha256Hex,
  type DevicePlane,
  type DeviceDriver,
  type DeviceEvent,
  type DeviceRequest,
  type DeviceResponse,
  type DownloadSink,
} from "@hypen-space/core/remote/device";
import { FakeClock, makePlane, spec } from "./device-srv-harness";

const owner = { moduleInstanceId: "m1", activationId: 1 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}
async function until(fn: () => boolean, max = 200) {
  for (let i = 0; i < max && !fn(); i++) await tick();
}

const payloadLen = (f: Uint8Array) => {
  const d = decodeFrame(f);
  return d.ok ? d.payload.byteLength : 0;
};

interface Harness {
  ctx: DeviceContext;
  plane: DevicePlane;
  /** Frames the broker handed to the transport, in order. */
  bulk: Uint8Array[];
  /** Client → server messages. */
  clientSent: Array<DeviceResponse | DeviceEvent>;
  /** Server → client JSON (app requests; core.capabilities stays server-side). */
  serverSent: any[];
  /** Running (cumulative granted, cumulative payload sent) at each frame send. */
  ledger: Array<{ granted: number; sent: number }>;
  /** Bytes the inline driver wrote, and its receiveAll failure code. */
  written: Uint8Array | null;
  failure: string | null;
  /** Resolve to let the driver "consent" and call receiveAll(). */
  consent(): void;
  sink(): DownloadSink | undefined;
  client: DeviceClient;
}

/**
 * `DeviceContext.save` ↔ the Rust broker (plane) ↔ `DeviceClient` with an
 * inline `file.save` driver, over in-process queues.
 */
function harness(opts: { tamper?: (f: Uint8Array) => Uint8Array; clock?: FakeClock } = {}): Harness {
  let client!: DeviceClient;
  let granted = 0;
  let sentBytes = 0;
  let consent!: () => void;
  const consented = new Promise<void>((r) => (consent = r));
  let lastSink: DownloadSink | undefined;
  let core: number | undefined;
  const h = {
    bulk: [] as Uint8Array[],
    clientSent: [] as Array<DeviceResponse | DeviceEvent>,
    serverSent: [] as any[],
    ledger: [] as Array<{ granted: number; sent: number }>,
    written: null as Uint8Array | null,
    failure: null as string | null,
    consent: () => consent(),
    sink: () => lastSink,
  } as unknown as Harness;

  const p = makePlane({
    ...(opts.clock ? { clock: opts.clock } : {}),
    onSend: (m) => {
      if (core === undefined || m.id === core) return;
      h.serverSent.push(m);
      queueMicrotask(() => client.handleMessage(m as DeviceRequest | DeviceEvent));
    },
    onFrameOut: (frame) => {
      h.bulk.push(frame);
      sentBytes += payloadLen(frame);
      h.ledger.push({ granted, sent: sentBytes });
      const out = opts.tamper ? opts.tamper(frame) : frame;
      queueMicrotask(() => client.handleFrame(out));
    },
  });
  core = p.core;

  const saveDriver: DeviceDriver = async ({ download, cancelled }) => {
    lastSink = download;
    if (!download) return { kind: "error", code: "internal", platformDetail: "no sink" };
    const gate = await Promise.race([consented.then(() => "go" as const), cancelled.then(() => "stop" as const)]);
    if (gate === "stop") return { kind: "error", code: "cancelled" };
    try {
      const bytes = await download.receiveAll();
      h.written = bytes;
      return { kind: "result", result: { bytesWritten: bytes.byteLength } };
    } catch (err) {
      const code = (err as { code: string }).code;
      h.failure = code;
      return { kind: "error", code: code as "invalidParams" };
    }
  };

  client = new DeviceClient(
    {
      sendMessage: (m) => {
        h.clientSent.push(m);
        if (m.type === "deviceEvent" && m.control && "grant" in m.control) granted += m.control.grant;
        queueMicrotask(() => p.receive(m));
      },
      sendBinary: () => {
        throw new Error("client must not send binary on a download");
      },
    },
    new Map([["file.save", saveDriver]])
  );

  h.ctx = new DeviceContext(p.plane, owner, "origin");
  h.plane = p.plane;
  h.client = client;
  return h;
}

const grantsOf = (msgs: Array<DeviceResponse | DeviceEvent>) =>
  msgs
    .filter((m): m is DeviceEvent => m.type === "deviceEvent" && !!m.control && "grant" in m.control)
    .map((m) => (m.control as { grant: number }).grant);

describe("file.save download end to end", () => {
  test("nothing is sent before the client grants; bytes arrive verified after consent", async () => {
    const data = new Uint8Array(600 * 1024).map((_, i) => (i * 7 + 3) & 0xff);
    const h = harness();
    const p = h.ctx.save(data, { name: "report.bin", contentType: "application/octet-stream" });

    await until(() => h.sink() !== undefined);
    await ticks(5);
    const req = h.serverSent.find((m): m is DeviceRequest => m.type === "deviceRequest")!;
    expect(req.capability).toBe("file.save");
    expect(req.initialCredit).toBe(0);
    expect(req.params).toEqual({
      channel: 0,
      name: "report.bin",
      contentType: "application/octet-stream",
      bytes: data.byteLength,
      sha256: await sha256Hex(data),
    });
    // The sink exposes the declaration; no grant yet, so no frames.
    expect(h.sink()!.declared).toEqual({
      name: "report.bin",
      contentType: "application/octet-stream",
      bytes: data.byteLength,
      sha256: await sha256Hex(data),
    });
    expect(grantsOf(h.clientSent)).toEqual([]);
    expect(h.bulk.length).toBe(0);

    h.consent();
    const res = await p;
    expect(res).toEqual({ ok: true, value: { bytesWritten: data.byteLength } });
    expect(h.written).toEqual(data);

    // Frames: channel 0, contiguous seq from 0, each ≤ 64 KiB.
    const headers = h.bulk.map((f) => (decodeFrame(f) as { header: { channel: number; seq: number } }).header);
    expect(headers.every((x) => x.channel === 0)).toBe(true);
    expect(headers.map((x) => x.seq)).toEqual(headers.map((_, i) => i));
    for (const f of h.bulk) expect(payloadLen(f)).toBeLessThanOrEqual(64 * 1024);
    // The server never ran ahead of granted credit.
    for (const row of h.ledger) expect(row.sent).toBeLessThanOrEqual(row.granted);
    // The client kept ≤ 256 KiB outstanding and never granted past the size.
    const gs = grantsOf(h.clientSent);
    expect(gs[0]).toBe(256 * 1024);
    expect(gs.reduce((a, b) => a + b, 0)).toBe(data.byteLength);
  });

  test("hash mismatch in transit → receiveAll rejects invalidParams; handler sees invalidParams", async () => {
    const data = new TextEncoder().encode("the quick brown fox");
    const h = harness({
      tamper: (f) => {
        const t = f.slice();
        t[t.length - 1] ^= 0xff;
        return t;
      },
    });
    const p = h.ctx.save(data, { name: "fox.txt", contentType: "text/plain" });
    await until(() => h.sink() !== undefined);
    h.consent();
    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalidParams");
    expect(h.failure).toBe("invalidParams");
    // Exactly one terminal response from the client.
    expect(h.clientSent.filter((m) => m.type === "deviceResponse").length).toBe(1);
  });

  test("server cancel → receiveAll rejects with code cancelled", async () => {
    const data = new Uint8Array(10);
    const h = harness();
    const p = h.ctx.save(data, { name: "x", contentType: "application/octet-stream" });
    await until(() => h.sink() !== undefined);
    const pending = h.sink()!.receiveAll(); // grants…
    h.plane.ownerDeactivated("m1", 1); // …but the owner is swept first
    // The sweep retires the id synchronously, before the grant reaches the
    // broker, so no bytes are ever sent and the sink observes the cancel.
    const err = await pending.then(() => null, (e) => e as { code: string });
    expect(err?.code).toBe("cancelled");
    expect(await p).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.bulk.length).toBe(0);
  });

  test("a client that never grants receives nothing; the deadline still applies", async () => {
    const clock = new FakeClock();
    const h = harness({ clock });
    const p = h.ctx.save(new Uint8Array(1000), { name: "n", contentType: "a/b", timeoutMs: 3_000 });
    await until(() => h.sink() !== undefined);
    await ticks(3);
    // Keep the lease alive (acks flow automatically); advance past the deadline.
    for (let i = 0; i < 4; i++) {
      clock.advance(1_000);
      await ticks(2);
    }
    expect(await p).toEqual({ ok: false, error: { code: "timeout" } });
    expect(h.bulk.length).toBe(0);
  });
});

describe("download hostile/edge cases", () => {
  test("frames beyond granted credit are rejected by the client without writing", async () => {
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    let sink: DownloadSink | undefined;
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(m), sendBinary: () => {} },
      new Map<string, DeviceDriver>([
        [
          "file.save",
          async ({ download, cancelled }) => {
            sink = download;
            await cancelled; // never consents
            return { kind: "error", code: "cancelled" };
          },
        ],
      ])
    );
    const bytes = new Uint8Array(100);
    client.handleMessage({
      type: "deviceRequest",
      id: 5,
      capability: "file.save",
      version: 1,
      owner: { moduleInstanceId: "m1", activationId: 1 },
      lifetime: "activation",
      timeoutMs: 60_000,
      initialCredit: 0,
      params: { channel: 0, name: "a", contentType: "a/b", bytes: 100, sha256: await sha256Hex(bytes) },
    });
    await ticks(2);
    expect(sink).toBeDefined();
    // Hostile server: bytes without any grant.
    client.handleFrame(encodeFrame({ version: 1, flags: 0, channel: 0, requestId: 5, seq: 0 }, bytes));
    await ticks(2);
    const res = sent.filter((m): m is DeviceResponse => m.type === "deviceResponse");
    expect(res.length).toBe(1);
    expect(res[0]!.error?.code).toBe("invalidParams");
    const err = await sink!.receiveAll().then(() => null, (e) => e as { code: string });
    expect(err?.code).toBe("invalidParams");
    // Frames for unknown ids are dropped silently.
    client.handleFrame(encodeFrame({ version: 1, flags: 0, channel: 0, requestId: 99, seq: 0 }, bytes));
    await ticks(1);
    expect(sent.filter((m) => m.type === "deviceResponse").length).toBe(1);
  });

  test("client refuses a download request with nonzero initialCredit or bad params", async () => {
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    let ran = false;
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(m), sendBinary: () => {} },
      new Map<string, DeviceDriver>([["file.save", async () => ((ran = true), { kind: "result", result: { bytesWritten: 0 } })]])
    );
    const base = {
      type: "deviceRequest" as const,
      capability: "file.save",
      version: 1,
      owner: { moduleInstanceId: "m1", activationId: 1 },
      lifetime: "activation" as const,
      timeoutMs: 60_000,
    };
    client.handleMessage({ ...base, id: 1, initialCredit: 1, params: { channel: 0, name: "a", contentType: "a/b", bytes: 1, sha256: "0".repeat(64) } });
    client.handleMessage({ ...base, id: 2, initialCredit: 0, params: { channel: 0, name: "a", contentType: "a/b", bytes: 1, sha256: "nothex" } });
    await ticks(2);
    expect(ran).toBe(false);
    expect(sent.map((m) => (m as DeviceResponse).error?.code)).toEqual(["invalidParams", "invalidParams"]);
  });

  const announce = async (bytes: Uint8Array) => ({
    channel: 0,
    name: "a.bin",
    contentType: "application/octet-stream",
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });

  test("broker: grant overflowing max_outstanding_credit → invalidParams + cancel", async () => {
    const h = makePlane();
    const bytes = new Uint8Array(10);
    const r = h.plane.open(spec("file.save", await announce(bytes), { timeoutMs: 60_000, download: bytes }));
    expect(r.id).not.toBeNull();
    h.receive({ type: "deviceEvent", id: r.id, control: { grant: 8 * 1024 * 1024 + 1 } });
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
    expect(h.sent.some((m) => m.type === "deviceEvent" && m.id === r.id && m.control && "cancel" in m.control)).toBe(true);
  });

  test("broker never hands more than the granted amount, even for a small grant", async () => {
    const h = makePlane();
    const bytes = new Uint8Array(200 * 1024);
    const r = h.plane.open(spec("file.save", await announce(bytes), { timeoutMs: 60_000, download: bytes }));
    await ticks(2);
    expect(h.frames.length).toBe(0);
    h.receive({ type: "deviceEvent", id: r.id, control: { grant: 1000 } });
    await ticks(2);
    expect(h.frames.map(payloadLen)).toEqual([1000]);
    h.receive({ type: "deviceEvent", id: r.id, control: { grant: 100 * 1024 } });
    await ticks(3);
    expect(h.frames.map(payloadLen)).toEqual([1000, 64 * 1024, 100 * 1024 - 64 * 1024]);
    r.cancel();
  });

  test("broker: the announcement must describe exactly the download (refused locally)", async () => {
    const h = makePlane();
    const before = h.sent.length;
    const bytes = new Uint8Array(10);
    const wrong = { ...(await announce(bytes)), sha256: "0".repeat(64) };
    const r = h.plane.open(spec("file.save", wrong, { download: bytes }));
    expect(r.id).toBeNull();
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
    expect(h.sent.length).toBe(before);
  });

  test("DeviceContext.save without a binary route is unsupported", async () => {
    const h = makePlane({ noFrames: true });
    const ctx = new DeviceContext(h.plane, owner, "origin");
    expect(await ctx.save(new Uint8Array(1), { name: "a", contentType: "a/b" })).toEqual({
      ok: false,
      error: { code: "unsupported", platformDetail: "no binary route" },
    });
  });
});
