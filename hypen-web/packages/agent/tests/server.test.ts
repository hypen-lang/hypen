/**
 * The MCP protocol wiring, over a fake engine.
 *
 * A fake is the right double here and a real engine would be the wrong one:
 * what is under test is that this package transports the engine's manifest
 * *without editing it* and reaches the app only through `dispatchExternal`.
 * Both are claims about what this code does with what it is handed, so the
 * test has to control what it is handed. The guard itself is the engine's,
 * and is proven in `hypen-engine-rs/src/agent.rs`'s own tests and in
 * `tests/external-surface.test.ts` against real WASM.
 *
 * The manifest below is the shape `Engine::mcp_manifest()` composes for the
 * cart app in `agent_manifest.rs`'s tests, transcribed field for field.
 */

import { describe, expect, test } from "bun:test";
import { HypenMcpServer } from "../src/server.js";
import type {
  AgentEngine,
  McpManifest,
  McpTool,
} from "../src/types.js";

const NAVIGATE_TOOL: McpTool = {
  name: "hypen_navigate",
  title: "Navigate",
  description: "Move the app to one of its declared routes. Declared: /cart, /orders.",
  inputSchema: {
    type: "object",
    properties: { to: { type: "string", enum: ["/cart", "/orders"] } },
    required: ["to"],
    additionalProperties: true,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  _meta: {
    "dev.hypen/enforcement": "guard",
    "dev.hypen/routes": ["/cart", "/orders"],
  },
};

const SET_INPUT_TOOL: McpTool = {
  name: "hypen_set_input",
  title: "Set input",
  description: "Set one form field the app declares with .bind().",
  inputSchema: {
    type: "object",
    oneOf: [
      {
        properties: {
          field: { const: "coupon" },
          value: { type: ["string", "number", "boolean", "null"] },
          module: { type: "null" },
        },
        required: ["field", "value"],
      },
    ],
    additionalProperties: true,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  _meta: { "dev.hypen/enforcement": "guard" },
};

const CHECKOUT_TOOL: McpTool = {
  name: "checkout",
  title: "checkout",
  description:
    "Dispatch the app's 'checkout' action. Declared by module 'cart'. " +
    "Arguments are passed to the handler unchecked.",
  inputSchema: {
    type: "object",
    properties: { note: { type: "string" }, qty: { type: "number" } },
    required: [],
    additionalProperties: true,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  _meta: { "dev.hypen/enforcement": "advisory", "dev.hypen/module": "cart" },
};

function manifest(): McpManifest {
  return {
    protocolVersion: "2025-06-18",
    instructions:
      "This server drives one running Hypen application.\n\nTools act; they never return data.",
    tools: [NAVIGATE_TOOL, SET_INPUT_TOOL, CHECKOUT_TOOL],
    resources: [
      {
        uri: "hypen://state/cart/total",
        name: "cart.total",
        title: "total",
        description: "Value of 'total' in the 'cart' module's state.",
        mimeType: "application/json",
        _meta: { "dev.hypen/module": null, "dev.hypen/statePath": "total" },
      },
      {
        uri: "hypen://state/orders/status",
        name: "orders.status",
        title: "status",
        description: "Value of 'status' in the 'orders' module's state.",
        mimeType: "application/json",
        _meta: { "dev.hypen/module": "orders", "dev.hypen/statePath": "status" },
      },
    ],
    resourceTemplates: [],
    degraded: [
      { kind: "tool", name: "add to cart", reason: "action name is not an MCP tool name" },
    ],
  };
}

/**
 * An engine that records what reached it. `refuse` stands in for the guard:
 * the real `dispatch_external` throws `ActionNotFound` for a name that is not
 * externally dispatchable, and the SDK rethrows it as a `HypenError`.
 */
class FakeEngine implements AgentEngine {
  manifest: McpManifest = manifest();
  revision = 1;
  refuse = new Set<string>();
  state: Record<string, unknown> = {
    "|total": 4780,
    "orders|status": "shipped",
    // Readable by the fake, absent from the manifest: the whole point of the
    // unlisted-URI test is that it is never asked for.
    "|_token": "sk-live-DEADBEEF",
  };

  dispatched: Array<{ name: string; payload: unknown }> = [];
  reads: Array<[string | null, string | null]> = [];

  mcpManifest(): unknown {
    return this.manifest;
  }

  dispatchExternal(name: string, payload?: unknown): void {
    if (this.refuse.has(name)) {
      throw new Error(`Action not found: '${name}' is not externally dispatchable`);
    }
    this.dispatched.push({ name, payload });
  }

  getStateAt(module: string | null, path: string | null): unknown {
    this.reads.push([module, path]);
    return this.state[`${module ?? ""}|${path ?? ""}`];
  }

  getRevision(): number {
    return this.revision;
  }
}

type Harness = {
  engine: FakeEngine;
  server: HypenMcpServer;
  notifications: Array<{ method: string }>;
  call: (method: string, params?: unknown) => any;
};

/** A server whose client has completed the handshake. */
function harness(): Harness {
  const engine = new FakeEngine();
  const notifications: Array<{ method: string }> = [];
  const server = new HypenMcpServer({
    engine,
    serverInfo: { name: "cart-app", version: "1.2.3" },
    onNotification: (n) => notifications.push({ method: n.method }),
  });

  let id = 0;
  const call = (method: string, params?: unknown) =>
    server.handle({ jsonrpc: "2.0", id: ++id, method, params });

  call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

  return { engine, server, notifications, call };
}

describe("initialize", () => {
  test("hands back the engine's own protocol version and instructions", () => {
    const { engine, server } = harness();
    const response = server.handle({ jsonrpc: "2.0", id: 9, method: "initialize" })!;

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.protocolVersion).toBe(engine.manifest.protocolVersion);
    // Verbatim: the prose is the engine's, identical for every Hypen app, and
    // a transport that paraphrased it would be hand-writing protocol prose.
    expect(result.instructions).toBe(engine.manifest.instructions);
    expect(result.serverInfo).toEqual({ name: "cart-app", version: "1.2.3" });
    expect(result.capabilities.tools.listChanged).toBe(true);
    expect(result.capabilities.resources.listChanged).toBe(true);
  });

  test("a notification is never answered", () => {
    const { server } = harness();
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});

describe("tools/list", () => {
  test("returns the manifest's tools verbatim", () => {
    const { engine, call } = harness();
    const tools = call("tools/list").result.tools;

    // Field for field, `_meta` and schema included. Not "the same names" —
    // the design point is that the engine composed these and no transport
    // re-derives, re-describes or filters them.
    expect(tools).toEqual(engine.manifest.tools);
  });

  test("publishes no tool the manifest omitted", () => {
    // `add to cart` is declared by the app and dispatchable by anyone whose
    // transport can carry the name; MCP cannot spell it, so the engine put it
    // in `degraded` and this server must not invent a spelling for it.
    const { server, call } = harness();
    const names = call("tools/list").result.tools.map((t: McpTool) => t.name);

    expect(names).toEqual(["hypen_navigate", "hypen_set_input", "checkout"]);
    expect(server.degraded[0]!.name).toBe("add to cart");
  });
});

describe("tools/call", () => {
  test("a built-in maps back to its dotted dispatch name through the fixed table", () => {
    const { engine, call } = harness();
    const response = call("tools/call", {
      name: "hypen_navigate",
      arguments: { to: "/orders" },
    });

    expect(response.error).toBeUndefined();
    // `hypen_navigate` is the MCP spelling; `hypen.navigate` is what the
    // guard knows. Substituting the underscore back would be string surgery.
    expect(engine.dispatched).toEqual([
      { name: "hypen.navigate", payload: { to: "/orders" } },
    ]);
  });

  test("a module action dispatches under its declared name", () => {
    const { engine, call } = harness();
    call("tools/call", { name: "checkout", arguments: { note: "gift" } });

    expect(engine.dispatched).toEqual([
      { name: "checkout", payload: { note: "gift" } },
    ]);
  });

  test("a result reports delivery and a cursor, and invents no return value", () => {
    const { call } = harness();
    const delivered = call("tools/call", { name: "checkout" }).result;
    expect(delivered.isError).toBe(false);
    expect(delivered.content).toHaveLength(1);
    expect(delivered.content[0].type).toBe("text");
    expect(delivered.content[0].text).toContain("Delivered 'checkout'");
    // Dispatch genuinely returns nothing, so the only structured fields are
    // what was delivered and where the engine's counter stood afterwards —
    // never anything shaped like a handler's result.
    expect(delivered.structuredContent).toEqual({ dispatched: "checkout", revision: 1 });
    expect(delivered.content[0].text).toContain("revision after delivery: 1");
    // And it points at where an effect can actually be observed.
    expect(delivered.content[0].text).toContain("resources/read");
  });

  test("the cursor is read after the dispatch, and a later read is at-or-above it", () => {
    const { engine, call } = harness();
    // A handler whose effect renders synchronously: the counter has moved
    // by the time `dispatchExternal` returns, and the result must say so.
    engine.dispatchExternal = (name, payload) => {
      engine.dispatched.push({ name, payload });
      engine.revision += 1;
    };
    const before = engine.revision;

    const delivered = call("tools/call", { name: "checkout" }).result;
    expect(delivered.structuredContent.revision).toBe(before + 1);

    const read = call("resources/read", { uri: "hypen://state/cart/total" }).result;
    expect(read.contents[0]._meta["dev.hypen/revision"]).toBeGreaterThanOrEqual(
      delivered.structuredContent.revision,
    );
    // The cursor rides beside the text, never inside it.
    expect(read.contents[0].text).toBe("4780");
  });

  test("an engine without getRevision carries no cursor anywhere", () => {
    const engine = new FakeEngine();
    (engine as { getRevision?: unknown }).getRevision = undefined;
    const server = new HypenMcpServer({ engine });
    const rpc = (id: number, method: string, params: unknown) =>
      server.handle({ jsonrpc: "2.0", id, method, params })!.result as any;

    const delivered = rpc(1, "tools/call", { name: "checkout" });
    expect(delivered.structuredContent).toEqual({ dispatched: "checkout" });
    expect(delivered.content[0].text).not.toContain("revision");

    const read = rpc(2, "resources/read", { uri: "hypen://state/cart/total" });
    expect(read.contents[0]._meta).toBeUndefined();
    expect(read.contents[0].text).toBe("4780");
  });

  test("a refused dispatch is an MCP error, not a successful result", () => {
    const { engine, call } = harness();
    engine.refuse.add("checkout");

    const response = call("tools/call", { name: "checkout" });

    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    // The engine's own words survive: a client that cannot see why it was
    // refused retries the same call.
    expect(response.error.message).toContain("is not externally dispatchable");
    expect(engine.dispatched).toEqual([]);
  });

  test("a tool the manifest never published is refused before the engine is touched", () => {
    const { engine, call } = harness();
    const response = call("tools/call", { name: "__hypen_bind", arguments: { path: "x" } });

    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("Unknown tool '__hypen_bind'");
    expect(engine.dispatched).toEqual([]);
  });

  test("malformed params are rejected without dispatching", () => {
    const { engine, call } = harness();

    expect(call("tools/call", {}).error.code).toBe(-32602);
    expect(call("tools/call", { name: "checkout", arguments: [1, 2] }).error.code).toBe(-32602);
    expect(engine.dispatched).toEqual([]);
  });
});

describe("resources", () => {
  test("resources/list returns the manifest's resources verbatim", () => {
    const { engine, call } = harness();
    expect(call("resources/list").result.resources).toEqual(engine.manifest.resources);
  });

  test("a read is addressed from _meta, not from the URI's segments", () => {
    const { engine, call } = harness();

    const primary = call("resources/read", { uri: "hypen://state/cart/total" }).result;
    expect(primary.contents).toEqual([
      {
        uri: "hypen://state/cart/total",
        mimeType: "application/json",
        text: "4780",
        _meta: { "dev.hypen/revision": 1 },
      },
    ]);
    // `cart` is in the URI, but the primary module is addressed by the
    // ABSENCE of a scope — which no URI segment can spell.
    expect(engine.reads[0]).toEqual([null, "total"]);

    call("resources/read", { uri: "hypen://state/orders/status" });
    expect(engine.reads[1]).toEqual(["orders", "status"]);
  });

  test("a URI the manifest never listed is refused, and never read", () => {
    // The manifest is the allowlist. This URI is well-formed, its module and
    // path are real, and the engine would hand the value over — so the only
    // thing standing between an agent and the token is that this server
    // refuses a string it did not publish rather than parsing one it did not.
    const { engine, call } = harness();
    const response = call("resources/read", { uri: "hypen://state/cart/_token" });

    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32002);
    expect(response.error.message).toContain("Unknown resource");
    expect(engine.reads).toEqual([]);
  });

  test("a listed resource with nothing behind it is an error, not an empty read", () => {
    const { engine, call } = harness();
    delete engine.state["|total"];

    const response = call("resources/read", { uri: "hypen://state/cart/total" });
    expect(response.error.code).toBe(-32002);
  });

  test("resources/templates/list passes the manifest's templates through", () => {
    const { call } = harness();
    expect(call("resources/templates/list").result.resourceTemplates).toEqual([]);
  });
});

describe("manifest changes", () => {
  test("a changed tool list notifies and re-lists", () => {
    const { engine, notifications, call } = harness();

    engine.manifest = {
      ...engine.manifest,
      tools: [...engine.manifest.tools, { ...CHECKOUT_TOOL, name: "refund", title: "refund" }],
    };
    engine.revision += 1;

    const names = call("tools/list").result.tools.map((t: McpTool) => t.name);
    expect(names).toContain("refund");
    expect(notifications.map((n) => n.method)).toEqual([
      "notifications/tools/list_changed",
    ]);
    // The new tool is callable immediately — the index moved with the list.
    call("tools/call", { name: "refund" });
    expect(engine.dispatched.at(-1)!.name).toBe("refund");
  });

  test("a revision bump that changes no declaration notifies nobody", () => {
    // The revision moves on every render — a keystroke into a bound input is
    // a render. Notifying on it would have the client re-listing tools per
    // keystroke.
    const { engine, notifications, server } = harness();
    engine.revision += 1;

    expect(server.refresh()).toBe(false);
    expect(notifications).toEqual([]);
  });

  test("a changed resource list notifies separately", () => {
    const { engine, notifications, server } = harness();
    engine.manifest = { ...engine.manifest, resources: [] };
    engine.revision += 1;

    expect(server.refresh()).toBe(true);
    expect(notifications.map((n) => n.method)).toEqual([
      "notifications/resources/list_changed",
    ]);
  });

  test("nothing is notified before the client says it is initialized", () => {
    // A server notification racing the handshake has no defined ordering.
    const engine = new FakeEngine();
    const notifications: string[] = [];
    const server = new HypenMcpServer({
      engine,
      onNotification: (n) => notifications.push(n.method),
    });

    engine.manifest = { ...engine.manifest, tools: [] };
    engine.revision += 1;
    expect(server.refresh()).toBe(true);
    expect(notifications).toEqual([]);
  });
});

describe("protocol errors", () => {
  test("an unknown method is method-not-found", () => {
    const { call } = harness();
    expect(call("prompts/list").error.code).toBe(-32601);
  });

  test("a non-request is invalid-request with a null id", () => {
    const { server } = harness();
    const response = server.handle("not a request")!;
    expect(response.id).toBeNull();
    expect(response.error!.code).toBe(-32600);
  });
});

describe("engine compatibility", () => {
  test("an engine with no mcpManifest fails loudly instead of improvising one", () => {
    const engine = { dispatchExternal() {}, getStateAt: () => undefined } as unknown as AgentEngine;
    expect(() => new HypenMcpServer({ engine })).toThrow(/mcpManifest/);
  });

  test("a manifest arriving as wasm-bindgen Maps is still published intact", () => {
    // The web-target WASM hands nested values back as `Map`s, which
    // JSON.stringify to `{}` — a tool with an empty inputSchema and no error
    // anywhere. Normalizing is framing, not editing: no key is renamed.
    const engine = new FakeEngine();
    const asMaps = new Map<string, unknown>([
      ["protocolVersion", "2025-06-18"],
      ["instructions", "prose"],
      [
        "tools",
        [
          new Map<string, unknown>([
            ["name", "checkout"],
            ["title", "checkout"],
            ["description", "d"],
            ["inputSchema", new Map<string, unknown>([["type", "object"]])],
            [
              "annotations",
              new Map<string, unknown>([
                ["readOnlyHint", false],
                ["destructiveHint", true],
                ["idempotentHint", false],
              ]),
            ],
          ]),
        ],
      ],
      ["resources", []],
      ["resourceTemplates", []],
      ["degraded", []],
    ]);
    engine.mcpManifest = () => asMaps;

    const server = new HypenMcpServer({ engine });
    const tools = (server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })!
      .result as any).tools;

    expect(tools[0].inputSchema).toEqual({ type: "object" });
    expect(JSON.parse(JSON.stringify(tools[0])).annotations.destructiveHint).toBe(true);
  });
});


test("a disconnected attached engine returns an error with the request id", () => {
  let alive = true;
  const engine: AgentEngine = {
    mcpManifest: () => manifest(),
    getRevision: () => {
      if (!alive) throw new Error("Session is no longer live");
      return 1;
    },
    dispatchExternal: () => {},
    getStateAt: () => undefined,
  };
  const server = new HypenMcpServer({ engine });
  alive = false;
  const response = server.handle({ jsonrpc: "2.0", id: 42, method: "tools/list" });
  expect(response?.id).toBe(42);
  expect(response?.error?.code).toBe(-32603);
  expect(response?.error?.message).toContain("no longer live");
  expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
});
