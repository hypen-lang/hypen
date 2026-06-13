import SwiftUI

// MARK: - App Component

/// Root application container. Full-screen vertical layout that fills the available space.
public struct AppComponent: ComponentHandler {
    public let typeName = "app"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        var mod = modifier
        if mod.width == nil { mod.fillMaxWidth = true }
        if mod.height == nil { mod.fillMaxHeight = true }

        return AnyView(
            VStack(alignment: .leading, spacing: 0) {
                children()
                    .environment(\.parentAllowsHorizontalExpansion, true)
                    .environment(\.parentAllowsVerticalExpansion, true)
            }
            .hypenModifier(mod)
        )
    }
}

// MARK: - Column Component

public struct ColumnComponent: ComponentHandler {
    public let typeName = "column"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let gap = modifier.gap ?? context.element.getCGFloatProp("gap.0") ?? context.element.getCGFloatProp("rowGap.0") ?? 0
        // Column: cross-axis = horizontal, main-axis = vertical
        // CSS align-items → cross-axis alignment (horizontalAlignment)
        // CSS justify-content → main-axis alignment (verticalAlignment)
        let alignItemsStr = context.element.getStringProp("horizontalAlignment.0")
            ?? context.element.getStringProp("alignItems.0")
        let isStretch = alignItemsStr?.lowercased() == "stretch"
        let horizontalAlignment = parseHorizontalAlignment(alignItemsStr)
        let verticalAlignmentStr = context.element.getStringProp("verticalAlignment.0")
            ?? context.element.getStringProp("justifyContent.0")
        // `.scrollable(true)` (bool) and `.scrollable("vertical")`/`"both"`/
        // `"auto"` (string) all enable vertical scrolling on a Column. An
        // explicit `"horizontal"` on a Column is unusual (cross-axis) — we
        // treat it as off here since Column's layout axis is vertical; use
        // a Row if you want horizontal scrolling. Bool-only parsing was the
        // pre-fix behavior that made `.scrollable("horizontal")` on the
        // Stories Row render non-scrollable in iOS.
        let scrollSpec = context.element.getScrollable()
        let scrollable: Bool = {
            switch scrollSpec.axis {
            case .horizontal: return false
            case .vertical, .both, nil: return scrollSpec.enabled
            }
        }()
        let justifyContent = parseJustifyContent(verticalAlignmentStr)

        // For space-between/around/evenly, we need to render children with spacers
        let childElements = context.renderer.getChildren(of: context.element.id)

        // Check if any child has a weight/flex property for vertical flex distribution
        let hasWeightedChild = childElements.contains { child in
            child.getCGFloatProp("weight.0") != nil || child.getCGFloatProp("flex.0") != nil || child.getCGFloatProp("flexGrow.0") != nil
        }

        // For non-start arrangements or when children have weights, Column needs to fill available height
        var effectiveModifier = modifier
        if (justifyContent != .start || hasWeightedChild) && !scrollable {
            effectiveModifier.fillMaxHeight = true
        }

        // Set modifier alignment so hypenModifier's frames position content correctly.
        // Without this, applyFillExpansion defaults to .topLeading, ignoring items-center/justify-center.
        let verticalAlign: VerticalAlignment = {
            switch justifyContent {
            case .center: return .center
            case .end: return .bottom
            default: return .top
            }
        }()
        effectiveModifier.alignment = Alignment(horizontal: horizontalAlignment, vertical: verticalAlign)

        // Check if this Column allows children to expand horizontally
        // Children can only expand if parent has explicit width (fillMaxWidth or explicit width)
        let allowsHorizontalExpansion = effectiveModifier.fillMaxWidth || modifier.width != nil

        // Get explicit dimensions for percentage calculations in children
        let explicitWidth = modifier.width
        let explicitHeight = modifier.height

