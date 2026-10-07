import Foundation

// MARK: - HypenAction Protocol

/// Base protocol for typed Hypen actions.
///
/// Implement this as a `Codable` enum to define type-safe actions:
///
/// ```swift
/// enum CounterAction: String, HypenAction, Codable {
///     case increment
///     case decrement
///     case reset
/// }
///
/// // With payloads — use an enum with associated values:
/// enum TodoAction: HypenAction, Codable {
///     case add(text: String)
///     case toggle(index: Int)
///     case clear
///
///     var actionName: String {
///         switch self {
///         case .add: return "add"
///         case .toggle: return "toggle"
///         case .clear: return "clear"
///         }
///     }
/// }
/// ```
public protocol HypenAction: Sendable {
    var actionName: String { get }

    /// All action names this type can represent.
    static var allActionNames: [String] { get }
}

/// Default implementation for RawRepresentable enums (e.g. `String`-backed).
public extension HypenAction where Self: RawRepresentable, Self.RawValue == String {
    var actionName: String { rawValue }
}


/// Default implementation for CaseIterable + RawRepresentable enums.
public extension HypenAction where Self: CaseIterable, Self: RawRepresentable, Self.RawValue == String {
    static var allActionNames: [String] {
        allCases.map { $0.rawValue }
    }
}

/// Fallback — non-CaseIterable types must provide their own.
public extension HypenAction {
    static var allActionNames: [String] { [] }
}

// MARK: - Handler Types

/// Lifecycle handler called when module is created or destroyed.
public typealias LifecycleHandler = @Sendable (ObservableState) -> Void

/// Action handler context provides all data needed to handle an action.
public struct ActionHandlerContext: @unchecked Sendable {
    public let action: Action
    public let state: ObservableState
    public let context: GlobalContext?
    public let router: HypenRouter?
    /// Device Capability Protocol access (RFC 001) for this invocation:
    /// scoped to the module instance's live activation and to the
    /// dispatch's provenance (a replayed or broadcast-derived dispatch gets
    /// `unavailable`). Without a negotiated device plane every call returns
    /// `unavailable` ("device-disabled").
    public let device: DeviceContext

    public init(
        action: Action,
        state: ObservableState,
        context: GlobalContext? = nil,
        router: HypenRouter? = nil,
        device: DeviceContext = .unavailable()
    ) {
        self.action = action
        self.state = state
        self.context = context
        self.router = router
        self.device = device
    }
}

/// Async lifecycle handler with device access, run after the synchronous
/// handler of the same phase (see `AppBuilder.onActivatedAsync`).
public typealias DeviceLifecycleHandler = @Sendable (ObservableState, DeviceContext) async -> Void

/// Typed action handler for module-level dispatch.
public typealias ModuleActionHandler = @Sendable (ActionHandlerContext) -> Void

/// Async action handler.
public typealias AsyncModuleActionHandler = @Sendable (ActionHandlerContext) async -> Void

/// Error context for module error handling.
public struct ErrorContext: @unchecked Sendable {
    public let error: Error
    public let state: ObservableState
    public let actionName: String?
    public let lifecycle: String?
}

/// Error handler result controls error propagation.
public struct ErrorHandlerResult: Sendable {
    public let handled: Bool
    public let rethrow_: Bool

    public init(handled: Bool = false, rethrow_: Bool = false) {
        self.handled = handled
        self.rethrow_ = rethrow_
    }

    public static let handled = ErrorHandlerResult(handled: true)
    public static let rethrown = ErrorHandlerResult(rethrow_: true)
}

/// Error handler for modules.
public typealias ModuleErrorHandler = @Sendable (ErrorContext) -> ErrorHandlerResult?

/// Disconnect handler.
public typealias DisconnectHandler = @Sendable (ObservableState, SessionInfo) -> Void

/// Reconnect handler.
public typealias ReconnectHandler = @Sendable (SessionInfo, _ restore: ([String: Any]) -> Void) -> Void

/// Expire handler.
public typealias ExpireHandler = @Sendable (SessionInfo) -> Void

