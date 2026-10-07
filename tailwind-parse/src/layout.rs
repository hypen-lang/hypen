//! Layout utilities: display, flex, grid, position

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Display
    match utility {
        "block" => return Some(vec![CssProperty::new("display", "block")]),
        "inline-block" => return Some(vec![CssProperty::new("display", "inline-block")]),
        "inline" => return Some(vec![CssProperty::new("display", "inline")]),
        "flex" => return Some(vec![CssProperty::new("display", "flex")]),
        "inline-flex" => return Some(vec![CssProperty::new("display", "inline-flex")]),
        // `grid` / `inline-grid` are dropped: a grid is the `Grid` component
        // (display:grid on another element is web-only).
        "contents" => return Some(vec![CssProperty::new("display", "contents")]),
        "hidden" => return Some(vec![CssProperty::new("display", "none")]),
        _ => {}
    }

    // Flex direction
    match utility {
        "flex-row" => return Some(vec![CssProperty::new("flex-direction", "row")]),
        "flex-row-reverse" => return Some(vec![CssProperty::new("flex-direction", "row-reverse")]),
        "flex-col" => return Some(vec![CssProperty::new("flex-direction", "column")]),
        "flex-col-reverse" => {
            return Some(vec![CssProperty::new("flex-direction", "column-reverse")])
        }
        _ => {}
    }

    // Flex wrap
    match utility {
        "flex-wrap" => return Some(vec![CssProperty::new("flex-wrap", "wrap")]),
        "flex-wrap-reverse" => return Some(vec![CssProperty::new("flex-wrap", "wrap-reverse")]),
        "flex-nowrap" => return Some(vec![CssProperty::new("flex-wrap", "nowrap")]),
        _ => {}
    }

    // Flex grow/shrink
    // Note: flex-1/auto/initial/none emit "flex" (the Hypen-native weight prop)
    // instead of the CSS "flex" shorthand ("1 1 0%") which native renderers can't parse.
    // The "flex" prop maps to weight in iOS/Android layout systems.
    match utility {
        "flex-1" => return Some(vec![CssProperty::new("flex", "1")]),
        "flex-auto" => return Some(vec![CssProperty::new("flex", "1")]),
        "flex-initial" => return Some(vec![CssProperty::new("flex", "0")]),
        "flex-none" => {
            return Some(vec![
                CssProperty::new("flex", "0"),
                CssProperty::new("flex-shrink", "0"),
            ])
        }
        "grow" => return Some(vec![CssProperty::new("flex-grow", "1")]),
        "grow-0" => return Some(vec![CssProperty::new("flex-grow", "0")]),
        "shrink" => return Some(vec![CssProperty::new("flex-shrink", "1")]),
        "shrink-0" => return Some(vec![CssProperty::new("flex-shrink", "0")]),
        _ => {}
    }

    // Justify content
    // Note: We use "start"/"end" instead of "flex-start"/"flex-end"
    // for compatibility with native renderers (iOS/Android).
    if let Some(val) = utility.strip_prefix("justify-") {
        let value = match val {
            "normal" => "normal",
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "between" => "space-between",
            "around" => "space-around",
            "evenly" => "space-evenly",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("justify-content", value)]);
    }

    // Align items
    // Note: We use "start"/"end" instead of "flex-start"/"flex-end"
    // for compatibility with native renderers (iOS/Android).
    if let Some(val) = utility.strip_prefix("items-") {
        let value = match val {
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "baseline" => "baseline",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("align-items", value)]);
    }

    // Align self
    if let Some(val) = utility.strip_prefix("self-") {
        let value = match val {
            "auto" => "auto",
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "stretch" => "stretch",
            "baseline" => "baseline",
            _ => return None,
        };
        return Some(vec![CssProperty::new("align-self", value)]);
    }

    // Align content
    if let Some(val) = utility.strip_prefix("content-") {
        let value = match val {
            "normal" => "normal",
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "between" => "space-between",
            "around" => "space-around",
            "evenly" => "space-evenly",
            "baseline" => "baseline",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("align-content", value)]);
    }

    // Grid
    //
    // Only what every renderer (DOM, Canvas, iOS, Android, desktop) supports:
    // a column COUNT on the `Grid` component and a column SPAN on its items.
    // `grid-cols-N` is the `.gridColumns(N)` applicator (so `md:grid-cols-6`
    // becomes `gridColumns@md`, a responsive count); `col-span-N` is
    // `.gridColumn("span N")`. Track templates, rows, start/end lines,
    // auto-flow and auto tracks are web-only CSS and are dropped like any
    // unknown class.
    if let Some(val) = utility.strip_prefix("grid-cols-") {
        return match val.parse::<u8>() {
            Ok(n @ 1..=12) => Some(vec![CssProperty::new("grid-columns", &n.to_string())]),
            _ => None,
        };
    }
    if let Some(val) = utility.strip_prefix("col-span-") {
        return match val.parse::<u8>() {
            Ok(n @ 1..=12) => Some(vec![CssProperty::new("grid-column", &format!("span {n}"))]),
            _ => None,
        };
    }

    // Positioning (`static`/`absolute`/`relative`/…) and inset utilities are
    // rejected up-front in `parser::forbidden_utility_reason` — Hypen has no
    // CSS positioning model; overlays are `Stack { ... }` + alignment.

    // Z-index
    //
    // Tailwind ships with 0, 10, 20, 30, 40, 50 + auto, but real-world apps
    // routinely need values outside that band (z-1 for "above the default
    // stacking context", z-100 for modals, etc.). Accept any integer so
    // utilities like `z-1`, `z-5`, `z-99`, `z-9999`, `z--1` all work without
    // forcing users to drop into arbitrary values.
    if let Some(val) = utility.strip_prefix("z-") {
        if val == "auto" {
            return Some(vec![CssProperty::new("z-index", "auto")]);
        }
        // Validate as integer (positive or negative) so we don't accept garbage.
        let trimmed = val.strip_prefix('-').unwrap_or(val);
        if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
            return Some(vec![CssProperty::new("z-index", val)]);
        }
        return None;
    }

    // Overflow
    if let Some(val) = utility.strip_prefix("overflow-") {
        let value = match val {
            "auto" => "auto",
            "hidden" => "hidden",
            "clip" => "clip",
            "visible" => "visible",
            "scroll" => "scroll",
            "x-auto" => return Some(vec![CssProperty::new("overflow-x", "auto")]),
            "y-auto" => return Some(vec![CssProperty::new("overflow-y", "auto")]),
            "x-hidden" => return Some(vec![CssProperty::new("overflow-x", "hidden")]),
            "y-hidden" => return Some(vec![CssProperty::new("overflow-y", "hidden")]),
            "x-scroll" => return Some(vec![CssProperty::new("overflow-x", "scroll")]),
            "y-scroll" => return Some(vec![CssProperty::new("overflow-y", "scroll")]),
            "x-clip" => return Some(vec![CssProperty::new("overflow-x", "clip")]),
            "y-clip" => return Some(vec![CssProperty::new("overflow-y", "clip")]),
            "x-visible" => return Some(vec![CssProperty::new("overflow-x", "visible")]),
            "y-visible" => return Some(vec![CssProperty::new("overflow-y", "visible")]),
            _ => return None,
        };
        return Some(vec![CssProperty::new("overflow", value)]);
    }

    // Overscroll behavior
    if let Some(val) = utility.strip_prefix("overscroll-") {
        match val {
            "auto" => return Some(vec![CssProperty::new("overscroll-behavior", "auto")]),
            "contain" => return Some(vec![CssProperty::new("overscroll-behavior", "contain")]),
            "none" => return Some(vec![CssProperty::new("overscroll-behavior", "none")]),
            "y-auto" => return Some(vec![CssProperty::new("overscroll-behavior-y", "auto")]),
            "y-contain" => return Some(vec![CssProperty::new("overscroll-behavior-y", "contain")]),
            "y-none" => return Some(vec![CssProperty::new("overscroll-behavior-y", "none")]),
            "x-auto" => return Some(vec![CssProperty::new("overscroll-behavior-x", "auto")]),
            "x-contain" => return Some(vec![CssProperty::new("overscroll-behavior-x", "contain")]),
            "x-none" => return Some(vec![CssProperty::new("overscroll-behavior-x", "none")]),
            _ => return None,
        };
    }

    // Columns
    if let Some(val) = utility.strip_prefix("columns-") {
        let value = match val {
            "1" => "1",
            "2" => "2",
            "3" => "3",
            "4" => "4",
            "5" => "5",
            "6" => "6",
            "7" => "7",
            "8" => "8",
            "9" => "9",
            "10" => "10",
            "11" => "11",
            "12" => "12",
            "auto" => "auto",
            "3xs" => "16rem",
            "2xs" => "18rem",
            "xs" => "20rem",
            "sm" => "24rem",
            "md" => "28rem",
            "lg" => "32rem",
            "xl" => "36rem",
            "2xl" => "42rem",
            "3xl" => "48rem",
            "4xl" => "56rem",
            "5xl" => "64rem",
            "6xl" => "72rem",
            "7xl" => "80rem",
            _ => return None,
        };
        return Some(vec![CssProperty::new("columns", value)]);
    }

    // Break after
    if let Some(val) = utility.strip_prefix("break-after-") {
        let value = match val {
            "auto" => "auto",
            "avoid" => "avoid",
            "all" => "all",
            "avoid-page" => "avoid-page",
            "page" => "page",
            "left" => "left",
            "right" => "right",
            "column" => "column",
            _ => return None,
        };
        return Some(vec![CssProperty::new("break-after", value)]);
    }

    // Break before
    if let Some(val) = utility.strip_prefix("break-before-") {
        let value = match val {
            "auto" => "auto",
            "avoid" => "avoid",
            "all" => "all",
            "avoid-page" => "avoid-page",
            "page" => "page",
            "left" => "left",
            "right" => "right",
            "column" => "column",
            _ => return None,
        };
        return Some(vec![CssProperty::new("break-before", value)]);
    }

    // Break inside
    if let Some(val) = utility.strip_prefix("break-inside-") {
        let value = match val {
            "auto" => "auto",
            "avoid" => "avoid",
            "avoid-page" => "avoid-page",
            "avoid-column" => "avoid-column",
            _ => return None,
        };
        return Some(vec![CssProperty::new("break-inside", value)]);
    }

    // Box decoration break
    match utility {
        "box-decoration-clone" => {
            return Some(vec![CssProperty::new("box-decoration-break", "clone")])
        }
        "box-decoration-slice" => {
            return Some(vec![CssProperty::new("box-decoration-break", "slice")])
        }
        _ => {}
    }

    // Isolation
    match utility {
        "isolate" => return Some(vec![CssProperty::new("isolation", "isolate")]),
        "isolation-auto" => return Some(vec![CssProperty::new("isolation", "auto")]),
        _ => {}
    }

    // Flex basis
    if let Some(val) = utility.strip_prefix("basis-") {
        let value = match val {
            "0" => "0px",
            "1" => "0.25rem",
            "2" => "0.5rem",
            "3" => "0.75rem",
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
            "auto" => "auto",
            "px" => "1px",
            "0.5" => "0.125rem",
            "1.5" => "0.375rem",
            "2.5" => "0.625rem",
            "3.5" => "0.875rem",
            "1/2" => "50%",
            "1/3" => "33.333333%",
            "2/3" => "66.666667%",
            "1/4" => "25%",
            "2/4" => "50%",
            "3/4" => "75%",
            "1/5" => "20%",
            "2/5" => "40%",
            "3/5" => "60%",
            "4/5" => "80%",
            "1/6" => "16.666667%",
            "5/6" => "83.333333%",
            "1/12" => "8.333333%",
            "full" => "100%",
            _ => return None,
        };
        return Some(vec![CssProperty::new("flex-basis", value)]);
    }

    // Order
    if let Some(val) = utility.strip_prefix("order-") {
        let value = match val {
            "1" => "1",
            "2" => "2",
            "3" => "3",
            "4" => "4",
            "5" => "5",
            "6" => "6",
            "7" => "7",
            "8" => "8",
            "9" => "9",
            "10" => "10",
            "11" => "11",
            "12" => "12",
            "first" => "-9999",
            "last" => "9999",
            "none" => "0",
            _ => return None,
        };
        return Some(vec![CssProperty::new("order", value)]);
    }

    // Place content
    if let Some(val) = utility.strip_prefix("place-content-") {
        let value = match val {
            "center" => "center",
            "start" => "start",
            "end" => "end",
            "between" => "space-between",
            "around" => "space-around",
            "evenly" => "space-evenly",
            "baseline" => "baseline",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("place-content", value)]);
    }

    // Place items
    if let Some(val) = utility.strip_prefix("place-items-") {
        let value = match val {
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "baseline" => "baseline",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("place-items", value)]);
    }

    // Place self
    if let Some(val) = utility.strip_prefix("place-self-") {
        let value = match val {
            "auto" => "auto",
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("place-self", value)]);
    }

    // Justify items
    if let Some(val) = utility.strip_prefix("justify-items-") {
        let value = match val {
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("justify-items", value)]);
    }

    // Justify self
    if let Some(val) = utility.strip_prefix("justify-self-") {
        let value = match val {
            "auto" => "auto",
            "start" => "start",
            "end" => "end",
            "center" => "center",
            "stretch" => "stretch",
            _ => return None,
        };
        return Some(vec![CssProperty::new("justify-self", value)]);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flex() {
        let props = parse("flex").unwrap();
        assert_eq!(props[0].property, "display");
        assert_eq!(props[0].value, "flex");
    }

    #[test]
    fn test_justify_center() {
        let props = parse("justify-center").unwrap();
        assert_eq!(props[0].property, "justify-content");
        assert_eq!(props[0].value, "center");
    }

    #[test]
    fn test_justify_between() {
        let props = parse("justify-between").unwrap();
        assert_eq!(props[0].property, "justify-content");
        assert_eq!(props[0].value, "space-between");
    }

    #[test]
    fn test_justify_start_uses_native_value() {
        let props = parse("justify-start").unwrap();
        assert_eq!(props[0].value, "start"); // not "flex-start"
    }

    #[test]
    fn test_items_center() {
        let props = parse("items-center").unwrap();
        assert_eq!(props[0].property, "align-items");
        assert_eq!(props[0].value, "center");
    }

    #[test]
    fn test_items_start_uses_native_value() {
        let props = parse("items-start").unwrap();
        assert_eq!(props[0].value, "start"); // not "flex-start"
    }

    #[test]
    fn test_flex_1_emits_native_flex() {
        let props = parse("flex-1").unwrap();
        assert_eq!(props.len(), 1);
        assert_eq!(props[0].property, "flex");
        assert_eq!(props[0].value, "1");
    }

    /// `grid-cols-N` is the cross-platform `.gridColumns(N)` count.
    #[test]
    fn test_grid_cols_is_a_column_count() {
        for n in 1..=12 {
            let props = parse(&format!("grid-cols-{n}")).unwrap();
            assert_eq!(props.len(), 1);
            assert_eq!(props[0].property, "grid-columns");
            assert_eq!(props[0].value, n.to_string());
        }
        for dropped in ["grid-cols-0", "grid-cols-13", "grid-cols-none", "grid-cols-subgrid"] {
            assert!(parse(dropped).is_none(), "{dropped} must be dropped");
        }
    }

    /// `col-span-N` is `.gridColumn("span N")` — the form iOS/Android parse.
    #[test]
    fn test_col_span_is_a_span() {
        for n in 1..=12 {
            let props = parse(&format!("col-span-{n}")).unwrap();
            assert_eq!(props[0].property, "grid-column");
            assert_eq!(props[0].value, format!("span {n}"));
        }
        assert!(parse("col-span-full").is_none());
    }

    /// Positioning is not a layout utility in Hypen — it never maps to CSS.
    /// (The hard error is raised one level up, in `parser::parse_class`.)
    #[test]
    fn test_position_and_inset_never_map() {
        for utility in ["absolute", "relative", "fixed", "sticky", "static", "top-0", "inset-0", "-left-2"] {
            assert!(parse(utility).is_none(), "{utility} must not map to CSS");
        }
    }

    /// Regression: z-index used to hardcode 0/10/20/30/40/50/auto, so any
    /// integer outside that band silently dropped (e.g. `z-1` for "above
    /// the default stacking context", `z-100` for modals). Now accepts any
    /// integer literal.
    #[test]
    fn test_z_index_arbitrary_integers() {
        for z in ["0", "1", "5", "10", "50", "99", "100", "9999"] {
            let utility = format!("z-{z}");
            let props = parse(&utility)
                .unwrap_or_else(|| panic!("z-index value silently dropped: {utility}"));
            assert_eq!(props[0].property, "z-index");
            assert_eq!(props[0].value, z, "wrong value for {utility}");
        }
    }

    #[test]
    fn test_z_index_negative() {
        let props = parse("z--1").unwrap();
        assert_eq!(props[0].property, "z-index");
        assert_eq!(props[0].value, "-1");
    }

    #[test]
    fn test_z_index_auto_still_works() {
        let props = parse("z-auto").unwrap();
        assert_eq!(props[0].property, "z-index");
        assert_eq!(props[0].value, "auto");
    }

    #[test]
    fn test_z_index_rejects_garbage() {
        assert!(parse("z-foo").is_none());
        assert!(parse("z-1.5").is_none());
        assert!(parse("z-1px").is_none());
    }

    /// Web-only grid CSS (track templates, rows, start/end lines, auto-flow,
    /// auto tracks, display:grid) is dropped: a grid is the `Grid` component
    /// with a column count, which every renderer supports.
    #[test]
    fn test_web_only_grid_utilities_are_dropped() {
        for utility in [
            "grid", "inline-grid", "grid-rows-3", "row-span-2", "row-start-1", "row-end-3",
            "col-start-2", "col-end-4", "grid-flow-row", "grid-flow-col-dense", "auto-cols-fr",
            "auto-rows-min",
        ] {
            assert!(parse(utility).is_none(), "{utility} must be dropped");
        }
    }
}
