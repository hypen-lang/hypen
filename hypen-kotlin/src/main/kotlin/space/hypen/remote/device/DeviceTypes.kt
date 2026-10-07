/**
 * Device Capability Protocol — the thin typed surface of the handler API
 * (RFC 001 §3/§4).
 *
 * There is exactly ONE implementation of the device protocol: the Rust
 * engine crate (`hypen-engine-rs/src/device` + `src/serialize/device.rs`),
 * reached through the generated UniFFI bindings (`uniffi.hypen_engine`). It
 * is the only decoder, validator and negotiator — the strict JSON limits,
 * the envelope and per-revision schemas, the registry, handshake selection,
 * frames, leases, credit and blob verification all live there.
 *
 * What this file holds is deliberately NOT a second protocol
 * implementation:
 *
 * - param classes that ENCODE the params a handler passes (the broker
 *   validates them against the selected revision before anything is sent;
 *   an invalid one is refused locally with `invalidParams` and the failing
 *   field in `platformDetail`);
 * - result / event classes DECODED with plain kotlinx.serialization from the
 *   JSON the broker already validated (a result reaches the handler only
 *   after the broker checked it against the revision schema, the blob item
 *   set, byte counts and SHA-256);
 * - the closed enums the API is typed over ([Permission], [MediaType] …),
 *   the error taxonomy ([DeviceErrorCode]) and [Lifetime].
 */
package space.hypen.remote.device

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

// ---------------------------------------------------------------------------
// Encoding / decoding (plain kotlinx over broker-validated JSON)
// ---------------------------------------------------------------------------

/** A typed capability payload with its wire encoding (params a handler sends). */
interface DevicePayload {
    /** The wire JSON object. */
    fun toJson(): JsonObject
}

/**
 * The kotlinx configuration for device payloads: absent optional members
 * stay absent on the wire (`explicitNulls = false`), and decoding is closed
 * (an unknown member means the bindings and this SDK disagree, surfaced as
 * `invalidParams` rather than silently dropped).
 */
internal object DeviceJson {
    val json: Json = Json {
        explicitNulls = false
        encodeDefaults = false
        ignoreUnknownKeys = false
    }

    fun <T> encode(serializer: KSerializer<T>, value: T): JsonObject = json.encodeToJsonElement(serializer, value).jsonObject

    /** Decode broker-validated JSON; a mismatch throws [IllegalArgumentException] (kotlinx `SerializationException`). */
    fun <T> decode(serializer: KSerializer<T>, value: JsonObject): T = json.decodeFromJsonElement(serializer, value)
}

// ---------------------------------------------------------------------------
// Errors and lifetimes
// ---------------------------------------------------------------------------

/**
 * Closed error taxonomy for protocol v1 (RFC 001 §3). New codes after
 * stabilization require a negotiated protocol version.
 */
enum class DeviceErrorCode(val wireName: String) {
    UNSUPPORTED("unsupported"),
    UNAVAILABLE("unavailable"),
    DENIED("denied"),
    REVOKED("revoked"),
    CANCELLED("cancelled"),
    TIMEOUT("timeout"),
    THROTTLED("throttled"),
    CONNECTION_LOST("connectionLost"),
    INVALID_PARAMS("invalidParams"),
    INTERNAL("internal"),
    ;

    companion object {
        /** The code with this exact wire spelling, or `null`. */
        fun fromWireName(name: String): DeviceErrorCode? = entries.firstOrNull { it.wireName == name }
    }
}

/** Requested lifetime for a device operation (RFC 001 §2.7). */
enum class Lifetime(
    /** The wire spelling. */
    val wireName: String,
) {
    /** Owned by an exact `{moduleInstanceId, activationId}`; swept on deactivation. */
    ACTIVATION("activation"),

    /** Owned by `{moduleInstanceId}`; swept on destruction, not deactivation. */
    BACKGROUND("background"),

    /** Reserved for protocol control (`core.*`); survives module navigation. */
    CONNECTION("connection"),
    ;

    companion object {
        /** The lifetime with this exact wire spelling, or `null`. */
        fun fromWireName(name: String): Lifetime? = entries.firstOrNull { it.wireName == name }
    }
}

