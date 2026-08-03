/**
 * Remote UI Protocol Types
 */

import type { Patch } from "../types.js";

export type RemoteMessage =
  | InitialTreeMessage
  | PatchMessage
  | StateUpdateMessage
  | UpdateStateMessage
  | SubscribeStateMessage
  | DispatchActionMessage
  | HelloMessage
  | SessionAckMessage
  | SessionExpiredMessage;

export interface InitialTreeMessage {
  type: "initialTree";
  module: string;
  state: any;
  patches: Patch[];
  revision: number;
}

export interface PatchMessage {
  type: "patch";
  module: string;
  patches: Patch[];
  revision: number;
}

export interface StateUpdateMessage {
  type: "stateUpdate";
  module: string;
  state: any;
  revision: number;
}

export interface DispatchActionMessage {
  type: "dispatchAction";
  module: string;
  action: string;
  payload?: any;
}

/**
 * Client → Server: Override the module's state (e.g. for time-travel)
 * Server will update the module instance and re-render, sending back
 * patch + stateUpdate messages.
 */
export interface UpdateStateMessage {
  type: "updateState";
  module: string;
  state: any;
}

/**
 * Client → Server: Opt-in to receiving stateUpdate messages after each render.
 * Only subscribed clients receive state snapshots (e.g. Studio for time-travel).
 */
export interface SubscribeStateMessage {
  type: "subscribeState";
}

/**
 * Client → Server: First message after WebSocket opens
 * Used to establish or resume a session
 */
export interface HelloMessage {
  type: "hello";
  /** Session ID to resume (omit for new session) */
  sessionId?: string;
  /** Client metadata (platform, version, userId, etc.) */
  props?: Record<string, any>;
  /** Optional persist/routing key for Durable Object routing (withKey) */
  persistKey?: string;
}

/**
 * Server → Client: Response to HelloMessage
 * Confirms session establishment
 */
export interface SessionAckMessage {
  type: "sessionAck";
  /** The session ID (generated or resumed) */
  sessionId: string;
  /** True if this is a new session */
  isNew: boolean;
  /** True if state was restored from a previous session */
  isRestored: boolean;
}

/**
 * Server → Client: Session termination notification
 * Sent when session is kicked or expires
 */
export interface SessionExpiredMessage {
  type: "sessionExpired";
  sessionId: string;
  reason: "ttl" | "kicked" | "manual";
}

/**
 * Session information passed to lifecycle hooks
 */
export interface Session {
  /** Unique session identifier */
  id: string;
  /** Time-to-live in seconds */
  ttl: number;
  /** When the session was first created */
  createdAt: Date;
  /** When the client last connected */
  lastConnectedAt: Date;
  /** Client-provided metadata */
  props?: Record<string, any>;
}

/**
 * Configuration for session management
 */
export interface SessionConfig {
  /** Session TTL in seconds (default: 3600 = 1 hour) */
  ttl?: number;
  /** How to handle concurrent connections with same sessionId */
  concurrent?: "kick-old" | "reject-new" | "allow-multiple";
  /** Custom session ID generator */
  generateId?: () => string;
}

export interface RemoteClient {
  id: string;
  socket: any;
  connectedAt: Date;
}

export interface RemoteServerConfig {
  port?: number;
  hostname?: string;
  /**
   * Negotiate WebSocket `permessage-deflate` compression (default: `true`).
   *
   * Patch streams are JSON and compress well, so this is on by default.
   * Compression is negotiated per-connection during the upgrade handshake:
   * clients that don't offer the extension (e.g. the desktop renderer's
   * tokio-tungstenite client) transparently fall back to uncompressed frames.
   *
   * Set to `false` to opt out — useful when inspecting the raw wire in a proxy
   * or packet capture.
   */
  compression?: boolean;
}
