import Foundation
import HypenEngine

// MARK: - Concurrent Policy

/// How to handle concurrent connections to the same session.
public enum ConcurrentPolicy: Sendable {
    /// New connection kicks the existing one.
    case kickOld
    /// Reject new connection if one already exists.
    case rejectNew
    /// Allow multiple connections to the same session.
    case allowMultiple
}

// MARK: - Session Config

/// Session configuration.
public struct SessionConfig: Sendable {
    /// Session TTL in seconds after disconnect (default: 1 hour).
    public var ttl: TimeInterval
    /// How to handle concurrent connections to the same session.
    public var concurrent: ConcurrentPolicy
    /// Custom ID generator. Defaults to UUID.
    public var generateId: @Sendable () -> String

    public init(
        ttl: TimeInterval = 3600,
        concurrent: ConcurrentPolicy = .kickOld,
        generateId: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        precondition(ttl > 0, "Session TTL must be positive")
        self.ttl = ttl
        self.concurrent = concurrent
        self.generateId = generateId
    }
}

// MARK: - Session Info

/// Session information passed to lifecycle handlers.
/// Thread-safety: treated as immutable after construction. Callers must not
/// mutate the `props` dictionary after passing it to the initializer.
public struct SessionInfo: @unchecked Sendable {
    public let id: String
    public let createdAt: Date
    public let lastConnectedAt: Date
    public let props: [String: Any]

    public init(
        id: String,
        createdAt: Date = Date(),
        lastConnectedAt: Date = Date(),
        props: [String: Any] = [:]
    ) {
        self.id = id
        self.createdAt = createdAt
        self.lastConnectedAt = lastConnectedAt
        self.props = props
    }
}

// MARK: - Session

/// Active session data.
public final class Session: @unchecked Sendable {
    public let id: String
    public let ttl: TimeInterval
    public let createdAt: Date

    private let lock = NSLock()
    private var _lastConnectedAt: Date
    private var _props: [String: Any]

    public var lastConnectedAt: Date {
        get { lock.lock(); defer { lock.unlock() }; return _lastConnectedAt }
        set { lock.lock(); defer { lock.unlock() }; _lastConnectedAt = newValue }
    }

    public var props: [String: Any] {
        get { lock.lock(); defer { lock.unlock() }; return _props }
        set { lock.lock(); defer { lock.unlock() }; _props = newValue }
    }

    public init(id: String, ttl: TimeInterval, props: [String: Any] = [:]) {
        self.id = id
        self.ttl = ttl
        self.createdAt = Date()
        self._lastConnectedAt = Date()
        self._props = props
    }

    public func toSessionInfo() -> SessionInfo {
        lock.lock()
        defer { lock.unlock() }
        return SessionInfo(
            id: id,
            createdAt: createdAt,
            lastConnectedAt: _lastConnectedAt,
            props: _props
        )
    }
}

// MARK: - Pending Session

/// Pending (disconnected) session awaiting reconnect or expiry.
public struct PendingSession: @unchecked Sendable {
    public let session: Session
    public let savedState: [String: Any]
    let expiryTimer: DispatchWorkItem
}

// MARK: - Session Stats

public struct SessionStats: Sendable {
    public let activeSessions: Int
    public let pendingSessions: Int
    public let totalConnections: Int
}

// MARK: - Session Manager

/// Manages session lifecycle: create, suspend, resume, expire.
///
/// ```swift
/// let manager = SessionManager(config: SessionConfig(ttl: 300))
/// let session = manager.createSession()
/// manager.suspendSession(session.id, savedState: state) { print("expired") }
/// let pending = manager.resumeSession(session.id)
/// ```
public final class SessionManager: @unchecked Sendable {
    public let config: SessionConfig
    private let lock = NSLock()
    private var activeSessions: [String: Session] = [:]
    private var pendingSessions: [String: PendingSession] = [:]
    private var sessionConnections: [String: Set<ObjectIdentifier>] = [:]
    private let resumeTokens = DeviceResumeTokens()
    private let log = HypenLoggers.session

    public init(config: SessionConfig = SessionConfig()) {
        self.config = config
    }

    /// Create a new active session.
    public func createSession(props: [String: Any] = [:]) -> Session {
        lock.lock()
        var id = config.generateId()
        var attempts = 0
        while activeSessions[id] != nil || pendingSessions[id] != nil {
            attempts += 1
            if attempts >= 10 {
                lock.unlock()
                preconditionFailure("Failed to generate unique session ID after 10 attempts")
            }
            id = config.generateId()
        }
        let session = Session(id: id, ttl: config.ttl, props: props)
        activeSessions[id] = session
        lock.unlock()
        log.debug("Created session %@", id)
        return session
    }

