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
  }
}
