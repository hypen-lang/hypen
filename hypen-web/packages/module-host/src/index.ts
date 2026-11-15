/**
 * @hypen-space/module-host
 *
 * The browser/Node module host for Hypen WASM Component modules — the JS
 * half that the engine's Rust `BridgedHost` drives. See README.md for the
 * capability contract (declare -> grant -> enforce) and pipeline details.
 */

export { JsModuleHost, buildImportMap, prepareComponent } from "./js-module-host.ts";
export type {
  JsModuleHostOptions,
  EngineStateImport,
  DeferredHttpImport,
  PrepareInfo,
  PreparedComponent,
} from "./js-module-host.ts";
export type { LoadedVia } from "./loader.ts";
export {
  HostStorage,
  MemoryStorageBackend,
  LocalStorageBackend,
  defaultStorageBackend,
  createStorageImports,
  DEFAULT_STORAGE_QUOTAS,
  MAX_NAMESPACE_BYTES,
  MAX_OPEN_BUCKETS,
  entryCost,
  STORAGE_SCOPES,
  LS_PREFIX,
} from "./storage.ts";
export type {
  StorageBackend,
  StorageLike,
  StorageScope,
  StorageQuotas,
  StorageQuotaOptions,
  StorageError,
  HostStorageOptions,
  BucketRef,
  BucketEntryInfo,
  KvBucket,
  CloudBucket,
  StorageImports,
} from "./storage.ts";
export {
  MAX_HTTP_REQUESTS_PER_CALL,
  MAX_HTTP_URL_BYTES,
  MAX_HTTP_HEADERS,
  MAX_HTTP_HEADER_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_METHOD_BYTES,
  MAX_HTTP_NAME_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_BODY_BYTES,
  MAX_HTTP_REDIRECTS,
  DEFAULT_HTTP_IN_FLIGHT_PER_MODULE,
  HTTP_FAILURE_KINDS,
  DeferredHttpQueue,
  parseHttpUrl,
  joinHttpUrl,
  parseHostPattern,
  formatHostPattern,
  hostPatternMatches,
  httpGrantOf,
  checkHttpGrant,
  checkHttpAuthority,
  formatHttpDenial,
  isHostOwnedHeader,
  effectiveTimeoutMs,
  validateQueuedHttpRequest,
  httpCompletionPayload,
  base64Encode,
} from "./http.ts";
export type {
  Parsed,
  IpAddress,
  HttpScheme,
  HttpUrl,
  HostPattern,
  HttpGrant,
  HttpDenial,
  HttpRequest,
  QueuedHttpRequest,
  HttpRequestError,
  HttpFailureKind,
  HttpOutcome,
  HttpCompletion,
} from "./http.ts";
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
