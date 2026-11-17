/**
 * Reading a project's `hypen.json` as a library: the same defaults the CLI
 * applies, but a `BuildError` instead of an exit, and any project directory
 * instead of the working directory. Used wherever the CLI works on a project
 * other than the one it was started in (a `source` package's module project)
 * and by the commands that edit the file (`hypen add` / `remove`).
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { BuildError } from "./build-error.js";

export interface ProjectConfig {
  /** Absolute path of the project. */
  dir: string;
  /** Path of its hypen.json (which may not exist: defaults apply). */
  file: string;
  /** The file's text, `null` when there is no file. */
  text: string | null;
  components: string;
  entry: string;
  outDir: string;
  /** The raw `wasm` section. */
  wasm: unknown;
}

/**
 * @throws {BuildError} `CONFIG_INVALID` when hypen.json is not a JSON object.
 */
export function readProjectConfig(projectDir: string): ProjectConfig {
  const dir = resolve(projectDir);
  const file = join(dir, "hypen.json");
  let text: string | null = null;
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    text = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new BuildError(`${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
        code: "CONFIG_INVALID",
        file,
        hint: "fix the syntax error (hypen.json is plain JSON: no comments, no trailing commas)",
        cause,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BuildError(`${file} must contain a JSON object.`, {
        code: "CONFIG_INVALID",
        file,
        hint: `e.g. { "components": "./src/components", "entry": "App" }`,
      });
    }
    raw = parsed as Record<string, unknown>;
  }
  const text_ = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);
  const build = raw.build as { outDir?: unknown } | undefined;
  return {
    dir,
    file,
    text,
    components: text_(raw.components, "./src/components"),
    entry: text_(raw.entry, "App"),
    outDir: text_(raw.outDir, text_(build?.outDir, "dist")),
    wasm: raw.wasm,
  };
}
