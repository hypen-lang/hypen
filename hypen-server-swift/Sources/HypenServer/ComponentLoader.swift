import Foundation

// MARK: - Component Definition

/// A discovered/registered component with its template and optional module.
public struct ComponentDefinition: @unchecked Sendable {
    public let name: String
    public let module: ModuleDefinition?
    public let template: String
    public let path: String

    public init(name: String, module: ModuleDefinition? = nil, template: String, path: String = "") {
        self.name = name
        self.module = module
        self.template = template
        self.path = path.isEmpty ? name : path
    }
}

// MARK: - Component Loader

/// Loads and registers Hypen components.
///
/// ```swift
/// let loader = ComponentLoader()
/// loader.register("Counter", module: counterDef, template: "Column { Text(\"@{state.count}\") }")
/// loader.loadFromDirectory("Button", dirPath: "./components/Button")
/// loader.loadFromComponentsDir("./components")
/// ```
public final class ComponentLoader: @unchecked Sendable {
    private let lock = NSLock()
    private var components: [String: ComponentDefinition] = [:]
    private let log = HypenLoggers.loader

    public init() {}

    /// Register a component with its module and template.
    public func register(_ name: String, module: ModuleDefinition? = nil, template: String, path: String = "") {
        lock.lock()
        defer { lock.unlock() }
        components[name] = ComponentDefinition(
            name: name,
            module: module,
            template: template,
            path: path.isEmpty ? name : path
        )
    }

    /// Register a pre-built ComponentDefinition.
    public func register(_ definition: ComponentDefinition) {
        lock.lock()
        defer { lock.unlock() }
        components[definition.name] = definition
    }

    /// Get a registered component by name.
    public func get(_ name: String) -> ComponentDefinition? {
        lock.lock()
        defer { lock.unlock() }
        return components[name]
    }

    /// Check if a component is registered.
    public func has(_ name: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return components[name] != nil
    }

    /// Get all registered component names.
    public func getNames() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(components.keys)
    }

    /// Get all registered components.
    public func getAll() -> [ComponentDefinition] {
        lock.lock()
        defer { lock.unlock() }
        return Array(components.values)
    }

    /// Remove all registered components.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        components.removeAll()
    }

    /// Load a component from a directory.
    /// Expects: `component.hypen` in the directory.
    public func loadFromDirectory(_ name: String, dirPath: String) throws {
        let fileManager = FileManager.default
        var isDir: ObjCBool = false

        guard fileManager.fileExists(atPath: dirPath, isDirectory: &isDir) else {
            throw ComponentLoaderError.directoryNotFound(dirPath)
        }
        guard isDir.boolValue else {
            throw ComponentLoaderError.notADirectory(dirPath)
        }

        let templatePath = (dirPath as NSString).appendingPathComponent("component.hypen")

        guard fileManager.fileExists(atPath: templatePath) else {
            throw ComponentLoaderError.templateNotFound(templatePath)
        }

        let template = try String(contentsOfFile: templatePath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        register(name, template: template, path: dirPath)
        log.debug("Loaded component: %@ from %@", name, dirPath)
    }

    /// Auto-load all components from a directory.
    /// Scans for subdirectories containing `component.hypen`.
    public func loadFromComponentsDir(_ baseDir: String) throws {
        let fileManager = FileManager.default
        var isDir: ObjCBool = false

        guard fileManager.fileExists(atPath: baseDir, isDirectory: &isDir) else {
            log.warn("Components directory not found: %@", baseDir)
            return
        }

        guard isDir.boolValue else {
            throw ComponentLoaderError.notADirectory(baseDir)
        }

        let entries = try fileManager.contentsOfDirectory(atPath: baseDir)

        for entry in entries {
            let entryPath = (baseDir as NSString).appendingPathComponent(entry)

            var entryIsDir: ObjCBool = false
            guard fileManager.fileExists(atPath: entryPath, isDirectory: &entryIsDir),
                  entryIsDir.boolValue else { continue }

            let hypenPath = (entryPath as NSString).appendingPathComponent("component.hypen")
            if fileManager.fileExists(atPath: hypenPath) {
                do {
                    try loadFromDirectory(entry, dirPath: entryPath)
                } catch {
                    log.error("Failed to load component %@: %@", entry, "\(error)")
                }
            }
        }

        lock.lock()
        let count = components.count
        lock.unlock()
        log.debug("Loaded %d components from %@", count, baseDir)
    }
}

// MARK: - Errors

public enum ComponentLoaderError: Error, CustomStringConvertible {
    case directoryNotFound(String)
    case templateNotFound(String)
    case notADirectory(String)

    public var description: String {
        switch self {
        case .directoryNotFound(let path): return "Directory not found: \(path)"
        case .templateNotFound(let path): return "Template not found: \(path)"
        case .notADirectory(let path): return "Not a directory: \(path)"
        }
    }
}

// MARK: - Global Instance

/// Global component loader instance.
public let componentLoader = ComponentLoader()

// MARK: - Logger extension

extension HypenLoggers {
    public static let loader = HypenLogger("HypenLoader")
}