// MARK: - Module Definition

/// Defines a Hypen module with state, handlers, and UI template.
public struct ModuleDefinition: @unchecked Sendable {
    public let name: String?
    public let actions: [String]
    public let stateKeys: [String]
    /// Whether the ManagedRouter should keep this module instance alive
    /// across navigations. `nil` means "use the default" — which is
    /// `true` for any route whose definition resolves to a module. Set
    /// to `false` explicitly to opt out and restore per-navigation
    /// teardown.
    public let persist: Bool?
    public let version: Int
    public let initialState: [String: Any]
    public let ui: String?
    public let onCreated: LifecycleHandler?
    /// Fires every time the module becomes the active route target.
    /// Runs once right after `onCreated` on first mount, and again on
    /// each re-mount when the ManagedRouter restores a cached instance.
    public let onActivated: LifecycleHandler?
    /// Fires every time the module stops being the active route target.
    /// Runs before the module is cached for persistence OR before
    /// `onDestroyed` if it's being torn down.
    public let onDeactivated: LifecycleHandler?
    public let onDestroyed: LifecycleHandler?
    public let actionHandlers: [String: ModuleActionHandler]
    public let asyncActionHandlers: [String: AsyncModuleActionHandler]
    public let onError: ModuleErrorHandler?
    public let onDisconnect: DisconnectHandler?
    public let onReconnect: ReconnectHandler?
    public let onExpire: ExpireHandler?
    /// When a reconnect restore is expressed through a typed `Codable`
    /// value (`TypedModuleBuilder.onReconnect`), the encoding cannot carry
    /// runtime-owned top-level keys (`__dnd`, …). With this set,
    /// `ModuleInstance.handleReconnect` keeps the live instance's reserved
    /// keys that the restored map does not mention — the same
    /// reserved-key exemption `encodeState` applies (plan §3). Raw
    /// `[String: Any]` restores leave it `false` and replace exactly.
    public let preservesReservedKeysOnRestore: Bool
    /// Async activation handler with device access: runs every time the
    /// module becomes active, with a `DeviceContext` owned by exactly that
    /// activation (RFC 001 §2.7) — its unary device requests still pending
    /// when it returns are cancelled, and deactivation cancels every
    /// activation-owned request.
    public let onActivatedAsync: DeviceLifecycleHandler?

    public init(
        name: String? = nil,
        actions: [String] = [],
        stateKeys: [String] = [],
        persist: Bool? = nil,
        version: Int = 1,
        initialState: [String: Any] = [:],
        ui: String? = nil,
        onCreated: LifecycleHandler? = nil,
        onActivated: LifecycleHandler? = nil,
        onDeactivated: LifecycleHandler? = nil,
        onDestroyed: LifecycleHandler? = nil,
        actionHandlers: [String: ModuleActionHandler] = [:],
        asyncActionHandlers: [String: AsyncModuleActionHandler] = [:],
        onError: ModuleErrorHandler? = nil,
        onDisconnect: DisconnectHandler? = nil,
        onReconnect: ReconnectHandler? = nil,
        onExpire: ExpireHandler? = nil,
        preservesReservedKeysOnRestore: Bool = false,
        onActivatedAsync: DeviceLifecycleHandler? = nil
    ) {
        self.name = name
        self.actions = actions
        self.stateKeys = stateKeys
        self.persist = persist
        self.version = version
        self.initialState = initialState
        self.ui = ui
        self.onCreated = onCreated
        self.onActivated = onActivated
        self.onDeactivated = onDeactivated
        self.onDestroyed = onDestroyed
        self.actionHandlers = actionHandlers
        self.asyncActionHandlers = asyncActionHandlers
        self.onError = onError
        self.onDisconnect = onDisconnect
        self.onReconnect = onReconnect
        self.onExpire = onExpire
        self.preservesReservedKeysOnRestore = preservesReservedKeysOnRestore
        self.onActivatedAsync = onActivatedAsync
    }
}

// MARK: - Module Options

