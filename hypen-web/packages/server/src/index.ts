/**
 * @hypen-space/server - Hypen Server Runtime
 *
 * Node.js/Bun server runtime providing the WASM engine, component loader,
 * discovery, and remote server for streaming Hypen apps over WebSocket.
 *
 * @example
 * ```typescript
 * import { Engine, ComponentLoader, discoverComponents, RemoteServer } from "@hypen-space/server";
 * ```
 */

// ============================================================================
// ENGINE (Node.js WASM wrapper)
// ============================================================================

export { Engine } from "./engine.js";

// ============================================================================
// COMPONENT LOADER
// ============================================================================

export { ComponentLoader, componentLoader } from "./loader.js";
export type { ComponentDefinition } from "./loader.js";

// ============================================================================
// COMPONENT DISCOVERY
// ============================================================================

export {
  discoverComponents,
  loadDiscoveredComponents,
  watchComponents,
  generateComponentsCode,
} from "./discovery.js";
export type {
  DiscoveredComponent,
  DiscoveryOptions,
  WatchOptions,
} from "./discovery.js";

// ============================================================================
// PLUGIN (Bun plugin for .hypen imports)
// ============================================================================

export {
  hypenPlugin,
  defaultHypenPlugin,
  registerHypenPlugin,
} from "./plugin.js";
export type { HypenPluginOptions } from "./plugin.js";

// ============================================================================
// REMOTE SERVER
// ============================================================================

export {
  RemoteServer,
  serve,
  OPEN_ADMISSION_WARNING,
  type RemoteDeviceOptions,
} from "./remote/server.js";
export {
  createWasmDeviceBrokerFactory,
  WasmDeviceBroker,
  WasmRetainedBytesPool,
} from "./device-broker.js";
export type {
  WasmDeviceBrokerFactory,
  WasmDeviceBrokerFactoryOptions,
} from "./device-broker.js";
export { AgentHandle, AgentSessionGoneError } from "./remote/agent-handle.js";
export type { AgentHandleEngine } from "./remote/agent-handle.js";
export type { AgentOptions } from "./remote/agent-http.js";
export {
  RemoteSession,
  AsyncQueueTransport,
  createBunWebSocketTransport,
} from "./remote/session.js";
export type {
  OutgoingMessage,
  SessionTransport,
  SessionHost,
  RemoteSessionOptions,
} from "./remote/session.js";
