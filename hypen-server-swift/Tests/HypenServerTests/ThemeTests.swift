import XCTest
@testable import HypenServer

// Theming: the cross-SDK resolution fixture
// (`engine-compatibility-tests/fixtures/theme/resolve.json`), the `Theme`
// API, the native engine (`@theme.*` in applicators, a scheme switch that
// re-renders only what changed) and `RemoteServer` (per-session forks,
// `hello.colorScheme`, the `colorScheme` message, resume).
//
// The engine and session tests need the native library:
//   cd hypen-engine-rs && cargo build --release --features uniffi
//   LD_LIBRARY_PATH=../target/release swift test --filter Theme

// MARK: - Shared helpers

/// Canonical JSON text of a JSON-shaped value, for comparing token trees.
private func themeCanonicalJSON(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        return "<not JSON: \(value)>"
    }
    return text
}

/// Records every context a theme publishes. Thread-safe.
private final class RecordingContextEngine: ContextEngine, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(name: String, data: [String: Any])] = []
    /// Runs inside every `setContext`, before it is recorded.
    var hook: (() -> Void)?

    func setContext(_ name: String, data: [String: Any]) throws -> [[String: Any]] {
        hook?()
        lock.lock()
        recorded.append((name: name, data: data))
        lock.unlock()
        return []
    }

    var calls: [(name: String, data: [String: Any])] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    /// The newest payload published under `name`.
    func last(_ name: String) -> [String: Any]? {
        return calls.last(where: { $0.name == name })?.data
    }
}

private func themePatchId(_ patch: [String: Any]) -> String {
    return patch["id"] as? String ?? "\(patch["id"] ?? "")"
}

/// Ids of the `Text` elements created by `patches`, in creation order.
private func themeTextIds(_ patches: [[String: Any]]) -> [String] {
    return patches
        .filter { ($0["type"] as? String) == "create" && ($0["elementType"] as? String) == "Text" }
        .map(themePatchId)
}

/// The value a client holds for prop `name` of element `id` after applying
/// `patches` in order (from the `create` props or a later `setProp`).
private func themeProp(_ patches: [[String: Any]], _ id: String, _ name: String) -> Any? {
    var value: Any? = nil
    for patch in patches where themePatchId(patch) == id {
        let type = patch["type"] as? String
        if type == "create", let props = patch["props"] as? [String: Any], let found = props[name] {
            value = found
        } else if type == "setProp", (patch["name"] as? String) == name {
            value = patch["value"]
        }
    }
    return value
}

/// `type id name value` of a patch, for comparing a batch at a glance.
private func themePatchSummary(_ patch: [String: Any]) -> String {
    let type = patch["type"] as? String ?? "?"
    let name = patch["name"] as? String ?? "?"
    let value = patch["value"] as? String ?? "?"
    return [type, themePatchId(patch), name, value].joined(separator: " ")
}

/// Light ink `#111111`, dark ink `#eeeeee`; `space.md` is 16 in both.
private func makeTestTheme() -> Theme {
    let tokens: ThemeTokens = [
        "color": ["ink": "#111111", "surface": "#ffffff"],
        "space": ["md": 16],
    ]
    let dark: ThemeTokens = ["color": ["ink": "#eeeeee", "surface": "#000000"]]
    return createTheme(tokens: tokens, schemes: ["dark": dark])
}

// MARK: - Fixture + API (no engine)

final class ThemeTests: XCTestCase {
    private let tokens: ThemeTokens = [
        "color": ["brand": "#0066ff", "primary": "{color.brand}", "surface": "#ffffff"],
        "space": ["md": 16],
    ]
    private let dark: ThemeTokens = ["color": ["brand": "#66a3ff", "surface": "#111111"]]

    // MARK: Cross-SDK fixture

