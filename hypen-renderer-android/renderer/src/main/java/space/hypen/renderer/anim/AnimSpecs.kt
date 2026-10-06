package space.hypen.renderer.anim

import com.squareup.moshi.JsonReader
import okio.Buffer

/**
 * Vocabulary + defensive parsing for the `__anim.*` prop channel.
 *
 * Mirrors the normative `@hypen-space/core/animation` module (`parseAnimProps`
 * and friends) and its Rust twin `hypen-engine-rs/src/ir/anim.rs`. Nothing in
 * this file touches Compose or Android: it is plain Kotlin so the whole
 * protocol vocabulary is exercised by JVM unit tests.
 *
 * Parsing is TOLERANT by contract (protocol invariant 6, "snap, don't
 * error"): a malformed channel degrades to `null` and the renderer snaps to
 * the correct final state. Nothing here throws.
 */

/** Prefix shared by every animation channel prop. */
const val ANIM_PROP_PREFIX = "__anim."

/** `.transition(...)` → `{ duration, curve, delay?, props? }`. */
const val ANIM_TRANSITION_PROP = "__anim.transition"

/** `.enter(...)` → `{ presets, duration, curve, delay?, from? }`. */
const val ANIM_ENTER_PROP = "__anim.enter"

/** `.exit(...)` → `{ presets, duration, curve, delay?, to? }`. */
const val ANIM_EXIT_PROP = "__anim.exit"

/** `.layout(...)` → `{ duration, curve, delay? }` (FLIP intent; snapped in v1). */
const val ANIM_LAYOUT_PROP = "__anim.layout"

/** `.animate(preset, ...)` → `{ preset, duration, repeat, curve, delay? }`. */
const val ANIM_ANIMATE_PROP = "__anim.animate"

/** `.motion(essential)` → `{ essential: true }` (reduced-motion opt-out). */
const val ANIM_MOTION_PROP = "__anim.motion"

/** `.states(...)` → `{ label: "<matched label>" }`. */
const val ANIM_STATES_PROP = "__anim.states"

/** `.onAnimationComplete(@actions.x)` — ordinary applicator, base prop name. */
const val ANIM_COMPLETE_PROP = "onAnimationComplete"

/**
 * Grace added to `duration + delay` before the timeout backbone finalizes a
 * playback whose natural-settle signal never arrived (`dom/anim.ts`
 * `SETTLE_GRACE_MS`). Pinned cross-renderer.
 */
const val SETTLE_GRACE_MS = 80L

/** Fixed pixel travel of a `slide` enter/exit preset (DOM/canvas parity). */
const val SLIDE_OFFSET_DP = 24f

/** Initial scale of a `scale` enter/exit preset (DOM/canvas parity). */
const val PRESET_SCALE_FROM = 0.95f

/**
 * Curve vocabulary. `spring` is NOT a physics spring: the wire contract is
 * the fixed overshoot bezier `cubic-bezier(0.34, 1.56, 0.64, 1)`. The control
 * points are the pinned `CURVE_BEZIER_POINTS` from
 * `@hypen-space/core/animation`; `y1`/`y2` are unclamped so overshoot curves
 * exceed 1 mid-range.
 */
