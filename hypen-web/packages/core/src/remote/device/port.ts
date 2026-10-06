/**
 * Device Capability Protocol — the server-side broker PORT (RFC 001).
 *
 * The broker itself — request ids, owners and sweeps, leases, deadlines,
 * credit, uploads, downloads, `core.capabilities`, strict decoding and the
 * violation reactions, bulk transport scheduling — is implemented ONCE, in
 * Rust (`hypen-engine-rs/src/device/`), and shared by every server SDK. It is
 * sans-IO: no sockets, no timers, no clock of its own.
 *
 * `@hypen-space/core` stays WASM-free, so it only describes that broker
 * here, structurally, as a small port. The WASM-backed implementation is
 * supplied by the packages that already load the engine WASM:
 * `@hypen-space/server` (`wasm-node`) and `@hypen-space/cf` (the web-target
 * `hypen-engine` package) — both hand a {@link DeviceBrokerFactory} to the
 * session host. The shapes below are the ones the wasm-bindgen
 * `WasmDeviceBroker` speaks (defined once in
 * `hypen-engine-rs/src/wasm/device_binding.rs`, shared with Go, Kotlin and
 * the Swift server), so a `WasmDeviceBroker` satisfies
 * {@link DeviceBrokerPort} as-is.
 *
 * {@link DevicePlane} (./plane.ts) drives a port: it feeds socket text and
 * frames in, runs its timers from `tick()`'s next deadline, reports the
 * transport's buffered bytes and pumps `poll()` outputs to the socket and to
 * the handler API.
 */

import type { DeviceAck, DeviceErrorCode, DeviceLifetime } from "./generated.js";

/** `{id}` for an opened request, or a local refusal (nothing was sent). */
export type DeviceOpenResult =
  | { id: number; error?: undefined }
  | { id?: undefined; error: { code: DeviceErrorCode; detail?: string } };

