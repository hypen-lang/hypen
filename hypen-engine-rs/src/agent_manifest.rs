//! The MCP handshake, composed from what the app declared.
//!
//! # Why this exists
//!
//! [`crate::agent`] answers *what may be reached*. A host still has to turn
//! that into an MCP handshake: tool names in MCP's charset, a JSON Schema per
//! tool, a resource per readable value, and a paragraph of prose telling the
//! client how the surface behaves. Five SDKs were each going to write that
//! paragraph, and each was going to write it slightly differently.
//!
//! So the engine writes it once. A host copies these fields into `initialize`,
//! `tools/list` and `resources/list` verbatim — it transports bytes and
//! hand-writes no protocol prose.
//!
//! # What this may and may not do
//!
//! It composes; it never decides. Every tool comes from
//! [`agent_core::list_actions`], every resource from `declared_state_refs` —
//! the same allowlist [`agent_core::get_state`] enforces — so the manifest
//! cannot advertise a capability the guard would then refuse. There is no
//! expose list here and there must never be one: the moment this file decides
//! what is reachable, "nothing is externally reachable that a developer did not
//! declare" has two implementations and one of them will drift.
//!
//! # Schemas are permissive on purpose
//!
//! An MCP client validates `inputSchema` **locally** and refuses to send a call
//! that fails it. A schema tighter than the engine's own checks therefore
//! blocks calls that work today — a regression dressed as rigour. So arguments
//! inferred from call sites are never required, never closed, and typed only
//! where the type is actually known.
//!
//! Where the engine does check, it says so: every tool carries
//! `dev.hypen/enforcement`, `"guard"` when the guard validates the payload and
//! `"advisory"` when the schema is a description of a call site and nothing
//! more. Advertising a check that does not exist is worse than advertising no
//! check at all.

use indexmap::map::Entry;
use indexmap::IndexMap;
use serde_json::json;

use crate::agent::{
    AgentAction, AgentRoute, BoundInput, McpDegradation, McpManifest, McpResource, McpTool,
    McpToolAnnotations, BACK, NAVIGATE, SET_INPUT,
};
use crate::agent_core::{self, ArgSource, BindValueKind};
use crate::engine_core::EngineCore;
use crate::lifecycle::ModuleInstance;

/// MCP revision these shapes were written against.
pub(crate) const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// How this surface behaves, for the client's system prompt.
///
/// Deliberately app-agnostic: it is byte-identical for every Hypen app, so a
/// host may cache it, and nothing an app declares can change what it claims.
/// Each paragraph earns its place by heading off a specific wrong inference —
/// that a tool returns the thing it acted on, that success means the handler
/// finished, that a read reflects the write that preceded it, and that a
/// missing capability was withheld rather than never written.
pub(crate) const PROTOCOL_INSTRUCTIONS: &str = "\
This server drives one running Hypen application.

Tools act; they never return data. A successful call means the action was
DELIVERED to the app, not that it finished: handlers run asynchronously, are
not awaited, and their failures do not travel back to you. Treat a tool result
as evidence of dispatch and nothing more.

To observe anything, read a resource. Resources are sampled from state as it
stands when you read, so a read taken straight after a call may still show the
pre-call value. Read again; do not re-send the call.

Everything here is enumerated from what the developer declared — tools from
declared actions, routes and bound inputs, resources from state paths the UI
actually renders. Nothing else is exposed. A capability you cannot find was not
declared, rather than declared and withheld, so there is no alternate spelling
to look for.";

/// External name → MCP tool name, for the built-ins.
///
/// A **fixed table**, never a character substitution over [`NAVIGATE`] and
/// friends. Substitution is a many-to-one map — `hypen.set_input` and
/// `hypen-set-input` collapse to the same tool — so the one place the mapping
/// is allowed to happen is a list somebody has to edit by hand.
///
/// Module actions need no such table: the reserved floor already refuses any
/// name starting `hypen_`, so nothing a developer declares can land on one of
/// these spellings.
const BUILTIN_TOOL_NAMES: &[(&str, &str)] = &[
    (NAVIGATE, "hypen_navigate"),
    (BACK, "hypen_back"),
    (SET_INPUT, "hypen_set_input"),
];

/// Whether the engine validates a tool's payload, or merely describes it.
const ENFORCEMENT: &str = "dev.hypen/enforcement";
const ENFORCED: &str = "guard";
const ADVISORY: &str = "advisory";

/// Everything an MCP host needs to describe this app to a client.
pub(crate) fn mcp_manifest(core: &EngineCore) -> McpManifest {
    let routes = agent_core::list_routes(core);
    let bindings = agent_core::list_bindings(core);
    // The set `hypen_navigate` will actually accept, so nothing else in the
    // manifest can point an agent at a screen the guard refuses.
    let navigable: Vec<String> = routes.iter().map(|r| r.path.clone()).collect();

    let mut tools = Vec::new();
    let mut degraded = Vec::new();

    // Driven by `list_actions` rather than by the tables directly, so the tool
    // list is exactly the dispatch allowlist — including its ordering and its
    // "only once a handler exists" rule.
    for action in agent_core::list_actions(core) {
        // Built-in or not is decided here, once, from the flag the listing
        // already carries — never inferred from the name's shape, which is the
        // sort of guess that lets a module action be published wearing a
        // built-in's enforcement claim.
        let tool = if action.builtin {
            builtin_tool(core, &action, &routes, &bindings).ok_or_else(|| {
                "framework capability with no entry in the built-in tool-name table".to_string()
            })
        } else {
            module_action_tool(core, &action, &navigable)
        };

        match tool {
            Ok(tool) => tools.push(tool),
            Err(reason) => degraded.push(McpDegradation {
                kind: "tool".to_string(),
                name: action.name.clone(),
                reason,
            }),
        }
    }

    let (resources, mut resource_degradations) = state_resources(core);
    degraded.append(&mut resource_degradations);

    McpManifest {
        protocol_version: MCP_PROTOCOL_VERSION.to_string(),
        instructions: PROTOCOL_INSTRUCTIONS.to_string(),
        tools,
        resources,
        resource_templates: Vec::new(),
        degraded,
    }
}

