// Device Capability Protocol — the one advertisement rule of the native
// hosts (RFC 001 §2.2: "Advertise only implementable capability names").
//
// A capability is advertised iff
//   (1) the hardware it drives is present,
//   (2) the app declared what the OS requires before it may be used (on iOS
//       the Info.plist usage-description keys: asking without one terminates
//       the app), and
//   (3) for a stream that runs under the host's always-visible indicator
//       (`bluetooth.scan`, `mic.record`; RFC 001 §5), that indicator can be
//       shown right now.
// Whether the user has GRANTED a permission never enters the rule: an
// un-asked permission is still advertised so the app can prompt, and the
// advertisement never leaks permission history.
//
// `hello.device` carries every capability passing (2) — declarations are
// fixed for the life of the process, so everything that can ever become
// available on a connection is selectable. Every `core.capabilities`
// snapshot applies the whole rule, and a fresh snapshot goes out whenever
// (1) or (3) changes while connected (indicator shown/hidden, foreground
// scene gained/lost, hardware attached/detached where the OS reports it).
//
// Platform-neutral so every branch is tested on Linux through fakes; the
// iOS environment (Bundle.main, UIImagePickerController, AVAudioSession)
// lives in DeviceHostIOS.swift.

import Foundation

private let log = HypenLoggers.remote.child("Device")

/// Hardware a capability drives, probed by the platform (branch 1).
public enum DeviceHardware: String, Sendable, CaseIterable {
    case camera
    case microphone
    case bluetooth
}

/// What a capability needs before it is advertised.
public struct DeviceCapabilityRequirements: Sendable, Equatable {
    /// Hardware that must be present (branch 1).
    public var hardware: Set<DeviceHardware>
    /// What the app must declare for the OS (branch 2): on iOS, Info.plist
    /// usage-description keys.
    public var declarations: [String]
    /// Runs under the host's always-visible indicator, which must be
    /// showable right now (branch 3).
    public var needsIndicator: Bool

    public init(hardware: Set<DeviceHardware> = [], declarations: [String] = [], needsIndicator: Bool = false) {
        self.hardware = hardware
        self.declarations = declarations
        self.needsIndicator = needsIndicator
    }

    /// Needs nothing (pickers, `permission.*`): always advertised.
    public static let none = DeviceCapabilityRequirements()
}

/// The platform side of the rule: hardware probes and declarations. Neither
/// may prompt the user or depend on what the user granted.
@MainActor
public protocol DeviceAdvertisementEnvironment: AnyObject {
    func hasHardware(_ hardware: DeviceHardware) -> Bool
    func isDeclared(_ declaration: String) -> Bool
    /// Calls `changed` whenever a `hasHardware` answer may have changed,
    /// until the returned handle is cancelled; nil when the platform cannot
    /// observe hardware changes.
    func observeHardware(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable?
}

extension DevicePermission {
    /// The Info.plist key iOS requires before this permission may be asked
    /// for (asking without it terminates the app); nil when none is needed.
    public var iOSUsageDescriptionKey: String? {
        switch self {
        case .camera: return "NSCameraUsageDescription"
        case .microphone: return "NSMicrophoneUsageDescription"
        case .photos: return "NSPhotoLibraryUsageDescription"
        case .bluetooth: return "NSBluetoothAlwaysUsageDescription"
        case .location: return "NSLocationWhenInUseUsageDescription"
        case .contacts: return "NSContactsUsageDescription"
        case .notifications: return nil
        }
    }
}

/// The advertisement rule over one platform's requirements table.
@MainActor
public final class DeviceAdvertisementRule {
    public let requirements: [String: DeviceCapabilityRequirements]
    public let environment: DeviceAdvertisementEnvironment
    /// The host's indicator; nil means none can be shown, so no capability
    /// that needs one is advertised.
    public let indicator: DeviceActivityIndicator?

    public init(requirements: [String: DeviceCapabilityRequirements],
                environment: DeviceAdvertisementEnvironment,
                indicator: DeviceActivityIndicator?) {
        self.requirements = requirements
        self.environment = environment
        self.indicator = indicator
    }

