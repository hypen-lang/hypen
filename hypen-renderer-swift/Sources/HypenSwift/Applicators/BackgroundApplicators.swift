import SwiftUI

// MARK: - Background Image Applicator

/// Applicator for backgroundImage.
///
/// Despite the name, CSS `background-image` is overwhelmingly a GRADIENT in
/// practice — every Tailwind `bg-gradient-to-*` lowers to
/// `linear-gradient(to bottom right, #a, #b)` and arrives here. This used to
/// store the raw string as `backgroundImageUrl`, which a gradient is not, so
/// every gradient tile in the home-screen example rendered flat.
///
/// Remote (`http`) URLs still only get recorded, not fetched: loading them
/// needs an async image loader, and blocking rendering on the network is not
/// an option. `data:` URIs are decoded and painted.
public struct BackgroundImageApplicator: ApplicatorHandler {
    public let name = "backgroundImage"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let layers = CssBackground.parse(value) {
            modifier.cssBackground = layers
            // Kept for component-level handling of remote URLs.
            modifier.backgroundImageUrl = layers.imageUri
            return
        }

        if let urlString = value as? String {
            modifier.backgroundImageUrl = urlString
        } else if let map = value as? [String: Any], let url = map["url"] as? String {
            modifier.backgroundImageUrl = url
        }
    }
}

// MARK: - Background Size Applicator

/// Applicator for backgroundSize.
/// Placeholder for API compatibility.
public struct BackgroundSizeApplicator: ApplicatorHandler {
    public let name = "backgroundSize"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Store for component-level handling
        if let size = value as? String {
            modifier.backgroundSize = size
        }
    }
}

// MARK: - Background Position Applicator

/// Applicator for backgroundPosition.
/// Placeholder for API compatibility.
public struct BackgroundPositionApplicator: ApplicatorHandler {
    public let name = "backgroundPosition"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Store for component-level handling
        if let position = value as? String {
            modifier.backgroundPosition = position
        }
    }
}
