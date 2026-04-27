#!/usr/bin/env bun
/**
 * Hypen Component Gallery Screenshot Tests
 *
 * Runs screenshot tests across iOS, Android, and Web platforms.
 *
 * Usage:
 *   bun run run-tests.ts [options]
 *
 * Options:
 *   --ios-only      Run only iOS tests
 *   --android-only  Run only Android tests
 *   --web-only      Run only Web tests
 *   --skip-ios      Skip iOS tests
 *   --skip-android  Skip Android tests
 *   --skip-web      Skip Web tests
 *   --component=X   Test specific components (comma-separated, e.g. --component=column,stack,padding)
 *   --skip-install  Skip app installation (use if already installed)
 *   --skip-server   Skip starting the component server (use if already running)
 *   --resume        Resume from last failed/incomplete test
 *   --fresh         Delete the progress file before running (force re-run)
 *   --timeout=X     Per-screenshot timeout in ms (default: 10000)
 *   --visible       Show browser window (for debugging)
 *   --dump-html     Save rendered HTML files alongside web screenshots (for debugging)
 */

import { $ } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";

// Configuration
const SCRIPT_DIR = dirname(import.meta.path);
const ROOT_DIR = join(SCRIPT_DIR, "..");
const RESULTS_DIR = join(SCRIPT_DIR, "results");
const PROGRESS_FILE = join(RESULTS_DIR, ".progress.json");
const SWIFT_DIR = join(ROOT_DIR, "..", "hypen-renderer-swift");
const ANDROID_DIR = join(ROOT_DIR, "..", "hypen-renderer-android");
const WEB_DIR = join(ROOT_DIR, "..", "hypen-web", "screenshot-testing");

const COMPONENT_SERVER_PORT = 6555;
const WEB_GALLERY_PORT = 5556;

// Deep link URLs
const IOS_DEEPLINK_PREFIX = "hypengallery://";
const ANDROID_DEEPLINK_PREFIX = "hypengallery://components?name=";

// Screenshot delay (ms) - time to wait after deep link before taking screenshot
// Needs to be long enough for WebSocket to connect and receive initial tree
const SCREENSHOT_DELAY = 3500;

// Per-screenshot timeout (ms)
const DEFAULT_TIMEOUT = 10000;

// Track spawned processes for cleanup
const spawnedProcesses: import("bun").Subprocess[] = [];

// Shared browser instance for web screenshots
let sharedBrowser: import("puppeteer").Browser | null = null;
let sharedPage: import("puppeteer").Page | null = null;

async function getSharedBrowser(): Promise<{ browser: import("puppeteer").Browser; page: import("puppeteer").Page }> {
  if (!sharedBrowser || !sharedPage) {
    const puppeteer = await import("puppeteer");
    sharedBrowser = await puppeteer.default.launch({
      headless: !visibleMode,  // Use --visible flag to see browser
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    sharedPage = await sharedBrowser.newPage();
    await sharedPage.setViewport({
      width: 430,
      height: 934,
      deviceScaleFactor: 1,
    });
  }
  return { browser: sharedBrowser, page: sharedPage };
}

async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {}
    sharedBrowser = null;
    sharedPage = null;
  }
}

function cleanup(): void {
  for (const proc of spawnedProcesses) {
    try {
      proc.kill();
    } catch {}
  }
  // Close shared browser (fire and forget)
  closeSharedBrowser().catch(() => {});
}

// Parse command line arguments
const args = process.argv.slice(2);
const iosOnly = args.includes("--ios-only");
const androidOnly = args.includes("--android-only");
const webOnly = args.includes("--web-only");
const skipIos = args.includes("--skip-ios");
const skipAndroid = args.includes("--skip-android");
const skipWeb = args.includes("--skip-web");
const skipInstall = args.includes("--skip-install");
const skipServer = args.includes("--skip-server");
const resumeMode = args.includes("--resume");
const freshMode = args.includes("--fresh");

