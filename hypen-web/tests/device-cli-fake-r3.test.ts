/**
 * @hypen-space/device-fake round-3 scenarios end to end over an in-process
 * transport pair: the server broker (Rust, through the port and a
 * `DevicePlane`) + handler-facing `DeviceContext`
 * (the typed round-3 API: `device.camera.capture`, `device.mic.record`,
 * `device.bluetooth.select`, typed `permission.*`) ↔ the fake host's
 * `DeviceClient`. Every terminal is marked `simulated` (RFC 001 §1.11); live
 * items (camera video, mic) stream without a declared size and are
 * hash-verified by the broker.
 */

import { describe, expect, test } from "bun:test";
import {
  DeviceContext,
  sha256Hex,
  type DeviceEvent,
  type DeviceResponse,
} from "@hypen-space/core/remote/device";
import { FakeDeviceHost } from "../packages/device-fake/src/index.ts";
import { fullAck, loopback } from "./device-srv-harness";

/**
 * The fake host's client ↔ the Rust broker (plane) over in-process queues;
 * `selected` is the negotiated selection (plus core.capabilities).
 */
function connect(host: FakeDeviceHost, selected: string[]) {
  const owner = { moduleInstanceId: "profile-7", activationId: 3 };
  const ack = { ...fullAck(), capabilities: fullAck().capabilities.filter((c) => c.name === "core.capabilities" || selected.includes(c.name)) };
  const h = loopback((t) => host.client(t), { ack, owners: [[owner.moduleInstanceId, owner.activationId]] });
  const ctx = new DeviceContext(h.plane, owner, "origin");
  const clientSent = h.clientSent;
  const events = () =>
    clientSent.filter((m): m is DeviceEvent => !(m instanceof Uint8Array) && m.type === "deviceEvent" && "event" in m).map((m) => m.event);
  const responses = () => clientSent.filter((m): m is DeviceResponse => !(m instanceof Uint8Array) && m.type === "deviceResponse");
  return { ctx, clientSent, events, responses };
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

describe("FakeDeviceHost round-3 scenarios", () => {
  test("camera photo: one declared JPEG item through device.camera.capture, simulated", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
    const t = connect(new FakeDeviceHost().cameraReturns({ photo: { bytes: jpeg } }), ["camera.capture"]);
    const res = await t.ctx.camera.capture({ mode: "photo" }, { initialCredit: 65536 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.simulated).toBe(true);
    expect(res.value.items.length).toBe(1);
    expect(res.value.items[0]!.contentType).toBe("image/jpeg");
    expect(Array.from(res.value.items[0]!.bytes)).toEqual(Array.from(jpeg));
    expect(t.events()).toContainEqual({ kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: jpeg.byteLength });
    expect(t.responses()[0]!.simulated).toBe(true);
  });

  test("camera video: chunks stream undeclared (like a recorder) and verify", async () => {
    const chunks = [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(3000).fill(7), new Uint8Array([9])];
    const t = connect(new FakeDeviceHost().cameraReturns({ video: { chunks, chunkDelayMs: 2 } }), ["camera.capture"]);
    const res = await t.ctx.request("camera.capture", { mode: "video", maxDurationMs: 1000 }, { initialCredit: 65536 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items[0]!.contentType).toBe("video/webm");
    expect(Array.from(res.value.items[0]!.bytes)).toEqual(Array.from(concat(chunks)));
    expect(t.events()).toContainEqual({ kind: "blobStart", channel: 0, contentType: "video/webm" }); // no bytes: undeclared
  });

  test("camera: a mode without a scenario is unavailable", async () => {
    const t = connect(new FakeDeviceHost().cameraReturns({ photo: { bytes: new Uint8Array([1]) } }), ["camera.capture"]);
    const res = await t.ctx.camera.capture({ mode: "video" }, { initialCredit: 65536 });
    expect(res).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(t.responses()[0]).toMatchObject({ error: { code: "unavailable" }, simulated: true }); // marked on the wire
  });

  test("mic.record: PCM streams to onData in order; settled carries durationMs and the verified item", async () => {
    const pcm = Array.from({ length: 6 }, (_, k) => new Uint8Array(640).map((_, i) => (i * 7 + k) & 0xff));
    const t = connect(new FakeDeviceHost().micRecords(pcm, { chunkDelayMs: 1 }), ["mic.record"]);
    const delivered: Uint8Array[] = [];
    const handle = t.ctx.mic.record({ format: "pcm16", sampleRate: 16_000 }, (chunk) => {
      delivered.push(chunk.slice());
    });
    const res = await handle.settled;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const all = concat(pcm);
    expect(Array.from(concat(delivered))).toEqual(Array.from(all));
    expect(res.value.durationMs).toBe(120); // 3840 bytes of 16 kHz mono
    expect(res.value.item).toMatchObject({ channel: 0, contentType: "audio/L16", bytes: all.byteLength, sha256: await sha256Hex(all) });
    expect(t.events()).toContainEqual({ kind: "blobStart", channel: 0, contentType: "audio/L16" });
  });

  test("mic.record stereo with maxDurationMs: truncated to whole frames at the limit", async () => {
    const t = connect(new FakeDeviceHost().micRecords([new Uint8Array(10_000).fill(3)]), ["mic.record"]);
    const delivered: Uint8Array[] = [];
    const res = await t.ctx
      .stream("mic.record", { format: "pcm16", sampleRate: 8000, channels: 2, maxDurationMs: 250 }, {}, { onData: (c) => void delivered.push(c.slice()) })
      .settled;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.durationMs).toBe(250);
    expect(res.value.item.bytes).toBe(2000 * 4);
    expect(concat(delivered).byteLength).toBe(8000);
  });

  test("bluetooth.select: identity only", async () => {
    const t = connect(new FakeDeviceHost().bluetoothSelects({ id: "fake-hr-1", name: "Heart Rate" }), ["bluetooth.select"]);
    const res = await t.ctx.bluetooth.select({ services: ["0000180d-0000-1000-8000-00805f9b34fb"] });
    expect(res).toEqual({ ok: true, value: { device: { id: "fake-hr-1", name: "Heart Rate" } }, simulated: true });
  });

  test("permissionsReturn: the closed enum; unmapped names are unsupported with the name", async () => {
    const t = connect(new FakeDeviceHost().permissionsReturn({ camera: "granted", photos: "granted", contacts: "unsupported" }), [
      "permission.query",
      "permission.request",
    ]);
    expect(await t.ctx.request("permission.query", { permission: "camera" })).toEqual({ ok: true, value: { status: "granted" }, simulated: true });
    expect(await t.ctx.request("permission.request", { permission: "photos" })).toEqual({ ok: true, value: { status: "granted" }, simulated: true });
    for (const permission of ["contacts", "location"] as const) {
      expect(await t.ctx.request("permission.query", { permission })).toEqual({
        ok: false,
        error: { code: "unsupported", platformDetail: permission },
      });
    }
    expect(t.responses().every((r) => r.simulated === true)).toBe(true);
  });

  test("the endpoint advertises exactly the registered round-3 scenarios (plus core.capabilities)", () => {
    const endpoint = new FakeDeviceHost()
      .cameraReturns({ photo: { bytes: new Uint8Array([1]) } })
      .micRecords([])
      .bluetoothSelects({ id: "x" })
      .endpoint();
    expect(endpoint.advertisement.capabilities.map((c) => c.name).sort()).toEqual([
      "bluetooth.select",
      "camera.capture",
      "core.capabilities",
      "mic.record",
    ]);
  });
});
