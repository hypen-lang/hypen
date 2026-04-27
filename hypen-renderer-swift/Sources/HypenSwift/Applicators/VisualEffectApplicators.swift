import SwiftUI

// MARK: - Opacity Applicator

public struct OpacityApplicator: ApplicatorHandler {
    public let name = "opacity"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let double = value as? Double {
            modifier.opacity = double
            modifier.explicitlySetProperties.insert("opacity")
        } else if let int = value as? Int {
            modifier.opacity = Double(int)
            modifier.explicitlySetProperties.insert("opacity")
        } else if let str = value as? String, let double = Double(str) {
            modifier.opacity = double
            modifier.explicitlySetProperties.insert("opacity")
        }
    }
}

// MARK: - Visibility Applicator

public struct VisibilityApplicator: ApplicatorHandler {
    public let name = "visibility"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            modifier.isVisible = str.lowercased() != "hidden" && str.lowercased() != "invisible"
        } else if let bool = value as? Bool {
            modifier.isVisible = bool
        }
    }
}

// MARK: - Shadow Applicator

public struct ShadowApplicator: ApplicatorHandler {
    public let name = "shadow"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let dict = value as? [String: Any] {
            if let color = ColorParser.parse(dict["color"]) {
                modifier.shadowColor = color
            } else {
                modifier.shadowColor = Color.black.opacity(0.2)
            }
            if let radius = parseCGFloat(dict["radius"]) ?? parseCGFloat(dict["blur"]) {
                modifier.shadowRadius = radius
                modifier.explicitlySetProperties.insert("shadowRadius")
            }
            if let x = parseCGFloat(dict["x"]) ?? parseCGFloat(dict["offsetX"]) {
                modifier.shadowX = x
                modifier.explicitlySetProperties.insert("shadowX")
            }
            if let y = parseCGFloat(dict["y"]) ?? parseCGFloat(dict["offsetY"]) {
                modifier.shadowY = y
                modifier.explicitlySetProperties.insert("shadowY")
            }
        } else if let radius = parseCGFloat(value) {
            modifier.shadowRadius = radius
            modifier.explicitlySetProperties.insert("shadowRadius")
            modifier.shadowColor = Color.black.opacity(0.2)
        }
    }
}

// MARK: - Elevation Applicator

public struct ElevationApplicator: ApplicatorHandler {
    public let name = "elevation"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let elevation = parseCGFloat(value) {
            modifier.shadowRadius = elevation
            modifier.explicitlySetProperties.insert("shadowRadius")
            modifier.shadowColor = Color.black.opacity(0.2)
            modifier.shadowY = elevation / 2
            modifier.explicitlySetProperties.insert("shadowY")
        }
    }
}

// MARK: - Blur Applicator

public struct BlurApplicator: ApplicatorHandler {
    public let name = "blur"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let radius = parseCGFloat(value) {
            modifier.blurRadius = radius
        }
    }
}

// MARK: - Box Shadow Applicator

/// Applicator for boxShadow (CSS-like).
/// Simplified implementation using SwiftUI shadow.
public struct BoxShadowApplicator: ApplicatorHandler {
    public let name = "boxshadow"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        switch value {
        case let str as String:
            // Parse CSS-like shadow string: "0 4px 8px rgba(0,0,0,0.2)"
            // Simplified: just extract blur radius. Route through
            // `parseCGFloat` so `pt`/`sp`/`dp`/`px` / `rem` all parse —
            // the old hardcoded `.replacingOccurrences(of: "px", …)` only
            // handled `px` and dropped every other unit-bearing value.
            let parts = str.split(separator: " ")
            if parts.count >= 3 {
                if let blur = parseCGFloat(String(parts[2])) {
                    modifier.shadowRadius = blur
                    modifier.explicitlySetProperties.insert("shadowRadius")
                    modifier.shadowColor = Color.black.opacity(0.2)
                }
            }

        case let dict as [String: Any]:
            if let blur = parseCGFloat(dict["blur"]) {
                modifier.shadowRadius = blur
                modifier.explicitlySetProperties.insert("shadowRadius")
            }
            if let color = ColorParser.parse(dict["color"]) {
                modifier.shadowColor = color
            } else {
                modifier.shadowColor = Color.black.opacity(0.2)
            }
            if let x = parseCGFloat(dict["x"]) ?? parseCGFloat(dict["offsetX"]) {
                modifier.shadowX = x
                modifier.explicitlySetProperties.insert("shadowX")
            }
            if let y = parseCGFloat(dict["y"]) ?? parseCGFloat(dict["offsetY"]) {
                modifier.shadowY = y
                modifier.explicitlySetProperties.insert("shadowY")
            }

        case let number as NSNumber:
            modifier.shadowRadius = CGFloat(number.doubleValue)
            modifier.explicitlySetProperties.insert("shadowRadius")
            modifier.shadowColor = Color.black.opacity(0.2)

        default:
            break
        }
    }
}

// MARK: - Clip to Bounds Applicator

public struct ClipToBoundsApplicator: ApplicatorHandler {
    public let name = "cliptobounds"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let clip = value as? Bool {
            modifier.clipToBounds = clip
        } else if let str = value as? String {
            modifier.clipToBounds = str.lowercased() == "true"
        }
    }
}

// parseCGFloat is provided by SizeApplicators.swift (public)
