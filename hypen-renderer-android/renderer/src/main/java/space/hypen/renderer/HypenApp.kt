package space.hypen.renderer

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.Measured
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.layout.VerticalAlignmentLine
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import kotlin.math.roundToInt
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.DpSize
import space.hypen.renderer.anim.ClearFocusOnExit
import space.hypen.renderer.anim.rememberHypenAnimation
import space.hypen.renderer.components.HypenSafeAreaInsets
import space.hypen.renderer.components.LocalColumnScope
import space.hypen.renderer.components.LocalHypenSafeAreaInsets
import space.hypen.renderer.components.LocalParentAllowsHorizontalExpansion
import space.hypen.renderer.components.LocalRowScope
import space.hypen.renderer.components.LocalManagedRowId
import space.hypen.renderer.components.LocalStretchCrossAxis
import space.hypen.renderer.components.isManagedRowChild
import space.hypen.renderer.components.permittedFillMaxWidthFraction
import space.hypen.renderer.components.videoIntentClickable
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.normalizeOrigin
import space.hypen.renderer.device.android.ComposeDeviceActivityIndicator
import space.hypen.renderer.device.android.DeviceActivityOverlay
import space.hypen.renderer.dnd.rememberHypenDnd
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.navigation.BackNavigationDispatcher
import space.hypen.renderer.navigation.NavigationOptions
import space.hypen.renderer.remote.ConnectionState
import space.hypen.renderer.remote.RemoteEngineConfig
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.render.applyHypenSemantics
import space.hypen.renderer.render.LocalComposeRenderer
import space.hypen.renderer.components.WindowedLazyList
import space.hypen.renderer.components.renderableChildren
import space.hypen.renderer.virt.WindowedShape
import space.hypen.renderer.virt.LocalVirtItemPositions
import space.hypen.renderer.virt.ProvideVirtItemPositions
import space.hypen.renderer.virt.virtItemInfo
import space.hypen.renderer.virt.virtPadded
import space.hypen.renderer.virt.virtWindow
import kotlinx.coroutines.flow.collectLatest

/**
 * Size of the area the Hypen root was given, for resolving `vw`/`vh`.
 *
 * `DpSize.Unspecified` until the root measures itself; the size appliers fall
 * back to the physical display until then. Mirrors the Swift renderer's
 * `viewportHeight` environment value — `100vh` must mean the viewport hosting
 * the app, not the display, or a host that insets us (the Gallery's URL
 * chrome) pushes bottom-anchored content off screen.
 */
val LocalHypenViewport = compositionLocalOf { DpSize.Unspecified }

/**
 * Main entry point for rendering a Hypen app.
 *
 * @param url The WebSocket URL to connect to
 * @param config Configuration for the remote engine
 * @param modifier Modifier for the root container
 * @param navigation Back-button navigation options. Pass [NavigationOptions.DEFAULT] to enable
 *   with default settings, a custom [NavigationOptions] to configure the action name,
 *   or null (default) to disable back-button handling.
 * @param safeAreaInsets Overrides the insets `SafeArea` elements pad by. Per-edge optional and
 *   merged over the platform default, so `HypenSafeAreaInsets(bottom = 0.dp)` keeps the real
 *   top inset and zeroes only the bottom. Null (default) means every edge uses
 *   `WindowInsets.safeDrawing`.
 * @param deviceHost Optional Device Capability Protocol host (RFC 001), e.g.
 *   `AndroidDeviceHost.create(activity, url)`. Application-scoped and owned by the caller.
 *   HypenApp draws its host-owned overlay above the app (outside the patch tree): the
 *   `bluetooth.scan` and `mic.record` (recording) indicators with their Stop control, and
 *   a development-mode notice for `ws://` origins (RFC 001 §5). Prompts, grants and cooldowns use the origin of [url].
 * @param disposeDeviceHost Bind [deviceHost] to this HypenApp: dispose it when the
 *   connection is finally torn down (HypenApp leaves for good, or is given a different
 *   host). Leave false (default) for an Application-scoped host shared across screens.
 *
 * The connection (socket, session and rendered tree) survives Activity recreation: when
 * the hosting Activity is recreated (a configuration change, or the system destroying it
 * behind a system picker) the replacement Activity's HypenApp re-attaches to the same
 * connection, so in-flight device work can still deliver its result. A connection nobody
 * re-attaches to is closed after a short grace (longer while a system picker or
 * permission dialog of a device operation is up). Leaving the screen or finishing the
 * Activity closes it at once.
 * @param loadingContent Content to show while connecting
 * @param errorContent Content to show on error
 */