        // Wrap children with appropriate environments
        let wrappedChildren: () -> AnyView = {
            var view = children()
            if isStretch {
                view = AnyView(view.environment(\.stretchCrossAxis, .horizontal))
            }
            // Tell children whether they can expand horizontally
            view = AnyView(view.environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion))
            // Pass explicit width for percentage width calculations
            if let width = explicitWidth {
                view = AnyView(view.environment(\.parentExplicitWidth, width))
            }
            return view
        }

        return AnyView(
            Group {
                if scrollable {
                    ScrollView(.vertical, showsIndicators: true) {
                        VStack(alignment: horizontalAlignment, spacing: gap) {
                            wrappedChildren()
                        }
                        .frame(maxWidth: .infinity, alignment: verticalFrameAlignment(verticalAlignmentStr))
                    }
                } else {
                    switch justifyContent {
                    case .spaceBetween:
                        VStack(alignment: horizontalAlignment, spacing: 0) {
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .horizontal : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitWidth, explicitWidth)
                                if index < childElements.count - 1 {
                                    Spacer(minLength: gap)
                                }
                            }
                        }
                        .frame(maxHeight: .infinity)

                    case .spaceAround:
                        VStack(alignment: horizontalAlignment, spacing: 0) {
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                Spacer(minLength: gap / 2)
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .horizontal : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitWidth, explicitWidth)
                                Spacer(minLength: gap / 2)
                            }
                        }
                        .frame(maxHeight: .infinity)

                    case .spaceEvenly:
                        VStack(alignment: horizontalAlignment, spacing: 0) {
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                Spacer(minLength: gap)
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .horizontal : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitWidth, explicitWidth)
                            }
                            Spacer(minLength: gap)
                        }
                        .frame(maxHeight: .infinity)

                    case .center:
                        if hasWeightedChild {
                            FlexDistributingColumn(
                                childElements: childElements,
                                gap: gap,
                                horizontalAlignment: horizontalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                            .frame(maxHeight: .infinity, alignment: .center)
                        } else {
                            VStack(alignment: horizontalAlignment, spacing: gap) {
                                wrappedChildren()
                            }
                            .frame(maxHeight: .infinity, alignment: .center)
                        }

                    case .end:
                        if hasWeightedChild {
                            FlexDistributingColumn(
                                childElements: childElements,
                                gap: gap,
                                horizontalAlignment: horizontalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                            .frame(maxHeight: .infinity, alignment: .bottom)
                        } else {
                            VStack(alignment: horizontalAlignment, spacing: gap) {
                                wrappedChildren()
                            }
                            .frame(maxHeight: .infinity, alignment: .bottom)
                        }

                    case .start:
                        if hasWeightedChild {
                            FlexDistributingColumn(
                                childElements: childElements,
                                gap: gap,
                                horizontalAlignment: horizontalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                        } else {
                            VStack(alignment: horizontalAlignment, spacing: gap) {
                                wrappedChildren()
                            }
                        }
                    }
                }
            }
            .hypenModifier(effectiveModifier)
        )
    }

    private func parseHorizontalAlignment(_ value: String?) -> HorizontalAlignment {
        switch value?.lowercased() {
        case "start", "leading", "left", "flex-start": return .leading
        case "end", "trailing", "right", "flex-end": return .trailing
        case "center": return .center
        case "stretch": return .leading // Stretch uses leading alignment + frame(maxWidth: .infinity) on children
        default: return .leading
        }
    }

    private enum JustifyContent {
        case start, center, end, spaceBetween, spaceAround, spaceEvenly
    }

    private func parseJustifyContent(_ value: String?) -> JustifyContent {
        switch value?.lowercased() {
        case "center": return .center
        case "end", "bottom", "flex-end": return .end
        case "spacebetween", "space-between": return .spaceBetween
        case "spacearound", "space-around": return .spaceAround
        case "spaceevenly", "space-evenly": return .spaceEvenly
        default: return .start
        }
    }

    /// Convert vertical alignment string to frame alignment for main axis control
    private func verticalFrameAlignment(_ value: String?) -> Alignment {
        switch value?.lowercased() {
        case "top", "start": return .top
        case "bottom", "end": return .bottom
        case "center": return .center
        default: return .top
        }
    }
}

// MARK: - Row Component

public struct RowComponent: ComponentHandler {
    public let typeName = "row"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let gap = modifier.gap ?? context.element.getCGFloatProp("gap.0") ?? context.element.getCGFloatProp("columnGap.0") ?? 0
        // Row: cross-axis = vertical, main-axis = horizontal
        // CSS align-items → cross-axis alignment (verticalAlignment)
        // CSS justify-content → main-axis alignment (horizontalAlignment)
        let alignItemsStr = context.element.getStringProp("verticalAlignment.0")
            ?? context.element.getStringProp("alignItems.0")
        let isStretch = alignItemsStr?.lowercased() == "stretch"
        let verticalAlignment = parseVerticalAlignment(alignItemsStr)
        let horizontalAlignmentStr = context.element.getStringProp("horizontalAlignment.0")
            ?? context.element.getStringProp("justifyContent.0")
        // Row accepts `.scrollable(true)`, `.scrollable("horizontal")`,
        // `.scrollable("both")`, `.scrollable("auto")` — any of these enable
        // horizontal scrolling. Explicit `"vertical"` is a cross-axis
        // request, which we drop (use a Column if you want vertical scroll).
        let scrollSpecRow = context.element.getScrollable()
        let scrollable: Bool = {
            switch scrollSpecRow.axis {
            case .vertical: return false
            case .horizontal, .both, nil: return scrollSpecRow.enabled
            }
        }()
        let justifyContent = parseJustifyContent(horizontalAlignmentStr)

        // For space-between/around/evenly, we need to render children with spacers
        let childElements = context.renderer.getChildren(of: context.element.id)

        // Check if any child has a weight property
        // When a child has weight, it should take remaining space, making centering ineffective
        let hasWeightedChild = childElements.contains { child in
            child.getCGFloatProp("weight.0") != nil || child.getCGFloatProp("flex.0") != nil || child.getCGFloatProp("flexGrow.0") != nil
        }

        // For non-start arrangements or when children have weights, Row needs to fill available width
        var effectiveModifier = modifier
        if (justifyContent != .start || hasWeightedChild) && !scrollable {
            effectiveModifier.fillMaxWidth = true
        }

