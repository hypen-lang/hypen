// JS-side implementation of the `JsModuleHost` interface the Rust
// `BridgedHost` calls into. Transpiles registered WASM Component bytes at
// runtime with jco's programmatic API (async `prepare()`), then serves the
// Rust host's synchronous instantiate/init/dispatch calls from the prepared
// bindings.
//
// Method contract (must match `bridged_host.rs::JsModuleHost`):
//   register(name, bytes, manifest)
//   instantiate(name) -> id
//   actions(id) -> string[]
//   destroy(id)
//   init(id, config) -> Uint8Array (new state)
//   dispatch(id, state, action, siblings) -> ReducerOutput
//   onActivated(id, state) -> ReducerOutput
//   onDeactivated(id, state) -> ReducerOutput
//   onDestroyed(id, state)
//
// Plus the JS-only async half:
//   await prepare(name [, bytes, manifest])
//     jco-transpiles the registered component bytes in memory, compiles the
//     emitted core wasm binaries, builds the per-module import map (this is
//     where http egress is gated, see buildImportMap), and instantiates the
//     component. Must complete before `instantiate(name)` — the Rust side
//     calls instantiate/init/dispatch synchronously, so all async work lives
//     here. When `bytes` is given, it registers first (pre-registration), so
//     a later `register()` from the engine with empty bytes is a no-op.
//
// ReducerOutput shape:
//   { state?: Uint8Array, effects: Effect[], emit: Action[],
//     crossDispatch: CD[], subscribeRequests: Sub[] }
//   Effect = { tag: 'log'|'navigate'|'delay', ... }
//   Action = { name: string, payload: Uint8Array }
//   CD     = { module: string, action: Action }
//   Sub    = { module: string, path: string, onChange: string }

import { transpile } from "@bytecodealliance/jco";
import * as preview2CliNs from "@bytecodealliance/preview2-shim/cli";
import * as preview2IoNs from "@bytecodealliance/preview2-shim/io";
import * as preview2ClocksNs from "@bytecodealliance/preview2-shim/clocks";
import * as preview2RandomNs from "@bytecodealliance/preview2-shim/random";
import * as preview2HttpNs from "@bytecodealliance/preview2-shim/http";

// preview2-shim's bundled .d.ts files describe the WASI *interface shapes*,
// not the runtime module exports (environment, stdout, streams, ...), so we
// view the namespaces through a loose record at this boundary.
const preview2Cli = preview2CliNs as unknown as Record<string, unknown>;
const preview2Io = preview2IoNs as unknown as Record<string, unknown>;
const preview2Clocks = preview2ClocksNs as unknown as Record<string, unknown>;
const preview2Random = preview2RandomNs as unknown as Record<string, unknown>;
const preview2Http = preview2HttpNs as unknown as Record<string, unknown>;
import { LocalBucket, CloudBucket } from "./storage.ts";
import type {
  ActionMessage,
  CrossDispatch,
  Effect,
  ModuleBindings,
  ModuleManifest,
  ReducerOutput,
  SiblingState,
  SubscribeRequest,
} from "./types.ts";

// Per-call cross-module context, valid for the duration of one dispatch /
// onActivated. Installed before the reducer runs, drained after — the same
// model as the native WasmtimeHost's per-call fields (sibling_states,
// reads_allowed/dispatches_allowed, xdispatch/subscribe queues).
interface CallContext {
  siblings: Map<string, Uint8Array>;
  readsAllowed: Set<string>;
  dispatchesAllowed: Set<string>;
  crossDispatch: CrossDispatch[];
  subscribeRequests: SubscribeRequest[];
}

let activeCallContext: CallContext | null = null;

function callContext(
  manifest: ModuleManifest | undefined,
  siblings: SiblingState[] | undefined,
): CallContext {
  return {
    siblings: new Map((siblings ?? []).map((s) => [s.module, s.state])),
    readsAllowed: new Set(manifest?.reads ?? []),
    dispatchesAllowed: new Set(manifest?.dispatches ?? []),
    crossDispatch: [],
    subscribeRequests: [],
  };
}

