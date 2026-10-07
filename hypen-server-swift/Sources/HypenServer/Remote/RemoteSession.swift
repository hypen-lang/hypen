import Foundation
import Dispatch
import NIOCore
import NIOWebSocket
import WebSocketKit
@preconcurrency import HypenEngine

// MARK: - Outgoing message types
//
// These mirror the wire protocol types the `RemoteServer` was inlining as
// `[String: Any]` dictionaries. Having them as explicit types makes the
// `SessionTransport.send(_:)` seam well-typed and lets alternate
// transports (SSE, in-memory, test fakes) decide their own serialisation.

/// Server → client messages emitted by a `RemoteSession`.
///
/// Marked `@unchecked Sendable` because the `[String: Any]` associated
/// values carry serialised state and patch payloads — arbitrary JSON-
/// shaped data the engine hands us that we only ever read to pipe into
/// `JSONSerialization.data(withJSONObject:)`. The payload is never
/// mutated after construction and is copied into a JSON blob before
/// crossing any actor boundary, so the usual Sendable caveats
/// (`Any`-typed storage can hide reference-type sharing) don't apply
/// to our usage. Swift's strict concurrency checker can't prove that,
/// so we assert it with `@unchecked Sendable` rather than wrap every
/// value in a bespoke `AnyCodable` shim (which would be a much bigger,
/// more invasive change for zero runtime benefit).
public enum OutgoingMessage: @unchecked Sendable {
    /// `resumeToken` (RFC 001 §5) is issued in every ack; `device` (the
    /// negotiated `sessionAck.device` selection as JSON text, from the Rust
    /// `deviceHandshake`) is present only when a device plane was negotiated.
    case sessionAck(sessionId: String, isNew: Bool, isRestored: Bool, resumeToken: String? = nil, device: String? = nil)
    case sessionExpired(sessionId: String, reason: String)
    case initialTree(module: String, state: [String: Any], patches: [[String: Any]], revision: Int)
    case patch(module: String, patches: [[String: Any]], revision: Int)
    case stateUpdate(module: String, state: [String: Any], revision: Int)

    /// Serialise to a JSON string matching the wire protocol.
    public func toJSONString() -> String {
        let dict = toDictionary()
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }

    /// Raw dictionary representation (in case a transport wants MessagePack, protobuf, etc.).
    public func toDictionary() -> [String: Any] {
        switch self {
        case let .sessionAck(sessionId, isNew, isRestored, resumeToken, device):
            var ack: [String: Any] = [
                "type": "sessionAck",
                "sessionId": sessionId,
                "isNew": isNew,
                "isRestored": isRestored,
            ]
            if let resumeToken { ack["resumeToken"] = resumeToken }
            if let device,
               let value = try? JSONSerialization.jsonObject(with: Data(device.utf8)) {
                ack["device"] = value
            }
            return ack
        case let .sessionExpired(sessionId, reason):
            return [
                "type": "sessionExpired",
                "sessionId": sessionId,
                "reason": reason,
            ]
        case let .initialTree(module, state, patches, revision):
            return [
                "type": "initialTree",
                "module": module,
                "state": state,
                "patches": patches,
                "revision": revision,
            ]
        case let .patch(module, patches, revision):
            return [
                "type": "patch",
                "module": module,
                "patches": patches,
                "revision": revision,
            ]
        case let .stateUpdate(module, state, revision):
            return [
                "type": "stateUpdate",
                "module": module,
                "state": state,
                "revision": revision,
            ]
        }
    }
}

// MARK: - SessionTransport

/// Minimal seam a `RemoteSession` uses to reach its client. Implement
/// this to back sessions with any transport — WebSocketKit, raw NIO,
/// server-sent events, an in-memory channel, anything.
///
/// `send(_:)` may be invoked concurrently; implementations must
/// serialise writes if the underlying connection requires it.
public protocol SessionTransport: AnyObject, Sendable {
    func send(_ message: OutgoingMessage) throws
    func close(code: UInt16, reason: String)
}

/// A transport that can also carry the Device Capability Protocol (RFC
/// 001): device JSON text and binary frames on DEDICATED routes — never as
/// an `OutgoingMessage`, so the device plane stays out of broadcasts and
/// state fan-out — plus the transport's buffered byte count for the
/// broker's bulk scheduling (§2.3). A session on a plain `SessionTransport`
/// never negotiates a device plane.
///
/// The device plane calls these in broker order, but from several threads
/// (the connection's event loop, the device clock's queue, handler tasks);
/// an implementation must put messages and frames on the wire in exactly
/// the order its methods were called — a download frame that overtakes an
/// earlier one fails the transfer at the client.
public protocol DeviceTransport: SessionTransport {
    /// One server → client device JSON message.
    func sendDeviceText(_ text: String)
    /// Whether binary frames can be sent (downloads, e.g. `file.save`).
    var carriesBinary: Bool { get }
    /// One server → client binary frame.
    func sendBinary(_ frame: Data)
    /// Bytes accepted for sending but not yet written to the socket.
    func bufferedAmount() -> Int
}

/// Wraps a `WebSocketKit` `WebSocket` as a `SessionTransport` (and a
/// `DeviceTransport`). Encodes messages as JSON text frames.
///
/// Writes reach the socket in exactly the order `send` / `sendDeviceText` /
/// `sendBinary` / `close` were called, whichever thread called them. That
/// is not what a bare `ws.send` gives: NIO writes immediately when called
/// on the channel's event loop, but from any other thread it queues the
/// write with `eventLoop.execute`, so a frame sent on the loop can overtake
/// frames still queued from another thread. The device plane sends from
/// the loop (the pump after an incoming credit grant), from the clock's
/// dispatch queue (bulk turns, timers) and from handler tasks, all in broker
/// order under its lock — and a download whose frames arrive out of order
/// fails at the client (`download seq N, expected M`). So every write goes
/// through one FIFO outbox drained on the event loop: a caller on the loop
/// drains inline (after anything queued before it), any other caller
/// schedules a drain.
///
/// Every write's size is counted from the moment it is accepted until its
/// write promise completes; that is the buffered amount the device broker
/// schedules bulk frames against.
public final class WebSocketKitTransport: DeviceTransport, @unchecked Sendable {
    public let ws: WebSocket
    private let lock = NSLock()
    private var buffered = 0

    private enum Outbound {
        case text(String)
        case binary(Data)
        case close(UInt16)
    }

    /// Accepted but not yet handed to the socket, in call order.
    private var outbox: [(item: Outbound, size: Int)] = []
    /// A drain is scheduled on the event loop and has not taken the outbox yet.
    private var drainScheduled = false
    /// A drain is running on the event loop (guards re-entrant sends made
    /// from inside a write, which must queue behind the current batch).
    private var draining = false

    public init(_ ws: WebSocket) { self.ws = ws }

    public func send(_ message: OutgoingMessage) throws {
        sendText(message.toJSONString())
    }

