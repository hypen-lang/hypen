import XCTest
@testable import HypenServer

/// Tests for the external capability surface — what a caller that is NOT the
/// rendered UI (MCP, REST, CLI, agent) may reach.
///
/// The rule under test: nothing is externally reachable that a developer did
/// not declare. Actions come from `.onAction()`, navigation from a declared
/// `Router`, inputs from `.bind(@state.x)`. The guard lives in the Rust engine
/// (`agent_core::resolve_external`); these tests assert the Swift SDK reaches
/// it rather than around it.
///
/// Like `NativeEngineTests`, these need the native library:
///   cd hypen-engine-rs && cargo build --release --features uniffi
///   LD_LIBRARY_PATH=../target/release swift test
final class ExternalCapabilitiesTests: XCTestCase {

    // MARK: - Actions

    func testDeclaredModuleActionIsListedAndDispatchable() throws {
        let engine = try NativeEngine()
        engine.setModule(
            name: "Counter",
            actions: ["increment"],
            stateKeys: ["count"],
            initialState: ["count": 0]
        )

        // Listed only once a handler exists: a declared name that would be
        // refused on dispatch is never advertised.
        let fired = TestCounter(false)
        engine.onAction("increment") { _, _ in fired.set(true) }

        let listed = try engine.listActions()
        let increment = listed.first(where: { $0.name == "increment" })
        XCTAssertNotNil(increment, "a declared onAction should be externally listed")
        XCTAssertEqual(increment?.builtin, false)
        // Primary-slot actions carry no module scope.
        XCTAssertNil(increment?.module)

        try engine.dispatchExternal("increment")
        engine.processPendingActions()

        XCTAssertTrue(fired.current, "dispatchExternal should reach the module handler")
    }

    func testUndeclaredActionIsRefused() throws {
        let engine = try NativeEngine()
        engine.setModule(
            name: "Counter",
            actions: ["increment"],
            stateKeys: ["count"],
            initialState: ["count": 0]
        )
        // Registered with the dispatcher, but never *declared* by a module —
        // so it is reachable by the renderer and not by anyone else.
        engine.onAction("secretlyRegistered") { _, _ in }

        XCTAssertThrowsError(try engine.dispatchExternal("secretlyRegistered")) { error in
            XCTAssertTrue(
                "\(error)".contains("secretlyRegistered"),
                "expected a refusal naming the action, got \(error)"
            )
        }
    }

    // MARK: - Framework internals stay unreachable

    func testBindActionIsRefusedByName() throws {
        let engine = try NativeEngine()
        engine.setModule(
            name: "Form",
            actions: [],
            stateKeys: ["name"],
            initialState: ["name": ""]
        )
        // `setModule` registers `__hypen_bind` with the dispatcher so the
        // renderer's two-way binding works. That must not make it externally
        // dispatchable — it takes a caller-supplied path and writes straight
        // into state, which is exactly the primitive `set_input` exists to
        // fence off.
        _ = try engine.renderSource("""
            Input(placeholder: "Name").bind(@state.name)
        """)

        XCTAssertFalse(
            try engine.listActions().contains(where: { $0.name == "__hypen_bind" }),
            "__hypen_bind must never be advertised"
        )
        XCTAssertThrowsError(
            try engine.dispatchExternal("__hypen_bind", payload: ["path": "name", "value": "Mallory"])
        ) { error in
            XCTAssertTrue(
                "\(error)".contains("__hypen_bind"),
                "expected a refusal naming the action, got \(error)"
            )
        }
    }

