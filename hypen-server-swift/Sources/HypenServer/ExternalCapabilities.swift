import Foundation

// The external capability surface, as Swift value types.
//
// These mirror `hypen-engine-rs/src/agent.rs` one-for-one. They describe what
// a caller that is NOT the rendered UI — an MCP server, a REST endpoint, a CLI,
// an AI agent — is allowed to reach. Every one of them is an allowlist derived
// from something the developer declared: `.onAction()` for actions,
// `Router { Route(...) }` for navigation, `.bind(@state.x)` for inputs.
//
// Nothing here enforces anything. The guard lives in the Rust engine
// (`agent_core::resolve_external`), shared by every SDK so the rule cannot
// drift per platform. These types only carry what the engine advertises, and
// `NativeEngine.dispatchExternal(_:payload:)` is the only way to act on it.

// MARK: - Decoding

/// Snake_case spellings of the two multi-word keys.
///
/// The engine emits camelCase today (`#[serde(rename_all = "camelCase")]` on
/// the structs in `agent.rs`), but it emitted `module_scope` / `element_type`
/// before that attribute landed, and the rename went out unannounced. Reading
/// either spelling costs four lines and makes the decode survive that class of
/// change: the alternative is `moduleScope` silently going nil and
/// `elementType` throwing, both of which look like an empty surface rather
/// than a wire mismatch.
private enum SnakeCodingKeys: String, CodingKey {
    case moduleScope = "module_scope"
    case elementType = "element_type"
}

// MARK: - Actions

/// One externally dispatchable action, as advertised by
/// `NativeEngine.listActions()`.
public struct AgentAction: Codable, Sendable, Equatable {
    /// Name to pass to `dispatchExternal`. For module actions this is the
    /// declared action name; for built-ins it is the external alias
    /// (`navigate`, `back`, `set_input`), never the internal one.
    public let name: String
    /// Owning module scope. `nil` for the primary module and for built-ins.
    public let module: String?
    /// True for framework-provided capabilities, false for module actions.
    public let builtin: Bool

    public init(name: String, module: String?, builtin: Bool) {
        self.name = name
        self.module = module
        self.builtin = builtin
    }
}

// MARK: - Routes

/// A declared route, as a navigation target for the `navigate` built-in.
public struct AgentRoute: Codable, Sendable, Equatable {
    /// The pattern exactly as declared (e.g. `/user-profile/:id`).
    public let path: String
    /// Names of the `:param` segments, in order. Empty for a static route.
    public let params: [String]
    /// Module scope of the enclosing `Router`, if any.
    public let moduleScope: String?

    public init(path: String, params: [String], moduleScope: String?) {
        self.path = path
        self.params = params
        self.moduleScope = moduleScope
    }

    // Spelled out rather than synthesized so `encode(to:)` stays synthesized
    // while `init(from:)` below reaches for the snake_case fallback container.
    private enum CodingKeys: String, CodingKey {
        case path, params, moduleScope
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let snake = try decoder.container(keyedBy: SnakeCodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        params = try container.decodeIfPresent([String].self, forKey: .params) ?? []
        moduleScope = try container.decodeIfPresent(String.self, forKey: .moduleScope)
            ?? snake.decodeIfPresent(String.self, forKey: .moduleScope)
    }
}

// MARK: - Bound inputs

/// One `.bind()`-declared writable input — the argument schema for `set_input`.
public struct BoundInput: Codable, Sendable, Equatable {
    /// State path the bind writes, exactly as `.bind(@state.x)` declared it.
    /// This is the value `set_input` expects in its `field` argument.
    public let path: String
    /// Prop the value lands on — `value`, `checked`, `on` or `playback`.
    /// Doubles as a type signal: `checked` / `on` mean boolean.
    public let prop: String
    /// Element type that declared the bind (`Input`, `Checkbox`, …).
    public let elementType: String
    /// Module scope of the declaring element, if any.
    public let moduleScope: String?
    /// Pattern of the enclosing `Route`, if any — which screen the field is
    /// on. The same field name under two routes is two different form fields
    /// to a caller deciding what to fill in. `nil` outside any `Route`.
    public let route: String?
    /// The field's human label, taken from a **static** `placeholder` or
    /// `label` prop and from nothing else. An interpolated placeholder yields
    /// `nil`, never its rendered value — the engine does not read state into
    /// the manifest.
    public let label: String?

