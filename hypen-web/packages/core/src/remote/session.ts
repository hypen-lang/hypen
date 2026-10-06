/**
 * Session Management for Remote UI
 *
 * Manages session lifecycle including:
 * - Creating new sessions
 * - Suspending sessions on disconnect (pending reconnection)
 * - Resuming sessions on reconnect
 * - Expiring sessions after TTL
 * - Handling concurrent connections
 */

import type { Session, SessionConfig } from "./types.js";

/**
 * Internal representation of a pending (disconnected) session
 */
interface PendingSession {
  session: Session;
  savedState: unknown;
  expiryTimer: ReturnType<typeof setTimeout>;
}

/**
 * Callback invoked when a session expires
 */
export type SessionExpireCallback = (session: Session) => void | Promise<void>;

/**
 * Manages session lifecycle for remote UI connections
 */
export class SessionManager {
  /** Active sessions (currently connected) */
  private activeSessions = new Map<string, Session>();

  /** Pending sessions (disconnected, waiting for reconnect within TTL) */
  private pendingSessions = new Map<string, PendingSession>();

  /** Maps session ID to connected WebSocket(s) for concurrent handling */
  private sessionConnections = new Map<string, Set<unknown>>();

  /**
   * Current resume credential per session id (RFC 001 §5 / Phase S). Kept
   * here, never on the `Session` object handed to user hooks.
   */
  private resumeTokens = new Map<string, string>();

  /**
   * Session ids that negotiated a device plane on some connection. Resuming
   * one of these requires its resume token; every other session keeps the
   * legacy id-only resume (RFC 001 §5).
   */
  private deviceSessions = new Set<string>();

  /** Resolved configuration with defaults */
  private config: Required<SessionConfig>;

  constructor(config: SessionConfig = {}) {
    this.config = {
      ttl: config.ttl ?? 3600, // 1 hour default
      concurrent: config.concurrent ?? "kick-old",
      generateId: config.generateId ?? (() => crypto.randomUUID()),
    };
  }

  /**
   * Get the configured TTL in seconds
   */
  getTtl(): number {
    return this.config.ttl;
  }

  /**
   * Get the concurrent connection policy
   */
  getConcurrentPolicy(): "kick-old" | "reject-new" | "allow-multiple" {
    return this.config.concurrent;
  }

  /**
   * Create a new session
   */
  createSession(props?: Record<string, any>): Session {
    const now = new Date();
    const session: Session = {
      id: this.config.generateId(),
      ttl: this.config.ttl,
      createdAt: now,
      lastConnectedAt: now,
      props,
    };
    this.activeSessions.set(session.id, session);
    return session;
  }

  /**
   * Re-adopt a session id supplied by a trusted transport recovery channel.
   *
   * This is intentionally separate from `createSession`: ordinary client
   * hello messages must not be allowed to choose their own id. Cloudflare's
   * hibernation API, however, stores the server-issued id on the accepted
   * socket and needs to reconstruct the in-memory SessionManager after the
   * Durable Object itself has been evicted.
   */
  recoverSession(id: string, props?: Record<string, any>): Session {
    const now = new Date();
    const session: Session = {
      id,
      ttl: this.config.ttl,
      createdAt: now,
      lastConnectedAt: now,
      props,
    };
    this.activeSessions.set(id, session);
    return session;
  }

