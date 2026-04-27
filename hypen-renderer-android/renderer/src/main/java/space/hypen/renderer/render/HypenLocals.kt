package space.hypen.renderer.render

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * CompositionLocal providing access to the action dispatcher.
 * Used by components that need to dispatch actions directly (e.g., Input for form events).
 */
val LocalActionDispatcher = staticCompositionLocalOf<ActionDispatcher?> { null }

/**
 * CompositionLocal providing access to the compose renderer.
 * Used by components that need to access children directly (e.g., List for LazyColumn).
 */
val LocalComposeRenderer = staticCompositionLocalOf<ComposeRenderer?> { null }
