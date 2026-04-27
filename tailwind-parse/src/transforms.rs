//! Transform utilities: translate, scale, rotate, skew, origin

use crate::parser::CssProperty;

pub fn parse(utility: &str) -> Option<Vec<CssProperty>> {
    // Translate X
    if let Some(val) = utility.strip_prefix("translate-x-") {
        let value = translate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("translateX({})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("-translate-x-") {
        let value = translate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("translateX(-{})", value),
        )]);
    }

    // Translate Y
    if let Some(val) = utility.strip_prefix("translate-y-") {
        let value = translate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("translateY({})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("-translate-y-") {
        let value = translate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("translateY(-{})", value),
        )]);
    }

    // Scale
    if let Some(val) = utility.strip_prefix("scale-x-") {
        let value = scale_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("scaleX({})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("scale-y-") {
        let value = scale_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("scaleY({})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("scale-") {
        let value = scale_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("scale({})", value),
        )]);
    }

    // Rotate
    if let Some(val) = utility.strip_prefix("-rotate-") {
        let value = rotate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("rotate(-{})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("rotate-") {
        let value = rotate_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("rotate({})", value),
        )]);
    }

    // Skew X
    if let Some(val) = utility.strip_prefix("-skew-x-") {
        let value = skew_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("skewX(-{})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("skew-x-") {
        let value = skew_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("skewX({})", value),
        )]);
    }

    // Skew Y
    if let Some(val) = utility.strip_prefix("-skew-y-") {
        let value = skew_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("skewY(-{})", value),
        )]);
    }
    if let Some(val) = utility.strip_prefix("skew-y-") {
        let value = skew_value(val)?;
        return Some(vec![CssProperty::new(
            "transform",
            &format!("skewY({})", value),
        )]);
    }

    // Transform origin
    if let Some(val) = utility.strip_prefix("origin-") {
        let value = match val {
            "center" => "center",
            "top" => "top",
            "top-right" => "top right",
            "right" => "right",
            "bottom-right" => "bottom right",
            "bottom" => "bottom",
            "bottom-left" => "bottom left",
            "left" => "left",
            "top-left" => "top left",
            _ => return None,
        };
        return Some(vec![CssProperty::new("transform-origin", value)]);
    }

    // Backface visibility
    match utility {
        "backface-visible" => {
            return Some(vec![CssProperty::new("backface-visibility", "visible")])
        }
        "backface-hidden" => return Some(vec![CssProperty::new("backface-visibility", "hidden")]),
        _ => {}
    }

    // Perspective
    if let Some(val) = utility.strip_prefix("perspective-") {
        let value = match val {
            "none" => "none",
            "50" => "50px",
            "75" => "75px",
            "100" => "100px",
            "150" => "150px",
            "200" => "200px",
            "250" => "250px",
            "300" => "300px",
            "350" => "350px",
            "400" => "400px",
            "500" => "500px",
            "600" => "600px",
            "700" => "700px",
            "800" => "800px",
            "900" => "900px",
            "1000" => "1000px",
            _ => return None,
        };
        return Some(vec![CssProperty::new("perspective", value)]);
    }

    // Perspective origin
    if let Some(val) = utility.strip_prefix("perspective-origin-") {
        let value = match val {
            "center" => "center",
            "top" => "top",
            "top-right" => "top right",
            "right" => "right",
            "bottom-right" => "bottom right",
            "bottom" => "bottom",
            "bottom-left" => "bottom left",
            "left" => "left",
            "top-left" => "top left",
            _ => return None,
        };
        return Some(vec![CssProperty::new("perspective-origin", value)]);
    }

    // Transform style
    match utility {
        "transform-flat" => return Some(vec![CssProperty::new("transform-style", "flat")]),
        "transform-3d" => return Some(vec![CssProperty::new("transform-style", "preserve-3d")]),
        _ => {}
    }

    // Transform (GPU acceleration)
    match utility {
        "transform-gpu" => return Some(vec![CssProperty::new("transform", "translateZ(0)")]),
        "transform-none" => return Some(vec![CssProperty::new("transform", "none")]),
        _ => {}
    }

    None
}

fn translate_value(key: &str) -> Option<&'static str> {
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
        "1/2" => Some("50%"),
        "1/3" => Some("33.333333%"),
        "2/3" => Some("66.666667%"),
        "1/4" => Some("25%"),
        "2/4" => Some("50%"),
        "3/4" => Some("75%"),
        "full" => Some("100%"),
        _ => None,
    }
}

fn scale_value(key: &str) -> Option<&'static str> {
    match key {
        "0" => Some("0"),
        "50" => Some(".5"),
        "75" => Some(".75"),
        "90" => Some(".9"),
        "95" => Some(".95"),
        "100" => Some("1"),
        "105" => Some("1.05"),
        "110" => Some("1.1"),
        "125" => Some("1.25"),
        "150" => Some("1.5"),
        _ => None,
    }
}

fn rotate_value(key: &str) -> Option<&'static str> {
    match key {
        "0" => Some("0deg"),
        "1" => Some("1deg"),
        "2" => Some("2deg"),
        "3" => Some("3deg"),
        "6" => Some("6deg"),
        "12" => Some("12deg"),
        "45" => Some("45deg"),
        "90" => Some("90deg"),
        "180" => Some("180deg"),
        _ => None,
    }
}

fn skew_value(key: &str) -> Option<&'static str> {
    match key {
        "0" => Some("0deg"),
        "1" => Some("1deg"),
        "2" => Some("2deg"),
        "3" => Some("3deg"),
        "6" => Some("6deg"),
        "12" => Some("12deg"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_translate_x() {
        let props = parse("translate-x-4").unwrap();
        assert_eq!(props[0].property, "transform");
        assert_eq!(props[0].value, "translateX(1rem)");
    }

    #[test]
    fn test_negative_translate() {
        let props = parse("-translate-y-4").unwrap();
        assert_eq!(props[0].value, "translateY(-1rem)");
    }

    #[test]
    fn test_scale() {
        let props = parse("scale-150").unwrap();
        assert_eq!(props[0].value, "scale(1.5)");
    }

    #[test]
    fn test_rotate() {
        let props = parse("rotate-45").unwrap();
        assert_eq!(props[0].value, "rotate(45deg)");
    }

    #[test]
    fn test_origin() {
        let props = parse("origin-top-right").unwrap();
        assert_eq!(props[0].property, "transform-origin");
        assert_eq!(props[0].value, "top right");
    }
}
