package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import java.util.Locale

/**
 * Accumulator for text styling properties.
 * This is populated by text applicators and consumed by text components.
 */
data class TextStyle(
    val fontSize: TextUnit = TextUnit.Unspecified,
    val fontWeight: FontWeight? = null,
    val fontStyle: FontStyle? = null,
    val fontFamily: FontFamily? = null,
    val color: Color = Color.Unspecified,
    val letterSpacing: TextUnit = TextUnit.Unspecified,
    val lineHeight: TextUnit = TextUnit.Unspecified,
    val textAlign: TextAlign? = null,
    val textDecoration: TextDecoration? = null,
    val textTransform: TextTransform? = null,
    val maxLines: Int = Int.MAX_VALUE,
    val overflow: TextOverflow = TextOverflow.Clip,
    val fontFeatureSettings: String? = null,
) {
    enum class TextTransform {
        UPPERCASE, LOWERCASE, CAPITALIZE
    }

    fun applyTransform(text: String): String = when (textTransform) {
        TextTransform.UPPERCASE -> text.uppercase(Locale.getDefault())
        TextTransform.LOWERCASE -> text.lowercase(Locale.getDefault())
        TextTransform.CAPITALIZE -> text.split(" ").joinToString(" ") { word ->
            word.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }
        }
        null -> text
    }
}

/**
 * Builder for TextStyle that applicators can modify.
 */
class TextStyleBuilder {
    var fontSize: TextUnit = TextUnit.Unspecified
    var fontWeight: FontWeight? = null
    var fontStyle: FontStyle? = null
    var fontFamily: FontFamily? = null
    var color: Color = Color.Unspecified
    var letterSpacing: TextUnit = TextUnit.Unspecified
    var lineHeight: TextUnit = TextUnit.Unspecified
    var textAlign: TextAlign? = null
    var textDecoration: TextDecoration? = null
    var textTransform: TextStyle.TextTransform? = null
    var maxLines: Int = Int.MAX_VALUE
    var overflow: TextOverflow = TextOverflow.Clip
    var fontFeatureSettings: String? = null

    fun build(): TextStyle = TextStyle(
        fontSize = fontSize,
        fontWeight = fontWeight,
        fontStyle = fontStyle,
        fontFamily = fontFamily,
        color = color,
        letterSpacing = letterSpacing,
        lineHeight = lineHeight,
        textAlign = textAlign,
        textDecoration = textDecoration,
        textTransform = textTransform,
        maxLines = maxLines,
        overflow = overflow,
        fontFeatureSettings = fontFeatureSettings,
    )
}

/**
 * Interface for text-specific applicators that modify TextStyleBuilder.
 */
interface TextApplicatorHandler {
    val name: String
    fun apply(builder: TextStyleBuilder, value: Any?)
}

/**
 * Registry for text applicators.
 */
class TextApplicatorRegistry {
    private val handlers = mutableMapOf<String, TextApplicatorHandler>()

    fun register(handler: TextApplicatorHandler) {
        handlers[handler.name.lowercase()] = handler
    }

    fun getHandler(name: String): TextApplicatorHandler? =
        handlers[name] ?: handlers[name.lowercase()]

    fun applyAll(props: Map<String, Any?>): TextStyle {
        val builder = TextStyleBuilder()

        // Group props by base name
        val grouped = mutableMapOf<String, Any?>()
        for ((name, value) in props) {
            val dotIndex = name.indexOf('.')
            if (dotIndex != -1) {
                val baseName = name.substring(0, dotIndex)
                val suffix = name.substring(dotIndex + 1)
                if (suffix == "0") {
                    grouped[baseName] = value
                }
            }
        }

        // `foregroundColor` is an alias of `color`, and both write the same
        // builder field. Handlers are applied in the props' iteration order,
        // not registration order, so a node setting both would otherwise get
        // a result that depends on key order. Drop the alias so the canonical
        // name always wins — matching DOM and Canvas.
        if (grouped.containsKey("color")) {
            grouped.remove("foregroundColor")
        }

        for ((name, value) in grouped) {
            getHandler(name)?.apply(builder, value)
        }

        return builder.build()
    }

    companion object {
        fun withDefaults(): TextApplicatorRegistry {
            val registry = TextApplicatorRegistry()
            registry.register(FontSizeApplicator())
            registry.register(FontWeightApplicator())
            registry.register(FontStyleApplicator())
            registry.register(FontFamilyApplicator())
            // Precedence when a node sets both is enforced in applyAll, not
            // by registration order -- handlers run in the props' iteration
            // order.
            registry.register(ForegroundColorTextApplicator())
            registry.register(ColorApplicator())
            registry.register(LetterSpacingApplicator())
            registry.register(LineHeightApplicator())
            registry.register(TextAlignApplicator())
            registry.register(TextDecorationApplicator())
            registry.register(TextTransformApplicator())
            registry.register(MaxLinesApplicator())
            registry.register(TextOverflowApplicator())
            registry.register(FontVariantApplicator())
            return registry
        }
    }
}

