package space.hypen.renderer.routing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterControllerTest {
    @Test
    fun `push updates current path and history`() {
        val router = RouterController("/")

        router.push("/home")
        assertEquals("/home", router.state.value.currentPath)

        router.push("/products/123")
        assertEquals("/products/123", router.state.value.currentPath)

        router.back()
        assertEquals("/home", router.state.value.currentPath)

        router.forward()
        assertEquals("/products/123", router.state.value.currentPath)
    }

    @Test
    fun `replace overwrites current history entry`() {
        val router = RouterController("/")

        router.push("/home")
        router.replace("/about")

        assertEquals("/about", router.state.value.currentPath)
        router.back()
        assertEquals("/", router.state.value.currentPath)
    }

    @Test
    fun `matchPath supports params and wildcards`() {
        val router = RouterController("/")

        val userMatch = router.matchPath("/users/:id", "/users/42")
        assertEquals("42", userMatch?.params?.get("id"))

        val wildcardMatch = router.matchPath("/docs/*", "/docs/guides/intro")
        assertTrue(wildcardMatch != null)

        assertFalse(router.isActive("/missing"))
    }

    @Test
    fun `query strings are parsed and exposed`() {
        val router = RouterController("/products?sort=asc&limit=10")

        assertEquals("asc", router.state.value.query["sort"])
        assertEquals("10", router.state.value.query["limit"])

        router.push("/products?id=123")
        assertEquals("123", router.state.value.query["id"])
    }
}
