/**
 * The vocabulary of the wasm build: what a project, a component and a build
 * result are. Everything past the config/discovery boundary works on these
 * types — nothing downstream handles `unknown` or bare strings whose meaning
 * depends on context.
 */

import { BuildError } from "../build-error.js";

/** Source language of a project's modules. One build compiles one language. */
export type Language = "ts" | "go" | "rust";

export const LANGUAGES: readonly Language[] = ["ts", "go", "rust"];

/**
 * A `hypen:module` contract version: `"0.1"` is the sync reducer world,
 * `"0.2"` the Component-Model-async one (Rust only today).
 */
export type Abi = "0.1" | "0.2";

/** Storage tiers a module can be granted beyond the always-on `local`. */
export type GrantableStorage = "app" | "cloud";

export const GRANTABLE_STORAGE: readonly GrantableStorage[] = ["app", "cloud"];

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * A component name as authored (`Counter`): the template tag, the manifest
 * `name`, and the stem of its `.wasm` / `.hypen` output files.
 */
export type ModuleName = Brand<string, "ModuleName">;

/**
 * The engine state scope of a module: its name lowercased. Capability grants
 * (`reads` / `dispatches`) are expressed in scopes because that is how the
 * host keys modules. Kept distinct from `ModuleName` so a cased name can
 * never be written where the host expects a scope (it would silently match
 * nothing).
 */
export type ScopeName = Brand<string, "ScopeName">;

/**
 * Check that `raw` can name a module. The engine derives the state scope from
 * the name and rejects scopes that are empty or contain `:` (its
 * `scope:action` separator), so such a module could be built but never
 * registered.
 */
export function parseModuleName(raw: string): ModuleName {
  if (raw.length === 0 || raw.includes(":")) {
    throw new BuildError(
      `"${raw}" is not a valid module name: names must be non-empty and must not contain ":"`,
      {
        code: "MODULE_NAME_INVALID",
        module: raw,
        hint: `rename the component (the engine uses ":" to separate a module's scope from an action name)`,
      }
    );
  }
  return raw as ModuleName;
}

export function scopeOf(name: ModuleName): ScopeName {
  return name.toLowerCase() as ScopeName;
}

/** The capability grants of one stateful module, as the host consumes them. */
export interface Capabilities {
  /** Sibling scopes whose state this module may read / subscribe to. */
  reads: ScopeName[];
  /** Sibling scopes this module may dispatch actions to. */
  dispatches: ScopeName[];
  /** Storage tiers beyond `local` (which the host always grants). */
  storage: GrantableStorage[];
  /** Outbound HTTP (`wasi:http`). */
  http: boolean;
}

/** A template-only building block (`Header()`): UI, no wasm, no state scope. */
export interface StatelessComponent {
  kind: "stateless";
  name: ModuleName;
  /** The `.hypen` template source. */
  template: string;
}

/** A component with a module to compile; `S` is what its language builds from. */
export interface StatefulModule<S> {
  kind: "stateful";
  name: ModuleName;
  template: string;
  source: S;
}

export type Component<S> = StatefulModule<S> | StatelessComponent;

/** What discovery found in a project, in manifest order. */
export interface Discovery<S> {
  stateful: StatefulModule<S>[];
  stateless: StatelessComponent[];
}

/** The resolved locations of the project being built. All paths absolute. */
export interface Project {
  /** Where hypen.json / Cargo.toml / go.mod live. */
  projectDir: string;
  componentsDir: string;
  /** The entry component's name, as configured (not yet known to exist). */
  entry: string;
  /**
   * Names declared PREBUILT in hypen.json (`wasm.modules.<Name>.component`).
   * Discovery never treats a component directory of one of these as a module
   * of another language: its module is the declared `.wasm`.
   */
  prebuilt?: ReadonlySet<string>;
}

/**
 * A module declared prebuilt and resolved against the project: the files
 * exist, and the component is a WebAssembly Component.
 */
export interface PrebuiltModule {
  kind: "prebuilt";
  name: ModuleName;
  /** Absolute path of the `.wasm` Component. */
  componentPath: string;
  /** Absolute path of the declared `.hypen` template, if one was declared. */
  templatePath: string | undefined;
  /** The declared template's source; `undefined` when none was declared. */
  template: string | undefined;
  /** `wasm.modules.<Name>` — where it is declared, for messages. */
  field: string;
}

/** A module's compiled component, written into the build's staging dir. */
export interface BuiltModule {
  name: ModuleName;
  /** Absolute path of the `.wasm` the builder wrote. */
  wasmPath: string;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
