import Foundation

/// Factory for creating nested module instances from an app registry
/// and registering them in a global context.
///
/// Nested modules allow multi-module composition where each module owns its
/// own state and action handlers, and all modules are accessible to each
/// other through the `HypenGlobalContext`.
///
/// ```swift
/// let app = HypenApp()
/// app.module("Counter").defineState(["count": 0])
///     .onAction("increment") { ctx in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + 1)
///     }
///     .build()
///
/// app.module("Profile").defineState(["name": ""])
///     .build()
///
/// let ctx = HypenGlobalContext()
/// let instances = createNestedModuleInstances(app: app, globalContext: ctx)
/// // Both "counter" and "profile" are now registered in ctx
/// ```

/// Create nested module instances for all registered modules in the app that
/// have not yet been instantiated in the global context.
///
/// Module IDs are derived by lowercasing the registered name.
/// Stateless modules (no initial state, no action handlers) are skipped.
///
/// - Parameters:
///   - app: The `HypenApp` containing module definitions.
///   - globalContext: The `HypenGlobalContext` to register instances in.
/// - Returns: A dictionary mapping module names to their created `ModuleInstance`s.
public func createNestedModuleInstances(
    app: HypenApp,
    globalContext: HypenGlobalContext
) -> [String: ModuleInstance] {
    var instances: [String: ModuleInstance] = [:]

    for name in app.getNames() {
        let moduleId = name.lowercased()

        // Skip modules already registered in the context
        if globalContext.hasModule(moduleId) { continue }

        guard let def = app.get(name) else { continue }

        // Skip stateless modules (no state, no handlers)
        if def.initialState.isEmpty
            && def.actionHandlers.isEmpty
            && def.asyncActionHandlers.isEmpty {
            continue
        }

        guard let instance = try? ModuleInstance(definition: def) else {
            // Native engine init failed (likely UniFFI/library load issue).
            // Skip this module rather than crashing module discovery.
            continue
        }
        globalContext.registerModule(moduleId, instance: instance)
        instances[name] = instance
    }

    return instances
}

/// Get merged state from a primary module instance and all nested modules.
/// Returns a single dictionary containing all module states.
///
/// This is the Swift equivalent of the TypeScript SDK's getMergedState().
public func getMergedState(
    primaryInstance: ModuleInstance?,
    nestedInstances: [String: ModuleInstance]
) -> [String: Any] {
    var merged: [String: Any] = [:]

    // Include primary module state
    if let primary = primaryInstance {
        for (key, value) in primary.getState() {
            merged[key] = value
        }
    }

    // Include all nested module states
    for (_, instance) in nestedInstances {
        for (key, value) in instance.getState() {
            merged[key] = value
        }
    }

    return merged
}

/// Destroy all nested module instances and unregister them from the global context.
///
/// - Parameters:
///   - instances: The dictionary returned by `createNestedModuleInstances`.
///   - globalContext: The `HypenGlobalContext` to unregister from.
public func destroyNestedModuleInstances(
    _ instances: [String: ModuleInstance],
    globalContext: HypenGlobalContext
) {
    for (name, instance) in instances {
        let moduleId = name.lowercased()
        instance.destroy()
        globalContext.unregisterModule(moduleId)
    }
}
