/**
 * Device Capability Protocol (RFC 001) — cross-language end to end.
 *
 * The TypeScript web client (`RemoteEngine` + `FakeDeviceHost`'s
 * `DeviceEndpoint`, i.e. the real `DeviceClient` runtime) connects over a
 * REAL WebSocket to the Swift `RemoteServer` (`HypenDeviceE2EServer`, NIO +
 * WebSocketKit, device plane on the Rust `DeviceBroker` via UniFFI). The
 * server's handlers use the Swift device API (`ctx.device…`) and report what
 * it returned as `E2E {json}` lines on stderr (its log is on stdout).
 *
 * Run: `Tests/DeviceE2E/run.sh` (builds the server, then `bun test` here).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import net from "node:net";
import { resolve } from "node:path";
import { RemoteEngine, type SessionInfo } from "../../../hypen-web/packages/core/src/remote/client.ts";
import { FakeDeviceHost } from "../../../hypen-web/packages/device-fake/src/index.ts";

const SERVER_BIN =
  process.env.HYPEN_DEVICE_E2E_SERVER ?? resolve(import.meta.dir, "../../.build/debug/HypenDeviceE2EServer");
const AUTH = { Authorization: "Bearer e2e-token" };

// ---------------------------------------------------------------------------
// Server process + report stream
// ---------------------------------------------------------------------------

type Report = Record<string, any> & { tag: string };

let proc: ReturnType<typeof Bun.spawn>;
let port = 0;
const reports: Report[] = [];
let serverLog = "";

async function pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
}

/**
 * The report on a stderr line. The server writes reports on their own
 * stream, away from its (block-buffered) log on stdout, but the marker is
 * matched anywhere in the line anyway: a report glued after a stray
 * unterminated write must not be dropped (a dropped report is a test
 * timeout).
 */
function parseReport(line: string): Report | undefined {
  const at = line.indexOf("E2E {");
  if (at < 0) return undefined;
  return JSON.parse(line.slice(at + 4));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, what: string, timeoutMs = 8000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- server log ---\n${serverLog.slice(-4000)}`);
    await sleep(10);
  }
}

/** The next report with `tag` after position `from`. */
function nextReport(tag: string, from: number, timeoutMs = 8000): Promise<Report> {
  return until(() => reports.slice(from).find((r) => r.tag === tag), `report ${tag}`, timeoutMs);
}

beforeAll(async () => {
  for (let attempt = 0; attempt < 5 && port === 0; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 20000);
    proc = Bun.spawn({
      cmd: [SERVER_BIN, String(candidate)],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    // stdout: the server's log. stderr: its reports (see `report` in
    // Server/main.swift).
    void pump(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      serverLog += line + "\n";
    });
    void pump(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      serverLog += line + "\n";
      const report = parseReport(line);
      if (report) reports.push(report);
    });
    await until(() => reports.find((r) => r.tag === "ready"), "server ready", 15000);
    // The bind itself may have failed (port taken): probe it.
    const ok = await fetch(`http://127.0.0.1:${candidate}/health`).then((r) => r.ok, () => false);
    if (ok) port = candidate;
    else {
      proc.kill();
      reports.length = 0;
    }
  }
  expect(port).toBeGreaterThan(0);
}, 30000);

afterAll(async () => {
  // EOF on stdin stops the server cleanly (it removes its temp components).
  try {
    (proc.stdin as { end(): void }).end();
  } catch {}
  await Promise.race([proc?.exited, sleep(3000)]);
  proc?.kill();
});

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

const url = () => `ws://127.0.0.1:${port}/ws`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The Swift server's `pattern(n)`. */
function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((Math.imul(i, 31) ^ (i >> 8)) & 0xff) >>> 0;
  return out;
}

function randomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Full-featured fake host (every capability the server consumes). */
function fullHost(opts: { galleryDelayMs?: number; photo?: Uint8Array; saved?: Uint8Array[] } = {}) {
  const photo = opts.photo ?? randomBytes(150_000, 7);
  return new FakeDeviceHost()
    .permissionsReturn({ camera: "granted", microphone: "prompt", location: "denied" })
    .galleryReturns(photo, "image/jpeg", opts.galleryDelayMs ?? 0)
    .cameraReturns({ photo: { bytes: randomBytes(4096, 3) } })
    .bluetoothSelects({ id: "hr-1", name: "HR Strap" })
    .micRecords([randomBytes(3200, 11), randomBytes(3200, 12), randomBytes(3200, 13)], { chunkDelayMs: 5 })
    .driver("bluetooth.scan", async ({ emit, cancelled }) => {
      for (let i = 0; i < 5; i++) {
        emit({ device: { id: `dev-${i}`, name: `HR ${i}`, rssi: -40 - i } });
        await sleep(15);
      }
      await cancelled;
      return { kind: "error", code: "cancelled" };
    })
    .driver("file.save", async ({ download }) => {
      const bytes = await download!.receiveAll();
      opts.saved?.push(bytes);
      return { kind: "result", result: { bytesWritten: bytes.byteLength } };
    });
}

