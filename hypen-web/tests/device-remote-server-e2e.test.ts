/**
 * Device Capability Protocol — TypeScript server end to end over a REAL
 * WebSocket (RFC 001; round-4 "tests every SDK must have").
 *
 * A listening `RemoteServer` (device plane on by default) — whose device plane runs
 * on the Rust `DeviceBroker` through wasm-node — is driven by the TS web
 * client exactly as an app would: `RemoteEngine` + `FakeDeviceHost` (the
 * `DeviceClient` runtime with scripted drivers) over a real socket. Covered:
 *
 *   - admission: foreign Origin → refused, no credentials → refused, listed
 *     Origin admitted, native client (no Origin) admitted by `authenticate`
 *     with a device plane;
 *   - handshake: `sessionAck.device`, `resumeToken`, `core.capabilities`
 *     opened first;
 *   - `supports`, `permission.query` (granted + denied status);
 *   - `gallery.pick` upload with hash verification on the server;
 *   - `file.save` download (bytes + hash checked on the client);
 *   - `bluetooth.scan` JSON events + handler cancel reaching the client;
 *   - `mic.record` binary data stream (bytes + hash + duration);
 *   - `AbortSignal` cancel of an in-flight request from another action;
 *   - lease renewals while a client driver holds a request past 5 s;
 *   - `resumeToken` resume: wrong token → new session; issued token → same
 *     session, rotated token, a fresh working device plane.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app } from "@hypen-space/core";
import { RemoteEngine, type SessionInfo } from "../packages/core/src/remote/client";
import {
  sha256Hex,
  type DeviceAck,
  type DeviceClientTransport,
  type DeviceEndpoint,
  type DeviceEvent,
} from "@hypen-space/core/remote/device";
import { FakeDeviceHost } from "../packages/device-fake/src/index.ts";
import { RemoteServer } from "../packages/server/src/remote/server";

const ORIGIN = "http://app.e2e";
const AUTH = { Authorization: "Bearer e2e" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- deterministic payloads -------------------------------------------------

const photo = new Uint8Array(100_000).map((_, i) => (i * 31 + 7) & 0xff);
const pcmChunks = [0, 1, 2, 3].map((c) => new Uint8Array(3200).map((_, i) => (i + c * 13) & 0xff));
const pcmAll = (() => {
  const all = new Uint8Array(pcmChunks.reduce((n, x) => n + x.byteLength, 0));
  let o = 0;
  for (const x of pcmChunks) {
    all.set(x, o);
    o += x.byteLength;
  }
  return all;
})();
const saveBytes = new TextEncoder().encode("hypen-e2e-save ".repeat(10_000)); // 150 KB, > one 64 KiB frame

// ---- the server ---------------------------------------------------------------

/** What the server's handlers observed (asserted alongside the client's view). */
const serverSeen = {
  authCalls: 0,
  pickedBytes: null as Uint8Array | null,
  scanEvents: [] as string[],
  recordChunks: 0,
};
let slowPick: AbortController | null = null;
const code = (r: any) => r.error.code as string;

const STATE_KEYS = [
  "supports",
  "query",
  "queryMic",
  "pick",
  "save",
  "scan",
  "record",
  "slowPick",
  "slowRequest",
  "queryResumed",
] as const;