// ── tools ──────────────────────────────────────────────────────────────────

/// The tool for one framework built-in, or `None` when this file has no
/// spelling and no schema for it.
fn builtin_tool(
    core: &EngineCore,
    action: &AgentAction,
    routes: &[AgentRoute],
    bindings: &[BoundInput],
) -> Option<McpTool> {
    let (_, name) = BUILTIN_TOOL_NAMES
        .iter()
        .find(|(external, _)| *external == action.name)?;

    let (title, description, input_schema, idempotent) = match action.name.as_str() {
        NAVIGATE => (
            "Navigate",
            format!(
                "Move the app to one of its declared routes. Declared: {}.",
                routes
                    .iter()
                    .map(|r| r.path.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            navigate_schema(routes),
            true,
        ),
        BACK => (
            "Go back",
            "Return to the previous entry in the app's navigation history.".to_string(),
            json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": true
            }),
            false,
        ),
        SET_INPUT => (
            "Set input",
            "Set one form field the app declares with .bind(). 'field' names the \
             declared field and its value type is fixed per field; a field not \
             listed here cannot be written."
                .to_string(),
            set_input_schema(core, bindings),
            true,
        ),
        // Unreachable while [`BUILTIN_TOOL_NAMES`] and this match list the same
        // built-ins. Fail closed rather than with a `_` arm: a future built-in
        // added to the table alone would otherwise be published wearing
        // `set_input`'s schema and its "the guard checks this" claim. Landing
        // in `degraded` instead makes the gap something a developer can see.
        _ => return None,
    };

    let mut meta = IndexMap::new();
    // The guard checks these payloads itself — the route table for `navigate`,
    // the declared bind set and its prop type for `set_input` — so the schema
    // is a description of a real check rather than a hope.
    meta.insert(ENFORCEMENT.to_string(), json!(ENFORCED));
    if action.name == NAVIGATE {
        meta.insert(
            "dev.hypen/routes".to_string(),
            json!(routes.iter().map(|r| r.path.clone()).collect::<Vec<_>>()),
        );
    }

    Some(McpTool {
        name: (*name).to_string(),
        title: title.to_string(),
        description,
        input_schema,
        annotations: McpToolAnnotations {
            read_only_hint: false,
            destructive_hint: false,
            idempotent_hint: idempotent,
        },
        meta,
    })
}

/// The tool for one module-declared action, or why it has none.
fn module_action_tool(
    core: &EngineCore,
    action: &AgentAction,
    navigable: &[String],
) -> Result<McpTool, String> {
    if !is_mcp_tool_name(&action.name) {
        return Err(
            "action name is not an MCP tool name ([a-zA-Z0-9_-], 1-64 chars), and renaming it \
             here would invent a spelling the app never declared"
                .to_string(),
        );
    }

    let shape = action_shape(core, &action.name);

    let mut description = format!("Dispatch the app's '{}' action.", action.name);
    if let Some(scope) = &action.module {
        description.push_str(&format!(" Declared by module '{scope}'."));
    }
    if let [route] = shape.routes.as_slice() {
        if navigable.iter().any(|r| r == route) {
            description.push_str(&format!(" Invoked from the '{route}' screen."));
        }
    }
    if shape.per_row {
        description.push_str(
            " Every place the UI invokes it sits inside a list, so it is declared once per row;",
        );
        // Which row is the caller's to say, through the row arguments — and
        // the legal values for those are exactly the rendered rows, readable
        // as a resource. Name the collection so an agent knows where to look
        // before it guesses.
        match shape.rows.as_slice() {
            [] => description.push_str(" nothing here can say which row."),
            rows => description.push_str(&format!(
                " read the rows at state path {} to pick the row's values for its arguments.",
                rows.iter()
                    .map(|r| format!("'{r}'"))
                    .collect::<Vec<_>>()
                    .join(" or ")
            )),
        }
    }
    description.push_str(" Arguments are passed to the handler unchecked.");

    let mut meta = IndexMap::new();
    // The payload reaches a handler the engine never wrote and cannot inspect.
    // Saying "advisory" costs nothing; implying otherwise would have a client
    // trust a validation that happens nowhere.
    meta.insert(ENFORCEMENT.to_string(), json!(ADVISORY));
    if let Some(scope) = &action.module {
        meta.insert("dev.hypen/module".to_string(), json!(scope));
    }
    // Only name a screen the guard would actually accept. Call sites
    // accumulate across templates, so a route this action was once reachable
    // from can outlive the Router that declared it — and a hint pointing at a
    // screen `hypen_navigate` refuses is worse than no hint, because an agent
    // will try to go there first.
    if let [route] = shape.routes.as_slice() {
        if navigable.iter().any(|r| r == route) {
            meta.insert("dev.hypen/route".to_string(), json!(route));
        }
    }
    if shape.per_row {
        meta.insert("dev.hypen/perRow".to_string(), json!(true));
        if !shape.rows.is_empty() {
            meta.insert("dev.hypen/rows".to_string(), json!(shape.rows));
        }
    }

    Ok(McpTool {
        name: action.name.clone(),
        title: action.name.clone(),
        description,
        input_schema: json!({
            "type": "object",
            "properties": serde_json::Value::Object(
                shape
                    .args
                    .into_iter()
                    .map(|(name, ty)| (name, ty.map_or_else(|| json!({}), |t| json!({"type": t}))))
                    .collect()
            ),
            // Never inferred from call sites. A call site shows what one
            // template happens to pass, not what the handler needs — and a
            // client refuses locally on a missing required property, so
            // guessing wrong here removes a call that works today.
            "required": [],
            "additionalProperties": true
        }),
        annotations: McpToolAnnotations {
            read_only_hint: false,
            // The engine cannot see inside a module handler, so it cannot
            // promise the call is safe. MCP's own default is the same.
            destructive_hint: true,
            idempotent_hint: false,
        },
        meta,
    })
}

/// What the template's call sites say about how one action is invoked.
struct ActionShape {
    /// Argument name → JSON Schema type, or `None` where no type is known.
    args: IndexMap<String, Option<&'static str>>,
    /// Distinct routes the action is invoked from, in declaration order.
    routes: Vec<String>,
    /// Every call site sits inside a `ForEach`, so the call is one per row.
    per_row: bool,
    /// Readable collections the per-row call sites iterate, in declaration
    /// order — where a caller reads the rows to pick its arguments from.
    rows: Vec<String>,
}

