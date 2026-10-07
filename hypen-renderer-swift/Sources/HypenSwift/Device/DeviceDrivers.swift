import Foundation

// Device Capability Protocol — capability drivers (RFC 001 §2.6, §3, §7).
//
// Drivers hold the per-capability protocol logic and talk to the OS only
// through the small backend protocols below. `DeviceHostIOS.swift` supplies
// the UIKit / PhotosUI / AVFoundation / UserNotifications / CoreBluetooth
// implementations; tests supply fakes.

// MARK: - Backend protocols

/// How a host-owned consent interaction ended.
public enum DeviceConsentOutcome: Sendable, Equatable {
    /// Continue.
    case accepted
    /// Cancel or dismissal: a refusal (starts the denial cooldown).
    case declined
    /// The interaction could not be shown after all (e.g. UIKit refused the
    /// presentation mid-transition): no user decision, no cooldown; the
    /// driver fails `unavailable` and releases the prompt slot at once.
    case unavailable
}

/// Host-owned consent interaction (§2.6 step 2): names the authenticated app
/// origin and a host-controlled operation label, with Continue and Cancel.
/// Labels never come from server text.
@MainActor
public protocol DeviceConsentPresenter: AnyObject, Sendable {
    /// Present the interaction. Returns nil when nothing can present it (no
    /// foreground key window, a presentation already in progress) — the
    /// driver then fails `unavailable`. `completion` is called at most once.
    func presentConsent(origin: String,
                        operation: String,
                        completion: @escaping @Sendable @MainActor (DeviceConsentOutcome) -> Void) -> DeviceCancellable?
}

/// One picked media item, fully loaded.
public struct PickedMedia: Sendable {
    public let contentType: String
    public let data: Data

    public init(contentType: String, data: Data) {
        self.contentType = contentType
        self.data = data
    }
}

public enum GalleryPickOutcome: Sendable {
    case picked([PickedMedia])
    /// The user dismissed the picker without choosing (maps to `cancelled`, §2.6 step 4).
    case dismissed
    /// A picked item exceeds the revision's `maxItemBytes`; detected from
    /// the file size before its bytes are read (maps to `throttled`).
    case tooLarge
    /// The picker could not be shown after all (UIKit refused the
    /// presentation): maps to `unavailable`, never a user decision.
    case presentationFailed
    /// Loading failed. The detail is a fixed diagnostic token (never raw
    /// OS error text, which can carry paths): it becomes `platformDetail`.
    case failed(String)
}

/// A system media picker that already supplies the per-use user choice, so
/// no host consent dialog is needed before it (§2.6, §7).
@MainActor
public protocol GalleryPicker: AnyObject, Sendable {
    /// Present the picker. Returns nil when it cannot be presented safely
    /// (no key window / presenter) — the driver then fails `unavailable`.
    /// Cancelling the handle dismisses the picker; a completion delivered
    /// after that is ignored by the host.
    ///
    /// Implementations must check each item's size against `maxItemBytes`
    /// before reading it (report `.tooLarge`), and should hand back
    /// file-backed (memory-mapped) `Data` rather than loading whole assets.
    ///
    /// `selected` runs once when the user has chosen items and the picker UI
    /// is gone, before they finish loading: the host then releases the
    /// app-wide prompt slot and keeps the choice across a backgrounding
    /// while items load. Cancelling the handle also cancels item loading.
    func presentPicker(mediaTypes: Set<String>,
                       maxCount: Int,
                       maxItemBytes: UInt64,
                       selected: @escaping @Sendable @MainActor () -> Void,
                       completion: @escaping @Sendable @MainActor (GalleryPickOutcome) -> Void) -> DeviceCancellable?
}

/// Portable permission names accepted by `permission.query` / `permission.request`.
///
/// The closed `Permission` enum of RFC 001 §3 (P1): every host maps the same
/// names; anything else is `invalidParams` at decode.
public enum DevicePermission: String, CaseIterable, Sendable {
    case camera
    case microphone
    case photos
    case location
    case notifications
    case bluetooth
    case contacts
}

/// `permission.*@1` status values.
public enum DevicePermissionStatus: String, Sendable, Codable {
    case granted
    case denied
    case prompt
}

