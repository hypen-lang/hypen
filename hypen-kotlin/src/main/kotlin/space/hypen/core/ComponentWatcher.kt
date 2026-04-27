package space.hypen.core

import java.io.File
import java.nio.file.*
import java.nio.file.attribute.BasicFileAttributes
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.ConcurrentHashMap

/**
 * Configuration for component watching.
 */
class ComponentWatchConfig {
    /** Discovery patterns to use when scanning. */
    var patterns: List<DiscoveryPattern> = DiscoveryPattern.DEFAULT
    /** Debounce interval in milliseconds. File changes within this window are batched. */
    var debounceMs: Long = 100
    /** Whether to scan subdirectories recursively. */
    var recursive: Boolean = true
}

/**
 * Diff result from component re-discovery.
 */
data class ComponentChanges(
    val added: List<DiscoveredComponent>,
    val updated: List<DiscoveredComponent>,
    val removed: List<String>
) {
    fun isEmpty(): Boolean = added.isEmpty() && updated.isEmpty() && removed.isEmpty()
}

/**
 * Watches a directory for `.hypen` file changes and triggers re-discovery.
 *
 * Uses `java.nio.file.WatchService` (inotify on Linux, kqueue on macOS via polling).
 * Changes are debounced — rapid saves within [debounceMs] are batched into one callback.
 *
 * ```kotlin
 * val watcher = ComponentWatcher(
 *     baseDir = Path.of("./components"),
 *     onChange = { changes ->
 *         println("+${changes.added.size} ~${changes.updated.size} -${changes.removed.size}")
 *     }
 * )
 * watcher.start()
 * // ... later
 * watcher.stop()
 * ```
 *
 * **macOS note**: The JVM `WatchService` implementation on macOS uses polling (~2s latency).
 * For production dev servers, consider using a native library like
 * [directory-watcher](https://github.com/gmethvin/directory-watcher) for FSEvents support.
 */
