/**
 * Device Capability Protocol — Phase 4 real-browser validation (RFC 001 §6).
 *
 * A REAL Chromium (Playwright, executablePath from the preinstalled browsers)
 * loads a page running RemoteEngine + WebDeviceHost against a REAL
 * RemoteServer with the device plane enabled. The server-side handler asks
 * for gallery.pick; the test clicks the host's own Continue control with a
 * trusted click, which opens the real `<input type=file>` picker inside that
 * activation window; Playwright supplies the file; the bytes round-trip over
 * binary WebSocket frames and are hash-verified server-side.
 *
 * No mock activation, no fake echo (RFC 001 §6 Phase 4 exit criteria).
 *
 * Input protection (review2-ts #6): keystrokes typed into the app and
 * clicks aimed where Continue appears never activate it — Continue is not
 * focused on open, is disabled for the protection window, and needs a fresh
 * activation that starts on it. Proven with real keyboard/mouse input.
 *
 * Round 3 (real devices through Chromium's fake capture devices,
 * `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream`):
 * camera.capture photo (JPEG from the live preview) and a short video
 * (MediaRecorder webm streamed undeclared), mic.record for a few hundred ms
 * (AudioWorklet → PCM16 at the requested rate) delivered to the server's
 * `onData` in order — all hash-verified server-side by the broker — and
 * bluetooth.select through the real Web Bluetooth chooser, driven by CDP
 * `BluetoothEmulation` (a simulated peripheral) + `DeviceAccess` (the
 * chooser prompt).
 *
 * Skipped when Chromium is not available.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import { app } from "@hypen-space/core";
import { RemoteServer } from "../packages/server/src/remote/server";
import { sha256Hex, type DeviceResult } from "@hypen-space/core/remote/device";

const CHROMIUM = process.env.HYPEN_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const haveChromium = existsSync(CHROMIUM);
if (process.env.HYPEN_BROWSER_REQUIRE === "1" && !haveChromium) {
  throw new Error(`Required browser not found: ${CHROMIUM}. Set HYPEN_CHROMIUM_PATH.`);
}

type PickResult = DeviceResult<{ items: Array<{ contentType: string; bytes: Uint8Array }> }>;

let chromium: typeof import("playwright-core").chromium;
let browser: import("playwright-core").Browser;
let server: RemoteServer;
let pageServer: ReturnType<typeof Bun.serve>;
let wsPort: number;
let pagePort: number;
const results: PickResult[] = [];
/** A "typing" action's device request is in flight (one at a time). */
let typingInFlight = false;
let notifyResult: (() => void) | null = null;

/** Round-3 handler outcomes by action name, in arrival order. */
const outcomes = new Map<string, unknown[]>();
const outcomeWaiters = new Map<string, () => void>();
function recordOutcome(action: string, value: unknown): void {
  const list = outcomes.get(action) ?? [];
  list.push(value);
  outcomes.set(action, list);
  outcomeWaiters.get(action)?.();
}
function nextOutcome<T>(action: string): Promise<T> {
  const n = outcomes.get(action)?.length ?? 0;
  return new Promise<T>((res) => {
    const check = () => {
      const list = outcomes.get(action) ?? [];
      if (list.length > n) {
        outcomeWaiters.delete(action);
        res(list[n] as T);
      } else outcomeWaiters.set(action, check);
    };
    check();
  });
}

interface MicOutcome {
  result: DeviceResult<{ durationMs: number; item: { channel: number; contentType: string; bytes: number; sha256: string } }>;
  delivered: Uint8Array;
  chunks: number;
}

const concatBytes = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

const nextResult = () =>
  new Promise<PickResult>((res) => {
    const n = results.length;
    const check = () => {
      if (results.length > n) res(results[n]!);
      else notifyResult = check;
    };
    check();
  });

