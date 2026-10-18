package space.hypen.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.model.propToDisplayString

/**
 * Numbers in props must render like JavaScript's `String(n)` so Android
 * matches the web renderer: `Text("@{state.count}")` with count = 2 shows
 * "2", not Kotlin's "2.0".
 */
class PropDisplayStringTest {
    @Test
    fun `whole doubles print without a decimal`() {
        assertEquals("2", propToDisplayString(2.0))
        assertEquals("-7", propToDisplayString(-7.0))
        assertEquals("0", propToDisplayString(0.0))
        assertEquals("0", propToDisplayString(-0.0))
        assertEquals("10000000", propToDisplayString(1e7))
        assertEquals("123456789012", propToDisplayString(123456789012.0))
    }

    @Test
    fun `fractional doubles keep their digits`() {
        assertEquals("2.5", propToDisplayString(2.5))
        assertEquals("0.1", propToDisplayString(0.1))
        assertEquals("0.30000000000000004", propToDisplayString(0.1 + 0.2))
        assertEquals("0.0001", propToDisplayString(0.0001))
    }

    @Test
    fun `extreme doubles use JS exponential form`() {
        assertEquals("1e+21", propToDisplayString(1e21))
        assertEquals("1.5e-8", propToDisplayString(1.5e-8))
        assertEquals("1e-7", propToDisplayString(1e-7))
        assertEquals("0.000001", propToDisplayString(1e-6))
        assertEquals("1e-7", propToDisplayString(1e-7))
        assertEquals("0.000001", propToDisplayString(1e-6))
        assertEquals("NaN", propToDisplayString(Double.NaN))
        assertEquals("Infinity", propToDisplayString(Double.POSITIVE_INFINITY))
    }

    @Test
    fun `non-numbers are unchanged`() {
        assertNull(propToDisplayString(null))
        assertEquals("hello", propToDisplayString("hello"))
        assertEquals("2.0", propToDisplayString("2.0"))
        assertEquals("true", propToDisplayString(true))
        assertEquals("42", propToDisplayString(42L))
        assertEquals("3", propToDisplayString(3f))
    }

    @Test
    fun `getStringProp formats numeric props`() {
        val el = HypenElement(id = "t", elementType = "text", props = mapOf("0" to 2.0, "list" to listOf(1.0, 1.5)))
        assertEquals("2", el.getStringProp("0"))
        assertEquals(listOf("1", "1.5"), el.getStringListProp("list"))
    }
}
