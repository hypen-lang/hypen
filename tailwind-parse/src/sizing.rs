//! Sizing utilities: width, height, min/max

use crate::parser::CssProperty;

fn size_value(key: &str) -> Option<&'static str> {
    // Tailwind's full numeric size scale. Values are in `rem` (1rem = 16px by
    // default). This MUST stay in lockstep with Tailwind's spec — gaps in the
    // scale (e.g. missing `w-7`) silently drop the utility, which causes
    // images to render at their natural size and other layout bugs that are
    // hard to track down.
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
        // Fractional
        "1/2" => Some("50%"),
        "1/3" => Some("33.333333%"),
        "2/3" => Some("66.666667%"),
        "1/4" => Some("25%"),
        "2/4" => Some("50%"),
        "3/4" => Some("75%"),
        "1/5" => Some("20%"),
        "2/5" => Some("40%"),
        "3/5" => Some("60%"),
        "4/5" => Some("80%"),
        "1/6" => Some("16.666667%"),
        "5/6" => Some("83.333333%"),
        "1/12" => Some("8.333333%"),
        "full" => Some("100%"),
        "screen" => Some("100vw"),
        "svw" => Some("100svw"),
        "lvw" => Some("100lvw"),
        "dvw" => Some("100dvw"),
        "min" => Some("min-content"),
        "max" => Some("max-content"),
        "fit" => Some("fit-content"),
        "auto" => Some("auto"),
        _ => None,
    }
}

fn height_value(key: &str) -> Option<&'static str> {
    // Most values same as width, but screen is vh not vw
    match key {
        "screen" => Some("100vh"),
        "svh" => Some("100svh"),
        "lvh" => Some("100lvh"),
        "dvh" => Some("100dvh"),
        _ => size_value(key),
    }
}

fn max_width_value(key: &str) -> Option<&'static str> {
    // Tailwind's `max-w-*` accepts BOTH named sizes (xs/sm/md/lg/xl/2xl/...
    // /7xl/prose/screen-*) AND the full numeric size scale (max-w-20,
    // max-w-32, etc.). The named sizes win when they collide; otherwise we
    // fall through to `size_value` so any numeric width also works as a
    // max-width without forcing users to drop into arbitrary values.
    match key {
        "none" => Some("none"),
        "xs" => Some("20rem"),
        "sm" => Some("24rem"),
        "md" => Some("28rem"),
        "lg" => Some("32rem"),
        "xl" => Some("36rem"),
        "2xl" => Some("42rem"),
        "3xl" => Some("48rem"),
        "4xl" => Some("56rem"),
        "5xl" => Some("64rem"),
        "6xl" => Some("72rem"),
        "7xl" => Some("80rem"),
        "prose" => Some("65ch"),
        "screen-sm" => Some("640px"),
        "screen-md" => Some("768px"),
        "screen-lg" => Some("1024px"),
        "screen-xl" => Some("1280px"),
        "screen-2xl" => Some("1536px"),
        _ => size_value(key),
    }
}

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Width
    if let Some(val) = utility.strip_prefix("w-") {
        let value = size_value(val)?;
        return Some(vec![CssProperty::new("width", value)]);
    }

    // Height
    if let Some(val) = utility.strip_prefix("h-") {
        let value = height_value(val)?;
        return Some(vec![CssProperty::new("height", value)]);
    }

    // Min-width
    if let Some(val) = utility.strip_prefix("min-w-") {
        let value = size_value(val)?;
        return Some(vec![CssProperty::new("min-width", value)]);
    }

    // Min-height
    if let Some(val) = utility.strip_prefix("min-h-") {
        let value = height_value(val)?;
        return Some(vec![CssProperty::new("min-height", value)]);
    }

    // Max-width
    if let Some(val) = utility.strip_prefix("max-w-") {
        let value = max_width_value(val)?;
        return Some(vec![CssProperty::new("max-width", value)]);
    }

    // Max-height
    if let Some(val) = utility.strip_prefix("max-h-") {
        let value = height_value(val)?;
        return Some(vec![CssProperty::new("max-height", value)]);
    }

    // Size (width and height)
    if let Some(val) = utility.strip_prefix("size-") {
        let value = size_value(val)?;
        return Some(vec![
            CssProperty::new("width", value),
            CssProperty::new("height", value),
        ]);
    }

    None
}

