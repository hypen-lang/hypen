package space.hypen.renderer.applicators

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.paint
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale

/**
 * Applicator for linear gradient background.
 * Supports:
 * - Map format: linearGradient({colors: ["red", "blue"], angle: 45})
 * - String format: linearGradient("to right, #3b82f6, #8b5cf6")
 * - String format: linearGradient("135deg, #667eea, #764ba2")
 */
class LinearGradientApplicator : ApplicatorHandler {
    override val name: String = "linearGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // The applicator takes the INNER form ("to right, #a, #b"); wrapping
        // it into the CSS function reuses one parser for both this and the
        // `background`/`backgroundImage` CSS strings, so they can't drift.
        if (value is String) {
            val layers = CssBackground.parse("linear-gradient($value)") ?: return modifier
            return modifier.paintCssBackground(layers)
        }

        val (colors, angle) = when (value) {
            is Map<*, *> -> parseGradientMap(value)
            else -> return modifier
        }

        if (colors.size < 2) return modifier

        return modifier.background(CssBackground.brushForAngle(colors, angle))
    }

    private fun parseGradientMap(value: Map<*, *>): Pair<List<Color>, Float> {
        val colorsList = value["colors"] as? List<*> ?: return emptyList<Color>() to 0f
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        val angle = (value["angle"] as? Number)?.toFloat() ?: 0f
        return colors to angle
    }

}

/**
 * Applicator for radial gradient background.
 * Supports: radialGradient({colors: ["red", "blue"], radius: 100})
 */
class RadialGradientApplicator : ApplicatorHandler {
    override val name: String = "radialGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = Brush.radialGradient(colors)
        return modifier.background(brush)
    }
}

/**
 * Applicator for sweep/conic gradient background.
 */
class ConicGradientApplicator : ApplicatorHandler {
    override val name: String = "conicGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = Brush.sweepGradient(colors)
        return modifier.background(brush)
    }
}

/**
 * Applicator for gradient (generic).
 * Supports: gradient({type: "linear", colors: [...], angle: 45})
 */
class GradientApplicator : ApplicatorHandler {
    override val name: String = "gradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val type = (value["type"] as? String)?.lowercase() ?: "linear"
        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = when (type) {
            "linear" -> {
                val angle = (value["angle"] as? Number)?.toFloat() ?: 0f
                when (angle.toInt() % 360) {
                    0, 360 -> Brush.verticalGradient(colors)
                    90 -> Brush.horizontalGradient(colors)
                    180 -> Brush.verticalGradient(colors.reversed())
                    270 -> Brush.horizontalGradient(colors.reversed())
                    else -> Brush.verticalGradient(colors)
                }
            }
            "radial" -> Brush.radialGradient(colors)
            "sweep", "conic" -> Brush.sweepGradient(colors)
            else -> Brush.verticalGradient(colors)
        }

        return modifier.background(brush)
    }
}

/**
 * Applicator for backgroundImage.
 *
 * Despite the name, CSS `background-image` is overwhelmingly a GRADIENT in
 * practice — every Tailwind `bg-gradient-to-*` lowers to
 * `linear-gradient(to bottom right, #a, #b)` and arrives here. This used to
 * be a stub that logged a warning and dropped the value, which is why every
 * gradient tile in the home-screen example rendered flat.
 *
 * Remote (`http`) image URLs still degrade to nothing: fetching needs an
 * async loader at the component level, and blocking composition on the
 * network is not an option. `data:` URIs are decoded and painted.
 */
class BackgroundImageApplicator : ApplicatorHandler {
    override val name: String = "backgroundImage"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val layers = CssBackground.parse(value) ?: return modifier
        return modifier.paintCssBackground(layers)
    }
}

/**
 * Paint parsed CSS background layers, bottom-up.
 *
 * Modifier draw order is chain order, so the colour goes on first, then the
 * image, then gradients — matching CSS, where the first-declared layer ends
 * up on top.
 */
internal fun Modifier.paintCssBackground(layers: CssBackground.Layers): Modifier {
    var result = this
    layers.color?.let { result = result.background(it) }
    // Bottom-first, so chain order matches CSS's first-declared-on-top.
    // Images and gradients interleave here exactly as declared.
    for (layer in layers.paintLayers) {
        result = when (layer) {
            is CssBackground.PaintLayer.Gradient -> result.background(layer.brush)
            is CssBackground.PaintLayer.Image ->
                CssBackground.decodeDataImage(layer.uri)?.let { bitmap ->
                    result.paint(
                        BitmapPainter(bitmap),
                        // The layout is the element's own; a background must
                        // never resize its host to the image's intrinsic size.
                        sizeToIntrinsics = false,
                        contentScale = ContentScale.Crop,
                    )
                } ?: result
        }
    }
    return result
}

/**
 * Applicator for backgroundSize.
 * Placeholder for API compatibility.
 */
class BackgroundSizeApplicator : ApplicatorHandler {
    override val name: String = "backgroundSize"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Would need to be combined with backgroundImage at component level
        return modifier
    }
}

/**
 * Applicator for backgroundPosition.
 * Placeholder for API compatibility.
 */
class BackgroundPositionApplicator : ApplicatorHandler {
    override val name: String = "backgroundPosition"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Would need to be combined with backgroundImage at component level
        return modifier
    }
}
