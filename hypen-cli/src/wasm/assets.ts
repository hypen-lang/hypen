/**
 * Locating the files the CLI ships next to its code: the vendored WIT
 * packages and the shim sources.
 *
 * The same module runs from three places, and `import.meta.url` differs in
 * each, so every lookup walks a short list of candidates:
 *
 *   - `src/wasm/assets.ts`      — running from source (`bun bin/hypen.ts`)
 *   - `dist/src/build-wasm.js`  — the built library entry (this file inlined)
 *   - `dist/bin/hypen.js`       — the built bin (this file inlined)
 *
 * WIT dirs live at the package root (`files` in package.json). Shims live in
 * `src/wasm/shims/` and are copied/compiled to `dist/src/wasm/shims/` by
 * `build.ts`.
 */

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { BuildError } from "../build-error.js";
import type { Abi } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function missing(what: string, searched: string[]): BuildError {
  return new BuildError(`Could not locate ${what}, which ships with the CLI.`, {
    code: "CLI_ASSET_MISSING",
    detail: ["searched:", ...searched.map((s) => `  ${s}`)],
    hint: "the CLI install is incomplete: reinstall @hypen-space/cli",
  });
}

function firstExisting(what: string, candidates: string[]): string {
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw missing(what, candidates);
  return found;
}

/** A WIT package directory shipped with the CLI. */
export type WitPackage =
  /** `hypen:module@0.1` — the sync reducer world TS and Rust build against. */
  | "module-0.1"
  /** `hypen:module@0.2` — the CM-async world. */
  | "module-0.2"
  /** `hypen:module@0.1` plus the wasi:* imports TinyGo's runtime needs. */
  | "tinygo";

const WIT_PACKAGES: Record<WitPackage, { dir: string; marker: string }> = {
  "module-0.1": { dir: "wit", marker: "hypen-module.wit" },
  "module-0.2": { dir: "wit-v0_2", marker: "hypen-module.wit" },
  tinygo: { dir: "wit-tinygo", marker: "world.wit" },
};

/** Absolute path of a bundled WIT package directory. */
export function bundledWitDir(pkg: WitPackage): string {
  const { dir, marker } = WIT_PACKAGES[pkg];
  const candidates = ["..", join("..", ".."), join("..", "..", "..")].map((up) =>
    resolve(HERE, up, dir)
  );
  const found = candidates.find((c) => existsSync(join(c, marker)));
  if (found === undefined) throw missing(`the bundled WIT directory ${dir}/${marker}`, candidates);
  return found;
}

/** The bundled `hypen:module` WIT for an ABI. */
export function bundledModuleWit(abi: Abi): string {
  return bundledWitDir(abi === "0.2" ? "module-0.2" : "module-0.1");
}

/** Directories that may hold the shims, most specific first. */
function shimDirs(): string[] {
  return [
    join(HERE, "shims"), // src/wasm/
    join(HERE, "wasm", "shims"), // dist/src/
    resolve(HERE, "..", "src", "wasm", "shims"), // dist/bin/
    resolve(HERE, "..", "..", "src", "wasm", "shims"), // dist/* → the shipped src/
  ];
}

/**
 * The TS shim module the generated entry file imports. A built CLI ships it
 * precompiled (`.js`), so bundling it in a user's project never depends on
 * how that project's tsconfig would have transpiled the `.ts`.
 */
export function tsShimPath(): string {
  return firstExisting(
    "the TypeScript module shim (module-shim)",
    shimDirs().flatMap((d) => [join(d, "module-shim.js"), join(d, "module-shim.ts")])
  );
}

/** The Go shim template (`renderGoShim` fills in its import paths). */
export function goShimTemplatePath(): string {
  return firstExisting(
    "the Go module shim template (module_shim.go)",
    shimDirs().map((d) => join(d, "module_shim.go"))
  );
}
