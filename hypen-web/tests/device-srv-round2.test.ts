/**
 * Device Capability Protocol — server-side regressions for the second
 * adversarial review (review2-ts) and the round-2 decisions D1–D8.
 *
 * One describe per finding; each test fails on the pre-fix code:
 *
 *   #1  validator cost is linear (maxItems before per-item work, uniqueItems
 *       via one Set pass); a UI-only server never validates hello.device;
 *       device JSON is size-capped before parsing
 *   #2  (D2) a zero-byte item sends no frames and is delivered as an empty
 *       Uint8Array; a zero-length frame is always a violation
 *   #3  tiny frames: one buffer per channel, a minimum per-frame charge,
 *       batched grants, and an aggregate (process / DO) budget
 *   #4  ManagedRouter releases destroyed instances
 *   #7  (D6) no hello grace on device-enabled hosts; a slow hello resumes
 *   #8/#9 unconsumed results count until the handler scope ends; unary work
 *       orphaned by its handler is cancelled
 *   D5  undeclared blob sizes: limits enforced as bytes arrive
 *   #10 ws.send backpressure closes instead of dropping; save() validates
 *       its announcement and honors an abort signal; owner ids are opaque
 *   D1  Origin is browser-only; native clients authenticate
 *   D7  the (Rust) handshake behind the broker port validates the hello
 *       first; duplicate server entries: first wins
 */

import { describe, expect, spyOn, test } from "bun:test";
import { app, HypenApp } from "../packages/core/src/app";
import { ManagedRouter } from "../packages/core/src/managed-router";
import { HypenRouter } from "../packages/core/src/router";
import { HypenGlobalContext } from "../packages/core/src/context";
import type { Action } from "../packages/core/src/types";
import {
  RemoteSession,
  SessionManager,
  createBunWebSocketTransport,
  type SessionHost,
} from "@hypen-space/core/remote";
import {
  DeviceContext,
  encodeFrame,
  parseStrictDeviceJson,
  sha256Hex,
  validateCapabilityPayload,
  validateDeviceAck,
  type DeviceBrokerConfig,
  type DevicePlane,
  type DeviceResult,
} from "@hypen-space/core/remote/device";
import { WasmRetainedBytesPool, createWasmDeviceBrokerFactory } from "../packages/server/src/device-broker";
import { deviceValidateHello } from "../packages/server/wasm-node/hypen_engine.js";
import { RemoteServer, admitUpgrade } from "../packages/server/src/remote/server";
import {
  controlsFor,
  deviceHello,
  flush,
  makeHost,
  makePlane,
  makeTransport,
  requestsOf,
  spec,
} from "./device-srv-harness";

const owner = { moduleInstanceId: "m", activationId: 1 };
const galleryParams = { mediaTypes: ["photo"], maxCount: 1 };

const frame = (id: number | null, seq: number, payload: Uint8Array, channel = 0) =>
  encodeFrame({ version: 1, flags: 0, channel, requestId: id!, seq }, payload);
const blobStart = (id: number | null, bytes?: number, channel = 0) => ({
  type: "deviceEvent",
  id,
  event: { kind: "blobStart", channel, contentType: "image/jpeg", ...(bytes !== undefined ? { bytes } : {}) },
});

/** The Rust broker through the port (plane + fake clock), owner m @ 1. */
function brokerWith(config: Omit<DeviceBrokerConfig, "ack"> = {}, pool?: WasmRetainedBytesPool) {
  const h = makePlane({ config, owners: [["m", 1]], ...(pool ? { pool } : {}) });
  const broker = Object.assign(h.plane, { receive: h.receive }) as DevicePlane & { receive: typeof h.receive };
  return { broker, sent: h.sent, closes: h.closes };
}

const openGallery = (broker: DevicePlane, initialCredit = 65536) =>
  broker.open(spec("gallery.pick", galleryParams, { ...owner, timeoutMs: 300_000, initialCredit }));

const grantsOf = (sent: any[], id: number | null) =>
  sent.filter((m: any) => m.id === id && m.control?.grant !== undefined).map((m: any) => m.control.grant);

/** A session whose "go" action runs `run(context.device)`. */
async function startSession(
  run: (device: DeviceContext) => Promise<unknown>,
  hostOpts: Parameters<typeof makeHost>[1] = {}
) {
  const module = app
    .defineState({})
    .onAction("go", async ({ context }) => {
      await run(context.device);
    })
    .build() as unknown as SessionHost["module"];
  const t = makeTransport();
  const session = new RemoteSession(makeHost(module, hostOpts), t.transport, { helloGraceMs: null });
  await session.receive(JSON.stringify(deviceHello()));
  await session.ready;
  await flush();
  return { ...t, session, go: () => session.receive(JSON.stringify({ type: "dispatchAction", module: "Test", action: "go" })) };
}

