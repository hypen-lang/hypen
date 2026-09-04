import SwiftUI

// MARK: - Border Applicator

public struct BorderApplicator: ApplicatorHandler {
    public let name = "border"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let dict = value as? [String: Any] {
            if let width = parseCGFloat(dict["width"]) {
                modifier.borderWidth = width
                modifier.explicitlySetProperties.insert("borderWidth")
            }
            if let color = ColorParser.parse(dict["color"]) {
                modifier.borderColor = color
            }
            if let radius = parseCGFloat(dict["radius"]) {
                modifier.cornerRadius = radius
                modifier.explicitlySetProperties.insert("cornerRadius")
            }

            // A compound border owns its style just like the CSS shorthand.
            // Omitting `style` therefore resets an inherited/variant style to
            // solid, while a separate `borderStyle` applicator is applied
            // afterwards by ApplicatorRegistry and retains longhand priority.
            modifier.borderStyle = canonicalBorderStyle(dict["style"])
            modifier.explicitlySetProperties.insert("borderStyle")
        } else if let width = parseCGFloat(value) {
            modifier.borderWidth = width
            modifier.explicitlySetProperties.insert("borderWidth")
            if modifier.borderColor == nil {
                modifier.borderColor = .primary
            }
        }
    }
}

// MARK: - Border Width Applicator

public struct BorderWidthApplicator: ApplicatorHandler {
    public let name = "borderwidth"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let width = parseCGFloat(value) {
            modifier.borderWidth = width
            modifier.explicitlySetProperties.insert("borderWidth")
            if modifier.borderColor == nil {
                modifier.borderColor = .primary
            }
        }
    }
}

// MARK: - Border Color Applicator

public struct BorderColorApplicator: ApplicatorHandler {
    public let name = "bordercolor"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.borderColor = color
        }
    }
}

// MARK: - Border Radius Applicator

public struct BorderRadiusApplicator: ApplicatorHandler {
    public let name = "borderradius"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let radius = parseCGFloat(value) {
            modifier.cornerRadius = radius
            modifier.explicitlySetProperties.insert("cornerRadius")
        }
    }
}

// MARK: - Corner Radius Applicator (alias)

public struct CornerRadiusApplicator: ApplicatorHandler {
    public let name = "cornerradius"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let radius = parseCGFloat(value) {
            modifier.cornerRadius = radius
            modifier.explicitlySetProperties.insert("cornerRadius")
        }
    }
}

// MARK: - Border Style Applicator

/// Applicator for borderStyle.
/// Supports: solid, dashed, dotted, double, none
public struct BorderStyleApplicator: ApplicatorHandler {
    public let name = "borderstyle"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let style = value as? String {
            modifier.borderStyle = canonicalBorderStyle(style)
            modifier.explicitlySetProperties.insert("borderStyle")
        }
    }
}

/// Normalize the border styles supported by the native renderer.
///
/// Unknown or empty styles render as solid today, so storing that effective
/// value keeps variant merging and render behavior in agreement.
func canonicalBorderStyle(_ value: Any?) -> String {
    guard let rawStyle = value as? String else { return "solid" }

    switch rawStyle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "dashed": return "dashed"
    case "dotted": return "dotted"
    case "double": return "double"
    case "none": return "none"
    case "solid": return "solid"
    default: return "solid"
    }
}

// parseCGFloat is provided by SizeApplicators.swift (public)
