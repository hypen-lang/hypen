import Foundation

// MARK: - Typed Module Builder

/// Fluent, chainable module builder with direct state mutation.
///
/// All configuration methods return `self` for chaining. Terminate with
/// `.build()` or `.ui()` to produce a `ModuleDefinition`.
///
/// ```swift
/// struct CounterState: Codable {
///     var count: Int = 0
/// }
///
/// struct AddPayload: Codable { let amount: Int }
///
/// let counter = hypen(CounterState())
///     .onAction("increment") { state in
///         state.count += 1
///     }
///     .onAction("add", payload: AddPayload.self) { state, payload in
///         state.count += payload.amount
///     }
///     .onCreated { state, _ in
///         print("Started at \(state.count)")
///     }
///     .ui("""
///         Column {
///             Text("Count: @{state.count}")
///             Button("@actions.increment") { Text("+") }
///         }
///     """)
/// ```
public final class TypedModuleBuilder<S: Codable>: @unchecked Sendable {
    private let initialState: S
    private var moduleName: String?
    private var _persist: Bool? = nil
    private var _version: Int = 1
    private var template: String?
    private var _actionHandlers: [String: ModuleActionHandler] = [:]
    private var _asyncActionHandlers: [String: AsyncModuleActionHandler] = [:]
    private var errorHandler: ModuleErrorHandler?
    private var disconnectHandler: DisconnectHandler?
    private var reconnectHandler: ReconnectHandler?
    private var expireHandler: ExpireHandler?
    private var _typedCreated: TypedLifecycleHandler<S>?
    private var _typedActivated: TypedLifecycleHandler<S>?
    private var _typedDeactivated: TypedLifecycleHandler<S>?
    private var _typedDestroyed: TypedLifecycleHandler<S>?
    var _app: HypenApp?

    init(_ initialState: S) {
        self.initialState = initialState
    }

    // MARK: - Configuration (fluent)

    /// Set the module name.
    @discardableResult
    public func name(_ name: String) -> Self {
        moduleName = name
        return self
    }

    /// Enable state persistence.
    @discardableResult
    public func persist(_ enabled: Bool = true) -> Self {
        _persist = enabled
        return self
    }

    /// Set the module version.
    @discardableResult
    public func version(_ version: Int) -> Self {
        self._version = version
        return self
    }

    /// Register with an app registry.
    @discardableResult
    public func app(_ app: HypenApp) -> Self {
        self._app = app
        return self
    }

    // MARK: - Action Handlers (fluent)

    /// Register an action handler. Mutate `state` directly.
    ///
    /// ```swift
    /// .onAction("increment") { state in
    ///     state.count += 1
    /// }
    /// ```
    @discardableResult
    public func onAction(_ name: String, handler: @escaping @Sendable (inout S) -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        _actionHandlers[name] = { ctx in
            var typed = decode(ctx.state)
            handler(&typed)
            encode(typed, ctx.state)
        }
        return self
    }

    /// Register an action handler with a typed `Codable` payload.
    ///
    /// ```swift
    /// .onAction("add", payload: AddPayload.self) { state, payload in
    ///     state.count += payload.amount
    /// }
    /// ```
    @discardableResult
    public func onAction<P: Codable>(_ name: String, payload: P.Type, handler: @escaping @Sendable (inout S, P) -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        _actionHandlers[name] = { ctx in
            var typed = decode(ctx.state)
            if let payload = BuilderInternals.deserializePayload(ctx.action.payload, as: P.self) {
                handler(&typed, payload)
            }
            encode(typed, ctx.state)
        }
        return self
    }

    /// Register a typed action handler using a `HypenAction` enum.
    ///
    /// The action enum must conform to both `HypenAction` and `Codable`.
    /// Each incoming action is deserialized into the enum type, giving you
    /// full type safety with `switch`.
    ///
    /// ```swift
    /// enum CounterAction: String, HypenAction, Codable, CaseIterable {
    ///     case increment
    ///     case decrement
    ///     case reset
    /// }
    ///
    /// hypen(CounterState())
    ///     .onAction(CounterAction.self) { state, action in
    ///         switch action {
    ///         case .increment: state.count += 1
    ///         case .decrement: state.count -= 1
    ///         case .reset: state.count = 0
    ///         }
    ///     }
    ///     .build()
    /// ```
    @discardableResult
    public func onAction<A: HypenAction & Codable>(_ actionType: A.Type, handler: @escaping @Sendable (inout S, A) -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        let wrappedHandler: ModuleActionHandler = { ctx in
            var typed = decode(ctx.state)
            if let action = Self.deserializeAction(ctx.action, as: A.self) {
                handler(&typed, action)
            }
            encode(typed, ctx.state)
        }
        // Register for all known action names
        for name in A.allActionNames {
            _actionHandlers[name] = wrappedHandler
        }
        return self
    }

