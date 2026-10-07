/**
 * Cross-language end-to-end client for the Kotlin server's device plane
 * (RFC 001), run by `DeviceWebSocketE2ETest` (`./gradlew deviceE2eTest`):
 *
 *   bun run src/test/e2e/device_e2e_client.ts ws://127.0.0.1:PORT/ws
 *
 * The TypeScript web client — RemoteEngine + FakeDeviceHost (DeviceClient)
 * from hypen-web — connects over a real WebSocket (Netty on the JVM) to the
 * Kotlin HypenServer, whose device plane runs on the Rust broker (UniFFI via
 * JNA), and exercises: Origin 403 / authenticator admission, handshake +
 * core.capabilities, device work from the auto-wired route module's
 * onActivated (the server's default router path), permission.query, gallery.pick upload with hash
 * verification, file.save download, bluetooth.scan (JSON events) and
 * mic.record (binary data) streams, cancellation, lease renewals, and
 * resumeToken resume.
 *
 * Results come back through the UI: each handler writes `key:value` into a
 * bound Text, and this script waits for the patch carrying it. Each check
 * prints one JSON line {"check": name, "ok": bool, ...}; the script exits
 * non-zero when any check failed. The Kotlin test asserts both these lines
 * and what its handlers observed.
 */

import { RemoteEngine, type SessionInfo } from "../../../../hypen-web/packages/core/src/remote/client.ts";
import type {
  DeviceAck,
  DeviceClientTransport,
  DeviceEndpoint,
  DeviceEvent,
} from "../../../../hypen-web/packages/core/src/remote/device/index.ts";
import { FakeDeviceHost } from "../../../../hypen-web/packages/device-fake/src/index.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: device_e2e_client.ts <ws-url>");

const AUTH = { Authorization: "Bearer e2e" };
let failures = 0;

