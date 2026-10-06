package space.hypen.renderer.components

import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

/**
 * The content colour a container hands down to its descendants.
 *
 * `.foregroundColor(...)` and `.color(...)` are the same intent - CSS
 * `color`, which inherits - so both resolve here. `color` is canonical and
 * wins when a node sets both, matching DOM, canvas, Swift and this
 * renderer's own text path (`ForegroundColorTextApplicator`).
 *
 * This cannot be an applicator: content colour is a CompositionLocal and a
 * Modifier has no way to provide one, which is why ForegroundColorApplicator
 * was a silent no-op. Containers provide it around their children instead,
 * the way ColumnComponent already did for `.color(...)`.
 */
internal fun hypenContentColor(element: HypenElement): Color? {
    val value = element.getStringProp("color.0")
        ?: element.getStringProp("color")
        ?: element.getStringProp("foregroundColor.0")
        ?: element.getStringProp("foregroundColor")
    return value?.let(ColorParser::parse)
}

/** Runs [content] under this element's content colour, when it declares one. */
@Composable
internal fun ProvideHypenContentColor(
    element: HypenElement,
    content: @Composable () -> Unit,
) {
    val color = hypenContentColor(element)
    if (color == null) {
        content()
    } else {
        CompositionLocalProvider(LocalContentColor provides color, content = content)
    }
}
