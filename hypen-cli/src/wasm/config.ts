/**
 * The `wasm` section of hypen.json: parsed once, at the boundary, into a
 * fully-typed and normalised `WasmConfig`. Shape errors name the offending
 * field; whether the *module names* in it exist is decided later, against
 * what discovery found (`resolveModuleCapabilities`).
 */

import { formatHostPattern, parseHostPattern } from "./http-grammar.js";
import { BuildError } from "../build-error.js";
import { asRequests, type ModuleRequests } from "./module-package.js";
import {
  GRANTABLE_STORAGE,
  LANGUAGES,
  isRecord,
  scopeOf,
  type Capabilities,
  type GrantableStorage,
  type Language,
  type ModuleName,
  type ScopeName,
} from "./types.js";

/**
 * `wasm.modules.<Module>`: one module's grants as written. `reads` and
 * `dispatches` are still plain strings here — they name modules the build has
 * not discovered yet.
 */
export interface ModuleGrants {
  reads: string[];
  dispatches: string[];
  storage: GrantableStorage[];
  http: boolean;
  /**
   * `httpHosts`: the hosts `http` is limited to, as canonical pattern
   * strings (`api.example.com`, `*.example.com`, either with `:port`).
   * Empty = any host. Non-empty only with `http: true`.
   */
  httpHosts: string[];
  /**
   * Present when the entry declares a PREBUILT module (`component`): one
   * that is loaded as is — by `hypen dev`, and copied by the builds —
   * instead of being compiled from a source component.
   */
  prebuilt?: PrebuiltDeclaration;
  /**
   * Where the entry is written when that is not `wasm.modules.<Name>`
   * (a package's recorded grant: `wasm.packages["…"].grants.<Name>`).
   */
  field?: string;
}

/**
 * `wasm.modules.<Module>.{component,template}` as written: paths relative
 * to the project root, not yet known to exist (`resolvePrebuiltModules`).
 */
export interface PrebuiltDeclaration {
  /** Path of the module's `.wasm` Component. */
  component: string;
  /** Path of its `.hypen` template, when it does not come from the components directory. */
  template: string | undefined;
}

/**
 * `wasm.packages.<from>`: one module package the app uses — the ONE entry a
 * user writes (or `hypen add` writes for them). The key says where the
 * package comes from: an npm package name, or a path (`./vendor/checkout`).
 * The package's manifest lists its modules; they are never listed by hand.
 */
export interface PackageDeclaration {
  /** The key as written: a package name or a path relative to the project. */
  from: string;
  /** `wasm.packages["<from>"]`, for messages. */
  field: string;
  /**
   * `"source": true`: `from` is a module *project* in this repository;
   * `hypen dev` / `hypen build` build it and load the result.
   */
  source: boolean;
  /**
   * What the package's modules get beyond `grants`. `"requested"`: whatever
   * each module's manifest requests (the default for `source` packages — the
   * same author controls both sides). `"explicit"`: only `grants` (always
   * the case for installed packages: nothing is granted without a decision).
   */
  trust: "requested" | "explicit";
  /** A prebuilt package to use when a `source` package's toolchain is missing. */
  fallback: string | undefined;
  /** Install only these modules / components. `undefined`: everything. */
  only: string[] | undefined;
  /** Renames of exported modules: name in the package → name in the app. */
  as: ReadonlyMap<string, string>;
  /** The recorded grant decisions, by the module's name in the package. */
  grants: ReadonlyMap<string, ModuleGrants>;
}

/** What a module project says about the package it builds. */
export interface PackageMeta {
  /** `wasm.name`: the package's name in its manifest. */
  name: string | undefined;
  /** `wasm.version`. */
  version: string | undefined;
  /** `wasm.description`. */
  description: string | undefined;
  /** `wasm.npm`: the npm name `hypen pack` gives the package. */
  npm: string | undefined;
  /** `wasm.exports`: names the app may use in its templates. Default: the entry. */
  exports: string[] | undefined;
  /**
   * `wasm.external`: modules this project's modules may name in `reads` /
   * `dispatches` although the project does not contain them — the app that
   * installs the package provides them.
   */
  external: string[];
}

/** The parsed `wasm` section. Every field is present; absent input means defaults. */
export interface WasmConfig {
  /** Explicit source language; `undefined` means detect from the project. */
  language: Language | undefined;
  /** Grants keyed by the module name as written in hypen.json. */
  modules: ReadonlyMap<string, ModuleGrants>;
  /** Module packages the app uses, by where they come from. */
  packages: ReadonlyMap<string, PackageDeclaration>;
  /** The package this project builds, as its author describes it. */
  package: PackageMeta;
}

