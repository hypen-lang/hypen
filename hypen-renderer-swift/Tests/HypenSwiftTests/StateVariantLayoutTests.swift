import SwiftUI
import Testing
@testable import HypenSwift

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// An element with a state variant (`active:bg-*`, `hover:*`, responsive
/// `md:*`) renders through `VariantAwareView`. The component handler applies
/// the modifier itself, so the variant path must hand it the effective
/// modifier rather than apply a second copy on top — otherwise padding,
/// background and borders land twice. The scaffold's Counter row
/// (`Button { Text("Reset") }.tw("px-6 py-3 active:bg-gray-700")`) rendered
/// its labels one letter per line on iOS and macOS.
@Suite("State variants keep the element's box")
struct StateVariantLayoutTests {
    @MainActor
    private func counterRow(buttonExtras: [String: Any]) -> HypenRenderer {
        let renderer = HypenRenderer()
        var patches: [Patch] = [
            Patch(type: .create, id: "row", elementType: "Row", props: ["gap.0": "1rem"]),
        ]
        for (id, label) in [("minus", "-"), ("reset", "Reset"), ("plus", "+")] {
            var props: [String: Any] = [
                "backgroundColor.0": "#4b5563",
                "borderRadius.0": "0.5rem",
                "paddingLeft.0": "1.5rem",
                "paddingRight.0": "1.5rem",
                "paddingTop.0": "0.75rem",
                "paddingBottom.0": "0.75rem",
                "onClick.0": "@\(id)",
            ]
            props.merge(buttonExtras) { _, extra in extra }
            patches += [
                Patch(type: .create, id: id, elementType: "Button", props: props),
                Patch(type: .insert, id: id, parentId: "row"),
                Patch(type: .create, id: "\(id)-label", elementType: "Text", props: [
                    "0": label,
                    "fontWeight.0": "600",
                ]),
                Patch(type: .insert, id: "\(id)-label", parentId: id),
            ]
        }
        renderer.applyPatches(patches)
        return renderer
    }

    @MainActor
    private func fittingSize(_ renderer: HypenRenderer, id: String) -> CGSize {
        let view = HypenElementView(
            elementId: id,
            renderer: renderer,
            actionDispatcher: MockActionDispatcher()
        )
        #if os(macOS)
        return NSHostingView(rootView: view).fittingSize
        #elseif canImport(UIKit)
        return UIHostingController(rootView: view)
            .sizeThatFits(in: CGSize(width: 10_000, height: 10_000))
        #else
        return .zero
        #endif
    }

    @Test @MainActor func activeBackgroundVariantDoesNotChangeTheRowSize() {
        let plain = fittingSize(counterRow(buttonExtras: [:]), id: "row")
        let withActive = fittingSize(
            counterRow(buttonExtras: ["backgroundColor:active.0": "#374151"]),
            id: "row"
        )
        #expect(plain.width > 0)
        #expect(abs(withActive.width - plain.width) < 1)
        #expect(abs(withActive.height - plain.height) < 1)
    }

    @Test @MainActor func activeVariantButtonKeepsItsPaddedLabelBox() {
        let plain = fittingSize(counterRow(buttonExtras: [:]), id: "reset")
        let withActive = fittingSize(
            counterRow(buttonExtras: ["backgroundColor:active.0": "#374151"]),
            id: "reset"
        )
        // 24pt horizontal padding on each side, applied once.
        #expect(abs(withActive.width - plain.width) < 1)
        #expect(abs(withActive.height - plain.height) < 1)
    }
}
