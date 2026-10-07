// Drag & drop applicator lowering — .draggable/.dropZone/.sortable/.pinboard → "__dnd.*" props
//
// Each DnD role applicator lowers into ONE static reserved prop carrying ONE
// JSON object (`"__dnd.source"`, `"__dnd.zone"`, `"__dnd.sort"`,
// `"__dnd.pin"`), plus separate props for the pieces that are *data* and must
// re-resolve per render (`"__dnd.sourcePayload"`, `"__dnd.sourceEnabled"`,
// `"__dnd.zoneId"`, `"__dnd.zoneEnabled"` — the `__anim.sharedKey` precedent).
// Renderers route on a single `startsWith("__dnd.")` check; a renderer that
// does not understand the family ignores the props and shows a correct,
// static, non-draggable UI. The originals never become `<name>.<idx>` props
// (intercepted in `expand::process_applicators` before the generic path).
//
// Two more reserved props are filled by the ENGINE, never by the author:
//   "__dnd.key"      — the `ForEach` item key, stamped at item expansion
//                      (`reconcile/item_bindings.rs`) on any element carrying
//                      `"__dnd.source"`.
//   "__dnd.pinGroup" — propagated at IR-expand time from a reserved-mode
//                      `.pinboard` (no `.bind`) onto every descendant element
//                      carrying `"__dnd.source"`; item expansion then injects
//                      `translateX.0` / `translateY.0` bindings to the
//                      reserved `__dnd.<group>.<key>.{x,y}` state paths.
//
// Malformed input never hard-errors: warn + fall back to the argument's
// default (or drop the offending argument). Bindings in static-only
// arguments warn and drop. The binding contract lives in
// `hypen-web/docs/dnd.md`

use crate::ir::{IRNode, Props, Value};
use crate::logger::LogScope;
use crate::reactive::Binding;
use hypen_parser::{ApplicatorSpecification, Argument, Value as ParserValue};

// ---------------------------------------------------------------------------
// Applicator names
// ---------------------------------------------------------------------------

/// `.draggable(group:, payload:, handle:, activation:, enabled:)`.
pub(crate) const DRAGGABLE_APPLICATOR: &str = "draggable";
/// `.dropZone(group:, id:, enabled:, band:, files:, accept:)`.
pub(crate) const DROP_ZONE_APPLICATOR: &str = "dropZone";
/// `.sortable(group:, axis:)`.
pub(crate) const SORTABLE_APPLICATOR: &str = "sortable";
/// `.pinboard(group:, x:, y:, grid:, bounds:, units:)`.
pub(crate) const PINBOARD_APPLICATOR: &str = "pinboard";

/// The six DnD event applicators. They lower through the EXISTING generic
/// applicator path (`onDrop.0` = action ref, or named args) — listed here so
/// tooling and renderers share one vocabulary; nothing in the engine
/// intercepts them.
pub const EVENT_APPLICATORS: &[&str] = &[
    "onDragStart",
    "onDragOver",
    "onDrop",
    "onSort",
    "onPin",
    "onDragEnd",
];

// ---------------------------------------------------------------------------
// Reserved prop names (engine → renderers)
// ---------------------------------------------------------------------------

/// Every DnD wire prop starts with this prefix.
pub const DND_PROP_PREFIX: &str = "__dnd.";
/// Static `{"group": string|null, "handle": bool, "activation": token}`.
pub const DND_SOURCE_PROP: &str = "__dnd.source";
/// Bindable payload; absent when `.draggable(payload:)` was not given.
pub const DND_SOURCE_PAYLOAD_PROP: &str = "__dnd.sourcePayload";
/// Bindable bool; absent ⇒ enabled.
pub const DND_SOURCE_ENABLED_PROP: &str = "__dnd.sourceEnabled";
/// Static string — the `ForEach` item key (engine-filled).
pub const DND_KEY_PROP: &str = "__dnd.key";
/// Static `{"group": string|null, "band": number}`, plus `"files": true` and
/// `"accept": string|null` when the zone reacts to files dragged in from the
/// OS (`.dropZone(files: true, accept: "image/*")`). A files zone shows the
/// `over` pose while matching OS files hover it and fires `.onFileDragEnter`;
/// the files themselves never cross to the server (an app answers with a
/// `file.pick`, whose host dialog takes the drop). Absent keys ⇒ in-app only.
pub const DND_ZONE_PROP: &str = "__dnd.zone";
/// Bindable string; absent ⇒ renderer uses the resolved `id` prop, else node id.
pub const DND_ZONE_ID_PROP: &str = "__dnd.zoneId";
/// Bindable bool; absent ⇒ enabled.
pub const DND_ZONE_ENABLED_PROP: &str = "__dnd.zoneEnabled";
/// Static `{"group": string|null, "axis": "x"|"y"}`.
pub const DND_SORT_PROP: &str = "__dnd.sort";
/// Static `{"group", "xKey", "yKey", "grid", "bounds", "units"}`.
pub const DND_PIN_PROP: &str = "__dnd.pin";
/// Static string — the reserved-mode pinboard group (engine-propagated).
pub const DND_PIN_GROUP_PROP: &str = "__dnd.pinGroup";

