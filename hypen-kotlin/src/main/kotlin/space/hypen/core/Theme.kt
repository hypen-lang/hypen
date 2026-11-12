package space.hypen.core

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Theming and design tokens for Hypen apps.
 *
 * One [Theme] instance per app (per session under [HypenServer]) owns the
 * design tokens and the active color scheme, and publishes them to the
 * engine as two data-source contexts:
 *
 * - `theme`      — the resolved tokens: the base set with the active scheme's
 *                  overrides merged on top. Templates read
 *                  `.color(@theme.color.primary)` / `.padding(@theme.space.md)`
 *                  / `Text("@{theme.font.body}")`.
 * - `appearance` — `{ scheme, preference, system, schemes }`, read as
 *                  `@appearance.scheme` (e.g. to pick an icon).
 *
 * Switching scheme ([Theme.setScheme]) pushes a new `theme` context; the
 * engine diffs it against the previous one and re-renders only the nodes
 * bound to tokens whose value actually changed.
 *
 * A token value may be an alias of another token, written
 * `"{color.blue.500}"` (the whole string). Aliases are resolved after the
 * scheme merge, so a semantic token defined once in the base set
 * (`"primary" to "{color.brand}"`) follows a scheme that overrides
 * `color.brand`.
 *
 * Behaviour is shared with the other SDKs and pinned by
 * `engine-compatibility-tests/fixtures/theme/resolve.json`.
 */

/** Reserved data-source provider carrying the resolved tokens. */
const val THEME_TOKENS_PROVIDER = "theme"

/** Reserved data-source provider carrying `{ scheme, preference, … }`. */
const val THEME_META_PROVIDER = "appearance"

/** The preference that follows the platform's color scheme. */
const val SYSTEM_SCHEME = "system"

/**
 * A (possibly nested) set of design tokens, in the same representation the
 * SDK uses for module state: a leaf is a `String`, `Number` or `Boolean`, a
 * group is a nested `Map<String, Any?>`.
 */
typealias Tokens = Map<String, Any?>

/** A color scheme the platform itself can report. */
enum class SystemColorScheme(val id: String) {
    LIGHT("light"),
    DARK("dark");

    override fun toString(): String = id

    companion object {
        /** The scheme named [id] (`"light"` / `"dark"`), or `null`. */
        fun of(id: String): SystemColorScheme? = entries.firstOrNull { it.id == id }
    }
}

/** Options for [createTheme]. */
data class ThemeOptions(
    /** Tokens shared by every scheme. */
    val tokens: Tokens = emptyMap(),
    /**
     * Per-scheme overrides, merged over [tokens] while that scheme is active.
     * `light` and `dark` are what `"system"` resolves to; any other name is a
     * scheme selected explicitly with [Theme.setScheme].
     */
    val schemes: Map<String, Tokens> = emptyMap(),
    /**
     * Which scheme to use: a scheme name, or `"system"` to follow the
     * platform. Defaults to `"system"`.
     */
    val scheme: String = SYSTEM_SCHEME,
    /**
     * What `"system"` resolves to until the platform reports otherwise
     * ([Theme.setSystemScheme]). Defaults to light.
     */
    val systemScheme: SystemColorScheme = SystemColorScheme.LIGHT,
    /** Called the first time each missing token is looked up via [Theme.token]. */
    val onMissingToken: ((path: String, scheme: String) -> Unit)? = null,
)

/** Snapshot published as the `appearance` data source. */
data class ThemeMeta(
    /** The scheme in effect (never `"system"`). */
    val scheme: String,
    /** What was asked for: a scheme name or `"system"`. */
    val preference: String,
    /** The platform's scheme as last reported. */
    val system: SystemColorScheme,
    /** Scheme names that have overrides defined. */
    val schemes: List<String>,
) {
    /** The payload as published to the engine. */
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "scheme" to scheme,
        "preference" to preference,
        "system" to system.id,
        "schemes" to schemes,
    )
}

typealias ThemeChangeListener = (ThemeMeta) -> Unit

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Segments a template reference (`@theme.a.b`) can address. */
private val REFERENCEABLE_KEY = Regex("^[A-Za-z0-9_]+$")
private val ALIAS = Regex("^\\{([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)\\}$")

/** Longest alias chain followed before giving up (a cycle is reported earlier). */
private const val MAX_ALIAS_DEPTH = 32

private val themeLog = createLogger("Theme")

@Suppress("UNCHECKED_CAST")
private fun Any?.asGroup(): Tokens? = this as? Map<String, Any?>

