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
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenApp
import space.hypen.renderer.components.HypenSafeAreaInsets
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
    // Browser chrome collapses to a floating URL pill once a hosted app has
    // loaded (like the desktop shell's island). Only meaningful on the App
    // screen; Home/QR always show the full toolbar.
    var isChromeCollapsed by remember { mutableStateOf(false) }
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
        isChromeCollapsed = false
        // Reconnecting to the URL that is already open (deep link, home tap)
        // must still tear the content down: HypenAppContent is keyed on
        // url+refreshKey, and without a new key its connection callbacks —
        // and the chrome auto-collapse — never fire again.
        val current = currentScreen
        if (current is BrowserScreen.App && current.url == normalizedUrl) {
            isConnected = false
            refreshKey++
        }
        navigateTo(BrowserScreen.App(normalizedUrl))
    }

    // Auto-collapse the chrome once the app is up; expanding again is a tap
    // on the pill. Re-arms on every (re)connect so a refresh collapses too.
    LaunchedEffect(isConnected, currentScreen) {
        if (isConnected && currentScreen is BrowserScreen.App) {
            isChromeCollapsed = true
        }
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

    val isAppScreen = currentScreen is BrowserScreen.App

    @Composable
    fun toolbar(modifier: Modifier) {
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
            modifier = modifier,
        )
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Gallery screens (Home / QR) keep the classic docked toolbar. On the
            // App screen the chrome floats over the content instead (see the
            // overlay below), so nothing is docked here.
            AnimatedVisibility(
                visible = !isFullscreen && !isAppScreen,
                enter = slideInVertically { -it },
                exit = slideOutVertically { -it },
            ) {
                toolbar(Modifier.statusBarsPadding())
            }

            // Bottom system-bar padding for the gallery's *own* screens. It used to sit
            // on the content Box below, which meant it applied to hosted Hypen apps too —
            // and `Modifier.navigationBarsPadding()` consumes the inset it applies, so a
            // `SafeArea` inside the hosted app found nothing left to pad by. The gallery
            // chrome keeps the padding; the hosted surface goes edge-to-edge.
            val galleryChromeInsets = if (!isFullscreen) Modifier.navigationBarsPadding() else Modifier

            // Main content
            Box(modifier = Modifier.fillMaxSize()) {
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
                            modifier = Modifier
                                .fillMaxSize()
                                .then(galleryChromeInsets)
                        )
                    }

                    is BrowserScreen.QRScanner -> {
                        QRScannerScreen(
                            onQRCodeScanned = { scannedUrl ->
                                connectToUrl(scannedUrl)
                            },
                            onBack = { goBack() },
                            modifier = Modifier
                                .fillMaxSize()
                                .then(galleryChromeInsets)
                        )
                    }

                    is BrowserScreen.App -> {
                        // The hosted app always runs edge-to-edge under the floating
                        // chrome, so `SafeArea` inside it resolves every edge from the
                        // real `safeDrawing` insets (null = no override).
                        // key() forces a fresh HypenAppContent instance on refresh, which
                        // tears down the existing WebSocket and reconnects cleanly.
                        key(screen.url, refreshKey) {
                            HypenAppContent(
                                url = screen.url,
                                safeAreaInsets = null,
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

        // Floating chrome over a hosted app: a Dynamic-Island-sized URL pill once
        // the app has loaded, or the full toolbar while expanded. Tapping the
        // content outside an expanded toolbar collapses it again.
        if (isAppScreen && !isFullscreen) {
            if (!isChromeCollapsed) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { isChromeCollapsed = true }
                )
            }
            AnimatedVisibility(
                visible = isChromeCollapsed,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 6.dp),
            ) {
                CollapsedUrlPill(
                    currentUrl = currentUrl,
                    isConnected = isConnected,
                    isLoading = isLoading,
                    onClick = { isChromeCollapsed = false },
                )
            }
            AnimatedVisibility(
                visible = !isChromeCollapsed,
                enter = slideInVertically { -it } + fadeIn(),
                exit = slideOutVertically { -it } + fadeOut(),
                modifier = Modifier.align(Alignment.TopCenter),
            ) {
                toolbar(Modifier.statusBarsPadding())
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
    safeAreaInsets: HypenSafeAreaInsets? = null,
) {
    // Track if we've notified the parent about connection
    var hasNotifiedConnected by remember { mutableStateOf(false) }

    val activity = LocalContext.current as ComponentActivity
    val deviceHost = remember(url, activity) {
        if (url.contains("device-lab")) space.hypen.renderer.device.android.AndroidDeviceHost.create(activity, url) else null
    }

    HypenApp(
        url = url,
        modifier = modifier,
        config = RemoteEngineConfig.DEBUG,
        deviceHost = deviceHost,
        disposeDeviceHost = true,
        safeAreaInsets = safeAreaInsets,
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
