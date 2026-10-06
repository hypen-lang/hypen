//! Typography utilities: font size, weight, family, alignment

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Font size: text-xs, text-sm, text-base, text-lg, text-xl, etc.
    if let Some(size) = utility.strip_prefix("text-") {
        let (font_size, line_height) = match size {
            "xs" => ("0.75rem", "1rem"),
            "sm" => ("0.875rem", "1.25rem"),
            "base" => ("1rem", "1.5rem"),
            "lg" => ("1.125rem", "1.75rem"),
            "xl" => ("1.25rem", "1.75rem"),
            "2xl" => ("1.5rem", "2rem"),
            "3xl" => ("1.875rem", "2.25rem"),
            "4xl" => ("2.25rem", "2.5rem"),
            "5xl" => ("3rem", "1"),
            "6xl" => ("3.75rem", "1"),
            "7xl" => ("4.5rem", "1"),
            "8xl" => ("6rem", "1"),
            "9xl" => ("8rem", "1"),
            // Text alignment
            "left" => return Some(vec![CssProperty::new("text-align", "left")]),
            "center" => return Some(vec![CssProperty::new("text-align", "center")]),
            "right" => return Some(vec![CssProperty::new("text-align", "right")]),
            "justify" => return Some(vec![CssProperty::new("text-align", "justify")]),
            "start" => return Some(vec![CssProperty::new("text-align", "start")]),
            "end" => return Some(vec![CssProperty::new("text-align", "end")]),
            _ => return None,
        };
        return Some(vec![
            CssProperty::new("font-size", font_size),
            CssProperty::new("line-height", line_height),
        ]);
    }

    // Font weight: font-thin, font-normal, font-bold, etc.
    if let Some(weight) = utility.strip_prefix("font-") {
        let value = match weight {
            "thin" => "100",
            "extralight" => "200",
            "light" => "300",
            "normal" => "400",
            "medium" => "500",
            "semibold" => "600",
            "bold" => "700",
            "extrabold" => "800",
            "black" => "900",
            // Font family
            "sans" => {
                return Some(vec![CssProperty::new(
                    "font-family",
                    "ui-sans-serif, system-ui, sans-serif",
                )])
            }
            "serif" => {
                return Some(vec![CssProperty::new(
                    "font-family",
                    "ui-serif, Georgia, serif",
                )])
            }
            "mono" => {
                return Some(vec![CssProperty::new(
                    "font-family",
                    "ui-monospace, monospace",
                )])
            }
            _ => return None,
        };
        return Some(vec![CssProperty::new("font-weight", value)]);
    }

    // Line height: leading-none, leading-tight, leading-normal, etc.
    if let Some(leading) = utility.strip_prefix("leading-") {
        let value = match leading {
            "3" => "0.75rem",
            "4" => "1rem",
            "5" => "1.25rem",
            "6" => "1.5rem",
            "7" => "1.75rem",
            "8" => "2rem",
            "9" => "2.25rem",
            "10" => "2.5rem",
            "none" => "1",
            "tight" => "1.25",
            "snug" => "1.375",
            "normal" => "1.5",
            "relaxed" => "1.625",
            "loose" => "2",
            _ => return None,
        };
        return Some(vec![CssProperty::new("line-height", value)]);
    }

    // Letter spacing: tracking-tighter, tracking-normal, tracking-wider, etc.
    if let Some(tracking) = utility.strip_prefix("tracking-") {
        let value = match tracking {
            "tighter" => "-0.05em",
            "tight" => "-0.025em",
            "normal" => "0em",
            "wide" => "0.025em",
            "wider" => "0.05em",
            "widest" => "0.1em",
            _ => return None,
        };
        return Some(vec![CssProperty::new("letter-spacing", value)]);
    }

    // Font smoothing
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

    // Font style
    match utility {
        "italic" => return Some(vec![CssProperty::new("font-style", "italic")]),
        "not-italic" => return Some(vec![CssProperty::new("font-style", "normal")]),
        _ => {}
    }

    // Font variant numeric
    match utility {
        "normal-nums" => return Some(vec![CssProperty::new("font-variant-numeric", "normal")]),
        "ordinal" => return Some(vec![CssProperty::new("font-variant-numeric", "ordinal")]),
        "slashed-zero" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "slashed-zero",
            )])
        }
        "lining-nums" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "lining-nums",
            )])
        }
        "oldstyle-nums" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "oldstyle-nums",
            )])
        }
        "proportional-nums" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "proportional-nums",
            )])
        }
        "tabular-nums" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "tabular-nums",
            )])
        }
        "diagonal-fractions" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "diagonal-fractions",
            )])
        }
        "stacked-fractions" => {
            return Some(vec![CssProperty::new(
                "font-variant-numeric",
                "stacked-fractions",
            )])
        }
        _ => {}
    }

    // Line clamp
    if let Some(val) = utility.strip_prefix("line-clamp-") {
        if val == "none" {
            return Some(vec![
                CssProperty::new("overflow", "visible"),
                CssProperty::new("display", "block"),
                CssProperty::new("-webkit-box-orient", "horizontal"),
                CssProperty::new("-webkit-line-clamp", "none"),
            ]);
        }
        return Some(vec![
            CssProperty::new("overflow", "hidden"),
            CssProperty::new("display", "-webkit-box"),
            CssProperty::new("-webkit-box-orient", "vertical"),
            CssProperty::new("-webkit-line-clamp", val),
        ]);
    }

    // Text decoration
    match utility {
        "underline" => return Some(vec![CssProperty::new("text-decoration-line", "underline")]),
        "overline" => return Some(vec![CssProperty::new("text-decoration-line", "overline")]),
        "line-through" => {
            return Some(vec![CssProperty::new(
                "text-decoration-line",
                "line-through",
            )])
        }
        "no-underline" => return Some(vec![CssProperty::new("text-decoration-line", "none")]),
        _ => {}
    }

    // Text decoration style
    match utility {
        "decoration-solid" => {
            return Some(vec![CssProperty::new("text-decoration-style", "solid")])
        }
        "decoration-double" => {
            return Some(vec![CssProperty::new("text-decoration-style", "double")])
        }
        "decoration-dotted" => {
            return Some(vec![CssProperty::new("text-decoration-style", "dotted")])
        }
        "decoration-dashed" => {
            return Some(vec![CssProperty::new("text-decoration-style", "dashed")])
        }
        "decoration-wavy" => return Some(vec![CssProperty::new("text-decoration-style", "wavy")]),
        _ => {}
    }

    // Text decoration thickness
    if let Some(val) = utility.strip_prefix("decoration-") {
        let value = match val {
            "auto" => "auto",
            "from-font" => "from-font",
            "0" => "0px",
            "1" => "1px",
            "2" => "2px",
            "4" => "4px",
            "8" => "8px",
            _ => return None,
        };
        return Some(vec![CssProperty::new("text-decoration-thickness", value)]);
    }

    // Text decoration color
    if let Some(color_name) = utility.strip_prefix("decoration-") {
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            return Some(vec![CssProperty::new("text-decoration-color", color)]);
        }
    }

    // Text underline offset
    if let Some(val) = utility.strip_prefix("underline-offset-") {
        let value = match val {
            "auto" => "auto",
            "0" => "0px",
            "1" => "1px",
            "2" => "2px",
            "4" => "4px",
            "8" => "8px",
            _ => return None,
        };
        return Some(vec![CssProperty::new("text-underline-offset", value)]);
    }

    // Text wrap
    match utility {
        "text-wrap" => return Some(vec![CssProperty::new("text-wrap", "wrap")]),
        "text-nowrap" => return Some(vec![CssProperty::new("text-wrap", "nowrap")]),
        "text-balance" => return Some(vec![CssProperty::new("text-wrap", "balance")]),
        "text-pretty" => return Some(vec![CssProperty::new("text-wrap", "pretty")]),
        _ => {}
    }

    // Text transform
    match utility {
        "uppercase" => return Some(vec![CssProperty::new("text-transform", "uppercase")]),
        "lowercase" => return Some(vec![CssProperty::new("text-transform", "lowercase")]),
        "capitalize" => return Some(vec![CssProperty::new("text-transform", "capitalize")]),
        "normal-case" => return Some(vec![CssProperty::new("text-transform", "none")]),
        _ => {}
    }

    // Text overflow
    match utility {
        // Emit Hypen-native props directly: native renderers (iOS/Android)
        // consume `maxLines` + `textOverflow` applicators, and the DOM
        // renderer maps these back to the CSS triplet. Keeping the
        // translation here avoids giving every native target its own
        // `white-space: nowrap` → `maxLines = 1` plumbing.
        "truncate" => {
            return Some(vec![
                CssProperty::new("maxLines", "1"),
                CssProperty::new("textOverflow", "ellipsis"),
            ])
        }
        "text-ellipsis" => return Some(vec![CssProperty::new("text-overflow", "ellipsis")]),
        "text-clip" => return Some(vec![CssProperty::new("text-overflow", "clip")]),
        _ => {}
    }

    // Whitespace
    if let Some(ws) = utility.strip_prefix("whitespace-") {
        let value = match ws {
            "normal" => "normal",
            "nowrap" => "nowrap",
            "pre" => "pre",
            "pre-line" => "pre-line",
            "pre-wrap" => "pre-wrap",
            "break-spaces" => "break-spaces",
            _ => return None,
        };
        return Some(vec![CssProperty::new("white-space", value)]);
    }

    // Word break
    match utility {
        "break-normal" => {
            return Some(vec![
                CssProperty::new("overflow-wrap", "normal"),
                CssProperty::new("word-break", "normal"),
            ])
        }
        "break-words" => return Some(vec![CssProperty::new("overflow-wrap", "break-word")]),
        "break-all" => return Some(vec![CssProperty::new("word-break", "break-all")]),
        "break-keep" => return Some(vec![CssProperty::new("word-break", "keep-all")]),
        _ => {}
    }

    // Hyphens
    if let Some(val) = utility.strip_prefix("hyphens-") {
        let value = match val {
            "none" => "none",
            "manual" => "manual",
            "auto" => "auto",
            _ => return None,
        };
        return Some(vec![CssProperty::new("hyphens", value)]);
    }

    // Content
    if let Some(val) = utility.strip_prefix("content-") {
        let value = match val {
            "none" => "none",
            _ => return None,
        };
        return Some(vec![CssProperty::new("content", value)]);
    }

    // Placeholder color (uses ::placeholder pseudo-element, we output as CSS var for renderers)
    if let Some(color_name) = utility.strip_prefix("placeholder-") {
        // Handle opacity separately
        if color_name.starts_with("opacity-") {
            let opacity = match color_name.strip_prefix("opacity-") {
                Some("0") => "0",
                Some("5") => "0.05",
                Some("10") => "0.1",
                Some("20") => "0.2",
                Some("25") => "0.25",
                Some("30") => "0.3",
                Some("40") => "0.4",
                Some("50") => "0.5",
                Some("60") => "0.6",
                Some("70") => "0.7",
                Some("75") => "0.75",
                Some("80") => "0.8",
                Some("90") => "0.9",
                Some("95") => "0.95",
                Some("100") => "1",
                _ => return None,
            };
            return Some(vec![CssProperty::new("--tw-placeholder-opacity", opacity)]);
        }
        // Color value - renderer will apply to ::placeholder
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            return Some(vec![CssProperty::new("--tw-placeholder-color", color)]);
        }
    }

    // Text indent
    if let Some(val) = utility.strip_prefix("indent-") {
        let value = match val {
            "0" => "0px",
            "px" => "1px",
            "0.5" => "0.125rem",
            "1" => "0.25rem",
            "1.5" => "0.375rem",
            "2" => "0.5rem",
            "2.5" => "0.625rem",
            "3" => "0.75rem",
            "3.5" => "0.875rem",
            "4" => "1rem",
            "5" => "1.25rem",
            "6" => "1.5rem",
            "7" => "1.75rem",
            "8" => "2rem",
            "9" => "2.25rem",
            "10" => "2.5rem",
            "11" => "2.75rem",
            "12" => "3rem",
            "14" => "3.5rem",
            "16" => "4rem",
            "20" => "5rem",
            "24" => "6rem",
            "28" => "7rem",
            "32" => "8rem",
            "36" => "9rem",
            "40" => "10rem",
            "44" => "11rem",
            "48" => "12rem",
            "52" => "13rem",
            "56" => "14rem",
            "60" => "15rem",
            "64" => "16rem",
            "72" => "18rem",
            "80" => "20rem",
            "96" => "24rem",
            _ => return None,
        };
        return Some(vec![CssProperty::new("text-indent", value)]);
    }

    None
}

