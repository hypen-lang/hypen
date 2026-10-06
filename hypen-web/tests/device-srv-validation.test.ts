/**
 * Server-side strict validation of client → server device traffic
 * (RFC 001 §1.9, §2.1, §2.4, §4) — through a real RemoteSession fed raw
 * JSON text, exactly as the Bun adapter delivers it:
 *
 *  - every deviceResponse/deviceEvent is decoded against envelope-v1
 *    (terminal XOR, single-variant control, object result/event) and the raw
 *    text is checked for duplicate keys;
 *  - results/events are validated against the selected revision BEFORE the
 *    handler sees them;
 *  - a blob result is always verified against blobStart + bytes + sha256.
 *
 * Known-id violations terminate the request with `invalidParams` and send a
 * cancellation (none when the offending message is the client's own
 * terminal); unknown ids are ignored; JSON-limit breaches are
 * connection-level (counted, no request touched — decision D8).
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import {
  DEVICE_PERMISSIONS,
  encodeFrame,
  sha256Hex,
  validateCapabilityPayload,
  type DeviceResult,
} from "@hypen-space/core/remote/device";
import { deviceServerAdvertisement } from "../packages/server/wasm-node/hypen_engine.js";
import { controlsFor, deviceHello, flush, makeHost, makeTransport, requestsOf } from "./device-srv-harness";

type Probe = { result: DeviceResult<any> | null };

/** A session whose "go" action runs `run(context.device)` into `probe`. */
async function start(run: (device: any) => Promise<DeviceResult<any>>) {
  const probe: Probe = { result: null };
  const module = app
    .defineState({})
    .onAction("go", async ({ context }) => {
      probe.result = await run(context.device);
    })
    .build() as unknown as SessionHost["module"];
  const t = makeTransport();
  const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
  await session.receive(JSON.stringify(deviceHello()));
  await session.ready;
  await flush();
  await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" }));
  await flush();
  const req = requestsOf(t.device).at(-1)!;
  return { ...t, session, probe, req };
}

const send = (session: RemoteSession, raw: string | object) =>
  session.receive(typeof raw === "string" ? raw : JSON.stringify(raw));

const permission = (d: any) => d.request("permission.request", { permission: "camera" });
const gallery = (d: any) => d.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });

/**
 * A known-id violation: settled `invalidParams`. The server sends `cancel`
 * — except when the offending message was the client's own terminal
 * `deviceResponse` (`terminal`), which already retired the id: the server
 * then settles locally and sends nothing (RFC 001 §2.1, decision D8).
 */
