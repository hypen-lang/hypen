import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, readFileSync } from "fs";

import type { Shell, BinaryShell, Simulator } from "./types.ts";
import { bunShell, bunBinaryShell } from "./shell.ts";

/**
 * Build the argv for `xcrun simctl list devices --json` so tests can assert
 * the exact command without mocking the shell.
 */
export function listDevicesCmd(): string[] {
  return ["xcrun", "simctl", "list", "devices", "--json"];
}

export function bootCmd(udid: string): string[] {
  return ["xcrun", "simctl", "boot", udid];
}

export function shutdownCmd(udid: string): string[] {
  return ["xcrun", "simctl", "shutdown", udid];
}

/**
 * Capture a single frame to a file path.
 *
 * Historically this supported "-" as a stdout sentinel, but Xcode 26's
 * `simctl io` stopped honouring that ("You can't save the file '-' because
 * the volume 'Macintosh HD' is read only"). Callers should pass a concrete
 * writable path (typically a tempfile); the high-level `screenshot()`
 * wrapper below does that for you.
 */
export function screenshotCmd(udid: string, outputPath: string, type: "png" | "jpeg" = "jpeg"): string[] {
  return ["xcrun", "simctl", "io", udid, "screenshot", `--type=${type}`, outputPath];
}

/**
 * Parse `xcrun simctl list devices --json` output.
 *
 * Shape:
 *   { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [ { udid, name, state, isAvailable, ... } ] } }
 */
export function parseDevicesJson(json: string): Simulator[] {
  const data = JSON.parse(json);
  const out: Simulator[] = [];

  for (const [runtimeKey, devices] of Object.entries(data.devices ?? {})) {
    if (!Array.isArray(devices)) continue;
    const runtime = formatRuntime(runtimeKey);

    for (const dev of devices as Array<Record<string, unknown>>) {
      if (dev.isAvailable === false) continue;
      out.push({
        udid: String(dev.udid),
        name: String(dev.name),
        runtime,
        state: String(dev.state),
        deviceTypeIdentifier:
          typeof dev.deviceTypeIdentifier === "string" ? dev.deviceTypeIdentifier : undefined,
      });
    }
  }

  return out.sort((a, b) => {
    if (a.state === "Booted" && b.state !== "Booted") return -1;
    if (a.state !== "Booted" && b.state === "Booted") return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * "com.apple.CoreSimulator.SimRuntime.iOS-17-4" -> "iOS 17.4"
 */
export function formatRuntime(runtimeKey: string): string {
  return runtimeKey
    .replace(/.*SimRuntime\./, "")
    .replace(/-/g, ".")
    .replace(/\.(\d)/, " $1");
}

// ─── High-level wrappers (use the default Bun shell unless overridden) ───

export async function listDevices(shell: Shell = bunShell): Promise<Simulator[]> {
  const { stdout, exitCode } = await shell(listDevicesCmd());
  if (exitCode !== 0) return [];
  try {
    return parseDevicesJson(stdout);
  } catch {
    return [];
  }
}

export async function boot(udid: string, shell: Shell = bunShell): Promise<void> {
  const { exitCode, stderr } = await shell(bootCmd(udid));
  // "Unable to boot device in current state: Booted" is fine.
  if (exitCode !== 0 && !stderr.includes("current state: Booted")) {
    throw new Error(`Failed to boot ${udid}: ${stderr.trim()}`);
  }
}

export async function shutdown(udid: string, shell: Shell = bunShell): Promise<void> {
  const { exitCode, stderr } = await shell(shutdownCmd(udid));
  if (exitCode !== 0 && !stderr.includes("Unable to shutdown")) {
    throw new Error(`Failed to shutdown ${udid}: ${stderr.trim()}`);
  }
}

function uniqueTmpPath(udid: string, type: "png" | "jpeg"): string {
  return join(tmpdir(), `hypen-sim-${udid}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${type}`);
}

/**
 * Capture a screenshot via a short-lived tempfile (Xcode 26 no longer
 * accepts "-" as the output path). File is deleted immediately after read.
 *
 * The `binaryShell` parameter is kept for API compatibility but no longer
 * required — stdout isn't used anymore. We accept it as an optional hint
 * so existing test mocks that override the shell still work.
 */
export async function screenshot(
  udid: string,
  type: "png" | "jpeg" = "jpeg",
  _binaryShell: BinaryShell = bunBinaryShell,
  shell: Shell = bunShell
): Promise<Uint8Array> {
  const tmpPath = uniqueTmpPath(udid, type);
  try {
    const { exitCode, stderr } = await shell(screenshotCmd(udid, tmpPath, type));
    if (exitCode !== 0) {
      throw new Error(`simctl screenshot exit ${exitCode} for ${udid}: ${stderr.trim() || "<no stderr>"}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(tmpPath));
    } catch (e: any) {
      throw new Error(`simctl screenshot succeeded but tempfile ${tmpPath} was unreadable: ${e?.message ?? e}`);
    }

    if (bytes.byteLength === 0) {
      throw new Error(`simctl screenshot wrote 0 bytes to ${tmpPath} for ${udid}`);
    }

    const sig0 = bytes[0];
    const sig1 = bytes[1];
    const looksJpeg = sig0 === 0xff && sig1 === 0xd8;
    const looksPng = sig0 === 0x89 && sig1 === 0x50;
    if (!looksJpeg && !looksPng) {
      const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 120)));
      throw new Error(`simctl screenshot output not an image (sig=${sig0?.toString(16)},${sig1?.toString(16)}): "${head}"`);
    }

    return bytes;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}
