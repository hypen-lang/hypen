import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import WebSocketKit
@preconcurrency import HypenEngine

// NOTE: Per-client state used to live on a `ClientConnection` class in
// this file. It has moved to `RemoteSession` (see RemoteSession.swift),
// which is transport-agnostic — `RemoteServer.listen(_:)` is now sugar
// over the new `prepare()` + `createSession(transport:)` primitives, and
// framework integrators (Vapor, Hummingbird, custom NIO pipelines) can
// use those primitives directly.

// MARK: - RemoteServer

/// WebSocket server that streams Hypen apps to connected clients.
///
/// Each connected client gets its own isolated module instance and state.
/// Actions are dispatched per-client, and state updates are sent back
/// as JSON messages.
///
/// ```swift
/// let server = RemoteServer()
///     .withState("Counter", ["count": 0])
///     .onAction { action, payload, state in
///         if action == "increment" {
///             var newState = state
///             let count = state["count"] as? Int ?? 0
///             newState["count"] = count + 1
///             return newState
///         }
///         return nil
///     }
///     .ui("""
///         Column {
///             Text("Count: ${state.count}")
///             Button("@actions.increment") { Text("+") }
///         }
///     """)
///     .listen(3000)
/// ```
public final class RemoteServer: @unchecked Sendable, SessionHost {
    // Properties have default (internal) access so `RemoteSession`
    // (same module) can read them. They are not surfaced to clients of
    // the package. The ones exposed via the `SessionHost` protocol match
    // names with the protocol's requirements, which lets this class
    // satisfy the protocol without renaming anything.
    let lock = NSLock()

    var moduleConfig: ModuleConfig?
    public var moduleName: String = "App"
    public var uiTemplate: String = ""
    var config: ServerConfig = ServerConfig()

    /// Live sessions, keyed by ObjectIdentifier for fast add/remove.
    var sessions: [ObjectIdentifier: RemoteSession] = [:]

    /// Manages session lifecycle (create / suspend / resume / expire) so
    /// briefly-disconnected clients can reconnect to their previous state
    /// within the TTL window. Default TTL is 1 hour (see SessionConfig).
    public let sessionManager: SessionManager

    var onConnectionCallbacks: [ConnectionCallback] = []
    var onDisconnectionCallbacks: [ConnectionCallback] = []
    /// Session-scoped hook: fires the moment a `RemoteSession` is
    /// constructed, before the hello handshake or the initial render.
    /// Callbacks get the session directly and can use
    /// `session.nativeEngine` + `session.onClosed(_:)` to drive
    /// per-session helpers (e.g. a `ManagedRouter`).
    var onSessionCreateCallbacks: [(RemoteSession) -> Void] = []
    /// When true (default), each new session auto-wires a
    /// ManagedRouter from any `Router { Route … }` blocks in the
    /// primary template. Flip off via `disableAutoRouter()` when the
    /// host wants bespoke wiring inside `onSessionCreate`.
    private var autoRouter: Bool = true
    public var resourceMaps: [[String: String]] = []
    /// Pre-loaded component sources, keyed by component name. Registered on
    /// each session's engine during `RemoteSession` construction.
    public var componentSources: [(name: String, source: String, path: String)] = []
    /// App registry used for auto-discovering named modules. Defaults to
    /// `HypenApp.shared`. Each module registered in this app (except the
    /// primary module) is automatically registered with each session's
    /// engine so the engine scopes `${state.xxx}` when it encounters the
    /// corresponding `module X { ... }` component template.
    public var appRegistry: HypenApp = .shared

    /// Set once `prepare()` has validated configuration. Idempotent.
    var prepared = false

    /// Device Capability Protocol settings (RFC 001). The device plane is
    /// on by default: these are the defaults until `configureDevice(_:)`.
    var _deviceOptions = DeviceServerOptions()
    /// True once `configureDevice(_:)` supplied options (they are validated
    /// against the broker in `prepare()`; the defaults need no validation).
    var _deviceConfigured = false
    /// `disableDevice()` was called: the server is UI-only.
    var _deviceDisabled = false
    /// The process-wide retained-bytes budget all connections' brokers
    /// share (default 1 GiB; `configureDevice(_:processRetainedBytes:)`).
    var _devicePool: DeviceRetainedBytesPool? = nil
    var _deviceProcessRetainedBytes: UInt64 = RemoteServer.defaultProcessRetainedBytes
    /// Default process-wide retained-bytes budget of every broker (1 GiB).
    public static let defaultProcessRetainedBytes: UInt64 = 1024 * 1024 * 1024