    func testHistoryManipulationBuiltinsAreRefused() throws {
        let engine = try NativeEngine()
        engine.setModule(name: "App", actions: [], stateKeys: [], initialState: [:])
        // A declared Router, so `navigate` / `back` ARE on offer here. The
        // built-in table is an exact-match allowlist rather than a `router.`
        // prefix rule, so the neighbouring verbs stay out.
        _ = try engine.renderSource("""
            Router {
                Route(path: "/") { Text("Home") }
            }
        """)

        let names = try engine.listActions().map(\.name)
        XCTAssertTrue(names.contains(ExternalAction.navigate))
        XCTAssertFalse(names.contains("router.replace"))
        XCTAssertFalse(names.contains("router.forward"))
        XCTAssertFalse(names.contains("router.push"), "the internal name is never advertised")

        XCTAssertThrowsError(try engine.dispatchExternal("router.replace", payload: ["to": "/"])) { error in
            XCTAssertTrue("\(error)".contains("router.replace"), "got \(error)")
        }
        XCTAssertThrowsError(try engine.dispatchExternal("router.forward")) { error in
            XCTAssertTrue("\(error)".contains("router.forward"), "got \(error)")
        }
    }

    // MARK: - Inputs

    func testSetInputAcceptsDeclaredBindAndRefusesUndeclaredField() throws {
        let engine = try NativeEngine()
        engine.setModule(
            name: "Form",
            actions: [],
            stateKeys: ["name", "agreed"],
            initialState: ["name": "", "agreed": false]
        )
        _ = try engine.renderSource("""
            Column {
                Input(placeholder: "Name").bind(@state.name)
                Checkbox {}.bind(@state.agreed)
            }
        """)

        let bindings = try engine.listBindings()
        XCTAssertEqual(Set(bindings.map(\.path)), ["name", "agreed"])

        let name = bindings.first(where: { $0.path == "name" })
        XCTAssertEqual(name?.prop, "value")
        XCTAssertEqual(name?.elementType, "Input")
        // `prop` doubles as a type signal — `checked` means boolean.
        XCTAssertEqual(bindings.first(where: { $0.path == "agreed" })?.prop, "checked")

        // Declared field: accepted, and lowered to `__hypen_bind` with a
        // payload the engine built rather than one the caller supplied.
        let seen = TestCounter<[(String, Any?)]>([])
        engine.onAction("__hypen_bind") { name, payload in
            seen.mutate { $0.append((name, payload)) }
        }
        try engine.dispatchExternal(
            ExternalAction.setInput,
            payload: ["field": "name", "value": "Ada"]
        )
        engine.processPendingActions()

        XCTAssertEqual(seen.current.count, 1)
        XCTAssertEqual(seen.current.first?.0, "__hypen_bind")
        let payload = seen.current.first?.1 as? [String: Any]
        XCTAssertEqual(payload?["path"] as? String, "name")
        XCTAssertEqual(payload?["value"] as? String, "Ada")

        // Undeclared field: refused, even though it is a perfectly valid
        // state path. No `.bind()` points at it, so nothing external may.
        XCTAssertThrowsError(
            try engine.dispatchExternal(
                ExternalAction.setInput,
                payload: ["field": "secretToken", "value": "x"]
            )
        ) { error in
            XCTAssertTrue("\(error)".contains("secretToken"), "got \(error)")
        }
    }

    func testSetInputIsNotOfferedWithoutAnyBind() throws {
        let engine = try NativeEngine()
        engine.setModule(name: "Plain", actions: [], stateKeys: [], initialState: [:])
        _ = try engine.renderSource("Text(\"nothing bound here\")")

        XCTAssertTrue(try engine.listBindings().isEmpty)
        XCTAssertFalse(try engine.listActions().contains(where: { $0.name == ExternalAction.setInput }))
        XCTAssertThrowsError(
            try engine.dispatchExternal(
                ExternalAction.setInput,
                payload: ["field": "anything", "value": 1]
            )
        )
    }

    // MARK: - Navigation

