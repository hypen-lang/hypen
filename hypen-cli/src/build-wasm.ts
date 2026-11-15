/**
 * `hypen build --target wasm`
 *
 * Builds a Hypen app into portable WebAssembly **components** — one
 * `<Module>.wasm` per stateful module — plus the declarative `<Module>.hypen`
 * UI assets and an `app.json` manifest. The output runs offline on any host
 * that speaks the `hypen:module` contract (e.g. the `hypen-runtime` binary:
 * `hypen-runtime --app dist/wasm/app.json`).
 *
 * This is the *portable target* described in `wit/AUTHORING_MODEL.md`:
 * the same authoring API (`app.defineState().onAction().build()` + a
 * `.hypen` template) targets either the in-process browser SPA (`hypen build`)
 * or a sandboxed `.wasm` (`hypen build --target wasm`). The artifact shape is
 * selected by `--target`, not by a new noun.
 *
 * ## TypeScript pipeline (per stateful module)
 *
 *   1. **Codegen** — emit a generic WIT shim that adapts the module's
 *      `HypenModuleDefinition` (initial state + action/lifecycle handlers) to
 *      the `hypen:module` reducer ABI (`init` / `dispatch` / lifecycle /
 *      `actions`). The author never writes WIT.
 *   2. **Bundle** — esbuild bundles the shim + the user module + its imports
 *      (`@hypen-space/core`) into one ESM file. Node built-ins that sit in
 *      lazy code paths a reducer never runs are stubbed so the bundle targets
 *      WASI, not Node.
 *   3. **Componentize** — `jco componentize` wraps the bundle (carrying the
 *      StarlingMonkey JS engine) into a Component implementing `hypen:module`.
 *
 * ## Go pipeline (per stateful module)
 *
 *   1. **Bindings** — `wit-bindgen-go generate` emits the `hypen:module`
 *      bindings into the project's `internal/bindings/` (once).
 *   2. **Componentize** — `tinygo build -target=wasip2 -wit-world tinygo-module`
 *      compiles each component's Go package directly to a Component. The Go
 *      module implements the reducer ABI against the generated bindings.
 *
 * ## Rust pipeline
 *
 *   The crate (one `Cargo.toml`) implements the `hypen:module` world directly
 *   (`wit_bindgen::generate!` + `impl Guest` — Rust's idiomatic component
 *   path). The CLI provisions `wit/`, runs `cargo build --release --target
 *   wasm32-wasip2` (which emits a Component natively), and copies the output to
 *   the entry's `.wasm`.
 *
 * The language is detected from the project (Rust via `Cargo.toml`, Go via
 * `go.mod`, TypeScript otherwise) unless `wasm.language` in hypen.json names
 * it explicitly. The orchestration, manifest, and asset emission are
 * language-agnostic.
 *
 * ## Capabilities (`app.json`)
 *
 * The host is deny-by-default, so every stateful module's manifest entry
 * carries explicit `reads` / `dispatches` / `storage` / `http` grants, sourced
 * from `wasm.modules.<Module>` in hypen.json (see `parseWasmConfig`). A module
 * with no section gets nothing beyond `local` storage (which the host always
 * grants).
 *
 * Library code never exits the process: expected failures throw
 * `BuildError`, which `bin/hypen.ts` prints before exiting.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "fs";
import { join, resolve, dirname, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawn } from "child_process";
import { boldPink, pink, dim, yellow } from "./colors.js";
import { BuildError } from "./build-error.js";

export { BuildError };

/** Build target language, detected from the project's files (or overridden). */
export type Language = "ts" | "go" | "rust";

const LANGUAGES: readonly Language[] = ["ts", "go", "rust"];

/** Storage tiers a module can be granted beyond the always-on `local`. */
export type GrantableStorage = "app" | "cloud";

const GRANTABLE_STORAGE: readonly GrantableStorage[] = ["app", "cloud"];

/** `wasm.modules.<Module>` in hypen.json: one module's capability grants. */
export interface WasmModuleCapabilities {
  /** Sibling modules whose state this module may read / subscribe to. */
  reads?: string[];
  /** Sibling modules this module may dispatch actions to. */
  dispatches?: string[];
  /** Storage tiers beyond `local` (always granted by the host). */
  storage?: GrantableStorage[];
  /** Outbound HTTP (`wasi:http`). */
  http?: boolean;
}

/** The validated `wasm` section of hypen.json. */
export interface WasmConfig {
  /** Explicit source language; skips detection from Cargo.toml / go.mod. */
  language?: Language;
  /** Per-module capability grants, keyed by module (component) name. */
  modules?: Record<string, WasmModuleCapabilities>;
}

/**
 * One `app.json` module entry as `hypen-runtime --app` parses it
 * (`ModuleEntry` in hypen-engine-rs/src/bin/hypen_runtime.rs). Stateful
 * entries always carry all four capability fields explicitly; stateless
 * (template-only) entries carry only `name` + `ui`.
 */
export interface AppManifestModule {
  name: string;
  wasm?: string;
  ui: string;
  /** Lowercased sibling scopes (the host keys modules by lowercased name). */
  reads?: string[];
  dispatches?: string[];
  storage?: GrantableStorage[];
  http?: boolean;
}

export interface AppManifest {
  entry: string;
  modules: AppManifestModule[];
}

export interface BuildWasmOptions {
  /** Path to components directory (e.g. `./src/components`), relative to `root`. */
  components: string;
  /** Entry component name (e.g. `App`). */
  entry: string;
  /** Output directory, relative to `root`. Artifacts land in `<outDir>/wasm/`. Default: `dist`. */
  outDir?: string;
  /** Keep the intermediate shim/bundle files for debugging. Default: false. */
  keepTemp?: boolean;
  /** Project root (where hypen.json / Cargo.toml / go.mod live). Default: `process.cwd()`. */
  root?: string;
  /**
   * The raw `wasm` section of hypen.json (validated here; see
   * `parseWasmConfig`). Holds the language override and capability grants.
   */
  wasm?: unknown;
}

/** A discovered component with a stateful module. */
interface ModuleComponent {
  name: string;
  /** Absolute path to the module's `.ts` source (TypeScript projects). */
  modulePath?: string;
  /** Absolute path to the component's Go package dir (Go projects). */
  dir?: string;
  /**
   * Go authoring mode:
   *  - `"app"`  → the package exports `func Module() *core.ModuleDefinition`
   *    (the high-level `core.NewApp().OnAction()` API); the CLI generates a
   *    WIT shim that adapts it — full parity with the TS path.
   *  - `"wit"`  → `package main` implements the `hypen:module` exports
   *    directly (advanced: the author owns the WIT exports); built as-is.
   */
  goMode?: "app" | "wit";
  /** Go package name (app-mode), for the generated shim's import. */
  goPkg?: string;
  /** The `.hypen` template source. */
  template: string;
  /** Action names the module handles (TS only; Go discovers at runtime). */
  actions: string[];
}

/**
 * Locate a WIT directory shipped with the CLI, identified by a marker file.
 * Resolves relative to this module so it works from both `src/` (repo) and
 * `dist/src/` (published bundle), where the WIT dirs are copied alongside.
 */
function resolveWit(dirName: string, marker: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", join("..", "..")]) {
    const candidate = resolve(here, up, dirName);
    if (existsSync(join(candidate, marker))) return candidate;
  }
  throw new Error(
    `Could not locate the bundled WIT directory (${dirName}/${marker}). ` +
      "The CLI install may be incomplete."
  );
}

/**
 * Detect the project's source language. An explicit `override` (hypen.json
 * `wasm.language`) wins; otherwise Rust projects have a `Cargo.toml`, Go
 * projects a `go.mod`, and anything else is TypeScript (the `hypen init`
 * default).
 */
