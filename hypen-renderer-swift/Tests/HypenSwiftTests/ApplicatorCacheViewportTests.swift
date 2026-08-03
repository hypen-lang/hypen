import XCTest
import SwiftUI
@testable import HypenSwift

/// The applicator result cache is keyed on the viewport, not just props.
///
/// `vw`/`vh` resolve against the area the Hypen root was given, and nothing
/// mutates the element when the window resizes, rotates, or when the first
/// `GeometryReader` pass replaces the unmeasured zero with a real size. If
/// the viewport weren't part of the key, a `min-h-screen` element would keep
/// whatever height it resolved on its very first composition — forever.
@MainActor
final class ApplicatorCacheViewportTests: XCTestCase {

    private func element() -> HypenElement {
        HypenElement(id: "1", elementType: "column", props: ["height.0": "100vh"])
    }

    private func context(_ el: HypenElement, viewport: CGSize) -> ApplicatorContext {
        ApplicatorContext(
            element: el,
            actionDispatcher: MockActionDispatcher(),
            viewportSize: viewport
        )
    }

    func testVhResolvesAgainstTheViewport() {
        let registry = ApplicatorRegistry.withDefaults()
        let el = element()

        let result = registry.applyAllWithVariants(
            element: el,
            context: context(el, viewport: CGSize(width: 402, height: 700))
        )
        XCTAssertEqual(result.baseModifier.height, 700)
    }

    func testAChangedViewportRecomputesRatherThanServingAStaleCache() {
        let registry = ApplicatorRegistry.withDefaults()
        let el = element()

        let first = registry.applyAllWithVariants(
            element: el,
            context: context(el, viewport: CGSize(width: 402, height: 700))
        )
        XCTAssertEqual(first.baseModifier.height, 700)

        // Same element, same props — only the viewport changed (rotation,
        // split view, or the first real measurement landing).
        let second = registry.applyAllWithVariants(
            element: el,
            context: context(el, viewport: CGSize(width: 402, height: 500))
        )
        XCTAssertEqual(second.baseModifier.height, 500)
    }

    func testAnUnchangedViewportStillServesTheCache() {
        let registry = ApplicatorRegistry.withDefaults()
        let el = element()
        let viewport = CGSize(width: 402, height: 700)

        _ = registry.applyAllWithVariants(element: el, context: context(el, viewport: viewport))
        XCTAssertNotNil(el.cachedApplicatorResult)

        let cachedBefore = el.cachedApplicatorResult
        _ = registry.applyAllWithVariants(element: el, context: context(el, viewport: viewport))
        // Still populated and still the same memoised instance's values.
        XCTAssertNotNil(cachedBefore)
        XCTAssertEqual(el.cachedApplicatorViewport, viewport)
    }
}
