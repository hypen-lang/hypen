/**
 * HypenDurableObject — base class for running Hypen apps inside Cloudflare
 * Durable Objects with Hibernation WebSocket support.
 *
 * A thin host around `RemoteSession` (in `@hypen-space/core`), which owns the
 * remote protocol, nested-module registration, resources, and router
 * auto-wiring. This class provides only the Cloudflare-specific parts: the WS
 * upgrade + Hibernation acceptance, the `CFTransport`, and per-DO storage
 * binding. Subclasses implement `getConfig()` and `createEngine()`.
 *
 * Hibernation: the runtime can evict the DO (and all in-memory sessions)
 * between messages while the socket stays alive at the edge. `ensureSession`
 * lazily rebuilds on the next message; since the client won't re-send `hello`,
 * a non-hello first message synthesises one so the initial tree is re-sent
 * before the message is processed.
 *
 * Device plane (RFC 001 §2.5): hibernation restoration applies to UI-only
 * sockets. A socket that negotiated the device plane carries a
 * `deviceEnabled` marker in its hibernation attachment (written before the
 * negotiating `sessionAck` leaves); when such a socket wakes with no live
 * in-memory broker it is closed with 1012 before any message is processed —
 * never re-helloed, never given a rebuilt broker.
 *
 * Hibernation vs leases: while a socket has a live device plane its
 * connection-owned `core.capabilities` stream renews its lease every 5 s
 * (RFC 001 §2.7), and those interval timers keep the DO resident — a
 * DO does not hibernate while a device plane is live. That is
 * deliberate (hibernating would lose the broker, i.e. reset the connection,
 * §2.5); UI-only sockets on the same DO keep hibernating normally once no
 * device plane is live. Budget for it in DO duration billing.
 *
 * The device plane is on by default (`device: false` opts out); it needs the
 * device-broker WASM (`deviceWasm`, supplied automatically by
 * `defineHypenWorker`) and is off — with one warning — when that is missing.
 * `syncActions` keeps it on (a replayed dispatch's `context.device` refuses
 * with `syncActions.replay`), and so does `webSocketCompression: true`:
 * compression is judged per socket — a socket whose permessage-deflate has
 * no context takeover in both directions keeps its device plane, any other
 * compressed socket stays UI-only (RFC 001 §2.3).
 *
 * Admission (RFC 001 §5, decision D1), enforced exactly when configured: with
 * `allowedOrigins` set, an upgrade's `Origin` must be listed and one without
 * (native iOS/Android clients) is admitted only by `authenticate` (none ⇒
 * 403); a configured `authenticate` runs for every upgrade. With neither,
 * every client is admitted and one warning is logged.
 */

import type { HypenApp, HypenModule, HypenModuleDefinition } from "@hypen-space/core/app";
import { createLogger } from "@hypen-space/core/logger";
import type { BaseEngine } from "@hypen-space/core/engine-base";
import type { RemoteClient, RemoteMessage } from "@hypen-space/core/remote";
import {
  RemoteSession,
  SessionManager,
  deflateContextPolicy,
  parseWebSocketExtensions,
  type SessionHost,
  type SessionTransport,
  type OutgoingMessage,
} from "@hypen-space/core/remote";
import {
  DO_AGGREGATE_RETAINED_BYTES,
  DO_MAX_RETAINED_BYTES,
  isOversizeDeviceText,
} from "@hypen-space/core/remote/device";
import type { DurableObjectStorage, DurableObjectStateStore } from "./durable-object-store.js";
import {
  createCFDeviceBrokerFactory,
  hasDeviceBroker,
  type CFDeviceWasmExports,
} from "./device-broker.js";

const log = createLogger("HypenDurableObject");

/** Logged once per Durable Object when the upgrade admits every client. */
export const OPEN_ADMISSION_WARNING =
  "no allowedOrigins/authenticate configured — any client can connect; set them in production";

// Minimal Cloudflare type stubs — shadowed at runtime by `cloudflare:workers`
// (which only resolves inside wrangler).

