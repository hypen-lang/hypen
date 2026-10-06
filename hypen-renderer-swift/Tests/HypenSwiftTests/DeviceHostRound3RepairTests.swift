import XCTest
@testable import HypenSwift

// Round 3, repair round 1 for the iOS DeviceHost:
//
// - `mic.record` (and `bluetooth.scan`) run under the host's OWN
//   always-visible indicator with Stop (`HostDeviceActivityIndicator`, the
//   default of `DeviceHost.iOS()`), so a stock iOS host advertises them;
// - `file.pick` never maps the user's original file: coordinated read, size
//   check before any copy, private first-unlock clone, only the clone mapped
//   (`DeviceFileClone` / `DeviceDocumentLoader`), so truncating the original
//   mid-upload cannot SIGBUS the app;
// - `bluetooth.select` cannot be widened by a scanner backend: the filtered
//   factory method has no default, and the driver re-checks every discovery's
//   advertised services against the request.

// MARK: - Fakes

/// A fake overlay: records what is on screen and can refuse to show or be
/// "lost" (scene backgrounded) on demand.
@MainActor
final class FakeIndicatorSurface: DeviceActivityIndicatorSurface {
    var stopHandler: (@Sendable @MainActor (UInt64) -> Void)?
    var lostHandler: (@Sendable @MainActor () -> Void)?
    var readinessHandler: (@Sendable @MainActor () -> Void)?
    /// Whether a render can make the overlay visible (a foreground scene
    /// exists); a change is reported like a scene transition.
    var canShow = true {
        didSet { if canShow != oldValue { readinessHandler?() } }
    }
    private(set) var visible = false
    private(set) var listed: [DeviceActivityIndicatorEntry] = []
    private(set) var renders = 0
    private(set) var dismissals = 0

    func render(_ entries: [DeviceActivityIndicatorEntry]) -> Bool {
        renders += 1
        XCTAssertFalse(entries.isEmpty, "the overlay is never rendered empty")
        guard canShow else {
            visible = false
            listed = []
            return false
        }
        visible = true
        listed = entries
        return true
    }

    func dismiss() {
        dismissals += 1
        visible = false
        listed = []
    }

    /// The user's Stop on the entry listed at `index`.
    func tapStop(_ index: Int = 0) {
        stopHandler?(listed[index].id)
    }

    /// The overlay's scene went to the background.
    func lose() {
        visible = false
        listed = []
        lostHandler?()
    }
}

/// Records whether the overlay was visible when the microphone opened.
@MainActor
final class WatchedAudioFactory: AudioCaptureFactory {
    let surface: FakeIndicatorSurface
    var sources: [FakeAudioSource] = []
    var visibleAtOpen: [Bool] = []

    init(surface: FakeIndicatorSurface) { self.surface = surface }

    func makeSource() -> AudioCaptureSource {
        visibleAtOpen.append(surface.visible)
        let s = FakeAudioSource()
        sources.append(s)
        return s
    }
}

/// A read coordinator that records its use; it can fail, redirect the read
/// to a materialised copy (an iCloud placeholder), or run a hook mid-read.
final class FakeReadCoordinator: DeviceFileReadCoordinator, @unchecked Sendable {
    var coordinated: [URL] = []
    var fail = false
    var redirect: URL?
    var during: (() -> Void)?
    var cancelled = false

    func coordinateReading(at url: URL, _ reader: (URL) -> Void) -> Bool {
        coordinated.append(url)
        if fail { return false }
        during?()
        reader(redirect ?? url)
        return true
    }

    func cancel() { cancelled = true }
}

