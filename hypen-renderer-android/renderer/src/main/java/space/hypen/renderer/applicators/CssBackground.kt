package space.hypen.renderer.applicators

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.asImageBitmap
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Parser for CSS `background` / `background-image` values.
 *
 * The engine lowers Tailwind and raw CSS straight onto the wire, so a
 * renderer receives real CSS strings:
 *
 * ```
 * backgroundImage.0 = linear-gradient(to bottom right, #818cf8, #7c3aed)
 * background.0      = linear-gradient(180deg, rgba(3,7,18,.08), rgba(3,7,18,.6)),
 *                     url('data:image/png;base64,…') center / cover no-repeat
 * ```
 *
 * Both used to be dropped on the floor: `background` was a pure alias for
 * `backgroundColor` (so anything that wasn't a flat colour parsed to null and
 * vanished) and `backgroundImage` was a stub that logged a warning. That is
 * why the home-screen example rendered with no wallpaper and no icon tiles.
 *
 * Splitting is paren- and quote-aware, which is the whole difficulty: a
 * layer list is comma-separated, but so are `rgba(3, 7, 18, 0.6)` and the
 * colour stops inside `linear-gradient(...)`. A naive `split(",")` shreds
 * both.
 *
 * CSS paints the FIRST layer on top; [Layers.brushes] is returned in paint
 * order (bottom first) so callers can chain modifiers left to right.
 */
internal object CssBackground {

    /** One image or gradient layer from a `background` value. */
    sealed interface PaintLayer {
        data class Image(val uri: String) : PaintLayer

        data class Gradient(val brush: Brush) : PaintLayer
    }

    /** One parsed `background` value, decomposed into paintable layers. */
    data class Layers(
        /** Solid colour. CSS always paints `background-color` bottom-most. */
        val color: Color? = null,
        /**
         * Image and gradient layers in PAINT order (bottom first) — CSS
         * declaration order reversed.
         *
         * One ordered list rather than separate image/gradient fields
         * because CSS interleaves them: `url(…), linear-gradient(…)` paints
         * the IMAGE on top, the exact reverse of
         * `linear-gradient(…), url(…)`. Separate fields forced a fixed
         * image-then-gradient order and silently mis-stacked the first form.
         */
        val paintLayers: List<PaintLayer> = emptyList(),
    ) {
        /** First image URI in declaration order. */
        val imageUri: String?
            get() = paintLayers.asReversed()
                .filterIsInstance<PaintLayer.Image>()
                .firstOrNull()
                ?.uri

        /** Gradient layers, bottom-first. */
        val brushes: List<Brush>
            get() = paintLayers.filterIsInstance<PaintLayer.Gradient>().map { it.brush }

        val isEmpty: Boolean
            get() = color == null && paintLayers.isEmpty()
    }

    /**
     * Parse a `background` / `backgroundImage` value. Returns null when
     * nothing in it is expressible — the caller then leaves the modifier
     * untouched (snap-don't-error: never render a wrong background to
     * salvage a pretty one).
     */
    fun parse(value: Any?): Layers? {
        val text = value as? String ?: return null
        if (text.isBlank()) return null

        var color: Color? = null
        val declared = mutableListOf<PaintLayer>()

        for (layer in splitTopLevel(text)) {
            val trimmed = layer.trim()
            if (trimmed.isEmpty()) continue

            when {
                trimmed.contains("url(", ignoreCase = true) -> {
                    // `url('…') center / cover no-repeat` — the trailing
                    // position/size/repeat keywords are not expressible as a
                    // modifier, and `cover` is what we do anyway (Crop).
                    extractUrl(trimmed)?.let { declared.add(PaintLayer.Image(it)) }
                }
                trimmed.startsWith("linear-gradient(", ignoreCase = true) -> {
                    parseLinearGradient(trimmed)?.let { declared.add(PaintLayer.Gradient(it)) }
                }
                trimmed.startsWith("radial-gradient(", ignoreCase = true) -> {
                    val colors = gradientColors(innerOf(trimmed))
                    if (colors.size >= 2) {
                        declared.add(PaintLayer.Gradient(Brush.radialGradient(colors)))
                    }
                }
                trimmed.startsWith("conic-gradient(", ignoreCase = true) -> {
                    val colors = gradientColors(innerOf(trimmed))
                    if (colors.size >= 2) {
                        declared.add(PaintLayer.Gradient(Brush.sweepGradient(colors)))
                    }
                }
                // `none` is a legitimate "no image", not a parse failure.
                trimmed.equals("none", ignoreCase = true) -> Unit
                else -> color = color ?: ColorParser.parse(trimmed)
            }
        }

        // CSS paints the first-declared layer on top; store bottom-first so
        // callers can chain modifiers in order.
        val layers = Layers(color = color, paintLayers = declared.reversed())
        return if (layers.isEmpty) null else layers
    }

