/**
 * Declaring hosted modules: `wasmModule()` for one component, and
 * `loadWasmModules()` for the output of `hypen build --target wasm`
 * (`app.json` + `<Name>.wasm` + `<Name>.hypen`).
 *
 * Both are cheap and synchronous-ish: they validate what can be validated
 * without running anything (the name, that the files exist, that the
 * `.wasm` is a Component) and return plain definitions. The expensive part
 * — transpiling the component — happens once, in `RemoteServer.prepare()`.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HostedComponentSource,
  HostedModuleDefinition,
  HostedModuleGrants,
  HostedStorageGrant,
} from "@hypen-space/core/hosted-module";
import { formatHostPattern, parseHostPattern } from "@hypen-space/core/http";
import { HostedModuleSetupError, type HostedModuleSetupCode } from "./errors.js";
import {
  ModulePackageError,
  assertNoDrift,
  locateModulePackage,
  packageDrift,
  readModuleLock,
  readModulePackage,
  type ModulePackageErrorCode,
  type PackageManifest,
  type ResolvedPackage,
} from "./module-package.js";

/** The grants of a hosted module, as written (module names in any case). */
export interface WasmModuleGrants {
  /** Modules (hosted or TypeScript) whose state it may read and subscribe to. */
  reads?: readonly string[];
  /** Modules (hosted or TypeScript) it may dispatch actions to. */
  dispatches?: readonly string[];
  /** Storage tiers beyond the always-granted, module-private `local`. */
  storage?: readonly HostedStorageGrant[];
  /** Outbound HTTP: blocking `wasi:http` and deferred `hypen:http/deferred`. */
  http?: boolean;
  /**
   * Hosts `http` is limited to: `"api.example.com"`, `"*.example.com"` (any
   * subdomain, not the apex), either with `:port`. Omitted or empty: any
   * host. Needs `http: true`.
   */
  httpHosts?: readonly string[];
}

export interface WasmModuleOptions {
  /**
   * The component tag (`Pricing {}` in templates); lowercased, the state
   * scope. With `from`: which module of the package (default: the package's
   * entry, or its only module).
   */
  name?: string;
  /**
   * The component: its bytes, a filesystem path (relative paths resolve
   * against `baseDir`), or an `http(s):` / `file:` URL (fetched once at
   * server startup). Omit it when `from` names a package.
   */
  component?: Uint8Array | string | URL;
  /**
   * A module package to take the module from instead of `component` /
   * `template`: an installed npm package (`"@acme/checkout"`) or a path to a
   * package directory / its `hypen-modules.json`. The manifest names the
   * files; the component's integrity is verified. To load EVERY module of a
   * package (and its template-only components) use `loadWasmPackage()`.
   */
  from?: string;
  /** Path of the module's `.hypen` template (relative to `baseDir`). */
  template?: string;
  /** The template source inline — instead of `template`. */
  ui?: string;
  /** What the module may do. Everything omitted is denied. */
  grants?: WasmModuleGrants;
  /** The module's `init` config (JSON-serialisable). Default `{}`. */
  config?: unknown;
  /**
   * `false`: as a route's module it is destroyed on navigating away instead
   * of kept in the router's persist cache. Default: persisted.
   */
  persist?: boolean;
  /** Directory relative paths resolve against. Default: `process.cwd()`. */
  baseDir?: string;
  /** Where this declaration lives, for error messages. Set by tooling. */
  declaredAt?: string;
  /** Where its grants are written (prefix of the grant key). Set by tooling. */
  grantsAt?: string;
}

/** What the first eight bytes of a file say it is. */
export type WasmKind = "component" | "core-module" | "empty" | "not-wasm";

/**
 * Classify a binary by its preamble: `\0asm`, then `version: u16` +
 * `layer: u16`. Core modules are layer 0, components layer 1.
 */
export function classifyWasm(header: Uint8Array): WasmKind {
  if (header.length === 0) return "empty";
  const magic = [0x00, 0x61, 0x73, 0x6d];
  if (header.length < 8 || magic.some((b, i) => header[i] !== b)) return "not-wasm";
  const layer = (header[6] ?? 0) | ((header[7] ?? 0) << 8);
  return layer === 1 ? "component" : "core-module";
}

