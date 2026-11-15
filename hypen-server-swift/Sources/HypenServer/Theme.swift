import Foundation

// Theming and design tokens for Hypen apps.
//
// One `Theme` instance per app (per session under `RemoteServer`) owns the
// design tokens and the active color scheme, and publishes them to the
// engine as two data-source contexts:
//
// - `theme`      — the resolved tokens: the base set with the active scheme's
//                  overrides merged on top. Templates read
//                  `.color(@theme.color.primary)` / `.padding(@theme.space.md)`
//                  / `Text("@{theme.font.body}")`.
// - `appearance` — `{ scheme, preference, system, schemes }`, read as
//                  `@appearance.scheme` (e.g. to pick an icon).
//
// Switching scheme (`Theme.setScheme(_:)`) pushes a new `theme` context; the
// engine diffs it against the previous one and re-renders only the nodes
// bound to tokens whose value actually changed.
//
// A token value may be an alias of another token, written
// `"{color.blue.500}"` (the whole string). Aliases are resolved after the
// scheme merge, so a semantic token defined once in the base set
// (`"primary": "{color.brand}"`) follows a scheme that overrides
// `color.brand`.
//
// Behaviour is shared with the other SDKs and pinned by
// `engine-compatibility-tests/fixtures/theme/resolve.json`.

/// A (possibly nested) set of design tokens, in the same representation the
/// SDK uses for module state: a leaf is a `String`, a number or a `Bool`, a
/// group is a nested `[String: Any]`.
public typealias ThemeTokens = [String: Any]

/// A color scheme the platform itself can report.
public enum SystemColorScheme: String, Sendable, CaseIterable {
    case light
    case dark
}

/// Something a `Theme` can publish its contexts to. `NativeEngine` is one.
public protocol ContextEngine: AnyObject {
    /// Set (or replace) the data-source context `name` and return the
    /// patches of the nodes bound to it.
    @discardableResult
    func setContext(_ name: String, data: [String: Any]) throws -> [[String: Any]]
}

/// Options for `createTheme(_:)`.
///
/// `@unchecked Sendable`: the token dictionaries are JSON-shaped values that
/// are only read after construction.
public struct ThemeOptions: @unchecked Sendable {
    /// Tokens shared by every scheme.
    public var tokens: ThemeTokens
    /// Per-scheme overrides, merged over `tokens` while that scheme is
    /// active. `light` and `dark` are what `"system"` resolves to; any other
    /// name is a scheme selected explicitly with `Theme.setScheme(_:)`.
    public var schemes: [String: ThemeTokens]
    /// Which scheme to use: a scheme name, or `"system"` to follow the
    /// platform. Defaults to `"system"`.
    public var scheme: String
    /// What `"system"` resolves to until the platform reports otherwise
    /// (`Theme.setSystemScheme(_:)`). Defaults to light.
    public var systemScheme: SystemColorScheme
    /// Called as `(path, scheme)` the first time each missing token is
    /// looked up via `Theme.token(_:)`.
    public var onMissingToken: ((String, String) -> Void)?

    public init(
        tokens: ThemeTokens = [:],
        schemes: [String: ThemeTokens] = [:],
        scheme: String = Theme.systemPreference,
        systemScheme: SystemColorScheme = .light,
        onMissingToken: ((String, String) -> Void)? = nil
    ) {
        self.tokens = tokens
        self.schemes = schemes
        self.scheme = scheme
        self.systemScheme = systemScheme
        self.onMissingToken = onMissingToken
    }
}

/// Snapshot published as the `appearance` data source.
public struct ThemeMeta: Sendable, Equatable {
    /// The scheme in effect (never `"system"`).
    public let scheme: String
    /// What was asked for: a scheme name or `"system"`.
    public let preference: String
    /// The platform's scheme as last reported.
    public let system: SystemColorScheme
    /// Scheme names that have overrides defined.
    public let schemes: [String]

    public init(scheme: String, preference: String, system: SystemColorScheme, schemes: [String]) {
        self.scheme = scheme
        self.preference = preference
        self.system = system
        self.schemes = schemes
    }

    /// The payload as published to the engine.
    public func toDictionary() -> [String: Any] {
        return [
            "scheme": scheme,
            "preference": preference,
            "system": system.rawValue,
            "schemes": schemes,
        ]
    }
}

