/**
 * Shared harness for the server-side device tests (device-srv-*.test.ts):
 * a fake wasm engine that really invokes registered action handlers, a
 * recording transport, a SessionHost builder, and a deterministic clock.
 */

import { BaseEngine } from "@hypen-space/core/engine-base";
import {
  SessionManager,
  type DeviceOutgoing,
  type OutgoingMessage,
  type SessionHost,
  type SessionTransport,
} from "@hypen-space/core/remote";
import {
  DEVICE_REGISTRY,
  DevicePlane,
  needsBinary,
  type DeviceAck,
  type DeviceBrokerConfig,
  type DeviceClock,
  type DevicePlaneOpen,
  type DeviceClient,
  type DeviceClientTransport,
  type DeviceEvent,
  type DeviceResponse,
} from "@hypen-space/core/remote/device";
import {
  createWasmDeviceBrokerFactory,
  type WasmRetainedBytesPool,
} from "../packages/server/src/device-broker";
import type { HypenApp } from "../packages/core/src/app";

export type RouterBlock = { moduleScope: string | null; routes: Array<{ path: string; elementNames: string[] }> };

/** Fake wasm engine that stores action handlers and invokes them on dispatch. */
export class HandlerFakeEngine extends BaseEngine {
  readonly handlers = new Map<string, (action: unknown) => void>();
  constructor(private readonly routers: RouterBlock[] = []) {
    super();
  }
  async init(): Promise<void> {
    const self = this;
    this.wasmEngine = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "onAction") {
            return (name: string, h: (a: unknown) => void) => self.handlers.set(name, h);
          }
          if (prop === "dispatchAction") {
            return (name: string, payload: unknown) => {
              for (const [key, h] of self.handlers) {
                if (key === name || key.endsWith(`:${name}`) || key.endsWith(`.${name}`)) h({ name, payload });
              }
            };
          }
          if (prop === "discoverRouters") return () => self.routers;
          return () => {};
        },
      }
    );
    this.initialized = true;
  }
  protected unwrapForWasm<T>(value: T): T {
    return value;
  }
}

/** Transport recording UI messages, device messages, frames and closes. */
export function makeTransport(opts: { binary?: boolean } = {}) {
  const ui: OutgoingMessage[] = [];
  const device: DeviceOutgoing[] = [];
  const binary: Uint8Array[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const transport: SessionTransport = {
    send: (m) => ui.push(m),
    sendDevice: (m) => device.push(m),
    ...(opts.binary === false ? {} : { sendBinary: (f: Uint8Array) => binary.push(f) }),
    close: (code, reason) => closes.push({ code, reason }),
  };
  return { transport, ui, device, binary, closes };
}

export function makeHost(
  module: SessionHost["module"],
  opts: {
    /** true: the host opts out of the device plane (UI-only). */
    deviceDisabled?: boolean;
    syncActions?: boolean;
    app?: HypenApp | null;
    routers?: RouterBlock[];
    sessionManager?: SessionManager;
    deviceMaxRetainedBytes?: number;
    /** Aggregate pool of the host's brokers (default: none). */
    devicePoolBytes?: number | null;
    /** false: the host supplies no device broker. */
    deviceBroker?: boolean;
  } = {}
): SessionHost {
  return {
    module,
    moduleName: "Test",
    ui: 'Text("hi")',
    resources: {},
    app: opts.app ?? null,
    syncActions: opts.syncActions ?? false,
    ...(opts.deviceDisabled ? { deviceDisabled: true } : {}),
    ...(opts.deviceMaxRetainedBytes !== undefined
      ? { deviceMaxRetainedBytes: opts.deviceMaxRetainedBytes }
      : {}),
    ...(opts.deviceBroker === false
      ? {}
      : { deviceBrokerFactory: createWasmDeviceBrokerFactory({ poolBytes: opts.devicePoolBytes ?? null }) }),
    sessionManager: opts.sessionManager ?? new SessionManager(),
    discoveredComponents: new Map(),
    createEngine: () => new HandlerFakeEngine(opts.routers ?? []),
    otherSessions: () => [],
    sessionsForId: () => [],
    onSessionReady: () => {},
    onSessionDestroyed: () => {},
  };
}

export const CAPS_ALL = [
  { name: "core.capabilities", versions: [1] },
  { name: "gallery.pick", versions: [1] },
  { name: "file.save", versions: [1] },
  { name: "permission.request", versions: [1] },
  { name: "bluetooth.scan", versions: [1] },
  { name: "mic.record", versions: [1] },
];

export function deviceHello(
  capabilities: Array<{ name: string; versions: number[] }> = CAPS_ALL,
  extra: Record<string, unknown> = {}
) {
  return {
    type: "hello" as const,
    ...extra,
    device: { protocolVersions: [1], binary: true, capabilities },
  };
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fake device clock: manual time advance, one-shot timers fired in order.
 * The device plane re-arms one timer from the broker's next deadline, so
 * advancing fires exactly the broker's due work (leases, deadlines, the
 * planned core.capabilities reopen) at the right virtual times.
 */
export class FakeClock implements DeviceClock {
  private t = 0;
  private timers = new Map<number, { fn: () => void; at: number }>();
  private seq = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.t + Math.max(0, ms) });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Timers currently armed (a device plane arms at most one). */
  get pending(): number {
    return this.timers.size;
  }
  /** Advance virtual time, firing due timers in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    while (true) {
      let soonest: { id: number; at: number } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (soonest === null || timer.at < soonest.at)) soonest = { id, at: timer.at };
      }
      if (soonest === null) break;
      this.t = Math.max(this.t, soonest.at);
      const timer = this.timers.get(soonest.id)!;
      this.timers.delete(soonest.id);
      timer.fn();
    }
    this.t = target;
  }
}

/** Device messages of one kind from a recorded list. */
export const requestsOf = (device: DeviceOutgoing[], capability?: string) =>
  device.filter(
    (m) => m.type === "deviceRequest" && (capability === undefined || (m as any).capability === capability)
  ) as any[];