// ---------------------------------------------------------------------------
// Shared blob metadata
// ---------------------------------------------------------------------------

/**
 * A completed blob item as the client reported it in a terminal result — its
 * ACTUAL byte count and SHA-256, which the broker verified against the bytes
 * it received before the handler sees the result.
 */
@Serializable
data class BlobItem(
    val channel: Int,
    val contentType: String,
    val bytes: Long,
    /** Lowercase hex SHA-256 of the item's bytes (mismatch detection, not authenticity). */
    val sha256: String,
)

// ---------------------------------------------------------------------------
// gallery.pick / file.pick
// ---------------------------------------------------------------------------

@Serializable
enum class MediaType(val wireName: String) {
    @SerialName("photo") PHOTO("photo"),
    @SerialName("video") VIDEO("video"),
    ;

    companion object {
        fun fromWireName(name: String): MediaType? = entries.firstOrNull { it.wireName == name }
    }
}

/** `gallery.pick@1` params: 1..2 unique media types, 1..16 items. */
@Serializable
data class GalleryPickParams(val mediaTypes: List<MediaType>, val maxCount: Int) : DevicePayload {
    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)
}

/** `file.pick@1` params: accepted MIME types or patterns (e.g. `application/pdf`, `image/&#42;`). */
@Serializable
data class FilePickParams(val accept: List<String>, val maxCount: Int) : DevicePayload {
    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)
}

// ---------------------------------------------------------------------------
// file.save
// ---------------------------------------------------------------------------

/** `file.save@1` write receipt: the client verified size and hash before success. */
@Serializable
data class FileSaveResult(val bytesWritten: Long)

// ---------------------------------------------------------------------------
// permission.query / permission.request
// ---------------------------------------------------------------------------

@Serializable
enum class PermissionStatus(val wireName: String) {
    @SerialName("granted") GRANTED("granted"),
    @SerialName("denied") DENIED("denied"),
    @SerialName("prompt") PROMPT("prompt"),
    ;

    companion object {
        fun fromWireName(name: String): PermissionStatus? = entries.firstOrNull { it.wireName == name }
    }
}

/**
 * The closed permission set of `permission.query@1` / `permission.request@1`
 * (RFC 001 §3, round-3 P1). Every host maps the SAME names; a typo cannot be
 * expressed here, and the broker refuses anything outside the schema enum. A
 * host that cannot represent one of these at all answers `unsupported` with
 * `platformDetail` = [wireName].
 */
@Serializable
enum class Permission(val wireName: String) {
    @SerialName("camera") CAMERA("camera"),
    @SerialName("microphone") MICROPHONE("microphone"),
    @SerialName("photos") PHOTOS("photos"),
    @SerialName("location") LOCATION("location"),
    @SerialName("notifications") NOTIFICATIONS("notifications"),
    @SerialName("bluetooth") BLUETOOTH("bluetooth"),
    @SerialName("contacts") CONTACTS("contacts"),
    ;

    companion object {
        /** Exact (case-sensitive) wire-name lookup; `null` for anything outside the closed set. */
        fun fromWireName(name: String): Permission? = entries.firstOrNull { it.wireName == name }
    }
}

/** `permission.query@1` / `permission.request@1` params. */
@Serializable
data class PermissionParams(val permission: Permission) : DevicePayload {
    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)
}

@Serializable
data class PermissionResult(val status: PermissionStatus)

// ---------------------------------------------------------------------------
// bluetooth.scan
// ---------------------------------------------------------------------------

/** `bluetooth.scan@1` takes no params. */
data object BluetoothScanParams : DevicePayload {
    override fun toJson(): JsonObject = JsonObject(emptyMap())
}

