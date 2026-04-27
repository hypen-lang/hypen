/**
 * Non-interactive "install Hypen Runner on device and launch" helpers.
 *
 * The interactive `hypen run <platform>` command in ../run.ts prompts the
 * user for a device. Studio knows the device up-front (the user picked it
 * in Test Mode), so we skip the prompt and reuse the download / install /
 * deep-link pieces directly.
 */

import {
  ensureAndroidRunner,
  ensureIOSRunner,
  exec,
  getServerUrl,
  listAndroidDevices as listAdbDevices,
  listIOSSimulators,
  RUNNER_PATHS,
} from "../run.js";

export interface RunResult {
  ok: boolean;
  deepLink?: string;
  wsUrl?: string;
  error?: string;
}

/**
 * Normalise any user-supplied origin (bare host:port, http://, etc.) to
 * a WebSocket URL. Android emulators can't reach the host's loopback
 * interface, so localhost / 127.0.0.1 is rewritten to 10.0.2.2 when
 * targeting an emulator.
 */
export function normaliseRunUrl(
  raw: string,
  platform: "android" | "ios",
  deviceType: "emulator" | "physical" | "simulator"
): string {
  let url = raw.trim();
  if (!url) return url;
  if (/^wss?:\/\//i.test(url)) {
    // already a ws URL
  } else if (/^https?:\/\//i.test(url)) {
    url = url.replace(/^http/i, "ws");
  } else {
    url = `ws://${url}`;
  }
  if (platform === "android" && deviceType === "emulator") {
    url = url.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, "//10.0.2.2");
  }
  return url;
}

/**
 * Resolve the WebSocket URL the runner app should connect to. Preference
 * order: explicit override → HYPEN_REMOTE_URL → HYPEN_STUDIO_PORT's
 * in-process engine host (`/ws/engine`) → HYPEN_DEV_PORT (legacy external
 * dev server).
 *
 * The studio-port branch is the common path: `hypen studio` boots an
 * engine host on its own port, so native runners dial back into studio
 * itself — no separate `hypen dev` process required.
 */
function resolveWsUrl(
  platform: "android" | "ios",
  deviceType: "emulator" | "physical" | "simulator",
  override?: string
): string | null {
  const pick = override?.trim() || process.env.HYPEN_REMOTE_URL?.trim() || "";
  if (pick) return normaliseRunUrl(pick, platform, deviceType);

  const studioPort = Number(process.env.HYPEN_STUDIO_PORT);
  if (Number.isFinite(studioPort) && studioPort > 0) {
    // `getServerUrl` handles localhost → 10.0.2.2 for Android emulators.
    // Append /ws/engine to hit the studio-hosted RemoteServer.
    const base = getServerUrl(platform, studioPort, deviceType);
    return `${base.replace(/\/$/, "")}/ws/engine`;
  }

  const port = Number(process.env.HYPEN_DEV_PORT);
  if (!Number.isFinite(port) || port <= 0) return null;
  return getServerUrl(platform, port, deviceType);
}

export async function installAndLaunchAndroid(deviceId: string, overrideUrl?: string): Promise<RunResult> {
  const devices = await listAdbDevices();
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return { ok: false, error: `Android device ${deviceId} not found via adb` };

  const wsUrl = resolveWsUrl("android", device.type, overrideUrl);
  if (!wsUrl) {
    return {
      ok: false,
      error: "No dev server URL. Provide one via the Test Mode URL bar, or launch studio with `hypen run android --studio`.",
    };
  }

  const hasRunner = await ensureAndroidRunner();
  if (!hasRunner) return { ok: false, error: "Could not download Android runner APK." };

  const { exitCode: installCode, stderr: installErr } = await exec([
    "adb", "-s", device.id, "install", "-r", RUNNER_PATHS.android,
  ]);
  if (installCode !== 0) return { ok: false, error: `Install failed: ${installErr.trim()}` };

  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  const { exitCode: launchCode, stderr: launchErr } = await exec([
    "adb", "-s", device.id, "shell", "am", "start",
    "-a", "android.intent.action.VIEW",
    "-d", deepLink,
  ]);
  if (launchCode !== 0) return { ok: false, error: `Launch failed: ${launchErr.trim()}` };

  return { ok: true, deepLink, wsUrl };
}

export async function installAndLaunchIOS(udid: string, overrideUrl?: string): Promise<RunResult> {
  const sims = await listIOSSimulators();
  const sim = sims.find((s) => s.udid === udid);
  if (!sim) return { ok: false, error: `iOS simulator ${udid} not found` };

  const wsUrl = resolveWsUrl("ios", "simulator", overrideUrl);
  if (!wsUrl) {
    return {
      ok: false,
      error: "No dev server URL. Provide one via the Test Mode URL bar, or launch studio with `hypen run ios --studio`.",
    };
  }

  if (sim.state !== "Booted") {
    const { exitCode, stderr } = await exec(["xcrun", "simctl", "boot", sim.udid]);
    if (exitCode !== 0 && !stderr.includes("current state: Booted")) {
      return { ok: false, error: `Boot failed: ${stderr.trim()}` };
    }
  }

  const hasRunner = await ensureIOSRunner();
  if (!hasRunner) return { ok: false, error: "Could not download iOS runner app." };

  const { exitCode: installCode, stderr: installErr } = await exec([
    "xcrun", "simctl", "install", sim.udid, RUNNER_PATHS.ios,
  ]);
  if (installCode !== 0) return { ok: false, error: `Install failed: ${installErr.trim()}` };

  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  const { exitCode: launchCode, stderr: launchErr } = await exec([
    "xcrun", "simctl", "openurl", sim.udid, deepLink,
  ]);
  if (launchCode !== 0) return { ok: false, error: `Launch failed: ${launchErr.trim()}` };

  return { ok: true, deepLink, wsUrl };
}
