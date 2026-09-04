#!/usr/bin/env bun
/**
 * Hypen Component Gallery Screenshot Tests
 *
 * Runs screenshot tests across Web DOM, Canvas, Desktop, iOS, and Android.
 *
 * Usage:
 *   bun run run-tests.ts [options]
 *
 * Options:
 *   --ios-only      Run only iOS tests
 *   --android-only  Run only Android tests
 *   --web-only      Run only Web tests
 *   --canvas-only   Run only Canvas renderer tests
 *   --desktop-only  Run only Desktop renderer tests
 *   --skip-ios      Skip iOS tests
 *   --skip-android  Skip Android tests
 *   --skip-web      Skip Web tests
 *   --skip-canvas   Skip Canvas renderer tests
 *   --skip-desktop  Skip Desktop renderer tests
 *   --component=X   Test specific components (comma-separated, e.g. --component=column,stack,padding)
 *   --skip-install  Skip app installation (use if already installed)
 *   --skip-server   Skip starting the component server (use if already running)
 *   --resume        Resume from last failed/incomplete test
 *   --fresh         Delete the progress file before running (force re-run)
 *   --timeout=X     Per-screenshot timeout in ms (default: 10000)
 *   --visible       Show browser window (for debugging)
 *   --dump-html     Save rendered HTML files alongside web screenshots (for debugging)
 *   --ios-simulator=X  Exact iOS simulator name (default: iPhone 17 Pro Max)
 *   --ios-udid=X       Pin one simulator when the name exists in multiple runtimes
 *   --ios-width=X      Expected iOS screenshot width (default: 1320)
 *   --ios-height=X     Expected iOS screenshot height (default: 2868)
 *   --android-avd=X    Exact Android AVD name (default: Pixel_8)
 *   --android-serial=X Pin a connected emulator serial
 *   --android-api=X    Expected Android API level (default: 34)
 *   --android-width=X  Expected Android screenshot width (default: 1080)
 *   --android-height=X Expected Android screenshot height (default: 2400)
 *   --android-density=X Expected Android density dpi (default: 420)
 */

import { $ } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import {
  type AndroidDevice,
  androidGalleryLaunchCommand,
  type IOSSimulator,
  androidConsolePortFromSerial,
  androidEnvironmentForDevice,
  integerOption,
  iosGalleryLaunchCommand,
  optionValue,
  parseAndroidMetric,
  parsePngDimensions,
  probeAndroidDevice,
  selectAndroidConsolePort,
  selectAndroidDevice,
  selectIOSSimulator,
} from "./device-config";
import {
  captureStage,
  fetchGalleryReadiness,
  nativeGalleryStabilityOptions,
  waitForBrowserPaint,
  waitForGalleryReadiness,
  waitForVisualStability,
} from "./capture-readiness";
import {
  ensureServerLifecycle,
  probeComponentGallery,
  probeWebGallery,
} from "./server-lifecycle";
import { cleanupOwnedResources, type OwnedBrowser } from "./runner-cleanup";

// Configuration
const SCRIPT_DIR = dirname(import.meta.path);
const ROOT_DIR = join(SCRIPT_DIR, "..");
const RESULTS_DIR = join(SCRIPT_DIR, "results");
const PROGRESS_FILE = join(RESULTS_DIR, ".progress.json");
const SWIFT_DIR = join(ROOT_DIR, "..", "hypen-renderer-swift");
const ANDROID_DIR = join(ROOT_DIR, "..", "hypen-renderer-android");
const WEB_DIR = join(ROOT_DIR, "..", "hypen-web", "screenshot-testing");
const WORKSPACE_DIR = join(ROOT_DIR, "..");
const DESKTOP_SCREENSHOT_BINARY = join(
  WORKSPACE_DIR,
  "target", "debug", "examples", "gallery_screenshot",
);

const COMPONENT_SERVER_PORT = 6555;
const WEB_GALLERY_PORT = 5556;

// Platform routing
const IOS_GALLERY_BUNDLE_ID = "space.hypen.gallery.HypenGallery";
const ANDROID_GALLERY_PACKAGE_ID = "space.hypen.gallery";
const ANDROID_GALLERY_ACTIVITY = ".ComponentListActivity";

// Per-screenshot timeout (ms)
const DEFAULT_TIMEOUT = 10000;

// Track spawned processes for cleanup
const spawnedProcesses: import("bun").Subprocess[] = [];

// Shared browser instance for web screenshots
let sharedBrowser: import("puppeteer").Browser | null = null;
let sharedBrowserInit: Promise<import("puppeteer").Browser> | null = null;
const sharedPages = new Map<"web" | "canvas", import("puppeteer").Page>();

