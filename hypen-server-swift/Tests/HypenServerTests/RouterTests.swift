import XCTest
@testable import HypenServer

final class RouterTests: XCTestCase {
    func testBasicNavigation() {
        let router = HypenRouter()
        XCTAssertEqual(router.getCurrentPath(), "/")

        router.push("/counter")
        XCTAssertEqual(router.getCurrentPath(), "/counter")

        router.push("/profile")
        XCTAssertEqual(router.getCurrentPath(), "/profile")
    }

    func testBack() {
        let router = HypenRouter()
        router.push("/a")
        router.push("/b")
        XCTAssertEqual(router.getCurrentPath(), "/b")

        router.back()
        XCTAssertEqual(router.getCurrentPath(), "/a")
    }

    func testReplace() {
        let router = HypenRouter()
        router.push("/a")
        router.replace("/b")
        XCTAssertEqual(router.getCurrentPath(), "/b")

        // Back should go to "/" not "/a" since we replaced
        router.back()
        XCTAssertEqual(router.getCurrentPath(), "/")
    }

    func testOnNavigate() {
        let router = HypenRouter()
        var changes: [(String?, String)] = []

        router.onNavigate { from, to in
            changes.append((from, to))
        }

        router.push("/a")
        router.push("/b")

        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes[0].0, "/")
        XCTAssertEqual(changes[0].1, "/a")
        XCTAssertEqual(changes[1].0, "/a")
        XCTAssertEqual(changes[1].1, "/b")
    }

    func testUnsubscribeNavigate() {
        let router = HypenRouter()
        var count = 0

        let unsub = router.onNavigate { _, _ in count += 1 }
        router.push("/a")
        XCTAssertEqual(count, 1)

        unsub()
        router.push("/b")
        XCTAssertEqual(count, 1) // Should not increment
    }

    func testMatchPathLiteral() {
        let router = HypenRouter()
        let match = router.matchPath(pattern: "/users/list", path: "/users/list")
        XCTAssertNotNil(match)
        XCTAssertTrue(match!.params.isEmpty)
    }

    func testMatchPathMismatch() {
        let router = HypenRouter()
        XCTAssertNil(router.matchPath(pattern: "/users/list", path: "/users/edit"))
        XCTAssertNil(router.matchPath(pattern: "/users/list", path: "/users"))
    }

    func testMatchPathParams() {
        let router = HypenRouter()
        let match = router.matchPath(pattern: "/users/:id", path: "/users/42")
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.params["id"], "42")
    }

    func testMatchPathMultipleParams() {
        let router = HypenRouter()
        let match = router.matchPath(pattern: "/users/:userId/posts/:postId", path: "/users/5/posts/99")
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.params["userId"], "5")
        XCTAssertEqual(match?.params["postId"], "99")
    }

    func testMatchPathWildcard() {
        let router = HypenRouter()
        let match = router.matchPath(pattern: "/files/*", path: "/files/anything")
        XCTAssertNotNil(match)
    }

    func testMatchPathQuery() {
        let router = HypenRouter()
        let match = router.matchPath(pattern: "/search", path: "/search?q=hello&page=2")
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.query["q"], "hello")
        XCTAssertEqual(match?.query["page"], "2")
    }

    func testIsActive() {
        let router = HypenRouter()
        router.push("/counter")
        XCTAssertTrue(router.isActive("/counter"))
        XCTAssertFalse(router.isActive("/profile"))
    }

    func testBuildUrl() {
        let router = HypenRouter()
        XCTAssertEqual(router.buildUrl("/search"), "/search")
        XCTAssertEqual(
            router.buildUrl("/search", query: ["q": "hello"]),
            "/search?q=hello"
        )
    }

    func testGetState() {
        let router = HypenRouter()
        router.push("/test?key=value")

        let state = router.getState()
        XCTAssertEqual(state.currentPath, "/test")
        XCTAssertEqual(state.query["key"], "value")
        XCTAssertEqual(state.previousPath, "/")
    }
}
