/**
 * Transport-agnostic remote session primitives.
 *
 * These moved to `@hypen-space/core` so non-Node runtimes (Cloudflare Durable
 * Objects, Deno Deploy, etc.) can reuse the Hypen remote protocol envelope.
 * This module re-exports them so existing `@hypen-space/server` import paths
 * (`./session.js`, `@hypen-space/server`) keep resolving unchanged.
 *
 * The engine is injected per session via `SessionHost.createEngine`; the
 * server's `RemoteServer` supplies `() => new Engine()` (Node/Bun WASM).
 */
export {
  RemoteSession,
  AsyncQueueTransport,
  createBunWebSocketTransport,
} from "@hypen-space/core/remote";
export type {
  SessionTransport,
  SessionHost,
  RemoteSessionOptions,
  OutgoingMessage,
} from "@hypen-space/core/remote";
