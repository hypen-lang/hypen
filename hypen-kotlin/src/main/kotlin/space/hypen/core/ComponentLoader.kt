package space.hypen.core

import java.io.File

/**
 * Discovers and loads Hypen components from the filesystem.
 *
 * Supports multiple conventions:
 * - Folder-based: ComponentName/component.hypen
 * - Sibling files: ComponentName.hypen (+ optional ComponentName.kt)
 * - Index-based: ComponentName/index.hypen
 *
 * Usage:
 * ```kotlin
 * val loader = ComponentLoader(engine)
 * val components = loader.discoverComponents("./components")
 * // Components are automatically registered with the engine
 * ```
 */
class ComponentLoader(private val engine: NativeEngine) {

    /**
     * Register a component with the engine.
     */
    fun register(name: String, template: String, path: String = "") {
        engine.registerComponent(name, template, path)
    }

    /**
     * Discover and register all components in a directory.
     */
    fun discoverComponents(
        baseDir: String,
        patterns: List<DiscoveryPattern> = DiscoveryPattern.DEFAULT,
        recursive: Boolean = false
    ): List<DiscoveredComponent> {
        val dir = File(baseDir).canonicalFile
        if (!dir.exists() || !dir.isDirectory) {
            return emptyList()
        }

        val components = mutableListOf<DiscoveredComponent>()
        val seen = mutableSetOf<String>()

        if (patterns.contains(DiscoveryPattern.FOLDER) || patterns.contains(DiscoveryPattern.INDEX)) {
            scanForFolderComponents(dir, patterns, recursive, components, seen)
        }

        if (patterns.contains(DiscoveryPattern.SIBLING)) {
            scanForSiblingComponents(dir, recursive, components, seen)
        }

        // Auto-register discovered components with the engine
        for (comp in components) {
            register(comp.name, comp.template, comp.hypenPath)
        }

        return components
    }

    private fun scanForFolderComponents(
        dir: File,
        patterns: List<DiscoveryPattern>,
        recursive: Boolean,
        components: MutableList<DiscoveredComponent>,
        seen: MutableSet<String>
    ) {
        val entries = dir.listFiles() ?: return

        for (entry in entries) {
            if (!entry.isDirectory) continue

            val componentName = entry.name

            // Folder-based: Name/component.hypen
            if (patterns.contains(DiscoveryPattern.FOLDER)) {
                val hypenFile = File(entry, "component.hypen")
                if (hypenFile.exists() && seen.add(componentName)) {
                    val template = hypenFile.readText().trim()
                    components.add(DiscoveredComponent(
                        name = componentName,
                        hypenPath = hypenFile.path,
                        template = template
                    ))
                    continue
                }
            }

            // Index-based: Name/index.hypen
            if (patterns.contains(DiscoveryPattern.INDEX)) {
                val hypenFile = File(entry, "index.hypen")
                if (hypenFile.exists() && seen.add(componentName)) {
                    val template = hypenFile.readText().trim()
                    components.add(DiscoveredComponent(
                        name = componentName,
                        hypenPath = hypenFile.path,
                        template = template
                    ))
                    continue
                }
            }

            if (recursive) {
                scanForFolderComponents(entry, patterns, true, components, seen)
            }
        }
    }

    private fun scanForSiblingComponents(
        dir: File,
        recursive: Boolean,
        components: MutableList<DiscoveredComponent>,
        seen: MutableSet<String>
    ) {
        val entries = dir.listFiles() ?: return

        for (entry in entries) {
            if (entry.isDirectory) {
                if (recursive) {
                    scanForSiblingComponents(entry, true, components, seen)
                }
                continue
            }

            if (!entry.name.endsWith(".hypen")) continue

            val baseName = entry.nameWithoutExtension

            // Skip component.hypen and index.hypen (handled by folder patterns)
            if (baseName == "component" || baseName == "index") continue

            if (seen.add(baseName)) {
                val template = entry.readText().trim()
                components.add(DiscoveredComponent(
                    name = baseName,
                    hypenPath = entry.path,
                    template = template
                ))
            }
        }
    }
}

/** Discovery pattern for component scanning */
enum class DiscoveryPattern {
    FOLDER,
    SIBLING,
    INDEX;

    companion object {
        val DEFAULT = listOf(FOLDER, SIBLING, INDEX)
    }
}

/** A component discovered from the filesystem */
data class DiscoveredComponent(
    val name: String,
    val hypenPath: String,
    val template: String
)
