// Animation applicator lowering — .transition/.enter/.exit/.layout/.animate → "__anim.*" props
//
// Each animation applicator lowers into ONE reserved prop carrying ONE JSON
// object (`"__anim.transition"`, `"__anim.enter"`, `"__anim.exit"`,
// `"__anim.layout"`, `"__anim.animate"`). Renderers route on a single `startsWith("__anim.")`
// check; renderers that don't understand the channel ignore the unknown prop
// and snap — graceful degradation by construction. The originals never become
// `<name>.<idx>` props (they are intercepted in `expand::process_applicators`
// before the generic applicator path).
//
// Lowered values are always `Value::Static` — bindings in animation args are
// rejected with a warning. Malformed input never hard-errors: warn + fall
// back to the channel's defaults (or drop the offending argument).

use crate::logger::LogScope;
use hypen_parser::{ApplicatorSpecification, Argument, Value as ParserValue};

/// Curve vocabulary shared by every channel.
pub const CURVES: &[&str] = &["linear", "easeIn", "easeOut", "easeInOut", "spring"];

/// Enter/exit preset vocabulary.
pub const PRESETS: &[&str] = &["fade", "slide", "scale"];

/// `.animate(<preset>)` looping-preset vocabulary (Option E). Mirrors the
/// normative `ANIMATE_PRESETS` map in `@hypen-space/core`.
pub const ANIMATE_PRESETS: &[&str] = &["pulse", "spin", "shimmer", "shake"];

/// Direction vocabulary for `.enter(from:)` / `.exit(to:)`.
pub const DIRECTIONS: &[&str] = &["top", "bottom", "leading", "trailing"];

/// The animatable-prop whitelist (Hypen prop names). Mirrors the normative
/// `ANIMATABLE_PROPS` constant in `@hypen-space/core`; a conformance fixture
/// pins the engine-side filtering so the two lists can't drift. Used to
/// filter `.transition(props: [...])` scoping — non-animatable entries are
/// warned about and dropped.
pub const ANIMATABLE_PROPS: &[&str] = &[
    "opacity",
    "translateX",
    "translateY",
    "scale",
    "rotate",
    "color",
    "backgroundColor",
    "borderColor",
    "cornerRadius",
    "padding",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "paddingHorizontal",
    "paddingVertical",
    "margin",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    "marginHorizontal",
    "marginVertical",
    "width",
    "height",
    "gap",
    "fontSize",
];

/// Reserved prop key carrying the `.exit(...)` spec. The reconciler reads it
/// off a removal root's resolved props (before any tree mutation) to decide
/// whether to flag the root `Remove` with `transition: true` — see the
/// ordering contract on `Patch::Remove`.
pub(crate) const ANIM_EXIT_PROP: &str = "__anim.exit";

/// True when the applicator name is one of the five animation applicators
/// intercepted in `process_applicators`.
pub(crate) fn is_anim_applicator(name: &str) -> bool {
    matches!(name, "transition" | "enter" | "exit" | "layout" | "animate")
}

/// Detect the legacy web-only string form `.transition("opacity 0.3s ease")`:
/// a single positional string containing whitespace. It falls through to the
/// generic applicator path (→ `transition.0`) unchanged, with a deprecation
/// warning. `.transition(easeOut)` (no whitespace) takes the new path.
pub(crate) fn is_legacy_transition_string(applicator: &ApplicatorSpecification) -> bool {
    if applicator.name != "transition" {
        return false;
    }
    match applicator.arguments.arguments.as_slice() {
        [Argument::Positioned {
            value: ParserValue::String(s),
            ..
        }] => unquote(s).contains(char::is_whitespace),
        _ => false,
    }
}

