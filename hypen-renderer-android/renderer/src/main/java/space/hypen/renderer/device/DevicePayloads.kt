/**
 * Closed-schema validation of capability payloads (RFC 001 §3) for every
 * revision in [DeviceRegistry], mirroring the exported revision schemas in
 * `engine-compatibility-tests/schema/device/<capability>-v1.schema.json`
 * (`$defs/params|result|event`) plus the rules no schema keyword expresses
 * (unique blob channels in a result, unique names in a `core.capabilities`
 * snapshot). Pinned by `fixtures/device/conformance/payloads.json`.
 *
 * The DeviceHost validates every inbound `params` with it (so a capability
 * without an Android driver is still refused precisely), and every outbound
 * `result`/`event` before sending, so a driver bug surfaces as `internal`
 * instead of an invalid message on the wire.
 *
 * Values are the strict JSON trees of `DeviceProtocol.kt` (integers are
 * `Long`/`Int`; never `Double`).
 */
package space.hypen.renderer.device

enum class PayloadKind { PARAMS, RESULT, EVENT }

/** Optional progress state (§2.1): consumes no data credit, never goes back to [PENDING_CONSENT]. */
enum class ProgressState(val wireName: String) {
    PENDING_CONSENT("pendingConsent"),
    RUNNING("running"),
}

/**
 * The closed permission set of `permission.query@1` / `permission.request@1`
 * (RFC 001 §3, round 3 P1). Every host maps the SAME names; anything else is
 * `invalidParams` at decode. A host that cannot represent one of them answers
 * `unsupported` with `platformDetail` = the permission name.
 */
object DevicePermissions {
    /** Wire names in schema `enum` order. */
    val ALL: List<String> = listOf("camera", "microphone", "photos", "location", "notifications", "bluetooth", "contacts")
}

object DevicePayloads {
    private const val CONTENT_TYPE_MAX = 256
    private const val FILE_NAME_MAX = 512
    private val SHA256 = Regex("[0-9a-f]{64}")

    /** Canonical Bluetooth UUID on the wire: lowercase 128-bit (a 16-bit SIG id is sent expanded). */
    val BLUETOOTH_UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    /** `camera.capture@1` media types per mode (bare types: codec parameters are stripped). */
    val CAMERA_PHOTO_TYPES: Set<String> = linkedSetOf("image/jpeg", "image/heic")
    val CAMERA_VIDEO_TYPES: Set<String> = linkedSetOf("video/mp4", "video/quicktime", "video/webm")
    private val CAMERA_TYPES: Set<String> = CAMERA_PHOTO_TYPES + CAMERA_VIDEO_TYPES

    /**
     * Request-dependent `blobStart` metadata (RFC 001 §2.4 "disallowed
     * metadata"): an announced item must fit the params of its request.
     * `camera.capture@1`: a `photo` item is `image/jpeg`/`image/heic`, a
     * `video` item `video/mp4`/`video/quicktime`/`video/webm`. Null when it
     * fits (and for every revision without such a rule).
     */
    fun blobStartViolation(capability: String, version: Long, params: Map<String, Any?>, contentType: String): String? {
        if (capability != "camera.capture" || version != 1L) return null
        val allowed = if (params["mode"] == "video") CAMERA_VIDEO_TYPES else CAMERA_PHOTO_TYPES
        return if (contentType in allowed) null else "contentType $contentType does not fit the requested capture mode"
    }

    private class Invalid(message: String) : Exception(message)

    private fun bad(what: String): Nothing = throw Invalid(what)

    /** Fail a [check] block. */
    internal fun invalid(what: String): Nothing = throw Invalid(what)

    /**
     * Null when [value] is a valid [kind] payload of `capability@version`,
     * else the first violation. A revision the registry does not declare is
     * never valid.
     */
    fun validate(capability: String, version: Long, kind: PayloadKind, value: Any?): String? {
        val rev = DeviceRegistry.revision(capability, version) ?: return "$capability@$version is not a registry revision"
        return try {
            when (kind) {
                PayloadKind.PARAMS -> params(capability, rev, value)
                PayloadKind.RESULT -> result(capability, rev, value)
                PayloadKind.EVENT -> event(capability, rev, value)
            }
            null
        } catch (e: Invalid) {
            "${kind.name.lowercase()}: ${e.message}"
        }
    }

    // ---- per-capability shapes ---------------------------------------------------

