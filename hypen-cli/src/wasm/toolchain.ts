/**
 * Finding the external tools each language pipeline shells out to. A lookup
 * never throws: it returns a `ToolLookup` saying the tool was found, is
 * missing, or is too old — each non-found case carrying the install step.
 * `requireTool` is the one place that turns those into a `BuildError`.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { BuildError } from "../build-error.js";
import { runTool } from "./process.js";
import { isRecord } from "./types.js";

export type ToolLookup<T> =
  | { status: "found"; tool: T }
  | { status: "missing"; name: string; neededFor: string; hint: string }
  | { status: "outdated"; name: string; neededFor: string; found: string; required: string; hint: string };

/** Unwrap a lookup, or throw `TOOLCHAIN_MISSING` / `TOOLCHAIN_VERSION`. */
export function requireTool<T>(lookup: ToolLookup<T>): T {
  switch (lookup.status) {
    case "found":
      return lookup.tool;
    case "missing":
      throw new BuildError(`${lookup.neededFor} needs ${lookup.name}, which is not installed.`, {
        code: "TOOLCHAIN_MISSING",
        hint: lookup.hint,
      });
    case "outdated":
      throw new BuildError(
        `${lookup.neededFor} needs ${lookup.name} >= ${lookup.required}, but found ${lookup.found}.`,
        { code: "TOOLCHAIN_VERSION", hint: lookup.hint }
      );
  }
}

