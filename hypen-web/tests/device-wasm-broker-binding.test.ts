/**
 * Binding smoke test for the Rust device broker (RFC 001) as shipped to
 * TypeScript: loads the BUILT wasm-bindgen artifact the server SDK uses
 * (`packages/server/wasm-node`, Node/Bun target, built with
 * `--features js,device-broker`) and drives one upload (gallery.pick) and
 * one download (file.save) through `WasmDeviceBroker`, plus the `device*`
 * handshake helpers. It also pins that the browser bundle
 * (`packages/web-engine/wasm-browser`, `--features js` alone) carries NO
 * device broker: browsers never broker device requests, and the broker,
 * SHA-256 and payload validators would add ~0.5 MB to every page load.
 *
 * The same checks run against Cloudflare's build (`@hypen-space/cf` imports
 * the web-target `hypen-engine` package, `hypen-engine-rs/pkg/web`, built
 * with `js,device-broker`). `pkg/` is an untracked build output, so
 * `build-wasm.sh` copies that build's JS glue into
 * `tests/fixtures/wasm-web-glue/` and records the SHA-256 of the wasm it was
 * generated for. The web and nodejs targets compile the same Rust with the
 * same features, so that wasm is byte-identical to wasm-node's (the script
 * copies it into the fixture too if it ever is not); the glue is loaded the
 * way `CFEngine` loads it — `initSync({ module })` with a compiled
 * `WebAssembly.Module`. Rebuild the artifacts with
 * `cd hypen-engine-rs && ./build-wasm.sh`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type * as NodeWasm from "../packages/server/wasm-node/hypen_engine.js";

/**
 * Load a shipped build from a private copy of its files. Other suites
 * (`engine.browser.test.ts`) replace the package paths with `mock.module`
 * for the whole process, so importing the originals could yield a fake; a
 * byte-identical copy under a fresh path always loads the real glue + wasm.
 */
const copies: string[] = [];
afterAll(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});

async function loadCopy(dir: string, files: string[]): Promise<any> {
  const src = resolve(import.meta.dir, dir);
  const dst = mkdtempSync(join(tmpdir(), "hypen-wasm-"));
  copies.push(dst);
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  return import(join(dst, files[0]));
}

const nodeWasm: typeof NodeWasm = await loadCopy("../packages/server/wasm-node", [
  "hypen_engine.js",
  "hypen_engine_bg.wasm",
  "package.json",
]);
const webWasm = await loadCopy("../packages/web-engine/wasm-browser", [
  "hypen_engine.js",
  "hypen_engine_bg.wasm",
  "package.json",
]);
webWasm.initSync({
  module: readFileSync(
    resolve(import.meta.dir, "../packages/web-engine/wasm-browser/hypen_engine_bg.wasm"),
  ),
});

/**
 * Cloudflare's web-target glue, paired with the wasm it was generated for:
 * the fixture's own `hypen_engine_bg.wasm` when build-wasm.sh had to copy
 * one, otherwise wasm-node's (byte-identical). The recorded SHA-256 pins the
 * pair, so a glue left stale by a partial rebuild fails here by name instead
 * of as an opaque import mismatch.
 */
const CF_GLUE_DIR = "fixtures/wasm-web-glue";
const cfWasmPath = existsSync(resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm"))
  ? resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm")
  : resolve(import.meta.dir, "../packages/server/wasm-node/hypen_engine_bg.wasm");
const cfWasmBytes = readFileSync(cfWasmPath);
const cfWasmSha = readFileSync(
  resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine_bg.wasm.sha256"),
  "utf8",
).trim();
const cfWasm = await loadCopy(`./${CF_GLUE_DIR}`, ["hypen_engine.js"]);
if (createHash("sha256").update(cfWasmBytes).digest("hex") !== cfWasmSha) {
  throw new Error(
    `${CF_GLUE_DIR} was generated for a different hypen_engine_bg.wasm than ${cfWasmPath}; ` +
      "rerun `cd hypen-engine-rs && ./build-wasm.sh`",
  );
}
// As CFEngine does: wrangler hands the worker a compiled WebAssembly.Module.
cfWasm.initSync({ module: new WebAssembly.Module(cfWasmBytes) });

type Bindings = typeof NodeWasm;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function frame(id: number, channel: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1); // version
  view.setUint8(1, 0); // flags
  view.setUint16(2, channel, true);
  view.setUint32(4, id, true);
  view.setUint32(8, seq, true);
  out.set(payload, 12);
  return out;
}

