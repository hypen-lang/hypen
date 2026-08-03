// Animation applicator lowering — .transition/.enter/.exit/.layout/.animate/.motion → "__anim.*" props
//
// Each animation applicator lowers into ONE reserved prop carrying ONE JSON
// object (`"__anim.transition"`, `"__anim.enter"`, `"__anim.exit"`,
// `"__anim.layout"`, `"__anim.animate"`, `"__anim.motion"`). Renderers route on a single `startsWith("__anim.")`
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

/// Reserved prop key carrying the `.motion(essential)` reduced-motion
/// opt-out: `{"essential": true}`. Marks the rare animation that carries
/// meaning (a progress indicator, a status pulse) so animation-aware
/// renderers keep playing it when the platform asks for reduced motion.
/// The only valid token is `essential` — anything else warns and omits the
/// channel entirely (there is no "non-essential" marker to emit).
pub(crate) const ANIM_MOTION_PROP: &str = "__anim.motion";

/// Reserved prop key carrying the `.exit(...)` spec. The reconciler reads it
/// off a removal root's resolved props (before any tree mutation) to decide
/// whether to flag the root `Remove` with `transition: true` — see the
/// ordering contract on `Patch::Remove`.
pub(crate) const ANIM_EXIT_PROP: &str = "__anim.exit";

/// The `.states { onState(...) }` applicator name (Option C). Intercepted in
/// `process_applicators` like the other animation applicators, but *applied*
/// only after every other applicator has merged into props, so pose defaults
/// capture the node's final base values.
pub(crate) const STATES_APPLICATOR: &str = "states";

/// Reserved prop key for a node's `.transition(...)` spec. `.states`
/// synthesizes one scoped to its animatable overridden props — but only when
/// the author didn't write an explicit `.transition` (explicit wins).
pub(crate) const ANIM_TRANSITION_PROP: &str = "__anim.transition";

/// Prop key the deprecated legacy string form
/// `.transition("opacity 0.3s ease")` lowers to (the generic applicator
/// path, see [`is_legacy_transition_string`]). Still an EXPLICIT
/// `.transition` for the `.states` precedence rule: synthesizing an
/// `__anim.transition` next to it would make the DOM applicator's
/// `style.transition` shorthand and the animator's longhands clobber each
/// other per patch order.
pub(crate) const LEGACY_TRANSITION_PROP: &str = "transition.0";

/// Reserved prop key carrying the active `.states` pose label as
/// `{"label": "<label>"}` (default `null`). Lowered as a `StateSwitch` over
/// the labels themselves, so renderers observe pose changes as an ordinary
/// `SetProp` — used to attach the label to completion payloads and to time
/// the settle window. Renderers that ignore it lose nothing.
pub(crate) const ANIM_STATES_PROP: &str = "__anim.states";

/// Reserved prop carrying the `.sharedElement` identity KEY (Option H).
/// Unlike every other animation argument the key is allowed to bind —
/// identity is data ("cover-@{item.id}") — so it lowers through the standard
/// parser-value conversion (String/TemplateString/Binding preserved) and
/// re-resolves per render, flowing as `SetProp` on state change.
pub(crate) const ANIM_SHARED_KEY_PROP: &str = "__anim.sharedKey";

/// Reserved prop carrying the `.sharedElement` timing spec (Option H) —
/// a static `{"duration", "curve"}` object like every other channel.
pub(crate) const ANIM_SHARED_PROP: &str = "__anim.shared";

/// Default duration (ms) filled into a batch-animation spec that doesn't
/// carry one (Option D cheap subset — see `Patch::BatchAnimation`).
pub(crate) const BATCH_ANIMATION_DEFAULT_DURATION: f64 = 250.0;

/// Normalize a host-supplied batch-animation context (Option D) into the
/// complete spec object renderers receive on `Patch::BatchAnimation`.
///
/// Accepted inputs:
/// - a bare curve string from the [`CURVES`] vocabulary — normalized to
///   `{"curve": <s>, "duration": 250}`;
/// - a JSON object — validated loosely: a missing `duration` is filled with
///   250, every other field (known or unknown) passes through untouched.
///   Renderers own interpretation.
///
/// Anything else (unknown curve string, number, array, bool, null) warns
/// and returns `None` — the update proceeds unstamped, never a hard error.
pub(crate) fn normalize_batch_animation(spec: serde_json::Value) -> Option<serde_json::Value> {
    match spec {
        serde_json::Value::String(s) => {
            if CURVES.contains(&s.as_str()) {
                let mut map = serde_json::Map::new();
                map.insert("curve".to_string(), serde_json::json!(s));
                map.insert(
                    "duration".to_string(),
                    json_ms(BATCH_ANIMATION_DEFAULT_DURATION),
                );
                Some(serde_json::Value::Object(map))
            } else {
                crate::log_warn!(
                    LogScope::Engine,
                    "batch animation: unknown curve '{}' (expected one of {}); update proceeds unstamped",
                    s,
                    CURVES.join("|")
                );
                None
            }
        }
        serde_json::Value::Object(mut map) => {
            map.entry("duration".to_string())
                .or_insert_with(|| json_ms(BATCH_ANIMATION_DEFAULT_DURATION));
            Some(serde_json::Value::Object(map))
        }
        other => {
            crate::log_warn!(
                LogScope::Engine,
                "batch animation: spec must be an object or a curve string, got {}; update proceeds unstamped",
                other
            );
            None
        }
    }
}

