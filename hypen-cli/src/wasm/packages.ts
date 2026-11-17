/**
 * Module packages in an app: `wasm.packages.<from>` in hypen.json.
 *
 * The user points at ONE thing — a package (`"@acme/checkout": {}`) or a
 * module project in the same repository (`"./modules/checkout": { "source":
 * true }`) — and its manifest (`hypen-modules.json`) lists every module and
 * template-only component it brings. This file turns those declarations
 * into what the dev server and the builds consume, and enforces the rules
 * that make installing someone else's code a recorded decision:
 *
 * - the manifest is verified (shape, confinement, integrity) every time;
 * - an installed package must have been reviewed (`hypen.lock.json`), and a
 *   package that now requests MORE than was reviewed stops the command;
 * - a link-time capability (storage tier, HTTP) the component imports but
 *   was not granted is an error naming the field and the one-line fix;
 * - every name the package brings is checked against the app and the other
 *   packages (engine scopes are global);
 * - app templates may only use the names a package exports.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { BuildError } from "../build-error.js";
import { linkRequirements, readComponentImports } from "./component-imports.js";
import type { ModuleGrants, PackageDeclaration, WasmConfig } from "./config.js";
import {
  ModulePackageError,
  PACKAGE_MANIFEST_FILE,
  assertNoDrift,
  describeCapability,
  locateModulePackage,
  packageDrift,
  readModuleLock,
  readModulePackage,
  unionGrant,
  type Capability,
  type ModuleLock,
  type ResolvedPackage,
  type ResolvedPackageComponent,
  type ResolvedPackageModule,
} from "./module-package.js";
import { resolvePrebuiltModules } from "./prebuilt.js";
import { parseModuleName, scopeOf, type ModuleName, type PackageModuleGrants, type PrebuiltModule } from "./types.js";

const CONFIG_FILE = "hypen.json";

/** Rethrow a `ModulePackageError` as the `BuildError` the CLI prints. */
export function asBuildError(err: unknown): unknown {
  if (!(err instanceof ModulePackageError)) return err;
  return new BuildError(err.message, {
    code: err.code,
    module: err.module,
    file: err.file,
    field: err.field,
    hint: err.hint,
    cause: err,
  });
}

/** Run `body`, turning package errors into `BuildError`s. */
export function withPackageErrors<T>(body: () => T): T {
  try {
    return body();
  } catch (err) {
    throw asBuildError(err);
  }
}

// ── templates ───────────────────────────────────────────────────────────────

/**
 * The component names a `.hypen` template uses: capitalised identifiers in
 * tag position (`Cart {}`, `Header()`, a bare `Divider`), outside strings
 * and comments. The declared `module X` / `component X` name is not a use.
 */
export function templateRefs(source: string): Set<string> {
  const code = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const refs = new Set<string>();
  for (const match of code.matchAll(/(^|[^.@\w])([A-Z][A-Za-z0-9_]*)\b/g)) {
    const before = code.slice(0, match.index + (match[1] ?? "").length);
    if (/\b(module|component)\s+$/.test(before)) continue;
    // A named argument (`Text(color: Red)`) is a value, not a tag.
    if (/:\s*$/.test(before)) continue;
    refs.add(match[2] as string);
  }
  return refs;
}

/** `module <from> {` → `module <to> {` in a template's declaration. */
export function renameTemplateModule(template: string, from: string, to: string): string {
  return template.replace(new RegExp(`^(\\s*(?:module|component)\\s+)${from}\\b`), `$1${to}`);
}

// ── selection ───────────────────────────────────────────────────────────────

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface PackageSelection {
  modules: ResolvedPackageModule[];
  components: ResolvedPackageComponent[];
}

/**
 * The part of `pkg` that `only` selects (everything when `undefined`).
 *
 * @throws {BuildError} `UNKNOWN_PACKAGE_MODULE` for a name the package does
 *   not have; `ONLY_INCOMPLETE` when a selected template uses a package
 *   component or module that was left out.
 */
