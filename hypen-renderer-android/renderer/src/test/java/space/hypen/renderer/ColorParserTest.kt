package space.hypen.renderer

import androidx.compose.ui.graphics.Color
import space.hypen.renderer.applicators.ColorParser
import org.junit.Assert.*
import org.junit.Test

class ColorParserTest {
    @Test
    fun `parse named color red`() {
        val result = ColorParser.parse("red")
        assertEquals(Color.Red, result)
    }

    @Test
    fun `parse named color blue`() {
        val result = ColorParser.parse("blue")
        assertEquals(Color.Blue, result)
    }

    @Test
    fun `parse named color case insensitive`() {
        assertEquals(ColorParser.parse("RED"), ColorParser.parse("red"))
        assertEquals(ColorParser.parse("Blue"), ColorParser.parse("blue"))
        assertEquals(ColorParser.parse("GREEN"), ColorParser.parse("green"))
    }

    @Test
    fun `parse hex color 6 digits`() {
        val result = ColorParser.parse("#FF0000")
        assertNotNull(result)
        assertEquals(Color(255, 0, 0), result)
    }

    @Test
    fun `parse hex color 3 digits`() {
        val result = ColorParser.parse("#F00")
        assertNotNull(result)
        assertEquals(Color(255, 0, 0), result)
    }

    @Test
    fun `parse hex color 8 digits with alpha`() {
        val result = ColorParser.parse("#FF000080")
        assertNotNull(result)
        assertEquals(Color(255, 0, 0, 128), result)
    }

    @Test
    fun `parse hex color without hash`() {
        val result = ColorParser.parse("00FF00")
        assertNotNull(result)
        assertEquals(Color(0, 255, 0), result)
    }

    @Test
    fun `parse rgb map`() {
        val result =
            ColorParser.parse(
                mapOf(
                    "r" to 255,
                    "g" to 128,
                    "b" to 64,
                ),
            )
        assertNotNull(result)
        assertEquals(Color(255, 128, 64), result)
    }

    @Test
    fun `parse rgba map`() {
        val result =
            ColorParser.parse(
                mapOf(
                    "red" to 100,
                    "green" to 150,
                    "blue" to 200,
                    "alpha" to 128,
                ),
            )
        assertNotNull(result)
        assertEquals(Color(100, 150, 200, 128), result)
    }

    @Test
    fun `parse transparent`() {
        val result = ColorParser.parse("transparent")
        assertEquals(Color.Transparent, result)
    }

    @Test
    fun `parse null returns null`() {
        val result = ColorParser.parse(null)
        assertNull(result)
    }

    @Test
    fun `parse invalid string returns null`() {
        val result = ColorParser.parse("notacolor")
        assertNull(result)
    }

    @Test
    fun `parse long value as color`() {
        val result = ColorParser.parse(0xFF0000FFL)
        assertNotNull(result)
    }
}
