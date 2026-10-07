/**
 * Device Capability Protocol — every shared transcript replayed against the
 * TS CLIENT runtime (`DeviceClient` with `requireHandshake`, the mode every
 * `DeviceEndpoint` host runs), acting as the client endpoint. The server
 * half is replayed through `DeviceBroker` in device-srv-conformance.test.ts;
 * the iOS/Android client runners (`DeviceTranscriptTests.swift`,
 * `DeviceTranscriptTest.kt`) apply the same rules.
 *
 * Every server → client step is delivered through the runtime's socket edge
 * (`handleText` with the exact JSON text, `handleFrame` with the exact
 * bytes). Every client → server step is either produced by the runtime
 * itself (lease acks, `paused` transitions, blob announcements, frames and
 * hashed items, download credit, reactions, `cancelled` terminals) or asked
 * of a scripted driver (events, progress, snapshots, terminal results) and
 * then compared with what the runtime actually sent:
 *
 * - `expectViolation` on a server step: the client detects it —
 *   `connection` closes the device connection; an attributable violation
 *   terminates the id with the reaction's exact code; connection-level
 *   `malformed` text or frame headers change nothing and send nothing (D3);
 * - `ignored` server steps produce no output at all;
 * - a server `cancel` on a live id makes the client send `cancelled`;
 * - uploads are compared by meaning, not chunking: the announced items
 *   (a declared size exactly when the transcript declares one — D5), the
 *   per-channel bytes (contiguous `seq`, ≤ 64 KiB, no empty frame — D2),
 *   `paused` transitions (nothing sent while paused), cumulative bytes never
 *   beyond the credit granted so far, and the terminal items;
 * - download credit is compared by meaning too: the client grants only
 *   after its driver asked to receive, before any byte, and every server
 *   frame fits what it granted (the amounts are the client's policy);
 * - client → server steps that are themselves violations (or `ignored` late
 *   messages) describe a misbehaving or racing client and are not
 *   produced; after an attributable one the id's remaining client output is
 *   not compared.
 *
 * Handshake-selection transcripts (and every `conformance/selection.json`
 * case) are checked from the client's side: `RemoteEngine` accepts the
 * server's selection for that hello unchanged, or disables the device plane
 * when the server selects nothing. No transcript is skipped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { RemoteEngine } from "../packages/core/src/remote/client.ts";
import {
  DeviceClient,
  type DeviceClientClock,
  type DeviceDriver,
  type DriverBlob,
  type DriverContext,
  type DriverOutcome,
} from "../packages/core/src/remote/device/runtime.ts";
import { decodeFrame } from "../packages/core/src/remote/device/frames.ts";
import { DEVICE_REGISTRY, findRevision } from "../packages/core/src/remote/device/registry.ts";
import type { DeviceAck, DeviceEndpoint, DeviceHello } from "../packages/core/src/remote/device/index.ts";

const ROOT = join(import.meta.dir, "../../engine-compatibility-tests/fixtures/device");
const TRANSCRIPTS = join(ROOT, "transcripts");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function frameBytes(frame: Json): Uint8Array {
  const head = hexToBytes(frame.hex);
  const fill = frame.payloadFill as { byte: number; length: number } | undefined;
  if (!fill) return head;
  const out = new Uint8Array(head.byteLength + fill.length);
  out.set(head);
  out.fill(fill.byte, head.byteLength);
  return out;
}

/** A clock that never advances: timing is not observable in transcripts. */
const frozenClock: DeviceClientClock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

type Out = { kind: "message"; m: Json } | { kind: "frame"; bytes: Uint8Array };

class Failure extends Error {}

const stats = {
  transcripts: 0,
  handshake: 0,
  clientDetected: 0,
  reactions: 0,
  produced: 0,
  uploadsVerified: 0,
  downloadsVerified: 0,
  serverSideSteps: 0,
};

interface Op {
  ctx: DriverContext;
  resolve(outcome: DriverOutcome): void;
  receiving: Promise<Uint8Array> | null;
}

class Replay {
  readonly name: string;
  readonly steps: Json[];
  readonly doc: Json;
  readonly sent: Out[] = [];
  readonly consumed = new Set<number>();
  readonly abandoned = new Set<number>();
  readonly ops = new Map<number, Op>();
  readonly requests = new Map<number, Json>();
  readonly credit = new Map<number, number>();
  readonly renewals = new Set<string>();
  readonly ackedSeqs = new Map<number, Set<number>>();
  readonly uploadTriggered = new Set<number>();
  readonly granted = new Map<number, number>();
  readonly downloaded = new Map<number, number>();
  /** Live (undeclared) upload sources per request id and channel. */
  readonly live = new Map<number, Map<number, LiveSource>>();
  /** Frame steps seen per `${id}:${channel}` (live sources release by them). */
  readonly frameSteps = new Map<string, number>();
  closed: { code: number; reason: string } | null = null;
  client!: DeviceClient;

