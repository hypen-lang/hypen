import XCTest
@testable import HypenServer

/// The remote `viewport` message (hypen-web/docs/virtualization.md §4):
/// accepted only after hello, malformed reports ignored, bounds clamped to
/// `UInt32`, applied to this session's engine only, patches out as an
/// ordinary `patch` — never an action, never a `stateUpdate`.
///
/// Needs the native library:
///   cd hypen-engine-rs && cargo build --release --features uniffi
///   LD_LIBRARY_PATH=../target/release swift test --filter ViewportTests
final class ViewportTests: XCTestCase {

    private final class RecordingTransport: SessionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [OutgoingMessage] = []
        private var closedCount = 0

        func send(_ message: OutgoingMessage) throws {
            lock.lock(); defer { lock.unlock() }
            messages.append(message)
        }

        func close(code: UInt16, reason: String) {
            lock.lock(); defer { lock.unlock() }
            closedCount += 1
        }

        var all: [OutgoingMessage] {
            lock.lock(); defer { lock.unlock() }
            return messages
        }

        var wasClosed: Bool {
            lock.lock(); defer { lock.unlock() }
            return closedCount > 0
        }
    }

    private static let template = """
    Column {
        Text("Count: @{state.count}")
        List(@state.items, key: "id") { Text("@{item.name}") }
    }
    """

    private func makeServer(actionLog: TestEventLog? = nil) throws -> RemoteServer {
        let items: [[String: Any]] = (0..<500).map { ["id": "i\($0)", "name": "Item \($0)"] }
        let testApp = HypenApp()
        let mod = testApp.module("Feed")
            .defineState(["count": 0, "items": items])
            .onAction("bump") { ctx in
                actionLog?.append("bump")
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .ui(Self.template)
        let server = RemoteServer()
            .app(testApp)
            .module("Feed", mod)
            .ui(Self.template)
        try server.prepare()
        return server
    }

    private func patches(of message: OutgoingMessage) -> [[String: Any]] {
        switch message {
        case let .initialTree(_, _, patches, _): return patches
        case let .patch(_, patches, _): return patches
        default: return []
        }
    }

    /// The id and latest `__virt.window` of the windowed list, from every
    /// patch the session has sent so far.
    private func virtWindow(in messages: [OutgoingMessage]) -> (id: String, window: [String: Any])? {
        var found: (String, [String: Any])? = nil
        for message in messages {
            for patch in patches(of: message) {
                let id = patch["id"] as? String ?? "\(patch["id"] ?? "")"
                if (patch["type"] as? String) == "setProp",
                   (patch["name"] as? String) == "__virt.window",
                   let value = patch["value"] as? [String: Any] {
                    found = (id, value)
                } else if let props = patch["props"] as? [String: Any],
                          let value = props["__virt.window"] as? [String: Any] {
                    found = (id, value)
                }
            }
        }
        return found
    }

    private func ready(_ server: RemoteServer) throws -> (RemoteSession, RecordingTransport) {
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)
        session.receive("{\"type\":\"hello\"}")
        XCTAssertTrue(session.isReady)
        return (session, transport)
    }

    private func isStateUpdate(_ m: OutgoingMessage) -> Bool {
        if case .stateUpdate = m { return true }
        return false
    }

    // MARK: - Message decoding

    func testParseViewportAcceptsAndClamps() {
        let ok = RemoteSession.parseViewport(["listId": "42", "start": 40, "end": 70])
        XCTAssertEqual(ok?.listId, "42")
        XCTAssertEqual(ok?.start, 40)
        XCTAssertEqual(ok?.end, 70)

        let huge = RemoteSession.parseViewport(["listId": "42", "start": 0, "end": 1e12])
        XCTAssertEqual(huge?.end, UInt32.max)
        XCTAssertEqual(RemoteSession.viewportBound(3.0), 3)
    }

    func testParseViewportRejectsMalformed() {
        let bad: [[String: Any]] = [
            [:],
            ["start": 0, "end": 10],
            ["listId": "", "start": 0, "end": 10],
            ["listId": 42, "start": 0, "end": 10],
            ["listId": "42", "end": 10],
            ["listId": "42", "start": -1, "end": 10],
            ["listId": "42", "start": 1.5, "end": 10],
            ["listId": "42", "start": "0", "end": 10],
            ["listId": "42", "start": 0, "end": true],
            ["listId": "42", "start": 0, "end": NSNull()],
        ]
        for json in bad {
            XCTAssertNil(RemoteSession.parseViewport(json), "should reject \(json)")
        }
    }

    func testParseViewportFromWireJSON() throws {
        // Booleans and numbers as JSONSerialization decodes them.
        func parse(_ text: String) throws -> (listId: String, start: UInt32, end: UInt32)? {
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            return RemoteSession.parseViewport(json)
        }
        XCTAssertNotNil(try parse(#"{"type":"viewport","listId":"7","start":1,"end":2}"#))
        XCTAssertNil(try parse(#"{"type":"viewport","listId":"7","start":true,"end":2}"#))
        XCTAssertNil(try parse(#"{"type":"viewport","listId":"7","start":0,"end":false}"#))
        XCTAssertEqual(try parse(#"{"type":"viewport","listId":"7","start":0,"end":99999999999}"#)?.end, UInt32.max)
    }

    // MARK: - Session behaviour

    func testInitialTreeCarriesWindow() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (_, transport) = try ready(server)
        let virt = try XCTUnwrap(virtWindow(in: transport.all), "List should carry __virt.window")
        XCTAssertEqual(virt.window["total"] as? Int, 500)
        XCTAssertEqual(virt.window["start"] as? Int, 0)
        XCTAssertLessThan(virt.window["end"] as? Int ?? 500, 500, "only a window is materialized")
    }

    func testViewportStreamsPatchWithoutStateUpdate() throws {
        let log = TestEventLog()
        let server = try makeServer(actionLog: log)
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let listId = try XCTUnwrap(virtWindow(in: transport.all)?.id)
        let before = transport.all.count
        let revBefore = session.currentRevision

        session.receive(#"{"type":"viewport","listId":"\#(listId)","start":200,"end":240}"#)

        let after = Array(transport.all.dropFirst(before))
        XCTAssertEqual(after.count, 1, "exactly one patch message, got \(after)")
        guard case let .patch(_, _, rev) = try XCTUnwrap(after.first) else {
            return XCTFail("expected a patch message, got \(after)")
        }
        XCTAssertEqual(rev, revBefore + 1)
        XCTAssertFalse(after.contains(where: isStateUpdate), "a viewport never sends stateUpdate")
        XCTAssertTrue(log.all.isEmpty, "a viewport is never an action")

        let virt = try XCTUnwrap(virtWindow(in: transport.all))
        XCTAssertEqual(virt.id, listId)
        XCTAssertEqual(virt.window["start"] as? Int, 200)
        XCTAssertEqual(virt.window["end"] as? Int, 240)
        XCTAssertFalse(transport.wasClosed)
    }

    func testViewportBeforeHelloIsIgnored() throws {
        let server = try makeServer()
        defer { server.stop() }
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)
        session.receive(#"{"type":"viewport","listId":"1","start":0,"end":10}"#)
        XCTAssertTrue(transport.all.isEmpty)
        XCTAssertFalse(transport.wasClosed)
    }

    func testMalformedAndUnknownViewportsAreIgnored() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let listId = try XCTUnwrap(virtWindow(in: transport.all)?.id)
        let before = transport.all.count
        session.receive(#"{"type":"viewport","listId":"\#(listId)","start":-5,"end":10}"#)
        session.receive(#"{"type":"viewport","listId":"\#(listId)","start":"0","end":10}"#)
        session.receive(#"{"type":"viewport","start":0,"end":10}"#)
        session.receive(#"{"type":"viewport","listId":"999999999","start":0,"end":10}"#)
        session.receive(#"{"type":"viewport","listId":"not-an-id","start":0,"end":10}"#)
        XCTAssertEqual(transport.all.count, before, "nothing sent for malformed / unknown reports")
        XCTAssertFalse(transport.wasClosed, "never a disconnect")
    }

    /// The rows every server SDK agrees on (see hypen-sdk-rs
    /// `viewport_contract_table_rows`): re-reporting the current window
    /// (spelled `-0` / `NeM`) sends nothing and keeps the revision; an empty
    /// `listId` is malformed; `start > end` is forwarded and the engine keeps
    /// the single item at `start`.
    func testViewportContractTableRows() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let virt = try XCTUnwrap(virtWindow(in: transport.all))
        let end = try XCTUnwrap(virt.window["end"] as? Int)
        let before = transport.all.count
        let revBefore = session.currentRevision

        session.receive(#"{"type":"viewport","listId":"\#(virt.id)","start":-0,"end":\#(end)e0}"#)
        session.receive(#"{"type":"viewport","listId":"","start":0,"end":10}"#)
        XCTAssertEqual(transport.all.count, before, "a no-op or empty-id report sends nothing")
        XCTAssertEqual(session.currentRevision, revBefore)

        session.receive(#"{"type":"viewport","listId":"\#(virt.id)","start":50,"end":10}"#)
        let after = Array(transport.all.dropFirst(before))
        XCTAssertEqual(after.count, 1)
        let moved = try XCTUnwrap(virtWindow(in: transport.all))
        XCTAssertEqual(moved.window["start"] as? Int, 50)
        XCTAssertEqual(moved.window["end"] as? Int, 51, "start > end keeps one item at start")
        XCTAssertEqual(session.currentRevision, revBefore + 1)
        XCTAssertFalse(transport.wasClosed)
    }

    func testViewportOnlyAffectsThisSession() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (a, ta) = try ready(server)
        let (_, tb) = try ready(server)
        let listId = try XCTUnwrap(virtWindow(in: ta.all)?.id)
        let bBefore = tb.all.count
        a.receive(#"{"type":"viewport","listId":"\#(listId)","start":300,"end":330}"#)
        XCTAssertEqual(tb.all.count, bBefore, "another session never sees this client's viewport")
        XCTAssertEqual(virtWindow(in: tb.all)?.window["start"] as? Int, 0)
    }

    func testDispatchAfterViewportStillWorks() throws {
        let log = TestEventLog()
        let server = try makeServer(actionLog: log)
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let listId = try XCTUnwrap(virtWindow(in: transport.all)?.id)
        session.receive(#"{"type":"viewport","listId":"\#(listId)","start":100,"end":130}"#)
        let before = transport.all.count
        session.receive(#"{"type":"dispatchAction","action":"bump"}"#)
        XCTAssertEqual(log.all, ["bump"])
        XCTAssertTrue(transport.all.dropFirst(before).contains(where: isStateUpdate))
    }
}