function check(name: string, ok: boolean, detail: Record<string, unknown> = {}): void {
  if (!ok) failures++;
  console.log(JSON.stringify({ check: name, ok, ...detail }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- deterministic payloads shared with the Kotlin test ----------------------------

const photo = new Uint8Array(100_000).map((_, i) => (i * 31 + 7) & 0xff);
const pcmChunks = [0, 1, 2, 3].map((c) => new Uint8Array(3200).map((_, i) => (i + c * 13) & 0xff));
const expectedSave = new TextEncoder().encode("hypen-e2e-save ".repeat(10_000)); // 150 KB

// ---- the fake device host ----------------------------------------------------------

type Observed = {
  saved: Uint8Array | null;
  scanCancelled: boolean;
  slowPickCancelled: boolean;
  renewals: Map<number, number>;
  leaseAcks: number;
  requests: string[];
  requestIds: Map<string, number[]>;
};

function makeHost(observed: Observed) {
  let slowPick = false;
  const host = new FakeDeviceHost()
    .permissionsReturn({ camera: "granted", microphone: "denied" })
    .driver("permission.request", async ({ cancelled }) => {
      // Held past one 5 s lease interval: the server renews meanwhile.
      const raced = await Promise.race([sleep(6_500).then(() => "done"), cancelled.then(() => "cancelled")]);
      if (raced === "cancelled") return { kind: "error", code: "cancelled" };
      return { kind: "result", result: { status: "granted" } };
    })
    .driver("gallery.pick", async ({ cancelled }) => {
      if (slowPick) {
        slowPick = false;
        await cancelled; // only the server's cancel ends it
        observed.slowPickCancelled = true;
        return { kind: "error", code: "cancelled" };
      }
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }] };
    })
    .driver("file.save", async ({ download }) => {
      const bytes = await download!.receiveAll(); // size + hash checked by the runtime
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
  return { host, armSlowPick: () => (slowPick = true) };
}

/** Wrap the fake endpoint to observe device traffic (requests, renewLease in, leaseAck out). */
function observing(base: DeviceEndpoint, observed: Observed): DeviceEndpoint & { ack: () => DeviceAck | undefined } {
  let ack: DeviceAck | undefined;
  const note = (text: string) => {
    try {
      const m = JSON.parse(text) as { type?: string; id?: number; capability?: string; control?: Record<string, unknown> };
      if (m.type === "deviceRequest" && m.capability && typeof m.id === "number") {
        observed.requests.push(m.capability);
        observed.requestIds.set(m.capability, [...(observed.requestIds.get(m.capability) ?? []), m.id]);
      }
      if (m.type === "deviceEvent" && m.control && "renewLease" in m.control && typeof m.id === "number") {
        observed.renewals.set(m.id, (observed.renewals.get(m.id) ?? 0) + 1);
      }
    } catch {
      /* not JSON: the runtime decides */
    }
  };
  return {
    advertisement: base.advertisement,
    attach: (io: DeviceClientTransport) =>
      base.attach({
        sendMessage: (m) => {
          const ctl = (m as DeviceEvent).control as Record<string, unknown> | undefined;
          if (ctl && "leaseAck" in ctl) observed.leaseAcks++;
          io.sendMessage(m);
        },
        sendBinary: (f) => io.sendBinary(f),
        ...(io.bufferedAmount ? { bufferedAmount: () => io.bufferedAmount!() } : {}),
        ...(io.close ? { close: (code: number, reason: string) => io.close!(code, reason) } : {}),
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

function newObserved(): Observed {
  return {
    saved: null,
    scanCancelled: false,
    slowPickCancelled: false,
    renewals: new Map(),
    leaseAcks: 0,
    requests: [],
    requestIds: new Map(),
  };
}

/** Every string anywhere in a patch batch (Text values arrive as props). */
function collectStrings(v: unknown, out: Set<string>): void {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
}

type Conn = {
  engine: RemoteEngine;
  info: SessionInfo;
  /** The value a handler wrote into `Text("<key>:@{state.<key>}")`. */
  waitValue: (key: string, timeoutMs?: number) => Promise<string>;
  observed: Observed;
  endpoint: ReturnType<typeof observing>;
  armSlowPick: () => void;
};

async function connect(options: {
  headers?: Record<string, string>;
  session?: { id: string; resumeToken?: string };
}): Promise<Conn | null> {
  const observed = newObserved();
  const { host, armSlowPick } = makeHost(observed);
  const endpoint = observing(host.endpoint(), observed);
  const engine = new RemoteEngine(url, {
    autoReconnect: false,
    device: endpoint,
    headers: options.headers ?? AUTH,
    ...(options.session ? { session: options.session } : {}),
  });
  const seen = new Set<string>();
  engine.onPatches((patches) => collectStrings(patches, seen));
  const established = new Promise<SessionInfo>((resolve) => engine.onSessionEstablished(resolve));
  const res = await engine.connect();
  if (!res.ok) {
    engine.dispose();
    return null;
  }
  const info = await Promise.race([established, sleep(20_000).then(() => null)]);
  if (!info) {
    engine.dispose();
    return null;
  }
  const waitValue = async (key: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    const prefix = `${key}:`;
    while (Date.now() < deadline) {
      for (const s of seen) if (s.startsWith(prefix) && s.length > prefix.length) return s.slice(prefix.length);
      await sleep(10);
    }
    throw new Error(`${key} never set`);
  };
  // Wait until the device plane is up (the ack selected it).
  const deadline = Date.now() + 20_000;
  while (endpoint.ack() === undefined && Date.now() < deadline) await sleep(10);
  return { engine, info, waitValue, observed, endpoint, armSlowPick };
}

// ---- scenarios -----------------------------------------------------------------------

async function admission() {
  const foreign = await connect({ headers: { ...AUTH, Origin: "http://evil.e2e" } });
  check("origin-403", foreign === null);
  foreign?.engine.dispose();

  const noCreds = await connect({ headers: {} });
  check("no-credentials-403", noCreds === null);
  noCreds?.engine.dispose();

  const browser = await connect({ headers: { ...AUTH, Origin: "http://app.e2e" } });
  check("allowed-origin-admitted", browser !== null && browser.endpoint.ack() !== undefined);
  browser?.engine.dispose();
}

async function main() {
  await admission();

  const c = await connect({});
  if (!c) {
    check("authenticator-admits", false);
    process.exit(1);
  }
  check("authenticator-admits", true, { sessionId: c.info.sessionId });
  const ack = c.endpoint.ack();
  check("handshake-device-ack", ack !== undefined && ack.capabilities.some((x) => x.name === "gallery.pick"), {
    selected: ack?.capabilities.map((x) => x.name),
  });
  for (let i = 0; i < 200 && c.observed.requests.length === 0; i++) await sleep(10);
  check("core-capabilities-opened", c.observed.requests[0] === "core.capabilities", { requests: c.observed.requests });
  // The server's default auto-wired router activates the route module
  // (`Page`) while the session is established; its onActivated queries a
  // permission at once — on a live device plane, right after core.capabilities.
  for (let i = 0; i < 500 && !c.observed.requests.includes("permission.query"); i++) await sleep(10);
  check(
    "route-module-activation-device",
    c.observed.requests[0] === "core.capabilities" && c.observed.requests[1] === "permission.query",
    { requests: c.observed.requests }
  );
  check("resume-token-issued", typeof c.info.resumeToken === "string" && c.info.resumeToken.length >= 43);

  c.engine.dispatchAction("e2eSupports");
  check("supports", (await c.waitValue("supports")) === "true,true,false");

  c.engine.dispatchAction("e2eQuery", { permission: "camera" });
  check("permission-query", (await c.waitValue("query")) === "granted");
  c.engine.dispatchAction("e2eQueryMic");
  check("permission-query-denied-status", (await c.waitValue("queryMic")) === "denied");

  c.engine.dispatchAction("e2ePick");
  const pick = await c.waitValue("pick");
  check("gallery-pick-hash-verified", pick === `${photo.byteLength}|${await sha256Hex(photo)}|image/jpeg`, { pick });

  c.engine.dispatchAction("e2eSave");
  const save = await c.waitValue("save");
  const saved = c.observed.saved;
  check(
    "file-save-download",
    save === String(expectedSave.byteLength) &&
      saved !== null &&
      (await sha256Hex(saved)) === (await sha256Hex(expectedSave)),
    { save, received: saved?.byteLength }
  );

  c.engine.dispatchAction("e2eScan");
  check("bluetooth-scan-events", (await c.waitValue("scan")) === "e2e:01,e2e:02");
  for (let i = 0; i < 200 && !c.observed.scanCancelled; i++) await sleep(10);
  check("bluetooth-scan-cancelled-on-client", c.observed.scanCancelled);

  c.engine.dispatchAction("e2eRecord");
  const all = new Uint8Array(pcmChunks.reduce((n, x) => n + x.byteLength, 0));
  let off = 0;
  for (const x of pcmChunks) {
    all.set(x, off);
    off += x.byteLength;
  }
  const record = await c.waitValue("record");
  const expectedMs = Math.round((all.byteLength / 2 / 8000) * 1000);
  check("mic-record-data", record === `${all.byteLength}|${await sha256Hex(all)}|${expectedMs}`, { record });

  // Cancel: a picker that never answers; a second action cancels the first
  // handler's coroutine while it waits (coroutine cancellation ⇒ wire cancel).
  c.armSlowPick();
  c.engine.dispatchAction("e2eSlowPick");
  await sleep(200);
  c.engine.dispatchAction("e2eCancelPick");
  check("cancel-handler-result", (await c.waitValue("slowPick")) === "cancelled");
  for (let i = 0; i < 200 && !c.observed.slowPickCancelled; i++) await sleep(10);
  check("cancel-reached-client", c.observed.slowPickCancelled);

  // Lease renewals: permission.request is held 6.5 s on the client.
  c.engine.dispatchAction("e2eSlowRequest");
  check("slow-request-result", (await c.waitValue("slowRequest", 30_000)) === "granted");
  const slowId = (c.observed.requestIds.get("permission.request") ?? [0]).at(-1)!;
  check("lease-renewals", (c.observed.renewals.get(slowId) ?? 0) >= 2 && c.observed.leaseAcks >= 3, {
    renewals: c.observed.renewals.get(slowId),
    leaseAcks: c.observed.leaseAcks,
  });

  const { sessionId, resumeToken } = c.info;
  console.log(JSON.stringify({ event: "session", sessionId }));
  c.engine.dispose();
  await sleep(300);

  // Resume with the wrong token: a new session, never a takeover.
  const wrong = await connect({ session: { id: sessionId, resumeToken: "wrong-token" } });
  check("resume-wrong-token-new-session", wrong !== null && wrong.info.sessionId !== sessionId && wrong.info.isNew);
  wrong?.engine.dispose();
  await sleep(300);

  // Resume with the issued token: same session, rotated token, fresh plane.
  const resumed = await connect({ session: { id: sessionId, resumeToken } });
  check(
    "resume-with-token",
    resumed !== null &&
      resumed.info.sessionId === sessionId &&
      resumed.info.isRestored &&
      resumed.info.resumeToken !== resumeToken &&
      resumed.endpoint.ack() !== undefined,
    { info: resumed?.info && { ...resumed.info, resumeToken: undefined } }
  );
  if (resumed) {
    resumed.engine.dispatchAction("e2eQuery", { permission: "camera", key: "queryResumed" });
    check("resumed-plane-works", (await resumed.waitValue("queryResumed")) === "granted");
    resumed.engine.dispose();
  }

  console.log(JSON.stringify({ event: "done", failures }));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ check: "script", ok: false, error: String(err?.stack ?? err) }));
  process.exit(1);
});
