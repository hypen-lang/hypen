// Device Capability Protocol — iOS platform backends for DeviceHost
// (RFC 001 §2.6, §3, §7).
//
// Everything OS-specific lives here, behind the small protocols in
// `DeviceDrivers.swift`, so the protocol core stays platform-agnostic and
// unit-testable. Compiled only on iOS / Mac Catalyst.
//
// Platform notes (§7):
// - PHPickerViewController runs out of process and needs neither a fresh app
//   gesture nor photo-library permission; it supplies the per-use choice
//   itself, so gallery.pick presents it directly (§2.6). Dismissal maps to
//   `cancelled`, never `denied`.
// - CoreBluetooth scans only while the app is in the foreground; entering
//   the background suspends activation-bound work (`DeviceHost.suspend()`).
// - Prompting for a permission without its Info.plist usage description
//   terminates the app, so drivers check and return `unavailable` first.

#if canImport(UIKit) && os(iOS)
// OS completion handlers that may run off the main queue are written as
// explicit `@Sendable` closures that hop with `Task { @MainActor in }`, so
// Swift 6 never infers them `@MainActor` (which would trap at runtime).
import Foundation
import UIKit
import UniformTypeIdentifiers
@preconcurrency import PhotosUI
@preconcurrency import Photos
@preconcurrency import AVFoundation
@preconcurrency import UserNotifications
@preconcurrency import CoreBluetooth
@preconcurrency import CoreLocation
@preconcurrency import Contacts

// MARK: - Presentation

@MainActor
public enum DeviceUIKitPresentation {
    /// Top-most view controller of the foreground-active key window, or nil
    /// when there is nothing that can safely present (background, no scene).
    public static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        guard let window = scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow }),
              var top = window.rootViewController else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    /// Whether `host` can present right now. UIKit silently ignores a
    /// `present` from a controller that is mid-transition, already
    /// presenting, or off-window (only a console warning), which would leave
    /// the operation holding the app-wide prompt slot until its deadline.
    public static func canPresent(from host: UIViewController) -> Bool {
        host.viewIfLoaded?.window != nil
            && host.presentedViewController == nil
            && host.transitionCoordinator == nil
            && !host.isBeingPresented
            && !host.isBeingDismissed
    }

    /// Present `controller` from the top view controller, the UIKit way,
    /// with no timers:
    /// - a host that can present right now presents at once;
    /// - a host in the middle of a transition (typically the previous prompt
    ///   still animating away) presents when UIKit reports that transition
    ///   finished, through its transition coordinator;
    /// - otherwise (no foreground scene, or the host is showing something
    ///   that isn't going away) the presentation is refused and `refused`
    ///   runs, so the prompt slot is released at once.
    /// Once `present` is called on a host that passed `canPresent`, UIKit's
    /// presentation is trusted. A presentation UIKit still drops is bounded
    /// by the request's own deadline, server cancel and module teardown.
    static func present(_ controller: UIViewController,
                        using presenter: @escaping @MainActor () -> UIViewController?,
                        refused: @escaping @MainActor () -> Void) {
        PresentationAttempt(controller: controller, presenter: presenter, refused: refused).run()
    }
}

/// One `DeviceUIKitPresentation.present` call: re-resolves the host after
/// each transition it waits for (the top controller changes when the
/// previous prompt goes away).
@MainActor
private final class PresentationAttempt {
    private let controller: UIViewController
    private let presenter: @MainActor () -> UIViewController?
    private let refused: @MainActor () -> Void
    /// Transitions waited for so far: a chain longer than this is not a
    /// prompt finishing its dismissal, so give up rather than loop.
    private var waits = 0

    init(controller: UIViewController,
         presenter: @escaping @MainActor () -> UIViewController?,
         refused: @escaping @MainActor () -> Void) {
        self.controller = controller
        self.presenter = presenter
        self.refused = refused
    }

