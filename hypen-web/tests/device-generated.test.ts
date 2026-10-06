/**
 * Device Capability Protocol — Phase 1 conformance (RFC 001).
 *
 * 1. Generated-diff gate: generated.ts must match regeneration exactly.
 * 2. TS transcript runner: replays every shared fixture through the
 *    generated validators + envelope invariants (mirror of the Rust
 *    reference runner in hypen-engine-rs/tests/test_device_transcripts.rs).
 * 3. Golden frame bytes through the native TS codec.
 * 4. Handshake selection pinned against the shared fixtures (the Rust
 *    selection through WASM — TS has no selection code of its own).
 * 5. Legacy wire unchanged when the device extension is absent.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import {
  decodeDeviceMessage,
  decodeFrame,
  encodeFrame,
  findRevision,
  FRAME_HEADER_LEN,
  validateCapabilityPayload,
  validateDeviceMessage,
  type DeviceMessage,
  type DeviceRequest,
} from "@hypen-space/core/remote/device";
import type { HelloMessage, SessionAckMessage } from "@hypen-space/core/remote";
import {
  deviceSelectAck,
  deviceServerAdvertisement,
  deviceValidateHello,
} from "../packages/server/wasm-node/hypen_engine.js";

/** What a broker-backed server advertises — the Rust answer, never a TS table. */
const ADVERTISED: Array<{ name: string; versions: number[] }> = deviceServerAdvertisement();

const FIXTURES = resolve(
  import.meta.dir,
  "../../engine-compatibility-tests/fixtures/device"
);
const TRANSCRIPTS = join(FIXTURES, "transcripts");

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const loadJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

describe("generated-diff gate", () => {
  test("generated.ts matches regeneration", () => {
    const result = spawnSync(
      "bun",
      [resolve(import.meta.dir, "../scripts/generate-device-types.ts"), "--check"],
      { encoding: "utf-8" }
    );
    expect(result.stderr ?? "").toBe("");
    expect(result.status).toBe(0);
  });
});