const NO_META: PackageMeta = {
  name: undefined,
  version: undefined,
  description: undefined,
  npm: undefined,
  exports: undefined,
  external: [],
};

const CONFIG_FILE = "hypen.json";

function configError(message: string, field: string, hint?: string): BuildError {
  return new BuildError(`${CONFIG_FILE}: ${message}`, {
    code: "CONFIG_INVALID",
    file: CONFIG_FILE,
    field,
    hint,
  });
}

/** Levenshtein distance, for "did you mean" on misspelled keys. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** The known key a misspelling most plausibly meant, if any. */
function closestKey(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  return known.find(
    (k) => k.startsWith(lower) || lower.startsWith(k) || editDistance(lower, k) <= 2
  );
}

function unknownKey(
  path: string,
  key: string,
  known: readonly string[],
  /** Keys that are valid but not listed in "expected" — still offered as a "did you mean". */
  alsoValid: readonly string[] = []
): BuildError {
  const expected =
    known.length === 2
      ? `"${known[0]}" or "${known[1]}"`
      : `${known.slice(0, -1).map((k) => `"${k}"`).join(", ")} or "${known[known.length - 1]}"`;
  const guess = closestKey(key, [...known, ...alsoValid]);
  return configError(
    `unknown key "${path}.${key}" (expected ${expected})`,
    `${path}.${key}`,
    guess ? `did you mean "${path}.${guess}"?` : `remove "${key}" from ${path} in ${CONFIG_FILE}`
  );
}

function parseLanguage(value: unknown): Language {
  const language = LANGUAGES.find((l) => l === value);
  if (language === undefined) {
    throw configError(
      `wasm.language must be one of ${LANGUAGES.map((l) => `"${l}"`).join(", ")} ` +
        `(got ${JSON.stringify(value)})`,
      "wasm.language",
      `set "language" to "ts", "go" or "rust", or remove it to detect the language from Cargo.toml / go.mod`
    );
  }
  return language;
}

function parseModuleNames(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
    throw configError(
      `${field} must be an array of module names (strings)`,
      field,
      `write it as a list, e.g. ${JSON.stringify(field.split(".").pop())}: ["Catalog"]`
    );
  }
  return value;
}

function parseStorage(value: unknown, field: string): GrantableStorage[] {
  if (!Array.isArray(value)) {
    throw configError(`${field} must be an array of "app" / "cloud"`, field, `e.g. "storage": ["app"]`);
  }
  const tiers: GrantableStorage[] = [];
  for (const raw of value) {
    const tier = GRANTABLE_STORAGE.find((t) => t === raw);
    if (tier === undefined) {
      const local = raw === "local";
      throw configError(
        `${field} has unknown tier ${JSON.stringify(raw)} (expected "app" or "cloud")` +
          (local ? ` ("local" is always granted; omit it)` : ""),
        field,
        local ? `remove "local" from ${field}` : `use "app" and/or "cloud"`
      );
    }
    if (!tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
}

/**
 * `httpHosts`: a list of host patterns in the engine's grammar
 * (`HostPattern` in hypen-engine-rs/src/module_host/http.rs, ported in
 * `@hypen-space/core/http`), stored canonically and deduplicated. A bad
 * entry is an error, never dropped: an empty allowlist means *any host*.
 */
function parseHttpHosts(value: unknown, field: string): string[] {
  const example = `e.g. "httpHosts": ["api.example.com", "*.example.org", "localhost:8080"]`;
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
    throw configError(`${field} must be an array of host patterns (strings)`, field, example);
  }
  const hosts: string[] = [];
  value.forEach((entry, index) => {
    const pattern = parseHostPattern(entry);
    if (!pattern.ok) {
      throw configError(
        `${field}[${index}]: ${pattern.error}`,
        `${field}[${index}]`,
        `an entry names a host, not a URL: "api.example.com", "*.example.com" (every subdomain, not the apex) or "localhost:8080"; remove httpHosts to allow any host`
      );
    }
    const text = formatHostPattern(pattern.value);
    if (!hosts.includes(text)) hosts.push(text);
  });
  return hosts;
}

const GRANT_KEYS = ["reads", "dispatches", "storage", "http", "httpHosts"] as const;
/** The keys that declare a prebuilt module, valid beside the grants. */
const PREBUILT_KEYS = ["component", "template"] as const;

function parsePath(value: unknown, field: string, example: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(
      `${field} must be a path (a non-empty string)`,
      field,
      `e.g. ${JSON.stringify(field.split(".").pop())}: ${JSON.stringify(example)}`
    );
  }
  return value;
}

