/**
 * Running hosted (WASM-component) modules on a server.
 *
 * Two lifetimes:
 *
 * - **`HostedModuleService`** — one per `RemoteServer`. Holds the hosted
 *   module definitions and, per component, the result of the expensive step
 *   (jco transpile + `WebAssembly.compile`), done ONCE in `prepare()`.
 * - **`SessionRuntime`** — one per session. Owns that session's module host:
 *   its own component *instances* (own linear memory) linked against the
 *   storage of the session's owner, its `delay` timers, and crash recovery.
 *
 * Why a host per session and not one shared host: a `JsModuleHost` links a
 * component's imports — `hypen:storage` above all — when it instantiates
 * it, and storage must differ per user. A shared host would also share one
 * wasm instance between users, so one user's trap would kill the module for
 * everyone. Sharing the prepared artifact gets the startup cost down to one
 * transpile per component; a session pays only an instantiation.
 *
 * `@hypen-space/module-host` is an optional peer dependency, imported
 * dynamically the first time an app with hosted modules prepares. Nothing
 * in this file runs for an app without them.
 */

import { readFileSync } from "node:fs";
import type { BaseEngine } from "@hypen-space/core/engine-base";
import {
  isHostedModuleError,
  type HostedModuleEffect,
  type HostedModuleHttpEffect,
  type HostedModuleManifest,
  type ModuleCascadeFailure,
  type ModuleCascadeReport,
  type ModuleHostLike,
} from "@hypen-space/core/types";
import type {
  HostedModuleDefinition,
  HostedModuleFailure,
  HostedModuleFailureKind,
  HostedModuleInstance,
  HostedModuleProvider,
  HostedModuleSession,
  HostedSessionContext,
} from "@hypen-space/core/hosted-module";
import { createLogger } from "@hypen-space/core/logger";
import { assertComponentBytes } from "./define.js";
import { HostedModuleSetupError, isHostedModuleSetupError } from "./errors.js";
import {
  DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS,
  HttpJobQueue,
  performHttpRequest,
  type HostedFetch,
  type HttpEgressPolicy,
  type PerformedHttpRequest,
} from "./http.js";
import {
  HostedStorageOwners,
  type HostedStorageBackend,
  type HostedStorageResolver,
} from "./storage.js";

const log = createLogger("HostedModules");

/** Most `delay` effects one module may have pending per session (the native runtime's bound). */
export const DEFAULT_MAX_PENDING_DELAYS = 1024;

/** `setTimeout` fires immediately past this. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// ── the slice of @hypen-space/module-host this file uses ────────────────────
//
// Declared structurally so `@hypen-space/server`'s types never reference the
// optional package (a consumer without it installed still type-checks).

interface PreparedComponentLike {
  readonly requiredImports: readonly string[];
  readonly componentBytes: number;
  readonly timings: { transpileMs: number; compileMs: number; importMs: number };
}

interface JsModuleHostLike extends ModuleHostLike {
  /** Instantiate a prepared component in this host; resolves to its bindings. */
  instantiatePrepared(
    name: string,
    prepared: PreparedComponentLike,
    manifest?: HostedModuleManifest
  ): Promise<unknown>;
  registerPrepared(name: string, bindings: unknown, manifest?: HostedModuleManifest): void;
  deathReason(id: number): string | null;
}

interface ModuleHostPackage {
  JsModuleHost: new (options: {
    storage: HostedStorageBackend;
    cloudStorage: HostedStorageBackend;
    quotas?: HostedStorageQuotas;
  }) => JsModuleHostLike;
  prepareComponent(name: string, bytes: Uint8Array): Promise<PreparedComponentLike>;
}

const MODULE_HOST_PACKAGE = "@hypen-space/module-host";

function isModuleHostPackage(value: unknown): value is ModuleHostPackage {
  const pkg = value as Partial<ModuleHostPackage> | null;
  return (
    pkg !== null &&
    typeof pkg === "object" &&
    typeof pkg.JsModuleHost === "function" &&
    typeof pkg.prepareComponent === "function"
  );
}

async function importModuleHost(): Promise<unknown> {
  // A variable specifier: bundlers and tsc must not resolve the optional
  // package at build time.
  const specifier = MODULE_HOST_PACKAGE;
  return import(specifier);
}

// ── options ─────────────────────────────────────────────────────────────────

/** Storage quotas of the session hosts (see `@hypen-space/module-host`). */
export interface HostedStorageQuotas {
  /** Largest single value. Default 1 MiB. */
  maxValueBytes?: number;
  /** Budget of one partition (a module's `local`; an owner's `app`; `cloud`). Default 5 MiB. */
  maxPartitionBytes?: number;
}

export interface HostedModulesOptions {
  /**
   * Whose storage a session's modules use. Default: every session owns a
   * private in-memory store. Return `{ key }` to name the owner (sessions
   * with the same key share a store; see `storageDir`), or a backend.
   */
  storage?: HostedStorageResolver;
  /**
   * Persist `{ key }` owners' stores as files in this directory (one per
   * owner, named by a hash of the key). Without it they live in memory.
   */
  storageDir?: string;
  quotas?: HostedStorageQuotas;
  /**
   * Called for every hosted-module failure at run time: a module that could
   * not start on a session, a failing action or lifecycle hook, a refused
   * cross-module call, a crashed instance and its recovery. Without a hook
   * failures are logged (`HostedModules` logger); with one, reporting is
   * the hook's job (alerting, dev diagnostics).
   */
  onError?: (failure: HostedModuleFailure) => void;
  /** Most pending `delay` effects per module per session. Default 1024. */
  maxPendingDelays?: number;
  /**
   * How a hosted module's deferred HTTP requests (`hypen:http/deferred`) are
   * sent: called once per hop with `redirect: "manual"` (the server follows
   * and checks redirects itself). Default: the runtime's `fetch`. Replace it
   * to route through a proxy or agent, to pin DNS, or to fake the network in
   * tests.
   */
  fetch?: HostedFetch;
  /**
   * App-level egress policy for hosted modules' HTTP requests, evaluated
   * before each request and each redirect hop — after the module's own
   * `httpHosts` and the private-network rule (`privateNetwork`) let it
   * through. Return `"allow"`, or `{ deny: "<reason>" }` to complete the
   * request to the module as `denied`. It can only narrow.
   */
  onHttpRequest?: HttpEgressPolicy;
  /**
   * What happens to a request whose URL points into the server's own
   * network: a loopback, link-local, private or unspecified IP literal, or
   * `localhost`.
   *
   * - `"block"` (default): refused (`denied`) unless the module's
   *   `httpHosts` names that host explicitly (an exact entry such as
   *   `"127.0.0.1:8080"` or `"localhost"` — a wildcard does not count). A
   *   hosted, possibly third-party module must not reach the machine's
   *   metadata service or internal services just because it was granted
   *   `http`.
   * - `"allow"`: no such rule — what `hypen-runtime` does on a developer's
   *   machine. Only for servers whose modules are all first-party.
   *
   * The rule reads the URL, not DNS: a public name that resolves to a
   * private address is not caught. Pin resolution in `fetch` if modules are
   * untrusted.
   */
  privateNetwork?: "block" | "allow";
  /** Most deferred HTTP exchanges in progress per session; the rest wait in order. Default 8. */
  maxConcurrentHttpRequests?: number;
  /** @internal Tests: stand in for `import("@hypen-space/module-host")`. */
  loadModuleHost?: () => Promise<unknown>;
}

