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
  // External capability surface (see engine-base `listActions` et al.)
  AgentAction,
  AgentRoute,
  BoundInput,
} from "./types.js";

export {
  AGENT_NAVIGATE,
  AGENT_BACK,
  AGENT_SET_INPUT,
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

// ============================================================================
// ANIMATION (__anim.* prop channel — shared renderer vocabulary)
// ============================================================================

export {
  ANIM_PROP_PREFIX,
  ANIM_TRANSITION_PROP,
  ANIM_ENTER_PROP,
  ANIM_EXIT_PROP,
  ANIM_LAYOUT_PROP,
  ANIM_PROP_ANIMATE,
  ANIM_MOTION_PROP,
  ANIM_STATES_PROP,
  ANIM_SHARED_KEY_PROP,
  ANIM_SHARED_PROP,
  ANIM_SCRUB_PROP,
  ANIM_SCRUB_SETTLE_PROP,
  ANIM_SCRUB_BIND_PROP,
  ANIM_SCRUB_POSES_PROP,
  SCRUB_SOURCES,
  SCRUB_AXES,
  ANIM_CURVES,
  ANIM_PRESETS,
  ANIM_DIRECTIONS,
  ANIMATE_PRESETS,
  CURVE_TO_CSS,
  ANIMATABLE_PROPS,
  ENTER_EXIT_PRESETS,
  SLIDE_OFFSET_PX,
  SCALE_HIDDEN_FACTOR,
  CURVE_BEZIER_POINTS,
  cssPropertiesFor,
  presetHiddenStyles,
  parseAnimProps,
  parseStatesLabel,
  parseMotionEssential,
  parseSharedKey,
  parseSharedSpec,
  parseScrubSpec,
  parseScrubSettle,
  parseScrubBind,
  parseScrubPoses,
  scrubProgress,
  animatableBaseProp,
  parseColorValue,
  interpolateColor,
  cubicBezier,
  curveFunction,
} from "./animation.js";
export type {
  AnimCurve,
  EasingFunction,
  AnimPreset,
  AnimDirection,
  AnimRepeat,
  AnimatePreset,
  AnimatePresetDefaults,
  TransitionSpec,
  EnterSpec,
  ExitSpec,
  LayoutSpec,
  SharedSpec,
  AnimateSpec,
  NodeAnimSpecs,
  PresetHiddenStyle,
  ScrubSource,
  ScrubAxis,
  ScrubSpec,
  ScrubSettleSpec,
  ScrubPoses,
  RgbaColor,
} from "./animation.js";

// ============================================================================
// DRAG & DROP (__dnd.* prop channel — shared renderer vocabulary)
// ============================================================================

export {
  DND_PROP_PREFIX,
  DND_SOURCE_PROP,
  DND_SOURCE_PAYLOAD_PROP,
  DND_SOURCE_ENABLED_PROP,
  DND_KEY_PROP,
  DND_ZONE_PROP,
  DND_ZONE_ID_PROP,
  DND_ZONE_ENABLED_PROP,
  DND_SORT_PROP,
  DND_PIN_PROP,
  DND_PIN_GROUP_PROP,
  DND_PROPS,
  DND_REORDER_ACTION,
  DND_PIN_ACTION,
  DND_RESERVED_STATE_KEY,
  DND_EVENT_NAMES,
  DND_DRAG_OVER_DWELL_KEY,
  DND_DEFAULT_DWELL_MS,
  DND_LABEL_LIFTED,
  DND_LABEL_OVER,
  DND_ACTIVATIONS,
  DND_AXES,
  DND_BOUNDS,
  DND_UNITS,
  DND_DEFAULT_BAND,
  parseDndSource,
  parseDndZone,
  fileDragMatchesAccept,
  parseDndSort,
  parseDndPin,
  parseDndEnabled,
  parseDndString,
  resolveBand,
  snapToGrid,
  reservedPinPath,
  userPinPath,
  applyPathMove,
  KeyboardDragMachine,
} from "./dnd.js";
export type {
  DndEventName,
  DndActivation,
  DndAxis,
  DndBounds,
  DndUnits,
  DndSourceSpec,
  DndZoneSpec,
  DndSortSpec,
  DndPinSpec,
  DndLocation,
  DndEventPayload,
  DndReorderPayload,
  DndReorderShorthandPayload,
  DndPinPayload,
  DndBandResult,
  KeyboardDragState,
  KeyboardDragZone,
  KeyboardDragDirection,
} from "./dnd.js";

export { dispatchUIAction } from "./ui-action";