function parseModuleGrants(raw: unknown, at: string): ModuleGrants {
  if (!isRecord(raw)) {
    throw configError(
      `${at} must be an object`,
      at,
      `e.g. { "reads": ["Catalog"], "storage": ["app"], "http": true }`
    );
  }
  const grants: ModuleGrants = { reads: [], dispatches: [], storage: [], http: false, httpHosts: [] };
  let component: string | undefined;
  let template: string | undefined;
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "component":
        component = parsePath(value, `${at}.component`, "./modules/pricing/pricing.wasm");
        break;
      case "template":
        template = parsePath(value, `${at}.template`, "./modules/pricing/Pricing.hypen");
        break;
      case "reads":
      case "dispatches":
        grants[key] = parseModuleNames(value, `${at}.${key}`);
        break;
      case "storage":
        grants.storage = parseStorage(value, `${at}.storage`);
        break;
      case "http":
        if (typeof value !== "boolean") {
          throw configError(`${at}.http must be true or false`, `${at}.http`, `write "http": true (no quotes)`);
        }
        grants.http = value;
        break;
      case "httpHosts":
        grants.httpHosts = parseHttpHosts(value, `${at}.httpHosts`);
        break;
      default:
        throw unknownKey(at, key, GRANT_KEYS, PREBUILT_KEYS);
    }
  }
  if (grants.httpHosts.length > 0 && !grants.http) {
    // The same rule as the runtime's manifest (`HostsWithoutHttp`): an
    // allowlist for a grant the module does not have is a mistake, and
    // ignoring it would hide which one.
    throw configError(
      `${at}.httpHosts narrows the http grant, but ${at}.http is not true`,
      `${at}.httpHosts`,
      `add "http": true to ${at}, or remove "httpHosts"`
    );
  }
  if (component !== undefined) {
    grants.prebuilt = { component, template };
  } else if (template !== undefined) {
    // `template` only means something next to `component`: a source
    // component's template is the `.hypen` file beside its module.
    throw configError(
      `${at}.template is set without ${at}.component`,
      `${at}.template`,
      `add "component": "<path to the module's .wasm>" to load a prebuilt module, or remove "template" (a source component's template is its own .hypen file)`
    );
  }
  return grants;
}

const PACKAGE_KEYS = ["source", "trust", "fallback", "only", "as", "grants"] as const;

/** A dotted path segment for a key that may contain `.` / `/` / `@`. */
export function packageField(from: string): string {
  return `wasm.packages[${JSON.stringify(from)}]`;
}

function parseNameList(value: unknown, field: string, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v !== "")) {
    throw configError(`${field} must be an array of ${what} (strings)`, field, `e.g. ["Checkout"]`);
  }
  return [...new Set(value)];
}

function parsePackage(from: string, raw: unknown): PackageDeclaration {
  const at = packageField(from);
  if (from.trim() === "") {
    throw configError(`wasm.packages has an empty key`, "wasm.packages", `a key names a package ("@acme/checkout") or a path ("./vendor/checkout")`);
  }
  if (!isRecord(raw)) {
    throw configError(`${at} must be an object`, at, `e.g. "${from}": {}  — \`hypen add\` writes it for you`);
  }
  let source = false;
  let trust: PackageDeclaration["trust"] | undefined;
  let fallback: string | undefined;
  let only: string[] | undefined;
  const as = new Map<string, string>();
  const grants = new Map<string, ModuleGrants>();
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "source":
        if (typeof value !== "boolean") {
          throw configError(`${at}.source must be true or false`, `${at}.source`, `write "source": true to build the module project at ${from}`);
        }
        source = value;
        break;
      case "trust":
        if (value !== "requested" && value !== "explicit") {
          throw configError(
            `${at}.trust must be "requested" or "explicit" (got ${JSON.stringify(value)})`,
            `${at}.trust`,
            `"requested" grants a source package what its own hypen.json declares; "explicit" grants only what ${at}.grants lists`
          );
        }
        trust = value;
        break;
      case "fallback":
        fallback = parsePath(value, `${at}.fallback`, "./modules/checkout/prebuilt");
        break;
      case "only":
        only = parseNameList(value, `${at}.only`, "module / component names");
        break;
      case "as":
        if (!isRecord(value) || !Object.values(value).every((v): v is string => typeof v === "string" && v !== "")) {
          throw configError(`${at}.as must map a module's name in the package to its name in the app`, `${at}.as`, `e.g. "as": { "Checkout": "Shop" }`);
        }
        for (const [name, renamed] of Object.entries(value)) as.set(name, renamed as string);
        break;
      case "grants":
        if (!isRecord(value)) {
          throw configError(`${at}.grants must be an object keyed by module name`, `${at}.grants`, `e.g. "grants": { "Pricing": { "reads": ["Cart"] } }`);
        }
        for (const [name, entry] of Object.entries(value)) {
          const field = `${at}.grants.${name}`;
          const parsed = parseModuleGrants(entry, field);
          if (parsed.prebuilt !== undefined) {
            throw configError(`${field}.component is not valid here: the package's manifest names its files`, `${field}.component`, `remove "component" / "template" from ${field}`);
          }
          grants.set(name, { ...parsed, field });
        }
        break;
      default:
        throw unknownKey(at, key, PACKAGE_KEYS);
    }
  }
  if (!source && (trust === "requested" || fallback !== undefined)) {
    const key = trust === "requested" ? "trust" : "fallback";
    throw configError(
      `${at}.${key} only applies to a source package ("source": true)`,
      `${at}.${key}`,
      trust === "requested"
        ? `an installed package gets exactly what ${at}.grants records: run \`hypen add ${from}\` to review and record what it requests`
        : `remove "fallback", or add "source": true if ${from} is a module project in this repository`
    );
  }
  return { from, field: at, source, trust: trust ?? (source ? "requested" : "explicit"), fallback, only, as, grants };
}

