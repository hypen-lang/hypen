import XCTest
@testable import HypenServer

final class ManagedRouterTests: XCTestCase {
    func testMountsInitialRoute() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let _ = app.module("HomePage").defineState(["page": "home"]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/", component: "HomePage"))
        managed.start()

        XCTAssertNotNil(managed.getActiveModule())
        XCTAssertEqual(managed.getActiveRoute()?.path, "/")
        XCTAssertTrue(ctx.hasModule("homepage"))

        managed.stop()
    }

    func testSwitchesModulesOnNavigation_explicitOptOut() {
        // With persist: false explicitly, the previous behavior is preserved:
        // navigating away destroys and unregisters the leaving module.
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let _ = app.module("HomePage")
            .defineState(["page": "home"], options: ModuleOptions(persist: false))
            .build()
        let _ = app.module("Counter")
            .defineState(["count": 0], options: ModuleOptions(persist: false))
            .build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/", component: "HomePage"))
        managed.addRoute(RouteDefinition(path: "/counter", component: "Counter"))
        managed.start()

        XCTAssertTrue(ctx.hasModule("homepage"))
        XCTAssertFalse(ctx.hasModule("counter"))

        router.push("/counter")

        XCTAssertFalse(ctx.hasModule("homepage"))
        XCTAssertTrue(ctx.hasModule("counter"))
        XCTAssertEqual(managed.getActiveRoute()?.path, "/counter")

        managed.stop()
    }

    func testPersistDefaultsToTrueForModuleBackedRoutes() {
        // Without `persist` set explicitly, module-backed routes now
        // persist across navigation by default — state survives.
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let _ = app.module("HomePage").defineState(["page": "home"]).build()
        let _ = app.module("Counter").defineState(["count": 0]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/", component: "HomePage"))
        managed.addRoute(RouteDefinition(path: "/counter", component: "Counter"))
        managed.start()

        XCTAssertTrue(ctx.hasModule("homepage"))

        router.push("/counter")

        // HomePage should persist by default.
        XCTAssertTrue(ctx.hasModule("homepage"))
        XCTAssertTrue(ctx.hasModule("counter"))
        XCTAssertEqual(managed.getActiveRoute()?.path, "/counter")

        managed.stop()
    }

    func testActivationLifecycle() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let events = TestEventLog()

        let _ = app.module("Screen")
            .defineState(["visits": 0])
            .onCreated { _ in events.append("created") }
            .onActivated { state in
                events.append("activated")
                let v = state.get("visits") as? Int ?? 0
                state.set("visits", v + 1)
            }
            .onDeactivated { _ in events.append("deactivated") }
            .onDestroyed { _ in events.append("destroyed") }
            .build()

        let _ = app.module("Other").defineState(["x": 0]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/screen", component: "Screen"))
        managed.addRoute(RouteDefinition(path: "/other", component: "Other"))

        router.push("/screen")
        managed.start()
        XCTAssertEqual(events.all, ["created", "activated"])

        router.push("/other")
        XCTAssertEqual(events.all, ["created", "activated", "deactivated"])

        router.push("/screen")
        XCTAssertEqual(events.all, ["created", "activated", "deactivated", "activated"])

        let screen = managed.getActiveModule()!
        XCTAssertEqual(screen.getState()["visits"] as? Int, 2)

        managed.stop()
        XCTAssertEqual(
            events.all,
            ["created", "activated", "deactivated", "activated", "deactivated", "destroyed"]
        )
    }

    func testModuleStateSurvivesNavigationAwayAndBack_noLoadingFlash() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let created = TestCounter(0)
        let _ = app.module("Items")
            .defineState(["loading": true, "items": [String]()])
            .onCreated { state in
                created.mutate { $0 += 1 }
                // Simulate immediate data load.
                state.set("items", ["a", "b", "c"])
                state.set("loading", false)
            }
            .build()
        let _ = app.module("Other").defineState(["x": 0]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/items", component: "Items"))
        managed.addRoute(RouteDefinition(path: "/other", component: "Other"))

        router.push("/items")
        managed.start()
        XCTAssertEqual(created.current, 1)
        let first = managed.getActiveModule()!.getState()
        XCTAssertEqual(first["loading"] as? Bool, false)
        XCTAssertEqual(first["items"] as? [String], ["a", "b", "c"])

        router.push("/other")
        router.push("/items")

        // onCreated must NOT have re-run — module persisted.
        XCTAssertEqual(created.current, 1)
        let second = managed.getActiveModule()!.getState()
        XCTAssertEqual(second["loading"] as? Bool, false)
        XCTAssertEqual(second["items"] as? [String], ["a", "b", "c"])

        managed.stop()
    }

    func testPersistentModuleSurvivesNavigation() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let _ = app.module("Counter")
            .defineState(["count": 0], options: ModuleOptions(persist: true))
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()
        let _ = app.module("Other").defineState(["x": 0]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/counter", component: "Counter"))
        managed.addRoute(RouteDefinition(path: "/other", component: "Other"))

        router.push("/counter")
        managed.start()

        // Increment counter
        let module = managed.getActiveModule()!
        module.dispatchAction("increment")
        XCTAssertEqual(module.getState()["count"] as? Int, 1)

        // Navigate away
        router.push("/other")

        // Counter module should still be registered (persisted)
        XCTAssertTrue(ctx.hasModule("counter"))

        // Navigate back
        router.push("/counter")
        let restored = managed.getActiveModule()!
        XCTAssertEqual(restored.getState()["count"] as? Int, 1) // State preserved

        managed.stop()
    }

    func testNoRemountOnSameRoute() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let createCount = TestCounter(0)
        let _ = app.module("Page").defineState(["x": 0])
            .onCreated { _ in createCount.mutate { $0 += 1 } }
            .build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/page", component: "Page"))

        router.push("/page")
        managed.start()
        XCTAssertEqual(createCount.current, 1)

        // Push same route again
        router.push("/page")
        XCTAssertEqual(createCount.current, 1) // Should not recreate

        managed.stop()
    }

    func testUnmatchedRouteUnmountsActive() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let _ = app.module("Page").defineState(["x": 0]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/page", component: "Page"))

        router.push("/page")
        managed.start()
        XCTAssertNotNil(managed.getActiveModule())

        router.push("/unknown")
        XCTAssertNil(managed.getActiveModule())

        managed.stop()
    }

    func testStopDestroysAll() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let destroyed = TestCounter(false)
        let _ = app.module("Page").defineState(["x": 0])
            .onDestroyed { _ in destroyed.set(true) }
            .build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/", component: "Page"))
        managed.start()

        managed.stop()
        XCTAssertTrue(destroyed.current)
        XCTAssertNil(managed.getActiveModule())
    }

    func testInlineModuleDefinition() {
        let router = HypenRouter()
        let app = HypenApp()
        let ctx = HypenGlobalContext(router: router)

        let inlineDef = AppBuilder(["inline": true]).build()

        let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
        managed.addRoute(RouteDefinition(path: "/", component: "Inline", module: inlineDef))
        managed.start()

        XCTAssertNotNil(managed.getActiveModule())
        XCTAssertEqual(managed.getActiveModule()?.getState()["inline"] as? Bool, true)

        managed.stop()
    }
}
