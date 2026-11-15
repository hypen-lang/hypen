/**
 * The output directory's lifecycle. A build never writes into
 * `<outDir>/wasm` directly: it works in a private directory next to it and
 * swaps the finished tree in at the end. So a failed or interrupted build
 * leaves the previous output intact, and two builds racing for one `outDir`
 * each publish a complete tree (the last one wins) instead of interleaving
 * files.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { BuildError } from "../build-error.js";
import { MANIFEST_FILE } from "./manifest.js";
import type { Project } from "./types.js";

/** The directory `--keep-temp` leaves behind, relative to `outDir`. */
export const KEPT_TEMP_DIR = ".wasm-temp";

/** Prefix of per-build private directories: `<prefix><pid>-<random>`. */
const WORK_PREFIX = ".wasm-temp-";
const RETIRED_PREFIX = ".wasm-old-";

/** True when `inner` is `outer` or lies beneath it. */
function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unsafe(message: string, hint: string): BuildError {
  return new BuildError(message, { code: "OUTDIR_UNSAFE", field: "outDir", hint });
}

/**
 * Refuse an output location that publishing would damage. `<outDir>/wasm` is
 * *replaced* on every build, so it must not hold (or be held by) sources, and
 * an existing directory there must look like a previous build's output.
 */
export function assertSafeOutput(outWasmDir: string, project: Project): void {
  const elsewhere = `choose an output directory that holds only build output (e.g. "outDir": "dist")`;
  if (isWithin(project.componentsDir, outWasmDir) || isWithin(project.projectDir, outWasmDir)) {
    throw unsafe(
      `The output directory ${outWasmDir} contains the project's sources; building would delete them.`,
      elsewhere
    );
  }
  if (isWithin(outWasmDir, project.componentsDir)) {
    throw unsafe(
      `The output directory ${outWasmDir} is inside the components directory ${project.componentsDir}; ` +
        `build output would be picked up as components.`,
      elsewhere
    );
  }
  if (!existsSync(outWasmDir)) return;
  if (!statSync(outWasmDir).isDirectory()) {
    throw unsafe(`${outWasmDir} exists and is not a directory.`, `remove it, or ${elsewhere}`);
  }
  // A previous build's output holds only components, templates and the
  // manifest. Anything else was put there by someone, and replacing the
  // directory would delete it.
  const foreign = readdirSync(outWasmDir).filter(
    (f) => f !== MANIFEST_FILE && !f.endsWith(".wasm") && !f.endsWith(".hypen")
  );
  if (foreign.length > 0) {
    throw unsafe(
      `${outWasmDir} holds files that are not wasm build output (${foreign.slice(0, 3).join(", ")}` +
        `${foreign.length > 3 ? ", …" : ""}); the build replaces this directory and would delete them.`,
      `move those files away, or ${elsewhere}`
    );
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

/**
 * Remove private directories left by builds that died without cleaning up
 * (SIGKILL, power loss). Each name embeds its owner's pid, so a directory
 * whose process is gone is safe to delete while a live concurrent build's is
 * left alone.
 */
function sweepAbandoned(outDir: string): void {
  for (const name of readdirSync(outDir)) {
    const prefix = [WORK_PREFIX, RETIRED_PREFIX].find((p) => name.startsWith(p));
    if (prefix === undefined) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0]);
    if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) {
      rmSync(join(outDir, name), { recursive: true, force: true });
    }
  }
}

/** A build's private directories under `outDir`. */
export interface Staging {
  /** Scratch space for intermediates (shims, bundles, per-module WIT). */
  workDir: string;
  /** The tree that becomes `<outDir>/wasm`. */
  stageDir: string;
  /** Swap `stageDir` in as `outWasmDir`. */
  publish(): void;
  /**
   * Remove the private directories — or, with `keepTemp`, leave the
   * intermediates at `<outDir>/.wasm-temp`. Safe to call more than once.
   */
  dispose(): void;
}

/**
 * Create the build's private directories inside `outDir` (same filesystem as
 * the final location, so publishing is a rename, not a copy).
 *
 * @throws {BuildError} `OUTDIR_NOT_WRITABLE` when `outDir` cannot be created
 *   or written to.
 */
export function createStaging(outDir: string, outWasmDir: string, keepTemp: boolean): Staging {
  const createdOutDir = !existsSync(outDir);
  let workDir: string;
  try {
    mkdirSync(outDir, { recursive: true });
    sweepAbandoned(outDir);
    workDir = mkdtempSync(join(outDir, `${WORK_PREFIX}${process.pid}-`));
  } catch (cause) {
    throw new BuildError(
      `Cannot write to the output directory ${outDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        code: "OUTDIR_NOT_WRITABLE",
        file: outDir,
        field: "outDir",
        hint: `check the directory's permissions, or pass another one with --out-dir`,
        cause,
      }
    );
  }
  const stageDir = join(workDir, "out");
  mkdirSync(stageDir);
  let disposed = false;

  return {
    workDir,
    stageDir,

    publish() {
      mkdirSync(dirname(outWasmDir), { recursive: true });
      const retired = join(outDir, RETIRED_PREFIX + basename(workDir).slice(WORK_PREFIX.length));
      // A concurrent build may publish between retiring the old tree and
      // renaming the new one in (rename onto a non-empty directory fails), so
      // retry: whichever build goes last replaces the other's complete tree.
      for (let attempt = 0; ; attempt++) {
        try {
          if (existsSync(outWasmDir)) {
            rmSync(retired, { recursive: true, force: true });
            renameSync(outWasmDir, retired);
          }
          renameSync(stageDir, outWasmDir);
          break;
        } catch (cause) {
          if (attempt >= 4) {
            throw new BuildError(
              `Could not move the build output into place at ${outWasmDir}: ` +
                `${cause instanceof Error ? cause.message : String(cause)}`,
              {
                code: "OUTDIR_NOT_WRITABLE",
                file: outWasmDir,
                hint: "another process is writing to the same output directory: re-run the build once it has finished",
                cause,
              }
            );
          }
        }
      }
      rmSync(retired, { recursive: true, force: true });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (keepTemp) {
        const kept = join(outDir, KEPT_TEMP_DIR);
        rmSync(kept, { recursive: true, force: true });
        // After a failed build this still holds whatever was staged — part
        // of what `--keep-temp` is for.
        renameSync(workDir, kept);
        return;
      }
      rmSync(workDir, { recursive: true, force: true });
      // Don't leave an empty `outDir` behind a build that produced nothing.
      if (createdOutDir) {
        try {
          rmdirSync(outDir);
        } catch {
          // Not empty (the build published, or something else wrote here).
        }
      }
    },
  };
}
