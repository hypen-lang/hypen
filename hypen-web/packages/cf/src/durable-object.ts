/**
 * HypenDurableObject — Base class for running Hypen apps inside
 * Cloudflare Durable Objects with Hibernation WebSocket support.
 *
 * This is infrastructure code. Developers don't extend this class
 * directly — the build tool (`hypen build --platform cloudflare`)
 * generates a worker that instantiates a concrete subclass.
 *
 * Responsibilities:
 *   1. WebSocket upgrade in fetch()
 *   2. Bind DO storage to all state stores via __bindStorage
 *   3. Hibernation-safe lifecycle via webSocketMessage / webSocketClose
 *   4. Engine + module instance creation on connection / wake
 *   5. Action dispatch and patch streaming
 *   6. Final state flush on disconnect
 */

import { HypenModuleInstance } from "@hypen-space/core/app";
import type {
  IEngine,
  HypenModuleDefinition,
} from "@hypen-space/core/app";
import type { Patch } from "@hypen-space/core/types";
import type {
  InitialTreeMessage,
  PatchMessage,
  DispatchActionMessage,
  HelloMessage,
  SessionAckMessage,
} from "@hypen-space/core/remote";
import type { DurableObjectStorage, DurableObjectStateStore } from "./durable-object-store.js";

// ---------------------------------------------------------------------------
// Minimal Cloudflare type stubs so the package compiles without the
// `cloudflare:workers` import (which only resolves inside wrangler).
// At runtime in a CF worker these are shadowed by the real types.
// ---------------------------------------------------------------------------

/** Minimal stub for Cloudflare's DurableObjectState */
export interface DurableObjectState {
  storage: DurableObjectStorage;
  /** Accept a WebSocket for the Hibernation API */
  acceptWebSocket(ws: WebSocket): void;
  /** Get all accepted WebSockets (survives hibernation) */
  getWebSockets(): WebSocket[];
}

// ---------------------------------------------------------------------------
// Session data — per-WebSocket state that must be reconstructed after
// hibernation since in-memory data is lost when the DO is evicted.
// ---------------------------------------------------------------------------

interface SessionData {
  engine: IEngine;
  moduleInstance: HypenModuleInstance<any>;
  revision: number;
  sessionId: string;
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HypenDurableObjectConfig {
  /** The module definition (built via `app.defineState(...).build()`) */
  module: HypenModuleDefinition<any>;
  /** Hypen DSL template string for the UI */
  template: string;
  /** Module name used in protocol messages (default: "App") */
  moduleName?: string;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class HypenDurableObject {
  protected ctx: DurableObjectState;
  protected env: unknown;

  /**
   * In-memory session keyed by WebSocket identity. Lost on hibernation —
   * `ensureSession` lazily re-creates it when the DO wakes.
   */
  private sessions = new Map<WebSocket, SessionData>();

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  /** Subclass must provide the module + template config. */
  abstract getConfig(): HypenDurableObjectConfig;

  /** Subclass must provide an engine factory (WASM creation is platform-specific). */
  abstract createEngine(): IEngine;

  // -----------------------------------------------------------------------
  // fetch — WebSocket upgrade
  // -----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Create a WebSocketPair — client goes to the caller, server stays here
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept the server-side socket through the Hibernation API so CF can
    // evict this DO from memory while keeping the WebSocket alive at the edge.
    this.ctx.acceptWebSocket(server);

    // Bind DO storage to the module's state store so persistence calls
    // route to this DO's transactional storage.
    this.bindStorage();

    return new Response(null, { status: 101, webSocket: client });
  }

  // -----------------------------------------------------------------------
  // Hibernation WebSocket API
  // -----------------------------------------------------------------------

  /**
   * Called by the CF runtime when a message arrives on an accepted WebSocket.
   * After hibernation the DO is re-constructed from scratch, so all in-memory
   * state (engine, module instance) must be lazily re-created here.
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore unparseable messages
    }

    switch (msg.type) {
      case "hello": {
        const helloMsg = msg as unknown as HelloMessage;
        const session = await this.ensureSession(ws);
        await this.initializeSession(ws, session, helloMsg.sessionId);
        break;
      }

      case "dispatchAction": {
        const actionMsg = msg as unknown as DispatchActionMessage;
        const session = await this.ensureSession(ws);
        if (!session.initialized) {
          // Session never received a hello — initialize with defaults
          await this.initializeSession(ws, session);
        }
        session.engine.dispatchAction(actionMsg.action, actionMsg.payload ?? null);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Called by the CF runtime when a WebSocket closes.
   * Flush state and clean up the session.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      // Final state flush — destroy calls stateStore.save under the hood
      await session.moduleInstance.destroy();
      this.sessions.delete(ws);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Bind this DO's storage to any state store that exposes `__bindStorage`.
   * Called on every fetch() and lazily on wake so the store always has a
   * reference to the (possibly new) storage instance.
   */
  private bindStorage(): void {
    const config = this.getConfig();
    const store = config.module.stateStore;
    if (store && typeof (store as DurableObjectStateStore<unknown>).__bindStorage === "function") {
      (store as DurableObjectStateStore<unknown>).__bindStorage(this.ctx.storage);
    }
  }

  /**
   * Get or create the session data for a WebSocket. After hibernation the
   * `sessions` map is empty, so this re-creates the engine and module instance.
   */
  private async ensureSession(ws: WebSocket): Promise<SessionData> {
    let session = this.sessions.get(ws);
    if (session) return session;

    // Re-bind storage in case we just woke from hibernation
    this.bindStorage();

    const config = this.getConfig();
    const engine = this.createEngine();

    const moduleInstance = new HypenModuleInstance(engine, config.module);
    await moduleInstance.waitForReady();

    // Flush microtasks so state changes from onCreated are applied
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    session = {
      engine,
      moduleInstance,
      revision: 0,
      sessionId: "",
      initialized: false,
    };

    this.sessions.set(ws, session);
    return session;
  }

  /**
   * Render the initial tree and send it + sessionAck to the client.
   */
  private async initializeSession(
    ws: WebSocket,
    session: SessionData,
    requestedSessionId?: string,
  ): Promise<void> {
    if (session.initialized) return;
    session.initialized = true;
    session.sessionId = requestedSessionId ?? crypto.randomUUID();

    const config = this.getConfig();
    const moduleName = config.moduleName ?? "App";

    // Send session acknowledgement
    const ack: SessionAckMessage = {
      type: "sessionAck",
      sessionId: session.sessionId,
      isNew: true,
      isRestored: false,
    };
    ws.send(JSON.stringify(ack));

    // Capture patches from initial render
    const initialPatches: Patch[] = [];
    session.engine.setRenderCallback((patches: Patch[]) => {
      initialPatches.push(...patches);
    });

    session.engine.renderSource(config.template);

    // Wire up streaming render callback for subsequent updates
    session.engine.setRenderCallback((patches: Patch[]) => {
      session.revision++;
      const patchMsg: PatchMessage = {
        type: "patch",
        module: moduleName,
        patches,
        revision: session.revision,
      };
      ws.send(JSON.stringify(patchMsg));
    });

    // Send the initial tree
    const initialMessage: InitialTreeMessage = {
      type: "initialTree",
      module: moduleName,
      state: session.moduleInstance.getState(),
      patches: initialPatches,
      revision: 0,
    };
    ws.send(JSON.stringify(initialMessage));
  }
}
