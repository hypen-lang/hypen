//! Conditional branch evaluation and pattern matching.
//!
//! Pure evaluation logic for `When`/`If` control-flow constructs.
//! Given an evaluated condition value and a list of branches, these
//! functions determine which branch (if any) matches — without
//! touching the instance tree or generating patches.

use super::resolve::{evaluate_binding, evaluate_binding_path};
use crate::ir::{ConditionalBranch, IRNode, RouterRoute, Value};
use crate::reactive::{build_evaluator, evaluate_template_string};

/// Data sources type alias for readability
type DataSources = indexmap::IndexMap<String, serde_json::Value>;

/// Emit a one-line warning when an `If`/`When` expression fails to evaluate.
/// Without this, an errored condition silently collapses to `false`, making
/// issues like `state.searchQuery.length == 0` on a string (exprimo rejects
/// `.length` on non-array/non-object) invisible: the branch just never
/// renders, with no hint as to why.
///
/// Routes through the engine's existing logger (`crate::logger`) rather than
/// reaching into `web_sys::console` directly — that keeps the reconcile
/// module renderer-agnostic and lets the host swap/silence the destination.
fn warn_condition_error(what: &str, expr: &str, err: impl std::fmt::Display) {
    crate::log_warn!(
        crate::logger::LogScope::Reconciler,
        "{} {:?} failed to evaluate: {} (branch treated as false)",
        what,
        expr,
        err
    );
}

/// Resolve a binding against the appropriate source (state or data sources).
///
/// DataSource bindings (e.g., `@spacetime.messages`) are evaluated against
/// the provider's data rather than module state.
fn resolve_binding(
    binding: &crate::reactive::Binding,
    state: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> serde_json::Value {
    if binding.is_data_source() {
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
        evaluate_binding(binding, state).unwrap_or(serde_json::Value::Null)
    }
}

/// Evaluate a Value against state (with optional data sources)
pub(crate) fn evaluate_value(
    value: &Value,
    state: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> serde_json::Value {
    match value {
        Value::Static(v) => v.clone(),
        Value::Binding(binding) => resolve_binding(binding, state, data_sources),
        Value::TemplateString { template, .. } => {
            // For pure expressions (entire template is @{...}), preserve the typed
            // result so that boolean/numeric comparisons work correctly.
            // e.g., "@{state.x == 'y'}" should evaluate to Bool(true), not String("true")
            let trimmed = template.trim();
            if trimmed.starts_with("@{")
                && trimmed.ends_with('}')
                && !trimmed[2..trimmed.len() - 1].contains("@{")
            {
                let expr = &trimmed[2..trimmed.len() - 1];
                let context = crate::reactive::build_expression_context(state, None, data_sources);
                match crate::reactive::evaluate_expression(expr, &context) {
                    Ok(result) => result,
                    Err(e) => {
                        warn_condition_error("condition expression", expr, e);
                        serde_json::Value::Null
                    }
                }
            } else {
                let evaluator = build_evaluator(state, None, data_sources);
                match evaluate_template_string(template, &evaluator) {
                    Ok(result) => serde_json::Value::String(result),
                    Err(e) => {
                        warn_condition_error("condition template", template, e);
                        serde_json::Value::String(template.clone())
                    }
                }
            }
        }
        Value::Action(action) => serde_json::Value::String(format!("@{}", action)),
        Value::Resource(name) => serde_json::Value::String(format!("@resources.{}", name)),
    }
}

/// Find the matching branch for a conditional value
pub(crate) fn find_matching_branch<'a>(
    evaluated_value: &serde_json::Value,
    branches: &'a [ConditionalBranch],
    fallback: Option<&'a [IRNode]>,
    state: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> Option<&'a [IRNode]> {
    for branch in branches {
        if pattern_matches(evaluated_value, &branch.pattern, state, data_sources) {
            return Some(&branch.children);
        }
    }

    fallback
}

/// Find the matching route along with a stable key identifying it.
///
/// Returns `(key, children)` where:
///   - `key`    is the matched route pattern (for cache keying), or the
///              sentinel `"__fallback__"` when the fallback branch is
///              rendered, or `None` when there's no fallback and no match.
///   - `children` is the slice of IR nodes to render.
///
/// Used by the Router reconciler to key detached-subtree caches by
/// the route that produced them.
pub(crate) fn find_matching_route_with_key<'a>(
    location: &str,
    routes: &'a [RouterRoute],
    fallback: Option<&'a [IRNode]>,
) -> Option<(String, &'a [IRNode])> {
    for route in routes {
        if route_matches(&route.path, location) {
            return Some((route.path.clone(), &route.children));
        }
    }
    fallback.map(|children| ("__fallback__".to_string(), children))
}

