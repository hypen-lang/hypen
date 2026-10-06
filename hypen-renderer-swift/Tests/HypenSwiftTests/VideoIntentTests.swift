import XCTest
@testable import HypenSwift

/// Renderer-local fullscreen intent — the pure half of `VideoIntents.swift`.
///
/// Contract: `hypen-docs/content/docs/guide/components.mdx`
/// §"Fullscreen: `videoIntent("fullscreen")` (renderer-local)". Parity
/// reference: the DOM handler in
/// `hypen-web/packages/web/src/dom/applicators/events.ts` — it accepts a
/// string equal to `"fullscreen"` and bails on anything else, and it does
/// nothing when the tapped node has no video wrapper above it.
///
/// The SwiftUI half (a `.fullScreenCover` hosting the same container) is
/// presentation only and carries no logic of its own.
@MainActor
final class VideoIntentTests: XCTestCase {

    // MARK: Intent parsing

    func testFullscreenWireNameParses() {
        XCTAssertEqual(VideoIntent.parse("fullscreen"), .fullscreen)
    }

    func testParsingIsExact() {
        // The DOM does `intent !== "fullscreen"` — no trimming, no casing.
        XCTAssertNil(VideoIntent.parse("Fullscreen"))
        XCTAssertNil(VideoIntent.parse("FULLSCREEN"))
        XCTAssertNil(VideoIntent.parse(" fullscreen"))
    }

    func testNonStringsAndUnknownIntentsAreNotIntents() {
        XCTAssertNil(VideoIntent.parse(nil))
        XCTAssertNil(VideoIntent.parse(42))
        XCTAssertNil(VideoIntent.parse(true))
        XCTAssertNil(VideoIntent.parse(["fullscreen"]))
        // Unknown intents are inert, not errors: the contract promises the
        // prop can be authored everywhere today.
        XCTAssertNil(VideoIntent.parse("pip"))
        XCTAssertNil(VideoIntent.parse(""))
    }

    /// `getStringProp` stringifies whatever it finds; the intent parser must
    /// not, or `videoIntent: 1` would become the string "1" to parse (and,
    /// worse, a future numeric wire value could alias an intent name).
    func testParsingDoesNotStringifyNonStrings() {
        let element = HypenElement(
            id: "1", elementType: "button",
            props: ["videoIntent.0": 1]
        )
        XCTAssertNil(VideoIntent.from(element))
    }

    // MARK: Prop lookup

    func testApplicatorWireFormIsRead() {
        // `.videoIntent("fullscreen")` lowers to `videoIntent.0`.
        let element = HypenElement(
            id: "1", elementType: "button",
            props: ["videoIntent.0": "fullscreen"]
        )
        XCTAssertEqual(VideoIntent.from(element), .fullscreen)
    }

    func testBarePropFormIsRead() {
        let element = HypenElement(
            id: "1", elementType: "button",
            props: ["videoIntent": "fullscreen"]
        )
        XCTAssertEqual(VideoIntent.from(element), .fullscreen)
    }

    func testApplicatorFormWinsOverBareForm() {
        let element = HypenElement(
            id: "1", elementType: "button",
            props: ["videoIntent.0": "fullscreen", "videoIntent": "pip"]
        )
        XCTAssertEqual(VideoIntent.from(element), .fullscreen)
    }

    func testElementWithoutThePropHasNoIntent() {
        let element = HypenElement(
            id: "1", elementType: "button",
            props: ["slot.0": "controls"]
        )
        XCTAssertNil(VideoIntent.from(element))
    }

    // MARK: Toggle state machine

    func testIntentTogglesFullscreenOnAndBackOff() {
        // The same button is the way in and the way out (the contract's
        // example ships exactly one fullscreen control).
        let entered = VideoFullscreenPresentation.next(
            current: false, intent: .fullscreen, insideVideo: true
        )
        XCTAssertTrue(entered)
        XCTAssertFalse(
            VideoFullscreenPresentation.next(
                current: entered, intent: .fullscreen, insideVideo: true
            )
        )
    }

    func testIntentIsInertOutsideAVideoSubtree() {
        // No enclosing Video means no container to fullscreen — the DOM
        // walks up looking for the video wrapper and returns when it finds
        // none; here the environment handle is simply nil.
        XCTAssertFalse(
            VideoFullscreenPresentation.next(
                current: false, intent: .fullscreen, insideVideo: false
            )
        )
        XCTAssertTrue(
            VideoFullscreenPresentation.next(
                current: true, intent: .fullscreen, insideVideo: false
            )
        )
    }

    func testAbsentIntentNeverChangesThePresentation() {
        XCTAssertFalse(
            VideoFullscreenPresentation.next(
                current: false, intent: nil, insideVideo: true
            )
        )
        XCTAssertTrue(
            VideoFullscreenPresentation.next(
                current: true, intent: nil, insideVideo: true
            )
        )
    }

    func testTogglingIsAClosedCycle() {
        // Presentation-only: no accumulating state, N taps land on N % 2.
        var fullscreen = false
        for _ in 0..<5 {
            fullscreen = VideoFullscreenPresentation.next(
                current: fullscreen, intent: .fullscreen, insideVideo: true
            )
        }
        XCTAssertTrue(fullscreen)
        fullscreen = VideoFullscreenPresentation.next(
            current: fullscreen, intent: .fullscreen, insideVideo: true
        )
        XCTAssertFalse(fullscreen)
    }

    // MARK: Controller

    func testControllerTogglesAndIsIdempotentInPairs() {
        let controller = VideoFullscreenController()
        XCTAssertFalse(controller.isFullscreen)
        controller.handle(.fullscreen)
        XCTAssertTrue(controller.isFullscreen)
        controller.handle(.fullscreen)
        XCTAssertFalse(controller.isFullscreen)
    }

    /// A system dismissal (the cover's interactive swipe) writes through the
    /// same flag, so the next tap on the intent button enters again rather
    /// than toggling a stale `true` back to `false`.
    func testExternalDismissalIsHonoured() {
        let controller = VideoFullscreenController()
        controller.handle(.fullscreen)
        controller.isFullscreen = false
        controller.handle(.fullscreen)
        XCTAssertTrue(controller.isFullscreen)
    }
}
