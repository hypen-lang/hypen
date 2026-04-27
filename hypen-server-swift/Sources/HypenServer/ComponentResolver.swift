import Foundation

// MARK: - Import Types

/// Type of import clause.
public enum ImportClauseType: String, Sendable {
    case named
    case `default`
}

/// What is being imported.
public struct ImportClause: Sendable {
    public let type: ImportClauseType
    /// For named imports: `{ Button, Card }`
    public let names: [String]
    /// For default imports: `HomePage`
    public let name: String

    public static func named(_ names: [String]) -> ImportClause {
        ImportClause(type: .named, names: names, name: "")
    }

    public static func `default`(_ name: String) -> ImportClause {
        ImportClause(type: .default, names: [], name: name)
    }
}

/// Where the import comes from.
public enum ImportSource: Sendable {
    case local(path: String)
    case url(String)
}

/// A parsed import statement.
public struct ImportStatement: Sendable {
    public let clause: ImportClause
    public let source: ImportSource
}

/// A resolved component with module and template.
public struct ResolvedComponent: @unchecked Sendable {
    public let module: ModuleDefinition?
    public let template: String
}

// MARK: - Resolver Options

/// Configuration for the ComponentResolver.
public struct ResolverOptions: @unchecked Sendable {
    /// Base directory for resolving relative local paths.
    public var baseDir: String
    /// Enable caching of resolved components.
    public var cache: Bool
    /// Custom fetch function for URL imports.
    public var customFetch: ((String) throws -> String)?
    /// App registry for looking up pre-registered modules.
    public var app: HypenApp?

    public init(
        baseDir: String = ".",
        cache: Bool = true,
        customFetch: ((String) throws -> String)? = nil,
        app: HypenApp? = nil
    ) {
        self.baseDir = baseDir
        self.cache = cache
        self.customFetch = customFetch
        self.app = app
    }
}

// MARK: - Component Resolver

/// Resolves and loads components from local files or remote URLs.
///
/// Checks the app registry first, then falls back to file I/O or HTTP fetch.
///
/// ```swift
/// let resolver = ComponentResolver(options: ResolverOptions(baseDir: "./components", app: myApp))
/// let imports = parseImports("import { Button } from \"./button.hypen\"")
/// let resolved = try resolver.resolve(imports[0])
/// ```
public final class ComponentResolver: @unchecked Sendable {
    private let lock = NSLock()
    private var resolvedCache: [String: ResolvedComponent] = [:]
    private let options: ResolverOptions
    private let log = HypenLoggers.resolver

    public init(options: ResolverOptions = ResolverOptions()) {
        self.options = options
    }

    /// Resolve a component from an import statement.
    public func resolve(_ stmt: ImportStatement) throws -> [String: ResolvedComponent] {
        // Check app registry first
        if let app = options.app {
            let names = getImportNames(stmt.clause)
            let allFound = names.allSatisfy { app.has($0) }
            if allFound {
                var result: [String: ResolvedComponent] = [:]
                for name in names {
                    let def = app.get(name)
                    result[name] = ResolvedComponent(module: def, template: def?.ui ?? "")
                }
                return result
            }
        }

        let sourcePath = getSourcePath(stmt.source)

        // Check cache
        if options.cache {
            lock.lock()
            if let cached = resolvedCache[sourcePath] {
                lock.unlock()
                return extractComponents(stmt.clause, component: cached)
            }
            lock.unlock()
        }

        // Load the component
        let component: ResolvedComponent
        switch stmt.source {
        case .local(let path):
            component = try resolveLocal(path)
        case .url(let url):
            component = try resolveURL(url)
        }

        // Cache it
        if options.cache {
            lock.lock()
            resolvedCache[sourcePath] = component
            lock.unlock()
        }

        return extractComponents(stmt.clause, component: component)
    }

    /// Clear the component cache.
    public func clearCache() {
        lock.lock()
        defer { lock.unlock() }
        resolvedCache.removeAll()
    }

    /// Get the number of cached components.
    public var cacheSize: Int {
        lock.lock()
        defer { lock.unlock() }
        return resolvedCache.count
    }

    // MARK: - Private

    private func resolveLocal(_ path: String) throws -> ResolvedComponent {
        let baseURL = URL(fileURLWithPath: options.baseDir).resolvingSymlinksInPath().standardizedFileURL
        let fullURL = URL(fileURLWithPath: path, relativeTo: baseURL).resolvingSymlinksInPath().standardizedFileURL
        guard fullURL.path.hasPrefix(baseURL.path + "/") || fullURL.path == baseURL.path else {
            throw ComponentResolverError.componentNotFound(path)
        }
        let fullPath = fullURL.path

        var hypenPath = fullPath
        if !hypenPath.hasSuffix(".hypen") {
            hypenPath = fullPath + ".hypen"
        }

        let template: String
        if FileManager.default.fileExists(atPath: hypenPath) {
            // Re-validate after .hypen append in case the new path is a symlink escaping baseDir
            let hypenURL = URL(fileURLWithPath: hypenPath).resolvingSymlinksInPath().standardizedFileURL
            guard hypenURL.path.hasPrefix(baseURL.path + "/") || hypenURL.path == baseURL.path else {
                throw ComponentResolverError.componentNotFound(path)
            }
            template = try String(contentsOfFile: hypenURL.path, encoding: .utf8)
        } else if FileManager.default.fileExists(atPath: fullPath) {
            template = try String(contentsOfFile: fullPath, encoding: .utf8)
        } else {
            throw ComponentResolverError.componentNotFound(hypenPath)
        }

        return ResolvedComponent(
            module: AppBuilder([:]).build(),
            template: template
        )
    }

