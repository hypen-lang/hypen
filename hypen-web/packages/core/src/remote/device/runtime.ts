/**
 * Device Capability Protocol — client-side runtime (RFC 001 §2.6/§5).
 *
 * `DeviceClient` is the transport-side runtime every DeviceHost is built on:
 * it consumes server → client device messages (deviceRequest, control),
 * dispatches to per-capability drivers, and produces client → server replies
 * (deviceResponse, capability events incl. blobStart, binary frames, lease
 * acks). It is driver-agnostic — the fake host (`@hypen-space/device-fake`)
 * and the real platform hosts (`@hypen-space/device-web`, …) all supply
 * drivers.
 *
 * `DeviceEndpoint` is the contract a browser/native client engine talks to:
 * an advertisement for `hello`, attach/detach around the socket lifetime, and
 * message/frame delivery.
 */

import { sha256Hex } from "./blob.js";
import {
  CONNECTION_VIOLATION_BURST,
  CONNECTION_VIOLATIONS_PER_SEC,
  DOWNLOAD_WINDOW_BYTES,
  LEASE_EXPIRY_MS,
  MAX_BULK_CHUNK_BYTES,
  MAX_TRANSPORT_PENDING_BYTES,
  MIN_FRAME_CHARGE_BYTES,
} from "./constants.js";
import { decodeFrame, encodeFrame } from "./frames.js";
import { decodeDeviceMessage } from "./strict-json.js";
import {
  DEVICE_SCHEMAS,
  validateCapabilityPayload,
  validateDeviceMessage,
  type DeviceAck,
  type DeviceErrorCode,
  type DeviceEvent,
  type DeviceHello,
  type DeviceRequest,
  type DeviceResponse,
  type SchemaViolation,
} from "./generated.js";
import {
  DEVICE_REGISTRY,
  findRevision,
  needsBinary,
  type DeviceRegistry,
  type DeviceRevisionBounds,
} from "./registry.js";

/**
 * One produced blob item (client → server upload, RFC 001 §2.4).
 *
 * Exactly one source: `bytes` (the whole item in memory — its size is known
 * and always declared in `blobStart`) or `stream` (chunks as they are
 * produced: a picked file read incrementally, a transcoder, a live
 * microphone). A stream's size is declared only when `declaredBytes` is set
 * (decision D5: senders that know the size SHOULD declare it; live sources
 * cannot). Either way the runtime enforces the revision's `maxItemBytes` as
 * bytes are produced, never sends past credit, hashes incrementally, and the
 * terminal result states each item's actual `bytes` and `sha256`. A
 * zero-byte item is announced (`blobStart`) and sends NO frame (decision D2).
 */
export interface DriverBlob {
  channel: number;
  contentType: string;
  /** The whole item. Mutually exclusive with `stream`. */
  bytes?: Uint8Array;
  /**
   * The item as it is produced. Mutually exclusive with `bytes`. The
   * runtime pulls it only as credit and the transport allow, and calls
   * `return()` when the request stops early (so a recorder / reader is
   * released). A thrown error ends the request (`internal`, or the error's
   * `code` when it is a DeviceErrorCode).
   */
  stream?: AsyncIterable<Uint8Array>;
  /**
   * Exact size of a `stream` item when known up front (e.g. `File.size`):
   * announced in `blobStart.bytes` and checked when the item ends. A stream
   * that produces more or fewer bytes ends the request `internal`.
   */
  declaredBytes?: number;
  /**
   * File name, for capabilities whose result items carry one (`file.pick`).
   * Rides only on the terminal result item — `blobStart` is a closed schema
   * without a name.
   */
  name?: string;
}

/** A driver's terminal outcome for one request. */
export type DriverOutcome =
  | {
      kind: "result";
      result: Record<string, unknown>;
      blobs?: DriverBlob[];
      /**
       * Called once every blob finished streaming (after the last frame,
       * before the terminal): its fields are merged over `result` — for
       * values only known at the end of a live capture, e.g. a recording's
       * `durationMs`. Not called when the request stopped early.
       */
      complete?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
      /**
       * The result is simulated (a development/fake driver): the terminal
       * carries the protocol-level `simulated: true` marker (RFC 001 §1.11).
       */
      simulated?: true;
    }
  | { kind: "error"; code: DeviceErrorCode; platformDetail?: string; simulated?: true };

/**
 * Receiving side of a server → client binary download (RFC 001 §2.4), e.g.
 * `file.save`. Present on `DriverContext.download` only when the request's
 * capability revision has a server → client binary data plane.
 *
 * No credit is granted until `receiveAll()` is called, so a driver calls it
 * only after consent and destination selection.
 */
export interface DownloadSink {
  readonly declared: { name: string; contentType: string; bytes: number; sha256: string };
  /**
   * Starts granting credit (keeping ≤256 KiB outstanding, replenishing as
   * frames arrive), collects channel-0 frames with contiguous seq, and
   * resolves with all bytes once the declared count arrived and sha256
   * matched. Rejects with an Error whose `code` property is a
   * DeviceErrorCode ("invalidParams" on mismatch/overflow/gap, "cancelled"
   * on cancel). Idempotent: repeated calls return the same promise.
   *
   * On an `invalidParams` rejection the runtime has already sent the
   * terminal `invalidParams` response; the driver's own outcome for that
   * request is ignored (it should still clean up any partial output).
   */
  receiveAll(): Promise<Uint8Array>;
}

/** Error shape `DownloadSink.receiveAll()` rejects with. */
export interface DeviceRuntimeError extends Error {
  code: DeviceErrorCode;
}

function runtimeError(code: DeviceErrorCode, message: string): DeviceRuntimeError {
  return Object.assign(new Error(message), { code });
}

export interface DriverContext {
  request: DeviceRequest;
  /**
   * Resolves when the operation stops before the driver finishes: server
   * cancel, local deadline, lease expiry, a client-detected violation, or
   * transport detach. The runtime has already sent (or suppressed) the
   * terminal response; the driver's own outcome is then ignored, so it only
   * needs to release hardware / dismiss prompts.
   */
  readonly cancelled: Promise<void>;
  /**
   * Emit a capability event (`deviceEvent.event`) for this request. On a
   * JSON-stream revision each event spends one unit of event credit; beyond
   * the credit the runtime applies the revision's overflow policy
   * (coalesce / dropOldest / bounded pause) and never sends past credit.
   *
   * `{kind: "progress", state}` is accepted on every revision, spends no
   * credit, and never goes back to `pendingConsent` after `running` or after
   * data (such a regression is dropped). On revisions without a JSON event
   * stream, progress is the only event a driver may emit (`blobStart` is the
   * runtime's); anything else ends the request `internal`.
   */
  emit(event: Record<string, unknown>): void;
  /**
   * The selected revision's bounds (item size/count, credit, deadline).
   * Always set by `DeviceClient`; optional so hand-built test contexts work.
   */
  readonly revision?: DeviceRevisionBounds;
  /** Server → client download sink; present only for download capabilities. */
  download?: DownloadSink;
  /**
   * End this request with an error from the driver's side at any time,
   * including after the driver already returned its outcome and the runtime
   * is uploading a live `stream` (RFC 001 §2.4 "overflow pause is bounded":
   * a recorder whose bounded capture window filled while the runtime waits
   * for credit ends the request `throttled`). A no-op once the request is
   * terminal. Always set by `DeviceClient`; optional so hand-built test
   * contexts work.
   */
  readonly fail?: (code: DeviceErrorCode, platformDetail?: string) => void;
}

/** A capability driver: given a request, eventually produces an outcome. */
export type DeviceDriver = (ctx: DriverContext) => Promise<DriverOutcome>;

/** What a `DeviceClient` needs from its transport to reply to the server. */
export interface DeviceClientTransport {
  sendMessage(message: DeviceResponse | DeviceEvent): void;
  sendBinary(frame: Uint8Array): void;
  /**
   * Bytes queued in the socket but not yet written (`WebSocket.bufferedAmount`).
   * Uploads wait while it reports ≥ 256 KiB (RFC 001 §2.3). Absent ⇒ 0.
   */
  bufferedAmount?(): number;
  /**
   * Close the device connection (RFC 001 §2.2 connection model: an app
   * request before the `core.capabilities` stream opened, a second live core
   * stream, or repeated connection-level violations). A socket transport
   * closes the WebSocket with `code` (1002, protocol error). The runtime has
   * already stopped every operation and ignores all later traffic.
   */
  close?(code: number, reason: string): void;
}