async function expectInvalid(
  t: Awaited<ReturnType<typeof start>>,
  detail?: RegExp,
  opts: { terminal?: boolean } = {}
): Promise<void> {
  await flush();
  expect(t.probe.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
  if (detail) expect((t.probe.result as any).error.platformDetail).toMatch(detail);
  expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(opts.terminal ? 0 : 1);
  expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(false);
  await t.session.destroy();
}

describe("envelope decode through RemoteSession (#1)", () => {
  test("result AND error in one response → invalidParams, never ok", async () => {
    const t = await start(permission);
    await send(t.session, {
      type: "deviceResponse",
      id: t.req.id,
      result: "not-an-object",
      error: { code: "denied" },
    });
    await expectInvalid(t, undefined, { terminal: true });
  });

  test("non-object result → invalidParams", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: "not-an-object" });
    await expectInvalid(t, undefined, { terminal: true });
  });

  test("neither result nor error → invalidParams (request does not stay live)", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id });
    await expectInvalid(t, undefined, { terminal: true });
  });

  test("simulated must be exactly true", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { status: "granted" }, simulated: false });
    await expectInvalid(t, undefined, { terminal: true });
  });

  test("multi-variant control ({leaseAck, grant}) → invalidParams, first key never wins", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceEvent", id: t.req.id, control: { leaseAck: 1, grant: 5 } });
    await expectInvalid(t);
  });

  test("control of the wrong type (grant: \"5\") → invalidParams", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceEvent", id: t.req.id, control: { grant: "5" } });
    await expectInvalid(t);
  });

  test("event AND control in one deviceEvent → invalidParams", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceEvent", id: t.req.id, event: {}, control: { paused: true } });
    await expectInvalid(t);
  });

  test("duplicate JSON keys in the raw text are connection-level: counted, the request stays live (D8)", async () => {
    const t = await start(permission);
    const before = t.session.deviceBroker!.connectionViolations;
    await send(
      t.session,
      `{"type":"deviceResponse","id":${t.req.id},"error":{"code":"denied"},"error":{"code":"denied"}}`
    );
    await flush();
    // Text breaking the JSON limits is attributable to NO request: the id it
    // seems to name is untrusted, so nothing is cancelled or settled.
    expect(t.session.deviceBroker!.connectionViolations).toBe(before + 1);
    expect(t.session.deviceBroker!.lastConnectionViolation).toMatch(/duplicate key/);
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(0);
    expect(t.probe.result).toBeNull();
    // …and a valid terminal still completes the request.
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { status: "granted" } });
    await flush();
    expect(t.probe.result).toEqual({ ok: true, value: { status: "granted" } });
    await t.session.destroy();
  });

  test("escaped duplicate keys collide after decoding (connection-level)", async () => {
    const t = await start(permission);
    await send(
      t.session,
      `{"type":"deviceResponse","id":${t.req.id},"result":{"status":"granted","st\\u0061tus":"denied"}}`
    );
    await flush();
    expect(t.session.deviceBroker!.lastConnectionViolation).toMatch(/duplicate key/);
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    await t.session.destroy();
  });

  test("repeated connection-level violations close the device connection (1012)", async () => {
    const t = await start(permission);
    for (let i = 0; i < 40; i++) {
      await send(t.session, `{"type":"deviceEvent","id":${t.req.id},"event":{"kind":"progress","state":"running","n":1.0}}`);
    }
    await flush();
    expect(t.session.deviceBroker).toBeNull();
    expect(t.closes.at(-1)?.code).toBe(1012);
    expect(t.probe.result).toMatchObject({ ok: false, error: { code: "connectionLost" } });
    await t.session.destroy();
  });

  test("prototype-named keys are unknown keys, not inherited ones", async () => {
    const t = await start(permission);
    await send(
      t.session,
      `{"type":"deviceResponse","id":${t.req.id},"result":{"status":"granted","constructor":1,"__proto__":{"x":1}}}`
    );
    await expectInvalid(t, undefined, { terminal: true });
  });

  test("result that violates the capability schema → invalidParams before the handler", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { status: "maybe" } });
    // The Rust broker's schema check names the payload, field and rule that failed.
    await expectInvalid(t, /^result \$\.status: unknown variant `maybe`/, { terminal: true });
  });

  test("a valid terminal still settles ok", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { status: "granted" } });
    await flush();
    expect(t.probe.result).toEqual({ ok: true, value: { status: "granted" } });
    await t.session.destroy();
  });

  test("simulated:true is surfaced to the handler", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { status: "granted" }, simulated: true });
    await flush();
    expect(t.probe.result).toEqual({ ok: true, value: { status: "granted" }, simulated: true });
    await t.session.destroy();
  });

  test("malformed messages for unknown ids are ignored (no cancel, no throw)", async () => {
    const t = await start(permission);
    const before = t.device.length;
    await send(t.session, { type: "deviceResponse", id: 9999 });
    await send(t.session, `{"type":"deviceResponse","id":9999,"id":9999}`);
    await send(t.session, { type: "deviceEvent", id: 0, control: { cancel: true } });
    expect(t.device.length).toBe(before);
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    await t.session.destroy();
  });

  test("a late terminal for a retired id (client `cancelled` after our cancel) is silently ignored", async () => {
    const t = await start(permission);
    t.session.deviceBroker!.cancel(t.req.id); // server cancel
    await flush();
    const before = t.device.length;
    await send(t.session, { type: "deviceResponse", id: t.req.id, error: { code: "cancelled" } });
    expect(t.device.length).toBe(before);
    expect(t.closes.length).toBe(0);
    await t.session.destroy();
  });
});

describe("leases (#14)", () => {
  test("a fabricated/future leaseAck → invalidParams + cancel", async () => {
    const t = await start(permission);
    await send(t.session, { type: "deviceEvent", id: t.req.id, control: { leaseAck: 42 } });
    await expectInvalid(t, /never sent/);
  });

  test("wrong-direction controls (cancel / renewLease from the client) → invalidParams", async () => {
    const a = await start(permission);
    await send(a.session, { type: "deviceEvent", id: a.req.id, control: { cancel: true } });
    await expectInvalid(a, /wrong-direction/);
    const b = await start(permission);
    await send(b.session, { type: "deviceEvent", id: b.req.id, control: { renewLease: 1 } });
    await expectInvalid(b, /wrong-direction/);
  });
});

// ---------------------------------------------------------------------------
// Blob results are ALWAYS verified on a binaryUpload revision
// ---------------------------------------------------------------------------

