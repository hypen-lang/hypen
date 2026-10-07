/**
 * Device Capability Protocol — RemoteServer defaults and admission
 * (RFC 001 §5 / Phase S), device plane always on.
 *
 * Real Bun servers on ephemeral ports:
 *   - a plain `RemoteServer` (no device call at all) negotiates a device
 *     plane for a client whose hello offers `device`;
 *   - `disableDevice()` is the one opt-out: UI-only, compression unchanged;
 *   - no allowlist / authenticator ⇒ every client admitted + ONE warning;
 *   - `syncActions()` keeps the device plane on: the dispatching client's
 *     device request goes out, the replayed copy on the other session is
 *     refused with `unavailable` / `syncActions.replay`, no warning;
 *   - compression (default, or explicit `true`) is per message and keeps the
 *     device plane on, no warning;
 *   - a configured allowlist still rejects a cross-origin upgrade with 403.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { app } from "../packages/core/src/app";
import { configureLogger } from "../packages/core/src/logger";
import { RemoteServer, OPEN_ADMISSION_WARNING } from "../packages/server/src/remote/server";
import type { RemoteSession } from "../packages/core/src/remote/remote-session";

const counter = app.defineState({ count: 0 }).build();
// Port 0: the OS picks a free port, so parallel suites never collide.
const port = () => 0;
const boundPort = (server: RemoteServer) =>
  (server as unknown as { server: { port: number } }).server.port;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEVICE_HELLO = {
  type: "hello",
  device: {
    protocolVersions: [1],
    binary: true,
    capabilities: [
      { name: "core.capabilities", versions: [1] },
      { name: "permission.query", versions: [1] },
    ],
  },
};

/** Capture `warn`-level framework log lines until `restore()`. */
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

let restoreLog: (() => void) | null = null;
afterEach(() => {
  restoreLog?.();
  restoreLog = null;
});

const upgradeHeaders = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

/** Parse one negotiated permessage-deflate's params (lower-cased names). */
function deflateParams(extensions: string): string[] {
  const [name, ...params] = extensions.split(";").map((p) => p.trim().toLowerCase());
  expect(name).toBe("permessage-deflate");
  return params;
}

/** Open a socket, send a device-offering hello, and collect the ack. */
async function helloWithDevice(server: RemoteServer, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${boundPort(server)}/`, { headers } as unknown as string[]);
  const messages: any[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") messages.push(JSON.parse(ev.data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  ws.send(JSON.stringify(DEVICE_HELLO));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !messages.some((m) => m.type === "initialTree")) await sleep(5);
  const ack = messages.find((m) => m.type === "sessionAck");
  const sessions = (server as unknown as { _wsToSession: Map<unknown, RemoteSession> })._wsToSession;
  const session = [...sessions.values()].at(-1)!;
  return { ws, messages, ack, session };
}

describe("device plane on by default", () => {
  test("no device call at all: a device-offering hello gets a device plane", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"], webClient: false });
    await server.listen(port());
    try {
      const c = await helloWithDevice(server, { Origin: "http://app.example" });
      expect(c.ack?.device).toBeDefined();
      expect(typeof c.ack?.resumeToken).toBe("string");
      expect(c.session.deviceBroker).not.toBeNull();
      // Bun's client offers DEFLATE; the default server compresses one
      // message at a time, on the very socket that carries the device plane.
      expect(deflateParams(c.ws.extensions)).toEqual(
        expect.arrayContaining(["server_no_context_takeover", "client_no_context_takeover"])
      );
      c.ws.close();
    } finally {
      server.stop();
    }
  });

  test("disableDevice() opts out: UI-only session, compression unchanged", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"], webClient: false })
      .disableDevice();
    await server.listen(port());
    try {
      const c = await helloWithDevice(server, { Origin: "http://app.example" });
      expect(c.ack).toBeDefined();
      expect(c.ack.device).toBeUndefined();
      expect(c.session.deviceBroker).toBeNull();
      // The resume credential is still issued (UI-only sessions ignore it).
      expect(typeof c.ack.resumeToken).toBe("string");
      c.ws.close();

      // A UI-only server negotiates the same per-message permessage-deflate.
      const res = await fetch(`http://127.0.0.1:${boundPort(server)}/`, {
        headers: {
          ...upgradeHeaders,
          Origin: "http://app.example",
          "Sec-WebSocket-Extensions": "permessage-deflate",
        },
      });
      expect(res.status).toBe(101);
      expect(deflateParams(res.headers.get("sec-websocket-extensions") ?? "")).toEqual(
        expect.arrayContaining(["server_no_context_takeover", "client_no_context_takeover"])
      );
    } finally {
      server.stop();
    }
  });
});

