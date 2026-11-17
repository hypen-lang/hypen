//! Renaming the components a template refers to — safely.
//!
//! Installing a module package under a namespace means its templates must
//! say `Acme__Cart {}` where the author wrote `Cart {}`, and
//! `module Acme__Cart { … }` where the author declared `module Cart`. That
//! is a source-to-source edit, and doing it with a regular expression is
//! wrong the moment a name also appears in a string, a comment or an
//! argument. This does it with the parser: the template is parsed, the name
//! token of every component in tag position (the declaration included) is
//! looked up, and only those byte ranges are replaced. Everything else —
//! strings, comments, `@{state.x}` bindings, `@actions.y`, argument values,
//! whitespace — is copied through untouched.

use hypen_parser::{ApplicatorSpecification, ComponentSpecification};
use std::fmt;
use std::ops::Range;

/// Why a template could not be rewritten. Nothing is returned in that case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenameError {
    /// The template does not parse (carries the parser's diagnostics).
    Parse(String),
    /// A replacement is not a component name the parser would read back.
    InvalidName { from: String, to: String },
    /// Two entries rename the same component to different names.
    Conflict {
        from: String,
        first: String,
        second: String,
    },
    /// The rewritten template does not parse back to the renamed tree. Not
    /// reachable through a valid name; reported rather than assumed.
    Unstable(String),
}

impl fmt::Display for RenameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenameError::Parse(e) => write!(f, "the template does not parse: {e}"),
            RenameError::InvalidName { from, to } => write!(
                f,
                "cannot rename '{from}' to '{to}': a component name starts with a letter or \
                 '_' and continues with letters, digits and '_'"
            ),
            RenameError::Conflict {
                from,
                first,
                second,
            } => write!(f, "'{from}' is renamed twice, to '{first}' and to '{second}'"),
            RenameError::Unstable(e) => write!(f, "the rewritten template is not valid: {e}"),
        }
    }
}

impl std::error::Error for RenameError {}

/// Whether `name` is something the parser reads as a component name.
fn is_component_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        // The declaration keywords would be read as keywords.
        && name != "module"
        && name != "component"
}

fn parse(source: &str) -> Result<ComponentSpecification, String> {
    hypen_parser::parse_component(source).map_err(|errors| {
        errors
            .iter()
            .map(hypen_parser::error::format_error_simple)
            .collect::<Vec<_>>()
            .join("; ")
    })
}

/// The name tokens to replace, with their replacement.
fn collect<'r>(
    component: &ComponentSpecification,
    renames: &'r [(String, String)],
    edits: &mut Vec<(Range<usize>, &'r str)>,
) {
    if let Some((_, to)) = renames.iter().find(|(from, _)| *from == component.name) {
        edits.push((component.metadata.name_range.clone(), to));
    }
    for child in &component.children {
        collect(child, renames, edits);
    }
    for ApplicatorSpecification { children, .. } in &component.applicators {
        for child in children {
            collect(child, renames, edits);
        }
    }
}

/// The names of the components in tag position, declaration included, in
/// document order.
fn names(component: &ComponentSpecification, out: &mut Vec<String>) {
    out.push(component.name.clone());
    for child in &component.children {
        names(child, out);
    }
    for applicator in &component.applicators {
        for child in &applicator.children {
            names(child, out);
        }
    }
}