    func run() {
        // Already up (a transition we waited for ended after it appeared).
        if controller.presentingViewController != nil || controller.isBeingPresented { return }
        guard let host = presenter() else { refused(); return }
        if DeviceUIKitPresentation.canPresent(from: host) {
            host.present(controller, animated: true)
            return
        }
        if waits < 3,
           let coordinator = host.transitionCoordinator ?? host.presentedViewController?.transitionCoordinator {
            waits += 1
            let queued = coordinator.animate(alongsideTransition: nil) { @Sendable [self] _ in
                Task { @MainActor in self.run() }
            }
            // Not queued: the transition already ended — look again now.
            if !queued { run() }
            return
        }
        refused()
    }
}

// MARK: - Host-owned consent (UIAlertController)

/// Host-owned Continue/Cancel interaction naming the app origin (§2.6 step 2).
/// System alert UI: outside the patch tree, accessible, keyboard-operable,
/// and unaffected by the state of any app button.
@MainActor
public final class AlertConsentPresenter: DeviceConsentPresenter {
    private let presenter: @MainActor () -> UIViewController?

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController) {
        self.presenter = presenter
    }

    public func presentConsent(origin: String,
                               operation: String,
                               completion: @escaping @Sendable @MainActor (DeviceConsentOutcome) -> Void) -> DeviceCancellable? {
        // Nothing on screen that could ever present (background, no scene);
        // a host that is mid-transition is waited for by `present`.
        guard presenter() != nil else { return nil }
        let handle = AlertHandle(completion: completion)
        let alert = UIAlertController(title: origin, message: "wants to \(operation).", preferredStyle: .alert)
        // Handlers are typed differently across SDK versions (plain vs.
        // `@MainActor @Sendable`); an explicit main-actor hop compiles and is
        // correct under both.
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { @Sendable _ in
            Task { @MainActor in handle.finish(.declined) }
        })
        let proceed = UIAlertAction(title: "Continue", style: .default) { @Sendable _ in
            Task { @MainActor in handle.finish(.accepted) }
        }
        alert.addAction(proceed)
        alert.preferredAction = proceed
        handle.alert = alert
        DeviceUIKitPresentation.present(alert, using: presenter) { handle.presentationRefused() }
        return handle
    }
}

@MainActor
private final class AlertHandle: DeviceCancellable {
    weak var alert: UIAlertController?
    private var completion: (@Sendable @MainActor (DeviceConsentOutcome) -> Void)?

    init(completion: @escaping @Sendable @MainActor (DeviceConsentOutcome) -> Void) {
        self.completion = completion
    }

    /// A refused presentation leaves no presenting controller: report it so
    /// the prompt slot is released now, not at the deadline.
    func presentationRefused() {
        guard completion != nil else { return }
        if let alert = alert, alert.presentingViewController != nil { return }
        finish(.unavailable)
    }

    /// One acceptance consumes only this request; repeated taps are no-ops.
    func finish(_ outcome: DeviceConsentOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        completion(outcome)
    }

    /// The operation settled elsewhere (server cancel, deadline, detach).
    func cancel() {
        completion = nil
        if let alert = alert, alert.presentingViewController != nil {
            alert.dismiss(animated: true)
        }
    }
}

// MARK: - gallery.pick (PHPickerViewController)

