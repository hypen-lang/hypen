package space.hypen.renderer.dnd

import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.anim.AnimParse
import space.hypen.renderer.applicators.translateDp
import space.hypen.renderer.model.ActionValue
import kotlin.math.roundToLong

private val log = HypenLoggers.renderer.child("Dnd")

/**
 * Vocabulary + defensive parsing for the `__dnd.*` prop channel.
 *
 * Mirrors the normative `@hypen-space/core/dnd` module and its Rust twin
 * `hypen-engine-rs/src/ir/dnd.rs` (plan `hypen-web/docs/dnd.md`
 * §2 props, §4 actions + event payload). Nothing in this file touches Compose
 * or Android: it is plain Kotlin so the whole protocol vocabulary is
 * exercised by JVM unit tests.
 *
 * Parsing is TOLERANT by contract: a malformed channel degrades to `null`
 * ("this node has no such role") and the renderer shows static UI. Nothing
 * here throws on author input.
 */

/** Prefix shared by every DnD channel prop; routing is one `startsWith`. */
const val DND_PROP_PREFIX = "__dnd."

/** `.draggable(...)` → static `{ group, handle, activation }`. */
const val DND_SOURCE_PROP = "__dnd.source"

/** `.draggable(payload:)` → bindable value; absent if not given. */
const val DND_SOURCE_PAYLOAD_PROP = "__dnd.sourcePayload"

/** `.draggable(enabled:)` → bindable bool; absent ⇒ true. */
const val DND_SOURCE_ENABLED_PROP = "__dnd.sourceEnabled"

/** Static string — the `ForEach` item key. Absent outside a `ForEach` ⇒ node id. */
const val DND_KEY_PROP = "__dnd.key"

/** `.dropZone(...)` → static `{ group, band }`. */
const val DND_ZONE_PROP = "__dnd.zone"

/**
 * `.dropZone(files: true, accept:)` is the same `__dnd.zone` channel with
 * `"files": true` and `"accept": string|null` added (see [DndZoneSpec]).
 */

/** `.dropZone(id:)` → bindable string; absent ⇒ resolved `id` prop, else node id. */
const val DND_ZONE_ID_PROP = "__dnd.zoneId"

/** `.dropZone(enabled:)` → bindable bool; absent ⇒ true. */
const val DND_ZONE_ENABLED_PROP = "__dnd.zoneEnabled"

/** `.sortable(...)` → static `{ group, axis }`; write target is the node's own `bind`. */
const val DND_SORT_PROP = "__dnd.sort"

/** `.pinboard(...)` → static `{ group, xKey, yKey, grid, bounds, units }`. */
const val DND_PIN_PROP = "__dnd.pin"

/** Static string stamped on reserved-mode pinboard sources (translate injection). */
const val DND_PIN_GROUP_PROP = "__dnd.pinGroup"

/**
 * `__anim.statePoses` — the header-less `.states` pose table
 * (`{ "<label>": { "<loweredPropKey>": value } }`, plan §2.1). Emitted only on
 * nodes carrying a `__dnd.*` prop; its labels are driven by this runtime.
 */
const val ANIM_STATE_POSES_PROP = "__anim.statePoses"

/** `__hypen_reorder { fromPath, from, toPath, to }` (or `{ path, from, to }`). */
const val DND_REORDER_ACTION = "__hypen_reorder"

/** `__hypen_pin { path, x, y, xKey, yKey }`. */
const val DND_PIN_ACTION = "__hypen_pin"

/** Root key of the reserved pin-position subtree in module state (§3). */
const val DND_RESERVED_STATE_KEY = "__dnd"

/** Runtime `.states` label on the dragged source while lifted. */
const val DND_LABEL_LIFTED = "lifted"

/** Runtime `.states` label on a zone while a compatible drag hovers it. */
const val DND_LABEL_OVER = "over"

/** Default `.dropZone` band — the middle 50% along the sort axis is "into". */
const val DND_DEFAULT_BAND = 0.5

/** Reserved named argument on `.onDragOver(@a, dwell:)`; stripped from the payload. */
const val DND_DRAG_OVER_DWELL_KEY = "dwell"

/** Default hover dwell before `.onDragOver` fires. */
const val DND_DEFAULT_DWELL_MS = 500L

/** Hold window after a drop before local transforms are released (no-flash fallback). */
const val DND_HOLD_TIMEOUT_MS = 500L