    /**
     * Split on commas that are not nested inside parentheses or quotes.
     * Base64 `url(data:…)` payloads and `rgba(...)` stops both depend on it.
     */
    fun splitTopLevel(value: String): List<String> {
        val parts = mutableListOf<String>()
        val current = StringBuilder()
        var depth = 0
        var quote: Char? = null

        for (ch in value) {
            when {
                quote != null -> {
                    current.append(ch)
                    if (ch == quote) quote = null
                }
                ch == '\'' || ch == '"' -> {
                    current.append(ch)
                    quote = ch
                }
                ch == '(' -> {
                    depth++
                    current.append(ch)
                }
                ch == ')' -> {
                    if (depth > 0) depth--
                    current.append(ch)
                }
                ch == ',' && depth == 0 -> {
                    parts.add(current.toString())
                    current.setLength(0)
                }
                else -> current.append(ch)
            }
        }
        if (current.isNotEmpty()) parts.add(current.toString())
        return parts
    }

    /** Contents between the first `(` and the matching final `)`. */
    private fun innerOf(function: String): String {
        val open = function.indexOf('(')
        val close = function.lastIndexOf(')')
        if (open < 0 || close <= open) return ""
        return function.substring(open + 1, close)
    }

    /** `url('…')` / `url(…)` → the bare URI, or null. */
    private fun extractUrl(layer: String): String? {
        val start = layer.indexOf("url(", ignoreCase = true)
        if (start < 0) return null
        val open = start + 4
        var depth = 1
        var i = open
        while (i < layer.length && depth > 0) {
            when (layer[i]) {
                '(' -> depth++
                ')' -> depth--
            }
            if (depth > 0) i++
        }
        if (depth != 0) return null
        val raw = layer.substring(open, i).trim()
        return raw.trim('\'', '"').takeIf { it.isNotEmpty() }
    }

    /**
     * `linear-gradient(<direction>?, <stop>, <stop>…)` → Brush, reusing the
     * angle→Brush mapping the `.linearGradient()` applicator already uses.
     */
    private fun parseLinearGradient(function: String): Brush? {
        val parts = splitTopLevel(innerOf(function)).map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null

        val head = parts[0].lowercase()
        val angle: Float
        val stops: List<String>
        when {
            head.startsWith("to ") -> {
                angle = directionToAngle(head)
                stops = parts.drop(1)
            }
            head.endsWith("deg") -> {
                angle = head.removeSuffix("deg").trim().toFloatOrNull() ?: DEFAULT_ANGLE
                stops = parts.drop(1)
            }
            else -> {
                angle = DEFAULT_ANGLE
                stops = parts
            }
        }

        val colors = gradientColors(stops)
        if (colors.size < 2) return null
        return brushForAngle(colors, angle)
    }

    private fun gradientColors(inner: String): List<Color> =
        gradientColors(splitTopLevel(inner).map { it.trim() })

    /**
     * Colour stops may carry a position (`#fff 40%`); the colour is the
     * leading token. Positions are dropped — Compose's brush helpers take
     * evenly distributed stops and an uneven ramp is a nicety, not a
     * correctness issue.
     */
    private fun gradientColors(stops: List<String>): List<Color> =
        stops.mapNotNull { stop ->
            val token = stop.trim()
            ColorParser.parse(token)
                ?: ColorParser.parse(token.substringBeforeLast(' ').trim())
        }

    private const val DEFAULT_ANGLE = 180f

