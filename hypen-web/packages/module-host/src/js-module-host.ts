// JS-side implementation of the `JsModuleHost` interface the Rust
// `BridgedHost` calls into. Transpiles registered WASM Component bytes at
// runtime with jco's bindgen (async `prepare()`), then serves the Rust host's
// synchronous instantiate/init/dispatch calls from the prepared bindings.
//
// Method contract (must match `bridged_host.rs::JsModuleHost`):
//   register(name, bytes, manifest)
//   instantiate(name) -> id
//   actions(id) -> string[]
//   destroy(id)
//   init(id, config) -> Uint8Array (new state)
//   dispatch(id, state, action, siblings) -> ReducerOutput
//   onActivated(id, state, siblings) -> ReducerOutput
//   onDeactivated(id, state) -> ReducerOutput
//   onDestroyed(id, state)
//
// Plus the JS-only async half:
//   await prepare(name [, bytes, manifest])
//     transpiles the registered component bytes in memory, compiles the
//     emitted core wasm, builds the manifest-gated import map (link-time
//     gating of wasi:http and hypen:storage/{app,cloud}, see buildImportMap),
//     and instantiates the component. Must complete before
//     `instantiate(name)`.
//
// All per-call and storage state lives on the host instance: two hosts never
// share an ACL context, and each has its own storage backends.

import type {
  ActionMessage,
  CrossDispatch,
  Effect,
  ModuleBindings,
  ModuleManifest,
  NormalizedManifest,
  ReducerOutput,
  SiblingState,
  SubscribeRequest,
} from "./types.ts";
import { normalizeManifest } from "./types.ts";
import {
  HostStorage,
  createStorageImports,
  type HostStorageOptions,
} from "./storage.ts";
import { loadWasiImports, type WasiImports } from "./wasi.ts";
import { importInMemoryModule, transpileComponent, wasmCspError, type LoadedVia } from "./loader.ts";

// ----------------------------------------------------------------------------
// hypen:engine/state
// ----------------------------------------------------------------------------

// Per-call cross-module context, valid for the duration of one dispatch /
// onActivated — the same model as the native WasmtimeHost's per-call fields.
interface CallContext {
  siblings: Map<string, Uint8Array>;
  readsAllowed: ReadonlySet<string>;
  dispatchesAllowed: ReadonlySet<string>;
  crossDispatch: CrossDispatch[];
  subscribeRequests: SubscribeRequest[];
}

/** The `hypen:engine/state` import (jco shape: errors thrown as `{ tag, val }`). */
export interface EngineStateImport {
  read(module: string): Uint8Array;
  dispatch(module: string, action: ActionMessage): void;
  subscribe(module: string, path: string, onChange: string): void;
}

function createEngineStateImport(current: () => CallContext | null): EngineStateImport {
  return {
    read(module) {
      const ctx = current();
      if (!ctx || !ctx.readsAllowed.has(module)) {
        throw { tag: "permission-denied", val: "reads" };
      }
      const snapshot = ctx.siblings.get(module);
      if (snapshot === undefined) throw { tag: "not-found" };
      return snapshot;
    },
    dispatch(module, action) {
      const ctx = current();
      if (!ctx || !ctx.dispatchesAllowed.has(module)) {
        throw { tag: "permission-denied", val: "dispatches" };
      }
      // Queued, not reentrant: drained into ReducerOutput.crossDispatch.
      ctx.crossDispatch.push({ module, action: { name: action.name, payload: action.payload } });
    },
    subscribe(module, path, onChange) {
      const ctx = current();
      // Observing state is a read: gated on the same `reads` grant.
      if (!ctx || !ctx.readsAllowed.has(module)) {
        throw { tag: "permission-denied", val: "reads" };
      }
      ctx.subscribeRequests.push({ module, path, onChange });
    },
  };
}

// ----------------------------------------------------------------------------
// Import map (link-time capability gate)
// ----------------------------------------------------------------------------

const LOCAL = "hypen:storage/local";
const APP = "hypen:storage/app";
const CLOUD = "hypen:storage/cloud";
const ENGINE_STATE = "hypen:engine/state";