  constructor(doc: Json) {
    this.doc = doc;
    this.name = doc.name;
    this.steps = doc.steps;
  }

  fail(what: string): never {
    throw new Failure(`${this.name}: ${what}`);
  }

  // ---- step helpers ----

  flag(s: Json, k: string): boolean {
    return s?.[k] === true;
  }

  idOf(s: Json): number | null {
    if (s.message && typeof s.message.id === "number") return s.message.id;
    if (s.frame) return s.frame.header.requestId;
    if (typeof s.raw === "string") {
      const m = /"id":(\d+)/.exec(s.raw);
      return m ? Number(m[1]) : null;
    }
    return null;
  }

  outId(o: Out): number | null {
    if (o.kind === "message") return typeof o.m.id === "number" ? o.m.id : null;
    const d = decodeFrame(o.bytes);
    return d.ok ? d.header.requestId : null;
  }

  isLeaseAck(o: Out): boolean {
    return o.kind === "message" && o.m.control?.leaseAck !== undefined;
  }

  isGrant(o: Out): boolean {
    return o.kind === "message" && o.m.control?.grant !== undefined;
  }

  describe(o: Out): string {
    if (o.kind === "message") return JSON.stringify(o.m);
    const d = decodeFrame(o.bytes);
    return d.ok ? `frame(${JSON.stringify(d.header)}, ${d.payload.byteLength} B)` : "frame(bad)";
  }

  pending(): number[] {
    const out: number[] = [];
    this.sent.forEach((o, i) => {
      if (this.consumed.has(i)) return;
      const id = this.outId(o);
      if (id !== null && this.abandoned.has(id)) return;
      out.push(i);
    });
    return out;
  }

  hasPending(id: number): boolean {
    return this.pending().some((i) => this.outId(this.sent[i]!) === id && !this.isLeaseAck(this.sent[i]!));
  }

  isConnectionLevel(s: Json, next: Json | undefined): boolean {
    return s.expectViolation === "malformed" && !this.flag(next, "reaction") && (s.raw !== undefined || s.frame !== undefined);
  }

  /** Ids for which the transcript shows the client misbehaving. */
  private misbehaving: Set<number> | null = null;
  get clientMisbehaves(): Set<number> {
    if (this.misbehaving) return this.misbehaving;
    const ids = new Set<number>();
    this.steps.forEach((s, i) => {
      if (s.dir !== "c2s" || !s.expectViolation) return;
      if (this.isConnectionLevel(s, this.steps[i + 1])) return;
      const id = this.idOf(s);
      if (id !== null) ids.add(id);
    });
    return (this.misbehaving = ids);
  }

  isLive(id: number): boolean {
    return !this.sent.some((o) => o.kind === "message" && o.m.type === "deviceResponse" && o.m.id === id);
  }

  // ---- output bookkeeping ----

  /** Let the runtime run to quiescence; record acks/grants; check credit. */
  async settle(): Promise<void> {
    let before = -1;
    for (let round = 0; round < 50 && before !== this.sent.length; round++) {
      before = this.sent.length;
      for (let i = 0; i < 4; i++) await macrotask();
    }
    for (const o of this.sent) {
      const id = this.outId(o);
      if (id === null || o.kind !== "message") continue;
      if (this.isLeaseAck(o)) {
        let seqs = this.ackedSeqs.get(id);
        if (!seqs) this.ackedSeqs.set(id, (seqs = new Set()));
        seqs.add(o.m.control.leaseAck);
      }
    }
    this.checkCredit();
  }

  /** Cumulative upload bytes never exceed the credit granted so far (§2.3). */
  checkCredit(): void {
    const bytes = new Map<number, number>();
    for (const o of this.sent) {
      if (o.kind !== "frame") continue;
      const d = decodeFrame(o.bytes);
      if (!d.ok) this.fail("the client sent a frame with a bad header");
      bytes.set(d.header.requestId, (bytes.get(d.header.requestId) ?? 0) + d.payload.byteLength);
    }
    for (const [id, n] of bytes) {
      const allowed = this.credit.get(id);
      if (allowed === undefined) this.fail(`frame for unknown request ${id}`);
      if (n > allowed) this.fail(`request ${id} sent ${n} bytes with only ${allowed} credit`);
    }
  }