/// OS permission snapshots and prompts.
@MainActor
public protocol DevicePermissionAuthority: AnyObject, Sendable {
    func status(of permission: DevicePermission,
                completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void)
    func request(_ permission: DevicePermission,
                 completion: @escaping @Sendable @MainActor (DevicePermissionStatus) -> Void)
    /// The Info.plist usage-description key the OS requires before prompting,
    /// when it is missing (prompting without it terminates the app).
    func missingUsageDescription(for permission: DevicePermission) -> String?
    /// Whether this host can represent `permission` at all. A host that
    /// cannot answers `unsupported` with the permission name as
    /// `platformDetail` (P1). Defaults to true.
    func supports(_ permission: DevicePermission) -> Bool
}

extension DevicePermissionAuthority {
    public func supports(_ permission: DevicePermission) -> Bool { true }
}

/// Host-owned, always-visible activity indicator with a stop control for a
/// running audio/BLE stream (RFC 001 §5: "Audio/BLE streams require an
/// always-visible host indicator and stop control … Do not assume every OS
/// has a BLE indicator"). iOS shows no system indicator for BLE scanning,
/// so the host brings its own: `HostDeviceActivityIndicator` (the default
/// of `DeviceHost.iOS()`), or one the app supplies.
@MainActor
public protocol DeviceActivityIndicator: AnyObject, Sendable {
    /// Show the indicator naming the authenticated `origin` and a
    /// host-controlled `activity` label (never server text). `stop` ends the
    /// stream when the user uses the stop control. The returned handle hides
    /// the indicator; nil means it cannot be shown right now, and the driver
    /// then fails `unavailable` rather than run invisibly.
    func showIndicator(origin: String,
                       activity: String,
                       stop: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable?
    /// Whether `showIndicator` could make the indicator visible right now
    /// (e.g. a foreground scene exists). The advertisement rule offers
    /// `bluetooth.scan` and `mic.record` only while this is true (§2.2).
    var isReady: Bool { get }
    /// Calls `changed` whenever `isReady` may have changed (scene
    /// foreground/background, overlay attached/detached), until the returned
    /// handle is cancelled. Spurious calls are fine; missed changes are not.
    func observeReadiness(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable
}

public enum BluetoothScanUpdate: Sendable, Equatable {
    /// Powered on and scanning (authorization resolved).
    case scanning
    /// A peripheral. `services` lists the service UUIDs it advertises, in
    /// any form `DeviceBluetoothUUID.canonical` accepts; nil when the scanner
    /// does not report them (then a service-filtered `bluetooth.select`
    /// cannot confirm the device matches, and does not list it).
    case discovered(id: String, name: String?, rssi: Int, services: [String]? = nil)
    case poweredOff
    case unauthorized
    case unsupported
}

/// A foreground BLE scanner (one per operation).
@MainActor
public protocol BluetoothScanner: AnyObject, Sendable {
    /// Start; updates flow to `handler` until `stop()`.
    func start(_ handler: @escaping @Sendable @MainActor (BluetoothScanUpdate) -> Void)
    func stop()
}

@MainActor
public protocol BluetoothScannerFactory: AnyObject, Sendable {
    var authorization: DevicePermissionStatus { get }
    /// Info.plist key missing for Bluetooth, if any.
    var missingUsageDescription: String? { get }
    func makeScanner() -> BluetoothScanner
    /// A scanner that reports only peripherals advertising one of
    /// `services` (canonical lowercase 128-bit UUIDs; empty = all), with
    /// each discovery's advertised `services`. Deliberately without a
    /// default: a backend that silently ignored the filter would widen what
    /// the server asked for. `BluetoothSelectDriver` re-checks every
    /// discovery against the filter as well.
    func makeScanner(services: [String]) -> BluetoothScanner
}

// MARK: - Diagnostics

/// `platformDetail` is diagnostic text sent to the server (§3): drivers send
/// fixed tokens, never raw OS error descriptions, which can carry container
/// paths, file names and UUIDs.
public enum DeviceDiagnostics {
    /// `load-failed:<domain>:<code>` for an item-loading error (the domain
    /// restricted to `[A-Za-z0-9._-]`, at most 64 characters).
    public static func loadFailureToken(_ error: Error?) -> String {
        guard let error = error else { return "load-failed" }
        let ns = error as NSError
        let domain = String(ns.domain.unicodeScalars.filter {
            ($0 >= "A" && $0 <= "Z") || ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9")
                || $0 == "." || $0 == "_" || $0 == "-"
        }.prefix(64).map(Character.init))
        return "load-failed:\(domain):\(ns.code)"
    }
}

// MARK: - Capability param shapes (closed, provisional revision 1)

struct GalleryPickParams: Decodable {
    let mediaTypes: [String]
    let maxCount: Int

    init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(decoder, allowed: ["mediaTypes", "maxCount"], typeName: "gallery.pick params")
        mediaTypes = try c.req([String].self, "mediaTypes")
        maxCount = try c.req(Int.self, "maxCount")
        guard !mediaTypes.isEmpty, Set(mediaTypes).count == mediaTypes.count,
              mediaTypes.allSatisfy({ $0 == "photo" || $0 == "video" }) else {
            throw DeviceWire.fail(c, "mediaTypes must be a non-empty subset of [photo, video]")
        }
        guard (1...16).contains(maxCount) else { throw DeviceWire.fail(c, "maxCount must be 1...16") }
    }
}

struct PermissionParams: Decodable {
    let permission: DevicePermission

