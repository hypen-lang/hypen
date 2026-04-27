import Testing
@testable import HypenSwift

// MARK: - ActionValue.from Tests

@Test func testActionValueFromSimpleActionString() {
    let action = ActionValue.from("@actions.submit")

    #expect(action != nil)
    #expect(action?.actionName == "submit")
    #expect(action?.payload.isEmpty == true)
}

@Test func testActionValueFromPlainString() {
    let action = ActionValue.from("doSomething")

    #expect(action != nil)
    #expect(action?.actionName == "doSomething")
    #expect(action?.payload.isEmpty == true)
}

@Test func testActionValueFromDictWithActionKeyAndExplicitPayload() {
    let action = ActionValue.from([
        "action": "@actions.login",
        "payload": ["username": "test", "password": "secret"]
    ] as [String: Any])

    #expect(action != nil)
    #expect(action?.actionName == "login")
    #expect(action?.payload["username"] as? String == "test")
    #expect(action?.payload["password"] as? String == "secret")
}

@Test func testActionValueFromDictWithActionKeyAndImplicitPayload() {
    let action = ActionValue.from([
        "action": "@actions.update",
        "field": "email",
        "value": "test@example.com"
    ] as [String: Any])

    #expect(action != nil)
    #expect(action?.actionName == "update")
    #expect(action?.payload["field"] as? String == "email")
    #expect(action?.payload["value"] as? String == "test@example.com")
}

@Test func testActionValueFromDictWithActionNameKey() {
    let action = ActionValue.from([
        "actionName": "refresh",
        "force": true
    ] as [String: Any])

    #expect(action != nil)
    #expect(action?.actionName == "refresh")
    #expect(action?.payload["force"] as? Bool == true)
}

@Test func testActionValueFromDictWithActionNameKeyAndExplicitPayload() {
    let action = ActionValue.from([
        "actionName": "save",
        "payload": ["id": 42]
    ] as [String: Any])

    #expect(action != nil)
    #expect(action?.actionName == "save")
    #expect(action?.payload["id"] as? Int == 42)
}

@Test func testActionValueFromDictWithoutActionKey() {
    let action = ActionValue.from([
        "name": "not-an-action",
        "value": 123
    ] as [String: Any])

    #expect(action == nil)
}

@Test func testActionValueFromNil() {
    let action = ActionValue.from(nil)
    #expect(action == nil)
}

@Test func testActionValueFromNonStringNonDict() {
    let action = ActionValue.from(42)
    #expect(action == nil)
}

@Test func testActionValueFromActionStringWithoutPrefix() {
    // Dictionary "action" key without @actions. prefix
    let action = ActionValue.from([
        "action": "plainName"
    ] as [String: Any])

    #expect(action != nil)
    #expect(action?.actionName == "plainName")
}
