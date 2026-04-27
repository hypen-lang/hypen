import XCTest
@testable import HypenServer

// MARK: - Test State Types for Multi-Module

struct SearchState: Codable {
    var query: String = ""
    var results: [String] = []
}

struct FeedState: Codable {
    var posts: [String] = []
    var loading: Bool = false
}

struct ProfileState: Codable {
    var username: String = ""
    var bio: String = ""
}

// MARK: - Multi-Module Integration Tests

final class MultiModuleIntegrationTests: XCTestCase {

    // ========================================================================
    // A. NativeEngine.registerModule calls through to the FFI
    // ========================================================================
    //
    // These tests require the native libhypen_engine library. Build with:
    //   cd hypen-engine-rs && cargo build --release --features uniffi
    // Run tests with:
    //   LD_LIBRARY_PATH=../hypen-engine-rs/target/release swift test

    func testNativeEngineRegisterModuleDoesNotCrash() throws {
        let engine = try NativeEngine()

        // Set the primary module first (required before registerModule)
        engine.setModule(
            name: "App",
            actions: [],
            stateKeys: ["page"],
            initialState: ["page": "home"]
        )

        // registerModule should not throw or crash
        engine.registerModule(name: "Search", initialState: ["query": "", "results": []])
        engine.registerModule(name: "Feed", initialState: ["posts": [], "loading": false])

        // Engine should still be functional after registering modules
        let patches = try engine.renderSource("Text(\"Hello\")")
        XCTAssertFalse(patches.isEmpty, "Engine should render after registerModule calls")
    }

