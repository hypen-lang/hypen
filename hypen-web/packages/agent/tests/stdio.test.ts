/**
 * Stdio framing: one JSON value per line, nothing else on stdout, and never
 * an answer to a notification.
 *
 * These are the rules an MCP client enforces by disconnecting, so they are
 * worth pinning here rather than discovering in Claude Desktop's log.
 */

import { describe, expect, test } from "bun:test";
import { StdioTransport } from "../src/stdio.js";
import type { AgentEngine, McpManifest } from "../src/types.js";

function manifest(): McpManifest {
  return {
    protocolVersion: "2025-06-18",
    instructions: "prose",
    tools: [
      {
        name: "checkout",
        title: "checkout",
        description: "Dispatch the app's 'checkout' action.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
    ],
    resources: [],
    resourceTemplates: [],
    degraded: [{ kind: "tool", name: "add to cart", reason: "not an MCP tool name" }],
  };
}

class FakeEngine implements AgentEngine {
  dispatched: string[] = [];
  mcpManifest(): unknown {
    return manifest();
  }
  dispatchExternal(name: string): void {
    this.dispatched.push(name);
  }
  getStateAt(): unknown {
    return undefined;
  }
}

/** A transport reading a fixed script, writing into arrays. */
function transport(lines: string[]) {
  const out: string[] = [];
  const logged: string[] = [];
  const encoder = new TextEncoder();

  async function* input(): AsyncGenerator<Uint8Array> {
    for (const line of lines) yield encoder.encode(line);
  }

  const engine = new FakeEngine();
  const t = new StdioTransport({
    engine,
    serverInfo: { name: "cart-app", version: "1.0.0" },
    input: input(),
    write: (chunk) => out.push(chunk),
    log: (message) => logged.push(message),
  });
  return { transport: t, out, logged, engine };
}

const rpc = (id: number, method: string, params?: unknown) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

describe("stdio framing", () => {
  test("each request gets exactly one newline-terminated JSON response", async () => {
    const { transport: t, out } = transport([
      rpc(1, "initialize"),
      rpc(2, "tools/list"),
    ]);
    await t.start();

    expect(out).toHaveLength(2);
    for (const chunk of out) {
      expect(chunk.endsWith("\n")).toBe(true);
      // One value per line: the newline is the frame, so there can be no
      // second one inside a chunk.
      expect(chunk.slice(0, -1).includes("\n")).toBe(false);
    }
    expect(JSON.parse(out[1]!).result.tools[0].name).toBe("checkout");
  });

  test("a notification produces no output at all", async () => {
    const { transport: t, out } = transport([
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    ]);
    await t.start();
    expect(out).toEqual([]);
  });

  test("a message split across chunks is buffered until its newline", async () => {
    const { transport: t, out } = transport([
      '{"jsonrpc":"2.0","id":7,"method":"to',
      'ols/list"}\n',
    ]);
    await t.start();

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).id).toBe(7);
  });

  test("a final line with no trailing newline is still handled", async () => {
    const { transport: t, out } = transport(['{"jsonrpc":"2.0","id":3,"method":"ping"}']);
    await t.start();
    expect(JSON.parse(out[0]!).result).toEqual({});
  });

  test("unparseable bytes answer with a parse error and a null id", async () => {
    const { transport: t, out } = transport(["{ not json\n", "\n", rpc(4, "ping")]);
    await t.start();

    expect(out).toHaveLength(2);
    const parseError = JSON.parse(out[0]!);
    expect(parseError.id).toBeNull();
    expect(parseError.error.code).toBe(-32700);
    // A blank line is framing, not a message, and the stream keeps working.
    expect(JSON.parse(out[1]!).id).toBe(4);
  });

  test("what the app could not publish is reported on stderr, never on stdout", async () => {
    const { transport: t, out, logged } = transport([]);
    await t.start();

    expect(out).toEqual([]);
    expect(logged.join("\n")).toContain("add to cart");
  });

  test("a manifest change while the client is idle notifies over the same stream", async () => {
    // The poll exists for exactly this: no request is in flight, so nothing
    // would otherwise re-read the manifest.
    const out: string[] = [];
    const engine = new FakeEngine();
    let revision = 1;
    let tools = manifest().tools;
    engine.mcpManifest = () => ({ ...manifest(), tools });
    (engine as AgentEngine).getRevision = () => revision;

    const t = new StdioTransport({
      engine,
      input: (async function* () {})(),
      write: (chunk) => out.push(chunk),
      log: () => {},
    });
    // Complete the handshake, then change the surface behind the client.
    t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    t.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    out.length = 0;

    tools = [];
    revision = 2;
    t.server.refresh();

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
  });
});
