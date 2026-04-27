package space.hypen.renderer.components

import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement

/**
 * Handler for TextArea component - multi-line text input.
 */
class TextAreaComponent : ComponentHandler {
    override val typeName: String = "textarea"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val dispatcher = LocalActionDispatcher.current

        val initialValue = element.getStringProp("value")
            ?: element.getStringProp("0")
            ?: ""
        val placeholder = element.getStringProp("placeholder") ?: ""
        val variant = element.getStringProp("variant") ?: "outlined"
        val minLines = element.getIntProp("minLines") ?: 3
        val maxLines = element.getIntProp("maxLines") ?: Int.MAX_VALUE

        var text by remember(initialValue) { mutableStateOf(initialValue) }

        // Event handlers - use ActionValue.parse() for complex action object support
        val onInputAction = element.props["onInput.0"]?.let { ActionValue.parse(it) }
        val onChangeAction = element.props["onChange.0"]?.let { ActionValue.parse(it) }

        // Two-way binding path from .bind(@state.x)
        val bindTarget = element.getStringProp("bind")

        val onValueChange: (String) -> Unit = { newValue ->
            text = newValue
            if (onInputAction != null && dispatcher != null) {
                dispatcher.dispatch(
                    onInputAction.actionName,
                    mapOf(
                        "type" to "input",
                        "value" to newValue,
                        "input" to newValue,
                        "timestamp" to System.currentTimeMillis()
                    ) + onInputAction.payload,
                )
            }

            if (onChangeAction != null && dispatcher != null) {
                dispatcher.dispatch(
                    onChangeAction.actionName,
                    mapOf(
                        "type" to "change",
                        "value" to newValue,
                        "input" to newValue,
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

        val textFieldModifier = modifier.defaultMinSize(minHeight = (minLines * 24).dp)

        when (variant.lowercase()) {
            "filled" -> {
                TextField(
                    value = text,
                    onValueChange = onValueChange,
                    modifier = textFieldModifier,
                    placeholder = if (placeholder.isNotEmpty()) {
                        { Text(placeholder) }
                    } else null,
                    minLines = minLines,
                    maxLines = maxLines,
                )
            }
            else -> {
                OutlinedTextField(
                    value = text,
                    onValueChange = onValueChange,
                    modifier = textFieldModifier,
                    placeholder = if (placeholder.isNotEmpty()) {
                        { Text(placeholder) }
                    } else null,
                    minLines = minLines,
                    maxLines = maxLines,
                )
            }
        }
    }
}
