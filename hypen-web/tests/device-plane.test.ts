/**
 * The TypeScript host driver of the Rust device broker (RFC 001, round 4):
 * `DevicePlane` over the WASM-free `DeviceBrokerPort`, the WASM-backed
 * factories that `@hypen-space/server` and `@hypen-space/cf` supply, and the
 * RemoteSession wiring (text route, fail-closed admission). Everything
 * protocol-side is the Rust broker's (see the other device-* suites, which
 * all run against it); these tests pin the driver's own contracts.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import {
  DEFAULT_PROCESS_RETAINED_BYTES,
  DeviceContext,
  DevicePlane,
  type DeviceBrokerPort,
} from "@hypen-space/core/remote/device";
import { createWasmDeviceBrokerFactory, WasmRetainedBytesPool } from "../packages/server/src/device-broker";
import { createCFDeviceBrokerFactory, hasDeviceBroker } from "../packages/cf/src/index";
import * as nodeWasm from "../packages/server/wasm-node/hypen_engine.js";
import { deviceHello, flush, fullAck, makeHost, makePlane, spec } from "./device-srv-harness";

const owner = { moduleInstanceId: "m1", activationId: 1 };

describe("DevicePlane: the handler API never throws", () => {
  test("a spec the broker cannot parse settles `internal` instead of throwing", async () => {
    const errors: string[] = [];
    const factory = createWasmDeviceBrokerFactory({ poolBytes: null });
    const plane = new DevicePlane(factory({ ack: fullAck() }, 0), { sendText: () => {}, closeConnection: () => {} }, {
      onError: (what) => errors.push(what),
    });
    plane.start();
    plane.ownerActivated("m1", 1);
    // A negative timeout is a host bug (the broker takes u64 ms).
    const r = plane.open(spec("permission.query", { permission: "camera" }, { timeoutMs: -1 }));
    expect(r.id).toBeNull();
    expect(await r.settled).toMatchObject({ error: { code: "internal", platformDetail: expect.stringMatching(/invalid device open spec/) } });
    expect(errors).toEqual(["device open"]);
    plane.close();
  });

  test("DeviceContext sanitizes numbers before they reach the broker", async () => {
    const h = makePlane();
    const ctx = new DeviceContext(h.plane, owner, "origin");
    void ctx.request("permission.query", { permission: "camera" }, { timeoutMs: 1.7 });
    void ctx.request("permission.query", { permission: "camera" }, { timeoutMs: Number.POSITIVE_INFINITY });
    void ctx.request("permission.query", { permission: "camera" }, { timeoutMs: Number.NaN });
    void ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, { initialCredit: 4096.9 });
    const reqs = h.sent.filter((m) => m.type === "deviceRequest" && m.capability !== "core.capabilities");
    expect(reqs.map((r) => r.timeoutMs)).toEqual([1, 30_000, 30_000, 300_000]);
    expect(reqs[3].initialCredit).toBe(4096);
  });

  test("a params refusal names the offending paths (the broker decided; TS explains)", async () => {
    const h = makePlane();
    const before = h.sent.length;
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const res = await ctx.requestUntyped("permission.query", { permission: "camra" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalidParams", platformDetail: expect.stringMatching(/permission/) } });
    // Refusals the broker makes before params keep the broker's own detail.
    const bg = await ctx.requestUntyped("permission.query", { permission: "camra" }, { lifetime: "background" });
    expect(bg).toEqual({
      ok: false,
      error: { code: "unsupported", platformDetail: 'lifetime "background" is not allowed by permission.query v1' },
    });
    expect(h.sent.length).toBe(before);
  });
});

describe("DevicePlane: outputs in broker order, reentrancy", () => {
  test("a consumer that opens another request from inside onEvent is handled in order", async () => {
    const h = makePlane();
    const opened: Array<number | null> = [];
    const scan = h.plane.open(
      spec("bluetooth.scan", {}, {
        initialCredit: 4,
        onEvent: () => {
          // Reentrant: the plane is dispatching this event right now.
          opened.push(h.plane.open(spec("permission.query", { permission: "camera" })).id);
        },
      })
    );
    h.receive({ type: "deviceEvent", id: scan.id, event: { device: { id: "a", rssi: -40 } } });
    h.receive({ type: "deviceEvent", id: scan.id, event: { device: { id: "b", rssi: -41 } } });
    expect(opened).toEqual([scan.id! + 1, scan.id! + 2]);
    const requestIds = h.sent.filter((m) => m.type === "deviceRequest").map((m) => m.id);
    expect(requestIds).toEqual([h.core, scan.id, scan.id! + 1, scan.id! + 2]);
    // Every event was consumed synchronously: credit went back (batched).
    const grants = h.sent.filter((m) => m.id === scan.id && m.control?.grant).map((m) => m.control.grant);
    expect(grants.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  });

  test("closing from inside a sink call still settles everything and releases the broker once", async () => {
    let plane!: DevicePlane;
    let frees = 0;
    const factory = createWasmDeviceBrokerFactory({ poolBytes: null });
    const inner = factory({ ack: fullAck() }, 0);
    const port: DeviceBrokerPort = new Proxy(inner, {
      get(target, prop) {
        if (prop === "free") {
          return () => {
            frees += 1;
            target.free();
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    let closedFromSink = false;
    plane = new DevicePlane(port, {
      sendText: (text) => {
        if (!closedFromSink && JSON.parse(text).capability === "gallery.pick") {
          closedFromSink = true;
          plane.close(); // e.g. the socket write failed and the host tears down
        }
      },
      closeConnection: () => {},
    });
    plane.start();
    plane.ownerActivated("m1", 1);
    const r = plane.open(spec("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
    expect(await r.settled).toEqual({ error: { code: "connectionLost" } });
    expect(plane.isClosed).toBe(true);
    expect(frees).toBe(1);
    plane.close();
    expect(frees).toBe(1);
    expect(plane.info()).toBeNull();
    expect(plane.liveCount).toBe(0);
    expect(plane.supports("gallery.pick")).toBe(false);
  });
});

describe("WASM-backed factories", () => {
  test("server: one process-wide pool by default; `poolBytes: null` shares none; an explicit pool is reused", () => {
    const def = createWasmDeviceBrokerFactory();
    expect(def.pool?.limit).toBe(DEFAULT_PROCESS_RETAINED_BYTES);
    expect(createWasmDeviceBrokerFactory({ poolBytes: null }).pool).toBeNull();
    const shared = new WasmRetainedBytesPool(4096);
    const a = createWasmDeviceBrokerFactory({ pool: shared });
    const b = createWasmDeviceBrokerFactory({ pool: shared });
    expect(a.pool).toBe(shared);
    expect(b.pool).toBe(shared);
    // Both factories' brokers charge the same pool.
    for (const f of [a, b]) {
      const port = f({ ack: fullAck(), maxRetainedBytes: 4096 }, 0);
      port.start(0);
      port.ownerActivated("m", 1, 0);
      const r = port.open({ capability: "gallery.pick", params: { mediaTypes: ["photo"], maxCount: 1 }, moduleInstanceId: "m", activationId: 1 }, 0);
      port.onText(
        JSON.stringify({ type: "deviceEvent", id: r.id, event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 3000 } }),
        0
      );
      port.poll();
    }
    expect(shared.inUse()).toBe(3000); // the second declaration did not fit the 4 KiB pool
  });

  test("cf: the factory needs the device-broker exports; its pool is created lazily and shared", () => {
    expect(hasDeviceBroker(nodeWasm)).toBe(true);
    expect(hasDeviceBroker({ WasmEngine: class {} })).toBe(false);
    expect(hasDeviceBroker(undefined)).toBe(false);
    const factory = createCFDeviceBrokerFactory(nodeWasm, 2048);
    const ports = [factory({ ack: fullAck() }, 0), factory({ ack: fullAck() }, 0)];
    for (const port of ports) {
      port.start(0);
      port.ownerActivated("m", 1, 0);
      const r = port.open({ capability: "gallery.pick", params: { mediaTypes: ["photo"], maxCount: 1 }, moduleInstanceId: "m", activationId: 1 }, 0);
      port.onText(
        JSON.stringify({ type: "deviceEvent", id: r.id, event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 1500 } }),
        0
      );
    }
    expect(ports[0]!.retainedBytes).toBe(1500);
    expect(ports[1]!.retainedBytes).toBe(0); // 1500 + 1500 > the shared 2 KiB pool
    for (const p of ports) p.free();
  });

  test("both factories negotiate through the Rust handshake (no TS selection code)", () => {
    // Without the handshake export a glue is not a device-broker build.
    const { deviceHandshake: _h, ...noHandshake } = nodeWasm as Record<string, unknown>;
    expect(hasDeviceBroker(noHandshake)).toBe(false);

    const hello = JSON.stringify({
      protocolVersions: [1],
      binary: true,
      capabilities: [
        { name: "core.capabilities", versions: [1] },
        { name: "gallery.pick", versions: [1] },
      ],
    });
    for (const factory of [createWasmDeviceBrokerFactory({ poolBytes: null }), createCFDeviceBrokerFactory(nodeWasm, 2048)]) {
      // Default advertisement: everything the broker consumes.
      expect(factory.negotiate(hello, true)).toEqual({
        ack: {
          protocolVersion: 1,
          binary: true,
          capabilities: [
            { name: "core.capabilities", version: 1 },
            { name: "gallery.pick", version: 1 },
          ],
        },
      });
      // No binary route: binary revisions are not selectable (rule c).
      expect(factory.negotiate(hello, false).ack?.capabilities).toEqual([{ name: "core.capabilities", version: 1 }]);
      // An explicit advertisement replaces the default.
      expect(
        factory.negotiate(hello, true, [{ name: "core.capabilities", versions: [1] }]).ack?.capabilities
      ).toEqual([{ name: "core.capabilities", version: 1 }]);
      // Judged on the raw text as sent: a duplicate key disables the plane (D7), with a reason.
      const dup = factory.negotiate(`{"protocolVersions":[1],"protocolVersions":[1],"binary":true,"capabilities":[]}`, true);
      expect(dup.ack).toBeNull();
      expect(dup.reason).toStartWith("invalid hello.device");
      // Valid but without core.capabilities@1: disabled, with a reason.
      const noCore = factory.negotiate(JSON.stringify({ protocolVersions: [1], binary: true, capabilities: [] }), true);
      expect(noCore.ack).toBeNull();
      expect(noCore.reason).toContain("core.capabilities@1");
      // A malformed advertisement is a host error.
      expect(() => factory.negotiate(hello, true, "nope" as any)).toThrow();
    }
  });
});

describe("RemoteSession wiring", () => {
  test("broker text goes out verbatim on sendDeviceText (no parse/stringify round trip)", async () => {
    const texts: string[] = [];
    const objects: unknown[] = [];
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const session = new RemoteSession(
      makeHost(module),
      {
        send: () => {},
        sendDevice: (m) => objects.push(m),
        sendDeviceText: (t) => texts.push(t),
        sendBinary: () => {},
        close: () => {},
      },
      { helloGraceMs: null }
    );
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(objects).toEqual([]);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(texts[0]!)).toMatchObject({ type: "deviceRequest", capability: "core.capabilities", id: 1 });
    await session.destroy();
  });

  test("the primary module's live activation is registered with the broker; destroy ends it", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const session = new RemoteSession(
      makeHost(module),
      { send: () => {}, sendDevice: () => {}, sendBinary: () => {}, close: () => {} },
      { helloGraceMs: null }
    );
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    const plane = session.deviceBroker!;
    const mi = session.moduleInstance!.deviceInstanceId;
    expect(plane.ownerIsActive(mi, 1)).toBe(true);
    await session.moduleInstance!.deactivate();
    expect(plane.ownerIsActive(mi, 1)).toBe(false);
    await session.moduleInstance!.activate();
    expect(plane.ownerIsActive(mi, 2)).toBe(true);
    await session.destroy();
    expect(plane.isClosed).toBe(true);
  });
});
