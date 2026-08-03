package space.hypen.core

import uniffi.hypen_engine.HypenEngine as NativeHypenEngine
import uniffi.hypen_engine.Patch as NativePatch
import uniffi.hypen_engine.PatchType as NativePatchType
import uniffi.hypen_engine.ModuleConfig as NativeModuleConfig
import uniffi.hypen_engine.ComponentDef as NativeComponentDef
import uniffi.hypen_engine.ImportInfo as NativeImportInfo
import uniffi.hypen_engine.HypenException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.encodeToString

/**
 * Native Hypen engine implementation using UniFFI bindings to the Rust engine.
 *
 * This provides full parsing and rendering capabilities via the native Rust library.
 *
 * Usage:
 * ```kotlin
 * val engine = NativeEngine()
 * engine.registerPrimitive("Text")
 * engine.registerPrimitive("Column")
 *
 * engine.setRenderCallback { patches -> println("Got ${patches.size} patches") }
 * engine.renderSource("""Text("Hello World")""")
 * ```
 *
 * Note: Requires the native library (libhypen_engine.so/.dylib/.dll) to be available
 * in the library path.
 */
class NativeEngine : IEngine, AutoCloseable {
    private val native: NativeHypenEngine = NativeHypenEngine()
    private val actionHandlers = mutableMapOf<String, EngineActionCallback>()
    private var renderCallback: RenderCallback? = null

    /**
     * Parse Hypen DSL source and return the AST as JSON.
     * @throws EngineError.Parse if the source fails to parse
     */
    fun parseToJson(source: String): String {
        return try {
            native.parseToJson(source)
        } catch (e: HypenException.ParseException) {
            throw EngineError.Parse(e.v1, e)
        }
    }

    /**
     * Render Hypen DSL source, return the patches, and invoke the render callback.
     * @throws EngineError.Parse if the source fails to parse
     * @throws EngineError.Render if rendering fails
     */
    override fun renderSource(source: String): List<Patch> {
        return try {
            val patches = native.renderSource(source).map { it.toPatch() }
            if (patches.isNotEmpty()) {
                renderCallback?.invoke(patches)
            }
            patches
        } catch (e: HypenException.ParseException) {
            throw EngineError.Parse(e.v1, e)
        } catch (e: HypenException.RenderException) {
            throw EngineError.Render(e.v1, e)
        }
    }

    /**
     * Update engine state for the given [scope] with a JSON patch and return resulting patches.
     * Empty [scope] targets the primary module; a non-empty lowercase name targets a
     * registered named module. Also invokes the render callback if patches are produced.
     * @throws EngineError.State if the state patch is invalid
     */
    fun updateStateJson(scope: String, stateJson: String): List<Patch> {
        return try {
            val patches = native.updateState(scope, stateJson).map { it.toPatch() }
            if (patches.isNotEmpty()) {
                renderCallback?.invoke(patches)
            }
            patches
        } catch (e: HypenException.StateException) {
            throw EngineError.State(e.v1, e)
        }
    }

    /**
     * Register resources from a flat JSON map of name → raw SVG string.
     * Example: `{"heart": "<svg>...</svg>", "search": "<svg>...</svg>"}`
     */
    override fun registerResources(resourcesJson: String) {
        try {
            native.registerResources(resourcesJson)
        } catch (e: HypenException) {
            throw EngineError.Render("Failed to register resources: ${e.message}", e)
        }
    }

    /**
     * Register a primitive element type.
     */
    override fun registerPrimitive(name: String) {
        native.registerPrimitive(name)
    }

    /**
     * Register all standard Hypen primitives.
     * Calls the engine's built-in list so the SDK doesn't maintain its own copy.
     */
    override fun registerDefaultPrimitives() {
        native.registerDefaultPrimitives()
    }

    /**
     * Register a component from source.
     * @throws EngineError.ComponentNotFound if the component cannot be registered
     * @throws EngineError.Parse if the component source fails to parse
     */
    fun registerComponent(name: String, source: String, path: String = "") {
        try {
            native.registerComponent(NativeComponentDef(name, source, path))
        } catch (e: HypenException.ComponentException) {
            throw EngineError.ComponentNotFound(name, e)
        } catch (e: HypenException.ParseException) {
            throw EngineError.Parse(e.v1, e)
        }
    }

    /**
     * Clear the render tree.
     */
    override fun clearTree() {
        native.clearTree()
    }

    /**
     * Get the current revision number.
     */
    override fun getRevision(): ULong {
        return native.getRevision()
    }

