/**
 * Host-input hardening of the Rust device broker (RFC 001) as shipped to
 * TypeScript, driven through the BUILT wasm-bindgen artifacts: the Node/Bun
 * build (`packages/server/wasm-node`) and Cloudflare's web-target glue
 * (`tests/fixtures/wasm-web-glue`, paired with its wasm by SHA-256; see
 * device-wasm-broker-binding.test.ts).
 *
 * - `consumedEvents` / `consumedData` counts are clamped to what the broker
 *   actually delivered (10 after 0 deliveries earns nothing; 1e300 returns at
 *   once and grants exactly the delivered amount);
 * - `setTransportBuffered` saturates instead of truncating on wasm32
 *   (2^32 buffered bytes must hold bulk frames back, not read as 0);
 * - host numbers must be finite and non-negative;
 * - `deviceHandshake`: hello validation + selection with a reason when the
 *   device plane is disabled (what the server SDK uses instead of its own
 *   selection code);
 * - payload refusals name the failing JSON path and rule.
 *
 * Rebuild the artifacts with `cd hypen-engine-rs && ./build-wasm.sh`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type * as NodeWasm from "../packages/server/wasm-node/hypen_engine.js";

// Private copies: other suites mock the package paths process-wide.
const copies: string[] = [];
afterAll(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});

async function loadCopy(dir: string, files: string[]): Promise<any> {
  const src = resolve(import.meta.dir, dir);
  const dst = mkdtempSync(join(tmpdir(), "hypen-wasm-hardening-"));
  copies.push(dst);
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  return import(join(dst, files[0]));
}

const nodeWasm: typeof NodeWasm = await loadCopy("../packages/server/wasm-node", [
  "hypen_engine.js",
  "hypen_engine_bg.wasm",
  "package.json",
]);

const CF_GLUE_DIR = "fixtures/wasm-web-glue";
const cfWasmPath = existsSync(resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm"))
  ? resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm")
  : resolve(import.meta.dir, "../packages/server/wasm-node/hypen_engine_bg.wasm");
const cfWasmBytes = readFileSync(cfWasmPath);
const cfWasmSha = readFileSync(
  resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm.sha256"),
  "utf8",
).trim();
if (createHash("sha256").update(cfWasmBytes).digest("hex") !== cfWasmSha) {
  throw new Error(
    `${CF_GLUE_DIR} was generated for a different hypen_engine_bg.wasm than ${cfWasmPath}; ` +
      "rerun `cd hypen-engine-rs && ./build-wasm.sh`",
  );
}
const cfWasm = await loadCopy(`./${CF_GLUE_DIR}`, ["hypen_engine.js"]);
cfWasm.initSync({ module: new WebAssembly.Module(cfWasmBytes) });

type Bindings = typeof NodeWasm;

const HELLO = {
  protocolVersions: [1],
  binary: true,
  capabilities: [
    { name: "core.capabilities", versions: [1] },
    { name: "gallery.pick", versions: [1] },
    { name: "file.save", versions: [1] },
    { name: "bluetooth.scan", versions: [1] },
    { name: "mic.record", versions: [1] },
  ],
};

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

/** A started broker with m1 active, and a recorder of what it asks for. */
function setup(w: Bindings) {
  const ack = w.deviceNegotiate(HELLO, true);
  const broker = new w.WasmDeviceBroker({ ack }, 0);
  broker.start(0);
  broker.ownerActivated("m1", 1, 0);
  const grants = new Map<number, number[]>();
  const frames: Uint8Array[] = [];
  let events = 0;
  let data = 0;
  const drain = () => {
    for (let i = 0; i < 64; i++) {
      const out = broker.poll() as any[];
      if (out.length === 0) return;
      for (const o of out) {
        if (o.type === "sendText") {
          const m = JSON.parse(o.text);
          if (m.control && typeof m.control.grant === "number") {
            grants.set(m.id, [...(grants.get(m.id) ?? []), m.control.grant]);
          }
        } else if (o.type === "sendFrame") frames.push(o.frame);
        else if (o.type === "event") events++;
        else if (o.type === "data") data++;
      }
    }
  };
  drain();
  return {
    broker,
    drain,
    grants: (id: number) => grants.get(id) ?? [],
    frames,
    counts: () => ({ events, data }),
  };
}

