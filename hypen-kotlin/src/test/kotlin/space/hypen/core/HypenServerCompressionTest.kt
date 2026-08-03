package space.hypen.core

import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for the `compression` (WebSocket permessage-deflate) config option.
 *
 * [HypenServer] is transport-agnostic — it never installs Ktor's `WebSockets`
 * plugin, so the flag it carries is advisory and the host application reads it
 * when wiring the socket up (see `example-server/src/main/kotlin/Sockets.kt`).
 * These tests pin the config surface: default-on, explicitly opt-out-able, and
 * readable off the constructed server.
 */
class HypenServerCompressionTest {

    @Test
    fun `compression defaults to enabled`() {
        val server = HypenServer {}
        try {
            assertTrue(server.compression, "expected permessage-deflate on by default")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `compression can be disabled for raw-wire debugging`() {
        val server = HypenServer {
            compression = false
        }
        try {
            assertFalse(server.compression, "expected compression = false to be honoured")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `compression setting is independent of other server config`() {
        val server = HypenServer {
            compression = false
            route("/counter", "Counter")
            session { ttl = 60 }
        }
        try {
            assertFalse(server.compression)
            assertTrue(server.getRoutes().any { it.path == "/counter" })
        } finally {
            server.shutdown()
        }
    }
}
