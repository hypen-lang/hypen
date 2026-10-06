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
 * These tests pin the config surface: on by default with or without the
 * device plane, explicitly opt-out-able, readable off the constructed server —
 * and the negotiated-extension check that keeps a context-takeover socket
 * UI-only ([PerMessageDeflate]).
 */
class HypenServerCompressionTest {

    @Test
    fun `compression defaults to enabled with the device plane on`() {
        val server = HypenServer {}
        try {
            assertTrue(server.deviceEnabled)
            assertTrue(server.compression, "expected permessage-deflate on by default")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `compression defaults to enabled on a UI-only server`() {
        val server = HypenServer { disableDevice() }
        try {
            assertTrue(server.compression, "expected permessage-deflate on by default")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `an explicit compression = true keeps the device plane on`() {
        val server = HypenServer { compression = true }
        try {
            assertTrue(server.compression)
            assertTrue(server.deviceEnabled)
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
            assertTrue(server.deviceEnabled)
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

    @Test
    fun `per-message compression - both no-context-takeover params do not share context`() {
        for (negotiated in listOf(
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
            "permessage-deflate;client_no_context_takeover;server_no_context_takeover",
            "Permessage-Deflate; SERVER_NO_CONTEXT_TAKEOVER; client_no_context_takeover; client_max_window_bits=15",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=\"15\"",
        )) {
            assertFalse(PerMessageDeflate.sharesContext(negotiated), negotiated)
        }
    }

    @Test
    fun `no compression negotiated does not share context`() {
        for (negotiated in listOf(null, "", "   ", "x-webkit-deflate-frame", "foo; server_no_context_takeover")) {
            assertFalse(PerMessageDeflate.sharesContext(negotiated), "$negotiated")
        }
    }

    @Test
    fun `context takeover in either direction shares context`() {
        for (negotiated in listOf(
            "permessage-deflate",
            "permessage-deflate; server_no_context_takeover",
            "permessage-deflate; client_no_context_takeover",
            "permessage-deflate; client_max_window_bits=15",
            // A parameter NAME must match exactly (not a substring / value).
            "permessage-deflate; server_no_context_takeover_x; client_no_context_takeover",
            "permessage-deflate; x=\"server_no_context_takeover; client_no_context_takeover\"",
            // A second element can't vouch for the permessage-deflate one.
            "permessage-deflate, foo; server_no_context_takeover; client_no_context_takeover",
        )) {
            assertTrue(PerMessageDeflate.sharesContext(negotiated), negotiated)
        }
    }
}
