package space.hypen.renderer.components

import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * `SafeArea` edge selection and the embedder inset override.
 *
 * The Compose half (the actual `windowInsetsPadding` chain) needs a device,
 * so what's pinned here is the logic the component was factored around: which
 * edges the wire prop selects, and how a partial [HypenSafeAreaInsets]
 * override merges over the `safeDrawing` default per edge.
 */
class SafeAreaTest {

    private fun element(props: Map<String, Any?> = emptyMap()) = HypenElement(
        id = "1",
        elementType = "SafeArea",
        props = props,
    )

    @Test
    fun `SafeArea resolves from the registry, whatever the wire casing`() {
        val registry = createDefaultComponentRegistry()
        // The engine emits the primitive as `SafeArea`; the registry lowercases
        // on both sides, the same way `ProgressBar` -> "progressbar" resolves.
        assertTrue(registry.getHandler("SafeArea") is SafeAreaComponent)
        assertTrue(registry.getHandler("safearea") is SafeAreaComponent)
    }

    @Test
    fun `no edges prop insets all four edges`() {
        assertEquals(ALL_SAFE_AREA_EDGES, parseSafeAreaEdges(element()))
    }

    @Test
    fun `an empty edges list insets all four edges`() {
        assertEquals(ALL_SAFE_AREA_EDGES, parseSafeAreaEdges(element(mapOf("edges" to emptyList<String>()))))
    }

    @Test
    fun `a non-list edges prop degrades to all four edges`() {
        assertEquals(ALL_SAFE_AREA_EDGES, parseSafeAreaEdges(element(mapOf("edges" to "top"))))
    }

    @Test
    fun `edges filters to the named edges`() {
        assertEquals(
            setOf(SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM),
            parseSafeAreaEdges(element(mapOf("edges" to listOf("top", "bottom")))),
        )
    }

    @Test
    fun `edges arrives through the applicator wire suffix too`() {
        assertEquals(
            setOf(SafeAreaEdge.LEFT),
            parseSafeAreaEdges(element(mapOf("edges.0" to listOf("left")))),
        )
    }

    @Test
    fun `edge names are case and whitespace tolerant, unknown names are ignored`() {
        assertEquals(
            setOf(SafeAreaEdge.TOP, SafeAreaEdge.RIGHT),
            parseSafeAreaEdges(element(mapOf("edges" to listOf(" Top ", "banana", "RIGHT")))),
        )
    }

    @Test
    fun `a list of only unknown names insets nothing`() {
        // Only an absent or empty prop means "all four" — an author who asked
        // for specific edges gets exactly those, even if none are recognised.
        assertTrue(parseSafeAreaEdges(element(mapOf("edges" to listOf("banana")))).isEmpty())
    }

    @Test
    fun `without an override every selected edge uses the platform insets`() {
        val resolved = resolveSafeArea(ALL_SAFE_AREA_EDGES, null)
        assertEquals(ALL_SAFE_AREA_EDGES, resolved.platformEdges)
        assertTrue(resolved.fixed.isEmpty())
    }

    @Test
    fun `a custom inset wins on its edge and the rest still come from the platform`() {
        val resolved = resolveSafeArea(ALL_SAFE_AREA_EDGES, HypenSafeAreaInsets(bottom = 0.dp))
        assertEquals(
            setOf(SafeAreaEdge.TOP, SafeAreaEdge.RIGHT, SafeAreaEdge.LEFT),
            resolved.platformEdges,
        )
        assertEquals(mapOf(SafeAreaEdge.BOTTOM to 0.dp), resolved.fixed)
    }

    @Test
    fun `a full override replaces the platform insets entirely`() {
        val resolved = resolveSafeArea(
            ALL_SAFE_AREA_EDGES,
            HypenSafeAreaInsets(top = 24.dp, right = 8.dp, bottom = 16.dp, left = 8.dp),
        )
        assertTrue(resolved.platformEdges.isEmpty())
        assertEquals(24.dp, resolved.fixed[SafeAreaEdge.TOP])
        assertEquals(16.dp, resolved.fixed[SafeAreaEdge.BOTTOM])
        assertEquals(8.dp, resolved.fixed[SafeAreaEdge.LEFT])
        assertEquals(8.dp, resolved.fixed[SafeAreaEdge.RIGHT])
    }

    @Test
    fun `an override on an unselected edge is ignored`() {
        val resolved = resolveSafeArea(setOf(SafeAreaEdge.TOP), HypenSafeAreaInsets(bottom = 40.dp))
        assertEquals(setOf(SafeAreaEdge.TOP), resolved.platformEdges)
        assertTrue(resolved.fixed.isEmpty())
    }

    @Test
    fun `a negative override is clamped, since Modifier padding rejects it`() {
        val resolved = resolveSafeArea(ALL_SAFE_AREA_EDGES, HypenSafeAreaInsets(top = (-12).dp))
        assertEquals(0.dp, resolved.fixed[SafeAreaEdge.TOP])
    }

    @Test
    fun `fixed padding only covers the overridden edges`() {
        val padding = resolveSafeArea(ALL_SAFE_AREA_EDGES, HypenSafeAreaInsets(top = 24.dp)).fixedPadding()
        assertEquals(24.dp, padding.calculateTopPadding())
        assertEquals(0.dp, padding.calculateBottomPadding())
    }

    @Test
    fun `the sides mask mirrors the selected edges`() {
        assertNull(safeAreaSides(emptySet()))
        assertEquals(WindowInsetsSides.Top, safeAreaSides(setOf(SafeAreaEdge.TOP)))
        assertEquals(
            WindowInsetsSides.Top + WindowInsetsSides.Bottom,
            safeAreaSides(setOf(SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM)),
        )
        assertEquals(
            WindowInsetsSides.Top + WindowInsetsSides.Right + WindowInsetsSides.Bottom + WindowInsetsSides.Left,
            safeAreaSides(ALL_SAFE_AREA_EDGES),
        )
    }
}