    var eventLoopGroup: EventLoopGroup?
    var serverChannel: Channel?
    var boundPort: Int?
    let log = HypenLoggers.server

    /// Simple module configuration for the server-level API.
    struct ModuleConfig {
        let name: String
        var initialState: [String: Any]
        var onAction: ActionHandler?
    }

    /// - Parameter sessionConfig: session TTL, id generator and concurrent
    ///   connection policy. `.allowMultiple` fans one session out to several
    ///   connections, which the per-connection device plane cannot follow:
    ///   the server then runs with the device plane off (one startup
    ///   warning says so).
    public init(sessionConfig: SessionConfig = SessionConfig()) {
        self.sessionManager = SessionManager(config: sessionConfig)
    }

    // MARK: - Builder API

    /// Set a named module with initial state.
    @discardableResult
    public func withState(_ name: String, _ initialState: [String: Any]) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        moduleName = name
        moduleConfig = ModuleConfig(name: name, initialState: initialState)
        return self
    }

    /// Set a module from a ModuleDefinition.
    @discardableResult
    public func module(_ name: String, _ definition: ModuleDefinition) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        moduleName = name
        moduleConfig = ModuleConfig(
            name: name,
            initialState: definition.initialState,
            onAction: nil // Actions handled by the definition itself
        )
        // Seed uiTemplate from definition if available and not already set
        if uiTemplate.isEmpty, let ui = definition.ui, !ui.isEmpty {
            uiTemplate = ui
        }
        // Store the definition for creating per-client ModuleInstances
        _moduleDefinition = definition
        return self
    }

    // _moduleDefinition is declared at the top of the class so RemoteSession
    // (via the SessionHost extension) can reach it.
    var _moduleDefinition: ModuleDefinition?

    /// Set the action handler (simple API).
    @discardableResult
    public func onAction(_ handler: @escaping ActionHandler) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        if moduleConfig == nil {
            moduleConfig = ModuleConfig(name: moduleName, initialState: [:])
        }
        moduleConfig?.onAction = handler
        return self
    }

    /// Set the UI DSL string.
    @discardableResult
    public func ui(_ dsl: String) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        uiTemplate = dsl
        return self
    }

    /// Register a flat map of resource name → raw SVG string.
    /// Each client engine will have these resources registered on connection.
    @discardableResult
    public func resources(_ map: [String: String]) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        resourceMaps.append(map)
        return self
    }

    /// Load a JSON file containing `{ "name": "<svg>...</svg>" }` and register as resources.
    /// Each client engine will have these resources registered on connection.
    @discardableResult
    public func resourcesFile(_ path: String) throws -> RemoteServer {
        let url = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: url)
        guard let map = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            throw RemoteServerError.invalidResourcesFile(path)
        }
        return resources(map)
    }

    /// Load every `.svg` file in `dir` and register its contents as a resource
    /// keyed by the filename without extension.
    ///
    /// SVG parsing is delegated to the Rust engine via `registerResources`,
    /// so the Swift side is a dumb filesystem reader.
    @discardableResult
    public func resourcesDir(_ dir: String) throws -> RemoteServer {
        let dirURL = URL(fileURLWithPath: dir)
        let entries = try FileManager.default.contentsOfDirectory(atPath: dir)
        var map: [String: String] = [:]
        for entry in entries {
            let fileURL = dirURL.appendingPathComponent(entry)
            guard fileURL.pathExtension.lowercased() == "svg" else { continue }
            let name = fileURL.deletingPathExtension().lastPathComponent
            let svg = try String(contentsOfFile: fileURL.path, encoding: .utf8)
            map[name] = svg
        }
        return resources(map)
    }

    /// Set the app registry used for auto-discovering named modules.
    ///
    /// By default `HypenApp.shared` is used. Modules registered in the app
    /// (via the typed builder or `app.register()`) are automatically
    /// registered with each client engine on connection — no explicit
    /// `registerModule` call needed.
    @discardableResult
    public func app(_ app: HypenApp) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        appRegistry = app
        return self
    }

    /// Walk a directory of Hypen components and pre-load them.
    ///
    /// Expects the layout `<dir>/<ComponentName>/component.hypen`. Every such
    /// file is read into memory and registered on each new client engine in
    /// session init, so the engine can resolve cross-component references
    /// without needing an explicit import statement.
    @discardableResult
    public func componentsDir(_ dir: String) throws -> RemoteServer {
        let dirURL = URL(fileURLWithPath: dir)
        let entries = try FileManager.default.contentsOfDirectory(atPath: dir)
        var loaded: [(name: String, source: String, path: String)] = []
        for entry in entries {
            let componentDir = dirURL.appendingPathComponent(entry)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: componentDir.path, isDirectory: &isDir),
                  isDir.boolValue else { continue }
            let componentFile = componentDir.appendingPathComponent("component.hypen")
            guard FileManager.default.fileExists(atPath: componentFile.path) else { continue }
            let source = try String(contentsOfFile: componentFile.path, encoding: .utf8)
            loaded.append((name: entry, source: source, path: componentFile.path))
        }
        lock.lock()
        defer { lock.unlock() }
        componentSources.append(contentsOf: loaded)
        return self
    }

    /// Set server configuration.
    @discardableResult
    public func config(_ config: ServerConfig) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        self.config = config
        return self
    }

    /// Turn off the per-session `ManagedRouter` that the server
    /// normally wires up automatically from the primary template's
    /// `Router {}` blocks. Use this when the host wants to
    /// construct its own ManagedRouter inside `onSessionCreate` —
    /// e.g. to share one router across many sessions, pre-register
    /// nested modules, or swap in a custom route matcher.
    @discardableResult
    public func disableAutoRouter() -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        autoRouter = false
        return self
    }

    /// Register a callback fired the instant a `RemoteSession` is
    /// constructed — before the hello handshake and initial render.
    /// Use this to wire per-session helpers (routers, contexts,
    /// managed routers) that need access to `session.nativeEngine`.
    ///
    /// Swift's `RemoteSession` builds its engine eagerly in `init`, so
    /// `session.nativeEngine` is already non-nil in the callback.
    /// Register a teardown closure via `session.onClosed { ... }` for
    /// cleanup on disconnect.
    @discardableResult
    public func onSessionCreate(_ callback: @escaping (RemoteSession) -> Void) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        onSessionCreateCallbacks.append(callback)
        return self
    }

    /// Tune the Device Capability Protocol (RFC 001) plane. There is nothing
    /// to enable: every session whose client offers `device` in its hello
    /// gets a negotiated device plane backed by the Rust device broker, and
    /// module handlers reach it through `ctx.device` (and
    /// `onActivatedAsync`). Call this only to change the defaults (limits,
    /// budgets, clock, revision overrides, pin cap); every connection's
    /// broker shares one process-wide retained-bytes pool of
    /// `processRetainedBytes` (default 1 GiB).
    ///
    /// Options the broker refuses (e.g. an override of a revision that does
    /// not exist) are a programming error: `prepare()` throws
    /// `RemoteServerError.invalidDeviceOptions`. `disableDevice()` wins
    /// regardless of call order.
    @discardableResult
    public func configureDevice(
        _ options: DeviceServerOptions = DeviceServerOptions(),
        processRetainedBytes: UInt64 = RemoteServer.defaultProcessRetainedBytes
    ) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        _deviceOptions = options
        _deviceConfigured = true
        _deviceProcessRetainedBytes = processRetainedBytes
        _devicePool = nil
        return self
    }

    /// Opt out of the device plane: no session negotiates one (a client's
    /// `hello.device` is ignored and `sessionAck` carries no `device`), so
    /// the server behaves exactly like a UI-only server.
    @discardableResult
    public func disableDevice() -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        _deviceDisabled = true
        return self
    }

    /// Whether sessions of this server negotiate a device plane: true unless
    /// `disableDevice()` was called or a setting incompatible with the
    /// device plane is in effect (see `deviceIncompatibility`). A status,
    /// not a switch.
    public var deviceEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return deviceOnLocked
    }

    /// The setting that keeps the device plane off even though
    /// `disableDevice()` was not called, or nil. The only one on this
    /// server is a `.allowMultiple` concurrent-session policy: one session
    /// fanned out to several connections cannot share a per-connection
    /// device plane. (This server never negotiates WebSocket compression
    /// and has no `syncActions` mode, the other SDKs' incompatible settings.)
    public var deviceIncompatibility: String? {
        sessionManager.config.concurrent == .allowMultiple
            ? "SessionConfig.concurrent = .allowMultiple (one session on several connections)"
            : nil
    }

    private var deviceOnLocked: Bool { !_deviceDisabled && deviceIncompatibility == nil }

    /// Register a connection callback.
    @discardableResult
    public func onConnection(_ callback: @escaping ConnectionCallback) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        onConnectionCallbacks.append(callback)
        return self
    }

    /// Register a disconnection callback.
    @discardableResult
    public func onDisconnection(_ callback: @escaping ConnectionCallback) -> RemoteServer {
        lock.lock()
        defer { lock.unlock() }
        onDisconnectionCallbacks.append(callback)
        return self
    }

    // MARK: - Transport-agnostic API
    //
    // `listen(_:)` is convenient but couples Hypen to the built-in
    // NIO + WebSocketKit pipeline. The primitives below let framework
    // integrators (Vapor, Hummingbird, custom NIO channels, SSE
    // responses, tests) plug Hypen into their own transport.

    /// Validate configuration. Must be called before `createSession(...)`
    /// if you are bypassing `listen(_:)`. Idempotent. Throws if the
    /// server hasn't been given a module or a UI.
    public func prepare() throws {
        lock.lock()
        defer { lock.unlock() }
        if prepared { return }
        guard moduleConfig != nil else {
            throw RemoteServerError.moduleNotSet
        }
        guard !uiTemplate.isEmpty else {
            throw RemoteServerError.uiNotSet
        }
        // Device prerequisites never stop the server (RFC 001, always-on):
        // an incompatible setting turns the device plane off with ONE
        // warning. Only options the broker refuses — a programming error
        // in `configureDevice` — throw.
        if !_deviceDisabled {
            if let reason = deviceIncompatibility {
                log.warning("Device plane off for this server: %@ is incompatible with the device plane", reason)
            } else if _deviceConfigured {
                try _deviceOptions.validateAgainstBroker()
            }
        }
        prepared = true
    }

    /// The one startup warning of a server that admits every client: no
    /// `allowedOrigins` and no `authenticate` configured. Nil when either is.
    var admissionWarning: String? {
        config.allowedOrigins.isEmpty && config.authenticate == nil
            ? "no allowedOrigins/authenticate configured — any client can connect; set them in production"
            : nil
    }

    /// Create a `RemoteSession` driven by the supplied transport.
    ///
    /// Use this to integrate Hypen with an existing WebSocket / HTTP
    /// stack. Feed incoming text frames via `session.receive(text)` and
    /// call `session.destroy()` when the underlying connection closes.
    ///
    /// Throws if the server is not prepared.
    @discardableResult
    public func createSession(
        transport: SessionTransport,
        id: String? = nil,
        helloGraceMs: Int? = nil
    ) throws -> RemoteSession {
        try prepare()
        let session = RemoteSession(
            host: self,
            transport: transport,
            id: id,
            helloGraceMs: helloGraceMs
        )
        lock.lock()
        session.autoRouterEnabled = autoRouter
        sessions[ObjectIdentifier(session)] = session
        let callbacks = onSessionCreateCallbacks
        lock.unlock()
        for cb in callbacks {
            cb(session)
        }
        return session
    }

    /// Thin handler bundle for middleware-style wiring.
    public struct SessionHandler {
        public let session: RemoteSession
        public let receive: (String) -> Void
        public let destroy: () -> Void
    }

    /// Return a closure that, given a transport, creates a session and
    /// returns `{ session, receive, destroy }` wired up. Useful for
    /// plumbing Hypen into middleware-style HTTP/WebSocket stacks.
    public func createHandler() -> (SessionTransport) throws -> SessionHandler {
        return { [weak self] transport in
            guard let self = self else {
                throw RemoteServerError.moduleNotSet
            }
            let session = try self.createSession(transport: transport)
            return SessionHandler(
                session: session,
                receive: { session.receive($0) },
                destroy: { session.destroy() }
            )
        }
    }

    // MARK: - Server Lifecycle

    /// Start the WebSocket server. Convenience wrapper that backs
    /// `prepare()` + `createSession(transport:)` with a NIO +
    /// WebSocketKit adapter. For custom integrations use the
    /// transport-agnostic primitives directly.
    @discardableResult
    public func listen(_ port: Int? = nil) -> RemoteServer {
        do {
            try prepare()
        } catch {
            fatalError("\(error)")
        }

        lock.lock()
        let actualPort = port ?? config.port
        let hostname = config.hostname
        let openAdmission = admissionWarning
        let allowedOrigins: Set<String>? = config.allowedOrigins.isEmpty
            ? nil : Set(config.allowedOrigins.map(DeviceAdmission.normalizeOrigin))
        let authenticate = config.authenticate
        lock.unlock()
        let admissionLog = log
        if let openAdmission { log.warning("%@", openAdmission) }

        let elg = MultiThreadedEventLoopGroup(numberOfThreads: System.coreCount)
        self.eventLoopGroup = elg

        let server = self

        // Set up HTTP + WebSocket server
        let bootstrap = ServerBootstrap(group: elg)
            .serverChannelOption(.backlog, value: 256)
            .serverChannelOption(.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { channel in
                // Compression (RFC 7692 `permessage-deflate`) is deliberately
                // NOT negotiated by this server. Other Hypen SDKs enable it by
                // default; Swift is the exception, and it is the exception on
                // purpose:
                //
                //   * SwiftNIO's `NIOWebSocketServerUpgrader` implements RFC
                //     6455 only. It parses `Sec-WebSocket-Key` / `-Version`
                //     and never reads or echoes `Sec-WebSocket-Extensions`;
                //     extension negotiation is left entirely to the
                //     `shouldUpgrade` callback below.
                //   * WebSocketKit (the frame handler we install in
                //     `upgradePipelineHandler`) has no compression support
                //     either — vapor/websocket-kit#55 has been open since 2020.
                //   * The maintained RFC 7692 implementation in the ecosystem
                //     (`WSCompression` in hummingbird-project/swift-websocket,
                //     built on compress-nio) is bound to that package's own
                //     `WSCore` handler + upgrade stack; it negotiates via
                //     `WebSocketServerConfiguration.extensions` and cannot be
                //     spliced into a WebSocketKit pipeline. Adopting it means
                //     replacing this transport wholesale. Kitura-WebSocket-
                //     Compression does expose standalone NIO handlers, but
                //     Kitura has been unmaintained since 2020.
                //
                // Hand-rolling RFC 7692 (per-connection sliding-window zlib
                // contexts, `client_no_context_takeover` /
                // `server_max_window_bits` parameter negotiation, RSV1
                // framing) is not worth the risk for this change.
                //
                // The behaviour below is protocol-correct regardless: a client
                // offering `Sec-WebSocket-Extensions: permessage-deflate` gets
                // a 101 response that does NOT accept the extension (the empty
                // `HTTPHeaders()` returned here are the ONLY headers added on
                // top of Upgrade/Connection/Sec-WebSocket-Accept), so per RFC
                // 7692 §5.1 the client must fall back to uncompressed frames.
                // Compression is per-connection, so a compression-capable
                // client interoperates with this server unchanged — the
                // connection simply runs uncompressed. Never echo the
                // extension header from `shouldUpgrade` without also
                // installing the corresponding compressor/decompressor: an
                // accepted-but-unimplemented extension breaks every client.
                // Inbound size bounds (RFC 001 §2.1/§2.3). NIO's default
                // `maxFrameSize` is 16 KiB, which would refuse a device
                // binary frame (12-byte header + 64 KiB chunk = 65,548
                // bytes) or a large `hello.device` at the transport, and
                // WebSocketKit's frame aggregator is unbounded by default.
                // Allow one frame / one aggregated message up to
                // `DeviceProtocol.transportMaxInboundMessageBytes` (2 MiB:
                // above the 1 MiB device text limit, so an oversize device
                // message reaches the device layer as a counted violation)
                // and refuse anything larger before it is buffered.
                let upgrader = NIOWebSocketServerUpgrader(
                    maxFrameSize: DeviceProtocol.transportMaxInboundMessageBytes,
                    shouldUpgrade: { channel, head in
                        // Admission (RFC 001 §5, decision D1): the Origin
                        // allowlist and the app authenticator, each enforced
                        // exactly when configured; with neither, every
                        // client is admitted (warned about at startup).
                        // A refused upgrade falls through to HTTPHandler,
                        // which answers 403. Empty headers => no extensions
                        // accepted. See the compression note above before
                        // changing this.
                        let request = DeviceUpgradeRequest(
                            uri: head.uri, headers: head.headers.map { (name: $0.name, value: $0.value) })
                        let promise = channel.eventLoop.makePromise(of: HTTPHeaders?.self)
                        Task {
                            let refusal = await DeviceAdmission.refusal(
                                for: request, allowedOrigins: allowedOrigins,
                                authenticate: authenticate)
                            if let refusal {
                                admissionLog.warning("Rejected WebSocket upgrade: %@", refusal)
                                promise.succeed(nil)
                            } else {
                                promise.succeed(HTTPHeaders())
                            }
                        }
                        return promise.futureResult
                    },
                    upgradePipelineHandler: { channel, req in
                        // WebSocketKit installs its handlers on `channel`
                        // as a side effect and returns an EventLoopFuture
                        // we don't wait on — the HTTP upgrader's own
                        // completion future is what signals upgrade done.
                        var wsConfig = WebSocket.Configuration()
                        wsConfig.maxAccumulatedFrameSize = DeviceProtocol.transportMaxInboundMessageBytes
                        wsConfig.maxAccumulatedFrameCount = DeviceProtocol.transportMaxInboundFragments
                        _ = WebSocket.server(on: channel, config: wsConfig) { ws in
                            server.attachWebSocket(ws)
                        }
                        return channel.eventLoop.makeSucceededVoidFuture()
                    }
                )

                let config: NIOHTTPServerUpgradeConfiguration = (
                    upgraders: [upgrader],
                    completionHandler: { ctx in
                        // Remove HTTP handlers after upgrade
                        ctx.pipeline.removeHandler(name: "HTTPHandler", promise: nil)
                    }
                )

                // NIO's upgrader protocol predates Swift concurrency and
                // isn't `Sendable`-annotated, but the pipeline API still
                // accepts it because NIO's channel/EventLoop model
                // guarantees single-threaded access. Suppress the
                // strict-concurrency warning at the call site.
                nonisolated(unsafe) let nonsendableConfig = config
                return channel.pipeline.configureHTTPServerPipeline(
                    withServerUpgrade: nonsendableConfig
                ).flatMap {
                    channel.pipeline.addHandler(HTTPHandler(server: server), name: "HTTPHandler")
                }
            }

        do {
            let channel = try bootstrap.bind(host: hostname, port: actualPort).wait()
            self.serverChannel = channel
            self.boundPort = actualPort
            log.info("Hypen app streaming on ws://%@:%d/ws", hostname, actualPort)
        } catch {
            log.error("Failed to start server: %@", "\(error)")
            try? elg.syncShutdownGracefully()
            self.eventLoopGroup = nil
        }

        return self
    }

    /// Start the server and block the current thread until shutdown.
    /// Use this as your main entry point.
    public func listenAndWait(_ port: Int? = nil) throws {
        listen(port)
        // Block until the server channel closes
        try serverChannel?.closeFuture.wait()
    }

    /// Stop the server and tear down all sessions.
    public func stop() {
        lock.lock()
        let sessionsCopy = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()

        for session in sessionsCopy {
            session.destroy()
        }

        try? eventLoopGroup?.syncShutdownGracefully()
        eventLoopGroup = nil
        log.info("Server stopped")
    }

    /// Get the server URL.
    public func getURL() -> String {
        lock.lock()
        defer { lock.unlock() }
        let port = boundPort ?? config.port
        return "ws://\(config.hostname):\(port)/ws"
    }

    /// Get the number of connected sessions.
    public func getClientCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sessions.count
    }

    /// Snapshot of the currently-live sessions.
    public func allSessions() -> [RemoteSession] {
        lock.lock()
        defer { lock.unlock() }
        return Array(sessions.values)
    }

    // MARK: - Agent surface (attach mode)

    /// Bind the agent surface to an existing live user session.
    ///
    /// Returns an `AgentHandle` for the first session whose Hypen session
    /// id (the value the client received in `sessionAck`) matches, has
    /// completed hello → initialTree (`isReady`), is not destroyed, and
    /// has an engine. Nil otherwise — an unknown id, a session that has
    /// not finished its handshake, and a destroyed session are
    /// indistinguishable to the caller on purpose.
    ///
    /// No authorization is performed here: whoever holds a `RemoteServer`
    /// reference already holds every session on it, so the developer's
    /// own handler (the caller) is the authorizer. The handle never owns
    /// the session — see `AgentHandle`.
    ///
    /// Attach requires a typed module (`module(_:_:)`); under the legacy
    /// `withState(_:_:)` + `onAction(_:)` shim no actions are declared
    /// and every guarded dispatch is refused.
    public func attach(_ sessionID: String) -> AgentHandle? {
        // `allSessions()` releases the server lock before we touch any
        // session accessor (each takes the session's own lock).
        for session in allSessions() {
            guard session.currentSessionID == sessionID,
                  session.isReady,
                  !session.isDestroyed,
                  session.nativeEngine != nil else {
                continue
            }
            return AgentHandle(session: session, sessionID: sessionID)
        }
        return nil
    }


    // MARK: - Broadcast

    /// Send a state update to all connected sessions. Each session's
    /// `state.replace` triggers the per-session onChange wiring, which
    /// pushes patches through the engine and out over the transport.
    /// The explicit `stateUpdate` is for client-side state inspection
    /// (Studio, time-travel, etc.).
    public func broadcastState(_ state: [String: Any]) {
        let sessionsCopy = allSessions()
        let mName = moduleName

        for session in sessionsCopy {
            // Triggers onChange → engine.updateState → patch callback.
            session.replaceState(state)
            session.send(.stateUpdate(
                module: mName,
                state: state,
                revision: session.incrementRevision()
            ))
        }
    }

    /// Dispatch an action on every ready session as a broadcast-derived
    /// dispatch: handlers run on each session, but device calls they make
    /// fail `unavailable` (RFC 001 §1.7 — replay and broadcast cannot
    /// initiate device work on any connection).
    public func broadcastAction(_ name: String, payload: Any? = nil) {
        for session in allSessions() where session.isReady {
            session.dispatchReplayed(name, payload: payload)
        }
    }

    /// Broadcast patches to all connected sessions.
    public func broadcastPatches(_ patches: [[String: Any]]) {
        let sessionsCopy = allSessions()
        let mName = moduleName

        for session in sessionsCopy {
            session.send(.patch(
                module: mName,
                patches: patches,
                revision: session.incrementRevision()
            ))
        }
    }

    // MARK: - WebSocket adapter

    /// Wrap a `WebSocket` as a `SessionTransport`, create a session,
    /// and forward text/close events through it. Used by `listen(_:)`;
    /// also callable directly by framework integrators who already have
    /// a `WebSocketKit` socket in hand.
    public func attachWebSocket(_ ws: WebSocket) {
        let transport = WebSocketKitTransport(ws)
        do {
            let session = try createSession(transport: transport)
            ws.onText { [weak session] _, text in
                session?.receive(text)
            }
            // Device data-plane frames (RFC 001 §2.3); dropped by sessions
            // without a negotiated device plane.
            ws.onBinary { [weak session] _, buffer in
                session?.receiveBinary(Data(buffer.readableBytesView))
            }
            ws.onClose.whenComplete { [weak session] _ in
                session?.destroy()
            }
        } catch {
            log.error("Failed to create session: %@", "\(error)")
            _ = ws.close()
        }
    }
}