beforeAll(async () => {
  if (!haveChromium) return;
  ({ chromium } = await import("playwright-core"));
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Real capture pipelines against Chromium's fake camera/microphone,
      // with the browser permission prompt auto-accepted (the HOST's own
      // dialogs are still driven by real clicks).
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Web Bluetooth is behind a flag on Linux.
      "--enable-features=WebBluetooth",
    ],
  });

  wsPort = 44100 + Math.floor(Math.random() * 400);
  pagePort = wsPort + 1;
  const pageOrigin = `http://127.0.0.1:${pagePort}`;

  const module = app
    .defineState({ picks: 0 })
    .onAction("pick", async ({ state, context }) => {
      const res = (await context.device.request("gallery.pick", {
        mediaTypes: ["photo"],
        maxCount: 1,
      })) as PickResult;
      state.picks += 1;
      results.push(res);
      notifyResult?.();
      notifyResult = null;
    })
    // A hostile app: every chat keystroke / game click is an action, and it
    // asks for gallery.pick in the middle of the user's typing/clicking.
    .onAction("typing", async ({ context }) => {
      if (typingInFlight) return;
      typingInFlight = true;
      try {
        await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
      } finally {
        typingInFlight = false;
      }
    })
    .onAction("filePick", async ({ state, context }) => {
      const res = (await context.device.request("file.pick", {
        accept: ["text/plain", ".txt"],
        maxCount: 2,
      })) as PickResult;
      state.picks += 1;
      results.push(res);
      notifyResult?.();
      notifyResult = null;
    })
    // ---- round 3: camera.capture / mic.record / bluetooth.select ----
    .onAction("photo", async ({ context }) => {
      recordOutcome("photo", await context.device.camera.capture({ mode: "photo", facing: "front" }));
    })
    .onAction("video", async ({ context }) => {
      recordOutcome("video", await context.device.request("camera.capture", { mode: "video", maxDurationMs: 5000 }));
    })
    .onAction("record", async ({ context }) => {
      const parts: Uint8Array[] = [];
      const handle = context.device.mic.record(
        { format: "pcm16", sampleRate: 16_000, channels: 1, maxDurationMs: 400 },
        (chunk) => {
          parts.push(chunk.slice());
        }
      );
      const result = await handle.settled;
      recordOutcome("record", { result, delivered: concatBytes(parts), chunks: parts.length } satisfies MicOutcome);
    })
    .onAction("recordStereo", async ({ context }) => {
      const parts: Uint8Array[] = [];
      const handle = context.device.stream(
        "mic.record",
        { format: "pcm16", sampleRate: 48_000, channels: 2 },
        { timeoutMs: 60_000 },
        { onData: (chunk) => void parts.push(chunk.slice()) }
      );
      const result = await handle.settled;
      recordOutcome("recordStereo", { result, delivered: concatBytes(parts), chunks: parts.length } satisfies MicOutcome);
    })
    .onAction("btSelect", async ({ context }) => {
      recordOutcome(
        "btSelect",
        await context.device.bluetooth.select({ services: ["0000180d-0000-1000-8000-00805f9b34fb"] })
      );
    })
    .onAction("permissions", async ({ context }) => {
      const query = await context.device.request("permission.query", { permission: "camera" });
      const photos = await context.device.request("permission.query", { permission: "photos" });
      const contacts = await context.device.request("permission.query", { permission: "contacts" });
      recordOutcome("permissions", { query, photos, contacts });
    })
    .build();

  server = new RemoteServer()
    .module("App", module)
    .ui('Column { Button("@actions.pick") { Text("Renderer pick") } Text("Picks: @{state.picks}") }')
    .config({ allowedOrigins: [pageOrigin], webClient: false });
  await server.listen(wsPort);

  // Bundle the browser entry (RemoteEngine + WebDeviceHost) for the page.
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/device-browser-entry.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const bundle = await build.outputs[0]!.text();

  pageServer = Bun.serve({
    port: pagePort,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/app.js") {
        return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>device</title>
         <button id="pick">Change photo</button>
         <button id="filepick">Attach file</button>
         <input id="chat" placeholder="chat">
         <button id="game" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;height:140px">CLICK FAST!</button>
         <button id="photo" data-action="photo">Take photo</button>
         <button id="video" data-action="video">Record video</button>
         <button id="record" data-action="record">Voice note</button>
         <button id="recordStereo" data-action="recordStereo">Stereo note</button>
         <button id="bt" data-action="btSelect">Pair sensor</button>
         <button id="perms" data-action="permissions">Permissions</button>
         <div id="renderer" style="position:absolute;top:200px;left:0;width:400px;height:180px"></div>
         <script type="module" src="/app.js"></script>`,
        { headers: { "content-type": "text/html" } }
      );
    },
  });
  // Launching Chromium and bundling can take well over the 5 s default
  // under full-suite load (the review2 flake).
}, 60_000);

afterAll(async () => {
  typingInFlight = false;
  await browser?.close();
  server?.stop();
  pageServer?.stop(true);
});

describe.skipIf(!haveChromium)("real Chromium: gallery.pick through the host-owned consent control", () => {
  for (const renderer of ["dom", "canvas"] as const) {
    test(`${renderer}: rendered action opens picker and verified upload updates rendered state`, async () => {
      const page = await browser.newPage();
      try {
        const wsUrl = `ws://127.0.0.1:${wsPort}`;
        await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}&renderer=${renderer}`);
        await page.waitForFunction(() => window.__hypen?.connected === true);
        const pending = nextResult();
        if (renderer === "dom") {
          await page.locator("#renderer").getByText("Renderer pick").click();
        } else {
          // The first native Canvas button occupies the top row.
          await page.locator("#renderer canvas").click({ position: { x: 40, y: 15 } });
        }
        await page.waitForSelector("[data-hypen-device-dialog]");
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          page.click('[data-hypen-device="continue"]'),
        ]);
        const bytes = Buffer.from("renderer-device-roundtrip".repeat(4000));
        await chooser.setFiles({ name: "renderer.jpg", mimeType: "image/jpeg", buffer: bytes });
        const result = await pending;
        expect(result.ok).toBe(true);
        if (result.ok) expect(await sha256Hex(result.value.items[0]!.bytes)).toBe(await sha256Hex(bytes));
        await page.waitForFunction(() => window.__hypen.renderedTexts?.includes("Picks: 1"));
        if (renderer === "dom") await page.locator("#renderer").getByText("Picks: 1").waitFor();
      } finally {
        await page.close();
      }
    }, 20_000);
  }
  test("host Continue opens the real file picker; bytes round-trip and verify", async () => {
    const page = await browser.newPage();
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => window.__hypen?.connected === true, null, { timeout: 10_000 });

    // The negotiated selection reached the browser.
    const selected = await page.evaluate(() => window.__hypen.host.selected);
    expect(selected?.capabilities.map((c: { name: string }) => c.name)).toContain("gallery.pick");

    const photo = new TextEncoder().encode("real-browser-photo-bytes-".repeat(3000)); // ~75 KiB → 2 frames
    const expectedHash = await sha256Hex(photo);

    // App button → action → server handler → deviceRequest → host dialog.
    const pending = nextResult();
    await page.click("#pick");
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    const dialogText = await page.textContent("[data-hypen-device-dialog]");
    expect(dialogText).toContain(`ws://127.0.0.1:${wsPort}`);
    expect(dialogText).toContain("choose a photo");

    // Trusted click on the HOST's Continue opens the real picker in that
    // activation window; Playwright intercepts the chooser and supplies a file.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.click('[data-hypen-device="continue"]'),
    ]);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo) });

    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.value.items[0]!;
    expect(item.contentType).toBe("image/jpeg");
    expect(item.bytes.byteLength).toBe(photo.byteLength);
    expect(await sha256Hex(item.bytes)).toBe(expectedHash);

    // The host interaction is gone once the operation settled.
    expect(await page.$("[data-hypen-device-dialog]")).toBeNull();
    await page.close();
  });

  test("file.pick: host Continue opens the real multi-file picker; every file's bytes verify", async () => {
    const page = await browser.newPage();
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => window.__hypen?.connected === true, null, { timeout: 10_000 });
    const selected = await page.evaluate(() => window.__hypen.host.selected);
    expect(selected?.capabilities.map((c: { name: string }) => c.name)).toContain("file.pick");

    const notes = new TextEncoder().encode("meeting notes\n".repeat(6000)); // ~84 KiB → 2 frames
    const todo = new TextEncoder().encode("- ship file.pick\n");
    const pending = nextResult();
    await page.click("#filepick");
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    expect(await page.textContent("[data-hypen-device-dialog]")).toContain("choose a file");

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.click('[data-hypen-device="continue"]'),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    const accept = await chooser.element().getAttribute("accept");
    expect(accept).toBe("text/plain,.txt");
    await chooser.setFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(notes) },
      { name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from(todo) },
    ]);

    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.length).toBe(2);
    const [a, b] = res.value.items;
    expect(a!.contentType).toBe("text/plain");
    expect(await sha256Hex(a!.bytes)).toBe(await sha256Hex(notes));
    expect(await sha256Hex(b!.bytes)).toBe(await sha256Hex(todo));
    expect(await page.$("[data-hypen-device-dialog]")).toBeNull();
    await page.close();
  });

  test("host Cancel is a denial; an immediate retry is throttled by cooldown", async () => {
    const page = await browser.newPage();
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => window.__hypen?.connected === true, null, { timeout: 10_000 });

    const denied = nextResult();
    await page.click("#pick");
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    await page.click('[data-hypen-device="cancel"]');
    const first = await denied;
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("denied");

    const throttled = nextResult();
    await page.click("#pick");
    const second = await throttled;
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("throttled");
    // No dialog was shown for the throttled request.
    expect(await page.$("[data-hypen-device-dialog]")).toBeNull();
    await page.close();
  });
});

