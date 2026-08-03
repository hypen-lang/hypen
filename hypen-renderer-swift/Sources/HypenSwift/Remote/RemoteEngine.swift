import Foundation
import Combine

private let log = HypenLoggers.remote

/// Session configuration for the client
public struct SessionOptions: @unchecked Sendable {
    /// Session ID to resume (nil for new session)
    public let id: String?
    /// Client metadata (platform, version, userId, etc.)
    public let props: [String: Any]?

    public init(id: String? = nil, props: [String: Any]? = nil) {
        self.id = id
        self.props = props
    }
}

/// Session information received from server
public struct SessionInfo: Sendable {
    public let sessionId: String
    public let isNew: Bool
    public let isRestored: Bool

    public init(sessionId: String, isNew: Bool, isRestored: Bool) {
        self.sessionId = sessionId
        self.isNew = isNew
        self.isRestored = isRestored
    }
}

/// A server message decoded off the main actor. `@unchecked Sendable`
/// because `[String: Any]` payloads are handed over wholesale from the
/// decoding task to the main actor and never shared (see CLAUDE.md's
/// isolation-boundary pattern).
private enum DecodedRemoteMessage: @unchecked Sendable {
    case sessionAck([String: Any])
    case sessionExpired([String: Any])
    case initialTree(state: [String: Any]?, patches: [Patch]?)
    case patch([Patch]?)
    case stateUpdate([String: Any]?)
    case unknown(type: String)
    case unparseable(preview: String)
}

/// WebSocket-based remote engine for Hypen
@MainActor
public final class RemoteEngine: NSObject, @unchecked Sendable {
    private let url: URL
    private let config: RemoteEngineConfig
    private let sessionOptions: SessionOptions?

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectAttempts = 0
    private var reconnectTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?

    // Session state
    private var currentSessionId: String?

    // MARK: - Publishers

    private let connectionStateSubject = CurrentValueSubject<ConnectionState, Never>(.disconnected)
    private let treeResetSubject = PassthroughSubject<Void, Never>()
    private let patchesSubject = PassthroughSubject<[Patch], Never>()
    private let stateSubject = CurrentValueSubject<[String: Any], Never>([:])
    private let errorsSubject = PassthroughSubject<Error, Never>()
    private let sessionEstablishedSubject = PassthroughSubject<SessionInfo, Never>()
    private let sessionExpiredSubject = PassthroughSubject<String, Never>()

    public var connectionState: AnyPublisher<ConnectionState, Never> {
        connectionStateSubject.eraseToAnyPublisher()
    }

    public var patches: AnyPublisher<[Patch], Never> {
        patchesSubject.eraseToAnyPublisher()
    }

    /// Fires whenever the server sends a full `initialTree` — including
    /// replays after a reconnect or revision-gap recovery, where the same
    /// element ids are re-Created from scratch. Emitted BEFORE the
    /// accompanying patch batch is delivered on `patches`, so consumers
    /// must reset any tree state built from previous patches (e.g.
    /// `HypenRenderer.clear()`) to avoid observing orphaned pre-replay
    /// element instances.
    public var treeResets: AnyPublisher<Void, Never> {
        treeResetSubject.eraseToAnyPublisher()
    }

    public var state: AnyPublisher<[String: Any], Never> {
        stateSubject.eraseToAnyPublisher()
    }

    public var errors: AnyPublisher<Error, Never> {
        errorsSubject.eraseToAnyPublisher()
    }

    /// Publisher for session establishment events
    public var sessionEstablished: AnyPublisher<SessionInfo, Never> {
        sessionEstablishedSubject.eraseToAnyPublisher()
    }

    /// Publisher for session expiration events
    public var sessionExpired: AnyPublisher<String, Never> {
        sessionExpiredSubject.eraseToAnyPublisher()
    }

    public var currentState: ConnectionState {
        connectionStateSubject.value
    }

    /// Get the current session ID
    public func getSessionId() -> String? {
        currentSessionId
    }

    // MARK: - Initialization

    public init(url: URL, config: RemoteEngineConfig = .default, sessionOptions: SessionOptions? = nil) {
        self.url = url
        self.config = config
        self.sessionOptions = sessionOptions
        self.currentSessionId = sessionOptions?.id
        super.init()
    }

    public convenience init(urlString: String, config: RemoteEngineConfig = .default, sessionOptions: SessionOptions? = nil) throws {
        guard let url = URL(string: urlString) else {
            throw RemoteEngineError.invalidURL(urlString)
        }
        self.init(url: url, config: config, sessionOptions: sessionOptions)
    }

    // MARK: - Connection Management

