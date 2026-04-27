package space.hypen.renderer.render

import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.model.Patch

/**
 * Interface for rendering Hypen UI patches.
 * Implementations handle the actual rendering to a specific target (Compose, View, etc.).
 */
interface Renderer {
    /**
     * Apply a batch of patches to the render tree.
     */
    fun applyPatches(patches: List<Patch>)

    /**
     * Get an element by its ID.
     */
    fun getElement(id: String): HypenElement?

    /**
     * Clear the entire render tree.
     */
    fun clear()

    /**
     * Dispatch an action to be sent to the server.
     */
    fun dispatchAction(
        action: String,
        payload: Map<String, Any?>? = null,
    )
}

/**
 * Listener for action dispatches from the renderer.
 */
fun interface ActionDispatcher {
    fun dispatch(
        action: String,
        payload: Map<String, Any?>?,
    )
}

/**
 * Listener for renderer state changes.
 */
interface RendererStateListener {
    /**
     * Called when an element is created.
     */
    fun onElementCreated(element: HypenElement) {}

    /**
     * Called when an element is removed.
     */
    fun onElementRemoved(id: String) {}

    /**
     * Called when the tree structure changes.
     */
    fun onTreeChanged() {}
}
