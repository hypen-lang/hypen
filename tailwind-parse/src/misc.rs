//! Miscellaneous utilities: visibility, object-fit, aspect ratio, appearance, etc.

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Visibility
    match utility {
        "visible" => return Some(vec![CssProperty::new("visibility", "visible")]),
        "invisible" => return Some(vec![CssProperty::new("visibility", "hidden")]),
        "collapse" => return Some(vec![CssProperty::new("visibility", "collapse")]),
        _ => {}
    }

    // Object fit and position
    if let Some(val) = utility.strip_prefix("object-") {
        match val {
            "contain" => return Some(vec![CssProperty::new("object-fit", "contain")]),
            "cover" => return Some(vec![CssProperty::new("object-fit", "cover")]),
            "fill" => return Some(vec![CssProperty::new("object-fit", "fill")]),
            "none" => return Some(vec![CssProperty::new("object-fit", "none")]),
            "scale-down" => return Some(vec![CssProperty::new("object-fit", "scale-down")]),
            // Object position
            "bottom" => return Some(vec![CssProperty::new("object-position", "bottom")]),
            "center" => return Some(vec![CssProperty::new("object-position", "center")]),
            "left" => return Some(vec![CssProperty::new("object-position", "left")]),
            "left-bottom" => return Some(vec![CssProperty::new("object-position", "left bottom")]),
            "left-top" => return Some(vec![CssProperty::new("object-position", "left top")]),
            "right" => return Some(vec![CssProperty::new("object-position", "right")]),
            "right-bottom" => {
                return Some(vec![CssProperty::new("object-position", "right bottom")])
            }
            "right-top" => return Some(vec![CssProperty::new("object-position", "right top")]),
            "top" => return Some(vec![CssProperty::new("object-position", "top")]),
            _ => return None,
        };
    }

    // Aspect ratio
    if let Some(val) = utility.strip_prefix("aspect-") {
        let value: String = match val {
            "auto" => "auto".to_string(),
            "square" => "1 / 1".to_string(),
            "video" => "16 / 9".to_string(),
            // Arbitrary value: `aspect-[2/3]` → `2/3`. Tailwind escapes
            // spaces as underscores inside brackets, so undo that.
            _ if val.len() >= 2 && val.starts_with('[') && val.ends_with(']') => {
                val[1..val.len() - 1].replace('_', " ")
            }
            _ => return None,
        };
        return Some(vec![CssProperty::new("aspect-ratio", &value)]);
    }

    // Container
    if utility == "container" {
        return Some(vec![CssProperty::new("width", "100%")]);
    }

    // Box sizing
    match utility {
        "box-border" => return Some(vec![CssProperty::new("box-sizing", "border-box")]),
        "box-content" => return Some(vec![CssProperty::new("box-sizing", "content-box")]),
        _ => {}
    }

    // Float
    match utility {
        "float-right" => return Some(vec![CssProperty::new("float", "right")]),
        "float-left" => return Some(vec![CssProperty::new("float", "left")]),
        "float-none" => return Some(vec![CssProperty::new("float", "none")]),
        _ => {}
    }

    // Clear
    match utility {
        "clear-left" => return Some(vec![CssProperty::new("clear", "left")]),
        "clear-right" => return Some(vec![CssProperty::new("clear", "right")]),
        "clear-both" => return Some(vec![CssProperty::new("clear", "both")]),
        "clear-none" => return Some(vec![CssProperty::new("clear", "none")]),
        _ => {}
    }

    // Isolation
    match utility {
        "isolate" => return Some(vec![CssProperty::new("isolation", "isolate")]),
        "isolation-auto" => return Some(vec![CssProperty::new("isolation", "auto")]),
        _ => {}
    }

    // Vertical align
    if let Some(val) = utility.strip_prefix("align-") {
        let value = match val {
            "baseline" => "baseline",
            "top" => "top",
            "middle" => "middle",
            "bottom" => "bottom",
            "text-top" => "text-top",
            "text-bottom" => "text-bottom",
            "sub" => "sub",
            "super" => "super",
            _ => return None,
        };
        return Some(vec![CssProperty::new("vertical-align", value)]);
    }

    // Appearance
    match utility {
        "appearance-none" => return Some(vec![CssProperty::new("appearance", "none")]),
        "appearance-auto" => return Some(vec![CssProperty::new("appearance", "auto")]),
        _ => {}
    }

    // List style
    if let Some(val) = utility.strip_prefix("list-") {
        match val {
            "none" => return Some(vec![CssProperty::new("list-style-type", "none")]),
            "disc" => return Some(vec![CssProperty::new("list-style-type", "disc")]),
            "decimal" => return Some(vec![CssProperty::new("list-style-type", "decimal")]),
            "inside" => return Some(vec![CssProperty::new("list-style-position", "inside")]),
            "outside" => return Some(vec![CssProperty::new("list-style-position", "outside")]),
            _ => return None,
        };
    }

    // Scroll behavior
    match utility {
        "scroll-auto" => return Some(vec![CssProperty::new("scroll-behavior", "auto")]),
        "scroll-smooth" => return Some(vec![CssProperty::new("scroll-behavior", "smooth")]),
        _ => {}
    }

    // Will change
    if let Some(val) = utility.strip_prefix("will-change-") {
        let value = match val {
            "auto" => "auto",
            "scroll" => "scroll-position",
            "contents" => "contents",
            "transform" => "transform",
            _ => return None,
        };
        return Some(vec![CssProperty::new("will-change", value)]);
    }

    // SVG
    match utility {
        "fill-current" => return Some(vec![CssProperty::new("fill", "currentColor")]),
        "fill-none" => return Some(vec![CssProperty::new("fill", "none")]),
        "stroke-current" => return Some(vec![CssProperty::new("stroke", "currentColor")]),
        "stroke-none" => return Some(vec![CssProperty::new("stroke", "none")]),
        _ => {}
    }
    if let Some(val) = utility.strip_prefix("stroke-") {
        let value = match val {
            "0" => "0",
            "1" => "1",
            "2" => "2",
            _ => return None,
        };
        return Some(vec![CssProperty::new("stroke-width", value)]);
    }

    // `sr-only` / `not-sr-only` are rejected in `parser::forbidden_utility_reason`
    // (they rely on absolute positioning); use the VisuallyHidden component.

    // Antialiasing
    match utility {
        "antialiased" => {
            return Some(vec![
                CssProperty::new("-webkit-font-smoothing", "antialiased"),
                CssProperty::new("-moz-osx-font-smoothing", "grayscale"),
            ])
        }
        "subpixel-antialiased" => {
            return Some(vec![
                CssProperty::new("-webkit-font-smoothing", "auto"),
                CssProperty::new("-moz-osx-font-smoothing", "auto"),
            ])
        }
        _ => {}
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_visibility() {
        let props = parse("invisible").unwrap();
        assert_eq!(props[0].property, "visibility");
        assert_eq!(props[0].value, "hidden");
    }

    #[test]
    fn test_object_fit() {
        let props = parse("object-cover").unwrap();
        assert_eq!(props[0].property, "object-fit");
        assert_eq!(props[0].value, "cover");
    }

    #[test]
    fn test_aspect_ratio() {
        let props = parse("aspect-video").unwrap();
        assert_eq!(props[0].property, "aspect-ratio");
        assert_eq!(props[0].value, "16 / 9");
    }

    #[test]
    fn test_aspect_ratio_arbitrary() {
        let props = parse("aspect-[2/3]").unwrap();
        assert_eq!(props[0].property, "aspect-ratio");
        assert_eq!(props[0].value, "2/3");
    }

    #[test]
    fn test_vertical_align() {
        let props = parse("align-middle").unwrap();
        assert_eq!(props[0].property, "vertical-align");
        assert_eq!(props[0].value, "middle");
    }

    #[test]
    fn test_list_style() {
        let props = parse("list-disc").unwrap();
        assert_eq!(props[0].property, "list-style-type");
        assert_eq!(props[0].value, "disc");
    }
}
