import { describe, expect, test } from "bun:test";
import {
  androidGalleryLaunchCommand,
  androidEnvironmentForDevice,
  androidConsolePortFromSerial,
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

describe("device configuration", () => {
  test("CLI values override environment and defaults", () => {
    expect(optionValue(["--ios-simulator=iPhone Test"], "ios-simulator", "env", "default"))
      .toBe("iPhone Test");
    expect(integerOption([], "android-api", "35", 34)).toBe(35);
    expect(() => integerOption(["--android-api=nope"], "android-api", undefined, 35)).toThrow();
  });

  test("iOS selection rejects ambiguous names and validates a pinned UDID", () => {
    const simulators = [
      { udid: "A", name: "iPhone", state: "Shutdown", runtime: "iOS 18" },
      { udid: "B", name: "iPhone", state: "Booted", runtime: "iOS 19" },
    ];
    expect(() => selectIOSSimulator(simulators, "iPhone")).toThrow("More than one");
    expect(selectIOSSimulator(simulators, "iPhone", "B").udid).toBe("B");
    expect(() => selectIOSSimulator(simulators, "Other", "B")).toThrow("not \"Other\"");
  });

  test("iOS gallery launch command terminates and preserves item spelling", () => {
    expect(iosGalleryLaunchCommand("SIM-UDID", "space.hypen.gallery", "borderRadius")).toEqual([
      "xcrun",
      "simctl",
      "launch",
      "--terminate-running-process",
      "SIM-UDID",
      "space.hypen.gallery",
      "--gallery-item",
      "borderRadius",
    ]);
    expect(() => iosGalleryLaunchCommand("SIM-UDID", "space.hypen.gallery", " ")).toThrow(
      "requires a simulator UDID",
    );
  });

  test("Android selection ignores unrelated connected devices", () => {
    const devices = [
      { serial: "phone", state: "device", avdName: null, model: "Phone" },
      { serial: "emulator-5554", state: "device", avdName: "Pixel_9", model: "sdk" },
    ];
    const selected = selectAndroidDevice(devices, "Pixel_9");
    expect(selected?.serial).toBe("emulator-5554");
    expect(androidEnvironmentForDevice({ KEEP: "yes" }, selected!.serial)).toEqual({
      KEEP: "yes",
      ANDROID_SERIAL: "emulator-5554",
    });
    expect(selectAndroidDevice(devices, "Missing")).toBeNull();
  });

  test("Android gallery launch resets the app process and disables activity animation", () => {
    expect(androidGalleryLaunchCommand(
      "emulator-5558",
      "space.hypen.gallery",
      ".ComponentListActivity",
      "borderRadius",
    )).toEqual([
      "adb",
      "-s",
      "emulator-5558",
      "shell",
      "am",
      "start",
      "-W",
      "-S",
      "--activity-no-animation",
      "-n",
      "space.hypen.gallery/.ComponentListActivity",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "hypengallery://components?name=borderRadius",
    ]);
    expect(() => androidGalleryLaunchCommand(
      "emulator-5558",
      "space.hypen.gallery",
      ".ComponentListActivity",
      " ",
    )).toThrow("requires a device serial");
  });

  test("Android boot polling waits through absent, offline, and missing-identity states", () => {
    const serial = "emulator-5558";
    expect(selectAndroidDevice([], "Pixel_8", serial, { allowPendingTarget: true })).toBeNull();
    expect(selectAndroidDevice(
      [{ serial, state: "offline", avdName: null, model: null }],
      "Pixel_8",
      serial,
      { allowPendingTarget: true },
    )).toBeNull();
    expect(selectAndroidDevice(
      [{ serial, state: "device", avdName: null, model: "Android SDK built for arm64" }],
      "Pixel_8",
      serial,
      { allowPendingTarget: true },
    )).toBeNull();
    expect(selectAndroidDevice(
      [{ serial, state: "device", avdName: "Pixel_8", model: "Pixel 8" }],
      "Pixel_8",
      serial,
      { allowPendingTarget: true },
    )?.serial).toBe(serial);

    expect(() => selectAndroidDevice(
      [{ serial, state: "unauthorized", avdName: null, model: null }],
      "Pixel_8",
      serial,
    )).toThrow("unauthorized, not ready");
    expect(() => selectAndroidDevice(
      [{ serial, state: "device", avdName: "Wrong_AVD", model: "Pixel" }],
      "Pixel_8",
      serial,
      { allowPendingTarget: true },
    )).toThrow('AVD "Wrong_AVD", not "Pixel_8"');
  });

  test("Android identity probing tolerates transient shell failure before succeeding", async () => {
    let adbReady = false;
    const readProperty = async (name: string): Promise<string> => {
      if (!adbReady) throw new Error("adb shell exited 126");
      if (name === "ro.boot.qemu.avd_name") return "Pixel_8\r\n";
      if (name === "ro.kernel.qemu.avd_name") return "Legacy_AVD\r\n";
      return "Pixel 8\r\n";
    };

    expect(await probeAndroidDevice(
      "emulator-5558",
      "device",
      readProperty,
      { allowTransientShellErrors: true },
    )).toEqual({ serial: "emulator-5558", state: "device", avdName: null, model: null });

    adbReady = true;
    expect(await probeAndroidDevice("emulator-5558", "device", readProperty)).toEqual({
      serial: "emulator-5558",
      state: "device",
      avdName: "Pixel_8",
      model: "Pixel 8",
    });
    await expect(probeAndroidDevice(
      "emulator-5558",
      "device",
      async () => { throw new Error("strict failure"); },
    )).rejects.toThrow("strict failure");
  });

  test("Android identity probing prefers modern AVD name and falls back to legacy", async () => {
    const modern = await probeAndroidDevice("emulator-5558", "device", async name => {
      if (name === "ro.boot.qemu.avd_name") return "Pixel_8\n";
      if (name === "ro.kernel.qemu.avd_name") return "Medium_Phone\n";
      return "Pixel 8\n";
    });
    expect(modern.avdName).toBe("Pixel_8");

    const legacy = await probeAndroidDevice("emulator-5554", "device", async name => {
      if (name === "ro.boot.qemu.avd_name") return "\n";
      if (name === "ro.kernel.qemu.avd_name") return "Medium_Phone\r\n";
      return "Android SDK\n";
    });
    expect(legacy.avdName).toBe("Medium_Phone");

    const blank = await probeAndroidDevice("emulator-5560", "device", async name =>
      name === "ro.product.model" ? "Android SDK\n" : "\n"
    );
    expect(blank.avdName).toBeNull();
  });

  test("Android console port allocation skips emulators, servers, and occupied ADB pairs", () => {
    expect(selectAndroidConsolePort([5554], [], [5556, 6555])).toBe(5558);
    expect(selectAndroidConsolePort([], [5555], [5556, 6555])).toBe(5558);
    expect(selectAndroidConsolePort([], [], [5556, 6555], 5560)).toBe(5560);
    expect(() => selectAndroidConsolePort([], [], [5556], 5556)).toThrow("occupied or reserved");
    expect(() => selectAndroidConsolePort([], [], [], 5555)).toThrow("even number");
    expect(androidConsolePortFromSerial("emulator-5560")).toBe(5560);
    expect(androidConsolePortFromSerial("physical-device")).toBeNull();
  });

  test("PNG and Android metric parsers use actual/override values", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 1320);
    new DataView(png.buffer).setUint32(20, 2868);
    expect(parsePngDimensions(png)).toEqual({ width: 1320, height: 2868 });
    expect(parseAndroidMetric("Physical density: 420\nOverride density: 480", "density")).toBe(480);
  });
});