// ---------------------------------------------------------------------------
// #1 — validator cost, hello validation, pre-parse size cap
// ---------------------------------------------------------------------------

describe("#1 validator cost is linear and bounded", () => {
  // The generated validators serve the client (sessionAck.device, envelope,
  // payloads): their cost stays bounded on hostile sizes.
  test("a 100k-element array against maxItems:64 validates in < 50 ms", () => {
    const capabilities = Array.from({ length: 100_000 }, (_, i) => ({ name: `c${i}`, version: 1 }));
    const started = performance.now();
    const violations = validateDeviceAck({ protocolVersion: 1, binary: true, capabilities });
    expect(performance.now() - started).toBeLessThan(50);
    // One violation, not one per item: nothing else runs on an oversize array.
    expect(violations).toEqual([{ path: "$.capabilities", message: "more than 64 items" }]);
  });

  test("uniqueItems still finds duplicates (Set pass, first pair reported)", () => {
    const hr = "0000180d-0000-1000-8000-00805f9b34fb";
    const bat = "0000180f-0000-1000-8000-00805f9b34fb";
    expect(validateCapabilityPayload("bluetooth.select", 1, "params", { services: [hr, bat, hr] })).toEqual([
      { path: "$.services", message: "duplicate items at 0 and 2" },
    ]);
  });

  // The server's side (hello.device, core.capabilities snapshots) is the
  // Rust broker's, reached through the port: same bound on hostile sizes.
  test("a hello.device with 100k protocol versions is refused by the Rust handshake in < 250 ms", () => {
    const port = createWasmDeviceBrokerFactory({ poolBytes: null });
    const protocolVersions = Array.from({ length: 100_000 }, (_, i) => i + 1);
    const text = JSON.stringify({ protocolVersions, binary: true, capabilities: [] });
    const started = performance.now();
    const outcome = port.negotiate(text, true);
    expect(performance.now() - started).toBeLessThan(250);
    expect(outcome.ack).toBeNull();
    expect(outcome.reason).toStartWith("invalid hello.device");
    expect(deviceValidateHello(JSON.stringify({ protocolVersions: [3, 1, 3], binary: true, capabilities: [] })).ok).toBe(false);
  });

  test("a core.capabilities snapshot with 60k versions is rejected by the Rust broker in < 250 ms", () => {
    const h = makePlane();
    const versions = Array.from({ length: 60_000 }, (_, i) => i + 1);
    const started = performance.now();
    h.receive({ type: "deviceEvent", id: h.core, event: { capabilities: [{ name: "core.capabilities", versions }] } });
    expect(performance.now() - started).toBeLessThan(250);
    // A violated control stream: one cancel, and the device plane closes.
    expect(controlsFor(h.sent, h.core!, "cancel").length).toBe(1);
    expect(h.plane.isClosed).toBe(true);
  });

  test("a UI-only server never validates hello.device (160k versions: fast, no device)", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module, { deviceDisabled: true }), t.transport, { helloGraceMs: null });
    const protocolVersions = Array.from({ length: 160_000 }, (_, i) => i + 1);
    const text = JSON.stringify({ type: "hello", device: { protocolVersions, binary: true, capabilities: [] } });
    const started = performance.now();
    await session.receive(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect((t.ui.find((m) => m.type === "sessionAck") as any).device).toBeUndefined();
    await session.destroy();
  });

  test("hello.device is strictly decoded from its own text: a duplicate key disables device only", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(
      `{"type":"hello","props":{"ratio":1.5},"device":{"protocolVersions":[1],"binary":false,"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}}`
    );
    await session.ready;
    const ack = t.ui.find((m) => m.type === "sessionAck") as any;
    expect(ack).toBeDefined(); // UI keeps working (and the UI props' 1.5 is not judged)
    expect(ack.device).toBeUndefined();
    expect(session.deviceBroker).toBeNull();
    await session.destroy();
  });

  test("a valid hello.device beside non-device props (floats) still negotiates", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify({ ...deviceHello(), props: { ratio: 1.5 } }));
    await session.ready;
    expect((t.ui.find((m) => m.type === "sessionAck") as any).device).toBeDefined();
    await session.destroy();
  });

  test("an over-1 MiB device message is dropped before parsing (connection-level)", async () => {
    const t = await startSession(async () => {});
    const broker = t.session.deviceBroker!;
    const before = broker.connectionViolations;
    const pad = "x".repeat(15 * 1024 * 1024);
    const started = performance.now();
    await t.session.receive(`{"type":"deviceEvent","id":999,"event":{"pad":"${pad}"}}`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(broker.connectionViolations).toBe(before + 1);
    // Also when `type` is not the first member (the linear top-level scan
    // finds it anywhere): still dropped before any JSON.parse.
    const parse = spyOn(JSON, "parse");
    try {
      await t.session.receive(`{"id":999,"event":{"pad":"${"y".repeat(1_100_000)}"},"type":"deviceEvent"}`);
      for (const call of parse.mock.calls) expect(String(call[0]).length).toBeLessThan(64);
    } finally {
      parse.mockRestore();
    }
    expect(broker.connectionViolations).toBe(before + 2);
    expect(broker.lastConnectionViolation).toMatch(/over 1 MiB/);
    await t.session.destroy();
  });

  test("the strict parser is one linear pass over 1 MiB", () => {
    const doc = (n: number) =>
      `{"type":"deviceEvent","id":1,"event":{"a":[${Array.from({ length: n }, (_, i) => `{"k${i}":${i}}`).join(",")}]}}`;
    const full = doc(60_000);
    const quarter = doc(15_000);
    expect(full.length).toBeLessThan(1_048_576);
    // Best of several runs: the minimum is what the parser costs, not what a
    // loaded machine's scheduler added on top (an absolute wall-clock bound on
    // a single run flaked under parallel suites).
    const best = (text: string) => {
      let min = Infinity;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        expect(parseStrictDeviceJson(text).ok).toBe(true);
        min = Math.min(min, performance.now() - started);
      }
      return min;
    };
    best(quarter); // warm the JIT so the small input is not measured cold
    const tQuarter = best(quarter);
    const tFull = best(full);
    // Linear: 4x the input costs ~4x the time; a quadratic pass would cost
    // ~16x. The floor keeps timer granularity on a fast machine from
    // inflating the ratio.
    expect(tFull / Math.max(tQuarter, 1)).toBeLessThan(10);
    // And the full 1 MiB stays well within a message-handling budget.
    expect(tFull).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// #2 / D2 — empty items
// ---------------------------------------------------------------------------

describe("#2 (D2) zero-byte items send no frames", () => {
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  for (const declared of [true, false]) {
    test(`an empty item (${declared ? "declared bytes:0" : "undeclared"}) reaches the handler as an empty Uint8Array`, async () => {
      let result: DeviceResult<any> | null = null;
      const t = await startSession(async (device) => {
        result = await device.request("gallery.pick", galleryParams);
      });
      await t.go();
      await flush();
      const req = requestsOf(t.device, "gallery.pick")[0];
      await t.session.receive(JSON.stringify(blobStart(req.id, declared ? 0 : undefined)));
      await t.session.receive(
        JSON.stringify({
          type: "deviceResponse",
          id: req.id,
          result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 0, sha256: EMPTY_SHA }] },
        })
      );
      await flush();
      await flush();
      expect(result).toMatchObject({ ok: true });
      const item = (result as any).value.items[0];
      expect(item.bytes).toBeInstanceOf(Uint8Array);
      expect(item.bytes.byteLength).toBe(0);
      expect(controlsFor(t.device, req.id, "cancel").length).toBe(0);
      await t.session.destroy();
    });
  }

  test("a zero-length frame is always a violation, even for a bytes:0 item", async () => {
    const { broker, sent } = brokerWith();
    const h = openGallery(broker);
    broker.receive(JSON.stringify(blobStart(h.id, 0)));
    expect(broker.receiveFrame(frame(h.id, 0, new Uint8Array(0)))).toBe(false);
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/zero-length/) } });
    expect(sent.some((m: any) => m.id === h.id && m.control?.cancel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #3 — tiny frames, grants, aggregate budget
// ---------------------------------------------------------------------------

describe("#3 1-byte frames cannot outrun the budget", () => {
  test("every frame costs at least 1 KiB of budget: a 64 KiB budget admits 64 tiny frames", async () => {
    const { broker } = brokerWith({ maxRetainedBytes: 64 * 1024 });
    const h = openGallery(broker);
    broker.receive(JSON.stringify(blobStart(h.id))); // undeclared: nothing reserved up front
    let accepted = 0;
    for (let seq = 0; seq < 1000; seq++) {
      if (broker.receiveFrame(frame(h.id, seq, new Uint8Array([7])))) accepted++;
      else break;
    }
    expect(accepted).toBe(64);
    expect(await h.settled).toMatchObject({ error: { code: "throttled" } });
    expect(broker.retainedBytes).toBe(0); // released with the request
  });

  test("a maximum-size declared item with a short last chunk fits a budget equal to it", async () => {
    const budget = 64 * 1024;
    const { broker } = brokerWith({ maxRetainedBytes: budget, maxItemBytes: budget });
    const h = openGallery(broker, 65536);
    broker.receive(JSON.stringify(blobStart(h.id, budget)));
    const bytes = new Uint8Array(budget).fill(3);
    let seq = 0;
    let off = 0;
    for (; off + 65000 <= budget; off += 65000) expect(broker.receiveFrame(frame(h.id, seq++, bytes.subarray(off, off + 65000)))).toBe(true);
    expect(broker.receiveFrame(frame(h.id, seq++, bytes.subarray(off)))).toBe(true); // 536 bytes: charged exactly
    expect(broker.isLive(h.id)).toBe(true);
    h.cancel();
  });

  test("grants are batched: one per half window, not one per frame", () => {
    const { broker, sent } = brokerWith();
    const h = openGallery(broker, 4096);
    broker.receive(JSON.stringify(blobStart(h.id)));
    for (let seq = 0; seq < 4096; seq++) expect(broker.receiveFrame(frame(h.id, seq, new Uint8Array([seq & 0xff])))).toBe(true);
    const grants = grantsOf(sent, h.id);
    expect(grants.length).toBe(2); // 4096 frames of 1 byte → 2 grants of 2048
    expect(grants.every((g) => g === 2048)).toBe(true);
    h.cancel();
  });

  test("payload lands in one buffer per channel: the item is delivered intact", async () => {
    const { broker } = brokerWith();
    const h = openGallery(broker, 65536);
    const bytes = new Uint8Array(10_000).map((_, i) => (i * 31) & 0xff);
    broker.receive(JSON.stringify(blobStart(h.id, bytes.byteLength)));
    let seq = 0;
    for (let off = 0; off < bytes.byteLength; off += 1500) {
      expect(broker.receiveFrame(frame(h.id, seq++, bytes.subarray(off, off + 1500)))).toBe(true);
    }
    broker.receive(
      JSON.stringify({
        type: "deviceResponse",
        id: h.id,
        result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: bytes.byteLength, sha256: await sha256Hex(bytes) }] },
      })
    );
    const s = await h.settled;
    expect("result" in s && s.blobs.find((b) => b.channel === 0)?.bytes).toEqual(bytes);
  });

  test("an aggregate pool bounds connections together (process / Durable Object)", async () => {
    const pool = new WasmRetainedBytesPool(100 * 1024);
    const a = brokerWith({}, pool);
    const b = brokerWith({}, pool);
    const ha = openGallery(a.broker);
    const hb = openGallery(b.broker);
    a.broker.receive(JSON.stringify(blobStart(ha.id, 80 * 1024)));
    expect(a.broker.isLive(ha.id)).toBe(true);
    expect(pool.inUse()).toBe(80 * 1024);
    b.broker.receive(JSON.stringify(blobStart(hb.id, 40 * 1024)));
    expect(await hb.settled).toMatchObject({ error: { code: "throttled" } });
    ha.cancel();
    expect(pool.inUse()).toBe(0);
  });

  test("bad frame headers are connection-level: counted, the request lives on (D3)", () => {
    const { broker } = brokerWith();
    const h = openGallery(broker);
    broker.receive(JSON.stringify(blobStart(h.id, 3)));
    const bad = frame(h.id, 0, new Uint8Array([1, 2, 3]));
    bad[0] = 2; // unknown version
    expect(broker.receiveFrame(bad)).toBe(false);
    bad[0] = 1;
    bad[1] = 1; // nonzero flags
    expect(broker.receiveFrame(bad)).toBe(false);
    expect(broker.connectionViolations).toBe(2);
    expect(broker.isLive(h.id)).toBe(true);
    expect(broker.receiveFrame(frame(h.id, 0, new Uint8Array([1, 2, 3])))).toBe(true);
    h.cancel();
  });

  test("repeated connection-level violations close the device plane once the burst is spent", async () => {
    const { broker, closes } = brokerWith({ violationRate: { burst: 3, perSecond: 0 } });
    const h = openGallery(broker);
    for (let i = 0; i < 3; i++) broker.receive('{"type":"deviceEvent","id":1,"id":1}');
    expect(closes).toEqual([]);
    broker.receive('{"type":"deviceEvent","id":1,"id":1}');
    expect(closes.length).toBe(1);
    expect(closes[0]).toMatchObject({ code: 1012, reason: expect.stringMatching(/repeated protocol violations/) });
    expect(broker.isClosed).toBe(true);
    expect(await h.settled).toEqual({ error: { code: "connectionLost" } });
  });
});

