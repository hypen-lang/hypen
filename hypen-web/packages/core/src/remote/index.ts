/**
 * Remote UI client and session management for Hypen
 *
 * Client-side: Connect to remote Hypen apps via RemoteEngine
 * Session: Manage client sessions with SessionManager
 *
 * Note: RemoteServer has moved to @hypen-space/server
 */

// Client
export { RemoteEngine } from "./client.js";
export type {
  RemoteConnectionState,
  RemoteEngineOptions,
  NavigationOptions,
  SessionOptions,
  SessionInfo,
} from "./client.js";

// NOTE: RemoteServer has moved to @hypen-space/server
// Import it from: import { RemoteServer } from "@hypen-space/server/remote"

// Session Management
export { SessionManager } from "./session.js";
export type { SessionExpireCallback } from "./session.js";

// Types
export type {
  RemoteMessage,
  InitialTreeMessage,
  PatchMessage,
  DispatchActionMessage,
  StateUpdateMessage,
  UpdateStateMessage,
  SubscribeStateMessage,
  HelloMessage,
  SessionAckMessage,
  SessionExpiredMessage,
  Session,
  SessionConfig,
  RemoteClient,
  RemoteServerConfig,
} from "./types.js";

// Re-export Patch type
export type { Patch } from "../types.js";
