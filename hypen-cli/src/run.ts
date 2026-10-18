/**
 * hypen run - Download, install, and launch runner apps on devices
 *
 * `hypen run android` - installs and launches the Hypen Runner APK via adb
 * `hypen run ios`     - installs and launches the Hypen Runner app on iOS Simulator via xcrun
 * `hypen run desktop` - downloads and launches the Hypen Browser on this machine
 *                       (macOS arm64/x86_64, Windows x64, Linux x64)
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { createHash } from "crypto";
import { isAbsolute, join, resolve as resolvePath } from "path";
import { homedir, networkInterfaces } from "os";
import { createInterface } from "readline";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "child_process";
import { pink, yellow, dim, boldPink, boldYellow } from "./colors.js";

const isBun = typeof globalThis.Bun !== "undefined";

/** Where we cache downloaded runner binaries */
const RUNNERS_DIR = join(homedir(), ".hypen", "runners");

/** Download URLs for runner apps */
export const RUNNER_URLS = {
  android: "https://red-water-3890.ian-dae.workers.dev/android/latest",
  ios: "https://red-water-3890.ian-dae.workers.dev/ios/latest",
  version: "https://red-water-3890.ian-dae.workers.dev/version",
  // Bare-binary archives attached to hypen-engine-rs releases by the
  // Desktop Installers workflow, under stable version-less names:
  // hypen-browser-<rust-target>.tar.gz
  desktop: "https://github.com/hypen-lang/hypen-engine-rs/releases/latest/download",
} as const;

const DESKTOP_BIN = process.platform === "win32" ? "hypen-browser.exe" : "hypen-browser";

/** Local file paths for cached runners */
export const RUNNER_PATHS = {
  android: join(RUNNERS_DIR, "hypen-gallery.apk"),
  ios: join(RUNNERS_DIR, "HypenGallery.app"),
  iosZip: join(RUNNERS_DIR, "HypenGallery.zip"),
  desktop: join(RUNNERS_DIR, DESKTOP_BIN),
  desktopTar: join(RUNNERS_DIR, "hypen-browser.tar.gz"),
  version: join(RUNNERS_DIR, "version.txt"),
  /** stdout/stderr of the last `hypen run desktop` launches (appended). */
  desktopLog: join(RUNNERS_DIR, "browser.log"),
  /** Which APK we installed on which adb serial, to skip reinstalls. */
  androidInstalls: join(RUNNERS_DIR, "android-installed.json"),
} as const;

/** Env var that points `hypen run desktop` at a locally built runner. */
export const DESKTOP_RUNNER_ENV = "HYPEN_DESKTOP_RUNNER";

/** Per-command options that bin/hypen.ts passes through from flags. */
export interface RunOptions {
  /** adb serial to use (`--device`); falls back to $ANDROID_SERIAL. */
  device?: string;
  /** Path to a hypen-browser binary (`--runner`); falls back to $HYPEN_DESKTOP_RUNNER. */
  runner?: string;
}

type ExecFn = (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * The Rust target triple for the desktop runner archive matching this
 * machine, or null when no prebuilt exists (e.g. linux-arm64).
 */
export function desktopTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
    return null;
  }
  if (platform === "win32") {
    return arch === "x64" ? "x86_64-pc-windows-msvc" : null;
  }
  if (platform === "linux") {
    return arch === "x64" ? "x86_64-unknown-linux-gnu" : null;
  }
  return null;
}

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
 * Interfaces that never carry a phone's route back to this machine:
 * loopback, container bridges (docker/podman/k8s/lxc), hypervisor host-only
 * networks, and VPN/tunnel devices.
 */
const NON_LAN_IFACE =
  /^(lo|docker|br-|veth|virbr|vboxnet|vmnet|vEthernet|tun|tap|utun|wg|tailscale|zt|cni|flannel|cali|weave|kube|lxc|lxd|podman|cilium|nordlynx|proton|ppp|ipsec|gif|stf|awdl|llw|anpi|bridge|ham)/i;

/** Names of real NICs: Ethernet and Wi-Fi on Linux, macOS and Windows. */
const LAN_IFACE = /^(en|eth|wl|wlan|wlp|Wi-?Fi|Ethernet)/i;

