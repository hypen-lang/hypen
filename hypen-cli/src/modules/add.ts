/**
 * `hypen add <spec>`: install a module package someone else built.
 *
 * Nothing from the package runs at add time (no lifecycle scripts, no
 * instantiation), and nothing is granted without an explicit decision: a
 * person answering the consent screen, or flags (`--yes`, `--grant`,
 * `--deny`) in a non-interactive run.
 *
 * Library code: throws `BuildError`, never exits.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { BuildError } from "../build-error.js";
import { bold, boldYellow, dim, pink, yellow } from "../colors.js";
import { linkRequirements, readComponentImports } from "../wasm/component-imports.js";
import { packageField, parseWasmConfig, type WasmConfig } from "../wasm/config.js";
import {
  PACKAGE_MANIFEST_FILE,
  capabilitiesOf,
  capabilityId,
  capabilitySetToJson,
  decideGrant,
  describeCapability,
  isPathSpec,
  locateModulePackage,
  lockEntryOf,
  notCovered,
  planPackageNames,
  readModulePackage,
  type Capability,
  type LockedPackage,
  type ModuleGrant,
  type ModuleLock,
  type ResolvedPackage,
  type ResolvedPackageModule,
} from "../wasm/module-package.js";
import {
  appComponents,
  assertRenamesSound,
  resolveHosted,
  selectFromPackage,
  withPackageErrors,
  type PackageSelection,
} from "../wasm/packages.js";
import { getJsonPath, setJsonPath, JsonEditError } from "./json-edit.js";
import { installPackage } from "./pm.js";
import type { Prompter } from "./prompter.js";
import { openAppProject, saveAppProject, type AppProject } from "./store.js";
import { extractTarball } from "./tar.js";
import { readFileSync } from "fs";

/** What `<spec>` turned out to be. */
export type ModuleSpec =
  /** A package directory, used where it is. */
  | { kind: "dir"; path: string }
  /** A `hypen-modules.json`, used where it is. */
  | { kind: "manifest"; path: string }
  /** A `.tgz`, extracted into the project. */
  | { kind: "tarball"; path: string }
  /** Anything else: handed to the project's package manager. */
  | { kind: "npm"; spec: string }
  /** A package hypen.json already has: reviewed again in place. */
  | { kind: "installed"; from: string };

const posix = (path: string): string => path.split(sep).join("/");

/** `path` as a `wasm.packages` key: relative to the project, starting with `./` or `../`. */
function keyOf(path: string, projectDir: string): string {
  const rel = posix(relative(projectDir, path));
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? rel : `./${rel}`;
}

/**
 * Decide what `spec` is. Paths resolve against `cwd`.
 *
 * @throws {BuildError} `SPEC_NOT_FOUND`
 */
export function classifySpec(spec: string, cwd: string, config: WasmConfig): ModuleSpec {
  if (spec.trim() === "") {
    throw new BuildError("hypen add needs a package: a directory, a .tgz, or an npm package name.", {
      code: "SPEC_NOT_FOUND",
      hint: "e.g. `hypen add @acme/checkout`, `hypen add ./vendor/checkout`, `hypen add ./checkout-1.2.0.tgz`",
    });
  }
  if (config.packages.has(spec) && !config.packages.get(spec)?.source) return { kind: "installed", from: spec };
  if (spec.startsWith("file:")) return { kind: "npm", spec };
  const path = resolve(cwd, spec);
  if (existsSync(path)) {
    if (statSync(path).isDirectory()) return { kind: "dir", path };
    if (/\.(tgz|tar\.gz)$/i.test(path)) return { kind: "tarball", path };
    if (path.endsWith(".json")) return { kind: "manifest", path };
    throw new BuildError(`${path} is not a module package: expected a directory, a ${PACKAGE_MANIFEST_FILE}, or a .tgz.`, {
      code: "SPEC_NOT_FOUND",
      file: path,
      hint: "to install a single .wasm you built yourself, declare it under wasm.modules.<Name>.component in hypen.json",
    });
  }
  if (isPathSpec(spec) || /\.(tgz|tar\.gz|json)$/i.test(spec)) {
    throw new BuildError(`Nothing at ${path}.`, {
      code: "SPEC_NOT_FOUND",
      file: path,
      hint: `"${spec}" looks like a path (resolved against ${cwd}); for an npm package pass its name, e.g. \`hypen add @acme/checkout\``,
    });
  }
  return { kind: "npm", spec };
}