/// True when the applicator name is one of the six animation applicators
/// intercepted in `process_applicators`.
pub(crate) fn is_anim_applicator(name: &str) -> bool {
    matches!(
        name,
        "transition" | "enter" | "exit" | "layout" | "animate" | "motion"
    )
}

/// True for `.sharedElement` (Option H). Intercepted separately from
/// [`is_anim_applicator`] because its lowering splits into TWO props
/// (identity + timing) and its key argument — alone among animation
/// arguments — is allowed to carry bindings.
pub(crate) fn is_shared_element_applicator(name: &str) -> bool {
    name == "sharedElement"
}

/// Lower `.sharedElement(<key>, curve: ..., duration: ...)` (Option H).
///
/// Returns the RAW key parser value (first positional; the caller runs it
/// through the standard parser-value conversion so String/TemplateString/
/// Binding forms all resolve through the existing machinery) plus the static
/// timing spec `{"duration", "curve"}` with defaults `{350, "spring"}`.
///
/// A missing, empty, or non-string-ish key warns and returns `None` — the
/// caller omits BOTH props. Invalid timing arguments degrade to the defaults
/// with a warning, never a hard error. Timing modifiers are named-only.
pub(crate) fn lower_shared_element(
    applicator: &ApplicatorSpecification,
) -> Option<(&ParserValue, serde_json::Value)> {
    let channel = "sharedElement";

    let mut positionals = applicator
        .arguments
        .arguments
        .iter()
        .filter_map(|arg| match arg {
            Argument::Positioned { value, .. } => Some(value),
            Argument::Named { .. } => None,
        });
    let key = match positionals.next() {
        Some(value @ ParserValue::String(s)) => {
            if unquote(s).is_empty() {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: key must be a non-empty string; applicator ignored",
                    channel
                );
                return None;
            }
            value
        }
        // A pure reference key (`@state.heroKey`) is a binding — allowed:
        // identity is data. Conversion downstream turns it into Value::Binding.
        Some(value @ (ParserValue::Reference(_) | ParserValue::DataSourceReference(_))) => value,
        Some(other) => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: key must be a string (bindings allowed), got {:?}; applicator ignored",
                channel,
                other
            );
            return None;
        }
        None => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: missing key (first positional argument); applicator ignored",
                channel
            );
            return None;
        }
    };
    for extra in positionals {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: unsupported positional argument {:?}; ignored (timing is named: duration/curve)",
            channel,
            extra
        );
    }

    let mut duration = 350.0;
    let mut curve = "spring".to_string();
    for arg in &applicator.arguments.arguments {
        let Argument::Named { key: name, value } = arg else {
            continue;
        };
        match name.as_str() {
            "duration" => {
                if let Some(ms) = named_ms(channel, "duration", value) {
                    duration = ms;
                }
            }
            "curve" => apply_named_curve(channel, value, &mut curve),
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
    spec.insert("duration".to_string(), json_ms(duration));
    spec.insert("curve".to_string(), serde_json::json!(curve));
    Some((key, serde_json::Value::Object(spec)))
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
/// hard error). `.animate` and `.motion` are the exceptions: an unknown or
/// missing `.animate` preset — or any `.motion` token other than
/// `essential` — warns and omits the channel entirely, there is nothing
/// sensible to emit without one.
pub(crate) fn lower_anim_applicator(
    applicator: &ApplicatorSpecification,
) -> Option<(String, serde_json::Value)> {
    let channel = applicator.name.as_str();
    if channel == "animate" {
        return lower_animate(applicator);
    }
    if channel == "motion" {
        return lower_motion(applicator);
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

/// Lower `.motion(essential)` into `("__anim.motion", {"essential": true})`.
///
/// The reduced-motion opt-out (#149): the flag marks the rare animation that
/// carries meaning, so animation-aware renderers exempt the node from their
/// reduced-motion snap paths. `essential` is the ONLY valid token — a
/// missing, unknown, or non-token argument warns and omits the channel
/// entirely (like `.animate` with an unknown preset: there is no meaningful
/// spec to emit without it). Extra arguments warn and are ignored.
fn lower_motion(applicator: &ApplicatorSpecification) -> Option<(String, serde_json::Value)> {
    let channel = "motion";

    let mut positionals = applicator
        .arguments
        .arguments
        .iter()
        .filter_map(|arg| match arg {
            Argument::Positioned { value, .. } => Some(value),
            Argument::Named { .. } => None,
        });
    match positionals.next() {
        Some(ParserValue::String(s)) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, &token);
                return None;
            }
            if token != "essential" {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown token '{}' (the only valid token is 'essential'); applicator omitted",
                    channel,
                    token
                );
                return None;
            }
        }
        Some(ParserValue::Reference(r)) | Some(ParserValue::DataSourceReference(r)) => {
            warn_binding(channel, r);
            return None;
        }
        Some(other) => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: expected the token 'essential', got {:?}; applicator omitted",
                channel,
                other
            );
            return None;
        }
        None => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: missing token (expected 'essential'); applicator omitted",
                channel
            );
            return None;
        }
    }
    for extra in positionals {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: unsupported positional argument {:?}; ignored",
            channel,
            extra
        );
    }
    for arg in &applicator.arguments.arguments {
        if let Argument::Named { key, .. } = arg {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: unknown argument '{}'; ignored",
                channel,
                key
            );
        }
    }

    let mut spec = serde_json::Map::new();
    spec.insert("essential".to_string(), serde_json::json!(true));
    Some((ANIM_MOTION_PROP.to_string(), serde_json::Value::Object(spec)))
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

