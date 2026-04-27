package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Route definition mapping a path to a component and optional module.
 */
data class RouteDefinition(
    /** Route path pattern (e.g., "/", "/profile/:id") */
    val path: String,
    /** Component name — used to look up in HypenApp */
    val component: String,
    /** Inline module definition (alternative to registry lookup) */
    val module: ModuleDefinition<*>? = null
)

/**
 * Managed Router — orchestrates module mount/unmount on route changes.
 *
 * When the router navigates to a route:
 * 1. Deactivates and unmounts the previous module (either persisting it
 *    for later reuse or destroying it).
 * 2. Mounts the new module (creating it fresh or restoring from cache)
 *    and activates it.
 *
 * Module names are used as state prefixes (lowercased) for isolation.
 *
 * ## Persistence (default: on for module-backed routes)
 *
 * By default, any route whose `component` resolves to a registered module
 * definition (or provides one inline via `route.module`) has its module
 * instance **persisted** across navigations. This preserves module state
 * so navigating away and back doesn't re-trigger the initial "loading"
 * state that usually lives in `onCreated`. Opt out by setting
 * `persist = false` on [ModuleOptions]. Routes without a module
 * definition are unchanged.
 *
 * ## Lifecycle on navigation
 *
 * First visit to a route:  construct → onCreated → onActivated
 * Navigate away:            onDeactivated (then persist OR onDestroyed)
 * Revisit (persisted):      onActivated (onCreated does not re-run)
 */
