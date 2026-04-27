//! Main parser for Tailwind classes

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::backgrounds;
use crate::borders;
use crate::colors;
use crate::effects;
use crate::interactivity;
use crate::layout;
use crate::misc;
use crate::sizing;
use crate::spacing;
use crate::tables;
use crate::transforms;
use crate::typography;

/// Represents a parsed CSS property
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CssProperty {
    pub property: String,
    pub value: String,
}

impl CssProperty {
    pub fn new(property: &str, value: &str) -> Self {
        Self {
            property: property.to_string(),
            value: value.to_string(),
        }
    }
}

/// Variant type for responsive/state/dark mode
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Variant {
    /// No variant (default)
    None,
    /// Responsive breakpoint: sm, md, lg, xl, 2xl
    Responsive(String),
    /// State: hover, focus, active, disabled
    State(String),
    /// Dark mode
    Dark,
    /// Combined variants like "md:hover:"
    Combined(Vec<Variant>),
}

impl Variant {
    pub fn is_none(&self) -> bool {
        matches!(self, Variant::None)
    }
}

/// Output from parsing Tailwind classes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TailwindOutput {
    /// Properties with no variant (default styles)
    pub base: Vec<CssProperty>,
    /// Properties grouped by variant
    pub variants: HashMap<String, Vec<CssProperty>>,
}