/** Minimal stub for Cloudflare's DurableObjectState */
export interface DurableObjectState {
  storage: DurableObjectStorage;
  /** Accept a WebSocket for the Hibernation API */
  acceptWebSocket(ws: WebSocket): void;
  /** Get all accepted WebSockets (survives hibernation) */
  getWebSockets(): WebSocket[];
}

// workerd provides `WebSocketPair` at runtime. We avoid `declare global` (a
// consumer also pulling in `@cloudflare/workers-types` would hit a
// duplicate-declaration error) and cast locally instead.
type WebSocketPairCtor = { new (): { 0: WebSocket; 1: WebSocket } };

/**
 * Data carried on a hibernatable socket across a DO eviction.
 *
 * - `hypenSessionId` — lets a UI-only socket RESUME its session on wake.
 * - `deviceEnabled` — set (before the ack is sent) once this socket
 *   negotiated the device plane. On wake a marked socket without its live
 *   broker is reset with 1012 (RFC 001 §2.5) instead of being restored.
 */
export type HibernationAttachment = {
  hypenSessionId?: string;
  deviceEnabled?: true;
  /**
   * Set when this socket negotiated permessage-deflate WITH context takeover
   * in either direction (or, with `webSocketCompression: true`, when its
   * negotiation could not be observed and the client offered DEFLATE): the
   * device plane is never admitted on it (RFC 001 §2.3). Per-message
   * compression (both no-context-takeover params) is not marked.
   */
  compressed?: true;
};

/**
 * Per-connection retained device upload bytes in a Durable Object: one
 * 128 MB isolate is shared by every session in the DO, so the budget (and
 * the per-item cap the DO honors) is 16 MiB rather than the Node default of
 * 128 MiB (RFC 001 §2.4 "advertise only limits they can honor", §5).
 */
export const DO_DEVICE_MAX_RETAINED_BYTES = DO_MAX_RETAINED_BYTES;
/**
 * Aggregate retained device upload bytes across every connection of one DO
 * (its sockets share one isolate, and the routing key is client-chosen, so
 * any number of connections can land in one DO): three full per-connection
 * budgets at most.
 */
export const DO_DEVICE_AGGREGATE_RETAINED_BYTES = DO_AGGREGATE_RETAINED_BYTES;

/** The socket's negotiated `Sec-WebSocket-Extensions`, if the runtime reports it. */
function negotiatedExtensions(ws: WebSocket): string | undefined {
  const ext = (ws as unknown as { extensions?: unknown }).extensions;
  return typeof ext === "string" ? ext : undefined;
}

/**
 * Whether a socket's reported negotiation is permessage-deflate WITH context
 * takeover in either direction (RFC 001 §2.3) — the only compression the
 * device plane refuses. Uncompressed, or per-message (both
 * no-context-takeover params), is fine.
 */
function contextTakeoverDeflate(ws: WebSocket): boolean {
  return deflateContextPolicy(negotiatedExtensions(ws)) === "context-takeover";
}

/** Whether an upgrade request's `Sec-WebSocket-Extensions` offers any DEFLATE. */
function offersDeflate(request: Request): boolean {
  const offer = request.headers.get("Sec-WebSocket-Extensions");
  if (offer === null || offer.trim() === "") return false;
  const parsed = parseWebSocketExtensions(offer);
  // Unparseable: fail closed (assume it may have negotiated DEFLATE).
  if (parsed === null) return true;
  return parsed.some((e) => e.name.includes("deflate") || e.name.includes("compress"));
}

/** Close code + reason for a surviving socket whose device broker is gone. */
export const DEVICE_BROKER_LOST_CODE = 1012;
export const DEVICE_BROKER_LOST_REASON = "device broker lost";

/** A socket as seen through the (optional) Hibernation attachment API. */
type AttachableSocket = WebSocket & {
  serializeAttachment?: (value: unknown) => void;
  deserializeAttachment?: () => unknown;
};

function supportsAttachment(ws: WebSocket): boolean {
  const sock = ws as AttachableSocket;
  return (
    typeof sock.serializeAttachment === "function" &&
    typeof sock.deserializeAttachment === "function"
  );
}

