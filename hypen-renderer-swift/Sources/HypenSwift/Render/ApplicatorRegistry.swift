import SwiftUI

/// Context passed to applicator handlers
public struct ApplicatorContext: @unchecked Sendable {
    public let element: HypenElement
    public let actionDispatcher: ActionDispatcher

    public init(element: HypenElement, actionDispatcher: ActionDispatcher) {
        self.element = element
        self.actionDispatcher = actionDispatcher
    }
}

/// Protocol for applicator handlers that modify SwiftUI views
public protocol ApplicatorHandler: Sendable {
    /// The applicator name (e.g., "padding", "backgroundColor")
    var name: String { get }

    /// Apply the applicator to a HypenModifier
    func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext)
}

/// Result of applying applicators with variant support
public struct ApplicatorResult {
    public var baseModifier: HypenModifier
    public var variants: VariantModifiers

    public init() {
        self.baseModifier = HypenModifier()
        self.variants = VariantModifiers()
    }
}

/// Registry for applicator handlers
@MainActor
public final class ApplicatorRegistry: @unchecked Sendable {
    private var handlers: [String: any ApplicatorHandler] = [:]

    public init() {}

    /// Register an applicator handler
    public func register(_ handler: any ApplicatorHandler) {
        handlers[handler.name.lowercased()] = handler
    }

    /// Register multiple handlers at once
    public func register(_ handlers: [any ApplicatorHandler]) {
        for handler in handlers {
            register(handler)
        }
    }

    /// Get a handler for a given applicator name
    public func getHandler(for name: String) -> (any ApplicatorHandler)? {
        handlers[name.lowercased()]
    }

    /// Check if a handler exists
    public func hasHandler(for name: String) -> Bool {
        handlers[name.lowercased()] != nil
    }

    /// Apply all applicators from an element's props to a modifier (legacy method)
    public func applyAll(
        to modifier: inout HypenModifier,
        element: HypenElement,
        context: ApplicatorContext
    ) {
        let result = applyAllWithVariants(element: element, context: context)
        modifier = result.baseModifier
    }

