import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "fs";
import type { Shell, BinaryShell, ShellResult } from "../src/types.ts";
import { startServer, type StartedServer } from "../src/server.ts";

const SAMPLE_DEVICES = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
      { udid: "AAA", name: "iPhone 15", state: "Booted", isAvailable: true },
    ],
  },
});

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);

function makeShells() {
  const calls: string[][] = [];
  const shell: Shell = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "which") {
      return { stdout: "", stderr: "", exitCode: 1 } as ShellResult; // pretend idb missing
    }
    if (cmd.slice(0, 4).join(" ") === "xcrun simctl list devices") {
      return { stdout: SAMPLE_DEVICES, stderr: "", exitCode: 0 };
    }
    if (cmd.slice(0, 3).join(" ") === "xcrun simctl boot" || cmd.slice(0, 3).join(" ") === "xcrun simctl shutdown") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    // `xcrun simctl io <udid> screenshot --type=<t> <outputPath>` — write the
    // fake JPEG to the real file so screenshot() can read it back.
    if (cmd[0] === "xcrun" && cmd[1] === "simctl" && cmd[2] === "io" && cmd[4] === "screenshot") {
      const outPath = cmd[cmd.length - 1]!;
      writeFileSync(outPath, FAKE_JPEG);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unhandled", exitCode: 1 };
  };
  const binaryShell: BinaryShell = async (cmd) => {
    calls.push(cmd);
    return { stdout: FAKE_JPEG, stderr: "", exitCode: 0 };
  };
  return { calls, shell, binaryShell };
}

describe("server", () => {
  let server: StartedServer;
  let shells: ReturnType<typeof makeShells>;

  beforeAll(async () => {
    shells = makeShells();
    server = await startServer({ port: 0, shell: shells.shell, binaryShell: shells.binaryShell });
  });

  afterAll(() => {
    server.stop();
  });

  test("GET /health reports idb availability", async () => {
    const res = await fetch(`${server.url}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.idb).toBe(false);
  });

  test("GET /devices returns parsed devices", async () => {
    const res = await fetch(`${server.url}/devices`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.devices).toEqual([
      { udid: "AAA", name: "iPhone 15", runtime: "iOS 17.4", state: "Booted" },
    ]);
  });

  test("POST /devices/:udid/boot succeeds", async () => {
    const res = await fetch(`${server.url}/devices/AAA/boot`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /devices/:udid/screenshot.jpg returns JPEG bytes", async () => {
    const res = await fetch(`${server.url}/devices/AAA/screenshot.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(FAKE_JPEG);
  });

  test("POST /devices/:udid/input returns 501 when idb missing", async () => {
    const res = await fetch(`${server.url}/devices/AAA/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tap", x: 10, y: 10 }),
    });
    expect(res.status).toBe(501);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${server.url}/nope`);
    expect(res.status).toBe(404);
  });
});