function isPrivateIPv4(ip: string): boolean {
  return (
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Pick the address a device on the same network should dial, from an
 * `os.networkInterfaces()` map. Skips internal, IPv6, link-local
 * (169.254/16) and container/VM/VPN interfaces, then prefers real NICs and
 * RFC 1918 addresses. Returns null when nothing usable is left.
 */
export function pickLanIP(
  interfaces: Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>
): string | null {
  let best: { ip: string; score: number } | null = null;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || NON_LAN_IFACE.test(name)) continue;
    for (const addr of addrs) {
      const isV4 = addr.family === "IPv4" || addr.family === 4;
      if (!isV4 || addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue;
      const score = (LAN_IFACE.test(name) ? 2 : 0) + (isPrivateIPv4(addr.address) ? 1 : 0);
      if (!best || score > best.score) best = { ip: addr.address, score };
    }
  }
  return best?.ip ?? null;
}

/**
 * Get the local network IP for physical device connections
 */
export function getLocalIP(): string | null {
  return pickLanIP(networkInterfaces() as any);
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

export interface DownloadResult {
  ok: boolean;
  /** HTTP status when the server answered. */
  status?: number;
  /** Network/filesystem error message. */
  error?: string;
}

/**
 * Download `url` to `destPath` via a `.part` file, so a failed or partial
 * download never leaves a broken file where the cache expects a good one.
 */
export async function fetchToFile(url: string, destPath: string): Promise<DownloadResult> {
  const partPath = `${destPath}.part`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, status: response.status };
    const arrayBuffer = await response.arrayBuffer();
    if (isBun) {
      await Bun.write(partPath, arrayBuffer);
    } else {
      writeFileSync(partPath, Buffer.from(arrayBuffer));
    }
    renameSync(partPath, destPath);
    return { ok: true, status: response.status };
  } catch (err: any) {
    rmSync(partPath, { force: true });
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function downloadFile(
  url: string,
  destPath: string
): Promise<boolean> {
  const result = await fetchToFile(url, destPath);
  if (!result.ok) {
    if (result.status !== undefined) {
      console.error(`  Failed to download: HTTP ${result.status}`);
    } else {
      console.error(`  Download error: ${result.error}`);
    }
  }
  return result.ok;
}

/**
 * Delete cached runners for a platform (or all platforms).
 */
export function cleanRunners(platform?: "android" | "ios" | "desktop"): void {
  console.log(`  ${pink("Cleaning cached runners...")}`);
  if (!platform || platform === "android") {
    if (existsSync(RUNNER_PATHS.android)) rmSync(RUNNER_PATHS.android);
    // Forget what we installed so the next run reinstalls the fresh APK.
    if (existsSync(RUNNER_PATHS.androidInstalls)) rmSync(RUNNER_PATHS.androidInstalls);
  }
  if (!platform || platform === "ios") {
    if (existsSync(RUNNER_PATHS.ios)) rmSync(RUNNER_PATHS.ios, { recursive: true });
    if (existsSync(RUNNER_PATHS.iosZip)) rmSync(RUNNER_PATHS.iosZip);
  }
  if (!platform || platform === "desktop") {
    if (existsSync(RUNNER_PATHS.desktop)) rmSync(RUNNER_PATHS.desktop);
    if (existsSync(RUNNER_PATHS.desktopTar)) rmSync(RUNNER_PATHS.desktopTar);
  }
  if (existsSync(RUNNER_PATHS.version)) rmSync(RUNNER_PATHS.version);
  console.log(`  ${dim("Cached runners removed.")}\n`);
}

/**
 * A version string we're willing to show as "runner v<x>". Guards against
 * caching an error page or a usage message as the version.
 */
export function isPlausibleVersion(text: string | null | undefined): text is string {
  return !!text && /^v?\d+([.-]\d+){0,3}([.+-][0-9A-Za-z.-]+)?$/.test(text.trim());
}

/**
 * Fetch the runner version from the CDN and cache it locally. Returns null
 * (and caches nothing) when the endpoint is unavailable or answers with
 * something that isn't a version.
 */
async function fetchAndCacheVersion(): Promise<string | null> {
  try {
    const res = await fetch(RUNNER_URLS.version);
    if (!res.ok) return null;
    const version = (await res.text()).trim();
    if (!isPlausibleVersion(version)) return null;
    ensureRunnersDir();
    writeFileSync(RUNNER_PATHS.version, version);
    return version;
  } catch {
    // Version display is cosmetic; never fail or warn over it.
    return null;
  }
}

/**
 * Get the cached runner version, or null if it isn't known.
 */
function getCachedVersion(): string | null {
  try {
    if (existsSync(RUNNER_PATHS.version)) {
      const v = readFileSync(RUNNER_PATHS.version, "utf-8").trim();
      return isPlausibleVersion(v) ? v : null;
    }
  } catch {
    // fall through
  }
  return null;
}

/** " (runner v1.2.3)" when the version is known, "" otherwise. */
function versionSuffix(version: string | null | undefined): string {
  if (!isPlausibleVersion(version)) return "";
  return ` ${dim(`(runner ${version.startsWith("v") ? version : `v${version}`})`)}`;
}

export async function ensureAndroidRunner(): Promise<boolean> {
  ensureRunnersDir();
  if (existsSync(RUNNER_PATHS.android)) {
    return true;
  }
  console.log(`  ${pink("Downloading Android runner...")}`);
  console.log(`  ${dim("From:")} ${RUNNER_URLS.android}`);
  return downloadFile(RUNNER_URLS.android, RUNNER_PATHS.android);
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

/** `~/.hypen/...` for display, so the hint is copy-pasteable on every OS. */
function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * What to do when there is no prebuilt desktop runner to download: build
 * it from source, then drop it in the cache or point the CLI at it.
 */
export function desktopRunnerHelp(reason: string): string {
  const cmd = (s: string) => `    ${dim("$")} ${s}`;
  const lines = [
    "",
    `  ${boldYellow("No desktop runner:")} ${reason}`,
    "",
    "  Build the Hypen Browser from source (needs Rust; see hypen-browser/README.md",
    "  for the Linux packages: libdbus-1-dev, libclang-dev, libasound2-dev):",
    cmd("git clone https://github.com/hypen-lang/hypen.git"),
    cmd("cd hypen && cargo build --release -p hypen-browser"),
    "",
    "  Then either copy the binary into the runner cache:",
    cmd(
      process.platform === "win32"
        ? `copy target\\release\\${DESKTOP_BIN} ${tildify(RUNNER_PATHS.desktop)}`
        : `mkdir -p ${tildify(RUNNERS_DIR)} && cp target/release/${DESKTOP_BIN} ${tildify(RUNNER_PATHS.desktop)}`
    ),
    "  or point hypen at it:",
    cmd(`hypen run desktop --runner ./target/release/${DESKTOP_BIN}`),
    cmd(`${DESKTOP_RUNNER_ENV}=/path/to/${DESKTOP_BIN} hypen run desktop`),
    "",
  ];
  return lines.join("\n");
}

/**
 * An explicitly chosen desktop runner: `--runner <path>`, else
 * $HYPEN_DESKTOP_RUNNER. Relative paths resolve against the cwd.
 */
export function resolveDesktopRunnerOverride(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = flag?.trim() || env[DESKTOP_RUNNER_ENV]?.trim();
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolvePath(expanded);
}

/**
 * Download + extract the Hypen Browser bare binary for this machine.
 * Cached at ~/.hypen/runners/hypen-browser; `--clean` forces a refresh.
 * When nothing can be downloaded, prints how to build and install it.
 */
export async function ensureDesktopRunner(): Promise<boolean> {
  ensureRunnersDir();
  if (existsSync(RUNNER_PATHS.desktop)) {
    return true;
  }

  const target = desktopTarget();
  if (!target) {
    console.error(
      desktopRunnerHelp(`no prebuilt Hypen Browser for ${process.platform}/${process.arch}.`)
    );
    return false;
  }

  const url = `${RUNNER_URLS.desktop}/hypen-browser-${target}.tar.gz`;
  console.log(`  ${pink("Downloading desktop runner...")}`);
  console.log(`  ${dim("From:")} ${url}`);
  const download = await fetchToFile(url, RUNNER_PATHS.desktopTar);
  if (!download.ok) {
    const why =
      download.status === 404
        ? "the prebuilt download isn't published yet (HTTP 404)."
        : download.status !== undefined
          ? `download failed (HTTP ${download.status}).`
          : `download failed (${download.error}).`;
    console.error(desktopRunnerHelp(why));
    return false;
  }

  console.log(`  Extracting...`);
  // tar handles .tar.gz on macOS, Linux, and Windows 10+ (bsdtar).
  const { exitCode, stderr } = await exec([
    "tar",
    "-xzf",
    RUNNER_PATHS.desktopTar,
    "-C",
    RUNNERS_DIR,
  ]);
  rmSync(RUNNER_PATHS.desktopTar, { force: true });
  if (exitCode !== 0) {
    console.error(`  Failed to extract: ${stderr}`);
    return false;
  }
  if (!existsSync(RUNNER_PATHS.desktop)) {
    console.error(`  Archive did not contain ${DESKTOP_BIN}`);
    return false;
  }
  if (process.platform !== "win32") {
    await exec(["chmod", "+x", RUNNER_PATHS.desktop]);
  }
  return true;
}

export type LaunchResult =
  | { state: "running"; pid: number }
  | { state: "exited"; code: number | null; signal: string | null; logTail: string }
  | { state: "error"; message: string };

/** The last `maxLines` lines of `path` written after byte `offset`. */
function readLogTail(path: string, offset: number, maxLines = 20): string {
  try {
    const text = readFileSync(path).subarray(offset).toString("utf-8");
    return text.trimEnd().split(/\r?\n/).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Start `bin args...` detached with stdout/stderr appended to `logPath`,
 * then watch it for `graceMs`. A process that dies inside that window is
 * reported (with the tail of its log) instead of being called "launched".
 */
export async function launchDetached(
  bin: string,
  args: string[],
  opts: { logPath: string; graceMs?: number }
): Promise<LaunchResult> {
  const graceMs = opts.graceMs ?? 1500;
  let fd: number;
  let offset = 0;
  try {
    mkdirSync(join(opts.logPath, ".."), { recursive: true });
    fd = openSync(opts.logPath, "a");
    offset = statSync(opts.logPath).size;
    const header = `\n=== ${new Date().toISOString()} ${[bin, ...args].join(" ")}\n`;
    writeSync(fd, header);
    offset += Buffer.byteLength(header);
  } catch (err: any) {
    return { state: "error", message: `cannot open log ${opts.logPath}: ${err?.message ?? err}` };
  }

  return new Promise<LaunchResult>((resolve) => {
    let settled = false;
    const settle = (r: LaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof nodeSpawn>;
    try {
      // Detached + own stdio: the window outlives the CLI. Closing the
      // CLI's server just makes the browser show its reconnect state.
      child = nodeSpawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
    } catch (err: any) {
      closeSync(fd);
      resolve({ state: "error", message: err?.message ?? String(err) });
      return;
    }
    // The child holds its own copy of the descriptor.
    closeSync(fd);

    child.once("error", (err) => settle({ state: "error", message: err.message }));
    child.once("exit", (code, signal) =>
      settle({ state: "exited", code, signal, logTail: readLogTail(opts.logPath, offset) })
    );
    const timer = setTimeout(() => {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.unref();
      settle({ state: "running", pid: child.pid ?? -1 });
    }, graceMs);
  });
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

export type DeviceSelection<T> =
  | { kind: "device"; device: T }
  | { kind: "prompt"; devices: T[] }
  | { kind: "error"; message: string };

/**
 * Decide which adb device to use. An explicit serial (`--device`, else
 * $ANDROID_SERIAL) must match a ready device. With several devices and no
 * serial we prompt — but only on a TTY; otherwise we fail fast rather than
 * hang waiting for input that will never come.
 */
export function selectAndroidDevice(
  devices: AndroidDevice[],
  opts: { serial?: string; interactive: boolean }
): DeviceSelection<AndroidDevice> {
  const list = () =>
    devices.map((d) => `    ${d.id}  ${dim(`${d.name} (${d.type})`)}`).join("\n");
  const serial = opts.serial?.trim();
  if (serial) {
    const match = devices.find((d) => d.id === serial);
    if (match) return { kind: "device", device: match };
    return {
      kind: "error",
      message:
        `Android device "${serial}" is not connected (or not authorized).` +
        (devices.length ? `\n  Connected devices:\n${list()}` : ""),
    };
  }
  if (devices.length === 1) return { kind: "device", device: devices[0]! };
  if (!opts.interactive) {
    return {
      kind: "error",
      message:
        `${devices.length} Android devices are connected and there is no terminal to ask which one.\n` +
        `  Pick one with --device <serial> or ANDROID_SERIAL=<serial>:\n${list()}`,
    };
  }
  return { kind: "prompt", devices };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Forward device:port → host:port over adb. True when adb accepted it. */
export async function adbReverse(serial: string, port: number, run: ExecFn = exec): Promise<boolean> {
  const { exitCode } = await run(["adb", "-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
  return exitCode === 0;
}

export interface AndroidUrl {
  url: string;
  /** How the device reaches the server. */
  via: "reverse" | "emulator-alias" | "lan" | "override";
}

/**
 * The URL the runner should dial. `adb reverse` first: it works for
 * emulators, USB devices and remote adb alike, with no guessing about
 * which host address the device can route to. Without it, emulators use
 * the 10.0.2.2 host alias and physical devices the host's LAN IP.
 *
 * An explicit `--url` pointing at this machine's loopback is reversed too
 * (the device's own localhost would otherwise be the phone itself); any
 * other `--url` is used as given.
 */
export async function resolveAndroidUrl(
  device: Pick<AndroidDevice, "id" | "type">,
  port: number,
  overrideUrl?: string,
  run: ExecFn = exec
): Promise<AndroidUrl> {
  if (overrideUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(overrideUrl);
    } catch {
      // not a URL we can reason about; pass it through
    }
    if (!parsed || !LOCAL_HOSTS.has(parsed.hostname)) return { url: overrideUrl, via: "override" };
    const p = Number(parsed.port) || (/^(wss|https):$/.test(parsed.protocol) ? 443 : 80);
    if (await adbReverse(device.id, p, run)) return { url: overrideUrl, via: "reverse" };
    if (device.type === "emulator") {
      parsed.hostname = "10.0.2.2";
      return { url: parsed.toString().replace(/\/$/, ""), via: "emulator-alias" };
    }
    console.warn(
      `  ${yellow("Warning:")} adb reverse failed; ${overrideUrl} points at the device itself, not this machine.`
    );
    return { url: overrideUrl, via: "override" };
  }

  if (await adbReverse(device.id, port, run)) {
    return { url: `ws://localhost:${port}`, via: "reverse" };
  }
  if (device.type === "physical") {
    const ip = getLocalIP();
    if (ip) return { url: `ws://${ip}:${port}`, via: "lan" };
    console.warn("  Warning: adb reverse failed and no LAN IP was found, falling back to 10.0.2.2");
  }
  return { url: `ws://10.0.2.2:${port}`, via: "emulator-alias" };
}

export interface InstalledPackage {
  versionName?: string;
  versionCode?: string;
  lastUpdateTime?: string;
}

/** Pull version info out of `adb shell dumpsys package <pkg>`. */
export function parseDumpsysPackage(out: string): InstalledPackage | null {
  const versionName = /versionName=(\S+)/.exec(out)?.[1];
  const versionCode = /versionCode=(\d+)/.exec(out)?.[1];
  const lastUpdateTime = /lastUpdateTime=([^\r\n]+)/.exec(out)?.[1]?.trim();
  if (!versionName && !versionCode) return null;
  return { versionName, versionCode, lastUpdateTime };
}

export async function getInstalledAndroidRunner(
  serial: string,
  run: ExecFn = exec
): Promise<InstalledPackage | null> {
  const { stdout, exitCode } = await run(["adb", "-s", serial, "shell", "dumpsys", "package", ANDROID_PACKAGE]);
  if (exitCode !== 0) return null;
  return parseDumpsysPackage(stdout);
}

type InstallRecord = { apk: string; versionCode?: string; lastUpdateTime?: string };

function readInstallRecords(path: string): Record<string, InstallRecord> {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * True when `serial` still has exactly the APK we last installed there:
 * same APK bytes on our side, and the package on the device hasn't been
 * reinstalled or updated since (same versionCode and lastUpdateTime).
 */
export function isRunnerInstallCurrent(
  record: InstallRecord | undefined,
  apkHash: string,
  installed: InstalledPackage | null
): boolean {
  if (!record || !installed) return false;
  if (record.apk !== apkHash) return false;
  if (!installed.lastUpdateTime || record.lastUpdateTime !== installed.lastUpdateTime) return false;
  return record.versionCode === installed.versionCode;
}

export interface AndroidInstallResult {
  ok: boolean;
  skipped: boolean;
  versionName?: string;
  error?: string;
}

/**
 * `adb install -r` the cached runner APK on `serial` unless that exact APK
 * is already installed there. `hypen run android --clean` clears the
 * record, forcing a reinstall.
 */
export async function installAndroidRunnerIfNeeded(
  serial: string,
  opts: { apkPath?: string; recordsPath?: string; run?: ExecFn } = {}
): Promise<AndroidInstallResult> {
  const apkPath = opts.apkPath ?? RUNNER_PATHS.android;
  const recordsPath = opts.recordsPath ?? RUNNER_PATHS.androidInstalls;
  const run = opts.run ?? exec;

  const apkHash = sha256File(apkPath);
  const records = readInstallRecords(recordsPath);
  const before = await getInstalledAndroidRunner(serial, run);
  if (isRunnerInstallCurrent(records[serial], apkHash, before)) {
    return { ok: true, skipped: true, versionName: before?.versionName };
  }

  const { exitCode, stderr, stdout } = await run(["adb", "-s", serial, "install", "-r", apkPath]);
  if (exitCode !== 0) {
    return { ok: false, skipped: false, error: (stderr || stdout).trim() };
  }

  const after = await getInstalledAndroidRunner(serial, run);
  if (after?.lastUpdateTime) {
    records[serial] = { apk: apkHash, versionCode: after.versionCode, lastUpdateTime: after.lastUpdateTime };
    try {
      mkdirSync(join(recordsPath, ".."), { recursive: true });
      writeFileSync(recordsPath, JSON.stringify(records, null, 2));
    } catch {
      // Only costs a reinstall next time.
    }
  }
  return { ok: true, skipped: false, versionName: after?.versionName };
}

export async function runAndroid(
  port: number,
  overrideUrl?: string,
  options: RunOptions = {}
): Promise<void> {
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

  // Pick device: --device, then $ANDROID_SERIAL, then the only one, then ask.
  const selection = selectAndroidDevice(devices, {
    serial: options.device || process.env.ANDROID_SERIAL,
    interactive: !!process.stdin.isTTY,
  });
  if (selection.kind === "error") {
    console.error(`\n  Error: ${selection.message}\n`);
    process.exit(1);
  }
  const device =
    selection.kind === "device"
      ? selection.device
      : await promptChoice(
          selection.devices,
          (d) => `${d.name} (${d.type}) - ${d.id}`,
          "Select a device"
        );

  console.log(`  ${pink("Using:")} ${device.name} ${dim(`(${device.id})`)}\n`);

  // Download APK if needed
  const hasRunner = await ensureAndroidRunner();
  if (!hasRunner) {
    console.error("\n  Error: Could not download Android runner APK.\n");
    process.exit(1);
  }

  // Install (target specific device with -s), unless already current
  console.log(`  ${dim("Checking runner...")}`);
  const install = await installAndroidRunnerIfNeeded(device.id);
  if (!install.ok) {
    console.error(`  Install failed: ${install.error}`);
    process.exit(1);
  }
  console.log(
    `  ${pink(install.skipped ? "Runner up to date." : "Installed.")}${versionSuffix(install.versionName)}`
  );

  // Launch via deep link
  const { url: wsUrl, via } = await resolveAndroidUrl(device, port, overrideUrl);
  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  const viaNote =
    via === "reverse" ? " (adb reverse)" : via === "lan" ? " (LAN; device must be on the same network)" : "";
  console.log(`  ${dim("Launching with server:")} ${yellow(wsUrl)}${dim(viaNote)}`);

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
  console.log(`  ${pink("Installed.")}${versionSuffix(getCachedVersion())}`);

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

// ─── Desktop ──────────────────────────────────────────────

/**
 * Launch the Hypen Browser on this machine, pointed at the dev server.
 * Works on macOS (arm64/x86_64), Windows (x64), and Linux (x64) — the
 * platforms the Desktop Installers workflow publishes binaries for — and
 * anywhere else with a locally built runner (`--runner`/$HYPEN_DESKTOP_RUNNER).
 */
export async function runDesktop(
  port: number,
  overrideUrl?: string,
  options: RunOptions = {}
): Promise<void> {
  let runner = resolveDesktopRunnerOverride(options.runner);
  if (runner) {
    if (!existsSync(runner) || statSync(runner).isDirectory()) {
      const source = options.runner ? "--runner" : `$${DESKTOP_RUNNER_ENV}`;
      console.error(`\n  Error: ${source} points at ${runner}, which is not a file.\n`);
      process.exit(1);
    }
  } else {
    const hasRunner = await ensureDesktopRunner();
    if (!hasRunner) {
      console.error("  Error: Could not set up the desktop runner.\n");
      process.exit(1);
    }
    runner = RUNNER_PATHS.desktop;
  }
  console.log(`  ${pink("Runner:")} ${dim(tildify(runner))}`);

  const wsUrl = overrideUrl || `ws://localhost:${port}`;
  console.log(`  ${dim("Launching with server:")} ${yellow(wsUrl)}`);

  const logPath = RUNNER_PATHS.desktopLog;
  const result = await launchDetached(runner, [wsUrl], { logPath });
  if (result.state === "error") {
    console.error(`\n  Error: could not start ${runner}: ${result.message}\n`);
    process.exit(1);
  }
  if (result.state === "exited") {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    if (result.code === 0 && !result.signal) {
      console.warn(`  ${yellow("Warning:")} Hypen Browser exited right away (${how}).`);
    } else {
      console.error(`\n  Error: Hypen Browser exited right after starting (${how}).`);
    }
    if (result.logTail) {
      console.error(`\n${result.logTail.split("\n").map((l) => `    ${dim(l)}`).join("\n")}\n`);
    }
    console.error(`  Full log: ${tildify(logPath)}\n`);
    if (result.code !== 0 || result.signal) process.exit(1);
    return;
  }

  console.log(`  ${pink("Hypen Browser launched.")} ${dim(`Log: ${tildify(logPath)}`)}\n`);
}

// ─── Help ─────────────────────────────────────────────────

export const RUN_HELP = `
  ${boldPink("hypen run")} ${dim("-")} Start dev server and launch Hypen Runner on a device

  ${boldYellow("Usage:")}
    hypen run <platform> [options]

  ${boldYellow("Platforms:")}
    ${pink("android")}               Install and launch on Android device/emulator (via adb)
    ${pink("ios")}                   Install and launch on iOS Simulator (via xcrun simctl)
    ${pink("desktop")}               Launch the Hypen Browser on this machine (macOS/Windows/Linux)

  ${boldYellow("Options:")}
    --port, -p <port>     Dev server port (default: 3000)
    --url <ws://...>      Connect to an existing server (skips built-in server)
    --clean               Delete cached runner and download a fresh copy
                          (Android: also forces a reinstall)
    --studio              Launch Studio IDE alongside the runner
    --device <serial>     Android: adb serial to use (default: $ANDROID_SERIAL)
    --runner <path>       Desktop: use this hypen-browser binary
                          (default: $${DESKTOP_RUNNER_ENV}, else ~/.hypen/runners/)

  This command starts a hypen dev server, downloads and installs the runner app
  (cached in ~/.hypen/runners/), and launches it on your device. Use --url to
  connect to an existing server instead of starting a new one.

  If multiple Android devices are connected, pass --device (or set
  ANDROID_SERIAL); in a terminal you'll otherwise be prompted to choose one.
  Android connects over ${dim("adb reverse")} when it can (ws://localhost:<port>),
  else via 10.0.2.2 (emulator) or this machine's LAN IP (physical device).
  The APK is only reinstalled when it changed.

  Desktop runner output goes to ~/.hypen/runners/browser.log. If no prebuilt
  runner can be downloaded, build it with ${dim("cargo build --release -p hypen-browser")}
  and copy it to ~/.hypen/runners/hypen-browser, or pass --runner.

  ${boldYellow("Examples:")}
    ${dim("$")} hypen run android
    ${dim("$")} hypen run ios
    ${dim("$")} hypen run desktop
    ${dim("$")} hypen run android --port 8080
    ${dim("$")} hypen run desktop --url ws://localhost:3000
    ${dim("$")} hypen run ios --clean
    ${dim("$")} hypen run android --device emulator-5554
    ${dim("$")} hypen run desktop --runner ./target/release/hypen-browser
`;
