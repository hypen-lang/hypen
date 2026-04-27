import XCTest
@testable import HypenServer

final class AppBuilderTests: XCTestCase {
    func testBasicBuild() {
        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        XCTAssertEqual(def.initialState["count"] as? Int, 0)
        XCTAssertTrue(def.actions.contains("increment"))
        XCTAssertTrue(def.stateKeys.contains("count"))
    }

    func testUIBuilder() {
        let def = AppBuilder(["text": "hello"])
            .ui("Text(\"@{state.text}\")")

        XCTAssertEqual(def.ui, "Text(\"@{state.text}\")")
        XCTAssertEqual(def.initialState["text"] as? String, "hello")
    }

    func testLifecycleHandlers() {
        let createdCalled = TestCounter(false)
        let destroyedCalled = TestCounter(false)

        let def = AppBuilder(["x": 1])
            .onCreated { _ in createdCalled.set(true) }
            .onDestroyed { _ in destroyedCalled.set(true) }
            .build()
        _ = createdCalled
        _ = destroyedCalled

        XCTAssertNotNil(def.onCreated)
        XCTAssertNotNil(def.onDestroyed)
    }

    func testHypenAppRegistry() {
        let testApp = HypenApp()

        let _ = testApp.module("TestModule")
            .defineState(["count": 0])
            .build()

        XCTAssertTrue(testApp.has("TestModule"))
        XCTAssertNotNil(testApp.get("TestModule"))
        XCTAssertEqual(testApp.size, 1)

        testApp.unregister("TestModule")
        XCTAssertFalse(testApp.has("TestModule"))
    }

    func testModuleInstance() {
        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        XCTAssertEqual(instance.getState()["count"] as? Int, 0)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 2)
    }

    func testModuleInstanceDestroy() {
        let destroyed = TestCounter(false)

        let def = AppBuilder(["x": 0])
            .onDestroyed { _ in destroyed.set(true) }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.destroy()
        XCTAssertTrue(destroyed.current)

        // Double destroy should be safe
        instance.destroy()
    }

    func testBindAction() {
        let def = AppBuilder(["name": ""])
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("__hypen_bind", payload: ["path": "name", "value": "Alice"])
        XCTAssertEqual(instance.getState()["name"] as? String, "Alice")
    }

    // MARK: - Typed Action Tests

    func testTypedActionWithCodablePayload() {
        struct AddPayload: Codable {
            let amount: Int
        }

        let def = AppBuilder(["count": 0])
            .onAction("add", payloadType: AddPayload.self) { ctx, payload in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + (payload?.amount ?? 0))
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("add", payload: ["amount": 5])
        XCTAssertEqual(instance.getState()["count"] as? Int, 5)

        instance.dispatchAction("add", payload: ["amount": 3])
        XCTAssertEqual(instance.getState()["count"] as? Int, 8)
    }

    func testTypedActionWithNilPayload() {
        struct Payload: Codable {
            let value: String
        }

        let handlerCalled = TestCounter(false)
        let def = AppBuilder(["x": 0])
            .onAction("test", payloadType: Payload.self) { _, payload in
                handlerCalled.set(true)
                XCTAssertNil(payload)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("test")
        XCTAssertTrue(handlerCalled.current)
    }

    // MARK: - Async Action Tests

    func testAsyncAction() {
        let expectation = XCTestExpectation(description: "Async action completed")

        let def = AppBuilder(["count": 0])
            .onActionAsync("asyncIncrement") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
                expectation.fulfill()
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("asyncIncrement")

        wait(for: [expectation], timeout: 2.0)
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)
    }

    func testAsyncTypedAction() {
        let expectation = XCTestExpectation(description: "Async typed action completed")

        struct SetPayload: Codable {
            let value: Int
        }

        let def = AppBuilder(["count": 0])
            .onActionAsync("set", payloadType: SetPayload.self) { ctx, payload in
                if let payload = payload {
                    ctx.state.set("count", payload.value)
                }
                expectation.fulfill()
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("set", payload: ["value": 42])

        wait(for: [expectation], timeout: 2.0)
        XCTAssertEqual(instance.getState()["count"] as? Int, 42)
    }

    // MARK: - Session Lifecycle Hooks

    func testDisconnectHandler() {
        let disconnectCalled = TestCounter(false)
        let receivedSessionId = TestCounter("")

        let def = AppBuilder(["count": 0])
            .onDisconnect { state, session in
                disconnectCalled.set(true)
                receivedSessionId.set(session.id)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        let session = SessionInfo(id: "test-session-1")
        instance.handleDisconnect(session: session)

        XCTAssertTrue(disconnectCalled.current)
        XCTAssertEqual(receivedSessionId.current, "test-session-1")
    }

    func testReconnectHandler() {
        let reconnectCalled = TestCounter(false)

        let def = AppBuilder(["count": 0])
            .onReconnect { session, restore in
                reconnectCalled.set(true)
                restore(["count": 99])
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        let session = SessionInfo(id: "test-session-2")
        instance.handleReconnect(session: session, savedState: ["count": 42])

        XCTAssertTrue(reconnectCalled.current)
        XCTAssertEqual(instance.getState()["count"] as? Int, 99)
    }

    func testExpireHandler() {
        let expireCalled = TestCounter(false)
        let expiredSessionId = TestCounter("")

        let def = AppBuilder(["x": 0])
            .onExpire { session in
                expireCalled.set(true)
                expiredSessionId.set(session.id)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.handleExpire(session: SessionInfo(id: "expired-1"))

        XCTAssertTrue(expireCalled.current)
        XCTAssertEqual(expiredSessionId.current, "expired-1")
    }

    // MARK: - Error Handler

    func testErrorHandler() {
        let errorHandled = TestCounter(false)

        let def = AppBuilder(["x": 0])
            .onError { ctx in
                errorHandled.set(true)
                XCTAssertNotNil(ctx.error)
                return .handled
            }
            .build()

        XCTAssertNotNil(def.onError)
        _ = errorHandled
    }

    // MARK: - Multiple Actions

    func testMultipleActions() {
        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .onAction("decrement") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count - 1)
            }
            .onAction("reset") { ctx in
                ctx.state.set("count", 0)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction("increment")
        instance.dispatchAction("increment")
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 3)

        instance.dispatchAction("decrement")
        XCTAssertEqual(instance.getState()["count"] as? Int, 2)

        instance.dispatchAction("reset")
        XCTAssertEqual(instance.getState()["count"] as? Int, 0)
    }

    // MARK: - Destroyed instance ignores actions

    func testDestroyedInstanceIgnoresActions() {
        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.destroy()

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1) // Should not change
    }
}
