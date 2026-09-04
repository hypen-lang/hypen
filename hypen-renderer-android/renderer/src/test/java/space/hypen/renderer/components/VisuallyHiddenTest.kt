package space.hypen.renderer.components

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `VisuallyHidden` must resolve from the registry.
 *
 * Registration is the whole bug: an unregistered type falls through to
 * HypenApp's unknown-type `Box { children }`, which paints screen-reader-only
 * content on screen — the inverse of the component's contract. The layout and
 * draw behaviour itself needs a device, so what's pinned here is that the
 * fallback path is no longer reachable for this type.
 */
class VisuallyHiddenTest {

    @Test
    fun `VisuallyHidden resolves from the registry, whatever the wire casing`() {
        val registry = createDefaultComponentRegistry()
        // The engine emits the primitive as `VisuallyHidden`; the registry
        // lowercases on both sides.
        assertTrue(registry.getHandler("VisuallyHidden") is VisuallyHiddenComponent)
        assertTrue(registry.getHandler("visuallyhidden") is VisuallyHiddenComponent)
    }
}