const HELLO = {
  protocolVersions: [1],
  binary: true,
  capabilities: [
    { name: "core.capabilities", versions: [1] },
    { name: "gallery.pick", versions: [1] },
    { name: "file.save", versions: [1] },
  ],
};

function exercise(name: string, w: Bindings) {
  describe(`WasmDeviceBroker (${name})`, () => {
    test("handshake helpers", () => {
      const ack = w.deviceNegotiate(HELLO, true) as {
        protocolVersion: number;
        binary: boolean;
        capabilities: Array<{ name: string; version: number }>;
      };
      expect(ack.protocolVersion).toBe(1);
      expect(ack.capabilities.map((c) => c.name).sort()).toEqual([
        "core.capabilities",
        "file.save",
        "gallery.pick",
      ]);
      // D7: a duplicate capability name disables device access.
      const dup = { ...HELLO, capabilities: [...HELLO.capabilities, HELLO.capabilities[0]] };
      expect(w.deviceNegotiate(dup, true)).toBeNull();
      expect(w.deviceNegotiate("{", true)).toBeNull();
      expect((w.deviceValidateHello(JSON.stringify(HELLO)) as { ok: boolean }).ok).toBe(true);
      expect((w.deviceValidateHello(dup) as { ok: boolean }).ok).toBe(false);
      expect((w.deviceValidateAck(ack) as { ok: boolean }).ok).toBe(true);
      const adv0 = [{ name: "core.capabilities", versions: [1] }];
      const sel = w.deviceSelectAck(HELLO, [1], adv0, false) as {
        binary: boolean;
        capabilities: unknown[];
      };
      expect(sel.binary).toBe(false);
      expect(sel.capabilities).toEqual([{ name: "core.capabilities", version: 1 }]);
      expect(() => w.deviceSelectAck(HELLO, [1], "not json", true)).toThrow();
      expect(() => w.deviceSelectAck(HELLO, [-1], [], true)).toThrow();
      expect(w.deviceSelectAck(HELLO, "[2]", JSON.stringify(adv0), true)).toBeNull();
      const adv = w.deviceServerAdvertisement() as Array<{ name: string }>;
      expect(adv[0].name).toBe("core.capabilities");
      expect((w.deviceConstants() as { devicePlaneCloseCode: number }).devicePlaneCloseCode).toBe(1012);
      expect(w.deviceIsOversizeText('{"type":"deviceEvent"}')).toBe(false);
      expect(w.deviceSha256Hex(new TextEncoder().encode("abc"))).toBe(
        sha256(new TextEncoder().encode("abc")),
      );
      expect(w.deviceServerConsumes({ mode: "unary", data: "binaryDownload" })).toBe(true);
      expect(w.deviceServerConsumes('{"mode":"stream","data":"jsonEvents"}')).toBe(true);
      expect(w.deviceServerConsumes({ mode: "stream", data: "binaryDownload" })).toBe(false);
      expect(w.deviceServerConsumes({ mode: "stream", data: "none" })).toBe(false);
      expect(() => w.deviceServerConsumes({ mode: "stream" })).toThrow();
      expect(() => w.deviceServerConsumes({ mode: "often", data: "none" })).toThrow();
    });

    test("revision reports the effective revision", () => {
      const ack = w.deviceNegotiate(HELLO, true);
      const broker = new w.WasmDeviceBroker(
        {
          ack,
          maxItemBytes: 1024,
          revisionOverrides: [{ capability: "gallery.pick", version: 1, maxTimeoutMs: 1234 }],
        },
        0,
      );
      const pick = broker.revision("gallery.pick", 1) as Record<string, unknown>;
      expect(pick).toMatchObject({
        version: 1,
        mode: "unary",
        data: "binaryUpload",
        consent: "perUse",
        maxItemBytes: 1024,
        maxTimeoutMs: 1234,
      });
      expect(Array.isArray(pick.lifetimes)).toBe(true);
      // A revision answer feeds straight back into deviceServerConsumes.
      expect(w.deviceServerConsumes(pick)).toBe(true);
      const save = broker.revision("file.save", 1) as Record<string, unknown>;
      expect(save).toMatchObject({ mode: "unary", data: "binaryDownload", maxInitialCredit: 0 });
      expect(broker.revision("gallery.pick", 99)).toBeNull();
      expect(broker.revision("no.such", 1)).toBeNull();
      broker.free();
    });

    test("one upload and one download", () => {
      const ack = w.deviceNegotiate(HELLO, true);
      const broker = new w.WasmDeviceBroker({ ack }, 0);
      const sent: any[] = [];
      const frames: Uint8Array[] = [];
      const settled = new Map<number, any>();
      const drain = () => {
        for (let i = 0; i < 64; i++) {
          const out = broker.poll() as any[];
          if (out.length === 0) return;
          for (const o of out) {
            if (o.type === "sendText") sent.push(JSON.parse(o.text));
            else if (o.type === "sendFrame") frames.push(o.frame);
            else if (o.type === "settled") settled.set(o.id, o.outcome);
          }
        }
      };

      const core = broker.start(0) as { id: number };
      expect(typeof core.id).toBe("number");
      expect(broker.coreStreamId).toBe(core.id);
      expect(broker.ownerActivated("m1", 1, 0)).toBe(true);
      drain();
      expect(sent.some((m) => m.type === "deviceRequest" && m.capability === "core.capabilities")).toBe(true);

      // Upload: gallery.pick with one declared photo in two frames.
      const opened = broker.open(
        {
          capability: "gallery.pick",
          params: { mediaTypes: ["photo"], maxCount: 1 },
          moduleInstanceId: "m1",
          activationId: 1,
        },
        1,
      ) as { id: number };
      const id = opened.id;
      expect(broker.isLive(id)).toBe(true);
      drain();
      expect(sent.some((m) => m.type === "deviceRequest" && m.id === id && m.capability === "gallery.pick")).toBe(true);
      const photo = new Uint8Array(3000).map((_, i) => i % 251);
      expect(
        broker.onText(
          JSON.stringify({
            type: "deviceEvent",
            id,
            event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: photo.length },
          }),
          2,
        ),
      ).toBe(true);
      expect(broker.onFrame(frame(id, 0, 0, photo.subarray(0, 2000)), 3)).toBe(true);
      expect(broker.onFrame(frame(id, 0, 1, photo.subarray(2000)), 3)).toBe(true);
      expect(
        broker.onText(
          JSON.stringify({
            type: "deviceResponse",
            id,
            result: {
              items: [{ channel: 0, contentType: "image/jpeg", bytes: photo.length, sha256: sha256(photo) }],
            },
          }),
          4,
        ),
      ).toBe(true);
      drain();
      const up = settled.get(id);
      expect(up.ok).toBe(true);
      expect(up.blobs.length).toBe(1);
      expect(up.blobs[0].contentType).toBe("image/jpeg");
      expect(up.blobs[0].bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(up.blobs[0].bytes)).toEqual(Array.from(photo));
      expect(up.result.items[0].sha256).toBe(sha256(photo));
      expect(broker.isLive(id)).toBe(false);
      expect(broker.retainedBytes).toBe(0);

      // Download: file.save announces, waits for a grant, sends frames.
      const data = new TextEncoder().encode("hello from the rust broker");
      const params = w.deviceFileSaveParams("hello.txt", "text/plain", data) as { sha256: string };
      expect(params.sha256).toBe(sha256(data));
      const dl = (
        broker.open(
          { capability: "file.save", params, moduleInstanceId: "m1", activationId: 1 },
          5,
          data,
        ) as { id: number }
      ).id;
      drain();
      expect(frames.length).toBe(0);
      const req = sent.find((m) => m.type === "deviceRequest" && m.id === dl);
      expect(req.capability).toBe("file.save");
      expect(req.initialCredit).toBe(0);
      expect(
        broker.onText(JSON.stringify({ type: "deviceEvent", id: dl, control: { grant: 65536 } }), 6),
      ).toBe(true);
      drain();
      const received = new Uint8Array(frames.reduce((n, f) => n + f.length - 12, 0));
      let at = 0;
      for (const f of frames) {
        const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
        expect(view.getUint32(4, true)).toBe(dl);
        received.set(f.subarray(12), at);
        at += f.length - 12;
      }
      expect(new TextDecoder().decode(received)).toBe("hello from the rust broker");
      expect(
        broker.onText(
          JSON.stringify({ type: "deviceResponse", id: dl, result: { bytesWritten: data.length } }),
          7,
        ),
      ).toBe(true);
      drain();
      expect(settled.get(dl)).toMatchObject({ ok: true, result: { bytesWritten: data.length } });

      const info = broker.info() as { liveCount: number; coreStreamId: number; closed: boolean };
      expect(info.liveCount).toBe(1);
      expect(info.coreStreamId).toBe(core.id);
      expect(typeof broker.tick(8)).toBe("number");
      broker.close("connectionLost");
      expect(broker.isClosed).toBe(true);
      expect(() => broker.close("ConnectionLost")).toThrow();
      broker.free();
    });

    test("refusals are values, host errors throw, pools are shared", () => {
      const ack = w.deviceNegotiate(HELLO, true);
      const pool = new w.WasmRetainedBytesPool(1 << 20);
      const broker = w.WasmDeviceBroker.withPool(JSON.stringify({ ack, maxRetainedBytes: 8192 }), pool, 0);
      broker.start(0);
      broker.ownerActivated("m1", 1, 0);
      const replayed = broker.open(
        {
          capability: "gallery.pick",
          params: { mediaTypes: ["photo"], maxCount: 1 },
          moduleInstanceId: "m1",
          activationId: 1,
          replayed: true,
        },
        0,
      ) as { error: { code: string } };
      expect(replayed.error.code).toBe("unavailable");
      expect(() => broker.open("{", 0)).toThrow();
      expect(() => broker.open({ capability: "x", moduleInstanceId: "m1", activationId: 1, bogus: 1 }, 0)).toThrow();
      expect(() => new w.WasmDeviceBroker({}, 0)).toThrow();
      expect(() => broker.tick(-1)).toThrow();
      const id = (
        broker.open(
          { capability: "gallery.pick", params: { mediaTypes: ["photo"], maxCount: 1 }, moduleInstanceId: "m1", activationId: 1 },
          0,
        ) as { id: number }
      ).id;
      broker.onText(
        JSON.stringify({
          type: "deviceEvent",
          id,
          event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 4096 },
        }),
        1,
      );
      expect(pool.inUse()).toBeGreaterThanOrEqual(4096);
      broker.ownerDestroyed("m1", 2);
      const out = broker.poll() as any[];
      const s = out.find((o) => o.type === "settled" && o.id === id);
      expect(s.outcome).toMatchObject({ ok: false, code: "cancelled" });
      expect(pool.inUse()).toBe(0);
      broker.free();
      pool.free();
    });

    /** A started pooled broker holding one 50000-byte upload declaration. */
    function reserving(pool: InstanceType<Bindings["WasmRetainedBytesPool"]>) {
      const ack = w.deviceNegotiate(HELLO, true);
      const broker = w.WasmDeviceBroker.withPool({ ack }, pool, 0);
      broker.start(0);
      broker.ownerActivated("m1", 1, 0);
      broker.poll();
      const id = (
        broker.open(
          { capability: "gallery.pick", params: { mediaTypes: ["photo"], maxCount: 1 }, moduleInstanceId: "m1", activationId: 1 },
          1,
        ) as { id: number }
      ).id;
      broker.poll();
      expect(
        broker.onText(
          JSON.stringify({
            type: "deviceEvent",
            id,
            event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 50000 },
          }),
          2,
        ),
      ).toBe(true);
      expect(broker.onFrame(frame(id, 0, 0, new Uint8Array(2000).fill(7)), 3)).toBe(true);
      expect(broker.retainedBytes).toBe(50000);
      return broker;
    }

    test("free() without close() returns the broker's pooled bytes", () => {
      const pool = new w.WasmRetainedBytesPool(1 << 30);
      const kept = reserving(pool);
      const freed = reserving(pool);
      expect(pool.inUse()).toBe(100000);
      // A socket error path that never reached close(): free() alone must
      // hand the reservation back to the shared (process / DO) budget.
      freed.free();
      expect(pool.inUse()).toBe(50000);
      // free() after an explicit close() releases nothing twice.
      kept.close("connectionLost");
      expect(pool.inUse()).toBe(0);
      const other = reserving(pool);
      kept.free();
      expect(pool.inUse()).toBe(50000);
      other.free();
      expect(pool.inUse()).toBe(0);
      pool.free();
    });

    test("a garbage-collected broker returns its pooled bytes", async () => {
      // Unreachable, never closed or freed: wasm-bindgen's
      // FinalizationRegistry frees it, which must release its reservation.
      const pool = new w.WasmRetainedBytesPool(1 << 30);
      const abandon = () => {
        for (let i = 0; i < 20; i++) reserving(pool);
      };
      abandon();
      expect(pool.inUse()).toBe(20 * 50000);
      for (let i = 0; i < 100 && pool.inUse() > 0; i++) {
        Bun.gc(true);
        await Bun.sleep(10);
      }
      // JSC scans the stack conservatively, so tolerate one or two stragglers;
      // without the release-on-free every one of the 20 stays reserved.
      expect(pool.inUse()).toBeLessThanOrEqual(2 * 50000);
      pool.free();
    });

    test("a freed broker's budget is available to other connections", () => {
      // An aggregate budget that fits one 50000-byte declaration.
      const pool = new w.WasmRetainedBytesPool(60000);
      const first = reserving(pool);
      first.free();
      expect(pool.inUse()).toBe(0);
      const second = reserving(pool);
      expect(pool.inUse()).toBe(50000);
      second.free();
      pool.free();
    });
  });
}