/// PHPicker-backed gallery picker. No `PHPhotoLibrary` is passed to the
/// configuration, so no library permission is requested or needed (§7).
///
/// Items are loaded with `loadFileRepresentation`: the file size is checked
/// against the revision's `maxItemBytes` before any byte is read, and the
/// accepted file is memory-mapped rather than loaded, so a large video never
/// becomes resident (§5 "bound … binary buffers"); the host then cuts frames
/// from the mapping lazily.
@MainActor
public final class PHPickerGalleryPicker: GalleryPicker {
    private let presenter: @MainActor () -> UIViewController?
    private var sessions: [ObjectIdentifier: PickerSession] = [:]

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController) {
        self.presenter = presenter
    }

    public func presentPicker(mediaTypes: Set<String>,
                              maxCount: Int,
                              maxItemBytes: UInt64,
                              selected: @escaping @Sendable @MainActor () -> Void,
                              completion: @escaping @Sendable @MainActor (GalleryPickOutcome) -> Void) -> DeviceCancellable? {
        // Nothing on screen that could ever present (background, no scene);
        // a host that is mid-transition is waited for by `present`.
        guard presenter() != nil else { return nil }
        var config = PHPickerConfiguration()
        config.selectionLimit = max(1, maxCount)
        switch (mediaTypes.contains("photo"), mediaTypes.contains("video")) {
        case (true, false): config.filter = .images
        case (false, true): config.filter = .videos
        default: config.filter = .any(of: [.images, .videos])
        }
        // Transcode to the most compatible representation (JPEG / H.264)
        // so servers are not handed HEIC/HEVC they may not decode.
        config.preferredAssetRepresentationMode = .compatible

        let picker = PHPickerViewController(configuration: config)
        let session = PickerSession(picker: picker, maxItemBytes: maxItemBytes,
                                    selected: selected, completion: completion) { [weak self] ended in
            self?.sessions[ObjectIdentifier(ended)] = nil
        }
        sessions[ObjectIdentifier(session)] = session
        // PHPicker reports every ending — including swipe-to-dismiss — through
        // `didFinishPicking` (empty results on dismissal). Its presentation
        // controller is not overridden: the picker runs out of process and a
        // separate dismissal callback would race item loading (§2.6 step 4).
        picker.delegate = session
        DeviceUIKitPresentation.present(picker, using: presenter) { session.presentationRefused() }
        return session
    }
}

/// Result of loading one picked item off the main actor.
private enum LoadedPickerItem: Sendable {
    case data(Data)
    case tooLarge
    case failed(String)
}

@MainActor
private final class PickerSession: NSObject, @preconcurrency PHPickerViewControllerDelegate, DeviceCancellable {
    private weak var picker: PHPickerViewController?
    private let maxItemBytes: UInt64
    private var selected: (@Sendable @MainActor () -> Void)?
    private var completion: (@Sendable @MainActor (GalleryPickOutcome) -> Void)?
    private let onEnd: @MainActor (PickerSession) -> Void
    private var loaded: [PickedMedia?] = []
    private var pending = 0
    /// In-flight `loadFileRepresentation` work: cancelled when the operation
    /// settles elsewhere (server cancel, deadline, detach) or an item fails,
    /// so a `.compatible` transcode of a large video does not keep running.
    private var loads: [Progress] = []

