import XCTest
@testable import HypenSwift

// Replays every shared transcript in
// `engine-compatibility-tests/fixtures/device/transcripts/` against the real
// iOS `DeviceHost`, acting as the **client** endpoint (the reference model is
// `hypen-engine-rs/tests/test_device_transcripts.rs`; the Android client
// runner `DeviceTranscriptTest.kt` applies the same rules).
//
// Every server → client step is delivered through the host's socket edge
// (`handleMessage` with the exact text, `handleFrame` with the exact bytes).
// Every client → server step is either produced by the host itself (lease
// acks, `paused` transitions, blob announcements, frames and verified items,
// reactions, `cancelled` terminals, snapshots) or asked of a scripted driver
// (events, progress, terminal results, download credit, availability) and
// then compared with what the host actually sent:
//
// - `expectViolation` on a server step: the client detects it — `connection`
//   closes the device connection; an attributable violation terminates the
//   id with the reaction's exact code; connection-level `malformed` text or
//   frame headers change nothing and send nothing (decision D3);
// - `ignored` server steps produce no output at all;
// - a server `cancel` on a live id makes the client send its `cancelled`
//   terminal;
// - uploads are produced incrementally, like a live capture source: a
//   `blobStart` step opens the item (`openBlob`), each frame step writes its
//   payload (the host frames it as credit allows and reports `paused`
//   itself), and the terminal result ends production — so lease renewals
//   and grants interleaved with a live stream (mic.record) reach a live
//   operation, and an upload ending in an error (`throttled` when credit
//   starves) is checked up to that error;
// - uploads are compared by meaning, not chunking: the announced items, the
//   per-channel bytes (contiguous `seq`, no empty frame), `paused`
//   transitions (nothing sent while paused), cumulative bytes never beyond
//   the credit granted so far, and the terminal items;
// - client → server steps that are themselves violations (or `ignored` late
//   messages) describe a misbehaving or racing client and are not produced;
//   after an attributable one, the id's remaining client output is not
//   compared, and its upload is not produced.
//
// The handshake-selection transcripts are checked by
// `DeviceWireSharedFixtureTests.testSharedSelectionFixtures`. No transcript
// is skipped.

private let transcriptDir = "engine-compatibility-tests/fixtures/device/transcripts"

@MainActor
final class ScriptedDriver: DeviceDriver {
    let capability: String
    private let started: @MainActor (DeviceOperation) -> Void

    init(_ capability: String, started: @escaping @MainActor (DeviceOperation) -> Void) {
        self.capability = capability
        self.started = started
    }

    func start(_ operation: DeviceOperation) {
        started(operation)
    }
}

struct TranscriptFailure: Error, CustomStringConvertible {
    let description: String
}

@MainActor
final class TranscriptStats {
    var transcripts = 0
    var handshake = 0
    var clientDetected = 0
    var reactions = 0
    var produced = 0
    var uploadsVerified = 0
    var serverSideSteps = 0
}

@MainActor
final class TranscriptReplay {
    let name: String
    let doc: DeviceJSON
    let steps: [DeviceJSON]
    let stats: TranscriptStats
    let clock = ManualDeviceClock()
    let transport = RecordingTransport()
    var host: DeviceHost!
    var ops: [UInt32: DeviceOperation] = [:]

    /// Outputs already matched (indexes into transport.sent).
    var consumed = Set<Int>()
    /// Ids whose remaining client output is not compared.
    var abandoned = Set<UInt32>()
    var coreIds = Set<UInt32>()
    var coreIdsWithSnapshots = Set<UInt32>()
    var uploadTriggered = Set<UInt32>()
    /// Live upload items opened per request, by channel (uploads are
    /// produced incrementally, step by step, like a live capture source).
    var writers: [UInt32: [Int64: DeviceBlobWriter]] = [:]
    var requests: [UInt32: DeviceJSON] = [:]
    var credit: [UInt32: Int64] = [:]
    var ackedSeqs: [UInt32: Set<Int64>] = [:]
    /// Renewals delivered to the client: every lease ack must answer one.
    var renewals = Set<[Int64]>()
    let registryNames = Array(Set(DeviceRegistry.revisions.map { $0.capability })).sorted()

