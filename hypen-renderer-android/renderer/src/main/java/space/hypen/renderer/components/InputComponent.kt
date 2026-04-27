package space.hypen.renderer.components

import android.util.Log
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalActionDispatcher

/**
 * Handler for Input (TextField) components.
 * Supports form event applicators: onInput, onChange, onFocus, onBlur
 */
class InputComponent : ComponentHandler {
    override val typeName: String = "input"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val actionDispatcher = LocalActionDispatcher.current

        val initialValue =
            element.getStringProp("0")
                ?: element.getStringProp("value")
                ?: ""

        val placeholder = element.getStringProp("placeholder") ?: ""
        // Default to a plain/undecorated field so Hypen's own styling
        // composes cleanly (matches iOS's `.textFieldStyle(.plain)`).
        // Callers that want Material chrome can pass `variant: "filled"`
        // or `variant: "outlined"` explicitly.
        val variant = element.getStringProp("variant") ?: "plain"

        // Parse event applicators
        val onInputAction = element.props["onInput.0"]?.let { ActionValue.parse(it) }
        val onChangeAction = element.props["onChange.0"]?.let { ActionValue.parse(it) }
        val onFocusAction = element.props["onFocus.0"]?.let { ActionValue.parse(it) }
        val onBlurAction = element.props["onBlur.0"]?.let { ActionValue.parse(it) }

        // Two-way binding path from .bind(@state.x)
        val bindTarget = element.getStringProp("bind")

        // Local text state - only sync from server when not focused
        var text by remember { mutableStateOf(initialValue) }
        var isFocused by remember { mutableStateOf(false) }

        // Update text when element value changes, but ONLY if not focused
        // This prevents losing focus/cursor position during typing
        LaunchedEffect(initialValue) {
            if (!isFocused) {
                text = initialValue
            }
        }

        // Track focus state for onChange (fires on blur after change)
        var hasChanged by remember { mutableStateOf(false) }
        var lastTextOnFocus by remember { mutableStateOf(initialValue) }

        // Value change handler
        val onValueChange: (String) -> Unit = { newValue ->
            text = newValue
            hasChanged = true

            // Dispatch onInput action (fires on every keystroke)
            if (onInputAction != null && actionDispatcher != null) {
                Log.d(TAG, "onInput fired, dispatching action: ${onInputAction.actionName}")
                actionDispatcher.dispatch(
                    onInputAction.actionName,
                    mapOf(
                        "type" to "input",
                        "value" to newValue,
                        "input" to newValue,
                        "timestamp" to System.currentTimeMillis(),
                    ) + onInputAction.payload,
                )
            }

            // Dispatch __hypen_bind for two-way binding
            if (bindTarget != null && actionDispatcher != null) {
                actionDispatcher.dispatch(
                    "__hypen_bind",
                    mapOf(
                        "path" to bindTarget,
                        "value" to newValue,
                    ),
                )
            }
        }

        // Focus change modifier
        val focusModifier = modifier.onFocusChanged { focusState ->
            if (focusState.isFocused) {
                // Focus gained
                isFocused = true
                lastTextOnFocus = text
                hasChanged = false

                if (onFocusAction != null && actionDispatcher != null) {
                    Log.d(TAG, "onFocus fired, dispatching action: ${onFocusAction.actionName}")
                    actionDispatcher.dispatch(
                        onFocusAction.actionName,
                        mapOf(
                            "type" to "focus",
                            "value" to text,
                            "timestamp" to System.currentTimeMillis(),
                        ) + onFocusAction.payload,
                    )
                }
            } else {
                // Focus lost (blur)
                isFocused = false

                // Sync final value to external state on blur
                if (text != initialValue) {
                    // The text changed while focused - this is the authoritative value
                }

                if (onBlurAction != null && actionDispatcher != null) {
                    Log.d(TAG, "onBlur fired, dispatching action: ${onBlurAction.actionName}")
                    actionDispatcher.dispatch(
                        onBlurAction.actionName,
                        mapOf(
                            "type" to "blur",
                            "value" to text,
                            "timestamp" to System.currentTimeMillis(),
                        ) + onBlurAction.payload,
                    )
                }

                // Dispatch onChange on blur if text changed
                if (hasChanged && text != lastTextOnFocus && onChangeAction != null && actionDispatcher != null) {
                    Log.d(TAG, "onChange fired, dispatching action: ${onChangeAction.actionName}")
                    actionDispatcher.dispatch(
                        onChangeAction.actionName,
                        mapOf(
                            "type" to "change",
                            "value" to text,
                            "previousValue" to lastTextOnFocus,
                            "timestamp" to System.currentTimeMillis(),
                        ) + onChangeAction.payload,
                    )
                }

                hasChanged = false
            }
        }

        // Use an undecorated BasicTextField so Hypen's own tw styling
        // (background, rounded corners, padding) is authoritative. The
        // Material OutlinedTextField/TextField brought its own outline
        // and ~56dp minimum height, which stacked on top of user tw
        // classes as a "double" border and oversized input. Match the
        // iOS renderer, which uses `TextField` with `.textFieldStyle(.plain)`
        // for the same reason. The `filled`/`outlined` variants fall back
        // to the Material widgets for callers that explicitly opt in.
        when (variant.lowercase()) {
            "filled" ->
                TextField(
                    value = text,
                    onValueChange = onValueChange,
                    modifier = focusModifier,
                    placeholder = { Text(placeholder) },
                )
            "outlined" ->
                OutlinedTextField(
                    value = text,
                    onValueChange = onValueChange,
                    modifier = focusModifier,
                    placeholder = { Text(placeholder) },
                )
            else -> {
                val contentColor = LocalContentColor.current
                BasicTextField(
                    value = text,
                    onValueChange = onValueChange,
                    modifier = focusModifier,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = contentColor),
                    cursorBrush = SolidColor(contentColor),
                    decorationBox = { inner ->
                        if (text.isEmpty() && placeholder.isNotEmpty()) {
                            Text(
                                text = placeholder,
                                style = MaterialTheme.typography.bodyMedium,
                                color = contentColor.copy(alpha = 0.6f),
                            )
                        }
                        inner()
                    },
                )
            }
        }
    }

    companion object {
        private const val TAG = "InputComponent"
    }
}
