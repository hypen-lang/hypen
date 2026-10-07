package space.hypen.remote.device

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.DeviceOpenResult
import uniffi.hypen_engine.DeviceOutcome
import uniffi.hypen_engine.DeviceOutput
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A thin test driver around the REAL Rust `DeviceBroker` (UniFFI via JNA) in
 * the server role: it plays the client by feeding text / frames, drains
 * `poll()` like the SDK's pump and records every output. It interprets
 * nothing itself — every protocol verdict comes from the broker.
 */
internal class BrokerDriver(configJson: String, var now: ULong = 0uL) : AutoCloseable {
    val broker = DeviceBroker(configJson, null, now)

    /** Every server → client text, parsed (lenient: the broker produced it). */
    val sent = mutableListOf<JsonObject>()
    val frames = mutableListOf<ByteArray>()
    val events = mutableListOf<Pair<UInt, JsonObject>>()
    val data = mutableMapOf<UInt, java.io.ByteArrayOutputStream>()
    val settled = mutableMapOf<UInt, DeviceOutcome>()
    var closed: DeviceOutput.CloseConnection? = null

    /** Report streamed chunks / events consumed at once (a prompt handler). */
    var consume = true

    fun drain() {
        repeat(100_000) {
            val out = broker.poll()
            if (out.isEmpty()) return
            val chunks = mutableListOf<UInt>()
            val evs = mutableListOf<UInt>()
            for (o in out) when (o) {
                is DeviceOutput.SendText -> sent += Json.parseToJsonElement(o.text).jsonObject
                is DeviceOutput.SendFrame -> frames += o.frame
                is DeviceOutput.Event -> {
                    events += o.id to Json.parseToJsonElement(o.eventJson).jsonObject
                    evs += o.id
                }
                is DeviceOutput.Data -> {
                    data.getOrPut(o.id) { java.io.ByteArrayOutputStream() }.write(o.bytes)
                    chunks += o.id
                }
                is DeviceOutput.Settled -> {
                    check(settled.put(o.id, o.outcome) == null) { "request ${o.id} settled twice" }
                }
                is DeviceOutput.CloseConnection -> {
                    check(closed == null) { "device plane closed twice" }
                    closed = o
                }
            }
            if (consume) {
                chunks.forEach { broker.consumedData(it, 1u, now) }
                evs.forEach { broker.consumedEvents(it, 1uL, now) }
            }
        }
        error("broker never drained")
    }

    fun start(): UInt = opened(broker.start(now)).also { drain() }

    fun activate(module: String = MODULE, activation: UInt = 1u): Boolean =
        (broker.ownerIsActive(module, activation) || broker.ownerActivated(module, activation, now)).also { drain() }

    fun open(spec: JsonObject, download: ByteArray? = null): DeviceOpenResult = broker.open(spec.toString(), download, now).also { drain() }

    fun onText(text: String): Boolean = broker.onText(text, now).also { drain() }

    fun onFrame(frame: ByteArray): Boolean = broker.onFrame(frame, now).also { drain() }

    fun info(): JsonObject = Json.parseToJsonElement(broker.infoJson()).jsonObject

    val connectionViolations: Long get() = info()["connectionViolations"]!!.jsonPrimitive.long

    val started: Boolean get() = info()["started"]!!.jsonPrimitive.content == "true"

    /** The effective revision (`mode`, `data`, bounds…) the broker enforces, or `null`. */
    fun revision(capability: String, version: Long): JsonObject? =
        broker.revisionJson(capability, version.toUInt())?.let { Json.parseToJsonElement(it).jsonObject }

    fun sentFor(id: UInt, type: String): List<JsonObject> = sent.filter {
        (it["type"] as? JsonPrimitive)?.content == type && (it["id"] as? JsonPrimitive)?.content == id.toString()
    }

    fun cancelsFor(id: UInt): Int = sentFor(id, "deviceEvent").count { (it["control"] as? JsonObject)?.containsKey("cancel") == true }

    fun failureCode(id: UInt): String? = (settled[id] as? DeviceOutcome.Failure)?.code

    override fun close() {
        broker.destroy()
    }

    companion object {
        const val MODULE = "conformance-module"

        fun opened(r: DeviceOpenResult): UInt = when (r) {
            is DeviceOpenResult.Opened -> r.id
            is DeviceOpenResult.Refused -> error("refused: ${r.code} ${r.detail}")
        }

        /** The canonical registry (`schema/device/registry-v1.json`). */
        val registry: JsonArray by lazy {
            DeviceFixtures.load(File(DeviceFixtures.deviceSchemas, "registry-v1.json")).jsonObject["capabilities"]!!.jsonArray
        }

        /** `sessionAck.device` selecting every registry capability at its highest revision, binary. */
        val fullAck: JsonObject by lazy {
            buildJsonObject {
                put("protocolVersion", 1)
                put("binary", true)
                put(
                    "capabilities",
                    buildJsonArray {
                        for (c in registry) {
                            val o = c.jsonObject
                            add(
                                buildJsonObject {
                                    put("name", o["name"]!!)
                                    put("version", o["revisions"]!!.jsonArray.last().jsonObject["version"]!!)
                                },
                            )
                        }
                    },
                )
            }
        }

        fun config(ack: JsonElement = fullAck, extra: Map<String, JsonElement> = emptyMap()): String =
            JsonObject(mapOf("ack" to ack) + extra).toString()

        /** A started broker (core.capabilities open) with [MODULE] activation 1 live. */
        fun started(ack: JsonElement = fullAck, extra: Map<String, JsonElement> = emptyMap()): BrokerDriver =
            BrokerDriver(config(ack, extra)).also {
                it.start()
                check(it.activate())
            }

        fun spec(capability: String, params: JsonElement, version: Long = 1, extra: Map<String, JsonElement> = emptyMap()): JsonObject =
            JsonObject(
                mapOf(
                    "capability" to JsonPrimitive(capability),
                    "version" to JsonPrimitive(version),
                    "params" to params,
                    "moduleInstanceId" to JsonPrimitive(MODULE),
                    "activationId" to JsonPrimitive(1),
                ) + extra,
            )

        /** A v1 binary frame: version 1, flags 0, channel, request id, seq, payload. */
        fun frame(id: UInt, channel: Int, seq: Int, payload: ByteArray): ByteArray =
            ByteBuffer.allocate(12 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
                .put(1).put(0).putShort(channel.toShort()).putInt(id.toInt()).putInt(seq).put(payload).array()

        fun text(type: String, id: UInt, body: Pair<String, JsonElement>): String =
            JsonObject(mapOf("type" to JsonPrimitive(type), "id" to JsonPrimitive(id.toLong()), body)).toString()
    }
}