    /// Apply all applicators with variant support
    public func applyAllWithVariants(
        element: HypenElement,
        context: ApplicatorContext
    ) -> ApplicatorResult {
        var result = ApplicatorResult()

        // Group props by base name (e.g., "padding.0", "padding.top" -> "padding")
        // Track insertion order to ensure consistent application across platforms
        // Also track variant props separately
        var groupedProps: [String: Any] = [:]
        var applicatorOrder: [String] = []
        var variantProps: [(name: String, breakpoint: Breakpoint?, state: StateVariant?, value: Any)] = []

        // Sort element.props keys to ensure deterministic iteration order
        let sortedKeys = element.props.keys.sorted()

        for key in sortedKeys {
            guard let value = element.props[key] else { continue }

            // Check if this is an applicator prop (ends with .0 or .something)
            if let dotIndex = key.lastIndex(of: ".") {
                let baseName = String(key[..<dotIndex])
                let suffix = String(key[key.index(after: dotIndex)...])

                // Parse for variant suffix in the base name
                let variantInfo = parseVariantName(baseName)

                if variantInfo.isVariant {
                    // This is a variant prop - store for later processing
                    variantProps.append((
                        name: variantInfo.baseName + "." + suffix,
                        breakpoint: variantInfo.breakpoint,
                        state: variantInfo.state,
                        value: value
                    ))
                } else {
                    // Regular prop
                    // Track order of first occurrence
                    if groupedProps[baseName] == nil {
                        applicatorOrder.append(baseName)
                    }

                    if suffix == "0" {
                        // Simple value (e.g., "padding.0")
                        // If there's already a dict from named args, add "0" key to it
                        if var existing = groupedProps[baseName] as? [String: Any] {
                            existing["0"] = value
                            groupedProps[baseName] = existing
                        } else {
                            groupedProps[baseName] = value
                        }
                    } else {
                        // Named value (e.g., "padding.top", "onClick.postId")
                        var existing: [String: Any]
                        if let dict = groupedProps[baseName] as? [String: Any] {
                            existing = dict
                        } else if let existingValue = groupedProps[baseName] {
                            // Convert existing scalar value (from suffix "0") to dict format
                            existing = ["0": existingValue]
                        } else {
                            existing = [:]
                        }
                        existing[suffix] = value
                        groupedProps[baseName] = existing
                    }
                }
            } else {
                // Check for variant suffix directly in key (no dot)
                let variantInfo = parseVariantName(key)
                if variantInfo.isVariant {
                    variantProps.append((
                        name: variantInfo.baseName,
                        breakpoint: variantInfo.breakpoint,
                        state: variantInfo.state,
                        value: value
                    ))
                }
            }
        }

        // Apply base applicators in deterministic order
        for name in applicatorOrder {
            if let value = groupedProps[name],
               let handler = getHandler(for: name) {
                handler.apply(modifier: &result.baseModifier, value: value, context: context)
            }
        }

        // Group variant props by breakpoint/state and apply to variant modifiers
        var responsiveGroups: [Breakpoint: [String: Any]] = [:]
        var stateGroups: [StateVariant: [String: Any]] = [:]

        for (name, breakpoint, state, value) in variantProps {
            if let bp = breakpoint {
                if responsiveGroups[bp] == nil {
                    responsiveGroups[bp] = [:]
                }

                // Parse the prop name for grouping
                if let dotIndex = name.lastIndex(of: ".") {
                    let baseName = String(name[..<dotIndex])
                    let suffix = String(name[name.index(after: dotIndex)...])

                    if suffix == "0" {
                        responsiveGroups[bp]![baseName] = value
                    } else {
                        var existing = responsiveGroups[bp]![baseName] as? [String: Any] ?? [:]
                        existing[suffix] = value
                        responsiveGroups[bp]![baseName] = existing
                    }
                } else {
                    responsiveGroups[bp]![name] = value
                }
            } else if let st = state {
                if stateGroups[st] == nil {
                    stateGroups[st] = [:]
                }

                if let dotIndex = name.lastIndex(of: ".") {
                    let baseName = String(name[..<dotIndex])
                    let suffix = String(name[name.index(after: dotIndex)...])

                    if suffix == "0" {
                        stateGroups[st]![baseName] = value
                    } else {
                        var existing = stateGroups[st]![baseName] as? [String: Any] ?? [:]
                        existing[suffix] = value
                        stateGroups[st]![baseName] = existing
                    }
                } else {
                    stateGroups[st]![name] = value
                }
            }
        }

        // Apply grouped responsive props to variant modifiers
        for (breakpoint, props) in responsiveGroups {
            var variantModifier = HypenModifier()
            for (name, value) in props {
                if let handler = getHandler(for: name) {
                    handler.apply(modifier: &variantModifier, value: value, context: context)
                }
            }
            result.variants.responsive[breakpoint] = variantModifier
        }

        // Apply grouped state props to variant modifiers
        for (state, props) in stateGroups {
            var variantModifier = HypenModifier()
            for (name, value) in props {
                if let handler = getHandler(for: name) {
                    handler.apply(modifier: &variantModifier, value: value, context: context)
                }
            }
            result.variants.states[state] = variantModifier
        }

        return result
    }
}

// MARK: - Default Registry

