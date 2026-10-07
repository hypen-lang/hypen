package space.hypen.gallery

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenApp
import space.hypen.renderer.components.HypenSafeAreaInsets
import space.hypen.renderer.remote.RemoteEngineConfig
import space.hypen.gallery.ui.theme.HypenGalleryTheme

/**
 * Represents a component or applicator entry in the gallery.
 */
data class GalleryItem(
    val name: String,
    val path: String,
    val description: String,
    val isApplicator: Boolean,
)

/**
 * All gallery items for the component gallery server.
 * Single server on port 6555 with path-based routing.
 */
object GalleryItems {
    const val SERVER_PORT = 6555

    val components = listOf(
        GalleryItem("Column", "/components/column", "Vertical stack container", false),
        GalleryItem("Row", "/components/row", "Horizontal stack container", false),
        GalleryItem("Text", "/components/text", "Text display", false),
        GalleryItem("Button", "/components/button", "Interactive button", false),
        GalleryItem("Image", "/components/image", "Image display", false),
        GalleryItem("Container", "/components/container", "Generic container", false),
        GalleryItem("Center", "/components/center", "Centers content", false),
        GalleryItem("List", "/components/list", "Scrollable list", false),
        GalleryItem("Input", "/components/input", "Text input field", false),
        GalleryItem("Link", "/components/link", "Navigation link", false),
        GalleryItem("TextArea", "/components/textarea", "Multi-line text input", false),
        GalleryItem("Checkbox", "/components/checkbox", "Toggle checkbox", false),
        GalleryItem("Select", "/components/select", "Dropdown selection", false),
        GalleryItem("Spacer", "/components/spacer", "Flexible space", false),
        GalleryItem("Stack", "/components/stack", "Overlays children", false),
        GalleryItem("Divider", "/components/divider", "Visual separator", false),
        GalleryItem("SafeArea", "/components/safearea", "Insets content past the system bars", false),
        GalleryItem("Grid", "/components/grid", "Grid layout", false),
        GalleryItem("Card", "/components/card", "Styled card container", false),
        GalleryItem("Heading", "/components/heading", "Semantic heading", false),
        GalleryItem("Switch", "/components/switch", "Toggle switch", false),
        GalleryItem("Slider", "/components/slider", "Range slider", false),
        GalleryItem("Spinner", "/components/spinner", "Loading indicator", false),
        GalleryItem("Badge", "/components/badge", "Status badge", false),
        GalleryItem("Avatar", "/components/avatar", "User avatar", false),
        GalleryItem("ProgressBar", "/components/progressbar", "Progress indicator", false),
        GalleryItem("Chart", "/components/chart", "Data marks in a coordinate space", false),
        GalleryItem("Video", "/components/video", "Video player", false),
        GalleryItem("Audio", "/components/audio", "Audio player", false),
        GalleryItem("Paragraph", "/components/paragraph", "Block of text", false),
        GalleryItem("Counter", "/components/counter", "Interactive counter", false),
        GalleryItem("Calculator", "/components/calculator", "Functional calculator", false),
        GalleryItem("Onboarding", "/components/onboarding", "Multi-step onboarding flow", false),
        GalleryItem("Todo", "/components/todo", "Todo list app", false),
    )

