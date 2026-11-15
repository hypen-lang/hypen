/**
 * Hosted modules: modules whose logic is a prebuilt WASM Component
 * (`hypen:module`) instead of in-process TypeScript handlers.
 *
 * This file is the WASM-free half: the *shape* of a hosted module definition
 * and the seams a session uses to run one. Nothing here loads, transpiles or
 * instantiates a component — that is `@hypen-space/server`
 * (`wasmModule()` / `loadWasmModules()` and the provider it installs as
 * `SessionHost.hostedModules`), which needs `@hypen-space/module-host`.
 *
 * A module definition is one of two kinds:
 *
 * - **in-process** — `app.defineState(...).onAction(...)`: handlers run in
 *   this JS realm, state lives in an observable proxy;
 * - **hosted** — a definition whose `hosted` field is set
 *   ({@link HostedModuleDefinition}): the engine drives a component instance
 *   through the session's module host, and the module's state lives only in
 *   the engine.
 *
 * Both kinds sit in the same `HypenApp` registry, are resolved as components
 * by name, mounted by `ManagedRouter`, and reachable through
 * `context.getModule(id)`. Everything that has to behave differently
 * branches on {@link isHostedModuleDefinition} (definitions) or on the
 * `kind` tag of {@link AnyModuleInstance} (instances) — never on a name.
 */

import type { HypenModuleDefinition, HypenModuleInstance } from "./app.js";
import type { BaseEngine } from "./engine-base.js";
import type { Session } from "./remote/types.js";
import type { ModuleCascadeReport } from "./types.js";

/** Storage tiers a hosted module can be granted beyond the always-on `local`. */
export type HostedStorageGrant = "app" | "cloud";

/**
 * What a hosted module is allowed to do, normalised: scopes are lowercase
 * module names. Deny-by-default — an empty grant set is a module that can
 * only compute over its own state and its private `local` storage.
 */
export interface HostedModuleGrants {
  /** Module scopes (hosted or in-process) whose state it may read / subscribe to. */
  readonly reads: readonly string[];
  /** Module scopes (hosted or in-process) it may dispatch actions to. */
  readonly dispatches: readonly string[];
  readonly storage: readonly HostedStorageGrant[];
  /** Outbound HTTP (`wasi:http`). */
  readonly http: boolean;
}

/** Where a hosted module's component bytes come from. */
export type HostedComponentSource =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /** An absolute filesystem path. */
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "url"; readonly url: string };

/** The hosted half of a {@link HostedModuleDefinition}. */
export interface HostedModuleSpec {
  readonly component: HostedComponentSource;
  readonly grants: HostedModuleGrants;
  /** The module's `init` config (JSON-serialisable). */
  readonly config: unknown;
  /** Absolute path of the `.hypen` template, when it came from a file. */
  readonly templatePath?: string;
  /**
   * Where the module was declared, for error messages: e.g.
   * `hypen.json wasm.modules.Pricing` or `wasmModule({ name: "Pricing" })`.
   */
  readonly declaredAt: string;
  /**
   * Where its grants are written, as a prefix for the grant key: e.g.
   * `hypen.json wasm.modules.Pricing` (→ `….reads`) or
   * `wasmModule({ name: "Pricing" }).grants`.
   */
  readonly grantsAt: string;
}

/**
 * A module whose logic is a WASM Component. Structurally a
 * `HypenModuleDefinition` (so registries, the component resolver and the
 * router need no second code path) with no in-process handlers; `hosted`
 * is what marks it and says how to run it.
 */
export interface HostedModuleDefinition extends HypenModuleDefinition<Record<string, unknown>> {
  /** Required: the name is the component tag and (lowercased) the state scope. */
  name: string;
  readonly hosted: HostedModuleSpec;
}

/** Whether `definition` is a hosted module (its logic lives in a component). */
export function isHostedModuleDefinition(
  definition: HypenModuleDefinition<any> | null | undefined
): definition is HostedModuleDefinition {
  return (
    definition !== null &&
    definition !== undefined &&
    typeof (definition as { hosted?: unknown }).hosted === "object" &&
    (definition as { hosted?: unknown }).hosted !== null
  );
}

/**
 * A running hosted module on one session: the hosted counterpart of
 * `HypenModuleInstance`, with the same lifecycle surface so a
 * `ManagedRouter` treats both alike.
 */
