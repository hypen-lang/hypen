import { tmpdir } from "node:os";
import { join } from "node:path";

/** PID file the playground server writes for a given port. */
export function pidFileFor(port: number | string): string {
  return join(tmpdir(), `hypen-playground-${port}.pid`);
}
