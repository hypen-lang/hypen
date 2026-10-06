/**
 * Device Capability Protocol — RemoteSession integration (RFC 001 §6 Phase 2).
 *
 * Drives a real RemoteSession + HypenModuleInstance with a fake wasm engine
 * that actually invokes registered action handlers, so `context.device` is
 * exercised through the genuine handler-context path:
 *
 *   hello(device) → sessionAck.device → broker attached → core.capabilities
 *   opened → handler request → exactly one deviceRequest on THIS transport
 *   → deviceResponse settles it → destroy() rejects in-flight connectionLost.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import {
  RemoteSession,
  SessionManager,
  type SessionHost,
  type SessionTransport,
  type OutgoingMessage,
  type DeviceOutgoing,
} from "@hypen-space/core/remote";
import { BaseEngine } from "@hypen-space/core/engine-base";
import type { DeviceResult } from "@hypen-space/core/remote/device";
import { createWasmDeviceBrokerFactory } from "../packages/server/src/device-broker";

/** Fake wasm engine that stores action handlers and invokes them on dispatch. */
class HandlerFakeEngine extends BaseEngine {
  readonly handlers = new Map<string, (action: unknown) => void>();
  async init(): Promise<void> {
    const self = this;
    this.wasmEngine = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "onAction") {
            return (name: string, h: (a: unknown) => void) => self.handlers.set(name, h);
          }
          if (prop === "dispatchAction") {
            return (name: string, payload: unknown) => {
              for (const [key, h] of self.handlers) {
                if (key === name || key.endsWith(`:${name}`)) h({ name, payload });
              }
            };
          }
          if (prop === "discoverRouters") return () => [];
          return () => {};
        },
      }
    );
    this.initialized = true;
  }
  protected unwrapForWasm<T>(value: T): T {
    return value;
  }
}

/** Transport that records UI messages and device messages on separate routes. */
function makeTransport() {
  const ui: OutgoingMessage[] = [];
  const device: DeviceOutgoing[] = [];
  const binary: Uint8Array[] = [];
  const transport: SessionTransport = {
    send: (m) => ui.push(m),
    sendDevice: (m) => device.push(m),
    sendBinary: (f) => binary.push(f),
    close: () => {},
  };
  return { transport, ui, device, binary };
}

function makeHost(
  module: SessionHost["module"],
  opts: { deviceDisabled?: boolean; syncActions?: boolean; deviceBroker?: boolean } = {}
): SessionHost {
  return {
    module,
    moduleName: "Test",
    ui: 'Text("hi")',
    resources: {},
    app: null,
    syncActions: opts.syncActions ?? false,
    // Device plane on by default: no switch unless the test opts out.
    ...(opts.deviceDisabled ? { deviceDisabled: true } : {}),
    // The Rust device broker (wasm-node), as RemoteServer supplies it.
    ...(opts.deviceBroker === false ? {} : { deviceBrokerFactory: createWasmDeviceBrokerFactory() }),
    sessionManager: new SessionManager(),
    discoveredComponents: new Map(),
    createEngine: () => new HandlerFakeEngine(),
    otherSessions: () => [],
    sessionsForId: () => [],
    onSessionReady: () => {},
    onSessionDestroyed: () => {},
  };
}

