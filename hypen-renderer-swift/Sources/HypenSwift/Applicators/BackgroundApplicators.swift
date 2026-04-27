import SwiftUI

// MARK: - Background Image Applicator

/// Applicator for backgroundImage.
/// Note: In SwiftUI, background images are typically handled differently
/// (using ZStack with Image behind content).
/// This applicator stores the URL for potential component-level handling.
public struct BackgroundImageApplicator: ApplicatorHandler {
    public let name = "backgroundImage"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Background images in SwiftUI are typically handled at component level
        // using ZStack with Image. This stores the value for reference.
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
