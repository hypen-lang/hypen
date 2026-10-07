/**
 * Shared cross-SDK conformance corpora, consumed by the TS server side
 * (RFC 001 §2.1–§2.4, §3):
 *
 *   conformance/messages.json   strict envelope decode (incl. raw text with
 *                               duplicate keys / number spellings); handshake
 *                               cases: `sessionAck.device` through the TS
 *                               client decoder, `hello.device` and
 *                               `core.capabilities` snapshots through the
 *                               Rust handshake / a live Rust broker
 *   conformance/payloads.json   per-revision params/result/event validation,
 *                               judged by a live Rust broker through the
 *                               port: params at open, results as the
 *                               client's terminal (with the announced bytes
 *                               really uploaded), events on a live request
 *   conformance/selection.json  handshake selection — through the Rust
 *                               selection (`deviceSelectAck`, explicit
 *                               server lists) and the server's broker port
 *                               (`DeviceBrokerFactory.negotiate`); TS has
 *                               no selection code of its own
 *   schema/device/registry-v1.json  DEVICE_REGISTRY must equal it exactly
 *   transcripts/*.json          every wire transcript replayed with the
 *                               real (Rust) broker as the server, through
 *                               the port and a DevicePlane: client
 *                               violations, reactions, ignored steps
 *
 * These fixtures are produced by the Rust reference; a missing file is a
 * failure, never a skip.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEVICE_REGISTRY,
  decodeDeviceMessage,
  decodeFrame,
  findRevision,
  decodeDeviceAck,
  encodeFrame,
  sha256Hex,
  type DeviceAck,
  type DeviceBrokerOutcome,
  type DeviceMessage,
  type DeviceRequest,
  type DeviceResponse,
  type DeviceOpenResult,
  type DeviceSettlement,
} from "@hypen-space/core/remote/device";
import { fullAck, makePlane } from "./device-srv-harness";
import { createWasmDeviceBrokerFactory } from "../packages/server/src/device-broker";
import { deviceSelectAck, deviceValidateHello } from "../packages/server/wasm-node/hypen_engine.js";

/** The Rust handshake exactly as a RemoteSession reaches it: the broker port. */
const port = createWasmDeviceBrokerFactory({ poolBytes: null });

const ROOT = resolve(import.meta.dir, "../../engine-compatibility-tests");
const CONFORMANCE = join(ROOT, "fixtures/device/conformance");
const TRANSCRIPTS = join(ROOT, "fixtures/device/transcripts");
const load = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

/** Materialize a corpus case's text form: `raw`, `rawRepeat` or (bytes) `rawHex`. */
function caseInput(c: any): string | Uint8Array {
  if (typeof c.raw === "string") return c.raw;
  if (c.rawRepeat) {
    const r = c.rawRepeat;
    return r.prefix + r.repeat.repeat(r.count) + r.suffix;
  }
  if (typeof c.rawHex === "string") return hexToBytes(c.rawHex);
  return JSON.stringify(c.message ?? c.value);
}

describe("conformance/messages.json — strict envelope decode", () => {
  const doc = load(join(CONFORMANCE, "messages.json"));
  test("corpus is non-trivial", () => {
    expect(doc.valid.length).toBeGreaterThan(10);
    expect(doc.invalid.length).toBeGreaterThan(10);
    expect(doc.handshake.length).toBeGreaterThan(10);
  });
  for (const c of doc.valid) {
    test(`valid: ${c.name}`, () => {
      const input = caseInput(c);
      const decoded = decodeDeviceMessage(input);
      if (!decoded.ok) throw new Error(`rejected: ${decoded.reason}`);
      // Round-trips to an equal JSON value.
      const expected = c.message ?? JSON.parse(typeof input === "string" ? input : new TextDecoder().decode(input));
      expect(JSON.parse(JSON.stringify(decoded.message))).toEqual(expected);
    });
  }
  for (const c of doc.invalid) {
    test(`invalid: ${c.name} (${c.reason})`, () => {
      const started = performance.now();
      expect(decodeDeviceMessage(caseInput(c)).ok).toBe(false);
      // Every limit is enforced in (at most) one linear pass.
      expect(performance.now() - started).toBeLessThan(250);
    });
  }
  for (const c of doc.handshake) {
    test(`handshake ${c.kind} ${c.valid ? "valid" : "invalid"}: ${c.name}`, () => {
      const input = c.value !== undefined ? c.value : caseInput(c);
      /** The case as JSON text — what reaches a server on the wire. */
      const text = typeof input === "string" ? input : JSON.stringify(c.value);
      if (c.kind === "ack") {
        // The client's side: the TS strict decoder (DeviceClient/RemoteEngine).
        const started = performance.now();
        const decoded = decodeDeviceAck(input);
        expect(performance.now() - started).toBeLessThan(250);
        if (c.valid) {
          if (!decoded.ok) throw new Error(`rejected: ${decoded.reason}`);
          if (c.value !== undefined) expect(decoded.value).toEqual(c.value);
        } else {
          expect(decoded.ok).toBe(false);
        }
        if (c.value !== undefined) {
          // The text form decodes identically to the value form.
          expect(decodeDeviceAck(JSON.stringify(c.value)).ok).toBe(decoded.ok);
        }
        return;
      }
      if (c.kind === "hello") {
        // The server's side, judged by the Rust decoder on the text as sent
        // (decision D7: a hello failing validation disables device access),
        // through the broker port exactly as a RemoteSession reaches it.
        const started = performance.now();
        const outcome = port.negotiate(text, true, [{ name: "core.capabilities", versions: [1] }]);
        expect(performance.now() - started).toBeLessThan(250);
        expect(deviceValidateHello(text).ok).toBe(c.valid);
        if (c.valid) {
          expect(outcome.reason ?? "").not.toStartWith("invalid hello.device");
        } else {
          expect(outcome.ack).toBeNull();
          expect(outcome.reason).toStartWith("invalid hello.device");
        }
        return;
      }
      if (c.kind === "capabilitiesEvent") {
        // A snapshot on the live core.capabilities stream, judged by the Rust
        // broker: valid ⇒ applied (no reaction); invalid ⇒ the control stream
        // is violated (one cancel, the plane closes) or, outside the JSON
        // limits, a connection-level violation.
        const d = brokerDriver();
        try {
          const violations = d.b.info().connectionViolations;
          const started = performance.now();
          d.b.onText(`{"type":"deviceEvent","id":${d.core},"event":${text}}`, 0);
          d.drain();
          expect(performance.now() - started).toBeLessThan(250);
          const counted = d.b.info().connectionViolations > violations;
          if (c.valid) {
            // Accepted and applied to the live selection (a snapshot without
            // core.capabilities may end the plane — that is selection, not a
            // decode verdict): never a violation, never a cancel.
            expect(counted).toBe(false);
            expect(d.cancels(d.core)).toBe(0);
          } else {
            expect(counted || (d.cancels(d.core) === 1 && d.closes.length > 0)).toBe(true);
          }
        } finally {
          d.b.free();
        }
        return;
      }
      throw new Error(`unknown handshake kind ${c.kind}`);
    });
  }
});