  // ---- setup ----

  setUp(): void {
    const drivers = new Map<string, DeviceDriver>();
    for (const name of DEVICE_REGISTRY.keys()) {
      drivers.set(name, (ctx) => {
        return new Promise<DriverOutcome>((resolve) => {
          this.ops.set(ctx.request.id, { ctx, resolve, receiving: null });
        });
      });
    }
    const transport = {
      sendMessage: (m: unknown) => this.sent.push({ kind: "message", m: JSON.parse(JSON.stringify(m)) }),
      sendBinary: (f: Uint8Array) => this.sent.push({ kind: "frame", bytes: f.slice() }),
      close: (code: number, reason: string) => {
        this.closed = { code, reason };
      },
    };
    const options = { requireHandshake: true, clock: frozenClock, yieldTurn: () => Promise.resolve() };
    this.client = new DeviceClient(transport, drivers, options);
    const ack: DeviceAck = this.doc.ack ?? {
      protocolVersion: 1,
      binary: true,
      capabilities: [...DEVICE_REGISTRY].flatMap(([name, revs]) => revs.map((r) => ({ name, version: r.version }))),
    };
    this.client.setSelection(ack);
  }

  // ---- run ----

  async run(): Promise<void> {
    this.setUp();
    let i = 0;
    while (i < this.steps.length) {
      const s = this.steps[i];
      const next = this.steps[i + 1];
      i += s.dir === "s2c" ? await this.serverStep(s, next) : await this.clientStep(s, next);
      if (this.closed) {
        if (i < this.steps.length) this.fail(`connection closed before step ${i}: ${this.closed.reason}`);
        return;
      }
    }
    await this.settle();
    for (const o of this.sent) {
      if (!this.isLeaseAck(o) || o.kind !== "message") continue;
      if (!this.renewals.has(`${o.m.id}:${o.m.control.leaseAck}`)) this.fail(`leaseAck without a renewal: ${this.describe(o)}`);
    }
    // Lease acks answering delivered renewals and download credit (the
    // client's policy) are always legitimate.
    const left = this.pending().filter((k) => !this.isLeaseAck(this.sent[k]!) && !this.isGrant(this.sent[k]!));
    if (left.length > 0) this.fail(`unmatched client output: ${left.map((k) => this.describe(this.sent[k]!)).join(", ")}`);
  }

  // ---- server → client ----

  deliver(s: Json): void {
    if (s.message) this.client.handleText(JSON.stringify(s.message));
    else if (typeof s.raw === "string") this.client.handleText(s.raw);
    else if (s.frame) this.client.handleFrame(frameBytes(s.frame));
    else this.fail("step without payload");
  }