  /**
   * Issue (rotate) the resume credential for `sessionId`: 256 random bits,
   * base64url. The previous token for that session stops working.
   */
  issueResumeToken(sessionId: string): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    this.resumeTokens.set(sessionId, token);
    return token;
  }

  /**
   * Record that `sessionId` negotiated a device plane: from now on only its
   * current resume token resumes (or takes over) it. Sticky for the life of
   * the session.
   */
  markDeviceSession(sessionId: string): void {
    this.deviceSessions.add(sessionId);
  }

  /**
   * Whether resuming `sessionId` requires a valid resume token — true only
   * for a session that negotiated a device plane.
   */
  requiresResumeToken(sessionId: string): boolean {
    return this.deviceSessions.has(sessionId);
  }

  /**
   * Whether `token` is the current resume credential for `sessionId`.
   * Constant-time over the token contents.
   */
  verifyResumeToken(sessionId: string, token: string | undefined): boolean {
    const expected = this.resumeTokens.get(sessionId);
    if (expected === undefined || typeof token !== "string") return false;
    // Token length is fixed and public; only the contents are secret.
    if (token.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Get an active (connected) session by ID
   */
  getActiveSession(id: string): Session | null {
    return this.activeSessions.get(id) ?? null;
  }

  /**
   * Get a pending (disconnected) session by ID
   */
  getPendingSession(id: string): PendingSession | null {
    return this.pendingSessions.get(id) ?? null;
  }

  /**
   * Check if a session exists (either active or pending)
   */
  hasSession(id: string): boolean {
    return this.activeSessions.has(id) || this.pendingSessions.has(id);
  }

  /**
   * Suspend a session when client disconnects
   * Moves from active to pending with a TTL timer
   *
   * @param sessionId - The session to suspend
   * @param savedState - State snapshot to restore on reconnect
   * @param onExpire - Callback when TTL expires
   */
  suspendSession(
    sessionId: string,
    savedState: unknown,
    onExpire: SessionExpireCallback
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Remove from active
    this.activeSessions.delete(sessionId);

    // Set up expiry timer
    const expiryTimer = setTimeout(async () => {
      const pending = this.pendingSessions.get(sessionId);
      if (pending) {
        this.pendingSessions.delete(sessionId);
        this.resumeTokens.delete(sessionId);
        this.deviceSessions.delete(sessionId);
        await onExpire(pending.session);
      }
    }, session.ttl * 1000);

    // Add to pending
    this.pendingSessions.set(sessionId, {
      session,
      savedState,
      expiryTimer,
    });
  }

  /**
   * Resume a pending session when client reconnects
   *
   * @param sessionId - The session to resume
   * @returns Session and saved state, or null if not found/expired
   */
  resumeSession(
    sessionId: string
  ): { session: Session; savedState: unknown } | null {
    const pending = this.pendingSessions.get(sessionId);
    if (!pending) return null;

    // Clear expiry timer
    clearTimeout(pending.expiryTimer);
    this.pendingSessions.delete(sessionId);

    // Update last connected time
    pending.session.lastConnectedAt = new Date();

    // Move back to active
    this.activeSessions.set(sessionId, pending.session);

    return {
      session: pending.session,
      savedState: pending.savedState,
    };
  }

  /**
   * Destroy a session completely (both active and pending)
   */
  destroySession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.resumeTokens.delete(sessionId);
    this.deviceSessions.delete(sessionId);

    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      clearTimeout(pending.expiryTimer);
      this.pendingSessions.delete(sessionId);
    }

    this.sessionConnections.delete(sessionId);
  }

  /**
   * Track a WebSocket connection for a session
   * Used for concurrent connection handling
   */
  trackConnection(sessionId: string, ws: unknown): void {
    let connections = this.sessionConnections.get(sessionId);
    if (!connections) {
      connections = new Set();
      this.sessionConnections.set(sessionId, connections);
    }
    connections.add(ws);
  }

  /**
   * Untrack a WebSocket connection
   */
  untrackConnection(sessionId: string, ws: unknown): void {
    const connections = this.sessionConnections.get(sessionId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        this.sessionConnections.delete(sessionId);
      }
    }
  }

  /**
   * Get all connections for a session
   */
  getConnections(sessionId: string): Set<unknown> | undefined {
    return this.sessionConnections.get(sessionId);
  }

  /**
   * Get connection count for a session
   */
  getConnectionCount(sessionId: string): number {
    return this.sessionConnections.get(sessionId)?.size ?? 0;
  }

  /**
   * Get stats about current sessions
   */
  getStats(): {
    activeSessions: number;
    pendingSessions: number;
    totalConnections: number;
  } {
    let totalConnections = 0;
    for (const connections of this.sessionConnections.values()) {
      totalConnections += connections.size;
    }

    return {
      activeSessions: this.activeSessions.size,
      pendingSessions: this.pendingSessions.size,
      totalConnections,
    };
  }

  /**
   * Clean up all sessions and timers
   * Call this when shutting down the server
   */
  destroy(): void {
    // Clear all pending session timers
    for (const pending of this.pendingSessions.values()) {
      clearTimeout(pending.expiryTimer);
    }

    this.activeSessions.clear();
    this.pendingSessions.clear();
    this.sessionConnections.clear();
    this.resumeTokens.clear();
    this.deviceSessions.clear();
  }
}