export function selectFromPackage(
  pkg: ResolvedPackage,
  only: readonly string[] | undefined,
  from: string,
  field: string
): PackageSelection {
  if (only === undefined) return { modules: pkg.modules, components: pkg.components };
  const all = [...pkg.modules.map((m) => m.name), ...pkg.components.map((c) => c.name)];
  for (const name of only) {
    if (all.some((n) => same(n, name))) continue;
    throw new BuildError(`${from} has no module or component named "${name}" (it has: ${all.join(", ")}).`, {
      code: "UNKNOWN_PACKAGE_MODULE",
      module: name,
      file: pkg.manifestPath,
      field,
      hint: `fix the name, or drop "only" to install everything`,
    });
  }
  const picked = (name: string): boolean => only.some((n) => same(n, name));
  const selection: PackageSelection = {
    modules: pkg.modules.filter((m) => picked(m.name)),
    components: pkg.components.filter((c) => picked(c.name)),
  };
  const templates: Array<{ name: string; path: string | undefined }> = [
    ...selection.modules.map((m) => ({ name: m.name, path: m.templatePath })),
    ...selection.components.map((c) => ({ name: c.name, path: c.templatePath })),
  ];
  for (const { name, path } of templates) {
    if (path === undefined) continue;
    for (const ref of templateRefs(readFileSync(path, "utf8"))) {
      const left = all.find((n) => same(n, ref) && !picked(n));
      if (left === undefined) continue;
      throw new BuildError(
        `${from}: "${name}" is selected, but its template uses "${left}", which is left out.`,
        {
          code: "ONLY_INCOMPLETE",
          module: name,
          file: path,
          field,
          hint: `add "${left}" to the selection (--only ${[...only, left].join(",")}), or install the whole package`,
        }
      );
    }
  }
  return selection;
}

/**
 * Check the `as` renames of a package against what makes a rename sound:
 * the renamed name is an exported module, and nothing else in the package
 * refers to it — siblings name each other in templates and call each other
 * by scope through `hypen:engine/state`, and neither can be redirected.
 *
 * @throws {BuildError} `RENAME_UNSOUND`
 */
export function assertRenamesSound(
  pkg: ResolvedPackage,
  selection: PackageSelection,
  as: ReadonlyMap<string, string>,
  from: string,
  field: string
): void {
  for (const [name, renamed] of as) {
    const unsound = (why: string, hint: string): BuildError =>
      new BuildError(`${from}: cannot install "${name}" as "${renamed}": ${why}.`, {
        code: "RENAME_UNSOUND",
        module: name,
        file: CONFIG_FILE,
        field: `${field}.as.${name}`,
        hint,
      });
    parseModuleName(renamed);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(renamed)) {
      throw unsound(`"${renamed}" is not a component name`, `use letters, digits and "_", e.g. ${name}2`);
    }
    const module = selection.modules.find((m) => same(m.name, name));
    if (module === undefined) {
      const component = selection.components.find((c) => same(c.name, name));
      throw unsound(
        component !== undefined
          ? `it is a template-only component, which the package's templates use by that name`
          : `the package installs no module of that name`,
        component !== undefined
          ? `rename the app's own "${name}" instead, or leave it out with --only if nothing selected uses it`
          : `fix the name (modules: ${selection.modules.map((m) => m.name).join(", ") || "none"})`
      );
    }
    if (!pkg.manifest.exports.some((n) => same(n, name))) {
      throw unsound(
        `it is internal to the package (exports: ${pkg.manifest.exports.join(", ")})`,
        "only exported modules can be renamed; an internal name that collides needs the app's own component renamed"
      );
    }
    for (const other of selection.modules) {
      if (other === module) continue;
      const asks = [...other.requests.reads, ...other.requests.dispatches].some((t) => same(t, name));
      if (asks) {
        throw unsound(
          `${other.name} (same package) reads or dispatches to "${name}" by that name`,
          `a module calls its siblings by name, so "${name}" must keep its name: rename the app's own "${name}" instead`
        );
      }
    }
    const templates = [
      ...selection.modules.filter((m) => m !== module).map((m) => ({ name: m.name, path: m.templatePath })),
      ...selection.components.map((c) => ({ name: c.name, path: c.templatePath as string | undefined })),
    ];
    for (const { name: user, path } of templates) {
      if (path === undefined) continue;
      if ([...templateRefs(readFileSync(path, "utf8"))].some((ref) => same(ref, name))) {
        throw unsound(
          `the template of ${user} (same package) uses \`${name} {}\``,
          `"${name}" must keep its name: rename the app's own "${name}" instead`
        );
      }
    }
  }
}

// ── the app's own components ────────────────────────────────────────────────

export interface AppComponent {
  name: string;
  /** Path of its `.hypen` template. */
  template: string;
  /** Has code beside the template (a module). */
  stateful: boolean;
}

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".go", ".rs"];