    init(doc: DeviceJSON, stats: TranscriptStats) {
        self.doc = doc
        self.name = doc["name"]?.stringValue ?? "?"
        self.steps = doc["steps"]?.arrayValue ?? []
        self.stats = stats
    }

    func fail(_ what: String) -> TranscriptFailure { TranscriptFailure(description: what) }

    // MARK: Step helpers

    func dir(_ s: DeviceJSON) -> String { s["dir"]?.stringValue ?? "" }
    func flag(_ s: DeviceJSON, _ key: String) -> Bool { s[key]?.boolValue == true }
    func violation(_ s: DeviceJSON) -> String? { s["expectViolation"]?.stringValue }
    func message(_ s: DeviceJSON) -> DeviceJSON? { s["message"] }

    func idOfStep(_ s: DeviceJSON) -> UInt32? {
        if let id = message(s)?["id"]?.int64Value { return UInt32(exactly: id) }
        if let id = s["frame"]?["header"]?["requestId"]?.int64Value { return UInt32(exactly: id) }
        if let raw = s["raw"]?.stringValue, let range = raw.range(of: #""id":(\d+)"#, options: .regularExpression) {
            return UInt32(raw[range].dropFirst(5))
        }
        return nil
    }

    func frameBytes(_ s: DeviceJSON) -> Data {
        var bytes = DeviceFixtures.bytes(fromHex: s["frame"]?["hex"]?.stringValue ?? "")
        if let fill = s["frame"]?["payloadFill"], let byte = fill["byte"]?.int64Value,
           let length = fill["length"]?.int64Value {
            bytes.append(Data(repeating: UInt8(byte), count: Int(length)))
        }
        return bytes
    }

    func outId(_ o: RecordingTransport.Sent) -> UInt32? {
        switch o {
        case let .message(m): return m["id"]?.int64Value.flatMap { UInt32(exactly: $0) }
        case let .frame(f):
            if case let .success(d) = DeviceFrameCodec.decode(f) { return d.header.requestId }
            return nil
        }
    }

    func isLeaseAck(_ o: RecordingTransport.Sent) -> Bool {
        if case let .message(m) = o { return m["control"]?["leaseAck"] != nil }
        return false
    }

    func isSnapshot(_ o: RecordingTransport.Sent) -> Bool {
        if case let .message(m) = o { return m["event"]?["capabilities"] != nil }
        return false
    }

    func text(_ value: DeviceJSON) -> String {
        String(decoding: DeviceFixtures.serialize(value), as: UTF8.self)
    }

    func describe(_ o: RecordingTransport.Sent) -> String {
        switch o {
        case let .message(m): return text(m)
        case let .frame(f):
            if case let .success(d) = DeviceFrameCodec.decode(f) { return "frame(\(d.header), \(d.payload.count) B)" }
            return "frame(bad)"
        }
    }

    func pending() -> [Int] {
        transport.sent.indices.filter { !consumed.contains($0) && !(outId(transport.sent[$0]).map(abandoned.contains) ?? false) }
    }

    func hasPending(_ id: UInt32) -> Bool {
        pending().contains { outId(transport.sent[$0]) == id && !isLeaseAck(transport.sent[$0]) }
    }

    /// Ids for which the transcript shows the client misbehaving
    /// (attributable c2s violations; a server-side test of that id).
    lazy var clientMisbehaves: Set<UInt32> = {
        var ids = Set<UInt32>()
        for (i, s) in steps.enumerated() where dir(s) == "c2s" && violation(s) != nil {
            let next = i + 1 < steps.count ? steps[i + 1] : nil
            if !isConnectionLevel(s, next: next), let id = idOfStep(s) { ids.insert(id) }
        }
        return ids
    }()