// ── what is asked, and what can be answered ─────────────────────────────────

/** How a `reads` / `dispatches` target resolves in the app. */
type TargetStatus =
  /** Another module of the same package. */
  | "same-package"
  /** A module the app has. */
  | "app"
  /** The app's modules are registered in code; the name cannot be checked. */
  | "unverified"
  /** The app has no such module: it cannot be granted. */
  | "missing";

/** One requested capability of one module, as shown and decided. */
export interface RequestedCapability {
  /** The module's name in the package. */
  module: string;
  capability: Capability;
  /** `Pricing.reads:Cart` — what `--grant` / `--deny` name. */
  id: string;
  status: TargetStatus | "n/a";
  /** The app module a `map` points the target at (`Cart` → the app's `Basket`). */
  mappedTo?: string;
  /** Was not requested when the package was last reviewed. */
  isNew: boolean;
}

/** `map` per package module: the name its code uses → the app's module. */
export type PackageMap = ReadonlyMap<string, Readonly<Record<string, string>>>;

function requested(
  selection: PackageSelection,
  appModules: ReadonlySet<string> | null,
  previous: LockedPackage | undefined,
  map: PackageMap
): RequestedCapability[] {
  const siblings = new Set(selection.modules.map((m) => m.name.toLowerCase()));
  const out: RequestedCapability[] = [];
  for (const module of selection.modules) {
    const before = previous?.modules[module.name];
    const fresh = before === undefined ? [] : notCovered(module.requests, before.requests).map(capabilityId);
    for (const capability of capabilitiesOf(module.requests)) {
      let status: RequestedCapability["status"] = "n/a";
      let mappedTo: string | undefined;
      if (capability.kind === "reads" || capability.kind === "dispatches") {
        const target = capability.target.toLowerCase();
        // A sibling in the package is always the sibling, whatever the app
        // has under that name; any other name is the app's to provide —
        // under that name, or the one a map points it at.
        if (siblings.has(target)) {
          status = "same-package";
        } else {
          mappedTo = Object.entries(map.get(module.name) ?? {}).find(([name]) => name.toLowerCase() === target)?.[1];
          const provided = (mappedTo ?? capability.target).toLowerCase();
          status = appModules === null ? "unverified" : appModules.has(provided) ? "app" : "missing";
        }
      }
      out.push({
        module: module.name,
        capability,
        id: `${module.name}.${capabilityId(capability)}`,
        status,
        ...(mappedTo !== undefined ? { mappedTo } : {}),
        isNew: previous !== undefined && (before === undefined || fresh.includes(capabilityId(capability))),
      });
    }
  }
  return out;
}

/** Whether a `--grant` / `--deny` value names `item`. */
function patternMatches(pattern: string, item: RequestedCapability): boolean {
  const lower = pattern.toLowerCase();
  if (lower === "all") return true;
  // A bare module name selects everything that module requests.
  if (lower === item.module.toLowerCase()) return true;
  const dot = pattern.indexOf(".");
  // `Pricing.http` — but `reads:My.Module` is not a thing: names have no dots.
  const [module, cap] = dot === -1 ? [undefined, lower] : [pattern.slice(0, dot).toLowerCase(), lower.slice(dot + 1)];
  if (module !== undefined && module !== item.module.toLowerCase()) return false;
  if (cap === "all" || cap === "") return true;
  const id = capabilityId(item.capability).toLowerCase();
  return id === cap || id.startsWith(`${cap}:`);
}

function describe(item: RequestedCapability): string {
  const { text, notable } = describeCapability(item.capability);
  const where =
    (item.mappedTo !== undefined ? ` → the app's ${item.mappedTo}` : "") +
    (item.status === "same-package" ? " (same package)" : item.status === "unverified" ? " (not checked: this app registers its modules in code)" : "");
  return `${text}${where}${notable !== null ? `  ${boldYellow("!")} ${notable}` : ""}${item.isNew ? `  ${boldYellow("NEW")}` : ""}`;
}

