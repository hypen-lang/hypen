/**
 * RemoteSession - Transport-agnostic per-client session for Hypen remote apps.
 *
 * One `RemoteSession` owns one logical client: a dedicated engine instance,
 * a module instance, a session id, and the logic that drives the Hypen remote
 * protocol (hello → sessionAck → initialTree → streaming patches).
 *
 * It does NOT know how bytes reach the client. That is the job of the
 * `SessionTransport` interface — a minimal `{ send, close }` contract that
 * can be backed by a Bun `ServerWebSocket`, an SSE `ReadableStream`, an
 * in-memory queue (see `AsyncQueueTransport`), or anything else.
 *
 * Backend devs can plug Hypen into an existing Express/Fastify/ws/uWebSockets
 * setup by:
 *
 *   1. Calling `server.prepare()` once (discovery + session manager init).
 *   2. Calling `server.createSession(transport)` per client.
 *   3. Forwarding incoming JSON messages via `session.receive(msg)`.
 *   4. Calling `session.destroy()` when the transport closes.
 *
 * Or, for a pure async-iterator style:
 *
 *   const transport = new AsyncQueueTransport();
 *   const session = server.createSession(transport);
 *   for await (const out of transport.stream()) { ...forward to client... }
 */

import type {
  HypenApp,
  HypenModule,
  HypenModuleDefinition,
} from "../app.js";
import { HypenModuleInstance, HypenApp as HypenAppClass } from "../app.js";
import { HypenGlobalContext } from "../context.js";
import { HypenRouter } from "../router.js";
import { ManagedRouter } from "../managed-router.js";
import type {
  DispatchActionMessage,
  HelloMessage,
  InitialTreeMessage,
  PatchMessage,
  RemoteClient,
  RemoteMessage,
  Session,
  SessionAckMessage,
  SessionExpiredMessage,
  StateUpdateMessage,
  UpdateStateMessage,
} from "./types.js";
import { SessionManager } from "./session.js";
import type { Patch } from "../types.js";
import type {
  DeviceRequest as DeviceRequestMessage,
  DeviceEvent as DeviceEventMessage,
  DeviceAck,
} from "./device/generated.js";
import { DevicePlane, systemDeviceClock, type DeviceClock } from "./device/plane.js";
import type { DeviceBrokerConfig, DeviceBrokerFactory } from "./device/port.js";
import { DEFAULT_MAX_RETAINED_BYTES } from "./device/constants.js";
import {
  findTopLevelMember,
  isDeviceTypedText,
  isOversizeDeviceText,
} from "./device/strict-json.js";
import { TemplateExpander } from "../patch-expand.js";
import { frameworkLoggers } from "../logger.js";
import { BaseEngine } from "../engine-base.js";

const log = frameworkLoggers.remote;

/**
 * Server → client messages emitted by a `RemoteSession`.
 */
export type OutgoingMessage =
  | InitialTreeMessage
  | PatchMessage
  | StateUpdateMessage
  | SessionAckMessage
  | SessionExpiredMessage;

/**
 * Minimal contract a `RemoteSession` needs to reach the client. Implement
 * this to plug Hypen into any transport.
 *
 * `send` receives a structured message — serialize however you like
 * (JSON, MessagePack, protobuf). Built-in adapters use `JSON.stringify`.
 */
export interface SessionTransport {
  send(message: OutgoingMessage): void;
  /**
   * Send a device-plane message (RFC 001 §5). Deliberately a separate method
   * taking a separate union that is NOT assignable to `OutgoingMessage`, so
   * `broadcast()` (typed on `OutgoingMessage`) can never carry a device
   * request. Optional: transports without it do not enable the device plane.
   */
  sendDevice?(message: DeviceOutgoing): void;
  /**
   * Send one device-plane message as the JSON text the broker produced
   * (preferred over `sendDevice` when present: no parse/stringify round
   * trip). Same separation from `send`/`broadcast` as `sendDevice`.
   */
  sendDeviceText?(text: string): void;
  /**
   * Send a raw binary device frame (RFC 001 §2.3). Present only on transports
   * that meet the binary profile; its absence means binary capabilities are
   * not advertised.
   */
  sendBinary?(frame: Uint8Array): void;
  /**
   * Bytes accepted by the transport but not yet written to the network
   * (e.g. Bun `ServerWebSocket.getBufferedAmount()`). The device scheduler
   * stops handing bulk frames to the transport while this is ≥ 256 KiB
   * (RFC 001 §2.3). Absent ⇒ treated as 0 (chunking/turn limits still apply).
   */
  bufferedAmount?(): number;
  close(code?: number, reason?: string): void;
}

/**
 * Server → client device-plane messages. Kept as its own union, structurally
 * disjoint from `OutgoingMessage`, so the UI broadcast path cannot emit one.
 */
export type DeviceOutgoing = DeviceRequestMessage | DeviceEventMessage;

/**
 * The subset of `RemoteServer` state a session needs. Kept as an interface so
 * sessions can be used standalone in tests and so alternate hosts (e.g. a
 * Cloudflare Durable Object wrapper) can satisfy it without subclassing
 * `RemoteServer`.
 */
export interface SessionHost {
  readonly module: HypenModule<any>;
  readonly moduleName: string;
  readonly ui: string;
  readonly resources: Record<string, string>;
  readonly app: HypenApp | null;
  readonly syncActions: boolean;
  /**
   * Opt-out of the Device Capability Protocol (RFC 001). The device plane is
   * on by default: any client whose hello offers `device` gets one, provided
   * the host supplies a `deviceBrokerFactory`. `true` makes the host behave
   * exactly like a UI-only server (`RemoteServer.disableDevice()`, a
   * Cloudflare `device: false`, or a setting incompatible with the device
   * plane such as `allow-multiple` session fan-out). `syncActions` is NOT
   * one: replayed dispatches carry replay provenance, so their
   * `context.device` refuses (`syncActions.replay`) while the originating
   * client keeps its device plane.
   */
  readonly deviceDisabled?: boolean;
  /**
   * Per-connection budget of retained device upload bytes (RFC 001 §2.4/§5).
   * Defaults to 128 MiB. A host with a smaller in-memory sink (a Cloudflare
   * Durable Object: 16 MiB) sets it lower; revisions whose `maxItemBytes`
   * exceed it are capped to it for this host, so `blobStart` admission and
   * `device.save()` both honor what the host can actually hold.
   */
  readonly deviceMaxRetainedBytes?: number;
  /**
   * Creates the connection's device broker — the Rust `DeviceBroker` through
   * the WASM-free port (RFC 001). Supplied by `@hypen-space/server`
   * (`createWasmDeviceBrokerFactory`) and `@hypen-space/cf`; the factory owns
   * the aggregate retained-bytes pool shared by this host's connections (a
   * process, or one Durable Object). Absent ⇒ the device plane is never
   * admitted (the host is UI-only).
   */
  readonly deviceBrokerFactory?: DeviceBrokerFactory;
  readonly sessionManager: SessionManager;
  readonly discoveredComponents: Map<
    string,
    { template: string; module?: HypenModuleDefinition<any> }
  >;

  /**
   * Construct a fresh engine for this session. Called once per session.
   *
   * Each session owns its own engine instance, so this must return a new
   * engine every call (not a shared singleton). This is the seam that keeps
   * `RemoteSession` engine-agnostic: `@hypen-space/server` returns
   * `new Engine()` (Node/Bun WASM), a Cloudflare Durable Object returns a
   * `CFEngine`, etc. The returned engine may be un-initialised — the session
   * calls `init()` itself.
   */
  createEngine(): BaseEngine;

  /** Other live sessions (for syncActions fan-out and allow-multiple peer broadcast). */
  otherSessions(self: RemoteSession): Iterable<RemoteSession>;

  /** Sessions that currently share `sessionId` (for kick-old / reject-new). */
  sessionsForId(sessionId: string): Iterable<RemoteSession>;

