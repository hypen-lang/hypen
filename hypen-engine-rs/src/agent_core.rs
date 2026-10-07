//! Shared implementation of the external capability surface.
//!
//! Every binding owns its own [`EngineCore`] rather than wrapping [`Engine`]:
//! `WasmEngine` (`wasm/js.rs`), `WasiEngine` (`wasm/wasi.rs`) and the UniFFI
//! `HypenEngine` (`uniffi/mod.rs`) each construct one directly, and each keeps
//! its own handler map. So the guard cannot live on `Engine` — put it there and
//! four of the five SDKs would either miss it or reimplement it.
//!
//! It lives here instead, as free functions over `&EngineCore`, and every
//! engine type delegates. That is what makes "one implementation, five SDKs"
//! literally true: there is exactly one copy of the rule that decides what an
//! external caller may reach, and one copy of the listing built from the same
//! sets. They cannot drift apart because they are the same code.
//!
//! See [`crate::agent`] for the design rationale.

use crate::agent::{AgentAction, AgentRoute, BoundInput, BACK, NAVIGATE, SET_INPUT};
use crate::engine_core::EngineCore;
use crate::error::EngineError;
use crate::ir::{
    walk::{walk_ir, walk_ir_ctx, WalkCtx},
    IRNode, Value,
};

/// Built-ins an external caller may reach, as `(external name, internal name)`.
///
/// Deliberately an **exact-match** table and never a `router.` prefix rule: a
/// prefix would admit whatever a future framework version registers in that
/// namespace. `router.replace` (history manipulation with no external meaning)
/// and `router.forward` are omitted.
pub(crate) const BUILTIN_ACTIONS: &[(&str, &str)] =
    &[(NAVIGATE, "router.push"), (BACK, "router.back")];

/// The internal action `set_input` lowers to. Never externally dispatchable
/// under its own name.
pub(crate) const BIND_ACTION: &str = "__hypen_bind";

/// Name prefixes an external caller may never reach, whatever the
/// `action_module_map` says.
///
/// This is the floor under the allowlist, and it is load-bearing. That map is
/// filled **verbatim** from module-declared action-name lists — in the web SDK
/// from `Array.from(this.actionHandlers.keys())`, and for every discovered
/// component from `def.actions`. Nothing upstream vets those names, so a module
/// declaring an action called `__hypen_bind` or `router.replace` would
/// otherwise put that exact name in the allowlist and reach the internal
/// handler registered under it — arbitrary state writes for the first, and for
/// the second the very verbs [`BUILTIN_ACTIONS`] deliberately withholds.
///
/// `hypen.` is reserved too, so a module cannot shadow a built-in's external
/// name and change what callers think they are invoking — and `hypen_`
/// alongside it, because transports that cannot carry a dot (MCP tool names are
/// `[a-zA-Z0-9_-]`) render `hypen.navigate` as `hypen_navigate`, and a module
/// declaring that spelling would collide there while looking unreserved here.
const RESERVED_PREFIXES: &[&str] = &["__", "router.", "hypen.", "hypen_"];

/// Whether a name belongs to the framework and so can never be dispatched by,
/// or listed to, an external caller under its own name.
pub(crate) fn is_reserved_action_name(name: &str) -> bool {
    RESERVED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// The app's own escape hatch from expose-all: an action whose name starts
/// with `_` is **private to the UI**. It dispatches from the rendered tree
/// exactly as before and is never listed to, or dispatchable by, an external
/// caller. Layered under the framework floor — `__` is the framework's,
/// a single `_` is the app's — so `.onAction("_deleteAccount")` needs no
/// SDK API in any of the five SDKs to opt out.
///
/// Shipped *with* expose-all rather than after it: a default that widens
/// reach is the kind that locks in once callers depend on it, and the
/// developers who most need this are the ones who wrote `.onAction()` for a
/// button and never imagined the network.
pub(crate) const PRIVATE_PREFIX: &str = "_";

/// Whether a name is the app's private marker (`_x`). Reserved names (`__x`)
/// also start with `_`, so this is true for them too; [`is_reserved_action_name`]
/// is the narrower question of *whose* the name is.
pub(crate) fn is_private_action_name(name: &str) -> bool {
    name.starts_with(PRIVATE_PREFIX)
}

/// Whether a name may be listed to and dispatched by an external caller at
/// all — the framework floor and the app's private marker together. Every
/// listing and every dispatch check reads this one predicate.
pub(crate) fn is_externally_hidden(name: &str) -> bool {
    is_reserved_action_name(name) || is_private_action_name(name)
}

/// The `sender` stamped on every action that arrives through the guard.
///
/// A handler can tell an agent's dispatch from a click by reading
/// `action.sender`; a click never carries this value. Provenance is stamped
/// from day one because retrofitting it after handlers exist in the wild is
/// the painful kind of change, and it is the seed of any audit trail.
pub const EXTERNAL_SENDER: &str = "external";

/// Resolve an external dispatch into the internal [`Action`] to run — the
/// one place that turns a guard verdict into an action, shared by
/// [`crate::Engine::dispatch_external`] and every binding.
///
/// Keeping the construction here (and not in each binding) is what stops a
/// binding from drifting: the bind payload's shape, the reserved bind name
/// and the `sender` stamp are decided once. A caller-supplied `sender`
/// survives so a transport can be more specific (`"external:mcp"`); an
/// absent one becomes [`EXTERNAL_SENDER`].
pub(crate) fn external_action(
    core: &EngineCore,
    name: &str,
    payload: Option<serde_json::Value>,
    sender: Option<String>,
) -> Result<crate::dispatch::Action, EngineError> {
    use crate::dispatch::Action;
    let target = resolve_external(core, name, payload.as_ref())?;
    let sender = sender.or_else(|| Some(EXTERNAL_SENDER.to_string()));
    Ok(match target {
        ExternalTarget::Named(name) => core.route_ui_action(Action {
            name,
            payload,
            sender,
        })?,
        ExternalTarget::Bind {
            module,
            path,
            value,
        } => Action {
            name: {
                let scoped = crate::action_routing::scoped_action_name(
                    module.as_deref().unwrap_or(""),
                    BIND_ACTION,
                );
                if core.registered_actions.contains(&scoped) {
                    scoped
                } else {
                    BIND_ACTION.to_string()
                }
            },
            // The payload comes from the guard, never from the caller: the
            // caller's `{field, value}` was validated against the declared
            // bind set and discarded, so `__hypen_bind` can only ever be
            // aimed where the developer already pointed it. `module` rides
            // along so a host with per-module state maps can route the write.
            payload: Some(serde_json::json!({ "module": module, "path": path, "value": value })),
            sender,
        },
    })
}

/// What an external dispatch resolves to, once the guard has accepted it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ExternalTarget {
    /// Dispatch under this internal name with the payload unchanged.
    /// Covers module actions (name unchanged) and navigation built-ins
    /// (`navigate` → `router.push`).
    Named(String),
    /// Dispatch `__hypen_bind` with this freshly built payload. Only ever
    /// produced after the field was matched against a declared `.bind()`.
    ///
    /// Carries the declaring module's scope. Reads are module-qualified
    /// (`hypen://state/beta/name`) and writes were not, so two modules each
    /// binding `name` collapsed into one writable field and a caller who read
    /// one module's value wrote the other's.
    Bind {
        module: Option<String>,
        path: String,
        value: serde_json::Value,
    },
}