    /** CSS angles: 0deg points up, growing clockwise. */
    private fun directionToAngle(direction: String): Float =
        when (direction.replace(Regex("\\s+"), " ").trim()) {
            "to top" -> 0f
            "to right" -> 90f
            "to bottom" -> 180f
            "to left" -> 270f
            "to top right", "to right top" -> 45f
            "to bottom right", "to right bottom" -> 135f
            "to bottom left", "to left bottom" -> 225f
            "to top left", "to left top" -> 315f
            else -> DEFAULT_ANGLE
        }

    /**
     * Snap an angle to the nearest of the eight directions Compose's brush
     * helpers express directly. Shared with [LinearGradientApplicator] so the
     * `.linearGradient()` applicator and CSS strings trace the same ramp.
     */
    fun brushForAngle(colors: List<Color>, angle: Float): Brush {
        val normalized = ((angle % 360) + 360) % 360
        // The four cardinal directions have exact built-ins; everything else
        // goes through the size-aware shader below.
        return when (normalized) {
            0f -> Brush.verticalGradient(colors.reversed())
            90f -> Brush.horizontalGradient(colors)
            180f -> Brush.verticalGradient(colors)
            270f -> Brush.horizontalGradient(colors.reversed())
            else -> AngleGradientBrush(colors, normalized)
        }
    }

    /**
     * A linear gradient at an ARBITRARY CSS angle.
     *
     * `Brush.linearGradient` takes absolute pixel offsets, which is why the
     * previous implementation snapped every angle to one of eight directions
     * — a `linear-gradient(30deg, …)` rendered as 45°. A `ShaderBrush` gets
     * the draw size, so the endpoints can be computed properly.
     *
     * CSS 0deg points UP and grows clockwise, so the gradient direction is
     * (sin θ, −cos θ) in screen coordinates (y grows downward). The line is
     * centred on the box and extended by CSS's gradient-line length,
     * `|W·sin θ| + |H·cos θ|`, so the first and last stops land exactly on
     * the corners the spec puts them on.
     */
    private class AngleGradientBrush(
        private val colors: List<Color>,
        private val angle: Float,
    ) : ShaderBrush() {
        override fun createShader(size: Size): Shader {
            val radians = Math.toRadians(angle.toDouble())
            val dx = sin(radians).toFloat()
            val dy = -cos(radians).toFloat()
            val length = abs(size.width * dx) + abs(size.height * dy)
            val cx = size.width / 2f
            val cy = size.height / 2f
            val half = length / 2f
            return LinearGradientShader(
                from = Offset(cx - dx * half, cy - dy * half),
                to = Offset(cx + dx * half, cy + dy * half),
                colors = colors,
            )
        }

        override fun equals(other: Any?): Boolean =
            other is AngleGradientBrush && other.colors == colors && other.angle == angle

        override fun hashCode(): Int = 31 * colors.hashCode() + angle.hashCode()
    }

    /**
     * Decode a `data:` image URI to an [ImageBitmap], memoised by URI.
     *
     * The home-screen wallpaper is a ~700 KB base64 PNG that would otherwise
     * be decoded on every applicator pass. Remote URLs are NOT fetched here —
     * that needs an async image loader at the component level, so they
     * degrade to "no image" rather than blocking composition on the network.
     */
    fun decodeDataImage(uri: String): ImageBitmap? {
        if (!uri.startsWith("data:", ignoreCase = true)) return null
        synchronized(imageCache) { imageCache[uri] }?.let { return it.value }

        val decoded = runCatching {
            val comma = uri.indexOf(',')
            if (comma < 0) return@runCatching null
            val meta = uri.substring(0, comma)
            if (!meta.contains("base64", ignoreCase = true)) return@runCatching null
            val bytes = Base64.decode(uri.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()

        // Cache misses too: a payload that failed once fails every time, and
        // re-attempting a 700 KB decode per frame is the expensive mistake.
        synchronized(imageCache) {
            if (imageCache.size >= MAX_CACHED_IMAGES) {
                imageCache.remove(imageCache.keys.first())
            }
            imageCache[uri] = Cached(decoded)
        }
        return decoded
    }

    private class Cached(val value: ImageBitmap?)

    private const val MAX_CACHED_IMAGES = 8
    private val imageCache = LinkedHashMap<String, Cached>()
}