    /**
     * Get pending imports from the last rendered document.
     * Call this after renderSource() to discover which components need to be resolved.
     * Returns a list of ImportStatement objects describing the imports found.
     */
    fun getPendingImports(): List<ImportStatement> {
        return native.getPendingImports().map { it.toImportStatement() }
    }

    /**
     * Render source that may contain import statements.
     * Automatically resolves imports using the provided ComponentResolver,
     * registers the resolved components, and re-renders.
     *
     * @param source The Hypen DSL source (may include import statements)
     * @param resolver The ComponentResolver to use for resolving imports
     * @return The final list of patches after all imports are resolved
     */
    fun renderDocument(source: String, resolver: ComponentResolver): List<Patch> {
        // First render to discover imports
        val patches = renderSource(source)

        // Get pending imports
        val imports = getPendingImports()
        if (imports.isEmpty()) {
            return patches
        }

        // Resolve and register each import
        val log = HypenLoggers.engine
        for (imp in imports) {
            try {
                val resolved = resolver.resolve(imp)
                for ((name, def) in resolved) {
                    registerComponent(name, def.template, def.path)
                }
            } catch (e: Exception) {
                log.warn("Failed to resolve import '${imp.sourcePath}': ${e.stackTraceToString()}")
            }
        }

        // Re-render with resolved components
        return renderSource(source)
    }

    /**
     * Render source with import resolution AND automatic nested module instantiation.
     *
     * This is the Kotlin equivalent of the TypeScript SDK's Hypen.mount() flow:
     * render → resolve imports → create nested module instances → re-render.
     *
     * @param source The Hypen DSL source
     * @param resolver The ComponentResolver for import resolution
     * @param app The HypenApp registry containing module definitions
     * @param globalContext The global context for module registration
     * @param routerContext Optional router context for action handlers
     * @return RenderDocumentResult containing patches and created nested modules
     */
    fun renderDocumentWithModules(
        source: String,
        resolver: ComponentResolver,
        app: HypenApp,
        globalContext: HypenGlobalContext,
        routerContext: RouterContext? = null
    ): RenderDocumentResult {
        // Use existing renderDocument for import resolution and template registration
        val patches = renderDocument(source, resolver)

        // Auto-instantiate nested modules from the app registry
        val nested = createNestedModuleInstances(this, app, globalContext, routerContext)

        // If we created nested modules, re-render so the engine sees all state
        val finalPatches = if (nested.isNotEmpty()) {
            renderSource(source)
        } else {
            patches
        }

        return RenderDocumentResult(finalPatches, nested)
    }

    // IEngine interface implementation