    init(picker: PHPickerViewController,
         maxItemBytes: UInt64,
         selected: @escaping @Sendable @MainActor () -> Void,
         completion: @escaping @Sendable @MainActor (GalleryPickOutcome) -> Void,
         onEnd: @escaping @MainActor (PickerSession) -> Void) {
        self.picker = picker
        self.maxItemBytes = maxItemBytes
        self.selected = selected
        self.completion = completion
        self.onEnd = onEnd
        super.init()
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard completion != nil else { return }
        guard !results.isEmpty else {
            // Cancel button or swipe-to-dismiss: abandonment → `cancelled`.
            finish(.dismissed)
            return
        }
        // The picker UI is gone: the prompt slot is free while items load.
        let chose = selected
        selected = nil
        chose?()
        guard completion != nil else { return }
        loaded = Array(repeating: nil, count: results.count)
        pending = results.count
        let limit = maxItemBytes
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            guard let type = Self.preferredType(provider) else {
                finish(.failed("unsupported-item"))
                return
            }
            let mime = UTType(type)?.preferredMIMEType ?? "application/octet-stream"
            // The handler runs on a background queue and the file at `url`
            // is deleted when it returns: size-check, then clone and map it.
            let progress = provider.loadFileRepresentation(forTypeIdentifier: type) { @Sendable [weak self] url, error in
                let item = Self.load(url: url, error: error, limit: limit)
                Task { @MainActor in
                    self?.itemLoaded(index: index, item: item, contentType: mime)
                }
            }
            loads.append(progress)
        }
    }

    /// UIKit refused to present the picker (no presenting controller while
    /// the user has not chosen yet): no user decision was made.
    func presentationRefused() {
        guard completion != nil, selected != nil else { return }
        if let picker = picker, picker.presentingViewController != nil { return }
        finish(.presentationFailed)
    }

    /// Size check before reading, then a memory-mapped private clone.
    nonisolated private static func load(url: URL?, error: Error?, limit: UInt64) -> LoadedPickerItem {
        guard let url = url else {
            return .failed(DeviceDiagnostics.loadFailureToken(error))
        }
        // A private clone cannot be truncated underneath the mapping; it is
        // unlinked right away and the mapping keeps it alive until released
        // (first-unlock protection: see `DeviceFileClone.mappedClone`).
        switch DeviceFileClone.mappedClone(of: url, limit: limit) {
        case let .success(data):
            return .data(data)
        case .failure(.tooLarge):
            return .tooLarge
        case let .failure(.failed(detail)):
            return .failed(detail)
        }
    }

    private func itemLoaded(index: Int, item: LoadedPickerItem, contentType: String) {
        guard completion != nil, loaded.indices.contains(index) else { return }
        switch item {
        case let .data(data):
            loaded[index] = PickedMedia(contentType: contentType, data: data)
            pending -= 1
            if pending == 0 { finish(.picked(loaded.compactMap { $0 })) }
        case .tooLarge:
            finish(.tooLarge)
        case let .failed(detail):
            finish(.failed(detail))
        }
    }

    private func finish(_ outcome: GalleryPickOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        selected = nil
        loaded = []
        cancelLoads()
        onEnd(self)
        completion(outcome)
    }

    /// The operation settled elsewhere: dismiss, stop loading, and drop any
    /// late result.
    func cancel() {
        completion = nil
        selected = nil
        loaded = []
        cancelLoads()
        if let picker = picker, picker.presentingViewController != nil {
            picker.dismiss(animated: true)
        }
        onEnd(self)
    }

    private func cancelLoads() {
        let running = loads
        loads = []
        for progress in running where !progress.isFinished { progress.cancel() }
    }

    private static func preferredType(_ provider: NSItemProvider) -> String? {
        let ids = provider.registeredTypeIdentifiers
        return ids.first { UTType($0)?.conforms(to: .image) == true }
            ?? ids.first { UTType($0)?.conforms(to: .movie) == true }
            ?? ids.first
    }
}

// MARK: - Permissions

/// The closed permission enum (P1) mapped onto iOS authorization:
/// camera (AVCaptureDevice video), microphone (AVAudioApplication on iOS 17+,
/// else AVAudioSession), photos (PHPhotoLibrary read-write; `limited` is
/// granted), location (CLLocationManager when-in-use), notifications
/// (UNUserNotificationCenter), bluetooth (CBManager), contacts
/// (CNContactStore) — each onto `granted | denied | prompt`.
@MainActor
public final class SystemPermissionAuthority: DevicePermissionAuthority {
    private var probes: [ObjectIdentifier: AnyObject] = [:]

    public init() {}

    public func status(of permission: DevicePermission,
                       completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        switch permission {
        case .camera:
            completion(Self.map(AVCaptureDevice.authorizationStatus(for: .video)))
        case .microphone:
            completion(Self.microphoneStatus())
        case .location:
            completion(Self.map(CLLocationManager().authorizationStatus))
        case .contacts:
            completion(Self.map(CNContactStore.authorizationStatus(for: .contacts)))
        case .photos:
            completion(Self.map(PHPhotoLibrary.authorizationStatus(for: .readWrite)))
        case .bluetooth:
            completion(Self.map(CBManager.authorization))
        case .notifications:
            UNUserNotificationCenter.current().getNotificationSettings { @Sendable settings in
                let status = Self.map(settings.authorizationStatus)
                Task { @MainActor in completion(status) }
            }
        }
    }

