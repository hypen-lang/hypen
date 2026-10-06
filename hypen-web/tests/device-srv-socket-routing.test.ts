/**
 * Device Capability Protocol — every client → server device message reaches
 * the Rust broker, over a REAL WebSocket (RFC 001 §2.1, decisions D4/D8).
 *
 * A listening `RemoteServer` (device plane on by default) is driven by a raw Bun
 * WebSocket client speaking the wire protocol by hand, so it can send what
 * no well-behaved client would:
 *
 *   - `violation-request-from-client`: a client `deviceRequest` reusing a
 *     live server id is a wrong-direction message — the server cancels that
 *     request and the handler settles `invalidParams`; the plane stays up. A
 *     client `deviceRequest` for an unknown id is ignored (no violation).
 *   - JSON-limit breakers of EVERY device type — including text `JSON.parse`
 *     rejects outright (`NaN`, a truncated message) and client
 *     `deviceRequest`s — count against the connection's violation budget;
 *     well-formed UI traffic does not. Exhausting the budget closes the
 *     socket with 1012.
 *
 * Plus the pieces underneath: `isDeviceTypedText` (the pre-parse routing
 * decision) and the pre-parsed-object path of `RemoteSession.receive` used by
 * custom transports.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app } from "@hypen-space/core";
import { RemoteSession, type SessionHost } from "@hypen-space/core/remote";
import { isDeviceTypedText, type DeviceResult } from "@hypen-space/core/remote/device";
import { RemoteServer } from "../packages/server/src/remote/server";
import { CAPS_ALL, deviceHello, flush, makeHost, makeTransport } from "./device-srv-harness";

const ORIGIN = "http://routing.test";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the server's handler saw, per connection tag. */
const results = new Map<string, DeviceResult<unknown>>();

const module = app
  .defineState({ n: 0 })
  .onAction<{ tag: string }>("query", async ({ action, context }) => {
    const r = await context!.device.permissions.query("microphone");
    results.set(action.payload!.tag, r as DeviceResult<unknown>);
  })
  .build();

let server: RemoteServer;
let url = "";

