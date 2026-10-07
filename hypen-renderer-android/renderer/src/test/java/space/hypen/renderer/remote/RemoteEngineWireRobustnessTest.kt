package space.hypen.renderer.remote

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.device.DeviceDriver
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.DriverContext
import space.hypen.renderer.device.DriverOutcome
import space.hypen.renderer.model.InitialTreeMessage
import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchMessage
import space.hypen.renderer.model.PatchType
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * UI updates survive whatever else arrives on the socket (tester report:
 * "Kotlin: malformed messages break Android updates"):
 *
 * - the exact `initialTree` / `patch` frames the Kotlin server sent before
 *   its fix (no `state`, no `module`) still apply: `module` is informational
 *   on the client, so a server omitting it must not cost the whole batch;
 * - malformed device texts, wrong-shaped messages and unknown types in
 *   between never stop later patches, and never close a device-enabled socket
 *   below the violation threshold.
 */
class RemoteEngineWireRobustnessTest {
    private lateinit var server: MockWebServer
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        executor.shutdownNow()
    }

    private val url get() = server.url("/").toString().replace("http", "ws")

    /** Kotlin server frames as sent before the fix: `initialTree` without `state`, `patch` without `module`. */
    private val kotlinTree =
        """{"type":"initialTree","module":"Counter","patches":[{"type":"create","id":"1","elementType":"Text","props":{"0":"Count: 0"}},""" +
            """{"type":"insert","id":"1","parentId":"root"}],"revision":0,"routes":["/"]}"""

    private fun kotlinPatch(rev: Int, text: String) =
        """{"type":"patch","patches":[{"type":"setProp","id":"1","name":"0","value":"$text"}],"revision":$rev}"""

    private fun tsPatch(rev: Int, text: String) =
        """{"type":"patch","module":"Counter","patches":[{"type":"setProp","id":"1","name":"0","value":"$text"}],"revision":$rev}"""

    private val closed = AtomicReference<Int?>(null)

    private fun enqueueSocket(vararg afterHello: String) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        closed.set(code)
                        webSocket.close(code, null)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"type\":\"hello\"")) afterHello.forEach { webSocket.send(it) }
                    }
                },
            ),
        )
    }

    /** Collect [n] patch batches (or whatever arrived within the timeout). */
    private fun collect(engine: RemoteEngine, n: Int, start: () -> Unit): List<List<Patch>> = runBlocking {
        val got = Collections.synchronizedList(mutableListOf<List<Patch>>())
        val done = CountDownLatch(n)
        val job = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            engine.patches.collect {
                got += it
                done.countDown()
            }
        }
        start()
        withTimeoutOrNull(10_000) { kotlinx.coroutines.withContext(Dispatchers.IO) { done.await(10, TimeUnit.SECONDS) } }
        job.cancel()
        synchronized(got) { got.toList() }
    }

    private fun values(batches: List<List<Patch>>): List<Any?> = batches.flatten().filter { it.type == PatchType.SET_PROP }.map { it.value }

    @Test
    fun `the parser accepts initialTree and patch frames without module or state`() {
        val parser = MoshiMessageParser()
        val patch = parser.parseMessage(kotlinPatch(1, "Count: 1"))
        assertTrue("a patch without module must still parse: $patch", patch is PatchMessage)
        assertEquals("", (patch as PatchMessage).module)
        assertEquals(1, patch.patches.size)
        val tree = parser.parseMessage(kotlinTree) as InitialTreeMessage
        assertNull(tree.state)
        assertEquals("Counter", tree.module)
        val bare = parser.parseMessage("""{"type":"initialTree","patches":[],"revision":0}""")
        assertTrue(bare is InitialTreeMessage)
        // A patch batch without its patches is still refused (nothing to apply).
        assertNull(parser.parseMessage("""{"type":"patch","module":"M","revision":3}"""))
    }

    @Test
    fun `UI updates keep flowing across Kotlin-shaped frames, junk and unknown types - UI-only socket`() {
        enqueueSocket(
            """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false}""",
            kotlinTree,
            kotlinPatch(1, "Count: 1"),
            """{"type":"deviceEvent","id":1,"event":""",
            """{"type":"deviceRequest","id":1.0}""",
            """{"type":"render","route":"/x","patches":[],"routes":["/"]}""",
            """not json at all""",
            """{"type":"patch","module":"Counter","patches":[{"type":"noSuchPatchType","id":"1"}],"revision":2}""",
            """[1,2,3]""",
            tsPatch(3, "Count: 3"),
            kotlinPatch(4, "Count: 4"),
        )
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false))
        val batches = collect(engine, 4) { runBlocking { engine.connect() } }
        assertEquals(listOf("Count: 1", "Count: 3", "Count: 4"), values(batches))
        assertEquals(4, engine.getRevision())
        assertEquals("Counter", engine.getModuleName())
        assertEquals(ConnectionState.CONNECTED, engine.connectionState.value)
        engine.destroy()
    }

    @Test
    fun `malformed device messages on a device-enabled socket never stop patch application`() {
        val queried = CountDownLatch(1)
        val driver = object : DeviceDriver {
            override val capability = "permission.query"

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome {
                queried.countDown()
                return DriverOutcome.Result(mapOf("status" to "granted"))
            }
        }
        val ack = """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{"protocolVersion":1,"binary":true,""" +
            """"capabilities":[{"name":"core.capabilities","version":1},{"name":"permission.query","version":1}]}}"""
        val core = """{"type":"deviceRequest","id":1,"capability":"core.capabilities","version":1,"owner":{"connection":true},""" +
            """"lifetime":"connection","timeoutMs":86400000,"initialCredit":8,"params":{}}"""
        val query = """{"type":"deviceRequest","id":2,"capability":"permission.query","version":1,""" +
            """"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":30000,"initialCredit":0,"params":{"permission":"camera"}}"""
        enqueueSocket(
            ack,
            core,
            kotlinTree,
            // Device texts that break the JSON limits or the envelope (connection-level
            // violations, counted, fewer than the close threshold) ...
            """{"type":"deviceEvent","id":1,"event":""",
            """{"type":"deviceRequest","id":3,"id":3}""",
            """{"type":"deviceEvent","id":1.5,"control":{}}""",
            """{"type":"deviceResponse","id":77,"result":{}}""",
            // ... interleaved with UI updates in the Kotlin server's old shape.
            kotlinPatch(1, "Count: 1"),
            query,
            """{"type":"deviceEvent","id":2,"control":{"renewLease":1}}""",
            tsPatch(2, "Count: 2"),
        )
        val host = DeviceHost(DeviceHostConfig("wss://a:443"), listOf(driver), dispatcher)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        val batches = collect(engine, 3) { runBlocking { engine.connect() } }
        assertEquals(listOf("Count: 1", "Count: 2"), values(batches))
        assertTrue("device work still runs on the same socket", queried.await(10, TimeUnit.SECONDS))
        assertNull("the socket stays open", closed.get())
        assertNotNull(engine.getSessionId())
        engine.destroy()
        host.dispose()
    }
}
