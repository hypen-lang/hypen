/**
 * Device Capability Protocol — the shared `frames.json` corpus through the
 * server broker (RFC 001 §2.3, decision D3).
 *
 * The server's receiver-side frame rules (header validation, the per-channel
 * `seq` rule) live once, in the Rust `DeviceBroker`; the TS server reaches it
 * as `WasmDeviceBroker` through the port. This suite replays `frames.json`
 * through that broker, driven by a `DevicePlane` (tests/device-srv-harness),
 * the way the Go and Kotlin runners replay it through theirs:
 *
 *   - `frames`: a golden payload frame, retargeted at a live gallery.pick
 *     upload, is accepted and delivered byte for byte; a broker download
 *     frame carries a golden-form header;
 *   - `invalid`: a short header is dropped without effect; a bad version or
 *     nonzero flags is a counted connection-level violation that leaves the
 *     request its untrusted header names untouched;
 *   - `sequences`: every lossless (`pause`) case runs against a live upload
 *     channel — an accepted seq keeps the request live, the violating one
 *     settles it `invalidParams`. No registry revision has a `dropOldest`
 *     binary plane (checked here against the broker's own revisions), so the
 *     dropOldest and u32-wrap cases are reachable only in the Rust tests that
 *     run the same table (`frame_sequence_rules` in
 *     hypen-engine-rs/tests/test_device_transcripts.rs and
 *     `lossless_sequence_up_to_u32_max_and_no_wrap` in
 *     src/serialize/device.rs).
 *
 * The client-side header codec (`encodeFrame`/`decodeFrame`, used by the
 * browser runtime) is pinned against the same goldens in
 * device-generated.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { DEVICE_REGISTRY, sha256Hex, type DeviceSettlement } from "@hypen-space/core/remote/device";
import { deviceFileSaveParams } from "../packages/server/wasm-node/hypen_engine.js";
import { makePlane, spec } from "./device-srv-harness";

interface SeqCase {
  name: string;
  overflow: "pause" | "dropOldest";
  seqs: number[];
  valid: boolean;
}

interface GoldenFrame {
  header: { version: number; flags: number; channel: number; requestId: number; seq: number };
  hex: string;
  payloadHex?: string;
}

const FRAMES = resolve(import.meta.dir, "../../engine-compatibility-tests/fixtures/device/frames.json");
const doc = JSON.parse(readFileSync(FRAMES, "utf-8")) as {
  frames: GoldenFrame[];
  invalid: Array<{ reason: string; hex: string }>;
  sequences: { cases: SeqCase[] };
};
const cases = doc.sequences.cases;

const hex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function frame(id: number, channel: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 0);
  view.setUint16(2, channel, true);
  view.setUint32(4, id, true);
  view.setUint32(8, seq, true);
  out.set(payload, 12);
  return out;
}

/** A copy of `raw` whose requestId names `id` (the header's bytes 4..8). */
function withRequestId(raw: Uint8Array, id: number): Uint8Array {
  const out = raw.slice();
  if (out.byteLength >= 8) new DataView(out.buffer).setUint32(4, id, true);
  return out;
}

