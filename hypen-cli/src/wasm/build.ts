/**
 * `hypen build --target wasm`: the orchestrator.
 *
 * Builds a Hypen app into portable WebAssembly **components** — one
 * `<Module>.wasm` per stateful module — plus the declarative `<Module>.hypen`
 * UI assets and an `app.json` manifest. The output runs offline on any host
 * that speaks the `hypen:module` contract (e.g. `hypen-runtime --app
 * dist/wasm/app.json`). This is the *portable target* of
 * `wit/AUTHORING_MODEL.md`: the same authoring API targets either the
 * in-process browser SPA (`hypen build`) or a sandboxed `.wasm`.
 *
 * Everything here is language-agnostic; the per-language work is behind
 * `ModuleBuilder` (`builders/`). The steps, in order — each one failing
 * before the next spends any time:
 *
 *   config → language → output safety → discovery → capabilities
 *     → toolchain + setup → compile each module → manifest → publish
 *
 * Library code never exits the process: expected failures throw
 * `BuildError`, which `bin/hypen.ts` prints before exiting.
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { BuildError } from "../build-error.js";
import { boldPink, dim, pink, yellow } from "../colors.js";
import type { BuildContext, ModuleBuilder } from "./builders/builder.js";
import { goBuilder } from "./builders/go.js";
import { rustBuilder } from "./builders/rust.js";
import { tsBuilder } from "./builders/ts.js";
import { linkRequirements, readComponentImports, unversioned } from "./component-imports.js";
import {
  declaredRequests,
  parseWasmConfig,
  resolveModuleCapabilities,
  type PackageDeclaration,
  type WasmConfig,
} from "./config.js";
import { assertBuildable, detectProjectLanguage } from "./discover.js";
import {
  MANIFEST_FILE,
  serializeManifest,
  statefulEntry,
  statelessEntry,
  uiFileName,
  wasmFileName,
  type AppManifest,
  type AppManifestModule,
} from "./manifest.js";
import { assertSafeOutput, createStaging, type Staging } from "./output.js";
import {
  PACKAGE_MANIFEST_FILE,
  integrityOf,
  locateModulePackage,
  serializePackageManifest,
  type ModuleRequests,
  type PackageManifest,
  type PackageModule,
} from "./module-package.js";
import {
  builtManifestPath,
  resolveHosted,
  withPackageErrors,
  withPackageGrants,
  type PackageComponentUse,
  type ResolvedHosted,
} from "./packages.js";
import { prebuiltNames } from "./prebuilt.js";
import { readProjectConfig } from "../project-config.js";
import { killRunningTools } from "./process.js";
import {
  parseModuleName,
  scopeOf,
  type Discovery,
  type ModuleName,
  type Language,
  type PrebuiltModule,
  type Project,
  type StatelessComponent,
} from "./types.js";

export interface BuildWasmOptions {
  /** Path to components directory (e.g. `./src/components`), relative to `root`. */
  components: string;
  /** Entry component name (e.g. `App`). */
  entry: string;
  /** Output directory, relative to `root`. Artifacts land in `<outDir>/wasm/`. Default: `dist`. */
  outDir?: string;
  /** Keep the intermediate build directory at `<outDir>/.wasm-temp`. Default: false. */
  keepTemp?: boolean;
  /** Project root (where hypen.json / Cargo.toml / go.mod live). Default: `process.cwd()`. */
  root?: string;
  /**
   * The raw `wasm` section of hypen.json — the language override and the
   * capability grants. Parsed (and rejected if malformed) by `parseWasmConfig`.
   */
  wasm?: unknown;
  /** Where progress lines go. Default: `console.log`. */
  log?: (line: string) => void;
  /**
   * Do not run toolchains for `source` packages: use each one's `fallback`
   * (also `HYPEN_NO_SOURCE_BUILD=1`). For machines without the toolchains.
   */
  noSourceBuild?: boolean;
}

/** Everything the language-agnostic part of a build needs, resolved up front. */
interface BuildPlan {
  project: Project;
  outDir: string;
  outWasmDir: string;
  keepTemp: boolean;
  /** The config, with package modules' grants merged into `modules`. */
  config: WasmConfig;
  /** The modules hypen.json declares prebuilt, resolved against the project. */
  prebuilt: PrebuiltModule[];
  /** Template-only components the app's packages bring. */
  packageComponents: PackageComponentUse[];
  hosted: ResolvedHosted;
  say: (line: string) => void;
}

