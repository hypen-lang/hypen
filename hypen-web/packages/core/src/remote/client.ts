/**
 * RemoteEngine - Connect to a remote Hypen app over WebSocket
 * Platform-agnostic client (uses standard WebSocket API)
 *
 * Usage:
 * ```typescript
 * const engine = new RemoteEngine("ws://localhost:3000", {
 *   session: {
 *     id: localStorage.getItem("sessionId") ?? undefined,
 *     props: { platform: "web", version: "1.0" }
 *   }
 * });
 *
 * engine.onSessionEstablished(({ sessionId, isNew, isRestored }) => {
 *   localStorage.setItem("sessionId", sessionId);
 *   console.log(isRestored ? "Welcome back!" : "New session");
 * });
 *
 * engine.onSessionExpired((reason) => {
 *   localStorage.removeItem("sessionId");
 * });
 *
 * const result = await engine.connect();
 * if (!result.ok) {
 *   console.error("Connection failed:", result.error);
 * }
 * ```
 */

import type {
  RemoteMessage,
  InitialTreeMessage,
  PatchMessage,
  DispatchActionMessage,
  UpdateStateMessage,
  SubscribeStateMessage,
  HelloMessage,
  SessionAckMessage,
  SessionExpiredMessage,
} from "./types.js";
import type { DeviceEndpoint } from "./device/runtime.js";
import {
  decodeDeviceAck,
  decodeDeviceMessage,
  findTopLevelMember,
  isOversizeDeviceText,
} from "./device/strict-json.js";
import { findRevision, needsBinary } from "./device/registry.js";
import { deflateContextPolicy } from "./ws-extensions.js";
import type { DeviceAck, DeviceEvent, DeviceRequest, DeviceResponse } from "./device/generated.js";
import type { Patch } from "../types.js";
import {
  type Result,
  Ok,
  Err,
  ConnectionError,
} from "../result.js";
import {
  type Disposable,
  DisposableStack,
  disposableTimeout,
  disposableWebSocket,
  disposableListener,
} from "../disposable.js";
import { retry, type RetryOptions } from "../retry.js";
import { frameworkLoggers } from "../logger.js";

const log = frameworkLoggers.remote;

export type RemoteConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * Session configuration for the client
 */
export interface SessionOptions {
  /** Session ID to resume (omit for new session) */
  id?: string;
  /** Client metadata (platform, version, userId, etc.) */
  props?: Record<string, unknown>;
  /** Optional persist/routing key for Durable Object routing (withKey) */
  persistKey?: string;
  /**
   * Resume credential for `id`, as previously reported by
   * `SessionInfo.resumeToken` (RFC 001 §5: distinct from the public session
   * id). Sent as `hello.resumeToken` only when resuming. Treat as a secret.
   */
  resumeToken?: string;
}

/**
 * Session information received from server
 */
export interface SessionInfo {
  sessionId: string;
  isNew: boolean;
  isRestored: boolean;
  /**
   * Resume credential issued by servers that support it (RFC 001 §5). Persist
   * it next to `sessionId` (and pass it back as `session.resumeToken`) to
   * resume after a reload; never log it.
   */
  resumeToken?: string;
}

/**
 * Navigation options for platform back-button integration.
 *
 * When enabled, the client listens for platform back events (browser popstate,
 * Android back button) and dispatches a configurable action to the server.
 * The server module handles navigation via its own route stack.
 */
export interface NavigationOptions {
  /** Action name dispatched on back navigation (default: "navigateBack") */
  backAction?: string;
  /**
   * State key that represents the current view/route on the server.
   * When this key changes in a stateUpdate, the client pushes a browser
   * history entry so the back button works. (default: "currentView")
   */
  viewStateKey?: string;
}