// The `hypen:engine/state` capability import, with the same semantics and
// ACLs as the native host. jco convention: WIT `result<_, error>` errors are
// thrown as the error variant's JS representation ({ tag, val }).
//
// Exported so (a) alternative import maps can reuse it and (b) tests can
// exercise the ACL behavior directly with fake bindings.
export const engineStateImport = {
  read(module: string): Uint8Array {
    const ctx = activeCallContext;
    if (!ctx || !ctx.readsAllowed.has(module)) {
      throw { tag: "permission-denied", val: "reads" };
    }
    const snapshot = ctx.siblings.get(module);
    if (snapshot === undefined) {
      throw { tag: "not-found" };
    }
    return snapshot;
  },
  dispatch(module: string, action: ActionMessage): void {
    const ctx = activeCallContext;
    if (!ctx || !ctx.dispatchesAllowed.has(module)) {
      throw { tag: "permission-denied", val: "dispatches" };
    }
    // Queued, not reentrant: the host folds these into
    // ReducerOutput.crossDispatch after the reducer returns.
    ctx.crossDispatch.push({
      module,
      action: { name: action.name, payload: action.payload },
    });
  },
  subscribe(module: string, path: string, onChange: string): void {
    const ctx = activeCallContext;
    // Observing state is a read: gate on the same `reads` grant.
    if (!ctx || !ctx.readsAllowed.has(module)) {
      throw { tag: "permission-denied", val: "reads" };
    }
    ctx.subscribeRequests.push({ module, path, onChange });
  },
};

// Always-granted imports: Hypen capabilities plus the WASI surface pulled in
// by Rust's stdlib (format!, panic, alloc, rand seeds). http is deliberately
// NOT here — it is granted per-module in buildImportMap.
const baseImports: Record<string, unknown> = {
  "hypen:storage/local":         { Bucket: LocalBucket },
  "hypen:storage/cloud":         { Bucket: CloudBucket },
  "hypen:engine/state":          engineStateImport,
  "wasi:cli/environment":        preview2Cli.environment,
  "wasi:cli/exit":               preview2Cli.exit,
  "wasi:cli/stderr":             preview2Cli.stderr,
  "wasi:cli/stdin":              preview2Cli.stdin,
  "wasi:cli/stdout":             preview2Cli.stdout,
  "wasi:cli/terminal-input":     preview2Cli.terminalInput,
  "wasi:cli/terminal-output":    preview2Cli.terminalOutput,
  "wasi:cli/terminal-stderr":    preview2Cli.terminalStderr,
  "wasi:cli/terminal-stdin":     preview2Cli.terminalStdin,
  "wasi:cli/terminal-stdout":    preview2Cli.terminalStdout,
  "wasi:clocks/monotonic-clock": preview2Clocks.monotonicClock,
  "wasi:clocks/wall-clock":      preview2Clocks.wallClock,
  "wasi:io/error":               preview2Io.error,
  "wasi:io/poll":                preview2Io.poll,
  "wasi:io/streams":             preview2Io.streams,
  "wasi:random/random":          preview2Random.random,
  "wasi:random/insecure":        preview2Random.insecure,
  "wasi:random/insecure-seed":   preview2Random.insecureSeed,
};

// Interfaces only granted when the manifest allows http egress.
const httpImports: Record<string, unknown> = {
  "wasi:http/types":            preview2Http.types,
  "wasi:http/outgoing-handler": preview2Http.outgoingHandler,
};

// Strip a `@0.2.x` version suffix — jco reports required imports with the
// package version, but the emitted instantiate() looks them up unversioned.
const unversioned = (key: string): string => key.replace(/@[^@]*$/, "");

/**
 * Build the per-module import map. This is the browser-style equivalent of
 * the native hosts' link-time wasi:http gate: when the manifest denies http
 * (`http === false`), the wasi:http/* shims are simply withheld from the
 * map, and a component that imports them fails to link with an error naming
 * the missing interface. Absent/true = granted (back-compat with older
 * manifests that predate the http flag).
 */
export function buildImportMap(
  name: string,
  manifest: ModuleManifest | undefined,
  requiredImports: string[] | undefined,
): Record<string, unknown> {
  const httpGranted = manifest?.http !== false;
  const map = httpGranted ? { ...baseImports, ...httpImports } : { ...baseImports };

  const missing = (requiredImports ?? [])
    .map(unversioned)
    .filter((key) => !(key in map));
  if (missing.length > 0) {
    const missingHttp = missing.filter((k) => k.startsWith("wasi:http/"));
    if (missingHttp.length > 0 && !httpGranted) {
      throw new Error(
        `http egress denied for module '${name}': manifest.http is false but ` +
          `the component imports ${missingHttp.join(", ")}`,
      );
    }
    throw new Error(
      `module '${name}' imports interfaces this host does not provide: ${missing.join(", ")}`,
    );
  }
  return map;
}