describe.skipIf(!haveChromium)("real Chromium: host dialog input protection (review2 #6)", () => {
  async function open() {
    const page = await browser.newPage();
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => window.__hypen?.connected === true, null, { timeout: 10_000 });
    let chooser = false;
    page.on("filechooser", () => {
      chooser = true;
    });
    return { page, opened: () => chooser };
  }

  test("keystrokes typed into the app never reach the host's Continue (keyjacking)", async () => {
    const { page, opened } = await open();
    await page.focus("#chat");
    await page.keyboard.type("hello", { delay: 30 }); // the first keystroke makes the server ask
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-hypen-device") ?? document.activeElement?.tagName);
    expect(focused).not.toBe("continue");
    // The user keeps typing: spaces and Enters must not activate Continue.
    await page.keyboard.type(" world ", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.waitForTimeout(800); // well past the protection window
    await page.keyboard.type(" more ", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(opened()).toBe(false);
    expect(await page.$("[data-hypen-device-dialog]")).not.toBeNull();
    await page.close();
  }, 30_000);

  test("a click landing on Continue as it appears is ignored; a deliberate click later works", async () => {
    const { page, opened } = await open();
    const box = (await (await page.$("#game"))!.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    const c = (await (await page.$('[data-hypen-device="continue"]'))!.boundingBox())!;
    // Rapid clicks where Continue now is, right after it rendered.
    for (let i = 0; i < 3; i++) await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    await page.waitForTimeout(100);
    expect(opened()).toBe(false);
    expect(await page.$("[data-hypen-device-dialog]")).not.toBeNull();
    // After the protection window, a deliberate click opens the real picker.
    await page.waitForTimeout(600);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.click('[data-hypen-device="continue"]'),
    ]);
    expect(chooser).toBeTruthy();
    await page.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Round 3: real capture devices (Chromium fake camera/microphone) and the
// real Web Bluetooth chooser (CDP BluetoothEmulation + DeviceAccess)
// ---------------------------------------------------------------------------

type CaptureResult = DeviceResult<{ items: Array<{ channel: number; contentType: string; bytes: Uint8Array }> }>;

async function openPage(query = "") {
  const page = await browser.newPage();
  // Count which capture path the host's audio graph takes.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__audioPaths = { worklet: 0, scriptProcessor: 0 };
    const paths = w.__audioPaths as { worklet: number; scriptProcessor: number };
    const Node = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Node {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        paths.worklet += 1;
      }
    };
    const create = BaseAudioContext.prototype.createScriptProcessor;
    BaseAudioContext.prototype.createScriptProcessor = function (...args: Parameters<typeof create>) {
      paths.scriptProcessor += 1;
      return create.apply(this, args);
    };
  });
  const wsUrl = `ws://127.0.0.1:${wsPort}`;
  await page.goto(`http://127.0.0.1:${pagePort}/?ws=${encodeURIComponent(wsUrl)}${query}`);
  await page.waitForFunction(() => window.__hypen?.connected === true, null, { timeout: 10_000 });
  return page;
}

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

describe.skipIf(!haveChromium)("real Chromium: round-3 capture drivers end to end", () => {
  test("camera.capture photo: host capture dialog with live preview → Capture → JPEG verified server-side", async () => {
    const page = await openPage();
    const selected = await page.evaluate(() => window.__hypen.host.selected);
    const names = selected?.capabilities.map((c: { name: string }) => c.name) ?? [];
    for (const n of ["camera.capture", "mic.record", "bluetooth.select"]) expect(names).toContain(n);

    const pending = nextOutcome<CaptureResult>("photo");
    await page.click("#photo");
    await page.waitForSelector("[data-hypen-device-capture]", { timeout: 10_000 });
    expect(await page.textContent("[data-hypen-device-capture]")).toContain(`ws://127.0.0.1:${wsPort}`);
    // The live preview is running (the fake camera paints frames).
    await page.waitForFunction(
      () => (document.querySelector('[data-hypen-device="preview"]') as HTMLVideoElement | null)?.videoWidth! > 0,
      null,
      { timeout: 10_000 }
    );
    // Playwright's click waits until Capture is armed (enabled), then is a
    // real trusted click that started on it.
    await page.click('[data-hypen-device="capture"]');
    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.value.items[0]!;
    expect(res.value.items.length).toBe(1);
    expect(item.contentType).toBe("image/jpeg");
    expect(item.bytes.byteLength).toBeGreaterThan(1000);
    expect(startsWith(item.bytes, [0xff, 0xd8, 0xff])).toBe(true); // SOI
    expect(item.bytes[item.bytes.byteLength - 2]).toBe(0xff); // EOI
    expect(item.bytes[item.bytes.byteLength - 1]).toBe(0xd9);
    await page.waitForSelector("[data-hypen-device-capture]", { state: "detached", timeout: 5_000 });
    await page.close();
  }, 30_000);

  test("camera.capture video: Record → Stop streams MediaRecorder webm, undeclared, verified server-side", async () => {
    const page = await openPage();
    const pending = nextOutcome<CaptureResult>("video");
    await page.click("#video");
    await page.waitForSelector('[data-hypen-device="record"]', { timeout: 10_000 });
    await page.click('[data-hypen-device="record"]');
    await page.waitForSelector('[data-hypen-device="stop"]', { timeout: 5_000 });
    await page.waitForTimeout(900); // a short clip
    await page.click('[data-hypen-device="stop"]');
    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.value.items[0]!;
    expect(item.contentType).toBe("video/webm");
    expect(item.bytes.byteLength).toBeGreaterThan(1000);
    expect(startsWith(item.bytes, [0x1a, 0x45, 0xdf, 0xa3])).toBe(true); // EBML header
    await page.waitForSelector("[data-hypen-device-capture]", { state: "detached", timeout: 5_000 });
    await page.close();
  }, 30_000);

  test("mic.record: consent → AudioWorklet PCM16 @16 kHz for 400 ms, streamed to onData, hash-verified", async () => {
    const page = await openPage();
    const pending = nextOutcome<MicOutcome>("record");
    await page.click("#record");
    await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
    expect(await page.textContent("[data-hypen-device-dialog]")).toContain("record audio");
    await page.click('[data-hypen-device="continue"]');
    // The always-visible indicator names the origin while recording.
    await page.waitForSelector("[data-hypen-device-indicator]", { timeout: 10_000 });
    expect(await page.textContent("[data-hypen-device-indicator]")).toContain(`ws://127.0.0.1:${wsPort}`);
    const out = await pending;
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    const { durationMs, item } = out.result.value;
    expect(durationMs).toBe(400);
    expect(item.contentType).toBe("audio/L16");
    expect(item.bytes).toBe(400 * 16 * 2); // exactly maxDurationMs of 16 kHz mono PCM16
    expect(out.delivered.byteLength).toBe(item.bytes);
    expect(await sha256Hex(out.delivered)).toBe(item.sha256);
    expect(out.chunks).toBeGreaterThan(1); // frames left as captured, not at the end
    expect(await page.evaluate(() => (window as unknown as { __audioPaths: unknown }).__audioPaths)).toEqual({
      worklet: 1,
      scriptProcessor: 0,
    });
    await page.waitForSelector("[data-hypen-device-indicator]", { state: "detached", timeout: 5_000 });
    await page.close();
  }, 30_000);

  test("mic.record through the ScriptProcessor fallback (no AudioWorklet) yields the same exact-length PCM16", async () => {
    const page = await openPage("&audio=scriptprocessor");
    const pending = nextOutcome<MicOutcome>("record");
    await page.click("#record");
    await page.click('[data-hypen-device="continue"]');
    const out = await pending;
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    expect(out.result.value.durationMs).toBe(400);
    expect(out.result.value.item.bytes).toBe(400 * 16 * 2);
    expect(await sha256Hex(out.delivered)).toBe(out.result.value.item.sha256);
    expect(await page.evaluate(() => (window as unknown as { __audioPaths: unknown }).__audioPaths)).toEqual({
      worklet: 0,
      scriptProcessor: 1,
    });
    await page.close();
  }, 30_000);

  test("mic.record stereo @48 kHz: the indicator's Stop ends it normally with what was captured", async () => {
    const page = await openPage();
    const pending = nextOutcome<MicOutcome>("recordStereo");
    await page.click("#recordStereo");
    await page.click('[data-hypen-device="continue"]');
    await page.waitForSelector('[data-hypen-device="stop-recording"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.click('[data-hypen-device="stop-recording"]');
    const out = await pending;
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    const { durationMs, item } = out.result.value;
    expect(item.bytes % 4).toBe(0); // whole interleaved L/R frames
    expect(item.bytes).toBeGreaterThan(48_000 * 4 * 0.2);
    expect(Math.abs(durationMs - Math.round((item.bytes / 4 / 48_000) * 1000))).toBeLessThanOrEqual(1);
    expect(await sha256Hex(out.delivered)).toBe(item.sha256);
    await page.waitForSelector("[data-hypen-device-indicator]", { state: "detached", timeout: 5_000 });
    await page.close();
  }, 30_000);

  test("permission.query: the closed enum on a real browser (camera granted by the fake UI, photos granted, contacts unsupported)", async () => {
    const page = await openPage();
    const pending = nextOutcome<{
      query: DeviceResult<{ status: string }>;
      photos: DeviceResult<{ status: string }>;
      contacts: DeviceResult<unknown>;
    }>("permissions");
    await page.click("#perms");
    const out = await pending;
    expect(out.query).toEqual({ ok: true, value: { status: "granted" } });
    expect(out.photos).toEqual({ ok: true, value: { status: "granted" } });
    expect(out.contacts).toEqual({ ok: false, error: { code: "unsupported", platformDetail: "contacts" } });
    await page.close();
  }, 30_000);

  test("bluetooth.select: consent → real Web Bluetooth chooser (CDP BluetoothEmulation) → device identity", async () => {
    const browserSession = await browser.newBrowserCDPSession();
    await browserSession.send("BluetoothEmulation.enable" as never, { state: "powered-on", leSupported: true } as never);
    await browserSession.send(
      "BluetoothEmulation.simulatePreconnectedPeripheral" as never,
      {
        address: "09:09:09:09:09:09",
        name: "Heart Rate",
        manufacturerData: [],
        knownServiceUuids: ["0000180d-0000-1000-8000-00805f9b34fb"],
      } as never
    );
    try {
      const page = await openPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DeviceAccess.enable" as never);
      const prompts: string[] = [];
      cdp.on("DeviceAccess.deviceRequestPrompted" as never, (ev: { id: string; devices: Array<{ id: string }> }) => {
        if (prompts.includes(ev.id) || ev.devices.length === 0) return;
        prompts.push(ev.id);
        void cdp.send("DeviceAccess.selectPrompt" as never, { id: ev.id, deviceId: ev.devices[0]!.id } as never);
      });
      const pending = nextOutcome<DeviceResult<{ device: { id: string; name?: string } }>>("btSelect");
      await page.click("#bt");
      await page.waitForSelector("[data-hypen-device-dialog]", { timeout: 10_000 });
      expect(await page.textContent("[data-hypen-device-dialog]")).toContain("Bluetooth");
      expect(prompts.length).toBe(0); // no chooser before the host Continue
      await page.click('[data-hypen-device="continue"]');
      const res = await pending;
      expect(prompts.length).toBe(1);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.device.name).toBe("Heart Rate");
      expect(res.value.device.id.length).toBeGreaterThan(0);
      expect(Object.keys(res.value)).toEqual(["device"]); // identity only
      await page.close();
    } finally {
      await browserSession.send("BluetoothEmulation.disable" as never).catch(() => undefined);
      await browserSession.detach().catch(() => undefined);
    }
  }, 30_000);
});
