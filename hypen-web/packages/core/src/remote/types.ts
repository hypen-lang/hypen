/**
 * Remote UI Protocol Types
 */

import type { Patch } from "../types.js";
import type {
  DeviceAck,
  DeviceHello,
  DeviceResponse,
  DeviceEvent,
} from "./device/generated.js";

export type RemoteMessage =
  | InitialTreeMessage
  | PatchMessage
  | StateUpdateMessage
  | UpdateStateMessage
  | SubscribeStateMessage
  | DispatchActionMessage
  | HelloMessage
  | SessionAckMessage
  | SessionExpiredMessage
  // Device Capability Protocol (RFC 001) — client → server inbound messages.
  // Server → client device messages travel a separate `DeviceOutgoing` union
  // that is intentionally NOT part of `OutgoingMessage`.
  | DeviceResponse
  | DeviceEvent;

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
  /**
   * Resume credential from the last `sessionAck.resumeToken` for this
   * `sessionId` (RFC 001 §5 / Phase S). A session that negotiated a device
   * plane is resumed only when this matches; otherwise the hello starts a
   * NEW session — the public session id alone never resumes one. UI-only
   * sessions keep the legacy id-only resume (the token is then optional).
   */
  resumeToken?: string;
  /** Client metadata (platform, version, userId, etc.) */
  props?: Record<string, any>;
  /** Optional persist/routing key for Durable Object routing (withKey) */
  persistKey?: string;
  /**
   * Optional Device Capability Protocol extension (RFC 001 §2.2): the
   * client's complete initial capability advertisement. Absent for legacy
   * clients — the legacy wire is byte-identical without it, and device
   * access is simply disabled.
   */
  device?: DeviceHello;
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
  /**
   * Resume credential (RFC 001 §5 / Phase S), issued in every ack: ≥ 128
   * random bits, base64url, distinct from the public `sessionId`. The client
   * stores it with the session id and presents it as `hello.resumeToken`
   * when resuming; it is REQUIRED to resume a session that negotiated a
   * device plane (UI-only sessions also resume by id alone). Rotated on
   * every acknowledged connection — always keep the latest one. Legacy
   * clients simply ignore it.
   */
  resumeToken?: string;
  /**
   * Optional Device Capability Protocol extension (RFC 001 §2.2): the
   * server's exact-revision selection. Present only when the hello carried
   * a device advertisement and a common protocol version exists.
   */
  device?: DeviceAck;
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
   *
   * Compression is per message: the server negotiates both
   * `server_no_context_takeover` and `client_no_context_takeover`, so every
   * message is compressed on its own and never shares a DEFLATE history
   * with another. That is what makes it compatible with the device plane
   * (RFC 001 §2.3): compression and the device plane are independent — this
   * setting never turns the device plane off, and the device plane never
   * turns compression off. (A client whose socket negotiated context
   * takeover in either direction keeps that connection UI-only.)
   */
  compression?: boolean;
  /**
   * Browser `Origin` allowlist for the WebSocket upgrade (RFC 001 §5 / Phase
   * S) — a defence against cross-site WebSocket hijacking by BROWSERS, not
   * an authenticator (any non-browser client chooses its own Origin). An
   * upgrade that carries an `Origin` not listed here is rejected with 403
   * before any session exists. Exact normalized origins
   * (`scheme://host[:port]`), no wildcards.
   *
   * With an allowlist configured, an upgrade WITHOUT `Origin` (native
   * iOS/Android clients, CLIs) is admitted only by `authenticate`. With
   * neither allowlist nor authenticator every client is admitted and the
   * server logs one startup warning — set them in production.
   */
  allowedOrigins?: string[];
  /**
   * Application connection authenticator, called before the WebSocket
   * upgrade (RFC 001 §5, decision D1): check a bearer token, cookie or
   * signed query parameter and return true to admit. It runs for EVERY
   * upgrade when configured — including those with an allowed `Origin` —
   * and, when `allowedOrigins` is configured, it is the only way a request
   * without `Origin` is admitted (no authenticator ⇒ 403, fail closed).
   */
  authenticate?: (request: Request) => boolean | Promise<boolean>;
  /**
   * Largest WebSocket message accepted, in bytes (Bun `maxPayloadLength`).
   * Default: 4 MiB while the device plane is on (the default; device
   * messages themselves are capped at 1 MiB before parsing, RFC 001 §2.1,
   * the rest is headroom for UI `hello`/`updateState`), Bun's 16 MiB on a
   * UI-only server (`disableDevice()` or a device-incompatible setting).
   */
  maxPayloadLength?: number;
  /**
   * Serve the default browser client over plain HTTP (default: `true`).
   *
   * With it on, opening `http://host:port/` in a browser loads a small
   * page that connects back over WebSocket and renders the app with the
   * DOM renderer — so `hypen dev` gives you a working client out of the
   * box. Set to `false` to keep the pre-existing plain-text HTTP
   * responses (the WebSocket endpoint is unaffected either way).
   */
  webClient?: boolean;
}
