package space.hypen.renderer.components

import androidx.compose.ui.Alignment
import space.hypen.renderer.applicators.AlignmentApplicator
import space.hypen.renderer.model.HypenElement

/**
 * How a Box-shaped container places its content: `.alignment(...)` when the
 * author gave both axes at once, otherwise the Hypen-native
 * `.horizontalAlignment(...)`/`.verticalAlignment(...)` and the CSS
 * `justify-content`/`align-items` a `.tw()` class expands to.
 *
 * Flex's main axis in the default row direction is horizontal, so
 * `justifyContent` lands on the horizontal side and `alignItems` on the
 * vertical — the reading the Swift renderer settled on for the same props
 * (Applicators/LayoutApplicators.swift).
 *
 * The alignment applicators exist for containers that have no handler of
 * their own, but they cannot serve these: HypenApp appends its
 * `fillMaxWidth` policy modifier *after* the whole applicator chain, which
 * would fill straight through an outer `wrapContentWidth` and leave the
 * content pinned. Resolving the props here instead keeps `fillMaxWidth` — by
 * far the case where alignment matters — working, so these types opt out of
 * the applicators in `alignmentOwningTypes`.
 */
internal fun hypenContentAlignment(
    element: HypenElement,
    defaultHorizontal: Alignment.Horizontal = Alignment.Start,
    defaultVertical: Alignment.Vertical = Alignment.Top,
): Alignment {
    element.getStringProp("alignment.0")
        ?.let(AlignmentApplicator::parseAlignment)
        ?.let { return it }

    val horizontal = element.getStringProp("horizontalAlignment.0")
        ?: element.getStringProp("justifyContent.0")
    val vertical = element.getStringProp("verticalAlignment.0")
        ?: element.getStringProp("alignItems.0")

    val h = AlignmentApplicator.parseHorizontalAlignment(horizontal) ?: defaultHorizontal
    val v = AlignmentApplicator.parseVerticalAlignment(vertical) ?: defaultVertical

    return when {
        h == Alignment.Start && v == Alignment.Top -> Alignment.TopStart
        h == Alignment.CenterHorizontally && v == Alignment.Top -> Alignment.TopCenter
        h == Alignment.End && v == Alignment.Top -> Alignment.TopEnd
        h == Alignment.Start && v == Alignment.CenterVertically -> Alignment.CenterStart
        h == Alignment.CenterHorizontally && v == Alignment.CenterVertically -> Alignment.Center
        h == Alignment.End && v == Alignment.CenterVertically -> Alignment.CenterEnd
        h == Alignment.Start && v == Alignment.Bottom -> Alignment.BottomStart
        h == Alignment.CenterHorizontally && v == Alignment.Bottom -> Alignment.BottomCenter
        h == Alignment.End && v == Alignment.Bottom -> Alignment.BottomEnd
        else -> Alignment.TopStart
    }
}
