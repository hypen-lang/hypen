package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset

/**
 * Spacing modifiers that survive the values CSS actually produces.
 *
 * `Modifier.padding` has a hard `require(value >= 0) { "Padding must be
 * non-negative" }`. Both spacing applicators used to hand it wire values
 * unchecked, so a single negative margin took the whole app down with an
 * uncaught `IllegalArgumentException` mid-composition — and negative margins
 * are ordinary CSS that the Tailwind parser emits directly
 * (`tailwind-parse/src/spacing.rs` strips a `-m-` prefix for `-m-4` and
 * friends).
 *
 * Renderers degrade, they don't crash (the animation spec's invariant 6,
 * "snap, don't error" — the same principle applies to layout).
 */

/** Zero unless [this] is positive. */
private fun Dp.positivePart(): Dp = if (value > 0f) this else 0.dp

/**
 * CSS `padding`, clamped at zero.
 *
 * Negative padding is invalid CSS — browsers discard the declaration — so
 * clamping matches the web renderer's effective behaviour.
 */
internal fun Modifier.cssPadding(
    start: Dp = 0.dp,
    top: Dp = 0.dp,
    end: Dp = 0.dp,
    bottom: Dp = 0.dp,
): Modifier = padding(
    start = start.positivePart(),
    top = top.positivePart(),
    end = end.positivePart(),
    bottom = bottom.positivePart(),
)

/** CSS `padding` shorthand with one value for every side. */
internal fun Modifier.cssPadding(all: Dp): Modifier = padding(all.positivePart())

/**
 * One axis of a signed margin box, expressed in physical pixels.
 *
 * [childOffset] is relative to the logical start/top of the reported box and
 * [outerSize] is the space the parent advances before laying out the next
 * sibling. Keeping this calculation separate makes the sibling-placement
 * contract directly testable without an Android device.
 */
internal data class MarginAxisGeometry(
    val childOffset: Int,
    val outerSize: Int,
)

internal fun marginAxisGeometry(
    contentSize: Int,
    before: Int,
    after: Int,
    minSize: Int,
    maxSize: Int,
): MarginAxisGeometry {
    val desiredOuterSize = contentSize.toLong() + before.toLong() + after.toLong()
    val constrainedOuterSize = desiredOuterSize
        .coerceIn(minSize.toLong(), maxSize.toLong())
        .toInt()
    return MarginAxisGeometry(childOffset = before, outerSize = constrainedOuterSize)
}

/**
 * CSS `margin`, including negative values.
 *
 * Compose padding already models non-negative margins correctly because this
 * modifier is ordered outside size applicators. If any edge is negative we
 * need a signed layout instead: the child moves by its start/top margin while
 * the reported size includes all four signed margins. The parent therefore
 * advances by the CSS margin-box size, so later siblings overlap correctly.
 * `placeRelative` keeps start/end semantics correct in RTL layouts.
 */
internal fun Modifier.cssMargin(
    start: Dp = 0.dp,
    top: Dp = 0.dp,
    end: Dp = 0.dp,
    bottom: Dp = 0.dp,
): Modifier {
    if (start.value >= 0f && top.value >= 0f && end.value >= 0f && bottom.value >= 0f) {
        return cssPadding(start = start, top = top, end = end, bottom = bottom)
    }

    return layout { measurable, constraints ->
        val startPx = start.roundToPx()
        val topPx = top.roundToPx()
        val endPx = end.roundToPx()
        val bottomPx = bottom.roundToPx()
        val horizontalMargins = startPx + endPx
        val verticalMargins = topPx + bottomPx

        // Positive margins reduce the proposal for the child; negative ones
        // enlarge it. This is the same box-model relationship used by
        // Compose's padding modifier, extended to signed values.
        val placeable = measurable.measure(
            constraints.offset(
                horizontal = -horizontalMargins,
                vertical = -verticalMargins,
            ),
        )
        val horizontal = marginAxisGeometry(
            contentSize = placeable.width,
            before = startPx,
            after = endPx,
            minSize = constraints.minWidth,
            maxSize = constraints.maxWidth,
        )
        val vertical = marginAxisGeometry(
            contentSize = placeable.height,
            before = topPx,
            after = bottomPx,
            minSize = constraints.minHeight,
            maxSize = constraints.maxHeight,
        )

        layout(horizontal.outerSize, vertical.outerSize) {
            placeable.placeRelative(horizontal.childOffset, vertical.childOffset)
        }
    }
}

/** CSS `margin` shorthand with one value for every side. */
internal fun Modifier.cssMargin(all: Dp): Modifier =
    cssMargin(start = all, top = all, end = all, bottom = all)
