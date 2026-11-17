// GENERATED — do not edit. This file is hypen-web/packages/server/src/hosted/module-package.ts,
// copied (with its HTTP-grammar import pointed at ./http-grammar.js) below this header by `bun hypen-web/scripts/sync-http-grammar.ts`
// (edit that file, then run the script; `--check` and the http-grammar-sync
// tests fail on drift).

/**
 * Module packages: `hypen-modules.json`, the manifest that travels with
 * built Hypen WASM modules, and `hypen.lock.json`, the record of what an
 * app reviewed when it installed one.
 *
 * A package is what `hypen build --target wasm` produces and `hypen add`
 * installs: every stateful module of a project (a `.wasm` Component plus
 * its `.hypen` template), the template-only components those templates
 * use, the package's `entry` and the names it `exports` to the app's own
 * templates.
 *
 * Two vocabularies that must never be confused live here as distinct types:
 *
 * - {@link ModuleRequests}: what a module ASKS for. Written by the module's
 *   author into the manifest. Never a grant.
 * - {@link ModuleGrant}: what an app DECIDED to give it. Written into the
 *   app's `hypen.json` by `hypen add` (or by hand).
 *
 * One file, two homes: this is the canonical source
 * (`hypen-web/packages/server/src/hosted/module-package.ts`, used by
 * `@hypen-space/server`); `hypen-cli/src/wasm/module-package.ts` is a
 * generated copy (`bun hypen-web/scripts/sync-http-grammar.ts`), because the
 * CLI validates manifests with whatever `@hypen-space/server` the project
 * has installed — which may predate this file. Node only (fs + crypto).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatHostPattern, parseHostPattern } from "./http-grammar.js";

/** The manifest's file name inside a package directory. */
export const PACKAGE_MANIFEST_FILE = "hypen-modules.json";
/** The manifest format this code reads and writes (`"hypenModules": 1`). */
export const PACKAGE_MANIFEST_VERSION = 1;
/** The app-side record of reviewed packages, next to `hypen.json`. */
export const MODULE_LOCK_FILE = "hypen.lock.json";
export const MODULE_LOCK_VERSION = 1;

// ── errors ──────────────────────────────────────────────────────────────────

export type ModulePackageErrorCode =
  /** No manifest where one was expected. */
  | "MANIFEST_NOT_FOUND"
  /** The manifest is not JSON, or a field has the wrong shape. */
  | "MANIFEST_INVALID"
  /** `hypenModules` names a format newer than this tool reads. */
  | "MANIFEST_VERSION_UNSUPPORTED"
  /** A path in the manifest points outside the manifest's directory. */
  | "MANIFEST_PATH_ESCAPES"
  /** A component or template the manifest lists does not exist. */
  | "MODULE_FILE_MISSING"
  /** A listed component is empty, not wasm, or a core module. */
  | "COMPONENT_INVALID"
  /** A component's bytes do not match the recorded integrity. */
  | "INTEGRITY_MISMATCH"
  /** An npm package named in `from` is not installed. */
  | "PACKAGE_NOT_FOUND"
  /** The package (or directory) carries no Hypen module manifest. */
  | "PACKAGE_NOT_HYPEN"
  /** `hypen.lock.json` is not JSON or has the wrong shape. */
  | "LOCK_INVALID"
  /** The package requests more than what was reviewed when it was added. */
  | "REQUESTS_CHANGED"
  /** The package is used but was never reviewed (no lock entry). */
  | "NOT_RECORDED"
  /** A module name that the package does not have. */
  | "UNKNOWN_PACKAGE_MODULE"
  /** A `namespace`, `as` or `map` entry that cannot be applied. */
  | "NAMING_INVALID";

export interface ModulePackageErrorInfo {
  code: ModulePackageErrorCode;
  /** The package the failure concerns (its `from`, or manifest name). */
  package?: string;
  module?: string;
  file?: string;
  field?: string;
  /** One concrete next step. */
  hint?: string;
  cause?: unknown;
}

export class ModulePackageError extends Error {
  readonly code: ModulePackageErrorCode;
  readonly package?: string;
  readonly module?: string;
  readonly file?: string;
  readonly field?: string;
  readonly hint?: string;

  constructor(message: string, info: ModulePackageErrorInfo) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "ModulePackageError";
    this.code = info.code;
    this.package = info.package;
    this.module = info.module;
    this.file = info.file;
    this.field = info.field;
    this.hint = info.hint;
  }
}

// ── capabilities: requests vs grants ────────────────────────────────────────

/** Storage tiers beyond the always-available, module-private `local`. */
export type StorageTier = "app" | "cloud";
const STORAGE_TIERS: readonly StorageTier[] = ["app", "cloud"];

/** The shape requests and grants share. Use the branded types below. */
export interface CapabilitySet {
  /** Modules whose state may be read / subscribed to (names as authored). */
  reads: string[];
  /** Modules actions may be dispatched to. */
  dispatches: string[];
  storage: StorageTier[];
  http: boolean;
  /** Canonical host patterns `http` is limited to; empty = any host. */
  httpHosts: string[];
}

declare const REQUESTS: unique symbol;
declare const GRANT: unique symbol;

/** What a module asks for (from its manifest). Not assignable to a grant. */
export type ModuleRequests = CapabilitySet & { readonly [REQUESTS]: true };
/** What an app decided to give a module. Not assignable to requests. */
export type ModuleGrant = CapabilitySet & { readonly [GRANT]: true };

/** One thing a module can ask for / be given. */
export type Capability =
  | { kind: "reads"; target: string }
  | { kind: "dispatches"; target: string }
  | { kind: "storage"; tier: StorageTier }
  /** `hosts` empty: any host. */
  | { kind: "http"; hosts: string[] };

/** The stable id of a capability: `reads:Cart`, `storage:app`, `http`. */
export function capabilityId(capability: Capability): string {
  switch (capability.kind) {
    case "reads":
    case "dispatches":
      return `${capability.kind}:${capability.target}`;
    case "storage":
      return `storage:${capability.tier}`;
    case "http":
      return "http";
  }
}