    func isConnectionLevel(_ s: DeviceJSON, next: DeviceJSON?) -> Bool {
        violation(s) == "malformed" && !(next.map { flag($0, "reaction") } ?? false)
            && (s["raw"] != nil || s["frame"] != nil)
    }

    // MARK: Output bookkeeping

    /// Run scheduling turns; record lease acks; silently accept snapshots of
    /// core streams the transcript does not show and output of abandoned ids.
    func settle() throws {
        clock.drainTurns()
        for i in transport.sent.indices where !consumed.contains(i) {
            let o = transport.sent[i]
            guard let id = outId(o) else { continue }
            if isLeaseAck(o), case let .message(m) = o, let seq = m["control"]?["leaseAck"]?.int64Value {
                ackedSeqs[id, default: []].insert(seq)
            }
            if isSnapshot(o), coreIds.contains(id), !coreIdsWithSnapshots.contains(id) { consumed.insert(i) }
            if abandoned.contains(id) { consumed.insert(i) }
        }
        try checkCredit()
    }

    /// Cumulative upload bytes never exceed the credit granted so far (§2.3).
    func checkCredit() throws {
        var sent: [UInt32: Int64] = [:]
        for o in transport.sent {
            guard case let .frame(f) = o, case let .success(d) = DeviceFrameCodec.decode(f) else { continue }
            sent[d.header.requestId, default: 0] += Int64(d.payload.count)
        }
        for (id, bytes) in sent {
            guard let allowed = credit[id] else { throw fail("frame for unknown request \(id)") }
            if bytes > allowed { throw fail("request \(id) sent \(bytes) bytes with only \(allowed) credit") }
        }
    }

    func isLive(_ id: UInt32) -> Bool {
        !transport.sent.contains { o in
            if case let .message(m) = o { return m["type"] == .string("deviceResponse") && outId(o) == id }
            return false
        }
    }

    // MARK: Setup

