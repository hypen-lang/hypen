/**
 * `hypen run` runner plumbing: device choice, adb reverse, install skip,
 * desktop runner override / launch / download guidance. No device needed —
 * adb is replaced by a fake exec.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  pickLanIP,
  selectAndroidDevice,
  selectIOSSimulator,
  launchIOSRunner,
  resolveAndroidUrl,
  parseDumpsysPackage,
  isRunnerInstallCurrent,
  installAndroidRunnerIfNeeded,
  launchDetached,
  desktopRunnerHelp,
  resolveDesktopRunnerOverride,
  isPlausibleVersion,
  RUN_HELP,
  type AndroidDevice,
} from "../src/run.js";

const emu: AndroidDevice = { id: "emulator-5554", name: "Pixel 7", type: "emulator", status: "device" };
const phone: AndroidDevice = { id: "R5CT1234", name: "Galaxy", type: "physical", status: "device" };

/** A fake `exec` that records commands and answers by prefix. */
function fakeExec(answers: Array<[RegExp, { stdout?: string; stderr?: string; exitCode?: number }]>) {
  const calls: string[] = [];
  const run = async (cmd: string[]) => {
    const line = cmd.join(" ");
    calls.push(line);
    for (const [re, a] of answers) {
      if (re.test(line)) return { stdout: a.stdout ?? "", stderr: a.stderr ?? "", exitCode: a.exitCode ?? 0 };
    }
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  return { run, calls };
}

describe("pickLanIP", () => {
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });

  test("skips loopback, link-local, docker and VPN interfaces", () => {
    expect(
      pickLanIP({
        lo: [v4("127.0.0.1", true)],
        docker0: [v4("172.17.0.1")],
        "br-1a2b": [v4("172.18.0.1")],
        tailscale0: [v4("100.101.102.103")],
        utun3: [v4("10.8.0.2")],
        eth1: [v4("169.254.10.20")],
        wlan0: [v4("192.168.1.42")],
      })
    ).toBe("192.168.1.42");
  });

  test("prefers a real NIC with a private address over other interfaces", () => {
    expect(
      pickLanIP({
        foo0: [v4("203.0.113.5")],
        en0: [v4("10.0.0.7")],
      })
    ).toBe("10.0.0.7");
  });

  test("ignores IPv6 and returns null when nothing usable is left", () => {
    expect(
      pickLanIP({
        lo: [v4("127.0.0.1", true)],
        eth0: [{ address: "fe80::1", family: "IPv6", internal: false }, v4("169.254.1.1")],
        docker0: [v4("172.17.0.1")],
      })
    ).toBeNull();
  });
});

describe("selectAndroidDevice", () => {
  test("explicit serial wins", () => {
    const r = selectAndroidDevice([emu, phone], { serial: "R5CT1234", interactive: false });
    expect(r).toEqual({ kind: "device", device: phone });
  });

  test("unknown serial is an error listing connected devices", () => {
    const r = selectAndroidDevice([emu, phone], { serial: "nope", interactive: true });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain('"nope"');
      expect(r.message).toContain("emulator-5554");
    }
  });

  test("single device is used without asking", () => {
    expect(selectAndroidDevice([emu], { interactive: false })).toEqual({ kind: "device", device: emu });
  });

  test("several devices without a TTY fail fast with a --device hint", () => {
    const r = selectAndroidDevice([emu, phone], { interactive: false });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("--device");
      expect(r.message).toContain("ANDROID_SERIAL");
      expect(r.message).toContain("R5CT1234");
    }
  });

  test("several devices on a TTY prompt", () => {
    expect(selectAndroidDevice([emu, phone], { interactive: true }).kind).toBe("prompt");
  });
});

