package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.applicators.TextApplicatorRegistry
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Badge component - small status indicator.
 */
class BadgeComponent : ComponentHandler {
    override val typeName: String = "badge"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val text = element.getStringProp("0")
            ?: element.getStringProp("text")
            ?: element.getStringProp("label")
            ?: ""

        val style = resolveBadgeStyle(element)
        var badgeModifier = modifier
        if (style.appliesComponentCornerRadius) {
            badgeModifier = badgeModifier.clip(RoundedCornerShape(style.cornerRadiusDp.dp))
        }
        style.componentBackgroundColor?.let { color ->
            badgeModifier = badgeModifier.background(color)
        }
        if (style.appliesDefaultPadding) {
            badgeModifier = badgeModifier.padding(
                horizontal = BadgeDefaults.HORIZONTAL_PADDING_DP.dp,
                vertical = BadgeDefaults.VERTICAL_PADDING_DP.dp,
            )
        }

        Box(
            modifier = badgeModifier,
            contentAlignment = resolveBadgeContentAlignment(element),
        ) {
            val inheritedTextStyle = LocalTextStyle.current.copy(
                fontSize = style.fontSizeSp.sp,
                fontWeight = style.fontWeight,
            )
            val inheritedContentColor = style.textColor ?: LocalContentColor.current
            CompositionLocalProvider(
                LocalContentColor provides inheritedContentColor,
                LocalTextStyle provides inheritedTextStyle,
            ) {
                // If text prop is provided, render it; otherwise render children.
                if (text.isNotEmpty()) {
                    Text(
                        text = text,
                        color = inheritedContentColor,
                        fontSize = style.fontSizeSp.sp,
                        fontWeight = style.fontWeight,
                    )
                } else {
                    renderChildren()
                }
            }
        }
    }
}

/**
 * Badges use an inline flex box on Web, so their alignment applicators align
 * the child inside the badge's border box. Compose's [Box] defaults to
 * top-start; resolve the same contract explicitly, especially for fixed-size
 * count badges where the child is smaller than the 20 dp box.
 */
internal fun resolveBadgeContentAlignment(element: HypenElement): Alignment {
    val horizontal = element.getStringProp("horizontalAlignment.0")
        ?: element.getStringProp("justifyContent.0")
    val vertical = element.getStringProp("verticalAlignment.0")
        ?: element.getStringProp("alignItems.0")

    val horizontalAlignment = when (horizontal?.lowercase()) {
        "end", "right", "trailing", "flex-end" -> Alignment.End
        "center" -> Alignment.CenterHorizontally
        else -> Alignment.Start
    }
    val verticalAlignment = when (vertical?.lowercase()) {
        "bottom", "end", "flex-end" -> Alignment.Bottom
        "center" -> Alignment.CenterVertically
        else -> Alignment.Top
    }

    return when {
        horizontalAlignment == Alignment.CenterHorizontally && verticalAlignment == Alignment.CenterVertically -> Alignment.Center
        horizontalAlignment == Alignment.End && verticalAlignment == Alignment.CenterVertically -> Alignment.CenterEnd
        horizontalAlignment == Alignment.Start && verticalAlignment == Alignment.CenterVertically -> Alignment.CenterStart
        horizontalAlignment == Alignment.CenterHorizontally && verticalAlignment == Alignment.Bottom -> Alignment.BottomCenter
        horizontalAlignment == Alignment.End && verticalAlignment == Alignment.Bottom -> Alignment.BottomEnd
        horizontalAlignment == Alignment.Start && verticalAlignment == Alignment.Bottom -> Alignment.BottomStart
        horizontalAlignment == Alignment.CenterHorizontally -> Alignment.TopCenter
        horizontalAlignment == Alignment.End -> Alignment.TopEnd
        else -> Alignment.TopStart
    }
}

internal object BadgeDefaults {
    val BACKGROUND_COLOR = Color(0xFFE0E0E0)
    val TEXT_COLOR = Color(0xFF333333)
    const val CORNER_RADIUS_DP = 4f
    const val HORIZONTAL_PADDING_DP = 8f
    const val VERTICAL_PADDING_DP = 4f
    const val FONT_SIZE_SP = 12f
    val FONT_WEIGHT = FontWeight.W600
}

internal data class BadgeStyleResolution(
    /** Null means the generic background applicator owns the paint. */
    val componentBackgroundColor: Color?,
    val textColor: Color?,
    val cornerRadiusDp: Float,
    val appliesComponentCornerRadius: Boolean,
    val appliesDefaultPadding: Boolean,
    val fontSizeSp: Float,
    val fontWeight: FontWeight,
)

private val badgePaddingProps = setOf(
    "padding",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "paddingStart",
    "paddingEnd",
    "paddingLeading",
    "paddingTrailing",
    "paddingHorizontal",
    "paddingVertical",
)

private fun Map<String, Any?>.hasBaseProp(name: String): Boolean =
    keys.any { key -> key.substringBefore('.') == name }

private fun Map<String, Any?>.baseProp(name: String): Any? =
    this[name] ?: this["$name.0"]

internal fun resolveBadgeStyle(element: HypenElement): BadgeStyleResolution {
    val props = element.props
    val variant = element.getStringProp("variant")?.lowercase()
    val variantColors = when (variant) {
        "primary" -> Color(0xFF1976D2) to Color.White
        "secondary" -> Color(0xFF9C27B0) to Color.White
        "success" -> Color(0xFF4CAF50) to Color.White
        "warning" -> Color(0xFFFF9800) to Color.Black
        "error", "danger" -> Color(0xFFF44336) to Color.White
        "info" -> Color(0xFF2196F3) to Color.White
        else -> null
    }

    val hasCustomBackground = props.hasBaseProp("backgroundColor") || props.hasBaseProp("background")
    val componentBackgroundColor = when {
        hasCustomBackground -> null
        variantColors != null -> variantColors.first
        else -> BadgeDefaults.BACKGROUND_COLOR
    }

    val textStyle = TextApplicatorRegistry.withDefaults().applyAll(props)
    val explicitForeground = props.baseProp("foregroundColor")?.let(ColorParser::parse)
    val hasCustomTextColor = props.hasBaseProp("color") || props.hasBaseProp("foregroundColor")
    val textColor = when {
        explicitForeground != null -> explicitForeground
        textStyle.color != Color.Unspecified -> textStyle.color
        hasCustomTextColor -> null
        variantColors != null -> variantColors.second
        else -> BadgeDefaults.TEXT_COLOR
    }

    val hasCustomRadius = props.hasBaseProp("borderRadius") || props.hasBaseProp("cornerRadius")
    val hasCustomPadding = badgePaddingProps.any(props::hasBaseProp)
    val hasFixedBox = props.hasBaseProp("width") && props.hasBaseProp("height")

    return BadgeStyleResolution(
        componentBackgroundColor = componentBackgroundColor,
        textColor = textColor,
        cornerRadiusDp = BadgeDefaults.CORNER_RADIUS_DP,
        appliesComponentCornerRadius = !hasCustomRadius,
        appliesDefaultPadding = !hasCustomPadding && !hasFixedBox,
        fontSizeSp = if (textStyle.fontSize != TextUnit.Unspecified) {
            textStyle.fontSize.value
        } else {
            BadgeDefaults.FONT_SIZE_SP
        },
        fontWeight = textStyle.fontWeight ?: BadgeDefaults.FONT_WEIGHT,
    )
}
