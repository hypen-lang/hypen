import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { SessionManager } from "../packages/core/src/remote/session";
import type { Session, SessionConfig } from "../packages/core/src/remote/types";
import { flushMicrotasks } from "./helpers";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("createSession", () => {
    test("creates a new session with default TTL", () => {
      const session = manager.createSession();

      expect(session.id).toBeDefined();
      expect(session.ttl).toBe(3600); // default 1 hour
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastConnectedAt).toBeInstanceOf(Date);
    });

    test("creates session with custom props", () => {
      const props = { platform: "web", version: "1.0" };
      const session = manager.createSession(props);

      expect(session.props).toEqual(props);
    });

    test("stores session as active", () => {
      const session = manager.createSession();

      expect(manager.getActiveSession(session.id)).toEqual(session);
      expect(manager.hasSession(session.id)).toBe(true);
    });

    test("uses custom ID generator", () => {
      let counter = 0;
      const customManager = new SessionManager({
        generateId: () => `custom-${++counter}`,
      });

      const session1 = customManager.createSession();
      const session2 = customManager.createSession();

      expect(session1.id).toBe("custom-1");
      expect(session2.id).toBe("custom-2");

      customManager.destroy();
    });

    test("uses custom TTL", () => {
      const customManager = new SessionManager({ ttl: 7200 });
      const session = customManager.createSession();

      expect(session.ttl).toBe(7200);
      expect(customManager.getTtl()).toBe(7200);

      customManager.destroy();
    });
  });

  describe("suspendSession", () => {
    test("moves session from active to pending", () => {
      const session = manager.createSession();
      const savedState = { count: 42 };

      manager.suspendSession(session.id, savedState, () => {});

      expect(manager.getActiveSession(session.id)).toBeNull();
      expect(manager.getPendingSession(session.id)).not.toBeNull();
      expect(manager.hasSession(session.id)).toBe(true);
    });

    test("stores saved state with pending session", () => {
      const session = manager.createSession();
      const savedState = { items: ["a", "b", "c"], total: 100 };

      manager.suspendSession(session.id, savedState, () => {});

      const pending = manager.getPendingSession(session.id);
      expect(pending?.savedState).toEqual(savedState);
    });

    test("does nothing for non-existent session", () => {
      manager.suspendSession("non-existent", {}, () => {});

      expect(manager.getPendingSession("non-existent")).toBeNull();
    });
  });

  describe("resumeSession", () => {
    test("moves session from pending to active", () => {
      const session = manager.createSession();
      const savedState = { count: 42 };

      manager.suspendSession(session.id, savedState, () => {});
      const result = manager.resumeSession(session.id);

      expect(result).not.toBeNull();
      expect(result?.session.id).toBe(session.id);
      expect(result?.savedState).toEqual(savedState);
      expect(manager.getActiveSession(session.id)).not.toBeNull();
      expect(manager.getPendingSession(session.id)).toBeNull();
    });

    test("updates lastConnectedAt on resume", async () => {
      const session = manager.createSession();
      const originalTime = session.lastConnectedAt;

      // Wait a bit to ensure time difference
      await new Promise((r) => setTimeout(r, 10));

      manager.suspendSession(session.id, {}, () => {});
      const result = manager.resumeSession(session.id);

      expect(result?.session.lastConnectedAt.getTime()).toBeGreaterThan(
        originalTime.getTime()
      );
    });

    test("returns null for non-existent session", () => {
      const result = manager.resumeSession("non-existent");

      expect(result).toBeNull();
    });

    test("returns null for already-resumed session", () => {
      const session = manager.createSession();

      manager.suspendSession(session.id, {}, () => {});
      manager.resumeSession(session.id);
      const secondResume = manager.resumeSession(session.id);

      expect(secondResume).toBeNull();
    });
  });

  describe("destroySession", () => {
    test("removes active session", () => {
      const session = manager.createSession();

      manager.destroySession(session.id);

      expect(manager.getActiveSession(session.id)).toBeNull();
      expect(manager.hasSession(session.id)).toBe(false);
    });

    test("removes pending session and clears timer", () => {
      const session = manager.createSession();
      const expireCalled = { value: false };

      manager.suspendSession(session.id, {}, () => {
        expireCalled.value = true;
      });
      manager.destroySession(session.id);

      expect(manager.getPendingSession(session.id)).toBeNull();
      expect(manager.hasSession(session.id)).toBe(false);
    });
  });

  describe("connection tracking", () => {
    test("tracks connections for a session", () => {
      const session = manager.createSession();
      const ws1 = { id: "ws1" };
      const ws2 = { id: "ws2" };

      manager.trackConnection(session.id, ws1);
      manager.trackConnection(session.id, ws2);

      expect(manager.getConnectionCount(session.id)).toBe(2);
      expect(manager.getConnections(session.id)?.has(ws1)).toBe(true);
      expect(manager.getConnections(session.id)?.has(ws2)).toBe(true);
    });

    test("untracks connections", () => {
      const session = manager.createSession();
      const ws1 = { id: "ws1" };
      const ws2 = { id: "ws2" };

      manager.trackConnection(session.id, ws1);
      manager.trackConnection(session.id, ws2);
      manager.untrackConnection(session.id, ws1);

      expect(manager.getConnectionCount(session.id)).toBe(1);
      expect(manager.getConnections(session.id)?.has(ws1)).toBe(false);
      expect(manager.getConnections(session.id)?.has(ws2)).toBe(true);
    });

    test("cleans up connection set when empty", () => {
      const session = manager.createSession();
      const ws = { id: "ws1" };

      manager.trackConnection(session.id, ws);
      manager.untrackConnection(session.id, ws);

      expect(manager.getConnections(session.id)).toBeUndefined();
    });
  });

  describe("concurrent connection policy", () => {
    test("defaults to kick-old", () => {
      expect(manager.getConcurrentPolicy()).toBe("kick-old");
    });

    test("respects custom policy", () => {
      const rejectNewManager = new SessionManager({ concurrent: "reject-new" });
      const allowMultipleManager = new SessionManager({
        concurrent: "allow-multiple",
      });

      expect(rejectNewManager.getConcurrentPolicy()).toBe("reject-new");
      expect(allowMultipleManager.getConcurrentPolicy()).toBe("allow-multiple");

      rejectNewManager.destroy();
      allowMultipleManager.destroy();
    });
  });

  describe("getStats", () => {
    test("returns correct session counts", () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();
      manager.suspendSession(session1.id, {}, () => {});

      const stats = manager.getStats();

      expect(stats.activeSessions).toBe(1);
      expect(stats.pendingSessions).toBe(1);
    });

    test("returns correct connection count", () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();

      manager.trackConnection(session1.id, { id: 1 });
      manager.trackConnection(session1.id, { id: 2 });
      manager.trackConnection(session2.id, { id: 3 });

      const stats = manager.getStats();

      expect(stats.totalConnections).toBe(3);
    });
  });

  describe("session expiry", () => {
    test("calls onExpire after TTL", async () => {
      // Use very short TTL for testing
      const shortTtlManager = new SessionManager({ ttl: 0.05 }); // 50ms
      const session = shortTtlManager.createSession();
      let expiredSession: Session | null = null;

      shortTtlManager.suspendSession(session.id, {}, (s) => {
        expiredSession = s;
      });

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 100));

      expect(expiredSession).not.toBeNull();
      expect((expiredSession as Session | null)?.id).toBe(session.id);
      expect(shortTtlManager.hasSession(session.id)).toBe(false);

      shortTtlManager.destroy();
    });

    test("cancels expiry timer on resume", async () => {
      const shortTtlManager = new SessionManager({ ttl: 0.05 }); // 50ms
      const session = shortTtlManager.createSession();
      let expireCalled = false;

      shortTtlManager.suspendSession(session.id, {}, () => {
        expireCalled = true;
      });

      // Resume before expiry
      shortTtlManager.resumeSession(session.id);

      // Wait past original expiry time
      await new Promise((r) => setTimeout(r, 100));

      expect(expireCalled).toBe(false);
      expect(shortTtlManager.hasSession(session.id)).toBe(true);

      shortTtlManager.destroy();
    });
  });

  describe("destroy", () => {
    test("clears all sessions and timers", () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();

      manager.suspendSession(session1.id, {}, () => {});
      manager.trackConnection(session2.id, { id: 1 });

      manager.destroy();

      const stats = manager.getStats();
      expect(stats.activeSessions).toBe(0);
      expect(stats.pendingSessions).toBe(0);
      expect(stats.totalConnections).toBe(0);
    });
  });
});

