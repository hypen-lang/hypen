/**
 * hypen run - Download, install, and launch runner apps on devices
 *
 * `hypen run android` - installs and launches the Hypen Runner APK via adb
 * `hypen run ios`     - installs and launches the Hypen Runner app on iOS Simulator via xcrun
 */

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, networkInterfaces } from "os";
import { createInterface } from "readline";
import { execFile as nodeExecFile } from "child_process";
import { pink, yellow, dim, boldPink, boldYellow } from "./colors.js";

const isBun = typeof globalThis.Bun !== "undefined";

/** Where we cache downloaded runner binaries */
const RUNNERS_DIR = join(homedir(), ".hypen", "runners");

/** Download URLs for runner apps */
export const RUNNER_URLS = {
  android: "https://red-water-3890.ian-dae.workers.dev/android/latest",
  ios: "https://red-water-3890.ian-dae.workers.dev/ios/latest",
  version: "https://red-water-3890.ian-dae.workers.dev/version",
} as const;

/** Local file paths for cached runners */
export const RUNNER_PATHS = {
  android: join(RUNNERS_DIR, "hypen-gallery.apk"),
  ios: join(RUNNERS_DIR, "HypenGallery.app"),
  iosZip: join(RUNNERS_DIR, "HypenGallery.zip"),
  version: join(RUNNERS_DIR, "version.txt"),
} as const;

/** Android/iOS identifiers */
const ANDROID_PACKAGE = "space.hypen.gallery";
const ANDROID_ACTIVITY = `${ANDROID_PACKAGE}/.MainActivity`;
const IOS_BUNDLE_ID = "space.hypen.gallery.HypenGallery";

// ─── Device types ─────────────────────────────────────────

export interface AndroidDevice {
  id: string;
  name: string;
  type: "emulator" | "physical";
  status: string;
}

export interface IOSSimulator {
  udid: string;
  name: string;
  runtime: string;
  state: "Booted" | "Shutdown" | string;
}

// ─── Shell helpers ────────────────────────────────────────

/**
 * Run a shell command, return stdout/stderr/exitCode.
 * Uses Bun.spawn() when running under Bun, falls back to child_process for Node.js.
 */
export async function exec(
  cmd: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (isBun) {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  // Node.js fallback using child_process
  return new Promise((resolve) => {
    const [binary, ...args] = cmd;
    nodeExecFile(binary, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

/**
 * Check if a command exists on PATH
 */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    if (isBun) {
      const proc = Bun.spawn(["which", cmd], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }
    // Node.js fallback
    const { exitCode } = await exec(["which", cmd]);
    return exitCode === 0;
  } catch (e: any) {
    console.warn(`  Warning: command lookup failed for '${cmd}': ${e.message}`);
    return false;
  }
}

// ─── Network ──────────────────────────────────────────────

/**
 * Get the local network IP for physical device connections
 */
export function getLocalIP(): string | null {
  const interfaces = networkInterfaces();
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

/**
 * Compute the WebSocket URL a device should connect to.
 * - Android emulators: 10.0.2.2 (special alias for host loopback)
 * - Android physical: host's LAN IP
 * - iOS simulators: localhost (shares host network)
 */
export function getServerUrl(
  platform: "android" | "ios",
  port: number,
  deviceType?: "emulator" | "physical" | "simulator"
): string {
  if (platform === "android") {
    if (deviceType === "physical") {
      const ip = getLocalIP();
      if (ip) return `ws://${ip}:${port}`;
      console.warn("  Warning: Could not detect LAN IP, falling back to 10.0.2.2");
    }
    return `ws://10.0.2.2:${port}`;
  }
  // iOS simulators share the host network
  return `ws://localhost:${port}`;
}

// ─── Interactive prompt ───────────────────────────────────

/**
 * Prompt the user to pick one item from a list.
 * Returns the chosen item, or the only item if there's just one.
 */
export async function promptChoice<T>(
  items: T[],
  formatItem: (item: T, index: number) => string,
  message: string
): Promise<T> {
  if (items.length === 1) return items[0];

  console.log();
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}) ${formatItem(items[i], i)}`);
  }
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<T>((resolve) => {
    const ask = () => {
      rl.question(`  ${message} [1-${items.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= items.length) {
          rl.close();
          resolve(items[num - 1]);
        } else {
          console.log(`  Please enter a number between 1 and ${items.length}`);
          ask();
        }
      });
    };
    ask();
  });
}

// ─── Download helpers ─────────────────────────────────────

function ensureRunnersDir(): void {
  if (!existsSync(RUNNERS_DIR)) {
    mkdirSync(RUNNERS_DIR, { recursive: true });
  }
}

