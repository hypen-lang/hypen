/**
 * Compression policy (#11, RFC 001 §2.3): compression is per message. A
 * device connection may use permessage-deflate only with no context takeover
 * in BOTH directions (`server_no_context_takeover` AND
 * `client_no_context_takeover`), so device data never shares a DEFLATE
 * history with another message.
 *
 *  - Bun `RemoteServer`: a real upgrade that offers permessage-deflate is
 *    answered 101 with both no-context-takeover params, by default and with
 *    an explicit `compression: true`; `compression: false` declines it. The
 *    device plane is on in every case.
 *  - `RemoteEngine` over real sockets: it negotiates the device plane on the
 *    default (per-message) server, and refuses it — hello without `device`
 *    — on a server that negotiates context takeover.
 *  - Cloudflare DO: `webSocketCompression: true` no longer turns the device
 *    plane off; each socket is judged by its negotiated extensions (both
 *    params ⇒ device, otherwise UI-only; unobservable + declared compression
 *    + a DEFLATE offer ⇒ UI-only, fail closed).
 */

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { app } from "@hypen-space/core";
import { configureLogger } from "../packages/core/src/logger";
import { RemoteServer } from "../packages/server/src/remote/server";
import { RemoteEngine } from "../packages/core/src/remote/client";
import type { DeviceEndpoint } from "../packages/core/src/remote/device/runtime";
import type { DeviceAck } from "../packages/core/src/remote/device/generated";
import { parseWebSocketExtensions } from "../packages/core/src/remote/ws-extensions";
import { HypenDurableObject, CFTransport, type HypenDurableObjectConfig } from "../packages/cf/src/index";
import { Engine } from "../packages/server/src/engine";
import type { BaseEngine } from "../packages/core/src/engine-base";
import * as nodeWasm from "../packages/server/wasm-node/hypen_engine.js";

const counter = app.defineState({ count: 0 }).build();
/** Listen on an OS-assigned port (no collisions with parallel suites). */
async function listen(server: RemoteServer): Promise<number> {
  await server.listen(0);
  return (server as unknown as { server: { port: number } }).server.port;
}

/** Raw HTTP/1.1 upgrade offering permessage-deflate; resolves the response head. */
function rawUpgrade(
  p: number,
  origin: string,
  offer = "permessage-deflate; client_max_window_bits"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(p, "127.0.0.1", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          `Host: 127.0.0.1:${p}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Extensions: ${offer}`,
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n")
      );
    });
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.destroy();
        resolve(buf.slice(0, end));
      }
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error(`no upgrade response: ${JSON.stringify(buf)}`));
    }, 3000);
  });
}

