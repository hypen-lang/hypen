/**
 * @hypen-space/core - Hypen Core Engine
 *
 * Platform-agnostic reactive UI runtime.
 * Use with @hypen/web for browser rendering, or build your own renderer.
 *
 * ## Quick Start (Single-File Component)
 *
 * ```typescript
 * import { app, hypen, state } from "@hypen-space/core";
 *
 * export default app
 *   .defineState({ count: 0 })
 *   .onAction("increment", ({ state }) => {
 *     state.count += 1;
 *   })
 *   .ui(hypen`
 *     Column {
 *       Text("Count: @{state.count}")
 *       Button { Text("+") }
 *         .onClick("@actions.increment")
 *     }
 *   `);
 * ```
 *
 * ## Two-File Component (Legacy)
 *
 * ```typescript
 * // component.ts
 * import { app } from "@hypen-space/core";
 *
 * export default app
 *   .defineState({ count: 0 })
 *   .onAction("increment", ({ state }) => {
 *     state.count++;
 *   })
 *   .build();
 *
 * // component.hypen (separate file)
 * // Column { Text("Count: @{state.count}") ... }
 * ```
 */

// ============================================================================
// CORE TYPES (WASM-free)
// ============================================================================

export type {
  Patch,
  Action,
  RenderCallback,
  ActionHandler as EngineActionHandler,
  ResolvedComponent,
  ComponentResolver as EngineComponentResolver,
} from "./types.js";

// NOTE: Engine has moved to dedicated packages:
//   Browser: import { Engine } from "@hypen-space/web-engine/engine"
//   Node.js: import { Engine } from "@hypen-space/server/engine"

// ============================================================================
// APP / MODULE SYSTEM
// ============================================================================

export { app, HypenApp, HypenAppBuilder, HypenModuleInstance } from "./app.js";

// ============================================================================
// TEMPLATE SYSTEM (Single-File Components)
// ============================================================================

export { hypen, state, item, index } from "./hypen.js";
export type { StateProxy, ItemProxy } from "./hypen.js";

export type {
  IEngine,
  ActionContext,
  GlobalContext,
  LifecycleHandler,
  ActionHandlerContext,
  ActionHandler,
  HypenModuleDefinition,
  HypenModule,
  // Session lifecycle hooks
  DisconnectContext,
  ReconnectContext,
  ExpireContext,
  DisconnectHandler,
  ReconnectHandler,
  ExpireHandler,
  // Error handling
  ErrorContext,
  ErrorHandler,
  ErrorHandlerResult,
  // Data source access in action handlers
  DataSourceAccessor,
} from "./app.js";

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

export type { StateStore } from "./persistence.js";

// ============================================================================
// DATA SOURCE PLUGIN SYSTEM
// ============================================================================

export { DataSourceManager } from "./datasource.js";
export type {
  DataSourcePlugin,
  DataSourceStatus,
  DataSourceQuery,
  DataSourceSubscription,
  DataSourceChange,
  IDataSourceEngine,
} from "./datasource.js";

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export {
  createObservableState,
  batchStateUpdates,
  getStateSnapshot,
  isStateProxy,
  unwrapProxy,
} from "./state.js";
export type {
  StatePath,
  StateChange,
  StateObserverOptions,
} from "./state.js";

// Portable DI seam: `@hypen-space/server` and `@hypen-space/web-engine`
// call `setPortableImpl` at their module-init time to route core's
// diff / matchPath / path-ops / URL helpers through the Rust engine's
// canonical implementations. Standalone core use gets TS fallbacks.
export { setPortableImpl, portable } from "./portable.js";
export type { PortableImpl } from "./portable.js";

// ============================================================================
// RENDERER ABSTRACTION
// ============================================================================

export { BaseRenderer, ConsoleRenderer } from "./renderer.js";
export type { Renderer } from "./renderer.js";

// ============================================================================
// ROUTING
// ============================================================================

export { HypenRouter } from "./router.js";
export type {
  RouteMatch,
  RouteState,
  RouteChangeCallback,
} from "./router.js";

