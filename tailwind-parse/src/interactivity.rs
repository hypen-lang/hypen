//! Interactivity utilities: accent, caret, appearance, resize, scroll, snap, touch, will-change

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Accent color
    if let Some(color_name) = utility.strip_prefix("accent-") {
        if color_name == "auto" {
            return Some(vec![CssProperty::new("accent-color", "auto")]);
        }
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            return Some(vec![CssProperty::new("accent-color", color)]);
        }
    }

    // Caret color
    if let Some(color_name) = utility.strip_prefix("caret-") {
        if let Some(color) = crate::colors::COLORS.get(color_name) {
            return Some(vec![CssProperty::new("caret-color", color)]);
        }
    }

    // Appearance
    match utility {
        "appearance-none" => return Some(vec![CssProperty::new("appearance", "none")]),
        "appearance-auto" => return Some(vec![CssProperty::new("appearance", "auto")]),
        _ => {}
    }

    // Resize
    match utility {
        "resize-none" => return Some(vec![CssProperty::new("resize", "none")]),
        "resize-y" => return Some(vec![CssProperty::new("resize", "vertical")]),
        "resize-x" => return Some(vec![CssProperty::new("resize", "horizontal")]),
        "resize" => return Some(vec![CssProperty::new("resize", "both")]),
        _ => {}
    }

    // Scroll behavior
    match utility {
        "scroll-auto" => return Some(vec![CssProperty::new("scroll-behavior", "auto")]),
        "scroll-smooth" => return Some(vec![CssProperty::new("scroll-behavior", "smooth")]),
        _ => {}
    }

    // Scroll margin
    if let Some(val) = utility.strip_prefix("scroll-m-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-margin", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-mx-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("scroll-margin-left", value),
            CssProperty::new("scroll-margin-right", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("scroll-my-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("scroll-margin-top", value),
            CssProperty::new("scroll-margin-bottom", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("scroll-mt-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-margin-top", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-mr-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-margin-right", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-mb-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-margin-bottom", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-ml-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-margin-left", value)]);
    }

    // Scroll padding
    if let Some(val) = utility.strip_prefix("scroll-p-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-padding", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-px-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("scroll-padding-left", value),
            CssProperty::new("scroll-padding-right", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("scroll-py-") {
        let value = spacing_value(val)?;
        return Some(vec![
            CssProperty::new("scroll-padding-top", value),
            CssProperty::new("scroll-padding-bottom", value),
        ]);
    }
    if let Some(val) = utility.strip_prefix("scroll-pt-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-padding-top", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-pr-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-padding-right", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-pb-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-padding-bottom", value)]);
    }
    if let Some(val) = utility.strip_prefix("scroll-pl-") {
        let value = spacing_value(val)?;
        return Some(vec![CssProperty::new("scroll-padding-left", value)]);
    }

    // Scroll snap align
    match utility {
        "snap-start" => return Some(vec![CssProperty::new("scroll-snap-align", "start")]),
        "snap-end" => return Some(vec![CssProperty::new("scroll-snap-align", "end")]),
        "snap-center" => return Some(vec![CssProperty::new("scroll-snap-align", "center")]),
        "snap-align-none" => return Some(vec![CssProperty::new("scroll-snap-align", "none")]),
        _ => {}
    }

    // Scroll snap stop
    match utility {
        "snap-normal" => return Some(vec![CssProperty::new("scroll-snap-stop", "normal")]),
        "snap-always" => return Some(vec![CssProperty::new("scroll-snap-stop", "always")]),
        _ => {}
    }

    // Scroll snap type
    match utility {
        "snap-none" => return Some(vec![CssProperty::new("scroll-snap-type", "none")]),
        "snap-x" => {
            return Some(vec![CssProperty::new(
                "scroll-snap-type",
                "x var(--tw-scroll-snap-strictness)",
            )])
        }
        "snap-y" => {
            return Some(vec![CssProperty::new(
                "scroll-snap-type",
                "y var(--tw-scroll-snap-strictness)",
            )])
        }
        "snap-both" => {
            return Some(vec![CssProperty::new(
                "scroll-snap-type",
                "both var(--tw-scroll-snap-strictness)",
            )])
        }
        "snap-mandatory" => {
            return Some(vec![CssProperty::new(
                "--tw-scroll-snap-strictness",
                "mandatory",
            )])
        }
        "snap-proximity" => {
            return Some(vec![CssProperty::new(
                "--tw-scroll-snap-strictness",
                "proximity",
            )])
        }
        _ => {}
    }

    // Touch action
    match utility {
        "touch-auto" => return Some(vec![CssProperty::new("touch-action", "auto")]),
        "touch-none" => return Some(vec![CssProperty::new("touch-action", "none")]),
        "touch-pan-x" => return Some(vec![CssProperty::new("touch-action", "pan-x")]),
        "touch-pan-left" => return Some(vec![CssProperty::new("touch-action", "pan-left")]),
        "touch-pan-right" => return Some(vec![CssProperty::new("touch-action", "pan-right")]),
        "touch-pan-y" => return Some(vec![CssProperty::new("touch-action", "pan-y")]),
        "touch-pan-up" => return Some(vec![CssProperty::new("touch-action", "pan-up")]),
        "touch-pan-down" => return Some(vec![CssProperty::new("touch-action", "pan-down")]),
        "touch-pinch-zoom" => return Some(vec![CssProperty::new("touch-action", "pinch-zoom")]),
        "touch-manipulation" => {
            return Some(vec![CssProperty::new("touch-action", "manipulation")])
        }
        _ => {}
    }

    // Will change
    match utility {
        "will-change-auto" => return Some(vec![CssProperty::new("will-change", "auto")]),
        "will-change-scroll" => {
            return Some(vec![CssProperty::new("will-change", "scroll-position")])
        }
        "will-change-contents" => return Some(vec![CssProperty::new("will-change", "contents")]),
        "will-change-transform" => return Some(vec![CssProperty::new("will-change", "transform")]),
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
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_accent_color() {
        let props = parse("accent-blue-500").unwrap();
        assert_eq!(props[0].property, "accent-color");
        assert_eq!(props[0].value, "#3b82f6");
    }

    #[test]
    fn test_caret_color() {
        let props = parse("caret-red-500").unwrap();
        assert_eq!(props[0].property, "caret-color");
        assert_eq!(props[0].value, "#ef4444");
    }

    #[test]
    fn test_appearance_none() {
        let props = parse("appearance-none").unwrap();
        assert_eq!(props[0].property, "appearance");
        assert_eq!(props[0].value, "none");
    }

    #[test]
    fn test_resize() {
        let props = parse("resize").unwrap();
        assert_eq!(props[0].property, "resize");
        assert_eq!(props[0].value, "both");
    }

    #[test]
    fn test_scroll_smooth() {
        let props = parse("scroll-smooth").unwrap();
        assert_eq!(props[0].property, "scroll-behavior");
        assert_eq!(props[0].value, "smooth");
    }

    #[test]
    fn test_scroll_margin() {
        let props = parse("scroll-m-4").unwrap();
        assert_eq!(props[0].property, "scroll-margin");
        assert_eq!(props[0].value, "1rem");
    }

    #[test]
    fn test_snap_center() {
        let props = parse("snap-center").unwrap();
        assert_eq!(props[0].property, "scroll-snap-align");
        assert_eq!(props[0].value, "center");
    }

    #[test]
    fn test_touch_none() {
        let props = parse("touch-none").unwrap();
        assert_eq!(props[0].property, "touch-action");
        assert_eq!(props[0].value, "none");
    }

    #[test]
    fn test_will_change() {
        let props = parse("will-change-transform").unwrap();
        assert_eq!(props[0].property, "will-change");
        assert_eq!(props[0].value, "transform");
    }
}