/// Resolve and authorise an external dispatch.
///
/// This is the single guard. Every transport — MCP, REST, CLI, in-process —
/// reaches it, and it accepts exactly what [`list_actions`] advertises.
///
/// # Errors
///
/// [`EngineError::ActionNotFound`] when the name is not externally
/// dispatchable, when a built-in is used in an app that does not declare the
/// backing surface, or when `set_input` names an undeclared field.
/// [`EngineError::StateError`] when a `set_input` payload is malformed.
pub(crate) fn resolve_external(
    core: &EngineCore,
    name: &str,
    payload: Option<&serde_json::Value>,
) -> Result<ExternalTarget, EngineError> {
    // Order matters. Built-in names are checked BEFORE module actions so a
    // module cannot shadow `navigate` / `set_input` and thereby smuggle a
    // different meaning into a name external callers are told is a built-in.
    if name == SET_INPUT {
        return resolve_set_input(core, payload);
    }

    if let Some((_, internal)) = BUILTIN_ACTIONS.iter().find(|(ext, _)| *ext == name) {
        let routes = list_routes(core);
        // A built-in is only offered while its backing declaration exists,
        // so accepting one when it is unlisted would break the invariant
        // that listing and dispatch agree.
        if routes.is_empty() {
            return Err(EngineError::ActionNotFound(name.to_string()));
        }
        // Navigation is supposed to be *bounded by the declared route table*.
        // Checking only that the table is non-empty left `to` entirely free —
        // an external caller could navigate anywhere the app never declared,
        // which is exactly the gap the reserved-name floor closed on the action
        // side. Bound it here too.
        if name == NAVIGATE {
            check_navigate_target(&routes, payload)?;
        }
        return Ok(ExternalTarget::Named((*internal).to_string()));
    }

    // The reserved floor and the app's private marker are checked BEFORE the
    // allowlist, because the allowlist itself is populated from unvetted
    // module-declared names.
    if is_externally_hidden(name)
        || !core.action_module_map.contains_key(name)
        || !core.has_routable_handler(name)
    {
        return Err(EngineError::ActionNotFound(name.to_string()));
    }
    Ok(ExternalTarget::Named(name.to_string()))
}

/// Reject a navigation target the app never declared.
///
/// Accepts either the pattern verbatim (`/order/:orderId`) or a concrete path
/// that matches one (`/order/42`), resolved through `portable::route` — the
/// same matcher the Router IR and every SDK router already use, so a target the
/// guard admits is exactly one the router can land on.
fn check_navigate_target(
    routes: &[AgentRoute],
    payload: Option<&serde_json::Value>,
) -> Result<(), EngineError> {
    let to = payload
        .and_then(|p| p.get("to"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| {
            EngineError::StateError(format!("{NAVIGATE}: 'to' must be a string route path"))
        })?;

    let declared = routes
        .iter()
        .any(|r| r.path == to || crate::portable::route::match_path(&r.path, to).is_some());

    if declared {
        return Ok(());
    }
    Err(EngineError::NotDeclared(format!(
        "{NAVIGATE}: '{to}' is not a declared route"
    )))
}

/// Validate a `set_input` payload against the declared bind set.
///
/// The only path by which an external caller reaches `__hypen_bind`. The field
/// must match a `.bind()`-declared path exactly, so the arbitrary-write
/// primitive can only ever be aimed where the developer already pointed it.
fn resolve_set_input(
    core: &EngineCore,
    payload: Option<&serde_json::Value>,
) -> Result<ExternalTarget, EngineError> {
    let payload = payload.ok_or_else(|| {
        EngineError::StateError(format!(
            "{SET_INPUT}: payload required (expected {{field, value}})"
        ))
    })?;

    let field = payload
        .get("field")
        .and_then(|f| f.as_str())
        .ok_or_else(|| EngineError::StateError(format!("{SET_INPUT}: 'field' must be a string")))?;

    let value = payload
        .get("value")
        .cloned()
        .ok_or_else(|| EngineError::StateError(format!("{SET_INPUT}: 'value' is required")))?;

    // Which module's field. Absent means the primary module, matching
    // `get_state`, so a caller addresses a write exactly as it addressed the
    // read it is following up.
    let module = payload
        .get("module")
        .and_then(|m| m.as_str())
        .map(|m| m.to_lowercase());

    let declared = list_bindings(core);
    let Some(target) = declared
        .iter()
        .filter(|i| i.path == field)
        .find(|i| effective_scope(core, &i.module_scope) == module)
    else {
        // Distinguish "no such field" from "that field belongs to another
        // module": the second is a caller mistake worth naming, and saying so
        // reveals nothing a `list_bindings` call would not.
        let elsewhere: Vec<String> = declared
            .iter()
            .filter(|i| i.path == field)
            .filter_map(|i| effective_scope(core, &i.module_scope))
            .collect();
        return Err(EngineError::NotDeclared(if elsewhere.is_empty() {
            format!("{SET_INPUT}: no .bind() declares field '{field}'")
        } else {
            format!(
                "{SET_INPUT}: field '{field}' is declared by module(s) {elsewhere:?}, not {}",
                module.as_deref().unwrap_or("<primary>")
            )
        }));
    };

    // Enforce the type the listing advertises. `BoundInput.prop` is offered to
    // callers as an independent type signal — `checked`/`on` mean boolean — so
    // forwarding an arbitrary value would make that advertisement a lie and let
    // an external caller drop, say, an object into a field the surface just
    // described as a checkbox.
    check_value_for_prop(&target.prop, &value)?;

    Ok(ExternalTarget::Bind {
        module: effective_scope(core, &target.module_scope),
        path: field.to_string(),
        value,
    })
}

/// Normalise a declaration's scope to how a caller addresses it.
///
/// A template written `module App { … }` tags its declarations with scope
/// `"app"`, but the same module installed via `set_module` is addressed as the
/// primary slot — by omission. Without collapsing the two, every primary-module
/// field is advertised under a module name that `set_input` then refuses, and
/// `get_state` needed the same reconciliation for exactly the same reason.
pub(crate) fn effective_scope(core: &EngineCore, declared: &Option<String>) -> Option<String> {
    let primary = primary_scope(core);
    match (declared, &primary) {
        (Some(d), Some(p)) if d == p => None,
        _ => declared.clone(),
    }
}

/// The template scope the primary module answers for, if any.
///
/// Usually the two spellings agree: a template written `module App { … }` files
/// its declarations under `"app"` and the host installs a module named `App`.
/// Nothing enforces that, and the most-used SDK breaks it —
/// `hypen-web/packages/core/src/app.ts` installs an unnamed module as
/// `setModule("AnonymousModule", …)`. Then the primary module's name matches no
/// declaring scope, every path the app declared is filed against a scope whose
/// only module is the hollow placeholder the engine auto-registered at render
/// time, and the whole read surface resolves against `{}`: the manifest
/// publishes a resource per declared path and every one of them reads nothing,
/// while `degraded` — which exists to say so — stays empty.
///
/// So the primary module also answers for the one declared scope that no real
/// module was ever registered under. **One**: with two such scopes there is no
/// evidence which of them the primary module is, and guessing would put one
/// module's declared paths on another module's state — the widening
/// [`extract_state_refs`] was rewritten to prevent. Ambiguity yields `None`,
/// and those scopes are reported in `degraded` instead.
pub(crate) fn primary_scope(core: &EngineCore) -> Option<String> {
    let primary = core.module.as_ref()?.module.name.to_lowercase();

    let declared = declared_scopes(core);
    if declared.contains(&primary) {
        return Some(primary);
    }

    let mut orphans = declared.into_iter().filter(|scope| {
        !core.modules.contains_key(scope) || core.placeholder_scopes.contains(scope)
    });
    let candidate = orphans.next()?;
    orphans.next().is_none().then_some(candidate)
}

/// Every named module scope the declaration tables mention, in first-seen
/// order.
///
/// Read from the tables rather than from the live IR: they are what every other
/// derivation on this surface is keyed by, so a scope that is not in them
/// declares nothing and cannot be the scope the primary module answers for.
fn declared_scopes(core: &EngineCore) -> Vec<String> {
    let mut scopes: Vec<String> = Vec::new();
    let keys = core
        .declared_state_refs
        .keys()
        .chain(core.declared_bindings.keys())
        .chain(core.declared_routes.keys())
        .chain(core.declared_call_sites.keys());
    for (scope, _) in keys {
        if let Some(scope) = scope {
            if !scopes.contains(scope) {
                scopes.push(scope.clone());
            }
        }
    }
    scopes
}

/// The JSON shape a bound input accepts, keyed off the prop `ir::expand` chose
/// for the element type.
///
/// One table, shared by the guard's [`check_value_for_prop`] and the manifest's
/// `hypen_set_input` schema — written twice, they would eventually disagree and
/// the manifest would promise a type the guard rejects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindValueKind {
    /// `Checkbox` / `Switch` render boolean controls.
    Boolean,
    /// `Video` binds a playback struct, not a scalar.
    Object,
    /// Text-ish controls carry a scalar. Null clears the field; an object or
    /// array would replace a whole state subtree through what the caller was
    /// told is a single input.
    Scalar,
}