    private func resolveURL(_ url: String) throws -> ResolvedComponent {
        let body: String

        if let customFetch = options.customFetch {
            body = try customFetch(url)
        } else {
            body = try defaultFetch(url)
        }

        guard let data = body.data(using: .utf8) else {
            throw ComponentResolverError.invalidResponse(url)
        }

        struct RemoteComponent: Codable {
            let template: String
            let module: [String: AnyCodable]?
        }

        let decoded = try JSONDecoder().decode(RemoteComponent.self, from: data)

        guard !decoded.template.isEmpty else {
            throw ComponentResolverError.missingTemplate(url)
        }

        let moduleDef: ModuleDefinition
        if let moduleData = decoded.module {
            var initialState: [String: Any] = [:]
            if let stateValue = moduleData["state"]?.value as? [String: Any] {
                initialState = stateValue
            }
            moduleDef = AppBuilder(initialState).build()
        } else {
            moduleDef = AppBuilder([:]).build()
        }

        return ResolvedComponent(module: moduleDef, template: decoded.template)
    }

    /// Synchronously fetch a URL. Blocks the calling thread (intended for init/build-time only).
    private func defaultFetch(_ urlString: String) throws -> String {
        guard let url = URL(string: urlString) else {
            throw ComponentResolverError.invalidURL(urlString)
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw ComponentResolverError.invalidURL(urlString)
        }

        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<String, Error>?

        let task = URLSession.shared.dataTask(with: url) { data, response, error in
            if let error = error {
                result = .failure(error)
            } else if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
                result = .failure(ComponentResolverError.httpError(httpResponse.statusCode, urlString))
            } else if let data = data, let body = String(data: data, encoding: .utf8) {
                result = .success(body)
            } else {
                result = .failure(ComponentResolverError.invalidResponse(urlString))
            }
            semaphore.signal()
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 15) == .timedOut {
            task.cancel()
            throw ComponentResolverError.invalidResponse(urlString)
        }

        switch result {
        case .success(let body): return body
        case .failure(let error): throw error
        case .none: throw ComponentResolverError.invalidResponse(urlString)
        }
    }

    private func getImportNames(_ clause: ImportClause) -> [String] {
        clause.type == .default ? [clause.name] : clause.names
    }

    private func extractComponents(_ clause: ImportClause, component: ResolvedComponent) -> [String: ResolvedComponent] {
        var result: [String: ResolvedComponent] = [:]
        for name in getImportNames(clause) {
            result[name] = component
        }
        return result
    }

    private func getSourcePath(_ source: ImportSource) -> String {
        switch source {
        case .local(let path): return path
        case .url(let url): return url
        }
    }
}

// MARK: - Import Parsing

/// Parse import statements from Hypen DSL text.
///
/// Supports:
/// - `import { Button, Card } from "./components"`
/// - `import HomePage from "https://example.com/page"`
public func parseImports(_ text: String) -> [ImportStatement] {
    let pattern = #"import\s+(?:(\{[^}]*\})|(\w+))\s+from\s+["']([^"']+)["']"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }

    let nsText = text as NSString
    let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))

    return matches.compactMap { match -> ImportStatement? in
        guard match.numberOfRanges >= 4 else { return nil }

        let namedRange = match.range(at: 1)
        let defaultRange = match.range(at: 2)
        let sourceRange = match.range(at: 3)

        guard sourceRange.location != NSNotFound else { return nil }
        let source = nsText.substring(with: sourceRange)

        let clause: ImportClause
        if namedRange.location != NSNotFound {
            let inner = nsText.substring(with: namedRange)
                .trimmingCharacters(in: CharacterSet(charactersIn: "{}"))
            let names = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            clause = .named(names)
        } else if defaultRange.location != NSNotFound {
            clause = .default(nsText.substring(with: defaultRange))
        } else {
            return nil
        }

        let importSource: ImportSource
        if source.hasPrefix("http://") || source.hasPrefix("https://") {
            importSource = .url(source)
        } else {
            importSource = .local(path: source)
        }

        return ImportStatement(clause: clause, source: importSource)
    }
}

/// Remove import statements from Hypen DSL text.
public func removeImports(_ text: String) -> String {
    let pattern = #"import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
    let nsText = text as NSString
    return regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: nsText.length), withTemplate: "")
}

// MARK: - Errors

public enum ComponentResolverError: Error, CustomStringConvertible {
    case componentNotFound(String)
    case invalidURL(String)
    case httpError(Int, String)
    case invalidResponse(String)
    case missingTemplate(String)

    public var description: String {
        switch self {
        case .componentNotFound(let path): return "Component not found: \(path)"
        case .invalidURL(let url): return "Invalid URL: \(url)"
        case .httpError(let code, let url): return "HTTP \(code): \(url)"
        case .invalidResponse(let url): return "Invalid response from: \(url)"
        case .missingTemplate(let url): return "Missing template in response from: \(url)"
        }
    }
}

// MARK: - Logger extension

extension HypenLoggers {
    public static let resolver = HypenLogger("HypenResolver")
}