    public func request(_ permission: DevicePermission,
                        completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void) {
        switch permission {
        case .camera:
            AVCaptureDevice.requestAccess(for: .video) { @Sendable granted in
                Task { @MainActor in completion(granted ? .granted : .denied) }
            }
        case .microphone:
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { @Sendable granted in
                    Task { @MainActor in completion(granted ? .granted : .denied) }
                }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { @Sendable granted in
                    Task { @MainActor in completion(granted ? .granted : .denied) }
                }
            }
        case .contacts:
            CNContactStore().requestAccess(for: .contacts) { @Sendable granted, _ in
                Task { @MainActor in completion(granted ? .granted : .denied) }
            }
        case .location:
            // The when-in-use prompt resolves through the manager's delegate.
            let probe = LocationAuthorizationProbe()
            let key = ObjectIdentifier(probe)
            probes[key] = probe
            probe.start { [weak self] status in
                self?.probes[key] = nil
                completion(status)
            }
        case .photos:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { @Sendable status in
                let mapped = Self.map(status)
                Task { @MainActor in completion(mapped) }
            }
        case .notifications:
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { @Sendable granted, _ in
                Task { @MainActor in completion(granted ? .granted : .denied) }
            }
        case .bluetooth:
            // Creating a central manager raises the one-time OS prompt; the
            // first resolved state update reports the user's answer.
            let probe = BluetoothAuthorizationProbe()
            let key = ObjectIdentifier(probe)
            probes[key] = probe
            probe.start { [weak self] status in
                self?.probes[key] = nil
                completion(status)
            }
        }
    }

    public func missingUsageDescription(for permission: DevicePermission) -> String? {
        guard let key = permission.iOSUsageDescriptionKey else { return nil }
        return SystemDeviceAdvertisementEnvironment.infoPlistDeclares(key) ? nil : key
    }

    nonisolated static func map(_ status: AVAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .prompt
        @unknown default: return .prompt
        }
    }

    nonisolated static func microphoneStatus() -> DevicePermissionStatus {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return .granted
            case .denied: return .denied
            case .undetermined: return .prompt
            @unknown default: return .prompt
            }
        }
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        case .undetermined: return .prompt
        @unknown default: return .prompt
        }
    }

    nonisolated static func map(_ status: CLAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorizedWhenInUse, .authorizedAlways: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .prompt
        @unknown default: return .prompt
        }
    }

    nonisolated static func map(_ status: CNAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .prompt
        // `.limited` (iOS 18): the user shared some contacts — access granted.
        @unknown default: return .granted
        }
    }

    nonisolated static func map(_ status: PHAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorized, .limited: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .prompt
        @unknown default: return .prompt
        }
    }

    nonisolated static func map(_ status: UNAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorized, .provisional, .ephemeral: return .granted
        case .denied: return .denied
        case .notDetermined: return .prompt
        @unknown default: return .prompt
        }
    }

    nonisolated static func map(_ status: CBManagerAuthorization) -> DevicePermissionStatus {
        switch status {
        case .allowedAlways: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .prompt
        @unknown default: return .prompt
        }
    }
}

@MainActor
private final class BluetoothAuthorizationProbe: NSObject, CBCentralManagerDelegate {
    private var central: CBCentralManager?
    private var completion: (@MainActor (DevicePermissionStatus) -> Void)?

    func start(_ completion: @escaping @MainActor (DevicePermissionStatus) -> Void) {
        self.completion = completion
        central = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        // Hop rather than assume: correct whatever queue CoreBluetooth uses.
        Task { @MainActor in self.resolve(state) }
    }

    private func resolve(_ state: CBManagerState) {
        guard state != .unknown, state != .resetting, let completion = completion else { return }
        self.completion = nil
        central?.delegate = nil
        central = nil
        completion(SystemPermissionAuthority.map(CBManager.authorization))
    }
}

