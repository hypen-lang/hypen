/**
 * Capability policy (RFC 001 §3) — a copy of the provisional v1 registry in
 * `hypen-engine-rs/src/serialize/device.rs` (mirrored by the JVM SDK's
 * `space.hypen.remote.device.DeviceRegistry`). Every entry is an immutable
 * revision. `DeviceRegistryPinTest` pins this table field-for-field to the
 * exported `engine-compatibility-tests/schema/device/registry-v1.json`.
 */
package space.hypen.renderer.device

enum class Mode { UNARY, STREAM }

/** What flows on the data plane, and in which direction. */
enum class DataPlane { NONE, JSON_EVENTS, BINARY_UPLOAD, BINARY_DOWNLOAD }

enum class Consent { NONE, PER_USE, PERSISTABLE }

/** Revision-defined overflow policy (RFC 001 §2.3). */
enum class Overflow { NONE, DROP_OLDEST, PAUSE }

data class CapabilityRevision(
    val version: Long,
    val mode: Mode,
    val data: DataPlane,
    val consent: Consent,
    val lifetimes: List<Lifetime>,
    val maxItemBytes: Long,
    val maxItems: Int,
    val maxInitialCredit: Long,
    val maxOutstandingCredit: Long,
    val maxTimeoutMs: Long,
    val overflow: Overflow,
)

object DeviceRegistry {
    private const val MIB: Long = 1024 * 1024
    private val ACTIVATION = listOf(Lifetime.ACTIVATION)

    private val revisions: Map<Pair<String, Long>, CapabilityRevision> = mapOf(
        ("core.capabilities" to 1L) to CapabilityRevision(
            1, Mode.STREAM, DataPlane.JSON_EVENTS, Consent.NONE, listOf(Lifetime.CONNECTION),
            maxItemBytes = 0, maxItems = 0, maxInitialCredit = 64, maxOutstandingCredit = 64, maxTimeoutMs = 86_400_000, overflow = Overflow.DROP_OLDEST,
        ),
        ("bluetooth.scan" to 1L) to CapabilityRevision(
            1, Mode.STREAM, DataPlane.JSON_EVENTS, Consent.PERSISTABLE, ACTIVATION,
            maxItemBytes = 0, maxItems = 0, maxInitialCredit = 256, maxOutstandingCredit = 1024, maxTimeoutMs = 600_000, overflow = Overflow.DROP_OLDEST,
        ),
        ("bluetooth.select" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.NONE, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 0, maxItems = 0, maxInitialCredit = 0, maxOutstandingCredit = 0, maxTimeoutMs = 300_000, overflow = Overflow.NONE,
        ),
        ("camera.capture" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.BINARY_UPLOAD, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 64 * MIB, maxItems = 1, maxInitialCredit = 4 * MIB, maxOutstandingCredit = 8 * MIB, maxTimeoutMs = 600_000, overflow = Overflow.PAUSE,
        ),
        ("file.pick" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.BINARY_UPLOAD, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 64 * MIB, maxItems = 16, maxInitialCredit = 4 * MIB, maxOutstandingCredit = 8 * MIB, maxTimeoutMs = 300_000, overflow = Overflow.PAUSE,
        ),
        ("file.save" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.BINARY_DOWNLOAD, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 64 * MIB, maxItems = 1, maxInitialCredit = 0, maxOutstandingCredit = 8 * MIB, maxTimeoutMs = 300_000, overflow = Overflow.PAUSE,
        ),
        ("gallery.pick" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.BINARY_UPLOAD, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 64 * MIB, maxItems = 16, maxInitialCredit = 4 * MIB, maxOutstandingCredit = 8 * MIB, maxTimeoutMs = 300_000, overflow = Overflow.PAUSE,
        ),
        ("mic.record" to 1L) to CapabilityRevision(
            1, Mode.STREAM, DataPlane.BINARY_UPLOAD, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 64 * MIB, maxItems = 1, maxInitialCredit = 256 * 1024, maxOutstandingCredit = MIB, maxTimeoutMs = 600_000, overflow = Overflow.PAUSE,
        ),
        ("permission.query" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.NONE, Consent.NONE, ACTIVATION,
            maxItemBytes = 0, maxItems = 0, maxInitialCredit = 0, maxOutstandingCredit = 0, maxTimeoutMs = 30_000, overflow = Overflow.NONE,
        ),
        ("permission.request" to 1L) to CapabilityRevision(
            1, Mode.UNARY, DataPlane.NONE, Consent.PER_USE, ACTIVATION,
            maxItemBytes = 0, maxItems = 0, maxInitialCredit = 0, maxOutstandingCredit = 0, maxTimeoutMs = 300_000, overflow = Overflow.NONE,
        ),
    )

    fun revision(capability: String, version: Long): CapabilityRevision? = revisions[capability to version]

    /** Every `(capability, version)` revision this host knows. */
    val all: Map<Pair<String, Long>, CapabilityRevision> get() = revisions
}