    /// Register an async typed action handler using a `HypenAction` enum.
    @discardableResult
    public func onActionAsync<A: HypenAction & Codable>(_ actionType: A.Type, handler: @escaping @Sendable (inout S, A) async -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        let wrappedHandler: AsyncModuleActionHandler = { ctx in
            var typed = decode(ctx.state)
            if let action = Self.deserializeAction(ctx.action, as: A.self) {
                await handler(&typed, action)
            }
            encode(typed, ctx.state)
        }
        for name in A.allActionNames {
            _asyncActionHandlers[name] = wrappedHandler
        }
        return self
    }

    /// Register an async action handler.
    @discardableResult
    public func onActionAsync(_ name: String, handler: @escaping @Sendable (inout S) async -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        _asyncActionHandlers[name] = { ctx in
            var typed = decode(ctx.state)
            await handler(&typed)
            encode(typed, ctx.state)
        }
        return self
    }

    /// Register an async action handler with a typed `Codable` payload.
    @discardableResult
    public func onActionAsync<P: Codable>(_ name: String, payload: P.Type, handler: @escaping @Sendable (inout S, P) async -> Void) -> Self {
        let encode = Self.encodeState
        let decode = Self.decodeState
        _asyncActionHandlers[name] = { ctx in
            var typed = decode(ctx.state)
            if let payload = BuilderInternals.deserializePayload(ctx.action.payload, as: P.self) {
                await handler(&typed, payload)
            }
            encode(typed, ctx.state)
        }
        return self
    }

    // MARK: - Lifecycle (fluent)

    /// Register a lifecycle handler called when the module is created.
    @discardableResult
    public func onCreated(_ handler: @escaping TypedLifecycleHandler<S>) -> Self {
        _typedCreated = handler
        return self
    }

    /// Register a handler that runs every time the module becomes the
    /// active route target (once after `onCreated` on first mount, and
    /// again on each re-mount from the ManagedRouter's persistence cache).
    @discardableResult
    public func onActivated(_ handler: @escaping TypedLifecycleHandler<S>) -> Self {
        _typedActivated = handler
        return self
    }

    /// Register a handler that runs every time the module stops being
    /// the active route target (before persistence OR before `onDestroyed`).
    @discardableResult
    public func onDeactivated(_ handler: @escaping TypedLifecycleHandler<S>) -> Self {
        _typedDeactivated = handler
        return self
    }

    /// Register a lifecycle handler called when the module is destroyed.
    @discardableResult
    public func onDestroyed(_ handler: @escaping TypedLifecycleHandler<S>) -> Self {
        _typedDestroyed = handler
        return self
    }

    /// Register a disconnect handler.
    @discardableResult
    public func onDisconnect(_ handler: @escaping @Sendable (S, SessionInfo) -> Void) -> Self {
        let decode = Self.decodeState
        disconnectHandler = { state, session in
            let typed = decode(state)
            handler(typed, session)
        }
        return self
    }

    /// Register a reconnect handler with a typed `restore` callback.
    ///
    /// The callback encodes the typed value through JSON before handing it
    /// to the underlying untyped `restore(_ :[String: Any])`, mirroring the
    /// `Codable` semantics used everywhere else in `TypedModuleBuilder`.
    @discardableResult
    public func onReconnect(_ handler: @escaping @Sendable (SessionInfo, _ restore: (S) -> Void) -> Void) -> Self {
        reconnectHandler = { session, rawRestore in
            let typedRestore: (S) -> Void = { value in
                guard
                    let data = try? JSONEncoder().encode(value),
                    let map = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else {
                    return
                }
                rawRestore(map)
            }
            handler(session, typedRestore)
        }
        return self
    }

    /// Escape-hatch: register a reconnect handler that receives the raw
    /// `[String: Any]` restore callback. Prefer the typed variant above.
    @discardableResult
    public func onReconnectRaw(_ handler: @escaping @Sendable (SessionInfo, _ restore: ([String: Any]) -> Void) -> Void) -> Self {
        reconnectHandler = handler
        return self
    }

    /// Register an expire handler.
    @discardableResult
    public func onExpire(_ handler: @escaping @Sendable (SessionInfo) -> Void) -> Self {
        expireHandler = handler
        return self
    }

    /// Register an error handler.
    @discardableResult
    public func onError(_ handler: @escaping ModuleErrorHandler) -> Self {
        errorHandler = handler
        return self
    }

