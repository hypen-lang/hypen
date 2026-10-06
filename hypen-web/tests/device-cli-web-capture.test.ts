/**
 * Round 3 browser DeviceHost drivers under JSDOM (RFC 001 §2.4 / §5, round-3
 * P1 / C2 / C3 / C4), driven end to end through the real `DeviceClient`
 * runtime the host builds on:
 *
 * - P1 typed permissions: the closed enum mapped onto the Permissions API
 *   (`photos` granted, `bluetooth` prompt/unsupported, `contacts`
 *   unsupported with the name), and `permission.request` really prompting
 *   (getUserMedia with tracks stopped, getCurrentPosition,
 *   Notification.requestPermission) only behind the consent dialog's
 *   trusted Continue;
 * - C2 camera.capture: the host capture dialog (preview, armed Capture /
 *   Record, Stop, Cancel), photo as a declared JPEG item, video streamed
 *   undeclared as the recorder produces it, bounded capture window;
 * - C3 mic.record: consent, recording indicator with Stop, PCM16 at the
 *   requested rate/channels, `maxDurationMs`, credit starvation → throttled;
 * - C4 bluetooth.select through a fake `navigator.bluetooth` (the real
 *   Chromium chooser is exercised in device-browser.test.ts via CDP
 *   BluetoothEmulation);
 * - the pure PCM resampler/encoder and the bounded LiveQueue;
 * - the runtime's live-source rules: frames leave as captured, and
 *   `DriverContext.fail` ends a request mid-upload.
 *
 * Platform seams (media, bluetooth, geolocation, notifications) are fakes;
 * a trusted click is JSDOM's internal `isTrusted` flipped for one event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  DeviceClient,
  decodeFrame,
  sha256Hex,
  type DeviceAck,
  type DeviceDriver,
  type DeviceEvent,
  type DeviceRequest,
  type DeviceResponse,
  type DriverOutcome,
} from "@hypen-space/core/remote/device";
import {
  floatToPcm16,
  LiveQueue,
  PcmEncoder,
  WebDeviceHost,
  type AudioCaptureLike,
  type BluetoothLike,
  type MediaBackend,
  type MediaStreamLike,
  type PermissionsLike,
  type RecorderLike,
  type WebDeviceHostOptions,
} from "../packages/device-web/src/index.ts";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { implSymbol } = require("jsdom/lib/jsdom/living/generated/utils.js") as { implSymbol: symbol };

let dom: JSDOM;
let doc: Document;
let win: Window & typeof globalThis;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  win = dom.window as unknown as Window & typeof globalThis;
  doc = win.document;
});

afterEach(() => {
  dom.window.close();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await tick();
  }
}

function trusted(el: Element, ev: Event): void {
  const flip = (e: Event) => {
    (e as unknown as Record<symbol, { isTrusted: boolean }>)[implSymbol]!.isTrusted = true;
  };
  win.addEventListener(ev.type, flip, { capture: true, once: true });
  el.dispatchEvent(ev);
}

function trustedClick(el: Element): void {
  trusted(el, new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  trusted(el, new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function activate(el: Element): Promise<void> {
  await waitFor(() => !(el as HTMLButtonElement).disabled);
  trustedClick(el);
}

const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
const consentDialog = () => q("[data-hypen-device-dialog]");
const captureDialog = () => q("[data-hypen-device-capture]");
const indicator = () => q("[data-hypen-device-indicator]");
const control = (role: string) => q(`[data-hypen-device="${role}"]`);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTrack {
  stopped = false;
  constructor(public kind: string) {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks: FakeTrack[];
  constructor(kinds: string[]) {
    this.tracks = kinds.map((k) => new FakeTrack(k));
  }
  getTracks() {
    return this.tracks;
  }
  get allStopped() {
    return this.tracks.every((t) => t.stopped);
  }
}

class FakeRecorder implements RecorderLike {
  state = "inactive";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  timeslice: number | undefined;
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0xee, 0xff])]) });
      setTimeout(() => this.onstop?.(), 5);
    });
  }
  emit(bytes: Uint8Array) {
    this.ondataavailable?.({ data: new Blob([bytes as BlobPart]) });
  }
}

class FakeCapture implements AudioCaptureLike {
  closed = false;
  flushed = 0;
  constructor(
    readonly sampleRate: number,
    readonly onBlock: (planar: Float32Array[]) => void,
    readonly channels: number
  ) {}
  async flush() {
    this.flushed += 1;
  }
  close() {
    this.closed = true;
  }
}

interface FakeMedia extends MediaBackend {
  constraints: MediaStreamConstraints[];
  streams: FakeStream[];
  recorders: FakeRecorder[];
  captures: FakeCapture[];
  gumError: { name: string } | null;
  /** When set, getUserMedia resolves only after it (a slow device / OS prompt). */
  gumGate: Promise<void> | null;
  jpeg: Uint8Array;
}

function fakeMedia(opts: { rate?: number } = {}): FakeMedia {
  const m: FakeMedia = {
    constraints: [],
    streams: [],
    recorders: [],
    captures: [],
    gumError: null,
    gumGate: null,
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]),
    getUserMedia: async (c) => {
      m.constraints.push(c);
      if (m.gumGate) await m.gumGate;
      if (m.gumError) throw Object.assign(new Error(m.gumError.name), m.gumError);
      const kinds = [...(c.video ? ["video"] : []), ...(c.audio ? ["audio"] : [])];
      const s = new FakeStream(kinds);
      m.streams.push(s);
      return s;
    },
    attachPreview: async () => {},
    snapshot: async () => new Blob([m.jpeg as BlobPart], { type: "image/jpeg" }),
    createRecorder: () => {
      const r = new FakeRecorder();
      m.recorders.push(r);
      return { recorder: r, contentType: "video/webm" };
    },
    openAudioCapture: async (_stream, channels, onBlock) => {
      const c = new FakeCapture(opts.rate ?? 48_000, onBlock, channels);
      m.captures.push(c);
      return c;
    },
  };
  return m;
}

