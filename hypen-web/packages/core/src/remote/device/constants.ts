/**
 * Device Capability Protocol constants the TypeScript side itself enforces
 * (RFC 001 §2.3/§2.4/§2.7): the browser client runtime's scheduling, receive
 * window and abuse bounds, plus the retained-bytes budgets a Node/Bun or
 * Durable Object host hands to the Rust broker. Server-broker policy (lease
 * renewal, stream token buckets, control-stream timing, camera content-type
 * rules) lives only in hypen-engine-rs/src/device/. Leaf module — no imports
 * — so the client runtime, the session and the index barrel can all depend
 * on it without a cycle.
 */

// DEVICE_PROTOCOL_VERSION is exported from generated.ts (the schema source).

/** Lease expiry (RFC 001 §2.7), milliseconds. */
export const LEASE_EXPIRY_MS = 15_000;
/** Maximum bulk chunk handed to the transport per scheduling turn (§2.3). */
export const MAX_BULK_CHUNK_BYTES = 64 * 1024;
/** Bulk enqueueing stops when transport-pending bytes reach this bound (§2.3). */
export const MAX_TRANSPORT_PENDING_BYTES = 256 * 1024;
/**
 * Download receive window: a client-side `DownloadSink` keeps at most this
 * much granted-but-unreceived credit outstanding (§2.4).
 */
export const DOWNLOAD_WINDOW_BYTES = 256 * 1024;
/**
 * Hard cap on module instances pinned by live `background` device work, per
 * connection (§2.7). A background request from a module beyond the cap is
 * refused `throttled`; the persisted-module LRU never pins more than this.
 */
export const MAX_BACKGROUND_PINNED_MODULES = 2;
/**
 * Per-connection retained upload bytes (declared by live `blobStart`s) on a
 * Node/Bun host (§2.4 "connection budget", §5 "bound … total retained
 * results"). A declaration that would exceed it is refused `throttled`.
 */
export const DEFAULT_MAX_RETAINED_BYTES = 128 * 1024 * 1024;
/**
 * Per-connection retained upload bytes on a Cloudflare Durable Object (one
 * 128 MB isolate shared by every session in the DO). The DO also lowers the
 * per-item cap it honors to this value.
 */
export const DO_MAX_RETAINED_BYTES = 16 * 1024 * 1024;
/**
 * Minimum budget charge per accepted upload frame (§2.3/§5): a frame costs
 * `max(payloadBytes, MIN_FRAME_CHARGE_BYTES)` against the per-connection and
 * aggregate retained-bytes budgets while its request lives. Payload bytes are
 * copied into one growable buffer per channel (no per-frame object survives),
 * so this charge bounds the per-frame CPU/bookkeeping a sender can buy with a
 * stream of tiny frames: a 16 MiB budget admits at most 16 Ki frames. The
 * frame completing a declared item is charged exactly. Senders SHOULD send
 * chunks of at least this size except for an item's last chunk.
 */
export const MIN_FRAME_CHARGE_BYTES = 1024;
/**
 * Default aggregate retained upload bytes across every device connection in
 * one Node/Bun process (the server's `WasmRetainedBytesPool`), next to the per-connection
 * budget: many connections cannot together exhaust the heap.
 */
export const DEFAULT_PROCESS_RETAINED_BYTES = 1024 * 1024 * 1024;
/**
 * Aggregate retained upload bytes across every device connection in one
 * Cloudflare Durable Object (a single 128 MB isolate): three full
 * per-connection budgets at most.
 */
export const DO_AGGREGATE_RETAINED_BYTES = 48 * 1024 * 1024;
/**
 * Connection-level protocol violations (JSON-limit breaches, bad frame
 * headers, unattributable messages — decisions D3/D8) are discarded and
 * counted; past this burst (refilled at the given rate) the endpoint closes
 * the device connection ("repeated protocol abuse", RFC 001 §2.1).
 */
export const CONNECTION_VIOLATION_BURST = 32;
export const CONNECTION_VIOLATIONS_PER_SEC = 1;