const deviceModule = app
  .defineState<Record<string, string>>(Object.fromEntries(STATE_KEYS.map((k) => [k, ""])))
  .onAction("e2eSupports", ({ state, context }) => {
    const d = context!.device;
    state.supports = `${d.supports("gallery.pick")},${d.supports("mic.record")},${d.supports("camera.capture")}`;
  })
  .onAction<{ permission: "camera" | "microphone"; key?: string }>("e2eQuery", async ({ action, state, context }) => {
    const p = action.payload!;
    const r = await context!.device.permissions.query(p.permission);
    const out = r.ok ? r.value.status : code(r);
    if (p.key === "queryResumed") state.queryResumed = out;
    else if (p.permission === "microphone") state.queryMic = out;
    else state.query = out;
  })
  .onAction("e2ePick", async ({ state, context }) => {
    const r = await context!.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    if (!r.ok) {
      state.pick = code(r);
      return;
    }
    const it = r.value.items[0]!;
    serverSeen.pickedBytes = it.bytes.slice();
    state.pick = `${it.bytes.byteLength}:${await sha256Hex(it.bytes)}:${it.contentType}`;
  })
  .onAction("e2eSave", async ({ state, context }) => {
    const r = await context!.device.save(saveBytes, { name: "e2e.txt", contentType: "text/plain" });
    state.save = r.ok ? String(r.value.bytesWritten) : code(r);
  })
  .onAction("e2eScan", async ({ state, context }) => {
    const ids: string[] = [];
    const h = context!.device.stream("bluetooth.scan", {}, {}, (ev: any) => {
      ids.push(ev.device.id);
      serverSeen.scanEvents.push(ev.device.id);
      if (ids.length === 2) h.cancel();
    });
    const r = await h.settled;
    state.scan = !r.ok && r.error.code === "cancelled" ? ids.join(",") : `unexpected:${JSON.stringify(r)}`;
  })
  .onAction("e2eRecord", async ({ state, context }) => {
    const parts: Uint8Array[] = [];
    const h = context!.device.mic.record({ format: "pcm16", sampleRate: 8000 }, (c: Uint8Array) => {
      serverSeen.recordChunks++;
      parts.push(c.slice());
    });
    const r = await h.settled;
    if (!r.ok) {
      state.record = code(r);
      return;
    }
    const all = new Uint8Array(parts.reduce((n, x) => n + x.byteLength, 0));
    let o = 0;
    for (const x of parts) {
      all.set(x, o);
      o += x.byteLength;
    }
    const hash = await sha256Hex(all);
    const item = (r.value as any).item;
    state.record =
      hash === item.sha256 && all.byteLength === item.bytes
        ? `${all.byteLength}:${hash}:${(r.value as any).durationMs}`
        : "mismatch";
  })
  .onAction("e2eSlowPick", async ({ state, context }) => {
    slowPick = new AbortController();
    const r = await context!.device.request(
      "gallery.pick",
      { mediaTypes: ["photo"], maxCount: 1 },
      { signal: slowPick.signal }
    );
    state.slowPick = r.ok ? "unexpected success" : code(r);
  })
  .onAction("e2eCancelPick", () => {
    slowPick?.abort();
  })
  .onAction("e2eSlowRequest", async ({ state, context }) => {
    const r = await context!.device.permissions.request("notifications");
    state.slowRequest = r.ok ? r.value.status : code(r);
  })
  .build();

let server: RemoteServer;
let url = "";

