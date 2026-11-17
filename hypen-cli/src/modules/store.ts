/**
 * Where an app's package decisions live, and how they are written.
 *
 * - `hypen.json` → `wasm.packages.<from>`: the ONE entry per package, plus
 *   the grants the app decided on (`grants.<Module>`). Edited as text so the
 *   rest of the file keeps its formatting.
 * - `hypen.lock.json`: what was reviewed — per package its version and, per
 *   module, the component's integrity and the requests the reviewer saw.
 *   Machine-written, sorted, committed. It is a separate file (not more
 *   keys in hypen.json) so the hand-edited config stays small and a version
 *   bump shows up as its own reviewable diff; it never overlaps the package
 *   manager's lockfile, which pins *which bytes are installed*, not *what
 *   they were allowed to do*.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { BuildError } from "../build-error.js";
import { parseWasmConfig, type WasmConfig } from "../wasm/config.js";
import { MODULE_LOCK_FILE, readModuleLock, serializeModuleLock, type ModuleLock } from "../wasm/module-package.js";
import { withPackageErrors } from "../wasm/packages.js";
import { readProjectConfig, type ProjectConfig } from "../project-config.js";

export interface AppProject extends ProjectConfig {
  /** hypen.json's text (the project must have one). */
  text: string;
  config: WasmConfig;
  lock: ModuleLock;
  /** `entry` is a script: modules are registered in code, not discovered. */
  scriptEntry: boolean;
}

/**
 * Open the app at `projectDir` for a command that edits its packages.
 *
 * @throws {BuildError} when there is no hypen.json, or it / the lock is malformed.
 */
export function openAppProject(projectDir: string): AppProject {
  const project = readProjectConfig(projectDir);
  if (project.text === null) {
    throw new BuildError(`${project.dir} is not a Hypen project: it has no hypen.json.`, {
      code: "CONFIG_INVALID",
      file: project.file,
      hint: "run this inside your app's directory (the one with hypen.json), or create one with `hypen init`",
    });
  }
  return {
    ...project,
    text: project.text,
    config: parseWasmConfig(project.wasm),
    lock: withPackageErrors(() => readModuleLock(project.dir)),
    scriptEntry: /\.(ts|js|mjs)$/.test(project.entry),
  };
}

function writeAtomically(file: string, content: string): void {
  const temp = join(dirname(file), `.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } catch (cause) {
    rmSync(temp, { force: true });
    throw new BuildError(`Cannot write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "CONFIG_NOT_WRITABLE",
      file,
      hint: "check the file's (and its directory's) permissions; nothing was changed",
      cause,
    });
  }
}

/** Write hypen.json and hypen.lock.json; an empty lock removes the file. */
export function saveAppProject(project: AppProject, text: string, lock: ModuleLock): void {
  if (text !== project.text) writeAtomically(project.file, text);
  const lockFile = join(project.dir, MODULE_LOCK_FILE);
  if (Object.keys(lock).length === 0) {
    if (existsSync(lockFile)) rmSync(lockFile);
  } else {
    const content = serializeModuleLock(lock);
    writeAtomically(lockFile, content);
  }
}