/// Rewrite `source` so that every component named `from` — a tag
/// (`Cart {}`, `Cart()`) or the template's own `module Cart` /
/// `component Cart` declaration — is named `to`, for each `(from, to)` in
/// `renames`. Names match exactly (case-sensitively). A name that does not
/// occur is not an error; with nothing to rename the source comes back
/// unchanged, byte for byte.
///
/// Renames are simultaneous, not sequential: `[(A, B), (B, A)]` swaps.
pub fn rename_template_components(
    source: &str,
    renames: &[(String, String)],
) -> Result<String, RenameError> {
    for (index, (from, to)) in renames.iter().enumerate() {
        if !is_component_name(to) {
            return Err(RenameError::InvalidName {
                from: from.clone(),
                to: to.clone(),
            });
        }
        if let Some((_, first)) = renames[..index]
            .iter()
            .find(|(earlier, first)| earlier == from && first != to)
        {
            return Err(RenameError::Conflict {
                from: from.clone(),
                first: first.clone(),
                second: to.clone(),
            });
        }
    }
    let tree = parse(source).map_err(RenameError::Parse)?;
    let mut edits = Vec::new();
    collect(&tree, renames, &mut edits);
    if edits.is_empty() {
        return Ok(source.to_string());
    }
    edits.sort_by_key(|(range, _)| range.start);

    let mut out = String::with_capacity(source.len() + edits.len() * 16);
    let mut copied = 0;
    for (range, to) in &edits {
        // The parser's spans are byte offsets of the name token; anything
        // else would make this edit land in the wrong place, so check.
        let token = source.get(range.clone());
        if range.start < copied || !token.is_some_and(is_component_name) {
            return Err(RenameError::Unstable(format!(
                "the name at bytes {}..{} is not a component name token",
                range.start, range.end
            )));
        }
        out.push_str(&source[copied..range.start]);
        out.push_str(to);
        copied = range.end;
    }
    out.push_str(&source[copied..]);

    // The result must be the same tree with exactly those names changed.
    let mut expected = Vec::new();
    names(&tree, &mut expected);
    for name in &mut expected {
        if let Some((_, to)) = renames.iter().find(|(from, _)| from == name) {
            name.clone_from(to);
        }
    }
    let mut actual = Vec::new();
    names(&parse(&out).map_err(RenameError::Unstable)?, &mut actual);
    if actual != expected {
        return Err(RenameError::Unstable(
            "it does not parse back to the renamed component tree".into(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rename(source: &str, renames: &[(&str, &str)]) -> Result<String, RenameError> {
        let renames: Vec<(String, String)> = renames
            .iter()
            .map(|(from, to)| (from.to_string(), to.to_string()))
            .collect();
        rename_template_components(source, &renames)
    }

    #[test]
    fn tags_and_the_declaration_are_renamed_and_nothing_else() {
        let source = r#"// Cart is the Cart module
module Cart {
    Column {
        /* Cart { } in a comment */
        Text("Cart: @{state.Cart} 'Cart {}'")
        Text('Cart')
        Cart(title: "Cart", onTap: @actions.Cart)
        Cart { Cart() }
            .onClick(@actions.openCart)
        CartRow {}
        Text(text: Cart)
    }
}"#;
        let out = rename(source, &[("Cart", "Acme__Cart")]).unwrap();
        assert_eq!(
            out,
            r#"// Cart is the Cart module
module Acme__Cart {
    Column {
        /* Cart { } in a comment */
        Text("Cart: @{state.Cart} 'Cart {}'")
        Text('Cart')
        Acme__Cart(title: "Cart", onTap: @actions.Cart)
        Acme__Cart { Acme__Cart() }
            .onClick(@actions.openCart)
        CartRow {}
        Text(text: Cart)
    }
}"#
        );
    }

    #[test]
    fn nothing_to_rename_returns_the_source_byte_for_byte() {
        let source = "  Column {\n\tText(\"é — Cart\")  \n}\n";
        assert_eq!(rename(source, &[("Cart", "X")]).unwrap(), source);
        assert_eq!(rename(source, &[]).unwrap(), source);
    }

    #[test]
    fn offsets_hold_after_non_ascii_text() {
        let source = "Column { Text(\"héllo — ✓\") Cart {} Text('日本') Cart() }";
        assert_eq!(
            rename(source, &[("Cart", "Ns__Cart")]).unwrap(),
            "Column { Text(\"héllo — ✓\") Ns__Cart {} Text('日本') Ns__Cart() }"
        );
    }

    #[test]
    fn renames_are_simultaneous_and_cover_control_flow_and_routes() {
        let source = r#"module Shell {
    Column {
        If(condition: "@{state.open}") { A {} }
        ForEach(items: @state.rows, key: "id") { B(label: "@{item.name}") }
        Router { Route(path: "/a") { A {} } }
    }
}"#;
        let out = rename(source, &[("A", "B"), ("B", "A"), ("Shell", "Ns__Shell")]).unwrap();
        assert!(out.starts_with("module Ns__Shell {"), "{out}");
        assert!(out.contains(r#"{ B {} }"#) && out.contains(r#"{ A(label: "@{item.name}") }"#));
        assert!(out.contains(r#"Route(path: "/a") { B {} }"#), "{out}");
    }

    #[test]
    fn a_stateless_template_whose_root_is_a_use_is_renamed_too() {
        assert_eq!(
            rename("Card { Text(\"x\") }", &[("Card", "Ns__Card")]).unwrap(),
            "Ns__Card { Text(\"x\") }"
        );
        assert_eq!(
            rename("component Card { Row {} }", &[("Card", "Ns__Card")]).unwrap(),
            "component Ns__Card { Row {} }"
        );
    }

    #[test]
    fn bad_input_is_refused_with_the_reason() {
        assert!(matches!(
            rename("Column { ", &[("A", "B")]),
            Err(RenameError::Parse(_))
        ));
        for to in ["", "1x", "a-b", "a b", "a.b", "module", "é"] {
            assert_eq!(
                rename("A {}", &[("A", to)]),
                Err(RenameError::InvalidName {
                    from: "A".into(),
                    to: to.into()
                }),
                "{to:?}"
            );
        }
        assert_eq!(
            rename("A {}", &[("A", "B"), ("A", "C")]),
            Err(RenameError::Conflict {
                from: "A".into(),
                first: "B".into(),
                second: "C".into()
            })
        );
        // The same rename twice is fine.
        assert_eq!(rename("A {}", &[("A", "B"), ("A", "B")]).unwrap(), "B {}");
    }
}
