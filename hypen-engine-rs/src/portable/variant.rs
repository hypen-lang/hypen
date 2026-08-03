//! Responsive / interaction-state variant prop key parsing and resolution.
//!
//! This is the single canonical implementation of the variant prop-key
//! contract that every renderer (DOM, Canvas, iOS/SwiftUI, Android/Compose,
//! desktop) must follow. Like the rest of [`crate::portable`], every function
//! here is pure (strings in, strings/structs out — no I/O, no clocks).
//!
//! # Canonical prop key format
//!
//! ```text
//! <camelBase><variant?><argSuffix>
//! ```
//!
//! * `camelBase` — camelCase applicator name, e.g. `padding`, `backgroundColor`.
//! * `variant` (optional) — `@<bp>` and/or `:<state>`, in that order when
//!   combined. `bp` is one of `sm`/`md`/`lg`/`xl`/`2xl`; `state` is one of
//!   `hover`/`focus`/`active`/`disabled`/`focus-visible`/`focus-within`.
//!   A combined key like `backgroundColor@md:hover` applies only when BOTH the
//!   breakpoint is active (viewport width >= its min-width) AND the state is
//!   active.
//! * `argSuffix` — `.<index>` (almost always `.0`) or `.<name>` for named args.
//!
//! Examples emitted by the engine: `padding.0`, `padding@md.0`,
//! `backgroundColor:hover.0`, `backgroundColor@md:hover.0`, `padding.top`.
//!
//! Note the variant marker sits *between* the base and the trailing `.arg`
//! suffix. A lookup that forgets the `.arg` suffix (e.g. building `padding@md`
//! and looking it up directly) will MISS the real key `padding@md.0`. The fix
//! is [`pick_variant_base`], which returns the *variant-decorated base without
//! the arg suffix* so callers can feed it to their existing prop getters that
//! append `.0` themselves.
//!
//! # Resolution precedence (lowest to highest; later overrides earlier)
//!
//! ```text
//! base
//!   < breakpoints in ascending min-width order (sm<md<lg<xl<2xl, only those
//!     whose min-width <= current width)
//!   < disabled < hover < focus < active
//! ```
//!
//! This mirrors the iOS reference in
//! `hypen-renderer-swift/Sources/HypenSwift/Render/VariantSupport.swift`
//! (`StateAwareModifier.computeEffectiveModifier`).

/// Breakpoint tokens paired with their min-width in CSS pixels, in ascending
/// order. This ordering is load-bearing: breakpoint precedence follows it.
pub const BREAKPOINTS: &[(&str, f32)] = &[
    ("sm", 640.0),
    ("md", 768.0),
    ("lg", 1024.0),
    ("xl", 1280.0),
    ("2xl", 1536.0),
];

/// Interaction-state tokens, in ascending precedence order (later overrides
/// earlier). `focus-visible` / `focus-within` are recognised tokens but are
/// not assigned a distinct precedence slot here — they sort after the named
/// `disabled`/`hover`/`focus`/`active` ladder; renderers that distinguish them
/// can apply their own ordering. The four primary states follow the iOS
/// reference: disabled < hover < focus < active.
pub const STATES: &[&str] = &[
    "disabled",
    "hover",
    "focus",
    "active",
    "focus-visible",
    "focus-within",
];

/// The literal key meaning "base" (no variant) in a value-map form, e.g.
/// `.padding({ default: 8, md: 16 })`.
pub const DEFAULT_KEY: &str = "default";

/// True if `tok` is a known breakpoint token (`sm`/`md`/`lg`/`xl`/`2xl`).
pub fn is_breakpoint(tok: &str) -> bool {
    BREAKPOINTS.iter().any(|(name, _)| *name == tok)
}

/// True if `tok` is a known interaction-state token.
pub fn is_state(tok: &str) -> bool {
    STATES.contains(&tok)
}

