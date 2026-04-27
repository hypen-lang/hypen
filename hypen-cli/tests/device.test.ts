import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "bun";
import {
  getServerUrl,
  getLocalIP,
  promptChoice,
  RUNNER_URLS,
  RUNNER_PATHS,
  RUN_HELP,
  type AndroidDevice,
  type IOSSimulator,
} from "../src/run.js";

// ─── CLI integration tests (spawn the actual CLI process) ───

describe("CLI run command", () => {
  const testDir = `/tmp/hypen-run-test-${Date.now()}`;
  const cliPath = join(import.meta.dir, "../bin/hypen.ts");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function runCli(
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", cliPath, ...args],
      cwd: cwd || testDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  describe("help", () => {
    test("shows run help with no platform argument", async () => {
      const result = await runCli(["run"]);

      expect(result.stdout).toContain("hypen run");
      expect(result.stdout).toContain("android");
      expect(result.stdout).toContain("ios");
      expect(result.exitCode).toBe(0);
    });

    test("shows run in main help output", async () => {
      const result = await runCli(["--help"]);

      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("android");
      expect(result.stdout).toContain("ios");
      expect(result.exitCode).toBe(0);
    });

    test("shows error for unknown platform", async () => {
      const result = await runCli(["run", "windows"]);

      expect(result.stderr).toContain("Unknown platform");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("port validation", () => {
    test("rejects invalid port for run", async () => {
      const result = await runCli(["run", "android", "--port", "99999"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Port must be between 1 and 65535");
    });

    test("rejects non-numeric port for run", async () => {
      const result = await runCli(["run", "android", "--port", "abc"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Port must be a valid integer");
    });
  });

  describe("run android", () => {
    test("fails gracefully when adb is not installed", async () => {
      const result = await runCli(["run", "android"]);

      const hasError =
        result.exitCode !== 0 ||
        result.stderr.includes("adb not found") ||
        result.stderr.includes("No Android devices");
      expect(hasError).toBe(true);
    });
  });

  describe("run ios", () => {
    test("fails gracefully when xcrun is not installed", async () => {
      const result = await runCli(["run", "ios"]);

      const hasError =
        result.exitCode !== 0 ||
        result.stderr.includes("xcrun not found") ||
        result.stderr.includes("No iOS Simulators");
      expect(hasError).toBe(true);
    });
  });
});

// ─── Unit tests for run.ts utilities ───

describe("run.ts utilities", () => {
  describe("getServerUrl", () => {
    test("returns 10.0.2.2 for android emulator", () => {
      expect(getServerUrl("android", 3000, "emulator")).toBe("ws://10.0.2.2:3000");
    });

    test("returns 10.0.2.2 for android with no device type (default)", () => {
      expect(getServerUrl("android", 3000)).toBe("ws://10.0.2.2:3000");
    });

    test("returns LAN IP or fallback for android physical", () => {
      const url = getServerUrl("android", 3000, "physical");
      // Either the host LAN IP or the 10.0.2.2 fallback
      expect(url).toMatch(/^ws:\/\/[\d.]+:3000$/);
    });

    test("returns localhost for ios simulator", () => {
      expect(getServerUrl("ios", 3000, "simulator")).toBe("ws://localhost:3000");
    });

    test("returns localhost for ios with no device type", () => {
      expect(getServerUrl("ios", 3000)).toBe("ws://localhost:3000");
    });

    test("uses the correct port", () => {
      expect(getServerUrl("android", 8080, "emulator")).toBe("ws://10.0.2.2:8080");
      expect(getServerUrl("ios", 9999)).toBe("ws://localhost:9999");
    });
  });

  describe("promptChoice", () => {
    test("returns the only item without prompting", async () => {
      const items = [{ id: "only-one" }];
      const result = await promptChoice(
        items,
        (item) => item.id,
        "Pick one"
      );
      expect(result).toBe(items[0]);
    });
  });

  describe("getLocalIP", () => {
    test("returns null or a valid IPv4 address", () => {
      const ip = getLocalIP();
      if (ip !== null) {
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    });
  });

  describe("RUNNER_URLS", () => {
    test("android URL points to android runner", () => {
      expect(RUNNER_URLS.android).toContain("/android/");
    });

    test("ios URL points to ios runner", () => {
      expect(RUNNER_URLS.ios).toContain("/ios/");
    });

    test("urls use https", () => {
      expect(RUNNER_URLS.android).toMatch(/^https:\/\//);
      expect(RUNNER_URLS.ios).toMatch(/^https:\/\//);
    });
  });

  describe("RUNNER_PATHS", () => {
    test("android path is under ~/.hypen/runners", () => {
      expect(RUNNER_PATHS.android).toContain(join(homedir(), ".hypen", "runners"));
      expect(RUNNER_PATHS.android).toContain(".apk");
    });

    test("ios path is under ~/.hypen/runners", () => {
      expect(RUNNER_PATHS.ios).toContain(join(homedir(), ".hypen", "runners"));
      expect(RUNNER_PATHS.ios).toContain(".app");
    });
  });

  describe("RUN_HELP", () => {
    test("mentions both platforms", () => {
      expect(RUN_HELP).toContain("android");
      expect(RUN_HELP).toContain("ios");
    });

    test("mentions port option", () => {
      expect(RUN_HELP).toContain("--port");
    });

    test("mentions the cache directory", () => {
      expect(RUN_HELP).toContain("~/.hypen/runners");
    });

    test("mentions hypen dev", () => {
      expect(RUN_HELP).toContain("hypen dev");
    });

    test("mentions device chooser", () => {
      expect(RUN_HELP).toContain("prompted to choose");
    });
  });

  describe("AndroidDevice type", () => {
    test("can represent an emulator", () => {
      const device: AndroidDevice = {
        id: "emulator-5554",
        name: "Pixel 7",
        type: "emulator",
        status: "device",
      };
      expect(device.type).toBe("emulator");
    });

    test("can represent a physical device", () => {
      const device: AndroidDevice = {
        id: "R5CT900ABCD",
        name: "Galaxy S23",
        type: "physical",
        status: "device",
      };
      expect(device.type).toBe("physical");
    });
  });

  describe("IOSSimulator type", () => {
    test("can represent a booted simulator", () => {
      const sim: IOSSimulator = {
        udid: "ABC-123",
        name: "iPhone 15 Pro",
        runtime: "iOS 17.4",
        state: "Booted",
      };
      expect(sim.state).toBe("Booted");
    });

    test("can represent a shutdown simulator", () => {
      const sim: IOSSimulator = {
        udid: "DEF-456",
        name: "iPad Air",
        runtime: "iOS 17.2",
        state: "Shutdown",
      };
      expect(sim.state).toBe("Shutdown");
    });
  });
});