// ---------------------------------------------------------------------------
// `.states { onState(...) }` — Option C named visual states
// ---------------------------------------------------------------------------

/// Parsed `.states(...)` header + pose blocks, ready for lowering in
/// `expand::apply_states_applicator`. Timing defaults are {easeOut, 250, 0}.
pub(crate) struct StatesSpec {
    /// The driving state path (from the mandatory first positional
    /// `@state.xxx` reference).
    pub path: String,
    pub duration: f64,
    pub curve: String,
    /// Only `Some` when the author passed `delay:` — the synthesized spec
    /// omits the key otherwise, mirroring `.transition`'s wire format.
    pub delay: Option<f64>,
    /// Pose label → that pose's applicator chain. Duplicate labels warn and
    /// the last occurrence wins.
    pub poses: indexmap::IndexMap<String, Vec<ApplicatorSpecification>>,
}

/// Collect a `.states(...) { onState(label)... }` applicator into a
/// [`StatesSpec`]. Returns `None` (with a warning) when the whole applicator
/// must be ignored: a first positional that is not a state reference, or no
/// valid `onState` entry at all. Malformed *entries* degrade individually.
pub(crate) fn collect_states(applicator: &ApplicatorSpecification) -> Option<StatesSpec> {
    let channel = STATES_APPLICATOR;

    // --- header: first positional MUST be a state reference/binding ---
    let mut positionals = applicator
        .arguments
        .arguments
        .iter()
        .filter_map(|arg| match arg {
            Argument::Positioned { value, .. } => Some(value),
            Argument::Named { .. } => None,
        });
    let path = match positionals.next() {
        Some(value) => match crate::ir::expand::parser_value_to_ir(value) {
            crate::ir::Value::Binding(binding) if binding.is_state() => binding.full_path(),
            _ => {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: first argument must be a state reference (e.g. @state.cardState), got {:?}; applicator ignored",
                    channel,
                    value
                );
                return None;
            }
        },
        None => {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: missing state reference (e.g. .states(@state.cardState) {{ ... }}); applicator ignored",
                channel
            );
            return None;
        }
    };
    for extra in positionals {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: unsupported positional argument {:?}; ignored (modifiers are named: transition/duration/delay)",
            channel,
            extra
        );
    }

    let mut duration = 250.0;
    let mut curve = "easeOut".to_string();
    let mut delay: Option<f64> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            continue;
        };
        match key.as_str() {
            "transition" => apply_named_curve(channel, value, &mut curve),
            "duration" => {
                if let Some(ms) = named_ms(channel, "duration", value) {
                    duration = ms;
                }
            }
            "delay" => {
                delay = named_ms(channel, "delay", value).or(delay);
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

    // --- block: only `onState(<label>)` entries with applicators ---
    let mut poses: indexmap::IndexMap<String, Vec<ApplicatorSpecification>> =
        indexmap::IndexMap::new();
    for child in &applicator.children {
        if child.name != "onState" {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: only onState(<label>) entries are allowed in the block, got '{}'; ignored",
                channel,
                child.name
            );
            continue;
        }
        if !child.children.is_empty() {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: onState takes applicators, not children; entry ignored",
                channel
            );
            continue;
        }
        let label = child
            .arguments
            .arguments
            .iter()
            .find_map(|arg| match arg {
                Argument::Positioned {
                    value: ParserValue::String(s),
                    ..
                } => Some(unquote(s)),
                _ => None,
            })
            .filter(|l| !l.is_empty() && !is_binding_like(l));
        let Some(label) = label else {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: onState requires one positional label (bare identifier or string); entry ignored",
                channel
            );
            continue;
        };
        if poses.contains_key(&label) {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: duplicate onState label '{}'; last one wins",
                channel,
                label
            );
        }
        poses.insert(label, child.applicators.clone());
    }

    if poses.is_empty() {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: no valid onState entries in the block; applicator ignored",
            channel
        );
        return None;
    }

    Some(StatesSpec {
        path,
        duration,
        curve,
        delay,
        poses,
    })
}