export function detectLanguage(projectDir: string, override?: Language): Language {
  if (override) return override;
  if (existsSync(join(projectDir, "Cargo.toml"))) return "rust";
  if (existsSync(join(projectDir, "go.mod"))) return "go";
  return "ts";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate the `wasm` section of hypen.json. Shape errors (unknown keys,
 * wrong types, unknown storage tiers or languages) throw a `BuildError`
 * naming the offending path, e.g. `wasm.modules.Cart.reads`. Module *names*
 * are checked later, against the discovered modules
 * (`resolveModuleCapabilities`).
 */
export function parseWasmConfig(raw: unknown): WasmConfig {
  if (raw === undefined || raw === null) return {};
  const where = "hypen.json";
  if (!isPlainObject(raw)) {
    throw new BuildError(`${where}: "wasm" must be an object`);
  }
  const out: WasmConfig = {};
  for (const key of Object.keys(raw)) {
    if (key !== "language" && key !== "modules") {
      throw new BuildError(
        `${where}: unknown key "wasm.${key}" (expected "language" or "modules")`
      );
    }
  }
  if (raw.language !== undefined) {
    if (typeof raw.language !== "string" || !LANGUAGES.includes(raw.language as Language)) {
      throw new BuildError(
        `${where}: wasm.language must be one of ${LANGUAGES.map((l) => `"${l}"`).join(", ")} ` +
          `(got ${JSON.stringify(raw.language)})`
      );
    }
    out.language = raw.language as Language;
  }
  if (raw.modules !== undefined) {
    if (!isPlainObject(raw.modules)) {
      throw new BuildError(`${where}: wasm.modules must be an object keyed by module name`);
    }
    out.modules = {};
    for (const [name, caps] of Object.entries(raw.modules)) {
      const at = `wasm.modules.${name}`;
      if (!isPlainObject(caps)) {
        throw new BuildError(`${where}: ${at} must be an object`);
      }
      const parsed: WasmModuleCapabilities = {};
      for (const [key, value] of Object.entries(caps)) {
        if (key === "reads" || key === "dispatches") {
          if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
            throw new BuildError(`${where}: ${at}.${key} must be an array of module names (strings)`);
          }
          parsed[key] = value as string[];
        } else if (key === "storage") {
          if (!Array.isArray(value)) {
            throw new BuildError(
              `${where}: ${at}.storage must be an array of "app" / "cloud"`
            );
          }
          for (const tier of value) {
            if (!GRANTABLE_STORAGE.includes(tier)) {
              const hint = tier === "local" ? ` ("local" is always granted; omit it)` : "";
              throw new BuildError(
                `${where}: ${at}.storage has unknown tier ${JSON.stringify(tier)} ` +
                  `(expected "app" or "cloud")${hint}`
              );
            }
          }
          parsed.storage = [...new Set(value as GrantableStorage[])];
        } else if (key === "http") {
          if (typeof value !== "boolean") {
            throw new BuildError(`${where}: ${at}.http must be true or false`);
          }
          parsed.http = value;
        } else {
          throw new BuildError(
            `${where}: unknown key "${at}.${key}" ` +
              `(expected "reads", "dispatches", "storage" or "http")`
          );
        }
      }
      out.modules[name] = parsed;
    }
  }
  return out;
}

/** The explicit capability fields every stateful app.json entry carries. */
export type ResolvedCapabilities = Required<
  Pick<AppManifestModule, "reads" | "dispatches" | "storage" | "http">
>;

/**
 * Resolve each stateful module's capability grants against the discovered
 * modules. Every stateful module gets an explicit entry (defaults: no reads,
 * no dispatches, no storage beyond `local`, no HTTP). Unknown module names —
 * as a `wasm.modules` key or a `reads`/`dispatches` target — throw a
 * `BuildError` naming the offender. Targets match module names
 * case-insensitively and are emitted lowercased: the host keys module state
 * scopes by the lowercased name.
 */
