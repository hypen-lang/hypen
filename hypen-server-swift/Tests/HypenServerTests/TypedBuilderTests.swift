import XCTest
@testable import HypenServer

// MARK: - Test State Types

struct CounterState: Codable {
    var count: Int = 0
    var label: String = "Counter"
}

struct TodoState: Codable {
    var items: [String] = []
    var filter: String = "all"
}

struct AddPayload: Codable {
    let amount: Int
}

struct AddItemPayload: Codable {
    let item: String
}

struct SetFilterPayload: Codable {
    let filter: String
}

// MARK: - Typed Action Enums

enum CounterAction: String, HypenAction, Codable, CaseIterable {
    case increment
    case decrement
    case reset
}

// MARK: - Fluent Chaining Tests

final class TypedBuilderTests: XCTestCase {

    // MARK: - Fluent API

    func testFluentIncrement() {
        let def = hypen(CounterState())
            .onAction("increment") { state in
                state.count += 1
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        XCTAssertEqual(instance.getState()["count"] as? Int, 0)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 2)
    }

    func testFluentChainedActions() {
        let def = hypen(CounterState())
            .onAction("increment") { state in
                state.count += 1
            }
            .onAction("decrement") { state in
                state.count -= 1
            }
            .onAction("reset") { state in
                state.count = 0
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

    func testFluentTypedPayload() {
        let def = hypen(CounterState())
            .onAction("add", payload: AddPayload.self) { state, payload in
                state.count += payload.amount
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("add", payload: ["amount": 5])
        XCTAssertEqual(instance.getState()["count"] as? Int, 5)

        instance.dispatchAction("add", payload: ["amount": 3])
        XCTAssertEqual(instance.getState()["count"] as? Int, 8)
    }

    func testFluentUITerminal() {
        let def = hypen(CounterState())
            .onAction("increment") { state in
                state.count += 1
            }
            .ui("Column { Text(\"Count: @{state.count}\") }")

        XCTAssertEqual(def.ui, "Column { Text(\"Count: @{state.count}\") }")
    }

    func testFluentMultipleFields() {
        let def = hypen(CounterState())
            .onAction("setAll") { state in
                state.count = 42
                state.label = "Updated"
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("setAll")
        XCTAssertEqual(instance.getState()["count"] as? Int, 42)
        XCTAssertEqual(instance.getState()["label"] as? String, "Updated")
    }

    func testFluentLifecycle() {
        let createdCount = TestCounter(0)
        let destroyedWith = TestCounter(0)

        let def = hypen(CounterState(count: 5))
            .onCreated { state, _ in
                createdCount.set(state.count)
            }
            .onAction("increment") { state in
                state.count += 1
            }
            .onDestroyed { state, _ in
                destroyedWith.set(state.count)
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        XCTAssertEqual(createdCount.current, 5)

        instance.dispatchAction("increment")
        instance.dispatchAction("increment")
        instance.destroy()
        XCTAssertEqual(destroyedWith.current, 7)
    }

    func testFluentNamedModule() {
        let testApp = HypenApp()

        let _ = hypen(CounterState(), name: "MyCounter", app: testApp)
            .onAction("increment") { state in
                state.count += 1
            }
            .build()

        XCTAssertTrue(testApp.has("MyCounter"))
    }

    func testFluentPersistAndVersion() {
        let def = hypen(CounterState())
            .persist()
            .version(3)
            .build()

        XCTAssertEqual(def.persist, true)
        XCTAssertEqual(def.version, 3)
    }

    func testFluentArrayState() {
        let def = hypen(TodoState())
            .onAction("add", payload: AddItemPayload.self) { state, payload in
                state.items.append(payload.item)
            }
            .onAction("clear") { state in
                state.items.removeAll()
            }
            .onAction("setFilter", payload: SetFilterPayload.self) { state, payload in
                state.filter = payload.filter
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("add", payload: ["item": "Buy milk"])
        instance.dispatchAction("add", payload: ["item": "Walk dog"])

        let items = instance.getState()["items"] as? [String]
        XCTAssertEqual(items, ["Buy milk", "Walk dog"])

        instance.dispatchAction("setFilter", payload: ["filter": "active"])
        XCTAssertEqual(instance.getState()["filter"] as? String, "active")
    }

    func testFluentDestroyed() {
        let def = hypen(CounterState())
            .onAction("increment") { state in
                state.count += 1
            }
            .build()

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.destroy()
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1) // Unchanged
    }

    // MARK: - Typed Action Enum

    func testTypedActionEnum() {
        let def = hypen(CounterState())
            .onAction(CounterAction.self) { state, action in
                switch action {
                case .increment: state.count += 1
                case .decrement: state.count -= 1
                case .reset: state.count = 0
                }
            }
            .build()

        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.dispatchAction("increment")
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 3)

        instance.dispatchAction("decrement")
        XCTAssertEqual(instance.getState()["count"] as? Int, 2)

        instance.dispatchAction("reset")
        XCTAssertEqual(instance.getState()["count"] as? Int, 0)
    }

    func testTypedActionEnumWithUI() {
        let def = hypen(CounterState())
            .onAction(CounterAction.self) { state, action in
                switch action {
                case .increment: state.count += 1
                case .decrement: state.count -= 1
                case .reset: state.count = 0
                }
            }
            .ui("Column { Text(\"@{state.count}\") }")

        XCTAssertEqual(def.ui, "Column { Text(\"@{state.count}\") }")
        XCTAssertTrue(def.actions.contains("increment"))
        XCTAssertTrue(def.actions.contains("decrement"))
        XCTAssertTrue(def.actions.contains("reset"))
    }

    // MARK: - Closure API (backward compat)

    func testClosureAPIStillWorks() {
        let def = hypen(CounterState()) { module in
            module.onAction("increment") { state in
                state.count += 1
            }
        }

        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)
    }

    func testClosureNamedModule() {
        let testApp = HypenApp()

        let _ = hypen(CounterState(), name: "ClosureCounter", app: testApp) { module in
            module.onAction("increment") { state in
                state.count += 1
            }
        }

        XCTAssertTrue(testApp.has("ClosureCounter"))
    }

    // MARK: - Initial state

    func testInitialStateFromStruct() {
        let def = hypen(CounterState(count: 42, label: "Custom"))
            .build()

        XCTAssertEqual(def.initialState["count"] as? Int, 42)
        XCTAssertEqual(def.initialState["label"] as? String, "Custom")
    }

    // MARK: - Mixed: typed enum + string actions

    func testMixedTypedAndStringActions() {
        let def = hypen(CounterState())
            .onAction(CounterAction.self) { state, action in
                switch action {
                case .increment: state.count += 1
                case .decrement: state.count -= 1
                case .reset: state.count = 0
                }
            }
            .onAction("setLabel") { state in
                state.label = "Changed"
            }
            .build()

        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction("increment")
        XCTAssertEqual(instance.getState()["count"] as? Int, 1)

        instance.dispatchAction("setLabel")
        XCTAssertEqual(instance.getState()["label"] as? String, "Changed")
    }
}