/** Pointer travel (dp) below which a gesture is a tap, not a drag claim (§6.1). */
const val DND_SLOP_DP = 6f

/** Long-press activation delay for touch outside axis-constrained sortables (§6.1). */
const val DND_PRESS_MS = 300L

/** Sibling gap-opening transition (DOM parity: `transform 150ms ease-out`). */
const val DND_SHIFT_DURATION_MS = 150

/**
 * The six event applicators (§2.2 / §4.2), plus `.onFileDragEnter` (files
 * from the OS), by their lowered base prop name.
 */
enum class DndEvent(val prop: String) {
    DRAG_START("onDragStart"),
    DRAG_OVER("onDragOver"),
    DROP("onDrop"),
    SORT("onSort"),
    PIN("onPin"),
    DRAG_END("onDragEnd"),

    /** On a `files: true` zone: an OS file drag entered it (once per entry). */
    FILE_DRAG_ENTER("onFileDragEnter"),
}

/** `type` of the default `.onFileDragEnter` payload. */
const val DND_FILE_DRAG_ENTER_TYPE = "filedragenter"

enum class DndActivation(val wire: String) {
    AUTO("auto"),
    SLOP("slop"),
    PRESS("press"),
    IMMEDIATE("immediate"),
    ;

    companion object {
        fun from(token: Any?): DndActivation? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

enum class DndAxis(val wire: String) {
    X("x"),
    Y("y"),
    ;

    val cross: DndAxis get() = if (this == X) Y else X

    companion object {
        fun from(token: Any?): DndAxis? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

enum class DndBounds(val wire: String) {
    CLAMP("clamp"),
    FREE("free"),
    ;

    companion object {
        fun from(token: Any?): DndBounds? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

enum class DndUnits(val wire: String) {
    PX("px"),
    FRACTION("fraction"),
    ;

    companion object {
        fun from(token: Any?): DndUnits? =
            (token as? String)?.let { t -> entries.firstOrNull { it.wire == t } }
    }
}

/** `__dnd.source` — `.draggable`. */
data class DndSourceSpec(
    val group: String?,
    /** This subtree is the only lift surface. */
    val handle: Boolean,
    val activation: DndActivation,
)

/** `__dnd.zone` — `.dropZone`. */
data class DndZoneSpec(
    val group: String?,
    /** Fraction (0..1) of the item along the sort axis that resolves to "into". */
    val band: Double,
    /**
     * `.dropZone(files: true)` — also react to content dragged in from
     * OUTSIDE the app (the OS, another app). Absent on the wire ⇒ false.
     */
    val files: Boolean = false,
    /** `.dropZone(accept:)` — an `<input accept>` filter; null ⇒ any. Only meaningful with [files]. */
    val accept: String? = null,
)

/** `__dnd.sort` — `.sortable`. */
data class DndSortSpec(
    val group: String?,
    val axis: DndAxis,
)

/** `__dnd.pin` — `.pinboard`. */
data class DndPinSpec(
    val group: String?,
    val xKey: String,
    val yKey: String,
    val grid: Double?,
    val bounds: DndBounds,
    val units: DndUnits,
)

/** One end of a drag: which zone, and the slot within it (`null` = "into"). */
data class DndLocation(
    val zone: String,
    val index: Int?,
) {
    /** `{ zone, index }` in wire key order. */
    fun toPayload(): Map<String, Any?> = linkedMapOf("zone" to zone, "index" to index)
}

/** Band rule outcome for a `.dropZone` on a sortable item. */
enum class DndBand { BEFORE, INTO, AFTER }

/**
 * One parsed `.on*` event applicator: the action name, the extra named
 * arguments (merged UNDER the §4.2 payload — the §4.2 fields win), and the
 * `dwell` reserved argument for `onDragOver`.
 */
data class DndEventBinding(
    val actionName: String,
    val customPayload: Map<String, Any?>,
    val dwell: Long?,
)

/** Defensive parsers for the `__dnd.*` channels. Nothing here throws. */
object DndParse {
    private fun group(value: Any?): String? = (value as? String)?.takeIf { it.isNotEmpty() }

    private fun finite(value: Any?): Double? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() }

    private fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v

    /**
     * `__dnd.source`. Malformed (not an object) → null, the node is not
     * draggable. Missing or invalid fields degrade to the §2 defaults — the
     * engine always fills them, so a hole here is version drift, not author
     * error.
     */
    fun source(value: Any?): DndSourceSpec? {
        val obj = AnimParse.channelObject(value) ?: return null
        return DndSourceSpec(
            group = group(obj["group"]),
            handle = obj["handle"] == true,
            activation = DndActivation.from(obj["activation"]) ?: DndActivation.AUTO,
        )
    }

    /** `__dnd.zone`. `band` outside `[0,1]` clamps; a non-number is the default. */
    fun zone(value: Any?): DndZoneSpec? {
        val obj = AnimParse.channelObject(value) ?: return null
        val files = obj["files"] == true
        return DndZoneSpec(
            group = group(obj["group"]),
            band = finite(obj["band"])?.let { clamp01(it) } ?: DND_DEFAULT_BAND,
            files = files,
            // `accept` without `files` has no effect (the engine warns and
            // never emits it); ignore a stray one.
            accept = if (files) (obj["accept"] as? String)?.trim()?.takeIf { it.isNotEmpty() } else null,
        )
    }

    /** `__dnd.sort`. `axis` defaults to `y`. */
    fun sort(value: Any?): DndSortSpec? {
        val obj = AnimParse.channelObject(value) ?: return null
        return DndSortSpec(
            group = group(obj["group"]),
            axis = DndAxis.from(obj["axis"]) ?: DndAxis.Y,
        )
    }

    /** `__dnd.pin`. Defaults `x`/`y`, `grid null` (also for `grid <= 0`), `clamp`, `px`. */
    fun pin(value: Any?): DndPinSpec? {
        val obj = AnimParse.channelObject(value) ?: return null
        return DndPinSpec(
            group = group(obj["group"]),
            xKey = group(obj["xKey"]) ?: "x",
            yKey = group(obj["yKey"]) ?: "y",
            grid = finite(obj["grid"])?.takeIf { it > 0.0 },
            bounds = DndBounds.from(obj["bounds"]) ?: DndBounds.CLAMP,
            units = DndUnits.from(obj["units"]) ?: DndUnits.PX,
        )
    }

    /**
     * A bindable enabled flag (`__dnd.sourceEnabled` / `__dnd.zoneEnabled`).
     * Absent (null) ⇒ true; only an explicit `false` (or `"false"` for
     * raw-JSON hosts) disables.
     */
    fun enabled(value: Any?): Boolean = !(value == false || value == "false")

    /**
     * `__dnd.key` / `__dnd.zoneId` / `__dnd.pinGroup` / `id` — a nonempty
     * string, else null so callers apply their documented fallback. Numbers
     * are tolerated (a `ForEach` keyed by a numeric id) and stringified the
     * way the engine's `generate_item_key` does (`3`, not `3.0`).
     */
    fun string(value: Any?): String? =
        when (value) {
            is String -> value.takeIf { it.isNotEmpty() }
            is Number -> {
                val d = value.toDouble()
                if (!d.isFinite()) null
                else if (d == Math.floor(d) && Math.abs(d) < 1e15) d.toLong().toString()
                else d.toString()
            }
            else -> null
        }

    /**
     * `__anim.statePoses` → `{ label: { loweredPropKey: value } }`, or null.
     * Non-object pose entries are skipped.
     */
    fun poses(value: Any?): Map<String, Map<String, Any?>>? {
        val obj = AnimParse.channelObject(value) ?: return null
        val out = LinkedHashMap<String, Map<String, Any?>>()
        for ((label, pose) in obj) {
            val key = label as? String ?: continue
            val map = pose as? Map<*, *> ?: continue
            val entries = LinkedHashMap<String, Any?>()
            for ((k, v) in map) {
                val propKey = k as? String ?: continue
                entries[propKey] = v
            }
            out[key] = entries
        }
        return out
    }

    /**
     * Read one `.on*` event applicator off a node's props. The generic
     * lowering emits `onSort.0 = "@reorder"` plus sibling `onSort.<arg>`
     * props for named arguments; a bare `onSort` string or
     * `{ "0": "@actions.x", ...args }` object is tolerated. `dwell` on
     * `onDragOver` is parsed (non-negative number, else a warning and the
     * default) and stripped from the custom payload.
     */
    fun eventBinding(props: Map<String, Any?>, event: DndEvent): DndEventBinding? {
        val base = event.prop
        val custom = LinkedHashMap<String, Any?>()
        var actionRaw: Any? = props["$base.0"]
        if (actionRaw == null) {
            val bare = props[base]
            if (bare is Map<*, *>) {
                actionRaw = bare["0"] ?: bare["action"]
                for ((k, v) in bare) {
                    val key = k?.toString() ?: continue
                    if (key != "0" && key != "action") custom[key] = v
                }
            } else {
                actionRaw = bare
            }
        }
        val action = ActionValue.parse(actionRaw) ?: return null
        val prefix = "$base."
        for ((name, value) in props) {
            if (name.startsWith(prefix) && name != "$base.0") custom[name.substring(prefix.length)] = value
        }
        var dwell: Long? = null
        if (event == DndEvent.DRAG_OVER && custom.containsKey(DND_DRAG_OVER_DWELL_KEY)) {
            val raw = custom.remove(DND_DRAG_OVER_DWELL_KEY)
            val n =
                when (raw) {
                    is Number -> raw.toDouble()
                    is String -> raw.toDoubleOrNull()
                    else -> null
                }
            if (n != null && n.isFinite() && n >= 0.0) {
                dwell = n.toLong()
            } else {
                log.warn { "onDragOver dwell must be a non-negative number, got: $raw" }
            }
        }
        return DndEventBinding(action.actionName, custom, dwell)
    }

    /** True when [name] is a `__dnd.*` channel prop. */
    fun isChannel(name: String): Boolean = name.startsWith(DND_PROP_PREFIX)

    /** The base Hypen prop name behind a wire key: `translateX.0` → `translateX`. */
    fun baseOf(name: String): String {
        val dot = name.indexOf('.')
        return if (dot == -1) name else name.substring(0, dot)
    }
}

/**
 * Band rule for a `.dropZone` on a sortable item (§6.4): the middle `band`
 * fraction of the item along the sort axis resolves to INTO; the outer
 * `(1 - band) / 2` on either side fall through to the sortable's
 * before/after insertion. Boundaries are half-open: a pointer exactly at the
 * start of a band belongs to that band. Pointers outside the item resolve to
 * BEFORE / AFTER by side.
 */
fun resolveBand(pointerAlongAxis: Double, itemStart: Double, itemLength: Double, band: Double): DndBand {
    val b = if (band.isFinite()) band.coerceIn(0.0, 1.0) else DND_DEFAULT_BAND
    val length = if (itemLength.isFinite() && itemLength > 0.0) itemLength else 0.0
    val outer = (1.0 - b) / 2.0
    val beforeEnd = itemStart + length * outer
    val afterStart = itemStart + length * (1.0 - outer)
    return when {
        pointerAlongAxis < beforeEnd -> DndBand.BEFORE
        pointerAlongAxis >= afterStart -> DndBand.AFTER
        else -> DndBand.INTO
    }
}

/** Snap to the nearest multiple of [grid]; a null / non-positive grid is a no-op. */
fun snapToGrid(v: Double, grid: Double?): Double {
    if (!v.isFinite()) return v
    if (grid == null || !grid.isFinite() || grid <= 0.0) return v
    return Math.round(v / grid) * grid
}

/** Reserved-mode pin base path: `"__dnd.<group>.<key>"`. */
fun reservedPinPath(group: String, key: String): String = "$DND_RESERVED_STATE_KEY.$group.$key"

/** User-field-mode pin base path: `"<bindPath>.<index>"`. */
fun userPinPath(bindPath: String, index: Int): String = "$bindPath.$index"

/** Three-decimal rounding for coordinates that cross the wire (DOM `round3` parity). */
fun round3(v: Double): Double = (v * 1000.0).roundToLong() / 1000.0

/** The lowered translate applicator keys the engine injects on pinboard items (§3). */
const val DND_TRANSLATE_X_PROP = "translateX.0"
const val DND_TRANSLATE_Y_PROP = "translateY.0"

/**
 * The element's OWN engine translate in root px — what its `translateX.0` /
 * `translateY.0` applicators (dp; explicit `null` = 0, unparseable = no
 * transform, exactly as [translateDp] reads them) move its content by.
 *
 * Compose reports the LAYOUT rect for a node measured above its applicator
 * chain, and the injected translate layers are the innermost modifiers, so
 * the Compose layer adds this to every bounds report: the coordinator then
 * sees the RENDERED rect (`getBoundingClientRect` parity, §6.11 pinboard
 * geometry) and a re-pin of an already-positioned note dispatches base +
 * delta instead of delta-from-layout-origin.
 */
fun dndTranslatePx(props: Map<String, Any?>, density: Float): Pair<Float, Float> {
    val scale = if (density > 0f && density.isFinite()) density else 1f
    val tx = (translateDp(props[DND_TRANSLATE_X_PROP]) ?: 0f) * scale
    val ty = (translateDp(props[DND_TRANSLATE_Y_PROP]) ?: 0f) * scale
    return tx to ty
}

/**
 * What an OS drag tells us before the drop: the MIME types of its
 * `ClipDescription` (null when the platform did not say) and how many items
 * it holds (`0` when unknown — Android only exposes the `ClipData` at the
 * drop, so this is almost always 0 while hovering). Never names, URIs or
 * bytes.
 */
data class DndFileDragInfo(
    val mimeTypes: List<String>?,
    val items: Int = 0,
)

/**
 * Pure (JVM-testable) helpers for files drop zones: deciding whether a
 * platform drag is an EXTERNAL drag carrying content, and the `accept:`
 * filter. Nothing here reads drag content.
 */
object DndFileDrag {
    /** `ClipDescription.MIMETYPE_TEXT_INTENT` — an Intent, not content. */
    const val MIMETYPE_INTENT = "text/vnd.android.intent"

    /**
     * Classify a platform drag. Returns null — "not ours, ignore" — when:
     * - [hasLocalState]: the drag was started inside this activity with a
     *   local state object (an in-app platform drag; cross-app drags never
     *   carry one). Hypen's own in-app DnD never starts a platform drag at all
     *   (it is a pointer gesture), so it can't reach here either way.
     * - the drag carries no content: no description, no MIME types, or only
     *   an Intent.
     */
    fun classify(mimeTypes: List<String>?, hasLocalState: Boolean, items: Int = 0): DndFileDragInfo? {
        if (hasLocalState) return null
        val types = mimeTypes?.mapNotNull { normalize(it) } ?: return null
        if (types.isEmpty()) return null
        if (types.all { it == MIMETYPE_INTENT }) return null
        return DndFileDragInfo(types, if (items > 0) items else 0)
    }

    /** The comma-separated `accept` tokens, trimmed and lowercased; empty ones dropped. */
    fun acceptTokens(accept: String?): List<String> =
        accept?.split(',')?.mapNotNull { it.trim().lowercase().takeIf { t -> t.isNotEmpty() } } ?: emptyList()

    /**
     * Does a drag carrying [mimeTypes] match [accept]?
     * - No filter (null / blank) ⇒ match.
     * - Unknown types (null / empty) ⇒ match: the platform could not tell.
     * - Any `.ext` token ⇒ match: there are no file names before the drop.
     * - Otherwise at least one drag type must match one MIME token, with
     *   `type/ *` and `* / *` wildcards on either side (the same rule as
     *   `ClipDescription.compareMimeTypes`, plus a wildcard drag type such
     *   as `image/ *` overlapping a concrete token). Malformed tokens are
     *   skipped; a filter made only of malformed tokens matches anything.
     */
    fun accepts(accept: String?, mimeTypes: Collection<String>?): Boolean {
        val tokens = acceptTokens(accept)
        if (tokens.isEmpty()) return true
        val types = mimeTypes?.mapNotNull { normalize(it) }.orEmpty()
        if (types.isEmpty()) return true
        if (tokens.any { it.startsWith(".") }) return true
        val mimeTokens = tokens.filter { isMime(it) }
        if (mimeTokens.isEmpty()) return true
        return types.any { type -> mimeTokens.any { token -> mimeMatches(type, token) } }
    }

    /** Wildcard-aware MIME comparison (`*` on either side matches). */
    fun mimeMatches(a: String, b: String): Boolean {
        val x = split(normalize(a) ?: return false) ?: return false
        val y = split(normalize(b) ?: return false) ?: return false
        fun part(p: String, q: String) = p == "*" || q == "*" || p == q
        return part(x.first, y.first) && part(x.second, y.second)
    }

    private fun isMime(token: String): Boolean = token == "*" || split(token) != null

    private fun split(mime: String): Pair<String, String>? {
        if (mime == "*") return "*" to "*"
        val slash = mime.indexOf('/')
        if (slash <= 0 || slash == mime.length - 1) return null
        return mime.substring(0, slash) to mime.substring(slash + 1)
    }

    /** Lowercase, parameters (`;charset=…`) stripped; null when blank. */
    private fun normalize(mime: String?): String? =
        mime?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
}
