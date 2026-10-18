package space.hypen.renderer.model

import java.math.BigDecimal

/**
 * Converts a prop value to the text a user sees, matching JavaScript's
 * `String(value)` for numbers so every renderer shows the same thing.
 *
 * Wire JSON numbers arrive as [Double], and Kotlin's `Double.toString()`
 * prints `2.0` for a whole number and `1.0E-4` for small ones, where the
 * web renderer prints `2` and `0.0001`. Non-numeric values use `toString()`.
 * Returns null only for a null value.
 */
fun propToDisplayString(value: Any?): String? =
    when (value) {
        null -> null
        is Double -> formatJsNumber(value)
        is Float -> formatJsNumber(value.toString().toDouble())
        else -> value.toString()
    }

/** JavaScript `Number.prototype.toString()` for a double. */
internal fun formatJsNumber(v: Double): String {
    if (v.isNaN()) return "NaN"
    if (v == Double.POSITIVE_INFINITY) return "Infinity"
    if (v == Double.NEGATIVE_INFINITY) return "-Infinity"
    if (v == 0.0) return "0" // also -0.0, which JS prints as "0"
    val abs = kotlin.math.abs(v)
    // JS uses plain notation for 1e-6 <= |v| < 1e21. Double.toString() is the
    // shortest round-trip form, so re-rendering it plainly keeps JS's digits.
    if (abs >= 1e-6 && abs < 1e21) {
        return BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
    }
    // Exponential: Java "1.5E-8" / "1.0E21" -> JS "1.5e-8" / "1e+21".
    val s = v.toString()
    val e = s.indexOf('E')
    if (e < 0) return s
    val mantissa = s.substring(0, e).removeSuffix(".0")
    val exp = s.substring(e + 1)
    return mantissa + "e" + (if (exp.startsWith("-")) exp else "+$exp")
}
