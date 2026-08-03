package space.hypen.renderer

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.anim.ClearFocusOnExit
import space.hypen.renderer.anim.SettingsMotionPreference
import space.hypen.renderer.anim.rememberHypenAnimation
import space.hypen.renderer.components.LocalColumnScope
import space.hypen.renderer.components.LocalParentAllowsHorizontalExpansion
import space.hypen.renderer.components.LocalRowScope
import space.hypen.renderer.components.LocalStretchCrossAxis
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.navigation.BackNavigationDispatcher
import space.hypen.renderer.navigation.NavigationOptions
import space.hypen.renderer.remote.ConnectionState
import space.hypen.renderer.remote.RemoteEngine
import space.hypen.renderer.remote.RemoteEngineConfig
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.render.applyHypenSemantics
import space.hypen.renderer.render.LocalComposeRenderer
import kotlinx.coroutines.flow.collectLatest

/**
 * Main entry point for rendering a Hypen app.
 *
 * @param url The WebSocket URL to connect to
 * @param config Configuration for the remote engine
 * @param modifier Modifier for the root container
 * @param navigation Back-button navigation options. Pass [NavigationOptions.DEFAULT] to enable
 *   with default settings, a custom [NavigationOptions] to configure the action name,
 *   or null (default) to disable back-button handling.
 * @param loadingContent Content to show while connecting
 * @param errorContent Content to show on error
 */
@Composable
fun HypenApp(
    url: String,
    modifier: Modifier = Modifier,
    config: RemoteEngineConfig = RemoteEngineConfig.DEFAULT,
    navigation: NavigationOptions? = null,
    loadingContent: @Composable () -> Unit = { DefaultLoadingContent() },
    errorContent: @Composable (String) -> Unit = { DefaultErrorContent(it) },
) {
    // Live reduced-motion preference: Android's "Remove animations" switch
    // (ANIMATOR_DURATION_SCALE == 0), observed so a mid-session toggle takes
    // effect without a reconnect.
    val context = LocalContext.current
    val motion = remember(context) { SettingsMotionPreference(context) }
    DisposableEffect(motion) {
        onDispose { motion.dispose() }
    }

    // Use url as key to recreate engine when URL changes
    val renderer = remember(url, motion) { ComposeRenderer(animation = AnimationCoordinator(motion)) }
    val remoteEngine = remember(url) { RemoteEngine(url, config) }

    HypenLoggers.app.debug("HypenApp composing: renderer=%s, engine=%s", System.identityHashCode(renderer), System.identityHashCode(remoteEngine))

    // Connection state
    val connectionState by remoteEngine.connectionState.collectAsState()

    // Error state
    var lastError by remember { mutableStateOf<Throwable?>(null) }

    // Create action dispatcher - memoized to avoid recreating on recomposition
    val actionDispatcher = remember(remoteEngine) {
        ActionDispatcher { action, payload ->
            remoteEngine.dispatchAction(action, payload)
        }
    }

    // Set up action dispatcher on renderer
    DisposableEffect(remoteEngine, actionDispatcher) {
        renderer.setActionDispatcher(actionDispatcher)
        onDispose { }
    }

    // Connect and handle patches
    LaunchedEffect(remoteEngine) {
        // Connect
        try {
            remoteEngine.connect()
        } catch (e: Exception) {
            HypenLoggers.app.error("Connection failed", e)
            lastError = e
        }

        // Collect patches — MUST use collect (not collectLatest) to ensure
        // every patch batch is processed. collectLatest skips intermediate values
        // which causes missing elements when the server sends multiple batches rapidly.
        remoteEngine.patches.collect { patches ->
            HypenLoggers.app.debug { "Received ${patches.size} patches" }
            renderer.applyPatches(patches)
        }
    }

    // Handle errors
    LaunchedEffect(Unit) {
        remoteEngine.errors.collect { error ->
            HypenLoggers.app.error("Remote engine error", error)
            lastError = error
        }
    }

    // Cleanup — keyed on remoteEngine so old engine is destroyed when URL changes
    DisposableEffect(remoteEngine) {
        onDispose {
            remoteEngine.destroy()
        }
    }

    // Render based on connection state, providing action dispatcher and renderer to children
    // Root element has no parent restricting it, so allow expansion
    CompositionLocalProvider(
        LocalActionDispatcher provides actionDispatcher,
        LocalComposeRenderer provides renderer,
        LocalParentAllowsHorizontalExpansion provides true,
    ) {
        // Wire up back-button handling when navigation is enabled
        BackNavigationDispatcher(
            remoteEngine = remoteEngine,
            navigationOptions = navigation,
            enabled = connectionState == ConnectionState.CONNECTED,
        )

        Box(modifier = modifier.fillMaxSize()) {
            when (connectionState) {
                ConnectionState.CONNECTING,
                ConnectionState.RECONNECTING,
                -> {
                    loadingContent()
                }

                ConnectionState.CONNECTED -> {
                    // The root id is snapshot-backed, so this block recomposes
                    // when the root element arrives or is replaced. Per-element
                    // updates invalidate only the composables that read the
                    // touched element's snapshot state.
                    val rootId = renderer.getRootId()
                    val rootElement = if (rootId != null) renderer.getElement(rootId) else null

                    if (rootElement != null) {
                        HypenElement(
                            element = rootElement,
                            renderer = renderer,
                        )
                    } else {
                        // Tree not yet loaded, show loading
                        loadingContent()
                    }
                }

                ConnectionState.ERROR -> {
                    errorContent(lastError?.message ?: "Unknown error")
                }

                ConnectionState.DISCONNECTED -> {
                    if (lastError != null) {
                        errorContent(lastError?.message ?: "Disconnected")
                    } else {
                        loadingContent()
                    }
                }
            }
        }
    }
}

