import XCTest
@testable import HypenServer

/// Nested-router auto-wiring parity test. Mirrors the TypeScript
/// `hypen-web/tests/nested-router-auto-wire.test.ts`.
///
/// When a per-route module's template itself contains a
/// `Router { Route ... }` block, the Swift SDK's
/// `autoWireManagedRouter` flattens every discovered router's routes —
/// primary and nested — into a single `ManagedRouter` against the
/// session's one `HypenRouter`. Nested routes share the parent's URL
/// space; authors spell out the full path in each `Route(path:)`.
///
/// This test guards against regressions in `RemoteSession.autoWireManagedRouter`
/// (hypen-server-swift/Sources/HypenServer/Remote/RemoteSession.swift) —
/// specifically the decision in commit 77fadf05 to stop filtering out
/// nested (non-top-level) routers from the discovery results.
final class NestedRouterAutoWireTests: XCTestCase {
    private var tmpDir: URL?

    override func tearDown() {
        if let dir = tmpDir {
            try? FileManager.default.removeItem(at: dir)
            tmpDir = nil
        }
        super.tearDown()
    }

    /// Materialise a component tree on disk so `RemoteServer.componentsDir`
    /// can discover it. Each entry becomes `<dir>/<name>/component.hypen`.
    private func writeComponents(_ entries: [String: String]) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypen-nested-router-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true
        )
        for (name, dsl) in entries {
            let sub = dir.appendingPathComponent(name)
            try FileManager.default.createDirectory(
                at: sub, withIntermediateDirectories: true
            )
            let file = sub.appendingPathComponent("component.hypen")
            try dsl.write(to: file, atomically: true, encoding: .utf8)
        }
        return dir
    }

    func testNestedRouteInPerRouteModuleIsNavigable() throws {
        // Fresh HypenApp per test to avoid cross-test pollution of the
        // shared registry (HypenApp.shared).
        let testApp = HypenApp()

        let dir = try writeComponents([
            "App": """
            module App {
                Router {
                    Route(path: "/") { Home() }
                    Route(path: "/settings") { Settings() }
                }
            }
            """,
            // Home's own Router is the nested block. Pre-3.4 the SDK
            // silently skipped these — the session's ManagedRouter had
            // no entry for "/home/feed", so nav pushed the URL but
            // never mirrored into state.location.
            "Home": """
            module Home {
                Column {
                    Text("home-root")
                    Router {
                        Route(path: "/home/feed") { Feed() }
                        Route(path: "/home/explore") { Explore() }
                    }
                }
            }
            """,
            "Feed": "module Feed { Text(\"feed-body\") }",
            "Explore": "module Explore { Text(\"explore-body\") }",
            "Settings": "module Settings { Text(\"settings-body\") }",
        ])
        tmpDir = dir

        // Primary module — carries the `location` field so the
        // auto-wired ManagedRouter's onNavigate mirror has somewhere
        // to land.
        _ = testApp.module("App")
            .defineState(["location": "/"])
            .build()
        _ = testApp.module("Home").defineState([:]).build()
        _ = testApp.module("Feed").defineState([:]).build()
        _ = testApp.module("Explore").defineState([:]).build()
        _ = testApp.module("Settings").defineState([:]).build()

        let primary = testApp.get("App")!

        let server = RemoteServer()
            .app(testApp)
            .module("App", primary)
            .ui("""
            module App {
                Router {
                    Route(path: "/") { Home() }
                    Route(path: "/settings") { Settings() }
                }
            }
            """)
        _ = try server.componentsDir(dir.path)
        try server.prepare()
        defer { server.stop() }

        let transport = AsyncStreamTransport()
        let session = try server.createSession(
            transport: transport,
            helloGraceMs: nil
        )

        // Complete hello -> sessionAck -> initialTree handshake.
        // `initializeSession` runs synchronously inside `receive` and
        // fires `autoWireManagedRouter` at the end, so by the time
        // `receive` returns the session's ManagedRouter is wired.
        session.receive("{\"type\":\"hello\"}")
        XCTAssertNotNil(session.currentSessionID, "hello should complete synchronously")

        // Push to the nested route. If auto-wire flattened nested
        // routers, the session's ManagedRouter has "/home/feed"
        // registered and navigating there mirrors into state.location.
        session.receive("""
        {"type":"dispatchAction","action":"router.push","payload":{"to":"/home/feed"}}
        """)

        // The router mirror runs on DispatchQueue.global() (see
        // autoWireManagedRouter), so poll briefly for the write to
        // settle.
        let deadline = Date().addingTimeInterval(2.0)
        var observed: String?
        while Date() < deadline {
            if let loc = session.currentState()["location"] as? String,
               loc == "/home/feed" {
                observed = loc
                break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }

        XCTAssertEqual(
            observed, "/home/feed",
            "Auto-wire should register nested-router routes so router.push mirrors into state.location"
        )

        session.destroy()
    }

    /// Regression guard for P2-B. Pre-fix, `autoWireManagedRouter` built
    /// a fresh `HypenGlobalContext` but never registered the primary
    /// `ModuleInstance` into it, so any routed module calling
    /// `context.getModule("app")` got nil under Swift — diverging from
    /// TS/Kotlin which both register. This broke cross-module reads for
    /// routed screens that depend on app-level state (e.g. the
    /// `currentUser` pattern used in Social examples).
    ///
    /// We verify it end-to-end: register a "checkApp" action on Home
    /// whose handler stashes whether `context.getModule("app")` was
    /// non-nil and reports the app's `currentUser` sentinel. After
    /// initial mount of Home, dispatch the action and assert the
    /// handler observed a non-nil primary.
    func testAutoWirePrimaryVisibleToRoutedModules() throws {
        let testApp = HypenApp()

        let dir = try writeComponents([
            "App": "module App { Router { Route(path: \"/\") { Home() } } }",
            "Home": "module Home { Text(\"home-root\") }",
        ])
        tmpDir = dir

        _ = testApp.module("App")
            .defineState([
                "location": "/",
                "currentUser": "alice",
            ])
            .build()

        // Captured via reference-semantic class so the closure's
        // mutations are visible from the test after dispatch. `@unchecked
        // Sendable` because the test reads these fields on the main
        // thread after a brief poll — there is no concurrent writer.
        final class Probe: @unchecked Sendable {
            var sawPrimary = false
            var userSentinel: String? = nil
        }
        let probe = Probe()

        _ = testApp.module("Home")
            .defineState([:])
            .onAction("checkApp") { actionCtx in
                guard let ctx = actionCtx.context else { return }
                guard let ref = ctx.getModule("app") else { return }
                probe.sawPrimary = true
                let state = ref.getState()
                if let user = state["currentUser"] as? String {
                    probe.userSentinel = user
                }
            }
            .build()

        let primary = testApp.get("App")!

        let server = RemoteServer()
            .app(testApp)
            .module("App", primary)
            .ui("module App { Router { Route(path: \"/\") { Home() } } }")
        _ = try server.componentsDir(dir.path)
        try server.prepare()
        defer { server.stop() }

        let transport = AsyncStreamTransport()
        let session = try server.createSession(
            transport: transport,
            helloGraceMs: nil
        )
        session.receive("{\"type\":\"hello\"}")
        XCTAssertNotNil(session.currentSessionID)

        // Home mounts at "/" via the auto-router's initial mount, so
        // the probe action is addressable.
        session.receive("""
        {"type":"dispatchAction","module":"Home","action":"checkApp","payload":{}}
        """)

        // Wait briefly for the dispatch to settle (handler runs on the
        // session's queue).
        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if probe.sawPrimary { break }
            Thread.sleep(forTimeInterval: 0.02)
        }

        XCTAssertTrue(
            probe.sawPrimary,
            "context.getModule(\"app\") returned nil from a routed module — primary was not registered in the auto-wire GlobalContext (P2-B regressed)."
        )
        XCTAssertEqual(
            probe.userSentinel, "alice",
            "primary snapshot via getModule(\"app\").getState() should carry the app-level sentinel"
        )

        session.destroy()
    }

    /// P1-A regression guard (TS commit 9adcb3f2 ported to Swift).
    ///
    /// Pre-fix, `autoWireManagedRouter` passed only `host.uiTemplate` to
    /// `engine.discoverRouters(source:)`, so any `Router {}` declared
    /// inside a child component's template (e.g. `Home/component.hypen`)
    /// was invisible to the session's ManagedRouter. The previous 3.4
    /// test (`testNestedRouteInPerRouteModuleIsNavigable`) happened to
    /// pass because the `state.location` mirror fires on any
    /// `router.push`, not just on ones where ManagedRouter actually
    /// mounted a target — so it could not distinguish "navigated" from
    /// "mounted". This test dispatches an action to a module that only
    /// exists on a nested-only route, proving it was actually mounted.
    func testNestedRouterInChildTemplateMountsRouteTarget() throws {
        let testApp = HypenApp()

        // Note: the primary template has NO "/home/feed" route. That
        // route is declared exclusively inside Home's own template. Pre-
        // fix, the auto-wire would never see it, Feed would never mount,
        // and the probe dispatch below would silently no-op.
        let dir = try writeComponents([
            "App": "module App { Router { Route(path: \"/\") { Home() } } }",
            "Home": """
            module Home {
                Column {
                    Text(\"home\")
                    Router {
                        Route(path: \"/home/feed\") { Feed() }
                    }
                }
            }
            """,
            "Feed": "module Feed { Text(\"feed-body\") }",
        ])
        tmpDir = dir

        _ = testApp.module("App")
            .defineState(["location": "/"])
            .build()
        _ = testApp.module("Home").defineState([:]).build()

        // Reference-semantic probe (same pattern as
        // testAutoWirePrimaryVisibleToRoutedModules).
        final class Probe: @unchecked Sendable {
            var fired = false
        }
        let probe = Probe()

        _ = testApp.module("Feed")
            .defineState([:])
            .onAction("probe") { _ in
                probe.fired = true
            }
            .build()

        let primary = testApp.get("App")!

        let server = RemoteServer()
            .app(testApp)
            .module("App", primary)
            .ui("module App { Router { Route(path: \"/\") { Home() } } }")
        _ = try server.componentsDir(dir.path)
        try server.prepare()
        defer { server.stop() }

        let transport = AsyncStreamTransport()
        let session = try server.createSession(
            transport: transport,
            helloGraceMs: nil
        )
        session.receive("{\"type\":\"hello\"}")
        XCTAssertNotNil(session.currentSessionID)

        // Navigate to the nested-only route. If the P1-A fix is in
        // place, auto-wire saw Home's template, registered "/home/feed"
        // with ManagedRouter, and pushing here mounts Feed (whose probe
        // handler gets installed via ModuleInstance.init → engine.onAction).
        session.receive("""
        {"type":"dispatchAction","action":"router.push","payload":{"to":"/home/feed"}}
        """)

        // Give ManagedRouter a beat to mount Feed before dispatching the
        // probe — router mirror runs on DispatchQueue.global() and
        // mount itself happens inside the onNavigate callback chain.
        let mountDeadline = Date().addingTimeInterval(1.0)
        while Date() < mountDeadline {
            if (session.currentState()["location"] as? String) == "/home/feed" { break }
            Thread.sleep(forTimeInterval: 0.02)
        }

        session.receive("""
        {"type":"dispatchAction","module":"Feed","action":"probe","payload":{}}
        """)

        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if probe.fired { break }
            Thread.sleep(forTimeInterval: 0.02)
        }

        XCTAssertTrue(
            probe.fired,
            "Feed.probe did not fire — ManagedRouter never mounted Feed, proving the nested Router in Home/component.hypen was invisible to autoWireManagedRouter (P1-A regressed)."
        )

        session.destroy()
    }
}