pub(crate) fn bind_value_kind(prop: &str) -> BindValueKind {
    match prop {
        "checked" | "on" => BindValueKind::Boolean,
        "playback" => BindValueKind::Object,
        _ => BindValueKind::Scalar,
    }
}

/// Reject a value whose shape contradicts the prop the listing advertised.
fn check_value_for_prop(prop: &str, value: &serde_json::Value) -> Result<(), EngineError> {
    let ok = match bind_value_kind(prop) {
        BindValueKind::Boolean => value.is_boolean(),
        BindValueKind::Object => value.is_object(),
        BindValueKind::Scalar => !value.is_object() && !value.is_array(),
    };

    if ok {
        return Ok(());
    }
    Err(EngineError::StateError(format!(
        "{SET_INPUT}: field declares '{prop}', which does not accept {}",
        match value {
            serde_json::Value::Object(_) => "an object",
            serde_json::Value::Array(_) => "an array",
            serde_json::Value::String(_) => "a string",
            serde_json::Value::Number(_) => "a number",
            serde_json::Value::Bool(_) => "a boolean",
            serde_json::Value::Null => "null",
        }
    )))
}

/// Every action an external caller may dispatch right now.
///
/// Module-declared actions come from `action_module_map`, which `set_module`
/// and `register_module` populate from each module's own `actions` list — so
/// framework internals, registered directly on the dispatcher, are excluded by
/// construction rather than by a denylist.
///
/// Built-ins are appended only when the app declares the backing surface, and
/// they are appended *after* module actions with a `builtin` flag so a caller
/// can tell them apart. A module action sharing a built-in's name still appears
/// here under its own entry, but [`resolve_external`] resolves that name to the
/// built-in — see the ordering note there.
pub(crate) fn list_actions(core: &EngineCore) -> Vec<AgentAction> {
    let mut actions: Vec<AgentAction> = core
        .action_module_map
        .iter()
        .filter(|(name, _)| !is_externally_hidden(name))
        // Only what can actually be dispatched: a declared name whose handler
        // was never installed would otherwise be advertised and then refused.
        .filter(|(name, _)| core.has_routable_handler(name))
        .map(|(name, owners)| AgentAction {
            name: name.clone(),
            // Last owner wins, matching which handler actually runs.
            module: owners.last().cloned().flatten(),
            builtin: false,
        })
        .collect();

    if !list_routes(core).is_empty() {
        for (external, _) in BUILTIN_ACTIONS {
            actions.push(AgentAction {
                name: (*external).to_string(),
                module: None,
                builtin: true,
            });
        }
    }

    if !list_bindings(core).is_empty() {
        actions.push(AgentAction {
            name: SET_INPUT.to_string(),
            module: None,
            builtin: true,
        });
    }

    actions
}

/// Every route the app declares, in declaration order.
///
/// Read from the retained expanded root IR, so this is the *declared* route
/// table rather than whichever route is rendered. It therefore changes when the
/// template changes, not per re-render — which is what makes it usable as a
/// tool schema, since MCP clients cache `tools/list`.
pub(crate) fn list_routes(core: &EngineCore) -> Vec<AgentRoute> {
    core.declared_routes.values().flatten().cloned().collect()
}

/// Extract every `Router { Route … }` declared in one expanded template.
///
/// Used at render time rather than at read time. Reading used to walk the whole
/// IR per call — and `list_actions` calls this *and* [`extract_bindings`], so a
/// single tool listing cost two full tree walks.
pub(crate) fn extract_routes(root: &IRNode) -> Vec<AgentRoute> {
    let mut routes = Vec::new();
    walk_ir(root, &mut |node| {
        if let IRNode::Router {
            routes: declared,
            module_scope,
            ..
        } = node
        {
            for route in declared {
                routes.push(AgentRoute {
                    path: route.path.clone(),
                    params: route_params(&route.path),
                    module_scope: module_scope.clone(),
                });
            }
        }
    });
    routes
}

/// Every `.bind()`-declared writable input.
///
/// `ir::expand` lowers `.bind(@state.x)` to two props on the element: the value
/// binding on a type-appropriate key, and `"bind"` holding the path as a static
/// string. This walks for that pair.
///
/// Only **state** binds are returned. Data-source binds write through a
/// provider rather than module state, and are filtered out by inspecting the
/// companion binding rather than by parsing the path string — which could not
/// distinguish `provider.field` from a nested state path.
///
/// Enumerated from the declared template, so a bind inside a false branch is
/// still listed: setting it writes state the UI is not currently showing, which
/// is idempotent and exactly what would happen were the branch visible. The
/// alternative churns the field list on every re-render.
pub(crate) fn list_bindings(core: &EngineCore) -> Vec<BoundInput> {
    core.declared_bindings.values().flatten().cloned().collect()
}

