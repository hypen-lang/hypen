import SwiftUI
import Testing
@testable import HypenSwift

@MainActor
@Suite("Divider and Grid contracts")
struct DividerGridContractTests {
    @Test func rawDividerUsesCanonicalDefaults() {
        let element = HypenElement(id: "divider", elementType: "divider")

        let style = resolveDividerStyle(element: element, modifier: HypenModifier())

        #expect(style.thickness == 1)
        #expect(style.colorSource == .canonicalDefault)
    }

    @Test func dividerBackgroundAndHeightControlItsStroke() {
        let element = HypenElement(
            id: "divider",
            elementType: "divider",
            props: ["thickness.0": 8]
        )
        var modifier = HypenModifier()
        modifier.backgroundColor = .blue
        modifier.height = 3

        let style = resolveDividerStyle(element: element, modifier: modifier)

        #expect(style.thickness == 3)
        #expect(style.colorSource == .background)
    }

    @Test func rawGridUsesZeroGapAndTwoColumns() {
        let element = HypenElement(id: "grid", elementType: "grid")

        let style = resolveGridStyle(element: element, modifier: HypenModifier())

        #expect(style == GridStyleResolution(columns: 2, spacing: 0))
    }

    @Test func gridPreservesExplicitColumnsAndGap() {
        let element = HypenElement(
            id: "grid",
            elementType: "grid",
            props: ["gridColumns.0": 3]
        )
        var modifier = HypenModifier()
        modifier.gap = 12

        let style = resolveGridStyle(element: element, modifier: modifier)

        #expect(style == GridStyleResolution(columns: 3, spacing: 12))
    }
}