        // Set modifier alignment so hypenModifier's frames position content correctly.
        let horizontalAlign: HorizontalAlignment = {
            switch justifyContent {
            case .center: return .center
            case .end: return .trailing
            default: return .leading
            }
        }()
        effectiveModifier.alignment = Alignment(horizontal: horizontalAlign, vertical: verticalAlignment)

        // Row allows horizontal expansion when it has width (fillMaxWidth, explicit width, or weighted children)
        let allowsHorizontalExpansion = effectiveModifier.fillMaxWidth || modifier.width != nil || hasWeightedChild

        // Get explicit dimensions for percentage calculations in children
        let explicitHeight = modifier.height
        let explicitWidth = modifier.width

        // Wrap children with appropriate environments
        let wrappedChildren: () -> AnyView = {
            var view = children()
            if isStretch {
                view = AnyView(view.environment(\.stretchCrossAxis, .vertical))
            }
            // Tell children they can expand horizontally (for weight to work)
            view = AnyView(view.environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion))
            // Pass explicit height for percentage height calculations
            if let height = explicitHeight {
                view = AnyView(view.environment(\.parentExplicitHeight, height))
            }
            // Pass explicit width for percentage width calculations
            if let width = explicitWidth {
                view = AnyView(view.environment(\.parentExplicitWidth, width))
            }
            return view
        }

        return AnyView(
            Group {
                if scrollable {
                    ScrollView(.horizontal, showsIndicators: true) {
                        HStack(alignment: verticalAlignment, spacing: gap) {
                            wrappedChildren()
                        }
                        .frame(maxHeight: .infinity, alignment: horizontalFrameAlignment(horizontalAlignmentStr))
                    }
                } else {
                    switch justifyContent {
                    case .spaceBetween:
                        HStack(alignment: verticalAlignment, spacing: 0) {
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .vertical : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitHeight, explicitHeight)
                                .environment(\.parentExplicitWidth, explicitWidth)
                                if index < childElements.count - 1 {
                                    Spacer(minLength: 0)
                                }
                            }
                        }

                    case .spaceAround:
                        HStack(alignment: verticalAlignment, spacing: 0) {
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                Spacer(minLength: 0)
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .vertical : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitHeight, explicitHeight)
                                .environment(\.parentExplicitWidth, explicitWidth)
                                Spacer(minLength: 0)
                            }
                        }

                    case .spaceEvenly:
                        HStack(alignment: verticalAlignment, spacing: 0) {
                            Spacer(minLength: 0)
                            ForEach(Array(childElements.enumerated()), id: \.element.id) { index, childElement in
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.stretchCrossAxis, isStretch ? .vertical : .none)
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentExplicitHeight, explicitHeight)
                                .environment(\.parentExplicitWidth, explicitWidth)
                                Spacer(minLength: 0)
                            }
                        }

                    case .center:
                        // When children have weights, use FlexDistributingRow for proportional distribution
                        if hasWeightedChild {
                            FlexDistributingRow(
                                childElements: childElements,
                                gap: gap,
                                verticalAlignment: verticalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                        } else {
                            HStack(alignment: verticalAlignment, spacing: gap) {
                                Spacer(minLength: 0)
                                wrappedChildren()
                                Spacer(minLength: 0)
                            }
                        }

                    case .end:
                        // When children have weights, use FlexDistributingRow for proportional distribution
                        if hasWeightedChild {
                            FlexDistributingRow(
                                childElements: childElements,
                                gap: gap,
                                verticalAlignment: verticalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                        } else {
                            HStack(alignment: verticalAlignment, spacing: gap) {
                                Spacer(minLength: 0)
                                wrappedChildren()
                            }
                        }

                    case .start:
                        if hasWeightedChild {
                            // Use FlexDistributingRow for proportional flex distribution
                            FlexDistributingRow(
                                childElements: childElements,
                                gap: gap,
                                verticalAlignment: verticalAlignment,
                                isStretch: isStretch,
                                allowsHorizontalExpansion: allowsHorizontalExpansion,
                                explicitHeight: explicitHeight,
                                explicitWidth: explicitWidth,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                        } else {
                            HStack(alignment: verticalAlignment, spacing: gap) {
                                wrappedChildren()
                            }
                        }
                    }
                }
            }
            .hypenModifier(effectiveModifier)
        )
    }

    private func parseVerticalAlignment(_ value: String?) -> VerticalAlignment {
        switch value?.lowercased() {
        case "top", "start", "flex-start": return .top
        case "bottom", "end", "flex-end": return .bottom
        case "center": return .center
        case "stretch": return .top // Stretch uses top alignment + frame(maxHeight: .infinity) on children
        default: return .top
        }
    }

    private enum JustifyContent {
        case start, center, end, spaceBetween, spaceAround, spaceEvenly
    }

    private func parseJustifyContent(_ value: String?) -> JustifyContent {
        switch value?.lowercased() {
        case "center": return .center
        case "end", "trailing", "right", "flex-end": return .end
        case "spacebetween", "space-between": return .spaceBetween
        case "spacearound", "space-around": return .spaceAround
        case "spaceevenly", "space-evenly": return .spaceEvenly
        default: return .start
        }
    }

    /// Convert horizontal alignment string to frame alignment for main axis control
    private func horizontalFrameAlignment(_ value: String?) -> Alignment {
        switch value?.lowercased() {
        case "start", "leading", "left": return .leading
        case "end", "trailing", "right": return .trailing
        case "center": return .center
        default: return .leading
        }
    }
}

