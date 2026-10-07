import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// The Swift server's native device layer around the Rust broker: the
/// device plane is on by default (no enable call; `disableDevice()` opts
/// out; incompatible settings turn it off without stopping the server), the
/// handshake (`hello.device` → `sessionAck.device`, resumeToken), hello
/// grace for legacy clients, message routing (device text / binary frames
/// on dedicated routes), the replay firewall at the dispatch layer,
/// connection resets and admission (RFC 001 §2.2, §2.5, §5; decisions D1,
/// D6, D7).
final class DeviceSessionTests: XCTestCase {
    typealias W = DeviceTestWire

    /// A `DeviceTransport` recording UI messages, device text and frames.
    final class DeviceTestTransport: DeviceTransport, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var ui: [[String: Any]] = []
        private(set) var device: [String] = []
        private(set) var frames: [Data] = []
        private(set) var closes: [UInt16] = []
        let binary: Bool
        init(binary: Bool = true) { self.binary = binary }

        func send(_ message: OutgoingMessage) throws {
            let d = message.toDictionary()
            lock.withLock { ui.append(d) }
        }
        func close(code: UInt16, reason: String) { lock.withLock { closes.append(code) } }
        func sendDeviceText(_ text: String) { lock.withLock { device.append(text) } }
        var carriesBinary: Bool { binary }
        func sendBinary(_ frame: Data) { lock.withLock { frames.append(frame) } }
        func bufferedAmount() -> Int { 0 }

        var uiMessages: [[String: Any]] { lock.withLock { ui } }
        var closeCodes: [UInt16] { lock.withLock { closes } }
        var deviceMessages: [[String: Any]] {
            lock.withLock { device }.compactMap {
                (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
            }
        }
        func ack() -> [String: Any]? { uiMessages.first { ($0["type"] as? String) == "sessionAck" } }
        func requests(_ capability: String) -> [[String: Any]] {
            deviceMessages.filter { ($0["type"] as? String) == "deviceRequest" && ($0["capability"] as? String) == capability }
        }
    }