class FakeStatus extends EventTarget {
  constructor(public state: string) {
    super();
  }
  set(state: string) {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

function fakePermissions(initial: Record<string, string>) {
  const statuses = new Map<string, FakeStatus>();
  const queried: string[] = [];
  for (const [k, v] of Object.entries(initial)) statuses.set(k, new FakeStatus(v));
  const api: PermissionsLike = {
    async query({ name }) {
      queried.push(name);
      const s = statuses.get(name);
      if (!s) throw new TypeError(`unknown permission ${name}`);
      return s;
    },
  };
  return { api, statuses, queried };
}

// ---------------------------------------------------------------------------
// Harness: the host behind its real DeviceClient, a recording transport
// ---------------------------------------------------------------------------

let nextId = 1;
function request(capability: string, params: Record<string, unknown>, over: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    type: "deviceRequest",
    id: nextId++,
    capability,
    version: 1,
    owner: { moduleInstanceId: "m1", activationId: 1 },
    lifetime: "activation",
    timeoutMs: 30_000,
    initialCredit: 0,
    params,
    ...over,
  };
}

const ALL_CAPS = [
  "core.capabilities",
  "gallery.pick",
  "file.pick",
  "file.save",
  "permission.query",
  "permission.request",
  "camera.capture",
  "mic.record",
  "bluetooth.select",
];
const FULL_ACK: DeviceAck = { protocolVersion: 1, binary: true, capabilities: ALL_CAPS.map((name) => ({ name, version: 1 })) };

interface Host {
  host: WebDeviceHost;
  sent: Array<DeviceResponse | DeviceEvent>;
  frames: Uint8Array[];
  send(req: DeviceRequest): DeviceRequest;
  grant(id: number, n: number): void;
  cancel(id: number): void;
  response(id: number): Promise<DeviceResponse>;
  responseNow(id: number): DeviceResponse | undefined;
  bytes(id: number): Uint8Array;
  events(id: number): Array<Record<string, unknown>>;
  controls(id: number): Array<Record<string, unknown>>;
}

function connect(opts: Partial<WebDeviceHostOptions> = {}): Host {
  const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5, ...opts });
  const sent: Array<DeviceResponse | DeviceEvent> = [];
  const frames: Uint8Array[] = [];
  host.attach({ sendMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), sendBinary: (f) => frames.push(f.slice()) });
  host.onAck(FULL_ACK);
  host.handleMessage(
    request("core.capabilities", {}, { lifetime: "connection", owner: { connection: true }, timeoutMs: 86_400_000, initialCredit: 8 })
  );
  const responseNow = (id: number) => sent.find((m): m is DeviceResponse => m.type === "deviceResponse" && m.id === id);
  return {
    host,
    sent,
    frames,
    send(req) {
      host.handleMessage(req);
      return req;
    },
    grant(id, n) {
      host.handleMessage({ type: "deviceEvent", id, control: { grant: n } } as DeviceEvent);
    },
    cancel(id) {
      host.handleMessage({ type: "deviceEvent", id, control: { cancel: true } } as DeviceEvent);
    },
    responseNow,
    response: (id) => waitFor(() => responseNow(id), 4000),
    bytes(id) {
      const parts: Uint8Array[] = [];
      for (const f of frames) {
        const d = decodeFrame(f);
        if (d.ok && d.header.requestId === id) parts.push(d.payload);
      }
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
      }
      return out;
    },
    events: (id) =>
      sent.filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && "event" in m && !!m.event).map((m) => m.event as Record<string, unknown>),
    controls: (id) =>
      sent.filter((m): m is DeviceEvent => m.type === "deviceEvent" && m.id === id && "control" in m && !!m.control).map((m) => m.control as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// PCM encoder + live queue (pure)
// ---------------------------------------------------------------------------

describe("PcmEncoder", () => {
  const le16 = (bytes: Uint8Array) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: bytes.byteLength / 2 }, (_, i) => v.getInt16(i * 2, true));
  };

  test("floatToPcm16 clamps and scales asymmetrically; NaN is silence", () => {
    expect(floatToPcm16(0)).toBe(0);
    expect(floatToPcm16(1)).toBe(32767);
    expect(floatToPcm16(-1)).toBe(-32768);
    expect(floatToPcm16(4)).toBe(32767);
    expect(floatToPcm16(-4)).toBe(-32768);
    expect(floatToPcm16(0.5)).toBe(16384);
    expect(floatToPcm16(Number.NaN)).toBe(0);
  });

  test("same rate: every sample, little-endian", () => {
    const enc = new PcmEncoder(16_000, 16_000, 1);
    const out = enc.push([new Float32Array([0, 0.5, -0.5, 1])]);
    expect(Array.from(out)).toEqual([0x00, 0x00, 0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]);
    expect(enc.frames).toBe(4);
  });

  test("48 kHz → 16 kHz keeps every third sample; block boundaries never change the output", () => {
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7) * 0.8);
    const whole = new PcmEncoder(48_000, 16_000, 1).push([input]);
    expect(whole.byteLength).toBe(1600 * 2);
    expect(le16(whole).slice(0, 5)).toEqual([0, 3, 6, 9, 12].map((i) => floatToPcm16(input[i]!)));
    // Irregular block sizes (as a worklet / ScriptProcessor delivers).
    const split = new PcmEncoder(48_000, 16_000, 1);
    const parts: number[] = [];
    let off = 0;
    for (const n of [1, 2, 127, 128, 500, 1, 2048, 1993]) {
      parts.push(...split.push([input.subarray(off, off + n)]));
      off += n;
    }
    expect(off).toBe(4800);
    expect(parts).toEqual(Array.from(whole));
  });

  test("44.1 kHz → 16 kHz: the output length follows the rate ratio, split or not", () => {
    const input = Float32Array.from({ length: 44_100 }, (_, i) => Math.sin(i / 11) * 0.3);
    const whole = new PcmEncoder(44_100, 16_000, 1).push([input]);
    expect(Math.abs(whole.byteLength / 2 - 16_000)).toBeLessThanOrEqual(1);
    const split = new PcmEncoder(44_100, 16_000, 1);
    let n = 0;
    for (let off = 0; off < input.length; off += 128) n += split.push([input.subarray(off, off + 128)]).byteLength;
    expect(n).toBe(whole.byteLength);
  });

  test("upsampling interpolates linearly across block boundaries", () => {
    const enc = new PcmEncoder(8_000, 16_000, 1);
    const a = le16(enc.push([new Float32Array([0, 0.5])]));
    const b = le16(enc.push([new Float32Array([1])]));
    expect([...a, ...b]).toEqual([0, floatToPcm16(0.25), floatToPcm16(0.5), floatToPcm16(0.75), floatToPcm16(1)]);
  });

  test("stereo interleaves L/R; a mono input feeds both channels", () => {
    const enc = new PcmEncoder(16_000, 16_000, 2);
    expect(le16(enc.push([new Float32Array([0.5, -0.5]), new Float32Array([1, 0])]))).toEqual([
      16384, 32767, -16384, 0,
    ]);
    const mono = new PcmEncoder(16_000, 16_000, 2);
    expect(le16(mono.push([new Float32Array([0.5])]))).toEqual([16384, 16384]);
  });

  test("maxFrames caps the recording exactly and reports its duration", () => {
    const enc = new PcmEncoder(48_000, 16_000, 1, 400);
    let total = 0;
    for (let i = 0; i < 10; i++) total += enc.push([new Float32Array(480)]).byteLength;
    expect(total).toBe(800);
    expect(enc.full).toBe(true);
    expect(enc.durationMs).toBe(25);
    expect(enc.push([new Float32Array(480)]).byteLength).toBe(0);
  });
});

