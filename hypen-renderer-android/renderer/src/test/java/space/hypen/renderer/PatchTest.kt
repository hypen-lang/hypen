package space.hypen.renderer

import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchType
import org.junit.Assert.*
import org.junit.Test

class PatchTest {
    @Test
    fun `create patch with factory method`() {
        val patch =
            Patch.create(
                id = "element-1",
                elementType = "text",
                props = mapOf("0" to "Hello World"),
            )

        assertEquals(PatchType.CREATE, patch.type)
        assertEquals("element-1", patch.id)
        assertEquals("text", patch.elementType)
        assertEquals("Hello World", patch.props?.get("0"))
    }

    @Test
    fun `setProp patch with factory method`() {
        val patch =
            Patch.setProp(
                id = "element-1",
                name = "color",
                value = "red",
            )

        assertEquals(PatchType.SET_PROP, patch.type)
        assertEquals("element-1", patch.id)
        assertEquals("color", patch.name)
        assertEquals("red", patch.value)
    }

    @Test
    fun `setText patch with factory method`() {
        val patch =
            Patch.setText(
                id = "element-1",
                text = "Updated text",
            )

        assertEquals(PatchType.SET_TEXT, patch.type)
        assertEquals("element-1", patch.id)
        assertEquals("Updated text", patch.text)
    }

    @Test
    fun `insert patch with factory method`() {
        val patch =
            Patch.insert(
                parentId = "parent-1",
                id = "element-1",
                beforeId = "element-2",
            )

        assertEquals(PatchType.INSERT, patch.type)
        assertEquals("parent-1", patch.parentId)
        assertEquals("element-1", patch.id)
        assertEquals("element-2", patch.beforeId)
    }

    @Test
    fun `move patch with factory method`() {
        val patch =
            Patch.move(
                parentId = "parent-1",
                id = "element-1",
                beforeId = null,
            )

        assertEquals(PatchType.MOVE, patch.type)
        assertEquals("parent-1", patch.parentId)
        assertEquals("element-1", patch.id)
        assertNull(patch.beforeId)
    }

    @Test
    fun `remove patch with factory method`() {
        val patch = Patch.remove(id = "element-1")

        assertEquals(PatchType.REMOVE, patch.type)
        assertEquals("element-1", patch.id)
    }

    @Test
    fun `attachEvent patch with factory method`() {
        val patch =
            Patch.attachEvent(
                id = "element-1",
                eventName = "click",
            )

        assertEquals(PatchType.ATTACH_EVENT, patch.type)
        assertEquals("element-1", patch.id)
        assertEquals("click", patch.eventName)
    }

    @Test
    fun `detachEvent patch with factory method`() {
        val patch =
            Patch.detachEvent(
                id = "element-1",
                eventName = "click",
            )

        assertEquals(PatchType.DETACH_EVENT, patch.type)
        assertEquals("element-1", patch.id)
        assertEquals("click", patch.eventName)
    }

    @Test
    fun `patch with nested props`() {
        val patch =
            Patch.create(
                id = "element-1",
                elementType = "button",
                props =
                    mapOf(
                        "onClick" to
                            mapOf(
                                "0" to "@actions.submit",
                                "id" to "123",
                            ),
                        "padding" to 16,
                    ),
            )

        assertEquals(PatchType.CREATE, patch.type)
        @Suppress("UNCHECKED_CAST")
        val onClick = patch.props?.get("onClick") as? Map<String, Any?>
        assertEquals("@actions.submit", onClick?.get("0"))
        assertEquals("123", onClick?.get("id"))
        assertEquals(16, patch.props?.get("padding"))
    }
}
