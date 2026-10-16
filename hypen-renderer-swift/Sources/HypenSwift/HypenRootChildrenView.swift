import SwiftUI

/// Renders the `"root"` mount container's children (`HypenRenderer.rootIds`)
/// top to bottom in root order: one root child normally, several when
/// control flow (Router / If / ForEach) sits at the IR root with siblings.
///
/// One always-present container for every count, so going between one and
/// several roots never changes a surviving child's identity: the view path
/// is always `VStack → ForEach → HypenElementView` keyed by node id, so a
/// root `If` banner toggling above a Router neither remounts the page nor
/// resets its scroll position / `@State`, and a Move at the root reorders
/// views instead of rebuilding them. VoiceOver reads the children in order.
///
/// Why the single-child case lays out exactly like the old bare
/// `HypenElementView`: a `VStack` offers its whole proposal to a lone child
/// (no spacing to subtract, nothing to share it with), takes that child's
/// size as its own, and places it at its origin — `spacing: 0` adds no gap,
/// and `.leading` alignment is moot with one child because the stack is
/// exactly as wide as it. Flexibility passes through too (a child with
/// `maxWidth/maxHeight: .infinity` makes the stack flexible), so the host's
/// `ZStack(.topLeading)` and `.frame(maxWidth/maxHeight: .infinity)` see the
/// same sizes and place it at the same point. Environment values the host
/// sets on this view reach the child unchanged.
///
/// With several children the stack mirrors the DOM mount container's block
/// flow and the desktop renderer's column root (no gap, leading-aligned).
/// Placeholder / loading content is the host's job, gated on
/// `HypenRenderer.showsRootPlaceholder`; an empty list renders nothing.
@MainActor
struct HypenRootChildrenView: View {
    let rootIds: [String]
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rootIds, id: \.self) { id in
                HypenElementView(
                    elementId: id,
                    renderer: renderer,
                    actionDispatcher: actionDispatcher
                )
            }
        }
    }
}
