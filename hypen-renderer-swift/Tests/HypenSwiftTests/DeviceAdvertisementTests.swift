import XCTest
@testable import HypenSwift

// The one advertisement rule of the native hosts (RFC 001 §2.2 "advertise
// only implementable capabilities"): a capability is advertised iff
//   (1) its hardware is present,
//   (2) the app declared what the OS requires (iOS: Info.plist usage
//       descriptions), and
//   (3) for bluetooth.scan and mic.record, the host's always-visible
//       indicator can be shown right now.
// What the user granted never matters. Every change of (1) or (3) while
// connected sends a fresh core.capabilities snapshot; permission.* stays
// advertised and answers an undeclared name `unavailable`
// `not-declared:<name>`.

// MARK: - Fakes and helpers

/// Hardware probes and Info.plist declarations under test control.
@MainActor
final class FakeAdvertisementEnvironment: DeviceAdvertisementEnvironment {
    static let allDeclared = Set(DevicePermission.allCases.compactMap { $0.iOSUsageDescriptionKey })

    var hardware = Set(DeviceHardware.allCases) {
        didSet { if hardware != oldValue { notify() } }
    }
    var declared = FakeAdvertisementEnvironment.allDeclared
    /// Whether hardware changes can be observed at all.
    var observable = true
    private var observers: [(FakeHandle, @Sendable @MainActor () -> Void)] = []

    func hasHardware(_ hardware: DeviceHardware) -> Bool {
        self.hardware.contains(hardware)
    }

    func isDeclared(_ declaration: String) -> Bool { declared.contains(declaration) }

    func observeHardware(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable? {
        guard observable else { return nil }
        let h = FakeHandle()
        observers.append((h, changed))
        return h
    }

    /// Report a probe change without changing any answer (a spurious signal).
    func notify() {
        for (handle, changed) in observers where !handle.cancelled { changed() }
    }
}

/// An authority whose statuses AND declarations are scripted; the rule
/// must not consult it.
@MainActor
final class CountingAuthority: DevicePermissionAuthority {
    var statuses: [DevicePermission: DevicePermissionStatus] = [:]
    var undeclared: Set<DevicePermission> = []
    private(set) var statusQueries = 0
    private(set) var requests = 0

    func status(of permission: DevicePermission,
                completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        statusQueries += 1
        completion(statuses[permission] ?? .prompt)
    }

    func request(_ permission: DevicePermission,
                 completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        requests += 1
        completion(.granted)
    }

