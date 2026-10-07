package space.hypen.core

/**
 * Mock engine implementation for testing.
 * Provides tracking of state changes and dispatched actions.
 */
class MockEngine : IEngine {
    private var moduleName: String? = null
    private var moduleActions: List<String> = emptyList()
    private var moduleStateKeys: List<String> = emptyList()
    private var moduleState: MutableMap<String, Any?> = mutableMapOf()
    private val registeredPrimitives: MutableSet<String> = mutableSetOf()
    private var revision: ULong = 0u

    private val actionHandlers: MutableMap<String, EngineActionCallback> = mutableMapOf()
    private val stateChanges: MutableList<StateChange> = mutableListOf()
    /** Scope (lowercase module name, "" for primary) for each recorded state change. */
    private val stateChangeScopes: MutableList<String> = mutableListOf()
    private val dispatchedActions: MutableList<Action> = mutableListOf()
    private var renderCallback: RenderCallback? = null
    var setModuleCallCount: Int = 0
        private set
    var registerModuleCallCount: Int = 0
        private set
    private val registeredModules: MutableMap<String, Map<String, Any?>> = mutableMapOf()
    private val moduleStates: MutableMap<String, MutableMap<String, Any?>> = mutableMapOf()

    override fun setModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    ) {
        moduleName = name
        moduleActions = actions
        moduleStateKeys = stateKeys
        moduleState = initialState.toMutableMap()
        setModuleCallCount++
    }

    override fun registerModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    ) {
        val scope = name.lowercase()
        registeredModules[scope] = initialState
        moduleStates[scope] = initialState.toMutableMap()
        registerModuleCallCount++
    }

    /**
     * Get all modules registered via registerModule (not setModule).
     */
    fun getRegisteredModules(): Map<String, Map<String, Any?>> = registeredModules.toMap()

    override fun onAction(actionName: String, handler: EngineActionCallback) {
        actionHandlers[actionName] = handler
    }

    override fun updateState(
        scope: String,
        paths: List<String>,
        values: Map<String, Any?>
    ) {
        stateChanges.add(StateChange(paths, values))
        stateChangeScopes.add(scope)
        // Update internal state for the target scope
        val target = if (scope.isEmpty()) {
            moduleState
        } else {
            moduleStates.getOrPut(scope) { mutableMapOf() }
        }
        values.forEach { (key, value) ->
            target[key] = value
        }
    }

    /** Get all state changes grouped with their scope ("" for primary module). */
    fun getScopedStateChanges(): List<Pair<String, StateChange>> =
        stateChangeScopes.zip(stateChanges)

    /** Get the current state of a named module registered via [registerModule]. */
    fun getNamedModuleState(scope: String): Map<String, Any?>? =
        moduleStates[scope]?.toMap()

    override fun dispatchAction(name: String, payload: Any?) {
        val action = Action(name, payload?.toJsonElement())
        dispatchedActions.add(action)
        triggerAction(name, payload)
    }

    override fun setRenderCallback(callback: RenderCallback) {
        renderCallback = callback
    }

    override fun triggerAction(name: String, payload: Any?) {
        val action = Action(name, payload?.toJsonElement())
        val scoped = actionHandlers.keys.filter { it.startsWith("__hypen_scoped:") && it.endsWith(":$name") }
        (actionHandlers[name] ?: scoped.singleOrNull()?.let { actionHandlers[it] })?.invoke(action)
    }

    override fun renderSource(source: String): List<Patch> {
        // MockEngine doesn't parse — return empty patches
        return emptyList()
    }

    override fun registerPrimitive(name: String) {
        registeredPrimitives.add(name)
    }

    override fun registerDefaultPrimitives() {
        // MockEngine doesn't need actual primitives
    }

    override fun clearTree() {
        revision++
    }

    override fun getRevision(): ULong = revision

    /**
     * Simulate rendering patches (for testing)
     */
    fun simulateRender(patches: List<Patch>) {
        renderCallback?.invoke(patches)
    }

    /**
     * Get all recorded state changes
     */
    fun getStateChanges(): List<StateChange> = stateChanges.toList()

    /**
     * Get all dispatched actions
     */
    fun getDispatchedActions(): List<Action> = dispatchedActions.toList()

    /**
     * Clear recorded state changes
     */
    fun clearStateChanges() {
        stateChanges.clear()
    }

    /**
     * Clear dispatched actions
     */
    fun clearDispatchedActions() {
        dispatchedActions.clear()
    }

    /**
     * Check if an action handler is registered
     */
    fun hasAction(name: String): Boolean = actionHandlers.containsKey(name) || actionHandlers.keys.any { it.startsWith("__hypen_scoped:") && it.endsWith(":$name") }

    /**
     * Get all registered action names
     */
    fun getRegisteredActions(): List<String> = actionHandlers.keys.toList()

    /**
     * Get the current module state
     */
    fun getModuleState(): Map<String, Any?> = moduleState.toMap()

    /**
     * Get registered primitive names (for testing)
     */
    fun getRegisteredPrimitives(): Set<String> = registeredPrimitives.toSet()

    /**
     * Reset the engine to initial state
     */
    fun reset() {
        moduleName = null
        moduleActions = emptyList()
        moduleStateKeys = emptyList()
        moduleState.clear()
        registeredPrimitives.clear()
        actionHandlers.clear()
        stateChanges.clear()
        stateChangeScopes.clear()
        dispatchedActions.clear()
        renderCallback = null
        setModuleCallCount = 0
        registerModuleCallCount = 0
        registeredModules.clear()
        moduleStates.clear()
        revision = 0u
    }
}

fun mockEngine(block: MockEngine.() -> Unit = {}): MockEngine {
    return MockEngine().apply(block)
}
