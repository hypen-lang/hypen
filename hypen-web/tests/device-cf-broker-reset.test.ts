/**
 * RFC 001 §2.5 "loss of broker state is a connection reset" — Cloudflare
 * Durable Object adapter.
 *
 * The DO records a `deviceEnabled` marker in the hibernation attachment
 * before the `sessionAck` that selects a device plane leaves. When the DO
 * wakes (fresh instance, empty session map) and a marked socket delivers a
 * message, the adapter closes it with 1012 before processing anything — no
 * synthesised hello, no rebuilt broker, no dispatch. Unmarked (UI-only)
 * sockets keep the existing transparent restoration path.
 *
 * Exercised like `cf-hibernation.test.ts`: a real WASM engine, the DO driven
 * directly through `webSocketMessage`, and in-memory workerd stand-ins.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  HypenDurableObject,
  CFTransport,
  DEVICE_BROKER_LOST_CODE,
  DEVICE_BROKER_LOST_REASON,
  type HypenDurableObjectConfig,
} from "../packages/cf/src/index";
import { Engine } from "../packages/server/src/engine";
import * as nodeWasm from "../packages/server/wasm-node/hypen_engine.js";
import { app } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";

// ---------------------------------------------------------------------------
// workerd stand-ins
// ---------------------------------------------------------------------------

function createStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return data.get(key); },
    async put(key: string, value: unknown) { data.set(key, value); },
    async delete(key: string) { return data.delete(key); },
  };
}

type Event =
  | { kind: "send"; data: string | Uint8Array }
  | { kind: "attach"; value: unknown }
  | { kind: "close"; code?: number; reason?: string };

function createSocket(opts: { attachments?: boolean; failDeviceMarker?: boolean } = {}) {
  const events: Event[] = [];
  let attachment: unknown;
  let closed: { code?: number; reason?: string } | null = null;
  const ws: Record<string, unknown> = {
    events,
    get closed() { return closed; },
    send: (data: string | Uint8Array) => events.push({ kind: "send", data }),
    close: (code?: number, reason?: string) => {
      closed = { code, reason };
      events.push({ kind: "close", code, reason });
    },
    readyState: 1,
  };
  if (opts.attachments !== false) {
    ws.serializeAttachment = (value: unknown) => {
      if (opts.failDeviceMarker && (value as { deviceEnabled?: boolean })?.deviceEnabled) {
        throw new Error("attachment too large");
      }
      attachment = structuredClone(value);
      events.push({ kind: "attach", value: structuredClone(value) });
    };
    ws.deserializeAttachment = () => structuredClone(attachment);
  }
  return ws as typeof ws & {
    events: Event[];
    closed: { code?: number; reason?: string } | null;
    deserializeAttachment?: () => unknown;
  };
}

type Socket = ReturnType<typeof createSocket>;
const asWs = (s: Socket) => s as unknown as WebSocket;

function jsonFrames(s: Socket): any[] {
  return s.events
    .filter((e): e is { kind: "send"; data: string } => e.kind === "send" && typeof e.data === "string")
    .map((e) => JSON.parse(e.data));
}

function createCtx(storage = createStorage()) {
  const sockets: WebSocket[] = [];
  return {
    storage,
    acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  };
}

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

/** Counts action dispatches across DO incarnations. */
let incCalls = 0;

function makeConfig(overrides: Partial<HypenDurableObjectConfig> = {}): HypenDurableObjectConfig {
  const module = app
    .defineState<{ counter: number }>({ counter: 0 })
    .onAction("inc", ({ state }: any) => {
      incCalls += 1;
      state.counter += 1;
    })
    .ui('module App { Text("counter:@{state.counter}") }');
  return {
    module,
    template: module.template ?? "",
    moduleName: "App",
    // Device plane on by default. The Rust device broker (same exports as the web-target glue).
    deviceWasm: nodeWasm,
    allowedOrigins: ["https://app.example"],
    ...overrides,
  };
}

