import { describe, expect, test } from "bun:test";
import {
  bootCmd,
  formatRuntime,
  listDevicesCmd,
  parseDevicesJson,
  screenshotCmd,
  shutdownCmd,
} from "../src/simctl.ts";

describe("simctl argv", () => {
  test("listDevicesCmd", () => {
    expect(listDevicesCmd()).toEqual(["xcrun", "simctl", "list", "devices", "--json"]);
  });

  test("bootCmd / shutdownCmd", () => {
    expect(bootCmd("ABCD")).toEqual(["xcrun", "simctl", "boot", "ABCD"]);
    expect(shutdownCmd("ABCD")).toEqual(["xcrun", "simctl", "shutdown", "ABCD"]);
  });

  test("screenshotCmd writes to the supplied path (no `-` stdout in Xcode 26)", () => {
    expect(screenshotCmd("UD", "/tmp/shot.jpg")).toEqual([
      "xcrun",
      "simctl",
      "io",
      "UD",
      "screenshot",
      "--type=jpeg",
      "/tmp/shot.jpg",
    ]);
    expect(screenshotCmd("UD", "/tmp/shot.png", "png")).toEqual([
      "xcrun",
      "simctl",
      "io",
      "UD",
      "screenshot",
      "--type=png",
      "/tmp/shot.png",
    ]);
  });
});

describe("formatRuntime", () => {
  test("normalises iOS runtime keys", () => {
    expect(formatRuntime("com.apple.CoreSimulator.SimRuntime.iOS-17-4")).toBe("iOS 17.4");
  });

  test("normalises tvOS", () => {
    expect(formatRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-17-0")).toBe("tvOS 17.0");
  });
});

describe("parseDevicesJson", () => {
  test("returns available devices, booted first", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
          {
            udid: "AAA",
            name: "iPhone 15",
            state: "Shutdown",
            isAvailable: true,
            deviceTypeIdentifier: "com.apple.iPhone-15",
          },
          {
            udid: "BBB",
            name: "iPhone 15 Pro",
            state: "Booted",
            isAvailable: true,
          },
          {
            udid: "CCC",
            name: "iPhone Unavailable",
            state: "Shutdown",
            isAvailable: false,
          },
        ],
      },
    });

    const devices = parseDevicesJson(json);
    expect(devices.map((d) => d.udid)).toEqual(["BBB", "AAA"]);
    expect(devices[0]?.runtime).toBe("iOS 17.4");
    expect(devices[0]?.state).toBe("Booted");
    expect(devices[1]?.deviceTypeIdentifier).toBe("com.apple.iPhone-15");
  });

  test("handles empty / missing devices map", () => {
    expect(parseDevicesJson(JSON.stringify({}))).toEqual([]);
    expect(parseDevicesJson(JSON.stringify({ devices: {} }))).toEqual([]);
  });
});