    public func sendDeviceText(_ text: String) {
        sendText(text)
    }

    public var carriesBinary: Bool { true }

    public func sendBinary(_ frame: Data) {
        enqueue(.binary(frame), size: frame.count)
    }

    public func bufferedAmount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return buffered
    }

    public func close(code: UInt16, reason: String) {
        // The close code reaches the client (e.g. 1012 when the device
        // plane resets, so it reconnects with a full advertisement). Close
        // reasons aren't surfaced over the WebSocket close frame here —
        // callers should prefer pushing an in-band `sessionExpired` message
        // first (RemoteSession.expireAndClose does this). The close is
        // ordered after every frame sent before it.
        _ = reason
        enqueue(.close(code), size: 0)
    }

    private func sendText(_ text: String) {
        enqueue(.text(text), size: text.utf8.count)
    }

    private func enqueue(_ item: Outbound, size: Int) {
        let onLoop = ws.eventLoop.inEventLoop
        lock.lock()
        outbox.append((item, size))
        buffered += size
        // On the loop: drain inline unless a drain is already running
        // further up this stack (it picks the new entry up after its batch).
        let drainNow = onLoop && !draining
        if drainNow { draining = true }
        let schedule = !onLoop && !drainScheduled
        if schedule { drainScheduled = true }
        lock.unlock()

        if drainNow {
            drainLoop()
        } else if schedule {
            ws.eventLoop.execute { [self] in
                lock.lock()
                // Scheduled drains never run concurrently with an inline
                // one (both are on the loop), but one may be running
                // re-entrantly further up the stack: leave it to that one.
                let run = !draining
                if run { draining = true }
                lock.unlock()
                if run { drainLoop() }
            }
        }
    }

    /// Hand the outbox to the socket in order. On the event loop, with
    /// `draining` set by the caller.
    private func drainLoop() {
        while true {
            lock.lock()
            let batch = outbox
            outbox.removeAll(keepingCapacity: true)
            drainScheduled = false
            if batch.isEmpty {
                draining = false
                lock.unlock()
                return
            }
            lock.unlock()
            for entry in batch {
                write(entry.item, size: entry.size)
            }
        }
    }

    private func write(_ item: Outbound, size: Int) {
        switch item {
        case .text(let text):
            ws.send(text, promise: track(size))
        case .binary(let frame):
            ws.send(raw: frame, opcode: .binary, promise: track(size))
        case .close(let code):
            _ = ws.close(code: WebSocketErrorCode(codeNumber: Int(code)))
        }
    }

    private func track(_ size: Int) -> EventLoopPromise<Void> {
        let promise = ws.eventLoop.makePromise(of: Void.self)
        promise.futureResult.whenComplete { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.buffered -= size
            self.lock.unlock()
        }
        return promise
    }
}

/// In-memory transport that buffers outgoing messages and exposes them
/// via an `AsyncStream`. Natural for tests and for bridging to streaming
/// HTTP transports (SSE, HTTP/2 push).
///
/// ```swift
/// let transport = AsyncStreamTransport()
/// let session = try server.createSession(transport: transport)
/// for await msg in transport.stream {
///     // forward msg to your HTTP response
/// }
/// ```
public final class AsyncStreamTransport: SessionTransport, @unchecked Sendable {
    public let stream: AsyncStream<OutgoingMessage>
    private let continuation: AsyncStream<OutgoingMessage>.Continuation
    private let lock = NSLock()
    private var closed = false

    public init(bufferingPolicy: AsyncStream<OutgoingMessage>.Continuation.BufferingPolicy = .unbounded) {
        var cont: AsyncStream<OutgoingMessage>.Continuation!
        self.stream = AsyncStream(OutgoingMessage.self, bufferingPolicy: bufferingPolicy) { c in
            cont = c
        }
        self.continuation = cont
    }

    public func send(_ message: OutgoingMessage) throws {
        lock.lock()
        let isClosed = closed
        lock.unlock()
        if isClosed { return }
        continuation.yield(message)
    }

    public func close(code: UInt16, reason: String) {
        _ = code
        _ = reason
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        lock.unlock()
        continuation.finish()
    }
}

// MARK: - SessionHost

/// The subset of `RemoteServer` state a `RemoteSession` needs. Kept as a
/// protocol so sessions can be unit-tested against fakes and so
/// alternate hosts (e.g. a Cloudflare Durable Object wrapper) can
/// satisfy it without subclassing `RemoteServer`.
public protocol SessionHost: AnyObject, Sendable {
    var moduleName: String { get }
    var uiTemplate: String { get }
    var resourceMaps: [[String: String]] { get }
    var componentSources: [(name: String, source: String, path: String)] { get }
    var appRegistry: HypenApp { get }
    var sessionManager: SessionManager { get }

    /// Build (or return) the primary `ModuleDefinition` to use for a new
    /// session. Hosts that accept both the typed `module(_:_:)` builder
    /// and the untyped `withState(_:_:)` path compose the right
    /// definition here.
    func makeModuleDefinition() -> ModuleDefinition

    /// Legacy untyped action handler shim (non-nil only when the host
    /// was configured via `withState(_:_:)` + `onAction(_:)` without a
    /// typed `ModuleDefinition`).
    var legacyActionHandler: ActionHandler? { get }

    /// Fired after a session's hello → initialTree flow completes.
    func onSessionReady(_ session: RemoteSession, client: ClientInfo)

    /// Fired at the end of `session.destroy()`.
    func onSessionDestroyed(_ session: RemoteSession, client: ClientInfo)

    /// Device Capability Protocol settings (RFC 001). The device plane is on
    /// by default (the default implementation returns the default options);
    /// nil = the host opted out and no session negotiates a device plane.
    var deviceOptions: DeviceServerOptions? { get }

    /// The process-wide retained-bytes pool every connection's broker
    /// shares (nil = per-connection budgets only).
    var deviceRetainedBytesPool: DeviceRetainedBytesPool? { get }
}

extension SessionHost {
    public var deviceOptions: DeviceServerOptions? { DeviceServerOptions() }
    public var deviceRetainedBytesPool: DeviceRetainedBytesPool? { nil }
}

/// Device Capability Protocol settings of a server (RFC 001); the defaults
/// apply unless `RemoteServer.configureDevice(_:)` supplies others.
public struct DeviceServerOptions: Sendable {
    /// Per-connection retained-bytes budget (uploads buffered for handlers);
    /// smaller than the default also caps every revision's item size.
    public var maxRetainedBytes: UInt64?
    /// Lifetime of the connection-owned `core.capabilities` stream before
    /// its planned reopen.
    public var controlStreamTimeoutMs: UInt64?
    /// How long a device-capable connection (a `DeviceTransport`) without a
    /// hello grace may take to send its `hello` before it is closed (1008).
    public var helloTimeoutMs: Int
    /// Monotonic clock + timers driving the broker (inject a manual clock
    /// in tests).
    public var clock: DeviceClock
    /// Registry revision replacements for this server's brokers — e.g. a
    /// revision that also allows the `background` lifetime (RFC 001 §2.7).
    public var revisionOverrides: [DeviceRevisionOverride]
    /// Module instances one connection may pin with live `background` work
    /// (the broker's pin cap; default `DeviceProtocol.maxBackgroundPinnedModules`).
    /// A background request from a further module is refused `throttled`.
    public var maxBackgroundOwners: Int?