/// Errors thrown by `Theme`.
public enum ThemeError: Error, CustomStringConvertible, Equatable {
    /// `Theme.setScheme(_:)` was given a name that is neither `light` /
    /// `dark` / `"system"` nor defined in `schemes`.
    case unknownScheme(String, known: [String])

    public var description: String {
        switch self {
        case let .unknownScheme(name, known):
            return "Unknown color scheme \"\(name)\". Known: \(known.joined(separator: ", "))"
        }
    }
}

/// Receives the theme's `appearance` after every scheme / token change.
public typealias ThemeChangeListener = (ThemeMeta) -> Void

// MARK: - Token helpers

/// Longest alias chain followed before giving up (a cycle is reported earlier).
private let maxThemeAliasDepth = 32

private let themeLog = HypenLogger("Theme")

/// Whether `text` is one segment a template reference (`@theme.a.b`) can
/// address: letters, digits and "_" only, at least one.
private func isReferenceableTokenKey<S: StringProtocol>(_ text: S) -> Bool {
    if text.isEmpty { return false }
    for byte in text.utf8 {
        let isDigit = byte >= 48 && byte <= 57
        let isUpper = byte >= 65 && byte <= 90
        let isLower = byte >= 97 && byte <= 122
        if !(isDigit || isUpper || isLower || byte == 95) { return false }
    }
    return true
}

/// The path a whole-string alias (`"{color.brand}"`) points at, or nil when
/// `value` is not an alias.
private func themeAliasTarget(_ value: Any) -> String? {
    guard let text = value as? String,
          text.utf8.count >= 3,
          text.hasPrefix("{"),
          text.hasSuffix("}") else {
        return nil
    }
    let inner = text.dropFirst().dropLast()
    for segment in inner.split(separator: ".", omittingEmptySubsequences: false) {
        if !isReferenceableTokenKey(segment) { return nil }
    }
    return String(inner)
}

/// Deep-merge `primary` over `fallback` into a new dictionary.
private func mergeThemeTokens(_ fallback: ThemeTokens?, _ primary: ThemeTokens?) -> ThemeTokens {
    var out: ThemeTokens = fallback ?? [:]
    guard let primary = primary else { return out }
    for (key, value) in primary {
        if let group = value as? [String: Any] {
            out[key] = mergeThemeTokens(out[key] as? [String: Any], group)
        } else {
            out[key] = value
        }
    }
    return out
}

/// The value at the dotted `path` (a leaf or a group), or nil.
private func lookupThemeToken(_ tokens: ThemeTokens, _ path: String) -> Any? {
    var current: Any = tokens
    for segment in path.split(separator: ".", omittingEmptySubsequences: false) {
        guard let group = current as? [String: Any],
              let next = group[String(segment)],
              !(next is NSNull) else {
            return nil
        }
        current = next
    }
    return current
}

private func followThemeAlias(
    _ value: Any,
    at: String,
    in tokens: ThemeTokens,
    report: (String) -> Void
) -> Any {
    var seen: [String] = [at]
    var current: Any = value
    for _ in 0..<maxThemeAliasDepth {
        guard let target = themeAliasTarget(current) else { return current }
        if seen.contains(target) || at.hasPrefix(target + ".") {
            report("Token alias cycle: " + (seen + [target]).joined(separator: " -> "))
            return value
        }
        guard let next = lookupThemeToken(tokens, target) else {
            report("Token \"\(at)\" aliases \"\(target)\", which is not defined")
            return value
        }
        seen.append(target)
        current = next
    }
    report("Token \"\(at)\" has an alias chain longer than \(maxThemeAliasDepth)")
    return value
}

private func resolveThemeGroup(
    _ group: ThemeTokens,
    prefix: String,
    depth: Int,
    in tokens: ThemeTokens,
    report: (String) -> Void
) -> ThemeTokens {
    var out: ThemeTokens = [:]
    // Sorted so the problems are reported in the same order on every run.
    for key in group.keys.sorted() {
        guard let value = group[key] else { continue }
        let at = prefix.isEmpty ? key : prefix + "." + key
        let resolved: Any
        if value is [String: Any] {
            resolved = value
        } else {
            resolved = followThemeAlias(value, at: at, in: tokens, report: report)
        }
        // A group reached through an alias can itself hold aliases (and
        // could alias back into its own parent), hence the depth bound.
        if let nested = resolved as? [String: Any], depth < maxThemeAliasDepth {
            out[key] = resolveThemeGroup(nested, prefix: at, depth: depth + 1, in: tokens, report: report)
        } else {
            out[key] = resolved
        }
    }
    return out
}