/** The leading `major.minor[.patch]` of a version string, as numbers. */
function parseVersion(text: string): number[] | undefined {
  const m = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function atLeast(found: number[], required: number[]): boolean {
  for (let i = 0; i < required.length; i++) {
    const a = found[i] ?? 0;
    const b = required[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Run `<cmd> <args>` quietly. `undefined` when the binary cannot be started
 * (not on PATH); otherwise its combined output — a non-zero exit still proves
 * the binary exists (some tools exit non-zero for `--help`).
 */
async function probe(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
  const run = await runTool(cmd, args, { cwd, output: "quiet" });
  switch (run.status) {
    case "ok":
      return `${run.stdout}\n${run.stderr}`;
    case "failed":
      return run.failure.stderrTail;
    case "not-started":
      return undefined;
  }
}

// ── jco (TypeScript) ─────────────────────────────────────────────────────────

/** The npm package that provides the `jco` binary. */
export const JCO_PACKAGE = "@bytecodealliance/jco";

/** Version of `@bytecodealliance/jco` the TS pipeline is tested against. */
export const JCO_VERSION = "1.42.0";

export interface JcoTool {
  /** Executable to spawn. */
  cmd: string;
  /** Arguments that precede jco's own (the script path, when run via a runtime). */
  pre: string[];
  /** Where it came from: the project's own install, or the CLI's pinned one. */
  origin: "project" | "cli";
  /** The package version, when its package.json could be read. */
  version: string | undefined;
}

/**
 * The `@bytecodealliance/jco` package visible from `fromDir`: the first
 * `node_modules/@bytecodealliance/jco` walking up. Node's lookup, done by
 * hand because the package does not export `./package.json` and runtime
 * resolvers may fall back to global caches.
 */
function jcoPackageRoot(fromDir: string): string | undefined {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...JCO_PACKAGE.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function readJcoPackage(root: string): { bin: string | undefined; version: string | undefined } {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return { bin: undefined, version: undefined };
  }
  if (!isRecord(pkg)) return { bin: undefined, version: undefined };
  const bin =
    typeof pkg.bin === "string"
      ? pkg.bin
      : isRecord(pkg.bin) && typeof pkg.bin.jco === "string"
        ? pkg.bin.jco
        : undefined;
  return { bin, version: typeof pkg.version === "string" ? pkg.version : undefined };
}

/**
 * Find how to invoke `jco`:
 *
 *  1. The project's own `node_modules/.bin/jco` — an explicit override, so a
 *     project can pin a different jco.
 *  2. The CLI's own `@bytecodealliance/jco` (an optional peer dependency
 *     pinned to `JCO_VERSION`), run with the runtime executing the CLI.
 *
 * There is deliberately no `bunx`/`npx` fallback: that fetched an unpinned
 * jco (~350 MB with its toolchain) on every machine.
 */
export function findJco(
  projectDir: string,
  cliDir: string = dirname(fileURLToPath(import.meta.url))
): ToolLookup<JcoTool> {
  const local = join(projectDir, "node_modules", ".bin", "jco");
  if (existsSync(local)) {
    const projectPkg = join(projectDir, "node_modules", ...JCO_PACKAGE.split("/"));
    return {
      status: "found",
      tool: { cmd: local, pre: [], origin: "project", version: readJcoPackage(projectPkg).version },
    };
  }
  const root = jcoPackageRoot(cliDir);
  if (root !== undefined) {
    const { bin, version } = readJcoPackage(root);
    if (bin !== undefined) {
      return {
        status: "found",
        tool: { cmd: process.execPath, pre: [join(root, bin)], origin: "cli", version },
      };
    }
  }
  return {
    status: "missing",
    name: JCO_PACKAGE,
    neededFor: "The TypeScript wasm target",
    hint:
      `install it in the project: bun add -d ${JCO_PACKAGE}@${JCO_VERSION} ` +
      `(or npm install -D ${JCO_PACKAGE}@${JCO_VERSION})`,
  };
}

/**
 * `findJco`, unwrapped.
 * @throws {BuildError} `TOOLCHAIN_MISSING` with the pinned install command.
 */
export function resolveJco(projectDir: string, cliDir?: string): JcoTool {
  return requireTool(findJco(projectDir, cliDir));
}

// ── TinyGo / Go ──────────────────────────────────────────────────────────────

/**
 * TinyGo 0.39.0 is the first release with Go 1.25 support (its CHANGELOG:
 * "all: add Go 1.25 support"); hypen-golang's go.mod says `go 1.25.0`.
 */
export const TINYGO_MIN_VERSION = "0.39";

const TINYGO_INSTALL =
  `install TinyGo >= ${TINYGO_MIN_VERSION} (the first release supporting Go 1.25, which the ` +
  `Hypen Go SDK requires): https://tinygo.org/getting-started/install/`;

export interface GoToolchain {
  /** `tinygo version`'s number, when it could be parsed. */
  tinygoVersion: string | undefined;
}

/** Find `tinygo` (>= `TINYGO_MIN_VERSION`), `wit-bindgen-go` and `go` on PATH. */
export async function findGoToolchain(cwd: string): Promise<ToolLookup<GoToolchain>> {
  const neededFor = "The Go wasm target";
  const tinygo = await probe("tinygo", ["version"], cwd);
  if (tinygo === undefined) {
    return { status: "missing", name: "tinygo", neededFor, hint: TINYGO_INSTALL };
  }
  const tinygoVersion = tinygo.match(/tinygo version (\S+)/)?.[1];
  const parsed = tinygoVersion === undefined ? undefined : parseVersion(tinygoVersion);
  const required = parseVersion(TINYGO_MIN_VERSION);
  // An unparseable version (a custom build) is let through: the compile
  // itself will say so if it is too old.
  if (tinygoVersion !== undefined && parsed && required && !atLeast(parsed, required)) {
    return {
      status: "outdated",
      name: "tinygo",
      neededFor,
      found: tinygoVersion,
      required: TINYGO_MIN_VERSION,
      hint: TINYGO_INSTALL,
    };
  }
  if ((await probe("wit-bindgen-go", ["--help"], cwd)) === undefined) {
    return {
      status: "missing",
      name: "wit-bindgen-go",
      neededFor,
      hint: "install it: go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest (and put $(go env GOPATH)/bin on PATH)",
    };
  }
  if ((await probe("go", ["version"], cwd)) === undefined) {
    return { status: "missing", name: "go", neededFor, hint: "install Go >= 1.25: https://go.dev/dl/" };
  }
  return { status: "found", tool: { tinygoVersion } };
}

// ── cargo (Rust) ─────────────────────────────────────────────────────────────

/** The Rust target whose output is a WASI 0.2 component. */
export const RUST_WASM_TARGET = "wasm32-wasip2";

/** rustc 1.82 is the first stable release whose wasm32-wasip2 target links a Component directly. */
export const RUSTC_MIN_VERSION = "1.82";

export interface RustToolchain {
  rustcVersion: string | undefined;
}

/**
 * Find `cargo` and check the toolchain *as selected in `crateDir`* (a
 * `rust-toolchain.toml` there changes which rustc the rustup proxy runs):
 * rustc >= `RUSTC_MIN_VERSION` with the `wasm32-wasip2` target installed.
 * Without the target, cargo fails with "can't find crate for `core`", which
 * says nothing about the fix.
 */
export async function findRustToolchain(crateDir: string): Promise<ToolLookup<RustToolchain>> {
  const neededFor = "The Rust wasm target";
  if ((await probe("cargo", ["--version"], crateDir)) === undefined) {
    return { status: "missing", name: "cargo", neededFor, hint: "install Rust: https://rustup.rs" };
  }
  const rustc = await runTool("rustc", ["--version"], { cwd: crateDir, output: "quiet" });
  // No rustc beside cargo (an unusual install): let cargo report what it finds.
  if (rustc.status !== "ok") return { status: "found", tool: { rustcVersion: undefined } };
  const rustcVersion = rustc.stdout.match(/rustc (\S+)/)?.[1];
  const parsed = rustcVersion === undefined ? undefined : parseVersion(rustcVersion);
  const required = parseVersion(RUSTC_MIN_VERSION);
  if (rustcVersion !== undefined && parsed && required && !atLeast(parsed, required)) {
    return {
      status: "outdated",
      name: "rustc",
      neededFor,
      found: rustcVersion,
      required: RUSTC_MIN_VERSION,
      hint: "update Rust: rustup update stable",
    };
  }
  const sysroot = await runTool("rustc", ["--print", "sysroot"], { cwd: crateDir, output: "quiet" });
  if (
    sysroot.status === "ok" &&
    sysroot.stdout.trim() !== "" &&
    !existsSync(join(sysroot.stdout.trim(), "lib", "rustlib", RUST_WASM_TARGET))
  ) {
    return {
      status: "missing",
      name: `the ${RUST_WASM_TARGET} Rust target`,
      neededFor,
      hint: `install it: rustup target add ${RUST_WASM_TARGET}`,
    };
  }
  return { status: "found", tool: { rustcVersion } };
}
