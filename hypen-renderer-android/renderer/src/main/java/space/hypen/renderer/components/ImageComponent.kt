package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Image components.
 * Uses Coil for async image loading from URLs.
 *
 * Image source is passed as an argument: Image("url") or Image(src: "url")
 * All styling is done via applicators: Image("url").objectFit(cover)
 */
class ImageComponent : ComponentHandler {
    override val typeName: String = "image"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Image source comes from prop "0", "src", or "source" (these are arguments, not styling)
        val src =
            element.getStringProp("0")
                ?: element.getStringProp("src")
                ?: element.getStringProp("source")

        // Alt/content description is also an argument (WHAT to display)
        val contentDescription =
            element.getStringProp("alt")
                ?: element.getStringProp("contentDescription")

        // Content scale - applicator only: .objectFit(cover)
        val contentScaleStr = element.getStringProp("objectFit.0")

        val contentScale =
            when (contentScaleStr?.lowercase()) {
                "crop" -> ContentScale.Crop
                "cover" -> ContentScale.Crop
                "contain" -> ContentScale.Fit
                "fit" -> ContentScale.Fit
                "fill" -> ContentScale.FillBounds
                "fillbounds" -> ContentScale.FillBounds
                "none" -> ContentScale.None
                "inside" -> ContentScale.Inside
                else -> ContentScale.Fit
            }

        val imageModifier = if (
            LocalGridStretchesBareImage.current && !element.hasExplicitImageSize()
        ) {
            modifier.fillMaxWidth().aspectRatio(1f)
        } else {
            modifier
        }

        if (src != null) {
            AsyncImage(
                model = src,
                contentDescription = contentDescription,
                modifier = imageModifier,
                contentScale = contentScale,
            )
        } else {
            // Placeholder if no source
            Box(modifier = imageModifier)
        }
    }
}

internal fun HypenElement.hasExplicitImageSize(): Boolean = listOf(
    "width", "height", "size", "minWidth", "maxWidth", "minHeight", "maxHeight",
    "fillMaxWidth", "fillMaxHeight", "fillMaxSize", "aspectRatio",
).any { name -> props.containsKey(name) || props.containsKey("$name.0") }
