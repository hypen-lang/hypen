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