/// Lower one animation applicator into its `("__anim.<channel>", spec)` pair.
/// Returns `None` for non-animation applicator names; for
/// transition/enter/exit/layout the channel is always emitted (invalid
/// arguments degrade to the channel's defaults with a warning, never to a
/// hard error). `.animate` is the one exception: an unknown or missing
/// preset warns and omits the channel entirely — there is nothing sensible
/// to play without one.
pub(crate) fn lower_anim_applicator(
    applicator: &ApplicatorSpecification,
) -> Option<(String, serde_json::Value)> {
    let channel = applicator.name.as_str();
    if channel == "animate" {
        return lower_animate(applicator);
    }
    let (default_duration, default_curve) = match channel {
        "transition" => (200.0, "easeOut"),
        "enter" => (200.0, "easeOut"),
        "exit" => (150.0, "easeIn"),
        "layout" => (300.0, "spring"),
        _ => return None,
    };
    // enter/exit take presets positionally and a named direction
    // (`from:` on enter, `to:` on exit); transition/layout take neither.
    let direction_key = match channel {
        "enter" => Some("from"),
        "exit" => Some("to"),
        _ => None,
    };
    let has_presets = direction_key.is_some();

    let mut duration = default_duration;
    let mut curve = default_curve.to_string();
    let mut delay: Option<f64> = None;
    let mut presets: Vec<String> = Vec::new();
    let mut direction: Option<String> = None;
    let mut scoped_props: Option<Vec<String>> = None;

    for arg in &applicator.arguments.arguments {
        match arg {
            Argument::Positioned { value, .. } => match value {
                ParserValue::Number(n) => {
                    if let Some(ms) = valid_ms(channel, "duration", *n) {
                        duration = ms;
                    }
                }
                ParserValue::String(s) => {
                    let token = unquote(s);
                    if is_binding_like(&token) {
                        warn_binding(channel, &token);
                    } else if CURVES.contains(&token.as_str()) {
                        curve = token;
                    } else if has_presets && PRESETS.contains(&token.as_str()) {
                        if !presets.contains(&token) {
                            presets.push(token);
                        }
                    } else {
                        crate::log_warn!(
                            LogScope::Engine,
                            ".{}: unknown token '{}' (expected {}); ignored",
                            channel,
                            token,
                            if has_presets {
                                "a curve or preset"
                            } else {
                                "a curve"
                            }
                        );
                    }
                }
                ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
                    warn_binding(channel, r);
                }
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: unsupported positional argument {:?}; ignored",
                        channel,
                        other
                    );
                }
            },
            Argument::Named { key, value } => match key.as_str() {
                "duration" => {
                    if let Some(ms) = named_ms(channel, "duration", value) {
                        duration = ms;
                    }
                }
                "delay" => {
                    delay = named_ms(channel, "delay", value).or(delay);
                }
                "curve" => apply_named_curve(channel, value, &mut curve),
                "props" if channel == "transition" => {
                    scoped_props = lower_scoped_props(value);
                }
                k if Some(k) == direction_key => match value {
                    ParserValue::String(s) => {
                        let token = unquote(s);
                        if DIRECTIONS.contains(&token.as_str()) {
                            direction = Some(token);
                        } else {
                            crate::log_warn!(
                                LogScope::Engine,
                                ".{}: unknown direction '{}' (expected one of {}); ignored",
                                channel,
                                token,
                                DIRECTIONS.join("|")
                            );
                        }
                    }
                    other => {
                        crate::log_warn!(
                            LogScope::Engine,
                            ".{}: {} must be a direction token, got {:?}; ignored",
                            channel,
                            k,
                            other
                        );
                    }
                },
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: unknown argument '{}'; ignored",
                        channel,
                        other
                    );
                }
            },
        }
    }

    // Wire format: one JSON object per channel.
    //   enter/exit:  presets, from/to?, duration, curve, delay?
    //   transition:  duration, curve, delay?, props?
    //   layout:      duration, curve, delay?
    // (serde_json::Map here is a BTreeMap — serialized key order is
    // alphabetical; consumers and fixtures must not depend on ordering.)
    let mut spec = serde_json::Map::new();
    if has_presets {
        if presets.is_empty() {
            presets.push("fade".to_string());
        }
        spec.insert("presets".to_string(), serde_json::json!(presets));
        if let (Some(key), Some(dir)) = (direction_key, direction) {
            spec.insert(key.to_string(), serde_json::json!(dir));
        }
    }
    spec.insert("duration".to_string(), json_ms(duration));
    spec.insert("curve".to_string(), serde_json::json!(curve));
    if let Some(d) = delay {
        spec.insert("delay".to_string(), json_ms(d));
    }
    if let Some(props) = scoped_props {
        spec.insert("props".to_string(), serde_json::json!(props));
    }

    Some((
        format!("__anim.{channel}"),
        serde_json::Value::Object(spec),
    ))
}

