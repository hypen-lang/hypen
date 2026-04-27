import Foundation

// MARK: - Discovered Component

/// A component discovered from the filesystem.
public struct DiscoveredComponent: Sendable {
    public let name: String
    public let hypenPath: String
    public let modulePath: String
    public let template: String
    public let hasModule: Bool
}

// MARK: - Discovery Pattern

/// Naming patterns to look for when discovering components.
public enum DiscoveryPattern: String, Sendable {
    /// Folder-based: `ComponentName/component.hypen` + `component.swift`
    case folder
    /// Sibling files: `ComponentName.hypen` + `ComponentName.swift`
    case sibling
    /// Index-based: `ComponentName/index.hypen` + `index.swift`
    case index
}

// MARK: - Discovery Options

/// Configuration for component discovery.
public struct DiscoveryOptions: Sendable {
    /// Which naming patterns to look for.
    public var patterns: [DiscoveryPattern]
    /// Enable scanning subdirectories.
    public var recursive: Bool
    /// Enable debug logging.
    public var debug: Bool

    public init(
        patterns: [DiscoveryPattern] = [.folder, .sibling, .index],
        recursive: Bool = false,
        debug: Bool = false
    ) {
        self.patterns = patterns
        self.recursive = recursive
        self.debug = debug
    }
}

// MARK: - Watch Options

/// Configuration for file watching (extends DiscoveryOptions).
public struct WatchOptions: @unchecked Sendable {
    public var discoveryOptions: DiscoveryOptions
    public var onChange: (([DiscoveredComponent]) -> Void)?
    public var onAdd: ((DiscoveredComponent) -> Void)?
    public var onRemove: ((String) -> Void)?
    public var onUpdate: ((DiscoveredComponent) -> Void)?
    public var pollInterval: TimeInterval

    public init(
        discoveryOptions: DiscoveryOptions = DiscoveryOptions(),
        pollInterval: TimeInterval = 1.0,
        onChange: (([DiscoveredComponent]) -> Void)? = nil,
        onAdd: ((DiscoveredComponent) -> Void)? = nil,
        onRemove: ((String) -> Void)? = nil,
        onUpdate: ((DiscoveredComponent) -> Void)? = nil
    ) {
        precondition(pollInterval > 0, "pollInterval must be positive")
        self.discoveryOptions = discoveryOptions
        self.pollInterval = pollInterval
        self.onChange = onChange
        self.onAdd = onAdd
        self.onRemove = onRemove
        self.onUpdate = onUpdate
    }
}

// MARK: - Component Discovery

/// Discovers Hypen components from the filesystem.
///
/// Supports three naming patterns:
/// - **Folder**: `Counter/component.hypen` + `Counter/component.swift`
/// - **Sibling**: `Counter.hypen` + `Counter.swift`
/// - **Index**: `Counter/index.hypen` + `Counter/index.swift`
///
/// ```swift
/// let components = try discoverComponents("./components")
/// loadDiscoveredComponents(components, into: componentLoader)
/// ```
public func discoverComponents(
    _ baseDir: String,
    options: DiscoveryOptions = DiscoveryOptions()
) throws -> [DiscoveredComponent] {
    let fileManager = FileManager.default
    let resolvedDir = (baseDir as NSString).standardizingPath
    let log = options.debug ? HypenLoggers.discovery : nil

    log?.debug("Scanning directory: %@", resolvedDir)

    var components: [DiscoveredComponent] = []
    var seen = Set<String>()

    func addComponent(_ name: String, hypenPath: String, modulePath: String) {
        guard !seen.contains(name) else {
            log?.debug("Skipping duplicate: %@", name)
            return
        }

        guard let template = try? String(contentsOfFile: hypenPath, encoding: .utf8) else {
            log?.debug("Failed to read template: %@", hypenPath)
            return
        }

        seen.insert(name)
        let hasModule = !modulePath.isEmpty

        components.append(DiscoveredComponent(
            name: name,
            hypenPath: hypenPath,
            modulePath: modulePath,
            template: template.trimmingCharacters(in: .whitespacesAndNewlines),
            hasModule: hasModule
        ))

        if hasModule {
            log?.debug("Found: %@ (with module)", name)
        } else {
            log?.debug("Found: %@ (stateless)", name)
        }
    }

    let hasPattern: (DiscoveryPattern) -> Bool = { options.patterns.contains($0) }

    // Scan for folder-based and index-based components
    func scanFolders(_ dir: String) throws {
        let entries = try fileManager.contentsOfDirectory(atPath: dir)

        for entry in entries {
            let entryPath = (dir as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: entryPath, isDirectory: &isDir),
                  isDir.boolValue else { continue }

            // Folder pattern: Name/component.hypen
            if hasPattern(.folder) {
                let hypenPath = (entryPath as NSString).appendingPathComponent("component.hypen")
                if fileManager.fileExists(atPath: hypenPath) {
                    let modulePath = (entryPath as NSString).appendingPathComponent("component.swift")
                    addComponent(entry, hypenPath: hypenPath,
                                 modulePath: fileManager.fileExists(atPath: modulePath) ? modulePath : "")
                    continue
                }
            }

            // Index pattern: Name/index.hypen
            if hasPattern(.index) {
                let hypenPath = (entryPath as NSString).appendingPathComponent("index.hypen")
                if fileManager.fileExists(atPath: hypenPath) {
                    let modulePath = (entryPath as NSString).appendingPathComponent("index.swift")
                    addComponent(entry, hypenPath: hypenPath,
                                 modulePath: fileManager.fileExists(atPath: modulePath) ? modulePath : "")
                    continue
                }
            }

            // Recursive
            if options.recursive {
                try scanFolders(entryPath)
            }
        }
    }

    // Scan for sibling file components
    func scanSiblings(_ dir: String) throws {
        let entries = try fileManager.contentsOfDirectory(atPath: dir)

        for entry in entries {
            let entryPath = (dir as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: entryPath, isDirectory: &isDir), isDir.boolValue {
                if options.recursive { try scanSiblings(entryPath) }
                continue
            }

            guard entry.hasSuffix(".hypen") else { continue }

            let baseName = String(entry.dropLast(6)) // Remove ".hypen"
            guard baseName != "component" && baseName != "index" else { continue }

            let modulePath = (dir as NSString).appendingPathComponent(baseName + ".swift")
            addComponent(baseName, hypenPath: entryPath,
                         modulePath: fileManager.fileExists(atPath: modulePath) ? modulePath : "")
        }
    }

    if hasPattern(.folder) || hasPattern(.index) {
        try scanFolders(resolvedDir)
    }

    if hasPattern(.sibling) {
        try scanSiblings(resolvedDir)
    }

    log?.debug("Discovered %d components", components.count)
    return components
}