/// Copy of `tokens` with every `"{path}"` alias replaced by the value it
/// points at (a leaf or a whole group). An alias that is missing or part of
/// a cycle is reported through `report` and left as written.
public func resolveTokenAliases(
    _ tokens: ThemeTokens,
    report: (String) -> Void = { _ in }
) -> ThemeTokens {
    return resolveThemeGroup(tokens, prefix: "", depth: 0, in: tokens, report: report)
}

/// The keys of `tokens` (at any depth) that a template cannot reference.
private func unreferenceableTokenKeys(_ tokens: ThemeTokens, prefix: String = "") -> [String] {
    var out: [String] = []
    for key in tokens.keys.sorted() {
        let at = prefix.isEmpty ? key : prefix + "." + key
        if !isReferenceableTokenKey(key) { out.append(at) }
        if let group = tokens[key] as? [String: Any] {
            out.append(contentsOf: unreferenceableTokenKeys(group, prefix: at))
        }
    }
    return out
}

// MARK: - Token store

/// The tokens a theme and all of its forks share. Guarded by its own lock,
/// which is only ever taken last (after a theme's lock, never before one).
private final class ThemeTokenStore: @unchecked Sendable {
    private let lock = NSLock()
    private var base: ThemeTokens
    private var schemes: [String: ThemeTokens]
    /// Scheme names in a stable order: the initial ones alphabetically (a
    /// Swift dictionary has no order of its own), then each scheme first
    /// introduced through `Theme.extend(_:scheme:)` as it arrives.
    private var order: [String]

    init(base: ThemeTokens, schemes: [String: ThemeTokens]) {
        self.base = base
        self.schemes = schemes
        self.order = schemes.keys.sorted()
    }

    /// Scheme names that have overrides defined.
    func names() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return order
    }

    /// `light`, `dark` and every defined scheme, without duplicates.
    func selectable() -> [String] {
        lock.lock(); defer { lock.unlock() }
        var out = SystemColorScheme.allCases.map { $0.rawValue }
        for name in order where !out.contains(name) {
            out.append(name)
        }
        return out
    }

    /// The base tokens with `scheme`'s overrides merged on top.
    func merged(for scheme: String) -> ThemeTokens {
        lock.lock(); defer { lock.unlock() }
        guard let overrides = schemes[scheme] else { return base }
        return mergeThemeTokens(base, overrides)
    }

    /// Every token set held: the base set first, then each scheme's.
    func allSets() -> [ThemeTokens] {
        lock.lock(); defer { lock.unlock() }
        return [base] + order.compactMap { schemes[$0] }
    }

    /// Merge `tokens` into the base set, or into `scheme`'s overrides.
    func extend(_ tokens: ThemeTokens, scheme: String?) {
        lock.lock(); defer { lock.unlock() }
        if let scheme = scheme {
            if schemes[scheme] == nil { order.append(scheme) }
            schemes[scheme] = mergeThemeTokens(schemes[scheme], tokens)
        } else {
            base = mergeThemeTokens(base, tokens)
        }
    }
}

// MARK: - Theme

/// The app's design tokens and active color scheme. Create one with
/// `createTheme(...)`; see the top of this file for how it reaches templates.
///
/// Thread-safe. A change is published to every attached engine before the
/// mutating call returns — also when that call is made from an action
/// handler: `NativeEngine` runs handlers from `processPendingActions()`,
/// after the native dispatch call has returned (the same reason
/// `ObservableState` writes go straight to the engine), so there is nothing
/// to re-enter and nothing to defer.
///
/// No lock of this class is held while an engine, a listener or the logger
/// is called, so code running under any of them may read or change the
/// theme freely. When changes race, or one is made while a publish is in
/// progress (from another thread, or from a patch callback of that very
/// publish), the thread already publishing sends the newest snapshot again
/// once it is done: every engine ends on the latest tokens, and such a call
/// may return just before they are delivered.
public final class Theme: @unchecked Sendable {
    /// Reserved data-source provider carrying the resolved tokens.
    public static let tokensProvider = "theme"
    /// Reserved data-source provider carrying `{ scheme, preference, … }`.
    public static let metaProvider = "appearance"
    /// The preference that follows the platform's color scheme.
    public static let systemPreference = "system"

