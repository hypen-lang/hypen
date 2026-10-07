/**
 * `AgentHandle` — the agent surface bound to one live user session.
 *
 * # Why this exists
 *
 * The REST surface in `agent-http.ts` opens *headless* sessions: a fresh
 * engine on a transport nobody watches. That is the right default — an
 * unattended caller gets a sandbox of its own — but it cannot deliver the
 * co-pilot promise, where the human watching a session sees the effect of
 * what an agent did. For that the guarded dispatch has to run on the user's
 * own engine, so the user's own transport receives the patches.
 *
 * A handle is that binding. It is obtained from `RemoteServer.attach(id)`,
 * which returns one only for a session that has completed its hello
 * handshake (`RemoteSession.isReady`) and is not destroyed. Authorisation is
 * the caller's: `attach` performs no check of its own, because whoever
 * holds a `RemoteServer` reference already has every session on it. The
 * REST route layers `AgentOptions.authorize` in front of it.
 *
 * # What a handle is not
 *
 * A handle **never owns the session**. It holds a reference and nothing
 * else: no `destroy()`, no `expireAndClose()`, no suspend. When the user's
 * socket closes the session tears itself down as it always did, and the
 * handle reports `alive === false` and throws `AgentSessionGoneError` from
 * then on. Dropping the handle changes nothing about the session.
 *
 * # Wire behaviour
 *
 * `dispatch` goes through `engine.dispatchExternal` — the guard — and never
 * `dispatchAction`. Because it runs on the session's own engine, the
 * streaming render callback the session installed at hello time is what
 * carries the result: the user's transport receives exactly the `patch`
 * (and, when subscribed, `stateUpdate`) messages a click would have
 * produced, with the same revision bookkeeping, and under `allow-multiple`
 * the same peer fan-out. A guard refusal throws *before* any handler runs,
 * so nothing re-renders, nothing is sent, and the revision does not move.
 *
 * This module imports core types only. `server.ts` constructs handles and
 * `agent-http.ts` consumes them; importing either from here would close a
 * cycle between those two.
 */

import type { AgentAction } from "@hypen-space/core";
import type { RemoteSession, SessionHost } from "@hypen-space/core/remote";

/**
 * Thrown by every engine-touching method of an `AgentHandle` once the
 * session behind it has been destroyed (or was never ready). The session
 * is not "unknown" — the handle was valid when it was minted — it is gone,
 * and the caller should drop the handle rather than retry.
 */
export class AgentSessionGoneError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session '${sessionId}' is no longer live.`);
    this.name = "AgentSessionGoneError";
    this.sessionId = sessionId;
  }
}

/**
 * The engine-shaped view an `AgentHandle` exposes through `handle.engine`.
 *
 * Structurally what `@hypen-space/agent`'s `AgentEngine` requires, so
 * `new HypenMcpServer({ engine: handle.engine })` type-checks without this
 * package depending on that one. Every call is routed back through the
 * handle, so the liveness check and the `syncActions` fan-out apply to an
 * MCP client exactly as they do to a direct caller.
 */
export interface AgentHandleEngine {
  mcpManifest(): unknown;
  dispatchExternal(name: string, payload?: unknown): void;
  getStateAt(module: string | null, path: string | null): unknown;
  getRevision(): number;
  listActions(): AgentAction[];
}

/**
 * The agent surface, bound to one live session.
 *
 * Construct via `RemoteServer.attach(sessionId)`; the constructor is public
 * only so a host that satisfies `SessionHost` itself (a Durable Object, a
 * test) can mint one over a session it already holds.
 */
export class AgentHandle {
  /** The user session's id — the same value the client received in `sessionAck`. */
  readonly sessionId: string;

  constructor(
    private readonly session: RemoteSession,
    private readonly host: SessionHost
  ) {
    if (session.sessionId === null) {
      throw new Error("AgentHandle requires a session that has completed hello.");
    }
    this.sessionId = session.sessionId;
  }

  /**
   * Whether the session behind this handle can still be driven. False once
   * the user's transport closed and the session tore itself down; a handle
   * does not become alive again, and nothing here revives a session.
   */
  get alive(): boolean {
    return this.session.isReady && !this.session.isDestroyed;
  }

  /** Every action an external caller may dispatch right now. */
  listActions(): AgentAction[] {
    return this.live().engine.listActions();
  }

  /**
   * Dispatch one action on the user's engine, through the guard.
   *
   * On success the session's own streaming callback delivers the resulting
   * patches to the user's transport — nothing is sent from here. Under
   * `syncActions` the action is then mirrored to every other hello-completed
   * session, the way a click is (with replay provenance, so a sibling's
   * `context.device` refuses), but through `dispatchExternal` rather than
   * the permissive path a click uses; a sibling's refusal is logged by the
   * caller's choice, never propagated, so one peer cannot veto the user's
   * own dispatch.
   *
   * @throws {AgentSessionGoneError} when the session is no longer live.
   * @throws {HypenError} when the guard refuses — before any handler runs,
   *   so no patch is emitted and the revision is unchanged.
   */
  dispatch(name: string, payload?: unknown): void {
    const session = this.live();
    // The guard decides first. A throw here leaves every engine untouched:
    // the fan-out below is only reached once the user's own engine accepted.
    session.engine.dispatchExternal(name, payload);

    if (!this.host.syncActions) return;
    for (const other of this.host.otherSessions(session)) {
      if (!other.helloReceived || other.isDestroyed) continue;
      try {
        // Replay provenance, exactly like a mirrored click: the sibling's
        // handlers see `context.device` refuse (`syncActions.replay`,
        // RFC 001 §1.7) — a mirrored dispatch never starts device work on
        // another user's connection.
        const mirror = () => other.engine.dispatchExternal(name, payload);
        const instance = other.moduleInstance;
        if (instance) instance.runReplayed(mirror);
        else mirror();
      } catch {
        // A sibling that refuses (or has a stale declaration table) drops
        // out of the mirror; the primary dispatch already succeeded and
        // its patches are already on the user's transport.
      }
    }
  }

  /**
   * Read module state, whole or at a path, bounded to what the template
   * renders. `null` module = primary module; `undefined` when the module is
   * unknown or the path is outside the declared read surface — the engine
   * does not distinguish the two, and neither does this.
   */
  getState(module: string | null, path: string | null): unknown {
    return this.live().engine.getStateAt(module, path);
  }

  /**
   * The session's outgoing revision — the `revision` stamped on the last
   * `patch` message the user's transport received. Unchanged by a refusal.
   */
  revision(): number {
    return this.live().revision;
  }

  /**
   * The app's MCP manifest, as the engine composes it, or `null` when the
   * WASM artifact behind this session predates `mcpManifest()`.
   */
  manifest(): unknown | null {
    return this.live().engine.mcpManifest();
  }

  /**
   * An `AgentEngine`-shaped view for `@hypen-space/agent`:
   * `new HypenMcpServer({ engine: handle.engine })`.
   */
  get engine(): AgentHandleEngine {
    return {
      mcpManifest: () => this.manifest(),
      dispatchExternal: (name, payload) => this.dispatch(name, payload),
      getStateAt: (module, path) => this.getState(module, path),
      getRevision: () => this.revision(),
      listActions: () => this.listActions(),
    };
  }

  /** The session, or the `AgentSessionGoneError` to throw. */
  private live(): RemoteSession {
    if (!this.alive) throw new AgentSessionGoneError(this.sessionId);
    return this.session;
  }
}