beforeAll(async () => {
  server = new RemoteServer()
    .module("App", module)
    .ui('Text("routing")')
    .config({ allowedOrigins: [ORIGIN], webClient: false });
  await server.listen(0);
  const port = (server as unknown as { server: { port: number } }).server.port;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(() => {
  server?.stop();
});

/** The server-side session behind the most recently opened socket. */
function newestSession(): RemoteSession {
  const map = (server as unknown as { _wsToSession: Map<unknown, RemoteSession> })._wsToSession;
  const all = [...map.values()];
  return all[all.length - 1]!;
}

type Client = {
  ws: WebSocket;
  messages: any[];
  closed: Promise<{ code: number }>;
  send: (text: string) => void;
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
  session: RemoteSession;
};

async function connect(): Promise<Client> {
  const ws = new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const messages: any[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") messages.push(JSON.parse(ev.data));
  });
  const closed = new Promise<{ code: number }>((resolve) =>
    ws.addEventListener("close", (ev) => resolve({ code: ev.code }))
  );
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const waitFor = async (pred: (m: any) => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error("timed out waiting for a server message");
  };
  ws.send(
    JSON.stringify({
      type: "hello",
      device: {
        protocolVersions: [1],
        binary: true,
        capabilities: [
          { name: "core.capabilities", versions: [1] },
          { name: "permission.query", versions: [1] },
        ],
      },
    })
  );
  const ack = await waitFor((m) => m.type === "sessionAck");
  expect(ack.device).toBeDefined();
  // The plane is up once the connection-owned core.capabilities stream opened.
  await waitFor((m) => m.type === "deviceRequest" && m.capability === "core.capabilities");
  const session = newestSession();
  expect(session.deviceBroker).not.toBeNull();
  return { ws, messages, closed, send: (t) => ws.send(t), waitFor, session };
}

/** Let the server process everything sent so far (one echo round trip). */
async function drain(c: Client) {
  const marker = `m${Math.random()}`;
  c.send(JSON.stringify({ type: "dispatchAction", action: "noop", payload: { marker } }));
  await sleep(30);
}

describe("client deviceRequest reaches the broker (real socket)", () => {
  test("violation-request-from-client: a live id is cancelled and settles invalidParams; the plane stays up", async () => {
    const c = await connect();
    try {
      c.send(JSON.stringify({ type: "dispatchAction", action: "query", payload: { tag: "echo" } }));
      const req = await c.waitFor((m) => m.type === "deviceRequest" && m.capability === "permission.query");
      const broker = c.session.deviceBroker!;
      const violationsBefore = broker.connectionViolations;

      // The client sends the server's own request back (wrong direction).
      c.send(JSON.stringify(req));

      const cancel = await c.waitFor(
        (m) => m.type === "deviceEvent" && m.id === req.id && m.control?.cancel === true
      );
      expect(cancel).toEqual({ type: "deviceEvent", id: req.id, control: { cancel: true } });
      const deadline = Date.now() + 5_000;
      while (!results.has("echo") && Date.now() < deadline) await sleep(5);
      const r = results.get("echo")!;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("invalidParams");
      // Known-id reaction, not a connection-level violation; the plane is up.
      expect(broker.connectionViolations).toBe(violationsBefore);
      expect(c.session.deviceBroker).toBe(broker);
      expect(broker.isLive(req.id)).toBe(false);

      // A client deviceRequest for an unknown / retired id is simply ignored.
      c.send(JSON.stringify({ ...req, id: 999 }));
      c.send(JSON.stringify(req));
      await drain(c);
      expect(broker.connectionViolations).toBe(violationsBefore);
      expect(c.session.deviceBroker).toBe(broker);
    } finally {
      c.ws.close();
    }
  });
});

describe("JSON-limit breakers of every device type count against the connection budget (real socket)", () => {
  const BREAKERS: Array<[string, string]> = [
    ["deviceEvent with NaN (JSON.parse rejects it)", `{"type":"deviceEvent","id":9,"event":{"x":NaN}}`],
    ["truncated deviceResponse (JSON.parse rejects it)", `{"type":"deviceResponse","id":9,`],
    ["deviceResponse with a fraction", `{"type":"deviceResponse","id":9,"result":{"a":1.0}}`],
    ["deviceRequest with a duplicate key", `{"type":"deviceRequest","id":9,"id":9}`],
    ["deviceRequest with Infinity (JSON.parse rejects it)", `{"type":"deviceRequest","id":Infinity}`],
    ["deviceRequest, unattributable", `{"type":"deviceRequest"}`],
    ["escaped device type with a bare token", `{"type":"device\\u0045vent","id":tru}`],
    ["duplicated type (a lenient parser would read it as UI)", `{"type":"deviceEvent","type":"noop"}`],
  ];

  test("each breaker is one connection-level violation; well-formed UI traffic is not", async () => {
    const c = await connect();
    try {
      const broker = c.session.deviceBroker!;
      let expected = broker.connectionViolations;
      for (const [label, text] of BREAKERS) {
        c.send(text);
        await drain(c);
        expected += 1;
        expect({ label, violations: broker.connectionViolations }).toEqual({ label, violations: expected });
      }
      // UI messages (well-formed, non-device `type`) never count.
      c.send(JSON.stringify({ type: "dispatchAction", action: "noop" }));
      c.send(JSON.stringify({ type: "subscribeState" }));
      c.send(JSON.stringify({ type: "somethingNew", payload: [1, 2, 3] }));
      await drain(c);
      expect(broker.connectionViolations).toBe(expected);
      expect(c.session.deviceBroker).toBe(broker);
    } finally {
      c.ws.close();
    }
  });

  test("a flood of device text JSON.parse rejects exhausts the budget: the socket is closed 1012", async () => {
    const c = await connect();
    for (let i = 0; i < 64; i++) c.send(`{"type":"deviceEvent","id":${i + 2},"event":{"x":NaN}}`);
    const closed = await Promise.race([c.closed, sleep(5_000).then(() => null)]);
    expect(closed).not.toBeNull();
    expect(closed!.code).toBe(1012);
  });

  test("a flood of client deviceRequests for unknown ids is ignored (never a violation)", async () => {
    const c = await connect();
    try {
      const broker = c.session.deviceBroker!;
      const before = broker.connectionViolations;
      for (let i = 0; i < 64; i++) {
        c.send(
          JSON.stringify({
            type: "deviceRequest",
            id: 1000 + i,
            capability: "permission.query",
            version: 1,
            owner: { moduleInstanceId: "x", activationId: 1 },
            lifetime: "activation",
            timeoutMs: 30000,
            initialCredit: 0,
            params: { permission: "microphone" },
          })
        );
      }
      await drain(c);
      expect(broker.connectionViolations).toBe(before);
      expect(c.session.deviceBroker).toBe(broker);
      const early = await Promise.race([c.closed, sleep(50).then(() => null)]);
      expect(early).toBeNull();
    } finally {
      c.ws.close();
    }
  });
});

describe("isDeviceTypedText (the pre-parse routing decision)", () => {
  test("device types by their raw top-level `type`, escaped spellings and malformed text included", () => {
    for (const text of [
      `{"type":"deviceRequest","id":1}`,
      `{"type":"deviceResponse"}`,
      `{"id":1,"type":"deviceEvent"}`,
      `{ "t\\u0079pe" : "device\\u0045vent" }`,
      `{"type":"deviceEvent","id":NaN}`,
      `{"type":"deviceEvent",`,
      // Unscannable / ambiguous: hostile on a device connection.
      `{"type":"deviceEvent","type":"noop"}`,
      `{"type":"noop","type":"deviceEvent"}`,
      `{"type":"dispatchAction",1}`,
      `[1,2]`,
      `garbage`,
      `{"type":"dev\\x"}`,
    ]) {
      expect({ text, device: isDeviceTypedText(text) }).toEqual({ text, device: true });
    }
  });

  test("well-formed UI messages and messages without `type` are not device text", () => {
    for (const text of [
      `{"type":"dispatchAction","action":"a","payload":{"type":"deviceEvent"}}`,
      `{"type":"hello","device":{"protocolVersions":[1]}}`,
      `{"type":"subscribeState"}`,
      `{"type":5}`,
      `{"type":"deviceEventX"}`,
      `{"id":1}`,
      `{}`,
      // Malformed later on, but its `type` is plainly a UI one.
      `{"type":"dispatchAction","x":NaN}`,
    ]) {
      expect({ text, device: isDeviceTypedText(text) }).toEqual({ text, device: false });
    }
  });
});

describe("RemoteSession.receive: pre-parsed device messages (custom transports)", () => {
  test("a pre-parsed client deviceRequest on a live id is routed: cancel + invalidParams", async () => {
    let result: DeviceResult<unknown> | null = null;
    const mod = app
      .defineState({})
      .onAction("q", async ({ context }) => {
        result = (await context!.device.permissions.query("camera")) as DeviceResult<unknown>;
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(mod), t.transport, { helloGraceMs: null });
    // Pre-parsed hello too: negotiated from its JSON form.
    await session.receive(deviceHello([...CAPS_ALL, { name: "permission.query", versions: [1] }]) as any);
    await session.ready;
    await flush();
    expect(session.deviceBroker).not.toBeNull();
    await session.receive({ type: "dispatchAction", action: "q" } as any);
    await flush();
    const req = t.device.find((m: any) => m.type === "deviceRequest" && m.capability === "permission.query") as any;
    expect(req).toBeDefined();
    await session.receive(req);
    for (let i = 0; i < 20 && result === null; i++) await flush();
    expect(t.device.some((m: any) => m.type === "deviceEvent" && m.id === req.id && m.control?.cancel === true)).toBe(
      true
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    expect(session.deviceBroker).not.toBeNull();
    await session.destroy();
  });

  test("device text on a connection without a device plane is dropped, never parsed into UI handling", async () => {
    const seen: unknown[] = [];
    const mod = app
      .defineState({})
      .onAction("deviceEvent", ({ action }) => {
        seen.push(action);
      })
      .build() as unknown as SessionHost["module"];
    const t = makeTransport();
    const session = new RemoteSession(makeHost(mod, { deviceDisabled: true }), t.transport, { helloGraceMs: null });
    await session.receive(JSON.stringify(deviceHello()));
    await session.ready;
    await flush();
    expect(session.deviceBroker).toBeNull();
    await session.receive(`{"type":"deviceRequest","id":1}`);
    await session.receive(`{"type":"deviceEvent","id":1,"event":{}}`);
    await flush();
    expect(seen).toEqual([]);
    expect(t.device.length).toBe(0);
    expect(t.closes).toEqual([]);
    await session.destroy();
  });
});
