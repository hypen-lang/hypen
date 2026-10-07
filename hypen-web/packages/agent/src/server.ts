/**
 * The MCP protocol layer: JSON-RPC in, JSON-RPC out, no transport.
 *
 * # What this is allowed to decide
 *
 * Nothing. The engine composed the manifest — tool names, schemas,
 * descriptions, the instructions paragraph — precisely so that five SDKs
 * could transport it without any of them re-describing the app. So
 * `tools/list` hands back `manifest.tools` by reference and `initialize`
 * hands back `manifest.instructions` unedited. There is no filter here and
 * there must never be one: the moment this file decides what a client may
 * see, "nothing is externally reachable that a developer did not declare"
 * has two implementations and one of them will drift.
 *
 * # Where the guard is
 *
 * Not here either. Every call lands on `engine.dispatchExternal`, which is
 * `hypen-engine-rs/src/agent_core::resolve_external` — the allowlist derived
 * from `.onAction()`, `Router { Route }` and `.bind(@state.x)`, over a
 * reserved-name floor. This file's contribution to the security story is
 * negative: it never calls `dispatchAction`, never parses a resource URI, and
 * never resolves a tool name the manifest did not publish.
 *
 * # Errors
 *
 * A refused dispatch comes back as a JSON-RPC **error**, not as a tool result
 * with `isError`. The distinction MCP draws is between a tool that ran and
 * failed (a result) and a call that was not performed at all (an error) — and
 * a refusal is the second: the guard stopped it before any app code existed
 * to fail. A client that saw `isError` would reasonably retry with different
 * arguments; there are no arguments that make an undeclared capability
 * declared.
 *
 * # The settlement cursor
 *
 * A `tools/call` result still says "delivered, not done" — handlers are
 * async and nothing travels back — but it also carries the engine's render
 * `revision`, read after the dispatch returned, as `structuredContent:
 * { dispatched, revision }` and in the text. `resources/read` carries the
 * revision at the time of the read in each content's `_meta` under
 * `dev.hypen/revision`. The counter is monotonic and moves only on a render
 * that produced patches, so a read whose revision is above a call's has
 * observed at least one render since the call, and one equal to it has
 * observed none. It is a cursor, not a completion signal: "handler still
 * awaiting a fetch" and "handler ran and changed nothing" both leave it
 * where it was. An engine without `getRevision` omits it everywhere.
 */

import {
  readManifest,
  resourceIndex,
  toolIndex,
  type StateAddress,
} from "./manifest.js";
import type { AgentEngine, McpDegradation, McpManifest } from "./types.js";

/** This package's own version, reported in `serverInfo` unless overridden. */
const PACKAGE_VERSION = "0.6.3";

// JSON-RPC 2.0, as MCP uses it (no batching: dropped in MCP 2025-06-18).
export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  /** Absent on a notification — which is exactly how one is recognised. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

/** JSON-RPC's own codes, plus MCP's resource-not-found. */
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_RESOURCE_NOT_FOUND = -32002;

export type HypenMcpServerOptions = {
  /** The running app. */
  engine: AgentEngine;
  /** Reported in `initialize`. Name your app here; the client shows it. */
  serverInfo?: { name: string; version: string };
  /**
   * Sink for server-initiated notifications (`notifications/tools/
   * list_changed` and its resources twin). The transport supplies this;
   * without it the server simply never notifies.
   */
  onNotification?: (notification: JsonRpcNotification) => void;
};

/**
 * One running Hypen app, spoken to over MCP.
 *
 * Transport-agnostic on purpose: `handle` takes a decoded JSON-RPC message
 * and returns the response to write back, or `null` for a notification (which
 * JSON-RPC forbids answering). `stdio.ts` is one caller; an HTTP or WebSocket
 * transport would be another, with no protocol logic of its own.
 */
export class HypenMcpServer {
  private readonly engine: AgentEngine;
  private readonly serverInfo: { name: string; version: string };
  private readonly notify: (notification: JsonRpcNotification) => void;

  private manifest: McpManifest;
  private tools: Map<string, string>;
  private resources: Map<string, StateAddress>;
  /** Engine revision the cached manifest was read at; `undefined` = unknown. */
  private revision: number | undefined;
  /**
   * Whether the client has sent `notifications/initialized`. Notifications
   * before that point are dropped rather than queued: MCP has no ordering
   * guarantee for a server notification that races the handshake, and the
   * client's first `tools/list` reads the current manifest anyway.
   */
  private ready = false;

