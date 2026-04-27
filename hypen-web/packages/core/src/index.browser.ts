/**
 * @hypen-space/core - Browser Entry Point
 *
 * This entry point exports platform-agnostic runtime APIs for browser use.
 * Engine has moved to @hypen-space/web-engine (browser) and @hypen-space/server (Node.js).
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
  ComponentResolver,
} from "./types.js";

// NOTE: Engine has moved to dedicated packages:
//   Browser: import { Engine } from "@hypen-space/web-engine/engine"
//   Node.js: import { Engine } from "@hypen-space/server/engine"

// ============================================================================
// APP / MODULE SYSTEM
// ============================================================================

export { app, HypenApp, HypenAppBuilder, HypenModuleInstance } from "./app.js";
export type {
  IEngine,
  ActionContext,
  GlobalContext,
  LifecycleHandler,
  ActionHandlerContext,
  ActionHandler,
  HypenModuleDefinition,
  HypenModule,
} from "./app.js";

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export {
  createObservableState,
  batchStateUpdates,
  getStateSnapshot,
} from "./state.js";
export type {
  StatePath,
  StateChange,
  StateObserverOptions,
} from "./state.js";

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

export { RemoteEngine } from "./remote/client.js";
export type {
  RemoteMessage,
  InitialTreeMessage,
  PatchMessage,
  DispatchActionMessage,
  StateUpdateMessage,
  RemoteClient,
  RemoteServerConfig,
} from "./remote/types.js";
export type {
  RemoteConnectionState,
  RemoteEngineOptions,
} from "./remote/client.js";

// ============================================================================
// DISPOSABLES (for event cleanup in @hypen-space/web)
// ============================================================================

export {
  DisposableStack,
  getElementDisposables,
  disposableListener,
  disposableTimeout,
  disposableInterval,
  disposableWebSocket,
  disposableAbortController,
  disposableSubscription,
} from "./disposable.js";
export type { Disposable } from "./disposable.js";

// ============================================================================
// LOGGER
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