    override fun setModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    ) {
        val stateJson = initialState.toJsonElement().toString()

        native.setModule(NativeModuleConfig(
            name = name,
            actions = actions,
            stateKeys = stateKeys,
            initialStateJson = stateJson
        ))

        // Register action handlers
        actions.forEach { actionName ->
            native.registerAction(actionName)
        }
    }

    /**
     * Register a named module with the native engine for multi-module scoping.
     * The engine will scope `${state.xxx}` bindings to this module's state
     * when rendering `module <name> { ... }` blocks.
     */
    override fun registerModule(
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initialState: Map<String, Any?>
    ) {
        val stateJson = initialState.toJsonElement().toString()

        native.registerModule(NativeModuleConfig(
            name = name,
            actions = actions,
            stateKeys = stateKeys,
            initialStateJson = stateJson
        ))

        // Register action handlers
        actions.forEach { actionName ->
            native.registerAction(actionName)
        }
    }

    override fun onAction(actionName: String, handler: EngineActionCallback) {
        actionHandlers[actionName] = handler
        native.registerAction(actionName)
    }

    override fun updateState(
        scope: String,
        paths: List<String>,
        values: Map<String, Any?>
    ) {
        // Forward sparse paths + values directly to the engine. The engine
        // applies each dotted path individually and uses the same paths to
        // invalidate the dependency graph — no host-side flat→nested
        // conversion needed.
        val pathsJson = JsonArray(paths.map { JsonPrimitive(it) }).toString()
        val valuesJson = values.toJsonElement().toString()
        try {
            val patches = native
                .updateStateSparse(scope, pathsJson, valuesJson)
                .map { it.toPatch() }
            if (patches.isNotEmpty()) {
                renderCallback?.invoke(patches)
            }
        } catch (e: HypenException.StateException) {
            throw EngineError.State(e.v1, e)
        }
    }

    override fun dispatchAction(name: String, payload: Any?) {
        val payloadJson = payload?.let {
            when (it) {
                is JsonElement -> it.toString()
                else -> it.toJsonElement().toString()
            }
        }
        native.dispatchAction(name, payloadJson)
        processPendingActions()
    }

    override fun setRenderCallback(callback: RenderCallback) {
        renderCallback = callback
    }

    override fun triggerAction(name: String, payload: Any?) {
        val action = Action(name, payload?.toJsonElement())
        actionHandlers[name]?.invoke(action)
    }

    /**
     * Process pending actions from the native engine.
     * Invokes registered Kotlin-side action handlers for any queued actions.
     */
    fun processPendingActions() {
        val pending = native.getPendingActions()
        for (action in pending) {
            val handler = actionHandlers[action.name]
            if (handler != null) {
                val payloadElement = action.payloadJson?.let {
                    try {
                        Json.decodeFromString<JsonElement>(it)
                    } catch (e: Exception) {
                        JsonPrimitive(it)
                    }
                }
                handler(Action(action.name, payloadElement))
            }
        }
    }

    override fun close() {
        native.destroy()
    }

    companion object {
        /**
         * Check if the native library is available.
         */
        fun isAvailable(): Boolean {
            return try {
                NativeHypenEngine().also { it.destroy() }
                true
            } catch (e: UnsatisfiedLinkError) {
                false
            } catch (e: Exception) {
                false
            }
        }

        /**
         * Convert flat dotted-path keys to a nested map structure.
         * e.g., {"counter.count": 1} → {"counter": {"count": 1}}
         */
        @Suppress("UNCHECKED_CAST")
        internal fun flatToNested(flat: Map<String, Any?>): Map<String, Any?> {
            val result = mutableMapOf<String, Any?>()
            for ((path, value) in flat) {
                val parts = path.split(".")
                if (parts.size == 1) {
                    result[path] = value
                    continue
                }
                var current = result
                for (i in 0 until parts.size - 1) {
                    current = current.getOrPut(parts[i]) {
                        mutableMapOf<String, Any?>()
                    } as MutableMap<String, Any?>
                }
                current[parts.last()] = value
            }
            return result
        }
    }
}

/**
 * Result of renderDocumentWithModules.
 */
data class RenderDocumentResult(
    /** Patches from the final render */
    val patches: List<Patch>,
    /** Nested modules that were auto-instantiated (name → instance) */
    val nestedModules: Map<String, NestedModuleInstance<*>>
)

// Extension to convert native ImportInfo to SDK ImportStatement
private fun NativeImportInfo.toImportStatement(): ImportStatement {
    return ImportStatement(
        names = names,
        sourcePath = sourcePath,
        sourceType = sourceType
    )
}

// Extension to convert native Patch to SDK Patch
private fun NativePatch.toPatch(): Patch {
    return Patch(
        type = when (patchType) {
            NativePatchType.CREATE -> PatchType.CREATE
            NativePatchType.SET_PROP -> PatchType.SET_PROP
            NativePatchType.REMOVE_PROP -> PatchType.REMOVE_PROP
            NativePatchType.SET_TEXT -> PatchType.SET_TEXT
            NativePatchType.INSERT -> PatchType.INSERT
            NativePatchType.MOVE -> PatchType.MOVE
            NativePatchType.REMOVE -> PatchType.REMOVE
            // Router subtree cache — see the Rust engine's
            // `Patch::Detach` / `Patch::Attach` (`reconcile/diff.rs`) and
            // the matching handlers in the Android renderer
            // (`ComposeRenderer.onDetach` / `onAttach`).
            NativePatchType.DETACH -> PatchType.DETACH
            NativePatchType.ATTACH -> PatchType.ATTACH
            // Reactive accessibility re-emit — see the Rust engine's
            // `Patch::SetSemantics` (`reconcile/patch.rs`). The updated
            // block rides `semanticsJson` → `Patch.semantics`.
            NativePatchType.SET_SEMANTICS -> PatchType.SET_SEMANTICS
        },
        id = id,
        elementType = elementType,
        props = propsJson?.let {
            try {
                Json.decodeFromString<JsonObject>(it).mapValues { (_, v) -> v }
            } catch (e: Exception) {
                null
            }
        },
        name = name,
        value = valueJson?.let {
            try {
                Json.decodeFromString<JsonElement>(it)
            } catch (e: Exception) {
                JsonPrimitive(it)
            }
        },
        text = text,
        parentId = parentId,
        beforeId = beforeId,
        semantics = semanticsJson?.let {
            try {
                Json.decodeFromString<JsonElement>(it)
            } catch (e: Exception) {
                null
            }
        }
    )
}