// MARK: - SessionHost conformance

extension RemoteServer {
    /// Build the primary `ModuleDefinition` for a new session. Uses the
    /// typed `_moduleDefinition` if one was registered via
    /// `module(_:_:)`; otherwise synthesises one from the untyped
    /// `moduleConfig` path (`withState(_:_:)` + `onAction(_:)`).
    public func makeModuleDefinition() -> ModuleDefinition {
        lock.lock()
        let typed = _moduleDefinition
        let mc = moduleConfig
        let ui = uiTemplate
        lock.unlock()

        if let typed = typed { return typed }
        guard let mc = mc else {
            // Should be unreachable: prepare() already validated.
            return ModuleDefinition(
                name: moduleName,
                actions: [],
                stateKeys: [],
                persist: false,
                version: 1,
                initialState: [:],
                ui: ui,
                onCreated: nil,
                onDestroyed: nil,
                actionHandlers: [:],
                onError: nil
            )
        }
        return ModuleDefinition(
            name: mc.name,
            actions: [],
            stateKeys: Array(mc.initialState.keys),
            persist: false,
            version: 1,
            initialState: mc.initialState,
            ui: ui,
            onCreated: nil,
            onDestroyed: nil,
            actionHandlers: [:],
            onError: nil
        )
    }

    /// Legacy untyped action handler shim. Non-nil only when the host
    /// was configured via `withState(_:_:)` + `onAction(_:)` without a
    /// typed `ModuleDefinition`.
    public var legacyActionHandler: ActionHandler? {
        lock.lock()
        defer { lock.unlock() }
        if _moduleDefinition != nil { return nil }
        return moduleConfig?.onAction
    }

