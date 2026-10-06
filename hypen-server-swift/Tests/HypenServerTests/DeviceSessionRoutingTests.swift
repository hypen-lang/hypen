import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// Shared wire transcripts with a CLIENT-sent `deviceRequest`, replayed
/// through the Swift server's socket entry points (`RemoteSession.receive` /
/// `receiveBinary`) — not straight into the plane — so the session's routing
/// is part of what is checked:
///
/// - `violation-request-from-client`: a client `deviceRequest` reusing a live
///   server id is a known-id wrong-direction message (D8). It must reach the
///   broker, which cancels that request (exactly one `cancel`, the
///   transcript's reaction) and settles it `invalidParams`.
/// - `unknown-ids-ignored-in-any-direction`: every message for a never-
///   requested id — a client `deviceRequest` included — reaches the broker
///   and is ignored (liveness before direction): nothing is sent, nothing is
///   counted, the live request completes normally.
///
/// A session that dropped client `deviceRequest` texts before the broker (the
/// old routing only forwarded `deviceResponse` / `deviceEvent`) fails both:
/// the violation goes unanswered and the text never reaches the broker.
final class DeviceSessionRoutingTests: XCTestCase {
    typealias W = DeviceTestWire
    typealias Transport = DeviceSessionTests.DeviceTestTransport

