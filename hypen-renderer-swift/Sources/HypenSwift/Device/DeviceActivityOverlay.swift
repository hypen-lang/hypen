// Device Capability Protocol — the host-owned activity indicator (RFC 001
// §5): "Audio/BLE streams require an always-visible host indicator and stop
// control." `HostDeviceActivityIndicator` owns the bookkeeping (which streams
// are running, which Stop belongs to which stream, what happens when the
// overlay can no longer be seen) and drives a platform
// `DeviceActivityIndicatorSurface`; on iOS that surface is
// `UIKitDeviceActivityOverlay`, a passthrough window above the app's own UI.
//
// Platform-neutral so the protocol behaviour is tested on Linux through a
// fake surface; the UIKit surface lives in DeviceHostIOSCapture.swift.

import Foundation

/// One running stream listed by the host indicator. `origin` is the
/// authenticated display origin and `activity` a host-controlled label
/// (never server text).
public struct DeviceActivityIndicatorEntry: Sendable, Equatable {
    public let id: UInt64
    public let origin: String
    public let activity: String

    public init(id: UInt64, origin: String, activity: String) {
        self.id = id
        self.origin = origin
        self.activity = activity
    }
}

/// The visible overlay a `HostDeviceActivityIndicator` drives: host-owned UI
/// outside the patch tree that app content cannot cover or restyle.
@MainActor
public protocol DeviceActivityIndicatorSurface: AnyObject {
    /// The user used the Stop control of the entry with this id.
    var stopHandler: (@Sendable @MainActor (UInt64) -> Void)? { get set }
    /// The overlay stopped being visible on its own (its scene went to the
    /// background or disconnected): every listed stream must stop.
    var lostHandler: (@Sendable @MainActor () -> Void)? { get set }
    /// Show the overlay (creating it when needed) listing `entries`, which is
    /// never empty. Returns whether the overlay is visible now; false means
    /// it cannot be shown (no foreground scene), and nothing is left on screen.
    func render(_ entries: [DeviceActivityIndicatorEntry]) -> Bool
    /// Remove the overlay (no stream is running any more).
    func dismiss()
    /// Whether `render` could make the overlay visible right now (a
    /// foreground scene exists), without creating it.
    var canShow: Bool { get }
    /// Called whenever `canShow` may have changed (a scene came to the
    /// foreground, went to the background, connected or disconnected).
    var readinessHandler: (@Sendable @MainActor () -> Void)? { get set }
}

/// The host's own `DeviceActivityIndicator`: every running scan or
/// recording is listed on one always-visible overlay, each with a Stop
/// control. `showIndicator` returns nil (the driver then fails
/// `unavailable` before any hardware opens) when the overlay cannot be
/// visible; if the overlay later stops being visible, every running stream
/// is stopped, so no stream ever runs without its indicator. `isReady`
/// mirrors whether the surface could be shown, and readiness observers hear
/// every scene change the surface reports and every loss of the overlay.
@MainActor
public final class HostDeviceActivityIndicator: DeviceActivityIndicator {
    private struct Running {
        let entry: DeviceActivityIndicatorEntry
        let stop: @Sendable @MainActor () -> Void
    }

    private let surface: DeviceActivityIndicatorSurface
    private var running: [Running] = []
    private var nextId: UInt64 = 1
    private var readinessObservers: [UInt64: @Sendable @MainActor () -> Void] = [:]
    private var nextObserverId: UInt64 = 1

    public init(surface: DeviceActivityIndicatorSurface) {
        self.surface = surface
        surface.stopHandler = { [weak self] id in self?.userStopped(id) }
        surface.lostHandler = { [weak self] in self?.lost() }
        surface.readinessHandler = { [weak self] in self?.readinessChanged() }
    }

    /// The streams currently listed, in start order.
    public var entries: [DeviceActivityIndicatorEntry] { running.map { $0.entry } }

    /// The overlay could be shown now.
    public var isReady: Bool { surface.canShow }

    public func observeReadiness(_ changed: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable {
        let id = nextObserverId
        nextObserverId &+= 1
        readinessObservers[id] = changed
        return IndicatorHandle { [weak self] in self?.readinessObservers[id] = nil }
    }

    /// Tell observers (in registration order) that `isReady` may have changed.
    private func readinessChanged() {
        for id in readinessObservers.keys.sorted() {
            readinessObservers[id]?()
        }
    }

    public func showIndicator(origin: String,
                              activity: String,
                              stop: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable? {
        let entry = DeviceActivityIndicatorEntry(id: nextId, origin: origin, activity: activity)
        nextId &+= 1
        running.append(Running(entry: entry, stop: stop))
        guard surface.render(entries) else {
            // Not visible: the stream must not start. Streams already listed
            // cannot be visible either, so they stop too.
            running.removeAll { $0.entry.id == entry.id }
            lost()
            return nil
        }
        return IndicatorHandle { [weak self] in self?.remove(entry.id) }
    }

    /// The stream ended (its handle was cancelled): unlist it.
    private func remove(_ id: UInt64) {
        guard running.contains(where: { $0.entry.id == id }) else { return }
        running.removeAll { $0.entry.id == id }
        refresh()
    }

    /// Stop control: unlist first (the stop handler may cancel the handle
    /// again, which is then a no-op), then end the stream.
    private func userStopped(_ id: UInt64) {
        guard let index = running.firstIndex(where: { $0.entry.id == id }) else { return }
        let stopped = running.remove(at: index)
        refresh()
        stopped.stop()
    }

    /// The overlay can no longer be seen: stop every stream, then report
    /// the (likely) readiness change — the overlay was detached.
    private func lost() {
        let stopped = running
        running = []
        surface.dismiss()
        stopped.forEach { $0.stop() }
        readinessChanged()
    }

    private func refresh() {
        if running.isEmpty {
            surface.dismiss()
        } else if !surface.render(entries) {
            lost()
        }
    }
}

@MainActor
private final class IndicatorHandle: DeviceCancellable {
    private var onCancel: (@MainActor () -> Void)?

    init(_ onCancel: @escaping @MainActor () -> Void) { self.onCancel = onCancel }

    func cancel() {
        let run = onCancel
        onCancel = nil
        run?()
    }
}