    // MARK: - UI Template (terminal)

    /// Set the UI template and build the module definition.
    ///
    /// This is a **terminal** method — it calls `build()` internally.
    ///
    /// ```swift
    /// let counter = hypen(CounterState())
    ///     .onAction("increment") { state in state.count += 1 }
    ///     .ui("Column { Text(\"Count: @{state.count}\") }")
    /// ```
    public func ui(_ template: String) -> ModuleDefinition {
        self.template = template
        return build()
    }

    /// Load a UI template from a file and build the module definition.
    ///
    /// This is a **terminal** method — it calls `build()` internally.
    public func uiFile(_ path: String) throws -> ModuleDefinition {
        self.template = try String(contentsOfFile: path, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return build()
    }

    // MARK: - Build (terminal)

    /// Build the module definition.
    ///
    /// ```swift
    /// let def = hypen(CounterState())
    ///     .onAction("increment") { state in state.count += 1 }
    ///     .build()
    /// ```
    public func build() -> ModuleDefinition {
        return build(app: _app)
    }

    func build(app: HypenApp?) -> ModuleDefinition {
        let initialMap = Self.stateToMap(initialState)
        let encode = Self.encodeState
        let decode = Self.decodeState

        var createdHandler: LifecycleHandler? = nil
        if let typedCreated = _typedCreated {
            createdHandler = { state in
                var typed = decode(state)
                typedCreated(&typed, nil)
                encode(typed, state)
            }
        }

        var activatedHandler: LifecycleHandler? = nil
        if let typedActivated = _typedActivated {
            activatedHandler = { state in
                var typed = decode(state)
                typedActivated(&typed, nil)
                encode(typed, state)
            }
        }

        var deactivatedHandler: LifecycleHandler? = nil
        if let typedDeactivated = _typedDeactivated {
            deactivatedHandler = { state in
                var typed = decode(state)
                typedDeactivated(&typed, nil)
                encode(typed, state)
            }
        }

        var destroyedHandler: LifecycleHandler? = nil
        if let typedDestroyed = _typedDestroyed {
            destroyedHandler = { state in
                var typed = decode(state)
                typedDestroyed(&typed, nil)
                encode(typed, state)
            }
        }

        let allActions = Array(Set(_actionHandlers.keys).union(_asyncActionHandlers.keys))

        let definition = ModuleDefinition(
            name: moduleName,
            actions: allActions,
            stateKeys: Array(initialMap.keys),
            persist: _persist,
            version: _version,
            initialState: initialMap,
            ui: template,
            onCreated: createdHandler,
            onActivated: activatedHandler,
            onDeactivated: deactivatedHandler,
            onDestroyed: destroyedHandler,
            actionHandlers: _actionHandlers,
            asyncActionHandlers: _asyncActionHandlers,
            onError: errorHandler,
            onDisconnect: disconnectHandler,
            onReconnect: reconnectHandler,
            onExpire: expireHandler
        )

        let resolvedApp = app ?? _app
        if let name = moduleName, !name.isEmpty {
            resolvedApp?.register(name, definition)
        }

        return definition
    }

    // MARK: - State Serialization

    static func stateToMap(_ state: S) -> [String: Any] {
        let data: Data
        do {
            data = try JSONEncoder().encode(state)
        } catch {
            preconditionFailure("Failed to encode state \(S.self): \(error.localizedDescription)")
        }
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            preconditionFailure("State \(S.self) did not encode to a JSON object. Encoded data: \(String(data: data, encoding: .utf8) ?? "<binary>")")
        }
        return dict
    }

    static func decodeState(_ observable: ObservableState) -> S {
        let snapshot = observable.snapshot()
        do {
            let data = try JSONSerialization.data(withJSONObject: snapshot)
            return try JSONDecoder().decode(S.self, from: data)
        } catch {
            // Log the error and return a best-effort decode using the initial defaults.
            // This avoids crashing the server process on state schema mismatches.
            HypenLoggers.engine.error("Failed to decode state as %@: %@", "\(S.self)", "\(error)")
            // Try with empty object as fallback
            if let fallbackData = try? JSONSerialization.data(withJSONObject: [String: Any]()),
               let fallback = try? JSONDecoder().decode(S.self, from: fallbackData) {
                return fallback
            }
            // Try with the original snapshot keys set to nil/defaults
            HypenLoggers.engine.error("Fallback decode also failed for %@. State may be inconsistent.", "\(S.self)")
            // Use "{}" JSON bytes directly as last resort
            if let emptyData = "{}".data(using: .utf8),
               let fallback = try? JSONDecoder().decode(S.self, from: emptyData) {
                return fallback
            }
            // Truly unrecoverable — state type has required fields with no defaults
            preconditionFailure("Cannot decode state as \(S.self): ensure all properties have default values or the state type can decode from an empty object")
        }
    }