function parseText(value: unknown, field: string, example: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${field} must be a non-empty string`, field, `e.g. ${JSON.stringify(field.split(".").pop())}: ${JSON.stringify(example)}`);
  }
  return value;
}

/**
 * Parse the raw `wasm` section of hypen.json.
 *
 * @throws {BuildError} `CONFIG_INVALID` naming the offending field
 *   (e.g. `wasm.modules.Cart.reads`) on unknown keys or wrong types.
 */
export function parseWasmConfig(raw: unknown): WasmConfig {
  const modules = new Map<string, ModuleGrants>();
  const packages = new Map<string, PackageDeclaration>();
  const meta: PackageMeta = { ...NO_META, external: [] };
  if (raw === undefined || raw === null) return { language: undefined, modules, packages, package: meta };
  if (!isRecord(raw)) {
    throw configError(
      `"wasm" must be an object`,
      "wasm",
      `e.g. "wasm": { "language": "ts", "modules": { "Cart": { "http": true } } }`
    );
  }
  let language: Language | undefined;
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "language":
        // An explicit `undefined` (a config object built in code) means "unset".
        if (value !== undefined) language = parseLanguage(value);
        break;
      case "modules":
        if (value === undefined) break;
        if (!isRecord(value)) {
          throw configError(
            `wasm.modules must be an object keyed by module name`,
            "wasm.modules",
            `e.g. "modules": { "Cart": { "reads": ["Catalog"] } }`
          );
        }
        for (const [name, grants] of Object.entries(value)) {
          modules.set(name, parseModuleGrants(grants, `wasm.modules.${name}`));
        }
        break;
      case "packages":
        if (value === undefined) break;
        if (!isRecord(value)) {
          throw configError(
            `wasm.packages must be an object keyed by package name or path`,
            "wasm.packages",
            `e.g. "packages": { "@acme/checkout": {} } — \`hypen add @acme/checkout\` writes it`
          );
        }
        for (const [from, entry] of Object.entries(value)) packages.set(from, parsePackage(from, entry));
        break;
      case "name":
        meta.name = parseText(value, "wasm.name", "@acme/checkout");
        break;
      case "version":
        meta.version = parseText(value, "wasm.version", "1.0.0");
        break;
      case "description":
        meta.description = parseText(value, "wasm.description", "Checkout modules");
        break;
      case "npm":
        meta.npm = parseText(value, "wasm.npm", "@acme/checkout");
        break;
      case "exports":
        meta.exports = parseNameList(value, "wasm.exports", "component names");
        break;
      case "external":
        meta.external = parseNameList(value, "wasm.external", "module names");
        break;
      default:
        throw unknownKey("wasm", key, ["language", "modules"], ["packages", "name", "version", "description", "npm", "exports", "external"]);
    }
  }
  return { language, modules, packages, package: meta };
}

/**
 * Resolve every stateful module's capability grants against the discovered
 * modules. Each stateful module gets an explicit entry — the host is
 * deny-by-default, so the defaults are no reads, no dispatches, no storage
 * beyond `local`, no HTTP. Grant targets match module names case-insensitively
 * and come out as scopes.
 *
 * @throws {BuildError} `CONFIG_UNKNOWN_MODULE` when a `wasm.modules` key or a
 *   `reads` / `dispatches` target names no stateful module.
 */