const KIND_TEXT: Record<Exclude<WasmKind, "component">, string> = {
  empty: "an empty file",
  "core-module": "a core WebAssembly module, not a Component",
  "not-wasm": "not a WebAssembly binary",
};

/** Throw `COMPONENT_INVALID` unless `header` starts a WebAssembly Component. */
export function assertComponentBytes(
  header: Uint8Array,
  module: string,
  where: { file?: string; field: string }
): void {
  const kind = classifyWasm(header);
  if (kind === "component") return;
  throw new HostedModuleSetupError(
    `The component of hosted module "${module}" is ${KIND_TEXT[kind]}` +
      (where.file ? ` (${where.file}).` : "."),
    {
      code: "COMPONENT_INVALID",
      module,
      file: where.file,
      field: where.field,
      hint:
        kind === "core-module"
          ? "build it as a component: `cargo build --release --target wasm32-wasip2` for Rust, " +
            "or `hypen build --target wasm`"
          : "point it at the `.wasm` Component built for this module",
    }
  );
}

function readHeader(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(8);
    return buf.subarray(0, readSync(fd, buf, 0, 8, 0));
  } finally {
    closeSync(fd);
  }
}

function assertName(name: unknown, declaredAt: string): asserts name is string {
  const problem =
    typeof name !== "string" || name === ""
      ? "a module needs a non-empty name"
      : name.includes(":")
        ? `"${name}" contains ":" (the engine's scope separator)`
        : name.toLowerCase().startsWith("__hypen_")
          ? `"${name}" uses the reserved "__hypen_" prefix`
          : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
            ? `"${name}" is not a component name (letters, digits and "_", not starting with a digit)`
            : null;
  if (problem === null) return;
  throw new HostedModuleSetupError(`Invalid hosted module name: ${problem}.`, {
    code: "INVALID_NAME",
    module: typeof name === "string" ? name : undefined,
    field: `${declaredAt}`,
    hint: 'name it like a component, e.g. "Pricing" — templates use it as `Pricing {}` and the engine keys its state by the lowercased name',
  });
}

function stringList(value: unknown, field: string, module: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v !== "")) {
    throw new HostedModuleSetupError(`${field} must be a list of module names.`, {
      code: "INVALID_OPTIONS",
      module,
      field,
      hint: `e.g. ["Cart"]`,
    });
  }
  return value;
}

function normalizeGrants(grants: WasmModuleGrants | undefined, grantsAt: string, module: string): HostedModuleGrants {
  if (grants !== undefined && (grants === null || typeof grants !== "object" || Array.isArray(grants))) {
    throw new HostedModuleSetupError(`${grantsAt} must be an object.`, {
      code: "INVALID_OPTIONS",
      module,
      field: grantsAt,
      hint: `e.g. { reads: ["Cart"], storage: ["app"] }`,
    });
  }
  const known = ["reads", "dispatches", "storage", "http", "httpHosts"];
  for (const key of Object.keys(grants ?? {})) {
    if (!known.includes(key)) {
      throw new HostedModuleSetupError(`Unknown grant "${key}" (expected reads, dispatches, storage, http or httpHosts).`, {
        code: "INVALID_OPTIONS",
        module,
        field: `${grantsAt}.${key}`,
        hint: `remove "${key}"`,
      });
    }
  }
  const scopes = (key: "reads" | "dispatches"): string[] => [
    ...new Set(stringList(grants?.[key], `${grantsAt}.${key}`, module).map((n) => n.toLowerCase())),
  ];
  const storage: HostedStorageGrant[] = [];
  const rawStorage: unknown = grants?.storage ?? [];
  if (!Array.isArray(rawStorage)) {
    throw new HostedModuleSetupError(`${grantsAt}.storage must be a list of "app" / "cloud".`, {
      code: "INVALID_OPTIONS",
      module,
      field: `${grantsAt}.storage`,
      hint: `e.g. ["app"]`,
    });
  }
  for (const tier of rawStorage) {
    if (tier === "local") continue; // always granted; harmless to list
    if (tier !== "app" && tier !== "cloud") {
      throw new HostedModuleSetupError(
        `${grantsAt}.storage has unknown tier ${JSON.stringify(tier)} (expected "app" or "cloud").`,
        { code: "INVALID_OPTIONS", module, field: `${grantsAt}.storage`, hint: `use "app" and/or "cloud"` }
      );
    }
    if (!storage.includes(tier)) storage.push(tier);
  }
  if (grants?.http !== undefined && typeof grants.http !== "boolean") {
    throw new HostedModuleSetupError(`${grantsAt}.http must be true or false.`, {
      code: "INVALID_OPTIONS",
      module,
      field: `${grantsAt}.http`,
    });
  }
  const http = grants?.http === true;
  return {
    reads: scopes("reads"),
    dispatches: scopes("dispatches"),
    storage,
    http,
    httpHosts: normalizeHttpHosts(grants?.httpHosts, http, grantsAt, module),
  };
}