/// Load discovered components into a ComponentLoader.
public func loadDiscoveredComponents(_ components: [DiscoveredComponent], into loader: ComponentLoader) {
    for component in components {
        loader.register(component.name, template: component.template, path: component.hypenPath)
    }
}

// MARK: - Component Watcher

/// Watches a directory for component changes via polling.
///
/// ```swift
/// let watcher = ComponentWatcher(baseDir: "./components", options: WatchOptions(
///     onAdd: { print("Added: \($0.name)") },
///     onRemove: { print("Removed: \($0)") }
/// ))
/// watcher.start()
/// // ... later ...
/// watcher.stop()
/// ```
public final class ComponentWatcher: @unchecked Sendable {
    private let lock = NSLock()
    private let baseDir: String
    private let options: WatchOptions
    private var current: [String: DiscoveredComponent] = [:]
    private var timer: DispatchSourceTimer?
    private var running = false

    public init(baseDir: String, options: WatchOptions = WatchOptions()) {
        self.baseDir = baseDir
        self.options = options
    }

    /// Start watching for changes.
    public func start() {
        lock.lock()
        guard !running else {
            lock.unlock()
            return
        }
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        source.schedule(
            deadline: .now() + options.pollInterval,
            repeating: options.pollInterval
        )
        source.setEventHandler { [weak self] in
            self?.rescan()
        }
        timer = source
        running = true
        lock.unlock()

        // Initial scan
        rescan()
        source.resume()
    }

    /// Stop watching for changes.
    public func stop() {
        lock.lock()
        let currentTimer = timer
        timer = nil
        running = false
        lock.unlock()
        currentTimer?.cancel()
    }

    /// Get the current list of discovered components.
    public func getComponents() -> [DiscoveredComponent] {
        lock.lock()
        defer { lock.unlock() }
        return Array(current.values)
    }

    private func rescan() {
        let newComponents: [DiscoveredComponent]
        do {
            newComponents = try discoverComponents(baseDir, options: options.discoveryOptions)
        } catch {
            HypenLoggers.discovery.error("Rescan failed: %@", "\(error)")
            return
        }

        var newMap: [String: DiscoveredComponent] = [:]
        for c in newComponents {
            newMap[c.name] = c
        }

        lock.lock()
        let oldMap = current
        current = newMap
        lock.unlock()

        // Detect changes
        for (name, component) in newMap {
            if let existing = oldMap[name] {
                if existing.template != component.template || existing.modulePath != component.modulePath {
                    options.onUpdate?(component)
                }
            } else {
                options.onAdd?(component)
            }
        }

        for name in oldMap.keys {
            if newMap[name] == nil {
                options.onRemove?(name)
            }
        }

        options.onChange?(newComponents)
    }
}

// MARK: - Logger extension

extension HypenLoggers {
    public static let discovery = HypenLogger("HypenDiscovery")
}