  async serverStep(s: Json, next: Json | undefined): Promise<number> {
    const m = s.message;
    const id = this.idOf(s);
    const ignored = this.flag(s, "ignored");
    if (m?.type === "deviceRequest" && !ignored && id !== null) {
      this.requests.set(id, m);
      this.credit.set(id, m.initialCredit ?? 0);
    }
    if (m?.control?.renewLease !== undefined && id !== null) this.renewals.add(`${id}:${m.control.renewLease}`);
    if (m?.control?.grant !== undefined && id !== null && !s.expectViolation && !ignored) {
      this.credit.set(id, (this.credit.get(id) ?? 0) + m.control.grant);
    }
    if (s.frame && !ignored && id !== null && this.requests.has(id)) {
      // A server → client download frame must fit the credit the client granted.
      const payload = frameBytes(s.frame).byteLength - 12;
      const total = (this.downloaded.get(id) ?? 0) + payload;
      this.downloaded.set(id, total);
      if (!s.expectViolation && !this.abandoned.has(id) && total > (this.granted.get(id) ?? 0)) {
        this.fail(`the server's download frame exceeds the ${this.granted.get(id) ?? 0} bytes the client granted`);
      }
    }
    const before = this.sent.length;
    const wasLive = id !== null && this.requests.has(id) && this.isLive(id);
    this.deliver(s);
    await this.settle();
    const fresh: number[] = [];
    for (let k = before; k < this.sent.length; k++) {
      const oid = this.outId(this.sent[k]!);
      if (!this.consumed.has(k) && !(oid !== null && this.abandoned.has(oid))) fresh.push(k);
    }
    if (ignored) {
      if (fresh.length > 0) this.fail(`ignored step produced ${fresh.map((k) => this.describe(this.sent[k]!))}`);
      return 1;
    }
    const category = s.expectViolation as string | undefined;
    if (category) {
      if (category === "connection") {
        if (!this.closed) this.fail("connection violation not detected");
        stats.clientDetected += 1;
        return 1;
      }
      if (!this.flag(next, "reaction")) {
        // Connection-level (D3): discarded and counted, nothing sent, nothing ended.
        if (fresh.length > 0) this.fail(`connection-level violation produced ${fresh.map((k) => this.describe(this.sent[k]!))}`);
        if (this.closed) this.fail("closed on a single connection-level violation");
        stats.clientDetected += 1;
        return 1;
      }
      const reaction = next.message;
      const hit = fresh.find((k) => {
        const o = this.sent[k]!;
        return o.kind === "message" && o.m.type === "deviceResponse" && o.m.id === reaction.id && o.m.error?.code === reaction.error?.code;
      });
      if (hit === undefined) {
        this.fail(`expected reaction ${JSON.stringify(reaction)} after ${category}, got ${fresh.map((k) => this.describe(this.sent[k]!))}`);
      }
      this.consumed.add(hit);
      this.abandoned.add(reaction.id);
      stats.clientDetected += 1;
      stats.reactions += 1;
      return 2;
    }
    if (m?.control?.cancel === true && id !== null) {
      if (wasLive && !this.abandoned.has(id)) {
        const hit = fresh.find((k) => {
          const o = this.sent[k]!;
          return o.kind === "message" && o.m.type === "deviceResponse" && o.m.id === id;
        });
        if (hit === undefined) this.fail(`no cancelled terminal for ${id}`);
        const o = this.sent[hit] as { kind: "message"; m: Json };
        if (o.m.error?.code !== "cancelled") this.fail(`cancel answered with ${this.describe(o)}`);
        this.consumed.add(hit);
      }
      this.abandoned.add(id);
      return 1;
    }
    if (this.closed) this.fail(`closed on a valid step: ${this.closed.reason}`);
    const refused = fresh.find((k) => {
      const o = this.sent[k]!;
      return o.kind === "message" && o.m.type === "deviceResponse" && ["invalidParams", "unsupported"].includes(o.m.error?.code);
    });
    if (refused !== undefined) {
      const tid = this.outId(this.sent[refused]!)!;
      // The transcript then shows the *client* lying about this id (e.g. a
      // success despite a hash mismatch); the TS client refuses instead.
      if (!this.clientMisbehaves.has(tid)) this.fail(`valid step refused: ${this.describe(this.sent[refused]!)}`);
      this.consumed.add(refused);
      this.abandoned.add(tid);
      stats.clientDetected += 1;
    }
    return 1;
  }

  // ---- client → server ----

  isUploadStep(s: Json): boolean {
    if (s.frame) return true;
    const m = s.message;
    if (!m) return false;
    if (m.type === "deviceResponse") return m.result !== undefined;
    if (m.event?.kind === "blobStart") return true;
    return m.control?.paused !== undefined;
  }

  async op(id: number): Promise<Op> {
    await this.settle();
    const op = this.ops.get(id);
    if (!op) this.fail(`no running driver for ${id}`);
    return op;
  }