/** Strip a `@x.y.z` version suffix; the emitted bindings look imports up unversioned. */
const unversioned = (key: string): string => key.replace(/@[^@/]*$/, "");

/**
 * Build the per-module import map from the `available` implementations,
 * keeping only what the manifest grants. This is the browser analogue of
 * the native hosts' link-time gate: an ungranted interface is simply absent,
 * and if the component imports it this throws (so `prepare()` fails) with an
 * error naming the missing interface.
 *
 * Always linked: `hypen:storage/local`, `hypen:engine/state` (its ACLs are
 * enforced per call) and every non-http WASI interface in `available`.
 * Linked only when granted: `hypen:storage/app` (`storage` lists `"app"`),
 * `hypen:storage/cloud` (`"cloud"`), `wasi:http/*` (`http === true`).
 *
 * @param available interface name (unversioned) -> implementation; the host
 *   passes its WASI shims, storage and engine-state imports here.
 */
export function buildImportMap(
  name: string,
  manifest: ModuleManifest | NormalizedManifest | null | undefined,
  requiredImports: readonly string[] | undefined,
  available: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const m = isNormalized(manifest) ? manifest : normalizeManifest(manifest);
  const granted = (key: string): boolean => {
    if (key === APP) return m.storage.has("app");
    if (key === CLOUD) return m.storage.has("cloud");
    if (key.startsWith("wasi:http/")) return m.http;
    return true;
  };
  const map: Record<string, unknown> = {};
  for (const [key, impl] of Object.entries(available)) {
    if (granted(key)) map[key] = impl;
  }

  const missing = (requiredImports ?? []).map(unversioned).filter((key) => !(key in map));
  if (missing.length === 0) return map;

  const denied = missing.filter((k) => k in available || !granted(k));
  const http = denied.filter((k) => k.startsWith("wasi:http/"));
  if (http.length > 0) {
    throw new Error(
      `http egress denied for module '${name}': manifest.http is not true but ` +
        `the component imports ${http.join(", ")}`,
    );
  }
  const storage = denied.filter((k) => k === APP || k === CLOUD);
  if (storage.length > 0) {
    throw new Error(
      `storage scope denied for module '${name}': the component imports ` +
        `${storage.join(", ")} but manifest.storage does not grant ` +
        storage.map((k) => `'${k.slice("hypen:storage/".length)}'`).join(", "),
    );
  }
  throw new Error(
    `module '${name}' imports interfaces this host does not provide: ${missing.join(", ")}`,
  );
}

function isNormalized(m: unknown): m is NormalizedManifest {
  return typeof m === "object" && m !== null && (m as { storage?: unknown }).storage instanceof Set;
}

// ----------------------------------------------------------------------------
// WIT -> wire normalisation
// ----------------------------------------------------------------------------

function effectFromWit(e: any): Effect {
  if (e.tag === "log") return { tag: "log", level: e.val.level, message: e.val.message };
  if (e.tag === "navigate") return { tag: "navigate", path: e.val };
  if (e.tag === "delay") return { tag: "delay", ms: e.val.ms, then: e.val.then };
  return e;
}

function reducerOutputFromWit(out: any, ctx: CallContext | null = null): ReducerOutput {
  return {
    state: out?.state, // Uint8Array or undefined
    effects: (out?.effects ?? []).map(effectFromWit),
    emit: (out?.emit ?? []).map((a: any) => ({ name: a.name, payload: a.payload })),
    // Queued by the reducer through `hypen:engine/state`; the Rust
    // BridgedHost decodes these into ReducerOutput.{cross_dispatch,
    // subscribe_requests}.
    crossDispatch: ctx?.crossDispatch ?? [],
    subscribeRequests: ctx?.subscribeRequests ?? [],
  };
}

// ----------------------------------------------------------------------------
// The host
// ----------------------------------------------------------------------------

/**
 * What one successful {@link JsModuleHost.prepare} did — for diagnostics and
 * performance measurement (see {@link JsModuleHostOptions.onPrepare}).
 */
