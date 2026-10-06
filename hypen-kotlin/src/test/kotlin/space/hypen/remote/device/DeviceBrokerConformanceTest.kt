package space.hypen.remote.device

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import uniffi.hypen_engine.DeviceBindingException
import uniffi.hypen_engine.DeviceOpenResult
import uniffi.hypen_engine.DeviceOutcome
import uniffi.hypen_engine.deviceFileSaveParamsJson
import uniffi.hypen_engine.deviceSelectAck
import uniffi.hypen_engine.deviceSha256Hex
import uniffi.hypen_engine.deviceValidateAck
import uniffi.hypen_engine.deviceValidateHello
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The shared conformance corpora (`fixtures/device/conformance/`) replayed
 * through the ONE protocol implementation — the Rust engine, via the
 * generated UniFFI bindings — exactly as the Kotlin server reaches it. The
 * SDK has no decoder, validator or negotiator of its own to test; what is
 * checked here is that every verdict the corpora pin is what the broker /
 * negotiation the SDK ships actually does:
 *
 * - `selection.json`: `deviceSelectAck` gives exactly the expected ack (or
 *   none); `handshake` cases: `deviceValidateHello` / `deviceValidateAck`,
 *   and `capabilitiesEvent` snapshots fed to a live broker's
 *   `core.capabilities` stream (invalid ⇒ the broker cancels it and closes
 *   the plane);
 * - `payloads.json` through a live broker: params at `open` (invalid ⇒
 *   refused locally, nothing sent), results as the client's terminal
 *   (valid ⇒ the handler's success; invalid ⇒ `invalidParams` + never
 *   delivered), events on a live request of that revision (invalid ⇒ the
 *   request terminates `invalidParams`);
 * - `messages.json` through a live broker: every invalid case is rejected —
 *   counted as a connection-level violation (JSON limits, no attributable
 *   id) or, attributed to a live id (the corpus uses 17 and 1), terminates
 *   that request; no valid case is ever a connection-level violation. The
 *   envelope's exact decode/round-trip verdicts are the Rust decoder's own
 *   corpus test (`hypen-engine-rs/tests/test_device_conformance.rs`).
 *
 * A missing fixture fails; it never skips.
 */
class DeviceBrokerConformanceTest {
    private fun corpus(name: String): JsonObject {
        val file = File(DeviceFixtures.deviceFixtures, "conformance/$name")
        check(file.isFile) { "shared fixture ${file.absolutePath} is required" }
        return DeviceFixtures.load(file).jsonObject
    }

    private fun JsonObject.cases(key: String): List<JsonObject> =
        (this[key] as? JsonArray)?.map { it.jsonObject }?.also { check(it.isNotEmpty()) { "no $key cases" } }
            ?: fail("corpus has no $key array")

    private fun JsonObject.name(): String = this["name"]!!.jsonPrimitive.content

    private fun JsonObject.str(key: String): String = this[key]!!.jsonPrimitive.content

    // ---- selection + handshake ---------------------------------------------------

    @TestFactory
    fun selection(): Collection<DynamicTest> {
        val cases = corpus("selection.json").cases("cases")
        assertEquals(cases.size, cases.map { it.name() }.toSet().size, "duplicate case names")
        assertTrue(cases.size >= 28, "selection cases missing")
        return cases.map { case ->
            DynamicTest.dynamicTest(case.name()) {
                val protocols = (case["serverProtocolVersions"] as? JsonArray)?.map { it.jsonPrimitive.long.toUInt() } ?: listOf(1u)
                val ack = deviceSelectAck(
                    case["hello"]!!.toString(),
                    protocols,
                    case["serverCapabilities"]!!.toString(),
                    case["serverBinary"]!!.jsonPrimitive.boolean,
                )
                val expect = case["expect"]
                if (expect == null || expect is JsonNull) {
                    assertNull(ack, "expected device access disabled")
                } else {
                    assertEquals(expect, Json.parseToJsonElement(assertNotNull(ack, "expected an ack")), "selection mismatch")
                    // What negotiation selects always passes the strict ack decoder.
                    deviceValidateAck(ack)
                }
                // D7: a hello the strict decoder refuses never selects anything.
                val helloOk = runCatching { deviceValidateHello(case["hello"]!!.toString()) }.isSuccess
                if (!helloOk) assertNull(ack, "an invalid hello must disable device access")
            }
        }
    }