export const controlsFor = (device: DeviceOutgoing[], id: number, key: string) =>
  device.filter((m) => m.type === "deviceEvent" && (m as any).id === id && (m as any).control && key in (m as any).control) as any[];

// ---------------------------------------------------------------------------
// The Rust broker through the port, driven by a DevicePlane (unit level)
// ---------------------------------------------------------------------------

/** Every v1 registry revision selected (binary profile unless told otherwise). */
export function fullAck(binary = true): DeviceAck {
  const capabilities: DeviceAck["capabilities"] = [];
  for (const [name, revs] of DEVICE_REGISTRY) {
    const rev = revs.find((r) => r.version === 1);
    if (!rev) continue;
    if (!binary && needsBinary(rev)) continue;
    capabilities.push({ name, version: 1 });
  }
  return { protocolVersion: 1, binary, capabilities };
}

export interface PlaneHarnessOptions {
  clock?: FakeClock;
  ack?: DeviceAck;
  /** Extra broker configuration (limits, overrides, scheduler). */
  config?: Omit<DeviceBrokerConfig, "ack">;
  /** Share an aggregate retained-bytes pool. */
  pool?: WasmRetainedBytesPool;
  /** Transport-reported buffered bytes (bulk scheduling). */
  bufferedAmount?: () => number;
  /** Bulk-turn deferral (default: a macrotask). */
  defer?: (fn: () => void) => void;
  /** Module activations registered up front (default: m1 @ 1). */
  owners?: Array<[string, number]>;
  /** Open core.capabilities (default true); the broker admits nothing before. */
  start?: boolean;
  /** No binary route (downloads refused). */
  noFrames?: boolean;
  /**
   * Acknowledge renewals as a live client would: "core" for the control
   * stream only (so long clock advances never close the plane), "all" for
   * every request.
   */
  autoAck?: "core" | "all";
  /** Also hand every server → client message / frame here (a loopback). */
  onSend?: (message: any) => void;
  onFrameOut?: (frame: Uint8Array) => void;
}

/**
 * A `DevicePlane` over the real Rust broker (`WasmDeviceBroker` from
 * wasm-node) with an injected fake clock — the TS device tests' unit-level
 * broker. `sent` collects every server → client device message (parsed),
 * `frames` every download frame, `closes` every connection close the broker
 * asked for. `core` is the id of the connection-owned `core.capabilities`
 * stream, which `start()` opens first (so handler requests start at id 2).
 */
