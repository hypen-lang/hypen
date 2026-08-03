//! Pure item-binding substitution for list iteration.
//!
//! Given an [`Element`] or [`IRNode`] and an item value from a list,
//! produce a new element/node with `@{item.x}` bindings replaced by
//! concrete values.  These functions are pure transformations — they
//! never touch the [`InstanceTree`], [`Patch`] list, or
//! [`DependencyGraph`].

use crate::ir::{ConditionalBranch, Element, IRNode, Props, Value};
use crate::reactive::Binding;

// ---------------------------------------------------------------------------
// String-level helpers
// ---------------------------------------------------------------------------

/// Navigate a nested path in a JSON value (e.g., "images.0" or "category.name")
/// Supports both object keys and array indices
pub(crate) fn navigate_item_path<'a>(
    item: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    let mut current = item;

    for segment in path.split('.') {
        // Try to parse as array index first
        if let Ok(index) = segment.parse::<usize>() {
            current = current.get(index)?;
        } else {
            // Otherwise treat as object key
            current = current.get(segment)?;
        }
    }

    Some(current)
}

/// A replacement to be applied: (start_index, end_index, replacement_string)
#[derive(Debug)]
pub(super) struct Replacement {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Apply all collected replacements to a string in a single pass.
/// Builds result by copying segments between replacements - true O(n + m) complexity.
pub(super) fn apply_replacements(s: &str, mut replacements: Vec<Replacement>) -> String {
    if replacements.is_empty() {
        return s.to_string();
    }

    // Sort by start position ascending
    replacements.sort_by(|a, b| a.start.cmp(&b.start));

    // Filter invalid replacements and calculate result size
    let valid_replacements: Vec<_> = replacements
        .into_iter()
        .filter(|r| r.start <= s.len() && r.end <= s.len() && r.start <= r.end)
        .collect();

    if valid_replacements.is_empty() {
        return s.to_string();
    }

    // Calculate total size: original - removed + added
    let removed: usize = valid_replacements.iter().map(|r| r.end - r.start).sum();
    let added: usize = valid_replacements.iter().map(|r| r.text.len()).sum();
    let capacity = s.len() - removed + added;

    let mut result = String::with_capacity(capacity);
    let mut pos = 0;

    for r in valid_replacements {
        // Push the segment before this replacement
        if r.start > pos {
            result.push_str(&s[pos..r.start]);
        }
        // Push the replacement text
        result.push_str(&r.text);
        pos = r.end;
    }

    // Push remaining segment after last replacement
    if pos < s.len() {
        result.push_str(&s[pos..]);
    }

    result
}

/// Find the end of a path (valid identifier chars: alphanumeric, _, and . for nesting)
fn find_path_end(s: &str, start: usize) -> usize {
    let substring = &s[start..];
    let mut end = start;
    let mut char_iter = substring.char_indices().peekable();

    while let Some((byte_offset, ch)) = char_iter.next() {
        if ch.is_alphanumeric() || ch == '_' {
            end = start + byte_offset + ch.len_utf8();
        } else if ch == '.' {
            // Dot is valid only if followed by alphanumeric or underscore
            if let Some(&(_, next)) = char_iter.peek() {
                if next.is_alphanumeric() || next == '_' {
                    end = start + byte_offset + ch.len_utf8();
                    continue;
                }
            }
            break;
        } else {
            break;
        }
    }

    end
}

/// Format a JSON value for replacement in expressions
fn format_value_for_replacement(val: &serde_json::Value, quote_strings: bool) -> String {
    match val {
        serde_json::Value::String(s) => {
            if quote_strings {
                format!("'{}'", s)
            } else {
                s.clone()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".to_string(),
        _ => serde_json::to_string(val).unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Element-level item binding replacement
// ---------------------------------------------------------------------------

/// Replace item bindings (Value::Binding with is_item() or TemplateString with item bindings) with actual item values
/// OPTIMIZED: Uses single-pass replacement instead of O(n²) repeated scans
/// This is a convenience wrapper that uses "item" as the default item name.
pub fn replace_item_bindings(element: &Element, item: &serde_json::Value, index: usize) -> Element {
    replace_item_bindings_with_name(element, item, index, "item")
}

/// Replace item bindings in an Element with a configurable item name
/// This is the full implementation that supports custom iteration variable names.
///
/// Builds a fresh `Element` rather than cloning and overwriting — cloning
/// `element.ir_children` (a `Vec<IRNode>`) just to discard it is the most
/// expensive part of this hot loop, so every field here is constructed once.
pub fn replace_item_bindings_with_name(
    element: &Element,
    item: &serde_json::Value,
    index: usize,
    item_name: &str,
) -> Element {
    // Replace bindings in props using the unified Value replacement logic
    let mut new_props = Props::new();
    for (key, value) in &element.props {
        new_props.insert(
            key.clone(),
            replace_value_item_bindings(value, item, item_name),
        );
    }

    // Generate key using the item name
    let key = item
        .get("id")
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .or_else(|| {
            item.get("key")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .map(|id| format!("{}-{}", item_name, id))
        .unwrap_or_else(|| format!("{}-{}", item_name, index));

    // Recursively replace in ir_children (build directly — never materialize
    // a clone of the original Vec<IRNode>).
    let child_key = format!("{}-{}", item_name, index);
    let ir_children = element
        .ir_children
        .iter()
        .map(|child_ir| replace_ir_node_item_bindings(child_ir, item, index, item_name, &child_key))
        .collect();

    Element {
        element_type: element.element_type.clone(),
        props: new_props,
        ir_children,
        key: Some(key),
        module_scope: element.module_scope.clone(),
        semantics: element.semantics.clone(),
        span: element.span,
        expr_span: element.expr_span,
    }
}

// ---------------------------------------------------------------------------
// IRNode-level item binding replacement
// ---------------------------------------------------------------------------

/// Replace item bindings in an IRNode with actual item values
/// Supports configurable item variable names (e.g., "todo", "user" instead of "item")
pub(crate) fn replace_ir_node_item_bindings(
    node: &IRNode,
    item: &serde_json::Value,
    index: usize,
    item_name: &str,
    item_key: &str,
) -> IRNode {
    match node {
        IRNode::Element(element) => {
            let mut new_element = replace_item_bindings_with_name(element, item, index, item_name);
            // Override key with the computed item key
            new_element.key = Some(item_key.to_string());
            IRNode::Element(new_element)
        }
        IRNode::ForEach {
            source,
            item_name: inner_item_name,
            key_path,
            template,
            props,
            module_scope,
        } => {
            // Note: source binding is kept as-is; nested ForEach maintains its own iteration context
            // Replace in props
            let new_props = replace_props_item_bindings(props, item, item_name);

            // Recursively replace in template (but inner ForEach has its own item context)
            let new_template: Vec<IRNode> = template
                .iter()
                .map(|child| replace_ir_node_item_bindings(child, item, index, item_name, item_key))
                .collect();

            IRNode::ForEach {
                source: source.clone(),
                item_name: inner_item_name.clone(),
                key_path: key_path.clone(),
                template: new_template,
                props: new_props,
                module_scope: module_scope.clone(),
            }
        }
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope,
        } => {
            // Replace in condition value
            let new_value = replace_value_item_bindings(value, item, item_name);

            // Replace in branches
            let new_branches: Vec<ConditionalBranch> = branches
                .iter()
                .map(|branch| {
                    let new_pattern = replace_value_item_bindings(&branch.pattern, item, item_name);
                    let new_children: Vec<IRNode> = branch
                        .children
                        .iter()
                        .map(|child| {
                            replace_ir_node_item_bindings(child, item, index, item_name, item_key)
                        })
                        .collect();
                    ConditionalBranch::new(new_pattern, new_children)
                })
                .collect();

            // Replace in fallback
            let new_fallback = fallback.as_ref().map(|f| {
                f.iter()
                    .map(|child| {
                        replace_ir_node_item_bindings(child, item, index, item_name, item_key)
                    })
                    .collect()
            });

            IRNode::Conditional {
                value: new_value,
                branches: new_branches,
                fallback: new_fallback,
                module_scope: module_scope.clone(),
            }
        }
        IRNode::Router {
            location,
            routes,
            fallback,
            module_scope,
        } => {
            // Replace in location value (rare — usually state.location which has no item refs)
            let new_location = replace_value_item_bindings(location, item, item_name);

            // Replace in each route's children
            let new_routes: Vec<crate::ir::RouterRoute> = routes
                .iter()
                .map(|route| crate::ir::RouterRoute {
                    path: route.path.clone(),
                    children: route
                        .children
                        .iter()
                        .map(|child| {
                            replace_ir_node_item_bindings(child, item, index, item_name, item_key)
                        })
                        .collect(),
                })
                .collect();

            // Replace in fallback
            let new_fallback = fallback.as_ref().map(|f| {
                f.iter()
                    .map(|child| {
                        replace_ir_node_item_bindings(child, item, index, item_name, item_key)
                    })
                    .collect()
            });

            IRNode::Router {
                location: new_location,
                routes: new_routes,
                fallback: new_fallback,
                module_scope: module_scope.clone(),
            }
        }
    }
}

/// Replace item bindings in Props
fn replace_props_item_bindings(props: &Props, item: &serde_json::Value, item_name: &str) -> Props {
    let mut new_props = Props::new();
    for (key, value) in props {
        new_props.insert(
            key.clone(),
            replace_value_item_bindings(value, item, item_name),
        );
    }
    new_props
}

// ---------------------------------------------------------------------------
// Value-level item binding replacement
// ---------------------------------------------------------------------------

/// Replace item bindings in a Value
/// Uses optimized single-pass replacement to avoid O(n²) string operations.
/// `item_name` allows custom iteration variable names (e.g., "todo", "user" instead of "item").
fn replace_value_item_bindings(value: &Value, item: &serde_json::Value, item_name: &str) -> Value {
    match value {
        Value::Binding(binding) => {
            if binding.is_item() {
                if binding.path.is_empty() {
                    Value::Static(item.clone())
                } else {
                    let path = binding.full_path();
                    if let Some(val) = navigate_item_path(item, &path) {
                        Value::Static(val.clone())
                    } else {
                        value.clone()
                    }
                }
            } else {
                value.clone()
            }
        }
        Value::TemplateString { template, bindings } => {
            replace_template_string_item_bindings(template, bindings, item, item_name, value)
        }
        // Handle static strings containing @{item.xxx} pattern (legacy/fallback)
        Value::Static(serde_json::Value::String(s))
            if s.contains(&format!("@{{{}.", item_name))
                || s.contains(&format!("@{{{}}}", item_name)) =>
        {
            replace_static_item_bindings_with_name(s, item, item_name)
        }
        _ => value.clone(),
    }
}

/// Replace item bindings within a TemplateString value
fn replace_template_string_item_bindings(
    template: &str,
    bindings: &[Binding],
    item: &serde_json::Value,
    item_name: &str,
    original: &Value,
) -> Value {
    use crate::reactive::{build_evaluator, evaluate_template_string};

    let has_item_bindings = bindings.iter().any(|b| b.is_item());

    // Custom `as:` names (e.g. `as: "opt"`) are deliberately rejected by
    // `parse_binding` — unknown `@{...}` prefixes must not become data-source
    // bindings — so the template carries no parsed item bindings for them.
    // They are only detectable textually, and only here at substitution time
    // where the iteration variable's name is known.
    let has_named_refs = template.contains(&format!("@{{{}.", item_name))
        || template.contains(&format!("@{{{}}}", item_name));

    if !has_item_bindings && !has_named_refs {
        return original.clone();
    }

    // Whole-template item reference ("@{opt.id}") that expand could not parse
    // into a `Value::Binding`: resolve to the item value directly, preserving
    // its JSON type. Guarded on `!has_item_bindings` so the parsed-binding
    // path (default "item" name) keeps its existing string-formatting shape.
    if !has_item_bindings {
        if let Some(val) = whole_template_item_value(template, item, item_name) {
            return Value::Static(val);
        }
    }

    // PHASE 1: Collect all replacements for explicit bindings (single pass)
    let mut replacements = Vec::new();
    for binding in bindings {
        if binding.is_item() {
            let pattern = format!("@{{{}}}", binding.full_path_with_source());
            if let Some(start) = template.find(&pattern) {
                let replacement = if binding.path.is_empty() {
                    format_value_for_replacement(item, false)
                } else if let Some(val) = navigate_item_path(item, &binding.full_path()) {
                    format_value_for_replacement(val, false)
                } else {
                    continue;
                };
                replacements.push(Replacement {
                    start,
                    end: start + pattern.len(),
                    text: replacement,
                });
            }
        }
    }

    // PHASE 2: Apply explicit binding replacements
    let mut result = apply_replacements(template, replacements);

    // PHASE 2.5: whole `@{<item_name>}` / `@{<item_name>.path}` occurrences
    // that carry no parsed binding (custom `as:` names) — replace the entire
    // `@{...}` with the raw value, mirroring PHASE 1's unquoted treatment so
    // simple refs never round-trip through the expression evaluator.
    if has_named_refs {
        let named_replacements = collect_named_ref_replacements(&result, item, item_name);
        result = apply_replacements(&result, named_replacements);
    }

    // PHASE 3: Replace item.xxx references in expressions (e.g., ternary operators)
    // Uses the configurable item_name for custom iteration variables
    let expr_replacements = collect_item_replacements_with_name(&result, item, true, item_name);
    result = apply_replacements(&result, expr_replacements);

    // Filter out resolved item bindings, keep state bindings
    let remaining_bindings: Vec<_> = bindings.iter().filter(|b| b.is_state()).cloned().collect();

    if remaining_bindings.is_empty() {
        if result.contains("@{") {
            let evaluator = build_evaluator(&serde_json::Value::Null, None, None);
            match evaluate_template_string(&result, &evaluator) {
                Ok(evaluated) => Value::Static(serde_json::Value::String(evaluated)),
                Err(_) => Value::Static(serde_json::Value::String(result)),
            }
        } else {
            Value::Static(serde_json::Value::String(result))
        }
    } else {
        Value::TemplateString {
            template: result,
            bindings: remaining_bindings,
        }
    }
}

/// If the entire template is one simple reference to the iteration variable
/// (`"@{opt}"` / `"@{opt.path}"`), resolve it to the item's JSON value.
/// Returns `None` (falling back to string substitution) for anything else,
/// including refs whose path is absent from the item.
fn whole_template_item_value(
    template: &str,
    item: &serde_json::Value,
    item_name: &str,
) -> Option<serde_json::Value> {
    let trimmed = template.trim();
    if !trimmed.starts_with("@{") || !trimmed.ends_with('}') {
        return None;
    }
    let content = &trimmed[2..trimmed.len() - 1];
    if content == item_name {
        return Some(item.clone());
    }
    if content.starts_with(item_name)
        && content[item_name.len()..].starts_with('.')
        && is_simple_path_with_name(content, item_name)
    {
        let path = &content[item_name.len() + 1..];
        return navigate_item_path(item, path).cloned();
    }
    None
}

/// Collect whole `@{...}` occurrences of the iteration variable — bare
/// `@{opt}` or simple-path `@{opt.a.b}` — replacing the full `@{...}` span
/// with the unquoted value. Complex expressions are left for the
/// expression-level pass ([`collect_item_replacements_with_name`]).
fn collect_named_ref_replacements(
    s: &str,
    item: &serde_json::Value,
    item_name: &str,
) -> Vec<Replacement> {
    let mut replacements = Vec::new();
    let mut pos = 0;

    while let Some(rel_start) = s[pos..].find("@{") {
        let abs_start = pos + rel_start;
        let Some(end) = s[abs_start..].find('}') else {
            break;
        };
        let abs_end = abs_start + end;
        let content = &s[abs_start + 2..abs_end];

        if content == item_name {
            replacements.push(Replacement {
                start: abs_start,
                end: abs_end + 1,
                text: format_value_for_replacement(item, false),
            });
        } else if content.starts_with(item_name)
            && content[item_name.len()..].starts_with('.')
            && is_simple_path_with_name(content, item_name)
        {
            let path = &content[item_name.len() + 1..];
            if let Some(val) = navigate_item_path(item, path) {
                replacements.push(Replacement {
                    start: abs_start,
                    end: abs_end + 1,
                    text: format_value_for_replacement(val, false),
                });
            }
        }
        pos = abs_end + 1;
    }

    replacements
}

/// Find all item.xxx references in a string with configurable item name.
fn collect_item_replacements_with_name(
    s: &str,
    item: &serde_json::Value,
    quote_strings: bool,
    item_name: &str,
) -> Vec<Replacement> {
    let mut replacements = Vec::new();
    let mut pos = 0;

    while pos < s.len() {
        if let Some(rel_start) = s[pos..].find(item_name) {
            let abs_start = pos + rel_start;
            let after_item = abs_start + item_name.len();

            if after_item < s.len() && s.as_bytes()[after_item] == b'.' {
                let path_start = after_item + 1;
                let path_end = find_path_end(s, path_start);

                if path_end > path_start {
                    let path = &s[path_start..path_end];
                    if let Some(val) = navigate_item_path(item, path) {
                        let replacement = format_value_for_replacement(val, quote_strings);
                        replacements.push(Replacement {
                            start: abs_start,
                            end: path_end,
                            text: replacement,
                        });
                    }
                }
                pos = path_end.max(after_item + 1);
            } else {
                pos = after_item;
            }
        } else {
            break;
        }
    }

    replacements
}

/// Replace item bindings in a static string value with configurable item name
fn replace_static_item_bindings_with_name(
    s: &str,
    item: &serde_json::Value,
    item_name: &str,
) -> Value {
    use crate::reactive::{build_evaluator, evaluate_template_string};

    let mut replacements = Vec::new();
    let mut pos = 0;

    while let Some(start) = s[pos..].find("@{") {
        let abs_start = pos + start;

        if let Some(end) = s[abs_start..].find('}') {
            let abs_end = abs_start + end;
            let content = &s[abs_start + 2..abs_end];

            if content == item_name {
                // Bare @{item}
                replacements.push(Replacement {
                    start: abs_start,
                    end: abs_end + 1,
                    text: format_value_for_replacement(item, false),
                });
                pos = abs_end + 1;
            } else if content.starts_with(&format!("{}.", item_name))
                && is_simple_path_with_name(content, item_name)
            {
                // Simple @{item.path}
                let path = &content[item_name.len() + 1..];
                if let Some(val) = navigate_item_path(item, path) {
                    replacements.push(Replacement {
                        start: abs_start,
                        end: abs_end + 1,
                        text: format_value_for_replacement(val, false),
                    });
                }
                pos = abs_end + 1;
            } else if content.contains(&format!("{}.", item_name))
                || content.contains(&format!("{} ", item_name))
            {
                // Complex expression - replace item refs within, then evaluate
                let expr_replacements =
                    collect_item_replacements_with_name(content, item, true, item_name);
                let substituted_content = apply_replacements(content, expr_replacements);
                let new_expr = format!("@{{{}}}", substituted_content);

                let evaluator = build_evaluator(&serde_json::Value::Null, None, None);
                if let Ok(evaluated) = evaluate_template_string(&new_expr, &evaluator) {
                    replacements.push(Replacement {
                        start: abs_start,
                        end: abs_end + 1,
                        text: evaluated,
                    });
                }
                pos = abs_end + 1;
            } else {
                pos = abs_end + 1;
            }
        } else {
            break;
        }
    }

    let result = apply_replacements(s, replacements);
    Value::Static(serde_json::Value::String(result))
}

/// Check if a string is a simple path with configurable item name
fn is_simple_path_with_name(s: &str, item_name: &str) -> bool {
    if !s.starts_with(item_name) {
        return false;
    }

    let after_item = &s[item_name.len()..];
    if after_item.is_empty() {
        return true;
    }

    if !after_item.starts_with('.') {
        return false;
    }

    after_item[1..]
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}