// MARK: - Text Applicator Implementations

class FontSizeApplicator : TextApplicatorHandler {
    override val name = "fontSize"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val size = when (value) {
            is Number -> value.toFloat()
            is String -> {
                val str = value.trim().lowercase()
                when {
                    str.endsWith("rem") -> str.removeSuffix("rem").toFloatOrNull()?.times(16f)
                    str.endsWith("em") -> str.removeSuffix("em").toFloatOrNull()?.times(16f)
                    // Typographic point = 1/72 inch = 96/72 logical pixels.
                    // Compose `.sp` is a scale-aware logical unit, so multiply
                    // the value into logical-pixel space before tagging `.sp`.
                    str.endsWith("pt") -> str.removeSuffix("pt").toFloatOrNull()?.times(96f / 72f)
                    else -> str
                        .replace("sp", "")
                        .replace("px", "")
                        .replace("dp", "")
                        .toFloatOrNull()
                }
            }
            else -> null
        }
        if (size != null) {
            builder.fontSize = size.sp
        }
    }
}

class FontWeightApplicator : TextApplicatorHandler {
    override val name = "fontWeight"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.fontWeight = parseFontWeight(value?.toString())
    }

    private fun parseFontWeight(value: String?): FontWeight? = when (value?.lowercase()) {
        "bold" -> FontWeight.Bold
        "semibold", "semi-bold" -> FontWeight.SemiBold
        "medium" -> FontWeight.Medium
        "normal", "regular" -> FontWeight.Normal
        "light" -> FontWeight.Light
        "thin" -> FontWeight.Thin
        "extrabold", "extra-bold" -> FontWeight.ExtraBold
        "extralight", "extra-light" -> FontWeight.ExtraLight
        "black" -> FontWeight.Black
        "100" -> FontWeight.W100
        "200" -> FontWeight.W200
        "300" -> FontWeight.W300
        "400" -> FontWeight.W400
        "500" -> FontWeight.W500
        "600" -> FontWeight.W600
        "700" -> FontWeight.W700
        "800" -> FontWeight.W800
        "900" -> FontWeight.W900
        else -> value?.toIntOrNull()?.let { weight ->
            when {
                weight <= 100 -> FontWeight.W100
                weight <= 200 -> FontWeight.W200
                weight <= 300 -> FontWeight.W300
                weight <= 400 -> FontWeight.W400
                weight <= 500 -> FontWeight.W500
                weight <= 600 -> FontWeight.W600
                weight <= 700 -> FontWeight.W700
                weight <= 800 -> FontWeight.W800
                else -> FontWeight.W900
            }
        }
    }
}

class FontStyleApplicator : TextApplicatorHandler {
    override val name = "fontStyle"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.fontStyle = when (value?.toString()?.lowercase()) {
            "italic" -> FontStyle.Italic
            "normal" -> FontStyle.Normal
            else -> null
        }
    }
}

class FontFamilyApplicator : TextApplicatorHandler {
    override val name = "fontFamily"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val fontName = value?.toString() ?: return

        // First check if it's a system font keyword
        val systemFont = space.hypen.renderer.fonts.GoogleFontsLoader.getSystemFontFamily(fontName)
        if (systemFont != null) {
            builder.fontFamily = systemFont
            return
        }

        // Try to load as a Google Font
        val googleFont = space.hypen.renderer.fonts.GoogleFontsLoader.loadFontFamily(fontName)
        if (googleFont != null) {
            builder.fontFamily = googleFont
        }
    }
}

class ColorApplicator : TextApplicatorHandler {
    override val name = "color"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val color = space.hypen.renderer.applicators.ColorParser.parse(value)
        if (color != null) {
            builder.color = color
        }
    }
}

/**
 * `foregroundColor` on a text element is the same thing as `color`.
 *
 * The modifier-level ForegroundColorApplicator provides LocalContentColor to
 * a container's DESCENDANTS, which is right for a Box or a Card but leaves
 * `Text("x").foregroundColor(red)` doing nothing at all: TextComponent reads
 * textStyle.color first, and only this registry writes that. DOM, Canvas and
 * Swift all honour the spelling directly on the text node, so Android has to
 * as well. `color` still wins when a node sets both; applyAll drops this
 * alias in that case.
 */
class ForegroundColorTextApplicator : TextApplicatorHandler {
    override val name = "foregroundColor"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val color = space.hypen.renderer.applicators.ColorParser.parse(value)
        if (color != null) {
            builder.color = color
        }
    }
}