    func testNavigateWorksWhenARouterIsDeclared() throws {
        let engine = try NativeEngine()
        engine.setModule(name: "App", actions: [], stateKeys: [], initialState: [:])
        _ = try engine.renderSource("""
            Router {
                Route(path: "/") { Text("Home") }
                Route(path: "/counter/:id") { Text("Counter") }
            }
        """)

        let routes = try engine.listRoutes()
        XCTAssertEqual(routes.map(\.path), ["/", "/counter/:id"])
        XCTAssertTrue(routes.first?.params.isEmpty == true, "a static route has no params")
        XCTAssertEqual(routes.last?.params, ["id"])

        // The alias is resolved inside the engine: the host sees `router.push`,
        // never the external name.
        let seen = TestCounter<[String]>([])
        engine.onAction("router.push") { name, _ in seen.mutate { $0.append(name) } }

        try engine.dispatchExternal(ExternalAction.navigate, payload: ["to": "/counter/7"])
        engine.processPendingActions()

        XCTAssertEqual(seen.current, ["router.push"])
    }

    func testNavigateIsRefusedWhenNoRouterIsDeclared() throws {
        let engine = try NativeEngine()
        engine.setModule(name: "App", actions: [], stateKeys: [], initialState: [:])
        _ = try engine.renderSource("Text(\"no routes here\")")

        XCTAssertTrue(try engine.listRoutes().isEmpty)
        // Listing and dispatch have to agree: an unlisted built-in is refused.
        XCTAssertFalse(try engine.listActions().contains(where: { $0.name == ExternalAction.navigate }))
        XCTAssertThrowsError(
            try engine.dispatchExternal(ExternalAction.navigate, payload: ["to": "/counter"])
        ) { error in
            XCTAssertTrue("\(error)".contains(ExternalAction.navigate), "got \(error)")
        }
    }

    // MARK: - State reads

    func testGetStateAtReadsWholeStateAndPath() throws {
        let engine = try NativeEngine()
        engine.setModule(name: "App", actions: [], stateKeys: [], initialState: [:])
        engine.registerModule(
            name: "Profile",
            initialState: [
                "user": ["name": "Ada", "age": 36, "ssn": "000-00-0000"] as [String: Any]
            ],
            actions: []
        )
        // Reads are gated to what the templates render: a module declares
        // its readable paths through its own on-screen nodes, so the named
        // module renders through a component the primary template mounts.
        try engine.registerComponent(
            name: "Profile",
            source: """
            module Profile { Column { Text("@{state.user.name}") Text("@{state.user.age}") } }
            """,
            path: "Profile"
        )
        _ = try engine.renderSource("module App { Column { Profile } }")

        // Module names are matched case-insensitively.
        XCTAssertEqual(engine.getStateAt(module: "profile", path: "user.name") as? String, "Ada")
        XCTAssertEqual(engine.getStateAt(module: "Profile", path: "user.age") as? Int, 36)
        // A whole-module read is projected down to the rendered paths: the
        // SSN the UI never shows is simply absent.
        let whole = engine.getStateAt(module: "Profile") as? [String: Any]
        let user = whole?["user"] as? [String: Any]
        XCTAssertEqual(user?["name"] as? String, "Ada")
        XCTAssertNil(user?["ssn"])
        // Unknown module, absent path and unrendered path are deliberately
        // indistinguishable.
        XCTAssertNil(engine.getStateAt(module: "Profile", path: "user.ssn"))
        XCTAssertNil(engine.getStateAt(module: "NoSuchModule", path: "user.name"))
    }

    // MARK: - Destroy vs. persist

