import SwiftUI
import Testing
@testable import HypenSwift

@Suite("Percentage width sizing")
struct PercentageWidthTests {
    private let context = ApplicatorContext(
        element: HypenElement(id: "test", elementType: "box", props: [:], children: []),
        actionDispatcher: MockActionDispatcher()
    )

    @Test(arguments: [
        ("25%", CGFloat(0.25)),
        ("50%", CGFloat(0.50)),
        ("75%", CGFloat(0.75)),
        ("100%", CGFloat(1.00)),
    ])
    func percentageApplicatorPreservesFraction(value: String, fraction: CGFloat) {
        var modifier = HypenModifier()
        WidthApplicator().apply(modifier: &modifier, value: value, context: context)

        #expect(modifier.fillMaxWidth)
        #expect(modifier.fillMaxWidthFraction == fraction)
    }

    @Test(arguments: [
        (CGFloat(0.25), CGFloat(80)),
        (CGFloat(0.50), CGFloat(160)),
        (CGFloat(0.75), CGFloat(240)),
    ])
    func fractionalWidthsResolveBeforeVisuals(fraction: CGFloat, expectedWidth: CGFloat) {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = fraction

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(expectedWidth)
        )
        #expect(modifier.hasFractionalFillWidth)
    }

    @Test func fullWidthKeepsBooleanFillBehavior() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 1

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .full
        )
        #expect(!modifier.hasFractionalFillWidth)
    }

    @Test func unresolvedFractionUsesContainerRelativeSizing() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 0.5

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: nil,
                parentAllowsHorizontalExpansion: true
            ) == .relative(fraction: 0.5, minWidth: nil, maxWidth: nil)
        )
    }

    @Test func fractionalWidthIsResolvedThenCappedBeforeVisuals() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 0.75
        modifier.maxWidth = 180

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(180)
        )

        // A cap larger than the requested percentage does not force the
        // element up to the cap; 75% of 320 remains 240.
        modifier.maxWidth = 280
        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(240)
        )
    }

    @Test func unresolvedFractionCarriesItsCapIntoContainerSizing() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 0.75
        modifier.maxWidth = 180

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: nil,
                parentAllowsHorizontalExpansion: true
            ) == .relative(fraction: 0.75, minWidth: nil, maxWidth: 180)
        )
    }

    @Test func fullWidthWithMaxWidthResolvesToTheCap() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 1
        modifier.maxWidth = 180

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(180)
        )
    }

    @Test func paddingAndMarginDoNotChangeTheResolvedPercentage() {
        var modifier = HypenModifier()
        modifier.fillMaxWidth = true
        modifier.fillMaxWidthFraction = 0.5
        modifier.setPadding(all: 12)
        modifier.setMargin(all: 8)

        #expect(
            modifier.horizontalFillExpansion(
                parentWidth: 320,
                parentAllowsHorizontalExpansion: true
            ) == .exact(160)
        )
    }
}
