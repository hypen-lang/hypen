/**
 * Reading the engine's manifest, and the two lookups a transport needs from
 * it: MCP tool name -> external dispatch name, and resource URI -> state read.
 *
 * Both are *lookups into the manifest*, never derivations from a string. The
 * distinction is the point of the whole package: if this file could compute a
 * dispatch name from a tool name, a tool the engine never published would
 * still resolve, and "nothing is externally reachable that a developer did not
 * declare" would have a second implementation living here.
 */

// The narrow entry point, not the barrel: this package needs three string
// constants, and pulling core's root export into a stdio process drags in the
// renderer, router and state machinery it never touches.
import { AGENT_BACK, AGENT_NAVIGATE, AGENT_SET_INPUT } from "@hypen-space/core/types";
import type { AgentEngine, McpManifest } from "./types.js";

/**
 * MCP tool name -> external dispatch name, for the framework built-ins.
 *
 * The mirror image of `BUILTIN_TOOL_NAMES` in
 * `hypen-engine-rs/src/agent_manifest.rs`, and a **fixed table** for the same
 * reason it is one there: a character substitution (`_` back to `.`) is a
 * many-to-one map, so `hypen_set_input` would also resolve `hypen-set-input`
 * and any other spelling that collapses onto it. A table is a list somebody
 * has to edit by hand, in both languages, when a built-in is added.
 *
 * The dotted names come from `@hypen-space/core`'s constants rather than
 * string literals, so a rename in `agent.rs` that reaches core fails the build
 * here instead of silently dispatching a name the guard no longer knows.
 *
 * Module actions need no entry: the engine's reserved floor refuses any
 * declared action name starting `hypen_`, so nothing a developer writes can
 * land on one of these keys and be routed to a built-in.
 */
const BUILTIN_DISPATCH_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["hypen_navigate", AGENT_NAVIGATE],
  ["hypen_back", AGENT_BACK],
  ["hypen_set_input", AGENT_SET_INPUT],
];

/** Where a resource's `_meta` says its value lives. */
export type StateAddress = {
  /** Argument for `getStateAt` — `null` addresses the primary module. */
  module: string | null;
  path: string;
};

const META_MODULE = "dev.hypen/module";
const META_STATE_PATH = "dev.hypen/statePath";

/**
 * Recursively turn wasm-bindgen `Map`s into plain objects.
 *
 * A `Map` survives every structural check in this file and then
 * `JSON.stringify`s to `{}` — so an un-normalized manifest would publish a
 * tool whose `inputSchema` is an empty object, with no error anywhere. The
 * walk preserves keys, order and values exactly; it renames nothing, because
 * the manifest is already MCP-shaped and re-spelling a field here is how a
 * transport starts drifting from the engine that composed it.
 *
 * Same tolerance, and the same reason, as `BaseEngine.getStateAt`'s.
 */
function plain(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of value.entries()) out[String(key)] = plain(val);
    return out;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = plain(val);
    return out;
  }
  return value;
}

/** Read and normalize the manifest, failing loudly on an engine that has none. */
export function readManifest(engine: AgentEngine): McpManifest {
  if (typeof engine.mcpManifest !== "function") {
    // The same fail-closed posture `dispatchExternal` takes in
    // `BaseEngine`: a transport that improvised a manifest would be
    // hand-writing the protocol prose the engine exists to own.
    throw new Error(
      "mcpManifest() is not available on this engine. Rebuild the WASM " +
        "artifact (`bun run build:wasm`) — this server publishes the engine's " +
        "manifest verbatim and cannot compose a substitute.",
    );
  }
  const manifest = plain(engine.mcpManifest()) as McpManifest;
  if (!manifest || !Array.isArray(manifest.tools)) {
    throw new Error(
      `mcpManifest() returned no tool list (got ${JSON.stringify(manifest)}).`,
    );
  }
  return manifest;
}

/**
 * The dispatch name for one published tool, or `undefined` when the manifest
 * does not publish it.
 *
 * A module action transports under its declared name unchanged — `agent_
 * manifest.rs` publishes `action.name` verbatim and drops (into `degraded`)
 * any name MCP cannot spell — so identity is the mapping, not a guess.
 */
function dispatchNameFor(toolName: string): string {
  const builtin = BUILTIN_DISPATCH_NAMES.find(([tool]) => tool === toolName);
  return builtin ? builtin[1] : toolName;
}

/** MCP tool name -> the name `dispatchExternal` takes, for published tools only. */
export function toolIndex(manifest: McpManifest): Map<string, string> {
  const index = new Map<string, string>();
  for (const tool of manifest.tools) {
    if (typeof tool?.name === "string") {
      index.set(tool.name, dispatchNameFor(tool.name));
    }
  }
  return index;
}

/**
 * Resource URI -> the arguments its read takes, for published resources only.
 *
 * A resource whose `_meta` is missing or malformed is left out rather than
 * repaired: the URI's own segments look like `<module>/<path>`, and parsing
 * them would invent a read the engine never advertised — for the primary
 * module they are not even the right values, since it is addressed by the
 * absence of a scope.
 */
export function resourceIndex(manifest: McpManifest): Map<string, StateAddress> {
  const index = new Map<string, StateAddress>();
  for (const resource of manifest.resources ?? []) {
    const meta = resource?._meta;
    if (!resource || typeof resource.uri !== "string" || !meta) continue;

    const path = meta[META_STATE_PATH];
    if (typeof path !== "string") continue;

    // The key must be *present*, not merely falsy: an absent
    // `dev.hypen/module` and an explicit `null` mean different things, and
    // reading the absence as "the primary module" would point a read at a
    // module the manifest never named.
    if (!(META_MODULE in meta)) continue;
    const module = meta[META_MODULE];
    if (module !== null && typeof module !== "string") continue;

    index.set(resource.uri, { module, path });
  }
  return index;
}
