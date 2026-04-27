package space.hypen.renderer.applicators

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.focusable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.model.ActionValue

private val log = HypenLoggers.components.child("Events")

/**
 * Applicator for onClick events.
 */
class OnClickApplicator : ApplicatorHandler {
    override val name: String = "onClick"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val actionValue = ActionValue.parse(value)
        if (actionValue == null) {
            log.warn("onClick value must be an action reference, got: $value")
            return modifier
        }

        val dispatcher =
            context.actionDispatcher ?: run {
                log.warn("No action dispatcher available for onClick")
                return modifier
            }

        return modifier.clickable {
            log.debug("onClick fired, dispatching action: ${actionValue.actionName}")
            dispatcher.dispatch(actionValue.actionName, actionValue.payload)
        }
    }

}

/**
 * Applicator for onPress events (alias for onClick).
 */
class OnPressApplicator : ApplicatorHandler {
    override val name: String = "onPress"

    private val delegate = OnClickApplicator()

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = delegate.apply(modifier, value, context)
}

/**
 * Applicator for onLongClick events.
 */
class OnLongClickApplicator : ApplicatorHandler {
    override val name: String = "onLongClick"

    @OptIn(ExperimentalFoundationApi::class)
    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val actionValue = ActionValue.parse(value)
        if (actionValue == null) {
            log.warn("onLongClick value must be an action reference, got: $value")
            return modifier
        }

        val dispatcher =
            context.actionDispatcher ?: run {
                log.warn("No action dispatcher available for onLongClick")
                return modifier
            }

        return modifier.combinedClickable(
            onClick = { /* no-op for regular clicks */ },
            onLongClick = {
                log.debug("onLongClick fired, dispatching action: ${actionValue.actionName}")
                dispatcher.dispatch(actionValue.actionName, actionValue.payload)
            }
        )
    }

}

/**
 * Applicator for onLongPress events (alias for onLongClick).
 */
class OnLongPressApplicator : ApplicatorHandler {
    override val name: String = "onLongPress"

    private val delegate = OnLongClickApplicator()

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = delegate.apply(modifier, value, context)
}

/**
 * Applicator for onFocus events.
 */
class OnFocusApplicator : ApplicatorHandler {
    override val name: String = "onFocus"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val actionValue = ActionValue.parse(value)
        if (actionValue == null) {
            log.warn("onFocus value must be an action reference, got: $value")
            return modifier
        }

        val dispatcher =
            context.actionDispatcher ?: run {
                log.warn("No action dispatcher available for onFocus")
                return modifier
            }

        return modifier
            .focusable()
            .onFocusChanged { focusState ->
                if (focusState.isFocused) {
                    log.debug("onFocus fired, dispatching action: ${actionValue.actionName}")
                    dispatcher.dispatch(
                        actionValue.actionName,
                        actionValue.payload + mapOf(
                            "type" to "focus",
                            "timestamp" to System.currentTimeMillis()
                        )
                    )
                }
            }
    }

}

/**
 * Applicator for onBlur events.
 */
class OnBlurApplicator : ApplicatorHandler {
    override val name: String = "onBlur"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val actionValue = ActionValue.parse(value)
        if (actionValue == null) {
            log.warn("onBlur value must be an action reference, got: $value")
            return modifier
        }

        val dispatcher =
            context.actionDispatcher ?: run {
                log.warn("No action dispatcher available for onBlur")
                return modifier
            }

        return modifier
            .focusable()
            .onFocusChanged { focusState ->
                if (!focusState.isFocused) {
                    log.debug("onBlur fired, dispatching action: ${actionValue.actionName}")
                    dispatcher.dispatch(
                        actionValue.actionName,
                        actionValue.payload + mapOf(
                            "type" to "blur",
                            "timestamp" to System.currentTimeMillis()
                        )
                    )
                }
            }
    }

}
