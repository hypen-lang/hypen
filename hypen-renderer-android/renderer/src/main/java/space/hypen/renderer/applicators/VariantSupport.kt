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
    // Check for responsive variant (@)
    val atIndex = name.indexOf('@')
    if (atIndex != -1) {
        val baseName = name.substring(0, atIndex)
        val breakpointStr = name.substring(atIndex + 1)
        val breakpoint = Breakpoint.from(breakpointStr)
        return VariantInfo(baseName = baseName, breakpoint = breakpoint)
    }

    // Check for state variant (:)
    val colonIndex = name.indexOf(':')
    if (colonIndex != -1) {
        val baseName = name.substring(0, colonIndex)
        val stateStr = name.substring(colonIndex + 1)
        val state = StateVariant.from(stateStr)
        return VariantInfo(baseName = baseName, state = state)
    }

    return VariantInfo(baseName = name)
}

/**
 * Result of applying applicators with variant support.
 */
data class ApplicatorResultWithVariants(
    val baseModifier: Modifier,
    val responsiveModifiers: Map<Breakpoint, Modifier>,
    val stateModifiers: Map<StateVariant, Modifier>
) {
    val hasResponsiveVariants: Boolean get() = responsiveModifiers.isNotEmpty()
    val hasStateVariants: Boolean get() = stateModifiers.isNotEmpty()
    val hasVariants: Boolean get() = hasResponsiveVariants || hasStateVariants

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

    // Track interaction states for state variants
    if (result.hasStateVariants) {
        val interactionSource = remember { MutableInteractionSource() }
        val isHovered by interactionSource.collectIsHoveredAsState()
        val isFocused by interactionSource.collectIsFocusedAsState()
        val isPressed by interactionSource.collectIsPressedAsState()

        // Apply state modifiers in order of precedence (disabled < hover < focus < active)
        if (isDisabled) {
            result.stateModifiers[StateVariant.DISABLED]?.let {
                modifier = modifier.then(it)
            }
        }

        if (isHovered) {
            result.stateModifiers[StateVariant.HOVER]?.let {
                modifier = modifier.then(it)
            }
        }

        if (isFocused) {
            result.stateModifiers[StateVariant.FOCUS]?.let {
                modifier = modifier.then(it)
            }
            result.stateModifiers[StateVariant.FOCUS_VISIBLE]?.let {
                modifier = modifier.then(it)
            }
        }

        if (isPressed) {
            result.stateModifiers[StateVariant.ACTIVE]?.let {
                modifier = modifier.then(it)
            }
        }
    }

    return modifier
}