/// Raises the when-in-use location prompt and reports the user's answer
/// (the first authorization change away from `notDetermined`).
@MainActor
private final class LocationAuthorizationProbe: NSObject, CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var completion: (@MainActor (DevicePermissionStatus) -> Void)?

    func start(_ completion: @escaping @MainActor (DevicePermissionStatus) -> Void) {
        self.completion = completion
        let manager = CLLocationManager()
        manager.delegate = self
        self.manager = manager
        if manager.authorizationStatus != .notDetermined {
            resolve(manager.authorizationStatus)
            return
        }
        manager.requestWhenInUseAuthorization()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in self.resolve(status) }
    }

    private func resolve(_ status: CLAuthorizationStatus) {
        guard status != .notDetermined, let completion = completion else { return }
        self.completion = nil
        manager?.delegate = nil
        manager = nil
        completion(SystemPermissionAuthority.map(status))
    }
}

// MARK: - bluetooth.scan (CoreBluetooth)

@MainActor
public final class CoreBluetoothScannerFactory: BluetoothScannerFactory {
    public init() {}

    public var authorization: DevicePermissionStatus {
        SystemPermissionAuthority.map(CBManager.authorization)
    }

    public var missingUsageDescription: String? {
        DevicePermission.bluetooth.iOSUsageDescriptionKey
            .flatMap { SystemDeviceAdvertisementEnvironment.infoPlistDeclares($0) ? nil : $0 }
    }

    public func makeScanner() -> BluetoothScanner { CoreBluetoothScanner() }

    /// A scan filtered by service UUIDs (canonical 128-bit strings) in
    /// CoreBluetooth itself; discoveries report their advertised services.
    public func makeScanner(services: [String]) -> BluetoothScanner {
        CoreBluetoothScanner(services: services.compactMap { UUID(uuidString: $0).map { CBUUID(nsuuid: $0) } })
    }
}

/// One foreground scan: a dedicated `CBCentralManager` on the main queue,
/// scanning for all peripherals without duplicates, torn down on `stop()`.
@MainActor
final class CoreBluetoothScanner: NSObject, BluetoothScanner, CBCentralManagerDelegate {
    private let services: [CBUUID]?
    private var central: CBCentralManager?
    private var handler: (@Sendable @MainActor (BluetoothScanUpdate) -> Void)?
    private var scanning = false

    /// `services` empty or nil: every peripheral.
    init(services: [CBUUID]? = nil) {
        self.services = (services?.isEmpty ?? true) ? nil : services
        super.init()
    }

    func start(_ handler: @escaping @Sendable @MainActor (BluetoothScanUpdate) -> Void) {
        self.handler = handler
        central = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }

    func stop() {
        if scanning, let central = central, central.state == .poweredOn {
            central.stopScan()
        }
        scanning = false
        central?.delegate = nil
        central = nil
        handler = nil
    }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        Task { @MainActor in self.stateChanged(state) }
    }

    nonisolated func centralManager(_ central: CBCentralManager,
                                    didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any],
                                    rssi RSSI: NSNumber) {
        let id = peripheral.identifier.uuidString
        let name = peripheral.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
        let rssi = RSSI.intValue
        let services = Self.advertisedServices(advertisementData)
        Task { @MainActor in
            self.handler?(.discovered(id: id, name: name, rssi: rssi, services: self.reported(services)))
        }
    }

    /// Service UUIDs in the advertisement (main and overflow area), as
    /// CoreBluetooth strings (`"180D"` short forms included).
    nonisolated static func advertisedServices(_ advertisementData: [String: Any]) -> [String] {
        let main = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let overflow = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? []
        return (main + overflow).map { $0.uuidString }
    }

    /// What this discovery advertises for the driver's filter re-check.
    /// CoreBluetooth only reports peripherals advertising one of a filtered
    /// scan's services, so when the advertisement dictionary itself does not
    /// repeat a requested UUID the OS guarantee stands in for it.
    private func reported(_ advertised: [String]) -> [String] {
        guard let services = services, !services.isEmpty else { return advertised }
        let wanted = Set(services.compactMap { DeviceBluetoothUUID.canonical($0.uuidString) })
        if advertised.contains(where: { DeviceBluetoothUUID.canonical($0).map(wanted.contains) == true }) {
            return advertised
        }
        return advertised + services.map { $0.uuidString }
    }

    private func stateChanged(_ state: CBManagerState) {
        guard let central = central else { return }
        switch state {
        case .poweredOn:
            if !scanning {
                scanning = true
                central.scanForPeripherals(withServices: services,
                                           options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            }
            handler?(.scanning)
        case .poweredOff:
            scanning = false
            handler?(.poweredOff)
        case .unauthorized:
            scanning = false
            handler?(.unauthorized)
        case .unsupported:
            scanning = false
            handler?(.unsupported)
        case .resetting, .unknown:
            break
        @unknown default:
            break
        }
    }
}

