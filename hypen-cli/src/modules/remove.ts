/**
 * `hypen remove <package | Module>`: undo `hypen add`. Removes the
 * hypen.json entry and the lock record. It never deletes files of yours:
 * a package directory or an extracted tarball is left where it is (and the
 * command says so); an npm dependency is removed only when asked.
 */

import { BuildError } from "../build-error.js";
import { bold, dim, pink } from "../colors.js";
import { packageField, type PackageDeclaration } from "../wasm/config.js";
import { isPathSpec, locateModulePackage, readModulePackage, type ModuleLock } from "../wasm/module-package.js";
import { selectFromPackage, withPackageErrors } from "../wasm/packages.js";
import { removeJsonPath, setJsonPath } from "./json-edit.js";
import { isDependency, uninstallPackage } from "./pm.js";
import type { Prompter } from "./prompter.js";
import { openAppProject, saveAppProject } from "./store.js";

export interface RemoveOptions {
  projectDir: string;
  /** A `wasm.packages` key, or the name of one installed module / component. */
  target: string;
  /** Also remove the npm dependency (asked interactively when unset). */
  uninstall?: boolean;
  prompter: Prompter;
}

export interface RemoveResult {
  /** The package entry that was changed or removed. */
  from: string | null;
  /** The whole package entry is gone. */
  removedPackage: boolean;
  /** Names that are no longer installed. */
  removed: string[];
  /** The npm dependency was removed too. */
  uninstalled: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function removePackage(options: RemoveOptions): Promise<RemoveResult> {
  const { prompter, target } = options;
  const say = (line: string): void => prompter.say(line);
  const project = openAppProject(options.projectDir);
  const { config } = project;

  const whole = async (decl: PackageDeclaration, names: string[]): Promise<RemoveResult> => {
    const text = removeJsonPath(project.text, ["wasm", "packages", decl.from], 0);
    const lock: ModuleLock = { ...project.lock };
    delete lock[decl.from];
    saveAppProject(project, text, lock);
    say(`  ${pink("Removed")} ${bold(decl.from)} ${dim(`(${names.join(", ") || "no modules"}) from hypen.json`)}`);
    let uninstalled = false;
    if (decl.source) {
      say(`  ${dim(`The module project at ${decl.from} was not touched.`)}`);
    } else if (isPathSpec(decl.from)) {
      say(`  ${dim(`The files at ${decl.from} were left in place — delete them yourself if nothing else needs them.`)}`);
    } else if (isDependency(project.dir, decl.from)) {
      const remove =
        options.uninstall ??
        (prompter.interactive && /^y(es)?$/i.test((await prompter.ask(`  Also remove the dependency ${decl.from} from package.json? [y/N] `)).trim()));
      if (remove) {
        const command = await uninstallPackage(project.dir, decl.from);
        uninstalled = true;
        say(`  ${dim(`Removed the dependency: ${command.join(" ")}`)}`);
      } else {
        say(`  ${dim(`The dependency ${decl.from} is still in package.json (remove it with --uninstall, or your package manager).`)}`);
      }
    }
    say("");
    return { from: decl.from, removedPackage: true, removed: names, uninstalled };
  };

  const namesOf = (decl: PackageDeclaration): { modules: string[]; components: string[] } | null => {
    if (decl.source) return null;
    try {
      const pkg = readModulePackage(locateModulePackage(decl.from, project.dir).manifestPath);
      const selection = selectFromPackage(pkg, decl.only, decl.from, decl.field);
      return { modules: selection.modules.map((m) => m.name), components: selection.components.map((c) => c.name) };
    } catch {
      // A package whose files are gone can still be removed by its key.
      return null;
    }
  };

  const direct = config.packages.get(target);
  if (direct !== undefined) {
    const names = namesOf(direct);
    return whole(direct, names ? [...names.modules, ...names.components] : [...direct.grants.keys()]);
  }

  // A single module / component of an installed package.
  for (const decl of config.packages.values()) {
    const names = namesOf(decl);
    if (names === null) continue;
    const all = [...names.modules, ...names.components];
    const renamedFrom = [...decl.as].find(([, renamed]) => same(renamed, target))?.[0];
    const name = all.find((n) => same(n, renamedFrom ?? target));
    if (name === undefined) continue;
    const rest = all.filter((n) => n !== name);
    if (rest.length === 0) return whole(decl, all);
    // What stays must still be complete without it.
    const pkg = withPackageErrors(() => readModulePackage(locateModulePackage(decl.from, project.dir).manifestPath));
    selectFromPackage(pkg, rest, decl.from, `${packageField(decl.from)}.only`);
    let text = setJsonPath(project.text, ["wasm", "packages", decl.from, "only"], rest);
    text = removeJsonPath(text, ["wasm", "packages", decl.from, "grants", name], 3);
    text = removeJsonPath(text, ["wasm", "packages", decl.from, "as", name], 3);
    text = removeJsonPath(text, ["wasm", "packages", decl.from, "map", name], 3);
    const lock: ModuleLock = { ...project.lock };
    const locked = lock[decl.from];
    if (locked !== undefined) {
      const modules = { ...locked.modules };
      delete modules[name];
      lock[decl.from] = { ...locked, modules };
    }
    saveAppProject(project, text, lock);
    say(`  ${pink("Removed")} ${bold(name)} ${dim(`from ${decl.from} (still installed: ${rest.join(", ")})`)}`);
    say("");
    return { from: decl.from, removedPackage: false, removed: [name], uninstalled: false };
  }

  // The low-level form: a hand-declared prebuilt module.
  const legacy = [...config.modules].find(([name, entry]) => same(name, target) && entry.prebuilt !== undefined);
  if (legacy !== undefined) {
    const [name, entry] = legacy;
    saveAppProject(project, removeJsonPath(project.text, ["wasm", "modules", name], 0), project.lock);
    say(`  ${pink("Removed")} ${bold(name)} ${dim("(wasm.modules entry) from hypen.json")}`);
    say(`  ${dim(`Its files (${entry.prebuilt?.component}) were left in place.`)}`);
    say("");
    return { from: null, removedPackage: false, removed: [name], uninstalled: false };
  }

  const installed = [...config.packages.keys()];
  throw new BuildError(`"${target}" is not installed in this app.`, {
    code: "NOT_INSTALLED",
    file: project.file,
    hint:
      installed.length > 0
        ? `installed packages: ${installed.join(", ")} — run \`hypen modules\` to see their modules`
        : "this app has no module packages (hypen.json has no wasm.packages)",
  });
}
