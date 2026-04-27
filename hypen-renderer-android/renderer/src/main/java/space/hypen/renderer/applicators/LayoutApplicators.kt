package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

/**
 * Applicator for alignment.
 */
class AlignmentApplicator : ApplicatorHandler {
    override val name: String = "alignment"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Note: Alignment in Compose is typically handled at the parent level
        // This is a simplified version
        return modifier
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

        fun parseVerticalAlignment(value: Any?): Alignment.Vertical? =
            when (value?.toString()?.lowercase()) {
                "top" -> Alignment.Top
                "center" -> Alignment.CenterVertically
                "bottom" -> Alignment.Bottom
                else -> null
            }

        fun parseHorizontalAlignment(value: Any?): Alignment.Horizontal? =
            when (value?.toString()?.lowercase()) {
                "start", "left" -> Alignment.Start
                "center" -> Alignment.CenterHorizontally
                "end", "right" -> Alignment.End
                else -> null
            }
    }
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

