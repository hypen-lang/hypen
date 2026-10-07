//! Shared prop resolution and binding evaluation.
//!
//! These functions are used by both the initial tree builder (`tree.rs`),
//! the reconciler/differ (`diff.rs`), and the dirty-node renderer (`render.rs`).
//! Keeping a single copy avoids the subtle divergence bugs that come from
//! copy-pasting the same path-walking logic in three places.

use super::tree::ResolvedProps;
use crate::ir::Value;
use crate::reactive::Binding;
use indexmap::IndexMap;
use std::sync::Arc;

/// Navigate a binding path against a root JSON value.
/// If the path is empty, returns the root value itself (handles bare `@item`).
pub fn evaluate_binding_path(
    binding: &Binding,
    root: &serde_json::Value,
) -> Option<serde_json::Value> {
    if binding.path.is_empty() {
        return Some(root.clone());
    }

    let mut current = root;
    for segment in &binding.path {
        current = current.get(segment)?;
    }
    Some(current.clone())
}

/// Evaluate a state binding (delegates to [`evaluate_binding_path`]).
pub fn evaluate_binding(binding: &Binding, state: &serde_json::Value) -> Option<serde_json::Value> {
    evaluate_binding_path(binding, state)
}

/// Borrowing variant of [`evaluate_binding`]: navigate to the bound value
/// without cloning it. The hot list-update path iterates the bound array
/// directly out of state — cloning a 1,000-row array per re-render, only to
/// drop it after the pass, was pure allocator churn.
pub fn evaluate_binding_ref<'a>(
    binding: &Binding,
    state: &'a serde_json::Value,
) -> Option<&'a serde_json::Value> {
    let mut current = state;
    for segment in &binding.path {
        current = current.get(segment)?;
    }
    Some(current)
}

/// Evaluate an item binding against the item object (delegates to [`evaluate_binding_path`]).
pub fn evaluate_item_binding(
    binding: &Binding,
    item: &serde_json::Value,
) -> Option<serde_json::Value> {
    evaluate_binding_path(binding, item)
}

/// Resolve props by evaluating bindings against state (no item context).
pub fn resolve_props(props: &IndexMap<String, Value>, state: &serde_json::Value) -> ResolvedProps {
    resolve_props_full(props, state, None, None)
}

/// Resolve props by evaluating bindings against state with data sources (no item context).
pub fn resolve_props_with_data_sources(
    props: &IndexMap<String, Value>,
    state: &serde_json::Value,
    data_sources: &IndexMap<String, serde_json::Value>,
) -> ResolvedProps {
    resolve_props_full(props, state, None, Some(data_sources))
}

/// Resolve props with optional item context (for list iteration).
pub fn resolve_props_with_item(
    props: &IndexMap<String, Value>,
    state: &serde_json::Value,
    item: Option<&serde_json::Value>,
) -> ResolvedProps {
    resolve_props_full(props, state, item, None)
}

/// Full prop resolution with all contexts: state, item, and data sources.
pub fn resolve_props_full(
    props: &IndexMap<String, Value>,
    state: &serde_json::Value,
    item: Option<&serde_json::Value>,
    data_sources: Option<&IndexMap<String, serde_json::Value>>,
) -> ResolvedProps {
    resolve_props_iter(
        props.iter().map(|(k, v)| (k.as_str(), v)),
        state,
        item,
        data_sources,
    )
}

/// [`resolve_props_full`] over any ordered `(key, value)` sequence — the
/// instance tree's raw props are a layered map (`reconcile::layered`), not
/// a flat `IndexMap`, and re-resolve through this same loop.
pub(crate) fn resolve_props_iter<'a>(
    props: impl Iterator<Item = (&'a str, &'a Value)>,
    state: &serde_json::Value,
    item: Option<&serde_json::Value>,
    data_sources: Option<&IndexMap<String, serde_json::Value>>,
) -> ResolvedProps {
    let mut resolved = IndexMap::new();
    // Lazily built evaluator — only allocated when we hit a TemplateString prop.
    let mut evaluator: Option<exprimo::Evaluator> = None;

    for (key, value) in props {
        match resolve_single_value(value, state, item, data_sources, &mut evaluator) {
            Some(v) => {
                resolved.insert(key.to_string(), v);
            }
            None => continue,
        }
    }

    Arc::new(resolved)
}