    /// Device settings for new sessions: the defaults (or the
    /// `configureDevice` options), nil only after `disableDevice()` or with
    /// a setting incompatible with the device plane.
    public var deviceOptions: DeviceServerOptions? {
        lock.lock(); defer { lock.unlock() }
        return deviceOnLocked ? _deviceOptions : nil
    }

    /// The process-wide retained-bytes pool shared by every broker (created
    /// on first use, so a server whose clients never negotiate a device
    /// plane never allocates it).
    public var deviceRetainedBytesPool: DeviceRetainedBytesPool? {
        lock.lock(); defer { lock.unlock() }
        guard deviceOnLocked else { return nil }
        if let pool = _devicePool { return pool }
        let pool = DeviceRetainedBytesPool(limit: _deviceProcessRetainedBytes)
        _devicePool = pool
        return pool
    }

    /// Fires server-level OnConnection callbacks.
    public func onSessionReady(_ session: RemoteSession, client: ClientInfo) {
        lock.lock()
        let cbs = onConnectionCallbacks
        lock.unlock()
        for cb in cbs { cb(client) }
    }

    /// Removes the session from bookkeeping and fires OnDisconnection
    /// callbacks.
    public func onSessionDestroyed(_ session: RemoteSession, client: ClientInfo) {
        lock.lock()
        sessions.removeValue(forKey: ObjectIdentifier(session))
        let cbs = onDisconnectionCallbacks
        lock.unlock()
        for cb in cbs { cb(client) }
    }
}