export interface HostedModuleInstance {
  readonly kind: "hosted";
  /** The engine scope (lowercase module name). */
  readonly scope: string;
  readonly destroyed: boolean;
  /** Hosted modules cannot own device work; never pinned in the persist cache. */
  readonly hasLiveBackgroundDeviceWork: false;
  /** Resolves once the instance is wired (rejects never; failures are reported). */
  waitForReady(): Promise<void>;
  /** `on_activated` (where a module subscribes to others). Idempotent. */
  activate(): Promise<void>;
  /** `on_deactivated`. Idempotent. */
  deactivate(): Promise<void>;
  /** `on_destroyed` + full teardown, pending `delay` timers cancelled. Idempotent. */
  destroy(): Promise<void>;
  /** A snapshot of the module's current state. Safe inside an action handler. */
  getState(): Record<string, unknown>;
  /**
   * Dispatch `action` to the module. Always deferred to a fresh task turn,
   * so it is safe from inside an action handler (the engine refuses
   * re-entrant calls). Rejects with the `HostedModuleError` the engine
   * threw when the module's own call failed.
   */
  dispatch(action: string, payload?: unknown): Promise<void>;
  /** Called (coalesced) after the module's state changed. */
  onStateChange(callback: () => void): void;
}

/** A live module instance of either kind. Discriminated by `kind`. */
export type AnyModuleInstance = HypenModuleInstance<any> | HostedModuleInstance;

/** Why a hosted module call did not (fully) work, in terms an app can act on. */
export type HostedModuleFailureKind =
  /** The module could not be instantiated or initialised on this session. */
  | "setup"
  /** A lifecycle hook (`on_activated` / `on_deactivated` / `on_destroyed`) failed. */
  | "lifecycle"
  /** The module's own handling of an action failed; nothing was applied. */
  | "action"
  /** The action ran, but follow-ups (cross-dispatches, notifications) failed. */
  | "cascade"
  /** The component instance trapped: it is dead until re-instantiated. */
  | "crash"
  /** A crashed instance was replaced; its state was reset to `init`. */
  | "recovered"
  /** A `navigate` / `delay` effect could not be performed. */
  | "effect"
  /** A hot reload was refused; the previous instance keeps running. */
  | "reload";

/** One hosted-module failure, as handed to diagnostics and the app's error hook. */
export interface HostedModuleFailure {
  kind: HostedModuleFailureKind;
  /** The module's name as declared (`Pricing`). */
  module: string;
  /** Its engine scope (`pricing`). */
  scope: string;
  /** The action being dispatched, when one was. */
  action?: string;
  /** One-line description. */
  message: string;
  /** What to change, when the failure points at configuration. */
  hint?: string;
  /** The grant that would have allowed a refused read / dispatch / import. */
  missingGrant?: { field: "reads" | "dispatches" | "storage" | "http"; value: string };
  /** The engine's structured cascade report, when the failure came out of one. */
  report?: ModuleCascadeReport;
  /** The session it happened on. */
  sessionId?: string;
  cause?: unknown;
}

/** What a session hands the hosted-module provider when it opens. */
export interface HostedSessionContext {
  /** The session's engine, initialised, with no module host installed yet. */
  readonly engine: BaseEngine;
  readonly session: Session;
  /**
   * Navigate the session's router (a hosted module's `navigate` effect).
   * Returns `false` when the app has no router to navigate.
   */
  navigate(path: string): boolean;
}

/**
 * Hosted modules on one session: owns the session's module host (and with
 * it the module's storage), its `delay` timers and crash recovery.
 */
export interface HostedModuleSession {
  /**
   * Instantiate `definition` and wire it under its scope. Never throws: a
   * module that cannot start is reported (kind `"setup"`) and the returned
   * instance stays inert — the rest of the app keeps working.
   */
  mount(definition: HostedModuleDefinition): HostedModuleInstance;
  /**
   * Re-instantiate modules whose instance crashed. Awaited before each
   * client action, so "the next use" of a crashed module finds a fresh
   * instance (state reset to `init`, logged).
   */
  recover(): Promise<void>;
  /**
   * Report an error an engine call threw on this session's behalf (a UI
   * dispatch reaching a hosted module). Returns `false` when `error` is not
   * a hosted-module error — the caller handles it as before.
   */
  report(error: unknown, during: { action?: string }): boolean;
  /** Destroy every hosted instance of the session and cancel its timers. */
  close(): Promise<void>;
}

/**
 * The seam a `SessionHost` exposes when its app has hosted modules. Absent
 * (the default) on hosts that cannot run them — a session that meets a
 * hosted definition without a provider reports it and leaves the module
 * unmounted.
 */
export interface HostedModuleProvider {
  /** Called once per session, after the hello handshake, before any module mounts. */
  openSession(context: HostedSessionContext): Promise<HostedModuleSession>;
}
