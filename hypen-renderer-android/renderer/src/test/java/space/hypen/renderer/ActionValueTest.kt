package space.hypen.renderer

import space.hypen.renderer.model.ActionValue
import org.junit.Assert.*
import org.junit.Test

class ActionValueTest {
    @Test
    fun `parse simple action string`() {
        val result = ActionValue.parse("@actions.submit")

        assertNotNull(result)
        assertEquals("submit", result?.actionName)
        assertTrue(result?.payload?.isEmpty() == true)
    }

    @Test
    fun `parse action string with @ prefix`() {
        val result = ActionValue.parse("@increment")

        assertNotNull(result)
        assertEquals("increment", result?.actionName)
    }

    @Test
    fun `parse action string without @ returns null`() {
        val result = ActionValue.parse("notAnAction")

        assertNull(result)
    }

    @Test
    fun `parse action map with payload`() {
        val result =
            ActionValue.parse(
                mapOf(
                    "0" to "@actions.deleteItem",
                    "id" to "123",
                    "confirm" to true,
                ),
            )

        assertNotNull(result)
        assertEquals("deleteItem", result?.actionName)
        assertEquals("123", result?.payload?.get("id"))
        assertEquals(true, result?.payload?.get("confirm"))
    }

    @Test
    fun `parse action map without action key returns null`() {
        val result =
            ActionValue.parse(
                mapOf(
                    "id" to "123",
                ),
            )

        assertNull(result)
    }

    @Test
    fun `parse null returns null`() {
        val result = ActionValue.parse(null)
        assertNull(result)
    }

    @Test
    fun `parse number returns null`() {
        val result = ActionValue.parse(123)
        assertNull(result)
    }

    @Test
    fun `parse action map with invalid action string returns null`() {
        val result =
            ActionValue.parse(
                mapOf(
                    "0" to "notAnAction",
                    "id" to "123",
                ),
            )

        assertNull(result)
    }
}
