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
    let mut resolved = IndexMap::new();
    // Lazily built evaluator — only allocated when we hit a TemplateString prop.
    let mut evaluator: Option<exprimo::Evaluator> = None;

    for (key, value) in props {
        let resolved_value = match value {
            Value::Static(v) => v.clone(),
            Value::Binding(binding) => {
                if binding.is_item() {
                    // Evaluate item binding
                    if let Some(item_value) = item {
                        evaluate_item_binding(binding, item_value)
                            .unwrap_or(serde_json::Value::Null)
                    } else {
                        serde_json::Value::Null
                    }
                } else if binding.is_data_source() {
                    // Evaluate data source binding against its provider's state
                    if let (Some(provider), Some(ds_map)) = (binding.provider(), data_sources) {
                        if let Some(ds_state) = ds_map.get(provider) {
                            evaluate_binding_path(binding, ds_state)
                                .unwrap_or(serde_json::Value::Null)
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
                let eval = evaluator.get_or_insert_with(|| {
                    crate::reactive::build_evaluator(state, item, data_sources)
                });
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
        };
        resolved.insert(key.clone(), resolved_value);
    }

    Arc::new(resolved)
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
            Value::Binding(Binding::data_source(
                "firebase",
                vec!["users".to_string()],
            )),
        );

        let state = json!({});
        let data_sources = indexmap::IndexMap::new(); // empty — no firebase registered

        let resolved = resolve_props_with_data_sources(&props, &state, &data_sources);
        assert_eq!(resolved.get("data"), Some(&json!(null)));
    }
}
