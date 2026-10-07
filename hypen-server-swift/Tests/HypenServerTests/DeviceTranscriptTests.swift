import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// Every shared wire transcript (`engine-compatibility-tests/fixtures/device/
/// transcripts`) replayed through the Swift server's RUNTIME path: the Rust
/// `DeviceBroker` driven by `DevicePlane` (UniFFI), in the server role — the
/// same replay the TypeScript server runs through its port
/// (`hypen-web/tests/device-srv-conformance.test.ts`) and the Rust crate runs
/// natively (`tests/test_device_broker_transcripts.rs`).
///
/// The test plays the client: every `c2s` step is fed to the plane
/// (`receiveText` / `receiveFrame`, exact fixture text), and the broker's
/// outputs are checked against the `s2c` steps:
///
/// - an `s2c` `deviceRequest` is produced by `DevicePlane.open` (or `start` /
///   a planned reopen for `core.capabilities`) and must equal the broker's
///   message (transcript ids are mapped to the broker's own monotone ids);
/// - `s2c` `cancel`s come from `cancel` / the planned reopen, exactly once;
/// - `s2c` `renewLease n` is reached by advancing the manual clock on the
///   5 s cadence; requests whose transcript never acknowledges renewals are
///   acknowledged by the harness so clock advances never expire them;
/// - a `c2s` violation must be detected in its category: request-level ones
///   settle the request with an error and send exactly one `cancel` (none
///   when the offending message is the client's own terminal), which must be
///   the transcript's `reaction`; connection-level ones (JSON limits, bad
///   frame headers) are counted and touch no request; a terminal on the live
///   `core.capabilities` stream closes the device plane (1012);
/// - an `ignored` step has no effect at all;
/// - successful uploads are re-verified here (item count, sizes, SHA-256 of
///   the bytes the broker delivered), downloads against the frames the broker
///   actually wrote. Transcripts with a binary-upload STREAM are replayed a
///   second time with a consumer taking the bytes (`deliverData`).
final class DeviceTranscriptBrokerTests: XCTestCase {

    // MARK: - Fixture access

    private struct Revision {
        let mode: String
        let data: String
    }

