package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

/**
 * Element types whose handler resolves the alignment props itself:
 * Column/Row/List fold them into an Arrangement, and
 * App/Badge/Box/Button/Center/Container/Stack into a Box `contentAlignment`
 * (see components/ContentAlignment.kt). Card/Grid/SafeArea size and paint a
 * frame *inside* this modifier chain.
 *
 * On those the component keeps winning and the applicators below stand down.
 * Applying both would fight: `wrapContent*` measures the node at its content
 * size, so a Card would paint its surface at content width instead of
 * centring what is inside it, and a Column would end up aligned twice.
 */
private val alignmentOwningTypes = setOf(
    "app", "badge", "box", "button", "card", "center", "column", "container",
    "grid", "list", "row", "safearea", "stack",
)

private fun ApplicatorContext.componentOwnsAlignment(): Boolean =
    element.elementType.lowercase() in alignmentOwningTypes

/**
 * Content alignment applicators (`alignment`, `justifyContent`/`alignItems`
 * from `.tw()` classes, and the Hypen-native `horizontalAlignment`/
 * `verticalAlignment`).
 *
 * These were read only *inside* Column/Row/Stack/List/Badge, so on every
 * other container they were dropped and content stayed pinned top-start —
 * the same gap the Swift renderer closed with its JustifyContentApplicator
 * (Applicators/LayoutApplicators.swift).
 *
 * Compose expresses "align my content inside the box my size applicators
 * established" as `wrapContent*`: the node is measured at its content size
 * and placed within the incoming constraints. That only reads correctly when
 * everything which must keep the full box — size, border, background,
 * padding, the click target — sits outside it, which is why these run in the
 * innermost CONTENT_ALIGNMENT band.
 *
 * Flex's main axis in the default row direction is horizontal, so
 * `justifyContent` drives the horizontal side and `alignItems` the vertical,
 * matching the reading Swift settled on.
 *
 * KNOWN LIMIT: these only take effect in a wrap-content parent. HypenApp
 * appends its stretch policy (`fillMaxWidth()` for a stretch Column child,
 * `fillMaxWidth(fraction)` for `.fillMaxWidth()`) AFTER the whole applicator
 * chain, i.e. inside this band, and `wrapContentWidth(center).fillMaxWidth()`
 * fills - so `Text("x").tw("justify-center")` inside `Column.tw("items-stretch")`
 * still sits at the start. The owning containers resolve the props themselves
 * (`hypenContentAlignment`) precisely to escape this; leaf types under a
 * stretch parent need the policy modifier moved ahead of this band.
 */
private fun alignHorizontally(
    modifier: Modifier,
    value: Any?,
    context: ApplicatorContext,
): Modifier {
    if (context.componentOwnsAlignment()) return modifier
    val alignment = AlignmentApplicator.parseHorizontalAlignment(value) ?: return modifier
    return modifier.wrapContentWidth(alignment)
}

private fun alignVertically(
    modifier: Modifier,
    value: Any?,
    context: ApplicatorContext,
): Modifier {
    if (context.componentOwnsAlignment()) return modifier
    val alignment = AlignmentApplicator.parseVerticalAlignment(value) ?: return modifier
    return modifier.wrapContentHeight(alignment)
}

/**
 * Applicator for alignment - both axes at once, e.g. `.alignment(center)`.
 */
class AlignmentApplicator : ApplicatorHandler {
    override val name: String = "alignment"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (context.componentOwnsAlignment()) return modifier
        val alignment = parseAlignment(value) ?: return modifier
        return modifier.wrapContentSize(alignment)
    }

    companion object {
        fun parseAlignment(value: Any?): Alignment? =
            when (value?.toString()?.lowercase()) {
                "center" -> Alignment.Center
                "topleft", "topstart" -> Alignment.TopStart
                "topcenter" -> Alignment.TopCenter
                "topright", "topend" -> Alignment.TopEnd
                "centerleft", "centerstart" -> Alignment.CenterStart
                "centerright", "centerend" -> Alignment.CenterEnd
                "bottomleft", "bottomstart" -> Alignment.BottomStart
                "bottomcenter" -> Alignment.BottomCenter
                "bottomright", "bottomend" -> Alignment.BottomEnd
                else -> null
            }

        // The flex spellings (`flex-start`, `flex-end`) and the leading/
        // trailing synonyms are accepted alongside the native tokens so a
        // `.tw()` class and a hand-written applicator resolve identically —
        // the same token set Column/Row already match on.
        fun parseVerticalAlignment(value: Any?): Alignment.Vertical? =
            when (value?.toString()?.lowercase()) {
                "top", "start", "flex-start" -> Alignment.Top
                "center", "centervertically" -> Alignment.CenterVertically
                "bottom", "end", "flex-end" -> Alignment.Bottom
                else -> null
            }

        fun parseHorizontalAlignment(value: Any?): Alignment.Horizontal? =
            when (value?.toString()?.lowercase()) {
                "start", "left", "leading", "flex-start" -> Alignment.Start
                "center", "centerhorizontally" -> Alignment.CenterHorizontally
                "end", "right", "trailing", "flex-end" -> Alignment.End
                else -> null
            }
    }
}