/** Deep-merge [primary] over [fallback] into a new map. */
private fun mergeTokens(fallback: Tokens?, primary: Tokens?): Tokens {
    val out = LinkedHashMap<String, Any?>()
    for (src in listOf(fallback, primary)) {
        if (src == null) continue
        for ((k, v) in src) {
            val group = v.asGroup()
            out[k] = if (group != null) mergeTokens(out[k].asGroup(), group) else v
        }
    }
    return out
}

private fun lookup(tokens: Tokens, path: String): Any? {
    var cur: Any? = tokens
    for (seg in path.split(".")) {
        cur = (cur.asGroup() ?: return null)[seg]
    }
    return cur
}

/**
 * Copy of [tokens] with every `"{path}"` alias replaced by the value it
 * points at (a leaf or a whole group). An alias that is missing or part of a
 * cycle is reported through [report] and left as written.
 */
fun resolveTokenAliases(tokens: Tokens, report: (problem: String) -> Unit = {}): Tokens {
    fun follow(value: Any?, at: String): Any? {
        val seen = mutableListOf(at)
        var cur = value
        repeat(MAX_ALIAS_DEPTH) {
            val target = (cur as? String)?.let { ALIAS.matchEntire(it) }?.groupValues?.get(1)
                ?: return cur
            if (target in seen || at.startsWith("$target.")) {
                report("Token alias cycle: ${(seen + target).joinToString(" -> ")}")
                return value
            }
            val next = lookup(tokens, target)
            if (next == null) {
                report("Token \"$at\" aliases \"$target\", which is not defined")
                return value
            }
            seen.add(target)
            cur = next
        }
        report("Token \"$at\" has an alias chain longer than $MAX_ALIAS_DEPTH")
        return value
    }

    fun walk(group: Tokens, prefix: String, depth: Int): Tokens {
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in group) {
            val at = if (prefix.isEmpty()) k else "$prefix.$k"
            val resolved = if (v is Map<*, *>) v else follow(v, at)
            // A group reached through an alias can itself hold aliases (and
            // could alias back into its own parent), hence the depth bound.
            val asGroup = resolved.asGroup()
            out[k] = if (asGroup != null && depth < MAX_ALIAS_DEPTH) walk(asGroup, at, depth + 1) else resolved
        }
        return out
    }
    return walk(tokens, "", 0)
}