/// Extract every state path the template actually references.
///
/// This is the read surface, derived the same way every other surface is: from
/// what the developer wrote. A path the UI binds to is already on the user's
/// screen, so showing it to an agent acting on that user's behalf reveals
/// nothing new. A path the template never mentions — an auth token, a cached
/// credential, an internal cursor — was never shown, and stays unreadable.
///
/// Collects from every `Value::Binding` and from the bindings inside template
/// strings, so `Text("Total: @{state.total}")` counts as much as a direct bind.
///
/// # Rows
///
/// A `ForEach` puts its rows on screen, but only the fields its template
/// renders. Declaring the collection itself (`products`) would hand over every
/// field of every row — `internal_cost` beside the `title` the user sees — so
/// the loop's source is never declared. What is declared is each row binding
/// under it, folded into the collection with `*` standing for "each row":
/// `@{product.title}` under `List(@state.products, as: product)` is
/// `products.*.title`, and a loop nested in the rows compounds it —
/// `@{v.size}` under `List(@product.variants, as: v)` is
/// `products.*.variants.*.size`. The bare row, `@{item}`, is `products.*`: the
/// whole row ships, so the whole row is readable. Resolution of the row name
/// and of the collection path is [`WalkCtx`]'s (`state_path`), which mirrors
/// how the reconciler substitutes rows — so a custom `as:` name and the
/// reserved `item` produce the same paths.
///
/// A loop over a data source, or a row reference under one, has no state path
/// and declares nothing: `*` only ever extends a **state** collection, so a
/// row can never surface as a top-level path of its own.
///
/// The read side ([`get_state`], via [`crate::portable::path::path_project`])
/// resolves `*` against the live array: `products` reads as every row
/// projected to its rendered fields, and `products.3.sku` — the aiming
/// primitive for a per-row action — is served because `products.*.sku`
/// covers it.
pub(crate) fn extract_state_refs(root: &IRNode) -> Vec<(Option<String>, String)> {
    fn note(
        scope: &Option<String>,
        value: &Value,
        ctx: &WalkCtx,
        out: &mut Vec<(Option<String>, String)>,
    ) {
        match value {
            Value::Binding(b) => {
                if b.is_state()
                    || ctx
                        .frame_for(b)
                        .is_some_and(|frame| &frame.module_scope == scope)
                {
                    out.extend(ctx.state_path(b).map(|p| (scope.clone(), p)));
                }
            }
            Value::TemplateString { template, bindings } => {
                for b in bindings {
                    // Dependency extraction also finds identifier-looking
                    // quoted text. Only direct interpolations grant row reads.
                    let row = ctx
                        .frame_for(b)
                        .is_some_and(|frame| &frame.module_scope == scope)
                        && template
                            .split("@{")
                            .skip(1)
                            .filter_map(|part| part.split_once('}'))
                            .any(|(expression, _)| expression.trim() == b.full_path_with_source());
                    if b.is_state() || row {
                        out.extend(ctx.state_path(b).map(|p| (scope.clone(), p)));
                    }
                }
            }
            // Always a state path: `.states` lowering takes its driving path
            // from a binding it checks `is_state()` on (`ir::anim::collect_states`),
            // so a row-derived path cannot reach here.
            Value::StateSwitch { path, .. } => out.push((scope.clone(), path.clone())),
            _ => {}
        }
    }

    let mut refs = Vec::new();
    walk_ir_ctx(root, &mut |node, ctx| match node {
        IRNode::Element(element) => {
            // Scope comes from the node that owns the binding, never from the
            // template as a whole. Taking the template's first scope filed
            // every path against whichever module happened to appear first —
            // so composing two module-backed components on one screen, the
            // ordinary shape of a dashboard, made the second module's paths
            // readable in the FIRST module's state, where the same field name
            // can hold something the first module never rendered.
            let scope = &element.module_scope;
            let arg_keys = action_argument_keys(&element.props);
            let public_prefixes: Vec<&str> = element
                .props
                .iter()
                .filter_map(|(key, value)| match value {
                    Value::Action(name) if !is_externally_hidden(name) => key.strip_suffix(".0"),
                    _ => None,
                })
                .collect();
            for (key, value) in element.props.iter() {
                // Action-argument props are NOT rendered — they are handed to a
                // handler. The whole justification for this read surface is
                // that a path the UI *displays* is already on the user's
                // screen, and an argument fails that test:
                // `.onClick(@actions.sync, key: @state.apiKey)` shows the key
                // to nobody.
                //
                // A **row** argument is the exception, and a deliberate one:
                // `.onClick(@actions.addToCart, sku: @item.sku)` is the only
                // place the template says what a per-row action needs, and the
                // value is substituted into the row's `Create` patch on its way
                // to the renderer (dispatch is renderer-side), so it is on the
                // wire whether or not any pixel shows it. Declaring it never
                // exceeds what the client already holds, and without it the
                // action is advertised with no legal value to aim it with.
                // See [`action_argument_keys`] for the rule as a whole.
                if arg_keys.contains(key.as_str())
                    && (!is_row_sourced(value, ctx)
                        || !public_prefixes.iter().any(|prefix| {
                            key.strip_prefix(*prefix)
                                .is_some_and(|rest| rest.starts_with('.'))
                        }))
                {
                    continue;
                }
                note(scope, value, ctx, &mut refs);
            }
        }
        // A branch-steering value is made readable although only the chosen
        // branch's *contents* reach the screen, not the value itself — the
        // user sees "loading" or the list, never the string `"loading"`. This
        // is a scalar-sized over-grant relative to the wire, tolerated on
        // purpose: the value is what the developer wrote the screen around,
        // and which branch rendered already reveals it up to the granularity
        // of the cases.
        IRNode::Conditional {
            value,
            module_scope,
            ..
        } => note(module_scope, value, ctx, &mut refs),
        // A Router's location binding is synthesized by `ir::expand` when the
        // DSL omits one, so treating it as a declaration would publish
        // `state.location` for an app whose developer never wrote it. The route
        // table already tells an agent where it can go.
        IRNode::Router { .. } => {}
        // The source itself is consumed by the loop, never rendered, and never
        // declared — the rows' rendered fields are, one `*` path each, as the
        // walk descends into the template (see the doc above). The container's
        // own props are rendered like any element's.
        //
        // `key_path` is not declared either: the key names the row for the
        // reconciler, and reconciliation keys never appear in a patch, so
        // declaring it would be the one row field on this surface the client
        // does not already hold.
        IRNode::ForEach {
            props,
            module_scope,
            ..
        } => {
            let arg_keys = action_argument_keys(props);
            for (key, value) in props.iter() {
                // Container event payloads obey the same read boundary as
                // ordinary elements; only public row targets are readable.
                if arg_keys.contains(key.as_str()) {
                    let public = props.iter().any(|(action_key, action)| {
                        matches!(action, Value::Action(name) if !is_externally_hidden(name))
                            && action_key.strip_suffix(".0").is_some_and(|prefix| {
                                key.strip_prefix(prefix)
                                    .is_some_and(|rest| rest.starts_with('.'))
                            })
                    });
                    if !public || !is_row_sourced(value, ctx) {
                        continue;
                    }
                }
                note(module_scope, value, ctx, &mut refs);
            }
        }
    });
    refs.sort();
    refs.dedup();
    refs
}

/// Whether a prop value is filled in from the current row — a `Value::Binding`
/// resolving through an enclosing `ForEach` frame, or a template string whose
/// every binding does.
fn is_row_sourced(value: &Value, ctx: &WalkCtx) -> bool {
    match value {
        Value::Binding(b) => ctx.frame_for(b).is_some(),
        Value::TemplateString { bindings, .. } => {
            !bindings.is_empty() && bindings.iter().all(|b| ctx.frame_for(b).is_some())
        }
        _ => false,
    }
}