// MARK: - Flex Distributing Row Helper

/// Helper view for Row with weighted children
/// Uses SwiftUI's natural flex layout - children with weight expand via applyWeightExpansion
private struct FlexDistributingRow: View {
    let childElements: [HypenElement]
    let gap: CGFloat
    let verticalAlignment: VerticalAlignment
    let isStretch: Bool
    let allowsHorizontalExpansion: Bool
    let explicitHeight: CGFloat?
    let explicitWidth: CGFloat?
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    var body: some View {
        HStack(alignment: verticalAlignment, spacing: gap) {
            ForEach(childElements, id: \.id) { childElement in
                // Check if this child has weight/flex - if so, it should expand
                let childWeight = childElement.getCGFloatProp("flex.0") ?? childElement.getCGFloatProp("weight.0") ?? childElement.getCGFloatProp("flexGrow.0")
                let shouldExpand = childWeight != nil && childWeight! > 0

                HypenElementView(
                    elementId: childElement.id,
                    renderer: renderer,
                    actionDispatcher: actionDispatcher
                )
                .environment(\.stretchCrossAxis, isStretch ? .vertical : .none)
                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                .environment(\.parentExplicitHeight, explicitHeight)
                .environment(\.parentExplicitWidth, explicitWidth)
                // Directly apply expansion for weighted children
                .frame(maxWidth: shouldExpand ? .infinity : nil, alignment: .topLeading)
            }
        }
        // Row with weighted children needs to fill available width
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Flex Distributing Column Helper

/// Helper view for Column with weighted children.
/// Uses a custom Layout (iOS 16+) to properly distribute vertical space:
/// 1. Measures non-flex children first at their natural size
/// 2. Distributes remaining space to flex children proportionally by weight
/// Falls back to VStack on iOS 15 (no flex distribution).
private struct FlexDistributingColumn: View {
    let childElements: [HypenElement]
    let gap: CGFloat
    let horizontalAlignment: HorizontalAlignment
    let isStretch: Bool
    let allowsHorizontalExpansion: Bool
    let explicitHeight: CGFloat?
    let explicitWidth: CGFloat?
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    var body: some View {
        if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
            FlexColumnLayout(gap: gap, horizontalAlignment: horizontalAlignment) {
                ForEach(childElements, id: \.id) { childElement in
                    let childWeight = childElement.getCGFloatProp("flex.0") ?? childElement.getCGFloatProp("weight.0") ?? childElement.getCGFloatProp("flexGrow.0") ?? 0
                    let isFlexChild = childWeight > 0

                    HypenElementView(
                        elementId: childElement.id,
                        renderer: renderer,
                        actionDispatcher: actionDispatcher
                    )
                    .environment(\.stretchCrossAxis, isStretch ? .horizontal : .none)
                    .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                    .environment(\.parentAllowsVerticalExpansion, true)
                    // Don't pass parentExplicitHeight to flex children — their height is controlled
                    // by the FlexColumnLayout, not by percentage calculation in applyWeightExpansion.
                    // Passing it would cause applyWeightExpansion to set frame(height: parentHeight)
                    // which overrides the Layout's proposed height.
                    .environment(\.parentExplicitHeight, isFlexChild ? nil : explicitHeight)
                    .environment(\.parentExplicitWidth, explicitWidth)
                    .layoutValue(key: FlexWeightLayoutKey.self, value: childWeight)
                }
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)
        } else {
            // iOS 15 fallback: basic VStack without flex distribution
            VStack(alignment: horizontalAlignment, spacing: gap) {
                ForEach(childElements, id: \.id) { childElement in
                    HypenElementView(
                        elementId: childElement.id,
                        renderer: renderer,
                        actionDispatcher: actionDispatcher
                    )
                    .environment(\.stretchCrossAxis, isStretch ? .horizontal : .none)
                    .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                    .environment(\.parentAllowsVerticalExpansion, true)
                    .environment(\.parentExplicitHeight, explicitHeight)
                    .environment(\.parentExplicitWidth, explicitWidth)
                }
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Custom Flex Column Layout (iOS 16+)

/// Layout key to pass flex weight from child to the custom layout
private struct FlexWeightLayoutKey: LayoutValueKey {
    static let defaultValue: CGFloat = 0
}

/// Custom Layout that distributes vertical space like CSS flexbox / Android LinearLayout weight:
/// 1. Measure non-flex children at their ideal (natural) size
/// 2. Calculate remaining space = total height - non-flex heights - gaps
/// 3. Distribute remaining space to flex children proportionally by weight
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
private struct FlexColumnLayout: Layout {
    let gap: CGFloat
    let horizontalAlignment: HorizontalAlignment

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Fill the proposed size (parent should set maxHeight: .infinity)
        let width = proposal.width ?? 0
        let height = proposal.height ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }

        let totalGap = gap * CGFloat(max(0, subviews.count - 1))

        // Phase 1: measure non-flex children at their natural height
        var nonFlexHeight: CGFloat = 0
        var totalFlexWeight: CGFloat = 0

        for subview in subviews {
            let weight = subview[FlexWeightLayoutKey.self]
            if weight > 0 {
                totalFlexWeight += weight
            } else {
                // Use nil height (ideal size) instead of .infinity to prevent
                // ScrollView-based children from reporting infinite height
                let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                nonFlexHeight += size.height
            }
        }

        // Phase 2: calculate available space for flex children
        let availableForFlex = max(0, bounds.height - nonFlexHeight - totalGap)

        // Phase 3: place children top to bottom
        var y = bounds.minY

        for subview in subviews {
            let weight = subview[FlexWeightLayoutKey.self]
            let childHeight: CGFloat

            if weight > 0 && totalFlexWeight > 0 {
                // Flex child: proportional share of remaining space
                childHeight = availableForFlex * (weight / totalFlexWeight)
            } else {
                // Non-flex child: natural/ideal height
                childHeight = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil)).height
            }

            let childProposal = ProposedViewSize(width: bounds.width, height: childHeight)

            // Horizontal alignment within the column
            let childSize = subview.sizeThatFits(childProposal)
            let x: CGFloat
            switch horizontalAlignment {
            case .trailing:
                x = bounds.maxX - childSize.width
            case .center:
                x = bounds.midX - childSize.width / 2
            default: // .leading
                x = bounds.minX
            }

            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: childProposal)
            y += childHeight + gap
        }
    }
}

