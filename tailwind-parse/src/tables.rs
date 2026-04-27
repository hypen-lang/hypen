//! Table utilities: border-collapse, border-spacing, table-layout, caption-side

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Border collapse
    match utility {
        "border-collapse" => return Some(vec![CssProperty::new("border-collapse", "collapse")]),
        "border-separate" => return Some(vec![CssProperty::new("border-collapse", "separate")]),
        _ => {}
    }

    // Border spacing
    if let Some(val) = utility.strip_prefix("border-spacing-") {
        // Directional
        if let Some(x_val) = val.strip_prefix("x-") {
            let value = spacing_value(x_val)?;
            return Some(vec![CssProperty::new(
                "border-spacing",
                &format!("{} 0", value),
            )]);
        }
        if let Some(y_val) = val.strip_prefix("y-") {
            let value = spacing_value(y_val)?;
            return Some(vec![CssProperty::new(
                "border-spacing",
                &format!("0 {}", value),
            )]);
        }
        // All sides
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("border-spacing", value)]);
    }

    // Table layout
    match utility {
        "table-auto" => return Some(vec![CssProperty::new("table-layout", "auto")]),
        "table-fixed" => return Some(vec![CssProperty::new("table-layout", "fixed")]),
        _ => {}
    }

    // Caption side
    match utility {
        "caption-top" => return Some(vec![CssProperty::new("caption-side", "top")]),
        "caption-bottom" => return Some(vec![CssProperty::new("caption-side", "bottom")]),
        _ => {}
    }

    None
}

fn spacing_value(key: &str) -> Option<&'static str> {
    match key {
        "0" => Some("0px"),
        "px" => Some("1px"),
        "0.5" => Some("0.125rem"),
        "1" => Some("0.25rem"),
        "1.5" => Some("0.375rem"),
        "2" => Some("0.5rem"),
        "2.5" => Some("0.625rem"),
        "3" => Some("0.75rem"),
        "3.5" => Some("0.875rem"),
        "4" => Some("1rem"),
        "5" => Some("1.25rem"),
        "6" => Some("1.5rem"),
        "7" => Some("1.75rem"),
        "8" => Some("2rem"),
        "9" => Some("2.25rem"),
        "10" => Some("2.5rem"),
        "11" => Some("2.75rem"),
        "12" => Some("3rem"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_border_collapse() {
        let props = parse("border-collapse").unwrap();
        assert_eq!(props[0].property, "border-collapse");
        assert_eq!(props[0].value, "collapse");
    }

    #[test]
    fn test_border_separate() {
        let props = parse("border-separate").unwrap();
        assert_eq!(props[0].property, "border-collapse");
        assert_eq!(props[0].value, "separate");
    }

    #[test]
    fn test_border_spacing() {
        let props = parse("border-spacing-2").unwrap();
        assert_eq!(props[0].property, "border-spacing");
        assert_eq!(props[0].value, "0.5rem");
    }

    #[test]
    fn test_table_fixed() {
        let props = parse("table-fixed").unwrap();
        assert_eq!(props[0].property, "table-layout");
        assert_eq!(props[0].value, "fixed");
    }

    #[test]
    fn test_caption_top() {
        let props = parse("caption-top").unwrap();
        assert_eq!(props[0].property, "caption-side");
        assert_eq!(props[0].value, "top");
    }
}