/// Prop keys on this element that carry an action's arguments rather than
/// rendered content.
///
/// Mirrors the lowering in `ir::expand`: an applicator lands as `<prefix>.0`
/// holding the `Value::Action`, with its named arguments on sibling
/// `<prefix>.<key>` props; the positional bare form lands on `action`.
///
/// # What the read surface does with them
///
/// The rule is asymmetric by source, and the asymmetry is the wire:
///
/// * A **state**-sourced argument (`key: @state.apiKey`) is excluded. It is
///   not displayed, and the read surface exists to mirror what is displayed.
/// * A **row**-sourced argument (`sku: @item.sku`) is included, as
///   `<collection>.*.sku`. Row substitution resolves it into the row's
///   `Create` patch before the renderer ever sees the element, so the client
///   holds every row's value already; declaring it grants nothing new and is
///   what lets an agent aim the per-row action at a row it can name.
///
/// (Strictly, a state-sourced argument reaches the renderer the same way. The
/// exclusion is kept because the developer's intent for `@state.apiKey` in an
/// argument slot is a handler input, not a display — the conservative reading
/// of an ambiguous declaration.)
fn action_argument_keys(props: &crate::ir::node::PropsMap) -> std::collections::HashSet<&str> {
    let mut prefixes: Vec<&str> = Vec::new();
    let mut keys: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for (key, value) in props.iter() {
        if !matches!(value, Value::Action(_)) {
            continue;
        }
        keys.insert(key.as_str());
        if let Some(prefix) = key.strip_suffix(".0") {
            prefixes.push(prefix);
        }
    }

    for (key, _) in props.iter() {
        if prefixes
            .iter()
            .any(|p| key.strip_prefix(*p).is_some_and(|r| r.starts_with('.')))
        {
            keys.insert(key.as_str());
        }
    }
    keys
}

/// Extract every `.bind()`-declared writable input in one expanded template.
///
/// `ir::expand` lowers `.bind(@state.x)` to two props on the element: the value
/// binding on a type-appropriate key, and `"bind"` holding the path as a static
/// string. This walks for that pair.
///
/// Only **state** binds are returned. Data-source binds write through a
/// provider rather than module state, and are filtered out by inspecting the
/// companion binding rather than by parsing the path string — which could not
/// distinguish `provider.field` from a nested state path.
pub(crate) fn extract_bindings(root: &IRNode) -> Vec<BoundInput> {
    let mut inputs = Vec::new();
    walk_ir_ctx(root, &mut |node, ctx| {
        let IRNode::Element(element) = node else {
            return;
        };
        // `__bind`, not `bind`: only the `.bind()` applicator sets the reserved
        // twin, so a plain `bind:` argument cannot declare a writable field.
        let Some(Value::Static(serde_json::Value::String(path))) = element.props.get("__bind")
        else {
            return;
        };

        // The companion binding decides whether this is a state bind: a
        // data-source bind stores `provider.path` here, indistinguishable
        // from a nested state path by inspection alone.
        let prop = bind_prop_for(&element.element_type);
        let is_state = matches!(
            element.props.get(prop),
            Some(Value::Binding(binding)) if binding.is_state()
        );
        if !is_state {
            return;
        }

        inputs.push(BoundInput {
            path: path.clone(),
            prop: prop.to_string(),
            element_type: element.element_type.clone(),
            module_scope: element.module_scope.clone(),
            route: ctx.route.clone(),
            label: static_label(element),
        });
    });
    inputs
}

/// The field's human label, if the developer wrote one as a literal.
///
/// Static **only**, and deliberately so: a `Binding` or `TemplateString` here
/// would render state into the manifest, so a template writing
/// `Input(label: "@{state.user.email}")` would leak an address through what is
/// meant to be a description of the form. The label is a nicety; the leak is
/// permanent, so the nicety loses.
///
/// `placeholder` before `label` because that is the order of specificity for
/// the controls that carry both — a placeholder names *this* field, a label may
/// name the group. Each is read in its argument spelling (`label: "…"`) and its
/// applicator spelling (`.label("…")` → `label.0`), which are the same
/// declaration written two ways.
fn static_label(element: &crate::ir::Element) -> Option<String> {
    ["placeholder", "label"]
        .iter()
        .flat_map(|name| [(*name).to_string(), format!("{name}.0")])
        .find_map(|key| match element.props.get(&key) {
            Some(Value::Static(serde_json::Value::String(text))) => Some(text.clone()),
            _ => None,
        })
}

/// Where one argument of an action call comes from.
///
/// The point of the distinction is what an external caller can do with it. A
/// static is the value the developer fixed and the caller must send back
/// unchanged; a state path is a value the caller can read for itself through
/// the declared read surface; an item field is read the same way, but from
/// one row of the collection the call site's [`CallSite::rows`] names — which
/// row is the caller's choice, and the argument is how it says so.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ArgSource {
    /// A literal written at the call site.
    Static(serde_json::Value),
    /// Read from module state at this path when the handler fires.
    State(String),
    /// A field of the current row, by its path inside the row. Only ever
    /// inside a `ForEach`.
    Item(String),
}

/// One place the template invokes an action, with the arguments it passes.
///
/// This is what turns a bare action name into something callable: `list_actions`
/// says `addToCart` exists, and only the call sites say it takes a `sku`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CallSite {
    /// Declared action name, exactly as `@actions.<name>` wrote it.
    pub action: String,
    /// Pattern of the enclosing `Route`, if any — which screen this call
    /// belongs to.
    pub route: Option<String>,
    /// Element the call hangs off (`Button`, `Text`, …).
    pub element_type: String,
    /// True when the call site sits inside a `ForEach` template, i.e. it is one
    /// call *per row*.
    pub in_for_each: bool,
    /// The state path of the collection whose rows the call is declared over,
    /// when it is one (`products`, or `products.*.variants` for a nested
    /// loop). This is where a caller reads the legal values for the call's
    /// [`ArgSource::Item`] arguments. `None` outside a loop, and for a loop
    /// over something other than module state.
    pub rows: Option<String>,
    /// Named arguments, in the order the template wrote them. Positional
    /// arguments after the action itself appear under their index.
    pub args: indexmap::IndexMap<String, ArgSource>,
}

/// Extract every action invocation the template declares.
///
/// `ir::expand` lowers an action to a `Value::Action` prop in one of two
/// shapes, and both occur in real templates:
///
/// * the applicator form, `.onClick(@actions.addToCart, sku: @item.sku)`, puts
///   the action on `"onClick.0"` and each argument on a sibling key under the
///   same `"onClick."` prefix;
/// * the bare form, `Button(onClick: @actions.submit)` or the positional
///   `Button(@actions.submit)`, puts the action directly on `"onClick"` /
///   `"action"` and carries no arguments at all.
///
/// Reserved names are skipped, on the same reasoning as everywhere else on this
/// surface: `@router.push` lowers to a `Value::Action("router.push")` that is
/// indistinguishable here from a module action, and navigation is bounded by
/// the declared route table rather than by whoever wrote a call site.
pub(crate) fn extract_call_sites(root: &IRNode) -> Vec<CallSite> {
    let mut sites = Vec::new();
    walk_ir_ctx(root, &mut |node, ctx| {
        let IRNode::Element(element) = node else {
            return;
        };
        for (key, value) in element.props.iter() {
            let Value::Action(action) = value else {
                continue;
            };
            if is_reserved_action_name(action) {
                continue;
            }
            sites.push(CallSite {
                action: action.clone(),
                route: ctx.route.clone(),
                element_type: element.element_type.clone(),
                in_for_each: ctx.in_for_each(),
                rows: ctx.frames.last().and_then(|f| f.collection.clone()),
                // Only the applicator form has a prefix to collect siblings
                // under; a bare `onClick` prop has no dot and so no arguments.
                args: match key.rsplit_once('.') {
                    Some((prefix, _)) => call_args(element, prefix, key, ctx),
                    None => indexmap::IndexMap::new(),
                },
            });
        }
    });
    sites
}

/// The applicator's own named `animate:` argument.
///
/// A transaction-animation stamp, not an argument: the renderer lifts it out of
/// the applicator's argument object into `Action.animate` and it "must never
/// reach a module handler's payload" (`extractActionDetails`,
/// `hypen-web/packages/web/src/dom/applicators/events.ts`). Publishing it would
/// describe a parameter no call can carry. Only this named position is
/// reserved — an `animate` key *inside* a positional payload object is user
/// data, and the flattening below passes it through exactly as the renderer
/// does.
const ANIMATE_ARG: &str = "animate";