export function resolveModuleCapabilities(
  config: WasmConfig,
  statefulNames: string[],
  statelessNames: string[] = []
): Map<string, ResolvedCapabilities> {
  const known = statefulNames.join(", ") || "none";
  const byLower = new Map(statefulNames.map((n) => [n.toLowerCase(), n]));
  const configured = config.modules ?? {};
  for (const name of Object.keys(configured)) {
    if (statefulNames.includes(name)) continue;
    const why = statelessNames.includes(name)
      ? `"${name}" is a stateless (template-only) component, which has no wasm to grant capabilities to`
      : byLower.has(name.toLowerCase())
        ? `no module named "${name}" (did you mean "${byLower.get(name.toLowerCase())}"?)`
        : `no module named "${name}"`;
    throw new BuildError(`hypen.json: wasm.modules.${name}: ${why}. Stateful modules: ${known}`);
  }

  const out = new Map<string, ResolvedCapabilities>();
  for (const name of statefulNames) {
    const caps = configured[name] ?? {};
    const targets = (key: "reads" | "dispatches"): string[] => {
      const scopes: string[] = [];
      for (const target of caps[key] ?? []) {
        if (!byLower.has(target.toLowerCase())) {
          throw new BuildError(
            `hypen.json: wasm.modules.${name}.${key} names unknown module "${target}". ` +
              `Stateful modules: ${known}`
          );
        }
        const scope = target.toLowerCase();
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      return scopes;
    };
    out.set(name, {
      reads: targets("reads"),
      dispatches: targets("dispatches"),
      storage: caps.storage ?? [],
      http: caps.http ?? false,
    });
  }
  return out;
}

/**
 * The generic shim source: adapts a `HypenModuleDefinition` (the default
 * export of a Hypen module file) to the `hypen:module` reducer ABI. Identical
 * for every TS module — only the import path to the user module differs.
 *
 * Reducer semantics mirror `@hypen-space/core`: action handlers mutate
 * `state` in place; we serialize the mutated object. Cross-module writes,
 * unsubscribe, router reads/history, data sources, and async handlers are not
 * yet bridged across the wasm boundary and fail loudly rather than silently
 * misbehaving. `router.push` / `replace` / `navigate` emit the WIT `navigate`
 * effect, which the host performs.
 */
export function shimSource(moduleImportPath: string): string {
  return `// AUTO-GENERATED by \`hypen build --target wasm\`. Do not edit.
import def from ${JSON.stringify(moduleImportPath)};
// Synchronous cross-module state capability (world: module-x). Provided by the
// host (native WasmtimeHost / hypen-runtime). Only \`read\` + \`subscribe\` are
// wired here — directed cross-module dispatch is async and stays unbridged.
// The specifier carries the WIT package version: componentize-js binds world
// imports under their fully versioned name, and an unversioned specifier fails
// at component initialization ("Error loading module").
import { read as stateRead, subscribe as stateSubscribe } from ${JSON.stringify(ENGINE_STATE_IMPORT)};

const enc = new TextEncoder();
const dec = new TextDecoder();
const encJson = (v) => enc.encode(JSON.stringify(v ?? null));
const decJson = (b) => (b && b.length ? JSON.parse(dec.decode(b)) : null);

// Snapshot a sibling module's current state via the engine's synchronous
// cross-module read. Requires the target in this module's manifest \`reads\`
// (the host throws otherwise). Valid only while a reducer/lifecycle call is on
// the stack — the host installs the sibling snapshots per-call.
function readSiblingState(id) {
  return decJson(stateRead(id));
}

// The tag of a hypen:engine/state \`error\` variant thrown by an import
// (componentize-js throws a ComponentError carrying the variant as \`payload\`).
function stateErrorTag(e) {
  const p = e && typeof e === "object" && "payload" in e ? e.payload : e;
  return p && typeof p === "object" ? p.tag : undefined;
}

// The router surface. Navigation maps to the WIT \`navigate\` effect (the host
// performs it after the reducer returns); everything that would need the
// host's live route state or history is not wired yet and fails loudly.
function routerFor(effectSink) {
  const navigate = (path) => {
    if (typeof path !== "string") throw new Error("router navigation needs a path string on the wasm target");
    effectSink.push({ tag: "navigate", val: path });
  };
  const wired = { push: navigate, replace: navigate, navigate };
  return new Proxy(wired, {
    get(t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in t) return t[prop];
      if (prop === "then") return undefined; // not a thenable
      throw new Error("context.router." + prop + " is not supported on the wasm target yet: only push/replace/navigate (the host's navigate effect) are wired");
    },
  });
}

// The wasm-target GlobalContext. Sync surfaces (read/emit/subscribe) are wired
// to the engine; async cross-module *writes* fail loudly. \`emitSink\` is the
// current reducer's ReducerOutput.emit accumulator, \`effectSink\` its effects.
function ctx(emitSink, effectSink) {
  const moduleRef = (id) => ({
    get state() { return readSiblingState(id); },
    getState: () => readSiblingState(id),
    setState() { throw new Error("context.getModule(...).setState is not supported on the wasm target yet (cross-module writes need directed dispatch)"); },
  });
  return {
    getModule: (id) => moduleRef(id),
    // Absent (not-found) is \`false\`; a sibling that exists but isn't granted
    // is an error, not an absence — the fix is a manifest grant.
    hasModule: (id) => {
      try { stateRead(id); return true; } catch (e) {
        const tag = stateErrorTag(e);
        if (tag === "not-found") return false;
        if (tag === "permission-denied") {
          throw new Error('context.hasModule("' + id + '"): permission denied (the host only reports on modules listed in the reads grant) — add it to wasm.modules.<ThisModule>.reads in hypen.json');
        }
        throw e;
      }
    },
    getModuleIds: () => [],            // siblings can't be enumerated across the wasm boundary
    // Lazy global view: \`globalState[moduleId]\` reads that sibling on access.
    getGlobalState: () => new Proxy({}, { get: (_t, id) => (typeof id === "string" ? readSiblingState(id) : undefined) }),
    // Enqueue a follow-up action on this module; the engine dispatches it after
    // the current reducer returns (ReducerOutput.emit).
    emit: (name, payload) => { emitSink.push({ name, payload: encJson(payload) }); },
    // Observe a sibling: re-dispatch \`onChange\` (an action name) whenever
    // \`module\`'s state changes at dotted \`path\`. Registered when the reducer
    // returns; maps 1:1 to hypen:engine/state.subscribe. The WIT has no
    // unsubscribe (subscriptions end when the module is torn down), so the
    // returned function fails loudly instead of pretending to unsubscribe.
    on: (module, path, onChange) => {
      stateSubscribe(module, path ?? "", onChange);
      return () => { throw new Error("unsubscribing from context.on(...) is not supported on the wasm target (subscriptions last until the module is torn down)"); };
    },
    router: routerFor(effectSink),
  };
}

function assertSync(ret, what) {
  if (ret && typeof ret.then === "function") {
    // Swallow the eventual rejection; the error below is the one to surface.
    if (typeof ret.catch === "function") ret.catch(() => {});
    throw new Error("async handlers are not supported on the wasm target yet (" + what + " returned a Promise)");
  }
}
const dataSources = new Proxy({}, {
  get() { throw new Error("data sources are not supported on the wasm target yet"); },
});

// componentize-js turns a thrown *string* into the export's \`err(string)\`,
// but re-throws an Error instance — a trap that kills the instance and loses
// the message. Every result-returning export goes through \`guard\` so the
// loud failures above reach the host as readable module errors.
function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      if (e && typeof e === "object" && Object.prototype.hasOwnProperty.call(e, "payload")) {
        throw "host capability error: " + JSON.stringify(e.payload);
      }
      throw e instanceof Error ? (e.message || String(e)) : typeof e === "string" ? e : JSON.stringify(e);
    }
  };
}

export const init = guard(function init(config) {
  // Declaration-site config (\`module X(start: 5)\` → {"start":5}) shallow-merges
  // over the static initialState. No config (empty / non-object) leaves the
  // initialState untouched.
  const seed = decJson(config);
  if (!seed || typeof seed !== "object" || Array.isArray(seed) || Object.keys(seed).length === 0) {
    return encJson(def.initialState);
  }
  return encJson({ ...(def.initialState ?? {}), ...seed });
});

export const dispatch = guard(function dispatch(stateBytes, action) {
  const state = decJson(stateBytes) ?? {};
  const handler = def.handlers.onAction.get(action.name);
  if (!handler) throw new Error("unknown action: " + action.name);
  const payload = decJson(action.payload);
  const emit = [];
  const effects = [];
  const ret = handler({ action: { name: action.name, payload, sender: undefined }, state, context: ctx(emit, effects), dataSources });
  assertSync(ret, 'action handler "' + action.name + '"');
  return { state: encJson(state), effects, emit };
});

function lifecycle(fn, name) {
  return guard((stateBytes) => {
    if (!fn) return { state: undefined, effects: [], emit: [] };
    const state = decJson(stateBytes) ?? {};
    const emit = [];
    const effects = [];
    const ret = fn(state, ctx(emit, effects));
    assertSync(ret, name);
    return { state: encJson(state), effects, emit };
  });
}
export const onActivated = lifecycle(def.handlers.onActivated, "onActivated");
export const onDeactivated = lifecycle(def.handlers.onDeactivated, "onDeactivated");
export const onDestroyed = guard(function onDestroyed(stateBytes) {
  // onDestroyed returns result<_,string> (no ReducerOutput), so any emit()/on()
  // /navigation here is dropped — matches the native host, which discards them.
  if (def.handlers.onDestroyed) {
    assertSync(def.handlers.onDestroyed(decJson(stateBytes) ?? {}, ctx([], [])), "onDestroyed");
  }
});

export function actions() {
  return def.actions;
}
`;
}

/** Node built-ins the TS bundle stubs out (the WASI target has none of them). */
const STUBBED_BUILTINS = [
  "fs",
  "fs/promises",
  "path",
  "os",
  "url",
  "crypto",
  "child_process",
  "module",
  "worker_threads",
  "net",
  "tls",
  "http",
  "https",
  "stream",
  "zlib",
] as const;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The named exports a stub for `mod` provides: the real built-in's export
 * names, read from the runtime running the CLI (so `import { join } from
 * "path"` binds instead of failing to bundle or silently becoming
 * `undefined`). Falls back to none if the runtime can't load it.
 */
function builtinExportNames(mod: string): string[] {
  try {
    const real = createRequire(import.meta.url)(`node:${mod}`);
    return Object.keys(real).filter((k) => k !== "default" && IDENTIFIER.test(k));
  } catch {
    return [];
  }
}

/**
 * Source of the ESM stub for Node built-in `mod`. Every export (the default
 * and each named export) is a Proxy that throws `node:<mod> is not available
 * in the wasm target` as soon as it's *used* — called, constructed, its
 * properties read, or coerced to a primitive. Merely importing (or having the
 * import in a lazy code path that never runs) stays harmless, which is what
 * lets `@hypen-space/core`'s file-loading paths bundle for WASI.
 */
export function nodeStubSource(mod: string, names: string[] = builtinExportNames(mod)): string {
  const spec = JSON.stringify(`node:${mod}`);
  const lines = [
    `// AUTO-GENERATED stub for ${spec} (hypen build --target wasm).`,
    `const fail = (what) => { throw new Error(${spec} + " is not available in the wasm target" + (what ? " (used: " + what + ")" : "")); };`,
    `const stub = (name) => new Proxy(function () {}, {`,
    `  get(_t, prop) {`,
    `    if (prop === Symbol.toPrimitive) return () => fail(name);`,
    `    if (typeof prop === "symbol" || prop === "then" || prop === "__esModule") return undefined;`,
    `    fail(name ? name + "." + prop : prop);`,
    `  },`,
    `  apply() { fail(name); },`,
    `  construct() { fail(name); },`,
    `  set() { fail(name); },`,
    `  has() { fail(name); },`,
    `});`,
    `export default stub("");`,
  ];
  const unique = [...new Set(names)].filter((n) => n !== "default" && IDENTIFIER.test(n));
  unique.forEach((n, i) => lines.push(`const __s${i} = stub(${JSON.stringify(n)});`));
  if (unique.length > 0) {
    lines.push(`export { ${unique.map((n, i) => `__s${i} as ${n}`).join(", ")} };`);
  }
  return lines.join("\n") + "\n";
}

/**
 * esbuild plugin stubbing node built-ins. A Hypen reducer never touches the
 * filesystem; these references live in lazy core code paths (`.uiFile()`,
 * the component resolver) that don't execute inside a module. Stubbing lets
 * the bundle target WASI instead of Node, and the throwing stubs
 * (`nodeStubSource`) make any *use* of one fail loudly at runtime.
 */
export function nodeStubPlugin() {
  const escaped = STUBBED_BUILTINS.map((m) => m.replace("/", "\\/")).join("|");
  return {
    name: "hypen-stub-node-builtins",
    setup(build: any) {
      const builtins = new RegExp(`^(node:)?(${escaped})$`);
      build.onResolve({ filter: builtins }, (args: any) => ({
        path: args.path.replace(/^node:/, ""),
        namespace: "hypen-node-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "hypen-node-stub" }, (args: any) => ({
        contents: nodeStubSource(args.path),
        loader: "js",
      }));
    },
  };
}

/** Run a child process to completion, streaming stdio. Rejects on non-zero. */
function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", (e) => reject(new BuildError(`failed to run ${cmd}: ${e.message}`)));
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new BuildError(`${cmd} exited with code ${code ?? "null"}`))
    );
  });
}