    func missingUsageDescription(for permission: DevicePermission) -> String? {
        undeclared.contains(permission) ? permission.iOSUsageDescriptionKey ?? permission.rawValue : nil
    }
}

@MainActor
final class SignalCounter: Sendable {
    nonisolated(unsafe) var count = 0
}

@MainActor
private func advRequest(id: UInt32, capability: String, params: String, timeoutMs: UInt64 = 300_000,
                        initialCredit: UInt64 = 0, owner: String = #"{"moduleInstanceId":"m-1","activationId":1}"#,
                        lifetime: String = "activation") -> Data {
    Data(#"{"type":"deviceRequest","id":\#(id),"capability":"\#(capability)","version":1,"owner":\#(owner),"lifetime":"\#(lifetime)","timeoutMs":\#(timeoutMs),"initialCredit":\#(initialCredit),"params":\#(params)}"#.utf8)
}

@MainActor
private func advCore(id: UInt32) -> Data {
    advRequest(id: id, capability: "core.capabilities", params: "{}", timeoutMs: 86_400_000,
               initialCredit: 64, owner: #"{"connection":true}"#, lifetime: "connection")
}

@MainActor
private func advCancel(id: UInt32) -> Data {
    Data(#"{"type":"deviceEvent","id":\#(id),"control":{"cancel":true}}"#.utf8)
}

/// Every capability of the stock iOS host.
private let iOSCapabilities = ["core.capabilities", "gallery.pick", "file.pick", "file.save", "permission.query",
                               "permission.request", "camera.capture", "bluetooth.select", "bluetooth.scan",
                               "mic.record"]

// MARK: - Tests

@MainActor
final class DeviceAdvertisementTests: XCTestCase, @unchecked Sendable {
    var clock: ManualDeviceClock!
    var transport: RecordingTransport!
    var environment: FakeAdvertisementEnvironment!
    var surface: FakeIndicatorSurface!
    var authority: CountingAuthority!
    var scanner: FakeScannerFactory!
    var presenter: FakePresenter!
    var audio: FakeAudioFactory!

    override func setUp() async throws {
        clock = ManualDeviceClock()
        transport = RecordingTransport()
        environment = FakeAdvertisementEnvironment()
        surface = FakeIndicatorSurface()
        authority = CountingAuthority()
        scanner = FakeScannerFactory()
        presenter = FakePresenter()
        audio = FakeAudioFactory()
    }

    /// The stock iOS host's driver set over fakes, advertised by the iOS
    /// requirements table.
    private func makeHost(indicator: DeviceActivityIndicator? = nil,
                          authority: DevicePermissionAuthority? = nil) -> DeviceHost {
        let authority = authority ?? self.authority!
        let indicator = indicator ?? HostDeviceActivityIndicator(surface: surface)
        let drivers: [DeviceDriver] = [
            GalleryPickDriver(picker: FakePicker()),
            FilePickDriver(picker: FakeDocumentPicker()),
            FileSaveDriver(destination: FakeDestinationPicker(), presenter: presenter),
            PermissionQueryDriver(authority: authority),
            PermissionRequestDriver(authority: authority, presenter: presenter),
            CameraCaptureDriver(capturer: FakeCamera(), authority: authority),
            BluetoothSelectDriver(factory: scanner, chooser: FakeChooser()),
            BluetoothScanDriver(factory: scanner, presenter: presenter, indicator: indicator),
            MicRecordDriver(factory: audio, authority: authority, presenter: presenter, indicator: indicator),
        ]
        let rule = DeviceAdvertisementRule(requirements: DeviceAdvertisementRule.iOSRequirements,
                                           environment: environment, indicator: indicator)
        return DeviceHost(origin: "wss://app.example.com", drivers: drivers, rule: rule,
                          options: DeviceHost.Options(leaseExpiry: 10_000), clock: clock,
                          promptGate: DevicePromptGate(), persistentStore: InMemoryDeviceStore())
    }

    /// Attach, select everything offered, open core.capabilities as id 1.
    @discardableResult
    private func connect(_ host: DeviceHost, transport: RecordingTransport? = nil) -> DeviceHost {
        let transport = transport ?? self.transport!
        XCTAssertTrue(host.attach(transport))
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        host.handleMessage(advCore(id: 1))
        return host
    }

    private func hello(_ host: DeviceHost) -> [String] { host.advertisement.capabilities.map { $0.name } }

    /// Every core.capabilities snapshot sent, in order, as name lists.
    private func snapshots(_ t: RecordingTransport? = nil) -> [[String]] {
        (t ?? transport).messages.compactMap { m in
            guard m["type"]?.stringValue == "deviceEvent", m["id"]?.int64Value == 1,
                  let offers = m["event"]?["capabilities"]?.arrayValue else { return nil }
            return offers.compactMap { $0["name"]?.stringValue }
        }
    }

    private func responses() -> [DeviceJSON] {
        transport.messages.filter { $0["type"]?.stringValue == "deviceResponse" }
    }

    private func code(_ m: DeviceJSON?) -> String? { m?["error"]?["code"]?.stringValue }
    private func detail(_ m: DeviceJSON?) -> String? { m?["error"]?["platformDetail"]?.stringValue }

    private func without(_ names: String...) -> [String] { iOSCapabilities.filter { !names.contains($0) } }

    // MARK: The requirements table

    func testIOSRequirementsTablePinsEveryBranch() async {
        let table = DeviceAdvertisementRule.iOSRequirements
        XCTAssertEqual(Set(table.keys), Set(iOSCapabilities).subtracting(["core.capabilities"]))
        for name in ["gallery.pick", "file.pick", "file.save", "permission.query", "permission.request"] {
            XCTAssertEqual(table[name], DeviceCapabilityRequirements.none, name)
        }
        XCTAssertEqual(table["camera.capture"],
                       DeviceCapabilityRequirements(hardware: [.camera], declarations: ["NSCameraUsageDescription"]))
        XCTAssertEqual(table["bluetooth.select"],
                       DeviceCapabilityRequirements(hardware: [.bluetooth], declarations: ["NSBluetoothAlwaysUsageDescription"]))
        XCTAssertEqual(table["bluetooth.scan"],
                       DeviceCapabilityRequirements(hardware: [.bluetooth], declarations: ["NSBluetoothAlwaysUsageDescription"],
                                                    needsIndicator: true))
        XCTAssertEqual(table["mic.record"],
                       DeviceCapabilityRequirements(hardware: [.microphone], declarations: ["NSMicrophoneUsageDescription"],
                                                    needsIndicator: true))
        XCTAssertEqual(DevicePermission.location.iOSUsageDescriptionKey, "NSLocationWhenInUseUsageDescription")
        XCTAssertEqual(DevicePermission.photos.iOSUsageDescriptionKey, "NSPhotoLibraryUsageDescription")
        XCTAssertEqual(DevicePermission.contacts.iOSUsageDescriptionKey, "NSContactsUsageDescription")
        XCTAssertNil(DevicePermission.notifications.iOSUsageDescriptionKey)
    }

    // MARK: Branch (2): declarations

    func testEverythingDeclaredPresentAndReadyIsAdvertised() async {
        let host = connect(makeHost())
        XCTAssertEqual(hello(host), iOSCapabilities)
        XCTAssertEqual(snapshots(), [iOSCapabilities])
    }

    func testUndeclaredCapabilitiesAreLeftOutOfHelloAndEverySnapshot() async {
        environment.declared = []
        let host = connect(makeHost())
        let always = ["core.capabilities", "gallery.pick", "file.pick", "file.save", "permission.query", "permission.request"]
        XCTAssertEqual(hello(host), always, "no usage description → never offered, whatever else holds")
        XCTAssertEqual(snapshots(), [always])
        // A later readiness or hardware signal cannot bring them back.
        surface.canShow = false
        surface.canShow = true
        environment.notify()
        XCTAssertEqual(snapshots(), [always], "nothing changed: no fresh snapshot")
        host.handleMessage(advRequest(id: 2, capability: "mic.record", params: #"{"format":"pcm16","sampleRate":8000}"#))
        XCTAssertEqual(code(responses().last), "unsupported")
    }

    func testEachDeclarationGatesOnlyItsOwnCapabilities() async {
        environment.declared = FakeAdvertisementEnvironment.allDeclared.subtracting(["NSBluetoothAlwaysUsageDescription"])
        XCTAssertEqual(hello(connect(makeHost())), without("bluetooth.select", "bluetooth.scan"))

        environment.declared = FakeAdvertisementEnvironment.allDeclared.subtracting(["NSMicrophoneUsageDescription"])
        XCTAssertEqual(hello(makeHost()), without("mic.record"))

        environment.declared = FakeAdvertisementEnvironment.allDeclared.subtracting(["NSCameraUsageDescription"])
        XCTAssertEqual(hello(makeHost()), without("camera.capture"))
    }

    func testACapabilityMissingFromTheTableIsNeverAdvertised() async {
        let rule = DeviceAdvertisementRule(requirements: [:], environment: environment, indicator: nil)
        let host = DeviceHost(origin: "wss://app.example.com", drivers: [GalleryPickDriver(picker: FakePicker())],
                              rule: rule, clock: clock, promptGate: DevicePromptGate(),
                              persistentStore: InMemoryDeviceStore())
        XCTAssertEqual(hello(host), ["core.capabilities"])
        XCTAssertTrue(rule.isAdvertised("core.capabilities"))
        XCTAssertFalse(rule.isAdvertised("gallery.pick"))
    }

    // MARK: Branch (1): hardware

    func testAbsentHardwareIsWithheldFromSnapshotsAndReAdvertisedWhenItAppears() async {
        environment.hardware = [.bluetooth]
        let host = connect(makeHost())
        XCTAssertEqual(hello(host), iOSCapabilities, "declared: selectable, so it can come back on this socket")
        XCTAssertEqual(snapshots(), [without("camera.capture", "mic.record")])
        host.handleMessage(advRequest(id: 2, capability: "camera.capture", params: #"{"mode":"photo"}"#))
        XCTAssertEqual(code(responses().last), "unsupported", "withheld means not in the live selection")

        environment.hardware.insert(.microphone) // headset plugged in
        XCTAssertEqual(snapshots().last, without("camera.capture"))
        environment.hardware.remove(.bluetooth) // adapter gone
        XCTAssertEqual(snapshots().last, without("camera.capture", "bluetooth.select", "bluetooth.scan"))
        environment.hardware = Set(DeviceHardware.allCases)
        XCTAssertEqual(snapshots().last, iOSCapabilities)
        XCTAssertEqual(snapshots().count, 4, "one fresh snapshot per change")

        XCTAssertEqual(host.liveCapabilities["camera.capture"], 1, "re-added by the fresh snapshot")
        host.handleMessage(advRequest(id: 3, capability: "camera.capture", params: #"{"mode":"photo"}"#))
        XCTAssertEqual(responses().count, 1, "admitted: the camera is up, nothing refused it")
    }

    func testUnobservableHardwareIsStillProbedAtEverySnapshot() async {
        environment.observable = false
        environment.hardware = []
        let host = connect(makeHost())
        XCTAssertEqual(snapshots(), [without("camera.capture", "bluetooth.select", "bluetooth.scan", "mic.record")])
        environment.hardware = Set(DeviceHardware.allCases) // nobody told the host
        XCTAssertEqual(snapshots().count, 1)
        // The next snapshot, for any reason, carries the current truth.
        surface.canShow = false
        XCTAssertEqual(snapshots().last, without("bluetooth.scan", "mic.record"))
        host.handleMessage(advCancel(id: 1)) // planned reopen
        host.handleMessage(advCore(id: 1_000))
        XCTAssertNotNil(transport.messages.last?["event"]?["capabilities"])
    }

    // MARK: Branch (3): the host indicator

    func testIndicatorNotReadyWithholdsOnlyScanAndMic() async {
        surface.canShow = false // no foreground scene
        let host = connect(makeHost())
        XCTAssertEqual(hello(host), iOSCapabilities)
        XCTAssertEqual(snapshots(), [without("bluetooth.scan", "mic.record")],
                       "bluetooth.select and camera.capture need no host indicator")
        host.handleMessage(advRequest(id: 2, capability: "bluetooth.scan", params: "{}"))
        XCTAssertEqual(code(responses().last), "unsupported")
        XCTAssertTrue(presenter.presented.isEmpty, "never a prompt for a capability that is not advertised")
    }

    func testSceneForegroundAndBackgroundReAdvertiseScanAndMic() async {
        surface.canShow = false
        let host = connect(makeHost())
        surface.canShow = true // scene came to the foreground
        XCTAssertEqual(snapshots(), [without("bluetooth.scan", "mic.record"), iOSCapabilities])
        host.handleMessage(advRequest(id: 2, capability: "bluetooth.scan", params: "{}"))
        XCTAssertEqual(presenter.presented.count, 1, "live again: the request reaches the host consent")
        presenter.completion?(false)

        surface.canShow = false // scene went to the background
        XCTAssertEqual(snapshots().last, without("bluetooth.scan", "mic.record"))
        XCTAssertEqual(snapshots().count, 3)
    }

    func testOverlayLostWhileStreamingSendsOneFreshSnapshot() async {
        let host = connect(makeHost())
        host.handleMessage(advRequest(id: 2, capability: "bluetooth.scan", params: "{}"))
        presenter.completion?(true)
        XCTAssertTrue(surface.visible)
        XCTAssertEqual(snapshots().count, 1, "showing the overlay does not change readiness")

        // The overlay's scene backgrounds: the surface reports both the
        // readiness change and the loss.
        surface.canShow = false
        surface.lose()
        XCTAssertTrue(scanner.scanners[0].stopped, "no stream without its indicator")
        XCTAssertEqual(snapshots(), [iOSCapabilities, without("bluetooth.scan", "mic.record")],
                       "one snapshot for the change, however many signals")
    }

    func testOverlayDetachedAfterAFailedRenderIsReported() async {
        let indicator = HostDeviceActivityIndicator(surface: surface)
        let signals = SignalCounter()
        let observation = indicator.observeReadiness { signals.count += 1 }
        XCTAssertTrue(indicator.isReady)
        // Readiness flipped between the snapshot and the request (no signal
        // yet): the request still fails before any hardware opens, and the
        // detach is reported.
        surface.readinessHandler = nil
        surface.canShow = false
        XCTAssertNil(indicator.showIndicator(origin: "o", activity: "a") {})
        XCTAssertFalse(indicator.isReady)
        XCTAssertEqual(signals.count, 1)
        observation.cancel()
        _ = indicator.showIndicator(origin: "o", activity: "a") {}
        XCTAssertEqual(signals.count, 1, "a cancelled observation hears nothing")
    }

    func testAnAppIndicatorWithoutReadinessWithholdsScanAndMic() async {
        let indicator = FakeIndicator()
        indicator.available = false
        let host = connect(makeHost(indicator: indicator))
        XCTAssertEqual(snapshots(), [without("bluetooth.scan", "mic.record")])
        indicator.available = true
        XCTAssertEqual(snapshots().last, iOSCapabilities)
        _ = host
    }

    func testNoIndicatorAtAllNeverAdvertisesScanOrMic() async {
        let rule = DeviceAdvertisementRule(requirements: DeviceAdvertisementRule.iOSRequirements,
                                           environment: environment, indicator: nil)
        XCTAssertFalse(rule.isAdvertised("bluetooth.scan"))
        XCTAssertFalse(rule.isAdvertised("mic.record"))
        XCTAssertTrue(rule.isAdvertised("bluetooth.select"))
        XCTAssertTrue(rule.isAdvertised("camera.capture"))
    }

    // MARK: Granted vs not granted must not matter

    func testWhatTheUserGrantedNeverChangesTheAdvertisement() async {
        var observed: [[[String]]] = []
        for status in [DevicePermissionStatus.granted, .denied, .prompt] {
            let authority = CountingAuthority()
            authority.statuses = Dictionary(uniqueKeysWithValues: DevicePermission.allCases.map { ($0, status) })
            scanner.authorization = status
            let t = RecordingTransport()
            let host = connect(makeHost(authority: authority), transport: t)
            XCTAssertEqual(hello(host), iOSCapabilities, "\(status)")
            XCTAssertEqual(authority.statusQueries, 0, "the rule never reads a permission status")
            XCTAssertEqual(authority.requests, 0)
            observed.append(snapshots(t))
        }
        XCTAssertEqual(observed[0], observed[1])
        XCTAssertEqual(observed[1], observed[2])
        XCTAssertEqual(observed[0], [iOSCapabilities])
    }

    // MARK: permission.* stays advertised; undeclared names answer not-declared

    func testPermissionQueryAndRequestAnswerNotDeclaredWhateverWasGranted() async {
        environment.declared = []
        authority.undeclared = [.contacts, .microphone]
        authority.statuses = [.contacts: .granted, .microphone: .denied, .camera: .granted]
        let host = connect(makeHost())
        XCTAssertTrue(hello(host).contains("permission.query"))
        XCTAssertTrue(hello(host).contains("permission.request"))
        host.handleMessage(advRequest(id: 2, capability: "permission.query", params: #"{"permission":"contacts"}"#,
                                      timeoutMs: 30_000))
        host.handleMessage(advRequest(id: 3, capability: "permission.request", params: #"{"permission":"contacts"}"#))
        host.handleMessage(advRequest(id: 4, capability: "permission.query", params: #"{"permission":"microphone"}"#,
                                      timeoutMs: 30_000))
        host.handleMessage(advRequest(id: 5, capability: "permission.request", params: #"{"permission":"microphone"}"#))
        let r = responses()
        XCTAssertEqual(r.map { code($0) }, ["unavailable", "unavailable", "unavailable", "unavailable"])
        XCTAssertEqual(r.map { detail($0) }, ["not-declared:contacts", "not-declared:contacts",
                                               "not-declared:microphone", "not-declared:microphone"])
        XCTAssertEqual(authority.statusQueries, 0, "granted or denied, an undeclared name answers the same")
        XCTAssertTrue(presenter.presented.isEmpty)

        // A declared name answers its status as before.
        host.handleMessage(advRequest(id: 6, capability: "permission.query", params: #"{"permission":"camera"}"#,
                                      timeoutMs: 30_000))
        XCTAssertEqual(responses().last?["result"]?["status"]?.stringValue, "granted")
        host.handleMessage(advRequest(id: 7, capability: "permission.request", params: #"{"permission":"camera"}"#))
        XCTAssertEqual(responses().last?["result"]?["status"]?.stringValue, "granted")
    }

    // MARK: Snapshots: change-only, per socket, current on open

    func testSpuriousSignalsSendNoSnapshot() async {
        connect(makeHost())
        environment.notify()
        surface.readinessHandler?()
        surface.canShow = true
        XCTAssertEqual(snapshots().count, 1)
    }

    func testChangesWithoutALiveCoreStreamAreCarriedByTheNextOpen() async {
        let host = makeHost()
        XCTAssertTrue(host.attach(transport))
        host.onAck(DeviceAck(protocolVersion: 1, binary: true,
                             capabilities: host.advertisement.capabilities.map { CapabilitySelection(name: $0.name, version: 1) }))
        surface.canShow = false // before core.capabilities opened
        XCTAssertTrue(snapshots().isEmpty)
        host.handleMessage(advCore(id: 1))
        XCTAssertEqual(snapshots(), [without("bluetooth.scan", "mic.record")], "the first snapshot is current")
        surface.canShow = true
        XCTAssertEqual(snapshots().last, iOSCapabilities)

        // A new socket starts over: its first snapshot is current too, and
        // the change detection does not leak across sockets.
        surface.canShow = false
        let second = RecordingTransport()
        connect(host, transport: second)
        XCTAssertEqual(snapshots(second), [without("bluetooth.scan", "mic.record")])
        surface.canShow = true
        XCTAssertEqual(snapshots(second).last, iOSCapabilities)
    }

    func testRuleAndManualAvailabilityCombine() async {
        let host = connect(makeHost())
        host.setAvailable("gallery.pick", false)
        XCTAssertEqual(snapshots().last, without("gallery.pick"))
        surface.canShow = false
        XCTAssertEqual(snapshots().last, without("gallery.pick", "bluetooth.scan", "mic.record"))
        host.setAvailable("gallery.pick", true)
        XCTAssertEqual(snapshots().last, without("bluetooth.scan", "mic.record"))
        surface.canShow = true
        XCTAssertEqual(snapshots().last, iOSCapabilities)
        XCTAssertEqual(snapshots().count, 5)
    }

    /// The UIKit side is not compiled on Linux: pin that the stock factory
    /// routes every driver through the rule with the iOS table, the system
    /// environment and the SAME indicator the scan and mic drivers use, and
    /// that the overlay reports readiness on every scene transition.
    func testStockIOSHostIsWiredThroughTheRule() async throws {
        let source = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOS.swift"), encoding: .utf8)
        guard let start = source.range(of: "public static func iOS("),
              let end = source.range(of: "return host", range: start.upperBound..<source.endIndex) else {
            return XCTFail("DeviceHost.iOS factory not found")
        }
        let body = String(source[start.lowerBound..<end.upperBound])
        XCTAssertTrue(body.contains("DeviceAdvertisementRule(requirements: DeviceAdvertisementRule.iOSRequirements"))
        XCTAssertTrue(body.contains("environment: SystemDeviceAdvertisementEnvironment(camera: camera)"))
        XCTAssertTrue(body.contains("indicator: indicator)"))
        XCTAssertTrue(body.contains("DeviceHost(origin: origin, drivers: drivers, rule: rule"))
        XCTAssertFalse(body.contains("missingUsageDescription"), "declarations are the rule's job, not ad-hoc ifs")
        XCTAssertFalse(body.contains("isAvailable(facing:"), "hardware is the rule's job, not ad-hoc ifs")
        XCTAssertFalse(body.contains("authorization"), "what the user granted never gates the advertisement")
        for driver in ["GalleryPickDriver", "FilePickDriver", "FileSaveDriver", "PermissionQueryDriver",
                       "PermissionRequestDriver", "CameraCaptureDriver", "BluetoothSelectDriver",
                       "BluetoothScanDriver", "MicRecordDriver"] {
            XCTAssertTrue(body.contains(driver + "("), driver)
        }
        XCTAssertTrue(source.contains("case .microphone: return AVAudioSession.sharedInstance().isInputAvailable"))
        XCTAssertTrue(source.contains("AVAudioSession.routeChangeNotification"))

        let overlay = try String(contentsOf: DeviceFixtures.url("hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOSCapture.swift"), encoding: .utf8)
        XCTAssertTrue(overlay.contains("public var canShow: Bool"))
        for name in ["willConnectNotification", "didDisconnectNotification", "willEnterForegroundNotification",
                     "didActivateNotification", "willDeactivateNotification", "didEnterBackgroundNotification"] {
            XCTAssertTrue(overlay.contains("UIScene.\(name)"), name)
        }
        XCTAssertTrue(overlay.contains("self?.readinessHandler?()"))
    }

    func testTheHostDoesNotKeepItselfAlive() async {
        weak var weakHost: DeviceHost?
        do {
            let host = connect(makeHost())
            weakHost = host
            host.detach()
        }
        XCTAssertNil(weakHost, "rule observers hold the host weakly")
        surface.canShow = false // an observer outliving its host is a no-op
        environment.notify()
    }
}
