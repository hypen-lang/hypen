//! Background utilities: attachment, clip, origin, position, repeat, size, gradients

use crate::parser::CssProperty;

/// Create a transparent version of a color for gradient stops.
/// For hex colors like "#3b82f6", appends "00" alpha to produce "#3b82f600".
/// For non-hex colors, falls back to "transparent".
fn make_transparent(color: &str) -> String {
    if color.starts_with('#') && color.len() == 7 {
        format!("{}00", color)
    } else {
        "transparent".to_string()
    }
}

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Background attachment
    match utility {
        "bg-fixed" => return Some(vec![CssProperty::new("background-attachment", "fixed")]),
        "bg-local" => return Some(vec![CssProperty::new("background-attachment", "local")]),
        "bg-scroll" => return Some(vec![CssProperty::new("background-attachment", "scroll")]),
        _ => {}
    }

    // Background clip
    match utility {
        "bg-clip-border" => return Some(vec![CssProperty::new("background-clip", "border-box")]),
        "bg-clip-padding" => return Some(vec![CssProperty::new("background-clip", "padding-box")]),
        "bg-clip-content" => return Some(vec![CssProperty::new("background-clip", "content-box")]),
        "bg-clip-text" => return Some(vec![CssProperty::new("background-clip", "text")]),
        _ => {}
    }

    // Background origin
    match utility {
        "bg-origin-border" => {
            return Some(vec![CssProperty::new("background-origin", "border-box")])
        }
        "bg-origin-padding" => {
            return Some(vec![CssProperty::new("background-origin", "padding-box")])
        }
        "bg-origin-content" => {
            return Some(vec![CssProperty::new("background-origin", "content-box")])
        }
        _ => {}
    }

    // Background position
    match utility {
        "bg-bottom" => return Some(vec![CssProperty::new("background-position", "bottom")]),
        "bg-center" => return Some(vec![CssProperty::new("background-position", "center")]),
        "bg-left" => return Some(vec![CssProperty::new("background-position", "left")]),
        "bg-left-bottom" => {
            return Some(vec![CssProperty::new("background-position", "left bottom")])
        }
        "bg-left-top" => return Some(vec![CssProperty::new("background-position", "left top")]),
        "bg-right" => return Some(vec![CssProperty::new("background-position", "right")]),
        "bg-right-bottom" => {
            return Some(vec![CssProperty::new(
                "background-position",
                "right bottom",
            )])
        }
        "bg-right-top" => return Some(vec![CssProperty::new("background-position", "right top")]),
        "bg-top" => return Some(vec![CssProperty::new("background-position", "top")]),
        _ => {}
    }

    // Background repeat
    match utility {
        "bg-repeat" => return Some(vec![CssProperty::new("background-repeat", "repeat")]),
        "bg-no-repeat" => return Some(vec![CssProperty::new("background-repeat", "no-repeat")]),
        "bg-repeat-x" => return Some(vec![CssProperty::new("background-repeat", "repeat-x")]),
        "bg-repeat-y" => return Some(vec![CssProperty::new("background-repeat", "repeat-y")]),
        "bg-repeat-round" => return Some(vec![CssProperty::new("background-repeat", "round")]),
        "bg-repeat-space" => return Some(vec![CssProperty::new("background-repeat", "space")]),
        _ => {}
    }

    // Background size
    match utility {
        "bg-auto" => return Some(vec![CssProperty::new("background-size", "auto")]),
        "bg-cover" => return Some(vec![CssProperty::new("background-size", "cover")]),
        "bg-contain" => return Some(vec![CssProperty::new("background-size", "contain")]),
        _ => {}
    }

    // Background image / Gradients
    match utility {
        "bg-none" => return Some(vec![CssProperty::new("background-image", "none")]),
        "bg-gradient-to-t" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to top, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-tr" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to top right, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-r" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to right, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-br" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to bottom right, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-b" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to bottom, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-bl" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to bottom left, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-l" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to left, var(--tw-gradient-stops))",
            )])
        }
        "bg-gradient-to-tl" => {
            return Some(vec![CssProperty::new(
                "background-image",
                "linear-gradient(to top left, var(--tw-gradient-stops))",
            )])
        }
        _ => {}
    }

    // Gradient color stops: from-*, via-*, to-*
    if let Some(color_name) = utility.strip_prefix("from-") {
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            let transparent = make_transparent(color);
            return Some(vec![
                CssProperty::new("--tw-gradient-from", color),
                CssProperty::new("--tw-gradient-to", &transparent),
                CssProperty::new(
                    "--tw-gradient-stops",
                    "var(--tw-gradient-from), var(--tw-gradient-to)",
                ),
            ]);
        }
    }

    if let Some(color_name) = utility.strip_prefix("via-") {
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            let transparent = make_transparent(color);
            return Some(vec![
                CssProperty::new("--tw-gradient-via", color),
                CssProperty::new("--tw-gradient-to", &transparent),
                CssProperty::new(
                    "--tw-gradient-stops",
                    &format!("var(--tw-gradient-from), {}, var(--tw-gradient-to)", color),
                ),
            ]);
        }
    }

    if let Some(color_name) = utility.strip_prefix("to-") {
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            return Some(vec![CssProperty::new("--tw-gradient-to", color)]);
        }
    }

    None
}

