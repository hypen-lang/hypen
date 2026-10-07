import XCTest
@testable import HypenServer

/// Attach mode for the agent surface: `RemoteServer.attach(_:)` binds an
/// `AgentHandle` to one live user session so a guarded dispatch runs on
/// that user's engine and the user's transport receives the patches.
///
/// Three properties are pinned here:
///   - **wire-identical**: an attached dispatch emits exactly what a click
///     on that session emits — `patch` at revision N+1, then `stateUpdate`
///     at N+2 — nothing more, nothing less;
///   - **refusal-is-silent**: a guard refusal throws, sends nothing, and
///     leaves the revision alone;
///   - **never-destroys**: a handle never owns the session — dropping it
///     changes nothing, and the session's own `destroy()` is what makes a
///     handle dead.
///
/// Fixture mirrors `NestedRouterAutoWireTests` (in-memory transport, hello
/// fed through `receive`). Like `NativeEngineTests`, these need the native
/// library:
///   cd hypen-engine-rs && cargo build --release --features uniffi
///   LD_LIBRARY_PATH=../target/release swift test --filter AgentAttachTests
final class AgentAttachTests: XCTestCase {

    // MARK: - Fixture

    /// Synchronous in-memory transport that records every outgoing
    /// message. The dispatch paths under test are synchronous end to end
    /// (sync handler → onChange → engine.updateState → onPatches → send),
    /// so no polling is needed to observe them.
    private final class RecordingTransport: SessionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [OutgoingMessage] = []
        private var closedCount = 0

        func send(_ message: OutgoingMessage) throws {
            lock.lock()
            defer { lock.unlock() }
            messages.append(message)
        }

        func close(code: UInt16, reason: String) {
            lock.lock()
            defer { lock.unlock() }
            closedCount += 1
        }

        var all: [OutgoingMessage] {
            lock.lock()
            defer { lock.unlock() }
            return messages
        }

        var count: Int { all.count }