export async function downloadFile(
  url: string,
  destPath: string
): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`  Failed to download: HTTP ${response.status}`);
      return false;
    }
    const arrayBuffer = await response.arrayBuffer();
    if (isBun) {
      await Bun.write(destPath, arrayBuffer);
    } else {
      writeFileSync(destPath, Buffer.from(arrayBuffer));
    }
    return true;
  } catch (err: any) {
    console.error(`  Download error: ${err.message}`);
    return false;
  }
}

/**
 * Delete cached runners for a platform (or all platforms).
 */
export function cleanRunners(platform?: "android" | "ios"): void {
  console.log(`  ${pink("Cleaning cached runners...")}`);
  if (!platform || platform === "android") {
    if (existsSync(RUNNER_PATHS.android)) rmSync(RUNNER_PATHS.android);
  }
  if (!platform || platform === "ios") {
    if (existsSync(RUNNER_PATHS.ios)) rmSync(RUNNER_PATHS.ios, { recursive: true });
    if (existsSync(RUNNER_PATHS.iosZip)) rmSync(RUNNER_PATHS.iosZip);
  }
  if (existsSync(RUNNER_PATHS.version)) rmSync(RUNNER_PATHS.version);
  console.log(`  ${dim("Cached runners removed.")}\n`);
}

/**
 * Fetch the runner version from the CDN and cache it locally.
 */
async function fetchAndCacheVersion(): Promise<string> {
  try {
    const res = await fetch(RUNNER_URLS.version);
    if (res.ok) {
      const version = (await res.text()).trim();
      ensureRunnersDir();
      if (isBun) {
        await Bun.write(RUNNER_PATHS.version, version);
      } else {
        writeFileSync(RUNNER_PATHS.version, version);
      }
      return version;
    }
  } catch (e: any) {
    console.warn(`  Warning: could not fetch runner version: ${e.message}`);
  }
  return "unknown";
}

/**
 * Get the cached runner version, or "unknown" if not available.
 */
function getCachedVersion(): string {
  try {
    if (existsSync(RUNNER_PATHS.version)) {
      return readFileSync(RUNNER_PATHS.version, "utf-8").trim();
    }
  } catch (e: any) {
    console.warn(`  Warning: could not read cached version: ${e.message}`);
  }
  return "unknown";
}

export async function ensureAndroidRunner(): Promise<boolean> {
  ensureRunnersDir();
  if (existsSync(RUNNER_PATHS.android)) {
    return true;
  }
  console.log(`  ${pink("Downloading Android runner...")}`);
  console.log(`  ${dim("From:")} ${RUNNER_URLS.android}`);
  const ok = await downloadFile(RUNNER_URLS.android, RUNNER_PATHS.android);
  if (ok) await fetchAndCacheVersion();
  return ok;
}

export async function ensureIOSRunner(): Promise<boolean> {
  ensureRunnersDir();
  if (existsSync(RUNNER_PATHS.ios)) {
    return true;
  }
  console.log(`  ${pink("Downloading iOS runner...")}`);
  console.log(`  ${dim("From:")} ${RUNNER_URLS.ios}`);

  const downloaded = await downloadFile(RUNNER_URLS.ios, RUNNER_PATHS.iosZip);
  if (!downloaded) return false;

  console.log(`  Extracting...`);
  const { exitCode, stderr } = await exec([
    "unzip",
    "-o",
    RUNNER_PATHS.iosZip,
    "-d",
    RUNNERS_DIR,
  ]);
  if (exitCode !== 0) {
    console.error(`  Failed to unzip: ${stderr}`);
    return false;
  }

  if (existsSync(RUNNER_PATHS.ios)) {
    await fetchAndCacheVersion();
    return true;
  }
  return false;
}

// ─── Device discovery ─────────────────────────────────────

/**
 * Parse `adb devices -l` into a structured list
 */
export async function listAndroidDevices(): Promise<AndroidDevice[]> {
  const { stdout, exitCode } = await exec(["adb", "devices", "-l"]);
  if (exitCode !== 0) return [];

  const devices: AndroidDevice[] = [];
  const lines = stdout.trim().split("\n").slice(1); // skip header

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const id = parts[0];
    const status = parts[1];
    if (!id || status !== "device") continue;

    const modelMatch = trimmed.match(/model:(\S+)/);
    const deviceMatch = trimmed.match(/device:(\S+)/);
    const name = (modelMatch?.[1] || deviceMatch?.[1] || id).replace(/_/g, " ");
    const isEmulator = id.startsWith("emulator-") || id.includes("localhost:");

    devices.push({
      id,
      name,
      type: isEmulator ? "emulator" : "physical",
      status,
    });
  }

  return devices;
}