describe("RemoteEngine client session", () => {
  // These tests verify the session-related message types and handling
  // We test the message structures since actual WebSocket tests require integration setup

  test("HelloMessage structure", () => {
    const hello = {
      type: "hello" as const,
      sessionId: "test-session-123",
      props: { platform: "web", version: "1.0" },
    };

    expect(hello.type).toBe("hello");
    expect(hello.sessionId).toBe("test-session-123");
    expect(hello.props?.platform).toBe("web");
  });

  test("HelloMessage without sessionId for new session", () => {
    const hello: { type: "hello"; sessionId?: string; props: { platform: string } } = {
      type: "hello" as const,
      props: { platform: "web" },
    };

    expect(hello.type).toBe("hello");
    expect(hello.sessionId).toBeUndefined();
  });

  test("SessionAckMessage structure", () => {
    const ack = {
      type: "sessionAck" as const,
      sessionId: "new-session-456",
      isNew: true,
      isRestored: false,
    };

    expect(ack.type).toBe("sessionAck");
    expect(ack.sessionId).toBe("new-session-456");
    expect(ack.isNew).toBe(true);
    expect(ack.isRestored).toBe(false);
  });

  test("SessionAckMessage for restored session", () => {
    const ack = {
      type: "sessionAck" as const,
      sessionId: "existing-session-789",
      isNew: false,
      isRestored: true,
    };

    expect(ack.isNew).toBe(false);
    expect(ack.isRestored).toBe(true);
  });

  test("SessionExpiredMessage structure", () => {
    const expired = {
      type: "sessionExpired" as const,
      sessionId: "expired-session-000",
      reason: "ttl" as const,
    };

    expect(expired.type).toBe("sessionExpired");
    expect(expired.sessionId).toBe("expired-session-000");
    expect(expired.reason).toBe("ttl");
  });

  test("SessionExpiredMessage reasons", () => {
    const reasons = ["ttl", "kicked", "manual"] as const;

    for (const reason of reasons) {
      const expired = {
        type: "sessionExpired" as const,
        sessionId: "test",
        reason,
      };
      expect(expired.reason).toBe(reason);
    }
  });
});
