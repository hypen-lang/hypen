package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Applicator for padding.
 *
 * Supports the same forms as the web renderer:
 *   - `padding(all)` — single value applied to every side
 *   - `padding(vertical, horizontal)` — CSS shorthand 2-arg
 *   - `padding(top, horizontal, bottom)` — CSS shorthand 3-arg
 *   - `padding(top, right, bottom, left)` — CSS shorthand 4-arg
 *   - `padding(top: x, bottom: y, left: z, right: w)` — named keys (also
 *     accepts `start`/`end`/`leading`/`trailing` and `horizontal`/`vertical`)
 *
 * The engine emits positional applicator args as `padding.0`, `padding.1`, …
 * which the registry groups into a map keyed by `"0"`, `"1"`, … so the
 * positional path below mirrors CSS shorthand semantics regardless of source
 * SDK.
 */
class PaddingApplicator : ApplicatorHandler {
    override val name: String = "padding"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier =
        when (value) {
            is Number -> modifier.padding(value.toFloat().dp)
            is String -> {
                val dp = parseCssUnit(value)
                if (dp != null) modifier.padding(dp) else modifier
            }
            is Map<*, *> -> applyFromMap(modifier, value)
            else -> modifier
        }

    private fun applyFromMap(
        modifier: Modifier,
        map: Map<*, *>,
    ): Modifier {
        // Positional form first: padding(v), padding(v,h), padding(t,h,b), padding(t,r,b,l)
        val positional = collectPositional(map)
        if (positional.isNotEmpty()) {
            val edges = edgesFromPositional(positional)
            return modifier.padding(
                start = edges.start,
                top = edges.top,
                end = edges.end,
                bottom = edges.bottom,
            )
        }

        val start =
            parseDp(map["start"])
                ?: parseDp(map["leading"])
                ?: parseDp(map["left"])
                ?: parseDp(map["horizontal"])
        val top =
            parseDp(map["top"])
                ?: parseDp(map["vertical"])
        val end =
            parseDp(map["end"])
                ?: parseDp(map["trailing"])
                ?: parseDp(map["right"])
                ?: parseDp(map["horizontal"])
        val bottom =
            parseDp(map["bottom"])
                ?: parseDp(map["vertical"])

        return modifier.padding(
            start = start ?: 0.dp,
            top = top ?: 0.dp,
            end = end ?: 0.dp,
            bottom = bottom ?: 0.dp,
        )
    }
}

/** Directional padding applicators — match Web's paddingTop, paddingBottom, etc. */

class PaddingTopApplicator : ApplicatorHandler {
    override val name: String = "paddingTop"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(top = dp)
    }
}

class PaddingBottomApplicator : ApplicatorHandler {
    override val name: String = "paddingBottom"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(bottom = dp)
    }
}

class PaddingLeftApplicator : ApplicatorHandler {
    override val name: String = "paddingLeft"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(start = dp)
    }
}

class PaddingRightApplicator : ApplicatorHandler {
    override val name: String = "paddingRight"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(end = dp)
    }
}

class PaddingHorizontalApplicator : ApplicatorHandler {
    override val name: String = "paddingHorizontal"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(start = dp, end = dp)
    }
}

class PaddingVerticalApplicator : ApplicatorHandler {
    override val name: String = "paddingVertical"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(top = dp, bottom = dp)
    }
}
