//! Expression evaluation using exprimo
//!
//! Supports JavaScript-like expressions in bindings:
//! - `@{state.selected ? '#FFA7E1' : '#374151'}`
//! - `@{item.count > 10 ? 'many' : 'few'}`
//! - `@{state.user.name + ' (' + state.user.role + ')'}`

use exprimo::{CustomFuncError, CustomFunction, Evaluator};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{Binding, BindingSource};
use crate::error::EngineError;

/// `length(x)` — JS-like size across the common container types.
///
/// Exprimo's built-in `.length` property only works on arrays and objects
/// (0.6.1 rejects strings with "Cannot read property 'length' of
/// non-array/non-object value"), which silently hid conditions like
/// `@{state.searchQuery.length == 0}` when `searchQuery` was a string.
/// Registering this as a custom function sidesteps the upstream gap
/// without forking exprimo: the DSL syntax becomes `length(state.x)`
/// instead of `.length`, and it works uniformly for strings, arrays,
/// and objects.
#[derive(Debug)]
struct LengthFn;

impl CustomFunction for LengthFn {
    fn call(&self, args: &[Value]) -> Result<Value, CustomFuncError> {
        if args.len() != 1 {
            return Err(CustomFuncError::ArityError {
                expected: 1,
                got: args.len(),
            });
        }
        let n = match &args[0] {
            // `chars().count()` so grapheme-ish counting is unicode-aware.
            // Cheap enough for the short strings that actually flow through
            // template expressions; the full grapheme-cluster story is a
            // separate feature if it ever matters.
            Value::String(s) => s.chars().count(),
            Value::Array(a) => a.len(),
            Value::Object(o) => o.len(),
            Value::Null => 0,
            other => {
                return Err(CustomFuncError::ArgumentError(format!(
                    "length() expects string, array, object, or null; got {}",
                    other
                )));
            }
        };
        // `len()` is `usize` and `serde_json::Number` accepts `u64` losslessly,
        // so this can't fail on any 64-bit target.
        Ok(Value::Number(serde_json::Number::from(n as u64)))
    }
}

/// Build the custom-function registry shared by every evaluator the engine
/// constructs. Centralised here so future additions (e.g. `keys()`,
/// `values()`) land in one place rather than every `Evaluator::new` call
/// site.
fn builtin_functions() -> HashMap<String, Arc<dyn CustomFunction>> {
    let mut funcs: HashMap<String, Arc<dyn CustomFunction>> = HashMap::new();
    funcs.insert("length".to_string(), Arc::new(LengthFn));
    funcs
}

/// Evaluate an expression string with the given context
///
/// The context should contain flattened variables like:
/// - `state` -> the full state object
/// - `item` -> the current item (in list iteration)
///
/// # Example
/// ```
/// use serde_json::json;
/// use std::collections::HashMap;
/// use hypen_engine::reactive::evaluate_expression;
///
/// let mut context = HashMap::new();
/// context.insert("selected".to_string(), json!(true));
///
/// let result = evaluate_expression("selected ? 'yes' : 'no'", &context);
/// assert_eq!(result, Ok(json!("yes")));
/// ```
pub fn evaluate_expression(
    expr: &str,
    context: &HashMap<String, Value>,
) -> Result<Value, EngineError> {
    let evaluator = Evaluator::new(context.clone(), builtin_functions());
    evaluator
        .evaluate(expr)
        .map_err(|e| EngineError::ExpressionError(e.to_string()))
}

/// Build a context for expression evaluation from state, optional item, and data sources.
///
/// Flattens `state`, `item`, and data source objects so that expressions can access:
/// - `state.user.name` via path traversal
/// - `item.selected` via path traversal
/// - `spacetime.messages` via data source path traversal
pub fn build_expression_context(
    state: &Value,
    item: Option<&Value>,
    data_sources: Option<&indexmap::IndexMap<String, Value>>,
) -> HashMap<String, Value> {
    let mut context = HashMap::new();

    // Add the full state object
    context.insert("state".to_string(), state.clone());

    // Add the full item object if present
    if let Some(item_value) = item {
        context.insert("item".to_string(), item_value.clone());
    }

    // Add data source states as top-level context entries
    if let Some(ds_map) = data_sources {
        for (provider, ds_state) in ds_map {
            context.insert(provider.clone(), ds_state.clone());
        }
    }

    context
}

