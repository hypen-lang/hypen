package space.hypen.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Attach mode: an [AgentHandle] bound to a live user session drives that
 * user's engine through the guarded external surface, and the user's
 * transport receives exactly what a click would have produced.
 *
 * Three properties are pinned here, mirroring the other SDKs' attach
 * suites:
 *
 * - **wire-identical** — an attached dispatch emits one `patch` message
 *   with the next revision, shaped exactly like a renderer click's.
 * - **refusal-is-silent** — a guard refusal throws, sends nothing, and
 *   bumps no revision.
 * - **never-destroys** — the handle cannot outlive or tear down the
 *   session; once the user disconnects, it simply throws.
 *
 * Every test body is `runBlocking<Unit>`: JUnit Jupiter silently ignores
 * a `@Test` method whose return type is not `void`, and an inferred
 * `runBlocking { ... assertNotNull(x) }` returns `x`.
 */
class HypenServerAttachTest {

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

    /**
     * A one-module counter app: one declared action, one state key, one
     * bound text node so an `increment` produces a visible patch.
     */
    private fun counterServer(): HypenServer {
        app.module("Counter")
            .defineState(mapOf("count" to 0))
            .ui(
                """module Counter {
                    Column {
                        Text("Count: @{state.count}")
                        Button("@actions.increment") { Text("+") }
                    }
                }""".trimIndent()
            )
            .onAction("increment") { ctx ->
                val count = ctx.state.get("count") as? Int ?: 0
                ctx.state.set("count", count + 1)
            }
            .build()

        return HypenServer {
            module("Counter", HypenApp.get("Counter")!!)
            route("/", "Counter")
        }
    }

    /** One connected renderer: its outbound frames, its key, its session id. */
    private class Connected(
        val key: Any,
        val sent: MutableList<String>,
        val send: suspend (String) -> Unit,
        val sessionId: String
    ) {
        fun snapshot(): List<String> = synchronized(sent) { sent.toList() }
    }

    private suspend fun connect(server: HypenServer): Connected {
        val sent = mutableListOf<String>()
        val key = Any()
        val send: suspend (String) -> Unit = { msg -> synchronized(sent) { sent.add(msg) } }
        server.handleConnect(connectionKey = key, sendMessage = send)

        val ack = Json.decodeFromString<JsonObject>(synchronized(sent) { sent[0] })
        assertEquals("sessionAck", ack["type"]?.jsonPrimitive?.content)
        val sessionId = ack["sessionId"]!!.jsonPrimitive.content
        return Connected(key, sent, send, sessionId)
    }

    private fun parse(msg: String): JsonObject = Json.decodeFromString(msg)

    // ── Attach + dispatch ──────────────────────────────────────────────

    @Test
    fun `attached dispatch reaches the user's transport as one patch with revision 1`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val user = connect(server)
            val before = user.snapshot().size

            val handle = server.attach(user.sessionId)
            assertNotNull(handle, "a ready session must be attachable")
            assertEquals(user.sessionId, handle.sessionId)
            assertTrue(handle.isAlive)
            assertEquals(0L, handle.revision())

            val dispatched = mutableListOf<HypenEvents.ActionDispatched>()
            val unsubscribe = server.events().on(HypenEvents.actionDispatched) {
                synchronized(dispatched) { dispatched.add(it) }
            }

            handle.dispatch("increment")
            unsubscribe()

            val after = user.snapshot()
            assertEquals(before + 1, after.size, "exactly one frame must follow the dispatch; got $after")
            val frame = parse(after.last())
            assertEquals("patch", frame["type"]?.jsonPrimitive?.content, "got $frame")
            assertEquals(1L, frame["revision"]?.jsonPrimitive?.long, "got $frame")
            assertTrue(after.last().contains("Count: 1"), "patch must carry the new count; got ${after.last()}")

            assertEquals(1L, handle.revision())
            assertEquals(1, handle.getState(path = "count")?.jsonPrimitive?.int)

