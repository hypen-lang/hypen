package space.hypen.gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A small floating pill that hovers over the Hypen view, showing the
 * connection URL + a red/green status dot. Tapping expands into the full
 * BrowserToolbar. Kept compact so it doesn't compete for vertical space
 * with the rendered app.
 */
@Composable
fun BrowserPill(
    currentUrl: String,
    isConnected: Boolean,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .clickable { onTap() }
            .widthIn(max = 280.dp),
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        shadowElevation = 6.dp,
        tonalElevation = 2.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Red when disconnected, green when connected.
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(RoundedCornerShape(50))
                    .background(
                        if (isConnected) Color(0xFF22C55E) else Color(0xFFEF4444),
                    )
            )

            Text(
                text = displayUrl(currentUrl),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Trim noise from the URL so the pill stays readable at small sizes —
 * drop the ws/http scheme and any trailing slash. The full URL is still
 * available (and editable) in the expanded toolbar.
 */
private fun displayUrl(raw: String): String {
    if (raw.isBlank()) return "no connection"
    var s = raw
    for (p in listOf("wss://", "ws://", "https://", "http://")) {
        if (s.startsWith(p)) {
            s = s.removePrefix(p)
            break
        }
    }
    return s.removeSuffix("/")
}
