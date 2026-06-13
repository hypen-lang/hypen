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

// MARK: - align-items / justify-content
//
// Container components (Column, Row) read `alignItems` / `justifyContent`
// directly from the element props to drive VStack/HStack alignment and
// override `modifier.alignment` themselves — so on those components these
// applicators are clobbered and harmless. On leaf-ish containers (Button,
// Box, the implicit frame inside `hypenModifier`) there is no override, so
// these applicators are what make `tw("items-center justify-center")`
// actually center the content inside the expanded frame.
//
// Semantically `align-items` controls the cross-axis and `justify-content`
// controls the main axis, which depends on parent direction. Without that
// context here we use the leaf-container reading (center = center on the
// corresponding axis of the frame's alignment). That matches how the
// classes are used in practice — typically together to mean "center the
// content in this box".

public struct AlignItemsApplicator: ApplicatorHandler {
    public let name = "alignitems"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let str = value as? String else { return }
        let v: VerticalAlignment = {
            switch str.lowercased() {
            case "center": return .center
            case "end", "flex-end", "bottom": return .bottom
            case "start", "flex-start", "top": return .top
            default: return .top
            }
        }()
        let h = modifier.alignment?.horizontal ?? .leading
        modifier.alignment = Alignment(horizontal: h, vertical: v)
    }
}

public struct JustifyContentApplicator: ApplicatorHandler {
    public let name = "justifycontent"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let str = value as? String else { return }
        let h: HorizontalAlignment = {
            switch str.lowercased() {
            case "center": return .center
            case "end", "flex-end", "right": return .trailing
            case "start", "flex-start", "left": return .leading
            default: return .leading
            }
        }()
        let v = modifier.alignment?.vertical ?? .top
        modifier.alignment = Alignment(horizontal: h, vertical: v)
    }
}

// Hypen-native `.verticalAlignment(...)` / `.horizontalAlignment(...)`
// applicators. Column/Row already read these props directly so they can
// drive VStack/HStack alignment, but on every other container (Button,
// Box, Stack, plain frames) the props had no handler and were dropped.
// Mapping them onto `modifier.alignment` here makes them work uniformly,
// matching the Android renderer's behaviour where these are first-class
// applicators on any component.

public struct VerticalAlignmentApplicator: ApplicatorHandler {
    public let name = "verticalalignment"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let str = value as? String else { return }
        let v: VerticalAlignment = {
            switch str.lowercased() {
            case "center", "centervertically": return .center
            case "bottom", "end": return .bottom
            case "top", "start": return .top
            default: return .top
            }
        }()
        let h = modifier.alignment?.horizontal ?? .leading
        modifier.alignment = Alignment(horizontal: h, vertical: v)
    }
}

public struct HorizontalAlignmentApplicator: ApplicatorHandler {
    public let name = "horizontalalignment"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let str = value as? String else { return }
        let h: HorizontalAlignment = {
            switch str.lowercased() {
            case "center", "centerhorizontally": return .center
            case "right", "trailing", "end": return .trailing
            case "left", "leading", "start": return .leading
            default: return .leading
            }
        }()
        let v = modifier.alignment?.vertical ?? .top
        modifier.alignment = Alignment(horizontal: h, vertical: v)
    }
}

// parseCGFloat is provided by SizeApplicators.swift (public)
