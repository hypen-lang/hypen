/**
 * @hypen-space/device-web drivers under JSDOM (RFC 001 §2.4 / §2.6 / §5).
 *
 * Covers the host-owned admission and consent flow for file.pick/file.save,
 * background-lifetime refusal, permission revocation mid-request, and the
 * core.capabilities re-advertisement. The real-Chromium activation path is
 * covered separately in device-browser.test.ts; here a trusted click is
 * simulated by flipping JSDOM's internal `isTrusted` for exactly one click.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  decodeFrame,
  encodeFrame,
  sha256Hex,
  type DeviceDriver,
  type DeviceEvent,
  type DeviceRequest,
  type DeviceResponse,
  type DriverContext,
  type DriverOutcome,
} from "@hypen-space/core/remote/device";
import { findRevision } from "../packages/core/src/remote/device/registry.ts";
import {
  WebDeviceHost,
  type DownloadSinkLike,
  type PermissionsLike,
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

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 1000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await tick();
  }
}

/** Dispatch an event JSDOM treats as trusted (stands in for real user input). */
function trusted(el: Element, ev: Event): void {
  const flip = (e: Event) => {
    (e as unknown as Record<symbol, { isTrusted: boolean }>)[implSymbol]!.isTrusted = true;
  };
  win.addEventListener(ev.type, flip, { capture: true, once: true });
  el.dispatchEvent(ev);
}

/** A trusted click (press + click) whose press started on `el`, right now. */
function trustedClick(el: Element): void {
  trusted(el, new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  trusted(el, new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * A real user's activation of the host's Continue: wait until its input
 * protection armed it (enabled), then a trusted press + click on it.
 */
async function activate(el: Element): Promise<void> {
  await waitFor(() => !(el as HTMLButtonElement).disabled);
  trustedClick(el);
}

/** A driver blob's bytes, whether it carries them or streams them (D5). */
async function blobBytes(blob: { bytes?: Uint8Array; stream?: AsyncIterable<Uint8Array> }): Promise<Uint8Array> {
  if (blob.bytes) return blob.bytes;
  const parts: number[] = [];
  for await (const chunk of blob.stream!) parts.push(...chunk);
  return new Uint8Array(parts);
}

const dialog = () => doc.querySelector("[data-hypen-device-dialog]");
const button = (which: "continue" | "cancel") =>
  doc.querySelector(`[data-hypen-device="${which}"]`) as HTMLElement | null;

/** Answer the next `<input type=file>` the host opens with these files. */
function answerFilePicker(files: File[] | "dismiss"): Promise<HTMLInputElement> {
  return new Promise((resolve) => {
    const onClick = (ev: Event) => {
      const input = ev.target as HTMLInputElement;
      if (input?.tagName !== "INPUT" || input.type !== "file") return;
      doc.removeEventListener("click", onClick, true);
      queueMicrotask(() => {
        if (files === "dismiss") {
          input.dispatchEvent(new win.Event("cancel"));
        } else {
          Object.defineProperty(input, "files", { value: files, configurable: true });
          input.dispatchEvent(new win.Event("change"));
        }
        resolve(input);
      });
    };
    doc.addEventListener("click", onClick, true);
  });
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
  for (const [k, v] of Object.entries(initial)) statuses.set(k, new FakeStatus(v));
  const api: PermissionsLike = {
    async query({ name }) {
      const s = statuses.get(name);
      if (!s) throw new TypeError(`unknown permission ${name}`);
      return s;
    },
  };
  return { api, statuses };
}

let nextId = 1;
function request(
  capability: string,
  params: Record<string, unknown>,
  over: Partial<DeviceRequest> = {}
): DeviceRequest {
  return {
    type: "deviceRequest",
    id: nextId++,
    capability,
    version: 1,
    owner: { moduleInstanceId: "m1", activationId: 1 },
    lifetime: "activation",
    timeoutMs: 30_000,
    initialCredit: 1024 * 1024, // uploads are credit-paced by the runtime
    params,
    ...over,
  };
}

interface Harness {
  host: WebDeviceHost;
  sent: Array<DeviceResponse | DeviceEvent>;
  frames: Uint8Array[];
  /** Run a guarded driver directly with a hand-built context. */
  run(
    req: DeviceRequest,
    extra?: { download?: DownloadSinkLike; revision?: DriverContext["revision"] }
  ): { outcome: Promise<DriverOutcome>; cancel(): void; events: Array<Record<string, unknown>> };
}

/** The full-registry selection a device-enabled server acks. */
const FULL_ACK = {
  protocolVersion: 1,
  binary: true,
  capabilities: [
    "core.capabilities",
    "gallery.pick",
    "file.pick",
    "file.save",
    "permission.query",
    "permission.request",
    "bluetooth.scan",
  ].map((name) => ({ name, version: 1 })),
};

/**
 * What a real connection does before app work (RFC 001 §2.2): the ack's
 * selection, then the connection-owned core.capabilities stream.
 */
function openConnection(host: WebDeviceHost): void {
  host.onAck(FULL_ACK);
  host.handleMessage(request("core.capabilities", {}, { lifetime: "connection", owner: { connection: true }, timeoutMs: 86_400_000, initialCredit: 8 }));
}

function harness(opts: Partial<WebDeviceHostOptions> = {}): Harness {
  const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5, ...opts });
  const sent: Array<DeviceResponse | DeviceEvent> = [];
  const frames: Uint8Array[] = [];
  host.attach({ sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) });
  openConnection(host);
  // The guarded driver table the host hands its DeviceClient.
  const drivers = (host as unknown as { buildDrivers(): Map<string, DeviceDriver> }).buildDrivers();
  return {
    host,
    sent,
    frames,
    run(req, extra = {}) {
      let cancel!: () => void;
      const cancelled = new Promise<void>((r) => (cancel = r));
      const events: Array<Record<string, unknown>> = [];
      const ctx: DriverContext & { download?: DownloadSinkLike } = {
        request: req,
        cancelled,
        emit: (e) => events.push(e),
        ...(extra.download ? { download: extra.download } : {}),
        ...(extra.revision ? { revision: extra.revision } : {}),
      };
      const driver = drivers.get(req.capability);
      if (!driver) throw new Error(`no driver for ${req.capability}`);
      return { outcome: driver(ctx), cancel, events };
    },
  };
}