    private func deviceSession() throws -> (RemoteServer, RemoteSession, Transport, DevicePlane) {
        let server = RemoteServer()
            .module("App", AppBuilder(["n": 0]).build())
            .ui("Column { Text(\"routing\") }")
            .configureDevice(DeviceServerOptions(clock: ManualDeviceClock()))
        try server.prepare()
        let t = Transport()
        let session = try server.createSession(transport: t)
        session.receive(#"{"type":"hello","device":\#(W.fullHello)}"#)
        let plane = try XCTUnwrap(session.device, "device plane negotiated")
        return (server, session, t, plane)
    }

    /// Transcripts whose client sends a `deviceRequest` (found, not listed,
    /// so a new one is picked up automatically).
    private func transcriptsWithClientRequests() throws -> [(String, FixtureJSON)] {
        let dir = try DeviceFixtures.requireDirectory().appendingPathComponent("transcripts")
        var out: [(String, FixtureJSON)] = []
        for file in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() where file.hasSuffix(".json") {
            let doc = try FixtureJSON.parse(Data(contentsOf: dir.appendingPathComponent(file)))
            let steps = doc["steps"]?.array ?? []
            if steps.contains(where: { $0["dir"]?.string == "c2s" && $0["message"]?["type"]?.string == "deviceRequest" }) {
                out.append((file, doc))
            }
        }
        return out
    }

    func testTranscriptsWithAClientDeviceRequestReplayThroughRemoteSession() async throws {
        let docs = try transcriptsWithClientRequests()
        let names = docs.map(\.0)
        XCTAssertTrue(names.contains("violation-request-from-client.json"), "\(names)")
        XCTAssertTrue(names.contains("unknown-ids-ignored-in-any-direction.json"), "\(names)")
        var clientRequests = 0
        for (file, doc) in docs {
            clientRequests += try await replay(file, doc)
        }
        XCTAssertGreaterThanOrEqual(clientRequests, 2, "client deviceRequest steps fed through RemoteSession")
    }

    /// Replay one transcript; returns how many client `deviceRequest` steps
    /// were fed.
    private func replay(_ file: String, _ doc: FixtureJSON) async throws -> Int {
        let (server, session, t, plane) = try deviceSession()
        defer {
            session.destroy()
            server.stop()
        }
        var map: [UInt64: UInt32] = [:]
        func bid(_ id: UInt64) -> UInt32 { map[id] ?? UInt32(truncatingIfNeeded: 0x4000_0000 &+ id) }
        var tasks: [UInt32: Task<DeviceResult<PermissionResult>, Never>] = [:]
        func cancels(_ id: UInt32) -> Int {
            t.deviceMessages.filter {
                ($0["id"] as? NSNumber)?.uint32Value == id
                    && (($0["control"] as? [String: Any])?["cancel"] as? Bool) == true
            }.count
        }
        var pendingReaction: (id: UInt32, cancelsBefore: Int)?
        var clientRequests = 0
        let steps = doc["steps"]?.array ?? []

        for (i, step) in steps.enumerated() {
            let at = "\(file) step \(i)"
            if step["dir"]?.string == "s2c" {
                if step["reaction"]?.bool == true {
                    let r = try XCTUnwrap(pendingReaction, "\(at): reaction without a violation")
                    XCTAssertEqual(step["message"]?["control"]?["cancel"]?.bool, true, at)
                    XCTAssertEqual(step["message"]?["id"]?.uint64.map(bid), r.id, at)
                    XCTAssertEqual(cancels(r.id) - r.cancelsBefore, 1, "\(at): exactly one cancel, sent by the broker")
                    pendingReaction = nil
                    continue
                }
                guard step["ignored"]?.bool != true, let m = step["message"],
                      m["type"]?.string == "deviceRequest", let tid = m["id"]?.uint64 else { continue }
                if m["capability"]?.string == "core.capabilities" {
                    map[tid] = try XCTUnwrap(plane.coreStreamId, at)
                    continue
                }
                // The server opens the transcript's request through the
                // handler API, owned as the transcript says.
                XCTAssertEqual(m["capability"]?.string, "permission.query", "\(at): only permission.query is opened here")
                let owner = try XCTUnwrap(m["owner"])
                let mi = try XCTUnwrap(owner["moduleInstanceId"]?.string, at)
                let act = try XCTUnwrap(owner["activationId"]?.uint64.flatMap { UInt32(exactly: $0) }, at)
                let permission = try XCTUnwrap(m["params"]?["permission"]?.string.flatMap(Permission.init(rawValue:)), at)
                XCTAssertTrue(plane.ownerActivated(mi, activationId: act), at)
                let ctx = DeviceContext(plane: plane, owner: DeviceOwnerAuthority(moduleInstanceId: mi, activationId: act),
                                        provenance: .origin)
                let before = t.requests("permission.query").count
                let task = Task { await ctx.permissions.query(permission) }
                let deadline = Date().addingTimeInterval(5)
                while t.requests("permission.query").count == before, Date() < deadline {
                    try await Task.sleep(nanoseconds: 2_000_000)
                }
                let sent = try XCTUnwrap(t.requests("permission.query").last, "\(at): request not sent")
                XCTAssertEqual(sent["params"] as? [String: String], ["permission": permission.rawValue], at)
                let id = try XCTUnwrap((sent["id"] as? NSNumber)?.uint32Value, at)
                map[tid] = id
                tasks[id] = task
                continue
            }

            // ---- c2s: through the session's socket entry points ----
            if let r = pendingReaction { return fail("\(at): missing reaction for \(r.id)", clientRequests) }
            let violationsBefore = plane.connectionViolations
            let routedBefore = plane.receivedTextCount
            let sentBefore = t.deviceMessages.count
            let id: UInt32
            if let f = step["frame"] {
                id = bid(try XCTUnwrap(f["header"]?["requestId"]?.uint64, at))
                var bytes = [UInt8](try hexDecode(f["hex"]?.string ?? ""))
                bytes[4] = UInt8(truncatingIfNeeded: id)
                bytes[5] = UInt8(truncatingIfNeeded: id >> 8)
                bytes[6] = UInt8(truncatingIfNeeded: id >> 16)
                bytes[7] = UInt8(truncatingIfNeeded: id >> 24)
                session.receiveBinary(Data(bytes))
            } else {
                let m = try XCTUnwrap(step["message"], "\(at): c2s step without a message")
                id = bid(try XCTUnwrap(m["id"]?.uint64, at))
                if m["type"]?.string == "deviceRequest" { clientRequests += 1 }
                let cancelsBefore = cancels(id)
                session.receive(m.text { $0 == ["id"] ? "\(id)" : nil })
                XCTAssertEqual(plane.receivedTextCount, routedBefore + 1, "\(at): a device text must reach the broker")
                if step["expectViolation"] != nil { pendingReaction = (id, cancelsBefore) }
            }
            if step["ignored"]?.bool == true {
                XCTAssertEqual(t.deviceMessages.count, sentBefore, "\(at): an ignored message sends nothing")
                XCTAssertEqual(plane.connectionViolations, violationsBefore, "\(at): an ignored message is no violation")
                continue
            }
            if let category = step["expectViolation"]?.string {
                XCTAssertEqual(category, "direction", at)
                // Request-level: the named live request ends invalidParams.
                XCTAssertFalse(plane.isLive(id), "\(at): the violated request must end")
                let task = try XCTUnwrap(tasks[id], "\(at): violation on an id the server never opened")
                guard case .failure(let e)? = await settle(task) else {
                    return fail("\(at): the violated request did not fail", clientRequests)
                }
                XCTAssertEqual(e.code, .invalidParams, at)
                XCTAssertEqual(plane.connectionViolations, violationsBefore, "\(at): attributable, not connection-level")
                XCTAssertTrue(next(steps, i)?["reaction"]?.bool == true, "\(at): the transcript pins the reaction")
                continue
            }
            // A legitimate client message (here: the terminal of the live request).
            XCTAssertEqual(plane.connectionViolations, violationsBefore, at)
            if let task = tasks[id], step["message"]?["type"]?.string == "deviceResponse" {
                let value = try await settle(task).unwrapped().get()
                XCTAssertEqual(value.status.rawValue, step["message"]?["result"]?["status"]?.string, at)
            }
        }
        XCTAssertNil(pendingReaction, "\(file): reaction step missing")
        // Only the socket was used: the control stream survives, no close.
        XCTAssertTrue(t.closeCodes.isEmpty, "\(file): unexpected close \(t.closeCodes)")
        XCTAssertTrue(plane.isLive(try XCTUnwrap(plane.coreStreamId)), "\(file): the control stream must survive")
        return clientRequests
    }

    private func next(_ steps: [FixtureJSON], _ i: Int) -> FixtureJSON? { i + 1 < steps.count ? steps[i + 1] : nil }

    private func fail(_ message: String, _ n: Int) -> Int {
        XCTFail(message)
        return n
    }

    /// Unit-level pins of the routing rule itself.
    func testEveryDeviceMessageTypeIsRoutedAndJudgedByTheBroker() async throws {
        let (server, session, t, plane) = try deviceSession()
        defer {
            session.destroy()
            server.stop()
        }
        XCTAssertEqual(RemoteSession.deviceMessageTypes, ["deviceRequest", "deviceResponse", "deviceEvent"])
        let core = try XCTUnwrap(plane.coreStreamId)

        // A client deviceRequest on an unknown id: routed, ignored.
        var routed = plane.receivedTextCount
        session.receive(#"{"type":"deviceRequest","id":777,"capability":"permission.query","version":1,"#
            + #""owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":1000,"#
            + #""initialCredit":0,"params":{"permission":"camera"}}"#)
        XCTAssertEqual(plane.receivedTextCount, routed + 1)
        XCTAssertEqual(plane.connectionViolations, 0)

        // A client deviceRequest with a JSON-limit breach (duplicated key):
        // routed and counted at the connection level, never dropped silently.
        routed = plane.receivedTextCount
        session.receive(#"{"type":"deviceRequest","type":"deviceRequest","id":778}"#)
        XCTAssertEqual(plane.receivedTextCount, routed + 1)
        XCTAssertEqual(plane.connectionViolations, 1)

        // A client deviceRequest reusing the live control stream's id: a
        // wrong-direction message on core.capabilities ends the device plane
        // (the mandatory stream cannot survive), and the socket is reset.
        let before = t.deviceMessages.count
        session.receive(#"{"type":"deviceRequest","id":\#(core),"capability":"core.capabilities","version":1,"#
            + #""owner":{"connection":true},"lifetime":"connection","timeoutMs":86400000,"initialCredit":8,"params":{}}"#)
        XCTAssertFalse(plane.isLive(core))
        XCTAssertTrue(plane.isClosed)
        XCTAssertEqual(t.closeCodes, [1012])
        XCTAssertNil(session.device)
        XCTAssertGreaterThanOrEqual(t.deviceMessages.count, before)
    }
}
