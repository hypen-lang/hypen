/**
 * Device Capability Protocol — end-to-end over an in-process transport pair
 * (RFC 001 §2.4/§2.6/§4). Wires the server broker — the Rust `DeviceBroker`
 * through the port, driven by a `DevicePlane` — and the handler-facing
 * DeviceContext to a client FakeDeviceHost/DeviceClient and runs the real
 * loop: request → (blobStart + frame) → terminal result → hash verification.
 */

import { describe, expect, test } from "bun:test";
import {
  DeviceContext,
  sha256Hex,
  type DeviceEvent,
  type DeviceRequest,
  type DeviceResponse,
} from "@hypen-space/core/remote/device";
import { FakeDeviceHost } from "@hypen-space/device-fake";
import { loopback } from "./device-srv-harness";

const owner = { moduleInstanceId: "profile-7", activationId: 3 };

/**
 * Connect a server plane and a client host with in-process queues (see
 * `loopback`). `serverSent` is every server → client device message.
 */
function connect(host: FakeDeviceHost, opts: { tamper?: (f: Uint8Array) => Uint8Array } = {}) {
  const h = loopback((t) => host.client(t), { owners: [[owner.moduleInstanceId, owner.activationId]] });
  if (opts.tamper) {
    const plane = h.plane;
    const original = plane.receiveFrame.bind(plane);
    plane.receiveFrame = (f: Uint8Array) => original(opts.tamper!(f));
  }
  const ctx = new DeviceContext(h.plane, owner, "origin");
  return { ...h, ctx, serverSent: h.sent };
}

describe("gallery.pick upload end-to-end", () => {
  test("blobStart + frame + terminal result; bytes verified against sha256", async () => {
    const photo = new TextEncoder().encode("hello-hypen-photo");
    const host = new FakeDeviceHost().galleryReturns(photo, "image/jpeg");
    const { ctx, serverSent, clientSent } = connect(host);

    const res = await ctx.request<{ items: Array<{ bytes: Uint8Array; contentType: string }> }>(
      "gallery.pick",
      { mediaTypes: ["photo"], maxCount: 1 },
      { initialCredit: 65536 }
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.value.items[0]!;
    expect(item.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(item.bytes)).toBe("hello-hypen-photo");

    // Exactly one app deviceRequest went out on this transport (after the
    // connection-owned core.capabilities stream).
    expect(serverSent.filter((m) => m.type === "deviceRequest").map((m) => m.capability)).toEqual([
      "core.capabilities",
      "gallery.pick",
    ]);
    // Announcement before bytes, terminal success after its bytes (§2.3).
    expect(blobStartPrecedesBytes(clientSent)).toBe(true);
  });

  test("corrupted bytes fail locally with invalidParams, never a trusted result", async () => {
    const photo = new TextEncoder().encode("hello-hypen-photo");
    // Driver lies: declares a hash for the real bytes but sends different bytes.
    const host = new FakeDeviceHost().driver("gallery.pick", async () => ({
      kind: "result",
      result: {},
      blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }],
    }));
    // Corrupt one byte in transit, simulating a client that hashes real
    // bytes but delivers different ones.
    const { ctx } = connect(host, {
      tamper: (frame) => {
        const tampered = frame.slice();
        tampered[tampered.length - 1] ^= 0xff; // flip a payload bit
        return tampered;
      },
    });

    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalidParams");
  });
});

describe("wire-order helper", () => {
  test("blobStartPrecedesBytes rejects every mis-ordering (it is not a no-op)", () => {
    const start = { type: "deviceEvent", id: 1, event: { kind: "blobStart", channel: 0, contentType: "a/b", bytes: 1 } } as DeviceEvent;
    const frame = new Uint8Array(13);
    const done = { type: "deviceResponse", id: 1, result: {} } as DeviceResponse;
    expect(blobStartPrecedesBytes([start, frame, done])).toBe(true);
    expect(blobStartPrecedesBytes([frame, start, done])).toBe(false);
    expect(blobStartPrecedesBytes([start, done, frame])).toBe(false);
    expect(blobStartPrecedesBytes([start, done])).toBe(false);
    expect(blobStartPrecedesBytes([frame, done])).toBe(false);
  });
});