/** Read the attachment; `{}` when absent, unsupported, or unreadable. */
function readAttachment(ws: WebSocket): HibernationAttachment {
  const sock = ws as AttachableSocket;
  if (typeof sock.deserializeAttachment !== "function") return {};
  try {
    const value = sock.deserializeAttachment();
    return value && typeof value === "object" ? (value as HibernationAttachment) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the socket attachment. Throws when the host lacks the
 * API or the write fails — callers decide whether that is fatal.
 */
function writeAttachment(ws: WebSocket, patch: HibernationAttachment): void {
  const sock = ws as AttachableSocket;
  if (typeof sock.serializeAttachment !== "function") {
    throw new Error("WebSocket attachment API unavailable");
  }
  sock.serializeAttachment({ ...readAttachment(ws), ...patch });
}

/** Whether this socket negotiated the device plane on some incarnation. */
function isDeviceMarked(ws: WebSocket): boolean {
  return readAttachment(ws).deviceEnabled === true;
}

/**
 * Server → client device-plane message. Derived from `SessionTransport`
 * because core's `DeviceOutgoing` is not re-exported from
 * `@hypen-space/core/remote`.
 */
type DeviceOutgoing = Parameters<NonNullable<SessionTransport["sendDevice"]>>[0];

function getWebSocketPair(): WebSocketPairCtor {
  return (globalThis as unknown as { WebSocketPair: WebSocketPairCtor }).WebSocketPair;
}

/** RFC 001 §5 origin normalisation — must match `RemoteServer`'s. */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return origin.trim().toLowerCase();
  }
}

/**
 * Wrap a Cloudflare (hibernatable) WebSocket as a `SessionTransport`. Each
 * outgoing protocol message is JSON-serialised. Closing is best-effort — a
 * socket already closed by the edge throws, which we swallow.
 *
 * Device plane (RFC 001): `sendDevice` (JSON) is present only when the socket
 * exposes the Hibernation attachment API, because §2.5 requires the
 * `deviceEnabled` marker to be recorded before negotiation is acknowledged —
 * a socket that cannot carry the marker must never negotiate (core's
 * admission check sees no `sendDevice` and leaves the device plane off).
 * `sendBinary` ships raw device frames as binary WebSocket messages.
 */
export class CFTransport implements SessionTransport {
  /** Device-plane route (RFC 001 §5); absent ⇒ device plane never admitted. */
  readonly sendDevice?: (message: DeviceOutgoing) => void;
  /** The same route for the broker's own JSON text (no re-serialisation). */
  readonly sendDeviceText?: (text: string) => void;

  constructor(private readonly ws: WebSocket) {
    // A socket that negotiated permessage-deflate with context takeover
    // never carries the device plane (RFC 001 §2.3): no `sendDevice`, so
    // core never admits it. Per-message compression (both
    // no-context-takeover params) is fine.
    const compressed = readAttachment(ws).compressed === true || contextTakeoverDeflate(ws);
    if (supportsAttachment(ws) && !compressed) {
      this.sendDevice = (message: DeviceOutgoing) => {
        this.ws.send(JSON.stringify(message));
      };
      this.sendDeviceText = (text: string) => {
        this.ws.send(text);
      };
    }
  }

  send(message: OutgoingMessage): void {
    // RFC 001 §2.5: persist the reset marker BEFORE the ack that selects a
    // device plane leaves (covers both the initial and a late-hello re-ack).
    // If it can't be written, the socket must not be allowed to negotiate:
    // reset it rather than acknowledge a plane we could not reset on wake.
    if (message.type === "sessionAck" && (message as { device?: unknown }).device) {
      try {
        writeAttachment(this.ws, { deviceEnabled: true });
      } catch (err) {
        this.close(1011, "device marker unavailable");
        throw err;
      }
    }
    this.ws.send(JSON.stringify(message));
  }

  sendBinary(frame: Uint8Array): void {
    this.ws.send(frame);
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* socket already closed at the edge */
    }
  }
}