// Route-based module lifecycle orchestrator. Wraps HypenRouter and
// mounts/unmounts modules as the route changes, with optional per-module
// persistence to avoid tearing down state on every navigation.
export { ManagedRouter } from "./managed-router.js";
export type { RouteDefinition } from "./managed-router.js";

// ============================================================================
// EVENTS
// ============================================================================

export { TypedEventEmitter, createEventEmitter } from "./events.js";
export type { EventHandler, HypenFrameworkEvents } from "./events.js";

// ============================================================================
// GLOBAL CONTEXT
// ============================================================================

export { HypenGlobalContext } from "./context.js";
export type { ModuleReference } from "./context.js";

// ============================================================================
// REMOTE UI
// ============================================================================

// Client (browser-safe)
export { RemoteEngine } from "./remote/client.js";
export type {
  RemoteConnectionState,
  RemoteEngineOptions,
  SessionOptions,
  SessionInfo,
} from "./remote/client.js";

// NOTE: RemoteServer has moved to @hypen-space/server:
//   import { RemoteServer, serve } from "@hypen-space/server/remote"

// Session Management
export { SessionManager } from "./remote/session.js";
export type { SessionExpireCallback } from "./remote/session.js";

// Types
export type {
  RemoteMessage,
  InitialTreeMessage,
  PatchMessage,
  DispatchActionMessage,
  StateUpdateMessage,
  HelloMessage,
  SessionAckMessage,
  SessionExpiredMessage,
  Session,
  SessionConfig,
  RemoteClient,
  RemoteServerConfig,
} from "./remote/types.js";

// ============================================================================
// COMPONENT RESOLVER (browser-safe, no fs dependency)
// ============================================================================

export { ComponentResolver } from "./resolver.js";
export type {
  ImportStatement,
  ImportClause,
  ImportSource,
  ComponentDefinition as ResolverComponentDefinition,
  ResolverOptions,
} from "./resolver.js";

// ============================================================================
// NODE-ONLY MODULES — Moved to @hypen-space/server
// ============================================================================
//
// These modules have moved to the @hypen-space/server package:
//   import { ComponentLoader, componentLoader } from "@hypen-space/server/loader"
//   import { discoverComponents, ... } from "@hypen-space/server/discovery"
//   import { hypenPlugin, ... } from "@hypen-space/server/plugin"
//

// ============================================================================
// BUILT-IN COMPONENTS
// ============================================================================

export { Router, Route, Link } from "./components/builtin.js";

// ============================================================================
// RESULT TYPE (Error Handling)
// ============================================================================

export {
  Ok,
  Err,
  isOk,
  isErr,
  fromPromise,
  fromTry,
  map,
  mapErr,
  flatMap,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  match,
  all,
  HypenError,
  ActionError,
  ConnectionError,
  StateError,
  ParseError,
  RenderError,
  classifyEngineError,
} from "./result.js";
export type { Result } from "./result.js";

// ============================================================================
// DISPOSABLE PATTERN (Resource Management)
// ============================================================================

export {
  DisposableStack,
  DisposableMixin,
  isDisposable,
  disposableListener,
  disposableTimeout,
  disposableInterval,
  disposableWebSocket,
  disposableAbortController,
  disposableSubscription,
  getElementDisposables,
  disposeElement,
  hasElementDisposables,
  compositeDisposable,
  using,
  usingSync,
} from "./disposable.js";
export type { Disposable } from "./disposable.js";

// ============================================================================
// Retry Utility
// ============================================================================

export {
  retry,
  retryResult,
  withRetry,
  RetryConditions,
  RetryPresets,
} from "./retry.js";
export type { RetryOptions } from "./retry.js";

// ============================================================================
// Logger
// ============================================================================

export {
  Logger,
  createLogger,
  logger,
  log,
  frameworkLoggers,
  setLogLevel,
  getLogLevel,
  configureLogger,
  enableLogging,
  disableLogging,
  setDebugMode,
  isDebugMode,
} from "./logger.js";
export type { LogLevel, LoggerConfig, LogHandler } from "./logger.js";

// Patch-stream validation — catch silent resolver misses (opaque component
// elementTypes) in CI / smoke tests off the wire.
export { validatePatches } from "./validate.js";
export type { PatchValidationResult } from "./validate.js";