/** One advertisement: `name` absent is `null`, `""` is present. */
@Serializable
data class BluetoothDevice(val id: String, val name: String? = null, val rssi: Int)

@Serializable
data class BluetoothScanEvent(val device: BluetoothDevice)

/** `bluetooth.scan@1` terminal result (empty object). */
data object BluetoothScanResult

// ---------------------------------------------------------------------------
// bluetooth.select
// ---------------------------------------------------------------------------

/**
 * `bluetooth.select@1` params: optional filters for the host-owned chooser
 * (absent filters list every nearby device). [services]: 1..16 unique
 * service UUIDs in the canonical lowercase 128-bit form (build one from a
 * 16-bit SIG id with [expandShortUuid]); [namePrefix]: 1..64 code points.
 */
@Serializable
data class BluetoothSelectParams(val services: List<String>? = null, val namePrefix: String? = null) : DevicePayload {
    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)

    companion object {
        /** A 16-bit SIG short id (e.g. `0x180d`) expanded against the Bluetooth base UUID. */
        fun expandShortUuid(shortId: Int): String {
            require(shortId in 0..0xFFFF) { "a 16-bit Bluetooth id is 0..0xFFFF, got $shortId" }
            return "0000%04x-0000-1000-8000-00805f9b34fb".format(shortId)
        }
    }
}

/** The device the user chose: identity only (no GATT in revision 1). */
@Serializable
data class SelectedBluetoothDevice(val id: String, val name: String? = null)

@Serializable
data class BluetoothSelectResult(val device: SelectedBluetoothDevice)

// ---------------------------------------------------------------------------
// mic.record
// ---------------------------------------------------------------------------

@Serializable
enum class MicFormat(val wireName: String) {
    /** v1 pilot: `pcm16` only; the final encoding set is a Phase 4 decision. */
    @SerialName("pcm16") PCM16("pcm16"),
    ;

    companion object {
        fun fromWireName(name: String): MicFormat? = entries.firstOrNull { it.wireName == name }
    }
}

/**
 * `mic.record@1` params. [maxDurationMs] (1..600000) is a recording limit,
 * never a size (RFC 001 §2.4, D5); [channels] is 1 or 2 (absent = 1), frames
 * carry little-endian PCM16 samples, interleaved when 2.
 */
@Serializable
data class MicRecordParams(
    val sampleRate: Long,
    val format: MicFormat,
    val maxDurationMs: Long? = null,
    val channels: Int? = null,
) : DevicePayload {
    /** The effective channel count (absent = 1). */
    val channelCount: Int get() = channels ?: 1

    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)
}

@Serializable
data class MicRecordResult(val durationMs: Long, val item: BlobItem)

// ---------------------------------------------------------------------------
// camera.capture
// ---------------------------------------------------------------------------

@Serializable
enum class CaptureMode(val wireName: String) {
    @SerialName("photo") PHOTO("photo"),
    @SerialName("video") VIDEO("video"),
    ;

    companion object {
        fun fromWireName(name: String): CaptureMode? = entries.firstOrNull { it.wireName == name }
    }
}

/** `camera.capture@1` preferred camera; the host may fall back when the device has only one. */
@Serializable
enum class CameraFacing(val wireName: String) {
    @SerialName("front") FRONT("front"),
    @SerialName("back") BACK("back"),
    ;

    companion object {
        fun fromWireName(name: String): CameraFacing? = entries.firstOrNull { it.wireName == name }
    }
}

/**
 * `camera.capture@1` params. The host's own capture UI is the per-use
 * consent gate. [maxDurationMs] (1..600000) is a video recording limit; the
 * broker refuses it with [CaptureMode.PHOTO] (`invalidParams`).
 */
@Serializable
data class CameraCaptureParams(
    val mode: CaptureMode,
    val facing: CameraFacing? = null,
    val maxDurationMs: Long? = null,
) : DevicePayload {
    override fun toJson(): JsonObject = DeviceJson.encode(serializer(), this)
}