/// Top-level state key holding reserved-mode pinboard positions:
/// `{"__dnd": {"<group>": {"<key>": {"x", "y"}}}}`.
pub const DND_STATE_KEY: &str = "__dnd";

/// Prop keys the translate injection writes — the SAME keys the
/// `.translateX(n)` / `.translateY(n)` applicators lower to, so renderers
/// read them through their ordinary applicator path.
pub const TRANSLATE_X_PROP: &str = "translateX.0";
pub const TRANSLATE_Y_PROP: &str = "translateY.0";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/// `.draggable(activation:)` vocabulary.
pub const ACTIVATIONS: &[&str] = &["auto", "slop", "press", "immediate"];
/// `.sortable(axis:)` vocabulary.
pub const AXES: &[&str] = &["x", "y"];
/// `.pinboard(bounds:)` vocabulary.
pub const PIN_BOUNDS: &[&str] = &["clamp", "free"];
/// `.pinboard(units:)` vocabulary.
pub const PIN_UNITS: &[&str] = &["px", "fraction"];
/// Runtime-driven `.states` labels the DnD runtime applies (header-less
/// `.states` block on a draggable / zone, see `anim.rs`).
pub const RUNTIME_STATE_LABELS: &[&str] = &["lifted", "over"];

/// Default `.dropZone(band:)`.
pub const DEFAULT_BAND: f64 = 0.5;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/// True when `name` is one of the four DnD role applicators intercepted in
/// `process_applicators`.
pub(crate) fn is_dnd_applicator(name: &str) -> bool {
    matches!(
        name,
        DRAGGABLE_APPLICATOR | DROP_ZONE_APPLICATOR | SORTABLE_APPLICATOR | PINBOARD_APPLICATOR
    )
}

/// True when the props carry ANY `__dnd.*` prop.
pub(crate) fn has_dnd_props(props: &Props) -> bool {
    props.keys().any(|k| k.starts_with(DND_PROP_PREFIX))
}

/// True when any element in the template subtree carries `"__dnd.source"`.
/// Such templates need per-row identity that only the substitution path
/// stamps (`__dnd.key`, translate bindings), so the compiled/prototype
/// fast paths must refuse them.
pub(crate) fn template_needs_item_identity(node: &IRNode) -> bool {
    let mut found = false;
    crate::ir::walk::walk_ir(node, &mut |n| {
        if let IRNode::Element(el) = n {
            if el.props.contains_key(DND_SOURCE_PROP) {
                found = true;
            }
        }
    });
    found
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

/// Lower one DnD role applicator into its reserved props. Returns `false`
/// for non-DnD applicator names (nothing inserted). Always consumes the
/// applicator otherwise — invalid arguments degrade to defaults with a
/// warning, never a hard error.
pub(crate) fn lower_dnd_applicator(
    applicator: &ApplicatorSpecification,
    props: &mut Props,
) -> bool {
    match applicator.name.as_str() {
        DRAGGABLE_APPLICATOR => lower_draggable(applicator, props),
        DROP_ZONE_APPLICATOR => lower_drop_zone(applicator, props),
        SORTABLE_APPLICATOR => lower_sortable(applicator, props),
        PINBOARD_APPLICATOR => lower_pinboard(applicator, props),
        _ => return false,
    }
    true
}

/// `.draggable(...)` → `__dnd.source` (+ `__dnd.sourcePayload`,
/// `__dnd.sourceEnabled` when given).
fn lower_draggable(applicator: &ApplicatorSpecification, props: &mut Props) {
    let channel = DRAGGABLE_APPLICATOR;
    warn_positionals(channel, applicator);

    let mut group: Option<String> = None;
    let mut handle = false;
    let mut activation = "auto".to_string();
    let mut payload: Option<Value> = None;
    let mut enabled: Option<Value> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "group" => group = static_string(channel, "group", value).or(group),
            "handle" => {
                if let Some(b) = static_bool(channel, "handle", value) {
                    handle = b;
                }
            }
            "activation" => {
                if let Some(t) = static_token(channel, "activation", value, ACTIVATIONS) {
                    activation = t;
                }
            }
            "payload" => payload = bindable_any(channel, "payload", value).or(payload),
            "enabled" => enabled = bindable_bool(channel, "enabled", value).or(enabled),
            other => warn_unknown_arg(channel, other),
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("group".to_string(), json_opt_string(group));
    spec.insert("handle".to_string(), serde_json::json!(handle));
    spec.insert("activation".to_string(), serde_json::json!(activation));
    props.insert(
        DND_SOURCE_PROP.to_string(),
        Value::Static(serde_json::Value::Object(spec)),
    );
    if let Some(p) = payload {
        props.insert(DND_SOURCE_PAYLOAD_PROP.to_string(), p);
    }
    if let Some(e) = enabled {
        props.insert(DND_SOURCE_ENABLED_PROP.to_string(), e);
    }
}

/// `.dropZone(...)` → `__dnd.zone` (+ `__dnd.zoneId`, `__dnd.zoneEnabled`).
fn lower_drop_zone(applicator: &ApplicatorSpecification, props: &mut Props) {
    let channel = DROP_ZONE_APPLICATOR;
    warn_positionals(channel, applicator);

    let mut group: Option<String> = None;
    let mut band = DEFAULT_BAND;
    let mut id: Option<Value> = None;
    let mut enabled: Option<Value> = None;
    let mut files = false;
    let mut accept: Option<String> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "group" => group = static_string(channel, "group", value).or(group),
            "files" => files = static_bool(channel, "files", value).unwrap_or(files),
            "accept" => accept = static_string(channel, "accept", value).or(accept),
            "id" => id = bindable_string(channel, "id", value).or(id),
            "enabled" => enabled = bindable_bool(channel, "enabled", value).or(enabled),
            "band" => match value {
                ParserValue::Number(n) if n.is_finite() && (0.0..=1.0).contains(n) => band = *n,
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: band must be a number in 0..1, got {:?}; using {}",
                        channel,
                        other,
                        DEFAULT_BAND
                    );
                }
            },
            other => warn_unknown_arg(channel, other),
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("group".to_string(), json_opt_string(group));
    spec.insert("band".to_string(), serde_json::json!(band));
    if files {
        spec.insert("files".to_string(), serde_json::json!(true));
        spec.insert("accept".to_string(), json_opt_string(accept));
    } else if accept.is_some() {
        crate::log_warn!(LogScope::Engine, ".{}: accept: has no effect without files: true", channel);
    }
    props.insert(
        DND_ZONE_PROP.to_string(),
        Value::Static(serde_json::Value::Object(spec)),
    );
    if let Some(v) = id {
        props.insert(DND_ZONE_ID_PROP.to_string(), v);
    }
    if let Some(v) = enabled {
        props.insert(DND_ZONE_ENABLED_PROP.to_string(), v);
    }
}

