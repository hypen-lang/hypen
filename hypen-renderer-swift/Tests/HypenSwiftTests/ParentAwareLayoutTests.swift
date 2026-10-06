import SwiftUI
import Testing
@testable import HypenSwift

#if os(macOS)
import AppKit
#endif

@Suite("Parent-aware container layout")
struct ParentAwareLayoutTests {
    @Test func percentageHeightsUseTheImmediatePaddedContentBox() {
        var parent = HypenModifier()
        parent.height = 200
        parent.setPadding(all: 16)

        #expect(parent.explicitContentHeight == 168)
        #expect([0.25, 0.5, 0.75, 1].map { parent.explicitContentHeight! * $0 } == [42, 84, 126, 168])
    }

    @Test func filledStackSubtractsItsOwnPaddingFromTheContentProposal() {
        var child = HypenModifier()
        child.fillMaxHeight = true
        child.setPadding(all: 12)

        // Gallery Row: height 150 with 16pt parent padding exposes a 118pt
        // content box. The purple child's painted border box must stay 118pt,
        // not grow to 118 + its own 24pt padding.
        #expect(child.contentHeight(forFilledBorderBox: 118) == 94)
    }

    @Test func percentageWidthsShareOneRowPoolAfterPaddingAndGaps() {
        var parent = HypenModifier()
        parent.width = 300
        parent.setPadding(all: 16)

        let widths = RowWidthAllocator.widths(
            availableWidth: parent.explicitContentWidth!,
            gap: 8,
            naturalWidths: [40, 70],
            items: [
                RowItemSizing(fraction: 0.5),
                RowItemSizing(fraction: 0.5),
            ]
        )

        #expect(widths == [130, 130])
        #expect(widths.reduce(0, +) + 8 == 268)
    }

    @Test func numericFlexUsesAZeroBasisAndHonorsOneTwoOneRatios() {
        let widths = RowWidthAllocator.widths(
            availableWidth: 300,
            gap: 8,
            naturalWidths: [90, 30, 140],
            items: [
                RowItemSizing(flexWeight: 1, usesZeroFlexBasis: true),
                RowItemSizing(flexWeight: 2, usesZeroFlexBasis: true),
                RowItemSizing(flexWeight: 1, usesZeroFlexBasis: true),
            ]
        )

        #expect(widths == [71, 142, 71])
    }

    @Test func flexGrowExpandsFromItsPaintedNaturalWidth() {
        let widths = RowWidthAllocator.widths(
            availableWidth: 300,
            gap: 8,
            naturalWidths: [80, 40],
            items: [
                RowItemSizing(),
                RowItemSizing(flexWeight: 1),
            ]
        )

        #expect(widths == [80, 212])
    }

    @Test func flexShrinkZeroProtectsItsSiblingWidth() {
        let widths = RowWidthAllocator.widths(
            availableWidth: 300,
            gap: 8,
            naturalWidths: [200, 200],
            items: [
                RowItemSizing(shrink: 1),
                RowItemSizing(shrink: 0),
            ]
        )

        #expect(widths == [92, 200])
    }

    @Test func declaredWidthIsTheShrinkBasisRatherThanASecondPaintWidth() {
        let widths = RowWidthAllocator.widths(
            availableWidth: 300,
            gap: 8,
            naturalWidths: [24, 24],
            items: [
                RowItemSizing(basis: 200, shrink: 1),
                RowItemSizing(basis: 200, shrink: 0),
            ]
        )

        #expect(widths == [92, 200])
    }

    @Test @MainActor func flexibleSpacerConsumesTheRemainingListRowWidth() {
        let spacer = RowItemSizing(element: HypenElement(
            id: "spacer",
            elementType: "spacer"
        ))
        let widths = RowWidthAllocator.widths(
            availableWidth: 300,
            gap: 0,
            naturalWidths: [42, 0, 8],
            items: [RowItemSizing(), spacer, RowItemSizing()]
        )

        #expect(spacer.flexWeight == 1)
        #expect(spacer.usesZeroFlexBasis)
        #expect(widths == [42, 250, 8])
    }