    @TestFactory
    fun handshake(): Collection<DynamicTest> {
        val cases = corpus("messages.json").cases("handshake")
        assertEquals(cases.size, cases.map { it.name() }.toSet().size, "duplicate case names")
        assertTrue(cases.size >= 25, "handshake cases missing")
        return cases.map { case ->
            DynamicTest.dynamicTest(case.name()) {
                val expect = case["valid"]!!.jsonPrimitive.boolean
                val bytes = DeviceFixtures.caseBytes(case)
                val text = if (bytes != null) {
                    DeviceFixtures.utf8OrNull(bytes) ?: return@dynamicTest assertFalse(expect, "non-UTF-8 text never reaches the engine")
                } else {
                    case["value"]!!.toString()
                }
                when (val kind = case.str("kind")) {
                    "hello", "ack" -> {
                        val got = runCatching { if (kind == "hello") deviceValidateHello(text) else deviceValidateAck(text) }
                        assertEquals(expect, got.isSuccess, "verdict: ${got.exceptionOrNull()?.message}")
                        got.exceptionOrNull()?.let { assertTrue(it is DeviceBindingException, "got $it") }
                        // A valid value decodes to itself (no normalization drift).
                        if (expect && bytes == null) assertEquals(case["value"], Json.parseToJsonElement(got.getOrThrow()))
                    }
                    "capabilitiesEvent" -> BrokerDriver.started().use { d ->
                        val core = assertNotNull(d.broker.coreStreamId())
                        d.onText("""{"type":"deviceEvent","id":$core,"event":$text}""")
                        if (expect) {
                            assertEquals(0, d.cancelsFor(core), "a valid snapshot is never a violation")
                            d.closed?.let { assertTrue(it.reason.endsWith("core.capabilities withdrawn"), "only withdrawing core closes the plane: ${it.reason}") }
                        } else {
                            assertEquals(1, d.cancelsFor(core), "an invalid snapshot is a known-id violation of the core stream")
                            assertNotNull(d.closed, "an invalid snapshot closes the device plane")
                        }
                    }
                    else -> fail("kind $kind")
                }
            }
        }
    }

    // ---- payloads ------------------------------------------------------------------

    /** Valid params the broker opens for a capability (upload / stream plumbing for result and event cases). */
    private fun paramsFor(capability: String, contentType: String? = null): JsonObject = when (capability) {
        "gallery.pick" -> buildJsonObject {
            put("mediaTypes", Json.parseToJsonElement("""["photo","video"]"""))
            put("maxCount", 16)
        }
        "file.pick" -> buildJsonObject {
            put("accept", Json.parseToJsonElement("""["*/*"]"""))
            put("maxCount", 16)
        }
        "camera.capture" -> CameraCaptureParams(if (contentType?.startsWith("video/") == true) CaptureMode.VIDEO else CaptureMode.PHOTO).toJson()
        "mic.record" -> MicRecordParams(16_000, MicFormat.PCM16).toJson()
        "permission.query", "permission.request" -> PermissionParams(Permission.CAMERA).toJson()
        "bluetooth.select" -> BluetoothSelectParams().toJson()
        "bluetooth.scan" -> BluetoothScanParams.toJson()
        else -> fail("no params for $capability")
    }

