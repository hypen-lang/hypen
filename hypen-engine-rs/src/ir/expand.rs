// AST → IR lowering - converts parser output to engine IR

use super::{ConditionalBranch, Element, IRNode, Props, RouterRoute, Value};
use crate::reactive::{extract_bindings_from_expression, parse_binding, Binding};
use hypen_parser::{ComponentSpecification, Value as ParserValue};
use std::collections::HashSet;

// Event handling is now done at the renderer level, not in the engine

/// Convert a CSS hyphenated property name to camelCase.
/// e.g., "background-color" → "backgroundColor", "align-items" → "alignItems"
/// Names without hyphens are returned unchanged.
fn css_to_camel_case(name: &str) -> String {
    if !name.contains('-') {
        return name.to_string();
    }
    let mut result = String::with_capacity(name.len());
    let mut capitalize_next = false;
    for ch in name.chars() {
        if ch == '-' {
            capitalize_next = true;
        } else if capitalize_next {
            result.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
        }
    }
    result
}

/// Expand Tailwind classes into CSS properties
/// Returns a Vec of (prop_name, value) pairs with `.0` suffix,
/// consistent with regular applicator props.
/// CSS hyphenated names are converted to camelCase.
fn expand_tailwind_classes(classes: &str) -> Vec<(String, Value)> {
    let output = hypen_tailwind_parse::parse_classes(classes);
    let mut props = Vec::new();

    // Add base properties (no variant)
    for css_prop in &output.base {
        let camel = css_to_camel_case(&css_prop.property);
        props.push((
            format!("{}.0", camel),
            Value::Static(serde_json::Value::String(css_prop.value.clone())),
        ));
    }

    // Add variant properties with suffix notation
    // e.g., "padding@md.0" for responsive, "backgroundColor:hover.0" for state
    for (variant_key, css_props) in &output.variants {
        for css_prop in css_props {
            let camel = css_to_camel_case(&css_prop.property);
            let prop_key = format!("{}{}.0", camel, variant_key);
            props.push((
                prop_key,
                Value::Static(serde_json::Value::String(css_prop.value.clone())),
            ));
        }
    }

    props
}

/// Extract all @{state.xxx} and @{item.xxx} bindings from a template string
/// This handles both simple bindings like @{state.x} and expressions like @{state.x ? 'a' : 'b'}
/// Returns None if no bindings found, Some(bindings) if bindings exist
fn extract_bindings_from_template(s: &str) -> Option<Vec<Binding>> {
    let mut bindings = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut pos = 0;

    // Look for @{ patterns and try to parse them
    while let Some(start) = s[pos..].find("@{") {
        let abs_start = pos + start;
        if let Some(end) = s[abs_start..].find('}') {
            let abs_end = abs_start + end;
            // Extract the full binding string including @{...}
            let binding_str = &s[abs_start..=abs_end];

            // Try to parse as a simple binding first
            if let Some(mut binding) = parse_binding(binding_str) {
                // `.length` is computed FROM the container, not stored in it —
                // state diffs never emit a "...length" path (an unshift changes
                // tasks.0, tasks.3, …). Depend on the container itself so
                // element-level changes invalidate the template. (Same remap
                // as extract_bindings_from_expression.)
                if binding.path.len() >= 2 && binding.path.last().is_some_and(|s| s == "length") {
                    binding.path.pop();
                }
                let path = binding.full_path_with_source();
                if !seen_paths.contains(&path) {
                    seen_paths.insert(path);
                    bindings.push(binding);
                }
            } else {
                // Not a simple binding - extract bindings from the expression
                let expr_content = &s[abs_start + 2..abs_end];
                for binding in extract_bindings_from_expression(expr_content) {
                    let path = binding.full_path_with_source();
                    if !seen_paths.contains(&path) {
                        seen_paths.insert(path);
                        bindings.push(binding);
                    }
                }
            }
            pos = abs_end + 1;
        } else {
            break;
        }
    }

    if bindings.is_empty() {
        None
    } else {
        Some(bindings)
    }
}

/// Process applicators from a parsed component and insert them as props.
///
/// Handles:
/// - `.tw(classes)` - expands Tailwind classes to CSS properties
/// - `.bind(path)` - two-way binding for form elements (state only)
/// - All other applicators - converted to namespaced props
///
/// `element_type` is used by `.bind()` to pick the correct bound property
/// (`checked` for Checkbox, `on` for Switch, `value` otherwise).
/// Breakpoint names recognised in a *responsive-object* applicator value
/// like `.gridColumns({default: 2, md: 3, lg: 4})`. Mirrors the tailwind
/// breakpoints every renderer already resolves via `name@bp` keys.
const RESPONSIVE_KEYS: &[&str] = &["default", "base", "sm", "md", "lg", "xl", "2xl"];

/// Insert an applicator prop, expanding a responsive-object value into
/// the same `name@bp.idx` suffix keys that tailwind `md:` classes
/// produce — the format every renderer (DOM media-query classes,
/// desktop `lookup_breakpoint`, Swift/Android variant resolution) already
/// understands. Without this, `.gridColumns({default: 2, md: 3})` reaches
/// renderers as one opaque object prop that each must special-case (most
/// don't — the DOM stringifies it to `"[object Object]"`).
///
/// Only objects whose keys are *all* breakpoint names are expanded;
/// composite-value objects such as `.size({width, height})` pass through
/// untouched as a single `name.idx` prop.
fn insert_applicator_prop(props: &mut Props, name: &str, idx_key: &str, value: Value) {
    if let Value::Static(serde_json::Value::Object(map)) = &value {
        let all_breakpoints =
            !map.is_empty() && map.keys().all(|k| RESPONSIVE_KEYS.contains(&k.as_str()));
        if all_breakpoints {
            for (bp, v) in map {
                let key = if bp == "default" || bp == "base" {
                    format!("{name}.{idx_key}")
                } else {
                    format!("{name}@{bp}.{idx_key}")
                };
                props.insert(key, Value::Static(v.clone()));
            }
            return;
        }
    }
    props.insert(format!("{name}.{idx_key}"), value);
}