/// Collect the argument props sitting alongside an action under one applicator
/// prefix, skipping the action's own key.
///
/// The names here have to be the names the *handler* receives, not the keys the
/// IR happens to hold, because this is what the manifest publishes as the
/// action's callable signature. The renderer that builds the real dispatch
/// payload (`extractActionDetails`) does two things to those keys, and both are
/// mirrored here or the schema describes a payload no call site in the app has
/// ever produced: the reserved `animate:` stamp is dropped, and a positional
/// object argument — `.onClick(@actions.foo, { id: "123" })`, which lowers to
/// the indexed prop `onClick.1` — is *flattened* into the payload, so its keys
/// are the arguments and the index is not an argument name at all.
///
/// A row argument is recognised through the walk context rather than by
/// `Binding::is_item()` alone: under `as: product`, `@product.sku` lowers to a
/// data-source-shaped binding named after the row (see `WalkCtx::frame_for`),
/// and gating on `is_item()` would name the argument for the reserved `item`
/// spelling and drop it for every other — the same call site, described or
/// not, depending on a name the caller never sees. The quoted spelling
/// `"@{product.sku}"` — a template string that is one whole row reference — is
/// the same argument again and is reported the same way.
///
/// A value with no single source an external caller could supply — an
/// interpolation mixing text and bindings, a nested action — is dropped rather
/// than named, because naming it would describe an argument nobody can fill.
fn call_args(
    element: &crate::ir::Element,
    prefix: &str,
    action_key: &str,
    ctx: &WalkCtx,
) -> indexmap::IndexMap<String, ArgSource> {
    let mut args = indexmap::IndexMap::new();
    for (key, value) in element.props.iter() {
        if key == action_key {
            continue;
        }
        let Some(name) = key
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('.'))
        else {
            continue;
        };
        if name == ANIMATE_ARG {
            continue;
        }

        // A positional object is spread into the payload by the renderer. Its
        // fields are literals written at the call site, so each is reported the
        // same way a named literal argument is. Arrays are excluded here for
        // the same reason the renderer excludes them: they are not spread.
        if is_positional(name) {
            if let Value::Static(serde_json::Value::Object(fields)) = value {
                for (field, literal) in fields {
                    args.insert(field.clone(), ArgSource::Static(literal.clone()));
                }
                continue;
            }
        }

        let source = match value {
            Value::Static(literal) => ArgSource::Static(literal.clone()),
            Value::Binding(binding) if binding.is_state() => ArgSource::State(binding.full_path()),
            Value::Binding(binding) if ctx.frame_for(binding).is_some() => {
                ArgSource::Item(binding.full_path())
            }
            Value::TemplateString { template, bindings } => match bindings.as_slice() {
                [binding]
                    if ctx.frame_for(binding).is_some()
                        && template.trim() == whole_reference(binding) =>
                {
                    ArgSource::Item(binding.full_path())
                }
                _ => continue,
            },
            _ => continue,
        };
        args.insert(name.to_string(), source);
    }
    args
}

/// The `@{…}` text a binding was written as, for telling a template string
/// that *is* one reference apart from one that merely contains it.
fn whole_reference(binding: &crate::reactive::Binding) -> String {
    format!("@{{{}}}", binding.full_path_with_source())
}

/// Whether an argument name is a positional index rather than a written name.
///
/// Matches the renderer's `/^\d+$/` exactly. A positional argument that is not
/// an object does arrive under its index, so only the object case is rewritten.
fn is_positional(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())
}

/// Read module state, whole or at a path.
///
/// `module` is `None` for the primary module (installed via `set_module`) or
/// the name of one registered via `register_module`, matched case-insensitively
/// to mirror that call's lowercasing.
///
/// Returns `None` when the module is unknown *or* the path is absent —
/// deliberately not distinguished, so a caller cannot probe for the existence
/// of state it is not being shown.
pub(crate) fn get_state(
    core: &EngineCore,
    module: Option<&str>,
    path: Option<&str>,
) -> Option<serde_json::Value> {
    // The primary module is addressed by the *absence* of a scope, but it also
    // has an installed name, and that name is what the manifest puts in its
    // resource URIs (`hypen://state/shop/cartCount`) because a URI segment
    // cannot spell absence. Accept the name as an alias for the primary slot
    // so a published URI is a working read address. A named module of the
    // same name still wins — that is the existing precedence.
    // Resolution mirrors `agent_manifest::state_address`, which is what
    // minted the URI: the name is the primary's if it is the scope the
    // primary answers for (`primary_scope`) or its installed name, and no
    // *real* named module (a placeholder scope is not one) claims it.
    let module = match module {
        Some(name) => {
            let lower = name.to_lowercase();
            let real_named =
                core.modules.contains_key(&lower) && !core.placeholder_scopes.contains(&lower);
            let is_primary = primary_scope(core).as_deref() == Some(lower.as_str())
                || core
                    .module
                    .as_ref()
                    .is_some_and(|m| m.module.name.eq_ignore_ascii_case(name));
            if !real_named && is_primary {
                None
            } else {
                Some(name)
            }
        }
        None => None,
    };
    let scope = module.map(|m| m.to_lowercase());
    let state = match module {
        None => core.module.as_ref().map(|m| m.get_state())?,
        Some(name) => core.modules.get(&name.to_lowercase())?.get_state(),
    };

    // A template written as `module App { … }` declares its refs under scope
    // "app", but the same module installed via `set_module` is read back as the
    // primary slot (`None`). Look under both, or every primary-module read
    // finds nothing declared.
    // Unioned across every template that rendered under the scope, not just
    // the last one: a shell and the route inside it are separate templates
    // and both are on screen.
    // Not the primary module's installed *name*: the scope it answers for,
    // which is the same thing only when the host happened to name the module
    // the way the template spelled its `module X { }` wrapper. See
    // [`primary_scope`].
    let primary = scope.is_none().then(|| primary_scope(core)).flatten();
    let readable: Vec<&String> = core
        .declared_state_refs
        .iter()
        .filter(|((s, _), _)| *s == scope || (s.is_some() && *s == primary))
        .flat_map(|(_, refs)| refs.iter())
        .collect();

    match path {
        // A whole-tree read is the leak: it hands over every field the module
        // holds, declared or not. Project it down to the declared paths instead
        // of refusing outright — an agent still gets a usable picture, and a
        // token the template never renders is simply absent.
        None => Some(project(state, &readable)),
        Some(p) => {
            // Exactly declared, or covered by a declared ancestor: serve it.
            if is_readable(state, &readable, p) {
                return crate::portable::path::path_get(state, p);
            }
            // An ancestor of declared paths: serve the declared descendants
            // rather than the whole object. Refusing outright would be safe but
            // unhelpful, and handing over the object would serve siblings the
            // template never rendered.
            //
            // "Ancestor" is segment-wise, so `products` and `products.3` are
            // both ancestors of `products.*.sku`. The declared path is
            // narrowed to the request first — `products.3.sku` — and projected
            // from there, so a whole-collection read returns every row and an
            // indexed read only the row asked for, each projected to its
            // rendered fields; an index past the end projects nothing and
            // reads as `None`, the same answer as a refusal.
            let below: Vec<String> = readable
                .iter()
                .filter(|d| row_indices_are_arrays(state, d, p))
                .filter_map(|d| narrow_to(d, p))
                .collect();
            if below.is_empty() {
                return None;
            }
            let below: Vec<&String> = below.iter().collect();
            let projected = project(state, &below);
            crate::portable::path::path_get(&projected, p)
        }
    }
}