/** One verified upload item of a successful buffered (unary) upload. */
export interface DeviceBrokerBlob {
  channel: number;
  /** The result item's `name`, when the revision carries one (file.pick). */
  name?: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A request's single terminal outcome, as the broker reports it. */
export type DeviceBrokerOutcome =
  | {
      ok: true;
      /** The client's result, validated against the selected revision. */
      result: unknown;
      /** Verified upload items (buffered unary uploads), in result order. */
      blobs: DeviceBrokerBlob[];
      /** Produced by a fake host (RFC 001 §1.11). */
      simulated: boolean;
      /** The retained-bytes charge is held until `releaseResult(id)`. */
      held: boolean;
    }
  | { ok: false; code: DeviceErrorCode; detail?: string };

/** Everything the broker asks the host to do, in order. */
export type DeviceBrokerOutput =
  /** Send this device JSON message on the text channel. */
  | { type: "sendText"; text: string }
  /** Send this binary frame (download bytes), already scheduled. */
  | { type: "sendFrame"; frame: Uint8Array }
  /** A validated JSON stream event; call `consumedEvents` when done with it. */
  | { type: "event"; id: number; event: Record<string, unknown> }
  /** Streamed upload bytes, in order; call `consumedData` when done with them. */
  | { type: "data"; id: number; channel: number; bytes: Uint8Array }
  /** Request `id` ended (exactly once per opened request). */
  | { type: "settled"; id: number; outcome: DeviceBrokerOutcome }
  /** The broker closed the device plane: close the socket with this code. */
  | { type: "closeConnection"; code: number; reason: string };

/**
 * Broker configuration. Only `ack` is required; every other member defaults
 * to the Rust broker's value (unknown members are rejected there, so a
 * misspelt limit cannot silently fall back to a default).
 */
export interface DeviceBrokerConfig {
  /** The negotiated `sessionAck.device`. */
  ack: DeviceAck;
  /**
   * What this server advertised (snapshots are intersected with it).
   * Absent: the Rust broker's own advertisement — what `negotiate` selects
   * against when it is not given one either (`RemoteSession` passes neither).
   */
  serverCapabilities?: Array<{ name: string; versions: number[] }>;
  /** Per-connection retained upload bytes. */
  maxRetainedBytes?: number;
  /** Host cap on a single blob item, applied to every revision. */
  maxItemBytes?: number;
  /** Hard cap on modules pinned by live background work. */
  maxBackgroundOwners?: number;
  /** Minimum budget charge per accepted upload frame. */
  minFrameCharge?: number;
  /** Streamed uploads: consumer progress bound after the success terminal. */
  drainTimeoutMs?: number;
  eventRate?: {
    requestBurst?: number;
    requestPerSecond?: number;
    connectionBurst?: number;
    connectionPerSecond?: number;
  };
  /** Connection-level violations tolerated before the plane closes. */
  violationRate?: { burst?: number; perSecond?: number };
  /** Overall deadline of `core.capabilities` (the broker reopens it before). */
  controlStreamTimeoutMs?: number;
  controlStreamInitialCredit?: number;
  /** Bulk transport scheduling (64 KiB turns, 256 KiB pending, 8 MiB queue). */
  scheduler?: {
    turnBytes?: number;
    pendingLimit?: number;
    maxQueuedBytes?: number;
    retryMs?: number;
  };
  /** Registry revision replacements (e.g. a revision that allows background). */
  revisionOverrides?: Array<{
    capability: string;
    version: number;
    lifetimes?: DeviceLifetime[];
    maxItemBytes?: number;
    maxItems?: number;
    maxInitialCredit?: number;
    maxOutstandingCredit?: number;
    maxTimeoutMs?: number;
  }>;
  /** Ids are allocated below this bound; reaching it closes the plane. */
  requestIdLimit?: number;
}

/** What a handler asks the broker to open. */
export interface DeviceOpenSpec {
  capability: string;
  /** Exact revision; absent = the live selection's revision. */
  version?: number;
  params?: unknown;
  moduleInstanceId: string;
  activationId: number;
  /** Absent = the revision's default lifetime. */
  lifetime?: DeviceLifetime;
  /** Absent = the broker default; always clamped to the revision. */
  timeoutMs?: number;
  /** Absent = the data plane's default; clamped to the revision. */
  initialCredit?: number;
  /** Accept an explicit `initialCredit: 0` on a client → server data plane. */
  allowZeroCredit?: boolean;
  /** The operation shape the caller expects; absent accepts either. */
  mode?: "unary" | "stream";
  /** Hold a successful result's retained-bytes charge until `releaseResult`. */
  holdResult?: boolean;
  /** The replay firewall: refused `unavailable` before anything else. */
  replayed?: boolean;
}

/** The revision a broker enforces for one `capability@version`. */
export interface DeviceBrokerRevision {
  version: number;
  mode: "unary" | "stream";
  data: "none" | "jsonEvents" | "binaryUpload" | "binaryDownload";
  consent: string;
  overflow: string;
  lifetimes: DeviceLifetime[];
  maxItemBytes: number;
  maxItems: number;
  maxInitialCredit: number;
  maxOutstandingCredit: number;
  maxTimeoutMs: number;
}

/** A snapshot of the broker's queryable state. */
export interface DeviceBrokerInfo {
  closed: boolean;
  started: boolean;
  binary: boolean;
  liveCount: number;
  drainingCount: number;
  coreStreamId: number | null;
  nextDeadline: number | null;
  retainedBytes: number;
  maxRetainedBytes: number;
  connectionViolations: number;
  lastConnectionViolation: string | null;
  queuedBulkBytes: number;
  bulkTurns: number;
  backgroundOwners: string[];
  selection: Array<{ name: string; version: number }>;
}

/**
 * The sans-IO server-side device broker of one connection. Times are
 * monotonic milliseconds supplied by the host. Host errors (a malformed
 * spec, a negative time) throw; protocol refusals are values.
 */
export interface DeviceBrokerPort {
  /** Open the connection-owned `core.capabilities` stream (once). */
  start(nowMs: number): DeviceOpenResult;
  /** Open a request; `download` carries `file.save` bytes. */
  open(spec: DeviceOpenSpec, nowMs: number, download?: Uint8Array | null): DeviceOpenResult;
  /** Server-initiated cancel (sends `cancel`, settles `cancelled`). */
  cancel(id: number, nowMs: number): void;
  /** Release a held result's retained-bytes charge (idempotent). */
  releaseResult(id: number): void;
  consumedEvents(id: number, n: number, nowMs: number): void;
  consumedData(id: number, chunks: number, nowMs: number): void;
  ownerActivated(moduleInstanceId: string, activationId: number, nowMs: number): boolean;
  ownerDeactivated(moduleInstanceId: string, activationId: number, nowMs: number): void;
  ownerDestroyed(moduleInstanceId: string, nowMs: number): void;
  /** Feed one client → server device text message (the raw text). */
  onText(text: string, nowMs: number): boolean;
  /** Feed one client → server binary frame. */
  onFrame(frame: Uint8Array, nowMs: number): boolean;
  /** Count a connection-level violation the host detected itself. */
  reportViolation(reason: string, nowMs: number): void;
  /** Run due timers; the next deadline (absolute ms) or undefined. */
  tick(nowMs: number): number | undefined;
  nextDeadline(): number | undefined;
  /** The transport's buffered (accepted, unwritten) bytes. */
  setTransportBuffered(bytes: number): void;
  /** Drain every output (and at most one bulk turn). */
  poll(): DeviceBrokerOutput[];
  /** Close the device plane locally with a wire error code. */
  close(code: DeviceErrorCode): void;
  reopenCoreCapabilities(nowMs: number): number | undefined;
  info(): DeviceBrokerInfo;
  isLive(id: number): boolean;
  readonly isClosed: boolean;
  readonly liveCount: number;
  readonly coreStreamId: number | undefined;
  readonly retainedBytes: number;
  supports(capability: string): boolean;
  selectedVersion(capability: string): number | undefined;
  outstandingCredit(id: number): number | undefined;
  outstandingEventCredit(id: number): number | undefined;
  hasBackgroundWork(moduleInstanceId: string): boolean;
  admitsBackground(moduleInstanceId: string): boolean;
  ownerIsActive(moduleInstanceId: string, activationId: number): boolean;
  /** The effective revision, or null when it is not a registry revision. */
  revision(capability: string, version: number): DeviceBrokerRevision | null;
  /** Release the broker's memory (a WASM object); it closes first if needed. */
  free(): void;
}

/** One `{name, versions}` entry of a server's device advertisement. */
export interface DeviceCapabilityOffer {
  name: string;
  versions: number[];
}

/**
 * The server side of the device handshake (RFC 001 §2.2): the
 * `sessionAck.device` to send, or `null` (device plane disabled, UI-only
 * operation continues) with a `reason` for the server log — never for the
 * client.
 */
export type DeviceHandshakeOutcome =
  | { ack: DeviceAck; reason?: undefined }
  | { ack: null; reason: string };

/**
 * Creates one broker per device connection, and negotiates the
 * handshake that precedes it. Supplied by `@hypen-space/server`
 * (`createWasmDeviceBrokerFactory`) or `@hypen-space/cf`
 * (`createCFDeviceBrokerFactory`); the factory owns any aggregate
 * retained-bytes pool shared by its brokers. Calling it throws on a
 * malformed configuration.
 */
export interface DeviceBrokerFactory {
  (config: DeviceBrokerConfig, nowMs: number): DeviceBrokerPort;
  /**
   * The whole server-side handshake, in Rust (`negotiate_explained`, shared
   * by every server SDK and pinned by `conformance/selection.json`): strict
   * validation of the RAW `hello.device` JSON text (§2.1 JSON limits,
   * handshake-v1 schema, duplicate names — decision D7: an invalid hello
   * disables the device plane, it is never repaired), then selection
   * against `serverCapabilities` (absent: everything the broker consumes)
   * and device protocol v1. `binaryRoute`: the transport carries binary
   * frames. Throws only on a malformed `serverCapabilities`.
   */
  negotiate(
    helloText: string,
    binaryRoute: boolean,
    serverCapabilities?: readonly DeviceCapabilityOffer[]
  ): DeviceHandshakeOutcome;
}

/**
 * Normalize what a Rust `deviceHandshake` binding returned (`{ack}` or
 * `{ack: null, reason}`) into a {@link DeviceHandshakeOutcome}. Used by the
 * WASM-backed factories; anything but an ack object disables the plane.
 */
export function toDeviceHandshakeOutcome(raw: unknown): DeviceHandshakeOutcome {
  const r = raw as { ack?: unknown; reason?: unknown } | null | undefined;
  const ack = r?.ack;
  if (ack !== null && typeof ack === "object" && !Array.isArray(ack)) {
    return { ack: ack as DeviceAck };
  }
  return {
    ack: null,
    reason: typeof r?.reason === "string" ? r.reason : "device handshake returned no ack",
  };
}