/**
 * `httpHosts` as canonical pattern strings, deduplicated. Strict: a wrong
 * shape or a malformed pattern is an error (an entry silently dropped would
 * widen the grant — an empty allowlist means any host), and so is an
 * allowlist without `http: true`.
 */
function normalizeHttpHosts(raw: unknown, http: boolean, grantsAt: string, module: string): string[] {
  const field = `${grantsAt}.httpHosts`;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === "string")) {
    throw new HostedModuleSetupError(`${field} must be a list of host patterns.`, {
      code: "INVALID_OPTIONS",
      module,
      field,
      hint: `e.g. ["api.example.com", "*.example.org", "localhost:8080"]`,
    });
  }
  const hosts: string[] = [];
  for (const entry of raw) {
    const pattern = parseHostPattern(entry);
    if (!pattern.ok) {
      throw new HostedModuleSetupError(`${field}: ${pattern.error}.`, {
        code: "INVALID_OPTIONS",
        module,
        field,
        hint: `entries look like "api.example.com", "*.example.com" or "localhost:8080"; leave the list out to allow any host`,
      });
    }
    const text = formatHostPattern(pattern.value);
    if (!hosts.includes(text)) hosts.push(text);
  }
  if (hosts.length > 0 && !http) {
    throw new HostedModuleSetupError(
      `${field} narrows the \`http\` grant, but ${grantsAt}.http is not true for "${module}".`,
      { code: "INVALID_OPTIONS", module, field, hint: `set ${grantsAt}.http to true, or remove httpHosts` }
    );
  }
  return hosts;
}

function componentSource(
  component: WasmModuleOptions["component"],
  baseDir: string,
  module: string,
  field: string
): HostedComponentSource {
  if (component instanceof Uint8Array) {
    assertComponentBytes(component.subarray(0, 8), module, { field });
    return { kind: "bytes", bytes: component };
  }
  let text: string;
  if (component instanceof URL) text = component.href;
  else if (typeof component === "string" && component !== "") text = component;
  else {
    throw new HostedModuleSetupError(
      `Hosted module "${module}" needs a component: its bytes, a path to its .wasm, or a URL.`,
      { code: "INVALID_OPTIONS", module, field, hint: `e.g. component: "./modules/${module.toLowerCase()}.wasm"` }
    );
  }
  if (/^https?:\/\//i.test(text)) return { kind: "url", url: text };
  const path = /^file:\/\//i.test(text) ? fileURLToPath(text) : resolve(baseDir, text);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new HostedModuleSetupError(
      `The component of hosted module "${module}" was not found: ${path}`,
      {
        code: "COMPONENT_MISSING",
        module,
        file: path,
        field,
        hint: "build the module (or copy its .wasm there), or fix the path — relative paths resolve against the project root",
      }
    );
  }
  assertComponentBytes(readHeader(path), module, { file: path, field });
  return { kind: "file", path };
}

/**
 * Define a module whose logic is a prebuilt WASM Component — a Rust, Go or
 * TypeScript `hypen:module` — to run next to the app's TypeScript modules:
 *
 * ```ts
 * new RemoteServer()
 *   .source("./src/components")
 *   .wasmModules(
 *     wasmModule({
 *       name: "Pricing",
 *       component: "./modules/pricing/pricing.wasm",
 *       template: "./modules/pricing/Pricing.hypen",
 *       grants: { reads: ["Cart"] },
 *     })
 *   )
 * ```
 *
 * The result is an ordinary module definition: `Pricing {}` in any template
 * renders it, a `Route` can mount it, and `context.getModule("pricing")`
 * reads its state and dispatches to it.
 *
 * @throws {HostedModuleSetupError} for an unusable name, a missing or
 *   non-component file, a missing template, or malformed grants.
 */