/// Union every call site of one action into a single callable shape.
///
/// A union, not an intersection: an argument some screen passes is an argument
/// the handler can receive, and dropping it because another screen omits it
/// would hide it from a caller for whom it is the only way to say what it means.
fn action_shape(core: &EngineCore, action: &str) -> ActionShape {
    let mut args: IndexMap<String, Option<&'static str>> = IndexMap::new();
    let mut routes: Vec<String> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    let mut sites = 0usize;
    let mut in_for_each = 0usize;

    for ((scope, _), declared) in core.declared_call_sites.iter() {
        for site in declared.iter().filter(|s| s.action == action) {
            sites += 1;
            in_for_each += usize::from(site.in_for_each);
            if let Some(route) = &site.route {
                if !routes.contains(route) {
                    routes.push(route.clone());
                }
            }
            if let Some(collection) = &site.rows {
                if !rows.contains(collection) {
                    rows.push(collection.clone());
                }
            }

            for (name, source) in site.args.iter() {
                let ty = arg_type(core, scope, source);
                match args.entry(name.clone()) {
                    Entry::Vacant(slot) => {
                        slot.insert(ty);
                    }
                    // Two call sites disagreeing about an argument's type mean
                    // the engine does not know it, so it constrains nothing —
                    // picking one would refuse the other's calls.
                    Entry::Occupied(mut slot) if *slot.get() != ty => {
                        slot.insert(None);
                    }
                    Entry::Occupied(_) => {}
                }
            }
        }
    }

    ActionShape {
        args,
        routes,
        per_row: sites > 0 && sites == in_for_each,
        rows,
    }
}

/// The JSON Schema type of one call-site argument, where it is knowable.
fn arg_type(
    core: &EngineCore,
    scope: &Option<String>,
    source: &ArgSource,
) -> Option<&'static str> {
    match source {
        ArgSource::Static(literal) => json_type_name(literal),
        // The **seeded** state, never the live one: a manifest is cached by
        // clients and read by agents, so typing off a value the user has since
        // edited would make the schema drift under them. The seed is what the
        // developer declared, which is the only thing on this surface that a
        // running session cannot change.
        ArgSource::State(path) => seeded_for(core, scope)
            .and_then(|state| crate::portable::path::path_get(state, path))
            .as_ref()
            .and_then(json_type_name),
        // A row field is typed by no single value: the seed may hold no rows
        // at all, and rows are free to differ. The rows themselves are
        // readable (see `CallSite::rows`), which is where a caller learns the
        // real values rather than a type.
        ArgSource::Item(_) => None,
    }
}

/// The `to` schema for `hypen_navigate`.
fn navigate_schema(routes: &[AgentRoute]) -> serde_json::Value {
    let mut to = serde_json::Map::new();
    to.insert("type".to_string(), json!("string"));

    // Enumerate only while every route is static and closed. A `:param` route is reached
    // by a *concrete* path — `/order/42`, which the guard accepts and no list
    // of patterns contains — so an enum there would have the client refuse
    // locally the very navigations the engine allows. The full pattern list is
    // in `_meta` and in the description either way.
    // A `/*` route is open in the same way: `/docs/intro` matches `/docs/*`,
    // the guard accepts it, and no enum of patterns contains it.
    if routes
        .iter()
        .all(|r| r.params.is_empty() && !r.path.contains('*'))
    {
        to.insert(
            "enum".to_string(),
            json!(routes.iter().map(|r| r.path.clone()).collect::<Vec<_>>()),
        );
    }

    json!({
        "type": "object",
        "properties": { "to": serde_json::Value::Object(to) },
        // Required because the guard genuinely refuses a call without it, so
        // requiring it locally blocks nothing that would have worked.
        "required": ["to"],
        "additionalProperties": true
    })
}

/// The `{field, value}` schema for `hypen_set_input`.
///
/// A `oneOf` of `const`-discriminated branches, so a client can see that the
/// field set is closed and that each field has its own value type.
fn set_input_schema(core: &EngineCore, bindings: &[BoundInput]) -> serde_json::Value {
    let mut branches: Vec<serde_json::Value> = Vec::new();
    let mut seen: Vec<(Option<String>, String)> = Vec::new();

    for input in bindings {
        // Dedup on (module, field), not field alone. Reads are module-qualified
        // — `hypen://state/alpha/name` and `hypen://state/beta/name` are two
        // resources — so collapsing them to one writable field meant a caller
        // who read one module's value wrote the other's.
        let scope = agent_core::effective_scope(core, &input.module_scope);
        let key = (scope.clone(), input.path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);

        let mut properties = serde_json::Map::new();
        properties.insert("field".to_string(), json!({ "const": input.path }));
        properties.insert("value".to_string(), bind_value_schema(&input.prop));

        let mut required = vec!["field", "value"];
        // Discriminate on `module` as well, so the branches stay mutually
        // exclusive when two modules declare the same path. The primary module
        // is addressed by omission, exactly as `get_state` addresses it, so its
        // branch pins `module` absent rather than inventing a name for it.
        match &scope {
            Some(scope) => {
                properties.insert("module".to_string(), json!({ "const": scope }));
                required.push("module");
            }
            None => {
                properties.insert("module".to_string(), json!({ "type": "null" }));
            }
        }

        branches.push(json!({
            "properties": properties,
            "required": required
        }));
    }

    json!({
        "type": "object",
        "oneOf": branches,
        "additionalProperties": true
    })
}

/// The schema for a bound field's value.
///
/// Reads [`agent_core::bind_value_kind`] rather than restating the mapping, so
/// what this publishes and what the guard enforces cannot come apart.
fn bind_value_schema(prop: &str) -> serde_json::Value {
    match agent_core::bind_value_kind(prop) {
        BindValueKind::Boolean => json!({ "type": "boolean" }),
        BindValueKind::Object => json!({ "type": "object" }),
        // "Scalar" is defined by the guard as *not* an object and *not* an
        // array, so it is spelled here as the complement rather than narrowed
        // to a string.
        BindValueKind::Scalar => json!({ "type": ["string", "number", "boolean", "null"] }),
    }
}

