import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// The shared cross-SDK device corpus (`engine-compatibility-tests/fixtures/
/// device/conformance`, `frames.json`, `schema/device/registry-v1.json`)
/// consumed through the Swift server's RUNTIME path — `RemoteSession`
/// routing, the handshake helpers `RemoteSession` calls, and the Rust
/// `DeviceBroker` behind `DevicePlane` — never through a Swift re-implementation
/// of the protocol (there is none).
///
/// - `messages.json`: every case, as its exact fixture text, is fed to a live
///   device session with `RemoteSession.receive`. A text announcing
///   `deviceRequest` / `deviceResponse` / `deviceEvent` (resolved as
///   `JSON.parse` resolves it: the last top-level `type` wins) must reach the
///   broker — a client `deviceRequest` too, which the broker judges by
///   liveness then direction (D8) — whatever else is
///   wrong with it; JSON-limit breaches (duplicate keys, number spellings,
///   depth, control characters, lone surrogates, trailing data, over 1 MiB)
///   are counted as connection-level violations; nothing else is touched.
/// - handshake cases: `deviceValidateHello` / `deviceValidateAck` (the
///   helpers behind `deviceNegotiate`), an invalid hello gets a
///   `sessionAck` without `device` from a real session (D7), and
///   `capabilitiesEvent` values are delivered on a live `core.capabilities`
///   stream.
/// - `selection.json`: `deviceSelectAck`.
/// - `payloads.json`: params through `DevicePlane.open` (refused
///   `invalidParams` iff invalid), events and results through live requests.
/// - `frames.json`: bad headers counted, short frames dropped, the seq rule
///   on a live upload.
final class DeviceConformanceTests: XCTestCase {
    typealias W = DeviceTestWire
    typealias Transport = DeviceSessionTests.DeviceTestTransport

    private static let conformance = "engine-compatibility-tests/fixtures/device/conformance"

    // MARK: - Session helpers

    private func deviceServer() throws -> RemoteServer {
        let server = RemoteServer()
            .module("App", AppBuilder(["n": 0]).build())
            .ui("Column { Text(\"conformance\") }")
            .configureDevice(DeviceServerOptions(clock: ManualDeviceClock()))
        try server.prepare()
        return server
    }

