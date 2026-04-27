package space.hypen.core

import kotlinx.coroutines.CoroutineScope

/**
 * Runtime module instance for a **primary** module.
 *
 * Occupies the engine's primary module slot via [IEngine.setModule], binding
 * to the flat state tree at scope `""`. Use [NestedModuleInstance] instead
 * for named child modules that should live under a scoped `mod:<name>:<path>`
 * namespace without disturbing the primary slot.
 *
 * All lifecycle, action handling, and state observation logic lives in the
 * shared [BaseModuleInstance] base class. This class is a thin constructor
 * wrapper that wires up the primary-module-specific knobs.
 */
class ModuleInstance<T : Any>(
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
    // Primary modules always bind to the flat state tree, not a named scope.
    engineScope = "",
    lifecyclePrefix = "Module",
    anonymousFallback = "AnonymousModule",
    registerFn = { name, actions, stateKeys, initial ->
        engine.setModule(name, actions, stateKeys, initial)
    },
)

/**
 * Router context for action handlers
 */
data class RouterContext(
    val router: HypenRouter,
)