// ── resources ──────────────────────────────────────────────────────────────

/// One resource per declared readable state path — and, for the rows of a
/// `ForEach`, one per **collection**.
///
/// A row is declared as `products.*.sku` (see
/// [`agent_core::extract_state_refs`]), and no resource can carry a `*`: it is
/// not a path any read serves, and it is not one value. So every wildcard path
/// under one collection collapses into the resource for that collection —
/// `hypen://state/shop/products` — whose read goes through the same projection
/// the guard applies, returning every row with just its rendered fields. Those
/// fields are named in the description and in `dev.hypen/rowFields`, so an
/// agent knows a `sku` is there before it reads, and can read the collection
/// once instead of probing rows for a field it cannot see.
fn state_resources(core: &EngineCore) -> (Vec<McpResource>, Vec<McpDegradation>) {
    let mut resources = Vec::new();
    let mut degraded = Vec::new();
    /// One resource in the making, keyed by URI in first-seen order.
    struct Pending {
        module: String,
        argument: Option<String>,
        path: String,
        /// Row fields declared under the collection, in the (sorted) order
        /// `declared_state_refs` holds them.
        row_fields: Vec<String>,
        /// The path was also declared whole (`@{state.products}` rendered as
        /// is), so the read serves everything and the row fields are moot.
        whole: bool,
    }
    let mut published: IndexMap<String, Pending> = IndexMap::new();
    let mut unaddressable: Vec<Option<String>> = Vec::new();

    for ((scope, _), refs) in core.declared_state_refs.iter() {
        let Some((module, argument)) = state_address(core, scope) else {
            // A scope whose module is gone: the paths are still in the table
            // but nothing holds their values, so publishing them would
            // advertise reads that come back empty.
            if !unaddressable.contains(scope) {
                unaddressable.push(scope.clone());
                degraded.push(McpDegradation {
                    kind: "resource".to_string(),
                    name: format!("{}.*", scope.as_deref().unwrap_or("<primary>")),
                    reason: "no module is installed under this scope, so its declared state \
                             paths have nothing to read"
                        .to_string(),
                });
            }
            continue;
        };

        let seeded = seeded_for(core, scope);
        for declared in refs {
            let (path, row_field) = collection_and_row_field(declared);
            // Advertise only what a read can serve. A template may render a
            // path the module was never seeded with — a typo, or a field the
            // host fills in later — and publishing it produces a resource that
            // reads empty, which an agent cannot distinguish from a permission
            // problem. For rows the gate is the collection: a seeded empty
            // list is a real, readable collection whose rows arrive later.
            if seeded.is_none_or(|st| crate::portable::path::path_get(st, path).is_none()) {
                continue;
            }
            let uri = format!("hypen://state/{module}/{path}");
            // The same path is routinely declared by several templates under
            // one scope — a shell and the route inside it both render the
            // user's name — and it is one value either way. Row fields from
            // every template still accumulate onto the one collection.
            let entry = published.entry(uri).or_insert_with(|| Pending {
                module: module.clone(),
                argument: argument.clone(),
                path: path.to_string(),
                row_fields: Vec::new(),
                whole: false,
            });
            match row_field {
                Some(field) if !entry.row_fields.iter().any(|f| f == field) => {
                    entry.row_fields.push(field.to_string());
                }
                Some(_) => {}
                None => entry.whole = true,
            }
        }
    }

    for (
        uri,
        Pending {
            module,
            argument,
            path,
            row_fields,
            whole,
        },
    ) in published
    {
        let mut meta = IndexMap::new();
        // The read takes an *optional* scope, and the primary module is
        // addressed by its absence — which no URI segment can spell. So
        // the argument travels beside the URI rather than inside it.
        meta.insert(
            "dev.hypen/module".to_string(),
            argument.map_or(serde_json::Value::Null, |m| json!(m)),
        );
        meta.insert("dev.hypen/statePath".to_string(), json!(path));

        let description = if whole || row_fields.is_empty() {
            format!("Value of '{path}' in the '{module}' module's state.")
        } else {
            meta.insert("dev.hypen/rowFields".to_string(), json!(row_fields));
            if row_fields.iter().any(|f| f == WHOLE_ROW) {
                format!(
                    "Rows of '{path}' in the '{module}' module's state, each row in full; \
                     address one as '{path}.<index>'."
                )
            } else {
                format!(
                    "Rows of '{path}' in the '{module}' module's state, each projected to the \
                     fields the UI renders: {}. Address one row as '{path}.<index>'.",
                    row_fields.join(", ")
                )
            }
        };

        resources.push(McpResource {
            uri,
            name: format!("{module}.{path}"),
            title: path.clone(),
            description,
            mime_type: "application/json".to_string(),
            meta,
        });
    }

    (resources, degraded)
}

/// How a whole row is listed among a collection's row fields: the declared
/// path was `products.*` with nothing after the wildcard.
const WHOLE_ROW: &str = "*";

/// Split a declared path at its first `*`: the collection the resource is
/// published for, and the field inside each row — `products.*.sku` is
/// `("products", Some("sku"))`, `products.*` is `("products", Some("*"))`, and a
/// plain `user.name` is `("user.name", None)`. A nested wildcard stays in the
/// field (`variants.*.size`), since a nested list's rows are only addressable
/// through the row that holds them.
fn collection_and_row_field(declared: &str) -> (&str, Option<&str>) {
    match declared.split_once(".*") {
        Some((collection, rest)) => {
            let field = rest.strip_prefix('.').unwrap_or(WHOLE_ROW);
            (collection, Some(field))
        }
        None => (declared, None),
    }
}