describe("permission.request", () => {
  test("granted status returned as a value", async () => {
    const host = new FakeDeviceHost().permissionReturns("granted");
    const { ctx } = connect(host);
    const res = await ctx.request("permission.request", { permission: "notifications" });
    expect(res).toMatchObject({ ok: true, value: { status: "granted" } });
  });

  test("denial is an ordinary error value", async () => {
    const host = new FakeDeviceHost().permissionReturns("denied");
    const { ctx } = connect(host);
    const res = await ctx.request("permission.request", { permission: "notifications" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("denied");
  });
});

describe("consent delay and cancellation race", () => {
  test("server cancel before the driver finishes yields cancelled, no upload", async () => {
    const photo = new TextEncoder().encode("hello-hypen-photo");
    // Slow picker: 200ms. We cancel immediately.
    const host = new FakeDeviceHost().galleryReturns(photo, "image/jpeg", 200);
    const { ctx, plane, serverSent, clientSent } = connect(host);

    const p = ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    const reqId = (serverSent.find((m) => m.capability === "gallery.pick") as DeviceRequest).id;
    plane.ownerDeactivated("profile-7", 3); // deactivation cancels it
    expect(serverSent.some((m) => m.id === reqId && m.control?.cancel === true)).toBe(true);

    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 250));
    // The client stopped: no bytes ever flowed for the cancelled request.
    expect(clientSent.some((m) => m instanceof Uint8Array)).toBe(false);
  });
});

describe("simulated marker", () => {
  test("every fake result is marked simulated on the wire", async () => {
    const host = new FakeDeviceHost().permissionReturns("prompt");
    const responses: DeviceResponse[] = [];
    const client = host.client({
      sendMessage: (m) => {
        if (m.type === "deviceResponse") responses.push(m);
      },
      sendBinary: () => {},
    });
    client.handleMessage({
      type: "deviceRequest",
      id: 1,
      capability: "permission.query",
      version: 1,
      owner: { moduleInstanceId: "m", activationId: 1 },
      lifetime: "activation",
      timeoutMs: 30000,
      initialCredit: 0,
      params: { permission: "microphone" },
    });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(responses[0]?.simulated).toBe(true);
  });
});

describe("production guard", () => {
  test("FakeDeviceHost refuses to initialize under NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new FakeDeviceHost()).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("lease acks flow automatically", () => {
  test("client echoes renewLease as leaseAck so the request stays live", async () => {
    const photo = new TextEncoder().encode("hello-hypen-photo");
    const host = new FakeDeviceHost().galleryReturns(photo, "image/jpeg", 10);
    const { ctx, clientSent } = connect(host);
    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    expect(res.ok).toBe(true);
    const acks = clientSent
      .filter((m): m is DeviceEvent => !(m instanceof Uint8Array) && m.type === "deviceEvent")
      .filter((m) => m.control && "leaseAck" in m.control)
      .map((m) => (m.control as { leaseAck: number }).leaseAck);
    expect(acks).toContain(1); // seq 1 acked
  });
});

/**
 * True iff the client's wire order is: blobStart for channel 0, then at least
 * one binary frame, then the terminal deviceResponse — and no frame precedes
 * the announcement or follows the response.
 */
function blobStartPrecedesBytes(clientSent: Array<DeviceResponse | DeviceEvent | Uint8Array>): boolean {
  const isFrame = (x: unknown): x is Uint8Array => x instanceof Uint8Array;
  const start = clientSent.findIndex(
    (m) => !isFrame(m) && m.type === "deviceEvent" && (m.event as { kind?: string } | undefined)?.kind === "blobStart"
  );
  const firstFrame = clientSent.findIndex(isFrame);
  const lastFrame = clientSent.length - 1 - [...clientSent].reverse().findIndex(isFrame);
  const response = clientSent.findIndex((m) => !isFrame(m) && m.type === "deviceResponse");
  return start >= 0 && firstFrame > start && response > lastFrame && firstFrame >= 0;
}

// Keep sha256Hex referenced for API-surface coverage.
void sha256Hex;
