//! Border utilities: border width, radius, style

use crate::parser::CssProperty;

/// Map a Tailwind border-radius size token to its CSS value.
///
/// Supports the named scale Tailwind ships out of the box (none/sm/md/lg/xl/
/// 2xl/3xl/full) plus the bare default. Returns `None` for any other token so
/// callers can fall back to arbitrary values.
fn radius_value(name: &str) -> Option<&'static str> {
    match name {
        "none" => Some("0px"),
        "xs" => Some("0.125rem"),
        "sm" => Some("0.125rem"),
        "" => Some("0.25rem"), // bare `rounded` ⇒ default radius
        "md" => Some("0.375rem"),
        "lg" => Some("0.5rem"),
        "xl" => Some("0.75rem"),
        "2xl" => Some("1rem"),
        "3xl" => Some("1.5rem"),
        "4xl" => Some("2rem"),
        "full" => Some("9999px"),
        _ => None,
    }
}

/// Resolve which CSS properties a directional radius shorthand expands to.
/// Returns the list of property names that should receive the radius value.
fn directional_radius_props(side: &str) -> Option<&'static [&'static str]> {
    match side {
        // Sides — affect both corners on that side
        "t" => Some(&["border-top-left-radius", "border-top-right-radius"]),
        "b" => Some(&["border-bottom-left-radius", "border-bottom-right-radius"]),
        "l" => Some(&["border-top-left-radius", "border-bottom-left-radius"]),
        "r" => Some(&["border-top-right-radius", "border-bottom-right-radius"]),
        // Single corners
        "tl" => Some(&["border-top-left-radius"]),
        "tr" => Some(&["border-top-right-radius"]),
        "bl" => Some(&["border-bottom-left-radius"]),
        "br" => Some(&["border-bottom-right-radius"]),
        // Logical (RTL-aware) variants — emit physical properties for now
        // since the CSS logical properties aren't yet supported by every
        // renderer. Conservative mapping that mirrors LTR.
        "s" | "ss" => Some(&["border-top-left-radius", "border-bottom-left-radius"]),
        "e" | "ee" => Some(&["border-top-right-radius", "border-bottom-right-radius"]),
        "es" => Some(&["border-bottom-left-radius"]),
        "se" => Some(&["border-bottom-right-radius"]),
        "ss-corner" => Some(&["border-top-left-radius"]),
        _ => None,
    }
}

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Border radius
    //
    // Two forms supported, both delegating to the same `radius_value` table
    // so the named scale stays in sync:
    //
    //   rounded-{size}        → border-radius
    //   rounded-{side}-{size} → border-{corner}-radius for each affected corner
    //
    // The previous implementation had a hand-written match arm for every
    // (side, size) pair and silently dropped any combination it didn't list
    // (e.g. `rounded-t-xl`, `rounded-l-2xl`). This refactor closes those gaps.
    if let Some(rest) = utility.strip_prefix("rounded-") {
        // Plain `rounded-{size}` first.
        if let Some(value) = radius_value(rest) {
            return Some(vec![CssProperty::new("border-radius", value)]);
        }

        // Directional `rounded-{side}-{size}`. Split on the first '-' so
        // multi-char sizes like "2xl" stay intact.
        if let Some(dash) = rest.find('-') {
            let side = &rest[..dash];
            let size = &rest[dash + 1..];
            if let (Some(props), Some(value)) =
                (directional_radius_props(side), radius_value(size))
            {
                return Some(props.iter().map(|p| CssProperty::new(p, value)).collect());
            }
        }

        return None;
    }

    // Plain rounded (no suffix)
    if utility == "rounded" {
        return Some(vec![CssProperty::new("border-radius", "0.25rem")]);
    }

    // Border width
    if utility == "border" {
        return Some(vec![CssProperty::new("border-width", "1px")]);
    }
    if let Some(val) = utility.strip_prefix("border-") {
        // Check if it's a width value (number)
        let value = match val {
            "0" => "0px",
            "2" => "2px",
            "4" => "4px",
            "8" => "8px",
            // Directional borders. Web renders these via the per-side
            // CSS props directly; native renderers that don't yet
            // support per-side widths can fall back by checking for
            // any of the per-side keys and treating them as a uniform
            // border. Emitting the per-side key is strictly more
            // information than the previous "border-width: 1px"
            // collapse, so the desktop / web / mobile renderers all
            // see what the user actually asked for.
            "t" => return Some(vec![CssProperty::new("border-top-width", "1px")]),
            "r" => return Some(vec![CssProperty::new("border-right-width", "1px")]),
            "b" => return Some(vec![CssProperty::new("border-bottom-width", "1px")]),
            "l" => return Some(vec![CssProperty::new("border-left-width", "1px")]),
            "t-0" => return Some(vec![CssProperty::new("border-top-width", "0px")]),
            "r-0" => return Some(vec![CssProperty::new("border-right-width", "0px")]),
            "b-0" => return Some(vec![CssProperty::new("border-bottom-width", "0px")]),
            "l-0" => return Some(vec![CssProperty::new("border-left-width", "0px")]),
            "t-2" => return Some(vec![CssProperty::new("border-top-width", "2px")]),
            "r-2" => return Some(vec![CssProperty::new("border-right-width", "2px")]),
            "b-2" => return Some(vec![CssProperty::new("border-bottom-width", "2px")]),
            "l-2" => return Some(vec![CssProperty::new("border-left-width", "2px")]),
            // Border style
            "solid" => return Some(vec![CssProperty::new("border-style", "solid")]),
            "dashed" => return Some(vec![CssProperty::new("border-style", "dashed")]),
            "dotted" => return Some(vec![CssProperty::new("border-style", "dotted")]),
            "double" => return Some(vec![CssProperty::new("border-style", "double")]),
            "hidden" => return Some(vec![CssProperty::new("border-style", "hidden")]),
            "none" => return Some(vec![CssProperty::new("border-style", "none")]),
            _ => return None,
        };
        return Some(vec![CssProperty::new("border-width", value)]);
    }

    // Outline
    if utility == "outline" {
        return Some(vec![CssProperty::new("outline-style", "solid")]);
    }
    if utility == "outline-none" {
        return Some(vec![
            CssProperty::new("outline", "2px solid transparent"),
            CssProperty::new("outline-offset", "2px"),
        ]);
    }

    // Ring (focus ring)
    if utility == "ring" {
        return Some(vec![CssProperty::new(
            "box-shadow",
            "0 0 0 3px rgba(59, 130, 246, 0.5)",
        )]);
    }
    if let Some(val) = utility.strip_prefix("ring-") {
        let value = match val {
            "0" => "0 0 0 0px",
            "1" => "0 0 0 1px",
            "2" => "0 0 0 2px",
            "4" => "0 0 0 4px",
            "8" => "0 0 0 8px",
            "inset" => return Some(vec![CssProperty::new("--tw-ring-inset", "inset")]),
            // Ring offset
            "offset-0" => return Some(vec![CssProperty::new("--tw-ring-offset-width", "0px")]),
            "offset-1" => return Some(vec![CssProperty::new("--tw-ring-offset-width", "1px")]),
            "offset-2" => return Some(vec![CssProperty::new("--tw-ring-offset-width", "2px")]),
            "offset-4" => return Some(vec![CssProperty::new("--tw-ring-offset-width", "4px")]),
            "offset-8" => return Some(vec![CssProperty::new("--tw-ring-offset-width", "8px")]),
            _ => return None,
        };
        return Some(vec![CssProperty::new("box-shadow", value)]);
    }

    // Divide width (between children)
    if let Some(val) = utility.strip_prefix("divide-x-") {
        let width = match val {
            "0" => "0px",
            "2" => "2px",
            "4" => "4px",
            "8" => "8px",
            "reverse" => return Some(vec![CssProperty::new("--tw-divide-x-reverse", "1")]),
            _ => return None,
        };
        return Some(vec![
            CssProperty::new("--tw-divide-x-reverse", "0"),
            CssProperty::new(
                "border-right-width",
                &format!("calc({} * var(--tw-divide-x-reverse))", width),
            ),
            CssProperty::new(
                "border-left-width",
                &format!("calc({} * calc(1 - var(--tw-divide-x-reverse)))", width),
            ),
        ]);
    }
    if utility == "divide-x" {
        return Some(vec![
            CssProperty::new("--tw-divide-x-reverse", "0"),
            CssProperty::new(
                "border-right-width",
                "calc(1px * var(--tw-divide-x-reverse))",
            ),
            CssProperty::new(
                "border-left-width",
                "calc(1px * calc(1 - var(--tw-divide-x-reverse)))",
            ),
        ]);
    }

    if let Some(val) = utility.strip_prefix("divide-y-") {
        let width = match val {
            "0" => "0px",
            "2" => "2px",
            "4" => "4px",
            "8" => "8px",
            "reverse" => return Some(vec![CssProperty::new("--tw-divide-y-reverse", "1")]),
            _ => return None,
        };
        return Some(vec![
            CssProperty::new("--tw-divide-y-reverse", "0"),
            CssProperty::new(
                "border-top-width",
                &format!("calc({} * calc(1 - var(--tw-divide-y-reverse)))", width),
            ),
            CssProperty::new(
                "border-bottom-width",
                &format!("calc({} * var(--tw-divide-y-reverse))", width),
            ),
        ]);
    }
    if utility == "divide-y" {
        return Some(vec![
            CssProperty::new("--tw-divide-y-reverse", "0"),
            CssProperty::new(
                "border-top-width",
                "calc(1px * calc(1 - var(--tw-divide-y-reverse)))",
            ),
            CssProperty::new(
                "border-bottom-width",
                "calc(1px * var(--tw-divide-y-reverse))",
            ),
        ]);
    }

    // Divide style
    if let Some(val) = utility.strip_prefix("divide-") {
        let style = match val {
            "solid" => "solid",
            "dashed" => "dashed",
            "dotted" => "dotted",
            "double" => "double",
            "none" => "none",
            _ => return None,
        };
        return Some(vec![CssProperty::new("border-style", style)]);
    }

    None
}