/**
 * Run a child process capturing stdout (stderr streams through). Rejects with
 * a `BuildError` on non-zero exit.
 */
function runCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (out += d));
    child.on("error", (e) => reject(new BuildError(`failed to run ${cmd}: ${e.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new BuildError(`${cmd} exited with code ${code ?? "null"}`))
    );
  });
}

/** Version of `@bytecodealliance/jco` the TS pipeline is tested against. */
export const JCO_VERSION = "1.42.0";

/**
 * Locate the `@bytecodealliance/jco` package visible from `fromDir`: the
 * first `node_modules/@bytecodealliance/jco` walking up (node's lookup, done
 * by hand — the package doesn't export `./package.json`, and runtime
 * resolvers may fall back to global caches), or null.
 */
function jcoPackageRoot(fromDir: string): string | null {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...JCO_PACKAGE.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Resolve how to invoke `jco`. Returns the command + leading args.
 *
 *  1. The project's own `node_modules/.bin/jco` — an explicit override, so a
 *     project can pin a different jco.
 *  2. The CLI's own `@bytecodealliance/jco` (an optional peer dependency
 *     pinned to `JCO_VERSION`), run with the runtime executing the CLI.
 *
 * There is deliberately no `bunx`/`npx` fallback: that fetched an unpinned
 * jco (~350 MB with its toolchain) on every machine. Missing jco is a
 * `BuildError` with install instructions.
 */
export function resolveJco(
  projectDir: string,
  cliDir: string = dirname(fileURLToPath(import.meta.url))
): { cmd: string; pre: string[] } {
  const local = join(projectDir, "node_modules", ".bin", "jco");
  if (existsSync(local)) return { cmd: local, pre: [] };
  const root = jcoPackageRoot(cliDir);
  if (root) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.jco;
    if (bin) return { cmd: process.execPath, pre: [join(root, bin)] };
  }
  throw new BuildError(
    `The TypeScript wasm target needs ${JCO_PACKAGE}, which is not installed. ` +
      `Install it in the project: bun add -d ${JCO_PACKAGE}@${JCO_VERSION} ` +
      `(or npm install -D ${JCO_PACKAGE}@${JCO_VERSION}).`
  );
}

/**
 * Import specifier of the cross-module state capability the TS shim uses. The
 * version must match `package hypen:engine@…` in `wit/deps/hypen-engine/state.wit`
 * (asserted by tests/build-wasm.test.ts).
 */
const ENGINE_STATE_IMPORT = "hypen:engine/state@0.1.0";

/** The npm package that provides the `jco` binary. */
const JCO_PACKAGE = "@bytecodealliance/jco";

/**
 * Build one TS module into a `.wasm` component: codegen shim → esbuild bundle
 * → jco componentize.
 */
/** Name of the per-module world `tsBuildWorld` generates. */
export const TS_BUILD_WORLD = "hypen-cli-build";

/**
 * The world a TS module is componentized against: `module` (all reducer
 * exports) plus the `hypen:engine/state` import, but with only the storage
 * imports the module is granted.
 *
 * componentize-js keeps *every* import of the target world in the component,
 * used or not, and the host links `hypen:storage/app` / `cloud` only for
 * modules granted them (an ungranted import fails instantiation). Building
 * against `module-x` verbatim would therefore make every TS module need
 * `"storage": ["app", "cloud"]`. `module`'s body is copied from the vendored
 * WIT (so exports stay in lockstep), minus the ungranted storage imports.
 */
export function tsBuildWorld(moduleWit: string, storage: GrantableStorage[]): string {
  const start = moduleWit.search(/^world module \{/m);
  if (start < 0) throw new BuildError("bundled WIT has no `world module` (CLI install broken?)");
  let depth = 0;
  let end = -1;
  for (let i = start; i < moduleWit.length; i++) {
    if (moduleWit[i] === "{") depth++;
    else if (moduleWit[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new BuildError("bundled WIT `world module` is unterminated (CLI install broken?)");
  const body = moduleWit
    .slice(moduleWit.indexOf("{", start) + 1, end)
    .split("\n")
    .filter((line) => {
      const m = line.match(/^\s*import\s+hypen:storage\/(app|cloud)@/);
      return !m || storage.includes(m[1] as GrantableStorage);
    })
    .join("\n");
  return (
    `\n// Generated by \`hypen build --target wasm\`: \`module\` with only this\n` +
    `// module's granted storage imports, plus hypen:engine/state.\n` +
    `world ${TS_BUILD_WORLD} {${body}    import ${ENGINE_STATE_IMPORT};\n}\n`
  );
}

/**
 * Copy the vendored WIT into `<tempDir>/wit-<Name>` with the module's
 * `tsBuildWorld` appended, for `jco componentize --world-name`.
 */
function prepareTsWit(witDir: string, tempDir: string, name: string, storage: GrantableStorage[]): string {
  const dest = join(tempDir, `wit-${name}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(witDir, dest, { recursive: true });
  const file = join(dest, "hypen-module.wit");
  const src = readFileSync(file, "utf8");
  writeFileSync(file, src + tsBuildWorld(src, storage));
  return dest;
}

async function buildTsModule(
  comp: ModuleComponent,
  opts: {
    projectDir: string;
    tempDir: string;
    outWasmDir: string;
    witDir: string;
    keepTemp: boolean;
    storage: GrantableStorage[];
  }
): Promise<string> {
  const esbuild = await import("esbuild");

  const shimPath = join(opts.tempDir, `shim-${comp.name}.mjs`);
  const bundlePath = join(opts.tempDir, `bundle-${comp.name}.mjs`);
  const wasmPath = join(opts.outWasmDir, `${comp.name}.wasm`);
  if (!comp.modulePath) throw new Error(`TS component ${comp.name} has no module path`);

  // 1. Codegen the WIT shim importing the user module by absolute path.
  writeFileSync(shimPath, shimSource(comp.modulePath));

  // 2. Bundle shim + user module + @hypen-space/core into one ESM file.
  //    `conditions: ["bun", ...]` resolves the source entry of workspace
  //    packages; node built-ins are stubbed for the WASI target.
  await esbuild.build({
    entryPoints: [shimPath],
    bundle: true,
    outfile: bundlePath,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["bun", "import", "default"],
    // The shim statically imports the host capability `hypen:engine/state`
    // (world: module-x). It's a WIT import satisfied by jco componentize at
    // instantiation, not a resolvable module — keep it out of the bundle.
    external: [ENGINE_STATE_IMPORT],
    plugins: [nodeStubPlugin()],
    logLevel: "warning",
    absWorkingDir: opts.projectDir,
  });

  // 3. Componentize against the module's narrowed world (`tsBuildWorld`).
  //    `--disable http fetch-event` keeps every wasi:http import out of the
  //    component (with only `http` disabled, StarlingMonkey's fetch-event
  //    support still imports wasi:http/types, which the host doesn't link
  //    without an `http` grant); clocks/random stay (Date / Math.random).
  const { cmd, pre } = resolveJco(opts.projectDir);
  const witDir = prepareTsWit(opts.witDir, opts.tempDir, comp.name, opts.storage);
  await run(
    cmd,
    [
      ...pre,
      "componentize",
      bundlePath,
      "--wit",
      witDir,
      "--world-name",
      TS_BUILD_WORLD,
      "-o",
      wasmPath,
      "--disable",
      "http",
      "fetch-event",
    ],
    opts.projectDir
  );
  // Don't trust the exit code alone: a mis-resolved `jco` can exit 0 without
  // writing anything, and the manifest would then reference a missing file.
  if (!existsSync(wasmPath)) {
    throw new BuildError(
      `jco componentize reported success but did not write ${wasmPath}. ` +
        `Install ${JCO_PACKAGE} in the project (bun add -d ${JCO_PACKAGE}@${JCO_VERSION}) and retry.`
    );
  }

  if (!opts.keepTemp) {
    rmSync(shimPath, { force: true });
    rmSync(bundlePath, { force: true });
  }
  return wasmPath;
}

/**
 * Discover Go components by scanning the components directory. A subdirectory
 * is a **stateful** Go component if it contains `.go` source (a package
 * implementing the `hypen:module` world); a `.hypen`-only subdirectory is a
 * **stateless** component. The `.hypen` is `component.hypen` or `<Name>.hypen`.
 */
export function collectGoComponents(componentsDir: string): {
  modules: ModuleComponent[];
  stateless: Array<{ name: string; template: string }>;
} {
  const modules: ModuleComponent[] = [];
  const stateless: Array<{ name: string; template: string }> = [];
  if (!existsSync(componentsDir)) return { modules, stateless };

  for (const name of readdirSync(componentsDir)) {
    const dir = join(componentsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);

    const hypenFile = files.find((f) => f === "component.hypen" || f === `${name}.hypen`);
    if (!hypenFile) continue;
    const template = readFileSync(join(dir, hypenFile), "utf8").trim();

    const goFiles = files.filter((f) => f.endsWith(".go"));
    if (goFiles.length > 0) {
      // Mode: `package main` → wit-authored (built as-is); any other package
      // → app-mode (exports `Module() *core.ModuleDefinition`; CLI shims it).
      let goMode: "app" | "wit" = "app";
      let goPkg = name.toLowerCase();
      for (const f of goFiles) {
        const pkg = readGoPackage(join(dir, f));
        if (pkg === "main") {
          goMode = "wit";
          break;
        }
        if (pkg) goPkg = pkg;
      }
      modules.push({ name, dir, template, actions: [], goMode, goPkg });
    } else {
      stateless.push({ name, template });
    }
  }
  return { modules, stateless };
}

/** Read the `package <name>` declaration from a Go file (first non-comment). */
function readGoPackage(file: string): string | null {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    const m = t.match(/^package\s+(\w+)/);
    return m ? m[1] : null;
  }
  return null;
}

/** Read the module path from a project's `go.mod` (`module <path>`). */
function goModulePath(projectDir: string): string {
  const modFile = join(projectDir, "go.mod");
  if (existsSync(modFile)) {
    for (const line of readFileSync(modFile, "utf8").split("\n")) {
      const m = line.trim().match(/^module\s+(\S+)/);
      if (m) return m[1];
    }
  }
  throw new Error(`Could not read 'module' path from ${modFile}`);
}

/**
 * The Go shim source: adapts a `*core.ModuleDefinition` (from
 * `core.NewApp().OnAction().Build()`) to the `hypen:module` reducer ABI.
 * Generic across modules — only the user package import differs. Action
 * handlers run against an `ObservableState` reconstructed from the incoming
 * JSON; the resulting snapshot is serialized back, mirroring the engine-backed
 * path so behavior is identical to a normal (RemoteServer) Go module.
 */
export function goShimSource(userImport: string, bindingsBase: string): string {
  return `// AUTO-GENERATED by \`hypen build --target wasm\`. Do not edit.
package main

import (
\t"encoding/json"

\t"go.bytecodealliance.org/cm"

\tcore "github.com/hypen-lang/hypen/hypen-golang"
\tusermod ${JSON.stringify(userImport)}
\tmodule ${JSON.stringify(bindingsBase + "/module")}
\ttypes ${JSON.stringify(bindingsBase + "/types")}
)

var def = usermod.Module()

type stubCtx struct{}

func (stubCtx) GetModule(id string) *core.ModuleReference   { return nil }
func (stubCtx) HasModule(id string) bool                    { return false }
func (stubCtx) GetModuleIds() []string                      { return nil }
func (stubCtx) GetGlobalState() map[string]any              { return map[string]any{} }
func (stubCtx) Emit(event string, payload any)              {}
func (stubCtx) On(event string, h core.EventHandler) func() { return func() {} }
func (stubCtx) GetRouter() *core.HypenRouter                { return nil }

func encodeJSON(v any) module.JSON { b, _ := json.Marshal(v); return types.JSON(cm.ToList(b)) }
func decodeMap(j module.JSON) map[string]any {
\tb := j.Slice()
\tm := map[string]any{}
\tif len(b) > 0 {
\t\t_ = json.Unmarshal(b, &m)
\t}
\treturn m
}

func okOut(s module.JSON) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\tout := module.ReducerOutput{State: cm.Some(s), Effects: cm.NewList[types.Effect](nil, 0), Emit: cm.NewList[module.Action](nil, 0)}
\tvar r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
\tr.SetOK(out)
\treturn r
}
func noopOut() cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\tout := module.ReducerOutput{State: cm.None[module.JSON](), Effects: cm.NewList[types.Effect](nil, 0), Emit: cm.NewList[module.Action](nil, 0)}
\tvar r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
\tr.SetOK(out)
\treturn r
}
func errOut(msg string) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\tvar r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
\tr.SetErr(msg)
\treturn r
}

