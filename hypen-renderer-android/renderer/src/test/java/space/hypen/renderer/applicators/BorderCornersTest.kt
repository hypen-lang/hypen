package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class BorderCornersTest {
    @Test
    fun `gallery R12 and R24 borders inherit their sibling radius`() {
        assertEquals(
            BorderCorners.uniform(12.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 2, "color" to "#22c55e"),
                props = mapOf("borderRadius.0" to 12),
            ),
        )
        assertEquals(
            BorderCorners.uniform(24.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 2, "color" to "#f59e0b"),
                props = mapOf("borderRadius.0" to 24),
            ),
        )
    }

    @Test
    fun `radius embedded in border overrides sibling radii`() {
        assertEquals(
            BorderCorners.uniform(7.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 2, "radius" to 7),
                props = mapOf(
                    "borderRadius.0" to 12,
                    "cornerRadius.0" to 24,
                ),
            ),
        )
        assertEquals(
            BorderCorners.uniform(7.dp),
            resolveClipBorderCorners(
                radiusValue = 12,
                props = mapOf(
                    "border.width" to 2,
                    "border.radius" to 7,
                    "borderRadius.0" to 12,
                ),
            ),
        )
    }

    @Test
    fun `flattened per-corner radius embedded in border keeps priority`() {
        assertEquals(
            BorderCorners(2.dp, 4.dp, 6.dp, 8.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf(
                    "width" to 2,
                    "radius.topStart" to 2,
                    "radius.topEnd" to 4,
                    "radius.bottomEnd" to 6,
                    "radius.bottomStart" to 8,
                ),
                props = mapOf("borderRadius.0" to 24),
            ),
        )
    }

    @Test
    fun `explicit zero radius remains square instead of falling through`() {
        assertEquals(
            BorderCorners.Square,
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("radius" to 0),
                props = mapOf("borderRadius.0" to 24),
            ),
        )
        assertEquals(
            BorderCorners.Square,
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 1),
                props = emptyMap(),
            ),
        )
    }

    @Test
    fun `canonical borderRadius wins over cornerRadius alias`() {
        assertEquals(
            BorderCorners.uniform(12.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 1),
                props = linkedMapOf(
                    "cornerRadius.0" to 24,
                    "borderRadius.0" to 12,
                ),
            ),
        )

        val base = Modifier
        val context = ApplicatorContext(
            element = HypenElement(
                id = "card",
                elementType = "stack",
                props = mapOf(
                    "cornerRadius.0" to 24,
                    "borderRadius.0" to 12,
                ),
            ),
            actionDispatcher = null,
        )
        assertSame(base, CornerRadiusApplicator().apply(base, 24, context))
    }

    @Test
    fun `cornerRadius alias is inherited when canonical radius is absent`() {
        assertEquals(
            BorderCorners.uniform(24.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 1),
                props = mapOf("cornerRadius.0" to "24px"),
            ),
        )
    }

    @Test
    fun `flattened per-corner borderRadius uses the same geometry as clipping`() {
        val props = mapOf(
            "borderRadius.topStart" to 4,
            "borderRadius.topEnd" to "8px",
            "borderRadius.bottomEnd" to 12,
            "borderRadius.bottomStart" to "16dp",
        )

        assertEquals(
            BorderCorners(4.dp, 8.dp, 12.dp, 16.dp),
            resolveCompoundBorderCorners(mapOf("width" to 2), props),
        )
    }

    @Test
    fun `physical corner aliases remain supported in nested maps`() {
        assertEquals(
            BorderCorners(3.dp, 6.dp, 9.dp, 12.dp),
            resolveCompoundBorderCorners(
                compoundBorder = mapOf("width" to 2),
                props = mapOf(
                    "borderRadius" to mapOf(
                        "topLeft" to 3,
                        "topRight" to 6,
                        "bottomRight" to 9,
                        "bottomLeft" to 12,
                    ),
                ),
            ),
        )
    }
}
