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
 * - a package is self-contained: the names it EXPORTS (default: its entry)
 *   are installed as written — or under the name `as` gives them — and
 *   checked against the app and the other packages; every other name is
 *   internal and installed under the package's namespace
 *   (`AcmeCheckout__Cart`), so it cannot clash with anything. Templates are
 *   rewritten to the installed names with the engine's parser, and each
 *   module gets an alias table so its code keeps calling siblings by the
 *   names it was written with (`planPackageNames` / `moduleAliases` in
 *   `module-package.ts`);
 * - app templates may only use the names a package exports.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative, resolve } from "path";
import * as hypenServer from "@hypen-space/server";
import { BuildError } from "../build-error.js";
import { linkRequirements, readComponentImports } from "./component-imports.js";
import type { ModuleGrants, PackageDeclaration, WasmConfig } from "./config.js";
import {
  ModulePackageError,
  PACKAGE_MANIFEST_FILE,
  assertNoDrift,
  describeCapability,
  installedNameOf,
  locateModulePackage,
  moduleAliases,
  packageDrift,
  planPackageNames,
  readModuleLock,
  readModulePackage,
  unionGrant,
  type Capability,
  type ModuleLock,
  type PackageNaming,
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

/**
 * `template` with the components named by `renames` renamed (tags and the
 * `module X` / `component X` declaration), by the engine's parser — strings,
 * comments and bindings are never touched.
 *
 * @throws {BuildError} `TEMPLATE_INVALID` when the template does not parse;
 *   `PREBUILT_UNSUPPORTED_TARGET` when the CLI's `@hypen-space/server`
 *   predates the helper.
 */
export function renameTemplate(
  template: string,
  renames: Readonly<Record<string, string>>,
  where: { module: string; file: string | undefined }
): string {
  if (Object.keys(renames).length === 0) return template;
  const rename = (
    hypenServer as {
      renameTemplateComponents?: (t: string, r: Readonly<Record<string, string>>, where?: { module?: string; file?: string }) => string;
    }
  ).renameTemplateComponents;
  if (typeof rename !== "function") {
    throw new BuildError(
      "This @hypen-space/server cannot install a package under its namespace (it has no template renaming).",
      {
        code: "PREBUILT_UNSUPPORTED_TARGET",
        module: where.module,
        hint: "update @hypen-space/server (and @hypen-space/cli) to the same version",
      }
    );
  }
  try {
    return rename(template, renames, { module: where.module, file: where.file });
  } catch (cause) {
    throw new BuildError(
      cause instanceof Error ? cause.message : `The template of "${where.module}" could not be installed: ${String(cause)}`,
      {
        code: "TEMPLATE_INVALID",
        module: where.module,
        file: where.file,
        hint: "the package's template is not valid Hypen: rebuild the package (`hypen build --target wasm`) or report it to its author",
        cause,
      }
    );
  }
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
 * Check the `as` renames of a package: a rename applies to a name the
 * package EXPORTS and installs. (Internal names are namespaced and never
 * need one. What refers to the renamed name inside the package follows it:
 * templates are rewritten, and siblings reach it through their alias
 * tables.)
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
  const installs = [...selection.modules.map((m) => m.name), ...selection.components.map((c) => c.name)];
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
    if (!installs.some((n) => same(n, name))) {
      throw unsound(`the package installs nothing of that name`, `fix the name (it installs: ${installs.join(", ") || "nothing"})`);
    }
    if (!pkg.manifest.exports.some((n) => same(n, name))) {
      throw unsound(
        `it is internal to the package (exports: ${pkg.manifest.exports.join(", ")})`,
        "internal names are installed under the package's namespace and cannot clash with the app's, so they are never renamed; only exported names are"
      );
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
  /** The template's source, rewritten to the package's installed names. */
  template: string;
  templatePath: string;
  /** The `wasm.packages` key. */
  from: string;
  /** Its name in the package (`name` is the installed one). */
  packageName: string;
  exported: boolean;
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
  /** Its modules, under their INSTALLED names (`module.package.name` is the name in the package). */
  modules: PrebuiltModule[];
  /** Its template-only components, under their installed names. */
  components: PackageComponentUse[];
  /** The names the app's templates may use (after renames). */
  exports: string[];
  /** Names the package brings that are internal to it, as written in the package. */
  internal: string[];
  /** How every name of the package is installed (the namespace, and the mangled names — a debug detail). */
  naming: PackageNaming;
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

  for (const name of decl.map.keys()) {
    if (selection.modules.some((m) => m.name === name)) continue;
    throw new BuildError(
      `${CONFIG_FILE}: ${decl.field}.map.${name}: ${decl.from} installs no module named "${name}" (modules: ${selection.modules.map((m) => m.name).join(", ") || "none"}).`,
      {
        code: "CONFIG_UNKNOWN_MODULE",
        module: name,
        file: CONFIG_FILE,
        field: `${decl.field}.map.${name}`,
        hint: "a map is keyed by the package module whose names it redirects; fix the name or remove the entry",
      }
    );
  }

  // `assertRenamesSound` has vetted `as`; what is left for this to refuse is
  // a namespace clash inside the package (two names installed alike).
  const naming = planPackageNames(pkg.manifest, { namespace: decl.namespace, as: decl.as, from: decl.from });
  // `naming` covers every name of the manifest, so this cannot miss.
  const installedAs = (name: string): string => installedNameOf(naming, name)?.installed ?? name;
  const isExported = (name: string): boolean => installedNameOf(naming, name)?.exported ?? false;

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
      aliases: moduleAliases(naming, module.name, effective, decl.map.get(module.name), `${CONFIG_FILE} ${decl.field}`),
      field,
      editAt:
        decl.source && decl.trust === "requested"
          ? `${decl.from}/hypen.json wasm.modules.${module.name}`
          : `${CONFIG_FILE} ${field}`,
    };
    assertLinkGrants(decl, module, grants);
    const name = parseModuleName(installedAs(module.name));
    const template =
      module.templatePath !== undefined
        ? renameTemplate(readFileSync(module.templatePath, "utf8").trim(), naming.renames, { module: module.name, file: module.templatePath })
        : undefined;
    return {
      kind: "prebuilt",
      name,
      componentPath: module.componentPath,
      templatePath: module.templatePath,
      template,
      field,
      grants,
      package: {
        from: decl.from,
        name: module.name,
        exported: isExported(module.name),
        version: pkg.manifest.version,
        manifestPath: pkg.manifestPath,
      },
    };
  });
  const components = selection.components.map(
    (component): PackageComponentUse => ({
      name: parseModuleName(installedAs(component.name)),
      template: renameTemplate(readFileSync(component.templatePath, "utf8").trim(), naming.renames, {
        module: component.name,
        file: component.templatePath,
      }),
      templatePath: component.templatePath,
      from: decl.from,
      packageName: component.name,
      exported: isExported(component.name),
    })
  );
  const installed = [...selection.modules.map((m) => m.name), ...selection.components.map((c) => c.name)];
  return {
    declaration: decl,
    pkg,
    origin,
    modules,
    components,
    exports: installed.filter(isExported).map(installedAs),
    internal: installed.filter((n) => !isExported(n)),
    naming,
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

    // Two packages under one namespace would install their internal names
    // alike.
    const namespaces = new Map<string, PackageUse>();
    for (const use of packages) {
      const other = namespaces.get(use.naming.namespace.toLowerCase());
      if (other !== undefined) {
        throw new BuildError(
          `${use.declaration.from} and ${other.declaration.from} would both install their internal modules under the namespace "${use.naming.namespace}".`,
          {
            code: "MODULE_NAME_COLLISION",
            file: CONFIG_FILE,
            field: `${use.declaration.field}.namespace`,
            hint: `give one of them its own: "namespace": "${use.naming.namespace}2" in ${use.declaration.field}`,
          }
        );
      }
      namespaces.set(use.naming.namespace.toLowerCase(), use);
    }

    // Engine scopes and component names are global: one owner per name.
    // Only what a package EXPORTS can meet another name — its internal
    // names are namespaced (and so are claimed here without ever clashing,
    // unless someone names a component like a namespaced one).
    const owners = new Map<string, { name: string; owner: string; field: string }>();
    const claim = (name: string, owner: string, field: string, renameHint: string): void => {
      const other = owners.get(name.toLowerCase());
      if (other !== undefined) {
        throw new BuildError(
          `Name collision: "${name}" (${owner}) and "${other.name}" (${other.owner}) would both be the component / state scope "${name.toLowerCase()}".`,
          {
            code: "MODULE_NAME_COLLISION",
            module: name,
            file: CONFIG_FILE,
            field,
            hint: renameHint,
          }
        );
      }
      owners.set(name.toLowerCase(), { name, owner, field });
    };
    for (const module of legacy) {
      claim(module.name, `${CONFIG_FILE} ${module.field}`, module.field, `rename one of the two declarations`);
    }
    for (const use of packages) {
      const { from, field } = use.declaration;
      const hint = (packageName: string, exported: boolean): string =>
        exported
          ? `both are names their packages export: install one under another name (\`hypen add ${from} --as ${packageName}=<NewName>\`), or leave it out (\`only\`)`
          : `"${packageName}" is internal to ${from} and installed under its namespace; give the package another one ("namespace" in ${field})`;
      for (const module of use.modules) {
        claim(module.name, from, field, hint(module.package?.name ?? module.name, module.package?.exported ?? true));
      }
      for (const component of use.components) claim(component.name, from, field, hint(component.packageName, component.exported));
    }

    const own = options.componentsDir !== undefined ? appComponents(options.componentsDir) : null;
    if (own !== null) {
      for (const use of packages) {
        const { from, field } = use.declaration;
        const brings = [
          ...use.modules.map((m) => ({ name: m.name as string, packageName: m.package?.name ?? m.name, exported: m.package?.exported ?? true, isModule: true })),
          ...use.components.map((c) => ({ name: c.name as string, packageName: c.packageName, exported: c.exported, isModule: false })),
        ];
        for (const brought of brings) {
          const mine = own.find((c) => same(c.name, brought.name));
          if (mine === undefined) continue;
          // Only an exported name can meet one of the app's: a template-only
          // component of the app named like it would shadow it silently, and
          // a module would fight over one scope.
          throw new BuildError(
            `Name collision: ${from} ${brought.exported ? "exports" : "installs"} ${brought.isModule ? "the module" : "the component"} "${brought.name}", and the app has its own "${mine.name}" (${relative(root, mine.template) || mine.template}).`,
            {
              code: "MODULE_NAME_COLLISION",
              module: brought.name,
              file: CONFIG_FILE,
              field,
              hint: brought.exported
                ? `install it under another name: \`hypen add ${from} --as ${brought.packageName}=<NewName>\` — or rename the app's own ${mine.name}`
                : `"${brought.name}" is how ${from} installs its internal "${brought.packageName}": rename the app's own ${mine.name}, or give the package another namespace ("namespace" in ${field})`,
            }
          );
        }
        // App templates may only use what the package exports. An internal
        // name the app also has a component for is simply the app's own.
        for (const component of own) {
          let refs: Set<string>;
          try {
            refs = templateRefs(readFileSync(component.template, "utf8"));
          } catch {
            continue;
          }
          const used = use.internal.find(
            (n) => [...refs].some((r) => same(r, n)) && !own.some((c) => same(c.name, n)) && !owners.has(n.toLowerCase())
          );
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

    // A package's templates may use their own package's names (already
    // rewritten) and what the app or another package EXPORTS — never
    // another package's internals.
    for (const use of packages) {
      const mine = (name: string): boolean => installedNameOf(use.naming, name) !== undefined;
      const templates = [
        ...use.modules.map((m) => ({ name: m.package?.name ?? m.name, path: m.templatePath })),
        ...use.components.map((c) => ({ name: c.packageName, path: c.templatePath as string | undefined })),
      ];
      for (const { name, path } of templates) {
        if (path === undefined) continue;
        for (const ref of templateRefs(readFileSync(path, "utf8"))) {
          if (mine(ref) || owners.has(ref.toLowerCase()) || own?.some((c) => same(c.name, ref))) continue;
          const other = packages.find((p) => p !== use && p.internal.some((n) => same(n, ref)));
          if (other === undefined) continue;
          throw new BuildError(
            `${use.declaration.from}: the template of ${name} uses \`${ref} {}\`, which is internal to ${other.declaration.from} ` +
              `(it exports: ${other.exports.join(", ") || "nothing"}).`,
            {
              code: "NOT_EXPORTED",
              module: ref,
              file: path,
              field: use.declaration.field,
              hint: `a package can use what another package exports, not its internals: ${other.declaration.from} would have to export "${ref}" ("wasm.exports" in its hypen.json)`,
            }
          );
        }
      }
    }

    // A `map` points a name at one of the APP's modules: it must be one.
    const stateful = new Map<string, string>();
    for (const module of legacy) stateful.set(module.name.toLowerCase(), module.name);
    for (const use of packages) {
      for (const module of use.modules) if (module.package?.exported) stateful.set(module.name.toLowerCase(), module.name);
    }
    if (own !== null) for (const component of own) if (component.stateful) stateful.set(component.name.toLowerCase(), component.name);
    for (const use of packages) {
      for (const [module, entries] of use.declaration.map) {
        for (const [name, target] of Object.entries(entries)) {
          // Without a components directory the app's modules are registered
          // in code and cannot be checked here; the server checks at startup.
          if (own === null || stateful.has(target.toLowerCase())) continue;
          throw new BuildError(
            `${CONFIG_FILE}: ${use.declaration.field}.map.${module}.${name} points "${name}" at "${target}", but the app has no module named "${target}"` +
              ` (modules: ${[...stateful.values()].join(", ") || "none"}).`,
            {
              code: "MAP_TARGET_UNKNOWN",
              module,
              file: CONFIG_FILE,
              field: `${use.declaration.field}.map.${module}.${name}`,
              hint: `point it at one of the app's stateful modules: \`hypen add ${use.declaration.from} --map ${module}.${name}=<Module>\``,
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
    // Keyed by the INSTALLED name: that is the module of the build. Its
    // `reads` / `dispatches` keep the names its code uses; `aliases` says
    // which modules of the build they are.
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