export interface PrepareInfo {
  module: string;
  /** How the emitted bindings JS was imported: a Blob URL or the `data:` fallback. */
  loadedVia: LoadedVia;
  /** Size of the component that was transpiled. */
  componentBytes: number;
  /** Size of the emitted bindings JS. */
  bindingsBytes: number;
  /** Total size of the emitted core wasm modules. */
  coreWasmBytes: number;
  /** Wall-clock milliseconds per step (`performance.now()` deltas). */
  timings: {
    /** jco bindgen (includes fetching + compiling jco's own wasm on the first call). */
    transpileMs: number;
    /** `WebAssembly.compile` of the emitted core modules. */
    compileMs: number;
    /** Import of the bindings JS (Blob / data: URL). */
    importMs: number;
    /** Component instantiation against the gated import map. */
    instantiateMs: number;
    totalMs: number;
  };
}

/** Options for {@link JsModuleHost}. */
export interface JsModuleHostOptions extends HostStorageOptions {
  /** Called after every successful `prepare()` with how it went. */
  onPrepare?: (info: PrepareInfo) => void;
}

/**
 * Whether preview2-shim can make a module's blocking `wasi:io/poll` wait
 * synchronously here. Its Node build parks the thread (`Atomics.wait`, also
 * used under Bun); its browser build can only return a Promise from
 * `Pollable.block()`, which a synchronous reducer cannot await.
 */
const SYNC_WASI_POLL =
  typeof process !== "undefined" && typeof (process as { versions?: { node?: string } }).versions?.node === "string";

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * A component transpiled and compiled once, ready to be instantiated any
 * number of times — the expensive half of {@link JsModuleHost.prepare}
 * (jco bindgen + `WebAssembly.compile`), with nothing host-specific in it.
 * Share one between hosts: each {@link JsModuleHost.instantiatePrepared}
 * links a fresh component instance (own linear memory) against that host's
 * own storage and ACL context.
 */
export interface PreparedComponent {
  /** The name it was transpiled under (diagnostics only). */
  readonly name: string;
  /** Interfaces the component imports (unversioned). */
  readonly requiredImports: readonly string[];
  readonly loadedVia: LoadedVia;
  readonly componentBytes: number;
  readonly bindingsBytes: number;
  readonly coreWasmBytes: number;
  readonly timings: { transpileMs: number; compileMs: number; importMs: number };
  /** Link and instantiate against `imports` (see {@link JsModuleHost.importMapFor}). */
  instantiate(imports: Record<string, unknown>): Promise<ModuleBindings>;
}

/**
 * Transpile and compile component `bytes` (async, slow: do it once per
 * component). Nothing is linked yet, so no manifest is involved — the
 * capability gate applies when a host instantiates the result.
 */
