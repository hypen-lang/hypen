package space.hypen.core

import kotlinx.coroutines.runBlocking
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Resolves and loads components from local files or remote URLs.
 *
 * Usage:
 * ```kotlin
 * val resolver = ComponentResolver(baseDir = "./components")
 * val engine = NativeEngine()
 *
 * // Render source with imports
 * engine.renderSource(source)
 *
 * // Get pending imports and resolve them
 * val imports = engine.getPendingImports()
 * for (imp in imports) {
 *     val resolved = resolver.resolve(imp)
 *     for ((name, def) in resolved) {
 *         engine.registerComponent(name, def.template, def.path)
 *     }
 * }
 * ```
 */
class ComponentResolver(
    /** Base directory for resolving relative local paths */
    val baseDir: String = ".",
    /** Whether to cache resolved components */
    val cache: Boolean = true,
    /** Custom fetch function for URL imports */
    val customFetch: ((String) -> String)? = null,
    /** App instance for looking up pre-registered module definitions */
    val app: HypenApp? = null
) {
    private val componentCache = mutableMapOf<String, ComponentDefinition>()

    /**
     * Resolve a component from an import statement.
     * Checks the app registry first (if available), then falls back to file I/O.
     * Returns a map of component name -> definition.
     */
    fun resolve(importStmt: ImportStatement): Map<String, ComponentDefinition> {
        // Check app registry first — if a component is pre-registered,
        // use its template directly (it will be mounted as a full module)
        if (app != null) {
            val allFound = importStmt.names.all { app.has(it) }
            if (allFound) {
                return importStmt.names.associateWith { name ->
                    val def = app.get(name)
                    ComponentDefinition(
                        template = def?.ui ?: "",
                        path = ""
                    )
                }
            }
        }

        val sourcePath = importStmt.sourcePath

        // Check cache
        if (cache) {
            componentCache[sourcePath]?.let { cached ->
                return extractComponents(importStmt.names, cached)
            }
        }

        // Load the component
        val component = if (importStmt.isLocal) {
            resolveLocal(sourcePath)
        } else {
            resolveUrl(sourcePath)
        }

        // Cache it
        if (cache) {
            componentCache[sourcePath] = component
        }

        return extractComponents(importStmt.names, component)
    }

    /**
     * Resolve a component from a local file path.
     */
    private fun resolveLocal(path: String): ComponentDefinition {
        val basePath = File(baseDir, path).canonicalPath

        // Try .hypen extension
        val hypenFile = if (basePath.endsWith(".hypen")) {
            File(basePath)
        } else {
            File("$basePath.hypen")
        }

        val template = if (hypenFile.exists()) {
            hypenFile.readText()
        } else {
            // Try without extension (maybe it already has one or is a directory)
            val plainFile = File(basePath)
            if (plainFile.exists()) {
                plainFile.readText()
            } else {
                throw IllegalArgumentException("Component not found at ${hypenFile.path}")
            }
        }

        return ComponentDefinition(
            template = template.trim(),
            path = hypenFile.path
        )
    }

    /**
     * Resolve a component from a URL.
     */
    private fun resolveUrl(url: String): ComponentDefinition {
        val body = if (customFetch != null) {
            customFetch.invoke(url)
        } else {
            defaultFetch(url)
        }

        // For URL imports, the response is the template source directly
        return ComponentDefinition(
            template = body.trim(),
            path = url
        )
    }

    private fun defaultFetch(url: String): String = runBlocking {
        retry(RetryOptions(
            maxAttempts = 3,
            delayMs = 1000,
            backoff = BackoffStrategy.EXPONENTIAL,
            shouldRetry = RetryConditions.any(RetryConditions.networkErrors, RetryConditions.ioErrors)
        )) {
            val request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .build()
            val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() != 200) {
                throw RuntimeException("HTTP ${response.statusCode()} fetching $url")
            }
            response.body()
        }
    }

    private fun extractComponents(
        names: List<String>,
        component: ComponentDefinition
    ): Map<String, ComponentDefinition> {
        return names.associateWith { component }
    }

    /** Clear the component cache */
    fun clearCache() {
        componentCache.clear()
    }

    /** Get the number of cached components */
    val cacheSize: Int get() = componentCache.size

    companion object {
        /** Shared HTTP client with connection timeout */
        private val httpClient: HttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build()

        /**
         * Parse import statements from Hypen DSL text.
         * Returns a list of ImportStatement objects.
         */
        fun parseImports(text: String): List<ImportStatement> {
            val imports = mutableListOf<ImportStatement>()
            val regex = Regex("""import\s+(?:(\{[^}]*\})|(\w+))\s+from\s+["']([^"']+)["']""")

            for (match in regex.findAll(text)) {
                val namedImports = match.groupValues[1]
                val defaultImport = match.groupValues[2]
                val source = match.groupValues[3]

                if (source.isEmpty()) continue

                val names = if (namedImports.isNotEmpty()) {
                    namedImports
                        .removeSurrounding("{", "}")
                        .split(",")
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                } else if (defaultImport.isNotEmpty()) {
                    listOf(defaultImport)
                } else {
                    continue
                }

                val sourceType = if (source.startsWith("http://") || source.startsWith("https://")) {
                    "url"
                } else {
                    "local"
                }

                imports.add(ImportStatement(
                    names = names,
                    sourcePath = source,
                    sourceType = sourceType
                ))
            }

            return imports
        }
    }
}