/// `.sortable(...)` → `__dnd.sort`. A `null` group is finalized from the
/// node's static `id` prop (if any) in [`finalize_dnd_props`].
fn lower_sortable(applicator: &ApplicatorSpecification, props: &mut Props) {
    let channel = SORTABLE_APPLICATOR;
    warn_positionals(channel, applicator);

    let mut group: Option<String> = None;
    let mut axis = "y".to_string();

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "group" => group = static_string(channel, "group", value).or(group),
            "axis" => {
                if let Some(t) = static_token(channel, "axis", value, AXES) {
                    axis = t;
                }
            }
            other => warn_unknown_arg(channel, other),
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("group".to_string(), json_opt_string(group));
    spec.insert("axis".to_string(), serde_json::json!(axis));
    props.insert(
        DND_SORT_PROP.to_string(),
        Value::Static(serde_json::Value::Object(spec)),
    );
}

/// `.pinboard(...)` → `__dnd.pin`. A `null` group is finalized from the
/// node's static `id` prop in [`finalize_dnd_props`], which also drops the
/// prop (with a warning) when reserved-state mode ends up without a group.
fn lower_pinboard(applicator: &ApplicatorSpecification, props: &mut Props) {
    let channel = PINBOARD_APPLICATOR;
    warn_positionals(channel, applicator);

    let mut group: Option<String> = None;
    let mut x_key = "x".to_string();
    let mut y_key = "y".to_string();
    let mut grid: Option<f64> = None;
    let mut bounds = "clamp".to_string();
    let mut units = "px".to_string();

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "group" => group = static_string(channel, "group", value).or(group),
            "x" => {
                if let Some(s) = static_string(channel, "x", value) {
                    x_key = s;
                }
            }
            "y" => {
                if let Some(s) = static_string(channel, "y", value) {
                    y_key = s;
                }
            }
            "grid" => match value {
                ParserValue::Number(n) if n.is_finite() && *n > 0.0 => grid = Some(*n),
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: grid must be a positive number, got {:?}; ignored",
                        channel,
                        other
                    );
                }
            },
            "bounds" => {
                if let Some(t) = static_token(channel, "bounds", value, PIN_BOUNDS) {
                    bounds = t;
                }
            }
            "units" => {
                if let Some(t) = static_token(channel, "units", value, PIN_UNITS) {
                    units = t;
                }
            }
            other => warn_unknown_arg(channel, other),
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("group".to_string(), json_opt_string(group));
    spec.insert("xKey".to_string(), serde_json::json!(x_key));
    spec.insert("yKey".to_string(), serde_json::json!(y_key));
    spec.insert(
        "grid".to_string(),
        match grid {
            Some(g) => serde_json::json!(g),
            None => serde_json::Value::Null,
        },
    );
    spec.insert("bounds".to_string(), serde_json::json!(bounds));
    spec.insert("units".to_string(), serde_json::json!(units));
    props.insert(
        DND_PIN_PROP.to_string(),
        Value::Static(serde_json::Value::Object(spec)),
    );
}

// ---------------------------------------------------------------------------
// End-phase (runs after every applicator has merged into props)
// ---------------------------------------------------------------------------