describe("never refuses to start over device prerequisites", () => {
  test("no allowlist / authenticator: starts, admits any client, ONE warning", async () => {
    const log = captureWarnings();
    restoreLog = log.restore;
    const server = new RemoteServer().module("Counter", counter).ui('Text("hi")').config({ webClient: false });
    await server.listen(port());
    try {
      expect(log.warnings.filter((w) => w === OPEN_ADMISSION_WARNING)).toHaveLength(1);
      // Any Origin and no Origin are both admitted…
      const url = `http://127.0.0.1:${boundPort(server)}/`;
      expect((await fetch(url, { headers: { ...upgradeHeaders, Origin: "http://any.example" } })).status).toBe(101);
      expect((await fetch(url, { headers: upgradeHeaders })).status).toBe(101);
      // …and a device-offering client still gets its device plane.
      const c = await helloWithDevice(server);
      expect(c.ack?.device).toBeDefined();
      c.ws.close();
      // Still exactly one admission warning.
      expect(log.warnings.filter((w) => w === OPEN_ADMISSION_WARNING)).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("syncActions(): device plane stays on (no warning); a replayed dispatch cannot start device work", async () => {
    const log = captureWarnings();
    restoreLog = log.restore;
    const results: any[] = [];
    const asker = app
      .defineState({ n: 0 })
      .onAction("ask", async ({ context }) => {
        results.push(await context.device.request("permission.query", { permission: "camera" }));
      })
      .build();
    const server = new RemoteServer()
      .module("Asker", asker)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://localhost:1234"], webClient: false })
      .syncActions();
    await server.listen(port());
    try {
      expect(log.warnings.filter((w) => w.includes("Device plane off"))).toHaveLength(0);
      const a = await helloWithDevice(server, { Origin: "http://localhost:1234" });
      const b = await helloWithDevice(server, { Origin: "http://localhost:1234" });
      expect(a.ack.device).toBeDefined();
      expect(b.ack.device).toBeDefined();
      expect(a.session.deviceBroker).not.toBeNull();
      expect(b.session.deviceBroker).not.toBeNull();

      // A dispatches; the same action is replayed onto B's session.
      a.ws.send(JSON.stringify({ type: "dispatchAction", module: "Asker", action: "ask" }));
      const isAsk = (m: any) => m.type === "deviceRequest" && m.capability === "permission.query";
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (!a.messages.some(isAsk) || results.length < 1)) await sleep(5);

      // B's replayed handler was refused at once, and nothing reached B's client.
      expect(results).toEqual([
        { ok: false, error: { code: "unavailable", platformDetail: "syncActions.replay" } },
      ]);
      expect(b.messages.some(isAsk)).toBe(false);

      // A — the client that actually dispatched — got the request; its answer completes it.
      const req = a.messages.find(isAsk);
      expect(req).toBeDefined();
      a.ws.send(JSON.stringify({ type: "deviceResponse", id: req.id, result: { status: "granted" } }));
      while (Date.now() < deadline && results.length < 2) await sleep(5);
      expect(results[1]).toEqual({ ok: true, value: { status: "granted" } });

      a.ws.close();
      b.ws.close();
      await sleep(20);
      expect(
        log.warnings.filter((w) => w.includes("Device plane off") || w.includes("device plane refused"))
      ).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("explicit compression: true is per message: device plane on, no warning", async () => {
    const log = captureWarnings();
    restoreLog = log.restore;
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"], compression: true, webClient: false });
    await server.listen(port());
    try {
      expect(log.warnings.filter((w) => w.includes("Device plane off"))).toHaveLength(0);
      const c = await helloWithDevice(server, { Origin: "http://app.example" });
      expect(c.ack.device).toBeDefined();
      expect(c.session.deviceBroker).not.toBeNull();
      expect(deflateParams(c.ws.extensions)).toEqual(
        expect.arrayContaining(["server_no_context_takeover", "client_no_context_takeover"])
      );
      c.ws.close();
    } finally {
      server.stop();
    }
  });

  test("compression: false: uncompressed socket, device plane on", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"], compression: false, webClient: false });
    await server.listen(port());
    try {
      const c = await helloWithDevice(server, { Origin: "http://app.example" });
      expect(c.ack.device).toBeDefined();
      expect(c.ws.extensions).toBe("");
      c.ws.close();
      await sleep(20);
    } finally {
      server.stop();
    }
  });

  test("allow-multiple still turns the device plane off, with one warning", async () => {
    const log = captureWarnings();
    restoreLog = log.restore;
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .session({ concurrent: "allow-multiple" })
      .config({ allowedOrigins: ["http://app.example"], webClient: false });
    await server.listen(port());
    try {
      const deviceWarnings = log.warnings.filter((w) => w.includes("Device plane off"));
      expect(deviceWarnings).toHaveLength(1);
      expect(deviceWarnings[0]).toContain("allow-multiple");
      const c = await helloWithDevice(server, { Origin: "http://app.example" });
      expect(c.ack.device).toBeUndefined();
      c.ws.close();
      await sleep(20);
    } finally {
      server.stop();
    }
  });
});

describe("Origin allowlist at the WebSocket upgrade (enforced when configured)", () => {
  test("cross-origin upgrade → 403; missing Origin → 403; listed origin admitted", async () => {
    const server = new RemoteServer()
      .module("Counter", counter)
      .ui('Text("hi")')
      .config({ allowedOrigins: ["http://app.example"] });
    await server.listen(port());
    const p = boundPort(server);
    try {
      const evil = await fetch(`http://127.0.0.1:${p}/`, {
        headers: { ...upgradeHeaders, Origin: "http://evil.example" },
      });
      expect(evil.status).toBe(403);

      const noOrigin = await fetch(`http://127.0.0.1:${p}/`, { headers: upgradeHeaders });
      expect(noOrigin.status).toBe(403);

      // A listed origin completes the upgrade and gets the session handshake.
      const ws = new WebSocket(`ws://127.0.0.1:${p}/`, {
        headers: { Origin: "http://app.example" },
      } as unknown as string[]);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("error", () => resolve(false));
        setTimeout(() => resolve(false), 2000);
      });
      expect(opened).toBe(true);
      ws.close();
    } finally {
      server.stop();
    }
  });
});