    /// `hypen-server-swift/Tests/HypenServerTests/<this file>` → repo root.
    private static var fixtureURL: URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // HypenServerTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // hypen-server-swift
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("engine-compatibility-tests/fixtures/theme/resolve.json")
    }

    func testThemeResolveFixture() throws {
        let url = Self.fixtureURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("theme fixture not present at \(url.path) (standalone checkout)")
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return XCTFail("fixture root is not an object")
        }
        guard let cases = root["cases"] as? [[String: Any]], !cases.isEmpty else {
            return XCTFail("fixture has no cases")
        }

        for c in cases {
            let name = c["name"] as? String ?? "<unnamed>"
            guard let caseTokens = c["tokens"] as? [String: Any],
                  let rawSchemes = c["schemes"] as? [String: Any],
                  let preference = c["preference"] as? String,
                  let systemName = c["system"] as? String,
                  let system = SystemColorScheme(rawValue: systemName),
                  let expected = c["expected"] as? [String: Any],
                  let expectedScheme = expected["scheme"] as? String,
                  let expectedTokens = expected["tokens"] as? [String: Any],
                  let expectedProblems = expected["problems"] as? Int else {
                XCTFail("malformed fixture case \(name)")
                continue
            }
            var schemes: [String: ThemeTokens] = [:]
            for (schemeName, value) in rawSchemes {
                guard let overrides = value as? [String: Any] else {
                    XCTFail("malformed scheme \(schemeName) in fixture case \(name)")
                    continue
                }
                schemes[schemeName] = overrides
            }

            let theme = createTheme(
                tokens: caseTokens,
                schemes: schemes,
                scheme: preference,
                systemScheme: system
            )
            XCTAssertEqual(theme.scheme, expectedScheme, "\(name): scheme")
            XCTAssertEqual(
                themeCanonicalJSON(theme.tokens),
                themeCanonicalJSON(expectedTokens),
                "\(name): tokens"
            )
            XCTAssertEqual(theme.problems.count, expectedProblems, "\(name): problems \(theme.problems)")
        }
    }

    // MARK: Scheme selection

    func testDefaultsToSystemPreferenceAndLightSystemScheme() {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        XCTAssertEqual(theme.preference, "system")
        XCTAssertEqual(theme.systemScheme, .light)
        XCTAssertEqual(theme.scheme, "light")
        XCTAssertEqual(theme.schemes, ["dark"])
        XCTAssertEqual(
            theme.meta,
            ThemeMeta(scheme: "light", preference: "system", system: .light, schemes: ["dark"])
        )
        XCTAssertEqual(
            themeCanonicalJSON(theme.meta.toDictionary()),
            themeCanonicalJSON([
                "scheme": "light", "preference": "system", "system": "light", "schemes": ["dark"],
            ] as [String: Any])
        )
        XCTAssertEqual(theme.token("color.primary") as? String, "#0066ff")
    }

    func testSetSchemeSwitchesTokensAndRejectsUnknownNames() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark, "sepia": [:]])
        try theme.setScheme("dark")
        XCTAssertEqual(theme.scheme, "dark")
        XCTAssertEqual(theme.preference, "dark")
        XCTAssertEqual(
            theme.token("color.primary") as? String, "#66a3ff", "the alias follows the scheme's brand")
        XCTAssertEqual(theme.token("space.md") as? Int, 16)

        try theme.setScheme("sepia")
        XCTAssertEqual(theme.token("color.brand") as? String, "#0066ff")

        XCTAssertThrowsError(try theme.setScheme("neon")) { error in
            XCTAssertEqual(
                error as? ThemeError,
                ThemeError.unknownScheme("neon", known: ["system", "light", "dark", "sepia"])
            )
            XCTAssertTrue("\(error)".contains("neon"), "\(error)")
            XCTAssertTrue("\(error)".contains("system, light, dark, sepia"), "\(error)")
        }
        XCTAssertEqual(theme.preference, "sepia", "a refused scheme changes nothing")
    }

    func testUnknownInitialSchemeFallsBackToSystem() {
        let theme = createTheme(tokens: tokens, scheme: "neon")
        XCTAssertEqual(theme.preference, "system")
        XCTAssertEqual(theme.scheme, "light")
    }

    func testToggleFlipsBetweenLightAndDark() {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark], systemScheme: .dark)
        XCTAssertEqual(theme.scheme, "dark")
        theme.toggle()
        XCTAssertEqual(theme.preference, "light")
        theme.toggle()
        XCTAssertEqual(theme.preference, "dark")
    }

    func testSetSystemSchemeAppliesOnlyWhilePreferenceIsSystem() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        theme.setSystemScheme(.dark)
        XCTAssertEqual(theme.scheme, "dark")
        XCTAssertEqual(theme.token("color.surface") as? String, "#111111")

        try theme.setScheme("light")
        theme.setSystemScheme(.light)
        theme.setSystemScheme(.dark)
        XCTAssertEqual(theme.scheme, "light", "an explicit preference wins")
        try theme.setScheme("system")
        XCTAssertEqual(theme.scheme, "dark", "the remembered system scheme applies again")
    }

    // MARK: Tokens

    func testExtendMergesIntoBaseOrOneScheme() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        theme.extend(["color": ["accent": "{color.brand}"], "radius": ["md": 8]])
        XCTAssertEqual(theme.token("color.accent") as? String, "#0066ff")
        XCTAssertEqual(theme.token("radius.md") as? Int, 8)
        XCTAssertEqual(
            theme.token("color.surface") as? String, "#ffffff", "existing tokens survive the merge")

        theme.extend(["radius": ["md": 12]], scheme: "dark")
        XCTAssertEqual(
            theme.token("radius.md") as? Int, 8, "an inactive scheme's override is not in effect")
        try theme.setScheme("dark")
        XCTAssertEqual(theme.token("radius.md") as? Int, 12)

        theme.extend(["color": ["accent": "#ff00ff"]], scheme: "contrast")
        XCTAssertEqual(theme.schemes, ["dark", "contrast"])
        try theme.setScheme("contrast")
        XCTAssertEqual(theme.token("color.accent") as? String, "#ff00ff")
    }

    func testHasAndTokenReportMissingTokensOnce() {
        var missing: [String] = []
        let theme = createTheme(tokens: tokens, onMissingToken: { path, scheme in
            missing.append("\(path)@\(scheme)")
        })
        XCTAssertTrue(theme.has("color.primary"))
        XCTAssertTrue(theme.has("color"))
        XCTAssertFalse(theme.has("color.nope"))
        XCTAssertFalse(theme.has("color.primary.deeper"))
        let space = theme.token("space")
        XCTAssertEqual(themeCanonicalJSON(space ?? NSNull()), #"{"md":16}"#)

        XCTAssertNil(theme.token("color.nope"))
        XCTAssertNil(theme.token("color.nope"))
        XCTAssertEqual(missing, ["color.nope@light"])
    }

    func testProblemsListsAliasProblemsOfTheActiveScheme() throws {
        let theme = createTheme(
            tokens: ["a": "{missing}", "b": 1],
            schemes: ["dark": ["a": "{b}"]]
        )
        XCTAssertEqual(theme.problems, ["Token \"a\" aliases \"missing\", which is not defined"])
        XCTAssertEqual(theme.token("a") as? String, "{missing}")
        try theme.setScheme("dark")
        XCTAssertEqual(theme.problems, [])
        XCTAssertEqual(theme.token("a") as? Int, 1)
    }

    func testResolveTokenAliasesReportsAndKeepsBadAliases() {
        var problems: [String] = []
        let resolved = resolveTokenAliases(
            ["a": "{b}", "b": "{a}", "ok": "{d}", "d": 1, "text": "not {d} alias"]
        ) { problems.append($0) }
        XCTAssertEqual(problems.count, 2, "\(problems)")
        XCTAssertEqual(resolved["a"] as? String, "{b}")
        XCTAssertEqual(resolved["ok"] as? Int, 1)
        XCTAssertEqual(resolved["text"] as? String, "not {d} alias")
    }

    // MARK: Listeners, forks, engines

    func testOnChangeHearsSchemeAndTokenChangesUntilUnsubscribed() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        var heard: [ThemeMeta] = []
        let stop = theme.onChange { heard.append($0) }

        try theme.setScheme("dark")
        try theme.setScheme("dark")  // unchanged: silent
        theme.setSystemScheme(.dark)  // scheme stays dark, meta.system changes
        theme.extend(["x": 1])
        XCTAssertEqual(heard.map { $0.scheme }, ["dark", "dark", "dark"])
        XCTAssertEqual(heard.dropFirst().first?.system, SystemColorScheme.dark)

        stop()
        try theme.setScheme("light")
        XCTAssertEqual(heard.count, 3)
    }

    func testForkHasItsOwnPreferenceAndSharesTheTokens() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        let a = theme.fork()
        let b = theme.fork(preference: "dark")
        XCTAssertEqual(a.preference, "system")
        XCTAssertEqual(b.preference, "dark")

        try a.setScheme("dark")
        XCTAssertEqual(theme.scheme, "light", "a fork's scheme does not leak to its parent")
        try a.setScheme("light")
        XCTAssertEqual(b.scheme, "dark", "nor to a sibling")

        // Tokens are shared: an extension made through one instance is seen
        // by the others the next time they resolve.
        theme.extend(["color": ["accent": "#ff00ff"]])
        XCTAssertEqual(theme.token("color.accent") as? String, "#ff00ff")
        try a.setScheme("dark")
        XCTAssertEqual(a.token("color.accent") as? String, "#ff00ff")

        XCTAssertEqual(
            theme.fork(preference: "neon").preference, "system",
            "an unknown preference follows the system")
    }

    func testAttachPublishesAppearanceAndThemeNowAndOnEveryChange() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        let engine = RecordingContextEngine()
        let detach = theme.attach(engine)

        XCTAssertEqual(engine.calls.map { $0.name }, ["appearance", "theme"])
        XCTAssertEqual(engine.calls.first?.data["scheme"] as? String, "light")
        XCTAssertEqual(
            themeCanonicalJSON(engine.last("theme") ?? [:]), themeCanonicalJSON(theme.tokens))

        try theme.setScheme("dark")
        XCTAssertEqual(engine.calls.count, 4)
        XCTAssertEqual(engine.last("appearance")?["scheme"] as? String, "dark")
        let color = engine.last("theme")?["color"] as? [String: Any]
        XCTAssertEqual(color?["surface"] as? String, "#111111")

        detach()
        try theme.setScheme("light")
        XCTAssertEqual(engine.calls.count, 4, "a detached engine hears nothing more")
    }

    /// A change made from inside an engine while the theme is publishing to
    /// it (a patch callback, a render hook) must neither deadlock nor be
    /// lost: the publishing thread goes round again with the newest tokens.
    func testChangeMadeWhilePublishingIsDeliveredWithoutDeadlock() throws {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        let engine = RecordingContextEngine()
        theme.attach(engine)

        let fired = TestCounter(false)
        engine.hook = {
            if fired.current { return }
            fired.set(true)
            theme.extend(["x": 2])
        }
        try theme.setScheme("dark")

        XCTAssertTrue(fired.current)
        XCTAssertEqual(engine.calls.last?.name, "theme")
        XCTAssertEqual(engine.last("theme")?["x"] as? Int, 2)
        XCTAssertEqual(engine.last("appearance")?["scheme"] as? String, "dark")
        let color = engine.last("theme")?["color"] as? [String: Any]
        XCTAssertEqual(color?["surface"] as? String, "#111111")
    }

    func testRacingChangesLeaveTheEngineOnTheLatestSnapshot() {
        let theme = createTheme(tokens: tokens, schemes: ["dark": dark])
        let engine = RecordingContextEngine()
        theme.attach(engine)

        DispatchQueue.concurrentPerform(iterations: 64) { i in
            if i % 3 == 0 {
                theme.setSystemScheme(i % 2 == 0 ? .dark : .light)
            } else {
                theme.toggle()
            }
        }

        XCTAssertEqual(engine.last("appearance")?["scheme"] as? String, theme.scheme)
        XCTAssertEqual(engine.last("appearance")?["preference"] as? String, theme.preference)
        XCTAssertEqual(
            themeCanonicalJSON(engine.last("theme") ?? [:]), themeCanonicalJSON(theme.tokens))
    }

    func testCreateThemeWithNoArgumentsNamedArgumentsOrOptions() {
        let bare = createTheme()
        XCTAssertEqual(bare.preference, "system")
        XCTAssertTrue(bare.tokens.isEmpty)

        XCTAssertEqual(createTheme(tokens: tokens).token("color.brand") as? String, "#0066ff")

        let fromOptions = createTheme(ThemeOptions(tokens: tokens, schemes: ["dark": dark], scheme: "dark"))
        XCTAssertEqual(fromOptions.scheme, "dark")
        XCTAssertEqual(fromOptions.token("color.brand") as? String, "#66a3ff")
    }
}