// MARK: - Host-local suspension (§2.7)

/// Entering the background stops activation-bound hardware and prompts.
/// Presenting PHPicker or an OS permission alert only resigns active; it
/// does not background the app, so it never suspends its own request.
@MainActor
final class DeviceHostLifecycleObserver {
    nonisolated(unsafe) private var token: NSObjectProtocol?

    init(host: DeviceHost) {
        token = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { @Sendable [weak host] _ in
            Task { @MainActor in host?.suspend() }
        }
    }

    deinit {
        if let token = token { NotificationCenter.default.removeObserver(token) }
    }
}

// MARK: - Advertisement environment (RFC 001 §2.2)

/// The iOS inputs of `DeviceAdvertisementRule`: Info.plist declarations,
/// the camera and audio-input probes, and audio route changes. Nothing here
/// prompts or reads what the user granted.
///
/// Bluetooth hardware counts as present: every supported iPhone and iPad
/// has BLE, and the only probe (`CBCentralManager.state`) shows the
/// Bluetooth permission alert on first use, so it cannot be read before the
/// app asks. A radio that turns out unsupported fails the scan
/// `unavailable` at request time.
@MainActor
public final class SystemDeviceAdvertisementEnvironment: DeviceAdvertisementEnvironment {
    private let camera: CameraCapturer

    public init(camera: CameraCapturer) {
        self.camera = camera
    }

    /// Whether Info.plist has `key` (a usage description).
    static func infoPlistDeclares(_ key: String) -> Bool {
        Bundle.main.object(forInfoDictionaryKey: key) != nil
    }

    public func isDeclared(_ declaration: String) -> Bool {
        Self.infoPlistDeclares(declaration)
    }

    public func hasHardware(_ hardware: DeviceHardware) -> Bool {
        switch hardware {
        case .camera: return camera.isAvailable(facing: nil)
        case .microphone: return AVAudioSession.sharedInstance().isInputAvailable
        case .bluetooth: return true
        }
    }

    /// Audio routes (a headset microphone attached or removed) change
    /// `isInputAvailable`; the cameras do not change at runtime.
    public func observeHardware(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable? {
        NotificationObservation(names: [AVAudioSession.routeChangeNotification], changed: changed)
    }
}

/// NotificationCenter observers on the main queue that hop to the main
/// actor, removed on `cancel()` (or deinit).
@MainActor
final class NotificationObservation: DeviceCancellable {
    nonisolated(unsafe) private var tokens: [NSObjectProtocol] = []

    init(names: [Notification.Name], object: AnyObject? = nil,
         changed: @escaping @Sendable @MainActor () -> Void) {
        tokens = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { @Sendable _ in
                Task { @MainActor in changed() }
            }
        }
    }

    func cancel() {
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        tokens = []
    }

    deinit {
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
    }
}

// MARK: - Factory

