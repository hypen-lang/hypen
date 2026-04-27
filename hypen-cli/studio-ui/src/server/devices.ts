/**
 * Studio device-control server module.
 *
 * Exposes a unified surface for the Test Mode UI:
 *   - Android: shells out to `adb` (list, screencap, input)
 *   - iOS:     proxies to a separately-spawned @hypen-space/ios-streamer
 *              (HYPEN_IOS_STREAMER_URL set by the CLI on darwin)
 *
 * Both adapters are non-fatal — if the underlying tool isn't installed the
 * studio just shows an empty list for that platform.
 */

import { existsSync } from "fs";

export interface StudioDevice {
  id: string;
  platform: "android" | "ios";
  name: string;
  status: "running" | "stopped" | "unknown";
  /** MJPEG fallback stream URL, null if streaming unavailable. */
  streamUrl: string | null;
  /** Optional fragmented-MP4 (H.264) stream URL — preferred when present. */
  videoUrl?: string | null;
  /** Optional WebRTC gRPC endpoint (Android emulator with -grpc <port>). */
  webrtcUrl?: string | null;
  /** Extra subtitle shown in the sidebar (runtime, model, …). */
  subtitle?: string;
}

const IOS_STREAMER_URL = (process.env.HYPEN_IOS_STREAMER_URL ?? "").replace(/\/$/, "");

// ─── Shell helper (Bun.spawn) ─────────────────────────────

async function exec(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (err: any) {
    return { stdout: "", stderr: err?.message ?? String(err), exitCode: 127 };
  }
}

async function execBytes(cmd: string[]): Promise<{ stdout: Uint8Array; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [buf, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    return { stdout: new Uint8Array(buf), exitCode };
  } catch {
    return { stdout: new Uint8Array(0), exitCode: 127 };
  }
}

// ─── Android (adb + emulator) ─────────────────────────────

/** Cache of the AVD name for each booted emulator (keyed by adb id). */
const avdNameCache = new Map<string, string>();

/** Track AVDs we cold-booted so we can kill the right process on shutdown
 *  AND surface the gRPC port we launched them with (used for WebRTC mirror). */
type BootedProc = { proc: ReturnType<typeof Bun.spawn>; grpcPort: number };
const bootedProcs = new Map<string, BootedProc>();
const GRPC_PORT_BASE = 8554;
function nextGrpcPort(): number {
  const used = new Set(Array.from(bootedProcs.values()).map((b) => b.grpcPort));
  let p = GRPC_PORT_BASE;
  while (used.has(p)) p++;
  return p;
}

async function avdNameFor(adbId: string): Promise<string | null> {
  if (!adbId.startsWith("emulator-")) return null;
  const cached = avdNameCache.get(adbId);
  if (cached) return cached;
  const { stdout, exitCode } = await exec(["adb", "-s", adbId, "emu", "avd", "name"]);
  if (exitCode !== 0) return null;
  // `adb emu avd name` returns "<name>\nOK\n"; we want the first line.
  const name = stdout.split("\n")[0]?.trim() ?? null;
  if (name) avdNameCache.set(adbId, name);
  return name;
}

/**
 * Locate the `emulator` binary. Android Studio installs it under
 * `$ANDROID_HOME/emulator/emulator` but doesn't symlink it into shell PATH,
 * so users who have `adb` (Homebrew) often don't have `emulator`. We try
 * the bare name first, then fall back to common SDK install locations.
 *
 * Resolved once per process and cached — if it's not there at startup it
 * won't suddenly appear at runtime.
 */
let emulatorPathCache: string | null | undefined;