/// Finalize the node's DnD props once every applicator has merged:
///
/// * `__dnd.sort` / `__dnd.pin` with a `null` group take the node's STATIC
///   `id` prop (`id` argument or `.id(...)` applicator) as their group.
/// * A reserved-state-mode `.pinboard` (no `bind` prop on the node) that
///   still has no group cannot address its `__dnd.<group>` subtree: warn
///   once and drop `__dnd.pin` (the node degrades to a plain container).
pub(crate) fn finalize_dnd_props(props: &mut Props) {
    let node_id = static_id_prop(props);

    for prop in [DND_SORT_PROP, DND_PIN_PROP] {
        let Some(Value::Static(serde_json::Value::Object(map))) = props.get(prop) else {
            continue;
        };
        if !map.get("group").is_some_and(|g| g.is_null()) {
            continue;
        }
        if let Some(id) = &node_id {
            let mut map = map.clone();
            map.insert("group".to_string(), serde_json::json!(id));
            props.insert(
                prop.to_string(),
                Value::Static(serde_json::Value::Object(map)),
            );
        }
    }

    if !props.contains_key("bind") && pin_group(props).is_none() && props.contains_key(DND_PIN_PROP)
    {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: reserved-state mode (no .bind) needs a group — pass group: or give the node an id; applicator ignored",
            PINBOARD_APPLICATOR
        );
        props.remove(DND_PIN_PROP);
    }
}

/// The group a reserved-mode pinboard node propagates to its draggable
/// descendants: `Some(group)` iff the node carries `__dnd.pin` with a
/// string group AND no `bind` prop (user-field mode never propagates —
/// the author binds `.translateX(@item.x)` themselves).
#[cfg(test)]
pub(crate) fn propagated_pin_group(props: &Props) -> Option<String> {
    if props.contains_key("bind") {
        return None;
    }
    pin_group(props)
}

// ---------------------------------------------------------------------------
// Item expansion (called from `reconcile/item_bindings.rs` with the key)
// ---------------------------------------------------------------------------

/// Stamp per-row DnD identity onto an expanded template element:
///
/// * `__dnd.source` present ⇒ `__dnd.key = item_key` (static string).
/// * `__dnd.pinGroup = G` present ⇒ unless the author set them, inject
///   `translateX.0` / `translateY.0` as state bindings to
///   `__dnd.G.<item_key>.x` / `.y`. A previously injected binding (a nested
///   `ForEach` stamps the outer key first) is overwritten with this key;
///   an author-set translate (any key whose base prop is `translateX` /
///   `translateY` and whose value is not an injected `__dnd` binding) wins.
#[cfg(test)]
pub(crate) fn stamp_item_identity(props: &mut Props, item_key: &str) {
    stamp_pin_identity(props, item_key, &serde_json::Value::Null);
}

pub(crate) fn stamp_pin_identity(props: &mut Props, item_key: &str, item: &serde_json::Value) {
    if !props.contains_key(DND_SOURCE_PROP) {
        return;
    }
    props.insert(
        DND_KEY_PROP.to_string(),
        Value::Static(serde_json::json!(item_key)),
    );
    let config = match props.get("__dnd.pinItem") {
        Some(Value::Static(value)) => value.clone(),
        _ => serde_json::json!({}),
    };
    let group = match props.get(DND_PIN_GROUP_PROP) {
        Some(Value::Static(serde_json::Value::String(group))) => Some(group.clone()),
        _ => None,
    };
    let bound = config.get("bind").and_then(serde_json::Value::as_str);
    if group.is_none() && bound.is_none() {
        return;
    }
    let fraction = config.get("units").and_then(serde_json::Value::as_str) == Some("fraction");
    if bound.is_some() && !fraction {
        return;
    }
    for (prop, base, axis, field) in [
        (TRANSLATE_X_PROP, "translateX", "X", "xKey"),
        (TRANSLATE_Y_PROP, "translateY", "Y", "yKey"),
    ] {
        if author_set_translate(props, base) {
            continue;
        }
        let coordinate = format!("__dnd.pin{axis}");
        let generated = format!("__dnd.pinGenerated{axis}");
        if props.contains_key(&coordinate) && !props.contains_key(&generated) {
            continue;
        }
        let default = if axis == "X" { "x" } else { "y" };
        let field = config
            .get(field)
            .and_then(serde_json::Value::as_str)
            .unwrap_or(default);
        let value = if bound.is_some() {
            // Same item substitution as an authored @item.<field> translate.
            // This also works when a row contains a nested module.
            Value::Static(item.get(field).cloned().unwrap_or(serde_json::Value::Null))
        } else {
            Value::Binding(Binding::state(vec![
                DND_STATE_KEY.to_string(),
                group.clone().unwrap(),
                item_key.to_string(),
                field.to_string(),
            ]))
        };
        props.insert(
            if fraction {
                coordinate
            } else {
                prop.to_string()
            },
            value,
        );
        props.insert(generated, Value::Static(serde_json::json!(true)));
    }
}

