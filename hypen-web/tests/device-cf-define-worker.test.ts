/**
 * Cloudflare wiring of the Rust device broker through `defineHypenWorker`
 * (RFC 001, round 4) with the web-target glue Cloudflare actually runs.
 *
 * `defineHypenWorker({ wasm, wasmModule })` — with no device option at all,
 * the device plane is on by default — must hand the same web-target exports
 * to the Durable Object as `deviceWasm` automatically, so each device
 * socket gets a `WasmDeviceBroker` from the SAME wasm instance the engine
 * runs on. Here the worker is built from `tests/fixtures/wasm-web-glue`
 * (the `hypen-engine` web-target glue built with `js,device-broker`,
 * instantiated like wrangler does: `initSync({ module })` with a compiled
 * `WebAssembly.Module`), its DO class is instantiated with workerd
 * stand-ins, and a `FakeDeviceHost` client drives it through
 * `webSocketMessage`: handshake + core.capabilities, permission.query, a
 * binary gallery.pick upload verified by sha256, and a file.save download.
 * A glue without the broker exports leaves the device plane off (UI keeps
 * working, one warning), and `device: false` never negotiates a device plane.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "../packages/core/src/app";
import type { DeviceAck, DeviceClientTransport } from "@hypen-space/core/remote/device";
import { defineHypenWorker, hasDeviceBroker, HypenDurableObject } from "../packages/cf/src/index";
import type { CFWasmExports } from "../packages/cf/src/engine";
import { FakeDeviceHost } from "../packages/device-fake/src/index.ts";

// ---------------------------------------------------------------------------
// The web-target glue, loaded as a private copy (other suites mock package
// paths process-wide), paired with the wasm it was generated for.
// ---------------------------------------------------------------------------

const GLUE_DIR = resolve(import.meta.dir, "fixtures/wasm-web-glue");
const copies: string[] = [];
afterAll(async () => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
  // defineHypenWorker installs the web glue's portable helpers into core;
  // put the suite-wide wasm-node ones (tests/_preload.ts) back.
  // (A query string makes Bun evaluate the module again.)
  const reinstall = "../packages/server/src/install-portable.ts?restore-after-cf-define-worker";
  await import(reinstall);
});

const wasmPath = existsSync(join(GLUE_DIR, "hypen_engine_bg.wasm"))
  ? join(GLUE_DIR, "hypen_engine_bg.wasm")
  : resolve(import.meta.dir, "../packages/server/wasm-node/hypen_engine_bg.wasm");
const wasmBytes = readFileSync(wasmPath);
const expectedSha = readFileSync(join(GLUE_DIR, "hypen_engine_bg.wasm.sha256"), "utf8").trim();
if (createHash("sha256").update(wasmBytes).digest("hex") !== expectedSha) {
  throw new Error(`${GLUE_DIR} was generated for a different wasm; rerun hypen-engine-rs/build-wasm.sh`);
}
const glueCopy = mkdtempSync(join(tmpdir(), "hypen-cf-glue-"));
copies.push(glueCopy);
copyFileSync(join(GLUE_DIR, "hypen_engine.js"), join(glueCopy, "hypen_engine.js"));
const webGlue = (await import(join(glueCopy, "hypen_engine.js"))) as CFWasmExports & Record<string, unknown>;
// What wrangler hands the worker for `import m from "hypen-engine/hypen_engine_bg.wasm"`.
const wasmModule = new WebAssembly.Module(wasmBytes);

// ---------------------------------------------------------------------------
// workerd stand-ins
// ---------------------------------------------------------------------------

function createStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) {
      return data.get(key);
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      return data.delete(key);
    },
  };
}

function createCtx() {
  const sockets: WebSocket[] = [];
  return {
    storage: createStorage(),
    acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  };
}

type Sent = string | Uint8Array;

/** A hibernatable server socket whose sends are delivered to `onSend` (async, in order). */
function createSocket(onSend: (data: Sent) => void) {
  let attachment: unknown;
  const sent: Sent[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    send: (data: string | ArrayBuffer | Uint8Array) => {
      const d = typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer).slice();
      sent.push(d);
      setTimeout(() => onSend(d), 0);
    },
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
    serializeAttachment: (v: unknown) => {
      attachment = structuredClone(v);
    },
    deserializeAttachment: () => structuredClone(attachment),
  };
  return { ws: ws as unknown as WebSocket, sent, closes };
}

