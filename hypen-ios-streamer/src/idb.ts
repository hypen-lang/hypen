import type { Shell, InputAction } from "./types.ts";
import { bunShell, commandExists } from "./shell.ts";

/**
 * Input forwarding via Facebook's idb (https://fbidb.io).
 *
 * idb is the only first-class CLI that injects taps/keystrokes into a booted
 * simulator without writing a custom XCUITest target. If it isn't installed
 * the streamer degrades to read-only mirroring.
 */

export function tapCmd(udid: string, x: number, y: number): string[] {
  return ["idb", "ui", "tap", "--udid", udid, String(Math.round(x)), String(Math.round(y))];
}

export function swipeCmd(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs?: number
): string[] {
  const args = [
    "idb",
    "ui",
    "swipe",
    "--udid",
    udid,
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
  ];
  if (durationMs && durationMs > 0) {
    args.push("--duration", String(durationMs / 1000));
  }
  return args;
}

export function textCmd(udid: string, text: string): string[] {
  return ["idb", "ui", "text", "--udid", udid, text];
}

export function keyCmd(udid: string, key: "home" | "lock" | "siri"): string[] {
  // `idb ui button` accepts: APPLE_PAY, HOME, LOCK, SIDE_BUTTON, SIRI
  const map: Record<string, string> = { home: "HOME", lock: "LOCK", siri: "SIRI" };
  return ["idb", "ui", "button", "--udid", udid, map[key]!];
}

export async function hasIdb(shell: Shell = bunShell): Promise<boolean> {
  return commandExists("idb", shell);
}

export async function dispatch(
  udid: string,
  action: InputAction,
  shell: Shell = bunShell
): Promise<void> {
  let cmd: string[];
  switch (action.type) {
    case "tap":
      cmd = tapCmd(udid, action.x, action.y);
      break;
    case "swipe":
      cmd = swipeCmd(udid, action.x1, action.y1, action.x2, action.y2, action.durationMs);
      break;
    case "text":
      cmd = textCmd(udid, action.text);
      break;
    case "key":
      cmd = keyCmd(udid, action.key);
      break;
  }
  const { exitCode, stderr } = await shell(cmd);
  if (exitCode !== 0) {
    throw new Error(`idb input failed (${action.type}): ${stderr.trim()}`);
  }
}
