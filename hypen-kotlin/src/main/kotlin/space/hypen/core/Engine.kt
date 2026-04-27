package space.hypen.core

/**
 * Interface for engine implementations.
 * Matches the TypeScript IEngine interface.
 */
interface IEngine {
    /**
     * Set the current module with its configuration
     */
    fun setModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    )

    /**
     * Register a named module for multi-module apps.
     * Unlike [setModule], this does NOT replace the primary module slot —
     * it adds a named module whose state is scoped under `module <name> { ... }` blocks.
     */
    fun registerModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    ) {
        // Default no-op; NativeEngine provides the real implementation.
    }

    /**
     * Register an action handler
     */
    fun onAction(actionName: String, handler: EngineActionCallback)

    /**
     * Apply a state patch to a specific module and re-render affected nodes.
     *
     * @param scope  Lowercased module name of the target module. An empty string
     *               targets the primary module slot (set via [setModule]); a
     *               non-empty value targets a named module registered via
     *               [registerModule].
     * @param paths  The paths that changed (relative to the target module's state).
     * @param values Flat map of path → new value containing every path listed
     *               in [paths]. Used to build the JSON patch applied to the engine.
     */
    fun updateState(scope: String, paths: List<String>, values: Map<String, Any?>)

    /**
     * Dispatch an action
     */
    fun dispatchAction(name: String, payload: Any? = null)

    /**
     * Set the render callback for receiving patches
     */
    fun setRenderCallback(callback: RenderCallback)

    /**
     * Trigger an action (for testing)
     */
    fun triggerAction(name: String, payload: Any? = null)

    /**
     * Render Hypen DSL source and return patches.
     */
    fun renderSource(source: String): List<Patch> = emptyList()

    /**
     * Register resources from a flat JSON map of name → raw SVG string.
     * Example: `{"heart": "<svg>...</svg>", "search": "<svg>...</svg>"}`
     *
     * The engine owns SVG parsing. SDKs pass raw SVG strings through this
     * method; at render time the engine resolves `Icon(@resources.name)`
     * references into concrete path data for the patch.
     */
    fun registerResources(resourcesJson: String) {}

    /**
     * Register a primitive element type.
     */
    fun registerPrimitive(name: String) {}

    /**
     * Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
     * Calls the engine's built-in default primitives list.
     */
    fun registerDefaultPrimitives() {}

    /**
     * Clear the render tree.
     */
    fun clearTree() {}

    /**
     * Get the current revision number.
     */
    fun getRevision(): ULong = 0u
}
