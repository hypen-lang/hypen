export interface IOSSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export function iosGalleryLaunchCommand(
  udid: string,
  bundleId: string,
  itemName: string,
): string[] {
  if (!udid.trim() || !bundleId.trim() || !itemName.trim()) {
    throw new Error("iOS gallery launch requires a simulator UDID, bundle ID, and item name.");
  }
  return [
    "xcrun",
    "simctl",
    "launch",
    "--terminate-running-process",
    udid,
    bundleId,
    "--gallery-item",
    itemName,
  ];
}

export function androidGalleryLaunchCommand(
  serial: string,
  packageId: string,
  activityName: string,
  itemName: string,
): string[] {
  if (!serial.trim() || !packageId.trim() || !activityName.trim() || !itemName.trim()) {
    throw new Error(
      "Android gallery launch requires a device serial, package ID, activity name, and item name.",
    );
  }

  const component = `${packageId}/${activityName}`;
  const url = `hypengallery://components?name=${encodeURIComponent(itemName)}`;

  return [
    "adb",
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-W",
    "-S",
    "--activity-no-animation",
    "-n",
    component,
    "-a",
    "android.intent.action.VIEW",
    "-d",
    url,
  ];
}

export interface AndroidDevice {
  serial: string;
  state: string;
  avdName: string | null;
  model: string | null;
}

export async function probeAndroidDevice(
  serial: string,
  state: string,
  readProperty: (name: string) => Promise<string>,
  options: { allowTransientShellErrors?: boolean } = {},
): Promise<AndroidDevice> {
  if (state !== "device") return { serial, state, avdName: null, model: null };
  try {
    const [bootAvdName, kernelAvdName, model] = await Promise.all([
      readProperty("ro.boot.qemu.avd_name"),
      readProperty("ro.kernel.qemu.avd_name"),
      readProperty("ro.product.model"),
    ]);
    return {
      serial,
      state,
      avdName: bootAvdName.replace(/\r/g, "").trim()
        || kernelAvdName.replace(/\r/g, "").trim()
        || null,
      model: model.replace(/\r/g, "").trim() || null,
    };
  } catch (error) {
    if (options.allowTransientShellErrors) {
      return { serial, state, avdName: null, model: null };
    }
    throw error;
  }
}

const MIN_ANDROID_CONSOLE_PORT = 5554;
const MAX_ANDROID_CONSOLE_PORT = 5682;

