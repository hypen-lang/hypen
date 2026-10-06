/**
 * Device plane — broker creation / start failure in RemoteSession (RFC 001
 * §2.2 / §2.5).
 *
 * A `sessionAck.device` is only ever sent when a broker actually stands
 * behind it: the broker is built BEFORE the ack. When the host's factory
 * throws (or the Rust broker rejects its config) the ack omits `device`, the
 * socket stays up for UI-only operation, and handlers see `unavailable`.
 * When the broker exists but cannot open `core.capabilities`, the advertised
 * plane is torn down with a 1012 reset (a device-enabled socket never
 * survives without its broker). A built-but-unstarted broker is released if
 * the ack itself cannot be sent.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import type {
  DeviceBrokerConfig,
  DeviceBrokerFactory,
  DeviceBrokerPort,
  DeviceResult,
} from "@hypen-space/core/remote/device";
import { createWasmDeviceBrokerFactory } from "../packages/server/src/device-broker";
import { deviceHello, flush, makeHost, makeTransport } from "./device-srv-harness";

type Probe = { result: DeviceResult<unknown> | null; supports: boolean | null };

function probeModule(probe: Probe): SessionHost["module"] {
  return app
    .defineState({ n: 0 })
    .onAction("probe", async ({ context }) => {
      probe.supports = context!.device.supports("gallery.pick");
      probe.result = await context!.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    })
    .build() as unknown as SessionHost["module"];
}

type CreateBroker = (config: DeviceBrokerConfig, nowMs: number) => DeviceBrokerPort;

/** The real (Rust) handshake, shared by every test factory below. */
const REAL = createWasmDeviceBrokerFactory({ poolBytes: null });

function hostWith(
  module: SessionHost["module"],
  create: CreateBroker,
  negotiate: DeviceBrokerFactory["negotiate"] = REAL.negotiate
): SessionHost {
  const factory: DeviceBrokerFactory = Object.assign((config: DeviceBrokerConfig, nowMs: number) => create(config, nowMs), {
    negotiate,
  });
  return { ...makeHost(module), deviceBrokerFactory: factory };
}