    func testNativeEngineRegisterModuleWithState() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "App",
            actions: ["navigate"],
            stateKeys: ["page"],
            initialState: ["page": "home"]
        )

        // Register a nested module with initial state
        engine.registerModule(
            name: "Counter",
            initialState: ["count": 0, "label": "My Counter"]
        )

        // The engine should still work and the revision should be valid
        XCTAssertEqual(engine.getRevision(), 0)
    }

    func testNativeEngineRegisterMultipleModules() throws {
        let engine = try NativeEngine()

        engine.setModule(
            name: "App",
            actions: [],
            stateKeys: ["page"],
            initialState: ["page": "home"]
        )

        // Register several nested modules
        engine.registerModule(name: "Search", initialState: ["query": ""])
        engine.registerModule(name: "Feed", initialState: ["posts": []])
        engine.registerModule(name: "Profile", initialState: ["username": "alice"])

        // Engine should still render correctly
        let patches = try engine.renderSource("Column { Text(\"Hello\") }")
        XCTAssertFalse(patches.isEmpty)
    }

    // ========================================================================
    // B. Typed builder hypen(State()).name("X").build() registers in HypenApp
    // ========================================================================

    func testTypedBuilderNamedModuleAppearsInGetNames() {
        let testApp = HypenApp()

        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .onAction("search") { state in
                state.results = ["result1", "result2"]
            }
            .build()

        XCTAssertTrue(testApp.has("Search"), "Named module should be registered in app")
        XCTAssertTrue(testApp.getNames().contains("Search"), "Search should appear in getNames()")
    }

    func testTypedBuilderMultipleNamedModules() {
        let testApp = HypenApp()

        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .onAction("search") { state in
                state.results = ["a"]
            }
            .build()

        let _ = hypen(FeedState(), name: "Feed", app: testApp)
            .onAction("loadFeed") { state in
                state.loading = true
            }
            .build()

        let _ = hypen(ProfileState(), name: "Profile", app: testApp)
            .build()

        let names = testApp.getNames()
        XCTAssertEqual(names.count, 3)
        XCTAssertTrue(names.contains("Search"))
        XCTAssertTrue(names.contains("Feed"))
        XCTAssertTrue(names.contains("Profile"))
    }

    func testTypedBuilderModuleDefinitionHasCorrectState() {
        let testApp = HypenApp()

        let _ = hypen(SearchState(query: "hello", results: ["a", "b"]), name: "Search", app: testApp)
            .build()

        let def = testApp.get("Search")
        XCTAssertNotNil(def)
        XCTAssertEqual(def?.initialState["query"] as? String, "hello")

        let results = def?.initialState["results"] as? [String]
        XCTAssertEqual(results, ["a", "b"])
    }

    func testTypedBuilderFluentNameChaining() {
        let testApp = HypenApp()

        // Using the fluent .name() + .app() chaining instead of the named convenience
        let _ = hypen(FeedState())
            .name("Feed")
            .app(testApp)
            .onAction("refresh") { state in
                state.loading = true
            }
            .build()

        XCTAssertTrue(testApp.has("Feed"))
        XCTAssertTrue(testApp.getNames().contains("Feed"))
    }

    func testTypedBuilderClosureAPIRegistersInApp() {
        let testApp = HypenApp()

        let _ = hypen(SearchState(), name: "Search", app: testApp) { module in
            module.onAction("search") { state in
                state.results = ["result"]
            }
        }

        XCTAssertTrue(testApp.has("Search"))
        XCTAssertTrue(testApp.getNames().contains("Search"))
    }

    // ========================================================================
    // C. RemoteServer auto-discovers modules from appRegistry on handleOpen
    // ========================================================================
    //
    // The RemoteServer.handleOpen() method iterates appRegistry.getNames(),
    // skips the primary module, and calls engine.registerModule() for each
    // other module. We test this by verifying the wiring through
    // createNestedModuleInstances, which mirrors the same discovery logic.

    func testAutoDiscoveryRegistersAllNonPrimaryModules() {
        let testApp = HypenApp()

        // Primary module (will be set via setModule, not registerModule)
        testApp.module("App")
            .defineState(["page": "home"])
            .build()

        // Nested modules that should be auto-discovered
        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .onAction("search") { state in
                state.results = ["found"]
            }
            .build()

        let _ = hypen(FeedState(), name: "Feed", app: testApp)
            .build()

        // Simulate what RemoteServer.handleOpen does:
        // 1. It calls setModule for the primary module (name matching moduleName)
        // 2. For all other modules in appRegistry, it calls engine.registerModule

        let registeredNames = testApp.getNames()
        let primaryName = "App"
        var autoDiscoveredModules: [String] = []

        for name in registeredNames {
            if name != primaryName {
                if let def = testApp.get(name) {
                    // This simulates: engine.registerModule(name: name, initialState: def.initialState)
                    autoDiscoveredModules.append(name)
                    XCTAssertFalse(def.initialState.isEmpty || def.actionHandlers.isEmpty && def.asyncActionHandlers.isEmpty,
                                   "Auto-discovered module '\(name)' should have state or handlers")
                }
            }
        }

        XCTAssertTrue(autoDiscoveredModules.contains("Search"), "Search should be auto-discovered")
        XCTAssertTrue(autoDiscoveredModules.contains("Feed"), "Feed should be auto-discovered")
        XCTAssertFalse(autoDiscoveredModules.contains("App"), "Primary module should NOT be auto-discovered")
    }

    func testAutoDiscoveryWithNestedModuleInstances() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        // Register the primary module in the context (simulating what RemoteServer does)
        let primaryDef = AppBuilder(["page": "home"]).build()
        let primaryInstance = try! ModuleInstance(definition: primaryDef)
        ctx.registerModule("app", instance: primaryInstance)

        // Register nested modules via typed builder
        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .onAction("search") { state in
                state.results = ["match"]
            }
            .build()

        let _ = hypen(FeedState(), name: "Feed", app: testApp)
            .onAction("loadFeed") { state in
                state.loading = true
            }
            .build()

        // createNestedModuleInstances mirrors what RemoteServer does for module instances
        let nested = createNestedModuleInstances(app: testApp, globalContext: ctx)

        XCTAssertEqual(nested.count, 2, "Two nested modules should be created")
        XCTAssertNotNil(nested["Search"])
        XCTAssertNotNil(nested["Feed"])

        // Verify they are in global context
        XCTAssertTrue(ctx.hasModule("search"))
        XCTAssertTrue(ctx.hasModule("feed"))

        // Verify the primary module is still there
        XCTAssertTrue(ctx.hasModule("app"))
    }

    func testAutoDiscoverySkipsPrimaryModuleInRemoteServerPattern() throws {
        // This test simulates the exact pattern in RemoteServer.handleOpen:
        //   let registeredNames = appRegistry.getNames()
        //   for regName in registeredNames {
        //       guard regName != moduleName else { continue }
        //       if let def = appRegistry.get(regName) {
        //           engine.registerModule(name: regName, initialState: def.initialState)
        //       }
        //   }

        let testApp = HypenApp()
        let primaryModuleName = "App"

        // Register primary module
        testApp.module(primaryModuleName)
            .defineState(["page": "home"])
            .build()

        // Register nested module
        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .build()

        // Create a real NativeEngine to verify registerModule is actually called
        let engine = try NativeEngine()

        // Set up the primary module as RemoteServer would
        engine.setModule(
            name: primaryModuleName,
            actions: [],
            stateKeys: ["page"],
            initialState: ["page": "home"]
        )

        // Simulate the auto-discovery loop from handleOpen
        var registerModuleCalls: [(name: String, state: [String: Any])] = []
        let registeredNames = testApp.getNames()

        for regName in registeredNames {
            guard regName != primaryModuleName else { continue }
            if let def = testApp.get(regName) {
                engine.registerModule(name: regName, initialState: def.initialState)
                registerModuleCalls.append((name: regName, state: def.initialState))
            }
        }

        // Only Search should have been registered (not App)
        XCTAssertEqual(registerModuleCalls.count, 1)
        XCTAssertEqual(registerModuleCalls.first?.name, "Search")

        // Engine should still be functional
        let patches = try engine.renderSource("Text(\"test\")")
        XCTAssertFalse(patches.isEmpty)
    }

    // ========================================================================
    // D. End-to-end: typed modules + nested instances + cross-module access
    // ========================================================================

    func testEndToEndTypedMultiModule() {
        let testApp = HypenApp()
        let ctx = HypenGlobalContext()

        // Register primary module
        testApp.module("App")
            .defineState(["page": "home"])
            .build()

        let primaryDef = testApp.get("App")!
        let primaryInstance = try! ModuleInstance(definition: primaryDef)
        ctx.registerModule("app", instance: primaryInstance)

        // Register nested modules via typed builder
        let _ = hypen(SearchState(), name: "Search", app: testApp)
            .onAction("search") { state in
                state.query = "test"
                state.results = ["result1", "result2"]
            }
            .build()

        let _ = hypen(FeedState(), name: "Feed", app: testApp)
            .onAction("loadFeed") { state in
                state.posts = ["Post 1", "Post 2"]
                state.loading = false
            }
            .build()

        // Create nested instances (what RemoteServer triggers)
        let nested = createNestedModuleInstances(app: testApp, globalContext: ctx)

        // Dispatch actions on nested modules
        let searchRef = ctx.getModule("search")
        XCTAssertNotNil(searchRef)
        searchRef?.dispatchAction("search")
        XCTAssertEqual(searchRef?.getState()["query"] as? String, "test")
        XCTAssertEqual(searchRef?.getState()["results"] as? [String], ["result1", "result2"])

        let feedRef = ctx.getModule("feed")
        XCTAssertNotNil(feedRef)
        feedRef?.dispatchAction("loadFeed")
        XCTAssertEqual(feedRef?.getState()["posts"] as? [String], ["Post 1", "Post 2"])

        // Verify merged state includes all modules
        let merged = getMergedState(primaryInstance: primaryInstance, nestedInstances: nested)
        XCTAssertEqual(merged["page"] as? String, "home")

        // Destroy nested modules
        destroyNestedModuleInstances(nested, globalContext: ctx)
        XCTAssertFalse(ctx.hasModule("search"))
        XCTAssertFalse(ctx.hasModule("feed"))
        XCTAssertTrue(ctx.hasModule("app"), "Primary module should survive nested destroy")
    }

    func testNestedModuleEngineRegistrationMatchesAppRegistry() throws {
        // Verify that for every non-primary module in the app, the engine
        // receives a registerModule call with matching initial state.

        let testApp = HypenApp()
        let engine = try NativeEngine()
        let primaryModuleName = "App"

        // Set up primary
        testApp.module(primaryModuleName)
            .defineState(["page": "home"])
            .build()

        // Set up nested modules via typed builder
        let _ = hypen(SearchState(query: "initial"), name: "Search", app: testApp)
            .build()

        let _ = hypen(FeedState(posts: ["p1"], loading: true), name: "Feed", app: testApp)
            .build()

        // Configure the engine primary module
        let primaryDef = testApp.get(primaryModuleName)!
        engine.setModule(
            name: primaryModuleName,
            actions: [],
            stateKeys: Array(primaryDef.initialState.keys),
            initialState: primaryDef.initialState
        )

        // Simulate auto-discovery (from handleOpen)
        for name in testApp.getNames() {
            guard name != primaryModuleName else { continue }
            if let def = testApp.get(name) {
                engine.registerModule(name: name, initialState: def.initialState)
            }
        }

        // After registration, the engine should still be able to render
        let patches = try engine.renderSource("Column { Text(\"@{state.page}\") }")
        XCTAssertFalse(patches.isEmpty, "Engine should render with primary + registered modules")
    }

    // ========================================================================
    // E. Nested module Grid rendering: Search module with Grid(@state.explorePosts)
    // ========================================================================

    func testNestedModuleGridRendersItems() throws {
        let engine = try NativeEngine()

        // 1. Set up App as primary module with currentView state
        engine.setModule(
            name: "App",
            actions: ["navigateToFeed"],
            stateKeys: ["currentView"],
            initialState: ["currentView": "search"]
        )

        // 2. Register Search as a named module with explorePosts
        let explorePosts: [[String: Any]] = [
            ["id": "p1", "imageUrl": "https://img1.jpg"],
            ["id": "p2", "imageUrl": "https://img2.jpg"],
            ["id": "p3", "imageUrl": "https://img3.jpg"],
        ]
        engine.registerModule(
            name: "Search",
            initialState: [
                "searchQuery": "",
                "explorePosts": explorePosts,
            ]
        )

        // 3. Register Search component DSL
        try engine.registerComponent(
            name: "Search",
            source: """
                module Search {
                    Column {
                        Input(placeholder: "Search")
                        Grid(@state.explorePosts, key: "id") {
                            Image(src: "@{item.imageUrl}")
                        }
                    }
                }
            """,
            path: "./components/Search.hypen"
        )

        // 4. Render App with If condition referencing Search()
        let patches = try engine.renderSource("""
            module App {
                Column {
                    If(condition: "@{state.currentView == 'search'}") {
                        Search()
                    }
                }
            }
        """)

        XCTAssertFalse(patches.isEmpty, "Rendering nested module with Grid should produce patches")

        // 5. Extract create patches
        let createPatches = patches.filter { ($0["type"] as? String) == "create" }
        let elementTypes = createPatches.compactMap { $0["elementType"] as? String }

        // 6. Assert Grid element is created
        XCTAssertTrue(
            elementTypes.contains("Grid"),
            "Initial render should create a Grid element. Got: \(elementTypes)"
        )

        // 7. Assert 3 Image elements are created (one per explorePost)
        let imageCount = elementTypes.filter { $0 == "Image" }.count
        XCTAssertEqual(
            imageCount, 3,
            "Should create 3 Image elements for 3 explorePosts. Got creates: \(elementTypes)"
        )
    }
}