    static func encodeState(_ typed: S, _ observable: ObservableState) {
        let newMap = stateToMap(typed)
        let oldMap = observable.snapshot()

        for (key, newValue) in newMap {
            let oldValue = oldMap[key]
            if !isEqual(oldValue, newValue) {
                observable.set(key, newValue)
            }
        }

        for key in oldMap.keys where newMap[key] == nil {
            observable.set(key, NSNull())
        }
    }

    /// Deserialize an Action into a typed HypenAction enum.
    ///
    /// For `RawRepresentable<String>` enums (no associated values), the action
    /// name itself is the raw value. For enums with associated values, the
    /// payload is merged with the action name for decoding.
    static func deserializeAction<A: HypenAction & Codable>(_ action: Action, as type: A.Type) -> A? {
        // Try simple string decoding first (for String-backed RawRepresentable enums)
        // JSON string "increment" decodes to MyEnum.increment for String raw enums
        if let data = try? JSONEncoder().encode(action.name),
           let result = try? JSONDecoder().decode(A.self, from: data) {
            return result
        }

        // For enums with associated values, build a JSON object { "caseName": { payload } }
        do {
            var jsonObj: [String: Any] = [:]
            if let payloadDict = action.payload as? [String: Any] {
                jsonObj[action.name] = payloadDict
            } else {
                jsonObj[action.name] = [String: Any]()
            }
            let data = try JSONSerialization.data(withJSONObject: jsonObj)
            return try JSONDecoder().decode(A.self, from: data)
        } catch {
            return nil
        }
    }

    private static func isEqual(_ a: Any?, _ b: Any?) -> Bool {
        if a == nil && b == nil { return true }
        guard let a = a, let b = b else { return false }
        switch (a, b) {
        case (let a as Int, let b as Int): return a == b
        case (let a as Double, let b as Double): return a == b
        case (let a as String, let b as String): return a == b
        case (let a as Bool, let b as Bool): return a == b
        case (let a as NSNull, let b as NSNull): return true
        default:
            let aData = try? JSONSerialization.data(withJSONObject: a)
            let bData = try? JSONSerialization.data(withJSONObject: b)
            return aData == bData
        }
    }
}

// MARK: - Typed Lifecycle Handler

public typealias TypedLifecycleHandler<S> = @Sendable (inout S, GlobalContext?) -> Void

// MARK: - hypen() Entry Point

/// Create a typed Hypen module builder. **This is the recommended API.**
///
/// Returns a `TypedModuleBuilder` for fluent chaining. Terminate with
/// `.build()` or `.ui()`.
///
/// ```swift
/// let counter = hypen(CounterState())
///     .onAction("increment") { state in
///         state.count += 1
///     }
///     .ui("Column { Text(\"Count: @{state.count}\") }")
/// ```
public func hypen<S: Codable>(_ initialState: S) -> TypedModuleBuilder<S> {
    return TypedModuleBuilder(initialState)
}

/// Create a typed Hypen module builder with a closure (alternative API).
///
/// ```swift
/// let counter = hypen(CounterState()) { module in
///     module.onAction("increment") { state in
///         state.count += 1
///     }
/// }
/// ```
public func hypen<S: Codable>(
    _ initialState: S,
    build: (TypedModuleBuilder<S>) -> Void
) -> ModuleDefinition {
    let builder = TypedModuleBuilder(initialState)
    build(builder)
    return builder.build()
}

/// Create a named typed Hypen module, registered with the given app.
///
/// ```swift
/// let counter = hypen(CounterState(), name: "Counter", app: myApp)
///     .onAction("increment") { state in
///         state.count += 1
///     }
///     .build()
/// ```
public func hypen<S: Codable>(
    _ initialState: S,
    name: String,
    app: HypenApp? = nil
) -> TypedModuleBuilder<S> {
    let builder = TypedModuleBuilder(initialState)
    _ = builder.name(name)
    builder._app = app ?? HypenApp.shared
    return builder
}

/// Create a named typed Hypen module with a closure, registered with the given app.
public func hypen<S: Codable>(
    _ initialState: S,
    name: String,
    app: HypenApp? = nil,
    build: (TypedModuleBuilder<S>) -> Void
) -> ModuleDefinition {
    let builder = TypedModuleBuilder(initialState)
    _ = builder.name(name)
    builder._app = app ?? HypenApp.shared
    build(builder)
    return builder.build()
}