describe("transcript fixtures", () => {
  const files = readdirSync(TRANSCRIPTS).filter((f) => f.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThan(0);

  const ownerMatchesLifetime = (req: DeviceRequest): boolean => {
    const owner = req.owner as Record<string, unknown>;
    switch (req.lifetime) {
      case "activation":
        return "moduleInstanceId" in owner && "activationId" in owner;
      case "background":
        return "moduleInstanceId" in owner && !("activationId" in owner);
      case "connection":
        return owner.connection === true;
    }
  };

  for (const file of files) {
    const doc = loadJson(join(TRANSCRIPTS, file));

    if (doc.hello !== undefined) {
      test(`${file}: handshake selection matches fixture`, () => {
        // A hello failing handshake-v1 disables device access (decision D7);
        // every fixture that expects an ack carries a valid hello.
        // (Validated by the Rust decoder — a hello is the server's to judge.)
        if (doc.expectAck !== null) expect(deviceValidateHello(JSON.stringify(doc.hello))).toMatchObject({ ok: true });
        const ack = deviceSelectAck(
          JSON.stringify(doc.hello),
          doc.serverProtocolVersions,
          doc.serverCapabilities,
          doc.serverBinary
        );
        if (doc.expectAck === null) expect(ack).toBeNull();
        else expect(ack).toEqual(doc.expectAck);
      });
      continue;
    }

    test(`${file}: messages validate and hold envelope invariants`, () => {
      const requests = new Map<number, DeviceRequest>();
      /** Progress never goes back to pendingConsent after running or data. */
      const progressed = new Set<number>();
      for (const step of doc.steps) {
        // Stale-id steps are dropped whatever they contain (decision D8).
        if (step.ignored) continue;
        if (typeof step.raw === "string") {
          const decoded = decodeDeviceMessage(step.raw);
          if (step.expectViolation === "malformed") expect(decoded.ok).toBe(false);
          else expect(decoded.ok).toBe(true);
          continue;
        }
        if (step.frame) {
          if (step.frame.header && step.dir === "c2s" && step.expectViolation === undefined) {
            progressed.add(step.frame.header.requestId);
          }
          if (step.expectViolation !== undefined) continue; // stateful: see the broker replay
          const bytes = hexToBytes(step.frame.hex);
          const decoded = decodeFrame(bytes);
          if (!decoded.ok) throw new Error(`${file}: golden frame rejected`);
          expect(decoded.header).toEqual(step.frame.header);
          expect(
            bytesToHex(encodeFrame(decoded.header, decoded.payload))
          ).toBe(step.frame.hex);
          continue;
        }
        const raw = step.message;
        if (step.expectViolation !== undefined) {
          // Violation steps: "malformed" must fail the strict decoder;
          // "invalidPayload" must fail decode or the selected revision's
          // payload/registry checks; every other category is a stateful
          // (direction/credit/blob/lease/sequence) violation of an
          // envelope-valid message — replayed through the server broker in
          // device-srv-conformance.test.ts.
          const decoded = decodeDeviceMessage(JSON.stringify(raw));
          if (step.expectViolation === "malformed") {
            expect(decoded.ok).toBe(false);
          } else if (step.expectViolation === "invalidPayload") {
            const regression =
              raw.type === "deviceEvent" &&
              raw.event?.kind === "progress" &&
              raw.event.state === "pendingConsent" &&
              progressed.has(raw.id);
            expect(!decoded.ok || payloadViolation(raw, requests) || regression).toBe(true);
          } else {
            expect(decoded.ok).toBe(true);
          }
          continue;
        }
        expect(validateDeviceMessage(raw)).toEqual([]);
        expect(decodeDeviceMessage(JSON.stringify(raw)).ok).toBe(true);
        const msg = raw as DeviceMessage;
        if (msg.type === "deviceRequest") requests.set(msg.id, msg);
        if (msg.type === "deviceEvent" && msg.event !== undefined && step.dir === "c2s") {
          const ev = msg.event as { kind?: unknown; state?: unknown };
          if (ev.kind !== "progress" || ev.state === "running") progressed.add(msg.id);
        }

        if (msg.type === "deviceRequest") {
          expect(step.dir).toBe("s2c");
          expect(ownerMatchesLifetime(msg)).toBe(true);
          // A server only ever requests a revision it advertises.
          const cap = ADVERTISED.find((c) => c.name === msg.capability);
          expect(cap?.versions).toContain(msg.version);
          expect(
            validateCapabilityPayload(msg.capability, msg.version, "params", msg.params)
          ).toEqual([]);
          expect(payloadViolation(msg, requests)).toBe(false);
        } else if (msg.type === "deviceResponse") {
          expect(step.dir).toBe("c2s");
          // Terminal XOR is enforced by the schema's oneOf; double-check.
          expect(("result" in raw) !== ("error" in raw)).toBe(true);
        } else {
          // deviceEvent: event XOR control, enforced by schema; re-check.
          expect(("event" in raw) !== ("control" in raw)).toBe(true);
        }
      }
    });
  }

  test("XOR guards reject malformed messages", () => {
    expect(
      validateDeviceMessage({ type: "deviceResponse", id: 1, result: {}, error: { code: "denied" } })
    ).not.toEqual([]);
    expect(validateDeviceMessage({ type: "deviceResponse", id: 1 })).not.toEqual([]);
    expect(
      validateDeviceMessage({ type: "deviceEvent", id: 1, event: {}, control: { cancel: true } })
    ).not.toEqual([]);
    expect(
      validateDeviceMessage({ type: "deviceEvent", id: 1, control: { grant: 1, cancel: true } })
    ).not.toEqual([]);
    expect(
      validateDeviceMessage({ type: "deviceRequest", id: 0, capability: "x", version: 1,
        owner: { connection: true }, lifetime: "connection", timeoutMs: 1,
        initialCredit: 0, params: {} })
    ).not.toEqual([]); // id 0 reserved
    expect(
      validateCapabilityPayload("gallery.pick", 1, "params", {
        mediaTypes: ["photo"], maxCount: 1, extra: true,
      })
    ).not.toEqual([]); // closed schemas
  });
});

/**
 * Whether a message violates its selected revision: request params and
 * registry bounds (revision exists, lifetime allowed, initial credit and
 * deadline within the revision, zero credit on a download), or a result /
 * event that fails the revision's payload validation.
 */
function payloadViolation(raw: unknown, requests: Map<number, DeviceRequest>): boolean {
  const msg = raw as DeviceMessage;
  if (msg.type === "deviceRequest") {
    const rev = findRevision(msg.capability, msg.version);
    if (!rev) return true;
    if (validateCapabilityPayload(msg.capability, msg.version, "params", msg.params).length > 0) return true;
    if (!rev.lifetimes.includes(msg.lifetime)) return true;
    if (msg.initialCredit > rev.maxInitialCredit) return true;
    if (rev.data === "binaryDownload" && msg.initialCredit !== 0) return true;
    if (msg.timeoutMs > rev.maxTimeoutMs) return true;
    return false;
  }
  const req = requests.get(msg.id);
  if (!req) return false;
  if (msg.type === "deviceResponse" && msg.result !== undefined) {
    return validateCapabilityPayload(req.capability, req.version, "result", msg.result).length > 0;
  }
  if (msg.type === "deviceEvent" && msg.event !== undefined) {
    return validateCapabilityPayload(req.capability, req.version, "event", msg.event).length > 0;
  }
  return false;
}

describe("golden frames", () => {
  const doc = loadJson(join(FIXTURES, "frames.json"));

  test("valid frames round-trip byte-for-byte", () => {
    for (const frame of doc.frames) {
      const bytes = hexToBytes(frame.hex);
      const decoded = decodeFrame(bytes);
      if (!decoded.ok) throw new Error(`golden frame rejected: ${frame.hex}`);
      expect(decoded.header).toEqual(frame.header);
      expect(bytesToHex(encodeFrame(decoded.header, decoded.payload))).toBe(frame.hex);
      if (frame.payloadHex) expect(bytesToHex(decoded.payload)).toBe(frame.payloadHex);
      expect(decoded.payload.byteLength).toBe(bytes.byteLength - FRAME_HEADER_LEN);
    }
  });

  test("encode rejects seq outside u32 range", () => {
    const h = { version: 1, flags: 0, channel: 0, requestId: 1 };
    const empty = new Uint8Array(0);
    expect(encodeFrame({ ...h, seq: 0xffff_ffff }, empty).byteLength).toBe(FRAME_HEADER_LEN);
    for (const seq of [-1, 0x1_0000_0000, 1.5, Number.NaN]) {
      expect(() => encodeFrame({ ...h, seq }, empty)).toThrow(RangeError);
    }
  });

  test("invalid frames classify exactly as fixtures require", () => {
    for (const invalid of doc.invalid) {
      const decoded = decodeFrame(hexToBytes(invalid.hex));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      if (invalid.reason === "shortHeader") {
        expect(decoded.error.kind).toBe("shortHeader");
      } else {
        expect(decoded.error.kind).toBe("violation");
      }
    }
  });
});

describe("legacy wire unchanged without the device extension", () => {
  test("hello/sessionAck serialize identically when device is absent", () => {
    const hello: HelloMessage = { type: "hello", sessionId: "s1", props: { a: 1 } };
    expect(JSON.parse(JSON.stringify(hello))).toEqual({
      type: "hello",
      sessionId: "s1",
      props: { a: 1 },
    });
    const ack: SessionAckMessage = {
      type: "sessionAck",
      sessionId: "s1",
      isNew: true,
      isRestored: false,
    };
    const wire = JSON.stringify(ack);
    expect(wire.includes("device")).toBe(false);
    expect(JSON.parse(wire)).toEqual({
      type: "sessionAck",
      sessionId: "s1",
      isNew: true,
      isRestored: false,
    });
  });
});
