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
        receiveTask = Task { [weak self] in
            guard let self = self else { return }
            while !Task.isCancelled {
                do {
                    guard let message = try await self.webSocketTask?.receive() else {
                        break
                    }
                    await MainActor.run {
                        self.handleMessage(message)
                    }
                } catch {
                    if !Task.isCancelled {
                        await MainActor.run {
                            self.handleError(error)
                        }
                    }
                    break
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            log.debug("Received message (%d chars)", text.count)
            parseMessage(text)
        case .data(let data):
            if let text = String(data: data, encoding: .utf8) {
                log.debug("Received data message (%d chars)", text.count)
                parseMessage(text)
            }
        @unknown default:
            log.warn("Unknown message type received")
        }
    }

    private func parseMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            log.error("Failed to parse message: %@", String(text.prefix(500)))
            return
        }

        log.debug("Message type: %@", type)

        switch type {
        case "sessionAck":
            handleSessionAck(json)
        case "sessionExpired":
            handleSessionExpired(json)
        case "initialTree":
            handleInitialTree(json)
        case "patch":
            handlePatch(json)
        case "stateUpdate":
            handleStateUpdate(json)
        default:
            log.warn("Unknown message type: %@", type)
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

    private func handleInitialTree(_ json: [String: Any]) {
        log.debug("Received initial tree")

        // Extract state
        if let state = json["state"] as? [String: Any] {
            log.debug("Initial tree has state with %d keys", state.count)
            stateSubject.send(state)
        } else {
            log.debug("Initial tree has no state")
        }

        // Extract and apply patches
        if let patchesArray = json["patches"] as? [[String: Any]] {
            let patches = Patch.fromArray(patchesArray)
            log.debug("Initial tree has %d patches", patches.count)
            patchesSubject.send(patches)
        } else {
            log.warn("Initial tree has NO patches array!")
        }
    }

    private func handlePatch(_ json: [String: Any]) {
        if let patchesArray = json["patches"] as? [[String: Any]] {
            let patches = Patch.fromArray(patchesArray)
            log.debug("Received patch message with %d patches", patches.count)
            patchesSubject.send(patches)
        } else {
            log.warn("Patch message has no patches array")
        }
    }

    private func handleStateUpdate(_ json: [String: Any]) {
        if let state = json["state"] as? [String: Any] {
            log.debug("Received state update")
            stateSubject.send(state)
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
