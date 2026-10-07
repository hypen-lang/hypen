/**
 * The manifest shapes, and the slice of the engine this package speaks to.
 *
 * Every type here mirrors a Rust struct in
 * `hypen-engine-rs/src/agent.rs` — `McpManifest` and friends. They are
 * mirrored rather than derived because TypeScript cannot read a Rust
 * struct, and mirrored *structurally* (same field names, same optionality)
 * so a drift shows up as a type error at the one place that reads the
 * field, not as an `undefined` three layers down.
 *
 * Nothing here interprets a manifest field. The engine composed it already:
 * `tools` and `resources` are MCP-shaped on arrival (camelCase `inputSchema`
 * / `mimeType`, `_meta` under its MCP-reserved key), which is the whole
 * point of composing them in the engine — five SDKs transport bytes and none
 * of them hand-writes protocol prose.
 */

/** MCP's behavioural hints for one tool. Hints only; a client may ignore them. */
export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
};

/** One MCP tool, exactly as `tools/list` must publish it. */
export type McpTool = {
  /** MCP-legal name (`[a-zA-Z0-9_-]{1,64}`). The name a client calls. */
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: McpToolAnnotations;
  /** Hypen extras under the MCP `_meta` convention. Absent when empty. */
  _meta?: Record<string, unknown>;
};

/** One readable state path, as an MCP resource. */
export type McpResource = {
  /** `hypen://state/<module>/<path>` — an opaque key, never parsed here. */
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /**
   * `dev.hypen/module` is the argument for the engine's state read (`null`
   * for the primary module) and `dev.hypen/statePath` the path. Both travel
   * beside the URI because the primary module is addressed by *absence* of a
   * scope, which no URI segment can spell.
   */
  _meta?: Record<string, unknown>;
};

/** One RFC 6570 URI template, for `resources/templates/list`. */
export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
};

/** Something the app declares that the manifest could not publish. */
export type McpDegradation = {
  kind: string;
  name: string;
  reason: string;
};

/** Everything an MCP host needs to describe one running app to a client. */
export type McpManifest = {
  protocolVersion: string;
  instructions: string;
  tools: McpTool[];
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
  degraded: McpDegradation[];
};

/**
 * The engine surface this package needs — a running app, seen from outside.
 *
 * Deliberately narrower than `IEngine`: this server never renders, never
 * mutates state directly, and never touches `dispatchAction` (which reaches
 * `__hypen_bind` and the raw `router.*` verbs). `dispatchExternal` is the
 * only door, and it is the engine's guard — see
 * `hypen-engine-rs/src/agent.rs`. `@hypen-space/server`'s and
 * `@hypen-space/web-engine`'s engines both satisfy this structurally.
 */
export interface AgentEngine {
  /**
   * The MCP handshake for this app, composed by the engine.
   *
   * Returns the serde encoding of `McpManifest`; typed `unknown` because a
   * wasm-bindgen web target hands nested values back as `Map`s, and this
   * package normalizes that before anything reads a field.
   */
  mcpManifest(): unknown;

  /**
   * Dispatch on behalf of a caller that is not the rendered UI. Throws when
   * the guard refuses — which is the only thing standing between an MCP
   * client and every handler in the app, so it is never worked around.
   */
  dispatchExternal(name: string, payload?: unknown): void;

  /** Read module state, whole or at a path. `null` module = primary module. */
  getStateAt(module: string | null, path: string | null): unknown;

  /**
   * Monotonic render counter. Optional: an engine without it simply has its
   * manifest re-read on every request instead of on every *change*, and its
   * `tools/call` and `resources/read` results carry no settlement cursor
   * (`structuredContent.revision` / `_meta["dev.hypen/revision"]`).
   */
  getRevision?(): number;
}