interface Client {
  engine: RemoteEngine;
  endpoint: ReturnType<FakeDeviceHost["endpoint"]>;
  /** Every server → client device message the endpoint received. */
  received: any[];
  session: SessionInfo;
  close(): void;
}

async function connect(
  host: FakeDeviceHost,
  extra: ConstructorParameters<typeof RemoteEngine>[1] = {}
): Promise<Client> {
  const endpoint = host.endpoint();
  const received: any[] = [];
  // Record every server → client device message (the endpoint takes the
  // exact text when it decodes strictly itself, else the decoded message).
  const handle = endpoint.handleMessage.bind(endpoint);
  endpoint.handleMessage = (m: any) => {
    received.push(m);
    return handle(m);
  };
  if (endpoint.handleText) {
    const handleText = endpoint.handleText.bind(endpoint);
    endpoint.handleText = (text: string) => {
      received.push(JSON.parse(text));
      return handleText(text);
    };
  }
  const engine = new RemoteEngine(url(), { device: endpoint, autoReconnect: false, headers: AUTH, ...extra });
  let session: SessionInfo | undefined;
  engine.onSessionEstablished((info) => {
    session ??= info;
  });
  const res = await engine.connect();
  expect(res.ok).toBe(true);
  await until(() => session && endpoint.selected, "sessionAck with device");
  // The connection-owned core.capabilities stream opened before anything else.
  await until(() => received.find((m) => m.type === "deviceRequest"), "core.capabilities request");
  return { engine, endpoint, received, session: session!, close: () => engine.dispose() };
}

function requestsFor(c: Client, capability: string): any[] {
  return c.received.filter((m) => m.type === "deviceRequest" && m.capability === capability);
}