/// True for applicators that must not appear inside an `onState` pose:
/// animation applicators (including nested `.states` and the Option G
/// `.scrub`/`.settle` pair), `.bind`, and event applicators (`/^on[A-Z]/`).
/// Excluded entries warn and are dropped.
pub(crate) fn is_pose_excluded_applicator(name: &str) -> bool {
    is_anim_applicator(name)
        || name == STATES_APPLICATOR
        || name == SCRUB_APPLICATOR
        || name == SETTLE_APPLICATOR
        || name == "bind"
        || {
            name.strip_prefix("on")
                .and_then(|rest| rest.chars().next())
                .is_some_and(|c| c.is_ascii_uppercase())
        }
}

/// The Hypen prop name a lowered prop key belongs to: everything before the
/// first `.` (arg index / named arg), `@` (breakpoint variant) or `:` (state
/// variant) — e.g. `cornerRadius.0` → `cornerRadius`,
/// `backgroundColor:hover.0` → `backgroundColor`. Used to scope the
/// synthesized `.states` transition spec against [`ANIMATABLE_PROPS`].
pub(crate) fn base_prop_name(key: &str) -> &str {
    let end = key.find(['.', '@', ':']).unwrap_or(key.len());
    &key[..end]
}

/// Build the `__anim.transition` spec `.states` synthesizes for its
/// animatable overridden props. Same wire shape as `.transition(...)`:
/// `{duration, curve, delay?, props}`.
pub(crate) fn synthesize_states_transition(
    spec: &StatesSpec,
    animatable_props: Vec<String>,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("duration".to_string(), json_ms(spec.duration));
    map.insert("curve".to_string(), serde_json::json!(spec.curve));
    if let Some(d) = spec.delay {
        map.insert("delay".to_string(), json_ms(d));
    }
    map.insert("props".to_string(), serde_json::json!(animatable_props));
    serde_json::Value::Object(map)
}

// ---------------------------------------------------------------------------
// `.scrub` / `.settle` — Option G scrub bindings (renderer-resident sources)
// ---------------------------------------------------------------------------
//
// Scrub interpolates between TWO of the node's `.states` poses (`from:` /
// `to:` name pose labels — author-defined timelines were rejected with the
// Option E decision), driven by a renderer-resident source; the per-frame
// loop never touches the engine. `.settle` names the release animation and
// binds the winning pose label back to a `@state.*` path — the same dotted
// path-string idiom as the `.bind` applicator.
//
// Both applicators are intercepted in `process_applicators` and applied in
// the SAME deferred end-phase as `.states` — strictly AFTER it, because
// cross-validation reads the collected pose labels. Lowered wire props (all
// `Value::Static`; renderers own interpretation):
//   "__anim.scrub"       {"from","to","source","axis","over":[p0,p1],"rubberBand"} (+"of" w/ scroll)
//   "__anim.scrubSettle" {"curve","duration"}
//   "__anim.scrubBind"   "<dotted state path>"
//   "__anim.scrubPoses"  {"<propKey>": [fromValue, toValue], ...}
//
// `over` is the DIRECTED input range [inputAtProgress0, inputAtProgress1] —
// direction matters (an upward-opening sheet uses [0, -400]); only equal or
// non-finite endpoints are rejected. `__anim.scrubPoses` materializes the
// pose endpoint values at lowering (the renderer cannot interpolate without
// them): for every prop key overridden by the from- or to-pose, both
// endpoint values resolve as pose override, else the node's static base
// default; keys resolvable on only one end warn and are skipped.
// Any hard violation (missing/unknown pose label, missing/invalid `over`,
// missing/invalid `.settle` or its bind, no `.states` on the node) warns
// ONCE naming the reason and omits ALL FOUR props — the node degrades to
// plain `.states` behavior, never a hard error.

/// The `.scrub(...)` applicator name (Option G).
pub(crate) const SCRUB_APPLICATOR: &str = "scrub";

/// The `.settle(...)` companion applicator name (Option G).
pub(crate) const SETTLE_APPLICATOR: &str = "settle";

/// Scrub source vocabulary. Closed and small BY DESIGN — every new source
/// is an implementation in all five renderers (see the §G tradeoffs).
pub const SCRUB_SOURCES: &[&str] = &["gesture", "scroll"];

/// Scrub axis vocabulary.
pub const SCRUB_AXES: &[&str] = &["x", "y"];

/// Default rubber-band resistance applied beyond the `over` range.
pub(crate) const SCRUB_DEFAULT_RUBBER_BAND: f64 = 0.4;

/// Default `.settle` duration (ms).
pub(crate) const SETTLE_DEFAULT_DURATION: f64 = 300.0;

/// Reserved prop carrying the scrub source spec.
pub(crate) const ANIM_SCRUB_PROP: &str = "__anim.scrub";

