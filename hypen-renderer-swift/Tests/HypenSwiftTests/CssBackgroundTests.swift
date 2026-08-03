import XCTest
import SwiftUI
@testable import HypenSwift

/// The parser behind `background` / `backgroundImage`.
///
/// Mirrors `CssBackgroundTest.kt` on Android case for case, so the two
/// renderers can't quietly disagree about what a CSS value means.
///
/// The load-bearing case is the home-screen wallpaper, a two-layer value
/// whose layers BOTH contain commas — `rgba(3, 7, 18, 0.6)` inside the
/// gradient and a base64 payload inside `url(...)`. A naive split on commas
/// shreds it, which is the shape of the original bug.
final class CssBackgroundTests: XCTestCase {

    // MARK: - Splitting

    func testSplitsTopLevelCommasOnly() {
        XCTAssertEqual(CssBackground.splitTopLevel("a, b, c").count, 3)
    }

    func testDoesNotSplitInsideParentheses() {
        let parts = CssBackground.splitTopLevel("rgba(3, 7, 18, 0.6), red")
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[0].trimmingCharacters(in: .whitespaces), "rgba(3, 7, 18, 0.6)")
        XCTAssertEqual(parts[1].trimmingCharacters(in: .whitespaces), "red")
    }

    func testDoesNotSplitInsideQuotes() {
        let parts = CssBackground.splitTopLevel("url('a,b.png'), red")
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[0].trimmingCharacters(in: .whitespaces), "url('a,b.png')")
    }

    func testDoesNotSplitInsideNestedParentheses() {
        let parts = CssBackground.splitTopLevel(
            "linear-gradient(180deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.6)), red"
        )
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[1].trimmingCharacters(in: .whitespaces), "red")
    }

    // MARK: - Gradients

    func testParsesTailwindGradientValue() {
        // What `bg-gradient-to-br from-indigo-400 to-violet-600` lowers to.
        let layers = CssBackground.parse("linear-gradient(to bottom right, #818cf8, #7c3aed)")
        XCTAssertNotNil(layers)
        XCTAssertEqual(layers?.gradients.count, 1)
        XCTAssertNil(layers?.color)
        XCTAssertNil(layers?.imageUri)
    }

    func testParsesAngleGradient() {
        XCTAssertEqual(CssBackground.parse("linear-gradient(180deg, #000, #fff)")?.gradients.count, 1)
    }

    func testParsesColourStopsWithPositions() {
        XCTAssertEqual(
            CssBackground.parse("linear-gradient(to right, #000 10%, #fff 90%)")?.gradients.count,
            1
        )
    }

    func testSingleStopGradientYieldsNothing() {
        // Not expressible as a ramp; snap rather than invent a second stop.
        XCTAssertNil(CssBackground.parse("linear-gradient(to right, #000)"))
    }

    // MARK: - The wallpaper

    func testParsesLayeredWallpaperShorthand() {
        let value = "linear-gradient(180deg, rgba(3, 7, 18, 0.08), rgba(3, 7, 18, 0.6)), "
            + "url('data:image/png;base64,iVBORw0KGgo=') center / cover no-repeat"

        let layers = CssBackground.parse(value)
        XCTAssertNotNil(layers)
        XCTAssertEqual(layers?.gradients.count, 1)
        XCTAssertEqual(layers?.imageUri, "data:image/png;base64,iVBORw0KGgo=")
    }

    func testExtractsBareUrl() {
        let layers = CssBackground.parse("url(https://example.com/a.png) center / cover")
        XCTAssertEqual(layers?.imageUri, "https://example.com/a.png")
    }

    // MARK: - Colours and degradation

    func testParsesPlainColour() {
        let layers = CssBackground.parse("#ff0000")
        XCTAssertNotNil(layers?.color)
        XCTAssertTrue(layers?.gradients.isEmpty ?? false)
    }

    func testParsesRgbaWithSpaces() {
        XCTAssertNotNil(CssBackground.parse("rgba(0, 0, 0, 0.25)")?.color)
    }

    func testUnparseableValuesYieldNil() {
        XCTAssertNil(CssBackground.parse("definitely-not-a-colour"))
        XCTAssertNil(CssBackground.parse(""))
        XCTAssertNil(CssBackground.parse(nil))
        XCTAssertNil(CssBackground.parse(42))
    }

    func testNoneIsNotAnError() {
        XCTAssertNil(CssBackground.parse("none"))
    }

    func testMultipleGradientsBothSurvive() {
        let layers = CssBackground.parse(
            "linear-gradient(to top, #111, #222), linear-gradient(to top, #333, #444)"
        )
        XCTAssertEqual(layers?.gradients.count, 2)
        XCTAssertNil(layers?.color)
    }

    // MARK: - Layer order

    func testImageDeclaredFirstPaintsAboveALaterGradient() {
        // CSS paints the FIRST-declared layer on top. paintLayers is stored
        // bottom-first, so the image must come LAST here.
        let layers = CssBackground.parse(
            "url('data:image/png;base64,iVBORw0KGgo='), linear-gradient(to top, #111, #222)"
        )!
        XCTAssertEqual(layers.paintLayers.count, 2)
        if case .gradient = layers.paintLayers[0] {} else { XCTFail("bottom layer should be the gradient") }
        if case .image = layers.paintLayers[1] {} else { XCTFail("top layer should be the image") }
    }

    func testGradientDeclaredFirstPaintsAboveALaterImage() {
        // The home-screen wallpaper's shape: gradient over photo.
        let layers = CssBackground.parse(
            "linear-gradient(to top, #111, #222), url('data:image/png;base64,iVBORw0KGgo=')"
        )!
        XCTAssertEqual(layers.paintLayers.count, 2)
        if case .image = layers.paintLayers[0] {} else { XCTFail("bottom layer should be the image") }
        if case .gradient = layers.paintLayers[1] {} else { XCTFail("top layer should be the gradient") }
    }

    // MARK: - Image decoding

    @MainActor
    func testRemoteUrlDecodesToNothing() {
        // Remote fetching needs an async loader; degrade, never block.
        XCTAssertNil(CssBackground.decodeDataImage("https://example.com/a.png"))
    }

    @MainActor
    func testMalformedDataUriDecodesToNilInsteadOfThrowing() {
        XCTAssertNil(CssBackground.decodeDataImage("data:image/png,notbase64"))
    }

    @MainActor
    func testValidDataUriDecodes() {
        // 1x1 transparent PNG.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
            + "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
        XCTAssertNotNil(CssBackground.decodeDataImage(png))
    }
}