export function wasmModule(options: WasmModuleOptions): HostedModuleDefinition {
  if (options === null || typeof options !== "object") {
    throw new HostedModuleSetupError("wasmModule() takes an options object.", {
      code: "INVALID_OPTIONS",
      hint: 'e.g. wasmModule({ name: "Pricing", component: "./pricing.wasm" })',
    });
  }
  if (options.from !== undefined) return moduleFromPackage(options);
  const label = typeof options.name === "string" && options.name ? options.name : "?";
  const declaredAt = options.declaredAt ?? `wasmModule({ name: "${label}" })`;
  assertName(options.name, declaredAt);
  const name = options.name;
  const grantsAt = options.grantsAt ?? `${declaredAt}.grants`;
  const baseDir = resolve(options.baseDir ?? process.cwd());

  const component = componentSource(
    options.component as Uint8Array | string | URL,
    baseDir,
    name,
    `${declaredAt}.component`
  );

  let template: string | undefined;
  let templatePath: string | undefined;
  if (options.template !== undefined && options.ui !== undefined) {
    throw new HostedModuleSetupError(
      `Hosted module "${name}" has both \`template\` (a path) and \`ui\` (inline source).`,
      { code: "INVALID_OPTIONS", module: name, field: `${declaredAt}.template`, hint: "keep one of them" }
    );
  }
  if (options.template !== undefined) {
    templatePath = resolve(baseDir, options.template);
    if (!existsSync(templatePath) || !statSync(templatePath).isFile()) {
      throw new HostedModuleSetupError(
        `The template of hosted module "${name}" was not found: ${templatePath}`,
        {
          code: "TEMPLATE_MISSING",
          module: name,
          file: templatePath,
          field: `${declaredAt}.template`,
          hint: `create ${name}.hypen there, or fix the path — relative paths resolve against the project root`,
        }
      );
    }
    template = readFileSync(templatePath, "utf8").trim();
  } else if (options.ui !== undefined) {
    template = String(options.ui).trim();
  }

  let config: unknown = options.config ?? {};
  try {
    config = JSON.parse(JSON.stringify(config));
  } catch (cause) {
    throw new HostedModuleSetupError(`The config of hosted module "${name}" is not JSON-serialisable.`, {
      code: "INVALID_OPTIONS",
      module: name,
      field: `${declaredAt}.config`,
      cause,
    });
  }

  return {
    name,
    actions: [],
    stateKeys: [],
    initialState: {},
    ...(options.persist === false ? { persist: false } : {}),
    ...(template !== undefined ? { template } : {}),
    handlers: { onAction: new Map() },
    hosted: {
      component,
      grants: normalizeGrants(options.grants, grantsAt, name),
      config,
      ...(templatePath !== undefined ? { templatePath } : {}),
      declaredAt,
      grantsAt,
    },
  };
}

// ── module packages (hypen-modules.json) ────────────────────────────────────

const PACKAGE_CODES: Record<ModulePackageErrorCode, HostedModuleSetupCode> = {
  MANIFEST_NOT_FOUND: "MANIFEST_INVALID",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  MANIFEST_VERSION_UNSUPPORTED: "MANIFEST_INVALID",
  MANIFEST_PATH_ESCAPES: "MANIFEST_INVALID",
  MODULE_FILE_MISSING: "COMPONENT_MISSING",
  COMPONENT_INVALID: "COMPONENT_INVALID",
  INTEGRITY_MISMATCH: "INTEGRITY_MISMATCH",
  PACKAGE_NOT_FOUND: "PACKAGE_NOT_FOUND",
  PACKAGE_NOT_HYPEN: "MANIFEST_INVALID",
  LOCK_INVALID: "MANIFEST_INVALID",
  REQUESTS_CHANGED: "REQUESTS_CHANGED",
  NOT_RECORDED: "REQUESTS_CHANGED",
  UNKNOWN_PACKAGE_MODULE: "UNKNOWN_MODULE",
};

function packageError(err: unknown): unknown {
  if (!(err instanceof ModulePackageError)) return err;
  return new HostedModuleSetupError(err.message, {
    code: PACKAGE_CODES[err.code],
    module: err.module,
    file: err.file,
    field: err.field,
    hint: err.hint,
    cause: err,
  });
}

