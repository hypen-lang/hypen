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
}

/**
 * Session information received from server
 */
export interface SessionInfo {
  sessionId: string;
  isNew: boolean;
  isRestored: boolean;
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

    // If session ID was provided, use it as current
    if (options.session?.id) {
      this.currentSessionId = options.session.id;
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

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.url);

        // Track the WebSocket for cleanup
        this.disposables.add(disposableWebSocket(this.ws));

        // Set up message handler
        const messageHandler = (event: MessageEvent) => {
          this.handleMessage(event.data);
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

  /**
   * Send hello message to establish session
   */
  private sendHello(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const hello: HelloMessage = {
      type: "hello",
      sessionId: this.currentSessionId ?? this.sessionOptions?.id,
      props: this.sessionOptions?.props,
      persistKey: this.sessionOptions?.persistKey,
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

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as RemoteMessage;

      switch (message.type) {
        case "sessionAck":
          this.handleSessionAck(message as SessionAckMessage);
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
      }
    } catch (e) {
      log.error("Error handling remote message:", e);
      const error = e instanceof Error ? e : new Error(String(e));
      this.errorCallbacks.forEach((cb) => cb(error));
    }
  }

  private handleSessionAck(message: SessionAckMessage): void {
    this.currentSessionId = message.sessionId;

    const info: SessionInfo = {
      sessionId: message.sessionId,
      isNew: message.isNew,
      isRestored: message.isRestored,
    };

    this.sessionEstablishedCallbacks.forEach((cb) => cb(info));
  }

  private handleSessionExpired(message: SessionExpiredMessage): void {
    this.currentSessionId = null;
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
