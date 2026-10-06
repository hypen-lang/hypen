package space.hypen.core

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNames

/**
 * The external capability surface — actions, navigation and inputs for
 * callers that are **not** the rendered UI: MCP servers, REST handlers,
 * CLIs, AI agents, test harnesses.
 *
 * [IEngine.dispatchAction] reaches every registered handler, because the
 * renderer legitimately needs that — `router.push` moves the app and
 * `__hypen_bind` is how a `.bind()` edit writes state. Until an external
 * caller existed, "reachable ⇔ rendered" did the guarding. It stops holding
 * the moment a dispatcher that is not the tree shows up, so the guard
 * becomes explicit: **nothing is externally reachable that a developer did
 * not declare.** Each surface is an allowlist derived from a declaration:
 *
 * | Capability | Declared by        | Listed by                     |
 * |------------|--------------------|-------------------------------|
 * | Actions    | `.onAction()`      | [NativeEngine.listActions]    |
 * | Navigation | `Router { Route }` | [NativeEngine.listRoutes]     |
 * | Inputs     | `.bind(@state.x)`  | [NativeEngine.listBindings]   |
 *
 * `__hypen_bind` is not one of them: it takes a caller-supplied path and
 * assigns straight into state, so it stays behind `set_input`, which
 * validates the field against the declared bind set and then builds the
 * internal payload itself.
 *
 * The guard lives in the Rust engine (`agent_core::resolve_external`) and is
 * shared by every SDK. This file only models its output and relays through
 * it — never re-implement or short-circuit it here, or the rule drifts per
 * SDK. See `hypen-engine-rs/src/agent.rs`.
 */

/**
 * One externally dispatchable action, as advertised by
 * [NativeEngine.listActions].
 */
@Serializable
data class AgentAction(
    /**
     * Name to pass to [NativeEngine.dispatchExternal]. For module actions
     * this is the declared action name; for built-ins it is the external
     * alias (`navigate`, `back`, `set_input`) rather than the internal one.
     */
    val name: String,
    /** Owning module scope. `null` for the primary module and for built-ins. */
    val module: String? = null,
    /** True for framework-provided capabilities, false for module actions. */
    val builtin: Boolean = false
)

/**
 * A declared route, as a navigation target for the `navigate` built-in.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class AgentRoute(
    /** The pattern exactly as declared (e.g. `/user-profile/:id`). */
    val path: String,
    /** Names of the `:param` segments, in order. Empty for a static route. */
    val params: List<String> = emptyList(),
    /** Module scope of the enclosing `Router`, if any. */
    @SerialName(MODULE_SCOPE_KEY)
    @JsonNames(MODULE_SCOPE_ALT_KEY)
    val moduleScope: String? = null
)

/**
 * One `.bind()`-declared writable input, as accepted by the `set_input`
 * built-in.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class BoundInput(
    /** State path the bind writes, exactly as `.bind(@state.x)` declared it. */
    val path: String,
    /**
     * Prop the value lands on — `value`, `checked`, `on` or `playback`.
     * An independent signal of the field's type: `checked` / `on` are
     * boolean controls, so `set_input` wants a boolean there.
     */
    val prop: String,
    /** Element type that declared the bind (`Input`, `Checkbox`, …). */
    @SerialName(ELEMENT_TYPE_KEY)
    @JsonNames(ELEMENT_TYPE_ALT_KEY)
    val elementType: String,
    /** Module scope of the declaring element, if any. */
    @SerialName(MODULE_SCOPE_KEY)
    @JsonNames(MODULE_SCOPE_ALT_KEY)
    val moduleScope: String? = null,
    /**
     * Pattern of the enclosing `Route`, if any — which screen the field is
     * on. The same field name under two routes is two different form fields
     * to a caller deciding what to fill in. `null` for a bind declared
     * outside any `Route`.
     */
    val route: String? = null,
    /**
     * The field's human label, taken from a **static** `placeholder` or
     * `label` prop and from nothing else. A binding or template string there
     * would render state into the manifest, so the engine never reads one —
     * an interpolated placeholder yields `null` here, not its rendered value.
     * See `agent_core::static_label`.
     */
    val label: String? = null
)

/**
 * The built-in action names the engine offers to external callers.
 *
 * These are the copy, not the source: `ExternalSurfaceTest` pins every one
 * of them to `NativeEngine.externalBuiltinNames()`, so an engine-side rename
 * fails a test here rather than silently desynchronising this SDK from the
 * guard.
 *
 * The `hypen.` prefix is load-bearing. An app is free to declare its own
 * `.onAction("navigate")`, and an unnamespaced built-in would shadow it —
 * `hypen.` is a reserved prefix no module action may use.
 */
object ExternalActions {
    /** Navigate to a declared route. Payload `{ "to": "/path" }`. Offered only when the app declares a `Router`. */
    const val NAVIGATE = "hypen.navigate"
    /** Go back in history. Offered only when the app declares a `Router`. */
    const val BACK = "hypen.back"
    /** Write a `.bind()`-declared input. Payload `{ "field": path, "value": v }`. Offered only when the app declares a `.bind()`. */
    const val SET_INPUT = "hypen.set_input"
    /** The internal bind action. Present so hosts can match it on the way out; dispatching it externally is refused. */
    const val BIND_ACTION = "__hypen_bind"
}

// The engine serializes these structs with `rename_all = "camelCase"`
// (`moduleScope` / `elementType`), matching what the binding docs advertise.
// An earlier engine wrote snake_case. Decode both spellings so an SDK built
// against either vintage keeps parsing, and a Kotlin host never silently
// reads `null` for a scope the engine did report.
private const val MODULE_SCOPE_KEY = "module_scope"
private const val MODULE_SCOPE_ALT_KEY = "moduleScope"
private const val ELEMENT_TYPE_KEY = "element_type"
private const val ELEMENT_TYPE_ALT_KEY = "elementType"

/**
 * Decoder for the engine's external-surface payloads. Lenient about
 * unknown keys so a newer engine that adds a field to any of these
 * structs does not break an older SDK.
 */
internal val externalSurfaceJson = Json { ignoreUnknownKeys = true }