fn process_applicators(
    applicators: &[hypen_parser::ApplicatorSpecification],
    props: &mut Props,
    element_type: &str,
) {
    // `.states { onState(...) }` is collected here but applied only AFTER
    // every other applicator has merged into props: pose lowering captures
    // the node's *final* base value per overridden key as the switch default,
    // so a `.cornerRadius(4)` later in the chain still wins as the base.
    let mut states_applicators: Vec<&hypen_parser::ApplicatorSpecification> = Vec::new();
    // `.scrub`/`.settle` (Option G) are likewise deferred, and apply strictly
    // AFTER the states end-phase below: their cross-validation reads the pose
    // labels `.states` collects. Interception here also guarantees neither
    // ever lowers to a `scrub.<idx>`/`settle.<idx>` prop.
    let mut scrub_applicators: Vec<&hypen_parser::ApplicatorSpecification> = Vec::new();
    let mut settle_applicators: Vec<&hypen_parser::ApplicatorSpecification> = Vec::new();

    for applicator in applicators {
        if applicator.name == crate::ir::anim::STATES_APPLICATOR {
            states_applicators.push(applicator);
            continue;
        }
        if applicator.name == crate::ir::anim::SCRUB_APPLICATOR {
            scrub_applicators.push(applicator);
            continue;
        }
        if applicator.name == crate::ir::anim::SETTLE_APPLICATOR {
            settle_applicators.push(applicator);
            continue;
        }

        // The parser accepts a children block on ANY applicator
        // (`.name(...) { ... }`), but only `.states` consumes one. Every
        // other path below (tw/bind/anim/variant-map/generic) ignores
        // `applicator.children`, so a block here — e.g. a SwiftUI-style
        // `Card().theme(dark) { Text("hi") }` where the body was meant as
        // component children — would silently vanish. Warn loudly instead.
        if !applicator.children.is_empty() {
            crate::log_warn!(
                crate::logger::LogScope::Engine,
                ".{}: children block ignored — only .states consumes a block; \
                 if these were meant as UI children, place the block before \
                 the applicator chain (Component {{ ... }}.{}(...))",
                applicator.name,
                applicator.name
            );
        }

        // .tw(classes) → expand Tailwind to individual CSS props
        if applicator.name == "tw" {
            if let Some(arg) = applicator.arguments.arguments.first() {
                let class_string = match arg {
                    hypen_parser::Argument::Named { value, .. }
                    | hypen_parser::Argument::Positioned { value, .. } => {
                        if let ParserValue::String(s) = value {
                            s.trim_matches(|c: char| c == '"' || c == '\'').to_string()
                        } else {
                            continue;
                        }
                    }
                };
                for (prop_key, prop_value) in expand_tailwind_classes(&class_string) {
                    props.insert(prop_key, prop_value);
                }
            }
            continue;
        }

        // .bind(@state.path) or .bind(@datasource.path) → two-way binding
        if applicator.name == "bind" {
            if let Some(arg) = applicator.arguments.arguments.first() {
                let value = match arg {
                    hypen_parser::Argument::Named { value, .. }
                    | hypen_parser::Argument::Positioned { value, .. } => value,
                };
                let ir_value = parser_value_to_ir(value);
                if let Value::Binding(binding) = ir_value {
                    if binding.is_state() || binding.is_data_source() {
                        let path = if binding.is_data_source() {
                            // For data sources, include provider: "spacetime.selectedId"
                            binding.full_path_with_source()
                        } else {
                            binding.full_path()
                        };
                        let prop_name = match element_type {
                            "Checkbox" | "checkbox" => "checked",
                            "Switch" | "switch" => "on",
                            // Video binds the playback struct ({playing,
                            // position, duration, state}), not a scalar —
                            // see hypen-docs/content/docs/guide/components.mdx §Playback control.
                            "Video" | "video" => "playback",
                            _ => "value",
                        };
                        props.insert(prop_name.to_string(), Value::Binding(binding));
                        props.insert(
                            "bind".to_string(),
                            Value::Static(serde_json::Value::String(path)),
                        );
                    }
                }
            }
            continue;
        }

        // .transition/.enter/.exit/.layout/.animate/.motion → lower into the
        // reserved "__anim.*" prop channel (one JSON object per channel;
        // renderers that don't understand it ignore the prop and snap). The
        // original applicator never becomes a `<name>.<idx>` prop — an
        // `.animate` with an unknown preset (or a `.motion` with anything
        // but `essential`) lowers to nothing at all. Must
        // run BEFORE the variant-map branch below so an animation map
        // argument isn't misread as variant props. The legacy web-only
        // string form `.transition("opacity 0.3s ease")` (single positional
        // string with whitespace) falls through to the generic path
        // (→ "transition.0") for back-compat, with a deprecation warning.
        if crate::ir::anim::is_anim_applicator(&applicator.name) {
            if crate::ir::anim::is_legacy_transition_string(applicator) {
                crate::log_warn!(
                    crate::logger::LogScope::Engine,
                    ".transition(\"<css shorthand>\") is deprecated and web-only; \
                     use .transition(duration, curve) instead"
                );
                // fall through to the generic applicator handling below
            } else {
                if let Some((key, spec)) = crate::ir::anim::lower_anim_applicator(applicator) {
                    props.insert(key, Value::Static(spec));
                }
                continue;
            }
        }

        // .sharedElement(<key>, ...) → Option H shared-element identity.
        // Splits into TWO reserved props: "__anim.sharedKey" carries the raw
        // key through the standard parser-value conversion — UNLIKE every
        // other animation argument the key may bind ("cover-@{item.id}"),
        // identity is data, so it resolves per render and re-resolves as
        // SetProp on state change — while "__anim.shared" is the static
        // timing object (defaults filled at lowering). A missing/empty/
        // non-string-ish key warns and omits BOTH props; either way the
        // applicator is consumed (never a "sharedElement.0" prop).
        if crate::ir::anim::is_shared_element_applicator(&applicator.name) {
            if let Some((raw_key, spec)) = crate::ir::anim::lower_shared_element(applicator) {
                let key_value = parser_value_to_ir(raw_key);
                match key_value {
                    Value::Static(serde_json::Value::String(_))
                    | Value::Binding(_)
                    | Value::TemplateString { .. } => {
                        props.insert(
                            crate::ir::anim::ANIM_SHARED_KEY_PROP.to_string(),
                            key_value,
                        );
                        props.insert(
                            crate::ir::anim::ANIM_SHARED_PROP.to_string(),
                            Value::Static(spec),
                        );
                    }
                    other => {
                        crate::log_warn!(
                            crate::logger::LogScope::Engine,
                            ".sharedElement: key must resolve to a string or binding, got {:?}; applicator ignored",
                            other
                        );
                    }
                }
            }
            continue;
        }

        // Value-map variant form: .padding({ default: 8, md: 16, hover: "x" })
        // When the applicator has a SINGLE positional Map argument whose keys
        // are ALL variant tokens, lower it into suffixed variant props exactly
        // like the tailwind path:
        //   "default" -> "<name>.0"
        //   "md"      -> "<name>@md.0"
        //   "hover"   -> "<name>:hover.0"
        // Map values still flow through parser_value_to_ir so @{state.x}
        // bindings inside continue to work. If not all keys are variant tokens,
        // fall through to the default applicator handling unchanged.
        if applicator.arguments.arguments.len() == 1 {
            if let hypen_parser::Argument::Positioned {
                value: ParserValue::Map(map),
                ..
            } = &applicator.arguments.arguments[0]
            {
                if !map.is_empty()
                    && map
                        .keys()
                        .all(|k| crate::portable::variant::is_variant_token(k))
                {
                    // Emit in canonical precedence order (default, then
                    // breakpoints ascending, then states). The parser's map is
                    // a `HashMap`, so its iteration order is arbitrary — and
                    // the DOM renderer appends one equal-specificity CSS rule
                    // per variant and lets the cascade pick the LAST match, so
                    // an arbitrary order would hand `sm` the win over `lg` on a
                    // wide window, differently on each run.
                    let mut entries: Vec<_> = map.iter().collect();
                    entries.sort_by_key(|(variant, _)| {
                        crate::portable::variant::variant_token_rank(variant)
                    });
                    for (variant, value) in entries {
                        let prop_key = if variant == crate::portable::variant::DEFAULT_KEY {
                            format!("{}.0", applicator.name)
                        } else if crate::portable::variant::is_breakpoint(variant) {
                            format!("{}@{}.0", applicator.name, variant)
                        } else {
                            // state token
                            format!("{}:{}.0", applicator.name, variant)
                        };
                        props.insert(prop_key, parser_value_to_ir(value));
                    }
                    continue;
                }
            }
        }

        // All other applicators become namespaced props
        if applicator.arguments.arguments.is_empty() {
            // Zero-argument applicators default to boolean true
            // e.g. .fillMaxWidth() → fillMaxWidth = true
            props.insert(
                format!("{}.0", applicator.name),
                Value::Static(serde_json::json!(true)),
            );
        } else {
            for (i, arg) in applicator.arguments.arguments.iter().enumerate() {
                let (idx_key, value) = match arg {
                    hypen_parser::Argument::Named { key, value } => {
                        (key.clone(), parser_value_to_ir(value))
                    }
                    hypen_parser::Argument::Positioned { value, .. } => {
                        (i.to_string(), parser_value_to_ir(value))
                    }
                };
                insert_applicator_prop(props, &applicator.name, &idx_key, value);
            }
        }
    }

    // Deferred `.states` application — base values above are now final.
    // Only the first valid `.states` applies; extras warn and are dropped.
    let mut applied = false;
    for applicator in states_applicators {
        if applied {
            crate::log_warn!(
                crate::logger::LogScope::Engine,
                ".states: only one .states applicator is supported per node; extra ignored"
            );
            continue;
        }
        applied = apply_states_applicator(applicator, props, element_type);
    }

    // Deferred `.scrub`/`.settle` application (Option G) — runs after the
    // states phase so the pose-label cross-validation sees the collected
    // labels (via the "__anim.states" switch the states phase inserts).
    apply_scrub_applicators(&scrub_applicators, &settle_applicators, props);
}

/// Apply the node's `.scrub`/`.settle` pair (Option G) to its final props.
///
/// Success inserts FOUR static props — `"__anim.scrub"`,
/// `"__anim.scrubSettle"`, `"__anim.scrubBind"`, `"__anim.scrubPoses"` (see
/// `ir::anim`'s Option G section for the wire shapes). Any hard violation —
/// invalid `.scrub`
/// arguments, missing/invalid `.settle` or its `bind:`, no `.states` block
/// on the node, or a `from:`/`to:` label no pose declares — warns ONCE
/// naming the reason and inserts NOTHING: the node degrades to plain
/// `.states` behavior. A `.settle` without a `.scrub` warns and is ignored.
fn apply_scrub_applicators(
    scrubs: &[&hypen_parser::ApplicatorSpecification],
    settles: &[&hypen_parser::ApplicatorSpecification],
    props: &mut Props,
) {
    use crate::ir::anim;
    use crate::logger::LogScope;

    if scrubs.is_empty() {
        if !settles.is_empty() {
            crate::log_warn!(
                LogScope::Engine,
                ".settle: no .scrub on this node; applicator ignored"
            );
        }
        return;
    }
    if scrubs.len() > 1 {
        crate::log_warn!(
            LogScope::Engine,
            ".scrub: only one .scrub applicator is supported per node; extras ignored"
        );
    }
    if settles.len() > 1 {
        crate::log_warn!(
            LogScope::Engine,
            ".settle: only one .settle applicator is supported per node; extras ignored"
        );
    }

    // ONE warn naming the reason, then omit ALL scrub-related props.
    let omit = |reason: &str| {
        crate::log_warn!(
            LogScope::Engine,
            ".scrub: {}; scrub omitted (node keeps plain .states behavior)",
            reason
        );
    };

    let scrub = match anim::collect_scrub(scrubs[0]) {
        Ok(spec) => spec,
        Err(reason) => return omit(&reason),
    };
    let Some(settle_applicator) = settles.first() else {
        return omit("a .settle(bind: @state.…) must accompany .scrub");
    };
    let settle = match anim::collect_settle(settle_applicator) {
        Ok(spec) => spec,
        Err(reason) => return omit(&reason),
    };

    // Cross-validate against the node's collected `.states` pose labels —
    // the "__anim.states" switch is inserted iff a valid `.states` applied,
    // and its cases are exactly the pose labels.
    let (states_path, labels): (String, Vec<String>) = match props.get(anim::ANIM_STATES_PROP) {
        Some(Value::StateSwitch { path, cases, .. }) => {
            (path.clone(), cases.keys().cloned().collect())
        }
        _ => {
            return omit("the node carries no .states block whose poses scrub could interpolate")
        }
    };
    for (field, label) in [("from", &scrub.from), ("to", &scrub.to)] {
        if !labels.iter().any(|l| l == label) {
            return omit(&format!(
                "{}: '{}' is not one of the node's .states labels ({})",
                field,
                label,
                labels.join("|")
            ));
        }
    }

    // Materialize the pose ENDPOINT values the renderer interpolates between
    // ("__anim.scrubPoses"). The states phase already turned every
    // pose-overridden prop key into a StateSwitch driven by the same state
    // path — reuse those switches: for each key the from- OR to-pose
    // overrides, both endpoints resolve as pose override, else the node's
    // static base default (the switch default). A key resolvable on only one
    // end cannot interpolate — warn and skip it (the pose switch itself
    // still flips it, it just snaps under scrub).
    let mut pose_map = serde_json::Map::new();
    for (key, value) in props.iter() {
        if key == anim::ANIM_STATES_PROP {
            continue;
        }
        let Value::StateSwitch {
            path,
            cases,
            default,
        } = value
        else {
            continue;
        };
        if path != &states_path {
            continue;
        }
        if !cases.contains_key(&scrub.from) && !cases.contains_key(&scrub.to) {
            continue; // overridden only by uninvolved poses
        }
        let from_value = cases.get(&scrub.from).or(default.as_ref());
        let to_value = cases.get(&scrub.to).or(default.as_ref());
        match (from_value, to_value) {
            (Some(from), Some(to)) => {
                pose_map.insert(
                    key.clone(),
                    serde_json::Value::Array(vec![from.clone(), to.clone()]),
                );
            }
            _ => {
                crate::log_warn!(
                    LogScope::Engine,
                    ".scrub: prop '{}' resolves on only one of the from/to poses (no pose override or static base default for the other end); excluded from scrub interpolation",
                    key
                );
            }
        }
    }

    props.insert(
        anim::ANIM_SCRUB_PROP.to_string(),
        Value::Static(anim::scrub_spec_json(&scrub)),
    );
    props.insert(
        anim::ANIM_SCRUB_SETTLE_PROP.to_string(),
        Value::Static(anim::settle_spec_json(&settle)),
    );
    props.insert(
        anim::ANIM_SCRUB_BIND_PROP.to_string(),
        Value::Static(serde_json::Value::String(settle.bind)),
    );
    props.insert(
        anim::ANIM_SCRUB_POSES_PROP.to_string(),
        Value::Static(serde_json::Value::Object(pose_map)),
    );
}

