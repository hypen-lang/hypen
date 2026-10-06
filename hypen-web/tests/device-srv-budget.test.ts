/**
 * Upload memory bounds (#2, RFC 001 §2.3/§2.4/§5):
 *  - a zero-length upload frame is a protocol violation (previously 300k
 *    empty frames at zero credit were all buffered);
 *  - a per-connection retained-bytes budget is checked at every blobStart
 *    (declared totals) and per frame: 128 MiB default, 16 MiB on a DO;
 *  - a host with a smaller budget caps the per-item limit it honors.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  encodeFrame,
  type DevicePlane,
  type DeviceResult,
} from "@hypen-space/core/remote/device";
import { DO_DEVICE_MAX_RETAINED_BYTES } from "../packages/cf/src/index";
import { controlsFor, deviceHello, flush, makeHost, makePlane, makeTransport, requestsOf, spec } from "./device-srv-harness";

const MIB = 1024 * 1024;

/** The Rust broker through the port (plane + fake clock). */
function makeBroker(opts: { maxRetainedBytes?: number } = {}) {
  const h = makePlane({ config: opts });
  const broker = Object.assign(h.plane, {
    receive: h.receive,
  }) as DevicePlane & { receive: typeof h.receive };
  return { broker, sent: h.sent };
}

const openUpload = (broker: DevicePlane, initialCredit = 0) =>
  broker.open(
    spec("gallery.pick", { mediaTypes: ["photo"], maxCount: 16 }, {
      timeoutMs: 300_000,
      initialCredit,
      // Zero credit is protocol-legal (the sender pauses and the broker
      // widens the window); handler APIs refuse it, the broker allows it.
      ...(initialCredit === 0 ? { allowZeroCredit: true } : {}),
    })
  );

const blobStart = (id: number | null, channel: number, bytes: number) => ({
  type: "deviceEvent" as const,
  id,
  event: { kind: "blobStart", channel, contentType: "image/jpeg", bytes },
});
const frame = (id: number | null, channel: number, seq: number, len: number) =>
  encodeFrame({ version: 1, flags: 0, channel, requestId: id!, seq }, new Uint8Array(len));

describe("zero-length frames", () => {
  test("an empty frame is a violation even at zero credit — the flood stops at frame one", async () => {
    const { broker, sent } = makeBroker();
    const h = openUpload(broker, 0);
    broker.receive(blobStart(h.id, 0, 10));
    let accepted = 0;
    for (let seq = 0; seq < 300_000; seq++) {
      if (broker.receiveFrame(frame(h.id, 0, seq, 0))) accepted += 1;
    }
    expect(accepted).toBe(0);
    const s = await h.settled;
    expect(s).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/zero-length/) } });
    expect(sent.filter((m) => m.type === "deviceEvent" && (m as any).control?.cancel).length).toBe(1);
    expect(broker.isLive(h.id!)).toBe(false);
  });
});

describe("per-connection retained-bytes budget", () => {
  test("default budget is 128 MiB on Node/Bun", () => {
    expect(DEFAULT_MAX_RETAINED_BYTES).toBe(128 * MIB);
    expect(makeBroker().broker.maxRetainedBytes).toBe(128 * MIB);
    expect(DO_DEVICE_MAX_RETAINED_BYTES).toBe(16 * MIB);
  });

  test("declared totals across requests are checked at blobStart: the overflowing one is throttled", async () => {
    const { broker } = makeBroker({ maxRetainedBytes: 100 });
    const a = openUpload(broker, 64);
    const b = openUpload(broker, 64);
    broker.receive(blobStart(a.id, 0, 60));
    expect(broker.retainedBytes).toBe(60);
    broker.receive(blobStart(b.id, 0, 30));
    expect(broker.retainedBytes).toBe(90);
    broker.receive(blobStart(b.id, 1, 20)); // 110 > 100
    expect(await b.settled).toMatchObject({ error: { code: "throttled" } });
    // Settling b released its reservation; a is untouched.
    expect(broker.retainedBytes).toBe(60);
    expect(broker.isLive(a.id!)).toBe(true);
  });

  test("the reservation is released on every terminal (success, error, cancel)", async () => {
    const { broker } = makeBroker({ maxRetainedBytes: 100 });
    const a = openUpload(broker, 64);
    broker.receive(blobStart(a.id, 0, 90));
    a.cancel();
    await a.settled;
    expect(broker.retainedBytes).toBe(0);
    const b = openUpload(broker, 64);
    broker.receive(blobStart(b.id, 0, 90)); // fits again
    expect(broker.isLive(b.id!)).toBe(true);
    expect(broker.retainedBytes).toBe(90);
  });

  test("16 items × 64 MiB can no longer be declared on one connection", async () => {
    const { broker } = makeBroker();
    const h = openUpload(broker, 64 * 1024);
    for (let c = 0; c < 16 && broker.isLive(h.id!); c++) broker.receive(blobStart(h.id, c, 64 * MIB));
    expect(await h.settled).toMatchObject({ error: { code: "throttled" } });
    expect(broker.retainedBytes).toBe(0);
  });
});

describe("host budget through RemoteSession (the Durable Object profile)", () => {
  async function session(budget: number | undefined, run: (d: any) => Promise<DeviceResult<any>>) {
    const probe: { result: DeviceResult<any> | null } = { result: null };
    const module = app
      .defineState({})
      .onAction("go", async ({ context }) => {
        probe.result = await run(context.device);
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const s = new RemoteSession(makeHost(module, { deviceMaxRetainedBytes: budget }), t.transport, {
      helloGraceMs: null,
    });
    await s.receive(JSON.stringify(deviceHello()));
    await s.ready;
    await s.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" }));
    await flush();
    return { ...t, s, probe };
  }

  test("a 16 MiB host refuses a 17 MiB declaration before any sink exists", async () => {
    const t = await session(DO_DEVICE_MAX_RETAINED_BYTES, (d) =>
      d.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 })
    );
    const req = requestsOf(t.device, "gallery.pick")[0]!;
    expect(t.s.deviceBroker!.maxRetainedBytes).toBe(16 * MIB);
    await t.s.receive(JSON.stringify(blobStart(req.id, 0, 17 * MIB)));
    await flush();
    expect(t.probe.result).toMatchObject({ ok: false });
    expect(t.s.deviceBroker!.retainedBytes).toBe(0);
    expect(controlsFor(t.device, req.id, "cancel").length).toBe(1);
    // The capped registry is what the host enforces per item.
    expect(t.s.deviceBroker!.revision("gallery.pick", 1)!.maxItemBytes).toBe(16 * MIB);
    await t.s.destroy();
  });

  test("device.save on a 16 MiB host refuses a payload above the capped item size", async () => {
    const t = await session(DO_DEVICE_MAX_RETAINED_BYTES, (d) =>
      d.save(new Uint8Array(16 * MIB + 1), { name: "big.bin", contentType: "application/octet-stream" })
    );
    await flush();
    expect(t.probe.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(requestsOf(t.device, "file.save").length).toBe(0);
    await t.s.destroy();
  });

  test("the default host keeps the registry's 64 MiB item cap", async () => {
    const t = await session(undefined, async () => ({ ok: true, value: null }));
    expect(t.s.deviceBroker!.revision("gallery.pick", 1)!.maxItemBytes).toBe(64 * MIB);
    expect(t.s.deviceBroker!.maxRetainedBytes).toBe(128 * MIB);
    await t.s.destroy();
  });
});
