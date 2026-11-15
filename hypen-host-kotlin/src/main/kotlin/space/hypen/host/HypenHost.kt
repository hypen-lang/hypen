// Idiomatic Kotlin wrapper over the UniFFI HypenModuleHost — the standalone
// module-host library for Android/JVM. Renderers stay pure patch consumers;
// this is the piece that RUNS modules (WASM components) on-device: v0.1
// sync and v0.2 CM-async ABIs behind one object (DualHost sniffing), the
// full capability set (manifest-gated storage / cross-module state / http,
// hypen:time), persistent storage via dataDir, and Pulley interpreter mode
// for JIT-forbidden platforms.
//
// The FFI convention is JSON strings; this wrapper keeps that visible but
// typed at the edges (kotlinx.serialization JsonElement), so apps never
// hand-assemble wire strings.

package space.hypen.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import uniffi.hypen_engine.HypenModuleHost

/** Host construction options. */
data class HostConfig(
    /** Max linear memory per module instance, bytes. Engine default: 256 MiB. */
    val maxMemoryBytes: Long? = null,
    /** Wall-clock budget per module call, ms. Engine default: 5000. */
    val maxCallMs: Long? = null,
    /**
     * Run modules on the Pulley interpreter instead of JIT. Required on iOS;
     * on Android JIT is allowed and faster — leave false.
     */
    val interpreter: Boolean = false,
    /**
     * Directory for persistent local/app storage (JSON snapshots). Pass the
     * app's files dir (e.g. `context.filesDir.path + "/hypen"`) so module
     * state survives process restarts. Null = in-memory.
     */
    val dataDir: String? = null,
)

/** A module's capability manifest — the declare→grant→enforce contract. */
data class ModuleGrants(
    val name: String,
    /** Storage scopes: "local" is always granted; list "app"/"cloud" to grant. */
    val storage: List<String> = listOf("local", "app", "cloud"),
    /** Sibling modules this one may read / subscribe to. */
    val reads: List<String> = emptyList(),
    /** Sibling modules this one may dispatch actions to. */
    val dispatches: List<String> = emptyList(),
    /** wasi:http egress. Denied modules fail to instantiate if they import http. */
    val http: Boolean = true,
)

/** What a reducer returned, deserialized from the shared wire shape. */
data class ReducerResult(
    /** New state, or null if the action didn't change state. */
    val state: JsonElement?,
    val effects: List<JsonObject>,
    val emit: List<JsonObject>,
    val crossDispatch: List<JsonObject>,
    val subscribeRequests: List<JsonObject>,
)

/**
 * A running module host. Create one per app process; register each module's
 * component bytes, instantiate, then drive init/dispatch from your app's
 * action loop and hand resulting state to the engine for re-render.
 */
class HypenHost private constructor(private val ffi: HypenModuleHost) : AutoCloseable {

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun create(config: HostConfig = HostConfig()): HypenHost {
            val cfg = buildJsonObject {
                config.maxMemoryBytes?.let { put("maxMemoryBytes", JsonPrimitive(it)) }
                config.maxCallMs?.let { put("maxCallMs", JsonPrimitive(it)) }
                if (config.interpreter) put("interpreter", JsonPrimitive(true))
                config.dataDir?.let { put("dataDir", JsonPrimitive(it)) }
            }
            return HypenHost(HypenModuleHost.withConfig(cfg.toString()))
        }
    }

    /** Register a component (.wasm bytes). ABI (v0.1/v0.2) is auto-detected. */
    fun register(grants: ModuleGrants, component: ByteArray) {
        val manifest = buildJsonObject {
            put("name", JsonPrimitive(grants.name))
            put("storage", buildJsonArray { grants.storage.forEach { add(JsonPrimitive(it)) } })
            put("reads", buildJsonArray { grants.reads.forEach { add(JsonPrimitive(it)) } })
            put("dispatches", buildJsonArray { grants.dispatches.forEach { add(JsonPrimitive(it)) } })
            put("http", JsonPrimitive(grants.http))
        }
        ffi.register(grants.name, component, manifest.toString())
    }

    fun instantiate(name: String): ULong = ffi.instantiate(name)

    fun destroy(id: ULong) = ffi.destroy(id)

    /** Run init; returns the initial state. */
    fun init(id: ULong, config: JsonElement = JsonObject(emptyMap())): JsonElement =
        json.parseToJsonElement(ffi.init(id, config.toString()))

    /** Dispatch an action against the current state. */
    fun dispatch(
        id: ULong,
        state: JsonElement,
        action: String,
        payload: JsonElement = JsonObject(emptyMap()),
        siblings: Map<String, JsonElement> = emptyMap(),
    ): ReducerResult {
        val siblingsJson =
            if (siblings.isEmpty()) "" else JsonObject(siblings).toString()
        val out = json
            .parseToJsonElement(
                ffi.dispatch(id, state.toString(), action, payload.toString(), siblingsJson),
            )
            .jsonObject
        return ReducerResult(
            state = out["state"]?.takeIf { it !is kotlinx.serialization.json.JsonNull },
            effects = out["effects"]?.let { arr -> (arr as kotlinx.serialization.json.JsonArray).map { it.jsonObject } } ?: emptyList(),
            emit = out["emit"]?.let { arr -> (arr as kotlinx.serialization.json.JsonArray).map { it.jsonObject } } ?: emptyList(),
            crossDispatch = out["crossDispatch"]?.let { arr -> (arr as kotlinx.serialization.json.JsonArray).map { it.jsonObject } } ?: emptyList(),
            subscribeRequests = out["subscribeRequests"]?.let { arr -> (arr as kotlinx.serialization.json.JsonArray).map { it.jsonObject } } ?: emptyList(),
        )
    }

    fun actions(id: ULong): List<String> = ffi.actions(id)

    override fun close() = ffi.close()
}
