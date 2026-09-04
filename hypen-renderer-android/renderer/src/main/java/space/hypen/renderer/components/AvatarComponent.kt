package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

internal const val DEFAULT_AVATAR_SIZE_DP = 40f

internal data class AvatarSizeResolution(
    val sizeDp: Float,
    val hasExplicitDimensions: Boolean,
)

internal fun resolveAvatarSize(element: HypenElement): AvatarSizeResolution {
    // Applicators use .0 suffix: .width(32) becomes "width.0".
    val explicitWidth = element.getFloatProp("width.0")
    val explicitHeight = element.getFloatProp("height.0")
    val sizeValue = element.getStringProp("size")

    val sizeDp = when (sizeValue?.lowercase()) {
        "small" -> 32f
        "medium" -> 48f
        "large" -> 64f
        else -> element.getFloatProp("size")
            ?: explicitWidth
            ?: explicitHeight
            ?: DEFAULT_AVATAR_SIZE_DP
    }

    return AvatarSizeResolution(
        sizeDp = sizeDp,
        hasExplicitDimensions = explicitWidth != null || explicitHeight != null,
    )
}

/**
 * Handler for Avatar component - user profile image or initials.
 */
class AvatarComponent : ComponentHandler {
    override val typeName: String = "avatar"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Image source - check all possible prop formats
        // Named args may be stored as "src.0" or "src", positional as "0"
        val src = element.getStringProp("src.0")
            ?: element.getStringProp("0")
            ?: element.getStringProp("src")
            ?: element.getStringProp("source")

        // Fallback text (usually initials)
        val fallback = element.getStringProp("fallback")
            ?: element.getStringProp("alt")
            ?: element.getStringProp("initials")
            ?: ""

        // Explicit width/height applicators already live in `modifier`, so they
        // must not be overwritten by the component's square default.
        val sizeResolution = resolveAvatarSize(element)
        val size = sizeResolution.sizeDp.dp

        // Background color for fallback
        val bgColorStr = element.getStringProp("backgroundColor.0")
        val backgroundColor = bgColorStr?.let { ColorParser.parse(it) } ?: Color(0xFF9E9E9E)

        // Text color
        val textColorStr = element.getStringProp("color.0")
        val textColor = textColorStr?.let { ColorParser.parse(it) } ?: Color.White

        // Only apply .size() if no explicit width/height from applicators
        // Otherwise the modifier already has the correct dimensions
        val boxModifier = if (sizeResolution.hasExplicitDimensions) {
            modifier.clip(CircleShape).background(backgroundColor)
        } else {
            modifier.size(size).clip(CircleShape).background(backgroundColor)
        }

        Box(
            modifier = boxModifier,
            contentAlignment = Alignment.Center
        ) {
            if (!src.isNullOrEmpty()) {
                AsyncImage(
                    model = src,
                    contentDescription = fallback,
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(CircleShape),
                    contentScale = ContentScale.Crop,
                )
            } else if (fallback.isNotEmpty()) {
                // Show initials
                val initials = fallback.take(2).uppercase()
                Text(
                    text = initials,
                    color = textColor,
                    fontSize = (size.value / 2.5f).sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}
