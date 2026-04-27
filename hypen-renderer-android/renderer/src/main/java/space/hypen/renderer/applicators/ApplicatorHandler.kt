package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.ActionDispatcher

/**
 * Context provided to applicators during modifier application.
 */
data class ApplicatorContext(
    val element: HypenElement,
    val actionDispatcher: ActionDispatcher?,
)

/**
 * Priority levels for applicator ordering in Compose.
 *
 * In Jetpack Compose, modifier order matters because modifiers wrap each other outside-in.
 * For example, to have a border visible on top of a background, the background modifier
 * must be applied BEFORE the border modifier.
 *
 * This enum defines the canonical order for applying applicators to ensure consistent
 * visual results across all Hypen components.
 */
enum class ApplicatorPriority(val order: Int) {
    /**
     * External spacing — must run BEFORE size. In Compose, modifier order is
     * outer→inner: `Modifier.padding(m).size(w,h)` grows the outer frame by
     * `m` while the inner content stays `w×h`, matching CSS/SwiftUI margin.
     * The reverse (`size → padding`) shrinks the inner content area and
     * leaves outer size untouched, which is *padding* semantics. Margin
     * applicators must therefore sit before SIZE so `.marginTop(36)` on a
     * fixed-size element like the Stories plus-badge actually shifts the
     * visible box outward instead of clipping its contents to nothing.
     */
    MARGIN(0),
    /** Size constraints: width, height, size, fillMaxSize, etc. */
    SIZE(1),
    /** Layout modifiers: alignment, weight, flex, aspectRatio, offset, gap, zIndex */
    LAYOUT(2),
    /** Shadow/elevation - typically rendered under content */
    SHADOW(4),
    /** Corner radius for clipping - outermost visual boundary */
    CLIP(5),
    /**
     * Border - drawn at the clip edge, outside the background.
     * Matches CSS box model: border is outside background+padding.
     * In Compose, modifier.clip().border().background().padding() means:
     *   clip shapes the element → border at edge → background fills inside → padding insets content.
     */
    BORDER(6),
    /** Background colors, gradients, images - fills inside border */
    BACKGROUND(7),
    /** Internal spacing - innermost, between background and content */
    PADDING(8),
    /** Visual effects: opacity, visibility, blur */
    VISUAL_EFFECTS(9),
    /** Transforms: rotate, scale, translate */
    TRANSFORMS(10),
    /** Event handlers: onClick, onPress, onLongClick */
    EVENTS(11),
    /** Unknown applicators - applied last */
    UNKNOWN(99)
}

/**
 * Maps applicator names to their priority for correct Compose modifier ordering.
 */
