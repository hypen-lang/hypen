package space.hypen.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * [Theme] against the native engine: `@theme.*` resolves in applicators, a
 * scheme switch re-renders only the props whose token changed, a handler
 * can switch scheme through `context.theme`, and [HypenServer] gives every
 * session its own fork.
 */
class ThemeEngineTest {
    // An applicator's first positional argument reaches the renderer as the
    // prop `<applicator>.0` (`.color(x)` -> `color.0`); a component's as `0`.
    private val tokens = mapOf(
        "color" to mapOf("ink" to "#111111", "surface" to "#ffffff"),
        "space" to mapOf("md" to 16),
    )
    private val dark = mapOf("color" to mapOf("ink" to "#eeeeee", "surface" to "#000000"))

    private fun newTheme() = createTheme(tokens = tokens, schemes = mapOf("dark" to dark))

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    @AfterEach
    fun cleanup() {
        HypenApp.clear()
    }

    private fun requireNative() {
        val available = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(available, "Native Hypen engine library not available")
    }

    private fun List<Patch>.createOf(elementType: String): Patch =
        single { it.type == PatchType.CREATE && it.elementType == elementType }

    // ── Engine ─────────────────────────────────────────────────────────

    @Test
    fun `theme tokens resolve in applicators`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            newTheme().attach(engine)