    private let store: ThemeTokenStore
    private let lock = NSLock()
    private let onMissingToken: ((String, String) -> Void)?

    // Everything below is guarded by `lock`.
    private var currentPreference: String = Theme.systemPreference
    private var system: SystemColorScheme
    private var resolved: ThemeTokens = [:]
    private var aliasProblems: [String] = []
    private var engines: [ContextEngine] = []
    private var listeners: [(id: UUID, callback: ThemeChangeListener)] = []
    /// Warnings already issued (each is logged once per instance).
    private var warned = Set<String>()
    /// Warnings found under `lock`, logged once it is released.
    private var pendingWarnings: [String] = []
    /// Bumped on every change to what gets published.
    private var version: UInt64 = 0
    /// True while one thread is delivering snapshots to the engines.
    private var publishing = false
    /// A change arrived while `publishing`; the publisher goes round again.
    private var republish = false

    /// Create a theme from `options`. Prefer `createTheme(...)`.
    public convenience init(_ options: ThemeOptions = ThemeOptions()) {
        self.init(options: options, shared: nil)
    }

    private init(options: ThemeOptions, shared: ThemeTokenStore?) {
        self.store = shared ?? ThemeTokenStore(base: options.tokens, schemes: options.schemes)
        self.system = options.systemScheme
        self.onMissingToken = options.onMissingToken

        // No other thread can see this instance yet, so the state is set up
        // without taking `lock`.
        if isSelectable(options.scheme) {
            currentPreference = options.scheme
        } else {
            pendingWarnings.append(
                "Unknown color scheme \"\(options.scheme)\"; following the system scheme")
        }
        if shared == nil {
            for tokens in store.allSets() {
                noteUnreferenceableKeys(tokens)
            }
        }
        rebuild()
        flushWarnings()
    }

    // MARK: Reading

    /// The scheme in effect: the preference, or the system scheme when it is
    /// `"system"`.
    public var scheme: String {
        lock.lock(); defer { lock.unlock() }
        return effectiveScheme()
    }

    /// What was asked for: a scheme name or `"system"`.
    public var preference: String {
        lock.lock(); defer { lock.unlock() }
        return currentPreference
    }

    /// The platform's scheme as last reported.
    public var systemScheme: SystemColorScheme {
        lock.lock(); defer { lock.unlock() }
        return system
    }

    /// Scheme names that have overrides defined: the ones the theme was
    /// created with in alphabetical order, then any added through
    /// `extend(_:scheme:)` in the order they were added.
    public var schemes: [String] {
        return store.names()
    }

    /// The `appearance` data-source payload.
    public var meta: ThemeMeta {
        lock.lock(); defer { lock.unlock() }
        return currentMeta()
    }

    /// The resolved tokens currently published as `theme`.
    public var tokens: ThemeTokens {
        lock.lock(); defer { lock.unlock() }
        return resolved
    }

    /// Alias problems (missing target, cycle) in the active scheme's tokens.
    public var problems: [String] {
        lock.lock(); defer { lock.unlock() }
        return aliasProblems
    }

    /// Whether `path` resolves in the active scheme.
    public func has(_ path: String) -> Bool {
        return lookupThemeToken(tokens, path) != nil
    }

    /// A token's value in the active scheme (a leaf, or a nested dictionary
    /// for a group), for use in handlers. A missing token returns nil and
    /// warns once.
    public func token(_ path: String) -> Any? {
        lock.lock()
        let value = lookupThemeToken(resolved, path)
        let activeScheme = effectiveScheme()
        let firstMiss = value == nil && warned.insert("missing:" + path).inserted
        lock.unlock()

        if firstMiss {
            themeLog.warn("%@", "Missing theme token \"\(path)\" for scheme \"\(activeScheme)\"")
            onMissingToken?(path, activeScheme)
        }
        return value
    }

    // MARK: Changing

