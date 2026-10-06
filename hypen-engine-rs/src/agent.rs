//! The external capability surface — actions, navigation and inputs, for
//! callers that are not the rendered UI.
//!
//! # Why this exists
//!
//! [`Engine::dispatch_action`](crate::Engine::dispatch_action) reaches every
//! registered handler, because the renderer legitimately needs to: `router.push`
//! moves the app, and `__hypen_bind` is how a `.bind()` edit writes state. Both
//! are reachable by name through one flat handler map.
//!
//! That is correct for the renderer and wrong for anyone else. Until now the
//! invariant "reachable ⇔ rendered" did the guarding: an action with no node in
//! the tree could not be triggered. An external caller — MCP, REST, a CLI, a
//! test harness — is the first dispatcher that is not the tree, so that
//! invariant stops holding and the guard has to become explicit.
//!
//! # The rule
//!
//! **Nothing is externally reachable that a developer did not declare**, and
//! nothing the framework owns is reachable at all. Each surface is an allowlist
//! derived from a declaration, sitting on a reserved-name floor:
//!
//! | Capability | Declared by | Bounded by |
//! |---|---|---|
//! | Actions | `.onAction()` in module code | `action_module_map`, minus reserved names |
//! | Navigation | `Router { Route(path: …) }` | the discovered route table |
//! | Inputs | `.bind(@state.x)` | the declared `"bind"` props |
//!
//! The floor matters because `action_module_map` is filled *verbatim* from
//! module-declared name lists that nothing upstream vets — so without it, a
//! module declaring an action called `__hypen_bind` would put the arbitrary
//! state writer straight into the allowlist. See
//! [`agent_core::is_reserved_action_name`](crate::agent_core::is_reserved_action_name).
//!
//! Built-ins are namespaced (`hypen.navigate`) for the same reason in reverse:
//! `@hypen-space/core`'s own `Link` component declares `.onAction("navigate")`,
//! so a bare built-in name would collide with a real module action.
//!
//! # Naming
//!
//! The guarded entry point is `dispatch_external`, not `agent_dispatch`: a REST
//! client is not an agent, and neither is a CLI or a test harness, but they all
//! need exactly this guard. The boundary is provenance, not audience.
//!
//! # Implementation
//!
//! Every method here delegates to [`crate::agent_core`], which operates on
//! `&EngineCore` and is shared with the WASM, WASI and UniFFI bindings. Keeping
//! a second copy of the rule in this file is what a previous revision did, and
//! it silently drifted — do not reintroduce one.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::dispatch::Action;
use crate::error::EngineError;
use crate::Engine;

/// External name of the navigation tool. Maps to `router.push`.
///
/// Namespaced under `hypen.` because a bare `navigate` collides with real
/// module actions — `@hypen-space/core`'s own `Link` component declares
/// `.onAction("navigate")` and self-registers, so an unnamespaced built-in
/// would shadow it in essentially every remote session.
pub const NAVIGATE: &str = "hypen.navigate";
/// External name of the history-back tool. Maps to `router.back`.
pub const BACK: &str = "hypen.back";
/// External name of the input-setting tool. Maps to `__hypen_bind`, but only
/// after its `field` is validated against [`Engine::list_bindings`].
pub const SET_INPUT: &str = "hypen.set_input";

/// The internal action `hypen.set_input` lowers to.
///
/// Exported because it is contract surface: hosts that own their own dispatch
/// path have to register a handler under this name for `set_input` to land
/// anywhere, and were otherwise hardcoding the string.
pub const BIND_ACTION: &str = crate::agent_core::BIND_ACTION;
/// The `sender` every guarded dispatch carries. See [`crate::agent_core::EXTERNAL_SENDER`].
pub const EXTERNAL_SENDER: &str = crate::agent_core::EXTERNAL_SENDER;

/// Wire format is camelCase (`moduleScope`, `elementType`), matching what
/// every binding's docs promise. Without the rename the derive emits Rust's
/// snake_case, and `serde_wasm_bindgen` passes it straight through — so a
/// TypeScript consumer reading `moduleScope` gets `undefined` with no error
/// and a scoped binding silently looks unscoped.
///
/// One externally dispatchable action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAction {
    /// Name an external caller dispatches. For module actions this is the
    /// declared action name; for built-ins it is the external alias
    /// ([`NAVIGATE`], [`BACK`], [`SET_INPUT`]).
    pub name: String,
    /// Owning module scope. `None` for the primary module and for built-ins.
    pub module: Option<String>,
    /// True for framework-provided capabilities, false for module actions.
    pub builtin: bool,
}

/// A declared route, as a navigation target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoute {
    /// The pattern exactly as declared (e.g. `/user-profile/:id`).
    pub path: String,
    /// Names of the `:param` segments, in order. Empty for a static route.
    pub params: Vec<String>,
    /// Module scope of the enclosing `Router`, if any.
    pub module_scope: Option<String>,
}

/// One `.bind()`-declared writable input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundInput {
    /// State path the bind writes, exactly as `.bind(@state.x)` declared it.
    pub path: String,
    /// Prop the value lands on — `value`, `checked`, `on` or `playback`.
    /// Chosen by element type in `ir::expand`, and mirrored here because it is
    /// an independent signal of the field's type (`checked`/`on` are boolean)
    /// — one the guard enforces rather than merely advertises.
    pub prop: String,
    /// Element type that declared the bind (`Input`, `Checkbox`, …).
    pub element_type: String,
    /// Module scope of the declaring element, if any.
    pub module_scope: Option<String>,
    /// Pattern of the enclosing `Route`, if any. Which screen the field is on
    /// — the same field name under two routes is two different form fields to
    /// a caller deciding what to fill in.
    pub route: Option<String>,
    /// The field's human label, taken from a **static** `placeholder` or
    /// `label` prop and from nothing else. A binding or template string here
    /// would render state into the manifest, so those are never read — see
    /// `agent_core::static_label`.
    pub label: Option<String>,
}

// ── MCP manifest ───────────────────────────────────────────────────────────
//
// Composed by [`crate::agent_manifest`] from the same declaration tables the
// listings above read. A host copies these fields verbatim into an MCP
// handshake — `initialize`, `tools/list`, `resources/list` — so that five SDKs
// transport bytes and none of them hand-writes protocol prose.

