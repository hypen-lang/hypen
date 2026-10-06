import Foundation

// AgentHandle.swift — attach mode for the agent surface.
//
// An `AgentHandle` binds an external caller (an MCP server, a REST route,
// an operator CLI, an LLM agent) to ONE live user session, so guarded
// dispatches and reads run on that user's engine and the user's own
// transport receives the resulting patches — the human watching the
// screen sees the cart badge tick. Obtain one via `RemoteServer.attach(_:)`.
//
// Authorization is the developer's: `attach` is an in-process call made
// from the developer's own handler, so whoever calls it is the authorizer.
// There is no HTTP route for it.

/// Errors raised by the agent surface.
///
/// A guard refusal is *not* one of these — it arrives as the engine's own
/// `HypenError.ActionError`, exactly as it does from
/// `NativeEngine.dispatchExternal(_:payload:)`.
public enum AgentHandleError: Error, CustomStringConvertible, Sendable {
    /// The user session behind the handle has been destroyed (or was
    /// released). The handle is inert from then on; obtain a fresh one via
    /// `RemoteServer.attach(_:)` if the user reconnects.
    case sessionGone(sessionID: String)
    /// The session exists but never built an engine (construction failed
    /// in `RemoteSession.init`), so there is no guarded surface to reach.
    case noEngine(sessionID: String)

    public var description: String {
        switch self {
        case .sessionGone(let sessionID):
            return "Session '\(sessionID)' is no longer live."
        case .noEngine(let sessionID):
            return "Session '\(sessionID)' has no engine."
        }
    }
}

/// The agent surface, bound to one live user session.
///
/// - Dispatch goes through the engine's guarded `dispatchExternal` — never
///   the renderer's permissive `dispatchAction` path — so only declared
///   `.onAction()` handlers and the `hypen.*` built-ins the app backs are
///   reachable. A refusal throws and emits no traffic on the user's
///   transport and no revision bump.
/// - A successful `dispatch` emits on the user's transport exactly what a
///   click on that session emits: a `patch` message at the next revision
///   (from the session's `onPatches` wiring), then a `stateUpdate` at the
///   revision after that (the shared `emitStateUpdate` tail).
/// - The handle **never owns, destroys, suspends, or closes** the session.
///   It holds the session weakly: dropping a handle has no effect on the
///   user, and destroying the user's session makes every handle method
///   throw `AgentHandleError.sessionGone` from then on.
///
/// Attach requires a typed module (`RemoteServer.module(_:_:)`): the legacy
/// untyped `withState(_:_:)` + `onAction(_:)` shim never registers engine
/// handlers or declares actions, so under it the guard refuses every name.
public final class AgentHandle: @unchecked Sendable {
    /// The Hypen session id this handle is bound to — the same value the
    /// client received in `sessionAck`.
    public let sessionID: String

    /// Weak on purpose: a handle observes the session, it does not keep it
    /// alive or tear it down.
    private weak var session: RemoteSession?

    /// Internal: minted by `RemoteServer.attach(_:)` over a session that has
    /// completed hello. Not public — the server is the only place that can
    /// match an id against its live sessions.
    init(session: RemoteSession, sessionID: String) {
        self.session = session
        self.sessionID = sessionID
    }

    /// Whether the session behind this handle can still be driven. False
    /// once the user's transport closed and the session tore itself down
    /// (or the session was released); a handle never becomes alive again,
    /// and nothing here revives a session.
    public var isAlive: Bool {
        guard let session = session else { return false }
        return session.isReady && !session.isDestroyed
    }

    /// The session's current wire revision — the value stamped on the last
    /// `patch` / `stateUpdate` the user's transport received. Unchanged by
    /// a refused dispatch.
    ///
    /// - Throws: `AgentHandleError` when the session is no longer live.
    public var revision: Int {
        get throws { try live().session.currentRevision }
    }

    /// Every action an external caller may dispatch on the session right
    /// now: declared module actions plus whichever `hypen.*` built-ins the
    /// app backs. Framework internals (`__hypen_bind`, `router.*`) never
    /// appear.
    ///
    /// - Throws: `AgentHandleError` when the session is no longer live, or
    ///   `NativeEngineError.surfaceDecodingFailed` on engine/SDK drift.
    public func listActions() throws -> [AgentAction] {
        try live().engine.listActions()
    }

    /// Dispatch one action on the user's engine, through the guard.
    ///
    /// On success the session's own `onPatches` wiring delivers the
    /// resulting `patch` to the user's transport and the session appends
    /// its `stateUpdate` — nothing is sent from here.
    ///
    /// - Throws: `AgentHandleError.sessionGone` when the session is no
    ///   longer live; the engine's `HypenError.ActionError` when the guard
    ///   refuses — before any handler runs, so no message is emitted and
    ///   the revision is unchanged.
    public func dispatch(_ name: String, payload: [String: Any]? = nil) throws {
        try live().session.dispatchExternal(name, payload: payload)
    }

    /// Read module state, whole or at a path, bounded to what the template
    /// declares. `module` nil reads the primary module; `path` nil reads
    /// the whole module. Returns nil for an unknown module *or* an absent
    /// path — the engine deliberately doesn't distinguish the two.
    ///
    /// - Throws: `AgentHandleError` when the session is no longer live.
    public func getState(module: String? = nil, path: String? = nil) throws -> Any? {
        try live().engine.getStateAt(module: module, path: path)
    }

    /// The MCP handshake for this app, composed by the engine from the same
    /// declaration tables `listActions()` reads. Returned as the JSON string
    /// the engine produced; forward it verbatim.
    ///
    /// - Throws: `AgentHandleError` when the session is no longer live.
    public func manifest() throws -> String {
        try live().engine.mcpManifest()
    }

    // MARK: - Internals

    /// Resolve the live session + engine, or throw. Every engine-touching
    /// member funnels through here so the liveness rule is in one place.
    private func live() throws -> (session: RemoteSession, engine: NativeEngine) {
        guard let session = session, session.isReady, !session.isDestroyed else {
            throw AgentHandleError.sessionGone(sessionID: sessionID)
        }
        guard let engine = session.nativeEngine else {
            throw AgentHandleError.noEngine(sessionID: sessionID)
        }
        return (session, engine)
    }
}