export interface HypenDurableObjectConfig {
  /** The primary module definition (built via `app.defineState(...).build()`). */
  module: HypenModuleDefinition<any>;
  /** Hypen DSL template string for the primary UI. */
  template: string;
  /** Module name used in protocol messages (default: "App"). */
  moduleName?: string;
  /**
   * The `HypenApp` registry of named modules. Required for multi-module apps:
   * nested-module state registration and `Router {}` auto-wiring resolve
   * route targets against it. Omit for a single-module app.
   */
  app?: HypenApp;
  /**
   * Templates for components that are NOT registered on `app` — e.g. a
   * stateless `BottomNav` built with bare `app.defineState({})` so its
   * `@state.*` falls through to the primary module. The Bun server discovers
   * these by filename; a DO has no filesystem, so they're listed here.
   * Name → Hypen DSL template.
   */
  componentTemplates?: Record<string, string>;
  /**
   * SVG resource bundle for `Icon(@resources.foo)` references. Name → raw SVG.
   */
  resources?: Record<string, string>;
  /**
   * Mirror actions/state to other sockets sharing this DO (default false).
   * The device plane stays on: a mirrored dispatch runs with replay
   * provenance, so its `context.device` refuses (`syncActions.replay`,
   * RFC 001 §1.7) — only the socket that dispatched can start device work.
   */
  syncActions?: boolean;
  /**
   * Device Capability Protocol (RFC 001). On by default: any client whose
   * hello offers `device` gets a device plane. `false` opts out — the DO then
   * behaves exactly like a UI-only host. The plane is also off (one warning)
   * when `deviceWasm` lacks the broker. Neither `syncActions` nor
   * `webSocketCompression` turns it off; compression is judged per socket.
   *
   * Hibernation: a socket that negotiated the device plane is reset with
   * 1012 when the DO wakes without its broker (§2.5); UI-only sockets keep
   * transparent restoration.
   */
  device?: boolean;
  /**
   * The device broker (RFC 001): the web-target `hypen-engine` exports built
   * with `--features js,device-broker` (the same module object passed to
   * `createCFEngine`), which carry `WasmDeviceBroker` — the Rust broker
   * every server SDK shares. `defineHypenWorker` sets it from its `wasm`
   * option. Missing (or a glue without the broker) ⇒ the device plane is
   * off, with one warning.
   */
  deviceWasm?: CFDeviceWasmExports;
  /**
   * Declare whether the Worker enables the `web_socket_compression`
   * compatibility flag (workerd then negotiates permessage-deflate with any
   * client that offers it; a Durable Object has no per-socket way to
   * decline). The flag is not observable from code, so it must be declared.
   * Default `false`, matching workerd without the flag.
   *
   * It never turns the device plane off for the DO. Compression is judged
   * per socket (RFC 001 §2.3): a socket whose negotiated extension carries
   * both `server_no_context_takeover` and `client_no_context_takeover`
   * (each message compressed on its own) keeps its device plane; one that
   * negotiated context takeover in either direction stays UI-only. When the
   * runtime does not report a socket's negotiated extensions, `true` makes
   * that check fail closed: a socket whose client OFFERED permessage-deflate
   * stays UI-only (a client that offered none cannot have negotiated it).
   */
  webSocketCompression?: boolean;
  /**
   * Browser `Origin` allowlist for the WebSocket upgrade (RFC 001 §5) — a
   * browser CSWSH defence, not an authenticator. An upgrade carrying an
   * unlisted `Origin` is rejected with 403; with an allowlist set, an
   * upgrade without `Origin` is admitted only by `authenticate`. With
   * neither this nor `authenticate`, every client is admitted (one warning —
   * set them in production). Exact normalised origins
   * (`scheme://host[:port]`), no wildcards.
   */
  allowedOrigins?: string[];
  /**
   * Application connection authenticator (RFC 001 §5, decision D1), called
   * in `fetch` before the socket is accepted: return true to admit. Runs for
   * every upgrade when configured (also those with an allowed Origin), and is
   * the only admission for clients that send no Origin (native apps) when an
   * allowlist is configured.
   */
  authenticate?: (request: Request) => boolean | Promise<boolean>;
}

