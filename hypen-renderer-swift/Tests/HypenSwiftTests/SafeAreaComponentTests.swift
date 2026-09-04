import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - Registration Tests

@Test func testSafeAreaComponentIsRegistered() async {
    await MainActor.run {
        let registry = ComponentRegistry.withDefaults()

        // The engine emits the primitive as "SafeArea"; the registry is
        // case-insensitive, so both spellings must resolve to a real handler
        // rather than the unknown-component fallback.
        #expect(registry.hasHandler(for: "SafeArea") == true)
        #expect(registry.hasHandler(for: "safearea") == true)
        #expect(registry.getHandler(for: "SafeArea")?.typeName == "safearea")
    }
}

// MARK: - Edge Parsing Tests

@Test func testSafeAreaEdgesDefaultToAllWhenAbsent() {
    #expect(HypenSafeArea.parseEdges(nil) == HypenSafeArea.allEdges)
    #expect(HypenSafeArea.parseEdges(nil).count == 4)
}

@Test func testSafeAreaEdgesDefaultToAllWhenEmpty() {
    #expect(HypenSafeArea.parseEdges([]) == HypenSafeArea.allEdges)
}

@Test func testSafeAreaEdgesFiltering() {
    #expect(HypenSafeArea.parseEdges(["top", "bottom"]) == [.top, .bottom])
    #expect(HypenSafeArea.parseEdges(["left"]) == [.left])
    #expect(HypenSafeArea.parseEdges(["top", "right", "bottom", "left"]) == HypenSafeArea.allEdges)
}

@Test func testSafeAreaEdgesAreCaseAndWhitespaceInsensitive() {
    #expect(HypenSafeArea.parseEdges(["TOP", " Bottom "]) == [.top, .bottom])
}

@Test func testSafeAreaEdgesIgnoreUnknownEntries() {
    #expect(HypenSafeArea.parseEdges(["top", "diagonal"]) == [.top])
    // An explicit list of only unknown edges insets nothing — it is never
    // widened back to "all edges".
    #expect(HypenSafeArea.parseEdges(["diagonal"]).isEmpty)
}

// MARK: - Inset Merge Tests

private let platform = HypenSafeArea.PlatformInsets(top: 47, leading: 3, bottom: 34, trailing: 5)

@Test func testSafeAreaInsetsDefaultToPlatformValues() {
    let resolved = HypenSafeArea.resolveInsets(platform: platform, override: nil)

    #expect(resolved.top == 47)
    #expect(resolved.left == 3)
    #expect(resolved.bottom == 34)
    #expect(resolved.right == 5)
}

@Test func testSafeAreaInsetsOverrideWinsOverPlatform() {
    let resolved = HypenSafeArea.resolveInsets(
        platform: platform,
        override: HypenSafeAreaInsets(top: 10, right: 11, bottom: 12, left: 13)
    )

    #expect(resolved.top == 10)
    #expect(resolved.right == 11)
    #expect(resolved.bottom == 12)
    #expect(resolved.left == 13)
}

@Test func testSafeAreaInsetsOverrideMergesPerEdge() {
    // `bottom: 0` zeroes only the bottom; every other edge keeps the real value.
    let resolved = HypenSafeArea.resolveInsets(
        platform: platform,
        override: HypenSafeAreaInsets(bottom: 0)
    )

    #expect(resolved.top == 47)
    #expect(resolved.left == 3)
    #expect(resolved.right == 5)
    #expect(resolved.bottom == 0)
}

@Test func testSafeAreaInsetsMapPhysicalEdgesInRTL() {
    let resolved = HypenSafeArea.resolveInsets(
        platform: platform,
        override: nil,
        layoutDirection: .rightToLeft
    )

    // In RTL the platform's leading inset is the physical right edge.
    #expect(resolved.right == 3)
    #expect(resolved.left == 5)
}

// MARK: - Padding Tests

@Test func testSafeAreaPaddingAppliesAllEdgesByDefault() {
    let resolved = HypenSafeArea.resolveInsets(platform: platform, override: nil)
    let padding = HypenSafeArea.padding(edges: HypenSafeArea.allEdges, insets: resolved)

    #expect(padding.top == 47)
    #expect(padding.leading == 3)
    #expect(padding.bottom == 34)
    #expect(padding.trailing == 5)
}

@Test func testSafeAreaPaddingZeroesUnselectedEdges() {
    let resolved = HypenSafeArea.resolveInsets(platform: platform, override: nil)
    let padding = HypenSafeArea.padding(edges: [.top, .bottom], insets: resolved)

    #expect(padding.top == 47)
    #expect(padding.bottom == 34)
    #expect(padding.leading == 0)
    #expect(padding.trailing == 0)
}

@Test func testSafeAreaPaddingWithNoEdgesIsZero() {
    let resolved = HypenSafeArea.resolveInsets(platform: platform, override: nil)
    let padding = HypenSafeArea.padding(edges: [], insets: resolved)

    #expect(padding.top == 0)
    #expect(padding.leading == 0)
    #expect(padding.bottom == 0)
    #expect(padding.trailing == 0)
}

@Test func testSafeAreaPaddingMapsPhysicalEdgesInRTL() {
    let resolved = HypenSafeArea.ResolvedInsets(top: 0, right: 20, bottom: 0, left: 10)

    let ltr = HypenSafeArea.padding(edges: HypenSafeArea.allEdges, insets: resolved)
    #expect(ltr.leading == 10)
    #expect(ltr.trailing == 20)

    let rtl = HypenSafeArea.padding(
        edges: HypenSafeArea.allEdges,
        insets: resolved,
        layoutDirection: .rightToLeft
    )
    #expect(rtl.leading == 20)
    #expect(rtl.trailing == 10)
}

// MARK: - Prop Plumbing Tests

@Test func testSafeAreaEdgesPropReadFromElement() {
    // `edges` arrives on the same channel as any other list prop — either
    // under the plain name or the engine's positional `.0` form.
    let plain = HypenElement(
        id: "sa",
        elementType: "SafeArea",
        props: ["edges": ["top", "bottom"]]
    )
    #expect(HypenSafeArea.parseEdges(plain.getStringListProp("edges")) == [.top, .bottom])

    let positional = HypenElement(
        id: "sa",
        elementType: "SafeArea",
        props: ["edges.0": ["left"]]
    )
    #expect(HypenSafeArea.parseEdges(positional.getStringListProp("edges")) == [.left])

    let absent = HypenElement(id: "sa", elementType: "SafeArea", props: [:])
    #expect(HypenSafeArea.parseEdges(absent.getStringListProp("edges")) == HypenSafeArea.allEdges)
}