object ApplicatorPriorityMap {
    private val priorities: Map<String, ApplicatorPriority> = mapOf(
        // Size
        "width" to ApplicatorPriority.SIZE,
        "height" to ApplicatorPriority.SIZE,
        "minwidth" to ApplicatorPriority.SIZE,
        "maxwidth" to ApplicatorPriority.SIZE,
        "minheight" to ApplicatorPriority.SIZE,
        "maxheight" to ApplicatorPriority.SIZE,
        "size" to ApplicatorPriority.SIZE,
        "fillmaxsize" to ApplicatorPriority.SIZE,
        "fillmaxwidth" to ApplicatorPriority.SIZE,
        "fillmaxheight" to ApplicatorPriority.SIZE,

        // Layout
        "alignment" to ApplicatorPriority.LAYOUT,
        "weight" to ApplicatorPriority.LAYOUT,
        "flex" to ApplicatorPriority.LAYOUT,
        "flexgrow" to ApplicatorPriority.LAYOUT,
        "flexshrink" to ApplicatorPriority.LAYOUT,
        "aspectratio" to ApplicatorPriority.LAYOUT,
        "offset" to ApplicatorPriority.LAYOUT,
        "gap" to ApplicatorPriority.LAYOUT,
        "rowgap" to ApplicatorPriority.LAYOUT,
        "columngap" to ApplicatorPriority.LAYOUT,
        "zindex" to ApplicatorPriority.LAYOUT,

        // Margin (directional variants must share the same priority as base margin
        // so `.marginTop(36)` etc. run BEFORE size — otherwise size clips inner content).
        "margin" to ApplicatorPriority.MARGIN,
        "margintop" to ApplicatorPriority.MARGIN,
        "marginbottom" to ApplicatorPriority.MARGIN,
        "marginleft" to ApplicatorPriority.MARGIN,
        "marginright" to ApplicatorPriority.MARGIN,
        "marginstart" to ApplicatorPriority.MARGIN,
        "marginend" to ApplicatorPriority.MARGIN,
        "marginhorizontal" to ApplicatorPriority.MARGIN,
        "marginvertical" to ApplicatorPriority.MARGIN,

        // Shadow (before background for proper layering)
        "shadow" to ApplicatorPriority.SHADOW,
        "elevation" to ApplicatorPriority.SHADOW,
        "boxshadow" to ApplicatorPriority.SHADOW,

        // Clip (corner radius for clipping)
        "borderradius" to ApplicatorPriority.CLIP,
        "cornerradius" to ApplicatorPriority.CLIP,

        // Border (at clip edge, outside background — matches CSS box model)
        "border" to ApplicatorPriority.BORDER,
        "borderwidth" to ApplicatorPriority.BORDER,
        "bordercolor" to ApplicatorPriority.BORDER,
        "borderstyle" to ApplicatorPriority.BORDER,

        // Background (fills inside border)
        "backgroundcolor" to ApplicatorPriority.BACKGROUND,
        "background" to ApplicatorPriority.BACKGROUND,
        "lineargradient" to ApplicatorPriority.BACKGROUND,
        "radialgradient" to ApplicatorPriority.BACKGROUND,
        "conicgradient" to ApplicatorPriority.BACKGROUND,
        "gradient" to ApplicatorPriority.BACKGROUND,
        "backgroundimage" to ApplicatorPriority.BACKGROUND,
        "backgroundsize" to ApplicatorPriority.BACKGROUND,
        "backgroundposition" to ApplicatorPriority.BACKGROUND,

        // Padding (directional variants share the same priority as base padding)
        "padding" to ApplicatorPriority.PADDING,
        "paddingtop" to ApplicatorPriority.PADDING,
        "paddingbottom" to ApplicatorPriority.PADDING,
        "paddingleft" to ApplicatorPriority.PADDING,
        "paddingright" to ApplicatorPriority.PADDING,
        "paddingstart" to ApplicatorPriority.PADDING,
        "paddingend" to ApplicatorPriority.PADDING,
        "paddinghorizontal" to ApplicatorPriority.PADDING,
        "paddingvertical" to ApplicatorPriority.PADDING,

        // Visual Effects
        "opacity" to ApplicatorPriority.VISUAL_EFFECTS,
        "visibility" to ApplicatorPriority.VISUAL_EFFECTS,
        "blur" to ApplicatorPriority.VISUAL_EFFECTS,
        "cliptobounds" to ApplicatorPriority.CLIP,

        // Transforms
        "rotate" to ApplicatorPriority.TRANSFORMS,
        "scale" to ApplicatorPriority.TRANSFORMS,
        "scalex" to ApplicatorPriority.TRANSFORMS,
        "scaley" to ApplicatorPriority.TRANSFORMS,
        "translatex" to ApplicatorPriority.TRANSFORMS,
        "translatey" to ApplicatorPriority.TRANSFORMS,
        "transform" to ApplicatorPriority.TRANSFORMS,

        // Events
        "onclick" to ApplicatorPriority.EVENTS,
        "onpress" to ApplicatorPriority.EVENTS,
        "onlongclick" to ApplicatorPriority.EVENTS,
        "onlongpress" to ApplicatorPriority.EVENTS,
        "onfocus" to ApplicatorPriority.EVENTS,
        "onblur" to ApplicatorPriority.EVENTS,
    )

