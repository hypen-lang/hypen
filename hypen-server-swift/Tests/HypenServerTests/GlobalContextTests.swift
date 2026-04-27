import XCTest
@testable import HypenServer

final class GlobalContextTests: XCTestCase {
    func testRegisterAndGetModule() {
        let ctx = HypenGlobalContext()
        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        ctx.registerModule("counter", instance: instance)

        XCTAssertTrue(ctx.hasModule("counter"))
        XCTAssertFalse(ctx.hasModule("nonexistent"))

        let ref = ctx.getModule("counter")
        XCTAssertNotNil(ref)
        XCTAssertEqual(ref?.id, "counter")
    }

    func testCrossModuleDispatch() {
        let ctx = HypenGlobalContext()

        let def = AppBuilder(["count": 0])
            .onAction("increment") { ctx in
                let count = ctx.state.get("count") as? Int ?? 0
                ctx.state.set("count", count + 1)
            }
            .build()
        let counter = try! ModuleInstance(definition: def)
        ctx.registerModule("counter", instance: counter)

        // Dispatch from "outside" via reference
        let ref = ctx.getModule("counter")!
        XCTAssertEqual(ref.getState()["count"] as? Int, 0)

        ref.dispatchAction("increment")
        XCTAssertEqual(ref.getState()["count"] as? Int, 1)
    }

    func testGetModuleIds() {
        let ctx = HypenGlobalContext()

        let def1 = AppBuilder(["x": 0]).build()
        let def2 = AppBuilder(["y": 0]).build()

        ctx.registerModule("a", instance: try! ModuleInstance(definition: def1))
        ctx.registerModule("b", instance: try! ModuleInstance(definition: def2))

        let ids = ctx.getModuleIds()
        XCTAssertEqual(Set(ids), Set(["a", "b"]))
    }

    func testGetGlobalState() {
        let ctx = HypenGlobalContext()

        let def1 = AppBuilder(["count": 5]).build()
        let def2 = AppBuilder(["name": "Alice"]).build()

        ctx.registerModule("counter", instance: try! ModuleInstance(definition: def1))
        ctx.registerModule("profile", instance: try! ModuleInstance(definition: def2))

        let global = ctx.getGlobalState()
        let counterState = global["counter"] as? [String: Any]
        let profileState = global["profile"] as? [String: Any]

        XCTAssertEqual(counterState?["count"] as? Int, 5)
        XCTAssertEqual(profileState?["name"] as? String, "Alice")
    }

    func testEventEmitAndOn() {
        let ctx = HypenGlobalContext()
        var received = false

        let unsub = ctx.on("test:event") { payload in
            received = true
            XCTAssertEqual(payload as? String, "hello")
        }

        ctx.emit("test:event", payload: "hello")
        XCTAssertTrue(received)

        received = false
        unsub()
        ctx.emit("test:event", payload: "hello again")
        XCTAssertFalse(received)
    }

    func testUnregisterModule() {
        let ctx = HypenGlobalContext()
        let def = AppBuilder(["x": 0]).build()
        ctx.registerModule("temp", instance: try! ModuleInstance(definition: def))

        XCTAssertTrue(ctx.hasModule("temp"))
        ctx.unregisterModule("temp")
        XCTAssertFalse(ctx.hasModule("temp"))
    }

    func testRouterAccess() {
        let router = HypenRouter()
        let ctx = HypenGlobalContext(router: router)

        XCTAssertNotNil(ctx.getRouter())
        router.push("/test")
        XCTAssertEqual(ctx.getRouter()?.getCurrentPath(), "/test")
    }
}
