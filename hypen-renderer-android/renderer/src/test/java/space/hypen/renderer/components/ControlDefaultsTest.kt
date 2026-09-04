package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class ControlDefaultsTest {
    private fun audio(props: Map<String, Any?> = emptyMap()) =
        HypenElement(id = "audio", elementType = "audio", props = props)

    @Test
    fun `audio controls are visible by default and explicit false is honored`() {
        assertTrue(audioControlsVisible(audio()))
        assertTrue(audioControlsVisible(audio(mapOf("controls" to true))))
        assertFalse(audioControlsVisible(audio(mapOf("controls" to false))))
        assertFalse(audioControlsVisible(audio(mapOf("controls.0" to false))))
    }

    @Test
    fun `checkbox visual footprint is twenty dp`() {
        assertEquals(20f, HypenCheckboxMetric.value)
    }

    @Test
    fun `select uses declarative text children and defaults to first option`() {
        val options = selectChildOptions(
            listOf(
                HypenElement(id = "one", elementType = "Text", props = mapOf("0" to "Option 1")),
                HypenElement(id = "ignored", elementType = "Icon", props = mapOf("0" to "No")),
                HypenElement(id = "two", elementType = "Text", props = mapOf("text" to "Option 2")),
            ),
        )

        assertEquals(listOf("Option 1", "Option 2"), options)
        assertEquals("Option 1", resolvedSelectInitialValue(null, options))
        assertEquals("Option 2", resolvedSelectInitialValue("Option 2", options))
    }
}