/** A capability set as individual capabilities, in a stable order. */
export function capabilitiesOf(set: CapabilitySet): Capability[] {
  return [
    ...set.reads.map((target): Capability => ({ kind: "reads", target })),
    ...set.dispatches.map((target): Capability => ({ kind: "dispatches", target })),
    ...set.storage.map((tier): Capability => ({ kind: "storage", tier })),
    ...(set.http ? [{ kind: "http", hosts: set.httpHosts } satisfies Capability] : []),
  ];
}

/**
 * The one human-readable rendering of a capability, used by `hypen add`,
 * `hypen modules` and every error that names one. `notable` is set for the
 * capabilities a reviewer should look at twice, with the reason.
 */
export function describeCapability(capability: Capability): { text: string; notable: string | null } {
  switch (capability.kind) {
    case "reads":
      return { text: `read the state of the ${capability.target} module`, notable: null };
    case "dispatches":
      return {
        text: `dispatch actions to the ${capability.target} module`,
        notable: `it can run ${capability.target}'s action handlers`,
      };
    case "storage":
      return capability.tier === "app"
        ? { text: "read and write app storage (shared across the app, kept on this device)", notable: null }
        : {
            text: "read and write cloud storage (synced off this device)",
            notable: "data leaves the device",
          };
    case "http":
      return capability.hosts.length === 0
        ? { text: "make HTTP requests to any host", notable: "no host allowlist" }
        : { text: `make HTTP requests to ${capability.hosts.join(", ")}`, notable: null };
  }
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether `set` covers `capability` (module names compare case-insensitively). */
export function covers(set: CapabilitySet, capability: Capability): boolean {
  switch (capability.kind) {
    case "reads":
      return set.reads.some((t) => sameName(t, capability.target));
    case "dispatches":
      return set.dispatches.some((t) => sameName(t, capability.target));
    case "storage":
      return set.storage.includes(capability.tier);
    case "http":
      if (!set.http) return false;
      if (set.httpHosts.length === 0) return true;
      // A narrowed set covers only requests for hosts it lists.
      return capability.hosts.length > 0 && capability.hosts.every((h) => set.httpHosts.includes(h));
  }
}

/** The capabilities of `wanted` that `have` does not cover. */
export function notCovered(wanted: CapabilitySet, have: CapabilitySet): Capability[] {
  const missing: Capability[] = [];
  for (const capability of capabilitiesOf(wanted)) {
    if (covers(have, capability)) continue;
    if (capability.kind === "http" && have.http && capability.hosts.length > 0) {
      // Only the hosts that are new.
      missing.push({ kind: "http", hosts: capability.hosts.filter((h) => !have.httpHosts.includes(h)) });
    } else {
      missing.push(capability);
    }
  }
  return missing;
}

/** A module that asks for nothing. */
export function noRequests(): ModuleRequests {
  return asRequests({ reads: [], dispatches: [], storage: [], http: false, httpHosts: [] });
}

/** Declare `set` to be what a module's author says it needs. */
export function asRequests(set: CapabilitySet): ModuleRequests {
  return normalizeSet(set) as ModuleRequests;
}

/** Declare `set` to be an app's decision (e.g. read from its `hypen.json`). */
export function asGrant(set: CapabilitySet): ModuleGrant {
  return normalizeSet(set) as ModuleGrant;
}

function normalizeSet(set: CapabilitySet): CapabilitySet {
  return {
    reads: [...set.reads],
    dispatches: [...set.dispatches],
    storage: STORAGE_TIERS.filter((t) => set.storage.includes(t)),
    http: set.http,
    httpHosts: set.http ? [...set.httpHosts] : [],
  };
}

/**
 * Turn requests into a grant, one explicit decision per capability. This is
 * the only way a `ModuleRequests` becomes a `ModuleGrant`.
 */
export function decideGrant(requests: ModuleRequests, decide: (capability: Capability) => boolean): ModuleGrant {
  const grant: CapabilitySet = { reads: [], dispatches: [], storage: [], http: false, httpHosts: [] };
  for (const capability of capabilitiesOf(requests)) {
    if (!decide(capability)) continue;
    switch (capability.kind) {
      case "reads":
        grant.reads.push(capability.target);
        break;
      case "dispatches":
        grant.dispatches.push(capability.target);
        break;
      case "storage":
        grant.storage.push(capability.tier);
        break;
      case "http":
        grant.http = true;
        grant.httpHosts = [...capability.hosts];
        break;
    }
  }
  return grant as ModuleGrant;
}

/** `a` plus everything in `b` (for trusted in-repo sources). */
export function unionGrant(a: CapabilitySet, b: CapabilitySet): ModuleGrant {
  const names = (x: string[], y: string[]) => [...x, ...y.filter((n) => !x.some((m) => sameName(m, n)))];
  const http = a.http || b.http;
  // Any-host on either side wins: a union never narrows.
  const anyHost = (a.http && a.httpHosts.length === 0) || (b.http && b.httpHosts.length === 0);
  return {
    reads: names(a.reads, b.reads),
    dispatches: names(a.dispatches, b.dispatches),
    storage: STORAGE_TIERS.filter((t) => a.storage.includes(t) || b.storage.includes(t)),
    http,
    httpHosts: !http || anyHost ? [] : [...new Set([...a.httpHosts, ...b.httpHosts])],
  } as ModuleGrant;
}

// ── parsing ─────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `raw` cannot name a module, or `null` when it can. */
export function moduleNameProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return "a name must be a non-empty string";
  if (raw.includes(":")) return `"${raw}" contains ":" (the engine's scope separator)`;
  if (raw.toLowerCase().startsWith("__hypen_")) return `"${raw}" uses the reserved "__hypen_" prefix`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    return `"${raw}" is not a component name (letters, digits and "_", not starting with a digit)`;
  }
  return null;
}

/** Where a parse problem is, and what to do about it. */
export interface ParseProblem {
  field: string;
  message: string;
  hint?: string;
}

/**
 * Parse a capability set (`reads` / `dispatches` / `storage` / `http` /
 * `httpHosts`) with the rules `hypen.json` grants follow: lists of names,
 * the two storage tiers, a boolean `http`, `httpHosts` in the engine's
 * host-pattern grammar (stored canonically) and only beside `http: true`.
 * Unknown keys are the caller's business (`known` lists the keys to read).
 */
