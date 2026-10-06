//! Color utilities: text, background, border colors

use crate::parser::CssProperty;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Tailwind color palette
pub static COLORS: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();

    // Basic colors
    m.insert("transparent", "transparent");
    m.insert("current", "currentColor");
    m.insert("black", "#000000");
    m.insert("white", "#ffffff");

    // Slate
    m.insert("slate-50", "#f8fafc");
    m.insert("slate-100", "#f1f5f9");
    m.insert("slate-200", "#e2e8f0");
    m.insert("slate-300", "#cbd5e1");
    m.insert("slate-400", "#94a3b8");
    m.insert("slate-500", "#64748b");
    m.insert("slate-600", "#475569");
    m.insert("slate-700", "#334155");
    m.insert("slate-800", "#1e293b");
    m.insert("slate-900", "#0f172a");
    m.insert("slate-950", "#020617");

    // Gray
    m.insert("gray-50", "#f9fafb");
    m.insert("gray-100", "#f3f4f6");
    m.insert("gray-200", "#e5e7eb");
    m.insert("gray-300", "#d1d5db");
    m.insert("gray-400", "#9ca3af");
    m.insert("gray-500", "#6b7280");
    m.insert("gray-600", "#4b5563");
    m.insert("gray-700", "#374151");
    m.insert("gray-800", "#1f2937");
    m.insert("gray-900", "#111827");
    m.insert("gray-950", "#030712");

    // Zinc
    m.insert("zinc-50", "#fafafa");
    m.insert("zinc-100", "#f4f4f5");
    m.insert("zinc-200", "#e4e4e7");
    m.insert("zinc-300", "#d4d4d8");
    m.insert("zinc-400", "#a1a1aa");
    m.insert("zinc-500", "#71717a");
    m.insert("zinc-600", "#52525b");
    m.insert("zinc-700", "#3f3f46");
    m.insert("zinc-800", "#27272a");
    m.insert("zinc-900", "#18181b");
    m.insert("zinc-950", "#09090b");

    // Red
    m.insert("red-50", "#fef2f2");
    m.insert("red-100", "#fee2e2");
    m.insert("red-200", "#fecaca");
    m.insert("red-300", "#fca5a5");
    m.insert("red-400", "#f87171");
    m.insert("red-500", "#ef4444");
    m.insert("red-600", "#dc2626");
    m.insert("red-700", "#b91c1c");
    m.insert("red-800", "#991b1b");
    m.insert("red-900", "#7f1d1d");
    m.insert("red-950", "#450a0a");

    // Orange
    m.insert("orange-50", "#fff7ed");
    m.insert("orange-100", "#ffedd5");
    m.insert("orange-200", "#fed7aa");
    m.insert("orange-300", "#fdba74");
    m.insert("orange-400", "#fb923c");
    m.insert("orange-500", "#f97316");
    m.insert("orange-600", "#ea580c");
    m.insert("orange-700", "#c2410c");
    m.insert("orange-800", "#9a3412");
    m.insert("orange-900", "#7c2d12");
    m.insert("orange-950", "#431407");

    // Yellow
    m.insert("yellow-50", "#fefce8");
    m.insert("yellow-100", "#fef9c3");
    m.insert("yellow-200", "#fef08a");
    m.insert("yellow-300", "#fde047");
    m.insert("yellow-400", "#facc15");
    m.insert("yellow-500", "#eab308");
    m.insert("yellow-600", "#ca8a04");
    m.insert("yellow-700", "#a16207");
    m.insert("yellow-800", "#854d0e");
    m.insert("yellow-900", "#713f12");
    m.insert("yellow-950", "#422006");

    // Green
    m.insert("green-50", "#f0fdf4");
    m.insert("green-100", "#dcfce7");
    m.insert("green-200", "#bbf7d0");
    m.insert("green-300", "#86efac");
    m.insert("green-400", "#4ade80");
    m.insert("green-500", "#22c55e");
    m.insert("green-600", "#16a34a");
    m.insert("green-700", "#15803d");
    m.insert("green-800", "#166534");
    m.insert("green-900", "#14532d");
    m.insert("green-950", "#052e16");

    // Blue
    m.insert("blue-50", "#eff6ff");
    m.insert("blue-100", "#dbeafe");
    m.insert("blue-200", "#bfdbfe");
    m.insert("blue-300", "#93c5fd");
    m.insert("blue-400", "#60a5fa");
    m.insert("blue-500", "#3b82f6");
    m.insert("blue-600", "#2563eb");
    m.insert("blue-700", "#1d4ed8");
    m.insert("blue-800", "#1e40af");
    m.insert("blue-900", "#1e3a8a");
    m.insert("blue-950", "#172554");

    // Indigo
    m.insert("indigo-50", "#eef2ff");
    m.insert("indigo-100", "#e0e7ff");
    m.insert("indigo-200", "#c7d2fe");
    m.insert("indigo-300", "#a5b4fc");
    m.insert("indigo-400", "#818cf8");
    m.insert("indigo-500", "#6366f1");
    m.insert("indigo-600", "#4f46e5");
    m.insert("indigo-700", "#4338ca");
    m.insert("indigo-800", "#3730a3");
    m.insert("indigo-900", "#312e81");
    m.insert("indigo-950", "#1e1b4b");

    // Purple
    m.insert("purple-50", "#faf5ff");
    m.insert("purple-100", "#f3e8ff");
    m.insert("purple-200", "#e9d5ff");
    m.insert("purple-300", "#d8b4fe");
    m.insert("purple-400", "#c084fc");
    m.insert("purple-500", "#a855f7");
    m.insert("purple-600", "#9333ea");
    m.insert("purple-700", "#7e22ce");
    m.insert("purple-800", "#6b21a8");
    m.insert("purple-900", "#581c87");
    m.insert("purple-950", "#3b0764");

    // Pink
    m.insert("pink-50", "#fdf2f8");
    m.insert("pink-100", "#fce7f3");
    m.insert("pink-200", "#fbcfe8");
    m.insert("pink-300", "#f9a8d4");
    m.insert("pink-400", "#f472b6");
    m.insert("pink-500", "#ec4899");
    m.insert("pink-600", "#db2777");
    m.insert("pink-700", "#be185d");
    m.insert("pink-800", "#9d174d");
    m.insert("pink-900", "#831843");
    m.insert("pink-950", "#500724");

    // Rose
    m.insert("rose-50", "#fff1f2");
    m.insert("rose-100", "#ffe4e6");
    m.insert("rose-200", "#fecdd3");
    m.insert("rose-300", "#fda4af");
    m.insert("rose-400", "#fb7185");
    m.insert("rose-500", "#f43f5e");
    m.insert("rose-600", "#e11d48");
    m.insert("rose-700", "#be123c");
    m.insert("rose-800", "#9f1239");
    m.insert("rose-900", "#881337");
    m.insert("rose-950", "#4c0519");

    // Amber
    m.insert("amber-50", "#fffbeb");
    m.insert("amber-100", "#fef3c7");
    m.insert("amber-200", "#fde68a");
    m.insert("amber-300", "#fcd34d");
    m.insert("amber-400", "#fbbf24");
    m.insert("amber-500", "#f59e0b");
    m.insert("amber-600", "#d97706");
    m.insert("amber-700", "#b45309");
    m.insert("amber-800", "#92400e");
    m.insert("amber-900", "#78350f");
    m.insert("amber-950", "#451a03");

    // Lime
    m.insert("lime-50", "#f7fee7");
    m.insert("lime-100", "#ecfccb");
    m.insert("lime-200", "#d9f99d");
    m.insert("lime-300", "#bef264");
    m.insert("lime-400", "#a3e635");
    m.insert("lime-500", "#84cc16");
    m.insert("lime-600", "#65a30d");
    m.insert("lime-700", "#4d7c0f");
    m.insert("lime-800", "#3f6212");
    m.insert("lime-900", "#365314");
    m.insert("lime-950", "#1a2e05");

    // Emerald
    m.insert("emerald-50", "#ecfdf5");
    m.insert("emerald-100", "#d1fae5");
    m.insert("emerald-200", "#a7f3d0");
    m.insert("emerald-300", "#6ee7b7");
    m.insert("emerald-400", "#34d399");
    m.insert("emerald-500", "#10b981");
    m.insert("emerald-600", "#059669");
    m.insert("emerald-700", "#047857");
    m.insert("emerald-800", "#065f46");
    m.insert("emerald-900", "#064e3b");
    m.insert("emerald-950", "#022c22");

    // Teal
    m.insert("teal-50", "#f0fdfa");
    m.insert("teal-100", "#ccfbf1");
    m.insert("teal-200", "#99f6e4");
    m.insert("teal-300", "#5eead4");
    m.insert("teal-400", "#2dd4bf");
    m.insert("teal-500", "#14b8a6");
    m.insert("teal-600", "#0d9488");
    m.insert("teal-700", "#0f766e");
    m.insert("teal-800", "#115e59");
    m.insert("teal-900", "#134e4a");
    m.insert("teal-950", "#042f2e");

    // Cyan
    m.insert("cyan-50", "#ecfeff");
    m.insert("cyan-100", "#cffafe");
    m.insert("cyan-200", "#a5f3fc");
    m.insert("cyan-300", "#67e8f9");
    m.insert("cyan-400", "#22d3ee");
    m.insert("cyan-500", "#06b6d4");
    m.insert("cyan-600", "#0891b2");
    m.insert("cyan-700", "#0e7490");
    m.insert("cyan-800", "#155e75");
    m.insert("cyan-900", "#164e63");
    m.insert("cyan-950", "#083344");

    // Sky
    m.insert("sky-50", "#f0f9ff");
    m.insert("sky-100", "#e0f2fe");
    m.insert("sky-200", "#bae6fd");
    m.insert("sky-300", "#7dd3fc");
    m.insert("sky-400", "#38bdf8");
    m.insert("sky-500", "#0ea5e9");
    m.insert("sky-600", "#0284c7");
    m.insert("sky-700", "#0369a1");
    m.insert("sky-800", "#075985");
    m.insert("sky-900", "#0c4a6e");
    m.insert("sky-950", "#082f49");

    // Violet
    m.insert("violet-50", "#f5f3ff");
    m.insert("violet-100", "#ede9fe");
    m.insert("violet-200", "#ddd6fe");
    m.insert("violet-300", "#c4b5fd");
    m.insert("violet-400", "#a78bfa");
    m.insert("violet-500", "#8b5cf6");
    m.insert("violet-600", "#7c3aed");
    m.insert("violet-700", "#6d28d9");
    m.insert("violet-800", "#5b21b6");
    m.insert("violet-900", "#4c1d95");
    m.insert("violet-950", "#2e1065");

    // Fuchsia
    m.insert("fuchsia-50", "#fdf4ff");
    m.insert("fuchsia-100", "#fae8ff");
    m.insert("fuchsia-200", "#f5d0fe");
    m.insert("fuchsia-300", "#f0abfc");
    m.insert("fuchsia-400", "#e879f9");
    m.insert("fuchsia-500", "#d946ef");
    m.insert("fuchsia-600", "#c026d3");
    m.insert("fuchsia-700", "#a21caf");
    m.insert("fuchsia-800", "#86198f");
    m.insert("fuchsia-900", "#701a75");
    m.insert("fuchsia-950", "#4a044e");

    // Stone
    m.insert("stone-50", "#fafaf9");
    m.insert("stone-100", "#f5f5f4");
    m.insert("stone-200", "#e7e5e4");
    m.insert("stone-300", "#d6d3d1");
    m.insert("stone-400", "#a8a29e");
    m.insert("stone-500", "#78716c");
    m.insert("stone-600", "#57534e");
    m.insert("stone-700", "#44403c");
    m.insert("stone-800", "#292524");
    m.insert("stone-900", "#1c1917");
    m.insert("stone-950", "#0c0a09");

    // Neutral
    m.insert("neutral-50", "#fafafa");
    m.insert("neutral-100", "#f5f5f5");
    m.insert("neutral-200", "#e5e5e5");
    m.insert("neutral-300", "#d4d4d4");
    m.insert("neutral-400", "#a3a3a3");
    m.insert("neutral-500", "#737373");
    m.insert("neutral-600", "#525252");
    m.insert("neutral-700", "#404040");
    m.insert("neutral-800", "#262626");
    m.insert("neutral-900", "#171717");
    m.insert("neutral-950", "#0a0a0a");

    m
});

