package space.hypen.renderer.routing

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Simple client-side router controller for managing navigation state.
 */
data class RouterState(
    val currentPath: String,
    val params: Map<String, String> = emptyMap(),
    val query: Map<String, String> = emptyMap(),
    val previousPath: String? = null,
)

data class RouteMatch(
    val path: String,
    val params: Map<String, String> = emptyMap(),
    val query: Map<String, String> = emptyMap(),
)

class RouterController(
    initialPath: String = "/",
) {
    private val history = mutableListOf<String>()
    private var historyIndex = 0

    private val _state: MutableStateFlow<RouterState>
    val state: StateFlow<RouterState>
        get() = _state.asStateFlow()

    init {
        val (path, query) = normalizePath(initialPath)
        history.add(path)
        _state =
            MutableStateFlow(
                RouterState(
                    currentPath = path,
                    query = query,
                    previousPath = null,
                ),
            )
    }

    fun push(rawPath: String) {
        val (path, query) = normalizePath(rawPath)
        if (path == _state.value.currentPath && query == _state.value.query) return

        if (historyIndex < history.lastIndex) {
            history.subList(historyIndex + 1, history.size).clear()
        }
        history.add(path)
        historyIndex = history.lastIndex

        _state.value =
            RouterState(
                currentPath = path,
                query = query,
                previousPath = _state.value.currentPath,
            )
    }

    fun replace(rawPath: String) {
        val (path, query) = normalizePath(rawPath)
        if (history.isEmpty()) {
            history.add(path)
            historyIndex = 0
        } else {
            history[historyIndex] = path
        }

        _state.value =
            RouterState(
                currentPath = path,
                query = query,
                previousPath = _state.value.currentPath,
            )
    }

    fun back() {
        if (historyIndex == 0) return
        historyIndex -= 1
        val (path, query) = normalizePath(history[historyIndex])
        _state.value =
            RouterState(
                currentPath = path,
                query = query,
                previousPath = _state.value.currentPath,
            )
    }

    fun forward() {
        if (historyIndex >= history.lastIndex) return
        historyIndex += 1
        val (path, query) = normalizePath(history[historyIndex])
        _state.value =
            RouterState(
                currentPath = path,
                query = query,
                previousPath = _state.value.currentPath,
            )
    }

    /**
     * Sync the router to an externally provided path (e.g., from props/state).
     */
    fun sync(rawPath: String?) {
        if (rawPath == null) return
        val (path, query) = normalizePath(rawPath)
        if (path == _state.value.currentPath && query == _state.value.query) return

        history.clear()
        history.add(path)
        historyIndex = 0

        _state.value =
            RouterState(
                currentPath = path,
                query = query,
                previousPath = _state.value.currentPath,
            )
    }

    fun setMatch(match: RouteMatch) {
        _state.value =
            _state.value.copy(
                params = match.params,
                query = match.query,
            )
    }

    fun isActive(pattern: String): Boolean = matchPath(pattern) != null

    fun matchPath(
        pattern: String,
        rawPath: String = _state.value.currentPath,
    ): RouteMatch? {
        val targetPath = normalizeRoute(pattern)
        val (path, query) = normalizePath(rawPath)

        if (targetPath == path) {
            return RouteMatch(path = path, query = query)
        }

        if (targetPath.endsWith("/*")) {
            val prefix = targetPath.removeSuffix("/*")
            if (path == prefix || path.startsWith("$prefix/")) {
                return RouteMatch(path = path, query = query)
            }
        }

        val paramNames = mutableListOf<String>()
        val regexPattern =
            targetPath
                .replace(Regex(":([a-zA-Z_][a-zA-Z0-9_]*)")) { matchResult ->
                    paramNames.add(matchResult.groupValues[1])
                    "([^/]+)"
                }.replace("*", ".*")
        val regex = Regex("^$regexPattern$")
        val match = regex.matchEntire(path) ?: return null

        val params =
            paramNames
                .mapIndexed { index, name ->
                    name to decodeSegment(match.groupValues[index + 1])
                }.toMap()

        return RouteMatch(
            path = path,
            params = params,
            query = query,
        )
    }

    private fun normalizePath(rawPath: String): Pair<String, Map<String, String>> {
        if (rawPath.isBlank()) return "/" to emptyMap()

        val parts = rawPath.split("?", limit = 2)
        val path = parts.first().let { if (it.startsWith("/")) it else "/$it" }
        val query = if (parts.size > 1) parseQuery(parts[1]) else emptyMap()
        return path to query
    }

    private fun normalizeRoute(pattern: String): String {
        if (pattern.isBlank()) return "/"
        return if (pattern.startsWith("/")) pattern else "/$pattern"
    }

    private fun parseQuery(queryString: String): Map<String, String> {
        if (queryString.isBlank()) return emptyMap()
        return queryString
            .split("&")
            .mapNotNull { part ->
                val pieces = part.split("=", limit = 2)
                if (pieces.isEmpty() || pieces[0].isBlank()) return@mapNotNull null
                val key = decodeSegment(pieces[0])
                val value = decodeSegment(pieces.getOrNull(1) ?: "")
                key to value
            }.toMap()
    }

    private fun decodeSegment(value: String): String = URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}
