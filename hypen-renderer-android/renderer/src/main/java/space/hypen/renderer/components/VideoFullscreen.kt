package space.hypen.renderer.components

import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalActionDispatcher

/**
 * Renderer-local video intents — `.videoIntent("fullscreen")`.
 *
 * Normative source: `hypen-web/docs/components/video.md`
 * §"Fullscreen: `videoIntent("fullscreen")` (renderer-local)". Reference
 * implementation: the DOM renderer's `videoIntent` applicator handler in
 * `hypen-web/packages/web/src/dom/applicators/events.ts`.
 *
 * The contract in three lines:
 *
 * 1. **Renderer-local.** The tap is handled in the gesture handler itself —
 *    no action, no module, no round trip. (On the web that is about not
 *    losing transient activation; on Android it is simply about latency and
 *    about fullscreen being presentation, not state.)
 * 2. **The target is the video CONTAINER**, never the platform video view.
 *    The container hosts the surface *and* the composition slots, so custom
 *    controls stay overlaid in fullscreen. Concretely: this never touches
 *    `PlayerView`'s built-in fullscreen button or any native player chrome.
 * 3. **Inert outside a Video subtree.** The intent is delivered through
 *    [LocalVideoPlaybackController], which is only provided to a Video's
 *    slot subtrees — everywhere else the prop is a no-op, exactly like the
 *    DOM's wrapper walk failing to find a `data-hypen-video-state` ancestor.
 *
 * The pure half of this file (intent parsing + the toggle) is unit-tested in
 * `VideoFullscreenTest`; the Compose half is the presentation shell.
 */

/** The renderer-local intents a node may carry. Currently only fullscreen. */
enum class VideoIntent(val wireName: String) {
    FULLSCREEN("fullscreen"),
}

/**
 * Parses a raw `videoIntent` prop value.
 *
 * Deliberately strict, matching the DOM handler (`typeof value === "string"`
 * then `intent !== "fullscreen"` → bail): a non-string, or any spelling
 * other than the exact wire name, is not an intent. An unknown intent is
 * inert rather than an error — the doc promises the prop can be authored
 * everywhere today and simply does nothing where unimplemented.
 */
fun videoIntentOf(value: Any?): VideoIntent? {
    val name = value as? String ?: return null
    return VideoIntent.entries.firstOrNull { it.wireName == name }
}

/**
 * The raw `videoIntent` prop of an element, in either wire spelling: the
 * applicator lowers `.videoIntent("fullscreen")` to `videoIntent.0`, while a
 * plain prop arrives bare.
 */
fun videoIntentProp(props: Map<String, Any?>): Any? =
    props["videoIntent.0"] ?: props["videoIntent"]

/** [videoIntentOf] applied to an element's props. */
fun elementVideoIntent(element: HypenElement): VideoIntent? =
    videoIntentOf(videoIntentProp(element.props))

/**
 * The fullscreen toggle state machine.
 *
 * `fullscreen` is a pure toggle: the same intent button enters and leaves,
 * so there is always a way back even when the author ships no other chrome.
 * [insideVideo] is the inertness rule — a tap on a node that carries the
 * prop but sits outside a Video subtree changes nothing.
 */
fun applyVideoIntent(
    current: Boolean,
    intent: VideoIntent?,
    insideVideo: Boolean,
): Boolean = when {
    !insideVideo -> current
    intent == VideoIntent.FULLSCREEN -> !current
    else -> current
}

/**
 * Whether this element's `videoIntent` will actually be acted on here: it
 * carries a known intent AND sits inside a Video subtree. Outside a Video
 * the prop is inert, so callers must not change their behaviour for it.
 */
@Composable
internal fun isVideoIntentActive(element: HypenElement): Boolean =
    elementVideoIntent(element) != null && LocalVideoPlaybackController.current != null

/**
 * The action a tagged node also carries, if any — `.onClick(...)` /
 * `.onPress(...)`, or a `Button("@actions.x")` positional action.
 *
 * The contract is explicit that "an `.onClick` wired alongside still
 * dispatches normally", but Compose gives the tap to the INNERMOST
 * `clickable` in a chain and nothing to the ones outside it. Since the
 * intent's own `clickable` has to be innermost to be reachable at all, it
 * takes on dispatching this action too — that is how both effects happen
 * from one tap, exactly once each.
 *
 * Grouping mirrors `DefaultApplicatorRegistry.applyAll` so the object form
 * (`onClick.0` plus extra payload args) parses identically to the way the
 * applicator would have parsed it, payload and all.
 */