export interface LoadWasmPackageOptions {
  /**
   * What each module may do, by module name. A module without an entry is
   * granted nothing — the manifest's `requests` are what the module ASKS
   * for and are never applied by themselves.
   */
  grants?: Readonly<Record<string, WasmModuleGrants>>;
  /** Load only these modules / components. Default: everything in the package. */
  only?: readonly string[];
  /** Per-module `init` config, by module name. */
  config?: Readonly<Record<string, unknown>>;
  /** Directory `from` and `hypen.lock.json` resolve against. Default: `process.cwd()`. */
  baseDir?: string;
  /**
   * Compare the package with what `hypen add` recorded in
   * `<baseDir>/hypen.lock.json` and refuse one that now requests more than
   * was reviewed (or whose bytes changed under the reviewed version).
   * Default: `true` when the lock has an entry for `from`.
   */
  checkLock?: boolean;
}

/** What {@link loadWasmPackage} read. */
export interface LoadedWasmPackage {
  /** The package's manifest (name, version, entry, exports, requests). */
  manifest: PackageManifest;
  /** The manifest's directory. */
  dir: string;
  /** One hosted module per stateful module of the package. */
  modules: HostedModuleDefinition[];
  /** Its template-only components, for `RemoteServer.components()`. */
  components: Array<{ name: string; template: string }>;
}

function resolvePackage(from: string, baseDir: string, checkLock: boolean | undefined, names?: readonly string[]): ResolvedPackage {
  const located = locateModulePackage(from, baseDir);
  const pkg = readModulePackage(located.manifestPath);
  if (checkLock !== false) {
    const locked = readModuleLock(baseDir)[from];
    if (locked !== undefined) assertNoDrift(from, pkg, packageDrift(pkg, locked, names));
    else if (checkLock === true) {
      throw new ModulePackageError(`${from} is not recorded in ${baseDir}/hypen.lock.json.`, {
        code: "NOT_RECORDED",
        package: from,
        hint: `run \`hypen add ${from}\` to review what it requests and record the decision`,
      });
    }
  }
  return pkg;
}

/**
 * Load a module package — what `hypen build --target wasm` / `hypen pack`
 * produce and `hypen add` installs: `from` is an installed npm package
 * name, or a path to a package directory or its `hypen-modules.json`.
 * Every component's integrity is verified against the manifest.
 *
 * ```ts
 * const checkout = loadWasmPackage("@acme/checkout", {
 *   grants: { Pricing: { reads: ["Cart"], dispatches: ["Cart"] } },
 * });
 * new RemoteServer()
 *   .source("./src/components")
 *   .wasmModules(checkout.modules)
 *   .components(checkout.components)
 * ```
 *
 * @throws {HostedModuleSetupError} `MANIFEST_INVALID`, `PACKAGE_NOT_FOUND`,
 *   `INTEGRITY_MISMATCH`, `REQUESTS_CHANGED`, `UNKNOWN_MODULE`, and
 *   everything `wasmModule()` throws.
 */
export function loadWasmPackage(from: string, options: LoadWasmPackageOptions = {}): LoadedWasmPackage {
  const baseDir = resolve(options.baseDir ?? process.cwd());
  let pkg: ResolvedPackage;
  try {
    pkg = resolvePackage(from, baseDir, options.checkLock, options.only);
  } catch (err) {
    throw packageError(err);
  }
  const all = [...pkg.modules.map((m) => m.name), ...pkg.components.map((c) => c.name)];
  const unknown = (name: string, where: string): HostedModuleSetupError =>
    new HostedModuleSetupError(`${from} has no module named "${name}" (it has: ${all.join(", ")}).`, {
      code: "UNKNOWN_MODULE",
      module: name,
      file: pkg.manifestPath,
      hint: `fix the name in \`${where}\``,
    });
  for (const name of options.only ?? []) if (!all.includes(name)) throw unknown(name, "only");
  for (const name of Object.keys(options.grants ?? {})) {
    if (!pkg.modules.some((m) => m.name === name)) throw unknown(name, "grants");
  }
  const picked = (name: string): boolean => options.only === undefined || options.only.includes(name);
  const at = `loadWasmPackage(${JSON.stringify(from)})`;
  return {
    manifest: pkg.manifest,
    dir: pkg.dir,
    modules: pkg.modules
      .filter((m) => picked(m.name))
      .map((m) =>
        wasmModule({
          name: m.name,
          component: m.componentPath,
          ...(m.templatePath !== undefined ? { template: m.templatePath } : {}),
          grants: options.grants?.[m.name],
          config: options.config?.[m.name],
          declaredAt: `${at} ${m.name}`,
          grantsAt: `${at}.grants.${m.name}`,
        })
      ),
    components: pkg.components
      .filter((c) => picked(c.name))
      .map((c) => ({ name: c.name, template: readFileSync(c.templatePath, "utf8").trim() })),
  };
}