/**
 * The contract a client engine (browser `RemoteEngine`, native renderers)
 * uses to plug in a DeviceHost. The engine owns the socket; the endpoint
 * owns consent, drivers and teardown.
 */
export interface DeviceEndpoint {
  /** Complete initial advertisement carried in `hello.device` (RFC 001 §2.2). */
  readonly advertisement: DeviceHello;
  /** Socket opened: from now on the endpoint may reply through `io`. */
  attach(io: DeviceClientTransport): void;
  /** Handshake outcome: the selected intersection, or `undefined` if disabled. */
  onAck(ack: DeviceAck | undefined): void;
  /**
   * Server → client device message, already parsed. A `deviceResponse` is
   * accepted too: only the client sends responses, so one on a live id
   * terminates that operation `invalidParams` (decision D8).
   */
  handleMessage(message: DeviceRequest | DeviceEvent | DeviceResponse): void;
  /**
   * Server → client device message as its exact wire text, strictly decoded
   * under the RFC 001 §2.1 JSON limits (size before parsing, integer
   * tokens, no duplicate keys, depth ≤ 32, …). Text breaking the limits is a
   * connection-level violation (discarded and counted, never terminating a
   * request); a schema-invalid message with a device type and a u32 id is a
   * known-id invalid message. Preferred over `handleMessage` by transports.
   */
  handleText?(text: string): void;
  /** Server → client binary frame (downloads). */
  handleFrame(frame: Uint8Array): void;
  /**
   * A server → client device message the transport already found malformed
   * before it could be trusted as JSON (e.g. duplicate object keys). A live
   * id terminates with `invalidParams`; anything else is ignored.
   */
  handleMalformed?(message: unknown, detail: string): void;
  /** Socket closed: stop every operation, release hardware, dismiss prompts. */
  detach(): void;
}

export interface DeviceClientOptions {
  /** Registry bounds used to classify/validate requests. Defaults to v1. */
  registry?: DeviceRegistry;
  /**
   * This client is the device endpoint of a real connection (every
   * `DeviceEndpoint` host sets it). Then (RFC 001 §2.2):
   * - no request is admitted before the handshake outcome arrives
   *   (`setSelection`) — until then every request is refused `unsupported`;
   * - the first selection carrying `device` is final for the connection; a
   *   later ack cannot change it (an earlier device-less ack can still be
   *   followed by one carrying `device`, decision D6);
   * - app requests only after the `core.capabilities` stream opened, and at
   *   most one live core stream; either breach closes the device connection
   *   (`transport.close`);
   * - the live selection follows the snapshots the core stream sent.
   * Without it (in-process wiring and tests, where no handshake exists) a
   * request needs only a registry revision and a driver until
   * `setSelection` is called.
   */
  requireHandshake?: boolean;
  /** Download receive window (outstanding granted credit). Default 256 KiB. */
  downloadWindow?: number;
  /** Uploads wait while `bufferedAmount()` ≥ this. Default 256 KiB. */
  pendingLimit?: number;
  /** Yield between upload chunks. Default: a `setTimeout(0)` macrotask. */
  yieldTurn?: () => Promise<void>;
  /** Poll delay while the transport is saturated, ms. Default 10. */
  drainPollMs?: number;
  /**
   * Local maximum for a request's overall deadline (RFC 001 §2.1: the client
   * uses `min(timeoutMs, localMaximum)` from receipt). Applies to every
   * non-`connection` request; the connection-owned control stream is bounded
   * by its revision's `maxTimeoutMs` instead. Default: no extra local cap.
   */
  maxTimeoutMs?: number;
  /** Monotonic clock + one-shot timers (tests inject a fake). */
  clock?: DeviceClientClock;
  /** Lease expiry after receipt / last accepted renewal. Default 15 s (§2.7). */
  leaseExpiryMs?: number;
  /** Bound on unsent JSON events queued per request beyond credit. Default 64. */
  maxQueuedEvents?: number;
  /**
   * Overflow policy per JSON-stream revision. Defaults to `jsonEventOverflow`
   * (the registry's policy); injectable for tests / future revisions.
   */
  jsonEventOverflow?: (capability: string, rev: DeviceRevisionBounds) => JsonEventOverflow;
}

/** Monotonic clock with one-shot timers, injectable for deterministic tests. */
export interface DeviceClientClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
};
const sleep = (ms: number) => new Promise<void>((r) => timers.setTimeout(() => r(), ms));

/** Default clock: `performance.now()` (monotonic) where available. */
export const systemDeviceClientClock: DeviceClientClock = {
  now: () => (typeof timers.performance?.now === "function" ? timers.performance.now() : Date.now()),
  setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
  clearTimeout: (h) => timers.clearTimeout(h),
};

/**
 * What a JSON-stream sender does with an event when its event credit is
 * exhausted (RFC 001 §2.2/§2.3), derived from the revision's `overflow`:
 * `core.capabilities` (dropOldest) coalesces unsent updates into one latest
 * snapshot; other `dropOldest` revisions keep a bounded queue and drop its
 * oldest entry; `pause` keeps a bounded queue, reports `paused`, and
 * terminates `throttled` when the bound would be exceeded (never an
 * unbounded buffer).
 */
export type JsonEventOverflow = "coalesce" | "dropOldest" | "pause";

export function jsonEventOverflow(capability: string, rev: DeviceRevisionBounds): JsonEventOverflow {
  if (rev.overflow === "dropOldest") return capability === "core.capabilities" ? "coalesce" : "dropOldest";
  return "pause";
}

/**
 * Revisions of `capability` this runtime can admit: a registry entry plus a
 * generated schema (params/result validators). Hosts advertise exactly
 * these (RFC 001 §2.2 "advertise only implementable capability names and
 * revision numbers"); anything else would be refused `unsupported`.
 */
export function implementableVersions(
  capability: string,
  registry: DeviceRegistry = DEVICE_REGISTRY
): number[] {
  return (registry.get(capability) ?? [])
    .map((r) => r.version)
    .filter((v) => `${capability}-v${v}` in DEVICE_SCHEMAS);
}

const MAX_PLATFORM_DETAIL = 512;
const U32_MAX = 0xffff_ffff;

const ERROR_CODES: ReadonlySet<string> = new Set<DeviceErrorCode>([
  "unsupported",
  "unavailable",
  "denied",
  "revoked",
  "cancelled",
  "timeout",
  "throttled",
  "connectionLost",
  "invalidParams",
  "internal",
]);

function describeViolations(v: SchemaViolation[]): string {
  return v
    .slice(0, 3)
    .map((x) => `${x.path}: ${x.message}`)
    .join("; ");
}

/**
 * Owner shape must match the lifetime exactly (RFC 001 §2.7):
 * activation ⇒ `{moduleInstanceId, activationId ≥ 1}`; background ⇒
 * `{moduleInstanceId}`; connection ⇒ `{connection: true}`.
 */
function ownerMatchesLifetime(owner: unknown, lifetime: string): boolean {
  if (!owner || typeof owner !== "object") return false;
  const o = owner as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  switch (lifetime) {
    case "activation":
      return (
        keys === "activationId,moduleInstanceId" &&
        typeof o.moduleInstanceId === "string" &&
        typeof o.activationId === "number" &&
        Number.isInteger(o.activationId) &&
        o.activationId >= 1 &&
        o.activationId <= U32_MAX
      );
    case "background":
      return keys === "moduleInstanceId" && typeof o.moduleInstanceId === "string";
    case "connection":
      return keys === "connection" && o.connection === true;
    default:
      return false;
  }
}

/**
 * The result field that carries a revision's blob items: `items` (a list,
 * e.g. `gallery.pick`) or `item` (exactly one, e.g. `mic.record`), read from
 * the generated result schema.
 */
export function resultItemField(capability: string, version: number): "items" | "item" {
  const doc = DEVICE_SCHEMAS[`${capability}-v${version}`] as
    | { $defs?: { result?: { properties?: Record<string, unknown> } } }
    | undefined;
  const props = doc?.$defs?.result?.properties ?? {};
  return "item" in props && !("items" in props) ? "item" : "items";
}

type ProgressState = "pendingConsent" | "running";

