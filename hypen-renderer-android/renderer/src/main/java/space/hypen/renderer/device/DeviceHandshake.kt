/**
 * Client side of the device handshake (RFC 001 §2.2, decisions D6/D7):
 * handshake-v1 validation of `hello.device`, `sessionAck.device` and
 * `core.capabilities` snapshots, and acceptance of the server's selection
 * against the exact advertisement this connection sent.
 *
 * Pinned by `fixtures/device/conformance/messages.json` (`handshake` cases)
 * and `fixtures/device/conformance/selection.json`.
 */
package space.hypen.renderer.device

/** The negotiated device selection of one connection: capability name → selected revision. */
data class DeviceSelection(
    val protocolVersion: Long,
    val binary: Boolean,
    val capabilities: Map<String, Long>,
)

sealed class AckOutcome {
    /** Accepted; [dropped] lists `name@version` entries the hello never offered (ignored, never enabled). */
    data class Selected(val selection: DeviceSelection, val dropped: List<String>) : AckOutcome()

    /** The device plane stays disabled on this connection. */
    data class Disabled(val reason: String) : AckOutcome()
}

object DeviceHandshake {
    private fun throwInvalid(what: String): Nothing = DevicePayloads.invalid(what)

    private const val MAX_PROTOCOL_VERSIONS = 8
    private const val MAX_CAPABILITIES = 64

    /** handshake-v1 `deviceHello`, plus unique names; null when valid. */
    fun validateHello(value: Any?): String? = DevicePayloads.check {
        val o = DeviceWire.asObject(value) ?: throwInvalid("hello.device must be an object")
        closedKeys(o, setOf("protocolVersions", "binary", "capabilities"))?.let { throwInvalid(it) }
        val versions = o["protocolVersions"] as? List<*> ?: throwInvalid("protocolVersions must be an array")
        if (versions.size > MAX_PROTOCOL_VERSIONS) throwInvalid("more than $MAX_PROTOCOL_VERSIONS protocol versions")
        val ints = versions.map { DeviceWire.exactLong(it)?.takeIf { v -> v in 1..DeviceProtocol.U32_MAX } ?: throwInvalid("protocol version out of range") }
        if (ints.toSet().size != ints.size) throwInvalid("protocol version repeated")
        if (o["binary"] !is Boolean) throwInvalid("binary must be a boolean")
        offers(o["capabilities"])
    }

    /** handshake-v1 `deviceAck`, plus unique names; null when valid. */
    fun validateAck(value: Any?): String? = DevicePayloads.check {
        val o = DeviceWire.asObject(value) ?: throwInvalid("sessionAck.device must be an object")
        closedKeys(o, setOf("protocolVersion", "binary", "capabilities"))?.let { throwInvalid(it) }
        DeviceWire.exactLong(o["protocolVersion"])?.takeIf { it in 1..DeviceProtocol.U32_MAX } ?: throwInvalid("protocolVersion out of range")
        if (o["binary"] !is Boolean) throwInvalid("binary must be a boolean")
        val caps = o["capabilities"] as? List<*> ?: throwInvalid("capabilities must be an array")
        if (caps.size > MAX_CAPABILITIES) throwInvalid("more than $MAX_CAPABILITIES capabilities")
        val names = HashSet<String>()
        for (c in caps) {
            val cap = DeviceWire.asObject(c) ?: throwInvalid("capability entry must be an object")
            closedKeys(cap, setOf("name", "version"))?.let { throwInvalid(it) }
            val name = (cap["name"] as? String)?.takeIf { it.codePointLength() in 1..DeviceProtocol.MAX_CAPABILITY_NAME }
                ?: throwInvalid("capability name invalid")
            DeviceWire.exactLong(cap["version"])?.takeIf { it in 1..DeviceProtocol.U32_MAX } ?: throwInvalid("capability version out of range")
            // Exact code points, never Unicode canonical equivalence (D7).
            if (!names.add(name)) throwInvalid("capability $name selected more than once")
        }
    }

    /** A `core.capabilities` snapshot body (handshake-v1 `capabilitiesEvent`, unique names); null when valid. */
    fun validateCapabilitiesEvent(value: Any?): String? = DevicePayloads.check { DevicePayloads.capabilities(value) }

    private fun offers(value: Any?) {
        val list = value as? List<*> ?: throwInvalid("capabilities must be an array")
        if (list.size > MAX_CAPABILITIES) throwInvalid("more than $MAX_CAPABILITIES capabilities")
        val names = list.map { DevicePayloads.offer(it)["name"] }
        if (names.toSet().size != names.size) throwInvalid("capability named twice")
    }

    /**
     * Accept `sessionAck.device` against the exact [hello] advertisement this
     * connection sent (RFC 001 §2.2). A schema-invalid ack, a protocol
     * version the hello did not offer, or a selection without
     * `core.capabilities@1` disables the plane. An entry naming a revision
     * the hello never offered is dropped (never enabled), as is a binary-plane
     * revision when `binary` was not negotiated.
     */
    fun accept(ack: Any?, hello: Map<String, Any?>): AckOutcome {
        validateAck(ack)?.let { return AckOutcome.Disabled("invalid sessionAck.device: $it") }
        val a = DeviceWire.asObject(ack)!!
        val offered = HashMap<String, Set<Long>>()
        for (c in hello["capabilities"] as? List<*> ?: emptyList<Any?>()) {
            val o = DeviceWire.asObject(c) ?: continue
            val name = o["name"] as? String ?: continue
            offered[name] = (o["versions"] as? List<*>).orEmpty().mapNotNull(DeviceWire::exactLong).toSet()
        }
        val protocol = DeviceWire.exactLong(a["protocolVersion"])!!
        val helloVersions = (hello["protocolVersions"] as? List<*>).orEmpty().mapNotNull(DeviceWire::exactLong)
        if (protocol !in helloVersions) {
            return AckOutcome.Disabled("no common protocol version (server chose $protocol)")
        }
        val binary = a["binary"] == true && hello["binary"] == true
        val kept = LinkedHashMap<String, Long>()
        val dropped = ArrayList<String>()
        for (c in a["capabilities"] as List<*>) {
            val cap = DeviceWire.asObject(c)!!
            val name = cap["name"] as String
            val version = DeviceWire.exactLong(cap["version"])!!
            val plane = DeviceRegistry.revision(name, version)?.data
            when {
                version !in offered[name].orEmpty() -> dropped += "$name@$version (not offered)"
                !binary && (plane == DataPlane.BINARY_UPLOAD || plane == DataPlane.BINARY_DOWNLOAD) -> dropped += "$name@$version (binary not negotiated)"
                else -> kept[name] = version
            }
        }
        if (kept[DeviceHost.CORE_CAPABILITIES] != 1L) return AckOutcome.Disabled("server did not select core.capabilities@1")
        return AckOutcome.Selected(DeviceSelection(protocol, binary, kept), dropped)
    }
}
