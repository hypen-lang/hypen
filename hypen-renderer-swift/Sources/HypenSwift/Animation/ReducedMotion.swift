import Foundation

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The platform reduce-motion preference.
///
/// SwiftUI's `@Environment(\.accessibilityReduceMotion)` is the live,
/// view-side signal and is what the view modifiers read; this type is the
/// renderer-side twin, used at patch-apply time (where there is no
/// environment) to decide whether an exit defers or snaps.
///
/// Reduced motion snaps everything — transitions, enters, `.animate`
/// playback — and finalizes flagged removes immediately. The per-node
/// `.motion(essential)` opt-out (`__anim.motion` = `{essential: true}`)
/// exempts a node from ALL of those shortcuts.
@MainActor
public enum HypenReducedMotion {
    /// Test/host override. When non-nil it wins over the platform query.
    public static var override: Bool?

    public static var isEnabled: Bool {
        if let override = override { return override }
        #if os(iOS) || os(tvOS) || os(watchOS) || targetEnvironment(macCatalyst)
        return UIAccessibility.isReduceMotionEnabled
        #elseif os(macOS)
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        return false
        #endif
    }
}