function fakeSink(bytes: Uint8Array, declared: Partial<DownloadSinkLike["declared"]> = {}) {
  let calls = 0;
  let reject: ((e: unknown) => void) | null = null;
  const sink: DownloadSinkLike & { readonly calls: number; fail(code: string): void } = {
    declared: {
      name: "report.csv",
      contentType: "text/csv",
      bytes: bytes.byteLength,
      sha256: "0".repeat(64),
      ...declared,
    },
    get calls() {
      return calls;
    },
    fail(code: string) {
      reject?.(Object.assign(new Error(`download ${code}`), { code }));
    },
    receiveAll() {
      calls += 1;
      return new Promise<Uint8Array>((resolve, rej) => {
        reject = rej;
        queueMicrotask(() => {
          if (reject === rej) resolve(bytes);
        });
      });
    },
  };
  return sink;
}

/** A sink whose receiveAll() stays pending until `fail(code)`. */
function pendingSink(bytes: number) {
  let calls = 0;
  let reject: ((e: unknown) => void) | null = null;
  return {
    declared: { name: "big.bin", contentType: "application/octet-stream", bytes, sha256: "0".repeat(64) },
    get calls() {
      return calls;
    },
    fail(code: string) {
      reject?.(Object.assign(new Error(`download ${code}`), { code }));
    },
    receiveAll() {
      calls += 1;
      return new Promise<Uint8Array>((_, rej) => (reject = rej));
    },
  };
}

// ---------------------------------------------------------------------------

describe("advertisement", () => {
  test("file.pick and file.save are advertised built-ins", () => {
    const { host } = harness();
    const names = host.advertisement.capabilities.map((c) => c.name);
    expect(names).toContain("file.pick");
    expect(names).toContain("file.save");
    expect(names).toContain("gallery.pick");
  });
});