/**
 * Parse `xcrun simctl list devices --json` into a structured list.
 * Returns all available simulators, with booted ones first.
 */
export async function listIOSSimulators(): Promise<IOSSimulator[]> {
  const { stdout, exitCode } = await exec([
    "xcrun",
    "simctl",
    "list",
    "devices",
    "--json",
  ]);
  if (exitCode !== 0) return [];

  const simulators: IOSSimulator[] = [];

  try {
    const data = JSON.parse(stdout);
    for (const [runtime, devs] of Object.entries(data.devices || {})) {
      if (!Array.isArray(devs)) continue;
      // Extract short runtime name: "com.apple.CoreSimulator.SimRuntime.iOS-17-4" -> "iOS 17.4"
      const runtimeShort = runtime
        .replace(/.*SimRuntime\./, "")
        .replace(/-/g, ".")
        .replace(/\.(\d)/, " $1");

      for (const dev of devs as any[]) {
        if (!dev.isAvailable) continue;
        simulators.push({
          udid: dev.udid,
          name: dev.name,
          runtime: runtimeShort,
          state: dev.state,
        });
      }
    }
  } catch (e: any) {
    console.warn(`  Warning: failed to parse iOS simulator list: ${e.message}`);
    return [];
  }

  // Booted simulators first
  simulators.sort((a, b) => {
    if (a.state === "Booted" && b.state !== "Booted") return -1;
    if (a.state !== "Booted" && b.state === "Booted") return 1;
    return 0;
  });

  return simulators;
}

// ─── Android ──────────────────────────────────────────────

export async function runAndroid(port: number, overrideUrl?: string): Promise<void> {
  const hasAdb = await commandExists("adb");
  if (!hasAdb) {
    console.error(
      "\n  Error: adb not found.\n  Install Android SDK platform-tools and make sure adb is on your PATH.\n"
    );
    process.exit(1);
  }

  // Discover devices
  const devices = await listAndroidDevices();
  if (devices.length === 0) {
    console.error(
      "\n  Error: No Android devices/emulators connected.\n  Start an emulator or connect a device via USB.\n"
    );
    process.exit(1);
  }

  // Pick device
  const device = await promptChoice(
    devices,
    (d) => {
      const tag = d.type === "emulator" ? "emulator" : "physical";
      return `${d.name} (${tag}) - ${d.id}`;
    },
    "Select a device"
  );

  console.log(`  ${pink("Using:")} ${device.name} ${dim(`(${device.id})`)}\n`);

  // Download APK if needed
  const hasRunner = await ensureAndroidRunner();
  if (!hasRunner) {
    console.error("\n  Error: Could not download Android runner APK.\n");
    process.exit(1);
  }

  // Install (target specific device with -s)
  console.log(`  ${dim("Installing runner...")}`);
  const { exitCode: installCode, stderr: installErr } = await exec([
    "adb",
    "-s",
    device.id,
    "install",
    "-r",
    RUNNER_PATHS.android,
  ]);
  if (installCode !== 0) {
    console.error(`  Install failed: ${installErr}`);
    process.exit(1);
  }
  const version = getCachedVersion();
  console.log(`  ${pink("Installed.")} ${dim(`(runner v${version})`)}`);

  // Launch via deep link
  const wsUrl = overrideUrl || getServerUrl("android", port, device.type);
  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  console.log(`  ${dim("Launching with server:")} ${yellow(wsUrl)}`);

  const { exitCode: launchCode, stderr: launchErr } = await exec([
    "adb",
    "-s",
    device.id,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    deepLink,
  ]);
  if (launchCode !== 0) {
    console.error(`  Launch failed: ${launchErr}`);
    process.exit(1);
  }

  console.log(`  ${pink("Runner launched on")} ${yellow(device.name)}\n`);
}

// ─── iOS ──────────────────────────────────────────────────