// Import an in-memory ES module (the jco-emitted bindings JS) without
// touching disk. data: URLs import fine in both node and browsers.
async function importInMemoryModule(sourceBytes: Uint8Array): Promise<any> {
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(sourceBytes).toString("base64");
  } else {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < sourceBytes.length; i += chunk) {
      bin += String.fromCharCode(...sourceBytes.subarray(i, i + chunk));
    }
    b64 = btoa(bin);
  }
  return import(`data:text/javascript;base64,${b64}`);
}

function effectFromWit(e: any): Effect {
  if (e.tag === "log")      return { tag: "log", level: e.val.level, message: e.val.message };
  if (e.tag === "navigate") return { tag: "navigate", path: e.val };
  if (e.tag === "delay")    return { tag: "delay", ms: e.val.ms, then: e.val.then };
  return e;
}

function reducerOutputFromWit(out: any, ctx: CallContext | null = null): ReducerOutput {
  return {
    state: out.state, // already Uint8Array or undefined
    effects: (out.effects ?? []).map(effectFromWit),
    emit: (out.emit ?? []).map((a: any) => ({ name: a.name, payload: a.payload })),
    // Cross-module dispatches + subscribes the reducer queued during this
    // call via the `hypen:engine/state` capability import (see
    // `engineStateImport`). The Rust BridgedHost decodes these into
    // ReducerOutput.{cross_dispatch, subscribe_requests}.
    crossDispatch: ctx?.crossDispatch ?? [],
    subscribeRequests: ctx?.subscribeRequests ?? [],
  };
}

interface ComponentEntry {
  bytes: Uint8Array | null;
  manifest: ModuleManifest | undefined;
  prepared: { bindings: ModuleBindings } | null;
}

interface InstanceEntry {
  name: string;
  bindings: ModuleBindings;
}

export class JsModuleHost {
  #components = new Map<string, ComponentEntry>(); // name -> entry
  #instances = new Map<number, InstanceEntry>();   // id -> instance
  #nextId = 1;

  register(
    name: string,
    bytes: Uint8Array | null | undefined,
    manifest?: ModuleManifest,
  ): void {
    const existing = this.#components.get(name);
    if (existing && (!bytes || bytes.length === 0)) {
      // Re-registration with empty bytes (e.g. the engine registering a
      // module that was pre-registered + prepared on the JS side): keep the
      // prepared bindings, just refresh the manifest if one was supplied.
      // Note the http gate is enforced at prepare() time — link time — like
      // the native hosts; a manifest update after prepare doesn't re-link.
      if (manifest) existing.manifest = manifest;
      return;
    }
    // Fresh bytes invalidate any previously prepared bindings.
    this.#components.set(name, { bytes: bytes ?? null, manifest, prepared: null });
  }

  /**
   * Inject already-instantiated bindings for `name`, skipping the
   * transpile pipeline. Useful for build-time-transpiled components and for
   * tests that drive the host with fake bindings (no wasm involved). The
   * per-call ACL context still comes from `manifest`.
   */
  registerPrepared(
    name: string,
    bindings: ModuleBindings,
    manifest?: ModuleManifest,
  ): void {
    this.#components.set(name, { bytes: null, manifest, prepared: { bindings } });
  }

