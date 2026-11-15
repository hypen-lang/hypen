/**
 * @hypen-space/module-host
 *
 * The browser/Node module host for Hypen WASM Component modules — the JS
 * half that the engine's Rust `BridgedHost` drives. See README.md for the
 * capability contract (declare -> grant -> enforce) and pipeline details.
 */

export { JsModuleHost, engineStateImport, buildImportMap } from "./js-module-host.ts";
export {
  LocalBucket,
  CloudBucket,
  BrowserLocalStore,
  MemoryLocalStore,
  dumpStores,
  LS_PREFIX,
} from "./storage.ts";
export type { LocalStoreBackend, BucketEntryInfo } from "./storage.ts";
export type {
  ModuleManifest,
  ModuleBindings,
  ActionMessage,
  SiblingState,
  CrossDispatch,
  SubscribeRequest,
  Effect,
  ReducerOutput,
} from "./types.ts";