@MainActor
private func repairRequest(id: UInt32, capability: String, params: String, timeoutMs: UInt64 = 300_000,
                           initialCredit: UInt64 = 0) -> Data {
    Data(#"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":1,"owner":{"moduleInstanceId":"m-1","activationId":1},"lifetime":"activation","timeoutMs":\#(timeoutMs),"initialCredit":\#(initialCredit),"params":\#(params)}"#.utf8)
}

@MainActor
private func repairControl(id: UInt32, _ control: String) -> Data {
    Data(#"{"type":"deviceEvent","id":\#(id),"control":\#(control)}"#.utf8)
}

// MARK: - Tests

@MainActor
final class DeviceHostRound3RepairTests: XCTestCase, @unchecked Sendable {
    var clock: ManualDeviceClock!
    var transport: RecordingTransport!
    var scratch: URL!

    override func setUp() async throws {
        clock = ManualDeviceClock()
        transport = RecordingTransport()
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypen-repair-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch.appendingPathComponent("clones"),
                                                withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    private var cloneDirectory: URL { scratch.appendingPathComponent("clones") }

    private func makeHost(_ drivers: [DeviceDriver]) -> DeviceHost {
        let host = DeviceHost(origin: "wss://app.example.com", drivers: drivers,
                              options: DeviceHost.Options(leaseExpiry: 10_000), clock: clock,
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

    private func uploaded(_ id: UInt32) -> [UInt16: Data] {
        var out: [UInt16: Data] = [:]
        for frame in transport.frames {
            guard case let .success(d) = DeviceFrameCodec.decode(frame), d.header.requestId == id else { continue }
            out[d.header.channel, default: Data()].append(d.payload)
        }
        return out
    }

    private func write(_ name: String, _ data: Data) throws -> URL {
        let url = scratch.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    private func leftoverClones() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: cloneDirectory.path)) ?? []
    }

    private func bytes(_ count: Int, seed: Int = 7) -> Data {
        Data((0..<count).map { UInt8(($0 * 31 + seed) % 251) })
    }

    // MARK: Host-owned activity indicator

    func testHostIndicatorListsStreamsAndHidesWhenTheLastEnds() async {
        let surface = FakeIndicatorSurface()
        let indicator = HostDeviceActivityIndicator(surface: surface)
        var stops: [String] = []
        let a = indicator.showIndicator(origin: "wss://a.example", activity: "Recording") { stops.append("a") }
        let b = indicator.showIndicator(origin: "wss://b.example", activity: "Scanning") { stops.append("b") }
        XCTAssertNotNil(a)
        XCTAssertNotNil(b)
        XCTAssertTrue(surface.visible)
        XCTAssertEqual(surface.listed.map { $0.origin }, ["wss://a.example", "wss://b.example"])
        XCTAssertEqual(surface.listed.map { $0.activity }, ["Recording", "Scanning"])
        XCTAssertNotEqual(surface.listed[0].id, surface.listed[1].id)

        a?.cancel()
        XCTAssertEqual(surface.listed.map { $0.activity }, ["Scanning"], "an ended stream is unlisted")
        a?.cancel() // idempotent
        XCTAssertEqual(surface.listed.count, 1)
        XCTAssertEqual(surface.dismissals, 0)
        b?.cancel()
        XCTAssertFalse(surface.visible, "hidden once nothing runs")
        XCTAssertEqual(surface.dismissals, 1)
        XCTAssertEqual(stops, [], "cancelling a handle never calls stop")
        XCTAssertTrue(indicator.entries.isEmpty)
    }

    func testHostIndicatorStopEndsOnlyThatStream() async {
        let surface = FakeIndicatorSurface()
        let indicator = HostDeviceActivityIndicator(surface: surface)
        var stops: [String] = []
        var handleA: DeviceCancellable?
        handleA = indicator.showIndicator(origin: "o", activity: "A") {
            stops.append("a")
            handleA?.cancel() // drivers cancel their handle from stop: harmless
        }
        _ = indicator.showIndicator(origin: "o", activity: "B") { stops.append("b") }
        surface.tapStop(0)
        XCTAssertEqual(stops, ["a"])
        XCTAssertEqual(surface.listed.map { $0.activity }, ["B"])
        surface.stopHandler?(9_999) // unknown id: ignored
        XCTAssertEqual(stops, ["a"])
        surface.tapStop(0)
        XCTAssertEqual(stops, ["a", "b"])
        XCTAssertFalse(surface.visible)
    }

    func testHostIndicatorRefusesWhenItCannotBeSeenAndStopsEverythingWhenLost() async {
        let surface = FakeIndicatorSurface()
        let indicator = HostDeviceActivityIndicator(surface: surface)
        var stops: [String] = []
        surface.canShow = false
        XCTAssertNil(indicator.showIndicator(origin: "o", activity: "A") { stops.append("a") },
                     "no visible overlay: the stream must not start")
        XCTAssertFalse(surface.visible)
        XCTAssertTrue(indicator.entries.isEmpty)
        XCTAssertEqual(stops, [])

        surface.canShow = true
        let b = indicator.showIndicator(origin: "o", activity: "B") { stops.append("b") }
        _ = indicator.showIndicator(origin: "o", activity: "C") { stops.append("c") }
        surface.lose()
        XCTAssertEqual(stops, ["b", "c"], "an overlay that can no longer be seen stops every stream")
        XCTAssertTrue(indicator.entries.isEmpty)
        b?.cancel()
        XCTAssertEqual(stops, ["b", "c"])

        // A running stream whose overlay cannot be re-rendered stops too.
        let d = indicator.showIndicator(origin: "o", activity: "D") { stops.append("d") }
        XCTAssertNotNil(d)
        surface.canShow = false
        XCTAssertNil(indicator.showIndicator(origin: "o", activity: "E") { stops.append("e") })
        XCTAssertEqual(stops, ["b", "c", "d"], "the overlay failed: nothing keeps running unseen")
        XCTAssertTrue(indicator.entries.isEmpty)
    }

    func testMicRecordUnderTheHostIndicatorOpensTheMicOnlyOnceVisibleAndStopSucceeds() async {
        let surface = FakeIndicatorSurface()
        let factory = WatchedAudioFactory(surface: surface)
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let host = makeHost([MicRecordDriver(factory: factory, authority: authority, presenter: presenter,
                                             indicator: HostDeviceActivityIndicator(surface: surface))])
        XCTAssertTrue(host.advertisement.capabilities.contains { $0.name == "mic.record" })
        host.handleMessage(repairRequest(id: 2, capability: "mic.record", params: #"{"format":"pcm16","sampleRate":16000}"#,
                                         timeoutMs: 600_000, initialCredit: 1024))
        XCTAssertFalse(surface.visible, "no indicator before consent")
        presenter.completion?(true)
        XCTAssertEqual(factory.visibleAtOpen, [true], "the microphone opens only once the indicator is visible")
        XCTAssertEqual(surface.listed.map { $0.activity }, [MicRecordDriver.activityLabel])
        XCTAssertEqual(surface.listed.map { $0.origin }, ["wss://app.example.com"])

        let pcm = bytes(64)
        factory.sources[0].emit(.samples(pcm))
        clock.drainTurns()
        surface.tapStop()
        clock.drainTurns()
        XCTAssertTrue(factory.sources[0].stopped)
        XCTAssertFalse(surface.visible, "the indicator goes with the recording")
        let result = responses().last?["result"]
        XCTAssertEqual(result?["item"]?["bytes"]?.int64Value, 64)
        XCTAssertEqual(result?["item"]?["sha256"]?.stringValue, DeviceHash.sha256Hex(pcm))
        XCTAssertEqual(uploaded(2), [0: pcm])
    }

    func testMicRecordFailsUnavailableWithoutOpeningTheMicWhenTheOverlayCannotShow() async {
        let surface = FakeIndicatorSurface()
        surface.canShow = false
        let factory = WatchedAudioFactory(surface: surface)
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let host = makeHost([MicRecordDriver(factory: factory, authority: authority, presenter: presenter,
                                             indicator: HostDeviceActivityIndicator(surface: surface))])
        host.handleMessage(repairRequest(id: 1, capability: "mic.record", params: #"{"format":"pcm16","sampleRate":8000}"#,
                                         initialCredit: 1024))
        presenter.completion?(true)
        XCTAssertEqual(code(responses().last), "unavailable")
        XCTAssertEqual(detail(responses().last), "no-activity-indicator")
        XCTAssertTrue(factory.sources.isEmpty, "the microphone never opened")
    }

    func testMicRecordEndsNormallyWhenTheOverlayIsLost() async {
        let surface = FakeIndicatorSurface()
        let factory = WatchedAudioFactory(surface: surface)
        let authority = FakeAuthority()
        authority.statuses = [.microphone: .granted]
        let presenter = FakePresenter()
        let host = makeHost([MicRecordDriver(factory: factory, authority: authority, presenter: presenter,
                                             indicator: HostDeviceActivityIndicator(surface: surface))])
        host.handleMessage(repairRequest(id: 3, capability: "mic.record", params: #"{"format":"pcm16","sampleRate":8000}"#,
                                         initialCredit: 1024))
        presenter.completion?(true)
        let pcm = bytes(32)
        factory.sources[0].emit(.samples(pcm))
        clock.drainTurns()
        surface.lose() // the scene went to the background
        clock.drainTurns()
        XCTAssertTrue(factory.sources[0].stopped, "no recording without a visible indicator")
        XCTAssertEqual(responses().last?["result"]?["item"]?["bytes"]?.int64Value, 32)
    }

    func testBluetoothScanUnderTheHostIndicatorStopsWhenStoppedOrLost() async {
        let surface = FakeIndicatorSurface()
        let factory = FakeScannerFactory()
        let presenter = FakePresenter()
        let host = makeHost([BluetoothScanDriver(factory: factory, presenter: presenter,
                                                 indicator: HostDeviceActivityIndicator(surface: surface))])
        host.handleMessage(repairRequest(id: 1, capability: "bluetooth.scan", params: "{}"))
        presenter.completion?(true)
        XCTAssertEqual(surface.listed.map { $0.activity }, [BluetoothScanDriver.activityLabel])
        surface.tapStop()
        XCTAssertTrue(factory.scanners[0].stopped)
        XCTAssertEqual(code(responses().last), "cancelled")
        XCTAssertFalse(surface.visible)

        host.handleMessage(repairRequest(id: 2, capability: "bluetooth.scan", params: "{}"))
        XCTAssertTrue(surface.visible, "the grant persists; the indicator still shows")
        surface.lose()
        XCTAssertTrue(factory.scanners[1].stopped)
        XCTAssertEqual(responses().count, 2)
    }

    /// `DeviceHost.iOS()` is UIKit-only (not compiled on Linux): pin that the
    /// stock factory brings its own indicator and registers `mic.record`
    /// and `bluetooth.scan` without the app supplying one.
    func testStockIOSHostUsesItsOwnIndicatorForMicAndScan() async throws {
        let source = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOS.swift"), encoding: .utf8)
        guard let start = source.range(of: "public static func iOS("),
              let end = source.range(of: "return host", range: start.upperBound..<source.endIndex) else {
            return XCTFail("DeviceHost.iOS factory not found")
        }
        let body = String(source[start.lowerBound..<end.upperBound])
        XCTAssertTrue(body.contains("activityIndicator ?? HostDeviceActivityIndicator(surface: UIKitDeviceActivityOverlay())"))
        XCTAssertFalse(body.contains("if let indicator = activityIndicator"), "no longer gated on an app indicator")
        XCTAssertTrue(body.contains("MicRecordDriver(factory: AVAudioEngineCaptureFactory()"))
        XCTAssertTrue(body.contains("BluetoothScanDriver(factory: bluetooth"))
        let overlay = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOSCapture.swift"), encoding: .utf8)
        XCTAssertTrue(overlay.contains("public final class UIKitDeviceActivityOverlay: DeviceActivityIndicatorSurface"))
    }

    // MARK: file.pick — private clones, never the original

    func testMappedCloneSurvivesTruncationAndDeletionOfTheOriginal() async throws {
        let content = bytes(300_000)
        let original = try write("doc.bin", content)
        guard case let .success(data) = DeviceFileClone.mappedClone(of: original, limit: 1_000_000,
                                                                   directory: cloneDirectory) else {
            return XCTFail("clone failed")
        }
        // Another process truncates, then removes, the original mid-upload.
        let handle = try FileHandle(forWritingTo: original)
        try handle.truncate(atOffset: 10)
        try handle.close()
        XCTAssertEqual(data.count, content.count)
        XCTAssertEqual(DeviceHash.sha256Hex(data), DeviceHash.sha256Hex(content),
                       "every page of the upload is still readable")
        try FileManager.default.removeItem(at: original)
        XCTAssertEqual(data.suffix(1000), content.suffix(1000))
        XCTAssertEqual(leftoverClones(), [], "the clone is unlinked at once")
    }

    func testMappedCloneChecksSizeBeforeCopying() async throws {
        let original = try write("big.bin", bytes(5000))
        XCTAssertEqual(DeviceFileClone.mappedClone(of: original, limit: 4999, directory: cloneDirectory).failure, .tooLarge)
        XCTAssertEqual(leftoverClones(), [], "nothing copied")
        XCTAssertEqual(DeviceFileClone.mappedClone(of: original, limit: 5000, directory: cloneDirectory).success?.count, 5000)
        let empty = try write("empty.bin", Data())
        XCTAssertEqual(DeviceFileClone.mappedClone(of: empty, limit: 10, directory: cloneDirectory).success, Data())
        XCTAssertEqual(DeviceFileClone.mappedClone(of: scratch, limit: 10, directory: cloneDirectory).failure,
                       .failed("size-unavailable"), "a folder is not a document")
        XCTAssertEqual(DeviceFileClone.mappedClone(of: scratch.appendingPathComponent("missing"), limit: 10,
                                                   directory: cloneDirectory).failure,
                       .failed("size-unavailable"))
        XCTAssertEqual(leftoverClones(), [])
    }

    func testCoordinatedCloneReadsThroughTheCoordinator() async throws {
        let original = try write("placeholder.txt", Data("stub".utf8))
        let materialised = try write("downloaded.txt", Data("the real contents".utf8))
        let coordinator = FakeReadCoordinator()
        coordinator.redirect = materialised
        let result = DeviceFileClone.coordinatedClone(of: original, limit: 1000, coordinator: coordinator,
                                                      directory: cloneDirectory)
        XCTAssertEqual(coordinator.coordinated, [original])
        XCTAssertEqual(result.success, Data("the real contents".utf8), "reads what coordination hands over")

        let failing = FakeReadCoordinator()
        failing.fail = true
        XCTAssertEqual(DeviceFileClone.coordinatedClone(of: original, limit: 1000, coordinator: failing,
                                                        directory: cloneDirectory).failure,
                       .failed("coordination-failed"))

        let big = try write("big.txt", bytes(2000))
        let untouched = FakeReadCoordinator()
        XCTAssertEqual(DeviceFileClone.coordinatedClone(of: big, limit: 1999, coordinator: untouched,
                                                        directory: cloneDirectory).failure, .tooLarge)
        XCTAssertEqual(untouched.coordinated, [], "an oversized file is refused before coordinating (no download)")

        // A file that grows past the limit while it is coordinated.
        let growing = try write("growing.txt", bytes(100))
        let writer = FakeReadCoordinator()
        writer.during = { try? self.bytes(5000).write(to: growing) }
        XCTAssertEqual(DeviceFileClone.coordinatedClone(of: growing, limit: 1000, coordinator: writer,
                                                        directory: cloneDirectory).failure, .tooLarge)
        XCTAssertEqual(leftoverClones(), [])
    }

    func testDocumentLoaderReleasesAccessRightAfterCloningAndStopsAtTheFirstFailure() async throws {
        let a = try write("a.pdf", bytes(70_000))
        let b = try write("b.txt", Data("hello".utf8))
        var opened: [String] = []
        var released: [String] = []
        var coordinators: [FakeReadCoordinator] = []
        let outcome = DeviceDocumentLoader.load(
            [a, b], limit: 100_000, cancellation: DeviceFileLoadCancellation(),
            makeCoordinator: {
                let c = FakeReadCoordinator()
                coordinators.append(c)
                return c
            },
            access: { url in
                opened.append(url.lastPathComponent)
                return { released.append(url.lastPathComponent) }
            },
            contentType: { $0.pathExtension == "pdf" ? "application/pdf" : "text/plain" },
            directory: cloneDirectory)
        guard case let .picked(documents)? = outcome else { return XCTFail("expected picked") }
        XCTAssertEqual(documents.map { $0.name }, ["a.pdf", "b.txt"])
        XCTAssertEqual(documents.map { $0.contentType }, ["application/pdf", "text/plain"])
        XCTAssertEqual(documents[0].data, bytes(70_000))
        XCTAssertEqual(documents[1].data, Data("hello".utf8))
        XCTAssertTrue(documents.allSatisfy { $0.release == nil }, "nothing held open for the upload")
        XCTAssertEqual(opened, ["a.pdf", "b.txt"])
        XCTAssertEqual(released, ["a.pdf", "b.txt"])
        XCTAssertEqual(coordinators.map { $0.coordinated.map { $0.lastPathComponent } }, [["a.pdf"], ["b.txt"]])

        opened = []
        released = []
        let tooBig = DeviceDocumentLoader.load(
            [b, a, b], limit: 1000, cancellation: DeviceFileLoadCancellation(),
            makeCoordinator: { FakeReadCoordinator() },
            access: { url in
                opened.append(url.lastPathComponent)
                return { released.append(url.lastPathComponent) }
            },
            contentType: { _ in "application/octet-stream" }, directory: cloneDirectory)
        guard case .tooLarge? = tooBig else { return XCTFail("expected tooLarge") }
        XCTAssertEqual(opened, ["b.txt", "a.pdf"], "the load ends at the first failure")
        XCTAssertEqual(released, opened, "access is always released")
        XCTAssertEqual(leftoverClones(), [])
    }

    func testDocumentLoaderCancellationAbandonsCoordinationAndReturnsNothing() async throws {
        let a = try write("a.bin", bytes(10))
        let b = try write("b.bin", bytes(10))
        let cancellation = DeviceFileLoadCancellation()
        let first = FakeReadCoordinator()
        first.during = { cancellation.cancel() } // the operation ends mid-read
        var made = 0
        var released = 0
        let outcome = DeviceDocumentLoader.load(
            [a, b], limit: 100, cancellation: cancellation,
            makeCoordinator: {
                made += 1
                return first
            },
            access: { _ in { released += 1 } },
            contentType: { _ in "application/octet-stream" }, directory: cloneDirectory)
        XCTAssertNil(outcome)
        XCTAssertTrue(first.cancelled, "the coordination in flight is abandoned")
        XCTAssertEqual(made, 1, "no further file is read")
        XCTAssertEqual(released, 1)
        XCTAssertTrue(cancellation.isCancelled)
        XCTAssertEqual(leftoverClones(), [])

        let late = DeviceFileLoadCancellation()
        late.cancel()
        XCTAssertNil(DeviceDocumentLoader.load([a], limit: 100, cancellation: late,
                                               makeCoordinator: { FakeReadCoordinator() },
                                               access: { _ in {} }, contentType: { _ in "x/y" },
                                               directory: cloneDirectory))
    }

    /// The regression end to end: a picked file is truncated by another
    /// process after the pick and before its bytes are framed; the upload
    /// still carries the picked content with a matching hash.
    func testFilePickUploadIsUnaffectedByTruncatingTheOriginal() async throws {
        let content = bytes(200_000, seed: 3)
        let original = try write("shared.dat", content)
        let picker = FakeDocumentPicker()
        let host = makeHost([FilePickDriver(picker: picker)])
        host.handleMessage(repairRequest(id: 1, capability: "file.pick", params: #"{"accept":[],"maxCount":1}"#))
        picker.selected?()
        let outcome = DeviceDocumentLoader.load([original], limit: 64 * 1024 * 1024,
                                                cancellation: DeviceFileLoadCancellation(),
                                                makeCoordinator: { DeviceUncoordinatedFileReader() },
                                                access: { _ in {} }, contentType: { _ in "application/octet-stream" },
                                                directory: cloneDirectory)
        guard let picked = outcome else { return XCTFail("cancelled") }
        picker.completion?(picked)
        let handle = try FileHandle(forWritingTo: original)
        try handle.truncate(atOffset: 0)
        try handle.close()
        host.handleMessage(repairControl(id: 1, #"{"grant":1048576}"#))
        clock.drainTurns()
        XCTAssertEqual(uploaded(1), [0: content])
        let item = responses().last?["result"]?["items"]?.arrayValue?.first
        XCTAssertEqual(item?["bytes"]?.int64Value, 200_000)
        XCTAssertEqual(item?["sha256"]?.stringValue, DeviceHash.sha256Hex(content))
        XCTAssertEqual(item?["name"]?.stringValue, "shared.dat")
    }

    /// iOS-only source pin: the document picker goes through the loader
    /// (coordinated private clones), never mapping the picked URL itself.
    func testIOSFilePickBackendNeverMapsTheOriginal() async throws {
        let source = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOSCapture.swift"), encoding: .utf8)
        XCTAssertFalse(source.contains("Data(contentsOf: url, options: .alwaysMapped)"))
        XCTAssertTrue(source.contains("DeviceDocumentLoader.load("))
        XCTAssertTrue(source.contains("makeCoordinator: { SystemFileReadCoordinator() }"))
        XCTAssertTrue(source.contains("NSFileCoordinator(filePresenter: nil)"))
    }

    // MARK: bluetooth.select — no widening

    private let heartRate = "0000180d-0000-1000-8000-00805f9b34fb"

    func testBluetoothUUIDCanonicalForms() async {
        XCTAssertEqual(DeviceBluetoothUUID.canonical("180D"), heartRate)
        XCTAssertEqual(DeviceBluetoothUUID.canonical("0x180d"), heartRate)
        XCTAssertEqual(DeviceBluetoothUUID.canonical("0000180D-0000-1000-8000-00805F9B34FB"), heartRate)
        XCTAssertEqual(DeviceBluetoothUUID.canonical(heartRate), heartRate)
        XCTAssertEqual(DeviceBluetoothUUID.canonical("0000180D"), heartRate, "32-bit form")
        XCTAssertEqual(DeviceBluetoothUUID.canonical("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"),
                       "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        for bad in ["", "180", "18 0D", "xyz1", "0x0000180d-0000-1000-8000-00805f9b34fb",
                    "0000180d_0000-1000-8000-00805f9b34fb", "0000180d-0000-1000-8000-00805f9b34fbb", "１８０Ｄ"] {
            XCTAssertNil(DeviceBluetoothUUID.canonical(bad), bad)
        }
    }

    func testBluetoothSelectRechecksServicesWhenTheBackendIgnoresTheFilter() async {
        // `FakeScannerFactory` ignores the service filter (a widening backend).
        let factory = FakeScannerFactory()
        let chooser = FakeChooser()
        let host = makeHost([BluetoothSelectDriver(factory: factory, chooser: chooser)])
        host.handleMessage(repairRequest(id: 1, capability: "bluetooth.select", params: #"{"services":["\#(heartRate)"]}"#))
        XCTAssertEqual(factory.filters, [[heartRate]], "the filter is always passed to the backend")
        let scanner = factory.scanners[0]
        scanner.handler?(.discovered(id: "unknown-services", name: "Mystery", rssi: -20))
        scanner.handler?(.discovered(id: "other-service", name: "Scale", rssi: -30, services: ["181D"]))
        scanner.handler?(.discovered(id: "garbage", name: "Junk", rssi: -35, services: ["not-a-uuid"]))
        scanner.handler?(.discovered(id: "hr-short", name: "Strap", rssi: -50, services: ["181D", "180D"]))
        scanner.handler?(.discovered(id: "hr-full", name: "Watch", rssi: -60, services: [heartRate.uppercased()]))
        XCTAssertEqual(chooser.session?.lists.last?.map { $0.id }, ["hr-short", "hr-full"],
                       "only devices advertising a requested service are listed")
        XCTAssertEqual(chooser.session?.lists.count, 2, "non-matching discoveries never reach the chooser")
        chooser.completion?(.selected(id: "other-service"))
        XCTAssertEqual(code(responses().last), "internal", "an unlisted device cannot be selected")
        XCTAssertEqual(detail(responses().last), "unknown-device")

        host.handleMessage(repairRequest(id: 2, capability: "bluetooth.select", params: #"{"services":["\#(heartRate)"]}"#))
        factory.scanners[1].handler?(.discovered(id: "hr-short", name: "Strap", rssi: -50, services: ["180D"]))
        chooser.completion?(.selected(id: "hr-short"))
        XCTAssertEqual(responses().last?["result"], .object(["device": .object(["id": .string("hr-short"),
                                                                                "name": .string("Strap")])]))

        // Without a service filter every discovery is listed, reported or not.
        host.handleMessage(repairRequest(id: 3, capability: "bluetooth.select", params: "{}"))
        XCTAssertEqual(factory.filters.last, [])
        factory.scanners[2].handler?(.discovered(id: "any", name: nil, rssi: -40))
        factory.scanners[2].handler?(.discovered(id: "any2", name: nil, rssi: -45, services: ["181D"]))
        XCTAssertEqual(chooser.session?.lists.last?.map { $0.id }, ["any", "any2"])
    }

    /// A widening default for the filtered factory method would compile any
    /// backend that forgot the filter; the requirement has none.
    func testFilteredScannerFactoryMethodHasNoWideningDefault() async throws {
        let source = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceDrivers.swift"), encoding: .utf8)
        XCTAssertFalse(source.contains("extension BluetoothScannerFactory"),
                       "no protocol-extension default for makeScanner(services:)")
        XCTAssertTrue(source.contains("func makeScanner(services: [String]) -> BluetoothScanner"))
    }
}

private extension Result {
    var success: Success? {
        if case let .success(value) = self { return value }
        return nil
    }

    var failure: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}