const hello = {
  type: "hello" as const,
  device: {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "gallery.pick", versions: [1] },
    ],
  },
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("device handshake through RemoteSession", () => {
  test("hello.device → sessionAck.device with the selected intersection; core.capabilities opens", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const { transport, ui, device } = makeTransport();
    const session = new RemoteSession(makeHost(module), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    await flush();

    const ack = ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toEqual({
      protocolVersion: 1,
      binary: true,
      capabilities: [
        { name: "core.capabilities", version: 1 },
        { name: "gallery.pick", version: 1 },
      ],
    });
    const requests = device.filter((m) => m.type === "deviceRequest") as any[];
    expect(requests.length).toBe(1);
    expect(requests[0].capability).toBe("core.capabilities");
    expect(requests[0].owner).toEqual({ connection: true });
    expect(session.deviceBroker).not.toBeNull();
    await session.destroy();
  });

  test("a host that opts out (deviceDisabled) never advertises, even when the client offers", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const { transport, ui, device } = makeTransport();
    const session = new RemoteSession(makeHost(module, { deviceDisabled: true }), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    const ack = ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toBeUndefined();
    expect(device.length).toBe(0);
    expect(session.deviceBroker).toBeNull();
    await session.destroy();
  });

  test("a host that supplies no device broker never advertises (fail closed)", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const { transport, ui, device } = makeTransport();
    const session = new RemoteSession(makeHost(module, { deviceBroker: false }), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    const ack = ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toBeUndefined();
    expect(device.length).toBe(0);
    expect(session.deviceBroker).toBeNull();
    await session.destroy();
  });

  test("syncActions keeps the device plane (replay provenance is the firewall, not admission)", async () => {
    const module = app.defineState({}).build() as unknown as SessionHost["module"];
    const { transport, ui } = makeTransport();
    const session = new RemoteSession(makeHost(module, { syncActions: true }), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    const ack = ui.find((m) => m.type === "sessionAck") as any;
    expect(ack.device).toBeDefined();
    expect(session.deviceBroker).not.toBeNull();
    await session.destroy();
  });

  test("syncActions: the originating session's request goes out; the replayed one is refused", async () => {
    const results: DeviceResult<unknown>[] = [];
    const module = app
      .defineState({})
      .onAction("pick", async ({ context }) => {
        results.push(await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
      })
      .build() as unknown as SessionHost["module"];
    const sessions: RemoteSession[] = [];
    const a = makeTransport();
    const b = makeTransport();
    const host = {
      ...makeHost(module, { syncActions: true }),
      otherSessions: (self: RemoteSession) => sessions.filter((s) => s !== self),
    };
    sessions.push(new RemoteSession(host, a.transport, { helloGraceMs: null }));
    sessions.push(new RemoteSession(host, b.transport, { helloGraceMs: null }));
    for (const s of sessions) {
      await s.receive(hello);
      await s.ready;
    }
    await flush();
    expect(sessions.every((s) => s.deviceBroker !== null)).toBe(true);
    const picks = (t: ReturnType<typeof makeTransport>) =>
      t.device.filter((m: any) => m.type === "deviceRequest" && m.capability === "gallery.pick") as any[];

    await sessions[0]!.receive({ type: "dispatchAction", module: "Test", action: "pick" });
    await flush();
    expect(results).toEqual([{ ok: false, error: { code: "unavailable", platformDetail: "syncActions.replay" } }]);
    expect(picks(b)).toHaveLength(0);
    expect(picks(a)).toHaveLength(1);
    await sessions[0]!.receive({ type: "deviceResponse", id: picks(a)[0].id, result: { items: [] } });
    await flush();
    expect(results[1]).toEqual({ ok: true, value: { items: [] } });
    for (const s of sessions) await s.destroy();
  });
});

describe("context.device through a real action handler", () => {
  test("one handler request → exactly one deviceRequest on this transport; response settles it", async () => {
    let result: DeviceResult<unknown> | null = null;
    const module = app
      .defineState({ done: false })
      .onAction("pick", async ({ context }) => {
        result = await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
      })
      .build() as unknown as SessionHost["module"];

    const { transport, device } = makeTransport();
    const session = new RemoteSession(makeHost(module), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    await flush();
    const before = device.filter((m) => m.type === "deviceRequest").length; // core.capabilities

    await session.receive({ type: "dispatchAction", module: "Test", action: "pick" });
    await flush();

    const requests = device.filter((m) => m.type === "deviceRequest") as any[];
    expect(requests.length).toBe(before + 1);
    const req = requests[requests.length - 1];
    expect(req.capability).toBe("gallery.pick");
    expect(req.lifetime).toBe("activation");
    // Opaque random owner id: no module name, no process-wide counter (#10).
    expect(req.owner.moduleInstanceId).toMatch(/^mi-[0-9a-f-]{36}$/);
    expect(req.owner.activationId).toBe(1); // primary was activated once

    // Client answers with a denial; the handler's await resolves to a value.
    await session.receive({ type: "deviceResponse", id: req.id, error: { code: "denied" } } as any);
    await flush();
    expect(result).toEqual({ ok: false, error: { code: "denied" } });
    await session.destroy();
  });

  test("pre-hello dispatchAction is rejected — the handler never runs", async () => {
    let ran = 0;
    const module = app
      .defineState({})
      .onAction("pick", async () => {
        ran += 1;
      })
      .build() as unknown as SessionHost["module"];
    const { transport } = makeTransport();
    const session = new RemoteSession(makeHost(module), transport, { helloGraceMs: null });
    await session.receive({ type: "dispatchAction", module: "Test", action: "pick" });
    await flush();
    expect(ran).toBe(0);
    await session.destroy();
  });

  test("without a device plane, context.device.request is an unavailable value (no throw)", async () => {
    let result: DeviceResult<unknown> | null = null;
    const module = app
      .defineState({})
      .onAction("pick", async ({ context }) => {
        result = await context.device.request("gallery.pick", {});
      })
      .build() as unknown as SessionHost["module"];
    const { transport } = makeTransport();
    const session = new RemoteSession(makeHost(module, { deviceDisabled: true }), transport, { helloGraceMs: null });
    await session.receive({ type: "hello" });
    await session.ready;
    await session.receive({ type: "dispatchAction", module: "Test", action: "pick" });
    await flush();
    expect(result).toEqual({ ok: false, error: { code: "unavailable", platformDetail: "device-disabled" } });
    await session.destroy();
  });

  test("destroy() rejects in-flight device work with connectionLost (broker loss == reset)", async () => {
    let result: DeviceResult<unknown> | null = null;
    const module = app
      .defineState({})
      .onAction("pick", async ({ context }) => {
        result = await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
      })
      .build() as unknown as SessionHost["module"];
    const { transport } = makeTransport();
    const session = new RemoteSession(makeHost(module), transport, { helloGraceMs: null });
    await session.receive(hello);
    await session.ready;
    await session.receive({ type: "dispatchAction", module: "Test", action: "pick" });
    await flush();
    expect(result).toBeNull(); // still awaiting the device
    await session.destroy();
    await flush();
    expect(result).toEqual({ ok: false, error: { code: "connectionLost" } });
  });
});