/// How a declaring scope's state is named in a URI, and how it is addressed in
/// a read — or `None` when no module holds it.
///
/// The primary module is checked **before** the named table on purpose. A
/// template rendered before its module is installed auto-registers a hollow
/// placeholder under its own scope name, so both can exist at once; the primary
/// slot is where the real state lands, and it is what `get_state` reads when
/// asked for no module. Which scope the primary answers for is
/// [`agent_core::primary_scope`]'s decision and not a name comparison here —
/// the two disagree whenever the host installed the module under a name the
/// template never spelled, which the web SDK does for every unnamed module.
///
/// A scope backed by *nothing but* that placeholder is refused rather than
/// addressed, so its paths land in `degraded` saying no module holds them.
/// Addressing it would publish a resource per declared path against a module
/// holding `{}` — reads that can only ever come back empty, which an agent
/// cannot tell apart from a permission refusal.
fn state_address(core: &EngineCore, scope: &Option<String>) -> Option<(String, Option<String>)> {
    let primary = agent_core::primary_scope(core);
    match scope {
        None => core
            .module
            .as_ref()
            .map(|m| (m.module.name.to_lowercase(), None)),
        Some(name) if primary.as_deref() == Some(name.as_str()) => Some((name.clone(), None)),
        Some(name)
            if core.modules.contains_key(name) && !core.placeholder_scopes.contains(name) =>
        {
            Some((name.clone(), Some(name.clone())))
        }
        Some(_) => None,
    }
}

/// The state a scope's module was seeded with. See [`arg_type`] for why the
/// seed and not the live tree.
fn seeded_for<'a>(core: &'a EngineCore, scope: &Option<String>) -> Option<&'a serde_json::Value> {
    // Same resolution as `state_address`, for the same reason: the scope the
    // primary module answers for is not always its installed name, and reading
    // the placeholder's `{}` instead would type every argument as unknown and
    // suppress every resource under an anonymous primary module.
    let is_primary = agent_core::primary_scope(core);
    let instance: Option<&ModuleInstance> = match scope {
        None => core.module.as_ref(),
        Some(name) if is_primary.as_deref() == Some(name.as_str()) => core.module.as_ref(),
        Some(name) => core.modules.get(name),
    };
    instance.map(|m| m.seeded_state())
}

// ── helpers ────────────────────────────────────────────────────────────────