describe("file.pick", () => {
  test("host Continue opens a real <input type=file> with the requested accept list; names ride on blobs", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: ["application/pdf", ".txt", "image/*"], maxCount: 2 }));
    await waitFor(dialog);
    expect(dialog()!.textContent).toContain("ws://app.test:8080");
    expect(dialog()!.textContent).toContain("choose a file");

    const picked = answerFilePicker([
      new File(["alpha"], "a.pdf", { type: "application/pdf" }),
      new File(["beta!"], "b.txt", { type: "" }),
      new File(["gamma"], "c.png", { type: "image/png" }),
    ]);
    await activate(button("continue")!);
    const input = await picked;
    expect(input.accept).toBe("application/pdf,.txt,image/*");
    expect(input.multiple).toBe(true);

    const outcome = await run.outcome;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    const blobs = outcome.blobs!;
    expect(blobs.length).toBe(2); // clamped to maxCount
    expect(blobs.map((b) => b.name)).toEqual(["a.pdf", "b.txt"]);
    expect(blobs[1]!.contentType).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await blobBytes(blobs[0]!))).toBe("alpha");
    expect(dialog()).toBeNull();
    expect(doc.querySelector('[data-hypen-device="file-input"]')).toBeNull();
  });

  test("through DeviceClient: blobStart + frames, then a terminal result with hashed items", async () => {
    const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5 });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const frames: Uint8Array[] = [];
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) });
    openConnection(host);
    const req = request("file.pick", { accept: ["text/plain"], maxCount: 1 });
    host.handleMessage(req);
    await waitFor(dialog);
    const picked = answerFilePicker([new File(["hello file"], "hello.txt", { type: "text/plain" })]);
    await activate(button("continue")!);
    await picked;
    const res = await waitFor(() => sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res.id).toBe(req.id);
    const items = (res.result as { items: Array<{ channel: number; bytes: number; sha256: string }> }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.bytes).toBe(10);
    expect(items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.some((m) => m.type === "deviceEvent" && (m.event as { kind?: string })?.kind === "blobStart")).toBe(true);
    expect(decodeFrame(frames[0]!).header.requestId).toBe(req.id);
    host.detach();
  });

  test("an accept entry with a comma is invalidParams before any dialog", async () => {
    const h = harness();
    const outcome = await h.run(request("file.pick", { accept: ["image/png,text/html"], maxCount: 1 })).outcome;
    expect(outcome).toMatchObject({ kind: "error", code: "invalidParams" });
    expect(dialog()).toBeNull();
  });

  test("OS picker dismissal is cancelled, not a denial (no cooldown)", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const picked = answerFilePicker("dismiss");
    await activate(button("continue")!);
    await picked;
    expect(await run.outcome).toMatchObject({ kind: "error", code: "cancelled", platformDetail: "picker-dismissed" });
    // Not throttled afterwards: a new request shows the dialog again.
    const again = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    button("cancel")!.click();
    expect(await again.outcome).toMatchObject({ code: "denied" });
  });

  test("host Cancel is denied + cooldown; the retry is throttled with no dialog", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    button("cancel")!.click();
    expect(await run.outcome).toMatchObject({ kind: "error", code: "denied", platformDetail: "host-refused" });
    const retry = await h.run(request("file.pick", { accept: [], maxCount: 1 })).outcome;
    expect(retry).toMatchObject({ kind: "error", code: "throttled", platformDetail: "cooldown" });
    expect(dialog()).toBeNull();
  });

  test("an untrusted (synthetic) Continue click is a refusal, not an activation", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    await waitFor(() => !(button("continue") as HTMLButtonElement).disabled);
    button("continue")!.click(); // isTrusted === false
    expect(await run.outcome).toMatchObject({ code: "denied" });
  });

  test("server cancel while the dialog is up settles cancelled and removes the dialog", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    run.cancel();
    expect(await run.outcome).toMatchObject({ kind: "error", code: "cancelled" });
    expect(dialog()).toBeNull();
  });
});

describe("picker memory bounds and dialog teardown", () => {
  test("a file over the revision's maxItemBytes is refused throttled before any byte is read", async () => {
    const h = harness();
    const revision = { ...findRevision("file.pick", 1)!, maxItemBytes: 8 };
    const run = h.run(request("file.pick", { accept: [], maxCount: 2 }), { revision });
    await waitFor(dialog);
    const small = new File(["tiny"], "a.txt", { type: "text/plain" });
    const big = new File(["0123456789"], "b.bin", { type: "application/octet-stream" });
    let reads = 0;
    for (const f of [small, big]) {
      const orig = f.arrayBuffer.bind(f);
      f.arrayBuffer = () => {
        reads += 1;
        return orig();
      };
    }
    const picked = answerFilePicker([small, big]);
    await activate(button("continue")!);
    await picked;
    expect(await run.outcome).toEqual({ kind: "error", code: "throttled", platformDetail: "item exceeds size limit" });
    expect(reads).toBe(0);
  });

  test("server cancel while the dialog is open settles the present() promise (no leaked closures)", async () => {
    const h = harness();
    const internals = h.host as unknown as { dialog: { present: (...a: unknown[]) => Promise<unknown> } };
    let presented: Promise<unknown> | null = null;
    const original = internals.dialog.present.bind(internals.dialog);
    internals.dialog.present = (...a: unknown[]) => (presented = original(...a));
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    run.cancel();
    expect(await run.outcome).toMatchObject({ code: "cancelled" });
    expect(await presented!).toBe("dismissed");
    expect(dialog()).toBeNull();
  });

  test("detach while the dialog is open is not a user refusal: no cooldown afterwards", async () => {
    const h = harness();
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    h.host.detach();
    expect(await run.outcome).toMatchObject({ code: "cancelled", platformDetail: "dialog-dismissed" });
    expect(dialog()).toBeNull();
    h.host.attach({ sendMessage: () => {}, sendBinary: () => {} });
    const again = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog); // not throttled by a cooldown
    button("cancel")!.click();
    expect(await again.outcome).toMatchObject({ code: "denied" });
  });

  test("the runtime's local deadline ends a pending consent dialog with timeout", async () => {
    const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, maxTimeoutMs: 40, inputProtectionMs: 5 });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: () => {} });
    openConnection(host);
    host.handleMessage(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const res = await waitFor(() => sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res.error).toEqual({ code: "timeout", platformDetail: "local deadline" });
    await waitFor(() => dialog() === null);
    host.detach();
  });

  test("advertises only capabilities the runtime can admit (registry revision + schema)", () => {
    const { host } = harness({ drivers: { "geo.watch": async () => ({ kind: "result", result: {} }) } });
    const names = host.advertisement.capabilities.map((c) => c.name);
    expect(names).not.toContain("geo.watch");
    expect(names).toContain("gallery.pick");
  });
});

