import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import HypenSwift

// Regression tests for the second review of the iOS DeviceHost
// (review2-ios.md findings #1–#13 and the round-2 decisions D1–D8). The
// adversarial probes the reviewer ran from scratch (hostile keys, number
// spellings, the TS-broker credit model, late acks) are adopted here as
// assertions.

@MainActor
private func r2json(_ text: String) -> Data { Data(text.utf8) }

@MainActor
private func r2request(id: UInt32, capability: String, params: String = #"{"permission":"camera"}"#,
                       timeoutMs: UInt64 = 300_000, initialCredit: UInt64 = 0,
                       owner: String = #"{"moduleInstanceId":"m-1","activationId":1}"#,
                       lifetime: String = "activation") -> Data {
    r2json(#"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":1,"owner":\#(owner),"lifetime":"\#(lifetime)","timeoutMs":\#(timeoutMs),"initialCredit":\#(initialCredit),"params":\#(params)}"#)
}

@MainActor
private func r2control(id: UInt32, _ control: String) -> Data {
    r2json(#"{"type":"deviceEvent","id":\#(id),"control":\#(control)}"#)
}

@MainActor
private func coreRequest(id: UInt32, credit: UInt64 = 8) -> Data {
    r2request(id: id, capability: "core.capabilities", params: "{}", timeoutMs: 86_400_000,
              initialCredit: credit, owner: #"{"connection":true}"#, lifetime: "connection")
}

private let galleryParams1 = #"{"mediaTypes":["photo"],"maxCount":1}"#
private let galleryParams2 = #"{"mediaTypes":["photo"],"maxCount":2}"#

/// Minimal model of the TS `DeviceBroker` upload receive path
/// (`broker.ts` receiveBlobStart / receiveFrame): contiguous seq, NON-EMPTY
/// payload, len ≤ outstanding credit, replenish exactly what was consumed
/// (bounded by maxOutstanding), declared sizes checked when present (D5).
@MainActor
final class MiniTsBroker: DeviceTransport {
    struct Channel { var bytes: Int?; var received = 0; var nextSeq: UInt32 = 0; var data = Data() }
    weak var host: DeviceHost?
    var credit: Int
    let maxOutstanding: Int
    var channels: [UInt16: Channel] = [:]
    var violation: String?
    var result: DeviceJSON?
    var pausedState = false

    init(initialCredit: Int, maxOutstanding: Int = 8 * 1024 * 1024) {
        credit = initialCredit
        self.maxOutstanding = maxOutstanding
    }

    func sendDeviceMessage(_ json: Data) {
        guard violation == nil else { return }
        let m = try! DeviceStrictJSON.parse(json)
        if m["type"]?.stringValue == "deviceResponse" { result = m; return }
        if let ev = m["event"], ev["kind"]?.stringValue == "blobStart" {
            let ch = UInt16(ev["channel"]!.int64Value!)
            channels[ch] = Channel(bytes: ev["bytes"]?.int64Value.map { Int($0) })
            return
        }
        if let p = m["control"]?["paused"]?.boolValue {
            if p == pausedState { violation = "paused:\(p) repeats the current state" }
            pausedState = p
        }
    }

    func sendDeviceBinary(_ frame: Data, completion: @escaping @Sendable @MainActor () -> Void) {
        defer { completion() }
        guard violation == nil, case let .success(d) = DeviceFrameCodec.decode(frame) else { return }
        guard var c = channels[d.header.channel] else { violation = "frame before blobStart"; return }
        if d.header.seq != c.nextSeq { violation = "seq \(d.header.seq) expected \(c.nextSeq)"; return }
        let len = d.payload.count
        if len == 0 { violation = "channel \(d.header.channel): zero-length frame"; return }
        if let declared = c.bytes, c.received + len > declared { violation = "exceeds declared"; return }
        if len > credit { violation = "frame of \(len) bytes exceeds outstanding credit \(credit)"; return }
        c.nextSeq += 1
        c.received += len
        c.data.append(d.payload)
        channels[d.header.channel] = c
        credit -= len
        let grant = min(len, maxOutstanding - credit)
        if grant > 0 {
            credit += grant
            let requestId = d.header.requestId
            // The grant arrives later, on a new main-actor turn (network RTT).
            Task { @MainActor [weak self] in
                self?.host?.handleMessage(r2control(id: requestId, #"{"grant":\#(grant)}"#))
            }
        }
    }
}

@MainActor
final class DeviceHostRound2Tests: XCTestCase, @unchecked Sendable {
    var clock: ManualDeviceClock!
    var transport: RecordingTransport!

    override func setUp() async throws {
        clock = ManualDeviceClock()
        transport = RecordingTransport()
    }

    /// A host with the full connection model: attach, ack everything it
    /// offers, open core.capabilities as id 1, and clear the wire.
    private func liveHost(_ drivers: [DeviceDriver], transport: DeviceTransport? = nil,
                          options: DeviceHost.Options = DeviceHost.Options(leaseExpiry: 10_000),
                          origin: String? = "wss://app.example.com") -> DeviceHost {
        let host = DeviceHost(origin: origin, drivers: drivers, options: options, clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        XCTAssertTrue(host.attach(transport ?? self.transport))
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        host.handleMessage(coreRequest(id: 1))
        self.transport.clear()
        return host
    }

    private func responses(_ t: RecordingTransport? = nil) -> [DeviceJSON] {
        (t ?? transport).messages.filter { $0["type"]?.stringValue == "deviceResponse" }
    }

    private func code(_ m: DeviceJSON?) -> String? { m?["error"]?["code"]?.stringValue }

    private func pump() async {
        for _ in 0..<2_000 {
            clock.drainTurns()
            await Task.yield()
        }
        clock.drainTurns()
    }

    // MARK: #1 — hostile keys never crash; the text names no request

    func testMalformedKeysAndStringsAreDroppedWithoutCrashing() async {
        let host = liveHost([HoldDriver("permission.query")])
        host.handleMessage(r2request(id: 2, capability: "permission.query", timeoutMs: 30_000))
        func bytes(_ parts: [Any]) -> Data {
            var out = Data()
            for p in parts {
                if let s = p as? String {
                    out.append(Data(s.utf8))
                } else if let b = p as? [UInt8] {
                    out.append(contentsOf: b)
                } else {
                    XCTFail("unexpected part \(p)")
                }
            }
            return out
        }
        let ctl1: [UInt8] = [0x01], ctl2: [UInt8] = [0x02], badUTF8: [UInt8] = [0xC3, 0x28]
        let hostile: [Data] = [
            bytes([#"{"type":"deviceEvent","id":2,"event":{"a"#, ctl1, #"":1}}"#]),
            bytes([#"{"type":"deviceEvent","id":2,"event":{"\ud800":1}}"#]),
            bytes([#"{"type":"deviceRequest","id":3,"capability":"permission.query","version":1,"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":1000,"initialCredit":0,"params":{"\udc00":1}}"#]),
            bytes([#"{"type":"deviceEvent","id":2,"event":{"a"#, badUTF8, #"":1}}"#]),
            bytes([#"{"type":"deviceEvent","id":2,"x"#, ctl2, #"":1,"control":{"cancel":true}}"#]),
            bytes([#"{"type":"deviceEvent","id":2,"event":{"k":"\ud800"}}"#]),
            bytes([#"{"type":"deviceEvent","id":2,"event":{"k":"\udc00\ud800"}}"#]),
        ]
        for text in hostile {
            host.handleMessage(text)
            XCTAssertThrowsError(try DeviceWireMessage.decodeStrict(text))
        }
        XCTAssertTrue(transport.sent.isEmpty, "never attributable: no reply, no termination")
        XCTAssertEqual(host.liveOperationCount, 2, "core stream and request 2 stay live")
        XCTAssertEqual(host.connectionViolationCount, hostile.count)
        // Request 3 never reached admission: id 3 is still unused.
        host.handleMessage(r2request(id: 3, capability: "permission.query", timeoutMs: 30_000))
        XCTAssertEqual(host.liveOperationCount, 3)
    }

    func testRepeatedConnectionLevelViolationsCloseTheConnection() async {
        let host = liveHost([HoldDriver("permission.query")],
                            options: DeviceHost.Options(leaseExpiry: 10_000, maxConnectionViolations: 3))
        host.handleMessage(r2json("{nope"))
        host.handleFrame(Data([9, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]))
        XCTAssertTrue(transport.closed.isEmpty)
        host.handleMessage(r2json(#"{"type":"deviceEvent","id":1.0,"control":{"cancel":true}}"#))
        XCTAssertEqual(transport.closed.map { $0.code }, [1002])
        XCTAssertEqual(host.liveOperationCount, 0, "closing tears the plane down")
        XCTAssertTrue(transport.sent.isEmpty)
    }

    // MARK: #4 — integer tokens only

    func testNonIntegerSpellingsNeverAddressALiveId() async {
        let host = liveHost([HoldDriver("bluetooth.scan")])
        host.handleMessage(r2request(id: 2, capability: "bluetooth.scan", params: "{}", timeoutMs: 600_000))
        for literal in ["1.0", "2.0", "2e0", "2E0", "0.2e1", "4.294967295e9", "-0", "-0.0", "02", "+2"] {
            host.handleMessage(r2json(#"{"type":"deviceEvent","id":\#(literal),"control":{"renewLease":1}}"#))
        }
        for literal in ["1.0", "1e0", "1e1", "1.0e0"] {
            host.handleMessage(r2json(#"{"type":"deviceEvent","id":2,"control":{"renewLease":\#(literal)}}"#))
        }
        XCTAssertTrue(transport.sent.isEmpty, "no lease ack, no termination")
        XCTAssertEqual(host.liveOperationCount, 2)
        XCTAssertThrowsError(try DeviceWireMessage.decodeStrict(r2json(#"{"type":"deviceEvent","id":1,"control":{"grant":1e3}}"#)))
        XCTAssertThrowsError(try DeviceWireMessage.decodeStrict(r2json(#"{"type":"deviceEvent","id":1.0,"control":{"cancel":true}}"#)))
        host.handleMessage(r2control(id: 2, #"{"renewLease":1}"#))
        XCTAssertEqual(transport.messages.last?["control"]?["leaseAck"]?.int64Value, 1)
    }

    // MARK: #5 / D2 — empty items against the TS broker model

    func testZeroLengthItemInteropWithTsBroker() async {
        let broker = MiniTsBroker(initialCredit: 262_144)
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker)], transport: broker)
        broker.host = host
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams2, initialCredit: 262_144))
        picker.completion?(.picked([PickedMedia(contentType: "image/png", data: Data()),
                                    PickedMedia(contentType: "image/png", data: Data([1, 2, 3]))]))
        await pump()
        XCTAssertNil(broker.violation)
        XCTAssertEqual(broker.channels[0]?.received, 0)
        XCTAssertEqual(broker.channels[1]?.data, Data([1, 2, 3]))
        XCTAssertEqual(broker.result?["result"]?["items"]?.arrayValue?.map { $0["bytes"]?.int64Value }, [0, 3])
    }

    func testInteropCreditBelowChunkCompletesAgainstTsBroker() async {
        let broker = MiniTsBroker(initialCredit: 32_768)
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker)], transport: broker)
        broker.host = host
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams2, initialCredit: 32_768))
        let a = Data((0..<200_000).map { UInt8($0 % 251) })
        let b = Data((0..<70_001).map { UInt8($0 % 13) })
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: a),
                                    PickedMedia(contentType: "image/jpeg", data: b)]))
        await pump()
        XCTAssertNil(broker.violation)
        XCTAssertEqual(broker.channels[0]?.data, a)
        XCTAssertEqual(broker.channels[1]?.data, b)
        XCTAssertNotNil(broker.result?["result"])
    }

    // MARK: D5 — sizes are optional; limits apply as bytes are written

    func testUndeclaredStreamedItemUsesItemFieldAndActualSize() async {
        let driver = HoldDriver("mic.record")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "mic.record",
                                     params: #"{"sampleRate":16000,"format":"pcm16","maxDurationMs":60000}"#,
                                     timeoutMs: 600_000, initialCredit: 16))
        let op = driver.operations[0]
        op.progress(.running)
        guard let writer = op.openBlob(contentType: "audio/L16") else { return XCTFail("openBlob") }
        XCTAssertEqual(transport.messages.last?["event"],
                       .object(["kind": .string("blobStart"), "channel": .int(0), "contentType": .string("audio/L16")]),
                       "a live recording announces no size")
        let pcm = Data((0..<40).map { UInt8($0) })
        writer.write(pcm.prefix(16))
        clock.drainTurns()
        writer.write(pcm.dropFirst(16))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.map { $0.count - 12 }, [16])
        XCTAssertEqual(transport.messages.last?["control"]?["paused"]?.boolValue, true)
        host.handleMessage(r2control(id: 2, #"{"grant":64}"#))
        clock.drainTurns()
        writer.finish()
        op.succeed(["durationMs": .int(1250)])
        clock.drainTurns()
        XCTAssertEqual(transport.frames.reduce(0) { $0 + $1.count - 12 }, 40)
        let result = responses().last?["result"]
        XCTAssertEqual(result?["durationMs"]?.int64Value, 1250)
        XCTAssertEqual(result?["item"]?["bytes"]?.int64Value, 40)
        XCTAssertEqual(result?["item"]?["sha256"]?.stringValue, DeviceHash.sha256Hex(pcm))
        XCTAssertNil(result?["items"])
    }

    func testStreamedItemIsBoundedAsBytesArrive() async {
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 0))
        let op = driver.operations[0]
        let writer = op.openBlob(contentType: "video/mp4")
        writer?.write(Data(count: 32 * 1024 * 1024))
        writer?.write(Data(count: 32 * 1024 * 1024))
        XCTAssertTrue(responses().isEmpty, "exactly maxItemBytes is allowed")
        writer?.write(Data([0]))
        XCTAssertEqual(code(responses().last), "throttled", "the 64 MiB + 1st byte ends the item")
        XCTAssertTrue(writer?.isClosed ?? false)
    }

    func testDeclaredSizeMustBeMetExactly() async {
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams2, initialCredit: 1024))
        let op = driver.operations[0]
        let writer = op.openBlob(contentType: "image/png", declaredBytes: 4)
        XCTAssertEqual(transport.messages.last?["event"]?["bytes"]?.int64Value, 4)
        writer?.write(Data([1, 2, 3]))
        writer?.finish()
        XCTAssertEqual(code(responses().last), "internal", "a declared size that is not reached")

        host.handleMessage(r2request(id: 3, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        let over = driver.operations[1].openBlob(contentType: "image/png", declaredBytes: 2)
        over?.write(Data([1, 2, 3]))
        XCTAssertEqual(code(responses().last), "internal", "a declared size that is exceeded")
        host.handleMessage(r2request(id: 4, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        XCTAssertNil(driver.operations[2].openBlob(contentType: "x", declaredBytes: 64 * 1024 * 1024 + 1))
        XCTAssertEqual(code(responses().last), "throttled", "declared above maxItemBytes")
    }

    func testDataBlobWithoutDeclarationOmitsBytes() async {
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        driver.operations[0].succeed([:], blobs: [DeviceBlob(contentType: "image/png", bytes: Data([7, 7]), declaresSize: false)])
        clock.drainTurns()
        XCTAssertNil(transport.messages.first?["event"]?["bytes"])
        XCTAssertEqual(responses().last?["result"]?["items"]?.arrayValue?.first?["bytes"]?.int64Value, 2)
    }

    func testItemFieldsRideOnlyOnTheTerminalItem() async {
        let driver = HoldDriver("file.pick")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "file.pick", params: #"{"accept":["application/pdf"],"maxCount":1}"#,
                                     initialCredit: 1024))
        driver.operations[0].succeed([:], blobs: [DeviceBlob(contentType: "application/pdf", bytes: Data("%PDF".utf8),
                                                             itemFields: ["name": .string("doc.pdf")])])
        clock.drainTurns()
        XCTAssertNil(transport.messages.first?["event"]?["name"], "blobStart is closed")
        XCTAssertEqual(responses().last?["result"]?["items"]?.arrayValue?.first?["name"]?.stringValue, "doc.pdf")
    }

    // MARK: #6 — the host binds to the socket's origin

    func testHostRefusesASocketWithAnotherOrigin() async {
        let host = DeviceHost(origin: "wss://prod.example.com", drivers: [], clock: clock,
                              persistentStore: InMemoryDeviceStore())
        let dev = RecordingTransport()
        dev.origin = "ws://localhost:3000"
        XCTAssertFalse(host.attach(dev), "a hard-coded prod origin never labels a dev socket")
        host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: [CapabilitySelection(name: "core.capabilities", version: 1)]))
        host.handleMessage(coreRequest(id: 1))
        XCTAssertTrue(dev.sent.isEmpty)
        let other = RecordingTransport()
        other.origin = "wss://evil.example.com"
        XCTAssertFalse(host.attach(other))
        let same = RecordingTransport()
        same.origin = "wss://PROD.example.com:443"
        XCTAssertTrue(host.attach(same))
        XCTAssertTrue(DeviceHost.sameOrigin("https://prod.example.com", "wss://prod.example.com:443"))
        XCTAssertFalse(DeviceHost.sameOrigin("https://prod.example.com", "ws://prod.example.com"))
    }

    func testUnboundHostTakesEachSocketsOrigin() async {
        let store = InMemoryDeviceStore()
        let host = DeviceHost(origin: nil, drivers: [], clock: clock, persistentStore: store)
        let plain = RecordingTransport()
        plain.origin = "ws://localhost:3000"
        XCTAssertTrue(host.attach(plain))
        XCTAssertEqual(host.grants.origin, "ws://localhost:3000")
        XCTAssertFalse(host.grants.persistent, "plaintext: grants stay connection-scoped")
        XCTAssertTrue(host.grants.displayOrigin.contains("development"))
        host.detach()
        let secure = RecordingTransport()
        secure.origin = "wss://app.example.com"
        XCTAssertTrue(host.attach(secure))
        XCTAssertEqual(host.grants.origin, "wss://app.example.com")
        XCTAssertTrue(host.grants.persistent)
        XCTAssertFalse(DeviceHost(origin: nil, drivers: [], clock: clock, persistentStore: store).attach(RecordingTransport()),
                       "no origin to bind to at all")
    }

    // MARK: #7 — cleanup registered before succeed

    func testOnCancelRegisteredBeforeSucceedRunsWhenUploadIsCancelled() async {
        transport.autoComplete = false
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 4 * 1024 * 1024))
        let op = driver.operations[0]
        var released = 0
        var ended = 0
        op.onCancel { released += 1 }
        op.onEnd { ended += 1 }
        op.succeed([:], blobs: [DeviceBlob(contentType: "video/mp4", bytes: Data(count: 1024 * 1024))])
        clock.drainTurns()
        host.handleMessage(r2control(id: 2, #"{"cancel":true}"#))
        XCTAssertEqual(released, 1)
        XCTAssertEqual(ended, 1)
    }

    func testOnEndRunsOnceOnEveryEnding() async {
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver])
        var ends: [UInt32] = []
        for id: UInt32 in 2...4 {
            host.handleMessage(r2request(id: id, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
            let op = driver.operations.last!
            op.onEnd { ends.append(id) }
        }
        driver.operations[0].succeed([:], blobs: [DeviceBlob(contentType: "image/png", bytes: Data([1]))])
        clock.drainTurns()
        driver.operations[1].fail(.denied)
        host.handleMessage(r2control(id: 4, #"{"cancel":true}"#))
        XCTAssertEqual(ends, [2, 3, 4])
        driver.operations[0].onEnd { ends.append(99) }
        XCTAssertEqual(ends.last, 99, "registration after the end runs immediately")
    }

    // MARK: #8 — picker selection frees the gate and survives backgrounding

    func testPickerSelectionReleasesTheGateAndExemptsLoadingFromSuspension() async {
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker), HoldDriver("permission.request")])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        XCTAssertTrue(host.promptGate.isBusy)
        picker.selected?()
        XCTAssertFalse(host.promptGate.isBusy, "the picker UI is gone: another prompt may run while items load")
        host.suspend()
        XCTAssertTrue(responses().isEmpty, "a made choice is not discarded by backgrounding")
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: Data([1, 2]))]))
        clock.drainTurns()
        XCTAssertNotNil(responses().last?["result"])
        XCTAssertEqual(picker.handle?.cancelled, false)
    }

    func testCancelDuringItemLoadingCancelsThePickerHandle() async {
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker)])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        picker.selected?()
        host.handleMessage(r2control(id: 2, #"{"cancel":true}"#))
        XCTAssertEqual(picker.handle?.cancelled, true, "the handle cancels in-flight loading (PHPicker Progress)")
        XCTAssertEqual(code(responses().last), "cancelled")
    }

    // MARK: #9 — a failed presentation releases the gate at once

    func testConsentPresentationFailureIsUnavailableWithoutCooldown() async {
        let presenter = FakePresenter()
        let authority = FakeAuthority()
        let host = liveHost([PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(r2request(id: 2, capability: "permission.request"))
        XCTAssertTrue(host.promptGate.isBusy)
        presenter.outcome?(.unavailable)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(responses().last?["error"]?["platformDetail"]?.stringValue, "presentation-failed")
        XCTAssertFalse(host.promptGate.isBusy)
        host.handleMessage(r2request(id: 3, capability: "permission.request"))
        XCTAssertEqual(presenter.presented.count, 2, "no cooldown: nothing was refused")
    }

    func testPickerPresentationFailureIsUnavailable() async {
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker)])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1))
        picker.completion?(.presentationFailed)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: #10 — no raw OS error text in platformDetail

    func testLoadFailureTokenNeverCarriesErrorText() async {
        let error = NSError(domain: "NSItemProviderErrorDomain", code: -1000, userInfo: [
            NSLocalizedDescriptionKey: "Cannot load /private/var/mobile/Containers/Data/Application/1234-ABCD/tmp/secret.mov",
            NSFilePathErrorKey: "/private/var/mobile/Containers/Data/Application/1234-ABCD/tmp/secret.mov",
        ])
        let token = DeviceDiagnostics.loadFailureToken(error)
        XCTAssertEqual(token, "load-failed:NSItemProviderErrorDomain:-1000")
        XCTAssertFalse(token.contains("/private"))
        XCTAssertEqual(DeviceDiagnostics.loadFailureToken(nil), "load-failed")
        let hostile = NSError(domain: "a/b c\n\u{202E}d", code: 7)
        XCTAssertEqual(DeviceDiagnostics.loadFailureToken(hostile), "load-failed:abcd:7")
    }

    // MARK: #11 — the ack is validated against the advertisement

    func testAckValidationAgainstTheAdvertisement() async {
        let offered = DeviceHello(protocolVersions: [1], binary: true, capabilities: [
            CapabilityOffer(name: "core.capabilities", versions: [1]),
            CapabilityOffer(name: "gallery.pick", versions: [1]),
            CapabilityOffer(name: "permission.query", versions: [1]),
        ])
        let core = CapabilitySelection(name: "core.capabilities", version: 1)
        let gallery = CapabilitySelection(name: "gallery.pick", version: 1)
        let query = CapabilitySelection(name: "permission.query", version: 1)
        // binary:false: the binary-plane selection is dropped, never enabled.
        XCTAssertEqual(DeviceHost.acceptSelection(DeviceAck(protocolVersion: 1, binary: false, capabilities: [core, gallery, query]),
                                                  advertisement: offered)?.capabilities, [core, query])
        // Unoffered names / revisions are dropped.
        XCTAssertEqual(DeviceHost.acceptSelection(DeviceAck(protocolVersion: 1, binary: true, capabilities: [
            core, CapabilitySelection(name: "bluetooth.scan", version: 1), CapabilitySelection(name: "gallery.pick", version: 2),
        ]), advertisement: offered)?.capabilities, [core])
        // No core.capabilities@1, or no common protocol: disabled.
        XCTAssertNil(DeviceHost.acceptSelection(DeviceAck(protocolVersion: 1, binary: true, capabilities: [gallery]), advertisement: offered))
        XCTAssertNil(DeviceHost.acceptSelection(DeviceAck(protocolVersion: 2, binary: true, capabilities: [core]), advertisement: offered))
        XCTAssertNil(DeviceHost.acceptSelection(DeviceAck(protocolVersion: 1, binary: true, capabilities: [core, gallery, gallery]),
                                                advertisement: offered))
    }

    func testRefusedAckDisablesTheSocketAndLaterAcksCannotChangeIt() async {
        let picker = FakePicker()
        let host = DeviceHost(origin: "wss://app.example.com", drivers: [GalleryPickDriver(picker: picker)], clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host.attach(transport)
        host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: [CapabilitySelection(name: "gallery.pick", version: 1)]))
        XCTAssertNil(host.selected, "no core.capabilities@1: device plane off")
        host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: host.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1) }))
        XCTAssertNil(host.selected, "the handshake is immutable once processed")
        host.handleMessage(coreRequest(id: 1))
        XCTAssertTrue(transport.sent.isEmpty)
    }

    func testBinaryFalseAckRefusesUploadRequestsAsUnsupported() async {
        let picker = FakePicker()
        let host = DeviceHost(origin: "wss://app.example.com", drivers: [GalleryPickDriver(picker: picker)], clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host.attach(transport)
        host.onAck(DeviceAck(protocolVersion: 1, binary: false, capabilities: host.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1) }))
        XCTAssertEqual(host.selected?.capabilities.map { $0.name }, ["core.capabilities"])
        host.handleMessage(coreRequest(id: 1))
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1, initialCredit: 1024))
        XCTAssertEqual(code(responses().last), "unsupported", "binary frames are never sent on a JSON-only connection")
        XCTAssertEqual(picker.presentCount, 0)
    }

    /// D6 (and the Android reviewer's late-hello finding): a device-less ack
    /// does not latch; the first ack carrying `device` selects.
    func testDevicelessAckThenReAckWithDeviceIsAccepted() async {
        let host = DeviceHost(origin: "wss://app.example.com", drivers: [], clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host.attach(transport)
        host.onAck(nil)
        XCTAssertNil(host.selected)
        host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: [CapabilitySelection(name: "core.capabilities", version: 1)]))
        XCTAssertNotNil(host.selected)
        host.handleMessage(coreRequest(id: 1))
        host.handleMessage(r2control(id: 1, #"{"renewLease":1}"#))
        XCTAssertEqual(transport.messages.first?["event"]?["capabilities"]?.arrayValue?.count, 1)
        XCTAssertEqual(transport.messages.last?["control"]?["leaseAck"]?.int64Value, 1)
    }

    // MARK: #12 / D8 — a server deviceResponse on a live id

    func testServerDeviceResponseOnLiveIdIsInvalidParams() async {
        let driver = HoldDriver("permission.query")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(r2json(#"{"type":"deviceResponse","id":2,"result":{"status":"granted"}}"#))
        XCTAssertEqual(responses().map { code($0) }, ["invalidParams"])
        XCTAssertEqual(driver.cancelCount, 1)
        // Unknown / retired ids: ignored whatever the direction or validity.
        host.handleMessage(r2json(#"{"type":"deviceResponse","id":2,"result":{"status":"granted"}}"#))
        host.handleMessage(r2json(#"{"type":"deviceResponse","id":9,"result":5}"#))
        XCTAssertEqual(responses().count, 1)
        // A malformed server response on a live id is still a known-id violation.
        host.handleMessage(r2request(id: 3, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(r2json(#"{"type":"deviceResponse","id":3,"result":5}"#))
        XCTAssertEqual(responses().map { code($0) }, ["invalidParams", "invalidParams"])
    }

    // MARK: Connection model (§2.2) and owners (§2.7)

    func testAppRequestBeforeCoreStreamClosesTheConnection() async {
        let driver = HoldDriver("permission.query")
        let host = DeviceHost(origin: "wss://app.example.com", drivers: [driver], clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host.attach(transport)
        host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: host.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1) }))
        host.handleMessage(r2request(id: 1, capability: "permission.query", timeoutMs: 30_000))
        XCTAssertEqual(transport.closed.map { $0.code }, [1002])
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertTrue(driver.operations.isEmpty)
    }

    func testSecondLiveCoreStreamClosesButAPlannedReopenDoesNot() async {
        let host = liveHost([HoldDriver("permission.query")])
        host.handleMessage(r2control(id: 1, #"{"cancel":true}"#)) // planned reopen: retire first
        host.handleMessage(coreRequest(id: 2))
        XCTAssertTrue(transport.closed.isEmpty)
        XCTAssertEqual(transport.messages.filter { $0["event"]?["capabilities"] != nil }.count, 1)
        host.handleMessage(coreRequest(id: 3))
        XCTAssertEqual(transport.closed.map { $0.code }, [1002])
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    func testSnapshotsDriveTheLiveSelection() async {
        let picker = FakePicker()
        let host = liveHost([GalleryPickDriver(picker: picker), HoldDriver("permission.query")])
        host.setAvailable("gallery.pick", false)
        let snapshot = transport.messages.last?["event"]?["capabilities"]?.arrayValue?.compactMap { $0["name"]?.stringValue }
        XCTAssertEqual(snapshot, ["core.capabilities", "permission.query"])
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1))
        XCTAssertEqual(code(responses().last), "unsupported")
        host.setAvailable("gallery.pick", true)
        host.handleMessage(r2request(id: 3, capability: "gallery.pick", params: galleryParams1))
        XCTAssertEqual(picker.presentCount, 1, "re-added by the next snapshot")
    }

    func testActivationIdsNeverGoBackwards() async {
        let driver = HoldDriver("permission.query")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "permission.query", timeoutMs: 30_000,
                                     owner: #"{"moduleInstanceId":"editor-1","activationId":2}"#))
        host.handleMessage(r2control(id: 2, #"{"cancel":true}"#))
        host.handleMessage(r2request(id: 3, capability: "permission.query", timeoutMs: 30_000,
                                     owner: #"{"moduleInstanceId":"editor-1","activationId":1}"#))
        XCTAssertEqual(responses().map { code($0) }, ["cancelled", "invalidParams"])
        host.handleMessage(r2request(id: 4, capability: "permission.query", timeoutMs: 30_000,
                                     owner: #"{"moduleInstanceId":"editor-2","activationId":1}"#))
        XCTAssertEqual(driver.operations.count, 2, "another module instance has its own sequence")
    }

    // MARK: Progress and outbound payload validation

    func testProgressIsCreditFreeAndNeverGoesBack() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "bluetooth.scan", params: "{}", timeoutMs: 600_000, initialCredit: 0))
        let op = driver.operations[0]
        op.progress(.pendingConsent)
        op.progress(.running)
        op.progress(.running)
        op.progress(.pendingConsent)
        XCTAssertEqual(transport.messages.compactMap { $0["event"]?["state"]?.stringValue },
                       ["pendingConsent", "running", "running"])
    }

    func testInvalidDriverEventOrResultBecomesInternal() async {
        let driver = HoldDriver("bluetooth.scan")
        let query = HoldDriver("permission.query")
        let host = liveHost([driver, query])
        host.handleMessage(r2request(id: 2, capability: "bluetooth.scan", params: "{}", timeoutMs: 600_000, initialCredit: 8))
        driver.operations[0].emit(["n": .int(1)])
        XCTAssertEqual(code(responses().last), "internal")
        XCTAssertNil(transport.messages.first { $0["event"]?["n"] != nil }, "never an invalid message on the wire")
        host.handleMessage(r2request(id: 3, capability: "permission.query", timeoutMs: 30_000))
        query.operations[0].succeed(["status": .string("maybe")])
        XCTAssertEqual(code(responses().last), "internal")
    }

    // MARK: Downloads (file.save)

    private let fileSaveParams = #"{"channel":0,"name":"report.txt","contentType":"text/plain","bytes":11,"sha256":"835218591566a3364d9258fcbf2074d19415dacc756ad7fb707119069f07e1e5"}"#

    func testDownloadIsVerifiedBeforeSuccess() async {
        let driver = HoldDriver("file.save")
        let host = liveHost([driver])
        host.handleMessage(r2request(id: 2, capability: "file.save", params: fileSaveParams))
        let op = driver.operations[0]
        var received = Data()
        var complete = false
        op.onDownloadChunk { received.append($0) }
        op.onDownloadComplete { complete = true }
        XCTAssertEqual(op.grantDownload(65_536), 65_536)
        XCTAssertEqual(transport.messages.last?["control"]?["grant"]?.int64Value, 65_536)
        op.succeed(["bytesWritten": .int(11)])
        XCTAssertEqual(code(responses().last), "internal", "success before verified bytes is refused")

        host.handleMessage(r2request(id: 3, capability: "file.save", params: fileSaveParams))
        let op2 = driver.operations[1]
        op2.onDownloadChunk { received.append($0) }
        op2.onDownloadComplete { complete = true }
        op2.grantDownload(64)
        let hello = Data("hypen-saved".utf8)
        host.handleFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 3, seq: 0), payload: hello.prefix(5)))
        XCTAssertFalse(complete)
        host.handleFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 3, seq: 1), payload: hello.dropFirst(5)))
        XCTAssertTrue(complete)
        XCTAssertEqual(received, hello)
        op2.succeed(["bytesWritten": .int(11)])
        XCTAssertEqual(responses().last?["result"]?["bytesWritten"]?.int64Value, 11)
    }

    func testDownloadViolationsAreInvalidParams() async {
        let driver = HoldDriver("file.save")
        let host = liveHost([driver])
        func start(_ id: UInt32, grant: UInt64 = 64) {
            host.handleMessage(r2request(id: id, capability: "file.save", params: fileSaveParams))
            driver.operations.last!.grantDownload(grant)
        }
        func frame(_ id: UInt32, seq: UInt32 = 0, channel: UInt16 = 0, _ payload: Data) {
            host.handleFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: channel, requestId: id, seq: seq), payload: payload))
        }
        start(2); frame(2, Data())                                   // empty frame
        start(3); frame(3, seq: 1, Data([1]))                        // seq gap
        start(4); frame(4, channel: 1, Data([1]))                    // unannounced channel
        start(5, grant: 3); frame(5, Data("hello".utf8))              // beyond credit
        start(6); frame(6, Data(repeating: 0x61, count: 12))          // beyond declaration
        start(7); frame(7, Data("hypen-SAVED".utf8))                 // sha256 mismatch
        start(8); host.handleMessage(r2control(id: 8, #"{"grant":64}"#)) // grant from the sender
        XCTAssertEqual(responses().map { code($0) }, Array(repeating: "invalidParams", count: 7))
        XCTAssertEqual(responses().map { $0["id"]?.int64Value }, [2, 3, 4, 5, 6, 7, 8])
    }

    // MARK: Terminal uniqueness (review probe)

    func testDeadlineDuringUploadSendsExactlyOneTerminal() async {
        transport.autoComplete = false
        let driver = HoldDriver("gallery.pick")
        let host = liveHost([driver], options: DeviceHost.Options(leaseExpiry: 10_000))
        host.handleMessage(r2request(id: 2, capability: "gallery.pick", params: galleryParams1,
                                     timeoutMs: 1_000, initialCredit: 4 * 1024 * 1024))
        driver.operations[0].succeed([:], blobs: [DeviceBlob(contentType: "video/mp4", bytes: Data(count: 1024 * 1024))])
        clock.drainTurns()
        clock.advance(by: 2)
        while !transport.pendingCompletions.isEmpty { transport.completeOne(); clock.drainTurns() }
        host.handleMessage(r2control(id: 2, #"{"cancel":true}"#))
        let terminals = responses()
        XCTAssertEqual(terminals.count, 1)
        XCTAssertEqual(code(terminals.first), "timeout")
    }

    // MARK: #13 — deadline across device sleep

    func testSystemClockFiresOnTheMonotonicDeadlineAcrossSleep() async throws {
        final class Now: @unchecked Sendable {
            private let lock = NSLock()
            private var value: TimeInterval = 1_000
            func get() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
            func add(_ d: TimeInterval) { lock.lock(); value += d; lock.unlock() }
        }
        let now = Now()
        let clock = SystemDeviceClock(pollInterval: 0.01, timeSource: { now.get() })
        var fired = false
        let timer = clock.schedule(after: 50) { fired = true }
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertFalse(fired, "50 s of monotonic time have not passed")
        now.add(3_600) // the device slept for an hour: uptime timers would not have advanced
        for _ in 0..<100 where !fired { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(fired, "fires within one poll slice of the monotonic deadline")
        timer.cancel()

        var cancelledFired = false
        let cancelled = clock.schedule(after: 0.02) { cancelledFired = true }
        cancelled.cancel()
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertFalse(cancelledFired)
    }

    func testHostDeadlineIsMeasuredOnTheMonotonicClock() async {
        let driver = HoldDriver("permission.request")
        let host = liveHost([driver], options: DeviceHost.Options(maxTimeout: 600, leaseExpiry: 10_000))
        host.handleMessage(r2request(id: 2, capability: "permission.request", timeoutMs: 60_000))
        // Timers stalled (suspended app) while monotonic time moved past the deadline:
        clock.monotonicNow += 120
        clock.advance(by: 0)
        XCTAssertEqual(code(responses().last), "timeout", "the next timer check sees the expired deadline")
    }

    func testIncrementalHashMatchesOneShot() async {
        let data = Data((0..<200_003).map { UInt8(($0 * 7) % 256) })
        var hasher = DeviceHasher()
        var offset = 0
        for size in [1, 63, 64, 65, 1000, 65_536] where offset < data.count {
            let end = min(data.count, offset + size)
            hasher.update(data[offset..<end])
            offset = end
        }
        hasher.update(data[offset...])
        XCTAssertEqual(hasher.finalize(), DeviceHash.sha256Hex(data))
        XCTAssertEqual(DeviceHasher().finalize(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }
}

// MARK: - RemoteEngine seams (#2/D1, #3, #13)

final class RemoteEngineSeamTests: XCTestCase {
    func testUpgradeRequestCarriesAuthHeadersAndNoOriginByDefault() {
        let url = URL(string: "wss://app.example.com/ws")!
        let config = RemoteEngineConfig(upgradeHeaders: ["Authorization": "Bearer static", "X-App": "1",
                                                         "Sec-WebSocket-Extensions": "x", "Host": "evil", "Origin": "https://evil",
                                                         "X-Split": "a\r\nInjected: 1"],
                                        upgradeHeaderProvider: { _ in ["Authorization": "Bearer fresh"] })
        let request = RemoteUpgradeRequest.make(url: url, config: config)
        XCTAssertEqual(request.url, url)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fresh", "the provider wins")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-App"), "1")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"), "native clients send no Origin by default (D1)")
        XCTAssertNil(request.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Split"), "no header splitting")
        XCTAssertNotEqual(request.value(forHTTPHeaderField: "Host"), "evil")

        let withOrigin = RemoteUpgradeRequest.make(url: url, config: RemoteEngineConfig(origin: "https://app.example.com"))
        XCTAssertEqual(withOrigin.value(forHTTPHeaderField: "Origin"), "https://app.example.com")
        XCTAssertEqual(RemoteUpgradeRequest.origin(of: URL(string: "wss://App.Example.com:443/ws?x=1")!), "wss://app.example.com")
    }

    func testConnectionLifecycleIgnoresStaleSocketsAndReconnectsOnce() {
        var life = RemoteConnectionLifecycle()
        guard let first = life.connect() else { return XCTFail("connect") }
        XCTAssertNil(life.connect(), "connect() while connecting is a no-op")
        XCTAssertTrue(life.opened(first))
        XCTAssertNil(life.connect(), "connect() while open is a no-op")
        // A server close: the failed receive and didClose both report it.
        XCTAssertEqual(life.ended(first, autoReconnect: true, maxAttempts: 10), .reconnect(attempt: 1))
        XCTAssertEqual(life.ended(first, autoReconnect: true, maxAttempts: 10), .ignore, "one reconnect per socket")
        XCTAssertNil(life.connect(), "connect() while a reconnect is scheduled is a no-op")
        guard let second = life.reconnectFired() else { return XCTFail("reconnect") }
        XCTAssertNil(life.reconnectFired(), "a second timer cannot establish again")
        XCTAssertFalse(life.opened(first), "a stale socket's open neither attaches nor sends hello")
        XCTAssertEqual(life.ended(first, autoReconnect: true, maxAttempts: 10), .ignore, "a stale close never tears down the live socket")
        XCTAssertFalse(life.isCurrent(first))
        XCTAssertTrue(life.isCurrent(second))
        XCTAssertTrue(life.opened(second))
        XCTAssertEqual(life.attempts, 0, "an open resets the backoff")

        life.disconnect()
        XCTAssertFalse(life.isCurrent(second))
        XCTAssertEqual(life.ended(second, autoReconnect: true, maxAttempts: 10), .ignore)
        XCTAssertNil(life.reconnectFired())
        XCTAssertNotNil(life.connect())
    }

    func testConnectionLifecycleStopsAfterMaxAttempts() {
        var life = RemoteConnectionLifecycle()
        var generation = life.connect()!
        for attempt in 1...2 {
            XCTAssertEqual(life.ended(generation, autoReconnect: true, maxAttempts: 2), .reconnect(attempt: attempt))
            generation = life.reconnectFired()!
        }
        XCTAssertEqual(life.ended(generation, autoReconnect: true, maxAttempts: 2), .stop)
        XCTAssertEqual(life.phase, .idle)
        let noAuto = { () -> RemoteConnectionLifecycle.EndDecision in
            var l = RemoteConnectionLifecycle()
            let g = l.connect()!
            return l.ended(g, autoReconnect: false, maxAttempts: 0)
        }()
        XCTAssertEqual(noAuto, .stop)
    }

    func testTaskDescriptionCarriesTheGeneration() {
        XCTAssertEqual(RemoteConnectionLifecycle.generation(fromTaskDescription:
            RemoteConnectionLifecycle.taskDescription(42)), 42)
        XCTAssertNil(RemoteConnectionLifecycle.generation(fromTaskDescription: nil))
        XCTAssertNil(RemoteConnectionLifecycle.generation(fromTaskDescription: "other-1"))
    }

    func testResumeTokenIsHiddenFromReflectionAndLogs() {
        var credential = RemoteResumeCredential()
        credential.acknowledge(sessionId: "s", resumeToken: "SeCrEt-Token_1")
        var dumped = ""
        dump(credential, to: &dumped)
        XCTAssertFalse(dumped.contains("SeCrEt"))
        XCTAssertFalse(Mirror(reflecting: credential).children.contains { "\($0.value)".contains("SeCrEt") })
        XCTAssertFalse(String(reflecting: credential).contains("SeCrEt"))
        XCTAssertEqual(credential.token(resuming: "s"), "SeCrEt-Token_1", "still usable")
        let logged = RemoteLogRedaction.unparseable(byteCount: 120)
        XCTAssertEqual(logged, "Failed to parse server message (120 bytes)")
    }
}
