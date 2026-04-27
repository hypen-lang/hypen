package space.hypen.renderer.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.routing.RouteMatch
import space.hypen.renderer.routing.RouterController

/**
 * CompositionLocal providing access to the nearest router controller.
 */
val LocalRouterController = compositionLocalOf<RouterController?> { null }

/**
 * Tracks whether any Route matched during the current composition.
 */
private val LocalRouteMatched = compositionLocalOf<MutableState<Boolean>?> { null }

/**
 * Router container that controls which Route child is visible based on the current path.
 */
class RouterComponent : ComponentHandler {
    override val typeName: String = "router"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val initialPath =
            element.getStringProp("currentPath")
                ?: element.getStringProp("path")
                ?: "/"

        val router = remember { RouterController(initialPath) }

        // Keep router in sync if server pushes a new path
        val externalPath = element.getStringProp("currentPath") ?: element.getStringProp("path")
        LaunchedEffect(externalPath) {
            router.sync(externalPath)
        }

        val routerState by router.state.collectAsState()
        val hasMatch = remember { androidx.compose.runtime.mutableStateOf(false) }
        hasMatch.value = false

        CompositionLocalProvider(
            LocalRouterController provides router,
            LocalRouteMatched provides hasMatch,
        ) {
            Column(modifier = modifier.fillMaxWidth()) {
                renderChildren()
            }
        }

        // Clear params if nothing matched this render pass
        SideEffect {
            if (!hasMatch.value) {
                router.setMatch(
                    RouteMatch(
                        path = routerState.currentPath,
                        params = emptyMap(),
                        query = routerState.query,
                    ),
                )
            }
        }
    }
}

/**
 * Route container that renders its children only when the current path matches.
 */
class RouteComponent : ComponentHandler {
    override val typeName: String = "route"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val router = LocalRouterController.current
        if (router == null) {
            // No router context - render children as-is
            Column(modifier = modifier.fillMaxWidth()) {
                renderChildren()
            }
            return
        }

        val path =
            element.getStringProp("path")
                ?: element.getStringProp("0")
                ?: "/"

        val matchFlag = LocalRouteMatched.current
        val routerState by router.state.collectAsState()
        val match = router.matchPath(path, routerState.currentPath)
        if (match != null) {
            matchFlag?.value = true
            router.setMatch(match)
            Column(modifier = modifier.fillMaxWidth()) {
                renderChildren()
            }
        }
    }
}

/**
 * Simple Link component that navigates via the router when clicked.
 */
class LinkComponent : ComponentHandler {
    override val typeName: String = "link"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val router = LocalRouterController.current
        val targetPath =
            element.getStringProp("to")
                ?: element.getStringProp("href")
                ?: element.getStringProp("0")
                ?: "/"
        val replace = element.getBoolProp("replace") ?: false

        val hasExplicitClick =
            element.props.containsKey("onClick") ||
                element.props.containsKey("onPress") ||
                element.props.containsKey("onLongClick")

        val clickableModifier =
            if (router != null && !hasExplicitClick) {
                modifier.clickable {
                    if (replace) {
                        router.replace(targetPath)
                    } else {
                        router.push(targetPath)
                    }
                }
            } else {
                modifier
            }

        Box(modifier = clickableModifier) {
            renderChildren()
        }
    }
}
