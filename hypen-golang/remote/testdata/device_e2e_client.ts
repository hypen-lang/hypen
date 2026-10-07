/**
 * Cross-language end-to-end client for the Go remote server's device plane
 * (RFC 001), run by remote/device_e2e_test.go:
 *
 *   bun run remote/testdata/device_e2e_client.ts ws://127.0.0.1:PORT/ws
 *
 * The TypeScript web client — RemoteEngine + FakeDeviceHost (DeviceClient)
 * from hypen-web — connects over a real WebSocket to the Go server, whose
 * device plane runs on the Rust broker (WASI via wazero), and exercises:
 * Origin 403 / authenticator admission, handshake + core.capabilities,
 * permission.query, gallery.pick upload with hash verification, file.save
 * downloads (2 KiB, 64 KiB+, several credit windows), camera.capture (photo
 * and an undeclared-size video), bluetooth.select, bluetooth.scan (JSON
 * events) and mic.record (binary data) streams, cancellation, lease
 * renewals, and resumeToken resume.
 *
 * Each check prints one JSON line {"check": name, "ok": bool, ...}; the
 * script exits non-zero when any check failed. The Go test asserts both
 * these lines and what its handlers observed.
 */

import { RemoteEngine, type SessionInfo } from "../../../hypen-web/packages/core/src/remote/client.ts";
import type {
  DeviceAck,
  DeviceClientTransport,
  DeviceEndpoint,
  DeviceEvent,
} from "../../../hypen-web/packages/core/src/remote/device/index.ts";
import { FakeDeviceHost } from "../../../hypen-web/packages/device-fake/src/index.ts";

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

// ---- deterministic payloads shared with the Go test ---------------------------------

const photo = new Uint8Array(100_000).map((_, i) => (i * 31 + 7) & 0xff);
const pcmChunks = [0, 1, 2, 3].map((c) => new Uint8Array(3200).map((_, i) => (i + c * 13) & 0xff));
const expectedSave = new TextEncoder().encode("hypen-e2e-save ".repeat(10_000)); // 150 KB
/** file.save payload of n bytes (mirrors e2eSizedSave in the Go test). */
const sizedSave = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + n) & 0xff);
const cameraPhoto = new Uint8Array(70_000).map((_, i) => (i * 13 + 1) & 0xff);
const videoChunks = [0, 1, 2].map((c) => new Uint8Array(40_000).map((_, i) => (i + c * 29) & 0xff));
const cameraVideo = new Uint8Array(videoChunks.reduce((n, x) => n + x.byteLength, 0));
videoChunks.reduce((off, x) => (cameraVideo.set(x, off), off + x.byteLength), 0);

// ---- the fake device host ------------------------------------------------------------

type Observed = {
  saved: Uint8Array | null;
  scanCancelled: boolean;
  slowPickCancelled: boolean;
  renewals: Map<number, number>;
  leaseAcks: number;
  coreCapabilitiesOpened: boolean;
  requests: string[];
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
    .micRecords(pcmChunks, { chunkDelayMs: 10 })
    .cameraReturns({
      photo: { bytes: cameraPhoto },
      video: { chunks: videoChunks, contentType: "video/webm", chunkDelayMs: 5 },
    })
    .bluetoothSelects({ id: "e2e:hr-01", name: "Heart Monitor" });
  return { host, armSlowPick: () => (slowPick = true) };
}