describe("one prompt at a time", () => {
  test("a second prompt-raising request is throttled while the first is pending", async () => {
    const h = harness();
    const first = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const second = await h.run(request("file.save", {}), { download: fakeSink(new Uint8Array(4)) }).outcome;
    expect(second).toMatchObject({ kind: "error", code: "throttled", platformDetail: "prompt-in-progress" });
    const third = await h.run(request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 })).outcome;
    expect(third).toMatchObject({ code: "throttled" });
    expect(doc.querySelectorAll("[data-hypen-device-dialog]").length).toBe(1);
    first.cancel();
    await first.outcome;
  });

  test("the slot is held while the OS picker is open (after the dialog closed)", async () => {
    const h = harness();
    const first = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    await activate(button("continue")!); // picker opens, nobody answers yet
    await tick();
    expect(dialog()).toBeNull();
    const second = await h.run(request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 })).outcome;
    expect(second).toMatchObject({ code: "throttled", platformDetail: "prompt-in-progress" });
    first.cancel();
    expect(await first.outcome).toMatchObject({ code: "cancelled" });
  });
});

describe("file.save", () => {
  test("oversize declaration is invalidParams before any dialog; no credit granted", async () => {
    const h = harness({ maxDownloadBytes: 1024 });
    const sink = pendingSink(4096);
    const outcome = await h.run(request("file.save", {}), { download: sink }).outcome;
    expect(outcome).toMatchObject({ kind: "error", code: "invalidParams" });
    expect(dialog()).toBeNull();
    expect(sink.calls).toBe(0);
  });

  test("without a download sink the driver is unavailable", async () => {
    const h = harness();
    expect(await h.run(request("file.save", {})).outcome).toMatchObject({
      code: "unavailable",
      platformDetail: "no-download-sink",
    });
  });

  test("fallback path: dialog names origin, file and size; receiveAll only after Continue; <a download> triggered", async () => {
    const h = harness();
    const bytes = new TextEncoder().encode("a,b,c\n1,2,3\n");
    const sink = fakeSink(bytes, { name: "../../report.csv" });
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    const text = dialog()!.textContent!;
    expect(text).toContain("ws://app.test:8080");
    expect(text).toContain("save a file");
    expect(text).toContain("Name: .._.._report"); // path separators neutralised
    expect(text).toContain("Type: .csv"); // the extension is shown on its own
    expect(text).toContain("12 B");
    await tick();
    expect(sink.calls).toBe(0); // zero credit until consent + destination

    let clicked: HTMLAnchorElement | null = null;
    doc.addEventListener(
      "click",
      (ev) => {
        const a = ev.target as HTMLAnchorElement;
        if (a.tagName === "A") {
          clicked = a;
          ev.preventDefault();
        }
      },
      true
    );
    await activate(button("continue")!);
    const outcome = await run.outcome;
    expect(outcome).toEqual({ kind: "result", result: { bytesWritten: bytes.byteLength } });
    expect(sink.calls).toBe(1);
    expect(clicked).not.toBeNull();
    expect(clicked!.download).toBe(".._.._report.csv");
    expect(clicked!.href.startsWith("blob:")).toBe(true);
    expect(doc.querySelector('[data-hypen-device="download-link"]')).toBeNull();
  });

  test("through DeviceClient: no grant before Continue; credit-paced frames land in the <a download>", async () => {
    const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5 });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: () => {} });
    openConnection(host);
    const payload = new TextEncoder().encode("downloaded-bytes-".repeat(8000)); // ~133 KiB → 3 frames
    const req = request(
      "file.save",
      {
        channel: 0,
        name: "export.txt",
        contentType: "text/plain",
        bytes: payload.byteLength,
        sha256: await sha256Hex(payload),
      },
      { initialCredit: 0 }
    );
    host.handleMessage(req);
    await waitFor(dialog);
    await tick();
    const grants = () =>
      sent.filter((m) => m.type === "deviceEvent" && m.control && "grant" in m.control).length;
    expect(grants()).toBe(0); // zero credit while consent is pending

    let downloaded: string | null = null;
    doc.addEventListener(
      "click",
      (ev) => {
        const a = ev.target as HTMLAnchorElement;
        if (a.tagName === "A") {
          downloaded = a.download;
          ev.preventDefault();
        }
      },
      true
    );
    await activate(button("continue")!);
    await waitFor(() => grants() > 0);
    const CHUNK = 64 * 1024;
    for (let off = 0, seq = 0; off < payload.byteLength; off += CHUNK, seq++) {
      host.handleFrame(
        encodeFrame(
          { version: 1, flags: 0, channel: 0, requestId: req.id, seq },
          payload.subarray(off, Math.min(off + CHUNK, payload.byteLength))
        )
      );
    }
    const res = await waitFor(() => sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res).toMatchObject({ id: req.id, result: { bytesWritten: payload.byteLength } });
    expect(downloaded).toBe("export.txt");
    host.detach();
  });

  test("a rejected receiveAll maps to its DeviceErrorCode", async () => {
    for (const code of ["invalidParams", "cancelled"] as const) {
      const h = harness();
      const sink = pendingSink(8);
      const run = h.run(request("file.save", {}), { download: sink });
      await waitFor(dialog);
      await activate(button("continue")!);
      await waitFor(() => sink.calls === 1);
      sink.fail(code);
      expect(await run.outcome).toMatchObject({ kind: "error", code });
    }
  });

  test("File System Access path: picker inside the click, write + close, bytesWritten", async () => {
    const h = harness();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const sink = fakeSink(bytes, { name: "data.bin" });
    const writes: Blob[] = [];
    let closed = false;
    let suggested: string | undefined;
    let callsAtPick = -1;
    (win as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o: { suggestedName?: string }) => {
      suggested = o.suggestedName;
      callsAtPick = sink.calls;
      return {
        createWritable: async () => ({
          write: async (b: Blob) => void writes.push(b),
          close: async () => void (closed = true),
          abort: async () => undefined,
        }),
      };
    };
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    await activate(button("continue")!);
    expect(await run.outcome).toEqual({ kind: "result", result: { bytesWritten: 5 } });
    expect(suggested).toBe("data.bin");
    expect(callsAtPick).toBe(0); // destination chosen before credit was granted
    expect(closed).toBe(true);
    expect(new Uint8Array(await writes[0]!.arrayBuffer())).toEqual(bytes);
  });

  test("save picker dismissal (AbortError) is cancelled and never grants credit", async () => {
    const h = harness();
    const sink = pendingSink(8);
    (win as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      throw Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    };
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    await activate(button("continue")!);
    expect(await run.outcome).toMatchObject({ kind: "error", code: "cancelled", platformDetail: "picker-dismissed" });
    expect(sink.calls).toBe(0);
  });

  test("host Cancel is denied + cooldown and never grants credit", async () => {
    const h = harness();
    const sink = pendingSink(8);
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    button("cancel")!.click();
    expect(await run.outcome).toMatchObject({ code: "denied" });
    expect(sink.calls).toBe(0);
    expect(await h.run(request("file.save", {}), { download: pendingSink(8) }).outcome).toMatchObject({
      code: "throttled",
      platformDetail: "cooldown",
    });
  });
});

