/**
 * RFC 001 §2.1 / decision D4 — the 1 MiB device-message limit is checked
 * BEFORE parsing, on every endpoint, whatever the member order.
 *
 * Regressions from the round-2 verifier (verify2-typescript/d4-typelast.ts):
 * - the Bun/Node `RemoteSession` (and the Cloudflare DO) recognised an
 *   oversize device message only when `"type":"device…"` sat in the first 64
 *   characters: `type` last, or after leading whitespace, ran `JSON.parse`
 *   over the whole (up to 4 MiB) text before the strict decoder refused it;
 * - the browser `RemoteEngine` compared UTF-16 code units with the byte limit,
 *   so a multi-byte device text over 1 MiB of UTF-8 but under 1M units was
 *   parsed first.
 * All endpoints now share `isOversizeDeviceText`: UTF-8 byte size, then the
 * linear top-level `type` scan.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, type SessionHost } from "../packages/core/src/remote/index.ts";
import { RemoteEngine } from "../packages/core/src/remote/client.ts";
import {
  exceedsUtf8Bytes,
  findTopLevelMember,
  isOversizeDeviceText,
  MAX_DEVICE_MESSAGE_BYTES,
} from "../packages/core/src/remote/device/strict-json.ts";
import type { DeviceEndpoint } from "../packages/core/src/remote/device/runtime.ts";
import { HypenDurableObject, type HypenDurableObjectConfig } from "../packages/cf/src/index";
import { Engine } from "../packages/server/src/engine";
import * as nodeWasm from "../packages/server/wasm-node/hypen_engine.js";
import type { BaseEngine } from "../packages/core/src/engine-base";
import { deviceHello, flush, makeHost, makeTransport } from "./device-srv-harness";

const MiB = MAX_DEVICE_MESSAGE_BYTES;

/** `"k0":0,"k1":0,…` members totalling at least `bytes` characters. */
function members(bytes: number): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < bytes; i++) {
    const m = `"k${i}":0`;
    parts.push(m);
    len += m.length + 1;
  }
  return parts.join(",");
}

const BIG = members(Math.ceil(1.5 * MiB));
const WS = " \n\t\r".repeat(40); // 160 characters: past any fixed-prefix window

/** Oversize device texts with `type` anywhere, spelled any legal way. */
const OVERSIZE_DEVICE: Array<[string, string]> = [
  ["type first", `{"type":"deviceEvent","id":999,"event":{${BIG}}}`],
  ["type last", `{"id":999,"event":{${BIG}},"type":"deviceEvent"}`],
  ["type after the big member, before id", `{"event":{${BIG}},"type":"deviceRequest","id":9}`],
  ["leading whitespace", `${WS}{${WS}"type"${WS}:${WS}"deviceEvent","id":999,"event":{${BIG}}}`],
  ["escaped key and value", `{"id":999,"event":{${BIG}},"\\u0074ype":"device\\u0052esponse"}`],
  ["duplicate type (unscannable)", `{"type":"stateUpdate","state":{${BIG}},"type":"deviceEvent"}`],
];

/** Counts `JSON.parse` calls on texts over `limit` characters. */
function countBigParses(limit = 4096) {
  const spy = spyOn(JSON, "parse");
  return {
    big: () => spy.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).length > limit).length,
    restore: () => spy.mockRestore(),
  };
}

// ---------------------------------------------------------------------------
// The shared helper
// ---------------------------------------------------------------------------

