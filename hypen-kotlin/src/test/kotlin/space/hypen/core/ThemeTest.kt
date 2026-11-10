package space.hypen.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [Theme] behaviour: the cross-SDK resolution fixture
 * (`engine-compatibility-tests/fixtures/theme/resolve.json`) plus the API
 * surface that needs no engine. Engine and server integration live in
 * [ThemeEngineTest].
 */
class ThemeTest {
    private val tokens = mapOf(
        "color" to mapOf("brand" to "#0066ff", "primary" to "{color.brand}", "surface" to "#ffffff"),
        "space" to mapOf("md" to 16),
    )
    private val dark = mapOf("color" to mapOf("brand" to "#66a3ff", "surface" to "#111111"))

    // ── Cross-SDK fixture ──────────────────────────────────────────────

    @TestFactory
    fun runThemeResolveFixture(): Collection<DynamicTest> {
        val file = File("../engine-compatibility-tests/fixtures/theme/resolve.json")
        check(file.exists()) { "theme fixture missing: ${file.absolutePath}" }
        val cases = Json.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        check(cases.isNotEmpty()) { "theme fixture has no cases" }

        return cases.map { it.jsonObject }.map { case ->
            DynamicTest.dynamicTest(case["name"]!!.jsonPrimitive.content) {
                @Suppress("UNCHECKED_CAST")
                val theme = createTheme(
                    tokens = case["tokens"]!!.toKotlinValue() as Tokens,
                    schemes = case["schemes"]!!.toKotlinValue() as Map<String, Tokens>,
                    scheme = case["preference"]!!.jsonPrimitive.content,
                    systemScheme = SystemColorScheme.of(case["system"]!!.jsonPrimitive.content)!!,
                )
                val expected = case["expected"]!!.jsonObject
                assertEquals(expected["scheme"]!!.jsonPrimitive.content, theme.scheme, "scheme")
                assertEquals(expected["tokens"], theme.tokens.toJsonElement(), "tokens")
                assertEquals(
                    expected["problems"]!!.jsonPrimitive.int,
                    theme.problems.size,
                    "problems: ${theme.problems}",
                )
            }
        }
    }

    // ── Scheme selection ───────────────────────────────────────────────

