/**
 * Device Capability Protocol — the host driver of one connection's broker
 * (RFC 001 §2.1–§2.7).
 *
 * The broker is the Rust `DeviceBroker`, reached through the WASM-free
 * {@link DeviceBrokerPort} (./port.ts). It is sans-IO; `DevicePlane` is the
 * I/O half every TypeScript host shares (Bun/Node `RemoteServer`, the
 * Cloudflare Durable Object, custom transports):
 *
 * - socket text / binary frames → `port.onText` / `port.onFrame`;
 * - `port.poll()` outputs → the socket (`sendText`, `sendFrame`), the
 *   handler API (JSON stream events, streamed upload bytes, settlements) or
 *   a connection close;
 * - ONE timer, re-armed from the broker's next deadline and run through
 *   `port.tick(now)` — leases, deadlines, drain watches and the planned
 *   `core.capabilities` reopen all live in the broker;
 * - the transport's buffered bytes are reported before every poll, and a
 *   bulk turn that is due "now" runs as its own macrotask, so UI messages
 *   queued meanwhile go out first (RFC 001 §2.3 priority);
 * - consumer pacing: event credit / upload credit is returned to the broker
 *   (`consumedEvents` / `consumedData`) as the consumer finishes — when it
 *   returns, or when its promise settles — so a slow consumer backpressures
 *   the device.
 *
 * Time is injected ({@link DeviceClock}); with a fake clock every lease and
 * deadline is deterministic.
 */

import type { DeviceErrorCode } from "./generated.js";
import type {
  DeviceBrokerBlob,
  DeviceBrokerInfo,
  DeviceBrokerOutcome,
  DeviceBrokerOutput,
  DeviceBrokerPort,
  DeviceBrokerRevision,
  DeviceOpenSpec,
} from "./port.js";

