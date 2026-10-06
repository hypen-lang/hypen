package space.hypen.renderer.render

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription

/**
 * Engine semantics → Compose semantics translation.
 *
 * Maps the platform-neutral semantics block (the camelCase wire shape of the
 * Rust `Semantics`, carried on `create` and re-emitted whole on
 * `setSemantics`) onto `Modifier.semantics {}`, mirroring the DOM renderer's
 * ARIA translation:
 *
 * | Semantics field    | Compose                                             |
 * |--------------------|-----------------------------------------------------|
 * | `hidden`           | `clearAndSetSemantics {}` — removed from the a11y tree |
 * | `name` (explicit)  | `contentDescription` — author `.label()` overrides content |
 * | `name` (img role)  | `contentDescription` — image alt has no text to derive from |
 * | `role`             | `role = Role.Button/Tab/Checkbox/Switch/Image/DropdownList` |
 * | `heading` role     | `heading()`                                         |
 * | `selected`         | `selected = true`                                   |
 * | `checked`/`expanded`/`pressed`/`current`/`description` | `stateDescription` |
 *
 * Derived (non-explicit) names on text-bearing elements are deliberately NOT
 * applied — TalkBack already reads the visible text, exactly as the browser
 * does on DOM. The id-reference relationships (`controls`/`describedby`/
 * `labelledby`/`owns`/`activeDescendant`) have no Compose target and are
 * dropped by design (see the "Platform support" section of
 * hypen-docs/content/docs/guide/accessibility.mdx).
 */
fun Modifier.applyHypenSemantics(block: Map<String, Any?>?): Modifier {
    if (block == null) return this

    if (block["hidden"] == true) {
        // Decorative: remove this node (and its descendants' semantics) from
        // the accessibility tree entirely — the aria-hidden equivalent.
        return this.clearAndSetSemantics {}
    }

    val label = effectiveLabel(block)
    val composeRole = composeRole(block["role"] as? String)
    val isHeading = block["role"] == "heading"
    val isSelected = block["selected"] == true
    val state = stateDescriptionFor(block)

    if (label == null && composeRole == null && !isHeading && !isSelected && state == null) {
        return this
    }

    return this.semantics {
        if (label != null) contentDescription = label
        if (composeRole != null) role = composeRole
        if (isHeading) heading()
        if (isSelected) selected = true
        if (state != null) stateDescription = state
    }
}

/**
 * An explicit author `.label(...)` always overrides; an image's name (alt
 * text) is applied too, since there is no visible text TalkBack could derive
 * it from. Derived names on text-bearing elements stay with the content.
 */
internal fun effectiveLabel(block: Map<String, Any?>): String? {
    val name = block["name"] as? String ?: return null
    if (block["nameExplicit"] == true) return name
    // Media names (Image alt, Video title) have no visible text TalkBack
    // could derive them from, so the engine-derived name is applied.
    if (block["role"] == "img" || block["role"] == "video") return name
    return null
}

/** Engine role token → Compose [Role], where a faithful one exists. */
internal fun composeRole(token: String?): Role? =
    when (token) {
        "button", "option" -> Role.Button
        "tab" -> Role.Tab
        "checkbox" -> Role.Checkbox
        "switch" -> Role.Switch
        "img" -> Role.Image
        "listbox", "combobox" -> Role.DropdownList
        else -> null
    }

/**
 * Self-state → TalkBack's state-description slot. First applicable wins:
 * checked (toggles) > expanded (disclosures) > pressed (toggle buttons) >
 * current (nav position); a supplementary `.description(...)` is appended
 * (or used alone) since Compose has no separate hint slot.
 */
internal fun stateDescriptionFor(block: Map<String, Any?>): String? {
    val state =
        when {
            block["checked"] is Boolean -> if (block["checked"] == true) "checked" else "unchecked"
            block["expanded"] is Boolean -> if (block["expanded"] == true) "expanded" else "collapsed"
            block["pressed"] is Boolean -> if (block["pressed"] == true) "pressed" else "not pressed"
            block["current"] is String -> "current ${block["current"]}"
            else -> null
        }
    val description = block["description"] as? String
    return when {
        state != null && description != null -> "$state, $description"
        state != null -> state
        else -> description
    }
}