    init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(decoder, allowed: ["permission"], typeName: "permission params")
        let name = try c.string("permission", maxLength: 64)
        // Closed enum, exact bytes (no case folding, no aliases).
        guard let permission = DevicePermission.allCases.first(where: { DeviceWire.sameName($0.rawValue, name) }) else {
            throw DeviceWire.fail(c, "permission must be one of \(DevicePayloads.permissionNames)")
        }
        self.permission = permission
    }
}

struct EmptyParams: Decodable {
    init(from decoder: Decoder) throws {
        _ = try DeviceWire.closedContainer(decoder, allowed: [], typeName: "params")
    }
}

// MARK: - gallery.pick

/// `gallery.pick@1`: the system picker is the per-use gate (§3). Picked items
/// upload as blobs; the host streams and hashes them.
@MainActor
public final class GalleryPickDriver: DeviceDriver {
    public let capability = "gallery.pick"
    private let picker: GalleryPicker

    public init(picker: GalleryPicker) {
        self.picker = picker
    }

    public func start(_ op: DeviceOperation) {
        guard let params = op.params(GalleryPickParams.self) else {
            op.fail(.invalidParams, "gallery.pick params")
            return
        }
        if let blocked = op.acquirePrompt() {
            op.fail(blocked)
            return
        }
        let types = Set(params.mediaTypes)
        let maxCount = params.maxCount
        let handle = picker.presentPicker(mediaTypes: types, maxCount: maxCount,
                                          maxItemBytes: op.policy.maxItemBytes,
                                          selected: {
            // The picker UI is gone and the user chose: free the app-wide
            // prompt slot now (not after transcoding) and keep the choice
            // across a backgrounding while items load.
            op.releasePrompt()
            op.markUserChoiceMade()
        }) { outcome in
            op.releasePrompt()
            switch outcome {
            case let .picked(items) where !items.isEmpty:
                op.succeed([:], blobs: items.prefix(maxCount).map {
                    DeviceBlob(contentType: $0.contentType, bytes: $0.data)
                })
            case .picked, .dismissed:
                // Picker dismissal is abandonment, not a permission denial (§2.6 step 4).
                op.fail(.cancelled, "picker-dismissed")
            case .tooLarge:
                op.fail(.throttled, "item exceeds size limit")
            case .presentationFailed:
                op.fail(.unavailable, "presentation-failed")
            case let .failed(detail):
                op.fail(.internal, detail)
            }
        }
        guard let presented = handle else {
            op.releasePrompt()
            op.fail(.unavailable, "no-presenter")
            return
        }
        op.onCancel { presented.cancel() }
    }
}

// MARK: - permission.query / permission.request

/// `permission.query@1`: a live snapshot; never prompts.
@MainActor
public final class PermissionQueryDriver: DeviceDriver {
    public let capability = "permission.query"
    private let authority: DevicePermissionAuthority

    public init(authority: DevicePermissionAuthority) {
        self.authority = authority
    }

