/**
 * Device Capability Protocol — `RemoteEngine` device plumbing (RFC 001 §2.2,
 * §2.3, §2.5, §5) against a scripted in-process WebSocket.
 *
 * Covers: endpoint attach on open and detach on dispose()/disconnect()/close
 * (exactly once), binary routing (ArrayBuffer and typed-array views),
 * compression (`ws.extensions` with context-takeover permessage-deflate ⇒ no
 * device extension and no device routing; per-message DEFLATE with both
 * no-context-takeover params ⇒ device as usual), duplicate-key device messages routed as malformed,
 * `sessionAck.device` validation/intersection, stale-socket isolation, and
 * the session resume token (stored from sessionAck, sent only on resume).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RemoteEngine, type SessionInfo } from "../packages/core/src/remote/client.ts";
import type { DeviceClientTransport, DeviceEndpoint } from "../packages/core/src/remote/device/runtime.ts";
import type { DeviceAck, DeviceHello } from "../packages/core/src/remote/device/generated.ts";

class MockWS extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];
  static nextExtensions = "";
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions: string;
  onopen: null | (() => void) = null;
  sent: Array<string | Uint8Array> = [];
  constructor(public url: string) {
    super();
    this.extensions = MockWS.nextExtensions;
    MockWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this.serverClose(), 0);
  }
  /** The peer (or network) closes the socket. */
  serverClose() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
}

let savedWebSocket: unknown;
beforeEach(() => {
  savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
  MockWS.instances = [];
  MockWS.nextExtensions = "";
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const ADVERTISEMENT: DeviceHello = {
  protocolVersions: [1],
  binary: true,
  capabilities: [
    { name: "core.capabilities", versions: [1] },
    { name: "gallery.pick", versions: [1] },
  ],
};

function recordingEndpoint() {
  const log = {
    attach: 0,
    detach: 0,
    acks: [] as Array<DeviceAck | undefined>,
    messages: [] as unknown[],
    malformed: [] as Array<{ message: unknown; detail: string }>,
    frames: [] as Uint8Array[],
    io: null as DeviceClientTransport | null,
  };
  const endpoint: DeviceEndpoint = {
    advertisement: ADVERTISEMENT,
    attach: (io) => {
      log.attach += 1;
      log.io = io;
    },
    onAck: (a) => log.acks.push(a),
    handleMessage: (m) => log.messages.push(m),
    handleMalformed: (message, detail) => log.malformed.push({ message, detail }),
    handleFrame: (f) => log.frames.push(f),
    detach: () => {
      log.detach += 1;
    },
  };
  return { endpoint, log };
}

async function connected(options: ConstructorParameters<typeof RemoteEngine>[1] = {}) {
  const { endpoint, log } = recordingEndpoint();
  const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false, ...options });
  const res = await engine.connect();
  expect(res.ok).toBe(true);
  const ws = MockWS.instances.at(-1)!;
  return { engine, ws, log };
}

const sessionAck = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "sessionAck", sessionId: "s-1", isNew: true, isRestored: false, ...extra });

const ACK: DeviceAck = {
  protocolVersion: 1,
  binary: true,
  capabilities: [
    { name: "core.capabilities", version: 1 },
    { name: "gallery.pick", version: 1 },
  ],
};

describe("device endpoint lifetime (RFC 001 §2.5)", () => {
  test("attach on open; dispose() detaches before closing, exactly once", async () => {
    const { engine, log } = await connected();
    expect(log.attach).toBe(1);
    engine.dispose();
    expect(log.detach).toBe(1);
    await tick();
    await tick();
    expect(log.detach).toBe(1);
  });

  test("disconnect() detaches even though the close event arrives later", async () => {
    const { engine, ws, log } = await connected();
    engine.disconnect();
    expect(log.detach).toBe(1);
    await tick();
    expect(ws.readyState).toBe(3);
    expect(log.detach).toBe(1);
  });

  test("a peer close detaches once; the device io stops sending", async () => {
    const { ws, log } = await connected();
    ws.serverClose();
    expect(log.detach).toBe(1);
    const before = ws.sent.length;
    log.io!.sendMessage({ type: "deviceEvent", id: 1, control: { leaseAck: 1 } });
    expect(ws.sent.length).toBe(before);
  });
});

