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
    /// The parsed ack plus its exact text (`sessionAck.device` is decoded
    /// from the text under the device JSON limits).
    case sessionAck([String: Any], text: Data)
    case sessionExpired([String: Any])
    case initialTree(state: [String: Any]?, patches: [Patch]?)
    case patch([Patch]?)
    case stateUpdate([String: Any]?)
    /// Device plane (RFC 001): raw `deviceRequest` / `deviceEvent` JSON,
    /// routed to the DeviceHost, never into the patch/state path.
    case device(Data)
    case unknown(type: String)
    /// Only the size is kept: the text could be a malformed `sessionAck`
    /// carrying a resume credential, so it is never logged.
    case unparseable(byteCount: Int)
}

/// WebSocket-based remote engine for Hypen.
///
/// Transport is `URLSessionWebSocketTask`. Note that WebSocket compression
/// (`permessage-deflate`) is offered automatically by URLSession and is not
/// configurable from this package — see the note in `establishConnection()`
/// for what that means when talking to the various Hypen server SDKs.
@MainActor
public final class RemoteEngine: NSObject, @unchecked Sendable {
    private let url: URL
    private let config: RemoteEngineConfig
    private let sessionOptions: SessionOptions?

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    /// Socket identity: generations, and at most one scheduled reconnect.
    private var lifecycle = RemoteConnectionLifecycle()

    /// Device Capability Protocol endpoint (RFC 001). When set, `hello`
    /// carries its advertisement, device messages and binary frames are
    /// routed to it, and it is detached on every socket close. Nil ⇒ legacy
    /// wire, byte-identical.
    private let device: DeviceEndpoint?
    /// Whether the device plane is attached to the current socket (false
    /// when the socket negotiated `permessage-deflate`, RFC 001 §2.3).
    private var deviceAttached = false
    private var reconnectTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?

    // Session state
    private var currentSessionId: String?
    /// Resume credential from the last `sessionAck` (RFC 001 §5). In memory
    /// only; never logged.
    private var resumeCredential = RemoteResumeCredential()

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

    /// - Parameter device: optional DeviceHost (RFC 001), e.g.
    ///   `DeviceHost.iOS()`, which binds its prompts and grants to this
    ///   socket's origin. The device plane works on an uncompressed socket
    ///   or one compressed per message (both no-context-takeover params,
    ///   which the Hypen servers negotiate by default); compression that
    ///   shares history across messages keeps the socket UI-only. Servers
    ///   negotiate the device plane by default;
    ///   one that configures an authenticator admits native clients through
    ///   `config.upgradeHeaders` (RFC 001 §5).
    public init(url: URL, config: RemoteEngineConfig = .default, sessionOptions: SessionOptions? = nil,
                device: DeviceEndpoint? = nil) {
        self.url = url
        self.config = config
        self.sessionOptions = sessionOptions
        self.currentSessionId = sessionOptions?.id
        self.device = device
        super.init()
    }

    public convenience init(urlString: String, config: RemoteEngineConfig = .default, sessionOptions: SessionOptions? = nil,
                            device: DeviceEndpoint? = nil) throws {
        guard let url = URL(string: urlString) else {
            throw RemoteEngineError.invalidURL(urlString)
        }
        self.init(url: url, config: config, sessionOptions: sessionOptions, device: device)
    }

    // MARK: - Connection Management

    /// Connect. A no-op while a socket is connecting or open, or while a
    /// reconnect is scheduled (e.g. `HypenView` calling it from `onAppear`).
    public func connect() {
        guard let generation = lifecycle.connect() else {
            log.debug("Already connected or connecting to %@", url.absoluteString)
            return
        }

        log.debug("Connecting to %@", url.absoluteString)
        connectionStateSubject.send(.connecting)
        establishConnection(generation)
    }

    public func disconnect() {
        log.debug("Disconnecting from %@", url.absoluteString)
        lifecycle.disconnect()
        detachDevice()
        tearDownSocket()
        connectionStateSubject.send(.disconnected)
    }