interface Inflight {
  request: DeviceRequest;
  rev: DeviceRevisionBounds;
  resolveCancel: () => void;
  /** Terminal (response sent or suppressed) — no further replies. */
  stopped: boolean;
  /** Data credit balance: payload bytes (uploads) or events (JSON streams). */
  credit: number;
  paused: boolean;
  wake: (() => void) | null;
  sink: DownloadSinkImpl | null;
  /** Last accepted `renewLease` sequence (0 = none yet). */
  leaseSeq: number;
  /** Monotonic time the lease lapses (§2.7). */
  leaseExpiresAt: number;
  leaseTimer: unknown;
  deadlineTimer: unknown;
  /** Unsent JSON events beyond credit (bounded; see JsonEventOverflow). */
  events: Array<Record<string, unknown>>;
  overflow: JsonEventOverflow;
  /** Last progress state sent; never goes back to pendingConsent. */
  progress: ProgressState | null;
  /** Data (an event, a blob announcement or a frame) was sent. */
  dataSeen: boolean;
  /** Release functions of upload sources still being pulled. */
  releases: Array<() => void>;
}

class DownloadSinkImpl implements DownloadSink {
  private promise: Promise<Uint8Array> | null = null;
  private resolveFn: ((b: Uint8Array) => void) | null = null;
  private rejectFn: ((e: Error) => void) | null = null;
  private started = false;
  private settled = false;
  private failure: DeviceRuntimeError | null = null;
  private granted = 0;
  private received = 0;
  private nextSeq = 0;
  private chunks: Uint8Array[] = [];
  /** The sender's last reported `paused` state (§2.3). */
  private senderPaused = false;

  constructor(
    readonly declared: { name: string; contentType: string; bytes: number; sha256: string },
    private readonly window: number,
    private readonly sendGrant: (n: number) => void,
    /** Client-detected violation: the runtime terminates the request. */
    private readonly onViolation: (detail: string) => void
  ) {}

  receiveAll(): Promise<Uint8Array> {
    if (!this.promise) {
      this.promise = new Promise<Uint8Array>((resolve, reject) => {
        this.resolveFn = resolve;
        this.rejectFn = reject;
      });
      if (this.failure) {
        this.rejectFn!(this.failure);
      } else if (!this.settled) {
        this.started = true;
        if (this.declared.bytes === 0) void this.finalize();
        else this.topUp();
      }
    }
    return this.promise;
  }

  /** One channel/seq-validated frame for this request. */
  accept(channel: number, seq: number, payload: Uint8Array): void {
    if (this.settled) return;
    // A zero-length frame carries no data: always a violation (decision D2).
    if (payload.byteLength === 0) return this.violation("zero-length download frame");
    if (this.senderPaused) return this.violation("download data after the sender reported paused");
    if (channel !== 0) return this.violation(`download frame on channel ${channel}`);
    if (seq !== this.nextSeq) {
      return this.violation(`download seq ${seq}, expected ${this.nextSeq}`);
    }
    const len = payload.byteLength;
    if (this.received + len > this.granted) {
      return this.violation(
        `download frame of ${len} bytes exceeds granted credit ${this.granted - this.received}`
      );
    }
    if (this.received + len > this.declared.bytes) {
      return this.violation(`download exceeds declared ${this.declared.bytes} bytes`);
    }
    this.nextSeq += 1;
    this.received += len;
    this.chunks.push(payload.slice());
    if (this.received === this.declared.bytes) void this.finalize();
    else this.topUp();
  }

  /** The sender's `paused` transition; repeating the current state is a violation. */
  senderPausedChanged(paused: boolean): void {
    if (this.settled) return;
    if (paused === this.senderPaused) {
      this.violation(`paused:${paused} repeats the current state`);
      return;
    }
    this.senderPaused = paused;
  }

  fail(code: DeviceErrorCode, detail: string): void {
    if (this.settled) return;
    this.settled = true;
    this.chunks = [];
    this.failure = runtimeError(code, detail);
    this.rejectFn?.(this.failure);
  }

  private violation(detail: string): void {
    this.fail("invalidParams", detail);
    this.onViolation(detail);
  }

  /** Keep ≤ window outstanding, never granting past the declared size. */
  private topUp(): void {
    if (!this.started || this.settled) return;
    const outstanding = this.granted - this.received;
    const want = Math.min(this.window - outstanding, this.declared.bytes - this.granted);
    if (want > 0) {
      this.granted += want;
      this.sendGrant(want);
    }
  }

  private async finalize(): Promise<void> {
    const joined = new Uint8Array(this.received);
    let off = 0;
    for (const c of this.chunks) {
      joined.set(c, off);
      off += c.byteLength;
    }
    const hash = await sha256Hex(joined);
    if (this.settled) return;
    if (hash !== this.declared.sha256) {
      this.violation("download sha256 mismatch");
      return;
    }
    this.settled = true;
    this.chunks = [];
    this.resolveFn?.(joined);
  }
}

/** Validate `file.save`-shaped download params; returns an error detail. */
function parseDownloadDeclaration(
  request: DeviceRequest,
  rev: DeviceRevisionBounds
): { ok: true; declared: DownloadSink["declared"] } | { ok: false; detail: string } {
  if (request.initialCredit !== 0) {
    return { ok: false, detail: "server→client data plane requires initialCredit 0" };
  }
  const p = request.params as Record<string, unknown>;
  if (p?.channel !== 0) return { ok: false, detail: "download channel must be 0" };
  if (typeof p.name !== "string" || typeof p.contentType !== "string") {
    return { ok: false, detail: "download name/contentType must be strings" };
  }
  const bytes = p.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, detail: "download bytes must be a non-negative integer" };
  }
  if (bytes > rev.maxItemBytes) {
    return { ok: false, detail: `download of ${bytes} bytes exceeds max item bytes ${rev.maxItemBytes}` };
  }
  if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) {
    return { ok: false, detail: "download sha256 must be 64 lowercase hex chars" };
  }
  return {
    ok: true,
    declared: { name: p.name, contentType: p.contentType, bytes, sha256: p.sha256 },
  };
}

/** Bound on the per-connection `moduleInstanceId → activationId` memory. */
const MAX_TRACKED_ACTIVATIONS = 4096;
const CORE = "core.capabilities";

/**
 * Client-side device runtime. Feed it server → client device messages with
 * `handleText` (exact wire text) or `handleMessage` / `handleFrame`; it
 * drives them and replies through the transport.
 *
 * Admission (RFC 001 §2.1/§2.6 step 1): text is strictly decoded under the
 * §2.1 JSON limits (a breach is a connection-level violation: discarded and
 * counted, never terminating a request; repeated breaches close the device
 * connection); every message is validated against the generated envelope
 * schema; request ids follow a high-water mark (duplicate/older ids are
 * dropped without executing); the capability revision must be in the live
 * selection (the negotiated one, filtered by the latest `core.capabilities`
 * snapshot) with a registry entry and a driver, else `unsupported`;
 * owner/lifetime shape, `timeoutMs`, `initialCredit` and params are checked
 * against the revision, and `activationId` never goes backwards per
 * `moduleInstanceId`, else `invalidParams`. With `requireHandshake` nothing
 * is admitted before the handshake, and the connection model holds (§2.2):
 * app requests only after the core stream opened, one live core stream.
 *
 * Violations (decision D8): liveness is checked before direction — any
 * message for an unknown/retired id is ignored, whatever it is. On a live
 * id, a malformed message, a server `deviceResponse`, a server capability
 * `event` (events flow client → server), a `grant` on a revision without a
 * client → server data plane, a server `leaseAck`, `paused` from a
 * non-sender (or repeating its state), a renewal that does not start at 1 or
 * strictly increase, and a zero-length or out-of-credit download frame
 * terminate the operation with `invalidParams`.
 *
 * Liveness (§2.1/§2.7): each admitted request gets a 15 s lease from receipt
 * (also while awaiting consent) and a local deadline of
 * `min(timeoutMs, localMaximum)`. Renewals extend the lease and are echoed
 * as `leaseAck`; unknown ids get no ack. Lease expiry ⇒ terminal
 * `connectionLost`; deadline ⇒ `timeout`; both stop the driver (its
 * `cancelled` resolves).
 *
 * Cancellation: a server `control.cancel` on a live id stops the driver and
 * sends the terminal `cancelled` (§2.1); a late driver result (e.g. an OS
 * dialog finishing afterwards) is discarded and never uploads.
 *
 * Data credit (§2.3): uploads are credit-paced — the balance starts at the
 * request's `initialCredit`, each frame spends its payload length, the
 * runtime never sends beyond the balance: it pauses (one `paused:true`) and
 * resumes on `control.grant` (one `paused:false`). Between chunks it yields a
 * turn and waits while the transport reports ≥ 256 KiB pending. Items may
 * stream with or without a declared size (decision D5); a zero-byte item
 * sends no frame (D2). JSON streams spend one credit per event with the
 * revision's overflow policy; progress events spend none.
 *
 * Downloads are routed by request id to the request's `DownloadSink`;
 * frames for unknown ids are dropped.
 */