/** Monotonic clock + one-shot timer seam (deterministic in tests). */
export interface DeviceClock {
  /** Monotonic milliseconds (non-negative). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Timer/performance globals reached through globalThis: this package targets
// several runtimes and does not pull in one ambient lib.
const g = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
};

/** The process clock: `performance.now()` (monotonic) where available. */
export const systemDeviceClock: DeviceClock = {
  now: () => (g.performance ? g.performance.now() : Date.now()),
  setTimeout: (fn, ms) => g.setTimeout(fn, ms),
  clearTimeout: (h) => g.clearTimeout(h),
};

/** Where a device plane's traffic goes. */
export interface DevicePlaneSink {
  /** One server → client device JSON message (request, cancel, lease, grant). */
  sendText(text: string): void;
  /** One binary download frame; absent ⇒ the connection carries no downloads. */
  sendFrame?(frame: Uint8Array): void;
  /** Bytes accepted by the transport but not yet written; absent ⇒ 0. */
  bufferedAmount?(): number;
  /**
   * The broker closed the device plane (repeated violations, the mandatory
   * `core.capabilities` stream ended, id space exhausted): reset the socket
   * with this code so the client reconnects with a full advertisement.
   */
  closeConnection(code: number, reason: string): void;
}

export interface DevicePlaneOptions {
  clock?: DeviceClock;
  /**
   * Runs a bulk scheduling turn that is due now, AFTER already-queued work
   * (a macrotask by default) so pending UI messages go out first.
   */
  defer?: (fn: () => void) => void;
  /** Whether this connection negotiated and carries the binary profile. */
  binary?: boolean;
  /** Diagnostics for a failed send (the connection is torn down elsewhere). */
  onError?: (what: string, err: unknown) => void;
}

/** A request's terminal outcome as the handler layer sees it. */
export type DeviceSettlement =
  | {
      result: unknown;
      /** Verified upload items of a buffered upload, in result order. */
      blobs: DeviceBrokerBlob[];
      simulated?: true;
      /** Present when the result's retained-bytes charge is held. */
      release?: () => void;
    }
  | { error: { code: DeviceErrorCode; platformDetail?: string } };

/** The result a caller awaits. Terminal exactly once; never rejects. */
export interface DeviceRequestHandle {
  /** Wire request id, or null when the broker refused locally. */
  readonly id: number | null;
  readonly settled: Promise<DeviceSettlement>;
  /** Server-initiated cancellation (idempotent). */
  cancel(): void;
}

/** Everything `DevicePlane.open` takes: the broker spec plus local consumers. */
export interface DevicePlaneOpen extends DeviceOpenSpec {
  /** `file.save` bytes (the params must announce exactly these). */
  download?: Uint8Array;
  /** Consumer of a JSON stream's validated capability events. */
  onEvent?: (event: Record<string, unknown>) => void | Promise<unknown>;
  /** Consumer of a binary-upload stream's bytes, one call at a time, in order. */
  onData?: (chunk: Uint8Array, channel: number) => void | Promise<unknown>;
}

interface Pending {
  id: number;
  resolve: (s: DeviceSettlement) => void;
  onEvent: DevicePlaneOpen["onEvent"] | null;
  onData: DevicePlaneOpen["onData"] | null;
  dataQueue: Array<{ bytes: Uint8Array; channel: number }>;
  delivering: boolean;
  done: boolean;
}

const macrotask = (fn: () => void) => {
  g.setTimeout(fn, 0);
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";

export class DevicePlane {
  private readonly clock: DeviceClock;
  private readonly defer: (fn: () => void) => void;
  private readonly onError: (what: string, err: unknown) => void;
  private readonly pending = new Map<number, Pending>();
  private readonly binaryRoute: boolean;
  private timer: unknown = null;
  private timerAt: number | null = null;
  private turnQueued = false;
  private pumping = false;
  private again = false;
  private closing = false;
  private freed = false;

  constructor(
    /** The connection's broker (WASM-backed). Owned by this plane. */
    readonly port: DeviceBrokerPort,
    private readonly sink: DevicePlaneSink,
    opts: DevicePlaneOptions = {}
  ) {
    this.clock = opts.clock ?? systemDeviceClock;
    this.defer = opts.defer ?? macrotask;
    this.binaryRoute = opts.binary === true && typeof sink.sendFrame === "function";
    this.onError = opts.onError ?? (() => {});
  }

  private now(): number {
    const t = this.clock.now();
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Open the connection-owned `core.capabilities` stream (RFC 001 §2.2),
   * right after the handshake — before any module callback can request
   * device work. False when it could not be opened (the plane is useless
   * then and the caller closes it).
   */
  start(): boolean {
    if (this.isClosed) return false;
    const r = this.port.start(this.now());
    this.pump();
    return r.error === undefined;
  }

  /**
   * Close the device plane locally (connection teardown / reset): every live
   * request settles with `code` (nothing is sent), the timer stops and the
   * broker's memory is released. Idempotent.
   */
  close(code: DeviceErrorCode = "connectionLost"): void {
    if (this.freed || this.closing) return;
    this.closing = true;
    this.clearTimer();
    try {
      if (!this.port.isClosed) this.port.close(code);
    } catch (err) {
      this.onError("device broker close", err);
    }
    this.pump();
  }

  /** True once the plane closed (locally or by the broker). */
  get isClosed(): boolean {
    return this.freed || this.closing || this.port.isClosed;
  }

  /** Whether downloads (`file.save`) can be carried on this connection. */
  get canSendBinary(): boolean {
    return this.binaryRoute;
  }

  // ---- module ownership (RFC 001 §2.7) ----------------------------------

  /** A module instance became active as `activationId` (strictly increasing). */
  ownerActivated(moduleInstanceId: string, activationId: number): boolean {
    if (this.isClosed) return false;
    const ok = this.port.ownerActivated(moduleInstanceId, activationId, this.now());
    this.pump();
    return ok;
  }

  /** The activation ended: its activation-owned work is cancelled. */
  ownerDeactivated(moduleInstanceId: string, activationId: number): void {
    if (this.isClosed) return;
    this.port.ownerDeactivated(moduleInstanceId, activationId, this.now());
    this.pump();
  }

  /** The module instance was destroyed: all of its work is cancelled. */
  ownerDestroyed(moduleInstanceId: string): void {
    if (this.isClosed) return;
    this.port.ownerDestroyed(moduleInstanceId, this.now());
    this.pump();
  }

  // ---- requests ------------------------------------------------------------

  /**
   * Open a request through the broker. A local refusal (the broker admits
   * nothing it cannot honor) settles at once with `id: null`; nothing is
   * sent then.
   */
  open(spec: DevicePlaneOpen): DeviceRequestHandle {
    if (this.isClosed) return refused({ code: "connectionLost" });
    const { download, onEvent, onData, ...wire } = spec;
    let r: ReturnType<DeviceBrokerPort["open"]>;
    try {
      r = this.port.open(wire, this.now(), download ?? null);
    } catch (err) {
      // A malformed spec is a host bug; the handler API still never throws.
      this.onError("device open", err);
      return refused({ code: "internal", platformDetail: String((err as Error)?.message ?? err).slice(0, 512) });
    }
    if (r.error !== undefined) {
      this.pump();
      return refused({
        code: r.error.code,
        ...(r.error.detail !== undefined ? { platformDetail: r.error.detail } : {}),
      });
    }
    const id = r.id;
    let resolve!: (s: DeviceSettlement) => void;
    const settled = new Promise<DeviceSettlement>((res) => {
      resolve = res;
    });
    this.pending.set(id, {
      id,
      resolve,
      onEvent: onEvent ?? null,
      onData: onData ?? null,
      dataQueue: [],
      delivering: false,
      done: false,
    });
    this.pump();
    return { id, settled, cancel: () => this.cancel(id) };
  }

  /** Server-initiated cancel: `cancel` is sent and the request settles `cancelled`. */
  cancel(id: number): void {
    if (this.isClosed) return;
    this.port.cancel(id, this.now());
    this.pump();
  }

  /**
   * Planned reopen of `core.capabilities` now (the broker also does this on
   * its own shortly before the stream's deadline): the old stream is retired
   * with `cancel`, then a fresh one opens. The new id, or undefined.
   */
  reopenCoreCapabilities(): number | undefined {
    if (this.isClosed) return undefined;
    const id = this.port.reopenCoreCapabilities(this.now());
    this.pump();
    return id;
  }

  /** Release a held result's retained-bytes charge (idempotent). */
  releaseResult(id: number): void {
    if (this.freed) return;
    this.port.releaseResult(id);
  }

  // ---- incoming traffic ------------------------------------------------------

  /** One client → server device text message (the raw text). */
  receiveText(text: string): boolean {
    if (this.isClosed) return false;
    const live = this.port.onText(text, this.now());
    this.pump();
    return live;
  }

  /** One client → server binary frame. */
  receiveFrame(frame: Uint8Array): boolean {
    if (this.isClosed) return false;
    const ok = this.port.onFrame(frame, this.now());
    this.pump();
    return ok;
  }

  /** A connection-level violation the host detected before feeding anything. */
  reportViolation(reason: string): void {
    if (this.isClosed) return;
    this.port.reportViolation(reason, this.now());
    this.pump();
  }

  // ---- queries -----------------------------------------------------------

  /** Negotiated live support (the live selection after every snapshot). */
  supports(capability: string): boolean {
    return !this.isClosed && this.port.supports(capability);
  }

  selectedVersion(capability: string): number | undefined {
    return this.freed ? undefined : this.port.selectedVersion(capability);
  }

  revision(capability: string, version: number): DeviceBrokerRevision | null {
    return this.freed ? null : this.port.revision(capability, version);
  }

  admitsBackground(moduleInstanceId: string): boolean {
    return !this.freed && this.port.admitsBackground(moduleInstanceId);
  }

  hasBackgroundWork(moduleInstanceId: string): boolean {
    return !this.freed && this.port.hasBackgroundWork(moduleInstanceId);
  }

  ownerIsActive(moduleInstanceId: string, activationId: number): boolean {
    return !this.freed && this.port.ownerIsActive(moduleInstanceId, activationId);
  }

  isLive(id: number): boolean {
    return !this.freed && this.port.isLive(id);
  }

  get liveCount(): number {
    return this.freed ? 0 : this.port.liveCount;
  }

  get retainedBytes(): number {
    return this.freed ? 0 : this.port.retainedBytes;
  }

  get coreStreamId(): number | undefined {
    return this.freed ? undefined : this.port.coreStreamId;
  }

  outstandingCredit(id: number): number | undefined {
    return this.freed ? undefined : this.port.outstandingCredit(id);
  }

  outstandingEventCredit(id: number): number | undefined {
    return this.freed ? undefined : this.port.outstandingEventCredit(id);
  }

  /**
   * Streamed uploads whose success terminal arrived while chunks still await
   * the consumer (their ids are retired; they settle once drained).
   */
  get drainingCount(): number {
    return this.info()?.drainingCount ?? 0;
  }

  /** The per-connection retained-bytes budget this broker enforces. */
  get maxRetainedBytes(): number {
    return this.info()?.maxRetainedBytes ?? 0;
  }

  /** Connection-level protocol violations counted so far (decisions D3/D8). */
  get connectionViolations(): number {
    return this.info()?.connectionViolations ?? 0;
  }

  /** The most recent connection-level violation, if any. */
  get lastConnectionViolation(): string | null {
    return this.info()?.lastConnectionViolation ?? null;
  }

  /** A snapshot of the broker's state (null once released). */
  info(): DeviceBrokerInfo | null {
    return this.freed ? null : this.port.info();
  }

  // ---- pump ------------------------------------------------------------------

  /**
   * Drain the broker's outputs. Non-reentrant: a consumer or sink that calls
   * back into the plane while outputs are dispatched only marks another
   * round, so outputs are always handled in broker order.
   */
  private pump(): void {
    if (this.freed) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        let outputs: DeviceBrokerOutput[];
        try {
          this.port.setTransportBuffered(this.buffered());
          outputs = this.port.poll();
        } catch (err) {
          this.onError("device broker poll", err);
          break;
        }
        for (const o of outputs) this.dispatch(o);
      } while (this.again);
    } finally {
      this.pumping = false;
    }
    if (this.closing || this.port.isClosed) {
      this.release();
      return;
    }
    this.schedule();
  }

  private buffered(): number {
    try {
      const n = this.sink.bufferedAmount?.() ?? 0;
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }

  private dispatch(o: DeviceBrokerOutput): void {
    switch (o.type) {
      case "sendText":
        try {
          this.sink.sendText(o.text);
        } catch (err) {
          this.onError("device message send", err);
        }
        return;
      case "sendFrame":
        // A request cancelled while this turn's frames were being written
        // (e.g. by the transport write itself) sends nothing more: its
        // remaining frames are discarded, never written after the cancel.
        if (o.frame.byteLength >= 8 && !this.port.isLive(frameRequestId(o.frame))) return;
        try {
          this.sink.sendFrame?.(o.frame);
        } catch (err) {
          this.onError("device frame send", err);
        }
        return;
      case "event":
        this.deliverEvent(o.id, o.event);
        return;
      case "data": {
        const p = this.pending.get(o.id);
        if (!p || !p.onData || p.done) {
          // No consumer (cannot happen for a plane-opened stream): the bytes
          // are consumed so the broker's budget and credit move on.
          this.port.consumedData(o.id, 1, this.now());
          this.again = true;
          return;
        }
        p.dataQueue.push({ bytes: o.bytes, channel: o.channel });
        this.deliverData(p);
        return;
      }
      case "settled":
        this.settle(o.id, o.outcome);
        return;
      case "closeConnection":
        this.closing = true;
        this.clearTimer();
        try {
          this.sink.closeConnection(o.code, o.reason);
        } catch (err) {
          this.onError("device plane close", err);
        }
        return;
    }
  }

  private deliverEvent(id: number, event: Record<string, unknown>): void {
    const consumer = this.pending.get(id)?.onEvent;
    let result: unknown;
    if (consumer) {
      try {
        result = consumer(event);
      } catch {
        result = undefined; // a throwing consumer still consumed the event
      }
    }
    const consumed = () => {
      if (this.isClosed) return;
      this.port.consumedEvents(id, 1, this.now());
      this.pump();
    };
    if (isThenable(result)) result.then(consumed, consumed);
    else consumed();
  }

  /** Deliver queued chunks one consumer call at a time, in order (iterative). */
  private deliverData(p: Pending): void {
    const consumer = p.onData!;
    while (!p.delivering && !p.done && p.dataQueue.length > 0) {
      const next = p.dataQueue.shift()!;
      p.delivering = true;
      let result: unknown;
      try {
        result = consumer(next.bytes, next.channel);
      } catch {
        result = undefined; // a throwing consumer still consumed the chunk
      }
      if (isThenable(result)) {
        const done = () => {
          p.delivering = false;
          this.dataConsumed(p);
          this.deliverData(p);
        };
        result.then(done, done);
        return;
      }
      p.delivering = false;
      this.dataConsumed(p);
    }
  }

  private dataConsumed(p: Pending): void {
    if (this.isClosed) return;
    this.port.consumedData(p.id, 1, this.now());
    this.pump();
  }

  private settle(id: number, outcome: DeviceBrokerOutcome): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.done = true;
    p.dataQueue.length = 0; // undelivered chunks of a failed stream are dropped
    if (!outcome.ok) {
      p.resolve({
        error: {
          code: outcome.code,
          ...(outcome.detail !== undefined ? { platformDetail: outcome.detail } : {}),
        },
      });
      return;
    }
    p.resolve({
      result: outcome.result,
      blobs: outcome.blobs ?? [],
      ...(outcome.simulated ? { simulated: true as const } : {}),
      ...(outcome.held ? { release: () => this.releaseResult(id) } : {}),
    });
  }

  // ---- timer -----------------------------------------------------------------

  private schedule(): void {
    if (this.freed || this.closing) return;
    const next = this.port.nextDeadline();
    if (next === undefined) {
      this.clearTimer();
      return;
    }
    const now = this.now();
    if (next <= now) {
      // Due now (a bulk turn): after already-queued work, never inline.
      this.clearTimer();
      if (this.turnQueued) return;
      this.turnQueued = true;
      this.defer(() => {
        this.turnQueued = false;
        this.fire();
      });
      return;
    }
    if (this.timer !== null && this.timerAt === next) return;
    this.clearTimer();
    this.timerAt = next;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.fire();
    }, Math.max(1, Math.ceil(next - now)));
  }

  private fire(): void {
    if (this.freed || this.closing) return;
    try {
      this.port.tick(this.now());
    } catch (err) {
      this.onError("device broker tick", err);
    }
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  /** Release the broker (closed): anything still pending ends connectionLost. */
  private release(): void {
    if (this.freed) return;
    this.freed = true;
    this.closing = true;
    this.clearTimer();
    for (const p of this.pending.values()) {
      p.done = true;
      p.resolve({ error: { code: "connectionLost" } });
    }
    this.pending.clear();
    try {
      this.port.free();
    } catch (err) {
      this.onError("device broker free", err);
    }
  }
}

/** The request id of a device frame header (u32 LE at offset 4). */
function frameRequestId(frame: Uint8Array): number {
  return (frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24)) >>> 0;
}

function refused(error: { code: DeviceErrorCode; platformDetail?: string }): DeviceRequestHandle {
  return { id: null, settled: Promise.resolve({ error }), cancel: () => {} };
}