const json = (sent: Sent[]) => sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(5);
  return cond();
}
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const photo = new Uint8Array(70_000).map((_, i) => (i * 17 + 3) & 0xff); // > one 64 KiB frame
const saveBytes = new TextEncoder().encode("cf-define-worker ".repeat(5_000));
const seen: Record<string, string> = {};

function makeModule() {
  return app
    .defineState({ n: 0 })
    .onAction("query", async ({ context }) => {
      const r = await context!.device.permissions.query("camera");
      seen.query = r.ok ? r.value.status : r.error.code;
    })
    .onAction("pick", async ({ context }) => {
      const r = await context!.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
      if (!r.ok) {
        seen.pick = r.error.code;
        return;
      }
      const it = r.value.items[0]!;
      seen.pick = `${it.bytes.byteLength}:${sha256(it.bytes)}:${it.contentType}`;
    })
    .onAction("save", async ({ context }) => {
      const r = await context!.device.save(saveBytes, { name: "cf.txt", contentType: "text/plain" });
      seen.save = r.ok ? String(r.value.bytesWritten) : r.error.code;
    })
    .ui('module App { Text("n:@{state.n}") }');
}

function worker(opts: { device?: boolean; wasm?: CFWasmExports } = {}) {
  return defineHypenWorker({
    module: makeModule(),
    wasm: opts.wasm ?? webGlue,
    wasmModule,
    // No device option unless the test opts out: on by default.
    ...(opts.device !== undefined ? { device: opts.device } : {}),
    allowedOrigins: ["https://app.example"],
    doClassName: "DeviceDO",
  });
}

/**
 * Connect a FakeDeviceHost endpoint to a DO instance over a socket stand-in:
 * client → `webSocketMessage` (text or ArrayBuffer), server → the endpoint.
 */
function connect(DO: HypenDurableObject, observed: { saved: Uint8Array | null }) {
  const host = new FakeDeviceHost()
    .permissionsReturn({ camera: "granted" })
    .galleryReturns(photo, "image/jpeg")
    .driver("file.save", async ({ download }) => {
      const bytes = await download!.receiveAll();
      observed.saved = bytes;
      return { kind: "result", result: { bytesWritten: bytes.byteLength } };
    });
  const endpoint = host.endpoint();
  let ack: DeviceAck | undefined;
  let chain: Promise<void> = Promise.resolve();
  const toServer = (msg: string | ArrayBuffer) => {
    chain = chain.then(() => DO.webSocketMessage(socket.ws, msg));
  };
  const socket = createSocket((data) => {
    if (typeof data !== "string") {
      endpoint.handleFrame(data);
      return;
    }
    const m = JSON.parse(data);
    if (m.type === "sessionAck") {
      if (m.device) {
        ack = m.device;
        endpoint.onAck(m.device);
      }
      return;
    }
    if (typeof m.type === "string" && m.type.startsWith("device")) endpoint.handleText!(data);
  });
  const io: DeviceClientTransport = {
    sendMessage: (m) => toServer(JSON.stringify(m)),
    sendBinary: (f) => toServer(f.slice().buffer as ArrayBuffer),
  };
  endpoint.attach(io);
  return {
    socket,
    ack: () => ack,
    hello: () => toServer(JSON.stringify({ type: "hello", props: {}, device: endpoint.advertisement })),
    dispatch: (action: string) => toServer(JSON.stringify({ type: "dispatchAction", action })),
    settled: () => chain,
  };
}

// ---------------------------------------------------------------------------