describe("background lifetime", () => {
  test("background requests are unavailable: no compliant background indicator on the web", async () => {
    const h = harness();
    for (const cap of ["gallery.pick", "file.pick", "file.save", "permission.query"]) {
      const outcome = await h.run(request(cap, {}, { lifetime: "background" }), {
        download: fakeSink(new Uint8Array(1)),
      }).outcome;
      expect(outcome).toEqual({ kind: "error", code: "unavailable", platformDetail: "no-background-indicator" });
    }
    expect(dialog()).toBeNull();
  });
});

describe("permission revocation", () => {
  test("a live request whose permission flips to denied ends with revoked; the driver observes cancellation", async () => {
    const perms = fakePermissions({ geolocation: "granted" });
    let driverSawCancel = false;
    const h = harness({
      permissions: perms.api,
      permissionDependencies: { "bluetooth.scan": "geolocation" },
      drivers: {
        "bluetooth.scan": async ({ cancelled }) => {
          await cancelled;
          driverSawCancel = true;
          return { kind: "result", result: {} };
        },
      },
    });
    expect(h.host.advertisement.capabilities.map((c) => c.name)).toContain("bluetooth.scan");
    const run = h.run(request("bluetooth.scan", {}));
    await tick();
    await tick();
    perms.statuses.get("geolocation")!.set("prompt"); // not a revocation
    await tick();
    perms.statuses.get("geolocation")!.set("denied");
    expect(await run.outcome).toEqual({ kind: "error", code: "revoked", platformDetail: "permission:geolocation" });
    await tick();
    expect(driverSawCancel).toBe(true);
  });

  test("revocation through DeviceClient reaches the wire as a revoked response", async () => {
    const perms = fakePermissions({ geolocation: "granted" });
    const host = new WebDeviceHost({
      origin: "ws://app.test:8080",
      mount: doc.body,
      permissions: perms.api,
      permissionDependencies: { "bluetooth.scan": "geolocation" },
      drivers: { "bluetooth.scan": async ({ cancelled }) => (await cancelled, { kind: "result", result: {} }) },
    });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: () => {} });
    openConnection(host);
    // A registered JSON-stream revision: event credit ≤ its maxInitialCredit.
    const req = request("bluetooth.scan", {}, { initialCredit: 16 });
    host.handleMessage(req);
    await tick();
    await tick();
    perms.statuses.get("geolocation")!.set("denied");
    const res = await waitFor(() => sent.find((m): m is DeviceResponse => m.type === "deviceResponse"));
    expect(res).toMatchObject({ id: req.id, error: { code: "revoked" } });
    host.detach();
  });

  test("a watched permission change re-emits a full core.capabilities advertisement", async () => {
    const perms = fakePermissions({ geolocation: "granted" });
    const h = harness({
      permissions: perms.api,
      permissionDependencies: { "bluetooth.scan": "geolocation" },
      drivers: { "bluetooth.scan": async () => ({ kind: "result", result: {} }) },
    });
    const stream = h.run(request("core.capabilities", {}, { lifetime: "connection", owner: { connection: true } }));
    expect(stream.events.length).toBe(1);
    await tick();
    await tick();
    perms.statuses.get("geolocation")!.set("denied");
    expect(stream.events.length).toBe(2);
    const names = (stream.events[1] as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name);
    expect(names).toEqual(h.host.advertisement.capabilities.map((c) => c.name));
    stream.cancel();
    expect(await stream.outcome).toEqual({ kind: "result", result: {} });
    // After the stream ended, changes no longer emit on it.
    perms.statuses.get("geolocation")!.set("granted");
    expect(stream.events.length).toBe(2);
  });

  test("detach tears down permission watches", async () => {
    const perms = fakePermissions({ geolocation: "granted" });
    const h = harness({
      permissions: perms.api,
      permissionDependencies: { "bluetooth.scan": "geolocation" },
      drivers: { "bluetooth.scan": async () => ({ kind: "result", result: {} }) },
    });
    const stream = h.run(request("core.capabilities", {}, { lifetime: "connection", owner: { connection: true } }));
    await tick();
    await tick();
    h.host.detach();
    perms.statuses.get("geolocation")!.set("denied");
    expect(stream.events.length).toBe(1);
    stream.cancel();
    await stream.outcome;
  });
});


