package space.hypen.renderer.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Switch/Toggle component.
 */
class SwitchComponent : ComponentHandler {
    override val typeName: String = "switch"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val dispatcher = LocalActionDispatcher.current

        val initialChecked = element.getBoolProp("checked")
            ?: element.getBoolProp("value")
            ?: false
        val label = element.getStringProp("0")
            ?: element.getStringProp("label")
            ?: ""
        val disabled = element.getBoolProp("disabled") ?: false

        var checked by remember(initialChecked) { mutableStateOf(initialChecked) }

        // Event handlers - use ActionValue.parse() for complex action object support
        val onChangeAction = element.props["onChange.0"]?.let { ActionValue.parse(it) }

        // Two-way binding path from .bind(@state.x)
        val bindTarget = element.getStringProp("bind")

        val onCheckedChange: (Boolean) -> Unit = { newValue ->
            checked = newValue
            if (onChangeAction != null && dispatcher != null) {
                dispatcher.dispatch(
                    onChangeAction.actionName,
                    mapOf(
                        "type" to "change",
                        "checked" to newValue,
                        "value" to newValue,
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
                        "value" to newValue,
                    )
                )
            }
        }

        Row(
            modifier = modifier,
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (label.isNotEmpty()) {
                Text(text = label)
                Spacer(modifier = Modifier.width(8.dp))
            }
            Switch(
                checked = checked,
                onCheckedChange = if (disabled) null else onCheckedChange,
                enabled = !disabled,
            )
        }
    }
}