async function getSharedBrowser(
  platform: "web" | "canvas",
): Promise<{ browser: import("puppeteer").Browser; page: import("puppeteer").Page }> {
  if (!sharedBrowser) {
    sharedBrowserInit ??= (async () => {
      const puppeteer = await import("puppeteer");
      return puppeteer.default.launch({
        // Chrome's new headless mode can leave Page.captureScreenshot pending
        // indefinitely on macOS even for a plain page. Puppeteer's headless
        // shell is purpose-built for deterministic capture and does not hang.
        headless: visibleMode ? false : "shell",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    })();
    sharedBrowser = await sharedBrowserInit;
    sharedBrowserInit = null;
  }
  const browser = sharedBrowser;
  if (!browser) throw new Error("Browser failed to initialize");
  let page = sharedPages.get(platform);
  if (!page) {
    page = await browser.newPage();
    await page.setViewport({
      width: 430,
      height: 934,
      deviceScaleFactor: 1,
    });
    sharedPages.set(platform, page);
  }
  return { browser, page };
}

let cleanupPromise: Promise<void> | null = null;

function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;

  const browser = sharedBrowser;
  const ownedBrowser: OwnedBrowser | null = browser ? {
    close: () => browser.close(),
    forceClose: () => {
      try { browser.disconnect(); } catch {}
      try { browser.process()?.kill("SIGKILL"); } catch {}
    },
  } : null;
  sharedBrowser = null;
  sharedPages.clear();

  // Take ownership of the current list so a repeated signal cannot terminate
  // anything twice. Reused servers and pre-existing devices are never added.
  const processes = spawnedProcesses.splice(0);
  cleanupPromise = cleanupOwnedResources({ browser: ownedBrowser, processes })
    .then(result => {
      if (result.processesStillRunning > 0) {
        console.warn(
          `Warning: ${result.processesStillRunning} spawned process(es) did not exit before the cleanup deadline.`,
        );
      }
    });
  return cleanupPromise;
}

// Parse command line arguments
const args = process.argv.slice(2);
const iosOnly = args.includes("--ios-only");
const androidOnly = args.includes("--android-only");
const webOnly = args.includes("--web-only");
const canvasOnly = args.includes("--canvas-only");
const desktopOnly = args.includes("--desktop-only");
const skipIos = args.includes("--skip-ios");
const skipAndroid = args.includes("--skip-android");
const skipWeb = args.includes("--skip-web");
const skipCanvas = args.includes("--skip-canvas");
const skipDesktop = args.includes("--skip-desktop");
const skipInstall = args.includes("--skip-install");
const skipServer = args.includes("--skip-server");
const resumeMode = args.includes("--resume");
const freshMode = args.includes("--fresh");
const hasOnlyFlag = iosOnly || androidOnly || webOnly || canvasOnly || desktopOnly;
const runIOS = iosOnly || (!hasOnlyFlag && !skipIos);
const runAndroid = androidOnly || (!hasOnlyFlag && !skipAndroid);
const runWeb = webOnly || (!hasOnlyFlag && !skipWeb);
const runCanvas = canvasOnly || (!hasOnlyFlag && !skipCanvas);
const runDesktop = desktopOnly || (!hasOnlyFlag && !skipDesktop);

// --*-only flags are mutually exclusive — passing more than one sets all
// platform toggles to false and silently runs 0 tests.
const onlyFlags = [
  iosOnly ? "--ios-only" : null,
  androidOnly ? "--android-only" : null,
  webOnly ? "--web-only" : null,
  canvasOnly ? "--canvas-only" : null,
  desktopOnly ? "--desktop-only" : null,
].filter((f): f is string => f !== null);
if (onlyFlags.length > 1) {
  console.error(
    `Error: ${onlyFlags.join(" and ")} are mutually exclusive. Pick one, or omit all to run every platform.`,
  );
  process.exit(1);
}

if (resumeMode && freshMode) {
  console.error("Error: --fresh and --resume cannot be combined.");
  process.exit(1);
}

if (freshMode && existsSync(PROGRESS_FILE)) {
  unlinkSync(PROGRESS_FILE);
  console.log("Cleared previous progress file (--fresh)");
}
const componentArg = args.find(a => a.startsWith("--component="));
const specificComponents = componentArg
  ? componentArg.split("=")[1].split(",").map(c => c.trim().toLowerCase())
  : null;
const timeoutArg = args.find(a => a.startsWith("--timeout="));
const SCREENSHOT_TIMEOUT = timeoutArg ? parseInt(timeoutArg.split("=")[1]) : DEFAULT_TIMEOUT;
const visibleMode = args.includes("--visible");
const dumpHtml = args.includes("--dump-html");

// Native device baselines. CLI values take precedence over environment values.
// Comparison normalization is intentionally not changed here; its stale native
// dimensions are handled separately from deterministic capture configuration.
const IOS_SIMULATOR_NAME = runIOS
  ? optionValue(args, "ios-simulator", process.env.HYPEN_IOS_SIMULATOR, "iPhone 17 Pro Max")
  : "iPhone 17 Pro Max";
const iosUdidArg = runIOS ? args.find(value => value.startsWith("--ios-udid=")) : undefined;
const IOS_SIMULATOR_UDID = runIOS
  ? iosUdidArg?.slice("--ios-udid=".length).trim() || process.env.HYPEN_IOS_UDID?.trim() || undefined
  : undefined;
const IOS_SCREENSHOT_WIDTH = runIOS
  ? integerOption(args, "ios-width", process.env.HYPEN_IOS_WIDTH, 1320) : 1320;
const IOS_SCREENSHOT_HEIGHT = runIOS
  ? integerOption(args, "ios-height", process.env.HYPEN_IOS_HEIGHT, 2868) : 2868;

const ANDROID_AVD = runAndroid
  ? optionValue(args, "android-avd", process.env.HYPEN_ANDROID_AVD, "Pixel_8")
  : "Pixel_8";
const androidSerialArg = runAndroid
  ? args.find(value => value.startsWith("--android-serial=")) : undefined;
const ANDROID_CONFIGURED_SERIAL = runAndroid
  ? androidSerialArg?.slice("--android-serial=".length).trim()
    || process.env.HYPEN_ANDROID_SERIAL?.trim()
    || undefined
  : undefined;
const ANDROID_API = runAndroid
  ? integerOption(args, "android-api", process.env.HYPEN_ANDROID_API, 34) : 34;
const ANDROID_SCREENSHOT_WIDTH = runAndroid
  ? integerOption(args, "android-width", process.env.HYPEN_ANDROID_WIDTH, 1080) : 1080;
const ANDROID_SCREENSHOT_HEIGHT = runAndroid
  ? integerOption(args, "android-height", process.env.HYPEN_ANDROID_HEIGHT, 2400) : 2400;
const ANDROID_DENSITY = runAndroid
  ? integerOption(args, "android-density", process.env.HYPEN_ANDROID_DENSITY, 420) : 420;

let iosSimulator: IOSSimulator | null = null;
let androidDevice: AndroidDevice | null = null;
let androidTargetSerial = ANDROID_CONFIGURED_SERIAL;

// Progress tracking
interface ProgressData {
  completed: { [key: string]: string[] }; // item -> platforms completed
  failed: { item: string; platform: string; error: string }[];
  startedAt: string;
  lastUpdated: string;
}

function loadProgress(): ProgressData {
  if (existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    } catch {
      // Corrupted file, start fresh
    }
  }
  return {
    completed: {},
    failed: [],
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveProgress(progress: ProgressData): void {
  progress.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function markCompleted(progress: ProgressData, item: string, platform: string): void {
  if (!progress.completed[item]) {
    progress.completed[item] = [];
  }
  if (!progress.completed[item].includes(platform)) {
    progress.completed[item].push(platform);
  }
  saveProgress(progress);
}

function markFailed(progress: ProgressData, item: string, platform: string, error: string): void {
  progress.failed.push({ item, platform, error });
  saveProgress(progress);
}

function isCompleted(progress: ProgressData, item: string, platform: string): boolean {
  return progress.completed[item]?.includes(platform) ?? false;
}

// Load test items
interface TestItem {
  name: string;
  deeplink: string;
}

function loadTestItems(): TestItem[] {
  const componentsPath = join(ROOT_DIR, "components.json");
  const applicatorsPath = join(ROOT_DIR, "applicators.json");

  const components: TestItem[] = JSON.parse(readFileSync(componentsPath, "utf-8"));
  const applicators: TestItem[] = JSON.parse(readFileSync(applicatorsPath, "utf-8"));

  let items = [...components, ...applicators];

  if (specificComponents) {
    items = items.filter(
      i => specificComponents.includes(i.deeplink.toLowerCase()) ||
           specificComponents.includes(i.name.toLowerCase())
    );
    if (items.length === 0) {
      console.error(`No components found matching: ${specificComponents.join(", ")}`);
      process.exit(1);
    }
  }

  return items;
}

// Utility functions
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timeoutId: Timer;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${operation}`)), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
}

async function portOwnerDetails(port: number): Promise<string> {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const output = result.stdout.toString().trim();
  return output || `PID unavailable. Inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function validateScreenshotDimensions(
  path: string,
  platform: string,
  expectedWidth: number,
  expectedHeight: number,
): void {
  if (!existsSync(path)) throw new Error(`${platform} screenshot was not created at ${path}.`);
  const actual = parsePngDimensions(readFileSync(path));
  if (actual.width !== expectedWidth || actual.height !== expectedHeight) {
    throw new Error(
      `${platform} screenshot is ${actual.width}x${actual.height}, expected ` +
      `${expectedWidth}x${expectedHeight}. Use the configured device or update the corresponding ` +
      `--${platform.toLowerCase()}-width/--${platform.toLowerCase()}-height values intentionally.`,
    );
  }
}

// Platform-specific functions
async function startComponentServer(): Promise<void> {
  const healthUrl = `http://127.0.0.1:${COMPONENT_SERVER_PORT}/api/readiness?platform=probe&example=probe`;
  if (skipServer) {
    if (!await probeComponentGallery(healthUrl)) {
      throw new Error(
        `--skip-server was requested, but no compatible component gallery passed its ` +
        `readiness health check on port ${COMPONENT_SERVER_PORT}.`,
      );
    }
    console.log("Using healthy component gallery server (--skip-server)");
    return;
  }

  const result = await ensureServerLifecycle({
    label: "component gallery server",
    port: COMPONENT_SERVER_PORT,
    probe: () => probeComponentGallery(healthUrl),
    portOccupied: () => isPortInUse(COMPONENT_SERVER_PORT),
    ownerDetails: () => portOwnerDetails(COMPONENT_SERVER_PORT),
    spawn: () => {
      console.log("Starting component gallery server...");
      const proc = Bun.spawn(["bun", "run", "server.ts"], {
        cwd: ROOT_DIR,
        stdout: "ignore",
        stderr: "ignore",
      });
      spawnedProcesses.push(proc);
      return proc;
    },
  });
  console.log(result.reused ? "Using healthy component gallery server" : "Component server started and healthy");
}

async function startWebGalleryServer(): Promise<void> {
  const healthUrl = `http://127.0.0.1:${WEB_GALLERY_PORT}/health`;
  const result = await ensureServerLifecycle({
    label: "web gallery server",
    port: WEB_GALLERY_PORT,
    probe: () => probeWebGallery(healthUrl),
    portOccupied: () => isPortInUse(WEB_GALLERY_PORT),
    ownerDetails: () => portOwnerDetails(WEB_GALLERY_PORT),
    spawn: () => {
      console.log("Starting web gallery server...");
      const proc = Bun.spawn(["bun", "run", "gallery-server.ts"], {
        cwd: WEB_DIR,
        stdout: "ignore",
        stderr: "ignore",
      });
      spawnedProcesses.push(proc);
      return proc;
    },
  });
  console.log(result.reused ? "Using healthy web gallery server" : "Web gallery server started and healthy");
}

// iOS Functions
async function listIOSSimulators(): Promise<IOSSimulator[]> {
  const raw = await $`xcrun simctl list devices available -j`.text();
  const data = JSON.parse(raw) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
  };
  return Object.entries(data.devices).flatMap(([runtime, devices]) =>
    devices
      .filter(device => device.isAvailable !== false)
      .map(device => ({ ...device, runtime })),
  );
}

async function bootIOSSimulator(): Promise<void> {
  try {
    iosSimulator = selectIOSSimulator(
      await listIOSSimulators(),
      IOS_SIMULATOR_NAME,
      IOS_SIMULATOR_UDID,
    );
    if (iosSimulator.state !== "Booted") {
      console.log(`Booting iOS simulator ${iosSimulator.name} (${iosSimulator.udid})...`);
      await $`xcrun simctl boot ${iosSimulator.udid}`.quiet();
    } else {
      console.log(`Using booted iOS simulator ${iosSimulator.name} (${iosSimulator.udid})`);
    }
    await $`xcrun simctl bootstatus ${iosSimulator.udid} -b`.quiet();
  } catch (error) {
    throw new Error(`Failed to prepare the configured iOS simulator: ${error}`);
  }
}

async function validateIOSSimulator(): Promise<void> {
  const selected = requireIOSSimulator();
  const current = (await listIOSSimulators()).find(item => item.udid === selected.udid);
  if (!current || current.state !== "Booted" || current.name !== IOS_SIMULATOR_NAME) {
    throw new Error(
      `Configured iOS simulator ${selected.udid} is no longer booted with the expected identity ` +
      `${JSON.stringify(IOS_SIMULATOR_NAME)}.`,
    );
  }
  const checkPath = join(RESULTS_DIR, ".device-check-ios.png");
  try {
    await $`xcrun simctl io ${selected.udid} screenshot ${checkPath}`.quiet();
    validateScreenshotDimensions(checkPath, "iOS", IOS_SCREENSHOT_WIDTH, IOS_SCREENSHOT_HEIGHT);
  } finally {
    if (existsSync(checkPath)) unlinkSync(checkPath);
  }
  console.log(
    `Validated iOS device: ${selected.name}, ${IOS_SCREENSHOT_WIDTH}x${IOS_SCREENSHOT_HEIGHT}`,
  );
}

function requireIOSSimulator(): IOSSimulator {
  if (!iosSimulator) throw new Error("iOS simulator was not prepared.");
  return iosSimulator;
}

async function installIOSApp(): Promise<void> {
  if (skipInstall) {
    console.log("Skipping iOS install (--skip-install)");
    return;
  }

  console.log("Building and installing iOS app...");
  try {
    const projectDir = join(SWIFT_DIR, "Gallery", "HypenGallery");
    const scheme = "HypenGallery";
    const bundleId = IOS_GALLERY_BUNDLE_ID;

    const simId = requireIOSSimulator().udid;

    // Build the app
    console.log("  Building...");
    await $`xcodebuild -project ${projectDir}/HypenGallery.xcodeproj \
      -scheme ${scheme} \
      -destination id=${simId} \
      -derivedDataPath ${projectDir}/DerivedData \
      build`.quiet();

    // Find the built app (exclude Index.noindex which is Xcode's cache)
    const findResult = await $`find ${projectDir}/DerivedData/Build/Products -name "HypenGallery.app" -type d | grep -E "Debug-iphonesimulator" | head -1`.text();
    const appPath = findResult.trim();

    if (!appPath) {
      throw new Error("Could not find built app");
    }

    // Install the app (don't launch with --console-pty)
    console.log("  Installing...");
    await $`xcrun simctl install ${simId} "${appPath}"`.quiet();

    // Launch the app without --console-pty (detached)
    console.log("  Launching...");
    await $`xcrun simctl launch ${simId} ${bundleId}`.quiet();

    console.log("iOS app installed and launched");
  } catch (error) {
    console.error("Failed to install iOS app:", error);
    throw error;
  }
}

async function iosLaunchGalleryItem(name: string): Promise<void> {
  const command = iosGalleryLaunchCommand(
    requireIOSSimulator().udid,
    IOS_GALLERY_BUNDLE_ID,
    name,
  );
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Failed to launch iOS gallery item ${JSON.stringify(name)} (exit ${exitCode}): ` +
      `${stderr.trim() || stdout.trim() || "no simctl output"}`,
    );
  }
}

async function iosScreenshot(filename: string): Promise<void> {
  const outputPath = join(RESULTS_DIR, filename);
  await $`xcrun simctl io ${requireIOSSimulator().udid} screenshot ${outputPath}`.quiet();
  validateScreenshotDimensions(outputPath, "iOS", IOS_SCREENSHOT_WIDTH, IOS_SCREENSHOT_HEIGHT);
}

async function captureIOSProbe(path: string): Promise<void> {
  await $`xcrun simctl io ${requireIOSSimulator().udid} screenshot ${path}`.quiet();
}

// Android Functions
async function listAndroidDevices(
  options: { allowTransientShellErrors?: boolean } = {},
): Promise<AndroidDevice[]> {
  const raw = await $`adb devices`.text();
  const rows = raw.split("\n").slice(1).map(line => line.trim()).filter(Boolean);
  return Promise.all(rows.map(row => {
    const [serial, state] = row.split(/\s+/, 2);
    return probeAndroidDevice(
      serial,
      state,
      name => $`adb -s ${serial} shell getprop ${name}`.text(),
      options,
    );
  }));
}

function findAndroidEmulator(): string {
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  const candidates = [
    sdkRoot ? join(sdkRoot, "emulator", "emulator") : null,
    Bun.which("emulator"),
  ].filter((item): item is string => Boolean(item));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error("Android emulator executable not found. Set ANDROID_SDK_ROOT or add emulator to PATH.");
  }
  return executable;
}

interface LaunchedAndroidEmulator {
  process: import("bun").Subprocess;
  outputTail: Promise<string>;
}

async function captureProcessTail(
  stream: ReadableStream<Uint8Array>,
  maxCharacters = 8000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = (tail + decoder.decode(value, { stream: true })).slice(-maxCharacters);
  }
  return (tail + decoder.decode()).slice(-maxCharacters);
}

async function throwIfAndroidEmulatorExited(
  launched: LaunchedAndroidEmulator | undefined,
): Promise<void> {
  if (!launched || launched.process.exitCode === null) return;
  const output = (await launched.outputTail).trim();
  throw new Error(
    `Android emulator process exited ${launched.process.exitCode} before ${androidTargetSerial} booted.` +
    (output ? ` Recent emulator output:\n${output}` : " No emulator output was captured."),
  );
}

async function waitForConfiguredAndroidDevice(
  launched?: LaunchedAndroidEmulator,
  timeout = 120000,
): Promise<AndroidDevice> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await throwIfAndroidEmulatorExited(launched);
    const selected = selectAndroidDevice(
      await listAndroidDevices({ allowTransientShellErrors: true }),
      ANDROID_AVD,
      androidTargetSerial,
      { allowPendingTarget: true },
    );
    if (selected) {
      try {
        const booted = (await $`adb -s ${selected.serial} shell getprop sys.boot_completed`.text()).trim();
        if (booted === "1") return selected;
      } catch {
        // ADB can transiently report `device` while shell services are still offline.
        // Identity already matched; keep polling until the boot property is readable.
      }
    }
    await throwIfAndroidEmulatorExited(launched);
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for AVD ${JSON.stringify(ANDROID_AVD)}` +
    (androidTargetSerial ? ` on ${androidTargetSerial}` : "") + ".",
  );
}

async function allocateAndroidConsolePort(devices: AndroidDevice[]): Promise<number> {
  const occupiedConsolePorts = devices
    .map(device => androidConsolePortFromSerial(device.serial))
    .filter((port): port is number => port !== null);
  const preferredPort = ANDROID_CONFIGURED_SERIAL
    ? androidConsolePortFromSerial(ANDROID_CONFIGURED_SERIAL)
    : undefined;
  if (ANDROID_CONFIGURED_SERIAL && preferredPort === null) {
    throw new Error(
      `Cannot launch AVD ${JSON.stringify(ANDROID_AVD)} as ${JSON.stringify(ANDROID_CONFIGURED_SERIAL)}. ` +
      `A launch serial must have the form emulator-<even console port>.`,
    );
  }

  const unavailableTcpPorts = new Set<number>();
  while (true) {
    const port = selectAndroidConsolePort(
      occupiedConsolePorts,
      unavailableTcpPorts,
      [WEB_GALLERY_PORT, COMPONENT_SERVER_PORT],
      preferredPort ?? undefined,
    );
    const [consoleOccupied, adbOccupied] = await Promise.all([
      isPortInUse(port),
      isPortInUse(port + 1),
    ]);
    if (!consoleOccupied && !adbOccupied) return port;
    if (consoleOccupied) unavailableTcpPorts.add(port);
    if (adbOccupied) unavailableTcpPorts.add(port + 1);
  }
}

async function startAndroidEmulator(): Promise<void> {
  try {
    const connectedDevices = await listAndroidDevices();
    androidDevice = selectAndroidDevice(
      connectedDevices, ANDROID_AVD, androidTargetSerial,
    );
    if (!androidDevice) {
      const emulator = findAndroidEmulator();
      const avds = (await $`${emulator} -list-avds`.text()).split("\n").map(item => item.trim());
      if (!avds.includes(ANDROID_AVD)) {
        throw new Error(
          `Configured Android AVD ${JSON.stringify(ANDROID_AVD)} is not installed. ` +
          `Available AVDs: ${avds.filter(Boolean).join(", ") || "none"}. ` +
          `Create it or set --android-avd/HYPEN_ANDROID_AVD.`,
        );
      }
      const port = await allocateAndroidConsolePort(connectedDevices);
      androidTargetSerial = `emulator-${port}`;
      console.log(`Starting Android AVD ${ANDROID_AVD} as ${androidTargetSerial}...`);
      const command = [
        emulator,
        "-avd", ANDROID_AVD,
        "-port", String(port),
        "-no-audio",
        "-no-boot-anim",
      ];
      const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      spawnedProcesses.push(proc);
      const outputTail = Promise.all([
        captureProcessTail(proc.stdout),
        captureProcessTail(proc.stderr),
      ]).then(([stdout, stderr]) => [
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ].filter(Boolean).join("\n"));
      const launched = { process: proc, outputTail };
      androidDevice = await waitForConfiguredAndroidDevice(launched);
    }
    console.log(
      `Using Android AVD ${ANDROID_AVD} (${androidDevice.serial}, ${androidDevice.model ?? "unknown model"})`,
    );
  } catch (error) {
    throw new Error(`Failed to prepare the configured Android emulator: ${error}`);
  }
}

async function validateAndroidEmulator(): Promise<void> {
  const prepared = requireAndroidDevice();
  const selected = selectAndroidDevice(
    await listAndroidDevices(),
    ANDROID_AVD,
    prepared.serial,
  );
  if (!selected) {
    throw new Error(`Configured Android emulator ${prepared.serial} disconnected before validation.`);
  }
  const apiRaw = (await $`adb -s ${selected.serial} shell getprop ro.build.version.sdk`.text()).trim();
  const api = Number(apiRaw);
  if (api !== ANDROID_API) {
    throw new Error(
      `Android AVD ${JSON.stringify(ANDROID_AVD)} is API ${apiRaw || "unknown"}, expected API ${ANDROID_API}. ` +
      `Use the configured system image or update --android-api/HYPEN_ANDROID_API intentionally.`,
    );
  }

  const densityOutput = await $`adb -s ${selected.serial} shell wm density`.text();
  const density = parseAndroidMetric(densityOutput, "density");
  if (density !== ANDROID_DENSITY) {
    throw new Error(
      `Android AVD ${JSON.stringify(ANDROID_AVD)} density is ${density} dpi, expected ${ANDROID_DENSITY} dpi. ` +
      `Reset its display settings or update --android-density/HYPEN_ANDROID_DENSITY intentionally.`,
    );
  }

  const checkPath = join(RESULTS_DIR, ".device-check-android.png");
  try {
    await $`adb -s ${selected.serial} exec-out screencap -p > ${checkPath}`;
    validateScreenshotDimensions(
      checkPath, "Android", ANDROID_SCREENSHOT_WIDTH, ANDROID_SCREENSHOT_HEIGHT,
    );
  } finally {
    if (existsSync(checkPath)) unlinkSync(checkPath);
  }
  console.log(
    `Validated Android device: ${ANDROID_AVD}, API ${api}, ` +
    `${ANDROID_SCREENSHOT_WIDTH}x${ANDROID_SCREENSHOT_HEIGHT} @ ${density} dpi`,
  );

}

function requireAndroidDevice(): AndroidDevice {
  if (!androidDevice) throw new Error("Android emulator was not prepared.");
  return androidDevice;
}

async function installAndroidApp(): Promise<void> {
  if (skipInstall) {
    console.log("Skipping Android install (--skip-install)");
    return;
  }

  console.log("Installing Android app...");
  try {
    const proc = Bun.spawn([join(ANDROID_DIR, "run_on_sim.sh")], {
      cwd: ANDROID_DIR,
      stdout: "ignore",
      stderr: "pipe",
      env: androidEnvironmentForDevice(process.env, requireAndroidDevice().serial),
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Android install script exited ${exitCode}: ${stderr.trim()}`);
    }
    console.log("Android app installed");
  } catch (error) {
    console.error("Failed to install Android app:", error);
    throw error;
  }
}

async function androidDeepLink(name: string): Promise<void> {
  const command = androidGalleryLaunchCommand(
    requireAndroidDevice().serial,
    ANDROID_GALLERY_PACKAGE_ID,
    ANDROID_GALLERY_ACTIVITY,
    name,
  );
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Failed to launch Android gallery item ${JSON.stringify(name)} (exit ${exitCode}): ` +
      `${stderr.trim() || stdout.trim() || "no adb output"}`,
    );
  }
}

async function androidScreenshot(filename: string): Promise<void> {
  const outputPath = join(RESULTS_DIR, filename);
  await $`adb -s ${requireAndroidDevice().serial} exec-out screencap -p > ${outputPath}`;
  validateScreenshotDimensions(
    outputPath, "Android", ANDROID_SCREENSHOT_WIDTH, ANDROID_SCREENSHOT_HEIGHT,
  );
}

async function captureAndroidProbe(path: string): Promise<void> {
  await $`adb -s ${requireAndroidDevice().serial} exec-out screencap -p > ${path}`;
}

async function waitForNativeGallery(
  platform: "ios" | "android",
  example: string,
  openDeepLink: () => Promise<void>,
  captureProbe: (path: string) => Promise<void>,
): Promise<void> {
  const stagePrefix = `${platform}/${example}`;
  const before = await captureStage(`${stagePrefix} initial readiness probe`, () =>
    withTimeout(
      fetchGalleryReadiness(COMPONENT_SERVER_PORT, platform, example),
      SCREENSHOT_TIMEOUT,
      `${stagePrefix} initial readiness probe`,
    )
  );
  await captureStage(`${stagePrefix} launch`, () =>
    withTimeout(openDeepLink(), SCREENSHOT_TIMEOUT, `${stagePrefix} launch`)
  );
  await captureStage(`${stagePrefix} readiness`, () =>
    waitForGalleryReadiness(
      COMPONENT_SERVER_PORT,
      platform,
      example,
      before.generation,
      SCREENSHOT_TIMEOUT,
    )
  );

  // Server readiness proves that a fresh client received its tree and assets,
  // not that SwiftUI/Compose has committed that tree to the screen. Always
  // cross a visual settle barrier so fixture-free pages cannot be captured on
  // their loading view and route transitions cannot preserve the old page.
  const probePath = join(RESULTS_DIR, `.readiness-${platform}.png`);
  try {
    await captureStage(`${stagePrefix} visual stability`, () =>
      waitForVisualStability(
        captureProbe,
        probePath,
        SCREENSHOT_TIMEOUT,
        nativeGalleryStabilityOptions(example),
      )
    );
  } finally {
    if (existsSync(probePath)) unlinkSync(probePath);
  }
}

// Web Functions
function detectChrome(): string | null {
  const chromePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  for (const p of chromePaths) {
    if (existsSync(p)) return p;
  }

  // Try PATH
  try {
    const result = Bun.spawnSync(["which", "google-chrome"]);
    if (result.exitCode === 0) return result.stdout.toString().trim();
  } catch {}

  try {
    const result = Bun.spawnSync(["which", "chromium"]);
    if (result.exitCode === 0) return result.stdout.toString().trim();
  } catch {}

  return null;
}

async function browserScreenshot(
  platform: "web" | "canvas",
  name: string,
  filename: string,
): Promise<void> {
  const rendererQuery = platform === "canvas" ? "&renderer=canvas" : "";
  const url = `http://localhost:${WEB_GALLERY_PORT}?name=${name}${rendererQuery}`;
  const outputPath = join(RESULTS_DIR, filename);

  const { page } = await getSharedBrowser(platform);

  const before = await fetchGalleryReadiness(COMPONENT_SERVER_PORT, platform, name);

  await page.goto(url, { waitUntil: "networkidle0", timeout: 8000 });
  await waitForGalleryReadiness(
    COMPONENT_SERVER_PORT,
    platform,
    name,
    before.generation,
    SCREENSHOT_TIMEOUT,
  );
  await page.waitForFunction(
    () => {
      const loading = document.getElementById("loading");
      const contentReady = loading?.classList.contains("hidden") || loading?.style.display === "none";
      return contentReady;
    },
    { timeout: SCREENSHOT_TIMEOUT },
  );
  await waitForBrowserPaint();

  if (platform === "web") {
    await page.waitForFunction(
      () => [...document.images].every(image => image.complete && image.naturalWidth > 0),
      { timeout: SCREENSHOT_TIMEOUT },
    );
  } else {
    // Readiness does not return until every local fixture request has reached
    // the server. Give the Canvas renderer one bounded decode/layout window,
    // then capture once. Repeated compositor/toDataURL probes can starve on
    // continuously repainting controls such as Audio and image-heavy Avatar.
    await waitForBrowserPaint(750);
    await page.evaluate(() => {
      const galleryWindow = window as typeof window & {
        __hypenFreezeCanvasForScreenshot?: () => void;
      };
      if (!galleryWindow.__hypenFreezeCanvasForScreenshot) {
        throw new Error("Canvas gallery capture hook was not installed");
      }
      galleryWindow.__hypenFreezeCanvasForScreenshot();
    });
  }

  // Optionally dump HTML for debugging (use --dump-html flag)
  if (dumpHtml) {
    const htmlPath = outputPath.replace('.png', '.html');
    const html = await page.evaluate(() => {
      const app = document.querySelector("#app.active, #canvas-app.active");
      return app ? app.outerHTML : document.body.innerHTML;
    });
    writeFileSync(htmlPath, html);
  }

  await page.screenshot({ path: outputPath, fullPage: false });

  if (!existsSync(outputPath)) {
    throw new Error("Screenshot file was not created");
  }
  validateScreenshotDimensions(outputPath, platform === "web" ? "Web" : "Canvas", 430, 934);
}

async function buildDesktopGalleryScreenshot(): Promise<void> {
  console.log("Building Desktop gallery screenshot client...");
  const proc = Bun.spawn(
    ["cargo", "build", "-p", "hypen-renderer-desktop", "--example", "gallery_screenshot"],
    { cwd: WORKSPACE_DIR, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 || !existsSync(DESKTOP_SCREENSHOT_BINARY)) {
    throw new Error(
      `Desktop gallery screenshot build failed (${exitCode}): ` +
      `${stderr.trim() || stdout.trim() || "binary was not created"}`,
    );
  }
  console.log("Desktop gallery screenshot client built");
}

async function desktopScreenshot(name: string, filename: string): Promise<void> {
  const outputPath = join(RESULTS_DIR, filename);
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const url = `ws://127.0.0.1:${COMPONENT_SERVER_PORT}/${name}?platform=desktop`;
  const proc = Bun.spawn([DESKTOP_SCREENSHOT_BINARY, url, outputPath], {
    cwd: WORKSPACE_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HYPEN_REDUCED_MOTION: "1" },
  });
  spawnedProcesses.push(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    withTimeout(
      proc.exited,
      SCREENSHOT_TIMEOUT + 15_000,
      `Desktop renderer for ${name}`,
    ),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Desktop renderer exited ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}`,
    );
  }
  validateScreenshotDimensions(outputPath, "Desktop", 430, 934);
}

// Main test runner
async function runTests(): Promise<void> {
  console.log("\n========================================");
  console.log("  Hypen Component Gallery Screenshot Tests");
  console.log("========================================\n");

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const items = loadTestItems();
  console.log(`Testing ${items.length} items\n`);

  if (!runIOS && !runAndroid && !runWeb && !runCanvas && !runDesktop) {
    console.error("Error: No platforms selected — all five are skipped or filtered out.");
    process.exit(1);
  }

  // Start component server
  await startComponentServer();

  // Platform setup (in parallel where possible)
  const setupPromises: Promise<void>[] = [];

  if (runIOS) {
    setupPromises.push(
      (async () => {
        await bootIOSSimulator();
        await validateIOSSimulator();
        await installIOSApp();
      })()
    );
  }

  if (runAndroid) {
    setupPromises.push(
      (async () => {
        await startAndroidEmulator();
        await validateAndroidEmulator();
        await installAndroidApp();
      })()
    );
  }

  if (runWeb || runCanvas) {
    setupPromises.push(startWebGalleryServer());
  }

  if (runDesktop) {
    setupPromises.push(buildDesktopGalleryScreenshot());
  }

  console.log("\nSetting up platforms...");
  await Promise.all(setupPromises);
  console.log("Platform setup complete\n");

  // Load or create progress
  const progress = resumeMode ? loadProgress() : {
    completed: {},
    failed: [],
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  if (resumeMode) {
    const completedCount = Object.values(progress.completed).flat().length;
    console.log(`Resuming from previous run (${completedCount} already completed)`);
  }

  // Save initial progress
  saveProgress(progress);

  // Run tests
  const results: { item: string; platform: string; success: boolean; error?: string }[] = [];
  let current = 0;
  const total = items.length;

  for (const item of items) {
    current++;
    console.log(`\n[${current}/${total}] Testing: ${item.name}`);

    // Run all platforms in parallel for this component
    const platformPromises: Promise<void>[] = [];

    // iOS
    if (runIOS && !(resumeMode && isCompleted(progress, item.deeplink, "ios"))) {
      platformPromises.push((async () => {
        try {
          await waitForNativeGallery(
            "ios",
            item.deeplink,
            () => iosLaunchGalleryItem(item.deeplink),
            captureIOSProbe,
          );
          await captureStage(`ios/${item.deeplink} final screenshot`, () =>
            withTimeout(
              iosScreenshot(`${item.deeplink}_ios.png`),
              SCREENSHOT_TIMEOUT,
              `ios/${item.deeplink} final screenshot`,
            )
          );
          console.log(`  iOS: OK`);
          markCompleted(progress, item.deeplink, "ios");
          results.push({ item: item.name, platform: "ios", success: true });
        } catch (error: any) {
          console.log(`  iOS: FAILED - ${error.message}`);
          markFailed(progress, item.deeplink, "ios", error.message);
          results.push({ item: item.name, platform: "ios", success: false, error: error.message });
        }
      })());
    } else if (runIOS) {
      console.log(`  iOS: SKIPPED (already done)`);
    }

    // Android
    if (runAndroid && !(resumeMode && isCompleted(progress, item.deeplink, "android"))) {
      platformPromises.push((async () => {
        try {
          await waitForNativeGallery(
            "android",
            item.deeplink,
            () => androidDeepLink(item.deeplink),
            captureAndroidProbe,
          );
          await captureStage(`android/${item.deeplink} final screenshot`, () =>
            withTimeout(
              androidScreenshot(`${item.deeplink}_android.png`),
              SCREENSHOT_TIMEOUT,
              `android/${item.deeplink} final screenshot`,
            )
          );
          console.log(`  Android: OK`);
          markCompleted(progress, item.deeplink, "android");
          results.push({ item: item.name, platform: "android", success: true });
        } catch (error: any) {
          console.log(`  Android: FAILED - ${error.message}`);
          markFailed(progress, item.deeplink, "android", error.message);
          results.push({ item: item.name, platform: "android", success: false, error: error.message });
        }
      })());
    } else if (runAndroid) {
      console.log(`  Android: SKIPPED (already done)`);
    }

    // Web
    if (runWeb && !(resumeMode && isCompleted(progress, item.deeplink, "web"))) {
      platformPromises.push((async () => {
        try {
          await withTimeout(
            browserScreenshot("web", item.deeplink, `${item.deeplink}_web.png`),
            SCREENSHOT_TIMEOUT,
            `Web screenshot for ${item.name}`
          );
          console.log(`  Web: OK`);
          markCompleted(progress, item.deeplink, "web");
          results.push({ item: item.name, platform: "web", success: true });
        } catch (error: any) {
          console.log(`  Web: FAILED - ${error.message}`);
          markFailed(progress, item.deeplink, "web", error.message);
          results.push({ item: item.name, platform: "web", success: false, error: error.message });
        }
      })());
    } else if (runWeb) {
      console.log(`  Web: SKIPPED (already done)`);
    }

    // Canvas
    if (runCanvas && !(resumeMode && isCompleted(progress, item.deeplink, "canvas"))) {
      platformPromises.push((async () => {
        try {
          await withTimeout(
            browserScreenshot("canvas", item.deeplink, `${item.deeplink}_canvas.png`),
            SCREENSHOT_TIMEOUT,
            `Canvas screenshot for ${item.name}`,
          );
          console.log(`  Canvas: OK`);
          markCompleted(progress, item.deeplink, "canvas");
          results.push({ item: item.name, platform: "canvas", success: true });
        } catch (error: any) {
          console.log(`  Canvas: FAILED - ${error.message}`);
          markFailed(progress, item.deeplink, "canvas", error.message);
          results.push({ item: item.name, platform: "canvas", success: false, error: error.message });
        }
      })());
    } else if (runCanvas) {
      console.log(`  Canvas: SKIPPED (already done)`);
    }

    // Desktop
    if (runDesktop && !(resumeMode && isCompleted(progress, item.deeplink, "desktop"))) {
      platformPromises.push((async () => {
        try {
          await desktopScreenshot(item.deeplink, `${item.deeplink}_desktop.png`);
          console.log(`  Desktop: OK`);
          markCompleted(progress, item.deeplink, "desktop");
          results.push({ item: item.name, platform: "desktop", success: true });
        } catch (error: any) {
          console.log(`  Desktop: FAILED - ${error.message}`);
          markFailed(progress, item.deeplink, "desktop", error.message);
          results.push({ item: item.name, platform: "desktop", success: false, error: error.message });
        }
      })());
    } else if (runDesktop) {
      console.log(`  Desktop: SKIPPED (already done)`);
    }

    // Wait for all platforms to complete for this component
    await Promise.all(platformPromises);
  }

  // Summary
  console.log("\n========================================");
  console.log("  Summary");
  console.log("========================================\n");

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalCompleted = Object.values(progress.completed).flat().length;

  console.log(`This run: ${results.length} tests`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`\nTotal completed (all runs): ${totalCompleted}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter(r => !r.success)) {
      console.log(`  - ${r.item} (${r.platform}): ${r.error}`);
    }
    console.log(`\nTo retry failed tests, run with --resume`);
  }

  console.log(`\nScreenshots saved to: ${RESULTS_DIR}`);
  console.log(`Progress file: ${PROGRESS_FILE}`);

  // Clear progress file if all tests passed
  if (failed === 0 && !resumeMode) {
    try {
      unlinkSync(PROGRESS_FILE);
      console.log("Progress file cleared (all tests passed)");
    } catch {}
  }

  // Cleanup spawned processes
  await cleanup();

  // Exit with error if any tests failed
  if (failed > 0) {
    process.exit(1);
  }

  process.exit(0);
}

// Ensure cleanup runs on exit
process.on("SIGINT", async () => {
  console.log("\nInterrupted, cleaning up...");
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

// Run
runTests().catch(async error => {
  console.error("Fatal error:", error);
  await cleanup();
  process.exit(1);
});