// ---------------------------------------------------------------------------
// review2-ts #6: input protection (keyjacking / click-through)
// ---------------------------------------------------------------------------

describe("consent dialog input protection (review2 #6)", () => {
  test("Continue is never focused on open; the dialog panel is", async () => {
    const chat = doc.createElement("input");
    doc.body.append(chat);
    chat.focus();
    const h = harness({ inputProtectionMs: 50 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    expect(doc.activeElement).not.toBe(button("continue"));
    expect(doc.activeElement?.closest("[data-hypen-device-dialog]")).not.toBeNull();
    run.cancel();
    await run.outcome;
  });

  test("activations during the protection window are ignored (not refusals); a fresh one afterwards counts", async () => {
    const h = harness({ inputProtectionMs: 60 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const cont = button("continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    // A click already "in flight" when the dialog appeared: ignored.
    trustedClick(cont);
    // A keystroke meant for the app (Space/Enter) while the dialog is up.
    trusted(cont, new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).not.toBeNull();
    let settled = false;
    void run.outcome.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    // Armed: a trusted click whose press did NOT start on Continue is ignored.
    await waitFor(() => !cont.disabled);
    trusted(cont, new win.MouseEvent("click", { bubbles: true }));
    await tick();
    expect(dialog()).not.toBeNull();
    // A press + click that starts on the armed button activates.
    const picked = answerFilePicker("dismiss");
    trustedClick(cont);
    await picked;
    expect(await run.outcome).toMatchObject({ kind: "error", code: "cancelled", platformDetail: "picker-dismissed" });
  });

  test("keyboard activation needs a fresh Enter/Space on the armed Continue (auto-repeat does not count)", async () => {
    const h = harness({ inputProtectionMs: 5 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const cont = button("continue") as HTMLButtonElement;
    await waitFor(() => !cont.disabled);
    trusted(cont, new win.KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
    trusted(cont, new win.MouseEvent("click", { bubbles: true }));
    await tick();
    expect(dialog()).not.toBeNull();
    const picked = answerFilePicker("dismiss");
    trusted(cont, new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    trusted(cont, new win.MouseEvent("click", { bubbles: true }));
    await picked;
    expect(await run.outcome).toMatchObject({ code: "cancelled" });
  });

  test("regaining window focus or visibility restarts the protection window", async () => {
    const h = harness({ inputProtectionMs: 40 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(dialog);
    const cont = button("continue") as HTMLButtonElement;
    await waitFor(() => !cont.disabled);
    win.dispatchEvent(new win.Event("blur"));
    expect(cont.disabled).toBe(true);
    win.dispatchEvent(new win.Event("focus"));
    expect(cont.disabled).toBe(true);
    await waitFor(() => !cont.disabled);
    doc.dispatchEvent(new win.Event("visibilitychange")); // JSDOM: visible ⇒ re-arm
    expect(cont.disabled).toBe(true);
    await waitFor(() => !cont.disabled);
    run.cancel();
    await run.outcome;
  });
});

// ---------------------------------------------------------------------------
// Host-owned drop zone: dropping files onto the consent dialog is the pick
// ---------------------------------------------------------------------------

describe("consent dialog drop zone (file.pick / gallery.pick)", () => {
  const zone = () => doc.querySelector('[data-hypen-device="drop-zone"]') as HTMLElement | null;

  /** A drag event carrying `files` (JSDOM has no DragEvent/DataTransfer). */
  function dragEvent(type: string, files: File[]): Event {
    const ev = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: ["Files"], files, dropEffect: "none" },
    });
    return ev;
  }

  const armed = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  test("a drop that entered the armed zone resolves the pick with those files — no OS picker", async () => {
    const h = harness({ inputProtectionMs: 5 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 3 }));
    await waitFor(zone);
    await armed();
    let pickerOpened = false;
    doc.addEventListener("click", (ev) => {
      if ((ev.target as HTMLInputElement).type === "file") pickerOpened = true;
    }, true);
    const files = [new File(["one"], "one.txt", { type: "text/plain" }), new File(["two"], "two.md", { type: "" })];
    trusted(zone()!, dragEvent("dragenter", files));
    trusted(zone()!, dragEvent("drop", files));
    const outcome = await run.outcome;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.blobs!.map((b) => b.name)).toEqual(["one.txt", "two.md"]);
    expect(new TextDecoder().decode(await blobBytes(outcome.blobs![0]!))).toBe("one");
    expect(pickerOpened).toBe(false);
    expect(dialog()).toBeNull();
  });

  test("a drop inside the protection window, or without entering the armed zone, is ignored", async () => {
    const h = harness({ inputProtectionMs: 60 });
    const run = h.run(request("file.pick", { accept: [], maxCount: 1 }));
    await waitFor(zone);
    const files = [new File(["x"], "x.txt", { type: "text/plain" })];
    // The drag the user was already holding when the dialog popped up.
    trusted(zone()!, dragEvent("dragenter", files));
    await armed(90);
    trusted(zone()!, dragEvent("drop", files));
    await tick();
    expect(dialog()).not.toBeNull();
    // Armed, but an untrusted (synthetic) enter + drop does not count either.
    zone()!.dispatchEvent(dragEvent("dragenter", files));
    zone()!.dispatchEvent(dragEvent("drop", files));
    await tick();
    expect(dialog()).not.toBeNull();
    // A real enter after arming, then a drop: accepted.
    trusted(zone()!, dragEvent("dragenter", files));
    trusted(zone()!, dragEvent("drop", files));
    expect((await run.outcome).kind).toBe("result");
  });

  test("files outside the accept filter are dropped; maxCount 1 keeps only the first match", async () => {
    const h = harness();
    const run = h.run(request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }));
    await waitFor(zone);
    await armed();
    const pdf = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
    trusted(zone()!, dragEvent("dragenter", [pdf]));
    trusted(zone()!, dragEvent("drop", [pdf]));
    await tick();
    expect(dialog()).not.toBeNull();
    expect(zone()!.textContent).toContain("isn't accepted");
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.jpg", { type: "image/jpeg" });
    trusted(zone()!, dragEvent("dragenter", [pdf, a, b]));
    trusted(zone()!, dragEvent("drop", [pdf, a, b]));
    const outcome = await run.outcome;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.blobs!.length).toBe(1);
    expect(outcome.blobs![0]!.contentType).toBe("image/png");
  });

  test("only picker dialogs carry a drop zone", async () => {
    const h = harness();
    const sink = fakeSink(new Uint8Array([1, 2, 3]));
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    expect(zone()).toBeNull();
    run.cancel();
    await run.outcome;
  });
});

// ---------------------------------------------------------------------------
// review2-ts #10: file.save names with bidi / format characters
// ---------------------------------------------------------------------------

describe("file.save names (review2 #10)", () => {
  test("bidi overrides and other format characters never reach the dialog or the save API", async () => {
    const h = harness();
    const bytes = new TextEncoder().encode("MZ-not-a-pdf");
    const name = "invoice‮fdp.exe";
    const sink = fakeSink(bytes, { name });
    const run = h.run(request("file.save", {}), { download: sink });
    await waitFor(dialog);
    const text = dialog()!.textContent!;
    for (const ch of ["‮", "‪", "⁦", "‎", "‏", "﻿", "​"]) {
      expect(text.includes(ch)).toBe(false);
    }
    expect(text).toContain("Name: invoice_fdp");
    expect(text).toContain("Type: .exe"); // the real extension, shown on its own
    let saved: string | null = null;
    doc.addEventListener(
      "click",
      (ev) => {
        const a = ev.target as HTMLAnchorElement;
        if (a.tagName === "A") {
          saved = a.download;
          ev.preventDefault();
        }
      },
      true
    );
    await activate(button("continue")!);
    await run.outcome;
    expect(saved).toBe("invoice_fdp.exe");
  });

  test("safeFileName strips every Cf / control / separator character; describeFileName splits the extension", async () => {
    const { safeFileName, describeFileName } = await import("../packages/device-web/src/index.ts");
    expect(safeFileName("a⁧b⁩c؜d­e\u0085f g")).toBe("a_b_c_d_e_f_g");
    expect(safeFileName("..")).toBe("download");
    expect(safeFileName("‮")).toBe("_");
    expect(describeFileName("report.final.csv")).toEqual({ base: "report.final", extension: "csv" });
    expect(describeFileName(".bashrc")).toEqual({ base: ".bashrc", extension: "" });
  });
});

// ---------------------------------------------------------------------------
// D2 / D5: picks stream with a declared size; empty files upload
// ---------------------------------------------------------------------------

describe("picked files stream with their declared size (D5) and empty files upload (D2)", () => {
  test("through DeviceClient: blobStart declares File.size, an empty file sends no frame", async () => {
    const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5 });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const frames: Uint8Array[] = [];
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) });
    openConnection(host);
    const req = request("file.pick", { accept: [], maxCount: 2 });
    host.handleMessage(req);
    await waitFor(dialog);
    const big = new Uint8Array(150_000).map((_, i) => i & 0xff);
    const picked = answerFilePicker([new File([big], "big.bin", { type: "application/octet-stream" }), new File([], "empty.txt", { type: "application/x-empty" })]);
    await activate(button("continue")!);
    await picked;
    const res = await waitFor(() => sent.find((m): m is DeviceResponse => m.type === "deviceResponse" && m.id === req.id), 3000);
    const starts = sent.filter((m) => m.type === "deviceEvent" && m.id === req.id && (m.event as { kind?: string })?.kind === "blobStart").map((m) => m.event);
    expect(starts).toEqual([
      { kind: "blobStart", channel: 0, contentType: "application/octet-stream", bytes: 150_000 },
      { kind: "blobStart", channel: 1, contentType: "application/x-empty", bytes: 0 },
    ]);
    const decoded = frames.map((f) => decodeFrame(f)).filter((d) => d.ok);
    expect(decoded.every((d) => d.ok && d.payload.byteLength > 0)).toBe(true);
    expect(decoded.some((d) => d.ok && d.header.channel === 1)).toBe(false);
    expect(res.result).toEqual({
      items: [
        { channel: 0, name: "big.bin", contentType: "application/octet-stream", bytes: 150_000, sha256: await sha256Hex(big) },
        { channel: 1, name: "empty.txt", contentType: "application/x-empty", bytes: 0, sha256: await sha256Hex(new Uint8Array(0)) },
      ],
    });
    host.detach();
  });

  test("the host refuses requests before the sessionAck and app work before the core stream", async () => {
    const host = new WebDeviceHost({ origin: "ws://app.test:8080", mount: doc.body, inputProtectionMs: 5 });
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    let closed: string | null = null;
    host.attach({ sendMessage: (m) => sent.push(m), sendBinary: () => {}, close: (_c, reason) => (closed = reason) });
    host.handleMessage(request("permission.query", { permission: "camera" }));
    await tick();
    expect(sent.map((m) => (m as DeviceResponse).error?.code)).toEqual(["unsupported"]);
    host.onAck(FULL_ACK);
    host.handleMessage(request("permission.query", { permission: "camera" }));
    await tick();
    expect(closed).toBe("app request before core.capabilities opened");
    expect(dialog()).toBeNull();
  });
});
