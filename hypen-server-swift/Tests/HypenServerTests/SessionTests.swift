import XCTest
@testable import HypenServer

final class SessionTests: XCTestCase {
    func testCreateSession() {
        let manager = SessionManager()
        let session = manager.createSession()
        XCTAssertFalse(session.id.isEmpty)
        XCTAssertNotNil(manager.getActiveSession(session.id))
    }

    func testCreateSessionWithProps() {
        let manager = SessionManager()
        let session = manager.createSession(props: ["platform": "ios"])
        XCTAssertEqual(session.props["platform"] as? String, "ios")
    }

    func testSuspendAndResume() {
        let manager = SessionManager(config: SessionConfig(ttl: 60))
        let session = manager.createSession()
        let state: [String: Any] = ["count": 42]

        manager.suspendSession(session.id, savedState: state) {}

        // Active session should be gone
        XCTAssertNil(manager.getActiveSession(session.id))

        // Resume
        let pending = manager.resumeSession(session.id)
        XCTAssertNotNil(pending)
        XCTAssertEqual(pending?.savedState["count"] as? Int, 42)

        // Should be active again
        XCTAssertNotNil(manager.getActiveSession(session.id))
    }

    func testResumeNonexistent() {
        let manager = SessionManager()
        XCTAssertNil(manager.resumeSession("nonexistent"))
    }

    func testDestroySession() {
        let manager = SessionManager()
        let session = manager.createSession()
        XCTAssertNotNil(manager.getActiveSession(session.id))

        manager.destroySession(session.id)
        XCTAssertNil(manager.getActiveSession(session.id))
    }

    func testConnectionTracking() {
        // Tracking two live connections needs allowMultiple — under the
        // default kickOld policy the engine kicks the first connection.
        let manager = SessionManager(config: SessionConfig(concurrent: .allowMultiple))
        let session = manager.createSession()

        let obj1 = NSObject()
        let obj2 = NSObject()
        let conn1 = ObjectIdentifier(obj1)
        let conn2 = ObjectIdentifier(obj2)

        manager.trackConnection(session.id, connectionId: conn1)
        XCTAssertEqual(manager.getConnectionCount(session.id), 1)

        manager.trackConnection(session.id, connectionId: conn2)
        XCTAssertEqual(manager.getConnectionCount(session.id), 2)

        manager.untrackConnection(session.id, connectionId: conn1)
        XCTAssertEqual(manager.getConnectionCount(session.id), 1)
    }

    func testGetStats() {
        let manager = SessionManager(config: SessionConfig(ttl: 60))
        let s1 = manager.createSession()
        let _ = manager.createSession()

        let statsObj = NSObject()
        manager.trackConnection(s1.id, connectionId: ObjectIdentifier(statsObj))

        let stats = manager.getStats()
        XCTAssertEqual(stats.activeSessions, 2)
        XCTAssertEqual(stats.pendingSessions, 0)
        XCTAssertEqual(stats.totalConnections, 1)
    }

    func testSessionExpiry() {
        let config = SessionConfig(ttl: 1) // 1 second TTL
        let manager = SessionManager(config: config)
        let session = manager.createSession()
        let expectation = XCTestExpectation(description: "Session expired")

        manager.suspendSession(session.id, savedState: ["count": 0]) {
            expectation.fulfill()
        }

        wait(for: [expectation], timeout: 3.0)

        // After expiry, resume should fail
        XCTAssertNil(manager.resumeSession(session.id))
    }

    func testShutdown() {
        let manager = SessionManager()
        let _ = manager.createSession()
        let _ = manager.createSession()

        manager.shutdown()

        let stats = manager.getStats()
        XCTAssertEqual(stats.activeSessions, 0)
        XCTAssertEqual(stats.pendingSessions, 0)
    }

    func testCustomIdGenerator() {
        let counter = TestCounter(0)
        let config = SessionConfig(generateId: {
            counter.mutate { $0 += 1 }
            return "session-\(counter.current)"
        })
        let manager = SessionManager(config: config)

        let s1 = manager.createSession()
        let s2 = manager.createSession()
        XCTAssertEqual(s1.id, "session-1")
        XCTAssertEqual(s2.id, "session-2")
    }
}