    /// Get an active session by ID.
    public func getActiveSession(_ id: String) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        return activeSessions[id]
    }

    /// Suspend a session (on disconnect). Moves it to pending with a TTL timer.
    public func suspendSession(
        _ sessionId: String,
        savedState: [String: Any],
        onExpire: @escaping () -> Void
    ) {
        lock.lock()
        guard let session = activeSessions.removeValue(forKey: sessionId) else {
            lock.unlock()
            return
        }

        let workItem = DispatchWorkItem { [weak self] in
            self?.lock.lock()
            let pending = self?.pendingSessions.removeValue(forKey: sessionId)
            self?.lock.unlock()

            if pending != nil {
                self?.resumeTokens.revoke(sessionId)
                self?.log.info("Session %@ expired after %0.0fs TTL", sessionId, session.ttl)
                onExpire()
            }
        }

        pendingSessions[sessionId] = PendingSession(
            session: session,
            savedState: savedState,
            expiryTimer: workItem
        )
        lock.unlock()

        DispatchQueue.global().asyncAfter(
            deadline: .now() + session.ttl,
            execute: workItem
        )
        log.debug("Suspended session %@ with %0.0fs TTL", sessionId, session.ttl)
    }

    /// Resume a pending session (on reconnect). Returns the PendingSession if found.
    public func resumeSession(_ sessionId: String) -> PendingSession? {
        lock.lock()
        guard let pending = pendingSessions.removeValue(forKey: sessionId) else {
            lock.unlock()
            return nil
        }
        pending.expiryTimer.cancel()

        let session = pending.session
        session.lastConnectedAt = Date()
        activeSessions[sessionId] = session
        lock.unlock()

        log.debug("Resumed session %@", sessionId)
        return pending
    }

    /// Destroy a session completely (active or pending).
    public func destroySession(_ sessionId: String) {
        lock.lock()
        activeSessions.removeValue(forKey: sessionId)
        pendingSessions.removeValue(forKey: sessionId)?.expiryTimer.cancel()
        sessionConnections.removeValue(forKey: sessionId)
        lock.unlock()
        resumeTokens.revoke(sessionId)
        log.debug("Destroyed session %@", sessionId)
    }

    // MARK: Resume credential (RFC 001 §5)

    /// Issue a fresh resume credential for `sessionId` (random 256-bit,
    /// base64url). Rotated on every acknowledged connection: the previous
    /// token stops working. Every `sessionAck` carries it. Pass
    /// `devicePlane: true` when the connection negotiated a device plane:
    /// from then on the session is resumed only with its current token in
    /// `hello.resumeToken` (the public id alone never resumes it), while a
    /// UI-only session keeps the legacy id-only resume.
    public func issueResumeToken(_ sessionId: String, devicePlane: Bool = false) -> String {
        resumeTokens.issue(sessionId, devicePlane: devicePlane)
    }

    /// Whether resuming `sessionId` requires its resume token: true once the
    /// session has had a negotiated device plane.
    public func resumeRequiresToken(_ sessionId: String) -> Bool {
        resumeTokens.requiresToken(sessionId)
    }

    /// Whether `token` is the current resume credential for `sessionId`
    /// (constant-time comparison).
    public func verifyResumeToken(_ sessionId: String, _ token: String?) -> Bool {
        resumeTokens.verify(sessionId, token)
    }

    /// Track a connection for a session, applying the concurrent connection policy.
    /// Returns the set of connection IDs that should be kicked (empty for allowMultiple).
    /// Returns nil when the engine says to reject.
    ///
    /// The policy decision (kick / reject / allow) is delegated to the
    /// engine's canonical `portable_session_step`; see
    /// `hypen-engine-rs/src/portable/session.rs`. This manager owns
    /// timers and connection bookkeeping; the engine owns the decision.
    @discardableResult
    public func trackConnection(_ sessionId: String, connectionId: ObjectIdentifier) -> Set<ObjectIdentifier>? {
        lock.lock()
        defer { lock.unlock() }

        let existing = sessionConnections[sessionId] ?? Set()

        let policyTag: String = {
            switch config.concurrent {
            case .kickOld: return "kick-old"
            case .rejectNew: return "reject-new"
            case .allowMultiple: return "allow-multiple"
            }
        }()
        let stateJson = "{\"policy\":\"\(policyTag)\"}"
        let eventJson = "{\"kind\":\"connect\",\"existing_connection_count\":\(existing.count)}"
        let effect = try! portableSessionStep(
            stateJson: stateJson, eventJson: eventJson)
        let kind = Self.effectKind(from: effect)

        switch kind {
        case "accept_and_kick_existing":
            let kicked = existing
            sessionConnections[sessionId] = [connectionId]
            return kicked
        case "reject_connection":
            return nil
        case "accept_connection":
            if config.concurrent == .allowMultiple {
                sessionConnections[sessionId, default: Set()].insert(connectionId)
            } else {
                sessionConnections[sessionId] = [connectionId]
            }
            return Set()
        default:
            fatalError("trackConnection: unknown session effect '\(kind)' from engine")
        }
    }

    private static func effectKind(from json: String) -> String {
        guard let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let kind = obj["kind"] as? String else {
            fatalError("trackConnection: engine returned non-JSON session effect: \(json)")
        }
        return kind
    }

    /// Untrack a connection.
    public func untrackConnection(_ sessionId: String, connectionId: ObjectIdentifier) {
        lock.lock()
        defer { lock.unlock() }
        sessionConnections[sessionId]?.remove(connectionId)
    }

    /// Get the number of active connections for a session.
    public func getConnectionCount(_ sessionId: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sessionConnections[sessionId]?.count ?? 0
    }

    /// Get session statistics.
    public func getStats() -> SessionStats {
        lock.lock()
        defer { lock.unlock() }
        return SessionStats(
            activeSessions: activeSessions.count,
            pendingSessions: pendingSessions.count,
            totalConnections: sessionConnections.values.reduce(0) { $0 + $1.count }
        )
    }

    /// Shut down the session manager, cancelling all timers.
    public func shutdown() {
        lock.lock()
        for pending in pendingSessions.values {
            pending.expiryTimer.cancel()
        }
        pendingSessions.removeAll()
        activeSessions.removeAll()
        sessionConnections.removeAll()
        lock.unlock()
        resumeTokens.removeAll()
    }
}

// MARK: - Logger extension

extension HypenLoggers {
    public static let session = HypenLogger("HypenSession")
}