export class DeviceClient {
  private readonly inflight = new Map<number, Inflight>();
  private detached = false;
  /** Highest request id seen on this connection (§2.1 high-water mark). */
  private maxSeenId = 0;
  /**
   * Negotiated selection: `undefined` until the handshake reports one,
   * `null` when the device plane is disabled, else capability → selected
   * version. Final once a selection carrying `device` was applied.
   */
  private selection: Map<string, number> | null | undefined = undefined;
  private selectionFinal = false;
  /** Live selection: the negotiated one filtered by the latest sent snapshot. */
  private live: Map<string, number> | null = null;
  /** A core.capabilities stream was admitted on this connection. */
  private coreOpened = false;
  /** Id of the most recently admitted core.capabilities stream. */
  private coreId: number | null = null;
  /** Highest activationId seen per moduleInstanceId (exact code units). */
  private readonly activations = new Map<string, number>();
  private violationTokens = CONNECTION_VIOLATION_BURST;
  private violationRefilledAt: number;
  private violations = 0;
  private readonly registry: DeviceRegistry;
  private readonly requireHandshake: boolean;
  private readonly downloadWindow: number;
  private readonly pendingLimit: number;
  private readonly yieldTurn: () => Promise<void>;
  private readonly drainPollMs: number;
  private readonly maxTimeoutMs: number;
  private readonly clock: DeviceClientClock;
  private readonly leaseExpiryMs: number;
  private readonly maxQueuedEvents: number;
  private readonly overflowPolicy: (capability: string, rev: DeviceRevisionBounds) => JsonEventOverflow;

  constructor(
    private readonly transport: DeviceClientTransport,
    /** capability name → driver. */
    private readonly drivers: Map<string, DeviceDriver>,
    options: DeviceClientOptions = {}
  ) {
    this.registry = options.registry ?? DEVICE_REGISTRY;
    this.requireHandshake = options.requireHandshake ?? false;
    this.downloadWindow = options.downloadWindow ?? DOWNLOAD_WINDOW_BYTES;
    this.pendingLimit = options.pendingLimit ?? MAX_TRANSPORT_PENDING_BYTES;
    this.yieldTurn = options.yieldTurn ?? (() => sleep(0));
    this.drainPollMs = options.drainPollMs ?? 10;
    this.maxTimeoutMs = options.maxTimeoutMs ?? Number.POSITIVE_INFINITY;
    this.clock = options.clock ?? systemDeviceClientClock;
    this.leaseExpiryMs = options.leaseExpiryMs ?? LEASE_EXPIRY_MS;
    this.maxQueuedEvents = Math.max(1, options.maxQueuedEvents ?? 64);
    this.overflowPolicy = options.jsonEventOverflow ?? jsonEventOverflow;
    this.violationRefilledAt = this.clock.now();
  }

  /**
   * Record the handshake outcome (RFC 001 §2.2). From now on a request is
   * admitted only for the exact selected `(capability, version)`; `undefined`
   * (device plane disabled) refuses every request with `unsupported`.
   *
   * The first selection carrying `device` is final: later calls are ignored,
   * so a second `sessionAck` cannot change what this connection may do. A
   * device-less outcome may still be followed by one carrying `device`
   * (decision D6). Without the binary profile, binary-plane revisions are
   * not selectable; duplicate names make the selection invalid (disabled).
   */
  setSelection(ack: DeviceAck | undefined): void {
    if (this.selectionFinal) return;
    if (!ack) {
      this.selection = null;
      this.live = null;
      return;
    }
    this.selectionFinal = true;
    const selected = new Map<string, number>();
    for (const c of ack.capabilities) {
      if (selected.has(c.name)) {
        this.selection = null; // duplicate capability names: invalid ack (D7)
        this.live = null;
        return;
      }
      const rev = findRevision(c.name, c.version, this.registry);
      if (!ack.binary && rev && needsBinary(rev)) continue;
      selected.set(c.name, c.version);
    }
    this.selection = selected;
    this.live = new Map(selected);
  }

  /** Number of live (non-terminal) operations. */
  get liveCount(): number {
    return this.inflight.size;
  }

  /** Connection-level violations counted so far (D3/D8). */
  get connectionViolations(): number {
    return this.violations;
  }

  /** The device connection was closed by this runtime (or detached). */
  get closed(): boolean {
    return this.detached;
  }

  /** The live selection (negotiated ∩ latest snapshot), for hosts and tests. */
  get liveSelection(): ReadonlyMap<string, number> | null {
    return this.live;
  }

  /**
   * Handle a server → client device message given as its exact wire text:
   * strict decoding under the JSON limits first (see class doc).
   */
  handleText(text: string): void {
    if (this.detached) return;
    const decoded = decodeDeviceMessage(text);
    if (decoded.ok) {
      this.dispatch(decoded.message as unknown, null);
      return;
    }
    if (decoded.id === null) {
      // Attributable to no request (JSON limits, no clean type/id): discard
      // and count; never terminate the request the text seems to name.
      this.connectionViolation(decoded.reason);
      return;
    }
    this.dispatch({ type: decoded.type, id: decoded.id }, `malformed ${decoded.type}: ${decoded.reason}`);
  }

  /** Handle a server → client device message (validated here; see class doc). */
  handleMessage(message: DeviceRequest | DeviceEvent | DeviceResponse): void {
    if (this.detached) return;
    const raw = message as unknown;
    const type = (raw as { type?: unknown } | null)?.type;
    if (type !== "deviceRequest" && type !== "deviceEvent" && type !== "deviceResponse") return;
    const violations = validateDeviceMessage(raw);
    this.dispatch(raw, violations.length > 0 ? `malformed ${type}: ${describeViolations(violations)}` : null);
  }

  /**
   * A message the transport found malformed before trusting its JSON. A
   * live id terminates `invalidParams`; a fresh request id is consumed and
   * refused `invalidParams` (never executed); anything else is ignored.
   */
  handleMalformed(message: unknown, detail: string): void {
    if (this.detached) return;
    const type = (message as { type?: unknown } | null)?.type;
    if (type !== "deviceRequest" && type !== "deviceEvent" && type !== "deviceResponse") return;
    this.dispatch(message, detail);
  }

  /**
   * Handle a server → client binary frame. Routed to the live download sink
   * by request id; unknown ids are dropped without allocating storage. A
   * frame for a known request without a download plane terminates it. A
   * frame whose header cannot be trusted (short, unknown version, nonzero
   * flags) is a connection-level violation: dropped and counted (D3).
   */
  handleFrame(frame: Uint8Array): void {
    if (this.detached) return;
    const decoded = decodeFrame(frame);
    if (!decoded.ok) {
      // Short frames are dropped; an unknown version / nonzero flags is a
      // connection-level violation (D3). Both are counted.
      this.connectionViolation(decoded.error.kind === "violation" ? `bad frame header: ${decoded.error.detail}` : "short frame");
      return;
    }
    const entry = this.inflight.get(decoded.header.requestId);
    if (!entry || entry.stopped) return;
    if (!entry.sink) {
      this.terminate(entry, "invalidParams", "binary frame on a request without a download plane");
      return;
    }
    entry.sink.accept(decoded.header.channel, decoded.header.seq, decoded.payload);
  }

  /**
   * Transport gone: every in-flight driver observes `cancelled`, timers stop,
   * no further replies are sent (RFC 001 §2.5 — connection loss tears
   * everything down). Idempotent.
   */
  detach(): void {
    this.detached = true;
    for (const entry of [...this.inflight.values()]) {
      entry.sink?.fail("cancelled", "transport detached");
      this.settle(entry, null);
    }
  }

  // ---- dispatch ----