public struct ModuleOptions: Sendable {
    /// Persist the module instance across route navigations. `nil`
    /// means "use the default" — which is persist-by-default for any
    /// module-backed route. Pass `false` to opt out.
    public var persist: Bool?
    public var version: Int
    public var name: String?

    public init(persist: Bool? = nil, version: Int = 1, name: String? = nil) {
        self.persist = persist
        self.version = version
        self.name = name
    }
}

// MARK: - AppBuilder

/// Fluent builder for creating Hypen module definitions.
///
/// Supports both untyped string-based actions and typed `HypenAction` actions.
///
/// ## Untyped (string-based):
/// ```swift
/// let counter = AppBuilder(["count": 0])
///     .onAction("increment") { ctx in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + 1)
///     }
///     .ui("Column { Text(\"Count: @{state.count}\") }")
/// ```
///
/// ## Typed actions:
/// ```swift
/// enum CounterAction: HypenAction {
///     case increment
///     case add(amount: Int)
///     var actionName: String {
///         switch self {
///         case .increment: return "increment"
///         case .add: return "add"
///         }
///     }
/// }
///
/// let counter = AppBuilder(["count": 0])
///     .onAction("increment") { ctx in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + 1)
///     }
///     .onTypedAction(CounterAction.self, "add") { ctx, action in
///         if case .add(let amount) = action {
///             let count = ctx.state.get("count") as? Int ?? 0
///             ctx.state.set("count", count + amount)
///         }
///     }
///     .ui("Column { Text(\"Count: @{state.count}\") }")
/// ```
///
/// ## Typed with Codable payload deserialization:
/// ```swift
/// struct AddPayload: Codable { let amount: Int }
///
/// let counter = AppBuilder(["count": 0])
///     .onAction("add", payloadType: AddPayload.self) { ctx, payload in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + (payload?.amount ?? 0))
///     }
///     .ui("...")
/// ```
public final class AppBuilder: @unchecked Sendable {
    private let initialState: [String: Any]
    private let options: ModuleOptions
    private var createdHandler: LifecycleHandler?
    private var activatedHandler: LifecycleHandler?
    private var deactivatedHandler: LifecycleHandler?
    private var activatedAsyncHandler: DeviceLifecycleHandler?
    private var destroyedHandler: LifecycleHandler?
    private var _actionHandlers: [String: ModuleActionHandler] = [:]
    private var _asyncActionHandlers: [String: AsyncModuleActionHandler] = [:]
    private var errorHandler: ModuleErrorHandler?
    private var disconnectHandler: DisconnectHandler?
    private var reconnectHandler: ReconnectHandler?
    private var expireHandler: ExpireHandler?
    private var template: String?
    private weak var app: HypenApp?

    public init(
        _ initialState: [String: Any],
        options: ModuleOptions? = nil,
        app: HypenApp? = nil
    ) {
        self.initialState = initialState
        self.options = options ?? ModuleOptions()
        self.app = app
    }

    /// Register a handler to be called when the module is created.
    @discardableResult
    public func onCreated(_ handler: @escaping LifecycleHandler) -> AppBuilder {
        createdHandler = handler
        return self
    }

    /// Register a handler that runs every time the module becomes the
    /// active route target.
    ///
    /// Unlike `onCreated`, which only runs once per module instance,
    /// `onActivated` runs on **every** mount — the first one (right
    /// after `onCreated`) and every subsequent re-entry when the
    /// ManagedRouter restores a cached instance. Use for data refresh,
    /// (re)connecting subscriptions, or any "screen became visible"
    /// work.
    @discardableResult
    public func onActivated(_ handler: @escaping LifecycleHandler) -> AppBuilder {
        activatedHandler = handler
        return self
    }

    /// Register an async activation handler with device access (RFC 001
    /// §2.7). Runs after `onActivated` every time the module becomes active,
    /// with a `DeviceContext` owned by exactly that activation: unary device
    /// requests it leaves pending when it returns are cancelled, and
    /// deactivation cancels every request that activation owns.
    @discardableResult
    public func onActivatedAsync(_ handler: @escaping DeviceLifecycleHandler) -> AppBuilder {
        activatedAsyncHandler = handler
        return self
    }

