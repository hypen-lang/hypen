import Foundation
import Dispatch
import WebSocketKit

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
    case sessionAck(sessionId: String, isNew: Bool, isRestored: Bool)
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
        case let .sessionAck(sessionId, isNew, isRestored):
            return [
                "type": "sessionAck",
                "sessionId": sessionId,
                "isNew": isNew,
                "isRestored": isRestored,
            ]
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

/// Wraps a `WebSocketKit` `WebSocket` as a `SessionTransport`. Encodes
/// messages as JSON text frames. WebSocketKit already serialises writes
/// internally on its event loop.
public final class WebSocketKitTransport: SessionTransport, @unchecked Sendable {
    public let ws: WebSocket
    public init(_ ws: WebSocket) { self.ws = ws }

    public func send(_ message: OutgoingMessage) throws {
        ws.send(message.toJSONString())
    }

    public func close(code: UInt16, reason: String) {
        // WebSocketKit's close takes a `WebSocketErrorCode`; we always use
        // the "normal closure" variant for policy-driven disconnects.
        // Close reasons aren't surfaced over the WebSocket close frame
        // here — callers should prefer pushing an in-band
        // `sessionExpired` message first (RemoteSession.expireAndClose
        // does this).
        _ = code
        _ = reason
        _ = ws.close()
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
    ///     Defaults to `nil` to preserve existing `RemoteServer` behaviour;
    ///     the WebSocket adapter passes a grace window explicitly.
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

        if let ms = helloGraceMs, ms > 0 {
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

    // MARK: - Public accessors

    /// The Hypen session id, once hello has completed. Empty before then.
    public var currentSessionID: String? {
        lock.lock(); defer { lock.unlock() }; return sessionID
    }

    /// Whether the client has completed its handshake.
    public var helloIsReceived: Bool {
        lock.lock(); defer { lock.unlock() }; return helloReceived
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

    /// Feed a raw client → server text message into this session.
    public func receive(_ text: String) {
        lock.lock()
        let destroyedLocal = destroyed
        lock.unlock()
        if destroyedLocal { return }

        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "hello":
            let requestedSessionId = json["sessionId"] as? String
            let props = (json["props"] as? [String: Any]) ?? [:]
            initializeSession(requestedSessionId: requestedSessionId, props: props)

        case "dispatchAction", "action":
            let name = (json["action"] as? String) ?? (json["name"] as? String) ?? ""
            let payload = json["payload"]
            handleDispatchAction(actionName: name, payload: payload)

        default:
            // Unknown — ignore for forward compatibility.
            break
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
        lock.unlock()

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
    private func initializeSession(requestedSessionId: String?, props: [String: Any]) {
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

        let sm = host.sessionManager
        var session: Session
        var isRestored = false

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

        lock.lock()
        sessionID = session.id
        lock.unlock()
        _ = sm.trackConnection(session.id, connectionId: ObjectIdentifier(self))

        // sessionAck.
        send(.sessionAck(
            sessionId: session.id,
            isNew: !isRestored,
            isRestored: isRestored
        ))

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

        host.onSessionReady(self, client: ClientInfo(id: id, connectedAt: connectedAt))

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

        managed.start()
        lock.lock()
        autoManagedRouter = managed
        lock.unlock()
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

        // Send a stateUpdate message for client-side state inspection.
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
}