func runLifecycle(state module.JSON, fn core.LifecycleHandler) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\tif fn == nil {
\t\treturn noopOut()
\t}
\tobs := core.NewObservableState(decodeMap(state), nil)
\tfn(obs, stubCtx{})
\treturn okOut(encodeJSON(obs.Snapshot()))
}

func init() {
\tmodule.Exports.Init = func(config module.JSON) cm.Result[module.JSON, module.JSON, string] {
\t\tvar r cm.Result[module.JSON, module.JSON, string]
\t\t// Declaration-site config (\`module X(start: 5)\` -> {"start":5})
\t\t// shallow-merges over the static InitialState. No config leaves it
\t\t// untouched. Merge at the JSON layer so InitialState's Go type (struct
\t\t// or map) doesn't matter.
\t\tseed := decodeMap(config)
\t\tif len(seed) == 0 {
\t\t\tr.SetOK(encodeJSON(def.InitialState))
\t\t\treturn r
\t\t}
\t\tbase := map[string]any{}
\t\tif b, err := json.Marshal(def.InitialState); err == nil {
\t\t\t_ = json.Unmarshal(b, &base)
\t\t}
\t\tfor k, v := range seed {
\t\t\tbase[k] = v
\t\t}
\t\tr.SetOK(encodeJSON(base))
\t\treturn r
\t}
\tmodule.Exports.Dispatch = func(state module.JSON, action module.Action) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\t\th, ok := def.Handlers.OnAction[action.Name]
\t\tif !ok {
\t\t\treturn errOut("unknown action: " + action.Name)
\t\t}
\t\tvar payload any
\t\tif p := action.Payload.Slice(); len(p) > 0 {
\t\t\t_ = json.Unmarshal(p, &payload)
\t\t}
\t\tobs := core.NewObservableState(decodeMap(state), nil)
\t\th(core.ActionHandlerContext{Action: core.ActionContext{Name: action.Name, Payload: payload}, State: obs, Context: stubCtx{}})
\t\treturn okOut(encodeJSON(obs.Snapshot()))
\t}
\tmodule.Exports.OnActivated = func(s module.JSON) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\t\treturn runLifecycle(s, def.Handlers.OnActivated)
\t}
\tmodule.Exports.OnDeactivated = func(s module.JSON) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
\t\treturn runLifecycle(s, def.Handlers.OnDeactivated)
\t}
\tmodule.Exports.OnDestroyed = func(s module.JSON) cm.Result[string, struct{}, string] {
\t\tif def.Handlers.OnDestroyed != nil {
\t\t\tdef.Handlers.OnDestroyed(core.NewObservableState(decodeMap(s), nil), stubCtx{})
\t\t}
\t\tvar r cm.Result[string, struct{}, string]
\t\tr.SetOK(struct{}{})
\t\treturn r
\t}
\tmodule.Exports.Actions = func() cm.List[string] { return cm.ToList(def.Actions) }
}