/// Per-preset defaults for `.animate(<preset>)`: (duration ms, repeat, curve).
/// `repeat` is the wire value — the string `"loop"` or an integer count.
fn animate_preset_defaults(preset: &str) -> Option<(f64, serde_json::Value, &'static str)> {
    match preset {
        "pulse" => Some((1200.0, serde_json::json!("loop"), "easeInOut")),
        "spin" => Some((800.0, serde_json::json!("loop"), "linear")),
        "shimmer" => Some((1500.0, serde_json::json!("loop"), "linear")),
        "shake" => Some((400.0, serde_json::json!(1), "easeInOut")),
        _ => None,
    }
}

/// Lower `.animate(<preset>, ...)` into `("__anim.animate", spec)`.
///
/// The first positional token names the preset (pulse|spin|shimmer|shake) and
/// seeds the per-preset defaults; the modifiers are named-only (`duration:`,
/// `repeat:`, `curve:`, `delay:`). Unlike the other channels an unknown or
/// missing preset omits the channel entirely (with a warning) — every other
/// invalid argument degrades to the preset's defaults, never a hard error.
///
/// Wire format: `{"preset", "duration", "repeat", "curve"}` + `"delay"` only
/// when given; `repeat` is `"loop"` or a positive integer.
fn lower_animate(applicator: &ApplicatorSpecification) -> Option<(String, serde_json::Value)> {
    let channel = "animate";

    let mut positionals = applicator
        .arguments
        .arguments
        .iter()
        .filter_map(|arg| match arg {
            Argument::Positioned { value, .. } => Some(value),
            Argument::Named { .. } => None,
        });
    let preset = match positionals.next() {
        Some(ParserValue::String(s)) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, &token);
                return None;
            }
            if !ANIMATE_PRESETS.contains(&token.as_str()) {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown preset '{}' (expected one of {}); animation omitted",
                    channel,
                    token,
                    ANIMATE_PRESETS.join("|")
                );
                return None;
            }
            token
        }
        Some(ParserValue::Reference(r)) | Some(ParserValue::DataSourceReference(r)) => {
            warn_binding(channel, r);
            return None;
        }
        Some(other) => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: preset must be a token (one of {}), got {:?}; animation omitted",
                channel,
                ANIMATE_PRESETS.join("|"),
                other
            );
            return None;
        }
        None => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: missing preset (expected one of {}); animation omitted",
                channel,
                ANIMATE_PRESETS.join("|")
            );
            return None;
        }
    };
    for extra in positionals {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: unsupported positional argument {:?}; ignored (modifiers are named: duration/repeat/curve/delay)",
            channel,
            extra
        );
    }

    let (default_duration, default_repeat, default_curve) =
        animate_preset_defaults(&preset).expect("preset validated against ANIMATE_PRESETS");

    let mut duration = default_duration;
    let mut repeat = default_repeat;
    let mut curve = default_curve.to_string();
    let mut delay: Option<f64> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "duration" => {
                if let Some(ms) = named_ms(channel, "duration", value) {
                    duration = ms;
                }
            }
            "delay" => {
                delay = named_ms(channel, "delay", value).or(delay);
            }
            "curve" => apply_named_curve(channel, value, &mut curve),
            "repeat" => {
                if let Some(r) = lower_repeat(channel, value) {
                    repeat = r;
                }
            }
            other => {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown argument '{}'; ignored",
                    channel,
                    other
                );
            }
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("preset".to_string(), serde_json::json!(preset));
    spec.insert("duration".to_string(), json_ms(duration));
    spec.insert("repeat".to_string(), repeat);
    spec.insert("curve".to_string(), serde_json::json!(curve));
    if let Some(d) = delay {
        spec.insert("delay".to_string(), json_ms(d));
    }

    Some((
        format!("__anim.{channel}"),
        serde_json::Value::Object(spec),
    ))
}

