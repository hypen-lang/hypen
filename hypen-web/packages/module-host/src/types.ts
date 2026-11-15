/**
 * Shared types for the Hypen module host.
 *
 * These mirror the wire contract between the Rust `BridgedHost`
 * (hypen-engine-rs/src/module_host/bridged_host.rs) and the JS
 * `JsModuleHost`, and the WIT-level shapes jco produces for the
 * `hypen:engine/module` world. Kept deliberately light — the authoritative
 * schema lives in the WIT files and `bridged_host.rs`.
 */

/**
 * Module manifest as delivered by `BridgedHost::register` (`ManifestWire`):
 * declared capabilities that the host turns into grants.
 *
 * - `storage`: granted storage scopes (e.g. `["local", "app", "cloud"]`)
 * - `reads` / `dispatches`: sibling modules this module may read from /
 *   cross-dispatch into (enforced per call by the ACL context)
 * - `http`: wasi:http egress grant. `false` withholds the wasi:http shims at
 *   prepare (link) time; `true` or absent grants them (back-compat).
 */
export interface ModuleManifest {
  name?: string;
  version?: string;
  storage?: string[];
  reads?: string[];
  dispatches?: string[];
  http?: boolean;
}

/** An action message: name + opaque JSON-encoded payload bytes. */
export interface ActionMessage {
  name: string;
  payload: Uint8Array;
}

/** Snapshot of a sibling module's state, passed into dispatch/onActivated. */
export interface SiblingState {
  module: string;
  state: Uint8Array;
}

/** A cross-module dispatch queued by the reducer via `hypen:engine/state`. */
export interface CrossDispatch {
  module: string;
  action: ActionMessage;
}

/** A state subscription queued by the reducer via `hypen:engine/state`. */
export interface SubscribeRequest {
  module: string;
  path: string;
  onChange: string;
}

/** Host-side effect descriptor decoded from the WIT `effect` variant. */
export type Effect =
  | { tag: "log"; level: string; message: string }
  | { tag: "navigate"; path: string }
  | { tag: "delay"; ms: number; then: string }
  | { tag: string; [key: string]: unknown };

/**
 * What the host hands back to the Rust `BridgedHost` after a reducer call.
 * `crossDispatch` / `subscribeRequests` are drained from the per-call ACL
 * context (they are queued, never re-entrant).
 */
export interface ReducerOutput {
  state?: Uint8Array;
  effects: Effect[];
  emit: ActionMessage[];
  crossDispatch: CrossDispatch[];
  subscribeRequests: SubscribeRequest[];
}

/**
 * The surface of a jco-instantiated `hypen:engine/module` component, i.e.
 * what `prepare()` produces and the synchronous host methods call into.
 * Reducer returns are WIT-shaped (jco representation), hence `unknown` — the
 * host normalises them into {@link ReducerOutput}.
 */
export interface ModuleBindings {
  init(config: Uint8Array): Uint8Array;
  dispatch(state: Uint8Array, action: ActionMessage): unknown;
  onActivated(state: Uint8Array): unknown;
  onDeactivated(state: Uint8Array): unknown;
  onDestroyed(state: Uint8Array): void;
  actions(): string[];
}