/// Min-width (CSS px) at which `bp` becomes active, or `None` if not a
/// breakpoint token.
pub fn breakpoint_min_width(bp: &str) -> Option<f32> {
    BREAKPOINTS
        .iter()
        .find(|(name, _)| *name == bp)
        .map(|(_, w)| *w)
}

/// True if `tok` is a variant token usable as a key in a value-map applicator:
/// the literal `default`, a breakpoint, or a state.
pub fn is_variant_token(tok: &str) -> bool {
    tok == DEFAULT_KEY || is_breakpoint(tok) || is_state(tok)
}

/// Precedence rank for a state token. Higher wins. Used only to order states
/// against each other; breakpoints are always ranked below any state.
fn state_rank(state: &str) -> u32 {
    match state {
        "disabled" => 1,
        "hover" => 2,
        // focus-visible / focus-within are focus-flavoured states; they sit at
        // the same precedence slot as `focus` rather than above `active` (the
        // primary ladder is disabled < hover < focus < active).
        "focus" | "focus-visible" | "focus-within" => 3,
        "active" => 4,
        _ => 0,
    }
}

/// A parsed prop key, split into its base, optional variant markers, and
/// optional arg suffix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedKey {
    /// camelCase applicator base, e.g. `padding`, `backgroundColor`.
    pub base: String,
    /// Breakpoint token (`md`, `lg`, …) if the key carried an `@bp` marker.
    pub breakpoint: Option<String>,
    /// State token (`hover`, `focus`, …) if the key carried a `:state` marker.
    pub state: Option<String>,
    /// Arg suffix after the trailing `.`, e.g. `0` for `padding.0`, or `top`
    /// for the named-arg key `padding.top`. `None` when the key has no `.`.
    pub arg: Option<String>,
}

/// Parse a raw prop key into its components.
///
/// Handles every shape:
/// * plain `padding.0`
/// * responsive `padding@md.0`
/// * state `backgroundColor:hover.0`
/// * combined `backgroundColor@md:hover.0`
/// * named-arg `padding.top` (no variant)
/// * bare `padding` (no arg)
///
/// `@` and `:` only act as variant markers, and they appear before the trailing
/// `.arg` suffix. The arg suffix is split off first (everything after the last
/// `.`), then the remaining head is split on `@` / `:`. Keys never contain
/// values, so there is no ambiguity with `:` inside a value.
pub fn parse_prop_key(key: &str) -> ParsedKey {
    // Peel components off the end, validating each marker token against the known
    // breakpoint/state sets. An UNRECOGNISED marker is left attached to the base
    // (so it never matches a real applicator), matching the web `parseVariantKey`
    // and the native renderers' `parseVariantName`. The canonical key order is
    // `<base>@<bp>:<state>.<arg>`, so peel arg → state → breakpoint.

    // Arg suffix: everything after the last '.'.
    let (mut work, arg) = match key.rfind('.') {
        Some(idx) => (key[..idx].to_string(), Some(key[idx + 1..].to_string())),
        None => (key.to_string(), None),
    };

    // State marker `:state` (only when the token is a known state).
    let mut state = None;
    if let Some(idx) = work.find(':') {
        let candidate = work[idx + 1..].to_string();
        if is_state(&candidate) {
            state = Some(candidate);
            work.truncate(idx);
        }
    }

    // Breakpoint marker `@bp` (only when the token is a known breakpoint).
    let mut breakpoint = None;
    if let Some(idx) = work.find('@') {
        let candidate = work[idx + 1..].to_string();
        if is_breakpoint(&candidate) {
            breakpoint = Some(candidate);
            work.truncate(idx);
        }
    }

    ParsedKey {
        base: work,
        breakpoint,
        state,
        arg,
    }
}

/// Build the variant-decorated base (no arg suffix) for a parsed key, e.g.
/// `padding@md`, `backgroundColor:hover`, `backgroundColor@md:hover`, or just
/// `padding`.
fn decorated_base(parsed: &ParsedKey) -> String {
    let mut out = parsed.base.clone();
    if let Some(bp) = &parsed.breakpoint {
        out.push('@');
        out.push_str(bp);
    }
    if let Some(st) = &parsed.state {
        out.push(':');
        out.push_str(st);
    }
    out
}