describe("resolveAndroidUrl", () => {
  test("uses adb reverse + localhost when it works", async () => {
    const { run, calls } = fakeExec([[/reverse tcp:3000 tcp:3000/, {}]]);
    expect(await resolveAndroidUrl(phone, 3000, undefined, run)).toEqual({
      url: "ws://localhost:3000",
      via: "reverse",
    });
    expect(calls).toEqual(["adb -s R5CT1234 reverse tcp:3000 tcp:3000"]);
  });

  test("emulator falls back to 10.0.2.2 when reverse fails", async () => {
    const { run } = fakeExec([[/reverse/, { exitCode: 1 }]]);
    expect(await resolveAndroidUrl(emu, 3001, undefined, run)).toEqual({
      url: "ws://10.0.2.2:3001",
      via: "emulator-alias",
    });
  });

  test("physical device falls back to a LAN IP or 10.0.2.2", async () => {
    const { run } = fakeExec([[/reverse/, { exitCode: 1 }]]);
    const r = await resolveAndroidUrl(phone, 3002, undefined, run);
    expect(r.url).toMatch(/^ws:\/\/[\d.]+:3002$/);
  });

  test("--url on localhost is reversed on its own port", async () => {
    const { run, calls } = fakeExec([[/reverse tcp:8080/, {}]]);
    expect(await resolveAndroidUrl(phone, 3000, "ws://localhost:8080", run)).toEqual({
      url: "ws://localhost:8080",
      via: "reverse",
    });
    expect(calls[0]).toContain("tcp:8080");
  });

  test("--url on localhost without reverse becomes 10.0.2.2 on an emulator", async () => {
    const { run } = fakeExec([[/reverse/, { exitCode: 1 }]]);
    const r = await resolveAndroidUrl(emu, 3000, "ws://127.0.0.1:8080", run);
    expect(r.url).toBe("ws://10.0.2.2:8080");
  });

  test("a remote --url is passed through untouched", async () => {
    const { run, calls } = fakeExec([]);
    expect(await resolveAndroidUrl(phone, 3000, "wss://dev.example.com/ws", run)).toEqual({
      url: "wss://dev.example.com/ws",
      via: "override",
    });
    expect(calls).toEqual([]);
  });
});

