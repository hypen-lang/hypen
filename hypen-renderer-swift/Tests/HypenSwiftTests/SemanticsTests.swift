import Testing
@testable import HypenSwift

// MARK: - HypenSemantics parsing

@Test func testSemanticsParsesFromWireDictionary() {
    let dict: [String: Any] = [
        "role": "button",
        "name": "Delete",
        "nameExplicit": true,
        "description": "This cannot be undone",
        "expanded": false,
        "id": "btn-1",
        "controls": "panel-1",
    ]
    let sem = HypenSemantics.from(dictionary: dict)
    #expect(sem != nil)
    #expect(sem?.role == "button")
    #expect(sem?.name == "Delete")
    #expect(sem?.nameExplicit == true)
    #expect(sem?.description == "This cannot be undone")
    #expect(sem?.expanded == false)
    #expect(sem?.id == "btn-1")
    #expect(sem?.controls == "panel-1")
}

@Test func testSemanticsNilForMissingBlock() {
    #expect(HypenSemantics.from(dictionary: nil) == nil)
}

@Test func testSemanticsLevelAcceptsDoubleEncoding() {
    // JSON numbers may decode as Double; level must still parse.
    let sem = HypenSemantics.from(dictionary: ["role": "heading", "level": 2.0])
    #expect(sem?.level == 2)
}

// MARK: - Patch decoding

@Test func testPatchFromSetSemanticsDictionary() {
    let dict: [String: Any] = [
        "type": "setSemantics",
        "id": "el-1",
        "semantics": ["role": "button", "expanded": true],
    ]
    let patch = Patch.from(dictionary: dict)
    #expect(patch != nil)
    #expect(patch?.type == .setSemantics)
    #expect(patch?.id == "el-1")
    #expect(patch?.semantics?["role"] as? String == "button")
}

@Test func testPatchFromCreateCarriesSemantics() {
    let dict: [String: Any] = [
        "type": "create",
        "id": "el-2",
        "elementType": "Button",
        "props": [:],
        "semantics": ["role": "button", "name": "Save"],
    ]
    let patch = Patch.from(dictionary: dict)
    #expect(patch?.semantics?["name"] as? String == "Save")
}

@Test func testPatchFromClearingSetSemantics() {
    // A clearing re-emit has no semantics key at all.
    let dict: [String: Any] = ["type": "setSemantics", "id": "el-3"]
    let patch = Patch.from(dictionary: dict)
    #expect(patch?.type == .setSemantics)
    #expect(patch?.semantics == nil)
}

// MARK: - Renderer application

@Test @MainActor func testCreateStoresSemanticsAndSetSemanticsReplacesThem() {
    let renderer = HypenRenderer()
    renderer.applyPatches([
        Patch(
            type: .create,
            id: "btn",
            elementType: "Button",
            props: [:],
            semantics: ["role": "button", "name": "Menu", "expanded": false]
        ),
        Patch(type: .insert, id: "btn", parentId: "root"),
    ])
    #expect(renderer.getElement("btn")?.semantics?.expanded == false)
    #expect(renderer.getElement("btn")?.semantics?.name == "Menu")

    // Reactive re-emit flips the state.
    renderer.applyPatches([
        Patch(
            type: .setSemantics,
            id: "btn",
            semantics: ["role": "button", "name": "Menu", "expanded": true]
        )
    ])
    #expect(renderer.getElement("btn")?.semantics?.expanded == true)

    // Clearing re-emit drops the block entirely.
    renderer.applyPatches([Patch(type: .setSemantics, id: "btn")])
    #expect(renderer.getElement("btn")?.semantics == nil)
}

// MARK: - Translation decisions (pure logic)

@Test func testExplicitNameWinsDerivedNameDropped() {
    let explicit = HypenSemantics.from(dictionary: [
        "role": "button", "name": "Close dialog", "nameExplicit": true,
    ])!
    let derived = HypenSemantics.from(dictionary: [
        "role": "button", "name": "Save",
    ])!
    let img = HypenSemantics.from(dictionary: [
        "role": "img", "name": "A cat",
    ])!

    #expect(SemanticsLabelModifier(semantics: explicit).effectiveLabel == "Close dialog")
    // Derived names on text-bearing controls stay with the visible content.
    #expect(SemanticsLabelModifier(semantics: derived).effectiveLabel == nil)
    // Image alt has no visible text to derive from → applied.
    #expect(SemanticsLabelModifier(semantics: img).effectiveLabel == "A cat")
}

@Test func testStateDescriptionPrecedence() {
    let checked = HypenSemantics.from(dictionary: ["role": "checkbox", "checked": true])!
    #expect(SemanticsValueModifier(semantics: checked).stateDescription == "checked")

    let collapsed = HypenSemantics.from(dictionary: ["role": "button", "expanded": false])!
    #expect(SemanticsValueModifier(semantics: collapsed).stateDescription == "collapsed")

    let current = HypenSemantics.from(dictionary: ["current": "page"])!
    #expect(SemanticsValueModifier(semantics: current).stateDescription == "current page")

    let none = HypenSemantics.from(dictionary: ["role": "button"])!
    #expect(SemanticsValueModifier(semantics: none).stateDescription == nil)
}