    /// Branch (2) alone: whether `capability` can ever be advertised in this
    /// process. A capability missing from the requirements table is not
    /// implementable (never advertised by accident); `core.capabilities` is
    /// always advertised.
    public func isDeclared(_ capability: String) -> Bool {
        if capability == CoreCapabilitiesDriver.name { return true }
        guard let needs = requirements[capability] else { return false }
        return needs.declarations.allSatisfy { environment.isDeclared($0) }
    }

    /// The whole rule, now: declared, hardware present, and (when needed) the
    /// indicator showable. Permission status is deliberately not an input.
    public func isAdvertised(_ capability: String) -> Bool {
        guard isDeclared(capability) else { return false }
        guard let needs = requirements[capability] else { return true } // core.capabilities
        guard needs.hardware.allSatisfy({ environment.hasHardware($0) }) else { return false }
        if needs.needsIndicator {
            guard let indicator = indicator, indicator.isReady else { return false }
        }
        return true
    }

    /// Calls `changed` whenever an `isAdvertised` answer may have changed
    /// (indicator readiness, hardware); cancel the handles to stop.
    public func observe(_ changed: @escaping @Sendable @MainActor () -> Void) -> [DeviceCancellable] {
        var handles: [DeviceCancellable] = []
        if let indicator = indicator { handles.append(indicator.observeReadiness(changed)) }
        if let hardware = environment.observeHardware(changed) { handles.append(hardware) }
        return handles
    }

    /// The stock iOS host's table (`DeviceHost.iOS()`):
    /// - `gallery.pick` (PHPicker runs out of process and needs no
    ///   permission), `file.pick`, `file.save` and `permission.*` need
    ///   nothing — `permission.*` answers an undeclared name with
    ///   `unavailable` `not-declared:<name>` instead;
    /// - `camera.capture` needs a camera and `NSCameraUsageDescription`
    ///   (video's microphone is checked per request). The system camera UI
    ///   is itself on screen, so no host indicator;
    /// - `bluetooth.select` needs `NSBluetoothAlwaysUsageDescription` (its
    ///   chooser sheet is itself visible);
    /// - `bluetooth.scan` needs the same key and the host indicator;
    /// - `mic.record` needs an audio input, `NSMicrophoneUsageDescription`
    ///   and the host indicator.
    public static let iOSRequirements: [String: DeviceCapabilityRequirements] = [
        "gallery.pick": .none,
        "file.pick": .none,
        "file.save": .none,
        "permission.query": .none,
        "permission.request": .none,
        "camera.capture": DeviceCapabilityRequirements(
            hardware: [.camera], declarations: [DevicePermission.camera.iOSUsageDescriptionKey!]),
        "bluetooth.select": DeviceCapabilityRequirements(
            hardware: [.bluetooth], declarations: [DevicePermission.bluetooth.iOSUsageDescriptionKey!]),
        "bluetooth.scan": DeviceCapabilityRequirements(
            hardware: [.bluetooth], declarations: [DevicePermission.bluetooth.iOSUsageDescriptionKey!],
            needsIndicator: true),
        "mic.record": DeviceCapabilityRequirements(
            hardware: [.microphone], declarations: [DevicePermission.microphone.iOSUsageDescriptionKey!],
            needsIndicator: true),
    ]
}

extension DeviceHost {
    /// A host whose advertisement follows `rule` (RFC 001 §2.2): drivers
    /// whose declarations are missing are left out entirely; the others are
    /// offered in `hello.device`, and each `core.capabilities` snapshot lists
    /// only those the whole rule allows now. A fresh snapshot is sent
    /// whenever the rule's answer changes while connected.
    public convenience init(origin: String?,
                            drivers: [DeviceDriver],
                            rule: DeviceAdvertisementRule,
                            options: Options = Options(),
                            clock: DeviceClock = SystemDeviceClock(),
                            promptGate: DevicePromptGate = DevicePromptGate(),
                            persistentStore: DeviceKeyValueStore = UserDefaultsDeviceStore()) {
        let declared = drivers.filter { driver in
            let ok = rule.isDeclared(driver.capability)
            if !ok, rule.requirements[driver.capability] == nil {
                log.warn("\(driver.capability) has no advertisement requirements: not advertised")
            }
            return ok
        }
        self.init(origin: origin, drivers: declared, options: options, clock: clock,
                  promptGate: promptGate, persistentStore: persistentStore)
        advertisementRule = rule
        retained += rule.observe { [weak self] in self?.refreshAdvertisement() }.map { $0 as AnyObject }
    }
}
