import SwiftUI
import Testing
@testable import HypenSwift

#if os(macOS)
import AppKit
#endif

@Suite("Border-box sizing")
struct BorderBoxSizingTests {
    @Test func explicitWidthConstrainsThePaddedOuterBox() {
        var modifier = HypenModifier()
        modifier.width = 100
        modifier.setPadding(all: 8)

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.width == 100)
        #expect(modifier.paddingLeading + modifier.paddingTrailing == 16)
    }

    @Test func explicitHeightConstrainsThePaddedOuterBox() {
        var modifier = HypenModifier()
        modifier.height = 100
        modifier.setPadding(all: 8)

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.height == 100)
        #expect(modifier.paddingTop + modifier.paddingBottom == 16)
    }

    @Test func explicitSizesAreClampedByMinAndMax() {
        var modifier = HypenModifier()
        modifier.width = 80
        modifier.minWidth = 100
        modifier.height = 180
        modifier.maxHeight = 120

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.width == 100)
        #expect(constraints.height == 120)
        #expect(constraints.minWidth == nil)
        #expect(constraints.maxHeight == nil)
    }

    @Test func minimumWinsWhenItExceedsMaximum() {
        var modifier = HypenModifier()
        modifier.minWidth = 120
        modifier.maxWidth = 80
        modifier.minHeight = 90
        modifier.maxHeight = 60

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.minWidth == 120)
        #expect(constraints.maxWidth == 120)
        #expect(constraints.minHeight == 90)
        #expect(constraints.maxHeight == 90)
    }

    @Test func paddingLargerThanAnExplicitSizeDoesNotGrowTheBorderBox() {
        var modifier = HypenModifier()
        modifier.width = 12
        modifier.height = 10
        modifier.setPadding(horizontal: 16, vertical: 14)

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.width == 12)
        #expect(constraints.height == 10)
    }

    @Test func marginRemainsOutsideTheDeclaredBorderBox() {
        var modifier = HypenModifier()
        modifier.width = 100
        modifier.height = 80
        modifier.setPadding(all: 8)
        modifier.setMargin(all: 6)

        let constraints = BorderBoxConstraints(modifier: modifier)
        #expect(constraints.width == 100)
        #expect(constraints.height == 80)
        #expect(constraints.width! + modifier.marginLeading + modifier.marginTrailing == 112)
        #expect(constraints.height! + modifier.marginTop + modifier.marginBottom == 92)
    }

    @Test func fractionalWidthHonorsBorderBoxMinimumAndMaximum() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 0.5
        modifier.minWidth = 180
        modifier.maxWidth = 240

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(180)
        )

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 600,
                parentAllowsHorizontalExpansion: true
            ) == .exact(240)
        )
    }

    #if os(macOS)
    @Test @MainActor func renderedBorderBoxIncludesPaddingAndBorderWithinExplicitSize() {
        var modifier = HypenModifier()
        modifier.width = 100
        modifier.height = 80
        modifier.setPadding(all: 8)
        modifier.backgroundColor = .blue
        modifier.borderWidth = 3
        modifier.borderColor = .red

        let size = fittingSize(
            Text("content")
                .hypenModifier(modifier)
        )

        #expect(size.width == 100)
        #expect(size.height == 80)
    }

    @Test @MainActor func renderedMarginStaysOutsideTheBorderBox() {
        var modifier = HypenModifier()
        modifier.width = 100
        modifier.height = 80
        modifier.setPadding(all: 8)
        modifier.setMargin(all: 6)
        modifier.backgroundColor = .blue

        let size = fittingSize(
            Text("content")
                .hypenModifier(modifier)
        )

        #expect(size.width == 112)
        #expect(size.height == 92)
    }

    @Test @MainActor func renderedMinAndMaxConstrainThePaddedBorderBox() {
        var minimum = HypenModifier()
        minimum.minWidth = 100
        minimum.minHeight = 80
        minimum.setPadding(all: 8)

        let minimumSize = fittingSize(
            Text("x")
                .hypenModifier(minimum)
        )
        #expect(minimumSize.width == 100)
        #expect(minimumSize.height == 80)

        var maximum = HypenModifier()
        maximum.maxWidth = 100
        maximum.maxHeight = 80
        maximum.setPadding(all: 8)

        let maximumSize = fittingSize(
            Color.blue
                .frame(width: 200, height: 160)
                .hypenModifier(maximum)
        )
        #expect(maximumSize.width == 100)
        #expect(maximumSize.height == 80)
    }

    @Test @MainActor func explicitWidthAndAspectRatioResolveTheOuterBorderBoxHeight() {
        var modifier = HypenModifier()
        modifier.width = 100
        modifier.aspectRatio = 2
        modifier.setPadding(all: 8)
        modifier.backgroundColor = .blue

        let size = fittingSize(
            Color.red
                .hypenModifier(modifier)
        )

        #expect(size.width == 100)
        #expect(size.height == 50)
    }

    @MainActor
    private func fittingSize<V: View>(_ view: V) -> CGSize {
        NSHostingView(rootView: view).fittingSize
    }
    #endif
}