    private fun params(capability: String, rev: CapabilityRevision, value: Any?) {
        when (capability) {
            "gallery.pick" -> {
                val o = obj(value, "params", setOf("mediaTypes", "maxCount"))
                array(o["mediaTypes"], "mediaTypes", min = 1, max = 2, unique = true) { enumString(it, "mediaTypes[]", setOf("photo", "video")) }
                int(o["maxCount"], "maxCount", 1, rev.maxItems.toLong())
            }
            "file.pick" -> {
                val o = obj(value, "params", setOf("accept", "maxCount"))
                array(o["accept"], "accept", min = 0, max = 32) { string(it, "accept[]", 0, 128) }
                int(o["maxCount"], "maxCount", 1, rev.maxItems.toLong())
            }
            "file.save" -> {
                val o = obj(value, "params", setOf("channel", "name", "contentType", "bytes", "sha256"))
                int(o["channel"], "channel", 0, 0)
                string(o["name"], "name", 0, FILE_NAME_MAX)
                string(o["contentType"], "contentType", 0, CONTENT_TYPE_MAX)
                int(o["bytes"], "bytes", 1, rev.maxItemBytes)
                sha256(o["sha256"], "sha256")
            }
            "mic.record" -> {
                val o = obj(value, "params", setOf("sampleRate", "format"), setOf("maxDurationMs", "channels"))
                int(o["sampleRate"], "sampleRate", 8_000, 192_000)
                enumString(o["format"], "format", setOf("pcm16"))
                if ("maxDurationMs" in o) int(o["maxDurationMs"], "maxDurationMs", 1, 600_000)
                if ("channels" in o) int(o["channels"], "channels", 1, 2)
            }
            "camera.capture" -> {
                val o = DeviceWire.asObject(value) ?: bad("params must be an object")
                // oneOf keyed by mode: maxDurationMs exists only for video.
                val video = o["mode"] == "video"
                obj(o, "params", setOf("mode"), if (video) setOf("facing", "maxDurationMs") else setOf("facing"))
                enumString(o["mode"], "mode", setOf("photo", "video"))
                if ("facing" in o) enumString(o["facing"], "facing", setOf("front", "back"))
                if ("maxDurationMs" in o) int(o["maxDurationMs"], "maxDurationMs", 1, 600_000)
            }
            "bluetooth.select" -> {
                val o = obj(value, "params", emptySet(), setOf("services", "namePrefix"))
                if ("services" in o) {
                    array(o["services"], "services", min = 1, max = 16, unique = true) {
                        val u = string(it, "services[]", 36, 36)
                        if (!BLUETOOTH_UUID.matches(u)) bad("services[] must be a lowercase 128-bit UUID")
                    }
                }
                if ("namePrefix" in o) string(o["namePrefix"], "namePrefix", 1, 64)
            }
            "permission.query", "permission.request" -> {
                val o = obj(value, "params", setOf("permission"))
                enumString(o["permission"], "permission", DevicePermissions.ALL.toSet())
            }
            "bluetooth.scan", "core.capabilities" -> obj(value, "params", emptySet())
            else -> bad("no params schema for $capability")
        }
    }

    private fun result(capability: String, rev: CapabilityRevision, value: Any?) {
        when (capability) {
            "gallery.pick" -> {
                val o = obj(value, "result", setOf("items"))
                val items = array(o["items"], "items", min = 0, max = rev.maxItems) { blobItem(it, rev) }
                uniqueChannels(items)
            }
            "file.pick" -> {
                val o = obj(value, "result", setOf("items"))
                val items = array(o["items"], "items", min = 0, max = rev.maxItems) {
                    val i = obj(it, "item", setOf("channel", "name", "contentType", "bytes", "sha256"))
                    string(i["name"], "item.name", 0, FILE_NAME_MAX)
                    blobItemFields(i, rev)
                    i
                }
                uniqueChannels(items)
            }
            "camera.capture" -> {
                val o = obj(value, "result", setOf("items"))
                val items = array(o["items"], "items", min = 1, max = 1) { blobItem(it, rev) }
                items.forEach { enumString(it["contentType"], "item.contentType", CAMERA_TYPES) }
                uniqueChannels(items)
            }
            "bluetooth.select" -> {
                val o = obj(value, "result", setOf("device"))
                val d = obj(o["device"], "device", setOf("id"), setOf("name"))
                string(d["id"], "device.id", 1, 128)
                if ("name" in d) string(d["name"], "device.name", 0, 256)
            }
            "file.save" -> {
                val o = obj(value, "result", setOf("bytesWritten"))
                int(o["bytesWritten"], "bytesWritten", 0, rev.maxItemBytes)
            }
            "mic.record" -> {
                val o = obj(value, "result", setOf("durationMs", "item"))
                int(o["durationMs"], "durationMs", 0, DeviceProtocol.JSON_SAFE_MAX)
                blobItem(o["item"], rev)
            }
            "permission.query", "permission.request" -> {
                val o = obj(value, "result", setOf("status"))
                enumString(o["status"], "status", setOf("granted", "denied", "prompt"))
            }
            "bluetooth.scan", "core.capabilities" -> obj(value, "result", emptySet())
            else -> bad("no result schema for $capability")
        }
    }