private fun warnUnreferenceableKeys(tokens: Tokens, prefix: String, warned: MutableSet<String>) {
    for ((k, v) in tokens) {
        val at = if (prefix.isEmpty()) k else "$prefix.$k"
        if (!REFERENCEABLE_KEY.matches(k) && warned.add(at)) {
            themeLog.warn(
                "Token key \"$at\" cannot be referenced from a template; use letters, digits and \"_\" only"
            )
        }
        v.asGroup()?.let { warnUnreferenceableKeys(it, at, warned) }
    }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The tokens a theme and all of its forks share. Guarded by its own monitor. */
private class TokenStore(var base: Tokens, val schemes: LinkedHashMap<String, Tokens>)

/**
 * The app's design tokens and active color scheme. Create one with
 * [createTheme]; see the file header for how it reaches templates.
 *
 * Thread-safe. A change is published to every attached engine before the
 * mutating call returns — also when that call is made from an action
 * handler: [NativeEngine] runs handlers after the native dispatch call has
 * returned (the same reason [ObservableState] writes go straight to the
 * engine), so there is nothing to re-enter and nothing to defer.
 *
 * No lock of this class is held while an engine or a listener is called, so
 * a render callback (or any code running inside an engine) may read or
 * change the theme freely. When changes race, or one is made while a
 * publish is in progress (from another thread, or from a render callback of
 * that very publish), the thread already publishing sends the newest
 * snapshot again once it is done: every engine ends on the latest tokens,
 * and such a call may return just before they are delivered.
 */
class Theme private constructor(options: ThemeOptions, shared: TokenStore?) {
    /** Create a theme from [options]. Prefer [createTheme]. */
    constructor(options: ThemeOptions = ThemeOptions()) : this(options, null)

    private val store: TokenStore = shared
        ?: TokenStore(options.tokens, LinkedHashMap(options.schemes))
    private val lock = Any()
    private var currentPreference: String = SYSTEM_SCHEME
    private var system: SystemColorScheme = options.systemScheme
    private var resolved: Tokens = emptyMap()
    private var aliasProblems: List<String> = emptyList()
    private val engines = LinkedHashSet<IEngine>()
    private val listeners = CopyOnWriteArrayList<ThemeChangeListener>()
    private val warned = HashSet<String>()
    private val onMissingToken = options.onMissingToken

    /** Bumped (under `lock`) on every change to what gets published. */
    private var version = 0L

    /** True while one thread is delivering snapshots to the engines. */
    private var publishing = false

    /** A change arrived while [publishing]; the publisher goes round again. */
    private var republish = false

    init {
        if (isSelectable(options.scheme)) {
            currentPreference = options.scheme
        } else {
            themeLog.warn("Unknown color scheme \"${options.scheme}\"; following the system scheme")
        }
        if (shared == null) {
            warnUnreferenceableKeys(store.base, "", warned)
            store.schemes.values.forEach { warnUnreferenceableKeys(it, "", warned) }
        }
        rebuild()
    }

    /** The scheme in effect: the preference, or the system scheme when it is `"system"`. */
    val scheme: String
        get() = synchronized(lock) { effectiveScheme() }

    /** What was asked for: a scheme name or `"system"`. */
    val preference: String
        get() = synchronized(lock) { currentPreference }

    /** The platform's scheme as last reported. */
    val systemScheme: SystemColorScheme
        get() = synchronized(lock) { system }

    /** Scheme names that have overrides defined. */
    val schemes: List<String>
        get() = synchronized(store) { store.schemes.keys.toList() }

    /** The `appearance` data-source payload. */
    val meta: ThemeMeta
        get() = synchronized(lock) { ThemeMeta(effectiveScheme(), currentPreference, system, schemes) }

    /** The resolved tokens currently published as `theme`. */
    val tokens: Tokens
        get() = synchronized(lock) { resolved }

    /** Alias problems (missing target, cycle) in the active scheme's tokens. */
    val problems: List<String>
        get() = synchronized(lock) { aliasProblems }

    /**
     * Select a scheme by name, or `"system"` to follow the platform, then
     * republish to every attached engine.
     *
     * @throws IllegalArgumentException for a name that is neither `light` /
     *   `dark` / `"system"` nor defined in `schemes`.
     */
    fun setScheme(preference: String) {
        val meta = synchronized(lock) {
            require(isSelectable(preference)) {
                "Unknown color scheme \"$preference\". Known: ${(listOf(SYSTEM_SCHEME) + selectable()).joinToString(", ")}"
            }
            if (preference == currentPreference) return
            val before = effectiveScheme()
            currentPreference = preference
            changed(before)
        }
        publish()
        notifyListeners(meta)
    }

    /** Flip between `light` and `dark`, starting from whichever is in effect. */
    fun toggle() {
        setScheme(if (scheme == SystemColorScheme.DARK.id) SystemColorScheme.LIGHT.id else SystemColorScheme.DARK.id)
    }

    /**
     * Report the platform's scheme. Takes effect immediately when the
     * preference is `"system"`; otherwise it is remembered for when it is.
     */
    fun setSystemScheme(scheme: SystemColorScheme) {
        val meta = synchronized(lock) {
            if (scheme == system) return
            val before = effectiveScheme()
            system = scheme
            changed(before)
        }
        publish()
        notifyListeners(meta)
    }

    /**
     * Merge more tokens in — into the base set, or into [scheme]'s
     * overrides — and republish. This is how a component package
     * contributes defaults.
     */
    fun extend(tokens: Tokens, scheme: String? = null) {
        val meta = synchronized(lock) {
            warnUnreferenceableKeys(tokens, "", warned)
            synchronized(store) {
                if (scheme == null) {
                    store.base = mergeTokens(store.base, tokens)
                } else {
                    store.schemes[scheme] = mergeTokens(store.schemes[scheme], tokens)
                }
            }
            if (scheme != null && scheme != effectiveScheme()) return
            rebuild()
            version++
            meta
        }
        publish()
        notifyListeners(meta)
    }

    /** Whether [path] resolves in the active scheme. */
    fun has(path: String): Boolean = lookup(tokens, path) != null

    /**
     * A token's value in the active scheme (a leaf, or a nested map for a
     * group), for use in handlers. A missing token returns `null` and warns
     * once.
     */
    fun token(path: String): Any? {
        val (value, activeScheme, firstMiss) = synchronized(lock) {
            val v = lookup(resolved, path)
            Triple(v, effectiveScheme(), v == null && warned.add("missing:$path"))
        }
        if (firstMiss) {
            themeLog.warn("Missing theme token \"$path\" for scheme \"$activeScheme\"")
            onMissingToken?.invoke(path, activeScheme)
        }
        return value
    }

    /**
     * Publish `theme` and `appearance` to [engine] now and on every change.
     * Returns a function that stops publishing (it does not remove the
     * contexts).
     */
    fun attach(engine: IEngine): () -> Unit {
        val first = synchronized(lock) {
            engines.add(engine)
            snapshot()
        }
        // Delivered here, not left to a publish that may be running on
        // another thread: the caller renders right after this returns.
        publishTo(engine, first)
        // A change that raced the delivery above may have reached this
        // engine first; publishing again leaves it on the newest snapshot.
        if (synchronized(lock) { version != first.version }) publish()
        return { synchronized(lock) { engines.remove(engine) } }
    }

    /** Listen for scheme / token changes. Returns an unsubscribe function. */
    fun onChange(listener: ThemeChangeListener): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /**
     * A new instance with its own scheme preference that shares this one's
     * tokens — one per [HypenServer] session.
     */
    fun fork(preference: String = this.preference): Theme = Theme(
        ThemeOptions(scheme = preference, systemScheme = systemScheme, onMissingToken = onMissingToken),
        store,
    )

    // ── internals (callers hold `lock` unless noted) ───────────────────────

    private fun effectiveScheme(): String =
        if (currentPreference == SYSTEM_SCHEME) system.id else currentPreference

    private fun selectable(): List<String> = synchronized(store) {
        (SystemColorScheme.entries.map { it.id } + store.schemes.keys).distinct()
    }

    private fun isSelectable(preference: String): Boolean =
        preference == SYSTEM_SCHEME || preference in selectable()

    private fun changed(schemeBefore: String): ThemeMeta {
        if (effectiveScheme() != schemeBefore) rebuild()
        version++
        return meta
    }

    private fun rebuild() {
        val merged = synchronized(store) {
            val overrides = store.schemes[effectiveScheme()]
            if (overrides != null) mergeTokens(store.base, overrides) else store.base
        }
        val found = mutableListOf<String>()
        resolved = resolveTokenAliases(merged) { problem ->
            found.add(problem)
            if (warned.add(problem)) themeLog.warn(problem)
        }
        aliasProblems = found
    }

    /** What one publish delivers: both payloads as of [version]. */
    private class Snapshot(val meta: Map<String, Any?>, val tokens: Tokens, val version: Long)

    private fun snapshot() = Snapshot(meta.toMap(), resolved, version)

    /** Called WITHOUT `lock`: the engine may call back into this theme. */
    private fun publishTo(engine: IEngine, snapshot: Snapshot) {
        engine.setContext(THEME_META_PROVIDER, snapshot.meta)
        engine.setContext(THEME_TOKENS_PROVIDER, snapshot.tokens)
    }

    /**
     * Deliver the current snapshot to every attached engine, in attach
     * order. Called WITHOUT `lock`, after the change it publishes.
     *
     * One thread publishes at a time, and none waits for another: a caller
     * that finds a publish in progress only asks for another round, and the
     * publishing thread re-reads the snapshot until no change arrived during
     * its last round. So engines never go back to an older snapshot, and a
     * thread that is inside an engine (holding whatever that engine holds)
     * can change the theme without waiting on a publisher that is itself
     * waiting for that engine.
     */
    private fun publish() {
        synchronized(lock) {
            if (publishing) {
                republish = true
                return
            }
            publishing = true
        }
        try {
            while (true) {
                val (snapshot, targets) = synchronized(lock) {
                    republish = false
                    snapshot() to engines.toList()
                }
                for (engine in targets) {
                    try {
                        publishTo(engine, snapshot)
                    } catch (e: Exception) {
                        themeLog.error("Failed to publish theme context: ${e.message ?: e.toString()}")
                    }
                }
                synchronized(lock) {
                    if (!republish) {
                        publishing = false
                        return
                    }
                }
            }
        } catch (e: Throwable) {
            synchronized(lock) { publishing = false }
            throw e
        }
    }

    /** Called without `lock`, so a listener may freely call back into the theme. */
    private fun notifyListeners(meta: ThemeMeta) {
        for (listener in listeners) {
            try {
                listener(meta)
            } catch (e: Exception) {
                themeLog.error("Theme change listener threw: ${e.message ?: e.toString()}")
            }
        }
    }
}

/** Create the app's theme from [options]. Register it once (e.g. `HypenServer { theme(theme) }`). */
fun createTheme(options: ThemeOptions): Theme = Theme(options)

/**
 * Create the app's theme:
 *
 * ```kotlin
 * val theme = createTheme(
 *     tokens = mapOf("color" to mapOf("surface" to "#ffffff", "primary" to "{color.brand}", "brand" to "#0066ff")),
 *     schemes = mapOf("dark" to mapOf("color" to mapOf("surface" to "#111111"))),
 * )
 * ```
 */
fun createTheme(
    tokens: Tokens = emptyMap(),
    schemes: Map<String, Tokens> = emptyMap(),
    scheme: String = SYSTEM_SCHEME,
    systemScheme: SystemColorScheme = SystemColorScheme.LIGHT,
    onMissingToken: ((path: String, scheme: String) -> Unit)? = null,
): Theme = Theme(ThemeOptions(tokens, schemes, scheme, systemScheme, onMissingToken))
