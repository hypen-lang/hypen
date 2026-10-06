#if os(iOS)
import XCTest
import Combine
@testable import HypenSwift

@MainActor
final class DeviceNativeSocketTests: XCTestCase {
    func testNativePermissionQueryOverWebSocket() async throws {
        // Opt in by running only this test with the fixture server listening.
        guard ProcessInfo.processInfo.environment["HYPEN_NATIVE_E2E"] == "1" else {
            throw XCTSkip("Set HYPEN_NATIVE_E2E=1 and run device-native-probe-server.ts")
        }
        let host = DeviceHost.iOS()
        let url = ProcessInfo.processInfo.environment["HYPEN_NATIVE_E2E_URL"] ?? "ws://127.0.0.1:44990"
        let engine = RemoteEngine(url: URL(string: url)!,
            config: .init(autoReconnect: false, upgradeHeaders: ["Authorization": "Bearer native-probe"]), device: host)
        let connected = expectation(description: "session established")
        let returned = expectation(description: "native permission response returned through server state")
        var tokens = Set<AnyCancellable>()
        engine.sessionEstablished.sink { _ in connected.fulfill() }.store(in: &tokens)
        engine.patches.sink { patches in
            for patch in patches {
                if let text = patch.value as? String, text.hasPrefix("native-probe:") {
                    XCTAssertTrue(text.contains("\"supported\":true"), text)
                    XCTAssertTrue(text.contains("\"ok\":true"), text)
                    XCTAssertTrue(text.contains("\"status\":"), text)
                    returned.fulfill()
                }
            }
        }.store(in: &tokens)
        defer { engine.disconnect() }
        engine.connect()
        await fulfillment(of: [connected], timeout: 15)
        engine.dispatchAction("probe")
        await fulfillment(of: [returned], timeout: 15)
    }
}
#endif
