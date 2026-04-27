import Testing
@testable import HypenSwift

@Test func testHypenElementCreation() {
    let element = HypenElement(
        id: "test-1",
        elementType: "text",
        props: ["text": "Hello, World!"],
        children: []
    )

    #expect(element.id == "test-1")
    #expect(element.elementType == "text")
    #expect(element.getStringProp("text") == "Hello, World!")
}

@Test func testPatchParsing() {
    let patchDict: [String: Any] = [
        "type": "Create",
        "id": "element-1",
        "elementType": "column",
        "props": ["gap.0": 16]
    ]

    let patch = Patch.from(dictionary: patchDict)

    #expect(patch != nil)
    #expect(patch?.type == .create)
    #expect(patch?.id == "element-1")
    #expect(patch?.elementType == "column")
}

@Test func testActionValueParsing() {
    // Test simple action string
    let action1 = ActionValue.from("@actions.submit")
    #expect(action1?.actionName == "submit")

    // Test dictionary format
    let action2 = ActionValue.from([
        "action": "@actions.login",
        "payload": ["username": "test"]
    ] as [String: Any])
    #expect(action2?.actionName == "login")
}

@Test func testColorParsing() {
    // Test hex color
    let hex = ColorParser.parse("#FF0000")
    #expect(hex != nil)

    // Test named color
    let named = ColorParser.parse("blue")
    #expect(named != nil)

    // Test rgb format
    let rgb = ColorParser.parse("rgb(255, 0, 0)")
    #expect(rgb != nil)
}

@Test func testHypenRendererPatchApplication() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        // Create element
        let createPatch = Patch(
            type: .create,
            id: "root",
            elementType: "column",
            props: ["gap.0": 8]
        )

        renderer.applyPatches([createPatch])

        #expect(renderer.rootId == "root")
        #expect(renderer.getElement("root") != nil)
        #expect(renderer.getElement("root")?.elementType == "column")

        // Create child
        let createChildPatch = Patch(
            type: .create,
            id: "child-1",
            elementType: "text"
        )

        let insertPatch = Patch(
            type: .insert,
            id: "child-1",
            parentId: "root"
        )

        renderer.applyPatches([createChildPatch, insertPatch])

        let root = renderer.getElement("root")
        #expect(root?.children.contains("child-1") == true)

        // Set prop
        let setPropPatch = Patch(
            type: .setProp,
            id: "child-1",
            name: "text",
            value: "Hello"
        )

        renderer.applyPatches([setPropPatch])

        let child = renderer.getElement("child-1")
        #expect(child?.getStringProp("text") == "Hello")
    }
}

@Test func testComponentRegistry() async {
    await MainActor.run {
        let registry = ComponentRegistry.withDefaults()

        #expect(registry.hasHandler(for: "text") == true)
        #expect(registry.hasHandler(for: "column") == true)
        #expect(registry.hasHandler(for: "row") == true)
        #expect(registry.hasHandler(for: "button") == true)
        #expect(registry.hasHandler(for: "image") == true)
        #expect(registry.hasHandler(for: "nonexistent") == false)
    }
}

@Test func testApplicatorRegistry() async {
    await MainActor.run {
        let registry = ApplicatorRegistry.withDefaults()

        #expect(registry.hasHandler(for: "padding") == true)
        #expect(registry.hasHandler(for: "backgroundColor") == true)
        #expect(registry.hasHandler(for: "width") == true)
        #expect(registry.hasHandler(for: "onClick") == true)
        #expect(registry.hasHandler(for: "nonexistent") == false)
    }
}

@Test func testHypenModifier() {
    var modifier = HypenModifier()

    modifier.setPadding(all: 16)
    #expect(modifier.paddingTop == 16)
    #expect(modifier.paddingBottom == 16)
    #expect(modifier.paddingLeading == 16)
    #expect(modifier.paddingTrailing == 16)
    #expect(modifier.hasPadding == true)

    modifier.backgroundColor = .blue
    modifier.cornerRadius = 8
    #expect(modifier.backgroundColor != nil)

    modifier.setScale(0.5)
    #expect(modifier.scaleX == 0.5)
    #expect(modifier.scaleY == 0.5)
    #expect(modifier.hasTransform == true)
}

// MARK: - Session Tests

@Test func testSessionOptionsWithNilValues() {
    let options = SessionOptions()

    #expect(options.id == nil)
    #expect(options.props == nil)
}

@Test func testSessionOptionsWithSessionIdOnly() {
    let options = SessionOptions(id: "session-123")

    #expect(options.id == "session-123")
    #expect(options.props == nil)
}

@Test func testSessionOptionsWithPropsOnly() {
    let props: [String: Any] = [
        "platform": "ios",
        "version": "1.0.0"
    ]
    let options = SessionOptions(props: props)

    #expect(options.id == nil)
    #expect(options.props?["platform"] as? String == "ios")
    #expect(options.props?["version"] as? String == "1.0.0")
}

@Test func testSessionOptionsWithAllValues() {
    let props: [String: Any] = ["platform": "ios"]
    let options = SessionOptions(
        id: "resume-session",
        props: props
    )

    #expect(options.id == "resume-session")
    #expect(options.props?["platform"] as? String == "ios")
}

@Test func testSessionInfoForNewSession() {
    let info = SessionInfo(
        sessionId: "new-session-456",
        isNew: true,
        isRestored: false
    )

    #expect(info.sessionId == "new-session-456")
    #expect(info.isNew == true)
    #expect(info.isRestored == false)
}

@Test func testSessionInfoForRestoredSession() {
    let info = SessionInfo(
        sessionId: "restored-session-789",
        isNew: false,
        isRestored: true
    )

    #expect(info.sessionId == "restored-session-789")
    #expect(info.isNew == false)
    #expect(info.isRestored == true)
}

@Test func testSessionInfoForReconnectedButNotRestoredSession() {
    // When reconnecting but state was not preserved
    let info = SessionInfo(
        sessionId: "reconnect-session",
        isNew: false,
        isRestored: false
    )

    #expect(info.isNew == false)
    #expect(info.isRestored == false)
}

@Test func testRemoteEngineInitWithSessionOptions() async {
    await MainActor.run {
        let options = SessionOptions(
            id: "test-session",
            props: ["platform": "ios"]
        )

        do {
            let engine = try RemoteEngine(
                urlString: "ws://localhost:3000",
                sessionOptions: options
            )

            #expect(engine.getSessionId() == "test-session")
        } catch {
            Issue.record("Failed to create RemoteEngine: \(error)")
        }
    }
}

@Test func testRemoteEngineInitWithoutSessionOptions() async {
    await MainActor.run {
        do {
            let engine = try RemoteEngine(urlString: "ws://localhost:3000")

            #expect(engine.getSessionId() == nil)
        } catch {
            Issue.record("Failed to create RemoteEngine: \(error)")
        }
    }
}
