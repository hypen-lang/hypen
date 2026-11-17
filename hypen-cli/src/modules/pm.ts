/**
 * The project's package manager, for `hypen add <npm spec>` and
 * `hypen remove`. Adding a module package must not run anything from it:
 * every add passes the manager's ignore-scripts flag, so no `preinstall` /
 * `install` / `postinstall` of the package (or of what it depends on) runs.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BuildError } from "../build-error.js";
import { runTool } from "../wasm/process.js";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function readJson(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Which package manager the project uses: its `packageManager` field, else
 * its lockfile, else Bun (what `hypen init` installs with).
 */
export function detectPackageManager(projectDir: string): PackageManager {
  const declared = readJson(join(projectDir, "package.json")).packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    const known = (["bun", "npm", "pnpm", "yarn"] as const).find((pm) => pm === name);
    if (known) return known;
  }
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(projectDir, file))) return pm;
  }
  return "bun";
}

/** The command that adds `spec` WITHOUT running lifecycle scripts. */
export function addCommand(pm: PackageManager, spec: string, projectDir: string): string[] {
  switch (pm) {
    case "bun":
      return ["bun", "add", "--ignore-scripts", spec];
    case "npm":
      return ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", spec];
    case "pnpm":
      return ["pnpm", "add", "--ignore-scripts", spec];
    case "yarn":
      // Yarn 2+ has no --ignore-scripts on `add`; `--mode=skip-build` is its equivalent.
      return existsSync(join(projectDir, ".yarnrc.yml"))
        ? ["yarn", "add", "--mode=skip-build", spec]
        : ["yarn", "add", "--ignore-scripts", spec];
  }
}

export function removeCommand(pm: PackageManager, name: string): string[] {
  return pm === "npm" ? ["npm", "uninstall", "--no-audit", "--no-fund", name] : [pm, "remove", name];
}

type Dependencies = Record<string, string>;

function dependenciesOf(projectDir: string): Dependencies {
  const pkg = readJson(join(projectDir, "package.json"));
  const out: Dependencies = {};
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const section = pkg[key];
    if (typeof section !== "object" || section === null) continue;
    for (const [name, range] of Object.entries(section)) if (typeof range === "string") out[name] = range;
  }
  return out;
}

/** The package name an npm spec names, when it says so itself. */
export function nameOfSpec(spec: string): string | undefined {
  const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@.+)?$/i.exec(spec);
  return match?.[1];
}

async function run(command: string[], projectDir: string, what: string, hint: string): Promise<void> {
  const [cmd, ...args] = command as [string, ...string[]];
  const result = await runTool(cmd, args, { cwd: projectDir, output: "quiet" });
  if (result.status === "ok") return;
  const { failure } = result;
  throw new BuildError(
    result.status === "not-started"
      ? `Could not run ${cmd} to ${what}: it is not installed (or not on PATH).`
      : `${cmd} could not ${what} (exit ${failure.exitCode ?? failure.signal ?? "?"}).`,
    {
      code: result.status === "not-started" ? "TOOLCHAIN_MISSING" : "TOOL_FAILED",
      tool: failure,
      file: join(projectDir, "package.json"),
      hint: result.status === "not-started" ? `install ${cmd}, or set "packageManager" in package.json to the one you use` : hint,
    }
  );
}

/**
 * Add `spec` to the project with its package manager, lifecycle scripts
 * disabled, and say which package that was.
 *
 * @throws {BuildError} `TOOL_FAILED` with the manager's stderr tail.
 */
export async function installPackage(projectDir: string, spec: string): Promise<{ name: string; manager: PackageManager; command: string[] }> {
  const manager = detectPackageManager(projectDir);
  const before = dependenciesOf(projectDir);
  const command = addCommand(manager, spec, projectDir);
  await run(
    command,
    projectDir,
    `add ${spec}`,
    "check the package name and your network / registry access; nothing was changed in hypen.json"
  );
  const after = dependenciesOf(projectDir);
  const changed = Object.keys(after).filter((name) => before[name] !== after[name]);
  const name = changed.length === 1 ? changed[0] : (nameOfSpec(spec) ?? changed[0]);
  if (name === undefined) {
    throw new BuildError(`${manager} added ${spec}, but package.json does not say under which name.`, {
      code: "SPEC_NOT_FOUND",
      file: join(projectDir, "package.json"),
      hint: `find the package's name in package.json "dependencies" and run \`hypen add <name>\``,
    });
  }
  return { name, manager, command };
}

/** Remove the dependency `name` with the project's package manager. */
export async function uninstallPackage(projectDir: string, name: string): Promise<string[]> {
  const command = removeCommand(detectPackageManager(projectDir), name);
  await run(command, projectDir, `remove ${name}`, `remove "${name}" from package.json yourself`);
  return command;
}

/** Whether `name` is a dependency of the project. */
export function isDependency(projectDir: string, name: string): boolean {
  return name in dependenciesOf(projectDir);
}