// MARK: - Errors

public enum RemoteServerError: Error, CustomStringConvertible {
    case moduleNotSet
    case uiNotSet
    case invalidResourcesFile(String)
    /// `configureDevice(_:)` options the Rust broker refuses (e.g. an
    /// override of a revision that does not exist) — a programming error.
    case invalidDeviceOptions(String)

    public var description: String {
        switch self {
        case .moduleNotSet:
            return "Module not set. Call .withState() or .module() before .prepare()/.listen()"
        case .uiNotSet:
            return "UI not set. Call .ui() before .prepare()/.listen()"
        case .invalidResourcesFile(let path):
            return "Invalid resources file (expected JSON object of String → String): \(path)"
        case .invalidDeviceOptions(let reason):
            return "configureDevice(): the device broker refuses these DeviceServerOptions: \(reason)"
        }
    }
}

// MARK: - HTTP Handler

/// Simple HTTP handler for non-WebSocket requests.
///
/// NIO's `ChannelInboundHandler` / `RemovableChannelHandler` aren't
/// `Sendable`-annotated (they predate Swift concurrency and are pinned
/// to their channel's EventLoop), but adding this handler to a pipeline
/// from the childChannelInitializer hits a Sendable warning under
/// strict concurrency. `@unchecked Sendable` is the standard escape
/// hatch for NIO handlers whose thread-safety is guaranteed by the
/// EventLoop model, not the type system.
private final class HTTPHandler: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private let server: RemoteServer

    init(server: RemoteServer) {
        self.server = server
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let part = unwrapInboundIn(data)

        switch part {
        case .head(let head):
            let body: String
            let status: HTTPResponseStatus

            let isUpgrade = head.headers[canonicalForm: "upgrade"].contains { $0.lowercased() == "websocket" }
            if isUpgrade {
                // A WebSocket upgrade only reaches this handler when the
                // upgrader declined it: admission refused (RFC 001 §5).
                body = "Forbidden"
                status = .forbidden
            } else {
                switch head.uri {
                case "/health":
                    body = "OK"
                    status = .ok
                default:
                    body = "Hypen Remote Server"
                    status = .ok
                }
            }

            var headers = HTTPHeaders()
            headers.add(name: "Content-Type", value: "text/plain")
            headers.add(name: "Content-Length", value: "\(body.utf8.count)")

            let responseHead = HTTPResponseHead(version: head.version, status: status, headers: headers)
            context.write(wrapOutboundOut(.head(responseHead)), promise: nil)

            var buffer = context.channel.allocator.buffer(capacity: body.utf8.count)
            buffer.writeString(body)
            context.write(wrapOutboundOut(.body(.byteBuffer(buffer))), promise: nil)
            if status == .forbidden {
                // A refused upgrade ends the connection after the answer.
                let channel = context.channel
                context.writeAndFlush(wrapOutboundOut(.end(nil))).whenComplete { _ in
                    channel.close(promise: nil)
                }
            } else {
                context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
            }

        case .body, .end:
            break
        }
    }
}

// MARK: - Convenience

/// Quick-start a Hypen server with minimal configuration.
///
/// ```swift
/// serve(
///     moduleName: "Counter",
///     initialState: ["count": 0],
///     ui: "Column { Text(\"Count: ${state.count}\") }",
///     onAction: { action, payload, state in
///         if action == "increment" {
///             var s = state
///             s["count"] = (state["count"] as? Int ?? 0) + 1
///             return s
///         }
///         return nil
///     },
///     port: 3000
/// )
/// ```
public func serve(
    moduleName: String = "App",
    initialState: [String: Any],
    ui: String,
    onAction: ActionHandler? = nil,
    port: Int = 3000,
    hostname: String = "0.0.0.0",
    onConnection: ConnectionCallback? = nil,
    onDisconnection: ConnectionCallback? = nil
) -> RemoteServer {
    var server = RemoteServer()
        .withState(moduleName, initialState)
        .ui(ui)

    if let handler = onAction {
        server = server.onAction(handler)
    }

    server = server.config(ServerConfig(port: port, hostname: hostname))

    if let cb = onConnection {
        server = server.onConnection(cb)
    }
    if let cb = onDisconnection {
        server = server.onDisconnection(cb)
    }

    return server.listen(port)
}
