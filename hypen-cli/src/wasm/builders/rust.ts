/**
 * Rust pipeline. Each module is a crate implementing the `hypen:module`
 * world directly (`wit_bindgen::generate!` + `impl Guest` — Rust's idiomatic
 * component path). The CLI provisions the crate's `wit/`, runs
 * `cargo build --release --target wasm32-wasip2` (which links a Component
 * natively, so no `wasm-tools component new` step) and copies the artifact.
 *
 * There is no app-mode shim for Rust: the high-level `hypen-server` authoring
 * API is server-oriented and its engine dependency isn't wasip2-buildable
 * (see wit/AUTHORING_MODEL.md).
 */

import { copyFileSync, existsSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { BuildError } from "../../build-error.js";
import { assertComponent } from "../artifact.js";
import { assertNoForeignModule, scanComponentDirs } from "../discover.js";
import { wasmFileName } from "../manifest.js";
import { expectSuccess, runTool } from "../process.js";
import { RUST_WASM_TARGET, findRustToolchain, requireTool } from "../toolchain.js";
import { isRecord, parseModuleName, type Abi, type Discovery, type StatefulModule } from "../types.js";
import { PROVISIONED_MARKER, provisionRustWit, vendoredWitDeclaresModule } from "../wit.js";
import type { ModuleBuilder } from "./builder.js";

/** What a Rust module is built from. */
export interface RustSource {
  /** Absolute path of the directory holding the module's `Cargo.toml`. */
  crateDir: string;
}

/**
 * Collect components for a Rust project. Two layouts, auto-detected:
 *
 *  - **multi-module** — any component directory with its own `Cargo.toml` is
 *    a stateful module crate (typically members of a Cargo workspace); a
 *    directory with only a `.hypen` is stateless.
 *  - **single-crate** — no component directory carries a `Cargo.toml`, so the
 *    project's root crate is the one stateful module, named by `entry`; every
 *    other component is stateless.
 */
export function collectRustComponents(
  componentsDir: string,
  entry: string,
  projectDir: string,
  prebuilt?: ReadonlySet<string>
): Discovery<RustSource> {
  const found: Discovery<RustSource> = { stateful: [], stateless: [] };
  const dirs = scanComponentDirs(componentsDir);
  const multiModule = dirs.some((c) => c.sources.rust);
  for (const c of dirs) {
    const name = parseModuleName(c.name);
    const crateDir = multiModule ? (c.sources.rust ? c.dir : undefined) : c.name === entry ? projectDir : undefined;
    if (crateDir === undefined) {
      assertNoForeignModule(c, "rust", prebuilt);
      found.stateless.push({ kind: "stateless", name, template: c.template });
    } else {
      found.stateful.push({ kind: "stateful", name, template: c.template, source: { crateDir } });
    }
  }
  return found;
}

/** Explicit `[package.metadata.hypen] abi = "..."` from `Cargo.toml`, if any. */
function cargoMetadataAbi(crateDir: string): Abi | undefined {
  const cargoToml = join(crateDir, "Cargo.toml");
  if (!existsSync(cargoToml)) return undefined;
  const toml = readFileSync(cargoToml, "utf8");
  const metaIdx = toml.indexOf("[package.metadata.hypen]");
  if (metaIdx < 0) return undefined;
  const nextSection = toml.indexOf("\n[", metaIdx + 1);
  const scope = toml.slice(metaIdx, nextSection === -1 ? undefined : nextSection);
  const declared = scope.match(/^\s*abi\s*=\s*"([^"]+)"/m)?.[1];
  if (declared === undefined) return undefined;
  if (declared === "0.1" || declared.startsWith("0.1.")) return "0.1";
  if (declared === "0.2" || declared.startsWith("0.2.")) return "0.2";
  throw new BuildError(
    `${cargoToml}: [package.metadata.hypen] abi = "${declared}" is not a known hypen:module ABI (expected "0.1" or "0.2")`,
    {
      code: "ABI_UNKNOWN",
      file: cargoToml,
      field: "package.metadata.hypen.abi",
      hint: `set abi = "0.1" (sync reducer) or abi = "0.2" (CM-async), or remove the line for the default (0.1)`,
    }
  );
}