describe("defineHypenWorker({ wasm }) with the web-target glue (device on by default)", () => {
  test("the fixture is the Cloudflare glue with the device broker", () => {
    expect(hasDeviceBroker(webGlue)).toBe(true);
    expect(typeof webGlue.initSync).toBe("function");
  });

  test("the DO negotiates a device plane on the Rust broker and serves unary, upload and download work", async () => {
    const w = worker();
    const ctx = createCtx();
    const DO = new w.DeviceDO!(ctx as any, {});
    expect(DO).toBeInstanceOf(HypenDurableObject);
    // The wiring under test: the DO config carries the worker's own wasm as deviceWasm.
    expect(DO.getConfig().deviceWasm).toBe(webGlue as any);

    const observed = { saved: null as Uint8Array | null };
    const c = connect(DO, observed);
    ctx.acceptWebSocket(c.socket.ws);
    c.hello();
    await c.settled();
    expect(await until(() => c.ack() !== undefined)).toBe(true);
    const frames = json(c.socket.sent);
    const ack = frames.find((m) => m.type === "sessionAck");
    expect(ack.device.protocolVersion).toBe(1);
    expect(ack.device.binary).toBe(true);
    expect(ack.device.capabilities.map((x: any) => x.name)).toEqual(
      expect.arrayContaining(["core.capabilities", "gallery.pick", "file.save", "permission.query"])
    );
    expect(typeof ack.resumeToken).toBe("string");
    // The connection-owned control stream is the first device request.
    const firstRequest = frames.find((m) => m.type === "deviceRequest");
    expect(firstRequest.capability).toBe("core.capabilities");
    // The hibernation marker precedes any device work on CF.
    expect((c.socket.ws as any).deserializeAttachment().deviceEnabled).toBe(true);

    c.dispatch("query");
    expect(await until(() => seen.query !== undefined)).toBe(true);
    expect(seen.query).toBe("granted");

    c.dispatch("pick");
    expect(await until(() => seen.pick !== undefined)).toBe(true);
    expect(seen.pick).toBe(`${photo.byteLength}:${sha256(photo)}:image/jpeg`);

    c.dispatch("save");
    expect(await until(() => seen.save !== undefined)).toBe(true);
    expect(seen.save).toBe(String(saveBytes.byteLength));
    expect(observed.saved).not.toBeNull();
    expect(sha256(observed.saved!)).toBe(sha256(saveBytes));
    // The download went out as binary frames through the web glue's broker.
    expect(c.socket.sent.some((d) => typeof d !== "string")).toBe(true);
    expect(c.socket.closes).toEqual([]);

    await DO.webSocketClose(c.socket.ws, 1000, "");
  });

  test("glue without the broker exports: the worker does not set deviceWasm and the DO stays UI-only", async () => {
    const { WasmDeviceBroker: _b, WasmRetainedBytesPool: _p, ...noBroker } = webGlue as Record<string, unknown>;
    expect(hasDeviceBroker(noBroker)).toBe(false);
    const w = worker({ wasm: noBroker as unknown as CFWasmExports });
    const ctx = createCtx();
    const DO = new w.DeviceDO!(ctx as any, {});
    expect(DO.getConfig().deviceWasm).toBeUndefined();
    const sock = createSocket(() => {});
    ctx.acceptWebSocket(sock.ws);
    await DO.webSocketMessage(
      sock.ws,
      JSON.stringify({
        type: "hello",
        props: {},
        device: { protocolVersions: [1], binary: true, capabilities: [{ name: "core.capabilities", versions: [1] }] },
      })
    );
    await sleep(20);
    const ack = json(sock.sent).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeUndefined();
    expect(json(sock.sent).some((m) => m.type === "deviceRequest")).toBe(false);
    await DO.webSocketClose(sock.ws, 1000, "");
  });

  test("device: false never wires a broker, even with the broker glue", async () => {
    const w = worker({ device: false });
    const ctx = createCtx();
    const DO = new w.DeviceDO!(ctx as any, {});
    expect(DO.getConfig().deviceWasm).toBeUndefined();
    const observed = { saved: null as Uint8Array | null };
    const c = connect(DO, observed);
    ctx.acceptWebSocket(c.socket.ws);
    c.hello();
    await c.settled();
    await sleep(20);
    const ack = json(c.socket.sent).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeUndefined();
    expect(json(c.socket.sent).some((m) => m.type === "deviceRequest")).toBe(false);
    await DO.webSocketClose(c.socket.ws, 1000, "");
  });
});