describe("LiveQueue (bounded capture window)", () => {
  test("delivers in order, bounds what waits, ends after draining", async () => {
    const released: string[] = [];
    const queue = new LiveQueue(4, () => released.push("released"));
    const done: string[] = [];
    queue.onDone(() => done.push("done"));
    expect(queue.push(new Uint8Array([1, 2]))).toBe("ok");
    expect(queue.push(new Uint8Array([3, 4]))).toBe("ok");
    expect(queue.push(new Uint8Array([5]))).toBe("full"); // nothing kept
    expect(queue.bufferedBytes).toBe(4);
    queue.end();
    expect(done).toEqual(["done"]);
    expect(queue.push(new Uint8Array([6]))).toBe("closed");
    const got: number[] = [];
    for await (const c of queue) got.push(...c);
    expect(got).toEqual([1, 2, 3, 4]);
    expect(released).toEqual([]);
  });

  test("a pending pull is answered by the next push; return() releases at once", async () => {
    let released = 0;
    const queue = new LiveQueue(16, () => released++);
    const first = queue.next();
    queue.push(new Uint8Array([9]));
    expect(await first).toEqual({ value: new Uint8Array([9]), done: false });
    const pending = queue.next();
    await queue.return();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(released).toBe(1);
    await queue.return();
    expect(released).toBe(1);
    expect(queue.closed).toBe(true);
  });

  test("fail() rejects the pending pull with the coded error", async () => {
    const queue = new LiveQueue(16);
    const pending = queue.next();
    queue.fail(Object.assign(new Error("capture-buffer-full"), { code: "throttled" }));
    await expect(pending).rejects.toMatchObject({ code: "throttled" });
  });
});

// ---------------------------------------------------------------------------
// Runtime: live sources
// ---------------------------------------------------------------------------