describe("Android install skip", () => {
  const dumpsys = (time: string) =>
    `Packages:\n  Package [space.hypen.gallery] (abc):\n    versionCode=42 minSdk=26 targetSdk=34\n    versionName=1.22.3\n    lastUpdateTime=${time}\n`;

  test("parseDumpsysPackage reads version fields", () => {
    expect(parseDumpsysPackage(dumpsys("2026-10-17 10:00:00"))).toEqual({
      versionName: "1.22.3",
      versionCode: "42",
      lastUpdateTime: "2026-10-17 10:00:00",
    });
    expect(parseDumpsysPackage("Unable to find package: space.hypen.gallery")).toBeNull();
  });

  test("isRunnerInstallCurrent needs same APK and untouched install", () => {
    const installed = { versionCode: "42", lastUpdateTime: "t1" };
    const record = { apk: "h", versionCode: "42", lastUpdateTime: "t1" };
    expect(isRunnerInstallCurrent(record, "h", installed)).toBe(true);
    expect(isRunnerInstallCurrent(record, "other", installed)).toBe(false);
    expect(isRunnerInstallCurrent(record, "h", { ...installed, lastUpdateTime: "t2" })).toBe(false);
    expect(isRunnerInstallCurrent(record, "h", null)).toBe(false);
    expect(isRunnerInstallCurrent(undefined, "h", installed)).toBe(false);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hypen-run-install-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("installs once, skips the next run, reinstalls when the APK changes", async () => {
    const apkPath = join(dir, "runner.apk");
    const recordsPath = join(dir, "installed.json");
    writeFileSync(apkPath, "apk-v1");

    let time = "never";
    let installs = 0;
    const run = async (cmd: string[]) => {
      const line = cmd.join(" ");
      if (line.includes("dumpsys")) {
        return time === "never"
          ? { stdout: "Unable to find package", stderr: "", exitCode: 0 }
          : { stdout: dumpsys(time), stderr: "", exitCode: 0 };
      }
      if (line.includes(" install -r ")) {
        installs++;
        time = `t${installs}`;
        return { stdout: "Success", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };

    const first = await installAndroidRunnerIfNeeded("emulator-5554", { apkPath, recordsPath, run });
    expect(first).toEqual({ ok: true, skipped: false, versionName: "1.22.3" });
    expect(JSON.parse(readFileSync(recordsPath, "utf-8"))["emulator-5554"].lastUpdateTime).toBe("t1");

    const second = await installAndroidRunnerIfNeeded("emulator-5554", { apkPath, recordsPath, run });
    expect(second).toEqual({ ok: true, skipped: true, versionName: "1.22.3" });
    expect(installs).toBe(1);

    // Another serial has no record: installs there.
    await installAndroidRunnerIfNeeded("R5CT1234", { apkPath, recordsPath, run });
    expect(installs).toBe(2);

    writeFileSync(apkPath, "apk-v2");
    const third = await installAndroidRunnerIfNeeded("emulator-5554", { apkPath, recordsPath, run });
    expect(third.skipped).toBe(false);
    expect(installs).toBe(3);
  });

  test("reports install failures", async () => {
    const apkPath = join(dir, "runner.apk");
    writeFileSync(apkPath, "apk");
    const { run } = fakeExec([
      [/dumpsys/, { stdout: "" }],
      [/install -r/, { exitCode: 1, stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE\n" }],
    ]);
    const r = await installAndroidRunnerIfNeeded("x", { apkPath, recordsPath: join(dir, "r.json"), run });
    expect(r).toEqual({ ok: false, skipped: false, error: "INSTALL_FAILED_INSUFFICIENT_STORAGE" });
  });
});

describe("desktop runner", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hypen-run-desktop-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("--runner beats $HYPEN_DESKTOP_RUNNER; relative paths resolve from cwd", () => {
    expect(resolveDesktopRunnerOverride("/opt/hb", { HYPEN_DESKTOP_RUNNER: "/x" })).toBe("/opt/hb");
    expect(resolveDesktopRunnerOverride(undefined, { HYPEN_DESKTOP_RUNNER: "/x/hb" })).toBe("/x/hb");
    expect(resolveDesktopRunnerOverride("bin/hb", {})).toBe(join(process.cwd(), "bin/hb"));
    expect(resolveDesktopRunnerOverride(undefined, {})).toBeNull();
  });

  test("download guidance explains build-from-source and where the binary goes", () => {
    const help = desktopRunnerHelp("HTTP 404");
    expect(help).toContain("cargo build --release -p hypen-browser");
    expect(help).toContain("~/.hypen/runners/hypen-browser");
    expect(help).toContain("--runner");
    expect(help).toContain("HYPEN_DESKTOP_RUNNER");
  });

  test("RUN_HELP documents --device and --runner", () => {
    expect(RUN_HELP).toContain("--device <id>");
    expect(RUN_HELP).toContain("--runner <path>");
    expect(RUN_HELP).toContain("browser.log");
  });

  test("launchDetached reports an immediate crash with the log tail", async () => {
    const bin = join(dir, "crash.sh");
    writeFileSync(bin, "#!/bin/sh\necho starting\necho 'error: no display' >&2\nexit 3\n");
    chmodSync(bin, 0o755);
    const logPath = join(dir, "logs", "browser.log");
    const r = await launchDetached(bin, ["ws://localhost:1"], { logPath, graceMs: 3000 });
    expect(r.state).toBe("exited");
    if (r.state === "exited") {
      expect(r.code).toBe(3);
      expect(r.logTail).toContain("error: no display");
    }
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("ws://localhost:1");
    expect(log).toContain("starting");
  });

  test("launchDetached reports a missing binary", async () => {
    const r = await launchDetached(join(dir, "nope"), [], { logPath: join(dir, "b.log"), graceMs: 2000 });
    expect(r.state).toBe("error");
  });

  test("launchDetached leaves a healthy process running", async () => {
    const bin = join(dir, "ok.sh");
    writeFileSync(bin, "#!/bin/sh\necho up\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const r = await launchDetached(bin, [], { logPath: join(dir, "b.log"), graceMs: 300 });
    expect(r.state).toBe("running");
    if (r.state === "running") process.kill(r.pid);
  });

  test("a 404 download prints the build-from-source guidance", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const script = `
      globalThis.fetch = async () => new Response("Not Found", { status: 404 });
      const { ensureDesktopRunner } = await import(${JSON.stringify(join(import.meta.dir, "../src/run.ts"))});
      const ok = await ensureDesktopRunner();
      console.log("RESULT", ok);
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (process.platform === "linux" && process.arch !== "x64") {
      expect(err).toContain("no prebuilt Hypen Browser");
    } else {
      expect(err).toContain("HTTP 404");
    }
    expect(err).toContain("cargo build --release -p hypen-browser");
    expect(out).toContain("RESULT false");
  });
});

describe("runner version", () => {
  test("only plausible versions are shown", () => {
    expect(isPlausibleVersion("1.22.3")).toBe(true);
    expect(isPlausibleVersion("v1.22.3")).toBe(true);
    expect(isPlausibleVersion("1-22-3")).toBe(true);
    expect(isPlausibleVersion("unknown")).toBe(false);
    expect(isPlausibleVersion("Use /android/latest, /ios/latest, /android/v-1-22-3, /ios/v-1-22-3")).toBe(false);
    expect(isPlausibleVersion("")).toBe(false);
    expect(isPlausibleVersion(null)).toBe(false);
  });
});

describe("selectIOSSimulator", () => {
  const sim = (name: string, state = "Shutdown", runtime = "iOS 18.4", udid = name.replace(/\W/g, "-")) => ({
    udid,
    name,
    runtime,
    state,
  });
  const pro = sim("iPhone 16 Pro");
  const ipad = sim("iPad Pro 11-inch (M4)");
  const watch = sim("Apple Watch Series 10", "Shutdown", "watchOS 11.4");

  test("no terminal: picks the first iPhone instead of prompting", () => {
    const r = selectIOSSimulator([ipad, pro], { interactive: false });
    expect(r).toEqual({ kind: "device", device: pro });
  });

  test("a terminal with several candidates prompts", () => {
    const r = selectIOSSimulator([pro, ipad], { interactive: true });
    expect(r.kind).toBe("prompt");
  });

  test("booted simulators win, without prompting when there is one", () => {
    const booted = sim("iPhone 16", "Booted");
    const r = selectIOSSimulator([pro, booted, ipad], { interactive: true });
    expect(r).toEqual({ kind: "device", device: booted });
  });

  test("explicit name or UDID, case-insensitive", () => {
    expect(selectIOSSimulator([pro, ipad], { device: "ipad pro 11-inch (m4)", interactive: true })).toEqual({
      kind: "device",
      device: ipad,
    });
    expect(selectIOSSimulator([pro, ipad], { device: pro.udid, interactive: false })).toEqual({
      kind: "device",
      device: pro,
    });
  });

  test("unknown explicit simulator is an error listing the available ones", () => {
    const r = selectIOSSimulator([pro], { device: "iPhone 99", interactive: false });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("iPhone 16 Pro");
  });

  test("non-iOS runtimes are ignored", () => {
    const r = selectIOSSimulator([watch, pro], { interactive: false });
    expect(r).toEqual({ kind: "device", device: pro });
  });
});

describe("launchIOSRunner", () => {
  test("launches with DEVICE_LAB_URL instead of the confirm-gated deep link", async () => {
    const calls: string[][] = [];
    const r = await launchIOSRunner("UDID-1", "ws://localhost:3000", async (cmd) => {
      calls.push(cmd);
      return { stdout: "space.hypen.gallery.HypenGallery: 42", stderr: "", exitCode: 0 };
    });
    expect(r).toEqual({ ok: true, via: "launch" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("SIMCTL_CHILD_DEVICE_LAB_URL=ws://localhost:3000");
    expect(calls[0]).toContain("launch");
    expect(calls[0]).toContain("UDID-1");
  });

  test("falls back to the deep link when launch fails", async () => {
    const calls: string[][] = [];
    const r = await launchIOSRunner("UDID-1", "ws://localhost:3000", async (cmd) => {
      calls.push(cmd);
      return cmd.includes("launch")
        ? { stdout: "", stderr: "not installed", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(r).toEqual({ ok: true, via: "deep-link" });
    expect(calls[1]).toEqual([
      "xcrun",
      "simctl",
      "openurl",
      "UDID-1",
      "hypenpreview://connect?url=ws%3A%2F%2Flocalhost%3A3000",
    ]);
  });

  test("reports the error when both fail", async () => {
    const r = await launchIOSRunner(
      "UDID-1",
      "ws://localhost:3000",
      async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
      0
    );
    expect(r).toEqual({ ok: false, error: "boom" });
  });
});