@Composable
fun HypenApp(
    url: String,
    modifier: Modifier = Modifier,
    config: RemoteEngineConfig = RemoteEngineConfig.DEFAULT,
    navigation: NavigationOptions? = null,
    safeAreaInsets: HypenSafeAreaInsets? = null,
    deviceHost: DeviceHost? = null,
    disposeDeviceHost: Boolean = false,
    loadingContent: @Composable () -> Unit = { DefaultLoadingContent() },
    errorContent: @Composable (String) -> Unit = { DefaultErrorContent(it) },
) {
    // The connection lives in a retained session (see HypenSessions): a new
    // url or host means a new session; Activity recreation re-attaches.
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val session = remember(url, deviceHost) { HypenSessions.acquire(url, config, deviceHost, context) }
    session.disposeDeviceHost = disposeDeviceHost
    DisposableEffect(session) {
        onDispose { HypenSessions.release(session, activity) }
    }
    val renderer = session.renderer
    val remoteEngine = session.engine

    HypenLoggers.app.debug("HypenApp composing: renderer=%s, engine=%s", System.identityHashCode(renderer), System.identityHashCode(remoteEngine))

    // Connection state
    val connectionState by remoteEngine.connectionState.collectAsState()

    // Error state (kept by the session across Activity recreation)
    val lastError = session.lastError

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

    // Connecting, collecting every patch batch in order (collect, never
    // collectLatest) and error handling are owned by the session, so they
    // continue between Activity instances.

    // Render based on connection state, providing action dispatcher and renderer to children
    // Root element has no parent restricting it, so allow expansion
    CompositionLocalProvider(
        LocalActionDispatcher provides actionDispatcher,
        LocalComposeRenderer provides renderer,
        LocalParentAllowsHorizontalExpansion provides true,
        LocalHypenSafeAreaInsets provides safeAreaInsets,
    ) {
        // Wire up back-button handling when navigation is enabled
        BackNavigationDispatcher(
            remoteEngine = remoteEngine,
            navigationOptions = navigation,
            enabled = connectionState == ConnectionState.CONNECTED,
        )

        BoxWithConstraints(modifier = modifier.fillMaxSize()) {
            val viewport = DpSize(maxWidth, maxHeight)
            CompositionLocalProvider(LocalHypenViewport provides viewport) {
            when (connectionState) {
                ConnectionState.CONNECTING,
                ConnectionState.RECONNECTING,
                -> {
                    loadingContent()
                }

                ConnectionState.CONNECTED -> {
                    HypenRoot(renderer, loadingContent)
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

            // Host-owned device UI, drawn above (and independent of) the
            // server's patch tree: stream indicators with Stop, and the
            // ws:// development-mode notice (RFC 001 §5).
            if (deviceHost != null) {
                DeviceActivityOverlay(
                    indicator = deviceHost.activityIndicator as? ComposeDeviceActivityIndicator,
                    // The origin this connection talks to (not the host's default).
                    origin = remember(url) { normalizeOrigin(url) },
                    modifier = Modifier.align(Alignment.TopCenter),
                )
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

    // `vw`/`vh` resolve against the area the Hypen root was given, so the
    // measured viewport is part of what the modifier depends on — and part of
    // the `remember` key below, or a rotation would keep the old sizes.
    val viewport = LocalHypenViewport.current

    // Build modifier from applicators with variant support, recomputed only
    // when this element's props change (propsRevision is bumped per touched
    // element by SET_PROP/REMOVE_PROP) or the viewport changes.
    val modifier = if (applicatorRegistry is space.hypen.renderer.applicators.DefaultApplicatorRegistry) {
        val result = remember(element, element.propsRevision, viewport) {
            applicatorRegistry.applyAllWithVariants(Modifier, element, renderer.createApplicatorContext(element, viewport))
        }

        if (result.hasVariants) {
            // Use responsive modifier based on screen width
            space.hypen.renderer.applicators.rememberVariantModifier(result)
        } else {
            result.baseModifier
        }
    } else {
        remember(element, element.propsRevision, viewport) {
            applicatorRegistry.applyAll(Modifier, element, renderer.createApplicatorContext(element, viewport))
        }
    }

    // Apply weight modifier if in Row/Column scope
    // Check both direct props and applicator style (.weight(1))
    val explicitWeight =
        element.getFloatProp("weight.0")
            ?: element.getFloatProp("weight")
            ?: element.getFloatProp("flex.0")
            ?: element.getFloatProp("flex")
            ?: element.getFloatProp("flexGrow.0")
            ?: element.getFloatProp("flexgrow.0")
            ?: element.getFloatProp("flexGrow")

    var finalModifier = modifier

    val rowScope = LocalRowScope.current
    val managedRowId = LocalManagedRowId.current
    val isManagedRowChild = isManagedRowChild(element, managedRowId, renderer)
    val columnScope = LocalColumnScope.current
    val shouldStretch = LocalStretchCrossAxis.current
    val parentAllowsHorizontalExpansion = LocalParentAllowsHorizontalExpansion.current

    // Apply stretch (fillMaxHeight for Row children, fillMaxWidth for Column children)
    if (shouldStretch) {
        finalModifier = when {
            rowScope != null || isManagedRowChild -> finalModifier.fillMaxHeight()
            columnScope != null -> finalModifier.fillMaxWidth()
            else -> finalModifier
        }
    }

    // Apply fillMaxWidth only if the parent Column establishes a usable width.
    // Compose itself resolves the request against the finite incoming constraint.
    val fillMaxWidthFraction = permittedFillMaxWidthFraction(element, parentAllowsHorizontalExpansion)
    if (fillMaxWidthFraction != null) {
        finalModifier = finalModifier.fillMaxWidth(fillMaxWidthFraction)
    }

    // Apply weight only if explicitly specified via .weight() or .flex() applicators
    // Note: We don't auto-apply weight to Row children (unlike Web's flex:1) because
    // it can cause unexpected layout behavior with nested layouts. Users should
    // explicitly use .weight(1) or .flex(1) if they want children to stretch.
    if (!isManagedRowChild && explicitWeight != null && explicitWeight > 0) {
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
    // A row of a padded windowed list: its whole-list position (§2), as the
    // lazy path's VirtItem gives it.
    LocalVirtItemPositions.current?.get(element.id)?.let { finalModifier = finalModifier.virtItemInfo(it) }

    // Animation channels (`__anim.*`). The playback layer sits OUTSIDE the
    // base chain so a graphicsLayer pose transforms the whole element — and
    // with it the hit target, the focus target and the accessibility node
    // (protocol invariant 5). An exiting subtree's exclusion modifiers land
    // here too, outermost, so nothing beneath them can be reached.
    val animation = rememberHypenAnimation(element, renderer.getAnimationCoordinator())
    ClearFocusOnExit(animation.exiting)
    finalModifier = animation.modifier.then(finalModifier)

    // Drag-and-drop (`__dnd.*`), in two halves around the chain built so far.
    // OUTER (outermost of all): the ghost translation and the sibling
    // gap-opening shift move the whole element — playback pose, hit target,
    // focus and accessibility node included — and the layout-rect report.
    // INNER (innermost, below the applicators and so below the element's own
    // engine `translateX`/`translateY` layers): the lift surface and the
    // pointer-mapping coordinates, so a pinned note is lifted where it is
    // drawn and its reported rect is its rendered rect (plan §6.11). The
    // gesture still sits above every child, so a drag starts from anywhere
    // on the lift surface; a tap below the activation threshold consumes
    // nothing. Both halves are `Modifier` (no-op) for every element the
    // runtime has no role for.
    val dnd = rememberHypenDnd(element, renderer.getDndCoordinator())
    finalModifier = dnd.outer.then(finalModifier).then(dnd.inner)

    // Renderer-local video intents (`.videoIntent("fullscreen")`): handled
    // here rather than by an applicator, because the intent needs the
    // enclosing Video's controller off the composition (applicators run
    // outside composition). Innermost in the chain, so the intent takes the
    // tap; a no-op for every node that does not carry the prop or does not
    // sit inside a Video subtree. See components/VideoFullscreen.kt.
    // Component-level events (Button's positional action, input/bind
    // writes, chart/video/scrubber callbacks, the video-intent companion)
    // read LocalActionDispatcher. Re-provide it node-addressed and
    // exit-gated for this element — the same wrapper applicators get — so
    // the engine resolves the owning module from the node instead of a bare
    // (multi-module-ambiguous) action name. Children re-wrap with their own
    // id; envelopes pass through, so the innermost node wins.
    val baseDispatcher = LocalActionDispatcher.current
    val nodeDispatcher = remember(renderer, element.id, baseDispatcher) {
        baseDispatcher?.let { renderer.nodeActionDispatcher(element.id, it) }
    }
    CompositionLocalProvider(LocalActionDispatcher provides nodeDispatcher) {
        val renderModifier = finalModifier.videoIntentClickable(element)

        // A windowed container other than List/Grid (the sole child is a lazy
        // ForEach): a self-scrolling one renders through the lazy slot path,
        // any other keeps its handler and pads for the missing items.
        // List/Grid handle `__virt.window` themselves.
        val virtWindow = element.virtWindow()
        if (virtWindow != null && handler.typeName != "list" && handler.typeName != "grid") {
            val shape = WindowedShape.of(element.elementType, element.props["scrollable.0"] ?: element.props["scrollable"])
            if (shape.lazy) {
                WindowedLazyList(
                    element = element,
                    window = virtWindow,
                    modifier = renderModifier,
                    children = renderableChildren(element, renderer),
                    renderer = renderer,
                    horizontal = shape.horizontal,
                    fillsWidth = false,
                )
            } else {
                handler.Render(
                    element = element,
                    modifier = renderModifier.virtPadded(element, virtWindow, renderer, horizontal = shape.horizontal),
                    renderChildren = {
                        ProvideVirtItemPositions(virtWindow, renderableChildren(element, renderer), shape.horizontal) {
                            RenderChildren(element, renderer)
                        }
                    },
                )
            }
        } else {
            // Render the component
            handler.Render(
                element = element,
                modifier = renderModifier,
                renderChildren = {
                    RenderChildren(element, renderer)
                },
            )
        }
    }
}

/**
 * The connected app: [renderer]'s root children, or [loadingContent] until
 * the first root lands. Expects [LocalComposeRenderer] (and the other
 * [HypenApp] locals) to be provided by the caller.
 *
 * The root children are snapshot-backed, so this recomposes when a root
 * node arrives, moves or leaves. Per-element updates invalidate only the
 * composables that read the touched element's snapshot state.
 */
@Composable
internal fun HypenRoot(
    renderer: ComposeRenderer,
    loadingContent: @Composable () -> Unit,
) {
    val rootElements = renderer.getRootChildIds().mapNotNull { renderer.getElement(it) }
    if (renderer.hasRendered()) {
        // An empty root after the first render (a root `If` turned off)
        // renders nothing, like the DOM container.
        HypenRootChildren(rootElements, renderer)
    } else {
        // Tree not yet loaded, show loading
        loadingContent()
    }
}

/**
 * Renders the ordered children of the "root" mount container.
 *
 * Always one stable structure — a single [Layout] with each root under
 * `key(id)` — so a root keeps its composition identity (remember, scroll,
 * focus) as siblings come and go, including across one <-> several roots.
 * See [rootChildrenMeasurePolicy] for how each case lays out.
 *
 * With several roots, [RootColumnScope] replaces [LocalColumnScope] so a
 * `.weight` root (a `flex-1` page above a bottom bar) works, and cross-axis
 * stretch is off (Column default). With one root both locals pass through
 * unchanged from the host, so the root builds the same modifiers as before.
 */
@Composable
private fun HypenRootChildren(
    roots: List<HypenElement>,
    renderer: ComposeRenderer,
) {
    val stacked = roots.size > 1
    val inheritedColumnScope = LocalColumnScope.current
    val inheritedStretch = LocalStretchCrossAxis.current
    Layout(
        content = {
            CompositionLocalProvider(
                LocalColumnScope provides if (stacked) RootColumnScope else inheritedColumnScope,
                LocalStretchCrossAxis provides if (stacked) false else inheritedStretch,
            ) {
                for (root in roots) {
                    key(root.id) {
                        HypenElement(element = root, renderer = renderer)
                    }
                }
            }
        },
        modifier = Modifier.fillMaxSize(),
        measurePolicy = remember(stacked) { rootChildrenMeasurePolicy(stacked) },
    )
}

/**
 * Root container layout.
 *
 * Not [stacked] (one root): exactly the host `Box`'s policy that used to
 * hold the root directly — every child measured with the incoming
 * constraints with minimums dropped (`propagateMinConstraints = false`) and
 * placed at the top-start corner (`placeRelative`, so RTL mirrors as Box's
 * `TopStart` did); parent data (weights) is ignored, as Box ignored it. This
 * Layout is `fillMaxSize`, the same size as that host box, so the root sees
 * identical constraints and lands at the identical offset.
 *
 * [stacked] (several roots): a vertical column filling the host, like the
 * DOM container's block flow and the desktop renderer's viewport-sized flex
 * column. Unweighted children are measured top-down with the height left;
 * children carrying [RootWeight] (from [RootColumnScope]) share what remains
 * by weight, `fill` making the share exact, as Compose's Column does.
 */
private fun rootChildrenMeasurePolicy(stacked: Boolean) = MeasurePolicy { measurables, constraints ->
    val loose = constraints.copy(minWidth = 0, minHeight = 0)
    if (!stacked) {
        val placeables = measurables.map { it.measure(loose) }
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth
            else (placeables.maxOfOrNull { it.width } ?: 0).coerceAtLeast(constraints.minWidth)
        val height = if (constraints.hasBoundedHeight) constraints.maxHeight
            else (placeables.maxOfOrNull { it.height } ?: 0).coerceAtLeast(constraints.minHeight)
        return@MeasurePolicy layout(width, height) {
            placeables.forEach { it.placeRelative(0, 0) }
        }
    }

    val weights = measurables.map { it.parentData as? RootWeight }
    val placeables = arrayOfNulls<Placeable>(measurables.size)
    var used = 0
    measurables.forEachIndexed { i, m ->
        if (weights[i] != null) return@forEachIndexed
        val maxH = if (constraints.hasBoundedHeight) (constraints.maxHeight - used).coerceAtLeast(0)
            else Constraints.Infinity
        val p = m.measure(loose.copy(maxHeight = maxH))
        placeables[i] = p
        used += p.height
    }
    val totalWeight = weights.sumOf { (it?.weight ?: 0f).toDouble() }.toFloat()
    if (totalWeight > 0f) {
        val remaining = if (constraints.hasBoundedHeight) (constraints.maxHeight - used).coerceAtLeast(0) else 0
        var left = remaining
        var weightLeft = totalWeight
        measurables.forEachIndexed { i, m ->
            val w = weights[i] ?: return@forEachIndexed
            val share = if (weightLeft > 0f) (left * (w.weight / weightLeft)).roundToInt().coerceIn(0, left) else 0
            left -= share
            weightLeft -= w.weight
            val p = m.measure(loose.copy(minHeight = if (w.fill) share else 0, maxHeight = share))
            placeables[i] = p
            used += p.height
        }
    }
    val width = if (constraints.hasBoundedWidth) constraints.maxWidth
        else (placeables.maxOfOrNull { it?.width ?: 0 } ?: 0).coerceAtLeast(constraints.minWidth)
    val height = if (constraints.hasBoundedHeight) constraints.maxHeight
        else used.coerceAtLeast(constraints.minHeight)
    layout(width, height) {
        var y = 0
        for (p in placeables) {
            if (p == null) continue
            p.placeRelative(0, y)
            y += p.height
        }
    }
}

/** A root child's weight inside the stacked root container. */
private data class RootWeight(val weight: Float, val fill: Boolean) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?): Any = this@RootWeight
}

/**
 * The [ColumnScope] the stacked root container hands its roots through
 * [LocalColumnScope]: `weight` tags the child for [rootChildrenMeasurePolicy];
 * horizontal alignment is start (the column default), so `align` / `alignBy`
 * are no-ops.
 */
private object RootColumnScope : ColumnScope {
    override fun Modifier.weight(weight: Float, fill: Boolean): Modifier {
        require(weight > 0f) { "invalid weight $weight; must be greater than zero" }
        return this.then(RootWeight(weight, fill))
    }

    override fun Modifier.align(alignment: Alignment.Horizontal): Modifier = this

    override fun Modifier.alignBy(alignmentLine: VerticalAlignmentLine): Modifier = this

    override fun Modifier.alignBy(alignmentLineBlock: (Measured) -> Int): Modifier = this
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