/** Raw HTTP upgrade: the status line the server answered with. */
function upgradeStatus(headers: Record<string, string>): Promise<string> {
  return new Promise((resolveStatus, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let data = "";
    socket.on("data", (d) => {
      data += d.toString("latin1");
      const eol = data.indexOf("\r\n");
      if (eol >= 0) {
        resolveStatus(data.slice(0, eol));
        socket.destroy();
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("no upgrade answer")), 5000);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admission (RFC 001 §5, D1)", () => {
  test("a foreign Origin is refused with 403", async () => {
    expect(await upgradeStatus({ Origin: "https://evil.example", ...AUTH })).toBe("HTTP/1.1 403 Forbidden");
  });

  test("no Origin and no credentials is refused (fail closed)", async () => {
    expect(await upgradeStatus({})).toBe("HTTP/1.1 403 Forbidden");
  });

  test("the authenticator also runs for an allowed Origin", async () => {
    expect(await upgradeStatus({ Origin: "https://app.example" })).toBe("HTTP/1.1 403 Forbidden");
    expect(await upgradeStatus({ Origin: "https://APP.example:443", ...AUTH })).toBe(
      "HTTP/1.1 101 Switching Protocols"
    );
  });

  test("a native client (no Origin) is admitted by the authenticator", async () => {
    expect(await upgradeStatus({ ...AUTH })).toBe("HTTP/1.1 101 Switching Protocols");
    expect(await upgradeStatus({ Authorization: "Bearer wrong" })).toBe("HTTP/1.1 403 Forbidden");
  });

  test("RemoteEngine without the bearer token cannot connect", async () => {
    const engine = new RemoteEngine(url(), { device: fullHost().endpoint(), autoReconnect: false });
    const res = await engine.connect();
    expect(res.ok).toBe(false);
    engine.dispose();
  });
});

describe("handshake", () => {
  test("sessionAck carries device + resumeToken; core.capabilities opens first", async () => {
    const c = await connect(fullHost());
    try {
      expect(typeof c.session.resumeToken).toBe("string");
      // 256 random bits, base64url.
      expect(c.session.resumeToken!).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const selected = c.endpoint.selected!;
      expect(selected.protocolVersion).toBe(1);
      expect(selected.binary).toBe(true);
      const names = selected.capabilities.map((s) => s.name);
      for (const n of ["core.capabilities", "gallery.pick", "file.save", "bluetooth.scan", "mic.record"]) {
        expect(names).toContain(n);
      }
      const first = c.received.find((m) => m.type === "deviceRequest");
      expect(first.capability).toBe("core.capabilities");
      expect(first.lifetime).toBe("connection");

      const from = reports.length;
      c.engine.dispatchAction("caps");
      const caps = await nextReport("caps", from);
      expect(caps.supports["gallery.pick"]).toBe(true);
      expect(caps.supports["permission.query"]).toBe(true);
      expect(caps.supports["file.pick"]).toBe(false); // not advertised by this host
      expect(caps.typed).toBe(true);
    } finally {
      c.close();
    }
  });
});

describe("capabilities over the Swift handler API", () => {
  let c: Client;
  const saved: Uint8Array[] = [];
  const photo = randomBytes(150_000, 99);
  beforeAll(async () => {
    c = await connect(fullHost({ photo, saved }));
  });
  afterAll(() => c?.close());

  test("permission.query / permission.request over the typed Permission enum", async () => {
    let from = reports.length;
    c.engine.dispatchAction("perm", { mode: "query", permission: "camera" });
    expect(await nextReport("perm", from)).toMatchObject({ ok: true, status: "granted", simulated: true });

    from = reports.length;
    c.engine.dispatchAction("perm", { mode: "request", permission: "microphone" });
    expect(await nextReport("perm", from)).toMatchObject({ ok: true, status: "prompt" });

    from = reports.length;
    c.engine.dispatchAction("perm", { mode: "query", permission: "contacts" });
    expect(await nextReport("perm", from)).toMatchObject({ ok: false, code: "unsupported", detail: "contacts" });
    expect(requestsFor(c, "permission.query").map((r) => r.params.permission)).toEqual(["camera", "contacts"]);
  });

  test("gallery.pick upload: bytes verified against sha256 end to end", async () => {
    const from = reports.length;
    c.engine.dispatchAction("pick");
    const r = await nextReport("pick", from);
    expect(r).toMatchObject({ ok: true, count: 1, contentType: "image/jpeg", size: photo.byteLength, simulated: true });
    expect(r.sha256).toBe(sha256(photo));
  });

  test("file.save download: the client receives exactly the server's bytes", async () => {
    const from = reports.length;
    c.engine.dispatchAction("save", { size: 300_000 });
    const r = await nextReport("save", from);
    expect(r).toMatchObject({ ok: true, bytesWritten: 300_000 });
    const expected = pattern(300_000);
    expect(r.sha256).toBe(sha256(expected));
    expect(saved.length).toBe(1);
    expect(sha256(saved[0]!)).toBe(sha256(expected));
    const req = requestsFor(c, "file.save").at(-1);
    expect(req.initialCredit).toBe(0);
    expect(req.params).toMatchObject({ channel: 0, name: "report.bin", bytes: 300_000, sha256: sha256(expected) });
  });

  test("bluetooth.scan stream: events via for-await, leaving the loop cancels", async () => {
    const from = reports.length;
    c.engine.dispatchAction("scan", { max: 2 });
    const r = await nextReport("scan", from);
    expect(r.ids).toEqual(["dev-0", "dev-1"]);
    expect(r).toMatchObject({ ok: false, code: "cancelled" });
    await until(
      () => c.received.find((m) => m.type === "deviceEvent" && m.id === r.id && m.control?.cancel === true),
      "scan cancel"
    );
  });

  test("mic.record binary stream: chunks in order, sha256 verified over everything delivered", async () => {
    const from = reports.length;
    c.engine.dispatchAction("mic");
    const r = await nextReport("mic", from);
    const all = new Uint8Array(9600);
    all.set(randomBytes(3200, 11), 0);
    all.set(randomBytes(3200, 12), 3200);
    all.set(randomBytes(3200, 13), 6400);
    expect(r).toMatchObject({ ok: true, bytes: 9600, resultBytes: 9600, durationMs: 300 });
    expect(r.sha256).toBe(sha256(all));
    expect(r.resultSha256).toBe(sha256(all));
    expect(r.chunks).toBeGreaterThanOrEqual(1);
  });

  test("camera.capture and bluetooth.select", async () => {
    let from = reports.length;
    c.engine.dispatchAction("camera");
    expect(await nextReport("camera", from)).toMatchObject({
      ok: true,
      contentType: "image/jpeg",
      size: 4096,
      sha256: sha256(randomBytes(4096, 3)),
    });
    from = reports.length;
    c.engine.dispatchAction("select");
    expect(await nextReport("select", from)).toMatchObject({ ok: true, id: "hr-1", name: "HR Strap" });
    expect(requestsFor(c, "bluetooth.select").at(-1).params).toEqual({ namePrefix: "HR" });
  });
});

describe("download frame ordering over a real socket", () => {
  // The device plane sends a download's frames from the NIO event loop
  // (the pump after a credit grant), the clock's dispatch queue (bulk
  // turns) and handler tasks. A frame written on the loop must never
  // overtake one still queued from another thread: the client rejects an
  // out-of-order frame (`download seq N, expected M`) and the save fails.
  function saveHost(saved: Uint8Array[]) {
    return new FakeDeviceHost().driver("file.save", async ({ download }) => {
      const bytes = await download!.receiveAll();
      saved.push(bytes);
      return { kind: "result", result: { bytesWritten: bytes.byteLength } };
    });
  }

  test(
    "40 back-to-back 300 KB file.save downloads all arrive byte-exact",
    async () => {
      const saved: Uint8Array[] = [];
      const c = await connect(saveHost(saved));
      const expected = sha256(pattern(300_000));
      try {
        const results: Report[] = [];
        for (let i = 0; i < 40; i++) {
          const from = reports.length;
          c.engine.dispatchAction("save", { size: 300_000 });
          results.push(await nextReport("save", from, 15000));
        }
        expect(results.filter((r) => !r.ok)).toEqual([]);
        expect(saved.length).toBe(40);
        for (const bytes of saved) expect(sha256(bytes)).toBe(expected);
      } finally {
        c.close();
      }
    },
    120000
  );

  test(
    "concurrent downloads on 4 connections, 8 each, all arrive byte-exact",
    async () => {
      const clients: { c: Client; saved: Uint8Array[] }[] = [];
      try {
        for (let k = 0; k < 4; k++) {
          const saved: Uint8Array[] = [];
          clients.push({ c: await connect(saveHost(saved)), saved });
        }
        const sizes = [300_000, 131_072, 65_536 * 3 + 17, 200_001];
        const from = reports.length;
        let dispatched = 0;
        for (let round = 0; round < 8; round++) {
          for (const [k, { c }] of clients.entries()) {
            c.engine.dispatchAction("save", { size: sizes[(round + k) % sizes.length] });
            dispatched++;
          }
          await sleep(5);
        }
        const done = await until(
          () => {
            const saves = reports.slice(from).filter((r) => r.tag === "save");
            return saves.length >= dispatched && saves;
          },
          `${dispatched} save reports`,
          60000
        );
        expect(done.filter((r) => !r.ok)).toEqual([]);
        const got = clients.flatMap(({ saved }) => saved.map((b) => sha256(b))).sort();
        const want = clients
          .flatMap((_, k) => Array.from({ length: 8 }, (_, round) => sha256(pattern(sizes[(round + k) % sizes.length]!))))
          .sort();
        expect(got).toEqual(want);
      } finally {
        for (const { c } of clients) c.close();
      }
    },
    120000
  );
});

describe("harness report stream", () => {
  test("reports made while 4 threads flood the log all arrive, as whole lines", async () => {
    const c = await connect(fullHost());
    try {
      const from = reports.length;
      c.engine.dispatchAction("flood", { workers: 4, reports: 60 });
      await nextReport("floodDone", from, 20000);
      const flood = reports.slice(from).filter((r) => r.tag === "flood");
      expect(flood.length).toBe(240);
      const seen = new Set(flood.map((r) => `${r.worker}:${r.i}`));
      expect(seen.size).toBe(240);
      // Every report line is intact, and so is every log line around it.
      const lines = serverLog.split("\n").filter((l) => l.includes("E2E {") || l.includes("[E2ENoise]"));
      for (const l of lines) {
        const isReport = l.startsWith("E2E {");
        const isNoise = /^\[E2ENoise\] DEBUG: line \d+ x+$/.test(l);
        expect(isReport || isNoise ? "whole line" : l).toBe("whole line");
      }
    } finally {
      c.close();
    }
  });
});

describe("cancellation and leases", () => {
  test("Swift Task cancellation cancels the request on the wire", async () => {
    const c = await connect(fullHost({ galleryDelayMs: 3000 }));
    try {
      const from = reports.length;
      c.engine.dispatchAction("pickCancel");
      const r = await nextReport("pickCancel", from);
      expect(r).toMatchObject({ ok: false, code: "cancelled" });
      const req = requestsFor(c, "gallery.pick").at(-1);
      await until(
        () => c.received.find((m) => m.type === "deviceEvent" && m.id === req.id && m.control?.cancel === true),
        "cancel on the wire"
      );
    } finally {
      c.close();
    }
  });

  test(
    "leases are renewed every 5 s while a request is pending",
    async () => {
      const photo = randomBytes(2000, 5);
      const c = await connect(fullHost({ galleryDelayMs: 6500, photo }));
      try {
        const from = reports.length;
        c.engine.dispatchAction("pick");
        const r = await nextReport("pick", from, 15000);
        expect(r).toMatchObject({ ok: true, size: 2000, sha256: sha256(photo) });
        const req = requestsFor(c, "gallery.pick").at(-1);
        const renewals = c.received
          .filter((m) => m.type === "deviceEvent" && m.id === req.id && m.control && "renewLease" in m.control)
          .map((m) => m.control.renewLease);
        // seq 1 at open, seq 2 five seconds later (the client acked seq 1).
        expect(renewals.slice(0, 2)).toEqual([1, 2]);
      } finally {
        c.close();
      }
    },
    20000
  );
});

describe("violations over a real socket (D3/D4/D8)", () => {
  /** Open a slow gallery.pick and return its request id plus the raw socket. */
  async function pickAndSocket(c: Client) {
    c.engine.dispatchAction("pick");
    const req = await until(() => requestsFor(c, "gallery.pick").at(-1), "gallery.pick request");
    const ws: WebSocket = (c.engine as any).ws;
    let closeCode: number | undefined;
    ws.addEventListener("close", (e: any) => {
      closeCode = e.code;
    });
    return { id: req.id as number, ws, closed: () => closeCode };
  }

  function frame(id: number, version: number): Uint8Array {
    const b = new Uint8Array(13);
    const v = new DataView(b.buffer);
    b[0] = version;
    v.setUint32(4, id, true);
    b[12] = 1;
    return b;
  }

  for (const [label, message] of [
    // A duplicated `type` is resolved like JSON.parse (the last one wins),
    // routed to the broker as exact text and counted there — never dropped
    // uncounted on the UI path.
    ["duplicated `type`", (id: number) => `{"type":"deviceEvent","type":"deviceEvent","id":${id},"event":{"kind":"progress","state":"running"}}`],
    ["duplicated `id`", (id: number) => `{"type":"deviceEvent","id":${id},"id":${id},"event":{"kind":"progress","state":"running"}}`],
  ] as const) {
    test(`40 device messages with a ${label} use up the violation budget: the socket is reset 1012`, async () => {
      const c = await connect(fullHost({ galleryDelayMs: 6000 }));
      try {
        const { id, ws, closed } = await pickAndSocket(c);
        for (let i = 0; i < 40; i++) ws.send(message(id));
        await until(() => closed() !== undefined, "socket close", 5000);
        expect(closed()).toBe(1012);
      } finally {
        c.close();
      }
    });
  }

  // Explicit timeout above `nextReport`'s own 8 s: a regression fails on an
  // assertion instead of bun's test timeout (which also kills the server).
  test("a client deviceRequest reaches the broker: ignored on an unknown id, ends a live id invalidParams", async () => {
    const c = await connect(fullHost({ galleryDelayMs: 6000 }));
    try {
      const from = reports.length;
      const { id, ws, closed } = await pickAndSocket(c);
      const req = requestsFor(c, "gallery.pick").at(-1);
      const cancelsFor = (rid: number) =>
        c.received.filter((m) => m.type === "deviceEvent" && m.id === rid && m.control?.cancel === true).length;

      // Only the server sends deviceRequest. For an id that is not live it
      // is ignored (liveness before direction, D8): nothing happens.
      ws.send(JSON.stringify({ ...req, id: id + 1000 }));
      await sleep(300);
      expect(reports.slice(from).find((r) => r.tag === "pick")).toBeUndefined();
      expect(cancelsFor(id)).toBe(0);
      expect(closed()).toBeUndefined();

      // Echoing the live request back is a known-id wrong-direction message
      // (transcript violation-request-from-client): the server cancels that
      // request and the handler gets invalidParams. The socket stays up.
      ws.send(JSON.stringify(req));
      expect(await nextReport("pick", from)).toMatchObject({ ok: false, code: "invalidParams" });
      await until(() => cancelsFor(id) === 1, "cancel for the violated request");
      await sleep(100);
      expect(cancelsFor(id)).toBe(1);
      expect(closed()).toBeUndefined();

      // The connection keeps working.
      const next = reports.length;
      c.engine.dispatchAction("perm", { mode: "query", permission: "camera" });
      expect(await nextReport("perm", next)).toMatchObject({ ok: true, status: "granted" });
    } finally {
      c.close();
    }
  }, 20000);

  test("40 frames with a bad header reset the socket 1012; short frames are only dropped", async () => {
    const c = await connect(fullHost({ galleryDelayMs: 800 }));
    try {
      const from = reports.length;
      const { id, ws, closed } = await pickAndSocket(c);
      // Shorter than a header: dropped, never counted, the pick completes.
      for (let i = 0; i < 100; i++) ws.send(new Uint8Array([1, 0, 0]));
      const r = await nextReport("pick", from);
      expect(r.ok).toBe(true);
      expect(closed()).toBeUndefined();
      for (let i = 0; i < 40; i++) ws.send(frame(id, 9));
      await until(() => closed() !== undefined, "socket close", 5000);
      expect(closed()).toBe(1012);
    } finally {
      c.close();
    }
  });
});

describe("sessions and ownership", () => {
  test("resumeToken resumes; a wrong token never does", async () => {
    const a = await connect(fullHost());
    const first = a.session;
    a.close();
    await sleep(200);

    const b = await connect(fullHost(), { session: { id: first.sessionId, resumeToken: first.resumeToken } });
    try {
      expect(b.session.sessionId).toBe(first.sessionId);
      expect(b.session.isRestored).toBe(true);
      // Rotated on every acknowledged connection.
      expect(b.session.resumeToken).not.toBe(first.resumeToken);
      // Resuming app state never resumes device operations: a fresh plane.
      const from = reports.length;
      b.engine.dispatchAction("perm", { mode: "query", permission: "camera" });
      expect(await nextReport("perm", from)).toMatchObject({ ok: true, status: "granted" });
    } finally {
      b.close();
    }
    await sleep(200);

    // The old token was rotated away; a bogus one is a new session too.
    for (const token of [first.resumeToken!, "bogus"]) {
      const c = await connect(fullHost(), { session: { id: first.sessionId, resumeToken: token } });
      try {
        expect(c.session.isNew).toBe(true);
        expect(c.session.sessionId).not.toBe(first.sessionId);
      } finally {
        c.close();
      }
    }
  });

  test("replay firewall: a broadcast-derived dispatch gets unavailable, nothing is sent", async () => {
    const c = await connect(fullHost());
    try {
      const before = requestsFor(c, "permission.query").length;
      const from = reports.length;
      (proc.stdin as { write(s: string): void; flush?(): void }).write(
        'broadcast perm {"mode":"query","permission":"camera"}\n'
      );
      (proc.stdin as { flush?(): void }).flush?.();
      const r = await nextReport("perm", from);
      expect(r).toMatchObject({ ok: false, code: "unavailable", detail: "replay" });
      await sleep(100);
      expect(requestsFor(c, "permission.query").length).toBe(before);
    } finally {
      c.close();
    }
  });

  test("module lifecycle: deactivation sweeps the activation's pending request", async () => {
    const c = await connect(fullHost({ galleryDelayMs: 5000 }));
    try {
      let from = reports.length;
      c.engine.dispatchAction("router.push", { to: "/home" });
      expect(await nextReport("homeActivated", from)).toMatchObject({ supports: true });
      const req = await until(() => requestsFor(c, "gallery.pick").at(-1), "home gallery.pick");
      expect(req.lifetime).toBe("activation");
      expect(req.owner.moduleInstanceId).toMatch(/^Home#/);

      from = reports.length;
      c.engine.dispatchAction("router.push", { to: "/other" });
      expect(await nextReport("homePick", from)).toMatchObject({ ok: false, code: "cancelled" });
      await until(
        () => c.received.find((m) => m.type === "deviceEvent" && m.id === req.id && m.control?.cancel === true),
        "sweep cancel on the wire"
      );
    } finally {
      c.close();
    }
  });
});