            val patches = engine.renderSource(
                """Text("Hi").color(@theme.color.ink).padding(@theme.space.md)"""
            )
            val props = assertNotNull(patches.createOf("Text").props)
            assertEquals(JsonPrimitive("#111111"), props["color.0"], "props: $props")
            assertEquals(JsonPrimitive(16), props["padding.0"], "props: $props")
        }
    }

    @Test
    fun `a scheme switch emits only the changed prop`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            val theme = newTheme()
            theme.attach(engine)

            val initial = engine.renderSource(
                """
                Column {
                    Text("Hi").color(@theme.color.ink).padding(@theme.space.md)
                    Text("@{appearance.scheme}")
                    Text("Plain").padding(@theme.space.md)
                }
                """.trimIndent()
            )
            val textIds = initial.filter { it.type == PatchType.CREATE && it.elementType == "Text" }.map { it.id }
            assertEquals(3, textIds.size)

            val rendered = mutableListOf<Patch>()
            engine.setRenderCallback { rendered.addAll(it) }
            theme.setScheme("dark")

            // One prop per bound value that changed: the scheme name and the
            // ink color. `space.md` is the same in both schemes, so neither
            // padding is re-sent, and nothing is created or removed.
            assertEquals(
                listOf(
                    Triple(textIds[1], "0", JsonPrimitive("dark")),
                    Triple(textIds[0], "color.0", JsonPrimitive("#eeeeee")),
                ),
                rendered.map { Triple(it.id, it.name, it.value) },
                "patches: $rendered",
            )
            assertTrue(rendered.all { it.type == PatchType.SET_PROP }, "patches: $rendered")

            // Asking for the scheme already in effect renders nothing.
            rendered.clear()
            theme.setScheme("dark")
            assertEquals(emptyList(), rendered)
        }
    }

    @Test
    fun `setContext and removeContext return patches and feed the render callback`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            assertEquals(emptyList(), engine.setContext("brand", mapOf("name" to "Acme")))
            engine.renderSource("""Text("@{brand.name}")""")

            val rendered = mutableListOf<Patch>()
            engine.setRenderCallback { rendered.addAll(it) }
            val patches = engine.setContext("brand", mapOf("name" to "Globex"))
            assertEquals(1, patches.size, "patches: $patches")
            assertEquals(JsonPrimitive("Globex"), patches.single().value)
            assertEquals(patches, rendered)

            // Unchanged data re-renders nothing; removing an unknown context is a no-op.
            assertEquals(emptyList(), engine.setContext("brand", mapOf("name" to "Globex")))
            assertEquals(emptyList(), engine.removeContext("nope"))
        }
    }

    /**
     * Re-entrancy: the handler runs from inside `engine.dispatchAction` and
     * pushes a context straight back into the same engine. The Kotlin
     * engine wrapper runs handlers after the native dispatch call has
     * returned, so the publish is synchronous — the new token value is in
     * the patches by the time `dispatchAction` returns.
     */
    @Test
    fun `a handler that switches scheme renders the new token value`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            val theme = newTheme()
            theme.attach(engine)
            val context = HypenGlobalContext().apply { setTheme(theme) }

            var schemeSeenByHandler: String? = null
            val definition = AppBuilder.defineState(mapOf("taps" to 0), ModuleOptions(name = "App"))
                .onAction("toggleTheme") { ctx ->
                    ctx.state.set("taps", (ctx.state.get("taps") as? Int ?: 0) + 1)
                    ctx.context?.theme?.toggle()
                    schemeSeenByHandler = ctx.context?.theme?.scheme
                }
                .build()
            ModuleInstance(engine, definition, globalContext = context)

            val initial = engine.renderSource(
                """
                module App {
                    Column {
                        Text("Taps: @{state.taps}").color(@theme.color.ink)
                        Button("@actions.toggleTheme") { Text("Toggle") }
                    }
                }
                """.trimIndent()
            )
            val label = initial.first { it.type == PatchType.CREATE && it.elementType == "Text" }
            assertEquals(JsonPrimitive("#111111"), label.props?.get("color.0"))

            val rendered = mutableListOf<Patch>()
            engine.setRenderCallback { rendered.addAll(it) }
            engine.dispatchAction("toggleTheme")

            assertEquals("dark", schemeSeenByHandler)
            val byName = rendered.filter { it.id == label.id }.associate { it.name to it.value }
            assertEquals(JsonPrimitive("#eeeeee"), byName["color.0"], "patches: $rendered")
            assertEquals(JsonPrimitive("Taps: 1"), byName["0"], "patches: $rendered")

            rendered.clear()
            engine.dispatchAction("toggleTheme")
            assertEquals("light", theme.scheme)
            assertEquals(
                JsonPrimitive("#111111"),
                rendered.single { it.id == label.id && it.name == "color.0" }.value,
            )
        }
    }

    // ── HypenServer ────────────────────────────────────────────────────

    private class Connected(val key: Any, val sent: MutableList<String>, val send: suspend (String) -> Unit) {
        fun frames(): List<JsonObject> = synchronized(sent) { sent.map { Json.decodeFromString<JsonObject>(it) } }
        val sessionId: String get() = frames().first()["sessionId"]!!.jsonPrimitive.content
    }

    /** Legacy hello-less connect; the returned initial tree is recorded as a frame too. */
    private suspend fun connect(server: HypenServer, sessionId: String? = null): Connected {
        val sent = mutableListOf<String>()
        val key = Any()
        val send: suspend (String) -> Unit = { msg -> synchronized(sent) { sent.add(msg) } }
        val initialTree = server.handleConnect(connectionKey = key, sessionId = sessionId, sendMessage = send)
        send(initialTree)
        return Connected(key, sent, send)
    }

    private fun themedServer(): HypenServer {
        app.module("Themed")
            .defineState(mapOf("taps" to 0))
            .ui(
                """module Themed {
                    Column {
                        Text("Scheme: @{appearance.scheme}").color(@theme.color.ink)
                        Button("@actions.toggleTheme") { Text("Toggle") }
                    }
                }""".trimIndent()
            )
            .onAction("toggleTheme") { ctx -> ctx.context?.theme?.toggle() }
            .build()

        return HypenServer {
            module("Themed", HypenApp.get("Themed")!!)
            route("/", "Themed")
            theme(newTheme())
        }
    }

    /** The themed label's `color` and text as the initial tree created it. */
    private fun labelOf(initialTree: JsonObject): Pair<String?, String?> {
        val label = initialTree["patches"]!!.jsonArray.map { it.jsonObject }.first {
            it["type"]?.jsonPrimitive?.content == PatchType.CREATE &&
                it["props"]?.jsonObject?.containsKey("color.0") == true
        }["props"]!!.jsonObject
        return label["color.0"]?.jsonPrimitive?.content to label["0"]?.jsonPrimitive?.content
    }

    @Test
    fun `each session gets its own fork, published before the first render`() = runBlocking<Unit> {
        requireNative()
        val server = themedServer()
        try {
            val alice = connect(server)
            val bob = connect(server)
            val aliceTree = alice.frames().single { it["type"]?.jsonPrimitive?.content == "initialTree" }
            assertEquals("#111111" to "Scheme: light", labelOf(aliceTree))

            server.handleMessage(alice.key, """{"type":"dispatchAction","action":"toggleTheme"}""", alice.send)

            val patch = alice.frames().last()
            assertEquals("patch", patch["type"]?.jsonPrimitive?.content, "got $patch")
            val changed = patch["patches"]!!.jsonArray.map { it.jsonObject }
                .associate { it["name"]?.jsonPrimitive?.content to it["value"]?.jsonPrimitive?.content }
            assertEquals(mapOf<String?, String?>("color.0" to "#eeeeee", "0" to "Scheme: dark"), changed, "got $patch")
            assertTrue(
                patch["patches"]!!.jsonArray.all { it.jsonObject["type"]?.jsonPrimitive?.content == PatchType.SET_PROP },
                "got $patch",
            )

            // Bob's session keeps its own preference and hears nothing.
            assertEquals(2, bob.frames().size, "ack + initialTree only; got ${bob.frames()}")

            // The preference outlives a reconnect within the session TTL.
            val sessionId = alice.sessionId
            server.handleDisconnect(alice.key)
            val back = connect(server, sessionId)
            assertEquals(sessionId, back.sessionId)
            val backTree = back.frames().single { it["type"]?.jsonPrimitive?.content == "initialTree" }
            assertEquals("#eeeeee" to "Scheme: dark", labelOf(backTree))
        } finally {
            server.shutdown()
        }
    }
}