        var wasClosed: Bool {
            lock.lock()
            defer { lock.unlock() }
            return closedCount > 0
        }
    }

    /// `(type, revision)` for a message — the shape "wire-identical"
    /// compares. Handshake messages carry no revision of interest.
    private func shape(_ message: OutgoingMessage) -> String {
        switch message {
        case .sessionAck: return "sessionAck"
        case .sessionExpired: return "sessionExpired"
        case let .initialTree(_, _, _, revision): return "initialTree@\(revision)"
        case let .patch(_, _, revision): return "patch@\(revision)"
        case let .stateUpdate(_, _, revision): return "stateUpdate@\(revision)"
        }
    }

    private static let cartTemplate = """
    Column {
        Text("Total: @{state.total}")
        Button("@actions.addToCart") { Text("Add") }
    }
    """

    /// A typed-module server: `addToCart` is a declared `.onAction`, so it
    /// is on the external surface. Nothing else is declared — no Router,
    /// no `.bind()` — so the `hypen.*` built-ins are off the surface too.
    private func makeCartServer() throws -> RemoteServer {
        let testApp = HypenApp()
        let cart = testApp.module("Cart")
            .defineState(["total": 0])
            .onAction("addToCart") { ctx in
                let total = ctx.state.get("total") as? Int ?? 0
                ctx.state.set("total", total + 1)
            }
            .ui(Self.cartTemplate)
        let server = RemoteServer()
            .app(testApp)
            .module("Cart", cart)
            .ui(Self.cartTemplate)
        try server.prepare()
        return server
    }

    /// Create a session, complete hello, and drain the handshake
    /// (`sessionAck`, `initialTree`). Returns the session and its
    /// transport, positioned so the next recorded message is the first
    /// post-handshake one.
    private func readySession(
        on server: RemoteServer
    ) throws -> (session: RemoteSession, transport: RecordingTransport, sessionID: String) {
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)
        session.receive("{\"type\":\"hello\"}")
        let sid = try XCTUnwrap(session.currentSessionID, "hello should complete synchronously")
        XCTAssertTrue(session.isReady, "isReady flips once initialTree has been sent")
        XCTAssertEqual(
            transport.all.map(shape), ["sessionAck", "initialTree@0"],
            "handshake should emit exactly sessionAck then initialTree"
        )
        return (session, transport, sid)
    }

    // MARK: - Attach lookup

    func testAttachReturnsHandleForReadySession() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (session, _, sid) = try readySession(on: server)

        let handle = try XCTUnwrap(server.attach(sid))
        XCTAssertEqual(handle.sessionID, sid)
        XCTAssertTrue(handle.isAlive)
        XCTAssertEqual(try handle.revision, 0)
        XCTAssertEqual(try handle.revision, session.currentRevision)

        let names = try handle.listActions().map(\.name)
        XCTAssertTrue(names.contains("addToCart"), "declared onAction should be listed, got \(names)")
        XCTAssertFalse(names.contains("__hypen_bind"), "framework internals never appear")
    }

    func testAttachUnknownIdReturnsNil() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        _ = try readySession(on: server)

        XCTAssertNil(server.attach("session_does_not_exist"))
        XCTAssertNil(server.attach(""))
    }

    func testAttachBeforeHelloReturnsNil() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)

        // No hello yet: no session id, not ready. The client id
        // (`client_N`) is not a Hypen session id and must not match either.
        XCTAssertNil(session.currentSessionID)
        XCTAssertFalse(session.isReady)
        XCTAssertNil(server.attach(session.id))

        session.destroy()
    }

    // MARK: - Wire-identical

    func testAttachedDispatchEmitsPatchThenStateUpdate() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (session, transport, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))
        let before = transport.count

        try handle.dispatch("addToCart")

        let emitted = Array(transport.all.dropFirst(before))
        XCTAssertEqual(
            emitted.map(shape), ["patch@1", "stateUpdate@2"],
            "an attached dispatch streams the handler's patch, then the stateUpdate tail"
        )
        guard emitted.count == 2 else {
            return XCTFail("expected exactly two messages, got \(emitted.map(shape))")
        }

        if case let .patch(module, patches, _) = emitted[0] {
            XCTAssertEqual(module, "Cart")
            XCTAssertFalse(patches.isEmpty, "the Text bound to @{state.total} should re-render")
        } else {
            XCTFail("first message should be a patch, got \(shape(emitted[0]))")
        }
        if case let .stateUpdate(module, state, _) = emitted[1] {
            XCTAssertEqual(module, "Cart")
            XCTAssertEqual(state["total"] as? Int, 1)
        } else {
            XCTFail("second message should be a stateUpdate, got \(shape(emitted[1]))")
        }

        // Every view of the result agrees: session, engine read, revision.
        XCTAssertEqual(session.currentState()["total"] as? Int, 1)
        XCTAssertEqual(try handle.getState(path: "total") as? Int, 1)
        XCTAssertEqual(try handle.revision, 2)
        XCTAssertEqual(session.currentRevision, 2)
    }

    func testAttachedDispatchMatchesClickOnTheWire() throws {
        let server = try makeCartServer()
        defer { server.stop() }

        // Session A: driven by a click through the renderer path.
        let (clickSession, clickTransport, _) = try readySession(on: server)
        let clickBefore = clickTransport.count
        clickSession.receive("""
        {"type":"dispatchAction","action":"addToCart"}
        """)
        let clickEmitted = Array(clickTransport.all.dropFirst(clickBefore)).map(shape)

        // Session B: driven by an attached agent.
        let (agentSession, agentTransport, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))
        let agentBefore = agentTransport.count
        try handle.dispatch("addToCart")
        let agentEmitted = Array(agentTransport.all.dropFirst(agentBefore)).map(shape)

        XCTAssertEqual(clickEmitted, ["patch@1", "stateUpdate@2"], "click baseline")
        XCTAssertEqual(
            agentEmitted, clickEmitted,
            "an attached dispatch must emit the same message types with the same revision bookkeeping as a click"
        )
        XCTAssertEqual(clickSession.currentState()["total"] as? Int, 1)
        XCTAssertEqual(agentSession.currentState()["total"] as? Int, 1)
    }

    func testDispatchWithPayloadReachesHandler() throws {
        let testApp = HypenApp()
        let seen = TestCounter<Int?>(nil)
        let cart = testApp.module("Cart")
            .defineState(["total": 0])
            .onAction("addToCart") { ctx in
                let amount = (ctx.action.payload as? [String: Any])?["amount"] as? Int ?? 1
                seen.set(amount)
                let total = ctx.state.get("total") as? Int ?? 0
                ctx.state.set("total", total + amount)
            }
            .ui(Self.cartTemplate)
        let server = RemoteServer()
            .app(testApp)
            .module("Cart", cart)
            .ui(Self.cartTemplate)
        try server.prepare()
        defer { server.stop() }
        let (_, transport, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))
        let before = transport.count

        try handle.dispatch("addToCart", payload: ["amount": 5])

        XCTAssertEqual(seen.current, 5)
        XCTAssertEqual(try handle.getState(path: "total") as? Int, 5)
        XCTAssertEqual(Array(transport.all.dropFirst(before)).map(shape), ["patch@1", "stateUpdate@2"])
    }

    // MARK: - Refusal is silent

    func testRefusedDispatchEmitsNothingAndBumpsNoRevision() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (session, transport, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))
        let before = transport.count

        // Undeclared name.
        XCTAssertThrowsError(try handle.dispatch("notDeclared")) { error in
            XCTAssertTrue("\(error)".contains("notDeclared"), "expected a refusal naming the action, got \(error)")
        }
        // Framework internal, refused by name however it is spelled.
        XCTAssertThrowsError(
            try handle.dispatch("__hypen_bind", payload: ["path": "total", "value": 99])
        ) { error in
            XCTAssertTrue("\(error)".contains("__hypen_bind"), "got \(error)")
        }
        // Router built-in with no declared Router behind it.
        XCTAssertThrowsError(try handle.dispatch(ExternalAction.navigate, payload: ["to": "/"]))

        XCTAssertEqual(transport.count, before, "a refusal must put nothing on the user's transport")
        XCTAssertEqual(try handle.revision, 0, "a refusal must not bump the revision")
        XCTAssertEqual(session.currentRevision, 0)
        XCTAssertEqual(session.currentState()["total"] as? Int, 0, "state untouched")
        XCTAssertFalse(transport.wasClosed, "a refusal never closes the user's transport")
        XCTAssertTrue(handle.isAlive, "a refusal does not kill the handle")

        // The session is still perfectly usable afterwards.
        try handle.dispatch("addToCart")
        XCTAssertEqual(Array(transport.all.dropFirst(before)).map(shape), ["patch@1", "stateUpdate@2"])
    }

    func testAttachUnderLegacyUntypedShimIsRefused() throws {
        // `withState` + `onAction` never registers engine handlers and
        // declares no actions, so the guard refuses everything: attach
        // requires a typed module. Documented in CLAUDE.md.
        let server = RemoteServer()
            .withState("Counter", ["count": 0])
            .onAction { action, _, state in
                guard action == "increment" else { return nil }
                var next = state
                next["count"] = (state["count"] as? Int ?? 0) + 1
                return next
            }
            .ui("""
            Column {
                Text("Count: @{state.count}")
                Button("@actions.increment") { Text("+") }
            }
            """)
        try server.prepare()
        defer { server.stop() }
        let (session, transport, sid) = try readySession(on: server)

        let handle = try XCTUnwrap(server.attach(sid), "the session is live; attach itself succeeds")
        XCTAssertFalse(try handle.listActions().contains(where: { $0.name == "increment" }))
        let before = transport.count

        XCTAssertThrowsError(try handle.dispatch("increment"))

        XCTAssertEqual(transport.count, before)
        XCTAssertEqual(session.currentRevision, 0)
        XCTAssertEqual(session.currentState()["count"] as? Int, 0)
    }

    // MARK: - Never destroys

    func testDroppingHandleLeavesSessionUntouched() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (session, transport, sid) = try readySession(on: server)

        var handle: AgentHandle? = server.attach(sid)
        XCTAssertNotNil(handle)
        try handle?.dispatch("addToCart")
        handle = nil

        XCTAssertFalse(session.isDestroyed, "a handle never owns the session")
        XCTAssertTrue(session.isReady)
        XCTAssertFalse(transport.wasClosed)
        XCTAssertNotNil(server.attach(sid), "re-attach works after the previous handle was dropped")

        // The user's own path keeps working.
        let before = transport.count
        session.receive("""
        {"type":"dispatchAction","action":"addToCart"}
        """)
        XCTAssertEqual(Array(transport.all.dropFirst(before)).map(shape), ["patch@3", "stateUpdate@4"])
        XCTAssertEqual(session.currentState()["total"] as? Int, 2)
    }

    func testDestroyedSessionMakesHandleDead() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (session, transport, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))
        XCTAssertTrue(handle.isAlive)

        // The user's transport closes; the session tears itself down as
        // it always did. The handle merely observes that.
        session.destroy()

        XCTAssertFalse(handle.isAlive)
        XCTAssertNil(server.attach(sid), "a destroyed session is not attachable")
        let before = transport.count

        XCTAssertThrowsError(try handle.dispatch("addToCart")) { error in
            guard case AgentHandleError.sessionGone(let gone) = error else {
                return XCTFail("expected sessionGone, got \(error)")
            }
            XCTAssertEqual(gone, sid)
        }
        XCTAssertThrowsError(try handle.listActions())
        XCTAssertThrowsError(try handle.getState(path: "total"))
        XCTAssertThrowsError(try handle.manifest())
        XCTAssertThrowsError(try handle.revision)

        XCTAssertEqual(transport.count, before, "a dead handle emits nothing")
    }

    func testServerStopDoesNotRunThroughHandle() throws {
        // `stop()` tears sessions down through the server's own
        // bookkeeping. A handle that outlives it simply reports dead.
        let server = try makeCartServer()
        let (session, _, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))

        server.stop()

        XCTAssertTrue(session.isDestroyed)
        XCTAssertFalse(handle.isAlive)
        XCTAssertThrowsError(try handle.dispatch("addToCart"))
    }

    // MARK: - Manifest

    func testManifestIsEngineComposedJSON() throws {
        let server = try makeCartServer()
        defer { server.stop() }
        let (_, _, sid) = try readySession(on: server)
        let handle = try XCTUnwrap(server.attach(sid))

        let json = try handle.manifest()
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
        let parsed = try XCTUnwrap(object as? [String: Any], "manifest should be a JSON object, got \(json)")
        XCTAssertNotNil(parsed["tools"], "engine manifest carries `tools`")
        XCTAssertTrue(json.contains("addToCart"), "the declared action should be advertised as a tool")
    }
}