class ManagedRouter(
    private val router: HypenRouter,
    private val engine: IEngine,
    private val registry: HypenApp,
    private val globalContext: HypenGlobalContext,
    /**
     * Coroutine scope used to defer `@router.*` action handlers off the
     * engine's synchronous dispatch call stack. Mirrors TS's
     * `queueMicrotask` / Go's `go func` / Swift's
     * `DispatchQueue.global().async` — without the deferral the WASM
     * state proxy rejects recursive calls with "recursive use of an
     * object".
     */
    private val routerActionScope: CoroutineScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
) {
    private val routes = mutableListOf<RouteDefinition>()
    private var activeModule: NestedModuleInstance<*>? = null
    private var activeRoute: RouteDefinition? = null
    private var unsubscribe: (() -> Unit)? = null
    /**
     * Cached instances for module-backed routes, keyed by the lowercase
     * module id. Populated on unmount (when persistence applies) and
     * consulted on mount to restore state across navigations.
     *
     * Persistence is the default for any route whose component or inline
     * module resolves to a [ModuleDefinition]; opt out by setting
     * `persist = false` on [ModuleOptions].
     */
    private val persistedModules = mutableMapOf<String, NestedModuleInstance<*>>()

    /**
     * Add a route definition.
     */
    fun addRoute(route: RouteDefinition): ManagedRouter {
        routes.add(route)
        return this
    }

    /**
     * Start listening for route changes and mount the initial route.
     */
    fun start() {
        unsubscribe = router.onNavigate { _, to ->
            handleRouteChange(to)
        }

        installRouterActions()

        // Mount initial route
        handleRouteChange(router.getCurrentPath())
    }

    /**
     * Register handlers for the reserved `router.*` action namespace
     * (`push` / `replace` / `back` / `forward`) on the shared engine.
     *
     * Unlike the TS / Go / Swift SDKs, which defer their router
     * mutations off the dispatch stack to avoid the WASM state proxy's
     * reentrance guard, the Kotlin [NativeEngine] reaches the native
     * side through JNA — there's no borrow-checker to trip — so we
     * run the mutation synchronously. That keeps the subsequent engine
     * patches inside the caller's `dispatchAction`/`collectPatches`
     * window so they're shipped in the same WebSocket response.
     *
     * [routerActionScope] is retained on the class so callers that
     * want deferred semantics can still construct a [ManagedRouter] with
     * their own scope and wrap handlers externally; it is unused by the
     * default handlers.
     *
     * Matches the DSL authored as `.onClick(@router.push, to: "/x")`.
     */
    private fun installRouterActions() {
        val router = this.router
        val readTo: (Action) -> String? = { action ->
            val elem = action.payload
            val to = if (elem is JsonObject) {
                (elem["to"] as? JsonPrimitive)?.contentOrNull
            } else null
            to?.takeIf { it.isNotEmpty() }
        }
        engine.onAction("router.push") { action ->
            val to = readTo(action) ?: return@onAction
            router.push(to)
        }
        engine.onAction("router.replace") { action ->
            val to = readTo(action) ?: return@onAction
            router.replace(to)
        }
        engine.onAction("router.back") { _ -> router.back() }
        // `router.forward` — HypenRouter has no forward() on the server
        // side (history only exists on the client), so the handler is a
        // no-op here. Registering it still prevents the engine from
        // complaining that the reserved action name is unhandled.
        engine.onAction("router.forward") { _ -> }
    }

    /**
     * Stop listening and unmount the active module.
     * Also destroys all persisted modules.
     */
    fun stop() {
        unsubscribe?.invoke()
        unsubscribe = null
        unmountActive()

        // Destroy all persisted modules on full stop
        persistedModules.forEach { (moduleId, instance) ->
            instance.destroy()
            globalContext.unregisterNestedModule(moduleId)
        }
        persistedModules.clear()
    }

    /**
     * Get the currently active module instance.
     */
    fun getActiveModule(): NestedModuleInstance<*>? = activeModule

    /**
     * Get the currently active route.
     */
    fun getActiveRoute(): RouteDefinition? = activeRoute

    private fun handleRouteChange(path: String) {
        val matched = matchRoute(path)

        if (matched == null) {
            unmountActive()
            return
        }

        // If same route, no need to remount
        if (activeRoute != null && activeRoute?.path == matched.path) {
            return
        }

        // Unmount old, mount new
        unmountActive()
        mount(matched)
    }

    private fun matchRoute(path: String): RouteDefinition? {
        return routes.firstOrNull { route ->
            router.matchPath(route.path, path) != null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun mount(route: RouteDefinition) {
        // Look up module definition: inline first, then registry
        val definition = route.module ?: registry.get(route.component)
        if (definition == null) {
            activeRoute = route
            return
        }

        // Ensure the definition has a name for state namespacing
        val namedDef = if (definition.name.isNullOrEmpty()) {
            (definition as ModuleDefinition<Any>).copy(name = route.component.lowercase())
        } else {
            definition
        }

        val moduleId = (namedDef.name ?: route.component).lowercase()

        // Check for a persisted instance first. If we hit the cache, we
        // reuse its state verbatim — onCreated has already fired (once)
        // and activate() below will fire onActivated without re-running
        // the one-time setup.
        val persisted = persistedModules[moduleId]
        if (persisted != null) {
            activeModule = persisted
            activeRoute = route
            // Remove from the cache while active so that a concurrent
            // navigation cannot double-mount the same instance.
            persistedModules.remove(moduleId)
            persisted.activate()
            return
        }

        // NestedModuleInstance keeps the primary slot (App) intact —
        // `ModuleInstance` calls `engine.setModule(...)` and clobbers
        // the initial tree's bindings.
        val instance = NestedModuleInstance(
            engine = engine,
            definition = namedDef as ModuleDefinition<Any>,
            routerContext = RouterContext(router),
            globalContext = globalContext
        )

        globalContext.registerNestedModule(moduleId, instance)

        activeModule = instance
        activeRoute = route

        // Fire onActivated after construction (onCreated has already run
        // in the instance's init block).
        instance.activate()
    }

    private fun unmountActive() {
        val module = activeModule ?: return
        val route = activeRoute ?: return

        val definition = route.module ?: registry.get(route.component)
        val moduleId = (definition?.name ?: route.component).lowercase()

        // Persistence default: any route backed by a module definition
        // persists unless the definition explicitly opts out via
        // `persist = false`. Routes with no module definition have
        // nothing to persist.
        //
        //   definition present & persist != false  →  cache the instance
        //   definition present & persist == false  →  destroy the instance
        //   definition missing                     →  nothing to persist
        val persist = definition != null && definition.persist != false

        // Clear the active slot before firing lifecycle hooks so the
        // module cannot observe itself as "active" from onDeactivated.
        activeModule = null
        activeRoute = null

        // Always deactivate first — regardless of whether we persist or
        // destroy — so onDeactivated → (onDestroyed) ordering holds.
        module.deactivate()

        if (persist) {
            // Keep instance alive and registered in GlobalContext
            persistedModules[moduleId] = module
        } else {
            module.destroy()
            globalContext.unregisterNestedModule(moduleId)
        }
    }
}
