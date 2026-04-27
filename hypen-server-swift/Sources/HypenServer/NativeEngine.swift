import Foundation
@preconcurrency import HypenEngine

// The UniFFI-generated class `HypenEngine` collides with the module name,
// so we use the disambiguation typealiases from the HypenEngine module.
private typealias FFIEngine = HypenEngineInstance
private typealias FFIPatch = HypenEnginePatch
private typealias FFIPatchType = HypenEnginePatchType
private typealias FFIModuleConfig = HypenEngineModuleConfig
private typealias FFIComponentDef = HypenEngineComponentDef

/// Wraps the UniFFI-generated `HypenEngine` for use in the server SDK.
///
/// Handles type conversion between UniFFI types (`HypenEngine.Patch`, etc.)
/// and the server's own wire-format types (`HypenServer.Patch`).
public final class NativeEngine: @unchecked Sendable {
    private let engine: FFIEngine
    private let lock = NSLock()
    private var actionHandlers: [String: (String, Any?) -> Void] = [:]
    private let log = HypenLoggers.module

    public init() throws {
        self.engine = try FFIEngine()
        engine.registerDefaultPrimitives()
    }

    // MARK: - Module Configuration

    /// Configure the engine's module with name, actions, state keys, and initial state.
    public func setModule(name: String, actions: [String], stateKeys: [String], initialState: [String: Any]) {
        let stateJson: String
        if let data = try? JSONSerialization.data(withJSONObject: initialState),
           let json = String(data: data, encoding: .utf8) {
            stateJson = json
        } else {
            stateJson = "{}"
        }

        let config = FFIModuleConfig(
            name: name,
            actions: actions,
            stateKeys: stateKeys,
            initialStateJson: stateJson
        )
        engine.setModule(config: config)

        // Register all action names so the engine queues them
        for action in actions {
            engine.registerAction(actionName: action)
        }
        // Always register the bind action
        engine.registerAction(actionName: "__hypen_bind")
    }

    /// Register a named module for multi-module apps.
    /// The engine scopes `${state.xxx}` bindings to this module's state when
    /// it renders a component whose source starts with `module <name> { ... }`.
    ///
    /// `actions` populates the module's action-scope map so
    /// `engine.action_scope_for("toggleLike")` returns `Some("homepage")`
    /// and dispatches route to the right scope. Also calls
    /// `registerAction` for each name so `dispatchAction` actually
    /// queues them (unregistered actions are silently dropped by the
    /// Rust engine). Default empty list preserves the prior
    /// no-action-registration behaviour for callers that only need
    /// state scoping.
    public func registerModule(name: String, initialState: [String: Any], actions: [String] = []) {
        let stateJson: String
        if let data = try? JSONSerialization.data(withJSONObject: initialState),
           let json = String(data: data, encoding: .utf8) {
            stateJson = json
        } else {
            stateJson = "{}"
        }
        let config = FFIModuleConfig(
            name: name,
            actions: actions,
            stateKeys: Array(initialState.keys),
            initialStateJson: stateJson
        )
        engine.registerModule(config: config)
        for action in actions {
            engine.registerAction(actionName: action)
        }
    }

    // MARK: - Rendering

    /// Render Hypen DSL source and return patches in the server's wire format.
    public func renderSource(_ source: String) throws -> [[String: Any]] {
        let nativePatches = try engine.renderSource(source: source)
        return nativePatches.map { convertPatch($0) }
    }