/**
 * The components in an app's components directory, by the discovery
 * conventions (`Name/component.hypen`, `Name/index.hypen`, `Name.hypen`).
 * Cheap and static: nothing is imported.
 */
export function appComponents(componentsDir: string): AppComponent[] {
  const found: AppComponent[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".hypen")) continue;
      const stem = entry.slice(0, -".hypen".length);
      const name = stem === "component" || stem === "index" ? basename(dir) : stem;
      const stateful = CODE_EXTENSIONS.some((ext) => existsSync(join(dir, stem + ext)));
      if (!found.some((c) => c.name === name)) found.push({ name, template: path, stateful });
    }
  };
  walk(componentsDir);
  return found;
}

// ── resolution ──────────────────────────────────────────────────────────────

/** A template-only component a package brings. */
export interface PackageComponentUse {
  name: ModuleName;
  /** The template's source. */
  template: string;
  templatePath: string;
  /** The `wasm.packages` key. */
  from: string;
}

/** Where the files of a package in use came from. */
export type PackageOrigin =
  /** An installed package (npm or a directory). */
  | "installed"
  /** Built from the module project just now. */
  | "source"
  /** A `source` package's committed `fallback`, used because its toolchain is missing. */
  | "fallback";

/** One `wasm.packages` entry, resolved. */
export interface PackageUse {
  declaration: PackageDeclaration;
  pkg: ResolvedPackage;
  origin: PackageOrigin;
  modules: PrebuiltModule[];
  components: PackageComponentUse[];
  /** The names the app's templates may use (after renames). */
  exports: string[];
  /** Names the package brings that are internal to it. */
  internal: string[];
}

export interface ResolvedHosted {
  /** Every hosted module: `wasm.modules.<Name>.component` ones, then the packages'. */
  modules: PrebuiltModule[];
  components: PackageComponentUse[];
  packages: PackageUse[];
  /** Things worth saying once (a harmless update not yet recorded, …). */
  notes: string[];
}

export interface ResolveHostedOptions {
  /**
   * The manifests of `source` packages, already built (by `from`). A source
   * package missing here is skipped — the caller reports why.
   */
  built?: ReadonlyMap<string, { manifestPath: string; origin: "source" | "fallback" }>;
  /** The app's components directory: enables the app-collision and export checks. */
  componentsDir?: string;
  /** Default: read `<projectDir>/hypen.lock.json`. */
  lock?: ModuleLock;
}

const grantFix = (decl: PackageDeclaration, module: string, capability: string): string =>
  decl.source
    ? `declare it in the module project's own hypen.json (wasm.modules.${module}), or add it to ${decl.field}.grants.${module}`
    : `\`hypen add ${decl.from} --grant ${module}.${capability}\`, or add it to ${decl.field}.grants.${module} in ${CONFIG_FILE}`;

/**
 * The link-time capabilities `module`'s component imports that `grants`
 * does not cover.
 *
 * @throws {BuildError} `UNGRANTED_IMPORT` naming the field and the fix.
 */
function assertLinkGrants(decl: PackageDeclaration, module: ResolvedPackageModule, grants: PackageModuleGrants): void {
  const imports = readComponentImports(readFileSync(module.componentPath));
  if (imports === null) return; // unreadable: the host's own link-time gate still applies
  const needs = linkRequirements(imports);
  const fail = (what: string, capability: string, json: string): BuildError =>
    new BuildError(
      `${module.name} (${decl.from}) imports ${what}, which it has not been granted: it cannot start.`,
      {
        code: "UNGRANTED_IMPORT",
        module: module.name,
        file: CONFIG_FILE,
        field: `${grants.field}.${capability.split(":")[0]}`,
        hint: `${grantFix(decl, module.name, capability)} (${json})`,
      }
    );
  for (const tier of needs.storage) {
    if (!grants.storage.includes(tier)) throw fail(`hypen:storage/${tier}`, `storage:${tier}`, `"storage": ["${tier}"]`);
  }
  if (needs.http !== null && !grants.http) throw fail(needs.http, "http", `"http": true`);
}