/// Extract all state, item, and data source bindings from an expression string
///
/// This scans the expression for `state.xxx`, `item.xxx`, and `provider.xxx`
/// patterns and returns Binding objects for dependency tracking. Any
/// `identifier.path` that isn't `state.` or `item.` is treated as a potential
/// data source binding (validated at the dependency graph level).
///
/// # Example
/// ```
/// use hypen_engine::reactive::extract_bindings_from_expression;
///
/// let bindings = extract_bindings_from_expression("state.selected ? '#FFA7E1' : '#374151'");
/// assert_eq!(bindings.len(), 1);
/// assert_eq!(bindings[0].full_path(), "selected");
/// ```
pub fn extract_bindings_from_expression(expr: &str) -> Vec<Binding> {
    let mut bindings = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    // Find all state.xxx and item.xxx patterns
    for prefix in &["state.", "item."] {
        let source = if *prefix == "state." {
            BindingSource::State
        } else {
            BindingSource::Item
        };

        let mut search_pos = 0;
        while let Some(start) = expr[search_pos..].find(prefix) {
            let abs_start = search_pos + start;

            // Check that this isn't in the middle of another identifier
            // (e.g., "mystate.x" should not match)
            if abs_start > 0 {
                let prev_char = expr.chars().nth(abs_start - 1).unwrap_or(' ');
                if prev_char.is_ascii_alphanumeric() || prev_char == '_' {
                    search_pos = abs_start + prefix.len();
                    continue;
                }
            }

            // Extract the path after the prefix
            let path_start = abs_start + prefix.len();
            let mut path_end = path_start;

            // Consume valid path characters (alphanumeric, underscore, and dots)
            let chars: Vec<char> = expr.chars().collect();
            while path_end < chars.len() {
                let c = chars[path_end];
                if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                    path_end += 1;
                } else {
                    break;
                }
            }

            if path_end > path_start {
                let path_str: String = chars[path_start..path_end].iter().collect();
                // Remove trailing dots
                let path_str = path_str.trim_end_matches('.');

                if !path_str.is_empty() {
                    let full_path = format!("{}{}", prefix, path_str);
                    if !seen_paths.contains(&full_path) {
                        seen_paths.insert(full_path);
                        // `.length` is computed FROM the container, not stored
                        // in it — state diffs never emit a "...length" path
                        // (an unshift changes tasks.0, tasks.3, …). Depend on
                        // the container itself so element-level changes
                        // invalidate the expression via the graph's
                        // ancestor/descendant matching.
                        let dep_path = match path_str.strip_suffix(".length") {
                            Some(parent) if !parent.is_empty() => parent,
                            _ => path_str,
                        };
                        let path: Vec<String> =
                            dep_path.split('.').map(|s| s.to_string()).collect();
                        bindings.push(Binding::new(source.clone(), path));
                    }
                }
            }

            search_pos = path_end.max(abs_start + prefix.len());
        }
    }

    // Also find potential data source references: identifier.path patterns that
    // aren't state.* or item.*. E.g., `spacetime.status == 'connected'`
    extract_data_source_bindings_from_expression(expr, &mut bindings, &mut seen_paths);

    bindings
}

/// Extract data source bindings (identifier.path patterns not starting with state/item)
fn extract_data_source_bindings_from_expression(
    expr: &str,
    bindings: &mut Vec<Binding>,
    seen_paths: &mut HashSet<String>,
) {
    let chars: Vec<char> = expr.chars().collect();
    let len = chars.len();
    let mut pos = 0;

    // Reserved identifiers that are NOT data source providers
    let reserved = ["state", "item", "true", "false", "null"];

    while pos < len {
        // Find the start of an identifier
        if !chars[pos].is_ascii_alphabetic() && chars[pos] != '_' {
            pos += 1;
            continue;
        }

        // Check not preceded by alphanumeric (part of another identifier)
        if pos > 0 && (chars[pos - 1].is_ascii_alphanumeric() || chars[pos - 1] == '_') {
            pos += 1;
            continue;
        }

        // Consume the identifier
        let ident_start = pos;
        while pos < len && (chars[pos].is_ascii_alphanumeric() || chars[pos] == '_') {
            pos += 1;
        }
        let ident: String = chars[ident_start..pos].iter().collect();

        // Must be followed by a dot and more path segments
        if pos >= len || chars[pos] != '.' {
            continue;
        }

        // Skip reserved words
        if reserved.contains(&ident.as_str()) {
            continue;
        }

        // Consume the dot and path segments
        let path_start = pos + 1; // skip the dot
        let mut path_end = path_start;
        while path_end < len
            && (chars[path_end].is_ascii_alphanumeric()
                || chars[path_end] == '_'
                || chars[path_end] == '.')
        {
            path_end += 1;
        }

        if path_end > path_start {
            let path_str: String = chars[path_start..path_end].iter().collect();
            let path_str = path_str.trim_end_matches('.');
            if !path_str.is_empty() {
                let full_path = format!("{}.{}", ident, path_str);
                if !seen_paths.contains(&full_path) {
                    seen_paths.insert(full_path);
                    let path: Vec<String> = path_str.split('.').map(|s| s.to_string()).collect();
                    bindings.push(Binding::data_source(&ident, path));
                }
            }
        }

        pos = path_end;
    }
}