/// Propagate the whole position contract, with the nearest board winning.
/// Pixel user-field boards keep their existing explicit-translate contract.
pub(crate) fn propagate_pin_config(nodes: &mut [IRNode], props: &Props) {
    let Some(Value::Static(spec)) = props.get(DND_PIN_PROP) else {
        return;
    };
    let mut config = spec.clone();
    let bound = props.get("bind");
    if let Some(Value::Static(bind)) = bound {
        config["bind"] = bind.clone();
    }
    let group = if bound.is_none() {
        pin_group(props)
    } else {
        None
    };
    for node in nodes {
        crate::ir::walk::walk_ir_mut(node, &mut |n| {
            if let IRNode::Element(el) = n {
                if el.props.contains_key(DND_SOURCE_PROP) && !el.props.contains_key("__dnd.pinItem")
                {
                    el.props
                        .insert("__dnd.pinItem".into(), Value::Static(config.clone()));
                    if let Some(group) = &group {
                        el.props.insert(
                            DND_PIN_GROUP_PROP.into(),
                            Value::Static(serde_json::json!(group)),
                        );
                    }
                }
            }
        });
    }
}

/// True when the props carry a translate prop for `base` (`translateX` /
/// `translateY`, any `.idx` / `@bp` / `:state` suffix) that the AUTHOR set —
/// i.e. whose value is not a binding into the reserved `__dnd` subtree.
fn author_set_translate(props: &Props, base: &str) -> bool {
    props.iter().any(|(key, value)| {
        crate::ir::anim::base_prop_name(key) == base && !is_injected_translate(value)
    })
}

fn is_injected_translate(value: &Value) -> bool {
    matches!(
        value,
        Value::Binding(b) if b.is_state() && b.path.first().is_some_and(|s| s == DND_STATE_KEY)
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The pinboard group carried by `__dnd.pin`, when it is a string.
fn pin_group(props: &Props) -> Option<String> {
    match props.get(DND_PIN_PROP) {
        Some(Value::Static(serde_json::Value::Object(map))) => map
            .get("group")
            .and_then(|g| g.as_str())
            .map(str::to_string),
        _ => None,
    }
}

/// The node's static `id` — the `id` argument (`Stack(id: "board")`) or
/// the `.id("board")` applicator (`id.0`). Bound ids are not usable as a
/// lowering-time default.
fn static_id_prop(props: &Props) -> Option<String> {
    for key in ["id.0", "id"] {
        if let Some(Value::Static(serde_json::Value::String(s))) = props.get(key) {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

fn json_opt_string(s: Option<String>) -> serde_json::Value {
    match s {
        Some(s) => serde_json::json!(s),
        None => serde_json::Value::Null,
    }
}

/// A static, non-empty string argument (quoted or bare token). Bindings
/// and non-strings warn and yield `None`.
fn static_string(channel: &str, field: &str, value: &ParserValue) -> Option<String> {
    match value {
        ParserValue::String(s) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, field, &token);
                None
            } else if token.is_empty() {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: {} must be a non-empty string; ignored",
                    channel,
                    field
                );
                None
            } else {
                Some(token)
            }
        }
        ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
            warn_binding(channel, field, r);
            None
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a string, got {:?}; ignored",
                channel,
                field,
                other
            );
            None
        }
    }
}

/// A static string argument restricted to `vocab`. Unknown tokens warn and
/// yield `None` (the caller keeps its default).
fn static_token(channel: &str, field: &str, value: &ParserValue, vocab: &[&str]) -> Option<String> {
    let token = static_string(channel, field, value)?;
    if vocab.contains(&token.as_str()) {
        Some(token)
    } else {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: unknown {} '{}' (expected one of {}); using default",
            channel,
            field,
            token,
            vocab.join("|")
        );
        None
    }
}

/// A static boolean argument. Anything else warns and yields `None`.
fn static_bool(channel: &str, field: &str, value: &ParserValue) -> Option<bool> {
    match value {
        ParserValue::Boolean(b) => Some(*b),
        ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
            warn_binding(channel, field, r);
            None
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a boolean, got {:?}; ignored",
                channel,
                field,
                other
            );
            None
        }
    }
}

/// A bindable argument of any type: static values, bindings and template
/// strings pass through the standard parser-value conversion. Action and
/// resource references are not data and are dropped with a warning.
fn bindable_any(channel: &str, field: &str, value: &ParserValue) -> Option<Value> {
    match crate::ir::expand::parser_value_to_ir(value) {
        v @ (Value::Static(_) | Value::Binding(_) | Value::TemplateString { .. }) => Some(v),
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a value or binding, got {:?}; ignored",
                channel,
                field,
                other
            );
            None
        }
    }
}

/// A bindable string argument: a static value must be a non-empty string;
/// bindings/templates pass through (they resolve per render).
fn bindable_string(channel: &str, field: &str, value: &ParserValue) -> Option<Value> {
    match bindable_any(channel, field, value)? {
        Value::Static(serde_json::Value::String(s)) if s.is_empty() => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a non-empty string; ignored",
                channel,
                field
            );
            None
        }
        Value::Static(v) if !v.is_string() => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a string (bindings allowed), got {}; ignored",
                channel,
                field,
                v
            );
            None
        }
        v => Some(v),
    }
}

/// A bindable boolean argument: a static value must be a boolean;
/// bindings/templates pass through (they resolve per render).
fn bindable_bool(channel: &str, field: &str, value: &ParserValue) -> Option<Value> {
    match bindable_any(channel, field, value)? {
        Value::Static(v) if !v.is_boolean() => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a boolean (bindings allowed), got {}; ignored",
                channel,
                field,
                v
            );
            None
        }
        v => Some(v),
    }
}

