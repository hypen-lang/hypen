//! Spacing utilities: padding, margin, gap, space

use crate::parser::CssProperty;

/// Tailwind spacing scale (in rem)
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
        "14" => Some("3.5rem"),
        "16" => Some("4rem"),
        "20" => Some("5rem"),
        "24" => Some("6rem"),
        "28" => Some("7rem"),
        "32" => Some("8rem"),
        "36" => Some("9rem"),
        "40" => Some("10rem"),
        "44" => Some("11rem"),
        "48" => Some("12rem"),
        "52" => Some("13rem"),
        "56" => Some("14rem"),
        "60" => Some("15rem"),
        "64" => Some("16rem"),
        "72" => Some("18rem"),
        "80" => Some("20rem"),
        "96" => Some("24rem"),
        "auto" => Some("auto"),
        _ => None,
    }
}

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Padding
    if let Some(val) = utility.strip_prefix("p-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("padding", value)]);
    }
    if let Some(val) = utility.strip_prefix("px-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("padding-left", value),
            CssProperty::new("padding-right", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("py-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("padding-top", value),
            CssProperty::new("padding-bottom", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("pt-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("padding-top", value)]);
    }
    if let Some(val) = utility.strip_prefix("pr-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("padding-right", value)]);
    }
    if let Some(val) = utility.strip_prefix("pb-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("padding-bottom", value)]);
    }
    if let Some(val) = utility.strip_prefix("pl-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("padding-left", value)]);
    }

    // Margin
    if let Some(val) = utility.strip_prefix("m-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin", value)]);
    }
    if let Some(val) = utility.strip_prefix("mx-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("margin-left", value),
            CssProperty::new("margin-right", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("my-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("margin-top", value),
            CssProperty::new("margin-bottom", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("mt-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin-top", value)]);
    }
    if let Some(val) = utility.strip_prefix("mr-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin-right", value)]);
    }
    if let Some(val) = utility.strip_prefix("mb-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin-bottom", value)]);
    }
    if let Some(val) = utility.strip_prefix("ml-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin-left", value)]);
    }

    // Gap
    if let Some(val) = utility.strip_prefix("gap-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("gap", value)]);
    }
    if let Some(val) = utility.strip_prefix("gap-x-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("column-gap", value)]);
    }
    if let Some(val) = utility.strip_prefix("gap-y-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("row-gap", value)]);
    }

    // Space between (applies to children)
    if let Some(val) = utility.strip_prefix("space-x-") {
        if val == "reverse" {
            return Some(vec![CssProperty::new("--tw-space-x-reverse", "1")]);
        }
        let value = spacing_value(val)?;
        // This is a special case - applies margin to children
        // For simplicity, we return column-gap as it achieves similar effect in flex
        return Some(vec![CssProperty::new("column-gap", value)]);
    }
    if let Some(val) = utility.strip_prefix("space-y-") {
        if val == "reverse" {
            return Some(vec![CssProperty::new("--tw-space-y-reverse", "1")]);
        }
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("row-gap", value)]);
    }

    // Negative margin
    if let Some(val) = utility.strip_prefix("-m-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin", &format!("-{}", value))]);
    }
    if let Some(val) = utility.strip_prefix("-mx-") {
        let value = spacing_value(val)?;
        let neg_value = format!("-{}", value);
        return Some(vec![
            CssProperty::new("margin-left", &neg_value),
            CssProperty::new("margin-right", &neg_value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("-my-") {
        let value = spacing_value(val)?;
        let neg_value = format!("-{}", value);
        return Some(vec![
            CssProperty::new("margin-top", &neg_value),
            CssProperty::new("margin-bottom", &neg_value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("-mt-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("margin-top", &format!("-{}", value))]);
    }
    if let Some(val) = utility.strip_prefix("-mr-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new(
            "margin-right",
            &format!("-{}", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("-mb-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new(
            "margin-bottom",
            &format!("-{}", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("-ml-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new(
            "margin-left",
            &format!("-{}", value),
        )]);
    }

    // Negative space between
    if let Some(val) = utility.strip_prefix("-space-x-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("column-gap", &format!("-{}", value))]);
    }
    if let Some(val) = utility.strip_prefix("-space-y-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("row-gap", &format!("-{}", value))]);
    }

    None
}

/// Parse arbitrary spacing values like `p-[32px]`, `mx-[1rem]`
/// Also handles negative prefixes (e.g., `-m-[10px]`) and `space-x`/`space-y`.
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    // Check for negative prefix
    let (is_neg, base_prefix) = if let Some(stripped) = prefix.strip_prefix('-') {
        (true, stripped)
    } else {
        (false, prefix)
    };

    let resolved_value = if is_neg {
        format!("-{}", value)
    } else {
        value.to_string()
    };
    let val = resolved_value.as_str();

    let property = match base_prefix {
        "p" => "padding",
        "px" => {
            return Some(vec![
                CssProperty::new("padding-left", val),
                CssProperty::new("padding-right", val),
            ])
        }
        "py" => {
            return Some(vec![
                CssProperty::new("padding-top", val),
                CssProperty::new("padding-bottom", val),
            ])
        }
        "pt" => "padding-top",
        "pr" => "padding-right",
        "pb" => "padding-bottom",
        "pl" => "padding-left",
        "m" => "margin",
        "mx" => {
            return Some(vec![
                CssProperty::new("margin-left", val),
                CssProperty::new("margin-right", val),
            ])
        }
        "my" => {
            return Some(vec![
                CssProperty::new("margin-top", val),
                CssProperty::new("margin-bottom", val),
            ])
        }
        "mt" => "margin-top",
        "mr" => "margin-right",
        "mb" => "margin-bottom",
        "ml" => "margin-left",
        "gap" => "gap",
        "gap-x" => "column-gap",
        "gap-y" => "row-gap",
        "space-x" => "column-gap",
        "space-y" => "row-gap",
        _ => return None,
    };
    Some(vec![CssProperty::new(property, val)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_padding() {
        let props = parse("p-4").unwrap();
        assert_eq!(props[0].property, "padding");
        assert_eq!(props[0].value, "1rem");
    }

    #[test]
    fn test_padding_x() {
        let props = parse("px-4").unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].property, "padding-left");
        assert_eq!(props[1].property, "padding-right");
    }

    #[test]
    fn test_margin_auto() {
        let props = parse("mx-auto").unwrap();
        assert_eq!(props[0].value, "auto");
    }

    #[test]
    fn test_gap() {
        let props = parse("gap-4").unwrap();
        assert_eq!(props[0].property, "gap");
        assert_eq!(props[0].value, "1rem");
    }

    #[test]
    fn test_negative_margin() {
        let props = parse("-m-4").unwrap();
        assert_eq!(props[0].property, "margin");
        assert_eq!(props[0].value, "-1rem");
    }

    #[test]
    fn test_negative_margin_top() {
        let props = parse("-mt-2").unwrap();
        assert_eq!(props[0].property, "margin-top");
        assert_eq!(props[0].value, "-0.5rem");
    }

    #[test]
    fn test_negative_margin_x() {
        let props = parse("-mx-4").unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].property, "margin-left");
        assert_eq!(props[0].value, "-1rem");
        assert_eq!(props[1].property, "margin-right");
        assert_eq!(props[1].value, "-1rem");
    }
}
