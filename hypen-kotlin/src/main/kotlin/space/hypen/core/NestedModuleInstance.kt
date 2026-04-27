package space.hypen.core

import kotlinx.coroutines.CoroutineScope

/**
 * Runtime module instance for a **nested (child)** module.
 *
 * Unlike [ModuleInstance], this does NOT call [IEngine.setModule] — the
 * parent module owns the engine's primary module slot. Instead, the nested
 * module registers itself via [IEngine.registerModule] and forwards state
 * changes to the engine under its own lowercase scope via
 * [IEngine.updateState], keeping its state namespaced without disturbing
 * the primary module.
 *
 * All lifecycle, action handling, and state observation logic lives in the
 * shared [BaseModuleInstance] base class. This class is a thin constructor
 * wrapper that wires up the nested-module-specific knobs.
 */
class NestedModuleInstance<T : Any>(
    engine: IEngine,
    definition: ModuleDefinition<T>,
    routerContext: RouterContext? = null,
    globalContext: GlobalContext? = null,
    scope: CoroutineScope? = null,
) : BaseModuleInstance<T>(
    engine = engine,
    definition = definition,
    routerContext = routerContext,
    globalContext = globalContext,
    scope = scope,
    // Nested modules scope state under their own name; engine lowercases internally.
    engineScope = definition.name ?: "",
    lifecyclePrefix = "Nested module",
    anonymousFallback = "AnonymousNestedModule",
    registerFn = { name, actions, stateKeys, initial ->
        engine.registerModule(name, actions, stateKeys, initial)
    },
)