    /// Update engine state and return any resulting patches.
    ///
    /// - Parameters:
    ///   - scope: Module name of the target module. An empty string targets
    ///            the primary module set via `setModule`; a non-empty value
    ///            targets a named module registered via `registerModule`. The
    ///            engine canonicalizes case internally, so the host can pass
    ///            the name in any case.
    ///   - state: JSON-compatible patch object deep-merged into the target
    ///            module's state.
    public func updateState(scope: String = "", state: [String: Any]) throws -> [[String: Any]] {
        let data = try JSONSerialization.data(withJSONObject: state)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NativeEngineError.stateSerializationFailed("Failed to encode state as UTF-8")
        }
        let nativePatches = try engine.updateState(scope: scope, stateJson: json)
        return nativePatches.map { convertPatch($0) }
    }

    // MARK: - Route discovery

    /// Parse a DSL source and return every `Router { Route ... }` block
    /// it contains. Used by `RemoteSession` to auto-wire a per-session
    /// ManagedRouter against the template — examples don't need to
    /// repeat the route table in Swift code. Mirrors the TS / Go
    /// `discoverRouters` surface.
    public func discoverRouters(source: String) throws -> [DiscoveredRouter] {
        // The underlying UniFFI free function is `discoverRouters`,
        // which collides name-wise with this method — calling it bare
        // would recursively re-enter. Route through the name-distinct
        // alias exposed in `HypenEngine/Aliases.swift`.
        let json = try _ffiDiscoverRouters(source: source)
        let data = Data(json.utf8)
        return try JSONDecoder().decode([DiscoveredRouter].self, from: data)
    }

    // MARK: - Actions

    /// Dispatch an action to the engine (queues it for pending action retrieval).
    public func dispatchAction(_ name: String, payloadJson: String? = nil) throws {
        try engine.dispatchAction(actionName: name, payloadJson: payloadJson)
    }

    /// Register a handler to be called when the engine produces an action.
    ///
    /// Also registers the action name with the underlying Rust engine so
    /// `dispatchAction` actually queues it. Without the `registerAction`
    /// call the engine's `registered_actions` set wouldn't include the
    /// name, and any wire-level dispatch would be silently dropped. This
    /// is what makes `ManagedRouter.installRouterActions` ("router.push"
    /// etc.) reach their handlers when a DSL `@router.push` fires via
    /// the session's dispatchAction path. Matches Kotlin's NativeEngine
    /// semantics; previously only `setModule` registered actions, which
    /// meant engine-scoped handlers like the router namespace never
    /// became dispatchable.
    public func onAction(_ name: String, handler: @escaping (String, Any?) -> Void) {
        lock.lock()
        actionHandlers[name] = handler
        lock.unlock()
        engine.registerAction(actionName: name)
    }

    /// Process pending actions from the engine and invoke registered handlers.
    public func processPendingActions() {
        let actions = engine.getPendingActions()
        for action in actions {
            lock.lock()
            let handler = actionHandlers[action.name]
            lock.unlock()

            var payload: Any? = nil
            if let json = action.payloadJson,
               let data = json.data(using: .utf8) {
                do {
                    payload = try JSONSerialization.jsonObject(with: data)
                } catch {
                    log.warning("Failed to parse action payload JSON for '\(action.name)': \(error)")
                }
            }

            handler?(action.name, payload)
        }
    }

    // MARK: - Components

    /// Register a component from source.
    public func registerComponent(name: String, source: String, path: String) throws {
        let def = FFIComponentDef(name: name, source: source, path: path)
        try engine.registerComponent(component: def)
    }

    /// Get pending imports from the last render (for component resolution).
    public func getPendingImports() -> [(names: [String], sourcePath: String, sourceType: String)] {
        let imports = engine.getPendingImports()
        return imports.map { imp in
            (names: imp.names, sourcePath: imp.sourcePath, sourceType: imp.sourceType)
        }
    }

    /// Render source that may contain import statements.
    /// Automatically resolves imports using the provided ComponentResolver,
    /// registers the resolved components, and re-renders.
    public func renderDocument(
        source: String,
        resolver: ComponentResolver
    ) throws -> [[String: Any]] {
        // First render to discover imports
        let patches = try renderSource(source)

        // Get pending imports
        let imports = getPendingImports()
        if imports.isEmpty {
            return patches
        }

        // Resolve and register each import
        for imp in imports {
            let clause: ImportClause = .named(imp.names)
            let importSource: ImportSource = imp.sourceType == "url"
                ? .url(imp.sourcePath)
                : .local(path: imp.sourcePath)
            let stmt = ImportStatement(clause: clause, source: importSource)
            do {
                let resolved = try resolver.resolve(stmt)
                for (name, comp) in resolved {
                    try registerComponent(name: name, source: comp.template, path: "")
                }
            } catch {
                log.warning("Failed to resolve import '\(imp.sourcePath)': \(error)")
            }
        }

        // Re-render with resolved components
        return try renderSource(source)
    }

    /// Render source with import resolution AND automatic nested module instantiation.
    ///
    /// This is the Swift equivalent of the TypeScript SDK's Hypen.mount() flow:
    /// render → resolve imports → create nested module instances → re-render.
    public func renderDocumentWithModules(
        source: String,
        resolver: ComponentResolver,
        app: HypenApp,
        globalContext: HypenGlobalContext
    ) throws -> RenderDocumentWithModulesResult {
        // Use existing renderDocument for import resolution
        var patches = try renderDocument(source: source, resolver: resolver)

        // Auto-instantiate nested modules
        let nested = createNestedModuleInstances(app: app, globalContext: globalContext)

        // If we created nested modules, re-render so the engine sees all state
        if !nested.isEmpty {
            patches = try renderSource(source)
        }

        return RenderDocumentWithModulesResult(patches: patches, nestedModules: nested)
    }

    /// Register a primitive element type.
    public func registerPrimitive(_ name: String) {
        engine.registerPrimitive(name: name)
    }

    /// Register resources (flat map of name → raw SVG string) from a JSON string.
    /// The engine owns SVG parsing and resolves `Icon(@resources.name)` into
    /// concrete path data at render time.
    public func registerResources(_ resourcesJson: String) {
        try? engine.registerResources(resourcesJson: resourcesJson)
    }

    // MARK: - Lifecycle

    /// Clear the engine's render tree.
    public func clearTree() {
        engine.clearTree()
    }

    /// Get the current revision number.
    public func getRevision() -> UInt64 {
        engine.getRevision()
    }

    // MARK: - Patch Conversion

    /// Convert a UniFFI Patch to the server's wire-format dictionary.
    private func convertPatch(_ patch: FFIPatch) -> [String: Any] {
        var dict: [String: Any] = [
            "type": patchTypeName(patch.patchType),
            "id": patch.id
        ]

        if let elementType = patch.elementType {
            dict["elementType"] = elementType
        }
        if let propsJson = patch.propsJson,
           let data = propsJson.data(using: .utf8),
           let props = try? JSONSerialization.jsonObject(with: data) {
            dict["props"] = props
        }
        if let name = patch.name {
            dict["name"] = name
        }
        if let valueJson = patch.valueJson,
           let data = valueJson.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data) {
            dict["value"] = value
        }
        if let text = patch.text {
            dict["text"] = text
        }
        if let parentId = patch.parentId {
            dict["parentId"] = parentId
        }
        if let beforeId = patch.beforeId {
            dict["beforeId"] = beforeId
        }

        return dict
    }

    private func patchTypeName(_ type: FFIPatchType) -> String {
        switch type {
        case .create: return "create"
        case .setProp: return "setProp"
        case .removeProp: return "removeProp"
        case .setText: return "setText"
        case .insert: return "insert"
        case .move: return "move"
        case .remove: return "remove"
        // Router subtree cache — emitted by the engine when navigating
        // between routes. See `hypen-engine-rs/src/reconcile/diff.rs`
        // (`Patch::Detach` / `Patch::Attach`) for the producer and
        // `HypenRenderer.applyDetach` / `applyAttach` on iOS for the
        // consumer. Wire name must match the DOM/Compose/iOS strings.
        case .detach: return "detach"
        case .attach: return "attach"
        }
    }
}

/// Result of renderDocumentWithModules.
public struct RenderDocumentWithModulesResult {
    /// Patches from the final render.
    public let patches: [[String: Any]]
    /// Nested modules that were auto-instantiated (name → instance).
    public let nestedModules: [String: ModuleInstance]
}

/// Errors from the NativeEngine wrapper (not from the Rust engine itself).
public enum NativeEngineError: Error, CustomStringConvertible {
    case stateSerializationFailed(String)

    public var description: String {
        switch self {
        case .stateSerializationFailed(let msg): return "State serialization failed: \(msg)"
        }
    }
}