/// Apply one `.states(...) { onState(label)... }` applicator to a node's
/// final props (Option C). Returns `false` when the applicator was ignored
/// entirely (already warned in [`crate::ir::anim::collect_states`]).
///
/// Each pose's applicators are lowered through the ordinary
/// [`process_applicators`] machinery (so `.tw`, directional forms and
/// variant maps all work per-state) minus the pose exclusions: animation
/// applicators, `.bind`, and `on[A-Z]*` event applicators. Every prop key
/// any pose overrides becomes a [`Value::StateSwitch`]; the node also gains
/// a synthesized `__anim.transition` scoped to the animatable overridden
/// props (an explicit `.transition` on the node wins) and the
/// `__anim.states` active-label prop.
fn apply_states_applicator(
    applicator: &hypen_parser::ApplicatorSpecification,
    props: &mut Props,
    element_type: &str,
) -> bool {
    use crate::ir::anim;
    use crate::logger::LogScope;

    let Some(spec) = anim::collect_states(applicator) else {
        return false;
    };

    // Lower each pose to static prop values via the normal applicator path.
    let mut poses: Vec<(String, indexmap::IndexMap<String, serde_json::Value>)> =
        Vec::with_capacity(spec.poses.len());
    for (label, pose_applicators) in &spec.poses {
        let mut allowed: Vec<hypen_parser::ApplicatorSpecification> = Vec::new();
        for pose_applicator in pose_applicators {
            if anim::is_pose_excluded_applicator(&pose_applicator.name) {
                crate::log_warn!(
                    LogScope::Engine,
                    ".states: '.{}' is not allowed inside onState({}) (animation, .bind and event applicators are excluded from poses); ignored",
                    pose_applicator.name,
                    label
                );
            } else {
                allowed.push(pose_applicator.clone());
            }
        }

        let mut pose_props = Props::new();
        process_applicators(&allowed, &mut pose_props, element_type);

        let mut static_props = indexmap::IndexMap::new();
        for (key, value) in &pose_props {
            match value {
                Value::Static(v) => {
                    static_props.insert(key.clone(), v.clone());
                }
                _ => {
                    crate::log_warn!(
                        LogScope::Engine,
                        ".states: pose values must be static — bindings are not supported inside onState({}); prop '{}' ignored",
                        label,
                        key
                    );
                }
            }
        }
        poses.push((label.clone(), static_props));
    }

    // Union of overridden prop keys, in first-appearance order.
    let mut union: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for (_, pose) in &poses {
        union.extend(pose.keys().cloned());
    }

    // Each overridden key becomes a StateSwitch whose default is the node's
    // (final) static base value for that key, when it has one.
    for key in &union {
        let default = match props.get(key.as_str()) {
            Some(Value::Static(v)) => Some(v.clone()),
            Some(_) => {
                crate::log_warn!(
                    LogScope::Engine,
                    ".states: base value of '{}' is not static; the pose switch replaces it without a default",
                    key
                );
                None
            }
            None => None,
        };
        let mut cases = indexmap::IndexMap::new();
        for (label, pose) in &poses {
            if let Some(v) = pose.get(key.as_str()) {
                cases.insert(label.clone(), v.clone());
            }
        }
        props.insert(
            key.clone(),
            Value::StateSwitch {
                path: spec.path.clone(),
                cases,
                default,
            },
        );
    }

    // Synthesize "__anim.transition" scoped to the animatable overridden
    // props. An explicit .transition on the node already inserted the key
    // (the main applicator loop ran first) — explicit wins, skip. The
    // deprecated legacy string form (.transition("opacity 0.3s ease")) is
    // ALSO an explicit .transition, but lowers to the plain "transition.0"
    // prop instead of the channel — synthesizing next to it would put the
    // applicator's `style.transition` shorthand and the animator's longhands
    // in a patch-order race, so it suppresses synthesis too (pose switches
    // then run on the author's CSS; no completion timing is available).
    // When no overridden prop is animatable there is nothing to animate:
    // emit no spec, everything snaps.
    let mut animatable: Vec<String> = Vec::new();
    for key in &union {
        let base = anim::base_prop_name(key);
        if anim::ANIMATABLE_PROPS.contains(&base) && !animatable.iter().any(|p| p == base) {
            animatable.push(base.to_string());
        }
    }
    let has_legacy_transition = props.contains_key(anim::LEGACY_TRANSITION_PROP);
    if !animatable.is_empty()
        && !props.contains_key(anim::ANIM_TRANSITION_PROP)
        && !has_legacy_transition
    {
        props.insert(
            anim::ANIM_TRANSITION_PROP.to_string(),
            Value::Static(anim::synthesize_states_transition(&spec, animatable)),
        );
    } else if !animatable.is_empty() && has_legacy_transition {
        crate::log_warn!(
            LogScope::Engine,
            ".states: the legacy .transition(\"<css shorthand>\") on this node takes precedence over the synthesized states transition; pose switches animate with the author's CSS and fire no completion events"
        );
    }

    // Synthesize the "__anim.states" active-label prop: a StateSwitch over
    // the labels themselves ({"label": <label>}, default null) so renderers
    // see pose changes as an ordinary SetProp.
    let mut label_cases = indexmap::IndexMap::new();
    for (label, _) in &poses {
        label_cases.insert(label.clone(), serde_json::json!({ "label": label }));
    }
    props.insert(
        anim::ANIM_STATES_PROP.to_string(),
        Value::StateSwitch {
            path: spec.path.clone(),
            cases: label_cases,
            default: Some(serde_json::Value::Null),
        },
    );

    true
}

/// Convert parser AST to engine IRNode (first-class control flow constructs)
/// This detects ForEach, When, If, and List components and converts them to the appropriate IRNode variants
pub fn ast_to_ir_node(component: &ComponentSpecification) -> IRNode {
    // Module declarations (`module Search { Column { ... } }`) are semantic
    // wrappers for state scoping — they should NOT create a "Search" element
    // in the render tree. Unwrap to the first child so the output is just
    // the content (e.g., Column). The module name is captured by the component
    // system (is_module / module_name) for state scoping during reconciliation.
    if component.declaration_type == hypen_parser::DeclarationType::Module {
        if let Some(first_child) = component.children.first() {
            let mut ir = ast_to_ir_node(first_child);
            let scope = component.name.to_lowercase();
            // `propagate_module_scope_ir_node` handles every IRNode variant —
            // plain Element but also Router / ForEach / Conditional. The
            // Router case matters for `module App { Router { ... } }`
            // templates where the top-level child is a Router (not an
            // Element): discovery + dependency registration both need the
            // enclosing scope set.
            propagate_module_scope_ir_node(&mut ir, &scope);
            return ir;
        }
    }

    match component.name.as_str() {
        "ForEach" => convert_foreach(component),
        "When" => convert_when(component),
        "If" => convert_if(component),
        "Router" => convert_router(component),
        "List" | "Grid" => convert_list(component),
        _ => {
            // Regular element - convert children to IRNodes recursively
            let mut element = Element::new(&component.name);

            // Carry the parser's name-token byte span so diagnostics
            // (conformance checker, LSP) can point at file:line:col, and the
            // full-expression span so suppression directives can trail any
            // line of a multiline applicator chain.
            element.span = Some(crate::ir::SourceSpan::from_range(
                &component.metadata.name_range,
            ));
            element.expr_span = Some(crate::ir::SourceSpan::from_range(
                &component.metadata.expr_range,
            ));

            // Convert arguments to props
            for (i, arg) in component.arguments.arguments.iter().enumerate() {
                let (key, value) = match arg {
                    hypen_parser::Argument::Named { key, value } => {
                        (key.clone(), parser_value_to_ir(value))
                    }
                    hypen_parser::Argument::Positioned { value, .. } => {
                        let ir_value = parser_value_to_ir(value);
                        let key = if matches!(ir_value, Value::Action(_)) {
                            "action".to_string()
                        } else {
                            i.to_string()
                        };
                        (key, ir_value)
                    }
                };
                element.props.insert(key, value);
            }

            // Convert applicators to props
            process_applicators(
                &component.applicators,
                &mut element.props,
                &element.element_type,
            );

            // Optional key from first positional string argument
            if let Some(hypen_parser::Argument::Positioned {
                value: ParserValue::String(s),
                ..
            }) = component.arguments.arguments.first()
            {
                element.key = Some(s.clone());
            }

            // Convert children recursively as IRNodes
            // Check if this element should be treated as a list (has binding prop "0" and children)
            let has_binding_prop = element
                .props
                .get("0")
                .is_some_and(|v| matches!(v, Value::Binding(_)));
            if has_binding_prop && !component.children.is_empty() {
                // This is the legacy List pattern - convert to ForEach
                if let Some(Value::Binding(binding)) = element.props.get("0").cloned() {
                    let mut props = element.props.clone();
                    props.remove("0"); // Remove the array binding prop (uses COW)

                    let template: Vec<IRNode> =
                        component.children.iter().map(ast_to_ir_node).collect();

                    return IRNode::ForEach {
                        source: binding,
                        item_name: "item".to_string(),
                        key_path: None,
                        template,
                        props,
                        module_scope: None,
                    };
                }
            }

            // Convert children recursively as IRNodes to preserve ForEach/When/If
            element.ir_children = component.children.iter().map(ast_to_ir_node).collect();

            // Derive accessibility semantics once, here in the engine, and
            // carry them to every renderer via the Create patch. Runs after
            // props AND children are populated so prop-dependent semantics
            // (heading level) and content-dependent semantics (accessible
            // name) are both available.
            element.semantics = crate::ir::Semantics::derive(&element);

            // Tabs auto-wiring: a tablist with an explicit `.id(...)` gets
            // its tab↔panel id graph minted for it, so authors don't
            // hand-assemble `.id`/`.controls`/`.labelledby` per pair.
            if element.semantics.as_ref().and_then(|s| s.role)
                == Some(crate::ir::semantics::Role::Tablist)
            {
                wire_tablist(&mut element);
            }

            // Listitem derivation: `.role("list")` is an author's statement
            // that this container really is a semantic list, which is only
            // true to assistive tech when its children are listitems. Wire
            // the direct, role-less element children.
            if element.semantics.as_ref().and_then(|s| s.role)
                == Some(crate::ir::semantics::Role::List)
            {
                wire_list_items(&mut element);
            }

            // Form-control ↔ label auto-association: an unlabeled form
            // control whose immediately-preceding sibling is a static Text
            // gets that Text wired as its label, so authors don't need an
            // explicit `.label(...)` for the ubiquitous label-then-field
            // layout. See `wire_form_labels` for the (deliberately narrow)
            // conditions.
            wire_form_labels(&mut element);

            // A content-named element whose nameable text is dynamic and
            // spans children (`Button { Text("@{state.x}") }`) cannot resolve
            // its name from its own props at reconcile. Hoist the recovered
            // template onto the parent as the synthetic `__a11yName` prop:
            // its bindings register as parent dependencies (a child text
            // change re-emits SetSemantics) and `with_resolved_name` reads
            // the resolved value. Renderers drop the unknown prop.
            if let Some(hoisted) = crate::ir::semantics::hoisted_name_template(&element) {
                element.props.insert("__a11yName".to_string(), hoisted);
            }

            // Intent applicators (.label/.hidden/.role/.landmark) are consumed
            // into the semantics block above; strip them so they don't travel
            // on as junk props (which would otherwise be silently dropped by
            // the renderer's CSS fallback).
            element.props.remove("label.0");
            element.props.remove("hidden.0");
            element.props.remove("description.0");
            // NOTE: .role/.landmark (role.0/landmark.0) and .dir (dir.0) are
            // intentionally NOT stripped — the conformance checker reads them
            // to flag an unrecognised token (a typo like `.role("buton")` or
            // `.dir("rlt")`) rather than
            // silently ignoring it. Likewise .expanded/.pressed/.selected/
            // .current/.invalid AND the id-reference applicators (.id/.controls/
            // .describedby/.labelledby/.owns/.activedescendant) must survive
            // so a bound or templated value (`.expanded(@state.open)`,
            // `.id("opt-@{item.id}")` inside a ForEach) resolves at
            // reconcile. The leftover props are harmless (dropped by the
            // renderer's CSS fallback).

            IRNode::Element(element)
        }
    }
}