/// Reserved prop carrying the settle timing spec.
pub(crate) const ANIM_SCRUB_SETTLE_PROP: &str = "__anim.scrubSettle";

/// Reserved prop carrying the settle write target — the dotted state path
/// string, module-scope semantics identical to the `.bind` applicator's
/// `"bind"` prop.
pub(crate) const ANIM_SCRUB_BIND_PROP: &str = "__anim.scrubBind";

/// Reserved prop carrying the materialized pose endpoint values:
/// `{"<propKey>": [fromValue, toValue], ...}` — one entry per prop key the
/// from- or to-pose overrides, with each endpoint resolved as pose override,
/// else the node's static base default. Keys resolvable on only one end are
/// skipped (with a warning) at lowering.
pub(crate) const ANIM_SCRUB_POSES_PROP: &str = "__anim.scrubPoses";

/// Parsed `.scrub(...)` arguments, validated except for the pose-label
/// cross-check (which needs the node's collected `.states` labels — done in
/// `expand::apply_scrub_applicators`).
pub(crate) struct ScrubSpec {
    pub from: String,
    pub to: String,
    /// One of [`SCRUB_SOURCES`]; defaults to `"gesture"`.
    pub source: String,
    /// One of [`SCRUB_AXES`]; defaults to `"y"`.
    pub axis: String,
    /// The `[inputAtProgress0, inputAtProgress1]` input range mapping onto
    /// progress 0..1. Directed — `[0, -400]` (upward travel) is as valid as
    /// `[0, 400]`; only equal endpoints are rejected.
    pub over: (f64, f64),
    /// Resistance factor 0..=1 beyond the range; defaults to 0.4.
    pub rubber_band: f64,
    /// Named scroll container — only kept when `source` is `scroll`.
    pub of: Option<String>,
}

/// Parsed `.settle(...)` arguments. Timing defaults are {spring, 300}.
pub(crate) struct SettleSpec {
    pub curve: String,
    pub duration: f64,
    /// Dotted state path the winning pose label is written to on settle.
    pub bind: String,
}

/// A pose-label argument value: a bare token or quoted string, non-empty and
/// not binding-like. `None` for anything else.
fn scrub_label(value: &ParserValue) -> Option<String> {
    match value {
        ParserValue::String(s) => {
            let token = unquote(s);
            (!token.is_empty() && !is_binding_like(&token)).then_some(token)
        }
        _ => None,
    }
}

