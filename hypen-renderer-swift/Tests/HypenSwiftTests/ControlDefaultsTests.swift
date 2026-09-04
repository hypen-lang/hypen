import CoreGraphics
import Testing
@testable import HypenSwift

@Suite("Control defaults")
struct ControlDefaultsTests {
    private func audio(_ props: [String: Any] = [:]) -> HypenElement {
        HypenElement(id: "audio", elementType: "audio", props: props, children: [])
    }

    @Test func audioControlsAreVisibleByDefaultAndExplicitFalseIsHonored() {
        #expect(audioControlsVisible(audio()))
        #expect(audioControlsVisible(audio(["controls": true])))
        #expect(!audioControlsVisible(audio(["controls": false])))
        #expect(!audioControlsVisible(audio(["controls.0": false])))
    }

    @Test func checkboxVisualFootprintIsTwentyPoints() {
        #expect(hypenCheckboxMetric == 20)
    }

    @Test func selectUsesDeclarativeTextChildrenAndDefaultsToTheFirstOption() {
        let children = [
            HypenElement(id: "one", elementType: "Text", props: ["0": "Option 1"], children: []),
            HypenElement(id: "ignored", elementType: "Icon", props: ["0": "No"], children: []),
            HypenElement(id: "two", elementType: "Text", props: ["text": "Option 2"], children: []),
        ]
        let options = selectChildOptions(children)

        #expect(options.count == 2)
        #expect(options[0]["label"] as? String == "Option 1")
        #expect(resolvedSelectInitialValue(nil, options: options) == "Option 1")
        #expect(resolvedSelectInitialValue("Option 2", options: options) == "Option 2")
    }
}