  /**
   * Async half of the pipeline. Transpiles the registered component bytes
   * with jco, compiles the emitted core wasm binaries, and instantiates the
   * component against the (manifest-gated) import map. After this resolves,
   * the sync `instantiate(name)` works.
   *
   * Optional `bytes`/`manifest` pre-register in one call, for flows where
   * the engine's own register() happens inside a sync Rust call (e.g.
   * WasmHostedEngine.registerAndInstantiate) and thus can't be awaited.
   */
  async prepare(
    name: string,
    bytes?: Uint8Array | null,
    manifest?: ModuleManifest,
  ): Promise<this> {
    if (bytes !== undefined && bytes !== null) {
      this.register(name, bytes, manifest);
    }
    const entry = this.#components.get(name);
    if (!entry) throw new Error(`module not registered: ${name}`);
    if (!entry.bytes || entry.bytes.length === 0) {
      throw new Error(`no component bytes registered for module: ${name}`);
    }

    // 1. Transpile the component bytes in memory. instantiation:'async'
    //    makes jco emit `instantiate(getCoreModule, imports)` instead of
    //    top-level fetch()es of sibling files.
    // `noTypescript` is honored at runtime but missing from jco's
    // TranspileOpts typing, hence the cast.
    const { files, imports: requiredImports } = (await transpile(entry.bytes, {
      name,
      instantiation: "async",
      noTypescript: true,
    } as Parameters<typeof transpile>[1])) as unknown as {
      files: Record<string, Uint8Array>;
      imports: string[];
    };

    // 2. Gate the import map off the manifest (http egress etc.). Throws if
    //    the component needs an interface the manifest denies.
    const importMap = buildImportMap(name, entry.manifest, requiredImports);

    // 3. Compile the emitted core wasm binaries.
    const coreModules = new Map<string, WebAssembly.Module>();
    for (const [file, contents] of Object.entries(files)) {
      if (file.endsWith(".wasm")) {
        coreModules.set(file, await WebAssembly.compile(contents as BufferSource));
      }
    }
    const getCoreModule = (relPath: string): WebAssembly.Module => {
      const mod = coreModules.get(relPath);
      if (!mod) throw new Error(`unknown core module requested by bindings: ${relPath}`);
      return mod;
    };

    // 4. Load the emitted bindings module and instantiate.
    const bindingsJs = files[`${name}.js`];
    if (!bindingsJs) {
      throw new Error(
        `jco transpile produced no ${name}.js (files: ${Object.keys(files).join(", ")})`,
      );
    }
    const { instantiate } = await importInMemoryModule(bindingsJs);
    const bindings: ModuleBindings = await instantiate(getCoreModule, importMap);

    entry.prepared = { bindings };
    return this;
  }

  instantiate(name: string): number {
    const entry = this.#components.get(name);
    if (!entry) {
      throw new Error(`module not registered: ${name}`);
    }
    // The Rust BridgedHost calls this synchronously, so the async
    // transpile+instantiate must already have happened in prepare().
    const bindings = entry.prepared?.bindings;
    if (!bindings) {
      throw new Error(
        `module not prepared: ${name}. Call \`await host.prepare('${name}')\` first.`,
      );
    }
    const id = this.#nextId++;
    this.#instances.set(id, { name, bindings });
    return id;
  }

  destroy(id: number): void {
    this.#instances.delete(id);
  }

  init(id: number, config: Uint8Array): Uint8Array {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    return inst.bindings.init(config); // returns Uint8Array
  }

  dispatch(
    id: number,
    state: Uint8Array,
    action: ActionMessage,
    siblings?: SiblingState[],
  ): ReducerOutput {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    // Install the per-call cross-module context (sibling snapshots + the
    // manifest's ACLs), run the reducer, then drain what it queued — the
    // same flow as the native host.
    const manifest = this.#components.get(inst.name)?.manifest;
    const ctx = callContext(manifest, siblings);
    const prev = activeCallContext;
    activeCallContext = ctx;
    let out: unknown;
    try {
      out = inst.bindings.dispatch(state, {
        name: action.name,
        payload: action.payload,
      });
    } finally {
      activeCallContext = prev;
    }
    return reducerOutputFromWit(out, ctx);
  }

  onActivated(
    id: number,
    state: Uint8Array,
    siblings?: SiblingState[],
  ): ReducerOutput {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    // Same per-call context as dispatch, so an on-activated hook can
    // read/dispatch/subscribe under the same ACLs.
    const manifest = this.#components.get(inst.name)?.manifest;
    const ctx = callContext(manifest, siblings);
    const prev = activeCallContext;
    activeCallContext = ctx;
    let out: unknown;
    try {
      out = inst.bindings.onActivated(state);
    } finally {
      activeCallContext = prev;
    }
    return reducerOutputFromWit(out, ctx);
  }

  onDeactivated(id: number, state: Uint8Array): ReducerOutput {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    return reducerOutputFromWit(inst.bindings.onDeactivated(state));
  }

  onDestroyed(id: number, state: Uint8Array): void {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    inst.bindings.onDestroyed(state);
  }

  actions(id: number): string[] {
    const inst = this.#instances.get(id);
    if (!inst) throw new Error(`dead instance ${id}`);
    return inst.bindings.actions();
  }
}
