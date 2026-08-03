import XCTest
import SwiftUI
@testable import HypenSwift

/// CSS background compositing rules that are easy to get subtly wrong.
///
/// Both cases here were found by an independent review of the original
/// implementation, which routed a plain-colour `background` shorthand to
/// `backgroundColor` and dropped `backgroundColor` entirely whenever CSS
/// layers were present.
@MainActor
final class BackgroundCompositingTests: XCTestCase {

    private func modifier(for props: [String: Any]) -> HypenModifier {
        let registry = ApplicatorRegistry.withDefaults()
        let el = HypenElement(id: "1", elementType: "column", props: props)
        return registry.applyAllWithVariants(
            element: el,
            context: ApplicatorContext(element: el, actionDispatcher: MockActionDispatcher())
        ).baseModifier
    }

    /// The `background` shorthand resets the longhands it doesn't mention, so
    /// a variant declaring a plain colour must REPLACE a base gradient. If
    /// the plain-colour case took the `backgroundColor` path, a stale
    /// `cssBackground` would still win at render time and the variant colour
    /// would never appear.
    func testPlainColourShorthandOwnsTheLayerStack() {
        let m = modifier(for: ["background.0": "#ff0000"])
        XCTAssertNotNil(m.cssBackground, "shorthand must own the layers so it can replace a base gradient")
        XCTAssertNotNil(m.cssBackground?.color)
        XCTAssertTrue(m.cssBackground?.gradients.isEmpty ?? false)
    }

    func testGradientShorthandStillParsesToALayer() {
        let m = modifier(for: ["background.0": "linear-gradient(to bottom, #000, #fff)"])
        XCTAssertEqual(m.cssBackground?.gradients.count, 1)
    }

    /// A shorthand override replaces the base layers wholesale.
    func testShorthandVariantReplacesABaseGradient() {
        let base = modifier(for: ["background.0": "linear-gradient(to bottom, #000, #fff)"])
        let override = modifier(for: ["background.0": "#ff0000"])

        let merged = HypenModifier.mergeOverride(base: base, override: override)

        XCTAssertNotNil(merged.cssBackground)
        XCTAssertTrue(
            merged.cssBackground?.gradients.isEmpty ?? false,
            "the override's plain colour must replace the base gradient, not sit behind it"
        )
    }

    /// The `background-color` LONGHAND does not reset `background-image`; it
    /// composites beneath it. So both survive on the modifier and the view
    /// layer is responsible for stacking them.
    func testColourLonghandAndImageLayerCoexist() {
        let m = modifier(for: [
            "backgroundColor.0": "#00ff00",
            "backgroundImage.0": "linear-gradient(to bottom, #000, #fff)",
        ])
        XCTAssertNotNil(m.backgroundColor, "the longhand colour must survive for the view to paint underneath")
        XCTAssertEqual(m.cssBackground?.gradients.count, 1)
    }
}
