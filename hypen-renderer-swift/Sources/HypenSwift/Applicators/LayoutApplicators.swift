import SwiftUI

// MARK: - Alignment Applicator

public struct AlignmentApplicator: ApplicatorHandler {
    public let name = "alignment"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let str = value as? String {
            modifier.alignment = parseAlignment(str)
        }
    }

    private func parseAlignment(_ value: String) -> Alignment {
        switch value.lowercased() {
        case "topleft", "topleading": return .topLeading
        case "top": return .top
        case "topright", "toptrailing": return .topTrailing
        case "left", "leading": return .leading
        case "center": return .center
        case "right", "trailing": return .trailing
        case "bottomleft", "bottomleading": return .bottomLeading
        case "bottom": return .bottom
        case "bottomright", "bottomtrailing": return .bottomTrailing
        default: return .center
        }
    }
}

// MARK: - AlignItems Applicator
//
// Mirrors `align-items` / `horizontalAlignment` (Tailwind `items-center` etc.)
// onto `modifier.alignment` so the *outer* frame applied by
// `applyWeightExpansion` knows where to anchor a flex-allocated child.
//
// Why this exists in addition to Column/Row reading the prop directly:
// the layout component uses `alignItems` to set the inner VStack/HStack
// alignment (children-relative-to-widest-child). But when the container
// is wrapped in a flex slot (`flex-1`), that inner alignment doesn't reach
// the slot — `applyWeightExpansion`'s frame defaults to `.topLeading`, so
// `flex-1 items-center` siblings of a fixed-width element visually hug the
// outer edges of the row instead of centering within their own slot.
public struct AlignItemsApplicator: ApplicatorHandler {
    public let name = "alignItems"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let str = (value as? String)?.lowercased() else { return }
        // Only set if not already explicitly set by the `.alignment(...)` applicator.
        guard modifier.alignment == nil else { return }
        switch str {
        case "center":
            modifier.alignment = .center
        case "end", "trailing", "right", "flex-end":
            modifier.alignment = .trailing
        case "start", "leading", "left", "flex-start":
            modifier.alignment = .leading
        default:
            break
        }
    }
}

public struct HorizontalAlignmentApplicator: ApplicatorHandler {
    public let name = "horizontalAlignment"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        AlignItemsApplicator().apply(modifier: &modifier, value: value, context: context)
    }
}

// MARK: - Weight/Flex Applicator

public struct WeightApplicator: ApplicatorHandler {
    public let name = "weight"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let weight = parseCGFloat(value) {
            modifier.weight = weight
        }
    }
}

public struct FlexApplicator: ApplicatorHandler {
    public let name = "flex"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let weight = parseCGFloat(value) {
            modifier.weight = weight
        }
    }
}

public struct FlexGrowApplicator: ApplicatorHandler {
    public let name = "flexgrow"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let grow = parseCGFloat(value) {
            modifier.flexGrow = grow
        }
    }
}

public struct FlexShrinkApplicator: ApplicatorHandler {
    public let name = "flexshrink"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let shrink = parseCGFloat(value) {
            modifier.flexShrink = shrink
        }
    }
}

// MARK: - Offset Applicator

public struct OffsetApplicator: ApplicatorHandler {
    public let name = "offset"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let dict = value as? [String: Any] {
            if let x = parseCGFloat(dict["x"]) {
                modifier.offsetX = x
            }
            if let y = parseCGFloat(dict["y"]) {
                modifier.offsetY = y
            }
        }
    }
}

// MARK: - Gap Applicators

public struct GapApplicator: ApplicatorHandler {
    public let name = "gap"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Gap is handled at the component level (Column/Row)
        // Store value for component access
        if let gap = parseCGFloat(value) {
            modifier.gap = gap
        }
    }
}

public struct RowGapApplicator: ApplicatorHandler {
    public let name = "rowgap"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Row gap is handled at the component level (Grid)
        if let gap = parseCGFloat(value) {
            modifier.rowGap = gap
        }
    }
}

public struct ColumnGapApplicator: ApplicatorHandler {
    public let name = "columngap"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Column gap is handled at the component level (Grid)
        if let gap = parseCGFloat(value) {
            modifier.columnGap = gap
        }
    }
}

// MARK: - Z-Index Applicator

public struct ZIndexApplicator: ApplicatorHandler {
    public let name = "zindex"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let double = value as? Double {
            modifier.zIndex = double
        } else if let int = value as? Int {
            modifier.zIndex = Double(int)
        }
    }
}

// parseCGFloat is provided by SizeApplicators.swift (public)