// --*-only flags are mutually exclusive — passing more than one sets all
// platform toggles to false and silently runs 0 tests.
const onlyFlags = [
  iosOnly ? "--ios-only" : null,
  androidOnly ? "--android-only" : null,
  webOnly ? "--web-only" : null,
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
  try {
    await $`lsof -i :${port}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isPortInUse(port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

// Platform-specific functions
async function startComponentServer(): Promise<void> {
  if (skipServer) {
    console.log("Skipping server start (--skip-server)");
    return;
  }

  if (await isPortInUse(COMPONENT_SERVER_PORT)) {
    console.log(`Component server already running on port ${COMPONENT_SERVER_PORT}`);
    return;
  }

  console.log("Starting component gallery server...");
  const proc = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: ROOT_DIR,
    stdout: "ignore",
    stderr: "ignore",
  });
  spawnedProcesses.push(proc);

  if (await waitForPort(COMPONENT_SERVER_PORT)) {
    console.log("Component server started");
  } else {
    throw new Error("Failed to start component server");
  }
}

async function startWebGalleryServer(): Promise<void> {
  if (await isPortInUse(WEB_GALLERY_PORT)) {
    console.log(`Web gallery server already running on port ${WEB_GALLERY_PORT}`);
    return;
  }

  console.log("Starting web gallery server...");
  const proc = Bun.spawn(["bun", "run", "gallery-server.ts"], {
    cwd: WEB_DIR,
    stdout: "ignore",
    stderr: "ignore",
  });
  spawnedProcesses.push(proc);

  if (await waitForPort(WEB_GALLERY_PORT)) {
    console.log("Web gallery server started");
  } else {
    throw new Error("Failed to start web gallery server");
  }
}

// iOS Functions
async function getBootedSimulator(): Promise<string | null> {
  try {
    const result = await $`xcrun simctl list devices available | grep "Booted"`.text();
    const match = result.match(/([A-F0-9-]{36})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function bootIOSSimulator(): Promise<string> {
  let simId = await getBootedSimulator();
  if (simId) {
    console.log(`iOS Simulator already booted: ${simId}`);
    return simId;
  }

  console.log("Booting iOS Simulator...");
  try {
    const devices = await $`xcrun simctl list devices available | grep "iPhone"`.text();
    const match = devices.match(/([A-F0-9-]{36})/);
    if (!match) {
      throw new Error("No iPhone simulator found");
    }
    simId = match[1];
    await $`xcrun simctl boot ${simId}`.quiet();
    await sleep(5000); // Wait for boot
    console.log(`iOS Simulator booted: ${simId}`);
    return simId;
  } catch (error) {
    throw new Error(`Failed to boot iOS simulator: ${error}`);
  }
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
    const bundleId = "space.hypen.gallery.HypenGallery";

    // Get simulator ID
    const simId = await getBootedSimulator();
    if (!simId) {
      throw new Error("No booted iOS simulator found");
    }

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

async function iosDeepLink(name: string): Promise<void> {
  const url = `${IOS_DEEPLINK_PREFIX}${name}`;
  await $`xcrun simctl openurl booted "${url}"`.quiet();
}

async function iosScreenshot(filename: string): Promise<void> {
  const outputPath = join(RESULTS_DIR, filename);
  await $`xcrun simctl io booted screenshot "${outputPath}"`.quiet();
}

// Android Functions
async function isAndroidDeviceConnected(): Promise<boolean> {
  try {
    const result = await $`adb devices`.text();
    const lines = result.split("\n").filter(l => l.includes("device") && !l.includes("List"));
    return lines.length > 0;
  } catch {
    return false;
  }
}

async function startAndroidEmulator(): Promise<void> {
  if (await isAndroidDeviceConnected()) {
    console.log("Android device/emulator already connected");
    return;
  }

  console.log("Starting Android emulator...");
  try {
    // List available emulators and start the first one
    const emulators = await $`emulator -list-avds`.text();
    const avdName = emulators.trim().split("\n")[0];
    if (!avdName) {
      throw new Error("No Android AVD found. Create one with Android Studio.");
    }

    const proc = Bun.spawn(["emulator", "-avd", avdName, "-no-audio", "-no-boot-anim"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnedProcesses.push(proc);

    // Wait for device to be ready
    console.log(`Waiting for emulator "${avdName}" to boot...`);
    await $`adb wait-for-device`.quiet();
    await sleep(10000); // Extra time for full boot
    console.log("Android emulator ready");
  } catch (error) {
    throw new Error(`Failed to start Android emulator: ${error}`);
  }
}

async function installAndroidApp(): Promise<void> {
  if (skipInstall) {
    console.log("Skipping Android install (--skip-install)");
    return;
  }

  console.log("Installing Android app...");
  try {
    await $`${ANDROID_DIR}/run_on_sim.sh`.quiet();
    console.log("Android app installed");
  } catch (error) {
    console.error("Failed to install Android app:", error);
    throw error;
  }
}

async function androidDeepLink(name: string): Promise<void> {
  const url = `${ANDROID_DEEPLINK_PREFIX}${name}`;
  await $`adb shell am start -a android.intent.action.VIEW -d "${url}"`.quiet();
}

async function androidScreenshot(filename: string): Promise<void> {
  const outputPath = join(RESULTS_DIR, filename);
  await $`adb exec-out screencap -p > "${outputPath}"`;
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

async function webScreenshot(name: string, filename: string): Promise<void> {
  const url = `http://localhost:${WEB_GALLERY_PORT}?name=${name}`;
  const outputPath = join(RESULTS_DIR, filename);

  const { page } = await getSharedBrowser();

  // Navigate and wait for the loading spinner to disappear
  await page.goto(url, { waitUntil: "networkidle0", timeout: 8000 });

  // Wait for the loading element to be hidden (indicating content has loaded)
  await page.waitForFunction(
    () => {
      const loading = document.getElementById("loading");
      return loading?.classList.contains("hidden") || loading?.style.display === "none";
    },
    { timeout: 5000 }
  ).catch(() => {
    // If loading never hides, content might be direct - continue anyway
  });

  // Wait for WebSocket data and CSS transitions
  await new Promise(r => setTimeout(r, 1500));

  // Optionally dump HTML for debugging (use --dump-html flag)
  if (dumpHtml) {
    const htmlPath = outputPath.replace('.png', '.html');
    const html = await page.evaluate(() => {
      const app = document.getElementById("app");
      return app ? app.innerHTML : document.body.innerHTML;
    });
    writeFileSync(htmlPath, html);
  }

  // Take screenshot
  await page.screenshot({ path: outputPath, fullPage: false });

  if (!existsSync(outputPath)) {
    throw new Error("Screenshot file was not created");
  }
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

  // Determine which platforms to test
  const runIOS = !androidOnly && !webOnly && !skipIos;
  const runAndroid = !iosOnly && !webOnly && !skipAndroid;
  const runWeb = !iosOnly && !androidOnly && !skipWeb;

  if (!runIOS && !runAndroid && !runWeb) {
    console.error("Error: No platforms selected — all three are skipped or filtered out.");
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
        await installIOSApp();
      })()
    );
  }

  if (runAndroid) {
    setupPromises.push(
      (async () => {
        await startAndroidEmulator();
        await installAndroidApp();
      })()
    );
  }

  if (runWeb) {
    setupPromises.push(startWebGalleryServer());
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
          await withTimeout(
            (async () => {
              await iosDeepLink(item.deeplink);
              await sleep(SCREENSHOT_DELAY);
              await iosScreenshot(`${item.deeplink}_ios.png`);
            })(),
            SCREENSHOT_TIMEOUT,
            `iOS screenshot for ${item.name}`
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
          await withTimeout(
            (async () => {
              await androidDeepLink(item.deeplink);
              await sleep(SCREENSHOT_DELAY);
              await androidScreenshot(`${item.deeplink}_android.png`);
            })(),
            SCREENSHOT_TIMEOUT,
            `Android screenshot for ${item.name}`
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
            webScreenshot(item.deeplink, `${item.deeplink}_web.png`),
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
  cleanup();

  // Exit with error if any tests failed
  if (failed > 0) {
    process.exit(1);
  }
}

// Ensure cleanup runs on exit
process.on("SIGINT", () => {
  console.log("\nInterrupted, cleaning up...");
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// Run
runTests().catch(error => {
  console.error("Fatal error:", error);
  cleanup();
  process.exit(1);
});