function assertComponentsDir(componentsDir: string): void {
  if (existsSync(componentsDir) && statSync(componentsDir).isDirectory()) return;
  throw new BuildError(
    existsSync(componentsDir)
      ? `The components path ${componentsDir} is not a directory.`
      : `Components directory not found: ${componentsDir}`,
    {
      code: "COMPONENTS_DIR_MISSING",
      file: componentsDir,
      field: "components",
      hint: `set "components" in hypen.json to the directory holding the project's components (default: ./src/components)`,
    }
  );
}

/**
 * Run `cleanup` if the process is interrupted while `body` runs, then let
 * the signal take its default course. `finally` does not run on SIGINT, and
 * a half-built temp directory would otherwise outlive the build.
 */
async function withInterruptCleanup<T>(cleanup: () => void, body: () => Promise<T>): Promise<T> {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => {
      killRunningTools(signal);
      cleanup();
      for (const [s, h] of handlers) process.off(s, h);
      // Re-raise with the default disposition restored, so the exit status
      // still says "killed by signal".
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    return await body();
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
  }
}

/** A prebuilt module with the template it ships with settled. */
interface PlacedPrebuilt {
  module: PrebuiltModule;
  template: string;
}

/**
 * Fit the prebuilt modules into what discovery found. A prebuilt module
 * takes the place of a stateful module of its name, so:
 *
 * - a source module of the same name (scope) is a collision — the build
 *   would have two modules for one scope;
 * - a template-only component of the same name is the prebuilt module's
 *   template, unless the declaration brought its own (then: collision);
 * - a prebuilt module needs a template from one of the two.
 *
 * Returns the placed prebuilt modules and the stateless components that
 * remain stateless.
 */
function placePrebuilt<S>(
  prebuilt: readonly PrebuiltModule[],
  discovery: Discovery<S>,
  project: Project
): { placed: PlacedPrebuilt[]; stateless: StatelessComponent[] } {
  const placed: PlacedPrebuilt[] = [];
  let stateless = discovery.stateless;
  for (const module of prebuilt) {
    const scope = scopeOf(module.name);
    const source = discovery.stateful.find((m) => scopeOf(m.name) === scope);
    if (source !== undefined) {
      throw new BuildError(
        `Module "${module.name}" is declared prebuilt (hypen.json ${module.field}.component) but ` +
          `"${source.name}" is also a source module in ${project.componentsDir}: the build would have two ` +
          `modules for the state scope "${scope}".`,
        {
          code: "MODULE_NAME_COLLISION",
          module: module.name,
          file: "hypen.json",
          field: `${module.field}.component`,
          hint: `remove "component" from ${module.field} to compile the source module, or remove the source module (keep only its .hypen template) to use the prebuilt one`,
        }
      );
    }
    const donor = stateless.find((c) => scopeOf(c.name) === scope);
    if (donor !== undefined && (module.template !== undefined || donor.name !== module.name)) {
      throw new BuildError(
        donor.name !== module.name
          ? `Prebuilt module "${module.name}" and component "${donor.name}" differ only by case: both would use the state scope "${scope}".`
          : `Prebuilt module "${module.name}" has two templates: hypen.json ${module.field}.template and the ` +
              `component "${donor.name}" in ${project.componentsDir}.`,
        {
          code: "MODULE_NAME_COLLISION",
          module: module.name,
          file: "hypen.json",
          field: donor.name !== module.name ? module.field : `${module.field}.template`,
          hint:
            donor.name !== module.name
              ? "rename one of them (the engine keys modules by lowercased name)"
              : `keep one: remove "template" from ${module.field}, or remove the ${donor.name} component`,
        }
      );
    }
    const template = module.template ?? donor?.template;
    if (template === undefined) {
      throw new BuildError(
        `Prebuilt module "${module.name}" has no template: a wasm build ships every module with its .hypen UI.`,
        {
          code: "PREBUILT_TEMPLATE_MISSING",
          module: module.name,
          file: "hypen.json",
          field: `${module.field}.template`,
          hint: `add "template": "<path to ${module.name}.hypen>" to ${module.field}, or put ${module.name}/component.hypen in the components directory`,
        }
      );
    }
    if (donor !== undefined) stateless = stateless.filter((c) => c !== donor);
    placed.push({ module, template });
  }
  return { placed, stateless };
}


/** The `hypen:module` contract version a component was built against. */
function abiOf(imports: readonly string[] | null): string {
  return imports?.some((name) => /^hypen:module\/[^@]+@0\.2\./.test(name)) ? "0.2" : "0.1";
}

