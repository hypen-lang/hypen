import Foundation
import NIOCore
import NIOPosix
import WebSocketKit

/// Configuration for the RemoteEngine client.
public struct RemoteEngineConfig: Sendable {
    public var autoReconnect: Bool
    public var reconnectInterval: TimeInterval
    public var maxReconnectAttempts: Int

    public init(
        autoReconnect: Bool = true,
        reconnectInterval: TimeInterval = 3.0,
        maxReconnectAttempts: Int = 10
    ) {
        self.autoReconnect = autoReconnect
        self.reconnectInterval = reconnectInterval
        self.maxReconnectAttempts = maxReconnectAttempts
    }
}

/// Callback types for the RemoteEngine client.
public typealias PatchCallback = @Sendable ([Patch]) -> Void
public typealias StateCallback = @Sendable (Any) -> Void
public typealias VoidCallback = @Sendable () -> Void
public typealias ErrorCallback = @Sendable (Error) -> Void

/// Client that connects to a remote Hypen server over WebSocket.
///
/// Mirrors the Go `RemoteEngine` and the Swift `RemoteEngine` client
/// from `hypen-renderer-swift`.
///
/// ```swift
/// let engine = RemoteEngine("ws://localhost:3000/ws")
/// engine.onPatches { patches in
///     print("Received \(patches.count) patches")
/// }
/// engine.onStateUpdate { state in
///     print("New state: \(state)")
/// }
/// try engine.connect()
/// ```
public final class RemoteEngine: @unchecked Sendable {
    private let lock = NSLock()
    private let url: String
    private let options: RemoteEngineConfig

    private var ws: WebSocket?
    private var state: ConnectionState = .disconnected
    private var reconnectAttempts: Int = 0
    private var stopReconnect = false

    private var patchCallbacks: [PatchCallback] = []
    private var stateCallbacks: [StateCallback] = []
    private var connectionCallbacks: [VoidCallback] = []
    private var disconnectCallbacks: [VoidCallback] = []
    private var errorCallbacks: [ErrorCallback] = []

    private var currentState: Any?
    private var currentRevision: Int = 0
    private var moduleName: String = ""

    private var eventLoopGroup: EventLoopGroup?
    private let log = HypenLoggers.client

    public init(_ wsURL: String, options: RemoteEngineConfig? = nil) {
        self.url = wsURL
        self.options = options ?? RemoteEngineConfig()
    }

    // MARK: - Connection

    /// Connect to the remote server.
    public func connect() throws {
        lock.lock()
        if state == .connected || state == .connecting {
            lock.unlock()
            return
        }
        state = .connecting
        stopReconnect = false

        // Clean up previous event loop group on reconnect
        let previousELG = eventLoopGroup
        lock.unlock()

        if let prev = previousELG {
            try? prev.syncShutdownGracefully()
        }

        let elg = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        lock.lock()
        self.eventLoopGroup = elg
        lock.unlock()

        do {
            try WebSocket.connect(to: url, on: elg) { [weak self] ws in
                guard let self = self else { return }

                self.lock.lock()
                self.ws = ws
                self.state = .connected
                self.reconnectAttempts = 0
                self.lock.unlock()

                self.notifyConnect()

                ws.onText { [weak self] _, text in
                    self?.handleMessage(text)
                }

                ws.onClose.whenComplete { [weak self] _ in
                    guard let self = self else { return }
                    self.lock.lock()
                    self.ws = nil
                    self.state = .disconnected
                    self.lock.unlock()

                    self.notifyDisconnect()
                    self.attemptReconnect()
                }
            }.wait()
        } catch {
            lock.lock()
            state = .error
            eventLoopGroup = nil
            lock.unlock()

            try? elg.syncShutdownGracefully()
            notifyError(error)
            throw error
        }
    }

    /// Disconnect from the server.
    public func disconnect() {
        lock.lock()
        stopReconnect = true
        let currentWs = ws
        ws = nil
        state = .disconnected
        lock.unlock()

        _ = currentWs?.close()
        try? eventLoopGroup?.syncShutdownGracefully()
        eventLoopGroup = nil
    }

    /// Dispatch an action to the remote server.
    public func dispatchAction(_ action: String, payload: Any? = nil) {
        lock.lock()
        guard state == .connected, let ws = ws else {
            lock.unlock()
            return
        }
        let mName = moduleName
        lock.unlock()

        var msg: [String: Any] = [
            "type": "dispatchAction",
            "module": mName,
            "action": action
        ]
        if let p = payload {
            msg["payload"] = p
        }

        if let data = try? JSONSerialization.data(withJSONObject: msg),
           let json = String(data: data, encoding: .utf8) {
            ws.send(json)
        }
    }

    // MARK: - Callbacks

    @discardableResult
    public func onPatches(_ callback: @escaping PatchCallback) -> RemoteEngine {
        lock.lock()
        defer { lock.unlock() }
        patchCallbacks.append(callback)
        return self
    }

    @discardableResult
    public func onStateUpdate(_ callback: @escaping StateCallback) -> RemoteEngine {
        lock.lock()
        defer { lock.unlock() }
        stateCallbacks.append(callback)
        return self
    }