const photo = new TextEncoder().encode("abc");
const blobStart = (id: number, channel = 0, bytes = photo.byteLength) => ({
  type: "deviceEvent",
  id,
  event: { kind: "blobStart", channel, contentType: "image/jpeg", bytes },
});
const frameFor = (id: number, bytes: Uint8Array, channel = 0, seq = 0) =>
  encodeFrame({ version: 1, flags: 0, channel, requestId: id, seq }, bytes);

describe("gallery.pick blob verification (#1, #14)", () => {
  test("result without sha256 → invalidParams (was: ok with bytes as a number)", async () => {
    const t = await start(gallery);
    await send(t.session, blobStart(t.req.id));
    t.session.receiveBinary(frameFor(t.req.id, photo));
    await send(t.session, {
      type: "deviceResponse",
      id: t.req.id,
      result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3 }] },
    });
    // The item schema requires sha256: the result fails the revision schema,
    // and the refusal names the item that lacks it.
    await expectInvalid(t, /^result \$\.items\[0\]: missing field `sha256`$/, { terminal: true });
  });

  test("correct bytes + hash → handler gets verified Uint8Array", async () => {
    const t = await start(gallery);
    await send(t.session, blobStart(t.req.id));
    t.session.receiveBinary(frameFor(t.req.id, photo));
    await send(t.session, {
      type: "deviceResponse",
      id: t.req.id,
      result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3, sha256: await sha256Hex(photo) }] },
    });
    await flush();
    await flush();
    expect(t.probe.result?.ok).toBe(true);
    const item = (t.probe.result as any).value.items[0];
    expect(item.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(item.bytes)).toBe("abc");
    await t.session.destroy();
  });

  test("wrong hash → invalidParams locally (no server→client response)", async () => {
    const t = await start(gallery);
    await send(t.session, blobStart(t.req.id));
    t.session.receiveBinary(frameFor(t.req.id, photo));
    await send(t.session, {
      type: "deviceResponse",
      id: t.req.id,
      result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3, sha256: "0".repeat(64) }] },
    });
    await flush();
    await flush();
    expect(t.probe.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    await t.session.destroy();
  });

  test("result items with no blobStart at all → invalidParams", async () => {
    const t = await start(gallery);
    await send(t.session, {
      type: "deviceResponse",
      id: t.req.id,
      result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3, sha256: await sha256Hex(photo) }] },
    });
    await expectInvalid(t, /announced/, { terminal: true });
  });

  test("duplicate channels in result.items → invalidParams (no announced channel left unverified)", async () => {
    const t = await start((d) => d.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 2 }));
    await send(t.session, blobStart(t.req.id, 0));
    await send(t.session, blobStart(t.req.id, 1));
    t.session.receiveBinary(frameFor(t.req.id, photo, 0));
    t.session.receiveBinary(frameFor(t.req.id, photo, 1));
    const item = { channel: 0, contentType: "image/jpeg", bytes: 3, sha256: await sha256Hex(photo) };
    await send(t.session, { type: "deviceResponse", id: t.req.id, result: { items: [item, item] } });
    await expectInvalid(t, /twice|duplicate/, { terminal: true });
  });

  test("a blobStart channel beyond params.maxCount → invalidParams before any sink", async () => {
    const t = await start(gallery); // maxCount 1 ⇒ channel 0 only
    await send(t.session, blobStart(t.req.id, 1));
    await expectInvalid(t, /outside/);
  });

  test("an unknown event kind on an upload → invalidParams", async () => {
    const t = await start(gallery);
    await send(t.session, { type: "deviceEvent", id: t.req.id, event: { kind: "surprise" } });
    await expectInvalid(t);
  });

  test("an optional progress event is accepted and ignored", async () => {
    const t = await start(gallery);
    await send(t.session, { type: "deviceEvent", id: t.req.id, event: { kind: "progress", state: "pendingConsent" } });
    expect(t.session.deviceBroker!.isLive(t.req.id)).toBe(true);
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(0);
    await t.session.destroy();
  });
});

// ---------------------------------------------------------------------------
// Handler API edges (#14)
// ---------------------------------------------------------------------------