describe("runtime live sources (frames as captured, DriverContext.fail)", () => {
  function runtime(driver: DeviceDriver) {
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const frames: Uint8Array[] = [];
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), sendBinary: (f) => frames.push(f.slice()) },
      new Map([["mic.record", driver]])
    );
    return { client, sent, frames };
  }

  test("a small captured chunk is sent without waiting for a frame's worth", async () => {
    const queue = new LiveQueue(1 << 20);
    const rt = runtime(async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "audio/L16", stream: queue }], complete: () => ({ durationMs: 1 }) }));
    const req = request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 4096 });
    rt.client.handleMessage(req);
    await tick();
    queue.push(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => rt.frames.length === 1);
    expect(decodeFrame(rt.frames[0]!).ok && decodeFrame(rt.frames[0]!).payload.byteLength).toBe(4);
    queue.push(new Uint8Array([5, 6]));
    await waitFor(() => rt.frames.length === 2);
    queue.end();
    const res = await waitFor(() => rt.sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res.result).toEqual({
      durationMs: 1,
      item: { channel: 0, contentType: "audio/L16", bytes: 6, sha256: await sha256Hex(new Uint8Array([1, 2, 3, 4, 5, 6])) },
    });
  });

  test("DriverContext.fail ends a request whose upload is paused for credit", async () => {
    let fail!: NonNullable<Parameters<DeviceDriver>[0]["fail"]>;
    const queue = new LiveQueue(1 << 20);
    const rt = runtime(async (ctx) => {
      fail = ctx.fail!;
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "audio/L16", stream: queue }] };
    });
    const req = request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 2 });
    rt.client.handleMessage(req);
    await tick();
    queue.push(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => rt.sent.some((m) => m.type === "deviceEvent" && (m as DeviceEvent).control?.paused === true));
    expect(queue.closed).toBe(false);
    fail("throttled", "capture-buffer-full");
    const res = await waitFor(() => rt.sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res.error).toEqual({ code: "throttled", platformDetail: "capture-buffer-full" });
    expect(queue.closed).toBe(true); // the runtime released the source
    fail("internal", "late"); // no-op once terminal
    expect(rt.sent.filter((m) => m.type === "deviceResponse").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1 typed permissions
// ---------------------------------------------------------------------------

describe("P1 permission.query on the web", () => {
  test("the closed enum maps onto the Permissions API; photos granted; bluetooth prompt; contacts unsupported", async () => {
    const perms = fakePermissions({ camera: "granted", microphone: "denied", geolocation: "prompt", notifications: "granted" });
    const bluetooth: BluetoothLike = { requestDevice: async () => ({ id: "x" }) };
    const h = connect({ permissions: perms.api, bluetooth, media: fakeMedia() });
    const expectations: Array<[string, unknown]> = [
      ["camera", { result: { status: "granted" } }],
      ["microphone", { result: { status: "denied" } }],
      ["location", { result: { status: "prompt" } }],
      ["notifications", { result: { status: "granted" } }],
      ["photos", { result: { status: "granted" } }],
      ["bluetooth", { result: { status: "prompt" } }],
      ["contacts", { error: { code: "unsupported", platformDetail: "contacts" } }],
    ];
    for (const [permission, want] of expectations) {
      const req = h.send(request("permission.query", { permission }));
      expect(await h.response(req.id)).toMatchObject(want as object);
    }
    // Queried through the Permissions API under their web names (the host
    // also watches camera/microphone for revocation of its capture drivers).
    expect([...new Set(perms.queried)].sort()).toEqual(["camera", "geolocation", "microphone", "notifications"]);
    expect(consentDialog()).toBeNull();
  });

  test("without Web Bluetooth `bluetooth` is unsupported; an unqueryable permission is unsupported", async () => {
    const perms = fakePermissions({});
    const h = connect({ permissions: perms.api });
    for (const permission of ["bluetooth", "camera"]) {
      const req = h.send(request("permission.query", { permission }));
      expect((await h.response(req.id)).error).toEqual({ code: "unsupported", platformDetail: permission });
    }
  });

  test("unqueryable but present platform APIs are undecided (prompt), and permission.request can raise them", async () => {
    const media = fakeMedia();
    const h = connect({
      permissions: fakePermissions({}).api,
      media,
      geolocation: { getCurrentPosition: (ok) => ok({}) },
    });
    for (const permission of ["camera", "microphone", "location"]) {
      const req = h.send(request("permission.query", { permission }));
      expect((await h.response(req.id)).result).toEqual({ status: "prompt" });
    }
    const req = h.send(request("permission.request", { permission: "location" }));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(req.id)).result).toEqual({ status: "granted" });
  });

  test("an unknown permission name is invalidParams at decode (schema enum), before any driver", async () => {
    const perms = fakePermissions({ camera: "granted" });
    const h = connect({ permissions: perms.api });
    const req = h.send(request("permission.query", { permission: "camra" }));
    expect((await h.response(req.id)).error?.code).toBe("invalidParams");
    expect(perms.queried).toEqual([]);
  });

  test("notifications fall back to Notification.permission when the Permissions API cannot say", async () => {
    const h = connect({ permissions: fakePermissions({}).api, notifications: { permission: "default", requestPermission: async () => "granted" } });
    const req = h.send(request("permission.query", { permission: "notifications" }));
    expect((await h.response(req.id)).result).toEqual({ status: "prompt" });
  });
});

