//! Effect utilities: shadow, opacity, blur, etc.

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Box shadow
    if let Some(val) = utility.strip_prefix("shadow-") {
        let value = match val {
            "sm" => "0 1px 2px 0 rgb(0 0 0 / 0.05)",
            "md" => "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
            "lg" => "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
            "xl" => "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
            "2xl" => "0 25px 50px -12px rgb(0 0 0 / 0.25)",
            "inner" => "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
            "none" => "0 0 #0000",
            _ => return None,
        };
        return Some(vec![CssProperty::new("box-shadow", value)]);
    }

    // Plain shadow
    if utility == "shadow" {
        return Some(vec![CssProperty::new(
            "box-shadow",
            "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        )]);
    }

    // Blur
    if let Some(val) = utility.strip_prefix("blur-") {
        let value = match val {
            "none" => "blur(0)",
            "sm" => "blur(4px)",
            "md" => "blur(12px)",
            "lg" => "blur(16px)",
            "xl" => "blur(24px)",
            "2xl" => "blur(40px)",
            "3xl" => "blur(64px)",
            _ => return None,
        };
        return Some(vec![CssProperty::new("filter", value)]);
    }
    if utility == "blur" {
        return Some(vec![CssProperty::new("filter", "blur(8px)")]);
    }

    // Backdrop blur
    if let Some(val) = utility.strip_prefix("backdrop-blur-") {
        let value = match val {
            "none" => "blur(0)",
            "sm" => "blur(4px)",
            "md" => "blur(12px)",
            "lg" => "blur(16px)",
            "xl" => "blur(24px)",
            "2xl" => "blur(40px)",
            "3xl" => "blur(64px)",
            _ => return None,
        };
        return Some(vec![CssProperty::new("backdrop-filter", value)]);
    }
    if utility == "backdrop-blur" {
        return Some(vec![CssProperty::new("backdrop-filter", "blur(8px)")]);
    }

    // Brightness
    if let Some(val) = utility.strip_prefix("brightness-") {
        let value = match val {
            "0" => "brightness(0)",
            "50" => "brightness(.5)",
            "75" => "brightness(.75)",
            "90" => "brightness(.9)",
            "95" => "brightness(.95)",
            "100" => "brightness(1)",
            "105" => "brightness(1.05)",
            "110" => "brightness(1.1)",
            "125" => "brightness(1.25)",
            "150" => "brightness(1.5)",
            "200" => "brightness(2)",
            _ => return None,
        };
        return Some(vec![CssProperty::new("filter", value)]);
    }

    // Grayscale
    match utility {
        "grayscale" => return Some(vec![CssProperty::new("filter", "grayscale(100%)")]),
        "grayscale-0" => return Some(vec![CssProperty::new("filter", "grayscale(0)")]),
        _ => {}
    }

    // Invert
    match utility {
        "invert" => return Some(vec![CssProperty::new("filter", "invert(100%)")]),
        "invert-0" => return Some(vec![CssProperty::new("filter", "invert(0)")]),
        _ => {}
    }

    // Mix blend mode
    if let Some(val) = utility.strip_prefix("mix-blend-") {
        let value = match val {
            "normal" => "normal",
            "multiply" => "multiply",
            "screen" => "screen",
            "overlay" => "overlay",
            "darken" => "darken",
            "lighten" => "lighten",
            "color-dodge" => "color-dodge",
            "color-burn" => "color-burn",
            "hard-light" => "hard-light",
            "soft-light" => "soft-light",
            "difference" => "difference",
            "exclusion" => "exclusion",
            "hue" => "hue",
            "saturation" => "saturation",
            "color" => "color",
            "luminosity" => "luminosity",
            _ => return None,
        };
        return Some(vec![CssProperty::new("mix-blend-mode", value)]);
    }

    // Cursor
    if let Some(val) = utility.strip_prefix("cursor-") {
        let value = match val {
            "auto" => "auto",
            "default" => "default",
            "pointer" => "pointer",
            "wait" => "wait",
            "text" => "text",
            "move" => "move",
            "help" => "help",
            "not-allowed" => "not-allowed",
            "none" => "none",
            "context-menu" => "context-menu",
            "progress" => "progress",
            "cell" => "cell",
            "crosshair" => "crosshair",
            "vertical-text" => "vertical-text",
            "alias" => "alias",
            "copy" => "copy",
            "no-drop" => "no-drop",
            "grab" => "grab",
            "grabbing" => "grabbing",
            _ => return None,
        };
        return Some(vec![CssProperty::new("cursor", value)]);
    }

    // Pointer events
    match utility {
        "pointer-events-none" => return Some(vec![CssProperty::new("pointer-events", "none")]),
        "pointer-events-auto" => return Some(vec![CssProperty::new("pointer-events", "auto")]),
        _ => {}
    }

    // User select
    if let Some(val) = utility.strip_prefix("select-") {
        let value = match val {
            "none" => "none",
            "text" => "text",
            "all" => "all",
            "auto" => "auto",
            _ => return None,
        };
        return Some(vec![CssProperty::new("user-select", value)]);
    }

    // Transition
    match utility {
        "transition" => {
            return Some(vec![
                CssProperty::new(
                    "transition-property",
                    "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
                ),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-all" => {
            return Some(vec![
                CssProperty::new("transition-property", "all"),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-colors" => {
            return Some(vec![
                CssProperty::new(
                    "transition-property",
                    "color, background-color, border-color, text-decoration-color, fill, stroke",
                ),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-opacity" => {
            return Some(vec![
                CssProperty::new("transition-property", "opacity"),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-shadow" => {
            return Some(vec![
                CssProperty::new("transition-property", "box-shadow"),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-transform" => {
            return Some(vec![
                CssProperty::new("transition-property", "transform"),
                CssProperty::new("transition-timing-function", "cubic-bezier(0.4, 0, 0.2, 1)"),
                CssProperty::new("transition-duration", "150ms"),
            ])
        }
        "transition-none" => {
            return Some(vec![CssProperty::new("transition-property", "none")])
        }
        _ => {}
    }

    // Duration
    if let Some(val) = utility.strip_prefix("duration-") {
        let value = match val {
            "0" => "0s",
            "75" => "75ms",
            "100" => "100ms",
            "150" => "150ms",
            "200" => "200ms",
            "300" => "300ms",
            "500" => "500ms",
            "700" => "700ms",
            "1000" => "1000ms",
            _ => return None,
        };
        return Some(vec![CssProperty::new("transition-duration", value)]);
    }

    // Ease
    if let Some(val) = utility.strip_prefix("ease-") {
        let value = match val {
            "linear" => "linear",
            "in" => "cubic-bezier(0.4, 0, 1, 1)",
            "out" => "cubic-bezier(0, 0, 0.2, 1)",
            "in-out" => "cubic-bezier(0.4, 0, 0.2, 1)",
            _ => return None,
        };
        return Some(vec![CssProperty::new("transition-timing-function", value)]);
    }

    None
}

/// Parse arbitrary effect values like `opacity-[0.5]`, `z-[999]`,
/// `shadow-[0_1px_2px_rgba(0,0,0,0.5)]` (underscores already normalized to spaces)
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    match prefix {
        "opacity" => Some(vec![CssProperty::new("opacity", value)]),
        "z" => Some(vec![CssProperty::new("z-index", value)]),
        "shadow" => Some(vec![CssProperty::new("box-shadow", value)]),
        "blur" => Some(vec![CssProperty::new(
            "filter",
            &format_filter_value("blur", value),
        )]),
        "backdrop-blur" => Some(vec![CssProperty::new(
            "backdrop-filter",
            &format_filter_value("blur", value),
        )]),
        _ => None,
    }
}

fn format_filter_value(function: &str, value: &str) -> String {
    if value.contains('(') {
        value.to_string()
    } else {
        format!("{}({})", function, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shadow() {
        let props = parse("shadow").unwrap();
        assert_eq!(props[0].property, "box-shadow");
    }

    #[test]
    fn test_shadow_lg() {
        let props = parse("shadow-lg").unwrap();
        assert_eq!(props[0].property, "box-shadow");
    }

    #[test]
    fn test_blur() {
        let props = parse("blur").unwrap();
        assert_eq!(props[0].property, "filter");
        assert_eq!(props[0].value, "blur(8px)");
    }

    #[test]
    fn test_cursor() {
        let props = parse("cursor-pointer").unwrap();
        assert_eq!(props[0].property, "cursor");
        assert_eq!(props[0].value, "pointer");
    }

    #[test]
    fn test_transition() {
        let props = parse("transition").unwrap();
        assert_eq!(props.len(), 3);
    }

    #[test]
    fn test_arbitrary_backdrop_blur() {
        let props = parse_arbitrary("backdrop-blur", "18px").unwrap();
        assert_eq!(props[0].property, "backdrop-filter");
        assert_eq!(props[0].value, "blur(18px)");
    }
}