    public init(
        maxRetainedBytes: UInt64? = nil,
        controlStreamTimeoutMs: UInt64? = nil,
        helloTimeoutMs: Int = 30_000,
        clock: DeviceClock = SystemDeviceClock(),
        revisionOverrides: [DeviceRevisionOverride] = [],
        maxBackgroundOwners: Int? = nil
    ) {
        self.maxRetainedBytes = maxRetainedBytes
        self.controlStreamTimeoutMs = controlStreamTimeoutMs
        self.helloTimeoutMs = helloTimeoutMs
        self.clock = clock
        self.revisionOverrides = revisionOverrides
        self.maxBackgroundOwners = maxBackgroundOwners
    }
}

extension DeviceServerOptions {
    /// The Rust broker configuration (`device_binding` "Config JSON") for a
    /// connection that negotiated `ack`.
    func brokerConfigJSON(ack: String) throws -> String {
        var config = "{\"ack\":\(ack)"
        if let budget = maxRetainedBytes {
            config += ",\"maxRetainedBytes\":\(budget)"
            // Advertise only limits the host can honor (§2.4): a smaller
            // retained budget also caps every revision's item size.
            config += ",\"maxItemBytes\":\(budget)"
        }
        if let t = controlStreamTimeoutMs { config += ",\"controlStreamTimeoutMs\":\(t)" }
        if let n = maxBackgroundOwners { config += ",\"maxBackgroundOwners\":\(max(0, n))" }
        if !revisionOverrides.isEmpty {
            config += ",\"revisionOverrides\":" + (try DeviceBrokerJSON.encode(revisionOverrides))
        }
        return config + "}"
    }

    /// Build a broker with these options for the full server advertisement,
    /// so a misconfiguration passed to `configureDevice` (an override of an
    /// unknown revision, a limit the broker rejects) fails
    /// `RemoteServer.prepare()` instead of disabling the device plane on
    /// every connection.
    func validateAgainstBroker() throws {
        let hello = "{\"protocolVersions\":[\(DeviceProtocol.version)],\"binary\":true,\"capabilities\":"
            + deviceServerAdvertisementJson() + "}"
        guard let ack = deviceNegotiate(helloJson: hello, binaryRoute: true) else {
            throw RemoteServerError.invalidDeviceOptions("the server advertisement does not negotiate")
        }
        do {
            let broker = try DeviceBroker(configJson: try brokerConfigJSON(ack: ack), pool: nil, nowMs: 0)
            try broker.close(code: DeviceErrorCode.connectionLost.rawValue)
        } catch let error as RemoteServerError {
            throw error
        } catch {
            throw RemoteServerError.invalidDeviceOptions("\(error)")
        }
    }
}

// MARK: - Reserved dispatch payload keys

/// The cross-boundary payload key TypeScript renderers use to carry an
/// event applicator's `animate:` transaction-animation stamp (Option D)
/// across `dispatchAction`. It is a renderer→host directive, never handler
/// data: TS hosts lift it into a distinct Action field; the Swift host does
/// not implement transaction stamping, so the key is stripped here —
/// module handlers must never observe it either way.
///
/// Mirrors `reservedAnimateKey` (`hypen-golang/remote/session.go`) and
/// `RESERVED_ANIMATE_KEY` (`hypen-kotlin/.../core/HypenServer.kt`).
let reservedAnimateKey = "__hypenAnimate"

/// Removes the reserved transaction-animation stamp from a decoded dispatch
/// payload, if present. Non-dictionary payloads (including `nil`) pass
/// through untouched, and so does a plain user-data `animate` key — only the
/// reserved key is a directive.
func stripReservedAnimateKey(_ payload: Any?) -> Any? {
    guard var dict = payload as? [String: Any],
          dict.keys.contains(reservedAnimateKey) else {
        return payload
    }
    dict.removeValue(forKey: reservedAnimateKey)
    return dict
}

// MARK: - RemoteSession

/// One client's worth of server-side state. Transport-agnostic.
///
/// Owns a dedicated `NativeEngine` + `ModuleInstance` and runs the full
/// Hypen remote protocol (`hello` → `sessionAck` → `initialTree` →
/// streaming `patch`/`stateUpdate` messages) through its
/// `SessionTransport`.
///
/// Typical usage from a transport adapter:
///
/// ```swift
/// let session = try server.createSession(transport: transport)
/// ws.onText { _, text in session.receive(text) }
/// ws.onClose.whenComplete { _ in Task { await session.destroy() } }
/// ```
public final class RemoteSession: @unchecked Sendable {
    public let id: String
    public let connectedAt: Date

    private let host: SessionHost
    private let transport: SessionTransport

    private let lock = NSLock()
    private var sessionID: String? = nil
    private var revision: Int = 0
    private var helloReceived = false
    /// True once the hello → sessionAck → initialTree flow has completed
    /// and the engine's declaration tables (actions, routes, bindings)
    /// are populated by the initial render. `sessionID` is assigned
    /// earlier in that flow, so `attach` gates on this rather than on
    /// the id alone.
    private var ready = false
    private var helloTimeoutWork: DispatchWorkItem? = nil
    private var moduleInstance: ModuleInstance? = nil
    private var engine: NativeEngine? = nil
    private var destroyed = false
    private var onClosedCallbacks: [() -> Void] = []
    /// Per-session ManagedRouter auto-wired from `Router {}` blocks
    /// found in the primary template. Nil when auto-wiring is off or
    /// no Routers were discovered. Torn down in destroy().
    private var autoManagedRouter: ManagedRouter? = nil
    /// Toggled by `RemoteServer.disableAutoRouter()` when the host
    /// wants to wire a ManagedRouter by hand via `onSessionCreate`.
    var autoRouterEnabled: Bool = true
    /// The connection's device plane (RFC 001), once negotiated.
    private var devicePlane: DevicePlane? = nil
    /// The resume credential issued in this connection's `sessionAck`.
    private var issuedResumeToken: String? = nil