    val applicators = listOf(
        GalleryItem("padding", "/applicators/padding", "Internal spacing", true),
        GalleryItem("margin", "/applicators/margin", "External spacing", true),
        GalleryItem("color", "/applicators/color", "Text color", true),
        GalleryItem("backgroundColor", "/applicators/backgroundColor", "Background color", true),
        GalleryItem("opacity", "/applicators/opacity", "Transparency", true),
        GalleryItem("width", "/applicators/width", "Element width", true),
        GalleryItem("height", "/applicators/height", "Element height", true),
        GalleryItem("size", "/applicators/size", "Width and height", true),
        GalleryItem("fillMaxSize", "/applicators/fillMaxSize", "Fill available space", true),
        GalleryItem("border", "/applicators/border", "Border styling", true),
        GalleryItem("borderRadius", "/applicators/borderRadius", "Rounded corners", true),
        GalleryItem("cornerRadius", "/applicators/cornerRadius", "Rounded corners (alias)", true),
        GalleryItem("fontSize", "/applicators/fontSize", "Text size", true),
        GalleryItem("fontWeight", "/applicators/fontWeight", "Text weight", true),
        GalleryItem("fontFamily", "/applicators/fontFamily", "Font family", true),
        GalleryItem("textAlign", "/applicators/textAlign", "Text alignment", true),
        GalleryItem("lineHeight", "/applicators/lineHeight", "Line spacing", true),
        GalleryItem("gap", "/applicators/gap", "Child spacing", true),
        GalleryItem("weight", "/applicators/weight", "Flex grow", true),
        GalleryItem("flex", "/applicators/flex", "Flex shorthand", true),
        GalleryItem("verticalAlignment", "/applicators/justifyContent", "Vertical alignment", true),
        GalleryItem("horizontalAlignment", "/applicators/alignItems", "Horizontal alignment", true),
        GalleryItem("shadow", "/applicators/shadow", "Box shadow", true),
        GalleryItem("elevation", "/applicators/elevation", "Material elevation", true),
        GalleryItem("blur", "/applicators/blur", "Blur filter", true),
        GalleryItem("transform", "/applicators/transform", "CSS transform", true),
        GalleryItem("rotate", "/applicators/rotate", "Rotation", true),
        GalleryItem("scale", "/applicators/scale", "Scaling", true),
        GalleryItem("transition", "/applicators/transition", "CSS transitions", true),
        GalleryItem("overflow", "/applicators/overflow", "Overflow handling", true),
        GalleryItem("zIndex", "/applicators/zIndex", "Stacking order", true),
        GalleryItem("gridColumns", "/applicators/gridColumns", "Grid columns", true),
        GalleryItem("linearGradient", "/applicators/linearGradient", "Gradient backgrounds", true),
        GalleryItem("maxLines", "/applicators/maxLines", "Text line limit", true),
    )

    val all = components + applicators

    /** Resolve either the user-facing item name or its canonical deeplink segment. */
    fun find(nameOrPathSegment: String): GalleryItem? {
        val query = nameOrPathSegment.trim()
        return all.find { item ->
            item.name.equals(query, ignoreCase = true) ||
                item.path.substringAfterLast('/').equals(query, ignoreCase = true)
        }
    }
}

class ComponentListActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Extract component name from deep link if present
        val initialComponentName = extractComponentNameFromIntent(intent)

        setContent {
            HypenGalleryTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    ComponentGalleryScreen(
                        initialComponentName = initialComponentName,
                        onClose = { finish() }
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Recreate to handle new deep link
        recreate()
    }

    /**
     * Extracts the component name from a deep link intent.
     * Supports: hypengallery://components?name=ComponentName
     */
    private fun extractComponentNameFromIntent(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_VIEW) return null

        val uri = intent.data ?: return null
        if (uri.scheme != "hypengallery" || uri.host != "components") return null

        // Get the name parameter, removing any surrounding quotes
        val name = uri.getQueryParameter("name")?.trim()?.removeSurrounding("\"")

        // Accept both the user-facing name and the canonical deeplink segment.
        // Some applicators intentionally use different labels, such as
        // verticalAlignment -> /applicators/justifyContent.
        return name?.let(GalleryItems::find)?.name
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComponentGalleryScreen(
    onClose: () -> Unit,
    initialComponentName: String? = null,
) {
    var selectedItem by rememberSaveable { mutableStateOf(initialComponentName) }
    val listState = rememberLazyListState()

    // Track if we came from a deep link (to close activity on back from preview)
    val cameFromDeepLink = remember { initialComponentName != null }

    // Find the selected item
    val currentItem = selectedItem?.let { name ->
        GalleryItems.all.find { it.name == name }
    }

    // Handle back press
    BackHandler(enabled = selectedItem != null) {
        if (cameFromDeepLink && selectedItem == initialComponentName) {
            // If opened via deep link and still on initial component, close activity
            onClose()
        } else {
            selectedItem = null
        }
    }

    if (currentItem != null) {
        // Preview screen
        ComponentPreviewScreen(
            item = currentItem,
            onClose = {
                if (cameFromDeepLink && selectedItem == initialComponentName) {
                    // If opened via deep link, close activity
                    onClose()
                } else {
                    selectedItem = null
                }
            }
        )
    } else {
        // List screen
        ComponentListScreen(
            listState = listState,
            onItemClick = { item -> selectedItem = item.name },
            onClose = onClose
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComponentListScreen(
    listState: LazyListState,
    onItemClick: (GalleryItem) -> Unit,
    onClose: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Component Gallery") },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(
                            imageVector = Icons.Default.ArrowBack,
                            contentDescription = "Back"
                        )
                    }
                },
                modifier = Modifier.statusBarsPadding()
            )
        }
    ) { paddingValues ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Components section
            item {
                Text(
                    text = "Components (${GalleryItems.components.size})",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(vertical = 8.dp)
                )
            }

            items(GalleryItems.components, key = { "component-${it.name}" }) { item ->
                GalleryItemCard(
                    item = item,
                    onClick = { onItemClick(item) }
                )
            }

            // Spacer between sections
            item {
                Spacer(modifier = Modifier.height(16.dp))
            }

            // Applicators section
            item {
                Text(
                    text = "Applicators (${GalleryItems.applicators.size})",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(vertical = 8.dp)
                )
            }

            items(GalleryItems.applicators, key = { "applicator-${it.name}" }) { item ->
                GalleryItemCard(
                    item = item,
                    onClick = { onItemClick(item) }
                )
            }

            // Bottom spacer for navigation bar
            item {
                Spacer(modifier = Modifier.navigationBarsPadding())
            }
        }
    }
}