// ---------------------------------------------------------------------------
// D5 — undeclared sizes
// ---------------------------------------------------------------------------

describe("D5 blob sizes are optional", () => {
  test("an undeclared item over maxItemBytes is refused as bytes arrive", async () => {
    const { broker } = brokerWith({ maxItemBytes: 100 });
    const h = openGallery(broker);
    broker.receive(JSON.stringify(blobStart(h.id)));
    expect(broker.receiveFrame(frame(h.id, 0, new Uint8Array(60)))).toBe(true);
    expect(broker.receiveFrame(frame(h.id, 1, new Uint8Array(41)))).toBe(false);
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/max item bytes 100/) } });
  });

  test("a declared size that is not reached fails at the terminal", async () => {
    const { broker } = brokerWith();
    const h = openGallery(broker);
    const bytes = new Uint8Array([1, 2, 3]);
    broker.receive(JSON.stringify(blobStart(h.id, 4)));
    broker.receiveFrame(frame(h.id, 0, bytes));
    broker.receive(
      JSON.stringify({
        type: "deviceResponse",
        id: h.id,
        result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3, sha256: await sha256Hex(bytes) }] },
      })
    );
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/3 of 4 declared/) } });
  });

  test("an undeclared item's terminal must state the bytes actually received", async () => {
    const { broker } = brokerWith();
    const h = openGallery(broker);
    const bytes = new Uint8Array([1, 2, 3]);
    broker.receive(JSON.stringify(blobStart(h.id)));
    broker.receiveFrame(frame(h.id, 0, bytes));
    broker.receive(
      JSON.stringify({
        type: "deviceResponse",
        id: h.id,
        result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 999, sha256: await sha256Hex(bytes) }] },
      })
    );
    expect(await h.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/states 999 bytes, received 3/) } });
  });
});

