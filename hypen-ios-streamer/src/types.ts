export type SimulatorState = "Booted" | "Shutdown" | "Booting" | "Shutting Down" | string;

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: SimulatorState;
  deviceTypeIdentifier?: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Shell = (cmd: string[], opts?: { input?: Uint8Array }) => Promise<ShellResult>;

export type BinaryShell = (cmd: string[]) => Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }>;

export interface StreamerOptions {
  /** TCP port to listen on. Default 7711. */
  port?: number;
  /** Host to bind. Default 127.0.0.1 (loopback only). */
  host?: string;
  /** MJPEG capture frame rate. Default 12 fps. */
  fps?: number;
  /** Override shell exec (for testing). */
  shell?: Shell;
  /** Override binary shell exec for screenshots (for testing). */
  binaryShell?: BinaryShell;
}

export type InputAction =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: "text"; text: string }
  | { type: "key"; key: "home" | "lock" | "siri" };
