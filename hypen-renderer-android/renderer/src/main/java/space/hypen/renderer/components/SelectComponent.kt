package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Select/Dropdown component.
 */
class SelectComponent : ComponentHandler {
    override val typeName: String = "select"

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val dispatcher = LocalActionDispatcher.current

        val initialValue = element.getStringProp("value") ?: ""
        val placeholder = element.getStringProp("placeholder") ?: "Select..."
        val disabled = element.getBoolProp("disabled") ?: false

        // Options can be passed as a list
        val optionsList = element.props["options"]
        val options = when (optionsList) {
            is List<*> -> optionsList.mapNotNull { it?.toString() }
            else -> emptyList()
        }

        var expanded by remember { mutableStateOf(false) }
        var selectedValue by remember(initialValue) { mutableStateOf(initialValue) }

        // Event handlers - use ActionValue.parse() for complex action object support
        val onChangeAction = element.props["onChange.0"]?.let { ActionValue.parse(it) }

        // Two-way binding path from .bind(@state.x)
        val bindTarget = element.getStringProp("bind")

        ExposedDropdownMenuBox(
            expanded = expanded,
            onExpandedChange = { if (!disabled) expanded = it },
            modifier = modifier
        ) {
            OutlinedTextField(
                value = selectedValue.ifEmpty { placeholder },
                onValueChange = {},
                readOnly = true,
                enabled = !disabled,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                modifier = Modifier.menuAnchor()
            )

            ExposedDropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false }
            ) {
                options.forEachIndexed { index, option ->
                    DropdownMenuItem(
                        text = { Text(option) },
                        onClick = {
                            selectedValue = option
                            expanded = false
                            if (onChangeAction != null && dispatcher != null) {
                                dispatcher.dispatch(
                                    onChangeAction.actionName,
                                    mapOf(
                                        "type" to "change",
                                        "value" to option,
                                        "selectedIndex" to index,
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
                                        "value" to option,
                                    )
                                )
                            }
                        }
                    )
                }
            }
        }
    }
}
