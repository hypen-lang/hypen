import Foundation
import HypenEngine

// MARK: - Route Types

/// Route state containing current path and parameters.
public struct RouteState: Sendable {
    public let currentPath: String
    public let params: [String: String]
    public let query: [String: String]
    public let previousPath: String?
}

/// Route match result.
public struct RouteMatch: Sendable {
    public let params: [String: String]
    public let query: [String: String]
    public let path: String
}

/// Route definition for the server.
public struct RouteDefinition: Sendable {
    public let path: String
    public let component: String
    public let module: ModuleDefinition?

    public init(path: String, component: String, module: ModuleDefinition? = nil) {
        self.path = path
        self.component = component
        self.module = module
    }
}

/// Route change callback.
public typealias RouteChangeCallback = (String?, String) -> Void

// MARK: - Discovered routers (for auto-wiring)

/// One route inside a `DiscoveredRouter`.
public struct DiscoveredRoute: Sendable, Codable {
    public let path: String
    public let elementNames: [String]

    enum CodingKeys: String, CodingKey {
        case path
        case elementNames = "element_names"
    }

    public init(path: String, elementNames: [String]) {
        self.path = path
        self.elementNames = elementNames
    }
}

/// A `Router { Route ... }` block discovered in a template, returned
/// by `NativeEngine.discoverRouters`. The SDK cross-references
/// `elementNames` against its `HypenApp` registry to pick the
/// component to mount for each path — first name registered wins, so
/// wrapped templates like `Route("/") { Column { HomePage()
/// BottomNav() } }` still work (HomePage registered, Column /
/// BottomNav not).
public struct DiscoveredRouter: Sendable, Codable {
    public let moduleScope: String?
    public let routes: [DiscoveredRoute]

    enum CodingKeys: String, CodingKey {
        case moduleScope = "module_scope"
        case routes
    }

    public init(moduleScope: String?, routes: [DiscoveredRoute]) {
        self.moduleScope = moduleScope
        self.routes = routes
    }
}

// MARK: - HypenRouter

/// Hash-based router for navigation.
/// Matches the TypeScript/Kotlin/Go HypenRouter API.
///
/// ```swift
/// let router = HypenRouter()
/// router.push("/counter")
/// router.onNavigate { from, to in
///     print("Navigated from \(from ?? "/") to \(to)")
/// }
/// ```
public final class HypenRouter: @unchecked Sendable {
    private var currentPath: String = "/"
    private var previousPath: String?
    private var params: [String: String] = [:]
    private var queryParams: [String: String] = [:]
    private var listeners: [(id: UUID, callback: RouteChangeCallback)] = []
    private let lock = NSLock()

    public init() {}

    /// Navigate to a new path (pushes to history).
    public func push(_ path: String) {
        navigate(path)
    }

    /// Replace the current path (no history entry).
    public func replace(_ path: String) {
        navigate(path, replace: true)
    }

    /// Go back in history.
    public func back() {
        lock.lock()
        let prev = previousPath
        lock.unlock()
        if let prev = prev {
            navigate(prev, replace: true)
        }
    }

    /// Get the current path.
    public func getCurrentPath() -> String {
        lock.lock()
        defer { lock.unlock() }
        return currentPath
    }

    /// Get route parameters.
    public func getParams() -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return params
    }

    /// Get query parameters.
    public func getQuery() -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return queryParams
    }

    /// Get the full route state.
    public func getState() -> RouteState {
        lock.lock()
        defer { lock.unlock() }
        return RouteState(
            currentPath: currentPath,
            params: params,
            query: queryParams,
            previousPath: previousPath
        )
    }

    /// Match a path pattern against a given path.
    ///
    /// Delegates to the engine's canonical `portable_match_path` via
    /// UniFFI; the matcher lives at
    /// `hypen-engine-rs/src/portable/route.rs`.
    public func matchPath(pattern: String, path: String) -> RouteMatch? {
        let cleanPath = path.split(separator: "?").first.map(String.init) ?? path
        let resultJson = portableMatchPath(pattern: pattern, path: cleanPath)

        guard let data = resultJson.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let matched = obj["matched"] as? Bool, matched else {
            return nil
        }
        var params: [String: String] = [:]
        if let raw = obj["params"] as? [String: Any] {
            for (k, v) in raw {
                if let s = v as? String { params[k] = s }
            }
        }
        return RouteMatch(
            params: params,
            query: parseQuery(path),
            path: cleanPath
        )
    }

    /// Check if a pattern matches the current path.
    public func isActive(_ pattern: String) -> Bool {
        lock.lock()
        let path = currentPath
        lock.unlock()
        return matchPath(pattern: pattern, path: path) != nil
    }

    /// Build a URL with optional query parameters via the engine's
    /// canonical `portable_build_url` (percent-encodes keys and values,
    /// sorts keys deterministically).
    public func buildUrl(_ path: String, query: [String: String]? = nil) -> String {
        let q = query ?? [:]
        guard let data = try? JSONSerialization.data(withJSONObject: q, options: []),
              let json = String(data: data, encoding: .utf8),
              let out = try? portableBuildUrl(path: path, queryJson: json) else {
            return path
        }
        return out
    }

    /// Subscribe to route changes. Returns an unsubscribe closure.
    @discardableResult
    public func onNavigate(_ callback: @escaping RouteChangeCallback) -> () -> Void {
        let id = UUID()
        lock.lock()
        listeners.append((id: id, callback: callback))
        lock.unlock()

        return { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.listeners.removeAll { $0.id == id }
            self.lock.unlock()
        }
    }

    // MARK: - Private

    private func navigate(_ path: String, replace: Bool = false) {
        lock.lock()
        let oldPath = currentPath
        if !replace {
            previousPath = oldPath
        }

        let parts = path.split(separator: "?", maxSplits: 1)
        currentPath = String(parts.first ?? "/")
        queryParams = parts.count > 1 ? parseQuery(path) : [:]

        let callbacks = listeners.map { $0.callback }
        let newPath = currentPath
        lock.unlock()

        for callback in callbacks {
            callback(oldPath, newPath)
        }
    }

    private func parseQuery(_ path: String) -> [String: String] {
        // Delegate to the engine's canonical `portable_parse_query`.
        let json = portableParseQuery(fullPath: path)
        guard let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rawQuery = obj["query"] as? [String: Any] else {
            return [:]
        }
        var result: [String: String] = [:]
        for (k, v) in rawQuery {
            if let s = v as? String { result[k] = s }
        }
        return result
    }
}