function resolveUse(
  decl: PackageDeclaration,
  manifestPath: string,
  origin: PackageOrigin,
  lock: ModuleLock,
  notes: string[]
): PackageUse {
  const pkg = readModulePackage(manifestPath);
  const selection = selectFromPackage(pkg, decl.only, decl.from, `${decl.field}.only`);
  assertRenamesSound(pkg, selection, decl.as, decl.from, decl.field);

  for (const name of decl.grants.keys()) {
    if (selection.modules.some((m) => m.name === name)) continue;
    const cased = selection.modules.find((m) => same(m.name, name));
    throw new BuildError(
      `${CONFIG_FILE}: ${decl.field}.grants.${name}: ${decl.from} installs no module named "${name}"` +
        (cased ? ` (did you mean "${cased.name}"?)` : ` (modules: ${selection.modules.map((m) => m.name).join(", ") || "none"})`) +
        ".",
      {
        code: "CONFIG_UNKNOWN_MODULE",
        module: name,
        file: CONFIG_FILE,
        field: `${decl.field}.grants.${name}`,
        hint: `remove the entry, or re-run \`hypen add ${decl.from}\` to rewrite the grants`,
      }
    );
  }

  if (origin === "installed") {
    const drift = packageDrift(pkg, lock[decl.from], selection.modules.map((m) => m.name));
    if (drift.status === "unrecorded") {
      throw new ModulePackageError(
        `${decl.from} is used by ${CONFIG_FILE} but was never reviewed (it is not in hypen.lock.json).`,
        {
          code: "NOT_RECORDED",
          package: decl.from,
          file: CONFIG_FILE,
          field: decl.field,
          hint: `run \`hypen add ${decl.from}\` to see what its modules request and record the decision (commit hypen.lock.json)`,
        }
      );
    }
    const note = assertNoDrift(decl.from, pkg, drift);
    if (note !== null) notes.push(note);
  }

  const renamedTo = (name: string): string => decl.as.get(name) ?? name;
  const modules = selection.modules.map((module): PrebuiltModule => {
    const recorded: ModuleGrants | undefined = decl.grants.get(module.name);
    const field = `${decl.field}.grants.${module.name}`;
    const base = {
      reads: recorded?.reads ?? [],
      dispatches: recorded?.dispatches ?? [],
      storage: recorded?.storage ?? [],
      http: recorded?.http ?? false,
      httpHosts: recorded?.httpHosts ?? [],
    };
    const effective = decl.trust === "requested" ? unionGrant(base, module.requests) : base;
    const grants: PackageModuleGrants = {
      ...effective,
      field,
      editAt:
        decl.source && decl.trust === "requested"
          ? `${decl.from}/hypen.json wasm.modules.${module.name}`
          : `${CONFIG_FILE} ${field}`,
    };
    assertLinkGrants(decl, module, grants);
    const name = parseModuleName(renamedTo(module.name));
    let template = module.templatePath !== undefined ? readFileSync(module.templatePath, "utf8").trim() : undefined;
    if (template !== undefined && name !== module.name) template = renameTemplateModule(template, module.name, name);
    return {
      kind: "prebuilt",
      name,
      componentPath: module.componentPath,
      templatePath: module.templatePath,
      template,
      field,
      grants,
      package: { from: decl.from, name: module.name, version: pkg.manifest.version, manifestPath: pkg.manifestPath },
    };
  });
  const components = selection.components.map(
    (component): PackageComponentUse => ({
      name: parseModuleName(component.name),
      template: readFileSync(component.templatePath, "utf8").trim(),
      templatePath: component.templatePath,
      from: decl.from,
    })
  );
  const installed = [...selection.modules.map((m) => m.name), ...selection.components.map((c) => c.name)];
  const exported = installed.filter((n) => pkg.manifest.exports.some((e) => same(e, n)));
  return {
    declaration: decl,
    pkg,
    origin,
    modules,
    components,
    exports: exported.map(renamedTo),
    internal: installed.filter((n) => !exported.includes(n)),
  };
}

/**
 * Resolve every hosted module of an app: the low-level
 * `wasm.modules.<Name>.component` declarations and every package under
 * `wasm.packages`, checked against each other and (given `componentsDir`)
 * against the app's own components.
 *
 * @throws {BuildError}
 */