  async clientStep(s: Json, next: Json | undefined): Promise<number> {
    const id = this.idOf(s);
    if (this.flag(s, "ignored")) {
      stats.serverSideSteps += 1;
      return 1;
    }
    if (s.expectViolation) {
      // A misbehaving client: the TS client never sends this.
      stats.serverSideSteps += 1;
      if (!this.isConnectionLevel(s, next) && id !== null) this.abandoned.add(id);
      return 1;
    }
    if (this.flag(s, "reaction")) this.fail("unexpected client reaction step");
    if (id === null) this.fail("client step without id");
    if (this.abandoned.has(id)) {
      stats.serverSideSteps += 1;
      return 1;
    }
    const req = this.requests.get(id);
    const rev = req ? findRevision(req.capability, req.version) : undefined;
    if (!req || !rev) this.fail(`client step for unknown request ${id}`);
    const m = s.message;
    const control = m?.control;
    if (control?.leaseAck !== undefined) {
      await this.settle();
      const idx = this.pending().find((k) => {
        const o = this.sent[k]!;
        return o.kind === "message" && JSON.stringify(o.m) === JSON.stringify(m);
      });
      if (idx !== undefined) this.consumed.add(idx);
      else if (!this.ackedSeqs.get(id)?.has(control.leaseAck)) this.fail(`leaseAck ${control.leaseAck} for ${id} never sent`);
      // else: a repeated/older ack of a sent sequence — legal, not reproduced
    } else if (rev.data === "binaryUpload" && this.isUploadStep(s)) {
      if (this.clientMisbehaves.has(id)) {
        stats.serverSideSteps += 1;
        return 1;
      }
      await this.uploadStep(id, s);
    } else if (control?.grant !== undefined) {
      await this.downloadGrant(id);
    } else if (m?.type === "deviceEvent" && m.event) {
      if (!this.hasPending(id)) {
        const op = await this.op(id);
        op.ctx.emit(m.event);
      }
      await this.expectNext(id, m);
    } else if (m?.type === "deviceResponse" && m.error && this.uploadTriggered.has(id)) {
      await this.failUpload(id, m);
    } else if (m?.type === "deviceResponse") {
      if (!this.hasPending(id)) {
        const op = await this.op(id);
        if (op.receiving) {
          const got = await op.receiving;
          if (m.result?.bytesWritten !== undefined && got.byteLength !== m.result.bytesWritten) {
            this.fail(`download delivered ${got.byteLength} bytes, transcript wrote ${m.result.bytesWritten}`);
          }
          stats.downloadsVerified += 1;
        }
        // `simulated` is the driver's own marker (a fake driver, §1.11).
        const simulated = m.simulated === true ? { simulated: true as const } : {};
        if (m.result) op.resolve({ kind: "result", result: m.result, ...simulated });
        else op.resolve({ kind: "error", code: m.error.code, ...(m.error.platformDetail !== undefined ? { platformDetail: m.error.platformDetail } : {}), ...simulated });
      }
      await this.expectNext(id, m);
    } else {
      this.fail(`unexpected client step ${JSON.stringify(s)}`);
    }
    stats.produced += 1;
    return 1;
  }

  /** Download credit: the driver asks to receive; the client grants (its own amounts). */
  async downloadGrant(id: number): Promise<void> {
    const op = await this.op(id);
    if (!op.ctx.download) this.fail(`grant step for ${id}, which has no download plane`);
    if (!op.receiving) {
      op.receiving = op.ctx.download.receiveAll();
      op.receiving.catch(() => undefined);
    }
    await this.settle();
    let found = false;
    for (const k of this.pending()) {
      const o = this.sent[k]!;
      if (this.outId(o) !== id || !this.isGrant(o) || o.kind !== "message") continue;
      const g = o.m.control.grant;
      if (!Number.isSafeInteger(g) || g < 1) this.fail(`bad grant ${g}`);
      this.granted.set(id, (this.granted.get(id) ?? 0) + g);
      this.consumed.add(k);
      found = true;
    }
    if (!found && !this.granted.has(id)) this.fail(`client sent no grant for ${id}`);
  }

  async expectNext(id: number, expected: Json): Promise<void> {
    await this.settle();
    const idx = this.pending().find((k) => this.outId(this.sent[k]!) === id && !this.isLeaseAck(this.sent[k]!) && !this.isGrant(this.sent[k]!));
    if (idx === undefined) this.fail(`client sent nothing for ${id}; expected ${JSON.stringify(expected)}`);
    const got = this.sent[idx]!;
    if (got.kind !== "message" || JSON.stringify(sortKeys(got.m)) !== JSON.stringify(sortKeys(expected))) {
      this.fail(`expected ${JSON.stringify(expected)}\n   got ${this.describe(got)}`);
    }
    this.consumed.add(idx);
  }

  // ---- uploads ----

  uploadSteps(id: number): Json[] {
    return this.steps.filter(
      (s) => s.dir === "c2s" && !this.flag(s, "ignored") && !s.expectViolation && this.idOf(s) === id && this.isUploadStep(s)
    );
  }