exercise("wasm-node", nodeWasm);

describe("Cloudflare build (pkg/web glue)", () => {
  test("is the web-target glue with the device broker, paired with its wasm", () => {
    expect(createHash("sha256").update(cfWasmBytes).digest("hex")).toBe(cfWasmSha);
    expect(typeof cfWasm.initSync).toBe("function");
    expect(typeof cfWasm.default).toBe("function"); // the async web-target init
    expect(typeof cfWasm.WasmEngine).toBe("function");
    expect(typeof cfWasm.WasmDeviceBroker).toBe("function");
    expect(typeof cfWasm.WasmRetainedBytesPool).toBe("function");
    // The glue is the web target, not a copy of the nodejs glue.
    const glue = readFileSync(resolve(import.meta.dir, CF_GLUE_DIR, "hypen_engine.js"), "utf8");
    expect(glue).toMatch(/export \{ initSync, __wbg_init as default \}/);
    expect(glue).not.toContain("module.exports");
  });
});
exercise("pkg/web (Cloudflare)", cfWasm);

describe("browser bundle (wasm-browser)", () => {
  test("carries the engine but no device broker", () => {
    // The UI engine is there…
    expect(typeof webWasm.WasmEngine).toBe("function");
    expect(typeof webWasm.diffPaths).toBe("function");
    // …the device broker surface is not.
    for (const name of [
      "WasmDeviceBroker",
      "WasmRetainedBytesPool",
      "deviceNegotiate",
      "deviceSelectAck",
      "deviceServerConsumes",
      "deviceSha256Hex",
    ]) {
      expect(webWasm[name]).toBeUndefined();
    }
    const dts = readFileSync(
      resolve(import.meta.dir, "../packages/web-engine/wasm-browser/hypen_engine.d.ts"),
      "utf8",
    );
    expect(dts).not.toContain("WasmDeviceBroker");
    expect(dts).not.toContain("deviceNegotiate");
  });

  test("is smaller than the server build by the broker's weight", () => {
    const size = (dir: string) =>
      statSync(resolve(import.meta.dir, dir, "hypen_engine_bg.wasm")).size;
    const browser = size("../packages/web-engine/wasm-browser");
    const server = size("../packages/server/wasm-node");
    // The broker, SHA-256 and payload validators are several hundred KB of
    // wasm; if they leak into the browser build the two converge.
    expect(server - browser).toBeGreaterThan(256 * 1024);
  });
});