class LetterSpacingApplicator : TextApplicatorHandler {
    override val name = "letterSpacing"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val spacing = when (value) {
            is Number -> value.toFloat()
            is String -> {
                val str = value.trim().lowercase()
                when {
                    str.endsWith("rem") -> str.removeSuffix("rem").toFloatOrNull()?.times(16f)
                    str.endsWith("em") -> str.removeSuffix("em").toFloatOrNull()?.times(16f)
                    else -> str.replace("sp", "").replace("px", "").toFloatOrNull()
                }
            }
            else -> null
        }
        if (spacing != null) {
            builder.letterSpacing = spacing.sp
        }
    }
}

class LineHeightApplicator : TextApplicatorHandler {
    override val name = "lineHeight"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val valueStr = value?.toString() ?: return
        val str = valueStr.trim().lowercase()

        // Handle rem/em units
        if (str.endsWith("rem")) {
            val num = str.removeSuffix("rem").toFloatOrNull() ?: return
            builder.lineHeight = (num * 16f).sp
            return
        }
        if (str.endsWith("em")) {
            val num = str.removeSuffix("em").toFloatOrNull() ?: return
            builder.lineHeight = (num * 16f).sp
            return
        }

        // Check if value has explicit units (sp/px) - use as-is
        val hasExplicitUnit = str.contains("sp") || str.contains("px")

        val numericValue = str
            .replace("sp", "")
            .replace("px", "")
            .trim()
            .toFloatOrNull() ?: return

        // If explicit unit or value is large enough to be an absolute value (>= 8sp),
        // use it directly. Otherwise, treat small values (0.5-5.0) as multipliers
        // of a default 16sp font size.
        val heightSp = when {
            hasExplicitUnit -> numericValue
            numericValue >= 8f -> numericValue  // Absolute value in sp
            numericValue in 0.5f..5f -> numericValue * 16f  // Multiplier of default font size
            else -> numericValue
        }

        builder.lineHeight = heightSp.sp
    }
}

class TextAlignApplicator : TextApplicatorHandler {
    override val name = "textAlign"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.textAlign = when (value?.toString()?.lowercase()) {
            "center" -> TextAlign.Center
            "left", "start" -> TextAlign.Start
            "right", "end" -> TextAlign.End
            "justify" -> TextAlign.Justify
            else -> null
        }
    }
}

class TextDecorationApplicator : TextApplicatorHandler {
    override val name = "textDecoration"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.textDecoration = when (value?.toString()?.lowercase()) {
            "underline" -> TextDecoration.Underline
            "linethrough", "line-through", "strikethrough" -> TextDecoration.LineThrough
            "none" -> TextDecoration.None
            else -> null
        }
    }
}

class TextTransformApplicator : TextApplicatorHandler {
    override val name = "textTransform"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.textTransform = when (value?.toString()?.lowercase()) {
            "uppercase" -> TextStyle.TextTransform.UPPERCASE
            "lowercase" -> TextStyle.TextTransform.LOWERCASE
            "capitalize" -> TextStyle.TextTransform.CAPITALIZE
            else -> null
        }
    }
}

class MaxLinesApplicator : TextApplicatorHandler {
    override val name = "maxLines"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        val lines = when (value) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }
        if (lines != null && lines > 0) {
            builder.maxLines = lines
        }
    }
}

class TextOverflowApplicator : TextApplicatorHandler {
    override val name = "textOverflow"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.overflow = when (value?.toString()?.lowercase()) {
            "ellipsis" -> TextOverflow.Ellipsis
            "clip" -> TextOverflow.Clip
            "visible" -> TextOverflow.Visible
            else -> TextOverflow.Clip
        }
    }
}

class FontVariantApplicator : TextApplicatorHandler {
    override val name = "fontVariant"

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        builder.fontFeatureSettings = when (value?.toString()?.lowercase()) {
            "small-caps" -> "'smcp' 1"
            "all-small-caps" -> "'smcp' 1, 'c2sc' 1"
            "petite-caps" -> "'pcap' 1"
            "all-petite-caps" -> "'pcap' 1, 'c2pc' 1"
            "unicase" -> "'unic' 1"
            "titling-caps" -> "'titl' 1"
            "normal", "none" -> null
            else -> if (value?.toString()?.contains("'") == true || value?.toString()?.contains("\"") == true) {
                value.toString()
            } else null
        }
    }
}

// Alias applicator for "overflow" to map to textOverflow
class OverflowApplicator : TextApplicatorHandler {
    override val name = "overflow"
    private val delegate = TextOverflowApplicator()

    override fun apply(builder: TextStyleBuilder, value: Any?) {
        delegate.apply(builder, value)
    }
}