async function resolveEmulatorPath(): Promise<string | null> {
  if (emulatorPathCache !== undefined) return emulatorPathCache;

  // 1. bare name via PATH
  const { exitCode } = await exec(["emulator", "-help"]);
  if (exitCode === 0) {
    emulatorPathCache = "emulator";
    return emulatorPathCache;
  }

  // 2. well-known SDK locations
  const candidates: string[] = [];
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (androidHome) candidates.push(`${androidHome}/emulator/emulator`);
  const home = process.env.HOME;
  if (home) {
    // macOS default when Android Studio installs the SDK fresh.
    candidates.push(`${home}/Library/Android/sdk/emulator/emulator`);
    // Common Linux default.
    candidates.push(`${home}/Android/Sdk/emulator/emulator`);
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      emulatorPathCache = path;
      return emulatorPathCache;
    }
  }

  console.warn(
    "[devices] `emulator` not found on PATH or in $ANDROID_HOME/emulator — " +
      "cold AVDs won't appear in the sidebar. Add Android SDK's emulator dir " +
      "to PATH or set ANDROID_HOME to fix."
  );
  emulatorPathCache = null;
  return null;
}

export async function listAndroidAVDs(): Promise<string[]> {
  const emulator = await resolveEmulatorPath();
  if (!emulator) return [];
  const { stdout, exitCode } = await exec([emulator, "-list-avds"]);
  if (exitCode !== 0) return [];
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("INFO"));
}

export async function listAndroidDevices(): Promise<StudioDevice[]> {
  const { stdout, exitCode } = await exec(["adb", "devices", "-l"]);

  const out: StudioDevice[] = [];
  const seenAvds = new Set<string>();

  if (exitCode === 0) {
    const lines = stdout.trim().split("\n").slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const id = parts[0];
      const status = parts[1];
      if (!id) continue;

      const modelMatch = trimmed.match(/model:(\S+)/);
      const isEmulator = id.startsWith("emulator-") || id.includes("localhost:");
      let displayName = (modelMatch?.[1] ?? id).replace(/_/g, " ");

      let webrtcUrl: string | null = null;
      if (isEmulator && status === "device") {
        const avd = await avdNameFor(id);
        if (avd) {
          seenAvds.add(avd);
          displayName = avd.replace(/_/g, " ");
          const port = grpcPortForAvd(avd);
          if (port != null) webrtcUrl = `http://localhost:${port}`;
        }
      }

      out.push({
        id,
        platform: "android",
        name: displayName,
        status: status === "device" ? "running" : "stopped",
        streamUrl: status === "device"
          ? `/api/devices/android/${encodeURIComponent(id)}/stream.mjpeg`
          : null,
        webrtcUrl,
        subtitle: isEmulator ? "Emulator" : "Physical",
      });
    }
  }

  // Merge in cold AVDs not currently booted.
  const avds = await listAndroidAVDs();
  for (const avd of avds) {
    if (seenAvds.has(avd)) continue;
    out.push({
      id: `avd:${avd}`,
      platform: "android",
      name: avd.replace(/_/g, " "),
      status: "stopped",
      streamUrl: null,
      subtitle: "AVD",
    });
  }

  return out;
}

/**
 * Cold-boot an AVD by name. Spawns the `emulator` binary and stores the handle
 * so a later shutdown call can kill it. The `-grpc <port>` flag exposes the
 * emulator's gRPC endpoint, which `android-emulator-webrtc` consumes for the
 * live WebRTC mirror.
 *
 * Returns the grpcPort that was assigned so callers can build a WebRTC URL.
 */
export async function bootAndroidAVD(avdName: string): Promise<{ grpcPort: number }> {
  const existing = bootedProcs.get(avdName);
  if (existing) return { grpcPort: existing.grpcPort };

  const emulator = await resolveEmulatorPath();
  if (!emulator) {
    throw new Error("`emulator` binary not found. Add Android SDK's emulator/ dir to PATH or set ANDROID_HOME.");
  }

  const grpcPort = nextGrpcPort();
  try {
    const proc = Bun.spawn(
      [emulator, "-avd", avdName, "-grpc", String(grpcPort), "-no-snapshot-save"],
      { stdout: "ignore", stderr: "ignore" }
    );
    bootedProcs.set(avdName, { proc, grpcPort });
    proc.exited.then(() => bootedProcs.delete(avdName));
    return { grpcPort };
  } catch (e: any) {
    throw new Error(`emulator launch failed: ${e?.message ?? e}`);
  }
}

