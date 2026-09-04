import SwiftUI
import Testing
@testable import HypenSwift

#if os(macOS)
import AppKit
#endif

@MainActor
@Suite("List and Grid rendered layout")
struct ListGridLayoutTests {
    @Test func staticListFillsWidthWithoutBecomingScrollable() {
        let element = HypenElement(id: "list", elementType: "list")

        let layout = resolveListLayout(element: element, modifier: HypenModifier())

        #expect(layout.fillsFiniteWidth)
        #expect(!layout.scrollsVertically)
    }

    @Test func boundedDynamicAndOverflowListsRetainScrolling() {
        let element = HypenElement(id: "list", elementType: "list")
        var bounded = HypenModifier()
        bounded.height = 120

        #expect(resolveListLayout(element: element, modifier: bounded).scrollsVertically)
        #expect(resolveListLayout(
            element: element,
            modifier: HypenModifier(),
            hasDynamicItems: true
        ).scrollsVertically)

        let overflow = HypenElement(
            id: "overflow",
            elementType: "list",
            props: ["overflow.0": "auto"]
        )
        #expect(resolveListLayout(element: overflow, modifier: HypenModifier()).scrollsVertically)
    }

    #if os(macOS)
    @Test func flexibleGridTracksProposeTheirFullCellWidth() {
        let probe = WidthProbe()
        var styled = HypenModifier()
        styled.backgroundColor = .blue
        styled.setPadding(all: 12)

        let view = HypenGridLayout(columns: 3, spacing: 12) {
            WidthProbeLayout(probe: probe) {
                Text("A")
                    .hypenModifier(styled)
                    .environment(\.parentStretchesHorizontalSizing, true)
            }
            Color.clear.frame(height: 40)
            Color.clear.frame(height: 40)
        }
        .frame(width: 300)

        _ = NSHostingView(rootView: view).fittingSize

        #expect(probe.proposedWidth == 92)
        #expect(probe.measuredWidth == 92)
    }

    @Test func explicitImageWidthRemainsFixedInsideAWiderTrack() {
        let probe = WidthProbe()
        var fixed = HypenModifier()
        fixed.width = 100
        fixed.height = 100

        let view = HypenGridLayout(columns: 2, spacing: 8) {
            WidthProbeLayout(probe: probe) {
                Color.blue
                    .hypenModifier(fixed)
                    .environment(\.parentStretchesHorizontalSizing, true)
            }
            Color.clear.frame(height: 100)
        }
        .frame(width: 320)

        _ = NSHostingView(rootView: view).fittingSize

        #expect(probe.proposedWidth == 156)
        #expect(probe.measuredWidth == 100)
    }

    @Test @MainActor func styledGridCellCentersItsContentInsideTheTrack() throws {
        let renderer = HypenRenderer()
        renderer.applyPatches([
            Patch(type: .create, id: "grid", elementType: "grid", props: [
                "gridColumns.0": 3,
                "gap.0": 12,
            ]),
            Patch(type: .create, id: "cell", elementType: "column", props: [
                "backgroundColor.0": "#3b82f6",
                "padding.0": 12,
                "horizontalAlignment.0": "center",
            ]),
            Patch(type: .insert, id: "cell", parentId: "grid"),
            Patch(type: .create, id: "centered-label", elementType: "grid-test-probe"),
            Patch(type: .insert, id: "centered-label", parentId: "cell"),
            Patch(type: .create, id: "trailing-cell", elementType: "column", props: [
                "backgroundColor.0": "#22c55e",
                "padding.0": 12,
                "horizontalAlignment.0": "end",
            ]),
            Patch(type: .insert, id: "trailing-cell", parentId: "grid"),
            Patch(type: .create, id: "trailing-label", elementType: "grid-test-probe"),
            Patch(type: .insert, id: "trailing-label", parentId: "trailing-cell"),
            Patch(type: .create, id: "default-cell", elementType: "column", props: [
                "backgroundColor.0": "#f59e0b",
                "padding.0": 12,
            ]),
            Patch(type: .insert, id: "default-cell", parentId: "grid"),
            Patch(type: .create, id: "default-label", elementType: "grid-test-probe"),
            Patch(type: .insert, id: "default-label", parentId: "default-cell"),
        ])

        let registry = ComponentRegistry.withDefaults()
        registry.register(GridTestProbeComponent())

        let view = HypenElementView(
            elementId: "grid",
            renderer: renderer,
            actionDispatcher: MockActionDispatcher()
        )
        .componentRegistry(registry)

        let host = render(view, size: CGSize(width: 300, height: 44))
        let label = try #require(frame(of: "centered-label", in: host))
        let trailingLabel = try #require(frame(of: "trailing-label", in: host))
        let defaultLabel = try #require(frame(of: "default-label", in: host))

        // First track is 92pt wide: (300 - 2 * 12) / 3. Its midpoint is 46.
        #expect(abs(label.midX - 46) < 1)
        // Explicit end alignment wins in the second track, inside 12pt padding.
        #expect(abs(trailingLabel.maxX - 184) < 1)
        // With no explicit alignment, the third track retains leading layout.
        #expect(abs(defaultLabel.minX - 220) < 1)
    }

    private final class WidthProbe: @unchecked Sendable {
        var proposedWidth: CGFloat?
        var measuredWidth: CGFloat?
    }

    private struct WidthProbeLayout: Layout {
        let probe: WidthProbe

        func sizeThatFits(
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) -> CGSize {
            probe.proposedWidth = proposal.width
            let size = subviews[0].sizeThatFits(proposal)
            probe.measuredWidth = size.width
            return size
        }

        func placeSubviews(
            in bounds: CGRect,
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) {
            subviews[0].place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: proposal
            )
        }
    }

    private func render<V: View>(_ view: V, size: CGSize) -> NSHostingView<V> {
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        host.layoutSubtreeIfNeeded()
        return host
    }

    private func frame(of id: String, in host: NSView) -> CGRect? {
        guard let probe = descendant(id: id, in: host) else { return nil }
        return probe.convert(probe.bounds, to: host)
    }

    private func descendant(id: String, in view: NSView) -> NSView? {
        if view.identifier?.rawValue == id { return view }
        for child in view.subviews {
            if let match = descendant(id: id, in: child) { return match }
        }
        return nil
    }
    #endif
}

#if os(macOS)
private struct GridFrameProbe: NSViewRepresentable {
    let id: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier(id)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private struct GridTestProbeComponent: ComponentHandler {
    let typeName = "grid-test-probe"

    func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        AnyView(GridFrameProbe(id: context.element.id).frame(width: 12, height: 20))
    }
}

#endif