extension ApplicatorRegistry {
    /// Create a registry with all default applicators registered
    public static func withDefaults() -> ApplicatorRegistry {
        let registry = ApplicatorRegistry()

        // Spacing
        registry.register(PaddingApplicator())
        registry.register(PaddingTopApplicator())
        registry.register(PaddingBottomApplicator())
        registry.register(PaddingLeftApplicator())
        registry.register(PaddingRightApplicator())
        registry.register(PaddingHorizontalApplicator())
        registry.register(PaddingVerticalApplicator())
        registry.register(MarginApplicator())
        registry.register(MarginTopApplicator())
        registry.register(MarginBottomApplicator())
        registry.register(MarginLeftApplicator())
        registry.register(MarginRightApplicator())
        registry.register(MarginHorizontalApplicator())
        registry.register(MarginVerticalApplicator())

        // Size
        registry.register(WidthApplicator())
        registry.register(HeightApplicator())
        registry.register(MinWidthApplicator())
        registry.register(MaxWidthApplicator())
        registry.register(MinHeightApplicator())
        registry.register(MaxHeightApplicator())
        registry.register(SizeApplicator())
        registry.register(FillMaxSizeApplicator())
        registry.register(FillMaxWidthApplicator())
        registry.register(FillMaxHeightApplicator())

        // Colors
        registry.register(BackgroundColorApplicator())
        registry.register(BackgroundApplicator())
        registry.register(ForegroundColorApplicator())

        // Border
        registry.register(BorderApplicator())
        registry.register(BorderWidthApplicator())
        registry.register(BorderColorApplicator())
        registry.register(BorderRadiusApplicator())
        registry.register(CornerRadiusApplicator())
        registry.register(BorderStyleApplicator())

        // Layout
        registry.register(AlignmentApplicator())
        registry.register(AlignItemsApplicator())
        registry.register(JustifyContentApplicator())
        registry.register(VerticalAlignmentApplicator())
        registry.register(HorizontalAlignmentApplicator())
        registry.register(WeightApplicator())
        registry.register(FlexApplicator())
        registry.register(FlexGrowApplicator())
        registry.register(FlexShrinkApplicator())
        registry.register(AspectRatioApplicator())
        registry.register(OffsetApplicator())
        registry.register(GapApplicator())
        registry.register(RowGapApplicator())
        registry.register(ColumnGapApplicator())
        registry.register(ZIndexApplicator())

        // Visual effects
        registry.register(OpacityApplicator())
        registry.register(VisibilityApplicator())
        registry.register(ShadowApplicator())
        registry.register(ElevationApplicator())
        registry.register(BlurApplicator())
        registry.register(BoxShadowApplicator())
        registry.register(ClipToBoundsApplicator())

        // Transforms
        registry.register(RotateApplicator())
        registry.register(ScaleApplicator())
        registry.register(ScaleXApplicator())
        registry.register(ScaleYApplicator())
        registry.register(TranslateXApplicator())
        registry.register(TranslateYApplicator())
        registry.register(TransformApplicator())

        // Gradients
        registry.register(LinearGradientApplicator())
        registry.register(RadialGradientApplicator())
        registry.register(ConicGradientApplicator())
        registry.register(GradientApplicator())

        // Background
        registry.register(BackgroundImageApplicator())
        registry.register(BackgroundSizeApplicator())
        registry.register(BackgroundPositionApplicator())

        // Events
        registry.register(OnClickApplicator())
        registry.register(OnPressApplicator())
        registry.register(OnLongPressApplicator())
        registry.register(OnLongClickApplicator())
        registry.register(OnFocusApplicator())
        registry.register(OnBlurApplicator())

        // Text-specific
        registry.register(FontSizeApplicator())
        registry.register(FontWeightApplicator())
        registry.register(FontFamilyApplicator())
        registry.register(TextAlignApplicator())
        registry.register(LineHeightApplicator())
        registry.register(LetterSpacingApplicator())
        registry.register(TextDecorationApplicator())
        registry.register(TextTransformApplicator())
        registry.register(MaxLinesApplicator())
        registry.register(TextOverflowApplicator())
        registry.register(FontStyleApplicator())
        registry.register(FontVariantApplicator())
        registry.register(OverflowApplicator())
        registry.register(ColorApplicator())

        return registry
    }
}
