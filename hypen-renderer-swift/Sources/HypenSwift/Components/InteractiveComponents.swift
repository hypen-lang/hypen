import SwiftUI

// MARK: - Button Component

public struct ButtonComponent: ComponentHandler {
    public let typeName = "button"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let disabled = context.element.getBoolProp("disabled.0") ?? false

        // Parse horizontal alignment - determines content position within button
        let horizontalAlignmentStr = context.element.getStringProp("horizontalAlignment.0")?.lowercased()

        // Determine content alignment:
        // - If horizontalAlignment is explicitly set, use it
        // - If fillMaxWidth but no explicit alignment, default to center (match Android Box)
        // - Otherwise, no special alignment needed
        let contentAlignment: Alignment? = {
            if let align = horizontalAlignmentStr {
                switch align {
                case "start", "left", "leading": return .leading
                case "end", "right", "trailing": return .trailing
                case "center": return .center
                default: return nil
                }
            } else if modifier.fillMaxWidth {
                // Default to center when filling width (matches Android Box behavior)
                return .center
            }
            return nil
        }()

        // Ensure the modifier has an onTap if the element has onClick/onPress props
        // but the applicator didn't set it (e.g., from Button("@actions.xxx") argument syntax)
        var effectiveModifier = modifier
        if effectiveModifier.onTap == nil {
            if let action = ActionValue.from(
                context.element.props["action"] ??
                context.element.props["action.0"] ??
                context.element.props["onClick.0"] ??
                context.element.props["onPress.0"]
            ) {
                let dispatcher = context.actionDispatcher
                effectiveModifier.onTap = {
                    dispatcher.dispatch(action: action.actionName, payload: action.payload)
                }
            }
        }

        return AnyView(
            ButtonViewWrapper(
                disabled: disabled,
                contentAlignment: contentAlignment,
                modifier: effectiveModifier,
                children: children
            )
        )
    }
}

/// Internal wrapper matching Android's Box(contentAlignment)
/// Note: Tap gestures are handled by HypenElementView.applyTapGestures() via the modifier,
/// NOT by the ButtonViewWrapper itself. This avoids double-dispatch of actions.
private struct ButtonViewWrapper: View {
    let disabled: Bool
    let contentAlignment: Alignment?  // nil = no alignment wrapper needed
    let modifier: HypenModifier
    let children: () -> AnyView

    var body: some View {
        Group {
            if let alignment = contentAlignment {
                // Use HStack with Spacers to achieve alignment
                HStack(spacing: 0) {
                    if alignment == .center || alignment == .trailing {
                        Spacer(minLength: 0)
                    }
                    children()
                    if alignment == .center || alignment == .leading {
                        Spacer(minLength: 0)
                    }
                }
            } else {
                // No alignment - button wraps content naturally
                children()
            }
        }
        .contentShape(Rectangle())  // Make entire area tappable
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1.0)
        .hypenModifier(modifier)
    }
}

// Note: LinkComponent is defined in RouterComponents.swift for router integration
