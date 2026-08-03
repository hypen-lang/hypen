package space.hypen.renderer.applicators

import android.content.res.Configuration
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration

/**
 * Tailwind-compatible breakpoint definitions.
 */
enum class Breakpoint(val minWidthDp: Int) {
    SM(640),
    MD(768),
    LG(1024),
    XL(1280),
    XXL(1536);

    companion object {
        fun from(name: String): Breakpoint? = when (name.lowercase()) {
            "sm" -> SM
            "md" -> MD
            "lg" -> LG
            "xl" -> XL
            "2xl" -> XXL
            else -> null
        }
    }
}

/**
 * CSS-like pseudo-state variants.
 */
enum class StateVariant {
    HOVER,
    FOCUS,
    ACTIVE,
    DISABLED,
    FOCUS_VISIBLE,
    FOCUS_WITHIN;

    companion object {
        fun from(name: String): StateVariant? = when (name.lowercase()) {
            "hover" -> HOVER
            "focus" -> FOCUS
            "active" -> ACTIVE
            "disabled" -> DISABLED
            "focus-visible" -> FOCUS_VISIBLE
            "focus-within" -> FOCUS_WITHIN
            else -> null
        }
    }
}

/**
 * Result of parsing a property name for variant suffixes.
 */
data class VariantInfo(
    val baseName: String,
    val breakpoint: Breakpoint? = null,
    val state: StateVariant? = null
) {
    val isResponsive: Boolean get() = breakpoint != null
    val isStateful: Boolean get() = state != null
    val isVariant: Boolean get() = isResponsive || isStateful
}

/**
 * Parse a property name to extract variant information.
 *
 * Examples:
 *   "padding" -> VariantInfo(baseName: "padding", breakpoint: null, state: null)
 *   "padding@md" -> VariantInfo(baseName: "padding", breakpoint: MD, state: null)
 *   "background-color:hover" -> VariantInfo(baseName: "background-color", breakpoint: null, state: HOVER)
 */
fun parseVariantName(name: String): VariantInfo {
    // Canonical key order is `base@bp:state`; a key may carry the breakpoint
    // marker, the state marker, BOTH (combined, e.g. "backgroundColor@md:hover"),
    // or neither. Peel the state marker first, then the breakpoint marker, so a
    // combined key resolves both halves instead of silently dropping the second.
    // An unrecognised marker is left in the base name (so it never matches a real
    // applicator), matching the engine + web parsers.
    var base = name
    var breakpoint: Breakpoint? = null
    var state: StateVariant? = null

    val colonIndex = base.indexOf(':')
    if (colonIndex != -1) {
        val st = StateVariant.from(base.substring(colonIndex + 1))
        if (st != null) {
            state = st
            base = base.substring(0, colonIndex)
        }
    }

    val atIndex = base.indexOf('@')
    if (atIndex != -1) {
        val bp = Breakpoint.from(base.substring(atIndex + 1))
        if (bp != null) {
            breakpoint = bp
            base = base.substring(0, atIndex)
        }
    }

    return VariantInfo(baseName = base, breakpoint = breakpoint, state = state)
}

/**
 * Result of applying applicators with variant support.
 */
data class ApplicatorResultWithVariants(
    val baseModifier: Modifier,
    val responsiveModifiers: Map<Breakpoint, Modifier>,
    val stateModifiers: Map<StateVariant, Modifier>,
    /// Combined `@bp:state` overrides — applied only when BOTH the breakpoint is
    /// active at the current width AND the state is active.
    val combinedModifiers: Map<Pair<Breakpoint, StateVariant>, Modifier> = emptyMap()
) {
    val hasResponsiveVariants: Boolean get() = responsiveModifiers.isNotEmpty()
    val hasStateVariants: Boolean get() = stateModifiers.isNotEmpty()
    val hasCombinedVariants: Boolean get() = combinedModifiers.isNotEmpty()
    val hasVariants: Boolean get() = hasResponsiveVariants || hasStateVariants || hasCombinedVariants

    /**
     * Get the effective modifier for a given screen width.
     */
    fun getModifierForWidth(screenWidthDp: Int): Modifier {
        var result = baseModifier

        // Apply responsive modifiers from smallest to largest breakpoint
        for (breakpoint in Breakpoint.entries.sortedBy { it.minWidthDp }) {
            if (screenWidthDp >= breakpoint.minWidthDp) {
                responsiveModifiers[breakpoint]?.let { variantModifier ->
                    result = result.then(variantModifier)
                }
            }
        }

        return result
    }
}

/**
 * Composable function to get current screen width in dp.
 */
@Composable
fun getScreenWidthDp(): Int {
    val configuration = LocalConfiguration.current
    return configuration.screenWidthDp
}

/**
 * Composable function that provides the effective modifier based on current screen width.
 */
@Composable
fun ApplicatorResultWithVariants.effectiveModifier(): Modifier {
    val screenWidthDp = getScreenWidthDp()
    return getModifierForWidth(screenWidthDp)
}

/**
 * Composable that applies variant-aware modifiers including state tracking.
 */
@Composable
fun rememberVariantModifier(
    result: ApplicatorResultWithVariants,
    isDisabled: Boolean = false
): Modifier {
    // Get responsive modifier based on screen width
    val screenWidthDp = getScreenWidthDp()
    var modifier = result.getModifierForWidth(screenWidthDp)

    // Track interaction states for state and combined variants
    if (result.hasStateVariants || result.hasCombinedVariants) {
        val interactionSource = remember { MutableInteractionSource() }
        val isHovered by interactionSource.collectIsHoveredAsState()
        val isFocused by interactionSource.collectIsFocusedAsState()
        val isPressed by interactionSource.collectIsPressedAsState()

        // Apply combined `@bp:state` overrides for `state` whose breakpoint is
        // active at the current width, smallest→largest so a higher breakpoint
        // wins the within-band tiebreak. Layered right after the plain state
        // override so a combined `@md:hover` beats a plain `:hover`.
        fun applyCombined(m: Modifier, state: StateVariant): Modifier {
            if (!result.hasCombinedVariants) return m
            var out = m
            for (bp in Breakpoint.entries.sortedBy { it.minWidthDp }) {
                if (screenWidthDp >= bp.minWidthDp) {
                    result.combinedModifiers[bp to state]?.let { out = out.then(it) }
                }
            }
            return out
        }

        // Apply state modifiers in order of precedence (disabled < hover < focus < active)
        if (isDisabled) {
            result.stateModifiers[StateVariant.DISABLED]?.let {
                modifier = modifier.then(it)
            }
            modifier = applyCombined(modifier, StateVariant.DISABLED)
        }

        if (isHovered) {
            result.stateModifiers[StateVariant.HOVER]?.let {
                modifier = modifier.then(it)
            }
            modifier = applyCombined(modifier, StateVariant.HOVER)
        }

        if (isFocused) {
            // focus, focus-visible, and focus-within share the focus band (no
            // keyboard-vs-pointer / descendant-focus distinction natively;
            // matches the engine ranking all three at the focus slot).
            for (st in listOf(StateVariant.FOCUS, StateVariant.FOCUS_VISIBLE, StateVariant.FOCUS_WITHIN)) {
                result.stateModifiers[st]?.let {
                    modifier = modifier.then(it)
                }
                modifier = applyCombined(modifier, st)
            }
        }

        if (isPressed) {
            result.stateModifiers[StateVariant.ACTIVE]?.let {
                modifier = modifier.then(it)
            }
            modifier = applyCombined(modifier, StateVariant.ACTIVE)
        }
    }

    return modifier
}