    /**
     * Get the priority for an applicator name.
     * Returns UNKNOWN priority if the applicator is not in the map.
     */
    fun getPriority(name: String): ApplicatorPriority {
        return priorities[name.lowercase()] ?: ApplicatorPriority.UNKNOWN
    }
}

/**
 * Interface for handling the application of a specific property/applicator to a Compose modifier.
 * Each applicator (padding, color, fontSize, onClick, etc.) has its own handler.
 */
interface ApplicatorHandler {
    /**
     * The applicator name (e.g., "padding", "backgroundColor", "onClick").
     */
    val name: String

    /**
     * Apply this applicator to a modifier.
     *
     * @param modifier The current modifier to extend
     * @param value The applicator value
     * @param context The applicator context with element and dispatcher
     * @return The modified Modifier
     */
    fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier
}

/**
 * Registry for applicator handlers.
 * Maps applicator names to their handlers.
 */
interface ApplicatorRegistry {
    /**
     * Register an applicator handler.
     */
    fun register(handler: ApplicatorHandler)

    /**
     * Get a handler for an applicator name.
     */
    fun getHandler(name: String): ApplicatorHandler?

    /**
     * Apply all applicators from an element's props to a modifier.
     */
    fun applyAll(
        modifier: Modifier,
        element: HypenElement,
        context: ApplicatorContext,
    ): Modifier

    /**
     * Check if a handler exists for an applicator name.
     */
    fun hasHandler(name: String): Boolean
}

/**
 * Default implementation of ApplicatorRegistry.
 */
class DefaultApplicatorRegistry : ApplicatorRegistry {
    private val handlers = mutableMapOf<String, ApplicatorHandler>()

    override fun register(handler: ApplicatorHandler) {
        handlers[handler.name.lowercase()] = handler
    }

    override fun getHandler(name: String): ApplicatorHandler? {
        // Try exact match first, then lowercase
        return handlers[name] ?: handlers[name.lowercase()]
    }

    override fun hasHandler(name: String): Boolean = handlers.containsKey(name) || handlers.containsKey(name.lowercase())

    override fun applyAll(
        modifier: Modifier,
        element: HypenElement,
        context: ApplicatorContext,
    ): Modifier {
        var result = modifier

        // Group applicators by base name to handle compound applicators like onClick.0, onClick.id
        val grouped = groupApplicators(element.props)

        // Sort applicators by priority for correct Compose modifier ordering
        val sortedApplicators = grouped.entries.sortedBy { (baseName, _) ->
            ApplicatorPriorityMap.getPriority(baseName).order
        }

        for ((baseName, args) in sortedApplicators) {
            val handler = getHandler(baseName)
            if (handler != null) {
                // If it's a single value applicator, pass just the value
                val value =
                    when {
                        args.size == 1 && args.containsKey("__value") -> args["__value"]
                        args.size == 1 && args.containsKey("0") -> args["0"]
                        else -> args
                    }
                result = handler.apply(result, value, context)
            }
        }

        return result
    }