export function resolveHosted(config: WasmConfig, projectDir: string, options: ResolveHostedOptions = {}): ResolvedHosted {
  const root = resolve(projectDir);
  return withPackageErrors(() => {
    const legacy = resolvePrebuiltModules(config, root);
    const notes: string[] = [];
    const packages: PackageUse[] = [];
    if (config.packages.size > 0) {
      const lock = options.lock ?? readModuleLock(root);
      for (const decl of config.packages.values()) {
        if (decl.source) {
          const built = options.built?.get(decl.from);
          if (built === undefined) continue;
          packages.push(resolveUse(decl, built.manifestPath, built.origin, lock, notes));
        } else {
          const located = locateModulePackage(decl.from, root);
          packages.push(resolveUse(decl, located.manifestPath, "installed", lock, notes));
        }
      }
    }

    // Engine scopes and component names are global: one owner per name.
    const owners = new Map<string, { name: string; owner: string; field: string }>();
    const claim = (name: string, owner: string, field: string): void => {
      const other = owners.get(name.toLowerCase());
      if (other !== undefined) {
        throw new BuildError(
          `Name collision: "${name}" (${owner}) and "${other.name}" (${other.owner}) would both be the component / state scope "${name.toLowerCase()}".`,
          {
            code: "MODULE_NAME_COLLISION",
            module: name,
            file: CONFIG_FILE,
            field,
            hint:
              "engine scopes are global, so two packages cannot bring the same name: install one of them partially (`only`), " +
              "or rename an exported module (`hypen add <package> --as <Name>=<NewName>`)",
          }
        );
      }
      owners.set(name.toLowerCase(), { name, owner, field });
    };
    for (const module of legacy) claim(module.name, `${CONFIG_FILE} ${module.field}`, module.field);
    for (const use of packages) {
      for (const module of use.modules) claim(module.name, use.declaration.from, use.declaration.field);
      for (const component of use.components) claim(component.name, use.declaration.from, use.declaration.field);
    }

    if (options.componentsDir !== undefined) {
      const own = appComponents(options.componentsDir);
      for (const use of packages) {
        const { from, field } = use.declaration;
        for (const name of [...use.modules.map((m) => m.name as string), ...use.components.map((c) => c.name as string)]) {
          const mine = own.find((c) => same(c.name, name));
          if (mine === undefined) continue;
          const isModule = use.modules.some((m) => m.name === name);
          // A template-only component of the app named like a package MODULE
          // would shadow it silently; anything named like a package name
          // would fight over one scope.
          throw new BuildError(
            `Name collision: ${from} brings ${isModule ? "the module" : "the component"} "${name}", and the app has its own "${mine.name}" (${relative(root, mine.template) || mine.template}).`,
            {
              code: "MODULE_NAME_COLLISION",
              module: name,
              file: CONFIG_FILE,
              field,
              hint: use.exports.includes(name) && isModule
                ? `install it under another name: \`hypen add ${from} --as ${name}=<NewName>\` — or rename the app's own ${mine.name}`
                : `"${name}" is ${isModule ? "internal to the package" : "a template-only component the package's templates use"} and cannot be renamed: rename the app's own ${mine.name}`,
            }
          );
        }
        // App templates may only use what the package exports.
        if (use.internal.length === 0) continue;
        for (const component of own) {
          let refs: Set<string>;
          try {
            refs = templateRefs(readFileSync(component.template, "utf8"));
          } catch {
            continue;
          }
          const used = use.internal.find((n) => [...refs].some((r) => same(r, n)));
          if (used === undefined) continue;
          throw new BuildError(
            `${relative(root, component.template) || component.template} uses \`${used} {}\`, which ${from} does not export ` +
              `(it exports: ${use.exports.join(", ") || "nothing"}).`,
            {
              code: "NOT_EXPORTED",
              module: used,
              file: component.template,
              field,
              hint: `use ${use.exports.map((e) => `\`${e} {}\``).join(" or ") || "an exported component"} instead — "${used}" is internal to ${from} (its author lists exports in the module project's hypen.json "wasm.exports")`,
            }
          );
        }
      }
    }

    return {
      modules: [...legacy, ...packages.flatMap((use) => use.modules)],
      components: packages.flatMap((use) => use.components),
      packages,
      notes,
    };
  });
}

/** The config with every package module's effective grants merged into `modules`. */
export function withPackageGrants(config: WasmConfig, hosted: ResolvedHosted): WasmConfig {
  if (hosted.packages.length === 0) return config;
  const modules = new Map(config.modules);
  for (const module of hosted.modules) {
    if (module.grants === undefined) continue;
    const { editAt: _editAt, ...grants } = module.grants;
    modules.set(module.name, grants);
  }
  return { ...config, modules };
}

/** Human words for a capability list: `read the state of the Cart module; …`. */
export function capabilityList(capabilities: readonly Capability[]): string {
  return capabilities.map((c) => describeCapability(c).text).join("; ");
}

/** The manifest a wasm build of the project at `dir` writes. */
export function builtManifestPath(dir: string, outDir: string): string {
  return join(resolve(dir, outDir), "wasm", PACKAGE_MANIFEST_FILE);
}