export function parseCapabilitySet(raw: Record<string, unknown>, at: string): CapabilitySet | ParseProblem {
  const set: CapabilitySet = { reads: [], dispatches: [], storage: [], http: false, httpHosts: [] };
  for (const key of ["reads", "dispatches"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
      return { field: `${at}.${key}`, message: `${at}.${key} must be an array of module names (strings)`, hint: `e.g. "${key}": ["Cart"]` };
    }
    for (const name of value) {
      const problem = moduleNameProblem(name);
      if (problem !== null) return { field: `${at}.${key}`, message: `${at}.${key}: ${problem}` };
      if (!set[key].some((n) => sameName(n, name))) set[key].push(name);
    }
  }
  if (raw.storage !== undefined) {
    if (!Array.isArray(raw.storage)) {
      return { field: `${at}.storage`, message: `${at}.storage must be an array of "app" / "cloud"`, hint: `e.g. "storage": ["app"]` };
    }
    for (const tier of raw.storage) {
      const known = STORAGE_TIERS.find((t) => t === tier);
      if (known === undefined) {
        return {
          field: `${at}.storage`,
          message: `${at}.storage has unknown tier ${JSON.stringify(tier)} (expected "app" or "cloud")`,
          hint: tier === "local" ? `"local" is always available; remove it` : `use "app" and/or "cloud"`,
        };
      }
      if (!set.storage.includes(known)) set.storage.push(known);
    }
  }
  if (raw.http !== undefined) {
    if (typeof raw.http !== "boolean") {
      return { field: `${at}.http`, message: `${at}.http must be true or false`, hint: `write "http": true (no quotes)` };
    }
    set.http = raw.http;
  }
  if (raw.httpHosts !== undefined) {
    const hosts = raw.httpHosts;
    if (!Array.isArray(hosts) || !hosts.every((v): v is string => typeof v === "string")) {
      return { field: `${at}.httpHosts`, message: `${at}.httpHosts must be an array of host patterns (strings)` };
    }
    for (const [index, entry] of hosts.entries()) {
      const pattern = parseHostPattern(entry);
      if (!pattern.ok) {
        return {
          field: `${at}.httpHosts[${index}]`,
          message: `${at}.httpHosts[${index}]: ${pattern.error}`,
          hint: `an entry names a host, not a URL: "api.example.com", "*.example.com" or "localhost:8080"`,
        };
      }
      const text = formatHostPattern(pattern.value);
      if (!set.httpHosts.includes(text)) set.httpHosts.push(text);
    }
    if (set.httpHosts.length > 0 && !set.http) {
      return {
        field: `${at}.httpHosts`,
        message: `${at}.httpHosts narrows http, but ${at}.http is not true`,
        hint: `add "http": true, or remove "httpHosts"`,
      };
    }
  }
  return set;
}

const isProblem = (v: CapabilitySet | ParseProblem): v is ParseProblem => "message" in v;

/** A capability set as written to JSON: only what is asked for / granted. */
export function capabilitySetToJson(set: CapabilitySet): Record<string, unknown> {
  return {
    ...(set.reads.length > 0 ? { reads: set.reads } : {}),
    ...(set.dispatches.length > 0 ? { dispatches: set.dispatches } : {}),
    ...(set.storage.length > 0 ? { storage: set.storage } : {}),
    ...(set.http ? { http: true } : {}),
    ...(set.http && set.httpHosts.length > 0 ? { httpHosts: set.httpHosts } : {}),
  };
}

// ── the manifest ────────────────────────────────────────────────────────────

/** A stateful module of a package. Paths are relative to the manifest. */
export interface PackageModule {
  name: string;
  component: string;
  /** Absent for a logic-only module. */
  template: string | undefined;
  /** The `hypen:module` contract version it was built against. */
  abi: string;
  requests: ModuleRequests;
  /** `sha256-<base64>` of the component's bytes. */
  integrity: string;
}

/** A template-only component the package's templates use. */
export interface PackageComponent {
  name: string;
  template: string;
}

export interface PackageManifest {
  /** The package's name (an npm name when it is published). */
  name: string;
  version: string;
  description: string | undefined;
  /** The package's root component, when it has one. */
  entry: string | undefined;
  /** The names an app may use in its own templates. */
  exports: string[];
  modules: PackageModule[];
  components: PackageComponent[];
}

/** `sha256-<base64>` (the Subresource Integrity form) of `bytes`. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function invalid(file: string, problem: ParseProblem): ModulePackageError {
  return new ModulePackageError(`${file}: ${problem.message}`, {
    code: "MANIFEST_INVALID",
    file,
    field: problem.field,
    hint: problem.hint ?? "rebuild the package with `hypen build --target wasm` (or `hypen pack`)",
  });
}

/** A path inside the manifest's directory, as written; rejects escapes. */
function confinedPath(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(file, { field, message: `${field} must be a file path (a non-empty string)` });
  }
  const normalized = value.replace(/\\/g, "/");
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || normalized.split("/").includes("..")) {
    throw new ModulePackageError(
      `${file}: ${field} ("${value}") points outside the manifest's directory.`,
      {
        code: "MANIFEST_PATH_ESCAPES",
        file,
        field,
        hint: "a package's files live next to its manifest; this package is malformed (or hostile) — do not install it",
      }
    );
  }
  return value;
}

/**
 * Parse the JSON value of a `hypen-modules.json` into a typed manifest.
 * Checks shape only — files are checked by {@link readModulePackage}.
 *
 * @throws {ModulePackageError} `MANIFEST_VERSION_UNSUPPORTED`,
 *   `MANIFEST_PATH_ESCAPES`, `MANIFEST_INVALID` (naming the field).
 */