    @discardableResult
    public func onConnect(_ callback: @escaping VoidCallback) -> RemoteEngine {
        lock.lock()
        defer { lock.unlock() }
        connectionCallbacks.append(callback)
        return self
    }

    @discardableResult
    public func onDisconnect(_ callback: @escaping VoidCallback) -> RemoteEngine {
        lock.lock()
        defer { lock.unlock() }
        disconnectCallbacks.append(callback)
        return self
    }

    @discardableResult
    public func onError(_ callback: @escaping ErrorCallback) -> RemoteEngine {
        lock.lock()
        defer { lock.unlock() }
        errorCallbacks.append(callback)
        return self
    }

    // MARK: - Getters

    public func getConnectionState() -> ConnectionState {
        lock.lock()
        defer { lock.unlock() }
        return state
    }

    public func getCurrentState() -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return currentState
    }

    public func getRevision() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return currentRevision
    }

    // MARK: - Message Handling

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "initialTree":
            handleInitialTree(json)
        case "patch":
            handlePatch(json)
        case "stateUpdate":
            handleStateUpdate(json)
        default:
            break
        }
    }

    private func handleInitialTree(_ msg: [String: Any]) {
        lock.lock()
        moduleName = msg["module"] as? String ?? ""
        currentState = msg["state"]
        currentRevision = msg["revision"] as? Int ?? 0
        lock.unlock()

        if let patchesArray = msg["patches"] as? [[String: Any]], !patchesArray.isEmpty {
            let patches = decodePatchesFromJSON(patchesArray)
            notifyPatches(patches)
        }

        if let state = msg["state"] {
            notifyState(state)
        }
    }

    private func handlePatch(_ msg: [String: Any]) {
        let revision = msg["revision"] as? Int ?? 0

        lock.lock()
        if revision <= currentRevision {
            lock.unlock()
            log.warn("Out of order patch: expected > %d, got %d", currentRevision, revision)
            return
        }
        currentRevision = revision
        lock.unlock()

        if let patchesArray = msg["patches"] as? [[String: Any]], !patchesArray.isEmpty {
            let patches = decodePatchesFromJSON(patchesArray)
            notifyPatches(patches)
        }
    }

    private func handleStateUpdate(_ msg: [String: Any]) {
        lock.lock()
        currentState = msg["state"]
        if let revision = msg["revision"] as? Int, revision > currentRevision {
            currentRevision = revision
        }
        lock.unlock()

        if let state = msg["state"] {
            notifyState(state)
        }
    }

    // MARK: - Notifications

    private func notifyPatches(_ patches: [Patch]) {
        lock.lock()
        let callbacks = patchCallbacks
        lock.unlock()
        for cb in callbacks { cb(patches) }
    }

    private func notifyState(_ state: Any) {
        lock.lock()
        let callbacks = stateCallbacks
        lock.unlock()
        for cb in callbacks { cb(state) }
    }

    private func notifyConnect() {
        lock.lock()
        let callbacks = connectionCallbacks
        lock.unlock()
        for cb in callbacks { cb() }
    }

    private func notifyDisconnect() {
        lock.lock()
        let callbacks = disconnectCallbacks
        lock.unlock()
        for cb in callbacks { cb() }
    }

    private func notifyError(_ error: Error) {
        lock.lock()
        let callbacks = errorCallbacks
        lock.unlock()
        for cb in callbacks { cb(error) }
    }

    // MARK: - Reconnection

    private func attemptReconnect() {
        guard options.autoReconnect else { return }

        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }

            while true {
                self.lock.lock()
                if self.stopReconnect || self.reconnectAttempts >= self.options.maxReconnectAttempts {
                    self.lock.unlock()
                    if self.reconnectAttempts >= self.options.maxReconnectAttempts {
                        self.log.error("Max reconnection attempts reached")
                    }
                    return
                }
                self.reconnectAttempts += 1
                let attempt = self.reconnectAttempts
                self.lock.unlock()

                self.log.debug("Reconnecting (%d/%d)...", attempt, self.options.maxReconnectAttempts)
                Thread.sleep(forTimeInterval: self.options.reconnectInterval)

                do {
                    try self.connect()
                    return // Connected
                } catch {
                    self.log.error("Reconnection failed: %@", "\(error)")
                }
            }
        }
    }

    // MARK: - Helpers

    private func decodePatchesFromJSON(_ array: [[String: Any]]) -> [Patch] {
        return array.compactMap { dict in
            guard let type = dict["type"] as? String else { return nil }
            return Patch(
                type: type,
                id: dict["id"] as? String,
                elementType: dict["elementType"] as? String,
                props: (dict["props"] as? [String: Any])?.mapValues { AnyCodable($0) },
                name: dict["name"] as? String,
                value: (dict["value"]).map { AnyCodable($0) },
                text: dict["text"] as? String,
                parentId: dict["parentId"] as? String,
                beforeId: dict["beforeId"] as? String,
                eventName: dict["eventName"] as? String
            )
        }
    }
}