/// Whether a name can be an MCP tool name as written.
fn is_mcp_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// JSON Schema type of a concrete value, where it constrains anything.
fn json_type_name(value: &serde_json::Value) -> Option<&'static str> {
    match value {
        // `null` is every type's inhabitant here; constraining on it would
        // pin an argument to the one value the developer happened to seed.
        serde_json::Value::Null => None,
        serde_json::Value::Bool(_) => Some("boolean"),
        // Hypen lowers every numeric literal to f64, so "integer" would be a
        // claim about the parser rather than about the argument.
        serde_json::Value::Number(_) => Some("number"),
        serde_json::Value::String(_) => Some("string"),
        serde_json::Value::Array(_) => Some("array"),
        serde_json::Value::Object(_) => Some("object"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::Action;
    use crate::ir::ast_to_ir_node;
    use crate::lifecycle::{Module, ModuleInstance};
    use crate::Engine;

    /// A cart app with the whole surface in one template: a Router, two
    /// actions (one carrying a call-site `sku`), two binds of different types,
    /// rendered state, and a `_token` the template never mentions.
    const CART: &str = r#"
        module Cart {
            Router {
                Route(path: "/cart") {
                    Column {
                        Text("Total: @{state.total}")
                        Text("@{state.user.name}")
                        Checkbox {}.bind(@state.giftWrap)
                        Input(placeholder: "Coupon").bind(@state.coupon)
                        List(@state.items, as: item) {
                            Button("Add").onClick(@actions.addToCart, sku: @item.sku)
                        }
                        Button("Go").onClick(@actions.checkout, note: "gift", qty: @state.total)
                    }
                }
                Route(path: "/orders") { Text("orders") }
            }
        }
    "#;

    /// Render a template, then install the module and its handlers the way
    /// every SDK does — declaration first, handlers immediately after.
    fn app(source: &str, name: &str, actions: &[&str], state: serde_json::Value) -> Engine {
        let mut engine = Engine::new();
        let doc = hypen_parser::parse_document(source).expect("parse");
        engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));

        let module = Module::new(name)
            .with_actions(actions.iter().map(|a| a.to_string()).collect());
        engine.set_module(ModuleInstance::new(module, state));
        for a in actions {
            let a = a.to_string();
            engine.on_action(a, move |_| {});
        }
        // The framework's own handlers, registered straight on the dispatcher.
        for internal in ["router.push", "router.back", crate::agent::BIND_ACTION] {
            engine.on_action(internal, |_| {});
        }
        engine
    }

    fn cart() -> Engine {
        app(
            CART,
            "Cart",
            &["addToCart", "checkout"],
            json!({
                "total": 4780,
                "user": { "name": "Ada" },
                "items": [],
                "giftWrap": false,
                "coupon": "",
                "_token": "secret"
            }),
        )
    }

    fn tool<'a>(manifest: &'a McpManifest, name: &str) -> &'a McpTool {
        manifest
            .tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| {
                panic!(
                    "no tool '{name}' in {:?}",
                    manifest.tools.iter().map(|t| &t.name).collect::<Vec<_>>()
                )
            })
    }

    fn enforcement(tool: &McpTool) -> &str {
        tool.meta[ENFORCEMENT].as_str().expect("enforcement is a string")
    }

    // ── the cart app, end to end ───────────────────────────────────────────

    #[test]
    fn every_tool_name_is_a_legal_mcp_name() {
        let manifest = cart().mcp_manifest();
        assert!(!manifest.tools.is_empty());
        for tool in &manifest.tools {
            assert!(
                is_mcp_tool_name(&tool.name),
                "'{}' is not [a-zA-Z0-9_-]{{1,64}}",
                tool.name
            );
        }
        // Built-ins arrive through the fixed table, never by substituting the
        // dot — so the dotted external names never appear as tool names.
        let names: Vec<&str> = manifest.tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"hypen_navigate"));
        assert!(names.contains(&"hypen_back"));
        assert!(names.contains(&"hypen_set_input"));
        assert!(!names.iter().any(|n| n.contains('.')));
    }

    #[test]
    fn a_module_actions_arguments_are_described_and_never_required() {
        let manifest = cart().mcp_manifest();
        let checkout = tool(&manifest, "checkout");

        // Typed from the call site: a literal by its own JSON type, a state
        // path by the type of that path in the seeded state.
        assert_eq!(checkout.input_schema["properties"]["note"]["type"], "string");
        assert_eq!(checkout.input_schema["properties"]["qty"]["type"], "number");

        // A row field has no type and no way to be named from outside, so it
        // is listed with no constraint rather than dropped.
        let add = tool(&manifest, "addToCart");
        assert_eq!(add.input_schema["properties"]["sku"], json!({}));
        assert_eq!(add.meta["dev.hypen/perRow"], json!(true));

        for name in ["addToCart", "checkout"] {
            let schema = &tool(&manifest, name).input_schema;
            // A call site shows what one template passes, not what the handler
            // needs — and a client refuses locally on a missing required
            // property, so inferring required-ness would remove working calls.
            assert_eq!(schema["required"], json!([]), "{name}");
            assert_eq!(schema["additionalProperties"], json!(true), "{name}");
        }
    }

    #[test]
    fn navigate_enumerates_exactly_the_declared_routes() {
        let manifest = cart().mcp_manifest();
        let navigate = tool(&manifest, "hypen_navigate");

        assert_eq!(
            navigate.input_schema["properties"]["to"]["enum"],
            json!(["/cart", "/orders"])
        );
        assert_eq!(navigate.input_schema["required"], json!(["to"]));
        assert_eq!(navigate.meta["dev.hypen/routes"], json!(["/cart", "/orders"]));
    }

    #[test]
    fn set_input_types_each_field_by_the_prop_the_guard_checks() {
        let manifest = cart().mcp_manifest();
        let branches = tool(&manifest, "hypen_set_input").input_schema["oneOf"]
            .as_array()
            .expect("oneOf")
            .clone();

        let branch = |field: &str| {
            branches
                .iter()
                .find(|b| b["properties"]["field"]["const"] == json!(field))
                .unwrap_or_else(|| panic!("no branch for {field} in {branches:?}"))
                .clone()
        };

        // A Checkbox binds `checked`, which `check_value_for_prop` accepts only
        // as a boolean — so the schema says boolean and nothing wider.
        assert_eq!(branch("giftWrap")["properties"]["value"], json!({"type": "boolean"}));
        // A text field's guard rule is "not an object, not an array", spelled
        // as the complement rather than narrowed to a string.
        assert_eq!(
            branch("coupon")["properties"]["value"],
            json!({"type": ["string", "number", "boolean", "null"]})
        );
        assert_eq!(branches.len(), 2, "one branch per declared bind");
    }

    #[test]
    fn resources_are_exactly_the_declared_read_surface() {
        let engine = cart();
        let manifest = engine.mcp_manifest();

        let mut paths: Vec<&str> = manifest
            .resources
            .iter()
            .map(|r| r.meta["dev.hypen/statePath"].as_str().expect("path"))
            .collect();
        paths.sort_unstable();

        assert_eq!(
            paths,
            // No "location": a bare Router's location binding is synthesised by
            // `ir::expand`, not written by the developer, so it is not a
            // declaration and must not become a readable resource.
            // `items` is here for its rows, not as a value: the ForEach's
            // source is consumed by the loop rather than rendered, but the
            // row's `sku` is substituted into each row's `Create` patch as the
            // `addToCart` argument, so `items.*.sku` is declared and collapses
            // onto the one collection resource.
            vec!["coupon", "giftWrap", "items", "total", "user.name"]
        );
        let items = manifest
            .resources
            .iter()
            .find(|r| r.uri == "hypen://state/cart/items")
            .expect("items resource");
        assert_eq!(items.meta["dev.hypen/rowFields"], json!(["sku"]));
        // The seed has no rows, and the read says so rather than refusing:
        // the collection is declared and empty.
        assert_eq!(engine.get_state(None, Some("items")), Some(json!([])));
        assert!(
            !paths.contains(&"_token"),
            "a path the template never renders must not be advertised"
        );

        // And the gate agrees, in both directions.
        assert_eq!(engine.get_state(None, Some("total")), Some(json!(4780)));
        assert_eq!(engine.get_state(None, Some("_token")), None);

        let total = manifest
            .resources
            .iter()
            .find(|r| r.uri == "hypen://state/cart/total")
            .expect("total resource");
        assert_eq!(total.name, "cart.total");
        assert_eq!(total.mime_type, "application/json");
        // The primary module is addressed by the *absence* of a scope, which
        // no URI segment can spell, so the read argument travels in `_meta`.
        assert_eq!(total.meta["dev.hypen/module"], serde_json::Value::Null);
    }

    #[test]
    fn enforcement_says_which_schemas_the_engine_actually_checks() {
        let manifest = cart().mcp_manifest();

        for guarded in ["hypen_navigate", "hypen_back", "hypen_set_input"] {
            assert_eq!(enforcement(tool(&manifest, guarded)), ENFORCED, "{guarded}");
        }
        for passed_through in ["addToCart", "checkout"] {
            assert_eq!(
                enforcement(tool(&manifest, passed_through)),
                ADVISORY,
                "{passed_through}: the payload reaches a handler the engine never inspects"
            );
        }
        assert!(manifest.degraded.is_empty(), "{:?}", manifest.degraded);
    }

    /// The invariant the whole file exists to hold: the manifest advertises
    /// nothing the guard then refuses.
    #[test]
    fn everything_the_manifest_offers_actually_dispatches() {
        let mut engine = cart();
        let manifest = engine.mcp_manifest();

        for tool in &manifest.tools {
            let (external, payload) = match tool.name.as_str() {
                "hypen_navigate" => (
                    NAVIGATE.to_string(),
                    Some(json!({ "to": tool.input_schema["properties"]["to"]["enum"][0] })),
                ),
                "hypen_back" => (BACK.to_string(), None),
                "hypen_set_input" => {
                    let branch = &tool.input_schema["oneOf"][0];
                    let value = match branch["properties"]["value"]["type"].as_str() {
                        Some("boolean") => json!(true),
                        Some("object") => json!({}),
                        _ => json!("typed"),
                    };
                    (
                        SET_INPUT.to_string(),
                        Some(json!({ "field": branch["properties"]["field"]["const"], "value": value })),
                    )
                }
                name => (name.to_string(), None),
            };

            let mut action = Action::new(&external);
            action.payload = payload;
            engine
                .dispatch_external(action)
                .unwrap_or_else(|e| panic!("advertised tool '{}' was refused: {e:?}", tool.name));
        }

        // Every enumerated route, not just the first.
        for route in tool(&manifest, "hypen_navigate").input_schema["properties"]["to"]["enum"]
            .as_array()
            .expect("enum")
        {
            engine
                .dispatch_external(Action::new(NAVIGATE).with_payload(json!({ "to": route })))
                .unwrap_or_else(|e| panic!("enumerated route {route} was refused: {e:?}"));
        }
    }

    // ── conservative schemas ───────────────────────────────────────────────

    #[test]
    fn a_parameterised_route_is_not_enumerated() {
        // `/order/42` is a legal target the guard accepts and no list of
        // patterns contains. A client validates the enum locally, so
        // enumerating here would refuse a navigation the engine allows.
        let engine = app(
            r#"
            module App {
                Router {
                    Route(path: "/cart") { Text("cart") }
                    Route(path: "/order/:orderId") { Text("order") }
                }
            }
            "#,
            "App",
            &[],
            json!({}),
        );
        let manifest = engine.mcp_manifest();
        let to = &tool(&manifest, "hypen_navigate").input_schema["properties"]["to"];

        assert_eq!(to["type"], "string");
        assert!(to.get("enum").is_none(), "{to}");
        // The patterns are still published, just not as a validation rule.
        assert_eq!(
            tool(&manifest, "hypen_navigate").meta["dev.hypen/routes"],
            json!(["/cart", "/order/:orderId"])
        );
    }

    #[test]
    fn call_sites_that_disagree_about_a_type_constrain_nothing() {
        let engine = app(
            r#"
            module App {
                Column {
                    Button("A").onClick(@actions.tag, id: "abc")
                    Button("B").onClick(@actions.tag, id: 7)
                    Button("C").onClick(@actions.tag, note: "same")
                }
            }
            "#,
            "App",
            &["tag"],
            json!({}),
        );
        let manifest = engine.mcp_manifest();
        let schema = &tool(&manifest, "tag").input_schema;

        assert_eq!(schema["properties"]["id"], json!({}), "conflicting types drop out");
        assert_eq!(schema["properties"]["note"]["type"], "string", "agreeing ones stay");
    }

    #[test]
    fn two_binds_on_one_path_yield_one_branch() {
        // Two matching `oneOf` branches is a validation failure, and the guard
        // resolves a duplicate field to the first declaration anyway.
        let engine = app(
            r#"
            module App {
                Column {
                    Input(placeholder: "Name").bind(@state.name)
                    Input(placeholder: "Name again").bind(@state.name)
                }
            }
            "#,
            "App",
            &[],
            json!({ "name": "" }),
        );
        let manifest = engine.mcp_manifest();
        assert_eq!(
            tool(&manifest, "hypen_set_input").input_schema["oneOf"]
                .as_array()
                .expect("oneOf")
                .len(),
            1
        );
    }

    // ── degradation ────────────────────────────────────────────────────────

    #[test]
    fn an_action_with_no_legal_mcp_name_is_reported_not_renamed() {
        // Substituting characters would invent a spelling the app never
        // declared, and could collide two declarations onto one tool.
        let mut engine = Engine::new();
        let module = Module::new("App")
            .with_actions(vec!["add to cart".to_string(), "checkout".to_string()]);
        engine.set_module(ModuleInstance::new(module, json!({})));
        engine.on_action("add to cart", |_| {});
        engine.on_action("checkout", |_| {});

        let manifest = engine.mcp_manifest();
        let names: Vec<&str> = manifest.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["checkout"]);

        let dropped = manifest
            .degraded
            .iter()
            .find(|d| d.name == "add to cart")
            .expect("the omission must be visible");
        assert_eq!(dropped.kind, "tool");
        assert!(!dropped.reason.is_empty());

        // The action itself is untouched — it is still dispatchable by anyone
        // whose transport can carry the name.
        assert!(engine.dispatch_external(Action::new("add to cart")).is_ok());
    }

    // ── the protocol prose ─────────────────────────────────────────────────

    #[test]
    fn the_instructions_describe_the_protocol_not_the_app() {
        // Cached by hosts and identical everywhere, so nothing an app declares
        // may change a word of it.
        let cart = cart().mcp_manifest();
        let other = app(
            r#"module Blog { Text("@{state.title}") }"#,
            "Blog",
            &[],
            json!({ "title": "hi" }),
        )
        .mcp_manifest();

        assert_eq!(cart.instructions, other.instructions);
        assert_eq!(cart.protocol_version, MCP_PROTOCOL_VERSION);
        for app_specific in ["cart", "Cart", "addToCart", "/orders"] {
            assert!(
                !cart.instructions.contains(app_specific),
                "'{app_specific}' leaked into the shared instructions"
            );
        }
    }

    #[test]
    fn an_app_with_nothing_declared_offers_nothing() {
        let engine = app(r#"module App { Text("static") }"#, "App", &[], json!({}));
        let manifest = engine.mcp_manifest();

        assert!(manifest.tools.is_empty(), "{:?}", manifest.tools);
        assert!(manifest.resources.is_empty(), "{:?}", manifest.resources);
        assert!(manifest.resource_templates.is_empty());
        assert!(manifest.degraded.is_empty());
        // The prose still ships: it is what tells a client that an empty tool
        // list means "not declared" rather than "not permitted".
        assert!(!manifest.instructions.is_empty());
    }

    // ── ADVERSARIAL REVIEW ─────────────────────────────────────────────────
    //
    // The five tests below FAIL on purpose. Each reproduces one finding from
    // an adversarial read of this file; none is a proposed API. Delete a test
    // only together with the defect it pins.

    /// The manifest tells a client its resources are "state paths the UI
    /// actually renders". An action's call-site arguments are element props
    /// like any other, so `extract_state_refs` collects them — and a token the
    /// developer only ever handed to a handler is published, by URI, to an
    /// agent, then reads back in full.
    #[test]
    fn review_a_an_action_argument_publishes_a_path_the_ui_never_renders() {
        let engine = app(
            r#"
            module Acct {
                Router {
                    Route(path: "/acct") {
                        Column {
                            Text("Hello")
                            Button("Refresh").onClick(@actions.refresh, token: @state.apiKey)
                            Link("Next").onClick(@router.push, to: @state.adminUrl)
                        }
                    }
                }
            }
            "#,
            "Acct",
            &["refresh"],
            json!({ "apiKey": "sk-live-DEADBEEF", "adminUrl": "https://internal/admin?t=abc" }),
        );
        let manifest = engine.mcp_manifest();
        let uris: Vec<&str> = manifest.resources.iter().map(|r| r.uri.as_str()).collect();

        // Skipping reserved names in `extract_call_sites` does not help: the
        // read surface is collected by a different walk that does not skip.
        assert!(
            !uris.iter().any(|u| u.ends_with("/apiKey") || u.ends_with("/adminUrl")),
            "paths passed only as action arguments are advertised as resources: {uris:?}"
        );
        assert_eq!(engine.get_state(None, Some("apiKey")), None);
    }

    /// `convert_router` synthesises `Binding::state(["location"])` when the
    /// template gives no `value:`, and `extract_state_refs` notes a Router's
    /// location like any other binding. So writing `Router { … }` — and
    /// nothing else — publishes whatever the module stores under `location`.
    #[test]
    fn review_b_a_bare_router_publishes_state_location_the_developer_never_wrote() {
        let engine = app(
            r#"module Trip { Router { Route(path: "/home") { Text("home") } } }"#,
            "Trip",
            &[],
            json!({ "location": { "lat": 51.5, "lng": -0.12, "address": "10 Downing St" } }),
        );
        assert_eq!(
            engine.get_state(None, Some("location")),
            None,
            "a field named by the engine, not by the template, is on the read surface"
        );
    }

    /// The module docs claim the manifest "cannot advertise a capability the
    /// guard would then refuse". A path the template renders but the state
    /// does not hold is published as a resource and then reads `None` — which
    /// `get_state` deliberately makes indistinguishable from a refusal.
    #[test]
    fn review_c_a_resource_is_advertised_for_a_path_the_read_cannot_serve() {
        let engine = app(
            r#"module App { Column { Text("@{state.here}") Text("@{state.missing}") } }"#,
            "App",
            &[],
            json!({ "here": 1 }),
        );
        for resource in &engine.mcp_manifest().resources {
            let path = resource.meta["dev.hypen/statePath"].as_str().expect("path");
            assert!(
                engine
                    .get_state(resource.meta["dev.hypen/module"].as_str(), Some(path))
                    .is_some(),
                "advertised resource {} reads nothing",
                resource.uri
            );
        }
    }

    /// Resources are module-qualified (`hypen://state/beta/name`); the
    /// `set_input` field namespace is flat. Two modules binding one path
    /// therefore expose two readable values and exactly one writable field,
    /// and the guard resolves that field to the first declaration — so an
    /// agent that read Beta's value writes Alpha's state.
    #[test]
    fn review_d_two_modules_binding_one_path_collapse_to_one_writable_field() {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("Alpha"),
            json!({ "name": "alpha-name" }),
        ));
        engine.register_module(
            "Beta",
            ModuleInstance::new(Module::new("Beta"), json!({ "name": "beta-name" })),
        );
        engine.on_action(crate::agent::BIND_ACTION, |_| {});
        for source in [
            r#"module Alpha { Input(placeholder: "A").bind(@state.name) }"#,
            r#"module Beta { Input(placeholder: "B").bind(@state.name) }"#,
        ] {
            let doc = hypen_parser::parse_document(source).expect("parse");
            engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
        }

        let manifest = engine.mcp_manifest();
        assert_eq!(
            tool(&manifest, "hypen_set_input").input_schema["oneOf"]
                .as_array()
                .expect("oneOf")
                .len(),
            manifest.resources.len(),
            "a field must name the module its resource named: {:?}",
            manifest.resources.iter().map(|r| &r.uri).collect::<Vec<_>>()
        );
    }

    /// `bound_scope` evicts each table independently, and only templates that
    /// declare a given kind hold a key in that table. A template carrying the
    /// app's only call site therefore keeps its `declared_call_sites` entry
    /// long after its `declared_routes` entry was evicted — so the tool says
    /// it is invoked from a screen `hypen_navigate` no longer offers and the
    /// guard now refuses.
    #[test]
    fn review_e_a_call_site_outlives_the_route_it_names() {
        // A call site records the route it was declared on. Retire that route —
        // re-render the template without it, which is what editing a component
        // does — and the hint would still name a screen `hypen_navigate` now
        // refuses. An agent reads the hint and tries to go there first, so a
        // stale hint is worse than none.
        let mut engine = app(
            r#"module App { Router { Route(path: "/shop") { Button("b").onClick(@actions.buy, sku: "x") } } }"#,
            "App",
            &["buy"],
            json!({}),
        );
        assert_eq!(
            tool(&engine.mcp_manifest(), "buy").meta["dev.hypen/route"],
            json!("/shop"),
            "while /shop is declared, naming it is correct"
        );

        // The same template, edited: /shop is gone, /other is not.
        let doc = hypen_parser::parse_document(
            r#"module App { Router { Route(path: "/other") { Button("b").onClick(@actions.buy, sku: "x") } } }"#,
        )
        .expect("parse");
        engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));

        let manifest = engine.mcp_manifest();
        let buy = tool(&manifest, "buy");
        assert!(
            !buy.description.contains("/shop"),
            "a retired screen must not be named in prose: {}",
            buy.description
        );

        // Whatever route hints survive must all be navigable.
        for t in &manifest.tools {
            if let Some(route) = t.meta.get("dev.hypen/route").and_then(|r| r.as_str()) {
                engine
                    .dispatch_external(
                        Action::new(NAVIGATE).with_payload(json!({ "to": route })),
                    )
                    .unwrap_or_else(|e| {
                        panic!("tool '{}' advertises '{route}', refused: {e:?}", t.name)
                    });
            }
        }
    }
}
