package space.hypen.renderer.applicators

import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

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

/** Zero unless [this] is negative. */
private fun Dp.negativePart(): Dp = if (value < 0f) this else 0.dp

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
 * CSS `margin`, including negative values.
 *
 * A negative margin is legal and pulls the box out of its normal position, so
 * the negative part becomes an offset — padding cannot express it at all.
 *
 * Recorded narrowing: only negative `start`/`top` shift this element.
 * In CSS a negative `end`/`bottom` margin pulls *subsequent siblings* toward
 * this box rather than moving it, which Compose cannot express without a
 * custom layout; those clamp to zero. The element lands in the right place
 * for the common `-mt-*` / `-ms-*` overlap idiom, and nothing crashes.
 */
internal fun Modifier.cssMargin(
    start: Dp = 0.dp,
    top: Dp = 0.dp,
    end: Dp = 0.dp,
    bottom: Dp = 0.dp,
): Modifier {
    val spaced = cssPadding(start = start, top = top, end = end, bottom = bottom)
    val dx = start.negativePart()
    val dy = top.negativePart()
    return if (dx == 0.dp && dy == 0.dp) spaced else spaced.offset(x = dx, y = dy)
}

/** CSS `margin` shorthand with one value for every side. */
internal fun Modifier.cssMargin(all: Dp): Modifier =
    cssMargin(start = all, top = all, end = all, bottom = all)