    /// Select a scheme by name, or `"system"` to follow the platform, then
    /// republish to every attached engine.
    ///
    /// - Throws: `ThemeError.unknownScheme` for a name that is neither
    ///   `light` / `dark` / `"system"` nor defined in `schemes`; nothing
    ///   changes.
    public func setScheme(_ preference: String) throws {
        lock.lock()
        guard isSelectable(preference) else {
            let known = [Theme.systemPreference] + store.selectable()
            lock.unlock()
            throw ThemeError.unknownScheme(preference, known: known)
        }
        if preference == currentPreference {
            lock.unlock()
            return
        }
        let before = effectiveScheme()
        currentPreference = preference
        let meta = changed(schemeBefore: before)
        lock.unlock()

        flushWarnings()
        publish()
        notifyListeners(meta)
    }

    /// Flip between `light` and `dark`, starting from whichever is in effect.
    public func toggle() {
        let next: SystemColorScheme = scheme == SystemColorScheme.dark.rawValue ? .light : .dark
        do {
            try setScheme(next.rawValue)
        } catch {
            // `light` and `dark` are always selectable.
            themeLog.error("%@", "Theme toggle failed: \(error)")
        }
    }

    /// Report the platform's scheme. Takes effect immediately when the
    /// preference is `"system"`; otherwise it is remembered for when it is.
    public func setSystemScheme(_ scheme: SystemColorScheme) {
        lock.lock()
        if scheme == system {
            lock.unlock()
            return
        }
        let before = effectiveScheme()
        system = scheme
        let meta = changed(schemeBefore: before)
        lock.unlock()

        flushWarnings()
        publish()
        notifyListeners(meta)
    }

    /// Merge more tokens in — into the base set, or into `scheme`'s
    /// overrides — and republish. This is how a component package
    /// contributes defaults.
    public func extend(_ tokens: ThemeTokens, scheme: String? = nil) {
        lock.lock()
        noteUnreferenceableKeys(tokens)
        store.extend(tokens, scheme: scheme)
        if let scheme = scheme, scheme != effectiveScheme() {
            // An inactive scheme's overrides are not in effect: nothing to
            // publish.
            lock.unlock()
            flushWarnings()
            return
        }
        rebuild()
        version += 1
        let meta = currentMeta()
        lock.unlock()

        flushWarnings()
        publish()
        notifyListeners(meta)
    }

    // MARK: Engines, listeners, forks

    /// Publish `theme` and `appearance` to `engine` now and on every change.
    /// Returns a closure that stops publishing (it does not remove the
    /// contexts). The theme keeps a strong reference to the engine until
    /// then.
    @discardableResult
    public func attach(_ engine: ContextEngine) -> () -> Void {
        lock.lock()
        if !engines.contains(where: { $0 === engine }) {
            engines.append(engine)
        }
        let first = snapshot()
        lock.unlock()

        // Delivered here, not left to a publish that may be running on
        // another thread: the caller renders right after this returns.
        deliver(first, to: engine)

        // A change that raced the delivery above may have reached this
        // engine first; publishing again leaves it on the newest snapshot.
        lock.lock()
        let stale = version != first.version
        lock.unlock()
        if stale { publish() }

        return { [weak self, weak engine] in
            guard let self = self, let engine = engine else { return }
            self.lock.lock()
            self.engines.removeAll { $0 === engine }
            self.lock.unlock()
        }
    }

    /// Listen for scheme / token changes. Returns an unsubscribe closure.
    @discardableResult
    public func onChange(_ listener: @escaping ThemeChangeListener) -> () -> Void {
        let id = UUID()
        lock.lock()
        listeners.append((id: id, callback: listener))
        lock.unlock()
        return { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            self.listeners.removeAll { $0.id == id }
            self.lock.unlock()
        }
    }

    /// A new instance with its own scheme preference that shares this one's
    /// tokens — one per `RemoteServer` session. `preference` defaults to
    /// this theme's; an unknown one follows the system scheme.
    public func fork(preference: String? = nil) -> Theme {
        lock.lock()
        let options = ThemeOptions(
            scheme: preference ?? currentPreference,
            systemScheme: system,
            onMissingToken: onMissingToken
        )
        lock.unlock()
        return Theme(options: options, shared: store)
    }

    // MARK: Internals (callers hold `lock` unless noted)

    private func effectiveScheme() -> String {
        return currentPreference == Theme.systemPreference ? system.rawValue : currentPreference
    }

    private func isSelectable(_ preference: String) -> Bool {
        return preference == Theme.systemPreference || store.selectable().contains(preference)
    }

    private func currentMeta() -> ThemeMeta {
        return ThemeMeta(
            scheme: effectiveScheme(),
            preference: currentPreference,
            system: system,
            schemes: store.names()
        )
    }

