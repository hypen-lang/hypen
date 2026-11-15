/**
 * The `wasm` section of hypen.json: parsed once, at the boundary, into a
 * fully-typed and normalised `WasmConfig`. Shape errors name the offending
 * field; whether the *module names* in it exist is decided later, against
 * what discovery found (`resolveModuleCapabilities`).
 */

import { BuildError } from "../build-error.js";
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
}

/** The parsed `wasm` section. Every field is present; absent input means defaults. */
export interface WasmConfig {
  /** Explicit source language; `undefined` means detect from the project. */
  language: Language | undefined;
  /** Grants keyed by the module name as written in hypen.json. */
  modules: ReadonlyMap<string, ModuleGrants>;
}

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

function unknownKey(path: string, key: string, known: readonly string[]): BuildError {
  const expected =
    known.length === 2
      ? `"${known[0]}" or "${known[1]}"`
      : `${known.slice(0, -1).map((k) => `"${k}"`).join(", ")} or "${known[known.length - 1]}"`;
  const guess = closestKey(key, known);
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

const GRANT_KEYS = ["reads", "dispatches", "storage", "http"] as const;

function parseModuleGrants(raw: unknown, at: string): ModuleGrants {
  if (!isRecord(raw)) {
    throw configError(
      `${at} must be an object`,
      at,
      `e.g. { "reads": ["Catalog"], "storage": ["app"], "http": true }`
    );
  }
  const grants: ModuleGrants = { reads: [], dispatches: [], storage: [], http: false };
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
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
      default:
        throw unknownKey(at, key, GRANT_KEYS);
    }
  }
  return grants;
}

/**
 * Parse the raw `wasm` section of hypen.json.
 *
 * @throws {BuildError} `CONFIG_INVALID` naming the offending field
 *   (e.g. `wasm.modules.Cart.reads`) on unknown keys or wrong types.
 */
export function parseWasmConfig(raw: unknown): WasmConfig {
  const modules = new Map<string, ModuleGrants>();
  if (raw === undefined || raw === null) return { language: undefined, modules };
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
      default:
        throw unknownKey("wasm", key, ["language", "modules"]);
    }
  }
  return { language, modules };
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

  const out = new Map<ModuleName, Capabilities>();
  for (const name of statefulNames) {
    const grants = config.modules.get(name);
    const scopes = (key: "reads" | "dispatches"): ScopeName[] => {
      const resolved: ScopeName[] = [];
      for (const target of grants?.[key] ?? []) {
        const field = `wasm.modules.${name}.${key}`;
        const module = lookup(target);
        if (module === undefined) {
          throw unknownModule(
            field,
            ` names unknown module "${target}"`,
            stateless.has(target)
              ? `"${target}" is stateless (it has no state to ${key === "reads" ? "read" : "dispatch to"}); remove it from ${field}`
              : `use one of the stateful module names, or remove "${target}" from ${field}`
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
    });
  }
  return out;
}