// MARK: - Native engine

final class ThemeEngineTests: XCTestCase {

    func testThemeTokensResolveInApplicators() throws {
        let engine = try NativeEngine()
        makeTestTheme().attach(engine)

        let patches = try engine.renderSource(
            #"Text("Hi").color(@theme.color.ink).padding(@theme.space.md)"#
        )
        let text = try XCTUnwrap(themeTextIds(patches).first, "patches: \(patches)")
        XCTAssertEqual(themeProp(patches, text, "color.0") as? String, "#111111", "patches: \(patches)")
        XCTAssertEqual(themeProp(patches, text, "padding.0") as? Int, 16, "patches: \(patches)")
    }

    func testSchemeSwitchEmitsOnlyTheChangedProp() throws {
        let engine = try NativeEngine()
        let theme = makeTestTheme()
        theme.attach(engine)

        let initial = try engine.renderSource("""
            Column {
                Text("Hi").color(@theme.color.ink).padding(@theme.space.md)
                Text("@{appearance.scheme}")
                Text("Plain").padding(@theme.space.md)
            }
            """)
        let textIds = themeTextIds(initial)
        XCTAssertEqual(textIds.count, 3, "patches: \(initial)")
        guard textIds.count == 3 else { return }

        var rendered: [[String: Any]] = []
        let stop = engine.onContextPatches { rendered.append(contentsOf: $0) }
        try theme.setScheme("dark")

        // One prop per bound value that changed: the scheme name and the
        // ink color. `space.md` is the same in both schemes, so neither
        // padding is re-sent, and nothing is created or removed.
        XCTAssertEqual(
            rendered.map(themePatchSummary),
            ["setProp \(textIds[1]) 0 dark", "setProp \(textIds[0]) color.0 #eeeeee"],
            "patches: \(rendered)"
        )

        // Asking for the scheme already in effect renders nothing.
        rendered.removeAll()
        try theme.setScheme("dark")
        XCTAssertTrue(rendered.isEmpty, "patches: \(rendered)")

        // A stopped listener hears nothing more.
        stop()
        try theme.setScheme("light")
        XCTAssertTrue(rendered.isEmpty, "patches: \(rendered)")
    }

