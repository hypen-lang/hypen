import Foundation
import XCTest
import HypenEngine

/// Device broker (RFC 001) binding tests for the Swift server: the GENERATED
/// UniFFI bindings (`Sources/HypenEngine/hypen_engine.swift` +
/// `hypen_engineFFI.h`: `DeviceBroker`, `DeviceRetainedBytesPool`,
/// `DeviceOutput`/`DeviceOutcome`/`DeviceOpenResult` and the `device*`
/// helpers) driven against the native engine library
/// (`cargo build --release --features uniffi`), exactly as the server's
/// native layer drives them.
///
/// Run with the library on the path, e.g.
///   LIBRARY_PATH=../target/release LD_LIBRARY_PATH=../target/release swift test
final class DeviceBrokerBindingTests: XCTestCase {

    private let hello = #"{"protocolVersions":[1],"binary":true,"capabilities":["#
        + #"{"name":"core.capabilities","versions":[1]},{"name":"gallery.pick","versions":[1]},"#
        + #"{"name":"file.save","versions":[1]},{"name":"bluetooth.scan","versions":[1]},"#
        + #"{"name":"permission.query","versions":[1]}]}"#

    // MARK: - Helpers

    private func obj(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
        guard let data = text.data(using: .utf8),
              let v = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
        else {
            XCTFail("not a JSON object: \(text)", file: file, line: line)
            return [:]
        }
        return v
    }

    private func frame(_ id: UInt32, _ channel: UInt16, _ seq: UInt32, _ payload: Data) -> Data {
        var d = Data([1, 0])
        withUnsafeBytes(of: channel.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: id.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: seq.littleEndian) { d.append(contentsOf: $0) }
        d.append(payload)
        return d
    }

    private func le32(_ d: Data, at offset: Int) -> UInt32 {
        d.subdata(in: (d.startIndex + offset)..<(d.startIndex + offset + 4))
            .withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
    }

    /// Collects every output a broker produced, as the server's pump would.
    private final class Pump {
        let broker: DeviceBroker
        var sent: [[String: Any]] = []
        var frames: [Data] = []
        var settled: [UInt32: DeviceOutcome] = [:]
        var events: [(UInt32, String)] = []

        init(_ broker: DeviceBroker) { self.broker = broker }

        func drain() {
            for _ in 0..<64 {
                let out = broker.poll()
                if out.isEmpty { return }
                for o in out {
                    switch o {
                    case .sendText(let text):
                        let v = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
                        sent.append(v ?? [:])
                    case .sendFrame(let f): frames.append(f)
                    case .settled(let id, let outcome): settled[id] = outcome
                    case .event(let id, let json): events.append((id, json))
                    case .data, .closeConnection: break
                    }
                }
            }
            XCTFail("broker never drained")
        }

        func sentFor(_ id: UInt32, _ type: String) -> [[String: Any]] {
            sent.filter { ($0["type"] as? String) == type && ($0["id"] as? NSNumber)?.uint32Value == id }
        }
    }

    private func opened(_ r: DeviceOpenResult, file: StaticString = #filePath, line: UInt = #line) -> UInt32 {
        switch r {
        case .opened(let id): return id
        case .refused(let code, let detail):
            XCTFail("open refused: \(code) \(detail ?? "")", file: file, line: line)
            return 0
        }
    }

    private func started(_ extra: String = "", pool: DeviceRetainedBytesPool? = nil) throws -> Pump {
        let ack = try XCTUnwrap(deviceNegotiate(helloJson: hello, binaryRoute: true))
        let broker = try DeviceBroker(configJson: "{\"ack\":\(ack)\(extra)}", pool: pool, nowMs: 0)
        let core = opened(broker.start(nowMs: 0))
        XCTAssertEqual(broker.coreStreamId(), core)
        XCTAssertTrue(broker.ownerActivated(moduleInstanceId: "m1", activationId: 1, nowMs: 0))
        let pump = Pump(broker)
        pump.drain()
        XCTAssertEqual(pump.sentFor(core, "deviceRequest").count, 1)
        return pump
    }

    // MARK: - Tests

