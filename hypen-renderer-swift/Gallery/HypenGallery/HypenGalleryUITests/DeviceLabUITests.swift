import XCTest

final class DeviceLabUITests: XCTestCase {
    @MainActor func testTS() throws { try exercise(port: 45101, name: "TS") }
    @MainActor func testGo() throws { try exercise(port: 45102, name: "Go") }
    @MainActor func testKotlin() throws { try exercise(port: 45103, name: "Kotlin") }
    @MainActor func testSwift() throws { try exercise(port: 45104, name: "Swift") }
    @MainActor func testRust() throws { try exercise(port: 45105, name: "Rust") }

    @MainActor private func launch(port: Int) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["DEVICE_LAB_URL"] = "ws://127.0.0.1:\(port)/ws?token=device-lab"
        app.launch()
        return app
    }
    @MainActor private func control(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
    }
    @MainActor private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    @MainActor private func finished(_ app: XCUIApplication, _ action: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT label CONTAINS %@", action + ":", "running")).firstMatch
    }
    @MainActor private func exercise(port: Int, name: String) throws {
        let app = launch(port: port)
        XCTAssertTrue(control(app, "Query camera").waitForExistence(timeout: 20))
        control(app, "Query camera").tap()
        if !finished(app, "query").waitForExistence(timeout: 2) { control(app, "Query camera").tap() }
        XCTAssertTrue(finished(app, "query").waitForExistence(timeout: 10))
        evidence(app, name + "-query")
        control(app, "Pick photo").tap()
        let fixture = app.images.matching(NSPredicate(format: "label == %@", "Photo, September 25, 17:30")).firstMatch
        XCTAssertTrue(fixture.waitForExistence(timeout: 5))
        let frame = fixture.frame
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
        XCTAssertTrue(text(app, "6465bbf6110e746367789368366419b0fbd7919d02558e92a2dfccfa246fb2fe").waitForExistence(timeout: 15))
        evidence(app, name + "-gallery")
        control(app, "Save 96K").tap()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
        let filename = app.textFields["DOCPicker.filenameTextField"]
        if filename.exists {
            filename.tap()
            filename.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30) + "device-lab-" + name)
        }
        app.buttons["Save"].tap()
        if app.buttons["Replace"].waitForExistence(timeout: 1) { app.buttons["Replace"].tap() }
        XCTAssertTrue(finished(app, "save").waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, "102000").waitForExistence(timeout: 5), "The server must confirm the entire saved payload")
        evidence(app, name + "-save")
        control(app, "Record 3s").tap()
        if app.buttons["Continue"].waitForExistence(timeout: 4) { app.buttons["Continue"].tap() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(finished(app, "record").waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, "96000").waitForExistence(timeout: 5), "Three seconds of mono PCM16 at 16 kHz must reach the server")
        evidence(app, name + "-record")
        control(app, "UI ping").tap()
        XCTAssertTrue(finished(app, "ping").waitForExistence(timeout: 5))
        evidence(app, name + "-ping")
    }
    @MainActor private func evidence(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
        print("DEVICE_LAB_EVIDENCE \(name)\n\(app.debugDescription)")
    }
}