export function parsePackageManifest(raw: unknown, file: string): PackageManifest {
  if (!isRecord(raw)) throw invalid(file, { field: "", message: "the manifest must be a JSON object" });
  const format = raw.hypenModules;
  if (format !== PACKAGE_MANIFEST_VERSION) {
    if (typeof format === "number" && format > PACKAGE_MANIFEST_VERSION) {
      throw new ModulePackageError(
        `${file} is a format ${format} manifest; this version of Hypen reads format ${PACKAGE_MANIFEST_VERSION}.`,
        {
          code: "MANIFEST_VERSION_UNSUPPORTED",
          file,
          field: "hypenModules",
          hint: "update @hypen-space/cli and @hypen-space/server, then try again",
        }
      );
    }
    throw invalid(file, {
      field: "hypenModules",
      message: `"hypenModules" must be ${PACKAGE_MANIFEST_VERSION} (got ${JSON.stringify(format)})`,
      hint: `this is not a Hypen module manifest; a package's manifest is its ${PACKAGE_MANIFEST_FILE}`,
    });
  }
  const text = (key: "name" | "version", fallback?: string): string => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(file, { field: key, message: `"${key}" must be a non-empty string` });
    }
    return value;
  };
  if (raw.description !== undefined && typeof raw.description !== "string") {
    throw invalid(file, { field: "description", message: `"description" must be a string` });
  }

  const seen = new Map<string, string>();
  const claim = (name: unknown, field: string): string => {
    const problem = moduleNameProblem(name);
    if (problem !== null) throw invalid(file, { field, message: `${field}: ${problem}` });
    const other = seen.get((name as string).toLowerCase());
    if (other !== undefined) {
      throw invalid(file, {
        field,
        message: `${field}: "${name as string}" is listed twice (as "${other}"); names are compared case-insensitively`,
      });
    }
    seen.set((name as string).toLowerCase(), name as string);
    return name as string;
  };

  const list = (key: "modules" | "components"): unknown[] => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value)) throw invalid(file, { field: key, message: `"${key}" must be an array` });
    return value;
  };

  const modules: PackageModule[] = list("modules").map((entry, i) => {
    const at = `modules[${i}]`;
    if (!isRecord(entry)) throw invalid(file, { field: at, message: `${at} must be an object` });
    const name = claim(entry.name, `${at}.name`);
    const requestsRaw = entry.requests ?? {};
    if (!isRecord(requestsRaw)) throw invalid(file, { field: `${at}.requests`, message: `${at}.requests must be an object` });
    const unknown = Object.keys(requestsRaw).find((k) => !["reads", "dispatches", "storage", "http", "httpHosts"].includes(k));
    if (unknown !== undefined) {
      throw invalid(file, {
        field: `${at}.requests.${unknown}`,
        message: `${at}.requests has an unknown capability "${unknown}"`,
        hint: "this package asks for something this version of Hypen does not know: update @hypen-space/cli, or do not install it",
      });
    }
    const requests = parseCapabilitySet(requestsRaw, `${at}.requests`);
    if (isProblem(requests)) throw invalid(file, requests);
    if (typeof entry.integrity !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(entry.integrity)) {
      throw invalid(file, { field: `${at}.integrity`, message: `${at}.integrity must be "sha256-<base64>" of the component` });
    }
    if (entry.abi !== undefined && typeof entry.abi !== "string") {
      throw invalid(file, { field: `${at}.abi`, message: `${at}.abi must be a string like "0.1"` });
    }
    return {
      name,
      component: confinedPath(entry.component, `${at}.component`, file),
      template: entry.template === undefined ? undefined : confinedPath(entry.template, `${at}.template`, file),
      abi: entry.abi ?? "0.1",
      requests: requests as ModuleRequests,
      integrity: entry.integrity,
    };
  });

  const components: PackageComponent[] = list("components").map((entry, i) => {
    const at = `components[${i}]`;
    if (!isRecord(entry)) throw invalid(file, { field: at, message: `${at} must be an object` });
    return { name: claim(entry.name, `${at}.name`), template: confinedPath(entry.template, `${at}.template`, file) };
  });

  if (modules.length === 0 && components.length === 0) {
    throw invalid(file, { field: "modules", message: "the package has no modules and no components" });
  }

  const has = (name: string): boolean => seen.has(name.toLowerCase());
  let entry: string | undefined;
  if (raw.entry !== undefined) {
    if (typeof raw.entry !== "string" || !has(raw.entry)) {
      throw invalid(file, { field: "entry", message: `"entry" must name one of the package's modules or components` });
    }
    entry = seen.get(raw.entry.toLowerCase());
  }
  let exports: string[];
  if (raw.exports === undefined) {
    exports = entry !== undefined ? [entry] : [...seen.values()];
  } else {
    if (!Array.isArray(raw.exports) || !raw.exports.every((v): v is string => typeof v === "string")) {
      throw invalid(file, { field: "exports", message: `"exports" must be an array of names` });
    }
    exports = raw.exports.map((name, i) => {
      if (!has(name)) {
        throw invalid(file, { field: `exports[${i}]`, message: `exports[${i}] ("${name}") names nothing in this package` });
      }
      return seen.get(name.toLowerCase()) as string;
    });
  }

  return {
    name: text("name"),
    version: text("version"),
    description: raw.description as string | undefined,
    entry,
    exports: [...new Set(exports)],
    modules,
    components,
  };
}

/** The manifest's on-disk bytes (field order is the order written). */
export function serializePackageManifest(manifest: PackageManifest): string {
  return (
    JSON.stringify(
      {
        hypenModules: PACKAGE_MANIFEST_VERSION,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        ...(manifest.entry !== undefined ? { entry: manifest.entry } : {}),
        exports: manifest.exports,
        modules: manifest.modules.map((m) => ({
          name: m.name,
          component: m.component,
          ...(m.template !== undefined ? { template: m.template } : {}),
          abi: m.abi,
          requests: capabilitySetToJson(m.requests),
          integrity: m.integrity,
        })),
        components: manifest.components.map((c) => ({ name: c.name, template: c.template })),
      },
      null,
      2
    ) + "\n"
  );
}

// ── a package on disk ───────────────────────────────────────────────────────

export interface ResolvedPackageModule extends PackageModule {
  /** Absolute paths. */
  componentPath: string;
  templatePath: string | undefined;
  /** Size of the component in bytes. */
  size: number;
}

export interface ResolvedPackageComponent extends PackageComponent {
  templatePath: string;
}

