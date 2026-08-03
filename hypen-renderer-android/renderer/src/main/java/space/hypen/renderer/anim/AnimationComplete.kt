package space.hypen.renderer.anim

import space.hypen.renderer.model.ActionValue

/**
 * `.onAnimationComplete(@actions.x, ...)` — the completion-event applicator.
 *
 * Unlike every other `on*` applicator it attaches nothing: the action is read
 * off the element's props when a playback settles NATURALLY. Firing points
 * and payloads are normative (.notes/ANIMATION_API_DESIGN.md §3 Option F):
 *
 *   - finite `.animate` preset completes → `{ animation: "<presetName>" }`
 *   - `.enter` settles                   → `{ animation: "enter" }`
 *   - `.exit` settles (before finalize)  → `{ animation: "exit" }`
 *   - `.states` transition settles       → `{ animation: "states", state: "<label>" }`
 *
 * Interrupted, superseded, reduced-motion-skipped and looping playbacks fire
 * NOTHING — that contract removes most completion races by construction.
 *
 * The applicator lowers like any other aggregate-arg applicator, so the
 * action arrives as `onAnimationComplete.0` with extra named args under
 * `onAnimationComplete.<name>`.
 */
fun animationCompleteAction(props: Map<String, Any?>): ActionValue? {
    val prefix = "$ANIM_COMPLETE_PROP."
    val args = mutableMapOf<String, Any?>()
    for ((name, value) in props) {
        when {
            name == ANIM_COMPLETE_PROP -> args["0"] = value
            name.startsWith(prefix) -> args[name.substring(prefix.length)] = value
        }
    }
    if (args.isEmpty()) return null
    return ActionValue.parse(args)
}