/**
 * Which `hypen:module` ABI a Rust crate targets.
 *
 * - `"0.2"` — the CM-async world (WASI 0.3): `async fn` reducer exports that
 *   `await` capability imports inline. Requires a CM-async host
 *   (`WasmtimeHostAsync`; `hypen-runtime` auto-detects it).
 * - `"0.1"` — the default sync reducer + effect-descriptor world.
 *
 * In priority order:
 *  1. An explicit `[package.metadata.hypen] abi = "0.1" | "0.2"` in
 *     `Cargo.toml` — always wins, so switching the ABI there takes effect
 *     even over a previously provisioned `wit/`.
 *  2. A crate `wit/hypen-module.wit` declaring `hypen:module@0.2`, unless
 *     that `wit/` carries the CLI's provisioning marker (a provisioned copy
 *     reflects an earlier build's choice, not the author's intent).
 *  3. `"0.1"`.
 */
export function rustCrateAbi(crateDir: string): Abi {
  const explicit = cargoMetadataAbi(crateDir);
  if (explicit !== undefined) return explicit;
  const witDir = join(crateDir, "wit");
  const vendored = join(witDir, "hypen-module.wit");
  if (
    existsSync(vendored) &&
    !existsSync(join(witDir, PROVISIONED_MARKER)) &&
    readFileSync(vendored, "utf8").includes("hypen:module@0.2")
  ) {
    return "0.2";
  }
  return "0.1";
}

/** `realpath`, or the resolved path when the file does not exist. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The fields of a cargo JSON message / metadata target this build reads. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Pick the crate's cdylib `.wasm` from `cargo build --message-format=json`
 * output: the `compiler-artifact` message whose `manifest_path` is the
 * crate's own `Cargo.toml` and whose target is a `cdylib`. Using cargo's own
 * report (rather than guessing `target/<triple>/release/<name>.wasm`) honors
 * `[lib] name`, `CARGO_TARGET_DIR`, and workspace target dirs, and can't pick
 * up a stale artifact from an earlier build.
 */
export function cdylibWasmFromCargoMessages(stdout: string, manifestPath: string): string | null {
  const want = canonical(manifestPath);
  let found: string | null = null;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(message) || message.reason !== "compiler-artifact") continue;
    if (typeof message.manifest_path !== "string" || canonical(message.manifest_path) !== want) continue;
    const kinds = isRecord(message.target) ? stringArray(message.target.kind) : [];
    if (!kinds.includes("cdylib")) continue;
    const wasm = stringArray(message.filenames).find((f) => f.endsWith(".wasm"));
    if (wasm !== undefined) found = wasm;
  }
  return found;
}

/**
 * The crate types of the package at `manifestPath`, from `cargo metadata`
 * output; `undefined` when the output does not describe that package.
 */
export function crateTypesFromCargoMetadata(stdout: string, manifestPath: string): string[] | undefined {
  let metadata: unknown;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(metadata) || !Array.isArray(metadata.packages)) return undefined;
  const want = canonical(manifestPath);
  for (const pkg of metadata.packages) {
    if (!isRecord(pkg) || typeof pkg.manifest_path !== "string") continue;
    if (canonical(pkg.manifest_path) !== want) continue;
    const targets = Array.isArray(pkg.targets) ? pkg.targets : [];
    return targets.flatMap((t: unknown) => (isRecord(t) ? stringArray(t.crate_types) : []));
  }
  return undefined;
}

const CDYLIB_HINT = `add to Cargo.toml:  [lib]  crate-type = ["cdylib"]`;

/**
 * Fail before compiling if the crate cannot produce a component: a missing
 * manifest, one cargo cannot read, or a library that is not a `cdylib` (an
 * `rlib` builds fine and yields no `.wasm` — minutes later).
 */