function packageModuleEntry(name: ModuleName, bytes: Uint8Array, requests: ModuleRequests): PackageModule {
  return {
    name,
    component: wasmFileName(name),
    template: uiFileName(name),
    abi: abiOf(readComponentImports(bytes)),
    requests,
    integrity: integrityOf(bytes),
  };
}

/**
 * Cross-check what a module DECLARES it needs (its `wasm.modules.<Name>`
 * entry — what installers will be asked to grant) against what its
 * component really imports.
 *
 * @throws {BuildError} `UNDECLARED_IMPORT`: the component imports a
 *   link-time capability the declaration does not cover, so it would fail
 *   to instantiate for everyone who grants what it asks for.
 * @returns warnings for declared capabilities the component never uses.
 */
export function checkDeclaredImports(name: ModuleName, bytes: Uint8Array, requests: ModuleRequests): string[] {
  const imports = readComponentImports(bytes);
  if (imports === null) return [];
  const needs = linkRequirements(imports);
  const field = `wasm.modules.${name}`;
  const undeclared = (what: string, key: string, json: string): BuildError =>
    new BuildError(
      `${name} imports ${what}, but ${field}.${key} does not declare it: the module would fail to start for everyone who installs it.`,
      {
        code: "UNDECLARED_IMPORT",
        module: name,
        file: "hypen.json",
        field: `${field}.${key}`,
        hint: `declare what the module needs — add ${json} to ${field} in hypen.json — or remove the code that uses ${unversioned(what)}`,
      }
    );
  for (const tier of needs.storage) {
    if (!requests.storage.includes(tier)) throw undeclared(`hypen:storage/${tier}`, "storage", `"storage": ["${tier}"]`);
  }
  if (needs.http !== null && !requests.http) throw undeclared(needs.http, "http", `"http": true`);

  const warnings: string[] = [];
  for (const tier of requests.storage) {
    if (!needs.storage.includes(tier)) {
      warnings.push(`${name} declares storage "${tier}" but its component does not import hypen:storage/${tier}; remove "${tier}" from ${field}.storage so installers are not asked for it`);
    }
  }
  if (requests.http && needs.http === null) {
    warnings.push(`${name} declares http but its component imports neither wasi:http nor hypen:http/deferred; remove "http" from ${field} so installers are not asked for it`);
  }
  if ((requests.reads.length > 0 || requests.dispatches.length > 0) && !needs.engineState) {
    warnings.push(`${name} declares reads/dispatches but its component does not import hypen:engine/state; remove them from ${field} so installers are not asked for them`);
  }
  return warnings;
}