// ---------------------------------------------------------------------------
// conformance/payloads.json through a live Rust broker (the server role)
// ---------------------------------------------------------------------------

/**
 * A started Rust broker (`core.capabilities` open, activation m1 @ 1 live)
 * reached through the port, with the test playing the client: it feeds text
 * and frames, drains `poll()` like the SDK's pump (consuming streamed chunks
 * and events at once) and records every output. It interprets nothing
 * itself — every protocol verdict comes from the broker.
 */
function brokerDriver() {
  const b = port({ ack: fullAck() }, 0);
  const sent: any[] = [];
  const frames: Uint8Array[] = [];
  const events: Array<[number, Record<string, unknown>]> = [];
  const settled = new Map<number, DeviceBrokerOutcome>();
  const closes: Array<{ code: number; reason: string }> = [];
  const drain = () => {
    for (let guard = 0; guard < 100_000; guard++) {
      const out = b.poll();
      if (out.length === 0) return;
      for (const o of out) {
        switch (o.type) {
          case "sendText":
            sent.push(JSON.parse(o.text));
            break;
          case "sendFrame":
            frames.push(o.frame);
            break;
          case "event":
            events.push([o.id, o.event]);
            b.consumedEvents(o.id, 1, 0);
            break;
          case "data":
            b.consumedData(o.id, 1, 0);
            break;
          case "settled":
            if (settled.has(o.id)) throw new Error(`request ${o.id} settled twice`);
            settled.set(o.id, o.outcome);
            break;
          case "closeConnection":
            closes.push({ code: o.code, reason: o.reason });
            break;
        }
      }
    }
    throw new Error("broker never drained");
  };
  const core = b.start(0);
  if (core.id === undefined) throw new Error(`core.capabilities refused: ${core.error.code}`);
  drain();
  if (!b.ownerActivated("m1", 1, 0)) throw new Error("activation refused");
  drain();
  const sentFor = (id: number, type: string) => sent.filter((m) => m.type === type && m.id === id);
  return {
    b,
    core: core.id,
    sent,
    frames,
    events,
    settled,
    closes,
    sentFor,
    drain,
    cancels: (id: number) => sentFor(id, "deviceEvent").filter((m) => m.control?.cancel === true).length,
    open(capability: string, params: unknown, version = 1, download: Uint8Array | null = null) {
      const r = b.open({ capability, version, params, moduleInstanceId: "m1", activationId: 1 }, 0, download);
      drain();
      return r;
    },
    text(message: object) {
      b.onText(JSON.stringify(message), 0);
      drain();
    },
    frame(frame: Uint8Array) {
      b.onFrame(frame, 0);
      drain();
    },
  };
}
type BrokerDriver = ReturnType<typeof brokerDriver>;

/** Valid params the broker opens (upload / stream plumbing for result and event cases). */
function paramsFor(capability: string, contentType?: string): unknown {
  switch (capability) {
    case "gallery.pick":
      return { mediaTypes: ["photo", "video"], maxCount: 16 };
    case "file.pick":
      return { accept: ["*/*"], maxCount: 16 };
    case "camera.capture":
      return { mode: contentType?.startsWith("video/") ? "video" : "photo" };
    case "mic.record":
      return { sampleRate: 16_000, format: "pcm16" };
    case "permission.query":
    case "permission.request":
      return { permission: "camera" };
    case "bluetooth.select":
    case "bluetooth.scan":
      return {};
  }
  throw new Error(`no params for ${capability}`);
}

/** Open a live request of `capability` (file.save with a matching download). */
async function openLive(d: BrokerDriver, capability: string, contentType?: string): Promise<number> {
  let r: DeviceOpenResult;
  if (capability === "file.save") {
    const download = new Uint8Array(11).fill(7);
    const params = { channel: 0, name: "f.bin", contentType: "application/octet-stream", bytes: 11, sha256: await sha256Hex(download) };
    r = d.open(capability, params, 1, download);
  } else {
    r = d.open(capability, paramsFor(capability, contentType));
  }
  if (r.id === undefined) throw new Error(`refused: ${r.error.code} ${r.error.detail ?? ""}`);
  return r.id;
}

