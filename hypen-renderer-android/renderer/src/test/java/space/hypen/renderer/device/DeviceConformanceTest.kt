package space.hypen.renderer.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import space.hypen.renderer.model.DeviceMalformedMessage
import space.hypen.renderer.model.DeviceWireMessage
import space.hypen.renderer.remote.DeviceJsonException
import space.hypen.renderer.remote.MoshiMessageParser
import space.hypen.renderer.remote.StrictDeviceJson
import java.io.File

/** Locates `engine-compatibility-tests/` from the Gradle test working directory. */
internal object CompatFixtures {
    val root: File by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "engine-compatibility-tests")
            if (candidate.isDirectory) return@lazy candidate
            dir = dir.parentFile
        }
        error("engine-compatibility-tests/ not found above ${File("").absolutePath}")
    }

    @Suppress("UNCHECKED_CAST")
    fun json(path: String): Map<String, Any?> = StrictDeviceJson.parseTrusted(File(root, path).readText()) as Map<String, Any?>
}

/** Text forms shared by the corpus files: `raw`, `rawHex`, `rawRepeat`, or a `message`/`value` tree. */
internal object CorpusText {
    private val parser = MoshiMessageParser()

    fun hexToBytes(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    /** The exact bytes of a case, or null for a tree form ([treeKey]). */
    fun bytesOf(case: Map<String, Any?>): ByteArray? {
        (case["raw"] as? String)?.let { return it.toByteArray(Charsets.UTF_8) }
        (case["rawHex"] as? String)?.let { return hexToBytes(it) }
        @Suppress("UNCHECKED_CAST")
        (case["rawRepeat"] as? Map<String, Any?>)?.let { r ->
            val sb = StringBuilder(r["prefix"] as String)
            val unit = r["repeat"] as String
            repeat((r["count"] as Long).toInt()) { sb.append(unit) }
            sb.append(r["suffix"] as String)
            return sb.toString().toByteArray(Charsets.UTF_8)
        }
        return null
    }

    /** A tree serialized the way the renderer serializes device JSON. */
    fun serialize(tree: Any?): String = parser.serializeMessage(DeviceWireMessage("", tree as Map<String, Any?>))
}

/**
 * Replays the shared envelope corpus
 * `engine-compatibility-tests/fixtures/device/conformance/messages.json`
 * through the renderer's real receive path — [MoshiMessageParser] (strict
 * device JSON, the RFC 001 §2.1 JSON limits of decision D4; `rawHex` cases as
 * text-frame bytes through the strict UTF-8 decoder) then [DeviceWire] — for
 * every case, none skipped: `valid` cases decode and round-trip to an equal
 * JSON value; `invalid` cases are refused. `deviceResponse` cases (client →
 * server) go through the client's own response check. The `handshake` cases
 * go through [DeviceHandshake] (hello and snapshots are what the client
 * sends; the ack is what it accepts).
 */
class DeviceConformanceTest {
    private val parser = MoshiMessageParser()
    private val corpus = CompatFixtures.json("fixtures/device/conformance/messages.json")

    private sealed class Outcome {
        data class Accepted(val body: Map<String, Any?>) : Outcome()

        data class Refused(val why: String) : Outcome()
    }