  /** Fired after hello → initialTree completes. */
  onSessionReady(session: RemoteSession, client: RemoteClient): void;

  /** Fired when the session is fully torn down. */
  onSessionDestroyed(session: RemoteSession, client: RemoteClient): void;
}

/**
 * Options passed when constructing a session.
 */
export interface RemoteSessionOptions {
  /** Internal client id (for logs and `RemoteClient.id`). Auto-generated if omitted. */
  clientId?: string;
  /**
   * Grace period in ms before a connected client that has not sent `hello`
   * is auto-initialised as a legacy (no-session-id) client. Set `null` to
   * disable the grace period entirely — useful for transports like SSE where
   * the first message may be deliberately delayed.
   *
   * Applies whether or not the host offers the device plane: a session
   * initialised by the grace timer simply has no device plane (a later hello
   * on it may still negotiate one, RFC 001 §2.2).
   * @default 1000
   */
  helloGraceMs?: number | null;
  /**
   * Handshake timeout: a connection that has not sent `hello` within this
   * many ms is closed (1008). Applies only when no grace timer initialises
   * the session (`helloGraceMs: null`). Off by default; `null` disables it
   * (e.g. a Cloudflare DO, whose timers do not survive hibernation).
   */
  helloTimeoutMs?: number | null;
  /**
   * `socket` value stored on the `RemoteClient` record surfaced to
   * `onConnection`/`onDisconnection` callbacks. Pass through the raw
   * transport handle (e.g. a `ServerWebSocket`) so user code has the
   * escape hatch when it needs it.
   */
  socketHandle?: unknown;
  /**
   * Server-authenticated session id recovered from a transport-owned channel
   * (for example a Cloudflare hibernatable WebSocket attachment). When the
   * in-memory SessionManager has been evicted, this id may be re-adopted.
   * Never populate this from an untrusted client hello payload.
   */
  recoverySessionId?: string;
  /**
   * Extra device broker configuration (RFC 001): bulk scheduling (64 KiB
   * turns, 256 KiB pending, 8 MiB queued by default), rates, revision
   * overrides. `ack` and the retained-bytes budget come from the handshake
   * and the host; the advertisement is the Rust broker's own (the one the
   * handshake selected against), never a per-session value.
   */
  deviceBrokerConfig?: Omit<DeviceBrokerConfig, "ack" | "serverCapabilities">;
  /** Device clock/timer seam driving the broker (tests inject a fake clock). */
  deviceClock?: DeviceClock;
  /**
   * Runs a bulk scheduling turn that is due now, after already-queued work
   * (RFC 001 §2.3: UI traffic first). Defaults to a macrotask; tests inject
   * a manual queue to step turns one at a time.
   */
  deviceDefer?: (fn: () => void) => void;
  /**
   * Overall deadline of the connection-owned `core.capabilities` stream.
   * The session reopens it (fresh snapshot, old stream retired first)
   * shortly before this expires. Defaults to the revision's 24 h maximum.
   */
  deviceControlStreamTimeoutMs?: number;
}

let nextSessionCounter = 1;

/**
 * One client's worth of server-side state. Transport-agnostic.
 */
export class RemoteSession {
  readonly id: string;
  readonly connectedAt: Date;

  private readonly host: SessionHost;
  private readonly transport: SessionTransport;
  private readonly socketHandle: unknown;
  private readonly recoverySessionId: string | undefined;

  readonly engine: BaseEngine;
  private _moduleInstance: HypenModuleInstance<any> | null = null;

  /**
   * Session-lifetime template lowering: remote clients of any version
   * receive plain patches only, so every batch captured from the engine
   * is expanded before it is sent. ONE expander spans both capture
   * points (initial-tree and streaming) — a `registerTemplate` consumed
   * while building the initial tree must satisfy `instantiate`s arriving
   * in later streamed batches.
   */
  private readonly templateExpander = new TemplateExpander();

  private _sessionId: string | null = null;
  private _helloReceived = false;
  /**
   * True when the session was initialised by the legacy `helloGrace` timer
   * rather than an explicit hello. Only then may a late hello negotiate the
   * device extension (RFC 001 §2.2); after an explicit hello the device
   * handshake — selected or disabled — is immutable for the socket.
   */
  private _initializedByGrace = false;
  /** `isNew` of the acknowledged session, repeated by a late device re-ack. */
  private _ackIsNew = true;
  private _stateSubscribed = false;
  private _revision = 0;
  private _destroyed = false;
  /**
   * Device Capability Protocol plane (RFC 001): the Rust broker of this
   * connection and its host driver, attached once the handshake selects a
   * common protocol. `null` when the device plane is disabled. Bound to this
   * one connection; closed on `destroy()` (broker loss == connection reset,
   * §2.5). The live capability selection (replaced by every
   * `core.capabilities` snapshot) lives in the broker.
   */
  private _deviceBroker: DevicePlane | null = null;
  /**
   * Server-issued resume credential for this session, issued in every ack.
   * Required on resume only for a session that negotiated a device plane.
   */
  private _resumeToken: string | null = null;
  private readonly deviceClock: DeviceClock;
  private readonly deviceDefer: ((fn: () => void) => void) | undefined;
  private readonly deviceControlStreamTimeoutMs: number | undefined;
  /** Extra broker configuration (tests inject small bounds / overrides). */
  private readonly deviceBrokerConfig: Omit<DeviceBrokerConfig, "ack" | "serverCapabilities"> | undefined;
  /**
   * The session's shared global context, constructed unconditionally so every
   * module instance — the primary included — always receives a handler
   * `context` (RFC 001 §6 Phase 2). The auto-wired ManagedRouter reuses it.
   */
  private readonly _globalContext = new HypenGlobalContext();
  /**
   * True once the hello handshake, primary-module construction and the
   * initial render have all completed — the point at which the engine's
   * declaration tables (routes, bindings, rendered paths) exist. Distinct
   * from `sessionId`, which is assigned earlier in `initializeSession`,
   * before `renderSource` has run; anything that consults the guard (the
   * agent surface's attach mode, for one) must gate on this, not on the id.
   * Never reset: `destroy()` is the exit, reported by `isDestroyed`.
   */
  private _ready = false;
  private helloTimeout: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-session ManagedRouter auto-wired from `Router {}` blocks found
   * in the primary template. `null` when auto-wiring is disabled, no
   * Routers are present, or no registered modules matched any route's
   * element list. Torn down alongside the session in `destroy()`.
   */
  private _autoManagedRouter: ManagedRouter | null = null;
  /**
   * Toggled by `RemoteServer.disableAutoRouter()` when the host wants
   * to wire a ManagedRouter by hand via `onSessionCreate` instead.
   */
  autoRouterEnabled: boolean = true;

  // Promises that let callers hook into session lifecycle without racing
  // against the hello handshake or the transport close event.
  //   `ready`  — resolves after the hello handshake, primary module
  //              construction, and initial render have completed.
  //              `moduleInstance` is guaranteed non-null here.
  //   `closed` — resolves after `destroy()` has finished its teardown
  //              (onDisconnect hook, module teardown, session suspend).
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private _resolveReady!: () => void;
  private _resolveClosed!: () => void;