/// A closed-vocabulary token argument (`source:` / `axis:`). Unknown or
/// non-token values warn and return `None` (keep the default).
fn scrub_token(channel: &str, field: &str, value: &ParserValue, vocab: &[&str]) -> Option<String> {
    match value {
        ParserValue::String(s) => {
            let token = unquote(s);
            if is_binding_like(&token) {
                warn_binding(channel, &token);
                None
            } else if vocab.contains(&token.as_str()) {
                Some(token)
            } else {
                crate::log_warn!(
                    LogScope::Engine,
                    ".{}: unknown {} '{}' (expected one of {}); using the default",
                    channel,
                    field,
                    token,
                    vocab.join("|")
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
                ".{}: {} must be a token (one of {}), got {:?}; using the default",
                channel,
                field,
                vocab.join("|"),
                other
            );
            None
        }
    }
}

/// Collect a `.scrub(from:, to:, source:, axis:, over:, rubberBand:, of:)`
/// applicator into a [`ScrubSpec`]. `Err` carries the ONE hard-failure
/// reason (missing/invalid `from`/`to`/`over`) for the caller's single
/// omit-all warning; every other malformed argument degrades to its default
/// with its own warning.
pub(crate) fn collect_scrub(applicator: &ApplicatorSpecification) -> Result<ScrubSpec, String> {
    let channel = SCRUB_APPLICATOR;

    if !applicator.children.is_empty() {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: children block ignored (.{} takes only named arguments)",
            channel,
            channel
        );
    }

    let mut from: Option<String> = None;
    let mut to: Option<String> = None;
    let mut source = "gesture".to_string();
    let mut axis = "y".to_string();
    let mut over: Option<(f64, f64)> = None;
    let mut over_invalid = false;
    let mut rubber_band = SCRUB_DEFAULT_RUBBER_BAND;
    let mut of: Option<String> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: unsupported positional argument {:?}; ignored (arguments are named: from/to/source/axis/over/rubberBand/of)",
                channel,
                arg
            );
            continue;
        };
        match key.as_str() {
            "from" => from = scrub_label(value),
            "to" => to = scrub_label(value),
            "source" => {
                if let Some(token) = scrub_token(channel, "source", value, SCRUB_SOURCES) {
                    source = token;
                }
            }
            "axis" => {
                if let Some(token) = scrub_token(channel, "axis", value, SCRUB_AXES) {
                    axis = token;
                }
            }
            "over" => match value {
                ParserValue::List(items) => {
                    let nums: Option<Vec<f64>> = items
                        .iter()
                        .map(|v| match v {
                            ParserValue::Number(n) => Some(*n),
                            _ => None,
                        })
                        .collect();
                    // `over` is [inputAtProgress0, inputAtProgress1] — a
                    // DIRECTED range, not a min/max pair. Direction matters:
                    // an upward-opening sheet maps travel [0, -400] onto
                    // progress 0..1. Only equal or non-finite endpoints are
                    // rejected (a zero-length range cannot map to progress).
                    match nums.as_deref() {
                        Some([a, b]) if a.is_finite() && b.is_finite() && a != b => {
                            over = Some((*a, *b));
                        }
                        _ => over_invalid = true,
                    }
                }
                _ => over_invalid = true,
            },
            "rubberBand" => match value {
                ParserValue::Number(n) if n.is_finite() => {
                    let clamped = n.clamp(0.0, 1.0);
                    if clamped != *n {
                        crate::log_warn!(
                            LogScope::Engine,
                            ".{}: rubberBand {} is outside 0..=1; clamped to {}",
                            channel,
                            n,
                            clamped
                        );
                    }
                    rubber_band = clamped;
                }
                ParserValue::Reference(r) | ParserValue::DataSourceReference(r) => {
                    warn_binding(channel, r);
                }
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: rubberBand must be a number in 0..=1, got {:?}; using {}",
                        channel,
                        other,
                        SCRUB_DEFAULT_RUBBER_BAND
                    );
                }
            },
            "of" => match value {
                ParserValue::String(s) => {
                    let name = unquote(s);
                    if name.is_empty() || is_binding_like(&name) {
                        crate::log_warn!(
                            LogScope::Engine,
                            ".{}: of must be a non-empty static string, got '{}'; ignored",
                            channel,
                            name
                        );
                    } else {
                        of = Some(name);
                    }
                }
                other => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".{}: of must be a string naming a scroll container, got {:?}; ignored",
                        channel,
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
        }
    }

    let Some(from) = from else {
        return Err("from: is required and must name a .states pose label (token or string)".into());
    };
    let Some(to) = to else {
        return Err("to: is required and must name a .states pose label (token or string)".into());
    };
    let Some(over) = over else {
        return Err(if over_invalid {
            "over: must be [inputAtProgress0, inputAtProgress1] — two finite, non-equal numbers"
                .into()
        } else {
            "over: is required ([inputAtProgress0, inputAtProgress1] input range)".into()
        });
    };

    // `of:` names a scroll container — meaningless for a gesture source.
    if of.is_some() && source != "scroll" {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: of: is only meaningful with source: scroll; ignored",
            channel
        );
        of = None;
    }

    Ok(ScrubSpec {
        from,
        to,
        source,
        axis,
        over,
        rubber_band,
        of,
    })
}

/// Collect a `.settle(curve:, duration:, bind:)` applicator into a
/// [`SettleSpec`]. `Err` carries the ONE hard-failure reason (missing or
/// non-`@state.*` bind); invalid timing degrades to the defaults with a
/// warning.
pub(crate) fn collect_settle(applicator: &ApplicatorSpecification) -> Result<SettleSpec, String> {
    let channel = SETTLE_APPLICATOR;

    if !applicator.children.is_empty() {
        crate::log_warn!(
            LogScope::Engine,
            ".{}: children block ignored (.{} takes only named arguments)",
            channel,
            channel
        );
    }

    let mut curve = "spring".to_string();
    let mut duration = SETTLE_DEFAULT_DURATION;
    let mut bind: Option<String> = None;

    for arg in &applicator.arguments.arguments {
        let Argument::Named { key, value } = arg else {
            crate::log_warn!(
                LogScope::Engine,
                ".{}: unsupported positional argument {:?}; ignored (arguments are named: curve/duration/bind)",
                channel,
                arg
            );
            continue;
        };
        match key.as_str() {
            "curve" => apply_named_curve(channel, value, &mut curve),
            "duration" => {
                if let Some(ms) = named_ms(channel, "duration", value) {
                    duration = ms;
                }
            }
            // Exactly the `.bind` applicator's path-string convention: a
            // `@state.*` reference stored as its dotted path ("sheetPhase").
            "bind" => match crate::ir::expand::parser_value_to_ir(value) {
                crate::ir::Value::Binding(binding) if binding.is_state() => {
                    bind = Some(binding.full_path());
                }
                _ => {
                    // Leave `bind` unset — the missing/invalid Err below is
                    // the node's single omit-all warning.
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
        }
    }

    let Some(bind) = bind else {
        return Err(
            ".settle requires bind: with a @state.* reference (e.g. bind: @state.sheetPhase)"
                .into(),
        );
    };

    Ok(SettleSpec {
        curve,
        duration,
        bind,
    })
}

/// Wire spec for `"__anim.scrub"`:
/// `{"from","to","source","axis","over":[atProgress0,atProgress1],"rubberBand"}`
/// plus `"of"` only when given with a scroll source.
pub(crate) fn scrub_spec_json(spec: &ScrubSpec) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("from".to_string(), serde_json::json!(spec.from));
    map.insert("to".to_string(), serde_json::json!(spec.to));
    map.insert("source".to_string(), serde_json::json!(spec.source));
    map.insert("axis".to_string(), serde_json::json!(spec.axis));
    map.insert(
        "over".to_string(),
        serde_json::Value::Array(vec![json_num(spec.over.0), json_num(spec.over.1)]),
    );
    map.insert("rubberBand".to_string(), json_num(spec.rubber_band));
    if let Some(of) = &spec.of {
        map.insert("of".to_string(), serde_json::json!(of));
    }
    serde_json::Value::Object(map)
}

/// Wire spec for `"__anim.scrubSettle"`: `{"curve","duration"}`.
pub(crate) fn settle_spec_json(spec: &SettleSpec) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("curve".to_string(), serde_json::json!(spec.curve));
    map.insert("duration".to_string(), json_ms(spec.duration));
    serde_json::Value::Object(map)
}

