//! Small pure helpers over `.hypen` template source: parsing an entry
//! component, reading a `module X(args)` declaration's config, and renaming
//! identifiers by byte range.

use std::ops::Range;

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::IRNode;
use hypen_parser::{Argument, ComponentSpecification, DeclarationType, Value as AstValue};
use serde_json::{Map, Value};

use crate::error::RuntimeError;

/// A JSON object of config / usage arguments.
pub type Config = Map<String, Value>;

/// The first component declared in `source`. `origin` names the template in
/// errors (a file path or a component name).
pub fn first_component(source: &str, origin: &str) -> Result<ComponentSpecification, RuntimeError> {
    let doc = hypen_parser::parse_document(source).map_err(|e| RuntimeError::Template {
        origin: origin.to_string(),
        message: format!("{e:?}"),
    })?;
    doc.components
        .into_iter()
        .next()
        .ok_or_else(|| RuntimeError::EmptyTemplate { origin: origin.to_string() })
}

/// Parse `source` and lower its first component to engine IR.
pub fn entry_ir(source: &str, origin: &str) -> Result<IRNode, RuntimeError> {
    Ok(ast_to_ir_node(&first_component(source, origin)?))
}

/// Convert a parser AST value to JSON, for `init(config)`.
///
/// Integral numbers become JSON integers (`7`, not `7.0`) so
/// `module X(start: 7)` yields the natural `{"start":7}`. Strings have their
/// surrounding quotes trimmed (the parser keeps them). References
/// (`@state.x`) aren't literal config values; they're preserved as their
/// source string rather than silently dropped.
fn ast_value_to_json(value: &AstValue) -> Value {
    match value {
        AstValue::String(s) => {
            Value::String(s.trim_matches(|c: char| c == '"' || c == '\'').to_string())
        }
        AstValue::Number(n) => {
            let integral = n.fract() == 0.0
                && n.is_finite()
                && *n >= i64::MIN as f64
                && *n <= i64::MAX as f64;
            if integral {
                Value::Number((*n as i64).into())
            } else {
                serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null)
            }
        }
        AstValue::Boolean(b) => Value::Bool(*b),
        AstValue::List(items) => Value::Array(items.iter().map(ast_value_to_json).collect()),
        AstValue::Map(map) => Value::Object(
            map.iter().map(|(k, v)| (k.clone(), ast_value_to_json(v))).collect(),
        ),
        AstValue::Reference(r) | AstValue::DataSourceReference(r) => Value::String(r.clone()),
    }
}

/// A component's arguments as a JSON object: named args by key, positional
/// args by index (`"0"`, `"1"`, …).
pub fn component_args(component: &ComponentSpecification) -> Config {
    let mut args = Config::new();
    for arg in &component.arguments.arguments {
        match arg {
            Argument::Named { key, value } => {
                args.insert(key.clone(), ast_value_to_json(value));
            }
            Argument::Positioned { position, value } => {
                args.insert(position.to_string(), ast_value_to_json(value));
            }
        }
    }
    args
}

/// The declaration-site config of a module root: `module Counter(start: 5)`
/// → `{"start":5}`. A non-module root has no config (`{}`).
pub fn declaration_config(component: &ComponentSpecification) -> Config {
    if component.declaration_type == DeclarationType::Module {
        component_args(component)
    } else {
        Config::new()
    }
}

/// Replace byte ranges in `source` with new identifiers. Applied
/// highest-offset first so earlier ranges stay valid; a range that does not
/// fall on the source's char boundaries is skipped rather than panicking.
pub fn splice(source: &str, edits: &[(Range<usize>, String)]) -> String {
    let mut edits: Vec<&(Range<usize>, String)> = edits.iter().collect();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0.start));
    let mut out = source.to_string();
    for (range, replacement) in edits {
        let in_bounds = range.start <= range.end && range.end <= out.len();
        if in_bounds && out.is_char_boundary(range.start) && out.is_char_boundary(range.end) {
            out.replace_range(range.clone(), replacement);
        }
    }
    out
}

/// `source` with its root declaration renamed to `new_name` (unparseable
/// source is returned unchanged — the engine reports the parse error when it
/// renders it).
pub fn rename_root(source: &str, new_name: &str) -> String {
    match first_component(source, new_name) {
        Ok(root) => splice(source, &[(root.metadata.name_range, new_name.to_string())]),
        Err(_) => source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declaration_config_reads_module_args() {
        let c = first_component("module Seeded(start: 7, label: \"hi\", on: true) { Text(\"x\") }", "t")
            .unwrap();
        assert_eq!(
            Value::Object(declaration_config(&c)),
            json!({ "start": 7, "label": "hi", "on": true })
        );
    }

    #[test]
    fn non_module_roots_have_no_config_but_do_have_args() {
        let c = first_component("Column(gap: 1.5) { Text(\"x\") }", "t").unwrap();
        assert!(declaration_config(&c).is_empty());
        assert_eq!(Value::Object(component_args(&c)), json!({ "gap": 1.5 }));
        let text = &c.children[0];
        assert_eq!(Value::Object(component_args(text)), json!({ "0": "x" }));
    }

    #[test]
    fn parse_failures_name_the_template() {
        let err = first_component("module {", "app.hypen").unwrap_err();
        assert!(matches!(err, RuntimeError::Template { ref origin, .. } if origin == "app.hypen"));
        let err = first_component("", "empty.hypen").unwrap_err();
        assert!(matches!(
            err,
            RuntimeError::EmptyTemplate { .. } | RuntimeError::Template { .. }
        ));
        assert!(entry_ir("Text(\"ok\")", "t").is_ok());
    }

    #[test]
    fn splice_applies_edits_back_to_front_and_skips_bad_ranges() {
        let src = "Counter() Counter()";
        let out = splice(src, &[(0..7, "A".into()), (10..17, "Bee".into())]);
        assert_eq!(out, "A() Bee()");
        // Out of bounds / not on a char boundary: left alone, no panic.
        assert_eq!(splice("é", &[(1..2, "x".into())]), "é");
        assert_eq!(splice("abc", &[(2..9, "x".into())]), "abc");
    }

    #[test]
    fn rename_root_renames_only_the_declaration() {
        let src = "module Counter { Text(\"Counter\") }";
        assert_eq!(rename_root(src, "Counter__a"), "module Counter__a { Text(\"Counter\") }");
        assert_eq!(rename_root("module {", "X"), "module {");
    }
}