export function makePlane(opts: PlaneHarnessOptions = {}) {
  const clock = opts.clock ?? new FakeClock();
  const ack = opts.ack ?? fullAck();
  const sent: any[] = [];
  const frames: Uint8Array[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const factory = createWasmDeviceBrokerFactory(opts.pool ? { pool: opts.pool } : { poolBytes: null });
  const port = factory({ ...opts.config, ack }, clock.now());
  const plane = new DevicePlane(
    port,
    {
      sendText: (text) => {
        const m = JSON.parse(text);
        sent.push(m);
        opts.onSend?.(m);
        if (opts.autoAck && m.control?.renewLease !== undefined && (opts.autoAck === "all" || m.id === plane.coreStreamId)) {
          plane.receiveText(JSON.stringify({ type: "deviceEvent", id: m.id, control: { leaseAck: m.control.renewLease } }));
        }
      },
      ...(opts.noFrames
        ? {}
        : {
            sendFrame: (f: Uint8Array) => {
              frames.push(f);
              opts.onFrameOut?.(f);
            },
          }),
      ...(opts.bufferedAmount ? { bufferedAmount: opts.bufferedAmount } : {}),
      closeConnection: (code, reason) => closes.push({ code, reason }),
    },
    { clock, binary: ack.binary, ...(opts.defer ? { defer: opts.defer } : {}) }
  );
  if (opts.start !== false) plane.start();
  for (const [mi, act] of opts.owners ?? [["m1", 1]]) plane.ownerActivated(mi, act);
  const core = plane.coreStreamId;
  /** Feed one client → server device message (object or raw text). */
  const receive = (m: object | string) => plane.receiveText(typeof m === "string" ? m : JSON.stringify(m));
  /** Ack every renewLease sent so far for `id` (keeps a request's lease alive). */
  const ackLeases = (id: number) => {
    const seqs = sent.filter((m) => m.id === id && m.control?.renewLease !== undefined).map((m) => m.control.renewLease);
    if (seqs.length > 0) receive({ type: "deviceEvent", id, control: { leaseAck: Math.max(...seqs) } });
  };
  return { plane, port, sent, frames, closes, clock, receive, core, ackLeases };
}

/** Open spec shorthand: activation m1 @ 1 unless overridden. */
export const spec = (capability: string, params: unknown, extra: Partial<DevicePlaneOpen> = {}): DevicePlaneOpen => ({
  capability,
  params,
  moduleInstanceId: "m1",
  activationId: 1,
  ...extra,
});

/**
 * A plane (Rust broker) wired to a client-side `DeviceClient` through
 * in-process queues: server → client messages and frames go to the client,
 * client → server traffic back into the plane, each deferred a microtask so
 * ordering matches a real duplex transport. The connection-owned
 * `core.capabilities` stream stays server-side (the clients under test run
 * without a handshake, like a bare `DeviceClient`); its lease cannot expire
 * because loopback tests do not advance the fake clock.
 */
export function loopback(
  makeClient: (transport: DeviceClientTransport) => DeviceClient,
  opts: PlaneHarnessOptions = {}
) {
  let client!: DeviceClient;
  let core: number | undefined;
  /** Client → server traffic in wire order: JSON messages and binary frames. */
  const clientSent: Array<DeviceResponse | DeviceEvent | Uint8Array> = [];
  const h = makePlane({
    ...opts,
    onSend: (m) => {
      opts.onSend?.(m);
      if (core === undefined || m.id === core) return;
      queueMicrotask(() => client.handleMessage(m));
    },
    onFrameOut: (f) => {
      opts.onFrameOut?.(f);
      queueMicrotask(() => client.handleFrame(f));
    },
  });
  core = h.core;
  client = makeClient({
    sendMessage: (m) => {
      clientSent.push(m);
      queueMicrotask(() => h.receive(m));
    },
    sendBinary: (f) => {
      clientSent.push(f);
      queueMicrotask(() => h.plane.receiveFrame(f));
    },
  });
  return { ...h, client: () => client, clientSent };
}