    public func start(_ op: DeviceOperation) {
        guard let permission = op.params(PermissionParams.self)?.permission else {
            op.fail(.invalidParams, "permission params")
            return
        }
        guard authority.supports(permission) else {
            op.fail(.unsupported, permission.rawValue)
            return
        }
        // Undeclared: the same answer whatever the user granted (§2.2).
        guard authority.missingUsageDescription(for: permission) == nil else {
            op.fail(.unavailable, "not-declared:\(permission.rawValue)")
            return
        }
        authority.status(of: permission) { status in
            op.succeed(["status": .string(status.rawValue)])
        }
    }
}

/// `permission.request@1` (perUse): a host-owned consent naming the origin,
/// then the OS prompt. Already-resolved permissions answer without prompting.
@MainActor
public final class PermissionRequestDriver: DeviceDriver {
    public let capability = "permission.request"
    private let authority: DevicePermissionAuthority
    private let presenter: DeviceConsentPresenter

    public init(authority: DevicePermissionAuthority, presenter: DeviceConsentPresenter) {
        self.authority = authority
        self.presenter = presenter
    }

    static func label(_ permission: DevicePermission) -> String {
        switch permission {
        case .camera: return "use your camera"
        case .microphone: return "use your microphone"
        case .photos: return "access your photo library"
        case .location: return "use your location"
        case .notifications: return "send you notifications"
        case .bluetooth: return "use Bluetooth"
        case .contacts: return "access your contacts"
        }
    }

    public func start(_ op: DeviceOperation) {
        guard let permission = op.params(PermissionParams.self)?.permission else {
            op.fail(.invalidParams, "permission params")
            return
        }
        guard authority.supports(permission) else {
            op.fail(.unsupported, permission.rawValue)
            return
        }
        // Undeclared: the same answer whatever the user granted, and the OS
        // is never asked (prompting without the declaration terminates the
        // app on iOS).
        guard authority.missingUsageDescription(for: permission) == nil else {
            op.fail(.unavailable, "not-declared:\(permission.rawValue)")
            return
        }
        let authority = self.authority
        let presenter = self.presenter
        authority.status(of: permission) { status in
            guard !op.isSettled else { return }
            switch status {
            case .granted:
                op.succeed(["status": .string("granted")])
                return
            case .denied:
                // iOS cannot re-prompt a denied permission; the user must use Settings.
                op.fail(.denied, "os-denied")
                return
            case .prompt:
                break
            }
            if let blocked = op.acquirePrompt() {
                op.fail(blocked)
                return
            }
            let handle = presenter.presentConsent(origin: op.displayOrigin, operation: Self.label(permission)) { outcome in
                guard !op.isSettled else { return }
                switch outcome {
                case .accepted:
                    break
                case .declined:
                    op.releasePrompt()
                    op.recordDenial()
                    op.fail(.denied, "host-refused")
                    return
                case .unavailable:
                    op.releasePrompt()
                    op.fail(.unavailable, "presentation-failed")
                    return
                }
                op.recordAcceptance()
                authority.request(permission) { result in
                    op.releasePrompt()
                    switch result {
                    case .granted: op.succeed(["status": .string("granted")])
                    case .denied: op.fail(.denied, "os-denied")
                    case .prompt: op.succeed(["status": .string("prompt")])
                    }
                }
            }
            guard let consent = handle else {
                op.releasePrompt()
                op.fail(.unavailable, "no-presenter")
                return
            }
            op.onCancel { consent.cancel() }
        }
    }
}

// MARK: - bluetooth.scan

/// `bluetooth.scan@1` (stream, persistable consent with expiry): emits
/// `{device:{id,name?,rssi}}` per discovery; stops on cancel, deadline, lease
/// expiry, suspension, detach, or the user's stop control; `unavailable`
/// when powered off or when the activity indicator cannot be shown;
/// `denied` when unauthorized (`revoked` if authorization is lost mid-scan).
/// The host-owned indicator is visible for the whole scan (§5).
@MainActor
public final class BluetoothScanDriver: DeviceDriver {
    public static let activityLabel = "Scanning for nearby Bluetooth devices"

