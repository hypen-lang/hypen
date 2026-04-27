import XCTest
@testable import HypenServer

final class EventsTests: XCTestCase {
    func testBasicEmitAndListen() {
        let emitter = TypedEventEmitter()
        let expectation = XCTestExpectation(description: "Event received")

        emitter.on(HypenEvents.moduleCreated) { event in
            XCTAssertEqual(event.moduleId, "counter")
            expectation.fulfill()
        }

        emitter.emit(HypenEvents.moduleCreated, payload: .init(moduleId: "counter"))
        wait(for: [expectation], timeout: 1.0)
    }

    func testUnsubscribe() {
        let emitter = TypedEventEmitter()
        var count = 0

        let unsub = emitter.on(HypenEvents.moduleCreated) { _ in
            count += 1
        }

        emitter.emit(HypenEvents.moduleCreated, payload: .init(moduleId: "a"))
        XCTAssertEqual(count, 1)

        unsub()
        emitter.emit(HypenEvents.moduleCreated, payload: .init(moduleId: "b"))
        XCTAssertEqual(count, 1) // Should not increment
    }

    func testOnce() {
        let emitter = TypedEventEmitter()
        var count = 0

        emitter.once(HypenEvents.moduleDestroyed) { _ in
            count += 1
        }

        emitter.emit(HypenEvents.moduleDestroyed, payload: .init(moduleId: "a"))
        emitter.emit(HypenEvents.moduleDestroyed, payload: .init(moduleId: "b"))
        XCTAssertEqual(count, 1) // Should only fire once
    }

    func testMultipleListeners() {
        let emitter = TypedEventEmitter()
        var results: [String] = []

        emitter.on(HypenEvents.routeChanged) { event in
            results.append("listener1:\(event.to)")
        }
        emitter.on(HypenEvents.routeChanged) { event in
            results.append("listener2:\(event.to)")
        }

        emitter.emit(HypenEvents.routeChanged, payload: .init(from: nil, to: "/home"))
        XCTAssertEqual(results, ["listener1:/home", "listener2:/home"])
    }

    func testCustomEventKey() {
        let myEvent = EventKey<String>("custom:event")
        let emitter = TypedEventEmitter()
        let expectation = XCTestExpectation(description: "Custom event")

        emitter.on(myEvent) { value in
            XCTAssertEqual(value, "hello")
            expectation.fulfill()
        }

        emitter.emit(myEvent, payload: "hello")
        wait(for: [expectation], timeout: 1.0)
    }

    func testListenerCount() {
        let emitter = TypedEventEmitter()

        XCTAssertEqual(emitter.listenerCount(HypenEvents.moduleCreated), 0)

        let unsub1 = emitter.on(HypenEvents.moduleCreated) { _ in }
        XCTAssertEqual(emitter.listenerCount(HypenEvents.moduleCreated), 1)

        let unsub2 = emitter.on(HypenEvents.moduleCreated) { _ in }
        XCTAssertEqual(emitter.listenerCount(HypenEvents.moduleCreated), 2)

        unsub1()
        XCTAssertEqual(emitter.listenerCount(HypenEvents.moduleCreated), 1)

        unsub2()
        XCTAssertEqual(emitter.listenerCount(HypenEvents.moduleCreated), 0)
    }

    func testClearAll() {
        let emitter = TypedEventEmitter()

        emitter.on(HypenEvents.moduleCreated) { _ in }
        emitter.on(HypenEvents.routeChanged) { _ in }

        XCTAssertEqual(emitter.eventNames().count, 2)

        emitter.clearAll()
        XCTAssertEqual(emitter.eventNames().count, 0)
    }
}