    func testHandshakeHelpers() throws {
        let ack = obj(try XCTUnwrap(deviceNegotiate(helloJson: hello, binaryRoute: true)))
        XCTAssertEqual(ack["protocolVersion"] as? Int, 1)
        XCTAssertEqual((ack["capabilities"] as? [Any])?.count, 5)
        // D7: a duplicate capability disables device access.
        let dup = hello.replacingOccurrences(of: "]}]}", with: #"]},{"name":"file.save","versions":[1]}]}"#)
        XCTAssertNil(deviceNegotiate(helloJson: dup, binaryRoute: true))
        XCTAssertNil(deviceNegotiate(helloJson: "{", binaryRoute: true))
        XCTAssertNoThrow(try deviceValidateHello(helloJson: hello))
        XCTAssertThrowsError(try deviceValidateHello(helloJson: dup))
        let sel = try XCTUnwrap(deviceSelectAck(
            helloJson: hello, serverProtocolVersions: [1],
            serverCapabilitiesJson: #"[{"name":"core.capabilities","versions":[1]}]"#, serverBinary: false))
        XCTAssertEqual(obj(sel)["binary"] as? Bool, false)
        XCTAssertNoThrow(try deviceValidateAck(ackJson: sel))
        XCTAssertThrowsError(try deviceSelectAck(
            helloJson: hello, serverProtocolVersions: [1], serverCapabilitiesJson: "nope", serverBinary: true))
        XCTAssertTrue(deviceServerAdvertisementJson().hasPrefix(#"[{"name":"core.capabilities""#))
        XCTAssertEqual(obj(deviceConstantsJson())["devicePlaneCloseCode"] as? Int, 1012)
        XCTAssertFalse(deviceIsOversizeText(text: #"{"type":"deviceEvent"}"#))
        XCTAssertEqual(
            deviceSha256Hex(bytes: Data("abc".utf8)),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /// `deviceHandshake`: the same selection as `deviceNegotiate`, plus the
    /// reason when the device plane is disabled (the server's log line).
    func testDeviceHandshakeSelectsOrExplains() throws {
        let ok = try deviceHandshake(helloJson: hello, binaryRoute: true, serverCapabilitiesJson: nil)
        XCTAssertNil(ok.reason)
        XCTAssertEqual(ok.ackJson, deviceNegotiate(helloJson: hello, binaryRoute: true))
        let dup = hello.replacingOccurrences(of: "]}]}", with: #"]},{"name":"file.save","versions":[1]}]}"#)
        for bad in [dup, "{", #"{"protocolVersions":[0],"binary":true,"capabilities":[]}"#] {
            let hs = try deviceHandshake(helloJson: bad, binaryRoute: true, serverCapabilitiesJson: nil)
            XCTAssertNil(hs.ackJson, bad)
            XCTAssertEqual(deviceNegotiate(helloJson: bad, binaryRoute: true), nil, bad)
            XCTAssertTrue(hs.reason?.hasPrefix("invalid hello.device: ") ?? false, "\(bad): \(String(describing: hs.reason))")
        }
        // A server list without core.capabilities@1 selects nothing, and says so.
        let narrow = try deviceHandshake(
            helloJson: hello, binaryRoute: true, serverCapabilitiesJson: #"[{"name":"file.save","versions":[1]}]"#)
        XCTAssertNil(narrow.ackJson)
        XCTAssertTrue(narrow.reason?.contains("core.capabilities@1") ?? false, String(describing: narrow.reason))
        XCTAssertThrowsError(try deviceHandshake(helloJson: hello, binaryRoute: true, serverCapabilitiesJson: "x"))
    }

    func testUploadAndDownload() throws {
        let pump = try started()
        let b = pump.broker

        let up = opened(try b.open(
            specJson: #"{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}"#,
            download: nil, nowMs: 1))
        pump.drain()
        XCTAssertEqual(pump.sentFor(up, "deviceRequest").first?["capability"] as? String, "gallery.pick")
        let photo = Data((0..<70_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        let sha = deviceSha256Hex(bytes: photo)
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(up),\"event\":{\"kind\":\"blobStart\",\"channel\":0,\"contentType\":\"image/jpeg\",\"bytes\":\(photo.count)}}", nowMs: 2))
        XCTAssertTrue(b.onFrame(frame: frame(up, 0, 0, photo.subdata(in: 0..<65_536)), nowMs: 3))
        XCTAssertTrue(b.onFrame(frame: frame(up, 0, 1, photo.subdata(in: 65_536..<photo.count)), nowMs: 3))
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceResponse\",\"id\":\(up),\"result\":{\"items\":[{\"channel\":0,\"contentType\":\"image/jpeg\",\"bytes\":\(photo.count),\"sha256\":\"\(sha)\"}]}}", nowMs: 4))
        pump.drain()
        guard case .success(let resultJson, let blobs, _, _) = try XCTUnwrap(pump.settled[up]) else {
            return XCTFail("upload did not succeed: \(String(describing: pump.settled[up]))")
        }
        XCTAssertEqual(blobs.count, 1)
        XCTAssertEqual(blobs.first?.contentType, "image/jpeg")
        XCTAssertEqual(blobs.first?.bytes, photo)
        XCTAssertTrue(resultJson.contains(sha))
        XCTAssertFalse(b.isLive(id: up))
        XCTAssertEqual(b.retainedBytes(), 0)

        let data = Data("swift download through the rust broker".utf8)
        let params = deviceFileSaveParamsJson(name: "s.txt", contentType: "text/plain", bytes: data)
        let dl = opened(try b.open(
            specJson: "{\"capability\":\"file.save\",\"params\":\(params),\"moduleInstanceId\":\"m1\",\"activationId\":1}",
            download: data, nowMs: 5))
        pump.drain()
        XCTAssertTrue(pump.frames.isEmpty, "no download frame before a grant")
        XCTAssertEqual(pump.sentFor(dl, "deviceRequest").first?["initialCredit"] as? Int, 0)
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(dl),\"control\":{\"grant\":65536}}", nowMs: 6))
        pump.drain()
        var sent = Data()
        for f in pump.frames {
            XCTAssertEqual(le32(f, at: 4), dl)
            sent.append(f.subdata(in: (f.startIndex + 12)..<f.endIndex))
        }
        XCTAssertEqual(sent, data)
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceResponse\",\"id\":\(dl),\"result\":{\"bytesWritten\":\(data.count)}}", nowMs: 7))
        pump.drain()
        guard case .success = try XCTUnwrap(pump.settled[dl]) else {
            return XCTFail("download did not succeed")
        }

        XCTAssertEqual(obj(b.infoJson())["liveCount"] as? Int, 1)
        XCTAssertNotNil(b.tick(nowMs: 8))
        XCTAssertThrowsError(try b.close(code: "nope"))
        try b.close(code: "connectionLost")
        XCTAssertTrue(b.isClosed())
    }

    func testRefusalsPoolsAndSweeps() throws {
        let pool = DeviceRetainedBytesPool(limit: 1 << 20)
        let pump = try started(#","maxRetainedBytes":8192"#, pool: pool)
        let b = pump.broker

        // Replay firewall: replayed dispatch is refused as a value.
        let replayed = try b.open(
            specJson: #"{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1,"replayed":true}"#,
            download: nil, nowMs: 1)
        guard case .refused(let code, _) = replayed else { return XCTFail("replayed open must be refused") }
        XCTAssertEqual(code, "unavailable")
        // Activation authority: a stale activation is refused.
        let stale = try b.open(
            specJson: #"{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":9}"#,
            download: nil, nowMs: 1)
        guard case .refused = stale else { return XCTFail("a stale activation must be refused") }
        // Host errors throw.
        XCTAssertThrowsError(try b.open(specJson: "{", download: nil, nowMs: 1)) { error in
            XCTAssertTrue(error is DeviceBindingError)
        }
        XCTAssertThrowsError(try DeviceBroker(configJson: "{}", pool: nil, nowMs: 0))

        let id = opened(try b.open(
            specJson: #"{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}"#,
            download: nil, nowMs: 1))
        _ = b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(id),\"event\":{\"kind\":\"blobStart\",\"channel\":0,\"contentType\":\"image/jpeg\",\"bytes\":4096}}", nowMs: 2)
        XCTAssertGreaterThanOrEqual(pool.inUse(), 4096)
        b.ownerDestroyed(moduleInstanceId: "m1", nowMs: 3)
        pump.drain()
        guard case .failure(let failCode, _) = try XCTUnwrap(pump.settled[id]) else {
            return XCTFail("a destroyed owner's upload must fail")
        }
        XCTAssertEqual(failCode, "cancelled")
        XCTAssertEqual(pool.inUse(), 0)
        XCTAssertEqual(pool.limit(), 1 << 20)
    }

    /// A started pooled broker holding one 50000-byte upload declaration.
    private func reserving(_ pool: DeviceRetainedBytesPool) throws -> DeviceBroker {
        let b = try started(pool: pool).broker
        let id = opened(try b.open(
            specJson: #"{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}"#,
            download: nil, nowMs: 1))
        _ = b.poll()
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(id),\"event\":{\"kind\":\"blobStart\",\"channel\":0,\"contentType\":\"image/jpeg\",\"bytes\":50000}}", nowMs: 2))
        XCTAssertTrue(b.onFrame(frame: frame(id, 0, 0, Data(repeating: 7, count: 2000)), nowMs: 3))
        XCTAssertEqual(b.retainedBytes(), 50000)
        return b
    }

    func testReleasingWithoutCloseReturnsPooledBytes() throws {
        let pool = DeviceRetainedBytesPool(limit: 1 << 30)
        var kept: DeviceBroker? = try reserving(pool)
        var freed: DeviceBroker? = try reserving(pool)
        XCTAssertEqual(pool.inUse(), 100_000)
        // A connection torn down on an error path that never called close():
        // releasing the last reference hands its reservation back.
        freed = nil
        XCTAssertNil(freed)
        XCTAssertEqual(pool.inUse(), 50000)
        // Releasing after an explicit close releases nothing twice.
        try kept?.close(code: "connectionLost")
        XCTAssertEqual(pool.inUse(), 0)
        var other: DeviceBroker? = try reserving(pool)
        kept = nil
        XCTAssertNil(kept)
        XCTAssertEqual(pool.inUse(), 50000)
        other = nil
        XCTAssertNil(other)
        XCTAssertEqual(pool.inUse(), 0)
    }

    func testLeasesAndBackgroundOwners() throws {
        let pump = try started(#","revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}]"#)
        let b = pump.broker
        XCTAssertTrue(b.admitsBackground(moduleInstanceId: "m1"))
        let scan = opened(try b.open(
            specJson: #"{"capability":"bluetooth.scan","moduleInstanceId":"m1","activationId":1,"lifetime":"background","initialCredit":4}"#,
            download: nil, nowMs: 0))
        pump.drain()
        func renewals() -> Int {
            pump.sentFor(scan, "deviceEvent").filter { ($0["control"] as? [String: Any])?["renewLease"] != nil }.count
        }
        XCTAssertEqual(renewals(), 1)
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(scan),\"event\":{\"device\":{\"id\":\"d1\",\"rssi\":-60}}}", nowMs: 100))
        pump.drain()
        XCTAssertEqual(pump.events.count, 1)
        XCTAssertEqual(pump.events.first?.0, scan)
        XCTAssertEqual((obj(pump.events.first?.1 ?? "{}")["device"] as? [String: Any])?["id"] as? String, "d1")
        XCTAssertEqual(b.outstandingEventCredit(id: scan), 3)
        b.consumedEvents(id: scan, n: 1, nowMs: 101)

        // Renewals follow the 5 s cadence as the host ticks.
        _ = b.tick(nowMs: 5_000)
        pump.drain()
        XCTAssertEqual(renewals(), 2)
        XCTAssertTrue(b.onText(text: "{\"type\":\"deviceEvent\",\"id\":\(scan),\"control\":{\"leaseAck\":2}}", nowMs: 5_001))

        // Deactivation keeps background work; destruction sweeps it.
        b.ownerDeactivated(moduleInstanceId: "m1", activationId: 1, nowMs: 5_002)
        XCTAssertTrue(b.isLive(id: scan))
        XCTAssertTrue(b.hasBackgroundWork(moduleInstanceId: "m1"))
        XCTAssertFalse(b.ownerIsActive(moduleInstanceId: "m1", activationId: 1))
        b.ownerDestroyed(moduleInstanceId: "m1", nowMs: 5_003)
        pump.drain()
        guard case .failure(let code, _) = try XCTUnwrap(pump.settled[scan]) else {
            return XCTFail("destruction must sweep background work")
        }
        XCTAssertEqual(code, "cancelled")
        XCTAssertFalse(b.hasBackgroundWork(moduleInstanceId: "m1"))
    }

    func testRevisionAndServerConsumes() throws {
        let b = try started(#","maxItemBytes":2048"#).broker
        let rev = try XCTUnwrap(b.revisionJson(capability: "gallery.pick", version: 1))
        let r = obj(rev)
        XCTAssertEqual(r["mode"] as? String, "unary")
        XCTAssertEqual(r["data"] as? String, "binaryUpload")
        XCTAssertEqual(r["maxItemBytes"] as? Int, 2048)
        XCTAssertNotNil(r["lifetimes"] as? [Any])
        XCTAssertNil(b.revisionJson(capability: "gallery.pick", version: 42))
        XCTAssertNil(b.revisionJson(capability: "no.such", version: 1))
        // A revision answer feeds straight back into deviceServerConsumes.
        XCTAssertTrue(try deviceServerConsumes(revisionJson: rev))
        XCTAssertFalse(try deviceServerConsumes(revisionJson: #"{"mode":"stream","data":"binaryDownload"}"#))
        XCTAssertTrue(try deviceServerConsumes(revisionJson: #"{"mode":"stream","data":"jsonEvents"}"#))
        XCTAssertThrowsError(try deviceServerConsumes(revisionJson: #"{"mode":"stream"}"#))
        XCTAssertTrue(b.supports(capability: "gallery.pick"))
        XCTAssertEqual(b.selectedVersion(capability: "gallery.pick"), 1)
        XCTAssertNil(b.selectedVersion(capability: "mic.record"))
        let core = try XCTUnwrap(b.coreStreamId())
        let reopened = try XCTUnwrap(b.reopenCoreCapabilities(nowMs: 10))
        XCTAssertGreaterThan(reopened, core)
    }
}
