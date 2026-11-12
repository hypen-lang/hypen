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
    fun `createTheme can be called with no arguments, named arguments, or options`() {
        val bare = createTheme()
        assertEquals("system", bare.preference)
        assertEquals(emptyMap(), bare.tokens)

        assertEquals("#0066ff", createTheme(tokens = tokens).token("color.brand"))
        assertEquals("dark", createTheme(scheme = "dark").scheme)
        assertEquals("dark", createTheme(ThemeOptions(tokens = tokens, scheme = "dark")).scheme)
        assertEquals("system", Theme().preference)
    }

    // ── Locking ────────────────────────────────────────────────────────

    /**
     * An engine that, like any host wrapper that serialises engine access,
     * holds its own lock while it applies a call and runs the render
     * callback.
     */
    private class LockingEngine(private val inner: MockEngine = MockEngine()) : IEngine by inner {
        private val engineLock = Any()
        private var callback: RenderCallback? = null
        val contexts = mutableListOf<Pair<String, Map<String, Any?>>>()

        override fun setRenderCallback(callback: RenderCallback) {
            this.callback = callback
        }

        override fun setContext(name: String, data: Map<String, Any?>): List<Patch> = synchronized(engineLock) {
            contexts.add(name to data)
            callback?.invoke(emptyList())
            emptyList()
        }

        override fun updateState(scope: String, paths: List<String>, values: Map<String, Any?>) {
            synchronized(engineLock) { callback?.invoke(emptyList()) }
        }

        fun lastScheme(): Any? = synchronized(engineLock) { contexts.last { it.first == THEME_META_PROVIDER }.second["scheme"] }
        fun lastTokens(): Map<String, Any?> = synchronized(engineLock) { contexts.last { it.first == THEME_TOKENS_PROVIDER }.second }
    }

    /** Run [block] on a daemon thread, so a deadlocked one cannot hang the JVM. */
    private fun daemon(name: String, block: () -> Unit): Thread =
        Thread(block, name).apply { isDaemon = true; start() }

    private fun assertFinished(vararg threads: Thread) {
        threads.forEach { it.join(5_000) }
        val stuck = threads.filter { it.isAlive }
        assertTrue(stuck.isEmpty(), "deadlock: ${stuck.map { "${it.name} is ${it.state}" }}")
    }

    /**
     * Thread A switches scheme while thread B is inside the engine, in a
     * render callback that reads the theme. If the theme held its own lock
     * while publishing, A would wait for the engine (held by B) holding the
     * lock B needs: a deadlock.
     */
    @Test
    fun `a render callback can read the theme while another thread switches scheme`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val engine = LockingEngine()
        theme.attach(engine)

        val insideCallback = java.util.concurrent.CountDownLatch(1)
        val switching = java.util.concurrent.CountDownLatch(1)
        val armed = java.util.concurrent.atomic.AtomicBoolean(true)
        var seen: Any? = null
        engine.setRenderCallback {
            if (armed.compareAndSet(true, false)) {
                insideCallback.countDown()
                switching.await()
                Thread.sleep(300) // let the switcher reach the engine and block on it
                seen = theme.scheme to theme.token("color.surface")
            }
        }

        val reader = daemon("reader") { engine.updateState("", emptyList(), emptyMap()) }
        assertTrue(insideCallback.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val switcher = daemon("switcher") {
            switching.countDown()
            theme.setScheme("dark")
        }
        assertFinished(reader, switcher)

        assertEquals("dark" to "#111111", seen, "the reader saw the new scheme, without waiting")
        assertEquals("dark", engine.lastScheme())
        assertEquals(theme.tokens, engine.lastTokens())
    }

    /**
     * The same shape, with the callback changing the theme instead of
     * reading it: the thread inside the engine must not wait for a publish
     * that is itself waiting for the engine. The publisher delivers the
     * newer snapshot when it gets through.
     */
    @Test
    fun `a render callback can change the theme while another thread is publishing`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark, "sepia" to mapOf("space" to mapOf("md" to 20))))
        val engine = LockingEngine()
        theme.attach(engine)

        val insideCallback = java.util.concurrent.CountDownLatch(1)
        val switching = java.util.concurrent.CountDownLatch(1)
        val armed = java.util.concurrent.atomic.AtomicBoolean(true)
        engine.setRenderCallback {
            if (armed.compareAndSet(true, false)) {
                insideCallback.countDown()
                switching.await()
                Thread.sleep(300)
                theme.setScheme("sepia")
            }
        }

        val inEngine = daemon("in-engine") { engine.updateState("", emptyList(), emptyMap()) }
        assertTrue(insideCallback.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val switcher = daemon("switcher") {
            switching.countDown()
            theme.setScheme("dark")
        }
        assertFinished(inEngine, switcher)

        assertEquals("sepia", theme.scheme)
        assertEquals("sepia", engine.lastScheme(), "the engine ends on the newest snapshot")
        assertEquals(20, (engine.lastTokens()["space"] as Map<*, *>)["md"])
    }

    @Test
    fun `a change made from inside a publish is delivered after it, not recursively`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val engine = LockingEngine()
        theme.attach(engine)
        var depth = 0
        var maxDepth = 0
        engine.setRenderCallback {
            depth++
            maxDepth = maxOf(maxDepth, depth)
            if (theme.scheme == "dark") theme.setScheme("light")
            depth--
        }

        theme.setScheme("dark")

        assertEquals("light", theme.scheme)
        assertEquals("light", engine.lastScheme())
        assertEquals("#ffffff", (engine.lastTokens()["color"] as Map<*, *>)["surface"])
        assertEquals(1, maxDepth, "the follow-up publish ran after the first, not inside it")
    }

    @Test
    fun `racing scheme changes leave every engine on the newest snapshot`() {
        val theme = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))
        val engines = List(3) { LockingEngine() }
        engines.forEach { theme.attach(it) }

        val start = java.util.concurrent.CountDownLatch(1)
        val threads = List(8) { n ->
            daemon("racer-$n") {
                start.await()
                repeat(200) { i -> theme.setScheme(if ((i + n) % 2 == 0) "dark" else "light") }
            }
        }
        start.countDown()
        assertFinished(*threads.toTypedArray())

        // A racer whose change found a publish in progress returns before
        // it is delivered; the publisher is at most one round behind.
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline && engines.any { it.lastScheme() != theme.scheme }) Thread.sleep(5)
        for (engine in engines) {
            assertEquals(theme.scheme, engine.lastScheme())
            assertEquals(theme.tokens, engine.lastTokens())
        }
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
