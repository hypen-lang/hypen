/**
 * `@hypen-space/agent` — a running Hypen app, exposed to an AI agent over MCP.
 *
 * The engine composes the manifest (`Engine::mcp_manifest`) and enforces the
 * capability guard (`Engine::dispatch_external`); this package is the wire.
 * See `src/server.ts` for why it is allowed to decide nothing.
 */

export {
  HypenMcpServer,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_RESOURCE_NOT_FOUND,
  type HypenMcpServerOptions,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./server.js";

export {
  StdioTransport,
  serveStdio,
  type StdioTransportOptions,
} from "./stdio.js";

export { readManifest, resourceIndex, toolIndex, type StateAddress } from "./manifest.js";

export type {
  AgentEngine,
  McpDegradation,
  McpManifest,
  McpResource,
  McpResourceTemplate,
  McpTool,
  McpToolAnnotations,
} from "./types.js";