// ---------------------------------------------------------------------------
// #4 — ManagedRouter releases destroyed instances
// ---------------------------------------------------------------------------

describe("#4 ManagedRouter does not retain destroyed instances", () => {
  class RecordingEngine {
    actionHandlers = new Map<string, (action: Action) => unknown>();
    setModule() {}
    registerModule() {}
    updateStateSparse() {}
    onAction(name: string, handler: (action: Action) => unknown) {
      this.actionHandlers.set(name, handler);
    }
    unregisterModule() {}
  }

  test("persist:false navigations and LRU evictions leave only live instances registered", async () => {
    const registry = new HypenApp();
    registry.module("A").defineState({ n: 0 }, { persist: false } as any).build();
    registry.module("B").defineState({ n: 0 }, { persist: false } as any).build();
    for (const name of ["C", "D", "E"]) registry.module(name).defineState({ n: 0 }).build();
    const router = new HypenRouter();
    const managed = new ManagedRouter(router, new RecordingEngine() as never, registry, new HypenGlobalContext(), {
      maxPersistedModules: 1,
    });
    for (const name of ["A", "B", "C", "D", "E"]) managed.addRoute({ path: `/${name.toLowerCase()}`, component: name });
    router.push("/a");
    managed.start();
    await managed.waitForNavigation();
    for (let i = 0; i < 60; i++) {
      router.push(["/a", "/b", "/c", "/d", "/e"][i % 5]!);
      await managed.waitForNavigation();
    }
    // Never calling liveInstances() (which prunes): the registry itself holds
    // at most the active module + the one persisted entry.
    const created = (managed as unknown as { createdInstances: Set<{ destroyed: boolean }> }).createdInstances;
    expect(created.size).toBeLessThanOrEqual(2);
    expect([...created].every((i) => !i.destroyed)).toBe(true);
    await managed.stop();
    expect(created.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #7 / D6 — hello grace applies whatever the device setting (device always on)
// ---------------------------------------------------------------------------

describe("#7 hello grace: legacy clients are initialised on every host", () => {
  test("a legacy client that never says hello is grace-initialised on a device host (no device plane)", async () => {
    const module = app.defineState({ n: 0 }).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    // No helloGraceMs passed — exactly what RemoteServer.createSession does.
    const session = new RemoteSession(makeHost(module), t.transport, {});
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s grace
    await session.ready;
    const acks = t.ui.filter((m) => m.type === "sessionAck") as any[];
    expect(acks.length).toBe(1);
    expect(acks[0].isNew).toBe(true);
    expect(acks[0].device).toBeUndefined();
    // The resume credential is always issued.
    expect(typeof acks[0].resumeToken).toBe("string");
    expect(t.ui.some((m) => m.type === "initialTree")).toBe(true);
    expect(session.deviceBroker).toBeNull();
    expect(t.closes).toEqual([]);
    await session.destroy();
  });

  test("a device hello within the grace resumes its device session (with its token)", async () => {
    const sm = new SessionManager();
    const module = app.defineState({ n: 0 }).build() as unknown as SessionHost["module"];
    const a = makeTransport();
    const s1 = new RemoteSession(makeHost(module, { sessionManager: sm }), a.transport, {});
    await s1.receive(JSON.stringify(deviceHello()));
    await s1.ready;
    await flush();
    const ack1 = a.ui.find((m) => m.type === "sessionAck") as any;
    await s1.destroy();

    const b = makeTransport();
    const s2 = new RemoteSession(makeHost(module, { sessionManager: sm }), b.transport, {});
    await s2.receive(
      JSON.stringify(deviceHello(undefined, { sessionId: ack1.sessionId, resumeToken: ack1.resumeToken }))
    );
    await flush();
    const acks = b.ui.filter((m) => m.type === "sessionAck") as any[];
    expect(acks.length).toBe(1);
    expect(acks[0].sessionId).toBe(ack1.sessionId);
    expect(acks[0].isNew).toBe(false);
    expect(acks[0].device).toBeDefined();
    await s2.destroy();
  });

  test("the handshake timeout closes a socket that never says hello (when grace is disabled)", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null, helloTimeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.closes).toEqual([{ code: 1008, reason: "hello timeout" }]);
    expect(t.ui.length).toBe(0);
    await session.destroy();
  });

  test("UI-only hosts keep the legacy grace path", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module, { deviceDisabled: true }), t.transport, { helloGraceMs: 10 });
    await session.ready;
    expect(t.ui.some((m) => m.type === "sessionAck")).toBe(true);
    await session.destroy();
  });

  test("a late device hello on a grace-created session repeats the original isNew", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: 5 });
    await session.ready;
    await session.receive(JSON.stringify(deviceHello(undefined, { sessionId: "someone-else" })));
    await flush();
    const acks = t.ui.filter((m) => m.type === "sessionAck") as any[];
    expect(acks.length).toBe(2);
    expect(acks[1].device).toBeDefined();
    expect(acks[1].sessionId).toBe(acks[0].sessionId);
    expect(acks[1].isNew).toBe(true); // was false: a resume the client never had
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// #8 / #9 — handler scope: unconsumed results, orphaned requests
// ---------------------------------------------------------------------------

describe("#8/#9 unary work is scoped to its handler", () => {
  test("a request the handler did not await is cancelled when the handler returns", async () => {
    let orphan: Promise<DeviceResult<unknown>> | null = null;
    const t = await startSession(async (device) => {
      orphan = device.request("gallery.pick", galleryParams);
    });
    await t.go();
    await flush();
    const req = requestsOf(t.device, "gallery.pick")[0];
    expect(controlsFor(t.device, req.id, "cancel").length).toBe(1);
    expect(await orphan!).toEqual({ ok: false, error: { code: "cancelled" } });
    // The client's late upload for the retired id allocates nothing.
    await t.session.receive(JSON.stringify(blobStart(req.id, 3)));
    t.session.receiveBinary(frame(req.id, 0, new Uint8Array([1, 2, 3])));
    expect(t.session.deviceBroker!.retainedBytes).toBe(0);
    await t.session.destroy();
  });

  test("a delivered result keeps counting toward the quota until the handler returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let delivered: DeviceResult<any> | null = null;
    const t = await startSession(async (device) => {
      delivered = await device.request("gallery.pick", galleryParams);
      await gate; // the handler is still holding the result
    });
    const dispatched = t.go();
    await flush();
    const req = requestsOf(t.device, "gallery.pick")[0];
    const bytes = new Uint8Array(3000).fill(9);
    await t.session.receive(JSON.stringify(blobStart(req.id, bytes.byteLength)));
    t.session.receiveBinary(frame(req.id, 0, bytes));
    await t.session.receive(
      JSON.stringify({
        type: "deviceResponse",
        id: req.id,
        result: { items: [{ channel: 0, contentType: "image/jpeg", bytes: 3000, sha256: await sha256Hex(bytes) }] },
      })
    );
    await flush();
    await flush();
    expect(delivered).toMatchObject({ ok: true });
    const broker = t.session.deviceBroker!;
    expect(broker.retainedBytes).toBeGreaterThanOrEqual(3000); // completed-but-unconsumed
    release();
    await dispatched;
    await flush();
    expect(broker.retainedBytes).toBe(0);
    await t.session.destroy();
  });

  test("a request issued after the handler returned (timer, live owner) is not scope-cancelled", async () => {
    let later: Promise<DeviceResult<unknown>> | null = null;
    let captured!: DeviceContext;
    const t = await startSession(async (device) => {
      captured = device;
    });
    await t.go();
    await flush();
    later = captured.request("permission.request", { permission: "camera" });
    await flush();
    const req = requestsOf(t.device, "permission.request")[0];
    expect(controlsFor(t.device, req.id, "cancel").length).toBe(0);
    await t.session.receive(JSON.stringify({ type: "deviceResponse", id: req.id, result: { status: "granted" } }));
    expect(await later).toEqual({ ok: true, value: { status: "granted" } });
    await t.session.destroy();
  });
});