  constructor(
    host: SessionHost,
    transport: SessionTransport,
    options: RemoteSessionOptions = {}
  ) {
    this.host = host;
    this.transport = transport;
    this.id = options.clientId ?? `client_${nextSessionCounter++}`;
    this.connectedAt = new Date();
    this.socketHandle = options.socketHandle;
    this.recoverySessionId = options.recoverySessionId;
    this.deviceBrokerConfig = options.deviceBrokerConfig;
    this.deviceClock = options.deviceClock ?? systemDeviceClock;
    this.deviceDefer = options.deviceDefer;
    this.deviceControlStreamTimeoutMs = options.deviceControlStreamTimeoutMs;

    this.ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
    this.closed = new Promise<void>((resolve) => {
      this._resolveClosed = resolve;
    });

    this.engine = host.createEngine();
    // init() is synchronous for wasm-node but declared async.
    this.engine.init().catch((err) => log.error("Engine init failed:", err));

    this.setupComponentResolver();
    if (Object.keys(host.resources).length > 0) {
      this.engine.registerResources(host.resources);
    }

    log.info(`Session ${this.id} created, engine initialized`);

    // Auto-initialise legacy clients that never send `hello`, whatever the
    // host's device support: a grace-initialised session simply has no
    // device plane (a late hello may still negotiate one, RFC 001 §2.2).
    const graceMs = options.helloGraceMs !== undefined ? options.helloGraceMs : 1000;
    if (graceMs !== null) {
      this.helloTimeout = setTimeout(() => {
        if (!this._helloReceived) {
          this._initializedByGrace = true;
          this.initializeSession(undefined, undefined).catch((err) =>
            log.error("Error initializing legacy session:", err)
          );
        }
      }, graceMs);
    } else {
      const timeoutMs = options.helloTimeoutMs ?? null;
      if (timeoutMs !== null) {
        this.helloTimeout = setTimeout(() => {
          this.helloTimeout = null;
          if (this._helloReceived || this._destroyed) return;
          log.warn(`Session ${this.id}: no hello within ${timeoutMs} ms — closing`);
          try {
            this.transport.close(1008, "hello timeout");
          } catch (err) {
            log.error(`Session ${this.id}: transport close failed`, err);
          }
        }, timeoutMs);
      }
    }
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Initialise a client that never sent `hello` (the legacy path) — what
   * the `helloGrace` timer does, for transports that drive it explicitly
   * (e.g. a Cloudflare DO whose first message is not a hello). `sessionId`
   * must come from a server-authenticated channel (the hibernation
   * attachment), never from client input. A later hello on such a session
   * may still negotiate the device extension (RFC 001 §2.2).
   */
  async initializeLegacy(sessionId?: string): Promise<void> {
    if (this._helloReceived || this._destroyed) return;
    this._initializedByGrace = true;
    await this.initializeSession(sessionId, undefined);
  }

  get moduleInstance(): HypenModuleInstance<any> | null {
    return this._moduleInstance;
  }

  get helloReceived(): boolean {
    return this._helloReceived;
  }

  get stateSubscribed(): boolean {
    return this._stateSubscribed;
  }

  get revision(): number {
    return this._revision;
  }

  get isDestroyed(): boolean {
    return this._destroyed;
  }

  /**
   * The device plane (Rust broker + driver) bound to this connection, or
   * null when disabled.
   */
  get deviceBroker(): DevicePlane | null {
    return this._deviceBroker;
  }

  /**
   * Feed a client → server binary device frame (RFC 001 §2.3). Transport
   * adapters call this for binary WebSocket frames; without a broker the
   * frame is dropped (device plane disabled, no storage allocated).
   */
  receiveBinary(frame: Uint8Array): void {
    if (this._destroyed) return;
    this._deviceBroker?.receiveFrame(frame);
  }

  /**
   * Admission for the device plane (RFC 001 §5 / Phase S). On by default:
   * the host must not have opted out, the transport must carry a device
   * route, the host must supply a broker, and `allow-multiple` must be off
   * (it fans one session out across connections, which device work must
   * never ride). `syncActions` is compatible: a dispatch replayed onto
   * another session runs with replay provenance (`runReplayed`), so its
   * `context.device` refuses with `unavailable` / `syncActions.replay`
   * (RFC 001 §1.7) — only the client that dispatched can start device work.
   */
  private deviceAdmitted(): boolean {
    if (this.host.deviceDisabled === true) return false;
    if (
      typeof this.transport.sendDevice !== "function" &&
      typeof this.transport.sendDeviceText !== "function"
    ) {
      return false;
    }
    const factory = this.host.deviceBrokerFactory;
    if (typeof factory !== "function") {
      // A UI-only host (no broker): nothing to negotiate.
      log.debug(`Session ${this.id}: device plane not offered — the host supplies no device broker`);
      return false;
    }
    if (typeof factory.negotiate !== "function") {
      // A factory without the (Rust) handshake cannot negotiate: fail closed.
      log.warn(`Session ${this.id}: device plane refused — the device broker factory has no negotiate()`);
      return false;
    }
    if (this.host.sessionManager.getConcurrentPolicy() === "allow-multiple") {
      log.warn(`Session ${this.id}: device plane refused — allow-multiple is on`);
      return false;
    }
    return true;
  }

  private deviceBudget(): number {
    return this.host.deviceMaxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
  }

  /**
   * Negotiate an untrusted `hello.device` (RFC 001 §2.2, decision D7)
   * through the host's broker port — the Rust handshake shared by every
   * server SDK: the §2.1 JSON limits and the handshake-v1 schema with
   * unique names are checked on the member's own RAW text when the hello
   * arrived as text (so duplicate keys and number spellings are judged as
   * sent), then the selection against the Rust broker's advertisement
   * (every registry revision it has a consuming API for). Invalid or
   * no common ground ⇒ `undefined`: the device plane is disabled for this
   * socket, UI-only operation continues.
   *
   * Nothing is negotiated unless this host admits the device plane at all:
   * a UI-only server never spends CPU on an extension it ignores. Pure (no
   * side effects), never throws.
   */
  private negotiateDevice(device: unknown, text: string | null): DeviceAck | undefined {
    if (device === undefined || !this.deviceAdmitted()) return undefined;
    try {
      let helloText: string;
      if (text !== null) {
        const member = findTopLevelMember(text, "device");
        if (!member.found) {
          log.warn(`Session ${this.id}: hello.device unreadable — device plane disabled`);
          return undefined;
        }
        helloText = member.raw;
      } else {
        // A pre-parsed hello: its value, as JSON text (never a JS string
        // handed over as if it were JSON text).
        const serialized = JSON.stringify(device);
        if (typeof serialized !== "string") return undefined;
        helloText = serialized;
      }
      // No advertisement of our own: the Rust handshake selects against
      // what the Rust broker consumes (`server_advertisement`).
      const outcome = this.host.deviceBrokerFactory!.negotiate(
        helloText,
        typeof this.transport.sendBinary === "function"
      );
      if (outcome.ack === null) {
        log.warn(`Session ${this.id}: ${outcome.reason} — device plane disabled`);
        return undefined;
      }
      return outcome.ack;
    } catch (err) {
      log.warn(`Session ${this.id}: device negotiation failed — device plane disabled`, err);
      return undefined;
    }
  }

  /**
   * Every live module instance on this connection: the primary plus the
   * auto-wired router's active and persisted (cached) route modules.
   */
  private liveModuleInstances(): HypenModuleInstance<any>[] {
    const out: HypenModuleInstance<any>[] = [];
    if (this._moduleInstance) out.push(this._moduleInstance);
    for (const instance of this._autoManagedRouter?.liveInstances() ?? []) {
      if (!out.includes(instance)) out.push(instance);
    }
    return out;
  }

  /**
   * Create the connection's broker (the Rust `DeviceBroker` through the
   * host's factory) BEFORE the `sessionAck` is sent: nothing reaches the wire
   * here. `null` when the host cannot build one — the caller then acks
   * WITHOUT `device`, so the client never holds an advertised device plane
   * that has no broker behind it (a device socket never survives
   * without its broker; the plane is simply not negotiated, §2.2).
   */
  private buildDevicePlane(ack: DeviceAck): DevicePlane | null {
    if (this._deviceBroker || this._destroyed) return null;
    const transport = this.transport;
    const budget = this.deviceBudget();
    // `serverCapabilities` is left to the broker (dropped even if an untyped
    // caller passed one): its default is the same Rust advertisement the
    // handshake selected against, so snapshots intersect with what was acked.
    const { serverCapabilities: _advertisement, ...extra } = (this.deviceBrokerConfig ?? {}) as Omit<DeviceBrokerConfig, "ack">;
    void _advertisement;
    const config: DeviceBrokerConfig = {
      ...extra,
      ack,
      maxRetainedBytes: budget,
      // Advertise only limits the host can honor (§2.4): a smaller retained
      // budget also caps every revision's item size.
      ...(budget < DEFAULT_MAX_RETAINED_BYTES ? { maxItemBytes: budget } : {}),
      ...(this.deviceControlStreamTimeoutMs !== undefined
        ? { controlStreamTimeoutMs: this.deviceControlStreamTimeoutMs }
        : {}),
    };
    let plane: DevicePlane;
    try {
      const port = this.host.deviceBrokerFactory!(config, Math.max(0, this.deviceClock.now()));
      plane = new DevicePlane(
        port,
        {
          sendText: (text) => {
            if (this._destroyed) return;
            if (transport.sendDeviceText) transport.sendDeviceText(text);
            // The broker only ever emits requests and events server → client.
            else transport.sendDevice!(JSON.parse(text) as DeviceOutgoing);
          },
          ...(typeof transport.sendBinary === "function"
            ? {
                sendFrame: (frame: Uint8Array) => {
                  if (this._destroyed) return;
                  transport.sendBinary!(frame);
                },
              }
            : {}),
          // Transport write capacity for bulk scheduling (§2.3).
          ...(transport.bufferedAmount ? { bufferedAmount: () => transport.bufferedAmount!() } : {}),
          // The broker closed the plane (repeated violations, core.capabilities
          // ended, id space exhausted): reset the socket.
          closeConnection: (code, reason) => {
            log.warn(`Session ${this.id}: ${reason} — closing`);
            this.closeDevicePlane(reason, code);
          },
        },
        {
          clock: this.deviceClock,
          ...(this.deviceDefer ? { defer: this.deviceDefer } : {}),
          binary: ack.binary,
          onError: (what, err) => log.error(`Session ${this.id}: ${what} failed:`, err),
        }
      );
    } catch (err) {
      log.error(`Session ${this.id}: device broker creation failed — device plane not negotiated`, err);
      return null;
    }
    return plane;
  }

  /**
   * Start a plane built by `buildDevicePlane`, AFTER the `sessionAck` that
   * carries its `device` member: opens the connection-owned
   * `core.capabilities` stream before any module callback can request device
   * work (§2.2), then binds every live module instance to it.
   */
  private startDevicePlane(plane: DevicePlane, ack: DeviceAck): void {
    if (this._destroyed || this._deviceBroker) {
      plane.close("connectionLost");
      return;
    }
    this._deviceBroker = plane;
    if (!plane.start()) {
      log.warn(`Session ${this.id}: core.capabilities could not open — device plane closed`);
      this.closeDevicePlane("device plane closed: core.capabilities unavailable");
      return;
    }
    // From now on a resume of this session must present its resume token
    // (RFC 001 §5): the public id alone never reaches a device session.
    if (this._sessionId) this.host.sessionManager.markDeviceSession(this._sessionId);
    for (const instance of this.liveModuleInstances()) instance.attachDevice(plane);
    log.info(
      `Session ${this.id}: device plane enabled (${ack.capabilities.map((c) => c.name).join(", ")})`
    );
  }

  /**
   * Close the device connection (RFC 001 §2.2/§2.5): reject all live device
   * work, detach every module instance, and reset the socket (1012) — a
   * device socket never survives without its broker, and the client
   * reconnects with a full advertisement.
   */
  private closeDevicePlane(reason: string, code = 1012): void {
    const plane = this._deviceBroker;
    if (!plane) return;
    this._deviceBroker = null;
    plane.close("connectionLost");
    for (const instance of this.liveModuleInstances()) instance.attachDevice(null);
    try {
      this.transport.close(code, reason.slice(0, 120));
    } catch (err) {
      log.error(`Session ${this.id}: transport close failed`, err);
    }
  }

  /** Late hello on an already-initialised session: negotiate + re-ack. */
  private lateDeviceHello(rawDevice: unknown, rawText: string | null): void {
    if (!this._initializedByGrace || rawDevice === undefined || this._deviceBroker || !this._sessionId) {
      return;
    }
    const selected = this.negotiateDevice(rawDevice, rawText);
    const plane = selected ? this.buildDevicePlane(selected) : null;
    const ack = plane ? selected : undefined;
    this.send({
      type: "sessionAck",
      sessionId: this._sessionId,
      // The re-ack describes the same session the legacy ack announced; it
      // never claims a resume the client did not get.
      isNew: this._ackIsNew,
      isRestored: false,
      ...(this._resumeToken ? { resumeToken: this._resumeToken } : {}),
      ...(ack ? { device: ack } : {}),
    });
    if (plane && ack) this.startDevicePlane(plane, ack);
  }

  /**
   * True once hello → initialTree has completed and the engine has
   * rendered. `ready` is the awaitable form; this is the synchronous check
   * for callers that must not wait (a lookup of an *existing* live session
   * has nothing to wait for — either it is ready now or it is not a match).
   * Note `ready` also resolves on a destroy-before-hello, so "`ready`
   * settled" is weaker than this flag.
   */
  get isReady(): boolean {
    return this._ready;
  }

  /**
   * The `RemoteClient` record surfaced to `onConnection`/`onDisconnection`
   * callbacks. Useful to construct consistently from both the Bun adapter
   * and custom transports.
   */
  toRemoteClient(): RemoteClient {
    return {
      id: this.id,
      socket: this.socketHandle,
      connectedAt: this.connectedAt,
    };
  }

  /**
   * Feed a client → server message into this session.
   *
   * Invoked by the transport adapter when it receives a message. Accepts
   * either a parsed `RemoteMessage` or a raw JSON string.
   */
  async receive(raw: RemoteMessage | string | Buffer): Promise<void> {
    if (this._destroyed) return;

    // `Buffer<ArrayBufferLike>`-as-narrowed-union doesn't reliably collapse
    // to `RemoteMessage` in the `else` branch under the current @types/node,
    // so we project the non-raw case through an explicit assertion.
    let msg: RemoteMessage;
    // Raw text is kept for device messages: their strict decode (RFC 001
    // §2.1 JSON limits) needs the text, which `JSON.parse` would normalize.
    let text: string | null = null;
    try {
      if (typeof raw === "string" || raw instanceof Buffer) {
        text = raw.toString();
        const plane = this._deviceBroker;
        if (plane) {
          // Device JSON limits start BEFORE parsing (§2.1): an over-limit
          // text that announces itself as a device message is dropped
          // unparsed — a connection-level violation, attributable to no
          // request.
          if (isOversizeDeviceText(text)) {
            plane.reportViolation("device message over 1 MiB");
            return;
          }
          // Device text is routed by its raw top-level `type` — never by
          // what `JSON.parse` makes of it — to the broker, which strictly
          // decodes EVERY device message type (a client `deviceRequest`
          // included): a JSON-limit breach (`NaN`, `1.0`, a duplicate key,
          // text `JSON.parse` rejects outright) counts against the
          // connection's violation budget, a known-id message in the wrong
          // direction or of the wrong shape terminates that request (D8),
          // an unknown id is ignored.
          if (isDeviceTypedText(text)) {
            plane.receiveText(text);
            return;
          }
        }
        msg = JSON.parse(text) as RemoteMessage;
      } else {
        msg = raw as RemoteMessage;
      }
    } catch (err) {
      log.error(`Invalid message on session ${this.id}:`, err);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;

    // Device plane (RFC 001): routed to the broker, never through the
    // action/state fan-out. Text messages on a live device connection were
    // routed above by their raw `type`; what reaches here is a pre-parsed
    // message from a custom transport (strictly decoded from its JSON form)
    // or device text for a connection without a plane (dropped). EVERY
    // device type goes to the broker — a client `deviceRequest` (which no
    // client may send) on a live id is a wrong-direction violation that
    // terminates that request (D8), on an unknown id it is ignored.
    const type = (msg as { type?: unknown }).type;
    if (type === "deviceRequest" || type === "deviceResponse" || type === "deviceEvent") {
      try {
        this._deviceBroker?.receiveText(text ?? JSON.stringify(msg));
      } catch (err) {
        log.error(`Error handling device message on session ${this.id}:`, err);
      }
      return;
    }

    try {
      switch (msg.type) {
        case "hello": {
          const hello = msg as HelloMessage;
          if (this._helloReceived) {
            // Late hello after the legacy grace path already initialised the
            // session (RFC 001 §2.2): accept the device extension and re-ack
            // without reinitialising app state. Never silently dropped.
            this.lateDeviceHello(hello.device, text);
            break;
          }
          // Everything in a hello is untrusted: shape-check it BEFORE any
          // initializeSession side effect. An invalid device extension
          // disables the device plane; it never throws mid-initialisation.
          await this.initializeSession(
            typeof hello.sessionId === "string" && hello.sessionId ? hello.sessionId : undefined,
            hello.props !== null && typeof hello.props === "object" && !Array.isArray(hello.props)
              ? hello.props
              : undefined,
            this.negotiateDevice(hello.device, text),
            typeof hello.resumeToken === "string" ? hello.resumeToken : undefined
          );
          break;
        }

        case "dispatchAction": {
          // Security admission (RFC 001 §5/Phase S): a socket that has not
          // completed the hello handshake may not dispatch — into this
          // session or, via syncActions, into anyone else's.
          if (!this._helloReceived) {
            log.warn(`Session ${this.id}: dispatchAction before hello — rejected`);
            break;
          }
          const action = msg as DispatchActionMessage;
          // Node ids are session-local. Resolve to an engine-validated scoped
          // handler before sending the semantic outcome to another session.
          const resolved = action.action === "__hypen_dispatch"
            ? this.engine.resolveUIAction(action.action, action.payload)
            : { name: action.action, payload: action.payload };
          this.engine.dispatchAction(resolved.name, resolved.payload);

          if (this.host.syncActions) {
            for (const other of this.host.otherSessions(this)) {
              if (!other._helloReceived) continue;
              // Replayed dispatch: handler contexts constructed inside carry
              // replay provenance, so context.device refuses to open requests
              // (RFC 001 §1.7) — the firewall at the dispatch layer.
              const dispatch = () =>
                other.engine.dispatchAction(resolved.name, resolved.payload);
              if (other._moduleInstance) other._moduleInstance.runReplayed(dispatch);
              else dispatch();
            }
          }
          break;
        }

        case "updateState": {
          if (!this._helloReceived) {
            log.warn(`Session ${this.id}: updateState before hello — rejected`);
            break;
          }
          const stateMsg = msg as UpdateStateMessage;
          this._moduleInstance?.updateState(stateMsg.state);

          if (this.host.syncActions) {
            for (const other of this.host.otherSessions(this)) {
              if (!other._helloReceived || !other._moduleInstance) continue;
              other._moduleInstance.updateState(stateMsg.state);
            }
          }
          break;
        }

        case "subscribeState": {
          this._stateSubscribed = true;
          log.info(`Session ${this.id} subscribed to state updates`);
          break;
        }

        default:
          // Unknown message type — ignore.
          break;
      }
    } catch (err) {
      log.error(`Error handling message on session ${this.id}:`, err);
    }
  }

  /**
   * Send an outgoing message through this session's transport. Exposed so
   * peer sessions can broadcast to each other (allow-multiple) without
   * touching transport internals.
   */
  send(message: OutgoingMessage): void {
    if (this._destroyed) return;
    try {
      this.transport.send(message);
    } catch (err) {
      log.error(`Failed to send message on session ${this.id}:`, err);
    }
  }

  /**
   * Close the transport WITHOUT expiring the session, so the client's
   * auto-reconnect resumes it (same session id → suspended state restored)
   * against freshly loaded code. Used by hot reload: re-rendering into a
   * live session leaves stale router-cached subtrees and broken reactive
   * wiring, so the reliable reload is a fast reconnect. Close code 1012 =
   * "service restart".
   */
  disconnectForReload(): void {
    this.transport.close(1012, "Hot reload");
  }

  /**
   * Notify the client their session is gone and close the transport.
   */
  expireAndClose(reason: "ttl" | "kicked" | "manual"): void {
    if (!this._sessionId) {
      this.transport.close(1000, "Session closed");
      return;
    }
    const expired: SessionExpiredMessage = {
      type: "sessionExpired",
      sessionId: this._sessionId,
      reason,
    };
    this.send(expired);
    this.transport.close(1000, "Session " + reason);
  }

  /**
   * Tear down the session. Call this from the transport adapter when the
   * underlying connection closes, or manually to evict a client.
   *
   * Runs `onDisconnect`, suspends the session so it can be resumed later,
   * and fires the host's `onSessionDestroyed` hook.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }

    const currentState = this._moduleInstance?.getState() ?? {};

    // onDisconnect hook
    if (this._sessionId && this.host.module.handlers.onDisconnect) {
      const session = this.host.sessionManager.getActiveSession(this._sessionId);
      if (session) {
        try {
          await this.host.module.handlers.onDisconnect({
            state: currentState,
            session,
          });
        } catch (err) {
          log.error(`onDisconnect threw on session ${this.id}:`, err);
        }
      }
    }

    // Suspend session if no other connections remain for it
    if (this._sessionId) {
      this.host.sessionManager.untrackConnection(this._sessionId, this);
      if (this.host.sessionManager.getConnectionCount(this._sessionId) === 0) {
        const session = this.host.sessionManager.getActiveSession(
          this._sessionId
        );
        if (session) {
          this.host.sessionManager.suspendSession(
            this._sessionId,
            currentState,
            async (expiredSession) => {
              if (this.host.module.handlers.onExpire) {
                await this.host.module.handlers.onExpire({
                  session: expiredSession,
                });
              }
            }
          );
        }
      }
    }

    // Device broker teardown BEFORE module teardown: loss of broker state is a
    // connection reset (RFC 001 §2.5). Rejects all in-flight device work
    // locally with connectionLost; no cancellation is sent (socket is going).
    if (this._deviceBroker) {
      const plane = this._deviceBroker;
      this._deviceBroker = null;
      plane.close("connectionLost");
    }

    if (this._autoManagedRouter) {
      try {
        await this._autoManagedRouter.stop();
      } catch (err) {
        log.error(`Auto-router stop failed on ${this.id}:`, err);
      }
      this._autoManagedRouter = null;
    }

    if (this._moduleInstance) {
      try {
        await this._moduleInstance.destroy();
      } catch (err) {
        log.error(`ModuleInstance.destroy() failed on ${this.id}:`, err);
      }
    }

    this.host.onSessionDestroyed(this, this.toRemoteClient());
    // Ensure `ready` never dangles: if teardown happens before init (e.g.
    // transport dies before hello arrives), unblock any waiter so they can
    // observe `closed` and clean up without deadlocking.
    this._resolveReady();
    this._resolveClosed();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private setupComponentResolver(): void {
    this.engine.setComponentResolver((componentName, _contextPath) => {
      const comp = this.host.discoveredComponents.get(componentName);
      if (comp) return { source: comp.template, path: componentName };
      // Server-based apps register modules programmatically with inline
      // `.ui()` templates and never populate `discoveredComponents`, so
      // fall back to the HypenApp registry. Without this, a template
      // referencing `Home()` renders an opaque Create the renderer drops.
      const registered = this.host.app?.get(componentName);
      if (registered?.template) {
        return { source: registered.template, path: componentName };
      }
      return null;
    });
  }

  private registerNestedModules(): void {
    const primary = this.host.moduleName;
    const registered: string[] = [];

    if (this.host.app) {
      for (const [name, def] of this.host.app.components) {
        if (name === primary) continue;
        const stateKeys =
          def.initialState !== null && typeof def.initialState === "object"
            ? Object.keys(def.initialState as object)
            : [];
        const snapshot =
          def.initialState !== null && typeof def.initialState === "object"
            ? structuredClone(def.initialState)
            : {};
        this.engine.registerModule(
          name,
          def.actions ?? [],
          stateKeys,
          snapshot
        );
        log.debug(
          `Registered nested module "${name}" (${def.actions?.length ?? 0} actions, ${stateKeys.length} state keys)`
        );
        registered.push(name);
      }
    }

    for (const [name, comp] of this.host.discoveredComponents) {
      if (name === primary) continue;
      if (!comp.module) continue;
      if (this.host.app?.has(name)) continue;

      const def = comp.module;

      // Skip pure UI components (no state, no actions, no lifecycle).
      // `loadDiscoveredComponents` creates an auto-stateless module
      // (`app.defineState({}).build()`) for every .hypen file without a
      // sidecar .ts, which means pure UI components like Notifications,
      // Profile, Messages, BottomNav, Feed, etc. all get registered as
      // nested modules. That registration doesn't shadow unscoped
      // `@state.x` bindings (those still hit the primary module), but
      // it does occupy a scope slot the engine may otherwise route
      // dependency updates through — and every extra module carries
      // revision bookkeeping overhead per render. When the module has
      // no state and no actions, registering it is pure noise.
      const hasState =
        def.initialState !== null &&
        typeof def.initialState === "object" &&
        Object.keys(def.initialState as object).length > 0;
      const hasActions = (def.actions?.length ?? 0) > 0;
      if (!hasState && !hasActions) continue;

      const stateKeys =
        def.initialState !== null && typeof def.initialState === "object"
          ? Object.keys(def.initialState as object)
          : [];
      const snapshot =
        def.initialState !== null && typeof def.initialState === "object"
          ? JSON.parse(JSON.stringify(def.initialState))
          : {};
      this.engine.registerModule(name, def.actions ?? [], stateKeys, snapshot);
      log.debug(`Registered nested module "${name}" from discovery`);
      registered.push(name);
    }

    // One line per session instead of one per module, and only the
    // modules an app author actually wrote — framework builtins
    // (`__Router`, `__Route`, `__Link`, ...) self-register in the shared
    // app registry on import and are pure noise at info level; the
    // per-module lines above remain available under debug logging.
    const visible = registered.filter((name) => !name.startsWith("__"));
    if (visible.length > 0) {
      log.info(
        `Registered ${visible.length} nested module${visible.length === 1 ? "" : "s"}: ${visible.join(", ")}`
      );
    }
  }

  private async initializeSession(
    requestedSessionId: string | undefined,
    props: Record<string, any> | undefined,
    deviceAck?: DeviceAck,
    resumeToken?: string
  ): Promise<void> {
    if (this._helloReceived || this._destroyed) return;
    // `deviceAck` is the handshake selection (RFC 001 §2.2), negotiated
    // before any side effect: a negotiation failure only disables the
    // device plane.
    this._helloReceived = true;
    log.info(
      `Initializing session for ${this.id} (sessionId: ${requestedSessionId ?? "new"})`
    );

    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }

    let session: Session;
    let isNew = true;
    let isRestored = false;
    let restoredState: unknown = null;

    const sm = this.host.sessionManager;

    // Resume credential (RFC 001 §5 / Phase S): the public session id alone
    // never resumes (or, under kick-old, takes over) a session that
    // negotiated a device plane — the hello must also present the
    // server-issued resume token. A missing/mismatched token is a NEW
    // session, never an error or a hijack. A UI-only session keeps the
    // legacy id-only resume. The transport-owned recovery id (Cloudflare
    // hibernation attachment) is server-authenticated and needs no token.
    if (
      requestedSessionId &&
      sm.requiresResumeToken(requestedSessionId) &&
      requestedSessionId !== this.recoverySessionId &&
      !sm.verifyResumeToken(requestedSessionId, resumeToken)
    ) {
      log.info(`Session ${this.id}: resume of ${requestedSessionId} without a valid resume token — new session`);
      requestedSessionId = undefined;
    }

    if (requestedSessionId) {
      const resumed = sm.resumeSession(requestedSessionId);
      if (resumed) {
        session = resumed.session;
        restoredState = resumed.savedState;
        isNew = false;
        isRestored = true;
      } else {
        const activeSession = sm.getActiveSession(requestedSessionId);
        if (activeSession) {
          const allowed = this.resolveConcurrentConnection(
            activeSession,
            props
          );
          if (!allowed) return;
          session = activeSession;
          isNew = false;
        } else if (requestedSessionId === this.recoverySessionId) {
          // A hibernated host has lost its in-memory SessionManager, but the
          // transport still carries the server-issued id. Re-adopt that id so
          // session-keyed module persistence resolves the same storage key.
          session = sm.recoverSession(requestedSessionId, props);
          isNew = false;
          isRestored = true;
        } else {
          session = sm.createSession(props);
        }
      }
    } else {
      session = sm.createSession(props);
    }

    this._sessionId = session.id;
    this._ackIsNew = isNew;
    sm.trackConnection(session.id, this);
    // A fresh resume credential per acknowledged connection (rotated on
    // every resume; the previous one stops working). Always issued; it is
    // required on resume only once the session negotiated a device plane.
    this._resumeToken = sm.issueResumeToken(session.id);

    // The broker is built before the ack is sent: `device` is only
    // acknowledged when a broker actually stands behind it.
    const devicePlane = deviceAck ? this.buildDevicePlane(deviceAck) : null;
    const ackedDevice = devicePlane ? deviceAck : undefined;
    const sessionAck: SessionAckMessage = {
      type: "sessionAck",
      sessionId: session.id,
      isNew,
      isRestored,
      ...(this._resumeToken ? { resumeToken: this._resumeToken } : {}),
      ...(ackedDevice ? { device: ackedDevice } : {}),
    };
    try {
      this.send(sessionAck);
      log.info(`Sent sessionAck to ${this.id} (session: ${session.id})`);

      // Create ModuleInstance HERE (not in constructor) so that onCreated fires
      // right before renderSource. See original server.ts comment for why.
      if (!this._moduleInstance) {
        this._moduleInstance = new HypenModuleInstance(
          this.engine,
          this.host.module,
          undefined,
          this._globalContext,
          session.id
        );
        this._globalContext.registerModule(
          this.host.moduleName.toLowerCase(),
          this._moduleInstance
        );
      }
    } catch (err) {
      // The built-but-unstarted broker owns WASM memory: release it.
      devicePlane?.close("connectionLost");
      throw err;
    }

    if (devicePlane && ackedDevice) this.startDevicePlane(devicePlane, ackedDevice);

    if (isRestored) {
      await this.triggerReconnect(session, restoredState);
    }

    await this._moduleInstance.waitForReady();

    this.registerNestedModules();

    // Flush state proxy microtasks so onCreated mutations propagate.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Capture initial render patches (initial tree + any re-render from onCreated state).
    // `batchAnimation` preludes are dropped: a stamp scopes exactly ONE batch
    // (first-patch contract), and concatenating accumulated batches into a
    // single initialTree array would let a stray prelude over-scope onto
    // patches from other batches — the initial tree never animates anyway.
    const initialPatches: Patch[] = [];
    this.engine.setRenderCallback((patches) => {
      initialPatches.push(
        ...this.templateExpander
          .expand(patches)
          .filter((p) => p.type !== "batchAnimation")
      );
    });

    try {
      this.engine.renderSource(this.host.ui);
    } catch (err) {
      log.error(`Failed to render UI for ${this.id}:`, err);
      this.transport.close(1011, "Render failed");
      return;
    }

    // Switch to the streaming callback for subsequent patches.
    this.setupStreamingRenderCallback();

    const initialMessage: InitialTreeMessage = {
      type: "initialTree",
      module: this.host.moduleName,
      state: this._moduleInstance.getState(),
      patches: initialPatches,
      revision: 0,
    };
    this.send(initialMessage);
    log.info(
      `Sent initialTree to ${this.id} (${initialPatches.length} patches)`
    );

    this.host.onSessionReady(this, this.toRemoteClient());
    this._ready = true;
    this._resolveReady();

    // Activate the primary module so single-screen apps have a live
    // activation authority for device work (RFC 001 §6 Phase 2). Under
    // ManagedRouter, route modules are activated by the router as usual.
    // (The core.capabilities stream already opened in startDevicePlane, before
    // this or any other module callback can request device work.)
    try {
      await this._moduleInstance.activate();
    } catch (err) {
      log.error(`Primary module activate() failed on ${this.id}:`, err);
    }

    // Auto-wire a ManagedRouter from the template's own Router {} blocks.
    // The user gets routing "for free" from the DSL — no addRoute calls
    // in their server code. Guarded by `_autoRouterEnabled` so callers
    // that want bespoke wiring can opt out via
    // `RemoteServer.disableAutoRouter()`.
    if (this.autoRouterEnabled) {
      this.autoWireManagedRouter();
    }
  }

  /**
   * Parse Router {} blocks out of the primary template and spin up a
   * per-session ManagedRouter bound to the shared engine, auto-adding
   * one route per Route() — components resolved from the HypenApp
   * registry. The primary module's `location` field (if present) is
   * kept in sync with the router path so the Router IR re-renders on
   * navigation.
   *
   * Both top-level routers (`moduleScope` = primary / unscoped) and
   * routers nested inside per-route module templates are registered
   * here, flattened into a single route table against the session's
   * `HypenRouter`. The URL is a single string, so nested-router routes
   * share the parent's URL space — authors who want sub-path semantics
   * must spell out the full prefix in their `Route(path: ...)`. On
   * pattern conflicts (multiple routes matching the same path),
   * `ManagedRouter` picks first-match, and the engine emits routers
   * in outer→inner order so primary routes win ties naturally.
   */
  private autoWireManagedRouter(): void {
    // A registry is only needed to resolve component-backed routes; inline
    // routes (`Route(path) { ...markup... }`) need none. Fall back to an empty
    // registry so a single-module app with an inline `Router {}` still gets its
    // `@router.push` handler + `state.location` mirror wired.
    const app = this.host.app ?? new HypenAppClass();

    // Collect router blocks from both the primary template AND every
    // discovered child component template. `discoverRouters` walks a
    // single IR tree and does not resolve `Foo()` component references
    // — child templates live in separate source strings in
    // `host.discoveredComponents`. Running discover on each separately
    // and concatenating (primary first) gives us the true cross-tree
    // router inventory. Without this pass, a nested `module Home {
    // Router { ... } }` block declared in `Home/component.hypen`
    // (the canonical `.source()`-discovery shape) is silently
    // invisible to the SDK and the route never mounts.
    const discovered: ReturnType<BaseEngine["discoverRouters"]> = [];
    const runDiscover = (source: string, label: string): void => {
      try {
        const blocks = this.engine.discoverRouters(source);
        for (const b of blocks) discovered.push(b);
      } catch (err) {
        log.error(`Auto-router: discoverRouters failed on ${label}:`, err);
      }
    };
    runDiscover(this.host.ui, this.id);
    for (const [name, comp] of this.host.discoveredComponents) {
      if (comp.template) runDiscover(comp.template, `${this.id} / ${name}`);
    }
    // Server-based apps carry child templates in the HypenApp registry
    // (`.module("Name").ui(...)`) instead of `discoveredComponents` —
    // scan those too so their nested Router blocks mount.
    if (this.host.app) {
      for (const [name, def] of this.host.app.components) {
        if (name === this.host.moduleName) continue;
        if (this.host.discoveredComponents.has(name)) continue;
        if (def.template) runDiscover(def.template, `${this.id} / ${name}`);
      }
    }
    if (discovered.length === 0) return;

    // Build a single top-level ManagedRouter covering every route from
    // every discovered router block (primary AND nested). Multiple
    // `Router {}` blocks flatten into one route list — the engine's
    // own Router IR still renders them independently, but the SDK only
    // needs a single `HypenRouter` per session.
    const router = new HypenRouter();
    // Reuse the session's shared global context (the primary module is
    // already registered in it) rather than minting a second one.
    const globalContext = this._globalContext;
    const managed = new ManagedRouter(router, this.engine, app, globalContext, {
      // Routed modules share this connection's device broker (RFC 001 §2.7):
      // each owns its own instance id / activations, swept by its lifecycle.
      onModuleCreated: (instance) => {
        if (this._deviceBroker) instance.attachDevice(this._deviceBroker);
      },
    });
    const primary = this._moduleInstance;

    let added = 0;
    const seenPaths = new Set<string>();
    for (const block of discovered) {
      for (const route of block.routes) {
        // First path wins — outer Router blocks emit first.
        if (seenPaths.has(route.path)) {
          log.debug(
            `Auto-router: path "${route.path}" already registered; ignoring nested duplicate`
          );
          continue;
        }
        const component = this.pickComponent(route.elementNames);
        if (!component) {
          log.debug(
            `Auto-router: no registered module matched route "${route.path}" — skipping`
          );
          continue;
        }
        managed.addRoute({ path: route.path, component });
        seenPaths.add(route.path);
        added += 1;
      }
    }

    // `added` counts component-backed routes (mounted via ManagedRouter).
    // Routes can also be fully INLINE — `Route(path: "/x") { ...markup... }`
    // with no component — in which case the engine's own Router IR renders
    // them straight from `state.location`, and there's nothing for
    // ManagedRouter to mount. We still need the URL→`location` mirror and the
    // `@router.push` action handler so navigation works. So: bail only if no
    // Router blocks were discovered at all; otherwise wire the router even
    // when `added === 0`.
    const locationKey = this.primaryHasLocationKey() ? "location" : null;
    if (added === 0 && !locationKey) {
      // No component routes and no `location` state to drive inline routes —
      // nothing this router could affect.
      log.debug(`Auto-router: nothing to mount for ${this.id}`);
      return;
    }

    // Mirror router path into primary module state's `location` so the
    // engine-level Router IR reconciles to the matching Route subtree.
    // Deferring via `queueMicrotask` keeps the engine write off the
    // synchronous notify path (Rust rejects re-entrant WASM state
    // proxy calls).
    if (locationKey) {
      // Persistence is loaded before auto-wiring. Seed the windowless router
      // from that restored location before any subscribers are attached;
      // otherwise its default `/` is immediately mirrored back into state
      // and a hibernation wake silently replaces the restored detail route
      // with Home before the triggering action runs.
      const restoredLocation = (
        primary?.getState() as Record<string, unknown> | undefined
      )?.[locationKey];
      if (typeof restoredLocation === "string" && restoredLocation) {
        router.replace(restoredLocation);
      }

      router.onNavigate((rs) => {
        const path = rs.currentPath;
        queueMicrotask(() => {
          try {
            const state = this._moduleInstance?.getState() as
              | Record<string, unknown>
              | undefined;
            // Skip when already in sync — this mirror and the state →
            // router one below would otherwise ping-pong.
            if (state?.[locationKey] === path) return;
            this._moduleInstance?.updateState({ [locationKey]: path });
          } catch (err) {
            log.error(`Auto-router: state.${locationKey} sync failed:`, err);
          }
        });
      });

      // Mirror the other direction too: templates commonly navigate by
      // mutating `state.location` from a module action (the scaffold's
      // `@actions.navigate`). The engine's Router IR follows that state
      // directly, but module mount/unmount and per-route action handlers
      // follow the HypenRouter — without this push, navigating via a state
      // mutation renders the new route while its module (and thus its
      // actions) never activates.
      if (primary) {
        primary.onStateChange(() => {
          try {
            const loc = (primary.getState() as Record<string, unknown>)?.[
              locationKey
            ];
            if (typeof loc === "string" && loc && loc !== router.getCurrentPath()) {
              router.push(loc);
            }
          } catch (err) {
            log.error(`Auto-router: ${locationKey} → router sync failed:`, err);
          }
        });
      }
    }

    // `start()` installs the `@router.push`/`@router.back`/... action handlers
    // and subscribes the router. Needed for both component and inline routes.
    // Published before `start()` mounts the first route, so a late device
    // hello racing initialisation still reaches every routed instance.
    this._autoManagedRouter = managed;
    managed.start();
    // HypenRouter doesn't fire onNavigate on subscribe; kick an
    // explicit push so the initial route mounts.
    router.push(router.getCurrentPath());
  }

  /** Pick the first element name that resolves to a registered module. */
  private pickComponent(elementNames: string[]): string | null {
    const app = this.host.app;
    if (!app) return null;
    for (const name of elementNames) {
      if (app.has(name)) return name;
    }
    return null;
  }

  /** Does the primary module's initial state have a `location` field? */
  private primaryHasLocationKey(): boolean {
    const state = this._moduleInstance?.getState();
    return (
      state !== null &&
      state !== undefined &&
      typeof state === "object" &&
      "location" in state
    );
  }

  private setupStreamingRenderCallback(): void {
    this.engine.setRenderCallback((patches) => {
      if (this._destroyed) return;
      // Lower template patches ONCE, before the message object is built —
      // the same patchMessage fans out to allow-multiple peers below.
      patches = this.templateExpander.expand(patches);
      this._revision++;
      log.info(
        `Streaming ${patches.length} patches to ${this.id} (rev ${this._revision})`
      );

      const patchMessage: PatchMessage = {
        type: "patch",
        module: this.host.moduleName,
        patches,
        revision: this._revision,
      };
      this.send(patchMessage);

      if (this._stateSubscribed && this._moduleInstance) {
        const stateMessage: StateUpdateMessage = {
          type: "stateUpdate",
          module: this.host.moduleName,
          state: this._moduleInstance.getState(),
          revision: this._revision,
        };
        this.send(stateMessage);
      }

      // allow-multiple: fan out to other sessions sharing our sessionId.
      if (
        this._sessionId &&
        this.host.sessionManager.getConcurrentPolicy() === "allow-multiple"
      ) {
        for (const peer of this.host.sessionsForId(this._sessionId)) {
          if (peer === this) continue;
          peer.send(patchMessage);
          if (peer._stateSubscribed && this._moduleInstance) {
            const stateMessage: StateUpdateMessage = {
              type: "stateUpdate",
              module: this.host.moduleName,
              state: this._moduleInstance.getState(),
              revision: this._revision,
            };
            peer.send(stateMessage);
          }
        }
      }
    });
  }

  private resolveConcurrentConnection(
    existingSession: Session,
    _props: Record<string, any> | undefined
  ): boolean {
    const policy = this.host.sessionManager.getConcurrentPolicy();

    switch (policy) {
      case "kick-old": {
        for (const peer of this.host.sessionsForId(existingSession.id)) {
          if (peer === this) continue;
          peer.expireAndClose("kicked");
        }
        return true;
      }
      case "reject-new": {
        this.expireAndClose("kicked");
        return false;
      }
      case "allow-multiple":
      default:
        return true;
    }
  }

  private async triggerReconnect(
    session: Session,
    savedState: unknown
  ): Promise<void> {
    const handler = this.host.module.handlers.onReconnect;
    if (!handler) {
      // No handler: restore the suspended state automatically — resuming a
      // session and then discarding the state it was suspended with would
      // make resume a no-op. Defining `onReconnect` takes over the
      // decision (call `restore()` yourself, or don't).
      if (savedState !== null && typeof savedState === "object") {
        this._moduleInstance?.updateState(
          savedState as Record<string, unknown>
        );
      }
      return;
    }

    const restore = (state: unknown) => {
      if (state === null || typeof state !== "object") {
        log.warn(
          "restore() called with non-object state, ignoring:",
          typeof state
        );
        return;
      }
      this._moduleInstance?.updateState(state as Record<string, unknown>);
    };

    await handler({ session, restore });
    // `savedState` is threaded through for handlers that don't call restore().
    void savedState;
  }
}

// ---------------------------------------------------------------------------
// Built-in transports
// ---------------------------------------------------------------------------

/**
 * Wrap a Bun `ServerWebSocket` as a `SessionTransport`.
 *
 * Each outgoing message is JSON-serialized. The caller is responsible for
 * calling `session.receive()` on incoming messages and `session.destroy()`
 * on close.
 */
export function createBunWebSocketTransport(
  ws: {
    /**
     * Bun `ServerWebSocket.send`: bytes written, `-1` when queued under
     * backpressure, `0` when the message was DROPPED (past Bun's
     * backpressure limit, or the socket is closing).
     */
    send(data: string | Uint8Array): number | void;
    close(code?: number, reason?: string): void;
    /** Bun `ServerWebSocket.getBufferedAmount()`. */
    getBufferedAmount?(): number;
  }
): SessionTransport {
  // A dropped message (UI patch, device control, lease or cancel) must never
  // vanish silently: the connection is closed instead (RFC 001 §2.3 "slow
  // receivers cannot cause unbounded queues … otherwise close the
  // connection"), and the client reconnects with a full state.
  let closedForBackpressure = false;
  const write = (data: string | Uint8Array) => {
    if (closedForBackpressure) return;
    const r = ws.send(data);
    if (r === 0) {
      closedForBackpressure = true;
      log.warn("WebSocket send dropped (backpressure limit) — closing the connection");
      try {
        ws.close(1013, "send buffer overflow");
      } catch {
        /* already closing */
      }
    }
  };
  return {
    send(message) {
      write(JSON.stringify(message));
    },
    // Transport write capacity for the device bulk scheduler (§2.3).
    ...(typeof ws.getBufferedAmount === "function"
      ? { bufferedAmount: () => ws.getBufferedAmount!() }
      : {}),
    // Device plane (RFC 001): its own route, never through `send`.
    sendDevice(message) {
      write(JSON.stringify(message));
    },
    sendDeviceText(text) {
      write(text);
    },
    sendBinary(frame) {
      write(frame);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

/**
 * In-memory transport that buffers outgoing messages and exposes them as
 * an async iterator via `.stream()`. Lets you drive a session from code
 * that prefers `for await` over callbacks — e.g. piping to SSE, HTTP/2
 * server push, or gRPC streaming.
 *
 * @example
 * ```ts
 * const transport = new AsyncQueueTransport();
 * const session = server.createSession(transport);
 * for await (const msg of transport.stream()) {
 *   res.write(`data: ${JSON.stringify(msg)}\n\n`); // SSE
 * }
 * ```
 */
export class AsyncQueueTransport implements SessionTransport {
  private queue: OutgoingMessage[] = [];
  private waiters: Array<
    (value: IteratorResult<OutgoingMessage, void>) => void
  > = [];
  private closed = false;

  send(message: OutgoingMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined, done: true });
    }
  }

  /**
   * Async iterator over outgoing messages. Completes once the transport is
   * closed and the queue is drained.
   */
  stream(): AsyncIterableIterator<OutgoingMessage> {
    const self = this;
    const iter: AsyncIterableIterator<OutgoingMessage> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next(): Promise<IteratorResult<OutgoingMessage, void>> {
        if (self.queue.length) {
          return { value: self.queue.shift()!, done: false };
        }
        if (self.closed) {
          return { value: undefined, done: true };
        }
        return new Promise((resolve) => {
          self.waiters.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<OutgoingMessage, void>> {
        self.close();
        return { value: undefined, done: true };
      },
    };
    return iter;
  }
}