  constructor(options: HypenMcpServerOptions) {
    this.engine = options.engine;
    this.serverInfo = options.serverInfo ?? {
      name: "@hypen-space/agent",
      version: PACKAGE_VERSION,
    };
    this.notify = options.onNotification ?? (() => {});

    this.manifest = readManifest(this.engine);
    this.tools = toolIndex(this.manifest);
    this.resources = resourceIndex(this.manifest);
    this.revision = this.readRevision();
  }

  /**
   * What the app declares but the manifest could not publish — an action name
   * MCP cannot spell, a scope with no module behind it. Surfaced so a
   * transport can tell the developer, who would otherwise be staring at a
   * tool list missing something they can see in their own code.
   */
  get degraded(): McpDegradation[] {
    return this.manifest.degraded ?? [];
  }

  /**
   * Re-read the manifest if the app has rendered since the last read, and
   * notify the client when what it may call has changed.
   *
   * The revision is a "something happened" signal, not a manifest version:
   * it moves on every render, and most renders change no declaration at all.
   * So the revision decides whether to *re-read*, and the tool list itself
   * decides whether to *notify* — otherwise a counter incrementing on each
   * keystroke would have the client re-listing tools on each keystroke.
   *
   * Returns true when the published surface changed.
   */
  refresh(): boolean {
    const revision = this.readRevision();
    if (revision !== undefined && revision === this.revision) return false;
    this.revision = revision;

    const next = readManifest(this.engine);
    // Field order is the engine's `IndexMap` order, which is declaration
    // order and stable across reads — so string equality here is a sound
    // "same list", not an accident of serialization.
    const toolsChanged = !same(next.tools, this.manifest.tools);
    const resourcesChanged = !same(next.resources, this.manifest.resources);

    this.manifest = next;
    this.tools = toolIndex(next);
    this.resources = resourceIndex(next);

    if (this.ready && toolsChanged) {
      this.notify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    if (this.ready && resourcesChanged) {
      this.notify({
        jsonrpc: "2.0",
        method: "notifications/resources/list_changed",
      });
    }
    return toolsChanged || resourcesChanged;
  }

  /**
   * Handle one decoded JSON-RPC message. Returns the response to send, or
   * `null` when the message was a notification.
   */
  handle(message: unknown): JsonRpcResponse | null {
    const request = message as JsonRpcRequest | null;
    if (!request || typeof request !== "object" || typeof request.method !== "string") {
      return error(null, RPC_INVALID_REQUEST, "Not a JSON-RPC request object.");
    }

    // A notification carries no id and must never be answered.
    const isNotification = request.id === undefined;
    const id = request.id ?? null;

    if (isNotification) {
      if (request.method === "notifications/initialized") this.ready = true;
      return null;
    }

    // Every request re-checks the app first, so a listing is never one
    // navigation behind the app the client is looking at.
    try {
      this.refresh();
    } catch (err) {
      return error(id, RPC_INTERNAL_ERROR, `App unavailable: ${describe(err)}`);
    }

    switch (request.method) {
      case "initialize":
        return result(id, {
          // The engine's revision, verbatim. Answering with a version this
          // file believes in would be this transport claiming to know what
          // the manifest's shapes were written against.
          protocolVersion: this.manifest.protocolVersion,
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
          },
          serverInfo: this.serverInfo,
          instructions: this.manifest.instructions,
        });

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, { tools: this.manifest.tools });

      case "tools/call":
        return this.callTool(id, request.params);

      case "resources/list":
        return result(id, { resources: this.manifest.resources });

      case "resources/templates/list":
        return result(id, {
          resourceTemplates: this.manifest.resourceTemplates ?? [],
        });

      case "resources/read":
        return this.readResource(id, request.params);

      default:
        return error(
          id,
          RPC_METHOD_NOT_FOUND,
          `Unsupported method '${request.method}'.`,
        );
    }
  }

  /** `tools/call` — the one path that reaches the app. */
  private callTool(id: JsonRpcId, params: unknown): JsonRpcResponse {
    const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== "string") {
      return error(id, RPC_INVALID_PARAMS, "tools/call requires a string 'name'.");
    }

    const args = call.arguments;
    if (args != null && (typeof args !== "object" || Array.isArray(args))) {
      return error(
        id,
        RPC_INVALID_PARAMS,
        `tools/call 'arguments' must be an object, got ${typeof args}.`,
      );
    }

    // The manifest's own entry, not a name transformed into a dispatch. A
    // tool the engine did not publish has no entry, so it is refused here
    // and never reaches the guard to be refused there.
    const dispatchName = this.tools.get(call.name);
    if (dispatchName === undefined) {
      return error(
        id,
        RPC_INVALID_PARAMS,
        `Unknown tool '${call.name}'. Call tools/list for what this app declares.`,
      );
    }

    try {
      this.engine.dispatchExternal(dispatchName, args ?? undefined);
    } catch (err) {
      // The guard refused, or the payload was malformed. Either way nothing
      // ran, so this is an error rather than a failed tool result.
      return error(
        id,
        RPC_INVALID_PARAMS,
        `Tool '${call.name}' was refused: ${describe(err)}`,
      );
    }

    // Read AFTER the dispatch returned, so every later read reports a
    // revision at or above this one.
    const revision = this.readRevision();
    return result(id, {
      content: [{ type: "text", text: this.deliveredText(call.name, revision) }],
      // MCP 2025-06-18 `CallToolResult.structuredContent`. No `outputSchema`
      // is declared for it — the engine composes the tools and this file
      // edits nothing — so a client that validates against one is not
      // affected, and the text block above stays the primary content.
      structuredContent: { dispatched: call.name, ...(revision === undefined ? {} : { revision }) },
      isError: false,
    });
  }

  /**
   * What a successful call reports.
   *
   * Says delivered and points at the read surface, and invents nothing else:
   * `dispatchExternal` genuinely returns no value, handlers are not awaited,
   * and their failures do not travel back — so any "result" this composed
   * would be fiction the client would then reason from.
   */
  private deliveredText(toolName: string, revision: number | undefined): string {
    const count = this.manifest.resources.length;
    const where =
      count === 0
        ? "This app declares no readable state, so there is nothing to read back."
        : `To observe any effect, read one of the app's ${count} resource(s): ` +
          `resources/list, then resources/read on its hypen://state/... URI.`;
    // The cursor, when the engine has one. Not a promise that anything
    // happened — only where the counter stood once the dispatch returned.
    const cursor =
      revision === undefined
        ? ""
        : ` Engine revision after delivery: ${revision}. A resources/read whose ` +
          `_meta["dev.hypen/revision"] is above that has observed a render since ` +
          `this call; one equal to it has observed none.`;
    return (
      `Delivered '${toolName}' to the app. Tools act; they never return data, ` +
      `and delivery is not completion — the handler runs asynchronously and ` +
      `its outcome does not travel back. ${where}${cursor}`
    );
  }

  /** `resources/read` — a lookup in the manifest, never a URI parse. */
  private readResource(id: JsonRpcId, params: unknown): JsonRpcResponse {
    const read = (params ?? {}) as { uri?: unknown };
    if (typeof read.uri !== "string") {
      return error(id, RPC_INVALID_PARAMS, "resources/read requires a string 'uri'.");
    }

    // A URI that is not in the manifest is refused as a *string*. Parsing it
    // into module and path would turn `hypen://state/cart/_token` into a read
    // of a path the app never rendered — the manifest is the allowlist, and
    // an allowlist you can pattern-match around is not one.
    const address = this.resources.get(read.uri);
    if (!address) {
      return error(
        id,
        RPC_RESOURCE_NOT_FOUND,
        `Unknown resource '${read.uri}'. Call resources/list for what this app declares.`,
      );
    }

    const value = this.engine.getStateAt(address.module, address.path);
    if (value === undefined) {
      // The engine deliberately does not distinguish "absent" from "not
      // yours", so neither does this.
      return error(
        id,
        RPC_RESOURCE_NOT_FOUND,
        `Resource '${read.uri}' has no value right now.`,
      );
    }

    // The revision at the time of the read rides in `_meta` (MCP
    // 2025-06-18 carries one on every resource content) rather than in the
    // text, so a client that parses `text` as the bare JSON value still
    // does. Same namespaced key style as the manifest's own `_meta`.
    const revision = this.readRevision();
    return result(id, {
      contents: [
        {
          uri: read.uri,
          mimeType: "application/json",
          text: JSON.stringify(value),
          ...(revision === undefined ? {} : { _meta: { "dev.hypen/revision": revision } }),
        },
      ],
    });
  }

  private readRevision(): number | undefined {
    return typeof this.engine.getRevision === "function"
      ? this.engine.getRevision()
      : undefined;
  }
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function error(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