/// Parse arbitrary typography values like `text-[#ff00ff]`, `text-[14px]`, `leading-[1.5]`
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    let property = match prefix {
        // text-[...] accepts both colors and sizes: text-[#ff00ff] vs text-[14px]
        "text" => {
            if crate::colors::is_color_like(value) {
                "color"
            } else {
                "font-size"
            }
        }
        "font-size" => "font-size",
        "leading" => "line-height",
        "tracking" => "letter-spacing",
        _ => return None,
    };
    Some(vec![CssProperty::new(property, value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_font_size() {
        let props = parse("text-xl").unwrap();
        assert_eq!(props[0].property, "font-size");
        assert_eq!(props[0].value, "1.25rem");
    }

    #[test]
    fn test_font_weight() {
        let props = parse("font-bold").unwrap();
        assert_eq!(props[0].property, "font-weight");
        assert_eq!(props[0].value, "700");
    }

    #[test]
    fn test_text_align() {
        let props = parse("text-center").unwrap();
        assert_eq!(props[0].property, "text-align");
        assert_eq!(props[0].value, "center");
    }

    #[test]
    fn test_truncate() {
        let props = parse("truncate").unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].property, "maxLines");
        assert_eq!(props[0].value, "1");
        assert_eq!(props[1].property, "textOverflow");
        assert_eq!(props[1].value, "ellipsis");
    }
}