/// Whether `path` is covered by the declared read surface.
///
/// A declared parent covers its children — rendering `@{state.user}` whole puts
/// its fields on screen — but **not** the reverse. Declaring `user.name` must
/// not make `user` readable: handing over the parent object would serve
/// `user.email` and every other sibling the template never rendered. The
/// earlier reasoning here ("a caller could reconstruct it path by path anyway")
/// was simply wrong, because a caller can only reconstruct the leaves that are
/// themselves declared.
///
/// A declared `*` segment covers exactly one **numeric** segment of the request
/// — `products.*.sku` covers `products.3.sku` and everything under it, never
/// `products.foo.sku` — because the wildcard was minted for the rows of an
/// array and nothing else. A `*` in the *request* matches only a literal `*`
/// in the declaration, and no array has such an index, so it reads as nothing.
fn is_readable(state: &serde_json::Value, declared: &[&String], path: &str) -> bool {
    declared
        .iter()
        .any(|d| covers(d, path) && row_indices_are_arrays(state, d, path))
}

/// A numeric object key is not a row index. Check live containers before
/// replacing a wildcard with an index, including after state changes type.
fn row_indices_are_arrays(state: &serde_json::Value, declared: &str, path: &str) -> bool {
    if !declared.split('.').any(|part| part == "*") {
        return true;
    }
    let mut current = state;
    for (pattern, requested) in declared.split('.').zip(path.split('.')) {
        if !segment_matches(pattern, requested) {
            return false;
        }
        if pattern == "*" && !current.is_array() {
            return false;
        }
        let next = match current {
            serde_json::Value::Array(items) => {
                requested.parse::<usize>().ok().and_then(|i| items.get(i))
            }
            serde_json::Value::Object(fields) => fields.get(requested),
            _ => None,
        };
        let Some(value) = next else {
            return false;
        };
        current = value;
    }
    true
}

/// Segment-wise "declared covers requested": every declared segment matches
/// the request's segment at the same position, and the request may go deeper.
fn covers(declared: &str, path: &str) -> bool {
    let mut requested = path.split('.');
    declared
        .split('.')
        .all(|d| requested.next().is_some_and(|p| segment_matches(d, p)))
}

/// Whether one declared segment admits one requested segment.
fn segment_matches(declared: &str, requested: &str) -> bool {
    declared == requested
        || (declared == "*"
            && !requested.is_empty()
            && requested.bytes().all(|b| b.is_ascii_digit()))
}

/// When `path` is a strict ancestor of `declared` — the request stops short of
/// the declaration, matching segment for segment on the way — the declaration
/// with the request's concrete segments substituted in: `products.*.sku`
/// narrowed to `products.3` is `products.3.sku`. `None` otherwise.
fn narrow_to(declared: &str, path: &str) -> Option<String> {
    let requested: Vec<&str> = path.split('.').collect();
    let rest: Vec<&str> = declared.split('.').collect();
    if rest.len() <= requested.len() {
        return None;
    }
    let (head, tail) = rest.split_at(requested.len());
    if !head
        .iter()
        .zip(&requested)
        .all(|(d, p)| segment_matches(d, p))
    {
        return None;
    }
    let mut narrowed = requested;
    narrowed.extend_from_slice(tail);
    Some(narrowed.join("."))
}

/// Build a new object containing only the declared paths.
///
/// `*` in a declared path fans out over the rows of the array it names, so the
/// result holds every row projected to its declared fields — see
/// [`crate::portable::path::path_project`] for the exact shape.
fn project(state: &serde_json::Value, declared: &[&String]) -> serde_json::Value {
    let mut out = serde_json::Value::Object(serde_json::Map::new());
    for path in declared {
        crate::portable::path::path_project(state, path, &mut out);
    }
    out
}

/// Drop a module and every action it declared.
///
/// **Call this on destroy only.** The engine's registry is otherwise
/// append-only by design, and that retention is load-bearing: under the default
/// `persist: true`, `ManagedRouter` keeps an off-screen module registered
/// precisely so siblings can still read its state. Calling this on unmount
/// would break the persist cache and cross-module reads.
///
/// Mirrors the eviction `register_module` performs when a scope is
/// re-registered. Unknown names are a no-op.
pub(crate) fn unregister_module(core: &mut EngineCore, name: &str) {
    let name = name.to_lowercase();

    // The primary slot (installed via `set_module`) records its actions with
    // scope `None`, so a scope-match alone can never reach it — and four of the
    // five SDKs put the app's main module exactly there. Match it by name and
    // clear the slot too, otherwise "drop a module and every action it
    // declared" is simply untrue for the most common case: after destroy the
    // actions stayed listed, stayed dispatchable, and `get_state(None, None)`
    // still returned the whole tree.
    let is_primary = core
        .module
        .as_ref()
        .is_some_and(|m| m.module.name.to_lowercase() == name);

    // Which declaring scopes die with this module. Its own name always — and,
    // for the primary slot, `None` as well: a template written without a
    // `module X { … }` wrapper, which is the documented shape for the
    // declarative half of the language, files every route, bind, call site and
    // state ref under `None`, and every one of them resolves against the
    // primary module's state. Retaining on the name alone left that whole
    // framework surface live after destroy — `hypen.navigate` still dispatched
    // into a module that no longer existed and `hypen.set_input` still reached
    // `__hypen_bind` — while `degraded` reported no module installed.
    // [`primary_scope`] covers the third spelling: the scope the primary
    // answers for when the host named the module something else.
    let mut owned = vec![Some(name.clone())];
    if is_primary {
        owned.push(None);
        let answers_for = primary_scope(core).map(Some);
        if let Some(scope) = answers_for {
            if !owned.contains(&scope) {
                owned.push(scope);
            }
        }
    }

    core.registered_actions.retain(|action| {
        !crate::action_routing::split_scoped_action(action).is_some_and(|(scope, _)| {
            owned.contains(&if scope.is_empty() {
                None
            } else {
                Some(scope.to_string())
            })
        })
    });

    // Drop the scopes' declared routes and inputs too, so a destroyed module
    // stops advertising navigation targets and writable fields. Every template
    // that declared under a scope goes, not just the last-rendered one — the
    // module is gone, so none of them can still be on screen.
    core.declared_routes.retain(|(s, _), _| !owned.contains(s));
    core.declared_bindings
        .retain(|(s, _), _| !owned.contains(s));
    core.declared_call_sites
        .retain(|(s, _), _| !owned.contains(s));
    core.declared_state_refs
        .retain(|(s, _), _| !owned.contains(s));

    // In-flight `.exit` completions owed to a destroyed module die with it
    // (a later module re-registered under the same name must not get them).
    core.tree
        .retain_exit_tombstones(|t| !owned.contains(&t.scope));

    if is_primary {
        core.evict_action_scope(&None);
        core.module = None;
    }

    core.evict_action_scope(&Some(name.clone()));
    core.modules.shift_remove(&name);
    core.placeholder_scopes.remove(&name);
}

