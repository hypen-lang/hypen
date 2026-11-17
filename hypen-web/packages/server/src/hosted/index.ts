/**
 * Hosted (WASM-component) modules for `@hypen-space/server`: define them
 * (`wasmModule`, `loadWasmModules`), register them on a `RemoteServer`
 * (`.wasmModules(...)`, `.hostedModules({ storage, onError })`).
 */

export { wasmModule, wasmModuleFromManifest, loadWasmModules, loadWasmPackage, classifyWasm } from "./define.js";
export {
  ModulePackageError,
  PACKAGE_MANIFEST_FILE,
  MODULE_LOCK_FILE,
  capabilitiesOf,
  describeCapability,
  parsePackageManifest,
  readModulePackage,
  readModuleLock,
  NAMESPACE_SEPARATOR,
  packageNamespace,
  planPackageNames,
  moduleAliases,
  installedNameOf,
  packageNameOf,
} from "./module-package.js";
export { renameTemplateComponents } from "./template-rename.js";
export type {
  Capability,
  ModuleGrant,
  ModuleRequests,
  PackageManifest,
  PackageModule,
  PackageComponent,
  ResolvedPackage,
  InstalledName,
  PackageNaming,
  PackageNamingOptions,
} from "./module-package.js";
export type {
  LoadWasmPackageOptions,
  LoadedWasmPackage,
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
export { DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS, httpTargetNetwork, httpHostsNameExplicitly } from "./http.js";
export type {
  HostedFetch,
  HostedFetchInit,
  HostedHttpRequestInfo,
  HostedHttpRequestContext,
  HttpEgressDecision,
  HttpEgressPolicy,
  HttpTargetNetwork,
} from "./http.js";
export { MemoryHostedStorage, FileHostedStorage, HostedStorageOwners, MAX_SESSION_STORES } from "./storage.js";
export type {
  HostedStorageBackend,
  HostedStorageBackends,
  HostedStorageChoice,
  HostedStorageResolver,
} from "./storage.js";