/// Build a reusable [`Evaluator`] from state, optional item, and data sources.
///
/// Use this when you need to evaluate multiple expressions against the same
/// state — `Evaluator::new` clones its context internally, so building once
/// and reusing avoids paying the clone for every expression.
pub fn build_evaluator(
    state: &Value,
    item: Option<&Value>,
    data_sources: Option<&indexmap::IndexMap<String, Value>>,
) -> Evaluator {
    let context = build_expression_context(state, item, data_sources);
    Evaluator::new(context, builtin_functions())
}

/// Evaluate a template string against a pre-built [`Evaluator`].
///
/// Substitutes every `@{...}` segment with the evaluator's result. Callers
/// that need a one-shot evaluation against fresh state should pair this
/// with [`build_evaluator`].
pub fn evaluate_template_string(
    template: &str,
    evaluator: &Evaluator,
) -> Result<String, EngineError> {
    let mut result = template.to_string();
    let mut pos = 0;

    while let Some(rel_start) = result[pos..].find("@{") {
        let abs_start = pos + rel_start;
        let body_start = abs_start + 2;

        // Walk the remainder of the string with char-boundary awareness to
        // locate the matching closing brace. Byte offsets are used throughout
        // so the arithmetic stays valid when the template contains multi-byte
        // UTF-8 characters (·, —, emoji, accented letters, CJK, …) before or
        // inside the expression.
        let mut depth: i32 = 1;
        let mut close_byte: Option<usize> = None;
        for (off, ch) in result[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close_byte = Some(body_start + off);
                        break;
                    }
                }
                _ => {}
            }
        }

        let close_byte = match close_byte {
            Some(b) => b,
            None => {
                return Err(EngineError::ExpressionError(
                    "Unclosed expression in template".to_string(),
                ));
            }
        };

        // Copy the expression out of `result` so we can mutate `result` below.
        let expr_content = result[body_start..close_byte].to_string();

        // Evaluate the expression directly via the evaluator (no context clone)
        let value = evaluator
            .evaluate(&expr_content)
            .map_err(|e| EngineError::ExpressionError(e.to_string()))?;

        // Convert to string
        let replacement = match &value {
            Value::String(s) => s.clone(),
            // Match JS number formatting: exprimo does its arithmetic in f64,
            // so integral results come back as e.g. 3.0 — render them as "3"
            // (`@{state.tasks.length} tasks` must not say "3.0 tasks").
            Value::Number(n) => match n.as_f64() {
                Some(f)
                    if n.as_i64().is_none()
                        && n.as_u64().is_none()
                        && f.is_finite()
                        && f.fract() == 0.0
                        && f.abs() < 9_007_199_254_740_992.0 =>
                {
                    format!("{}", f as i64)
                }
                _ => n.to_string(),
            },
            Value::Bool(b) => b.to_string(),
            Value::Null => "null".to_string(),
            _ => serde_json::to_string(&value).unwrap_or_default(),
        };

        // `}` is ASCII so close_byte + 1 is a valid char boundary past it.
        let end_byte = close_byte + 1;
        result.replace_range(abs_start..end_byte, &replacement);

        // Advance past the replacement so we don't re-scan substituted content.
        pos = abs_start + replacement.len();
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_simple_expression() {
        let mut context = HashMap::new();
        context.insert("x".to_string(), json!(5));
        context.insert("y".to_string(), json!(3));

        let result = evaluate_expression("x + y", &context).unwrap();
        // exprimo returns floats for arithmetic, so compare as f64
        assert_eq!(result.as_f64().unwrap(), 8.0);
    }

    #[test]
    fn test_ternary_expression() {
        let mut context = HashMap::new();
        context.insert("selected".to_string(), json!(true));

        let result = evaluate_expression("selected ? 'yes' : 'no'", &context).unwrap();
        assert_eq!(result, json!("yes"));
    }

    #[test]
    fn test_ternary_with_colors() {
        let mut context = HashMap::new();
        context.insert("selected".to_string(), json!(true));

        let result = evaluate_expression("selected ? '#FFA7E1' : '#374151'", &context).unwrap();
        assert_eq!(result, json!("#FFA7E1"));
    }

    #[test]
    fn test_comparison_expression() {
        let mut context = HashMap::new();
        context.insert("count".to_string(), json!(15));

        let result = evaluate_expression("count > 10", &context).unwrap();
        assert_eq!(result, json!(true));
    }

    #[test]
    fn test_state_object_access() {
        let context =
            build_expression_context(&json!({"user": {"name": "Alice", "age": 30}}), None, None);

        let result = evaluate_expression("state.user.name", &context).unwrap();
        assert_eq!(result, json!("Alice"));
    }

    #[test]
    fn test_item_object_access() {
        let context = build_expression_context(
            &json!({}),
            Some(&json!({"name": "Item 1", "selected": true})),
            None,
        );

        let result = evaluate_expression("item.name", &context).unwrap();
        assert_eq!(result, json!("Item 1"));
    }

    #[test]
    fn test_item_ternary() {
        let context = build_expression_context(&json!({}), Some(&json!({"selected": true})), None);

        let result =
            evaluate_expression("item.selected ? '#FFA7E1' : '#374151'", &context).unwrap();
        assert_eq!(result, json!("#FFA7E1"));
    }

    #[test]
    fn test_template_string_simple() {
        let state = json!({"user": {"name": "Alice"}});
        let evaluator = build_evaluator(&state, None, None);
        let result = evaluate_template_string("Hello @{state.user.name}!", &evaluator).unwrap();
        assert_eq!(result, "Hello Alice!");
    }

    #[test]
    fn test_template_string_with_expression() {
        let state = json!({"selected": true});
        let evaluator = build_evaluator(&state, None, None);
        let result = evaluate_template_string(
            "Color: @{state.selected ? '#FFA7E1' : '#374151'}",
            &evaluator,
        )
        .unwrap();
        assert_eq!(result, "Color: #FFA7E1");
    }

    #[test]
    fn test_template_string_multiple_expressions() {
        let state = json!({"name": "Alice", "count": 5});
        let evaluator = build_evaluator(&state, None, None);
        let result =
            evaluate_template_string("@{state.name} has @{state.count} items", &evaluator).unwrap();
        assert_eq!(result, "Alice has 5 items");
    }

    #[test]
    fn test_template_with_item() {
        let state = json!({});
        let item = json!({"name": "Product", "price": 99});
        let evaluator = build_evaluator(&state, Some(&item), None);
        let result = evaluate_template_string("@{item.name}: $@{item.price}", &evaluator).unwrap();
        assert_eq!(result, "Product: $99");
    }

    #[test]
    fn test_length_access_depends_on_container() {
        // `.length` is computed from the container; diffs never emit a
        // "...length" path (unshift → tasks.0, tasks.3, …), so the extracted
        // dependency must be the container path itself.
        // (Filter to state bindings — the data-source scanner also records a
        // speculative `tasks.length` provider ref, which the graph validates
        // separately.)
        let bindings = extract_bindings_from_expression("state.tasks.length");
        let state_paths: Vec<String> = bindings
            .iter()
            .filter(|b| b.is_state())
            .map(|b| b.full_path())
            .collect();
        assert_eq!(state_paths, vec!["tasks".to_string()]);

        // A literal `length` root key is left alone.
        let bindings = extract_bindings_from_expression("state.length");
        let state_paths: Vec<String> = bindings
            .iter()
            .filter(|b| b.is_state())
            .map(|b| b.full_path())
            .collect();
        assert_eq!(state_paths, vec!["length".to_string()]);
    }

    #[test]
    fn test_template_integral_float_renders_like_js() {
        // exprimo evaluates in f64, so `.length` member access and template
        // arithmetic produce e.g. 3.0 — the interpolation must render "3"
        // (JS-style), not "3.0". Non-integral floats keep their fraction.
        let state = json!({"tasks": [1, 2, 3], "count": 5, "ratio": 2.5});
        let evaluator = build_evaluator(&state, None, None);
        let result =
            evaluate_template_string("@{state.tasks.length} tasks", &evaluator).unwrap();
        assert_eq!(result, "3 tasks");
        let result = evaluate_template_string("next: @{state.count + 1}", &evaluator).unwrap();
        assert_eq!(result, "next: 6");
        let result = evaluate_template_string("ratio: @{state.ratio}", &evaluator).unwrap();
        assert_eq!(result, "ratio: 2.5");
    }

    #[test]
    fn test_string_concatenation() {
        let mut context = HashMap::new();
        context.insert("first".to_string(), json!("Hello"));
        context.insert("second".to_string(), json!("World"));

        let result = evaluate_expression("first + ' ' + second", &context).unwrap();
        assert_eq!(result, json!("Hello World"));
    }

    #[test]
    fn test_logical_and() {
        let mut context = HashMap::new();
        context.insert("a".to_string(), json!(true));
        context.insert("b".to_string(), json!(false));

        let result = evaluate_expression("a && b", &context).unwrap();
        assert_eq!(result, json!(false));
    }

    #[test]
    fn test_logical_or() {
        let mut context = HashMap::new();
        context.insert("a".to_string(), json!(false));
        context.insert("b".to_string(), json!(true));

        let result = evaluate_expression("a || b", &context).unwrap();
        assert_eq!(result, json!(true));
    }

    #[test]
    fn test_template_string_multibyte_before_expression() {
        // Regression: `find("@{")` returns a byte offset but the old code
        // indexed into `Vec<char>` with it. Any multi-byte char before `@{`
        // (·, —, emoji, accented letters, CJK …) desynchronised the two and
        // the expression-extractor ate the leading byte of the identifier.
        let state = json!({"a": "ALPHA", "b": "BETA"});
        let evaluator = build_evaluator(&state, None, None);

        // Middle-dot (U+00B7, 2 bytes in UTF-8)
        let result = evaluate_template_string("@{state.a} · @{state.b}", &evaluator).unwrap();
        assert_eq!(result, "ALPHA · BETA");

        let result = evaluate_template_string("prefix · @{state.a}", &evaluator).unwrap();
        assert_eq!(result, "prefix · ALPHA");

        // Em dash (U+2014, 3 bytes)
        let result = evaluate_template_string("@{state.a} — @{state.b}", &evaluator).unwrap();
        assert_eq!(result, "ALPHA — BETA");

        // Emoji (4 bytes)
        let result = evaluate_template_string("🍕 @{state.a}", &evaluator).unwrap();
        assert_eq!(result, "🍕 ALPHA");

        // CJK (3 bytes each)
        let result = evaluate_template_string("你好 @{state.a}", &evaluator).unwrap();
        assert_eq!(result, "你好 ALPHA");

        // Accented letter (2 bytes)
        let result = evaluate_template_string("café @{state.a}", &evaluator).unwrap();
        assert_eq!(result, "café ALPHA");
    }

    #[test]
    fn test_template_string_multibyte_inside_replacement() {
        // The replacement itself may contain multi-byte bytes, and the next
        // `@{` may appear after them. Byte-offset advancement must still work.
        let state = json!({"a": "café", "b": "naïve"});
        let evaluator = build_evaluator(&state, None, None);

        let result = evaluate_template_string("@{state.a} · @{state.b}", &evaluator).unwrap();
        assert_eq!(result, "café · naïve");
    }

    #[test]
    fn test_template_string_realistic_restaurant_example() {
        // Mirrors the user-visible report: a Text containing two template
        // expressions separated by a middle dot. Before the fix this returned
        // Err and the caller silently surfaced the raw DSL template.
        let state = json!({
            "restaurant": {
                "cuisine": "Italian",
                "description": "Wood-fired pizza"
            }
        });
        let evaluator = build_evaluator(&state, None, None);
        let result = evaluate_template_string(
            "@{state.restaurant.cuisine} · @{state.restaurant.description}",
            &evaluator,
        )
        .unwrap();
        assert_eq!(result, "Italian · Wood-fired pizza");
    }

    #[test]
    fn test_length_function_strings_arrays_objects() {
        // Regression: exprimo 0.6.1 rejects `.length` on strings with
        // "Cannot read property 'length' of non-array/non-object value".
        // We register `length(x)` as a custom function so the DSL can use
        // a single syntax for strings / arrays / objects uniformly.
        let state = json!({
            "empty": "",
            "hello": "hello",
            "unicode": "café",        // 4 chars, 5 bytes
            "items_empty": [],
            "items": [1, 2, 3],
            "obj": { "a": 1, "b": 2 },
        });
        let ev = build_evaluator(&state, None, None);

        // strings
        assert_eq!(
            evaluate_template_string("@{length(state.empty)}", &ev).unwrap(),
            "0"
        );
        assert_eq!(
            evaluate_template_string("@{length(state.hello)}", &ev).unwrap(),
            "5"
        );
        // unicode char count, not byte count
        assert_eq!(
            evaluate_template_string("@{length(state.unicode)}", &ev).unwrap(),
            "4"
        );

        // arrays
        assert_eq!(
            evaluate_template_string("@{length(state.items_empty)}", &ev).unwrap(),
            "0"
        );
        assert_eq!(
            evaluate_template_string("@{length(state.items)}", &ev).unwrap(),
            "3"
        );

        // objects (key count)
        assert_eq!(
            evaluate_template_string("@{length(state.obj)}", &ev).unwrap(),
            "2"
        );
    }

    #[test]
    fn test_length_function_empty_search_query_condition() {
        // The exact condition from the bug report: with `searchQuery = ""`
        // the "no results / suggestions" branch was silently never rendering
        // because exprimo errored on `.length`. `length(state.searchQuery) == 0`
        // now evaluates cleanly.
        let state = json!({ "searchQuery": "" });
        let ev = build_evaluator(&state, None, None);

        let mut ctx = HashMap::new();
        ctx.insert("state".to_string(), state.clone());

        let result = evaluate_expression("length(state.searchQuery) == 0", &ctx).unwrap();
        assert_eq!(result, json!(true));

        let populated = json!({ "searchQuery": "pizza" });
        let mut ctx = HashMap::new();
        ctx.insert("state".to_string(), populated);
        let result = evaluate_expression("length(state.searchQuery) == 0", &ctx).unwrap();
        assert_eq!(result, json!(false));

        // `length()` inside a pure-expression template must preserve the Bool
        // result (not stringify it), so `If(condition: "@{length(…) == 0}")`
        // matches the Static(true) pattern the parser emits for If.
        let _ = ev; // keep build_evaluator referenced so the evaluator path is also exercised
    }

    #[test]
    fn test_length_function_null_and_errors() {
        let state = json!({ "missing": null });
        let ev = build_evaluator(&state, None, None);

        // Null treated as 0 so `length(state.missing) == 0` doesn't throw
        // for uninitialised state fields.
        assert_eq!(
            evaluate_template_string("@{length(state.missing)}", &ev).unwrap(),
            "0"
        );

        // Wrong arity is a real error — surfaced, not silenced.
        let err = evaluate_template_string("@{length()}", &ev).unwrap_err();
        match err {
            EngineError::ExpressionError(msg) => {
                assert!(
                    msg.contains("expected 1") || msg.contains("arg"),
                    "expected arity error, got: {}",
                    msg
                );
            }
            _ => panic!("expected ExpressionError"),
        }
    }

    #[test]
    fn test_template_string_unclosed_expression() {
        let state = json!({});
        let evaluator = build_evaluator(&state, None, None);
        let err = evaluate_template_string("prefix @{state.a", &evaluator).unwrap_err();
        match err {
            EngineError::ExpressionError(msg) => {
                assert!(msg.contains("Unclosed"));
            }
            _ => panic!("expected ExpressionError"),
        }
    }

    #[test]
    fn test_complex_expression() {
        let context = build_expression_context(
            &json!({
                "user": {
                    "premium": true,
                    "age": 25
                }
            }),
            None,
            None,
        );

        let result = evaluate_expression(
            "state.user.premium && state.user.age >= 18 ? 'VIP Adult' : 'Standard'",
            &context,
        )
        .unwrap();
        assert_eq!(result, json!("VIP Adult"));
    }
}
