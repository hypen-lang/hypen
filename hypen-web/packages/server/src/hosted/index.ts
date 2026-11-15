/**
 * Hosted (WASM-component) modules for `@hypen-space/server`: define them
 * (`wasmModule`, `loadWasmModules`), register them on a `RemoteServer`
 * (`.wasmModules(...)`, `.hostedModules({ storage, onError })`).
 */

export { wasmModule, loadWasmModules, classifyWasm } from "./define.js";
export type {
  WasmModuleOptions,
  WasmModuleGrants,
  LoadedWasmModules,
  LoadWasmModulesOptions,
  WasmKind,
} from "./define.js";
export {
  HostedModuleSetupError,
  isHostedModuleSetupError,
  formatHostedModuleSetupError,
} from "./errors.js";
export type { HostedModuleSetupCode, HostedModuleSetupInfo } from "./errors.js";
export { HostedModuleService, DEFAULT_MAX_PENDING_DELAYS } from "./runtime.js";
export type { HostedModulesOptions, HostedReloadResult, HostedStorageQuotas } from "./runtime.js";
export { MemoryHostedStorage, FileHostedStorage, HostedStorageOwners, MAX_SESSION_STORES } from "./storage.js";
export type {
  HostedStorageBackend,
  HostedStorageBackends,
  HostedStorageChoice,
  HostedStorageResolver,
} from "./storage.js";