impl TailwindOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, variant: Variant, property: CssProperty) {
        match variant {
            Variant::None => self.base.push(property),
            Variant::Responsive(bp) => {
                self.variants
                    .entry(format!("@{}", bp))
                    .or_default()
                    .push(property);
            }
            Variant::State(state) => {
                self.variants
                    .entry(format!(":{}", state))
                    .or_default()
                    .push(property);
            }
            Variant::Dark => {
                self.variants
                    .entry("dark".to_string())
                    .or_default()
                    .push(property);
            }
            Variant::Combined(variants) => {
                // For combined variants, create a compound key
                let key = variants
                    .iter()
                    .map(|v| match v {
                        Variant::Responsive(bp) => format!("@{}", bp),
                        Variant::State(state) => format!(":{}", state),
                        Variant::Dark => "dark".to_string(),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("");
                self.variants.entry(key).or_default().push(property);
            }
        }
    }

    /// Convert to a flat map for engine props
    /// Format: { "padding": "1rem", "padding@md": "2rem", "backgroundColor:hover": "#fff" }
    pub fn to_props(&self) -> HashMap<String, String> {
        let mut props = HashMap::new();

        for prop in &self.base {
            props.insert(prop.property.clone(), prop.value.clone());
        }

        for (variant, properties) in &self.variants {
            for prop in properties {
                let key = format!("{}{}", prop.property, variant);
                props.insert(key, prop.value.clone());
            }
        }

        props
    }
}

/// Parse a string of space-separated Tailwind classes
pub fn parse_classes(input: &str) -> TailwindOutput {
    let mut output = TailwindOutput::new();

    for class in input.split_whitespace() {
        if let Some((variant, properties)) = parse_class(class) {
            for prop in properties {
                output.add(variant.clone(), prop);
            }
        }
    }

    output
}

/// Parse a single Tailwind class
/// Returns the variant and list of CSS properties
pub fn parse_class(class: &str) -> Option<(Variant, Vec<CssProperty>)> {
    // Extract variant prefix(es): "md:hover:bg-blue-500" -> (Combined[Responsive(md), State(hover)], "bg-blue-500")
    let (variant, utility) = extract_variant(class);

    // Parse the utility class
    let properties = parse_utility(utility)?;

    Some((variant, properties))
}

/// Extract variant prefix from class.
/// Only splits on ':' at bracket depth 0, so that arbitrary values
/// like `bg-[url(data:image/svg+xml;...)]` are kept intact.
fn extract_variant(class: &str) -> (Variant, &str) {
    // Split on ':' only when not inside brackets
    let mut parts: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut bracket_depth: usize = 0;
    for (i, ch) in class.char_indices() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            ':' if bracket_depth == 0 => {
                parts.push(&class[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&class[start..]);

    if parts.len() == 1 {
        return (Variant::None, class);
    }

    let utility = parts.last().unwrap();
    let variant_parts = &parts[..parts.len() - 1];

    if variant_parts.len() == 1 {
        let v = parse_variant_name(variant_parts[0]);
        (v, utility)
    } else {
        let variants: Vec<Variant> = variant_parts
            .iter()
            .map(|p| parse_variant_name(p))
            .filter(|v| !v.is_none())
            .collect();

        if variants.is_empty() {
            (Variant::None, utility)
        } else if variants.len() == 1 {
            (variants.into_iter().next().unwrap(), utility)
        } else {
            (Variant::Combined(variants), utility)
        }
    }
}

fn parse_variant_name(name: &str) -> Variant {
    match name {
        // Responsive
        "sm" => Variant::Responsive("sm".to_string()),
        "md" => Variant::Responsive("md".to_string()),
        "lg" => Variant::Responsive("lg".to_string()),
        "xl" => Variant::Responsive("xl".to_string()),
        "2xl" => Variant::Responsive("2xl".to_string()),
        // State
        "hover" => Variant::State("hover".to_string()),
        "focus" => Variant::State("focus".to_string()),
        "focus-within" => Variant::State("focus-within".to_string()),
        "focus-visible" => Variant::State("focus-visible".to_string()),
        "active" => Variant::State("active".to_string()),
        "disabled" => Variant::State("disabled".to_string()),
        "visited" => Variant::State("visited".to_string()),
        "checked" => Variant::State("checked".to_string()),
        "required" => Variant::State("required".to_string()),
        "placeholder" => Variant::State(":placeholder".to_string()),
        "first" => Variant::State("first-child".to_string()),
        "last" => Variant::State("last-child".to_string()),
        "only" => Variant::State("only-child".to_string()),
        "odd" => Variant::State("nth-child(odd)".to_string()),
        "even" => Variant::State("nth-child(even)".to_string()),
        "first-of-type" => Variant::State("first-of-type".to_string()),
        "last-of-type" => Variant::State("last-of-type".to_string()),
        "empty" => Variant::State("empty".to_string()),
        // Group variants
        "group-hover" => Variant::State("group-hover".to_string()),
        "group-focus" => Variant::State("group-focus".to_string()),
        // Dark mode
        "dark" => Variant::Dark,
        _ => Variant::None,
    }
}

/// Parse a utility class (without variant prefix) into CSS properties
fn parse_utility(utility: &str) -> Option<Vec<CssProperty>> {
    // Try each parser in order
    None.or_else(|| spacing::parse(utility))
        .or_else(|| sizing::parse(utility))
        .or_else(|| colors::parse(utility))
        .or_else(|| typography::parse(utility))
        .or_else(|| layout::parse(utility))
        .or_else(|| borders::parse(utility))
        .or_else(|| effects::parse(utility))
        .or_else(|| transforms::parse(utility))
        .or_else(|| backgrounds::parse(utility))
        .or_else(|| tables::parse(utility))
        .or_else(|| interactivity::parse(utility))
        .or_else(|| misc::parse(utility))
        .or_else(|| parse_arbitrary(utility))
}

/// Parse arbitrary value syntax like `p-[32px]`, `w-[200px]`, `text-[#ff00ff]`
fn parse_arbitrary(utility: &str) -> Option<Vec<CssProperty>> {
    // Match pattern: prefix-[value]
    let bracket_start = utility.find('[')?;
    if !utility.ends_with(']') {
        return None;
    }
    let value = &utility[bracket_start + 1..utility.len() - 1];
    if value.is_empty() {
        return None;
    }
    let prefix = &utility[..bracket_start.checked_sub(1)?]; // strip trailing '-'
    if utility.as_bytes()[bracket_start - 1] != b'-' {
        return None;
    }

    // Normalize negative prefix for categories that support negation.
    // Only spacing, layout, and effects (z-index) accept negative arbitrary values.
    let is_negative = prefix.starts_with('-');
    let bare_prefix = if is_negative { &prefix[1..] } else { prefix };
    let negated_value;
    let neg_val = if is_negative {
        negated_value = format!("-{}", value);
        negated_value.as_str()
    } else {
        value
    };

    // Delegate to category modules:
    // - spacing handles negation internally, receives original prefix/value
    // - layout and effects support negative values (top, inset, z-index)
    // - sizing, typography, borders do NOT support negation — skip if negative
    None.or_else(|| spacing::parse_arbitrary(prefix, value))
        .or_else(|| if is_negative { None } else { sizing::parse_arbitrary(prefix, value) })
        .or_else(|| if is_negative { None } else { typography::parse_arbitrary(prefix, value) })
        .or_else(|| layout::parse_arbitrary(bare_prefix, neg_val))
        .or_else(|| if is_negative { None } else { borders::parse_arbitrary(prefix, value) })
        .or_else(|| effects::parse_arbitrary(bare_prefix, neg_val))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_class() {
        let output = parse_classes("p-4");
        assert_eq!(output.base.len(), 1);
        assert_eq!(output.base[0].property, "padding");
        assert_eq!(output.base[0].value, "1rem");
    }

    #[test]
    fn test_parse_with_variant() {
        let output = parse_classes("md:p-4");
        assert!(output.base.is_empty());
        assert!(output.variants.contains_key("@md"));
        let md_props = output.variants.get("@md").unwrap();
        assert_eq!(md_props[0].property, "padding");
    }

    #[test]
    fn test_parse_multiple_classes() {
        let output = parse_classes("p-4 m-2 text-blue-500");
        assert_eq!(output.base.len(), 3);
    }

    #[test]
    fn test_parse_hover_variant() {
        let output = parse_classes("hover:bg-white");
        assert!(output.variants.contains_key(":hover"));
    }

    #[test]
    fn test_to_props() {
        let output = parse_classes("p-4 md:p-8");
        let props = output.to_props();
        assert_eq!(props.get("padding"), Some(&"1rem".to_string()));
        assert_eq!(props.get("padding@md"), Some(&"2rem".to_string()));
    }
}
