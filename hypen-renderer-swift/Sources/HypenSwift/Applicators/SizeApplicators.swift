import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/**
 * Size Applicators
 *
 * Cross-platform sizing value support:
 * - Numbers: treated as pt (platform default)
 * - "100px": absolute pixels (converted based on screen scale)
 * - "100dp" / "100pt": density-independent points (equivalent)
 * - "50%": percentage of parent/available space
 * - "50vw" / "50vh": viewport width/height
 * - "fill" / "100%": fill available space
 * - "wrap" / "auto": fit content
 */

// MARK: - Size Value Type

/// Represents a parsed size value for cross-platform compatibility
public enum SizeValue {
    case fixed(CGFloat)           // Fixed size in points
    case percent(CGFloat)         // Percentage (0-1)
    case viewportWidth(CGFloat)   // vw percentage (0-1)
    case viewportHeight(CGFloat)  // vh percentage (0-1)
    case fill(CGFloat)            // Fill with fraction (0-1)
    case wrap                     // Wrap content (auto)
    case infinity                 // Infinite size
}

// MARK: - Size Parser

/// Parse a size value from various formats
public func parseSizeValue(_ value: Any?) -> SizeValue? {
    guard let value = value else { return nil }

    // Handle numbers as points
    if let double = value as? Double { return .fixed(CGFloat(double)) }
    if let int = value as? Int { return .fixed(CGFloat(int)) }
    if let cgfloat = value as? CGFloat { return .fixed(cgfloat) }

    guard let str = value as? String else { return nil }
    let trimmed = str.trimmingCharacters(in: .whitespaces).lowercased()

    // Keywords
    switch trimmed {
    case "fill", "match_parent":
        return .fill(1.0)
    case "wrap", "wrap_content", "auto":
        return .wrap
    case "infinity", "inf", "max":
        return .infinity
    case "100%":
        return .fill(1.0)
    default:
        break
    }

    // Handle rem/em units (1rem/1em = 16pt)
    if trimmed.hasSuffix("rem") {
        let numStr = String(trimmed.dropLast(3))
        if let num = Double(numStr) {
            return .fixed(CGFloat(num * 16.0))
        }
        return nil
    }
    if trimmed.hasSuffix("em") {
        let numStr = String(trimmed.dropLast(2))
        if let num = Double(numStr) {
            return .fixed(CGFloat(num * 16.0))
        }
        return nil
    }

    // Parse value with unit using regex
    let pattern = "^(-?[\\d.]+)\\s*(px|dp|pt|sp|%|vw|vh)?$"
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []),
          let match = regex.firstMatch(in: trimmed, options: [], range: NSRange(trimmed.startIndex..., in: trimmed)),
          let numRange = Range(match.range(at: 1), in: trimmed),
          let num = Double(String(trimmed[numRange])) else {
        return nil
    }

    let unit: String
    if match.range(at: 2).location != NSNotFound,
       let unitRange = Range(match.range(at: 2), in: trimmed) {
        unit = String(trimmed[unitRange])
    } else {
        unit = "pt" // Default to points
    }

    switch unit {
    case "px":
        // Convert absolute pixels to points based on screen scale
        let scale = getScreenScale()
        return .fixed(CGFloat(num) / scale)
    case "dp", "sp", "":
        // dp / sp are 1 logical iOS point at standard density.
        // (`sp` does not yet scale with Dynamic Type — that's a
        // separate cross-renderer change.)
        return .fixed(CGFloat(num))
    case "pt":
        // Typographic point = 1/72 inch = 96/72 logical pixels.
        // Matches the CSS definition; the web renderer emits native
        // `pt` which the browser resolves to the same multiplier.
        return .fixed(CGFloat(num) * (96.0 / 72.0))
    case "%":
        // Percentage (0-100) -> fraction (0-1)
        return .percent(CGFloat(num / 100.0))
    case "vw":
        // Viewport width percentage
        return .viewportWidth(CGFloat(num / 100.0))
    case "vh":
        // Viewport height percentage
        return .viewportHeight(CGFloat(num / 100.0))
    default:
        return .fixed(CGFloat(num))
    }
}