    @Test func stackAxisApplicatorsCombineIntoCenterAlignment() {
        let alignment = StackAlignmentResolver.resolve(
            nil,
            horizontal: "center",
            vertical: "center"
        )

        #expect(alignment.horizontal == .center)
        #expect(alignment.vertical == .center)
    }

    @Test @MainActor func rowMetadataRecognizesFractionFlexGrowAndShrink() {
        let fraction = RowItemSizing(element: HypenElement(
            id: "fraction",
            elementType: "stack",
            props: ["fillMaxWidth.0": 0.5]
        ))
        let flex = RowItemSizing(element: HypenElement(
            id: "flex",
            elementType: "stack",
            props: ["flex.0": 2]
        ))
        let grow = RowItemSizing(element: HypenElement(
            id: "grow",
            elementType: "stack",
            props: ["flexGrow.0": 1, "flexShrink.0": 0]
        ))

        #expect(fraction.fraction == 0.5)
        #expect(flex.flexWeight == 2)
        #expect(flex.usesZeroFlexBasis)
        #expect(grow.flexWeight == 1)
        #expect(grow.shrink == 0)
    }

    @Test @MainActor func numericWidthIsAPointBasisNotAFullWidthFraction() {
        let avatar = RowItemSizing(element: HypenElement(
            id: "avatar",
            elementType: "column",
            props: ["width.0": 48]
        ))
        let percentage = RowItemSizing(element: HypenElement(
            id: "half",
            elementType: "column",
            props: ["width.0": "50%"]
        ))

        #expect(avatar.basis == 48)
        #expect(avatar.fraction == nil)
        #expect(percentage.basis == nil)
        #expect(percentage.fraction == 0.5)
    }

    #if os(macOS)
    @Test @MainActor func checkboxAndProfileRowsKeepTheirNaturalCardHeightUnderATallProposal() throws {
        let view = ZStack(alignment: .topLeading) {
            HypenRowLayout(gap: 12, verticalAlignment: .center, horizontalAlignment: .leading) {
                LayoutFrameProbe(id: "checkbox")
                    .frame(width: 20, height: 20)
                    .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
                LayoutFrameProbe(id: "profile-card")
                    .frame(width: 220, height: 76)
                    .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
            }
            .overlay(LayoutFrameProbe(id: "row-bounds"))
        }

        let host = render(view, size: CGSize(width: 320, height: 600))
        let row = try #require(frame(of: "row-bounds", in: host))
        #expect(abs(row.height - 76) < 1)
    }

    @Test @MainActor func audioAndListLabelGroupCentersWithoutSpaceBetweenExpansion() throws {
        let view = HypenRowLayout(gap: 8, verticalAlignment: .center, horizontalAlignment: .center) {
            LayoutFrameProbe(id: "audio-icon")
                .frame(width: 40, height: 40)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
            LayoutFrameProbe(id: "audio-label")
                .frame(width: 60, height: 20)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
        }

        let host = render(view, size: CGSize(width: 300, height: 40))
        let icon = try #require(frame(of: "audio-icon", in: host))
        let label = try #require(frame(of: "audio-label", in: host))
        #expect(abs(icon.minX - 96) < 1)
        #expect(abs(label.maxX - 204) < 1)
        #expect(abs(label.minX - icon.maxX - 8) < 1)
    }

    @Test @MainActor func weightedPlaylistLabelReceivesVisiblePaintWidth() throws {
        let view = HypenRowLayout(gap: 8, verticalAlignment: .center, horizontalAlignment: .leading) {
            LayoutFrameProbe(id: "artwork")
                .frame(width: 50, height: 50)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
            LayoutFrameProbe(id: "playlist-label")
                .frame(minWidth: 1, maxWidth: .infinity, minHeight: 20)
                .layoutValue(
                    key: RowSizingLayoutValueKey.self,
                    value: RowItemSizing(flexWeight: 1, usesZeroFlexBasis: true)
                )
        }

        let host = render(view, size: CGSize(width: 300, height: 50))
        let label = try #require(frame(of: "playlist-label", in: host))
        #expect(abs(label.width - 242) < 1)
    }

