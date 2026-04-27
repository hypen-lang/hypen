package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Applicator for margin.
 * In Compose, margins are typically implemented as padding on the parent or using Spacers.
 * For simplicity, we implement margin as padding (outer spacing).
 */
class MarginApplicator : ApplicatorHandler {
    override val name: String = "margin"

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
        // Positional form first: margin(v), margin(v,h), margin(t,h,b), margin(t,r,b,l)
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

/** Directional margin applicators — match Web's marginTop, marginBottom, etc. */

class MarginTopApplicator : ApplicatorHandler {
    override val name: String = "marginTop"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(top = dp)
    }
}

class MarginBottomApplicator : ApplicatorHandler {
    override val name: String = "marginBottom"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(bottom = dp)
    }
}

class MarginLeftApplicator : ApplicatorHandler {
    override val name: String = "marginLeft"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(start = dp)
    }
}

class MarginRightApplicator : ApplicatorHandler {
    override val name: String = "marginRight"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(end = dp)
    }
}

class MarginHorizontalApplicator : ApplicatorHandler {
    override val name: String = "marginHorizontal"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(start = dp, end = dp)
    }
}

class MarginVerticalApplicator : ApplicatorHandler {
    override val name: String = "marginVertical"
    override fun apply(modifier: Modifier, value: Any?, context: ApplicatorContext): Modifier {
        val dp = (value as? Number)?.toFloat()?.dp ?: (value as? String)?.let { parseCssUnit(it) } ?: return modifier
        return modifier.padding(top = dp, bottom = dp)
    }
}