/// Match a route pattern against a concrete location.
///
/// Delegates to `crate::portable::route::match_path`, the single
/// canonical route matcher shared with every SDK's runtime router
/// (Kotlin/Swift/Go/TypeScript). The Router IR node uses the **same**
/// semantics the SDKs do for `ManagedRouter.matchPath(...)`: exact
/// segments, `:param` captures, and a trailing `/*` wildcard.
///
/// The cache key in the Router reconciler is the pattern itself
/// (`route.path`), not the concrete location — so `/profile/42` and
/// `/profile/99` both hit the same cache bucket when matched against
/// a `Route(path: "/profile/:id")`. Keep-alive across param changes
/// is intentional; route params resolve through state bindings, not
/// through recreating the subtree.
fn route_matches(pattern: &str, location: &str) -> bool {
    crate::portable::route::match_path(pattern, location).is_some()
}

/// Check if a pattern matches an evaluated value
/// Supports:
/// - Static values: exact equality matching
/// - Bindings: evaluate the binding against state and check truthiness
/// - TemplateStrings: evaluate as expression with `value` available
fn pattern_matches(
    evaluated_value: &serde_json::Value,
    pattern: &Value,
    state: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> bool {
    match pattern {
        Value::Static(pattern_value) => values_match(evaluated_value, pattern_value, data_sources),
        Value::Binding(binding) => {
            // Evaluate the binding against state (or data sources) and check truthiness.
            // This allows: Case(match: @state.isAdmin) or Case(match: @spacetime.connected)
            let resolved = resolve_binding(binding, state, data_sources);
            is_truthy(&resolved)
        }
        Value::TemplateString { template, .. } => {
            // Expression pattern: evaluate with `value` variable available
            // This allows: Case(when: "@{value > 100}") or Case(match: "@{value == 'loading'}")
            evaluate_expression_pattern(template, evaluated_value, data_sources)
        }
        Value::Action(_) | Value::Resource(_) => false, // Actions/resources don't make sense as patterns
    }
}

/// Evaluate an expression pattern against a value
/// The expression has access to `value` which is the evaluated When condition
fn evaluate_expression_pattern(
    template: &str,
    value: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> bool {
    use crate::reactive::evaluate_expression;
    use std::collections::HashMap;

    // Build a context with the value available
    let mut context: HashMap<String, serde_json::Value> = HashMap::new();
    context.insert("value".to_string(), value.clone());

    // Extract the expression from the template (e.g., "@{value > 100}" -> "value > 100")
    let expr = if template.starts_with("@{") && template.ends_with("}") {
        &template[2..template.len() - 1]
    } else if template.contains("@{") {
        // Template with embedded expression — build an evaluator over a
        // synthetic state object that exposes `value` so the expression can
        // reference the matched condition value alongside any data sources.
        let json_context = serde_json::json!({ "value": value });
        let evaluator = build_evaluator(&json_context, None, data_sources);
        match evaluate_template_string(template, &evaluator) {
            Ok(result) => {
                // Check if result is truthy
                return is_truthy_string(&result);
            }
            Err(e) => {
                warn_condition_error("pattern template", template, e);
                return false;
            }
        }
    } else {
        // Plain expression without @{} wrapper
        template
    };

    // Evaluate the expression
    match evaluate_expression(expr, &context) {
        Ok(result) => is_truthy(&result),
        Err(e) => {
            warn_condition_error("pattern expression", expr, e);
            false
        }
    }
}

/// Check if a string value is truthy
pub(crate) fn is_truthy_string(s: &str) -> bool {
    !s.is_empty() && s != "false" && s != "0" && s != "null" && s != "undefined"
}

/// Check if a JSON value is truthy
pub(crate) fn is_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        serde_json::Value::String(s) => is_truthy_string(s),
        serde_json::Value::Array(arr) => !arr.is_empty(),
        serde_json::Value::Object(obj) => !obj.is_empty(),
    }
}