/// Everything an MCP host needs to describe this app to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpManifest {
    /// MCP revision these shapes were written against. Goes in `initialize`.
    pub protocol_version: String,
    /// Prose teaching a client how this surface behaves. Identical for every
    /// Hypen app — it describes the *protocol*, never the app.
    pub instructions: String,
    /// One tool per externally dispatchable action, in listing order.
    pub tools: Vec<McpTool>,
    /// One resource per declared readable state path.
    pub resources: Vec<McpResource>,
    /// Always empty today, and the field exists so a host can pass it through
    /// `resources/templates/list` unconditionally. A template advertises a
    /// *shape* of URI, and every readable path here is finitely enumerable —
    /// so a template could only ever describe reads wider than the ones
    /// `get_state` will actually serve.
    pub resource_templates: Vec<McpResourceTemplate>,
    /// What was declared but could not be published, and why. An MCP name is
    /// `[a-zA-Z0-9_-]{1,64}` and a Hypen action name is not, so some actions
    /// have no legal spelling; dropping them silently would leave a developer
    /// staring at a tool list missing an action they can see in their own code.
    pub degraded: Vec<McpDegradation>,
}

/// One MCP tool. Mutating by construction — everything on this surface acts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// MCP-legal name. Built-ins map through a fixed table
    /// (`hypen.navigate` → `hypen_navigate`), never by character substitution
    /// — a substitution rule turns two distinct declarations into one name.
    pub name: String,
    /// Human-facing display name.
    pub title: String,
    /// What calling it does, in the terms the developer declared it.
    pub description: String,
    /// JSON Schema for the arguments. Deliberately permissive: an MCP client
    /// validates this *locally* and refuses to send a call that fails, so an
    /// over-tight schema blocks a call the engine would have accepted.
    pub input_schema: serde_json::Value,
    /// MCP behaviour hints. Hints only — the client may ignore them.
    pub annotations: McpToolAnnotations,
    /// Hypen-specific extras, namespaced per the MCP `_meta` convention.
    /// `dev.hypen/enforcement` says whether the engine actually checks this
    /// tool's schema; `dev.hypen/module` and `dev.hypen/route` say where the
    /// declaration lives.
    #[serde(rename = "_meta", skip_serializing_if = "IndexMap::is_empty", default)]
    pub meta: IndexMap<String, serde_json::Value>,
}

/// MCP's behavioural hints for one tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    /// Always false here: nothing on this surface is a read.
    pub read_only_hint: bool,
    /// True when the engine cannot say what the call does — a module action
    /// runs developer code the engine never sees. MCP's own default for this
    /// hint is `true` for exactly that reason.
    pub destructive_hint: bool,
    /// True when calling twice with the same arguments lands the app in the
    /// same place as calling once.
    pub idempotent_hint: bool,
}

/// One readable state path, as an MCP resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    /// `hypen://state/<module>/<path>`.
    pub uri: String,
    /// Stable identifier, `<module>.<path>`.
    pub name: String,
    /// Human-facing display name.
    pub title: String,
    /// What the value is.
    pub description: String,
    /// Always `application/json` — state is read back as JSON.
    pub mime_type: String,
    /// `dev.hypen/module` is the argument to pass to the engine's state read
    /// (`null` for the primary module), and `dev.hypen/statePath` the path.
    /// Carried explicitly because the URI segment is a *name* and the read
    /// takes an optional scope — the primary module is addressed by absence,
    /// which no URI segment can spell.
    #[serde(rename = "_meta", skip_serializing_if = "IndexMap::is_empty", default)]
    pub meta: IndexMap<String, serde_json::Value>,
}

/// One RFC 6570 URI template, for `resources/templates/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    /// The template, e.g. `hypen://state/{module}/{path}`.
    pub uri_template: String,
    /// Stable identifier.
    pub name: String,
    /// Human-facing display name.
    pub title: String,
    /// What the templated resources are.
    pub description: String,
    /// Always `application/json`.
    pub mime_type: String,
}

/// Something the app declares that the manifest could not publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDegradation {
    /// What was dropped — `"tool"` or `"resource"`.
    pub kind: String,
    /// The declaration's own name, exactly as the developer wrote it.
    pub name: String,
    /// Why it could not be published, in one line.
    pub reason: String,
}

impl Engine {
    /// Every action an external caller may dispatch right now.
    pub fn list_actions(&self) -> Vec<AgentAction> {
        crate::agent_core::list_actions(&self.core)
    }

    /// Every route the app declares, in declaration order.
    pub fn list_routes(&self) -> Vec<AgentRoute> {
        crate::agent_core::list_routes(&self.core)
    }

    /// Every `.bind()`-declared writable input.
    pub fn list_bindings(&self) -> Vec<BoundInput> {
        crate::agent_core::list_bindings(&self.core)
    }

    /// Dispatch an action on behalf of a caller that is not the rendered UI.
    ///
    /// Authorises through the shared guard, then delegates to
    /// [`dispatch_action`](Self::dispatch_action) — which keeps its permissive
    /// semantics for renderers, and is simply not the entry point an external
    /// transport is given.
    ///
    /// # Errors
    ///
    /// [`EngineError::ActionNotFound`] when the name is reserved, not
    /// externally dispatchable, or names an undeclared `set_input` field;
    /// [`EngineError::StateError`] when a `set_input` payload is malformed or
    /// its value contradicts the declared prop's type.
    pub fn dispatch_external(&mut self, action: Action) -> Result<(), EngineError> {
        let Action {
            name,
            payload,
            sender,
        } = action;
        // The guard verdict becomes an action in exactly one place, shared
        // with every binding, and it stamps `sender` (see
        // [`crate::agent_core::EXTERNAL_SENDER`]).
        let resolved = crate::agent_core::external_action(&self.core, &name, payload, sender)?;
        self.dispatch_action(resolved)
    }