            val events = synchronized(dispatched) { dispatched.toList() }
            assertEquals(1, events.size, "one actionDispatched event; got $events")
            assertEquals(user.sessionId, events.single().moduleId)
            assertEquals("increment", events.single().actionName)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `attached dispatch is wire-identical to a renderer click`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val user = connect(server)
            val handle = server.attach(user.sessionId)!!

            // A click first, then the agent — two consecutive revisions on
            // the same session, each changing the same text node.
            server.handleMessage(
                user.key,
                """{"type":"dispatchAction","action":"increment"}""",
                user.send
            )
            handle.dispatch("increment")

            val frames = user.snapshot()
            assertEquals(3, frames.size, "ack + click patch + agent patch; got $frames")
            val click = parse(frames[1])
            val agent = parse(frames[2])

            assertEquals(click.keys, agent.keys, "same message shape")
            assertEquals("patch", click["type"]?.jsonPrimitive?.content)
            assertEquals("patch", agent["type"]?.jsonPrimitive?.content)
            assertEquals(1L, click["revision"]?.jsonPrimitive?.long)
            assertEquals(2L, agent["revision"]?.jsonPrimitive?.long)

            val clickPatches = click["patches"]!!.jsonArray
            val agentPatches = agent["patches"]!!.jsonArray
            assertEquals(clickPatches.size, agentPatches.size, "same number of patches")
            clickPatches.zip(agentPatches).forEach { (c, a) ->
                val co = c.jsonObject
                val ao = a.jsonObject
                assertEquals(co.keys, ao.keys, "same patch fields: $co vs $ao")
                for (k in co.keys) {
                    if (k == "value") continue // the only thing that differs: "Count: 1" vs "Count: 2"
                    assertEquals(co[k], ao[k], "field $k must match: $co vs $ao")
                }
            }
            assertTrue(frames[1].contains("Count: 1"), frames[1])
            assertTrue(frames[2].contains("Count: 2"), frames[2])

            // And the session is still the user's: a further click works
            // and continues the same revision sequence.
            server.handleMessage(
                user.key,
                """{"type":"dispatchAction","action":"increment"}""",
                user.send
            )
            val next = parse(user.snapshot().last())
            assertEquals(3L, next["revision"]?.jsonPrimitive?.long)
            assertEquals(3L, handle.revision())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `listActions, getState and manifest expose the declared surface`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val user = connect(server)
            val handle = server.attach(user.sessionId)!!

            val actions = handle.listActions()
            assertTrue(actions.any { it.name == "increment" && !it.builtin }, "got $actions")
            assertTrue(actions.none { it.builtin }, "no Router / .bind() declared; got $actions")

            assertEquals(0, handle.getState(path = "count")?.jsonPrimitive?.int)
            assertNull(handle.getState(module = "nope"), "unknown module reads as null")