// ---------------------------------------------------------------------------
// #10 — transport backpressure, save(), owner ids
// ---------------------------------------------------------------------------

describe("#10 remaining server gaps", () => {
  test("a dropped ws.send closes the connection instead of losing the message", () => {
    const closes: Array<[number | undefined, string | undefined]> = [];
    let sends = 0;
    const transport = createBunWebSocketTransport({
      send: () => {
        sends += 1;
        return sends >= 2 ? 0 : 10; // second send: dropped past Bun's backpressure limit
      },
      close: (code, reason) => closes.push([code, reason]),
    });
    transport.send({ type: "sessionAck", sessionId: "s", isNew: true, isRestored: false });
    expect(closes).toEqual([]);
    transport.sendDevice!({ type: "deviceEvent", id: 1, control: { cancel: true } });
    expect(closes).toEqual([[1013, "send buffer overflow"]]);
    transport.sendBinary!(new Uint8Array(4));
    expect(sends).toBe(2); // nothing more is written to a socket being closed
    expect(closes.length).toBe(1);
  });

  test("backpressure (-1: queued) is not a drop", () => {
    const closes: unknown[] = [];
    const transport = createBunWebSocketTransport({ send: () => -1, close: () => closes.push(1) });
    transport.send({ type: "sessionAck", sessionId: "s", isNew: true, isRestored: false });
    expect(closes).toEqual([]);
  });

  test("save() validates its announcement locally (no request, no round trip)", async () => {
    const { broker, sent } = brokerWith();
    const before = sent.length;
    const ctx = new DeviceContext(broker, owner, "origin");
    const res = await ctx.save(new Uint8Array([1]), { name: "n".repeat(513), contentType: "text/plain" });
    // Refused by the Rust broker at open (its wording, with the path).
    expect(res).toMatchObject({
      ok: false,
      error: { code: "invalidParams", platformDetail: expect.stringMatching(/^params \$\.name/) },
    });
    expect(sent.length).toBe(before);
  });

  test("save() honors an abort signal (cancel sent, settled cancelled)", async () => {
    const { broker, sent } = brokerWith();
    const ctx = new DeviceContext(broker, owner, "origin");
    const controller = new AbortController();
    const pending = ctx.save(new Uint8Array([1, 2]), { name: "a.txt", contentType: "text/plain", signal: controller.signal });
    const isSave = (m: any) => m.type === "deviceRequest" && m.capability === "file.save";
    for (let i = 0; i < 5 && !sent.some(isSave); i++) await flush();
    const req = sent.find(isSave)!;
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(sent.some((m: any) => m.id === req.id && m.control?.cancel)).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(await ctx.save(new Uint8Array([1]), { name: "a", contentType: "t", signal: pre.signal })).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("owner ids are opaque: no module name, no process-wide counter", () => {
    const { HypenModuleInstance } = require("../packages/core/src/app") as typeof import("../packages/core/src/app");
    const engine = { setModule() {}, registerModule() {}, updateStateSparse() {}, onAction() {} };
    const def = app.defineState({}, { name: "SecretBilling" }).build();
    const a = new HypenModuleInstance(engine as never, def);
    const b = new HypenModuleInstance(engine as never, def);
    for (const inst of [a, b]) {
      expect(inst.deviceInstanceId).toMatch(/^mi-[0-9a-f-]{36}$/);
      expect(inst.deviceInstanceId.toLowerCase()).not.toContain("secret");
    }
    expect(a.deviceInstanceId).not.toBe(b.deviceInstanceId);
  });
});

// ---------------------------------------------------------------------------
// D7 — selection
// ---------------------------------------------------------------------------

describe("D7 handshake selection (Rust, through the broker port)", () => {
  const port = createWasmDeviceBrokerFactory({ poolBytes: null });
  const hello = {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "permission.query", versions: [1, 2] },
    ],
  };

  test("duplicate server entries: the first wins, never merged", () => {
    const { ack } = port.negotiate(JSON.stringify(hello), true, [
      { name: "core.capabilities", versions: [1] },
      { name: "permission.query", versions: [2] }, // not a registry revision
      { name: "permission.query", versions: [1] }, // ignored (a duplicate)
    ]);
    expect(ack?.capabilities).toEqual([{ name: "core.capabilities", version: 1 }]);
  });

  test("the hello is validated first: a duplicate name disables device", () => {
    const outcome = port.negotiate(
      JSON.stringify({ ...hello, capabilities: [...hello.capabilities, { name: "permission.query", versions: [1] }] }),
      true,
      [{ name: "core.capabilities", versions: [1] }]
    );
    expect(outcome.ack).toBeNull();
    expect(outcome.reason).toContain("duplicate");
    const zero = port.negotiate(JSON.stringify({ ...hello, protocolVersions: [0, 1] }), true);
    expect(zero.ack).toBeNull();
    expect(zero.reason).toStartWith("invalid hello.device");
  });
});