    private fun event(capability: String, rev: CapabilityRevision, value: Any?) {
        val o = DeviceWire.asObject(value) ?: bad("event must be an object")
        when (o["kind"]) {
            "progress" -> {
                obj(o, "progress", setOf("kind", "state"))
                enumString(o["state"], "state", ProgressState.entries.map { it.wireName }.toSet())
                return
            }
            "blobStart" -> if (rev.data == DataPlane.BINARY_UPLOAD) {
                obj(o, "blobStart", setOf("kind", "channel", "contentType"), setOf("bytes"))
                int(o["channel"], "channel", 0, rev.maxItems - 1L)
                string(o["contentType"], "contentType", 0, CONTENT_TYPE_MAX)
                if ("bytes" in o) int(o["bytes"], "bytes", 0, rev.maxItemBytes)
                if (capability == "camera.capture") enumString(o["contentType"], "contentType", CAMERA_TYPES)
                return
            }
        }
        when (capability) {
            "core.capabilities" -> capabilities(o)
            "bluetooth.scan" -> {
                obj(o, "event", setOf("device"))
                val d = obj(o["device"], "device", setOf("id", "rssi"), setOf("name"))
                string(d["id"], "device.id", 0, 128)
                if ("name" in d) string(d["name"], "device.name", 0, 256)
                int(d["rssi"], "device.rssi", -32_768, 32_767)
            }
            else -> bad("event is not defined for $capability@${rev.version}")
        }
    }

    /** Run a shape check, returning its violation (or null) instead of throwing. */
    internal fun check(block: () -> Unit): String? = try {
        block()
        null
    } catch (e: Invalid) {
        e.message
    }

    /** A `core.capabilities` snapshot body `{capabilities:[{name, versions}]}` (unique names). */
    internal fun capabilities(value: Any?) {
        val o = obj(value, "capabilities event", setOf("capabilities"))
        val offers = array(o["capabilities"], "capabilities", min = 0, max = 64) { offer(it) }
        val names = offers.map { it["name"] }
        if (names.toSet().size != names.size) bad("capability named twice")
    }

    internal fun offer(value: Any?): Map<String, Any?> {
        val o = obj(value, "capability offer", setOf("name", "versions"))
        string(o["name"], "name", 1, DeviceProtocol.MAX_CAPABILITY_NAME)
        array(o["versions"], "versions", min = 0, max = 32, unique = true) { int(it, "versions[]", 1, DeviceProtocol.U32_MAX) }
        return o
    }

    private fun blobItem(value: Any?, rev: CapabilityRevision): Map<String, Any?> {
        val i = obj(value, "item", setOf("channel", "contentType", "bytes", "sha256"))
        blobItemFields(i, rev)
        return i
    }

    private fun blobItemFields(i: Map<String, Any?>, rev: CapabilityRevision) {
        int(i["channel"], "item.channel", 0, rev.maxItems - 1L)
        string(i["contentType"], "item.contentType", 0, CONTENT_TYPE_MAX)
        int(i["bytes"], "item.bytes", 0, rev.maxItemBytes)
        sha256(i["sha256"], "item.sha256")
    }

    private fun uniqueChannels(items: List<Map<String, Any?>>) {
        val channels = items.map { it["channel"] }
        if (channels.toSet().size != channels.size) bad("item channel repeated")
    }

    // ---- primitives ------------------------------------------------------------------

    private fun obj(value: Any?, what: String, required: Set<String>, optional: Set<String> = emptySet()): Map<String, Any?> {
        val o = DeviceWire.asObject(value) ?: bad("$what must be an object")
        closedKeys(o, required, optional)?.let { bad("$what: $it") }
        return o
    }

    private fun <T> array(value: Any?, what: String, min: Int, max: Int, unique: Boolean = false, item: (Any?) -> T): List<T> {
        val list = value as? List<*> ?: bad("$what must be an array")
        if (list.size < min) bad("$what needs at least $min items")
        if (list.size > max) bad("$what has more than $max items")
        if (unique && list.map { DeviceWire.exactLong(it) ?: it }.toSet().size != list.size) bad("$what items must be unique")
        return list.map(item)
    }

    private fun string(value: Any?, what: String, min: Int, max: Int): String {
        val s = value as? String ?: bad("$what must be a string")
        if (s.codePointLength() !in min..max) bad("$what must be $min..$max code points")
        return s
    }

    private fun enumString(value: Any?, what: String, allowed: Set<String>): String {
        val s = value as? String ?: bad("$what must be a string")
        if (s !in allowed) bad("$what must be one of $allowed")
        return s
    }

    private fun int(value: Any?, what: String, min: Long, max: Long): Long {
        val v = DeviceWire.exactLong(value) ?: bad("$what must be an integer")
        if (v !in min..max) bad("$what must be within $min..$max")
        return v
    }

    private fun sha256(value: Any?, what: String) {
        val s = value as? String ?: bad("$what must be a string")
        if (!SHA256.matches(s)) bad("$what must be 64 lowercase hex digits")
    }
}
