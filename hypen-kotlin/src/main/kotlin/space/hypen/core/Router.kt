package space.hypen.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Route state containing current path and parameters
 */
data class RouteState(
    val currentPath: String,
    val params: Map<String, String>,
    val query: Map<String, String>,
    val previousPath: String?
)

/**
 * Route match result
 */
data class RouteMatch(
    val params: Map<String, String>,
    val query: Map<String, String>,
    val path: String
)

/**
 * Callback for route changes
 */
typealias RouteChangeCallback = (from: String?, to: String) -> Unit

/**
 * Hash-based router for navigation.
 * Matches the TypeScript HypenRouter API.
 */
class HypenRouter {
    private var currentPath: String = "/"
    private var previousPath: String? = null
    private var params: Map<String, String> = emptyMap()
    private var query: Map<String, String> = emptyMap()
    private val listeners = mutableListOf<RouteChangeCallback>()

    /**
     * Navigate to a new path (pushes to history)
     */
    fun push(path: String) {
        navigate(path)
    }

    /**
     * Replace the current path (no history entry)
     */
    fun replace(path: String) {
        navigate(path, replace = true)
    }

    /**
     * Go back in history
     */
    fun back() {
        previousPath?.let { navigate(it, replace = true) }
    }

    /**
     * Go forward in history (not implemented in simple router)
     */
    fun forward() {
        // Simple router doesn't track forward history
    }

    /**
     * Get the current path
     */
    fun getCurrentPath(): String = currentPath

    /**
     * Get route parameters
     */
    fun getParams(): Map<String, String> = params

    /**
     * Get query parameters
     */
    fun getQuery(): Map<String, String> = query

    /**
     * Get the full route state
     */
    fun getState(): RouteState = RouteState(
        currentPath = currentPath,
        params = params,
        query = query,
        previousPath = previousPath
    )

    /**
     * Match a path pattern against a given path.
     *
     * Delegates to the engine's canonical `portable_match_path` via
     * UniFFI; the matcher lives at
     * `hypen-engine-rs/src/portable/route.rs`.
     */
    fun matchPath(pattern: String, path: String): RouteMatch? {
        val cleanPath = path.split("?")[0]
        val resultJson = uniffi.hypen_engine.portableMatchPath(pattern, cleanPath)
        val parsed = Json.parseToJsonElement(resultJson) as? JsonObject ?: return null
        val matched = (parsed["matched"] as? JsonPrimitive)?.booleanOrNull ?: false
        if (!matched) return null

        val params = mutableMapOf<String, String>()
        (parsed["params"] as? JsonObject)?.forEach { (name, value) ->
            (value as? JsonPrimitive)?.contentOrNull?.let { params[name] = it }
        }

        // Extract query from the original path via the engine's canonical
        // parser so router state stays in sync with matcher callsites.
        val queryPair = Json.parseToJsonElement(
            uniffi.hypen_engine.portableParseQuery(path)
        ).jsonObject
        val query = (queryPair["query"] as? JsonObject)
            ?.mapValues { (it.value as? JsonPrimitive)?.contentOrNull ?: "" }
            ?: emptyMap()

        return RouteMatch(
            params = params,
            query = query,
            path = cleanPath
        )
    }

    /**
     * Check if a pattern matches the current path
     */
    fun isActive(pattern: String): Boolean {
        return matchPath(pattern, currentPath) != null
    }

    /**
     * Build a URL from path and query params via the engine's canonical
     * `portable_build_url`.
     */
    fun buildUrl(path: String, queryParams: Map<String, String>? = null): String {
        val queryJson = (queryParams ?: emptyMap()).entries
            .joinToString(separator = ",", prefix = "{", postfix = "}") { (k, v) ->
                "\"${k.replace("\"", "\\\"")}\":\"${v.replace("\"", "\\\"")}\""
            }
        return uniffi.hypen_engine.portableBuildUrl(path, queryJson)
    }

    /**
     * Subscribe to route changes
     */
    fun onNavigate(callback: RouteChangeCallback): () -> Unit {
        listeners.add(callback)
        return { listeners.remove(callback) }
    }

    private fun navigate(path: String, replace: Boolean = false) {
        val oldPath = currentPath
        previousPath = if (replace) previousPath else oldPath

        // Split path and query via the engine's canonical parser.
        val parsed = Json.parseToJsonElement(
            uniffi.hypen_engine.portableParseQuery(path)
        ).jsonObject
        currentPath = (parsed["path"] as? JsonPrimitive)?.contentOrNull ?: path
        query = (parsed["query"] as? JsonObject)
            ?.mapValues { (it.value as? JsonPrimitive)?.contentOrNull ?: "" }
            ?: emptyMap()

        listeners.forEach { it(oldPath, currentPath) }
    }
}