    private static let counter = Counter()
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n: UInt64 = 0
        func next() -> UInt64 { lock.lock(); defer { lock.unlock() }; n += 1; return n }
    }

    /// Create a session bound to `transport`.
    ///
    /// - Parameters:
    ///   - host: the `SessionHost` (typically a `RemoteServer`).
    ///   - transport: backs `send` and `close`.
    ///   - id: optional override for the client id (auto-generated otherwise).
    ///   - helloGraceMs: milliseconds to wait for the client's first `hello`
    ///     message before auto-initialising as a legacy (no-sessionId)
    ///     connection. `nil` disables the auto-init entirely — useful
    ///     for transports where the first message may be deliberately
    ///     delayed (e.g. SSE: the client hellos via a separate POST).
    ///     Applies whether or not the host has the device plane on; a
    ///     grace-initialised session has no device plane. Without a grace
    ///     window, a `DeviceTransport` connection on a device-capable host
    ///     is closed (1008) after `DeviceServerOptions.helloTimeoutMs`.
    public init(
        host: SessionHost,
        transport: SessionTransport,
        id: String? = nil,
        helloGraceMs: Int? = nil
    ) {
        self.id = id ?? "client_\(Self.counter.next())"
        self.connectedAt = Date()
        self.host = host
        self.transport = transport

        // Eagerly build the engine + moduleInstance so that any state
        // mutations from `onCreated` propagate into the engine before
        // we render. Matches the existing RemoteServer flow where these
        // were constructed in `handleOpen` (not in `handleMessage(hello)`).
        do {
            try buildEngineAndModuleInstance()
        } catch {
            HypenLoggers.server.error("Failed to build engine for %@: %@", self.id, "\(error)")
        }

        // Hello grace applies regardless of the device plane: a legacy
        // client that never sends `hello` is auto-initialised after the
        // grace period, and a session initialised by grace simply has no
        // device plane (its first message was not a hello offering
        // `device`). Without a grace window, a device-capable connection is
        // bounded by the handshake timeout instead (RFC 001 §2.2).
        let graceMs = (helloGraceMs ?? 0) > 0 ? helloGraceMs : nil
        if graceMs == nil, transport is DeviceTransport,
           let opts = sessionDeviceOptions, opts.helloTimeoutMs > 0 {
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.lock.lock()
                let waiting = !self.helloReceived && !self.destroyed
                self.lock.unlock()
                if waiting { self.transport.close(code: 1008, reason: "hello timeout") }
            }
            lock.lock()
            helloTimeoutWork = work
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(opts.helloTimeoutMs), execute: work)
        }

        if let ms = graceMs {
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.lock.lock()
                if self.helloReceived || self.destroyed {
                    self.lock.unlock()
                    return
                }
                self.lock.unlock()
                self.initializeSession(requestedSessionId: nil, props: [:])
            }
            lock.lock()
            helloTimeoutWork = work
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms), execute: work)
        }
    }

    /// The host's device options for this session, or nil when the device
    /// plane is off: the host opted out, or its concurrent-session policy
    /// fans one session out to several connections (`.allowMultiple`),
    /// which a per-connection device plane cannot follow.
    private var sessionDeviceOptions: DeviceServerOptions? {
        guard host.sessionManager.config.concurrent != .allowMultiple else { return nil }
        return host.deviceOptions
    }

    // MARK: - Public accessors

    /// The Hypen session id, once hello has completed. Empty before then.
    public var currentSessionID: String? {
        lock.lock(); defer { lock.unlock() }; return sessionID
    }

    /// Whether the client has completed its handshake.
    public var helloIsReceived: Bool {
        lock.lock(); defer { lock.unlock() }; return helloReceived
    }

    /// Whether hello → sessionAck → initialTree has fully completed, so
    /// the session id is assigned *and* the initial render has populated
    /// the engine's declaration tables. This — not `currentSessionID`
    /// alone — is what `RemoteServer.attach(_:)` requires: before the
    /// initial render `listActions()` would be empty and every external
    /// dispatch refused. Never flips back to false; pair with
    /// `isDestroyed` for liveness.
    public var isReady: Bool {
        lock.lock(); defer { lock.unlock() }; return ready
    }

    /// Current render revision for this session.
    public var currentRevision: Int {
        lock.lock(); defer { lock.unlock() }; return revision
    }

    /// Snapshot of the current module state.
    public func currentState() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return moduleInstance?.getState() ?? [:]
    }

    /// Replace this session's module state. Fires the onChange →
    /// engine.updateState → patch-callback wiring wired up in
    /// `buildEngineAndModuleInstance`, so a `patch` message streams out
    /// through the transport. Exposed for `RemoteServer.broadcastState`
    /// style APIs.
    public func replaceState(_ state: [String: Any]) {
        lock.lock()
        let mi = moduleInstance
        lock.unlock()
        mi?.state.replace(state)
    }

    /// Merge a patch into the primary module's state without replacing
    /// the entire snapshot. Intended for out-of-band writes from
    /// per-session helpers (e.g. mirroring a ManagedRouter path into
    /// `state.location`) that don't originate from an action handler.
    public func updatePrimaryState(_ patch: [String: Any]) {
        lock.lock()
        let mi = moduleInstance
        lock.unlock()
        guard let mi = mi else { return }
        for (key, value) in patch {
            mi.state.set(key, value)
        }
    }

    /// Bump and return this session's revision counter. Exposed for
    /// `RemoteServer.broadcast*` helpers that need to stamp explicit
    /// `stateUpdate` / `patch` messages.
    public func incrementRevision() -> Int {
        lock.lock(); defer { lock.unlock() }; revision += 1; return revision
    }

    /// The per-session native engine. Built in `init` before this
    /// reference returns, so is safe to use from `onSessionCreate`
    /// callbacks without waiting for a "ready" signal.
    public var nativeEngine: NativeEngine? {
        lock.lock(); defer { lock.unlock() }; return engine
    }

    /// Whether this session has been torn down. After `true`, no
    /// further patches will stream and the engine is gone.
    public var isDestroyed: Bool {
        lock.lock(); defer { lock.unlock() }; return destroyed
    }

    /// Register a callback that fires once `destroy()` finishes its
    /// teardown (or immediately if already destroyed). Used by
    /// `onSessionCreate` wiring to stop per-session helpers like a
    /// `ManagedRouter` without polling.
    public func onClosed(_ callback: @escaping () -> Void) {
        lock.lock()
        if destroyed {
            lock.unlock()
            callback()
            return
        }
        onClosedCallbacks.append(callback)
        lock.unlock()
    }

    // MARK: - Protocol entry points

    /// The top-level `type`s of the Device Capability Protocol (RFC 001
    /// §2.1). A client text announcing any of them goes to the connection's
    /// broker as its exact text, never to the UI dispatch path.
    static let deviceMessageTypes: Set<String> = ["deviceRequest", "deviceResponse", "deviceEvent"]

    /// Feed a raw client → server text message into this session.
    public func receive(_ text: String) {
        lock.lock()
        let destroyedLocal = destroyed
        let plane = devicePlane
        lock.unlock()
        if destroyedLocal { return }

        // Device JSON limits start BEFORE parsing (RFC 001 §2.1, D4): an
        // over-limit text announcing itself as a device message is dropped
        // unparsed — a connection-level violation, attributable to no
        // request.
        if let plane, deviceIsOversizeText(text: text) {
            plane.reportViolation("device message over 1 MiB")
            return
        }

        // Route by the top-level `type` member alone, resolved as
        // `JSON.parse` resolves it (the last `type` wins) and nothing else
        // validated: device messages go to the broker as their exact text,
        // which strictly decodes them. Malformed device JSON — a duplicated
        // `type` or `id`, number spellings, depth, even text that is not
        // JSON after its `type` — therefore reaches the broker and counts
        // against the connection's violation budget (D3/D4/D8), exactly as
        // on the TypeScript server; it is never dropped on the way.
        //
        // EVERY device message type is routed — including a client-sent
        // `deviceRequest`, which only the server may send: the broker judges
        // it (liveness before direction, D8): on a live id it is a
        // wrong-direction violation that terminates that request
        // (`invalidParams`, `cancel` sent); on an unknown/retired id it is
        // ignored. Dropping it here would hide the violation.
        let routedType = deviceMessageType(text)
        if let routedType, RemoteSession.deviceMessageTypes.contains(routedType) {
            // Absent broker ⇒ device plane disabled ⇒ drop.
            plane?.receiveText(text)
            return
        }

        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = routedType ?? (json["type"] as? String) else {
            return
        }

        switch type {
        case "hello":
            let requestedSessionId = json["sessionId"] as? String
            let props = (json["props"] as? [String: Any]) ?? [:]
            // The device advertisement is read from the hello's exact text
            // (the `device` member's raw span), never from the
            // JSONSerialization value, which collapses duplicate keys.
            var deviceHello: String? = nil
            if sessionDeviceOptions != nil, case .found(let raw) = deviceFindTopLevelMember(text, "device") {
                deviceHello = raw
            }
            initializeSession(
                requestedSessionId: (requestedSessionId?.isEmpty ?? true) ? nil : requestedSessionId,
                props: props,
                deviceHello: deviceHello,
                resumeToken: json["resumeToken"] as? String
            )

        case "dispatchAction", "action":
            // Security admission (RFC 001 §5): a socket that has not
            // completed the hello handshake may not dispatch.
            if !helloIsReceived { return }
            let name = (json["action"] as? String) ?? (json["name"] as? String) ?? ""
            let payload = json["payload"]
            handleDispatchAction(actionName: name, payload: payload)

        default:
            // Unknown — ignore for forward compatibility.
            break
        }
    }

    /// Feed one client → server binary WebSocket frame (a device data-plane
    /// frame, RFC 001 §2.3). Dropped when no device plane is negotiated.
    public func receiveBinary(_ frame: Data) {
        lock.lock()
        let plane = destroyed ? nil : devicePlane
        lock.unlock()
        plane?.receiveFrame(frame)
    }

    /// The connection's device plane, when one was negotiated (RFC 001).
    public var device: DevicePlane? {
        lock.lock(); defer { lock.unlock() }; return devicePlane
    }

    /// Dispatch an action on this session as a replayed / broadcast-derived
    /// dispatch (RFC 001 §1.7): its handlers run normally, but every device
    /// call they make fails `unavailable` — replay cannot initiate device
    /// work on this connection.
    public func dispatchReplayed(_ name: String, payload: Any? = nil) {
        DeviceProvenance.$current.withValue(.replay) {
            handleDispatchAction(actionName: name, payload: payload)
        }
    }

    /// Send a server → client message. Exposed so a `RemoteServer` can
    /// broadcast to every live session via `session.send(...)`.
    public func send(_ message: OutgoingMessage) {
        lock.lock()
        if destroyed { lock.unlock(); return }
        lock.unlock()
        do {
            try transport.send(message)
        } catch {
            HypenLoggers.server.error("Session %@ send failed: %@", id, "\(error)")
        }
    }

    /// Tear down the session. Runs `onDisconnect`, suspends the Hypen
    /// session for later resumption (TTL permitting), closes the engine,
    /// and notifies the host. Idempotent.
    public func destroy() {
        lock.lock()
        if destroyed { lock.unlock(); return }
        destroyed = true
        helloTimeoutWork?.cancel()
        helloTimeoutWork = nil
        let sid = sessionID
        let mi = moduleInstance
        let savedState = mi?.getState() ?? [:]
        let plane = devicePlane
        devicePlane = nil
        lock.unlock()

        // Device broker teardown BEFORE module teardown: loss of broker state
        // is a connection reset (RFC 001 §2.5). Every in-flight device call
        // settles locally with connectionLost; nothing is sent (the socket
        // is going). Resuming app state never resumes device operations.
        if let plane {
            plane.close(.connectionLost)
            for instance in liveModuleInstances() { instance.attachDevice(nil) }
        }

        let sm = host.sessionManager
        if let sid = sid, let session = sm.getActiveSession(sid) {
            sm.untrackConnection(sid, connectionId: ObjectIdentifier(self))
            if sm.getConnectionCount(sid) == 0 {
                let info = session.toSessionInfo()
                // Fire onDisconnect on the live ModuleInstance before we
                // suspend — the user gets a chance to do cleanup while
                // state is still in memory.
                mi?.handleDisconnect(session: info)
                // Suspend; if the TTL elapses before reconnection, fire
                // onExpire and tear the engine down. If the client
                // reconnects in time, the timer is cancelled and this
                // closure never runs.
                sm.suspendSession(sid, savedState: savedState) {
                    mi?.handleExpire(session: info)
                    mi?.destroy()
                }
            }
            // else: other connections share this session; leave alone.
        } else {
            // No session was ever established (hello never arrived).
            mi?.destroy()
        }

        lock.lock()
        let managed = autoManagedRouter
        autoManagedRouter = nil
        lock.unlock()
        managed?.stop()

        host.onSessionDestroyed(self, client: ClientInfo(id: id, connectedAt: connectedAt))

        // Fire onClosed subscribers exactly once. Grabs + clears under
        // the lock so a late `onClosed` registration (which sees
        // `destroyed == true` and invokes immediately) can't double-fire.
        lock.lock()
        let callbacks = onClosedCallbacks
        onClosedCallbacks.removeAll()
        lock.unlock()
        for cb in callbacks { cb() }
    }

    /// Notify the client that their session has ended and close the
    /// transport. Used by peer-routing (e.g. `kickOld` concurrent
    /// policy) to evict duplicate sessions in-band.
    public func expireAndClose(reason: String) {
        if let sid = currentSessionID {
            send(.sessionExpired(sessionId: sid, reason: reason))
        }
        transport.close(code: 1000, reason: "session " + reason)
    }

    // MARK: - Internals

    /// Build the per-session engine and ModuleInstance, wire the patch
    /// callback, and register resources / components / nested modules /
    /// action handlers. Runs once in `init`.
    private func buildEngineAndModuleInstance() throws {
        let engine = try NativeEngine()

        // Resources.
        for map in host.resourceMaps {
            if let data = try? JSONSerialization.data(withJSONObject: map),
               let json = String(data: data, encoding: .utf8) {
                engine.registerResources(json)
            }
        }

        // Components.
        for comp in host.componentSources {
            do {
                try engine.registerComponent(name: comp.name, source: comp.source, path: comp.path)
            } catch {
                HypenLoggers.server.warning(
                    "Failed to register component '%@' on session %@: %@",
                    comp.name, id, "\(error)"
                )
            }
        }

        // Nested modules from the app registry. Each named module
        // (except the primary) is registered so `module <Name> { ... }`
        // in the DSL resolves `@{state.xxx}` against its own state.
        let primaryName = host.moduleName
        for name in host.appRegistry.getNames() where name != primaryName {
            if let def = host.appRegistry.get(name) {
                engine.registerModule(name: name, initialState: def.initialState)
            }
        }

        // Build the primary ModuleDefinition and the ModuleInstance.
        // ModuleInstance.init calls engine.setModule / engine.onAction /
        // wires state.onChange → engine.updateState.
        let definition = host.makeModuleDefinition()
        let moduleInstance = ModuleInstance(definition: definition, engine: engine)

        // Wire patches → transport. Fired every time engine.updateState
        // produces patches (which happens automatically inside the
        // onChange wiring set up in ModuleInstance.init).
        moduleInstance.onPatches { [weak self] patches in
            guard let self = self else { return }
            self.lock.lock()
            if self.destroyed {
                self.lock.unlock()
                return
            }
            self.revision += 1
            let rev = self.revision
            let module = self.host.moduleName
            self.lock.unlock()
            self.send(.patch(module: module, patches: patches, revision: rev))
        }

        lock.lock()
        self.engine = engine
        self.moduleInstance = moduleInstance
        lock.unlock()
    }

    /// Run hello → sessionAck → initialTree.
    /// Safe to call at most once per session.
    private func initializeSession(
        requestedSessionId: String?,
        props: [String: Any],
        deviceHello: String? = nil,
        resumeToken: String? = nil
    ) {
        lock.lock()
        if helloReceived || destroyed {
            lock.unlock()
            return
        }
        helloReceived = true
        helloTimeoutWork?.cancel()
        helloTimeoutWork = nil
        let mi = moduleInstance
        lock.unlock()

        // Device handshake selection (RFC 001 §2.2) is pure and computed
        // before any side effect: the Rust `deviceHandshake` strictly
        // validates the advertisement (D7) and intersects it with what this
        // broker-backed server consumes (the same selection as
        // `deviceNegotiate`); no ack disables the device plane (UI-only
        // operation continues) and comes with the reason, for the log only.
        var deviceAck: String? = nil
        if sessionDeviceOptions != nil, let hello = deviceHello, let dt = transport as? DeviceTransport {
            let handshake: DeviceHandshake?
            do {
                handshake = try deviceHandshake(helloJson: hello, binaryRoute: dt.carriesBinary, serverCapabilitiesJson: nil)
            } catch {
                // Only a malformed server advertisement throws (none is passed).
                handshake = nil
                HypenLoggers.server.error("Session %@: device handshake failed: %@", id, "\(error)")
            }
            deviceAck = handshake?.ackJson
            if deviceAck == nil {
                HypenLoggers.server.warning(
                    "Session %@: device plane disabled — %@", id,
                    handshake?.reason ?? "invalid or non-mutual hello.device")
            }
        }

        let sm = host.sessionManager
        var session: Session
        var isRestored = false

        // Resume credential (RFC 001 §5): a session that has had a
        // negotiated device plane is never resumed by its public id alone —
        // the hello must also present the server-issued resume token; a
        // missing or mismatched token is a NEW session, never an error or a
        // hijack. A UI-only session keeps the legacy id-only resume.
        var requestedSessionId = requestedSessionId
        if let rid = requestedSessionId, sm.resumeRequiresToken(rid), !sm.verifyResumeToken(rid, resumeToken) {
            HypenLoggers.server.info("Session %@: resume of %@ without a valid resume token — new session", id, rid)
            requestedSessionId = nil
        }

        if let id = requestedSessionId, let pending = sm.resumeSession(id) {
            session = pending.session
            isRestored = true
            // onReconnect hook. The user can opt to restore the saved
            // state via the Restore callback (or do nothing, leaving
            // the fresh state as-is).
            mi?.handleReconnect(
                session: session.toSessionInfo(),
                savedState: pending.savedState
            )
        } else {
            session = sm.createSession(props: props)
        }

        // A fresh resume credential per acknowledged connection (rotated on
        // every resume; the previous one stops working), on every server. A
        // negotiated device plane makes it required for this session's
        // resumes from now on.
        let token = sm.issueResumeToken(session.id, devicePlane: deviceAck != nil)
        lock.lock()
        sessionID = session.id
        issuedResumeToken = token
        lock.unlock()
        _ = sm.trackConnection(session.id, connectionId: ObjectIdentifier(self))

        // sessionAck.
        send(.sessionAck(
            sessionId: session.id,
            isNew: !isRestored,
            isRestored: isRestored,
            resumeToken: token,
            device: deviceAck
        ))

        // The broker exists (and its connection-owned core.capabilities
        // stream is open) before any module callback can request device
        // work.
        if let ack = deviceAck { attachDevice(ack: ack) }

        // initialTree. Render once up front; subsequent patches stream
        // through the onPatches callback installed in
        // buildEngineAndModuleInstance.
        let moduleName = host.moduleName
        let uiTemplate = host.uiTemplate
        var initialPatches: [[String: Any]] = []
        if !uiTemplate.isEmpty, let engine = self.engineRef() {
            do {
                initialPatches = try engine.renderSource(uiTemplate)
            } catch {
                HypenLoggers.server.error(
                    "Render failed for session %@: %@", id, "\(error)"
                )
                transport.close(code: 1011, reason: "Render failed")
                return
            }
        }

        let stateSnapshot = mi?.getState() ?? [:]
        send(.initialTree(
            module: moduleName,
            state: stateSnapshot,
            patches: initialPatches,
            revision: 0
        ))

        // Declaration tables are populated now; the session may be
        // attached to (`RemoteServer.attach(_:)`) from here on.
        lock.lock()
        ready = true
        lock.unlock()

        host.onSessionReady(self, client: ClientInfo(id: id, connectedAt: connectedAt))

        // Activate the primary module so single-screen apps have a live
        // activation authority for device work (RFC 001 §2.7), as every
        // Hypen server SDK does. Under ManagedRouter, route modules are
        // activated by the router as usual.
        mi?.activate()

        // Auto-wire a ManagedRouter from the template's own `Router {}`
        // blocks. Host code just registers modules + the template; the
        // per-session router spin-up is handled here so the Social
        // example (and friends) stay ceremony-free. Opt out via
        // `RemoteServer.disableAutoRouter()` when bespoke wiring is
        // needed in `onSessionCreate`.
        if autoRouterEnabled {
            autoWireManagedRouter()
        }
    }

    /// Inspect the primary UI for `Router { Route ... }` blocks, pick
    /// the first registered component in each route body, build a
    /// per-session ManagedRouter against the shared engine, mirror
    /// router path into the primary module's `location` field if
    /// present.
    ///
    /// Both top-level routers (moduleScope nil or == primary) and
    /// routers nested inside per-route module templates are registered,
    /// flattened into one route table. Nested routes share the parent's
    /// URL space; authors spell out the full prefix in `Route(path:)`.
    /// On pattern conflicts the outermost wins — `discoverRouters`
    /// emits outer blocks first and the de-dup below keeps the first
    /// entry seen for any given path.
    private func autoWireManagedRouter() {
        lock.lock()
        let engine = self.engine
        let app = host.appRegistry
        let mi = moduleInstance
        lock.unlock()
        guard let engine = engine else { return }
        let ui = host.uiTemplate
        guard !ui.isEmpty else { return }

        // Collect router blocks from both the primary template AND every
        // discovered child component template. `discoverRouters` walks a
        // single IR tree and does not resolve `Foo()` component references
        // — child templates live in separate source strings in
        // `host.componentSources`. Running discover on each separately
        // and concatenating (primary first) gives us the true cross-tree
        // router inventory. Without this pass, a nested `module Home {
        // Router { ... } }` block declared in `Home/component.hypen` is
        // silently invisible to the SDK and the route never mounts.
        // Matches the TS P1-A fix (commit 9adcb3f2).
        var discovered: [DiscoveredRouter] = []
        do {
            let blocks = try engine.discoverRouters(source: ui)
            discovered.append(contentsOf: blocks)
        } catch {
            HypenLoggers.server.error("Auto-router: discoverRouters failed on %@: %@", id, "\(error)")
        }
        for comp in host.componentSources {
            do {
                let blocks = try engine.discoverRouters(source: comp.source)
                discovered.append(contentsOf: blocks)
            } catch {
                HypenLoggers.server.error(
                    "Auto-router: discoverRouters failed on %@ / %@: %@",
                    id, comp.name, "\(error)"
                )
            }
        }
        if discovered.isEmpty { return }

        let router = HypenRouter()
        let ctx = HypenGlobalContext(router: router)
        // Register the primary module so routed children can read
        // app-level state via `context.getModule("app")`. Matches the
        // TS / Kotlin auto-wire; without this Swift routed modules see
        // no primary under that id even though the pattern is
        // documented. The primary's scope is the lowercase module name
        // (same convention the engine uses for `active_action_scope`
        // dispatching).
        if let primary = mi {
            let primaryScope = host.moduleName.lowercased()
            ctx.registerModule(primaryScope, instance: primary)
        }
        // Patch forwarder — same shape as the primary moduleInstance's
        // onPatches (buildEngineAndModuleInstance) so every route's
        // state-change patches ship through the one code path. Without
        // this, HomePage's onCreated-loaded feed generates patches
        // that get silently dropped (a fresh nested ModuleInstance
        // starts with an empty patchCallbacks array).
        let patchForwarder: @Sendable ([[String: Any]]) -> Void = { [weak self] patches in
            guard let self = self else { return }
            self.lock.lock()
            if self.destroyed {
                self.lock.unlock()
                return
            }
            self.revision += 1
            let rev = self.revision
            let module = self.host.moduleName
            self.lock.unlock()
            self.send(.patch(module: module, patches: patches, revision: rev))
        }
        let managed = ManagedRouter(
            router: router,
            registry: app,
            globalContext: ctx,
            engine: engine,
            onPatches: patchForwarder
        )

        var added = 0
        var seenPaths = Set<String>()
        for r in discovered {
            for route in r.routes {
                if seenPaths.contains(route.path) {
                    HypenLoggers.server.debug(
                        "Auto-router: path %@ already registered; ignoring nested duplicate",
                        route.path
                    )
                    continue
                }
                var picked: String? = nil
                for name in route.elementNames {
                    if app.get(name) != nil { picked = name; break }
                }
                guard let component = picked else {
                    HypenLoggers.server.debug(
                        "Auto-router: no registered module matched %@ — skipping", route.path
                    )
                    continue
                }
                managed.addRoute(RouteDefinition(path: route.path, component: component))
                seenPaths.insert(route.path)
                added += 1
            }
        }

        if added == 0 { return }

        // Mirror router path into primary module's `location`, if any.
        // Defer to a background queue to keep the engine write off
        // HypenRouter's synchronous notify path (matches the TS
        // `queueMicrotask` + Go `go func` patterns).
        if let miRef = mi {
            let snap = miRef.getState()
            if snap["location"] != nil {
                _ = router.onNavigate { _, to in
                    DispatchQueue.global().async {
                        // Use the session's merge API so both the
                        // session snapshot and the engine state stay
                        // in lockstep.
                        self.updatePrimaryState(["location": to])
                    }
                }
            }
        }

        // Route modules own device work too: bind them to the connection's
        // plane before the initial route mounts (and activates).
        managed.attachDevice(device)
        lock.lock()
        autoManagedRouter = managed
        lock.unlock()
        managed.start()
    }

    // MARK: - Device plane (RFC 001)

    /// Every live module instance on this connection: the primary plus the
    /// auto-wired router's active and persisted route modules.
    private func liveModuleInstances() -> [ModuleInstance] {
        lock.lock()
        let primary = moduleInstance
        let managed = autoManagedRouter
        lock.unlock()
        var out: [ModuleInstance] = []
        if let primary { out.append(primary) }
        for instance in managed?.liveInstances() ?? [] where !out.contains(where: { $0 === instance }) {
            out.append(instance)
        }
        return out
    }

    /// Create the connection's broker (the Rust `DeviceBroker`), start it —
    /// which opens the connection-owned `core.capabilities` stream — and
    /// bind every live module instance to it.
    private func attachDevice(ack: String) {
        guard let opts = sessionDeviceOptions, let dt = transport as? DeviceTransport else { return }
        let config: String
        do {
            config = try opts.brokerConfigJSON(ack: ack)
        } catch {
            HypenLoggers.server.error("Session %@: device options not encodable — device plane disabled: %@", id, "\(error)")
            return
        }
        let sessionRef = WeakSession(self)
        let sendText: @Sendable (String) -> Void = { text in
            guard let s = sessionRef.value, !s.isDestroyed else { return }
            dt.sendDeviceText(text)
        }
        var sendFrame: (@Sendable (Data) -> Void)? = nil
        if dt.carriesBinary {
            sendFrame = { frame in
                guard let s = sessionRef.value, !s.isDestroyed else { return }
                dt.sendBinary(frame)
            }
        }
        let closeConnection: @Sendable (UInt16, String) -> Void = { code, reason in
            HypenLoggers.server.warning("Device plane closed: %@", reason)
            sessionRef.value?.closeDevicePlane(reason: reason, code: code)
        }
        let sink = DevicePlaneSink(
            sendText: sendText,
            sendFrame: sendFrame,
            bufferedAmount: { dt.bufferedAmount() },
            closeConnection: closeConnection
        )
        let plane: DevicePlane
        do {
            plane = try DevicePlane(
                configJSON: config, pool: host.deviceRetainedBytesPool, sink: sink,
                clock: opts.clock, binary: dt.carriesBinary,
                onError: { HypenLoggers.server.error("Device plane: %@", $0) })
        } catch {
            HypenLoggers.server.error("Session %@: device broker creation failed — device plane disabled: %@", id, "\(error)")
            return
        }
        lock.lock()
        if destroyed || devicePlane != nil { lock.unlock(); plane.close(); return }
        devicePlane = plane
        lock.unlock()
        if !plane.start() {
            closeDevicePlane(reason: "device plane closed: core.capabilities unavailable", code: 1012)
            return
        }
        for instance in liveModuleInstances() { instance.attachDevice(plane) }
    }

    /// Close the device connection (RFC 001 §2.2/§2.5): reject all live
    /// device work, detach every module instance, and reset the socket
    /// (1012) — a socket with a device plane never survives without its broker,
    /// and the client reconnects with a full advertisement.
    private func closeDevicePlane(reason: String, code: UInt16) {
        lock.lock()
        let plane = devicePlane
        devicePlane = nil
        lock.unlock()
        guard let plane else { return }
        plane.close(.connectionLost)
        for instance in liveModuleInstances() { instance.attachDevice(nil) }
        transport.close(code: code, reason: String(reason.prefix(120)))
    }

    private func engineRef() -> NativeEngine? {
        lock.lock(); defer { lock.unlock() }; return engine
    }

    /// Dispatch through the ModuleInstance (typed path) or the legacy
    /// untyped shim. In either case, an explicit `stateUpdate` is sent
    /// for client-side inspection; patches flow through the onPatches
    /// callback installed in buildEngineAndModuleInstance.
    private func handleDispatchAction(actionName: String, payload: Any?) {
        // Strip the reserved transaction-animation stamp BEFORE either
        // dispatch path — the typed ModuleInstance route and the legacy
        // untyped shim both take their payload from here.
        let sanitizedPayload = stripReservedAnimateKey(payload)

        lock.lock()
        let mi = moduleInstance
        lock.unlock()
        guard let mi = mi else { return }

        // Dispatch path: the legacy untyped `(name, payload, state) →
        // newState?` shim exists only when the host was configured via
        // `withState(_:_:)` + `onAction(_:)` without a typed
        // ModuleDefinition. In every other case the typed dispatch
        // through ModuleInstance wins.
        if let shim = host.legacyActionHandler {
            let currentState = mi.state.snapshot()
            if let newState = shim(actionName, sanitizedPayload, currentState) {
                mi.state.replace(newState)
            }
        } else {
            mi.dispatchAction(actionName, payload: sanitizedPayload)
        }

        emitStateUpdate(mi)
    }

    /// The `stateUpdate` tail every dispatch ends with — the renderer's
    /// click path (`handleDispatchAction`) and the agent surface's
    /// `dispatchExternal` share it so an attached dispatch is
    /// wire-identical to a click: patches have already streamed through
    /// the `onPatches` callback at revision N; this stamps N+1 on the
    /// explicit snapshot for client-side state inspection.
    private func emitStateUpdate(_ mi: ModuleInstance) {
        let updatedState = mi.state.snapshot()
        lock.lock()
        revision += 1
        let rev = revision
        lock.unlock()
        send(.stateUpdate(
            module: host.moduleName,
            state: updatedState,
            revision: rev
        ))
    }

    // MARK: - Agent surface

    /// Dispatch on behalf of a caller that is NOT the rendered UI — the
    /// agent surface (`AgentHandle`), an MCP server, a REST handler.
    ///
    /// Goes through the engine's guarded `dispatchExternal`, never the
    /// renderer's permissive `dispatchAction`, so only what the app
    /// declares (`.onAction()`, `Router { Route }`, `.bind()`) is
    /// reachable. On acceptance the resulting handler runs on *this*
    /// session's engine, so this session's transport receives exactly
    /// what a click would have produced: a `patch` message from the
    /// `onPatches` callback at the next revision, then the same
    /// `stateUpdate` tail as `handleDispatchAction`.
    ///
    /// A guard refusal throws before anything is queued: no handler
    /// runs, nothing is sent on the transport, and the revision does not
    /// move.
    ///
    /// Locking: the session's `NSLock` is non-recursive and the
    /// `onPatches` callback re-takes it while a handler mutates state, so
    /// the engine / module-instance references are snapshotted under the
    /// lock and the lock is released *before* the engine is touched.
    ///
    /// Only the typed `module(_:_:)` path registers action handlers with
    /// the engine; the legacy `withState(_:_:)` + `onAction(_:)` shim is
    /// consulted by `handleDispatchAction` alone and declares no actions,
    /// so under that configuration the guard refuses every name.
    ///
    /// - Throws: `AgentHandleError.sessionGone` once `destroy()` has run,
    ///   `AgentHandleError.noEngine` when the engine failed to build, or
    ///   the engine's `HypenError.ActionError` refusal.
    public func dispatchExternal(_ name: String, payload: [String: Any]? = nil) throws {
        // Same directive-stripping as the click path, so a module handler
        // never observes the reserved transaction-animation stamp
        // whichever way the dispatch arrived.
        let sanitizedPayload = stripReservedAnimateKey(payload) as? [String: Any]

        lock.lock()
        let destroyedLocal = destroyed
        let engine = self.engine
        let mi = moduleInstance
        let sid = sessionID
        lock.unlock()

        if destroyedLocal {
            throw AgentHandleError.sessionGone(sessionID: sid ?? id)
        }
        guard let engine = engine, let mi = mi else {
            throw AgentHandleError.noEngine(sessionID: sid ?? id)
        }

        // Guard first. A throw here leaves the pending-action queue,
        // the transport, and the revision untouched.
        try engine.dispatchExternal(name, payload: sanitizedPayload)
        // `dispatchExternal` only queues the resolved action (exactly like
        // `dispatchAction`); draining fires the handler, whose state
        // mutations stream a `patch` through `onPatches`.
        engine.processPendingActions()

        emitStateUpdate(mi)
    }
}

/// A weak session reference the device sink closures capture (the plane is
/// owned by the session; the sink must not keep the session alive).
private final class WeakSession: @unchecked Sendable {
    weak var value: RemoteSession?
    init(_ value: RemoteSession) { self.value = value }
}