beforeAll(async () => {
  server = new RemoteServer()
    .module("App", deviceModule)
    // Every key is bound: stateUpdate messages ride renders.
    .ui(
      `Column { ${STATE_KEYS.map((k) => `Text("${k}:@{state.${k}}")`).join(" ")} }`
    )
    .config({
      allowedOrigins: [ORIGIN],
      authenticate: (req: Request) => {
        serverSeen.authCalls++;
        return req.headers.get("authorization") === AUTH.Authorization;
      },
      webClient: false,
    });
  await server.listen(0); // the OS picks a free port
  const port = (server as unknown as { server: { port: number } }).server.port;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(() => {
  server?.stop();
});

// ---- the client ---------------------------------------------------------------

type Observed = {
  saved: Uint8Array | null;
  scanCancelled: boolean;
  slowPickCancelled: boolean;
  renewals: Map<number, number>;
  leaseAcks: number;
  requests: string[];
};

function makeHost(observed: Observed) {
  let slow = false;
  const host = new FakeDeviceHost()
    .permissionsReturn({ camera: "granted", microphone: "denied" })
    .driver("permission.request", async ({ cancelled }) => {
      // Held past one 5 s lease interval: the server must renew meanwhile.
      const raced = await Promise.race([sleep(6_500).then(() => "done"), cancelled.then(() => "cancelled")]);
      if (raced === "cancelled") return { kind: "error", code: "cancelled" };
      return { kind: "result", result: { status: "granted" } };
    })
    .driver("gallery.pick", async ({ cancelled }) => {
      if (slow) {
        slow = false;
        await cancelled; // only the server's cancel ends it
        observed.slowPickCancelled = true;
        return { kind: "error", code: "cancelled" };
      }
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }] };
    })
    .driver("file.save", async ({ download }) => {
      const bytes = await download!.receiveAll(); // hash-checked by the runtime
      observed.saved = bytes;
      return { kind: "result", result: { bytesWritten: bytes.byteLength } };
    })
    .driver("bluetooth.scan", async ({ emit, cancelled }) => {
      for (const [i, rssi] of [-40, -55, -70].entries()) {
        emit({ device: { id: `e2e:0${i + 1}`, name: `Beacon ${i + 1}`, rssi } });
        await sleep(20);
      }
      await cancelled;
      observed.scanCancelled = true;
      return { kind: "result", result: {} };
    })
    .micRecords(pcmChunks, { chunkDelayMs: 10 });
  return { host, armSlowPick: () => (slow = true) };
}

/** Wrap the fake endpoint to observe the device traffic (requests, renewLease in, leaseAck out). */
function observing(base: DeviceEndpoint, observed: Observed): DeviceEndpoint & { ack: () => DeviceAck | undefined } {
  let ack: DeviceAck | undefined;
  const note = (text: string) => {
    const m = JSON.parse(text) as { type?: string; id?: number; capability?: string; control?: object };
    if (m.type === "deviceRequest" && m.capability) observed.requests.push(m.capability);
    if (m.type === "deviceEvent" && m.control && "renewLease" in m.control && typeof m.id === "number") {
      observed.renewals.set(m.id, (observed.renewals.get(m.id) ?? 0) + 1);
    }
  };
  return {
    advertisement: base.advertisement,
    attach: (io: DeviceClientTransport) =>
      base.attach({
        sendMessage: (m) => {
          const ctl = (m as DeviceEvent).control as object | undefined;
          if (ctl && "leaseAck" in ctl) observed.leaseAcks++;
          io.sendMessage(m);
        },
        sendBinary: (f) => io.sendBinary(f),
        ...(io.bufferedAmount ? { bufferedAmount: () => io.bufferedAmount!() } : {}),
        ...(io.close ? { close: (c: number, reason: string) => io.close!(c, reason) } : {}),
      }),
    onAck: (a) => {
      ack = a;
      base.onAck(a);
    },
    handleMessage: (m) => base.handleMessage(m),
    handleText: (text: string) => {
      note(text);
      if (base.handleText) base.handleText(text);
      else base.handleMessage(JSON.parse(text));
    },
    handleMalformed: (m, d) => base.handleMalformed?.(m, d),
    handleFrame: (f) => base.handleFrame(f),
    detach: () => base.detach(),
    ack: () => ack,
  };
}

type Conn = {
  engine: RemoteEngine;
  info: SessionInfo;
  waitState: (key: string, timeoutMs?: number) => Promise<unknown>;
  observed: Observed;
  endpoint: ReturnType<typeof observing>;
  armSlowPick: () => void;
};

