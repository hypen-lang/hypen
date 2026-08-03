package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Size Applicators
 *
 * Cross-platform sizing value support:
 * - Numbers: treated as dp (platform default)
 * - "100px": absolute pixels (converted to dp based on density)
 * - "100dp" / "100pt": density-independent (1dp ≈ 1pt)
 * - "50%": percentage of available space
 * - "50vw" / "50vh": viewport width/height
 * - "fill" / "100%": fill available space
 * - "wrap" / "auto": fit content
 */

/**
 * Applicator for width.
 */
class WidthApplicator : ApplicatorHandler {
    override val name: String = "width"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyWidth(size, context.viewport)
    }
}

/**
 * Applicator for height.
 */
class HeightApplicator : ApplicatorHandler {
    override val name: String = "height"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyHeight(size, context.viewport)
    }
}

/**
 * Applicator for minWidth.
 */
class MinWidthApplicator : ApplicatorHandler {
    override val name: String = "minWidth"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyMinWidth(size, context.viewport)
    }
}

/**
 * Applicator for maxWidth.
 */
class MaxWidthApplicator : ApplicatorHandler {
    override val name: String = "maxWidth"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyMaxWidth(size, context.viewport)
    }
}

/**
 * Applicator for minHeight.
 */
class MinHeightApplicator : ApplicatorHandler {
    override val name: String = "minHeight"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyMinHeight(size, context.viewport)
    }
}

/**
 * Applicator for maxHeight.
 */
class MaxHeightApplicator : ApplicatorHandler {
    override val name: String = "maxHeight"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyMaxHeight(size, context.viewport)
    }
}

/**
 * Applicator for size (width and height together).
 */
class SizeApplicator : ApplicatorHandler {
    override val name: String = "size"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Handle map with width/height
        if (value is Map<*, *>) {
            var result = modifier
            val widthVal = value["width"]
            val heightVal = value["height"]
            if (widthVal != null) {
                parseSizeValue(widthVal)?.let { result = result.applyWidth(it, context.viewport) }
            }
            if (heightVal != null) {
                parseSizeValue(heightVal)?.let { result = result.applyHeight(it, context.viewport) }
            }
            return result
        }

        // Single value applies to both
        val size = parseSizeValue(value) ?: return modifier
        return modifier.applyWidth(size, context.viewport).applyHeight(size, context.viewport)
    }
}

/**
 * Applicator for fillMaxSize.
 */
class FillMaxSizeApplicator : ApplicatorHandler {
    override val name: String = "fillMaxSize"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val fraction =
            when (value) {
                is Number -> value.toFloat()
                is Boolean -> if (value) 1f else return modifier
                else -> 1f
            }
        return modifier.fillMaxSize(fraction)
    }
}

/**
 * Applicator for fillMaxWidth.
 * Note: This applicator is now a no-op. fillMaxWidth is applied conditionally
 * in HypenApp.kt based on whether the parent Column allows expansion.
 * This ensures children only expand if parent has explicit width.
 */
class FillMaxWidthApplicator : ApplicatorHandler {
    override val name: String = "fillMaxWidth"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Don't apply here - handled in HypenApp.kt based on parent's LocalParentAllowsHorizontalExpansion
        return modifier
    }
}

/**
 * Applicator for fillMaxHeight.
 */
class FillMaxHeightApplicator : ApplicatorHandler {
    override val name: String = "fillMaxHeight"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val fraction =
            when (value) {
                is Number -> value.toFloat()
                is Boolean -> if (value) 1f else return modifier
                else -> 1f
            }
        return modifier.fillMaxHeight(fraction)
    }
}