// ---------------------------------------------------------------------------
// D1 — Origin is browser-only; native clients authenticate
// ---------------------------------------------------------------------------

describe("D1 upgrade admission (Bun)", () => {
  const counter = app.defineState({ count: 0 }).build();
  const upgradeHeaders = {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
  };
  const boundPort = (server: RemoteServer) => (server as unknown as { server: { port: number } }).server.port;
  const authenticate = (req: Request) => req.headers.get("authorization") === "Bearer ok";

  test("allowlist + authenticator: native (no Origin) clients authenticate; the authenticator also runs for browsers", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"], authenticate, webClient: false });
    await server.listen(0);
    const url = `http://127.0.0.1:${boundPort(server)}/`;
    try {
      const status = async (h: Record<string, string>) => (await fetch(url, { headers: { ...upgradeHeaders, ...h } })).status;
      expect(await status({})).toBe(403); // native, no credentials
      expect(await status({ Authorization: "Bearer ok" })).toBe(101); // native, authenticated
      expect(await status({ Origin: "http://app.example" })).toBe(403); // browser, not authenticated
      expect(await status({ Origin: "http://app.example", Authorization: "Bearer ok" })).toBe(101);
      expect(await status({ Origin: "http://evil.example", Authorization: "Bearer ok" })).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("authenticator only (native-only deployment): the authenticator decides, whatever the Origin", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ authenticate, webClient: false });
    await server.listen(0);
    const url = `http://127.0.0.1:${boundPort(server)}/`;
    try {
      const status = async (h: Record<string, string>) => (await fetch(url, { headers: { ...upgradeHeaders, ...h } })).status;
      expect(await status({ Authorization: "Bearer ok" })).toBe(101);
      expect(await status({})).toBe(403);
      // No allowlist configured: Origin is not checked, the authenticator is.
      expect(await status({ Origin: "http://app.example", Authorization: "Bearer ok" })).toBe(101);
      expect(await status({ Origin: "http://app.example" })).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("neither allowlist nor authenticator: the server starts and admits every client", async () => {
    const server = new RemoteServer().module("Counter", counter).ui('Text("hi")').config({ webClient: false });
    await server.listen(0);
    const url = `http://127.0.0.1:${boundPort(server)}/`;
    try {
      const status = async (h: Record<string, string>) => (await fetch(url, { headers: { ...upgradeHeaders, ...h } })).status;
      expect(await status({})).toBe(101);
      expect(await status({ Origin: "http://any.example" })).toBe(101);
    } finally {
      server.stop();
    }
  });

  test("admitUpgrade: enforced exactly when configured, fail closed, authenticator errors refuse", async () => {
    const req = (h: Record<string, string> = {}) => new Request("http://x/", { headers: h });
    const allow = new Set(["http://app.example"]);
    expect(await admitUpgrade(req(), { allowedOrigins: allow })).not.toBeNull();
    expect(await admitUpgrade(req(), { allowedOrigins: null })).toBeNull();
    expect(await admitUpgrade(req({ Origin: "http://any" }), { allowedOrigins: null })).toBeNull();
    expect((await admitUpgrade(req({ Origin: "http://evil" }), { allowedOrigins: allow }))?.status).toBe(403);
    const throwing = () => {
      throw new Error("boom");
    };
    expect(
      (await admitUpgrade(req({ Origin: "http://app.example" }), { allowedOrigins: allow, authenticate: throwing }))?.status
    ).toBe(403);
    expect(
      await admitUpgrade(req({ Origin: "http://APP.example:80" }), { allowedOrigins: allow, authenticate: async () => true })
    ).toBeNull();
  });
});
