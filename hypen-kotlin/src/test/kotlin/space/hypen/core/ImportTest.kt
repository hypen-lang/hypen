package space.hypen.core

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests for import resolution infrastructure in the Kotlin SDK.
 *
 * Covers:
 * - ImportStatement data class
 * - ComponentDefinition data class
 * - ComponentResolver: parseImports, resolveLocal, caching
 * - ComponentLoader: discovery patterns
 */
class ImportTest {

    // ========================================================================
    // A. ImportStatement Tests (4 tests)
    // ========================================================================

    @Test
    fun `ImportStatement local source detected`() {
        val stmt = ImportStatement(
            names = listOf("Button", "Card"),
            sourcePath = "./components/ui",
            sourceType = "local"
        )

        assertTrue(stmt.isLocal)
        assertEquals(2, stmt.names.size)
        assertEquals("Button", stmt.names[0])
        assertEquals("Card", stmt.names[1])
    }

    @Test
    fun `ImportStatement URL source detected`() {
        val stmt = ImportStatement(
            names = listOf("Widget"),
            sourcePath = "https://cdn.example.com/widgets",
            sourceType = "url"
        )

        assertFalse(stmt.isLocal)
        assertEquals("https://cdn.example.com/widgets", stmt.sourcePath)
    }

    @Test
    fun `ImportStatement single name`() {
        val stmt = ImportStatement(
            names = listOf("HomePage"),
            sourcePath = "./pages/home",
            sourceType = "local"
        )

        assertEquals(1, stmt.names.size)
        assertEquals("HomePage", stmt.names[0])
    }

    @Test
    fun `ImportStatement many names`() {
        val stmt = ImportStatement(
            names = listOf("A", "B", "C", "D", "E"),
            sourcePath = "./widgets",
            sourceType = "local"
        )

        assertEquals(5, stmt.names.size)
    }

    // ========================================================================
    // B. ComponentDefinition Tests (2 tests)
    // ========================================================================

    @Test
    fun `ComponentDefinition stores template and path`() {
        val def = ComponentDefinition(
            template = """Text("Hello")""",
            path = "./components/greeting.hypen"
        )

        assertEquals("""Text("Hello")""", def.template)
        assertEquals("./components/greeting.hypen", def.path)
    }

    @Test
    fun `ComponentDefinition with empty path`() {
        val def = ComponentDefinition(
            template = """Text("Inline")""",
            path = ""
        )

        assertEquals("", def.path)
    }

    // ========================================================================
    // C. ComponentResolver.parseImports Tests (6 tests)
    // ========================================================================

    @Test
    fun `parseImports default import local`() {
        val text = """import HomePage from "./pages/HomePage""""
        val imports = ComponentResolver.parseImports(text)

        assertEquals(1, imports.size)
        assertEquals(listOf("HomePage"), imports[0].names)
        assertEquals("./pages/HomePage", imports[0].sourcePath)
        assertEquals("local", imports[0].sourceType)
    }

    @Test
    fun `parseImports named imports local`() {
        val text = """import { Button, Card } from "./components/ui""""
        val imports = ComponentResolver.parseImports(text)

        assertEquals(1, imports.size)
        assertEquals(listOf("Button", "Card"), imports[0].names)
        assertEquals("./components/ui", imports[0].sourcePath)
    }

    @Test
    fun `parseImports URL import`() {
        val text = """import Widget from "https://cdn.example.com/widget""""
        val imports = ComponentResolver.parseImports(text)

        assertEquals(1, imports.size)
        assertEquals("url", imports[0].sourceType)
        assertEquals("https://cdn.example.com/widget", imports[0].sourcePath)
    }

    @Test
    fun `parseImports multiple imports`() {
        val text = """
            import { Button } from "./ui"
            import Header from "./layout"
            import { Widget } from "https://cdn.example.com/w"
        """.trimIndent()
        val imports = ComponentResolver.parseImports(text)

        assertEquals(3, imports.size)
        assertEquals("local", imports[0].sourceType)
        assertEquals("local", imports[1].sourceType)
        assertEquals("url", imports[2].sourceType)
    }

    @Test
    fun `parseImports no imports`() {
        val text = """Column { Text("Hello") }"""
        val imports = ComponentResolver.parseImports(text)

        assertEquals(0, imports.size)
    }

    @Test
    fun `parseImports with Hypen DSL around them`() {
        val text = """
            import { Button } from "./ui"

            Column {
                Button(text: "Click")
            }
        """.trimIndent()
        val imports = ComponentResolver.parseImports(text)

        assertEquals(1, imports.size)
        assertEquals(listOf("Button"), imports[0].names)
    }

    // ========================================================================
    // D. ComponentResolver.resolveLocal Tests (5 tests)
    // ========================================================================

    @Test
    fun `resolveLocal reads hypen file`(@TempDir dir: File) {
        val hypenContent = """Text("Hello from Button")"""
        File(dir, "Button.hypen").writeText(hypenContent)

        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("Button"),
            sourcePath = "./Button",
            sourceType = "local"
        )

