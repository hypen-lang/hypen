package space.hypen.renderer.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalActionDispatcher

/**
 * Handler for Button components.
 * Uses a Box instead of Material Button to allow full styling control via applicators.
 * onClick is handled by the applicator system which adds clickable modifier.
 * Also supports the generic "action" prop for positional action syntax: Button("@actions.x").
 */
class ButtonComponent : ComponentHandler {
    override val typeName: String = "button"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Parse horizontal alignment (cross axis for content inside button)
        val horizontalStr = element.getStringProp("horizontalAlignment.0")
        val verticalStr = element.getStringProp("verticalAlignment.0")

        val contentAlignment = parseAlignment(horizontalStr, verticalStr)

        // Support "action" prop from positional syntax: Button("@actions.x")
        // If no onClick applicator was applied, wire up the "action" prop as click handler
        val actionProp = element.props["action"] ?: element.props["action.0"]
        val actionValue = if (actionProp != null) ActionValue.parse(actionProp) else null
        val dispatcher = LocalActionDispatcher.current

        val effectiveModifier = if (actionValue != null && dispatcher != null &&
            element.props["onClick.0"] == null && element.props["onPress.0"] == null
        ) {
            modifier.clickable {
                dispatcher.dispatch(actionValue.actionName, actionValue.payload)
            }
        } else {
            modifier
        }

        Box(
            modifier = effectiveModifier,
            contentAlignment = contentAlignment,
        ) {
            renderChildren()
        }
    }

    private fun parseAlignment(horizontal: String?, vertical: String?): Alignment {
        val h = when (horizontal?.lowercase()) {
            "start", "left", "leading", "flex-start" -> Alignment.Start
            "end", "right", "trailing", "flex-end" -> Alignment.End
            "center" -> Alignment.CenterHorizontally
            else -> Alignment.CenterHorizontally // Default center for buttons
        }
        val v = when (vertical?.lowercase()) {
            "top", "start", "flex-start" -> Alignment.Top
            "bottom", "end", "flex-end" -> Alignment.Bottom
            "center" -> Alignment.CenterVertically
            else -> Alignment.CenterVertically // Default center for buttons
        }
        return when {
            h == Alignment.Start && v == Alignment.Top -> Alignment.TopStart
            h == Alignment.CenterHorizontally && v == Alignment.Top -> Alignment.TopCenter
            h == Alignment.End && v == Alignment.Top -> Alignment.TopEnd
            h == Alignment.Start && v == Alignment.CenterVertically -> Alignment.CenterStart
            h == Alignment.CenterHorizontally && v == Alignment.CenterVertically -> Alignment.Center
            h == Alignment.End && v == Alignment.CenterVertically -> Alignment.CenterEnd
            h == Alignment.Start && v == Alignment.Bottom -> Alignment.BottomStart
            h == Alignment.CenterHorizontally && v == Alignment.Bottom -> Alignment.BottomCenter
            h == Alignment.End && v == Alignment.Bottom -> Alignment.BottomEnd
            else -> Alignment.Center
        }
    }
}