/// Auto-wire the id graph of a tablist's tab/panel pairs, and restructure
/// mixed children so the tablist role never owns a tabpanel.
///
/// A hand-assembled accessible Tabs needs four references per pair —
/// `tab.id`, `tab.controls → panel.id`, `panel.id`, `panel.labelledby →
/// tab.id`. When the tablist declares an explicit `.id("settings")` (the
/// deterministic namespace) and its direct children contain an equal,
/// non-zero number of tab-role and tabpanel-role elements, the pairs are
/// wired positionally with minted ids `<tablistId>-tab-<i>` /
/// `<tablistId>-panel-<i>`. Author-supplied values always win (`??=`
/// semantics), and selection state stays author-driven via `.selected`.
///
/// ARIA constrains the shape: `role="tablist"` may own only `role="tab"`
/// children, and `role="tab"` requires a tablist parent. So when tabs and
/// panels are mixed under one container, the container CANNOT be the
/// tablist — it becomes a plain group (role cleared, id and everything
/// else kept), a synthetic inner `Tabs` element (same DOM flex-row host)
/// carries `role="tablist"` and ONLY the tab children in their original
/// relative order, positioned where the first tab was, and the panels stay
/// direct children of the outer container. The restructured outer defaults
/// to column layout (strip above panels; an author `flexDirection` wins)
/// and an author `gap` is mirrored onto the strip, so the widget lays out
/// as the author wrote it. The minted id namespace is the outer container's
/// author id either way, so the wired graph is identical in both shapes. When children are ALL tabs (panels portaled elsewhere),
/// the container itself stays the tablist. The restructured shape is pinned
/// against axe-core in `hypen-web/tests/a11y.axe.test.ts` and mirrored by
/// `tabs_mixed_children_restructure_into_tab_only_tablist` in
/// `tests/test_a11y_conformance.rs`.
///
/// Deliberately conservative: count mismatch → no wiring and no
/// restructuring (panels may be portaled elsewhere and hand-wired — minting
/// `controls` references to panels that don't exist here would manufacture
/// dangling references, and the conformance pass explains the skip via
/// `TablistWiringSkipped` against the unrestructured shape); no tablist id
/// → no wiring (no deterministic namespace to mint from), but a mixed
/// matched shape is still restructured so the ARIA ownership rule holds.
fn wire_tablist(element: &mut Element) {
    use crate::ir::semantics::{Role, Semantics};

    let role_of = |node: &IRNode| -> Option<Role> {
        node.as_element()
            .and_then(|e| e.semantics.as_ref())
            .and_then(|s| s.role)
    };

    let tab_indices: Vec<usize> = element
        .ir_children
        .iter()
        .enumerate()
        .filter(|(_, c)| role_of(c) == Some(Role::Tab))
        .map(|(i, _)| i)
        .collect();
    let panel_indices: Vec<usize> = element
        .ir_children
        .iter()
        .enumerate()
        .filter(|(_, c)| role_of(c) == Some(Role::Tabpanel))
        .map(|(i, _)| i)
        .collect();

    // All-tabs (panels portaled elsewhere): the container IS the tablist.
    // Mismatch: no wiring and no restructuring — TablistWiringSkipped reads
    // the unrestructured shape to explain why.
    if tab_indices.is_empty()
        || panel_indices.is_empty()
        || tab_indices.len() != panel_indices.len()
    {
        return;
    }

    if let Some(tablist_id) = element.semantics.as_ref().and_then(|s| s.id.clone()) {
        for (pair, (&tab_idx, &panel_idx)) in tab_indices.iter().zip(&panel_indices).enumerate() {
            let tab_id = format!("{tablist_id}-tab-{pair}");
            let panel_id = format!("{tablist_id}-panel-{pair}");

            if let Some(IRNode::Element(tab)) = element.ir_children.get_mut(tab_idx) {
                if let Some(sem) = tab.semantics.as_mut() {
                    sem.id.get_or_insert_with(|| tab_id.clone());
                    sem.controls.get_or_insert_with(|| panel_id.clone());
                }
            }
            if let Some(IRNode::Element(panel)) = element.ir_children.get_mut(panel_idx) {
                if let Some(sem) = panel.semantics.as_mut() {
                    sem.id.get_or_insert_with(|| panel_id.clone());
                    sem.labelledby.get_or_insert_with(|| tab_id.clone());
                }
            }
        }
    }

    // Restructure: tabs move into a synthetic inner tablist at the first
    // tab's position; everything else (panels included) keeps its relative
    // order under the outer container. The inner element carries no id of
    // its own — the outer keeps the author id (a copy would be a DuplicateId)
    // and the minted references never target the tablist element itself.
    let mut tablist = Element::new("Tabs");
    tablist.semantics = Some(Semantics {
        role: Some(Role::Tablist),
        ..Semantics::default()
    });

    // Restructuring must not change how the widget lays out: both hosts
    // default to flex-row on DOM, so untouched the panels would sit BESIDE
    // the tab strip and the author's `.gap` would stop spacing tab from tab.
    // The outer defaults to column (strip above panels — what every tabs UI
    // does) unless the author set a direction, and the author's gap is
    // copied (not moved) onto the strip: tabs keep their pre-restructure
    // spacing, and the outer gap separates strip from panels.
    if !element.props.contains_key("flexDirection.0")
        && !element.props.contains_key("flexDirection")
    {
        element.props.insert(
            "flexDirection.0".to_string(),
            Value::Static(serde_json::json!("column")),
        );
    }
    if let Some(gap) = element.props.get("gap.0").cloned() {
        if !tablist.props.contains_key("gap.0") {
            tablist.props.insert("gap.0".to_string(), gap);
        }
    }

    let mut new_children = Vec::with_capacity(element.ir_children.len() + 1 - tab_indices.len());
    let mut insert_at = None;
    for child in std::mem::take(&mut element.ir_children) {
        if role_of(&child) == Some(Role::Tab) {
            insert_at.get_or_insert(new_children.len());
            tablist.ir_children.push(child);
        } else {
            new_children.push(child);
        }
    }
    new_children.insert(
        insert_at.expect("tab_indices is non-empty"),
        IRNode::Element(tablist),
    );
    element.ir_children = new_children;

    if let Some(sem) = element.semantics.as_mut() {
        sem.role = None;
        if *sem == Semantics::default() {
            element.semantics = None;
        }
    }
}

/// Derive `listitem` for the direct children of an explicit list.
///
/// Deliberately conservative, mirroring [`wire_tablist`]: only *direct*
/// `Element` children, and only those that derive no role of their own — an
/// element with any role (structural or opted-in) has a different job, and
/// content behind control flow (`ForEach`/`When`) is left untouched rather
/// than guessed. Hidden children stay decorative.
fn wire_list_items(element: &mut Element) {
    use crate::ir::semantics::{Role, Semantics};

    for child in &mut element.ir_children {
        let IRNode::Element(item) = child else { continue };
        if item
            .semantics
            .as_ref()
            .is_some_and(|s| s.role.is_some() || s.hidden == Some(true))
        {
            continue;
        }
        item.semantics.get_or_insert_with(Semantics::default).role = Some(Role::Listitem);
    }
}

/// Auto-associate unlabeled form controls with an immediately-preceding
/// static Text sibling.
///
/// The ubiquitous form layout — `Text("Name")` directly followed by an
/// `Input` — is, in the unambiguous case, a label/field pair. Wiring it
/// mints what an author would hand-assemble: the Text gets an `id`, the
/// control gets `labelledby` → that id, **and** the Text's static content
/// becomes the control's `name` (non-explicit), so renderers without an
/// id-reference vocabulary (iOS/Android) still speak the label.
///
/// Deliberately conservative — a wrong auto-label is worse than none:
/// - Only roles that *need* an external label are wired
///   ([`Role::needs_external_label`]); Checkbox/Switch self-label and are
///   never touched.
/// - Only the control's *immediately preceding* element sibling counts, and
///   only when it is a bare `Text` with fully-static content and no other
///   semantic job (a role/label/hidden Text is presumed to have one). A
///   templated Text resolves at reconcile — its value is unknown here, and a
///   stale name is worse than none.
/// - Ids are minted only inside a deterministic namespace: the parent's
///   explicit `.id("signup")` yields `signup-label-<i>`; a Text carrying its
///   own author `.id(...)` is referenced as-is. No parent id and no Text id
///   → no wiring (ids invented without a namespace would not be stable
///   across rebuilds, which is worse than no association).
/// - An author `.label(...)` / `.labelledby(...)` on the control — static
///   or bound — always wins.
/// - The Text's content must pass [`looks_like_label`]: instructional prose
///   ("All fields are required.") meets every structural guard above, and
///   wiring it would both mis-name the control *and* silence
///   `FormControlMissingLabel`. Declining to wire only re-fires that rule,
///   which points the author at an explicit `.label` — false-negative-safe.
fn wire_form_labels(element: &mut Element) {
    use crate::ir::semantics::Semantics;

    if element.ir_children.len() < 2 {
        return;
    }

    let parent_id = element.semantics.as_ref().and_then(|s| s.id.clone());
    let mut minted = 0usize;

    for i in 1..element.ir_children.len() {
        let (left, right) = element.ir_children.split_at_mut(i);
        let Some(IRNode::Element(control)) = right.first_mut() else {
            continue;
        };

        let wirable = control
            .semantics
            .as_ref()
            .and_then(|s| s.role)
            .is_some_and(|r| r.needs_external_label());
        let unlabeled = control
            .semantics
            .as_ref()
            .is_some_and(|s| s.name.is_none() && s.labelledby.is_none());
        // A bound/templated `.label(...)` or `.labelledby(...)` contributes
        // nothing at derive but is author intent resolving at reconcile —
        // never wire over it.
        if !wirable
            || !unlabeled
            || control.props.contains_key("label.0")
            || control.props.contains_key("labelledby.0")
        {
            continue;
        }

        let Some(IRNode::Element(text)) = left.last_mut() else {
            continue;
        };
        if text.element_type != "Text" || !text.ir_children.is_empty() {
            continue;
        }
        // The Text must carry no semantics of its own beyond (possibly) an
        // author `.id(...)` — anything else means it has another job.
        let text_is_plain = match text.semantics.as_ref() {
            None => true,
            Some(s) => {
                *s == Semantics {
                    id: s.id.clone(),
                    ..Semantics::default()
                }
            }
        };
        // A bound/templated `.id(...)` re-resolves at reconcile and would
        // clobber a minted id, leaving the labelledby reference dangling.
        let text_id_deferred = matches!(
            text.props.get("id.0"),
            Some(Value::Binding(_)) | Some(Value::TemplateString { .. })
        );
        if !text_is_plain || text_id_deferred {
            continue;
        }
        let Some(label_text) = static_text(&text.props) else {
            continue;
        };
        // Prose preceding a control satisfies every structural guard above;
        // only its shape gives it away. Declining to wire is always safe —
        // the control stays unlabeled and `FormControlMissingLabel` fires.
        if !looks_like_label(&label_text) {
            continue;
        }

        let text_id = match text.semantics.as_ref().and_then(|s| s.id.clone()) {
            Some(author_id) => author_id,
            None => match &parent_id {
                Some(parent) => {
                    let id = format!("{parent}-label-{minted}");
                    minted += 1;
                    id
                }
                None => continue,
            },
        };

        text.semantics
            .get_or_insert_with(Semantics::default)
            .id
            .get_or_insert_with(|| text_id.clone());
        if let Some(sem) = control.semantics.as_mut() {
            sem.labelledby = Some(text_id);
            // name_explicit stays unset: DOM keeps relying on the labelledby
            // reference (no aria-label), while name-only renderers get the
            // spoken label.
            sem.name = Some(label_text);
        }
    }
}