/// DnD applicators take flat NAMED arguments only; positionals warn.
fn warn_positionals(channel: &str, applicator: &ApplicatorSpecification) {
    for arg in &applicator.arguments.arguments {
        if let Argument::Positioned { value, .. } = arg {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: unsupported positional argument {:?}; ignored (arguments are named, e.g. group: \"cards\")",
                channel,
                value
            );
        }
    }
}

fn warn_unknown_arg(channel: &str, name: &str) {
    crate::log_warn!(
        LogScope::Engine,
        ".{}: unknown argument '{}'; ignored",
        channel,
        name
    );
}

fn warn_binding(channel: &str, field: &str, what: &str) {
    crate::log_warn!(
        LogScope::Engine,
        ".{}: {} must be static — bindings are not supported here ('{}'); ignored",
        channel,
        field,
        what
    );
}

fn is_binding_like(token: &str) -> bool {
    token.contains("@{") || token.starts_with('@')
}

/// Trim surrounding `"` or `'` from a parser string token.
fn unquote(s: &str) -> String {
    s.trim_matches(|c: char| c == '"' || c == '\'').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_parser::ArgumentList;
    use serde_json::json;

    fn applicator(name: &str, args: Vec<Argument>) -> ApplicatorSpecification {
        ApplicatorSpecification {
            name: name.to_string(),
            arguments: ArgumentList::new(args),
            children: vec![],
            internal_id: "test".to_string(),
        }
    }

    fn positional(value: ParserValue) -> Argument {
        Argument::Positioned { position: 0, value }
    }

    fn named(key: &str, value: ParserValue) -> Argument {
        Argument::Named {
            key: key.to_string(),
            value,
        }
    }

    fn quoted(s: &str) -> ParserValue {
        ParserValue::String(format!("\"{s}\""))
    }

    fn bare(s: &str) -> ParserValue {
        ParserValue::String(s.to_string())
    }

    fn lower(name: &str, args: Vec<Argument>) -> Props {
        let mut props = Props::new();
        assert!(lower_dnd_applicator(&applicator(name, args), &mut props));
        props
    }

    fn static_json(props: &Props, key: &str) -> serde_json::Value {
        match props.get(key) {
            Some(Value::Static(v)) => v.clone(),
            other => panic!("expected static {key}, got {other:?}"),
        }
    }

    // ── .draggable ──────────────────────────────────────────────

    #[test]
    fn draggable_defaults() {
        let props = lower("draggable", vec![]);
        assert_eq!(
            static_json(&props, DND_SOURCE_PROP),
            json!({"group": null, "handle": false, "activation": "auto"})
        );
        assert!(!props.contains_key(DND_SOURCE_PAYLOAD_PROP));
        assert!(!props.contains_key(DND_SOURCE_ENABLED_PROP));
        assert_eq!(props.len(), 1);
    }

    #[test]
    fn draggable_custom_args() {
        let props = lower(
            "draggable",
            vec![
                named("group", quoted("cards")),
                named("handle", ParserValue::Boolean(true)),
                named("activation", bare("press")),
                named("payload", ParserValue::Reference("item".to_string())),
                named(
                    "enabled",
                    ParserValue::Reference("state.canDrag".to_string()),
                ),
            ],
        );
        assert_eq!(
            static_json(&props, DND_SOURCE_PROP),
            json!({"group": "cards", "handle": true, "activation": "press"})
        );
        match props.get(DND_SOURCE_PAYLOAD_PROP) {
            Some(Value::Binding(b)) => assert!(b.is_item() && b.path.is_empty()),
            other => panic!("payload should bind to the item, got {other:?}"),
        }
        match props.get(DND_SOURCE_ENABLED_PROP) {
            Some(Value::Binding(b)) => assert_eq!(b.full_path(), "canDrag"),
            other => panic!("enabled should bind to state, got {other:?}"),
        }
    }

    #[test]
    fn draggable_static_payload_and_enabled() {
        let props = lower(
            "draggable",
            vec![
                named("payload", quoted("hello")),
                named("enabled", ParserValue::Boolean(false)),
            ],
        );
        assert_eq!(static_json(&props, DND_SOURCE_PAYLOAD_PROP), json!("hello"));
        assert_eq!(static_json(&props, DND_SOURCE_ENABLED_PROP), json!(false));
    }

    #[test]
    fn draggable_malformed_falls_back() {
        let props = lower(
            "draggable",
            vec![
                positional(quoted("cards")), // positionals are ignored
                named("group", ParserValue::Reference("state.g".to_string())), // binding → dropped
                named("handle", quoted("yes")), // not a bool
                named("activation", bare("teleport")), // unknown token
                named("enabled", ParserValue::Number(1.0)), // not a bool
                named("payload", ParserValue::Reference("actions.go".to_string())), // not data
                named("bogus", ParserValue::Number(1.0)),
            ],
        );
        assert_eq!(
            static_json(&props, DND_SOURCE_PROP),
            json!({"group": null, "handle": false, "activation": "auto"})
        );
        assert!(!props.contains_key(DND_SOURCE_PAYLOAD_PROP));
        assert!(!props.contains_key(DND_SOURCE_ENABLED_PROP));
        assert!(!props.contains_key("draggable.0"));
    }

    // ── .dropZone ───────────────────────────────────────────────

    #[test]
    fn drop_zone_defaults() {
        let props = lower("dropZone", vec![]);
        assert_eq!(
            static_json(&props, DND_ZONE_PROP),
            json!({"group": null, "band": 0.5})
        );
        assert!(!props.contains_key(DND_ZONE_ID_PROP));
        assert!(!props.contains_key(DND_ZONE_ENABLED_PROP));
    }

    #[test]
    fn drop_zone_custom_and_bindable() {
        let props = lower(
            "dropZone",
            vec![
                named("group", quoted("fs")),
                named("id", ParserValue::Reference("item.id".to_string())),
                named(
                    "enabled",
                    ParserValue::Reference("item.isFolder".to_string()),
                ),
                named("band", ParserValue::Number(0.3)),
            ],
        );
        assert_eq!(
            static_json(&props, DND_ZONE_PROP),
            json!({"group": "fs", "band": 0.3})
        );
        assert!(matches!(props.get(DND_ZONE_ID_PROP), Some(Value::Binding(b)) if b.is_item()));
        assert!(matches!(props.get(DND_ZONE_ENABLED_PROP), Some(Value::Binding(b)) if b.is_item()));
    }

    #[test]
    fn drop_zone_files() {
        let props = lower(
            "dropZone",
            vec![named("files", ParserValue::Boolean(true)), named("accept", quoted("image/*,.pdf"))],
        );
        assert_eq!(
            static_json(&props, DND_ZONE_PROP),
            json!({"group": null, "band": 0.5, "files": true, "accept": "image/*,.pdf"})
        );

        let props = lower("dropZone", vec![named("files", ParserValue::Boolean(true))]);
        assert_eq!(
            static_json(&props, DND_ZONE_PROP),
            json!({"group": null, "band": 0.5, "files": true, "accept": null})
        );

        // `files: false`, a non-bool, or `accept:` alone leave the wire unchanged.
        for args in [
            vec![named("files", ParserValue::Boolean(false))],
            vec![named("files", quoted("yes"))],
            vec![named("accept", quoted("image/*"))],
        ] {
            let props = lower("dropZone", args);
            assert_eq!(static_json(&props, DND_ZONE_PROP), json!({"group": null, "band": 0.5}));
        }
    }

    #[test]
    fn drop_zone_static_id_and_template_id() {
        let props = lower("dropZone", vec![named("id", quoted("trash"))]);
        assert_eq!(static_json(&props, DND_ZONE_ID_PROP), json!("trash"));

        let props = lower("dropZone", vec![named("id", quoted("zone-@{item.id}"))]);
        assert!(matches!(
            props.get(DND_ZONE_ID_PROP),
            Some(Value::TemplateString { .. })
        ));
    }

    #[test]
    fn drop_zone_malformed_falls_back() {
        let props = lower(
            "dropZone",
            vec![
                named("band", ParserValue::Number(1.5)), // out of range
                named("id", ParserValue::Number(3.0)),   // not a string
                named("enabled", quoted("yes")),         // not a bool
                named("group", quoted("")),              // empty
            ],
        );
        assert_eq!(
            static_json(&props, DND_ZONE_PROP),
            json!({"group": null, "band": 0.5})
        );
        assert!(!props.contains_key(DND_ZONE_ID_PROP));
        assert!(!props.contains_key(DND_ZONE_ENABLED_PROP));
    }

    // ── .sortable ───────────────────────────────────────────────

    #[test]
    fn sortable_defaults_and_custom() {
        let props = lower("sortable", vec![]);
        assert_eq!(
            static_json(&props, DND_SORT_PROP),
            json!({"group": null, "axis": "y"})
        );

        let props = lower(
            "sortable",
            vec![named("group", quoted("board")), named("axis", bare("x"))],
        );
        assert_eq!(
            static_json(&props, DND_SORT_PROP),
            json!({"group": "board", "axis": "x"})
        );
    }

    #[test]
    fn sortable_unknown_axis_falls_back() {
        let props = lower("sortable", vec![named("axis", bare("z"))]);
        assert_eq!(
            static_json(&props, DND_SORT_PROP),
            json!({"group": null, "axis": "y"})
        );
    }

    // ── .pinboard ───────────────────────────────────────────────

    #[test]
    fn pinboard_defaults_and_custom() {
        let props = lower("pinboard", vec![named("group", quoted("board"))]);
        assert_eq!(
            static_json(&props, DND_PIN_PROP),
            json!({
                "group": "board", "xKey": "x", "yKey": "y",
                "grid": null, "bounds": "clamp", "units": "px"
            })
        );

        let props = lower(
            "pinboard",
            vec![
                named("group", quoted("seats")),
                named("x", quoted("left")),
                named("y", quoted("top")),
                named("grid", ParserValue::Number(8.0)),
                named("bounds", bare("free")),
                named("units", bare("fraction")),
            ],
        );
        assert_eq!(
            static_json(&props, DND_PIN_PROP),
            json!({
                "group": "seats", "xKey": "left", "yKey": "top",
                "grid": 8.0, "bounds": "free", "units": "fraction"
            })
        );
    }

    #[test]
    fn pinboard_malformed_falls_back() {
        let props = lower(
            "pinboard",
            vec![
                named("group", quoted("b")),
                named("grid", ParserValue::Number(-4.0)),
                named("bounds", bare("wrap")),
                named("units", bare("em")),
                named("x", ParserValue::Reference("state.k".to_string())),
            ],
        );
        assert_eq!(
            static_json(&props, DND_PIN_PROP),
            json!({
                "group": "b", "xKey": "x", "yKey": "y",
                "grid": null, "bounds": "clamp", "units": "px"
            })
        );
    }

    // ── finalize / propagation ─────────────────────────────────

    #[test]
    fn finalize_defaults_group_from_id_prop() {
        let mut props = lower("sortable", vec![]);
        props.insert("id".to_string(), Value::Static(json!("list")));
        finalize_dnd_props(&mut props);
        assert_eq!(static_json(&props, DND_SORT_PROP)["group"], json!("list"));

        let mut props = lower("pinboard", vec![]);
        props.insert("id.0".to_string(), Value::Static(json!("board")));
        finalize_dnd_props(&mut props);
        assert_eq!(static_json(&props, DND_PIN_PROP)["group"], json!("board"));
        assert_eq!(propagated_pin_group(&props), Some("board".to_string()));
    }

    #[test]
    fn finalize_drops_reserved_mode_pin_without_group() {
        let mut props = lower("pinboard", vec![]);
        finalize_dnd_props(&mut props);
        assert!(!props.contains_key(DND_PIN_PROP));
    }

    #[test]
    fn finalize_keeps_user_field_mode_pin_without_group() {
        let mut props = lower("pinboard", vec![named("x", quoted("px"))]);
        props.insert("bind".to_string(), Value::Static(json!("seats")));
        finalize_dnd_props(&mut props);
        assert_eq!(static_json(&props, DND_PIN_PROP)["group"], json!(null));
        // user-field mode never propagates a pin group
        assert_eq!(propagated_pin_group(&props), None);
    }

    #[test]
    fn explicit_group_beats_id_prop() {
        let mut props = lower("sortable", vec![named("group", quoted("g"))]);
        props.insert("id".to_string(), Value::Static(json!("list")));
        finalize_dnd_props(&mut props);
        assert_eq!(static_json(&props, DND_SORT_PROP)["group"], json!("g"));
    }

    // ── item identity stamping ─────────────────────────────────

    #[test]
    fn stamp_sets_key_only_on_sources() {
        let mut props = Props::new();
        stamp_item_identity(&mut props, "n1");
        assert!(props.is_empty());

        let mut props = lower("draggable", vec![]);
        stamp_item_identity(&mut props, "n1");
        assert_eq!(static_json(&props, DND_KEY_PROP), json!("n1"));
        assert!(!props.contains_key(TRANSLATE_X_PROP));
    }

    #[test]
    fn stamp_injects_translate_bindings_for_pin_group() {
        let mut props = lower("draggable", vec![]);
        props.insert(
            DND_PIN_GROUP_PROP.to_string(),
            Value::Static(json!("board")),
        );
        stamp_item_identity(&mut props, "n1");
        for (prop, axis) in [(TRANSLATE_X_PROP, "x"), (TRANSLATE_Y_PROP, "y")] {
            match props.get(prop) {
                Some(Value::Binding(b)) => {
                    assert!(b.is_state());
                    assert_eq!(b.full_path(), format!("__dnd.board.n1.{axis}"));
                }
                other => panic!("{prop} should be a state binding, got {other:?}"),
            }
        }
    }

    #[test]
    fn stamp_respects_author_translate_but_overwrites_injected() {
        let mut props = lower("draggable", vec![]);
        props.insert(
            DND_PIN_GROUP_PROP.to_string(),
            Value::Static(json!("board")),
        );
        props.insert(TRANSLATE_X_PROP.to_string(), Value::Static(json!(12)));
        stamp_item_identity(&mut props, "outer");
        assert_eq!(static_json(&props, TRANSLATE_X_PROP), json!(12));
        assert!(matches!(
            props.get(TRANSLATE_Y_PROP),
            Some(Value::Binding(_))
        ));

        // A nested ForEach re-stamps with the inner key: the injected Y
        // binding follows, the author's X stays.
        stamp_item_identity(&mut props, "inner");
        assert_eq!(static_json(&props, DND_KEY_PROP), json!("inner"));
        assert_eq!(static_json(&props, TRANSLATE_X_PROP), json!(12));
        match props.get(TRANSLATE_Y_PROP) {
            Some(Value::Binding(b)) => assert_eq!(b.full_path(), "__dnd.board.inner.y"),
            other => panic!("expected re-stamped binding, got {other:?}"),
        }
    }

    #[test]
    fn non_dnd_applicator_is_not_lowered() {
        let mut props = Props::new();
        assert!(!lower_dnd_applicator(
            &applicator("padding", vec![positional(ParserValue::Number(4.0))]),
            &mut props
        ));
        assert!(props.is_empty());
        assert!(!is_dnd_applicator("onDrop"));
        assert!(is_dnd_applicator("dropZone"));
    }
}
