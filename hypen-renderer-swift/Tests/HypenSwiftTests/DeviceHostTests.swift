import XCTest
@testable import HypenSwift

// Device Capability Protocol — native DeviceHost core (RFC 001).
//
// Deterministic: a manual clock drives leases/deadlines/scheduling turns, a
// recording transport captures the wire, and fakes stand in for PHPicker,
// the consent alert, OS permissions and CoreBluetooth.
//
// Test methods are `async` so the `@MainActor` test class runs under Linux
// XCTest as well as on Darwin (synchronous main-actor test methods do not
// compile against swift-corelibs-xctest).

// MARK: - Test doubles

@MainActor
final class ManualDeviceClock: DeviceClock {
    var monotonicNow: TimeInterval = 1_000
    var wallNow = Date(timeIntervalSince1970: 1_700_000_000)

    final class Timer: DeviceCancellable {
        let at: TimeInterval
        let fire: @Sendable @MainActor () -> Void
        var cancelled = false
        init(at: TimeInterval, fire: @escaping @Sendable @MainActor () -> Void) {
            self.at = at
            self.fire = fire
        }
        func cancel() { cancelled = true }
    }

    private var timers: [Timer] = []
    private var turns: [@Sendable @MainActor () -> Void] = []

    func schedule(after delay: TimeInterval, _ fire: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable {
        let timer = Timer(at: monotonicNow + delay, fire: fire)
        timers.append(timer)
        return timer
    }

    func enqueueTurn(_ work: @escaping @Sendable @MainActor () -> Void) {
        turns.append(work)
    }

    /// Advance both clocks, firing due timers in order.
    func advance(by delta: TimeInterval) {
        let target = monotonicNow + delta
        wallNow = wallNow.addingTimeInterval(delta)
        while true {
            timers.removeAll { $0.cancelled }
            guard let next = timers.filter({ $0.at <= target }).min(by: { $0.at < $1.at }) else { break }
            timers.removeAll { $0 === next }
            monotonicNow = next.at
            next.fire()
        }
        monotonicNow = target
    }

    /// Run queued scheduling turns until quiescent.
    func drainTurns() {
        var budget = 100_000
        while !turns.isEmpty, budget > 0 {
            budget -= 1
            turns.removeFirst()()
        }
    }
}

@MainActor
final class RecordingTransport: DeviceTransport {
    enum Sent {
        case message(DeviceJSON)
        case frame(Data)
    }

    var sent: [Sent] = []
    var autoComplete = true
    var pendingCompletions: [@Sendable @MainActor () -> Void] = []
    /// `closeDeviceConnection` calls (code, reason).
    var closed: [(code: Int, reason: String)] = []
    /// Reported as the socket origin when set.
    var origin: String?
    var socketOrigin: String? { origin }

    func closeDeviceConnection(code: Int, reason: String) {
        closed.append((code, reason))
    }

    var messages: [DeviceJSON] {
        sent.compactMap { if case let .message(m) = $0 { return m } else { return nil } }
    }

    var frames: [Data] {
        sent.compactMap { if case let .frame(f) = $0 { return f } else { return nil } }
    }

    /// Every message the host sends must itself pass the device JSON limits.
    func sendDeviceMessage(_ json: Data) {
        sent.append(.message(try! DeviceStrictJSON.parse(json)))
    }

    func sendDeviceBinary(_ frame: Data, completion: @escaping @Sendable @MainActor () -> Void) {
        sent.append(.frame(frame))
        if autoComplete { completion() } else { pendingCompletions.append(completion) }
    }

    func completeOne() {
        guard !pendingCompletions.isEmpty else { return }
        pendingCompletions.removeFirst()()
    }

    func clear() { sent.removeAll() }
}

/// A driver that holds every operation until the test finishes it.
@MainActor
final class HoldDriver: DeviceDriver {
    let capability: String
    var operations: [DeviceOperation] = []
    var cancelCount = 0

    init(_ capability: String) { self.capability = capability }

    func start(_ operation: DeviceOperation) {
        operations.append(operation)
        operation.onCancel { [weak self] in self?.cancelCount += 1 }
    }
}

@MainActor
final class FakeHandle: DeviceCancellable {
    var cancelled = false
    func cancel() { cancelled = true }
}

@MainActor
final class FakePicker: GalleryPicker {
    var available = true
    var completion: (@Sendable @MainActor (GalleryPickOutcome) -> Void)?
    var handle: FakeHandle?
    var presentCount = 0
    var lastMaxCount = 0
    var lastMaxItemBytes: UInt64 = 0
    /// The picker's "user chose, items loading" signal.
    var selected: (@Sendable @MainActor () -> Void)?