/**
 * Applicator for justifyContent (CSS main axis -> horizontal).
 */
class JustifyContentApplicator : ApplicatorHandler {
    override val name: String = "justifyContent"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = alignHorizontally(modifier, value, context)
}

/**
 * Applicator for horizontalAlignment (Hypen-native spelling of the above).
 */
class HorizontalAlignmentApplicator : ApplicatorHandler {
    override val name: String = "horizontalAlignment"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = alignHorizontally(modifier, value, context)
}

/**
 * Applicator for alignItems (CSS cross axis -> vertical).
 */
class AlignItemsApplicator : ApplicatorHandler {
    override val name: String = "alignItems"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = alignVertically(modifier, value, context)
}

/**
 * Applicator for verticalAlignment (Hypen-native spelling of the above).
 */
class VerticalAlignmentApplicator : ApplicatorHandler {
    override val name: String = "verticalAlignment"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = alignVertically(modifier, value, context)
}

/**
 * Applicator for flex weight.
 * Note: Weight is handled specially in HypenApp since it requires Row/Column scope.
 */
class WeightApplicator : ApplicatorHandler {
    override val name: String = "weight"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Weight is applied in HypenApp where we have access to Row/Column scope
        return modifier
    }
}

/**
 * Applicator for flex (similar to weight).
 */
class FlexApplicator : ApplicatorHandler {
    override val name: String = "flex"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Flex is applied in HypenApp where we have access to Row/Column scope
        return modifier
    }
}

/**
 * Applicator for flexGrow.
 * Like weight/flex, handled at the parent level (Row/Column scope).
 */
class FlexGrowApplicator : ApplicatorHandler {
    override val name: String = "flexGrow"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Flex grow is applied in HypenApp where we have access to Row/Column scope
        return modifier
    }
}

/**
 * Applicator for flexShrink.
 * Controls whether the element can shrink below its content size.
 */
class FlexShrinkApplicator : ApplicatorHandler {
    override val name: String = "flexShrink"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Flex shrink is applied in HypenApp where we have access to Row/Column scope
        return modifier
    }
}

/**
 * Applicator for aspectRatio.
 */
class AspectRatioApplicator : ApplicatorHandler {
    override val name: String = "aspectRatio"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val ratio =
            when (value) {
                is Number -> value.toFloat()
                is String -> parseRatio(value)
                else -> return modifier
            }
        return if (ratio != null && ratio > 0) {
            modifier.aspectRatio(ratio)
        } else {
            modifier
        }
    }

    private fun parseRatio(value: String): Float? {
        // Support "16:9" format
        val parts = value.split(":", "/")
        return if (parts.size == 2) {
            val width = parts[0].trim().toFloatOrNull()
            val height = parts[1].trim().toFloatOrNull()
            if (width != null && height != null && height > 0) {
                width / height
            } else {
                null
            }
        } else {
            value.toFloatOrNull()
        }
    }
}

/**
 * Applicator for offset.
 */
class OffsetApplicator : ApplicatorHandler {
    override val name: String = "offset"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier =
        when (value) {
            is Map<*, *> -> {
                val x = (value["x"] as? Number)?.toFloat()?.dp ?: 0.dp
                val y = (value["y"] as? Number)?.toFloat()?.dp ?: 0.dp
                modifier.offset(x = x, y = y)
            }
            else -> modifier
        }
}

/**
 * Applicator for gap.
 * Note: Gap in Compose is handled via Arrangement.spacedBy at the parent level (Row/Column).
 * This applicator stores the value for the component to read.
 * Actual gap implementation is in ColumnComponent and RowComponent.
 */
class GapApplicator : ApplicatorHandler {
    override val name: String = "gap"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Gap is read by Row/Column components directly from props
        // This applicator is here for API completeness
        return modifier
    }
}

/**
 * Applicator for rowGap.
 */
class RowGapApplicator : ApplicatorHandler {
    override val name: String = "rowGap"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Read by layout components directly
        return modifier
    }
}

/**
 * Applicator for columnGap.
 */
class ColumnGapApplicator : ApplicatorHandler {
    override val name: String = "columnGap"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Read by layout components directly
        return modifier
    }
}

/**
 * Applicator for zIndex.
 */
class ZIndexApplicator : ApplicatorHandler {
    override val name: String = "zIndex"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val zIndex = when (value) {
            is Number -> value.toFloat()
            is String -> value.toFloatOrNull() ?: return modifier
            else -> return modifier
        }
        return modifier.zIndex(zIndex)
    }
}