/// Among `candidate_keys` (a node's raw prop keys, each including its `.arg`
/// suffix), select those whose parsed base equals `base` and whose variant
/// markers are currently satisfied (breakpoint active at `viewport_w` AND state
/// present in `active_states`), then return the WINNER's variant-decorated base
/// (without the arg suffix) per the documented precedence.
///
/// The winner is chosen by precedence (lowest → highest, later wins):
/// `base < breakpoints ascending < disabled < hover < focus < active`.
/// A combined `@bp:state` key only qualifies when both halves are satisfied,
/// and ranks by its state (the higher signal), with its breakpoint min-width
/// breaking ties between two same-state candidates.
///
/// Returns:
/// * `Some(decorated_base)` for the winning key (e.g. `"padding@md"`).
/// * `Some(base)` when only the plain base key is present/qualifies.
/// * `None` when no candidate key matches `base` at all.
///
/// The returned value deliberately omits the `.arg` suffix: callers feed it to
/// their existing prop getters which append `.0` (or the named arg) themselves.
/// This is what fixes the `.0` mismatch bug.
pub fn pick_variant_base(
    base: &str,
    candidate_keys: &[&str],
    viewport_w: f32,
    active_states: &[&str],
) -> Option<String> {
    // Precedence score: higher wins.
    //   plain base                     -> 0
    //   breakpoint only                -> min-width (640..=1536), well below STATE_BASE
    //   state (any, maybe + bp)        -> STATE_BASE + state_rank*STATE_STEP + bp_min_width
    // The breakpoint min-width as a tiebreaker means a more-specific
    // `@xl:hover` beats `@sm:hover` when both are active. STATE_STEP must stay
    // strictly larger than the largest breakpoint min-width (1536) so the
    // bp tiebreak can never leak across state bands — i.e. a high-breakpoint
    // lower state (e.g. `@2xl:disabled`) must never outrank a plain higher
    // state (e.g. `:hover`).
    const STATE_BASE: f32 = 100_000.0;
    const STATE_STEP: f32 = 10_000.0;

    let mut best: Option<(f32, String)> = None;

    for key in candidate_keys {
        let parsed = parse_prop_key(key);
        if parsed.base != base {
            continue;
        }

        // Breakpoint must be active (or absent).
        if let Some(bp) = &parsed.breakpoint {
            match breakpoint_min_width(bp) {
                Some(min_w) if viewport_w >= min_w => {}
                _ => continue, // unknown bp or not active at this width
            }
        }

        // State must be active (or absent).
        if let Some(st) = &parsed.state {
            if !active_states.contains(&st.as_str()) {
                continue;
            }
        }

        // Compute precedence score.
        let bp_weight = parsed
            .breakpoint
            .as_deref()
            .and_then(breakpoint_min_width)
            .unwrap_or(0.0);
        let score = match (&parsed.breakpoint, &parsed.state) {
            (None, None) => 0.0,
            (Some(_), None) => bp_weight,
            (_, Some(st)) => STATE_BASE + state_rank(st) as f32 * STATE_STEP + bp_weight,
        };

        let decorated = decorated_base(&parsed);
        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => best = Some((score, decorated)),
        }
    }

    best.map(|(_, decorated)| decorated)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── predicates ──────────────────────────────────────────────────────

    #[test]
    fn predicates() {
        assert!(is_breakpoint("md"));
        assert!(is_breakpoint("2xl"));
        assert!(!is_breakpoint("hover"));
        assert!(is_state("hover"));
        assert!(is_state("focus-visible"));
        assert!(!is_state("md"));
        assert_eq!(breakpoint_min_width("md"), Some(768.0));
        assert_eq!(breakpoint_min_width("2xl"), Some(1536.0));
        assert_eq!(breakpoint_min_width("nope"), None);
        assert!(is_variant_token("default"));
        assert!(is_variant_token("md"));
        assert!(is_variant_token("hover"));
        assert!(!is_variant_token("top"));
        assert!(!is_variant_token("padding"));
    }

    // ── parse_prop_key ─────────────────────────────────────────────────

    #[test]
    fn parse_plain() {
        let p = parse_prop_key("padding.0");
        assert_eq!(p.base, "padding");
        assert_eq!(p.breakpoint, None);
        assert_eq!(p.state, None);
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_breakpoint() {
        let p = parse_prop_key("padding@md.0");
        assert_eq!(p.base, "padding");
        assert_eq!(p.breakpoint.as_deref(), Some("md"));
        assert_eq!(p.state, None);
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_state() {
        let p = parse_prop_key("backgroundColor:hover.0");
        assert_eq!(p.base, "backgroundColor");
        assert_eq!(p.breakpoint, None);
        assert_eq!(p.state.as_deref(), Some("hover"));
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_combined() {
        let p = parse_prop_key("backgroundColor@md:hover.0");
        assert_eq!(p.base, "backgroundColor");
        assert_eq!(p.breakpoint.as_deref(), Some("md"));
        assert_eq!(p.state.as_deref(), Some("hover"));
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_named_arg_no_variant() {
        let p = parse_prop_key("padding.top");
        assert_eq!(p.base, "padding");
        assert_eq!(p.breakpoint, None);
        assert_eq!(p.state, None);
        assert_eq!(p.arg.as_deref(), Some("top"));
    }

    #[test]
    fn parse_bare_no_arg() {
        let p = parse_prop_key("padding");
        assert_eq!(p.base, "padding");
        assert_eq!(p.breakpoint, None);
        assert_eq!(p.state, None);
        assert_eq!(p.arg, None);
    }

    #[test]
    fn parse_hyphenated_state() {
        let p = parse_prop_key("color:focus-visible.0");
        assert_eq!(p.base, "color");
        assert_eq!(p.state.as_deref(), Some("focus-visible"));
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_2xl_breakpoint() {
        let p = parse_prop_key("padding@2xl.0");
        assert_eq!(p.base, "padding");
        assert_eq!(p.breakpoint.as_deref(), Some("2xl"));
        assert_eq!(p.arg.as_deref(), Some("0"));
    }

    #[test]
    fn parse_invalid_markers_stay_in_base() {
        // Unrecognised breakpoint/state tokens are left attached to the base
        // (so they never match a real applicator), matching the web + native
        // parsers. The engine never emits such keys; this pins cross-SDK parity.
        let bp = parse_prop_key("padding@invalid.0");
        assert_eq!(bp.base, "padding@invalid");
        assert_eq!(bp.breakpoint, None);
        assert_eq!(bp.state, None);
        assert_eq!(bp.arg.as_deref(), Some("0"));

        let st = parse_prop_key("color:bogus.0");
        assert_eq!(st.base, "color:bogus");
        assert_eq!(st.state, None);
        assert_eq!(st.breakpoint, None);
    }

    // ── pick_variant_base ──────────────────────────────────────────────

    #[test]
    fn pick_base_only() {
        let keys = ["padding.0"];
        assert_eq!(
            pick_variant_base("padding", &keys, 1000.0, &[]),
            Some("padding".to_string())
        );
    }

    #[test]
    fn pick_no_match_returns_none() {
        let keys = ["margin.0"];
        assert_eq!(pick_variant_base("padding", &keys, 1000.0, &[]), None);
    }

    #[test]
    fn pick_breakpoint_active() {
        let keys = ["padding.0", "padding@md.0"];
        // width 1000 >= 768, so @md wins over base.
        assert_eq!(
            pick_variant_base("padding", &keys, 1000.0, &[]),
            Some("padding@md".to_string())
        );
    }

    #[test]
    fn pick_breakpoint_inactive() {
        let keys = ["padding.0", "padding@md.0"];
        // width 500 < 768, so @md does NOT apply; base wins.
        assert_eq!(
            pick_variant_base("padding", &keys, 500.0, &[]),
            Some("padding".to_string())
        );
    }

    #[test]
    fn pick_ascending_breakpoint_order() {
        let keys = ["padding.0", "padding@md.0", "padding@lg.0", "padding@xl.0"];
        // width 1100 >= md(768) and lg(1024) but < xl(1280): lg wins.
        assert_eq!(
            pick_variant_base("padding", &keys, 1100.0, &[]),
            Some("padding@lg".to_string())
        );
    }

    #[test]
    fn pick_hover_overrides_breakpoint() {
        let keys = ["backgroundColor.0", "backgroundColor@md.0", "backgroundColor:hover.0"];
        // md active and hover active: hover (a state) outranks breakpoint.
        assert_eq!(
            pick_variant_base("backgroundColor", &keys, 1000.0, &["hover"]),
            Some("backgroundColor:hover".to_string())
        );
    }

    #[test]
    fn pick_active_overrides_hover() {
        let keys = ["c.0", "c:hover.0", "c:active.0"];
        assert_eq!(
            pick_variant_base("c", &keys, 800.0, &["hover", "active"]),
            Some("c:active".to_string())
        );
    }

    #[test]
    fn pick_disabled_lowest_of_states() {
        let keys = ["c.0", "c:disabled.0", "c:hover.0"];
        // both active: hover outranks disabled.
        assert_eq!(
            pick_variant_base("c", &keys, 800.0, &["disabled", "hover"]),
            Some("c:hover".to_string())
        );
        // only disabled active: disabled wins over base.
        assert_eq!(
            pick_variant_base("c", &keys, 800.0, &["disabled"]),
            Some("c:disabled".to_string())
        );
    }

    #[test]
    fn pick_combined_requires_both() {
        let keys = ["c.0", "c@md:hover.0"];
        // md active but hover NOT active -> combined does not qualify; base wins.
        assert_eq!(
            pick_variant_base("c", &keys, 1000.0, &[]),
            Some("c".to_string())
        );
        // hover active but md NOT active (width 500 < 768) -> base wins.
        assert_eq!(
            pick_variant_base("c", &keys, 500.0, &["hover"]),
            Some("c".to_string())
        );
        // both active -> combined wins.
        assert_eq!(
            pick_variant_base("c", &keys, 1000.0, &["hover"]),
            Some("c@md:hover".to_string())
        );
    }

    #[test]
    fn pick_state_only_inactive_falls_to_base() {
        let keys = ["c.0", "c:hover.0"];
        assert_eq!(
            pick_variant_base("c", &keys, 800.0, &[]),
            Some("c".to_string())
        );
    }

    #[test]
    fn pick_combined_outranks_plain_state_via_breakpoint_tiebreak() {
        // Two hover candidates active; the one carrying a breakpoint is more
        // specific and wins the tiebreak.
        let keys = ["c:hover.0", "c@md:hover.0"];
        assert_eq!(
            pick_variant_base("c", &keys, 1000.0, &["hover"]),
            Some("c@md:hover".to_string())
        );
    }

    #[test]
    fn pick_high_breakpoint_lower_state_does_not_leak_across_state_bands() {
        // Regression: a high-breakpoint lower-precedence state (`@2xl:disabled`)
        // must NOT outrank a plain higher-precedence state (`:hover`). The bp
        // tiebreak only orders within a single state band.
        let keys = ["c:hover.0", "c@2xl:disabled.0"];
        assert_eq!(
            pick_variant_base("c", &keys, 1536.0, &["disabled", "hover"]),
            Some("c:hover".to_string())
        );
    }

    #[test]
    fn pick_focus_visible_ranks_as_focus_not_above_active() {
        // focus-visible / focus-within behave like focus; active must still win.
        let keys = ["c:focus-visible.0", "c:active.0"];
        assert_eq!(
            pick_variant_base("c", &keys, 0.0, &["focus-visible", "active"]),
            Some("c:active".to_string())
        );
    }
}
