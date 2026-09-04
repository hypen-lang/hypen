import SwiftUI
import Testing
@testable import HypenSwift

@MainActor
@Suite("Compound border styles")
struct BorderStyleApplicatorTests {
    private func modifier(for props: [String: Any]) -> HypenModifier {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "border-style-test",
            elementType: "column",
            props: props,
            children: []
        )
        return registry.applyAllWithVariants(
            element: element,
            context: ApplicatorContext(
                element: element,
                actionDispatcher: MockActionDispatcher()
            )
        ).baseModifier
    }

    @Test(arguments: [
        ("solid", "solid"),
        (" DASHED ", "dashed"),
        ("DoTtEd", "dotted"),
    ])
    func compoundMapParsesAndCanonicalizesStyle(input: String, expected: String) {
        let result = modifier(for: [
            "border.width": 2,
            "border.color": "#ff0000",
            "border.style": input,
        ])

        #expect(result.borderStyle == expected)
        #expect(result.explicitlySetProperties.contains("borderStyle"))
    }

    @Test func compoundMapWithoutStyleExplicitlyResetsToSolid() {
        let override = modifier(for: [
            "border.width": 2,
            "border.color": "#ff0000",
        ])
        var base = HypenModifier()
        base.borderStyle = "dashed"
        base.explicitlySetProperties.insert("borderStyle")

        let merged = HypenModifier.mergeOverride(base: base, override: override)

        #expect(override.borderStyle == "solid")
        #expect(override.explicitlySetProperties.contains("borderStyle"))
        #expect(merged.borderStyle == "solid")
    }

    @Test func separateBorderStyleLonghandOverridesCompoundMap() {
        let result = modifier(for: [
            "border.width": 2,
            "border.color": "#ff0000",
            "border.style": "dashed",
            "borderStyle.0": "dotted",
        ])

        #expect(result.borderStyle == "dotted")
        #expect(result.explicitlySetProperties.contains("borderStyle"))
    }

    @Test func dashedAndDottedUseDistinctPaintRecipes() {
        let solid = borderRenderingStyle("solid", width: 2)
        let dashed = borderRenderingStyle("dashed", width: 2)
        let dotted = borderRenderingStyle("dotted", width: 2)

        #expect(solid == .solid)
        #expect(dashed == .dashed([6, 4]))
        #expect(dotted == .dotted([0, 4]))
        #expect(dashed != dotted)
    }
}