/** Wrap the fake endpoint to observe lease traffic (renewLease in, leaseAck out). */
function observing(base: DeviceEndpoint, observed: Observed): DeviceEndpoint & { ack: () => DeviceAck | undefined } {
  let ack: DeviceAck | undefined;
  const note = (text: string) => {
    try {
      const m = JSON.parse(text) as { type?: string; id?: number; capability?: string; control?: Record<string, unknown> };
      if (m.type === "deviceRequest" && m.capability) {
        observed.requests.push(m.capability);
        if (m.capability === "core.capabilities") observed.coreCapabilitiesOpened = true;
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
    coreCapabilitiesOpened: false,
    requests: [],
  };
}

type Conn = {
  engine: RemoteEngine;
  info: SessionInfo;
  state: () => Record<string, unknown>;
  waitState: (key: string, timeoutMs?: number) => Promise<unknown>;
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
  const info = await Promise.race([established, sleep(20_000).then(() => null)]);
  if (!info) throw new Error("no sessionAck");
  const waitState = async (key: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = latest[key];
      if (v !== undefined && v !== "" && v !== null) return v;
      await sleep(10);
    }
    throw new Error(`state.${key} never set`);
  };
  // initialTree carries the state; wait until the plane is up.
  const deadline = Date.now() + 20_000;
  while (endpoint.ack() === undefined && Date.now() < deadline) await sleep(10);
  return { engine, info, state: () => latest, waitState, observed, endpoint, armSlowPick };
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
  // The connection-owned control stream is the first device message after
  // the ack (it arrives in the next socket event).
  for (let i = 0; i < 200 && !c.observed.coreCapabilitiesOpened; i++) await sleep(10);
  check("core-capabilities-opened", c.observed.coreCapabilitiesOpened && c.observed.requests[0] === "core.capabilities", {
    requests: c.observed.requests,
  });
  check("resume-token-issued", typeof c.info.resumeToken === "string" && c.info.resumeToken.length >= 22);

  c.engine.dispatchAction("e2eSupports");
  check("supports", (await c.waitState("supports")) === "true,true,true");

  c.engine.dispatchAction("e2eQuery", { permission: "camera" });
  check("permission-query", (await c.waitState("query")) === "granted");
  c.engine.dispatchAction("e2eQueryMic", { permission: "microphone" });
  check("permission-query-denied-status", (await c.waitState("queryMic")) === "denied");

  c.engine.dispatchAction("e2ePick");
  const pick = String(await c.waitState("pick"));
  check("gallery-pick-hash-verified", pick === `${photo.byteLength}:${await sha256Hex(photo)}:image/jpeg`, { pick });

  c.engine.dispatchAction("e2eSave");
  const save = await c.waitState("save");
  const saved = c.observed.saved;
  check(
    "file-save-download",
    save === String(expectedSave.byteLength) &&
      saved !== null &&
      (await sha256Hex(saved)) === (await sha256Hex(expectedSave)),
    { save, received: saved?.byteLength }
  );

  // file.save across sizes: the 2 KiB boundary where the Go SDK's wazero
  // once trapped in hypen_device_broker_open, one byte past a 64 KiB frame,
  // and more than one 256 KiB credit window.
  for (const [name, n] of [
    ["file-save-2048", 2048],
    ["file-save-64k-plus", 65_537],
    ["file-save-multi-window", 300_001],
  ] as const) {
    c.observed.saved = null;
    c.engine.dispatchAction("e2eSaveSized", { bytes: n });
    const got = String(await c.waitState("saveSized"));
    const bytes = c.observed.saved as Uint8Array | null;
    check(
      name,
      got === `${n}:${n}` && bytes !== null && (await sha256Hex(bytes)) === (await sha256Hex(sizedSave(n))),
      { got, received: bytes?.byteLength }
    );
    // The next size must write the state anew.
    c.engine.dispatchAction("e2eSaveSizedReset");
    for (let i = 0; i < 200 && c.state().saveSized !== ""; i++) await sleep(10);
  }

  c.engine.dispatchAction("e2ePhoto");
  const photoState = String(await c.waitState("photo"));
  check("camera-capture-photo", photoState === `${cameraPhoto.byteLength}:${await sha256Hex(cameraPhoto)}:image/jpeg`, {
    photo: photoState,
  });
  c.engine.dispatchAction("e2eVideo");
  const videoState = String(await c.waitState("video"));
  check("camera-capture-video", videoState === `${cameraVideo.byteLength}:${await sha256Hex(cameraVideo)}:video/webm`, {
    video: videoState,
  });

  c.engine.dispatchAction("e2eSelect");
  const selected = String(await c.waitState("select"));
  check("bluetooth-select", selected === "e2e:hr-01|Heart Monitor", { selected });

  c.engine.dispatchAction("e2eScan");
  check("bluetooth-scan-events", (await c.waitState("scan")) === "e2e:01,e2e:02");
  for (let i = 0; i < 200 && !c.observed.scanCancelled; i++) await sleep(10);
  check("bluetooth-scan-cancelled-on-client", c.observed.scanCancelled);

  c.engine.dispatchAction("e2eRecord");
  const all = new Uint8Array(pcmChunks.reduce((n, x) => n + x.byteLength, 0));
  let off = 0;
  for (const x of pcmChunks) {
    all.set(x, off);
    off += x.byteLength;
  }
  const record = String(await c.waitState("record"));
  const expectedMs = Math.round((all.byteLength / 2 / 8000) * 1000);
  check("mic-record-data", record === `${all.byteLength}:${await sha256Hex(all)}:${expectedMs}`, { record });

  // Cancel: a picker that never answers; a second action cancels the
  // first handler's context while it waits (the dispatch slot is yielded).
  c.armSlowPick();
  c.engine.dispatchAction("e2eSlowPick");
  await sleep(200);
  c.engine.dispatchAction("e2eCancelPick");
  check("cancel-handler-result", (await c.waitState("slowPick")) === "cancelled");
  for (let i = 0; i < 200 && !c.observed.slowPickCancelled; i++) await sleep(10);
  check("cancel-reached-client", c.observed.slowPickCancelled);

  // Lease renewals: permission.request is held 6.5 s on the client.
  c.engine.dispatchAction("e2eSlowRequest");
  check("slow-request-result", (await c.waitState("slowRequest", 30_000)) === "granted");
  const slowId = Math.max(...c.observed.renewals.keys());
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
    // The restored state already holds the earlier answers: write to a key
    // only this connection's device round trip can fill.
    resumed.engine.dispatchAction("e2eQuery", { permission: "camera", key: "queryResumed" });
    check("resumed-plane-works", (await resumed.waitState("queryResumed")) === "granted");
    resumed.engine.dispose();
  }

  console.log(JSON.stringify({ event: "done", failures }));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ check: "script", ok: false, error: String(err?.stack ?? err) }));
  process.exit(1);
});