    func testSetContextAndRemoveContextReturnPatchesAndFeedTheListeners() throws {
        let engine = try NativeEngine()
        XCTAssertTrue(try engine.setContext("brand", data: ["name": "Acme"]).isEmpty)
        _ = try engine.renderSource(#"Text("@{brand.name}")"#)

        var rendered: [[String: Any]] = []
        engine.onContextPatches { rendered.append(contentsOf: $0) }
        let patches = try engine.setContext("brand", data: ["name": "Globex"])
        XCTAssertEqual(patches.count, 1, "patches: \(patches)")
        XCTAssertEqual(patches.first?["value"] as? String, "Globex")
        XCTAssertEqual(rendered.count, 1)
        XCTAssertEqual(rendered.first?["value"] as? String, "Globex")

        // Unchanged data re-renders nothing; removing an unknown context is
        // a no-op.
        XCTAssertTrue(try engine.setContext("brand", data: ["name": "Globex"]).isEmpty)
        XCTAssertTrue(try engine.removeContext("nope").isEmpty)
        XCTAssertEqual(rendered.count, 1)
    }

    /// Re-entrancy: the handler runs from `processPendingActions()`, after
    /// the native dispatch call has returned, and pushes a context straight
    /// back into the same engine. The publish is synchronous — the new token
    /// value is in the patches by the time `dispatchAction` returns.
    func testHandlerThatSwitchesSchemeRendersTheNewTokenValue() throws {
        let engine = try NativeEngine()
        let theme = makeTestTheme()
        theme.attach(engine)

        let seen = TestCounter<String?>(nil)
        let definition = AppBuilder(["taps": 0])
            .onAction("toggleTheme") { ctx in
                ctx.theme?.toggle()
                seen.set(ctx.theme?.scheme)
            }
            .build()
        let instance = ModuleInstance(definition: definition, engine: engine)
        XCTAssertNil(instance.theme)
        instance.attachTheme(theme)
        XCTAssertTrue(instance.theme === theme)

        let initial = try engine.renderSource(#"Text("Hi").color(@theme.color.ink)"#)
        let label = try XCTUnwrap(themeTextIds(initial).first, "patches: \(initial)")
        XCTAssertEqual(themeProp(initial, label, "color.0") as? String, "#111111")

        var rendered: [[String: Any]] = []
        engine.onContextPatches { rendered.append(contentsOf: $0) }
        instance.dispatchAction("toggleTheme")

        XCTAssertEqual(seen.current, "dark")
        XCTAssertEqual(themeProp(rendered, label, "color.0") as? String, "#eeeeee", "patches: \(rendered)")

        rendered.removeAll()
        instance.dispatchAction("toggleTheme")
        XCTAssertEqual(theme.scheme, "light")
        XCTAssertEqual(themeProp(rendered, label, "color.0") as? String, "#111111", "patches: \(rendered)")
    }

    func testGlobalContextCarriesTheTheme() throws {
        let context = HypenGlobalContext()
        XCTAssertNil(context.theme)
        let theme = makeTestTheme()
        context.setTheme(theme)
        XCTAssertTrue(context.theme === theme)

        // A module without its own theme falls back to its context's.
        let engine = try NativeEngine()
        let instance = ModuleInstance(
            definition: AppBuilder(["x": 0]).build(), engine: engine, globalContext: context)
        XCTAssertTrue(instance.theme === theme)
        context.setTheme(nil)
        XCTAssertNil(instance.theme)
    }
}

// MARK: - RemoteServer sessions

final class ThemeSessionTests: XCTestCase {

    private final class RecordingTransport: SessionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [OutgoingMessage] = []
        private var closedCount = 0

        func send(_ message: OutgoingMessage) throws {
            lock.lock(); defer { lock.unlock() }
            messages.append(message)
        }

        func close(code: UInt16, reason: String) {
            lock.lock(); defer { lock.unlock() }
            closedCount += 1
        }

        var all: [OutgoingMessage] {
            lock.lock(); defer { lock.unlock() }
            return messages
        }

        var wasClosed: Bool {
            lock.lock(); defer { lock.unlock() }
            return closedCount > 0
        }
    }

    private static let template = """
    Column {
        Text("Taps: @{state.taps}").color(@theme.color.ink)
        Text("@{appearance.scheme}")
        Button("@actions.toggleTheme") { Text("Toggle") }
    }
    """

    private func makeServer(
        theme: Theme? = makeTestTheme(),
        seen: TestCounter<String?>? = nil
    ) throws -> RemoteServer {
        let testApp = HypenApp()
        let mod = testApp.module("Themed")
            .defineState(["taps": 0])
            .onAction("toggleTheme") { ctx in
                let taps = ctx.state.get("taps") as? Int ?? 0
                ctx.state.set("taps", taps + 1)
                ctx.theme?.toggle()
                seen?.set(ctx.theme?.scheme)
            }
            .ui(Self.template)
        let server = RemoteServer()
            .app(testApp)
            .module("Themed", mod)
            .ui(Self.template)
        if let theme {
            server.theme(theme)
        }
        try server.prepare()
        return server
    }

    private func patches(of message: OutgoingMessage) -> [[String: Any]] {
        switch message {
        case let .initialTree(_, _, patches, _): return patches
        case let .patch(_, patches, _): return patches
        default: return []
        }
    }

    /// Every patch the session has sent so far, in order.
    private func allPatches(_ transport: RecordingTransport) -> [[String: Any]] {
        return transport.all.flatMap { patches(of: $0) }
    }

    /// The label (bound to `@theme.color.ink`) and the scheme text (bound to
    /// `@{appearance.scheme}`).
    private func texts(_ transport: RecordingTransport) throws -> (label: String, scheme: String) {
        let ids = themeTextIds(allPatches(transport))
        let pair = try XCTUnwrap(
            ids.count >= 2 ? Array(ids.prefix(2)) : nil,
            "expected the template's Text elements, got \(ids)")
        return (pair[0], pair[1])
    }

    private func inkColor(_ transport: RecordingTransport) throws -> String? {
        let ids = try texts(transport)
        return themeProp(allPatches(transport), ids.label, "color.0") as? String
    }

    private func shownScheme(_ transport: RecordingTransport) throws -> String? {
        let ids = try texts(transport)
        return themeProp(allPatches(transport), ids.scheme, "0") as? String
    }

    private func ready(
        _ server: RemoteServer,
        hello: String = #"{"type":"hello"}"#
    ) throws -> (RemoteSession, RecordingTransport) {
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)
        session.receive(hello)
        XCTAssertTrue(session.isReady)
        return (session, transport)
    }