async function connect(options: {
  headers?: Record<string, string>;
  session?: { id: string; resumeToken?: string };
}): Promise<Conn | null> {
  const observed: Observed = {
    saved: null,
    scanCancelled: false,
    slowPickCancelled: false,
    renewals: new Map(),
    leaseAcks: 0,
    requests: [],
  };
  const { host, armSlowPick } = makeHost(observed);
  const endpoint = observing(host.endpoint(), observed);
  const engine = new RemoteEngine(url, {
    autoReconnect: false,
    device: endpoint,
    headers: options.headers ?? AUTH,
    ...(options.session ? { session: options.session } : {}),
  });
  let latest: Record<string, unknown> = {};
  engine.onStateUpdate((s) => {
    latest = (s ?? {}) as Record<string, unknown>;
  });
  const established = new Promise<SessionInfo>((resolve) => engine.onSessionEstablished(resolve));
  const res = await engine.connect();
  if (!res.ok) {
    engine.dispose();
    return null;
  }
  engine.subscribeState();
  const info = await Promise.race([established, sleep(10_000).then(() => null)]);
  if (!info) throw new Error("no sessionAck");
  const waitState = async (key: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = latest[key];
      if (v !== undefined && v !== "" && v !== null) return v;
      await sleep(10);
    }
    throw new Error(`state.${key} never set`);
  };
  // The device plane is up once the ack reached the endpoint and the
  // connection-owned core.capabilities stream arrived.
  const deadline = Date.now() + 10_000;
  while ((endpoint.ack() === undefined || observed.requests.length === 0) && Date.now() < deadline) await sleep(10);
  return { engine, info, waitState, observed, endpoint, armSlowPick };
}

async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(10);
  return cond();
}

// ---- scenarios ----------------------------------------------------------------