    @Test @MainActor func gradientRowDoesNotTurnAParentHeightProposalIntoVerticalGaps() throws {
        let view = ZStack(alignment: .topLeading) {
            HypenRowLayout(gap: 10, verticalAlignment: .top, horizontalAlignment: .leading) {
                LayoutFrameProbe(id: "gradient-a")
                    .frame(width: 90, height: 48)
                    .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
                LayoutFrameProbe(id: "gradient-b")
                    .frame(width: 90, height: 48)
                    .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(shrink: 0))
            }
            .overlay(LayoutFrameProbe(id: "gradient-row"))
        }

        let host = render(view, size: CGSize(width: 300, height: 500))
        let row = try #require(frame(of: "gradient-row", in: host))
        #expect(abs(row.height - 48) < 1)
    }

    @Test @MainActor func renderedFlexShrinkUsesNinetyTwoAndTwoHundredPointBoxes() throws {
        var shrinkable = HypenModifier()
        shrinkable.width = 200
        shrinkable.height = 32
        shrinkable.flexShrink = 1

        var protected = HypenModifier()
        protected.width = 200
        protected.height = 32
        protected.flexShrink = 0

        let view = HypenRowLayout(gap: 8, verticalAlignment: .top, horizontalAlignment: .leading) {
            Color.green
                .hypenModifier(shrinkable)
                .background(LayoutFrameProbe(id: "shrinkable"))
                .environment(\.parentControlsHorizontalSizing, true)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(basis: 200, shrink: 1))
            Color.orange
                .hypenModifier(protected)
                .background(LayoutFrameProbe(id: "protected"))
                .environment(\.parentControlsHorizontalSizing, true)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing(basis: 200, shrink: 0))
        }

        let host = render(view, size: CGSize(width: 300, height: 32))
        let green = try #require(frame(of: "shrinkable", in: host))
        let orange = try #require(frame(of: "protected", in: host))
        #expect(abs(green.width - 92) < 1)
        #expect(abs(orange.width - 200) < 1)
        #expect(abs(orange.minX - green.maxX - 8) < 1)
    }

    @Test @MainActor func fixtureShapedCenteredProfileRowStaysCompact() throws {
        let view = HypenRowLayout(gap: 12, verticalAlignment: .center, horizontalAlignment: .center) {
            LayoutFrameProbe(id: "avatar")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .layoutValue(
                    key: RowSizingLayoutValueKey.self,
                    value: RowItemSizing(basis: 48)
                )
            LayoutFrameProbe(id: "profile-copy")
                .frame(width: 118, height: 38)
                .layoutValue(key: RowSizingLayoutValueKey.self, value: RowItemSizing())
        }

        let host = render(view, size: CGSize(width: 360, height: 48))
        let avatar = try #require(frame(of: "avatar", in: host))
        let copy = try #require(frame(of: "profile-copy", in: host))
        #expect(abs(avatar.width - 48) < 1)
        #expect(abs(avatar.minX - 91) < 1)
        #expect(abs(copy.minX - avatar.maxX - 12) < 1)
        #expect(abs(copy.maxX - 269) < 1)
    }

    @MainActor
    private func render<V: View>(_ view: V, size: CGSize) -> NSHostingView<V> {
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        host.layoutSubtreeIfNeeded()
        return host
    }

    @MainActor
    private func frame(of id: String, in host: NSView) -> CGRect? {
        guard let probe = descendant(id: id, in: host) else { return nil }
        return probe.convert(probe.bounds, to: host)
    }

    @MainActor
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
private struct LayoutFrameProbe: NSViewRepresentable {
    let id: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier(id)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
#endif