    func setUp() throws {
        // Driver order follows the transcript's snapshots, so the host's
        // advertisement orders names like them.
        var order: [String] = []
        for s in steps where violation(s) == nil && !flag(s, "ignored") {
            for offer in message(s)?["event"]?["capabilities"]?.arrayValue ?? [] {
                if let n = offer["name"]?.stringValue, !order.contains(n) { order.append(n) }
            }
        }
        for n in registryNames where !order.contains(n) { order.append(n) }
        order.removeAll { $0 == "core.capabilities" }
        let drivers = order.map { name in
            ScriptedDriver(name) { [unowned self] op in self.ops[op.request.id] = op }
        }
        host = DeviceHost(origin: "wss://app.example", drivers: drivers,
                          options: DeviceHost.Options(maxTimeout: 86_400, leaseExpiry: 86_400,
                                                      maxConnectionViolations: 1_000),
                          clock: clock, promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        guard host.attach(transport) else { throw fail("attach refused") }
        let ackValue: DeviceJSON = doc["ack"] ?? .object([
            "protocolVersion": .int(1), "binary": .bool(true),
            "capabilities": .array(DeviceRegistry.revisions.map {
                .object(["name": .string($0.capability), "version": .int(Int64($0.version))])
            }),
        ])
        let ack = try DeviceAck.decodeStrict(DeviceFixtures.serialize(ackValue))
        host.onAck(ack)
        guard host.selected != nil else { throw fail("the ack was not accepted") }
        for s in steps where dir(s) == "c2s" {
            if let m = message(s), m["event"]?["capabilities"] != nil, let id = idOfStep(s) {
                coreIdsWithSnapshots.insert(id)
            }
        }
    }

    /// The first snapshot a core stream shows: what the host offers when
    /// that stream opens.
    func firstSnapshot(for id: UInt32) -> [String]? {
        for s in steps where dir(s) == "c2s" && idOfStep(s) == id {
            if let caps = message(s)?["event"]?["capabilities"]?.arrayValue {
                return caps.compactMap { $0["name"]?.stringValue }
            }
        }
        return nil
    }

    func setAvailable(_ names: [String]) {
        host.setUnavailable(Set(registryNames).subtracting(names))
    }

    // MARK: Run

    func run() throws {
        try setUp()
        var i = 0
        while i < steps.count {
            let s = steps[i]
            let next = i + 1 < steps.count ? steps[i + 1] : nil
            i += dir(s) == "s2c" ? try serverStep(s, next: next) : try clientStep(s, next: next)
            if !transport.closed.isEmpty {
                if i < steps.count { throw fail("connection closed before step \(i)") }
                return
            }
        }
        for o in transport.sent where isLeaseAck(o) {
            guard case let .message(m) = o, let id = m["id"]?.int64Value,
                  let seq = m["control"]?["leaseAck"]?.int64Value else { continue }
            if !renewals.contains([id, seq]) { throw fail("leaseAck without a renewal: \(describe(o))") }
        }
        // Lease acks answering delivered renewals are always legitimate.
        let left = pending().filter { !isLeaseAck(transport.sent[$0]) }
        if !left.isEmpty { throw fail("unmatched client output: \(left.map { describe(transport.sent[$0]) })") }
    }

    // MARK: Server → client

    func deliver(_ s: DeviceJSON) throws {
        if let m = message(s) {
            host.handleMessage(DeviceFixtures.serialize(m))
        } else if let raw = s["raw"]?.stringValue {
            host.handleMessage(Data(raw.utf8))
        } else if s["frame"] != nil {
            host.handleFrame(frameBytes(s))
        } else {
            throw fail("step without payload")
        }
    }

    func serverStep(_ s: DeviceJSON, next: DeviceJSON?) throws -> Int {
        let m = message(s)
        let id = idOfStep(s)
        let ignored = flag(s, "ignored")
        if m?["type"] == .string("deviceRequest"), !ignored, let id = id {
            requests[id] = m
            credit[id] = m?["initialCredit"]?.int64Value ?? 0
            if m?["capability"] == .string("core.capabilities") {
                coreIds.insert(id)
                if let names = firstSnapshot(for: id) { setAvailable(names) }
            }
        }
        if let seq = m?["control"]?["renewLease"]?.int64Value, let id = id { renewals.insert([Int64(id), seq]) }
        if let grant = m?["control"]?["grant"]?.int64Value, let id = id, violation(s) == nil, !ignored {
            credit[id, default: 0] += grant
        }
        let before = transport.sent.count
        let wasLive = id.map { requests[$0] != nil && isLive($0) } ?? false
        try deliver(s)
        try settle()
        let fresh = (before..<transport.sent.count).filter {
            !consumed.contains($0) && !(outId(transport.sent[$0]).map(abandoned.contains) ?? false)
        }
        if ignored {
            if !fresh.isEmpty { throw fail("ignored step produced \(fresh.map { describe(transport.sent[$0]) })") }
            return 1
        }
        if let category = violation(s) {
            if category == "connection" {
                if transport.closed.isEmpty { throw fail("connection violation not detected") }
                stats.clientDetected += 1
                return 1
            }
            guard let next = next, flag(next, "reaction") else {
                // Connection-level (D3): discarded and counted, nothing sent, nothing ended.
                if !fresh.isEmpty { throw fail("connection-level violation produced \(fresh.map { describe(transport.sent[$0]) })") }
                if !transport.closed.isEmpty { throw fail("closed on a single connection-level violation") }
                stats.clientDetected += 1
                return 1
            }
            guard let reaction = message(next), let rid = reaction["id"]?.int64Value,
                  let code = reaction["error"]?["code"] else { throw fail("malformed reaction step") }
            guard let hit = fresh.first(where: { idx in
                guard case let .message(o) = transport.sent[idx] else { return false }
                return o["type"] == .string("deviceResponse") && o["id"]?.int64Value == rid && o["error"]?["code"] == code
            }) else {
                throw fail("expected reaction \(text(reaction)) after \(category), got \(fresh.map { describe(transport.sent[$0]) })")
            }
            consumed.insert(hit)
            abandoned.insert(UInt32(rid)) // retired on both sides; late output is not compared
            stats.clientDetected += 1
            stats.reactions += 1
            return 2
        }
        if m?["control"]?["cancel"] == .bool(true), let id = id {
            // The client answers a server cancel on a live id with its own `cancelled`.
            if wasLive, !abandoned.contains(id) {
                guard let hit = fresh.first(where: { idx in
                    guard case let .message(o) = transport.sent[idx] else { return false }
                    return o["type"] == .string("deviceResponse") && outId(transport.sent[idx]) == id
                }) else { throw fail("no cancelled terminal for \(id)") }
                guard case let .message(o) = transport.sent[hit], o["error"]?["code"] == .string("cancelled") else {
                    throw fail("cancel answered with \(describe(transport.sent[hit]))")
                }
                consumed.insert(hit)
            }
            abandoned.insert(id)
            return 1
        }
        if !transport.closed.isEmpty { throw fail("closed on a valid step") }
        if let terminal = fresh.first(where: { idx in
            guard case let .message(o) = transport.sent[idx], o["type"] == .string("deviceResponse") else { return false }
            return o["error"]?["code"] == .string("invalidParams") || o["error"]?["code"] == .string("unsupported")
        }) {
            let tid = outId(transport.sent[terminal])!
            // The transcript then shows the *client* lying about this id (e.g.
            // a success despite a hash mismatch); the iOS client refuses.
            if !clientMisbehaves.contains(tid) {
                throw fail("valid step refused: \(describe(transport.sent[terminal]))")
            }
            consumed.insert(terminal)
            abandoned.insert(tid)
            stats.clientDetected += 1
        }
        return 1
    }

    // MARK: Client → server

    func clientStep(_ s: DeviceJSON, next: DeviceJSON?) throws -> Int {
        let id = idOfStep(s)
        if flag(s, "ignored") {
            stats.serverSideSteps += 1
            return 1
        }
        if violation(s) != nil {
            // A misbehaving client: the iOS client never sends this.
            stats.serverSideSteps += 1
            if !isConnectionLevel(s, next: next), let id = id { abandoned.insert(id) }
            return 1
        }
        if flag(s, "reaction") { throw fail("unexpected client reaction step") }
        guard let id = id else { throw fail("client step without id") }
        if abandoned.contains(id) {
            stats.serverSideSteps += 1
            return 1
        }
        guard let req = requests[id], let capability = req["capability"]?.stringValue,
              let version = req["version"]?.int64Value,
              let rev = DeviceRegistry.find(capability, version: UInt32(version)) else {
            throw fail("client step for unknown request \(id)")
        }
        let m = message(s)
        let control = m?["control"]
        if let seq = control?["leaseAck"]?.int64Value {
            if let idx = pending().first(where: {
                if case let .message(o) = transport.sent[$0] { return o == m }
                return false
            }) {
                consumed.insert(idx)
            } else if !(ackedSeqs[id]?.contains(seq) ?? false) {
                throw fail("leaseAck \(seq) for \(id) never sent")
            } // else: a repeated/older ack of a sent sequence — legal, not reproduced
        } else if rev.data == .binaryUpload, isUploadStep(s) {
            if clientMisbehaves.contains(id) {
                // The upload ends in a client violation: a server-side test.
                stats.serverSideSteps += 1
                return 1
            }
            try uploadStep(id, s)
        } else if let grant = control?["grant"]?.int64Value {
            try script(id).grantDownload(UInt64(grant))
            try expectNext(id, m!)
        } else if m?["type"] == .string("deviceEvent"), let event = m?["event"]?.objectValue {
            if event["capabilities"] != nil, coreIds.contains(id) {
                if !hasPending(id) {
                    let names = event["capabilities"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
                    let before = transport.sent.count
                    setAvailable(names)
                    if transport.sent.count == before { host.publishCapabilities() }
                }
            } else if !hasPending(id) {
                let op = try script(id)
                if event["kind"] == .string("progress"),
                   let state = event["state"]?.stringValue.flatMap(DeviceProgressState.init(rawValue:)) {
                    op.progress(state)
                } else {
                    op.emit(event)
                }
            }
            try expectNext(id, m!)
        } else if m?["type"] == .string("deviceResponse") {
            if uploadTriggered.contains(id), m?["error"] != nil {
                // A live upload that ends in an error (e.g. `throttled` when
                // credit starves): what was streamed so far is checked first.
                try verifyUpload(id, terminal: nil)
            }
            if !hasPending(id) {
                let op = try script(id)
                let simulated = m?["simulated"] == .bool(true)
                if let result = m?["result"]?.objectValue {
                    op.succeed(result, simulated: simulated)
                } else if let error = m?["error"], let code = error["code"]?.stringValue.flatMap(DeviceErrorCode.init(rawValue:)) {
                    op.fail(code, error["platformDetail"]?.stringValue, simulated: simulated)
                } else {
                    throw fail("unexpected terminal \(text(m!))")
                }
            }
            try expectNext(id, m!)
        } else {
            throw fail("unexpected client step \(text(s))")
        }
        stats.produced += 1
        return 1
    }

    func script(_ id: UInt32) throws -> DeviceOperation {
        try settle()
        guard let op = ops[id] else { throw fail("no running driver for \(id)") }
        return op
    }

    func expectNext(_ id: UInt32, _ expected: DeviceJSON) throws {
        try settle()
        guard let idx = pending().first(where: { outId(transport.sent[$0]) == id && !isLeaseAck(transport.sent[$0]) }) else {
            throw fail("client sent nothing for \(id); expected \(text(expected))")
        }
        guard case let .message(got) = transport.sent[idx] else {
            throw fail("expected \(text(expected)), got \(describe(transport.sent[idx]))")
        }
        if got != expected {
            throw fail("expected \(text(expected))\n   got \(describe(transport.sent[idx]))")
        }
        consumed.insert(idx)
    }

    // MARK: Uploads

    func isUploadStep(_ s: DeviceJSON) -> Bool {
        if s["frame"] != nil { return true }
        guard let m = message(s) else { return false }
        if m["type"] == .string("deviceResponse") { return m["result"] != nil }
        if m["event"]?["kind"] == .string("blobStart") { return true }
        return m["control"]?["paused"] != nil
    }

    /// Every normal client step of `id`'s upload, in transcript order.
    func uploadSteps(_ id: UInt32) -> [DeviceJSON] {
        steps.filter {
            dir($0) == "c2s" && !flag($0, "ignored") && violation($0) == nil && idOfStep($0) == id && isUploadStep($0)
        }
    }

    struct UploadOutcome {
        var result: DeviceJSONObject
        var blobs: [(channel: Int64, blob: DeviceBlob)]
        var simulated: Bool
    }

    func uploadOutcome(_ id: UInt32) -> UploadOutcome {
        let all = uploadSteps(id)
        var payloads: [Int64: Data] = [:]
        for s in all where s["frame"] != nil {
            guard case let .success(d) = DeviceFrameCodec.decode(frameBytes(s)) else { continue }
            payloads[Int64(d.header.channel), default: Data()].append(d.payload)
        }
        let terminal = all.last { message($0)?["type"] == .string("deviceResponse") }.flatMap { message($0) }
        var result = terminal?["result"]?.objectValue ?? [:]
        let field = DeviceRegistry.resultItemField(requests[id]?["capability"]?.stringValue ?? "")
        let items: [DeviceJSON]
        switch result[field] {
        case let .array(list)?: items = list
        case let .object(one)?: items = [.object(one)]
        default: items = []
        }
        result[field] = nil
        var blobs: [(Int64, DeviceBlob)] = []
        for s in all {
            guard let start = message(s)?["event"], start["kind"] == .string("blobStart"),
                  let channel = start["channel"]?.int64Value, let type = start["contentType"]?.stringValue else { continue }
            var extra = items.first { $0["channel"]?.int64Value == channel }?.objectValue ?? [:]
            for key in ["channel", "contentType", "bytes", "sha256"] { extra[key] = nil }
            blobs.append((channel, DeviceBlob(contentType: type, bytes: payloads[channel] ?? Data(),
                                              declaresSize: start["bytes"] != nil, itemFields: extra)))
        }
        blobs.sort { $0.0 < $1.0 }
        return UploadOutcome(result: result, blobs: blobs.map { (channel: $0.0, blob: $0.1) },
                             simulated: terminal?["simulated"] == .bool(true))
    }

    /// Produce one upload step the way a live source does: `blobStart`
    /// opens the item, a frame step writes its payload (the host frames it
    /// as credit allows and reports `paused` itself), and the terminal
    /// result ends production. Outputs are compared by meaning at the
    /// terminal (or before an error terminal).
    func uploadStep(_ id: UInt32, _ s: DeviceJSON) throws {
        let op = try script(id)
        if !uploadTriggered.contains(id) {
            uploadTriggered.insert(id)
            for (index, entry) in uploadOutcome(id).blobs.enumerated() where entry.channel != Int64(index) {
                throw fail("transcript channels are not 0..<n (\(entry.channel))")
            }
        }
        if let m = message(s), let event = m["event"], event["kind"] == .string("blobStart"),
           let channel = event["channel"]?.int64Value, let type = event["contentType"]?.stringValue {
            guard channel == Int64(writers[id]?.count ?? 0) else { throw fail("blobStart out of channel order") }
            let extra = uploadOutcome(id).blobs.first { $0.channel == channel }?.blob.itemFields ?? [:]
            guard let writer = op.openBlob(contentType: type, declaredBytes: event["bytes"]?.int64Value.map { UInt64($0) },
                                           itemFields: extra) else {
                throw fail("the host refused to open channel \(channel)")
            }
            writers[id, default: [:]][channel] = writer
        } else if s["frame"] != nil {
            guard case let .success(d) = DeviceFrameCodec.decode(frameBytes(s)),
                  let writer = writers[id]?[Int64(d.header.channel)] else {
                throw fail("frame for an unopened channel")
            }
            writer.write(d.payload)
        } else if let m = message(s), m["type"] == .string("deviceResponse") {
            let outcome = uploadOutcome(id)
            op.succeed(outcome.result, simulated: outcome.simulated)
            try settle()
            try verifyUpload(id, terminal: m)
            return
        }
        // `paused` transitions are produced by the host from credit.
        try settle()
    }

    func sortItems(_ response: DeviceJSON) -> DeviceJSON {
        guard case var .object(o) = response, case var .object(result)? = o["result"],
              case let .array(items)? = result["items"] else { return response }
        result["items"] = .array(items.sorted { ($0["channel"]?.int64Value ?? 0) < ($1["channel"]?.int64Value ?? 0) })
        o["result"] = .object(result)
        return .object(o)
    }

    /// Compare the host's upload output for `id` with the transcript. With
    /// no `terminal` (an upload ending in an error) only what was streamed
    /// so far is compared.
    func verifyUpload(_ id: UInt32, terminal: DeviceJSON?) throws {
        let outs = pending().filter { outId(transport.sent[$0]) == id && !isLeaseAck(transport.sent[$0]) }
        var announced: [Int64: DeviceJSON] = [:]
        var bytes: [Int64: Data] = [:]
        var nextSeq: [Int64: UInt32] = [:]
        var paused = false
        var result: DeviceJSON?
        for idx in outs {
            switch transport.sent[idx] {
            case let .frame(f):
                guard case let .success(d) = DeviceFrameCodec.decode(f) else { throw fail("bad frame") }
                let ch = Int64(d.header.channel)
                if paused { throw fail("frame sent while paused") }
                if announced[ch] == nil { throw fail("frame before blobStart on channel \(ch)") }
                if d.payload.isEmpty { throw fail("zero-length frame") }
                if d.payload.count > DeviceProtocolConstants.maxBulkChunkBytes { throw fail("chunk above 64 KiB") }
                if d.header.seq != (nextSeq[ch] ?? 0) { throw fail("seq \(d.header.seq) on channel \(ch)") }
                nextSeq[ch] = d.header.seq + 1
                bytes[ch, default: Data()].append(d.payload)
            case let .message(m):
                if let event = m["event"], event["kind"] == .string("blobStart"), let ch = event["channel"]?.int64Value {
                    announced[ch] = event
                } else if let p = m["control"]?["paused"]?.boolValue {
                    if p == paused { throw fail("paused repeats \(p)") }
                    paused = p
                } else if m["type"] == .string("deviceResponse") {
                    result = m
                } else {
                    throw fail("unexpected upload output \(describe(transport.sent[idx]))")
                }
            }
            consumed.insert(idx)
        }
        if paused, terminal != nil { throw fail("ended paused") }
        var wantStarts: [Int64: DeviceJSON] = [:]
        for s in uploadSteps(id) {
            if let event = message(s)?["event"], event["kind"] == .string("blobStart"), let ch = event["channel"]?.int64Value {
                wantStarts[ch] = event
            }
        }
        if announced != wantStarts { throw fail("blobStarts \(announced) != \(wantStarts)") }
        let want = Dictionary(uniqueKeysWithValues: uploadOutcome(id).blobs.map { ($0.channel, $0.blob.bytes) })
        for (ch, b) in want where (bytes[ch] ?? Data()) != b { throw fail("channel \(ch) bytes differ") }
        if bytes.keys.contains(where: { want[$0] == nil }) { throw fail("bytes on unexpected channels \(bytes.keys)") }
        guard let terminal = terminal else {
            if result != nil { throw fail("a result before the error terminal for \(id)") }
            stats.uploadsVerified += 1
            return
        }
        guard let got = result else { throw fail("no terminal for \(id)") }
        if sortItems(got) != sortItems(terminal) {
            throw fail("terminal \(describe(.message(got))) != \(text(terminal))")
        }
        stats.uploadsVerified += 1
    }
}

@MainActor
final class DeviceTranscriptTests: XCTestCase, @unchecked Sendable {
    func testEverySharedTranscriptReplaysAgainstTheIOSClient() async throws {
        let dir = DeviceFixtures.url(transcriptDir)
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertGreaterThanOrEqual(files.count, 100, "transcripts found")
        let stats = TranscriptStats()
        var failures: [String] = []
        for file in files {
            let doc = try DeviceFixtures.load("\(transcriptDir)/\(file)")
            XCTAssertEqual(file, "\(doc["name"]?.stringValue ?? "").json")
            if doc["hello"] != nil {
                // Handshake-selection fixture: pinned by testSharedSelectionFixtures.
                stats.handshake += 1
                continue
            }
            do {
                try TranscriptReplay(doc: doc, stats: stats).run()
                stats.transcripts += 1
            } catch {
                failures.append("\(doc["name"]?.stringValue ?? file): \(error)")
            }
        }
        print("device transcripts (iOS client): transcripts=\(stats.transcripts) handshake=\(stats.handshake) "
            + "clientDetected=\(stats.clientDetected) reactions=\(stats.reactions) produced=\(stats.produced) "
            + "uploadsVerified=\(stats.uploadsVerified) serverSideSteps=\(stats.serverSideSteps)")
        XCTAssertTrue(failures.isEmpty, "\(failures.count) transcript(s) failed:\n" + failures.joined(separator: "\n"))
        XCTAssertEqual(stats.transcripts + stats.handshake, files.count, "no transcript skipped")
        XCTAssertGreaterThanOrEqual(stats.clientDetected, 30)
        XCTAssertGreaterThanOrEqual(stats.reactions, 25)
        XCTAssertGreaterThanOrEqual(stats.uploadsVerified, 8)
    }
}
