import Testing
import SwiftUI
@testable import HypenSwift

/// Regression guards for two applicators that are easy to register and then
/// silently drop on the floor: the value has to survive the registry lookup,
/// land on `HypenModifier`, and be read by something that renders.
///
/// `foregroundColor` → `modifier.foregroundColor` → `.foregroundStyle(...)` in
/// `hypenModifier`; `justifyContent` → `modifier.alignment` → the frames
/// `hypenModifier` installs (Column/Row additionally read the prop directly to
/// drive their stack arrangement).

// MARK: - foregroundColor

@Test func testForegroundColorApplicatorReachesModifier() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "text",
            props: ["foregroundColor.0": "#ff0000"],
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )

        let result = registry.applyAllWithVariants(element: element, context: context)

        #expect(result.baseModifier.foregroundColor == ColorParser.parse("#ff0000"))
    }
}

@Test func testColorWinsOverForegroundColorWhenBothSet() async {
    await MainActor.run {
        // Cross-renderer contract: `color` is canonical, `foregroundColor` is
        // the alias. The registry applies keys sorted, so without the guard
        // "foregroundColor.0" ran after "color.0" and won by accident.
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "text",
            props: ["color.0": "#ff0000", "foregroundColor.0": "#0000ff"],
            children: []
        )
        let context = ApplicatorContext(element: element, actionDispatcher: MockActionDispatcher())

        let result = registry.applyAllWithVariants(element: element, context: context)

        #expect(result.baseModifier.foregroundColor == ColorParser.parse("#ff0000"))
    }
}

@Test func testForegroundColorVariantOverridesBase() async {
    await MainActor.run {
        // A `:hover` variant must replace the base colour, not sit beside it.
        var base = HypenModifier()
        base.foregroundColor = ColorParser.parse("#000000")
        var override = HypenModifier()
        override.foregroundColor = ColorParser.parse("#ffffff")

        let merged = HypenModifier.mergeOverride(base: base, override: override)

        #expect(merged.foregroundColor == ColorParser.parse("#ffffff"))
    }
}

// MARK: - justifyContent

@Test func testJustifyContentApplicatorCentersOnMainAxis() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "box",
            props: ["justifyContent.0": "center"],
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )

        let result = registry.applyAllWithVariants(element: element, context: context)

        // The main axis centers; the cross axis keeps its default.
        #expect(result.baseModifier.alignment == Alignment(horizontal: .center, vertical: .top))
    }
}

@Test func testJustifyContentAndAlignItemsCombine() async {
    await MainActor.run {
        // The `tw("items-center justify-center")` pairing: each applicator
        // must preserve the axis the other one set.
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "box",
            props: [
                "alignItems.0": "center",
                "justifyContent.0": "center",
            ],
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )

        let result = registry.applyAllWithVariants(element: element, context: context)

        #expect(result.baseModifier.alignment == Alignment(horizontal: .center, vertical: .center))
    }
}

@Test func testJustifyContentEndMapsToTrailing() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "box",
            props: ["justifyContent.0": "flex-end"],
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )

        let result = registry.applyAllWithVariants(element: element, context: context)

        #expect(result.baseModifier.alignment == Alignment(horizontal: .trailing, vertical: .top))
    }
}

// MARK: - Stack axis mapping

@Test func testStackReadsJustifyContentAsHorizontalAxis() {
    // Stack used to feed `justifyContent` into the vertical axis (and
    // `alignItems` into the horizontal), the inverse of Box/Button here and of
    // Android and canvas. `Stack {}.justifyContent("center")` must centre
    // horizontally.
    let element = HypenElement(
        id: "1",
        elementType: "stack",
        props: ["justifyContent.0": "center"],
        children: []
    )
    let horizontal = element.getStringProp("horizontalAlignment.0")
        ?? element.getStringProp("justifyContent.0")
    let vertical = element.getStringProp("verticalAlignment.0")
        ?? element.getStringProp("alignItems.0")
    let alignment = StackAlignmentResolver.resolve(nil, horizontal: horizontal, vertical: vertical)
    #expect(alignment == .top)
}
