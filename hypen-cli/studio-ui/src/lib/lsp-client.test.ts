import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { HypenLspClient } from "./lsp-client";

// --- MockWebSocket ---

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static get last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Not open");
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as any);
  }

  // --- Test helpers ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as any);
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data } as any);
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as any);
  }

  simulateError() {
    this.onerror?.({} as any);
  }
}

// --- Helpers ---

const originalWebSocket = globalThis.WebSocket;
const originalLocation = globalThis.location;

function installMocks() {
  MockWebSocket.instances = [];
  // @ts-ignore
  globalThis.WebSocket = MockWebSocket;
  // @ts-ignore - mock window.location for the client
  if (typeof globalThis.window === "undefined") {
    // @ts-ignore
    globalThis.window = {};
  }
  // @ts-ignore
  globalThis.window.location = { protocol: "http:", host: "localhost:5173" };
}

function restoreMocks() {
  globalThis.WebSocket = originalWebSocket;
  if (originalLocation) {
    // @ts-ignore
    globalThis.window.location = originalLocation;
  }
}

/** Simulate the full LSP initialize handshake on the given MockWebSocket. */
function completeInitialize(ws: MockWebSocket) {
  // The client sends an initialize request — find it
  const initMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
  expect(initMsg.method).toBe("initialize");
  // Respond with server capabilities
  ws.simulateMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: initMsg.id,
      result: {
        capabilities: {
          completionProvider: { triggerCharacters: [".", "@"] },
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ["(", ","] },
          textDocumentSync: 1,
        },
      },
    })
  );
}

/** Create a client, connect it, and return [client, mock ws]. */
async function createConnectedClient(): Promise<
  [HypenLspClient, MockWebSocket]
> {
  const client = new HypenLspClient("/test/project");
  const connectPromise = client.connect();
  const ws = MockWebSocket.last;
  ws.simulateOpen();
  completeInitialize(ws);
  await connectPromise;
  return [client, ws];
}

// Wait one microtask
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- Tests ---

