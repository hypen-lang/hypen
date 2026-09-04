import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - Registration Tests

@Test func testVisuallyHiddenComponentIsRegistered() async {
    await MainActor.run {
        let registry = ComponentRegistry.withDefaults()

        // The engine emits the primitive as "VisuallyHidden"; the registry is
        // case-insensitive, so both spellings must resolve to a real handler.
        // Falling through to the unknown-type fallback would render
        // screen-reader-only content on screen.
        #expect(registry.hasHandler(for: "VisuallyHidden") == true)
        #expect(registry.hasHandler(for: "visuallyhidden") == true)
        #expect(registry.getHandler(for: "VisuallyHidden")?.typeName == "visuallyhidden")
    }
}

@Test func testVisuallyHiddenComponentTypeName() async {
    await MainActor.run {
        #expect(VisuallyHiddenComponent().typeName == "visuallyhidden")
    }
}

// MARK: - Render Tests

@Test func testVisuallyHiddenRendersItsChildren() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        let element = HypenElement(
            id: "vh",
            elementType: "visuallyhidden",
            props: [:],
            children: ["label"]
        )
        let context = ComponentContext(
            element: element,
            renderer: renderer,
            actionDispatcher: MockActionDispatcher()
        )

        // The children closure must still be invoked: the subtree is hidden
        // visually, not dropped — that is the only thing screen readers have
        // left to announce.
        var childrenRendered = false
        _ = VisuallyHiddenComponent().render(
            context: context,
            modifier: HypenModifier(),
            children: {
                childrenRendered = true
                return AnyView(Text("Loading complete"))
            }
        )

        #expect(childrenRendered == true)
    }
}