export async function shutdownAndroidDevice(id: string): Promise<void> {
  // Cold AVD entries use the synthetic id "avd:<name>" — kill the spawned proc.
  if (id.startsWith("avd:")) {
    const name = id.slice("avd:".length);
    const entry = bootedProcs.get(name);
    if (entry && !entry.proc.killed) {
      try { entry.proc.kill(); } catch { /* already dead */ }
    }
    bootedProcs.delete(name);
    return;
  }

  // Booted devices: prefer `adb emu kill`, fall back to killing our spawned proc
  // when the AVD name is known.
  const { exitCode, stderr } = await exec(["adb", "-s", id, "emu", "kill"]);
  if (exitCode !== 0) {
    const avd = avdNameCache.get(id);
    if (avd) {
      const entry = bootedProcs.get(avd);
      if (entry && !entry.proc.killed) { try { entry.proc.kill(); } catch {} }
      bootedProcs.delete(avd);
      return;
    }
    throw new Error(`adb emu kill failed: ${stderr.trim()}`);
  }
  avdNameCache.delete(id);
}

/** Look up the gRPC port for a booted AVD, if studio launched it. */
export function grpcPortForAvd(avdName: string): number | null {
  return bootedProcs.get(avdName)?.grpcPort ?? null;
}

/** Single PNG screenshot via `adb exec-out screencap -p`. */
export async function androidScreenshot(id: string): Promise<Uint8Array> {
  const { stdout, exitCode } = await execBytes(["adb", "-s", id, "exec-out", "screencap", "-p"]);
  if (exitCode !== 0) throw new Error("adb screencap failed");
  return stdout;
}

/** Build a multipart MJPEG ReadableStream by polling screencap. */
export function androidMjpegStream(id: string, fps: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const intervalMs = Math.max(33, Math.floor(1000 / Math.max(1, Math.min(30, fps))));
  let cancelled = false;
  let consecutiveErrors = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => { cancelled = true; };
      signal.addEventListener("abort", onAbort, { once: true });
      const encoder = new TextEncoder();

      while (!cancelled) {
        const t0 = Date.now();
        try {
          const png = await androidScreenshot(id);
          consecutiveErrors = 0;
          // Note: PNG over MJPEG works in browsers despite the format mismatch — we
          // just need a fresh image per part. JPEG would be smaller; for v1 PNG is fine.
          const header = encoder.encode(
            `--studioframe\r\nContent-Type: image/png\r\nContent-Length: ${png.byteLength}\r\n\r\n`
          );
          controller.enqueue(header);
          controller.enqueue(png);
          controller.enqueue(encoder.encode("\r\n"));
        } catch {
          if (++consecutiveErrors >= 3) break;
        }
        const wait = intervalMs - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { cancelled = true; },
  });
}

// Persistent `adb -s <id> shell` sessions keyed by device id. Spawning a
// fresh `adb shell input tap` per click incurs ~100-500ms of adb handshake
// on top of the `input` command's JVM startup — stacked, that's the 1-2s
// click-to-action lag users reported. By keeping one shell open per device
// and piping `input tap X Y\n` into its stdin, the adb overhead is paid
// once at boot; each tap then only pays the on-device `input` cost.
type AdbShell = { proc: ReturnType<typeof Bun.spawn>; stdin: any };
const adbShells = new Map<string, AdbShell>();