describe("RemoteServer device plane over a real WebSocket (RemoteEngine + FakeDeviceHost)", () => {
  let c: Conn;

  test("admission: foreign Origin and missing credentials are refused; a listed Origin is admitted", async () => {
    const foreign = await connect({ headers: { ...AUTH, Origin: "http://evil.e2e" } });
    expect(foreign).toBeNull();

    const before = serverSeen.authCalls;
    const noCreds = await connect({ headers: {} });
    expect(noCreds).toBeNull();
    expect(serverSeen.authCalls).toBe(before + 1); // the authenticator ran and refused

    const browser = await connect({ headers: { ...AUTH, Origin: ORIGIN } });
    expect(browser).not.toBeNull();
    expect(browser!.endpoint.ack()).toBeDefined();
    browser!.engine.dispose();
  }, 30_000);

  test("a native client (no Origin) admitted by the authenticator gets a device plane", async () => {
    const before = serverSeen.authCalls;
    const conn = await connect({});
    expect(conn).not.toBeNull();
    c = conn!;
    expect(serverSeen.authCalls).toBe(before + 1);
    const ack = c.endpoint.ack()!;
    expect(ack).toBeDefined();
    expect(ack.protocolVersion).toBe(1);
    expect(ack.binary).toBe(true);
    const names = ack.capabilities.map((x) => x.name);
    for (const n of ["core.capabilities", "gallery.pick", "file.save", "bluetooth.scan", "mic.record"]) {
      expect(names).toContain(n);
    }
    // The connection-owned control stream is the first device request.
    expect(c.observed.requests[0]).toBe("core.capabilities");
    // A resume credential: random, >= 128 bits.
    expect(typeof c.info.resumeToken).toBe("string");
    expect(c.info.resumeToken!.length).toBeGreaterThanOrEqual(22);
    expect(c.info.isNew).toBe(true);
  }, 30_000);

  test("supports reflects the negotiated selection", async () => {
    c.engine.dispatchAction("e2eSupports");
    expect(await c.waitState("supports")).toBe("true,true,false");
  });

  test("permission.query answers granted and denied statuses", async () => {
    c.engine.dispatchAction("e2eQuery", { permission: "camera" });
    expect(await c.waitState("query")).toBe("granted");
    c.engine.dispatchAction("e2eQuery", { permission: "microphone" });
    expect(await c.waitState("queryMic")).toBe("denied");
  });

  test("gallery.pick uploads bytes the server verifies by sha256", async () => {
    c.engine.dispatchAction("e2ePick");
    expect(await c.waitState("pick")).toBe(`${photo.byteLength}:${await sha256Hex(photo)}:image/jpeg`);
    expect(serverSeen.pickedBytes).toEqual(photo);
  }, 20_000);

  test("file.save downloads the exact bytes to the client", async () => {
    c.engine.dispatchAction("e2eSave");
    expect(await c.waitState("save")).toBe(String(saveBytes.byteLength));
    expect(c.observed.saved).not.toBeNull();
    expect(await sha256Hex(c.observed.saved!)).toBe(await sha256Hex(saveBytes));
  }, 20_000);

  test("bluetooth.scan delivers JSON events; the handler's cancel reaches the client", async () => {
    c.engine.dispatchAction("e2eScan");
    expect(await c.waitState("scan")).toBe("e2e:01,e2e:02");
    expect(serverSeen.scanEvents.slice(0, 2)).toEqual(["e2e:01", "e2e:02"]);
    expect(await until(() => c.observed.scanCancelled)).toBe(true);
  }, 20_000);

  test("mic.record streams binary data whose bytes and hash match the terminal result", async () => {
    c.engine.dispatchAction("e2eRecord");
    const expectedMs = Math.round((pcmAll.byteLength / 2 / 8000) * 1000);
    expect(await c.waitState("record")).toBe(`${pcmAll.byteLength}:${await sha256Hex(pcmAll)}:${expectedMs}`);
    expect(serverSeen.recordChunks).toBeGreaterThan(0);
  }, 20_000);

  test("an AbortSignal cancel from another action ends the request on both sides", async () => {
    c.armSlowPick();
    c.engine.dispatchAction("e2eSlowPick");
    expect(await until(() => c.observed.requests.filter((r) => r === "gallery.pick").length === 2)).toBe(true);
    c.engine.dispatchAction("e2eCancelPick");
    expect(await c.waitState("slowPick")).toBe("cancelled");
    expect(await until(() => c.observed.slowPickCancelled)).toBe(true);
  }, 20_000);

  test("a request held past the lease interval is renewed and still completes", async () => {
    c.engine.dispatchAction("e2eSlowRequest");
    expect(await c.waitState("slowRequest", 20_000)).toBe("granted");
    const slowId = Math.max(...c.observed.renewals.keys());
    // Held 6.5 s: at least one renewal of the request (5 s cadence) and
    // leaseAcks for it and for the long-lived core.capabilities stream.
    expect(c.observed.renewals.get(slowId) ?? 0).toBeGreaterThanOrEqual(1);
    expect(c.observed.leaseAcks).toBeGreaterThanOrEqual(2);
    expect([...c.observed.renewals.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("resumeToken: a wrong token starts a new session; the issued token resumes with a fresh plane", async () => {
    const { sessionId, resumeToken } = c.info;
    c.engine.dispose();
    await sleep(300);

    const wrong = await connect({ session: { id: sessionId, resumeToken: "wrong-token" } });
    expect(wrong).not.toBeNull();
    expect(wrong!.info.sessionId).not.toBe(sessionId);
    expect(wrong!.info.isNew).toBe(true);
    wrong!.engine.dispose();
    await sleep(300);

    const resumed = await connect({ session: { id: sessionId, resumeToken } });
    expect(resumed).not.toBeNull();
    expect(resumed!.info.sessionId).toBe(sessionId);
    expect(resumed!.info.isRestored).toBe(true);
    expect(resumed!.info.resumeToken).toBeDefined();
    expect(resumed!.info.resumeToken).not.toBe(resumeToken);
    expect(resumed!.endpoint.ack()).toBeDefined();
    expect(resumed!.observed.requests[0]).toBe("core.capabilities");
    // Only this connection's device round trip can fill this key.
    resumed!.engine.dispatchAction("e2eQuery", { permission: "camera", key: "queryResumed" });
    expect(await resumed!.waitState("queryResumed")).toBe("granted");

    // The superseded token no longer resumes (rotated per ack).
    resumed!.engine.dispose();
    await sleep(300);
    const stale = await connect({ session: { id: sessionId, resumeToken } });
    expect(stale).not.toBeNull();
    expect(stale!.info.sessionId).not.toBe(sessionId);
    stale!.engine.dispose();
  }, 60_000);
});
