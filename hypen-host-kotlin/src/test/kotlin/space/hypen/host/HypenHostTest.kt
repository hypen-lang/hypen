// JVM integration tests for the standalone Kotlin host library. These load
// the real native library (libhypen_engine.so via JNA — see build.gradle.kts
// for the search path) and drive the real counter fixture end-to-end, so a
// green run here means the exact code path an Android app takes works:
// Kotlin → UniFFI → DualHost → wasmtime → module → wire JSON → Kotlin.

package space.hypen.host

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import uniffi.hypen_engine.HypenException

private fun fixture(name: String): ByteArray {
    val f = File("../hypen-engine-rs/tests/fixtures/$name")
    check(f.exists()) { "fixture missing: ${f.absolutePath}" }
    return f.readBytes()
}

private fun count(state: kotlinx.serialization.json.JsonElement): Long =
    state.jsonObject["count"]!!.jsonPrimitive.long

class HypenHostTest {

    @Test
    fun `reducer loop runs end to end`() {
        HypenHost.create().use { host ->
            host.register(ModuleGrants("counter"), fixture("counter_module.wasm"))
            val id = host.instantiate("counter")
            var state = host.init(id)
            assertEquals(0, count(state))

            for (expected in 1..3) {
                val out = host.dispatch(id, state, "increment")
                state = out.state!!
                assertEquals(expected.toLong(), count(state))
                assertEquals("log", out.effects.single()["type"]!!.jsonPrimitive.content)
            }
            host.destroy(id)
        }
    }

    @Test
    fun `v02 async module runs through the same host`() {
        HypenHost.create().use { host ->
            host.register(ModuleGrants("acounter"), fixture("async_counter_module.wasm"))
            val id = host.instantiate("acounter")
            val state = host.init(id, kotlinx.serialization.json.buildJsonObject {
                put("start", kotlinx.serialization.json.JsonPrimitive(7))
            })
            assertEquals(7, count(state), "declaration-site config seeds init")

            val out = host.dispatch(id, state, "increment")
            assertEquals(8, count(out.state!!))
            assertTrue("tick" in host.actions(id), "hypen:time action listed")
        }
    }

    @Test
    fun `data dir persists state across host instances`() {
        val dir = createTempDir("hypen-host-test")
        try {
            HypenHost.create(HostConfig(dataDir = dir.path)).use { host ->
                host.register(ModuleGrants("counter"), fixture("counter_module.wasm"))
                val id = host.instantiate("counter")
                var state = host.init(id)
                repeat(2) { state = host.dispatch(id, state, "increment").state!! }
                assertEquals(2, count(state))
            }
            // Second host = second app launch: warm start from the snapshot.
            HypenHost.create(HostConfig(dataDir = dir.path)).use { host ->
                host.register(ModuleGrants("counter"), fixture("counter_module.wasm"))
                val id = host.instantiate("counter")
                assertEquals(2, count(host.init(id)), "state survived the restart")
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `interpreter mode runs modules`() {
        // Pulley — the iOS-shaped configuration, proven from Kotlin too.
        HypenHost.create(HostConfig(interpreter = true)).use { host ->
            host.register(ModuleGrants("counter"), fixture("counter_module.wasm"))
            val id = host.instantiate("counter")
            val out = host.dispatch(id, host.init(id), "increment")
            assertEquals(1, count(out.state!!))
        }
    }

    @Test
    fun `http grant is enforced at instantiate`() {
        HypenHost.create().use { host ->
            host.register(
                ModuleGrants("fetcher", http = false),
                fixture("fetcher_module.wasm"),
            )
            val err = assertFailsWith<HypenException> { host.instantiate("fetcher") }
            assertTrue("http" in err.message.orEmpty(), "denial names the import: ${err.message}")
        }
    }
}