    /// Cancel the socket, its session, and its receive / ping / reconnect
    /// loops. Any callback it still delivers carries a stale generation.
    private func tearDownSocket() {
        cancelAllTasks()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    private func establishConnection(_ generation: UInt64) {
        log.debug("Establishing connection to %@", url.absoluteString)
        // A new socket never inherits device work from the old one (RFC 001
        // §2.5), and the old socket, session and loops are torn down so an
        // orphan can never deliver messages or close events.
        detachDevice()
        tearDownSocket()
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = config.connectTimeout
        sessionConfig.timeoutIntervalForResource = config.readTimeout

        let session = URLSession(configuration: sessionConfig, delegate: self, delegateQueue: nil)
        // Upgrade request: configured auth headers; `Origin` only when the
        // app sets one (RFC 001 §5, decision D1).
        let task = session.webSocketTask(with: RemoteUpgradeRequest.make(url: url, config: config))
        task.taskDescription = RemoteConnectionLifecycle.taskDescription(generation)
        urlSession = session
        webSocketTask = task
        // Compression (RFC 7692 `permessage-deflate`) is not configured here
        // because Apple gives us no knob to configure. It is handled entirely
        // inside URLSession, which is why `RemoteEngineConfig` has no
        // `compression` option where the other Hypen client SDKs do.
        //
        // What URLSession actually does: `URLSessionWebSocketTask` offers
        // `Sec-WebSocket-Extensions: permessage-deflate` in its opening
        // handshake on its own, and transparently inflates incoming compressed
        // frames if the server accepts. There is no public API to enable,
        // disable, or parameterise this — no property on the task, and the
        // `Sec-*` handshake headers cannot be set on the `URLRequest` (the
        // Network.framework layer underneath validates the server's response
        // against what *it* offered and fails the connection on a mismatch).
        //
        // Consequences worth knowing:
        //   * Connecting to a compression-enabled Hypen server (web / Go /
        //     Kotlin / Rust) means this client gets compressed frames for free,
        //     with no code change here. Nothing to opt into.
        //   * Connecting to `hypen-server-swift`, which declines the extension
        //     (SwiftNIO + WebSocketKit have no RFC 7692 support — see that
        //     package's README), the connection runs uncompressed. Negotiation
        //     is per-connection, so this is a clean fallback, not a failure.
        //   * We cannot opt *out* of compression. If a server misbehaves on
        //     compressed frames the fix belongs on the server.
        //
        // Historical note: on macOS 11 betas this task set the RSV1 frame bit
        // even when the server declined the extension, which strict servers
        // rejected as a protocol error (Apple radar 65668399). Fixed in macOS
        // 11 beta 3, well below this package's iOS 15 / macOS 12 floor.
        // URLSession caps a single WebSocket message at 1 MiB by default, and
        // a Hypen `initialTree` routinely exceeds that — any app embedding an
        // asset in state (a base64 wallpaper, an inlined image) blows past it
        // on the very first message. The receive then fails, the socket
        // closes, autoReconnect fires, and the app sits on "Connecting…"
        // reconnecting every few seconds with no error ever surfaced. Browsers
        // impose no such limit, so this only ever bit the native clients.
        task.maximumMessageSize = config.maximumMessageSize
        log.debug("WebSocket task created, resuming...")
        task.resume()

        startReceiving(task, generation: generation)
        startPingTimer(task, generation: generation)
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

    /// One receive loop per socket, bound to that socket: it never reads
    /// another socket, and drops whatever arrives once its socket is no
    /// longer current (so two loops can never interleave or reorder device
    /// messages).
    private func startReceiving(_ task: URLSessionWebSocketTask, generation: UInt64) {
        receiveTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self = self, self.lifecycle.isCurrent(generation) else { return }
                do {
                    let message = try await task.receive()
                    guard !Task.isCancelled, self.lifecycle.isCurrent(generation) else { return }
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
                        if let device = self.device, self.deviceAttached, Self.isDeviceFrame(data) {
                            // Binary device frame (RFC 001 §2.3), in socket order.
                            device.handleFrame(data)
                            decoded = nil
                        } else {
                            decoded = await Self.decodeMessage(text: nil, data: data)
                        }
                    @unknown default:
                        log.warn("Unknown message type received")
                        decoded = nil
                    }
                    // Decoding ran off-main: re-check that this socket is
                    // still the current one before dispatching.
                    if let decoded = decoded, self.lifecycle.isCurrent(generation) {
                        self.handleDecoded(decoded)
                    }
                } catch {
                    if !Task.isCancelled {
                        self.socketEnded(generation, error: error)
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
            return .unparseable(byteCount: payload?.count ?? 0)
        }

        log.debug("Message type: \(type)")

        switch type {
        case "sessionAck":
            return .sessionAck(json, text: payload)
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
        case "deviceRequest", "deviceEvent", "deviceResponse":
            // A server deviceResponse is routed too: on a live id the host
            // terminates that operation (RFC 001 §2.1, decision D8).
            return .device(payload)
        default:
            return .unknown(type: type)
        }
    }

    private func handleDecoded(_ message: DecodedRemoteMessage) {
        switch message {
        case .sessionAck(let json, let text):
            handleSessionAck(json, text: text)
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
        case .device(let data):
            // Without an attached endpoint, device traffic is dropped.
            if deviceAttached { device?.handleMessage(data) }
        case .unknown(let type):
            log.warn("Unknown message type: %@", type)
        case .unparseable(let byteCount):
            log.error("%@", RemoteLogRedaction.unparseable(byteCount: byteCount))
        }
    }

    private func handleSessionAck(_ json: [String: Any], text: Data) {
        guard let sessionId = json["sessionId"] as? String else {
            log.warn("Invalid sessionAck message: missing sessionId")
            return
        }

        let isNew = json["isNew"] as? Bool ?? true
        let isRestored = json["isRestored"] as? Bool ?? false

        log.debug("Session established: id=%@, isNew=%@, isRestored=%@", sessionId, String(isNew), String(isRestored))
        currentSessionId = sessionId
        // Servers issue a secret resume credential distinct from the public
        // session id (required to resume a session that had a device plane);
        // absent ⇒ legacy id-only resume.
        resumeCredential.acknowledge(sessionId: sessionId, resumeToken: json["resumeToken"])

        if let device = device, deviceAttached {
            // Absent or malformed `sessionAck.device` ⇒ device access disabled
            // for this socket; UI-only operation continues (RFC 001 §2.2).
            device.onAck(RemoteDevicePlane.deviceAck(fromSessionAckText: text))
        }

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
        resumeCredential.clear()

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

    /// - Parameter logContents: false for messages carrying credentials
    ///   (`hello.resumeToken`), which must never reach the log.
    private func sendMessage(_ message: [String: Any], logContents: Bool = true) {
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: .prettyPrinted),
              let text = String(data: data, encoding: .utf8) else {
            log.error("Failed to serialize message")
            return
        }

        if logContents {
            log.debug("Sending message: %@", String(text.prefix(200)))
        }

        webSocketTask?.send(.string(text)) { error in
            if let error = error {
                log.error("Send error: %@", error.localizedDescription)
            }
        }
    }

    /// Send hello message to establish session
    private func sendHello() {
        let message = RemoteHello.message(
            sessionId: currentSessionId ?? sessionOptions?.id,
            credential: resumeCredential,
            props: sessionOptions?.props,
            device: deviceAttached ? device?.advertisement : nil)

        log.debug("Sending hello message")
        // The hello may carry the resume credential: never log its contents.
        sendMessage(message, logContents: false)
    }

    // MARK: - Ping/Pong

    private func startPingTimer(_ task: URLSessionWebSocketTask, generation: UInt64) {
        let interval = config.pingInterval
        pingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled, let self = self, self.lifecycle.isCurrent(generation) else { return }
                task.sendPing { error in
                    if let error = error {
                        log.debug("Ping error: %@", error.localizedDescription)
                    }
                }
            }
        }
    }

