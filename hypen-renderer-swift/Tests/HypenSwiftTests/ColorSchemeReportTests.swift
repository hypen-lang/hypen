import XCTest
@testable import HypenSwift

// The system color scheme report of the Remote UI protocol: `hello.colorScheme`
// and the `colorScheme` message (wire shapes), and the bookkeeping behind
// `RemoteEngine.setColorScheme(_:)` — a change is sent once, an unchanged
// value sends nothing, and the value is carried by the hello of a reconnect.

final class ColorSchemeReportTests: XCTestCase {
    func testHelloOmitsColorSchemeWhenNoneIsReported() {
        let credential = RemoteResumeCredential()
        let legacy = RemoteHello.message(sessionId: nil, credential: credential, props: nil, device: nil)
        XCTAssertNil(legacy["colorScheme"])
        XCTAssertEqual(legacy.count, 1, "only `type`: the legacy hello is unchanged")

        let explicitNil = RemoteHello.message(sessionId: "s-1", credential: credential, props: nil, device: nil,
                                              colorScheme: nil)
        XCTAssertNil(explicitNil["colorScheme"])
    }

    func testHelloCarriesColorScheme() throws {
        let credential = RemoteResumeCredential()
        let dark = RemoteHello.message(sessionId: nil, credential: credential, props: nil, device: nil,
                                       colorScheme: .dark)
        XCTAssertEqual(dark["type"] as? String, "hello")
        XCTAssertEqual(dark["colorScheme"] as? String, "dark")

        let light = RemoteHello.message(sessionId: "s-1", credential: credential, props: ["platform": "ios"],
                                        device: nil, colorScheme: .light)
        XCTAssertEqual(light["colorScheme"] as? String, "light")
        XCTAssertEqual(light["sessionId"] as? String, "s-1")

        // As it goes on the wire.
        let data = try JSONSerialization.data(withJSONObject: dark, options: [.sortedKeys])
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"colorScheme":"dark","type":"hello"}"#)
    }

    func testColorSchemeMessageWireShape() throws {
        let dark = RemoteColorSchemeReport.message(.dark)
        XCTAssertEqual(dark as? [String: String], ["type": "colorScheme", "scheme": "dark"])
        let data = try JSONSerialization.data(withJSONObject: RemoteColorSchemeReport.message(.light),
                                              options: [.sortedKeys])
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"scheme":"light","type":"colorScheme"}"#)
    }

    func testWireNames() {
        XCTAssertEqual(HypenColorScheme.light.rawValue, "light")
        XCTAssertEqual(HypenColorScheme.dark.rawValue, "dark")
    }

    func testReportingOptionNamesItsFixedScheme() {
        XCTAssertNil(ColorSchemeReporting.auto.fixedScheme)
        XCTAssertNil(ColorSchemeReporting.off.fixedScheme)
        XCTAssertEqual(ColorSchemeReporting.light.fixedScheme, .light)
        XCTAssertEqual(ColorSchemeReporting.dark.fixedScheme, .dark)
        XCTAssertEqual(RemoteEngineConfig.default.colorScheme, .auto)
        XCTAssertEqual(RemoteEngineConfig(colorScheme: .dark).colorScheme, .dark)
    }

    func testSchemeSetBeforeTheHelloIsCarriedByItOnly() {
        var report = RemoteColorSchemeReport()
        XCTAssertNil(report.scheme)
        XCTAssertNil(report.report(.dark, helloSent: false), "nothing to send: the hello carries it")
        XCTAssertEqual(report.scheme, .dark)
    }

    func testChangeWhileConnectedIsSentOnceAndUnchangedSendsNothing() {
        var report = RemoteColorSchemeReport(initial: .light)
        XCTAssertNil(report.report(.light, helloSent: true), "unchanged value sends nothing")

        let message = report.report(.dark, helloSent: true)
        XCTAssertEqual(message as? [String: String], ["type": "colorScheme", "scheme": "dark"])
        XCTAssertEqual(report.scheme, .dark)

        XCTAssertNil(report.report(.dark, helloSent: true), "the same value again sends nothing")
    }

    func testReconnectHelloCarriesTheRememberedScheme() {
        var report = RemoteColorSchemeReport(initial: .light)
        _ = report.report(.dark, helloSent: true)
        // The socket ended; a change while down is only remembered.
        XCTAssertNil(report.report(.light, helloSent: false))

        let hello = RemoteHello.message(sessionId: "s-1", credential: RemoteResumeCredential(), props: nil,
                                        device: nil, colorScheme: report.scheme)
        XCTAssertEqual(hello["colorScheme"] as? String, "light")
        // Already in that hello: nothing follows it.
        XCTAssertNil(report.report(.light, helloSent: true))
    }
}