/// Parse a `repeat:` argument — the token `loop` or a positive integer count.
/// Invalid values warn and return `None` (keep the preset default).
fn lower_repeat(channel: &str, value: &ParserValue) -> Option<serde_json::Value> {
    match value {
        ParserValue::String(s) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, &token);
                None
            } else if token == "loop" {
                Some(serde_json::json!("loop"))
            } else {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown repeat '{}' (expected 'loop' or a positive integer); using preset default",
                    channel,
                    token
                );
                None
            }
        }
        ParserValue::Number(n) => {
            if n.is_finite() && *n >= 1.0 && n.fract() == 0.0 {
                Some(serde_json::Value::from(*n as u64))
            } else {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: repeat must be 'loop' or a positive integer, got {}; using preset default",
                    channel,
                    n
                );
                None
            }
        }
        ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
            warn_binding(channel, r);
            None
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: repeat must be 'loop' or a positive integer, got {:?}; using preset default",
                channel,
                other
            );
            None
        }
    }
}

/// Apply a named `curve:` argument in place. Unknown curves and bindings
/// warn and leave the current (default) curve untouched.
fn apply_named_curve(channel: &str, value: &ParserValue, curve: &mut String) {
    match value {
        ParserValue::String(s) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, &token);
            } else if CURVES.contains(&token.as_str()) {
                *curve = token;
            } else {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown curve '{}' (expected one of {}); using '{}'",
                    channel,
                    token,
                    CURVES.join("|"),
                    curve
                );
            }
        }
        ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
            warn_binding(channel, r);
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: curve must be a token, got {:?}; using '{}'",
                channel,
                other,
                curve
            );
        }
    }
}

/// Filter a `.transition(props: [...])` list against [`ANIMATABLE_PROPS`].
/// Non-animatable / non-string entries are warned about and dropped; an
/// empty (or fully dropped) list omits the key, i.e. all animatable props.
fn lower_scoped_props(value: &ParserValue) -> Option<Vec<String>> {
    let ParserValue::List(items) = value else {
        crate::log_warn!(
            LogScope::Engine,
            ".transition: props must be a list of prop names, got {:?}; ignored",
            value
        );
        return None;
    };
    let mut kept = Vec::new();
    for item in items {
        match item {
            ParserValue::String(s) => {
                let name = unquote(s);
                if ANIMATABLE_PROPS.contains(&name.as_str()) {
                    kept.push(name);
                } else {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".transition: '{}' is not an animatable prop; dropped",
                        name
                    );
                }
            }
            other => {
                crate::log_warn!(
                    LogScope::Engine,
                    ".transition: props entries must be prop names, got {:?}; dropped",
                    other
                );
            }
        }
    }
    if kept.is_empty() {
        crate::log_warn!(
            LogScope::Engine,
            ".transition: props list left no animatable props; animating all"
        );
        return None;
    }
    Some(kept)
}

fn named_ms(channel: &str, field: &str, value: &ParserValue) -> Option<f64> {
    match value {
        ParserValue::Number(n) => valid_ms(channel, field, *n),
        ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
            warn_binding(channel, r);
            None
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: {} must be a number (ms), got {:?}; ignored",
                channel,
                field,
                other
            );
            None
        }
    }
}

fn valid_ms(channel: &str, field: &str, n: f64) -> Option<f64> {
    if n.is_finite() && n >= 0.0 {
        Some(n)
    } else {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: {} must be a non-negative number (ms), got {}; ignored",
            channel,
            field,
            n
        );
        None
    }
}