    private final class ResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func add(_ s: String) { lock.withLock { values.append(s) } }
        var all: [String] { lock.withLock { values } }
    }

    /// A server with NO device call at all unless `deviceOptions` are given
    /// (then `configureDevice`), and no admission configured.
    private func server(
        results: ResultBox,
        deviceOptions: DeviceServerOptions? = nil,
        sessionConfig: SessionConfig = SessionConfig(),
        configure: (RemoteServer) -> Void = { _ in }
    ) throws -> RemoteServer {
        let def = AppBuilder(["n": 0])
            .onActionAsync("perm") { ctx in
                switch await ctx.device.permissions.query(.camera) {
                case .success(let v): results.add("ok:\(v.status.rawValue)")
                case .failure(let e): results.add("err:\(e.code.rawValue):\(e.platformDetail ?? "")")
                }
            }
            .build()
        let server = RemoteServer(sessionConfig: sessionConfig)
            .module("App", def)
            .ui("Column { Text(\"device\") }")
        if let deviceOptions { server.configureDevice(deviceOptions) }
        configure(server)
        try server.prepare()
        return server
    }

    /// Records warnings/errors logged while it is installed.
    final class Warnings: HypenLogHandler, @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String] = []
        func debug(tag: String, message: String) {}
        func info(tag: String, message: String) {}
        func warn(tag: String, message: String) { lock.withLock { lines.append(message) } }
        func error(tag: String, message: String) { lock.withLock { lines.append(message) } }
        var all: [String] { lock.withLock { lines } }
    }

    private func capturingWarnings<R>(_ body: (Warnings) throws -> R) rethrows -> R {
        let warnings = Warnings()
        let previousHandler = HypenLoggerConfig.shared.handler
        let previousLevel = HypenLoggerConfig.shared.level
        HypenLoggerConfig.shared.handler = warnings
        HypenLoggerConfig.shared.level = .warn
        defer {
            HypenLoggerConfig.shared.handler = previousHandler
            HypenLoggerConfig.shared.level = previousLevel
        }
        return try body(warnings)
    }

    private func hello(device: String? = W.fullHello, sessionId: String? = nil, token: String? = nil) -> String {
        var parts = ["\"type\":\"hello\""]
        if let sessionId { parts.append("\"sessionId\":\"\(sessionId)\"") }
        if let token { parts.append("\"resumeToken\":\"\(token)\"") }
        if let device { parts.append("\"device\":\(device)") }
        return "{" + parts.joined(separator: ",") + "}"
    }

    private func waitFor(_ what: String, timeout: TimeInterval = 5, _ predicate: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !predicate() {
            if Date() > end { return XCTFail("timed out waiting for \(what)") }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    // MARK: - On by default

    /// No `configureDevice` / enable call, no admission config: a client
    /// offering `device` gets a negotiated plane.
    func testDeviceIsNegotiatedWithNoEnableCall() throws {
        let server = RemoteServer().module("App", AppBuilder([:]).build()).ui("Text(\"x\")")
        XCTAssertNoThrow(try server.prepare())
        defer { server.stop() }
        XCTAssertTrue(server.deviceEnabled)
        XCTAssertNotNil(server.deviceOptions)
        XCTAssertNil(server.deviceIncompatibility)
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        XCTAssertNotNil(try XCTUnwrap(t.ack())["device"])
        XCTAssertNotNil(session.device)
        XCTAssertEqual(t.requests("core.capabilities").count, 1)
    }

    /// `disableDevice()` is the one opt-out: the server behaves exactly like
    /// a UI-only server (no `device` in the ack, device text dropped,
    /// id-only resume), and a hello grace still initialises legacy clients.
    func testDisableDeviceOptsOut() async throws {
        let server = try server(results: ResultBox(), configure: { $0.disableDevice() })
        defer { server.stop() }
        XCTAssertFalse(server.deviceEnabled)
        XCTAssertNil(server.deviceOptions)
        XCTAssertNil(server.deviceRetainedBytesPool)
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        let ack = try XCTUnwrap(t.ack())
        XCTAssertNil(ack["device"])
        XCTAssertNil(session.device)
        XCTAssertTrue(t.deviceMessages.isEmpty)
        session.receive(W.response(1, result: [:]))
        XCTAssertTrue(t.deviceMessages.isEmpty)
        // configureDevice after disableDevice does not re-enable it.
        server.configureDevice(DeviceServerOptions(helloTimeoutMs: 1))
        XCTAssertFalse(server.deviceEnabled)

        // UI-only session: resumed by id alone.
        let sid = try XCTUnwrap(ack["sessionId"] as? String)
        session.destroy()
        let t2 = DeviceTestTransport()
        try server.createSession(transport: t2).receive(hello(sessionId: sid))
        XCTAssertEqual(t2.ack()?["sessionId"] as? String, sid)
        XCTAssertEqual(t2.ack()?["isRestored"] as? Bool, true)

        // No hello timeout either way on a device-less server.
        let t3 = DeviceTestTransport()
        _ = try server.createSession(transport: t3)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(t3.closeCodes.isEmpty)
    }

    /// A setting incompatible with the device plane (here the only one this
    /// server has: an allow-multiple session fan-out) keeps working — the
    /// server starts, with the device plane off and ONE startup warning
    /// naming the setting.
    func testAnIncompatibleSettingRunsTheServerWithDeviceOff() throws {
        try capturingWarnings { warnings in
            let server = try server(results: ResultBox(), sessionConfig: SessionConfig(concurrent: .allowMultiple))
            defer { server.stop() }
            XCTAssertFalse(server.deviceEnabled)
            XCTAssertNil(server.deviceOptions)
            XCTAssertNotNil(server.deviceIncompatibility)
            try server.prepare() // idempotent: still one warning
            let lines = warnings.all.filter { $0.contains("Device plane off") }
            XCTAssertEqual(lines.count, 1, "\(warnings.all)")
            XCTAssertTrue(lines.first?.contains("allowMultiple") ?? false, lines.first ?? "")

            let t = DeviceTestTransport()
            let session = try server.createSession(transport: t)
            session.receive(hello())
            let ack = try XCTUnwrap(t.ack())
            XCTAssertNil(ack["device"])
            XCTAssertNil(session.device)
            XCTAssertNotNil(ack["resumeToken"])
            XCTAssertTrue(t.deviceMessages.isEmpty)
        }
    }

    // MARK: - Handshake

    func testHelloDeviceNegotiatesAckTokenAndCoreStreamOnDedicatedRoutes() throws {
        let results = ResultBox()
        let server = try server(results: results)
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())

        let ack = try XCTUnwrap(t.ack())
        let device = try XCTUnwrap(ack["device"] as? [String: Any])
        XCTAssertEqual(device["protocolVersion"] as? Int, 1)
        XCTAssertEqual(device["binary"] as? Bool, true)
        let names = (device["capabilities"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
        XCTAssertEqual(names.first, "core.capabilities")
        XCTAssertTrue(names.contains("mic.record"))
        let token = try XCTUnwrap(ack["resumeToken"] as? String)
        XCTAssertEqual(token.count, 43)

        // The core stream is a device message, never an OutgoingMessage.
        XCTAssertEqual(t.requests("core.capabilities").count, 1)
        XCTAssertTrue(t.uiMessages.allSatisfy { !(($0["type"] as? String) ?? "").hasPrefix("device") })
        XCTAssertNotNil(session.device)
        XCTAssertEqual(session.device?.coreStreamId, (t.requests("core.capabilities").first?["id"] as? NSNumber)?.uint32Value)
    }

    func testAHelloWithoutDeviceOrWithAnInvalidOneRunsUIOnly() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        // Duplicate key inside hello.device: seen on the exact text (D4/D7).
        let dup = #"{"protocolVersions":[1],"protocolVersions":[1],"binary":true,"capabilities":[]}"#
        for device in [nil, dup, #"{"protocolVersions":[1],"binary":true}"#] as [String?] {
            let t = DeviceTestTransport()
            let session = try server.createSession(transport: t)
            session.receive(hello(device: device))
            let ack = try XCTUnwrap(t.ack())
            XCTAssertNil(ack["device"])
            XCTAssertNotNil(ack["resumeToken"], "every server issues resume credentials")
            XCTAssertNil(session.device)
            XCTAssertTrue(t.deviceMessages.isEmpty)
            // Device messages are dropped without a plane.
            session.receive(W.response(1, result: [:]))
            XCTAssertTrue(t.deviceMessages.isEmpty)
        }
    }

    /// A disabled device plane is logged with the Rust handshake's reason.
    func testADisabledDevicePlaneLogsTheHandshakeReason() throws {
        try capturingWarnings { warnings in
            let server = try server(results: ResultBox())
            defer { server.stop() }
            let t = DeviceTestTransport()
            let session = try server.createSession(transport: t)
            session.receive(hello(device: #"{"protocolVersions":[0],"binary":true,"capabilities":[]}"#))
            XCTAssertNil(try XCTUnwrap(t.ack())["device"])
            XCTAssertNil(session.device)
            let line = warnings.all.first { $0.contains("device plane disabled") }
            XCTAssertNotNil(line, "\(warnings.all)")
            XCTAssertTrue(line?.contains("invalid hello.device: ") ?? false, line ?? "")
        }
    }

    func testATransportWithoutDeviceRoutesNeverNegotiates() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t = AsyncStreamTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        XCTAssertNil(session.device)
        XCTAssertNotNil(session.currentSessionID)
    }

    /// Legacy clients that never send `hello` are still auto-initialised
    /// after the grace period on a device-capable server; that session
    /// simply has no device plane. Without a grace window a device-capable
    /// connection is bounded by the handshake timeout.
    func testHelloGraceInitialisesLegacyClientsWithoutADevicePlane() async throws {
        let server = try server(results: ResultBox(), deviceOptions: DeviceServerOptions(helloTimeoutMs: 60))
        defer { server.stop() }
        XCTAssertTrue(server.deviceEnabled)
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t, helloGraceMs: 10)
        await waitFor("grace initialisation") { t.ack() != nil }
        let ack = try XCTUnwrap(t.ack())
        XCTAssertNil(ack["device"])
        XCTAssertNotNil(ack["resumeToken"])
        XCTAssertNotNil(session.currentSessionID)
        XCTAssertNil(session.device)
        XCTAssertTrue(t.uiMessages.contains { ($0["type"] as? String) == "initialTree" })
        // The grace-initialised session is never closed by the handshake timeout.
        try await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(t.closeCodes.isEmpty)
        // A late hello (with device) does not re-initialise it.
        session.receive(hello())
        XCTAssertNil(session.device)
        XCTAssertEqual(t.uiMessages.filter { ($0["type"] as? String) == "sessionAck" }.count, 1)

        // No grace: the handshake timeout closes a silent connection.
        let t1 = DeviceTestTransport()
        let s1 = try server.createSession(transport: t1)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertNil(s1.currentSessionID)
        await waitFor("handshake timeout close") { t1.closeCodes == [1008] }

        // A hello in time cancels the timeout.
        let t2 = DeviceTestTransport()
        let s2 = try server.createSession(transport: t2)
        s2.receive(hello())
        try await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(t2.closeCodes.isEmpty)
    }

    func testDispatchBeforeHelloIsRejected() async throws {
        let results = ResultBox()
        let server = try server(results: results)
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(#"{"type":"dispatchAction","action":"perm"}"#)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(results.all.isEmpty)
        XCTAssertTrue(t.uiMessages.isEmpty)
    }

    // MARK: - Resume credential

    func testResumeRequiresTheCurrentTokenAndRotatesIt() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t1 = DeviceTestTransport()
        let s1 = try server.createSession(transport: t1)
        s1.receive(hello())
        let first = try XCTUnwrap(t1.ack())
        let sid = try XCTUnwrap(first["sessionId"] as? String)
        let token1 = try XCTUnwrap(first["resumeToken"] as? String)
        s1.destroy()

        // The public session id alone never resumes.
        let t2 = DeviceTestTransport()
        try server.createSession(transport: t2).receive(hello(sessionId: sid))
        XCTAssertEqual(t2.ack()?["isNew"] as? Bool, true)
        XCTAssertNotEqual(t2.ack()?["sessionId"] as? String, sid)

        let t3 = DeviceTestTransport()
        let s3 = try server.createSession(transport: t3)
        s3.receive(hello(sessionId: sid, token: token1))
        let resumed = try XCTUnwrap(t3.ack())
        XCTAssertEqual(resumed["sessionId"] as? String, sid)
        XCTAssertEqual(resumed["isRestored"] as? Bool, true)
        let token2 = try XCTUnwrap(resumed["resumeToken"] as? String)
        XCTAssertNotEqual(token2, token1)
        // Resuming app state never resumes device operations: a fresh broker.
        XCTAssertEqual(t3.requests("core.capabilities").count, 1)
        s3.destroy()

        let t4 = DeviceTestTransport()
        try server.createSession(transport: t4).receive(hello(sessionId: sid, token: token1))
        XCTAssertEqual(t4.ack()?["isNew"] as? Bool, true, "a rotated-away token no longer resumes")
    }

    /// A UI-only session (its client offered no `device`) keeps the legacy
    /// id-only resume; once a session has had a device plane, its id alone
    /// no longer resumes it.
    func testUIOnlySessionResumesByIdWithoutAToken() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t1 = DeviceTestTransport()
        let s1 = try server.createSession(transport: t1)
        s1.receive(hello(device: nil))
        let first = try XCTUnwrap(t1.ack())
        XCTAssertNil(first["device"])
        XCTAssertNotNil(first["resumeToken"], "the token is always issued")
        let sid = try XCTUnwrap(first["sessionId"] as? String)
        XCTAssertFalse(server.sessionManager.resumeRequiresToken(sid))
        s1.destroy()

        // The public id alone resumes a UI-only session.
        let t2 = DeviceTestTransport()
        let s2 = try server.createSession(transport: t2)
        s2.receive(hello(sessionId: sid))
        let resumed = try XCTUnwrap(t2.ack())
        XCTAssertEqual(resumed["sessionId"] as? String, sid)
        XCTAssertEqual(resumed["isRestored"] as? Bool, true)
        // ... this time with a device plane: from now on the token is required.
        XCTAssertNotNil(resumed["device"])
        XCTAssertTrue(server.sessionManager.resumeRequiresToken(sid))
        let token = try XCTUnwrap(resumed["resumeToken"] as? String)
        s2.destroy()

        let t3 = DeviceTestTransport()
        try server.createSession(transport: t3).receive(hello(device: nil, sessionId: sid))
        XCTAssertEqual(t3.ack()?["isNew"] as? Bool, true, "a device session is never resumed by id alone")
        XCTAssertNotEqual(t3.ack()?["sessionId"] as? String, sid)

        let t4 = DeviceTestTransport()
        try server.createSession(transport: t4).receive(hello(device: nil, sessionId: sid, token: token))
        XCTAssertEqual(t4.ack()?["sessionId"] as? String, sid)
        XCTAssertEqual(t4.ack()?["isRestored"] as? Bool, true)
    }

    func testResumeTokensAreConstantShapeAndRevocable() {
        let tokens = DeviceResumeTokens()
        let a = tokens.issue("s")
        XCTAssertTrue(tokens.verify("s", a))
        XCTAssertFalse(tokens.verify("s", nil))
        XCTAssertFalse(tokens.verify("s", String(a.dropLast()) + (a.last == "A" ? "B" : "A")))
        XCTAssertFalse(tokens.verify("other", a))
        let b0 = tokens.issue("s")
        XCTAssertNotEqual(a, b0)
        XCTAssertFalse(tokens.verify("s", a))
        XCTAssertFalse(tokens.requiresToken("s"))
        _ = tokens.issue("s", devicePlane: true)
        XCTAssertTrue(tokens.requiresToken("s"))
        _ = tokens.issue("s")
        XCTAssertTrue(tokens.requiresToken("s"), "sticky once the session had a device plane")
        let b = tokens.issue("s")
        tokens.revoke("s")
        XCTAssertFalse(tokens.verify("s", b))
        XCTAssertFalse(tokens.requiresToken("s"))
        XCTAssertEqual(Set((0..<50).map { _ in tokens.issue("x") }).count, 50)
    }

    // MARK: - Handler API through a session

    func testHandlerDeviceCallsRoundTripAndReplayedDispatchIsFirewalled() async throws {
        let results = ResultBox()
        let server = try server(results: results)
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())

        session.receive(#"{"type":"dispatchAction","action":"perm"}"#)
        await waitFor("permission.query request") { !t.requests("permission.query").isEmpty }
        let req = try XCTUnwrap(t.requests("permission.query").last)
        let owner = try XCTUnwrap(req["owner"] as? [String: Any])
        XCTAssertEqual(owner["activationId"] as? Int, 1, "the primary module is activated after initialTree")
        let id = try XCTUnwrap((req["id"] as? NSNumber)?.uint32Value)
        session.receive(W.response(id, result: ["status": "granted"]))
        await waitFor("result") { results.all == ["ok:granted"] }

        // Replay / broadcast: handlers run, device calls are refused, nothing is sent.
        session.dispatchReplayed("perm")
        server.broadcastAction("perm")
        await waitFor("replay refusals") { results.all.count == 3 }
        XCTAssertEqual(Array(results.all.dropFirst()), ["err:unavailable:replay", "err:unavailable:replay"])
        XCTAssertEqual(t.requests("permission.query").count, 1)
    }

    func testBinaryFramesReachTheBrokerAndRepeatedViolationsResetTheSocket() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        let plane = try XCTUnwrap(session.device)
        session.receiveBinary(W.frame(5, 0, 0, Data([1]), version: 7))
        XCTAssertEqual(plane.connectionViolations, 1)
        for _ in 0..<64 { session.receiveBinary(W.frame(5, 0, 0, Data([1]), version: 7)) }
        XCTAssertEqual(t.closeCodes, [1012], "a broker-closed device plane resets the socket")
        XCTAssertNil(session.device)
    }

    func testOversizeDeviceTextIsACountedViolationNeverParsed() throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        let plane = try XCTUnwrap(session.device)
        let huge = "{\"type\":\"deviceEvent\",\"id\":1,\"event\":{\"pad\":\"" + String(repeating: "x", count: 1_100_000) + "\"}}"
        session.receive(huge)
        XCTAssertEqual(plane.connectionViolations, 1)
    }

    func testDestroyClosesThePlaneWithConnectionLost() async throws {
        let server = try server(results: ResultBox())
        defer { server.stop() }
        let t = DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(hello())
        let plane = try XCTUnwrap(session.device)
        let sent = t.deviceMessages.count
        session.destroy()
        XCTAssertTrue(plane.isClosed)
        XCTAssertEqual(t.deviceMessages.count, sent, "nothing is sent on teardown")
    }

    // MARK: - Admission

    /// No admission configured: the server starts, admits every client and
    /// logs ONE startup warning (device prerequisites never stop a server).
    func testNoAdmissionConfigIsAdmittedWithAWarning() async throws {
        let server = RemoteServer().module("App", AppBuilder([:]).build()).ui("Text(\"x\")")
        XCTAssertNoThrow(try server.prepare())
        XCTAssertEqual(server.admissionWarning,
                       "no allowedOrigins/authenticate configured — any client can connect; set them in production")
        for headers in [[("Origin", "https://evil.example")], [], [("Authorization", "Bearer x")]] {
            let request = DeviceUpgradeRequest(uri: "/ws", headers: headers.map { (name: $0.0, value: $0.1) })
            let refusal = await DeviceAdmission.refusal(for: request, allowedOrigins: nil, authenticate: nil)
            XCTAssertNil(refusal, "\(headers)")
        }
        let lines = capturingWarnings { warnings -> [String] in
            server.config(ServerConfig(port: 0, hostname: "127.0.0.1")).listen(0)
            server.stop()
            return warnings.all.filter { $0.contains("any client can connect") }
        }
        XCTAssertEqual(lines.count, 1, "\(lines)")

        // Either admission setting silences it.
        XCTAssertNil(RemoteServer().config(ServerConfig(authenticate: { _ in true })).admissionWarning)
        XCTAssertNil(RemoteServer().config(ServerConfig(allowedOrigins: ["https://a.example"])).admissionWarning)
    }

    func testAdmissionRules() async {
        func req(_ headers: [(String, String)]) -> DeviceUpgradeRequest {
            DeviceUpgradeRequest(uri: "/ws", headers: headers.map { (name: $0.0, value: $0.1) })
        }
        let allowed: Set<String> = ["https://app.example"]
        let auth: DeviceAuthenticator = { $0.header("authorization") == "Bearer t" }
        // Origin present: allowlist.
        var r = await DeviceAdmission.refusal(for: req([("Origin", "https://evil.example")]),
                                              allowedOrigins: allowed, authenticate: nil)
        XCTAssertNotNil(r)
        r = await DeviceAdmission.refusal(for: req([("Origin", "https://APP.example:443/")]),
                                          allowedOrigins: allowed, authenticate: nil)
        XCTAssertNil(r)
        // No allowlist: an Origin is not refused for lacking one (admission
        // is not tied to the device plane); the authenticator still decides.
        r = await DeviceAdmission.refusal(for: req([("Origin", "https://app.example"), ("Authorization", "Bearer t")]),
                                          allowedOrigins: nil, authenticate: auth)
        XCTAssertNil(r)
        r = await DeviceAdmission.refusal(for: req([("Origin", "https://app.example")]),
                                          allowedOrigins: nil, authenticate: auth)
        XCTAssertNotNil(r)
        // No Origin: the authenticator decides; an allowlist without one → fail closed.
        r = await DeviceAdmission.refusal(for: req([]), allowedOrigins: allowed, authenticate: nil)
        XCTAssertNotNil(r)
        r = await DeviceAdmission.refusal(for: req([("Authorization", "Bearer t")]),
                                          allowedOrigins: nil, authenticate: auth)
        XCTAssertNil(r)
        r = await DeviceAdmission.refusal(for: req([("Authorization", "Bearer x")]),
                                          allowedOrigins: nil, authenticate: auth)
        XCTAssertNotNil(r)
        // The authenticator also runs for an allowed Origin.
        r = await DeviceAdmission.refusal(for: req([("Origin", "https://app.example")]),
                                          allowedOrigins: allowed, authenticate: auth)
        XCTAssertNotNil(r)
        // Neither configured: open admission.
        r = await DeviceAdmission.refusal(for: req([("Origin", "https://evil.example")]),
                                          allowedOrigins: nil, authenticate: nil)
        XCTAssertNil(r)
        r = await DeviceAdmission.refusal(for: req([]), allowedOrigins: nil, authenticate: nil)
        XCTAssertNil(r)
        XCTAssertEqual(DeviceAdmission.normalizeOrigin("HTTP://Example.COM:80"), "http://example.com")
        XCTAssertEqual(DeviceAdmission.normalizeOrigin("https://a.b:8443"), "https://a.b:8443")
    }

    // MARK: - Raw member location

    func testTopLevelMemberLocatorReadsTheExactText() {
        XCTAssertEqual(deviceFindTopLevelMember(#"{"type":"hello","device":{"a":[1,{"b":"}"}]},"x":1.5}"#, "device"),
                       .found(#"{"a":[1,{"b":"}"}]}"#))
        XCTAssertEqual(deviceFindTopLevelMember(#"{"props":{"device":1},"type":"hello"}"#, "device"), .absent)
        XCTAssertEqual(deviceFindTopLevelMember(#" { "device" : true }"#, "device"), .found("true"))
        XCTAssertEqual(deviceFindTopLevelMember(#"{"device":1,"device":2}"#, "device"),
                       .malformed("duplicate \"device\" member"))
        XCTAssertEqual(deviceFindTopLevelMember("[1]", "device"), .malformed("malformed object"))
        XCTAssertEqual(deviceFindTopLevelMember(#"{"a":1,}"#, "device"), .malformed("malformed object"))
        XCTAssertEqual(deviceFindTopLevelMember(#"{"a":1 "device":2}"#, "device"), .malformed("malformed object"))
        XCTAssertEqual(deviceFindTopLevelMember("{}", "device"), .absent)
        XCTAssertEqual(deviceFindTopLevelMember(#"{"type":"deviceEvent","id":1}"#, "type"), .found(#""deviceEvent""#))
        // Keys are unescaped as JSON.parse does: an escaped spelling matches.
        XCTAssertEqual(deviceFindTopLevelMember(#"{"d\u0065vice":[1]}"#, "device"), .found("[1]"))
    }

    // MARK: - Routing type

    func testMessageTypeIsResolvedLikeJSONParse() {
        XCTAssertEqual(deviceMessageType(#"{"type":"deviceEvent","id":1}"#), "deviceEvent")
        // The last duplicate wins (JSON.parse); the broker judges the rest.
        XCTAssertEqual(deviceMessageType(#"{"type":"deviceRequest","type":"deviceEvent","id":1}"#), "deviceEvent")
        XCTAssertEqual(deviceMessageType(#"{"type":"deviceEvent","type":"hello"}"#), "hello")
        XCTAssertEqual(deviceMessageType(#"{"type":"device\u0045vent"}"#), "deviceEvent")
        XCTAssertEqual(deviceMessageType(#" {"\ud800":1, "type" : "deviceResponse"}"#), "deviceResponse")
        // Malformed after the type (not JSON at all): still announced.
        XCTAssertEqual(deviceMessageType(#"{"type":"deviceEvent","id":1.0,"event":{"#), "deviceEvent")
        XCTAssertEqual(deviceMessageType(#"{"props":{"type":"deviceEvent"},"type":"hello"}"#), "hello")
        XCTAssertNil(deviceMessageType(#"{"type":["deviceEvent"]}"#))
        XCTAssertNil(deviceMessageType(#"["deviceEvent"]"#))
        XCTAssertNil(deviceMessageType("\u{FEFF}{\"type\":\"deviceEvent\"}"), "a BOM is not JSON whitespace")
        XCTAssertNil(deviceMessageType(#"{"type":"device\qEvent"}"#), "an invalid escape is not a string")
        XCTAssertEqual(deviceDecodeStringLiteral(Array(#""a\ud83d\ude00\n""#.utf8)[...]).map { String(decoding: $0, as: UTF8.self) },
                       "a\u{1F600}\n")
        XCTAssertEqual(deviceDecodeStringLiteral(Array(#""\udc00""#.utf8)[...]).map { String(decoding: $0, as: UTF8.self) },
                       "\u{FFFD}")
        XCTAssertNil(deviceDecodeStringLiteral(Array("\"a\u{01}\"".utf8)[...]), "raw control characters are not JSON")
    }
}
