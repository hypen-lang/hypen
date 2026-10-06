import XCTest
@testable import HypenSwift

// Round 3 (capability coverage) for the iOS DeviceHost: typed permissions
// (P1), native file.pick / file.save with the server → client download plane
// (C1), camera.capture (C2), mic.record (C3) and bluetooth.select (C4).
//
// Every driver runs against fakes of its platform seam, so the protocol
// behaviour is pinned on Linux; the UIKit / AVFoundation / CoreBluetooth
// backends (`DeviceHostIOSCapture.swift`) only adapt those seams.

// MARK: - Fakes of the round-3 platform seams

@MainActor
final class FakeDocumentPicker: DocumentPicker {
    var available = true
    var presented = 0
    var filters: [DocumentTypeFilter] = []
    var maxCount = 0
    var selected: (@Sendable @MainActor () -> Void)?
    var completion: (@Sendable @MainActor (DocumentPickOutcome) -> Void)?
    var handle: FakeHandle?

    func presentOpen(filters: [DocumentTypeFilter], maxCount: Int, maxItemBytes: UInt64,
                     selected: @escaping @Sendable @MainActor () -> Void,
                     completion: @escaping @Sendable @MainActor (DocumentPickOutcome) -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        presented += 1
        self.filters = filters
        self.maxCount = maxCount
        self.selected = selected
        self.completion = completion
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakeFileSink: DeviceFileSink {
    var data = Data()
    var holdWrites = false
    var failWrites = false
    var commitResult = true
    var committed = false
    var discarded = 0
    var commits = 0
    private var held: [(Data, @Sendable @MainActor (Bool) -> Void)] = []

    var heldCount: Int { held.count }
    var heldBytes: Int { held.reduce(0) { $0 + $1.0.count } }

    func write(_ chunk: Data, completion: @escaping @Sendable @MainActor (Bool) -> Void) {
        if holdWrites {
            held.append((chunk, completion))
        } else {
            if !failWrites { data.append(chunk) }
            completion(!failWrites)
        }
    }

    /// Complete every held write, in order.
    func flush() {
        let pending = held
        held = []
        for (chunk, completion) in pending {
            if !failWrites { data.append(chunk) }
            completion(!failWrites)
        }
    }

    func commit(completion: @escaping @Sendable @MainActor (Bool) -> Void) {
        commits += 1
        committed = commitResult
        completion(commitResult)
    }

    func discard() {
        if !committed { discarded += 1 }
    }
}

@MainActor
final class FakeDestinationPicker: FileSaveDestinationPicker {
    var available = true
    var requests: [(name: String, contentType: String, bytes: UInt64)] = []
    var completion: (@MainActor (FileSaveDestinationOutcome) -> Void)?
    var handle: FakeHandle?

    func chooseDestination(name: String, contentType: String, bytes: UInt64,
                           completion: @escaping @MainActor (FileSaveDestinationOutcome) -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        requests.append((name, contentType, bytes))
        self.completion = completion
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakeCamera: CameraCapturer {
    var hasCamera = true
    var available = true
    var requests: [CameraCaptureRequest] = []
    var captured: (@Sendable @MainActor () -> Void)?
    var completion: (@Sendable @MainActor (CameraCaptureOutcome) -> Void)?
    var handle: FakeHandle?

    func isAvailable(facing: CameraCaptureRequest.Facing?) -> Bool { hasCamera }

    func presentCapture(_ request: CameraCaptureRequest, maxItemBytes: UInt64,
                        captured: @escaping @Sendable @MainActor () -> Void,
                        completion: @escaping @Sendable @MainActor (CameraCaptureOutcome) -> Void) -> DeviceCancellable? {
        guard available else { return nil }
        requests.append(request)
        self.captured = captured
        self.completion = completion
        let h = FakeHandle()
        handle = h
        return h
    }
}

@MainActor
final class FakeAudioSource: AudioCaptureSource {
    var format: AudioCaptureFormat?
    var handler: (@Sendable @MainActor (AudioCaptureEvent) -> Void)?
    var stopped = false
    var startFailure: String?

    func start(_ format: AudioCaptureFormat,
               _ handler: @escaping @Sendable @MainActor (AudioCaptureEvent) -> Void) -> String? {
        if let failure = startFailure { return failure }
        self.format = format
        self.handler = handler
        return nil
    }

    func stop() {
        stopped = true
        handler = nil
    }

    func emit(_ event: AudioCaptureEvent) { handler?(event) }
}

@MainActor
final class FakeAudioFactory: AudioCaptureFactory {
    var sources: [FakeAudioSource] = []
    var startFailure: String?
    func makeSource() -> AudioCaptureSource {
        let s = FakeAudioSource()
        s.startFailure = startFailure
        sources.append(s)
        return s
    }
}

@MainActor
final class FakeChooserSession: BluetoothChooserSession {
    var lists: [[BluetoothChooserEntry]] = []
    var cancelled = false
    func update(_ entries: [BluetoothChooserEntry]) { lists.append(entries) }
    func cancel() { cancelled = true }
}

@MainActor
final class FakeChooser: BluetoothChooser {
    var available = true
    var origins: [String] = []
    var completion: (@Sendable @MainActor (BluetoothChooserOutcome) -> Void)?
    var session: FakeChooserSession?

    func presentChooser(origin: String,
                        completion: @escaping @Sendable @MainActor (BluetoothChooserOutcome) -> Void) -> BluetoothChooserSession? {
        guard available else { return nil }
        origins.append(origin)
        self.completion = completion
        let s = FakeChooserSession()
        session = s
        return s
    }
}

@MainActor
final class FakeFilteredScannerFactory: BluetoothScannerFactory {
    var authorization: DevicePermissionStatus = .granted
    var missingUsageDescription: String?
    var services: [[String]] = []
    var scanners: [FakeScanner] = []

    func makeScanner() -> BluetoothScanner { makeScanner(services: []) }

    func makeScanner(services: [String]) -> BluetoothScanner {
        self.services.append(services)
        let s = FakeScanner()
        scanners.append(s)
        return s
    }
}

/// A permission authority that cannot represent some permissions at all.
@MainActor
final class LimitedAuthority: DevicePermissionAuthority {
    let inner = FakeAuthority()
    var unsupported: Set<DevicePermission> = []

    func status(of permission: DevicePermission,
                completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        inner.status(of: permission, completion: completion)
    }

    func request(_ permission: DevicePermission,
                 completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        inner.request(permission, completion: completion)
    }

    func missingUsageDescription(for permission: DevicePermission) -> String? {
        inner.missingUsageDescription(for: permission)
    }

    func supports(_ permission: DevicePermission) -> Bool { !unsupported.contains(permission) }
}

// MARK: - Helpers

@MainActor
private func r3request(id: UInt32, capability: String, params: String, timeoutMs: UInt64 = 300_000,
                       initialCredit: UInt64 = 0) -> Data {
    Data(#"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":1,"owner":{"moduleInstanceId":"m-1","activationId":1},"lifetime":"activation","timeoutMs":\#(timeoutMs),"initialCredit":\#(initialCredit),"params":\#(params)}"#.utf8)
}

@MainActor
private func r3control(id: UInt32, _ control: String) -> Data {
    Data(#"{"type":"deviceEvent","id":\#(id),"control":\#(control)}"#.utf8)
}

private func r3sha(_ data: Data) -> String { DeviceHash.sha256Hex(data) }

@MainActor
final class DeviceHostRound3Tests: XCTestCase, @unchecked Sendable {
    var clock: ManualDeviceClock!
    var transport: RecordingTransport!

    override func setUp() async throws {
        clock = ManualDeviceClock()
        transport = RecordingTransport()
    }

    private func makeHost(_ drivers: [DeviceDriver],
                          options: DeviceHost.Options = DeviceHost.Options(leaseExpiry: 10_000)) -> DeviceHost {
        let host = DeviceHost(origin: "wss://app.example.com", drivers: drivers, options: options, clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host.requiresCoreStreamFirst = false
        XCTAssertTrue(host.attach(transport))
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        return host
    }

    private func responses() -> [DeviceJSON] {
        transport.messages.filter { $0["type"]?.stringValue == "deviceResponse" }
    }

    private func code(_ m: DeviceJSON?) -> String? { m?["error"]?["code"]?.stringValue }
    private func detail(_ m: DeviceJSON?) -> String? { m?["error"]?["platformDetail"]?.stringValue }

    private func events(_ id: Int64) -> [DeviceJSON] {
        transport.messages.filter { $0["id"]?.int64Value == id }.compactMap { $0["event"] }
    }

    private func progress(_ id: Int64) -> [String] {
        events(id).filter { $0["kind"]?.stringValue == "progress" }.compactMap { $0["state"]?.stringValue }
    }

    private func grants(_ id: Int64) -> [Int64] {
        transport.messages.filter { $0["id"]?.int64Value == id }.compactMap { $0["control"]?["grant"]?.int64Value }
    }

    private func pausedTransitions(_ id: Int64) -> [Bool] {
        transport.messages.filter { $0["id"]?.int64Value == id }.compactMap { $0["control"]?["paused"]?.boolValue }
    }

    /// Payload bytes the host framed for `id`, per channel, checking seq.
    private func uploaded(_ id: UInt32) -> [UInt16: Data] {
        var out: [UInt16: Data] = [:]
        var seq: [UInt16: UInt32] = [:]
        for frame in transport.frames {
            guard case let .success(d) = DeviceFrameCodec.decode(frame), d.header.requestId == id else { continue }
            XCTAssertEqual(d.header.seq, seq[d.header.channel] ?? 0, "contiguous seq")
            XCTAssertFalse(d.payload.isEmpty, "no empty frame")
            seq[d.header.channel] = d.header.seq + 1
            out[d.header.channel, default: Data()].append(d.payload)
        }
        return out
    }

    private func frame(_ id: UInt32, seq: UInt32, _ payload: Data) -> Data {
        DeviceFrameCodec.encode(DeviceFrameHeader(channel: 0, requestId: id, seq: seq), payload: payload)
    }

    // MARK: P1 — typed permissions

    func testPermissionEnumMatchesTheSharedSchemaExactly() async throws {
        for capability in ["permission.query", "permission.request"] {
            let schema = try DeviceFixtures.load("engine-compatibility-tests/schema/device/\(capability)-v1.schema.json")
            let names = schema["$defs"]?["params"]?["properties"]?["permission"]?["enum"]?.arrayValue?
                .compactMap { $0.stringValue }
            XCTAssertEqual(names, DevicePermission.allCases.map { $0.rawValue }, capability)
        }
        XCTAssertEqual(DevicePayloads.permissionNames,
                       ["camera", "microphone", "photos", "location", "notifications", "bluetooth", "contacts"])
    }

    func testUnknownPermissionNamesAreInvalidParamsBeforeAnyDriver() async {
        let authority = FakeAuthority()
        let presenter = FakePresenter()
        let host = makeHost([PermissionQueryDriver(authority: authority),
                             PermissionRequestDriver(authority: authority, presenter: presenter)])
        var id: UInt32 = 1
        for name in ["camra", "geolocation", "Camera", "photo", "camera ", "", "bluetooth.scan"] {
            host.handleMessage(r3request(id: id, capability: "permission.query", params: #"{"permission":"\#(name)"}"#,
                                         timeoutMs: 30_000))
            host.handleMessage(r3request(id: id + 1, capability: "permission.request", params: #"{"permission":"\#(name)"}"#))
            id += 2
        }
        XCTAssertEqual(responses().count, 14)
        XCTAssertTrue(responses().allSatisfy { code($0) == "invalidParams" })
        XCTAssertTrue(authority.requested.isEmpty)
        XCTAssertTrue(presenter.presented.isEmpty)
    }

    func testEveryPermissionNameIsAnsweredAndUnrepresentableOnesAreUnsupported() async {
        let authority = LimitedAuthority()
        authority.unsupported = [.contacts]
        authority.inner.statuses = [.camera: .granted, .microphone: .denied, .photos: .granted, .location: .prompt,
                                    .notifications: .granted, .bluetooth: .prompt]
        let presenter = FakePresenter()
        let host = makeHost([PermissionQueryDriver(authority: authority),
                             PermissionRequestDriver(authority: authority, presenter: presenter)])
        for (index, permission) in DevicePermission.allCases.enumerated() {
            host.handleMessage(r3request(id: UInt32(index + 1), capability: "permission.query",
                                         params: #"{"permission":"\#(permission.rawValue)"}"#, timeoutMs: 30_000))
        }
        let r = responses()
        XCTAssertEqual(r.map { $0["result"]?["status"]?.stringValue },
                       ["granted", "denied", "granted", "prompt", "granted", "prompt", nil])
        XCTAssertEqual(code(r[6]), "unsupported")
        XCTAssertEqual(detail(r[6]), "contacts", "platformDetail names the permission")

        host.handleMessage(r3request(id: 20, capability: "permission.request", params: #"{"permission":"contacts"}"#))
        XCTAssertEqual(code(responses().last), "unsupported")
        XCTAssertEqual(detail(responses().last), "contacts")
        XCTAssertTrue(presenter.presented.isEmpty, "no prompt for an unrepresentable permission")
    }

    func testLocationAndContactsRequestsGoThroughConsentThenTheOSPrompt() async {
        let authority = FakeAuthority()
        authority.requestResult = .granted
        let presenter = FakePresenter()
        let host = makeHost([PermissionRequestDriver(authority: authority, presenter: presenter)])
        host.handleMessage(r3request(id: 1, capability: "permission.request", params: #"{"permission":"location"}"#))
        XCTAssertEqual(presenter.presented.last?.operation, "use your location")
        presenter.completion?(true)
        XCTAssertEqual(authority.requested, [.location])
        host.handleMessage(r3request(id: 2, capability: "permission.request", params: #"{"permission":"contacts"}"#))
        XCTAssertEqual(presenter.presented.last?.operation, "access your contacts")
        presenter.completion?(true)
        XCTAssertEqual(authority.requested, [.location, .contacts])
        XCTAssertEqual(responses().map { $0["result"]?["status"]?.stringValue }, ["granted", "granted"])
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: C1 — file.pick

    func testAcceptFiltersParseMimeWildcardsAndExtensions() async {
        XCTAssertEqual(DocumentTypeFilter.parse([]), [])
        XCTAssertEqual(DocumentTypeFilter.parse(["*/*", " "]), [])
        XCTAssertEqual(DocumentTypeFilter.parse(["image/*", "application/PDF", ".TXT", "csv", "image/*"]),
                       [.mediaWildcard("image"), .mimeType("application/pdf"), .fileExtension("txt"), .fileExtension("csv")])
        XCTAssertEqual(DocumentTypeFilter.parse(["application/vnd.ms-excel", ".tar.gz"]),
                       [.mimeType("application/vnd.ms-excel"), .fileExtension("tar.gz")])
        for bad in ["image/png;q=1", "a b", "/pdf", "image/", "../etc", "text/html,image/png", "."] {
            XCTAssertNil(DocumentTypeFilter.parse([bad]), bad)
        }
    }

    func testFilePickStreamsDeclaredNamedItemsAndReleasesThemAtTheEnd() async {
        let picker = FakeDocumentPicker()
        let host = makeHost([FilePickDriver(picker: picker)])
        host.handleMessage(r3request(id: 1, capability: "file.pick", params: #"{"accept":["application/pdf",".txt"],"maxCount":2}"#,
                                     initialCredit: 4 * 1024 * 1024))
        XCTAssertEqual(picker.presented, 1)
        XCTAssertEqual(picker.filters, [.mimeType("application/pdf"), .fileExtension("txt")])
        XCTAssertEqual(picker.maxCount, 2)
        XCTAssertTrue(host.promptGate.isBusy, "the picker holds the prompt slot")
        picker.selected?()
        XCTAssertFalse(host.promptGate.isBusy)
        var released: [String] = []
        let a = Data((0..<70_000).map { UInt8($0 % 253) })
        let b = Data("hello".utf8)
        picker.completion?(.picked([
            PickedDocument(name: "report.pdf", contentType: "application/pdf", data: a, release: { released.append("a") }),
            PickedDocument(name: "notes.txt", contentType: "text/plain", data: b, release: { released.append("b") }),
            PickedDocument(name: "extra.txt", contentType: "text/plain", data: b, release: { released.append("c") }),
        ]))
        XCTAssertEqual(released, ["c"], "an item beyond maxCount is released at once")
        clock.drainTurns()
        let starts = events(1).filter { $0["kind"]?.stringValue == "blobStart" }
        XCTAssertEqual(starts.map { $0["bytes"]?.int64Value }, [70_000, 5], "picked files declare their size")
        XCTAssertNil(starts.first?["name"], "name rides only on the terminal item")
        XCTAssertEqual(uploaded(1), [0: a, 1: b])
        let items = responses().last?["result"]?["items"]?.arrayValue ?? []
        XCTAssertEqual(items.map { $0["name"]?.stringValue }, ["report.pdf", "notes.txt"])
        XCTAssertEqual(items.map { $0["sha256"]?.stringValue }, [r3sha(a), r3sha(b)])
        XCTAssertEqual(Set(released), ["a", "b", "c"], "released once the upload ended")
        XCTAssertEqual(progress(1), ["pendingConsent", "running"])
    }

    func testFilePickDismissalCancelAndBadAccept() async {
        let picker = FakeDocumentPicker()
        let host = makeHost([FilePickDriver(picker: picker)])
        host.handleMessage(r3request(id: 1, capability: "file.pick", params: #"{"accept":[],"maxCount":1}"#))
        picker.completion?(.dismissed)
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(detail(responses().last), "picker-dismissed")

        host.handleMessage(r3request(id: 2, capability: "file.pick", params: #"{"accept":[],"maxCount":1}"#))
        host.handleMessage(r3control(id: 2, #"{"cancel":true}"#))
        XCTAssertEqual(picker.handle?.cancelled, true)
        XCTAssertEqual(code(responses().last), "cancelled")

        host.handleMessage(r3request(id: 3, capability: "file.pick", params: #"{"accept":["image/png;q=1"],"maxCount":1}"#))
        XCTAssertEqual(code(responses().last), "invalidParams")
        XCTAssertEqual(picker.presented, 2)

        host.handleMessage(r3request(id: 4, capability: "file.pick", params: #"{"accept":[],"maxCount":1}"#))
        picker.completion?(.tooLarge)
        XCTAssertEqual(code(responses().last), "throttled")
        picker.available = false
        host.handleMessage(r3request(id: 5, capability: "file.pick", params: #"{"accept":[],"maxCount":1}"#))
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertFalse(host.promptGate.isBusy)
    }

    // MARK: C1 — file.save download plane

    private func saveParams(_ data: Data, name: String = "report.pdf", sha: String? = nil) -> String {
        #"{"channel":0,"name":"\#(name)","contentType":"application/pdf","bytes":\#(data.count),"sha256":"\#(sha ?? r3sha(data))"}"#
    }

    private func saveHost(_ destination: FakeDestinationPicker, _ presenter: FakePresenter,
                          window: UInt64 = FileSaveDriver.maxWindow) -> DeviceHost {
        makeHost([FileSaveDriver(destination: destination, presenter: presenter, window: window)])
    }

    func testFileSaveGrantsOnlyAfterConsentAndDestinationThenStreamsBounded() async {
        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let host = saveHost(destination, presenter)
        let data = Data((0..<600_000).map { UInt8(($0 * 7) % 256) })
        host.handleMessage(r3request(id: 1, capability: "file.save", params: saveParams(data)))
        XCTAssertEqual(progress(1), ["pendingConsent"])
        XCTAssertTrue(grants(1).isEmpty, "no credit before consent")
        XCTAssertEqual(presenter.presented.last?.operation, "save a .pdf file (586 KB) to your device")
        XCTAssertEqual(presenter.presented.last?.origin, "wss://app.example.com")
        presenter.completion?(true)
        XCTAssertEqual(destination.requests.first?.name, "report.pdf")
        XCTAssertEqual(destination.requests.first?.bytes, 600_000)
        XCTAssertTrue(grants(1).isEmpty, "no credit before the destination is chosen")
        XCTAssertTrue(host.promptGate.isBusy)

        let sink = FakeFileSink()
        sink.holdWrites = true
        destination.completion?(.chosen(sink))
        XCTAssertFalse(host.promptGate.isBusy)
        XCTAssertEqual(progress(1), ["pendingConsent", "running"])
        XCTAssertEqual(grants(1), [262_144], "one bounded window (256 KiB)")

        // Four 64 KiB frames fill the window; the writes are still in flight,
        // so no credit is replenished and a fifth frame is a violation-free
        // impossibility for a well-behaved server.
        let chunk = DeviceProtocolConstants.maxBulkChunkBytes
        var seq: UInt32 = 0
        var offset = 0
        func send(_ n: Int) {
            host.handleFrame(frame(1, seq: seq, data[offset..<(offset + n)]))
            seq += 1
            offset += n
        }
        for _ in 0..<4 { send(chunk) }
        XCTAssertEqual(sink.heldCount, 4)
        XCTAssertEqual(grants(1), [262_144], "credit is replenished only by durable writes")
        sink.flush()
        XCTAssertEqual(grants(1).reduce(0, +), 524_288)
        // Outstanding credit never exceeds one window.
        while offset < data.count {
            send(min(chunk, data.count - offset))
            let outstanding = grants(1).reduce(0, +) - Int64(offset)
            XCTAssertLessThanOrEqual(outstanding, 262_144)
            sink.flush()
        }
        XCTAssertEqual(grants(1).reduce(0, +), 600_000, "never granted past the declaration")
        XCTAssertEqual(sink.data, data)
        XCTAssertEqual(sink.commits, 1)
        XCTAssertEqual(responses().last?["result"]?["bytesWritten"]?.int64Value, 600_000)
        XCTAssertEqual(sink.discarded, 0)
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    func testFileSaveCommitsOnlyAfterPendingWritesFinish() async {
        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let host = saveHost(destination, presenter)
        let data = Data("hypen-saved".utf8)
        host.handleMessage(r3request(id: 1, capability: "file.save", params: saveParams(data)))
        presenter.completion?(true)
        let sink = FakeFileSink()
        sink.holdWrites = true
        destination.completion?(.chosen(sink))
        XCTAssertEqual(grants(1), [11], "the window never exceeds the declaration")
        host.handleFrame(frame(1, seq: 0, data))
        XCTAssertEqual(sink.commits, 0, "verified, but the write is still in flight")
        XCTAssertTrue(responses().isEmpty)
        sink.flush()
        XCTAssertEqual(sink.commits, 1)
        XCTAssertEqual(responses().last?["result"]?["bytesWritten"]?.int64Value, 11)
    }

    func testFileSaveVerificationFailureAndEveryOtherEndDiscardPartialOutput() async {
        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let host = saveHost(destination, presenter, window: 4)
        let data = Data("hypen-saved".utf8)
        var sinks: [FakeFileSink] = []
        func begin(_ id: UInt32, params: String? = nil, timeoutMs: UInt64 = 300_000) {
            host.handleMessage(r3request(id: id, capability: "file.save", params: params ?? saveParams(data),
                                         timeoutMs: timeoutMs))
            presenter.completion?(true)
            let sink = FakeFileSink()
            sinks.append(sink)
            destination.completion?(.chosen(sink))
            XCTAssertEqual(grants(Int64(id)), [4], "window bounded by the driver setting")
        }
        // sha256 mismatch → invalidParams, never committed.
        begin(1, params: saveParams(data, sha: r3sha(Data("hypen-SAVED".utf8))))
        host.handleFrame(frame(1, seq: 0, data.prefix(4)))
        host.handleFrame(frame(1, seq: 1, data[4..<8]))
        host.handleFrame(frame(1, seq: 2, data[8...]))
        XCTAssertEqual(code(responses().last), "invalidParams")
        XCTAssertEqual(sinks[0].commits, 0)
        XCTAssertEqual(sinks[0].discarded, 1)
        // Server cancel mid-download.
        begin(2)
        host.handleFrame(frame(2, seq: 0, data.prefix(4)))
        host.handleMessage(r3control(id: 2, #"{"cancel":true}"#))
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(sinks[1].discarded, 1)
        // Deadline.
        begin(3, timeoutMs: 5_000)
        clock.advance(by: 6)
        XCTAssertEqual(code(responses().last), "timeout")
        XCTAssertEqual(sinks[2].discarded, 1)
        // A write failure.
        begin(4)
        sinks[3].failWrites = true
        host.handleFrame(frame(4, seq: 0, data.prefix(4)))
        XCTAssertEqual(code(responses().last), "internal")
        XCTAssertEqual(detail(responses().last), "write-failed")
        XCTAssertEqual(sinks[3].discarded, 1)
        // A commit failure.
        begin(5)
        sinks[4].commitResult = false
        host.handleFrame(frame(5, seq: 0, data.prefix(4)))
        host.handleFrame(frame(5, seq: 1, data[4..<8]))
        host.handleFrame(frame(5, seq: 2, data[8...]))
        XCTAssertEqual(code(responses().last), "internal")
        XCTAssertEqual(detail(responses().last), "commit-failed")
        XCTAssertEqual(sinks[4].discarded, 1)
        // Lease expiry (no renewals).
        let leased = DeviceHost(origin: "wss://app.example.com",
                                drivers: [FileSaveDriver(destination: destination, presenter: presenter)],
                                options: DeviceHost.Options(leaseExpiry: 15), clock: clock,
                                promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        leased.requiresCoreStreamFirst = false
        let t2 = RecordingTransport()
        leased.attach(t2)
        leased.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: leased.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1)
        }))
        leased.handleMessage(r3request(id: 1, capability: "file.save", params: saveParams(data)))
        presenter.completion?(true)
        let leasedSink = FakeFileSink()
        destination.completion?(.chosen(leasedSink))
        clock.advance(by: 16)
        XCTAssertEqual(t2.messages.last?["error"]?["code"]?.stringValue, "connectionLost")
        XCTAssertEqual(leasedSink.discarded, 1)
        // Detach (socket gone).
        begin(6)
        host.detach()
        XCTAssertEqual(sinks[5].discarded, 1)
    }

    func testFileSaveRefusalDismissalAndLateDestination() async {
        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let host = saveHost(destination, presenter)
        let data = Data("x".utf8)
        host.handleMessage(r3request(id: 1, capability: "file.save", params: saveParams(data)))
        presenter.completion?(false)
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertTrue(destination.requests.isEmpty)
        clock.advance(by: 120)

        host.handleMessage(r3request(id: 2, capability: "file.save", params: saveParams(data)))
        presenter.completion?(true)
        destination.completion?(.dismissed)
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(detail(responses().last), "picker-dismissed")

        // Server cancel while the destination picker is open; a late choice
        // is discarded, never written.
        host.handleMessage(r3request(id: 3, capability: "file.save", params: saveParams(data)))
        presenter.completion?(true)
        host.handleMessage(r3control(id: 3, #"{"cancel":true}"#))
        XCTAssertEqual(destination.handle?.cancelled, true)
        let late = FakeFileSink()
        destination.completion?(.chosen(late))
        XCTAssertEqual(late.discarded, 1)
        XCTAssertTrue(grants(3).isEmpty)
        XCTAssertFalse(host.promptGate.isBusy)
    }

    func testSafeFileNamesAndHostOwnedLabels() async {
        XCTAssertEqual(DeviceCaptureSupport.safeFileName("../etc/passwd"), ".._etc_passwd")
        XCTAssertEqual(DeviceCaptureSupport.safeFileName(""), "download")
        XCTAssertEqual(DeviceCaptureSupport.safeFileName(".."), "download")
        XCTAssertEqual(DeviceCaptureSupport.safeFileName("  a\u{0}b\\c\n "), "a_b_c_")
        XCTAssertEqual(DeviceCaptureSupport.safeFileName("invoice\u{202E}fdp.exe"), "invoice_fdp.exe", "bidi override")
        XCTAssertEqual(DeviceCaptureSupport.safeFileName(String(repeating: "é", count: 300)).unicodeScalars.count, 255)
        XCTAssertEqual(DeviceCaptureSupport.fileExtension("a.PDF"), "pdf")
        XCTAssertEqual(DeviceCaptureSupport.fileExtension(".hidden"), "")
        XCTAssertEqual(DeviceCaptureSupport.fileExtension("x.not ok"), "")
        XCTAssertEqual(FileSaveDriver.label(name: "evil name.exe", bytes: 1_048_576), "save a .exe file (1.0 MB) to your device")
        XCTAssertEqual(FileSaveDriver.label(name: "README", bytes: 12), "save a file (12 B) to your device")

        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let host = saveHost(destination, presenter)
        let data = Data("x".utf8)
        host.handleMessage(r3request(id: 1, capability: "file.save", params: saveParams(data, name: "a/b\\u0000c.txt")))
        presenter.completion?(true)
        XCTAssertEqual(destination.requests.first?.name, "a_b_c.txt", "the destination picker gets the sanitized name")
    }

    // MARK: C2 — camera.capture

    private func cameraHost(_ camera: FakeCamera, _ authority: FakeAuthority) -> DeviceHost {
        makeHost([CameraCaptureDriver(capturer: camera, authority: authority)])
    }

    func testCameraPhotoIsCapturedUploadedAndVerified() async {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted]
        let host = cameraHost(camera, authority)
        host.handleMessage(r3request(id: 2, capability: "camera.capture", params: #"{"mode":"photo","facing":"back"}"#,
                                     timeoutMs: 600_000, initialCredit: 65_536))
        XCTAssertEqual(camera.requests, [CameraCaptureRequest(mode: .photo, facing: .back, maxDuration: nil)])
        XCTAssertEqual(progress(2), ["pendingConsent"])
        XCTAssertTrue(host.promptGate.isBusy, "the capture UI holds the prompt slot")
        camera.captured?()
        XCTAssertFalse(host.promptGate.isBusy)
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0] + Array("hypen-photo-bytes".utf8) + [0xFF, 0xD9])
        camera.completion?(.captured(PickedMedia(contentType: "image/jpeg", data: jpeg)))
        clock.drainTurns()
        XCTAssertEqual(progress(2), ["pendingConsent", "running"])
        let start = events(2).first { $0["kind"]?.stringValue == "blobStart" }
        XCTAssertEqual(start?["bytes"]?.int64Value, Int64(jpeg.count), "a captured file declares its size")
        XCTAssertEqual(start?["contentType"]?.stringValue, "image/jpeg")
        XCTAssertEqual(uploaded(2), [0: jpeg])
        let items = responses().last?["result"]?["items"]?.arrayValue ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?["sha256"]?.stringValue, r3sha(jpeg))
        XCTAssertTrue(authority.requested.isEmpty, "a granted permission is not requested again")
    }

    func testCameraVideoRequestsCameraThenMicrophoneAndPassesTheLimit() async {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .prompt, .microphone: .prompt]
        authority.requestResult = .granted
        let host = cameraHost(camera, authority)
        host.handleMessage(r3request(id: 1, capability: "camera.capture",
                                     params: #"{"mode":"video","facing":"front","maxDurationMs":15000}"#,
                                     timeoutMs: 600_000, initialCredit: 16))
        XCTAssertEqual(authority.requested, [.camera, .microphone])
        XCTAssertEqual(camera.requests, [CameraCaptureRequest(mode: .video, facing: .front, maxDuration: 15)])
        camera.captured?()
        let movie = Data((0..<40).map { UInt8($0) })
        camera.completion?(.captured(PickedMedia(contentType: "video/quicktime", data: movie)))
        clock.drainTurns()
        XCTAssertEqual(uploaded(1), [0: movie.prefix(16)], "credit-paced")
        XCTAssertEqual(pausedTransitions(1), [true])
        host.handleMessage(r3control(id: 1, #"{"grant":64}"#))
        clock.drainTurns()
        XCTAssertEqual(uploaded(1), [0: movie])
        XCTAssertEqual(pausedTransitions(1), [true, false])
        XCTAssertEqual(responses().last?["result"]?["items"]?.arrayValue?.first?["contentType"]?.stringValue, "video/quicktime")
    }

    func testCameraRefusalsDismissalAndAvailability() async {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted, .microphone: .denied]
        let host = cameraHost(camera, authority)
        // Microphone refused for video: denied, no capture UI, no progress.
        host.handleMessage(r3request(id: 1, capability: "camera.capture", params: #"{"mode":"video"}"#, timeoutMs: 600_000))
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertEqual(detail(responses().last), "microphone")
        XCTAssertTrue(progress(1).isEmpty)
        // The OS prompt refused.
        authority.statuses[.camera] = .prompt
        authority.requestResult = .denied
        host.handleMessage(r3request(id: 2, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertEqual(detail(responses().last), "camera")
        XCTAssertTrue(camera.requests.isEmpty)
        XCTAssertFalse(host.promptGate.isBusy)
        // Dismissal is cancelled, not denied.
        authority.statuses[.camera] = .granted
        host.handleMessage(r3request(id: 3, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        camera.completion?(.dismissed)
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(detail(responses().last), "capture-dismissed")
        // Server cancel closes the capture UI.
        host.handleMessage(r3request(id: 4, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        host.handleMessage(r3control(id: 4, #"{"cancel":true}"#))
        XCTAssertEqual(camera.handle?.cancelled, true)
        // Too large, no camera, missing usage description.
        host.handleMessage(r3request(id: 5, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        camera.completion?(.tooLarge)
        XCTAssertEqual(code(responses().last), "throttled")
        camera.hasCamera = false
        host.handleMessage(r3request(id: 6, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        XCTAssertEqual(detail(responses().last), "no-camera")
        camera.hasCamera = true
        authority.missing = [.camera: "NSCameraUsageDescription"]
        host.handleMessage(r3request(id: 7, capability: "camera.capture", params: #"{"mode":"photo"}"#, timeoutMs: 600_000))
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(detail(responses().last), "not-declared:camera")
        // Photo with a video-only limit: invalidParams at decode.
        host.handleMessage(r3request(id: 8, capability: "camera.capture", params: #"{"mode":"photo","maxDurationMs":1000}"#,
                                     timeoutMs: 600_000))
        XCTAssertEqual(code(responses().last), "invalidParams")
        XCTAssertEqual(camera.requests.count, 3)
    }

    func testCameraItemTypeMustFitTheRequestedMode() async {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted]
        let host = cameraHost(camera, authority)
        host.handleMessage(r3request(id: 1, capability: "camera.capture", params: #"{"mode":"photo"}"#,
                                     timeoutMs: 600_000, initialCredit: 1024))
        camera.completion?(.captured(PickedMedia(contentType: "video/mp4", data: Data([1, 2, 3]))))
        XCTAssertEqual(code(responses().last), "internal")
        XCTAssertTrue(transport.frames.isEmpty, "nothing uploaded")

        // The host enforces it too, whatever the driver: a video request
        // announcing an image is disallowed metadata (§2.4).
        let driver = HoldDriver("camera.capture")
        let other = RecordingTransport()
        let host2 = DeviceHost(origin: "wss://app.example.com", drivers: [driver], clock: clock,
                               promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
        host2.requiresCoreStreamFirst = false
        host2.attach(other)
        host2.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: host2.advertisement.capabilities.map {
            CapabilitySelection(name: $0.name, version: 1)
        }))
        host2.handleMessage(r3request(id: 1, capability: "camera.capture", params: #"{"mode":"video"}"#,
                                      timeoutMs: 600_000, initialCredit: 1024))
        XCTAssertNil(driver.operations[0].openBlob(contentType: "image/jpeg"))
        XCTAssertEqual(other.messages.last?["error"]?["code"]?.stringValue, "internal")
        XCTAssertFalse(other.messages.contains { $0["event"]?["kind"]?.stringValue == "blobStart" })
        XCTAssertEqual(DevicePayloads.blobStartViolation("camera.capture", params: ["mode": .string("video")],
                                                         contentType: "video/webm"), nil)
        XCTAssertNil(DevicePayloads.blobStartViolation("gallery.pick", params: [:], contentType: "video/webm"))
    }

    // MARK: C3 — mic.record

    private func micHost(_ factory: FakeAudioFactory, _ authority: FakeAuthority, _ presenter: FakePresenter,
                         _ indicator: FakeIndicator, bufferLimit: Int = MicRecordDriver.defaultBufferLimit) -> DeviceHost {
        makeHost([MicRecordDriver(factory: factory, authority: authority, presenter: presenter, indicator: indicator,
                                  bufferLimit: bufferLimit)])
    }

    private func micParams(rate: Int = 48_000, channels: Int? = nil, maxDurationMs: Int? = nil) -> String {
        var fields = [#""sampleRate":\#(rate)"#, #""format":"pcm16""#]
        if let channels = channels { fields.append(#""channels":\#(channels)"#) }
        if let max = maxDurationMs { fields.append(#""maxDurationMs":\#(max)"#) }
        return "{" + fields.joined(separator: ",") + "}"
    }

    func testMicRecordStreamsPCM16UnderCreditAndStopEndsWithSuccess() async {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = micHost(factory, authority, presenter, indicator)
        host.handleMessage(r3request(id: 2, capability: "mic.record", params: micParams(channels: 2, maxDurationMs: 600_000),
                                     timeoutMs: 600_000, initialCredit: 32))
        XCTAssertEqual(progress(2), ["pendingConsent"])
        XCTAssertEqual(presenter.presented.last?.operation, "record audio from your microphone (stereo, 48000 Hz)")
        XCTAssertTrue(factory.sources.isEmpty, "nothing captured before consent")
        presenter.completion?(true)
        XCTAssertEqual(indicator.shown.last?.activity, MicRecordDriver.activityLabel)
        XCTAssertEqual(indicator.shown.last?.origin, "wss://app.example.com")
        XCTAssertFalse(host.promptGate.isBusy, "the indicator is not a prompt")
        let source = factory.sources[0]
        XCTAssertEqual(source.format, AudioCaptureFormat(sampleRate: 48_000, channels: 2))
        XCTAssertEqual(progress(2), ["pendingConsent", "running"])
        let start = events(2).first { $0["kind"]?.stringValue == "blobStart" }
        XCTAssertEqual(start?["contentType"]?.stringValue, "audio/L16")
        XCTAssertNil(start?["bytes"], "a live recording has no declared size")

        let a = Data((0..<32).map { UInt8($0) })
        let b = Data((32..<96).map { UInt8($0) })
        source.emit(.samples(a))
        source.emit(.samples(b))
        clock.drainTurns()
        XCTAssertEqual(uploaded(2), [0: a], "frames as credit allows")
        XCTAssertEqual(pausedTransitions(2), [true])
        host.handleMessage(r3control(id: 2, #"{"grant":64}"#))
        clock.drainTurns()
        XCTAssertEqual(uploaded(2), [0: a + b])
        XCTAssertEqual(pausedTransitions(2), [true, false])
        XCTAssertTrue(responses().isEmpty, "still recording")

        indicator.stop?() // the user's Stop
        clock.drainTurns()
        XCTAssertTrue(source.stopped)
        XCTAssertEqual(indicator.handle?.cancelled, true)
        let result = responses().last?["result"]
        XCTAssertEqual(result?["durationMs"]?.int64Value, 1, "24 stereo frames at 48 kHz = 0.5 ms, rounded")
        XCTAssertEqual(result?["item"]?["bytes"]?.int64Value, 96)
        XCTAssertEqual(result?["item"]?["sha256"]?.stringValue, r3sha(a + b))
        XCTAssertEqual(result?["item"]?["contentType"]?.stringValue, "audio/L16")
    }

    func testMicRecordEndsThrottledWhenCreditStarvesPastTheBoundedWindow() async {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = micHost(factory, authority, presenter, indicator, bufferLimit: 65_536)
        host.handleMessage(r3request(id: 2, capability: "mic.record", params: micParams(rate: 16_000),
                                     timeoutMs: 600_000, initialCredit: 16))
        presenter.completion?(true)
        let source = factory.sources[0]
        let block = Data(repeating: 0x11, count: 8_192)
        for _ in 0..<8 { source.emit(.samples(block)) }
        clock.drainTurns()
        XCTAssertTrue(responses().isEmpty, "exactly the window may queue")
        source.emit(.samples(block))
        clock.drainTurns()
        XCTAssertEqual(code(responses().last), "throttled")
        XCTAssertEqual(detail(responses().last), "capture-buffer-full")
        XCTAssertTrue(source.stopped)
        XCTAssertEqual(indicator.handle?.cancelled, true)
        XCTAssertEqual(uploaded(2)[0]?.count, 16, "only granted bytes were sent")
    }

    func testMicRecordMaxDurationTruncatesToWholeFramesAndCompletes() async {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = micHost(factory, authority, presenter, indicator)
        // 8 kHz mono, 10 ms → 80 frames → 160 bytes.
        host.handleMessage(r3request(id: 1, capability: "mic.record", params: micParams(rate: 8_000, maxDurationMs: 10),
                                     timeoutMs: 600_000, initialCredit: 262_144))
        presenter.completion?(true)
        let source = factory.sources[0]
        XCTAssertEqual(source.format, AudioCaptureFormat(sampleRate: 8_000, channels: 1), "channels default to 1")
        source.emit(.samples(Data(repeating: 1, count: 101))) // odd: trimmed to 100
        source.emit(.samples(Data(repeating: 2, count: 100))) // truncated to the remaining 60
        clock.drainTurns()
        XCTAssertTrue(source.stopped, "the limit stops capture")
        let result = responses().last?["result"]
        XCTAssertEqual(result?["item"]?["bytes"]?.int64Value, 160)
        XCTAssertEqual(result?["durationMs"]?.int64Value, 10)
        XCTAssertEqual(uploaded(1)[0], Data(repeating: 1, count: 100) + Data(repeating: 2, count: 60))
        XCTAssertEqual(MicRecordDriver.durationMs(frames: 48_000, sampleRate: 48_000), 1_000)
        XCTAssertEqual(MicRecordDriver.durationMs(frames: 0, sampleRate: 8_000), 0)
    }

    func testMicRecordSuspendAndInterruptionStopNormally() async {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = micHost(factory, authority, presenter, indicator)
        host.handleMessage(r3request(id: 1, capability: "mic.record", params: micParams(rate: 16_000),
                                     timeoutMs: 600_000, initialCredit: 1024))
        presenter.completion?(true)
        factory.sources[0].emit(.samples(Data(repeating: 3, count: 320)))
        host.suspend() // backgrounding
        clock.drainTurns()
        XCTAssertTrue(factory.sources[0].stopped)
        XCTAssertEqual(responses().last?["result"]?["durationMs"]?.int64Value, 10)
        XCTAssertEqual(responses().last?["result"]?["item"]?["bytes"]?.int64Value, 320)

        host.handleMessage(r3request(id: 2, capability: "mic.record", params: micParams(rate: 16_000),
                                     timeoutMs: 600_000, initialCredit: 1024))
        presenter.completion?(true)
        factory.sources[1].emit(.interrupted)
        clock.drainTurns()
        XCTAssertEqual(responses().last?["result"]?["item"]?["bytes"]?.int64Value, 0)
        XCTAssertFalse(transport.frames.contains { frame in
            if case let .success(d) = DeviceFrameCodec.decode(frame) { return d.header.requestId == 2 }
            return false
        }, "an empty recording sends no frame")

        host.handleMessage(r3request(id: 3, capability: "mic.record", params: micParams(rate: 16_000),
                                     timeoutMs: 600_000, initialCredit: 1024))
        presenter.completion?(true)
        factory.sources[2].emit(.failed("engine-error"))
        XCTAssertEqual(code(responses().last), "internal")
        XCTAssertTrue(factory.sources[2].stopped)

        host.handleMessage(r3request(id: 4, capability: "mic.record", params: micParams(rate: 16_000),
                                     timeoutMs: 600_000, initialCredit: 1024))
        presenter.completion?(true)
        host.handleMessage(r3control(id: 4, #"{"cancel":true}"#))
        XCTAssertTrue(factory.sources[3].stopped, "server cancel releases the microphone")
        XCTAssertEqual(indicator.handle?.cancelled, true)
    }

    func testMicRecordRefusalsAndMissingIndicator() async {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .denied]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let host = micHost(factory, authority, presenter, indicator)
        host.handleMessage(r3request(id: 1, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertEqual(detail(responses().last), "microphone")
        XCTAssertTrue(presenter.presented.isEmpty)

        authority.statuses[.microphone] = .prompt
        authority.requestResult = .denied
        host.handleMessage(r3request(id: 2, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        presenter.completion?(true)
        XCTAssertEqual(authority.requested, [.microphone], "OS prompt after the host consent")
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertFalse(host.promptGate.isBusy)

        authority.statuses[.microphone] = .granted
        host.handleMessage(r3request(id: 3, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        presenter.completion?(false)
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertEqual(detail(responses().last), "host-refused")
        clock.advance(by: 700)

        indicator.available = false
        host.handleMessage(r3request(id: 4, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        presenter.completion?(true)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(detail(responses().last), "no-activity-indicator")
        XCTAssertTrue(factory.sources.isEmpty, "never records without a visible indicator")

        indicator.available = true
        factory.startFailure = "no-input"
        host.handleMessage(r3request(id: 5, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        presenter.completion?(true)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(detail(responses().last), "no-input")
        XCTAssertEqual(indicator.handle?.cancelled, true)

        authority.missing = [.microphone: "NSMicrophoneUsageDescription"]
        host.handleMessage(r3request(id: 6, capability: "mic.record", params: micParams(), timeoutMs: 600_000))
        XCTAssertEqual(detail(responses().last), "not-declared:microphone")
    }

    func testPCM16EncodingIsLittleEndianClampedAndInterleaved() async {
        XCTAssertEqual(DevicePCM16.encode(interleaved: [0, 1, -1, 2, -2, 0.5, .nan]),
                       Data([0x00, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0xFF, 0x7F, 0x00, 0x80, 0x00, 0x40, 0x00, 0x00]))
        let samples: [Int16] = [100, -100, 800, -800]
        let bytes = samples.withUnsafeBufferPointer { DevicePCM16.littleEndianBytes($0) }
        XCTAssertEqual(bytes, Data([0x64, 0x00, 0x9C, 0xFF, 0x20, 0x03, 0xE0, 0xFC]))
    }

    // MARK: C4 — bluetooth.select

    private let heartRate = "0000180d-0000-1000-8000-00805f9b34fb"

    func testBluetoothSelectListsAFilteredLiveScanAndReturnsIdentityOnly() async {
        let factory = FakeFilteredScannerFactory()
        let chooser = FakeChooser()
        let host = makeHost([BluetoothSelectDriver(factory: factory, chooser: chooser)])
        host.handleMessage(r3request(id: 2, capability: "bluetooth.select",
                                     params: #"{"services":["\#(heartRate)"],"namePrefix":"Polar"}"#))
        XCTAssertEqual(factory.services, [[heartRate]], "services become the scan filter")
        XCTAssertEqual(chooser.origins, ["wss://app.example.com"])
        XCTAssertEqual(progress(2), ["pendingConsent"])
        XCTAssertTrue(host.promptGate.isBusy, "the chooser is the gate")
        let scanner = factory.scanners[0]
        scanner.handler?(.scanning)
        // Discoveries report what they advertise (the driver re-checks the
        // filter): the full form and CoreBluetooth's short form both match.
        let hr = [heartRate], hrShort = ["180D"]
        scanner.handler?(.discovered(id: "dev-7f3a", name: "Polar H10", rssi: -60, services: hr))
        scanner.handler?(.discovered(id: "dev-2", name: "polar lower", rssi: -30, services: hr))  // exact code points
        scanner.handler?(.discovered(id: "dev-3", name: nil, rssi: -20, services: hr))           // no name: no prefix match
        scanner.handler?(.discovered(id: "dev-4", name: "Polar OH1", rssi: -40, services: hrShort))
        scanner.handler?(.discovered(id: "dev-7f3a", name: "Polar H10", rssi: -50, services: hr)) // updated in place
        XCTAssertEqual(chooser.session?.lists.last?.map { $0.id }, ["dev-4", "dev-7f3a"], "strongest first")
        XCTAssertEqual(chooser.session?.lists.last?.last?.rssi, -50)
        chooser.completion?(.selected(id: "dev-7f3a"))
        XCTAssertEqual(responses().last?["result"], .object(["device": .object(["id": .string("dev-7f3a"),
                                                                                "name": .string("Polar H10")])]))
        XCTAssertTrue(scanner.stopped)
        XCTAssertEqual(chooser.session?.cancelled, true, "the chooser closes with the scan")
        XCTAssertFalse(host.promptGate.isBusy)

        host.handleMessage(r3request(id: 3, capability: "bluetooth.select", params: "{}"))
        XCTAssertEqual(factory.services.last, [])
        factory.scanners[1].handler?(.discovered(id: "dev-anonymous", name: nil, rssi: -70))
        chooser.completion?(.selected(id: "dev-anonymous"))
        XCTAssertEqual(responses().last?["result"], .object(["device": .object(["id": .string("dev-anonymous")])]))
    }

    func testBluetoothSelectCancelServerCancelAndRadioStates() async {
        let factory = FakeFilteredScannerFactory()
        let chooser = FakeChooser()
        let host = makeHost([BluetoothSelectDriver(factory: factory, chooser: chooser)])
        host.handleMessage(r3request(id: 1, capability: "bluetooth.select", params: "{}"))
        chooser.completion?(.dismissed)
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(detail(responses().last), "chooser-dismissed")
        XCTAssertTrue(factory.scanners[0].stopped)

        host.handleMessage(r3request(id: 2, capability: "bluetooth.select", params: #"{"namePrefix":"H"}"#))
        host.handleMessage(r3control(id: 2, #"{"cancel":true}"#))
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertEqual(chooser.session?.cancelled, true)
        XCTAssertTrue(factory.scanners[1].stopped)
        chooser.completion?(.selected(id: "late")) // ignored
        XCTAssertEqual(responses().count, 2)

        host.handleMessage(r3request(id: 3, capability: "bluetooth.select", params: "{}"))
        factory.scanners[2].handler?(.poweredOff)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(detail(responses().last), "powered-off")
        XCTAssertEqual(chooser.session?.cancelled, true)

        host.handleMessage(r3request(id: 4, capability: "bluetooth.select", params: "{}"))
        factory.scanners[3].handler?(.unauthorized)
        XCTAssertEqual(code(responses().last), "denied")
        XCTAssertEqual(detail(responses().last), "bluetooth")

        host.handleMessage(r3request(id: 5, capability: "bluetooth.select", params: "{}"))
        chooser.completion?(.selected(id: "never-seen"))
        XCTAssertEqual(code(responses().last), "internal")

        factory.authorization = .denied
        host.handleMessage(r3request(id: 6, capability: "bluetooth.select", params: "{}"))
        XCTAssertEqual(code(responses().last), "denied")
        factory.authorization = .granted
        chooser.available = false
        host.handleMessage(r3request(id: 7, capability: "bluetooth.select", params: "{}"))
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(factory.scanners.last?.stopped, true, "a chooser that cannot show never scans on")
        factory.missingUsageDescription = "NSBluetoothAlwaysUsageDescription"
        host.handleMessage(r3request(id: 8, capability: "bluetooth.select", params: "{}"))
        XCTAssertEqual(detail(responses().last), "not-declared:bluetooth")
        // Non-canonical UUIDs are refused at decode.
        factory.missingUsageDescription = nil
        host.handleMessage(r3request(id: 9, capability: "bluetooth.select", params: #"{"services":["0x180d"]}"#))
        XCTAssertEqual(code(responses().last), "invalidParams")
        XCTAssertFalse(host.promptGate.isBusy)
        XCTAssertEqual(host.liveOperationCount, 0)
    }

    func testCodePointPrefixNeverUsesCanonicalEquivalence() async {
        XCTAssertTrue(DeviceCaptureSupport.hasPrefix("Polar H10", "Polar"))
        XCTAssertFalse(DeviceCaptureSupport.hasPrefix("Pol", "Polar"))
        XCTAssertFalse(DeviceCaptureSupport.hasPrefix("e\u{301}x", "\u{e9}"), "decomposed ≠ precomposed")
        XCTAssertTrue(DeviceCaptureSupport.hasPrefix("\u{e9}x", "\u{e9}"))
        XCTAssertTrue(DevicePayloads.isCanonicalUUID("0000180d-0000-1000-8000-00805f9b34fb"))
        XCTAssertFalse(DevicePayloads.isCanonicalUUID("0000180D-0000-1000-8000-00805F9B34FB"))
    }

    // MARK: Advertisement

    func testRoundThreeDriversAreAdvertised() async {
        let authority = FakeAuthority()
        let presenter = FakePresenter()
        let host = DeviceHost(origin: "wss://a.example", drivers: [
            FilePickDriver(picker: FakeDocumentPicker()),
            FileSaveDriver(destination: FakeDestinationPicker(), presenter: presenter),
            CameraCaptureDriver(capturer: FakeCamera(), authority: authority),
            MicRecordDriver(factory: FakeAudioFactory(), authority: authority, presenter: presenter,
                            indicator: FakeIndicator()),
            BluetoothSelectDriver(factory: FakeFilteredScannerFactory(), chooser: FakeChooser()),
        ], clock: clock, persistentStore: InMemoryDeviceStore())
        XCTAssertEqual(host.advertisement.capabilities.map { $0.name },
                       ["core.capabilities", "file.pick", "file.save", "camera.capture", "mic.record", "bluetooth.select"])
        XCTAssertTrue(host.advertisement.capabilities.allSatisfy { $0.versions == [1] })
    }
}

// MARK: - Shared round-3 transcripts through the real drivers

/// Replays the round-3 capability transcripts through the REAL iOS drivers
/// (with fakes only at the platform seams), not scripted ones: every client
/// message the transcript shows must be what the driver + host produce, in
/// order, and the uploaded bytes must match. (`DeviceTranscriptTests`
/// replays every transcript's protocol rules with scripted drivers.)
@MainActor
final class DeviceRound3DriverTranscriptTests: XCTestCase, @unchecked Sendable {
    @MainActor
    struct Replay {
        let steps: [DeviceJSON]
        let clock = ManualDeviceClock()
        let transport = RecordingTransport()
        let host: DeviceHost

        init(_ file: String, drivers: [DeviceDriver]) throws {
            let doc = try DeviceFixtures.load("engine-compatibility-tests/fixtures/device/transcripts/\(file).json")
            steps = doc["steps"]?.arrayValue ?? []
            host = DeviceHost(origin: "wss://app.example", drivers: drivers,
                              options: DeviceHost.Options(maxTimeout: 86_400, leaseExpiry: 86_400), clock: clock,
                              promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
            host.attach(transport)
            host.onAck(DeviceAck(protocolVersion: 1, binary: true, capabilities: DeviceRegistry.revisions.map {
                CapabilitySelection(name: $0.capability, version: $0.version)
            }))
        }

        static func frameBytes(_ s: DeviceJSON) -> Data {
            var bytes = DeviceFixtures.bytes(fromHex: s["frame"]?["hex"]?.stringValue ?? "")
            if let fill = s["frame"]?["payloadFill"], let byte = fill["byte"]?.int64Value,
               let length = fill["length"]?.int64Value {
                bytes.append(Data(repeating: UInt8(byte), count: Int(length)))
            }
            return bytes
        }

        static func payload(_ s: DeviceJSON) -> Data {
            guard case let .success(d) = DeviceFrameCodec.decode(frameBytes(s)) else { return Data() }
            return d.payload
        }

        /// Run every step (the core stream included), performing `actions[i]`
        /// before step `i`; returns (expected, produced) client messages and
        /// uploaded bytes for app requests.
        func run(_ actions: [Int: @MainActor () -> Void],
                 normalize: (DeviceJSON) -> DeviceJSON? = { $0 }) -> (expected: [DeviceJSON], produced: [DeviceJSON],
                                                                     expectedBytes: Data, producedBytes: Data) {
            var expected: [DeviceJSON] = []
            var expectedBytes = Data()
            for (i, s) in steps.enumerated() {
                actions[i]?()
                clock.drainTurns()
                let message = s["message"]
                let isCore = message?["id"]?.int64Value == 1 || s["frame"]?["header"]?["requestId"]?.int64Value == 1
                if s["dir"]?.stringValue == "s2c" {
                    if let m = message {
                        host.handleMessage(DeviceFixtures.serialize(m))
                    } else if s["frame"] != nil {
                        host.handleFrame(Self.frameBytes(s))
                    }
                    clock.drainTurns()
                } else if !isCore, s["ignored"]?.boolValue != true {
                    if let m = message {
                        if let n = normalize(m) { expected.append(n) }
                    } else if s["frame"] != nil {
                        expectedBytes.append(Self.payload(s))
                    }
                }
            }
            var produced: [DeviceJSON] = []
            var producedBytes = Data()
            for sent in transport.sent {
                switch sent {
                case let .message(m) where m["id"]?.int64Value != 1:
                    if let n = normalize(m) { produced.append(n) }
                case let .frame(f):
                    if case let .success(d) = DeviceFrameCodec.decode(f), d.header.requestId != 1 {
                        producedBytes.append(d.payload)
                    }
                default:
                    break
                }
            }
            return (expected, produced, expectedBytes, producedBytes)
        }
    }

    func testCameraCapturePhotoTranscript() async throws {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted]
        let replay = try Replay("camera-capture-photo", drivers: [CameraCaptureDriver(capturer: camera, authority: authority)])
        let jpeg = Replay.payload(replay.steps[7])
        let out = replay.run([5: {
            camera.captured?()
            camera.completion?(.captured(PickedMedia(contentType: "image/jpeg", data: jpeg)))
        }])
        XCTAssertEqual(camera.requests, [CameraCaptureRequest(mode: .photo, facing: .back)])
        XCTAssertEqual(out.produced, out.expected)
        XCTAssertEqual(out.producedBytes, out.expectedBytes)
        XCTAssertEqual(out.producedBytes.count, 23)
    }

    func testCameraCaptureCancelledTranscript() async throws {
        let camera = FakeCamera()
        let authority = FakeAuthority()
        authority.statuses = [.camera: .granted, .microphone: .granted]
        let replay = try Replay("camera-capture-cancelled", drivers: [CameraCaptureDriver(capturer: camera, authority: authority)])
        let out = replay.run([
            3: { camera.completion?(.dismissed) },
            4: { authority.statuses[.camera] = .denied },
        ])
        XCTAssertEqual(out.produced, out.expected)
        XCTAssertEqual(camera.requests.count, 1, "nothing presented for the refused camera")
    }

    func testBluetoothSelectSuccessTranscript() async throws {
        let factory = FakeFilteredScannerFactory()
        let chooser = FakeChooser()
        let replay = try Replay("bluetooth-select-success", drivers: [BluetoothSelectDriver(factory: factory, chooser: chooser)])
        var first: FakeChooserSession?
        let out = replay.run([
            5: {
                first = chooser.session
                let hr = ["0000180d-0000-1000-8000-00805f9b34fb"]
                factory.scanners[0].handler?(.discovered(id: "dev-other", name: "Other", rssi: -30, services: hr))
                factory.scanners[0].handler?(.discovered(id: "dev-7f3a", name: "Polar H10", rssi: -55, services: hr))
                chooser.completion?(.selected(id: "dev-7f3a"))
            },
            7: {
                factory.scanners[1].handler?(.discovered(id: "dev-anonymous", name: nil, rssi: -70))
                chooser.completion?(.selected(id: "dev-anonymous"))
            },
        ], normalize: { m in
            // Optional progress (§2.1): this host reports every chooser wait;
            // the transcript shows it for the first request only.
            m["event"]?["state"]?.stringValue == "pendingConsent" ? nil : m
        })
        XCTAssertEqual(factory.services, [["0000180d-0000-1000-8000-00805f9b34fb"], []])
        XCTAssertEqual(first?.lists.last?.map { $0.id }, ["dev-7f3a"], "namePrefix filtered the live list")
        XCTAssertEqual(chooser.session?.lists.last?.map { $0.id }, ["dev-anonymous"])
        XCTAssertEqual(out.produced, out.expected)
        XCTAssertEqual(out.expected.count, 3)
    }

    func testFileSaveNativeDownloadTranscript() async throws {
        let destination = FakeDestinationPicker()
        let presenter = FakePresenter()
        let sink = FakeFileSink()
        let replay = try Replay("file-save-native-download",
                                drivers: [FileSaveDriver(destination: destination, presenter: presenter, window: 65_536)])
        // Credit is an upper bound: the transcript's server-model client
        // re-grants a full window; this host never grants past the
        // declaration. Grant amounts are compared separately.
        let out = replay.run([5: {
            presenter.completion?(true)
            destination.completion?(.chosen(sink))
        }], normalize: { m in
            guard m["control"]?["grant"] != nil else { return m }
            return .object(["type": .string("deviceEvent"), "id": m["id"] ?? .null, "control": .string("grant")])
        })
        XCTAssertEqual(out.produced, out.expected)
        let grants = replay.transport.messages.compactMap { $0["control"]?["grant"]?.int64Value }
        XCTAssertEqual(grants, [65_536, 34_464])
        XCTAssertEqual(sink.data.count, 100_000)
        XCTAssertEqual(sink.commits, 1)
    }

    func testMicRecordStereoEarlyStopTranscript() async throws {
        let factory = FakeAudioFactory()
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let indicator = FakeIndicator()
        let replay = try Replay("mic-record-stereo-early-stop", drivers: [
            MicRecordDriver(factory: factory, authority: authority, presenter: presenter, indicator: indicator),
        ])
        let frames = replay.steps.indices.filter { replay.steps[$0]["frame"] != nil }.map { Replay.payload(replay.steps[$0]) }
        XCTAssertEqual(frames.count, 3)
        let out = replay.run([
            4: { presenter.completion?(true) },
            6: { factory.sources[0].emit(.samples(frames[0])) },
            7: { factory.sources[0].emit(.samples(frames[1])) },
            13: { factory.sources[0].emit(.samples(frames[2])) },
            14: { indicator.stop?() },
        ], normalize: { m in
            // Optional progress (§2.1): this host also reports the consent wait.
            m["event"]?["state"]?.stringValue == "pendingConsent" ? nil : m
        })
        XCTAssertEqual(factory.sources.first?.format, AudioCaptureFormat(sampleRate: 48_000, channels: 2))
        XCTAssertEqual(out.produced, out.expected)
        XCTAssertEqual(out.producedBytes, out.expectedBytes)
    }
}