func main() {}
`;
}

/**
 * Ensure a Go-toolchain binary is on PATH, failing with install guidance.
 * Resolves via `<cmd> <probe>`; rejects with a helpful message on ENOENT.
 */
async function ensureBin(cmd: string, probe: string[], hint: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, probe, { stdio: "ignore" });
    child.on("error", () =>
      reject(new Error(`'${cmd}' not found on PATH. ${hint}`))
    );
    // Any exit (even non-zero usage) means the binary exists.
    child.on("exit", () => resolvePromise());
  });
}

/**
 * Generate the `hypen:module` Go bindings into the project's
 * `internal/bindings/` (once per build). The Go components import these as
 * `<go-module-path>/internal/bindings/hypen/module/module`.
 */
async function generateGoBindings(projectDir: string, witDir: string): Promise<void> {
  await ensureBin(
    "wit-bindgen-go",
    ["--help"],
    "Install it: go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest"
  );
  await run(
    "wit-bindgen-go",
    ["generate", "--world", "module", "--out", join(projectDir, "internal", "bindings"), witDir],
    projectDir
  );
}

/**
 * Build one Go component to a `.wasm` Component with TinyGo.
 *
 * - **app-mode**: generate a WIT shim (`<tempDir>/<Name>/main.go`) that imports
 *   the user's package and adapts its `Module()` definition to the reducer ABI,
 *   then build that package. The shim lives inside the Go module so its imports
 *   (`<gomod>/...`) resolve.
 * - **wit-mode**: the component package implements the exports directly; build
 *   it as-is.
 *
 * The `tinygo-module` world covers the wasi:* imports TinyGo's runtime brings
 * in; the component still satisfies the plain `hypen:module` contract.
 */
async function buildGoModule(
  comp: ModuleComponent,
  opts: { projectDir: string; tempDir: string; outWasmDir: string; witDir: string }
): Promise<string> {
  if (!comp.dir) throw new Error(`Go component ${comp.name} has no package dir`);
  const wasmPath = join(opts.outWasmDir, `${comp.name}.wasm`);
  await run(
    "tinygo",
    [
      "build",
      "-target=wasip2",
      "-wit-package",
      opts.witDir,
      "-wit-world",
      "tinygo-module",
      "-o",
      wasmPath,
      goBuildTarget(comp, opts.tempDir),
    ],
    opts.projectDir
  );
  return wasmPath;
}

/** What tinygo compiles: the generated shim dir (app-mode) or the package as-is (wit-mode). */
function goBuildTarget(comp: ModuleComponent, tempDir: string): string {
  return comp.goMode === "wit" ? comp.dir! : join(tempDir, comp.name);
}

/**
 * Write the generated WIT shim for an app-mode Go component into the temp build
 * dir (inside the Go module, so `<gomod>/...` imports resolve).
 */
function writeGoShim(
  comp: ModuleComponent,
  opts: { projectDir: string; tempDir: string; goModule: string; bindingsBase: string }
): void {
  const userImport = `${opts.goModule}/${relGoImport(opts.projectDir, comp.dir!)}`;
  const shimDir = join(opts.tempDir, comp.name);
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "main.go"), goShimSource(userImport, opts.bindingsBase));
}

/** Relative Go import segment (forward slashes) from project root to a dir. */
function relGoImport(projectDir: string, dir: string): string {
  return resolve(dir).slice(resolve(projectDir).length + 1).split("\\").join("/");
}

// ── Rust (cargo + wit-bindgen) ───────────────────────────────────────────────

/**
 * Collect components for a Rust project. Two layouts, auto-detected:
 *
 *  - **multi-module** — any `src/components/<Name>/` that has its own
 *    `Cargo.toml` is a stateful module crate (built to `<Name>.wasm`). A dir
 *    with only a `.hypen` is a stateless building block. Multiple stateful
 *    modules are supported (a crate per module, typically a Cargo workspace).
 *  - **single-crate (legacy)** — no component dir carries a `Cargo.toml`, so the
 *    project's root `Cargo.toml` is the one stateful module, named by `entry`;
 *    every other `.hypen` dir is stateless.
 *
 * Rust's idiomatic wasm path is authoring each module directly against the WIT
 * (`wit_bindgen::generate!` + `impl Guest`); the CLI builds the crate(s) and
 * pairs them with the declarative UI. (The high-level `hypen-server` authoring
 * API is server-oriented and its engine dependency isn't wasip2-buildable, so
 * there's no app-mode shim for Rust — see AUTHORING_MODEL.md.)
 */
export function collectRustComponents(
  componentsDir: string,
  entry: string,
  projectDir: string
): {
  modules: ModuleComponent[];
  stateless: Array<{ name: string; template: string }>;
} {
  const modules: ModuleComponent[] = [];
  const stateless: Array<{ name: string; template: string }> = [];
  if (!existsSync(componentsDir)) return { modules, stateless };

  const seen: Array<{ name: string; template: string; crate: boolean }> = [];
  let anyCrate = false;
  for (const name of readdirSync(componentsDir)) {
    const dir = join(componentsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);
    const hypenFile = files.find((f) => f === "component.hypen" || f === `${name}.hypen`);
    if (!hypenFile) continue;
    const template = readFileSync(join(dir, hypenFile), "utf8").trim();
    const crate = files.includes("Cargo.toml");
    if (crate) anyCrate = true;
    seen.push({ name, template, crate });
  }

  for (const c of seen) {
    if (anyCrate) {
      // Multi-module: crate dirs are stateful; `.hypen`-only dirs are stateless.
      if (c.crate) {
        modules.push({ name: c.name, template: c.template, actions: [], dir: join(componentsDir, c.name) });
      } else {
        stateless.push({ name: c.name, template: c.template });
      }
    } else if (c.name === entry) {
      // Legacy single-crate: the root Cargo.toml is the entry module.
      modules.push({ name: c.name, template: c.template, actions: [], dir: projectDir });
    } else {
      stateless.push({ name: c.name, template: c.template });
    }
  }
  return { modules, stateless };
}

/** Marker the CLI drops into a `wit/` it provisioned (vs. one the author vendored). */
export const PROVISIONED_MARKER = ".hypen-provisioned";

/** Relative paths of every file under `dir`, sorted (marker excluded). */
function listTree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!prefix && name === PROVISIONED_MARKER) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listTree(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** True when the two directory trees hold the same files with the same bytes. */
export function sameTree(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  const fa = listTree(a);
  const fb = listTree(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
  return fa.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

/** The CLI's bundled WIT dir for a `hypen:module` ABI. */
function witDirForAbi(abi: "0.1" | "0.2"): string {
  return abi === "0.2"
    ? resolveWit("wit-v0_2", "hypen-module.wit")
    : resolveWit("wit", "hypen-module.wit");
}

/**
 * Whether a crate's `wit/` was provisioned by the CLI (and so may be
 * refreshed) rather than vendored by the author: it carries the
 * provisioning marker, or — for crates provisioned before the marker
 * existed — it is byte-identical to one of the CLI's bundled WIT trees.
 */
function isCliProvisionedWit(witDest: string, bundled: string[] = []): boolean {
  if (existsSync(join(witDest, PROVISIONED_MARKER))) return true;
  return bundled.some((dir) => sameTree(witDest, dir));
}

/** Explicit `[package.metadata.hypen] abi = "..."` from `Cargo.toml`, if any. */
function cargoMetadataAbi(crateDir: string): "0.1" | "0.2" | null {
  const cargoToml = join(crateDir, "Cargo.toml");
  if (!existsSync(cargoToml)) return null;
  const toml = readFileSync(cargoToml, "utf8");
  const metaIdx = toml.indexOf("[package.metadata.hypen]");
  if (metaIdx < 0) return null;
  const nextSection = toml.indexOf("\n[", metaIdx + 1);
  const scope = toml.slice(metaIdx, nextSection === -1 ? undefined : nextSection);
  const m = scope.match(/^\s*abi\s*=\s*"([^"]+)"/m);
  if (!m) return null;
  if (m[1] === "0.1" || m[1].startsWith("0.1.")) return "0.1";
  if (m[1] === "0.2" || m[1].startsWith("0.2.")) return "0.2";
  throw new BuildError(
    `${cargoToml}: [package.metadata.hypen] abi = "${m[1]}" is not a known hypen:module ABI (expected "0.1" or "0.2")`
  );
}

/**
 * Which `hypen:module` ABI a Rust crate targets.
 *
 * - `"0.2"` — the CM-async world (WASI 0.3): `async fn` reducer exports that
 *   `await` capability imports inline. Requires a CM-async host
 *   (`WasmtimeHostAsync`; `hypen-runtime` auto-detects it).
 * - `"0.1"` — the default sync reducer + effect-descriptor world.
 *
 * Detection, in priority order:
 *  1. An explicit `[package.metadata.hypen] abi = "0.1" | "0.2"` in
 *     `Cargo.toml` — always wins, so switching the ABI there takes effect
 *     even over a previously provisioned `wit/`.
 *  2. A crate `wit/hypen-module.wit` declaring `hypen:module@0.2`, unless
 *     that `wit/` carries the CLI's provisioning marker (a provisioned copy
 *     reflects an earlier build's choice, not the author's intent).
 *  3. `"0.1"`.
 */
export function rustCrateAbi(crateDir: string): "0.1" | "0.2" {
  const explicit = cargoMetadataAbi(crateDir);
  if (explicit) return explicit;
  const witDest = join(crateDir, "wit");
  const vendored = join(witDest, "hypen-module.wit");
  if (
    existsSync(vendored) &&
    !existsSync(join(witDest, PROVISIONED_MARKER)) &&
    readFileSync(vendored, "utf8").includes("hypen:module@0.2")
  ) {
    return "0.2";
  }
  return "0.1";
}

/**
 * Provision the CLI's WIT for `abi` into `<crate>/wit` so the conventional
 * `wit_bindgen::generate!({ world: "module", path: "wit" })` resolves.
 *
 *  - absent → copy it (and drop the provisioning marker);
 *  - CLI-provisioned (marker, or identical to a bundled tree) but different
 *    from the WIT for `abi` → replace it, so an ABI switch or a CLI upgrade
 *    never builds against stale WIT;
 *  - author-vendored → left untouched, but a vendored WIT whose
 *    `hypen:module` version contradicts `abi` is a `BuildError` (it would
 *    otherwise silently build the wrong ABI).
 *
 * Returns what it did, for logging/tests.
 */
export function provisionRustWit(
  crateDir: string,
  abi: "0.1" | "0.2",
  bundled: { "0.1": string; "0.2": string } = { "0.1": witDirForAbi("0.1"), "0.2": witDirForAbi("0.2") }
): "provisioned" | "refreshed" | "unchanged" | "vendored" {
  const src = bundled[abi];
  const dest = join(crateDir, "wit");
  const mark = () =>
    writeFileSync(
      join(dest, PROVISIONED_MARKER),
      "Provisioned by `hypen build --target wasm`; refreshed whenever the CLI's WIT changes.\n" +
        "Delete this file to take ownership of wit/ (the CLI will then leave it alone).\n"
    );
  if (!existsSync(dest)) {
    cpSync(src, dest, { recursive: true });
    mark();
    return "provisioned";
  }
  if (isCliProvisionedWit(dest, [bundled["0.1"], bundled["0.2"]])) {
    if (sameTree(dest, src)) {
      if (!existsSync(join(dest, PROVISIONED_MARKER))) mark();
      return "unchanged";
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    mark();
    return "refreshed";
  }
  const vendored = join(dest, "hypen-module.wit");
  if (existsSync(vendored)) {
    const m = readFileSync(vendored, "utf8").match(/hypen:module@(\d+\.\d+)/);
    if (m && m[1] !== abi) {
      throw new BuildError(
        `${vendored} declares hypen:module@${m[1]} but the crate targets ABI ${abi} ` +
          `(Cargo.toml [package.metadata.hypen] abi). Update the vendored WIT, or delete ` +
          `${dest} to let the CLI provision it.`
      );
    }
  }
  return "vendored";
}

/**
 * Pick the crate's cdylib `.wasm` from `cargo build --message-format=json`
 * output: the `compiler-artifact` message whose `manifest_path` is the
 * crate's own `Cargo.toml` and whose target is a `cdylib`. Using cargo's own
 * report (rather than guessing `target/<triple>/release/<name>.wasm`) honors
 * `[lib] name`, `CARGO_TARGET_DIR`, and workspace target dirs, and can't pick
 * up a stale artifact from an earlier build.
 */
export function cdylibWasmFromCargoMessages(stdout: string, manifestPath: string): string | null {
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const want = canon(manifestPath);
  let found: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if (msg?.reason !== "compiler-artifact") continue;
    if (typeof msg.manifest_path !== "string" || canon(msg.manifest_path) !== want) continue;
    const kinds: string[] = msg.target?.kind ?? [];
    if (!kinds.includes("cdylib")) continue;
    const wasm = (msg.filenames ?? []).find((f: string) => f.endsWith(".wasm"));
    if (wasm) found = wasm;
  }
  return found;
}

/**
 * Build the Rust crate to a `wasm32-wasip2` component and copy it to
 * `dist/wasm/<entry>.wasm`. Rust ≥1.82's wasip2 target emits a Component
 * directly, so no `wasm-tools component new` wrapping is needed.
 */
async function buildRustModule(
  comp: ModuleComponent,
  opts: { projectDir: string; outWasmDir: string }
): Promise<string> {
  await ensureBin("cargo", ["--version"], "Install Rust: https://rustup.rs");
  // A module's crate is its component dir in a multi-module layout, or the
  // project root in the legacy single-crate layout (collectRustComponents sets
  // `dir` accordingly).
  const crateDir = comp.dir ?? opts.projectDir;
  const manifestPath = join(crateDir, "Cargo.toml");
  // `json-render-diagnostics`: compiler errors still render human-readable on
  // stderr; stdout carries only the JSON messages we parse.
  const stdout = await runCapture(
    "cargo",
    [
      "build",
      "--release",
      "--target",
      "wasm32-wasip2",
      "--manifest-path",
      manifestPath,
      "--message-format=json-render-diagnostics",
    ],
    crateDir
  );
  const built = cdylibWasmFromCargoMessages(stdout, manifestPath);
  if (!built || !existsSync(built)) {
    throw new BuildError(
      `cargo reported no cdylib .wasm for the crate at ${crateDir}. ` +
        `Ensure Cargo.toml sets [lib] crate-type = ["cdylib"] and the wasm32-wasip2 ` +
        `target is installed (rustup target add wasm32-wasip2).`
    );
  }
  const wasmPath = join(opts.outWasmDir, `${comp.name}.wasm`);
  copyFileSync(built, wasmPath);
  return wasmPath;
}

/**
 * Build a Hypen app to portable WASM components.
 *
 * @throws {BuildError} on invalid `wasm` config, a missing entry module, a
 *   missing toolchain, or a failed compile. Never exits the process.
 * @returns the manifest written to `<outDir>/wasm/app.json`.
 */
export async function buildWasm(options: BuildWasmOptions): Promise<AppManifest> {
  const {
    components: componentsDir,
    entry,
    outDir = "dist",
    keepTemp = false,
    root = process.cwd(),
  } = options;

  const config = parseWasmConfig(options.wasm);
  const projectDir = resolve(root);
  const resolvedComponentsDir = resolve(projectDir, componentsDir);
  const resolvedOutDir = resolve(projectDir, outDir);
  const outWasmDir = join(resolvedOutDir, "wasm");
  const tempDir = join(resolvedOutDir, ".wasm-temp");
  const lang = detectLanguage(projectDir, config.language);

  console.log(`\n  ${boldPink("Hypen Build")} ${dim("→")} ${yellow("wasm")}\n`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  const langLabel =
    lang === "go" ? "Go (tinygo)" : lang === "rust" ? "Rust (cargo)" : "TypeScript (jco)";
  const langSource = config.language ? ` ${dim("(hypen.json wasm.language)")}` : "";
  console.log(`  ${dim("Language:")}   ${langLabel}${langSource}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}`);
  console.log(`  ${dim("Output:")}     ${outWasmDir}\n`);

  // Collect stateful modules + stateless components per language.
  //   - stateful  → become `.wasm` (logic) + `.hypen` (UI)
  //   - stateless → template-only `.hypen` building blocks (Header(), Card())
  //     the entry references by name; no wasm, no state scope.
  let modules: ModuleComponent[];
  let stateless: Array<{ name: string; template: string }>;
  if (lang === "go") {
    ({ modules, stateless } = collectGoComponents(resolvedComponentsDir));
  } else if (lang === "rust") {
    ({ modules, stateless } = collectRustComponents(resolvedComponentsDir, entry, projectDir));
  } else {
    // Reuses the same discovery the dev server / RemoteServer use, so the wasm
    // build sees exactly what `hypen dev` sees.
    const { discoverComponents, loadDiscoveredComponents } = await import(
      "@hypen-space/server"
    );
    const discovered = await discoverComponents(resolvedComponentsDir);
    const loaded = await loadDiscoveredComponents(discovered);
    modules = [];
    stateless = [];
    for (const d of discovered) {
      const entryLoaded = loaded.get(d.name);
      if (d.hasModule && d.modulePath && entryLoaded?.module) {
        modules.push({
          name: d.name,
          modulePath: isAbsolute(d.modulePath)
            ? d.modulePath
            : resolve(projectDir, d.modulePath),
          template: entryLoaded.template ?? d.template ?? "",
          actions: entryLoaded.module.actions ?? [],
        });
      } else if (d.template) {
        stateless.push({ name: d.name, template: d.template });
      }
    }
  }

  if (!modules.find((m) => m.name === entry)) {
    const hint =
      lang === "go"
        ? `A Go wasm build needs ${entry}/ to contain Go source implementing the module.`
        : lang === "rust"
          ? `A Rust wasm build needs ${entry}/${entry}.hypen (the crate is the entry module).`
          : `A wasm build needs the entry to have a module ` +
            `(${entry}.ts with app.defineState(...).build()).`;
    throw new BuildError(
      `Entry module "${entry}" not found among stateful components ` +
        `(${modules.map((m) => m.name).join(", ") || "none"}). ${hint}`
    );
  }

  // Validate capability grants against what was discovered *before* spending
  // minutes compiling.
  const capabilities = resolveModuleCapabilities(
    config,
    modules.map((m) => m.name),
    stateless.map((s) => s.name)
  );

  // Fresh output dirs.
  rmSync(outWasmDir, { recursive: true, force: true });
  mkdirSync(outWasmDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    // Per-language WIT + one-time setup.
    const witDir =
      lang === "go"
        ? resolveWit("wit-tinygo", "world.wit")
        : resolveWit("wit", "hypen-module.wit");
    if (lang === "rust") {
      // Provision wit/ into each module's crate dir so its
      // `wit_bindgen::generate!({ path: "wit" })` resolves. (Legacy single-crate
      // sets `dir` to the project root.) Per-crate ABI: a crate opting into the
      // CM-async v0.2 world (`[package.metadata.hypen] abi = "0.2"`, or its own
      // vendored @0.2 WIT) gets the async package; wit-bindgen then generates
      // async bindings from the WIT itself — no extra codegen flags. A
      // previously provisioned wit/ is refreshed when it no longer matches.
      for (const m of modules) {
        const dir = m.dir ?? projectDir;
        const abi = rustCrateAbi(dir);
        if (abi === "0.2") console.log(`  ${dim(`${m.name}: hypen:module@0.2.0 (CM-async)`)}`);
        const did = provisionRustWit(dir, abi);
        if (did === "provisioned" || did === "refreshed") {
          console.log(`  ${dim(`${m.name}: ${did} wit/ (hypen:module@${abi}) from the CLI`)}`);
        }
      }
    }
    if (lang === "go") {
      await ensureBin(
        "tinygo",
        ["version"],
        // TinyGo 0.39.0 is the first release with Go 1.25 support (its
        // CHANGELOG: "all: add Go 1.25 support"); hypen-golang's go.mod says
        // `go 1.25.0`.
        "Install TinyGo >= 0.39 (the first release supporting Go 1.25, which the " +
          "Hypen Go SDK requires): https://tinygo.org/getting-started/install/"
      );
      const goModule = goModulePath(projectDir);
      const bindingsBase = `${goModule}/internal/bindings/hypen/module`;
      console.log(`  ${dim("generating Go bindings…")}`);
      await generateGoBindings(projectDir, witDir);
      // Generate every app-mode shim up front, then resolve the module graph
      // once — the shims (and bindings) import `cm`, so `go mod tidy` must see
      // them before it prunes/locks dependencies.
      const appComps = modules.filter((m) => m.goMode === "app");
      for (const comp of appComps) {
        writeGoShim(comp, { projectDir, tempDir, goModule, bindingsBase });
      }
      if (appComps.length > 0) {
        console.log(`  ${dim("resolving Go modules…")}`);
        await run("go", ["mod", "tidy"], projectDir);
      }
    }

    // `wasm` and the capability fields are omitted for stateless components —
    // the runtime registers their template with the resolver but creates no
    // instance.
    const manifestModules: AppManifestModule[] = [];

    // Build each stateful module + emit its UI template alongside.
    for (const comp of modules) {
      const modeNote =
        lang === "go" && comp.goMode === "wit" ? ` ${dim("(wit)")}` : "";
      console.log(`  ${pink("building")} ${comp.name}${modeNote} ${dim("…")}`);
      if (lang === "go") {
        await buildGoModule(comp, { projectDir, tempDir, outWasmDir, witDir });
      } else if (lang === "rust") {
        await buildRustModule(comp, { projectDir, outWasmDir });
      } else {
        await buildTsModule(comp, {
          projectDir,
          tempDir,
          outWasmDir,
          witDir,
          keepTemp,
          storage: capabilities.get(comp.name)!.storage,
        });
      }

      const uiName = `${comp.name}.hypen`;
      writeFileSync(join(outWasmDir, uiName), comp.template);
      manifestModules.push({
        name: comp.name,
        wasm: `${comp.name}.wasm`,
        ui: uiName,
        ...capabilities.get(comp.name)!,
      });
      // Go/Rust discover their action list at runtime via the module's
      // `actions()` export, so only annotate the count for TS where it's known.
      const actionsNote =
        lang === "ts" ? ` ${dim(`(${comp.actions.length} action(s))`)}` : "";
      console.log(
        `    ${dim("→")} ${comp.name}.wasm ${dim("+")} ${uiName}${actionsNote}`
      );
    }

    // Emit each stateless component's UI template (no wasm).
    for (const comp of stateless) {
      const uiName = `${comp.name}.hypen`;
      writeFileSync(join(outWasmDir, uiName), comp.template);
      manifestModules.push({ name: comp.name, ui: uiName });
      console.log(`    ${dim("→")} ${uiName} ${dim("(stateless)")}`);
    }

    // Emit the app manifest consumed by `hypen-runtime --app`.
    const manifest: AppManifest = { entry, modules: manifestModules };
    writeFileSync(
      join(outWasmDir, "app.json"),
      JSON.stringify(manifest, null, 2) + "\n"
    );

    const statelessNote =
      stateless.length > 0 ? ` + ${stateless.length} stateless` : "";
    console.log(
      `\n  ${boldPink("Done.")} ${modules.length} module(s)${statelessNote} → ${dim(outWasmDir)}`
    );
    const manifestRel = relative(projectDir, join(outWasmDir, "app.json")) || "app.json";
    console.log(`  ${dim("Run it:")} ${yellow(`hypen-runtime --app ${manifestRel}`)}\n`);
    return manifest;
  } finally {
    if (!keepTemp) rmSync(tempDir, { recursive: true, force: true });
  }
}
