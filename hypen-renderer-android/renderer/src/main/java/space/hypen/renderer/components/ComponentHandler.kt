package space.hypen.renderer.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Interface for handling the rendering of a specific Hypen component type.
 * Each component type (Text, Column, Row, Button, etc.) has its own handler.
 */
interface ComponentHandler {
    /**
     * The component type name (e.g., "text", "column", "row").
     * Should be lowercase for matching.
     */
    val typeName: String

    /**
     * Render this component.
     *
     * @param element The element to render
     * @param modifier The Compose modifier to apply
     * @param renderChildren A composable function to render child elements
     */
    @Composable
    fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    )
}

/**
 * Registry for component handlers.
 * Maps component type names to their handlers.
 */
interface ComponentRegistry {
    /**
     * Register a component handler.
     */
    fun register(handler: ComponentHandler)

    /**
     * Get a handler for a component type.
     */
    fun getHandler(typeName: String): ComponentHandler?

    /**
     * Check if a handler exists for a component type.
     */
    fun hasHandler(typeName: String): Boolean

    /**
     * Get all registered type names.
     */
    fun getRegisteredTypes(): Set<String>
}

/**
 * Default implementation of ComponentRegistry.
 */
class DefaultComponentRegistry : ComponentRegistry {
    private val handlers = mutableMapOf<String, ComponentHandler>()

    override fun register(handler: ComponentHandler) {
        handlers[handler.typeName.lowercase()] = handler
    }

    override fun getHandler(typeName: String): ComponentHandler? = handlers[typeName.lowercase()]

    override fun hasHandler(typeName: String): Boolean = handlers.containsKey(typeName.lowercase())

    override fun getRegisteredTypes(): Set<String> = handlers.keys.toSet()
}