describe("isOversizeDeviceText (shared pre-parse check)", () => {
  test("recognises every oversize device spelling without parsing it", () => {
    for (const [label, text] of OVERSIZE_DEVICE) {
      const parses = countBigParses();
      try {
        expect({ label, oversize: isOversizeDeviceText(text) }).toEqual({ label, oversize: true });
        expect(parses.big()).toBe(0);
      } finally {
        parses.restore();
      }
    }
  });

  test("an oversize UI message is not device text; anything within the limit is never inspected", () => {
    expect(isOversizeDeviceText(`{"type":"stateUpdate","state":{${BIG}}}`)).toBe(false);
    expect(isOversizeDeviceText(`{"state":{${BIG}},"type":"dispatchAction"}`)).toBe(false);
    expect(isOversizeDeviceText(`{"type":7,"x":{${BIG}}}`)).toBe(false);
    // A device message exactly at the limit is still within it.
    const head = `{"type":"deviceEvent","id":1,"event":{"p":"`;
    const exact = head + "a".repeat(MiB - head.length - 3) + `"}}`;
    expect(new TextEncoder().encode(exact).length).toBe(MiB);
    expect(isOversizeDeviceText(exact)).toBe(false);
    expect(isOversizeDeviceText(exact.replace('"p":"', '"p":"a'))).toBe(true);
  });

  test("the size is UTF-8 bytes, not UTF-16 code units", () => {
    // 400k × "é" (2 bytes) + 300k × "€" (3 bytes) = 1.7 MB of UTF-8 in 700k units.
    const text = `{"type":"deviceEvent","id":1,"event":{"p":"${"é".repeat(400_000)}${"€".repeat(300_000)}"}}`;
    expect(text.length).toBeLessThan(MiB);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(MiB);
    expect(isOversizeDeviceText(text)).toBe(true);
    // Astral characters: 4 bytes per surrogate pair.
    expect(exceedsUtf8Bytes("😀".repeat(262_144), MiB)).toBe(false); // exactly 1 MiB
    expect(exceedsUtf8Bytes("😀".repeat(262_145), MiB)).toBe(true);
    // A lone surrogate counts as its 3-byte U+FFFD replacement.
    expect(exceedsUtf8Bytes("\ud800".repeat(349_525), MiB)).toBe(false);
    expect(exceedsUtf8Bytes("\ud800".repeat(349_526), MiB)).toBe(true);
  });

  test("findTopLevelMember never unescapes a huge key", () => {
    const hugeKey = "k".repeat(2 * MiB);
    const parses = countBigParses(64);
    try {
      const found = findTopLevelMember(`{"${hugeKey}":1,"type":"deviceEvent"}`, "type");
      expect(found).toEqual({ found: true, raw: '"deviceEvent"' });
      expect(parses.big()).toBe(0);
    } finally {
      parses.restore();
    }
    // Keys that can still spell the member are unescaped and compared.
    expect(findTopLevelMember(`{"\\u0074\\u0079\\u0070\\u0065":1}`, "type")).toEqual({ found: true, raw: "1" });
    expect(findTopLevelMember(`{"type":1,"\\u0074ype":2}`, "type")).toEqual({
      found: false,
      error: 'duplicate "type" member',
    });
  });

  test("the scan is linear: a 4 MiB text is decided in well under the parse cost", () => {
    const text = `{"id":999,"event":{${members(4 * MiB)}},"type":"deviceEvent"}`;
    isOversizeDeviceText(text); // warm up
    const started = performance.now();
    expect(isOversizeDeviceText(text)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  // The server hosts (RemoteSession, the Cloudflare DO) keep this TS scan as
  // their pre-parse gate — @hypen-space/core is WASM-free, and the same scan
  // routes device text by its raw `type` (`isDeviceTypedText`) — while the
  // Rust broker exports its own (`deviceIsOversizeText`, what the Kotlin
  // server calls). Pin the two to one verdict so the gate in front of the
  // broker can never disagree with the broker's rule.
  test("agrees with the Rust broker's deviceIsOversizeText on every corpus text", () => {
    const head = `{"type":"deviceEvent","id":1,"event":{"p":"`;
    const exact = head + "a".repeat(MiB - head.length - 3) + `"}}`;
    const corpus: Array<[string, string]> = [
      ...OVERSIZE_DEVICE,
      ["oversize UI, type first", `{"type":"stateUpdate","state":{${BIG}}}`],
      ["oversize UI, type last", `{"state":{${BIG}},"type":"dispatchAction"}`],
      ["oversize, non-string type", `{"type":7,"x":{${BIG}}}`],
      ["oversize, no type", `{"x":{${BIG}}}`],
      ["oversize, not an object", `[{${BIG}},"deviceEvent"]`],
      ["oversize, truncated object", `{"type":"deviceEvent","x":{${BIG}}`],
      ["oversize, malformed type escape", `{"x":{${BIG}},"type":"device\\uZZZZ"}`],
      ["oversize, overlong type spelling", `{"x":{${BIG}},"type":"${"\\u0064".repeat(20)}"}`],
      ["exactly at the limit", exact],
      ["one byte over", exact.replace('"p":"', '"p":"a')],
      ["multi-byte over", `{"type":"deviceEvent","id":1,"event":{"p":"${"é".repeat(400_000)}${"€".repeat(300_000)}"}}`],
      ["small device text", `{"type":"deviceEvent","id":1}`],
      ["small malformed text", `{"type":`],
    ];
    for (const [label, text] of corpus) {
      expect({ label, verdict: isOversizeDeviceText(text) }).toEqual({
        label,
        verdict: nodeWasm.deviceIsOversizeText(text),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Server: RemoteSession (Bun / Node RemoteServer)
// ---------------------------------------------------------------------------

describe("RemoteSession drops every oversize device message before JSON.parse", () => {
  async function startSession() {
    const received: unknown[] = [];
    const module = app
      .defineState({})
      .onAction("big", ({ action }) => {
        received.push(action.payload);
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(module), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    return { session, received, broker: session.deviceBroker! };
  }

  test("type first / last / after whitespace / escaped / duplicated: never parsed, one violation each", async () => {
    const { session, broker } = await startSession();
    let violations = broker.connectionViolations;
    for (const [label, text] of OVERSIZE_DEVICE) {
      const parses = countBigParses();
      try {
        await session.receive(text);
        expect({ label, bigParses: parses.big() }).toEqual({ label, bigParses: 0 });
      } finally {
        parses.restore();
      }
      violations += 1;
      expect({ label, violations: broker.connectionViolations }).toEqual({ label, violations });
      expect(broker.lastConnectionViolation).toMatch(/over 1 MiB/);
    }
    expect(session.deviceBroker).toBe(broker); // the plane stays up
    await session.destroy();
  });

  test("a multi-byte device text over 1 MiB of UTF-8 is dropped unparsed", async () => {
    const { session, broker } = await startSession();
    const before = broker.connectionViolations;
    const text = `{"id":5,"event":{"p":"${"€".repeat(400_000)}"},"type":"deviceEvent"}`;
    expect(text.length).toBeLessThan(MiB);
    const parses = countBigParses();
    try {
      await session.receive(text);
      expect(parses.big()).toBe(0);
    } finally {
      parses.restore();
    }
    expect(broker.connectionViolations).toBe(before + 1);
    await session.destroy();
  });

  test("an oversize UI message with `type` last still reaches its handler", async () => {
    const { session, broker, received } = await startSession();
    const before = broker.connectionViolations;
    const blob = "b".repeat(1_200_000);
    await session.receive(`{"module":"Test","action":"big","payload":{"blob":"${blob}"},"type":"dispatchAction"}`);
    await flush();
    expect(received).toEqual([{ blob }]);
    expect(broker.connectionViolations).toBe(before);
    await session.destroy();
  });
});

// ---------------------------------------------------------------------------
// Server: Cloudflare Durable Object
// ---------------------------------------------------------------------------

describe("HypenDurableObject drops every oversize device message before JSON.parse", () => {
  function createSocket() {
    let attachment: unknown;
    return {
      send: () => {},
      close: () => {},
      readyState: 1,
      serializeAttachment: (v: unknown) => {
        attachment = structuredClone(v);
      },
      deserializeAttachment: () => structuredClone(attachment),
    } as unknown as WebSocket;
  }
  class TestDO extends HypenDurableObject {
    constructor(private cfg: HypenDurableObjectConfig) {
      const data = new Map<string, unknown>();
      const sockets: WebSocket[] = [];
      super(
        {
          storage: {
            async get(k: string) { return data.get(k); },
            async put(k: string, v: unknown) { data.set(k, v); },
            async delete(k: string) { return data.delete(k); },
          },
          acceptWebSocket: (ws: WebSocket) => sockets.push(ws),
          getWebSockets: () => sockets,
        } as any,
        {}
      );
    }
    getConfig() { return this.cfg; }
    createEngine(): BaseEngine { return new Engine(); }
    sessionFor(ws: WebSocket) {
      return (this as unknown as { sessions: Map<WebSocket, any> }).sessions.get(ws);
    }
  }
  const config = (): HypenDurableObjectConfig => {
    const module = app.defineState({}).ui('module App { Text("hi") }');
    return {
      module,
      template: module.template ?? "",
      moduleName: "App",
      // Device plane on by default.
      deviceWasm: nodeWasm,
      allowedOrigins: ["https://app.example"],
    };
  };

  test("type anywhere: dropped unparsed and counted", async () => {
    const d = new TestDO(config());
    const ws = createSocket();
    await d.webSocketMessage(ws, JSON.stringify(deviceHello([{ name: "core.capabilities", versions: [1] }])));
    await new Promise((r) => setTimeout(r, 20));
    const broker = d.sessionFor(ws).deviceBroker;
    let violations = broker.connectionViolations;
    for (const [label, text] of OVERSIZE_DEVICE) {
      const parses = countBigParses();
      try {
        await d.webSocketMessage(ws, text);
        expect({ label, bigParses: parses.big() }).toEqual({ label, bigParses: 0 });
      } finally {
        parses.restore();
      }
      violations += 1;
      expect({ label, violations: broker.connectionViolations }).toEqual({ label, violations });
    }
    await d.webSocketClose(ws, 1000, "");
  });

  test("before any session exists, a device-enabled DO still never parses one", async () => {
    const d = new TestDO(config());
    const ws = createSocket();
    const parses = countBigParses();
    try {
      await d.webSocketMessage(ws, OVERSIZE_DEVICE[1]![1]);
      expect(parses.big()).toBe(0);
    } finally {
      parses.restore();
    }
    expect(d.sessionFor(ws)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client: RemoteEngine
// ---------------------------------------------------------------------------

class MockWS extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  onopen: null | (() => void) = null;
  constructor() {
    super();
    MockWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send() {}
  close() {
    this.readyState = 3;
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("RemoteEngine hands every oversize device text over unparsed", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  });

  function recording() {
    const texts: string[] = [];
    const endpoint: DeviceEndpoint = {
      advertisement: { protocolVersions: [1], binary: true, capabilities: [{ name: "core.capabilities", versions: [1] }] },
      attach: () => {},
      onAck: () => {},
      handleMessage: () => {},
      handleText: (t) => texts.push(t),
      handleFrame: () => {},
      detach: () => {},
    };
    return { endpoint, texts };
  }

  test("multi-byte device text over 1 MiB of UTF-8 but under 1M code units", async () => {
    const { endpoint, texts } = recording();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const text = `{"type":"deviceEvent","id":2,"control":{"renewLease":1},"pad":"${"€".repeat(400_000)}"}`;
    expect(text.length).toBeLessThan(MiB);
    const parses = countBigParses();
    try {
      MockWS.instances[0]!.receive(text);
      expect(parses.big()).toBe(0);
    } finally {
      parses.restore();
    }
    expect(texts).toEqual([text]);
    engine.disconnect();
  });

  test("type last / after whitespace / escaped: never parsed", async () => {
    const { endpoint, texts } = recording();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    for (const [label, text] of OVERSIZE_DEVICE) {
      const parses = countBigParses();
      try {
        MockWS.instances[0]!.receive(text);
        expect({ label, bigParses: parses.big() }).toEqual({ label, bigParses: 0 });
      } finally {
        parses.restore();
      }
    }
    expect(texts.length).toBe(OVERSIZE_DEVICE.length);
    engine.disconnect();
  });

  test("an under-limit multi-byte device text is still parsed and routed normally", async () => {
    const { endpoint, texts } = recording();
    const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
    await engine.connect();
    const text = `{"type":"deviceEvent","id":2,"control":{"renewLease":1},"pad":"${"€".repeat(300_000)}"}`;
    expect(new TextEncoder().encode(text).length).toBeLessThan(MiB);
    MockWS.instances[0]!.receive(text);
    expect(texts).toEqual([text]);
    engine.disconnect();
  });
});