function getAdbShell(id: string): AdbShell {
  const existing = adbShells.get(id);
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
    return existing;
  }
  const proc = Bun.spawn(["adb", "-s", id, "shell"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // `stdin: "pipe"` produces a FileSink, but Bun's TS signature widens to
  // `number | FileSink | undefined`. Narrow via any — this is the same approach
  // taken for LSP/terminal stdin in index.tsx.
  const shell: AdbShell = { proc, stdin: proc.stdin as any };
  // Evict from the cache when the process dies so the next call respawns.
  proc.exited.then(() => {
    const current = adbShells.get(id);
    if (current === shell) adbShells.delete(id);
  });
  adbShells.set(id, shell);
  return shell;
}

const cleanupAdbShells = () => {
  for (const shell of adbShells.values()) {
    try { shell.proc.kill(); } catch { /* already dead */ }
  }
  adbShells.clear();
};
// Only the `exit` hook fires on normal shutdown. For SIGINT/SIGTERM we
// explicitly exit — just attaching a handler without calling process.exit
// tells Node/Bun the signal has been handled, which suppresses the default
// "terminate" behaviour and strands the process.
process.on("exit", cleanupAdbShells);
process.on("SIGINT", () => { cleanupAdbShells(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAdbShells(); process.exit(143); });

function buildInputCommand(action: { type: string; [k: string]: any }): string {
  switch (action.type) {
    case "tap":
      return `input tap ${Math.round(action.x)} ${Math.round(action.y)}`;
    case "swipe":
      return `input swipe ${Math.round(action.x1)} ${Math.round(action.y1)} ${Math.round(action.x2)} ${Math.round(action.y2)} ${action.durationMs ?? 200}`;
    case "text":
      // `input text` treats spaces literally as separators — the `%s` substitution
      // is Android's documented workaround. Single-quote the rest to keep shell
      // metacharacters from re-expanding inside the persistent shell session.
      return `input text '${String(action.text).replace(/'/g, "'\\''").replace(/ /g, "%s")}'`;
    case "key":
      return `input keyevent ${action.keycode ?? "KEYCODE_HOME"}`;
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

export async function androidInput(id: string, action: { type: string; [k: string]: any }): Promise<void> {
  const line = buildInputCommand(action) + "\n";
  const shell = getAdbShell(id);
  try {
    shell.stdin.write(line);
    await shell.stdin.flush?.();
  } catch {
    // Shell died mid-write; respawn once and retry.
    adbShells.delete(id);
    const fresh = getAdbShell(id);
    fresh.stdin.write(line);
    await fresh.stdin.flush?.();
  }
}

// ─── iOS (proxy to @hypen-space/ios-streamer) ─────────────

export function isIOSStreamerConfigured(): boolean {
  return IOS_STREAMER_URL.length > 0;
}

export interface IOSListResult {
  devices: StudioDevice[];
  ffmpeg: boolean;
  /** Reachable = /health returned 2xx. */
  reachable: boolean;
  /** Human-readable reason when not reachable / no devices. */
  diagnostic?: string;
}

export async function listIOSDevices(): Promise<IOSListResult> {
  if (!IOS_STREAMER_URL) {
    return {
      devices: [],
      ffmpeg: false,
      reachable: false,
      diagnostic: "HYPEN_IOS_STREAMER_URL is not set — Studio was launched without the iOS sidecar (macOS only).",
    };
  }

  let healthRes: Response | null = null;
  try {
    healthRes = await fetch(`${IOS_STREAMER_URL}/health`);
  } catch (e: any) {
    const msg = `iOS streamer at ${IOS_STREAMER_URL} not reachable: ${e?.message ?? e}`;
    console.warn(`[Studio] ${msg}`);
    return { devices: [], ffmpeg: false, reachable: false, diagnostic: msg };
  }

  if (!healthRes.ok) {
    const msg = `iOS streamer /health returned ${healthRes.status}`;
    console.warn(`[Studio] ${msg}`);
    return { devices: [], ffmpeg: false, reachable: false, diagnostic: msg };
  }

  const health = (await healthRes.json().catch(() => ({}))) as { ffmpeg?: boolean; idb?: boolean };
  const ffmpeg = Boolean(health.ffmpeg);

  let devicesRes: Response;
  try {
    devicesRes = await fetch(`${IOS_STREAMER_URL}/devices`);
  } catch (e: any) {
    const msg = `iOS streamer /devices fetch failed: ${e?.message ?? e}`;
    console.warn(`[Studio] ${msg}`);
    return { devices: [], ffmpeg, reachable: true, diagnostic: msg };
  }

  if (!devicesRes.ok) {
    return { devices: [], ffmpeg, reachable: true, diagnostic: `iOS streamer /devices returned ${devicesRes.status}` };
  }

  const body = (await devicesRes.json()) as {
    devices: Array<{ udid: string; name: string; runtime: string; state: string }>;
  };
  const devices = (body.devices ?? []).map((d) => {
    const booted = d.state === "Booted";
    // Proxy through studio-ui so URLs are same-origin (same as Android). This
    // avoids cross-origin MJPEG quirks in Chromium and makes test curls
    // uniform ("/api/devices/ios/<udid>/stream.mjpeg").
    return {
      id: d.udid,
      platform: "ios" as const,
      name: d.name,
      status: booted ? ("running" as const) : ("stopped" as const),
      streamUrl: booted ? `/api/devices/ios/${encodeURIComponent(d.udid)}/stream.mjpeg` : null,
      videoUrl: booted && ffmpeg ? `/api/devices/ios/${encodeURIComponent(d.udid)}/stream.mp4` : null,
      subtitle: d.runtime,
    };
  });

  const diagnostic =
    devices.length === 0
      ? "Streamer is up but returned 0 devices. Open Xcode → Devices & Simulators, or run `xcrun simctl list devices --json`."
      : undefined;
  return { devices, ffmpeg, reachable: true, diagnostic };
}

export async function bootIOSDevice(udid: string): Promise<void> {
  if (!IOS_STREAMER_URL) throw new Error("ios-streamer not running");
  const res = await fetch(`${IOS_STREAMER_URL}/devices/${encodeURIComponent(udid)}/boot`, { method: "POST" });
  if (!res.ok) throw new Error(`ios-streamer boot failed: ${res.status}`);
}

export async function shutdownIOSDevice(udid: string): Promise<void> {
  if (!IOS_STREAMER_URL) throw new Error("ios-streamer not running");
  const res = await fetch(`${IOS_STREAMER_URL}/devices/${encodeURIComponent(udid)}/shutdown`, { method: "POST" });
  if (!res.ok) throw new Error(`ios-streamer shutdown failed: ${res.status}`);
}

export async function iosInput(udid: string, action: unknown): Promise<Response> {
  if (!IOS_STREAMER_URL) {
    return new Response(JSON.stringify({ error: "ios-streamer not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fetch(`${IOS_STREAMER_URL}/devices/${encodeURIComponent(udid)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
}

/** Proxy a GET to the iOS streamer, preserving response body + Content-Type. */
export async function proxyIOSGet(path: string, signal?: AbortSignal): Promise<Response> {
  if (!IOS_STREAMER_URL) {
    return new Response("ios-streamer not running", { status: 503 });
  }
  const upstream = await fetch(`${IOS_STREAMER_URL}${path}`, { signal });
  const headers = new Headers();
  const ct = upstream.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  headers.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ─── Combined ─────────────────────────────────────────────

export async function listAllDevices(): Promise<{
  android: StudioDevice[];
  ios: StudioDevice[];
  iosStreamer: boolean;
  iosReachable: boolean;
  iosFfmpeg: boolean;
  iosDiagnostic?: string;
}> {
  const [android, iosResult] = await Promise.all([listAndroidDevices(), listIOSDevices()]);
  return {
    android,
    ios: iosResult.devices,
    iosStreamer: isIOSStreamerConfigured(),
    iosReachable: iosResult.reachable,
    iosFfmpeg: iosResult.ffmpeg,
    iosDiagnostic: iosResult.diagnostic,
  };
}