/// Resolve ONE raw prop value against state/item/data-source context.
///
/// `None` means the prop is ABSENT (a `.states` switch with no matching case
/// and no default) — callers must omit the key entirely. This is the single
/// source of truth for value resolution: [`resolve_props_full`] loops over
/// it, and the compiled binding-map fast path
/// ([`binding_map`](super::binding_map)) resolves individual changed fields
/// through it so the two paths can never drift.
pub(crate) fn resolve_single_value(
    value: &Value,
    state: &serde_json::Value,
    item: Option<&serde_json::Value>,
    data_sources: Option<&IndexMap<String, serde_json::Value>>,
    evaluator: &mut Option<exprimo::Evaluator>,
) -> Option<serde_json::Value> {
    let resolved_value = match value {
        Value::Static(v) => v.clone(),
        Value::Binding(binding) => {
            if binding.is_item() {
                // Evaluate item binding
                if let Some(item_value) = item {
                    evaluate_item_binding(binding, item_value).unwrap_or(serde_json::Value::Null)
                } else {
                    serde_json::Value::Null
                }
            } else if binding.is_data_source() {
                // Evaluate data source binding against its provider's state
                if let (Some(provider), Some(ds_map)) = (binding.provider(), data_sources) {
                    if let Some(ds_state) = ds_map.get(provider) {
                        evaluate_binding_path(binding, ds_state).unwrap_or(serde_json::Value::Null)
                    } else {
                        serde_json::Value::Null
                    }
                } else {
                    serde_json::Value::Null
                }
            } else {
                // Evaluate state binding
                evaluate_binding(binding, state).unwrap_or(serde_json::Value::Null)
            }
        }
        Value::TemplateString { template, .. } => {
            // Build evaluator once and reuse for all template strings
            let eval = evaluator
                .get_or_insert_with(|| crate::reactive::build_evaluator(state, item, data_sources));
            match crate::reactive::evaluate_template_string(template, eval) {
                Ok(result) => serde_json::Value::String(result),
                Err(e) => {
                    // Surface the failure through the existing logger so devs
                    // see why a template is rendering its raw DSL instead of
                    // the resolved value. Silent fallback is what made
                    // template bugs invisible in production.
                    crate::log_warn!(
                        crate::logger::LogScope::Reconciler,
                        "template evaluation failed for {:?}: {}",
                        template,
                        e
                    );
                    serde_json::Value::String(template.clone())
                }
            }
        }
        Value::Action(action) => {
            // Actions are serialized with @ prefix for renderer to detect
            serde_json::Value::String(format!("@{}", action))
        }
        Value::Resource(name) => {
            // Resource references are kept as @resources.name for the icon resolver
            serde_json::Value::String(format!("@resources.{}", name))
        }
        Value::StateSwitch {
            path,
            cases,
            default,
        } => {
            // `.states` pose switch: no matching case and no default
            // means the prop is ABSENT — omit the key entirely, exactly
            // as if it were never set. Resolution always yields plain
            // JSON, so the variant never reaches the wire.
            resolve_state_switch(path, cases, default.as_ref(), state)?
        }
    };
    Some(resolved_value)
}

