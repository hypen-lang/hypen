package space.hypen.gallery

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenApp
import space.hypen.renderer.remote.RemoteEngineConfig
import space.hypen.gallery.ui.theme.HypenGalleryTheme

class MainActivity : ComponentActivity() {
    /** Holds a deep-linked preview URL to be consumed by the Compose tree. */
    private val _deepLinkUrl = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Check for deep link on cold launch
        handleDeepLinkIntent(intent)

        setContent {
            val deepLinkUrl by _deepLinkUrl

            HypenGalleryTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    GalleryBrowser(
                        deepLinkUrl = deepLinkUrl,
                        onDeepLinkConsumed = { _deepLinkUrl.value = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLinkIntent(intent)
    }

    private fun handleDeepLinkIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "hypenpreview" && uri.host == "connect") {
            val url = uri.getQueryParameter("url") ?: return
            _deepLinkUrl.value = url
        }
    }
}

sealed class BrowserScreen {
    data object Home : BrowserScreen()
    data object QRScanner : BrowserScreen()
    data class App(val url: String) : BrowserScreen()
}

@Composable
fun GalleryBrowser(
    deepLinkUrl: String? = null,
    onDeepLinkConsumed: () -> Unit = {},
) {
    val context = LocalContext.current
    val activity = context as? Activity

    val appStorage = remember { AppStorage(context) }
    var recentApps by remember { mutableStateOf(appStorage.getRecentApps()) }

    var currentScreen by remember { mutableStateOf<BrowserScreen>(BrowserScreen.Home) }
    var currentUrl by remember { mutableStateOf("") }
    var isFullscreen by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(false) }
    var isConnected by remember { mutableStateOf(false) }
    // Incremented on refresh; used as a `key()` to force HypenAppContent to tear down
    // and re-establish its WebSocket connection.
    var refreshKey by remember { mutableIntStateOf(0) }

    // Navigation history
    val navigationHistory = remember { mutableStateListOf<BrowserScreen>() }
    val canGoBack = navigationHistory.isNotEmpty()

    fun navigateTo(screen: BrowserScreen) {
        if (currentScreen != BrowserScreen.Home) {
            navigationHistory.add(currentScreen)
        }
        currentScreen = screen
        if (screen is BrowserScreen.App) {
            currentUrl = screen.url
        }
    }

    fun goBack() {
        if (navigationHistory.isNotEmpty()) {
            val previous = navigationHistory.removeLast()
            currentScreen = previous
            currentUrl = if (previous is BrowserScreen.App) previous.url else ""
        }
    }

    fun goHome() {
        navigationHistory.clear()
        currentScreen = BrowserScreen.Home
        currentUrl = ""
        isLoading = false
        isConnected = false
    }

    fun connectToUrl(url: String, name: String? = null) {
        val normalizedUrl = normalizeUrl(url)
        val appName = name ?: extractNameFromUrl(normalizedUrl)
        appStorage.addOrUpdateApp(appName, normalizedUrl)
        recentApps = appStorage.getRecentApps()
        isLoading = true
        navigateTo(BrowserScreen.App(normalizedUrl))
    }

    // Handle hypenpreview:// deep link
    LaunchedEffect(deepLinkUrl) {
        if (deepLinkUrl != null) {
            connectToUrl(deepLinkUrl)
            onDeepLinkConsumed()
        }
    }

    // Handle system back
    BackHandler(enabled = canGoBack || currentScreen != BrowserScreen.Home) {
        when {
            canGoBack -> goBack()
            currentScreen != BrowserScreen.Home -> goHome()
        }
    }

    // Fullscreen handling
    LaunchedEffect(isFullscreen) {
        activity?.let { act ->
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                val controller = act.window.insetsController
                if (isFullscreen) {
                    controller?.hide(WindowInsets.Type.systemBars())
                    controller?.systemBarsBehavior =
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    controller?.show(WindowInsets.Type.systemBars())
                }
            } else {
                @Suppress("DEPRECATION")
                if (isFullscreen) {
                    act.window.decorView.systemUiVisibility = (
                            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            )
                } else {
                    act.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
                }
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Browser toolbar (hidden in fullscreen)
            AnimatedVisibility(
                visible = !isFullscreen,
                enter = slideInVertically { -it },
                exit = slideOutVertically { -it },
            ) {
                BrowserToolbar(
                    currentUrl = currentUrl,
                    isConnected = isConnected,
                    isLoading = isLoading,
                    canGoBack = canGoBack,
                    isFullscreen = isFullscreen,
                    onUrlSubmit = { url -> connectToUrl(url) },
                    onBackClick = { goBack() },
                    onHomeClick = { goHome() },
                    onRefreshClick = {
                        if (currentScreen is BrowserScreen.App) {
                            isConnected = false
                            isLoading = true
                            refreshKey++
                        }
                    },
                    onScanQrClick = { navigateTo(BrowserScreen.QRScanner) },
                    onFullscreenToggle = { isFullscreen = !isFullscreen },
                    modifier = Modifier.statusBarsPadding(),
                )
            }

            // Main content
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .then(
                        if (!isFullscreen) {
                            Modifier.navigationBarsPadding()
                        } else {
                            Modifier
                        }
                    )
            ) {
                when (val screen = currentScreen) {
                    is BrowserScreen.Home -> {
                        HomeScreen(
                            recentApps = recentApps,
                            onAppClick = { app ->
                                connectToUrl(app.url, app.name)
                            },
                            onDeleteApp = { app ->
                                appStorage.removeApp(app.id)
                                recentApps = appStorage.getRecentApps()
                            },
                            onScanQrClick = { navigateTo(BrowserScreen.QRScanner) },
                            modifier = Modifier.fillMaxSize()
                        )
                    }

                    is BrowserScreen.QRScanner -> {
                        QRScannerScreen(
                            onQRCodeScanned = { scannedUrl ->
                                connectToUrl(scannedUrl)
                            },
                            onBack = { goBack() },
                            modifier = Modifier.fillMaxSize()
                        )
                    }

                    is BrowserScreen.App -> {
                        // key() forces a fresh HypenAppContent instance on refresh, which
                        // tears down the existing WebSocket and reconnects cleanly.
                        key(screen.url, refreshKey) {
                            HypenAppContent(
                                url = screen.url,
                                onConnected = {
                                    isConnected = true
                                    isLoading = false
                                },
                                onError = {
                                    isConnected = false
                                    isLoading = false
                                },
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    }
                }
            }
        }

        // Exit fullscreen hint (shows briefly when entering fullscreen)
        if (isFullscreen) {
            var showHint by remember { mutableStateOf(true) }
            LaunchedEffect(Unit) {
                kotlinx.coroutines.delay(2000)
                showHint = false
            }

            AnimatedVisibility(
                visible = showHint,
                modifier = Modifier.align(Alignment.TopCenter)
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.inverseSurface,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.padding(top = 48.dp)
                ) {
                    Text(
                        text = "Swipe down from top to exit fullscreen",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun HypenAppContent(
    url: String,
    onConnected: () -> Unit,
    onError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Track if we've notified the parent about connection
    var hasNotifiedConnected by remember { mutableStateOf(false) }

    HypenApp(
        url = url,
        modifier = modifier,
        config = RemoteEngineConfig.DEBUG,
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
            // Notify parent of error
            LaunchedEffect(message) {
                onError()
            }
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
                        text = "Make sure the Hypen server is running",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
    )

    // Since HypenApp doesn't expose connection state callbacks,
    // we use a simple heuristic: if we're in this composable and
    // not showing loading/error, we're connected
    LaunchedEffect(url) {
        // Small delay to let HypenApp establish connection
        kotlinx.coroutines.delay(100)
        if (!hasNotifiedConnected) {
            hasNotifiedConnected = true
            onConnected()
        }
    }
}

private fun normalizeUrl(url: String): String {
    val trimmed = url.trim()
    return when {
        trimmed.startsWith("https://") -> trimmed.replaceFirst("https://", "wss://")
        trimmed.startsWith("http://") -> trimmed.replaceFirst("http://", "ws://")
        !trimmed.startsWith("ws://") && !trimmed.startsWith("wss://") -> "ws://$trimmed"
        else -> trimmed
    }
}

private fun extractNameFromUrl(url: String): String {
    return try {
        val withoutProtocol = url
            .removePrefix("ws://")
            .removePrefix("wss://")
            .removePrefix("http://")
            .removePrefix("https://")

        val hostPart = withoutProtocol.split("/").first()
        val host = hostPart.split(":").first()

        when {
            host == "10.0.2.2" -> "Local (Emulator)"
            host == "localhost" || host == "127.0.0.1" -> "Local"
            else -> host
        }
    } catch (e: Exception) {
        "Hypen App"
    }
}
