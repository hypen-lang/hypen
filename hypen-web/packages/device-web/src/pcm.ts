/**
 * Live-capture building blocks for the browser DeviceHost (RFC 001 §2.4
 * "live capture drivers"): a streaming resampler + PCM16 encoder for
 * `mic.record`, and the bounded live queue every capture driver (mic, camera
 * video) hands the runtime as its undeclared-size item source.
 *
 * Pure TypeScript with no DOM dependency, so they are unit-tested directly.
 */

import type { DeviceErrorCode } from "@hypen-space/core/remote/device";

/** Convert one float sample (nominally −1..1) to a signed 16-bit integer. */
export function floatToPcm16(sample: number): number {
  if (!(sample === sample)) return 0; // NaN → silence
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/**
 * Streaming linear-interpolation resampler + interleaved little-endian PCM16
 * encoder. Feed planar float blocks at the capture rate (any block length);
 * get PCM16 bytes at the requested rate, `channels` interleaved.
 *
 * - Input channel count may differ from `channels`: a mono input is
 *   duplicated into every output channel; extra input channels are dropped
 *   past the requested count (the capture graph normally delivers exactly
 *   `channels`, up/down-mixed by the audio engine).
 * - State carries across blocks, so splitting the input differently never
 *   changes the output.
 * - `maxFrames` caps the total output (a `maxDurationMs` recording limit):
 *   once reached, further input produces nothing and `full` is true.
 */
export class PcmEncoder {
  private readonly step: number;
  /** Position (in input samples, relative to the current block's sample 0) of the next output frame. */
  private t = 0;
  private prev: Float32Array;
  private written = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    readonly channels: 1 | 2,
    readonly maxFrames: number = Number.POSITIVE_INFINITY
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError("sample rates must be positive");
    this.step = inputRate / outputRate;
    this.prev = new Float32Array(channels);
  }

  /** Output frames produced so far. */
  get frames(): number {
    return this.written;
  }

  /** The recording limit was reached. */
  get full(): boolean {
    return this.written >= this.maxFrames;
  }

  /** Duration of what was produced, in whole milliseconds. */
  get durationMs(): number {
    return Math.round((this.written * 1000) / this.outputRate);
  }

  /**
   * Encode one planar block. Returns the PCM16 bytes produced (possibly
   * empty when the block is shorter than one output period).
   */
  push(planar: ReadonlyArray<Float32Array>): Uint8Array {
    const n = planar[0]?.length ?? 0;
    if (n === 0 || this.full) return new Uint8Array(0);
    const src: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) src.push(planar[Math.min(c, planar.length - 1)]!);

    // Output frames whose position t lies in [.., n - 1] (t < 0 interpolates
    // from the previous block's last sample).
    let count = 0;
    if (this.t <= n - 1) count = Math.floor((n - 1 - this.t) / this.step) + 1;
    count = Math.min(count, this.maxFrames - this.written);
    const out = new Uint8Array(count * this.channels * 2);
    const view = new DataView(out.buffer);
    let t = this.t;
    let o = 0;
    for (let k = 0; k < count; k++) {
      const i = Math.floor(t);
      const frac = t - i;
      for (let c = 0; c < this.channels; c++) {
        const x = src[c]!;
        const a = i < 0 ? this.prev[c]! : x[i]!;
        const b = frac === 0 ? a : i + 1 < n ? x[i + 1]! : a;
        view.setInt16(o, floatToPcm16(a + (b - a) * frac), true);
        o += 2;
      }
      t += this.step;
    }
    this.written += count;
    // Carry the position (relative to the next block) and the last sample.
    // When `count` was capped by maxFrames the encoder is full and the
    // position no longer matters.
    this.t = t - n;
    for (let c = 0; c < this.channels; c++) this.prev[c] = src[c]![n - 1]!;
    return out;
  }
}

/** An Error carrying a DeviceErrorCode (the runtime maps it to that code). */
export function codedError(code: DeviceErrorCode, message: string): Error & { code: DeviceErrorCode } {
  return Object.assign(new Error(message), { code });
}

/**
 * The bounded buffer between a live capture and the runtime's upload (RFC
 * 001 §2.3/§2.4 "overflow pause is bounded"): the capture `push`es chunks as
 * they are produced; the runtime pulls them (only as credit allows). When
 * more than `maxBytes` are waiting — the runtime is paused, starved of
 * credit — `push` returns false and the capture must end the request
 * `throttled` (never an unbounded buffer).
 *
 * It is its own async iterator (not a generator), so `return()` from the
 * runtime (request stopped) takes effect immediately even while a `next()`
 * is pending, and runs `onRelease` exactly once.
 */
export class LiveQueue implements AsyncIterableIterator<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private failure: Error | null = null;
  private released = false;
  private waiter: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  private waiterReject: ((e: unknown) => void) | null = null;
  private onRelease: (() => void) | null;
  private doneCallbacks: Array<() => void> = [];
  private isDone = false;

  constructor(
    readonly maxBytes: number,
    onRelease?: () => void
  ) {
    this.onRelease = onRelease ?? null;
  }

  /**
   * Run `cb` once the capture is over: ended normally, failed, or released
   * by the consumer (immediately if it already is).
   */
  onDone(cb: () => void): void {
    if (this.isDone) cb();
    else this.doneCallbacks.push(cb);
  }

  private settleDone(): void {
    if (this.isDone) return;
    this.isDone = true;
    for (const cb of this.doneCallbacks.splice(0)) {
      try {
        cb();
      } catch {
        /* a teardown step failing must not stop the others */
      }
    }
  }

  /** Bytes captured but not yet pulled by the runtime. */
  get bufferedBytes(): number {
    return this.buffered;
  }

  /** The consumer stopped (runtime release / request ended). */
  get closed(): boolean {
    return this.released;
  }

  /**
   * Add captured bytes: `"ok"`, `"full"` when the bounded window would
   * overflow (nothing kept — the capture must end `throttled`), or
   * `"closed"` once the queue ended, failed or was released.
   */
  push(chunk: Uint8Array): "ok" | "full" | "closed" {
    if (this.released || this.ended || this.failure) return "closed";
    if (chunk.byteLength === 0) return "ok";
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.waiterReject = null;
      w({ value: chunk, done: false });
      return "ok";
    }
    if (this.buffered + chunk.byteLength > this.maxBytes) return "full";
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    return "ok";
  }

  /** The capture finished normally (Stop, limit reached): drain, then done. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter && this.chunks.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      this.waiterReject = null;
      w({ value: undefined, done: true });
    }
    this.settleDone();
  }

  /** The capture failed: the next pull throws `err`. */
  fail(err: Error): void {
    if (this.failure || this.released) return;
    this.failure = err;
    this.chunks.length = 0;
    this.buffered = 0;
    if (this.waiterReject) {
      const r = this.waiterReject;
      this.waiter = null;
      this.waiterReject = null;
      r(err);
    }
    this.settleDone();
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    if (this.failure) return Promise.reject(this.failure);
    const head = this.chunks.shift();
    if (head) {
      this.buffered -= head.byteLength;
      return Promise.resolve({ value: head, done: false });
    }
    if (this.ended || this.released) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.waiterReject = reject;
    });
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    this.release();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Stop consuming: drop buffered bytes, settle a pending pull, run onRelease. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.chunks.length = 0;
    this.buffered = 0;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.waiterReject = null;
      w({ value: undefined, done: true });
    }
    const cb = this.onRelease;
    this.onRelease = null;
    cb?.();
    this.settleDone();
  }
}