describe("routing", () => {
  test("hello carries the advertisement; sessionAck.device reaches onAck", async () => {
    const { ws, log } = await connected();
    const hello = ws.json().find((m) => m.type === "hello")!;
    expect(hello.device).toEqual(ADVERTISEMENT);
    ws.receive(sessionAck({ device: ACK }));
    expect(log.acks).toEqual([ACK]);
  });

  test("binary frames route as bytes: ArrayBuffer and typed-array views", async () => {
    const { ws, log } = await connected();
    const bytes = new Uint8Array([1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0xaa, 0xbb]);
    ws.receive(bytes.slice().buffer);
    const backing = new Uint8Array(20);
    backing.set(bytes, 3);
    ws.receive(new Uint8Array(backing.buffer, 3, bytes.length));
    expect(log.frames.map((f) => [...f])).toEqual([[...bytes], [...bytes]]);
    // JSON is never mistaken for a frame and vice versa.
    expect(log.messages).toEqual([]);
  });

  test("device messages go to the endpoint; UI messages never do", async () => {
    const { ws, log } = await connected();
    const request = {
      type: "deviceRequest",
      id: 1,
      capability: "gallery.pick",
      version: 1,
      owner: { moduleInstanceId: "m", activationId: 1 },
      lifetime: "activation",
      timeoutMs: 1000,
      initialCredit: 0,
      params: { mediaTypes: ["photo"], maxCount: 1 },
    };
    ws.receive(JSON.stringify(request));
    ws.receive(JSON.stringify({ type: "patch", revision: 1, patches: [] }));
    expect(log.messages).toEqual([request]);
  });

  test("device text breaking the JSON limits (duplicate key) is connection-level: never routed or attributed (D3/D8)", async () => {
    const { ws, log } = await connected();
    ws.receive('{"type":"deviceEvent","id":3,"control":{"grant":1},"id":4}');
    ws.receive('{"type":"deviceEvent","id":3,"control":{"grant":1.0}}');
    expect(log.messages).toEqual([]);
    expect(log.malformed).toEqual([]);
  });

  test("a schema-invalid device message within the limits is attributed to its id (known-id invalid)", async () => {
    const { ws, log } = await connected();
    ws.receive('{"type":"deviceEvent","id":3,"control":{"cancel":false}}');
    expect(log.messages).toEqual([]);
    expect(log.malformed.length).toBe(1);
    expect(log.malformed[0]!.message).toMatchObject({ type: "deviceEvent", id: 3 });
  });

  test("sessionAck.device is validated and intersected with the advertisement", async () => {
    const { ws, log } = await connected();
    ws.receive(
      sessionAck({
        device: {
          protocolVersion: 1,
          binary: true,
          capabilities: [
            { name: "core.capabilities", version: 1 },
            { name: "gallery.pick", version: 1 },
            { name: "mic.record", version: 1 }, // never advertised
          ],
        },
      })
    );
    expect(log.acks).toEqual([
      {
        protocolVersion: 1,
        binary: true,
        capabilities: [
          { name: "core.capabilities", version: 1 },
          { name: "gallery.pick", version: 1 },
        ],
      },
    ]);
  });

  test("duplicate capability names make sessionAck.device invalid: the plane is disabled (D7)", async () => {
    const { ws, log } = await connected();
    ws.receive(
      sessionAck({
        device: {
          protocolVersion: 1,
          binary: true,
          capabilities: [
            { name: "core.capabilities", version: 1 },
            { name: "gallery.pick", version: 1 },
            { name: "gallery.pick", version: 1 },
          ],
        },
      })
    );
    expect(log.acks).toEqual([undefined]);
  });

  test("an ack without core.capabilities@1 disables the plane; binary revisions need the binary profile", async () => {
    const { ws, log } = await connected();
    ws.receive(
      sessionAck({ device: { protocolVersion: 1, binary: true, capabilities: [{ name: "gallery.pick", version: 1 }] } })
    );
    const second = await connected();
    second.ws.receive(sessionAck({ device: { ...ACK, binary: false } }));
    expect(log.acks).toEqual([undefined]);
    expect(second.log.acks).toEqual([
      { protocolVersion: 1, binary: false, capabilities: [{ name: "core.capabilities", version: 1 }] },
    ]);
  });

  test("a malformed sessionAck.device disables the plane (onAck(undefined))", async () => {
    const { ws, log } = await connected();
    ws.receive(sessionAck({ device: { protocolVersion: 1, binary: "yes", capabilities: [] } }));
    expect(log.acks).toEqual([undefined]);
  });

  test("device traffic from a stale socket never reaches the endpoint after reconnect", async () => {
    const { engine, ws: first, log } = await connected();
    first.serverClose();
    await engine.connect();
    const second = MockWS.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(log.attach).toBe(2);
    first.receive('{"type":"deviceEvent","id":1,"control":{"cancel":true}}');
    first.receive(new Uint8Array(14).buffer);
    expect(log.messages).toEqual([]);
    expect(log.frames).toEqual([]);
    second.receive('{"type":"deviceEvent","id":1,"control":{"cancel":true}}');
    expect(log.messages.length).toBe(1);
    engine.dispose();
  });
});