describe("P1 permission.request actually prompts, behind the trusted Continue", () => {
  test("camera: consent dialog, then getUserMedia({video}) inside the click; tracks stopped; granted", async () => {
    const perms = fakePermissions({ camera: "prompt" });
    const media = fakeMedia();
    const h = connect({ permissions: perms.api, media });
    const req = h.send(request("permission.request", { permission: "camera" }));
    await waitFor(consentDialog);
    expect(consentDialog()!.textContent).toContain("ws://app.test:8080");
    expect(consentDialog()!.textContent).toContain("use your camera");
    expect(h.events(req.id)).toEqual([{ kind: "progress", state: "pendingConsent" }]);
    expect(media.constraints).toEqual([]); // nothing before the activation
    await activate(control("continue")!);
    expect(await h.response(req.id)).toMatchObject({ result: { status: "granted" } });
    expect(media.constraints).toEqual([{ video: true }]);
    expect(media.streams[0]!.allStopped).toBe(true);
    expect(h.events(req.id)).toEqual([
      { kind: "progress", state: "pendingConsent" },
      { kind: "progress", state: "running" },
    ]);
  });

  test("microphone refused by the browser prompt → status denied (a result, not an error)", async () => {
    const media = fakeMedia();
    media.gumError = { name: "NotAllowedError" };
    const h = connect({ permissions: fakePermissions({ microphone: "prompt" }).api, media });
    const req = h.send(request("permission.request", { permission: "microphone" }));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(req.id)).result).toEqual({ status: "denied" });
    expect(media.constraints).toEqual([{ audio: true }]);
  });

  test("location prompts through getCurrentPosition: PERMISSION_DENIED → denied, other errors → granted", async () => {
    for (const [code, status] of [
      [1, "denied"],
      [3, "granted"],
    ] as const) {
      let calls = 0;
      const h = connect({
        permissions: fakePermissions({ geolocation: "prompt" }).api,
        geolocation: { getCurrentPosition: (_ok, err) => (calls++, err?.({ code })) },
      });
      const req = h.send(request("permission.request", { permission: "location" }));
      await waitFor(consentDialog);
      expect(calls).toBe(0);
      await activate(control("continue")!);
      expect((await h.response(req.id)).result).toEqual({ status });
      expect(calls).toBe(1);
      h.host.detach();
    }
  });

  test("notifications prompt through Notification.requestPermission", async () => {
    let asked = 0;
    const h = connect({
      permissions: fakePermissions({ notifications: "prompt" }).api,
      notifications: { permission: "default", requestPermission: async () => (asked++, "granted") },
    });
    const req = h.send(request("permission.request", { permission: "notifications" }));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(req.id)).result).toEqual({ status: "granted" });
    expect(asked).toBe(1);
  });

  test("an already-decided permission answers without a dialog; photos granted; contacts unsupported", async () => {
    const media = fakeMedia();
    const h = connect({ permissions: fakePermissions({ camera: "granted", microphone: "denied" }).api, media });
    for (const [permission, want] of [
      ["camera", { result: { status: "granted" } }],
      ["microphone", { result: { status: "denied" } }],
      ["photos", { result: { status: "granted" } }],
      ["contacts", { error: { code: "unsupported", platformDetail: "contacts" } }],
    ] as const) {
      const req = h.send(request("permission.request", { permission }));
      expect(await h.response(req.id)).toMatchObject(want);
    }
    expect(consentDialog()).toBeNull();
    expect(media.constraints).toEqual([]);
  });

  test("host Cancel is denied + cooldown and never prompts the platform", async () => {
    const media = fakeMedia();
    const h = connect({ permissions: fakePermissions({ camera: "prompt" }).api, media });
    const req = h.send(request("permission.request", { permission: "camera" }));
    (await waitFor(() => control("cancel")))!.click();
    expect((await h.response(req.id)).error).toEqual({ code: "denied", platformDetail: "host-refused" });
    const again = h.send(request("permission.request", { permission: "camera" }));
    expect((await h.response(again.id)).error).toEqual({ code: "throttled", platformDetail: "cooldown" });
    expect(media.constraints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C2 camera.capture
// ---------------------------------------------------------------------------

describe("C2 camera.capture: the host capture dialog is the gate", () => {
  test("photo: preview dialog names the origin; armed Capture → declared JPEG item, hash-verified terminal", async () => {
    const media = fakeMedia();
    const h = connect({ media, permissions: fakePermissions({ camera: "granted" }).api });
    const req = h.send(request("camera.capture", { mode: "photo", facing: "front" }, { initialCredit: 1 << 20 }));
    await waitFor(captureDialog);
    expect(captureDialog()!.textContent).toContain("ws://app.test:8080");
    expect(captureDialog()!.textContent).toContain("take a photo");
    expect(control("preview")!.tagName).toBe("VIDEO");
    const capture = await waitFor(() => control("capture"));
    expect(media.constraints).toEqual([{ video: { facingMode: { ideal: "user" } } }]);
    // A synthetic click is not an activation (and nothing was captured).
    expect(h.frames.length).toBe(0);
    await activate(capture);
    const res = await h.response(req.id);
    expect(res.result).toEqual({
      items: [{ channel: 0, contentType: "image/jpeg", bytes: media.jpeg.byteLength, sha256: await sha256Hex(media.jpeg) }],
    });
    expect(h.bytes(req.id)).toEqual(media.jpeg);
    expect(h.events(req.id)).toContainEqual({ kind: "blobStart", channel: 0, contentType: "image/jpeg", bytes: media.jpeg.byteLength });
    expect(media.streams[0]!.allStopped).toBe(true);
    expect(captureDialog()).toBeNull();
  });

  test("Capture is disabled while the preview starts and during the protection window; a click then is ignored", async () => {
    const media = fakeMedia();
    const h = connect({ media, inputProtectionMs: 80 });
    const req = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    const capture = await waitFor(() => control("capture"));
    expect((capture as HTMLButtonElement).disabled).toBe(true);
    trustedClick(capture); // lands before the control is armed
    await new Promise((r) => setTimeout(r, 20));
    expect(h.responseNow(req.id)).toBeUndefined();
    await activate(capture);
    expect((await h.response(req.id)).result).toBeDefined();
  });

  test("Cancel is cancelled (+ cooldown); an untrusted Capture click is a refusal too", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    await waitFor(() => control("capture"));
    control("cancel")!.click();
    expect((await h.response(req.id)).error).toEqual({ code: "cancelled", platformDetail: "capture-cancelled" });
    expect(media.streams[0]!.allStopped).toBe(true);
    expect(captureDialog()).toBeNull();
    const again = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    expect((await h.response(again.id)).error).toEqual({ code: "throttled", platformDetail: "cooldown" });

    const h2 = connect({ media: fakeMedia(), denialCooldownMs: 0 });
    const r2 = h2.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    const capture = await waitFor(() => control("capture"));
    await waitFor(() => !(capture as HTMLButtonElement).disabled);
    capture.click(); // synthetic
    expect((await h2.response(r2.id)).error?.code).toBe("cancelled");
  });

  test("a refused camera permission is denied: up front without a dialog, or from getUserMedia", async () => {
    const perms = fakePermissions({ camera: "denied" });
    const h = connect({ media: fakeMedia(), permissions: perms.api });
    const req = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    expect((await h.response(req.id)).error).toEqual({ code: "denied", platformDetail: "permission:camera" });
    expect(captureDialog()).toBeNull();

    const media = fakeMedia();
    media.gumError = { name: "NotAllowedError" };
    const h2 = connect({ media, permissions: fakePermissions({ camera: "prompt" }).api });
    const r2 = h2.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    expect((await h2.response(r2.id)).error?.code).toBe("denied");
    expect(captureDialog()).toBeNull();
  });

  test("maxDurationMs on a photo is invalidParams at decode (mode-keyed schema)", async () => {
    const h = connect({ media: fakeMedia() });
    const req = h.send(request("camera.capture", { mode: "photo", maxDurationMs: 1000 }, { initialCredit: 1 << 20 }));
    expect((await h.response(req.id)).error?.code).toBe("invalidParams");
    expect(captureDialog()).toBeNull();
  });

  test("server cancel while the preview is up closes the dialog and stops the camera", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    await waitFor(() => control("capture"));
    h.cancel(req.id);
    expect((await h.response(req.id)).error?.code).toBe("cancelled");
    await waitFor(() => captureDialog() === null);
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("a camera that opens only after the request was cancelled is released at once", async () => {
    const media = fakeMedia();
    let open!: () => void;
    media.gumGate = new Promise<void>((r) => (open = r));
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "photo" }, { initialCredit: 1 << 20 }));
    await waitFor(() => media.constraints.length === 1);
    h.cancel(req.id);
    expect((await h.response(req.id)).error?.code).toBe("cancelled");
    open();
    await waitFor(() => media.streams[0]);
    await waitFor(() => media.streams[0]!.allStopped);
    expect(captureDialog()).toBeNull();
  });

  test("video: Record → bytes stream undeclared as recorded; Stop is success with the full hash", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "video", facing: "back", maxDurationMs: 60_000 }, { initialCredit: 1 << 20 }));
    await waitFor(captureDialog);
    expect(captureDialog()!.textContent).toContain("record a video");
    await activate(await waitFor(() => control("record")));
    const rec = await waitFor(() => media.recorders[0]);
    expect(media.constraints[0]).toEqual({ video: { facingMode: { ideal: "environment" } }, audio: true });
    expect(rec.state).toBe("recording");
    expect(rec.timeslice).toBe(250);
    await waitFor(() => h.events(req.id).some((e) => e.kind === "blobStart"));
    expect(h.events(req.id).find((e) => e.kind === "blobStart")).toEqual({ kind: "blobStart", channel: 0, contentType: "video/webm" });
    rec.emit(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
    await waitFor(() => h.frames.length === 1); // sent as recorded
    rec.emit(new Uint8Array([4, 5, 6]));
    await waitFor(() => h.frames.length === 2);
    expect(captureDialog()!.textContent).toContain("Recording");
    control("stop")!.click();
    const res = await h.response(req.id);
    const all = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 0xee, 0xff]);
    expect(res.result).toEqual({ items: [{ channel: 0, contentType: "video/webm", bytes: all.byteLength, sha256: await sha256Hex(all) }] });
    expect(h.bytes(req.id)).toEqual(all);
    await waitFor(() => captureDialog() === null);
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("video: maxDurationMs stops the recording normally", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "video", maxDurationMs: 30 }, { initialCredit: 1 << 20 }));
    await activate(await waitFor(() => control("record")));
    const rec = await waitFor(() => media.recorders[0]);
    rec.emit(new Uint8Array([1, 2, 3]));
    const res = await h.response(req.id);
    expect(res.result?.items).toMatchObject([{ bytes: 5, contentType: "video/webm" }]);
  });

  test("video: Cancel mid-recording discards it (cancelled)", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("camera.capture", { mode: "video" }, { initialCredit: 1 << 20 }));
    await activate(await waitFor(() => control("record")));
    const rec = await waitFor(() => media.recorders[0]);
    rec.emit(new Uint8Array([1, 2, 3]));
    await waitFor(() => h.frames.length === 1);
    control("cancel")!.click();
    expect((await h.response(req.id)).error).toEqual({ code: "cancelled", platformDetail: "capture-cancelled" });
    await waitFor(() => captureDialog() === null);
    expect(rec.state).toBe("inactive");
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("video: starved of credit past the bounded window → throttled capture-buffer-full", async () => {
    const media = fakeMedia();
    const h = connect({ media, captureBufferBytes: { video: 64 } });
    const req = h.send(request("camera.capture", { mode: "video" }, { initialCredit: 16 }));
    await activate(await waitFor(() => control("record")));
    const rec = await waitFor(() => media.recorders[0]);
    // The runtime holds at most about a frame's worth itself; everything
    // beyond waits in the host's bounded window until it overflows.
    for (let i = 0; i < 100 && !h.responseNow(req.id); i++) {
      rec.emit(new Uint8Array(40).fill(i));
      await tick();
    }
    const res = await h.response(req.id);
    expect(res.error).toEqual({ code: "throttled", platformDetail: "capture-buffer-full" });
    expect(h.controls(req.id)).toContainEqual({ paused: true });
    expect(h.bytes(req.id).byteLength).toBe(16); // never beyond credit
    await waitFor(() => captureDialog() === null);
    expect(media.streams[0]!.allStopped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3 mic.record
// ---------------------------------------------------------------------------

describe("C3 mic.record: consent, indicator with Stop, PCM16 at the requested rate", () => {
  const sine = (n: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin((i + phase) / 5) * 0.5);

  test("16 kHz mono from a 48 kHz graph; Stop ends it normally with the exact bytes and hash", async () => {
    const media = fakeMedia({ rate: 48_000 });
    const h = connect({ media, permissions: fakePermissions({ microphone: "prompt" }).api });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 256 * 1024, timeoutMs: 600_000 }));
    await waitFor(consentDialog);
    expect(consentDialog()!.textContent).toContain("record audio");
    expect(consentDialog()!.textContent).toContain("16000 Hz · mono");
    expect(media.constraints).toEqual([]);
    await activate(control("continue")!);
    const capture = await waitFor(() => media.captures[0]);
    expect(capture.channels).toBe(1);
    expect(media.constraints[0]!.audio).toMatchObject({ channelCount: { ideal: 1 }, echoCancellation: false });
    await waitFor(indicator);
    expect(indicator()!.textContent).toContain("ws://app.test:8080");
    expect(consentDialog()).toBeNull();

    const expected = new PcmEncoder(48_000, 16_000, 1);
    const want: number[] = [];
    for (let k = 0; k < 5; k++) {
      const block = sine(2048, k * 2048);
      want.push(...expected.push([block]));
      capture.onBlock([block]);
      await tick();
    }
    await waitFor(() => h.bytes(req.id).byteLength === want.length);
    expect(h.events(req.id)).toContainEqual({ kind: "blobStart", channel: 0, contentType: "audio/L16" });
    control("stop-recording")!.click();
    const res = await h.response(req.id);
    expect(capture.flushed).toBe(1);
    expect(res.result).toEqual({
      durationMs: expected.durationMs,
      item: { channel: 0, contentType: "audio/L16", bytes: want.length, sha256: await sha256Hex(new Uint8Array(want)) },
    });
    expect(Array.from(h.bytes(req.id))).toEqual(want);
    expect(indicator()).toBeNull();
    expect(capture.closed).toBe(true);
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("stereo with maxDurationMs: interleaved frames, exactly the limit, then success", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000, channels: 2, maxDurationMs: 100 }, { initialCredit: 256 * 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    expect(capture.channels).toBe(2);
    for (let k = 0; k < 3; k++) capture.onBlock([sine(1024, k), sine(1024, k + 7)]);
    const res = await h.response(req.id);
    expect(res.result?.durationMs).toBe(100);
    expect(res.result?.item).toMatchObject({ bytes: 1600 * 2 * 2 });
    const pcm = h.bytes(req.id);
    const v = new DataView(pcm.buffer);
    expect(v.getInt16(0, true)).toBe(floatToPcm16(sine(1, 0)[0]!));
    expect(v.getInt16(2, true)).toBe(floatToPcm16(sine(1, 7)[0]!));
    expect(indicator()).toBeNull();
  });

  test("starved of credit: pauses, keeps a bounded window, then throttled capture-buffer-full", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media, captureBufferBytes: { mic: 8192 } });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 2048 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    for (let k = 0; k < 12 && !h.responseNow(req.id); k++) {
      capture.onBlock([sine(1024, k)]);
      await tick();
    }
    const res = await h.response(req.id);
    expect(res.error).toEqual({ code: "throttled", platformDetail: "capture-buffer-full" });
    expect(h.controls(req.id)).toContainEqual({ paused: true });
    expect(h.bytes(req.id).byteLength).toBe(2048);
    expect(indicator()).toBeNull();
    expect(capture.closed).toBe(true);
  });

  test("a grant resumes a paused recording (no loss)", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    capture.onBlock([sine(1024)]); // 2048 bytes, only 1024 credit
    await waitFor(() => h.controls(req.id).some((c) => c.paused === true));
    h.grant(req.id, 4096);
    await waitFor(() => h.bytes(req.id).byteLength === 2048);
    expect(h.controls(req.id)).toContainEqual({ paused: false });
    control("stop-recording")!.click();
    expect((await h.response(req.id)).result?.item).toMatchObject({ bytes: 2048 });
  });

  test("the page becoming hidden stops the recording normally", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 64 * 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    capture.onBlock([sine(320)]);
    Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
    doc.dispatchEvent(new win.Event("visibilitychange"));
    const res = await h.response(req.id);
    expect(res.result).toMatchObject({ durationMs: 20, item: { bytes: 640 } });
    expect(indicator()).toBeNull();
  });

  test("server cancel mid-recording: cancelled, indicator gone, capture and tracks released", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 64 * 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    capture.onBlock([sine(320)]);
    await waitFor(() => h.frames.length > 0);
    h.cancel(req.id);
    expect((await h.response(req.id)).error?.code).toBe("cancelled");
    await waitFor(() => indicator() === null);
    expect(capture.closed).toBe(true);
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("microphone permission revoked mid-recording ends it revoked and releases everything", async () => {
    const perms = fakePermissions({ microphone: "granted", camera: "granted" });
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media, permissions: perms.api });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 64 * 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    capture.onBlock([sine(320)]);
    await waitFor(() => h.frames.length > 0); // the item is already streaming
    perms.statuses.get("microphone")!.set("denied");
    expect((await h.response(req.id)).error).toEqual({ code: "revoked", platformDetail: "permission:microphone" });
    await waitFor(() => indicator() === null);
    expect(capture.closed).toBe(true);
    expect(media.streams[0]!.allStopped).toBe(true);
  });

  test("a microphone that opens only after the request was cancelled is released at once", async () => {
    const media = fakeMedia();
    let open!: () => void;
    media.gumGate = new Promise<void>((r) => (open = r));
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 1024 }));
    await activate(await waitFor(() => control("continue")));
    await waitFor(() => media.constraints.length === 1);
    h.cancel(req.id);
    expect((await h.response(req.id)).error?.code).toBe("cancelled");
    open();
    await waitFor(() => media.streams[0]);
    await waitFor(() => media.streams[0]!.allStopped);
    expect(media.captures.length).toBe(0);
    expect(indicator()).toBeNull();
  });

  test("host Cancel before recording is denied; the microphone is never opened", async () => {
    const media = fakeMedia();
    const h = connect({ media });
    const req = h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 1024 }));
    (await waitFor(() => control("cancel")))!.click();
    expect((await h.response(req.id)).error?.code).toBe("denied");
    expect(media.constraints).toEqual([]);
    expect(indicator()).toBeNull();
  });

  test("detach stops a live recording", async () => {
    const media = fakeMedia({ rate: 16_000 });
    const h = connect({ media });
    h.send(request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { initialCredit: 1024 }));
    await activate(await waitFor(() => control("continue")));
    const capture = await waitFor(() => media.captures[0]);
    await waitFor(indicator);
    h.host.detach();
    await waitFor(() => indicator() === null);
    expect(capture.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 bluetooth.select
// ---------------------------------------------------------------------------

describe("C4 bluetooth.select through Web Bluetooth (fake navigator.bluetooth)", () => {
  const HR = "0000180d-0000-1000-8000-00805f9b34fb";

  test("consent, then requestDevice inside the click with services + namePrefix filters; identity only", async () => {
    const calls: unknown[] = [];
    const bluetooth: BluetoothLike = {
      requestDevice: async (o) => (calls.push(o), { id: "GFr+TN2aaAMihU6dGsTq5Q==", name: "Heart Rate" }),
    };
    const h = connect({ bluetooth });
    expect(h.host.advertisement.capabilities.map((c) => c.name)).toContain("bluetooth.select");
    const req = h.send(request("bluetooth.select", { services: [HR], namePrefix: "Heart" }));
    await waitFor(consentDialog);
    expect(consentDialog()!.textContent).toContain("Bluetooth");
    expect(consentDialog()!.textContent).toContain(HR);
    expect(calls).toEqual([]);
    await activate(control("continue")!);
    expect((await h.response(req.id)).result).toEqual({ device: { id: "GFr+TN2aaAMihU6dGsTq5Q==", name: "Heart Rate" } });
    expect(calls).toEqual([{ filters: [{ services: [HR], namePrefix: "Heart" }], optionalServices: [HR] }]);
  });

  test("no filters → acceptAllDevices; a nameless device has no name; long names truncate by code points", async () => {
    const answers = [{ id: "dev-1", name: null }, { id: "dev-2", name: "😀".repeat(300) }];
    const calls: unknown[] = [];
    const h = connect({ bluetooth: { requestDevice: async (o) => (calls.push(o), answers.shift()!) } });
    const a = h.send(request("bluetooth.select", {}));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(a.id)).result).toEqual({ device: { id: "dev-1" } });
    expect(calls[0]).toEqual({ acceptAllDevices: true });
    const b = h.send(request("bluetooth.select", {}));
    await activate(await waitFor(() => control("continue")));
    const name = ((await h.response(b.id)).result as { device: { name: string } }).device.name;
    expect(Array.from(name).length).toBe(256);
  });

  test("chooser dismissal is cancelled; a security refusal is denied", async () => {
    const errors = [Object.assign(new Error("User cancelled"), { name: "NotFoundError" }), Object.assign(new Error("nope"), { name: "SecurityError" })];
    const h = connect({ bluetooth: { requestDevice: async () => Promise.reject(errors.shift()) } });
    const a = h.send(request("bluetooth.select", {}));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(a.id)).error).toEqual({ code: "cancelled", platformDetail: "chooser-dismissed" });
    const b = h.send(request("bluetooth.select", {}));
    await activate(await waitFor(() => control("continue")));
    expect((await h.response(b.id)).error?.code).toBe("denied");
  });

  test("without Web Bluetooth it is not advertised, and a request anyway is unsupported", async () => {
    const h = connect({});
    expect(h.host.advertisement.capabilities.map((c) => c.name)).not.toContain("bluetooth.select");
    const forced = connect({ capabilities: ALL_CAPS });
    const req = forced.send(request("bluetooth.select", {}));
    expect((await forced.response(req.id)).error).toEqual({ code: "unsupported", platformDetail: "no-web-bluetooth" });
  });

  test("a non-canonical service UUID is invalidParams at decode", async () => {
    const h = connect({ bluetooth: { requestDevice: async () => ({ id: "x" }) } });
    const req = h.send(request("bluetooth.select", { services: ["0x180d"] }));
    expect((await h.response(req.id)).error?.code).toBe("invalidParams");
    expect(consentDialog()).toBeNull();
  });
});