    // MARK: - Error Handling & Reconnection

    /// The socket of `generation` ended: a failed receive and the close
    /// callback both report it, and a stale socket reports it too — only the
    /// first report for the current socket acts, and it schedules at most
    /// one reconnect.
    private func socketEnded(_ generation: UInt64, error: Error?) {
        let decision = lifecycle.ended(generation, autoReconnect: config.autoReconnect,
                                       maxAttempts: config.maxReconnectAttempts)
        guard decision != .ignore else { return }
        if let error = error {
            log.error("WebSocket error: %@", error.localizedDescription)
            errorsSubject.send(error)
        }
        // Socket gone: stop every device operation, release hardware,
        // dismiss prompts (RFC 001 §2.5).
        detachDevice()
        tearDownSocket()
        switch decision {
        case let .reconnect(attempt):
            scheduleReconnect(attempt: attempt)
        case .stop:
            if let error = error {
                connectionStateSubject.send(.error(message: error.localizedDescription))
            } else {
                connectionStateSubject.send(.disconnected)
            }
        case .ignore:
            break
        }
    }

    private func scheduleReconnect(attempt: Int) {
        connectionStateSubject.send(.reconnecting(attempt: attempt))
        log.debug("Scheduling reconnect attempt %d in %fs", attempt, config.reconnectInterval)

        reconnectTask?.cancel()
        let delay = config.reconnectInterval
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self = self,
                  let generation = self.lifecycle.reconnectFired() else { return }
            self.establishConnection(generation)
        }
    }

    /// The device host asked to close the connection (its control plane
    /// broke, or the server kept violating the protocol).
    fileprivate func closeFromDevice(generation: UInt64, code: Int, reason: String) {
        guard lifecycle.isCurrent(generation), let task = webSocketTask else { return }
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .protocolError
        task.cancel(with: closeCode, reason: Data(reason.utf8))
        socketEnded(generation, error: nil)
    }

}