/** What a hot reload of one hosted module did. */
export interface HostedReloadResult {
  module: string;
  /** Live sessions that have the module mounted. */
  sessions: number;
  /** Of those, sessions now running the new component with their state kept. */
  reloaded: number;
  /** Sessions where the new component rejected the old state and was re-initialised. */
  stateReset: number;
  /** Sessions that kept the previous instance because the new one could not replace it. */
  kept: number;
  /** Sessions the module could not be brought back on at all (see the reported failures). */
  failed: number;
}

/** One hosted module, ready to instantiate. */
interface PreparedEntry {
  definition: HostedModuleDefinition;
  scope: string;
  prepared: PreparedComponentLike;
  manifest: HostedModuleManifest;
}

const scopeOf = (definition: HostedModuleDefinition): string => definition.name.toLowerCase();

function manifestOf(definition: HostedModuleDefinition): HostedModuleManifest {
  const { grants } = definition.hosted;
  return {
    name: scopeOf(definition),
    version: "0.0.0",
    storage: ["local", ...grants.storage],
    reads: [...grants.reads],
    dispatches: [...grants.dispatches],
    http: grants.http,
    // Only when narrowed: an older module host ignores a key it does not know.
    ...(grants.httpHosts.length > 0 ? { httpHosts: [...grants.httpHosts] } : {}),
  };
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

/** The import a component makes that needs a grant, and which. */
function grantFor(importName: string): { field: "storage" | "http"; value: string } | null {
  if (importName === "hypen:storage/app") return { field: "storage", value: "app" };
  if (importName === "hypen:storage/cloud") return { field: "storage", value: "cloud" };
  if (importName === "hypen:http/deferred" || importName.startsWith("wasi:http/")) {
    return { field: "http", value: "true" };
  }
  return null;
}

// ── the service ─────────────────────────────────────────────────────────────

export class HostedModuleService implements HostedModuleProvider {
  private options: HostedModulesOptions;
  private owners: HostedStorageOwners;
  private definitions = new Map<string, HostedModuleDefinition>();
  private entries = new Map<string, PreparedEntry>();
  private pkg: ModuleHostPackage | null = null;
  private readonly sessions = new Set<SessionRuntime>();

  constructor(options: HostedModulesOptions = {}) {
    this.options = options;
    this.owners = new HostedStorageOwners(options);
  }

  /** Replace the options. Storage owners start over (their stores are per option set). */
  configure(options: HostedModulesOptions): void {
    this.options = { ...this.options, ...options };
    this.owners = new HostedStorageOwners(this.options);
  }

  /** Add (or replace, by scope) hosted module definitions. */
  define(definitions: Iterable<HostedModuleDefinition>): void {
    for (const definition of definitions) this.definitions.set(scopeOf(definition), definition);
  }

  /** Every hosted module of the app, in declaration order. */
  list(): HostedModuleDefinition[] {
    return [...this.definitions.values()];
  }

  get(name: string): HostedModuleDefinition | undefined {
    return this.definitions.get(name.toLowerCase());
  }

  get size(): number {
    return this.definitions.size;
  }

  /** Sessions currently running hosted modules. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** @internal What the session runtimes perform deferred HTTP requests with. */
  get http(): {
    fetch: HostedFetch;
    policy: HttpEgressPolicy | undefined;
    privateNetwork: "block" | "allow";
    maxConcurrent: number;
  } {
    const { fetch: custom, onHttpRequest, privateNetwork, maxConcurrentHttpRequests: max } = this.options;
    return {
      // Looked up per request: a test (or an instrumentation library) that
      // replaces `globalThis.fetch` after startup is honoured.
      fetch:
        custom ??
        ((url, init) => globalThis.fetch(url, { ...init, body: init.body as Uint8Array<ArrayBuffer> | null })),
      policy: onHttpRequest,
      privateNetwork: privateNetwork === "allow" ? "allow" : "block",
      maxConcurrent:
        typeof max === "number" && max >= 1 ? Math.floor(max) : DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS,
    };
  }

  get maxPendingDelays(): number {
    const max = this.options.maxPendingDelays;
    return typeof max === "number" && max >= 0 ? Math.floor(max) : DEFAULT_MAX_PENDING_DELAYS;
  }

  /**
   * The one-time, slow half: load `@hypen-space/module-host`, check the
   * engine build, and transpile + compile every component not prepared yet.
   *
   * @throws {HostedModuleSetupError} naming the module, file and field.
   */
  async prepare(createEngine: () => BaseEngine): Promise<void> {
    if (this.definitions.size === 0) return;
    const names = this.list().map((d) => d.name).join(", ");

    const probe = createEngine();
    await probe.init();
    if (!probe.supportsHostedModules) {
      throw new HostedModuleSetupError(
        `This app has hosted (WASM) modules (${names}), but the engine build in use has no ` +
          "hosted-module support.",
        {
          code: "ENGINE_UNSUPPORTED",
          hint:
            "use the server engine build (@hypen-space/server's wasm-node, built with the " +
            "`module-loader-bridged` feature: `cd hypen-engine-rs && ./build-wasm.sh`). The browser " +
            "build (@hypen-space/web-engine) cannot run hosted modules.",
        }
      );
    }

    const pkg = await this.loadPackage(names);
    for (const definition of this.definitions.values()) {
      const scope = scopeOf(definition);
      if (this.entries.get(scope)?.definition === definition) continue;
      this.entries.set(scope, await this.prepareOne(pkg, definition));
    }
    for (const scope of this.entries.keys()) {
      if (!this.definitions.has(scope)) this.entries.delete(scope);
    }
  }

  private async loadPackage(names: string): Promise<ModuleHostPackage> {
    if (this.pkg) return this.pkg;
    let loaded: unknown;
    try {
      loaded = await (this.options.loadModuleHost ?? importModuleHost)();
    } catch (cause) {
      throw new HostedModuleSetupError(
        `This app has hosted (WASM) modules (${names}), which need the optional package ` +
          `${MODULE_HOST_PACKAGE} — it could not be loaded: ${errorMessage(cause)}`,
        {
          code: "MODULE_HOST_MISSING",
          hint: `install ${MODULE_HOST_PACKAGE}: \`bun add ${MODULE_HOST_PACKAGE}\` (or \`npm install ${MODULE_HOST_PACKAGE}\`)`,
          cause,
        }
      );
    }
    if (!isModuleHostPackage(loaded)) {
      throw new HostedModuleSetupError(
        `The installed ${MODULE_HOST_PACKAGE} is too old for this @hypen-space/server ` +
          "(it has no `prepareComponent`).",
        { code: "MODULE_HOST_MISSING", hint: `update ${MODULE_HOST_PACKAGE} to the version of @hypen-space/server` }
      );
    }
    this.pkg = loaded;
    return loaded;
  }

  private async loadBytes(definition: HostedModuleDefinition): Promise<Uint8Array> {
    const { component, declaredAt } = definition.hosted;
    const field = `${declaredAt}.component`;
    switch (component.kind) {
      case "bytes":
        return component.bytes;
      case "file":
        try {
          return new Uint8Array(readFileSync(component.path));
        } catch (cause) {
          throw new HostedModuleSetupError(
            `The component of hosted module "${definition.name}" could not be read: ${component.path}`,
            {
              code: "COMPONENT_MISSING",
              module: definition.name,
              file: component.path,
              field,
              hint: "build the module (or copy its .wasm there), or fix the path",
              cause,
            }
          );
        }
      case "url": {
        const failed = (why: string, cause?: unknown): HostedModuleSetupError =>
          new HostedModuleSetupError(
            `The component of hosted module "${definition.name}" could not be downloaded from ${component.url}: ${why}`,
            {
              code: "COMPONENT_FETCH_FAILED",
              module: definition.name,
              file: component.url,
              field,
              hint: "check the URL and that this server can reach it, or ship the .wasm with the app",
              cause,
            }
          );
        let response: Response;
        try {
          response = await fetch(component.url);
        } catch (cause) {
          throw failed(errorMessage(cause), cause);
        }
        if (!response.ok) throw failed(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }
    }
  }

  private async prepareOne(pkg: ModuleHostPackage, definition: HostedModuleDefinition): Promise<PreparedEntry> {
    const scope = scopeOf(definition);
    const { component, declaredAt, grantsAt, grants } = definition.hosted;
    const file = component.kind === "file" ? component.path : component.kind === "url" ? component.url : undefined;
    const bytes = await this.loadBytes(definition);
    // A file can change between `wasmModule()` and here (a rebuild in
    // progress); a URL was never checked.
    assertComponentBytes(bytes.subarray(0, 8), definition.name, { file, field: `${declaredAt}.component` });

    let prepared: PreparedComponentLike;
    try {
      prepared = await pkg.prepareComponent(scope, bytes);
    } catch (cause) {
      throw new HostedModuleSetupError(
        `Hosted module "${definition.name}" could not be prepared: ${errorMessage(cause)}`,
        {
          code: "PREPARE_FAILED",
          module: definition.name,
          file,
          field: `${declaredAt}.component`,
          hint:
            "the file must be a `hypen:module` Component (wasm32-wasip2 for Rust, or " +
            "`hypen build --target wasm`); a truncated or foreign component fails here",
          cause,
        }
      );
    }

    // Link-time grants, checked here so a missing one stops the server at
    // startup with the field to edit — not every session at connect time.
    for (const required of prepared.requiredImports) {
      const grant = grantFor(required);
      if (grant === null) continue;
      const granted = grant.field === "http" ? grants.http : grants.storage.includes(grant.value as "app" | "cloud");
      if (granted) continue;
      throw new HostedModuleSetupError(
        `Hosted module "${definition.name}" imports ${required}, which it has not been granted.`,
        {
          code: "UNGRANTED_IMPORT",
          module: definition.name,
          file,
          field: `${grantsAt}.${grant.field}`,
          hint:
            grant.field === "http"
              ? `grant outbound HTTP: set ${grantsAt}.http to true — or use a build of the module that does not import ${required.startsWith("wasi:http/") ? "wasi:http" : required}`
              : `grant the "${grant.value}" storage tier: add "${grant.value}" to ${grantsAt}.storage`,
        }
      );
    }

    const manifest = manifestOf(definition);
    // Trial instantiation in a throwaway host: whatever else cannot link
    // (an interface this host does not provide, e.g. a CM-async 0.2 module)
    // fails now, once, with the module's name.
    try {
      const scratch = new pkg.JsModuleHost({
        storage: new ScratchStorage(),
        cloudStorage: new ScratchStorage(),
      });
      await scratch.instantiatePrepared(scope, prepared, manifest);
    } catch (cause) {
      throw new HostedModuleSetupError(
        `Hosted module "${definition.name}" cannot be instantiated: ${errorMessage(cause)}`,
        {
          code: "PREPARE_FAILED",
          module: definition.name,
          file,
          field: `${declaredAt}.component`,
          hint:
            "the JS module host runs `hypen:module@0.1` (sync) components; a CM-async (0.2) module " +
            "or one importing other interfaces needs the native runtime (`hypen-runtime`)",
          cause,
        }
      );
    }
    return { definition, scope, prepared, manifest };
  }

  /** @internal */
  entry(scope: string): PreparedEntry | undefined {
    return this.entries.get(scope);
  }

  /** @internal */
  entriesList(): PreparedEntry[] {
    return [...this.entries.values()];
  }

  /** @internal */
  emit(failure: HostedModuleFailure): void {
    const hook = this.options.onError;
    if (!hook) {
      // Nobody is listening: the log is the only place it can go.
      const where = failure.sessionId ? ` (session ${failure.sessionId})` : "";
      const line = `[${failure.module}] ${failure.kind}${failure.action ? ` "${failure.action}"` : ""}: ${failure.message}${where}`;
      // A failed request is the outside world's doing, and the module was told.
      if (failure.kind === "recovered" || failure.kind === "http") {
        log.warn(failure.hint ? `${line}\n  Hint: ${failure.hint}` : line);
      } else log.error(failure.hint ? `${line}\n  Hint: ${failure.hint}` : line);
      return;
    }
    try {
      hook(failure);
    } catch (err) {
      log.error("hostedModules({ onError }) threw:", err);
    }
  }

  async openSession(context: HostedSessionContext): Promise<HostedModuleSession> {
    const names = this.list().map((d) => d.name).join(", ");
    if (!this.pkg) {
      throw new HostedModuleSetupError(
        `Hosted modules (${names}) are not prepared.`,
        { code: "PREPARE_FAILED", hint: "call `await server.prepare()` (or `.listen()`) before creating sessions" }
      );
    }
    if (!context.engine.supportsHostedModules) {
      throw new HostedModuleSetupError(
        `The session's engine has no hosted-module support, but the app has hosted modules (${names}).`,
        { code: "ENGINE_UNSUPPORTED", hint: "create sessions with @hypen-space/server's Engine" }
      );
    }
    const backends = this.owners.for(context.session);
    const host = new this.pkg.JsModuleHost({
      storage: backends.storage,
      cloudStorage: backends.cloudStorage,
      ...(this.options.quotas ? { quotas: this.options.quotas } : {}),
    });
    const runtime = new SessionRuntime(this, context, host);
    await runtime.start();
    this.sessions.add(runtime);
    return runtime;
  }

  /** @internal */
  closed(runtime: SessionRuntime): void {
    this.sessions.delete(runtime);
  }

  /**
   * Hot reload: prepare `definition`'s (new) component and swap it into
   * every live session, keeping each session's module state when the new
   * component accepts it.
   *
   * Throws — changing nothing, every session keeps the instance it has —
   * when the new component cannot be prepared or lacks a grant.
   */
  async reload(definition: HostedModuleDefinition): Promise<HostedReloadResult> {
    const scope = scopeOf(definition);
    if (!this.definitions.has(scope)) {
      throw new HostedModuleSetupError(
        `No hosted module named "${definition.name}" to reload (hosted modules: ${
          this.list().map((d) => d.name).join(", ") || "none"
        }).`,
        { code: "UNKNOWN_MODULE", module: definition.name, hint: "register it with RemoteServer.wasmModules() first" }
      );
    }
    const pkg = await this.loadPackage(definition.name);
    const previous = this.entries.get(scope);
    const next = await this.prepareOne(pkg, definition);
    this.definitions.set(scope, definition);
    this.entries.set(scope, next);

    const result: HostedReloadResult = {
      module: definition.name,
      sessions: 0,
      reloaded: 0,
      stateReset: 0,
      kept: 0,
      failed: 0,
    };
    for (const runtime of [...this.sessions]) {
      const outcome = await runtime.reloadModule(next, previous);
      if (outcome === "notMounted") continue;
      result.sessions += 1;
      result[outcome] += 1;
    }
    return result;
  }
}

/** Storage for the throwaway host of the prepare-time trial instantiation. */
class ScratchStorage implements HostedStorageBackend {
  private readonly data = new Map<string, Uint8Array>();
  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  set(key: string, value: Uint8Array): void {
    this.data.set(key, value);
  }
  delete(key: string): boolean {
    return this.data.delete(key);
  }
  keys(): Iterable<string> {
    return Array.from(this.data.keys());
  }
}

// ── one session ─────────────────────────────────────────────────────────────

type ReloadOutcome = "reloaded" | "stateReset" | "kept" | "failed" | "notMounted";

/** The mirrored state of one hosted scope: what its reducer last returned. */
interface MirroredState {
  bytes: Uint8Array;
  decoded?: Record<string, unknown> | null;
}

const decoder = new TextDecoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class SessionRuntime implements HostedModuleSession {
  private readonly engine: BaseEngine;
  /** Mounted modules by scope. */
  private readonly instances = new Map<string, MountedModule>();
  /** Host instance id → scope (every component is registered under its scope). */
  private readonly idScope = new Map<number, string>();
  /** The bindings each scope's component currently has in the host. */
  private readonly bindings = new Map<string, unknown>();
  /** Modules that could not be instantiated on this session, with why. */
  private readonly linkFailures = new Map<string, unknown>();
  private readonly mirror = new Map<string, MirroredState>();
  /** Scopes whose instance trapped, with what killed it. */
  private readonly crashed = new Map<string, string>();
  private readonly timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  /** Deferred HTTP requests handed to this session and not completed yet, by engine id. */
  private readonly httpPending = new Map<number, { scope: string; abort: AbortController }>();
  private httpQueue: HttpJobQueue | null = null;
  private readonly notifyQueued = new Set<string>();
  /** A host call failed and no thrown error has accounted for it yet. */
  private unreportedFailure = false;
  private sweepQueued = false;
  /** > 0 while recovery / reload tears an instance down on purpose. */
  private quiet = 0;
  private recovering: Promise<void> | null = null;
  private isClosed = false;

  constructor(
    private readonly service: HostedModuleService,
    private readonly context: HostedSessionContext,
    private readonly host: JsModuleHostLike
  ) {
    this.engine = context.engine;
  }

  get sessionId(): string {
    return this.context.session.id;
  }

  /** Instantiate every prepared component in this session's host and install it. */
  async start(): Promise<void> {
    for (const entry of this.service.entriesList()) {
      try {
        this.bindings.set(entry.scope, await this.host.instantiatePrepared(entry.scope, entry.prepared, entry.manifest));
      } catch (err) {
        this.linkFailures.set(entry.scope, err);
      }
    }
    this.engine.setModuleHost(this.hostFacade());
    this.engine.setModuleEffectHandler((scope, effect) => this.onEffect(scope, effect));
  }

  // ── the host the engine drives ────────────────────────────────────────────

  /**
   * The session's `JsModuleHost` behind a facade that watches what goes by:
   * the state each reducer returns (mirrored, so app code can read a hosted
   * module's state from inside an action handler, where the engine cannot
   * be called), and failures (a trap marks the scope crashed).
   */
  private hostFacade(): ModuleHostLike {
    const host = this.host;
    return {
      register: (name, bytes, manifest) => host.register(name, bytes, manifest),
      instantiate: (name) => {
        const id = host.instantiate(name);
        this.idScope.set(id, name);
        return id;
      },
      destroy: (id) => {
        this.idScope.delete(id);
        host.destroy(id);
      },
      init: (id, config) =>
        this.guarded(id, () => {
          const state = host.init(id, config);
          this.noteState(id, state);
          return state;
        }),
      dispatch: (id, state, action, siblings) =>
        this.guarded(id, () => this.noteOutput(id, host.dispatch(id, state, action, siblings))),
      onActivated: (id, state, siblings) =>
        this.guarded(id, () => this.noteOutput(id, host.onActivated(id, state, siblings))),
      onDeactivated: (id, state) => this.guarded(id, () => this.noteOutput(id, host.onDeactivated(id, state))),
      onDestroyed: (id, state) => this.guarded(id, () => host.onDestroyed(id, state)),
      actions: (id) => this.guarded(id, () => host.actions(id)),
    };
  }

  private guarded<T>(id: number, call: () => T): T {
    try {
      return call();
    } catch (err) {
      if (this.quiet === 0) {
        const scope = this.idScope.get(id);
        const reason = this.host.deathReason(id);
        if (scope !== undefined && reason !== null) this.markCrashed(scope, reason);
        this.unreportedFailure = true;
        this.queueSweep();
      }
      throw err;
    }
  }

  private noteOutput<T>(id: number, output: T): T {
    const state = (output as { state?: unknown } | null | undefined)?.state;
    if (state instanceof Uint8Array) this.noteState(id, state);
    return output;
  }

  private noteState(id: number, bytes: Uint8Array): void {
    const scope = this.idScope.get(id);
    if (scope === undefined) return;
    this.mirror.set(scope, { bytes });
    if (this.notifyQueued.has(scope)) return;
    this.notifyQueued.add(scope);
    queueMicrotask(() => {
      this.notifyQueued.delete(scope);
      this.instances.get(scope)?.stateChanged();
    });
  }

  /**
   * The current state of `scope`: the engine's when it can be asked, else
   * (the caller is inside an engine callback — an action handler reached by
   * a dispatch) what the module's reducer last returned.
   */
  stateOf(scope: string): Record<string, unknown> {
    if (!this.isClosed) {
      try {
        const state = this.engine.getModuleState(scope);
        if (isPlainObject(state)) return state;
      } catch {
        // Re-entrant: fall through to the mirror.
      }
    }
    const mirrored = this.mirror.get(scope);
    if (!mirrored) return {};
    if (mirrored.decoded === undefined) {
      try {
        const parsed: unknown = JSON.parse(decoder.decode(mirrored.bytes));
        mirrored.decoded = isPlainObject(parsed) ? parsed : null;
      } catch {
        mirrored.decoded = null;
      }
    }
    return mirrored.decoded ? structuredClone(mirrored.decoded) : {};
  }

  // ── failures ──────────────────────────────────────────────────────────────

  private definitionOf(scope: string): HostedModuleDefinition | undefined {
    return this.instances.get(scope)?.definition ?? this.service.get(scope);
  }

  private nameOf(scope: string): string {
    return this.definitionOf(scope)?.name ?? scope;
  }

  /** Deliver a failure after the engine call in progress (if any) returns. */
  emit(failure: Omit<HostedModuleFailure, "module" | "sessionId">): void {
    const full: HostedModuleFailure = { ...failure, module: this.nameOf(failure.scope), sessionId: this.sessionId };
    queueMicrotask(() => this.service.emit(full));
  }

  private markCrashed(scope: string, reason: string): void {
    if (this.crashed.has(scope)) return;
    this.crashed.set(scope, reason);
    this.emit({
      kind: "crash",
      scope,
      message: `the module's instance ${reason}; it is dead until re-instantiated`,
      hint: "it is re-instantiated — with its state reset to what `init` returns — on its next use",
    });
  }

  /**
   * A host call failed inside a cascade that throws nothing (the subscriber
   * notifications of an in-process state write): pick its report up once
   * the engine call has returned.
   */
  private queueSweep(): void {
    if (this.sweepQueued) return;
    this.sweepQueued = true;
    queueMicrotask(() => {
      this.sweepQueued = false;
      if (!this.unreportedFailure || this.isClosed) return;
      this.unreportedFailure = false;
      let report: ModuleCascadeReport | null = null;
      try {
        report = this.engine.lastModuleCascadeReport();
      } catch {
        return;
      }
      if (report) this.emitReport(report, report.rootFailed ? "action" : "cascade", undefined);
    });
  }

  /** What grant a refused cross-module call was missing, and whose it is. */
  private missingGrantOf(
    failure: ModuleCascadeFailure
  ): { scope: string; field: "reads" | "dispatches"; value: string } | null {
    const { cause, origin } = failure;
    if (cause.code === "dispatchDenied") {
      return {
        scope: origin.kind === "crossDispatch" ? origin.from : failure.scope,
        field: "dispatches",
        value: cause.missingGrant,
      };
    }
    if (cause.code === "readDenied") {
      return { scope: failure.scope, field: "reads", value: cause.missingGrant };
    }
    return null;
  }

  private emitReport(report: ModuleCascadeReport, kind: HostedModuleFailureKind, action: string | undefined): void {
    const failures = report.failures.length > 0 ? report.failures : null;
    const root = report.root;
    const rootAction = action ?? (root.kind === "dispatch" ? root.action : undefined);
    if (!failures) {
      this.emit({ kind, scope: root.scope, action: rootAction, message: report.message, report });
      return;
    }
    // One failure per report: the first refusal that names a missing grant
    // is the one a developer can act on; otherwise the first failure.
    const denied = failures.map((f) => ({ f, grant: this.missingGrantOf(f) })).find((x) => x.grant !== null);
    const first = denied?.f ?? failures[0]!;
    const grant = denied?.grant ?? null;
    let hint: string | undefined;
    let missingGrant: HostedModuleFailure["missingGrant"];
    if (grant) {
      const at = this.definitionOf(grant.scope)?.hosted.grantsAt ?? `the grants of "${grant.scope}"`;
      missingGrant = { field: grant.field, value: grant.value };
      hint = `"${this.nameOf(grant.scope)}" may not ${grant.field === "reads" ? "read" : "dispatch to"} "${grant.value}": add "${grant.value}" to ${at}.${grant.field}`;
    } else if (first.cause.code === "host" && this.guestHttpRefusalHint(first.scope, first.cause.host.message)) {
      // The module's own `context.http` call was refused and it did not
      // catch the error: the action failed with the refusal as its message.
      ({ hint, missingGrant } = this.guestHttpRefusalHint(first.scope, first.cause.host.message)!);
    } else if (first.cause.code === "host" && /permission[-_ ]?denied/i.test(first.cause.host.message)) {
      // The module host refused before the engine was asked; modules
      // usually pass the host's `permission-denied(<grant>)` on verbatim.
      const at = this.definitionOf(first.scope)?.hosted.grantsAt ?? `the grants of "${first.scope}"`;
      const which = /permission[-_ ]?denied\W*(reads|dispatches)/i.exec(first.cause.host.message)?.[1]?.toLowerCase();
      hint =
        which === "reads" || which === "dispatches"
          ? `"${this.nameOf(first.scope)}" tried to ${which === "reads" ? "read (or subscribe to)" : "dispatch to"} a module it has no grant for: add that module to ${at}.${which}`
          : `"${this.nameOf(first.scope)}" called a module it has no grant for: list the target under ${at}.reads (to read / subscribe) or ${at}.dispatches (to dispatch)`;
    } else if (first.cause.code === "notAccepted") {
      hint =
        first.origin.kind === "httpRequest"
          ? `"${this.nameOf(first.scope)}" queued an HTTP request whose completion action "${first.action}" it does not handle: \`then\` must name one of the module's own actions`
          : `"${this.nameOf(first.scope)}" does not list the action "${first.action}"; check the action name`;
    } else {
      const http = this.httpRefusalHint(first);
      if (http) ({ hint, missingGrant } = http);
    }
    const more = report.failureCount > 1 ? ` (+${report.failureCount - 1} more)` : "";
    this.emit({
      kind: this.crashed.has(first.scope) ? "crash" : kind,
      scope: denied ? (grant?.scope ?? first.scope) : first.scope,
      action: rootAction,
      message: `${first.message}${more}`,
      ...(hint !== undefined ? { hint } : {}),
      ...(missingGrant ? { missingGrant } : {}),
      report,
    });
  }

  /**
   * The hint for a deferred HTTP request the engine refused at admission
   * (`httpNotGranted` / `httpDenied` / `httpInvalid` / `httpLimit` /
   * `httpUnavailable`), naming the field to change. The module host answers
   * most of these at `send` already (the module sees the error and nothing
   * reaches the engine); these are what is left — the in-flight cap, and a
   * host that did not check.
   */
  private httpRefusalHint(
    failure: ModuleCascadeFailure
  ): { hint: string; missingGrant?: HostedModuleFailure["missingGrant"] } | null {
    const { cause } = failure;
    const name = this.nameOf(failure.scope);
    const at = this.definitionOf(failure.scope)?.hosted.grantsAt ?? `the grants of "${failure.scope}"`;
    switch (cause.code) {
      case "httpNotGranted":
        return {
          hint: `"${name}" has no \`http\` grant: set ${at}.http to true`,
          missingGrant: { field: "http", value: "true" },
        };
      case "httpDenied":
        return {
          hint: `"${name}" may not reach "${cause.host}": add it to ${at}.httpHosts (or remove httpHosts to allow any host)`,
          missingGrant: { field: "httpHosts", value: cause.host },
        };
      case "httpInvalid":
        return { hint: `"${name}" queued a request the engine cannot send: ${cause.detail}` };
      case "httpLimit":
        return {
          hint:
            cause.per === "module"
              ? `"${name}" already has ${cause.limit} requests in flight: wait for completions before queueing more (the cap is engine.setModuleHttpInFlightLimit)`
              : `"${name}" queued more than ${cause.limit} requests from one action: spread them over several actions`,
        };
      case "httpUnavailable":
        return { hint: "this engine has no effect handler installed, so nothing can perform HTTP requests" };
      default:
        return null;
    }
  }

  /**
   * The hint for an action that failed because the module let a refused
   * `hypen:http/deferred.send` escape — recognised by the host's wording
   * (`DeferredHttpQueue` / the TS shim's `context.http`), which modules
   * usually pass on verbatim. `null` when the message is about something else.
   */
  private guestHttpRefusalHint(
    scope: string,
    message: string
  ): { hint: string; missingGrant?: HostedModuleFailure["missingGrant"] } | null {
    const name = this.nameOf(scope);
    const at = this.definitionOf(scope)?.hosted.grantsAt ?? `the grants of "${scope}"`;
    const host = /host '([^']+)' is not in the manifest's `httpHosts` allowlist/.exec(message)?.[1];
    if (host !== undefined) {
      return {
        hint: `"${name}" may not reach "${host}": add it to ${at}.httpHosts (or remove httpHosts to allow any host)`,
        missingGrant: { field: "httpHosts", value: host },
      };
    }
    if (/has no `http` grant|does not grant `http`/.test(message)) {
      return {
        hint:
          `"${name}" was built without the \`http\` grant: set ${at}.http to true where the module is built ` +
          "and rebuild it (the grant decides whether the component imports hypen:http/deferred), and grant it here too",
        missingGrant: { field: "http", value: "true" },
      };
    }
    return null;
  }

  /** Turn something an engine call threw into a reported failure. */
  private reportThrown(
    err: unknown,
    fallback: { kind: HostedModuleFailureKind; scope: string; action?: string }
  ): void {
    this.unreportedFailure = false;
    if (isHostedModuleError(err)) {
      if (err.report) {
        const kind = err.code === "cascadeIncomplete" ? "cascade" : fallback.kind;
        this.emitReport(err.report, kind, fallback.action);
        return;
      }
      let hint: string | undefined;
      if (err.code === "engineReentrancy") {
        hint = "this is a bug in the host integration: an engine call was made from inside an engine callback";
      } else if (err.code === "actionNotAccepted") {
        hint = `"${this.nameOf(err.scope ?? fallback.scope)}" does not list that action; check the action name`;
      }
      this.emit({
        kind: fallback.kind,
        scope: err.scope ?? fallback.scope,
        action: fallback.action,
        message: err.message,
        ...(hint !== undefined ? { hint } : {}),
        cause: err,
      });
      return;
    }
    this.emit({ ...fallback, message: errorMessage(err), cause: err });
  }

  report(error: unknown, during: { action?: string }): boolean {
    if (!isHostedModuleError(error)) return false;
    // `__hypen_scoped:<scope>:<name>` → the action as the module knows it.
    const scoped = /^__hypen_scoped:([^:]+):(.+)$/.exec(during.action ?? "");
    this.reportThrown(error, {
      kind: "action",
      scope: error.scope ?? scoped?.[1] ?? "",
      action: scoped?.[2] ?? during.action,
    });
    return true;
  }

  // ── effects ───────────────────────────────────────────────────────────────

  /** Runs inside the engine call that produced the effect: never call the engine here. */
  private onEffect(scope: string, effect: HostedModuleEffect): void {
    if (this.isClosed) return;
    if (effect.type === "navigate") {
      const path = effect.path;
      queueMicrotask(() => {
        if (this.isClosed) return;
        let navigated = false;
        try {
          navigated = this.context.navigate(path);
        } catch (err) {
          this.emit({ kind: "effect", scope, message: `navigate to "${path}" failed: ${errorMessage(err)}`, cause: err });
          return;
        }
        if (!navigated) {
          this.emit({
            kind: "effect",
            scope,
            message: `the module asked to navigate to "${path}", but the app has no router`,
            hint: "add a `Router { Route(path: ...) { ... } }` to the app's template",
          });
        }
      });
      return;
    }
    if (effect.type === "http") {
      this.queueHttp(scope, effect);
      return;
    }
    const pending = this.timers.get(scope) ?? new Set<ReturnType<typeof setTimeout>>();
    this.timers.set(scope, pending);
    const max = this.service.maxPendingDelays;
    if (pending.size >= max) {
      this.emit({
        kind: "effect",
        scope,
        action: effect.then,
        message: `delay effect dropped: the module already has ${max} pending delays`,
        hint: "a module that re-arms a delay on every action needs to coalesce them",
      });
      return;
    }
    const then = effect.then;
    const ms = Math.min(Math.max(0, Number(effect.ms) || 0), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      pending.delete(timer);
      // Fire-and-forget: the failure, if any, was reported by `dispatch`.
      void this.dispatch(scope, then, null).catch(() => {});
    }, ms);
    pending.add(timer);
  }

  // ── deferred HTTP ─────────────────────────────────────────────────────────

  /**
   * Take a request the engine admitted. Runs inside the engine call that
   * produced the effect: it only queues. The exchange starts in a later
   * microtask (at most `maxConcurrentHttpRequests` at a time, in order) and
   * its completion is delivered from a later turn still.
   */
  private queueHttp(scope: string, effect: HostedModuleHttpEffect): void {
    const settings = this.service.http;
    this.httpQueue ??= new HttpJobQueue(settings.maxConcurrent);
    const abort = new AbortController();
    this.httpPending.set(effect.id, { scope, abort });
    this.httpQueue.push(async () => {
      const performed = await performHttpRequest(effect, {
        fetch: settings.fetch,
        module: this.nameOf(scope),
        scope,
        sessionId: this.sessionId,
        privateNetwork: settings.privateNetwork,
        ...(settings.policy ? { policy: settings.policy } : {}),
        redirectAllowed: (url) => !this.isClosed && this.engine.httpRedirectAllowed(effect.id, url),
        signal: abort.signal,
      });
      await this.completeHttp(scope, effect, performed, abort.signal.aborted);
    });
  }

  /** Report how a request ended to the engine, which runs the module's completion action. */
  private async completeHttp(
    scope: string,
    effect: HostedModuleHttpEffect,
    performed: PerformedHttpRequest,
    aborted: boolean
  ): Promise<void> {
    this.httpPending.delete(effect.id);
    // The session is gone and its engine with it: nobody to tell.
    if (this.isClosed) return;
    await this.recover();
    if (this.isClosed) return;
    let delivered = false;
    try {
      delivered = this.engine.completeHttpRequest(effect.id, performed.result);
    } catch (err) {
      // The completion action ran and failed (or its follow-ups did).
      this.reportThrown(err, { kind: "action", scope, action: effect.then });
      return;
    }
    // `false`: the module was destroyed or reloaded meanwhile — the result
    // is dropped by contract, and there is nothing to diagnose.
    if (!delivered || aborted || performed.result.ok) return;
    this.emitHttpFailure(scope, effect, performed);
  }

  private emitHttpFailure(scope: string, effect: HostedModuleHttpEffect, performed: PerformedHttpRequest): void {
    if (performed.result.ok) return;
    const { kind, message = "" } = performed.result.error;
    const at = this.definitionOf(scope)?.hosted.grantsAt ?? `the grants of "${scope}"`;
    const name = this.nameOf(scope);
    const host = performed.refusedHost;
    let hint: string | undefined;
    let missingGrant: HostedModuleFailure["missingGrant"];
    let refusedBy: NonNullable<HostedModuleFailure["http"]>["refusedBy"];
    switch (performed.refusedBy) {
      case "httpHosts":
        refusedBy = "httpHosts";
        if (host) missingGrant = { field: "httpHosts", value: host };
        hint = `"${name}" was redirected to a host outside its allowlist: add "${host}" to ${at}.httpHosts if it should follow that redirect`;
        break;
      case "privateNetwork":
        refusedBy = "policy";
        if (host) missingGrant = { field: "httpHosts", value: host };
        hint =
          `a hosted module may not reach the server's own network by default: name the host explicitly — add "${host}" ` +
          `to ${at}.httpHosts (a wildcard does not count) — or, when every module is trusted, set ` +
          `hostedModules({ privateNetwork: "allow" })`;
        break;
      case "policy":
        refusedBy = "policy";
        hint = "refused by the app's own egress policy: hostedModules({ onHttpRequest })";
        break;
      default:
        if (kind === "timeout") {
          hint = `the request's time budget is ${effect.request.timeoutMs} ms: pass a larger \`timeoutMs\` (up to 120000) if the endpoint is slow`;
        } else if (kind === "too-large") {
          hint = "a module can receive at most 4 MiB per response: ask the endpoint for less (paging, a range)";
        }
    }
    this.emit({
      kind: "http",
      scope,
      action: effect.then,
      message: `${effect.request.method} ${effect.request.url} ${performed.refusedBy ? "refused" : "failed"} (${kind}): ${message}`,
      ...(hint !== undefined ? { hint } : {}),
      ...(missingGrant ? { missingGrant } : {}),
      http: {
        method: effect.request.method,
        url: performed.url,
        errorKind: kind,
        ...(refusedBy ? { refusedBy } : {}),
      },
    });
  }

  /** Deferred HTTP requests of `scope` not completed yet: queued or in progress (diagnostics, tests). */
  pendingHttpRequests(scope: string): number {
    const wanted = scope.toLowerCase();
    let count = 0;
    for (const pending of this.httpPending.values()) if (pending.scope === wanted) count += 1;
    return count;
  }

  /** Abort the requests `scope` has in flight: its instance is going away and would not get them. */
  private cancelHttp(scope: string): void {
    for (const pending of this.httpPending.values()) {
      if (pending.scope === scope) pending.abort.abort();
    }
  }

  /** Pending `delay` effects of `scope` (diagnostics, tests). */
  pendingDelays(scope: string): number {
    return this.timers.get(scope.toLowerCase())?.size ?? 0;
  }

  private cancelTimers(scope: string): void {
    const pending = this.timers.get(scope);
    if (!pending) return;
    for (const timer of pending) clearTimeout(timer);
    this.timers.delete(scope);
  }

  // ── mounting and lifecycle ────────────────────────────────────────────────

  mount(definition: HostedModuleDefinition): HostedModuleInstance {
    const scope = scopeOf(definition);
    const existing = this.instances.get(scope);
    if (existing && !existing.destroyed) return existing;
    const mounted = new MountedModule(this, definition, scope);
    this.instances.set(scope, mounted);
    mounted.registered = this.register(mounted, "setup");
    return mounted;
  }

  /** Wire `mounted` into the engine (`register` → `instantiate` → `init`). */
  private register(mounted: MountedModule, kind: "setup" | "recovered" | "reload"): boolean {
    const { scope, definition } = mounted;
    const { declaredAt, grantsAt } = definition.hosted;
    const entry = this.service.entry(scope);
    if (!entry) {
      this.emit({
        kind: "setup",
        scope,
        message: `the module is not prepared on this server`,
        hint: `register it with RemoteServer.wasmModules() before prepare()/listen() (${declaredAt})`,
      });
      return false;
    }
    const linkFailure = this.linkFailures.get(scope);
    if (linkFailure !== undefined) {
      this.emit({
        kind: "setup",
        scope,
        message: `the module could not be instantiated: ${errorMessage(linkFailure)}`,
        hint: `check the grants at ${grantsAt}`,
        cause: linkFailure,
      });
      return false;
    }
    try {
      // The session reserved the scope as an (empty) in-process module so
      // the first render sees it; the component takes the scope over.
      if (!this.engine.isHostedModule(scope)) this.engine.unregisterModule(scope);
      this.engine.registerHostedModule(scope, {
        component: scope,
        manifest: entry.manifest,
        config: definition.hosted.config,
      });
      return true;
    } catch (err) {
      this.unreportedFailure = false;
      this.reserveScope(scope);
      let hint: string | undefined;
      if (isHostedModuleError(err)) {
        if (err.code === "scopeInUse") {
          hint = `a TypeScript module is already registered as "${scope}": rename one of them`;
        } else if (err.stage === "init") {
          hint = `the module's \`init\` rejected its config (${declaredAt}.config)`;
        } else if (err.code === "invalidState") {
          hint = "the module's `init` must return a JSON object as its state";
        }
      }
      this.emit({
        kind: kind === "setup" ? "setup" : kind,
        scope,
        message: `the module could not be started: ${errorMessage(err)}`,
        ...(hint !== undefined ? { hint } : {}),
        cause: err,
      });
      return false;
    }
  }

  /**
   * Keep `scope` registered (as an empty in-process module) while no
   * component backs it, so its template still renders as that module.
   */
  private reserveScope(scope: string): void {
    try {
      if (!this.engine.isHostedModule(scope)) this.engine.registerModule(scope, [], [], {});
    } catch {
      // Best effort: the module is already reported as not running.
    }
  }

  activateModule(mounted: MountedModule): void {
    if (this.isClosed || !mounted.registered || this.crashed.has(mounted.scope)) return;
    try {
      this.engine.activateHostedModule(mounted.scope);
    } catch (err) {
      this.reportThrown(err, { kind: "lifecycle", scope: mounted.scope, action: "<on_activated>" });
    }
  }

  deactivateModule(mounted: MountedModule): void {
    if (this.isClosed || !mounted.registered || this.crashed.has(mounted.scope)) return;
    try {
      this.engine.deactivateHostedModule(mounted.scope);
    } catch (err) {
      this.reportThrown(err, { kind: "lifecycle", scope: mounted.scope, action: "<on_deactivated>" });
    }
  }

  destroyModule(mounted: MountedModule): void {
    const { scope } = mounted;
    this.cancelTimers(scope);
    this.cancelHttp(scope);
    if (this.instances.get(scope) === mounted) this.instances.delete(scope);
    const wasCrashed = this.crashed.delete(scope);
    this.mirror.delete(scope);
    if (!mounted.registered) return;
    mounted.registered = false;
    // A dead instance cannot run `on_destroyed`; the teardown completes
    // regardless, and the crash was already reported.
    if (wasCrashed) this.quiet += 1;
    try {
      this.engine.destroyHostedModule(scope);
    } catch (err) {
      if (!wasCrashed && !this.isClosed) {
        this.reportThrown(err, { kind: "lifecycle", scope, action: "<on_destroyed>" });
      }
    } finally {
      if (wasCrashed) this.quiet -= 1;
    }
  }

  /** Dispatch `action` to the hosted module under `scope` (trusted, deferred). */
  async dispatch(scope: string, action: string, payload: unknown): Promise<void> {
    // A fresh turn: whatever engine call the caller is inside has returned.
    await Promise.resolve();
    await this.recover();
    if (this.isClosed) return;
    const mounted = this.instances.get(scope);
    if (!mounted || !mounted.registered) {
      const error = new Error(`Hosted module "${this.nameOf(scope)}" is not running on this session`);
      this.emit({ kind: "action", scope, action, message: error.message });
      throw error;
    }
    try {
      this.engine.dispatchModuleAction(scope, action, payload ?? null);
    } catch (err) {
      this.reportThrown(err, { kind: "action", scope, action });
      throw err;
    }
  }

  // ── crash recovery ────────────────────────────────────────────────────────

  recover(): Promise<void> {
    if (this.crashed.size === 0 && this.recovering === null) return Promise.resolve();
    const run = (this.recovering ?? Promise.resolve()).then(() => this.recoverCrashed());
    const settled = run.catch(() => {});
    this.recovering = settled;
    void settled.then(() => {
      if (this.recovering === settled) this.recovering = null;
    });
    return settled;
  }

  /**
   * Replace every crashed instance with a fresh one of the same prepared
   * component: state back to what `init` returns from the module's original
   * config — the policy `hypen-runtime` has.
   */
  private async recoverCrashed(): Promise<void> {
    for (const [scope, reason] of [...this.crashed]) {
      if (this.isClosed) return;
      const mounted = this.instances.get(scope);
      const entry = this.service.entry(scope);
      if (!mounted || !entry) {
        this.crashed.delete(scope);
        continue;
      }
      try {
        this.bindings.set(scope, await this.host.instantiatePrepared(scope, entry.prepared, entry.manifest));
      } catch (err) {
        // Stays crashed; the next use tries again.
        this.emit({
          kind: "setup",
          scope,
          message: `the crashed module could not be re-instantiated: ${errorMessage(err)}`,
          cause: err,
        });
        continue;
      }
      if (this.isClosed) return;
      this.replaceInstance(mounted);
      this.crashed.delete(scope);
      if (mounted.registered) {
        this.emit({
          kind: "recovered",
          scope,
          message: `re-instantiated after a crash (${reason}); its state was reset`,
        });
      }
    }
  }

  /** Tear the scope's engine instance down and start it again from `init`. */
  private replaceInstance(mounted: MountedModule): void {
    const { scope } = mounted;
    this.cancelTimers(scope);
    this.cancelHttp(scope);
    this.mirror.delete(scope);
    this.quiet += 1;
    try {
      if (mounted.registered) this.engine.destroyHostedModule(scope);
    } catch {
      // `on_destroyed` of the instance being replaced; the teardown completed.
    } finally {
      this.quiet -= 1;
    }
    this.crashed.delete(scope);
    mounted.registered = this.register(mounted, "recovered");
    if (mounted.registered && mounted.active) this.activateModule(mounted);
  }

  // ── hot reload ────────────────────────────────────────────────────────────

  /** @internal Swap `next`'s component in for this session. */
  async reloadModule(next: PreparedEntry, previous: PreparedEntry | undefined): Promise<ReloadOutcome> {
    if (this.isClosed) return "notMounted";
    const { scope } = next;
    const oldBindings = this.bindings.get(scope);
    let newBindings: unknown;
    try {
      newBindings = await this.host.instantiatePrepared(scope, next.prepared, next.manifest);
    } catch (err) {
      // The host still has the previous component: nothing changed here.
      const mounted = this.instances.get(scope);
      if (!mounted) return "notMounted";
      this.emit({
        kind: "reload",
        scope,
        message: `the new component could not be instantiated; the previous instance keeps running: ${errorMessage(err)}`,
        cause: err,
      });
      return "kept";
    }
    this.bindings.set(scope, newBindings);
    this.linkFailures.delete(scope);
    const mounted = this.instances.get(scope);
    if (!mounted || this.isClosed) return "notMounted";
    mounted.definition = next.definition;

    if (!mounted.registered || this.crashed.has(scope)) {
      // Nothing running to keep state from: start it fresh.
      this.crashed.delete(scope);
      this.replaceInstance(mounted);
      return mounted.registered ? "stateReset" : "failed";
    }

    try {
      this.engine.reloadHostedModule(scope, { component: scope, manifest: next.manifest });
    } catch (err) {
      // The engine kept the old instance; give the host its component back
      // so a later crash recovery re-instantiates what is actually running.
      if (oldBindings !== undefined && previous) {
        this.host.registerPrepared(scope, oldBindings, previous.manifest);
        this.bindings.set(scope, oldBindings);
        mounted.definition = previous.definition;
      }
      this.unreportedFailure = false;
      this.emit({
        kind: "reload",
        scope,
        message: `the new component could not replace the running instance, which keeps running: ${errorMessage(err)}`,
        cause: err,
      });
      return "kept";
    }

    // The swap dropped the old instance's subscriptions; `on_activated`
    // re-creates them — and is the first call that hands the new component
    // the old state.
    if (mounted.active) {
      try {
        this.engine.activateHostedModule(scope);
      } catch (err) {
        this.unreportedFailure = false;
        this.replaceInstance(mounted);
        this.emit({
          kind: "reload",
          scope,
          message: `the new component did not accept the previous state (${errorMessage(err)}); the module was re-initialised`,
          cause: err,
        });
        return mounted.registered ? "stateReset" : "failed";
      }
    }
    return "reloaded";
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.isClosed) return;
    await this.recovering?.catch(() => {});
    for (const mounted of [...this.instances.values()]) {
      await mounted.destroy();
    }
    this.isClosed = true;
    for (const scope of [...this.timers.keys()]) this.cancelTimers(scope);
    // In-flight requests are aborted and never completed: the engine is
    // going away with the session.
    this.httpQueue?.stop();
    for (const pending of this.httpPending.values()) pending.abort.abort();
    this.httpPending.clear();
    try {
      this.engine.setModuleEffectHandler(null);
    } catch {
      // The engine is going away with the session.
    }
    this.service.closed(this);
  }
}