/// Shape test for auto-association: does this (trimmed) Text content look
/// like a form label rather than prose?
///
/// Labels are short noun phrases ("Email", "Full name:"); prose that happens
/// to precede a control ("All fields are required.") is long, many-worded,
/// or sentence-punctuated. Rejects when the text
/// - exceeds 40 characters, or
/// - has more than 5 whitespace-separated words, or
/// - ends with sentence punctuation (`.`, `!`, `?`) — a trailing `:` is
///   label-like and stays wireable.
///
/// Every rejection is false-negative-safe: an unwired control falls back to
/// `FormControlMissingLabel`, guiding the author to an explicit `.label`.
fn looks_like_label(text: &str) -> bool {
    text.chars().count() <= 40
        && text.split_whitespace().count() <= 5
        && !text.ends_with(['.', '!', '?'])
}

/// A Text element's own fully-static content (`0`/`text` prop), trimmed.
/// `None` for templated, empty, or non-string content.
fn static_text(props: &Props) -> Option<String> {
    for key in ["0", "text"] {
        if let Some(value) = props.get(key) {
            return match value {
                Value::Static(serde_json::Value::String(s)) if !s.trim().is_empty() => {
                    Some(s.trim().to_string())
                }
                _ => None,
            };
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Argument-extraction helpers shared by control-flow converters.
// ---------------------------------------------------------------------------

/// Find the first named argument whose key matches any of `keys`.
fn find_named_arg<'a>(
    args: &'a [hypen_parser::Argument],
    keys: &[&str],
) -> Option<&'a ParserValue> {
    args.iter().find_map(|arg| match arg {
        hypen_parser::Argument::Named { key, value } if keys.contains(&key.as_str()) => Some(value),
        _ => None,
    })
}

/// Return the first positional argument value, if any.
fn first_positional_arg(args: &[hypen_parser::Argument]) -> Option<&ParserValue> {
    args.iter().find_map(|arg| match arg {
        hypen_parser::Argument::Positioned { value, .. } => Some(value),
        _ => None,
    })
}

/// Trim surrounding `"` or `'` from a parser String value.
fn parser_string_unquoted(value: &ParserValue) -> Option<String> {
    if let ParserValue::String(s) = value {
        Some(s.trim_matches(|c: char| c == '"' || c == '\'').to_string())
    } else {
        None
    }
}

/// Convert a parser value into an IR `Binding` if it resolves to one.
fn parser_to_binding(value: &ParserValue) -> Option<Binding> {
    match parser_value_to_ir(value) {
        Value::Binding(b) => Some(b),
        _ => None,
    }
}

/// Build an `__Error` element with `message` set to `msg`.
fn error_element(msg: impl Into<String>) -> IRNode {
    let mut err = Element::new("__Error");
    err.props.insert(
        "message".to_string(),
        Value::Static(serde_json::Value::String(msg.into())),
    );
    IRNode::Element(err)
}

/// Convert ForEach component to IRNode::ForEach
/// Syntax: ForEach(items: @{state.todos}, as: "todo", key: "id") { ... }
fn convert_foreach(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;

    let source = find_named_arg(args, &["items", "in"])
        .or_else(|| first_positional_arg(args))
        .and_then(parser_to_binding);

    let item_name = find_named_arg(args, &["as"])
        .and_then(parser_string_unquoted)
        .unwrap_or_else(|| "item".to_string());

    let key_path = find_named_arg(args, &["key"]).and_then(parser_string_unquoted);

    // Other named args become container props.
    let mut props = Props::new();
    for arg in args {
        if let hypen_parser::Argument::Named { key, value } = arg {
            if !matches!(key.as_str(), "items" | "in" | "as" | "key") {
                props.insert(key.clone(), parser_value_to_ir(value));
            }
        }
    }

    process_applicators(&component.applicators, &mut props, "ForEach");
    let template: Vec<IRNode> = component.children.iter().map(ast_to_ir_node).collect();

    let Some(source) = source else {
        return error_element(
            "ForEach requires an 'items' binding (e.g., ForEach(items: @state.list))",
        );
    };

    IRNode::ForEach {
        source,
        item_name,
        key_path,
        template,
        props,
        module_scope: None,
    }
}

/// Convert List component to a `list` wrapper element with a ForEach IR child.
///
/// This preserves the `list` element type in patches so native renderers
/// (Android LazyColumn, iOS LazyVStack) can do virtualized scrolling,
/// while the engine handles iteration via the ForEach IR semantics.
///
/// Syntax: List(@state.items, key: "id") { ItemView() }
fn convert_list(component: &ComponentSpecification) -> IRNode {
    let element_type = &component.name;
    let args = &component.arguments.arguments;

    let source = find_named_arg(args, &["items", "in"])
        .or_else(|| first_positional_arg(args))
        .and_then(parser_to_binding);

    let item_name = find_named_arg(args, &["as"])
        .and_then(parser_string_unquoted)
        .unwrap_or_else(|| "item".to_string());

    let key_path = find_named_arg(args, &["key"]).and_then(parser_string_unquoted);

    // Pass through other named args (columns, gap, etc.) as props
    // so the renderer can use them for layout configuration.
    let mut extra_props = indexmap::IndexMap::<String, Value>::new();
    for arg in args {
        if let hypen_parser::Argument::Named { key, value } = arg {
            if !matches!(key.as_str(), "items" | "in" | "as" | "key") {
                extra_props.insert(key.clone(), parser_value_to_ir(value));
            }
        }
    }

    let Some(source) = source else {
        return error_element(format!(
            "{element_type} requires an array binding (e.g., {element_type}(@state.items))"
        ));
    };

    // Build the ForEach IR node for iteration
    let template: Vec<IRNode> = component.children.iter().map(ast_to_ir_node).collect();
    let mut foreach_props = Props::new();
    process_applicators(&component.applicators, &mut foreach_props, element_type);

    let foreach_ir = IRNode::ForEach {
        source,
        item_name,
        key_path,
        template,
        props: foreach_props.clone(),
        module_scope: None,
    };

    // Create a wrapper element that contains the ForEach as an IR child.
    // Applicator props (flex, backgroundColor, etc.) go on the wrapper element
    // so the renderer can style the container.
    let mut list_element = Element::new(element_type);
    list_element.span = Some(crate::ir::SourceSpan::from_range(
        &component.metadata.name_range,
    ));
    list_element.expr_span = Some(crate::ir::SourceSpan::from_range(
        &component.metadata.expr_range,
    ));
    // Copy applicator props onto the wrapper (e.g. flex.0, backgroundColor.0)
    for (key, value) in &foreach_props {
        list_element.props.insert(key.clone(), value.clone());
    }
    // Copy extra named args (columns, gap, etc.) as props for the renderer.
    // Use the `.0` suffix convention that applicators use, since renderers
    // expect props like `columns.0` and `gap.0`.
    for (key, value) in &extra_props {
        list_element
            .props
            .insert(format!("{}.0", key), value.clone());
    }
    list_element.ir_children.push(foreach_ir);

    IRNode::Element(list_element)
}

/// Convert When component to IRNode::Conditional
/// Syntax: When(value: @{state.status}) { Case(match: "loading") {...} Else {...} }
fn convert_when(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let condition_value = find_named_arg(args, &["value", "condition"])
        .or_else(|| first_positional_arg(args))
        .map(parser_value_to_ir);

    let mut branches = Vec::new();
    let mut fallback: Option<Vec<IRNode>> = None;

    // Parse children: Case and Else
    for child in &component.children {
        match child.name.as_str() {
            "Case" => {
                let case_args = &child.arguments.arguments;
                let pattern = find_named_arg(case_args, &["match"])
                    .or_else(|| first_positional_arg(case_args))
                    .map(parser_value_to_ir)
                    .unwrap_or(Value::Static(serde_json::Value::Null));

                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                branches.push(ConditionalBranch::new(pattern, children));
            }
            "Else" => {
                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                fallback = Some(children);
            }
            _ => {
                // Non-Case/Else children become part of a default branch
                // This handles the case where When children are direct elements
            }
        }
    }

    let Some(value) = condition_value else {
        return error_element(
            "When requires a 'value' argument (e.g., When(value: @state.status))",
        );
    };

    IRNode::Conditional {
        value,
        branches,
        fallback,
        module_scope: None,
    }
}

/// Convert If component to IRNode::Conditional (syntactic sugar over When with boolean matching)
/// Syntax: If(condition: @{state.loggedIn}) { ... Else { ... } }
fn convert_if(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let condition_value = find_named_arg(args, &["condition", "when"])
        .or_else(|| first_positional_arg(args))
        .map(parser_value_to_ir);

    // Separate then-branch children from Else children
    let mut then_children: Vec<IRNode> = Vec::new();
    let mut else_children: Option<Vec<IRNode>> = None;

    for child in &component.children {
        if child.name == "Else" {
            else_children = Some(child.children.iter().map(ast_to_ir_node).collect());
        } else {
            then_children.push(ast_to_ir_node(child));
        }
    }

    // Create branches: true branch with then_children
    let branches = vec![ConditionalBranch::new(
        Value::Static(serde_json::json!(true)),
        then_children,
    )];

    let Some(value) = condition_value else {
        return error_element(
            "If requires a 'condition' argument (e.g., If(condition: @state.loggedIn))",
        );
    };

    IRNode::Conditional {
        value,
        branches,
        fallback: else_children,
        module_scope: None,
    }
}

/// Convert Router component to IRNode::Router
///
/// Syntax:
/// ```hypen
/// Router {
///     Route(path: "/") { Home() }
///     Route(path: "/users") { Users() }
///     Route.fallback { NotFound() }   // optional
/// }
/// ```
///
/// Optional `Router(value: @{state.x})` overrides the location source —
/// otherwise it defaults to `@{state.location}`.
fn convert_router(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let location = find_named_arg(args, &["value", "location"])
        .map(parser_value_to_ir)
        .unwrap_or_else(|| Value::Binding(Binding::state(vec!["location".to_string()])));

    let mut routes = Vec::new();
    let mut fallback: Option<Vec<IRNode>> = None;

    for child in &component.children {
        match child.name.as_str() {
            "Route" => {
                let route_args = &child.arguments.arguments;
                let path = find_named_arg(route_args, &["path", "0"])
                    .or_else(|| first_positional_arg(route_args))
                    .and_then(parser_string_unquoted);

                let Some(path) = path else {
                    // Skip routes without a path — ideally we'd error, but
                    // we mirror the When/If pattern of being lenient.
                    continue;
                };

                let route_children: Vec<IRNode> =
                    child.children.iter().map(ast_to_ir_node).collect();

                routes.push(RouterRoute::new(path, route_children));
            }
            // Convention for fallback: any non-Route child becomes part of
            // the fallback group. This lets users write `Router { Route(...){}; Else { ... } }`
            // or just leave a bare child as the fallback. Bare-element fallbacks
            // are more user-friendly than requiring a special wrapper.
            "Else" | "Fallback" => {
                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                fallback = Some(children);
            }
            _ => {
                // Anything that isn't a Route or Else inside a Router is treated
                // as part of the implicit fallback. (Useful for `Router { Route(...){...} Text("Loading...") }` style.)
                let extra = ast_to_ir_node(child);
                fallback.get_or_insert_with(Vec::new).push(extra);
            }
        }
    }

    IRNode::Router {
        location,
        routes,
        fallback,
        module_scope: None,
    }
}

/// Convert parser Value to engine Value
pub(crate) fn parser_value_to_ir(value: &ParserValue) -> Value {
    match value {
        ParserValue::String(s) => {
            // Remove surrounding quotes if present
            let trimmed = s.trim_matches(|c: char| c == '"' || c == '\'');

            // Check if it's a pure binding (entire string is @{state.xxx} or @{item.xxx})
            if trimmed.starts_with("@{")
                && trimmed.ends_with('}')
                && !trimmed[2..trimmed.len() - 1].contains("@{")
            {
                // Try to parse as a simple binding first
                match parse_binding(trimmed) {
                    Some(binding) => Value::Binding(binding),
                    None => {
                        // Not a simple binding - might be an expression like @{state.active ? 'a' : 'b'}
                        // Extract bindings from the expression for dependency tracking
                        let bindings = extract_bindings_from_template(trimmed).unwrap_or_default();
                        Value::TemplateString {
                            template: trimmed.to_string(),
                            bindings,
                        }
                    }
                }
            } else if let Some(action_ref) = trimmed.strip_prefix("@actions.") {
                // @actions.xxx → action name
                Value::Action(action_ref.to_string())
            } else if let Some(router_method) = trimmed.strip_prefix("@router.") {
                // @router.{push|back|replace|forward} — first-class navigation
                // primitive. The `router.` namespace is reserved; the SDK's
                // `ManagedRouter` registers the handlers on `start()`. Stored
                // as a regular `Value::Action` with the namespace preserved in
                // the action name ("router.push") so the renderer dispatches
                // to the reserved slot without any special casing.
                Value::Action(format!("router.{}", router_method))
            } else if trimmed.contains("@{") {
                // Template string with embedded expressions or bindings
                // Extract any simple bindings we can find
                let bindings = extract_bindings_from_template(trimmed).unwrap_or_default();
                Value::TemplateString {
                    template: trimmed.to_string(),
                    bindings,
                }
            } else {
                Value::Static(serde_json::Value::String(trimmed.to_string()))
            }
        }
        ParserValue::Number(n) => Value::Static(serde_json::json!(*n)),
        ParserValue::Boolean(b) => Value::Static(serde_json::json!(*b)),
        ParserValue::List(items) => {
            let converted: Vec<serde_json::Value> = items
                .iter()
                .map(|v| match parser_value_to_ir(v) {
                    Value::Static(val) => val,
                    Value::Binding(binding) => {
                        serde_json::json!(format!("@{{{}}}", binding.full_path()))
                    }
                    Value::TemplateString { template, .. } => serde_json::json!(template),
                    Value::Action(s) => serde_json::json!(format!("@{}", s)),
                    Value::Resource(s) => serde_json::json!(format!("@resources.{}", s)),
                    // Unreachable: parser_value_to_ir never produces a
                    // StateSwitch — it only exists via `.states` lowering.
                    Value::StateSwitch { .. } => serde_json::Value::Null,
                })
                .collect();
            Value::Static(serde_json::json!(converted))
        }
        ParserValue::Map(map) => {
            let mut json_map = serde_json::Map::new();
            for (k, v) in map {
                // Handle all value types, not just Static values
                // This preserves bindings like @{item.id} inside maps
                match parser_value_to_ir(v) {
                    Value::Static(val) => {
                        json_map.insert(k.clone(), val);
                    }
                    Value::Binding(binding) => {
                        // Preserve binding as a string representation for later resolution
                        json_map.insert(
                            k.clone(),
                            serde_json::json!(format!("@{{{}}}", binding.full_path_with_source())),
                        );
                    }
                    Value::TemplateString { template, .. } => {
                        json_map.insert(k.clone(), serde_json::json!(template));
                    }
                    Value::Action(s) => {
                        json_map.insert(k.clone(), serde_json::json!(format!("@actions.{}", s)));
                    }
                    Value::Resource(s) => {
                        json_map.insert(k.clone(), serde_json::json!(format!("@resources.{}", s)));
                    }
                    // Unreachable: parser_value_to_ir never produces a
                    // StateSwitch — it only exists via `.states` lowering.
                    Value::StateSwitch { .. } => {}
                }
            }
            Value::Static(serde_json::Value::Object(json_map))
        }
        ParserValue::Reference(ref_str) => {
            // References like @state.user, @actions.login, @item, @item.name, @spacetime.messages
            if ref_str.starts_with("state.") || ref_str.starts_with("item.") || ref_str == "item" {
                // Parse as binding, wrapping in @{}
                let binding_str = format!("@{{{}}}", ref_str);
                match parse_binding(&binding_str) {
                    Some(binding) => Value::Binding(binding),
                    None => Value::Static(serde_json::Value::String(ref_str.clone())),
                }
            } else if let Some(action_name) = ref_str.strip_prefix("actions.") {
                Value::Action(action_name.to_string())
            } else if let Some(router_method) = ref_str.strip_prefix("router.") {
                // `@router.push` / `@router.back` / `@router.replace` /
                // `@router.forward` — reserved navigation namespace. Stored
                // under the original "router.<method>" name so the SDK-side
                // `ManagedRouter.start()` can pre-register the handlers in
                // one place without engine-side special casing.
                Value::Action(format!("router.{}", router_method))
            } else if let Some(resource_name) = ref_str.strip_prefix("resources.") {
                Value::Resource(resource_name.to_string())
            } else if let Some(dot_pos) = ref_str.find('.') {
                // @provider.path → data source binding (e.g., @spacetime.messages)
                let provider = &ref_str[..dot_pos];
                let path: Vec<String> = ref_str[dot_pos + 1..]
                    .split('.')
                    .map(|s| s.to_string())
                    .collect();
                Value::Binding(Binding::data_source(provider, path))
            } else {
                Value::Static(serde_json::Value::String(ref_str.clone()))
            }
        }
        ParserValue::DataSourceReference(ref_str) => {
            // DEPRECATED: DataSourceReference is no longer produced by the parser.
            // Data sources now use @provider.path via Reference.
            // Kept for backward compatibility with serialized ASTs.
            if let Some(dot_pos) = ref_str.find('.') {
                let provider = &ref_str[..dot_pos];
                let path: Vec<String> = ref_str[dot_pos + 1..]
                    .split('.')
                    .map(|s| s.to_string())
                    .collect();
                Value::Binding(Binding::data_source(provider, path))
            } else {
                Value::Static(serde_json::Value::String(ref_str.clone()))
            }
        }
    }
}

/// Recursively set `module_scope` on an element and all its descendants.
///
/// Called during AST→IR conversion when the source is `module X { ... }`,
/// and from `ComponentRegistry::expand_ir_node_with_context` when expanding
/// a registered module-typed component into a tree.
pub(crate) fn propagate_module_scope_element(element: &mut Element, scope: &str) {
    element.module_scope = Some(scope.to_string());
    for ir_child in &mut element.ir_children {
        propagate_module_scope_ir_node(ir_child, scope);
    }
}

/// Recursively set `module_scope` on every Element inside an IRNode tree,
/// including ForEach/Conditional/Router control-flow nodes.
pub(crate) fn propagate_module_scope_ir_node(node: &mut IRNode, scope: &str) {
    crate::ir::walk::walk_ir_mut(node, &mut |n| match n {
        IRNode::Element(el) => el.module_scope = Some(scope.to_string()),
        IRNode::ForEach { module_scope, .. }
        | IRNode::Conditional { module_scope, .. }
        | IRNode::Router { module_scope, .. } => {
            *module_scope = Some(scope.to_string());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_parser::parse_component;

    /// Helper: parse → ast_to_ir_node → unwrap Element
    fn parse_to_element(input: &str) -> Element {
        let component = parse_component(input).unwrap();
        match ast_to_ir_node(&component) {
            IRNode::Element(e) => e,
            other => panic!("Expected Element, got {:?}", other),
        }
    }

    #[test]
    fn looks_like_label_thresholds() {
        // Label-shaped: short, few words, no sentence punctuation.
        assert!(looks_like_label("Email"));
        assert!(looks_like_label("Email:"));
        assert!(looks_like_label("Full legal name"));
        assert!(looks_like_label("One two three four five")); // 5 words: boundary in
        assert!(looks_like_label(&"x".repeat(40))); // 40 chars: boundary in

        // Prose-shaped: any single threshold rejects.
        assert!(!looks_like_label("All fields are required."));
        assert!(!looks_like_label("Required!"));
        assert!(!looks_like_label("What is your name?"));
        assert!(!looks_like_label("One two three four five six")); // 6 words
        assert!(!looks_like_label(&"x".repeat(41))); // 41 chars
    }

    #[test]
    fn test_simple_conversion() {
        let input = r#"Text("Hello World")"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Text");
        assert_eq!(element.props.len(), 1);
    }

    #[test]
    fn test_binding_conversion() {
        let input = r#"Text("@{state.user.name}")"#;
        let element = parse_to_element(input);

        // Check that binding was parsed correctly
        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::Binding(binding) => {
                assert_eq!(binding.path, vec!["user", "name"]);
                assert_eq!(binding.full_path(), "user.name");
            }
            _ => panic!("Expected binding, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_children_conversion() {
        let input = r#"
            Column {
                Text("First")
                Text("Second")
            }
        "#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Column");
        assert_eq!(element.ir_children.len(), 2);
        assert!(matches!(&element.ir_children[0], IRNode::Element(e) if e.element_type == "Text"));
        assert!(matches!(&element.ir_children[1], IRNode::Element(e) if e.element_type == "Text"));
    }

    #[test]
    fn test_onclick_applicator_conversion() {
        let input = r#"Text("Click me").onClick("@actions.increment")"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Text");
        // onClick should now be in props, not events
        assert!(element.props.contains_key("onClick.0"));
    }

    #[test]
    fn test_button_onclick_argument() {
        let input = r#"Button(onClick: "@actions.submit") { Text("Submit") }"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Button");
        // onClick argument should be in props
        assert!(element.props.contains_key("onClick"));
        // Should have one child
        assert_eq!(element.ir_children.len(), 1);
    }

    #[test]
    fn test_template_string_conversion() {
        let input = r#"Text("Count: @{state.count}")"#;
        let element = parse_to_element(input);

        // Check that template string was parsed correctly
        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "Count: @{state.count}");
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].full_path(), "count");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_template_string_multiple_bindings() {
        let input = r#"Text("Hello @{state.user.name}, you have @{state.count} messages")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(
                    template,
                    "Hello @{state.user.name}, you have @{state.count} messages"
                );
                assert_eq!(bindings.len(), 2);
                assert_eq!(bindings[0].full_path(), "user.name");
                assert_eq!(bindings[1].full_path(), "count");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_static_string_no_bindings() {
        let input = r#"Text("Hello World")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::Static(val) => {
                assert_eq!(val.as_str().unwrap(), "Hello World");
            }
            _ => panic!("Expected Static, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_item_reference_conversion() {
        // Test @item.name reference syntax
        let input = r#"Text(text: @item.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("text").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert_eq!(binding.path, vec!["name"]);
                assert_eq!(binding.full_path(), "name");
                assert_eq!(binding.full_path_with_source(), "item.name");
            }
            _ => panic!("Expected item Binding, got: {:?}", text_prop),
        }
    }

    #[test]
    fn test_item_reference_nested_path() {
        // Test @item.user.profile.name reference syntax
        let input = r#"Text(text: @item.user.profile.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("text").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert_eq!(binding.path, vec!["user", "profile", "name"]);
                assert_eq!(binding.full_path(), "user.profile.name");
            }
            _ => panic!("Expected item Binding, got: {:?}", text_prop),
        }
    }

    #[test]
    fn test_bare_item_reference() {
        // Test @item reference (the whole item object)
        let input = r#"Component(data: @item)"#;
        let element = parse_to_element(input);

        let data_prop = element.props.get("data").unwrap();
        match data_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert!(
                    binding.path.is_empty(),
                    "Path should be empty for bare @item"
                );
                assert_eq!(binding.full_path_with_source(), "item");
            }
            _ => panic!("Expected item Binding, got: {:?}", data_prop),
        }
    }

    #[test]
    fn test_item_binding_in_template_string() {
        // Test @{item.name} in a template string
        let input = r#"Text("Hello @{item.name}!")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "Hello @{item.name}!");
                assert_eq!(bindings.len(), 1);
                assert!(bindings[0].is_item(), "Should be an item binding");
                assert_eq!(bindings[0].full_path(), "name");
            }
            _ => panic!(
                "Expected TemplateString with item binding, got: {:?}",
                first_prop
            ),
        }
    }

    #[test]
    fn test_mixed_state_and_item_bindings() {
        // Test template with both @{state.xxx} and @{item.xxx}
        let input = r#"Text("@{state.prefix}: @{item.name}")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "@{state.prefix}: @{item.name}");
                assert_eq!(bindings.len(), 2);
                assert!(bindings[0].is_state(), "First should be state binding");
                assert_eq!(bindings[0].full_path(), "prefix");
                assert!(bindings[1].is_item(), "Second should be item binding");
                assert_eq!(bindings[1].full_path(), "name");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_tw_applicator_expansion() {
        // Test that .tw() applicator expands to CSS properties with .0 suffix
        let input = r#"Text("Hello").tw("p-4 text-blue-500")"#;
        let element = parse_to_element(input);

        // Should have expanded padding and color (with .0 suffix, camelCase)
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );
        assert!(
            element.props.contains_key("color.0"),
            "Should have color.0 prop"
        );

        // Check padding value
        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "1rem");
        } else {
            panic!("Expected static padding value");
        }

        // Check color value
        if let Value::Static(val) = element.props.get("color.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#3b82f6");
        } else {
            panic!("Expected static color value");
        }
    }

    #[test]
    fn test_tw_applicator_with_variants() {
        // Test that .tw() applicator handles responsive variants
        let input = r#"Text("Hello").tw("p-4 md:p-8 hover:bg-white")"#;
        let element = parse_to_element(input);

        // Should have base padding (with .0 suffix)
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );

        // Should have variant properties (camelCase + variant + .0)
        assert!(
            element.props.contains_key("padding@md.0"),
            "Should have padding@md.0 prop"
        );
        assert!(
            element.props.contains_key("backgroundColor:hover.0"),
            "Should have backgroundColor:hover.0 prop"
        );

        // Check values
        if let Value::Static(val) = element.props.get("padding@md.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "2rem");
        }
        if let Value::Static(val) = element.props.get("backgroundColor:hover.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#ffffff");
        }
    }

    #[test]
    fn test_responsive_object_applicator_expands_to_breakpoint_props() {
        // `.gridColumns({default: 2, md: 3, lg: 4})` must expand into the
        // same `name@bp.0` suffix props tailwind `md:` classes produce, so
        // every renderer resolves it — instead of one opaque object prop.
        let input = r#"Column {}.gridColumns({default: 2, md: 3, lg: 4})"#;
        let element = parse_to_element(input);
        let get = |k: &str| match element.props.get(k) {
            Some(Value::Static(v)) => v.as_f64(),
            _ => None,
        };
        assert_eq!(get("gridColumns.0"), Some(2.0), "default → unsuffixed base key");
        assert_eq!(get("gridColumns@md.0"), Some(3.0));
        assert_eq!(get("gridColumns@lg.0"), Some(4.0));
    }

    #[test]
    fn test_non_breakpoint_object_applicator_is_not_expanded() {
        // A composite-value object (not all-breakpoint keys) stays a single
        // prop — must not be mistaken for a responsive object.
        let input = r#"Column {}.size({width: 10, height: 20})"#;
        let element = parse_to_element(input);
        assert!(
            matches!(
                element.props.get("size.0"),
                Some(Value::Static(serde_json::Value::Object(_)))
            ),
            "composite {{width,height}} object passes through intact",
        );
        assert!(element.props.get("size@md.0").is_none());
    }

    #[test]
    fn test_tw_applicator_visual_regressions() {
        let input = r#"Column {}.tw("bg-gradient-to-br from-indigo-950 via-slate-900 to-fuchsia-950 bg-white/10 border-white/10 shadow-xl shadow-2xl opacity-60 backdrop-blur-[18px]")"#;
        let element = parse_to_element(input);

        let expected = [
            (
                "backgroundImage.0",
                "linear-gradient(to bottom right, #1e1b4b, #0f172a, #4a044e)",
            ),
            ("backgroundColor.0", "rgba(255, 255, 255, 0.1)"),
            ("borderColor.0", "rgba(255, 255, 255, 0.1)"),
            ("boxShadow.0", "0 25px 50px -12px rgb(0 0 0 / 0.25)"),
            ("opacity.0", "0.6"),
            ("backdropFilter.0", "blur(18px)"),
        ];

        for (key, value) in expected {
            match element.props.get(key) {
                Some(Value::Static(actual)) => assert_eq!(actual.as_str().unwrap(), value),
                other => panic!("Expected static prop {key}, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_value_map_variant_breakpoints() {
        // .padding({ default: 8, md: 16 }) lowers to padding.0 + padding@md.0
        let input = r#"Text("Hi").padding({default: 8, md: 16})"#;
        let element = parse_to_element(input);

        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );
        assert!(
            element.props.contains_key("padding@md.0"),
            "Should have padding@md.0 prop"
        );

        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_f64().unwrap(), 8.0);
        } else {
            panic!("expected static padding.0");
        }
        if let Value::Static(val) = element.props.get("padding@md.0").unwrap() {
            assert_eq!(val.as_f64().unwrap(), 16.0);
        } else {
            panic!("expected static padding@md.0");
        }
    }

    #[test]
    fn test_value_map_variant_props_are_ordered_by_precedence() {
        // The parser hands the map over as a HashMap, so emit order has to be
        // imposed by the engine: default, breakpoints ascending, then states.
        // The DOM renderer appends one equal-specificity rule per variant and
        // lets the cascade pick the last match, so an arbitrary order would
        // let `sm` beat `lg` on a wide window — differently on each run.
        let input = r#"Box {}.background({xl: "e", default: "a", hover: "f", md: "c", sm: "b", lg: "d"})"#;
        let element = parse_to_element(input);

        let order: Vec<&str> = element
            .props
            .keys()
            .map(|k| k.as_str())
            .filter(|k| k.starts_with("background"))
            .collect();
        assert_eq!(
            order,
            vec![
                "background.0",
                "background@sm.0",
                "background@md.0",
                "background@lg.0",
                "background@xl.0",
                "background:hover.0",
            ],
        );
    }

    #[test]
    fn test_value_map_variant_state() {
        // .backgroundColor({ default: "red", hover: "blue" })
        let input = r#"Box {}.backgroundColor({default: "red", hover: "blue"})"#;
        let element = parse_to_element(input);

        assert!(
            element.props.contains_key("backgroundColor.0"),
            "Should have backgroundColor.0 prop"
        );
        assert!(
            element.props.contains_key("backgroundColor:hover.0"),
            "Should have backgroundColor:hover.0 prop"
        );

        if let Value::Static(val) = element.props.get("backgroundColor:hover.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "blue");
        } else {
            panic!("expected static backgroundColor:hover.0");
        }
    }

    #[test]
    fn test_value_map_variant_preserves_binding() {
        // Bindings inside a variant map value must survive lowering.
        let input = r#"Text("Hi").padding({default: 8, md: "@{state.gap}"})"#;
        let element = parse_to_element(input);

        assert!(element.props.contains_key("padding@md.0"));
        assert!(
            matches!(
                element.props.get("padding@md.0").unwrap(),
                Value::Binding(_)
            ),
            "binding inside variant map should be preserved"
        );
    }

    #[test]
    fn test_non_variant_map_is_passthrough() {
        // A map whose keys are NOT all variant tokens must NOT be hijacked;
        // it falls through to default applicator handling as a single .0 prop.
        let input = r#"Box {}.gradient({from: "red", to: "blue"})"#;
        let element = parse_to_element(input);

        // Default handling: single positional arg -> "gradient.0" holding a map.
        assert!(
            element.props.contains_key("gradient.0"),
            "non-variant map should remain a single gradient.0 prop"
        );
        // And it must NOT have produced variant-suffixed keys.
        assert!(!element.props.contains_key("gradient@from.0"));
        assert!(!element.props.contains_key("gradient:to.0"));
    }

    #[test]
    fn test_named_arg_applicator_unaffected() {
        // .padding(top: 8) is a Named arg, not a Map; must stay padding.top.
        let input = r#"Text("Hi").padding(top: 8)"#;
        let element = parse_to_element(input);
        assert!(
            element.props.contains_key("padding.top"),
            "named-arg applicator must remain padding.top"
        );
        assert!(!element.props.contains_key("padding.0"));
    }

    #[test]
    fn test_tw_mixed_with_other_applicators() {
        // Test .tw() combined with other applicators
        let input = r#"Text("Hello").tw("p-4").fontSize(18)"#;
        let element = parse_to_element(input);

        // Should have expanded tailwind (with .0 suffix, same as regular applicators)
        assert!(element.props.contains_key("padding.0"));

        // Should also have regular applicator
        assert!(element.props.contains_key("fontSize.0"));
    }

    #[test]
    fn test_css_to_camel_case() {
        assert_eq!(
            super::css_to_camel_case("background-color"),
            "backgroundColor"
        );
        assert_eq!(super::css_to_camel_case("align-items"), "alignItems");
        assert_eq!(
            super::css_to_camel_case("justify-content"),
            "justifyContent"
        );
        assert_eq!(super::css_to_camel_case("max-width"), "maxWidth");
        assert_eq!(
            super::css_to_camel_case("border-top-left-radius"),
            "borderTopLeftRadius"
        );
        // No hyphens → unchanged
        assert_eq!(super::css_to_camel_case("padding"), "padding");
        assert_eq!(super::css_to_camel_case("color"), "color");
    }

    #[test]
    fn test_tw_full_class_set() {
        // Test the exact class set from the user's issue
        let input =
            r#"Column {}.tw("p-6 items-center justify-center w-full h-full bg-black text-white")"#;
        let element = parse_to_element(input);

        // All props should be camelCase with .0 suffix
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0"
        );
        assert!(
            element.props.contains_key("alignItems.0"),
            "Should have alignItems.0"
        );
        assert!(
            element.props.contains_key("justifyContent.0"),
            "Should have justifyContent.0"
        );
        assert!(element.props.contains_key("width.0"), "Should have width.0");
        assert!(
            element.props.contains_key("height.0"),
            "Should have height.0"
        );
        assert!(
            element.props.contains_key("backgroundColor.0"),
            "Should have backgroundColor.0"
        );
        assert!(element.props.contains_key("color.0"), "Should have color.0");

        // Check values
        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "1.5rem");
        }
        if let Value::Static(val) = element.props.get("backgroundColor.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#000000");
        }
        if let Value::Static(val) = element.props.get("color.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#ffffff");
        }
        if let Value::Static(val) = element.props.get("width.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "100%");
        }
        if let Value::Static(val) = element.props.get("height.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "100%");
        }
    }

    #[test]
    fn test_bind_applicator_expansion() {
        let input = r#"Input(placeholder: "Type...").bind(@state.message)"#;
        let element = parse_to_element(input);

        // Should have "value" as a binding
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "message");
            }
            _ => panic!("Expected binding for value prop"),
        }

        // Should have "bind" with the state path string
        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "message"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_applicator_nested_path() {
        let input = r#"Input(placeholder: "Email").bind(@state.user.email)"#;
        let element = parse_to_element(input);

        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "user.email");
            }
            _ => panic!("Expected binding for value prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "user.email"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_applicator_item_binding_ignored() {
        // .bind(@item.x) should NOT produce bind props (can't write back to iteration items)
        let input = r#"Input(placeholder: "Name").bind(@item.name)"#;
        let element = parse_to_element(input);

        assert!(
            !element.props.contains_key("bind"),
            "Item bindings should not produce bind prop"
        );
        assert!(
            !element.props.contains_key("value"),
            "Item bindings should not produce value prop"
        );
    }

    #[test]
    fn test_bind_applicator_in_ir_node() {
        // Test that bind works through ast_to_ir_node too
        let input = r#"Textarea(placeholder: "Message").bind(@state.msg)"#;
        let component = parse_component(input).unwrap();
        let ir_node = ast_to_ir_node(&component);

        match ir_node {
            IRNode::Element(element) => {
                match element.props.get("value").unwrap() {
                    Value::Binding(binding) => {
                        assert!(binding.is_state());
                        assert_eq!(binding.full_path(), "msg");
                    }
                    _ => panic!("Expected binding for value prop"),
                }
                match element.props.get("bind").unwrap() {
                    Value::Static(val) => assert_eq!(val.as_str().unwrap(), "msg"),
                    _ => panic!("Expected static string for bind prop"),
                }
            }
            _ => panic!("Expected Element IRNode"),
        }
    }

    #[test]
    fn test_bind_checkbox_uses_checked_prop() {
        let input = r#"Checkbox(label: "Accept").bind(@state.accepted)"#;
        let element = parse_to_element(input);

        // Should have "checked" (not "value") as a binding
        assert!(
            !element.props.contains_key("value"),
            "Checkbox bind should not set value prop"
        );
        match element.props.get("checked").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "accepted");
            }
            _ => panic!("Expected binding for checked prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "accepted"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_switch_uses_on_prop() {
        let input = r#"Switch(label: "Dark mode").bind(@state.darkMode)"#;
        let element = parse_to_element(input);

        // Should have "on" (not "value") as a binding
        assert!(
            !element.props.contains_key("value"),
            "Switch bind should not set value prop"
        );
        match element.props.get("on").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "darkMode");
            }
            _ => panic!("Expected binding for on prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "darkMode"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_select_uses_value_prop() {
        let input = r#"Select(options: ["a", "b"]).bind(@state.selected)"#;
        let element = parse_to_element(input);

        // Select should use "value" prop
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "selected");
            }
            _ => panic!("Expected binding for value prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "selected"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    // ── @datasource.path reference tests ─────────────────────────────────

    #[test]
    fn test_at_data_source_reference_simple() {
        // @spacetime.messages should produce a Binding::DataSource
        let input = r#"Text(data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        match element.props.get("data").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["messages"]);
                assert_eq!(binding.full_path_with_source(), "spacetime.messages");
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_at_data_source_reference_nested_path() {
        // @firebase.user.profile.name should produce a nested DataSource binding
        let input = r#"Text(@firebase.user.profile.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("0").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("firebase"));
                assert_eq!(binding.path, vec!["user", "profile", "name"]);
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_data_source_uses_at_prefix() {
        // @spacetime.messages should produce a DataSource binding
        let input = r#"Text(data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        let binding = match element.props.get("data").unwrap() {
            Value::Binding(b) => b,
            other => panic!("Expected binding from @, got: {:?}", other),
        };

        assert!(binding.is_data_source());
        assert_eq!(binding.provider(), Some("spacetime"));
        assert_eq!(binding.path, vec!["messages"]);
    }

    #[test]
    fn test_at_data_source_mixed_with_state() {
        // @state.count and @spacetime.messages in the same component
        let input = r#"Text(count: @state.count, data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        match element.props.get("count").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "count");
            }
            other => panic!("Expected state binding, got: {:?}", other),
        }

        match element.props.get("data").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["messages"]);
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_at_actions_data_source_method() {
        // @actions.spacetime.sendMessage should produce Action("spacetime.sendMessage")
        let input = r#"Button(onClick: @actions.spacetime.sendMessage)"#;
        let element = parse_to_element(input);

        match element.props.get("onClick").unwrap() {
            Value::Action(action_name) => {
                assert_eq!(action_name, "spacetime.sendMessage");
            }
            other => panic!("Expected Action, got: {:?}", other),
        }
    }

    #[test]
    fn test_bind_data_source_reference() {
        // .bind(@spacetime.selectedId) should work like .bind(@state.x) but with data source
        let input = r#"Input(placeholder: "Search").bind(@spacetime.selectedId)"#;
        let element = parse_to_element(input);

        // Should have "value" as a data source binding
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["selectedId"]);
            }
            other => panic!(
                "Expected DataSource binding for value prop, got: {:?}",
                other
            ),
        }

        // Should have "bind" with the full data source path
        match element.props.get("bind").unwrap() {
            Value::Static(val) => {
                assert_eq!(val.as_str().unwrap(), "spacetime.selectedId");
            }
            other => panic!("Expected static string for bind prop, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_conversion() {
        let input = r#"Icon(@resources.heart)"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Icon");
        match element.props.get("0").unwrap() {
            Value::Resource(name) => assert_eq!(name, "heart"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_hyphenated_conversion() {
        let input = r#"Icon(@resources.plus-square)"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Icon");
        match element.props.get("0").unwrap() {
            Value::Resource(name) => assert_eq!(name, "plus-square"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_named_arg() {
        let input = r#"Icon(name: @resources.search)"#;
        let element = parse_to_element(input);

        match element.props.get("name").unwrap() {
            Value::Resource(name) => assert_eq!(name, "search"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    // ---------------------------------------------------------------
    // @router namespace — first-class navigation primitive. Reserved
    // action name "router.<method>" is routed to the SDK's
    // ManagedRouter at `start()` time; users don't register it.
    // ---------------------------------------------------------------

    #[test]
    fn test_router_push_reference() {
        let input = r#"Button(text: "Go").onClick(@router.push, to: "/profile")"#;
        let element = parse_to_element(input);

        // Applicator pipeline namespaces prop keys as `onClick.0`,
        // `onClick.to`.
        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.push"),
            other => panic!("Expected Value::Action(\"router.push\"), got: {:?}", other),
        }

        match element.props.get("onClick.to").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "/profile"),
            other => panic!("Expected Value::Static(/profile), got: {:?}", other),
        }
    }

    #[test]
    fn test_router_back_reference_no_payload() {
        let input = r#"Button(text: "Back").onClick(@router.back)"#;
        let element = parse_to_element(input);

        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.back"),
            other => panic!("Expected Value::Action(\"router.back\"), got: {:?}", other),
        }
    }

    #[test]
    fn test_router_replace_quoted_string_form() {
        // Quoted form: `.onClick("@router.replace")` — must resolve to
        // the same Value::Action as the bare-reference form.
        let input = r#"Button(text: "R").onClick("@router.replace", to: "/x")"#;
        let element = parse_to_element(input);

        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.replace"),
            other => panic!(
                "Expected Value::Action(\"router.replace\"), got: {:?}",
                other
            ),
        }
    }
}