    private func changed(schemeBefore: String) -> ThemeMeta {
        if effectiveScheme() != schemeBefore { rebuild() }
        version += 1
        return currentMeta()
    }

    private func rebuild() {
        let merged = store.merged(for: effectiveScheme())
        var found: [String] = []
        resolved = resolveTokenAliases(merged) { problem in
            found.append(problem)
        }
        aliasProblems = found
        for problem in found where warned.insert(problem).inserted {
            pendingWarnings.append(problem)
        }
    }

    private func noteUnreferenceableKeys(_ tokens: ThemeTokens) {
        for at in unreferenceableTokenKeys(tokens) where warned.insert("key:" + at).inserted {
            pendingWarnings.append(
                "Token key \"\(at)\" cannot be referenced from a template; "
                    + "use letters, digits and \"_\" only")
        }
    }

    /// Log the warnings collected under `lock`. Called WITHOUT `lock`: a
    /// custom log handler is the app's code.
    private func flushWarnings() {
        lock.lock()
        let messages = pendingWarnings
        pendingWarnings.removeAll()
        lock.unlock()
        for message in messages {
            themeLog.warn("%@", message)
        }
    }

    /// What one publish delivers: both payloads as of `version`.
    private struct Snapshot {
        let meta: [String: Any]
        let tokens: ThemeTokens
        let version: UInt64
    }

    private func snapshot() -> Snapshot {
        return Snapshot(meta: currentMeta().toDictionary(), tokens: resolved, version: version)
    }

    /// Called WITHOUT `lock`: the engine's patch listeners run inside
    /// `setContext` and may call back into this theme.
    private func deliver(_ snapshot: Snapshot, to engine: ContextEngine) {
        do {
            _ = try engine.setContext(Theme.metaProvider, data: snapshot.meta)
            _ = try engine.setContext(Theme.tokensProvider, data: snapshot.tokens)
        } catch {
            themeLog.error("%@", "Failed to publish theme context: \(error)")
        }
    }

    /// Deliver the current snapshot to every attached engine, in attach
    /// order. Called WITHOUT `lock`, after the change it publishes.
    ///
    /// One thread publishes at a time, and none waits for another: a caller
    /// that finds a publish in progress only asks for another round, and the
    /// publishing thread re-reads the snapshot until no change arrived during
    /// its last round. So engines never go back to an older snapshot, and a
    /// thread that is inside an engine (holding whatever that engine holds)
    /// can change the theme without waiting on a publisher that is itself
    /// waiting for that engine.
    private func publish() {
        lock.lock()
        if publishing {
            republish = true
            lock.unlock()
            return
        }
        publishing = true
        lock.unlock()

        while true {
            lock.lock()
            republish = false
            let current = snapshot()
            let targets = engines
            lock.unlock()

            for engine in targets {
                deliver(current, to: engine)
            }

            lock.lock()
            if !republish {
                publishing = false
                lock.unlock()
                return
            }
            lock.unlock()
        }
    }

    /// Called WITHOUT `lock`, so a listener may freely call back into the
    /// theme.
    private func notifyListeners(_ meta: ThemeMeta) {
        lock.lock()
        let callbacks = listeners.map { $0.callback }
        lock.unlock()
        for callback in callbacks {
            callback(meta)
        }
    }
}

// MARK: - createTheme

/// Create the app's theme from `options`. Register it once (e.g.
/// `RemoteServer().theme(theme)`).
public func createTheme(_ options: ThemeOptions) -> Theme {
    return Theme(options)
}

/// Create the app's theme:
///
/// ```swift
/// let theme = createTheme(
///     tokens: ["color": ["surface": "#ffffff", "primary": "{color.brand}", "brand": "#0066ff"]],
///     schemes: ["dark": ["color": ["surface": "#111111"]]]
/// )
/// ```
public func createTheme(
    tokens: ThemeTokens = [:],
    schemes: [String: ThemeTokens] = [:],
    scheme: String = Theme.systemPreference,
    systemScheme: SystemColorScheme = .light,
    onMissingToken: ((String, String) -> Void)? = nil
) -> Theme {
    return Theme(ThemeOptions(
        tokens: tokens,
        schemes: schemes,
        scheme: scheme,
        systemScheme: systemScheme,
        onMissingToken: onMissingToken
    ))
}