enum class AnimCurve(
    val wire: String,
    val x1: Float,
    val y1: Float,
    val x2: Float,
    val y2: Float,
) {
    LINEAR("linear", 0f, 0f, 1f, 1f),
    EASE_IN("easeIn", 0.42f, 0f, 1f, 1f),
    EASE_OUT("easeOut", 0f, 0f, 0.58f, 1f),
    EASE_IN_OUT("easeInOut", 0.42f, 0f, 0.58f, 1f),
    SPRING("spring", 0.34f, 1.56f, 0.64f, 1f),
    ;

    companion object {
        fun from(token: Any?): AnimCurve? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

/** Enter/exit preset vocabulary. */
enum class AnimPreset(val wire: String) {
    FADE("fade"),
    SLIDE("slide"),
    SCALE("scale"),
    ;

    companion object {
        fun from(token: Any?): AnimPreset? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

/** Direction vocabulary for `.enter(from:)` / `.exit(to:)`. */
enum class AnimDirection(val wire: String) {
    TOP("top"),
    BOTTOM("bottom"),
    LEADING("leading"),
    TRAILING("trailing"),
    ;

    companion object {
        fun from(token: Any?): AnimDirection? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

/**
 * `.animate(<preset>)` vocabulary with the normative per-preset defaults
 * (`ANIMATE_PRESETS`, core/animation.ts). Keyframe SHAPES are renderer-owned;
 * the names and timing defaults are shared.
 */
enum class AnimatePreset(
    val wire: String,
    val defaultDuration: Int,
    /** null == "loop" (forever). */
    val defaultRepeat: Int?,
    val defaultCurve: AnimCurve,
) {
    PULSE("pulse", 1200, null, AnimCurve.EASE_IN_OUT),
    SPIN("spin", 800, null, AnimCurve.LINEAR),
    SHIMMER("shimmer", 1500, null, AnimCurve.LINEAR),
    SHAKE("shake", 400, 1, AnimCurve.EASE_IN_OUT),
    ;

    companion object {
        fun from(token: Any?): AnimatePreset? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

/**
 * The animatable-prop whitelist (Hypen prop names). Mirrors the normative
 * `ANIMATABLE_PROPS` in `@hypen-space/core` and its Rust twin. Props outside
 * it snap even when the node carries a `.transition`.
 */
val ANIMATABLE_PROPS: Set<String> = setOf(
    "opacity",
    "translateX",
    "translateY",
    "scale",
    "rotate",
    "color",
    "backgroundColor",
    "borderColor",
    "cornerRadius",
    "padding",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "paddingHorizontal",
    "paddingVertical",
    "margin",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    "marginHorizontal",
    "marginVertical",
    "width",
    "height",
    "gap",
    "fontSize",
)

/** Whitelisted props whose values interpolate in RGBA rather than numerically. */
val COLOR_ANIMATABLE_PROPS: Set<String> = setOf("color", "backgroundColor", "borderColor")

/** `__anim.transition` — implicit prop-change animation. */
data class TransitionSpec(
    val duration: Int,
    val curve: AnimCurve,
    val delay: Int = 0,
    /** Scoped Hypen prop list; null = every animatable prop transitions. */
    val props: List<String>? = null,
) {
    /** True when [base] (an unsuffixed Hypen prop name) is in scope. */
    fun covers(base: String): Boolean = props == null || base in props
}

/** `__anim.enter` — played when the node is inserted. */
data class EnterSpec(
    val presets: List<AnimPreset>,
    val duration: Int,
    val curve: AnimCurve,
    val delay: Int = 0,
    val from: AnimDirection? = null,
)

/** `__anim.exit` — played before the deferred remove finalizes. */
data class ExitSpec(
    val presets: List<AnimPreset>,
    val duration: Int,
    val curve: AnimCurve,
    val delay: Int = 0,
    val to: AnimDirection? = null,
)

/** `__anim.layout` — FLIP intent on `move` patches. Parsed, snapped in v1. */
data class LayoutSpec(
    val duration: Int,
    val curve: AnimCurve,
    val delay: Int = 0,
)

/** `__anim.animate` — ambient preset timeline playback. */
data class AnimateSpec(
    val preset: AnimatePreset,
    val duration: Int,
    val curve: AnimCurve,
    /** null == loop forever. */
    val repeat: Int?,
    val delay: Int = 0,
) {
    val loops: Boolean get() = repeat == null
}

/**
 * All parsed channels for one node. A `null` channel means "absent or
 * malformed" — either way the renderer snaps.
 */
data class NodeAnimSpecs(
    val transition: TransitionSpec? = null,
    val enter: EnterSpec? = null,
    val exit: ExitSpec? = null,
    val layout: LayoutSpec? = null,
    val animate: AnimateSpec? = null,
    val motionEssential: Boolean = false,
    val statesLabel: String? = null,
) {
    val isEmpty: Boolean
        get() = transition == null && enter == null && exit == null &&
            layout == null && animate == null && !motionEssential && statesLabel == null
}

/** What settled, and (for `.states`) which pose. */
data class AnimationCompletion(
    val animation: String,
    val state: String? = null,
) {
    /** Payload exactly as the normative contract specifies. */
    fun toPayload(): Map<String, Any?> =
        if (state == null) mapOf("animation" to animation)
        else mapOf("animation" to animation, "state" to state)
}

/**
 * Defensive parsers for the `__anim.*` channels. Every entry point returns
 * null / false / a default rather than throwing.
 */
object AnimParse {
    /**
     * A channel value normally arrives as a Map (Moshi-decoded JSON), but a
     * stringified object is tolerated for hosts that pass raw JSON through.
     */
    fun channelObject(value: Any?): Map<*, *>? =
        when (value) {
            is Map<*, *> -> value
            is String -> parseJsonObject(value)
            else -> null
        }

    private fun parseJsonObject(text: String): Map<*, *>? =
        try {
            JsonReader.of(Buffer().writeUtf8(text)).use { reader ->
                reader.readJsonValue() as? Map<*, *>
            }
        } catch (_: Exception) {
            null
        }

    /** Finite, non-negative millisecond count. Wire numbers arrive as Double. */
    private fun duration(value: Any?): Int? {
        val number = value as? Number ?: return null
        val ms = number.toDouble()
        if (!ms.isFinite() || ms < 0.0) return null
        return ms.toInt()
    }

    private data class Timing(val duration: Int, val curve: AnimCurve, val delay: Int)

    /**
     * Shared duration/curve/delay core of every channel. The engine always
     * emits duration + curve (defaults filled at lowering), so a missing or
     * invalid one marks the whole channel malformed.
     */
    private fun timing(obj: Map<*, *>): Timing? {
        val ms = duration(obj["duration"]) ?: return null
        val curve = AnimCurve.from(obj["curve"]) ?: return null
        return Timing(ms, curve, duration(obj["delay"]) ?: 0)
    }

    /**
     * Filter a presets array to the known vocabulary; a non-list, or nothing
     * recognizable, voids the channel (playing "no presets" is a no-op).
     */
    private fun presets(value: Any?): List<AnimPreset>? {
        val list = value as? List<*> ?: return null
        val parsed = list.mapNotNull { AnimPreset.from(it) }
        return parsed.ifEmpty { null }
    }

    fun transition(value: Any?): TransitionSpec? {
        val obj = channelObject(value) ?: return null
        val timing = timing(obj) ?: return null
        val rawProps = obj["props"] ?: return TransitionSpec(timing.duration, timing.curve, timing.delay)
        val list = rawProps as? List<*> ?: return null
        val scoped = list.filterIsInstance<String>().filter { it in ANIMATABLE_PROPS }
        // A scope that filters to nothing animates nothing — same as no channel.
        if (scoped.isEmpty()) return null
        return TransitionSpec(timing.duration, timing.curve, timing.delay, scoped)
    }

    fun enter(value: Any?): EnterSpec? {
        val obj = channelObject(value) ?: return null
        val timing = timing(obj) ?: return null
        val presets = presets(obj["presets"]) ?: return null
        // An invalid direction is dropped, not channel-voiding.
        return EnterSpec(presets, timing.duration, timing.curve, timing.delay, AnimDirection.from(obj["from"]))
    }

    fun exit(value: Any?): ExitSpec? {
        val obj = channelObject(value) ?: return null
        val timing = timing(obj) ?: return null
        val presets = presets(obj["presets"]) ?: return null
        return ExitSpec(presets, timing.duration, timing.curve, timing.delay, AnimDirection.from(obj["to"]))
    }

    fun layout(value: Any?): LayoutSpec? {
        val obj = channelObject(value) ?: return null
        val timing = timing(obj) ?: return null
        return LayoutSpec(timing.duration, timing.curve, timing.delay)
    }

    fun animate(value: Any?): AnimateSpec? {
        val obj = channelObject(value) ?: return null
        val preset = AnimatePreset.from(obj["preset"]) ?: return null
        val timing = timing(obj) ?: return null
        val repeat = repeat(obj["repeat"]) ?: return null
        return AnimateSpec(preset, timing.duration, timing.curve, repeat.value, timing.delay)
    }

    /** Boxed so "loop" (null iterations) is distinguishable from "invalid". */
    private data class Repeat(val value: Int?)

    private fun repeat(value: Any?): Repeat? =
        when {
            value == "loop" -> Repeat(null)
            value is Number -> {
                val d = value.toDouble()
                if (d.isFinite() && d >= 1.0 && d == Math.floor(d)) Repeat(d.toInt()) else null
            }
            else -> null
        }

    /**
     * `__anim.states` → the active pose label.
     *
     * The engine emits the OBJECT form `{"label": "..."}`; a bare string is
     * tolerated because a host relaying raw values may flatten it (the
     * desktop renderer shipped a bug reading it as a bare string only).
     * Anything else degrades to null — "no matched label".
     */
    fun statesLabel(value: Any?): String? {
        channelObject(value)?.let { return it["label"] as? String }
        return value as? String
    }

    /**
     * `__anim.motion` → the `.motion(essential)` opt-out. Only `essential:
     * true` exempts the node from reduced motion; anything else is false.
     */
    fun motionEssential(value: Any?): Boolean {
        val obj = channelObject(value) ?: return false
        return obj["essential"] == true
    }

    /**
     * Parse every animation channel off a node's props map. Props without an
     * `__anim.` prefix are ignored.
     */
    fun node(props: Map<String, Any?>): NodeAnimSpecs =
        NodeAnimSpecs(
            transition = transition(props[ANIM_TRANSITION_PROP]),
            enter = enter(props[ANIM_ENTER_PROP]),
            exit = exit(props[ANIM_EXIT_PROP]),
            layout = layout(props[ANIM_LAYOUT_PROP]),
            animate = animate(props[ANIM_ANIMATE_PROP]),
            motionEssential = motionEssential(props[ANIM_MOTION_PROP]),
            statesLabel = statesLabel(props[ANIM_STATES_PROP]),
        )

    /**
     * Normalize a `batchAnimation` prelude spec into the transition spec the
     * transaction glides with. The engine already fills `duration` (250 ms
     * default) and normalizes a bare curve string before the wire, so this is
     * the plain `.transition` parse; a malformed spec degrades to null =
     * unstamped (sanctioned snap).
     */
    fun batchSpec(spec: Map<String, Any?>?): TransitionSpec? = transition(spec)

    /**
     * The base Hypen prop name behind a wire prop key: `backgroundColor.0` →
     * `backgroundColor`. Variant-marked names (`color@md`, `color:hover`) are
     * not plain prop changes and never glide, so they resolve to null.
     */
    fun animatableBase(name: String): String? {
        if (name.startsWith(ANIM_PROP_PREFIX)) return null
        val dot = name.indexOf('.')
        val base = if (dot == -1) name else name.substring(0, dot)
        if (base.contains('@') || base.contains(':')) return null
        return if (base in ANIMATABLE_PROPS) base else null
    }
}
