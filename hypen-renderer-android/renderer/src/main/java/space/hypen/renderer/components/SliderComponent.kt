package space.hypen.renderer.components

import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Slider component - range input.
 */
class SliderComponent : ComponentHandler {
    override val typeName: String = "slider"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val dispatcher = LocalActionDispatcher.current

        val initialValue = element.getFloatProp("value")
            ?: element.getFloatProp("0")
            ?: 0f
        val min = element.getFloatProp("min") ?: 0f
        val max = element.getFloatProp("max") ?: 100f
        val step = element.getFloatProp("step")
        val disabled = element.getBoolProp("disabled") ?: false

        var value by remember(initialValue) { mutableFloatStateOf(initialValue) }

        // Event handlers - use ActionValue.parse() for complex action object support
        val onChangeAction = element.props["onChange.0"]?.let { ActionValue.parse(it) }
        val onInputAction = element.props["onInput.0"]?.let { ActionValue.parse(it) }

        // Two-way binding path from .bind(@state.x)
        val bindTarget = element.getStringProp("bind")

        Slider(
            value = value,
            onValueChange = { newValue ->
                value = newValue
                if (onInputAction != null && dispatcher != null) {
                    dispatcher.dispatch(
                        onInputAction.actionName,
                        mapOf(
                            "type" to "input",
                            "value" to newValue,
                            "timestamp" to System.currentTimeMillis()
                        ) + onInputAction.payload,
                    )
                }
            },
            onValueChangeFinished = {
                if (onChangeAction != null && dispatcher != null) {
                    dispatcher.dispatch(
                        onChangeAction.actionName,
                        mapOf(
                            "type" to "change",
                            "value" to value,
                            "timestamp" to System.currentTimeMillis()
                        ) + onChangeAction.payload,
                    )
                }

                // Dispatch __hypen_bind for two-way binding
                if (bindTarget != null && dispatcher != null) {
                    dispatcher.dispatch(
                        "__hypen_bind",
                        mapOf(
                            "path" to bindTarget,
                            "value" to value,
                        )
                    )
                }
            },
            valueRange = min..max,
            steps = if (step != null && step > 0) {
                ((max - min) / step).toInt() - 1
            } else 0,
            enabled = !disabled,
            modifier = modifier
        )
    }
}
