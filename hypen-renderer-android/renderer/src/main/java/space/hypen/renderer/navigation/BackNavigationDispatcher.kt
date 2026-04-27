package space.hypen.renderer.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.remote.RemoteEngine

/**
 * Configuration for back-button navigation integration.
 *
 * When enabled, Android's back button dispatches a configurable action
 * to the remote server, allowing the server-side module to pop its
 * view stack and send back updated patches.
 *
 * @param backAction The action name dispatched on back navigation (default: "navigateBack")
 */
data class NavigationOptions(
    val backAction: String = DEFAULT_BACK_ACTION,
) {
    companion object {
        const val DEFAULT_BACK_ACTION = "navigateBack"

        /**
         * Default navigation options using "navigateBack" action.
         */
        val DEFAULT = NavigationOptions()
    }
}

private val log = HypenLoggers.remote

/**
 * Composable that intercepts the Android back button and dispatches
 * a navigation action to the remote server.
 *
 * This is opt-in: only active when [navigationOptions] is non-null.
 * The back press is consumed (not propagated to the system) when the
 * engine is connected; otherwise it falls through to the default behavior.
 *
 * @param remoteEngine The remote engine to dispatch the action to
 * @param navigationOptions Configuration for the back action, or null to disable
 * @param enabled Whether the back handler is currently active (e.g., can be
 *   disabled when there's no view to go back to)
 */
@Composable
internal fun BackNavigationDispatcher(
    remoteEngine: RemoteEngine,
    navigationOptions: NavigationOptions?,
    enabled: Boolean = true,
) {
    if (navigationOptions == null) return

    BackHandler(enabled = enabled) {
        log.debug("Back button pressed, dispatching action: %s", navigationOptions.backAction)
        remoteEngine.dispatchAction(navigationOptions.backAction)
    }
}
