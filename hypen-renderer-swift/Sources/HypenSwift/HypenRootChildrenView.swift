import SwiftUI

/// Renders the `"root"` mount container's children (`HypenRenderer.rootLayout`).
///
/// - One root child (the common case): that element's view directly, with no
///   wrapper — the same hierarchy the single-`rootId` renderer produced.
/// - Several (control flow at the IR root with siblings): stacked top to
///   bottom in root order, with no spacing, like the DOM mount container's
///   block flow and the desktop renderer's column root. Each child keeps its
///   identity by node id, so a Move at the root reorders views instead of
///   rebuilding them, and VoiceOver reads the children in root order.
///
/// Hosts apply their root environment (`parentAllows*Expansion`, the
/// `resetEpoch` identity, the DnD host) around this view.
@MainActor
struct HypenRootChildrenView: View {
    let layout: RootChildren.Layout
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    var body: some View {
        switch layout {
        case .empty:
            EmptyView()
        case .single(let id):
            HypenElementView(
                elementId: id,
                renderer: renderer,
                actionDispatcher: actionDispatcher
            )
        case .stacked(let ids):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(ids, id: \.self) { id in
                    HypenElementView(
                        elementId: id,
                        renderer: renderer,
                        actionDispatcher: actionDispatcher
                    )
                }
            }
        }
    }
}
