/**
 * `app.json`: the manifest `hypen-runtime --app` loads (`ModuleEntry` in
 * hypen-engine-rs/src/bin/hypen_runtime/manifest.rs). Field order here is the order
 * written to disk.
 */

import type { Capabilities, GrantableStorage, ModuleName, ScopeName, StatelessComponent } from "./types.js";

/**
 * A stateful module's entry. All four capability fields are always written:
 * the host is deny-by-default, and an explicit `[]` / `false` documents that
 * the absence of a grant is intended.
 */
export interface StatefulManifestEntry {
  name: ModuleName;
  /** The component, relative to the manifest. */
  wasm: string;
  /** The template, relative to the manifest. */
  ui: string;
  reads: ScopeName[];
  dispatches: ScopeName[];
  storage: GrantableStorage[];
  http: boolean;
}

/**
 * A stateless component's entry: no `wasm` and no capabilities — the runtime
 * registers its template with the resolver but creates no instance.
 */
export interface StatelessManifestEntry {
  name: ModuleName;
  ui: string;
}

export type AppManifestModule = StatefulManifestEntry | StatelessManifestEntry;

export interface AppManifest {
  entry: string;
  modules: AppManifestModule[];
}

/** File names a component's artifacts get in the output directory. */
export const wasmFileName = (name: ModuleName): string => `${name}.wasm`;
export const uiFileName = (name: ModuleName): string => `${name}.hypen`;

export const MANIFEST_FILE = "app.json";

export function statefulEntry(name: ModuleName, capabilities: Capabilities): StatefulManifestEntry {
  return {
    name,
    wasm: wasmFileName(name),
    ui: uiFileName(name),
    reads: capabilities.reads,
    dispatches: capabilities.dispatches,
    storage: capabilities.storage,
    http: capabilities.http,
  };
}

export function statelessEntry(component: StatelessComponent): StatelessManifestEntry {
  return { name: component.name, ui: uiFileName(component.name) };
}

/** The manifest's on-disk bytes. */
export function serializeManifest(manifest: AppManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}
