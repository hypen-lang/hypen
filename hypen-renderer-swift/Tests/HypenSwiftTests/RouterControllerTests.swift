import Testing
@testable import HypenSwift

// MARK: - RouterController Tests

@Test func testRouterInitialState() async {
    await MainActor.run {
        let router = RouterController()

        #expect(router.state.currentPath == "/")
        #expect(router.state.previousPath == nil)
        #expect(router.state.query.isEmpty == true)
    }
}

@Test func testRouterPush() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")

        #expect(router.state.currentPath == "/users")
        #expect(router.state.previousPath == "/")
    }
}

@Test func testRouterBack() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")
        router.push("/settings")
        router.back()

        #expect(router.state.currentPath == "/users")
        #expect(router.state.previousPath == "/settings")
    }
}

@Test func testRouterForward() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")
        router.push("/settings")
        router.back()
        router.forward()

        #expect(router.state.currentPath == "/settings")
        #expect(router.state.previousPath == "/users")
    }
}

@Test func testRouterBackAtStartIsNoop() async {
    await MainActor.run {
        let router = RouterController()
        let pathBefore = router.state.currentPath

        router.back()

        #expect(router.state.currentPath == pathBefore)
    }
}

@Test func testRouterForwardAtEndIsNoop() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")
        let pathBefore = router.state.currentPath

        router.forward()

        #expect(router.state.currentPath == pathBefore)
    }
}

@Test func testRouterReplace() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")
        router.replace("/settings")

        #expect(router.state.currentPath == "/settings")

        // Going back should skip the replaced path
        router.back()
        #expect(router.state.currentPath == "/")
    }
}

@Test func testRouterPushClearsForwardHistory() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/a")
        router.push("/b")
        router.push("/c")
        router.back()
        router.back()

        #expect(router.state.currentPath == "/a")

        // Push clears /b and /c from forward history
        router.push("/d")

        router.forward()
        // Forward should be a no-op since forward history was cleared
        #expect(router.state.currentPath == "/d")
    }
}

@Test func testRouterPushSamePathIgnored() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")
        let previousPath = router.state.previousPath

        router.push("/users")

        // Should not change since it's the same path
        #expect(router.state.currentPath == "/users")
        #expect(router.state.previousPath == previousPath)
    }
}

@Test func testRouterMatchPathExactMatch() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")

        let match = router.matchPath(pattern: "/users")

        #expect(match != nil)
        #expect(match?.path == "/users")
    }
}

@Test func testRouterMatchPathNoMatch() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")

        let match = router.matchPath(pattern: "/settings")

        #expect(match == nil)
    }
}

@Test func testRouterMatchPathWithWildcard() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/docs/getting-started")

        let match = router.matchPath(pattern: "/docs/*")

        #expect(match != nil)
        #expect(match?.path == "/docs/getting-started")
    }
}

@Test func testRouterQueryStringParsing() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/search?sort=asc&limit=10")

        #expect(router.state.currentPath == "/search")
        #expect(router.state.query["sort"] == "asc")
        #expect(router.state.query["limit"] == "10")
    }
}

@Test func testRouterSync() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/a")
        router.push("/b")

        router.sync("/external")

        #expect(router.state.currentPath == "/external")

        // History is reset, so back should be a no-op
        router.back()
        #expect(router.state.currentPath == "/external")
    }
}

@Test func testRouterIsActive() async {
    await MainActor.run {
        let router = RouterController()

        router.push("/users")

        #expect(router.isActive("/users") == true)
        #expect(router.isActive("/settings") == false)
    }
}

@Test func testRouterPathNormalization() async {
    await MainActor.run {
        let router = RouterController(initialPath: "no-slash")

        #expect(router.state.currentPath == "/no-slash")
    }
}