/** A plane over the Rust broker with one live gallery.pick upload on channel 0. */
function liveUpload(bytes?: number) {
  const h = makePlane();
  const r = h.plane.open(spec("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
  const id = r.id!;
  expect(id).toBeGreaterThan(0);
  let settled: DeviceSettlement | null = null;
  void r.settled.then((s) => (settled = s));
  h.receive({
    type: "deviceEvent",
    id,
    event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", ...(bytes !== undefined ? { bytes } : {}) },
  });
  expect(h.plane.isLive(id)).toBe(true);
  return { h, r, id, settled: () => settled };
}

describe("frames.json through the Rust broker (shared corpus)", () => {
  test("the corpus is present and non-trivial", () => {
    expect(doc.frames.length).toBeGreaterThan(0);
    expect(doc.invalid.length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.overflow === "pause").length).toBeGreaterThanOrEqual(4);
    expect(cases.some((c) => c.overflow === "dropOldest")).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
  });

  describe("golden frames", () => {
    test("every golden header is the form the test frames use", () => {
      for (const g of doc.frames) {
        const { version, flags, channel, requestId, seq } = g.header;
        expect(version).toBe(1);
        expect(flags).toBe(0);
        const payload = g.payloadHex ? hex(g.payloadHex) : new Uint8Array(0);
        expect(toHex(frame(requestId, channel, seq, payload))).toBe(g.hex);
      }
    });

    const withPayload = doc.frames.filter((g) => g.payloadHex);
    test("the corpus carries a golden payload frame", () => {
      expect(withPayload.length).toBeGreaterThan(0);
    });

    for (const [i, g] of withPayload.entries()) {
      test(`golden payload frame #${i} is accepted and delivered byte for byte`, async () => {
        expect(g.header.channel).toBe(0);
        expect(g.header.seq).toBe(0);
        const payload = hex(g.payloadHex!);
        const { h, r, id } = liveUpload(payload.byteLength);
        expect(h.plane.receiveFrame(withRequestId(hex(g.hex), id))).toBe(true);
        h.receive({
          type: "deviceResponse",
          id,
          result: {
            items: [{ channel: 0, contentType: "image/jpeg", bytes: payload.byteLength, sha256: await sha256Hex(payload) }],
          },
        });
        const s = await r.settled;
        if (!("result" in s)) throw new Error(`upload failed: ${JSON.stringify(s)}`);
        expect(s.blobs.length).toBe(1);
        expect(toHex(s.blobs[0].bytes)).toBe(g.payloadHex!);
      });
    }

    test("a broker download frame carries a golden-form header", () => {
      const h = makePlane();
      const bytes = new Uint8Array([7, 8, 9]);
      const params = deviceFileSaveParams("a.bin", "application/octet-stream", bytes);
      const r = h.plane.open(spec("file.save", params, { download: bytes }));
      expect(r.id).not.toBeNull();
      h.receive({ type: "deviceEvent", id: r.id, control: { grant: 1 << 20 } });
      expect(h.frames.length).toBe(1);
      expect(toHex(h.frames[0].subarray(0, 12))).toBe(toHex(frame(r.id!, 0, 0, new Uint8Array(0))));
      expect(toHex(h.frames[0].subarray(12))).toBe(toHex(bytes));
    });
  });

  describe("invalid frames", () => {
    for (const [k, inv] of doc.invalid.entries()) {
      test(`#${k} ${inv.reason}`, () => {
        const { h, id, settled } = liveUpload();
        const before = h.plane.connectionViolations;
        expect(h.plane.receiveFrame(withRequestId(hex(inv.hex), id))).toBe(false);
        if (inv.reason === "shortHeader") {
          expect(h.plane.connectionViolations).toBe(before);
        } else if (inv.reason.startsWith("violation")) {
          expect(h.plane.connectionViolations).toBe(before + 1);
        } else {
          throw new Error(`unknown invalid-frame reason ${inv.reason}`);
        }
        // The request the untrusted header names is untouched (decision D3).
        expect(h.plane.isLive(id)).toBe(true);
        expect(settled()).toBeNull();
        expect(h.sent.some((m) => m.id === id && m.control?.cancel === true)).toBe(false);
      });
    }
  });

  describe("sequences", () => {
    for (const c of cases.filter((c) => c.overflow === "pause")) {
      test(`${c.name} (pause) on a live upload channel`, async () => {
        const { h, r, id } = liveUpload();
        c.seqs.forEach((seq, k) => {
          const last = k === c.seqs.length - 1;
          h.plane.receiveFrame(frame(id, 0, seq, new Uint8Array([k & 0xff])));
          // An accepted seq keeps the request live; the violation retires it.
          expect(h.plane.isLive(id)).toBe(!(last && !c.valid));
        });
        if (c.valid) {
          r.cancel();
          expect(await r.settled).toEqual({ error: { code: "cancelled" } });
        } else {
          expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
        }
      });
    }

    test("no registry revision has a dropOldest binary plane: those cases are the Rust tests'", () => {
      const h = makePlane();
      const binaryOverflows = new Set<string>();
      let checked = 0;
      for (const [name, revs] of DEVICE_REGISTRY) {
        for (const { version } of revs) {
          const rev = h.port.revision(name, version);
          expect(rev).not.toBeNull();
          checked++;
          if (rev!.data === "binaryUpload" || rev!.data === "binaryDownload") binaryOverflows.add(rev!.overflow);
        }
      }
      expect(checked).toBeGreaterThan(0);
      for (const c of cases.filter((c) => c.overflow !== "pause")) {
        // If this fails, a revision gained that binary plane: replay the case above.
        expect({ case: c.name, reachable: binaryOverflows.has(c.overflow) }).toEqual({ case: c.name, reachable: false });
      }
    });
  });
});