extension DeviceHost {
    /// A DeviceHost with the native iOS drivers, advertised by the one rule
    /// of `DeviceAdvertisementRule.iOSRequirements` (RFC 001 §2.2): a
    /// capability is offered iff its hardware is present, its Info.plist
    /// usage descriptions are declared, and — for `bluetooth.scan` and
    /// `mic.record` — the host's indicator can be shown right now. What the
    /// user granted never matters.
    ///
    /// - always: `gallery.pick` (PHPicker), `file.pick` (document picker),
    ///   `file.save` (host consent, then the document exporter as the
    ///   destination picker, then the download), `permission.query`,
    ///   `permission.request` (the whole closed permission enum; an
    ///   undeclared name answers `unavailable` `not-declared:<name>`);
    /// - `camera.capture` (UIImagePickerController) with a camera and
    ///   `NSCameraUsageDescription`;
    /// - `bluetooth.select` (host-owned chooser over a live scan) with
    ///   `NSBluetoothAlwaysUsageDescription`;
    /// - `bluetooth.scan` with that key while the indicator can be shown;
    /// - `mic.record` with an audio input and `NSMicrophoneUsageDescription`
    ///   while the indicator can be shown.
    ///
    /// Undeclared capabilities are left out of `hello.device`; hardware and
    /// indicator readiness gate every `core.capabilities` snapshot, and a
    /// fresh snapshot goes out when they change while connected (scene
    /// foreground/background, overlay lost, audio route change).
    ///
    /// Scans and recordings run under the host's own always-visible
    /// indicator with Stop (§5): `HostDeviceActivityIndicator` over
    /// `UIKitDeviceActivityOverlay`, a passthrough window above the app's UI
    /// (iOS has no system indicator the host can rely on for a BLE scan).
    /// A request racing a readiness change still fails `unavailable` before
    /// any hardware opens, and a stream stops as soon as the overlay can no
    /// longer be seen.
    ///
    /// - Parameters:
    ///   - origin: the server origin the prompts name and grants key on.
    ///     Nil (the default) binds to the origin of each socket the host is
    ///     attached to (`RemoteEngine` passes its URL's origin); a value
    ///     makes the host refuse any socket whose origin differs, so a
    ///     hard-coded production origin can never label (or persist grants
    ///     for) a plaintext or different-host connection (§5).
    ///   - activityIndicator: replaces the host's own indicator for running
    ///     scans and recordings (it must stay visible with a stop control for
    ///     the whole stream, return nil when it cannot be shown, and report
    ///     its readiness).
    ///   - bluetoothChooser: a custom chooser for `bluetooth.select`
    ///     (default: a system sheet listing the live scan).
    public static func iOS(origin: String? = nil,
                           options: Options = Options(),
                           promptGate: DevicePromptGate = .shared,
                           activityIndicator: DeviceActivityIndicator? = nil,
                           bluetoothChooser: BluetoothChooser? = nil) -> DeviceHost {
        let presenter = AlertConsentPresenter()
        let authority = SystemPermissionAuthority()
        let camera = ImagePickerCameraCapturer()
        let indicator = activityIndicator ?? HostDeviceActivityIndicator(surface: UIKitDeviceActivityOverlay())
        let bluetooth = CoreBluetoothScannerFactory()
        let drivers: [DeviceDriver] = [
            GalleryPickDriver(picker: PHPickerGalleryPicker()),
            FilePickDriver(picker: UIDocumentOpenPicker()),
            FileSaveDriver(destination: UIDocumentExportDestinationPicker(), presenter: presenter),
            PermissionQueryDriver(authority: authority),
            PermissionRequestDriver(authority: authority, presenter: presenter),
            CameraCaptureDriver(capturer: camera, authority: authority),
            BluetoothSelectDriver(factory: bluetooth, chooser: bluetoothChooser ?? SheetBluetoothChooser()),
            BluetoothScanDriver(factory: bluetooth, presenter: presenter, indicator: indicator),
            MicRecordDriver(factory: AVAudioEngineCaptureFactory(), authority: authority,
                            presenter: presenter, indicator: indicator),
        ]
        let rule = DeviceAdvertisementRule(requirements: DeviceAdvertisementRule.iOSRequirements,
                                           environment: SystemDeviceAdvertisementEnvironment(camera: camera),
                                           indicator: indicator)
        let host = DeviceHost(origin: origin, drivers: drivers, rule: rule, options: options, promptGate: promptGate)
        host.retained.append(DeviceHostLifecycleObserver(host: host))
        return host
    }
}
#endif
