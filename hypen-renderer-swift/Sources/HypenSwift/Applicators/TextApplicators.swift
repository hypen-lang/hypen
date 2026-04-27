import SwiftUI

// MARK: - Font Size Applicator

public struct FontSizeApplicator: ApplicatorHandler {
    public let name = "fontsize"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let size = parseCGFloat(value) {
            modifier.fontSize = size
        }
    }
}

// MARK: - Font Family Applicator

public struct FontFamilyApplicator: ApplicatorHandler {
    public let name = "fontfamily"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let family = value as? String {
            modifier.fontFamily = family
        }
    }
}

// MARK: - Font Weight Applicator

public struct FontWeightApplicator: ApplicatorHandler {
    public let name = "fontweight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let weight = parseFontWeight(value) {
            modifier.fontWeight = weight
        }
    }

    private func parseFontWeight(_ value: Any?) -> Font.Weight? {
        guard let value = value else { return nil }

        if let str = value as? String {
            switch str.lowercased() {
            case "thin", "100": return .thin
            case "ultralight", "extralight", "200": return .ultraLight
            case "light", "300": return .light
            case "regular", "normal", "400": return .regular
            case "medium", "500": return .medium
            case "semibold", "600": return .semibold
            case "bold", "700": return .bold
            case "heavy", "extrabold", "800": return .heavy
            case "black", "900": return .black
            default: return nil
            }
        }

        if let int = value as? Int {
            switch int {
            case 100: return .thin
            case 200: return .ultraLight
            case 300: return .light
            case 400: return .regular
            case 500: return .medium
            case 600: return .semibold
            case 700: return .bold
            case 800: return .heavy
            case 900: return .black
            default: return nil
            }
        }

        return nil
    }
}

// MARK: - Text Align Applicator

public struct TextAlignApplicator: ApplicatorHandler {
    public let name = "textalign"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            modifier.textAlignment = parseTextAlignment(str)
        }
    }

    private func parseTextAlignment(_ value: String) -> TextAlignment {
        switch value.lowercased() {
        case "left", "start": return .leading
        case "right", "end": return .trailing
        case "center": return .center
        default: return .leading
        }
    }
}

// MARK: - Line Height Applicator

public struct LineHeightApplicator: ApplicatorHandler {
    public let name = "lineheight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let height = parseCGFloat(value) {
            // Store raw line height - effectiveLineSpacing will calculate based on fontSize
            modifier.lineHeight = height
        }
    }
}

// MARK: - Letter Spacing Applicator

public struct LetterSpacingApplicator: ApplicatorHandler {
    public let name = "letterspacing"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let kerning = parseCGFloat(value) {
            modifier.kerning = kerning
        }
    }
}

// MARK: - Text Decoration Applicator

public struct TextDecorationApplicator: ApplicatorHandler {
    public let name = "textdecoration"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            let lowercased = str.lowercased()
            if lowercased.contains("underline") {
                modifier.underline = true
            }
            if lowercased.contains("line-through") || lowercased.contains("strikethrough") {
                modifier.strikethrough = true
            }
        }
    }
}

// MARK: - Text Transform Applicator

public struct TextTransformApplicator: ApplicatorHandler {
    public let name = "texttransform"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            switch str.lowercased() {
            case "uppercase": modifier.textTransform = .uppercase
            case "lowercase": modifier.textTransform = .lowercase
            case "capitalize": modifier.textTransform = .capitalize
            default: break
            }
        }
    }
}

// MARK: - Max Lines Applicator

public struct MaxLinesApplicator: ApplicatorHandler {
    public let name = "maxlines"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let lines = parseInt(value), lines > 0 {
            modifier.maxLines = lines
        }
    }
}

// MARK: - Text Overflow Applicator

public struct TextOverflowApplicator: ApplicatorHandler {
    public let name = "textoverflow"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            switch str.lowercased() {
            case "ellipsis":
                modifier.textOverflow = .ellipsis
            case "clip":
                modifier.textOverflow = .clip
            case "visible":
                modifier.textOverflow = .visible
            default:
                break
            }
        }
    }
}

// MARK: - Font Style Applicator

public struct FontStyleApplicator: ApplicatorHandler {
    public let name = "fontstyle"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            switch str.lowercased() {
            case "italic": modifier.fontStyle = .italic
            case "normal": modifier.fontStyle = .normal
            default: break
            }
        }
    }
}

// MARK: - Font Variant Applicator

public struct FontVariantApplicator: ApplicatorHandler {
    public let name = "fontvariant"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Font variant (small-caps etc.) has limited SwiftUI support
        // Store as a flag for components that can use it
        // Currently a no-op in SwiftUI but ensures API parity
    }
}

// MARK: - Overflow Applicator (alias for textOverflow)

public struct OverflowApplicator: ApplicatorHandler {
    public let name = "overflow"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            switch str.lowercased() {
            case "ellipsis":
                modifier.textOverflow = .ellipsis
            case "clip", "hidden":
                modifier.textOverflow = .clip
            case "visible":
                modifier.textOverflow = .visible
            default:
                break
            }
        }
    }
}

// MARK: - Helpers

fileprivate func parseInt(_ value: Any?) -> Int? {
    guard let value = value else { return nil }
    if let int = value as? Int { return int }
    if let double = value as? Double { return Int(double) }
    if let str = value as? String {
        return Int(str)
    }
    return nil
}

// parseCGFloat is provided by SizeApplicators.swift (public)