  /**
   * Route one message (liveness before direction, D8). `malformed` is set
   * when the message failed strict decoding / the envelope schema but is
   * attributable to its id.
   */
  private dispatch(raw: unknown, malformed: string | null): void {
    const type = (raw as { type?: unknown } | null)?.type;
    if (type === "deviceRequest") {
      this.receiveRequest(raw, malformed);
      return;
    }
    const entry = this.liveEntry(raw);
    if (!entry) return; // unknown/retired id: ignored in any direction
    if (malformed !== null) {
      this.terminate(entry, "invalidParams", malformed);
      return;
    }
    if (type === "deviceResponse") {
      // Only the client sends responses (D8).
      this.terminate(entry, "invalidParams", "wrong-direction deviceResponse from server");
      return;
    }
    const control = (raw as DeviceEvent).control;
    // Capability events flow client → server only (§2.1; shared fixture
    // violation-event-from-server): a server event on a live id is a
    // direction violation that terminates the op.
    if (!control) {
      this.terminate(entry, "invalidParams", "wrong-direction capability event from server");
      return;
    }
    if ("renewLease" in control) {
      this.renew(entry, control.renewLease);
    } else if ("cancel" in control) {
      this.serverCancel(entry);
    } else if ("grant" in control) {
      this.receiveGrant(entry, control.grant);
    } else if ("paused" in control) {
      // Backpressure status travels data sender → receiver: legitimate from
      // the server only on a server → client data plane.
      if (entry.rev.data !== "binaryDownload" || !entry.sink) {
        this.terminate(entry, "invalidParams", "wrong-direction control: paused");
      } else {
        entry.sink.senderPausedChanged(control.paused);
      }
    } else {
      this.terminate(entry, "invalidParams", "wrong-direction control: leaseAck");
    }
  }

  /**
   * A connection-level violation (D3/D8): discarded and counted. Past the
   * burst (refilled per second) the device connection closes.
   */
  private connectionViolation(_detail: string): void {
    this.violations += 1;
    const now = this.clock.now();
    const refill = ((now - this.violationRefilledAt) / 1000) * CONNECTION_VIOLATIONS_PER_SEC;
    this.violationTokens = Math.min(CONNECTION_VIOLATION_BURST, this.violationTokens + refill);
    this.violationRefilledAt = now;
    if (this.violationTokens < 1) {
      this.closeConnection("repeated device protocol violations");
      return;
    }
    this.violationTokens -= 1;
  }

  /**
   * The device connection's control plane broke (§2.2): stop everything,
   * ignore all later traffic, and ask the transport to close (1002).
   */
  private closeConnection(reason: string): void {
    if (this.detached) return;
    this.detach();
    try {
      this.transport.close?.(1002, reason);
    } catch {
      /* transport already gone */
    }
  }

  // ---- admission ----