@Composable
fun GalleryItemCard(
    item: GalleryItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = item.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Surface(
                shape = MaterialTheme.shapes.small,
                color = if (item.isApplicator) {
                    MaterialTheme.colorScheme.secondaryContainer
                } else {
                    MaterialTheme.colorScheme.primaryContainer
                },
            ) {
                Text(
                    text = item.path,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (item.isApplicator) {
                        MaterialTheme.colorScheme.onSecondaryContainer
                    } else {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    },
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComponentPreviewScreen(
    item: GalleryItem,
    onClose: () -> Unit,
) {
    val url = "ws://10.0.2.2:${GalleryItems.SERVER_PORT}${item.path}?platform=android"

    Scaffold(
        // The preview surface has to reach the bottom window edge, or `SafeArea` inside the
        // previewed component has no unconsumed navigation-bar inset left to pad by. The
        // Scaffold's default content insets would eat exactly that, so they are dropped here;
        // the top bar still applies its own `statusBarsPadding()` and the content padding
        // below still clears the bar itself.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "${item.name} preview",
                        modifier = Modifier.fillMaxWidth(),
                    )
                },
                actions = {
                    IconButton(onClick = onClose) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Close"
                        )
                    }
                },
                modifier = Modifier.statusBarsPadding()
            )
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            HypenApp(
                url = url,
                modifier = Modifier.fillMaxSize(),
                config = RemoteEngineConfig.DEBUG,
                // The top app bar (status-bar padded) stacks above this surface, so the
                // preview's top edge is already clear — but the unconsumed top inset would
                // still show up in `WindowInsets.safeDrawing`, double-padding every SafeArea.
                // Zero just that edge; bottom/left/right stay on the real safeDrawing insets.
                safeAreaInsets = remember { HypenSafeAreaInsets(top = 0.dp) },
                loadingContent = {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            CircularProgressIndicator()
                            Spacer(modifier = Modifier.height(16.dp))
                            Text("Connecting to $url...")
                        }
                    }
                },
                errorContent = { message ->
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.padding(24.dp),
                        ) {
                            Text(
                                text = "Connection Error",
                                style = MaterialTheme.typography.headlineSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = message,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Spacer(modifier = Modifier.height(16.dp))
                            Text(
                                text = "Make sure the component-gallery-server is running:\ncd component-gallery-server && bun run server.ts",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
            )
        }
    }
}