    /// Register a handler that runs every time the module stops being
    /// the active route target.
    ///
    /// Runs before the module is cached for persistence OR before
    /// `onDestroyed` if the module is being torn down. Use for pausing
    /// timers, unsubscribing from ephemeral streams, etc.
    @discardableResult
    public func onDeactivated(_ handler: @escaping LifecycleHandler) -> AppBuilder {
        deactivatedHandler = handler
        return self
    }

    /// Register a handler to be called when the module is destroyed.
    @discardableResult
    public func onDestroyed(_ handler: @escaping LifecycleHandler) -> AppBuilder {
        destroyedHandler = handler
        return self
    }

    /// Register an action handler (string-based, untyped payload).
    @discardableResult
    public func onAction(_ name: String, handler: @escaping ModuleActionHandler) -> AppBuilder {
        _actionHandlers[name] = handler
        return self
    }

    /// Register a typed action handler with Codable payload deserialization.
    ///
    /// The action payload is automatically deserialized from JSON into type `P`.
    ///
    /// ```swift
    /// struct AddPayload: Codable { let amount: Int }
    ///
    /// builder.onAction("add", payloadType: AddPayload.self) { ctx, payload in
    ///     let count = ctx.state.get("count") as? Int ?? 0
    ///     ctx.state.set("count", count + (payload?.amount ?? 0))
    /// }
    /// ```
    @discardableResult
    public func onAction<P: Codable>(
        _ name: String,
        payloadType: P.Type,
        handler: @escaping @Sendable (ActionHandlerContext, P?) -> Void
    ) -> AppBuilder {
        _actionHandlers[name] = { ctx in
            let typed: P? = BuilderInternals.deserializePayload(ctx.action.payload, as: P.self)
            handler(ctx, typed)
        }
        return self
    }

    /// Register a typed action handler for a `HypenAction` enum case.
    ///
    /// ```swift
    /// builder.onTypedAction(CounterAction.self, "add") { ctx, action in
    ///     if case .add(let amount) = action {
    ///         ctx.state.set("count", (ctx.state.get("count") as? Int ?? 0) + amount)
    ///     }
    /// }
    /// ```
    @discardableResult
    public func onTypedAction<A: HypenAction>(
        _ actionType: A.Type,
        _ name: String,
        factory: @escaping @Sendable (Any?) -> A?,
        handler: @escaping @Sendable (ActionHandlerContext, A) -> Void
    ) -> AppBuilder {
        _actionHandlers[name] = { ctx in
            if let action = factory(ctx.action.payload) {
                handler(ctx, action)
            }
        }
        return self
    }

    /// Register an async action handler.
    @discardableResult
    public func onActionAsync(_ name: String, handler: @escaping AsyncModuleActionHandler) -> AppBuilder {
        _asyncActionHandlers[name] = handler
        return self
    }

    /// Register an async typed action handler with Codable payload.
    @discardableResult
    public func onActionAsync<P: Codable>(
        _ name: String,
        payloadType: P.Type,
        handler: @escaping @Sendable (ActionHandlerContext, P?) async -> Void
    ) -> AppBuilder {
        _asyncActionHandlers[name] = { ctx in
            let typed: P? = BuilderInternals.deserializePayload(ctx.action.payload, as: P.self)
            await handler(ctx, typed)
        }
        return self
    }

    /// Register an error handler for the module.
    @discardableResult
    public func onError(_ handler: @escaping ModuleErrorHandler) -> AppBuilder {
        errorHandler = handler
        return self
    }

    /// Register a disconnect handler.
    @discardableResult
    public func onDisconnect(_ handler: @escaping DisconnectHandler) -> AppBuilder {
        disconnectHandler = handler
        return self
    }

    /// Register a reconnect handler.
    @discardableResult
    public func onReconnect(_ handler: @escaping ReconnectHandler) -> AppBuilder {
        reconnectHandler = handler
        return self
    }

    /// Register an expire handler.
    @discardableResult
    public func onExpire(_ handler: @escaping ExpireHandler) -> AppBuilder {
        expireHandler = handler
        return self
    }