    func presentPicker(mediaTypes: Set<String>, maxCount: Int, maxItemBytes: UInt64,
                       selected: @escaping @Sendable @MainActor () -> Void,
                       completion: @escaping @Sendable @MainActor (GalleryPickOutcome) -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        presentCount += 1
        lastMaxCount = maxCount
        lastMaxItemBytes = maxItemBytes
        self.selected = selected
        self.completion = completion
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakePresenter: DeviceConsentPresenter {
    var available = true
    var outcome: (@Sendable @MainActor (DeviceConsentOutcome) -> Void)?
    var presented: [(origin: String, operation: String)] = []
    var handle: FakeHandle?

    /// Continue (`true`) or Cancel (`false`).
    var completion: (@MainActor (Bool) -> Void)? {
        guard let outcome = outcome else { return nil }
        return { outcome($0 ? .accepted : .declined) }
    }

    func presentConsent(origin: String, operation: String,
                        completion: @escaping @Sendable @MainActor (DeviceConsentOutcome) -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        presented.append((origin, operation))
        self.outcome = completion
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakeAuthority: DevicePermissionAuthority {
    var statuses: [DevicePermission: DevicePermissionStatus] = [:]
    var requestResult: DevicePermissionStatus = .granted
    var requested: [DevicePermission] = []
    var missing: [DevicePermission: String] = [:]
    /// Hold OS prompts open until the test resolves them.
    var deferRequests = false
    var pendingRequest: (@Sendable @MainActor (DevicePermissionStatus) -> Void)?

    func status(of permission: DevicePermission,
                completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        completion(statuses[permission] ?? .prompt)
    }

    func request(_ permission: DevicePermission,
                 completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        requested.append(permission)
        if deferRequests {
            pendingRequest = completion
        } else {
            completion(requestResult)
        }
    }

    func missingUsageDescription(for permission: DevicePermission) -> String? { missing[permission] }
}

@MainActor
final class FakeScanner: BluetoothScanner {
    var handler: (@Sendable @MainActor (BluetoothScanUpdate) -> Void)?
    var stopped = false
    func start(_ handler: @escaping @Sendable @MainActor (BluetoothScanUpdate) -> Void) { self.handler = handler }
    func stop() { stopped = true }
}

@MainActor
final class FakeIndicator: DeviceActivityIndicator {
    /// Whether the indicator can be shown; a change is reported to
    /// readiness observers.
    var available = true {
        didSet {
            guard available != oldValue else { return }
            for (handle, changed) in readinessObservers where !handle.cancelled { changed() }
        }
    }
    var shown: [(origin: String, activity: String)] = []
    var stop: (@Sendable @MainActor () -> Void)?
    var handle: FakeHandle?
    private var readinessObservers: [(FakeHandle, @Sendable @MainActor () -> Void)] = []

    var isReady: Bool { available }

    func observeReadiness(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable {
        let h = FakeHandle()
        readinessObservers.append((h, changed))
        return h
    }

    func showIndicator(origin: String, activity: String,
                       stop: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        shown.append((origin, activity))
        self.stop = stop
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakeScannerFactory: BluetoothScannerFactory {
    var authorization: DevicePermissionStatus = .granted
    var missingUsageDescription: String?
    var scanners: [FakeScanner] = []
    /// Service filters requested through `makeScanner(services:)`.
    var filters: [[String]] = []
    func makeScanner() -> BluetoothScanner {
        let s = FakeScanner()
        scanners.append(s)
        return s
    }
    /// Deliberately ignores the filter (a widening backend): drivers must
    /// not rely on it.
    func makeScanner(services: [String]) -> BluetoothScanner {
        filters.append(services)
        return makeScanner()
    }
}

// MARK: - Helpers

@MainActor
private func json(_ text: String) -> Data { Data(text.utf8) }

/// Valid default params per capability (the host validates params against
/// the revision schema before any driver runs).
private func defaultParams(_ capability: String) -> String {
    switch capability {
    case "permission.query", "permission.request": return #"{"permission":"camera"}"#
    case "gallery.pick": return #"{"mediaTypes":["photo"],"maxCount":1}"#
    case "file.pick": return #"{"accept":[],"maxCount":1}"#
    case "mic.record": return #"{"sampleRate":16000,"format":"pcm16"}"#
    default: return "{}"
    }
}

@MainActor
private func requestJSON(id: UInt32, capability: String, version: UInt32 = 1,
                         params: String? = nil, timeoutMs: UInt64 = 300_000,
                         initialCredit: UInt64 = 0,
                         owner: String = #"{"moduleInstanceId":"m-1","activationId":1}"#,
                         lifetime: String = "activation") -> Data {
    let params = params ?? defaultParams(capability)
    return json(#"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":\#(version),"owner":\#(owner),"lifetime":"\#(lifetime)","timeoutMs":\#(timeoutMs),"initialCredit":\#(initialCredit),"params":\#(params)}"#)
}

@MainActor
private func controlJSON(id: UInt32, _ control: String) -> Data {
    json(#"{"type":"deviceEvent","id":\#(id),"control":\#(control)}"#)
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

private func bytes(fromHex hex: String) -> Data {
    var out = Data()
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        out.append(UInt8(hex[index..<next], radix: 16)!)
        index = next
    }
    return out
}

// MARK: - Frame codec

final class DeviceFrameCodecTests: XCTestCase {
    /// Golden bytes from engine-compatibility-tests/fixtures/device/frames.json.
    func testGoldenFixtureFrames() async {
        let cases: [(DeviceFrameHeader, String, String)] = [
            (DeviceFrameHeader(channel: 0, requestId: 1, seq: 0), "010000000100000000000000", ""),
            (DeviceFrameHeader(channel: 3, requestId: 17, seq: 2), "010003001100000002000000", ""),
            (DeviceFrameHeader(channel: 65535, requestId: 4_294_967_295, seq: 4_294_967_295),
             "0100ffffffffffffffffffff", ""),
            (DeviceFrameHeader(channel: 0, requestId: 1, seq: 0),
             "01000000010000000000000068656c6c6f2d687970656e2d70686f746f",
             "68656c6c6f2d687970656e2d70686f746f"),
        ]
        for (header, expected, payloadHex) in cases {
            let payload = bytes(fromHex: payloadHex)
            let encoded = DeviceFrameCodec.encode(header, payload: payload)
            XCTAssertEqual(hex(encoded), expected)
            guard case let .success(decoded) = DeviceFrameCodec.decode(encoded) else {
                return XCTFail("decode failed for \(expected)")
            }
            XCTAssertEqual(decoded.header, header)
            XCTAssertEqual(decoded.payload, payload)
        }
    }

    /// Hand-computed 12-byte little-endian layout with distinct byte values.
    func testHandComputedLittleEndianLayout() async {
        let header = DeviceFrameHeader(channel: 0x0201, requestId: 0x0605_0403, seq: 0x0A09_0807)
        // [01][00][01 02][03 04 05 06][07 08 09 0a]
        XCTAssertEqual(hex(DeviceFrameCodec.encodeHeader(header)), "01000102030405060708090a")
        XCTAssertEqual(DeviceFrameCodec.encodeHeader(header).count, 12)
    }

    func testInvalidFrames() async {
        XCTAssertEqual(DeviceFrameCodec.decode(bytes(fromHex: "0100000001000000000000")).failure, .shortHeader)
        XCTAssertEqual(DeviceFrameCodec.decode(bytes(fromHex: "090000000100000000000000")).failure, .violation("version 9"))
        XCTAssertEqual(DeviceFrameCodec.decode(bytes(fromHex: "010100000100000000000000")).failure, .violation("flags 1"))
    }

    func testDecodesSlicesWithNonZeroStartIndex() async {
        let frame = DeviceFrameCodec.encode(DeviceFrameHeader(channel: 3, requestId: 17, seq: 2), payload: Data([0xAB]))
        let padded = Data([0xFF, 0xFF]) + frame
        let slice = padded[2...]
        XCTAssertNotEqual(slice.startIndex, 0)
        guard case let .success(decoded) = DeviceFrameCodec.decode(slice) else { return XCTFail("decode") }
        XCTAssertEqual(decoded.header.requestId, 17)
        XCTAssertEqual(decoded.header.seq, 2)
        XCTAssertEqual(decoded.payload, Data([0xAB]))
    }
}

private extension Result {
    var failure: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}

// MARK: - Host protocol core

/// `@unchecked Sendable`: XCTest (Linux test discovery) hands the instance
/// to the main actor to run each async test; all state is main-actor bound.
@MainActor
final class DeviceHostTests: XCTestCase, @unchecked Sendable {
    var clock: ManualDeviceClock!
    var transport: RecordingTransport!

    override func setUp() async throws {
        clock = ManualDeviceClock()
        transport = RecordingTransport()
    }

    /// Build a host, attach it, and ack every advertised capability at v1.
    private func makeHost(_ drivers: [DeviceDriver],
                          options: DeviceHost.Options = DeviceHost.Options(),
                          origin: String = "wss://app.example.com",
                          ackExtra: [CapabilitySelection] = []) -> DeviceHost {
        let host = DeviceHost(origin: origin, drivers: drivers, options: options, clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        // Single-behaviour tests address requests without the
        // core.capabilities prelude (the connection model is covered by the
        // connection-model tests and the shared transcripts).
        host.requiresCoreStreamFirst = false
        host.attach(transport)
        host.onAck(DeviceAck(
            protocolVersion: 1, binary: true,
            capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) } + ackExtra))
        return host
    }

    private func responses() -> [DeviceJSON] {
        transport.messages.filter { $0["type"]?.stringValue == "deviceResponse" }
    }

    private func errorCode(_ message: DeviceJSON?) -> String? {
        message?["error"]?["code"]?.stringValue
    }

    // MARK: Handshake

    func testAdvertisementIncludesCoreCapabilitiesFirst() async throws {
        let host = DeviceHost(origin: "wss://a.example", drivers: [HoldDriver("gallery.pick"), HoldDriver("permission.query"),
                                                                    HoldDriver("not.in.registry")],
                              clock: clock, persistentStore: InMemoryDeviceStore())
        XCTAssertEqual(host.advertisement.protocolVersions, [1])
        XCTAssertTrue(host.advertisement.binary)
        XCTAssertEqual(host.advertisement.capabilities.map { $0.name },
                       ["core.capabilities", "gallery.pick", "permission.query"])
        let encoded = try DeviceWire.encode(host.advertisement)
        let decoded = try JSONDecoder().decode(DeviceHello.self, from: encoded)
        XCTAssertEqual(decoded, host.advertisement)
    }

    func testNoDeviceTrafficBeforeAck() async {
        let driver = HoldDriver("permission.query")
        let host = DeviceHost(origin: "wss://a.example", drivers: [driver], clock: clock,
                              persistentStore: InMemoryDeviceStore())
        host.attach(transport)
        host.handleMessage(requestJSON(id: 1, capability: "permission.query", params: #"{"permission":"camera"}"#))
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertTrue(driver.operations.isEmpty)

        host.onAck(nil) // device extension absent: stays disabled
        host.handleMessage(requestJSON(id: 2, capability: "permission.query"))
        XCTAssertTrue(transport.sent.isEmpty)
    }

    // MARK: Unsupported / invalid

    func testUnsupportedCapabilityOrRevision() async {
        let driver = HoldDriver("gallery.pick")
        // Server selected bluetooth.scan, but this host has no driver for it.
        let host = makeHost([driver], ackExtra: [CapabilitySelection(name: "bluetooth.scan", version: 1)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan"))
        host.handleMessage(requestJSON(id: 2, capability: "gallery.pick", version: 2,
                                       params: #"{"mediaTypes":["photo"],"maxCount":1}"#))
        host.handleMessage(requestJSON(id: 3, capability: "mic.record"))
        let codes = responses().map { errorCode($0) }
        XCTAssertEqual(codes, ["unsupported", "unsupported", "unsupported"])
        XCTAssertEqual(responses().compactMap { $0["id"]?.int64Value }, [1, 2, 3])
        XCTAssertTrue(driver.operations.isEmpty)
    }

    func testInvalidEnvelopeIsInvalidParams() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        // Owner shape does not match lifetime.
        host.handleMessage(requestJSON(id: 1, capability: "permission.query",
                                       owner: #"{"connection":true}"#))
        // timeoutMs beyond the revision bound (30 s for permission.query).
        host.handleMessage(requestJSON(id: 2, capability: "permission.query", timeoutMs: 60_000))
        // Unknown envelope key (closed schema).
        host.handleMessage(json(#"{"type":"deviceRequest","id":3,"capability":"permission.query","version":1,"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":1000,"initialCredit":0,"params":{},"extra":1}"#))
        XCTAssertEqual(responses().map { errorCode($0) }, ["invalidParams", "invalidParams", "invalidParams"])
        XCTAssertTrue(driver.operations.isEmpty)
    }

    func testDuplicateAndOlderIdsAreDropped() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 5, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(requestJSON(id: 5, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(requestJSON(id: 4, capability: "permission.query", timeoutMs: 30_000))
        XCTAssertEqual(driver.operations.count, 1)
        XCTAssertTrue(transport.sent.isEmpty)
    }

    // MARK: Leases (§2.7)

    func testLeaseRenewalEchoesExactSequence() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 4, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit: 64))
        XCTAssertEqual(driver.operations.count, 1)

        host.handleMessage(controlJSON(id: 4, #"{"renewLease":1}"#))
        clock.advance(by: 5)
        host.handleMessage(controlJSON(id: 4, #"{"renewLease":2}"#))
        let acks = transport.messages.compactMap { $0["control"]?["leaseAck"]?.int64Value }
        XCTAssertEqual(acks, [1, 2])
        XCTAssertEqual(transport.messages.first?["id"]?.int64Value, 4)

        // Unknown id: renewals cannot create/revive (not acked).
        host.handleMessage(controlJSON(id: 99, #"{"renewLease":1}"#))
        XCTAssertEqual(transport.messages.count, 2)
        // Older sequence on a live id: a lease violation (never increasing).
        host.handleMessage(controlJSON(id: 4, #"{"renewLease":1}"#))
        XCTAssertEqual(errorCode(responses().last), "invalidParams")
        XCTAssertEqual(driver.cancelCount, 1)
    }

    /// Shared rule (transcripts violation-renew-lease-not-increasing /
    /// -not-starting-at-1, lease-edge-cases): the first renewal is 1, later
    /// ones strictly increase and may skip.
    func testRenewalSequenceMustStartAtOneAndStrictlyIncrease() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":1}"#))
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":2}"#))
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":4}"#)) // skipping is legal
        XCTAssertEqual(transport.messages.compactMap { $0["control"]?["leaseAck"]?.int64Value }, [1, 2, 4])
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":4}"#)) // repeat: violation
        XCTAssertEqual(responses().map { errorCode($0) }, ["invalidParams"])
        XCTAssertEqual(driver.cancelCount, 1)

        host.handleMessage(requestJSON(id: 2, capability: "bluetooth.scan", timeoutMs: 600_000))
        host.handleMessage(controlJSON(id: 2, #"{"renewLease":4294967295}"#)) // not starting at 1
        XCTAssertEqual(responses().map { errorCode($0) }, ["invalidParams", "invalidParams"])
        XCTAssertEqual(responses().last?["id"]?.int64Value, 2)
    }

    func testLeaseSurvivesConsentWaitOnlyThroughRenewals() async {
        let driver = HoldDriver("permission.request")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", params: #"{"permission":"camera"}"#))
        for seq in 1...6 {
            clock.advance(by: 5)
            host.handleMessage(controlJSON(id: 1, #"{"renewLease":\#(seq)}"#))
        }
        XCTAssertTrue(responses().isEmpty, "renewed every 5 s: still live after 30 s")
        clock.advance(by: 15)
        XCTAssertEqual(errorCode(responses().last), "connectionLost")
    }

    func testLateRenewalAfterSuspendedTimersCannotRevive() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        // Timers suspended (no fire) while the monotonic clock moved on.
        clock.monotonicNow += 20
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":1}"#))
        XCTAssertNil(transport.messages.first { $0["control"] != nil })
        XCTAssertEqual(errorCode(responses().last), "connectionLost")
    }

    // MARK: Cancellation (§2.1)

    /// RFC 001 §2.1: on server cancel the client stops work and responds
    /// `cancelled` because it has not already terminated; anything after
    /// that (a late OS result, events, renewals) is ignored.
    func testServerCancelRepliesCancelledOnceThenIgnores() async {
        let driver = HoldDriver("permission.request")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 3, capability: "permission.request", params: #"{"permission":"camera"}"#))
        let op = driver.operations[0]
        host.handleMessage(controlJSON(id: 3, #"{"cancel":true}"#))
        XCTAssertEqual(driver.cancelCount, 1)
        XCTAssertTrue(op.isSettled)
        XCTAssertEqual(responses().count, 1)
        XCTAssertEqual(errorCode(responses().first), "cancelled")
        XCTAssertEqual(responses().first?["id"]?.int64Value, 3)
        // Late OS result: ignored, never sent (cancel-race fixture).
        op.succeed(["status": .string("granted")])
        op.emit(["x": .int(1)])
        host.handleMessage(controlJSON(id: 3, #"{"renewLease":1}"#))
        host.handleMessage(controlJSON(id: 3, #"{"cancel":true}"#))
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    func testDetachStopsEverythingWithoutReplies() async {
        let driver = HoldDriver("bluetooth.scan")
        let picker = FakePicker()
        let host = makeHost([driver, GalleryPickDriver(picker: picker)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        host.handleMessage(requestJSON(id: 2, capability: "gallery.pick", params: #"{"mediaTypes":["photo"],"maxCount":1}"#))
        XCTAssertTrue(host.promptGate.isBusy)
        host.detach()
        XCTAssertEqual(driver.cancelCount, 1)
        XCTAssertEqual(picker.handle?.cancelled, true)
        XCTAssertFalse(host.promptGate.isBusy)
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: Data([1]))]))
        clock.drainTurns()
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    // MARK: Deadline clamp (§2.1)

    func testDeadlineIsClampedToLocalMaximum() async {
        let driver = HoldDriver("permission.request")
        let host = makeHost([driver], options: DeviceHost.Options(maxTimeout: 60, leaseExpiry: 10_000))
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", timeoutMs: 300_000))
        clock.advance(by: 59.9)
        XCTAssertTrue(responses().isEmpty)
        clock.advance(by: 0.2)
        XCTAssertEqual(errorCode(responses().last), "timeout")
        XCTAssertEqual(driver.cancelCount, 1)
    }

    // MARK: Upload (§2.3/§2.4)

    private func galleryHost(_ picker: FakePicker, options: DeviceHost.Options = DeviceHost.Options()) -> DeviceHost {
        makeHost([GalleryPickDriver(picker: picker)], options: options)
    }

    private let galleryParams = #"{"mediaTypes":["photo"],"maxCount":1}"#

    private let maxUploadCredit: UInt64 = 4 * 1024 * 1024

    func testUploadChunksAt64KiBWithSha256() async throws {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        XCTAssertEqual(picker.presentCount, 1)
        let data = Data((0..<150_000).map { UInt8($0 % 251) })
        XCTAssertEqual(picker.lastMaxItemBytes, 64 * 1024 * 1024, "picker gets the revision item cap")
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: data)]))
        clock.drainTurns()

        // Order: blobStart → frames → terminal result.
        guard case let .message(first)? = transport.sent.first, case let .message(last)? = transport.sent.last else {
            return XCTFail("expected JSON first and last")
        }
        XCTAssertEqual(first["event"]?["kind"]?.stringValue, "blobStart")
        XCTAssertEqual(first["event"]?["channel"]?.int64Value, 0)
        XCTAssertEqual(first["event"]?["bytes"]?.int64Value, 150_000)
        XCTAssertEqual(first["event"]?["contentType"]?.stringValue, "image/jpeg")

        let frames = transport.frames
        XCTAssertEqual(frames.count, 3)
        var reassembled = Data()
        for (index, frame) in frames.enumerated() {
            guard case let .success(decoded) = DeviceFrameCodec.decode(frame) else { return XCTFail("frame") }
            XCTAssertEqual(decoded.header.requestId, 1)
            XCTAssertEqual(decoded.header.channel, 0)
            XCTAssertEqual(decoded.header.seq, UInt32(index))
            XCTAssertLessThanOrEqual(decoded.payload.count, 64 * 1024)
            reassembled.append(decoded.payload)
        }
        XCTAssertEqual(frames.map { $0.count - 12 }, [65_536, 65_536, 18_928])
        XCTAssertEqual(reassembled, data)

        XCTAssertEqual(last["type"]?.stringValue, "deviceResponse")
        let item = last["result"]?["items"]?.arrayValue?.first
        XCTAssertEqual(last["result"]?["items"]?.arrayValue?.count, 1)
        XCTAssertEqual(item?["channel"]?.int64Value, 0)
        XCTAssertEqual(item?["bytes"]?.int64Value, 150_000)
        XCTAssertEqual(item?["contentType"]?.stringValue, "image/jpeg")
        XCTAssertEqual(item?["sha256"]?.stringValue,
                       "02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b")
        XCTAssertEqual(host.liveOperationCount, 0)
        XCTAssertFalse(host.promptGate.isBusy)
    }

    /// Reproduces engine-compatibility-tests/fixtures/device/transcripts/gallery-pick-upload.json.
    func testUploadMatchesSharedTranscript() async throws {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams,
                                       initialCredit: 65_536,
                                       owner: #"{"moduleInstanceId":"profile-7","activationId":3}"#))
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: Data("hello-hypen-photo".utf8))]))
        clock.drainTurns()
        XCTAssertEqual(transport.sent.count, 3)
        XCTAssertEqual(transport.messages[0],
                       try JSONDecoder().decode(DeviceJSON.self, from: json(#"{"type":"deviceEvent","id":1,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":17}}"#)))
        XCTAssertEqual(hex(transport.frames[0]),
                       "01000000010000000000000068656c6c6f2d687970656e2d70686f746f")
        XCTAssertEqual(transport.messages[1],
                       try JSONDecoder().decode(DeviceJSON.self, from: json(#"{"type":"deviceResponse","id":1,"result":{"items":[{"channel":0,"contentType":"image/jpeg","bytes":17,"sha256":"5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347"}]}}"#)))
    }

    /// Decision D2 (transcript empty-item-no-frames): a zero-byte item is
    /// announced with `bytes: 0` and sends NO frame; its terminal entry has
    /// the SHA-256 of the empty string.
    func testEmptyItemSendsNoFrameAndEmptyHash() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        picker.completion?(.picked([PickedMedia(contentType: "image/png", data: Data())]))
        clock.drainTurns()
        XCTAssertTrue(transport.frames.isEmpty, "a zero-length frame is never sent")
        XCTAssertEqual(transport.messages.first?["event"]?["bytes"]?.int64Value, 0)
        XCTAssertNil(transport.messages.first { $0["control"]?["paused"] != nil }, "no data, no pause")
        let item = responses().last?["result"]?["items"]?.arrayValue?.first
        XCTAssertEqual(item?["bytes"]?.int64Value, 0)
        XCTAssertEqual(item?["sha256"]?.stringValue,
                       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    func testBulkStopsAtPendingBytesBound() async {
        transport.autoComplete = false
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 1024 * 1024))]))
        clock.drainTurns()
        // 4 × (64 KiB + 12) ≥ 256 KiB: the fourth frame reaches the bound.
        XCTAssertEqual(transport.frames.count, 4)
        // Control traffic is not held behind bulk.
        host.handleMessage(controlJSON(id: 1, #"{"renewLease":1}"#))
        XCTAssertEqual(transport.messages.last?["control"]?["leaseAck"]?.int64Value, 1)
        transport.completeOne()
        clock.drainTurns()
        XCTAssertEqual(transport.frames.count, 5)
        XCTAssertTrue(responses().isEmpty)
        while !transport.pendingCompletions.isEmpty {
            transport.completeOne()
            clock.drainTurns()
        }
        XCTAssertEqual(transport.frames.count, 16)
        XCTAssertEqual(responses().count, 1)
        guard case .message(let tail)? = transport.sent.last else { return XCTFail("terminal must follow bytes") }
        XCTAssertEqual(tail["type"]?.stringValue, "deviceResponse")
    }

    func testCancelDuringUploadDiscardsQueuedBytesAndResult() async {
        transport.autoComplete = false
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 1024 * 1024))]))
        clock.drainTurns()
        let sentFrames = transport.frames.count
        XCTAssertGreaterThan(sentFrames, 0)
        host.handleMessage(controlJSON(id: 1, #"{"cancel":true}"#))
        while !transport.pendingCompletions.isEmpty {
            transport.completeOne()
            clock.drainTurns()
        }
        XCTAssertEqual(transport.frames.count, sentFrames)
        // Only the `cancelled` reply: no result, no further bytes.
        XCTAssertEqual(responses().map { errorCode($0) }, ["cancelled"])
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    func testCreditPausesAndResumes() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: 65_536))
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: Data(count: 100_000))]))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.count, 1)
        XCTAssertEqual(transport.messages.last?["control"]?["paused"]?.boolValue, true)
        host.handleMessage(controlJSON(id: 1, #"{"grant":65536}"#))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.count, 2)
        let pausedFlags = transport.messages.compactMap { $0["control"]?["paused"]?.boolValue }
        XCTAssertEqual(pausedFlags, [true, false])
        XCTAssertEqual(responses().count, 1)
    }

    func testOversizeItemIsRejected() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 64 * 1024 * 1024 + 1))]))
        clock.drainTurns()
        XCTAssertTrue(transport.frames.isEmpty)
        XCTAssertEqual(errorCode(responses().last), "throttled")
    }

    // MARK: Gallery driver

    func testPickerDismissalIsCancelledNotDenied() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        picker.completion?(.dismissed)
        XCTAssertEqual(errorCode(responses().last), "cancelled")
        XCTAssertFalse(host.promptGate.isBusy)
        // Dismissal starts no cooldown.
        host.handleMessage(requestJSON(id: 2, capability: "gallery.pick", params: galleryParams))
        XCTAssertEqual(picker.presentCount, 2)
    }

    func testGalleryUnavailableWithoutPresenter() async {
        let picker = FakePicker()
        picker.available = false
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        XCTAssertEqual(errorCode(responses().last), "unavailable")
        XCTAssertFalse(host.promptGate.isBusy)
    }

    func testGalleryParamsAreValidated() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: #"{"mediaTypes":["photo"],"maxCount":0}"#))
        host.handleMessage(requestJSON(id: 2, capability: "gallery.pick", params: #"{"mediaTypes":["audio"],"maxCount":1}"#))
        host.handleMessage(requestJSON(id: 3, capability: "gallery.pick", params: #"{"mediaTypes":["photo"],"maxCount":1,"x":1}"#))
        host.handleMessage(requestJSON(id: 4, capability: "gallery.pick", params: #"{"mediaTypes":[],"maxCount":1}"#))
        host.handleMessage(requestJSON(id: 5, capability: "gallery.pick", params: #"{"mediaTypes":["photo","photo"],"maxCount":1}"#))
        XCTAssertEqual(responses().map { errorCode($0) }, Array(repeating: "invalidParams", count: 5))
        XCTAssertEqual(picker.presentCount, 0)
    }

    // MARK: Admission (§2.6/§5)

    func testOnlyOnePromptAtATime() async {
        let picker = FakePicker()
        let presenter = FakePresenter()
        let authority = FakeAuthority()
        let host = makeHost([GalleryPickDriver(picker: picker),
                             PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        host.handleMessage(requestJSON(id: 2, capability: "gallery.pick", params: galleryParams))
        host.handleMessage(requestJSON(id: 3, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(picker.presentCount, 1)
        XCTAssertTrue(presenter.presented.isEmpty)
        let throttled = responses()
        XCTAssertEqual(throttled.map { errorCode($0) }, ["throttled", "throttled"])
        XCTAssertEqual(throttled.map { $0["error"]?["platformDetail"]?.stringValue }, ["prompt-in-progress", "prompt-in-progress"])

        picker.completion?(.dismissed)
        host.handleMessage(requestJSON(id: 4, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(presenter.presented.count, 1)
        XCTAssertEqual(presenter.presented.first?.origin, "wss://app.example.com")
    }

    func testPromptGateIsSharedAcrossHosts() async {
        let gate = DevicePromptGate()
        let pickerA = FakePicker(), pickerB = FakePicker()
        let transportB = RecordingTransport()
        let hostA = DeviceHost(origin: "wss://a.example", drivers: [GalleryPickDriver(picker: pickerA)],
                               clock: clock, promptGate: gate, persistentStore: InMemoryDeviceStore())
        let hostB = DeviceHost(origin: "wss://b.example", drivers: [GalleryPickDriver(picker: pickerB)],
                               clock: clock, promptGate: gate, persistentStore: InMemoryDeviceStore())
        for (host, t) in [(hostA, transport!), (hostB, transportB)] {
            host.requiresCoreStreamFirst = false
            host.attach(t)
            host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                                 capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        }
        hostA.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        hostB.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        XCTAssertEqual(pickerA.presentCount, 1)
        XCTAssertEqual(pickerB.presentCount, 0)
        XCTAssertEqual(transportB.messages.last?["error"]?["code"]?.stringValue, "throttled")
    }

    func testDenialCooldownThrottlesThenExpires() async {
        let presenter = FakePresenter()
        let authority = FakeAuthority()
        let host = makeHost([PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(presenter.presented.first?.operation, "use your camera")
        presenter.completion?(false)
        XCTAssertEqual(errorCode(responses().last), "denied")
        XCTAssertEqual(responses().last?["error"]?["platformDetail"]?.stringValue, "host-refused")
        XCTAssertTrue(authority.requested.isEmpty)

        host.handleMessage(requestJSON(id: 2, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(errorCode(responses().last), "throttled")
        XCTAssertEqual(responses().last?["error"]?["platformDetail"]?.stringValue, "cooldown")
        XCTAssertEqual(presenter.presented.count, 1)

        clock.advance(by: 31)
        host.handleMessage(requestJSON(id: 3, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(presenter.presented.count, 2)
        presenter.completion?(true)
        XCTAssertEqual(authority.requested, [.camera])
        XCTAssertEqual(responses().last?["result"]?["status"]?.stringValue, "granted")
    }

    func testCooldownBackoffGrowsAndIsCapped() async {
        let grants = DeviceGrantStore(origin: "wss://a.example", persistentStore: InMemoryDeviceStore(),
                                      baseCooldown: 30, maxCooldown: 100)
        let now = Date(timeIntervalSince1970: 0)
        grants.recordDenial("x", now: now)
        XCTAssertEqual(grants.cooldownUntil("x"), now.addingTimeInterval(30))
        grants.recordDenial("x", now: now)
        XCTAssertEqual(grants.cooldownUntil("x"), now.addingTimeInterval(60))
        grants.recordDenial("x", now: now)
        XCTAssertEqual(grants.cooldownUntil("x"), now.addingTimeInterval(100))
        grants.recordAcceptance("x")
        XCTAssertNil(grants.cooldownUntil("x"))
    }

    func testPlaintextOriginGrantsAreConnectionScoped() async {
        let persistent = InMemoryDeviceStore()
        let insecure = DeviceGrantStore(origin: "ws://localhost:3000", persistentStore: persistent)
        XCTAssertFalse(insecure.persistent)
        insecure.setGrant("bluetooth.scan", until: Date.distantFuture)
        XCTAssertTrue(insecure.hasGrant("bluetooth.scan", now: Date()))
        insecure.resetConnectionScoped()
        XCTAssertFalse(insecure.hasGrant("bluetooth.scan", now: Date()))
        XCTAssertNil(persistent.double(forKey: "hypen.device.grant:ws://localhost:3000:bluetooth.scan"))

        XCTAssertEqual(DeviceGrantStore.normalize("WSS://App.Example.com:443"), "wss://app.example.com")
        XCTAssertEqual(DeviceGrantStore.normalize("wss://app.example.com:8443"), "wss://app.example.com:8443")
    }

    // MARK: Permissions

    func testPermissionQueryMapsStatusesAndNeverPrompts() async {
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted, .photos: .denied]
        let host = makeHost([PermissionQueryDriver(authority: authority)])
        host.handleMessage(requestJSON(id: 1, capability: "permission.query", params: #"{"permission":"camera"}"#, timeoutMs: 30_000))
        host.handleMessage(requestJSON(id: 2, capability: "permission.query", params: #"{"permission":"photos"}"#, timeoutMs: 30_000))
        host.handleMessage(requestJSON(id: 3, capability: "permission.query", params: #"{"permission":"microphone"}"#, timeoutMs: 30_000))
        host.handleMessage(requestJSON(id: 4, capability: "permission.query", params: #"{"permission":"geolocation"}"#, timeoutMs: 30_000))
        let r = responses()
        XCTAssertEqual(r[0]["result"]?["status"]?.stringValue, "granted")
        XCTAssertEqual(r[1]["result"]?["status"]?.stringValue, "denied")
        XCTAssertEqual(r[2]["result"]?["status"]?.stringValue, "prompt")
        // Round 3 (P1): the permission name is a closed enum; an alias such
        // as "geolocation" is invalidParams at decode, before any driver runs.
        XCTAssertEqual(errorCode(r[3]), "invalidParams")
        XCTAssertTrue(authority.requested.isEmpty)
    }

    func testPermissionRequestShortCircuitsResolvedStatuses() async {
        let presenter = FakePresenter()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted, .microphone: .denied]
        authority.missing = [.photos: "NSPhotoLibraryUsageDescription"]
        let host = makeHost([PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", params: #"{"permission":"camera"}"#))
        host.handleMessage(requestJSON(id: 2, capability: "permission.request", params: #"{"permission":"microphone"}"#))
        host.handleMessage(requestJSON(id: 3, capability: "permission.request", params: #"{"permission":"photos"}"#))
        let r = responses()
        XCTAssertEqual(r[0]["result"]?["status"]?.stringValue, "granted")
        XCTAssertEqual(errorCode(r[1]), "denied")
        XCTAssertEqual(errorCode(r[2]), "unavailable")
        XCTAssertTrue(presenter.presented.isEmpty)
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: Bluetooth

    func testBluetoothScanStreamsDevicesAndStopsOnCancel() async {
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter, indicator: indicator)])
        host.handleMessage(requestJSON(id: 4, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit: 64))
        XCTAssertEqual(presenter.presented.count, 1, "first use: host-owned consent")
        presenter.completion?(true)
        let scanner = factory.scanners[0]
        scanner.handler?(.scanning)
        XCTAssertFalse(host.promptGate.isBusy)
        scanner.handler?(.discovered(id: "aa:bb:cc:dd:ee:ff", name: "Speaker", rssi: -41))
        scanner.handler?(.discovered(id: "11", name: nil, rssi: 127)) // RSSI unavailable: skipped
        scanner.handler?(.discovered(id: "22", name: nil, rssi: -70))
        let events = transport.messages.compactMap { $0["event"] }
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0], try JSONDecoder().decode(DeviceJSON.self, from: json(#"{"device":{"id":"aa:bb:cc:dd:ee:ff","name":"Speaker","rssi":-41}}"#)))
        XCTAssertNil(events[1]["device"]?["name"])

        XCTAssertEqual(indicator.shown.count, 1, "indicator visible while scanning")
        XCTAssertEqual(indicator.shown.first?.origin, "wss://app.example.com")
        XCTAssertEqual(indicator.shown.first?.activity, BluetoothScanDriver.activityLabel)
        host.handleMessage(controlJSON(id: 4, #"{"cancel":true}"#))
        XCTAssertTrue(scanner.stopped)
        XCTAssertEqual(indicator.handle?.cancelled, true, "indicator hidden on cancel")
        XCTAssertEqual(responses().map { errorCode($0) }, ["cancelled"])

        // Persisted grant: the next scan needs no consent.
        host.handleMessage(requestJSON(id: 5, capability: "bluetooth.scan", timeoutMs: 600_000))
        XCTAssertEqual(presenter.presented.count, 1)
        XCTAssertEqual(factory.scanners.count, 2)
    }

    func testBluetoothPoweredOffAndUnauthorized() async {
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter, indicator: indicator)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        presenter.completion?(true)
        factory.scanners[0].handler?(.poweredOff)
        XCTAssertEqual(errorCode(responses().last), "unavailable")
        XCTAssertTrue(factory.scanners[0].stopped)
        XCTAssertEqual(indicator.handle?.cancelled, true)

        host.handleMessage(requestJSON(id: 2, capability: "bluetooth.scan", timeoutMs: 600_000))
        factory.scanners[1].handler?(.scanning)
        factory.scanners[1].handler?(.unauthorized)
        XCTAssertEqual(errorCode(responses().last), "revoked")

        factory.authorization = .denied
        host.handleMessage(requestJSON(id: 3, capability: "bluetooth.scan", timeoutMs: 600_000))
        XCTAssertEqual(errorCode(responses().last), "denied")
        XCTAssertEqual(factory.scanners.count, 2)
    }

    func testBluetoothDetachStopsScanner() async {
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter, indicator: indicator)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        presenter.completion?(true)
        host.detach()
        XCTAssertTrue(factory.scanners[0].stopped)
        factory.scanners[0].handler?(.discovered(id: "late", name: nil, rssi: -50))
        XCTAssertTrue(transport.messages.compactMap { $0["event"] }.isEmpty)
    }

    // MARK: core.capabilities and suspension

    func testCoreCapabilitiesEmitsFullSnapshotAndSurvivesSuspension() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver], options: DeviceHost.Options(leaseExpiry: 10_000))
        host.handleMessage(requestJSON(id: 1, capability: "core.capabilities", timeoutMs: 86_400_000,
                                       initialCredit: 8, owner: #"{"connection":true}"#, lifetime: "connection"))
        let snapshot = transport.messages.first?["event"]?["capabilities"]?.arrayValue
        XCTAssertEqual(snapshot?.compactMap { $0["name"]?.stringValue }, ["core.capabilities", "permission.query"])
        XCTAssertEqual(snapshot?.first?["versions"], .array([.int(1)]))

        host.handleMessage(requestJSON(id: 2, capability: "permission.query", timeoutMs: 30_000))
        host.suspend()
        XCTAssertEqual(errorCode(responses().last), "cancelled")
        XCTAssertEqual(responses().last?["id"]?.int64Value, 2)
        XCTAssertEqual(host.liveOperationCount, 1, "connection-owned stream continues")

        host.publishCapabilities()
        XCTAssertEqual(transport.messages.filter { $0["event"]?["capabilities"] != nil }.count, 2)
    }

    func testWrongDirectionTrafficTerminatesKnownId() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(controlJSON(id: 1, #"{"leaseAck":1}"#))
        XCTAssertEqual(errorCode(responses().last), "invalidParams")

        host.handleMessage(requestJSON(id: 2, capability: "permission.query", timeoutMs: 30_000))
        host.handleFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 2, seq: 0)))
        XCTAssertEqual(errorCode(responses().last), "invalidParams")

        // Unknown ids and short frames drop silently.
        let before = transport.sent.count
        host.handleFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 77, seq: 0)))
        host.handleFrame(Data([1, 0, 0]))
        XCTAssertEqual(transport.sent.count, before)
    }

    func testReattachStartsFreshIdSpace() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 7, capability: "permission.query", timeoutMs: 30_000))
        host.detach()
        let second = RecordingTransport()
        host.attach(second)
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: [CapabilitySelection(name: "core.capabilities", version: 1),
                                            CapabilitySelection(name: "permission.query", version: 1)]))
        host.handleMessage(requestJSON(id: 1, capability: "permission.query", timeoutMs: 30_000))
        XCTAssertEqual(driver.operations.count, 2)
        // A late completion from the old socket cannot reach the new one.
        driver.operations[0].succeed(["status": .string("granted")])
        XCTAssertTrue(second.sent.isEmpty)
        XCTAssertTrue(transport.sent.isEmpty)
    }

    // MARK: Credit pacing (§2.3) — review findings #1/#2/#3

    /// Frames are cut to `min(64 KiB, credit)`: a 32 KiB budget sends a
    /// 32 KiB frame, pauses once, and resumes exactly on each grant.
    func testCreditBelowChunkSizeSplitsFramesToFit() async throws {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: 32_768))
        let data = Data((0..<100_000).map { UInt8($0 % 239) })
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: data)]))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.map { $0.count - 12 }, [32_768])
        XCTAssertEqual(transport.messages.last?["control"]?["paused"]?.boolValue, true)

        host.handleMessage(controlJSON(id: 1, #"{"grant":1000}"#))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.map { $0.count - 12 }, [32_768, 1_000])
        host.handleMessage(controlJSON(id: 1, #"{"grant":100000}"#))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.map { $0.count - 12 }, [32_768, 1_000, 65_536, 696])
        let pausedFlags = transport.messages.compactMap { $0["control"]?["paused"]?.boolValue }
        XCTAssertEqual(pausedFlags, [true, false, true, false], "transitions only, never repeated")

        var reassembled = Data()
        for (index, frame) in transport.frames.enumerated() {
            guard case let .success(decoded) = DeviceFrameCodec.decode(frame) else { return XCTFail("frame") }
            XCTAssertEqual(decoded.header.seq, UInt32(index), "contiguous seq on channel 0")
            reassembled.append(decoded.payload)
        }
        XCTAssertEqual(reassembled, data)
        XCTAssertEqual(responses().last?["result"]?["items"]?.arrayValue?.first?["sha256"]?.stringValue,
                       DeviceHash.sha256Hex(data))
    }

    func testZeroInitialCreditWaitsForGrantWithoutDeadlock() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams))
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: Data(count: 10))]))
        clock.drainTurns()
        XCTAssertEqual(transport.messages.first?["event"]?["kind"]?.stringValue, "blobStart", "announcement needs no credit")
        XCTAssertTrue(transport.frames.isEmpty)
        XCTAssertEqual(transport.messages.last?["control"]?["paused"]?.boolValue, true)
        host.handleMessage(controlJSON(id: 1, #"{"grant":10}"#))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.map { $0.count - 12 }, [10])
        XCTAssertEqual(responses().count, 1)
    }

    func testGrantOverflowPastMaxOutstandingIsInvalidParams() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        // 4 MiB outstanding + 4 MiB + 1 > 8 MiB maxOutstandingCredit.
        host.handleMessage(controlJSON(id: 1, #"{"grant":4194305}"#))
        XCTAssertEqual(errorCode(responses().last), "invalidParams")
        XCTAssertEqual(picker.handle?.cancelled, true)
    }

    func testMultiBlobUsesOneChannelPerItemAndPerChannelSeq() async {
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 9, capability: "gallery.pick",
                                       params: #"{"mediaTypes":["photo","video"],"maxCount":2}"#,
                                       initialCredit: maxUploadCredit))
        let a = Data(count: 70_000), b = Data([1, 2, 3])
        picker.completion?(.picked([PickedMedia(contentType: "image/jpeg", data: a),
                                    PickedMedia(contentType: "video/mp4", data: b)]))
        clock.drainTurns()
        // Both items are announced up front, then per-channel frames, result.
        var trace: [String] = []
        for item in transport.sent {
            switch item {
            case let .message(m):
                if let ch = m["event"]?["channel"]?.int64Value { trace.append("start\(ch)") }
                else if m["type"]?.stringValue == "deviceResponse" { trace.append("result") }
            case let .frame(f):
                guard case let .success(d) = DeviceFrameCodec.decode(f) else { return XCTFail("frame") }
                trace.append("f\(d.header.channel).\(d.header.seq)")
            }
        }
        XCTAssertEqual(trace, ["start0", "start1", "f0.0", "f0.1", "f1.0", "result"])
        let items = responses().last?["result"]?["items"]?.arrayValue ?? []
        XCTAssertEqual(items.compactMap { $0["channel"]?.int64Value }, [0, 1])
        XCTAssertEqual(items.compactMap { $0["bytes"]?.int64Value }, [70_000, 3])
        XCTAssertEqual(items.compactMap { $0["sha256"]?.stringValue }, [DeviceHash.sha256Hex(a), DeviceHash.sha256Hex(b)])
    }

    /// Frames are cut per turn from the blob, not pre-materialised: after the
    /// pending-bytes bound is reached only the handed frames exist.
    func testFramesAreProducedLazilyPerTurn() async {
        transport.autoComplete = false
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 2 * 1024 * 1024))]))
        clock.drainTurns()
        XCTAssertEqual(transport.frames.count, 4)
        // Budget spent only for handed frames.
        host.handleMessage(controlJSON(id: 1, #"{"grant":4194304}"#))
        XCTAssertTrue(responses().isEmpty, "4 MiB + 4 MiB − 256 KiB sent stays within the 8 MiB bound")
    }

    // MARK: Cross-SDK alignment (#8)

    /// RFC 001 §2.1: a known-id invalid message terminates that operation.
    func testGrantWithoutDataPlaneIsInvalidParams() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "permission.query", timeoutMs: 30_000))
        host.handleMessage(controlJSON(id: 1, #"{"grant":65536}"#))
        XCTAssertEqual(responses().map { errorCode($0) }, ["invalidParams"])
        XCTAssertEqual(driver.cancelCount, 1)
        XCTAssertEqual(host.liveOperationCount, 0)
        // Unknown ids stay ignored.
        host.handleMessage(controlJSON(id: 99, #"{"grant":1}"#))
        XCTAssertEqual(responses().count, 1)
    }

    func testServerEventPayloadOnKnownIdIsInvalidParams() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        host.handleMessage(json(#"{"type":"deviceEvent","id":1,"event":{"kind":"progress","state":"running"}}"#))
        XCTAssertEqual(responses().map { errorCode($0) }, ["invalidParams"])
        XCTAssertEqual(driver.cancelCount, 1)
        host.handleMessage(json(#"{"type":"deviceEvent","id":7,"event":{"kind":"progress","state":"running"}}"#))
        XCTAssertEqual(responses().count, 1, "unknown ids stay ignored")
    }

    /// RFC 001 §2.3: JSON stream credit counts events. Events beyond the
    /// balance are held (dropOldest, bounded) and flushed on grant.
    func testJsonStreamEventsArePacedByEventCredit() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit: 2))
        let op = driver.operations[0]
        func device(_ n: Int) -> DeviceJSONObject {
            ["device": .object(["id": .string("\(n)"), "rssi": .int(-40)])]
        }
        func events() -> [Int64] {
            transport.messages.compactMap { $0["event"]?["device"]?["id"]?.stringValue.flatMap { Int64($0) } }
        }
        for n in 0..<5 { op.emit(device(n)) }
        XCTAssertEqual(events(), [0, 1], "two units of credit, two events")
        host.handleMessage(controlJSON(id: 1, #"{"grant":2}"#))
        XCTAssertEqual(events(), [0, 1, 2, 3], "held events flush in order on grant")
        host.handleMessage(controlJSON(id: 1, #"{"grant":10}"#))
        XCTAssertEqual(events(), [0, 1, 2, 3, 4])
        op.emit(device(5))
        XCTAssertEqual(events().last, 5, "remaining credit spends immediately")

        // Held events are bounded: the oldest are dropped.
        let host2Transport = RecordingTransport()
        let driver2 = HoldDriver("bluetooth.scan")
        let host2 = DeviceHost(origin: "wss://a.example", drivers: [driver2], clock: clock,
                               promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host2.requiresCoreStreamFirst = false
        host2.attach(host2Transport)
        host2.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: host2.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1) }))
        host2.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        for n in 0..<100 { driver2.operations[0].emit(device(n)) }
        XCTAssertTrue(host2Transport.messages.isEmpty, "zero initial credit: nothing sent")
        host2.handleMessage(controlJSON(id: 1, #"{"grant":1000}"#))
        let sent = host2Transport.messages.compactMap {
            $0["event"]?["device"]?["id"]?.stringValue.flatMap { Int64($0) }
        }
        XCTAssertEqual(sent.count, DeviceHost.maxHeldEvents)
        XCTAssertEqual(sent.first, Int64(100 - DeviceHost.maxHeldEvents))
        XCTAssertEqual(sent.last, 99)
    }

    func testJsonStreamGrantOverflowIsInvalidParams() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000, initialCredit: 64))
        host.handleMessage(controlJSON(id: 1, #"{"grant":960}"#)) // 1024 = maxOutstandingCredit
        XCTAssertTrue(responses().isEmpty)
        host.handleMessage(controlJSON(id: 1, #"{"grant":1}"#))
        XCTAssertEqual(errorCode(responses().last), "invalidParams")
    }

    func testCoreCapabilitiesCoalescesToLatestSnapshotWithoutCredit() async {
        let host = makeHost([HoldDriver("permission.query")], options: DeviceHost.Options(leaseExpiry: 10_000))
        host.handleMessage(requestJSON(id: 1, capability: "core.capabilities", timeoutMs: 86_400_000,
                                       initialCredit: 1, owner: #"{"connection":true}"#, lifetime: "connection"))
        XCTAssertEqual(transport.messages.filter { $0["event"] != nil }.count, 1, "first snapshot spends the credit")
        host.publishCapabilities()
        host.publishCapabilities()
        host.publishCapabilities()
        XCTAssertEqual(transport.messages.filter { $0["event"] != nil }.count, 1)
        host.handleMessage(controlJSON(id: 1, #"{"grant":8}"#))
        XCTAssertEqual(transport.messages.filter { $0["event"] != nil }.count, 2, "one coalesced latest snapshot")
    }

    func testBadFrameVersionOrFlagsOnLiveIdIsDropped() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 2, capability: "permission.query", timeoutMs: 30_000))
        var badVersion = DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 2, seq: 0))
        badVersion[0] = 9
        var badFlags = DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 2, seq: 0))
        badFlags[1] = 1
        host.handleFrame(badVersion)
        host.handleFrame(badFlags)
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertEqual(host.liveOperationCount, 1)
    }

    func testRenewLeaseForUnknownIdIsNotAcked() async {
        let host = makeHost([HoldDriver("permission.query")])
        host.handleMessage(controlJSON(id: 42, #"{"renewLease":1}"#))
        host.handleMessage(controlJSON(id: 42, #"{"cancel":true}"#))
        XCTAssertTrue(transport.sent.isEmpty)
    }

    /// Decision D4/D8 (transcript violation-json-limits-are-connection-
    /// level): a duplicate key anywhere breaks the JSON limits, so the text
    /// names no request — it is discarded and counted, never reinterpreted,
    /// and never terminates the request its id seems to name.
    func testDuplicateKeysAreNeverReinterpreted() async {
        let driver = HoldDriver("permission.query")
        let host = makeHost([driver])
        host.handleMessage(json(#"{"type":"deviceRequest","id":1,"id":2,"capability":"permission.query","version":1,"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":1000,"initialCredit":0,"params":{}}"#))
        host.handleMessage(requestJSON(id: 3, capability: "permission.query", params: #"{"permission":"camera","permission":"photos"}"#, timeoutMs: 1000))
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertTrue(driver.operations.isEmpty)
        host.handleMessage(requestJSON(id: 4, capability: "permission.query", timeoutMs: 1000))
        host.handleMessage(json(#"{"type":"deviceEvent","id":4,"control":{"renewLease":1,"renewLease":2}}"#))
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertEqual(host.liveOperationCount, 1, "request 4 stays live")
        XCTAssertEqual(host.connectionViolationCount, 3)
        // Nothing was reinterpreted: the next request executes normally.
        host.handleMessage(requestJSON(id: 5, capability: "permission.query", timeoutMs: 1000))
        XCTAssertEqual(driver.operations.count, 2)
    }

    // MARK: Suspension, cancellation hooks, epochs (#10/#13)

    func testSuspendDoesNotCancelAnUploadInProgress() async {
        transport.autoComplete = false
        let picker = FakePicker()
        let driver = HoldDriver("permission.request")
        let host = makeHost([GalleryPickDriver(picker: picker), driver])
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        host.handleMessage(requestJSON(id: 2, capability: "permission.request", params: #"{"permission":"camera"}"#))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 512 * 1024))]))
        clock.drainTurns()
        host.suspend()
        XCTAssertEqual(responses().map { $0["id"]?.int64Value }, [2], "only the non-uploading op is cancelled")
        while !transport.pendingCompletions.isEmpty {
            transport.completeOne()
            clock.drainTurns()
        }
        XCTAssertEqual(responses().last?["id"]?.int64Value, 1)
        XCTAssertNotNil(responses().last?["result"], "upload completed after suspension")
    }

    func testOnCancelRegisteredWhileUploadingRuns() async {
        transport.autoComplete = false
        let driver = HoldDriver("gallery.pick")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        let op = driver.operations[0]
        op.succeed([:], blobs: [DeviceBlob(contentType: "video/mp4", bytes: Data(count: 1024 * 1024))])
        var cleaned = 0
        op.onCancel { cleaned += 1 }
        clock.drainTurns()
        host.handleMessage(controlJSON(id: 1, #"{"cancel":true}"#))
        XCTAssertEqual(cleaned, 1)
        op.onCancel { cleaned += 1 }
        XCTAssertEqual(cleaned, 2, "registration after settlement runs immediately")
    }

    func testOnCancelRegisteredWhileUploadingIsDiscardedOnSuccess() async {
        let driver = HoldDriver("gallery.pick")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        let op = driver.operations[0]
        op.succeed([:], blobs: [DeviceBlob(contentType: "image/png", bytes: Data([1, 2, 3]))])
        var cleaned = 0
        op.onCancel { cleaned += 1 }
        clock.drainTurns()
        XCTAssertNotNil(responses().last?["result"])
        XCTAssertEqual(cleaned, 0, "a completed upload is not a cancellation")
        XCTAssertEqual(driver.cancelCount, 0)
    }

    func testLateFrameCompletionFromOldSocketDoesNotAffectNewSocket() async {
        transport.autoComplete = false
        let picker = FakePicker()
        let host = galleryHost(picker)
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 1024 * 1024))]))
        clock.drainTurns()
        let oldCompletions = transport.pendingCompletions
        XCTAssertEqual(oldCompletions.count, 4)
        host.detach()

        let second = RecordingTransport()
        second.autoComplete = false
        host.attach(second)
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        host.handleMessage(requestJSON(id: 1, capability: "gallery.pick", params: galleryParams, initialCredit: maxUploadCredit))
        picker.completion?(.picked([PickedMedia(contentType: "video/mp4", data: Data(count: 1024 * 1024))]))
        clock.drainTurns()
        XCTAssertEqual(second.frames.count, 4)
        // Old-socket completions must not free the new socket's budget.
        oldCompletions.forEach { $0() }
        clock.drainTurns()
        XCTAssertEqual(second.frames.count, 4)
        XCTAssertTrue(transport.frames.count == 4, "nothing more on the old socket")
    }

    // MARK: Leases with the production renewal cadence (#4)

    func testLeaseSurvivesTenSecondRenewalCadence() async {
        let driver = HoldDriver("bluetooth.scan")
        let host = makeHost([driver])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        for seq in 1...6 {
            clock.advance(by: 10)
            host.handleMessage(controlJSON(id: 1, #"{"renewLease":\#(seq)}"#))
        }
        XCTAssertTrue(responses().isEmpty, "15 s expiry tolerates a 10 s cadence")
        clock.advance(by: 15.1)
        XCTAssertEqual(errorCode(responses().last), "connectionLost")
    }

    // MARK: Permission prompt cancellation (#16)

    func testServerCancelDuringOSPromptIgnoresLateResult() async {
        let presenter = FakePresenter()
        let authority = FakeAuthority()
        authority.deferRequests = true
        let host = makeHost([PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", params: #"{"permission":"camera"}"#))
        presenter.completion?(true)
        XCTAssertEqual(authority.requested, [.camera])
        host.handleMessage(controlJSON(id: 1, #"{"cancel":true}"#))
        XCTAssertEqual(responses().map { errorCode($0) }, ["cancelled"])
        authority.pendingRequest?(.granted)
        XCTAssertEqual(responses().count, 1, "late OS result never restarts cancelled work")
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: Bluetooth indicator (#5)

    func testBluetoothUserStopControlCancelsScan() async {
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter, indicator: indicator)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        presenter.completion?(true)
        factory.scanners[0].handler?(.scanning)
        indicator.stop?()
        XCTAssertTrue(factory.scanners[0].stopped)
        XCTAssertEqual(indicator.handle?.cancelled, true)
        XCTAssertEqual(responses().map { errorCode($0) }, ["cancelled"])
        XCTAssertEqual(responses().last?["error"]?["platformDetail"]?.stringValue, "user-stopped")
    }

    func testBluetoothWithoutVisibleIndicatorIsUnavailable() async {
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        indicator.available = false
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter, indicator: indicator)])
        host.handleMessage(requestJSON(id: 1, capability: "bluetooth.scan", timeoutMs: 600_000))
        presenter.completion?(true)
        XCTAssertEqual(errorCode(responses().last), "unavailable")
        XCTAssertTrue(factory.scanners.isEmpty == false ? factory.scanners[0].handler == nil : true, "never started")
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: Origins (#15)

    func testOriginNormalizationEdgeCases() async {
        XCTAssertEqual(DeviceGrantStore.normalize("wss://user:secret@App.Example.com:443/path?q=1#f"), "wss://app.example.com")
        XCTAssertEqual(DeviceGrantStore.normalize("wss://[::1]:8443"), "wss://[::1]:8443")
        XCTAssertEqual(DeviceGrantStore.normalize("https://[FE80::1]"), "https://[fe80::1]")
        let unparsable = DeviceGrantStore(origin: "wss://", persistentStore: InMemoryDeviceStore())
        XCTAssertFalse(unparsable.persistent, "no host: never an authenticated origin")
        let garbage = DeviceGrantStore(origin: "not a url", persistentStore: InMemoryDeviceStore())
        XCTAssertFalse(garbage.persistent)
        XCTAssertTrue(DeviceGrantStore(origin: "wss://a.example", persistentStore: InMemoryDeviceStore()).persistent)
        let dev = DeviceGrantStore(origin: "ws://localhost:3000", persistentStore: InMemoryDeviceStore())
        XCTAssertTrue(dev.displayOrigin.hasPrefix("ws://localhost:3000"))
        XCTAssertNotEqual(dev.displayOrigin, dev.origin, "plaintext origins are visibly marked")
    }

    func testPlaintextCooldownSurvivesReconnect() async {
        let store = InMemoryDeviceStore()
        let grants = DeviceGrantStore(origin: "ws://localhost:3000", persistentStore: store)
        let now = Date(timeIntervalSince1970: 1_000)
        grants.recordDenial("permission.request", now: now)
        grants.setGrant("bluetooth.scan", until: .distantFuture)
        grants.resetConnectionScoped()
        XCTAssertTrue(grants.isCoolingDown("permission.request", now: now), "cooldowns persist across reconnect (§5)")
        XCTAssertFalse(grants.hasGrant("bluetooth.scan", now: now), "grants stay connection-scoped")
        // And across restart: a new store over the same backing store.
        let restarted = DeviceGrantStore(origin: "ws://localhost:3000", persistentStore: store)
        XCTAssertTrue(restarted.isCoolingDown("permission.request", now: now))
    }

    func testPlaintextConsentPromptShowsDevelopmentMarker() async {
        let presenter = FakePresenter()
        let host = makeHost([PermissionRequestDriver(authority: FakeAuthority(), presenter: presenter)],
                            origin: "ws://localhost:3000")
        host.handleMessage(requestJSON(id: 1, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(presenter.presented.first?.origin, host.grants.displayOrigin)
        XCTAssertNotEqual(presenter.presented.first?.origin, "ws://localhost:3000")
    }
}

// MARK: - Client wire strictness (no fixtures required)

final class DeviceWireStrictnessTests: XCTestCase {
    private func strict(_ text: String) throws -> DeviceWireMessage {
        try DeviceWireMessage.decodeStrict(Data(text.utf8))
    }

    private func request(owner: String = #"{"moduleInstanceId":"m","activationId":1}"#,
                         id: String = "1", timeoutMs: String = "1000", params: String = "{}",
                         capability: String = "permission.query") -> String {
        #"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":1,"owner":\#(owner),"lifetime":"activation","timeoutMs":\#(timeoutMs),"initialCredit":0,"params":\#(params)}"#
    }

    func testAcceptsCanonicalMessages() async throws {
        _ = try strict(request())
        _ = try strict(#"{"type":"deviceResponse","id":1,"result":{},"simulated":true}"#)
        _ = try strict(#"{"type":"deviceEvent","id":1,"control":{"renewLease":4294967295}}"#)
    }

    func testRejectsAmbiguousOrOutOfRangeData() async {
        let cases = [
            #"{"type":"deviceEvent","id":1,"id":1,"control":{"cancel":true}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"grant":0}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"grant":4294967296}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"leaseAck":4294967296}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"renewLease":4294967296}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"renewLease":9007199254740991}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"grant":8388609}}"#,
            #"{"type":"deviceEvent","id":-0,"control":{"cancel":true}}"#,
            #"{"type":"deviceEvent","id":1,"control":{"cancel":false}}"#,
            #"{"type":"deviceEvent","id":1,"event":null}"#,
            #"{"type":"deviceEvent","id":1,"event":[]}"#,
            #"{"type":"deviceEvent","id":0,"control":{"cancel":true}}"#,
            #"{"type":"deviceResponse","id":1,"result":null}"#,
            #"{"type":"deviceResponse","id":1,"result":{},"simulated":false}"#,
            #"{"type":"deviceResponse","id":1,"result":{},"simulated":null}"#,
            #"{"type":"deviceResponse","id":1,"error":{"code":"denied","platformDetail":null}}"#,
            #"{"id":1,"result":{}}"#,
            request(owner: #"{"moduleInstanceId":"m","activationId":0}"#),
            request(owner: #"{"moduleInstanceId":"m","activationId":1,"extra":1}"#),
            request(id: "4294967296"),
            request(timeoutMs: "0"),
            request(timeoutMs: "9007199254740992"),
            request(params: "null"),
            request(capability: String(repeating: "c", count: 129)),
        ]
        for text in cases {
            XCTAssertThrowsError(try strict(text), text)
        }
        // Code points, not graphemes: 64 × "e\u{301}" = 128 scalars passes.
        XCTAssertNoThrow(try strict(request(capability: String(repeating: "e\u{301}", count: 64))))
        XCTAssertThrowsError(try strict(request(capability: String(repeating: "e\u{301}", count: 65))))
    }

    func testRegistryCarriesAllTenCapabilities() async {
        XCTAssertEqual(DeviceRegistry.revisions.map { $0.capability }, [
            "core.capabilities", "bluetooth.scan", "bluetooth.select", "camera.capture", "file.pick", "file.save",
            "gallery.pick", "mic.record", "permission.query", "permission.request",
        ])
        XCTAssertEqual(DeviceRegistry.find("camera.capture", version: 1)?.data, .binaryUpload)
        XCTAssertEqual(DeviceRegistry.find("camera.capture", version: 1)?.maxItems, 1)
        XCTAssertEqual(DeviceRegistry.find("bluetooth.select", version: 1)?.data, DeviceRevisionPolicy.DataPlane.none)
        XCTAssertEqual(DeviceRegistry.find("file.save", version: 1)?.data, .binaryDownload)
        XCTAssertEqual(DeviceRegistry.find("file.save", version: 1)?.maxInitialCredit, 0)
    }
}

// MARK: - Shared conformance fixtures (RFC 001 §8)

/// Loads the cross-SDK fixtures from the repo checkout (located through this
/// file's resolved path). A missing file fails the test that asked for it.
enum DeviceFixtures {
    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
            .deletingLastPathComponent() // HypenSwiftTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // hypen-renderer-swift
            .deletingLastPathComponent() // repo root
    }

    static func url(_ relative: String) -> URL {
        repoRoot.appendingPathComponent(relative)
    }

    /// A fixture document, parsed with the device parser in trusted mode
    /// (duplicate keys are fixture errors; no device size/depth limits).
    static func load(_ relative: String) throws -> DeviceJSON {
        let url = url(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail("shared fixture missing: \(url.path)")
            throw CocoaError(.fileNoSuchFile)
        }
        return try DeviceStrictJSON.parseTrusted(Data(contentsOf: url))
    }

    static func serialize(_ value: DeviceJSON) -> Data {
        (try? DeviceWire.encode(value)) ?? Data()
    }

    static func bytes(fromHex hex: String) -> Data {
        var out = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return out
    }

    /// The exact text of a corpus case: `message`/`value` (serialized),
    /// `raw`, `rawHex`, or `rawRepeat`.
    static func text(of entry: DeviceJSON) -> Data? {
        if let message = entry["message"] ?? entry["value"] { return serialize(message) }
        if let raw = entry["raw"]?.stringValue { return Data(raw.utf8) }
        if let hex = entry["rawHex"]?.stringValue { return bytes(fromHex: hex) }
        if let spec = entry["rawRepeat"],
           let prefix = spec["prefix"]?.stringValue, let unit = spec["repeat"]?.stringValue,
           let count = spec["count"]?.int64Value, let suffix = spec["suffix"]?.stringValue {
            var out = Data(prefix.utf8)
            let piece = Data(unit.utf8)
            out.reserveCapacity(out.count + piece.count * Int(count) + suffix.utf8.count)
            for _ in 0..<count { out.append(piece) }
            out.append(Data(suffix.utf8))
            return out
        }
        return nil
    }
}

/// Consumes the cross-SDK fixtures from the Rust reference: the envelope,
/// handshake, payload and selection corpora and the frame goldens.
final class DeviceWireSharedFixtureTests: XCTestCase {
    /// Strict client decode plus the request admission rules the host
    /// applies to a request (bounds, owner/lifetime agreement, params).
    private func admit(_ data: Data) throws {
        let message = try DeviceWireMessage.decodeStrict(data)
        if case let .request(request) = message,
           let policy = DeviceRegistry.find(request.capability, version: request.version) {
            if let violation = DeviceHost.validate(request, against: policy)
                ?? DevicePayloads.validate(request.capability, version: request.version,
                                           kind: .params, value: .object(request.params)) {
                throw CocoaError(.coderInvalidValue, userInfo: [NSDebugDescriptionErrorKey: violation])
            }
        }
    }

    func testSharedMessageFixtures() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/conformance/messages.json")
        let valid = doc["valid"]?.arrayValue ?? []
        let invalid = doc["invalid"]?.arrayValue ?? []
        XCTAssertGreaterThanOrEqual(valid.count, 40)
        XCTAssertGreaterThanOrEqual(invalid.count, 150)
        for entry in valid {
            let name = entry["name"]?.stringValue ?? "?"
            guard let text = DeviceFixtures.text(of: entry) else { XCTFail("\(name): no message"); continue }
            do {
                let message = try DeviceWireMessage.decodeStrict(text)
                // Round trip: re-encoding gives back the input value.
                let expected = try entry["message"] ?? DeviceStrictJSON.parse(text)
                let back = try DeviceStrictJSON.parse(DeviceWire.encode(message))
                XCTAssertEqual(back, expected, "\(name): round-trip")
            } catch {
                XCTFail("\(name): valid message rejected: \(error)")
            }
        }
        for entry in invalid {
            let name = entry["name"]?.stringValue ?? "?"
            guard let text = DeviceFixtures.text(of: entry) else { XCTFail("\(name): no message/raw"); continue }
            XCTAssertThrowsError(try admit(text), "\(name): must be rejected (\(entry["reason"]?.stringValue ?? ""))")
        }
    }

    func testSharedHandshakeFixtures() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/conformance/messages.json")
        let cases = doc["handshake"]?.arrayValue ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 25)
        var kinds = Set<String>()
        for entry in cases {
            let name = entry["name"]?.stringValue ?? "?"
            let kind = entry["kind"]?.stringValue ?? "?"
            kinds.insert(kind)
            guard let text = DeviceFixtures.text(of: entry), let valid = entry["valid"]?.boolValue else {
                XCTFail("\(name): malformed case")
                continue
            }
            let accepted: Bool
            switch kind {
            case "hello":
                let hello = try? DeviceHello.decodeStrict(text)
                accepted = hello != nil
                if let hello = hello, let value = entry["value"] {
                    XCTAssertEqual(try DeviceStrictJSON.parse(DeviceWire.encode(hello)), value, "\(name): round-trip")
                }
            case "ack":
                let ack = try? DeviceAck.decodeStrict(text)
                accepted = ack != nil
                if let ack = ack, let value = entry["value"] {
                    XCTAssertEqual(try DeviceStrictJSON.parse(DeviceWire.encode(ack)), value, "\(name): round-trip")
                }
            case "capabilitiesEvent":
                if let value = try? DeviceStrictJSON.parse(text) {
                    accepted = DevicePayloads.validateCapabilitiesEvent(value) == nil
                } else {
                    accepted = false
                }
            default:
                XCTFail("\(name): unknown kind \(kind)")
                continue
            }
            XCTAssertEqual(accepted, valid, "\(name) (\(kind)): \(entry["reason"]?.stringValue ?? "valid")")
        }
        XCTAssertEqual(kinds, ["hello", "ack", "capabilitiesEvent"])
    }

    func testSharedPayloadFixtures() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/conformance/payloads.json")
        let cases = doc["cases"]?.arrayValue ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 100)
        for entry in cases {
            let name = entry["name"]?.stringValue ?? "?"
            guard let capability = entry["capability"]?.stringValue,
                  let version = entry["version"]?.int64Value,
                  let kind = entry["kind"]?.stringValue.flatMap(DevicePayloadKind.init(rawValue:)),
                  let value = entry["value"], let valid = entry["valid"]?.boolValue else {
                XCTFail("\(name): malformed case")
                continue
            }
            let violation = DevicePayloads.validate(capability, version: UInt32(version), kind: kind, value: value)
            XCTAssertEqual(violation == nil, valid, "\(name): \(violation ?? "accepted")")
        }
    }

    /// The client side of `conformance/selection.json`: a hello the client
    /// could send (valid handshake-v1) and the reference server's selection
    /// for it pass the client's ack validation unchanged; a disabled case
    /// yields no selection (and an invalid hello is one the client never
    /// sends, for which the reference disables device access).
    func testSharedSelectionFixtures() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/conformance/selection.json")
        var cases = doc["cases"]?.arrayValue ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 20)
        // The handshake-selection transcripts pin the same function.
        let dir = DeviceFixtures.url("engine-compatibility-tests/fixtures/device/transcripts")
        for file in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() where file.hasSuffix(".json") {
            let transcript = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/transcripts/\(file)")
            guard let hello = transcript["hello"] else { continue }
            cases.append(.object(["name": transcript["name"] ?? .string(file), "hello": hello,
                                  "expect": transcript["expectAck"] ?? .null]))
        }
        var selected = 0
        for entry in cases {
            let name = entry["name"]?.stringValue ?? "?"
            guard let helloValue = entry["hello"], let expect = entry["expect"] else {
                XCTFail("\(name): malformed case")
                continue
            }
            guard let hello = try? DeviceHello.decodeStrict(DeviceFixtures.serialize(helloValue)) else {
                XCTAssertEqual(expect, .null, "\(name): invalid hello but the reference selected")
                continue
            }
            guard expect != .null else { continue }
            guard let ack = try? DeviceAck.decodeStrict(DeviceFixtures.serialize(expect)) else {
                XCTFail("\(name): expected ack does not decode")
                continue
            }
            guard let accepted = DeviceHost.acceptSelection(ack, advertisement: hello) else {
                XCTFail("\(name): the reference selection was refused")
                continue
            }
            XCTAssertEqual(try DeviceWire.encode(accepted), try DeviceWire.encode(ack), "\(name): selection changed")
            selected += 1
        }
        XCTAssertGreaterThanOrEqual(selected, 10)
    }

    func testSharedFrameFixtures() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/frames.json")
        let frames = doc["frames"]?.arrayValue ?? []
        XCTAssertFalse(frames.isEmpty)
        for entry in frames {
            guard let h = entry["header"], let hex = entry["hex"]?.stringValue,
                  let version = h["version"]?.int64Value, let flags = h["flags"]?.int64Value,
                  let channel = h["channel"]?.int64Value, let requestId = h["requestId"]?.int64Value,
                  let seq = h["seq"]?.int64Value else { XCTFail("malformed frame case"); continue }
            let header = DeviceFrameHeader(version: UInt8(version), flags: UInt8(flags), channel: UInt16(channel),
                                           requestId: UInt32(requestId), seq: UInt32(seq))
            let payload = DeviceFixtures.bytes(fromHex: entry["payloadHex"]?.stringValue ?? "")
            let encoded = DeviceFrameCodec.encode(header, payload: payload)
            XCTAssertEqual(encoded, DeviceFixtures.bytes(fromHex: hex), hex)
            guard case let .success(decoded) = DeviceFrameCodec.decode(encoded) else { XCTFail(hex); continue }
            XCTAssertEqual(decoded.header, header)
            XCTAssertEqual(decoded.payload, payload)
        }
        let invalid = doc["invalid"]?.arrayValue ?? []
        XCTAssertFalse(invalid.isEmpty)
        for entry in invalid {
            let hex = entry["hex"]?.stringValue ?? ""
            let reason = entry["reason"]?.stringValue ?? ""
            switch DeviceFrameCodec.decode(DeviceFixtures.bytes(fromHex: hex)) {
            case .failure(.shortHeader): XCTAssertEqual(reason, "shortHeader", hex)
            case .failure(.violation): XCTAssertTrue(reason.hasPrefix("violation"), hex)
            case .success: XCTFail("\(hex) decoded")
            }
        }
        let sequences = doc["sequences"]?["cases"]?.arrayValue ?? []
        XCTAssertFalse(sequences.isEmpty)
        for entry in sequences {
            let name = entry["name"]?.stringValue ?? "?"
            let overflow = DeviceRevisionPolicy.Overflow(rawValue: entry["overflow"]?.stringValue ?? "") ?? .none
            let seqs = entry["seqs"]?.arrayValue?.compactMap { $0.int64Value } ?? []
            var tracker = DeviceSequenceTracker()
            var ok = true
            for (i, seq) in seqs.enumerated() {
                let accepted = seq >= 0 && seq <= Int64(UInt32.max) && tracker.accept(UInt32(seq), overflow: overflow)
                if !accepted {
                    ok = false
                    XCTAssertEqual(i, seqs.count - 1, "\(name): only the last seq may be the violation")
                    break
                }
            }
            XCTAssertEqual(ok, entry["valid"]?.boolValue, name)
        }
    }

    func testRegistryMatchesSharedExport() async throws {
        let doc = try DeviceFixtures.load("engine-compatibility-tests/schema/device/registry-v1.json")
        XCTAssertEqual(doc["protocolVersion"]?.int64Value, Int64(DeviceProtocolConstants.version))
        let capabilities = doc["capabilities"]?.arrayValue ?? []
        var exported: [String: DeviceJSON] = [:]
        for capability in capabilities {
            if let name = capability["name"]?.stringValue { exported[name] = capability["revisions"] }
        }
        var ours: [String: [DeviceJSON]] = [:]
        for p in DeviceRegistry.revisions {
            ours[p.capability, default: []].append(.object([
                "version": .int(Int64(p.version)), "mode": .string(p.mode.rawValue), "data": .string(p.data.rawValue),
                "consent": .string(p.consent.rawValue), "overflow": .string(p.overflow.rawValue),
                "lifetimes": .array(p.lifetimes.map { .string($0.rawValue) }),
                "maxItemBytes": .int(Int64(p.maxItemBytes)), "maxItems": .int(Int64(p.maxItems)),
                "maxInitialCredit": .int(Int64(p.maxInitialCredit)),
                "maxOutstandingCredit": .int(Int64(p.maxOutstandingCredit)), "maxTimeoutMs": .int(Int64(p.maxTimeoutMs)),
            ]))
        }
        XCTAssertEqual(Set(exported.keys), Set(ours.keys), "exactly the same capabilities")
        XCTAssertEqual(ours.count, 10)
        for (name, revisions) in ours {
            XCTAssertEqual(exported[name], .array(revisions), "\(name): revision mismatch")
        }
    }
}

// MARK: - Session resume credential (RFC 001 §5)

final class RemoteResumeCredentialTests: XCTestCase {
    func testHelloCarriesTokenOnlyWhenResumingItsSession() async {
        var credential = RemoteResumeCredential()
        credential.acknowledge(sessionId: "s-1", resumeToken: "AbC_-123xyz=")
        let resume = RemoteHello.message(sessionId: "s-1", credential: credential, props: nil, device: nil)
        XCTAssertEqual(resume["type"] as? String, "hello")
        XCTAssertEqual(resume["sessionId"] as? String, "s-1")
        XCTAssertEqual(resume["resumeToken"] as? String, "AbC_-123xyz=")

        let other = RemoteHello.message(sessionId: "s-2", credential: credential, props: nil, device: nil)
        XCTAssertNil(other["resumeToken"], "token is bound to the session it was issued for")
        let fresh = RemoteHello.message(sessionId: nil, credential: credential, props: ["platform": "ios"], device: nil)
        XCTAssertNil(fresh["sessionId"])
        XCTAssertNil(fresh["resumeToken"])
        XCTAssertEqual((fresh["props"] as? [String: Any])?["platform"] as? String, "ios")
    }

    func testLegacyServerAndExpiryClearTheToken() async {
        var credential = RemoteResumeCredential()
        credential.acknowledge(sessionId: "s-1", resumeToken: "tok123")
        credential.acknowledge(sessionId: "s-1", resumeToken: nil)
        XCTAssertNil(credential.token(resuming: "s-1"), "absent field: legacy id-only resume")
        credential.acknowledge(sessionId: "s-1", resumeToken: "tok123")
        credential.clear()
        XCTAssertNil(credential.token(resuming: "s-1"))
        XCTAssertNil(credential.sessionId)
    }

    func testInvalidTokensAreIgnoredAndNeverDescribed() async {
        var credential = RemoteResumeCredential()
        for bad: Any in ["", "has space", "slash/plus+", String(repeating: "a", count: 513), 42, "a==="] {
            credential.acknowledge(sessionId: "s", resumeToken: bad)
            XCTAssertNil(credential.token(resuming: "s"), "\(bad)")
        }
        credential.acknowledge(sessionId: "s", resumeToken: "SeCrEt-Token_1")
        XCTAssertFalse(credential.description.contains("SeCrEt"))
        XCTAssertFalse(String(reflecting: credential).contains("SeCrEt"))
        XCTAssertFalse("\(credential)".contains("SeCrEt"))
    }

    func testHelloEmbedsDeviceAdvertisement() async throws {
        let device = DeviceHello(protocolVersions: [1], binary: true,
                                 capabilities: [CapabilityOffer(name: "core.capabilities", versions: [1])])
        var credential = RemoteResumeCredential()
        credential.acknowledge(sessionId: "s", resumeToken: "tok")
        let message = RemoteHello.message(sessionId: "s", credential: credential, props: nil, device: device)
        let data = try JSONSerialization.data(withJSONObject: message["device"]!)
        XCTAssertEqual(try JSONDecoder().decode(DeviceHello.self, from: data), device)
        XCTAssertEqual(message["resumeToken"] as? String, "tok")
    }
}

// MARK: - RemoteEngine device-plane helpers

final class RemoteDevicePlaneTests: XCTestCase {
    func testBinaryFrameClassification() async {
        XCTAssertTrue(RemoteDevicePlane.isDeviceFrame(DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: 1, seq: 0))))
        XCTAssertTrue(RemoteDevicePlane.isDeviceFrame(Data()), "empty data goes to the device plane to be dropped")
        XCTAssertFalse(RemoteDevicePlane.isDeviceFrame(Data(#"{"type":"patch"}"#.utf8)))
        XCTAssertFalse(RemoteDevicePlane.isDeviceFrame(Data(" \n{}".utf8)))
    }

    func testSessionAckDeviceDecode() async {
        func ack(_ text: String) -> DeviceAck? {
            RemoteDevicePlane.deviceAck(fromSessionAckText: Data(text.utf8))
        }
        XCTAssertEqual(ack(#"{"type":"sessionAck","sessionId":"s","device":{"protocolVersion":1,"binary":true,"capabilities":[{"name":"core.capabilities","version":1}]}}"#),
                       DeviceAck(protocolVersion: 1, binary: true,
                                 capabilities: [CapabilitySelection(name: "core.capabilities", version: 1)]))
        XCTAssertNil(ack(#"{"type":"sessionAck","sessionId":"s"}"#), "legacy server")
        XCTAssertNil(ack(#"{"device":{"protocolVersion":1,"binary":true,"capabilities":[],"extra":1}}"#), "closed schema")
        XCTAssertNil(ack(#"{"device":{"protocolVersion":0,"binary":true,"capabilities":[]}}"#))
    }

    /// Decision D4: the JSON limits apply to `sessionAck.device` too; a
    /// lenient pre-parse can never reinterpret it (float, duplicate key,
    /// malformed key, duplicate capability names).
    func testSessionAckDeviceObeysTheJsonLimits() async {
        func ack(_ text: String) -> DeviceAck? {
            RemoteDevicePlane.deviceAck(fromSessionAckText: Data(text.utf8))
        }
        XCTAssertNil(ack(#"{"type":"sessionAck","sessionId":"s","device":{"protocolVersion":1.0,"binary":true,"capabilities":[]}}"#))
        XCTAssertNil(ack(#"{"type":"sessionAck","sessionId":"s","device":{"protocolVersion":1,"binary":false,"binary":true,"capabilities":[]}}"#))
        XCTAssertNil(ack(#"{"type":"sessionAck","sessionId":"s","device":{"protocolVersion":1,"binary":true,"capabilities":[],"\ud800":1}}"#))
        XCTAssertNil(ack(#"{"type":"sessionAck","sessionId":"s","device":{"protocolVersion":1,"binary":true,"capabilities":[{"name":"a","version":1},{"name":"a","version":2}]}}"#))
    }

    func testCompressionDetectionFailsClosed() async {
        func shared(_ header: String?, available: Bool = true) -> Bool {
            RemoteDevicePlane.compressionSharesContext(responseAvailable: available, extensionsHeader: header)
        }
        XCTAssertTrue(shared(nil, available: false),
                      "no inspectable handshake: assume shared compression, keep the device plane off")
        XCTAssertFalse(shared(nil))
        XCTAssertFalse(shared(""))
        XCTAssertTrue(shared("permessage-deflate; client_max_window_bits"))
        XCTAssertTrue(shared("PerMessage-Deflate"))
        XCTAssertTrue(shared("x-webkit-deflate-frame"))
        XCTAssertTrue(shared("permessage-deflate; \"unterminated"))
    }

    /// Per-message compression (both no-context-takeover params) keeps the
    /// device plane: what Bun, Go and the Ktor example negotiate by default.
    func testPerMessageCompressionAllowsTheDevicePlane() async {
        func shared(_ header: String) -> Bool {
            RemoteDevicePlane.compressionSharesContext(responseAvailable: true, extensionsHeader: header)
        }
        // Bun's and gorilla's answers.
        XCTAssertFalse(shared("permessage-deflate; client_no_context_takeover; server_no_context_takeover"))
        XCTAssertFalse(shared("permessage-deflate; server_no_context_takeover; client_no_context_takeover"))
        XCTAssertFalse(shared("PERMESSAGE-DEFLATE ; Server_No_Context_Takeover ; CLIENT_NO_CONTEXT_TAKEOVER"))
        XCTAssertFalse(shared("permessage-deflate; server_no_context_takeover; client_no_context_takeover; client_max_window_bits=15"))
        // One direction only, or the params split across two extensions.
        XCTAssertTrue(shared("permessage-deflate; server_no_context_takeover"))
        XCTAssertTrue(shared("permessage-deflate; client_no_context_takeover"))
        XCTAssertTrue(shared("permessage-deflate; server_no_context_takeover, permessage-deflate; client_no_context_takeover"))
        // Values or repeats are invalid for these params.
        XCTAssertTrue(shared("permessage-deflate; server_no_context_takeover=1; client_no_context_takeover"))
        XCTAssertTrue(shared("permessage-deflate; server_no_context_takeover; server_no_context_takeover; client_no_context_takeover"))
        // A param name inside a quoted value doesn't count.
        XCTAssertTrue(shared(#"permessage-deflate; x="server_no_context_takeover; client_no_context_takeover""#))
    }
}
