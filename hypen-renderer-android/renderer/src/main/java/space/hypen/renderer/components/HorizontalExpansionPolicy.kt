package space.hypen.renderer.components

import space.hypen.renderer.applicators.SizeValue
import space.hypen.renderer.applicators.parseSizeValue
import space.hypen.renderer.model.HypenElement

/**
 * Whether a Column establishes a horizontal extent that its fill-width
 * descendants may use.
 *
 * This is deliberately based on the same applicators that size the Column,
 * rather than on the wire value's Kotlin type. A string width such as `80%`
 * is just as explicit as a numeric width, and fillMaxSize also establishes the
 * cross-axis extent.
 */
internal fun columnAllowsHorizontalExpansion(
    element: HypenElement,
    inheritedHorizontalExpansion: Boolean = false,
): Boolean {
    val hasFillMaxWidth = fillApplicatorEnabled(element.props["fillMaxWidth.0"])
    val hasFillMaxSize = fillApplicatorEnabled(element.props["fillMaxSize.0"])
    val width = parseSizeValue(element.props["width.0"])
    val hasExplicitWidth = width != null && width !is SizeValue.Wrap

    return inheritedHorizontalExpansion || hasFillMaxWidth || hasFillMaxSize || hasExplicitWidth
}

private fun fillApplicatorEnabled(value: Any?): Boolean =
    when (value) {
        null -> false
        is Boolean -> value
        // Fractional fill applicators are still explicit sizing requests.
        is Number -> true
        // Matches the size applicators' fallback for supplied non-numeric values.
        else -> true
    }

/**
 * Resolves fillMaxWidth after enforcing the parent permission. The fraction
 * handling mirrors the existing renderer behavior while also making the
 * documented numeric form (`fillMaxWidth(0.5)`) reachable.
 */
internal fun permittedFillMaxWidthFraction(
    element: HypenElement,
    parentAllowsHorizontalExpansion: Boolean,
): Float? {
    if (!parentAllowsHorizontalExpansion) return null

    return when (val value = element.props["fillMaxWidth.0"]) {
        null -> null
        is Boolean -> if (value) 1f else null
        is Number -> value.toFloat().let { if (it > 0f) it else 1f }
        else -> 1f
    }
}