export function androidConsolePortFromSerial(serial: string): number | null {
  const match = serial.match(/^emulator-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function selectAndroidConsolePort(
  occupiedConsolePorts: Iterable<number>,
  unavailableTcpPorts: Iterable<number>,
  reservedPorts: Iterable<number>,
  preferredPort?: number,
): number {
  const occupied = new Set(occupiedConsolePorts);
  const unavailable = new Set(unavailableTcpPorts);
  const reserved = new Set(reservedPorts);

  if (preferredPort !== undefined && (
    !Number.isSafeInteger(preferredPort)
    || preferredPort < MIN_ANDROID_CONSOLE_PORT
    || preferredPort > MAX_ANDROID_CONSOLE_PORT
    || preferredPort % 2 !== 0
  )) {
    throw new Error(
      `Android emulator console port must be an even number from ` +
      `${MIN_ANDROID_CONSOLE_PORT} through ${MAX_ANDROID_CONSOLE_PORT} (received ${preferredPort}).`,
    );
  }

  const candidates = preferredPort === undefined
    ? Array.from(
      { length: ((MAX_ANDROID_CONSOLE_PORT - MIN_ANDROID_CONSOLE_PORT) / 2) + 1 },
      (_, index) => MIN_ANDROID_CONSOLE_PORT + (index * 2),
    )
    : [preferredPort];

  const selected = candidates.find(port =>
    !occupied.has(port)
    && !unavailable.has(port)
    && !unavailable.has(port + 1)
    && !reserved.has(port)
    && !reserved.has(port + 1),
  );
  if (selected !== undefined) return selected;

  if (preferredPort !== undefined) {
    throw new Error(
      `Configured Android emulator console port ${preferredPort} (ADB ${preferredPort + 1}) is occupied or reserved.`,
    );
  }
  throw new Error(
    `No free Android emulator console/ADB port pair is available from ` +
    `${MIN_ANDROID_CONSOLE_PORT}-${MAX_ANDROID_CONSOLE_PORT + 1}.`,
  );
}

export function androidEnvironmentForDevice(
  environment: Record<string, string | undefined>,
  serial: string,
): Record<string, string | undefined> {
  return { ...environment, ANDROID_SERIAL: serial };
}

export function optionValue(
  args: string[],
  option: string,
  envValue: string | undefined,
  defaultValue: string,
): string {
  const prefix = `--${option}=`;
  const argument = args.find(value => value.startsWith(prefix));
  const value = argument ? argument.slice(prefix.length) : envValue ?? defaultValue;
  if (!value.trim()) {
    throw new Error(`--${option} cannot be empty.`);
  }
  return value.trim();
}

export function integerOption(
  args: string[],
  option: string,
  envValue: string | undefined,
  defaultValue: number,
): number {
  const raw = optionValue(args, option, envValue, String(defaultValue));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${option} must be a positive integer (received ${JSON.stringify(raw)}).`);
  }
  return value;
}

export function selectIOSSimulator(
  simulators: IOSSimulator[],
  expectedName: string,
  expectedUdid?: string,
): IOSSimulator {
  if (expectedUdid) {
    const simulator = simulators.find(item => item.udid.toLowerCase() === expectedUdid.toLowerCase());
    if (!simulator) {
      throw new Error(
        `Configured iOS simulator UDID ${expectedUdid} is not available. ` +
        `Run "xcrun simctl list devices available" and update --ios-udid or HYPEN_IOS_UDID.`,
      );
    }
    if (simulator.name !== expectedName) {
      throw new Error(
        `Configured iOS UDID ${expectedUdid} is ${JSON.stringify(simulator.name)}, ` +
        `not ${JSON.stringify(expectedName)}. Update --ios-simulator/--ios-udid together.`,
      );
    }
    return simulator;
  }

  const matches = simulators.filter(item => item.name === expectedName);
  if (matches.length === 0) {
    throw new Error(
      `Configured iOS simulator ${JSON.stringify(expectedName)} is not available. ` +
      `Create it in Xcode or set --ios-simulator/--ios-udid (HYPEN_IOS_SIMULATOR/HYPEN_IOS_UDID).`,
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map(item => `${item.udid} (${item.runtime})`).join(", ");
    throw new Error(
      `More than one available iOS simulator is named ${JSON.stringify(expectedName)}: ${candidates}. ` +
      `Select one explicitly with --ios-udid or HYPEN_IOS_UDID.`,
    );
  }
  return matches[0];
}

export function selectAndroidDevice(
  devices: AndroidDevice[],
  expectedAvd: string,
  expectedSerial?: string,
  options: { allowPendingTarget?: boolean } = {},
): AndroidDevice | null {
  const online = devices.filter(item => item.state === "device");
  if (expectedSerial) {
    const device = devices.find(item => item.serial === expectedSerial);
    if (!device) return null;
    if (device.state !== "device") {
      if (options.allowPendingTarget) return null;
      throw new Error(`Configured Android device ${expectedSerial} is ${device.state}, not ready.`);
    }
    if (device.avdName !== expectedAvd) {
      if (options.allowPendingTarget && device.avdName === null) return null;
      throw new Error(
        `Configured Android serial ${expectedSerial} is AVD ${JSON.stringify(device.avdName)}, ` +
        `not ${JSON.stringify(expectedAvd)}. Update --android-avd/--android-serial together.`,
      );
    }
    return device;
  }

  const matches = online.filter(item => item.avdName === expectedAvd);
  if (matches.length > 1) {
    throw new Error(
      `More than one connected emulator is using AVD ${JSON.stringify(expectedAvd)}: ` +
      `${matches.map(item => item.serial).join(", ")}. Select one with --android-serial or HYPEN_ANDROID_SERIAL.`,
    );
  }
  return matches[0] ?? null;
}

export function parsePngDimensions(buffer: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || !signature.every((byte, index) => buffer[index] === byte)) {
    throw new Error("Screenshot is not a valid PNG file.");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function parseAndroidMetric(output: string, label: string): number {
  const override = output.match(new RegExp(`Override ${label}:\\s*(\\d+)`, "i"));
  const physical = output.match(new RegExp(`Physical ${label}:\\s*(\\d+)`, "i"));
  const plain = output.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
  const value = override?.[1] ?? physical?.[1] ?? plain?.[1];
  if (!value) throw new Error(`Could not parse Android ${label} from: ${output.trim()}`);
  return Number(value);
}