/** A real WASM factory whose ports record `free()` and can refuse `start`. */
function spyingFactory(opts: { refuseStart?: boolean } = {}) {
  const real = createWasmDeviceBrokerFactory();
  const ports: Array<{ freed: boolean; started: boolean }> = [];
  const factory: CreateBroker = (config, nowMs) => {
    const port = real(config, nowMs);
    const rec = { freed: false, started: false };
    ports.push(rec);
    return new Proxy(port, {
      get(target, prop, receiver) {
        if (prop === "free") {
          return () => {
            rec.freed = true;
            target.free();
          };
        }
        if (prop === "start") {
          return (now: number) => {
            rec.started = true;
            if (opts.refuseStart) return { error: { code: "internal", detail: "test: start refused" } };
            return target.start(now);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as DeviceBrokerPort;
  };
  return { factory, ports };
}

async function expectUiOnly(session: RemoteSession, t: ReturnType<typeof makeTransport>, probe: Probe) {
  const ack = t.ui.find((m) => m.type === "sessionAck") as any;
  expect(ack).toBeDefined();
  expect(ack.device).toBeUndefined();
  expect(session.deviceBroker).toBeNull();
  expect(t.device.length).toBe(0);
  expect(t.binary.length).toBe(0);
  expect(t.closes).toEqual([]);
  // UI-only operation continues: the initial tree was delivered.
  expect(t.ui.some((m) => m.type === "initialTree")).toBe(true);
  // Handlers see a disabled plane, and nothing reaches the device route.
  await session.receive(JSON.stringify({ type: "dispatchAction", action: "probe" }));
  for (let i = 0; i < 20 && probe.result === null; i++) await flush();
  expect(probe.supports).toBe(false);
  expect(probe.result).toEqual({ ok: false, error: { code: "unavailable", platformDetail: "device-disabled" } });
  expect(t.device.length).toBe(0);
}

describe("broker creation failure never leaves an advertised plane without a broker", () => {
  test("a throwing broker factory: the ack omits device, the socket stays open for UI", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    let calls = 0;
    const session = new RemoteSession(
      hostWith(probeModule(probe), () => {
        calls++;
        throw new Error("factory exploded");
      }),
      t.transport,
      { helloGraceMs: null }
    );
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(calls).toBe(1);
    await expectUiOnly(session, t, probe);
    await session.destroy();
  });

  test("a config the Rust broker rejects: the ack omits device (real WASM factory)", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    const session = new RemoteSession(makeHost(probeModule(probe)), t.transport, {
      helloGraceMs: null,
      // An unknown limit key: the Rust config decoder is strict and refuses it.
      deviceBrokerConfig: { bogusLimit: 1 } as any,
    });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    await expectUiOnly(session, t, probe);
    await session.destroy();
  });

  test("the same session with a valid config does negotiate (control for the test above)", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    const session = new RemoteSession(makeHost(probeModule(probe)), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    const ack = t.ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toBeDefined();
    expect(session.deviceBroker).not.toBeNull();
    expect((t.device[0] as any).capability).toBe("core.capabilities");
    await session.destroy();
  });

  test("a throwing negotiation (the port's Rust handshake): the ack omits device, no broker is built", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    let built = 0;
    const session = new RemoteSession(
      hostWith(
        probeModule(probe),
        (config, now) => {
          built++;
          return REAL(config, now);
        },
        () => {
          throw new Error("negotiation exploded");
        }
      ),
      t.transport,
      { helloGraceMs: null }
    );
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(built).toBe(0);
    await expectUiOnly(session, t, probe);
    await session.destroy();
  });

  test("the port's negotiation decides: a refusal (with a reason) disables the plane, no broker is built", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    let built = 0;
    const seen: string[] = [];
    const session = new RemoteSession(
      hostWith(
        probeModule(probe),
        (config, now) => {
          built++;
          return REAL(config, now);
        },
        (helloText, binaryRoute, caps) => {
          // The session hands over the raw hello.device text as sent.
          seen.push(helloText);
          expect(binaryRoute).toBe(true);
          expect(caps?.some((c) => c.name === "core.capabilities")).toBe(true);
          return { ack: null, reason: "test: refused" };
        }
      ),
      t.transport,
      { helloGraceMs: null }
    );
    const hello = deviceHello();
    await session.receive(JSON.stringify(hello));
    await session.ready;
    await flush();
    expect(seen).toEqual([JSON.stringify((hello as any).device)]);
    expect(built).toBe(0);
    await expectUiOnly(session, t, probe);
    await session.destroy();
  });

  test("a factory without negotiate() (no Rust handshake) is refused: UI-only, no broker built", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    let built = 0;
    const legacy = ((config: DeviceBrokerConfig, now: number) => {
      built++;
      return REAL(config, now);
    }) as unknown as DeviceBrokerFactory;
    const session = new RemoteSession({ ...makeHost(probeModule(probe)), deviceBrokerFactory: legacy }, t.transport, {
      helloGraceMs: null,
    });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(built).toBe(0);
    await expectUiOnly(session, t, probe);
    await session.destroy();
  });

  test("a late device hello on a grace session: the re-ack omits device when the factory throws", async () => {
    const probe: Probe = { result: null, supports: null };
    const t = makeTransport();
    const session = new RemoteSession(
      hostWith(probeModule(probe), () => {
        throw new Error("factory exploded");
      }),
      t.transport,
      { helloGraceMs: 5 }
    );
    await session.ready;
    await session.receive(JSON.stringify(deviceHello()));
    await flush();
    const acks = t.ui.filter((m) => m.type === "sessionAck") as any[];
    expect(acks.length).toBe(2);
    expect(acks[1].device).toBeUndefined();
    expect(acks[1].sessionId).toBe(acks[0].sessionId);
    expect(session.deviceBroker).toBeNull();
    expect(t.device.length).toBe(0);
    expect(t.closes).toEqual([]);
    await session.destroy();
  });

  test("a broker is built before the ack and started after it", async () => {
    const order: string[] = [];
    const { factory } = spyingFactory();
    const t = makeTransport();
    const host = hostWith(app.defineState({}).build() as unknown as SessionHost["module"], (config, now) => {
      order.push(`build(ackSent=${t.ui.some((m) => m.type === "sessionAck")})`);
      return factory(config, now);
    });
    const transport = {
      ...t.transport,
      sendDevice: (m: any) => {
        if (m.type === "deviceRequest") order.push(`device:${m.capability ?? m.type}(ackSent=${t.ui.some((x) => x.type === "sessionAck")})`);
        t.transport.sendDevice!(m);
      },
    };
    const session = new RemoteSession(host, transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(order).toEqual(["build(ackSent=false)", "device:core.capabilities(ackSent=true)"]);
    await session.destroy();
  });

  test("a built broker is released when session setup throws before it starts", async () => {
    const { factory, ports } = spyingFactory();
    const t = makeTransport();
    const session = new RemoteSession(
      hostWith(app.defineState({}).build() as unknown as SessionHost["module"], factory),
      t.transport,
      { helloGraceMs: null }
    );
    // Primary-module registration fails between the ack and the plane start.
    (session as any)._globalContext.registerModule = () => {
      throw new Error("registration failed");
    };
    // RemoteSession.receive logs handler errors instead of rejecting.
    await session.receive(JSON.stringify(deviceHello()));
    await flush();
    expect(t.ui.some((m) => m.type === "initialTree")).toBe(false);
    expect(ports.length).toBe(1);
    expect(ports[0]!.started).toBe(false);
    expect(ports[0]!.freed).toBe(true);
    expect(session.deviceBroker).toBeNull();
    expect(t.device.length).toBe(0);
    await session.destroy();
  });

  test("a broker that cannot open core.capabilities resets the advertised plane (1012)", async () => {
    const { factory, ports } = spyingFactory({ refuseStart: true });
    const t = makeTransport();
    const session = new RemoteSession(
      hostWith(app.defineState({}).build() as unknown as SessionHost["module"], factory),
      t.transport,
      { helloGraceMs: null }
    );
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    const ack = t.ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toBeDefined();
    expect(ports[0]!.started).toBe(true);
    expect(ports[0]!.freed).toBe(true);
    expect(session.deviceBroker).toBeNull();
    expect(t.closes.length).toBe(1);
    expect(t.closes[0]!.code).toBe(1012);
    await session.destroy();
  });
});