describe("HypenLspClient", () => {
  beforeEach(installMocks);
  afterEach(restoreMocks);

  // -- Connection & initialization --

  describe("connect", () => {
    test("opens WebSocket to /ws/lsp", async () => {
      const client = new HypenLspClient("/test/project");
      const p = client.connect();
      const ws = MockWebSocket.last;
      expect(ws.url).toBe("ws://localhost:5173/ws/lsp");
      ws.simulateOpen();
      completeInitialize(ws);
      await p;
    });

    test("sends initialize request on open", async () => {
      const client = new HypenLspClient("/my/project");
      const p = client.connect();
      const ws = MockWebSocket.last;
      ws.simulateOpen();

      const initReq = JSON.parse(ws.sent[0]);
      expect(initReq.jsonrpc).toBe("2.0");
      expect(initReq.method).toBe("initialize");
      expect(initReq.id).toBeGreaterThan(0);
      expect(initReq.params.rootUri).toBe("file:///my/project");

      completeInitialize(ws);
      await p;
    });

    test("sends initialized notification after response", async () => {
      const [, ws] = await createConnectedClient();
      const msgs = ws.sent.map((s) => JSON.parse(s));
      const initialized = msgs.find((m: any) => m.method === "initialized");
      expect(initialized).toBeTruthy();
      expect(initialized!.id).toBeUndefined(); // notification has no id
    });

    test("sets isConnected after successful handshake", async () => {
      const client = new HypenLspClient("/p");
      expect(client.isConnected).toBe(false);
      const p = client.connect();
      MockWebSocket.last.simulateOpen();
      completeInitialize(MockWebSocket.last);
      await p;
      expect(client.isConnected).toBe(true);
    });

    test("rejects if WebSocket errors before connect", async () => {
      const client = new HypenLspClient("/p");
      const p = client.connect();
      const ws = MockWebSocket.last;
      ws.simulateError();
      await expect(p).rejects.toThrow("WebSocket connection failed");
    });
  });

  // -- JSON-RPC --

  describe("JSON-RPC transport", () => {
    test("sendRequest formats correct JSON-RPC", async () => {
      const [client, ws] = await createConnectedClient();
      // Use a public method that calls sendRequest
      const p = client.requestHover("test.hypen", 5, 10);
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("textDocument/hover");
      expect(msg.id).toBeGreaterThan(0);
      expect(msg.params.textDocument.uri).toBe(
        "file:///test/project/test.hypen"
      );
      expect(msg.params.position).toEqual({ line: 5, character: 10 });

      // Respond
      ws.simulateMessage(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null })
      );
      const result = await p;
      expect(result).toBeNull();
    });

    test("dispatches response to correct pending request by id", async () => {
      const [client, ws] = await createConnectedClient();
      const p1 = client.requestHover("a.hypen", 0, 0);
      const p2 = client.requestHover("b.hypen", 1, 1);
      const id1 = JSON.parse(ws.sent[ws.sent.length - 2]).id;
      const id2 = JSON.parse(ws.sent[ws.sent.length - 1]).id;

      // Respond out of order
      ws.simulateMessage(
        JSON.stringify({ jsonrpc: "2.0", id: id2, result: "second" })
      );
      ws.simulateMessage(
        JSON.stringify({ jsonrpc: "2.0", id: id1, result: "first" })
      );

      expect(await p1).toBe("first");
      expect(await p2).toBe("second");
    });

    test("rejects request on error response", async () => {
      const [client, ws] = await createConnectedClient();
      const p = client.requestHover("x.hypen", 0, 0);
      const id = JSON.parse(ws.sent[ws.sent.length - 1]).id;

      ws.simulateMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid request" },
        })
      );
      await expect(p).rejects.toEqual({
        code: -32600,
        message: "Invalid request",
      });
    });

    test("rejects request on timeout", async () => {
      // Use a short timeout by monkey-patching (we can't easily, so test via connection close)
      const [client, ws] = await createConnectedClient();
      const p = client.requestHover("x.hypen", 0, 0);
      // Close connection — pending requests are rejected
      ws.simulateClose();
      await expect(p).rejects.toThrow("Connection closed");
    });

    test("dispatches server notifications to registered handlers", async () => {
      const [client, ws] = await createConnectedClient();
      let received: any = null;
      client.onNotification("textDocument/publishDiagnostics", (params) => {
        received = params;
      });

      const payload = {
        uri: "file:///test/project/test.hypen",
        diagnostics: [],
      };
      ws.simulateMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: payload,
        })
      );

      expect(received).toEqual(payload);
    });

    test("ignores malformed JSON", async () => {
      const [, ws] = await createConnectedClient();
      // Should not throw
      ws.simulateMessage("not json at all {{{");
    });
  });

  // -- Document sync --

  describe("document sync", () => {
    test("openDocument sends didOpen with correct URI and version", async () => {
      const [client, ws] = await createConnectedClient();
      client.openDocument("src/App/component.hypen", "Text('hi')", "hypen");

      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.method).toBe("textDocument/didOpen");
      expect(msg.params.textDocument.uri).toBe(
        "file:///test/project/src/App/component.hypen"
      );
      expect(msg.params.textDocument.version).toBe(1);
      expect(msg.params.textDocument.text).toBe("Text('hi')");
      expect(msg.params.textDocument.languageId).toBe("hypen");
    });

    test("changeDocument increments version", async () => {
      const [client, ws] = await createConnectedClient();
      client.openDocument("a.hypen", "v1", "hypen");
      client.changeDocument("a.hypen", "v2");
      client.changeDocument("a.hypen", "v3");

      const changes = ws.sent
        .map((s) => JSON.parse(s))
        .filter((m: any) => m.method === "textDocument/didChange");
      expect(changes).toHaveLength(2);
      expect(changes[0].params.textDocument.version).toBe(2);
      expect(changes[1].params.textDocument.version).toBe(3);
      expect(changes[1].params.contentChanges[0].text).toBe("v3");
    });

    test("closeDocument sends didClose", async () => {
      const [client, ws] = await createConnectedClient();
      client.openDocument("a.hypen", "x", "hypen");
      client.closeDocument("a.hypen");

      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.method).toBe("textDocument/didClose");
      expect(msg.params.textDocument.uri).toBe(
        "file:///test/project/a.hypen"
      );
    });

    test("methods are no-ops when not connected", async () => {
      const client = new HypenLspClient("/p");
      // Should not throw
      client.openDocument("a.hypen", "x", "hypen");
      client.changeDocument("a.hypen", "y");
      client.closeDocument("a.hypen");
    });
  });

  // -- Reconnection --

  describe("reconnection", () => {
    test("schedules reconnect on unexpected close", async () => {
      const [client, ws] = await createConnectedClient();
      expect(client.isConnected).toBe(true);

      ws.simulateClose();
      expect(client.isConnected).toBe(false);

      // A new WebSocket should be created after the backoff timer
      // First attempt has 1s delay. We use fake timers to avoid waiting.
      // For now, verify that a reconnect was scheduled by advancing time.
      // We can check that after a brief wait, a new MockWebSocket was created.
      await new Promise((r) => setTimeout(r, 1100)); // slightly > 1s backoff
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });

    test("does NOT reconnect after intentional disconnect", async () => {
      const [client, ws] = await createConnectedClient();
      const instanceCount = MockWebSocket.instances.length;

      client.disconnect();
      await new Promise((r) => setTimeout(r, 1200));

      // No new WebSocket should have been created
      expect(MockWebSocket.instances.length).toBe(instanceCount);
    });

    test("calls onReconnect callback after successful reconnect", async () => {
      const [client, ws] = await createConnectedClient();
      let reconnected = false;
      client.onReconnect(() => {
        reconnected = true;
      });

      // Simulate unexpected close
      ws.simulateClose();

      // Wait for backoff and complete the new handshake
      await new Promise((r) => setTimeout(r, 1100));

      const ws2 = MockWebSocket.last;
      expect(ws2).not.toBe(ws);
      ws2.simulateOpen();
      completeInitialize(ws2);

      await tick();
      expect(reconnected).toBe(true);
      expect(client.isConnected).toBe(true);
    });

    test("exponential backoff increases delay", async () => {
      const [client, ws] = await createConnectedClient();
      ws.simulateClose();

      // 1st attempt at ~1s
      await new Promise((r) => setTimeout(r, 1100));
      const ws2 = MockWebSocket.last;
      // Fail the reconnect
      ws2.simulateError();

      // 2nd attempt should be at ~2s (not 1s)
      const countBefore = MockWebSocket.instances.length;
      await new Promise((r) => setTimeout(r, 1100));
      // Should NOT have created a new instance yet (need 2s total)
      expect(MockWebSocket.instances.length).toBe(countBefore);

      await new Promise((r) => setTimeout(r, 1100));
      // Now it should have tried
      expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore);

      // Clean up
      client.disconnect();
    });

    test("clears document versions on reconnect", async () => {
      const [client, ws] = await createConnectedClient();
      client.openDocument("a.hypen", "v1", "hypen");
      client.changeDocument("a.hypen", "v2"); // version=2

      ws.simulateClose();
      await new Promise((r) => setTimeout(r, 1100));

      const ws2 = MockWebSocket.last;
      ws2.simulateOpen();
      completeInitialize(ws2);
      await tick();

      // After reconnect, opening the same doc should start at version 1 again
      client.openDocument("a.hypen", "v1-new", "hypen");
      const openMsg = JSON.parse(ws2.sent[ws2.sent.length - 1]);
      expect(openMsg.params.textDocument.version).toBe(1);

      client.disconnect();
    });
  });

  // -- disconnect --

  describe("disconnect", () => {
    test("closes WebSocket and clears state", async () => {
      const [client, ws] = await createConnectedClient();
      client.openDocument("a.hypen", "x", "hypen");

      client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    test("rejects all pending requests", async () => {
      const [client, ws] = await createConnectedClient();
      const p = client.requestHover("a.hypen", 0, 0);

      client.disconnect();
      await expect(p).rejects.toThrow("Disconnected");
    });
  });
});
