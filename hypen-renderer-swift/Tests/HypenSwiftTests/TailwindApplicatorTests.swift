import Testing
@testable import HypenSwift

/// Tests that Tailwind-expanded CSS values are correctly handled by Swift applicators.
/// The engine expands `.tw("p-6 bg-black text-white w-full h-full")` into props like:
///   "padding.0": "1.5rem", "backgroundColor.0": "#000000", "color.0": "#ffffff",
///   "width.0": "100%", "height.0": "100%"
/// These tests verify the applicators parse those CSS value formats.

// MARK: - Size Value Parsing

@Test func testParseSizeValuePercent() {
    // Tailwind: w-full → "100%", w-1/2 → "50%"
    let full = parseSizeValue("100%")
    #expect(full != nil)
    if case .fill(let f) = full { #expect(f == 1.0) }

    let half = parseSizeValue("50%")
    #expect(half != nil)
    if case .percent(let f) = half { #expect(f == 0.5) }
}

@Test func testParseSizeValueRem() {
    // Tailwind: w-64 → "16rem", h-24 → "6rem"
    let size16rem = parseSizeValue("16rem")
    #expect(size16rem != nil)
    if case .fixed(let v) = size16rem { #expect(v == 256) } // 16rem * 16pt

    let size6rem = parseSizeValue("6rem")
    #expect(size6rem != nil)
    if case .fixed(let v) = size6rem { #expect(v == 96) } // 6rem * 16pt
}

@Test func testParseSizeValueViewportHeight() {
    // Tailwind: h-screen → "100vh"
    let vh = parseSizeValue("100vh")
    #expect(vh != nil)
    if case .viewportHeight(let f) = vh { #expect(f == 1.0) }
}

@Test func testParseSizeValuePx() {
    // Tailwind: w-px → "1px"
    let px = parseSizeValue("1px")
    #expect(px != nil)
}

// MARK: - Width/Height Applicators with Tailwind Values

@Test func testWidthApplicatorWithPercentage() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["width.0": "100%"],  // from .tw("w-full")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "width")?.apply(modifier: &modifier, value: "100%", context: context)

        #expect(modifier.fillMaxWidth == true)
    }
}

@Test func testHeightApplicatorWithPercentage() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["height.0": "100%"],  // from .tw("h-full")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "height")?.apply(modifier: &modifier, value: "100%", context: context)

        #expect(modifier.fillMaxHeight == true)
    }
}

@Test func testWidthApplicatorWithRem() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["width.0": "16rem"],  // from .tw("w-64")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "width")?.apply(modifier: &modifier, value: "16rem", context: context)

        #expect(modifier.width == 256)  // 16 * 16pt
    }
}

// MARK: - Padding Applicator with Tailwind Values

@Test func testPaddingApplicatorWithRem() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["padding.0": "1.5rem"],  // from .tw("p-6")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "padding")?.apply(modifier: &modifier, value: "1.5rem", context: context)

        #expect(modifier.paddingTop == 24)  // 1.5 * 16pt
        #expect(modifier.paddingBottom == 24)
        #expect(modifier.paddingLeading == 24)
        #expect(modifier.paddingTrailing == 24)
    }
}

@Test func testPaddingApplicatorWithPx() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["padding.0": "16px"],
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "padding")?.apply(modifier: &modifier, value: "16px", context: context)

        // px stripped, treated as points
        #expect(modifier.paddingTop == 16)
    }
}

// MARK: - Color Applicators with Tailwind Values

@Test func testBackgroundColorApplicatorWithHex() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["backgroundColor.0": "#000000"],  // from .tw("bg-black")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "backgroundColor")?.apply(modifier: &modifier, value: "#000000", context: context)

        #expect(modifier.backgroundColor != nil)
    }
}

@Test func testColorApplicatorWithHex() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "text",
            props: ["color.0": "#ffffff"],  // from .tw("text-white")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "color")?.apply(modifier: &modifier, value: "#ffffff", context: context)

        #expect(modifier.foregroundColor != nil)
    }
}

// MARK: - Full Tailwind Pipeline via ApplicatorRegistry

@Test func testFullTailwindPropsPipeline() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()

        // Simulate props from engine after .tw("p-6 bg-black text-white w-full h-full")
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: [
                "padding.0": "1.5rem",
                "backgroundColor.0": "#000000",
                "color.0": "#ffffff",
                "width.0": "100%",
                "height.0": "100%",
            ],
            children: []
        )

        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )

        let result = registry.applyAllWithVariants(element: element, context: context)
        let m = result.baseModifier

        // padding: 1.5rem → 24pt
        #expect(m.paddingTop == 24)
        #expect(m.paddingBottom == 24)
        #expect(m.paddingLeading == 24)
        #expect(m.paddingTrailing == 24)

        // backgroundColor: #000000
        #expect(m.backgroundColor != nil)

        // color: #ffffff → foregroundColor
        #expect(m.foregroundColor != nil)

        // width: 100% → fillMaxWidth
        #expect(m.fillMaxWidth == true)

        // height: 100% → fillMaxHeight
        #expect(m.fillMaxHeight == true)
    }
}

// MARK: - Gap Applicator with Tailwind rem values

@Test func testGapApplicatorWithRem() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()
        let element = HypenElement(
            id: "1",
            elementType: "column",
            props: ["gap.0": "1rem"],  // from .tw("gap-4")
            children: []
        )
        let context = ApplicatorContext(
            element: element,
            actionDispatcher: MockActionDispatcher()
        )
        var modifier = HypenModifier()
        registry.getHandler(for: "gap")?.apply(modifier: &modifier, value: "1rem", context: context)

        #expect(modifier.gap == 16)  // 1rem = 16pt
    }
}

// MARK: - Helper

private final class MockActionDispatcher: ActionDispatcher, @unchecked Sendable {
    func dispatch(action: String, payload: [String: Any]?) {}
}