/// Cached screen metrics to avoid MainActor isolation issues
private enum ScreenMetrics {
    /// Screen scale factor - cached on first access
    nonisolated(unsafe) static var scale: CGFloat = {
        #if canImport(UIKit)
        return MainActor.assumeIsolated { UIScreen.main.scale }
        #elseif canImport(AppKit)
        return MainActor.assumeIsolated { NSScreen.main?.backingScaleFactor ?? 1.0 }
        #else
        return 1.0
        #endif
    }()

    /// Screen width - note: this may not update on rotation
    nonisolated(unsafe) static var width: CGFloat = {
        #if canImport(UIKit)
        return MainActor.assumeIsolated { UIScreen.main.bounds.width }
        #elseif canImport(AppKit)
        return MainActor.assumeIsolated { NSScreen.main?.frame.width ?? 1920 }
        #else
        return 1920
        #endif
    }()

    /// Screen height - note: this may not update on rotation
    nonisolated(unsafe) static var height: CGFloat = {
        #if canImport(UIKit)
        return MainActor.assumeIsolated { UIScreen.main.bounds.height }
        #elseif canImport(AppKit)
        return MainActor.assumeIsolated { NSScreen.main?.frame.height ?? 1080 }
        #else
        return 1080
        #endif
    }()
}

/// Get the screen scale factor for px conversion
private func getScreenScale() -> CGFloat {
    ScreenMetrics.scale
}

/// Get the screen width in points
public func getScreenWidth() -> CGFloat {
    ScreenMetrics.width
}

/// Get the screen height in points
public func getScreenHeight() -> CGFloat {
    ScreenMetrics.height
}

/// Resolve a SizeValue to a fixed CGFloat (for viewport units only)
public func resolveFixedSize(_ size: SizeValue) -> CGFloat? {
    switch size {
    case .fixed(let value):
        return value
    case .viewportWidth(let fraction):
        return getScreenWidth() * fraction
    case .viewportHeight(let fraction):
        return getScreenHeight() * fraction
    case .infinity:
        return .infinity
    case .percent, .fill, .wrap:
        return nil // These need special handling
    }
}

/// Parse any value to CGFloat, resolving all units including vw, vh, px, dp, pt, sp, rem, em.
/// Delegates to parseSizeValue + resolveFixedSize.
public func parseCGFloat(_ value: Any?) -> CGFloat? {
    guard let size = parseSizeValue(value) else { return nil }
    return resolveFixedSize(size)
}

// MARK: - Width Applicator

public struct WidthApplicator: ApplicatorHandler {
    public let name = "width"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value) else { return }
        applyWidthSize(size, to: &modifier)
    }
}

// MARK: - Height Applicator

public struct HeightApplicator: ApplicatorHandler {
    public let name = "height"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value) else { return }
        applyHeightSize(size, to: &modifier)
    }
}

// MARK: - Min/Max Size Applicators

public struct MinWidthApplicator: ApplicatorHandler {
    public let name = "minwidth"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value),
              let resolved = resolveFixedSize(size) else { return }
        modifier.minWidth = resolved
    }
}

public struct MaxWidthApplicator: ApplicatorHandler {
    public let name = "maxwidth"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value),
              let resolved = resolveFixedSize(size) else { return }
        modifier.maxWidth = resolved
    }
}

public struct MinHeightApplicator: ApplicatorHandler {
    public let name = "minheight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value),
              let resolved = resolveFixedSize(size) else { return }
        modifier.minHeight = resolved
    }
}

public struct MaxHeightApplicator: ApplicatorHandler {
    public let name = "maxheight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let size = parseSizeValue(value),
              let resolved = resolveFixedSize(size) else { return }
        modifier.maxHeight = resolved
    }
}

// MARK: - Size Applicator (width + height)

public struct SizeApplicator: ApplicatorHandler {
    public let name = "size"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let dict = value as? [String: Any] {
            if let widthSize = parseSizeValue(dict["width"]) {
                applyWidthSize(widthSize, to: &modifier)
            }
            if let heightSize = parseSizeValue(dict["height"]) {
                applyHeightSize(heightSize, to: &modifier)
            }
        } else if let size = parseSizeValue(value) {
            applyWidthSize(size, to: &modifier)
            applyHeightSize(size, to: &modifier)
        }
    }
}

