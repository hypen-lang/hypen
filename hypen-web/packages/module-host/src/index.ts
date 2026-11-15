/**
 * @hypen-space/module-host
 *
 * The browser/Node module host for Hypen WASM Component modules — the JS
 * half that the engine's Rust `BridgedHost` drives. See README.md for the
 * capability contract (declare -> grant -> enforce) and pipeline details.
 */

export { JsModuleHost, buildImportMap } from "./js-module-host.ts";
export type { JsModuleHostOptions, EngineStateImport } from "./js-module-host.ts";
export {
  HostStorage,
  MemoryStorageBackend,
  LocalStorageBackend,
  defaultStorageBackend,
  createStorageImports,
  DEFAULT_STORAGE_QUOTAS,
  STORAGE_SCOPES,
  LS_PREFIX,
} from "./storage.ts";
export type {
  StorageBackend,
  StorageLike,
  StorageScope,
  StorageQuotas,
  StorageError,
  HostStorageOptions,
  BucketRef,
  BucketEntryInfo,
  KvBucket,
  CloudBucket,
  StorageImports,
} from "./storage.ts";
export { normalizeManifest } from "./types.ts";
export type {
  ModuleManifest,
  NormalizedManifest,
  ModuleBindings,
  ActionMessage,
  SiblingState,
  CrossDispatch,
  SubscribeRequest,
  Effect,
  ReducerOutput,
} from "./types.ts";