  private liveEntry(raw: unknown): Inflight | undefined {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "number") return undefined;
    const entry = this.inflight.get(id);
    return entry && !entry.stopped ? entry : undefined;
  }

  /**
   * High-water mark first (duplicates/older ids never execute), then the
   * envelope, the connection model, selection, revision, owner/lifetime and
   * limits.
   */
  private receiveRequest(raw: unknown, malformed: string | null): void {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > U32_MAX) return; // unroutable
    if (id <= this.maxSeenId) return; // duplicate/older: dropped without executing again
    this.maxSeenId = id;
    if (malformed !== null) {
      this.sendError(id, "invalidParams", malformed);
      return;
    }
    const request = raw as DeviceRequest;
    // Connection model (§2.2): the connection-owned control stream opens
    // first, and at most one is live. Only once device work is negotiated.
    if (this.requireHandshake && this.selection instanceof Map) {
      if (request.capability === CORE) {
        const current = this.coreId === null ? undefined : this.inflight.get(this.coreId);
        if (current && !current.stopped) {
          this.closeConnection("a second live core.capabilities stream");
          return;
        }
      } else if (!this.coreOpened) {
        this.closeConnection("app request before core.capabilities opened");
        return;
      }
    }
    const admitted = this.admit(request);
    if ("code" in admitted) {
      this.sendError(id, admitted.code, admitted.detail);
      return;
    }
    if (request.capability === CORE) {
      this.coreOpened = true;
      this.coreId = id;
    }
    void this.runRequest(request, admitted.rev);
  }

  private admit(
    request: DeviceRequest
  ): { rev: DeviceRevisionBounds } | { code: DeviceErrorCode; detail: string } {
    const { capability, version } = request;
    if (this.selection === null) return { code: "unsupported", detail: "device plane not negotiated" };
    if (this.selection === undefined && this.requireHandshake) {
      return { code: "unsupported", detail: "no device selection yet (sessionAck pending)" };
    }
    if (this.selection !== undefined) {
      // core.capabilities@1 stays requestable whatever a snapshot says (a
      // planned reopen); everything else follows the live selection.
      const selected = capability === CORE ? this.selection.get(capability) : (this.live ?? this.selection).get(capability);
      if (selected !== version) {
        return { code: "unsupported", detail: `${capability}@${version} is not in the live selection` };
      }
    }
    if (!this.drivers.has(capability)) return { code: "unsupported", detail: `no driver for ${capability}` };
    const rev = findRevision(capability, version, this.registry);
    if (!rev || !(`${capability}-v${version}` in DEVICE_SCHEMAS)) {
      return { code: "unsupported", detail: `${capability}@${version} is not implemented` };
    }
    if (!rev.lifetimes.includes(request.lifetime)) {
      return { code: "invalidParams", detail: `lifetime ${request.lifetime} not allowed for ${capability}@${version}` };
    }
    if (!ownerMatchesLifetime(request.owner, request.lifetime)) {
      return { code: "invalidParams", detail: `owner shape does not match lifetime ${request.lifetime}` };
    }
    // activationIds never go backwards per module instance: an older one
    // would resurrect swept authority (§2.7).
    if (request.lifetime === "activation") {
      const owner = request.owner as { moduleInstanceId: string; activationId: number };
      const seen = this.activations.get(owner.moduleInstanceId);
      if (seen !== undefined && owner.activationId < seen) {
        return { code: "invalidParams", detail: "activationId went backwards" };
      }
      if (seen === undefined && this.activations.size >= MAX_TRACKED_ACTIVATIONS) {
        const oldest = this.activations.keys().next().value;
        if (oldest !== undefined) this.activations.delete(oldest);
      }
      this.activations.set(owner.moduleInstanceId, owner.activationId);
    }
    if (request.timeoutMs > rev.maxTimeoutMs) {
      return { code: "invalidParams", detail: `timeoutMs ${request.timeoutMs} exceeds ${rev.maxTimeoutMs}` };
    }
    if (request.initialCredit > rev.maxInitialCredit) {
      return {
        code: "invalidParams",
        detail: `initialCredit ${request.initialCredit} exceeds ${rev.maxInitialCredit}`,
      };
    }
    const params = validateCapabilityPayload(capability, version, "params", request.params);
    if (params.length > 0) {
      return { code: "invalidParams", detail: `params: ${describeViolations(params)}` };
    }
    return { rev };
  }

  // ---- liveness ----

  private renew(entry: Inflight, seq: number): void {
    // Lease sequences are u32 (1..4294967295) on the wire; anything else is
    // a malformed renewal on a live id (§2.7), whatever the validator allows.
    if (!Number.isInteger(seq) || seq < 1 || seq > U32_MAX) {
      this.terminate(entry, "invalidParams", "renewLease must be a u32 ≥ 1");
      return;
    }
    // Check expiry before processing a queued renewal (§2.7): an expired
    // operation cannot be revived.
    if (this.clock.now() >= entry.leaseExpiresAt) {
      this.terminate(entry, "connectionLost", "lease expired");
      return;
    }
    // The first renewal is 1; later ones may skip but strictly increase
    // (shared fixtures violation-renew-lease-not-starting-at-1 /
    // -not-increasing).
    if (entry.leaseSeq === 0 ? seq !== 1 : seq <= entry.leaseSeq) {
      this.terminate(
        entry,
        "invalidParams",
        entry.leaseSeq === 0 ? `first renewLease is ${seq}, not 1` : `renewLease ${seq} does not increase past ${entry.leaseSeq}`
      );
      return;
    }
    entry.leaseSeq = seq;
    entry.leaseExpiresAt = this.clock.now() + this.leaseExpiryMs;
    this.transport.sendMessage({ type: "deviceEvent", id: entry.request.id, control: { leaseAck: seq } });
  }

  private armLease(entry: Inflight): void {
    const delay = Math.max(0, entry.leaseExpiresAt - this.clock.now());
    entry.leaseTimer = this.clock.setTimeout(() => {
      entry.leaseTimer = null;
      if (entry.stopped) return;
      if (this.clock.now() >= entry.leaseExpiresAt) {
        this.terminate(entry, "connectionLost", "lease expired");
      } else {
        this.armLease(entry); // renewed since: wait for the new expiry
      }
    }, delay);
  }

  private clearTimers(entry: Inflight): void {
    if (entry.leaseTimer !== null) this.clock.clearTimeout(entry.leaseTimer);
    if (entry.deadlineTimer !== null) this.clock.clearTimeout(entry.deadlineTimer);
    entry.leaseTimer = null;
    entry.deadlineTimer = null;
  }

  // ---- terminal paths ----

  /**
   * Retire an operation exactly once: stop timers, wake/cancel the driver,
   * release upload sources, drop queued events, forget the id, and send
   * `response` (if any, and the transport is attached). Returns false if it
   * was already terminal.
   */
  private settle(entry: Inflight, response: DeviceResponse | null): boolean {
    if (entry.stopped) return false;
    entry.stopped = true;
    this.clearTimers(entry);
    entry.events = [];
    entry.resolveCancel();
    entry.wake?.();
    entry.wake = null;
    for (const release of entry.releases.splice(0)) release();
    if (this.inflight.get(entry.request.id) === entry) this.inflight.delete(entry.request.id);
    if (response && !this.detached) this.transport.sendMessage(this.checked(entry, response));
    return true;
  }

  /** Never put a schema-violating terminal on the wire: degrade to `internal`. */
  private checked(entry: Inflight, response: DeviceResponse): DeviceResponse {
    const envelope = validateDeviceMessage(response);
    const result =
      envelope.length === 0 && response.result !== undefined
        ? validateCapabilityPayload(entry.request.capability, entry.request.version, "result", response.result)
        : [];
    if (envelope.length === 0 && result.length === 0) return response;
    const bad = envelope.length > 0 ? envelope : result;
    return {
      type: "deviceResponse",
      id: entry.request.id,
      error: {
        code: "internal",
        platformDetail: `driver produced an invalid response: ${describeViolations(bad)}`.slice(0, MAX_PLATFORM_DETAIL),
      },
    };
  }

  /** Client-detected condition on a live id: send the terminal error. */
  private terminate(entry: Inflight, code: DeviceErrorCode, detail?: string): void {
    if (entry.stopped) return;
    entry.sink?.fail(code, detail ?? code);
    this.settle(entry, errorResponse(entry.request.id, code, detail));
  }

  /** Server `control.cancel`: stop the driver, respond `cancelled` (§2.1). */
  private serverCancel(entry: Inflight): void {
    entry.sink?.fail("cancelled", "request cancelled");
    this.settle(entry, errorResponse(entry.request.id, "cancelled"));
  }

  private receiveGrant(entry: Inflight, grant: number): void {
    const data = entry.rev.data;
    // No data plane: a grant is a credit violation (§2.3; shared fixture
    // violation-grant-without-data-plane).
    if (data === "none") {
      this.terminate(entry, "invalidParams", "grant on a request without a data plane");
      return;
    }
    if (entry.sink || data === "binaryDownload") {
      this.terminate(entry, "invalidParams", "grant on a server→client data plane");
      return;
    }
    if (!Number.isSafeInteger(grant) || grant <= 0) {
      this.terminate(entry, "invalidParams", "grant must be a positive integer");
      return;
    }
    const next = entry.credit + grant;
    if (next > entry.rev.maxOutstandingCredit) {
      this.terminate(entry, "invalidParams", "grant overflows max outstanding credit");
      return;
    }
    entry.credit = next;
    if (data === "jsonEvents") {
      this.flushEvents(entry);
      return;
    }
    entry.wake?.();
    entry.wake = null;
  }

  // ---- events ----

  private emit(entry: Inflight, event: Record<string, unknown>): void {
    if (entry.stopped || this.detached) return;
    if (event?.kind === "progress") {
      this.emitProgress(entry, event);
      return;
    }
    if (entry.rev.data !== "jsonEvents") {
      // blobStart belongs to the runtime; no other event exists here.
      this.terminate(entry, "internal", "driver emitted an event on a revision without a JSON event stream");
      return;
    }
    const violations = validateCapabilityPayload(entry.request.capability, entry.request.version, "event", event);
    if (violations.length > 0) {
      this.terminate(entry, "internal", `driver emitted an invalid event: ${describeViolations(violations)}`);
      return;
    }
    if (entry.credit > 0 && entry.events.length === 0) {
      entry.credit -= 1;
      this.sendEvent(entry, event);
      return;
    }
    // Beyond credit: never send; apply the revision's overflow policy.
    switch (entry.overflow) {
      case "coalesce":
        entry.events = [event]; // one latest snapshot
        break;
      case "dropOldest":
        if (entry.events.length >= this.maxQueuedEvents) entry.events.shift();
        entry.events.push(event);
        break;
      case "pause":
        if (entry.events.length >= this.maxQueuedEvents) {
          this.terminate(entry, "throttled", "event queue overflow while paused");
          return;
        }
        entry.events.push(event);
        if (!entry.paused) {
          entry.paused = true;
          this.transport.sendMessage({ type: "deviceEvent", id: entry.request.id, control: { paused: true } });
        }
        break;
    }
  }

  /**
   * Progress (`pendingConsent` → `running`) spends no credit and never goes
   * back to `pendingConsent` after `running` or after data (§2.6).
   */
  private emitProgress(entry: Inflight, event: Record<string, unknown>): void {
    const state = event.state;
    if (Object.keys(event).length !== 2 || (state !== "pendingConsent" && state !== "running")) {
      this.terminate(entry, "internal", "driver emitted an invalid progress event");
      return;
    }
    if (state === "pendingConsent" && (entry.progress === "running" || entry.dataSeen)) return;
    entry.progress = state;
    this.transport.sendMessage({ type: "deviceEvent", id: entry.request.id, event: { kind: "progress", state } });
  }

  /** Put one JSON-stream event on the wire; snapshots of the live core stream update the live selection. */
  private sendEvent(entry: Inflight, event: Record<string, unknown>): void {
    entry.dataSeen = true;
    this.transport.sendMessage({ type: "deviceEvent", id: entry.request.id, event });
    if (entry.request.id === this.coreId && Array.isArray(event.capabilities)) {
      this.applySnapshot(event.capabilities as Array<{ name: string; versions: number[] }>);
    }
  }

  /** A snapshot the live core stream sent replaces the live selection (§2.2). */
  private applySnapshot(offers: Array<{ name: string; versions: number[] }>): void {
    if (!(this.selection instanceof Map)) return;
    const live = new Map<string, number>();
    for (const [name, version] of this.selection) {
      if (offers.some((o) => o.name === name && o.versions.includes(version))) live.set(name, version);
    }
    this.live = live;
  }

  private flushEvents(entry: Inflight): void {
    while (entry.credit > 0 && entry.events.length > 0 && !entry.stopped && !this.detached) {
      const event = entry.events.shift()!;
      entry.credit -= 1;
      this.sendEvent(entry, event);
    }
    if (entry.paused && entry.events.length === 0 && !entry.stopped && !this.detached) {
      entry.paused = false;
      this.transport.sendMessage({ type: "deviceEvent", id: entry.request.id, control: { paused: false } });
    }
  }

  // ---- execution ----

  private async runRequest(request: DeviceRequest, rev: DeviceRevisionBounds): Promise<void> {
    const driver = this.drivers.get(request.capability)!;
    let resolveCancel!: () => void;
    const cancelled = new Promise<void>((r) => {
      resolveCancel = r;
    });
    const now = this.clock.now();
    const entry: Inflight = {
      request,
      rev,
      resolveCancel,
      stopped: false,
      credit: request.initialCredit,
      paused: false,
      wake: null,
      sink: null,
      leaseSeq: 0,
      leaseExpiresAt: now + this.leaseExpiryMs,
      leaseTimer: null,
      deadlineTimer: null,
      events: [],
      overflow: this.overflowPolicy(request.capability, rev),
      progress: null,
      dataSeen: false,
      releases: [],
    };

    if (rev.data === "binaryDownload") {
      // The request is the announcement: validate limits before any host
      // interaction is shown (RFC 001 §2.4).
      const parsed = parseDownloadDeclaration(request, rev);
      if (!parsed.ok) {
        this.sendError(request.id, "invalidParams", parsed.detail);
        return;
      }
      entry.credit = 0;
      entry.sink = new DownloadSinkImpl(
        parsed.declared,
        Math.min(this.downloadWindow, rev.maxOutstandingCredit),
        (grant) => {
          if (entry.stopped || this.detached) return;
          this.transport.sendMessage({ type: "deviceEvent", id: request.id, control: { grant } });
        },
        (detail) => this.terminate(entry, "invalidParams", detail)
      );
    }
    this.inflight.set(request.id, entry);

    // Lease from receipt (including pending consent), and the local overall
    // deadline min(timeoutMs, localMaximum) — for every driver (§2.1/§2.7).
    this.armLease(entry);
    const localMax = request.lifetime === "connection" ? rev.maxTimeoutMs : Math.min(rev.maxTimeoutMs, this.maxTimeoutMs);
    entry.deadlineTimer = this.clock.setTimeout(() => {
      entry.deadlineTimer = null;
      this.terminate(entry, "timeout", "local deadline");
    }, Math.min(request.timeoutMs, localMax));

    let outcome: DriverOutcome;
    try {
      outcome = await driver({
        request,
        cancelled,
        revision: rev,
        emit: (event) => this.emit(entry, event),
        fail: (code, platformDetail) => {
          if (!this.live_(entry)) return;
          this.terminate(entry, ERROR_CODES.has(code) ? code : "internal", platformDetail);
        },
        ...(entry.sink ? { download: entry.sink } : {}),
      });
    } catch (err) {
      outcome = {
        kind: "error",
        code: "internal",
        platformDetail: err instanceof Error ? err.message : String(err),
      };
    }

    // Cancelled/terminated/detached first: a late outcome (e.g. an OS dialog
    // that could not be dismissed) is discarded and never uploads (§2.1).
    if (!this.live_(entry)) {
      if (outcome.kind === "result") releaseBlobs(outcome.blobs);
      return;
    }
    if (outcome.kind === "error") {
      const code = ERROR_CODES.has(outcome.code) ? outcome.code : "internal";
      const response = errorResponse(request.id, code, outcome.platformDetail);
      this.settle(entry, outcome.simulated === true ? { ...response, simulated: true } : response);
      return;
    }
    await this.reply(entry, outcome);
  }

  private sendError(id: number, code: DeviceErrorCode, platformDetail?: string): void {
    if (this.detached) return;
    this.transport.sendMessage(errorResponse(id, code, platformDetail));
  }

  private live_(entry: Inflight): boolean {
    return !entry.stopped && !this.detached;
  }

  /** Wait for transport write capacity (RFC 001 §2.3). */
  private async drain(entry: Inflight): Promise<void> {
    while (this.live_(entry)) {
      let pending = 0;
      try {
        pending = this.transport.bufferedAmount?.() ?? 0;
      } catch {
        pending = 0;
      }
      if (pending < this.pendingLimit) return;
      await sleep(this.drainPollMs);
    }
  }

  /** Wait until the upload credit balance is positive (or the request stops). */
  private async awaitCredit(entry: Inflight): Promise<void> {
    if (entry.credit > 0 || !this.live_(entry)) return;
    if (!entry.paused) {
      entry.paused = true;
      this.transport.sendMessage({
        type: "deviceEvent",
        id: entry.request.id,
        control: { paused: true },
      });
    }
    while (entry.credit <= 0 && this.live_(entry)) {
      await new Promise<void>((r) => {
        entry.wake = r;
      });
    }
    if (entry.paused && this.live_(entry)) {
      entry.paused = false;
      this.transport.sendMessage({
        type: "deviceEvent",
        id: entry.request.id,
        control: { paused: false },
      });
    }
  }

  /** Reject a driver's blob set that the revision cannot carry. */
  private checkBlobs(entry: Inflight, blobs: DriverBlob[]): { code: DeviceErrorCode; detail: string } | null {
    if (blobs.length === 0) return null;
    const rev = entry.rev;
    if (rev.data !== "binaryUpload") {
      return { code: "internal", detail: "driver produced blobs on a capability without an upload plane" };
    }
    if (blobs.length > rev.maxItems) {
      return { code: "internal", detail: `driver produced ${blobs.length} items, max ${rev.maxItems}` };
    }
    const channels = new Set<number>();
    for (const blob of blobs) {
      if (!Number.isInteger(blob.channel) || blob.channel < 0 || blob.channel >= rev.maxItems || channels.has(blob.channel)) {
        return { code: "internal", detail: `invalid or duplicate blob channel ${blob.channel}` };
      }
      channels.add(blob.channel);
      const hasBytes = blob.bytes instanceof Uint8Array;
      const hasStream = blob.stream !== undefined && blob.stream !== null;
      if (hasBytes === hasStream) {
        return { code: "internal", detail: `blob ${blob.channel} needs exactly one of bytes/stream` };
      }
      if (hasStream && typeof (blob.stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
        return { code: "internal", detail: `blob ${blob.channel} stream is not async-iterable` };
      }
      const declared = hasBytes ? blob.bytes!.byteLength : blob.declaredBytes;
      if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
        return { code: "internal", detail: `blob ${blob.channel} declares an invalid size` };
      }
      if (declared !== undefined && declared > rev.maxItemBytes) {
        return { code: "throttled", detail: "item exceeds size limit" };
      }
    }
    return null;
  }

  private async reply(entry: Inflight, outcome: Extract<DriverOutcome, { kind: "result" }>): Promise<void> {
    const id = entry.request.id;
    const blobs = outcome.blobs ?? [];
    const refused = this.checkBlobs(entry, blobs);
    if (refused) {
      releaseBlobs(blobs);
      this.terminate(entry, refused.code, refused.detail);
      return;
    }

    // Upload blobs: announce each with blobStart, then credit-paced frames,
    // then the terminal result carrying what was actually sent.
    const items: UploadedItem[] = [];
    for (let i = 0; i < blobs.length; i++) {
      const item = await this.upload(entry, blobs[i]!);
      if (!item) {
        releaseBlobs(blobs.slice(i + 1));
        return;
      }
      items.push(item);
    }
    if (!this.live_(entry)) return;

    let result = outcome.result;
    if (outcome.complete) {
      let extra: Record<string, unknown>;
      try {
        extra = await outcome.complete();
      } catch (err) {
        this.terminate(entry, "internal", err instanceof Error ? err.message : String(err));
        return;
      }
      if (!this.live_(entry)) return;
      result = { ...result, ...extra };
    }
    if (blobs.length > 0) {
      const field = resultItemField(entry.request.capability, entry.request.version);
      result = field === "item" ? { ...result, item: items[0] } : { ...result, items };
    }
    this.settle(entry, { type: "deviceResponse", id, result, ...(outcome.simulated === true ? { simulated: true as const } : {}) });
  }

  /**
   * Announce and stream one item. Returns the item's terminal description,
   * or null once the request stopped (terminated here or elsewhere).
   */
  private async upload(entry: Inflight, blob: DriverBlob): Promise<UploadedItem | null> {
    const id = entry.request.id;
    const rev = entry.rev;
    const whole = blob.bytes;
    const declared = whole ? whole.byteLength : blob.declaredBytes;
    // An in-memory item is fully "produced" up front; a stream is pulled.
    const iterator: AsyncIterator<Uint8Array> | null = whole ? null : blob.stream![Symbol.asyncIterator]();
    let released = whole !== undefined;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const r = iterator?.return?.();
        if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined);
      } catch {
        /* source already finished */
      }
    };
    if (iterator) entry.releases.push(release);
    const finished = () => {
      released = true; // exhausted: nothing to release
      const at = entry.releases.indexOf(release);
      if (at >= 0) entry.releases.splice(at, 1);
    };

    if (!this.live_(entry)) return null;
    entry.dataSeen = true;
    this.transport.sendMessage({
      type: "deviceEvent",
      id,
      event: {
        kind: "blobStart",
        channel: blob.channel,
        contentType: blob.contentType,
        // Present = exact declaration; absent = unknown length (D5).
        ...(declared !== undefined ? { bytes: declared } : {}),
      },
    });

    const hasher = whole ? null : new Sha256();
    const queue: Uint8Array[] = [];
    let queued = 0;
    let produced = 0;
    let sent = 0;
    let seq = 0;
    let done = iterator === null;
    if (whole && whole.byteLength > 0) {
      queue.push(whole);
      queued = produced = whole.byteLength;
    }

    // A `next()` the source has not answered yet, kept across frames: a live
    // source (a recorder) yields only as it captures.
    let pendingNext: Promise<IteratorResult<Uint8Array>> | null = null;
    while (!done || queued > 0) {
      // Pull until a frame's worth is buffered (≥ the per-frame charge the
      // receiver bills, §2.3) or the source ends — but never hold captured
      // bytes back waiting for more: when something is buffered and the
      // source has nothing ready within a turn, send what is there (§2.4
      // "frames as captured"); the pending pull carries over.
      while (!done && queued < MIN_FRAME_CHARGE_BYTES) {
        let next: IteratorResult<Uint8Array>;
        try {
          if (!pendingNext) {
            pendingNext = iterator!.next();
            // Settled later (or never awaited once the request stops).
            pendingNext.catch(() => undefined);
          }
          if (queued > 0) {
            const raced: IteratorResult<Uint8Array> | typeof NOT_READY = await Promise.race([
              pendingNext,
              this.yieldTurn().then((): typeof NOT_READY => NOT_READY),
            ]);
            if (raced === NOT_READY) break;
            next = raced;
          } else {
            next = await pendingNext;
          }
          pendingNext = null;
        } catch (err) {
          finished();
          const code = (err as { code?: unknown } | null)?.code;
          this.terminate(
            entry,
            typeof code === "string" && ERROR_CODES.has(code) ? (code as DeviceErrorCode) : "internal",
            err instanceof Error ? err.message : String(err)
          );
          return null;
        }
        if (!this.live_(entry)) {
          release();
          return null;
        }
        if (next.done) {
          done = true;
          finished();
          break;
        }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) {
          release();
          this.terminate(entry, "internal", "upload source yielded a non-Uint8Array chunk");
          return null;
        }
        if (chunk.byteLength === 0) continue;
        if (produced + chunk.byteLength > rev.maxItemBytes) {
          release();
          this.terminate(entry, "throttled", "item exceeds size limit");
          return null;
        }
        if (declared !== undefined && produced + chunk.byteLength > declared) {
          release();
          this.terminate(entry, "internal", `upload source produced more than its declared ${declared} bytes`);
          return null;
        }
        produced += chunk.byteLength;
        hasher?.update(chunk);
        queue.push(chunk);
        queued += chunk.byteLength;
      }
      if (queued === 0) break; // ended with nothing buffered (a zero-byte item sends no frame, D2)

      await this.drain(entry);
      if (!this.live_(entry)) return null;
      await this.awaitCredit(entry);
      if (!this.live_(entry)) return null;
      if (seq > U32_MAX) {
        this.terminate(entry, "internal", "upload seq exhausted");
        return null;
      }
      // Chunked at ≤ 64 KiB and never beyond the credit balance.
      const n = Math.min(MAX_BULK_CHUNK_BYTES, queued, entry.credit);
      const payload = take(queue, n);
      queued -= n;
      this.transport.sendBinary(
        encodeFrame({ version: 1, flags: 0, channel: blob.channel, requestId: id, seq }, payload)
      );
      entry.credit -= n;
      sent += n;
      seq += 1;
      if (!done || queued > 0) await this.yieldTurn();
      if (!this.live_(entry)) return null;
    }

    if (declared !== undefined && sent !== declared) {
      this.terminate(entry, "internal", `upload source produced ${sent} bytes, declared ${declared}`);
      return null;
    }
    const sha256 = whole ? await sha256Hex(whole) : hasher!.hex();
    if (!this.live_(entry)) return null;
    return {
      channel: blob.channel,
      ...(typeof blob.name === "string" ? { name: blob.name } : {}),
      contentType: blob.contentType,
      bytes: sent,
      sha256,
    };
  }
}