describe("DeviceContext edges (#14)", () => {
  test("explicit initialCredit: 0 on an upload is refused invalidParams — nothing is sent", async () => {
    const probe: Probe = { result: null };
    const module = app
      .defineState({})
      .onAction("go", async ({ context }) => {
        probe.result = await context.device.request(
          "gallery.pick",
          { mediaTypes: ["photo"], maxCount: 1 },
          { initialCredit: 0 }
        );
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    const before = requestsOf(t.device).length;
    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" }));
    await flush();
    expect(probe.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(requestsOf(t.device).length).toBe(before);
    await session.destroy();
  });

  test("AbortSignal cancels an in-flight request (control.cancel sent, settles cancelled)", async () => {
    const controller = new AbortController();
    const t = await start((d) => d.request("permission.request", { permission: "camera" }, { signal: controller.signal }));
    expect(t.probe.result).toBeNull();
    controller.abort();
    await flush();
    expect(t.probe.result).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(controlsFor(t.device, t.req.id, "cancel").length).toBe(1);
    await t.session.destroy();
  });

  test("an already-aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe: Probe = { result: null };
    const module = app
      .defineState({})
      .onAction("go", async ({ context }) => {
        probe.result = await context.device.request("permission.request", { permission: "camera" }, { signal: controller.signal });
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    const before = requestsOf(t.device).length;
    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" }));
    await flush();
    expect(probe.result).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(requestsOf(t.device).length).toBe(before);
    await session.destroy();
  });

  test("device.save refuses a 0-byte payload (matches the client), nothing sent", async () => {
    const probe: Probe = { result: null };
    const module = app
      .defineState({})
      .onAction("go", async ({ context }) => {
        probe.result = await context.device.save(new Uint8Array(0), { name: "a.txt", contentType: "text/plain" });
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    const before = requestsOf(t.device).length;
    await session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" }));
    await flush();
    expect(probe.result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(requestsOf(t.device).length).toBe(before);
    await session.destroy();
  });
});

describe("generated validators (#13)", () => {
  test("prototype-named keys never pass a closed schema", () => {
    const params = JSON.parse('{"mediaTypes":["photo"],"maxCount":1,"constructor":1,"toString":2,"__proto__":{"x":1}}');
    const v = validateCapabilityPayload("gallery.pick", 1, "params", params);
    expect(v.map((x) => x.message).join(" ")).toMatch(/constructor/);
    expect(v.map((x) => x.message).join(" ")).toMatch(/__proto__/);
  });

  test("required keys are own keys (an inherited `permission` does not satisfy required)", () => {
    const proto = { permission: "camera" };
    const params = Object.create(proto);
    expect(validateCapabilityPayload("permission.query", 1, "params", params)).not.toEqual([]);
  });

  test("string lengths count Unicode code points, not UTF-16 units", () => {
    // bluetooth.select namePrefix is maxLength 64: 64 astral code points =
    // 128 UTF-16 units. (permission.query's `permission` became a closed
    // enum in round 3 — P1 — so it no longer carries a length bound.)
    const astral = "\u{1F600}".repeat(64);
    expect(astral.length).toBe(128);
    expect(validateCapabilityPayload("bluetooth.select", 1, "params", { namePrefix: astral })).toEqual([]);
    expect(
      validateCapabilityPayload("bluetooth.select", 1, "params", { namePrefix: astral + "x" })
    ).not.toEqual([]);
  });

  test("permission is the closed P1 enum: every listed name passes, anything else fails at decode", () => {
    for (const permission of DEVICE_PERMISSIONS) {
      expect(validateCapabilityPayload("permission.query", 1, "params", { permission })).toEqual([]);
      expect(validateCapabilityPayload("permission.request", 1, "params", { permission })).toEqual([]);
    }
    expect([...DEVICE_PERMISSIONS]).toEqual([
      "camera",
      "microphone",
      "photos",
      "location",
      "notifications",
      "bluetooth",
      "contacts",
    ]);
    for (const permission of ["camra", "geolocation", "Camera", "", "camera ", "\u{1F600}"]) {
      expect(validateCapabilityPayload("permission.query", 1, "params", { permission })).not.toEqual([]);
      expect(validateCapabilityPayload("permission.request", 1, "params", { permission })).not.toEqual([]);
    }
  });

  test("minItems / uniqueItems are enforced where the schema declares them", () => {
    expect(validateCapabilityPayload("gallery.pick", 1, "params", { mediaTypes: [], maxCount: 1 })).not.toEqual([]);
    expect(
      validateCapabilityPayload("gallery.pick", 1, "params", { mediaTypes: ["photo", "photo"], maxCount: 1 })
    ).not.toEqual([]);
  });

  test("the server advertisement (Rust) has one row per capability name, versions ascending", () => {
    const adv: Array<{ name: string; versions: number[] }> = deviceServerAdvertisement();
    expect(adv.length).toBeGreaterThan(0);
    const names = adv.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of adv) {
      expect([...c.versions].sort((a, b) => a - b)).toEqual(c.versions);
      expect(new Set(c.versions).size).toBe(c.versions.length);
    }
  });
});