function exercise(name: string, w: Bindings) {
  describe(`device broker host inputs (${name})`, () => {
    test("consumedEvents earns credit only for delivered events, in O(1)", () => {
      const t = setup(w);
      const scan = (
        t.broker.open(
          { capability: "bluetooth.scan", params: {}, moduleInstanceId: "m1", activationId: 1, initialCredit: 2 },
          0,
        ) as { id: number }
      ).id;
      t.drain();
      // 10 after 0 deliveries, then an absurd count: no credit.
      t.broker.consumedEvents(scan, 10, 1);
      t.broker.consumedEvents(scan, 1e300, 1);
      t.broker.consumedEvents(scan, Number.MAX_SAFE_INTEGER, 1);
      t.drain();
      expect(t.grants(scan)).toEqual([]);
      expect(t.broker.outstandingEventCredit(scan)).toBe(2);

      const ev = { type: "deviceEvent", id: scan, event: { device: { id: "aa:1", name: "x", rssi: -40 } } };
      expect(t.broker.onText(JSON.stringify(ev), 2)).toBe(true);
      t.drain();
      expect(t.counts().events).toBe(1);
      const started = performance.now();
      t.broker.consumedEvents(scan, 1e300, 3);
      expect(performance.now() - started).toBeLessThan(1000);
      t.drain();
      expect(t.grants(scan)).toEqual([1]);
      // Already reported: repeating the claim is worth nothing.
      t.broker.consumedEvents(scan, 1e300, 3);
      t.drain();
      expect(t.grants(scan)).toEqual([1]);
      expect(t.broker.outstandingEventCredit(scan)).toBe(2);

      expect(() => t.broker.consumedEvents(scan, -1, 3)).toThrow(/finite non-negative/);
      expect(() => t.broker.consumedEvents(scan, Number.NaN, 3)).toThrow(/finite non-negative/);
      expect(() => t.broker.consumedEvents(scan, Infinity, 3)).toThrow(/finite non-negative/);
      expect(() => t.broker.tick(-5)).toThrow(/finite non-negative/);
      t.broker.free();
    });

    test("consumedData releases only delivered chunks", () => {
      const t = setup(w);
      const mic = (
        t.broker.open(
          {
            capability: "mic.record",
            params: { sampleRate: 16000, format: "pcm16" },
            moduleInstanceId: "m1",
            activationId: 1,
            initialCredit: 2048,
          },
          0,
        ) as { id: number }
      ).id;
      t.drain();
      t.broker.consumedData(mic, 1e300, 1);
      t.drain();
      expect(t.grants(mic)).toEqual([]);
      const bs = { type: "deviceEvent", id: mic, event: { kind: "blobStart", channel: 0, contentType: "audio/L16" } };
      expect(t.broker.onText(JSON.stringify(bs), 2)).toBe(true);
      expect(t.broker.onFrame(frame(mic, 0, 0, new Uint8Array(1024).fill(7)), 2)).toBe(true);
      expect(t.broker.onFrame(frame(mic, 0, 1, new Uint8Array(1024).fill(7)), 2)).toBe(true);
      t.drain();
      expect(t.counts().data).toBe(2);
      expect(t.broker.outstandingCredit(mic)).toBe(0);
      // 2^32 chunks must not truncate to 0 on wasm32; 1e300 saturates.
      t.broker.consumedData(mic, 2 ** 32, 3);
      t.drain();
      expect(t.grants(mic)).toEqual([2048]);
      t.broker.consumedData(mic, 1e300, 3);
      t.drain();
      expect(t.grants(mic)).toEqual([2048]);
      t.broker.free();
    });

    test("setTransportBuffered saturates instead of truncating", () => {
      const t = setup(w);
      const bytes = new Uint8Array(4096).fill(1);
      const params = w.deviceFileSaveParams("a.bin", "application/octet-stream", bytes);
      const dl = (
        t.broker.open({ capability: "file.save", params, moduleInstanceId: "m1", activationId: 1 }, 1, bytes) as {
          id: number;
        }
      ).id;
      t.drain();
      // 2^32 + 5 buffered bytes: saturated (truncation would read 5 and send).
      t.broker.setTransportBuffered(2 ** 32 + 5);
      expect(t.broker.onText(JSON.stringify({ type: "deviceEvent", id: dl, control: { grant: 65536 } }), 2)).toBe(
        true,
      );
      t.drain();
      expect(t.frames.length).toBe(0);
      t.broker.setTransportBuffered(0);
      t.drain();
      expect(t.frames.reduce((n, f) => n + f.length - 12, 0)).toBe(bytes.length);
      expect(() => t.broker.setTransportBuffered(-1)).toThrow(/finite non-negative/);
      t.broker.free();
    });

    test("deviceHandshake validates the hello and explains a disabled plane", () => {
      const ok = w.deviceHandshake(JSON.stringify(HELLO), true, undefined) as { ack: any; reason?: string };
      expect(ok.reason).toBeUndefined();
      expect(ok.ack).toEqual(w.deviceNegotiate(HELLO, true));
      const nonBinary = w.deviceHandshake(HELLO, false, null) as { ack: any };
      expect(nonBinary.ack.binary).toBe(false);
      expect(nonBinary.ack.capabilities.map((c: any) => c.name)).toEqual(["core.capabilities", "bluetooth.scan"]);

      // Raw member text: a duplicate key is judged as sent (D4/D7).
      const dupKey = '{"protocolVersions":[1],"protocolVersions":[1],"binary":true,"capabilities":[]}';
      const r1 = w.deviceHandshake(dupKey, true, undefined) as { ack: any; reason: string };
      expect(r1.ack).toBeNull();
      expect(r1.reason).toMatch(/^invalid hello\.device: .*duplicate/);
      const dupName = { ...HELLO, capabilities: [...HELLO.capabilities, HELLO.capabilities[0]] };
      expect((w.deviceHandshake(dupName, true, undefined) as { reason: string }).reason).toMatch(/duplicate/);
      const v2 = { ...HELLO, protocolVersions: [2] };
      expect((w.deviceHandshake(v2, true, undefined) as { reason: string }).reason).toMatch(/protocol version/);
      const noCore = { ...HELLO, capabilities: [{ name: "gallery.pick", versions: [1] }] };
      expect((w.deviceHandshake(noCore, true, undefined) as { reason: string }).reason).toMatch(
        /core\.capabilities@1/,
      );
      // An explicit server list replaces the default advertisement.
      const only = w.deviceHandshake(HELLO, true, [{ name: "core.capabilities", versions: [1] }]) as { ack: any };
      expect(only.ack.capabilities).toEqual([{ name: "core.capabilities", version: 1 }]);
      expect(() => w.deviceHandshake(HELLO, true, "not json")).toThrow(/server capabilities/);
    });

    test("payload refusals name the failing field and rule", () => {
      const t = setup(w);
      const r = t.broker.open(
        {
          capability: "gallery.pick",
          params: { mediaTypes: ["vid"], maxCount: 1 },
          moduleInstanceId: "m1",
          activationId: 1,
        },
        1,
      ) as { error: { code: string; detail: string } };
      expect(r.error.code).toBe("invalidParams");
      expect(r.error.detail).toBe("params $.mediaTypes[0]: unknown variant `vid`, expected `photo` or `video`");
      const r2 = t.broker.open(
        { capability: "gallery.pick", params: { mediaTypes: ["photo"], maxCount: 0 }, moduleInstanceId: "m1", activationId: 1 },
        1,
      ) as { error: { detail: string } };
      expect(r2.error.detail).toBe("params $.maxCount: maxCount 0 out of bounds 1..=16");
      t.broker.free();
    });
  });
}

exercise("wasm-node", nodeWasm);
exercise("Cloudflare pkg/web glue", cfWasm);