    func testDestroyedModuleLosesItsActionsButPersistedModuleKeepsThem() throws {
        let engine = try NativeEngine()
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        // HomePage persists (the default). Counter opts out, so leaving it
        // destroys it.
        _ = app.module("HomePage")
            .defineState(["page": "home"])
            .onAction("refreshFeed") { _ in }
            .build()
        _ = app.module("Counter")
            .defineState(["count": 0], options: ModuleOptions(persist: false))
            .onAction("increment") { _ in }
            .build()

        let managed = ManagedRouter(
            router: router,
            registry: app,
            globalContext: ctx,
            engine: engine
        )
        managed.addRoute(RouteDefinition(path: "/", component: "HomePage"))
        managed.addRoute(RouteDefinition(path: "/counter", component: "Counter"))
        managed.start()

        func listed() throws -> [String] { try engine.listActions().map(\.name) }

        XCTAssertTrue(try listed().contains("refreshFeed"))
        XCTAssertEqual(
            try engine.listActions().first(where: { $0.name == "refreshFeed" })?.module,
            "homepage",
            "a route module's actions are listed under its own scope"
        )
        // The reserved `router.*` handlers ManagedRouter installs are
        // dispatcher registrations, not module declarations — they must not
        // leak into the external listing.
        XCTAssertFalse(try listed().contains("router.push"))

        router.push("/counter")

        XCTAssertTrue(try listed().contains("increment"))
        XCTAssertTrue(
            try listed().contains("refreshFeed"),
            "HomePage is persisted, not destroyed — it stays registered so "
                + "siblings can still read its state while it is off-screen"
        )
        // ...and stays externally dispatchable, because it is still declared.
        XCTAssertNoThrow(try engine.dispatchExternal("refreshFeed"))

        router.push("/")

        XCTAssertFalse(
            try listed().contains("increment"),
            "Counter opted out of persistence, so destroying it must drop its "
                + "actions from the external surface"
        )
        XCTAssertThrowsError(try engine.dispatchExternal("increment"))
        XCTAssertTrue(try listed().contains("refreshFeed"))

        managed.stop()

        // Full stop destroys everything, persisted instances included.
        XCTAssertFalse(try listed().contains("refreshFeed"))
    }

    // MARK: - Name pinning

    func testBuiltinConstantsMatchWhatTheEngineExports() throws {
        // `ExternalAction` is a compile-time convenience, but the engine owns
        // these spellings. Pinning them here turns an engine-side rename into a
        // failing test instead of a Swift SDK that dispatches names the guard
        // no longer recognises.
        let engine = try NativeEngine()
        let names = try engine.builtinActionNames()

        XCTAssertEqual(names.navigate, ExternalAction.navigate)
        XCTAssertEqual(names.back, ExternalAction.back)
        XCTAssertEqual(names.setInput, ExternalAction.setInput)
        XCTAssertEqual(names.bindAction, ExternalAction.bindAction)
    }

    // MARK: - Decoding

    func testListingsDecodeEitherKeySpelling() throws {
        // The engine's structs derive plain serde (snake_case) while the
        // UniFFI docs advertise camelCase; the decoders accept both so a
        // rename on either side can't silently drop `moduleScope`.
        let camel = Data("""
            [{"path":"bio","prop":"value","elementType":"Textarea","moduleScope":"profile"}]
        """.utf8)
        let snake = Data("""
            [{"path":"bio","prop":"value","element_type":"Textarea","module_scope":"profile"}]
        """.utf8)

        let expected = [
            BoundInput(path: "bio", prop: "value", elementType: "Textarea", moduleScope: "profile")
        ]
        XCTAssertEqual(try JSONDecoder().decode([BoundInput].self, from: camel), expected)
        XCTAssertEqual(try JSONDecoder().decode([BoundInput].self, from: snake), expected)

        let routeCamel = Data(#"[{"path":"/u/:id","params":["id"],"moduleScope":"app"}]"#.utf8)
        let routeSnake = Data(#"[{"path":"/u/:id","params":["id"],"module_scope":"app"}]"#.utf8)
        let expectedRoute = [AgentRoute(path: "/u/:id", params: ["id"], moduleScope: "app")]
        XCTAssertEqual(try JSONDecoder().decode([AgentRoute].self, from: routeCamel), expectedRoute)
        XCTAssertEqual(try JSONDecoder().decode([AgentRoute].self, from: routeSnake), expectedRoute)
    }
}
