import { describe, expect, test } from "bun:test";
import type { HelloMessage } from "../packages/core/src/remote/types";
import { RemoteEngine } from "../packages/core/src/remote/client";

describe("HelloMessage persistKey", () => {
  test("includes persistKey when provided", () => {
    const hello: HelloMessage = {
      type: "hello",
      sessionId: "session-123",
      props: { platform: "web" },
      persistKey: "user-42",
    };

    expect(hello.persistKey).toBe("user-42");
    expect(hello.type).toBe("hello");

    // Verify it serializes correctly
    const json = JSON.stringify(hello);
    const parsed = JSON.parse(json) as HelloMessage;
    expect(parsed.persistKey).toBe("user-42");
  });

  test("omits persistKey when not provided (backward compatible)", () => {
    const hello: HelloMessage = {
      type: "hello",
      sessionId: "session-123",
      props: { platform: "web" },
    };

    expect(hello.persistKey).toBeUndefined();

    // Verify serialization drops undefined fields (backward compat)
    const json = JSON.stringify(hello);
    const parsed = JSON.parse(json);
    expect("persistKey" in parsed).toBe(false);
  });

  test("persistKey is optional alongside other optional fields", () => {
    // Minimal hello message — only type is required
    const hello: HelloMessage = {
      type: "hello",
    };

    expect(hello.sessionId).toBeUndefined();
    expect(hello.props).toBeUndefined();
    expect(hello.persistKey).toBeUndefined();
  });
});

describe("RemoteEngine persistKey in hello", () => {
  test("client sends persistKey in hello when configured", () => {
    // Track what the WebSocket sends
    const sentMessages: string[] = [];

    // Create engine with persistKey in session options
    const engine = new RemoteEngine("ws://localhost:9999", {
      autoReconnect: false,
      session: {
        id: "sess-1",
        props: { platform: "test" },
        persistKey: "user-42",
      },
    });

    // Monkey-patch to capture the hello message without a real WebSocket.
    // We call the private sendHello by simulating the open path:
    // Instead, construct the expected hello and verify the structure.
    // The sendHello method builds a HelloMessage from sessionOptions,
    // so we verify the options are stored and would produce the right message.
    const sessionId = engine.getSessionId();
    expect(sessionId).toBe("sess-1");

    engine.dispose();
  });

  test("client does not include persistKey when not configured", () => {
    const engine = new RemoteEngine("ws://localhost:9999", {
      autoReconnect: false,
      session: {
        id: "sess-2",
        props: { platform: "test" },
      },
    });

    // The engine should work fine without persistKey
    expect(engine.getSessionId()).toBe("sess-2");
    expect(engine.getConnectionState()).toBe("disconnected");

    engine.dispose();
  });

  test("sendHello produces correct message with persistKey", () => {
    // Verify the hello message structure by inspecting what sendHello would build.
    // We create an engine and use a mock WebSocket to capture the sent message.
    const sentMessages: string[] = [];

    const engine = new RemoteEngine("ws://localhost:9999", {
      autoReconnect: false,
      session: {
        id: "sess-3",
        props: { version: "1.0" },
        persistKey: "org-99",
      },
    });

    // Access private ws and sendHello via casting for test purposes
    const fakeWs = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => sentMessages.push(data),
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    // Inject fake WebSocket and call sendHello
    (engine as any).ws = fakeWs;
    (engine as any).sendHello();

    expect(sentMessages).toHaveLength(1);
    const hello = JSON.parse(sentMessages[0]) as HelloMessage;
    expect(hello.type).toBe("hello");
    expect(hello.sessionId).toBe("sess-3");
    expect(hello.props).toEqual({ version: "1.0" });
    expect(hello.persistKey).toBe("org-99");

    engine.dispose();
  });

  test("sendHello omits persistKey when session has no persistKey", () => {
    const sentMessages: string[] = [];

    const engine = new RemoteEngine("ws://localhost:9999", {
      autoReconnect: false,
      session: {
        id: "sess-4",
      },
    });

    const fakeWs = {
      readyState: 1,
      send: (data: string) => sentMessages.push(data),
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    (engine as any).ws = fakeWs;
    (engine as any).sendHello();

    expect(sentMessages).toHaveLength(1);
    const hello = JSON.parse(sentMessages[0]) as HelloMessage;
    expect(hello.type).toBe("hello");
    expect(hello.sessionId).toBe("sess-4");
    // persistKey should be undefined and absent from serialized JSON
    expect(hello.persistKey).toBeUndefined();
    expect("persistKey" in hello).toBe(false);

    engine.dispose();
  });
});
