package space.hypen.renderer.components

import space.hypen.renderer.applicators.SizeValue
import space.hypen.renderer.applicators.parseSizeValue
import space.hypen.renderer.model.HypenElement
import kotlin.math.max
import kotlin.math.min

/** Sizing metadata consumed by a Row's single, parent-aware allocation pass. */
internal data class RowItemSizing(
    val fraction: Float? = null,
    val flexWeight: Float = 0f,
    val usesZeroFlexBasis: Boolean = false,
    val shrink: Float = 1f,
    val minimum: Float? = null,
    val maximum: Float? = null,
) {
    val isManaged: Boolean
        get() = fraction != null || flexWeight > 0f || shrink == 0f

    companion object {
        fun from(element: HypenElement): RowItemSizing {
            val flex = element.getFloatProp("flex.0")
                ?: element.getFloatProp("flex")
                ?: element.getFloatProp("weight.0")
                ?: element.getFloatProp("weight")
            val grow = element.getFloatProp("flexGrow.0")
                ?: element.getFloatProp("flexgrow.0")
                ?: element.getFloatProp("flexGrow")
            val fraction = fraction(element.props["fillMaxWidth.0"])
                ?: fractionFromWidth(element.props["width.0"])

            return RowItemSizing(
                fraction = fraction,
                flexWeight = max(0f, flex ?: grow ?: 0f),
                usesZeroFlexBasis = (flex ?: 0f) > 0f,
                shrink = max(
                    0f,
                    element.getFloatProp("flexShrink.0")
                        ?: element.getFloatProp("flexshrink.0")
                        ?: 1f,
                ),
                minimum = fixedDp(element.props["minWidth.0"]),
                maximum = fixedDp(element.props["maxWidth.0"]),
            )
        }

        private fun fraction(value: Any?): Float? = when (value) {
            is Boolean -> if (value) 1f else null
            is Number -> value.toFloat().coerceIn(0f, 1f)
            is String -> value.toFloatOrNull()?.takeIf { it in 0f..1f }
            else -> null
        }

        private fun fractionFromWidth(value: Any?): Float? =
            when (val size = parseSizeValue(value)) {
                is SizeValue.Percent -> size.fraction.coerceIn(0f, 1f)
                is SizeValue.Fill -> size.fraction.coerceIn(0f, 1f)
                else -> null
            }

        private fun fixedDp(value: Any?): Float? =
            (parseSizeValue(value) as? SizeValue.Fixed)?.dp?.value
    }
}

/**
 * CSS-like Row width distribution, independent of Compose measurement so the
 * contract can be unit tested. [availableWidth] is the Row's content box;
 * gaps are removed once, before any child receives a percentage or flex share.
 */
internal fun allocateRowWidths(
    availableWidth: Float,
    gap: Float,
    naturalWidths: List<Float>,
    items: List<RowItemSizing>,
): List<Float> {
    if (naturalWidths.size != items.size || items.isEmpty()) return emptyList()

    val gapTotal = max(0f, gap) * max(0, items.size - 1)
    val pool = max(0f, availableWidth - gapTotal)
    val result = naturalWidths.zip(items).mapTo(mutableListOf()) { (natural, item) ->
        val base = when {
            item.fraction != null -> pool * item.fraction.coerceIn(0f, 1f)
            item.usesZeroFlexBasis -> 0f
            else -> max(0f, natural)
        }
        clampRowWidth(base, item)
    }

    var free = pool - result.sum()
    val totalGrow = items.sumOf { it.flexWeight.toDouble() }.toFloat()
    if (free > 0f && totalGrow > 0f) {
        val active = items.indices.filterTo(mutableSetOf()) { items[it].flexWeight > 0f }
        while (free > 0.001f && active.isNotEmpty()) {
            val activeWeight = active.sumOf { items[it].flexWeight.toDouble() }.toFloat()
            if (activeWeight <= 0f) break
            val startingFree = free
            var consumed = 0f
            val capped = mutableListOf<Int>()
            for (index in active) {
                val grown = clampRowWidth(
                    result[index] + startingFree * items[index].flexWeight / activeWeight,
                    items[index],
                )
                consumed += grown - result[index]
                result[index] = grown
                if (items[index].maximum?.let { grown >= it } == true) capped += index
            }
            free -= consumed
            active.removeAll(capped.toSet())
            if (consumed < 0.001f) break
        }
    } else if (free < 0f) {
        var overflow = -free
        val active = items.indices.filterTo(mutableSetOf()) {
            items[it].shrink > 0f && result[it] > (items[it].minimum ?: 0f)
        }
        while (overflow > 0.001f && active.isNotEmpty()) {
            val factors = active.sumOf {
                (items[it].shrink * max(result[it], 1f)).toDouble()
            }.toFloat()
            if (factors <= 0f) break
            val startingOverflow = overflow
            var removed = 0f
            val floored = mutableListOf<Int>()
            for (index in active) {
                val share = startingOverflow *
                    (items[index].shrink * max(result[index], 1f)) / factors
                val floor = items[index].minimum ?: 0f
                val shrunk = max(floor, result[index] - share)
                removed += result[index] - shrunk
                result[index] = shrunk
                if (shrunk <= floor) floored += index
            }
            overflow -= removed
            active.removeAll(floored.toSet())
            if (removed < 0.001f) break
        }
    }

    return result
}

private fun clampRowWidth(width: Float, item: RowItemSizing): Float {
    var result = width
    item.maximum?.let { result = min(result, it) }
    item.minimum?.let { result = max(result, it) }
    return result
}