    private fun receive(bytes: ByteArray): Outcome = when (val m = parser.parseMessageBytes(bytes)) {
        null -> Outcome.Refused("unparsable or not a known message type")
        is DeviceMalformedMessage -> Outcome.Refused("malformed: ${m.detail}")
        is DeviceWireMessage -> {
            val verdict: Parsed<*> = when (m.type) {
                "deviceRequest" -> DeviceWire.parseRequest(m.body)
                "deviceEvent" -> DeviceWire.parseEvent(m.body)
                "deviceResponse" -> DeviceWire.parseResponse(m.body)
                else -> Parsed.Invalid(null, "${m.type} is not a device message")
            }
            when (verdict) {
                is Parsed.Ok -> Outcome.Accepted(m.body)
                is Parsed.Invalid -> Outcome.Refused(verdict.reason)
            }
        }
        else -> Outcome.Refused("not a device message: ${m.type}")
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> = corpus[key] as List<Map<String, Any?>>

    private fun bytesOf(case: Map<String, Any?>): ByteArray =
        CorpusText.bytesOf(case) ?: CorpusText.serialize(case["message"]).toByteArray(Charsets.UTF_8)

    @Test
    fun `every valid message decodes and round-trips`() {
        val valid = cases("valid")
        assertTrue("corpus has valid cases", valid.size >= 45)
        val failures = mutableListOf<String>()
        for (case in valid) {
            val bytes = bytesOf(case)
            when (val outcome = receive(bytes)) {
                is Outcome.Refused -> failures += "${case["name"]}: refused (${outcome.why})"
                is Outcome.Accepted -> {
                    val again = CorpusText.serialize(outcome.body)
                    if (StrictDeviceJson.parse(again) != StrictDeviceJson.parse(String(bytes, Charsets.UTF_8))) {
                        failures += "${case["name"]}: round-trip changed ${again.take(120)}"
                    }
                }
            }
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `every invalid message is refused`() {
        val invalid = cases("invalid")
        assertTrue("corpus has invalid cases", invalid.size >= 190)
        val failures = invalid.filter { receive(bytesOf(it)) is Outcome.Accepted }.map { "${it["name"]}: accepted (${it["reason"]})" }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `every handshake case is classified like the reference`() {
        val handshake = cases("handshake")
        assertTrue("corpus has handshake cases", handshake.size >= 30)
        val failures = mutableListOf<String>()
        for (case in handshake) {
            val tree: Any? = CorpusText.bytesOf(case)?.let { bytes ->
                try {
                    StrictDeviceJson.parse(StrictDeviceJson.decodeUtf8(bytes))
                } catch (e: DeviceJsonException) {
                    INVALID_TEXT
                }
            } ?: case["value"]
            val verdict = if (tree === INVALID_TEXT) {
                "JSON limits"
            } else {
                when (case["kind"]) {
                    "hello" -> DeviceHandshake.validateHello(tree)
                    "ack" -> DeviceHandshake.validateAck(tree)
                    "capabilitiesEvent" -> DeviceHandshake.validateCapabilitiesEvent(tree)
                    else -> "unknown kind ${case["kind"]}"
                }
            }
            val valid = case["valid"] == true
            if (valid != (verdict == null)) failures += "${case["name"]}: expected valid=$valid, got ${verdict ?: "valid"}"
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `JSON-limit breakers never carry an attributable id`() {
        for (text in listOf(
            """{"type":"deviceEvent","id":7,"control":{"grant":1,"grant":2}}""",
            """{"type":"deviceEvent","id":7,"control":{"grant":1.0}}""",
            """{"type":"deviceRequest","id":3,"capability":"gallery.pick","version":1,"owner":{"moduleInstanceId":"a","activationId":1},""" +
                """"lifetime":"activation","timeoutMs":1000,"initialCredit":0,"params":{"maxCount":1,"maxCount":2}}""",
        )) {
            val m = parser.parseMessage(text)
            assertTrue(text, m is DeviceMalformedMessage)
        }
        // Not JSON at all, but device-typed: still a (counted) device violation.
        assertTrue(parser.parseMessage("""{"type":"deviceEvent","id":1,"control":""") is DeviceMalformedMessage)
        // Not device-typed and not JSON: dropped.
        assertEquals(null, parser.parseMessage("""{"type":"patch","""))
    }

    @Test
    fun `number tokens are integers or refused`() {
        assertEquals(1L, StrictDeviceJson.parse("1"))
        assertEquals(-5L, StrictDeviceJson.parse("-5"))
        assertEquals(9_007_199_254_740_991L, StrictDeviceJson.parse("9007199254740991"))
        for (bad in listOf("1.0", "1e0", "-0", "01", "+1", "9007199254740992", "12345678901234567", "NaN", "True")) {
            assertTrue(bad, runCatching { StrictDeviceJson.parse(bad) }.exceptionOrNull() is DeviceJsonException)
        }
    }

    @Test
    fun `nesting is bounded at 32 containers`() {
        fun nested(n: Int) = "[".repeat(n) + "]".repeat(n)
        assertTrue(StrictDeviceJson.parse(nested(32)) is List<*>)
        assertTrue(runCatching { StrictDeviceJson.parse(nested(33)) }.exceptionOrNull() is DeviceJsonException)
        val m = parser.parseMessage("""{"type":"deviceEvent","id":4,"event":{"x":${nested(32)}}}""")
        assertTrue(m is DeviceMalformedMessage) // envelope + event + 32 arrays = 34
    }

    private companion object {
        val INVALID_TEXT = Any()
    }
}

/**
 * Replays `fixtures/device/conformance/payloads.json` (every case) through
 * [DevicePayloads]: the per-revision params/result/event validator the
 * DeviceHost applies to inbound params and to its own outbound results and
 * events.
 */
class DevicePayloadsConformanceTest {
    @Test
    fun `every payload case is classified like the reference`() {
        @Suppress("UNCHECKED_CAST")
        val cases = CompatFixtures.json("fixtures/device/conformance/payloads.json")["cases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 120)
        val failures = mutableListOf<String>()
        for (case in cases) {
            val kind = PayloadKind.valueOf((case["kind"] as String).uppercase())
            val verdict = DevicePayloads.validate(case["capability"] as String, case["version"] as Long, kind, case["value"])
            val valid = case["valid"] == true
            if (valid != (verdict == null)) failures += "${case["name"]}: expected valid=$valid, got ${verdict ?: "valid"}"
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }
}

/**
 * Replays `fixtures/device/conformance/selection.json` on the client side
 * (RFC 001 §2.2, decision D7): a hello that fails handshake-v1 is never sent
 * ([DeviceHandshake.validateHello]); for every valid hello, the reference
 * selection is accepted against exactly that hello with nothing dropped, and
 * yields exactly the expected `(name, version)` pairs and `binary`.
 */
class DeviceSelectionConformanceTest {
    @Test
    fun `the client accepts every reference selection against the hello it sent`() {
        @Suppress("UNCHECKED_CAST")
        val cases = CompatFixtures.json("fixtures/device/conformance/selection.json")["cases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 20)
        val failures = mutableListOf<String>()
        var accepted = 0
        var invalidHellos = 0
        for (case in cases) {
            @Suppress("UNCHECKED_CAST")
            val hello = case["hello"] as Map<String, Any?>
            val helloProblem = DeviceHandshake.validateHello(hello)
            @Suppress("UNCHECKED_CAST")
            val expect = case["expect"] as Map<String, Any?>?
            if (helloProblem != null) {
                invalidHellos += 1
                if (expect != null) failures += "${case["name"]}: invalid hello ($helloProblem) but the reference selected"
                continue
            }
            if (expect == null) continue // the server disables device: the ack carries no device
            when (val outcome = DeviceHandshake.accept(expect, hello)) {
                is AckOutcome.Disabled -> failures += "${case["name"]}: disabled (${outcome.reason})"
                is AckOutcome.Selected -> {
                    accepted += 1
                    @Suppress("UNCHECKED_CAST")
                    val pairs = (expect["capabilities"] as List<Map<String, Any?>>).associate { it["name"] as String to it["version"] as Long }
                    if (outcome.dropped.isNotEmpty()) failures += "${case["name"]}: dropped ${outcome.dropped}"
                    if (outcome.selection.capabilities != pairs) failures += "${case["name"]}: selection ${outcome.selection.capabilities} != $pairs"
                    if (outcome.selection.binary != expect["binary"]) failures += "${case["name"]}: binary ${outcome.selection.binary}"
                    if (outcome.selection.protocolVersion != expect["protocolVersion"]) failures += "${case["name"]}: protocol"
                }
            }
        }
        assertTrue("accepted $accepted", accepted >= 10)
        assertTrue("invalid hellos $invalidHellos", invalidHellos >= 5)
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `an ack naming something the hello never offered drops it, a missing core disables`() {
        val hello = mapOf(
            "protocolVersions" to listOf(1L),
            "binary" to true,
            "capabilities" to listOf(mapOf("name" to "core.capabilities", "versions" to listOf(1L)), mapOf("name" to "gallery.pick", "versions" to listOf(1L))),
        )
        val ack = mapOf(
            "protocolVersion" to 1L,
            "binary" to true,
            "capabilities" to listOf(
                mapOf("name" to "core.capabilities", "version" to 1L),
                mapOf("name" to "gallery.pick", "version" to 1L),
                mapOf("name" to "file.save", "version" to 1L),
            ),
        )
        val outcome = DeviceHandshake.accept(ack, hello) as AckOutcome.Selected
        assertEquals(mapOf("core.capabilities" to 1L, "gallery.pick" to 1L), outcome.selection.capabilities)
        assertEquals(listOf("file.save@1 (not offered)"), outcome.dropped)
        val noCore = ack + ("capabilities" to listOf(mapOf("name" to "gallery.pick", "version" to 1L)))
        assertTrue(DeviceHandshake.accept(noCore, hello) is AckOutcome.Disabled)
        val otherProtocol = ack + ("protocolVersion" to 2L)
        assertTrue(DeviceHandshake.accept(otherProtocol, hello) is AckOutcome.Disabled)
    }
}

/**
 * Pins [DeviceRegistry] and the envelope bounds in [DeviceProtocol]
 * field-for-field to the exported registry
 * `engine-compatibility-tests/schema/device/registry-v1.json` (generated
 * from the Rust declarations), so the Android copy cannot drift.
 */
class DeviceRegistryPinTest {
    private val registry = CompatFixtures.json("schema/device/registry-v1.json")

    @Suppress("UNCHECKED_CAST")
    private val exported: Map<Pair<String, Long>, Map<String, Any?>> by lazy {
        val out = LinkedHashMap<Pair<String, Long>, Map<String, Any?>>()
        for (cap in registry["capabilities"] as List<Map<String, Any?>>) {
            for (rev in cap["revisions"] as List<Map<String, Any?>>) {
                out[cap["name"] as String to rev["version"] as Long] = rev
            }
        }
        out
    }

    private fun wire(e: Enum<*>): String {
        val parts = e.name.lowercase().split('_')
        return parts.first() + parts.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercase) }
    }

    @Test
    fun `registry matches registry-v1 json exactly`() {
        assertEquals(DeviceProtocol.PROTOCOL_VERSIONS.single(), registry["protocolVersion"])
        assertEquals(exported.keys, DeviceRegistry.all.keys)
        val fields = setOf(
            "version", "mode", "data", "consent", "lifetimes", "maxItemBytes", "maxItems",
            "maxInitialCredit", "maxOutstandingCredit", "maxTimeoutMs", "overflow",
        )
        for ((key, rev) in exported) {
            val mine = DeviceRegistry.all.getValue(key)
            assertEquals("$key: exported fields (update CapabilityRevision)", fields, rev.keys)
            val expected = mapOf(
                "version" to mine.version,
                "mode" to wire(mine.mode),
                "data" to wire(mine.data),
                "consent" to wire(mine.consent),
                "lifetimes" to mine.lifetimes.map { it.wireName },
                "maxItemBytes" to mine.maxItemBytes,
                "maxItems" to mine.maxItems.toLong(),
                "maxInitialCredit" to mine.maxInitialCredit,
                "maxOutstandingCredit" to mine.maxOutstandingCredit,
                "maxTimeoutMs" to mine.maxTimeoutMs,
                "overflow" to wire(mine.overflow),
            )
            assertEquals("$key", expected, rev)
        }
    }

    @Test
    fun `envelope bounds are the registry maxima and match envelope-v1 schema`() {
        val revs = DeviceRegistry.all.values
        assertEquals(revs.maxOf { it.maxTimeoutMs }, DeviceProtocol.MAX_TIMEOUT_MS)
        assertEquals(revs.maxOf { it.maxInitialCredit }, DeviceProtocol.MAX_INITIAL_CREDIT)
        assertEquals(revs.maxOf { it.maxOutstandingCredit }, DeviceProtocol.MAX_GRANT)

        @Suppress("UNCHECKED_CAST")
        val defs = CompatFixtures.json("schema/device/envelope-v1.schema.json")["\$defs"] as Map<String, Map<String, Any?>>

        @Suppress("UNCHECKED_CAST")
        fun prop(def: String, name: String) = (defs.getValue(def)["properties"] as Map<String, Map<String, Any?>>).getValue(name)
        assertEquals(DeviceProtocol.MAX_TIMEOUT_MS, prop("deviceRequest", "timeoutMs")["maximum"])
        assertEquals(DeviceProtocol.MAX_INITIAL_CREDIT, prop("deviceRequest", "initialCredit")["maximum"])
        assertEquals(DeviceProtocol.MAX_CAPABILITY_NAME.toLong(), prop("deviceRequest", "capability")["maxLength"])

        @Suppress("UNCHECKED_CAST")
        val grant = ((defs.getValue("control")["oneOf"] as List<Map<String, Any?>>).first { "grant" in (it["properties"] as Map<*, *>) }["properties"] as Map<String, Map<String, Any?>>).getValue("grant")
        assertEquals(DeviceProtocol.MAX_GRANT, grant["maximum"])
    }
}