export abstract class HypenDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;

  /**
   * Live sessions keyed by WebSocket identity. Emptied on hibernation —
   * `ensureSession` lazily re-creates entries when the DO wakes.
   */
  private sessions = new Map<WebSocket, RemoteSession>();

  /** One session manager per DO; created lazily once the config is known. */
  private _sessionManager: SessionManager | null = null;

  /** Built-once `SessionHost` shared across this DO's sessions. */
  private _host: SessionHost | null = null;

  /** Whether the device plane is on for this DO; resolved (and logged) once. */
  private _deviceOn: boolean | null = null;

  /** Whether the open-admission warning was logged for this DO. */
  private _admissionWarned = false;


  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  /** Subclass must provide the app config (module + template + registry). */
  abstract getConfig(): HypenDurableObjectConfig;

  /** Subclass must provide an engine factory (WASM creation is platform-specific). */
  abstract createEngine(): BaseEngine;

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Admission (RFC 001 §5, decision D1): reject before any socket is
    // accepted. Origin is checked against the allowlist when present; the
    // app's authenticator admits Origin-less (native) clients and runs for
    // every upgrade when configured.
    const refused = await this.admit(request);
    if (refused) return refused;

    // Create a WebSocketPair — client goes to the caller, server stays here.
    //
    // Compression: there is no per-socket knob here. workerd handles
    // permessage-deflate transparently when the Worker sets the
    // `web_socket_compression` compatibility flag in wrangler.jsonc; without
    // it, frames are always sent uncompressed. It is negotiated per-connection,
    // so clients that don't offer the extension are unaffected. What it
    // negotiated decides this socket's device plane (below).
    const pair = new (getWebSocketPair())();
    const client = pair[0];
    const server = pair[1];

    // Accept the server-side socket through the Hibernation API so CF can
    // evict this DO from memory while keeping the WebSocket alive at the edge.
    this.ctx.acceptWebSocket(server);

    // RFC 001 §2.3: a socket whose DEFLATE keeps a context across messages
    // (in either direction) never gets the device plane; remember it on the
    // socket so the verdict survives hibernation. Per-message compression
    // (both no-context-takeover params) is not marked.
    if (this.deviceOn() && this.uiOnlyCompression(server, request)) {
      if (supportsAttachment(server)) {
        try {
          writeAttachment(server, { compressed: true });
        } catch {
          // The verdict cannot be recorded, and CFTransport alone may not
          // be able to see it: fail closed rather than risk a device plane
          // on a context-takeover socket.
          try {
            server.close(1011, "compression marker unavailable");
          } catch {
            /* already closed */
          }
        }
      }
      /* no attachment API: CFTransport never offers a device route anyway */
    }

    // Bind DO storage so persistence calls route to this DO's storage.
    this.bindStorage();

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  /**
   * Message arrived on an accepted WebSocket. After hibernation the DO is
   * reconstructed, so the session is lazily re-created and fed to
   * `RemoteSession.receive`.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // RFC 001 §2.5 — loss of broker state is a connection reset. A socket
    // that negotiated the device plane on an earlier incarnation, but has no
    // live session (and so no broker) here, woke from hibernation: close it
    // BEFORE touching the message. No synthesised hello, no new broker, no
    // dispatch; the client reconnects with a full advertisement. Unmarked
    // (UI-only) sockets fall through to the restoration path below.
    if (!this.sessions.has(ws) && isDeviceMarked(ws)) {
      try {
        ws.close(DEVICE_BROKER_LOST_CODE, DEVICE_BROKER_LOST_REASON);
      } catch {
        /* socket already closed at the edge */
      }
      return;
    }

    // Binary device frames (RFC 001 §2.3) route to the live broker. Without
    // one, binary messages keep the legacy JSON-in-binary interpretation.
    if (typeof message !== "string") {
      const live = this.sessions.get(ws);
      if (live?.deviceBroker) {
        live.receiveBinary(toBytes(message));
        return;
      }
    }

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    // Device JSON limits start before parsing (RFC 001 §2.1, decision D4):
    // an over-1 MiB text that is a device message — `type` found by a linear
    // scan wherever it sits — is never JSON.parsed here; a live device
    // session counts it as a connection-level violation.
    const live = this.sessions.get(ws);
    if ((live?.deviceBroker || this.deviceOn()) && isOversizeDeviceText(text)) {
      live?.deviceBroker?.reportViolation("device message over 1 MiB");
      return;
    }

    let msg: RemoteMessage;
    try {
      msg = JSON.parse(text) as RemoteMessage;
    } catch {
      // Unparseable text is ignored — except on a live device connection,
      // where device text `JSON.parse` rejects (`NaN`, a bare token, …) is a
      // JSON-limit breach the broker must count against the connection's
      // violation budget (RFC 001 §2.1, decision D4): the session routes it
      // by its raw `type`.
      if (live?.deviceBroker) await live.receive(text);
      return;
    }

    // Re-bind storage on every message — after a wake the storage handle may
    // be freshly recreated, and the session we're about to (re)build needs it
    // in place before any load/save runs.
    this.bindStorage();

    const session = this.ensureSession(ws);

    // A client that believes it is still connected (post-hibernation, or a
    // legacy client that never sent `hello`) sends a non-hello first message.
    // Synthesise the handshake so the session renders and ships its initial
    // tree before the real message is processed.
    //
    // The synthesised hello MUST carry the session id the client already
    // established. Without it the wake path asks for a brand-new session
    // (`sessionId: new` in the logs), so the engine restarts from its initial
    // state, module state is discarded, and the client is sent a fresh
    // `initialTree` that re-creates its entire element tree — which, being a
    // first batch, also suppresses every enter animation. With it, the
    // session RESUMES and the wake is invisible to the client.
    if (msg.type !== "hello" && !session.helloReceived) {
      // The legacy (no-hello) initialisation — a legacy client that never
      // sends hello, or a UI-only socket waking from hibernation (with the
      // server-authenticated id from the attachment). Whatever the device
      // setting: such a session simply has no device plane, and a later real
      // hello may still negotiate the device extension on this socket
      // (RFC 001 §2.2).
      await session.initializeLegacy(this.rememberedSessionId(ws));
    }

    // The raw text (not the parsed value) goes to the session so device
    // messages get their strict duplicate-key check (RFC 001 §1.9).
    await session.receive(text);

    // Keep the id beside the socket so the NEXT hibernation can resume too.
    this.rememberSessionId(ws, session);
  }

  /**
   * Called by the CF runtime when a WebSocket closes. Tears the session down —
   * `RemoteSession.destroy` runs the disconnect hook and flushes persisted
   * state via the bound store.
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.destroySession(ws);
  }

  /**
   * Cloudflare reports abnormal socket termination separately from a clean
   * close. Treat both paths identically so session state, timers, and module
   * lifecycle resources cannot leak inside a long-lived DO isolate.
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.destroySession(ws);
  }

  private async destroySession(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    await session.destroy();
  }

  /** Lazily create (once) the per-DO session manager. */
  private getSessionManager(): SessionManager {
    if (!this._sessionManager) {
      this._sessionManager = new SessionManager();
    }
    return this._sessionManager;
  }

  /**
   * Build (once) the `SessionHost` adapter `RemoteSession` consumes. Mirrors
   * `RemoteServer.getHost()` but sources its module/template/registry from
   * `getConfig()` and its engine from the subclass's `createEngine()`.
   */
  private getHost(): SessionHost {
    if (this._host) return this._host;

    const config = this.getConfig();
    const self = this;
    const deviceOn = this.deviceOn();

    const discoveredComponents = mergeComponentTemplates(
      config.app ?? null,
      config.componentTemplates,
    );

    this._host = {
      module: config.module as HypenModule<any>,
      moduleName: config.moduleName ?? "App",
      ui: config.template,
      resources: config.resources ?? {},
      app: config.app ?? null,
      syncActions: config.syncActions ?? false,
      deviceDisabled: !deviceOn,
      deviceMaxRetainedBytes: DO_DEVICE_MAX_RETAINED_BYTES,
      // One Rust broker per device socket; the factory's pool is the
      // aggregate budget of this DO's connections (RFC 001 §2.4/§5).
      ...(deviceOn && hasDeviceBroker(config.deviceWasm)
        ? {
            deviceBrokerFactory: createCFDeviceBrokerFactory(
              config.deviceWasm,
              DO_DEVICE_AGGREGATE_RETAINED_BYTES
            ),
          }
        : {}),
      sessionManager: this.getSessionManager(),
      discoveredComponents,
      createEngine() {
        return self.createEngine();
      },
      *otherSessions(current: RemoteSession) {
        for (const s of self.sessions.values()) if (s !== current) yield s;
      },
      *sessionsForId(sessionId: string) {
        for (const s of self.sessions.values()) if (s.sessionId === sessionId) yield s;
      },
      onSessionReady(_session: RemoteSession, _client: RemoteClient) {
        /* no-op: the DO has no per-connection hooks to fire */
      },
      onSessionDestroyed(_session: RemoteSession, _client: RemoteClient) {
        /* webSocketClose owns map removal */
      },
    };
    return this._host;
  }

  /**
   * Store the established session id beside the hibernatable socket.
   *
   * The DO's in-memory `sessions` map is emptied when the runtime evicts it,
   * but the socket stays open at the edge — so the wake path has to rebuild
   * the session, and needs the id to rebuild it as a RESUME rather than a
   * fresh one. Cloudflare's hibernation attachment is the sanctioned place to
   * keep a few bytes that outlive the eviction.
   *
   * Best-effort throughout: a host without the attachment API (tests, the
   * non-CF stubs) simply degrades to the old reset-on-wake behaviour rather
   * than failing a message.
   */
  private rememberSessionId(ws: WebSocket, session: RemoteSession): void {
    const id = session.sessionId;
    if (!id) return;
    if (!supportsAttachment(ws)) return;
    try {
      if (readAttachment(ws).hypenSessionId === id) return; // already current
      writeAttachment(ws, { hypenSessionId: id });
    } catch {
      // Attachment is an optimisation, never a correctness requirement.
    }
  }

  /** The session id stashed by [rememberSessionId], if this host supports it. */
  private rememberedSessionId(ws: WebSocket): string | undefined {
    return readAttachment(ws).hypenSessionId;
  }

  /**
   * Whether this socket's compression keeps it UI-only (RFC 001 §2.3):
   * the runtime reports a negotiated permessage-deflate with context
   * takeover in either direction, or — when it reports nothing and the
   * Worker declared `webSocketCompression: true` — the client offered
   * DEFLATE, so the negotiation may have kept a context (fail closed).
   */
  private uiOnlyCompression(server: WebSocket, request: Request): boolean {
    const negotiated = negotiatedExtensions(server);
    if (negotiated !== undefined) return contextTakeoverDeflate(server);
    return this.getConfig().webSocketCompression === true && offersDeflate(request);
  }

  /**
   * Whether the device plane is on for this DO (RFC 001) — on by default.
   * Resolved once; an opt-out is silent, a missing broker logs ONE warning.
   * `syncActions` and `webSocketCompression` never turn it off (replay
   * provenance and the per-socket compression check cover them). Never
   * throws.
   */
  private deviceOn(): boolean {
    if (this._deviceOn !== null) return this._deviceOn;
    const config = this.getConfig();
    let reason: string | null = null;
    if (config.device === false) {
      this._deviceOn = false;
      return false;
    }
    if (!hasDeviceBroker(config.deviceWasm)) {
      reason =
        "no device broker: deviceWasm is missing or lacks WasmDeviceBroker (pass the web-target " +
        "hypen-engine exports built with --features js,device-broker; defineHypenWorker does this " +
        "from its `wasm` option)";
    }
    this._deviceOn = reason === null;
    if (reason !== null) {
      log.warn(`Device plane off: ${reason} — sessions stay UI-only`);
    }
    return this._deviceOn;
  }

  /** D1 upgrade admission; null admits, else the 403 response. */
  private async admit(request: Request): Promise<Response | null> {
    const config = this.getConfig();
    const allowedOrigins = this.getAllowedOrigins();
    if (!allowedOrigins && !config.authenticate && !this._admissionWarned) {
      this._admissionWarned = true;
      log.warn(OPEN_ADMISSION_WARNING);
    }
    const origin = request.headers.get("Origin");
    const forbidden = () => new Response("Forbidden", { status: 403 });
    if (origin !== null) {
      if (allowedOrigins && !allowedOrigins.has(normalizeOrigin(origin))) return forbidden();
    } else if (!config.authenticate && allowedOrigins) {
      return forbidden();
    }
    if (config.authenticate) {
      let ok = false;
      try {
        ok = (await config.authenticate(request)) === true;
      } catch {
        ok = false;
      }
      if (!ok) return forbidden();
    }
    return null;
  }

  /** Normalised `allowedOrigins`, or null when no allowlist is configured. */
  private getAllowedOrigins(): Set<string> | null {
    const list = this.getConfig().allowedOrigins;
    return list && list.length > 0 ? new Set(list.map(normalizeOrigin)) : null;
  }

  /** Get or lazily (re)create the session for a WebSocket. */
  private ensureSession(ws: WebSocket): RemoteSession {
    let session = this.sessions.get(ws);
    if (session) return session;

    const transport = new CFTransport(ws);
    // `helloGraceMs: null` disables the auto-init timer — initialisation is
    // driven explicitly (real or synthesised `hello`) so it always completes
    // before the triggering message is dispatched, and no timer dangles
    // across a hibernation boundary.
    session = new RemoteSession(this.getHost(), transport, {
      helloGraceMs: null,
      recoverySessionId: this.rememberedSessionId(ws),
    });
    this.sessions.set(ws, session);
    return session;
  }

  /**
   * Bind this DO's storage to every `.persist(durableObjectStore(...))` state
   * store — the primary module plus any named modules on the registry. Called
   * on `fetch` and on every message so the store always references the
   * current (possibly post-wake) storage instance.
   */
  private bindStorage(): void {
    const config = this.getConfig();
    bindStore(config.module.stateStore, this.ctx.storage);
    if (config.app) {
      for (const def of config.app.components.values()) {
        bindStore(def.stateStore, this.ctx.storage);
      }
    }
    this.onStorageBound(this.ctx.storage);
  }

  /**
   * Hook called after persistence stores are bound, on `fetch` and on every
   * message (so it runs again post-hibernation). Override to wire app-specific
   * storage — e.g. binding the DO's `state.storage.sql` into a `bun:sqlite`
   * shim and seeding the schema. Default no-op. Idempotent work should guard
   * itself (the schema seed is run-once in the examples).
   */
  protected onStorageBound(_storage: DurableObjectStorage): void {
    // no-op by default
  }
}