class TestDO extends HypenDurableObject {
  enginesCreated = 0;
  constructor(ctx: any, private cfg: HypenDurableObjectConfig) {
    super(ctx, {});
  }
  getConfig() { return this.cfg; }
  createEngine(): BaseEngine {
    this.enginesCreated += 1;
    return new Engine();
  }
  /** Test-only peek at the in-memory session for a socket. */
  sessionFor(ws: WebSocket) {
    return (this as unknown as { sessions: Map<WebSocket, any> }).sessions.get(ws);
  }
}

const deviceHello = {
  type: "hello",
  props: {},
  device: {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "gallery.pick", versions: [1] },
    ],
  },
};

const inc = JSON.stringify({ type: "dispatchAction", action: "inc", payload: null });
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  incCalls = 0;
  app.clear?.();
});

/** First incarnation: negotiate the device plane on `ws`. */
async function negotiate(ws: Socket, cfg = makeConfig()) {
  const ctx = createCtx();
  ctx.acceptWebSocket(asWs(ws));
  const first = new TestDO(ctx, cfg);
  await first.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
  await settle();
  return first;
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

describe("CF device marker (attachment `deviceEnabled`)", () => {
  test("is written before the sessionAck that selects a device plane", async () => {
    const ws = createSocket();
    const first = await negotiate(ws);

    const ackIdx = ws.events.findIndex(
      (e) => e.kind === "send" && typeof e.data === "string" && JSON.parse(e.data).type === "sessionAck",
    );
    const markIdx = ws.events.findIndex(
      (e) => e.kind === "attach" && (e.value as any)?.deviceEnabled === true,
    );
    const ack = jsonFrames(ws).find((m) => m.type === "sessionAck");
    expect(ack.device).toBeDefined();
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeLessThan(ackIdx);

    // The session id rides along and the marker survives its later write.
    const att = ws.deserializeAttachment!() as any;
    expect(att.deviceEnabled).toBe(true);
    expect(att.hypenSessionId).toBe(ack.sessionId);

    // Device plane is live on CF: core.capabilities went out via sendDevice.
    expect(first.sessionFor(asWs(ws))?.deviceBroker).toBeTruthy();
    expect(
      jsonFrames(ws).some((m) => m.type === "deviceRequest" && m.capability === "core.capabilities"),
    ).toBe(true);
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("is not written when the DO opted out (device: false)", async () => {
    const ws = createSocket();
    const first = await negotiate(ws, makeConfig({ device: false }));
    const ack = jsonFrames(ws).find((m) => m.type === "sessionAck");
    expect(ack.device).toBeUndefined();
    expect((ws.deserializeAttachment!() as any)?.deviceEnabled).toBeUndefined();
    expect(first.sessionFor(asWs(ws))?.deviceBroker).toBeNull();
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("is not written when the client's hello carries no device extension", async () => {
    const ws = createSocket();
    const ctx = createCtx();
    const first = new TestDO(ctx, makeConfig());
    await first.webSocketMessage(asWs(ws), JSON.stringify({ type: "hello", props: {} }));
    await settle();
    expect(jsonFrames(ws).find((m) => m.type === "sessionAck").device).toBeUndefined();
    const att = ws.deserializeAttachment!() as any;
    expect(att.hypenSessionId).toBeDefined();
    expect(att.deviceEnabled).toBeUndefined();
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("a legacy client's non-hello first message is initialised (no device plane); a later hello may negotiate", async () => {
    const ws = createSocket();
    const first = new TestDO(createCtx(), makeConfig());
    // Legacy first message on a FRESH socket: the legacy (no-hello) path
    // initialises a device-less session and processes the message.
    await first.webSocketMessage(asWs(ws), inc);
    await settle();
    const legacyAcks = jsonFrames(ws).filter((m) => m.type === "sessionAck");
    expect(legacyAcks.length).toBe(1);
    expect(legacyAcks[0].device).toBeUndefined();
    expect(jsonFrames(ws).some((m) => m.type === "initialTree")).toBe(true);
    expect(incCalls).toBe(1);
    expect((ws.deserializeAttachment!() as any)?.deviceEnabled).toBeUndefined();

    await first.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
    await settle();
    const acks = jsonFrames(ws).filter((m) => m.type === "sessionAck");
    expect(acks.length).toBe(2);
    expect(acks[1].device).toBeDefined();
    expect(acks[1].sessionId).toBe(acks[0].sessionId);
    expect(acks[1].isNew).toBe(acks[0].isNew);
    expect((ws.deserializeAttachment!() as any).deviceEnabled).toBe(true);
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("a UI-only socket woken from hibernation re-acks a late device hello with its original isNew", async () => {
    const ws = createSocket();
    const ctx = createCtx();
    const first = new TestDO(ctx, makeConfig());
    // UI-only hello, then the DO is evicted (fresh instance, same socket).
    await first.webSocketMessage(asWs(ws), JSON.stringify({ type: "hello", props: {} }));
    await settle();
    const firstAck = jsonFrames(ws).find((m) => m.type === "sessionAck");
    expect(firstAck.device).toBeUndefined();
    const woke = new TestDO(ctx, makeConfig());
    await woke.webSocketMessage(asWs(ws), inc); // legacy restoration of the remembered id
    await settle();
    await woke.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
    await settle();
    const acks = jsonFrames(ws).filter((m) => m.type === "sessionAck");
    const last = acks.at(-1);
    expect(last.device).toBeDefined();
    expect(last.sessionId).toBe(firstAck.sessionId);
    // The re-ack repeats what the restoration ack said — never a made-up resume.
    expect(last.isNew).toBe(acks.at(-2).isNew);
    expect((ws.deserializeAttachment!() as any).deviceEnabled).toBe(true);
    await woke.webSocketClose(asWs(ws), 1000, "");
  });


  test("a socket without the attachment API never negotiates (no sendDevice)", async () => {
    const ws = createSocket({ attachments: false });
    expect(typeof new CFTransport(asWs(ws)).sendDevice).toBe("undefined");
    const first = await negotiate(ws);
    expect(jsonFrames(ws).find((m) => m.type === "sessionAck").device).toBeUndefined();
    expect(first.sessionFor(asWs(ws))?.deviceBroker).toBeNull();
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("a failed marker write resets the socket instead of acknowledging", async () => {
    const ws = createSocket({ failDeviceMarker: true });
    const first = await negotiate(ws);
    expect(ws.closed).toEqual({ code: 1011, reason: "device marker unavailable" });
    expect(jsonFrames(ws).some((m) => m.type === "sessionAck")).toBe(false);
    await first.webSocketClose(asWs(ws), 1011, "");
  });
});

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

describe("CF wake with a lost device broker", () => {
  test("a marked socket is closed 1012 and the message is NOT dispatched", async () => {
    const ws = createSocket();
    await negotiate(ws);
    // Hibernation: the first incarnation (and its broker) is gone; only the
    // socket and its attachment survive.
    ws.events.length = 0;
    incCalls = 0;

    const woke = new TestDO(createCtx(), makeConfig());
    await woke.webSocketMessage(asWs(ws), inc);
    await settle();

    expect(ws.closed).toEqual({ code: DEVICE_BROKER_LOST_CODE, reason: DEVICE_BROKER_LOST_REASON });
    expect(DEVICE_BROKER_LOST_CODE).toBe(1012);
    expect(DEVICE_BROKER_LOST_REASON).toBe("device broker lost");
    // Nothing sent: no synthesised sessionAck/initialTree, no patches.
    expect(ws.events.filter((e) => e.kind === "send")).toEqual([]);
    expect(incCalls).toBe(0);
    // No session, engine or broker was rebuilt under the surviving socket.
    expect(woke.enginesCreated).toBe(0);
    expect(woke.sessionFor(asWs(ws))).toBeUndefined();

    // The runtime's follow-up close is a clean no-op.
    await woke.webSocketClose(asWs(ws), 1012, "device broker lost");
  });

  test("a marked socket sending hello or a binary frame on wake is also reset", async () => {
    for (const message of [
      JSON.stringify(deviceHello),
      new Uint8Array(16).buffer as ArrayBuffer,
    ]) {
      const ws = createSocket();
      await negotiate(ws);
      ws.events.length = 0;
      const woke = new TestDO(createCtx(), makeConfig());
      await woke.webSocketMessage(asWs(ws), message);
      expect(ws.closed?.code).toBe(1012);
      expect(ws.events.filter((e) => e.kind === "send")).toEqual([]);
      expect(woke.enginesCreated).toBe(0);
    }
  });

  test("a marked socket with its live broker in memory is processed normally", async () => {
    const ws = createSocket();
    const first = await negotiate(ws);
    await first.webSocketMessage(asWs(ws), inc);
    await settle();
    expect(ws.closed).toBeNull();
    expect(incCalls).toBe(1);
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("an unmarked (UI-only) socket keeps the restoration path on wake", async () => {
    const ws = createSocket();
    const ctx = createCtx();
    const first = new TestDO(ctx, makeConfig());
    await first.webSocketMessage(asWs(ws), JSON.stringify({ type: "hello", props: {} }));
    await settle();
    const originalId = jsonFrames(ws).find((m) => m.type === "sessionAck").sessionId;

    ws.events.length = 0;
    incCalls = 0;
    const woke = new TestDO(createCtx(ctx.storage), makeConfig());
    await woke.webSocketMessage(asWs(ws), inc);
    await settle();

    expect(ws.closed).toBeNull();
    const out = jsonFrames(ws);
    const ack = out.find((m) => m.type === "sessionAck");
    expect(ack).toMatchObject({ sessionId: originalId, isNew: false, isRestored: true });
    expect(ack.device).toBeUndefined();
    expect(out.findIndex((m) => m.type === "initialTree")).toBeGreaterThan(out.indexOf(ack));
    expect(incCalls).toBe(1);
    await woke.webSocketClose(asWs(ws), 1000, "");
  });
});

// ---------------------------------------------------------------------------
// Binary routing + admission
// ---------------------------------------------------------------------------

describe("CF device transport", () => {
  test("sendBinary ships raw frames; sendDevice JSON-serialises", () => {
    const ws = createSocket();
    const t = new CFTransport(asWs(ws));
    const frame = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9]);
    t.sendBinary(frame);
    t.sendDevice!({ type: "deviceEvent" } as any);
    expect(ws.events[0]).toEqual({ kind: "send", data: frame });
    expect(ws.events[1]).toEqual({ kind: "send", data: JSON.stringify({ type: "deviceEvent" }) });
  });

  test("binary inbound frames route to session.receiveBinary when a broker exists", async () => {
    const ws = createSocket();
    const first = await negotiate(ws);
    const session = first.sessionFor(asWs(ws));
    const got: Uint8Array[] = [];
    session.receiveBinary = (f: Uint8Array) => got.push(f);
    const buf = new Uint8Array([1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 42]).buffer;
    await first.webSocketMessage(asWs(ws), buf);
    expect(got.length).toBe(1);
    expect([...got[0]!]).toEqual([1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 42]);
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("without a broker, binary messages keep the legacy JSON-in-binary path", async () => {
    const ws = createSocket();
    const first = new TestDO(createCtx(), makeConfig({ device: false }));
    await first.webSocketMessage(
      asWs(ws),
      new TextEncoder().encode(JSON.stringify({ type: "hello", props: {} })).buffer as ArrayBuffer,
    );
    await settle();
    expect(jsonFrames(ws).some((m) => m.type === "sessionAck")).toBe(true);
    await first.webSocketClose(asWs(ws), 1000, "");
  });

  test("never refuses to start: no allowlist ⇒ device still negotiated; syncActions keeps it on", async () => {
    const noOrigins = new TestDO(createCtx(), makeConfig({ allowedOrigins: undefined }));
    const a = createSocket();
    await noOrigins.webSocketMessage(asWs(a), JSON.stringify(deviceHello));
    await settle();
    expect(jsonFrames(a).find((m) => m.type === "sessionAck").device).toBeDefined();
    await noOrigins.webSocketClose(asWs(a), 1000, "");

    const sync = new TestDO(createCtx(), makeConfig({ syncActions: true }));
    const b = createSocket();
    await sync.webSocketMessage(asWs(b), JSON.stringify(deviceHello));
    await settle();
    const ack = jsonFrames(b).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeDefined();
    expect(sync.sessionFor(asWs(b))?.deviceBroker).not.toBeNull();
    await sync.webSocketClose(asWs(b), 1000, "");
  });

  test("syncActions: the dispatching socket's device request goes out; the replayed copy is refused (syncActions.replay)", async () => {
    const results: any[] = [];
    const module = app
      .defineState({ n: 0 })
      .onAction("pick", async ({ context }: any) => {
        results.push(await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
      })
      .ui('module App { Text("n") }');
    const d = new TestDO(
      createCtx(),
      makeConfig({ module, template: module.template ?? "", syncActions: true })
    );
    const a = createSocket();
    const b = createSocket();
    await d.webSocketMessage(asWs(a), JSON.stringify(deviceHello));
    await d.webSocketMessage(asWs(b), JSON.stringify(deviceHello));
    await settle();
    expect(jsonFrames(a).find((m) => m.type === "sessionAck").device).toBeDefined();
    expect(jsonFrames(b).find((m) => m.type === "sessionAck").device).toBeDefined();

    await d.webSocketMessage(asWs(a), JSON.stringify({ type: "dispatchAction", action: "pick", payload: null }));
    await settle();
    const isPick = (m: any) => m.type === "deviceRequest" && m.capability === "gallery.pick";
    // B's replayed handler: refused at once, nothing sent to B.
    expect(results).toEqual([{ ok: false, error: { code: "unavailable", platformDetail: "syncActions.replay" } }]);
    expect(jsonFrames(b).some(isPick)).toBe(false);
    // A dispatched: its request is out, and its answer completes the handler.
    const req = jsonFrames(a).find(isPick);
    expect(req).toBeDefined();
    await d.webSocketMessage(asWs(a), JSON.stringify({ type: "deviceResponse", id: req.id, result: { items: [] } }));
    await settle();
    expect(results[1]).toEqual({ ok: true, value: { items: [] } });
    await d.webSocketClose(asWs(a), 1000, "");
    await d.webSocketClose(asWs(b), 1000, "");
  });

  test("no allowlist / authenticator: every upgrade is admitted", async () => {
    (globalThis as any).WebSocketPair = class {
      0 = createSocket();
      1 = createSocket();
    };
    const ctx = createCtx();
    const d = new TestDO(ctx, makeConfig({ allowedOrigins: undefined }));
    for (const headers of [{}, { Origin: "https://any.example" }] as Array<Record<string, string>>) {
      try {
        await d.fetch(new Request("https://do/", { headers: { Upgrade: "websocket", ...headers } }));
      } catch {
        /* status 101 is rejected by Bun's Response */
      }
    }
    expect(ctx.getWebSockets().length).toBe(2);
  });

  test("the upgrade enforces the Origin allowlist", async () => {
    (globalThis as any).WebSocketPair = class {
      0 = createSocket();
      1 = createSocket();
    };
    const ctx = createCtx();
    const d = new TestDO(ctx, makeConfig());
    const bad = await d.fetch(
      new Request("https://do/", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } }),
    );
    expect(bad.status).toBe(403);
    const none = await d.fetch(new Request("https://do/", { headers: { Upgrade: "websocket" } }));
    expect(none.status).toBe(403);
    expect(ctx.getWebSockets().length).toBe(0);
    // A 101 Response can't be constructed outside workerd; reaching the pair
    // + acceptWebSocket is the proof the allowlisted origin passed.
    try {
      await d.fetch(
        new Request("https://do/", { headers: { Upgrade: "websocket", Origin: "https://APP.example" } }),
      );
    } catch {
      /* status 101 is rejected by Bun's Response */
    }
    expect(ctx.getWebSockets().length).toBe(1);
  });

  test("D1: Origin-less (native) clients are admitted only by the authenticator; it also runs for browsers", async () => {
    (globalThis as any).WebSocketPair = class {
      0 = createSocket();
      1 = createSocket();
    };
    const ctx = createCtx();
    const authenticate = (req: Request) => req.headers.get("Authorization") === "Bearer ok";
    const d = new TestDO(ctx, makeConfig({ authenticate }));
    const attempt = async (headers: Record<string, string>) => {
      const before = ctx.getWebSockets().length;
      let status = 101;
      try {
        status = (await d.fetch(new Request("https://do/", { headers: { Upgrade: "websocket", ...headers } }))).status;
      } catch {
        /* status 101 cannot be constructed outside workerd */
      }
      return ctx.getWebSockets().length > before ? "accepted" : status;
    };
    expect(await attempt({})).toBe(403);
    expect(await attempt({ Authorization: "Bearer ok" })).toBe("accepted");
    expect(await attempt({ Origin: "https://app.example" })).toBe(403);
    expect(await attempt({ Origin: "https://app.example", Authorization: "Bearer ok" })).toBe("accepted");
    expect(await attempt({ Origin: "https://evil.example", Authorization: "Bearer ok" })).toBe(403);

    // Native-only DO (authenticator, no allowlist): Origin is not checked,
    // the authenticator decides.
    const nativeCtx = createCtx();
    const native = new TestDO(nativeCtx, makeConfig({ allowedOrigins: undefined, authenticate }));
    const refused = await native.fetch(
      new Request("https://do/", { headers: { Upgrade: "websocket", Origin: "https://app.example" } })
    );
    expect(refused.status).toBe(403);
    try {
      await native.fetch(
        new Request("https://do/", { headers: { Upgrade: "websocket", Origin: "https://app.example", Authorization: "Bearer ok" } })
      );
    } catch {
      /* status 101 cannot be constructed outside workerd */
    }
    expect(nativeCtx.getWebSockets().length).toBe(1);
    // …and the device plane is negotiated there as everywhere.
    const ws = createSocket();
    await native.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
    await settle();
    expect(jsonFrames(ws).find((m) => m.type === "sessionAck").device).toBeDefined();
    await native.webSocketClose(asWs(ws), 1000, "");
  });

  test("an over-1 MiB device message is dropped before JSON.parse and counted", async () => {
    const d = new TestDO(createCtx(), makeConfig());
    const ws = createSocket();
    await d.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
    await settle();
    const broker = d.sessionFor(asWs(ws)).deviceBroker;
    const before = broker.connectionViolations;
    const started = performance.now();
    await d.webSocketMessage(asWs(ws), `{"type":"deviceEvent","id":7,"event":{"pad":"${"x".repeat(8 * 1024 * 1024)}"}}`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(broker.connectionViolations).toBe(before + 1);
    await d.webSocketClose(asWs(ws), 1000, "");
  });

  test("device text JSON.parse rejects is routed to the broker and counted, never silently dropped", async () => {
    const d = new TestDO(createCtx(), makeConfig());
    const ws = createSocket();
    await d.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
    await settle();
    const broker = d.sessionFor(asWs(ws)).deviceBroker;
    let expected = broker.connectionViolations;
    for (const text of [
      `{"type":"deviceEvent","id":7,"event":{"x":NaN}}`,
      `{"type":"deviceRequest","id":Infinity}`,
      `{"type":"deviceResponse","id":7,`,
      // JSON-valid but a client deviceRequest no client may send, unattributable.
      `{"type":"deviceRequest"}`,
    ]) {
      await d.webSocketMessage(asWs(ws), text);
      expected += 1;
      expect({ text, violations: broker.connectionViolations }).toEqual({ text, violations: expected });
    }
    // Unparseable UI text is still just ignored (not device text, not counted).
    await d.webSocketMessage(asWs(ws), `{"type":"dispatchAction","action":"inc","x":NaN}`);
    expect(broker.connectionViolations).toBe(expected);
    expect(incCalls).toBe(0);
    // A flood exhausts the violation budget: the socket is reset 1012.
    for (let i = 0; i < 64 && !ws.closed; i++) {
      await d.webSocketMessage(asWs(ws), `{"type":"deviceEvent","id":${i + 10},"event":{"x":NaN}}`);
    }
    expect(ws.closed?.code).toBe(1012);
    await d.webSocketClose(asWs(ws), 1012, "");
  });

  test("the DO shares one aggregate retained-bytes pool across its sessions", async () => {
    // 48 MiB across the DO, 16 MiB per connection: three sockets may each
    // reserve a full 16 MiB declaration; a fourth is refused `throttled` by
    // the aggregate pool although its own connection budget is untouched.
    const d = new TestDO(createCtx(), makeConfig());
    const sockets = [createSocket(), createSocket(), createSocket(), createSocket()];
    const outcomes: Array<Promise<unknown>> = [];
    for (const ws of sockets) {
      await d.webSocketMessage(asWs(ws), JSON.stringify(deviceHello));
      await settle();
      const session = d.sessionFor(asWs(ws));
      const plane = session.deviceBroker;
      expect(plane.maxRetainedBytes).toBe(16 * 1024 * 1024);
      const r = plane.open({
        capability: "gallery.pick",
        params: { mediaTypes: ["photo"], maxCount: 1 },
        moduleInstanceId: session.moduleInstance.deviceInstanceId,
        activationId: 1,
      });
      expect(r.id).not.toBeNull();
      outcomes.push(r.settled);
      await d.webSocketMessage(
        asWs(ws),
        JSON.stringify({
          type: "deviceEvent",
          id: r.id,
          event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 16 * 1024 * 1024 },
        })
      );
    }
    const planes = sockets.map((ws) => d.sessionFor(asWs(ws)).deviceBroker);
    expect(planes.slice(0, 3).map((p) => p.retainedBytes)).toEqual([16, 16, 16].map((m) => m * 1024 * 1024));
    expect(planes[3].retainedBytes).toBe(0);
    expect(await outcomes[3]).toMatchObject({ error: { code: "throttled" } });
    // Closing one connection hands its reservation back to the shared pool.
    await d.webSocketClose(asWs(sockets[0]!), 1000, "");
    const e = createSocket();
    await d.webSocketMessage(asWs(e), JSON.stringify(deviceHello));
    await settle();
    const session = d.sessionFor(asWs(e));
    const r = session.deviceBroker.open({
      capability: "gallery.pick",
      params: { mediaTypes: ["photo"], maxCount: 1 },
      moduleInstanceId: session.moduleInstance.deviceInstanceId,
      activationId: 1,
    });
    await d.webSocketMessage(
      asWs(e),
      JSON.stringify({
        type: "deviceEvent",
        id: r.id,
        event: { kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: 16 * 1024 * 1024 },
      })
    );
    expect(session.deviceBroker.retainedBytes).toBe(16 * 1024 * 1024);
    for (const ws of [...sockets.slice(1), e]) await d.webSocketClose(asWs(ws), 1000, "");
  });
});
