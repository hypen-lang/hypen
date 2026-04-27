import Testing
@testable import HypenSwift

// MARK: - Patch.from(dictionary:) Tests

@Test func testPatchFromCreateDictionary() {
    let dict: [String: Any] = [
        "type": "Create",
        "id": "el-1",
        "elementType": "column",
        "props": ["gap.0": 16, "padding.0": 8]
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .create)
    #expect(patch?.id == "el-1")
    #expect(patch?.elementType == "column")
    #expect(patch?.props?["gap.0"] as? Int == 16)
}

@Test func testPatchFromSetPropDictionary() {
    let dict: [String: Any] = [
        "type": "SetProp",
        "id": "el-1",
        "name": "text",
        "value": "Hello World"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .setProp)
    #expect(patch?.id == "el-1")
    #expect(patch?.name == "text")
    #expect(patch?.value as? String == "Hello World")
}

@Test func testPatchFromSetTextDictionary() {
    let dict: [String: Any] = [
        "type": "SetText",
        "id": "el-1",
        "text": "Updated text"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .setText)
    #expect(patch?.text == "Updated text")
}

@Test func testPatchFromInsertDictionary() {
    let dict: [String: Any] = [
        "type": "Insert",
        "id": "child-1",
        "parentId": "root",
        "beforeId": "child-2"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .insert)
    #expect(patch?.id == "child-1")
    #expect(patch?.parentId == "root")
    #expect(patch?.beforeId == "child-2")
}

@Test func testPatchFromMoveDictionary() {
    let dict: [String: Any] = [
        "type": "Move",
        "id": "el-1",
        "parentId": "new-parent"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .move)
    #expect(patch?.parentId == "new-parent")
}

@Test func testPatchFromRemoveDictionary() {
    let dict: [String: Any] = [
        "type": "Remove",
        "id": "el-1"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .remove)
    #expect(patch?.id == "el-1")
}

@Test func testPatchFromAttachEventDictionary() {
    let dict: [String: Any] = [
        "type": "AttachEvent",
        "id": "btn-1",
        "eventName": "onClick"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .attachEvent)
    #expect(patch?.eventName == "onClick")
}

@Test func testPatchFromDetachEventDictionary() {
    let dict: [String: Any] = [
        "type": "DetachEvent",
        "id": "btn-1",
        "eventName": "onClick"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .detachEvent)
    #expect(patch?.eventName == "onClick")
}

@Test func testPatchFromCaseInsensitiveType() {
    let dict: [String: Any] = [
        "type": "create",
        "id": "el-1",
        "elementType": "text"
    ]

    let patch = Patch.from(dictionary: dict)

    #expect(patch != nil)
    #expect(patch?.type == .create)
}

@Test func testPatchFromUnknownType() {
    let dict: [String: Any] = [
        "type": "Unknown",
        "id": "el-1"
    ]

    let patch = Patch.from(dictionary: dict)
    #expect(patch == nil)
}

@Test func testPatchFromArrayMultiple() {
    let array: [[String: Any]] = [
        ["type": "Create", "id": "el-1", "elementType": "column"],
        ["type": "Create", "id": "el-2", "elementType": "text"],
        ["type": "Insert", "id": "el-2", "parentId": "el-1"]
    ]

    let patches = Patch.fromArray(array)

    #expect(patches.count == 3)
    #expect(patches[0].type == .create)
    #expect(patches[1].type == .create)
    #expect(patches[2].type == .insert)
}

@Test func testPatchFromArrayFiltersInvalid() {
    let array: [[String: Any]] = [
        ["type": "Create", "id": "el-1", "elementType": "column"],
        ["type": "BadType", "id": "el-2"],
        ["type": "Remove", "id": "el-3"]
    ]

    let patches = Patch.fromArray(array)

    #expect(patches.count == 2)
    #expect(patches[0].type == .create)
    #expect(patches[1].type == .remove)
}