// MARK: - Device plane (RFC 001)

extension RemoteEngine {
    private func attachDevice(to task: URLSessionWebSocketTask, generation: UInt64, sharedCompression: Bool) {
        guard let device = device else { return }
        detachDevice()
        guard !sharedCompression else {
            // RFC 001 §2.3: device traffic never shares a compression history
            // with other messages. Per-message compression (both
            // no-context-takeover parameters) is fine; anything else keeps
            // this connection UI-only.
            log.warn("Device plane disabled: socket negotiated permessage-deflate with context takeover (or it could not be inspected)")
            return
        }
        let transport = WebSocketDeviceTransport(
            task: task, origin: RemoteUpgradeRequest.origin(of: url)) { [weak self] code, reason in
            self?.closeFromDevice(generation: generation, code: code, reason: reason)
        }
        // The host may refuse a socket whose origin differs from the one it
        // is bound to; the hello then carries no device advertisement.
        deviceAttached = device.attach(transport)
    }

    private func detachDevice() {
        guard deviceAttached else { return }
        deviceAttached = false
        device?.detach()
    }

    /// Binary frames start with the version byte (1); a JSON document starts
    /// with `{` or whitespace (see `RemoteDevicePlane.isDeviceFrame`).
    nonisolated static func isDeviceFrame(_ data: Data) -> Bool {
        RemoteDevicePlane.isDeviceFrame(data)
    }

    /// Observation of the negotiated extensions from the 101 response.
    /// URLSession offers `permessage-deflate` on its own and has no opt-out.
    /// The reference servers compress by default with no context takeover in
    /// both directions, which the device plane allows; compression that
    /// shares history across messages keeps the socket UI-only. Fails closed:
    /// when the handshake response cannot be inspected, shared compression is
    /// assumed (RFC 001 §2.3).
    nonisolated static func negotiatedSharedCompression(_ task: URLSessionTask) -> Bool {
        let http = task.response as? HTTPURLResponse
        return RemoteDevicePlane.compressionSharesContext(
            responseAvailable: http != nil,
            extensionsHeader: http?.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"))
    }
}

/// Dedicated device route over the socket (RFC 001 §5): JSON device messages
/// as text frames, binary frames as data messages. Never the UI
/// `dispatchAction` path.
@MainActor
private final class WebSocketDeviceTransport: DeviceTransport {
    private weak var task: URLSessionWebSocketTask?
    let socketOrigin: String?
    private let close: @MainActor (Int, String) -> Void

    init(task: URLSessionWebSocketTask, origin: String, close: @escaping @MainActor (Int, String) -> Void) {
        self.task = task
        self.socketOrigin = origin
        self.close = close
    }

    func closeDeviceConnection(code: Int, reason: String) {
        close(code, reason)
    }

    func sendDeviceMessage(_ json: Data) {
        guard let task = task, task.state == .running else { return }
        task.send(.string(String(decoding: json, as: UTF8.self))) { @Sendable error in
            if let error = error {
                log.error("Device send error: %@", error.localizedDescription)
            }
        }
    }

    func sendDeviceBinary(_ frame: Data, completion: @escaping @Sendable @MainActor () -> Void) {
        guard let task = task, task.state == .running else {
            // Not handed to the transport: release its pending-bytes
            // accounting (§2.3) so bulk is not stalled for this socket.
            completion()
            return
        }
        task.send(.data(frame)) { @Sendable error in
            if let error = error {
                log.error("Device frame send error: %@", error.localizedDescription)
            }
            Task { @MainActor in completion() }
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
        let sharedCompression = Self.negotiatedSharedCompression(webSocketTask)
        let generation = RemoteConnectionLifecycle.generation(fromTaskDescription: webSocketTask.taskDescription)
        Task { @MainActor in
            // Only the current socket's open counts: a stale socket's open
            // must neither attach the device plane nor send a hello (which
            // would land on the current socket).
            guard let generation = generation, lifecycle.opened(generation),
                  let current = self.webSocketTask else { return }
            connectionStateSubject.send(.connected)

            // Attach the device plane to this socket's lifetime before hello.
            attachDevice(to: current, generation: generation, sharedCompression: sharedCompression)

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
        log.debug("WebSocket closed - code: %d", closeCode.rawValue)
        let generation = RemoteConnectionLifecycle.generation(fromTaskDescription: webSocketTask.taskDescription)
        Task { @MainActor in
            // A stale socket's close never touches the current one.
            guard let generation = generation else { return }
            socketEnded(generation, error: nil)
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