    private func deviceSession(_ server: RemoteServer) throws -> (RemoteSession, Transport, DevicePlane) {
        let t = Transport()
        let session = try server.createSession(transport: t)
        session.receive(#"{"type":"hello","device":\#(W.fullHello)}"#)
        let plane = try XCTUnwrap(session.device, "device plane negotiated")
        return (session, t, plane)
    }

    /// The top-level `type` a `JSON.parse` of `text` would yield (the last
    /// duplicate wins), or nil when `text` is not a JSON object text with a
    /// string `type`. Independent of the SDK's scanner: a character-level
    /// walk that tracks strings and nesting only.
    private static func jsParseType(_ text: String) -> String? {
        let scalars = Array(text.unicodeScalars)
        var i = 0
        func ws() { while i < scalars.count, [" ", "\t", "\n", "\r"].contains(scalars[i]) { i += 1 } }
        ws()
        guard i < scalars.count, scalars[i] == "{" else { return nil }
        var depth = 0
        var found: String?
        var expectKey = false
        var lastKey: String?
        while i < scalars.count {
            let c = scalars[i]
            if c == "\"" {
                // Read a string (escapes resolved only for plain ASCII use).
                var s = ""
                i += 1
                while i < scalars.count, scalars[i] != "\"" {
                    if scalars[i] == "\\", i + 1 < scalars.count {
                        let e = scalars[i + 1]
                        if e == "u", i + 5 < scalars.count,
                           let v = UInt32(String(String.UnicodeScalarView(scalars[(i + 2)...(i + 5)])), radix: 16),
                           let u = Unicode.Scalar(v) {
                            s.unicodeScalars.append(u)
                            i += 6
                            continue
                        }
                        s.unicodeScalars.append(e)
                        i += 2
                        continue
                    }
                    s.unicodeScalars.append(scalars[i])
                    i += 1
                }
                i += 1
                if depth == 1, expectKey {
                    lastKey = s
                    expectKey = false
                } else if depth == 1, lastKey == "type" {
                    found = s
                    lastKey = nil
                } else if depth == 1 {
                    lastKey = nil
                }
                continue
            }
            switch c {
            case "{", "[":
                depth += 1
                if depth == 1 { expectKey = true }
                if depth > 1, lastKey == "type" { lastKey = nil }
            case "}", "]":
                depth -= 1
            case ",":
                if depth == 1 {
                    expectKey = true
                    if lastKey == "type" { lastKey = nil }
                }
            case ":":
                break
            default:
                if depth == 1, !expectKey, lastKey == "type", !["\t", " ", "\n", "\r"].contains(c) {
                    lastKey = nil // a non-string type value
                }
            }
            i += 1
        }
        return found
    }

    // MARK: - messages.json

    func testMessageCorpusReachesTheBrokerAsExactTextThroughRemoteSession() throws {
        let doc = try DeviceFixtures.load("\(Self.conformance)/messages.json")
        let valid = try XCTUnwrap(doc["valid"]?.array)
        let invalid = try XCTUnwrap(doc["invalid"]?.array)
        XCTAssertGreaterThan(valid.count, 10)
        XCTAssertGreaterThan(invalid.count, 10)
        // Ids the corpus uses: the live core stream is moved off them, so
        // every attributable message targets a retired/unknown id (ignored,
        // D8) and only connection-level breaches are counted.
        var ids = Set<UInt64>()
        for c in valid + invalid {
            if let id = c["message"]?["id"]?.uint64 { ids.insert(id) }
            if let raw = c["raw"]?.bytes,
               let o = (try? JSONSerialization.jsonObject(with: Data(raw))) as? [String: Any],
               let id = (o["id"] as? NSNumber)?.uint64Value {
                ids.insert(id)
            }
        }

        let server = try deviceServer()
        defer { server.stop() }
        var current: (RemoteSession, Transport, DevicePlane)?
        var routedCount = 0
        var countedCount = 0
        for (isValid, cases) in [(true, valid), (false, invalid)] {
            for c in cases {
                let name = c["name"]?.string ?? "?"
                let bytes = try caseBytes(c)
                let text = String(decoding: bytes, as: UTF8.self)
                if current == nil || current!.2.isClosed || current!.2.connectionViolations > 16 {
                    current?.0.destroy()
                    current = try deviceSession(server)
                    let plane = current!.2
                    var guardCount = 0
                    while let core = plane.coreStreamId, ids.contains(UInt64(core)), guardCount < 64 {
                        plane.reopenCoreCapabilities()
                        guardCount += 1
                    }
                }
                let (session, transport, plane) = current!
                let core = try XCTUnwrap(plane.coreStreamId)
                let routedBefore = plane.receivedTextCount
                let violationsBefore = plane.connectionViolations
                let sentBefore = transport.deviceMessages.count
                let uiBefore = transport.uiMessages.count
                session.receive(text)

                let type: String? = c["message"] != nil ? c["message"]?["type"]?.string : Self.jsParseType(text)
                // Every device type is routed, a client-sent `deviceRequest`
                // included (the broker judges its direction, D8).
                let isDevice = type == "deviceRequest" || type == "deviceResponse" || type == "deviceEvent"
                let oversize = deviceIsOversizeText(text: text)
                let routed = plane.receivedTextCount - routedBefore
                let counted = plane.connectionViolations - violationsBefore
                if oversize {
                    // Over 1 MiB: counted before any parsing, never parsed.
                    XCTAssertEqual(routed, 0, "\(name): oversize text is never parsed")
                    XCTAssertEqual(counted, 1, "\(name): oversize device text is a counted violation")
                    countedCount += 1
                } else {
                    XCTAssertEqual(routed, isDevice ? 1 : 0,
                                   "\(name): routed=\(routed) for announced type \(type ?? "none")")
                    routedCount += routed
                    if isDevice {
                        if isValid {
                            XCTAssertEqual(counted, 0, "\(name): a valid message is not a violation")
                        } else if c["raw"] != nil || c["rawRepeat"] != nil {
                            // JSON-limit breaches are connection-level (D3/D4).
                            XCTAssertEqual(counted, 1, "\(name): a JSON-limit breach is counted")
                        }
                        countedCount += counted
                    }
                }
                // Never a request reaction, never a UI message: the only live
                // request (the control stream) is untouched.
                XCTAssertTrue(plane.isLive(core), "\(name): the control stream must survive")
                XCTAssertEqual(transport.deviceMessages.count, sentBefore, "\(name): nothing is sent")
                XCTAssertEqual(transport.uiMessages.count, uiBefore, "\(name): no UI traffic")
            }
        }
        current?.0.destroy()
        XCTAssertGreaterThanOrEqual(routedCount, 150, "device corpus routed to the broker")
        XCTAssertGreaterThanOrEqual(countedCount, 60, "JSON-limit breaches counted")
    }

    func testRoutingResolvesTypeLikeJSONParse() throws {
        let server = try deviceServer()
        defer { server.stop() }
        let (session, _, plane) = try deviceSession(server)
        let core = try XCTUnwrap(plane.coreStreamId)
        // A duplicated `type` (the last one wins, as in JSON.parse) is still a
        // device message: it reaches the broker and is counted.
        var routed = plane.receivedTextCount
        session.receive(#"{"type":"deviceEvent","type":"deviceEvent","id":\#(core),"event":{"kind":"progress","state":"running"}}"#)
        XCTAssertEqual(plane.receivedTextCount, routed + 1)
        XCTAssertEqual(plane.connectionViolations, 1)
        XCTAssertTrue(plane.isLive(core), "a JSON-limit breach touches no request")
        // `type` resolved to a UI type by the last duplicate is not routed.
        routed = plane.receivedTextCount
        session.receive(#"{"type":"deviceEvent","type":"subscribeState"}"#)
        XCTAssertEqual(plane.receivedTextCount, routed)
        // Escaped spelling of the type, whitespace, text that is not JSON
        // after the type: all routed (the broker judges them).
        routed = plane.receivedTextCount
        session.receive(#" { "type" : "deviceEvent", "id": 999999, "control": {"cancel": true} }"#)
        session.receive(#"{"type":"deviceResponse","id":999999,"result":{"a":1}"#)
        XCTAssertEqual(plane.receivedTextCount, routed + 2)
        // A lone-surrogate key before the type does not hide it.
        routed = plane.receivedTextCount
        session.receive(#"{"\ud800":1,"type":"deviceEvent","id":1,"id":1}"#)
        XCTAssertEqual(plane.receivedTextCount, routed + 1)
    }

    func testDuplicateTypeFloodUsesUpTheViolationBudgetAndResetsTheSocket() throws {
        // The verifier's probe P2: 40 × a deviceEvent with a duplicated
        // `type` must close the connection like any other JSON-limit breach.
        let server = try deviceServer()
        defer { server.stop() }
        let (session, transport, plane) = try deviceSession(server)
        let core = try XCTUnwrap(plane.coreStreamId)
        for _ in 0..<40 {
            session.receive(#"{"type":"deviceEvent","type":"deviceEvent","id":\#(core),"event":{"kind":"progress","state":"running"}}"#)
        }
        XCTAssertEqual(transport.closeCodes, [1012], "repeated violations reset the socket")
        XCTAssertTrue(plane.isClosed)
        XCTAssertNil(session.device)
    }

    // MARK: - Handshake

    /// Whether a snapshot value offers `core.capabilities` revision 1.
    private static func offersCoreV1(_ value: FixtureJSON) -> Bool {
        (value["capabilities"]?.array ?? []).contains {
            $0["name"]?.string == "core.capabilities" && ($0["versions"]?.u32s ?? []).contains(1)
        }
    }

    /// A snapshot on the live `core.capabilities` stream: a valid one
    /// replaces the live selection (withdrawing `core.capabilities` itself
    /// ends the device plane, without a violation); an invalid one violates
    /// the control stream (cancel sent, plane closed) or, when it breaks the
    /// JSON limits, is a counted connection-level violation.
    private func checkSnapshot(_ text: String, valid: Bool, keepsCore: Bool, _ name: String,
                               file: StaticString = #filePath, line: UInt = #line) throws {
        let h = try PlaneHarness()
        let core = try XCTUnwrap(h.plane.coreStreamId)
        let violations = h.plane.connectionViolations
        h.plane.receiveText(#"{"type":"deviceEvent","id":\#(core),"event":\#(text)}"#)
        let cancels = h.recorder.controls(core, "cancel").count
        if valid {
            XCTAssertEqual(h.plane.connectionViolations, violations, name, file: file, line: line)
            XCTAssertEqual(cancels, 0, "\(name): a valid snapshot is no violation", file: file, line: line)
            XCTAssertEqual(h.plane.isClosed, !keepsCore, name, file: file, line: line)
            if keepsCore {
                XCTAssertTrue(h.plane.isLive(core), name, file: file, line: line)
                XCTAssertTrue(h.recorder.closed.isEmpty, name, file: file, line: line)
            } else {
                XCTAssertEqual(h.recorder.closed.map(\.code), [1012], "\(name): core.capabilities withdrawn", file: file, line: line)
            }
        } else {
            let counted = h.plane.connectionViolations == violations + 1 && h.plane.isLive(core)
            let violated = cancels == 1 && h.plane.isClosed
            XCTAssertTrue(counted || violated, "\(name): an invalid snapshot must be refused", file: file, line: line)
        }
    }

    func testHandshakeCorpusThroughTheNegotiationHelpersAndASession() throws {
        let doc = try DeviceFixtures.load("\(Self.conformance)/messages.json")
        let cases = try XCTUnwrap(doc["handshake"]?.array)
        XCTAssertGreaterThan(cases.count, 10)
        let server = try deviceServer()
        defer { server.stop() }
        var kinds: [String: Int] = [:]
        for c in cases {
            let name = c["name"]?.string ?? "?"
            let kind = c["kind"]?.string ?? "?"
            let valid = c["valid"]?.bool ?? false
            let text = String(decoding: try caseBytes(c), as: UTF8.self)
            kinds[kind, default: 0] += 1
            switch kind {
            case "hello":
                if valid {
                    XCTAssertNoThrow(try deviceValidateHello(helloJson: text), name)
                } else {
                    XCTAssertThrowsError(try deviceValidateHello(helloJson: text), name)
                    XCTAssertNil(deviceNegotiate(helloJson: text, binaryRoute: true), "\(name): an invalid hello disables device (D7)")
                }
                // A real session: the ack carries `device` iff negotiation succeeds.
                let t = Transport()
                let session = try server.createSession(transport: t)
                session.receive(#"{"type":"hello","device":\#(text)}"#)
                let ack = try XCTUnwrap(t.ack(), "\(name): sessionAck")
                let negotiated = deviceNegotiate(helloJson: text, binaryRoute: true) != nil
                XCTAssertEqual(ack["device"] != nil, negotiated, name)
                XCTAssertEqual(session.device != nil, negotiated, name)
                if !valid { XCTAssertNil(ack["device"], "\(name): no device for an invalid hello") }
                session.destroy()
            case "ack":
                if valid {
                    XCTAssertNoThrow(try deviceValidateAck(ackJson: text), name)
                } else {
                    XCTAssertThrowsError(try deviceValidateAck(ackJson: text), name)
                }
            case "capabilitiesEvent":
                // Delivered as a snapshot on the live control stream.
                try checkSnapshot(text, valid: valid, keepsCore: c["value"].map(Self.offersCoreV1) ?? false, name)
            default:
                XCTFail("\(name): unknown handshake kind \(kind)")
            }
        }
        XCTAssertGreaterThanOrEqual(kinds["hello"] ?? 0, 10)
        XCTAssertGreaterThanOrEqual(kinds["ack"] ?? 0, 5)
        XCTAssertGreaterThanOrEqual(kinds["capabilitiesEvent"] ?? 0, 3)
    }

    func testSelectionCorpus() throws {
        let doc = try DeviceFixtures.load("\(Self.conformance)/selection.json")
        let cases = try XCTUnwrap(doc["cases"]?.array)
        XCTAssertGreaterThanOrEqual(cases.count, 20)
        for c in cases {
            let name = c["name"]?.string ?? "?"
            guard let hello = c["hello"], let caps = c["serverCapabilities"], let binary = c["serverBinary"]?.bool else {
                XCTFail("\(name): malformed selection case")
                continue
            }
            let versions = c["serverProtocolVersions"]?.u32s ?? [1]
            let ack: String?
            do {
                ack = try deviceSelectAck(
                    helloJson: String(decoding: hello.raw, as: UTF8.self), serverProtocolVersions: versions,
                    serverCapabilitiesJson: String(decoding: caps.raw, as: UTF8.self), serverBinary: binary)
            } catch {
                XCTFail("\(name): selection threw \(error)")
                continue
            }
            if let expect = c["expect"], !expect.isNull {
                let got = try ack.map { try FixtureJSON.parse(Data($0.utf8)).text() }
                XCTAssertEqual(got, expect.text(), name)
            } else {
                XCTAssertNil(ack, "\(name): device access must be disabled")
            }
        }
    }

    // MARK: - payloads.json

    /// Params of a request that makes `value` (an event or result of
    /// `capability`) admissible in context: camera mode matching the media
    /// type, the widest item counts.
    private static func contextParams(_ capability: String, for value: FixtureJSON?) -> String {
        func contentTypes(_ v: FixtureJSON?) -> [String] {
            guard let v else { return [] }
            var out: [String] = []
            if let ct = v["contentType"]?.string { out.append(ct) }
            for item in v["items"]?.array ?? [] { if let ct = item["contentType"]?.string { out.append(ct) } }
            return out
        }
        switch capability {
        case "gallery.pick": return #"{"mediaTypes":["photo","video"],"maxCount":16}"#
        case "file.pick": return #"{"accept":[],"maxCount":16}"#
        case "camera.capture":
            return contentTypes(value).contains { $0.hasPrefix("video/") } ? #"{"mode":"video"}"# : #"{"mode":"photo"}"#
        case "mic.record": return #"{"sampleRate":16000,"format":"pcm16"}"#
        case "permission.query", "permission.request": return #"{"permission":"camera"}"#
        default: return "{}"
        }
    }

    private func open(_ h: PlaneHarness, _ capability: String, version: UInt32 = 1, params: String,
                      download: Data? = nil, consumer: (any DevicePlaneConsumer)? = nil) -> DevicePlaneOpenResult {
        let mode = h.plane.revision(capability, version: 1)?.mode
        return h.plane.open(DevicePlaneOpenSpec(
            capability: capability, version: version, paramsJSON: params, moduleInstanceId: "m1", activationId: 1,
            mode: mode, download: download), consumer: consumer)
    }

    /// Send `bytes` as channel `channel` of upload `id`, within the credit the
    /// broker grants.
    private func upload(_ h: PlaneHarness, _ id: UInt32, channel: UInt16, _ bytes: Data) {
        var seq: UInt32 = 0
        var offset = 0
        while offset < bytes.count {
            let credit = Int(h.plane.outstandingCredit(id) ?? 0)
            guard credit > 0, h.plane.isLive(id) else { return }
            let n = min(65_536, credit, bytes.count - offset)
            h.plane.receiveFrame(W.frame(id, channel, seq, bytes.subdata(in: offset..<(offset + n))))
            seq += 1
            offset += n
            h.clock.runDue()
        }
    }

    private final class NullConsumer: DevicePlaneConsumer, @unchecked Sendable {
        weak var plane: DevicePlane?
        var id: UInt32 = 0
        func deliverEvent(_ json: String) { plane?.consumedEvents(id, 1) }
        func deliverData(channel: UInt16, bytes: Data) { plane?.consumedData(id, 1) }
        func finish(dropBuffered: Bool) {}
    }

    func testPayloadCorpusThroughTheBroker() throws {
        let doc = try DeviceFixtures.load("\(Self.conformance)/payloads.json")
        let cases = try XCTUnwrap(doc["cases"]?.array)
        XCTAssertGreaterThanOrEqual(cases.count, 100)
        var exercised: [String: Int] = [:]
        for c in cases {
            guard let name = c["name"]?.string, let cap = c["capability"]?.string, let kind = c["kind"]?.string,
                  let value = c["value"], let valid = c["valid"]?.bool,
                  let version = c["version"]?.uint64.flatMap({ UInt32(exactly: $0) }) else {
                XCTFail("malformed payload case")
                continue
            }
            if version != 1 {
                // A revision the connection did not select (D8: unsupported).
                XCTAssertFalse(valid, name)
                let h = try PlaneHarness()
                guard case .refused(let e) = open(h, cap, version: version, params: value.text()) else {
                    XCTFail("\(name): unknown revision admitted")
                    continue
                }
                XCTAssertEqual(e.code, .unsupported, name)
                exercised["\(kind):\(valid)", default: 0] += 1
                continue
            }
            let text = value.text()
            let label = "\(name) (\(cap) \(kind), \(valid ? "valid" : "invalid"))"
            exercised["\(kind):\(valid)", default: 0] += 1
            switch (cap, kind) {
            case ("core.capabilities", "params"):
                // The broker's own control-stream request carries the params;
                // no API can send others.
                let h = try PlaneHarness()
                let sent = try XCTUnwrap(h.recorder.requests("core.capabilities").first?["params"])
                let sentText = String(decoding: try JSONSerialization.data(withJSONObject: sent), as: UTF8.self)
                XCTAssertEqual(sentText == text, valid, label)
            case ("core.capabilities", "result"):
                // A terminal on the live control stream always ends the
                // device plane (valid or not: the stream must not end).
                let h = try PlaneHarness()
                let core = try XCTUnwrap(h.plane.coreStreamId)
                h.plane.receiveText(#"{"type":"deviceResponse","id":\#(core),"result":\#(text)}"#)
                XCTAssertTrue(h.plane.isClosed, label)
                XCTAssertEqual(h.recorder.closed.first?.code, 1012, label)
            case ("core.capabilities", "event"):
                try checkSnapshot(text, valid: valid, keepsCore: Self.offersCoreV1(value), label)
            case ("file.save", "params"):
                // The announcement must match the download bytes: a valid one
                // is admitted with bytes of its size (its sha256 rewritten to
                // theirs — the shape is unchanged); an invalid one is refused.
                let h = try PlaneHarness()
                let size = Int(value["bytes"]?.uint64 ?? 1)
                let bytes = W.bytes(max(1, min(size, 1 << 20)))
                let params = valid
                    ? value.text { $0 == ["sha256"] ? "\"\(DeviceDigest.sha256Hex(bytes))\"" : nil }
                    : text
                switch open(h, cap, params: params, download: bytes) {
                case .opened: XCTAssertTrue(valid, label)
                case .refused(let e):
                    XCTAssertFalse(valid, "\(label): refused \(e)")
                    XCTAssertEqual(e.code, .invalidParams, label)
                }
            case (_, "params"):
                let h = try PlaneHarness()
                switch open(h, cap, params: text) {
                case .opened: XCTAssertTrue(valid, "\(label): the broker admitted it")
                case .refused(let e):
                    XCTAssertFalse(valid, "\(label): refused \(e)")
                    XCTAssertEqual(e.code, .invalidParams, label)
                    XCTAssertTrue(h.recorder.requests(cap).isEmpty, "\(label): nothing sent")
                }
            case (_, "event"):
                let h = try PlaneHarness()
                let consumer = NullConsumer()
                consumer.plane = h.plane
                let result: DevicePlaneOpenResult
                if cap == "file.save" {
                    let bytes = W.bytes(8)
                    result = open(h, cap, params: deviceFileSaveParamsJson(name: "a", contentType: "b/c", bytes: bytes),
                                  download: bytes)
                } else {
                    result = open(h, cap, params: Self.contextParams(cap, for: value), consumer: consumer)
                }
                guard case .opened(let id, let box) = result else {
                    XCTFail("\(label): context request refused: \(result)")
                    continue
                }
                consumer.id = id
                h.plane.receiveText(#"{"type":"deviceEvent","id":\#(id),"event":\#(text)}"#)
                XCTAssertEqual(h.plane.isLive(id), valid, label)
                if !valid {
                    guard case .failure(let e)? = box.current else {
                        XCTFail("\(label): not settled")
                        continue
                    }
                    XCTAssertEqual(e.code, .invalidParams, label)
                    XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1, "\(label): one cancel")
                }
            case (_, "result"):
                let h = try PlaneHarness(extraConfig: #","maxRetainedBytes":134217728"#)
                let consumer = NullConsumer()
                consumer.plane = h.plane
                let bytes = cap == "file.save" ? W.bytes(Int(min(value["bytesWritten"]?.uint64 ?? 1, 1 << 20)).clamped(1)) : nil
                let result: DevicePlaneOpenResult
                if let bytes {
                    result = open(h, cap, params: deviceFileSaveParamsJson(name: "a", contentType: "b/c", bytes: bytes),
                                  download: bytes)
                } else {
                    result = open(h, cap, params: Self.contextParams(cap, for: value), consumer: consumer)
                }
                guard case .opened(let id, let box) = result else {
                    XCTFail("\(label): context request refused: \(result)")
                    continue
                }
                consumer.id = id
                var resultText = text
                if let bytes {
                    // Let the whole download through first.
                    h.plane.receiveText(W.control(id, ["grant": bytes.count]))
                    for _ in 0..<64 { h.clock.runDue() }
                    _ = bytes
                } else if valid {
                    // Upload items: send each declared item's bytes and state
                    // their real digest (same shape as the fixture's).
                    let items = value["items"]?.array ?? value["item"].map { [$0] } ?? []
                    var digests: [String: String] = [:]
                    for (index, item) in items.enumerated() {
                        let channel = UInt16(item["channel"]?.uint64 ?? 0)
                        let n = Int(item["bytes"]?.uint64 ?? 0)
                        let payload = n > 1 << 20
                            ? Data(repeating: UInt8(truncatingIfNeeded: 0x5a &+ index), count: n)
                            : W.bytes(n, seed: UInt8(truncatingIfNeeded: index))
                        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": Int(channel),
                                                         "contentType": item["contentType"]?.string ?? "", "bytes": n]))
                        upload(h, id, channel: channel, payload)
                        digests[item["channel"]?.text() ?? "0"] = DeviceDigest.sha256Hex(payload)
                    }
                    resultText = value.text { path in
                        guard path.last == "sha256" else { return nil }
                        let itemPath = Array(path.dropLast())
                        let item = itemPath.reduce(value as FixtureJSON?) { $0?[$1] ?? $0?.array?[Int($1) ?? -1] }
                        return item.flatMap { digests[$0["channel"]?.text() ?? "0"] }.map { "\"\($0)\"" }
                    }
                }
                h.plane.receiveText(#"{"type":"deviceResponse","id":\#(id),"result":\#(resultText)}"#)
                h.clock.runDue()
                switch box.current {
                case .success?: XCTAssertTrue(valid, "\(label): the broker accepted it")
                case .failure(let e)?:
                    XCTAssertFalse(valid, "\(label): failed \(e)")
                    XCTAssertEqual(e.code, .invalidParams, label)
                case nil: XCTFail("\(label): not settled")
                }
            default:
                XCTFail("\(label): unknown kind")
            }
        }
        XCTAssertGreaterThanOrEqual(exercised["params:true"] ?? 0, 30)
        XCTAssertGreaterThanOrEqual(exercised["params:false"] ?? 0, 90)
        XCTAssertGreaterThanOrEqual(exercised["result:true"] ?? 0, 25)
        XCTAssertGreaterThanOrEqual(exercised["event:false"] ?? 0, 20)
    }

    // MARK: - frames.json

    func testFrameCorpusThroughRemoteSessionAndALiveUpload() throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/frames.json")
        let server = try deviceServer()
        defer { server.stop() }
        let (session, _, plane) = try deviceSession(server)
        let goldens = try XCTUnwrap(doc["frames"]?.array)
        // Move the live control stream off every id the corpus names.
        let named = Set(goldens.compactMap { $0["header"]?["requestId"]?.uint64 })
            .union(try XCTUnwrap(doc["invalid"]?.array).compactMap { entry -> UInt64? in
                guard let bytes = try? hexDecode(entry["hex"]?.string ?? ""), bytes.count >= 8 else { return nil }
                return UInt64(DevicePlane.frameRequestId(bytes))
            })
        while let core = plane.coreStreamId, named.contains(UInt64(core)) { plane.reopenCoreCapabilities() }
        // Golden frames name no live upload: ignored, never a violation.
        for frame in goldens {
            let before = plane.connectionViolations
            session.receiveBinary(try hexDecode(frame["hex"]?.string ?? ""))
            XCTAssertEqual(plane.connectionViolations, before, frame["hex"]?.string ?? "")
        }
        XCTAssertFalse(plane.isClosed)
        // Short frames are dropped; bad versions/flags are counted (D3).
        var counted = 0
        for entry in try XCTUnwrap(doc["invalid"]?.array) {
            let reason = entry["reason"]?.string ?? ""
            let before = plane.connectionViolations
            session.receiveBinary(try hexDecode(entry["hex"]?.string ?? ""))
            if reason == "shortHeader" {
                XCTAssertEqual(plane.connectionViolations, before, reason)
            } else {
                XCTAssertTrue(reason.hasPrefix("violation"), reason)
                XCTAssertEqual(plane.connectionViolations, before + 1, reason)
                counted += 1
            }
        }
        XCTAssertGreaterThanOrEqual(counted, 3)

        // The per-channel seq rule on a live upload (every binary revision is
        // lossless `pause`; `dropOldest` revisions carry no frames).
        let registry = try DeviceFixtures.load("engine-compatibility-tests/schema/device/registry-v1.json")
        let h = try PlaneHarness()
        for cap in registry["capabilities"]?.array ?? [] {
            for rev in cap["revisions"]?.array ?? [] {
                let data = rev["data"]?.string ?? ""
                if data == "binaryUpload" || data == "binaryDownload" {
                    XCTAssertEqual(rev["overflow"]?.string, "pause", cap["name"]?.string ?? "")
                    let broker = h.plane.revision(cap["name"]?.string ?? "", version: UInt32(rev["version"]?.uint64 ?? 0))
                    XCTAssertEqual(broker?.overflow, .pause)
                }
            }
        }
        var lossless = 0
        for c in try XCTUnwrap(doc["sequences"]?["cases"]?.array) {
            let name = c["name"]?.string ?? "?"
            guard c["overflow"]?.string == "pause" else {
                XCTAssertEqual(c["overflow"]?.string, "dropOldest", name)
                continue
            }
            lossless += 1
            let valid = c["valid"]?.bool ?? false
            let seqs = c["seqs"]?.u32s ?? []
            let h = try PlaneHarness()
            guard case .opened(let id, let box) = open(h, "gallery.pick", params: #"{"mediaTypes":["photo"],"maxCount":1}"#) else {
                XCTFail("\(name): upload refused")
                continue
            }
            h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "image/jpeg"]))
            for (k, seq) in seqs.enumerated() {
                XCTAssertTrue(h.plane.isLive(id), "\(name): live before frame \(k)")
                h.plane.receiveFrame(W.frame(id, 0, seq, Data([UInt8(k + 1)])))
            }
            XCTAssertEqual(h.plane.isLive(id), valid, name)
            if !valid {
                guard case .failure(let e)? = box.current else { XCTFail("\(name): not settled"); continue }
                XCTAssertEqual(e.code, .invalidParams, name)
                XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1, name)
            }
        }
        XCTAssertGreaterThanOrEqual(lossless, 4)
    }

    // MARK: - Registry, enums, constants

    func testBrokerRevisionsEqualTheSharedRegistryExport() throws {
        let registry = try DeviceFixtures.load("engine-compatibility-tests/schema/device/registry-v1.json")
        XCTAssertEqual(registry["protocolVersion"]?.uint64, UInt64(DeviceProtocol.version))
        let h = try PlaneHarness()
        var names: [String] = []
        for cap in try XCTUnwrap(registry["capabilities"]?.array) {
            let name = try XCTUnwrap(cap["name"]?.string)
            names.append(name)
            for rev in try XCTUnwrap(cap["revisions"]?.array) {
                let version = try XCTUnwrap(rev["version"]?.uint64.flatMap { UInt32(exactly: $0) })
                let got = try XCTUnwrap(h.plane.revision(name, version: version), "\(name)@\(version)")
                XCTAssertEqual(got.mode.rawValue, rev["mode"]?.string, name)
                XCTAssertEqual(got.data.rawValue, rev["data"]?.string, name)
                XCTAssertEqual(got.consent.rawValue, rev["consent"]?.string, name)
                XCTAssertEqual(got.overflow.rawValue, rev["overflow"]?.string, name)
                XCTAssertEqual(got.lifetimes.map(\.rawValue), rev["lifetimes"]?.array?.compactMap(\.string), name)
                XCTAssertEqual(got.maxItemBytes, rev["maxItemBytes"]?.uint64, name)
                XCTAssertEqual(UInt64(got.maxItems), rev["maxItems"]?.uint64, name)
                XCTAssertEqual(got.maxInitialCredit, rev["maxInitialCredit"]?.uint64, name)
                XCTAssertEqual(got.maxOutstandingCredit, rev["maxOutstandingCredit"]?.uint64, name)
                XCTAssertEqual(got.maxTimeoutMs, rev["maxTimeoutMs"]?.uint64, name)
            }
        }
        XCTAssertEqual(names.count, 10)
        XCTAssertNil(h.plane.revision("camera.capture", version: 2))
        // The server advertises (and the full hello selects) every one.
        for name in names { XCTAssertTrue(h.plane.supports(name), name) }
    }

    func testSwiftEnumsMirrorTheSchemas() throws {
        let envelope = try DeviceFixtures.load("engine-compatibility-tests/schema/device/envelope-v1.schema.json")
        let codes = try XCTUnwrap(envelope["$defs"]?["error"]?["properties"]?["code"]?["enum"]?.array).compactMap(\.string)
        XCTAssertEqual(codes, DeviceErrorCode.allCases.map(\.rawValue))
        let lifetimes = try XCTUnwrap(envelope["$defs"]?["deviceRequest"]?["properties"]?["lifetime"]?["enum"]?.array)
            .compactMap(\.string)
        XCTAssertEqual(lifetimes, DeviceLifetime.allCases.map(\.rawValue))
        for capability in ["permission.query", "permission.request"] {
            let schema = try DeviceFixtures.load("engine-compatibility-tests/schema/device/\(capability)-v1.schema.json")
            let permissions = try XCTUnwrap(schema["$defs"]?["params"]?["properties"]?["permission"]?["enum"]?.array)
                .compactMap(\.string)
            XCTAssertEqual(permissions, Permission.allCases.map(\.rawValue), capability)
            let statuses = try XCTUnwrap(schema["$defs"]?["result"]?["properties"]?["status"]?["enum"]?.array)
                .compactMap(\.string)
            XCTAssertEqual(statuses, PermissionStatus.allCases.map(\.rawValue), capability)
        }
        let camera = try DeviceFixtures.load("engine-compatibility-tests/schema/device/camera.capture-v1.schema.json")
        let facing = try XCTUnwrap(camera["$defs"]?["params"]?["oneOf"]?.array?.first?["properties"]?["facing"]?["enum"]?.array)
            .compactMap(\.string)
        XCTAssertEqual(facing, CameraFacing.allCases.map(\.rawValue))
        let gallery = try DeviceFixtures.load("engine-compatibility-tests/schema/device/gallery.pick-v1.schema.json")
        let media = try XCTUnwrap(gallery["$defs"]?["params"]?["properties"]?["mediaTypes"]?["items"]?["enum"]?.array)
            .compactMap(\.string)
        XCTAssertEqual(media, MediaType.allCases.map(\.rawValue))
    }

    func testConstantsComeFromTheEngine() {
        XCTAssertEqual(DeviceProtocol.version, 1)
        XCTAssertEqual(DeviceProtocol.maxTextMessageBytes, 1_048_576)
        XCTAssertEqual(DeviceProtocol.maxBinaryFrameBytes, 12 + 65_536)
        XCTAssertEqual(DeviceProtocol.devicePlaneCloseCode, 1012)
        XCTAssertEqual(DeviceProtocol.maxBackgroundPinnedModules, 2)
        // The transport lets an oversize device text through to the broker
        // (a counted violation) and carries a full binary frame.
        XCTAssertGreaterThan(DeviceProtocol.transportMaxInboundMessageBytes, DeviceProtocol.maxTextMessageBytes)
        XCTAssertGreaterThanOrEqual(DeviceProtocol.transportMaxInboundMessageBytes, DeviceProtocol.maxBinaryFrameBytes)
    }
}

private extension Int {
    func clamped(_ low: Int) -> Int { Swift.max(low, self) }
}
