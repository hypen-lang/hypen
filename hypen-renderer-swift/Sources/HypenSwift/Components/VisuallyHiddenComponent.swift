import SwiftUI

// MARK: - VisuallyHidden Component

/// Screen-reader-only content: the subtree is never painted and claims no
/// layout space, but stays in the accessibility tree so VoiceOver still reads
/// it — the native counterpart of the DOM renderer's "sr-only" span
/// (`hypen-web/packages/web/src/dom/components/visuallyhidden.ts`).
///
/// Registering it is what makes the contract hold: the unknown-type fallback
/// in `HypenElementView` renders children in a plain `ZStack`, which puts
/// sr-only content on screen — the exact inverse of what the author asked for.
///
/// Each modifier below is load-bearing:
///
/// - `.fixedSize()` lays the subtree out at its ideal size instead of the
///   zero-size proposal underneath, so its accessibility frame is a real box
///   VoiceOver can focus rather than a degenerate one.
/// - The opacity is a hair above zero, not zero. SwiftUI's `.opacity(0)`
///   lands on `alpha == 0`, and UIAccessibility prunes a fully transparent
///   view from the tree exactly as it prunes a hidden one — which would lose
///   the announcement this component exists to preserve. The Android sibling
///   rejects `alpha(0f)` for the same reason
///   (`VisuallyHiddenComponent.kt`), and the DOM reference never touches
///   opacity at all, clipping instead. A value this small is visually
///   indistinguishable from absent while staying non-zero.
///   `.hidden()` is the wrong tool twice over: it drops the subtree from
///   accessibility *and* keeps its layout space.
/// - `.clipped()` keeps those near-invisible pixels from bleeding outside the
///   1pt box, mirroring the DOM's `clip: rect(0,0,0,0)`.
/// - `.allowsHitTesting(false)` stops an interactive child inside an sr-only
///   wrapper from holding a live touch target over whatever is painted
///   underneath it — neither DOM (clipped, absolutely positioned) nor canvas
///   (zero layout box) can be tapped, and this renderer should match.
/// - The outer zero `.frame` is what makes the wrapper occupy no space in its
///   parent.
///
/// NOT VERIFIED BY EXECUTION: no Swift toolchain was available when this was
/// written, so the VoiceOver behaviour above is reasoned from UIAccessibility's
/// documented pruning rules rather than observed on a device.
///
/// The element's own semantics (`.label(...)`, `.role(...)`) are applied by
/// `HypenElementView` outside the handler, exactly as for every other
/// component.
public struct VisuallyHiddenComponent: ComponentHandler {
    public let typeName = "visuallyhidden"

    /// Non-zero so UIAccessibility keeps the subtree, small enough that a
    /// 1pt clipped box is imperceptible. See the note on opacity above.
    static let srOnlyOpacity = 0.001

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // The styling applicators are deliberately not applied: a padding, a
        // background or an explicit size on an sr-only wrapper would either
        // paint or reclaim layout space, and invisibility outranks author
        // styling here. The DOM renderer pins the same properties in its
        // create-time styles for the same reason.
        AnyView(
            children()
                .fixedSize()
                .frame(width: 1, height: 1, alignment: .topLeading)
                .clipped()
                .opacity(Self.srOnlyOpacity)
                .allowsHitTesting(false)
                // Stated explicitly: this subtree is invisible on purpose and
                // must stay readable, so nothing downstream may infer that an
                // unpainted view is also decorative.
                .accessibilityHidden(false)
                .frame(width: 0, height: 0, alignment: .topLeading)
        )
    }
}