/** The negotiated `Sec-WebSocket-Extensions` of a raw response head, or null. */
function negotiated(head: string): string | null {
  const line = head.split("\r\n").find((l) => /^sec-websocket-extensions:/i.test(l));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

/** Assert a negotiated value is ONE permessage-deflate with both no-context-takeover params. */
function expectPerMessage(value: string | null) {
  expect(value).not.toBeNull();
  const parsed = parseWebSocketExtensions(value!)!;
  expect(parsed.map((e) => e.name)).toEqual(["permessage-deflate"]);
  const params = [...parsed[0]!.params.keys()];
  expect(params).toContain("server_no_context_takeover");
  expect(params).toContain("client_no_context_takeover");
  expect(parsed[0]!.params.get("server_no_context_takeover")).toBeNull();
  expect(parsed[0]!.params.get("client_no_context_takeover")).toBeNull();
}

describe("Bun RemoteServer negotiates per-message permessage-deflate", () => {
  test("default (device plane on): 101 with server_ and client_no_context_takeover", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"] });
    const p = await listen(server);
    try {
      // A browser-style offer (no context-takeover params requested) …
      const head = await rawUpgrade(p, "http://app.example");
      expect(head).toMatch(/^HTTP\/1\.1 101/);
      expectPerMessage(negotiated(head));
      // … and a bare offer: the server imposes both params either way.
      expectPerMessage(negotiated(await rawUpgrade(p, "http://app.example", "permessage-deflate")));
    } finally {
      server.stop();
    }
  });

  test("explicit compression: true: the same per-message negotiation", async () => {
    const server = new RemoteServer().module("Counter", counter).ui('Text("hi")').config({ compression: true });
    const p = await listen(server);
    try {
      const head = await rawUpgrade(p, "http://app.example");
      expect(head).toMatch(/^HTTP\/1\.1 101/);
      expectPerMessage(negotiated(head));
    } finally {
      server.stop();
    }
  });

  test("compression: false declines the extension (the probe is not vacuous)", async () => {
    const server = new RemoteServer().module("Counter", counter).ui('Text("hi")').config({ compression: false });
    const p = await listen(server);
    try {
      const head = await rawUpgrade(p, "http://app.example");
      expect(head).toMatch(/^HTTP\/1\.1 101/);
      expect(negotiated(head)).toBeNull();
      expect(head.toLowerCase()).not.toContain("permessage-deflate");
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RemoteEngine (the web client) over real sockets
// ---------------------------------------------------------------------------

/** A device endpoint that records attach/ack (the protocol is not exercised further). */
function recordingEndpoint() {
  const log = { attach: 0, acks: [] as Array<DeviceAck | undefined> };
  const endpoint: DeviceEndpoint = {
    advertisement: {
      protocolVersions: [1],
      binary: true,
      capabilities: [
        { name: "core.capabilities", versions: [1] },
        { name: "permission.query", versions: [1] },
      ],
    },
    attach: () => {
      log.attach += 1;
    },
    onAck: (a) => log.acks.push(a),
    handleMessage: () => {},
    handleMalformed: () => {},
    handleFrame: () => {},
    detach: () => {},
  };
  return { endpoint, log };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 5));
}

describe("RemoteEngine and compression over real sockets", () => {
  test("default server: the client's device plane is negotiated on the per-message compressed socket", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ webClient: false });
    const p = await listen(server);
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine(`ws://127.0.0.1:${p}/`, { device: endpoint, autoReconnect: false });
    try {
      expect((await engine.connect()).ok).toBe(true);
      const ws = (engine as unknown as { ws: WebSocket }).ws;
      expectPerMessage(ws.extensions);
      expect(log.attach).toBe(1);
      await until(() => log.acks.length > 0);
      expect(log.acks[0]).toBeDefined();
      expect(log.acks[0]!.capabilities.map((c) => c.name)).toContain("permission.query");
    } finally {
      engine.dispose();
      await new Promise((r) => setTimeout(r, 20));
      server.stop();
    }
  });

  test("a server that negotiates context takeover: the client refuses the device plane (hello without device)", async () => {
    const hellos: any[] = [];
    // A plain Bun server with "dedicated" (de)compressors: context takeover
    // in both directions, i.e. a bare `permessage-deflate` answer.
    const srv = Bun.serve({
      port: 0,
      websocket: {
        perMessageDeflate: { compress: "dedicated", decompress: "dedicated" },
        message(ws, msg) {
          const m = JSON.parse(String(msg));
          if (m.type !== "hello") return;
          hellos.push(m);
          ws.send(
            JSON.stringify({
              type: "sessionAck",
              sessionId: "s-1",
              isNew: true,
              isRestored: false,
              device: { protocolVersion: 1, binary: true, capabilities: [{ name: "core.capabilities", version: 1 }] },
            })
          );
        },
      },
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("no");
      },
    });
    const { endpoint, log } = recordingEndpoint();
    const engine = new RemoteEngine(`ws://127.0.0.1:${srv.port}/`, { device: endpoint, autoReconnect: false });
    try {
      expect((await engine.connect()).ok).toBe(true);
      const ws = (engine as unknown as { ws: WebSocket }).ws;
      expect(ws.extensions.toLowerCase()).toContain("permessage-deflate");
      expect(ws.extensions.toLowerCase()).not.toContain("no_context_takeover");
      await until(() => hellos.length > 0);
      expect(hellos).toHaveLength(1);
      expect("device" in hellos[0]).toBe(false);
      expect(log.attach).toBe(0);
      await new Promise((r) => setTimeout(r, 30));
      // Even an ack that (wrongly) selects a device plane is ignored.
      expect(log.acks).toEqual([]);
    } finally {
      engine.dispose();
      srv.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Durable Object
// ---------------------------------------------------------------------------

function createSocket(extensions?: string) {
  const sent: string[] = [];
  let attachment: unknown;
  return {
    sent,
    attachment: () => structuredClone(attachment) as Record<string, unknown> | undefined,
    ...(extensions !== undefined ? { extensions } : {}),
    send: (d: string | Uint8Array) => {
      if (typeof d === "string") sent.push(d);
    },
    close: () => {},
    readyState: 1,
    serializeAttachment: (v: unknown) => {
      attachment = structuredClone(v);
    },
    deserializeAttachment: () => structuredClone(attachment),
  };
}

function config(overrides: Partial<HypenDurableObjectConfig> = {}): HypenDurableObjectConfig {
  const module = app.defineState({ n: 0 }).ui('module App { Text("n") }');
  return {
    module,
    template: module.template ?? "",
    moduleName: "App",
    allowedOrigins: ["https://app.example"],
    // The Rust device broker (same exports as the web-target glue).
    deviceWasm: nodeWasm,
    ...overrides,
  };
}

class TestDO extends HypenDurableObject {
  constructor(private cfg: HypenDurableObjectConfig) {
    super(
      {
        storage: { get: async () => undefined, put: async () => {}, delete: async () => true } as any,
        acceptWebSocket: () => {},
        getWebSockets: () => [],
      },
      {}
    );
  }
  getConfig() {
    return this.cfg;
  }
  createEngine(): BaseEngine {
    return new Engine();
  }
}

const hello = JSON.stringify({
  type: "hello",
  device: {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "gallery.pick", versions: [1] },
    ],
  },
});

const PER_MESSAGE = "permessage-deflate; client_no_context_takeover; server_no_context_takeover";

/** Capture framework `warn` lines until `restore()`. */
function captureWarnings() {
  const warnings: string[] = [];
  const noop = () => {};
  configureLogger({
    handler: {
      debug: noop,
      info: noop,
      warn: (_tag: string, ...args: unknown[]) => warnings.push(args.map(String).join(" ")),
      error: noop,
    },
  });
  return { warnings, restore: () => configureLogger({ handler: undefined }) };
}

describe("Durable Object compression policy", () => {
  test("webSocketCompression: true no longer turns the device plane off: per socket, no warning", async () => {
    const log = captureWarnings();
    try {
      const d = new TestDO(config({ webSocketCompression: true }));
      // Per-message DEFLATE (both no-context-takeover params): device plane.
      const perMessage = createSocket(PER_MESSAGE);
      await d.webSocketMessage(perMessage as unknown as WebSocket, hello);
      const ok = perMessage.sent.map((s) => JSON.parse(s));
      expect(ok.find((m) => m.type === "sessionAck").device).toBeDefined();
      expect(ok.some((m) => m.type === "deviceRequest")).toBe(true);
      // Context takeover (bare permessage-deflate) on the same DO: UI-only.
      const takeover = createSocket("permessage-deflate");
      await d.webSocketMessage(takeover as unknown as WebSocket, hello);
      const ui = takeover.sent.map((s) => JSON.parse(s));
      const ack = ui.find((m) => m.type === "sessionAck");
      expect(ack).toBeDefined();
      expect(ack.device).toBeUndefined();
      expect(ui.some((m) => m.type === "deviceRequest")).toBe(false);
      expect(log.warnings.filter((w) => w.includes("Device plane off"))).toHaveLength(0);
      await d.webSocketClose(perMessage as unknown as WebSocket, 1000, "");
      await d.webSocketClose(takeover as unknown as WebSocket, 1000, "");
    } finally {
      log.restore();
    }
  });

  test("without the device broker wasm the DO still serves UI; the device plane is off", async () => {
    const d = new TestDO(config({ deviceWasm: undefined }));
    const ws = createSocket();
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const ack = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeUndefined();
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

  test("device: false + webSocketCompression (UI-only DO) is fine", async () => {
    const d = new TestDO(config({ device: false, allowedOrigins: undefined, webSocketCompression: true }));
    const ws = createSocket();
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const ack = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeUndefined();
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

  test("CFTransport offers a device route only on uncompressed or per-message sockets", () => {
    const route = (ext?: string) => typeof new CFTransport(createSocket(ext) as unknown as WebSocket).sendDevice;
    expect(route(undefined)).toBe("function");
    expect(route("")).toBe("function");
    expect(route(PER_MESSAGE)).toBe("function");
    expect(route("Permessage-Deflate; SERVER_NO_CONTEXT_TAKEOVER; client_no_context_takeover")).toBe("function");
    expect(route("permessage-deflate")).toBe("undefined");
    expect(route("permessage-deflate; server_no_context_takeover")).toBe("undefined");
    expect(route("permessage-deflate; client_no_context_takeover")).toBe("undefined");
    expect(route("permessage-deflate; client_max_window_bits=15")).toBe("undefined");
  });

  test("a socket reporting context-takeover permessage-deflate never gets a device plane", async () => {
    expect(typeof new CFTransport(createSocket("permessage-deflate") as unknown as WebSocket).sendDevice).toBe(
      "undefined"
    );
    const d = new TestDO(config());
    const ws = createSocket("permessage-deflate; server_no_context_takeover");
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs.find((m) => m.type === "sessionAck").device).toBeUndefined();
    expect(msgs.some((m) => m.type === "deviceRequest")).toBe(false);
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

  test("a per-message compressed socket negotiates normally", async () => {
    const d = new TestDO(config());
    const ws = createSocket(PER_MESSAGE);
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs.find((m) => m.type === "sessionAck").device).toBeDefined();
    expect((d as any).sessions.get(ws).deviceBroker).not.toBeNull();
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

  test("an uncompressed socket negotiates normally, with the 16 MiB DO budget", async () => {
    const d = new TestDO(config());
    const ws = createSocket("");
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs.find((m) => m.type === "sessionAck").device).toBeDefined();
    const session = (d as any).sessions.get(ws);
    expect(session.deviceBroker.maxRetainedBytes).toBe(16 * 1024 * 1024);
    expect(session.deviceBroker.revision("gallery.pick", 1).maxItemBytes).toBe(16 * 1024 * 1024);
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

  test("the DO hands raw text to the session: duplicate keys in a device message are caught", async () => {
    const d = new TestDO(config());
    const ws = createSocket("");
    await d.webSocketMessage(ws as unknown as WebSocket, hello);
    const core = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "deviceRequest");
    const broker = (d as any).sessions.get(ws).deviceBroker;
    const before = broker.connectionViolations;
    // A duplicate-key "terminal" for the control stream breaks the JSON
    // limits: attributable to no request (decision D8) — discarded and
    // counted, never ending the stream its untrusted id seems to name.
    await d.webSocketMessage(
      ws as unknown as WebSocket,
      `{"type":"deviceResponse","id":${core.id},"result":{},"result":{}}`
    );
    expect(broker.connectionViolations).toBe(before + 1);
    expect(broker.lastConnectionViolation).toMatch(/duplicate key/);
    expect(broker.isLive(core.id)).toBe(true);
    const cancels = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.id === core.id && m.control?.cancel);
    expect(cancels.length).toBe(0);
    await d.webSocketClose(ws as unknown as WebSocket, 1000, "");
  });

});

describe("Durable Object upgrade: the per-socket compression verdict (fetch)", () => {
  /** Run one upgrade whose server-side socket reports `extensions`; returns that socket. */
  async function upgrade(
    cfg: Partial<HypenDurableObjectConfig>,
    serverExtensions: string | undefined,
    offer?: string
  ) {
    const server = createSocket(serverExtensions);
    (globalThis as any).WebSocketPair = class {
      0 = createSocket();
      1 = server;
    };
    const d = new TestDO(config(cfg));
    try {
      await d.fetch(
        new Request("https://do/", {
          headers: {
            Upgrade: "websocket",
            Origin: "https://app.example",
            ...(offer !== undefined ? { "Sec-WebSocket-Extensions": offer } : {}),
          },
        })
      );
    } catch {
      /* a 101 Response cannot be constructed outside workerd */
    }
    return { d, server };
  }

  const marked = (s: ReturnType<typeof createSocket>) => s.attachment()?.compressed === true;

  test("reported extensions decide: context takeover is marked UI-only, per-message and none are not", async () => {
    expect(marked((await upgrade({}, "permessage-deflate")).server)).toBe(true);
    expect(marked((await upgrade({}, "permessage-deflate; server_no_context_takeover")).server)).toBe(true);
    expect(marked((await upgrade({}, PER_MESSAGE)).server)).toBe(false);
    expect(marked((await upgrade({}, "")).server)).toBe(false);
    // With the flag declared too: the reported value still decides.
    expect(marked((await upgrade({ webSocketCompression: true }, PER_MESSAGE, "permessage-deflate")).server)).toBe(
      false
    );
  });

  test("unobservable negotiation + webSocketCompression: true + a DEFLATE offer ⇒ UI-only (fail closed)", async () => {
    const offer = "permessage-deflate; client_max_window_bits";
    const { d, server } = await upgrade({ webSocketCompression: true }, undefined, offer);
    expect(marked(server)).toBe(true);
    // The marker holds when the hello arrives: no device plane on this socket.
    await d.webSocketMessage(server as unknown as WebSocket, hello);
    const ack = server.sent.map((s) => JSON.parse(s)).find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack.device).toBeUndefined();
    await d.webSocketClose(server as unknown as WebSocket, 1000, "");
  });

  test("unobservable negotiation without a DEFLATE offer, or without the flag, keeps the device plane", async () => {
    expect(marked((await upgrade({ webSocketCompression: true }, undefined)).server)).toBe(false);
    expect(marked((await upgrade({ webSocketCompression: true }, undefined, "x-other")).server)).toBe(false);
    expect(marked((await upgrade({}, undefined, "permessage-deflate")).server)).toBe(false);
    const { d, server } = await upgrade({ webSocketCompression: true }, undefined);
    await d.webSocketMessage(server as unknown as WebSocket, hello);
    const ack = server.sent.map((s) => JSON.parse(s)).find((m) => m.type === "sessionAck");
    expect(ack.device).toBeDefined();
    await d.webSocketClose(server as unknown as WebSocket, 1000, "");
  });
});