/** `wasmModule({ from, name?, grants })`: one module of a package. */
function moduleFromPackage(options: WasmModuleOptions): HostedModuleDefinition {
  const from = options.from as string;
  if (options.component !== undefined || options.template !== undefined) {
    throw new HostedModuleSetupError("wasmModule(): `from` names a package; `component` / `template` come from its manifest.", {
      code: "INVALID_OPTIONS",
      field: "from",
      hint: "pass either `from` (a module package) or `component` + `template` (the low-level form)",
    });
  }
  const baseDir = resolve(options.baseDir ?? process.cwd());
  let pkg: ResolvedPackage;
  try {
    pkg = resolvePackage(from, baseDir, undefined, options.name !== undefined ? [options.name] : undefined);
  } catch (err) {
    throw packageError(err);
  }
  const wanted = options.name ?? pkg.manifest.entry ?? (pkg.modules.length === 1 ? pkg.modules[0]?.name : undefined);
  const module = pkg.modules.find((m) => m.name === wanted);
  if (module === undefined) {
    throw new HostedModuleSetupError(
      wanted === undefined
        ? `${from} has several modules (${pkg.modules.map((m) => m.name).join(", ")}) and no entry: say which one with \`name\`.`
        : `${from} has no module named "${wanted}" (it has: ${pkg.modules.map((m) => m.name).join(", ") || "none"}).`,
      { code: "UNKNOWN_MODULE", module: wanted, file: pkg.manifestPath, hint: "set `name` to one of its modules, or use loadWasmPackage() for all of them" }
    );
  }
  const at = options.declaredAt ?? `wasmModule({ from: ${JSON.stringify(from)}, name: "${module.name}" })`;
  return wasmModule({
    name: module.name,
    component: module.componentPath,
    ...(options.ui !== undefined ? { ui: options.ui } : module.templatePath !== undefined ? { template: module.templatePath } : {}),
    grants: options.grants,
    config: options.config,
    persist: options.persist,
    declaredAt: at,
    grantsAt: options.grantsAt ?? `${at}.grants`,
  });
}

/**
 * One module from a package manifest: `wasmModuleFromManifest("./vendor/checkout", { reads: ["Cart"] })`.
 * Shorthand for `wasmModule({ from, name, grants })`.
 */
export function wasmModuleFromManifest(
  from: string,
  grants?: WasmModuleGrants,
  options: { name?: string; baseDir?: string; config?: unknown } = {}
): HostedModuleDefinition {
  return wasmModule({ from, grants, ...options });
}

/** The stateful entry of an `app.json` (see `hypen build --target wasm`). */
interface ManifestModule {
  name: string;
  wasm?: string;
  ui?: string;
  reads?: string[];
  dispatches?: string[];
  storage?: HostedStorageGrant[];
  http?: boolean;
  httpHosts?: string[];
}

/** What {@link loadWasmModules} read. */
export interface LoadedWasmModules {
  /** The manifest's entry component name. */
  entry: string;
  /** The manifest's directory. */
  dir: string;
  /** One hosted module per manifest entry that has a `wasm`. */
  modules: HostedModuleDefinition[];
  /** The manifest's template-only components (no wasm): name + template source. */
  templates: Array<{ name: string; template: string }>;
}

export interface LoadWasmModulesOptions {
  /** Load only these modules (by name). Default: every module in the manifest. */
  only?: readonly string[];
  /** Per-module `init` config, by module name. */
  config?: Readonly<Record<string, unknown>>;
}