    /// Read module state, whole or at a path.
    ///
    /// Gated to the *declared read surface*: only paths the module's template
    /// renders (harvested into `declared_state_refs` at render time) are
    /// readable, and a whole-module read is projected down to those paths.
    /// Anything else — a token the UI never shows, another module's state
    /// through the wrong scope, a state-sourced action argument — returns
    /// `None`, indistinguishable from an absent path so the surface cannot be
    /// probed.
    ///
    /// The rows of a `ForEach` are readable the same way, projected to the
    /// fields the template renders (plus any row-sourced action argument,
    /// which is substituted into the row's patches): `products` reads as every
    /// row with just those fields, `products.3` as one row, `products.3.sku`
    /// as one value, and an unrendered `products.3.internal_cost` as `None`.
    /// See [`agent_core::get_state`](crate::agent_core::get_state) and
    /// `agent_core::is_readable` for the rule, and
    /// [`agent_core::extract_state_refs`](crate::agent_core::extract_state_refs)
    /// for how rows are declared.
    pub fn get_state(&self, module: Option<&str>, path: Option<&str>) -> Option<serde_json::Value> {
        crate::agent_core::get_state(&self.core, module, path)
    }

    /// The MCP handshake for this app, composed from the same declaration
    /// tables the listings above read.
    ///
    /// Every field is meant to be copied through verbatim; a host that
    /// paraphrases it is hand-writing protocol prose again, which is the
    /// duplication this exists to remove.
    pub fn mcp_manifest(&self) -> McpManifest {
        crate::agent_manifest::mcp_manifest(&self.core)
    }

