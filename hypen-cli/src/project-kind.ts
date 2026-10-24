/**
 * Small, pure helpers for the CLI dispatcher (`bin/hypen.ts`), kept here so
 * they can be unit-tested without spawning the CLI.
 */

import { existsSync } from "fs";
import { join } from "path";

export type NonTsProjectKind = "go" | "kotlin";

/**
 * Detect a Go or Kotlin Hypen project (as scaffolded by `hypen init`).
 * Those projects have a `hypen.json` and `.hypen` components too, but they
 * run on their own SDK (`go run .`, `./gradlew run`); the TypeScript dev
 * server, build and Studio would otherwise "repair" them by writing a
 * `package.json` and installing npm packages into them.
 *
 * A project that has a `package.json` is treated as TypeScript.
 */
export function nonTsProjectKind(dir: string): NonTsProjectKind | null {
  if (existsSync(join(dir, "package.json"))) return null;
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (
    existsSync(join(dir, "build.gradle.kts")) ||
    existsSync(join(dir, "build.gradle")) ||
    existsSync(join(dir, "settings.gradle.kts"))
  ) {
    return "kotlin";
  }
  return null;
}

/** How to run a Go/Kotlin project, for error messages. */
export function nonTsRunHint(kind: NonTsProjectKind, dir: string): string {
  if (kind === "go") return "go run .";
  return existsSync(join(dir, "gradlew")) ? "./gradlew run" : "gradle run";
}

/**
 * Parse a `--port` value strictly: digits only, 1-65535. `parseInt` alone
 * would accept `3000abc` as 3000. Returns the port, or an error message.
 */
export function parsePortArg(raw: string): { port: number } | { error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { error: `Port must be a valid integer (got "${raw}")` };
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    return { error: `Port must be between 1 and 65535 (got "${raw}")` };
  }
  return { port };
}