        val result = resolver.resolve(stmt)

        assertEquals(1, result.size)
        assertNotNull(result["Button"])
        assertEquals(hypenContent, result["Button"]!!.template)
    }

    @Test
    fun `resolveLocal with explicit hypen extension`(@TempDir dir: File) {
        File(dir, "Card.hypen").writeText("""Text("Card")""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("Card"),
            sourcePath = "./Card.hypen",
            sourceType = "local"
        )

        val result = resolver.resolve(stmt)
        assertNotNull(result["Card"])
    }

    @Test
    fun `resolveLocal named imports returns all names`(@TempDir dir: File) {
        File(dir, "ui.hypen").writeText("""Column { Text("UI") }""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("Button", "Card", "Input"),
            sourcePath = "./ui",
            sourceType = "local"
        )

        val result = resolver.resolve(stmt)
        assertEquals(3, result.size)
        assertTrue(result.containsKey("Button"))
        assertTrue(result.containsKey("Card"))
        assertTrue(result.containsKey("Input"))
    }

    @Test
    fun `resolveLocal nested directory`(@TempDir dir: File) {
        val subDir = File(dir, "components/ui")
        subDir.mkdirs()
        File(subDir, "Button.hypen").writeText("""Text("Nested Button")""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("Button"),
            sourcePath = "./components/ui/Button",
            sourceType = "local"
        )

        val result = resolver.resolve(stmt)
        assertNotNull(result["Button"])
    }

    @Test
    fun `resolveLocal file not found throws`(@TempDir dir: File) {
        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("Missing"),
            sourcePath = "./Missing",
            sourceType = "local"
        )

        try {
            resolver.resolve(stmt)
            assertTrue(false, "Expected exception for missing file")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("not found"))
        }
    }

    // ========================================================================
    // E. ComponentResolver Caching Tests (3 tests)
    // ========================================================================

    @Test
    fun `resolver caches resolved components`(@TempDir dir: File) {
        File(dir, "Widget.hypen").writeText("""Text("Widget")""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath, cache = true)
        val stmt = ImportStatement(
            names = listOf("Widget"),
            sourcePath = "./Widget",
            sourceType = "local"
        )

        // First resolve
        resolver.resolve(stmt)
        assertEquals(1, resolver.cacheSize)

        // Delete the file
        File(dir, "Widget.hypen").delete()

        // Second resolve should use cache
        val result = resolver.resolve(stmt)
        assertNotNull(result["Widget"])
    }

    @Test
    fun `resolver clearCache empties cache`(@TempDir dir: File) {
        File(dir, "A.hypen").writeText("""Text("A")""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath)
        val stmt = ImportStatement(
            names = listOf("A"),
            sourcePath = "./A",
            sourceType = "local"
        )

        resolver.resolve(stmt)
        assertEquals(1, resolver.cacheSize)

        resolver.clearCache()
        assertEquals(0, resolver.cacheSize)
    }

    @Test
    fun `resolver no cache mode reads fresh`(@TempDir dir: File) {
        File(dir, "Widget.hypen").writeText("""Text("v1")""")

        val resolver = ComponentResolver(baseDir = dir.absolutePath, cache = false)
        val stmt = ImportStatement(
            names = listOf("Widget"),
            sourcePath = "./Widget",
            sourceType = "local"
        )

        val v1 = resolver.resolve(stmt)
        assertEquals("""Text("v1")""", v1["Widget"]!!.template)

        // Update the file
        File(dir, "Widget.hypen").writeText("""Text("v2")""")

        val v2 = resolver.resolve(stmt)
        assertEquals("""Text("v2")""", v2["Widget"]!!.template)
    }

    // ========================================================================
    // F. DiscoveryPattern Tests (3 tests)
    // ========================================================================

    @Test
    fun `DiscoveryPattern DEFAULT contains all patterns`() {
        val defaults = DiscoveryPattern.DEFAULT
        assertEquals(3, defaults.size)
        assertTrue(defaults.contains(DiscoveryPattern.FOLDER))
        assertTrue(defaults.contains(DiscoveryPattern.SIBLING))
        assertTrue(defaults.contains(DiscoveryPattern.INDEX))
    }

    @Test
    fun `DiscoveredComponent stores name template and path`() {
        val comp = DiscoveredComponent(
            name = "Button",
            hypenPath = "/app/components/Button.hypen",
            template = """Text("Click me")"""
        )

        assertEquals("Button", comp.name)
        assertEquals("/app/components/Button.hypen", comp.hypenPath)
        assertEquals("""Text("Click me")""", comp.template)
    }

    @Test
    fun `DiscoveredComponent data class equality works`() {
        val comp1 = DiscoveredComponent("A", "/a.hypen", "Text(\"A\")")
        val comp2 = DiscoveredComponent("A", "/a.hypen", "Text(\"A\")")
        val comp3 = DiscoveredComponent("B", "/b.hypen", "Text(\"B\")")

        assertEquals(comp1, comp2)
        assertFalse(comp1 == comp3)
    }
}