/** A manifest read from disk with its files checked. */
export interface ResolvedPackage {
  manifest: PackageManifest;
  manifestPath: string;
  /** The manifest's directory. */
  dir: string;
  modules: ResolvedPackageModule[];
  components: ResolvedPackageComponent[];
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function wasmKind(bytes: Uint8Array): "component" | "core-module" | "empty" | "not-wasm" {
  if (bytes.length === 0) return "empty";
  const magic = [0x00, 0x61, 0x73, 0x6d];
  if (bytes.length < 8 || magic.some((b, i) => bytes[i] !== b)) return "not-wasm";
  return ((bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8)) === 1 ? "component" : "core-module";
}

/**
 * Read a package for use: parse its manifest, check that every listed file
 * exists inside the package, that each component is a WebAssembly Component
 * and that its bytes match the recorded integrity.
 *
 * @throws {ModulePackageError}
 */
export function readModulePackage(manifestPath: string): ResolvedPackage {
  const file = resolve(manifestPath);
  if (!isFile(file)) {
    throw new ModulePackageError(`No module manifest at ${file}.`, {
      code: "MANIFEST_NOT_FOUND",
      file,
      hint: `a module package has a ${PACKAGE_MANIFEST_FILE} (written by \`hypen build --target wasm\` and \`hypen pack\`)`,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new ModulePackageError(`${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "MANIFEST_INVALID",
      file,
      hint: "rebuild the package with `hypen build --target wasm` (or `hypen pack`)",
      cause,
    });
  }
  const manifest = parsePackageManifest(raw, file);
  const dir = dirname(file);
  const missing = (path: string, field: string, module: string, what: string): ModulePackageError =>
    new ModulePackageError(`${file}: the ${what} of "${module}" was not found: ${path}`, {
      code: "MODULE_FILE_MISSING",
      package: manifest.name,
      module,
      file: path,
      field,
      hint: "the package is incomplete: rebuild or reinstall it",
    });

  const modules = manifest.modules.map((module, i): ResolvedPackageModule => {
    const componentPath = join(dir, module.component);
    if (!isFile(componentPath)) throw missing(componentPath, `modules[${i}].component`, module.name, "component");
    const bytes = readFileSync(componentPath);
    const kind = wasmKind(bytes);
    if (kind !== "component") {
      const what = kind === "empty" ? "an empty file" : kind === "core-module" ? "a core WebAssembly module, not a Component" : "not a WebAssembly binary";
      throw new ModulePackageError(`${file}: the component of "${module.name}" is ${what} (${componentPath}).`, {
        code: "COMPONENT_INVALID",
        package: manifest.name,
        module: module.name,
        file: componentPath,
        field: `modules[${i}].component`,
        hint: "the package is broken: rebuild it with `hypen build --target wasm`",
      });
    }
    const actual = integrityOf(bytes);
    if (actual !== module.integrity) {
      throw new ModulePackageError(
        `${manifest.name}: the component of "${module.name}" does not match its manifest ` +
          `(expected ${module.integrity}, the file is ${actual}).`,
        {
          code: "INTEGRITY_MISMATCH",
          package: manifest.name,
          module: module.name,
          file: componentPath,
          field: `modules[${i}].integrity`,
          hint: "the .wasm was changed after the manifest was written: rebuild the package (`hypen build --target wasm` / `hypen pack`) or reinstall it — do not edit the manifest to match",
        }
      );
    }
    let templatePath: string | undefined;
    if (module.template !== undefined) {
      templatePath = join(dir, module.template);
      if (!isFile(templatePath)) throw missing(templatePath, `modules[${i}].template`, module.name, "template");
    }
    return { ...module, componentPath, templatePath, size: bytes.length };
  });
  const components = manifest.components.map((component, i): ResolvedPackageComponent => {
    const templatePath = join(dir, component.template);
    if (!isFile(templatePath)) throw missing(templatePath, `components[${i}].template`, component.name, "template");
    return { ...component, templatePath };
  });
  return { manifest, manifestPath: file, dir, modules, components };
}

/** How a `from` was found. */
export type PackageLocation =
  /** A directory or manifest path. */
  | { kind: "path"; manifestPath: string }
  /** An installed npm package. */
  | { kind: "npm"; manifestPath: string; packageDir: string; packageVersion: string | undefined };

/** Whether `from` is a filesystem path rather than a package name. */
export function isPathSpec(from: string): boolean {
  return from.startsWith(".") || from.startsWith("/") || isAbsolute(from);
}

/** The manifest of the package directory `dir`: its `"hypen".modules`, else the default name. */
function manifestInDirectory(dir: string, label: string): string {
  const pkgJson = join(dir, "package.json");
  if (isFile(pkgJson)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch {
      pkg = null;
    }
    const marker = isRecord(pkg) && isRecord(pkg.hypen) ? pkg.hypen.modules : undefined;
    if (typeof marker === "string" && marker !== "") {
      const rel = relative(dir, resolve(dir, marker));
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new ModulePackageError(
          `${pkgJson}: "hypen".modules ("${marker}") points outside the package.`,
          { code: "MANIFEST_PATH_ESCAPES", package: label, file: pkgJson, field: "hypen.modules", hint: "this package is malformed (or hostile) — do not install it" }
        );
      }
      return resolve(dir, marker);
    }
  }
  const direct = join(dir, PACKAGE_MANIFEST_FILE);
  if (isFile(direct)) return direct;
  throw new ModulePackageError(`${label} is not a Hypen module package: ${dir} has no ${PACKAGE_MANIFEST_FILE}.`, {
    code: "PACKAGE_NOT_HYPEN",
    package: label,
    file: dir,
    hint:
      `a module package carries a ${PACKAGE_MANIFEST_FILE} (and, on npm, "hypen": { "modules": "${PACKAGE_MANIFEST_FILE}" } in package.json). ` +
      "Build one with `hypen pack` in the module project",
  });
}

/**
 * Find the manifest `from` names: a directory, a manifest file, or an npm
 * package installed in a `node_modules` at or above `baseDir`.
 *
 * @throws {ModulePackageError} `MANIFEST_NOT_FOUND`, `PACKAGE_NOT_FOUND`,
 *   `PACKAGE_NOT_HYPEN`, `MANIFEST_PATH_ESCAPES`.
 */
export function locateModulePackage(from: string, baseDir: string): PackageLocation {
  if (isPathSpec(from)) {
    const path = resolve(baseDir, from);
    if (!existsSync(path)) {
      throw new ModulePackageError(`Module package not found: ${path}`, {
        code: "MANIFEST_NOT_FOUND",
        package: from,
        file: path,
        hint: `"${from}" is resolved against ${resolve(baseDir)}: fix the path, or build the package there`,
      });
    }
    return { kind: "path", manifestPath: statSync(path).isDirectory() ? manifestInDirectory(path, from) : path };
  }
  for (let dir = resolve(baseDir); ; dir = dirname(dir)) {
    const packageDir = join(dir, "node_modules", ...from.split("/"));
    if (isFile(join(packageDir, "package.json"))) {
      let version: string | undefined;
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
        if (isRecord(pkg) && typeof pkg.version === "string") version = pkg.version;
      } catch {
        // manifestInDirectory reports what matters.
      }
      return { kind: "npm", manifestPath: manifestInDirectory(packageDir, from), packageDir, packageVersion: version };
    }
    if (dirname(dir) === dir) break;
  }
  throw new ModulePackageError(`The package "${from}" is not installed (no node_modules/${from} at or above ${resolve(baseDir)}).`, {
    code: "PACKAGE_NOT_FOUND",
    package: from,
    hint: `install the project's dependencies (bun install / npm install), or add it with \`hypen add ${from}\``,
  });
}

// ── names: a package in an app's namespace ──────────────────────────────────
//
// Engine scopes and component names are global to an app, so what a package
// brings must not depend on the app (or another package) having no module of
// the same name. The rule:
//
// - an EXPORTED name is the package's public API: it is installed as written
//   (`Checkout {}` in the app's templates), or under the name `as` gives it;
// - every other name is INTERNAL and installed under the package's
//   namespace: `Cart` of `@acme/checkout` is the component
//   `AcmeCheckout__Cart`, state scope `acmecheckout__cart`.
//
// Nothing inside the package changes. Its templates are rewritten when they
// are loaded (component tags and the `module X` declaration — by the engine's
// parser, `renameTemplateComponents`), and its code keeps calling siblings by
// the names it was written with: each module gets an alias table
// (`aliases`: the name its code uses → the scope it means here) that the
// engine applies at the module-host boundary.

/** Between a package's namespace and an internal name: `AcmeCheckout__Cart`. */
export const NAMESPACE_SEPARATOR = "__";

/**
 * The namespace a package's internal names live under, from its manifest
 * name: `@acme/checkout` → `AcmeCheckout`, `checkout-flow` → `CheckoutFlow`.
 * Always a component name without `_`, so `<namespace>__<Name>` reads back
 * unambiguously.
 */
export function packageNamespace(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  if (joined === "") return "Package";
  return /^[0-9]/.test(joined) ? `P${joined}` : joined;
}

/** Why `raw` cannot be a namespace, or `null` when it can. */
export function namespaceProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return "a namespace must be a non-empty string";
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) {
    return `"${raw}" is not a namespace (letters and digits, starting with a letter — e.g. "AcmeCheckout")`;
  }
  return null;
}

/** How one name of a package is installed in an app. */
export interface InstalledName {
  /** The name in the package (what its author wrote, what `hypen modules` shows). */
  name: string;
  /** The component name / (lowercased) state scope it has in the app. */
  installed: string;
  /** Whether the app's templates may use it. */
  exported: boolean;
}

/** The names of a package as installed in one app. */
export interface PackageNaming {
  namespace: string;
  /** Every module and component of the package, in manifest order. */
  names: InstalledName[];
  /** `name in the package → installed name` for the names that change: the template renames. */
  renames: Record<string, string>;
}

export interface PackageNamingOptions {
  /** Override the namespace derived from the manifest's name. */
  namespace?: string;
  /** Renames of EXPORTED names: name in the package → name in the app. */
  as?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** For messages: the package as the app refers to it. Default: the manifest's name. */
  from?: string;
}

const entriesOf = (map: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined): Array<[string, string]> =>
  map === undefined ? [] : map instanceof Map ? [...map.entries()] : Object.entries(map as Record<string, string>);

/**
 * Decide the installed name of everything in a package.
 *
 * @throws {ModulePackageError} `NAMING_INVALID`: a bad `namespace`, an `as`
 *   entry that names nothing exported or is not a component name, or two
 *   names that would be installed as the same component / scope.
 */
export function planPackageNames(manifest: PackageManifest, options: PackageNamingOptions = {}): PackageNaming {
  const from = options.from ?? manifest.name;
  const bad = (message: string, info: { module?: string; field?: string; hint: string }): ModulePackageError =>
    new ModulePackageError(`${from}: ${message}`, { code: "NAMING_INVALID", package: from, ...info });

  if (options.namespace !== undefined) {
    const problem = namespaceProblem(options.namespace);
    if (problem !== null) throw bad(problem, { field: "namespace", hint: `e.g. "namespace": "${packageNamespace(manifest.name)}"` });
  }
  const namespace = options.namespace ?? packageNamespace(manifest.name);
  const all = [...manifest.modules.map((m) => m.name), ...manifest.components.map((c) => c.name)];
  const isExported = (name: string): boolean => manifest.exports.some((e) => sameName(e, name));

  const as = new Map<string, string>();
  for (const [name, renamed] of entriesOf(options.as)) {
    const known = all.find((n) => sameName(n, name));
    if (known === undefined) {
      throw bad(`cannot install "${name}" as "${renamed}": the package has nothing of that name (it has: ${all.join(", ")})`, {
        module: name,
        field: `as.${name}`,
        hint: "fix the name",
      });
    }
    if (!isExported(known)) {
      throw bad(
        `cannot install "${known}" as "${renamed}": it is internal to the package (exports: ${manifest.exports.join(", ") || "nothing"})`,
        {
          module: known,
          field: `as.${name}`,
          hint: `internal names are namespaced (${namespace}${NAMESPACE_SEPARATOR}${known}) and never clash with the app's; only exported names are renamed`,
        }
      );
    }
    const problem = moduleNameProblem(renamed);
    if (problem !== null) throw bad(`cannot install "${known}" as "${renamed}": ${problem}`, { module: known, field: `as.${name}`, hint: `e.g. ${known}2` });
    as.set(known, renamed);
  }

  const names: InstalledName[] = all.map((name) => {
    const exported = isExported(name);
    return { name, installed: exported ? (as.get(name) ?? name) : `${namespace}${NAMESPACE_SEPARATOR}${name}`, exported };
  });
  const seen = new Map<string, InstalledName>();
  for (const entry of names) {
    const other = seen.get(entry.installed.toLowerCase());
    if (other !== undefined) {
      throw bad(
        `"${entry.name}" and "${other.name}" would both be installed as "${entry.installed}"`,
        { module: entry.name, field: "as", hint: "choose another name in `as`" }
      );
    }
    seen.set(entry.installed.toLowerCase(), entry);
  }
  const renames: Record<string, string> = {};
  for (const entry of names) if (entry.installed !== entry.name) renames[entry.name] = entry.installed;
  return { namespace, names, renames };
}

/** The installed name of `name` (compared case-insensitively), if the package has it. */
export function installedNameOf(naming: PackageNaming, name: string): InstalledName | undefined {
  return naming.names.find((n) => sameName(n.name, name));
}

/** The package-relative name behind an installed name, if `installed` is one of this package's. */
export function packageNameOf(naming: PackageNaming, installed: string): InstalledName | undefined {
  return naming.names.find((n) => sameName(n.installed, installed));
}

/**
 * The alias table of one module of a package: for every module it may read
 * or dispatch to (`access`: its grant), the engine scope that name means in
 * this app — when that is not simply the scope of the name.
 *
 * - a sibling in the package → its installed name;
 * - a module the app provides → the app's module of that name, or the one
 *   `map` points the name at (`{ Cart: "Basket" }`).
 *
 * Keys and values are lowercase scopes. Empty for a module whose names all
 * mean themselves.
 *
 * @throws {ModulePackageError} `NAMING_INVALID`: a `map` entry for a name
 *   the module does not use, for a sibling in the package, or to something
 *   that is not a module name — or two names that end up meaning one scope.
 */
export function moduleAliases(
  naming: PackageNaming,
  module: string,
  access: Pick<CapabilitySet, "reads" | "dispatches">,
  map: Readonly<Record<string, string>> = {},
  from = "the package"
): Record<string, string> {
  const bad = (message: string, name: string, hint: string): ModulePackageError =>
    new ModulePackageError(`${from}: ${message}`, { code: "NAMING_INVALID", package: from, module, field: `map.${module}.${name}`, hint });
  const used = [...access.reads, ...access.dispatches.filter((d) => !access.reads.some((r) => sameName(r, d)))];
  for (const [name, target] of Object.entries(map)) {
    const sibling = installedNameOf(naming, name);
    if (sibling !== undefined) {
      throw bad(
        `cannot map "${name}" of ${module} to "${target}": "${sibling.name}" is a module of the package itself`,
        name,
        "a map points a name the package expects the APP to provide at one of the app's modules; a package's own modules are not replaceable"
      );
    }
    if (!used.some((u) => sameName(u, name))) {
      throw bad(
        `cannot map "${name}" of ${module} to "${target}": ${module} is not granted "${name}"` +
          (used.length > 0 ? ` (it may reach: ${used.join(", ")})` : " (it reaches no other module)"),
        name,
        `a map says which module a granted name means; grant "${name}" first, or remove the entry`
      );
    }
    const problem = moduleNameProblem(target);
    if (problem !== null) throw bad(`cannot map "${name}" of ${module}: ${problem}`, name, `e.g. "${name}": "Basket"`);
  }
  const aliases: Record<string, string> = {};
  for (const list of [access.reads, access.dispatches]) {
    const scopes = new Map<string, string>();
    for (const name of list) {
      const sibling = installedNameOf(naming, name);
      const mapped = Object.entries(map).find(([key]) => sameName(key, name))?.[1];
      const scope = (sibling?.installed ?? mapped ?? name).toLowerCase();
      const other = scopes.get(scope);
      if (other !== undefined && !sameName(other, name)) {
        throw bad(
          `"${other}" and "${name}" of ${module} would both mean the module "${scope}"`,
          name,
          "a module reaches each module under one name: point the map somewhere else, or drop one of the two grants"
        );
      }
      scopes.set(scope, name);
      if (scope !== name.toLowerCase()) aliases[name.toLowerCase()] = scope;
    }
  }
  return aliases;
}

// ── the lock: what was reviewed ─────────────────────────────────────────────

export interface LockedModule {
  /** The component's integrity when it was reviewed. */
  integrity: string;
  /** What the module requested when it was reviewed. */
  requests: ModuleRequests;
}

export interface LockedPackage {
  /** The manifest's `name` (differs from the key for a path). */
  name: string;
  version: string;
  /** By the module's name in the package. */
  modules: Record<string, LockedModule>;
}

/** `hypen.lock.json`: reviewed packages, keyed like `wasm.packages`. */
export type ModuleLock = Record<string, LockedPackage>;

/** What to record for `pkg` as reviewed now. */
export function lockEntryOf(pkg: ResolvedPackage): LockedPackage {
  const modules: Record<string, LockedModule> = {};
  for (const module of [...pkg.modules].sort((a, b) => a.name.localeCompare(b.name))) {
    modules[module.name] = { integrity: module.integrity, requests: module.requests };
  }
  return { name: pkg.manifest.name, version: pkg.manifest.version, modules };
}

/** Parse the JSON value of a `hypen.lock.json`. */
export function parseModuleLock(raw: unknown, file: string): ModuleLock {
  const bad = (message: string, field?: string): ModulePackageError =>
    new ModulePackageError(`${file}: ${message}`, {
      code: "LOCK_INVALID",
      file,
      field,
      hint: `${MODULE_LOCK_FILE} is written by \`hypen add\`: restore it from version control, or re-run \`hypen add <package>\` for each installed package`,
    });
  if (!isRecord(raw) || raw.hypenLock !== MODULE_LOCK_VERSION || !isRecord(raw.packages)) {
    throw bad(`expected { "hypenLock": ${MODULE_LOCK_VERSION}, "packages": { … } }`);
  }
  const lock: ModuleLock = {};
  for (const [key, entry] of Object.entries(raw.packages)) {
    const at = `packages[${JSON.stringify(key)}]`;
    if (!isRecord(entry) || typeof entry.version !== "string" || !isRecord(entry.modules)) {
      throw bad(`${at} must have a "version" and "modules"`, at);
    }
    const modules: Record<string, LockedModule> = {};
    for (const [name, module] of Object.entries(entry.modules)) {
      const mAt = `${at}.modules.${name}`;
      if (!isRecord(module) || typeof module.integrity !== "string" || !isRecord(module.requests ?? {})) {
        throw bad(`${mAt} must have an "integrity" and "requests"`, mAt);
      }
      const requests = parseCapabilitySet((module.requests ?? {}) as Record<string, unknown>, `${mAt}.requests`);
      if (isProblem(requests)) throw bad(requests.message, requests.field);
      modules[name] = { integrity: module.integrity, requests: requests as ModuleRequests };
    }
    lock[key] = { name: typeof entry.name === "string" ? entry.name : key, version: entry.version, modules };
  }
  return lock;
}

/** Read `<dir>/hypen.lock.json`; an absent file is an empty lock. */
export function readModuleLock(dir: string): ModuleLock {
  const file = join(dir, MODULE_LOCK_FILE);
  if (!isFile(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new ModulePackageError(`${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "LOCK_INVALID",
      file,
      hint: "restore it from version control, or delete it and re-run `hypen add <package>` for each installed package",
      cause,
    });
  }
  return parseModuleLock(raw, file);
}

/** The lock's on-disk bytes: keys sorted, so it diffs cleanly. */
export function serializeModuleLock(lock: ModuleLock): string {
  const packages: Record<string, unknown> = {};
  for (const key of Object.keys(lock).sort()) {
    const entry = lock[key] as LockedPackage;
    const modules: Record<string, unknown> = {};
    for (const name of Object.keys(entry.modules).sort()) {
      const module = entry.modules[name] as LockedModule;
      modules[name] = { integrity: module.integrity, requests: capabilitySetToJson(module.requests) };
    }
    packages[key] = { name: entry.name, version: entry.version, modules };
  }
  return JSON.stringify({ hypenLock: MODULE_LOCK_VERSION, packages }, null, 2) + "\n";
}

/** How a package on disk relates to what was reviewed. */
export type PackageDrift =
  /** Never reviewed. */
  | { status: "unrecorded" }
  /** Exactly what was reviewed. */
  | { status: "current" }
  /** Changed, but asks for nothing that was not reviewed. */
  | { status: "updated"; from: string; to: string }
  /** Same version, different component bytes. */
  | { status: "integrity"; version: string; modules: string[] }
  /** Asks for more than was reviewed. */
  | { status: "requests"; from: string; to: string; added: Array<{ module: string; capabilities: Capability[] }> };

/**
 * Compare `pkg` (restricted to `names`, the installed modules; default all)
 * with its lock entry.
 */
export function packageDrift(pkg: ResolvedPackage, locked: LockedPackage | undefined, names?: readonly string[]): PackageDrift {
  if (locked === undefined) return { status: "unrecorded" };
  const modules = pkg.modules.filter((m) => names === undefined || names.some((n) => sameName(n, m.name)));
  const { version } = pkg.manifest;
  const added: Array<{ module: string; capabilities: Capability[] }> = [];
  const changed: string[] = [];
  for (const module of modules) {
    const before = locked.modules[module.name];
    const capabilities = notCovered(module.requests, before?.requests ?? noRequests());
    if (capabilities.length > 0) added.push({ module: module.name, capabilities });
    if (before === undefined || before.integrity !== module.integrity) changed.push(module.name);
  }
  if (added.length > 0) return { status: "requests", from: locked.version, to: version, added };
  if (changed.length === 0 && locked.version === version) return { status: "current" };
  if (locked.version === version) {
    const reviewed = changed.filter((name) => locked.modules[name] !== undefined);
    if (reviewed.length > 0) return { status: "integrity", version, modules: reviewed };
  }
  return { status: "updated", from: locked.version, to: version };
}

/** `Pricing now also requests: …; Tax now also requests: …`. */
export function formatAddedRequests(added: ReadonlyArray<{ module: string; capabilities: Capability[] }>): string {
  return added
    .map(({ module, capabilities }) => `${module} now also requests: ${capabilities.map((c) => describeCapability(c).text).join("; ")}`)
    .join(". ");
}

/**
 * Stop on drift that needs a human: more requests than were reviewed, or
 * bytes that changed under a reviewed version. `key` is the package as
 * written in `hypen.json` / passed as `from`.
 *
 * @returns a one-line note when the package changed harmlessly, else `null`.
 * @throws {ModulePackageError} `REQUESTS_CHANGED`, `INTEGRITY_MISMATCH`.
 */
export function assertNoDrift(key: string, pkg: ResolvedPackage, drift: PackageDrift): string | null {
  switch (drift.status) {
    case "unrecorded":
    case "current":
      return null;
    case "updated":
      return (
        `${key} changed since it was reviewed (${drift.from} → ${drift.to}) without asking for anything new; ` +
        `run \`hypen add ${key} --yes\` to record it`
      );
    case "integrity":
      throw new ModulePackageError(
        `${key} ${drift.version}: the component of ${drift.modules.join(", ")} is not the one that was reviewed ` +
          `(same version, different bytes).`,
        {
          code: "INTEGRITY_MISMATCH",
          package: key,
          module: drift.modules[0],
          file: MODULE_LOCK_FILE,
          hint: `if you rebuilt or re-vendored it on purpose, review and record it: \`hypen add ${key}\`; otherwise restore the package`,
        }
      );
    case "requests":
      throw new ModulePackageError(
        `${key} ${pkg.manifest.version}: ${formatAddedRequests(drift.added)}. ` +
          `Review and run \`hypen add ${key}\` to update the grant.`,
        {
          code: "REQUESTS_CHANGED",
          package: key,
          module: drift.added[0]?.module,
          file: MODULE_LOCK_FILE,
          hint: `the package was reviewed at ${drift.from}; nothing new is granted until you run \`hypen add ${key}\` (interactive) or \`hypen add ${key} --yes\``,
        }
      );
  }
}