const kb = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The consent screen: what the package is and what each module asks for. */
export function renderSummary(
  from: string,
  pkg: ResolvedPackage,
  selection: PackageSelection,
  items: readonly RequestedCapability[],
  previous: LockedPackage | undefined
): string[] {
  const { manifest } = pkg;
  const size = selection.modules.reduce((n, m) => n + m.size, 0);
  const counts = [
    `${selection.modules.length} module${selection.modules.length === 1 ? "" : "s"}`,
    ...(selection.components.length > 0 ? [`${selection.components.length} template-only component${selection.components.length === 1 ? "" : "s"}`] : []),
  ].join(", ");
  const lines = [
    "",
    `  ${bold(manifest.name)} ${manifest.version}${previous !== undefined && previous.version !== manifest.version ? dim(` (reviewed: ${previous.version})`) : ""}  ${dim(`${counts}, ${kb(size)}`)}`,
  ];
  if (manifest.name !== from) lines.push(`  ${dim("from")} ${from}`);
  if (manifest.description) lines.push(`  ${dim(manifest.description)}`);
  lines.push("");
  let n = 0;
  for (const module of selection.modules) {
    const mine = items.filter((i) => i.module === module.name);
    const exported = manifest.exports.includes(module.name) ? "" : dim("  (internal)");
    if (mine.length === 0) {
      lines.push(`  ${pink(module.name)}${exported} ${dim(`${kb(module.size)} — requests nothing`)}`);
      continue;
    }
    lines.push(`  ${pink(module.name)}${exported} ${dim(kb(module.size))} requests to:`);
    for (const item of mine) {
      if (item.status === "missing") {
        const target = (item.capability as { target: string }).target;
        lines.push(
          item.mappedTo !== undefined
            ? `       ${yellow("✗")} ${describeCapability(item.capability).text} — mapped to \`${item.mappedTo}\`, but this app has no such module, so this cannot be granted`
            : `       ${yellow("✗")} ${describeCapability(item.capability).text} — this app has no \`${target}\` module, so this cannot be granted ` +
                dim(`(point it at one of yours: --map ${item.module}.${target}=<Module>)`)
        );
      } else {
        lines.push(`    ${String(++n).padStart(2)}. ${describe(item)}`);
      }
    }
  }
  for (const component of selection.components) {
    lines.push(`  ${pink(component.name)} ${dim("template-only component (no code, no capabilities)")}`);
  }
  lines.push("");
  return lines;
}

// ── the command ─────────────────────────────────────────────────────────────

export interface AddOptions {
  /** The app (the directory with hypen.json). */
  projectDir: string;
  /** What to install. */
  spec: string;
  /** Directory relative specs resolve against. Default: `projectDir`. */
  cwd?: string;
  /** Grant exactly what is requested. */
  yes?: boolean;
  /** `[Module.]capability` patterns to grant / deny. */
  grant?: readonly string[];
  deny?: readonly string[];
  /** Install only these modules / components. */
  only?: readonly string[];
  /** `Name=NewName` renames of exported modules. */
  as?: readonly string[];
  /**
   * `[Module.]Name=AppModule`: where a package module reads or dispatches
   * to `Name` — a module the APP is expected to provide — use the app's
   * `AppModule` instead. Without `Module.` it applies to every module of
   * the package that requests `Name`.
   */
  map?: readonly string[];
  prompter: Prompter;
}

export interface AddResult {
  /** The `wasm.packages` key written. */
  from: string;
  name: string;
  version: string;
  modules: string[];
  components: string[];
  /** Names the app's templates can use. */
  exports: string[];
  granted: RequestedCapability[];
  withheld: RequestedCapability[];
  /** The value written under `wasm.packages.<from>`. */
  entry: Record<string, unknown>;
  updated: boolean;
}

function parseRenames(values: readonly string[]): Map<string, string> {
  const renames = new Map<string, string>();
  for (const value of values) {
    const match = /^([^=]+)=([^=]+)$/.exec(value);
    if (match === null) {
      throw new BuildError(`--as takes <Name>=<NewName> (got "${value}").`, {
        code: "FLAG_INVALID",
        hint: "e.g. `hypen add @acme/checkout --as Checkout=Shop`",
      });
    }
    renames.set((match[1] as string).trim(), (match[2] as string).trim());
  }
  return renames;
}

/**
 * `--map [Module.]Name=AppModule` values as a per-module map.
 *
 * @throws {BuildError} `FLAG_INVALID` for a malformed value, a module the
 *   package does not install, or a name no module requests.
 */