    /**
     * Apply all applicators with variant support.
     * Separates base styles from responsive and state-based variant styles.
     */
    fun applyAllWithVariants(
        modifier: Modifier,
        element: HypenElement,
        context: ApplicatorContext,
    ): ApplicatorResultWithVariants {
        var baseModifier = modifier
        val responsiveModifiers = mutableMapOf<Breakpoint, Modifier>()
        val stateModifiers = mutableMapOf<StateVariant, Modifier>()

        // Group applicators, separating variants from base props
        val baseGrouped = mutableMapOf<String, MutableMap<String, Any?>>()
        val responsiveGrouped = mutableMapOf<Breakpoint, MutableMap<String, MutableMap<String, Any?>>>()
        val stateGrouped = mutableMapOf<StateVariant, MutableMap<String, MutableMap<String, Any?>>>()

        for ((name, value) in element.props) {
            val dotIndex = name.indexOf('.')
            val (propName, argKey) = if (dotIndex != -1) {
                name.substring(0, dotIndex) to name.substring(dotIndex + 1)
            } else {
                name to "__value"
            }

            // Parse for variant suffix
            val variantInfo = parseVariantName(propName)

            when {
                variantInfo.breakpoint != null -> {
                    // Responsive variant
                    val bpGroups = responsiveGrouped.getOrPut(variantInfo.breakpoint) { mutableMapOf() }
                    val args = bpGroups.getOrPut(variantInfo.baseName) { mutableMapOf() }
                    args[argKey] = value
                }
                variantInfo.state != null -> {
                    // State variant
                    val stGroups = stateGrouped.getOrPut(variantInfo.state) { mutableMapOf() }
                    val args = stGroups.getOrPut(variantInfo.baseName) { mutableMapOf() }
                    args[argKey] = value
                }
                else -> {
                    // Base prop
                    val args = baseGrouped.getOrPut(propName) { mutableMapOf() }
                    args[argKey] = value
                }
            }
        }

        // Apply base applicators (sorted by priority for correct Compose modifier ordering)
        val sortedBaseApplicators = baseGrouped.entries.sortedBy { (baseName, _) ->
            ApplicatorPriorityMap.getPriority(baseName).order
        }
        for ((baseName, args) in sortedBaseApplicators) {
            val handler = getHandler(baseName)
            if (handler != null) {
                val value = when {
                    args.size == 1 && args.containsKey("__value") -> args["__value"]
                    args.size == 1 && args.containsKey("0") -> args["0"]
                    else -> args
                }
                baseModifier = handler.apply(baseModifier, value, context)
            }
        }

        // Apply responsive variant applicators (sorted by priority)
        for ((breakpoint, groups) in responsiveGrouped) {
            var variantModifier: Modifier = Modifier
            val sortedGroups = groups.entries.sortedBy { (baseName, _) ->
                ApplicatorPriorityMap.getPriority(baseName).order
            }
            for ((baseName, args) in sortedGroups) {
                val handler = getHandler(baseName)
                if (handler != null) {
                    val value = when {
                        args.size == 1 && args.containsKey("__value") -> args["__value"]
                        args.size == 1 && args.containsKey("0") -> args["0"]
                        else -> args
                    }
                    variantModifier = handler.apply(variantModifier, value, context)
                }
            }
            responsiveModifiers[breakpoint] = variantModifier
        }

        // Apply state variant applicators (sorted by priority)
        for ((state, groups) in stateGrouped) {
            var variantModifier: Modifier = Modifier
            val sortedGroups = groups.entries.sortedBy { (baseName, _) ->
                ApplicatorPriorityMap.getPriority(baseName).order
            }
            for ((baseName, args) in sortedGroups) {
                val handler = getHandler(baseName)
                if (handler != null) {
                    val value = when {
                        args.size == 1 && args.containsKey("__value") -> args["__value"]
                        args.size == 1 && args.containsKey("0") -> args["0"]
                        else -> args
                    }
                    variantModifier = handler.apply(variantModifier, value, context)
                }
            }
            stateModifiers[state] = variantModifier
        }

        return ApplicatorResultWithVariants(
            baseModifier = baseModifier,
            responsiveModifiers = responsiveModifiers,
            stateModifiers = stateModifiers
        )
    }

    /**
     * Groups applicator props by their base name.
     * e.g., "onClick.0", "onClick.id" -> "onClick" -> {0: value, id: value}
     */
    private fun groupApplicators(props: Map<String, Any?>): Map<String, Map<String, Any?>> {
        val grouped = mutableMapOf<String, MutableMap<String, Any?>>()

        for ((name, value) in props) {
            val dotIndex = name.indexOf('.')
            if (dotIndex != -1) {
                val baseName = name.substring(0, dotIndex)
                val argKey = name.substring(dotIndex + 1)

                val args = grouped.getOrPut(baseName) { mutableMapOf() }
                args[argKey] = value
            } else {
                val args = grouped.getOrPut(name) { mutableMapOf() }
                args["__value"] = value
            }
        }

        return grouped
    }
}
