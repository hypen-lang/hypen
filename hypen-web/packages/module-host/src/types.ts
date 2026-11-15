/**
 * Shared types for the Hypen module host.
 *
 * These mirror the wire contract between the Rust `BridgedHost`
 * (hypen-engine-rs/src/module_host/bridged_host.rs) and the JS
 * `JsModuleHost`, and the WIT-level shapes jco produces for the
 * `hypen:engine/module` world. Kept deliberately light — the authoritative
 * schema lives in the WIT files and `bridged_host.rs`.
 */

import type { StorageScope } from "./storage.ts";

/**
 * Module manifest as delivered by `BridgedHost::register` (`ManifestWire`):
 * declared capabilities that the host turns into grants.
 *
 * Every field is DENY-BY-DEFAULT here (see {@link normalizeManifest}):
 *
 * - `storage`: storage scopes granted in addition to `local` (which is always
 *   granted and module-private). `"app"` / `"cloud"` must be listed or the
 *   corresponding `hypen:storage/*` interface is not linked and a component
 *   importing it fails at `prepare()` (link) time. Omitted = local only.
 * - `reads` / `dispatches`: sibling modules this module may read from /
 *   cross-dispatch into (enforced per call). Omitted = none.
 * - `http`: wasi:http egress grant. Only an explicit `true` links the
 *   wasi:http shims; omitted or `false` withholds them at link time. (The
 *   Rust `ManifestWire` always sends this field.)
 */
export interface ModuleManifest {
  name?: string;
  version?: string;
  storage?: readonly string[];
  reads?: readonly string[];
  dispatches?: readonly string[];
  http?: boolean;
}

/** A manifest with every default applied — what the host actually enforces. */
export interface NormalizedManifest {
  name: string;
  version: string;
  /** Always contains `"local"`. */
  storage: ReadonlySet<StorageScope>;
  reads: ReadonlySet<string>;
  dispatches: ReadonlySet<string>;
  http: boolean;
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Apply the deny-by-default rules to a (possibly partial, possibly
 * untrusted) manifest: unknown storage scopes are ignored, non-string list
 * entries are dropped, and `http` is granted only by a literal `true`.
 */
export function normalizeManifest(manifest: ModuleManifest | null | undefined): NormalizedManifest {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const storage = new Set<StorageScope>(["local"]);
  for (const s of stringList(m.storage)) {
    if (s === "local" || s === "app" || s === "cloud") storage.add(s);
  }
  return {
    name: typeof m.name === "string" ? m.name : "",
    version: typeof m.version === "string" ? m.version : "",
    storage,
    reads: new Set(stringList(m.reads)),
    dispatches: new Set(stringList(m.dispatches)),
    http: m.http === true,
  };
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