/// Resolve a [`Value::StateSwitch`]: read the state at `path`, stringify a
/// scalar result (string as-is, number/bool via `to_string`), and pick the
/// matching case. A missing path, non-scalar value, or unmatched label falls
/// back to `default`; `None` means the prop resolves to absent.
pub fn resolve_state_switch(
    path: &str,
    cases: &IndexMap<String, serde_json::Value>,
    default: Option<&serde_json::Value>,
    state: &serde_json::Value,
) -> Option<serde_json::Value> {
    let mut current = Some(state);
    for segment in path.split('.') {
        current = current.and_then(|v| v.get(segment));
    }
    let label = match current {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(serde_json::Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    };
    label
        .and_then(|l| cases.get(&l).cloned())
        .or_else(|| default.cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_evaluate_binding_simple() {
        let state = json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        });

        let name_binding = Binding::state(vec!["user".to_string(), "name".to_string()]);
        let age_binding = Binding::state(vec!["user".to_string(), "age".to_string()]);
        let missing_binding = Binding::state(vec!["user".to_string(), "email".to_string()]);

        assert_eq!(
            evaluate_binding(&name_binding, &state),
            Some(json!("Alice"))
        );
        assert_eq!(evaluate_binding(&age_binding, &state), Some(json!(30)));
        assert_eq!(evaluate_binding(&missing_binding, &state), None);
    }

    #[test]
    fn test_evaluate_binding_path_empty() {
        let root = json!({"hello": "world"});
        let binding = Binding::state(vec![]);
        assert_eq!(evaluate_binding_path(&binding, &root), Some(root.clone()));
    }

    #[test]
    fn test_evaluate_item_binding_bare() {
        let item = json!("just a string");
        let binding = Binding::item(vec![]);
        assert_eq!(evaluate_item_binding(&binding, &item), Some(item.clone()));
    }

    #[test]
    fn test_evaluate_item_binding_nested() {
        let item = json!({"name": "Bob", "address": {"city": "NYC"}});
        let binding = Binding::item(vec!["address".to_string(), "city".to_string()]);
        assert_eq!(evaluate_item_binding(&binding, &item), Some(json!("NYC")));
    }

    #[test]
    fn test_resolve_props_static() {
        let mut props = IndexMap::new();
        props.insert("text".to_string(), Value::Static(json!("Hello")));
        let state = json!({});
        let resolved = resolve_props(&props, &state);
        assert_eq!(resolved.get("text"), Some(&json!("Hello")));
    }

    #[test]
    fn test_resolve_props_binding() {
        let mut props = IndexMap::new();
        props.insert(
            "text".to_string(),
            Value::Binding(Binding::state(vec!["name".to_string()])),
        );
        let state = json!({"name": "Alice"});
        let resolved = resolve_props(&props, &state);
        assert_eq!(resolved.get("text"), Some(&json!("Alice")));
    }

    #[test]
    fn test_resolve_props_action() {
        let mut props = IndexMap::new();
        props.insert("onClick".to_string(), Value::Action("submit".to_string()));
        let state = json!({});
        let resolved = resolve_props(&props, &state);
        assert_eq!(resolved.get("onClick"), Some(&json!("@submit")));
    }

    #[test]
    fn test_resolve_props_data_source_binding() {
        let mut props = IndexMap::new();
        props.insert(
            "messages".to_string(),
            Value::Binding(Binding::data_source(
                "spacetime",
                vec!["message".to_string()],
            )),
        );

        let state = json!({});
        let mut data_sources = indexmap::IndexMap::new();
        data_sources.insert(
            "spacetime".to_string(),
            json!({
                "message": [
                    {"id": 1, "text": "Hello"},
                    {"id": 2, "text": "World"}
                ]
            }),
        );

        let resolved = resolve_props_with_data_sources(&props, &state, &data_sources);
        let messages = resolved.get("messages").unwrap();
        assert!(messages.is_array());
        assert_eq!(messages.as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_resolve_props_data_source_missing_provider() {
        let mut props = IndexMap::new();
        props.insert(
            "data".to_string(),
            Value::Binding(Binding::data_source("firebase", vec!["users".to_string()])),
        );

        let state = json!({});
        let data_sources = indexmap::IndexMap::new(); // empty — no firebase registered

        let resolved = resolve_props_with_data_sources(&props, &state, &data_sources);
        assert_eq!(resolved.get("data"), Some(&json!(null)));
    }
}