class ComponentWatcher(
    private val baseDir: Path,
    private val patterns: List<DiscoveryPattern> = DiscoveryPattern.DEFAULT,
    private val debounceMs: Long = 100,
    private val recursive: Boolean = true,
    private val onChange: (ComponentChanges) -> Unit
) {
    private var watchService: WatchService? = null
    private var watchThread: Thread? = null
    private var debounceTimer: Timer? = null
    private var pendingTask: TimerTask? = null
    private val watchKeys = ConcurrentHashMap<WatchKey, Path>()
    private var previousComponents = mapOf<String, DiscoveredComponent>()
    private val log = HypenLoggers.loader

    @Volatile
    private var running = false

    /**
     * Start watching for file changes. Performs initial discovery immediately.
     */
    fun start(): ComponentWatcher {
        if (running) return this

        val dir = baseDir.toFile().canonicalFile
        if (!dir.exists() || !dir.isDirectory) {
            log.warn("Watch directory does not exist: $baseDir")
            return this
        }

        // Initial discovery
        previousComponents = discover().associateBy { it.name }
        log.info("Discovered ${previousComponents.size} components in $baseDir")

        // Set up WatchService
        watchService = FileSystems.getDefault().newWatchService()
        debounceTimer = Timer("hypen-watcher-debounce", true)
        running = true

        // Register directories
        registerDirectory(baseDir)

        // Start watch thread
        watchThread = Thread({
            watchLoop()
        }, "hypen-component-watcher").apply {
            isDaemon = true
            start()
        }

        log.info("Component watcher started on $baseDir")
        return this
    }

    /**
     * Stop watching and clean up resources.
     */
    fun stop() {
        running = false
        pendingTask?.cancel()
        debounceTimer?.cancel()
        watchService?.close()
        watchThread?.interrupt()
        watchKeys.clear()
        log.info("Component watcher stopped")
    }

    /**
     * Force a re-discovery and emit changes. Useful for manual refresh.
     */
    fun refresh() {
        processChanges()
    }

    /**
     * Get the currently known components.
     */
    fun getComponents(): Map<String, DiscoveredComponent> = previousComponents

    // ---- Internal ----

    private fun registerDirectory(dir: Path) {
        val ws = watchService ?: return

        if (recursive) {
            // Walk tree and register all directories
            Files.walkFileTree(dir, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(d: Path, attrs: BasicFileAttributes): FileVisitResult {
                    val key = d.register(
                        ws,
                        StandardWatchEventKinds.ENTRY_CREATE,
                        StandardWatchEventKinds.ENTRY_MODIFY,
                        StandardWatchEventKinds.ENTRY_DELETE
                    )
                    watchKeys[key] = d
                    return FileVisitResult.CONTINUE
                }
            })
        } else {
            val key = dir.register(
                ws,
                StandardWatchEventKinds.ENTRY_CREATE,
                StandardWatchEventKinds.ENTRY_MODIFY,
                StandardWatchEventKinds.ENTRY_DELETE
            )
            watchKeys[key] = dir
        }
    }

    private fun watchLoop() {
        while (running) {
            val key = try {
                watchService?.take() ?: break
            } catch (_: ClosedWatchServiceException) {
                break
            } catch (_: InterruptedException) {
                break
            }

            val dir = watchKeys[key] ?: continue
            var relevant = false

            for (event in key.pollEvents()) {
                val kind = event.kind()
                if (kind == StandardWatchEventKinds.OVERFLOW) continue

                @Suppress("UNCHECKED_CAST")
                val filename = (event as WatchEvent<Path>).context()
                val child = dir.resolve(filename)

                // Register newly created directories (for recursive watching)
                if (kind == StandardWatchEventKinds.ENTRY_CREATE && Files.isDirectory(child)) {
                    registerDirectory(child)
                    relevant = true
                    continue
                }

                // Only care about .hypen files
                if (filename.toString().endsWith(".hypen")) {
                    relevant = true
                }
            }

            // Reset key — if directory was deleted, key becomes invalid
            if (!key.reset()) {
                watchKeys.remove(key)
                if (watchKeys.isEmpty()) break
            }

            if (relevant) {
                scheduleDebouncedRefresh()
            }
        }
    }

    private fun scheduleDebouncedRefresh() {
        pendingTask?.cancel()
        val task = object : TimerTask() {
            override fun run() {
                if (running) {
                    processChanges()
                }
            }
        }
        pendingTask = task
        try {
            debounceTimer?.schedule(task, debounceMs)
        } catch (_: IllegalStateException) {
            // Timer was cancelled
        }
    }

    private fun processChanges() {
        val newComponents = discover().associateBy { it.name }

        val added = mutableListOf<DiscoveredComponent>()
        val updated = mutableListOf<DiscoveredComponent>()
        val removed = mutableListOf<String>()

        // Detect added and updated
        for ((name, component) in newComponents) {
            val previous = previousComponents[name]
            if (previous == null) {
                added.add(component)
                log.debug("Component added: $name")
            } else if (previous.template != component.template || previous.hypenPath != component.hypenPath) {
                updated.add(component)
                log.debug("Component updated: $name")
            }
        }

        // Detect removed
        for (name in previousComponents.keys) {
            if (name !in newComponents) {
                removed.add(name)
                log.debug("Component removed: $name")
            }
        }

        previousComponents = newComponents

        val changes = ComponentChanges(added, updated, removed)
        if (!changes.isEmpty()) {
            try {
                onChange(changes)
            } catch (e: Exception) {
                log.error("Error in component change handler", e.message ?: "")
            }
        }
    }

    private fun discover(): List<DiscoveredComponent> {
        val dir = baseDir.toFile().canonicalFile
        if (!dir.exists() || !dir.isDirectory) return emptyList()

        val components = mutableListOf<DiscoveredComponent>()
        val seen = mutableSetOf<String>()

        if (patterns.contains(DiscoveryPattern.FOLDER) || patterns.contains(DiscoveryPattern.INDEX)) {
            scanFolders(dir, components, seen)
        }
        if (patterns.contains(DiscoveryPattern.SIBLING)) {
            scanSiblings(dir, components, seen)
        }

        return components
    }

    private fun scanFolders(dir: File, components: MutableList<DiscoveredComponent>, seen: MutableSet<String>) {
        val entries = dir.listFiles() ?: return
        for (entry in entries) {
            if (!entry.isDirectory) continue
            val name = entry.name

            if (patterns.contains(DiscoveryPattern.FOLDER)) {
                val f = File(entry, "component.hypen")
                if (f.exists() && seen.add(name)) {
                    components.add(DiscoveredComponent(name, f.path, f.readText().trim()))
                    continue
                }
            }
            if (patterns.contains(DiscoveryPattern.INDEX)) {
                val f = File(entry, "index.hypen")
                if (f.exists() && seen.add(name)) {
                    components.add(DiscoveredComponent(name, f.path, f.readText().trim()))
                    continue
                }
            }
            if (recursive) scanFolders(entry, components, seen)
        }
    }

    private fun scanSiblings(dir: File, components: MutableList<DiscoveredComponent>, seen: MutableSet<String>) {
        val entries = dir.listFiles() ?: return
        for (entry in entries) {
            if (entry.isDirectory) {
                if (recursive) scanSiblings(entry, components, seen)
                continue
            }
            if (!entry.name.endsWith(".hypen")) continue
            val name = entry.nameWithoutExtension
            if (name == "component" || name == "index") continue
            if (seen.add(name)) {
                components.add(DiscoveredComponent(name, entry.path, entry.readText().trim()))
            }
        }
    }
}
