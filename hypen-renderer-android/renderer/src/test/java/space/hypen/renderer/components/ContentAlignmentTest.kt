package space.hypen.renderer.components

import androidx.compose.ui.Alignment
import org.junit.Assert.assertEquals
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * Content alignment on the Box-shaped containers.
 *
 * Container/Box hard-coded `Alignment.TopStart` and Center hard-coded
 * `Alignment.Center`, so every alignment prop was silently dropped on them.
 * They resolve here instead of through the applicators because HypenApp
 * appends its `fillMaxWidth` policy modifier after the applicator chain,
 * which would fill straight through an outer `wrapContentWidth`.
 */
class ContentAlignmentTest {
    private fun element(props: Map<String, Any?>): HypenElement =
        HypenElement(id = "1", elementType = "Box", props = props)

    @Test
    fun `containers still default to top-start`() {
        assertEquals(Alignment.TopStart, hypenContentAlignment(element(emptyMap())))
    }

    @Test
    fun `the CSS pair a tw class expands to centres both axes`() {
        assertEquals(
            Alignment.Center,
            hypenContentAlignment(element(mapOf("justifyContent.0" to "center", "alignItems.0" to "center"))),
        )
    }

    @Test
    fun `justifyContent drives the horizontal axis and alignItems the vertical`() {
        // Flex's main axis in the default row direction is horizontal - the
        // same reading the Swift renderer uses for these props.
        assertEquals(
            Alignment.TopEnd,
            hypenContentAlignment(element(mapOf("justifyContent.0" to "flex-end"))),
        )
        assertEquals(
            Alignment.BottomStart,
            hypenContentAlignment(element(mapOf("alignItems.0" to "flex-end"))),
        )
    }

    @Test
    fun `the native applicators win over the CSS aliases`() {
        assertEquals(
            Alignment.TopStart,
            hypenContentAlignment(
                element(mapOf("horizontalAlignment.0" to "start", "justifyContent.0" to "center")),
            ),
        )
    }

    @Test
    fun `a two-axis alignment prop is taken whole`() {
        assertEquals(
            Alignment.BottomEnd,
            hypenContentAlignment(element(mapOf("alignment.0" to "bottomEnd"))),
        )
    }

    @Test
    fun `Center keeps centring unless an axis is aligned explicitly`() {
        val centered = { props: Map<String, Any?> ->
            hypenContentAlignment(
                element(props),
                defaultHorizontal = Alignment.CenterHorizontally,
                defaultVertical = Alignment.CenterVertically,
            )
        }
        assertEquals(Alignment.Center, centered(emptyMap()))
        assertEquals(Alignment.CenterStart, centered(mapOf("horizontalAlignment.0" to "start")))
    }
}