/** View a binary WebSocket message as bytes without copying. */
function toBytes(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return new Uint8Array(message);
}

/** Bind DO storage into a state store if it exposes the `__bindStorage` channel. */
function bindStore(store: unknown, storage: DurableObjectStorage): void {
  const s = store as DurableObjectStateStore<unknown> | undefined;
  if (s && typeof s.__bindStorage === "function") {
    s.__bindStorage(storage);
  }
}

/**
 * Build the `discoveredComponents` map `RemoteSession` reads — merging the
 * app registry with explicit `componentTemplates`. Exported for testing.
 *
 * `RemoteSession`'s component resolver reads `template`; its nested-module
 * state registration reads the `module` def. Two sources:
 *
 *   1. Named modules on `app` — carry their `module` def (for nested-module
 *      state) and, for inline `.ui(...)` components, a non-empty `.template`.
 *   2. `componentTemplates` — explicit name→template for components whose DSL
 *      lives outside the module def: anonymous fallbacks (e.g. BottomNav) AND
 *      named modules whose template is an external `.hypen` file (registry
 *      `.template` empty).
 *
 * An explicit template OVERRIDES an empty/absent registry template (so a named
 * module with an external `.hypen` resolves), but a non-empty registry
 * `.ui(...)` template is left intact, and the registry `module` def is always
 * preserved.
 */
export function mergeComponentTemplates(
  appRegistry: HypenApp | null,
  componentTemplates?: Record<string, string>,
): Map<string, { template: string; module?: HypenModuleDefinition<any> }> {
  const merged = new Map<
    string,
    { template: string; module?: HypenModuleDefinition<any> }
  >();
  if (appRegistry) {
    for (const [name, def] of appRegistry.components) {
      merged.set(name, { template: def.template ?? "", module: def });
    }
  }
  if (componentTemplates) {
    for (const [name, template] of Object.entries(componentTemplates)) {
      const existing = merged.get(name);
      if (!existing) {
        merged.set(name, { template });
      } else if (!existing.template) {
        existing.template = template;
      }
    }
  }
  return merged;
}