    private func sessionId(_ transport: RecordingTransport) -> (id: String, isRestored: Bool)? {
        for message in transport.all {
            if case let .sessionAck(sessionId, _, isRestored, _, _) = message {
                return (sessionId, isRestored)
            }
        }
        return nil
    }

    private func isStateUpdate(_ m: OutgoingMessage) -> Bool {
        if case .stateUpdate = m { return true }
        return false
    }

    private func isPatch(_ m: OutgoingMessage) -> Bool {
        if case .patch = m { return true }
        return false
    }

    // MARK: Decoding

    func testParseColorScheme() {
        XCTAssertEqual(RemoteSession.parseColorScheme("light"), .light)
        XCTAssertEqual(RemoteSession.parseColorScheme("dark"), .dark)
        let bad: [Any?] = [nil, "Dark", "sepia", "system", "", 1, true, NSNull(), ["dark"]]
        for value in bad {
            XCTAssertNil(RemoteSession.parseColorScheme(value), "should reject \(String(describing: value))")
        }
    }

    // MARK: Sessions

    func testInitialTreeResolvesThemeTokens() throws {
        let appTheme = makeTestTheme()
        let server = try makeServer(theme: appTheme)
        defer { server.stop() }
        let (session, transport) = try ready(server)

        XCTAssertEqual(try inkColor(transport), "#111111")
        XCTAssertEqual(try shownScheme(transport), "light")
        let sessionTheme = try XCTUnwrap(session.theme)
        XCTAssertFalse(sessionTheme === appTheme, "each session gets its own fork")
        XCTAssertFalse(transport.all.contains(where: isPatch), "nothing streams before a change")
    }