/// Parse arbitrary border values like `rounded-[12px]`, `border-[3px]`
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    let property = match prefix {
        "rounded" => "border-radius",
        "border" => "border-width",
        _ => return None,
    };
    Some(vec![CssProperty::new(property, value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rounded() {
        let props = parse("rounded").unwrap();
        assert_eq!(props[0].property, "border-radius");
        assert_eq!(props[0].value, "0.25rem");
    }

    #[test]
    fn test_rounded_lg() {
        let props = parse("rounded-lg").unwrap();
        assert_eq!(props[0].property, "border-radius");
        assert_eq!(props[0].value, "0.5rem");
    }

    #[test]
    fn test_rounded_full() {
        let props = parse("rounded-full").unwrap();
        assert_eq!(props[0].property, "border-radius");
        assert_eq!(props[0].value, "9999px");
    }

    #[test]
    fn test_border() {
        let props = parse("border").unwrap();
        assert_eq!(props[0].property, "border-width");
        assert_eq!(props[0].value, "1px");
    }

    #[test]
    fn test_border_2() {
        let props = parse("border-2").unwrap();
        assert_eq!(props[0].property, "border-width");
        assert_eq!(props[0].value, "2px");
    }

    #[test]
    fn test_ring() {
        let props = parse("ring").unwrap();
        assert_eq!(props[0].property, "box-shadow");
    }

    #[test]
    fn test_ring_2() {
        let props = parse("ring-2").unwrap();
        assert_eq!(props[0].property, "box-shadow");
        assert_eq!(props[0].value, "0 0 0 2px");
    }

    #[test]
    fn test_divide_y() {
        let props = parse("divide-y").unwrap();
        assert!(props.len() >= 2);
    }

    #[test]
    fn test_divide_x_2() {
        let props = parse("divide-x-2").unwrap();
        assert!(props.len() >= 2);
    }

    /// Regression: directional rounded utilities used to only support a
    /// hand-picked subset (e.g. `rounded-t-lg` worked, `rounded-t-xl` didn't).
    /// The refactored implementation should accept every (side, size) pair
    /// from the named scale.
    #[test]
    fn test_directional_rounded_full_matrix() {
        let sides = ["t", "b", "l", "r", "tl", "tr", "bl", "br"];
        let sizes = ["none", "sm", "md", "lg", "xl", "2xl", "3xl", "full"];
        for side in sides {
            for size in sizes {
                let utility = format!("rounded-{side}-{size}");
                let props = parse(&utility)
                    .unwrap_or_else(|| panic!("missing directional radius: {utility}"));
                assert!(
                    !props.is_empty(),
                    "utility {utility} produced no properties"
                );
                // Each property should target a *-radius CSS prop
                for p in &props {
                    assert!(
                        p.property.ends_with("-radius"),
                        "{utility} produced non-radius property {}",
                        p.property
                    );
                }
            }
        }
    }

    #[test]
    fn test_rounded_t_xl_specific() {
        let props = parse("rounded-t-xl").unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].property, "border-top-left-radius");
        assert_eq!(props[0].value, "0.75rem");
        assert_eq!(props[1].property, "border-top-right-radius");
        assert_eq!(props[1].value, "0.75rem");
    }

    #[test]
    fn test_rounded_tr_2xl() {
        // Single-corner directional should affect exactly one corner.
        let props = parse("rounded-tr-2xl").unwrap();
        assert_eq!(props.len(), 1);
        assert_eq!(props[0].property, "border-top-right-radius");
        assert_eq!(props[0].value, "1rem");
    }
}