describe("advertisement follows platform support", () => {
  test("camera.capture / mic.record / bluetooth.select appear only when the browser can drive them", () => {
    const bare = connect({});
    const names = bare.host.advertisement.capabilities.map((c) => c.name);
    expect(names).not.toContain("camera.capture");
    expect(names).not.toContain("mic.record");
    const full = connect({ media: fakeMedia(), bluetooth: { requestDevice: async () => ({ id: "x" }) } });
    const all = full.host.advertisement.capabilities.map((c) => c.name);
    for (const name of ["camera.capture", "mic.record", "bluetooth.select", "permission.query", "permission.request"]) {
      expect(all).toContain(name);
    }
  });

  test("background mic.record is unavailable (no compliant background indicator)", async () => {
    const h = connect({ media: fakeMedia() });
    const run = (h.host as unknown as { buildDrivers(): Map<string, DeviceDriver> }).buildDrivers().get("mic.record")!;
    const outcome: DriverOutcome = await run({
      request: request("mic.record", { format: "pcm16", sampleRate: 16_000 }, { lifetime: "background", owner: { moduleInstanceId: "m1" } }),
      cancelled: new Promise(() => {}),
      emit: () => {},
    });
    expect(outcome).toEqual({ kind: "error", code: "unavailable", platformDetail: "no-background-indicator" });
  });
});