function parseMap(values: readonly string[], selection: PackageSelection, from: string): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const requestsName = (module: ResolvedPackageModule, name: string): boolean =>
    [...module.requests.reads, ...module.requests.dispatches].some((t) => t.toLowerCase() === name.toLowerCase());
  for (const value of values) {
    const match = /^(?:([^.=]+)\.)?([^.=]+)=([^.=]+)$/.exec(value.trim());
    if (match === null) {
      throw new BuildError(`--map takes [<Module>.]<Name>=<AppModule> (got "${value}").`, {
        code: "FLAG_INVALID",
        hint: "e.g. `hypen add @acme/checkout --map Pricing.Cart=Basket` — where Pricing reads or dispatches to Cart, use the app's Basket",
      });
    }
    const [, moduleName, name, target] = match as unknown as [string, string | undefined, string, string];
    const candidates = selection.modules.filter((m) => moduleName === undefined || m.name.toLowerCase() === moduleName.trim().toLowerCase());
    if (moduleName !== undefined && candidates.length === 0) {
      throw new BuildError(`--map ${value}: ${from} installs no module named "${moduleName}".`, {
        code: "FLAG_INVALID",
        hint: `modules: ${selection.modules.map((m) => m.name).join(", ") || "none"}`,
      });
    }
    const users = candidates.filter((m) => requestsName(m, name.trim()));
    if (users.length === 0) {
      const all = [...new Set(selection.modules.flatMap((m) => [...m.requests.reads, ...m.requests.dispatches].map((t) => `${m.name}.${t}`)))];
      throw new BuildError(
        `--map ${value}: ${moduleName !== undefined ? `${candidates[0]?.name} does not` : "no module of the package does"} read or dispatch to "${name.trim()}".`,
        { code: "FLAG_INVALID", hint: `a map redirects a name a module requests: ${all.join(", ") || "this package requests none"}` }
      );
    }
    for (const module of users) {
      // Keyed by the name as the module requests it.
      const requestedAs =
        [...module.requests.reads, ...module.requests.dispatches].find((t) => t.toLowerCase() === name.trim().toLowerCase()) ?? name.trim();
      map.set(module.name, { ...map.get(module.name), [requestedAs]: target.trim() });
    }
  }
  return map;
}