// MARK: - Box/Container Component

public struct BoxComponent: ComponentHandler {
    public let typeName = "box"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Wrap to content by default - use .fillMaxWidth(true) to stretch
        // Pass explicit dimensions to children for percentage sizing
        return AnyView(
            ZStack(alignment: .topLeading) {
                children()
                    .environment(\.parentExplicitHeight, modifier.height)
                    .environment(\.parentExplicitWidth, modifier.width)
                    .environment(\.parentAllowsHorizontalExpansion, modifier.fillMaxWidth || modifier.width != nil)
            }
            .hypenModifier(modifier)
        )
    }
}

public struct ContainerComponent: ComponentHandler {
    public let typeName = "container"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Wrap to content by default - use .fillMaxWidth(true) to stretch
        // Pass explicit dimensions to children for percentage sizing
        return AnyView(
            ZStack(alignment: .topLeading) {
                children()
                    .environment(\.parentExplicitHeight, modifier.height)
                    .environment(\.parentExplicitWidth, modifier.width)
                    .environment(\.parentAllowsHorizontalExpansion, modifier.fillMaxWidth || modifier.width != nil)
            }
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Center Component

public struct CenterComponent: ComponentHandler {
    public let typeName = "center"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        AnyView(
            ZStack {
                children()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Spacer Component

public struct SpacerComponent: ComponentHandler {
    public let typeName = "spacer"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let size = context.element.getCGFloatProp("size.0")

        return AnyView(
            Group {
                if let size = size {
                    Spacer()
                        .frame(minWidth: size, minHeight: size)
                } else {
                    Spacer()
                }
            }
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Stack Component (Z-axis)

public struct StackComponent: ComponentHandler {
    public let typeName = "stack"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let alignment = parseAlignment(context.element.getStringProp("alignment.0"))

        // Stack wraps content by default — matches Android's Box and Canvas's
        // grid-`auto` tracks. Opt in to expansion via `.fillMaxWidth()` or a
        // positive `.weight(...)` for grid/flex cells.
        let hasPositiveWeight = (modifier.weight ?? 0) > 0
        let shouldExpand = modifier.fillMaxWidth || hasPositiveWeight

        return AnyView(
            StackContentView(
                alignment: alignment,
                shouldExpand: shouldExpand,
                modifier: modifier,
                children: children
            )
        )
    }

    private func parseAlignment(_ value: String?) -> Alignment {
        switch value?.lowercased() {
        case "topleft", "topleading": return .topLeading
        case "top": return .top
        case "topright", "toptrailing": return .topTrailing
        case "left", "leading": return .leading
        case "center": return .center
        case "right", "trailing": return .trailing
        case "bottomleft", "bottomleading": return .bottomLeading
        case "bottom": return .bottom
        case "bottomright", "bottomtrailing": return .bottomTrailing
        default: return .topLeading  // Match web/Android - top-left by default
        }
    }
}

/// Helper view for Stack that can read environment
private struct StackContentView: View {
    let alignment: Alignment
    let shouldExpand: Bool
    let modifier: HypenModifier
    let children: () -> AnyView

    @Environment(\.parentAllowsHorizontalExpansion) private var parentAllowsHorizontalExpansion

    var body: some View {
        // Wrap children with environment for percentage sizing
        let wrappedChildren = AnyView(
            children()
                .environment(\.parentExplicitHeight, modifier.height)
                .environment(\.parentExplicitWidth, modifier.width)
                .environment(\.parentAllowsHorizontalExpansion, modifier.fillMaxWidth || modifier.width != nil)
        )

        let content = ZStack(alignment: alignment) {
            wrappedChildren
        }

        // Expand to fill cell when in Grid context (parentAllowsHorizontalExpansion)
        // and Stack doesn't have explicit width
        if parentAllowsHorizontalExpansion && shouldExpand {
            content
                .frame(maxWidth: .infinity, alignment: alignment)
                .hypenModifier(modifier)
        } else {
            content
                .hypenModifier(modifier)
        }
    }
}

// MARK: - List Component (Scrollable Stack)

public struct ListComponent: ComponentHandler {
    public let typeName = "list"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Flatten control-flow wrappers (__ForEach, __Conditional) to get actual renderable items.
        // The engine wraps List items in internal container elements, but the list
        // needs to lay out the individual items directly in the ScrollView.
        let rawChildren = context.renderer.getChildren(of: context.element.id)
        let childElements = ControlFlowUtils.flattenControlFlowChildren(rawChildren, renderer: context.renderer)
        let direction = context.element.getStringProp("direction.0")
            ?? context.element.getStringProp("1")
            ?? "vertical"
        // CSS-style `flex-direction` from `tw("flex flex-row")` —
        // emitted as the kebab key `flex-direction: row`. Without
        // this, Lists declared via Tailwind classes (e.g. AddFood's
        // horizontal category-tab list) stacked vertically because
        // only the `direction.0` applicator path was checked.
        let flexDirection = context.element.getStringProp("flexDirection.0")
            ?? context.element.getStringProp("flex-direction.0")
            ?? context.element.getStringProp("flex-direction")
            ?? context.element.getStringProp("flexDirection")
        let gap = modifier.gap ?? context.element.getCGFloatProp("gap.0") ?? 0
        let isHorizontal = direction.lowercased() == "horizontal"
            || flexDirection?.lowercased() == "row"
            || flexDirection?.lowercased() == "row-reverse"

        // Propagate expansion permissions to children, like Column/Row do.
        // A horizontal List always lays children out in a row, so children's
        // flex/weight expansion should resolve against the row's width even
        // when the list itself has no explicit width — same contract as Row.
        let allowsHorizontalExpansion = isHorizontal || modifier.fillMaxWidth || modifier.width != nil
        let allowsVerticalExpansion = modifier.fillMaxHeight || modifier.height != nil
        let explicitWidth = modifier.width

        return AnyView(
            Group {
                if isHorizontal {
                    // Non-scrolling HStack so weight/flex-1 children distribute
                    // evenly across the available width (like Row). Switch back
                    // to a horizontal ScrollView if the caller opts in via
                    // overflow-x scroll/auto in the future.
                    HStack(spacing: gap) {
                        ForEach(childElements, id: \.id) { childElement in
                            HypenElementView(
                                elementId: childElement.id,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                            .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                            .environment(\.parentAllowsVerticalExpansion, allowsVerticalExpansion)
                            .environment(\.parentExplicitWidth, explicitWidth)
                        }
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    ScrollView(.vertical, showsIndicators: true) {
                        VStack(alignment: .leading, spacing: gap) {
                            ForEach(childElements, id: \.id) { childElement in
                                HypenElementView(
                                    elementId: childElement.id,
                                    renderer: context.renderer,
                                    actionDispatcher: context.actionDispatcher
                                )
                                .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                                .environment(\.parentAllowsVerticalExpansion, allowsVerticalExpansion)
                                .environment(\.parentExplicitWidth, explicitWidth)
                            }
                        }
                    }
                }
            }
            .hypenModifier(modifier)
        )
    }
}

// MARK: - ScrollView Component

public struct ScrollViewComponent: ComponentHandler {
    public let typeName = "scrollview"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let horizontal = context.element.getBoolProp("horizontal.0") ?? false
        let showsIndicators = context.element.getBoolProp("showsIndicators.0") ?? true

        // Propagate expansion permissions to children
        let allowsHorizontalExpansion = modifier.fillMaxWidth || modifier.width != nil
        let allowsVerticalExpansion = modifier.fillMaxHeight || modifier.height != nil
        let explicitWidth = modifier.width

        return AnyView(
            ScrollView(horizontal ? .horizontal : .vertical, showsIndicators: showsIndicators) {
                children()
                    .environment(\.parentAllowsHorizontalExpansion, allowsHorizontalExpansion)
                    .environment(\.parentAllowsVerticalExpansion, allowsVerticalExpansion)
                    .environment(\.parentExplicitWidth, explicitWidth)
            }
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Grid Component

public struct GridComponent: ComponentHandler {
    public let typeName = "grid"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Check gridColumns applicator first, then columns prop, default to 2
        let columns = context.element.getIntProp("gridColumns.0")
            ?? context.element.getIntProp("columns.0")
            ?? 2
        // Check gap applicator first, then spacing prop, default to 8
        let spacing = context.element.getCGFloatProp("gap.0")
            ?? context.element.getCGFloatProp("spacing.0")
            ?? 8
        // Grid's natural scroll axis is vertical (LazyVGrid). Accept bool,
        // `"vertical"`, `"both"`, `"auto"` as scrollable; drop `"horizontal"`
        // as unsupported here (no LazyHGrid branch).
        let scrollSpecGrid = context.element.getScrollable()
        let scrollable: Bool = {
            switch scrollSpecGrid.axis {
            case .horizontal: return false
            case .vertical, .both, nil: return scrollSpecGrid.enabled
            }
        }()

        // Flatten control-flow elements (__ForEach, __Conditional) to get actual renderable children.
        // The engine wraps ForEach/Conditional items in internal container elements, but the grid
        // needs to lay out the individual items directly (not a single wrapper as one cell).
        let rawChildren = context.renderer.getChildren(of: context.element.id)
        let childElements = GridComponent.flattenControlFlowChildren(rawChildren, renderer: context.renderer)
        print("[HypenGrid] columns=\(columns) spacing=\(spacing) scrollable=\(scrollable) raw=\(rawChildren.count) types=\(rawChildren.map { $0.elementType }), flattened=\(childElements.count)")
        for (i, child) in childElements.enumerated() {
            print("[HypenGrid]   child[\(i)] id=\(child.id) type=\(child.elementType) props=\(child.props.keys.sorted())")
        }

        // Scrollable grids use ScrollView + LazyVGrid — the canonical SwiftUI pattern.
        // LazyVGrid's "reports one row in sizeThatFits" bug doesn't matter here because the
        // size never propagates past the enclosing ScrollView, which is greedy in flex parents.
        // Column span (.gridColumn("span N")) is NOT honored in this branch; LazyVGrid has no
        // native equivalent. If you need spanning, omit .scrollable(true).
        if scrollable {
            let gridColumns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: columns)
            return AnyView(
                ScrollView(.vertical, showsIndicators: true) {
                    LazyVGrid(columns: gridColumns, spacing: spacing) {
                        ForEach(childElements, id: \.id) { childElement in
                            HypenElementView(
                                elementId: childElement.id,
                                renderer: context.renderer,
                                actionDispatcher: context.actionDispatcher
                            )
                            .environment(\.parentAllowsHorizontalExpansion, true)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        }
                    }
                }
                .hypenModifier(modifier)
            )
        }

        if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
            // Custom non-lazy grid layout that correctly reports its full content height
            // in sizeThatFits. LazyVGrid can't do this (always reports one row), which
            // breaks flex distribution in parent Column containers.
            return AnyView(
                HypenGridLayout(columns: columns, spacing: spacing) {
                    ForEach(childElements, id: \.id) { childElement in
                        let span = GridComponent.parseGridSpan(childElement.getStringProp("gridColumn.0"))
                        HypenElementView(
                            elementId: childElement.id,
                            renderer: context.renderer,
                            actionDispatcher: context.actionDispatcher
                        )
                        .environment(\.parentAllowsHorizontalExpansion, true)
                        .layoutValue(key: GridSpanLayoutKey.self, value: span)
                    }
                }
                .hypenModifier(modifier)
            )
        } else {
            // iOS 15 fallback: LazyVGrid (no proper intrinsic sizing, but best available)
            let gridColumns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: columns)

            return AnyView(
                LazyVGrid(columns: gridColumns, spacing: spacing) {
                    ForEach(childElements, id: \.id) { childElement in
                        HypenElementView(
                            elementId: childElement.id,
                            renderer: context.renderer,
                            actionDispatcher: context.actionDispatcher
                        )
                        .environment(\.parentAllowsHorizontalExpansion, true)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
                .hypenModifier(modifier)
            )
        }
    }

    /// Parse gridColumn span value (delegates to shared utility for control flow flattening)
    fileprivate static func flattenControlFlowChildren(_ elements: [HypenElement], renderer: HypenRenderer) -> [HypenElement] {
        ControlFlowUtils.flattenControlFlowChildren(elements, renderer: renderer)
    }

    /// Parse gridColumn span value like "span 2" -> 2, "span 1" -> 1
    fileprivate static func parseGridSpan(_ value: String?) -> Int {
        guard let value = value else { return 1 }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.lowercased().hasPrefix("span ") {
            return Int(trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)) ?? 1
        }
        return Int(trimmed) ?? 1
    }
}

// MARK: - Custom Grid Layout (iOS 16+)

/// Layout key to pass column span from child to the grid layout
private struct GridSpanLayoutKey: LayoutValueKey {
    static let defaultValue: Int = 1
}

/// Custom non-lazy grid layout that correctly reports its full content height.
/// Unlike LazyVGrid (which only reports one row in sizeThatFits), this layout
/// measures all children eagerly and computes the true total height.
///
/// Algorithm:
/// 1. Compute column width = (availableWidth - (columns-1) * spacing) / columns
/// 2. Group children into rows based on column count and spans
/// 3. For each row, propose column-width to each child, take max height as row height
/// 4. Total height = sum of row heights + (rowCount-1) * spacing
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
private struct HypenGridLayout: Layout {
    let columns: Int
    let spacing: CGFloat

    /// Assign each subview to a row and column position
    private func computeGrid(subviews: Subviews) -> [(index: Int, row: Int, col: Int, span: Int)] {
        var result: [(index: Int, row: Int, col: Int, span: Int)] = []
        var currentRow = 0
        var currentCol = 0

        for (index, subview) in subviews.enumerated() {
            let span = min(subview[GridSpanLayoutKey.self], columns)

            // Start a new row if this child doesn't fit
            if currentCol + span > columns && currentCol > 0 {
                currentRow += 1
                currentCol = 0
            }

            result.append((index: index, row: currentRow, col: currentCol, span: span))
            currentCol += span

            // Row is full
            if currentCol >= columns {
                currentRow += 1
                currentCol = 0
            }
        }

        return result
    }

    /// Compute column width given available width
    private func columnWidth(in totalWidth: CGFloat) -> CGFloat {
        guard columns > 0 else { return totalWidth }
        return (totalWidth - CGFloat(columns - 1) * spacing) / CGFloat(columns)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }

        let totalWidth = proposal.width ?? 0
        let colWidth = columnWidth(in: totalWidth)
        print("[HypenGridLayout] sizeThatFits proposal=\(proposal) totalWidth=\(totalWidth) colWidth=\(colWidth) subviews=\(subviews.count)")
        let grid = computeGrid(subviews: subviews)

        // Compute row heights by measuring each child with its column-span width
        var rowHeights: [Int: CGFloat] = [:]
        for entry in grid {
            let cellWidth = colWidth * CGFloat(entry.span) + spacing * CGFloat(max(0, entry.span - 1))
            let childSize = subviews[entry.index].sizeThatFits(
                ProposedViewSize(width: cellWidth, height: nil)
            )
            rowHeights[entry.row] = max(rowHeights[entry.row, default: 0], childSize.height)
        }

        let rowCount = (rowHeights.keys.max() ?? -1) + 1
        let totalHeight = rowHeights.values.reduce(0, +) + CGFloat(max(0, rowCount - 1)) * spacing

        return CGSize(width: totalWidth, height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }

        let colWidth = columnWidth(in: bounds.width)
        print("[HypenGridLayout] placeSubviews bounds=\(bounds) colWidth=\(colWidth)")
        let grid = computeGrid(subviews: subviews)

        // Compute row heights (same logic as sizeThatFits)
        var rowHeights: [Int: CGFloat] = [:]
        for entry in grid {
            let cellWidth = colWidth * CGFloat(entry.span) + spacing * CGFloat(max(0, entry.span - 1))
            let childSize = subviews[entry.index].sizeThatFits(
                ProposedViewSize(width: cellWidth, height: nil)
            )
            rowHeights[entry.row] = max(rowHeights[entry.row, default: 0], childSize.height)
        }

        // Compute row Y offsets
        var rowY: [Int: CGFloat] = [:]
        var y = bounds.minY
        let rowCount = (rowHeights.keys.max() ?? -1) + 1
        for row in 0..<rowCount {
            rowY[row] = y
            y += rowHeights[row, default: 0] + spacing
        }

        // Place each child
        for entry in grid {
            let cellWidth = colWidth * CGFloat(entry.span) + spacing * CGFloat(max(0, entry.span - 1))
            let x = bounds.minX + CGFloat(entry.col) * (colWidth + spacing)
            let cellY = rowY[entry.row, default: bounds.minY]
            let rowHeight = rowHeights[entry.row, default: 0]

            subviews[entry.index].place(
                at: CGPoint(x: x, y: cellY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: cellWidth, height: rowHeight)
            )
        }
    }
}

// MARK: - Control Flow Utilities

/// Shared utilities for flattening control-flow wrapper elements (__ForEach, __Conditional, etc.)
/// that the engine creates as transparent containers. Components like List and Grid need to
/// render the actual items directly, not the wrapper nodes.
@MainActor
enum ControlFlowUtils {
    /// Known control-flow element types that should be flattened (transparent containers).
    static let controlFlowTypes: Set<String> = [
        "ForEach", "__ForEach",
        "Conditional", "__Conditional",
        "When", "__When",
        "If", "__If",
    ]

    /// Recursively flatten control-flow elements to get actual renderable children.
    static func flattenControlFlowChildren(_ elements: [HypenElement], renderer: HypenRenderer) -> [HypenElement] {
        var result: [HypenElement] = []
        for element in elements {
            if controlFlowTypes.contains(element.elementType) {
                let innerChildren = renderer.getChildren(of: element.id)
                result.append(contentsOf: flattenControlFlowChildren(innerChildren, renderer: renderer))
            } else {
                result.append(element)
            }
        }
        return result
    }
}