  /**
   * The driver's upload outcome as the transcript shows it. With `gated`, an
   * undeclared (live, D5) item is a source that yields each captured chunk
   * only when the transcript reaches it (see `LiveSource`), so a recorder's
   * frames, pauses and lease traffic interleave exactly as recorded.
   */
  uploadOutcome(id: number, gated = false): DriverOutcome {
    const all = this.uploadSteps(id);
    const payloads = new Map<number, Uint8Array[]>();
    for (const s of all) {
      if (!s.frame) continue;
      const d = decodeFrame(frameBytes(s.frame));
      if (!d.ok) this.fail("bad transcript frame");
      const list = payloads.get(d.header.channel) ?? [];
      list.push(d.payload.slice());
      payloads.set(d.header.channel, list);
    }
    const terminal = [...all].reverse().find((s) => s.message?.type === "deviceResponse")?.message;
    const result: Record<string, unknown> = { ...(terminal?.result ?? {}) };
    const items: Json[] = Array.isArray(result.items) ? result.items : result.item ? [result.item] : [];
    delete result.items;
    delete result.item;
    const blobs: DriverBlob[] = [];
    for (const s of all) {
      const start = s.message?.event;
      if (start?.kind !== "blobStart") continue;
      const chunks = payloads.get(start.channel) ?? [];
      const item = items.find((it) => it.channel === start.channel);
      const blob: DriverBlob = { channel: start.channel, contentType: start.contentType };
      if (typeof item?.name === "string") blob.name = item.name;
      if (start.bytes !== undefined) {
        const whole = concat(chunks);
        if (whole.byteLength !== start.bytes) this.fail(`transcript declares ${start.bytes} bytes, frames carry ${whole.byteLength}`);
        blob.bytes = whole;
      } else {
        // Unknown length (D5): the source streams, nothing is declared.
        if (gated) {
          const source = new LiveSource(chunks);
          let perId = this.live.get(id);
          if (!perId) this.live.set(id, (perId = new Map()));
          perId.set(start.channel, source);
          blob.stream = source.stream();
        } else {
          blob.stream = (async function* () {
            for (const c of chunks) yield c;
          })();
        }
      }
      blobs.push(blob);
    }
    blobs.sort((a, b) => a.channel - b.channel);
    return { kind: "result", result, blobs, ...(terminal?.simulated === true ? { simulated: true as const } : {}) };
  }

  async uploadStep(id: number, s: Json): Promise<void> {
    if (!this.uploadTriggered.has(id)) {
      this.uploadTriggered.add(id);
      const op = await this.op(id);
      op.resolve(this.uploadOutcome(id, true));
      await this.settle();
    }
    const sources = this.live.get(id);
    if (s.frame && sources) {
      // The recorder captured this frame's bytes.
      const channel = s.frame.header.channel as number;
      const n = (this.frameSteps.get(`${id}:${channel}`) ?? 0) + 1;
      this.frameSteps.set(`${id}:${channel}`, n);
      sources.get(channel)?.releaseThrough(n);
      await this.settle();
    } else if (s.message?.control?.paused === true && sources) {
      // The sender ran out of credit with captured bytes waiting: the
      // recorder captured the next chunk (or bytes never sent, when the
      // request then ends) of the item being streamed.
      const current = [...sources.entries()].sort((a, b) => a[0] - b[0]).find(([, src]) => !src.ended);
      current?.[1].captureMore();
      await this.settle();
    }
    if (s.message?.type === "deviceResponse") {
      // Stop: every captured byte is out and the recording ends.
      for (const src of sources?.values() ?? []) src.end();
      await this.verifyUpload(id, s.message);
    }
  }

  /**
   * An error terminal after the driver already handed over a live item
   * (e.g. mic.record `throttled` when its bounded capture window filled
   * while starved of credit): the driver ends the request through
   * `ctx.fail`; what went out before must match the transcript's prefix.
   */
  async failUpload(id: number, terminal: Json): Promise<void> {
    const op = await this.op(id);
    if (typeof op.ctx.fail !== "function") this.fail("DriverContext.fail is missing");
    op.ctx.fail(terminal.error.code, terminal.error.platformDetail);
    await this.settle();
    const outs = this.pending().filter((k) => this.outId(this.sent[k]!) === id && !this.isLeaseAck(this.sent[k]!));
    const sentBytes = new Map<number, Uint8Array[]>();
    let result: Json = null;
    for (const k of outs) {
      const o = this.sent[k]!;
      if (o.kind === "frame") {
        const d = decodeFrame(o.bytes);
        if (!d.ok) this.fail("bad frame");
        if (d.payload.byteLength === 0) this.fail("zero-length frame (D2)");
        const list = sentBytes.get(d.header.channel) ?? [];
        list.push(d.payload.slice());
        sentBytes.set(d.header.channel, list);
      } else if (o.m.type === "deviceResponse") {
        result = o.m;
      } else if (o.m.event?.kind !== "blobStart" && o.m.control?.paused === undefined) {
        this.fail(`unexpected upload output ${this.describe(o)}`);
      }
      this.consumed.add(k);
    }
    for (const [channel, chunks] of sentBytes) {
      if (!equalBytes(concat(chunks), concat(this.streamedChunks(id, channel)))) this.fail(`channel ${channel} bytes differ`);
    }
    if (!result) this.fail(`no terminal for ${id}`);
    if (JSON.stringify(sortKeys(result)) !== JSON.stringify(sortKeys(terminal))) {
      this.fail(`terminal ${JSON.stringify(result)} != ${JSON.stringify(terminal)}`);
    }
    stats.uploadsVerified += 1;
  }