/**
 * Renders a single Hypen element and its children.
 *
 * Internal so component handlers that render host-app subtrees themselves
 * (e.g. HypenAppComponent's loading/error slots) can reuse the full
 * rendering pipeline (variants, weights, semantics).
 */
@Composable
internal fun HypenElement(
    element: HypenElement,
    renderer: ComposeRenderer,
) {
    // Check visibility prop first
    // Note: Applicators like .visible(true) become "visible.0" in the props
    val visible =
        element.getBoolProp("visible.0")
            ?: element.getBoolProp("visible")
            ?: true
    if (!visible) {
        // Don't render invisible elements
        return
    }

    val componentRegistry = renderer.getComponentRegistry()
    val applicatorRegistry = renderer.getApplicatorRegistry()

    val handler = componentRegistry.getHandler(element.elementType)
    if (handler == null) {
        if (isControlFlowElement(element.elementType)) {
            RenderChildren(element, renderer)
        } else {
            HypenLoggers.app.warn { "Unknown ${element.elementType}(${element.id})" }
            Box {
                RenderChildren(element, renderer)
            }
        }
        return
    }

    // Build modifier from applicators with variant support, recomputed only
    // when this element's props change (propsRevision is bumped per touched
    // element by SET_PROP/REMOVE_PROP)
    val modifier = if (applicatorRegistry is space.hypen.renderer.applicators.DefaultApplicatorRegistry) {
        val result = remember(element, element.propsRevision) {
            applicatorRegistry.applyAllWithVariants(Modifier, element, renderer.createApplicatorContext(element))
        }

        if (result.hasVariants) {
            // Use responsive modifier based on screen width
            space.hypen.renderer.applicators.rememberVariantModifier(result)
        } else {
            result.baseModifier
        }
    } else {
        remember(element, element.propsRevision) {
            applicatorRegistry.applyAll(Modifier, element, renderer.createApplicatorContext(element))
        }
    }

    // Apply weight modifier if in Row/Column scope
    // Check both direct props and applicator style (.weight(1))
    val explicitWeight =
        element.getFloatProp("weight.0")
            ?: element.getFloatProp("weight")
            ?: element.getFloatProp("flex.0")
            ?: element.getFloatProp("flex")

    var finalModifier = modifier

    val rowScope = LocalRowScope.current
    val columnScope = LocalColumnScope.current
    val shouldStretch = LocalStretchCrossAxis.current
    val parentAllowsHorizontalExpansion = LocalParentAllowsHorizontalExpansion.current

    // Apply stretch (fillMaxHeight for Row children, fillMaxWidth for Column children)
    if (shouldStretch) {
        finalModifier = when {
            rowScope != null -> finalModifier.fillMaxHeight()
            columnScope != null -> finalModifier.fillMaxWidth()
            else -> finalModifier
        }
    }

    // Apply fillMaxWidth only if parent Column allows expansion
    // This ensures children only expand if parent has explicit width (fillMaxWidth or explicit width)
    val hasFillMaxWidth = element.getBoolProp("fillMaxWidth.0") == true
    if (hasFillMaxWidth && parentAllowsHorizontalExpansion) {
        val fraction = element.getFloatProp("fillMaxWidth.0") ?: 1f
        finalModifier = finalModifier.fillMaxWidth(if (fraction > 0) fraction else 1f)
    }

    // Apply weight only if explicitly specified via .weight() or .flex() applicators
    // Note: We don't auto-apply weight to Row children (unlike Web's flex:1) because
    // it can cause unexpected layout behavior with nested layouts. Users should
    // explicitly use .weight(1) or .flex(1) if they want children to stretch.
    if (explicitWeight != null && explicitWeight > 0) {
        finalModifier =
            when {
                rowScope != null -> with(rowScope) { finalModifier.weight(explicitWeight) }
                columnScope != null -> with(columnScope) { finalModifier.weight(explicitWeight) }
                else -> finalModifier
            }
    }

    // Engine-derived accessibility semantics (label/role/state → TalkBack).
    // Re-applied on every recomposition, so a SET_SEMANTICS reactive
    // re-emit lands here too.
    finalModifier = finalModifier.applyHypenSemantics(element.semantics)

    // Animation channels (`__anim.*`). The playback layer sits OUTSIDE the
    // base chain so a graphicsLayer pose transforms the whole element — and
    // with it the hit target, the focus target and the accessibility node
    // (protocol invariant 5). An exiting subtree's exclusion modifiers land
    // here too, outermost, so nothing beneath them can be reached.
    val animation = rememberHypenAnimation(element, renderer.getAnimationCoordinator())
    ClearFocusOnExit(animation.exiting)
    finalModifier = animation.modifier.then(finalModifier)

    // Render the component
    handler.Render(
        element = element,
        modifier = finalModifier,
        renderChildren = {
            RenderChildren(element, renderer)
        },
    )
}

/**
 * Renders children of an element.
 */
@Composable
private fun RenderChildren(
    element: HypenElement,
    renderer: ComposeRenderer,
) {
    val children = renderer.getChildren(element.id)
    for (child in children) {
        key(child.id) {
            HypenElement(element = child, renderer = renderer)
        }
    }
}

/**
 * Default loading content.
 */
@Composable
internal fun DefaultLoadingContent() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

/**
 * Default error content.
 */
@Composable
internal fun DefaultErrorContent(message: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Error: $message",
            color = MaterialTheme.colorScheme.error,
        )
    }
}

/**
 * Control flow element types that the engine creates as transparent wrappers.
 * These must NOT render a Box container because it would break parent Column/Row
 * scope chains (e.g., .weight() only works on direct children).
 */
private val CONTROL_FLOW_TYPES = setOf(
    "ForEach", "__ForEach",
    "Conditional", "__Conditional",
    "When", "__When",
    "If", "__If",
)

private fun isControlFlowElement(elementType: String): Boolean =
    elementType in CONTROL_FLOW_TYPES
