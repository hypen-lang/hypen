/**
 * DeviceHost admission policy (RFC 001 §2.6 / §5): at most one prompt-raising
 * operation per host (across connections), denial cooldowns that survive
 * reconnects, and consent grants for persistable capabilities.
 */
package space.hypen.renderer.device

/** Clocks the host uses: monotonic for leases/deadlines, wall for persisted cooldowns. */
interface DeviceClock {
    fun monotonicMs(): Long

    fun wallMs(): Long

    companion object {
        val SYSTEM: DeviceClock = object : DeviceClock {
            override fun monotonicMs(): Long = System.nanoTime() / 1_000_000

            override fun wallMs(): Long = System.currentTimeMillis()
        }
    }
}

/**
 * Where cooldown deadlines (wall-clock ms) live. The default is in-memory and
 * host-scoped (survives reconnects, not process death); the Android factory
 * installs a SharedPreferences store for authenticated (`wss:`) origins so
 * cooldowns also survive restarts (RFC 001 §5).
 */
interface CooldownStore {
    fun until(origin: String, key: String): Long

    fun set(origin: String, key: String, untilWallMs: Long)
}

class InMemoryCooldownStore : CooldownStore {
    private val map = HashMap<String, Long>()

    @Synchronized
    override fun until(origin: String, key: String): Long = map["$origin|$key"] ?: 0L

    @Synchronized
    override fun set(origin: String, key: String, untilWallMs: Long) {
        map["$origin|$key"] = untilWallMs
    }
}

/** Held while a prompt (host dialog, OS permission dialog, system picker) is up. */
class PromptTicket internal constructor(private val onRelease: () -> Unit) : AutoCloseable {
    private var released = false

    override fun close() {
        if (released) return
        released = true
        onRelease()
    }
}

sealed class PromptAdmit {
    class Granted(val ticket: PromptTicket) : PromptAdmit()

    data class Throttled(val detail: String) : PromptAdmit()
}

/**
 * The host-wide prompt gate. Confined to the host dispatcher (not thread-safe
 * by itself, like the rest of the connection state).
 */
class PromptGate(private val clock: DeviceClock, private val cooldowns: CooldownStore) {
    private var active: PromptTicket? = null

    val isPromptActive: Boolean get() = active != null

    fun tryAcquire(origin: String, cooldownKeys: List<String>): PromptAdmit {
        val now = clock.wallMs()
        if (cooldownKeys.any { cooldowns.until(origin, it) > now }) return PromptAdmit.Throttled("cooldown")
        if (active != null) return PromptAdmit.Throttled("prompt-in-progress")
        lateinit var ticket: PromptTicket
        ticket = PromptTicket { if (active === ticket) active = null }
        active = ticket
        return PromptAdmit.Granted(ticket)
    }

    fun coolDown(origin: String, key: String, durationMs: Long) {
        if (durationMs <= 0) return
        val until = clock.wallMs() + durationMs
        if (until > cooldowns.until(origin, key)) cooldowns.set(origin, key, until)
    }
}

/**
 * Consent grants for `persistable` capabilities, keyed on
 * `(origin, capability)` with a finite expiry (RFC 001 §3 / §5). Grants for
 * unauthenticated origins must be connection-scoped: the host keeps one
 * [ConsentGrants] per connection for those, and one host-wide for `wss:`.
 */
class ConsentGrants(private val clock: DeviceClock) {
    private val expiry = HashMap<String, Long>()

    fun isGranted(origin: String, capability: String): Boolean =
        (expiry["$origin|$capability"] ?: 0L) > clock.wallMs()

    fun grant(origin: String, capability: String, durationMs: Long) {
        expiry["$origin|$capability"] = clock.wallMs() + durationMs
    }

    fun revoke(origin: String, capability: String) {
        expiry.remove("$origin|$capability")
    }
}

/**
 * Normalize an app origin (scheme, host, effective port) from the remote URL.
 * `ws`/`http` default port 80, `wss`/`https` 443. Returns the input unchanged
 * when it cannot be parsed.
 */
fun normalizeOrigin(url: String): String {
    return try {
        val uri = java.net.URI(url)
        val scheme = uri.scheme?.lowercase() ?: return url
        val host = uri.host?.lowercase() ?: return url
        val port = if (uri.port != -1) uri.port else when (scheme) {
            "wss", "https" -> 443
            "ws", "http" -> 80
            else -> -1
        }
        if (port == -1) "$scheme://$host" else "$scheme://$host:$port"
    } catch (_: Exception) {
        url
    }
}

/** Grants/cooldowns persist only for authenticated origins (RFC 001 §5). */
fun isAuthenticatedOrigin(origin: String): Boolean =
    origin.startsWith("wss://") || origin.startsWith("https://")