/// Extract `:param` names from a route pattern.
pub(crate) fn route_params(path: &str) -> Vec<String> {
    path.split('/')
        .filter_map(|seg| seg.strip_prefix(':'))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// Prop key a `.bind()` lands on for a given element type.
///
/// Mirrors the mapping in `ir::expand` — kept in step with it deliberately:
/// this is what lets [`list_bindings`] report a boolean field as boolean
/// without consulting state.
pub(crate) fn bind_prop_for(element_type: &str) -> &'static str {
    match element_type {
        "Checkbox" | "checkbox" => "checked",
        "Switch" | "switch" => "on",
        "Video" | "video" => "playback",
        _ => "value",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::ast_to_ir_node;

    /// Expand one DSL source to IR the way a render would, so call sites are
    /// read from the same tree `absorb_declarations` sees.
    fn ir(source: &str) -> IRNode {
        let doc = hypen_parser::parse_document(source).expect("parse");
        ast_to_ir_node(doc.components.first().expect("has component"))
    }

    fn site_for<'a>(sites: &'a [CallSite], action: &str) -> &'a CallSite {
        sites
            .iter()
            .find(|s| s.action == action)
            .unwrap_or_else(|| panic!("no call site for {action} in {sites:?}"))
    }

    #[test]
    fn a_static_argument_is_reported_with_its_value() {
        let sites = extract_call_sites(&ir(
            r#"module Shop { Button("Add").onClick(@actions.addToCart, sku: "abc-1", qty: 2) }"#,
        ));

        let add = site_for(&sites, "addToCart");
        assert_eq!(add.element_type, "Button");
        assert_eq!(add.route, None);
        assert!(!add.in_for_each);
        // Order is the order the developer wrote, so a caller reading the
        // manifest sees the signature as declared.
        assert_eq!(
            add.args.keys().collect::<Vec<_>>(),
            vec!["sku", "qty"],
            "{:?}",
            add.args
        );
        assert_eq!(
            add.args["sku"],
            ArgSource::Static(serde_json::json!("abc-1"))
        );
        assert_eq!(add.args["qty"], ArgSource::Static(serde_json::json!(2.0)));
    }

    #[test]
    fn a_state_argument_is_reported_as_the_path_it_reads() {
        let sites = extract_call_sites(&ir(
            r#"module Search { Button("Go").onClick(@actions.search, q: @state.query) }"#,
        ));

        assert_eq!(
            site_for(&sites, "search").args["q"],
            ArgSource::State("query".to_string())
        );
    }

    #[test]
    fn a_call_site_inside_a_for_each_is_flagged_and_its_row_field_named() {
        let sites = extract_call_sites(&ir(r#"
            module Shop {
                Router {
                    Route(path: "/cart") {
                        List(@state.items, as: item) {
                            Button("Buy").onClick(@actions.addToCart, sku: @item.sku)
                        }
                    }
                }
            }
            "#));

        let add = site_for(&sites, "addToCart");
        // One call per row: the caller names the row through `sku`, and reads
        // the legal values from the collection the site is declared over.
        assert!(add.in_for_each);
        assert_eq!(add.rows.as_deref(), Some("items"));
        assert_eq!(add.route.as_deref(), Some("/cart"));
        assert_eq!(add.args["sku"], ArgSource::Item("sku".to_string()));
    }

    #[test]
    fn a_custom_item_name_names_the_row_argument_the_same_way() {
        // `@product.sku` never parses as an item binding — it reaches the IR
        // shaped like a data-source binding named after the row — and the
        // quoted `"@{product.sku}"` is a template string that is one whole
        // reference. Both are the same argument as `@item.sku` and are
        // reported as such; gating on `is_item()` would drop both.
        let sites = extract_call_sites(&ir(r#"
            module Shop {
                List(@state.products, as: product) {
                    Button("A").onClick(@actions.addToCart, sku: @product.sku)
                    Button("B").onClick(@actions.buyNow, sku: "@{product.sku}", note: "x @{product.sku}")
                }
            }
            "#));

        let add = site_for(&sites, "addToCart");
        assert_eq!(add.args["sku"], ArgSource::Item("sku".to_string()));
        assert_eq!(add.rows.as_deref(), Some("products"));

        let buy = site_for(&sites, "buyNow");
        assert_eq!(buy.args["sku"], ArgSource::Item("sku".to_string()));
        // Text mixed with a reference has no single source a caller could
        // supply, so it stays unnamed.
        assert!(!buy.args.contains_key("note"), "{:?}", buy.args);
    }

    #[test]
    fn a_data_source_row_argument_is_not_a_row_of_module_state() {
        let sites = extract_call_sites(&ir(r#"
            module Feed {
                List(@spacetime.messages, as: m) {
                    Button("R").onClick(@actions.reply, id: @m.id)
                }
            }
            "#));
        let reply = site_for(&sites, "reply");
        // Still a row argument — it is filled per row — but there is no state
        // collection to read the rows from.
        assert!(reply.in_for_each);
        assert_eq!(reply.args["id"], ArgSource::Item("id".to_string()));
        assert_eq!(reply.rows, None);
    }

    #[test]
    fn row_arguments_join_the_read_surface_and_state_arguments_do_not() {
        let refs: Vec<String> = extract_state_refs(&ir(
            r#"
            module Shop {
                Column {
                    Button("Sync").onClick(@actions.sync, key: @state.apiKey)
                    List(@state.products, as: product) {
                        Text("@{product.title}")
                        Button("Add").onClick(@actions.addToCart, sku: @product.sku, key: @state.apiKey)
                    }
                    List(@state.tags) { Text("@{item}") }
                }
            }
            "#,
        ))
        .into_iter()
        .map(|(_, path)| path)
        .collect();

        assert_eq!(
            refs,
            vec!["products.*.sku", "products.*.title", "tags.*"],
            "the row's sku ships in its Create patch and is declared; the state \
             apiKey is a handler input and is not — inside a row or out"
        );
    }

    #[test]
    fn the_bare_action_prop_forms_are_call_sites_with_no_arguments() {
        // `onClick:` as an argument, and the positional form that lowers to
        // the "action" prop. Neither can carry arguments — there is no
        // applicator prefix for siblings to hang off.
        let sites = extract_call_sites(&ir(r#"
            module App {
                Column {
                    Button(onClick: @actions.submit) { Text("Go") }
                    Button(@actions.checkout)
                }
            }
            "#));

        assert!(site_for(&sites, "submit").args.is_empty());
        assert!(site_for(&sites, "checkout").args.is_empty());
    }

    #[test]
    fn reserved_action_names_yield_no_call_site() {
        // Both spellings that reach `Value::Action`: a module-written
        // `@actions.__hypen_bind`, and `@router.push`, which lowers to an
        // action indistinguishable from a module one at this level.
        let sites = extract_call_sites(&ir(r#"
            module App {
                Column {
                    Button("Write").onClick(@actions.__hypen_bind, path: "token")
                    Link("Home").onClick(@router.push, to: "/")
                    Button("Real").onClick(@actions.refresh)
                }
            }
            "#));

        let names: Vec<&str> = sites.iter().map(|s| s.action.as_str()).collect();
        assert_eq!(names, vec!["refresh"], "{sites:?}");
    }

    #[test]
    fn call_sites_are_harvested_at_render_into_the_declared_table() {
        let mut core = EngineCore::new();
        core.render_ir_node(&ir(
            r#"module Shop { Button("Add").onClick(@actions.addToCart, sku: "abc-1") }"#,
        ));

        let (scope, sites) = core
            .declared_call_sites
            .iter()
            .next()
            .expect("one template declared call sites");
        assert_eq!(scope.0.as_deref(), Some("shop"));
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].action, "addToCart");
    }
}
