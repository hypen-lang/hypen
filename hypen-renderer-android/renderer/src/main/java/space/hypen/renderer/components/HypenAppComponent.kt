package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import space.hypen.renderer.DefaultErrorContent
import space.hypen.renderer.DefaultLoadingContent
import space.hypen.renderer.HypenApp
import space.hypen.renderer.HypenElement
import space.hypen.renderer.model.HypenElement as HypenElementModel
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.render.LocalComposeRenderer

/**
 * Component handler for embedding a remote Hypen app within a Hypen
 * component tree.
 *
 * Usage in Hypen DSL:
 * ```hypen
 * HypenApp("ws://localhost:3000")
 *
 * // Or with named prop:
 * HypenApp(url: "ws://localhost:3000")
 *
 * // With custom loading / error UI via slot children:
 * HypenApp("ws://localhost:3000") {
 *     Column { Spinner() Text("Connecting...") }.slot("loading")
 *     Column { Text("Couldn't reach the app") }.slot("error")
 * }
 * ```
 *
 * The embedded app runs on its own nested [RemoteEngine] + [ComposeRenderer]
 * (spun up by the reused [HypenApp] composable). The `loading` and `error`
 * slot children are *host*-app subtrees: they are rendered through the host
 * renderer and host action dispatcher, so they read host state and dispatch
 * host actions. When a slot isn't provided, the built-in spinner / error UI
 * is used.
 */
class HypenAppComponent : ComponentHandler {
    override val typeName: String = "hypenapp"

    @Composable
    override fun Render(
        element: HypenElementModel,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Capture the *host* renderer/dispatcher before the nested HypenApp
        // shadows these composition locals with the embedded app's own.
        val hostRenderer = LocalComposeRenderer.current
        val hostDispatcher = LocalActionDispatcher.current

        val url = element.getStringProp("0")
            ?: element.getStringProp("url.0")
            ?: element.getStringProp("url")

        if (url == null) {
            HostSlot(
                slot = SLOT_ERROR,
                hostElementId = element.id,
                renderer = hostRenderer,
                dispatcher = hostDispatcher,
                fallback = { Text("HypenApp: URL required", color = MaterialTheme.colorScheme.error) },
            )
            return
        }

        HypenApp(
            url = url,
            modifier = modifier,
            loadingContent = {
                HostSlot(
                    slot = SLOT_LOADING,
                    hostElementId = element.id,
                    renderer = hostRenderer,
                    dispatcher = hostDispatcher,
                    fallback = { DefaultLoadingContent() },
                )
            },
            errorContent = { message ->
                HostSlot(
                    slot = SLOT_ERROR,
                    hostElementId = element.id,
                    renderer = hostRenderer,
                    dispatcher = hostDispatcher,
                    fallback = { DefaultErrorContent(message) },
                )
            },
        )
    }

    companion object {
        private const val SLOT_LOADING = "loading"
        private const val SLOT_ERROR = "error"
    }
}

/**
 * Renders the host children tagged `.slot(name)`, or [fallback] when the
 * host passed none. Rendering goes through the *host* renderer (looked up at
 * call time so reactively-appearing slot subtrees are picked up) and re-binds
 * the host action dispatcher, which the reused [HypenApp] would otherwise
 * have replaced with the embedded app's dispatcher.
 */
@Composable
private fun HostSlot(
    slot: String,
    hostElementId: String,
    renderer: ComposeRenderer?,
    dispatcher: ActionDispatcher?,
    fallback: @Composable () -> Unit,
) {
    val slotChildren = renderer
        ?.getChildren(hostElementId)
        ?.filter { it.getStringProp("slot.0") == slot }
        .orEmpty()

    if (slotChildren.isEmpty() || renderer == null) {
        fallback()
        return
    }

    androidx.compose.runtime.CompositionLocalProvider(
        LocalComposeRenderer provides renderer,
        LocalActionDispatcher provides dispatcher,
    ) {
        Box {
            for (child in slotChildren) {
                key(child.id) {
                    HypenElement(element = child, renderer = renderer)
                }
            }
        }
    }
}
