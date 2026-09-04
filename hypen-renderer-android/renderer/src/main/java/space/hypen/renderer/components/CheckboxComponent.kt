package space.hypen.renderer.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.foundation.selection.toggleable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Checkbox component.
 */
class CheckboxComponent : ComponentHandler {
    override val typeName: String = "checkbox"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val dispatcher = LocalActionDispatcher.current

        val initialChecked = element.getBoolProp("checked") ?: false
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
            modifier = modifier.toggleable(
                value = checked,
                enabled = !disabled,
                role = Role.Checkbox,
                onValueChange = onCheckedChange,
            ),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CheckboxVisual(
                checked = checked,
                enabled = !disabled,
            )
            if (label.isNotEmpty()) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(text = label)
            }
        }
    }
}

internal val HypenCheckboxMetric: Dp = 20.dp

@Composable
private fun CheckboxVisual(
    checked: Boolean,
    enabled: Boolean,
) {
    val selectedColor = Color(0xFF3B82F6)
    val borderColor = when {
        !enabled -> Color(0xFF9CA3AF).copy(alpha = 0.55f)
        checked -> selectedColor
        else -> Color(0xFF6B7280)
    }
    val shape = RoundedCornerShape(4.dp)
    Box(
        modifier = Modifier
            .size(HypenCheckboxMetric)
            .background(if (checked) selectedColor else Color.Transparent, shape)
            .border(2.dp, borderColor, shape),
    ) {
        if (checked) {
            Canvas(modifier = Modifier.size(HypenCheckboxMetric)) {
                drawLine(
                    color = Color.White,
                    start = Offset(size.width * 0.23f, size.height * 0.52f),
                    end = Offset(size.width * 0.43f, size.height * 0.72f),
                    strokeWidth = 2.dp.toPx(),
                    cap = StrokeCap.Round,
                )
                drawLine(
                    color = Color.White,
                    start = Offset(size.width * 0.43f, size.height * 0.72f),
                    end = Offset(size.width * 0.78f, size.height * 0.30f),
                    strokeWidth = 2.dp.toPx(),
                    cap = StrokeCap.Round,
                )
            }
        }
    }
}