export interface RemoteEngineOptions {
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  /** Session configuration */
  session?: SessionOptions;
  /**
   * Enable platform back-button integration.
   * Pass `true` for defaults, or an object to customize action/key names.
   */
  navigation?: boolean | NavigationOptions;
  /**
   * Device Capability Protocol endpoint (RFC 001). When set, `hello`
   * carries its advertisement, server → client device messages and binary
   * frames are routed to it, and it is detached on every socket close.
   * Absent ⇒ legacy wire, byte-identical.
   */
  device?: DeviceEndpoint;
  /**
   * Extra WebSocket upgrade headers, e.g. `{ Authorization: "Bearer …" }`
   * for a server's connection authenticator (RFC 001 §5:
   * `Origin` is a browser-only defence; non-browser clients authenticate).
   * A function is called on every (re)connect, so a short-lived token can be
   * refreshed. Only runtimes whose `WebSocket` accepts an init object honour
   * it (Bun, Node ≥ 22, React Native); browsers cannot set upgrade headers —
   * there the connection fails with a ConnectionError, so authenticate with
   * a cookie instead. Non-browser clients send no `Origin` unless it is set
   * here.
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** WebSocket subprotocols offered on the upgrade. */
  protocols?: string | string[];
  /**
   * Socket factory for runtimes/tests that construct sockets differently.
   * Receives the resolved headers and protocols. Default: the global
   * `WebSocket` (called with the URL alone when neither is configured).
   */
  webSocketFactory?: (url: string, init: { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;
}

interface ResolvedNavigationOptions {
  backAction: string;
  viewStateKey: string;
}

interface RequiredOptions {
  autoReconnect: boolean;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  session?: SessionOptions;
  navigation?: ResolvedNavigationOptions;
}

/**
 * Client-side engine that connects to a remote Hypen app
 */
export class RemoteEngine implements Disposable {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private state: RemoteConnectionState = "disconnected";
  private readonly options: RequiredOptions;
  private reconnectAttempts = 0;

  // Resource management
  private readonly disposables = new DisposableStack();
  private reconnectDisposable: Disposable | null = null;

  // Session state
  private currentSessionId: string | null = null;
  private readonly sessionOptions?: SessionOptions;

  // Callbacks
  private readonly patchCallbacks: Array<(patches: Patch[]) => void> = [];
  private readonly stateCallbacks: Array<(state: unknown) => void> = [];
  private readonly connectionCallbacks: Array<() => void> = [];
  private readonly disconnectionCallbacks: Array<() => void> = [];
  private readonly errorCallbacks: Array<(error: Error) => void> = [];
  private readonly sessionEstablishedCallbacks: Array<(info: SessionInfo) => void> = [];
  private readonly sessionExpiredCallbacks: Array<(reason: string) => void> = [];

  // State
  private currentState: unknown = null;
  private currentRevision = 0;
  private moduleName: string = "";

  // Navigation
  private navigationDisposable: Disposable | null = null;
  private lastViewValue: string | null = null;
  private handlingPopState = false;

  /** Device Capability Protocol endpoint (RFC 001), or null for legacy wire. */
  private device: DeviceEndpoint | null = null;
  /**
   * The socket the device endpoint is currently attached to. Device traffic
   * from any other (older) socket is never routed into the endpoint (§2.5).
   */
  private deviceSocket: WebSocket | null = null;
  /** Resume credential from the last `sessionAck` (never logged). */
  private resumeToken: string | null = null;
  /**
   * Handshake outcome delivered to the device endpoint for `deviceSocket`
   * (RFC 001 §2.2, decision D6): "none" yet, "absent" (an ack without
   * `device`, which a later ack carrying `device` may still replace), or
   * "final" (an ack carrying `device` was processed: later acks on this
   * socket cannot change the selection).
   */
  private deviceAckState: "none" | "absent" | "final" = "none";
  private readonly headersOption: RemoteEngineOptions["headers"];
  private readonly protocolsOption: string[] | undefined;
  private readonly webSocketFactory: RemoteEngineOptions["webSocketFactory"];

  constructor(url: string, options: RemoteEngineOptions = {}) {
    this.url = url;
    const navOpt = options.navigation;
    const navigation = navOpt
      ? {
          backAction: (typeof navOpt === "object" ? navOpt.backAction : undefined) ?? "navigateBack",
          viewStateKey: (typeof navOpt === "object" ? navOpt.viewStateKey : undefined) ?? "currentView",
        }
      : undefined;

    this.options = {
      autoReconnect: options.autoReconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 3000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      session: options.session,
      navigation,
    };
    this.sessionOptions = options.session;
    this.device = options.device ?? null;
    this.headersOption = options.headers;
    this.protocolsOption =
      options.protocols === undefined ? undefined : Array.isArray(options.protocols) ? options.protocols : [options.protocols];
    this.webSocketFactory = options.webSocketFactory;

    // If session ID was provided, use it as current
    if (options.session?.id) {
      this.currentSessionId = options.session.id;
      this.resumeToken = options.session.resumeToken ?? null;
    }
  }

  /**
   * Connect to the remote server
   * Returns a Result indicating success or failure
   */
  async connect(): Promise<Result<void, ConnectionError>> {
    if (this.state === "connected" || this.state === "connecting") {
      return Ok(undefined);
    }

    this.state = "connecting";

    // Upgrade headers (e.g. a bearer token for the server's connection
    // authenticator) are resolved per attempt so a token can be refreshed.
    let headers: Record<string, string> | undefined;
    try {
      const h = this.headersOption;
      headers = typeof h === "function" ? await h() : h;
    } catch (e) {
      this.state = "error";
      return Err(new ConnectionError(this.url, e));
    }

    return new Promise((resolve) => {
      try {
        this.ws = this.openSocket(headers);
        // Binary device frames (RFC 001 §2.3) must arrive as ArrayBuffers —
        // the default "blob" type reads asynchronously and would reorder
        // frames relative to JSON messages.
        this.ws.binaryType = "arraybuffer";

        // Track the WebSocket for cleanup
        this.disposables.add(disposableWebSocket(this.ws));
        const ws = this.ws;

        // Set up message handler
        const messageHandler = (event: MessageEvent) => {
          if (typeof event.data === "string") {
            this.handleMessage(event.data, ws);
          } else if (this.device && this.deviceSocket === ws) {
            const frame = binaryFrame(event.data);
            if (frame) this.device.handleFrame(frame);
          }
        };
        this.disposables.add(
          disposableListener(this.ws, "message", messageHandler as EventListener)
        );

        // Set up error handler
        const errorHandler = () => {
          this.state = "error";
          const error = new ConnectionError(this.url, new Error("WebSocket error"));
          this.errorCallbacks.forEach((cb) => cb(error));
          resolve(Err(error));
        };
        this.disposables.add(
          disposableListener(this.ws, "error", errorHandler)
        );

        // Set up close handler
        const closeHandler = () => {
          this.state = "disconnected";
          // Socket gone: the device endpoint tears down every operation,
          // releases hardware and dismisses prompts (RFC 001 §2.5).
          if (this.deviceSocket === ws) this.detachDevice();
          this.disconnectionCallbacks.forEach((cb) => cb());
          this.attemptReconnect();
        };
        this.disposables.add(
          disposableListener(this.ws, "close", closeHandler)
        );

        // Set up open handler
        this.ws.onopen = () => {
          this.state = "connected";
          this.reconnectAttempts = 0;

          // Cancel any pending reconnect
          if (this.reconnectDisposable) {
            this.reconnectDisposable.dispose();
            this.reconnectDisposable = null;
          }

          // Attach the device endpoint to this socket's lifetime — unless
          // the socket negotiated permessage-deflate WITH context takeover
          // in either direction: device traffic must never share a DEFLATE
          // history with other messages (RFC 001 §2.3), so that connection
          // stays UI-only and hello carries no device extension. Per-message
          // compression (both no-context-takeover params) is fine.
          this.attachDevice(ws);

          // Send hello message with session info
          this.sendHello();

          this.connectionCallbacks.forEach((cb) => cb());
          resolve(Ok(undefined));
        };
      } catch (e) {
        this.state = "error";
        const error = new ConnectionError(this.url, e);
        resolve(Err(error));
      }
    });
  }

  /** Construct the socket: the URL alone unless headers/protocols/factory are configured. */
  private openSocket(headers: Record<string, string> | undefined): WebSocket {
    const protocols = this.protocolsOption;
    if (this.webSocketFactory) {
      return this.webSocketFactory(this.url, {
        ...(headers ? { headers } : {}),
        ...(protocols ? { protocols } : {}),
      });
    }
    if (headers && Object.keys(headers).length > 0) {
      // Bun / Node (undici) / React Native accept an init object; a browser
      // WebSocket throws here (it cannot set upgrade headers).
      const Ctor = WebSocket as unknown as new (url: string, init: unknown) => WebSocket;
      return new Ctor(this.url, { headers, ...(protocols ? { protocols } : {}) });
    }
    return protocols ? new WebSocket(this.url, protocols) : new WebSocket(this.url);
  }

  /**
   * Attach the device endpoint to `ws` if the socket is eligible:
   * uncompressed, or permessage-deflate negotiated with BOTH
   * `server_no_context_takeover` and `client_no_context_takeover` (each
   * message compressed on its own, RFC 001 §2.3). Detaches it from any
   * previous socket first.
   */
  private attachDevice(ws: WebSocket): void {
    if (!this.device) return;
    this.detachDevice();
    const extensions = (ws as { extensions?: unknown }).extensions;
    if (deflateContextPolicy(extensions) === "context-takeover") {
      log.warn(
        "WebSocket negotiated permessage-deflate with context takeover: device plane disabled on this connection"
      );
      return;
    }
    this.deviceSocket = ws;
    this.deviceAckState = "none";
    this.device.attach({
      sendMessage: (m) => {
        if (this.deviceSocket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      },
      sendBinary: (frame) => {
        if (this.deviceSocket === ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
      },
      // Socket write capacity: device uploads wait while ≥ 256 KiB is
      // pending (RFC 001 §2.3).
      bufferedAmount: () => ws.bufferedAmount,
      // The device connection's control plane broke (§2.2) or the peer kept
      // violating the protocol: close this socket (the endpoint already
      // stopped everything). A reconnect starts a fresh handshake.
      close: (code, reason) => {
        if (this.deviceSocket !== ws) return;
        log.warn(`Closing the connection: ${reason}`);
        this.detachDevice();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason.slice(0, 120));
        }
      },
    });
  }

  /** Tear the device endpoint down (idempotent): prompts, drivers, leases. */
  private detachDevice(): void {
    if (!this.deviceSocket) return;
    this.deviceSocket = null;
    this.device?.detach();
  }

  /**
   * Send hello message to establish session
   */
  private sendHello(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const sessionId = this.currentSessionId ?? this.sessionOptions?.id;
    // `resumeToken` is sent only when resuming the session it was issued for.
    const hello: HelloMessage & { resumeToken?: string } = {
      type: "hello",
      sessionId,
      props: this.sessionOptions?.props,
      persistKey: this.sessionOptions?.persistKey,
      ...(sessionId && this.resumeToken ? { resumeToken: this.resumeToken } : {}),
      ...(this.device && this.deviceSocket === this.ws ? { device: this.device.advertisement } : {}),
    };

    this.ws.send(JSON.stringify(hello));
  }

  /**
   * Disconnect from the remote server and clean up resources
   */
  disconnect(): void {
    // Cancel any pending reconnect
    if (this.reconnectDisposable) {
      this.reconnectDisposable.dispose();
      this.reconnectDisposable = null;
    }

    // Tear the device plane down first (RFC 001 §2.5): the socket's close
    // event may never reach us once listeners are disposed.
    this.detachDevice();

    // Close WebSocket if open
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.state = "disconnected";
  }

  /**
   * Dispose all resources (alias for disconnect)
   */
  dispose(): void {
    this.disconnect();
    if (this.navigationDisposable) {
      this.navigationDisposable.dispose();
      this.navigationDisposable = null;
    }
    this.disposables.dispose();
  }

  // ── Navigation ────────────────────────────────────────────────

  /**
   * Set up the browser popstate listener for back-button integration.
   * Called automatically after the initial tree is received.
   */
  private setupNavigation(): void {
    const nav = this.options.navigation;
    if (!nav || typeof window === "undefined") return;
    if (this.navigationDisposable) return; // already set up

    this.navigationDisposable = disposableListener(window, "popstate", () => {
      if (this.handlingPopState) return;

      // Browser went back — dispatch the back action to the server
      log.debug("Back navigation detected, dispatching:", nav.backAction);
      this.handlingPopState = true;
      this.dispatchAction(nav.backAction);
      // Flag cleared when we receive the next state update
    });
  }

  /**
   * Track view changes from the server and push browser history entries.
   * This keeps the browser history stack in sync with server-side navigation
   * so that the back button has entries to pop.
   */
  private trackViewChange(state: unknown): void {
    const nav = this.options.navigation;
    if (!nav || typeof window === "undefined") return;

    const viewValue = this.resolveStateKey(state, nav.viewStateKey);
    if (viewValue === undefined || viewValue === this.lastViewValue) return;

    if (this.handlingPopState) {
      // This state update was caused by our own back action — don't push
      this.handlingPopState = false;
      this.lastViewValue = viewValue;
      return;
    }

    // Only push if we had a previous view (skip the initial load)
    if (this.lastViewValue !== null) {
      window.history.pushState({ view: viewValue }, "", "");
    }
    this.lastViewValue = viewValue;
  }

  /**
   * Resolve a dot-path key from state (e.g., "currentView" or "ui.page").
   */
  private resolveStateKey(state: unknown, key: string): string | undefined {
    if (!state || typeof state !== "object") return undefined;
    const parts = key.split(".");
    let current: any = state;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = current[part];
    }
    return typeof current === "string" ? current : undefined;
  }

  /**
   * Dispatch an action to the remote server
   */
  dispatchAction(action: string, payload?: unknown): void {
    if (this.state !== "connected" || !this.ws) {
      log.warn("Cannot dispatch action: not connected");
      return;
    }

    const message: DispatchActionMessage = {
      type: "dispatchAction",
      module: this.moduleName,
      action,
      payload,
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Subscribe to state updates after each render.
   * Only subscribed clients receive stateUpdate messages (avoids overhead for native clients).
   */
  subscribeState(): void {
    if (this.state !== "connected" || !this.ws) {
      log.warn("Cannot subscribe to state: not connected");
      return;
    }

    const message: SubscribeStateMessage = { type: "subscribeState" };
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Override the remote module's state (e.g. for time-travel).
   * The server will update state, re-render, and send back patches.
   */
  updateState(state: unknown): void {
    if (this.state !== "connected" || !this.ws) {
      log.warn("Cannot update state: not connected");
      return;
    }

    const message: UpdateStateMessage = {
      type: "updateState",
      module: this.moduleName,
      state,
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Register callback for patches
   */
  onPatches(callback: (patches: Patch[]) => void): this {
    this.patchCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for state updates
   */
  onStateUpdate(callback: (state: unknown) => void): this {
    this.stateCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for connection
   */
  onConnect(callback: () => void): this {
    this.connectionCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for disconnection
   */
  onDisconnect(callback: () => void): this {
    this.disconnectionCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for errors
   */
  onError(callback: (error: Error) => void): this {
    this.errorCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for session establishment
   * Called when server confirms session (new or resumed)
   */
  onSessionEstablished(callback: (info: SessionInfo) => void): this {
    this.sessionEstablishedCallbacks.push(callback);
    return this;
  }

  /**
   * Register callback for session expiration
   * Called when session is kicked or expires
   */
  onSessionExpired(callback: (reason: string) => void): this {
    this.sessionExpiredCallbacks.push(callback);
    return this;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): RemoteConnectionState {
    return this.state;
  }

  /**
   * Get current app state
   */
  getCurrentState(): unknown {
    return this.currentState;
  }

  /**
   * Get current revision
   */
  getRevision(): number {
    return this.currentRevision;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId;
  }

  private handleMessage(data: string, ws: WebSocket | null = this.ws): void {
    try {
      // Device messages obey the RFC 001 §2.1 JSON limits, the size limit
      // (UTF-8 bytes, not UTF-16 units) BEFORE parsing: a text frame over it
      // is inspected for its `type` with a linear scan and, when it is
      // device traffic, never parsed.
      if (this.device && isOversizeDeviceText(data)) {
        if (this.deviceSocket !== null && this.deviceSocket === ws) this.routeDeviceText(data, null);
        return;
      }
      const message = JSON.parse(data) as RemoteMessage | DeviceRequest;

      switch (message.type) {
        case "sessionAck":
          this.handleSessionAck(message as SessionAckMessage, data, ws);
          break;

        case "sessionExpired":
          this.handleSessionExpired(message as SessionExpiredMessage);
          break;

        case "initialTree":
          this.handleInitialTree(message as InitialTreeMessage);
          break;

        case "patch":
          this.handlePatch(message as PatchMessage);
          break;

        case "stateUpdate":
          this.currentState = (message as { state: unknown }).state;
          this.trackViewChange(this.currentState);
          this.stateCallbacks.forEach((cb) => cb(this.currentState));
          break;

        case "deviceRequest":
        case "deviceEvent":
        case "deviceResponse": {
          // Device plane (RFC 001): routed to the endpoint attached to THIS
          // socket, never into the patch/state path. Otherwise dropped. A
          // server `deviceResponse` is routed too: on a live id it is a
          // direction violation the endpoint answers (decision D8).
          if (!this.device || this.deviceSocket === null || this.deviceSocket !== ws) break;
          this.routeDeviceText(data, message);
          break;
        }
      }
    } catch (e) {
      log.error("Error handling remote message:", e);
      const error = e instanceof Error ? e : new Error(String(e));
      this.errorCallbacks.forEach((cb) => cb(error));
    }
  }

  /**
   * Deliver one device text message to the endpoint: as exact text when it
   * decodes strictly itself (`handleText`), else strictly decoded here. Text
   * breaking the JSON limits is attributable to no request (D3/D8): it is
   * discarded, never terminating the request its id seems to name.
   */
  private routeDeviceText(data: string, parsed: unknown): void {
    const device = this.device;
    if (!device) return;
    if (device.handleText) {
      device.handleText(data);
      return;
    }
    const decoded = decodeDeviceMessage(data);
    if (decoded.ok) {
      device.handleMessage(decoded.message as DeviceRequest | DeviceEvent | DeviceResponse);
    } else if (decoded.id !== null) {
      device.handleMalformed?.(parsed ?? { type: decoded.type, id: decoded.id }, `malformed device message: ${decoded.reason.slice(0, 128)}`);
    } else {
      log.debug(`Discarding device text breaking the JSON limits: ${decoded.reason.slice(0, 128)}`);
    }
  }

  private handleSessionAck(message: SessionAckMessage, raw: string, ws: WebSocket | null = this.ws): void {
    this.currentSessionId = message.sessionId;
    const token = (message as { resumeToken?: unknown }).resumeToken;
    this.resumeToken = typeof token === "string" && token.length > 0 ? token : null;
    if (this.device && this.deviceSocket !== null && this.deviceSocket === ws) {
      // The handshake is immutable per socket (RFC 001 §2.2): the first ack
      // carrying `device` is final. An ack without it may be followed by
      // one carrying it (a server that answered before seeing the hello,
      // decision D6); every later ack leaves the selection alone.
      const carries = message.device !== undefined && message.device !== null;
      if (this.deviceAckState === "final") {
        if (carries) log.warn("Ignoring sessionAck.device after the device handshake completed");
      } else if (carries) {
        this.deviceAckState = "final";
        this.device.onAck(this.acceptDeviceAck(message.device, raw));
      } else if (this.deviceAckState === "none") {
        this.deviceAckState = "absent";
        this.device.onAck(undefined);
      }
    }

    const info: SessionInfo = {
      sessionId: message.sessionId,
      isNew: message.isNew,
      isRestored: message.isRestored,
      ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
    };

    this.sessionEstablishedCallbacks.forEach((cb) => cb(info));
  }

  /**
   * Validate `sessionAck.device` and keep only selections this client
   * actually advertised (RFC 001 §2.2). Anything malformed disables the
   * device plane for this connection rather than guessing.
   */
  private acceptDeviceAck(ack: unknown, raw: string): DeviceAck | undefined {
    if (ack === undefined || ack === null || !this.device) return undefined;
    // Strict decoding of the member's exact text (JSON limits, handshake-v1,
    // unique capability names — D4/D7); a duplicated `device` member is
    // malformed too (the endpoints would disagree on which one counts).
    const member = findTopLevelMember(raw, "device");
    const decoded = member.found ? decodeDeviceAck(member.raw) : null;
    if (!decoded || !decoded.ok) {
      log.warn("Ignoring malformed sessionAck.device: device plane disabled on this connection");
      return undefined;
    }
    const a = ack as DeviceAck;
    const adv = this.device.advertisement;
    if (!adv.protocolVersions.includes(a.protocolVersion)) return undefined;
    const binary = a.binary && adv.binary;
    const capabilities = a.capabilities.filter((c) => {
      if (!adv.capabilities.some((o) => o.name === c.name && o.versions.includes(c.version))) return false;
      // Without the binary profile, binary revisions are not selectable.
      const rev = findRevision(c.name, c.version);
      return binary || !rev || !needsBinary(rev);
    });
    // The mandatory control stream must be selected, else the plane is off.
    if (!capabilities.some((c) => c.name === "core.capabilities" && c.version === 1)) return undefined;
    return { protocolVersion: a.protocolVersion, binary, capabilities };
  }

  private handleSessionExpired(message: SessionExpiredMessage): void {
    this.currentSessionId = null;
    this.resumeToken = null;
    this.sessionExpiredCallbacks.forEach((cb) => cb(message.reason));
  }

  private handleInitialTree(message: InitialTreeMessage): void {
    this.moduleName = message.module;
    this.currentState = message.state;
    this.currentRevision = message.revision;

    // Apply initial patches
    if (message.patches.length > 0) {
      this.patchCallbacks.forEach((cb) => cb(message.patches));
    }

    // Initialize navigation tracking from initial state
    this.trackViewChange(message.state);
    this.setupNavigation();

    // Auto-subscribe to state when navigation is enabled so we can
    // track view changes and push browser history entries.
    if (this.options.navigation) {
      this.subscribeState();
    }

    // Notify state callbacks
    this.stateCallbacks.forEach((cb) => cb(message.state));
  }

  private handlePatch(message: PatchMessage): void {
    // Check revision ordering
    if (message.revision <= this.currentRevision) {
      log.warn(`Out of order patch: expected > ${this.currentRevision}, got ${message.revision}`);
      return;
    }

    this.currentRevision = message.revision;

    // Apply patches
    if (message.patches.length > 0) {
      this.patchCallbacks.forEach((cb) => cb(message.patches));
    }
  }

  private attemptReconnect(): void {
    if (!this.options.autoReconnect) {
      return;
    }

    // Use disposable timeout to start reconnection after initial delay
    this.reconnectDisposable = disposableTimeout(() => {
      this.reconnectDisposable = null;

      retry(
        async () => {
          const result = await this.connect();
          if (!result.ok) {
            throw result.error;
          }
        },
        {
          maxAttempts: this.options.maxReconnectAttempts,
          delayMs: this.options.reconnectInterval,
          backoff: "exponential",
          maxDelayMs: 30000,
          jitter: 0.1,
          onRetry: (attempt, error) => {
            log.debug(`Reconnection attempt ${attempt}/${this.options.maxReconnectAttempts} failed: ${error.message}`);
          },
        }
      ).catch((error) => {
        log.error("Max reconnection attempts reached:", error.message);
        this.errorCallbacks.forEach((cb) =>
          cb(new ConnectionError(this.url, error, this.options.maxReconnectAttempts))
        );
      });
    }, this.options.reconnectInterval);
  }
}

/** A binary WebSocket payload as bytes (ArrayBuffer or a typed-array view). */
function binaryFrame(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Cross-realm ArrayBuffer (e.g. a socket created in another frame/VM).
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}