fn get_color(name: &str) -> Option<&'static str> {
    COLORS.get(name).copied().or_else(|| {
        // Bare color names (e.g. "red", "blue") default to the -500 shade,
        // matching Tailwind CSS behavior.
        let with_shade = format!("{}-500", name);
        COLORS.get(with_shade.as_str()).copied()
    })
}

/// Parse an opacity modifier: `50` (percent), `[0.35]` (raw alpha), `[55%]`.
/// Returns alpha in 0.0..=1.0.
pub(crate) fn parse_alpha_modifier(modifier: &str) -> Option<f64> {
    let inner = modifier
        .strip_prefix('[')
        .and_then(|m| m.strip_suffix(']'))
        .unwrap_or(modifier);
    if let Some(pct) = inner.strip_suffix('%') {
        let value: f64 = pct.parse().ok()?;
        return (0.0..=100.0).contains(&value).then_some(value / 100.0);
    }
    if let Ok(percent) = inner.parse::<u32>() {
        return (percent <= 100).then_some(percent as f64 / 100.0);
    }
    let alpha: f64 = inner.parse().ok()?;
    (0.0..=1.0).contains(&alpha).then_some(alpha)
}

/// Apply an alpha channel to a color. Hex colors (#rgb / #rrggbb) become
/// rgba(); other formats are returned unchanged since they can't be blended
/// without full CSS color parsing.
pub(crate) fn apply_alpha(color: &str, alpha: f64) -> String {
    let Some(hex) = color.strip_prefix('#') else {
        return color.to_string();
    };
    let rgb = match hex.len() {
        3 => {
            let digit = |i: usize| u8::from_str_radix(&hex[i..i + 1], 16).map(|d| d * 17);
            digit(0).and_then(|r| digit(1).and_then(|g| digit(2).map(|b| (r, g, b))))
        }
        6 => u8::from_str_radix(&hex[0..2], 16).and_then(|r| {
            u8::from_str_radix(&hex[2..4], 16)
                .and_then(|g| u8::from_str_radix(&hex[4..6], 16).map(|b| (r, g, b)))
        }),
        _ => return color.to_string(),
    };
    match rgb {
        Ok((r, g, b)) => format!("rgba({}, {}, {}, {})", r, g, b, alpha),
        Err(_) => color.to_string(),
    }
}