/// Check if two JSON values match for conditional branching
/// Supports:
/// - Exact equality: Case(match: "loading"), Case(match: 42), Case(match: true), Case(match: null)
/// - Wildcard patterns: Case(match: "_") or Case(match: "*") matches anything
/// - Multiple values: Case(match: ["loading", "pending"]) matches any in the array
/// - Expression patterns: Case(match: "@{value > 100}")
fn values_match(
    value: &serde_json::Value,
    pattern: &serde_json::Value,
    data_sources: Option<&DataSources>,
) -> bool {
    match pattern {
        // Array pattern - match any value in the array
        serde_json::Value::Array(patterns) => patterns
            .iter()
            .any(|p| values_match(value, p, data_sources)),

        // String pattern with special syntax
        serde_json::Value::String(pattern_str) => {
            // Wildcard patterns
            if pattern_str == "_" || pattern_str == "*" {
                return true;
            }

            // Expression pattern (@{...})
            if pattern_str.contains("@{") {
                return evaluate_expression_pattern(pattern_str, value, data_sources);
            }

            // Exact string equality
            matches!(value, serde_json::Value::String(s) if s == pattern_str)
        }

        // Exact equality for non-string primitives
        _ => {
            if value == pattern {
                return true;
            }

            // Boolean pattern: coerce value via is_truthy. This is how
            // `If(condition: X)` works — convert_if hardcodes the branch
            // pattern to `Value::Static(true)`, and any truthy condition
            // (non-empty string, non-zero number, non-empty array/object)
            // should take the then-branch; null/false/0/"" falls through
            // to the Else fallback. Without this coercion, a string URL
            // like "@{item.avatarUrl}" never matches Bool(true) and the
            // then-branch silently drops — exactly the notifications-list
            // missing-post-image symptom.
            if let serde_json::Value::Bool(p) = pattern {
                return is_truthy(value) == *p;
            }

            // Null-to-null fallback (covered by the `value == pattern`
            // check above, but kept for symmetry with the previous shape).
            matches!(
                (value, pattern),
                (serde_json::Value::Null, serde_json::Value::Null)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reactive::Binding;
    use serde_json::json;

    #[test]
    fn test_evaluate_value_template_expression_preserves_bool() {
        // Pure expression templates should preserve typed results (not stringify)
        // This is critical for If(condition: "@{state.x == 'y'}") to match Bool(true)
        let state = json!({"currentView": "feed"});

        let value = Value::TemplateString {
            template: "@{state.currentView == 'feed'}".to_string(),
            bindings: vec![],
        };
        let result = evaluate_value(&value, &state, None);
        assert_eq!(
            result,
            json!(true),
            "Expression should evaluate to Bool(true), not String(\"true\")"
        );

        let value = Value::TemplateString {
            template: "@{state.currentView == 'profile'}".to_string(),
            bindings: vec![],
        };
        let result = evaluate_value(&value, &state, None);
        assert_eq!(
            result,
            json!(false),
            "Expression should evaluate to Bool(false)"
        );
    }

    #[test]
    fn test_evaluate_value_mixed_template_stays_string() {
        // Mixed templates (text + expression) should remain strings
        let state = json!({"name": "Alice"});

        let value = Value::TemplateString {
            template: "Hello @{state.name}!".to_string(),
            bindings: vec![],
        };
        let result = evaluate_value(&value, &state, None);
        assert_eq!(result, json!("Hello Alice!"));
    }

    #[test]
    fn test_pattern_matches_bool_coerces_truthy_value() {
        // Regression: `If(condition: X)` hardcodes the then-branch
        // pattern to Value::Static(true). The evaluated condition can
        // be any JSON value — string URL, number, array — and should
        // take the then-branch when truthy. Previously values_match
        // required strict equality against Bool(true) and silently
        // dropped the branch for non-bool truthy values, which made
        // `If(condition: @{item.postImageUrl})` always fall through
        // even when the URL was a non-empty string.
        let state = json!({});

        let true_pattern = Value::Static(json!(true));
        let false_pattern = Value::Static(json!(false));

        // Non-empty string (e.g. an image URL) is truthy → matches true
        let url = json!("https://example.com/img.jpg");
        assert!(
            pattern_matches(&url, &true_pattern, &state, None),
            "truthy string URL must match Bool(true)",
        );
        assert!(
            !pattern_matches(&url, &false_pattern, &state, None),
            "truthy string URL must NOT match Bool(false)",
        );

        // Empty string is falsy → matches false, not true
        let empty = json!("");
        assert!(!pattern_matches(&empty, &true_pattern, &state, None));
        assert!(pattern_matches(&empty, &false_pattern, &state, None));

        // Null falls through to false branch
        let null = json!(null);
        assert!(!pattern_matches(&null, &true_pattern, &state, None));
        assert!(pattern_matches(&null, &false_pattern, &state, None));

        // Numbers and non-empty arrays/objects coerce the same way
        assert!(pattern_matches(&json!(42), &true_pattern, &state, None));
        assert!(!pattern_matches(&json!(0), &true_pattern, &state, None));
        assert!(pattern_matches(&json!([1]), &true_pattern, &state, None));
        assert!(!pattern_matches(&json!([]), &true_pattern, &state, None));
    }

    #[test]
    fn test_pattern_matches_binding_truthy() {
        let state = json!({"isAdmin": true, "count": 0});
        let evaluated = json!("anything"); // The When() condition value

        // Truthy binding -> should match
        let pattern = Value::Binding(Binding::state(vec!["isAdmin".to_string()]));
        assert!(pattern_matches(&evaluated, &pattern, &state, None));

        // Falsy binding (number 0) -> should not match
        let pattern = Value::Binding(Binding::state(vec!["count".to_string()]));
        assert!(!pattern_matches(&evaluated, &pattern, &state, None));

        // Missing path -> null -> should not match
        let pattern = Value::Binding(Binding::state(vec!["missing".to_string()]));
        assert!(!pattern_matches(&evaluated, &pattern, &state, None));
    }

    #[test]
    fn test_evaluate_value_data_source_binding() {
        let state = json!({}); // empty module state
        let mut ds = indexmap::IndexMap::new();
        ds.insert(
            "spacetime".to_string(),
            json!({"status": "connected", "count": 42}),
        );

        // Data source binding should resolve against data sources, not state
        let binding = Binding::data_source("spacetime", vec!["status".to_string()]);
        let result = evaluate_value(&Value::Binding(binding), &state, Some(&ds));
        assert_eq!(result, json!("connected"));

        // Missing provider should resolve to null
        let binding = Binding::data_source("firebase", vec!["docs".to_string()]);
        let result = evaluate_value(&Value::Binding(binding), &state, Some(&ds));
        assert_eq!(result, json!(null));

        // No data sources at all should resolve to null
        let binding = Binding::data_source("spacetime", vec!["status".to_string()]);
        let result = evaluate_value(&Value::Binding(binding), &state, None);
        assert_eq!(result, json!(null));
    }

    #[test]
    fn test_pattern_matches_data_source_binding() {
        let state = json!({});
        let mut ds = indexmap::IndexMap::new();
        ds.insert("spacetime".to_string(), json!({"connected": true}));

        let evaluated = json!("anything");

        // Truthy data source binding -> should match
        let pattern = Value::Binding(Binding::data_source(
            "spacetime",
            vec!["connected".to_string()],
        ));
        assert!(pattern_matches(&evaluated, &pattern, &state, Some(&ds)));

        // Missing data source provider -> null -> should not match
        let pattern = Value::Binding(Binding::data_source("firebase", vec!["ready".to_string()]));
        assert!(!pattern_matches(&evaluated, &pattern, &state, Some(&ds)));
    }
}