async function assertComponentCrate(module: StatefulModule<RustSource>): Promise<void> {
  const { crateDir } = module.source;
  const manifestPath = join(crateDir, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    throw new BuildError(`A Rust wasm build needs a Cargo.toml for ${module.name}, but ${manifestPath} does not exist.`, {
      code: "RUST_CRATE_INVALID",
      module: module.name,
      file: manifestPath,
      hint: `create the crate (cargo init --lib), or set "wasm": { "language": "ts" | "go" } in hypen.json if this is not a Rust project`,
    });
  }
  const run = await runTool(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath],
    { cwd: crateDir, output: "quiet" }
  );
  const { stdout } = expectSuccess(run, "cargo metadata", {
    module: module.name,
    file: manifestPath,
    hint: "cargo could not read the crate's manifest: fix the error it reports",
  });
  const crateTypes = crateTypesFromCargoMetadata(stdout, manifestPath);
  // `undefined`: cargo did not describe this manifest as a package (a virtual
  // workspace root). The build itself reports that better than a guess here.
  if (crateTypes !== undefined && !crateTypes.includes("cdylib")) {
    throw new BuildError(
      `The crate for ${module.name} is not a cdylib (crate types: ${crateTypes.join(", ") || "none"}), ` +
        `so cargo would not produce a .wasm component for it.`,
      { code: "RUST_CRATE_INVALID", module: module.name, file: manifestPath, hint: CDYLIB_HINT }
    );
  }
}

export const rustBuilder: ModuleBuilder<RustSource, void> = {
  language: "rust",
  label: "Rust (cargo)",

  async discover(project) {
    return collectRustComponents(project.componentsDir, project.entry, project.projectDir, project.prebuilt);
  },

  entryHint: (entry) =>
    `a Rust wasm build needs ${entry}/${entry}.hypen (or ${entry}/component.hypen): the crate is the entry module`,

  async prepare(ctx, modules) {
    // Every check that can fail runs before any crate's wit/ is touched.
    for (const module of modules) {
      requireTool(await findRustToolchain(module.source.crateDir));
      await assertComponentCrate(module);
    }
    for (const module of modules) {
      const { crateDir } = module.source;
      // Per-crate ABI: a crate opting into the CM-async world gets the v0.2
      // package; wit-bindgen then generates async bindings from the WIT
      // itself — no extra codegen flags.
      const abi = rustCrateAbi(crateDir);
      if (abi === "0.2") ctx.log(`${module.name}: hypen:module@0.2.0 (CM-async)`);
      const did = provisionRustWit(crateDir, abi);
      if (did === "provisioned" || did === "refreshed") {
        ctx.log(`${module.name}: ${did} wit/ (hypen:module@${abi}) from the CLI`);
      } else if (did === "vendored" && !vendoredWitDeclaresModule(crateDir)) {
        ctx.log(
          `${module.name}: warning: ${join(crateDir, "wit")} is not CLI-provisioned and declares no ` +
            `hypen:module package; if the build cannot find the "module" world, delete it to let the CLI provision one`
        );
      }
    }
  },

  async build(ctx, _prepared, module) {
    const { crateDir } = module.source;
    const manifestPath = join(crateDir, "Cargo.toml");
    // `json-render-diagnostics`: compiler errors still render human-readable
    // on stderr; stdout carries only the JSON messages parsed below.
    const run = await runTool(
      "cargo",
      [
        "build",
        "--release",
        "--target",
        RUST_WASM_TARGET,
        "--manifest-path",
        manifestPath,
        "--message-format=json-render-diagnostics",
      ],
      {
        cwd: crateDir,
        output: "stream",
        captureStdout: true,
        // cargo drops color when stderr is a pipe; ask for it back when the
        // user's terminal would have shown it.
        env:
          process.stderr.isTTY && process.env.CARGO_TERM_COLOR === undefined && process.env.NO_COLOR === undefined
            ? { CARGO_TERM_COLOR: "always" }
            : undefined,
      }
    );
    const { stdout } = expectSuccess(run, "cargo build", {
      module: module.name,
      file: manifestPath,
      hint: "fix the compile errors above",
    });
    const built = cdylibWasmFromCargoMessages(stdout, manifestPath);
    if (built === null || !existsSync(built)) {
      throw new BuildError(`cargo reported no cdylib .wasm for the crate at ${crateDir}.`, {
        code: "TOOL_NO_OUTPUT",
        module: module.name,
        file: manifestPath,
        hint: `${CDYLIB_HINT}, and check the ${RUST_WASM_TARGET} target is installed (rustup target add ${RUST_WASM_TARGET})`,
      });
    }
    const wasmPath = join(ctx.stageDir, wasmFileName(module.name));
    copyFileSync(built, wasmPath);
    assertComponent(wasmPath, module.name, "cargo build", {
      noOutput: "re-run the build",
      notComponent: `the ${RUST_WASM_TARGET} target links a Component from rustc 1.82 on: update Rust (rustup update stable)`,
    });
    return { name: module.name, wasmPath };
  },
};