describe("compression policy (RFC 001 §2.3)", () => {
  async function expectUiOnly(extensions: string) {
    MockWS.nextExtensions = extensions;
    const { engine, ws, log } = await connected();
    expect(log.attach).toBe(0);
    const hello = ws.json().find((m) => m.type === "hello")!;
    expect("device" in hello).toBe(false);
    ws.receive(sessionAck({ device: ACK }));
    expect(log.acks).toEqual([]);
    ws.receive('{"type":"deviceEvent","id":1,"control":{"cancel":true}}');
    ws.receive(new Uint8Array(14).buffer);
    expect(log.messages).toEqual([]);
    expect(log.frames).toEqual([]);
    engine.dispose();
    expect(log.detach).toBe(0);
  }

  async function expectDevice(extensions: string) {
    MockWS.nextExtensions = extensions;
    const { engine, ws, log } = await connected();
    expect(log.attach).toBe(1);
    const hello = ws.json().find((m) => m.type === "hello")!;
    expect(hello.device).toEqual(ADVERTISEMENT);
    engine.dispose();
    expect(log.detach).toBe(1);
  }

  test("a socket that negotiated permessage-deflate with context takeover stays UI-only", async () => {
    await expectUiOnly("permessage-deflate; client_max_window_bits");
  });

  test("context takeover in ONE direction is enough to stay UI-only", async () => {
    await expectUiOnly("permessage-deflate; server_no_context_takeover");
    await expectUiOnly("permessage-deflate; client_no_context_takeover");
    await expectUiOnly("permessage-deflate");
  });

  test("per-message DEFLATE (both no-context-takeover params) keeps the device plane", async () => {
    // Bun's answer, byte for byte, then variations: order, case, spacing, window bits.
    await expectDevice("permessage-deflate; client_no_context_takeover; server_no_context_takeover");
    await expectDevice("permessage-deflate; server_no_context_takeover; client_no_context_takeover");
    await expectDevice("Permessage-Deflate;SERVER_NO_CONTEXT_TAKEOVER ; Client_No_Context_Takeover");
    await expectDevice(
      "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10"
    );
    await expectDevice("");
  });

  test("params are judged per extension, not by substring across the header", async () => {
    // Each param appears somewhere, but no single permessage-deflate carries both.
    await expectUiOnly(
      "permessage-deflate; server_no_context_takeover, permessage-deflate; client_no_context_takeover"
    );
    // A param name hidden inside a quoted value (even after a comma) does not count.
    await expectUiOnly('permessage-deflate; server_no_context_takeover; x="a, client_no_context_takeover"');
    // A quoted comma does not split the extension: this one is still per-message.
    await expectDevice('permessage-deflate; x="a, b"; server_no_context_takeover; client_no_context_takeover');
    // A parameter WITH a value is invalid per RFC 7692: fail closed.
    await expectUiOnly("permessage-deflate; server_no_context_takeover=1; client_no_context_takeover");
    // An unknown deflate-style extension: fail closed.
    await expectUiOnly("x-webkit-deflate-frame");
    // Malformed (unterminated quote): fail closed.
    await expectUiOnly('permessage-deflate; server_no_context_takeover; client_no_context_takeover; x="');
  });
});

describe("session resume token (RFC 001 §5)", () => {
  test("stored from sessionAck, surfaced to the app, and sent only when resuming", async () => {
    const infos: SessionInfo[] = [];
    const { engine, ws } = await connected();
    engine.onSessionEstablished((i) => infos.push(i));
    const firstHello = ws.json().find((m) => m.type === "hello")!;
    expect("resumeToken" in firstHello).toBe(false);
    ws.receive(sessionAck({ resumeToken: "secret-token" }));
    expect(infos[0]!.resumeToken).toBe("secret-token");
    ws.serverClose();
    await engine.connect();
    const hello = MockWS.instances.at(-1)!.json().find((m) => m.type === "hello")!;
    expect(hello.sessionId).toBe("s-1");
    expect(hello.resumeToken).toBe("secret-token");
    engine.dispose();
  });

  test("a token supplied with session.id is sent on the first hello; sessionExpired clears it", async () => {
    const { engine, ws } = await connected({ session: { id: "s-9", resumeToken: "tok-9" } });
    const hello = ws.json().find((m) => m.type === "hello")!;
    expect(hello).toMatchObject({ sessionId: "s-9", resumeToken: "tok-9" });
    ws.receive(JSON.stringify({ type: "sessionExpired", reason: "expired" }));
    ws.serverClose();
    await engine.connect();
    const next = MockWS.instances.at(-1)!.json().find((m) => m.type === "hello")!;
    expect("resumeToken" in next).toBe(false);
    engine.dispose();
  });

  test("a sessionAck without a token clears a stale one", async () => {
    const { engine, ws } = await connected({ session: { id: "s-9", resumeToken: "tok-9" } });
    ws.receive(sessionAck({ sessionId: "s-10" }));
    ws.serverClose();
    await engine.connect();
    const next = MockWS.instances.at(-1)!.json().find((m) => m.type === "hello")!;
    expect(next.sessionId).toBe("s-10");
    expect("resumeToken" in next).toBe(false);
    engine.dispose();
  });
});