    /// `schema/device/registry-v1.json` as `capability@version → (mode, data)`.
    private static func registry() throws -> (revisions: [String: Revision], fullAck: String) {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/schema/device/registry-v1.json")
        var revisions: [String: Revision] = [:]
        var ackCaps: [String] = []
        for cap in doc["capabilities"]?.array ?? [] {
            guard let name = cap["name"]?.string else { continue }
            for rev in cap["revisions"]?.array ?? [] {
                guard let v = rev["version"]?.uint64, let mode = rev["mode"]?.string, let data = rev["data"]?.string else {
                    continue
                }
                revisions["\(name)@\(v)"] = Revision(mode: mode, data: data)
                if v == 1 { ackCaps.append(#"{"name":"\#(name)","version":1}"#) }
            }
        }
        return (revisions, #"{"protocolVersion":1,"binary":true,"capabilities":[\#(ackCaps.joined(separator: ","))]}"#)
    }

    private static func frameBytes(_ frame: FixtureJSON) throws -> Data {
        var bytes = try hexDecode(frame["hex"]?.string ?? "")
        if let fill = frame["payloadFill"], let byte = fill["byte"]?.uint64, let length = fill["length"]?.int {
            bytes.append(Data(repeating: UInt8(byte), count: length))
        }
        return bytes
    }

    private static func withRequestId(_ frame: Data, _ id: UInt32) -> Data {
        var out = [UInt8](frame)
        if out.count >= 8 {
            out[4] = UInt8(truncatingIfNeeded: id)
            out[5] = UInt8(truncatingIfNeeded: id >> 8)
            out[6] = UInt8(truncatingIfNeeded: id >> 16)
            out[7] = UInt8(truncatingIfNeeded: id >> 24)
        }
        return Data(out)
    }

    /// The payload of every unflagged `s2c` frame for transcript id `id` after step `from`.
    private static func downloadFrames(_ steps: [FixtureJSON], from: Int, id: UInt64) throws -> Data {
        var out = Data()
        for later in steps.dropFirst(from + 1) {
            guard later["dir"]?.string == "s2c", let frame = later["frame"],
                  frame["header"]?["requestId"]?.uint64 == id,
                  later["expectViolation"] == nil, later["ignored"]?.bool != true else { continue }
            out.append(try frameBytes(frame).dropFirst(12))
        }
        return out
    }

    /// Download payloads by SHA-256, from every transcript whose server sends
    /// the complete, matching bytes of a `file.save` announcement.
    private static func downloadTable(_ docs: [(String, FixtureJSON)]) throws -> [String: Data] {
        var table: [String: Data] = [:]
        for (_, doc) in docs {
            let steps = doc["steps"]?.array ?? []
            for (i, step) in steps.enumerated() {
                guard step["dir"]?.string == "s2c", let m = step["message"], m["type"]?.string == "deviceRequest",
                      m["capability"]?.string == "file.save", let id = m["id"]?.uint64,
                      let bytes = m["params"]?["bytes"]?.uint64, let sha = m["params"]?["sha256"]?.string else { continue }
                let payload = try downloadFrames(steps, from: i, id: id)
                if UInt64(payload.count) == bytes, DeviceDigest.sha256Hex(payload) == sha { table[sha] = payload }
            }
        }
        return table
    }

    // MARK: - Harness

    private final class Recorder: @unchecked Sendable {
        var sent: [FixtureJSON] = []
        var closes: [(code: UInt16, reason: String)] = []
        var onSend: ((FixtureJSON) -> Void)?
        var onFrame: ((Data) -> Void)?
    }

    /// A consumer that never catches up on JSON events (no replenishing
    /// grants beyond the transcript's own) and takes streamed bytes at once.
    private final class Consumer: DevicePlaneConsumer, @unchecked Sendable {
        weak var plane: DevicePlane?
        var id: UInt32 = 0
        var delivered: [Data]?
        init(collectData: Bool) { delivered = collectData ? [] : nil }
        func deliverEvent(_ json: String) {}
        func deliverData(channel: UInt16, bytes: Data) {
            delivered?.append(bytes)
            plane?.consumedData(id, 1)
        }
        func finish(dropBuffered: Bool) {}
    }

    private final class Live {
        let req: FixtureJSON
        let revision: DeviceCapabilityRevision?
        let box: DeviceSettlementBox?
        let consumer: Consumer?
        var written: [Data] = []
        init(req: FixtureJSON, revision: DeviceCapabilityRevision?, box: DeviceSettlementBox?, consumer: Consumer?) {
            self.req = req
            self.revision = revision
            self.box = box
            self.consumer = consumer
        }
    }

    /// Server-side outcome after local verification — what a handler would see.
    private static func serverOutcomeOK(_ live: Live) -> Bool {
        guard case .success(let resultJSON, let blobs, _, _)? = live.box?.current else { return false }
        guard let rev = live.revision else { return true }
        if rev.data == .binaryDownload {
            let joined = Data(live.written.joined())
            return UInt64(joined.count) == live.req["params"]?["bytes"]?.uint64
                && DeviceDigest.sha256Hex(joined) == live.req["params"]?["sha256"]?.string
        }
        guard rev.data == .binaryUpload else { return true }
        let result = (try? JSONSerialization.jsonObject(with: Data(resultJSON.utf8))) as? [String: Any] ?? [:]
        let declared: [[String: Any]] = (result["items"] as? [[String: Any]])
            ?? ((result["item"] as? [String: Any]).map { [$0] } ?? [])
        func matches(_ item: [String: Any], _ bytes: Data) -> Bool {
            (item["bytes"] as? NSNumber)?.intValue == bytes.count && (item["sha256"] as? String) == DeviceDigest.sha256Hex(bytes)
        }
        if rev.mode == .stream {
            // Streamed: nothing buffered; exactly one declared item.
            guard blobs.isEmpty, declared.count == 1 else { return false }
            guard let delivered = live.consumer?.delivered else { return true }
            return matches(declared[0], Data(delivered.joined()))
        }
        guard declared.count == blobs.count else { return false }
        for item in declared {
            guard let channel = (item["channel"] as? NSNumber)?.uint16Value,
                  let blob = blobs.first(where: { $0.channel == channel }), matches(item, blob.bytes) else { return false }
        }
        return true
    }

    private struct Counts {
        var transcripts = 0
        var c2sSteps = 0
        var violations = 0
        var requestLevel = 0
        var connectionLevel = 0
        var ignored = 0
        var verifiedSuccesses = 0
        var streamedReplays = 0
    }

    // MARK: - The replay

    func testEveryTranscriptReplaysThroughTheRustBroker() throws {
        let dir = try DeviceFixtures.requireDirectory().appendingPathComponent("transcripts")
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted()
        var docs: [(String, FixtureJSON)] = []
        for file in files {
            let doc = try FixtureJSON.parse(Data(contentsOf: dir.appendingPathComponent(file)))
            if doc["steps"] != nil { docs.append((file, doc)) }
        }
        XCTAssertGreaterThanOrEqual(docs.count, 118, "wire transcripts missing")
        let (registry, fullAck) = try Self.registry()
        let table = try Self.downloadTable(docs)

        let withC2sViolations = docs.filter { _, doc in
            (doc["steps"]?.array ?? []).contains { $0["dir"]?.string == "c2s" && $0["expectViolation"] != nil }
        }
        XCTAssertGreaterThan(withC2sViolations.count, 40, "the corpus has client → server violations to replay")

        let streamedFiles = docs.filter { _, doc in
            (doc["steps"]?.array ?? []).contains { step in
                guard step["dir"]?.string == "s2c", let m = step["message"], m["type"]?.string == "deviceRequest",
                      let cap = m["capability"]?.string, let v = m["version"]?.uint64,
                      let rev = registry["\(cap)@\(v)"] else { return false }
                return rev.mode == "stream" && rev.data == "binaryUpload"
            }
        }
        XCTAssertGreaterThanOrEqual(streamedFiles.count, 3, "binary-upload stream transcripts to replay through a consumer")

        var counts = Counts()
        for (file, doc) in docs {
            replay(file, doc, streamed: false, fullAck: fullAck, table: table, counts: &counts)
        }
        for (file, doc) in streamedFiles {
            replay(file, doc, streamed: true, fullAck: fullAck, table: table, counts: &counts)
            counts.streamedReplays += 1
        }
        print("device transcripts through the Rust broker: \(counts.transcripts) replays (\(counts.streamedReplays) streamed), "
            + "c2s steps \(counts.c2sSteps), violations \(counts.violations) (request \(counts.requestLevel), "
            + "connection \(counts.connectionLevel)), ignored \(counts.ignored), verified successes \(counts.verifiedSuccesses)")
        XCTAssertGreaterThanOrEqual(counts.c2sSteps, 3_000, "suspiciously few client steps fed")
        XCTAssertGreaterThanOrEqual(counts.violations, 55, "negative transcripts missing")
        XCTAssertGreaterThanOrEqual(counts.requestLevel, 50, "request-level reactions missing")
        XCTAssertGreaterThanOrEqual(counts.connectionLevel, 4, "connection-level violations missing")
        XCTAssertGreaterThanOrEqual(counts.ignored, 25, "stale-id coverage missing")
        XCTAssertGreaterThanOrEqual(counts.verifiedSuccesses, 35, "verified successful outcomes missing")
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    private func replay(_ file: String, _ doc: FixtureJSON, streamed: Bool, fullAck: String,
                        table: [String: Data], counts: inout Counts) {
        let label = streamed ? "\(file) (streamed)" : file
        let steps = doc["steps"]?.array ?? []
        let ackText = doc["ack"].map { String(decoding: $0.raw, as: UTF8.self) } ?? fullAck
        guard let ack = try? FixtureJSON.parse(Data(ackText.utf8)) else { return XCTFail("\(label): unreadable ack") }
        let binary = ack["binary"]?.bool ?? true
        let serverCapabilities: String = doc["serverCapabilities"].map { String(decoding: $0.raw, as: UTF8.self) }
            ?? "[" + (ack["capabilities"]?.array ?? []).map {
                #"{"name":\#($0["name"]!.text()),"versions":[\#($0["version"]!.text())]}"#
            }.joined(separator: ",") + "]"
        var config = #"{"ack":\#(ackText),"serverCapabilities":\#(serverCapabilities)"#
        if let core = steps.first(where: {
            $0["dir"]?.string == "s2c" && $0["message"]?["type"]?.string == "deviceRequest"
                && $0["message"]?["capability"]?.string == "core.capabilities"
        })?["message"] {
            config += #","controlStreamInitialCredit":\#(core["initialCredit"]!.text())"#
            config += #","controlStreamTimeoutMs":\#(core["timeoutMs"]!.text())"#
        }
        config += "}"

        /// Transcript ids whose client acknowledges renewals itself.
        var selfAcking = Set<UInt64>()
        for step in steps where step["dir"]?.string == "c2s" {
            if let m = step["message"], m["control"]?["leaseAck"] != nil, let id = m["id"]?.uint64 { selfAcking.insert(id) }
        }
        var map: [UInt64: UInt32] = [:]
        var back: [UInt32: UInt64] = [:]
        func bid(_ t: UInt64) -> UInt32 { map[t] ?? UInt32(truncatingIfNeeded: 0x4000_0000 &+ t) }
        func link(_ t: UInt64, _ b: UInt32) {
            map[t] = b
            back[b] = t
        }
        var live: [UInt32: Live] = [:]
        var refused = Set<UInt64>()

        let clock = ManualDeviceClock()
        let rec = Recorder()
        final class PlaneRef: @unchecked Sendable { weak var plane: DevicePlane? }
        let ref = PlaneRef()
        let sink = DevicePlaneSink(
            sendText: { text in
                guard let m = try? FixtureJSON.parse(Data(text.utf8)) else {
                    return XCTFail("\(label): broker sent unreadable text \(text)")
                }
                rec.sent.append(m)
                rec.onSend?(m)
            },
            sendFrame: { frame in rec.onFrame?(frame) },
            bufferedAmount: { 0 },
            closeConnection: { code, reason in rec.closes.append((code, reason)) })
        let plane: DevicePlane
        do {
            plane = try DevicePlane(configJSON: config, pool: nil, sink: sink, clock: clock, binary: binary)
        } catch {
            return XCTFail("\(label): broker config refused: \(error)")
        }
        ref.plane = plane
        rec.onSend = { m in
            // A live client for requests the transcript does not acknowledge
            // itself, so clock advances never expire them.
            guard let seq = m["control"]?["renewLease"]?.uint64, let raw = m["id"]?.uint64,
                  let id = UInt32(exactly: raw), let plane = ref.plane else { return }
            let t = back[id]
            if (t == nil || !selfAcking.contains(t!)) && plane.isLive(id) {
                plane.receiveText(#"{"type":"deviceEvent","id":\#(id),"control":{"leaseAck":\#(seq)}}"#)
            }
        }
        rec.onFrame = { frame in
            guard frame.count >= 12 else { return }
            live[DevicePlane.frameRequestId(frame)]?.written.append(frame.dropFirst(12))
        }

        func brokerLease(_ id: UInt32) -> UInt64 {
            rec.sent.filter { $0["id"]?.uint64 == UInt64(id) }.compactMap { $0["control"]?["renewLease"]?.uint64 }.max() ?? 0
        }
        func cancelsSent(_ id: UInt32) -> Int {
            rec.sent.filter { $0["id"]?.uint64 == UInt64(id) && $0["control"]?["cancel"]?.bool == true }.count
        }
        func lastRequest(_ id: UInt32? = nil) -> FixtureJSON? {
            rec.sent.last { $0["type"]?.string == "deviceRequest" && (id == nil || $0["id"]?.uint64 == UInt64(id!)) }
        }

        var transcriptLease: [UInt64: UInt64] = [:]
        var pendingReaction: (t: UInt64, cancelsBefore: Int)?
        var connectionClosed = false
        var c2sViolations = 0

        for (i, step) in steps.enumerated() {
            let at = "\(label) step \(i)"
            if connectionClosed { return XCTFail("\(at): a connection violation must be the last step") }

            if step["dir"]?.string == "s2c" {
                if step["reaction"]?.bool == true {
                    // The server's reaction to the preceding c2s violation:
                    // exactly one cancel for that id, emitted by the broker.
                    guard let pr = pendingReaction else { return XCTFail("\(at): reaction without a violation") }
                    XCTAssertEqual(step["message"]?["control"]?["cancel"]?.bool, true, at)
                    XCTAssertEqual(step["message"]?["id"]?.uint64, pr.t, at)
                    XCTAssertEqual(cancelsSent(bid(pr.t)) - pr.cancelsBefore, 1, at)
                    pendingReaction = nil
                    if plane.isClosed { connectionClosed = true }
                    continue
                }
                // Client-detected violations and stale server messages are
                // what a hostile or racing peer sends; the broker never does.
                if step["expectViolation"] != nil || step["ignored"]?.bool == true { continue }
                // Download frames: the broker writes its own, within the grants.
                if step["frame"] != nil { continue }
                let msg: FixtureJSON
                if let m = step["message"] {
                    msg = m
                } else if let raw = step["raw"]?.bytes, let m = try? FixtureJSON.parse(Data(raw)) {
                    msg = m
                } else {
                    return XCTFail("\(at): unreadable s2c step")
                }
                guard let t = msg["id"]?.uint64 else { return XCTFail("\(at): s2c message without id") }
                if msg["type"]?.string == "deviceRequest" {
                    let before = rec.sent.count
                    if msg["capability"]?.string == "core.capabilities" {
                        // The connection-owned control stream: opened by
                        // start(), or the stream of a planned reopen.
                        if plane.coreStreamId == nil { XCTAssertTrue(plane.start(), at) }
                        guard let core = plane.coreStreamId else { return XCTFail("\(at): no core stream") }
                        link(t, core)
                        let got = lastRequest(core)
                        // Host configuration: the first stream's credit is the
                        // transcript's; a planned reopen reuses it.
                        XCTAssertEqual(
                            got?.text { $0 == ["initialCredit"] ? msg["initialCredit"]?.text() : nil },
                            msg.text { $0 == ["id"] ? "\(core)" : nil }, at)
                        live[core] = Live(req: msg, revision: nil, box: nil, consumer: nil)
                        continue
                    }
                    guard let owner = msg["owner"], let mi = owner["moduleInstanceId"]?.string,
                          let act = owner["activationId"]?.uint64.flatMap({ UInt32(exactly: $0) }),
                          let cap = msg["capability"]?.string, let version = msg["version"]?.uint64.flatMap({ UInt32(exactly: $0) })
                    else { return XCTFail("\(at): transcript request without an activation owner") }
                    if !plane.ownerIsActive(mi, activationId: act) {
                        XCTAssertTrue(plane.ownerActivated(mi, activationId: act), at)
                    }
                    let rev = plane.revision(cap, version: version)
                    var download: Data?
                    var faulty = false
                    if rev?.data == .binaryDownload, let params = msg["params"],
                       let size = params["bytes"]?.int, let sha = params["sha256"]?.string {
                        // The server's snapshot: the bytes its frames carry in
                        // this transcript (or the same announcement's bytes
                        // from another transcript), padded to the declared size.
                        var bytes = (try? Self.downloadFrames(steps, from: i, id: t)) ?? Data()
                        if bytes.isEmpty { bytes = table[sha] ?? bytes }
                        var padded = Data(count: size)
                        padded.replaceSubrange(0..<min(size, bytes.count), with: bytes.prefix(size))
                        download = padded
                        faulty = DeviceDigest.sha256Hex(padded) != sha
                    }
                    var consumer: Consumer?
                    if rev?.data == .jsonEvents {
                        consumer = Consumer(collectData: false)
                    } else if streamed, rev?.mode == .stream, rev?.data == .binaryUpload {
                        consumer = Consumer(collectData: true)
                    }
                    consumer?.plane = plane
                    let spec = DevicePlaneOpenSpec(
                        capability: cap, version: version,
                        paramsJSON: String(decoding: msg["params"]?.raw ?? Data("{}".utf8), as: UTF8.self),
                        moduleInstanceId: mi, activationId: act,
                        lifetime: msg["lifetime"]?.string.flatMap(DeviceLifetime.init(rawValue:)),
                        timeoutMs: msg["timeoutMs"]?.uint64, initialCredit: msg["initialCredit"]?.uint64,
                        allowZeroCredit: true, download: download)
                    switch plane.open(spec, consumer: consumer) {
                    case .refused(let e):
                        // The transcript's server announces bytes it does not
                        // send: the broker never announces such a download.
                        XCTAssertTrue(faulty, "\(at): open refused: \(e)")
                        XCTAssertEqual(e.code, .invalidParams, at)
                        XCTAssertEqual(rec.sent.count, before, at)
                        refused.insert(t)
                    case .opened(let id, let box):
                        XCTAssertFalse(faulty, "\(at): broker announced bytes it does not send")
                        consumer?.id = id
                        link(t, id)
                        XCTAssertEqual(lastRequest()?.text(), msg.text { $0 == ["id"] ? "\(id)" : nil }, at)
                        live[id] = Live(req: msg, revision: rev, box: box, consumer: consumer)
                    }
                    continue
                }
                if refused.contains(t) { continue }
                let b = bid(t)
                if msg["type"]?.string == "deviceEvent", let want = msg["control"]?["renewLease"]?.uint64 {
                    transcriptLease[t] = max(transcriptLease[t] ?? 0, want)
                    // Bring the broker's own 5 s renewal cadence up to the transcript's.
                    var k = 0
                    while k < 10, brokerLease(b) < want, plane.isLive(b) {
                        clock.advance(by: 5_000)
                        k += 1
                    }
                    XCTAssertGreaterThanOrEqual(brokerLease(b), want, "\(at): the broker never renewed to \(want)")
                    continue
                }
                if msg["type"]?.string == "deviceEvent", msg["control"]?["cancel"] != nil {
                    if b == plane.coreStreamId {
                        // Planned reopen: the old control stream is retired first.
                        XCTAssertNotNil(plane.reopenCoreCapabilities(), at)
                        XCTAssertEqual(cancelsSent(b), 1, at)
                        continue
                    }
                    // Server-initiated cancellation (owner swept, abandon, deadline).
                    if plane.isLive(b) { plane.cancel(b) }
                    XCTAssertEqual(cancelsSent(b), 1, at)
                    continue
                }
                continue // grants and other server output are the broker's own
            }

            // ---- c2s: feed the client's step to the server broker ----
            counts.c2sSteps += 1
            if let pr = pendingReaction { return XCTFail("\(at): missing server reaction step for \(pr.t)") }
            var text: String?
            var frame: Data?
            var t: UInt64?
            var isResponse = false
            if let f = step["frame"] {
                t = f["header"]?["requestId"]?.uint64
                guard let bytes = try? Self.frameBytes(f), let tt = t else { return XCTFail("\(at): bad frame step") }
                frame = Self.withRequestId(bytes, bid(tt))
            } else if let rawBytes = step["raw"]?.bytes {
                var raw = String(decoding: rawBytes, as: UTF8.self)
                let lenient = (try? JSONSerialization.jsonObject(with: Data(rawBytes), options: [.fragmentsAllowed])) as? [String: Any]
                if let tid = (lenient?["id"] as? NSNumber)?.uint64Value, map[tid] != nil,
                   let range = raw.range(of: #""id":\#(tid)"#) {
                    raw.replaceSubrange(range, with: #""id":\#(bid(tid))"#)
                }
                text = raw
            } else if let msg = step["message"] {
                guard let tt = msg["id"]?.uint64 else { return XCTFail("\(at): c2s message without id") }
                t = tt
                isResponse = msg["type"]?.string == "deviceResponse"
                let b = bid(tt)
                var leaseAck: String?
                if let ackSeq = msg["control"]?["leaseAck"]?.uint64 {
                    // The broker sends renewLease 1 WITH each request, so a
                    // transcript whose server had not renewed yet sits below
                    // it: translate the ack by what each side actually sent.
                    let offset = Int64(brokerLease(b)) - Int64(transcriptLease[tt] ?? 0)
                    leaseAck = "\(Int64(ackSeq) + max(0, offset))"
                }
                text = msg.text { path in
                    if path == ["id"] { return "\(b)" }
                    if path == ["control", "leaseAck"] { return leaseAck }
                    return nil
                }
            } else {
                return XCTFail("\(at): c2s step without message/raw/frame")
            }
            if let tt = t, refused.contains(tt) {
                if step["expectViolation"] != nil { c2sViolations += 1 } // prevented at the source
                continue
            }
            let id = t.map(bid)
            let wasLive = id.map { plane.isLive($0) } ?? false
            let wasCore = id != nil && id == plane.coreStreamId
            let violationsBefore = plane.connectionViolations
            let cancelsBefore = id.map(cancelsSent) ?? 0
            let sentBefore = rec.sent.count
            let closesBefore = rec.closes.count
            if let frame { plane.receiveFrame(frame) } else if let text { plane.receiveText(text) }
            clock.runDue()

            if step["ignored"]?.bool == true {
                // Stale id: dropped with no effect, whatever the message is.
                counts.ignored += 1
                XCTAssertTrue(id == nil || !wasLive, "\(at): an ignored step targets a live id")
                XCTAssertEqual(rec.sent.count, sentBefore, at)
                XCTAssertEqual(plane.connectionViolations, violationsBefore, at)
                continue
            }

            guard let category = step["expectViolation"]?.string else {
                XCTAssertEqual(plane.connectionViolations, violationsBefore, "\(at): unexpected connection-level violation")
                XCTAssertEqual(rec.closes.count, closesBefore, "\(at): unexpected close")
                if let id, wasLive, !plane.isLive(id) {
                    // A legitimate terminal: success verifies, an error is the client's.
                    guard let entry = live[id], let msg = step["message"] else {
                        XCTFail("\(at): request ended by a non-terminal step")
                        continue
                    }
                    XCTAssertEqual(msg["type"]?.string, "deviceResponse", "\(at): request ended by a non-terminal step")
                    if let code = msg["error"]?["code"]?.string {
                        guard case .failure(let e)? = entry.box?.current else {
                            XCTFail("\(at): client error \(code) did not settle the request")
                            continue
                        }
                        XCTAssertEqual(e.code.rawValue, code, at)
                    } else {
                        XCTAssertTrue(Self.serverOutcomeOK(entry), "\(at): success did not verify: \(String(describing: entry.box?.current))")
                        counts.verifiedSuccesses += 1
                    }
                    XCTAssertEqual(cancelsSent(id) - cancelsBefore, 0, "\(at): cancel after a clean terminal")
                } else if let id, wasLive {
                    XCTAssertTrue(plane.isLive(id), at)
                }
                continue
            }

            c2sViolations += 1
            counts.violations += 1
            let next = i + 1 < steps.count ? steps[i + 1] : nil
            if category == "connection" {
                // A terminal on the live core.capabilities stream: the broker
                // closes the device plane (RemoteSession resets the socket 1012).
                XCTAssertTrue(wasCore && !plane.isLive(id!), at)
                XCTAssertEqual(rec.closes.map(\.code), [1012], at)
                XCTAssertTrue(plane.isClosed, at)
                connectionClosed = true
                continue
            }
            let requestLevel = wasLive && !plane.isLive(id!)
            if !requestLevel {
                // Connection-level (JSON limits, bad frame header): discarded
                // and counted, the request its id seems to name stays live.
                counts.connectionLevel += 1
                XCTAssertEqual(category, "malformed", at)
                XCTAssertEqual(plane.connectionViolations, violationsBefore + 1, at)
                if let id, wasLive { XCTAssertTrue(plane.isLive(id), at) }
                XCTAssertNotEqual(next?["reaction"]?.bool, true, "\(at): no reaction to a connection-level violation")
                continue
            }
            counts.requestLevel += 1
            // Request-level: settled locally with an error (invalidParams, or
            // the verification failure a handler would see).
            if !wasCore, let entry = live[id!] {
                XCTAssertFalse(Self.serverOutcomeOK(entry), "\(at): a violated request must not verify")
                if case .failure(let e)? = entry.box?.current {
                    XCTAssertEqual(e.code, .invalidParams, at)
                }
            }
            if isResponse {
                // The client's own terminal: settle locally, send nothing.
                XCTAssertEqual(cancelsSent(id!) - cancelsBefore, 0, at)
                XCTAssertNotEqual(next?["reaction"]?.bool, true, at)
                if wasCore { connectionClosed = plane.isClosed }
            } else {
                XCTAssertEqual(next?["reaction"]?.bool, true, "\(at): a request-level violation is followed by its reaction")
                pendingReaction = (t!, cancelsBefore)
            }
        }
        XCTAssertNil(pendingReaction, "\(label): reaction step missing at the end")
        // The broker closed the plane only where the transcript ends it.
        if !connectionClosed { XCTAssertTrue(rec.closes.isEmpty, "\(label): unexpected close \(rec.closes)") }
        // Every c2s violation flagged in the file was exercised.
        XCTAssertEqual(c2sViolations, steps.filter { $0["dir"]?.string == "c2s" && $0["expectViolation"] != nil }.count, label)
        plane.close()
        counts.transcripts += 1
    }
}
