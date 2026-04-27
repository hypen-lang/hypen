import Testing
@testable import HypenSwift

// MARK: - HypenElement Property Accessor Tests

@Test func testGetStringPropReturnsString() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["label": "Hello"]
    )

    #expect(element.getStringProp("label") == "Hello")
}

@Test func testGetStringPropConvertsNonString() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["count": 42]
    )

    let result = element.getStringProp("count")
    #expect(result != nil)
    #expect(result == "42")
}

@Test func testGetStringPropReturnsNilForMissing() {
    let element = HypenElement(id: "1", elementType: "text")

    #expect(element.getStringProp("missing") == nil)
}

@Test func testGetIntPropReturnsInt() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["count": 42]
    )

    #expect(element.getIntProp("count") == 42)
}

@Test func testGetIntPropConvertsFromDouble() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["value": 3.7]
    )

    #expect(element.getIntProp("value") == 3)
}

@Test func testGetIntPropConvertsFromString() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["value": "99"]
    )

    #expect(element.getIntProp("value") == 99)
}

@Test func testGetDoublePropReturnsDouble() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["opacity": 0.75]
    )

    #expect(element.getDoubleProp("opacity") == 0.75)
}

@Test func testGetDoublePropConvertsFromInt() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["size": 16]
    )

    #expect(element.getDoubleProp("size") == 16.0)
}

@Test func testGetDoublePropConvertsFromString() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["ratio": "1.5"]
    )

    #expect(element.getDoubleProp("ratio") == 1.5)
}

@Test func testGetBoolPropReturnsBool() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["enabled": true]
    )

    #expect(element.getBoolProp("enabled") == true)
}

@Test func testGetBoolPropConvertsFromString() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["active": "true", "on": "1", "off": "false"]
    )

    #expect(element.getBoolProp("active") == true)
    #expect(element.getBoolProp("on") == true)
    #expect(element.getBoolProp("off") == false)
}

@Test func testGetScrollableBoolTrue() {
    let el = HypenElement(id: "1", elementType: "row", props: ["scrollable.0": true])
    let s = el.getScrollable()
    #expect(s.enabled == true)
    #expect(s.axis == nil)
}

@Test func testGetScrollableStringHorizontal() {
    // Regression: `.scrollable("horizontal")` on a Row used to return
    // false via getBoolProp (string "horizontal" is neither "true"
    // nor "1"), so the Stories carousel rendered without its ScrollView.
    let el = HypenElement(id: "1", elementType: "row", props: ["scrollable.0": "horizontal"])
    let s = el.getScrollable()
    #expect(s.enabled == true)
    #expect(s.axis == .horizontal)
}

@Test func testGetScrollableStringVertical() {
    let el = HypenElement(id: "1", elementType: "column", props: ["scrollable.0": "vertical"])
    let s = el.getScrollable()
    #expect(s.enabled == true)
    #expect(s.axis == .vertical)
}

@Test func testGetScrollableStringBoth() {
    let el = HypenElement(id: "1", elementType: "row", props: ["scrollable.0": "both"])
    let s = el.getScrollable()
    #expect(s.enabled == true)
    #expect(s.axis == .both)
}

@Test func testGetScrollableStringFalse() {
    let el = HypenElement(id: "1", elementType: "row", props: ["scrollable.0": "none"])
    let s = el.getScrollable()
    #expect(s.enabled == false)
    #expect(s.axis == nil)
}

@Test func testGetScrollableMissingDefault() {
    let el = HypenElement(id: "1", elementType: "row", props: [:])
    let s = el.getScrollable()
    #expect(s.enabled == false)
    #expect(s.axis == nil)
}

@Test func testGetBoolPropConvertsFromInt() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["yes": 1, "no": 0]
    )

    #expect(element.getBoolProp("yes") == true)
    #expect(element.getBoolProp("no") == false)
}

@Test func testGetCGFloatPropConvertsFromDouble() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["width": 100.5]
    )

    #expect(element.getCGFloatProp("width") == 100.5)
}

@Test func testAddChildAppends() {
    let element = HypenElement(id: "parent", elementType: "column")

    element.addChild("c1")
    element.addChild("c2")

    #expect(element.children == ["c1", "c2"])
}

@Test func testAddChildBeforeId() {
    let element = HypenElement(
        id: "parent", elementType: "column",
        children: ["c1", "c3"]
    )

    element.addChild("c2", beforeId: "c3")

    #expect(element.children == ["c1", "c2", "c3"])
}

@Test func testRemoveChild() {
    let element = HypenElement(
        id: "parent", elementType: "column",
        children: ["c1", "c2", "c3"]
    )

    element.removeChild("c2")

    #expect(element.children == ["c1", "c3"])
}

@Test func testSetPropSetsValue() {
    let element = HypenElement(id: "1", elementType: "text")

    element.setProp("color", value: "red")

    #expect(element.getStringProp("color") == "red")
}

@Test func testSetPropWithNilRemovesProp() {
    let element = HypenElement(
        id: "1", elementType: "text",
        props: ["color": "red"]
    )

    element.setProp("color", value: nil)

    #expect(element.getStringProp("color") == nil)
}