            val manifest = Json.decodeFromString<JsonObject>(handle.manifest())
            assertTrue(manifest.isNotEmpty(), "manifest must be a JSON object; got $manifest")
            assertTrue(handle.manifest().contains("increment"), "manifest lists the declared action")
        } finally {
            server.shutdown()
        }
    }

    // ── Refusal is silent ──────────────────────────────────────────────

    @Test
    fun `a guard refusal sends nothing and bumps no revision`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val user = connect(server)
            val handle = server.attach(user.sessionId)!!
            val before = user.snapshot()

            val dispatched = mutableListOf<HypenEvents.ActionDispatched>()
            val unsubscribe = server.events().on(HypenEvents.actionDispatched) {
                synchronized(dispatched) { dispatched.add(it) }
            }

            // The internal bind primitive: a live handler exists (every
            // module registers it), and it is exactly what the guard fences.
            assertFailsWith<EngineError.ActionNotFound> {
                handle.dispatch(
                    ExternalActions.BIND_ACTION,
                    buildJsonObject { put("path", "count"); put("value", 99) }
                )
            }
            // An undeclared module action.
            assertFailsWith<EngineError.ActionNotFound> {
                handle.dispatch("decrement")
            }
            // A built-in the app never declared a backing surface for.
            assertFailsWith<EngineError.ActionNotFound> {
                handle.dispatch(ExternalActions.NAVIGATE, mapOf("to" to "/"))
            }
            unsubscribe()

            assertEquals(before, user.snapshot(), "refusals must put nothing on the wire")
            assertEquals(0L, handle.revision(), "refusals must not consume a revision")
            assertEquals(0, handle.getState(path = "count")?.jsonPrimitive?.int, "state untouched")
            assertTrue(synchronized(dispatched) { dispatched.isEmpty() }, "no actionDispatched event")

            // The session is unharmed: a real dispatch afterwards is revision 1.
            handle.dispatch("increment")
            assertEquals(1L, parse(user.snapshot().last())["revision"]?.jsonPrimitive?.long)
        } finally {
            server.shutdown()
        }
    }

    // ── Liveness / never-destroys ──────────────────────────────────────

    @Test
    fun `attach returns null for an unknown session id`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            connect(server)
            assertNull(server.attach("session-that-does-not-exist"))
            assertNull(server.attach(""))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `after the user disconnects, attach returns null and the handle throws`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val user = connect(server)
            val handle = server.attach(user.sessionId)!!
            handle.dispatch("increment")
            val pendingBefore = server.getStats()["pendingSessions"] as Int

            server.handleDisconnect(user.key)

            assertFalse(handle.isAlive)
            assertNull(server.attach(user.sessionId), "a disconnected session is not attachable")
            assertFailsWith<AgentSessionGoneException> { handle.dispatch("increment") }
            assertFailsWith<AgentSessionGoneException> { handle.listActions() }
            assertFailsWith<AgentSessionGoneException> { handle.getState(path = "count") }
            assertFailsWith<AgentSessionGoneException> { handle.revision() }
            assertFailsWith<AgentSessionGoneException> { handle.manifest() }

            // Nothing more reached the (closed) transport, and the
            // disconnect went through the server's ordinary path — the
            // session is suspended for resumption, not destroyed by us.
            val frames = user.snapshot()
            assertEquals(2, frames.size, "ack + one patch; got $frames")
            assertEquals(
                pendingBefore + 1,
                server.getStats()["pendingSessions"],
                "the session must be suspended (resumable), not destroyed"
            )
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `server shutdown invalidates the handle without touching the closed engine`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        val user = connect(server)
        val handle = server.attach(user.sessionId)!!
        assertTrue(handle.isAlive)

        server.shutdown()

        assertFalse(handle.isAlive)
        assertFailsWith<AgentSessionGoneException> { handle.dispatch("increment") }
        assertFailsWith<AgentSessionGoneException> { handle.listActions() }
        assertEquals(1, user.snapshot().size, "only the ack was ever sent")
    }

    @Test
    fun `attach selects by session id and a dispatch reaches only that session`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            // Two sessions; attach picks by id, not "the first client".
            val a = connect(server)
            val b = connect(server)
            val ha = server.attach(a.sessionId)!!
            val hb = server.attach(b.sessionId)!!
            assertEquals(a.sessionId, ha.sessionId)
            assertEquals(b.sessionId, hb.sessionId)

            ha.dispatch("increment")
            assertEquals(2, a.snapshot().size, "A got its patch")
            assertEquals(1, b.snapshot().size, "B saw nothing")

            server.handleDisconnect(a.key)
            assertNull(server.attach(a.sessionId))
            assertNotNull(server.attach(b.sessionId), "B stays attachable after A disconnects")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a session that has not finished its handshake is not attachable`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val sent = mutableListOf<String>()
            val key = Any()
            var ackSessionId: String? = null
            var midHandshake: AgentHandle? = null
            var attachedMidHandshake = false
            val send: suspend (String) -> Unit = { msg ->
                synchronized(sent) { sent.add(msg) }
                val m = parse(msg)
                if (m["type"]?.jsonPrimitive?.content == "sessionAck") {
                    // The client is already registered and its id is on the
                    // wire, but handleConnect has not returned: the session
                    // is not ready and must not be attachable yet.
                    val id = m["sessionId"]!!.jsonPrimitive.content
                    ackSessionId = id
                    midHandshake = server.attach(id)
                    attachedMidHandshake = true
                }
            }

            server.handleConnect(connectionKey = key, sendMessage = send)

            assertTrue(attachedMidHandshake, "the ack callback must have run")
            val id = assertNotNull(ackSessionId)
            assertNull(midHandshake, "a client mid-handshake must not be attachable")
            assertNotNull(server.attach(id), "the same session is attachable once the handshake completes")
        } finally {
            server.shutdown()
        }
    }

    // ── Concurrency: click vs agent ────────────────────────────────────

    /**
     * A click and an agent dispatch arrive on different coroutines. The
     * revision bump and the transport write must happen under the same
     * lock as patch collection, or the two can stamp revisions out of
     * order (or the same revision twice) — and the browser client drops
     * any `patch` whose revision is not greater than the last one applied.
     *
     * The transport parks the click's frame mid-write; the agent dispatch
     * launched meanwhile must not complete until that frame is released,
     * and the two frames must then carry revisions 1 and 2 in that order.
     */
    @Test
    fun `a concurrent click and agent dispatch never reorder or reuse a revision`() = runBlocking<Unit> {
        requireNative()
        val server = counterServer()
        try {
            val sent = mutableListOf<String>()
            val key = Any()
            val gate = CompletableDeferred<Unit>()
            val parked = CompletableDeferred<Unit>()
            val gated = AtomicBoolean(false)
            val send: suspend (String) -> Unit = { msg ->
                val isPatch = parse(msg)["type"]?.jsonPrimitive?.content == "patch"
                if (isPatch && gated.compareAndSet(false, true)) {
                    // First post-handshake frame: hold it until released.
                    parked.complete(Unit)
                    gate.await()
                }
                synchronized(sent) { sent.add(msg) }
            }
            server.handleConnect(connectionKey = key, sendMessage = send)
            val sessionId = parse(synchronized(sent) { sent[0] })["sessionId"]!!.jsonPrimitive.content
            val handle = server.attach(sessionId)!!

            val click = launch(Dispatchers.Default) {
                server.handleMessage(key, """{"type":"dispatchAction","action":"increment"}""", send)
            }
            parked.await() // the click has stamped its revision and is inside the transport write

            val agent = launch(Dispatchers.Default) { handle.dispatch("increment") }
            // Bounded wait: with the lock held across the send, the agent
            // cannot finish while the click is parked. Without it, the
            // agent stamps and sends revision 2 immediately.
            val agentFinishedWhileClickParked = withTimeoutOrNull(500) { agent.join(); true } ?: false

            gate.complete(Unit)
            click.join()
            agent.join()

            assertFalse(agentFinishedWhileClickParked, "agent dispatch must wait for the in-flight click")
            val frames = synchronized(sent) { sent.toList() }
            assertEquals(3, frames.size, "ack + click patch + agent patch; got $frames")
            val revisions = frames.drop(1).map { parse(it)["revision"]!!.jsonPrimitive.long }
            assertEquals(listOf(1L, 2L), revisions, "revisions must reach the wire in order; got $frames")
            assertTrue(frames[1].contains("Count: 1"), frames[1])
            assertTrue(frames[2].contains("Count: 2"), frames[2])
            assertEquals(2L, handle.revision())
            assertEquals(2, handle.getState(path = "count")?.jsonPrimitive?.int)
        } finally {
            server.shutdown()
        }
    }
}