/// Whole-number millisecond values serialize as JSON integers (`200`, not
/// `200.0`) — the wire format conformance fixtures depend on it.
fn json_ms(n: f64) -> serde_json::Value {
    if n.fract() == 0.0 && n <= u64::MAX as f64 {
        serde_json::Value::from(n as u64)
    } else {
        serde_json::json!(n)
    }
}

fn is_binding_like(token: &str) -> bool {
    token.contains("@{") || token.starts_with('@')
}

fn warn_binding(channel: &str, what: &str) {
    crate::log_warn!(
        LogScope::Engine,
        ".{}: bindings are not supported in animation arguments ('{}'); ignored",
        channel,
        what
    );
}

/// Trim surrounding `"` or `'` from a parser string token.
fn unquote(s: &str) -> String {
    s.trim_matches(|c: char| c == '"' || c == '\'').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_parser::ArgumentList;
    use serde_json::json;

    fn applicator(name: &str, args: Vec<Argument>) -> ApplicatorSpecification {
        ApplicatorSpecification {
            name: name.to_string(),
            arguments: ArgumentList::new(args),
            children: vec![],
            internal_id: "test".to_string(),
        }
    }

    fn positional(value: ParserValue) -> Argument {
        Argument::Positioned { position: 0, value }
    }

    fn named(key: &str, value: ParserValue) -> Argument {
        Argument::Named {
            key: key.to_string(),
            value,
        }
    }

    fn lower(name: &str, args: Vec<Argument>) -> (String, serde_json::Value) {
        lower_anim_applicator(&applicator(name, args)).expect("anim applicator should lower")
    }

    #[test]
    fn transition_positional_number_and_curve() {
        let (key, spec) = lower(
            "transition",
            vec![
                positional(ParserValue::Number(200.0)),
                positional(ParserValue::String("easeOut".to_string())),
            ],
        );
        assert_eq!(key, "__anim.transition");
        assert_eq!(spec, json!({"duration": 200, "curve": "easeOut"}));
    }

    #[test]
    fn transition_defaults() {
        let (_, spec) = lower("transition", vec![]);
        assert_eq!(spec, json!({"duration": 200, "curve": "easeOut"}));
    }

    #[test]
    fn transition_named_full_form() {
        let (_, spec) = lower(
            "transition",
            vec![
                named("duration", ParserValue::Number(300.0)),
                named("curve", ParserValue::String("spring".to_string())),
                named("delay", ParserValue::Number(50.0)),
                named(
                    "props",
                    ParserValue::List(vec![
                        ParserValue::String("opacity".to_string()),
                        ParserValue::String("translateY".to_string()),
                    ]),
                ),
            ],
        );
        assert_eq!(
            spec,
            json!({
                "duration": 300,
                "curve": "spring",
                "delay": 50,
                "props": ["opacity", "translateY"]
            })
        );
    }

    #[test]
    fn transition_props_whitelist_filters_non_animatable() {
        let (_, spec) = lower(
            "transition",
            vec![named(
                "props",
                ParserValue::List(vec![
                    ParserValue::String("opacity".to_string()),
                    ParserValue::String("tw".to_string()),
                    ParserValue::String("display".to_string()),
                ]),
            )],
        );
        assert_eq!(spec["props"], json!(["opacity"]));
    }

    #[test]
    fn transition_props_all_filtered_omits_key() {
        let (_, spec) = lower(
            "transition",
            vec![named(
                "props",
                ParserValue::List(vec![ParserValue::String("display".to_string())]),
            )],
        );
        assert!(spec.get("props").is_none());
    }

    #[test]
    fn transition_unknown_token_falls_back_to_default_curve() {
        let (_, spec) = lower(
            "transition",
            vec![positional(ParserValue::String("wobble".to_string()))],
        );
        assert_eq!(spec, json!({"duration": 200, "curve": "easeOut"}));
    }

    #[test]
    fn transition_binding_args_ignored() {
        let (_, spec) = lower(
            "transition",
            vec![
                named("duration", ParserValue::Reference("state.dur".to_string())),
                positional(ParserValue::String("@{state.curve}".to_string())),
            ],
        );
        assert_eq!(spec, json!({"duration": 200, "curve": "easeOut"}));
    }

    #[test]
    fn transition_negative_duration_ignored() {
        let (_, spec) = lower(
            "transition",
            vec![named("duration", ParserValue::Number(-5.0))],
        );
        assert_eq!(spec["duration"], json!(200));
    }

    #[test]
    fn enter_presets_compose_with_direction() {
        let (key, spec) = lower(
            "enter",
            vec![
                positional(ParserValue::String("slide".to_string())),
                positional(ParserValue::String("fade".to_string())),
                named("from", ParserValue::String("bottom".to_string())),
            ],
        );
        assert_eq!(key, "__anim.enter");
        assert_eq!(
            spec,
            json!({
                "presets": ["slide", "fade"],
                "from": "bottom",
                "duration": 200,
                "curve": "easeOut"
            })
        );
    }

    #[test]
    fn enter_defaults_to_fade() {
        let (_, spec) = lower("enter", vec![]);
        assert_eq!(
            spec,
            json!({"presets": ["fade"], "duration": 200, "curve": "easeOut"})
        );
    }

    #[test]
    fn enter_unknown_direction_ignored() {
        let (_, spec) = lower(
            "enter",
            vec![named("from", ParserValue::String("sideways".to_string()))],
        );
        assert!(spec.get("from").is_none());
    }

    #[test]
    fn exit_defaults_and_direction() {
        let (key, spec) = lower(
            "exit",
            vec![
                positional(ParserValue::String("slide".to_string())),
                named("to", ParserValue::String("trailing".to_string())),
            ],
        );
        assert_eq!(key, "__anim.exit");
        // Pin the lowered key to the constant the reconciler's deferred-remove
        // sites read — if either side drifts, exit flagging silently dies.
        assert_eq!(key, ANIM_EXIT_PROP);
        assert_eq!(
            spec,
            json!({
                "presets": ["slide"],
                "to": "trailing",
                "duration": 150,
                "curve": "easeIn"
            })
        );
    }

    #[test]
    fn exit_duration_override() {
        let (_, spec) = lower(
            "exit",
            vec![
                positional(ParserValue::String("fade".to_string())),
                named("duration", ParserValue::Number(150.0)),
            ],
        );
        assert_eq!(
            spec,
            json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})
        );
    }

    #[test]
    fn exit_rejects_from_direction() {
        // `from:` belongs to .enter; on .exit it is an unknown argument.
        let (_, spec) = lower(
            "exit",
            vec![named("from", ParserValue::String("bottom".to_string()))],
        );
        assert!(spec.get("from").is_none());
        assert!(spec.get("to").is_none());
    }

    #[test]
    fn layout_defaults_and_curve_token() {
        let (key, spec) = lower("layout", vec![]);
        assert_eq!(key, "__anim.layout");
        assert_eq!(spec, json!({"duration": 300, "curve": "spring"}));

        let (_, spec) = lower(
            "layout",
            vec![positional(ParserValue::String("spring".to_string()))],
        );
        assert_eq!(spec, json!({"duration": 300, "curve": "spring"}));
    }

    #[test]
    fn layout_rejects_presets() {
        // Presets are enter/exit vocabulary; on .layout `fade` is unknown.
        let (_, spec) = lower(
            "layout",
            vec![positional(ParserValue::String("fade".to_string()))],
        );
        assert_eq!(spec, json!({"duration": 300, "curve": "spring"}));
    }

    #[test]
    fn fractional_duration_stays_float() {
        let (_, spec) = lower(
            "transition",
            vec![named("duration", ParserValue::Number(16.5))],
        );
        assert_eq!(spec["duration"], json!(16.5));
    }

    #[test]
    fn legacy_transition_string_detected() {
        assert!(is_legacy_transition_string(&applicator(
            "transition",
            vec![positional(ParserValue::String(
                "\"opacity 0.3s ease\"".to_string()
            ))],
        )));
        // Single token → new path.
        assert!(!is_legacy_transition_string(&applicator(
            "transition",
            vec![positional(ParserValue::String("easeOut".to_string()))],
        )));
        // Two arguments → new path even if one has whitespace.
        assert!(!is_legacy_transition_string(&applicator(
            "transition",
            vec![
                positional(ParserValue::Number(200.0)),
                positional(ParserValue::String("\"a b\"".to_string())),
            ],
        )));
        // Named string → new path.
        assert!(!is_legacy_transition_string(&applicator(
            "transition",
            vec![named("curve", ParserValue::String("\"a b\"".to_string()))],
        )));
    }

    // Both whitelists pin to the same artifact: the conformance fixture's
    // scoped-props list. `animation-core.test.ts` asserts the TS
    // ANIMATABLE_PROPS keys equal it; this test asserts the Rust list does
    // too — so the "must match exactly" mirrors can only drift by turning
    // one of the suites red.
    #[test]
    fn whitelist_matches_scoped_props_conformance_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine-compatibility-tests/fixtures/animation/transition-scoped-props.json"
        );
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture readable"))
                .expect("fixture is JSON");
        let pinned: Vec<&str> = fixture["expected"]["patches"][0]["props"]["__anim.transition"]
            ["props"]
            .as_array()
            .expect("fixture pins a props list")
            .iter()
            .map(|v| v.as_str().expect("prop names are strings"))
            .collect();
        assert_eq!(ANIMATABLE_PROPS, pinned.as_slice());
    }

    #[test]
    fn directional_shorthands_are_animatable() {
        let (_, spec) = lower(
            "transition",
            vec![named(
                "props",
                ParserValue::List(vec![
                    ParserValue::String("paddingHorizontal".to_string()),
                    ParserValue::String("marginVertical".to_string()),
                ]),
            )],
        );
        assert_eq!(spec["props"], json!(["paddingHorizontal", "marginVertical"]));
    }

    #[test]
    fn non_anim_applicator_returns_none() {
        assert!(lower_anim_applicator(&applicator("padding", vec![])).is_none());
        assert!(is_anim_applicator("enter"));
        assert!(is_anim_applicator("animate"));
        assert!(!is_anim_applicator("padding"));
    }

    // ------------------------------------------------------------------
    // .animate(<preset>) — Option E looping presets
    // ------------------------------------------------------------------

    fn preset(name: &str) -> Argument {
        positional(ParserValue::String(name.to_string()))
    }

    #[test]
    fn animate_defaults_per_preset() {
        let (key, spec) = lower("animate", vec![preset("pulse")]);
        assert_eq!(key, "__anim.animate");
        assert_eq!(
            spec,
            json!({"preset": "pulse", "duration": 1200, "repeat": "loop", "curve": "easeInOut"})
        );

        let (_, spec) = lower("animate", vec![preset("spin")]);
        assert_eq!(
            spec,
            json!({"preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear"})
        );

        let (_, spec) = lower("animate", vec![preset("shimmer")]);
        assert_eq!(
            spec,
            json!({"preset": "shimmer", "duration": 1500, "repeat": "loop", "curve": "linear"})
        );

        let (_, spec) = lower("animate", vec![preset("shake")]);
        assert_eq!(
            spec,
            json!({"preset": "shake", "duration": 400, "repeat": 1, "curve": "easeInOut"})
        );
    }

    #[test]
    fn animate_named_overrides() {
        let (_, spec) = lower(
            "animate",
            vec![
                preset("pulse"),
                named("duration", ParserValue::Number(800.0)),
                named("repeat", ParserValue::Number(3.0)),
                named("curve", ParserValue::String("linear".to_string())),
            ],
        );
        assert_eq!(
            spec,
            json!({"preset": "pulse", "duration": 800, "repeat": 3, "curve": "linear"})
        );
    }

    #[test]
    fn animate_repeat_loop_token() {
        // shake defaults to repeat: 1 — the loop token overrides it
        let (_, spec) = lower(
            "animate",
            vec![
                preset("shake"),
                named("repeat", ParserValue::String("loop".to_string())),
            ],
        );
        assert_eq!(spec["repeat"], json!("loop"));
    }

    #[test]
    fn animate_repeat_invalid_falls_back_to_preset_default() {
        // zero, fractional, and unknown-token repeats all keep the default
        for bad in [
            named("repeat", ParserValue::Number(0.0)),
            named("repeat", ParserValue::Number(2.5)),
            named("repeat", ParserValue::Number(-1.0)),
            named("repeat", ParserValue::String("forever".to_string())),
        ] {
            let (_, spec) = lower("animate", vec![preset("spin"), bad]);
            assert_eq!(spec["repeat"], json!("loop"));
        }
    }

    #[test]
    fn animate_unknown_preset_omits_channel() {
        assert!(lower_anim_applicator(&applicator("animate", vec![preset("wobble")])).is_none());
        // Missing preset omits too — there is nothing sensible to play.
        assert!(lower_anim_applicator(&applicator("animate", vec![])).is_none());
        // Named-only args without a positional preset also omit.
        assert!(lower_anim_applicator(&applicator(
            "animate",
            vec![named("duration", ParserValue::Number(500.0))],
        ))
        .is_none());
    }

    #[test]
    fn animate_binding_preset_omits_channel() {
        assert!(lower_anim_applicator(&applicator(
            "animate",
            vec![positional(ParserValue::Reference("state.preset".to_string()))],
        ))
        .is_none());
        assert!(lower_anim_applicator(&applicator(
            "animate",
            vec![positional(ParserValue::String("@{state.preset}".to_string()))],
        ))
        .is_none());
    }

    #[test]
    fn animate_binding_modifiers_keep_defaults() {
        let (_, spec) = lower(
            "animate",
            vec![
                preset("spin"),
                named("duration", ParserValue::Reference("state.dur".to_string())),
                named("repeat", ParserValue::Reference("state.n".to_string())),
                named("curve", ParserValue::String("@{state.curve}".to_string())),
            ],
        );
        assert_eq!(
            spec,
            json!({"preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear"})
        );
    }

    #[test]
    fn animate_delay_only_when_given() {
        let (_, spec) = lower("animate", vec![preset("spin")]);
        assert!(spec.get("delay").is_none());

        let (_, spec) = lower(
            "animate",
            vec![preset("shake"), named("delay", ParserValue::Number(100.0))],
        );
        assert_eq!(spec["delay"], json!(100));
    }

    #[test]
    fn animate_unknown_curve_falls_back_to_preset_default() {
        let (_, spec) = lower(
            "animate",
            vec![
                preset("spin"),
                named("curve", ParserValue::String("wobble".to_string())),
            ],
        );
        assert_eq!(spec["curve"], json!("linear"));
    }

    #[test]
    fn animate_extra_positionals_ignored() {
        // Modifiers are named-only on .animate — stray positionals warn and
        // are dropped, they never mutate the spec.
        let (_, spec) = lower(
            "animate",
            vec![
                preset("pulse"),
                positional(ParserValue::Number(999.0)),
                positional(ParserValue::String("linear".to_string())),
            ],
        );
        assert_eq!(
            spec,
            json!({"preset": "pulse", "duration": 1200, "repeat": "loop", "curve": "easeInOut"})
        );
    }

    #[test]
    fn animate_unknown_named_argument_ignored() {
        // "when:" triggers are out of scope for this slice — unknown named
        // args warn and are dropped.
        let (_, spec) = lower(
            "animate",
            vec![
                preset("shake"),
                named("when", ParserValue::String("@{state.error}".to_string())),
            ],
        );
        assert_eq!(
            spec,
            json!({"preset": "shake", "duration": 400, "repeat": 1, "curve": "easeInOut"})
        );
    }
}