fun videoIntentCompanionAction(props: Map<String, Any?>): ActionValue? {
    for (name in listOf("onClick", "onPress", "action")) {
        val action = ActionValue.parse(groupedApplicatorArgs(props, name)) ?: continue
        return action
    }
    return null
}

/** The value `DefaultApplicatorRegistry` would hand an applicator named [name]. */
private fun groupedApplicatorArgs(props: Map<String, Any?>, name: String): Any? {
    val args = mutableMapOf<String, Any?>()
    for ((key, value) in props) {
        when {
            key == name -> args["__value"] = value
            key.startsWith("$name.") -> args[key.substring(name.length + 1)] = value
        }
    }
    return when {
        args.isEmpty() -> null
        args.size == 1 && args.containsKey("__value") -> args["__value"]
        args.size == 1 && args.containsKey("0") -> args["0"]
        else -> args
    }
}

/**
 * Click interception for a node carrying a renderer-local video intent.
 *
 * Applied to every element by the render pipeline (see `HypenApp.kt`), so it
 * covers the controls-slot `Button` of the doc's example, a generic
 * clickable container, or anything else an author tags. It is a plain
 * `clickable`, so the node is interactive on the intent alone (no `.onClick`
 * required), the tap needs a completed press-and-release on the node (a
 * press that drifts off does nothing), and the node keeps a real
 * accessibility click action — which `.label("Toggle fullscreen")` names.
 *
 * It lands innermost in the chain, which makes it the handler that actually
 * receives the tap; any action on the same node is dispatched from here (see
 * [videoIntentCompanionAction]) so `.onClick` alongside the intent still
 * fires, and fires once. [space.hypen.renderer.components.ButtonComponent]
 * stands its own click handler down for the same reason.
 */
@Composable
internal fun Modifier.videoIntentClickable(element: HypenElement): Modifier {
    val intent = elementVideoIntent(element) ?: return this
    val controller = LocalVideoPlaybackController.current ?: return this
    val dispatcher = LocalActionDispatcher.current
    val companion = videoIntentCompanionAction(element.props)
    return this.clickable {
        // Action first: the intent is presentation, and a module handler
        // should see the tap in the same order the DOM's listeners run it.
        if (companion != null && dispatcher != null) {
            dispatcher.dispatch(companion.actionName, companion.payload)
        }
        controller.handleVideoIntent(intent)
    }
}

/**
 * The video container, in-page or filling the window.
 *
 * [content] is the container: the player surface plus every composition
 * slot overlaid on it. Fullscreen presents *that same content* over the
 * whole window — the slots come with it, which is the whole point of
 * targeting the container instead of the video view.
 *
 * The in-page [Box] is always emitted, empty while fullscreen, so the page
 * keeps its layout (no reflow when the player leaves and returns).
 *
 * Playback is unaffected: the `ExoPlayer` and its listeners live in
 * [VideoComponent]'s composition scope, which this never leaves, and the
 * `PlayerView` is a single remembered instance re-parented between the two
 * hosts (see `VideoComponent`) rather than a new view bound to a new
 * player. Nothing here re-prepares, re-seeks or re-creates the player, so
 * entering and leaving fullscreen is presentation-only, as the contract
 * requires.
 */
@Composable
internal fun VideoFullscreenContainer(
    fullscreen: Boolean,
    modifier: Modifier,
    onExitRequest: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    if (!fullscreen) {
        Box(modifier = modifier, content = content)
        return
    }

    // Layout placeholder: keeps the element's box in the page while the
    // player is presented over the window.
    Box(modifier = modifier)

    Dialog(
        // Back gesture / back key leaves fullscreen — the platform's own
        // "way back", in addition to the intent button itself.
        onDismissRequest = onExitRequest,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnClickOutside = false,
        ),
    ) {
        ImmersiveFullscreenEffect()
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            content = content,
        )
    }
}

/**
 * Immersive mode for the fullscreen window: system bars hidden, swipe to
 * reveal them transiently, restored on exit.
 *
 * Scoped to the dialog's own window, so an app that manages its activity's
 * bars itself is not disturbed — closing the dialog restores the bars this
 * effect hid and nothing else.
 */
@Composable
private fun ImmersiveFullscreenEffect() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.parent as? DialogWindowProvider)?.window
            ?: return@DisposableEffect onDispose { }
        // A Compose Dialog window wraps its content by default; fullscreen
        // needs the window itself to match the display.
        window.setLayout(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val insets = WindowCompat.getInsetsController(window, view)
        insets.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insets.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            insets.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