/** Sentinel: a live source had nothing ready within a turn. */
const NOT_READY: unique symbol = Symbol("not-ready");

interface UploadedItem {
  channel: number;
  name?: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

/** Remove exactly `n` bytes from the front of `queue` (a view when possible). */
function take(queue: Uint8Array[], n: number): Uint8Array {
  const head = queue[0]!;
  if (head.byteLength >= n) {
    const out = head.subarray(0, n);
    if (head.byteLength === n) queue.shift();
    else queue[0] = head.subarray(n);
    return out;
  }
  const out = new Uint8Array(n);
  let off = 0;
  while (off < n) {
    const c = queue[0]!;
    const k = Math.min(c.byteLength, n - off);
    out.set(c.subarray(0, k), off);
    off += k;
    if (k === c.byteLength) queue.shift();
    else queue[0] = c.subarray(k);
  }
  return out;
}

/** Release the stream sources of blobs that will never be uploaded. */
function releaseBlobs(blobs: DriverBlob[] | undefined): void {
  for (const blob of blobs ?? []) {
    const stream = blob.stream as (AsyncIterable<Uint8Array> & { return?: () => unknown }) | undefined;
    if (!stream) continue;
    try {
      // An async generator / iterator object: `return()` releases it. A
      // bare iterable (e.g. a ReadableStream) is cancelled via its iterator.
      if (typeof stream.return === "function") {
        const r = stream.return();
        if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined);
      } else if (typeof (stream as { cancel?: () => unknown }).cancel === "function") {
        const r = (stream as unknown as { cancel: () => unknown }).cancel();
        if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* already released */
    }
  }
}

function errorResponse(id: number, code: DeviceErrorCode, platformDetail?: string): DeviceResponse {
  return {
    type: "deviceResponse",
    id,
    error: {
      code,
      // Present-but-empty is preserved: `""` round-trips as present (§2.1).
      ...(platformDetail !== undefined ? { platformDetail: platformDetail.slice(0, MAX_PLATFORM_DETAIL) } : {}),
    },
  };
}

// ---- incremental SHA-256 (FIPS 180-4) ----
//
// Web Crypto has no streaming digest; an item whose bytes stream through
// the runtime (D5) is hashed as it is produced, so no copy of the whole item
// is kept just to hash it.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Streaming SHA-256: `update()` any number of times, then `hex()` once (a
 * finalized hasher throws instead of hashing on from its padded state).
 */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private length = 0;
  private finalized = false;

  /** Bytes fed so far. */
  get byteLength(): number {
    return this.length;
  }

  update(data: Uint8Array): this {
    if (this.finalized) throw new Error("Sha256: update() after hex()");
    return this.absorb(data);
  }

  private absorb(data: Uint8Array): this {
    let i = 0;
    const n = data.byteLength;
    this.length += n;
    if (this.bufLen > 0) {
      const k = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, k), this.bufLen);
      this.bufLen += k;
      i = k;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.block(data, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }

  hex(): string {
    if (this.finalized) throw new Error("Sha256: hex() called twice");
    this.finalized = true;
    const bits = this.length * 8;
    const pad = new Uint8Array((this.bufLen < 56 ? 56 : 120) - this.bufLen + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x1_0000_0000);
    const lo = bits >>> 0;
    const at = pad.length - 8;
    pad[at] = hi >>> 24;
    pad[at + 1] = (hi >>> 16) & 0xff;
    pad[at + 2] = (hi >>> 8) & 0xff;
    pad[at + 3] = hi & 0xff;
    pad[at + 4] = lo >>> 24;
    pad[at + 5] = (lo >>> 16) & 0xff;
    pad[at + 6] = (lo >>> 8) & 0xff;
    pad[at + 7] = lo & 0xff;
    const length = this.length;
    this.absorb(pad);
    this.length = length;
    let out = "";
    for (let i = 0; i < 8; i++) out += this.h[i]!.toString(16).padStart(8, "0");
    return out;
  }

  private block(d: Uint8Array, off: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((d[j]! << 24) | (d[j + 1]! << 16) | (d[j + 2]! << 8) | d[j + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    const h = this.h;
    let a = h[0]!, b = h[1]!, c = h[2]!, e0 = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[t]! + w[t]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (e0 + t1) >>> 0;
      e0 = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + e0) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
}