/** A hosted module mounted on one session. */
class MountedModule implements HostedModuleInstance {
  readonly kind = "hosted" as const;
  readonly hasLiveBackgroundDeviceWork = false as const;
  /** Wired in the engine (false: it could not start, or was destroyed). */
  registered = false;
  active = false;
  private isDestroyed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly runtime: SessionRuntime,
    public definition: HostedModuleDefinition,
    readonly scope: string
  ) {}

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  async waitForReady(): Promise<void> {}

  async activate(): Promise<void> {
    if (this.isDestroyed || this.active) return;
    this.active = true;
    this.runtime.activateModule(this);
  }

  async deactivate(): Promise<void> {
    if (this.isDestroyed || !this.active) return;
    this.active = false;
    this.runtime.deactivateModule(this);
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    if (this.active) await this.deactivate();
    this.isDestroyed = true;
    this.runtime.destroyModule(this);
  }

  getState(): Record<string, unknown> {
    return this.runtime.stateOf(this.scope);
  }

  dispatch(action: string, payload?: unknown): Promise<void> {
    if (this.isDestroyed) {
      return Promise.reject(new Error(`Hosted module "${this.definition.name}" is destroyed`));
    }
    return this.runtime.dispatch(this.scope, action, payload);
  }

  onStateChange(callback: () => void): void {
    this.listeners.push(callback);
  }

  /** @internal */
  stateChanged(): void {
    if (this.isDestroyed) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        log.error(`onStateChange listener of "${this.definition.name}" threw:`, err);
      }
    }
  }
}

export { isHostedModuleSetupError };