    @Test
    fun `defaults to the system preference and a light system scheme`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        assertEquals("system", theme.preference)
        assertEquals(SystemColorScheme.LIGHT, theme.systemScheme)
        assertEquals("light", theme.scheme)
        assertEquals(listOf("dark"), theme.schemes)
        assertEquals(
            ThemeMeta("light", "system", SystemColorScheme.LIGHT, listOf("dark")),
            theme.meta,
        )
        assertEquals(
            mapOf("scheme" to "light", "preference" to "system", "system" to "light", "schemes" to listOf("dark")),
            theme.meta.toMap(),
        )
        assertEquals("#0066ff", theme.token("color.primary"))
    }

    @Test
    fun `setScheme switches tokens and rejects unknown names`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark, "sepia" to emptyMap()))
        theme.setScheme("dark")
        assertEquals("dark", theme.scheme)
        assertEquals("dark", theme.preference)
        assertEquals("#66a3ff", theme.token("color.primary"), "the alias follows the scheme's brand")
        assertEquals(16, theme.token("space.md"))

        theme.setScheme("sepia")
        assertEquals("#0066ff", theme.token("color.brand"))

        val error = assertFailsWith<IllegalArgumentException> { theme.setScheme("neon") }
        assertTrue(error.message!!.contains("neon"), error.message)
        assertTrue(error.message!!.contains("system, light, dark, sepia"), error.message)
        assertEquals("sepia", theme.preference, "a refused scheme changes nothing")
    }

    @Test
    fun `an unknown initial scheme falls back to system`() {
        val theme = createTheme(tokens = tokens, scheme = "neon")
        assertEquals("system", theme.preference)
        assertEquals("light", theme.scheme)
    }

    @Test
    fun `toggle flips between light and dark from whichever is in effect`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark), systemScheme = SystemColorScheme.DARK)
        assertEquals("dark", theme.scheme)
        theme.toggle()
        assertEquals("light", theme.preference)
        theme.toggle()
        assertEquals("dark", theme.preference)
    }

    @Test
    fun `setSystemScheme applies only while the preference is system`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        theme.setSystemScheme(SystemColorScheme.DARK)
        assertEquals("dark", theme.scheme)
        assertEquals("#111111", theme.token("color.surface"))

        theme.setScheme("light")
        theme.setSystemScheme(SystemColorScheme.LIGHT)
        theme.setSystemScheme(SystemColorScheme.DARK)
        assertEquals("light", theme.scheme, "an explicit preference wins")
        theme.setScheme("system")
        assertEquals("dark", theme.scheme, "the remembered system scheme applies again")
    }

    // ── Tokens ─────────────────────────────────────────────────────────

    @Test
    fun `extend merges into the base set or one scheme`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        theme.extend(mapOf("color" to mapOf("accent" to "{color.brand}"), "radius" to mapOf("md" to 8)))
        assertEquals("#0066ff", theme.token("color.accent"))
        assertEquals(8, theme.token("radius.md"))
        assertEquals("#ffffff", theme.token("color.surface"), "existing tokens survive the merge")

        theme.extend(mapOf("radius" to mapOf("md" to 12)), scheme = "dark")
        assertEquals(8, theme.token("radius.md"), "an inactive scheme's override is not in effect")
        theme.setScheme("dark")
        assertEquals(12, theme.token("radius.md"))

        theme.extend(mapOf("color" to mapOf("accent" to "#ff00ff")), scheme = "contrast")
        assertEquals(listOf("dark", "contrast"), theme.schemes)
        theme.setScheme("contrast")
        assertEquals("#ff00ff", theme.token("color.accent"))
    }

    @Test
    fun `has and token report missing tokens once`() {
        val missing = mutableListOf<Pair<String, String>>()
        val theme = createTheme(tokens = tokens, onMissingToken = { path, scheme -> missing.add(path to scheme) })
        assertTrue(theme.has("color.primary"))
        assertTrue(theme.has("color"))
        assertFalse(theme.has("color.nope"))
        assertFalse(theme.has("color.primary.deeper"))
        assertEquals(mapOf("md" to 16), theme.token("space"))

        assertNull(theme.token("color.nope"))
        assertNull(theme.token("color.nope"))
        assertEquals(listOf("color.nope" to "light"), missing)
    }

    @Test
    fun `problems lists alias problems of the active scheme`() {
        val theme = createTheme(
            tokens = mapOf("a" to "{missing}", "b" to 1),
            schemes = mapOf("dark" to mapOf("a" to "{b}")),
        )
        assertEquals(listOf("Token \"a\" aliases \"missing\", which is not defined"), theme.problems)
        assertEquals("{missing}", theme.token("a"))
        theme.setScheme("dark")
        assertEquals(emptyList(), theme.problems)
        assertEquals(1, theme.token("a"))
    }

    // ── Listeners, forks, engines ──────────────────────────────────────

    @Test
    fun `onChange hears scheme and token changes until unsubscribed`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val heard = mutableListOf<ThemeMeta>()
        val stop = theme.onChange { heard.add(it) }

        theme.setScheme("dark")
        theme.setScheme("dark") // unchanged: silent
        theme.setSystemScheme(SystemColorScheme.DARK) // scheme stays dark, meta.system changes
        theme.extend(mapOf("x" to 1))
        assertEquals(listOf("dark", "dark", "dark"), heard.map { it.scheme })
        assertEquals(SystemColorScheme.DARK, heard[1].system)

        stop()
        theme.setScheme("light")
        assertEquals(3, heard.size)
    }

    @Test
    fun `a listener that throws does not break the change or other listeners`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        var heard = 0
        theme.onChange { error("boom") }
        theme.onChange { heard++ }
        theme.setScheme("dark")
        assertEquals(1, heard)
        assertEquals("dark", theme.scheme)
    }

    @Test
    fun `fork has its own preference and shares the tokens`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val a = theme.fork()
        val b = theme.fork("dark")
        assertEquals("system", a.preference)
        assertEquals("dark", b.preference)

        a.setScheme("dark")
        assertEquals("light", theme.scheme, "a fork's scheme does not leak to its parent")
        a.setScheme("light")
        assertEquals("dark", b.scheme, "nor to a sibling")

        // Tokens are shared: an extension made through one instance is seen
        // by the others the next time they resolve.
        theme.extend(mapOf("color" to mapOf("accent" to "#ff00ff")))
        assertEquals("#ff00ff", theme.token("color.accent"))
        a.setScheme("dark")
        assertEquals("#ff00ff", a.token("color.accent"))

        assertEquals("system", theme.fork("neon").preference, "an unknown preference follows the system")
    }

    @Test
    fun `attach publishes appearance and theme now and on every change`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val engine = MockEngine()
        val detach = theme.attach(engine)

        assertEquals(listOf("appearance", "theme"), engine.contextCalls.map { it.first })
        assertEquals("light", engine.contextCalls[0].second["scheme"])
        assertEquals(theme.tokens, engine.contextCalls[1].second)

        theme.setScheme("dark")
        assertEquals(4, engine.contextCalls.size)
        assertEquals("dark", engine.contextCalls[2].second["scheme"])
        assertEquals("#111111", (engine.contextCalls[3].second["color"] as Map<*, *>)["surface"])

        detach()
        theme.setScheme("light")
        assertEquals(4, engine.contextCalls.size, "a detached engine hears nothing more")
    }

    @Test
    fun `resolveTokenAliases leaves its input untouched`() {
        val input = mapOf("a" to 1, "b" to "{a}", "g" to mapOf("c" to "{b}"))
        val problems = mutableListOf<String>()
        val out = resolveTokenAliases(input) { problems.add(it) }
        assertEquals(mapOf("a" to 1, "b" to 1, "g" to mapOf("c" to 1)), out)
        assertEquals("{a}", input["b"])
        assertEquals(emptyList(), problems)
    }
}