    func testServerWithoutThemeHasNone() throws {
        let server = try makeServer(theme: nil)
        defer { server.stop() }
        let (session, transport) = try ready(server)
        XCTAssertNil(session.theme)
        let before = transport.all.count
        session.receive(#"{"type":"colorScheme","scheme":"dark"}"#)
        XCTAssertEqual(transport.all.count, before, "no theme: a colorScheme message is ignored")
        XCTAssertFalse(transport.wasClosed)
    }

    func testHandlerSwitchRendersTheNewToken() throws {
        let appTheme = makeTestTheme()
        let seen = TestCounter<String?>(nil)
        let server = try makeServer(theme: appTheme, seen: seen)
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let before = transport.all.count

        session.receive(#"{"type":"dispatchAction","action":"toggleTheme"}"#)

        XCTAssertEqual(seen.current, "dark")
        XCTAssertEqual(session.theme?.scheme, "dark")
        XCTAssertEqual(try inkColor(transport), "#eeeeee")
        XCTAssertEqual(try shownScheme(transport), "dark")
        let ids = try texts(transport)
        XCTAssertEqual(themeProp(allPatches(transport), ids.label, "0") as? String, "Taps: 1")
        XCTAssertTrue(transport.all.dropFirst(before).contains(where: isStateUpdate))
        XCTAssertEqual(appTheme.scheme, "light", "a session's switch never reaches the app's theme")

        session.receive(#"{"type":"dispatchAction","action":"toggleTheme"}"#)
        XCTAssertEqual(try inkColor(transport), "#111111")
        XCTAssertEqual(try shownScheme(transport), "light")
    }

    func testSessionsHaveTheirOwnForks() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (a, ta) = try ready(server)
        let (b, tb) = try ready(server)
        let bBefore = tb.all.count

        a.receive(#"{"type":"dispatchAction","action":"toggleTheme"}"#)

        XCTAssertEqual(try inkColor(ta), "#eeeeee")
        XCTAssertEqual(a.theme?.scheme, "dark")
        XCTAssertEqual(tb.all.count, bBefore, "another session never sees this client's scheme")
        XCTAssertEqual(try inkColor(tb), "#111111")
        XCTAssertEqual(b.theme?.scheme, "light")
    }

    // MARK: Client-reported color scheme

    func testHelloColorSchemeAppliesBeforeTheFirstRender() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (session, transport) = try ready(server, hello: #"{"type":"hello","colorScheme":"dark"}"#)

        XCTAssertEqual(session.theme?.systemScheme, .dark)
        XCTAssertEqual(session.theme?.preference, "system")
        XCTAssertEqual(try inkColor(transport), "#eeeeee")
        XCTAssertEqual(try shownScheme(transport), "dark")
        XCTAssertFalse(transport.all.contains(where: isPatch), "the first frame is already dark")
    }

    func testHelloColorSchemeIgnoresAnythingButLightAndDark() throws {
        let server = try makeServer()
        defer { server.stop() }
        for hello in [
            #"{"type":"hello","colorScheme":"sepia"}"#,
            #"{"type":"hello","colorScheme":1}"#,
            #"{"type":"hello","colorScheme":null}"#,
            #"{"type":"hello","colorScheme":{"scheme":"dark"}}"#,
        ] {
            let (session, transport) = try ready(server, hello: hello)
            XCTAssertEqual(session.theme?.systemScheme, .light, hello)
            XCTAssertEqual(try inkColor(transport), "#111111", hello)
        }
    }

    func testColorSchemeMessageAppliesToThisSessionOnly() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (a, ta) = try ready(server)
        let (b, tb) = try ready(server)
        let aBefore = ta.all.count
        let bBefore = tb.all.count
        let revBefore = a.currentRevision

        a.receive(#"{"type":"colorScheme","scheme":"dark"}"#)

        let sent = Array(ta.all.dropFirst(aBefore))
        XCTAssertFalse(sent.isEmpty, "the change streams out")
        XCTAssertTrue(sent.allSatisfy(isPatch), "only patch messages, never a stateUpdate: \(sent)")
        XCTAssertEqual(a.currentRevision, revBefore + sent.count)
        XCTAssertEqual(try inkColor(ta), "#eeeeee")
        XCTAssertEqual(try shownScheme(ta), "dark")
        XCTAssertEqual(a.theme?.preference, "system", "a report is not a preference")

        XCTAssertEqual(tb.all.count, bBefore, "another session never hears this client's scheme")
        XCTAssertEqual(b.theme?.systemScheme, .light)

        // The same scheme again changes nothing.
        let again = ta.all.count
        a.receive(#"{"type":"colorScheme","scheme":"dark"}"#)
        XCTAssertEqual(ta.all.count, again)
        XCTAssertFalse(ta.wasClosed)
    }

    func testMalformedColorSchemeMessagesAreIgnored() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let before = transport.all.count
        session.receive(#"{"type":"colorScheme"}"#)
        session.receive(#"{"type":"colorScheme","scheme":"sepia"}"#)
        session.receive(#"{"type":"colorScheme","scheme":"Dark"}"#)
        session.receive(#"{"type":"colorScheme","scheme":1}"#)
        session.receive(#"{"type":"colorScheme","scheme":true}"#)
        session.receive(#"{"type":"colorScheme","scheme":null}"#)
        session.receive(#"{"type":"colorScheme","colorScheme":"dark"}"#)
        XCTAssertEqual(transport.all.count, before, "nothing sent for malformed reports")
        XCTAssertEqual(session.theme?.systemScheme, .light)
        XCTAssertFalse(transport.wasClosed, "never a disconnect")
    }

    func testColorSchemeBeforeHelloIsIgnored() throws {
        let server = try makeServer()
        defer { server.stop() }
        let transport = RecordingTransport()
        let session = try server.createSession(transport: transport, helloGraceMs: nil)
        session.receive(#"{"type":"colorScheme","scheme":"dark"}"#)
        XCTAssertTrue(transport.all.isEmpty)
        XCTAssertEqual(session.theme?.systemScheme, .light)

        session.receive(#"{"type":"hello"}"#)
        XCTAssertEqual(try inkColor(transport), "#111111")
        XCTAssertFalse(transport.wasClosed)
    }

    func testExplicitPreferenceRemembersTheReportedScheme() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (session, transport) = try ready(server)
        let theme = try XCTUnwrap(session.theme)
        try theme.setScheme("light")
        let before = transport.all.count

        session.receive(#"{"type":"colorScheme","scheme":"dark"}"#)
        XCTAssertEqual(transport.all.count, before, "nothing on screen changes")
        XCTAssertEqual(theme.scheme, "light")

        try theme.setScheme("system")
        XCTAssertEqual(theme.scheme, "dark")
        XCTAssertEqual(try inkColor(transport), "#eeeeee")
    }

    // MARK: Resume

    func testResumeKeepsTheSchemePreference() throws {
        let server = try makeServer()
        defer { server.stop() }
        let (first, t1) = try ready(server)
        first.receive(#"{"type":"dispatchAction","action":"toggleTheme"}"#)
        XCTAssertEqual(first.theme?.preference, "dark")
        let sid = try XCTUnwrap(sessionId(t1)?.id)
        first.destroy()

        let (resumed, t2) = try ready(server, hello: #"{"type":"hello","sessionId":"\#(sid)"}"#)
        let ack = try XCTUnwrap(sessionId(t2))
        XCTAssertEqual(ack.id, sid)
        XCTAssertTrue(ack.isRestored)
        XCTAssertEqual(resumed.theme?.preference, "dark")
        XCTAssertEqual(try inkColor(t2), "#eeeeee", "the first frame after a resume is already dark")
        XCTAssertEqual(try shownScheme(t2), "dark")

        // A different client starts from the app's preference.
        let (fresh, t3) = try ready(server)
        XCTAssertEqual(fresh.theme?.preference, "system")
        XCTAssertEqual(try inkColor(t3), "#111111")
    }
}