function packageJsonOf(dir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `name` / `version` / `description` of `[package]` in a Cargo.toml. */
function cargoPackageOf(dir: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(dir, "Cargo.toml"), "utf8");
  } catch {
    return {};
  }
  const section = /^\[package\]\s*$([\s\S]*?)(?=^\[)/m.exec(text + "\n[")?.[1] ?? "";
  const out: Record<string, unknown> = {};
  for (const key of ["name", "version", "description"]) {
    const value = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The identity of the package a project builds. Precedence, per field:
 * hypen.json `wasm.{name,version,description}` → `package.json` →
 * `Cargo.toml` `[package]` → the directory name / `0.0.0`.
 */
export function packageIdentity(
  projectDir: string,
  config: WasmConfig
): { name: string; version: string; description: string | undefined } {
  const pkg = packageJsonOf(projectDir);
  const cargo = cargoPackageOf(projectDir);
  const pick = (key: "name" | "version" | "description"): string | undefined => {
    for (const value of [config.package[key], pkg[key], cargo[key]]) {
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    return undefined;
  };
  return {
    name: pick("name") ?? basename(projectDir),
    version: pick("version") ?? "0.0.0",
    description: pick("description"),
  };
}

function describePackage(plan: BuildPlan, modules: PackageModule[], stateless: readonly StatelessComponent[]): PackageManifest {
  const names = [...modules.map((m) => m.name), ...stateless.map((c) => c.name as string)];
  const exports = (plan.config.package.exports ?? [plan.project.entry]).map((name) => {
    const found = names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (found === undefined) {
      throw new BuildError(`hypen.json: wasm.exports names "${name}", which this project does not build (it builds: ${names.join(", ")}).`, {
        code: "CONFIG_UNKNOWN_MODULE",
        module: name,
        file: "hypen.json",
        field: "wasm.exports",
        hint: `list component names from the components directory, or remove "wasm.exports" to export only the entry (${plan.project.entry})`,
      });
    }
    return found;
  });
  return {
    ...packageIdentity(plan.project.projectDir, plan.config),
    entry: plan.project.entry,
    exports: [...new Set(exports)],
    modules,
    components: stateless.map((c) => ({ name: c.name, template: uiFileName(c.name) })),
  };
}

/** A `source` package, built (or resolved to its fallback). */
export interface BuiltSource {
  manifestPath: string;
  origin: "source" | "fallback";
  /** What to tell the user when the fallback was used. */
  notice?: string;
}

const TOOLCHAIN_CODES = new Set(["TOOLCHAIN_MISSING", "TOOLCHAIN_VERSION"]);

/**
 * Build the module project a `source` package points at, with the same
 * pipeline `hypen build --target wasm` runs there, and return its manifest.
 *
 * When the project's toolchain is missing (or `noSourceBuild`) and the
 * declaration names a `fallback`, the fallback package is used instead and
 * `notice` says so. A compile error is never papered over by the fallback.
 *
 * @throws {BuildError}
 */
export async function buildSourcePackage(
  decl: PackageDeclaration,
  projectDir: string,
  options: { log?: (line: string) => void; noSourceBuild?: boolean } = {}
): Promise<BuiltSource> {
  const dir = resolve(projectDir, decl.from);
  if (!existsSync(join(dir, "hypen.json"))) {
    throw new BuildError(`hypen.json: ${decl.field} is a source package, but ${dir} is not a Hypen project (no hypen.json there).`, {
      code: "CONFIG_INVALID",
      file: "hypen.json",
      field: decl.field,
      hint: `point the key at the module project's directory (the one with its own hypen.json), relative to ${resolve(projectDir)}; for an already-built package drop "source": true and run \`hypen add <path>\``,
    });
  }
  const useFallback = (why: string): BuiltSource => {
    const located = withPackageErrors(() => locateModulePackage(decl.fallback as string, projectDir));
    return {
      manifestPath: located.manifestPath,
      origin: "fallback",
      notice: `${decl.from}: ${why} — using the prebuilt fallback ${decl.fallback}. Changes to its sources are NOT picked up until it is built.`,
    };
  };
  const skip = options.noSourceBuild === true || process.env.HYPEN_NO_SOURCE_BUILD === "1";
  if (skip) {
    if (decl.fallback !== undefined) return useFallback("source builds are disabled (HYPEN_NO_SOURCE_BUILD)");
    throw new BuildError(`${decl.from} has to be built from source, but source builds are disabled (HYPEN_NO_SOURCE_BUILD=1) and it has no fallback.`, {
      code: "TOOLCHAIN_MISSING",
      file: "hypen.json",
      field: decl.field,
      hint: `unset HYPEN_NO_SOURCE_BUILD, or commit a built package and name it in ${decl.field}.fallback`,
    });
  }
  const project = readProjectConfig(dir);
  try {
    await buildWasm({
      root: dir,
      components: project.components,
      entry: project.entry,
      outDir: project.outDir,
      wasm: project.wasm,
      log: options.log,
    });
  } catch (err) {
    if (err instanceof BuildError && TOOLCHAIN_CODES.has(err.code) && decl.fallback !== undefined) {
      return useFallback(err.message.replace(/\.$/, ""));
    }
    throw err;
  }
  return { manifestPath: builtManifestPath(dir, project.outDir), origin: "source" };
}

/** Discover, validate, compile and publish one project with one builder. */
async function runBuild<S, P>(builder: ModuleBuilder<S, P>, plan: BuildPlan): Promise<AppManifest> {
  const { project, outWasmDir } = plan;

  // Stateful modules become `.wasm` (logic) + `.hypen` (UI); stateless ones
  // are template-only building blocks (Header(), Card()) the entry references
  // by name: no wasm, no state scope.
  const discovery = await builder.discover(project);
  const { stateful } = discovery;
  // Prebuilt modules (hypen.json `wasm.modules.<Name>.component`) are
  // already compiled: they join the build as stateful modules that only
  // need copying. Placed before `assertBuildable`, so a project whose only
  // modules — or whose entry — are prebuilt is a valid build.
  const placedPrebuilt = placePrebuilt(plan.prebuilt, discovery, project);
  const prebuilt = placedPrebuilt.placed;
  // Template-only components that packages bring ship like the project's own.
  const stateless: StatelessComponent[] = [
    ...placedPrebuilt.stateless,
    ...plan.packageComponents.map((c): StatelessComponent => ({ kind: "stateless", name: c.name, template: c.template })),
  ];
  const say = plan.say;
  assertBuildable(
    {
      stateful: [
        ...stateful.map((m) => ({ kind: "stateful" as const, name: m.name, template: m.template, source: null })),
        ...prebuilt.map((p) => ({ kind: "stateful" as const, name: p.module.name, template: p.template, source: null })),
      ],
      stateless,
    },
    project,
    builder.entryHint(project.entry)
  );

  // Grants are checked against what was discovered *before* spending minutes
  // compiling.
  const capabilities = resolveModuleCapabilities(
    plan.config,
    [...stateful.map((m) => m.name), ...prebuilt.map((p) => p.module.name)],
    stateless.map((c) => c.name)
  );

  const staging: Staging = createStaging(plan.outDir, outWasmDir, plan.keepTemp);
  const ctx: BuildContext = {
    project,
    workDir: staging.workDir,
    stageDir: staging.stageDir,
    log: (line) => say(`  ${dim(line)}`),
  };

  return withInterruptCleanup(staging.dispose, async () => {
    try {
      const entries: AppManifestModule[] = [];
      // No source modules (everything stateful is prebuilt): no toolchain
      // is needed, so none is looked for.
      const prepared: { value: P } | null =
        stateful.length > 0 ? { value: await builder.prepare(ctx, stateful) } : null;

      for (const module of stateful) {
        // `prepared` is only null when there is nothing to iterate.
        if (prepared === null) break;
        const grants = capabilities.get(module.name);
        if (grants === undefined) {
          // resolveModuleCapabilities returns an entry per stateful module.
          throw new Error(`no capabilities resolved for ${module.name}`);
        }
        const notes = builder.describe?.(module) ?? {};
        const building = notes.building ? ` ${dim(notes.building)}` : "";
        say(`  ${pink("building")} ${module.name}${building} ${dim("…")}`);

        await builder.build(ctx, prepared.value, module, grants);
        writeFileSync(join(staging.stageDir, uiFileName(module.name)), module.template);
        entries.push(statefulEntry(module.name, grants));

        const built = notes.built ? ` ${dim(notes.built)}` : "";
        say(
          `    ${dim("→")} ${wasmFileName(module.name)} ${dim("+")} ${uiFileName(module.name)}${built}`
        );
      }

      for (const { module, template } of prebuilt) {
        const grants = capabilities.get(module.name);
        if (grants === undefined) {
          throw new Error(`no capabilities resolved for ${module.name}`);
        }
        copyFileSync(module.componentPath, join(staging.stageDir, wasmFileName(module.name)));
        writeFileSync(join(staging.stageDir, uiFileName(module.name)), template);
        entries.push(statefulEntry(module.name, grants));
        say(`  ${pink("copying")} ${module.name} ${dim(module.package ? `(${module.package.from})` : "(prebuilt)")}`);
        say(`    ${dim("→")} ${wasmFileName(module.name)} ${dim("+")} ${uiFileName(module.name)}`);
      }

      for (const component of stateless) {
        writeFileSync(join(staging.stageDir, uiFileName(component.name)), component.template);
        entries.push(statelessEntry(component));
        say(`    ${dim("→")} ${uiFileName(component.name)} ${dim("(stateless)")}`);
      }

      const manifest: AppManifest = { entry: project.entry, modules: entries };
      writeFileSync(join(staging.stageDir, MANIFEST_FILE), serializeManifest(manifest));

      // The package manifest: the same modules and components, described for
      // whoever INSTALLS this build (what each module requests, its
      // integrity) rather than for the runtime that runs it (app.json).
      const statefulNames = [...stateful.map((m) => m.name), ...prebuilt.map((p) => p.module.name)];
      const packageModules: PackageModule[] = [];
      for (const module of stateful) {
        const requests = declaredRequests(plan.config, module.name, statefulNames);
        const bytes = readFileSync(join(staging.stageDir, wasmFileName(module.name)));
        for (const line of checkDeclaredImports(module.name, bytes, requests)) say(`  ${yellow("warning:")} ${line}`);
        packageModules.push(packageModuleEntry(module.name, bytes, requests));
      }
      for (const { module } of prebuilt) {
        const bytes = readFileSync(join(staging.stageDir, wasmFileName(module.name)));
        const from = plan.hosted.packages.find((use) => use.modules.includes(module));
        const original = from?.pkg.modules.find((m) => m.name === module.package?.name);
        packageModules.push(
          packageModuleEntry(module.name, bytes, original?.requests ?? declaredRequests(plan.config, module.name, statefulNames))
        );
      }
      const packageManifest = describePackage(plan, packageModules, stateless);
      writeFileSync(join(staging.stageDir, PACKAGE_MANIFEST_FILE), serializePackageManifest(packageManifest));
      staging.publish();

      const statelessNote = stateless.length > 0 ? ` + ${stateless.length} stateless` : "";
      const prebuiltNote = prebuilt.length > 0 ? ` + ${prebuilt.length} prebuilt` : "";
      say(
        `\n  ${boldPink("Done.")} ${stateful.length} module(s)${prebuiltNote}${statelessNote} → ${dim(outWasmDir)}`
      );
      const manifestRel = relative(project.projectDir, join(outWasmDir, MANIFEST_FILE)) || MANIFEST_FILE;
      say(`  ${dim("Run it:")} ${yellow(`hypen-runtime --app ${manifestRel}`)}\n`);
      return manifest;
    } finally {
      staging.dispose();
    }
  });
}

/** Label shown in the build header for each language. */
const LANGUAGE_LABELS: Record<Language, string> = {
  ts: tsBuilder.label,
  go: goBuilder.label,
  rust: rustBuilder.label,
};

/**
 * Build a Hypen app to portable WASM components.
 *
 * @throws {BuildError} on anything a user can fix: invalid `wasm` config, an
 *   unusable project layout or output directory, a missing or failing
 *   toolchain, an artifact that is not a component. Never exits the process.
 * @returns the manifest written to `<outDir>/wasm/app.json`.
 */
export async function buildWasm(options: BuildWasmOptions): Promise<AppManifest> {
  const say = options.log ?? ((line: string) => console.log(line));
  const config = parseWasmConfig(options.wasm);
  const projectDir = resolve(options.root ?? process.cwd());
  const project: Project = {
    projectDir,
    componentsDir: resolve(projectDir, options.components),
    entry: options.entry,
    prebuilt: prebuiltNames(config),
  };
  for (const name of config.package.external) parseModuleName(name);
  const outDir = resolve(projectDir, options.outDir ?? "dist");
  const outWasmDir = join(outDir, "wasm");
  const detected = detectProjectLanguage(projectDir, config.language);

  say(`\n  ${boldPink("Hypen Build")} ${dim("→")} ${yellow("wasm")}\n`);
  say(`  ${dim("Entry:")}      ${project.entry}`);
  const languageSource = detected.from === "config" ? ` ${dim("(hypen.json wasm.language)")}` : "";
  say(`  ${dim("Language:")}   ${LANGUAGE_LABELS[detected.language]}${languageSource}`);
  say(`  ${dim("Components:")} ${project.componentsDir}`);
  say(`  ${dim("Output:")}     ${outWasmDir}\n`);

  assertComponentsDir(project.componentsDir);
  assertSafeOutput(outWasmDir, project);
  // Module projects in this repository (`"source": true` packages) are
  // built first, with this same pipeline; their output is then installed
  // like any other package.
  const built = new Map<string, BuiltSource>();
  for (const decl of config.packages.values()) {
    if (!decl.source) continue;
    say(`  ${pink("source")} ${decl.from} ${dim("…")}`);
    const source = await buildSourcePackage(decl, projectDir, { log: options.log, noSourceBuild: options.noSourceBuild });
    if (source.notice) say(`  ${yellow("notice:")} ${source.notice}`);
    built.set(decl.from, source);
  }
  // Paths, "is it a component", integrity, drift, collisions — before
  // discovery loads any module.
  const hosted = resolveHosted(config, projectDir, { built, componentsDir: project.componentsDir });
  for (const note of hosted.notes) say(`  ${yellow("note:")} ${note}`);

  const plan: BuildPlan = {
    project,
    outDir,
    outWasmDir,
    keepTemp: options.keepTemp ?? false,
    config: withPackageGrants(config, hosted),
    prebuilt: hosted.modules,
    packageComponents: hosted.components,
    hosted,
    say,
  };
  // One arm per language keeps each builder's source/prepared types intact
  // (a `Record<Language, ModuleBuilder<…>>` lookup would have to erase them).
  switch (detected.language) {
    case "ts":
      return runBuild(tsBuilder, plan);
    case "go":
      return runBuild(goBuilder, plan);
    case "rust":
      return runBuild(rustBuilder, plan);
  }
}