    public func connect() {
        guard !connectionStateSubject.value.isConnected else {
            log.debug("Already connected to %@", url.absoluteString)
            return
        }

        log.debug("Connecting to %@", url.absoluteString)
        connectionStateSubject.send(.connecting)
        reconnectAttempts = 0
        establishConnection()
    }

    public func disconnect() {
        log.debug("Disconnecting from %@", url.absoluteString)
        cancelAllTasks()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        connectionStateSubject.send(.disconnected)
    }

    private func establishConnection() {
        log.debug("Establishing connection to %@", url.absoluteString)
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = config.connectTimeout
        sessionConfig.timeoutIntervalForResource = config.readTimeout

        urlSession = URLSession(configuration: sessionConfig, delegate: self, delegateQueue: nil)
        webSocketTask = urlSession?.webSocketTask(with: url)
        log.debug("WebSocket task created, resuming...")
        webSocketTask?.resume()

        startReceiving()
        startPingTimer()
        log.debug("Receive and ping tasks started")
    }

    private func cancelAllTasks() {
        reconnectTask?.cancel()
        reconnectTask = nil
        pingTask?.cancel()
        pingTask = nil
        receiveTask?.cancel()
        receiveTask = nil
    }

    // MARK: - Message Receiving

    private func startReceiving() {
        receiveTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self = self else { return }
                do {
                    guard let message = try await self.webSocketTask?.receive() else {
                        break
                    }
                    // Extract the Sendable payload on the main actor, then
                    // decode (JSON parse + patch materialization) off-main;
                    // only the final dispatch touches main-actor state.
                    let decoded: DecodedRemoteMessage?
                    switch message {
                    case .string(let text):
                        log.debug("Received message (\(text.count) chars)")
                        decoded = await Self.decodeMessage(text: text, data: nil)
                    case .data(let data):
                        log.debug("Received data message (\(data.count) bytes)")
                        decoded = await Self.decodeMessage(text: nil, data: data)
                    @unknown default:
                        log.warn("Unknown message type received")
                        decoded = nil
                    }
                    if let decoded = decoded {
                        self.handleDecoded(decoded)
                    }
                } catch {
                    if !Task.isCancelled {
                        self.handleError(error)
                    }
                    break
                }
            }
        }
    }

    /// Decode a raw WebSocket frame into a message. Nonisolated async, so
    /// it runs on the global executor — large initialTree/patch payloads
    /// never block the main actor while parsing.
    nonisolated private static func decodeMessage(text: String?, data: Data?) async -> DecodedRemoteMessage {
        let payload = data ?? text?.data(using: .utf8)
        guard let payload = payload,
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let type = json["type"] as? String else {
            let preview = text.map { String($0.prefix(500)) }
                ?? data.flatMap { String(data: $0.prefix(500), encoding: .utf8) }
                ?? "<binary>"
            return .unparseable(preview: preview)
        }

        log.debug("Message type: \(type)")

        switch type {
        case "sessionAck":
            return .sessionAck(json)
        case "sessionExpired":
            return .sessionExpired(json)
        case "initialTree":
            let patches = (json["patches"] as? [[String: Any]]).map(Patch.fromArray)
            return .initialTree(state: json["state"] as? [String: Any], patches: patches)
        case "patch":
            let patches = (json["patches"] as? [[String: Any]]).map(Patch.fromArray)
            return .patch(patches)
        case "stateUpdate":
            return .stateUpdate(json["state"] as? [String: Any])
        default:
            return .unknown(type: type)
        }
    }

    private func handleDecoded(_ message: DecodedRemoteMessage) {
        switch message {
        case .sessionAck(let json):
            handleSessionAck(json)
        case .sessionExpired(let json):
            handleSessionExpired(json)
        case .initialTree(let state, let patches):
            handleInitialTree(state: state, patches: patches)
        case .patch(let patches):
            if let patches = patches {
                log.debug("Received patch message with \(patches.count) patches")
                patchesSubject.send(patches)
            } else {
                log.warn("Patch message has no patches array")
            }
        case .stateUpdate(let state):
            if let state = state {
                log.debug("Received state update")
                stateSubject.send(state)
            }
        case .unknown(let type):
            log.warn("Unknown message type: %@", type)
        case .unparseable(let preview):
            log.error("Failed to parse message: %@", preview)
        }
    }

    private func handleSessionAck(_ json: [String: Any]) {
        guard let sessionId = json["sessionId"] as? String else {
            log.warn("Invalid sessionAck message: missing sessionId")
            return
        }

        let isNew = json["isNew"] as? Bool ?? true
        let isRestored = json["isRestored"] as? Bool ?? false

        log.debug("Session established: id=%@, isNew=%@, isRestored=%@", sessionId, String(isNew), String(isRestored))
        currentSessionId = sessionId

        let info = SessionInfo(
            sessionId: sessionId,
            isNew: isNew,
            isRestored: isRestored
        )
        sessionEstablishedSubject.send(info)
    }

    private func handleSessionExpired(_ json: [String: Any]) {
        let sessionId = json["sessionId"] as? String ?? ""
        let reason = json["reason"] as? String ?? "unknown"

        log.debug("Session expired: id=%@, reason=%@", sessionId, reason)
        currentSessionId = nil

        sessionExpiredSubject.send(reason)
    }

    private func handleInitialTree(state: [String: Any]?, patches: [Patch]?) {
        log.debug("Received initial tree")

        // Signal a full-tree replay before delivering the patches: on
        // reconnect the server re-sends the whole tree under the same
        // ids, so consumers must drop stale element instances first.
        treeResetSubject.send(())

        if let state = state {
            log.debug("Initial tree has state with \(state.count) keys")
            stateSubject.send(state)
        } else {
            log.debug("Initial tree has no state")
        }

        if let patches = patches {
            log.debug("Initial tree has \(patches.count) patches")
            patchesSubject.send(patches)
        } else {
            log.warn("Initial tree has NO patches array!")
        }
    }

    // MARK: - Action Dispatching

    public func dispatchAction(_ action: String, payload: [String: Any]? = nil) {
        let message: [String: Any] = [
            "type": "dispatchAction",
            "action": action,
            "payload": payload ?? [:]
        ]

        sendMessage(message)
    }

    private func sendMessage(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: .prettyPrinted),
              let text = String(data: data, encoding: .utf8) else {
            log.error("Failed to serialize message")
            return
        }

        log.debug("Sending message: %@", String(text.prefix(200)))

        webSocketTask?.send(.string(text)) { error in
            if let error = error {
                log.error("Send error: %@", error.localizedDescription)
            }
        }
    }

    /// Send hello message to establish session
    private func sendHello() {
        var message: [String: Any] = ["type": "hello"]

        if let sessionId = currentSessionId ?? sessionOptions?.id {
            message["sessionId"] = sessionId
        }

        if let props = sessionOptions?.props {
            message["props"] = props
        }

        log.debug("Sending hello message")
        sendMessage(message)
    }

    // MARK: - Ping/Pong

    private func startPingTimer() {
        pingTask = Task { [weak self] in
            guard let self = self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.config.pingInterval * 1_000_000_000))
                if Task.isCancelled { break }
                await MainActor.run {
                    self.sendPing()
                }
            }
        }
    }

    private func sendPing() {
        webSocketTask?.sendPing { error in
            if let error = error {
                log.debug("Ping error: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - Error Handling & Reconnection

    private func handleError(_ error: Error) {
        log.error("WebSocket error: %@", error.localizedDescription)
        errorsSubject.send(error)

        // Check if we should reconnect
        if config.autoReconnect &&
           (config.maxReconnectAttempts == 0 || reconnectAttempts < config.maxReconnectAttempts) {
            scheduleReconnect()
        } else {
            connectionStateSubject.send(.error(message: error.localizedDescription))
        }
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1
        connectionStateSubject.send(.reconnecting(attempt: reconnectAttempts))

        log.debug("Scheduling reconnect attempt %d in %fs", reconnectAttempts, config.reconnectInterval)

        reconnectTask = Task { [weak self] in
            guard let self = self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.config.reconnectInterval * 1_000_000_000))
            if !Task.isCancelled {
                await MainActor.run {
                    self.establishConnection()
                }
            }
        }
    }

}

// MARK: - URLSessionWebSocketDelegate

extension RemoteEngine: URLSessionWebSocketDelegate {
    nonisolated public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        log.debug("WebSocket connected to %@", url.absoluteString)
        Task { @MainActor in
            reconnectAttempts = 0
            connectionStateSubject.send(.connected)

            // Send hello message to establish session
            sendHello()
        }
    }

    nonisolated public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "unknown"
        log.debug("WebSocket closed - code: %d, reason: %@", closeCode.rawValue, reasonStr)
        Task { @MainActor in
            if config.autoReconnect &&
               (config.maxReconnectAttempts == 0 || reconnectAttempts < config.maxReconnectAttempts) {
                scheduleReconnect()
            } else {
                connectionStateSubject.send(.disconnected)
            }
        }
    }
}

// MARK: - Errors

public enum RemoteEngineError: LocalizedError {
    case invalidURL(String)
    case connectionFailed(String)
    case messageParseFailed

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .connectionFailed(let reason):
            return "Connection failed: \(reason)"
        case .messageParseFailed:
            return "Failed to parse message"
        }
    }
}
