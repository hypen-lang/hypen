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
 * `go.mod`, TypeScript via `package.json`). The orchestration, manifest, and
 * asset emission are language-agnostic.
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
  statSync,
} from "fs";
import { join, resolve, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { boldPink, pink, dim, yellow } from "./colors.js";

/** Build target language, detected from the project's files. */
type Language = "ts" | "go" | "rust";

export interface BuildWasmOptions {
  /** Path to components directory (e.g. `./src/components`). */
  components: string;
  /** Entry component name (e.g. `App`). */
  entry: string;
  /** Output directory. Artifacts land in `<outDir>/wasm/`. Default: `dist`. */
  outDir?: string;
  /** Keep the intermediate shim/bundle files for debugging. Default: false. */
  keepTemp?: boolean;
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
   *    directly (advanced / the wit-spikes shape); built as-is.
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
 * Detect the project's source language from its files. Rust projects have a
 * `Cargo.toml`; Go projects a `go.mod`; TypeScript projects a `package.json`
 * (the `hypen init` default). Defaults to TypeScript when ambiguous.
 */
export function detectLanguage(projectDir: string): Language {
  if (existsSync(join(projectDir, "Cargo.toml"))) return "rust";
  if (existsSync(join(projectDir, "go.mod"))) return "go";
  return "ts";
}

/**
 * The generic shim source: adapts a `HypenModuleDefinition` (the default
 * export of a Hypen module file) to the `hypen:module` reducer ABI. Identical
 * for every TS module — only the import path to the user module differs.
 *
 * Reducer semantics mirror `@hypen-space/core`: action handlers mutate
 * `state` in place; we serialize the mutated object. Cross-module context,
 * data sources, and async handlers are not yet bridged across the wasm
 * boundary and fail loudly rather than silently misbehaving.
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

// The wasm-target GlobalContext. Sync surfaces (read/emit/subscribe) are wired
// to the engine; async cross-module *writes* fail loudly. \`emitSink\` is the
// current reducer's ReducerOutput.emit accumulator.
function ctx(emitSink) {
  const moduleRef = (id) => ({
    get state() { return readSiblingState(id); },
    getState: () => readSiblingState(id),
    setState() { throw new Error("context.getModule(...).setState is not supported on the wasm target yet (cross-module writes need directed dispatch)"); },
  });
  return {
    getModule: (id) => moduleRef(id),
    hasModule: (id) => { try { stateRead(id); return true; } catch { return false; } },
    getModuleIds: () => [],            // siblings can't be enumerated across the wasm boundary
    // Lazy global view: \`globalState[moduleId]\` reads that sibling on access.
    getGlobalState: () => new Proxy({}, { get: (_t, id) => (typeof id === "string" ? readSiblingState(id) : undefined) }),
    // Enqueue a follow-up action on this module; the engine dispatches it after
    // the current reducer returns (ReducerOutput.emit).
    emit: (name, payload) => { emitSink.push({ name, payload: encJson(payload) }); },
    // Observe a sibling: re-dispatch \`onChange\` (an action name) whenever
    // \`module\`'s state changes at dotted \`path\`. Registered when the reducer
    // returns; maps 1:1 to hypen:engine/state.subscribe.
    on: (module, path, onChange) => { stateSubscribe(module, path ?? "", onChange); return () => {}; },
    router: null,
  };
}
const dataSources = new Proxy({}, {
  get() { throw new Error("data sources are not supported on the wasm target yet"); },
});

export function init(config) {
  // Declaration-site config (\`module X(start: 5)\` → {"start":5}) shallow-merges
  // over the static initialState. No config (empty / non-object) leaves the
  // initialState untouched.
  const seed = decJson(config);
  if (!seed || typeof seed !== "object" || Array.isArray(seed) || Object.keys(seed).length === 0) {
    return encJson(def.initialState);
  }
  return encJson({ ...(def.initialState ?? {}), ...seed });
}

export function dispatch(stateBytes, action) {
  const state = decJson(stateBytes) ?? {};
  const handler = def.handlers.onAction.get(action.name);
  if (!handler) throw new Error("unknown action: " + action.name);
  const payload = decJson(action.payload);
  const emit = [];
  const ret = handler({ action: { name: action.name, payload, sender: undefined }, state, context: ctx(emit), dataSources });
  if (ret && typeof ret.then === "function") {
    throw new Error('async action handler "' + action.name + '" is not supported on the wasm target yet');
  }
  return { state: encJson(state), effects: [], emit };
}

function lifecycle(fn) {
  return (stateBytes) => {
    if (!fn) return { state: undefined, effects: [], emit: [] };
    const state = decJson(stateBytes) ?? {};
    const emit = [];
    const ret = fn(state, ctx(emit));
    if (ret && typeof ret.then === "function") {
      throw new Error("async lifecycle handlers are not supported on the wasm target yet");
    }
    return { state: encJson(state), effects: [], emit };
  };
}
export const onActivated = lifecycle(def.handlers.onActivated);
export const onDeactivated = lifecycle(def.handlers.onDeactivated);
export function onDestroyed(stateBytes) {
  // onDestroyed returns result<_,string> (no ReducerOutput), so any emit()/on()
  // calls here are dropped — matches the native host, which discards them.
  if (def.handlers.onDestroyed) def.handlers.onDestroyed(decJson(stateBytes) ?? {}, ctx([]));
}

export function actions() {
  return def.actions;
}
`;
}

/**
 * esbuild plugin stubbing node built-ins. A Hypen reducer never touches the
 * filesystem; these references live in lazy core code paths (`.uiFile()`,
 * the component resolver) that don't execute inside a module. Stubbing lets
 * the bundle target WASI instead of Node.
 */
function nodeStubPlugin() {
  return {
    name: "hypen-stub-node-builtins",
    setup(build: any) {
      const builtins =
        /^(node:)?(fs|fs\/promises|path|os|url|crypto|child_process|module|worker_threads|net|tls|http|https|stream|zlib)$/;
      build.onResolve({ filter: builtins }, (args: any) => ({
        path: args.path,
        namespace: "hypen-node-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "hypen-node-stub" }, () => ({
        contents: "export default {};",
        loader: "js",
      }));
    },
  };
}

/** Run a child process to completion, streaming stdio. Rejects on non-zero. */
function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${cmd} exited with code ${code ?? "null"}`))
    );
  });
}

/**
 * Resolve how to invoke `jco`. Prefers a locally installed binary
 * (`node_modules/.bin/jco`), falling back to `bunx`/`npx` which fetch it on
 * demand. Returns the command + leading args.
 *
 * The fallback MUST name the scoped package: the unscoped `jco` on npm is an
 * unrelated placeholder package, not `@bytecodealliance/jco` (whose bin is
 * `jco`), so `bunx jco` would download and run the wrong thing.
 */
export function resolveJco(projectDir: string): { cmd: string; pre: string[] } {
  const local = join(projectDir, "node_modules", ".bin", "jco");
  if (existsSync(local)) return { cmd: local, pre: [] };
  const isBun = typeof (globalThis as any).Bun !== "undefined";
  return isBun
    ? { cmd: "bunx", pre: [JCO_PACKAGE] }
    : { cmd: "npx", pre: ["--yes", JCO_PACKAGE] };
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
async function buildTsModule(
  comp: ModuleComponent,
  opts: {
    projectDir: string;
    tempDir: string;
    outWasmDir: string;
    witDir: string;
    keepTemp: boolean;
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

  // 3. Componentize. `--disable http` keeps async-only HTTP out of the sync
  //    reducer ABI; clocks/random stay available (Date / Math.random).
  const { cmd, pre } = resolveJco(opts.projectDir);
  await run(
    cmd,
    [
      ...pre,
      "componentize",
      bundlePath,
      "--wit",
      opts.witDir,
      // module-x = the base module world + the hypen:engine/state import the
      // shim uses for cross-module read/subscribe. Superset of `module`; adds no
      // wasi:http requirement, so `--disable http` stays valid.
      "--world-name",
      "module-x",
      "-o",
      wasmPath,
      "--disable",
      "http",
    ],
    opts.projectDir
  );
  // Don't trust the exit code alone: a mis-resolved `jco` can exit 0 without
  // writing anything, and the manifest would then reference a missing file.
  if (!existsSync(wasmPath)) {
    throw new Error(
      `jco componentize reported success but did not write ${wasmPath}. ` +
        `Install ${JCO_PACKAGE} in the project (bun add -d ${JCO_PACKAGE}) and retry.`
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

/** Read the crate name from `Cargo.toml` (`[package] name = "..."`). */
function cargoPackageName(projectDir: string): string {
  const toml = readFileSync(join(projectDir, "Cargo.toml"), "utf8");
  // Naive but sufficient: the first `name = "..."` after `[package]`.
  const pkgIdx = toml.indexOf("[package]");
  const scope = pkgIdx >= 0 ? toml.slice(pkgIdx) : toml;
  const m = scope.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`Could not read [package] name from ${join(projectDir, "Cargo.toml")}`);
  return m[1];
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
 *  1. A crate-vendored `wit/hypen-module.wit` declaring `hypen:module@0.2`
 *     (authors who vendor their own WIT already get it verbatim —
 *     `provisionRustWit` never overwrites).
 *  2. An explicit `[package.metadata.hypen] abi = "0.2"` in `Cargo.toml`.
 */
export function rustCrateAbi(crateDir: string): "0.1" | "0.2" {
  const vendored = join(crateDir, "wit", "hypen-module.wit");
  if (existsSync(vendored) && readFileSync(vendored, "utf8").includes("hypen:module@0.2")) {
    return "0.2";
  }
  const cargoToml = join(crateDir, "Cargo.toml");
  if (existsSync(cargoToml)) {
    const toml = readFileSync(cargoToml, "utf8");
    const metaIdx = toml.indexOf("[package.metadata.hypen]");
    if (metaIdx >= 0) {
      const nextSection = toml.indexOf("\n[", metaIdx + 1);
      const scope = toml.slice(metaIdx, nextSection === -1 ? undefined : nextSection);
      const m = scope.match(/^\s*abi\s*=\s*"([^"]+)"/m);
      if (m && m[1].startsWith("0.2")) return "0.2";
    }
  }
  return "0.1";
}

/**
 * Provision the canonical WIT into `<project>/wit` so the conventional
 * `wit_bindgen::generate!({ world: "module", path: "wit" })` resolves. Only
 * copies when absent — a project that vendors its own WIT is left untouched.
 */
function provisionRustWit(projectDir: string, witDir: string): void {
  const dest = join(projectDir, "wit");
  if (existsSync(join(dest, "hypen-module.wit"))) return;
  cpSync(witDir, dest, { recursive: true });
  console.log(`  ${dim("provisioned wit/ from the CLI")}`);
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
  await run(
    "cargo",
    ["build", "--release", "--target", "wasm32-wasip2"],
    crateDir
  );
  const crate = cargoPackageName(crateDir).replace(/-/g, "_");
  const rel = join("target", "wasm32-wasip2", "release", `${crate}.wasm`);
  // A standalone crate emits into its own `target/`; a Cargo workspace member
  // emits into the workspace-root `target/`. Check both.
  const built = [join(crateDir, rel), join(opts.projectDir, rel)].find((p) =>
    existsSync(p)
  );
  if (!built) {
    throw new Error(
      `Expected cargo output <target>/${rel} not found for crate at ${crateDir}. ` +
        `Ensure Cargo.toml sets crate-type = ["cdylib"] and the wasm32-wasip2 ` +
        `target is installed (rustup target add wasm32-wasip2).`
    );
  }
  const wasmPath = join(opts.outWasmDir, `${comp.name}.wasm`);
  copyFileSync(built, wasmPath);
  return wasmPath;
}

/**
 * Build a Hypen app to portable WASM components.
 */
export async function buildWasm(options: BuildWasmOptions): Promise<void> {
  const {
    components: componentsDir,
    entry,
    outDir = "dist",
    keepTemp = false,
  } = options;

  const projectDir = process.cwd();
  const resolvedComponentsDir = resolve(componentsDir);
  const outWasmDir = resolve(outDir, "wasm");
  const tempDir = resolve(outDir, ".wasm-temp");
  const lang = detectLanguage(projectDir);

  console.log(`\n  ${boldPink("Hypen Build")} ${dim("→")} ${yellow("wasm")}\n`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  const langLabel =
    lang === "go" ? "Go (tinygo)" : lang === "rust" ? "Rust (cargo)" : "TypeScript (jco)";
  console.log(`  ${dim("Language:")}   ${langLabel}`);
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
            : resolve(d.modulePath),
          template: entryLoaded.template ?? d.template ?? "",
          actions: entryLoaded.module.actions ?? [],
        });
      } else if (d.template) {
        stateless.push({ name: d.name, template: d.template });
      }
    }
  }

  if (!modules.find((m) => m.name === entry)) {
    console.error(
      `  Entry module "${entry}" not found among stateful components ` +
        `(${modules.map((m) => m.name).join(", ") || "none"}).`
    );
    console.error(
      lang === "go"
        ? `  A Go wasm build needs ${entry}/ to contain Go source implementing the module.\n`
        : lang === "rust"
          ? `  A Rust wasm build needs ${entry}/${entry}.hypen (the crate is the entry module).\n`
          : `  A wasm build needs the entry to have a module ` +
              `(${entry}.ts with app.defineState(...).build()).\n`
    );
    process.exit(1);
  }

  // Fresh output dirs.
  rmSync(outWasmDir, { recursive: true, force: true });
  mkdirSync(outWasmDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

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
    // async bindings from the WIT itself — no extra codegen flags.
    for (const m of modules) {
      const dir = m.dir ?? projectDir;
      if (rustCrateAbi(dir) === "0.2") {
        console.log(`  ${dim(`${m.name}: hypen:module@0.2.0 (CM-async)`)}`);
        provisionRustWit(dir, resolveWit("wit-v0_2", "hypen-module.wit"));
      } else {
        provisionRustWit(dir, witDir);
      }
    }
  }
  if (lang === "go") {
    await ensureBin(
      "tinygo",
      ["version"],
      "Install TinyGo >= 0.36: https://tinygo.org/getting-started/install/"
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

  // `wasm` is omitted for stateless components — the runtime registers their
  // template with the resolver but creates no instance.
  const manifestModules: Array<{ name: string; wasm?: string; ui: string }> = [];

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
      });
    }

    const uiName = `${comp.name}.hypen`;
    writeFileSync(join(outWasmDir, uiName), comp.template);
    manifestModules.push({
      name: comp.name,
      wasm: `${comp.name}.wasm`,
      ui: uiName,
    });
    // Go discovers its action list at runtime via the module's `actions()`
    // export, so only annotate the count for TS where it's known here.
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
  const manifest = { entry, modules: manifestModules };
  writeFileSync(
    join(outWasmDir, "app.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  if (!keepTemp) rmSync(tempDir, { recursive: true, force: true });

  const statelessNote =
    stateless.length > 0 ? ` + ${stateless.length} stateless` : "";
  console.log(
    `\n  ${boldPink("Done.")} ${modules.length} module(s)${statelessNote} → ${dim(outWasmDir)}`
  );
  console.log(
    `  ${dim("Run it:")} ${yellow(`hypen-runtime --app ${join(outDir, "wasm", "app.json")}`)}\n`
  );
}