/// Parse arbitrary background values like `bg-[#FCFCFC]`, `bg-[rgb(252,252,252)]`,
/// `bg-[url(...)]`. Image-like values map to background-image, everything else
/// to background-color.
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    match prefix {
        "bg" => {
            let property = if value.starts_with("url(")
                || value.starts_with("linear-gradient(")
                || value.starts_with("radial-gradient(")
                || value.starts_with("conic-gradient(")
            {
                "background-image"
            } else {
                "background-color"
            };
            Some(vec![CssProperty::new(property, value)])
        }
        "from" => {
            let transparent = make_transparent(value);
            Some(vec![
                CssProperty::new("--tw-gradient-from", value),
                CssProperty::new("--tw-gradient-to", &transparent),
                CssProperty::new(
                    "--tw-gradient-stops",
                    "var(--tw-gradient-from), var(--tw-gradient-to)",
                ),
            ])
        }
        "via" => {
            let transparent = make_transparent(value);
            Some(vec![
                CssProperty::new("--tw-gradient-via", value),
                CssProperty::new("--tw-gradient-to", &transparent),
                CssProperty::new(
                    "--tw-gradient-stops",
                    &format!("var(--tw-gradient-from), {}, var(--tw-gradient-to)", value),
                ),
            ])
        }
        "to" => Some(vec![CssProperty::new("--tw-gradient-to", value)]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bg_fixed() {
        let props = parse("bg-fixed").unwrap();
        assert_eq!(props[0].property, "background-attachment");
        assert_eq!(props[0].value, "fixed");
    }

    #[test]
    fn test_bg_cover() {
        let props = parse("bg-cover").unwrap();
        assert_eq!(props[0].property, "background-size");
        assert_eq!(props[0].value, "cover");
    }

    #[test]
    fn test_bg_center() {
        let props = parse("bg-center").unwrap();
        assert_eq!(props[0].property, "background-position");
        assert_eq!(props[0].value, "center");
    }

    #[test]
    fn test_bg_no_repeat() {
        let props = parse("bg-no-repeat").unwrap();
        assert_eq!(props[0].property, "background-repeat");
        assert_eq!(props[0].value, "no-repeat");
    }

    #[test]
    fn test_bg_clip_text() {
        let props = parse("bg-clip-text").unwrap();
        assert_eq!(props[0].property, "background-clip");
        assert_eq!(props[0].value, "text");
    }

    #[test]
    fn test_gradient_to_r() {
        let props = parse("bg-gradient-to-r").unwrap();
        assert_eq!(props[0].property, "background-image");
        assert!(props[0].value.contains("to right"));
    }

    #[test]
    fn test_from_color() {
        let props = parse("from-blue-500").unwrap();
        assert_eq!(props[0].property, "--tw-gradient-from");
        assert_eq!(props[0].value, "#3b82f6");
    }

    #[test]
    fn test_to_color() {
        let props = parse("to-red-500").unwrap();
        assert_eq!(props[0].property, "--tw-gradient-to");
        assert_eq!(props[0].value, "#ef4444");
    }

    #[test]
    fn test_arbitrary_bg_hex() {
        let props = parse_arbitrary("bg", "#FCFCFC").unwrap();
        assert_eq!(props[0].property, "background-color");
        assert_eq!(props[0].value, "#FCFCFC");
    }

    #[test]
    fn test_arbitrary_bg_rgb() {
        let props = parse_arbitrary("bg", "rgb(252,252,252)").unwrap();
        assert_eq!(props[0].property, "background-color");
        assert_eq!(props[0].value, "rgb(252,252,252)");
    }

    #[test]
    fn test_arbitrary_bg_url_is_image() {
        let props = parse_arbitrary("bg", "url(/img/hero.png)").unwrap();
        assert_eq!(props[0].property, "background-image");
        assert_eq!(props[0].value, "url(/img/hero.png)");
    }

    #[test]
    fn test_arbitrary_gradient_stops() {
        let props = parse_arbitrary("from", "#112233").unwrap();
        assert_eq!(props[0].property, "--tw-gradient-from");
        assert_eq!(props[0].value, "#112233");
        assert_eq!(props[1].value, "#11223300");

        let props = parse_arbitrary("to", "#445566").unwrap();
        assert_eq!(props[0].property, "--tw-gradient-to");
        assert_eq!(props[0].value, "#445566");
    }
}