/// Parse arbitrary sizing values like `w-[200px]`, `max-h-[50vh]`
pub fn parse_arbitrary(prefix: &str, value: &str) -> Option<Vec<CssProperty>> {
    let property = match prefix {
        "w" => "width",
        "h" => "height",
        "min-w" => "min-width",
        "min-h" => "min-height",
        "max-w" => "max-width",
        "max-h" => "max-height",
        _ => return None,
    };
    Some(vec![CssProperty::new(property, value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_width() {
        let props = parse("w-full").unwrap();
        assert_eq!(props[0].property, "width");
        assert_eq!(props[0].value, "100%");
    }

    #[test]
    fn test_height_screen() {
        let props = parse("h-screen").unwrap();
        assert_eq!(props[0].property, "height");
        assert_eq!(props[0].value, "100vh");
    }

    #[test]
    fn test_max_width() {
        let props = parse("max-w-lg").unwrap();
        assert_eq!(props[0].property, "max-width");
        assert_eq!(props[0].value, "32rem");
    }

    #[test]
    fn test_size() {
        let props = parse("size-4").unwrap();
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].property, "width");
        assert_eq!(props[1].property, "height");
    }

    /// Regression: the size scale used to skip 7, 9, 11 and the *.5 fractions,
    /// which silently dropped utilities like `w-7 h-7` and caused images to
    /// render at their natural size. This test pins the full scale so any
    /// future gap is caught immediately.
    #[test]
    fn test_full_numeric_scale_present() {
        let cases: &[(&str, &str)] = &[
            ("w-0", "0px"),
            ("w-px", "1px"),
            ("w-0.5", "0.125rem"),
            ("w-1", "0.25rem"),
            ("w-1.5", "0.375rem"),
            ("w-2", "0.5rem"),
            ("w-2.5", "0.625rem"),
            ("w-3", "0.75rem"),
            ("w-3.5", "0.875rem"),
            ("w-4", "1rem"),
            ("w-5", "1.25rem"),
            ("w-6", "1.5rem"),
            ("w-7", "1.75rem"),
            ("w-8", "2rem"),
            ("w-9", "2.25rem"),
            ("w-10", "2.5rem"),
            ("w-11", "2.75rem"),
            ("w-12", "3rem"),
        ];
        for (utility, expected) in cases {
            let props = parse(utility).unwrap_or_else(|| panic!("missing scale value: {utility}"));
            assert_eq!(props[0].property, "width");
            assert_eq!(props[0].value, *expected, "wrong value for {utility}");
        }
    }

    #[test]
    fn test_height_full_numeric_scale_present() {
        // Sample the previously-missing values to confirm h-* uses the same scale.
        for utility in ["h-7", "h-9", "h-11", "h-1.5", "h-2.5", "h-3.5"] {
            let props = parse(utility).unwrap_or_else(|| panic!("missing scale value: {utility}"));
            assert_eq!(props[0].property, "height");
        }
    }

    #[test]
    fn test_size_full_numeric_scale_present() {
        // `size-N` was the original failure case (used in social BottomNav avatar).
        for n in ["7", "9", "11"] {
            let props = parse(&format!("size-{n}"))
                .unwrap_or_else(|| panic!("missing size-{n}"));
            assert_eq!(props.len(), 2);
            assert_eq!(props[0].property, "width");
            assert_eq!(props[1].property, "height");
        }
    }

    /// Regression: `max_width_value` used to only accept the named scale
    /// (xs/sm/md/lg/...). The numeric scale (max-w-20, max-w-32, etc.) was
    /// silently dropped, which surfaced as "the truncate utility doesn't
    /// work" because `max-w-20` had no effect, letting long usernames wrap.
    #[test]
    fn test_max_width_numeric_scale_present() {
        for n in ["4", "8", "12", "16", "20", "24", "32", "48", "64", "96"] {
            let utility = format!("max-w-{n}");
            let props = parse(&utility)
                .unwrap_or_else(|| panic!("missing numeric max-w: {utility}"));
            assert_eq!(props[0].property, "max-width");
        }
    }

    #[test]
    fn test_max_width_named_scale_still_works() {
        // Named sizes must still take priority (xs = 20rem, NOT size_value's 5rem).
        let props = parse("max-w-xs").unwrap();
        assert_eq!(props[0].value, "20rem");
        let props = parse("max-w-prose").unwrap();
        assert_eq!(props[0].value, "65ch");
    }
}
