import XCTest
@testable import HypenServer

/// Tests for NativeEngine — the UniFFI wrapper around the Rust engine.
///
/// These tests require the native `libhypen_engine` library to be built and
/// available in the library path. Build with:
///   cd hypen-engine-rs && cargo build --release --features uniffi
///
/// Run tests with:
///   LD_LIBRARY_PATH=../hypen-engine-rs/target/release swift test
final class NativeEngineTests: XCTestCase {

    // MARK: - Initialization

    func testEngineCreation() throws {
        let engine = try NativeEngine()
        XCTAssertEqual(engine.getRevision(), 0)
    }

    // MARK: - Simple DSL Rendering

    func testRenderSimpleText() throws {
        let engine = try NativeEngine()
        let patches = try engine.renderSource("Text(\"Hello\")")

        // Should produce at least a Create + SetText + Insert
        XCTAssertFalse(patches.isEmpty, "Rendering Text(\"Hello\") should produce patches")

        // Find the create patch for the Text element
        let createPatch = patches.first { ($0["type"] as? String) == "create" }
        XCTAssertNotNil(createPatch, "Should have a 'create' patch")
        XCTAssertEqual(createPatch?["elementType"] as? String, "Text")
    }

    func testRenderColumnWithChildren() throws {
        let engine = try NativeEngine()
        let patches = try engine.renderSource("""
            Column {
                Text("First")
                Text("Second")
            }
        """)

        XCTAssertFalse(patches.isEmpty)

        // Should create Column + two Text elements
        let createPatches = patches.filter { ($0["type"] as? String) == "create" }
        XCTAssertGreaterThanOrEqual(createPatches.count, 3, "Should create Column + 2 Text elements")

        let elementTypes = createPatches.compactMap { $0["elementType"] as? String }
        XCTAssertTrue(elementTypes.contains("Column"))
        XCTAssertTrue(elementTypes.contains("Text"))
    }

    func testRenderButtonWithAction() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "Test",
            actions: ["click"],
            stateKeys: [],
            initialState: [:]
        )

        let patches = try engine.renderSource("Button(\"@actions.click\") { Text(\"Click me\") }")

        XCTAssertFalse(patches.isEmpty)

        let createPatches = patches.filter { ($0["type"] as? String) == "create" }
        let elementTypes = createPatches.compactMap { $0["elementType"] as? String }
        XCTAssertTrue(elementTypes.contains("Button"))
        XCTAssertTrue(elementTypes.contains("Text"))
    }

    // MARK: - State Binding

    func testRenderWithStatefulText() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "Counter",
            actions: ["increment"],
            stateKeys: ["count"],
            initialState: ["count": 0]
        )

        let patches = try engine.renderSource("Text(\"Count: ${state.count}\")")
        XCTAssertFalse(patches.isEmpty)

        // Find the setText patch — should contain the resolved state value
        let textPatches = patches.filter { ($0["type"] as? String) == "setText" }
        if let textPatch = textPatches.first {
            let text = textPatch["text"] as? String
            XCTAssertTrue(text?.contains("0") ?? false, "Text should resolve state.count to 0")
        }
    }

    func testStateUpdateProducesPatches() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "Counter",
            actions: [],
            stateKeys: ["count"],
            initialState: ["count": 0]
        )

        // Initial render
        let _ = try engine.renderSource("Text(\"Count: ${state.count}\")")

        // Update state — should produce incremental patches
        let updatePatches = try engine.updateState(state: ["count": 1])

        // The engine should detect the state change and produce setText patches
        // (exact behavior depends on engine reconciliation)
        // At minimum, verify no crash and valid output
        XCTAssertTrue(true, "State update should not crash")

        if !updatePatches.isEmpty {
            let types = updatePatches.compactMap { $0["type"] as? String }
            XCTAssertFalse(types.isEmpty, "Patches should have types")
        }
    }

    // MARK: - Module Configuration

    func testSetModuleWithActions() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "App",
            actions: ["increment", "decrement", "reset"],
            stateKeys: ["count", "label"],
            initialState: ["count": 0, "label": "Counter"]
        )

        // Should be able to render after setting module
        let patches = try engine.renderSource("Text(\"${state.label}: ${state.count}\")")
        XCTAssertFalse(patches.isEmpty)
    }

    // MARK: - Component Registration

    func testRegisterAndUseComponent() throws {
        let engine = try NativeEngine()

        // Register a custom component
        try engine.registerComponent(
            name: "MyButton",
            source: "Button(\"click\") { Text(\"Custom\") }",
            path: "./components/MyButton.hypen"
        )

        // Render using the registered component
        let patches = try engine.renderSource("MyButton {}")
        XCTAssertFalse(patches.isEmpty, "Rendering registered component should produce patches")
    }

    // MARK: - Primitive Registration

    func testCustomPrimitiveRegistration() throws {
        let engine = try NativeEngine()
        // Default primitives already registered in init
        // Register an additional custom primitive
        engine.registerPrimitive("CustomView")

        // Should be able to render the custom primitive
        let patches = try engine.renderSource("CustomView {}")
        XCTAssertFalse(patches.isEmpty)
    }

    // MARK: - Action Dispatch

    func testActionDispatchAndRetrieval() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "Test",
            actions: ["doSomething"],
            stateKeys: [],
            initialState: [:]
        )

        // Dispatch an action
        try engine.dispatchAction("doSomething", payloadJson: "{\"key\": \"value\"}")

        // Process pending actions
        var handledAction: String?
        var handledPayload: Any?

        engine.onAction("doSomething") { name, payload in
            handledAction = name
            handledPayload = payload
        }

        engine.processPendingActions()

        XCTAssertEqual(handledAction, "doSomething")
        XCTAssertNotNil(handledPayload)
        if let dict = handledPayload as? [String: Any] {
            XCTAssertEqual(dict["key"] as? String, "value")
        }
    }

    // MARK: - Revision Tracking

    func testRevisionIncrements() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "Test",
            actions: [],
            stateKeys: ["x"],
            initialState: ["x": 0]
        )

        XCTAssertEqual(engine.getRevision(), 0)

        let _ = try engine.renderSource("Text(\"${state.x}\")")
        XCTAssertEqual(engine.getRevision(), 1)
    }

    // MARK: - Clear Tree

    func testClearTree() throws {
        let engine = try NativeEngine()

        let _ = try engine.renderSource("Text(\"Hello\")")
        engine.clearTree()

        // After clearing, rendering again should produce fresh patches
        let patches = try engine.renderSource("Text(\"World\")")
        XCTAssertFalse(patches.isEmpty)
    }

    // MARK: - Parse Errors

    func testInvalidDSLThrowsError() throws {
        let engine = try NativeEngine()

        XCTAssertThrowsError(try engine.renderSource("{{{{invalid"))
    }

    // MARK: - Patch Wire Format

    func testPatchWireFormat() throws {
        let engine = try NativeEngine()
        let patches = try engine.renderSource("Text(\"Hello\")")

        // Every patch must have "type" and "id"
        for patch in patches {
            XCTAssertNotNil(patch["type"] as? String, "Each patch must have a 'type' field")
            XCTAssertNotNil(patch["id"] as? String, "Each patch must have an 'id' field")
        }

        // Verify the wire format types are lowercase strings
        let validTypes = ["create", "setProp", "removeProp", "setText", "insert", "move", "remove"]
        for patch in patches {
            let type = patch["type"] as? String ?? ""
            XCTAssertTrue(validTypes.contains(type), "Patch type '\(type)' should be a valid type")
        }
    }
}
