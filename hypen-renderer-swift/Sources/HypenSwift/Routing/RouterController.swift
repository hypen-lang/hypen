import Foundation
import Combine

/// State representing the current router state
public struct RouterState: Equatable {
    public let currentPath: String
    public let params: [String: String]
    public let query: [String: String]
    public let previousPath: String?

    public init(
        currentPath: String,
        params: [String: String] = [:],
        query: [String: String] = [:],
        previousPath: String? = nil
    ) {
        self.currentPath = currentPath
        self.params = params
        self.query = query
        self.previousPath = previousPath
    }
}

/// Result of matching a path against a pattern
public struct RouteMatch: Equatable {
    public let path: String
    public let params: [String: String]
    public let query: [String: String]

    public init(
        path: String,
        params: [String: String] = [:],
        query: [String: String] = [:]
    ) {
        self.path = path
        self.params = params
        self.query = query
    }
}

/// Simple client-side router controller for managing navigation state.
@MainActor
public final class RouterController: ObservableObject {
    private var history: [String] = []
    private var historyIndex: Int = 0

    @Published public private(set) var state: RouterState

    public init(initialPath: String = "/") {
        let (path, query) = Self.normalizePath(initialPath)
        history.append(path)
        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: nil
        )
    }

    /// Navigate to a new path, adding it to history
    public func push(_ rawPath: String) {
        let (path, query) = Self.normalizePath(rawPath)
        guard path != state.currentPath || query != state.query else { return }

        // Clear forward history if we're not at the end
        if historyIndex < history.count - 1 {
            history.removeSubrange((historyIndex + 1)...)
        }

        history.append(path)
        historyIndex = history.count - 1

        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: state.currentPath
        )
    }

    /// Replace the current path without adding to history
    public func replace(_ rawPath: String) {
        let (path, query) = Self.normalizePath(rawPath)

        if history.isEmpty {
            history.append(path)
            historyIndex = 0
        } else {
            history[historyIndex] = path
        }

        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: state.currentPath
        )
    }

    /// Go back in history
    public func back() {
        guard historyIndex > 0 else { return }

        historyIndex -= 1
        let (path, query) = Self.normalizePath(history[historyIndex])

        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: state.currentPath
        )
    }

    /// Go forward in history
    public func forward() {
        guard historyIndex < history.count - 1 else { return }

        historyIndex += 1
        let (path, query) = Self.normalizePath(history[historyIndex])

        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: state.currentPath
        )
    }

    /// Sync the router to an externally provided path (e.g., from props/state)
    public func sync(_ rawPath: String?) {
        guard let rawPath = rawPath else { return }
        let (path, query) = Self.normalizePath(rawPath)
        guard path != state.currentPath || query != state.query else { return }

        history.removeAll()
        history.append(path)
        historyIndex = 0

        state = RouterState(
            currentPath: path,
            query: query,
            previousPath: state.currentPath
        )
    }

    /// Update the current match params
    public func setMatch(_ match: RouteMatch) {
        state = RouterState(
            currentPath: state.currentPath,
            params: match.params,
            query: match.query,
            previousPath: state.previousPath
        )
    }

    /// Check if a pattern matches the current path
    public func isActive(_ pattern: String) -> Bool {
        matchPath(pattern: pattern) != nil
    }

    /// Match a pattern against a path
    public func matchPath(pattern: String, rawPath: String? = nil) -> RouteMatch? {
        let targetPath = Self.normalizeRoute(pattern)
        let (path, query) = Self.normalizePath(rawPath ?? state.currentPath)

        // Exact match
        if targetPath == path {
            return RouteMatch(path: path, query: query)
        }

        // Wildcard match: /path/*
        if targetPath.hasSuffix("/*") {
            let prefix = String(targetPath.dropLast(2))
            if path == prefix || path.hasPrefix(prefix + "/") {
                return RouteMatch(path: path, query: query)
            }
        }

        // Parameter matching: /users/:id
        var paramNames: [String] = []
        var regexPattern = NSRegularExpression.escapedPattern(for: targetPath)

        // Replace :paramName with capture groups
        let paramRegex = try? NSRegularExpression(pattern: ":([a-zA-Z_][a-zA-Z0-9_]*)")
        if let matches = paramRegex?.matches(in: targetPath, range: NSRange(targetPath.startIndex..., in: targetPath)) {
            for match in matches.reversed() {
                if let range = Range(match.range(at: 1), in: targetPath) {
                    paramNames.insert(String(targetPath[range]), at: 0)
                }
            }
            regexPattern = regexPattern.replacingOccurrences(
                of: "\\\\:([a-zA-Z_][a-zA-Z0-9_]*)",
                with: "([^/]+)",
                options: .regularExpression
            )
        }

        // Replace * with .*
        regexPattern = regexPattern.replacingOccurrences(of: "\\*", with: ".*")

        guard let regex = try? NSRegularExpression(pattern: "^\(regexPattern)$") else {
            return nil
        }

        guard let match = regex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) else {
            return nil
        }

        var params: [String: String] = [:]
        for (index, name) in paramNames.enumerated() {
            if let range = Range(match.range(at: index + 1), in: path) {
                params[name] = Self.decodeSegment(String(path[range]))
            }
        }

        return RouteMatch(path: path, params: params, query: query)
    }

    // MARK: - Private Helpers

    private static func normalizePath(_ rawPath: String) -> (path: String, query: [String: String]) {
        guard !rawPath.trimmingCharacters(in: .whitespaces).isEmpty else {
            return ("/", [:])
        }

        let parts = rawPath.split(separator: "?", maxSplits: 1)
        var path = String(parts.first ?? "/")
        if !path.hasPrefix("/") {
            path = "/" + path
        }

        let query: [String: String]
        if parts.count > 1 {
            query = parseQuery(String(parts[1]))
        } else {
            query = [:]
        }

        return (path, query)
    }

    private static func normalizeRoute(_ pattern: String) -> String {
        guard !pattern.trimmingCharacters(in: .whitespaces).isEmpty else {
            return "/"
        }
        return pattern.hasPrefix("/") ? pattern : "/" + pattern
    }

    private static func parseQuery(_ queryString: String) -> [String: String] {
        guard !queryString.isEmpty else { return [:] }

        var result: [String: String] = [:]
        for part in queryString.split(separator: "&") {
            let pieces = part.split(separator: "=", maxSplits: 1)
            guard !pieces.isEmpty, !pieces[0].isEmpty else { continue }
            let key = decodeSegment(String(pieces[0]))
            let value = pieces.count > 1 ? decodeSegment(String(pieces[1])) : ""
            result[key] = value
        }
        return result
    }

    private static func decodeSegment(_ value: String) -> String {
        value.removingPercentEncoding ?? value
    }
}
