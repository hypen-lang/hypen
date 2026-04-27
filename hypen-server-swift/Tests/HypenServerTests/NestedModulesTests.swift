import XCTest
@testable import HypenServer

final class NestedModulesTests: XCTestCase {

    // MARK: - Basic Creation

    func testCreateNestedModuleInstances() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        testApp.module("Profile")
            .defineState(["name": "Alice"])
            .build()

        let instances = createNestedModuleInstances(app: testApp, globalContext: ctx)

        XCTAssertEqual(instances.count, 2)
        XCTAssertTrue(ctx.hasModule("counter"))
        XCTAssertTrue(ctx.hasModule("profile"))
    }

    // MARK: - Registration in GlobalContext

    func testRegistrationInGlobalContext() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        let _ = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Verify the module is accessible via GlobalContext
        let ref = ctx.getModule("counter")
        XCTAssertNotNil(ref)
        XCTAssertEqual(ref?.id, "counter")
        XCTAssertEqual(ref?.getState()["count"] as? Int, 0)
    }

    // MARK: - Cross-Module State Access

    func testCrossModuleStateAccess() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 5])
            .build()

        testApp.module("Profile")
            .defineState(["name": "Bob"])
            .build()

        let _ = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Access state from each module via global context
        let globalState = ctx.getGlobalState()
        let counterState = globalState["counter"] as? [String: Any]
        let profileState = globalState["profile"] as? [String: Any]

        XCTAssertEqual(counterState?["count"] as? Int, 5)
        XCTAssertEqual(profileState?["name"] as? String, "Bob")
    }

    // MARK: - Cross-Module Action Dispatch

    func testCrossModuleActionDispatch() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()

        let _ = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Dispatch action via global context reference
        let ref = ctx.getModule("counter")!
        ref.dispatchAction("increment")
        ref.dispatchAction("increment")

        XCTAssertEqual(ref.getState()["count"] as? Int, 2)
    }

    // MARK: - Lifecycle

    func testOnCreatedCalledDuringInstantiation() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()
        let createdCalled = TestCounter(false)

        testApp.module("Lifecycle")
            .defineState(["x": 0])
            .onCreated { _ in createdCalled.set(true) }
            .build()

        let _ = createNestedModuleInstances(app: testApp, globalContext: ctx)

        XCTAssertTrue(createdCalled.current)
    }

    func testDestroyNestedModuleInstances() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()
        let destroyedCalled = TestCounter(false)

        testApp.module("Lifecycle")
            .defineState(["x": 0])
            .onDestroyed { _ in destroyedCalled.set(true) }
            .build()

        let instances = createNestedModuleInstances(app: testApp, globalContext: ctx)
        XCTAssertTrue(ctx.hasModule("lifecycle"))

        destroyNestedModuleInstances(instances, globalContext: ctx)

        XCTAssertTrue(destroyedCalled.current)
        XCTAssertFalse(ctx.hasModule("lifecycle"))
    }

    // MARK: - Skip Already-Instantiated Modules

    func testSkipsAlreadyRegisteredModules() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 0])
            .build()

        // Pre-register a module with the same ID
        let existingDef = AppBuilder(["count": 99]).build()
        let existingInstance = try! ModuleInstance(definition: existingDef)
        ctx.registerModule("counter", instance: existingInstance)

        let instances = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Should skip the already-registered module
        XCTAssertEqual(instances.count, 0)

        // Original instance state should be unchanged
        let ref = ctx.getModule("counter")!
        XCTAssertEqual(ref.getState()["count"] as? Int, 99)
    }

    // MARK: - Skip Stateless Modules

    func testSkipsStatelessModules() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        // Module with no state, no handlers
        testApp.module("Empty")
            .defineState([:])
            .build()

        // Module with state
        testApp.module("Stateful")
            .defineState(["x": 1])
            .build()

        let instances = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Only the stateful module should be created
        XCTAssertEqual(instances.count, 1)
        XCTAssertNotNil(instances["Stateful"])
        XCTAssertNil(instances["Empty"])
        XCTAssertFalse(ctx.hasModule("empty"))
        XCTAssertTrue(ctx.hasModule("stateful"))
    }

    // MARK: - Module With Only Action Handlers (No State)

    func testModuleWithOnlyActionHandlersIsCreated() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("ActionOnly")
            .defineState([:])
            .onAction("doSomething") { _ in }
            .build()

        let instances = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Has an action handler, so should be created
        XCTAssertEqual(instances.count, 1)
        XCTAssertTrue(ctx.hasModule("actiononly"))
    }

    // MARK: - Multiple Calls Are Idempotent

    func testMultipleCallsAreIdempotent() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        testApp.module("Counter")
            .defineState(["count": 0])
            .build()

        let first = createNestedModuleInstances(app: testApp, globalContext: ctx)
        XCTAssertEqual(first.count, 1)

        // Second call should skip already-registered modules
        let second = createNestedModuleInstances(app: testApp, globalContext: ctx)
        XCTAssertEqual(second.count, 0)

        // Only one module registered
        XCTAssertEqual(ctx.getModuleIds().count, 1)
    }
}