    /// Drop a module and every action it declared. **Destroy only** — see
    /// [`agent_core::unregister_module`](crate::agent_core::unregister_module).
    pub fn unregister_module(&mut self, name: &str) {
        crate::agent_core::unregister_module(&mut self.core, name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::ast_to_ir_node;
    use crate::lifecycle::{Module, ModuleInstance};
    use std::sync::{Arc, Mutex};

    /// Parse a DSL source and render it, so the engine retains a root IR.
    fn engine_with(source: &str) -> Engine {
        let mut engine = Engine::new();
        let doc = hypen_parser::parse_document(source).expect("parse");
        let component = doc.components.first().expect("has component");
        engine.render_ir_node(&ast_to_ir_node(component));
        engine
    }

    fn module(name: &str, actions: &[&str], state: serde_json::Value) -> ModuleInstance {
        let m = Module::new(name).with_actions(actions.iter().map(|a| a.to_string()).collect());
        ModuleInstance::new(m, state)
    }

    /// Register a module the way every SDK does: declare it, then install a
    /// handler for each of its actions. Declaring without installing is not a
    /// state any real SDK produces — `HypenModuleInstance.setupHandlers` runs
    /// `onAction` for every declared name immediately after `registerModule` —
    /// and the external listing only advertises what can actually dispatch.
    fn register_with_handlers(engine: &mut Engine, name: &str, actions: &[&str]) {
        engine.register_module(name, module(name, actions, serde_json::json!({})));
        for a in actions {
            let a = a.to_string();
            engine.on_action(a, move |_| {});
        }
    }

    fn set_primary_with_handlers(engine: &mut Engine, name: &str, actions: &[&str], state: serde_json::Value) {
        engine.set_module(module(name, actions, state));
        for a in actions {
            let a = a.to_string();
            engine.on_action(a, move |_| {});
        }
    }

    /// Record every action name that actually reached a handler.
    fn recording_engine(engine: &mut Engine, names: &[&str]) -> Arc<Mutex<Vec<String>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        for name in names {
            let log = log.clone();
            let name = name.to_string();
            engine.on_action(name.clone(), move |_action| {
                log.lock().unwrap().push(name.clone());
            });
        }
        log
    }

    // ── list_actions ───────────────────────────────────────────────────────

    #[test]
    fn lists_primary_and_named_module_actions_with_scope() {
        let mut engine = Engine::new();
        set_primary_with_handlers(&mut engine, "App", &["refresh"], serde_json::json!({}));
        register_with_handlers(&mut engine, "Cart", &["addToCart"]);

        let actions = engine.list_actions();
        let refresh = actions.iter().find(|a| a.name == "refresh").expect("refresh");
        let add = actions.iter().find(|a| a.name == "addToCart").expect("addToCart");

        assert_eq!(refresh.module, None, "primary module actions carry no scope");
        assert_eq!(add.module.as_deref(), Some("cart"));
        assert!(!refresh.builtin && !add.builtin);
    }

    #[test]
    fn framework_internals_are_never_listed() {
        let mut engine = engine_with(
            r#"module App { Input(placeholder: "Name").bind(@state.name) }"#,
        );
        set_primary_with_handlers(&mut engine, "App", &["submit"], serde_json::json!({"name": ""}));
        // Register the internals exactly as the SDKs do — straight on the
        // dispatcher, never through register_module.
        recording_engine(&mut engine, &["__hypen_bind", "router.push", "router.back"]);

        let names: Vec<_> = engine.list_actions().into_iter().map(|a| a.name).collect();
        assert!(!names.iter().any(|n| n == "__hypen_bind"));
        assert!(!names.iter().any(|n| n.starts_with("router.")));
        assert!(names.contains(&"submit".to_string()));
    }

    #[test]
    fn builtins_appear_only_when_their_declaration_does() {
        // No Router, no binds -> no built-ins at all.
        let plain = engine_with(r#"module App { Text("hi") }"#);
        let names: Vec<_> = plain.list_actions().into_iter().map(|a| a.name).collect();
        assert!(!names.contains(&NAVIGATE.to_string()));
        assert!(!names.contains(&BACK.to_string()));
        assert!(!names.contains(&SET_INPUT.to_string()));

        // A Router alone -> navigation, but still no set_input.
        let routed = engine_with(
            r#"module App { Router { Route(path: "/") { Text("home") } } }"#,
        );
        let names: Vec<_> = routed.list_actions().into_iter().map(|a| a.name).collect();
        assert!(names.contains(&NAVIGATE.to_string()));
        assert!(names.contains(&BACK.to_string()));
        assert!(!names.contains(&SET_INPUT.to_string()));

        // A bind alone -> set_input, but no navigation.
        let bound = engine_with(r#"module App { Input(placeholder: "n").bind(@state.name) }"#);
        let names: Vec<_> = bound.list_actions().into_iter().map(|a| a.name).collect();
        assert!(names.contains(&SET_INPUT.to_string()));
        assert!(!names.contains(&NAVIGATE.to_string()));
    }

    // ── list_routes ────────────────────────────────────────────────────────

    #[test]
    fn lists_declared_routes_with_params() {
        let engine = engine_with(
            r#"
            module App {
                Router {
                    Route(path: "/") { Text("home") }
                    Route(path: "/user/:id") { Text("user") }
                }
            }
            "#,
        );
        let routes = engine.list_routes();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].path, "/");
        assert!(routes[0].params.is_empty());
        assert_eq!(routes[1].params, vec!["id".to_string()]);
        assert_eq!(routes[1].module_scope.as_deref(), Some("app"));
    }

    #[test]
    fn routes_come_from_the_declared_table_not_the_rendered_route() {
        // Only one route can be rendered at a time; all of them must list.
        let engine = engine_with(
            r#"
            module App {
                Router {
                    Route(path: "/") { Text("home") }
                    Route(path: "/cart") { Text("cart") }
                    Route(path: "/settings") { Text("settings") }
                }
            }
            "#,
        );
        let paths: Vec<_> = engine.list_routes().into_iter().map(|r| r.path).collect();
        assert_eq!(paths, vec!["/", "/cart", "/settings"]);
    }

    // ── list_bindings ──────────────────────────────────────────────────────

    #[test]
    fn lists_binds_with_the_prop_that_types_them() {
        let engine = engine_with(
            r#"
            module App {
                Column {
                    Input(placeholder: "Name").bind(@state.name)
                    Checkbox {}.bind(@state.agreed)
                    Switch {}.bind(@state.darkMode)
                }
            }
            "#,
        );
        let binds = engine.list_bindings();
        let by_path = |p: &str| binds.iter().find(|b| b.path == p).cloned();

        assert_eq!(by_path("name").expect("name").prop, "value");
        // checked / on are the boolean-typed props — the independent type
        // signal that means we don't have to consult state to know the shape.
        assert_eq!(by_path("agreed").expect("agreed").prop, "checked");
        assert_eq!(by_path("darkMode").expect("darkMode").prop, "on");
    }

    #[test]
    fn binds_behind_an_unrendered_branch_are_still_declared() {
        // Only one branch renders at a time, but every declared field must
        // list — otherwise the writable surface churns as state flips.
        // Covered for both branch-bearing forms.
        let via_if = engine_with(
            r#"
            module App {
                If(condition: "@{state.showAdvanced}") {
                    Input(placeholder: "Bio").bind(@state.bio)
                }
            }
            "#,
        );
        let paths: Vec<_> = via_if.list_bindings().into_iter().map(|b| b.path).collect();
        assert!(paths.contains(&"bio".to_string()), "If branch; got {paths:?}");

        let via_when = engine_with(
            r#"
            module App {
                When("@{state.mode}") {
                    Case(match: "basic") { Text("nothing to fill in") }
                    Case(match: "advanced") { Input(placeholder: "Bio").bind(@state.bio) }
                }
            }
            "#,
        );
        let paths: Vec<_> = via_when.list_bindings().into_iter().map(|b| b.path).collect();
        assert!(paths.contains(&"bio".to_string()), "When/Case branch; got {paths:?}");
    }

    #[test]
    fn foreach_item_binds_do_not_lower_and_so_never_multiply() {
        // `.bind` only lowers for state / data-source bindings, so `@item.*`
        // produces no bind prop at all — rows can't explode the field list.
        let engine = engine_with(
            r#"
            module App {
                List(@state.todos, as: item) {
                    Input(placeholder: "t").bind(@item.title)
                }
            }
            "#,
        );
        assert!(
            engine.list_bindings().is_empty(),
            "item binds must not appear as writable fields"
        );
    }

    #[test]
    fn binds_carry_their_route_and_a_static_label() {
        let engine = engine_with(
            r#"
            module App {
                Router {
                    Route(path: "/settings") {
                        Column {
                            Input(placeholder: "Display name").bind(@state.name)
                            Switch(label: "Dark mode").bind(@state.darkMode)
                        }
                    }
                }
            }
            "#,
        );
        let binds = engine.list_bindings();
        let by_path = |p: &str| binds.iter().find(|b| b.path == p).cloned().expect(p);

        let name = by_path("name");
        assert_eq!(name.route.as_deref(), Some("/settings"));
        assert_eq!(name.label.as_deref(), Some("Display name"));
        // No placeholder on a Switch — `label` is the fallback.
        assert_eq!(by_path("darkMode").label.as_deref(), Some("Dark mode"));
    }

    #[test]
    fn an_interpolated_label_is_never_read() {
        // The label is a description of the form, not a window onto state:
        // reading a binding here would put the user's email in the manifest.
        let engine = engine_with(
            r#"
            module App {
                Column {
                    Input(placeholder: "@{state.user.email}").bind(@state.name)
                    Input(label: @state.secret).bind(@state.other)
                }
            }
            "#,
        );
        let binds = engine.list_bindings();
        assert_eq!(binds.len(), 2, "both fields still list: {binds:?}");
        assert!(
            binds.iter().all(|b| b.label.is_none()),
            "interpolated labels must not surface: {binds:?}"
        );
    }

    #[test]
    fn a_bind_outside_any_route_reports_no_route() {
        let engine = engine_with(
            r#"module App { Input(placeholder: "Search").bind(@state.query) }"#,
        );
        assert_eq!(engine.list_bindings()[0].route, None);
    }

    // ── dispatch_external ──────────────────────────────────────────────────

    #[test]
    fn dispatches_a_declared_module_action() {
        let mut engine = Engine::new();
        engine.set_module(module("App", &["submit"], serde_json::json!({})));
        let log = recording_engine(&mut engine, &["submit"]);

        engine.dispatch_external(Action::new("submit")).expect("dispatch");
        assert_eq!(*log.lock().unwrap(), vec!["submit".to_string()]);
    }

    #[test]
    fn refuses_hypen_bind_by_name() {
        let mut engine = engine_with(r#"module App { Input(placeholder: "n").bind(@state.name) }"#);
        let log = recording_engine(&mut engine, &["__hypen_bind"]);

        let err = engine
            .dispatch_external(
                Action::new("__hypen_bind")
                    .with_payload(serde_json::json!({"path": "secret", "value": "x"})),
            )
            .expect_err("the arbitrary-write primitive must not be externally dispatchable");
        assert!(matches!(err, EngineError::ActionNotFound(_)));
        assert!(log.lock().unwrap().is_empty(), "handler must not have run");
    }

    #[test]
    fn refuses_an_unregistered_action() {
        let mut engine = Engine::new();
        engine.set_module(module("App", &["submit"], serde_json::json!({})));
        recording_engine(&mut engine, &["submit"]);

        assert!(engine.dispatch_external(Action::new("nope")).is_err());
    }

    #[test]
    fn listing_and_dispatch_agree() {
        // The invariant the guard exists to hold: everything listed
        // dispatches, and dispatch accepts nothing that isn't listed.
        let mut engine = engine_with(
            r#"
            module App {
                Column {
                    Router { Route(path: "/") { Text("home") } }
                    Input(placeholder: "n").bind(@state.name)
                }
            }
            "#,
        );
        engine.set_module(module("App", &["submit"], serde_json::json!({"name": ""})));
        recording_engine(
            &mut engine,
            &["submit", "router.push", "router.back", "__hypen_bind"],
        );

        for action in engine.list_actions() {
            let payload = match action.name.as_str() {
                SET_INPUT => Some(serde_json::json!({"field": "name", "value": "x"})),
                NAVIGATE => Some(serde_json::json!({"to": "/"})),
                _ => None,
            };
            let mut a = Action::new(&action.name);
            a.payload = payload;
            assert!(
                engine.dispatch_external(a).is_ok(),
                "listed action '{}' must dispatch",
                action.name
            );
        }

        for hidden in ["__hypen_bind", "router.push", "router.replace", "router.forward"] {
            assert!(
                engine.dispatch_external(Action::new(hidden)).is_err(),
                "'{hidden}' must not be externally dispatchable"
            );
        }
    }

    // ── navigation built-ins ───────────────────────────────────────────────

    #[test]
    fn navigate_lowers_to_router_push_preserving_payload() {
        let mut engine = engine_with(
            r#"module App { Router { Route(path: "/cart") { Text("cart") } } }"#,
        );
        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        engine.on_action("router.push", move |action| {
            *sink.lock().unwrap() = action.payload.clone();
        });

        engine
            .dispatch_external(
                Action::new(NAVIGATE).with_payload(serde_json::json!({"to": "/cart"})),
            )
            .expect("navigate");

        assert_eq!(
            seen.lock().unwrap().clone(),
            Some(serde_json::json!({"to": "/cart"})),
            "payload must reach router.push untouched"
        );
    }

    #[test]
    fn navigate_is_refused_when_no_router_is_declared() {
        let mut engine = engine_with(r#"module App { Text("no router here") }"#);
        recording_engine(&mut engine, &["router.push"]);
        assert!(engine.dispatch_external(Action::new(NAVIGATE)).is_err());
    }

    // ── navigation bounds ──────────────────────────────────────────────────

    #[test]
    fn navigate_refuses_a_route_the_app_never_declared() {
        // The design says navigation is bounded by the declared route table.
        // The guard used to check only that the table was NON-EMPTY, leaving
        // `to` entirely free — so an app declaring /cart would happily
        // navigate to /admin.
        let mut engine = engine_with(
            r#"
            module App {
                Router {
                    Route(path: "/cart") { Text("cart") }
                    Route(path: "/order/:orderId") { Text("order") }
                }
            }
            "#,
        );
        let log = recording_engine(&mut engine, &["router.push", "router.back"]);

        for bad in ["/admin", "/", "/cart/../admin", "/order", "/order/42/edit"] {
            let err = engine
                .dispatch_external(
                    Action::new(NAVIGATE).with_payload(serde_json::json!({ "to": bad })),
                )
                .expect_err("undeclared target must be refused");
            assert!(
                matches!(err, EngineError::NotDeclared(_)),
                "{bad} gave {err:?}"
            );
        }

        // A missing or non-string `to` is a malformed call, not a route miss.
        assert!(engine.dispatch_external(Action::new(NAVIGATE)).is_err());

        assert!(log.lock().unwrap().is_empty(), "nothing may have navigated");

        // Declared pattern verbatim, a concrete path matching a :param
        // pattern, and the matcher's own slash normalisation (`cart` and
        // `/cart` are the same route to every SDK router) all land.
        for good in ["/cart", "/order/:orderId", "/order/42", "cart"] {
            engine
                .dispatch_external(
                    Action::new(NAVIGATE).with_payload(serde_json::json!({ "to": good })),
                )
                .unwrap_or_else(|e| panic!("{good} must be navigable: {e:?}"));
        }
        assert_eq!(log.lock().unwrap().len(), 4);

        // `back` takes no target and stays unaffected.
        engine.dispatch_external(Action::new(BACK)).expect("back");
    }

    #[test]
    fn a_module_cannot_declare_the_transport_spelling_of_a_builtin() {
        // MCP tool names are [a-zA-Z0-9_-], so `hypen.navigate` transports as
        // `hypen_navigate`. Reserving only the dotted form would let a module
        // own the spelling an MCP client actually calls.
        let mut engine = Engine::new();
        set_primary_with_handlers(
            &mut engine,
            "App",
            &["hypen_navigate", "hypen_set_input"],
            serde_json::json!({}),
        );

        let names: Vec<_> = engine.list_actions().into_iter().map(|a| a.name).collect();
        assert!(
            !names.iter().any(|n| n.starts_with("hypen_")),
            "reserved transport spellings must not be listed: {names:?}"
        );
        assert!(engine
            .dispatch_external(Action::new("hypen_navigate"))
            .is_err());
    }

    // ── set_input ──────────────────────────────────────────────────────────

    #[test]
    fn set_input_lowers_to_hypen_bind_for_a_declared_field() {
        let mut engine = engine_with(
            r#"module App { Input(placeholder: "Name").bind(@state.name) }"#,
        );
        // Install the module the template names, as every SDK does. Without it
        // "app" is just a named scope, and the caller would have to address the
        // field as module "app" rather than by omission.
        engine.set_module(module("App", &[], serde_json::json!({ "name": "" })));

        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        engine.on_action("__hypen_bind", move |action| {
            *sink.lock().unwrap() = action.payload.clone();
        });

        engine
            .dispatch_external(
                Action::new(SET_INPUT)
                    .with_payload(serde_json::json!({"field": "name", "value": "Ada"})),
            )
            .expect("set_input");

        assert_eq!(
            seen.lock().unwrap().clone(),
            Some(serde_json::json!({"module": null, "path": "name", "value": "Ada"})),
            "must construct exactly the payload a user typing would produce"
        );
    }

    #[test]
    fn set_input_refuses_an_undeclared_field() {
        // The whole point: set_input is not a general state writer.
        let mut engine = engine_with(
            r#"module App { Input(placeholder: "Name").bind(@state.name) }"#,
        );
        let log = recording_engine(&mut engine, &["__hypen_bind"]);

        let err = engine
            .dispatch_external(
                Action::new(SET_INPUT)
                    .with_payload(serde_json::json!({"field": "authToken", "value": "stolen"})),
            )
            .expect_err("an undeclared path must be refused");
        assert!(matches!(err, EngineError::NotDeclared(_)));
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn set_input_rejects_a_malformed_payload() {
        let mut engine = engine_with(
            r#"module App { Input(placeholder: "Name").bind(@state.name) }"#,
        );
        recording_engine(&mut engine, &["__hypen_bind"]);
        assert!(engine
            .dispatch_external(Action::new(SET_INPUT).with_payload(serde_json::json!({"nope": 1})))
            .is_err());
        assert!(engine.dispatch_external(Action::new(SET_INPUT)).is_err());
    }

    // ── get_state ──────────────────────────────────────────────────────────

    #[test]
    fn reads_only_what_the_template_renders() {
        // `total` and `user.name` are on screen; `_token` is in state but the
        // template never mentions it, so it was never shown to the user and is
        // not shown to an agent acting on their behalf either.
        let mut engine = engine_with(
            r#"
            module App {
                Column {
                    Text("Total: @{state.total}")
                    Text("@{state.user.name}")
                }
            }
            "#,
        );
        engine.set_module(module(
            "App",
            &[],
            serde_json::json!({
                "total": 4780,
                "user": { "name": "Ada" },
                "_token": "secret"
            }),
        ));

        assert_eq!(
            engine.get_state(None, Some("total")),
            Some(serde_json::json!(4780))
        );
        assert_eq!(
            engine.get_state(None, Some("user.name")),
            Some(serde_json::json!("Ada"))
        );

        assert_eq!(
            engine.get_state(None, Some("_token")),
            None,
            "a path the template never renders must not be readable"
        );

        // The whole-tree read is projected down rather than refused, so an
        // agent still gets a usable picture with the undeclared field absent.
        let whole = engine.get_state(None, None).expect("whole read");
        assert_eq!(whole.get("total"), Some(&serde_json::json!(4780)));
        assert!(
            whole.get("_token").is_none(),
            "whole-tree read leaked an undeclared field: {whole}"
        );
    }

    #[test]
    fn a_declared_parent_covers_its_children_and_back() {
        // Rendering `@{state.user}` whole puts its children on screen too.
        let mut engine = engine_with(r#"module App { Text("@{state.user}") }"#);
        engine.set_module(module(
            "App",
            &[],
            serde_json::json!({"user": {"name": "Ada", "email": "a@x.dev"}, "_token": "s"}),
        ));

        assert_eq!(
            engine.get_state(None, Some("user.email")),
            Some(serde_json::json!("a@x.dev"))
        );
        assert_eq!(engine.get_state(None, Some("_token")), None);
    }

    #[test]
    fn nothing_is_readable_before_a_render() {
        // No template, nothing declared, nothing readable — the gate fails
        // closed rather than defaulting to the whole tree.
        let mut engine = Engine::new();
        engine.set_module(module("App", &[], serde_json::json!({"_token": "secret"})));

        assert_eq!(engine.get_state(None, Some("_token")), None);
        assert_eq!(
            engine.get_state(None, None),
            Some(serde_json::json!({})),
            "an ungated whole read is the leak this exists to prevent"
        );
    }

    // ── unregister_module ──────────────────────────────────────────────────

    #[test]
    fn unregister_drops_the_module_and_its_actions_only() {
        let mut engine = Engine::new();
        set_primary_with_handlers(&mut engine, "App", &["refresh"], serde_json::json!({}));
        register_with_handlers(&mut engine, "Cart", &["addToCart"]);
        register_with_handlers(&mut engine, "Catalog", &["search"]);

        engine.unregister_module("Cart");

        let names: Vec<_> = engine.list_actions().into_iter().map(|a| a.name).collect();
        assert!(!names.contains(&"addToCart".to_string()));
        assert!(names.contains(&"search".to_string()), "siblings must survive");
        assert!(names.contains(&"refresh".to_string()), "primary must survive");
        assert_eq!(engine.get_state(Some("cart"), None), None);
        assert!(engine.get_state(Some("catalog"), None).is_some());
    }

    #[test]
    fn unregistered_actions_stop_dispatching_externally() {
        let mut engine = Engine::new();
        engine.register_module("Cart", module("Cart", &["addToCart"], serde_json::json!({})));
        let log = recording_engine(&mut engine, &["addToCart"]);

        engine.dispatch_external(Action::new("addToCart")).expect("before");
        engine.unregister_module("Cart");
        assert!(
            engine.dispatch_external(Action::new("addToCart")).is_err(),
            "a destroyed module's actions must not remain externally reachable"
        );
        assert_eq!(log.lock().unwrap().len(), 1, "handler ran once, before unregister");
    }

    #[test]
    fn unregister_is_a_noop_for_unknown_names() {
        let mut engine = Engine::new();
        register_with_handlers(&mut engine, "Cart", &["addToCart"]);
        engine.unregister_module("nosuchmodule");
        assert!(engine
            .list_actions()
            .iter()
            .any(|a| a.name == "addToCart"));
    }

    // ══ REVIEW FINDINGS ════════════════════════════════════════════════════
    // Each test below asserts the invariant this module claims to hold and
    // FAILS against the current implementation. Named `bug_*`.

    /// CRITICAL: the guard's only membership test is `action_module_map`,
    /// which is filled verbatim from each module's declared action-name list
    /// (SDK: `Array.from(this.actionHandlers.keys())`, remote: `def.actions`).
    /// A module whose list contains an internal name puts that name in the
    /// allowlist, and `dispatch_action` then reaches the framework handler
    /// registered under it — the arbitrary state writer, and the two router
    /// verbs the built-in table deliberately withholds.
    #[test]
    fn bug_a_declared_action_name_reaches_framework_internals() {
        let mut engine = engine_with(r#"module App { Text("no router, no binds") }"#);
        engine.register_module(
            "Cart",
            module(
                "Cart",
                &["__hypen_bind", "router.replace", "router.forward"],
                serde_json::json!({}),
            ),
        );
        let log = recording_engine(
            &mut engine,
            &["__hypen_bind", "router.replace", "router.forward"],
        );

        for name in ["__hypen_bind", "router.replace", "router.forward"] {
            let res = engine.dispatch_external(Action::new(name).with_payload(
                serde_json::json!({"path": "authToken", "value": "stolen", "to": "/admin"}),
            ));
            assert!(
                res.is_err(),
                "'{name}' must never be externally dispatchable, whatever a module names its actions"
            );
        }
        assert!(
            log.lock().unwrap().is_empty(),
            "framework internals ran: {:?}",
            log.lock().unwrap()
        );
    }

    /// A module action whose name matches a built-in's *concept* must keep its
    /// own identity. `@hypen-space/core`'s `Link` really does declare
    /// `.onAction("navigate")` and self-register, so before the built-ins were
    /// namespaced this collided in essentially every remote session: `navigate`
    /// was listed but dispatched to `router.push`, and with no Router it was
    /// listed yet refused.
    #[test]
    fn a_module_action_may_share_a_builtins_concept_without_colliding() {
        // (a) No Router: `navigate` is an ordinary module action. It lists and
        // it dispatches to its own handler — listing and dispatch agree.
        let mut engine = engine_with(r#"module App { Text("hi") }"#);
        engine.register_module("Link", module("Link", &["navigate"], serde_json::json!({})));
        let log = recording_engine(&mut engine, &["navigate", "router.push"]);

        assert!(engine.list_actions().iter().any(|a| a.name == "navigate"));
        assert!(!engine.list_actions().iter().any(|a| a.name == NAVIGATE));
        engine
            .dispatch_external(Action::new("navigate"))
            .expect("a listed action must dispatch");
        assert_eq!(*log.lock().unwrap(), vec!["navigate".to_string()]);

        // (b) With a Router the built-in appears too — under its namespaced
        // name, so there is no duplicate entry and no shadowing.
        let mut engine =
            engine_with(r#"module App { Router { Route(path: "/") { Text("h") } } }"#);
        engine.register_module("Link", module("Link", &["navigate"], serde_json::json!({})));
        let log2 = recording_engine(&mut engine, &["navigate", "router.push"]);

        let listed = engine.list_actions();
        assert_eq!(
            listed.iter().filter(|a| a.name == "navigate").count(),
            1,
            "a name must appear exactly once in the listing"
        );
        assert_eq!(listed.iter().filter(|a| a.name == NAVIGATE).count(), 1);

        engine.dispatch_external(Action::new("navigate")).unwrap();
        engine
            .dispatch_external(Action::new(NAVIGATE).with_payload(serde_json::json!({"to": "/"})))
            .unwrap();
        assert_eq!(
            *log2.lock().unwrap(),
            vec!["navigate".to_string(), "router.push".to_string()],
            "each name must reach its own handler"
        );
    }

    /// MEDIUM: `set_input` does no type checking. A `Checkbox`, whose `prop`
    /// is advertised as the boolean-typed `checked`, accepts an object.
    #[test]
    fn bug_set_input_ignores_the_type_it_advertises() {
        let mut engine = engine_with(r#"module App { Checkbox {}.bind(@state.agreed) }"#);
        recording_engine(&mut engine, &["__hypen_bind"]);
        assert_eq!(engine.list_bindings()[0].prop, "checked");
        assert!(
            engine
                .dispatch_external(Action::new(SET_INPUT).with_payload(
                    serde_json::json!({"field": "agreed", "value": {"role": "admin"}})
                ))
                .is_err(),
            "a boolean-typed field must not accept an arbitrary object"
        );
    }

    /// MEDIUM: `list_bindings` looks only for a static `bind` prop plus a
    /// state binding on the type's prop key — never for a `.bind()`
    /// applicator. A plain `bind:` argument on any element opens `set_input`
    /// to that path.
    #[test]
    fn bug_a_static_bind_argument_declares_a_writable_field() {
        let engine = engine_with(r#"module App { Text(bind: "authToken", value: "@{state.shown}") }"#);
        assert!(
            engine.list_bindings().is_empty(),
            "only a .bind() applicator declares a writable input, got {:?}",
            engine.list_bindings()
        );
    }

    /// Two modules may declare the same action name. The owner map records
    /// every claimant, so destroying one module cannot delete a sibling's
    /// still-live action — which a plain `name -> scope` map did, because the
    /// second registration simply overwrote the first.
    #[test]
    fn unregister_keeps_an_action_a_sibling_still_declares() {
        let mut engine = Engine::new();
        register_with_handlers(&mut engine, "Cart", &["refresh"]);
        register_with_handlers(&mut engine, "Catalog", &["refresh"]);

        engine.unregister_module("Catalog");

        assert!(
            engine.list_actions().iter().any(|a| a.name == "refresh"),
            "cart is still registered and still declares 'refresh'"
        );
        assert!(
            engine.dispatch_external(Action::new("refresh")).is_ok(),
            "and it must still dispatch"
        );

        engine.unregister_module("Cart");
        assert!(
            !engine.list_actions().iter().any(|a| a.name == "refresh"),
            "with no module left declaring it, the name goes"
        );
    }

    /// MEDIUM: `unregister_module` only removes entries whose scope matches,
    /// and the primary module's actions carry scope `None`, so the primary
    /// module can never be dropped — its actions stay listed and dispatchable
    /// and its state stays readable after destroy, under any name.
    #[test]
    fn bug_the_primary_module_cannot_be_unregistered() {
        let mut engine = Engine::new();
        engine.set_module(module(
            "App",
            &["refresh"],
            serde_json::json!({"authToken": "sekrit"}),
        ));
        recording_engine(&mut engine, &["refresh"]);

        engine.unregister_module("App");
        engine.unregister_module("");

        assert!(engine.list_actions().is_empty(), "actions survive destroy");
        assert!(engine.get_state(None, None).is_none(), "state survives destroy");
        assert!(engine.dispatch_external(Action::new("refresh")).is_err());
    }

    /// MEDIUM: `root_ir` is whatever was rendered last. `ManagedRouter` calls
    /// `renderSource(route.template)` on every navigation, so the app shell's
    /// Router and any binds outside the current route drop out of the
    /// listings — and with them the `navigate` / `set_input` capabilities.
    #[test]
    fn bug_a_later_render_erases_the_declared_surface() {
        let mut engine = engine_with(
            r#"module App { Column { Router { Route(path: "/detail") { Text("d") } } Input(placeholder: "n").bind(@state.name) } }"#,
        );
        assert_eq!(engine.list_routes().len(), 1);
        assert_eq!(engine.list_bindings().len(), 1);

        // Navigate: the SDK renders the route's own template as the new root.
        let doc = hypen_parser::parse_document(r#"component Detail { Text("detail") }"#).unwrap();
        engine.render_ir_node(&ast_to_ir_node(doc.components.first().unwrap()));

        recording_engine(&mut engine, &["router.push", "__hypen_bind"]);
        assert!(
            engine
                .dispatch_external(Action::new(NAVIGATE).with_payload(serde_json::json!({"to": "/detail"})))
                .is_ok(),
            "the app still declares a Router; navigation must not vanish on navigation"
        );
    }

    /// The documented residual of the navigation-staleness fix: keying the
    /// declaration tables by module scope alone still let two templates under
    /// the SAME scope clobber each other — and a shell and a route body
    /// written inside one `module App` are exactly that. Navigating into the
    /// route dropped the shell's search field and the paths its header
    /// renders; navigating back dropped the route's.
    #[test]
    fn two_templates_under_one_scope_each_keep_their_declarations() {
        const SHELL: &str = r#"
            module App {
                Column {
                    Text("@{state.user.name}")
                    Input(placeholder: "Search").bind(@state.query)
                    Router { Route(path: "/detail") { Text("d") } }
                }
            }
        "#;
        const BODY: &str = r#"
            module App {
                Column {
                    Text("Total: @{state.total}")
                    Input(placeholder: "Name").bind(@state.name)
                }
            }
        "#;

        fn render(engine: &mut Engine, source: &str) {
            let doc = hypen_parser::parse_document(source).expect("parse");
            engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
        }

        fn assert_both_surfaces(engine: &Engine, when: &str) {
            let paths: Vec<_> = engine.list_bindings().into_iter().map(|b| b.path).collect();
            assert!(paths.contains(&"query".to_string()), "shell field, {when}: {paths:?}");
            assert!(paths.contains(&"name".to_string()), "route field, {when}: {paths:?}");
            assert_eq!(engine.list_routes().len(), 1, "route table, {when}");
            assert_eq!(
                engine.get_state(None, Some("user.name")),
                Some(serde_json::json!("Ada")),
                "shell read surface, {when}"
            );
            assert_eq!(
                engine.get_state(None, Some("total")),
                Some(serde_json::json!(12)),
                "route read surface, {when}"
            );
            assert_eq!(
                engine.get_state(None, Some("_token")),
                None,
                "the floor holds regardless, {when}"
            );
        }

        let mut engine = Engine::new();
        engine.set_module(module(
            "App",
            &[],
            serde_json::json!({
                "user": {"name": "Ada"},
                "query": "",
                "total": 12,
                "name": "",
                "_token": "secret"
            }),
        ));

        // Mount the shell, then navigate: the SDK renders the route's own
        // template as the new root.
        render(&mut engine, SHELL);
        render(&mut engine, BODY);
        assert_both_surfaces(&engine, "after navigating in");

        // And back. Re-rendering one template replaces only its own entries.
        render(&mut engine, SHELL);
        assert_both_surfaces(&engine, "after navigating back");
    }

    /// A name enters `action_module_map` at `register_module` time, but its
    /// handler is installed separately afterwards — and for remote or
    /// declaration-only modules, never. Listing a name that cannot dispatch
    /// breaks the invariant the guard exists to hold, so the listing tracks
    /// handler installation, not declaration alone.
    #[test]
    fn a_declared_action_is_listed_only_once_its_handler_exists() {
        let mut engine = Engine::new();
        engine.register_module("Cart", module("Cart", &["addToCart"], serde_json::json!({})));

        assert!(
            !engine.list_actions().iter().any(|a| a.name == "addToCart"),
            "declared but not yet handled — must not be advertised"
        );
        assert!(
            engine.dispatch_external(Action::new("addToCart")).is_err(),
            "and must not dispatch, so listing and dispatch agree"
        );

        engine.on_action("addToCart", |_| {});

        assert!(engine.list_actions().iter().any(|a| a.name == "addToCart"));
        assert!(
            engine.dispatch_external(Action::new("addToCart")).is_ok(),
            "everything listed must dispatch"
        );
    }

    /// LOW (test blind spot, root cause in `ast_to_ir_node`): a module body
    /// with several top-level children is lowered to its FIRST child only —
    /// every sibling is dropped. `listing_and_dispatch_agree` uses exactly
    /// that shape (`Router { … }` then a bound `Input`), so its `Input` never
    /// reaches the IR, `set_input` never appears in `list_actions()`, and the
    /// loop that "dispatches everything listed" never exercises `set_input`.
    #[test]
    fn a_module_body_needs_one_root_or_siblings_are_dropped() {
        let engine = engine_with(
            r#"
            module App {
                Column {
                    Router { Route(path: "/") { Text("home") } }
                    Input(placeholder: "n").bind(@state.name)
                }
            }
            "#,
        );
        assert!(
            engine.list_actions().iter().any(|a| a.name == SET_INPUT),
            "a wrapped module body keeps every child, so the .bind() declares \
             set_input — got {:?} with bindings {:?}",
            engine.list_actions(),
            engine.list_bindings()
        );
    }
}