    public let capability = "bluetooth.scan"
    private let factory: BluetoothScannerFactory
    private let presenter: DeviceConsentPresenter
    private let indicator: DeviceActivityIndicator
    /// Lifetime of a host-owned persistable grant (finite, re-affirmed on expiry).
    public let grantLifetime: TimeInterval

    public init(factory: BluetoothScannerFactory,
                presenter: DeviceConsentPresenter,
                indicator: DeviceActivityIndicator,
                grantLifetime: TimeInterval = 7 * 24 * 3600) {
        self.factory = factory
        self.presenter = presenter
        self.indicator = indicator
        self.grantLifetime = grantLifetime
    }

    public func start(_ op: DeviceOperation) {
        guard op.params(EmptyParams.self) != nil else {
            op.fail(.invalidParams, "bluetooth.scan params must be {}")
            return
        }
        if factory.missingUsageDescription != nil {
            op.fail(.unavailable, "not-declared:\(DevicePermission.bluetooth.rawValue)")
            return
        }
        let authorization = factory.authorization
        if authorization == .denied {
            op.fail(.denied, "os-denied")
            return
        }
        let needsConsent = !op.grants.hasGrant(capability, now: op.clock.wallNow)
        if needsConsent || authorization == .prompt {
            if let blocked = op.acquirePrompt() {
                op.fail(blocked)
                return
            }
        }
        guard needsConsent else {
            beginScan(op)
            return
        }
        let capability = self.capability
        let lifetime = grantLifetime
        let handle = presenter.presentConsent(origin: op.displayOrigin, operation: "scan for nearby Bluetooth devices") { [weak self] outcome in
            guard !op.isSettled else { return }
            switch outcome {
            case .accepted:
                break
            case .declined:
                op.releasePrompt()
                op.recordDenial()
                op.fail(.denied, "host-refused")
                return
            case .unavailable:
                op.releasePrompt()
                op.fail(.unavailable, "presentation-failed")
                return
            }
            op.recordAcceptance()
            op.grants.setGrant(capability, until: op.clock.wallNow.addingTimeInterval(lifetime))
            if authorization != .prompt { op.releasePrompt() }
            self?.beginScan(op)
        }
        guard let consent = handle else {
            op.releasePrompt()
            op.fail(.unavailable, "no-presenter")
            return
        }
        op.onCancel { consent.cancel() }
    }

    private func beginScan(_ op: DeviceOperation) {
        guard !op.isSettled else { return }
        let scanner = factory.makeScanner()
        let state = ScanState()
        // Always-visible indicator + stop control for the whole scan (§5).
        let shown = indicator.showIndicator(origin: op.displayOrigin, activity: Self.activityLabel) {
            guard !op.isSettled else { return }
            scanner.stop()
            state.indicator?.cancel()
            state.indicator = nil
            op.fail(.cancelled, "user-stopped")
        }
        guard let visible = shown else {
            op.releasePrompt()
            op.fail(.unavailable, "no-activity-indicator")
            return
        }
        state.indicator = visible
        let stopAll: @MainActor () -> Void = {
            scanner.stop()
            state.indicator?.cancel()
            state.indicator = nil
        }
        op.onCancel(stopAll)
        let capability = self.capability
        scanner.start { update in
            guard !op.isSettled else {
                stopAll()
                return
            }
            switch update {
            case .scanning:
                state.started = true
                op.releasePrompt()
            case let .discovered(id, name, rssi, _):
                state.started = true
                op.releasePrompt()
                // RSSI 127 is CoreBluetooth's "unavailable" sentinel.
                guard rssi != 127 else { return }
                var device: DeviceJSONObject = [
                    "id": .string(String(id.prefix(128))),
                    "rssi": .int(Int64(max(-32768, min(32767, rssi)))),
                ]
                if let name = name, !name.isEmpty { device["name"] = .string(String(name.prefix(256))) }
                op.emit(["device": .object(device)])
            case .poweredOff:
                stopAll()
                op.fail(.unavailable, "powered-off")
            case .unsupported:
                stopAll()
                op.fail(.unavailable, "unsupported-hardware")
            case .unauthorized:
                stopAll()
                op.grants.revokeGrant(capability)
                op.fail(state.started ? .revoked : .denied, "os-denied")
            }
        }
    }
}

@MainActor
private final class ScanState {
    var started = false
    var indicator: DeviceCancellable?
}