    public init(
        path: String,
        prop: String,
        elementType: String,
        moduleScope: String?,
        route: String? = nil,
        label: String? = nil
    ) {
        self.path = path
        self.prop = prop
        self.elementType = elementType
        self.moduleScope = moduleScope
        self.route = route
        self.label = label
    }

    private enum CodingKeys: String, CodingKey {
        case path, prop, elementType, moduleScope, route, label
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let snake = try decoder.container(keyedBy: SnakeCodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        prop = try container.decode(String.self, forKey: .prop)
        if let camel = try container.decodeIfPresent(String.self, forKey: .elementType) {
            elementType = camel
        } else {
            elementType = try snake.decode(String.self, forKey: .elementType)
        }
        moduleScope = try container.decodeIfPresent(String.self, forKey: .moduleScope)
            ?? snake.decodeIfPresent(String.self, forKey: .moduleScope)
        route = try container.decodeIfPresent(String.self, forKey: .route)
        label = try container.decodeIfPresent(String.self, forKey: .label)
    }
}

// MARK: - Built-in names

/// The built-in external names, exactly as the engine exports them.
///
/// Decoded from `NativeEngine.builtinActionNames()` rather than assembled here,
/// so a rename on the Rust side shows up as a value change instead of a silent
/// mismatch between what an SDK dispatches and what the guard accepts.
public struct ExternalBuiltinNames: Codable, Sendable, Equatable {
    /// Navigate to a declared route. Payload: `["to": "/path"]`.
    public let navigate: String
    /// Go back in history.
    public let back: String
    /// Write a `.bind()`-declared input. Payload: `["field": path, "value": v]`.
    public let setInput: String
    /// The internal action `setInput` lowers to. Listed so a host can recognise
    /// it arriving in `processPendingActions` — never dispatchable by name.
    public let bindAction: String

    public init(navigate: String, back: String, setInput: String, bindAction: String) {
        self.navigate = navigate
        self.back = back
        self.setInput = setInput
        self.bindAction = bindAction
    }
}

/// Compile-time spellings of the built-in external names.
///
/// These are aliases, not internal action names: `navigate` lowers to
/// `router.push` and `set_input` to `__hypen_bind` — inside the engine, after
/// the guard has run. Dispatching either internal name directly is refused,
/// which is the whole point of the alias.
///
/// Constants exist because callers want them at compile time, but they are the
/// copy, not the source: `ExternalCapabilitiesTests` pins every one of them to
/// `NativeEngine.builtinActionNames()`, so an engine-side rename fails a test
/// here rather than silently desynchronising this SDK from the guard.
public enum ExternalAction {
    /// Navigate to a declared route. Payload: `["to": "/path"]`.
    /// Only offered when the app declares a `Router`.
    ///
    /// The `hypen.` prefix is load-bearing: an app is free to declare its own
    /// `.onAction("navigate")`, and an unnamespaced built-in would shadow it.
    public static let navigate = "hypen.navigate"
    /// Go back in history. Only offered when the app declares a `Router`.
    public static let back = "hypen.back"
    /// Write a `.bind()`-declared input. Payload: `["field": path, "value": v]`.
    /// Only offered when the app declares at least one `.bind()`.
    public static let setInput = "hypen.set_input"
    /// The internal bind action. Present so hosts can match it on the way out;
    /// dispatching it externally is refused.
    public static let bindAction = "__hypen_bind"
}