async function acquire(spec: ModuleSpec, project: AppProject, say: (line: string) => void): Promise<{ from: string; manifestPath: string }> {
  switch (spec.kind) {
    case "installed":
      return { from: spec.from, manifestPath: withPackageErrors(() => locateModulePackage(spec.from, project.dir)).manifestPath };
    case "dir": {
      const from = keyOf(spec.path, project.dir);
      return { from, manifestPath: withPackageErrors(() => locateModulePackage(from, project.dir)).manifestPath };
    }
    case "manifest": {
      const isDefault = basename(spec.path) === PACKAGE_MANIFEST_FILE;
      return { from: keyOf(isDefault ? dirname(spec.path) : spec.path, project.dir), manifestPath: spec.path };
    }
    case "tarball": {
      // Extract into a fresh private directory first: the package's name —
      // which decides where it lives — is inside the archive.
      const home = join(project.dir, "hypen_modules");
      mkdirSync(home, { recursive: true });
      const scratch = mkdtempSync(join(home, ".extract-"));
      const staged = join(scratch, "package");
      try {
        extractTarball(spec.path, staged);
        const located = withPackageErrors(() => locateModulePackage(staged, project.dir));
        const { manifest } = withPackageErrors(() => readModulePackage(located.manifestPath));
        const dirName = manifest.name.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
        const target = join(home, dirName);
        if (existsSync(target)) {
          say(`  ${dim(`Replacing ${keyOf(target, project.dir)} (a previous extraction of ${manifest.name}).`)}`);
          rmSync(target, { recursive: true, force: true });
        }
        renameSync(staged, target);
        say(`  ${dim(`Extracted ${basename(spec.path)} → ${keyOf(target, project.dir)} (commit this directory).`)}`);
        const from = keyOf(target, project.dir);
        return { from, manifestPath: withPackageErrors(() => locateModulePackage(from, project.dir)).manifestPath };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    case "npm": {
      const { name, command } = await installPackage(project.dir, spec.spec);
      say(`  ${dim(`Installed with: ${command.join(" ")}  (lifecycle scripts are not run)`)}`);
      try {
        return { from: name, manifestPath: withPackageErrors(() => locateModulePackage(name, project.dir)).manifestPath };
      } catch (err) {
        throw leftover(err, "npm", name);
      }
    }
  }
}

/** The names of the app's stateful modules, lowercased; `null` when they cannot be known statically. */
function appModuleScopes(project: AppProject, exceptFrom: string): Set<string> | null {
  if (project.scriptEntry) return null;
  const scopes = new Set<string>();
  for (const component of appComponents(resolve(project.dir, project.components))) {
    if (component.stateful) scopes.add(component.name.toLowerCase());
  }
  for (const [name, entry] of project.config.modules) if (entry.prebuilt) scopes.add(name.toLowerCase());
  // Modules of the other installed packages.
  for (const decl of project.config.packages.values()) {
    if (decl.from === exceptFrom || decl.source) continue;
    try {
      const other = readModulePackage(locateModulePackage(decl.from, project.dir).manifestPath);
      const naming = planPackageNames(other.manifest, { namespace: decl.namespace, as: decl.as, from: decl.from });
      for (const module of selectFromPackage(other, decl.only, decl.from, decl.field).modules) {
        // Only what the other package EXPORTS is a module of the app.
        const installed = naming.names.find((n) => n.name === module.name);
        if (installed?.exported) scopes.add(installed.installed.toLowerCase());
      }
    } catch {
      // A broken sibling package is reported by `hypen dev` / `hypen modules`.
    }
  }
  return scopes;
}

async function decide(
  items: readonly RequestedCapability[],
  options: AddOptions,
  from: string
): Promise<Set<string>> {
  const grantable = items.filter((i) => i.status !== "missing");
  const grant = options.grant ?? [];
  const deny = options.deny ?? [];
  for (const [flag, patterns] of [["--grant", grant], ["--deny", deny]] as const) {
    for (const pattern of patterns) {
      if (items.some((i) => patternMatches(pattern, i))) continue;
      throw new BuildError(`${flag} ${pattern}: the package requests nothing that matches.`, {
        code: "FLAG_INVALID",
        hint: `requested: ${items.map((i) => i.id).join(", ") || "nothing"} (also: all, <Module>.all, reads, dispatches, storage, http)`,
      });
    }
  }
  const granted = new Set<string>();
  const { prompter } = options;
  const flagged = options.yes === true || grant.length > 0 || deny.length > 0;
  if (flagged || !prompter.interactive) {
    const undecided: RequestedCapability[] = [];
    for (const item of grantable) {
      if (deny.some((p) => patternMatches(p, item))) continue;
      if (options.yes === true || grant.some((p) => patternMatches(p, item))) granted.add(item.id);
      else undecided.push(item);
    }
    if (undecided.length > 0) {
      throw new BuildError(
        `${from} requests capabilities, and nothing is granted without a decision. Undecided: ${undecided.map((i) => i.id).join(", ")}.`,
        {
          code: "CONSENT_REQUIRED",
          detail: undecided.map((i) => `${i.id.padEnd(28)} ${describeCapability(i.capability).text}`),
          hint:
            "decide each one with flags: --yes (grant exactly what is requested), --grant <capability> / --deny <capability> " +
            `(e.g. --grant ${undecided[0]?.id} --deny ${undecided[undecided.length - 1]?.id}; a module name or "all" also works) — or run it in a terminal to choose interactively`,
        }
      );
    }
    return granted;
  }

  if (grantable.length === 0) return granted;
  const answer = (await prompter.ask(`  Grant: [a] all of the above   [m] choose per module   [c] choose per capability   [n] cancel  › `))
    .trim()
    .toLowerCase();
  const yes = async (question: string): Promise<boolean> => /^y(es)?$/i.test((await prompter.ask(question)).trim());
  if (answer === "a" || answer === "all") {
    for (const item of grantable) granted.add(item.id);
  } else if (answer === "m") {
    for (const module of [...new Set(grantable.map((i) => i.module))]) {
      const mine = grantable.filter((i) => i.module === module);
      if (await yes(`  Grant ${module} everything it requests (${mine.map((i) => capabilityId(i.capability)).join(", ")})? [y/N] `)) {
        for (const item of mine) granted.add(item.id);
      }
    }
  } else if (answer === "c") {
    for (const item of grantable) {
      if (await yes(`  Let ${item.module} ${describeCapability(item.capability).text}? [y/N] `)) granted.add(item.id);
    }
  } else {
    throw new BuildError("Cancelled: nothing was granted and hypen.json was not changed.", { code: "CANCELLED" });
  }
  return granted;
}

/**
 * Install (or re-review) a module package in the app at `projectDir`.
 *
 * @throws {BuildError}
 */
export async function addPackage(options: AddOptions): Promise<AddResult> {
  const { prompter } = options;
  const say = (line: string): void => prompter.say(line);
  const project = openAppProject(options.projectDir);
  const spec = classifySpec(options.spec, resolve(options.cwd ?? project.dir), project.config);
  const { from, manifestPath } = await acquire(spec, project, say);
  try {
    return await review(options, project, from, manifestPath);
  } catch (err) {
    if (spec.kind !== "npm" && spec.kind !== "tarball") throw err;
    throw leftover(err, spec.kind, from);
  }
}

/**
 * The package's files may already be in the project (a dependency was
 * added, a tarball extracted) although hypen.json does not use them: say so.
 */
function leftover(err: unknown, kind: "npm" | "tarball", from: string): unknown {
  if (!(err instanceof BuildError)) return err;
  return new BuildError(err.message, {
    code: err.code,
    module: err.module,
    file: err.file,
    field: err.field,
    tool: err.tool,
    hint: err.hint,
    cause: err,
    detail: [
      ...err.detail,
      kind === "npm"
        ? `note:    ${from} was added to package.json but is NOT used by hypen.json; re-run \`hypen add ${from}\` with a decision, or remove the dependency`
        : `note:    the archive was extracted to ${from} but is NOT used by hypen.json; re-run \`hypen add ${from}\`, or delete that directory`,
    ],
  });
}

async function review(options: AddOptions, project: AppProject, from: string, manifestPath: string): Promise<AddResult> {
  const { prompter } = options;
  const say = (line: string): void => prompter.say(line);
  const field = packageField(from);
  const existing = project.config.packages.get(from);
  if (existing?.source) {
    throw new BuildError(`${from} is a source package of this app (${field}.source): it is built, not installed.`, {
      code: "CONFIG_INVALID",
      file: project.file,
      field,
      hint: `remove "source": true from ${field} to install a built package from there instead`,
    });
  }

  const pkg = withPackageErrors(() => readModulePackage(manifestPath));
  const only = options.only !== undefined && options.only.length > 0 ? [...options.only] : existing?.only;
  const selection = selectFromPackage(pkg, only, from, "--only");
  const renames = options.as !== undefined && options.as.length > 0 ? parseRenames(options.as) : new Map(existing?.as ?? []);
  assertRenamesSound(pkg, selection, renames, from, field);

  const map: PackageMap =
    options.map !== undefined && options.map.length > 0 ? parseMap(options.map, selection, from) : new Map(existing?.map ?? []);

  const previous = project.lock[from];
  const items = requested(selection, appModuleScopes(project, from), previous, map);
  for (const line of renderSummary(from, pkg, selection, items, previous)) say(line);
  const granted = await decide(items, options, from);

  const grants: Record<string, Record<string, unknown>> = {};
  const decisions = new Map<string, ModuleGrant>();
  for (const module of selection.modules) {
    const grant = decideGrant(module.requests, (capability) => granted.has(`${module.name}.${capabilityId(capability)}`));
    decisions.set(module.name, grant);
    const json = capabilitySetToJson(grant);
    if (Object.keys(json).length > 0) grants[module.name] = json;
  }
  assertStartable(from, selection.modules, decisions);

  // A map entry for a name that was not granted would redirect nothing.
  const mapJson: Record<string, Record<string, string>> = {};
  for (const [module, entries] of map) {
    const grant = decisions.get(module);
    const kept = Object.entries(entries).filter(([name]) =>
      [...(grant?.reads ?? []), ...(grant?.dispatches ?? [])].some((t) => t.toLowerCase() === name.toLowerCase())
    );
    if (kept.length > 0) mapJson[module] = Object.fromEntries(kept);
  }
  const entry: Record<string, unknown> = {
    ...(existing?.namespace !== undefined ? { namespace: existing.namespace } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(renames.size > 0 ? { as: Object.fromEntries(renames) } : {}),
    ...(Object.keys(mapJson).length > 0 ? { map: mapJson } : {}),
    ...(Object.keys(grants).length > 0 ? { grants } : {}),
  };
  let text: string;
  try {
    text = setJsonPath(project.text, ["wasm", "packages", from], entry);
  } catch (cause) {
    if (!(cause instanceof JsonEditError)) throw cause;
    throw new BuildError(`Cannot edit ${project.file}: ${cause.message}.`, {
      code: "CONFIG_INVALID",
      file: project.file,
      field: "wasm.packages",
      hint: `make "wasm" (and "wasm.packages", if present) JSON objects`,
      cause,
    });
  }
  const lock: ModuleLock = { ...project.lock, [from]: lockOf(pkg, selection) };

  // Dry run: the config as it is about to be written must load — name
  // collisions with the app and with other packages, exports, link-time
  // grants. Nothing has been written yet.
  const nextConfig = parseWasmConfig(getJsonPath(text, ["wasm"]));
  const hosted = resolveHosted(nextConfig, project.dir, {
    lock,
    componentsDir: project.scriptEntry ? undefined : resolve(project.dir, project.components),
  });
  const use = hosted.packages.find((u) => u.declaration.from === from);

  saveAppProject(project, text, lock);

  const result: AddResult = {
    from,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    modules: selection.modules.map((m) => renames.get(m.name) ?? m.name),
    components: selection.components.map((c) => c.name),
    exports: use?.exports ?? [],
    granted: items.filter((i) => granted.has(i.id)),
    withheld: items.filter((i) => !granted.has(i.id)),
    entry,
    updated: existing !== undefined,
  };
  say(`  ${pink(result.updated ? "Updated" : "Added")} ${bold(from)} ${dim(`→ hypen.json ${field}, hypen.lock.json`)}`);
  if (result.granted.length > 0) say(`  ${dim("Granted:")}  ${result.granted.map((i) => i.id).join(", ")}`);
  if (result.withheld.length > 0) {
    say(`  ${dim("Withheld:")} ${result.withheld.map((i) => i.id).join(", ")} ${dim("(the module is refused when it tries)")}`);
  }
  if (result.exports.length > 0) {
    say(`  ${dim("Use it:")}   ${result.exports.map((name) => yellow(`${name} {}`)).join(", ")} ${dim("in a template")}`);
  }
  say("");
  return result;
}

function lockOf(pkg: ResolvedPackage, selection: PackageSelection): LockedPackage {
  const full = lockEntryOf(pkg);
  const modules: LockedPackage["modules"] = {};
  for (const module of selection.modules) modules[module.name] = full.modules[module.name] as LockedPackage["modules"][string];
  return { ...full, modules };
}

/**
 * A module whose component IMPORTS a storage tier or HTTP cannot start
 * without that grant (the host refuses to link it). Installing it that way
 * would only move the error to `hypen dev`.
 */
function assertStartable(from: string, modules: readonly ResolvedPackageModule[], decisions: ReadonlyMap<string, ModuleGrant>): void {
  for (const module of modules) {
    const imports = readComponentImports(readFileSync(module.componentPath));
    if (imports === null) continue;
    const needs = linkRequirements(imports);
    const grant = decisions.get(module.name);
    const missing = [
      ...needs.storage.filter((tier) => !grant?.storage.includes(tier)).map((tier) => `storage:${tier}`),
      ...(needs.http !== null && !grant?.http ? ["http"] : []),
    ];
    if (missing.length === 0) continue;
    throw new BuildError(
      `${module.name} cannot run without ${missing.join(" and ")}: its component imports ${missing.includes("http") ? needs.http : `hypen:storage/${needs.storage[0]}`} and would fail to start.`,
      {
        code: "UNGRANTED_IMPORT",
        module: module.name,
        hint:
          `grant it (--grant ${missing.map((m) => `${module.name}.${m}`).join(" --grant ")}), or leave the module out ` +
          `(--only ${modules.filter((m) => m !== module).map((m) => m.name).join(",") || "<the modules you want>"}); hypen.json was not changed`,
      }
    );
  }
}
