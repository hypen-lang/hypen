import Testing
@testable import HypenSwift

// MARK: - MockActionDispatcher Tests

@Test func testMockDispatcherRecordsSingleAction() {
    let mock = MockActionDispatcher()

    mock.dispatch(action: "submit", payload: ["key": "value"])

    #expect(mock.dispatchedActions.count == 1)
    #expect(mock.dispatchedActions[0].action == "submit")
    #expect(mock.dispatchedActions[0].payload?["key"] as? String == "value")
}

@Test func testMockDispatcherRecordsMultipleActions() {
    let mock = MockActionDispatcher()

    mock.dispatch(action: "first", payload: nil)
    mock.dispatch(action: "second", payload: ["x": 1])
    mock.dispatch(action: "third", payload: nil)

    #expect(mock.dispatchedActions.count == 3)
    #expect(mock.dispatchedActions[0].action == "first")
    #expect(mock.dispatchedActions[1].action == "second")
    #expect(mock.dispatchedActions[2].action == "third")
}

@Test func testMockDispatcherNilPayload() {
    let mock = MockActionDispatcher()

    mock.dispatch(action: "test", payload: nil)

    #expect(mock.dispatchedActions.count == 1)
    #expect(mock.dispatchedActions[0].payload == nil)
}

@Test func testMockDispatcherClear() {
    let mock = MockActionDispatcher()

    mock.dispatch(action: "a", payload: nil)
    mock.dispatch(action: "b", payload: nil)

    #expect(mock.dispatchedActions.count == 2)

    mock.clear()

    #expect(mock.dispatchedActions.isEmpty == true)
}

@Test func testRemoteEngineErrorDescriptions() {
    let invalidURL = RemoteEngineError.invalidURL("bad://url")
    #expect(invalidURL.errorDescription == "Invalid URL: bad://url")

    let connectionFailed = RemoteEngineError.connectionFailed("timeout")
    #expect(connectionFailed.errorDescription == "Connection failed: timeout")

    let parseFailed = RemoteEngineError.messageParseFailed
    #expect(parseFailed.errorDescription == "Failed to parse message")
}