export async function runIOS(port: number, overrideUrl?: string): Promise<void> {
  const hasXcrun = await commandExists("xcrun");
  if (!hasXcrun) {
    console.error(
      "\n  Error: xcrun not found.\n  Install Xcode and its command line tools.\n"
    );
    process.exit(1);
  }

  // Discover simulators
  const allSimulators = await listIOSSimulators();
  if (allSimulators.length === 0) {
    console.error(
      "\n  Error: No iOS Simulators available.\n  Open Xcode and create a simulator, or install a runtime.\n"
    );
    process.exit(1);
  }

  // Prefer booted simulators, but show all
  const booted = allSimulators.filter((s) => s.state === "Booted");
  const candidates = booted.length > 0 ? booted : allSimulators;

  const sim = await promptChoice(
    candidates,
    (s) => {
      const state = s.state === "Booted" ? "booted" : "shutdown";
      return `${s.name} - ${s.runtime} [${state}]`;
    },
    "Select a simulator"
  );

  console.log(`  ${pink("Using:")} ${sim.name} ${dim(`(${sim.udid})`)}\n`);

  // Boot the simulator if it's not running
  if (sim.state !== "Booted") {
    console.log(`  ${dim("Booting")} ${sim.name}...`);
    const { exitCode, stderr } = await exec([
      "xcrun",
      "simctl",
      "boot",
      sim.udid,
    ]);
    if (exitCode !== 0) {
      // "Unable to boot device in current state: Booted" is fine — already booted
      if (!stderr.includes("current state: Booted")) {
        console.error(`  Failed to boot simulator: ${stderr}`);
        process.exit(1);
      }
    }

    // Wait for the simulator to be fully ready (boot command returns before UI is up)
    console.log(`  ${dim("Waiting for simulator to be ready...")}`);
    const maxWait = 60_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const { stdout } = await exec([
        "xcrun", "simctl", "list", "devices", sim.udid, "--json",
      ]);
      try {
        const data = JSON.parse(stdout);
        const devices = Object.values(data.devices || {}).flat() as any[];
        const dev = devices.find((d: any) => d.udid === sim.udid);
        if (dev?.state === "Booted") break;
      } catch (e: any) {
        console.warn(`  Warning: could not parse simulator status: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Also open Simulator.app so the window is visible
    await exec(["open", "-a", "Simulator"]);
    // Give the Simulator UI a moment to be ready for deep links
    await new Promise((r) => setTimeout(r, 2000));

    console.log(`  ${pink("Booted.")}`);
  }

  // Download .app if needed
  const hasRunner = await ensureIOSRunner();
  if (!hasRunner) {
    console.error("\n  Error: Could not download iOS runner app.\n");
    process.exit(1);
  }

  // Install on simulator
  console.log(`  ${dim("Installing runner...")}`);
  const { exitCode: installCode, stderr: installErr } = await exec([
    "xcrun",
    "simctl",
    "install",
    sim.udid,
    RUNNER_PATHS.ios,
  ]);
  if (installCode !== 0) {
    console.error(`  Install failed: ${installErr}`);
    process.exit(1);
  }
  const version = getCachedVersion();
  console.log(`  ${pink("Installed.")} ${dim(`(runner v${version})`)}`);

  // Launch via deep link (retry a few times if simulator isn't ready yet)
  const wsUrl = overrideUrl || getServerUrl("ios", port, "simulator");
  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  console.log(`  ${dim("Launching with server:")} ${yellow(wsUrl)}`);

  let launchOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { exitCode: launchCode, stderr: launchErr } = await exec([
      "xcrun",
      "simctl",
      "openurl",
      sim.udid,
      deepLink,
    ]);
    if (launchCode === 0) {
      launchOk = true;
      break;
    }
    if (attempt < 2 && launchErr.includes("timed out")) {
      console.log(`  ${dim("Simulator not ready, retrying...")}`);
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      console.error(`  Launch failed: ${launchErr}`);
      process.exit(1);
    }
  }

  console.log(`  ${pink("Runner launched on")} ${yellow(sim.name)}\n`);
}

// ─── Help ─────────────────────────────────────────────────

export const RUN_HELP = `
  ${boldPink("hypen run")} ${dim("-")} Start dev server and launch Hypen Runner on a device

  ${boldYellow("Usage:")}
    hypen run <platform> [options]

  ${boldYellow("Platforms:")}
    ${pink("android")}               Install and launch on Android device/emulator (via adb)
    ${pink("ios")}                   Install and launch on iOS Simulator (via xcrun simctl)

  ${boldYellow("Options:")}
    --port, -p <port>     Dev server port (default: 3000)
    --url <ws://...>      Connect to an existing server (skips built-in server)
    --clean               Delete cached runner and download a fresh copy
    --studio              Launch Studio IDE alongside the runner

  This command starts a hypen dev server, downloads and installs the runner app
  (cached in ~/.hypen/runners/), and launches it on your device. Use --url to
  connect to an existing server instead of starting a new one.

  If multiple devices are connected, you'll be prompted to choose one.

  ${boldYellow("Examples:")}
    ${dim("$")} hypen run android
    ${dim("$")} hypen run ios
    ${dim("$")} hypen run android --port 8080
    ${dim("$")} hypen run android --url ws://localhost:3000
    ${dim("$")} hypen run ios --clean
`;