export function resolveModuleCapabilities(
  config: WasmConfig,
  statefulNames: readonly ModuleName[],
  statelessNames: readonly ModuleName[] = []
): Map<ModuleName, Capabilities> {
  const known = statefulNames.join(", ") || "none";
  const byScope = new Map<ScopeName, ModuleName>(statefulNames.map((n) => [scopeOf(n), n]));
  const lookup = (written: string): ModuleName | undefined =>
    byScope.get(written.toLowerCase() as ScopeName);
  const stateless = new Set<string>(statelessNames);
  const stateful = new Set<string>(statefulNames);

  const unknownModule = (field: string, why: string, hint: string): BuildError =>
    new BuildError(`${CONFIG_FILE}: ${field}${why}. Stateful modules: ${known}`, {
      code: "CONFIG_UNKNOWN_MODULE",
      file: CONFIG_FILE,
      field,
      hint,
    });

  for (const name of config.modules.keys()) {
    if (stateful.has(name)) continue;
    const field = `wasm.modules.${name}`;
    if (stateless.has(name)) {
      throw unknownModule(
        field,
        `: "${name}" is a stateless (template-only) component, which has no wasm to grant capabilities to`,
        `remove ${field} from ${CONFIG_FILE}, or give ${name} a module`
      );
    }
    const cased = lookup(name);
    throw unknownModule(
      field,
      cased ? `: no module named "${name}" (did you mean "${cased}"?)` : `: no module named "${name}"`,
      cased
        ? `rename the key to "${cased}" (wasm.modules keys are case-sensitive)`
        : `remove ${field} from ${CONFIG_FILE}, or fix the name`
    );
  }

  const external = config.package.external;
  const isExternal = (written: string): boolean => external.some((n) => n.toLowerCase() === written.toLowerCase());
  const out = new Map<ModuleName, Capabilities>();
  for (const name of statefulNames) {
    const grants = config.modules.get(name);
    const scopes = (key: "reads" | "dispatches"): ScopeName[] => {
      const resolved: ScopeName[] = [];
      for (const target of grants?.[key] ?? []) {
        const field = `${grants?.field ?? `wasm.modules.${name}`}.${key}`;
        const module = lookup(target);
        if (module === undefined) {
          // A module the installing app provides (`wasm.external`): part of
          // what this module REQUESTS (hypen-modules.json), but not of this
          // project's own app.json — there is no such module to grant here.
          if (isExternal(target)) continue;
          throw unknownModule(
            field,
            ` names unknown module "${target}"`,
            stateless.has(target)
              ? `"${target}" is stateless (it has no state to ${key === "reads" ? "read" : "dispatch to"}); remove it from ${field}`
              : `use one of the stateful module names, or remove "${target}" from ${field} — or, if "${target}" is a module of the app that will install this package, list it in "wasm.external"`
          );
        }
        const scope = scopeOf(module);
        if (!resolved.includes(scope)) resolved.push(scope);
      }
      return resolved;
    };
    out.set(name, {
      reads: scopes("reads"),
      dispatches: scopes("dispatches"),
      storage: grants?.storage ?? [],
      http: grants?.http ?? false,
      httpHosts: grants?.httpHosts ?? [],
    });
  }
  return out;
}

/**
 * What a module of this project REQUESTS from whoever installs it: its
 * `wasm.modules.<Name>` declaration, with targets written as module names —
 * the project's own (as discovered) or the ones listed in `wasm.external`.
 * Call after {@link resolveModuleCapabilities} (which rejects unknown targets).
 */
export function declaredRequests(
  config: WasmConfig,
  name: ModuleName,
  statefulNames: readonly ModuleName[]
): ModuleRequests {
  const grants = config.modules.get(name);
  const named = (targets: readonly string[]): string[] => {
    const out: string[] = [];
    for (const target of targets) {
      const resolved =
        statefulNames.find((n) => n.toLowerCase() === target.toLowerCase()) ??
        config.package.external.find((n) => n.toLowerCase() === target.toLowerCase()) ??
        target;
      if (!out.includes(resolved)) out.push(resolved);
    }
    return out;
  };
  return asRequests({
    reads: named(grants?.reads ?? []),
    dispatches: named(grants?.dispatches ?? []),
    storage: grants?.storage ?? [],
    http: grants?.http ?? false,
    httpHosts: grants?.httpHosts ?? [],
  });
}