/// Parse a color name that may include an opacity modifier
/// (e.g., "red-500/50", "black/[.35]").
/// Returns the resolved color string (hex or rgba with opacity applied).
fn resolve_color_with_opacity(name: &str) -> Option<String> {
    if let Some((color_name, modifier)) = name.rsplit_once('/') {
        let alpha = parse_alpha_modifier(modifier)?;
        let color = get_color(color_name)?;
        Some(apply_alpha(color, alpha))
    } else {
        get_color(name).map(|s| s.to_string())
    }
}

/// Heuristic for arbitrary values: does this look like a CSS color?
/// Used to disambiguate utilities that accept both colors and lengths,
/// e.g. `border-[#f00]` (color) vs `border-[3px]` (width),
/// `text-[#ff00ff]` (color) vs `text-[14px]` (font-size).
pub fn is_color_like(value: &str) -> bool {
    if value.starts_with('#') {
        return true;
    }
    const COLOR_FUNCTIONS: &[&str] = &[
        "rgb(", "rgba(", "hsl(", "hsla(", "hwb(", "oklch(", "oklab(", "lab(", "lch(", "color(",
    ];
    if COLOR_FUNCTIONS.iter().any(|f| value.starts_with(f)) {
        return true;
    }
    matches!(value, "transparent" | "currentColor" | "currentcolor")
}

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Text color: text-blue-500 or text-blue-500/50
    if let Some(color_name) = utility.strip_prefix("text-") {
        // Skip typography classes like text-xl
        if !color_name
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && ![
                "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl",
                "9xl",
            ]
            .contains(&color_name)
            && !["left", "center", "right", "justify", "start", "end"].contains(&color_name)
        {
            if let Some(color) = resolve_color_with_opacity(color_name) {
                return Some(vec![CssProperty::new("color", &color)]);
            }
        }
    }

    // Background color: bg-white or bg-white/50
    if let Some(color_name) = utility.strip_prefix("bg-") {
        if let Some(color) = resolve_color_with_opacity(color_name) {
            return Some(vec![CssProperty::new("background-color", &color)]);
        }
    }

    // Border color: border-gray-300 or border-gray-300/50
    if let Some(color_name) = utility.strip_prefix("border-") {
        // Skip border width classes like border-2
        if !color_name
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            if let Some(color) = resolve_color_with_opacity(color_name) {
                return Some(vec![CssProperty::new("border-color", &color)]);
            }
        }
    }

    // Opacity: opacity-50
    if let Some(val) = utility.strip_prefix("opacity-") {
        let opacity = match val {
            "0" => "0",
            "5" => "0.05",
            "10" => "0.1",
            "15" => "0.15",
            "20" => "0.2",
            "25" => "0.25",
            "30" => "0.3",
            "35" => "0.35",
            "40" => "0.4",
            "45" => "0.45",
            "50" => "0.5",
            "55" => "0.55",
            "60" => "0.6",
            "65" => "0.65",
            "70" => "0.7",
            "75" => "0.75",
            "80" => "0.8",
            "85" => "0.85",
            "90" => "0.9",
            "95" => "0.95",
            "100" => "1",
            _ => return None,
        };
        return Some(vec![CssProperty::new("opacity", opacity)]);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_color() {
        let props = parse("text-blue-500").unwrap();
        assert_eq!(props[0].property, "color");
        assert_eq!(props[0].value, "#3b82f6");
    }

    #[test]
    fn test_bg_color() {
        let props = parse("bg-white").unwrap();
        assert_eq!(props[0].property, "background-color");
        assert_eq!(props[0].value, "#ffffff");
    }

    #[test]
    fn test_border_color() {
        let props = parse("border-gray-300").unwrap();
        assert_eq!(props[0].property, "border-color");
        assert_eq!(props[0].value, "#d1d5db");
    }

    #[test]
    fn test_opacity() {
        let props = parse("opacity-50").unwrap();
        assert_eq!(props[0].property, "opacity");
        assert_eq!(props[0].value, "0.5");
    }

    #[test]
    fn test_bare_color_names_default_to_500() {
        // Bare color names should resolve to the -500 shade
        let props = parse("bg-red").unwrap();
        assert_eq!(props[0].property, "background-color");
        assert_eq!(props[0].value, "#ef4444"); // red-500

        let props = parse("bg-blue").unwrap();
        assert_eq!(props[0].value, "#3b82f6"); // blue-500

        let props = parse("text-green").unwrap();
        assert_eq!(props[0].property, "color");
        assert_eq!(props[0].value, "#22c55e"); // green-500

        let props = parse("border-purple").unwrap();
        assert_eq!(props[0].property, "border-color");
        assert_eq!(props[0].value, "#a855f7"); // purple-500
    }

    #[test]
    fn test_new_colors() {
        // Cyan
        let props = parse("text-cyan-500").unwrap();
        assert_eq!(props[0].value, "#06b6d4");

        // Teal
        let props = parse("bg-teal-600").unwrap();
        assert_eq!(props[0].value, "#0d9488");

        // Emerald
        let props = parse("border-emerald-400").unwrap();
        assert_eq!(props[0].value, "#34d399");

        // Rose
        let props = parse("text-rose-500").unwrap();
        assert_eq!(props[0].value, "#f43f5e");

        // Amber
        let props = parse("bg-amber-300").unwrap();
        assert_eq!(props[0].value, "#fcd34d");

        // Sky
        let props = parse("text-sky-500").unwrap();
        assert_eq!(props[0].value, "#0ea5e9");

        // Violet
        let props = parse("bg-violet-600").unwrap();
        assert_eq!(props[0].value, "#7c3aed");

        // Fuchsia
        let props = parse("text-fuchsia-500").unwrap();
        assert_eq!(props[0].value, "#d946ef");

        // Lime
        let props = parse("bg-lime-400").unwrap();
        assert_eq!(props[0].value, "#a3e635");

        // Stone
        let props = parse("text-stone-700").unwrap();
        assert_eq!(props[0].value, "#44403c");

        // Neutral
        let props = parse("bg-neutral-800").unwrap();
        assert_eq!(props[0].value, "#262626");
    }

    // --- resolve_color_with_opacity tests ---

    #[test]
    fn test_text_color_with_opacity() {
        let props = parse("text-red-500/50").unwrap();
        assert_eq!(props[0].property, "color");
        assert_eq!(props[0].value, "rgba(239, 68, 68, 0.5)");
    }

    #[test]
    fn test_bg_color_with_opacity() {
        let props = parse("bg-blue-500/75").unwrap();
        assert_eq!(props[0].property, "background-color");
        assert_eq!(props[0].value, "rgba(59, 130, 246, 0.75)");
    }

    #[test]
    fn test_border_color_with_opacity() {
        let props = parse("border-green-400/25").unwrap();
        assert_eq!(props[0].property, "border-color");
        assert_eq!(props[0].value, "rgba(74, 222, 128, 0.25)");
    }

    #[test]
    fn test_opacity_zero_produces_alpha_zero() {
        let props = parse("bg-red-500/0").unwrap();
        assert_eq!(props[0].value, "rgba(239, 68, 68, 0)");
    }

    #[test]
    fn test_opacity_100_produces_alpha_one() {
        let props = parse("bg-red-500/100").unwrap();
        assert_eq!(props[0].value, "rgba(239, 68, 68, 1)");
    }

    #[test]
    fn test_opacity_over_100_returns_none() {
        assert!(parse("text-red-500/101").is_none());
    }

    #[test]
    fn test_opacity_non_numeric_returns_none() {
        assert!(parse("text-red-500/xx").is_none());
    }

    #[test]
    fn test_opacity_empty_suffix_returns_none() {
        // "text-red-500/" — the opacity portion is empty, parse fails
        assert!(parse("text-red-500/").is_none());
    }

    #[test]
    fn test_resolve_color_with_opacity_direct() {
        // Valid hex color with opacity
        let r = resolve_color_with_opacity("blue-500/50").unwrap();
        assert_eq!(r, "rgba(59, 130, 246, 0.5)");

        // Without opacity — returns plain hex
        let r = resolve_color_with_opacity("blue-500").unwrap();
        assert_eq!(r, "#3b82f6");

        // Non-hex color (transparent) with opacity keeps the raw value
        let r = resolve_color_with_opacity("transparent/50").unwrap();
        assert_eq!(r, "transparent");

        // Invalid color name
        assert!(resolve_color_with_opacity("nonexistent/50").is_none());
    }
}