    /** Open a live request of [capability] (file.save with a matching [download]). */
    private fun BrokerDriver.openLive(capability: String, contentType: String? = null, download: ByteArray = ByteArray(11) { 7 }): UInt {
        val r = if (capability == "file.save") {
            val params = Json.parseToJsonElement(deviceFileSaveParamsJson("f.bin", "application/octet-stream", download))
            open(BrokerDriver.spec(capability, params), download)
        } else {
            open(BrokerDriver.spec(capability, paramsFor(capability, contentType)))
        }
        return BrokerDriver.opened(r)
    }

    private fun itemsOf(value: JsonElement): List<JsonObject>? {
        val o = value as? JsonObject ?: return null
        return when {
            o["items"] is JsonArray -> o["items"]!!.jsonArray.map { it as? JsonObject ?: return null }
            o["item"] is JsonObject -> listOf(o["item"]!!.jsonObject)
            else -> emptyList()
        }
    }

    /**
     * Stream one announced item of [size] bytes to live request [id] within
     * the broker's credit; the actual SHA-256 of what was sent.
     */
    private fun BrokerDriver.upload(id: UInt, item: JsonObject, size: Long): String {
        val channel = item["channel"]!!.jsonPrimitive.long.toInt()
        onText(
            buildJsonObject {
                put("type", "deviceEvent")
                put("id", id.toLong())
                put(
                    "event",
                    buildJsonObject {
                        put("kind", "blobStart")
                        put("channel", channel)
                        put("contentType", item["contentType"]!!)
                    },
                )
            }.toString(),
        )
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        var sent = 0L
        var seq = 0
        while (sent < size) {
            val credit = broker.outstandingCredit(id)?.toLong() ?: fail("request $id ended while uploading: ${settled[id]}")
            assertTrue(credit > 0, "the broker starved the upload at $sent/$size bytes")
            val n = minOf(65_536L, size - sent, credit).toInt()
            val chunk = ByteArray(n) { ((sent + it) * 31 % 251).toByte() }
            digest.update(chunk)
            onFrame(BrokerDriver.frame(id, channel, seq++, chunk))
            sent += n
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    @TestFactory
    fun payloads(): Collection<DynamicTest> {
        val cases = corpus("payloads.json").cases("cases")
        assertEquals(cases.size, cases.map { it.name() }.toSet().size, "duplicate case names")
        assertTrue(cases.size >= 270, "payload cases missing")
        return cases.map { case ->
            DynamicTest.dynamicTest(case.name()) {
                val capability = case.str("capability")
                val version = case["version"]!!.jsonPrimitive.long
                val value = case["value"]!!
                val valid = case["valid"]!!.jsonPrimitive.boolean
                BrokerDriver.started().use { d ->
                    when (case.str("kind")) {
                        "params" -> checkParams(d, capability, version, value, valid)
                        "result" -> checkResult(d, capability, value, valid)
                        "event" -> checkEvent(d, capability, value, valid)
                        else -> fail("kind ${case.str("kind")}")
                    }
                }
            }
        }
    }

    private fun checkParams(d: BrokerDriver, capability: String, version: Long, value: JsonElement, valid: Boolean) {
        if (capability == "core.capabilities") {
            // Only the broker opens the control stream; the params it sends are the valid ones.
            val core = assertNotNull(d.broker.coreStreamId())
            val emitted = d.sentFor(core, "deviceRequest").single()["params"]
            assertEquals(valid, emitted == value, "core.capabilities params: the broker emits exactly the valid value")
            val refused = d.open(BrokerDriver.spec(capability, value, version))
            assertTrue(refused is DeviceOpenResult.Refused, "application code never opens core.capabilities")
            return
        }
        val download = if (capability == "file.save") ByteArray(1) else null
        val sentBefore = d.sent.size
        val r = d.open(BrokerDriver.spec(capability, value, version), download)
        if (valid) {
            when (r) {
                is DeviceOpenResult.Opened -> assertEquals(1, d.sentFor(r.id, "deviceRequest").size)
                is DeviceOpenResult.Refused -> {
                    // file.save params must also describe the actual download bytes.
                    assertEquals("file.save", capability, "valid params refused: ${r.code} ${r.detail}")
                    assertTrue(r.detail?.startsWith("params.") == true, "not a schema refusal: ${r.detail}")
                }
            }
        } else {
            val refusal = r as? DeviceOpenResult.Refused ?: fail("invalid params were sent: $value")
            val registryRevision = d.revision(capability, version) != null
            assertEquals(if (registryRevision) "invalidParams" else "unsupported", refusal.code, "${refusal.detail}")
            assertEquals(sentBefore, d.sent.size, "a refusal sends nothing")
        }
    }

    private fun checkResult(d: BrokerDriver, capability: String, value: JsonElement, valid: Boolean) {
        if (capability == "core.capabilities") {
            // Any terminal on the live control stream — valid or not — ends
            // the device plane (the stream is connection-owned: nothing is
            // settled to a handler, and no cancel follows the client's own
            // terminal). The corpus verdict itself is the Rust decoder's.
            val core = assertNotNull(d.broker.coreStreamId())
            d.onText("""{"type":"deviceResponse","id":$core,"result":$value}""")
            assertTrue(d.closed?.reason?.endsWith("core.capabilities ended") == true, "${d.closed}")
            assertEquals(0, d.cancelsFor(core))
            assertNull(d.settled[core])
            return
        }
        val items = itemsOf(value).orEmpty()
        val contentType = items.firstOrNull()?.get("contentType")?.let { (it as? JsonPrimitive)?.content }
        val id = d.openLive(capability, contentType)
        var result = value
        if (capability == "file.save") {
            // The client grants after consent; the broker sends the whole download.
            d.onText("""{"type":"deviceEvent","id":$id,"control":{"grant":1048576}}""")
            assertTrue(d.frames.isNotEmpty(), "the broker sent the download within the grant")
        }
        if (valid && items.isNotEmpty()) {
            // Stream the announced bytes; the corpus hash stands for bytes it
            // does not carry, so the harness reports the actual one.
            val actual = items.map { item -> item to d.upload(id, item, item["bytes"]!!.jsonPrimitive.long) }
            result = rewriteItems(value.jsonObject, actual.associate { (i, sha) -> i to sha })
        }
        d.onText("""{"type":"deviceResponse","id":$id,"result":$result}""")
        val outcome = d.settled[id] ?: fail("the terminal did not settle $id")
        if (valid) {
            val ok = outcome as? DeviceOutcome.Success ?: fail("valid result refused: $outcome")
            assertEquals(result, Json.parseToJsonElement(ok.resultJson), "the handler sees the validated result")
            decodeTyped(capability, ok)
        } else {
            assertEquals("invalidParams", (outcome as? DeviceOutcome.Failure)?.code, "invalid result reached the handler: $outcome")
            assertEquals(0, d.cancelsFor(id), "no cancel after the client's own terminal")
        }
        d.data.clear()
    }

    /** The SDK's typed result classes decode every broker-validated result (plain kotlinx). */
    private fun decodeTyped(capability: String, ok: DeviceOutcome.Success) {
        val r = Json.parseToJsonElement(ok.resultJson).jsonObject
        val blobs = ok.blobs.map { VerifiedBlob(it.channel.toInt(), it.name, it.contentType, it.bytes) }
        when (capability) {
            "permission.query" -> Capability.PERMISSION_QUERY.decode(r, blobs)
            "permission.request" -> Capability.PERMISSION_REQUEST.decode(r, blobs)
            "bluetooth.select" -> Capability.BLUETOOTH_SELECT.decode(r, blobs)
            "gallery.pick" -> assertEquals(r["items"]!!.jsonArray.size, Capability.GALLERY_PICK.decode(r, blobs).size)
            "file.pick" -> assertEquals(r["items"]!!.jsonArray.size, Capability.FILE_PICK.decode(r, blobs).size)
            "camera.capture" -> Capability.CAMERA_CAPTURE.decode(r, blobs)
            "mic.record" -> Capability.MIC_RECORD.decodeResult(r)
            "bluetooth.scan" -> Capability.BLUETOOTH_SCAN.decodeResult(r)
            "file.save" -> DeviceJson.decode(FileSaveResult.serializer(), r)
            else -> fail("no typed result for $capability")
        }
    }

    private fun rewriteItems(result: JsonObject, sha: Map<JsonObject, String>): JsonObject {
        fun patch(item: JsonObject) = JsonObject(item + ("sha256" to JsonPrimitive(sha.getValue(item))))
        return JsonObject(
            result.mapValues { (k, v) ->
                when (k) {
                    "items" -> JsonArray(v.jsonArray.map { patch(it.jsonObject) })
                    "item" -> patch(v.jsonObject)
                    else -> v
                }
            },
        )
    }

    private fun checkEvent(d: BrokerDriver, capability: String, value: JsonElement, valid: Boolean) {
        if (capability == "core.capabilities") {
            val core = assertNotNull(d.broker.coreStreamId())
            d.onText("""{"type":"deviceEvent","id":$core,"event":$value}""")
            assertEquals(if (valid) 0 else 1, d.cancelsFor(core))
            if (!valid) assertNotNull(d.closed)
            return
        }
        val contentType = ((value as? JsonObject)?.get("contentType") as? JsonPrimitive)?.content
        val id = d.openLive(capability, contentType)
        d.onText("""{"type":"deviceEvent","id":$id,"event":$value}""")
        if (valid) {
            assertTrue(d.broker.isLive(id), "a valid event never ends the request: ${d.settled[id]}")
            assertEquals(0, d.cancelsFor(id))
            // Capability events reach the handler; blobStart / progress are the broker's.
            val kind = ((value as? JsonObject)?.get("kind") as? JsonPrimitive)?.content
            if (kind == null) {
                val delivered = d.events.single { it.first == id }.second
                assertEquals(value, delivered)
                assertNotNull(Capability.BLUETOOTH_SCAN.decodeEvent(delivered), "the typed event decodes")
            } else {
                assertTrue(d.events.none { it.first == id }, "$kind is not delivered to the handler")
            }
        } else {
            assertEquals("invalidParams", d.failureCode(id), "invalid event: ${d.settled[id]}")
            assertEquals(1, d.cancelsFor(id), "the server's reaction is one cancel")
            assertTrue(d.events.none { it.first == id }, "an invalid event is never delivered")
        }
    }

    // ---- envelope messages -----------------------------------------------------------

    @TestFactory
    fun messages(): Collection<DynamicTest> {
        val doc = corpus("messages.json")
        val names = (doc.cases("valid") + doc.cases("invalid")).map { it.name() }
        assertEquals(names.size, names.toSet().size, "duplicate case names")
        var textCases = 0
        var requestLevel = 0
        var connectionLevel = 0
        val tests = (doc.cases("valid").map { true to it } + doc.cases("invalid").map { false to it }).map { (valid, case) ->
            val bytes = DeviceFixtures.caseBytes(case)
            if (bytes != null) textCases++
            DynamicTest.dynamicTest("${if (valid) "valid" else "invalid"}/${case.name()}") {
                val text = if (bytes != null) {
                    // A WebSocket text frame is UTF-8: anything else never reaches the host.
                    DeviceFixtures.utf8OrNull(bytes) ?: return@dynamicTest assertFalse(valid, "valid text must be UTF-8")
                } else {
                    case["message"]!!.toString()
                }
                BrokerDriver.started().use { d ->
                    // Make the corpus ids live: 1 is the control stream, 17 an ordinary request.
                    val core = assertNotNull(d.broker.coreStreamId())
                    assertEquals(1u, core)
                    var last = core
                    while (last < 17u) last = d.openLive("permission.query")
                    val violations = d.connectionViolations
                    d.onText(text)
                    val counted = d.connectionViolations > violations
                    if (valid) {
                        assertFalse(counted, "a valid message is never a connection-level violation")
                        assertNull(d.closed?.takeIf { it.reason == "repeated protocol violations" })
                        return@dynamicTest
                    }
                    val terminated = listOf(core, 17u).filter { id -> d.cancelsFor(id) > 0 || d.failureCode(id) == "invalidParams" }
                    assertTrue(counted || terminated.isNotEmpty(), "${case.str("reason")}: accepted by the broker")
                    assertFalse(counted && terminated.isNotEmpty(), "a violation is either connection- or request-level")
                    if (counted) connectionLevel++ else requestLevel++
                    for (id in terminated) {
                        if (id == core) assertNotNull(d.closed, "a violated core stream closes the plane")
                        else assertEquals("invalidParams", d.failureCode(id))
                    }
                }
            }
        }
        val floor = DynamicTest.dynamicTest("corpus floors") {
            assertTrue(doc.cases("valid").size >= 56 && doc.cases("invalid").size >= 199, "corpus shrank")
            assertTrue(textCases >= 80, "JSON-limit text cases missing: $textCases")
            assertTrue(connectionLevel >= 80, "connection-level rejections: $connectionLevel")
            assertTrue(requestLevel >= 80, "known-id rejections: $requestLevel")
        }
        return tests + floor
    }

    // ---- coverage ------------------------------------------------------------------------

    /**
     * Every registry revision has payload coverage (valid and invalid
     * `params` and `result` cases), and the permission revisions' valid
     * names are exactly the SDK's closed [Permission] enum (round-3 P1) —
     * each of which the broker opens.
     */
    @Test
    fun `payload corpus covers every registry revision and the permission enum`() {
        val cases = corpus("payloads.json").cases("cases")
        fun has(cap: String, version: Long, kind: String, valid: Boolean) = cases.any {
            it.str("capability") == cap && it["version"]!!.jsonPrimitive.long == version &&
                it.str("kind") == kind && it["valid"]!!.jsonPrimitive.boolean == valid
        }
        for (decl in BrokerDriver.registry) {
            val name = decl.jsonObject.str("name")
            for (rev in decl.jsonObject["revisions"]!!.jsonArray) {
                val version = rev.jsonObject["version"]!!.jsonPrimitive.long
                for (kind in listOf("params", "result")) {
                    for (valid in listOf(true, false)) {
                        assertTrue(has(name, version, kind, valid), "$name@$version: no ${if (valid) "valid" else "invalid"} $kind case")
                    }
                }
            }
        }
        for (cap in listOf("permission.query", "permission.request")) {
            val valid = cases
                .filter { it.str("capability") == cap && it.str("kind") == "params" && it["valid"]!!.jsonPrimitive.boolean }
                .map { it["value"]!!.jsonObject.str("permission") }
                .toSet()
            assertEquals(Permission.entries.map { it.wireName }.toSet(), valid, "$cap: valid permission names")
            BrokerDriver.started().use { d ->
                for (p in Permission.entries) {
                    assertTrue(d.open(BrokerDriver.spec(cap, PermissionParams(p).toJson())) is DeviceOpenResult.Opened, "$cap $p")
                }
            }
        }
    }

    @Test
    fun `a streamed upload hash is verified by the broker, not the corpus`() {
        // Regression guard for the result replay above: a declared hash that
        // does not match the streamed bytes is refused.
        BrokerDriver.started().use { d ->
            val id = d.openLive("gallery.pick")
            val item = buildJsonObject {
                put("channel", 0)
                put("contentType", "image/jpeg")
                put("bytes", 17)
            }
            val actual = d.upload(id, item, 17)
            val wrong = deviceSha256Hex(ByteArray(17))
            assertTrue(actual != wrong)
            d.onText("""{"type":"deviceResponse","id":$id,"result":{"items":[${JsonObject(item + ("sha256" to JsonPrimitive(wrong)))}]}}""")
            assertEquals("invalidParams", d.failureCode(id))
        }
    }
}