  async verifyUpload(id: number, terminal: Json): Promise<void> {
    await this.settle();
    const outs = this.pending().filter((k) => this.outId(this.sent[k]!) === id && !this.isLeaseAck(this.sent[k]!));
    const announced = new Map<number, Json>();
    const bytes = new Map<number, Uint8Array[]>();
    const nextSeq = new Map<number, number>();
    let paused = false;
    let result: Json = null;
    for (const k of outs) {
      const o = this.sent[k]!;
      if (o.kind === "frame") {
        const d = decodeFrame(o.bytes);
        if (!d.ok) this.fail("bad frame");
        const ch = d.header.channel;
        if (paused) this.fail("frame sent while paused");
        if (!announced.has(ch)) this.fail(`frame before blobStart on channel ${ch}`);
        if (d.payload.byteLength === 0) this.fail("zero-length frame (D2)");
        if (d.payload.byteLength > 64 * 1024) this.fail("chunk above 64 KiB");
        if (d.header.seq !== (nextSeq.get(ch) ?? 0)) this.fail(`seq ${d.header.seq} on channel ${ch}`);
        nextSeq.set(ch, d.header.seq + 1);
        const list = bytes.get(ch) ?? [];
        list.push(d.payload.slice());
        bytes.set(ch, list);
      } else if (o.m.event?.kind === "blobStart") {
        announced.set(o.m.event.channel, o.m.event);
      } else if (o.m.control?.paused !== undefined) {
        if (o.m.control.paused === paused) this.fail(`paused repeats ${paused}`);
        paused = o.m.control.paused;
      } else if (o.m.type === "deviceResponse") {
        result = o.m;
      } else {
        this.fail(`unexpected upload output ${this.describe(o)}`);
      }
      this.consumed.add(k);
    }
    if (paused) this.fail("ended paused");
    const wantStarts = new Map<number, Json>();
    for (const s of this.uploadSteps(id)) {
      const e = s.message?.event;
      if (e?.kind === "blobStart") wantStarts.set(e.channel, e);
    }
    const norm = (m: Map<number, Json>) => JSON.stringify([...m].sort((a, b) => a[0] - b[0]).map(([c, e]) => [c, sortKeys(e)]));
    if (norm(announced) !== norm(wantStarts)) this.fail(`blobStarts ${norm(announced)} != ${norm(wantStarts)}`);
    const want = this.uploadOutcome(id) as Extract<DriverOutcome, { kind: "result" }>;
    for (const blob of want.blobs ?? []) {
      const got = concat(bytes.get(blob.channel) ?? []);
      const expected = blob.bytes ?? concat(this.streamedChunks(id, blob.channel));
      if (!equalBytes(got, expected)) this.fail(`channel ${blob.channel} bytes differ`);
    }
    if (!result) this.fail(`no terminal for ${id}`);
    if (JSON.stringify(sortKeys(sortItems(result))) !== JSON.stringify(sortKeys(sortItems(terminal)))) {
      this.fail(`terminal ${JSON.stringify(result)} != ${JSON.stringify(terminal)}`);
    }
    stats.uploadsVerified += 1;
  }

  streamedChunks(id: number, channel: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const s of this.uploadSteps(id)) {
      if (!s.frame) continue;
      const d = decodeFrame(frameBytes(s.frame));
      if (d.ok && d.header.channel === channel) out.push(d.payload);
    }
    return out;
  }
}

/**
 * A live capture source (D5, §2.4 "frames as captured"): chunk k exists only
 * once the transcript shows it captured — its frame step, or a `paused`
 * step (the sender had captured bytes it could not send). `end()` is the
 * recording's Stop. Bytes captured beyond the transcript's frames stand in
 * for audio that is never sent (the request then fails).
 */
class LiveSource {
  private released = 0;
  private extra = 0;
  private done = false;
  private wake: (() => void) | null = null;

  constructor(private readonly chunks: Uint8Array[]) {}

  get ended(): boolean {
    return this.done || this.released >= this.chunks.length + this.extra;
  }