    /// Set the inline Hypen DSL template and build the module definition.
    public func ui(_ template: String) -> ModuleDefinition {
        self.template = template
        return build()
    }

    /// Load a UI template from a file and build the module definition.
    public func uiFile(_ path: String) throws -> ModuleDefinition {
        self.template = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        return build()
    }

    /// Build the module definition.
    public func build() -> ModuleDefinition {
        let stateKeys = Array(initialState.keys)
        let allActions = Array(Set(_actionHandlers.keys).union(_asyncActionHandlers.keys))

        let definition = ModuleDefinition(
            name: options.name,
            actions: allActions,
            stateKeys: stateKeys,
            persist: options.persist,
            version: options.version,
            initialState: initialState,
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
            onExpire: expireHandler,
            onActivatedAsync: activatedAsyncHandler
        )

        // Auto-register in app when named
        if let name = options.name, !name.isEmpty {
            app?.register(name, definition)
        }

        return definition
    }

}

// MARK: - HypenApp

/// Singleton app instance — factory and module registry.
///
/// Modules built with a name are automatically registered here.
///
/// ```swift
/// let app = HypenApp.shared
///
/// let counter = app.defineState(["count": 0])
///     .onAction("increment") { ctx in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + 1)
///     }
///     .ui("Column { Text(\"Count: @{state.count}\") }")
/// ```
public final class HypenApp: @unchecked Sendable {
    private let lock = NSLock()
    private var registry: [String: ModuleDefinition] = [:]

    public static let shared = HypenApp()

    public init() {}

    /// Create a builder with initial state.
    public func defineState(_ initialState: [String: Any], options: ModuleOptions? = nil) -> AppBuilder {
        return AppBuilder(initialState, options: options, app: self)
    }

    /// Convenience: start a module builder with a name pre-set.
    public func module(_ name: String) -> ModuleHelper {
        return ModuleHelper(name: name, app: self)
    }

    // MARK: - Registry

    public func register(_ name: String, _ definition: ModuleDefinition) {
        lock.lock()
        defer { lock.unlock() }
        registry[name] = definition
    }

    public func get(_ name: String) -> ModuleDefinition? {
        lock.lock()
        defer { lock.unlock() }
        return registry[name]
    }

    public func has(_ name: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return registry[name] != nil
    }

    public func getNames() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(registry.keys)
    }

    public func unregister(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        registry.removeValue(forKey: name)
    }

    public var size: Int {
        lock.lock()
        defer { lock.unlock() }
        return registry.count
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        registry.removeAll()
    }

    /// Helper for the `app.module("name")` pattern.
    public struct ModuleHelper {
        let name: String
        let app: HypenApp

        /// Untyped: raw `[String: Any]` state. Prefer the typed
        /// `defineState<S: Codable>(_:)` overload below — it gives you a
        /// `TypedModuleBuilder<S>` with struct state access and typed
        /// lifecycle handlers.
        public func defineState(_ initialState: [String: Any], options: ModuleOptions? = nil) -> AppBuilder {
            var opts = options ?? ModuleOptions()
            opts.name = name
            return AppBuilder(initialState, options: opts, app: app)
        }

        /// Typed: define a nested module whose state is a `Codable` struct.
        ///
        /// Returns a `TypedModuleBuilder<S>` with the module name pre-set
        /// and the registry wired up, so chained handlers receive typed
        /// state instead of `[String: Any]`.
        ///
        /// ```swift
        /// struct FeedState: Codable { var items: [String] = [] }
        ///
        /// _ = app.module("Feed")
        ///     .defineState(FeedState())
        ///     .onAction("refresh") { state in state.items = [] }
        ///     .build()
        /// ```
        public func defineState<S: Codable>(_ initialState: S) -> TypedModuleBuilder<S> {
            let builder = TypedModuleBuilder(initialState)
            _ = builder.name(name)
            builder._app = app
            return builder
        }
    }
}

/// Global convenience accessor.
public let app = HypenApp.shared