/// Like [`json_ms`] but sign-preserving: whole numbers serialize as JSON
/// integers (an `over` range may be negative, e.g. `[-100, 0]`).
fn json_num(n: f64) -> serde_json::Value {
    if n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
        serde_json::Value::from(n as i64)
    } else {
        serde_json::json!(n)
    }
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

    // ------------------------------------------------------------------
    // .motion(essential) — reduced-motion opt-out (#149)
    // ------------------------------------------------------------------

    #[test]
    fn motion_essential_lowers_to_flag_object() {
        let (key, spec) = lower(
            "motion",
            vec![positional(ParserValue::String("essential".to_string()))],
        );
        assert_eq!(key, "__anim.motion");
        // Pin the lowered key to the constant renderers consume.
        assert_eq!(key, ANIM_MOTION_PROP);
        assert_eq!(spec, json!({"essential": true}));
        assert!(is_anim_applicator("motion"));
    }

    #[test]
    fn motion_quoted_token_also_lowers() {
        let (_, spec) = lower(
            "motion",
            vec![positional(ParserValue::String("\"essential\"".to_string()))],
        );
        assert_eq!(spec, json!({"essential": true}));
    }

    #[test]
    fn motion_unknown_token_omits_channel() {
        assert!(lower_anim_applicator(&applicator(
            "motion",
            vec![positional(ParserValue::String("decorative".to_string()))],
        ))
        .is_none());
        // Missing token omits too — there is no meaningful default.
        assert!(lower_anim_applicator(&applicator("motion", vec![])).is_none());
        // Non-token values omit.
        assert!(lower_anim_applicator(&applicator(
            "motion",
            vec![positional(ParserValue::Number(1.0))],
        ))
        .is_none());
        assert!(lower_anim_applicator(&applicator(
            "motion",
            vec![positional(ParserValue::Boolean(true))],
        ))
        .is_none());
    }

    #[test]
    fn motion_binding_token_omits_channel() {
        assert!(lower_anim_applicator(&applicator(
            "motion",
            vec![positional(ParserValue::Reference("state.essential".to_string()))],
        ))
        .is_none());
        assert!(lower_anim_applicator(&applicator(
            "motion",
            vec![positional(ParserValue::String("@{state.essential}".to_string()))],
        ))
        .is_none());
    }

    #[test]
    fn motion_extra_arguments_ignored() {
        let (_, spec) = lower(
            "motion",
            vec![
                positional(ParserValue::String("essential".to_string())),
                positional(ParserValue::String("decorative".to_string())),
                named("duration", ParserValue::Number(200.0)),
            ],
        );
        assert_eq!(spec, json!({"essential": true}));
    }

    // ------------------------------------------------------------------
    // .sharedElement(<key>) — Option H identity + timing
    // ------------------------------------------------------------------

    fn shared(args: Vec<Argument>) -> Option<(ParserValue, serde_json::Value)> {
        let applicator = applicator("sharedElement", args);
        lower_shared_element(&applicator).map(|(k, s)| (k.clone(), s))
    }

    #[test]
    fn shared_element_defaults_and_raw_key() {
        let (key, spec) =
            shared(vec![positional(ParserValue::String("hero-cover".to_string()))]).unwrap();
        assert_eq!(key, ParserValue::String("hero-cover".to_string()));
        assert_eq!(spec, json!({"duration": 350, "curve": "spring"}));
    }

    #[test]
    fn shared_element_template_key_preserved_raw() {
        // The key is returned RAW — template bindings survive for the
        // standard parser-value conversion downstream. Identity is data.
        let raw = "\"cover-@{item.id}\"".to_string();
        let (key, _) = shared(vec![positional(ParserValue::String(raw.clone()))]).unwrap();
        assert_eq!(key, ParserValue::String(raw));

        // Pure reference keys are bindings — also allowed.
        let (key, _) =
            shared(vec![positional(ParserValue::Reference("state.heroKey".to_string()))]).unwrap();
        assert_eq!(key, ParserValue::Reference("state.heroKey".to_string()));
    }

    #[test]
    fn shared_element_named_timing_overrides() {
        let (_, spec) = shared(vec![
            positional(ParserValue::String("hero".to_string())),
            named("curve", ParserValue::String("easeOut".to_string())),
            named("duration", ParserValue::Number(500.0)),
        ])
        .unwrap();
        assert_eq!(spec, json!({"duration": 500, "curve": "easeOut"}));
    }

    #[test]
    fn shared_element_invalid_timing_degrades_to_defaults() {
        let (_, spec) = shared(vec![
            positional(ParserValue::String("hero".to_string())),
            named("curve", ParserValue::String("wobble".to_string())),
            named("duration", ParserValue::Number(-5.0)),
            named("delay", ParserValue::Number(100.0)), // timing only — unknown arg
        ])
        .unwrap();
        assert_eq!(spec, json!({"duration": 350, "curve": "spring"}));
    }

    #[test]
    fn shared_element_missing_or_invalid_key_omits() {
        // Missing key
        assert!(shared(vec![]).is_none());
        // Named-only args, no positional key
        assert!(shared(vec![named("duration", ParserValue::Number(350.0))]).is_none());
        // Empty key
        assert!(shared(vec![positional(ParserValue::String("\"\"".to_string()))]).is_none());
        // Non-string-ish keys
        assert!(shared(vec![positional(ParserValue::Number(42.0))]).is_none());
        assert!(shared(vec![positional(ParserValue::Boolean(true))]).is_none());
        assert!(shared(vec![positional(ParserValue::List(vec![]))]).is_none());
    }

    #[test]
    fn shared_element_extra_positionals_ignored() {
        let (key, spec) = shared(vec![
            positional(ParserValue::String("hero".to_string())),
            positional(ParserValue::Number(500.0)),
            positional(ParserValue::String("easeOut".to_string())),
        ])
        .unwrap();
        assert_eq!(key, ParserValue::String("hero".to_string()));
        assert_eq!(spec, json!({"duration": 350, "curve": "spring"}));
    }

    #[test]
    fn shared_element_prop_key_constants() {
        // Pin the two reserved keys the expand interception writes.
        assert_eq!(ANIM_SHARED_KEY_PROP, "__anim.sharedKey");
        assert_eq!(ANIM_SHARED_PROP, "__anim.shared");
        assert!(is_shared_element_applicator("sharedElement"));
        assert!(!is_shared_element_applicator("shared"));
        // NOT part of the single-prop channel set.
        assert!(!is_anim_applicator("sharedElement"));
    }

    // ------------------------------------------------------------------
    // normalize_batch_animation — Option D batch stamp (cheap subset)
    // ------------------------------------------------------------------

    #[test]
    fn batch_animation_bare_curve_normalizes_with_default_duration() {
        assert_eq!(
            normalize_batch_animation(json!("spring")),
            Some(json!({"curve": "spring", "duration": 250}))
        );
        // Every curve in the shared vocabulary normalizes the same way.
        for curve in CURVES {
            assert_eq!(
                normalize_batch_animation(json!(curve)),
                Some(json!({"curve": curve, "duration": 250}))
            );
        }
    }

    #[test]
    fn batch_animation_unknown_curve_string_rejected() {
        assert_eq!(normalize_batch_animation(json!("wobble")), None);
    }

    #[test]
    fn batch_animation_object_missing_duration_filled() {
        assert_eq!(
            normalize_batch_animation(json!({"curve": "easeOut"})),
            Some(json!({"curve": "easeOut", "duration": 250}))
        );
        // An empty object is still a valid (loose) spec — duration filled.
        assert_eq!(
            normalize_batch_animation(json!({})),
            Some(json!({"duration": 250}))
        );
    }

    #[test]
    fn batch_animation_object_existing_duration_untouched() {
        assert_eq!(
            normalize_batch_animation(json!({"curve": "spring", "duration": 400})),
            Some(json!({"curve": "spring", "duration": 400}))
        );
    }

    #[test]
    fn batch_animation_unknown_fields_pass_through() {
        // Loose validation: renderers own interpretation of extra fields —
        // even an unknown curve inside an OBJECT passes through untouched.
        assert_eq!(
            normalize_batch_animation(
                json!({"curve": "customBezier", "stiffness": 180, "damping": 12})
            ),
            Some(json!({
                "curve": "customBezier",
                "stiffness": 180,
                "damping": 12,
                "duration": 250
            }))
        );
    }

    #[test]
    fn batch_animation_non_object_non_string_rejected() {
        assert_eq!(normalize_batch_animation(json!(250)), None);
        assert_eq!(normalize_batch_animation(json!(["spring"])), None);
        assert_eq!(normalize_batch_animation(json!(true)), None);
        assert_eq!(normalize_batch_animation(serde_json::Value::Null), None);
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