  releaseThrough(n: number): void {
    if (n > this.released) this.released = Math.min(n, this.chunks.length);
    this.poke();
  }

  captureMore(): void {
    if (this.released < this.chunks.length) this.released += 1;
    else this.extra += 1;
    this.poke();
  }

  end(): void {
    this.released = this.chunks.length;
    this.done = true;
    this.poke();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *stream(): AsyncGenerator<Uint8Array> {
    let next = 0;
    let extraOut = 0;
    for (;;) {
      if (next < this.released) {
        yield this.chunks[next++]!;
        continue;
      }
      if (next >= this.chunks.length && extraOut < this.extra) {
        extraOut += 1;
        yield new Uint8Array([0x5a, 0xa5]); // captured, never sent
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function sortItems(response: Json): Json {
  const items = response?.result?.items;
  if (!Array.isArray(items)) return response;
  return { ...response, result: { ...response.result, items: [...items].sort((a, b) => a.channel - b.channel) } };
}

// ---------------------------------------------------------------------------

const files = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("shared wire transcripts replayed against the TS client (DeviceClient)", () => {
  test("the corpus is present and non-trivial", () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
  });

  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(TRANSCRIPTS, file), "utf8"));
    if (doc.hello !== undefined) continue; // handshake-selection fixtures: below
    test(file, async () => {
      expect(`${doc.name}.json`).toBe(file);
      await new Replay(doc).run();
      stats.transcripts += 1;
    });
  }
});

// ---------------------------------------------------------------------------
// Handshake selection, from the client's side
// ---------------------------------------------------------------------------

class MockWS extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWS[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  onopen: null | (() => void) = null;
  sent: unknown[] = [];
  constructor(public url: string) {
    super();
    MockWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let savedWebSocket: unknown;
beforeEach(() => {
  savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
  MockWS.instances = [];
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
});

/**
 * Deliver the server's selection for `hello` to a RemoteEngine whose device
 * endpoint advertises `hello`; return what the endpoint was handed.
 */
async function clientAccepts(hello: DeviceHello, expectAck: DeviceAck | null): Promise<Array<DeviceAck | undefined>> {
  const acks: Array<DeviceAck | undefined> = [];
  const endpoint: DeviceEndpoint = {
    advertisement: hello,
    attach: () => {},
    onAck: (a) => acks.push(a),
    handleMessage: () => {},
    handleFrame: () => {},
    detach: () => {},
  };
  const engine = new RemoteEngine("ws://app.test", { device: endpoint, autoReconnect: false });
  expect((await engine.connect()).ok).toBe(true);
  const ws = MockWS.instances.at(-1)!;
  const helloSent = JSON.parse(ws.sent[0] as string);
  expect(helloSent.device).toEqual(hello);
  ws.receive(
    JSON.stringify({
      type: "sessionAck",
      sessionId: "s-1",
      isNew: true,
      isRestored: false,
      ...(expectAck ? { device: expectAck } : {}),
    })
  );
  engine.disconnect();
  return acks;
}

describe("handshake selection from the client's side", () => {
  const handshakeFiles = files.filter((f) => JSON.parse(readFileSync(join(TRANSCRIPTS, f), "utf8")).hello !== undefined);

  test("the corpus has handshake-selection transcripts", () => {
    expect(handshakeFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of handshakeFiles) {
    test(file, async () => {
      const doc = JSON.parse(readFileSync(join(TRANSCRIPTS, file), "utf8"));
      expect(await clientAccepts(doc.hello, doc.expectAck)).toEqual([doc.expectAck ?? undefined]);
      stats.handshake += 1;
    });
  }

  const selection = JSON.parse(readFileSync(join(ROOT, "conformance/selection.json"), "utf8"));
  for (const c of selection.cases as Json[]) {
    test(`selection.json: ${c.name}`, async () => {
      expect(await clientAccepts(c.hello, c.expect)).toEqual([c.expect ?? undefined]);
    });
  }
});

describe("coverage", () => {
  test("every transcript ran (none skipped) and the client detected the violations it must", () => {
    expect(stats.transcripts + stats.handshake).toBe(files.length);
    // eslint-disable-next-line no-console
    console.log(`device transcripts (TS client): ${JSON.stringify(stats)}`);
    expect(stats.clientDetected).toBeGreaterThanOrEqual(30);
    expect(stats.reactions).toBeGreaterThanOrEqual(25);
    expect(stats.uploadsVerified).toBeGreaterThanOrEqual(8);
    expect(stats.downloadsVerified).toBeGreaterThanOrEqual(2);
  });
});