export async function prepareComponent(name: string, bytes: Uint8Array): Promise<PreparedComponent> {
  if (!bytes || bytes.length === 0) {
    throw new Error(`no component bytes given for module: ${name}`);
  }
  const t0 = now();
  // 1. In-memory bindgen (instantiation: async => bindings export
  //    `instantiate(getCoreModule, imports)`, no sibling-file fetches).
  const { files, imports: requiredImports } = await transpileComponent(name, bytes);
  const t1 = now();

  // 2. Compile the emitted core wasm.
  const coreModules = new Map<string, WebAssembly.Module>();
  const jsFiles: string[] = [];
  let coreWasmBytes = 0;
  for (const [file, contents] of files) {
    if (file.endsWith(".wasm")) {
      coreWasmBytes += contents.byteLength;
      try {
        coreModules.set(file, await WebAssembly.compile(contents as BufferSource));
      } catch (e) {
        throw wasmCspError(e, `could not compile module '${name}'`) ?? e;
      }
    } else if (file.endsWith(".js")) {
      jsFiles.push(file);
    }
  }
  const t2 = now();
  const getCoreModule = (relPath: string): WebAssembly.Module => {
    const mod = coreModules.get(relPath.replace(/^\.\//, ""));
    if (!mod) throw new Error(`unknown core module requested by bindings: ${relPath}`);
    return mod;
  };

  // 3. Load the bindings module. With async instantiation jco emits exactly
  //    one self-contained JS file (no relative imports); anything else is
  //    unsupported here.
  const mainJs = jsFiles.includes(`${name}.js`) ? `${name}.js` : jsFiles[0];
  if (!mainJs || jsFiles.length !== 1) {
    throw new Error(
      `expected exactly one bindings .js from jco for '${name}', got: ` +
        `${files.map(([f]) => f).join(", ")}`,
    );
  }
  const source = files.find(([f]) => f === mainJs)![1];
  const { module: bindingsModule, via } = await importInMemoryModule(source);
  const t3 = now();

  return {
    name,
    requiredImports,
    loadedVia: via,
    componentBytes: bytes.byteLength,
    bindingsBytes: source.byteLength,
    coreWasmBytes,
    timings: { transpileMs: t1 - t0, compileMs: t2 - t1, importMs: t3 - t2 },
    instantiate: (imports) => bindingsModule.instantiate(getCoreModule, imports),
  };
}

interface ComponentEntry {
  bytes: Uint8Array | null;
  manifest: NormalizedManifest;
  prepared: { bindings: ModuleBindings } | null;
}

interface InstanceEntry {
  name: string;
  bindings: ModuleBindings;
}

/**
 * Whether `e` is a guest trap: the component instance behind it can no
 * longer be trusted (a Rust panic aborts mid-call, leaving its memory in
 * whatever state it was). An export that returned `Err(...)` is not a trap —
 * jco throws a `ComponentError` for that.
 */
function isTrap(e: unknown): boolean {
  return e instanceof WebAssembly.RuntimeError || e instanceof RangeError;
}

export class JsModuleHost {
  #components = new Map<string, ComponentEntry>();
  #instances = new Map<number, InstanceEntry>();
  #nextId = 1;
  #activeCall: CallContext | null = null;
  /**
   * Component instances that trapped, by their bindings object, with what
   * killed them. Every host instance id sharing those bindings is dead.
   */
  #dead = new WeakMap<ModuleBindings, string>();
  readonly #onPrepare: ((info: PrepareInfo) => void) | undefined;

  /** This host's storage (backends, quotas). Shared by all its modules. */
  readonly storage: HostStorage;

  /**
   * This host's `hypen:engine/state` import. Only answers inside a
   * `dispatch` / `onActivated` call of THIS host; outside one every call is
   * denied. Exposed for custom import maps and fake bindings in tests.
   */
  readonly engineState: EngineStateImport;

  constructor(options: JsModuleHostOptions = {}) {
    this.storage = new HostStorage(options);
    this.engineState = createEngineStateImport(() => this.#activeCall);
    this.#onPrepare = options.onPrepare;
  }

  register(name: string, bytes: Uint8Array | null | undefined, manifest?: ModuleManifest): void {
    const existing = this.#components.get(name);
    if (existing && (!bytes || bytes.length === 0)) {
      // Re-registration with empty bytes (the engine registering a module
      // that was pre-registered + prepared on the JS side): keep the
      // prepared bindings, refresh the manifest. Link-time grants (http,
      // storage scopes) were fixed at prepare(); only the per-call grants
      // (reads/dispatches) change.
      if (manifest) existing.manifest = normalizeManifest(manifest);
      return;
    }
    this.#components.set(name, {
      bytes: bytes ?? null,
      manifest: normalizeManifest(manifest),
      prepared: null,
    });
  }

  /**
   * Inject already-instantiated bindings for `name`, skipping the transpile
   * pipeline (build-time-transpiled components, test fakes). The per-call
   * ACL context still comes from `manifest`. For a real component, build
   * its imports with {@link importMapFor} so the link-time gate applies.
   */
  registerPrepared(name: string, bindings: ModuleBindings, manifest?: ModuleManifest): void {
    this.#components.set(name, {
      bytes: null,
      manifest: normalizeManifest(manifest),
      prepared: { bindings },
    });
  }

  /**
   * The manifest-gated import map for a registered module: WASI shims,
   * this host's storage imports bound to `name`, and `engineState`. Throws
   * if `requiredImports` includes an interface the manifest does not grant.
   */
  async importMapFor(name: string, requiredImports?: readonly string[]): Promise<Record<string, unknown>> {
    const entry = this.#components.get(name);
    if (!entry) throw new Error(`module not registered: ${name}`);
    const wasi = await loadWasiImports();
    return buildImportMap(name, entry.manifest, requiredImports, this.#available(name, wasi));
  }

  #available(name: string, wasi: WasiImports): Record<string, unknown> {
    const storage = createStorageImports(this.storage, name);
    return {
      ...wasi.base,
      ...wasi.http,
      [LOCAL]: storage.local,
      [APP]: storage.app,
      [CLOUD]: storage.cloud,
      [ENGINE_STATE]: this.engineState,
    };
  }

  /**
   * Async half of the pipeline: transpile, gate, compile, instantiate.
   * Optional `bytes`/`manifest` pre-register in one call, for flows where
   * the engine's own register() happens inside a sync Rust call.
   */
  async prepare(name: string, bytes?: Uint8Array | null, manifest?: ModuleManifest): Promise<this> {
    if (bytes !== undefined && bytes !== null) this.register(name, bytes, manifest);
    const entry = this.#components.get(name);
    if (!entry) throw new Error(`module not registered: ${name}`);
    if (!entry.bytes || entry.bytes.length === 0) {
      throw new Error(`no component bytes registered for module: ${name}`);
    }
    const t0 = now();
    const prepared = await prepareComponent(name, entry.bytes);

    // Link-time gate. Throws if the component imports something the
    // manifest does not grant.
    const importMap = await this.importMapFor(name, prepared.requiredImports);
    const t1 = now();
    const bindings = await prepared.instantiate(importMap);
    const t2 = now();

    // Only commit if the entry wasn't replaced (fresh bytes) meanwhile.
    if (this.#components.get(name) === entry) entry.prepared = { bindings };
    this.#onPrepare?.({
      module: name,
      loadedVia: prepared.loadedVia,
      componentBytes: prepared.componentBytes,
      bindingsBytes: prepared.bindingsBytes,
      coreWasmBytes: prepared.coreWasmBytes,
      timings: {
        transpileMs: prepared.timings.transpileMs,
        compileMs: prepared.timings.compileMs,
        importMs: prepared.timings.importMs,
        instantiateMs: t2 - t1,
        totalMs: t2 - t0,
      },
    });
    return this;
  }

  /**
   * Instantiate an already {@link prepareComponent}-ed component in THIS
   * host under `name`: a fresh component instance linked against this
   * host's storage (partitioned by `name`), ACL context and the grants of
   * `manifest`. Cheap next to `prepare()` (no transpile, no compile), so a
   * server prepares each component once and gives every session's host its
   * own instance. Replaces whatever `name` held; instances already handed
   * out keep the bindings they were created with.
   *
   * Returns the new bindings (hand them to `registerPrepared` to put a
   * previous set back). Throws — before anything is replaced — when the
   * component imports an interface `manifest` does not grant.
   */
  async instantiatePrepared(
    name: string,
    prepared: PreparedComponent,
    manifest?: ModuleManifest,
  ): Promise<ModuleBindings> {
    const normalized = normalizeManifest(manifest);
    const wasi = await loadWasiImports();
    const importMap = buildImportMap(name, normalized, prepared.requiredImports, this.#available(name, wasi));
    const bindings = await prepared.instantiate(importMap);
    this.#components.set(name, { bytes: null, manifest: normalized, prepared: { bindings } });
    return bindings;
  }

  instantiate(name: string): number {
    const entry = this.#components.get(name);
    if (!entry) throw new Error(`module not registered: ${name}`);
    const bindings = entry.prepared?.bindings;
    if (!bindings) {
      throw new Error(`module not prepared: ${name}. Call \`await host.prepare('${name}')\` first.`);
    }
    const id = this.#nextId++;
    this.#instances.set(id, { name, bindings });
    return id;
  }

  destroy(id: number): void {
    this.#instances.delete(id);
  }

  #instance(id: number): InstanceEntry {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    const reason = this.#dead.get(inst.bindings);
    if (reason !== undefined) {
      throw new Error(`dead instance ${id}: module '${inst.name}' ${reason}`);
    }
    return inst;
  }

  /**
   * Why instance `id` can no longer run — it (or another instance sharing
   * its component instance) trapped — or `null` while it is usable or
   * unknown. A dead instance refuses every call; replace the component's
   * bindings ({@link instantiatePrepared} / `prepare()`) and instantiate
   * again.
   */
  deathReason(id: number): string | null {
    const inst = this.#instances.get(id);
    if (!inst) return null;
    return this.#dead.get(inst.bindings) ?? null;
  }

  init(id: number, config: Uint8Array): Uint8Array {
    const inst = this.#instance(id);
    return this.#guard(inst, () => inst.bindings.init(config));
  }

  /**
   * Run a guest call. A trap from a module holding the `http` grant in a
   * runtime without synchronous wasi:io/poll (browsers) is almost always a
   * blocked HTTP request: say so instead of a bare "unreachable".
   */
  #guard<T>(inst: InstanceEntry, run: () => T): T {
    try {
      return run();
    } catch (e) {
      if (isTrap(e)) {
        this.#dead.set(inst.bindings, `trapped: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (
        !SYNC_WASI_POLL &&
        e instanceof WebAssembly.RuntimeError &&
        this.#components.get(inst.name)?.manifest.http
      ) {
        throw new Error(
          `module '${inst.name}' trapped (${e.message}). It holds the http grant, and in a ` +
            "browser wasi:http cannot complete inside a synchronous reducer call: the request " +
            "is sent, but preview2-shim's browser wasi:io/poll can only wait asynchronously, so " +
            "a module that blocks on the response traps. Perform HTTP outside the module (an " +
            "effect handled by the app) or run this module on a Node/Bun or native host. The " +
            "component instance may be unusable after a trap.",
          { cause: e },
        );
      }
      throw e;
    }
  }

  #withCallContext(inst: InstanceEntry, siblings: SiblingState[] | undefined, run: () => unknown): ReducerOutput {
    const manifest = this.#components.get(inst.name)?.manifest ?? normalizeManifest(undefined);
    const ctx: CallContext = {
      siblings: new Map((siblings ?? []).map((s) => [s.module, s.state])),
      readsAllowed: manifest.reads,
      dispatchesAllowed: manifest.dispatches,
      crossDispatch: [],
      subscribeRequests: [],
    };
    const prev = this.#activeCall;
    this.#activeCall = ctx;
    let out: unknown;
    try {
      out = this.#guard(inst, run);
    } finally {
      this.#activeCall = prev;
    }
    return reducerOutputFromWit(out, ctx);
  }

  dispatch(id: number, state: Uint8Array, action: ActionMessage, siblings?: SiblingState[]): ReducerOutput {
    const inst = this.#instance(id);
    return this.#withCallContext(inst, siblings, () =>
      inst.bindings.dispatch(state, { name: action.name, payload: action.payload }),
    );
  }

  onActivated(id: number, state: Uint8Array, siblings?: SiblingState[]): ReducerOutput {
    const inst = this.#instance(id);
    return this.#withCallContext(inst, siblings, () => inst.bindings.onActivated(state));
  }

  onDeactivated(id: number, state: Uint8Array): ReducerOutput {
    const inst = this.#instance(id);
    return reducerOutputFromWit(this.#guard(inst, () => inst.bindings.onDeactivated(state)));
  }

  onDestroyed(id: number, state: Uint8Array): void {
    const inst = this.#instance(id);
    this.#guard(inst, () => inst.bindings.onDestroyed(state));
  }

  actions(id: number): string[] {
    return this.#instance(id).bindings.actions();
  }
}