const itemsOf = (value: any): any[] =>
  Array.isArray(value?.items) ? value.items : value?.item && typeof value.item === "object" ? [value.item] : [];

/** Stream one announced item of `size` bytes within the broker's credit; the actual SHA-256. */
async function upload(d: BrokerDriver, id: number, item: any, size: number): Promise<string> {
  const channel = item.channel as number;
  d.text({ type: "deviceEvent", id, event: { kind: "blobStart", channel, contentType: item.contentType } });
  const hash = createHash("sha256");
  let sent = 0;
  let seq = 0;
  while (sent < size) {
    const credit = d.b.outstandingCredit(id);
    if (credit === undefined) throw new Error(`request ${id} ended while uploading: ${JSON.stringify(d.settled.get(id))}`);
    expect(credit, `the broker starved the upload at ${sent}/${size} bytes`).toBeGreaterThan(0);
    const n = Math.min(65_536, size - sent, credit);
    const chunk = new Uint8Array(n);
    for (let k = 0; k < n; k++) chunk[k] = ((sent + k) * 31) % 251;
    hash.update(chunk);
    d.frame(encodeFrame({ version: 1, flags: 0, channel, requestId: id, seq: seq++ }, chunk));
    sent += n;
  }
  return hash.digest("hex");
}

describe("conformance/payloads.json — per-revision payload validation (through the Rust broker)", () => {
  const doc = load(join(CONFORMANCE, "payloads.json"));
  test("corpus is non-trivial, names unique", () => {
    const names = doc.cases.map((c: any) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(doc.cases.length).toBeGreaterThanOrEqual(270);
  });
  for (const c of doc.cases) {
    test(`${c.kind} ${c.valid ? "valid" : "invalid"}: ${c.name}`, async () => {
      const d = brokerDriver();
      try {
        if (c.kind === "params") await checkParams(d, c.capability, c.version, c.value, c.valid);
        else if (c.kind === "result") await checkResult(d, c.capability, c.value, c.valid);
        else if (c.kind === "event") await checkEvent(d, c.capability, c.value, c.valid);
        else throw new Error(`kind ${c.kind}`);
      } finally {
        d.b.free();
      }
    });
  }
});

/** Params at `open`: invalid ⇒ refused locally, nothing sent. */
async function checkParams(d: BrokerDriver, capability: string, version: number, value: unknown, valid: boolean) {
  if (capability === "core.capabilities") {
    // Only the broker opens the control stream; the params it sends are the valid ones.
    const emitted = d.sentFor(d.core, "deviceRequest")[0]?.params;
    expect(Bun.deepEquals(emitted, value), "core.capabilities params: the broker emits exactly the valid value").toBe(valid);
    expect(d.open(capability, value, version).error, "application code never opens core.capabilities").toBeDefined();
    return;
  }
  const sentBefore = d.sent.length;
  const r = d.open(capability, value, version, capability === "file.save" ? new Uint8Array(1) : null);
  if (valid) {
    if (r.id !== undefined) {
      expect(d.sentFor(r.id, "deviceRequest").length).toBe(1);
    } else {
      // file.save params must also describe the actual download bytes.
      expect(capability, `valid params refused: ${r.error.code} ${r.error.detail}`).toBe("file.save");
      expect(r.error.detail ?? "", "not a schema refusal").not.toStartWith("params ");
    }
    return;
  }
  expect(r.id, `invalid params were sent: ${JSON.stringify(value)}`).toBeUndefined();
  const registryRevision = d.b.revision(capability, version) !== null;
  expect(r.error!.code, r.error!.detail).toBe(registryRevision ? "invalidParams" : "unsupported");
  expect(d.sent.length, "a refusal sends nothing").toBe(sentBefore);
}

/** Results as the client's terminal: valid ⇒ the handler's success; invalid ⇒ invalidParams, never delivered. */
async function checkResult(d: BrokerDriver, capability: string, value: any, valid: boolean) {
  if (capability === "core.capabilities") {
    // Any terminal on the live control stream — valid or not — ends the
    // device plane (connection-owned: nothing settles to a handler, and no
    // cancel follows the client's own terminal). The corpus verdict itself
    // is the Rust decoder's.
    d.text({ type: "deviceResponse", id: d.core, result: value });
    expect(d.closes.at(-1)?.reason ?? "").toEndWith("core.capabilities ended");
    expect(d.cancels(d.core)).toBe(0);
    expect(d.settled.has(d.core)).toBe(false);
    return;
  }
  const items = itemsOf(value);
  const contentType = typeof items[0]?.contentType === "string" ? items[0].contentType : undefined;
  const id = await openLive(d, capability, contentType);
  let result = value;
  if (capability === "file.save") {
    // The client grants after consent; the broker sends the whole download.
    d.text({ type: "deviceEvent", id, control: { grant: 1_048_576 } });
    expect(d.frames.length, "the broker sent the download within the grant").toBeGreaterThan(0);
  }
  if (valid && items.length > 0) {
    // Stream the announced bytes; the corpus hash stands for bytes it does
    // not carry, so the harness reports the actual one.
    const hashes: string[] = [];
    for (const item of items) hashes.push(await upload(d, id, item, item.bytes));
    result = structuredClone(value);
    const patched = itemsOf(result);
    patched.forEach((item, k) => (item.sha256 = hashes[k]));
  }
  d.text({ type: "deviceResponse", id, result });
  const outcome = d.settled.get(id);
  expect(outcome, "the terminal settled the request").toBeDefined();
  if (valid) {
    if (!outcome!.ok) throw new Error(`valid result refused: ${outcome!.code} ${outcome!.detail ?? ""}`);
    expect(outcome!.result, "the handler sees the validated result").toEqual(result);
  } else {
    expect(outcome!.ok ? "ok" : outcome!.code, "invalid result reached the handler").toBe("invalidParams");
    expect(d.cancels(id), "no cancel after the client's own terminal").toBe(0);
  }
}

/** Events on a live request of that revision: invalid ⇒ the request terminates invalidParams. */
async function checkEvent(d: BrokerDriver, capability: string, value: any, valid: boolean) {
  if (capability === "core.capabilities") {
    d.text({ type: "deviceEvent", id: d.core, event: value });
    expect(d.cancels(d.core)).toBe(valid ? 0 : 1);
    if (!valid) expect(d.closes.length).toBeGreaterThan(0);
    return;
  }
  const contentType = typeof value?.contentType === "string" ? value.contentType : undefined;
  const id = await openLive(d, capability, contentType);
  d.text({ type: "deviceEvent", id, event: value });
  const delivered = d.events.filter(([e]) => e === id);
  if (valid) {
    expect(d.b.isLive(id), `a valid event never ends the request: ${JSON.stringify(d.settled.get(id))}`).toBe(true);
    expect(d.cancels(id)).toBe(0);
    // Capability events reach the handler; blobStart / progress are the broker's.
    if (value?.kind === undefined) expect(delivered.map(([, e]) => e)).toEqual([value]);
    else expect(delivered, `${value.kind} is not delivered to the handler`).toEqual([]);
  } else {
    const outcome = d.settled.get(id);
    expect(outcome && !outcome.ok ? outcome.code : null, "invalid event").toBe("invalidParams");
    expect(d.cancels(id), "the server's reaction is one cancel").toBe(1);
    expect(delivered, "an invalid event is never delivered").toEqual([]);
  }
}

describe("conformance/selection.json — handshake selection (Rust, through WASM)", () => {
  const doc = load(join(CONFORMANCE, "selection.json"));
  test("corpus is non-trivial", () => {
    expect(doc.cases.length).toBeGreaterThan(20);
  });
  for (const c of doc.cases) {
    test(c.name, () => {
      const hello = JSON.stringify(c.hello);
      const ack = deviceSelectAck(hello, c.serverProtocolVersions ?? [1], c.serverCapabilities, c.serverBinary);
      if (c.expect === null) expect(ack).toBeNull();
      else expect(ack).toEqual(c.expect);
      // The server's own path (protocol v1): the broker port's negotiate.
      if (c.serverProtocolVersions === undefined) {
        const outcome = port.negotiate(hello, c.serverBinary, c.serverCapabilities);
        expect(outcome.ack).toEqual(c.expect);
        if (c.expect === null) expect(typeof outcome.reason).toBe("string");
      }
    });
  }
});

describe("schema/device/registry-v1.json — registry parity", () => {
  test("DEVICE_REGISTRY equals the exported registry exactly (order, fields, values)", () => {
    const doc = load(join(ROOT, "schema/device/registry-v1.json"));
    expect(doc.protocolVersion).toBe(1);
    const ts = {
      protocolVersion: 1,
      capabilities: [...DEVICE_REGISTRY].map(([name, revisions]) => ({
        name,
        revisions: revisions.map((r) => ({ ...r, lifetimes: [...r.lifetimes] })),
      })),
    };
    expect(ts).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// Every wire transcript replayed through the real DeviceBroker (the server)
// ---------------------------------------------------------------------------

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A transcript frame's bytes: `hex` then `payloadFill.length` × `payloadFill.byte`. */
function frameBytes(frame: any): Uint8Array {
  const head = hexToBytes(frame.hex);
  const fill = frame.payloadFill as { byte: number; length: number } | undefined;
  if (!fill) return head;
  const out = new Uint8Array(head.byteLength + fill.length);
  out.set(head);
  out.fill(fill.byte, head.byteLength);
  return out;
}

/** Download payloads by SHA-256, from every transcript whose server sends
 *  the complete, matching bytes of a `file.save` announcement. */
function downloadTable(docs: any[]): Map<string, Uint8Array> {
  const table = new Map<string, Uint8Array>();
  for (const doc of docs) {
    const steps: any[] = doc.steps;
    steps.forEach((step, i) => {
      const m = step.message;
      if (step.dir !== "s2c" || m?.type !== "deviceRequest" || m.capability !== "file.save") return;
      const payload = downloadFrames(steps, i, m.id);
      const sha = createHash("sha256").update(payload).digest("hex");
      if (payload.byteLength === m.params.bytes && sha === m.params.sha256) table.set(sha, payload);
    });
  }
  return table;
}

/** The payload of every unflagged s2c frame for transcript id `id` after step `from`. */
function downloadFrames(steps: any[], from: number, id: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const later of steps.slice(from + 1)) {
    if (later.dir === "s2c" && later.frame?.header.requestId === id && later.expectViolation === undefined && !later.ignored) {
      parts.push(frameBytes(later.frame).subarray(12));
    }
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** A frame with its header's request id replaced (transcript id → broker id). */
function withRequestId(frame: Uint8Array, id: number): Uint8Array {
  const out = frame.slice();
  if (out.byteLength >= 8) new DataView(out.buffer, out.byteOffset).setUint32(4, id, true);
  return out;
}

interface Live {
  req: DeviceRequest;
  settlement: DeviceSettlement | null;
  /** Download payload the broker actually wrote (its own frames). */
  written: Uint8Array[];
  /**
   * Streamed-upload replay (`onData`, round 3 C3): the chunks the broker
   * handed to the consumer, in order. Null when no consumer took them.
   */
  delivered: Uint8Array[] | null;
}

/** One upload item as the terminal result declares it. */
interface DeclaredItem {
  channel: number;
  contentType: string;
  bytes: number;
  sha256: string;
  name?: string;
}

/**
 * Independent test oracle for a buffered upload: the received channels must
 * be exactly the declared item set, each with the declared byte count and
 * SHA-256. (The production check is the Rust broker's; this re-derives it.)
 */
async function verifyItems(
  declared: DeclaredItem[],
  received: Map<number, Uint8Array>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (declared.length !== received.size) {
    return { ok: false, reason: `declared ${declared.length} items, received ${received.size}` };
  }
  for (const item of declared) {
    const bytes = received.get(item.channel);
    if (!bytes) return { ok: false, reason: `missing channel ${item.channel}` };
    if (bytes.byteLength !== item.bytes) {
      return { ok: false, reason: `channel ${item.channel}: declared ${item.bytes} bytes, got ${bytes.byteLength}` };
    }
    if ((await sha256Hex(bytes)) !== item.sha256) {
      return { ok: false, reason: `channel ${item.channel}: sha256 mismatch` };
    }
  }
  return { ok: true };
}

/**
 * Server-side outcome after local verification — what a handler would see.
 * The broker verified every upload before settling ok; it is re-checked
 * here independently: buffered uploads through `verifyItems` (count, sizes,
 * SHA-256 of the received bytes), streamed ones against the bytes the
 * consumer received. A download's success receipt is judged by the broker
 * against the bytes it really wrote; the hash of those bytes against the
 * declared `sha256` is re-checked here.
 */
async function serverOutcome(live: Live): Promise<"ok" | "error"> {
  const settlement = live.settlement;
  if (!settlement || !("result" in settlement)) return "error";
  const rev = findRevision(live.req.capability, live.req.version);
  if (rev?.data === "binaryDownload") {
    const params = live.req.params as { sha256: string; bytes: number };
    const joined = concat(live.written);
    return joined.byteLength === params.bytes && (await sha256Hex(joined)) === params.sha256 ? "ok" : "error";
  }
  if (rev?.data !== "binaryUpload") return "ok";
  const r = settlement.result as { items?: DeclaredItem[]; item?: DeclaredItem };
  const declared = Array.isArray(r.items) ? r.items : r.item ? [r.item] : [];
  if (rev.mode === "stream") {
    // Streamed: nothing was buffered (no blobs); exactly one declared item.
    if (settlement.blobs.length !== 0 || declared.length !== 1) return "error";
    if (!live.delivered) return "ok"; // no consumer: the broker's own hash check stands
    const joined = concat(live.delivered);
    return joined.byteLength === declared[0]!.bytes && (await sha256Hex(joined)) === declared[0]!.sha256 ? "ok" : "error";
  }
  const verified = await verifyItems(declared, new Map(settlement.blobs.map((b) => [b.channel, b.bytes])));
  return verified.ok ? "ok" : "error";
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("wire transcripts replayed through the Rust broker (TS server)", () => {
  const files = readdirSync(TRANSCRIPTS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .filter((f) => load(join(TRANSCRIPTS, f)).steps !== undefined);
  const table = downloadTable(files.map((f) => load(join(TRANSCRIPTS, f))));

  test("the corpus has client → server violations to replay", () => {
    const withC2sViolations = files.filter((f) =>
      load(join(TRANSCRIPTS, f)).steps.some((s: any) => s.expectViolation !== undefined && s.dir === "c2s")
    );
    expect(withC2sViolations.length).toBeGreaterThan(40);
  });

  /**
   * Transcripts with a binary-upload STREAM request (mic.record) are
   * replayed a second time with the server consuming it through `onData`
   * (round 3 C3): the same verdicts must hold, and the consumer must receive
   * exactly the verified bytes.
   */
  const streamedFiles = files.filter((f) =>
    load(join(TRANSCRIPTS, f)).steps.some((st: any) => {
      const m = st.message;
      if (st.dir !== "s2c" || m?.type !== "deviceRequest") return false;
      const rev = findRevision(m.capability, m.version);
      return rev?.mode === "stream" && rev.data === "binaryUpload";
    })
  );

  test("the corpus has binary-upload stream transcripts to replay through onData", () => {
    expect(streamedFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const [file, streamed] of [
    ...files.map((f) => [f, false] as const),
    ...streamedFiles.map((f) => [f, true] as const),
  ]) {
    test(streamed ? `${file} (streamed via onData)` : file, async () => {
      const doc = load(join(TRANSCRIPTS, file));
      const steps: any[] = doc.steps;
      const ack: DeviceAck = doc.ack ?? fullAck();
      const coreStep = steps.find(
        (st) => st.dir === "s2c" && st.message?.type === "deviceRequest" && st.message.capability === "core.capabilities"
      );
      /** Transcript ids whose client acknowledges renewals itself. */
      const selfAcking = new Set<number>(
        steps.filter((st) => st.dir === "c2s" && st.message?.control?.leaseAck !== undefined).map((st) => st.message.id)
      );
      /** transcript id ↔ broker id */
      const map = new Map<number, number>();
      const back = new Map<number, number>();
      const bid = (t: number) => map.get(t) ?? 0x4000_0000 + t;
      const link = (t: number, b: number) => {
        map.set(t, b);
        back.set(b, t);
      };
      const live = new Map<number, Live>();
      const refused = new Set<number>();

      let plane!: ReturnType<typeof makePlane>["plane"];
      const h = makePlane({
        start: false,
        owners: [],
        ack,
        config: {
          ...(doc.serverCapabilities
            ? { serverCapabilities: doc.serverCapabilities }
            : { serverCapabilities: ack.capabilities.map((c) => ({ name: c.name, versions: [c.version] })) }),
          ...(coreStep
            ? {
                controlStreamInitialCredit: coreStep.message.initialCredit,
                controlStreamTimeoutMs: coreStep.message.timeoutMs,
              }
            : {}),
        },
        onSend: (m) => {
          // A live client for requests the transcript does not acknowledge
          // itself, so clock advances never expire them.
          if (m.control?.renewLease !== undefined) {
            const t = back.get(m.id);
            if ((t === undefined || !selfAcking.has(t)) && plane?.isLive(m.id)) {
              plane.receiveText(JSON.stringify({ type: "deviceEvent", id: m.id, control: { leaseAck: m.control.renewLease } }));
            }
          }
        },
        onFrameOut: (f) => {
          const d = decodeFrame(f);
          if (d.ok) live.get(d.header.requestId)?.written.push(d.payload.slice());
        },
      });
      plane = h.plane;
      const sent = h.sent;
      const clock = h.clock;
      const brokerLease = (id: number) =>
        Math.max(0, ...sent.filter((m: any) => m.id === id && m.control?.renewLease).map((m: any) => m.control.renewLease));
      const cancelsSent = (id: number) => sent.filter((m: any) => m.id === id && m.control?.cancel === true).length;
      /** Highest renewLease the transcript's server sent, per transcript id. */
      const transcriptLease = new Map<number, number>();
      let pendingReaction: { t: number; cancelsBefore: number } | null = null;
      let connectionClosed = false;
      let c2sViolations = 0;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const where = `${file} step ${i}`;
        if (connectionClosed) throw new Error(`${where}: a connection violation must be the last step`);

        if (step.dir === "s2c") {
          if (step.reaction) {
            // The server's reaction to the preceding c2s violation: exactly
            // one cancel for that id, emitted by the broker itself.
            expect(pendingReaction, where).not.toBeNull();
            expect(step.message.control?.cancel, where).toBe(true);
            expect(step.message.id, where).toBe(pendingReaction!.t);
            expect(cancelsSent(bid(pendingReaction!.t)) - pendingReaction!.cancelsBefore, where).toBe(1);
            pendingReaction = null;
            // A violated control stream takes the device plane down.
            if (plane.isClosed) connectionClosed = true;
            continue;
          }
          // Client-detected violations and stale/ignored server messages are
          // what a hostile or racing peer sends; the broker never does.
          if (step.expectViolation !== undefined || step.ignored) continue;
          // Download frames: the broker writes its own, within the grants.
          if (step.frame) continue;
          const msg = (step.message ?? JSON.parse(step.raw)) as DeviceMessage;
          if (msg.type === "deviceRequest") {
            const before = sent.length;
            if (msg.capability === "core.capabilities") {
              // The connection-owned control stream: opened by start(), or
              // the fresh stream of a planned reopen (linked at the cancel).
              if (plane.coreStreamId === undefined) expect(plane.start(), where).toBe(true);
              link(msg.id, plane.coreStreamId!);
              const got = sent.filter((m: any) => m.type === "deviceRequest" && m.id === plane.coreStreamId).at(-1);
              // Host configuration: the first stream's credit is the
              // transcript's; a planned reopen reuses it.
              expect({ ...got, initialCredit: msg.initialCredit }, where).toEqual({ ...msg, id: plane.coreStreamId });
              live.set(plane.coreStreamId!, { req: msg, settlement: null, written: [], delivered: null });
              continue;
            }
            const owner = msg.owner as { moduleInstanceId: string; activationId: number };
            if (!plane.ownerIsActive(owner.moduleInstanceId, owner.activationId)) {
              expect(plane.ownerActivated(owner.moduleInstanceId, owner.activationId), where).toBe(true);
            }
            const rev = findRevision(msg.capability, msg.version);
            const params = msg.params as Record<string, unknown>;
            let download: Uint8Array | undefined;
            let faulty = false;
            if (rev?.data === "binaryDownload") {
              // The server's snapshot: the bytes its frames carry in this
              // transcript (or, when none flowed, the same announcement's
              // bytes from another transcript), padded to the declared size.
              let bytes = downloadFrames(steps, i, msg.id);
              if (bytes.byteLength === 0) bytes = table.get(String(params.sha256)) ?? bytes;
              download = new Uint8Array(Number(params.bytes));
              download.set(bytes.subarray(0, download.byteLength));
              faulty = (await sha256Hex(download)) !== params.sha256;
            }
            const delivered: Uint8Array[] | null =
              streamed && rev?.mode === "stream" && rev.data === "binaryUpload" ? [] : null;
            const r = plane.open({
              capability: msg.capability,
              version: msg.version,
              params,
              moduleInstanceId: owner.moduleInstanceId,
              activationId: owner.activationId,
              lifetime: msg.lifetime,
              timeoutMs: msg.timeoutMs,
              initialCredit: msg.initialCredit,
              // Transcript servers may open an upload at zero credit.
              allowZeroCredit: true,
              ...(download ? { download } : {}),
              ...(delivered ? { onData: (chunk: Uint8Array) => void delivered.push(chunk.slice()) } : {}),
              // A consumer that has not caught up: no replenishing grants
              // beyond what the transcript itself shows.
              ...(rev?.data === "jsonEvents" ? { onEvent: () => new Promise(() => {}) } : {}),
            });
            if (r.id === null) {
              // The transcript's server announces bytes it does not send:
              // the broker never announces such a download, and the
              // client's success is the flagged violation.
              expect(faulty, `${where}: open refused: ${JSON.stringify(await r.settled)}`).toBe(true);
              expect(await r.settled, where).toMatchObject({ error: { code: "invalidParams" } });
              expect(sent.length, where).toBe(before);
              refused.add(msg.id);
              continue;
            }
            expect(faulty, `${where}: broker announced bytes it does not send`).toBe(false);
            link(msg.id, r.id);
            const got = sent.filter((m: any) => m.type === "deviceRequest").at(-1);
            expect(got, where).toEqual({ ...msg, id: r.id });
            const entry: Live = { req: msg, settlement: null, written: [], delivered };
            void r.settled.then((st) => {
              entry.settlement = st;
            });
            live.set(r.id, entry);
            continue;
          }
          if (refused.has(msg.id)) continue;
          const b = bid(msg.id);
          if (msg.type === "deviceEvent" && msg.control && "renewLease" in msg.control) {
            const want = (msg.control as { renewLease: number }).renewLease;
            transcriptLease.set(msg.id, Math.max(transcriptLease.get(msg.id) ?? 0, want));
            // Bring the broker's own 5 s renewal cadence up to the transcript's.
            for (let k = 0; k < 10 && brokerLease(b) < want && plane.isLive(b); k++) {
              clock.advance(5_000);
            }
            expect(brokerLease(b), `${where}: the broker never renewed to ${want}`).toBeGreaterThanOrEqual(want);
            continue;
          }
          if (msg.type === "deviceEvent" && msg.control && "cancel" in msg.control) {
            if (b === plane.coreStreamId) {
              // Planned reopen: the old control stream is retired first.
              const next = plane.reopenCoreCapabilities();
              expect(next, where).toBeDefined();
              expect(cancelsSent(b), where).toBe(1);
              continue;
            }
            // Server-initiated cancellation (owner swept, abandon, deadline).
            if (plane.isLive(b)) plane.cancel(b);
            expect(cancelsSent(b), where).toBe(1);
            continue;
          }
          continue; // grants and other server output are the broker's own
        }

        // ---- c2s: feed the client's step to the server broker ----
        expect(pendingReaction, `${where}: missing server reaction step`).toBeNull();
        let input: string | Uint8Array;
        let t: number | null = null;
        let isResponse = false;
        if (step.frame) {
          t = step.frame.header.requestId;
          input = withRequestId(frameBytes(step.frame), bid(t!));
        } else if (typeof step.raw === "string") {
          let lenient: any = null;
          try {
            lenient = JSON.parse(step.raw);
          } catch {
            /* not JSON at all */
          }
          const tid = typeof lenient?.id === "number" ? lenient.id : null;
          input = tid !== null && map.has(tid) ? step.raw.replace(`"id":${tid}`, `"id":${bid(tid)}`) : step.raw;
        } else {
          const msg = structuredClone(step.message) as any;
          t = msg.id;
          isResponse = msg.type === "deviceResponse";
          msg.id = bid(msg.id);
          if (msg.type === "deviceEvent" && msg.control && "leaseAck" in msg.control) {
            // The broker sends renewLease 1 WITH each request (§2.7), so a
            // transcript whose server had not renewed yet sits below it:
            // translate the ack by what each side actually sent on this id.
            const offset = brokerLease(msg.id) - (transcriptLease.get(t!) ?? 0);
            msg.control.leaseAck += Math.max(0, offset);
          }
          input = JSON.stringify(msg);
        }
        if (t !== null && refused.has(t)) {
          if (step.expectViolation !== undefined) c2sViolations += 1; // prevented at the source
          continue;
        }
        const id = t !== null ? bid(t) : null;
        const wasLive = id !== null && plane.isLive(id);
        const wasCore = id !== null && id === plane.coreStreamId;
        const violationsBefore = plane.connectionViolations;
        const cancelsBefore = id !== null ? cancelsSent(id) : 0;
        const sentBefore = sent.length;
        const closesBefore = h.closes.length;
        if (input instanceof Uint8Array) plane.receiveFrame(input);
        else plane.receiveText(input);
        await flush();

        if (step.ignored) {
          // Stale id: dropped with no effect, whatever the message is.
          expect(id === null || !wasLive, `${where}: an ignored step targets a live id`).toBe(true);
          expect(sent.length, where).toBe(sentBefore);
          expect(plane.connectionViolations, where).toBe(violationsBefore);
          continue;
        }

        const category: string | undefined = step.expectViolation;
        if (category === undefined) {
          expect(plane.connectionViolations, `${where}: unexpected connection-level violation`).toBe(violationsBefore);
          expect(h.closes.length, `${where}: unexpected close`).toBe(closesBefore);
          if (id !== null && wasLive && !plane.isLive(id)) {
            // A legitimate terminal: success verifies, an error is the client's.
            const entry = live.get(id)!;
            const msg = step.message as DeviceResponse;
            expect(msg?.type, `${where}: request ended by a non-terminal step`).toBe("deviceResponse");
            if (msg.error) {
              expect(entry.settlement && "error" in entry.settlement ? entry.settlement.error.code : null, where).toBe(msg.error.code);
            } else {
              expect(await serverOutcome(entry), where).toBe("ok");
            }
            expect(cancelsSent(id) - cancelsBefore, `${where}: cancel after a clean terminal`).toBe(0);
          } else if (id !== null && wasLive) {
            expect(plane.isLive(id), where).toBe(true);
          }
          continue;
        }

        c2sViolations += 1;
        const next = steps[i + 1];
        if (category === "connection") {
          // A terminal on the live core.capabilities stream: the broker
          // closes the device plane (RemoteSession then resets the socket
          // with 1012 — device-srv-control-stream.test.ts end to end).
          expect(wasCore && !plane.isLive(id!), where).toBe(true);
          expect(h.closes.map((c) => c.code), where).toEqual([1012]);
          expect(plane.isClosed, where).toBe(true);
          connectionClosed = true;
          continue;
        }
        const requestLevel = wasLive && !plane.isLive(id!);
        if (!requestLevel) {
          // Connection-level (JSON limits, bad frame header): discarded and
          // counted, the request its id seems to name stays live.
          expect(category, where).toBe("malformed");
          expect(plane.connectionViolations, where).toBe(violationsBefore + 1);
          if (id !== null && wasLive) expect(plane.isLive(id), where).toBe(true);
          expect(next?.reaction, `${where}: no reaction to a connection-level violation`).not.toBe(true);
          continue;
        }
        // Request-level: settled locally with an error (invalidParams, or
        // the verification failure a handler would see).
        if (!wasCore) {
          const entry = live.get(id!)!;
          expect(await serverOutcome(entry), where).toBe("error");
          if (entry.settlement && "error" in entry.settlement) {
            expect(entry.settlement.error.code, where).toBe("invalidParams");
          }
        }
        if (isResponse) {
          // The client's own terminal: settle locally, send nothing.
          expect(cancelsSent(id!) - cancelsBefore, where).toBe(0);
          expect(next?.reaction, where).not.toBe(true);
          if (wasCore) connectionClosed = plane.isClosed;
        } else {
          expect(next?.reaction, `${where}: a request-level violation is followed by its reaction`).toBe(true);
          pendingReaction = { t: t!, cancelsBefore };
        }
      }
      expect(pendingReaction, `${file}: reaction step missing at the end`).toBeNull();
      // The broker closed the plane only where the transcript ends it.
      if (!connectionClosed) expect(h.closes, file).toEqual([]);
      // Sanity: every c2s violation flagged in the file was exercised.
      expect(c2sViolations).toBe(steps.filter((s) => s.dir === "c2s" && s.expectViolation !== undefined).length);
      plane.close();
    });
  }
});

/**
 * The shared envelope corpus through the TS server's REAL inbound decoder:
 * the Rust broker behind the WASM port (the model is Kotlin's
 * DeviceBrokerConformanceTest.messages). Ids 1 (the control stream) and 17
 * (an ordinary request) are live, as the corpus assumes. A valid message is
 * never a connection-level violation; an invalid one is either a counted
 * connection-level violation or terminates the live request it names —
 * never both, never silently accepted.
 */
describe("conformance/messages.json — through the Rust broker (TS server inbound path)", () => {
  const doc = load(join(CONFORMANCE, "messages.json"));
  const tally = { text: 0, connection: 0, request: 0 };
  const failureCode = (d: BrokerDriver, id: number): string | undefined => {
    const o = d.settled.get(id) as any;
    return o && o.ok === false ? o.code : undefined;
  };
  const cases = [
    ...doc.valid.map((c: any) => [true, c] as const),
    ...doc.invalid.map((c: any) => [false, c] as const),
  ];
  for (const [valid, c] of cases) {
    test(`${valid ? "valid" : "invalid"} (broker): ${c.name}`, async () => {
      const input = caseInput(c);
      if (typeof c.message !== "object" || c.message === null) tally.text++;
      let text: string;
      if (typeof input === "string") {
        text = input;
      } else {
        // A WebSocket text frame is UTF-8: anything else never reaches the server.
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(input);
        } catch {
          expect(valid).toBe(false);
          return;
        }
      }
      const d = brokerDriver();
      expect(d.core).toBe(1);
      let last = d.core;
      while (last < 17) last = await openLive(d, "permission.query");
      expect(last).toBe(17);
      const before = d.b.info().connectionViolations;
      d.b.onText(text, 0);
      d.drain();
      const counted = d.b.info().connectionViolations > before;
      if (valid) {
        expect(counted).toBe(false);
        expect(d.closes.some((x) => x.reason === "repeated protocol violations")).toBe(false);
        return;
      }
      const terminated = [d.core, 17].filter((id) => d.cancels(id) > 0 || failureCode(d, id) === "invalidParams");
      expect(counted || terminated.length > 0).toBe(true);
      expect(counted && terminated.length > 0).toBe(false);
      if (counted) tally.connection++;
      else tally.request++;
      for (const id of terminated) {
        if (id === d.core) expect(d.closes.length).toBeGreaterThan(0);
        else expect(failureCode(d, id)).toBe("invalidParams");
      }
    });
  }
  test("corpus floors (broker path)", () => {
    expect(doc.valid.length).toBeGreaterThanOrEqual(56);
    expect(doc.invalid.length).toBeGreaterThanOrEqual(199);
    expect(tally.text).toBeGreaterThanOrEqual(80);
    expect(tally.connection).toBeGreaterThanOrEqual(80);
    expect(tally.request).toBeGreaterThanOrEqual(80);
  });
});