/**
 * Load the modules a `hypen build --target wasm` produced: `source` is the
 * output directory or its `app.json`. Each entry's grants come from the
 * manifest; paths must stay inside the manifest's directory.
 *
 * ```ts
 * const { modules } = loadWasmModules("./vendor/pricing");
 * server.wasmModules(modules);
 * ```
 *
 * @throws {HostedModuleSetupError} `MANIFEST_INVALID` and everything
 *   `wasmModule()` throws.
 */
export function loadWasmModules(source: string | URL, options: LoadWasmModulesOptions = {}): LoadedWasmModules {
  const given = source instanceof URL ? fileURLToPath(source) : resolve(source);
  const manifestPath = existsSync(given) && statSync(given).isDirectory() ? join(given, "app.json") : given;
  const invalid = (message: string, hint: string, cause?: unknown): HostedModuleSetupError =>
    new HostedModuleSetupError(message, { code: "MANIFEST_INVALID", file: manifestPath, hint, cause });

  if (!existsSync(manifestPath)) {
    throw invalid(
      `No app.json at ${manifestPath}.`,
      "pass the directory `hypen build --target wasm` wrote (default dist/wasm), or the path of its app.json"
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw invalid(`${manifestPath} is not valid JSON.`, "rebuild it with `hypen build --target wasm`", cause);
  }
  const manifest = raw as { entry?: unknown; modules?: unknown } | null;
  if (manifest === null || typeof manifest !== "object" || !Array.isArray(manifest.modules)) {
    throw invalid(
      `${manifestPath} has no "modules" list.`,
      'expected { "entry": "...", "modules": [{ "name", "wasm", "ui", ... }] }'
    );
  }
  const dir = dirname(manifestPath);
  const inside = (file: unknown, field: string): string => {
    if (typeof file !== "string" || file === "") {
      throw invalid(`${manifestPath}: ${field} must be a file path.`, "rebuild the manifest");
    }
    const path = resolve(dir, file);
    const rel = relative(dir, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw invalid(
        `${manifestPath}: ${field} ("${file}") points outside the manifest's directory.`,
        "keep a module's files next to its app.json"
      );
    }
    return path;
  };

  const only = options.only ? new Set(options.only) : null;
  const modules: HostedModuleDefinition[] = [];
  const templates: Array<{ name: string; template: string }> = [];
  const seen = new Set<string>();
  (manifest.modules as unknown[]).forEach((entry, index) => {
    const at = `modules[${index}]`;
    if (entry === null || typeof entry !== "object" || typeof (entry as ManifestModule).name !== "string") {
      throw invalid(`${manifestPath}: ${at} must be an object with a "name".`, "rebuild the manifest");
    }
    const module = entry as ManifestModule;
    seen.add(module.name);
    if (only && !only.has(module.name)) return;
    const label = `${manifestPath} ${at} (${module.name})`;
    if (module.wasm === undefined) {
      if (module.ui !== undefined) {
        const uiPath = inside(module.ui, `${at}.ui`);
        if (!existsSync(uiPath)) {
          throw new HostedModuleSetupError(`The template of "${module.name}" was not found: ${uiPath}`, {
            code: "TEMPLATE_MISSING",
            module: module.name,
            file: uiPath,
            field: `${label}.ui`,
          });
        }
        templates.push({ name: module.name, template: readFileSync(uiPath, "utf8").trim() });
      }
      return;
    }
    modules.push(
      wasmModule({
        name: module.name,
        component: inside(module.wasm, `${at}.wasm`),
        ...(module.ui !== undefined ? { template: inside(module.ui, `${at}.ui`) } : {}),
        grants: {
          reads: module.reads,
          dispatches: module.dispatches,
          storage: module.storage,
          http: module.http,
          httpHosts: module.httpHosts,
        },
        config: options.config?.[module.name],
        baseDir: dir,
        declaredAt: label,
        grantsAt: label,
      })
    );
  });
  for (const name of only ?? []) {
    if (!seen.has(name)) {
      throw new HostedModuleSetupError(
        `${manifestPath} has no module named "${name}" (it has: ${[...seen].join(", ") || "none"}).`,
        { code: "UNKNOWN_MODULE", module: name, file: manifestPath, hint: "fix the name in `only`" }
      );
    }
  }
  return {
    entry: typeof manifest.entry === "string" ? manifest.entry : "",
    dir,
    modules,
    templates,
  };
}