// MARK: - Fill Max Applicators

public struct FillMaxSizeApplicator: ApplicatorHandler {
    public let name = "fillmaxsize"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        let fraction = parseFraction(value)
        if fraction > 0 {
            modifier.fillMaxWidth = true
            modifier.fillMaxHeight = true
            modifier.fillMaxWidthFraction = fraction
            modifier.fillMaxHeightFraction = fraction
        }
    }
}

public struct FillMaxWidthApplicator: ApplicatorHandler {
    public let name = "fillmaxwidth"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        let fraction = parseFraction(value)
        if fraction > 0 {
            modifier.fillMaxWidth = true
            modifier.fillMaxWidthFraction = fraction
        }
    }
}

public struct FillMaxHeightApplicator: ApplicatorHandler {
    public let name = "fillmaxheight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        let fraction = parseFraction(value)
        if fraction > 0 {
            modifier.fillMaxHeight = true
            modifier.fillMaxHeightFraction = fraction
        }
    }
}

// MARK: - Aspect Ratio Applicator

public struct AspectRatioApplicator: ApplicatorHandler {
    public let name = "aspectratio"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let num = value as? Double {
            modifier.aspectRatio = CGFloat(num)
        } else if let num = value as? Int {
            modifier.aspectRatio = CGFloat(num)
        } else if let str = value as? String {
            // Handle "16:9" format
            let parts = str.split(separator: ":")
            if parts.count == 2,
               let width = Double(parts[0]),
               let height = Double(parts[1]),
               height > 0 {
                modifier.aspectRatio = CGFloat(width / height)
            } else if let num = Double(str) {
                modifier.aspectRatio = CGFloat(num)
            }
        }
    }
}

// MARK: - Helpers

/// Apply a width SizeValue to a HypenModifier
fileprivate func applyWidthSize(_ size: SizeValue, to modifier: inout HypenModifier) {
    switch size {
    case .fixed(let v):
        modifier.width = v
    case .percent(let fraction):
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = fraction
    case .fill(let fraction):
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = fraction
    case .viewportWidth(let fraction):
        modifier.width = getScreenWidth() * fraction
    case .viewportHeight(let fraction):
        modifier.width = getScreenHeight() * fraction
    case .wrap:
        modifier.width = nil // Let content determine size
    case .infinity:
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 1.0
    }
}

/// Apply a height SizeValue to a HypenModifier
fileprivate func applyHeightSize(_ size: SizeValue, to modifier: inout HypenModifier) {
    switch size {
    case .fixed(let v):
        modifier.height = v
    case .percent(let fraction):
        modifier.fillMaxHeight = true
        modifier.fillMaxHeightFraction = fraction
    case .fill(let fraction):
        modifier.fillMaxHeight = true
        modifier.fillMaxHeightFraction = fraction
    case .viewportWidth(let fraction):
        modifier.height = getScreenWidth() * fraction
    case .viewportHeight(let fraction):
        modifier.height = getScreenHeight() * fraction
    case .wrap:
        modifier.height = nil // Let content determine size
    case .infinity:
        modifier.fillMaxHeight = true
        modifier.fillMaxHeightFraction = 1.0
    }
}

fileprivate func parseBool(_ value: Any?) -> Bool? {
    guard let value = value else { return nil }
    if let bool = value as? Bool { return bool }
    if let str = value as? String {
        return str.lowercased() == "true" || str == "1"
    }
    if let int = value as? Int { return int != 0 }
    return nil
}

fileprivate func parseFraction(_ value: Any?) -> CGFloat {
    guard let value = value else { return 1.0 }
    if let bool = value as? Bool {
        return bool ? 1.0 : 0.0
    }
    if let num = value as? Double {
        return CGFloat(num)
    }
    if let num = value as? Int {
        return CGFloat(num)
    }
    return 1.0
}
