//! Style props extracted from a renderer [`Node`].
//!
//! Hypen applicators land in props as dotted keys: `.padding(16)` →
//! `padding.0 = 16`; `.padding(top: 8)` → `padding.top = 8`. Helpers in
//! this module read those keys (with sensible fallbacks) so layout and
//! painter both see the same resolved style without re-implementing the
//! lookup rules.
//!
//! Phase 3 covers the 80% applicators: padding (uniform + directional),
//! gap, color, backgroundColor, fontSize, fontWeight. Borders, margins,
//! transforms, gradients, and tw classes land in later phases.
//!
//! ## Variants (responsive + interaction state)
//!
//! Applicator values may carry a variant marker BETWEEN the camelCase
//! base and the `.0` arg suffix, e.g. `padding@md.0`,
//! `backgroundColor:hover.0`, `backgroundColor@md:hover.0`. Resolution
//! is delegated wholesale to the engine's shared parser
//! (`hypen_engine::portable::{parse_prop_key, pick_variant_base}`) so
//! the desktop renderer matches the iOS / web reference precedence:
//! `base < breakpoints (ascending min-width) < disabled < hover < focus
//! < active`, with a combined `@bp:state` requiring both halves.
//!
//! - **Responsive (breakpoint) variants** resolve at layout time via the
//!   `prop_*_at` / `padding_at` / `margin_at` / `border_at` family — the
//!   `VariantState::layout` path (no interaction states).
//! - **Interaction-state variants** (hover/focus/active/disabled) split
//!   into two channels:
//!   - PAINT-AFFECTING colour props (`backgroundColor`, `color`,
//!     `borderColor`) are precomputed into [`StateVariants`] at
//!     layout-build time and applied by the painter against the live
//!     `InteractionState` — no relayout needed.
//!   - LAYOUT-AFFECTING props (padding / margin / gap / width / height /
//!     min-max sizes / border width / flex, …) participate in the Taffy
//!     layout pass: the layout reads thread the node's *active*
//!     interaction states through [`VariantState::paint`] so e.g.
//!     `padding:hover` actually changes geometry. To keep the common
//!     case fast, the window only relayouts on interaction transitions
//!     that touch nodes carrying a layout-affecting state variant (see
//!     [`node_has_layout_state_variant`] / [`tree_has_layout_state_variants`]);
//!     a hover on a plainly-styled node stays on the repaint-only path.
//!
//! ### Out of scope
//!
//! Opacity and shadow state variants are not resolved here (the painter
//! does not yet read those props at all).

use crate::tree::Node;
use serde_json::Value;

/// RGBA, premultiplied-friendly straight-alpha at the source. Used as
/// input to tiny-skia's `PremultipliedColorU8`. The `Default` is
/// fully transparent black.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    pub const BLACK: Rgba = Rgba(0, 0, 0, 0xff);
    pub const TRANSPARENT: Rgba = Rgba(0, 0, 0, 0);

    /// Pre-multiply alpha into RGB. tiny-skia's PremultipliedColorU8
    /// expects pre-multiplied bytes.
    pub fn premultiplied(self) -> [u8; 4] {
        let Rgba(r, g, b, a) = self;
        let a = a as u32;
        [
            ((r as u32 * a + 127) / 255) as u8,
            ((g as u32 * a + 127) / 255) as u8,
            ((b as u32 * a + 127) / 255) as u8,
            a as u8,
        ]
    }
}

/// Box-model padding in physical pixels.
#[derive(Debug, Clone, Copy, Default)]
pub struct Padding {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl Padding {
    pub fn uniform(v: f32) -> Self {
        Self {
            top: v,
            right: v,
            bottom: v,
            left: v,
        }
    }
}

/// Convert a camelCase prop name to its CSS kebab-case equivalent.
/// `backgroundColor` → `background-color`. Used by [`prop_str`] /
/// [`prop_f32`] to fall back onto props that arrive via `.tw(...)`
/// (the engine's tailwind expander emits CSS-style kebab names) when
/// no explicit applicator was set.
fn camel_to_kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Read a number prop. Lookup order: explicit applicator
/// (`backgroundColor`), single-arg form (`backgroundColor.0`), then
/// the kebab-case fallback (`background-color`) for tw-expanded
/// classes.
/// Viewport units (`vh`, `vw`, `vmin`, `vmax`) read as absent here —
/// there is no viewport in scope to resolve them against. Call
/// [`prop_f32_in`] from any path that has one.
pub fn prop_f32(node: &Node, name: &str) -> Option<f32> {
    prop_f32_in(node, name, None)
}

/// [`prop_f32`] with a viewport basis, so viewport-relative lengths
/// resolve to logical px.
pub fn prop_f32_in(node: &Node, name: &str, viewport: Option<Viewport>) -> Option<f32> {
    lookup_prop(node, name).and_then(|v| value_to_f32(v, viewport))
}

/// Read a string prop, same fallback chain as [`prop_f32`].
pub fn prop_str<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    lookup_prop(node, name).and_then(Value::as_str)
}

/// Shared `direct → dotted (.0) → kebab` lookup chain. Lazy: the dotted
/// key is only formatted when the direct key misses, and the kebab
/// fallback is only built for camelCase names (a lowercase `name`
/// kebab-cases to itself, so the third probe would be redundant).
#[inline]
fn lookup_prop<'a>(node: &'a Node, name: &str) -> Option<&'a Value> {
    node.props
        .get(name)
        .or_else(|| node.props.get(&format!("{name}.0")))
        .or_else(|| {
            if name.bytes().any(|b| b.is_ascii_uppercase()) {
                node.props.get(&camel_to_kebab(name))
            } else {
                None
            }
        })
}

/// The window's content box in **logical** (CSS) pixels.
///
/// Two things resolve against it and both want CSS pixels, not physical
/// ones: Tailwind breakpoints (`sm` 640 … `2xl` 1536) and the CSS
/// viewport length units (`vw`, `vh`, `vmin`, `vmax`). Lengths stay in
/// physical pixels elsewhere — taffy styles multiply by `scale` — so
/// this type is deliberately the only place the logical basis lives.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Viewport {
    pub w: f32,
    pub h: f32,
}

impl Viewport {
    pub fn new(w: f32, h: f32) -> Self {
        Self { w, h }
    }

    /// `1vmin` in logical px — the smaller axis, per CSS.
    fn vmin(&self) -> f32 {
        self.w.min(self.h)
    }

    /// `1vmax` in logical px — the larger axis, per CSS.
    fn vmax(&self) -> f32 {
        self.w.max(self.h)
    }
}

/// Variant-resolution context for the viewport-aware prop getters.
///
/// Bundles the current viewport and the set of active interaction
/// states (`hover`, `focus`, `active`, `disabled`, ...). Layout-time
/// callers leave `active_states` empty (only responsive breakpoints
/// resolve); the paint pass populates it from live `InteractionState`
/// so state variants (`backgroundColor:hover.0`) win per the shared
/// precedence rules.
#[derive(Debug, Clone, Default)]
pub struct VariantState<'a> {
    pub viewport: Viewport,
    pub active_states: Vec<&'a str>,
}

impl<'a> VariantState<'a> {
    /// Layout-time context: responsive breakpoints only, no interaction
    /// states. This is what `prop_*_at` / `padding_at` / `border_at`
    /// resolve through.
    pub fn layout(viewport: Viewport) -> Self {
        Self {
            viewport,
            active_states: Vec::new(),
        }
    }

    /// Paint-time context: breakpoints plus the supplied interaction
    /// states.
    pub fn paint(viewport: Viewport, active_states: Vec<&'a str>) -> Self {
        Self {
            viewport,
            active_states,
        }
    }
}

/// The set of applicator bases whose value feeds the Taffy layout pass
/// (box model, sizing, flex, grid). A state variant on any of these
/// (e.g. `padding:hover`) must trigger a relayout when its interaction
/// state toggles; a state variant on anything else (colours, opacity,
/// shadow) only repaints. Kept in sync with the props actually consumed
/// by `node_style` / `build_subtree` / the `apply_*` helpers in
/// `layout.rs`. `rowGap` / `columnGap` are included for completeness
/// (CSS layout props) even though only `gap` is read today.
pub const LAYOUT_AFFECTING_PROPS: &[&str] = &[
    // Box model — padding (uniform / directional / per-side).
    "padding",
    "paddingHorizontal",
    "paddingVertical",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    // Box model — margin.
    "margin",
    "marginHorizontal",
    "marginVertical",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    // Gaps.
    "gap",
    "rowGap",
    "columnGap",
    // Sizing.
    "width",
    "height",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "size",
    "aspectRatio",
    // Border width (the geometry-affecting part of a border; colour is
    // a paint channel handled by `StateVariants`).
    "border",
    "borderWidth",
    "borderTopWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderRightWidth",
    // Flex.
    "flex",
    "flexGrow",
    "flexShrink",
    "flexBasis",
    "flexDirection",
    // Grid.
    "gridColumns",
    // Positioning insets.
    "inset",
    "top",
    "right",
    "bottom",
    "left",
];

/// True when `base` (a camelCase applicator base, no variant markers or
/// arg suffix) names a layout-affecting prop — see
/// [`LAYOUT_AFFECTING_PROPS`].
pub fn is_layout_affecting_prop(base: &str) -> bool {
    LAYOUT_AFFECTING_PROPS.contains(&base)
}

/// True when `node` carries at least one prop key that (a) parses to a
/// non-`None` interaction `state` and (b) whose base is layout-affecting
/// (e.g. `padding:hover.0`, `width@md:focus.0`). Breakpoint-only
/// variants (`padding@md.0`) do NOT count — those already resolve at
/// layout time without interaction input. This is the per-node gate the
/// window uses to decide whether a hover/press/focus transition on this
/// node should bump the layout cache key.
pub fn node_has_layout_state_variant(node: &Node) -> bool {
    node.props.keys().any(|key| {
        // A state variant needs a `:state` marker; keys without a `:`
        // can't parse to one, so skip the allocating parse for them.
        if !key.as_bytes().contains(&b':') {
            return false;
        }
        let parsed = hypen_engine::portable::parse_prop_key(key);
        parsed.state.is_some() && is_layout_affecting_prop(&parsed.base)
    })
}

/// Build the active interaction-state list for layout-time prop
/// resolution, in the same shape the painter feeds the colour resolver.
/// Mirrors [`StateVariants::active_states`] (order is irrelevant —
/// precedence lives in the shared resolver). `disabled` is derived from
/// the node's `enabled` / `disabled` props; the rest reflect the live
/// pointer / keyboard flags for this specific node.
pub fn node_layout_active_states<'a>(
    node: &Node,
    hovered: bool,
    pressed: bool,
    focused: bool,
) -> Vec<&'a str> {
    let mut states = Vec::new();
    if is_disabled(node) {
        states.push("disabled");
    }
    if hovered {
        states.push("hover");
    }
    if focused {
        states.push("focus");
    }
    if pressed {
        states.push("active");
    }
    states
}

/// A single state/breakpoint-decorated colour candidate for a paint
/// prop, precomputed at layout-build time (where the node + viewport are
/// available) so the painter — which only sees the `LayoutItem`, not the
/// renderer tree — can still honour live interaction states.
#[derive(Debug, Clone)]
pub struct VariantCandidate {
    /// The raw node prop key, e.g. `"backgroundColor:hover.0"`. Carried
    /// so the painter can re-run the shared precedence resolver against
    /// the *live* active-state set.
    pub key: String,
    /// Decorated base (no arg suffix), e.g. `"backgroundColor:hover"` —
    /// what `pick_variant_base` returns and what the painter matches on.
    pub decorated: String,
    /// The resolved colour for this candidate.
    pub value: Rgba,
}

/// Paint-time state-variant overrides for a single node, precomputed at
/// layout-build time. Only the paint-affecting colour props are covered
/// (`backgroundColor`, `color`/foreground, `borderColor`); layout-
/// affecting state variants (e.g. `padding:hover`) are intentionally not
/// resolved here — see the module-level limitation note.
///
/// Empty (the common case) means the node declared no state/breakpoint
/// variants for any paint prop, and the painter takes its existing fast
/// path with the base-resolved values already on the `LayoutItem`.
#[derive(Debug, Clone, Default)]
pub struct StateVariants {
    pub viewport: Viewport,
    /// Whether the node is disabled (`enabled: false` or `disabled:
    /// true`). Folded into the live active-state set as `"disabled"` so
    /// `backgroundColor:disabled.0` variants resolve. Derived at layout
    /// time since the painter has no node handle.
    pub disabled: bool,
    pub background_color: Vec<VariantCandidate>,
    pub color: Vec<VariantCandidate>,
    pub border_color: Vec<VariantCandidate>,
}

impl StateVariants {
    /// `true` when no paint prop carries any variant candidate — lets
    /// the painter skip all state-variant work for the overwhelmingly
    /// common plain-styled node. The `disabled` flag alone doesn't make
    /// the node non-empty: with no `:disabled` candidates there's
    /// nothing to resolve.
    pub fn is_empty(&self) -> bool {
        self.background_color.is_empty()
            && self.color.is_empty()
            && self.border_color.is_empty()
    }

    /// Build the live active-state list the painter feeds to the
    /// resolver, from per-node disabled state plus the transient
    /// pointer/keyboard flags. Order is irrelevant — precedence lives in
    /// the shared resolver. `"active"` mirrors the pressed (pointer-
    /// down) state; `"focus"` the keyboard focus.
    pub fn active_states<'a>(&self, hovered: bool, pressed: bool, focused: bool) -> Vec<&'a str> {
        let mut states = Vec::new();
        if self.disabled {
            states.push("disabled");
        }
        if hovered {
            states.push("hover");
        }
        if focused {
            states.push("focus");
        }
        if pressed {
            states.push("active");
        }
        states
    }

    /// Resolve `backgroundColor` for the given live interaction states,
    /// returning the winning variant colour when one beats the base.
    /// `None` means "no state/breakpoint variant wins; use the base".
    pub fn background_color_for(&self, active_states: &[&str]) -> Option<Rgba> {
        self.resolve("backgroundColor", &self.background_color, active_states)
    }

    /// Resolve foreground `color` for the given live interaction states.
    pub fn color_for(&self, active_states: &[&str]) -> Option<Rgba> {
        self.resolve("color", &self.color, active_states)
    }

    /// Resolve `borderColor` for the given live interaction states.
    pub fn border_color_for(&self, active_states: &[&str]) -> Option<Rgba> {
        self.resolve("borderColor", &self.border_color, active_states)
    }

    fn resolve(
        &self,
        base: &str,
        candidates: &[VariantCandidate],
        active_states: &[&str],
    ) -> Option<Rgba> {
        if candidates.is_empty() {
            return None;
        }
        let keys: Vec<&str> = candidates.iter().map(|c| c.key.as_str()).collect();
        let picked =
            hypen_engine::portable::pick_variant_base(base, &keys, self.viewport.w, active_states)?;
        // Only override when a *variant-decorated* candidate won; a
        // plain-base winner means the base value already on the item is
        // correct (don't double-resolve).
        if picked == base {
            return None;
        }
        candidates
            .iter()
            .find(|c| c.decorated == picked)
            .map(|c| c.value)
    }
}

/// Collect the variant (state/breakpoint-decorated) colour candidates
/// for a single paint prop off `node`. Only keys whose parsed base
/// equals `base` AND that carry a variant marker (`@bp` or `:state`) are
/// included — the plain base is handled by the existing
/// `prop_color_at` path on the `LayoutItem`. Returns an empty vec for
/// the common no-variant case.
pub fn collect_color_variants(node: &Node, base: &str) -> Vec<VariantCandidate> {
    let mut out = Vec::new();
    for key in node.props.keys() {
        // Only variant-decorated keys qualify below (`parsed.breakpoint`
        // or `parsed.state` must be set), and both markers require a
        // `@` / `:` byte — skip the allocating parse for plain keys.
        if !key.as_bytes().iter().any(|&b| b == b'@' || b == b':') {
            continue;
        }
        let parsed = hypen_engine::portable::parse_prop_key(key);
        if parsed.base != base {
            continue;
        }
        if parsed.breakpoint.is_none() && parsed.state.is_none() {
            continue; // plain base — handled elsewhere
        }
        // Build the decorated base (no arg suffix).
        let mut decorated = parsed.base.clone();
        if let Some(bp) = &parsed.breakpoint {
            decorated.push('@');
            decorated.push_str(bp);
        }
        if let Some(st) = &parsed.state {
            decorated.push(':');
            decorated.push_str(st);
        }
        if let Some(value) = node.props.get(key).and_then(Value::as_str).and_then(parse_color) {
            out.push(VariantCandidate {
                key: key.clone(),
                decorated,
                value,
            });
        }
    }
    out
}

/// Build the full [`StateVariants`] override set for `node` at the given
/// viewport. Resolves `backgroundColor`, `color`, and `borderColor`
/// variant candidates so the painter can apply state variants without
/// the renderer tree.
pub fn state_variants(node: &Node, viewport: Viewport) -> StateVariants {
    StateVariants {
        viewport,
        disabled: is_disabled(node),
        background_color: collect_color_variants(node, "backgroundColor"),
        color: collect_color_variants(node, "color"),
        border_color: collect_color_variants(node, "borderColor"),
    }
}

/// Derive the node's disabled state from `enabled` / `disabled` props
/// (each via the standard `.0` / direct chain). `disabled: true` or
/// `enabled: false` both count; absent → not disabled.
fn is_disabled(node: &Node) -> bool {
    let as_bool = |name: &str| -> Option<bool> {
        node.props
            .get(name)
            .or_else(|| node.props.get(&format!("{name}.0")))
            .and_then(Value::as_bool)
    };
    if as_bool("disabled") == Some(true) {
        return true;
    }
    if as_bool("enabled") == Some(false) {
        return true;
    }
    false
}

/// Choose the winning variant-decorated base name for `name` on `node`
/// given the current `viewport_w` / `active_states`, then return that
/// decorated base (e.g. `"padding@md"`, `"backgroundColor:hover"`, or
/// plain `"padding"`). Returns `None` only when no prop key on the node
/// matches `name` at all.
///
/// The decorated base deliberately omits the `.0` arg suffix — callers
/// feed it back to [`prop_f32`] / [`prop_str`] / [`prop_color`] which
/// append the suffix themselves. This unifies the responsive + state
/// resolution onto the engine's shared parser and fixes the historical
/// `.0` mismatch (the old hand-rolled `lookup_breakpoint` built
/// `"padding@md"` and raw-`get`'d it, missing the real `"padding@md.0"`).
fn pick_base(node: &Node, name: &str, viewport_w: f32, active_states: &[&str]) -> Option<String> {
    // Fast path: a node with no variant-decorated key at all can only
    // ever resolve to the plain base, which every caller treats the
    // same as `None` (the `decorated != name` branch is skipped either
    // way). Skipping the resolver here removes a per-lookup Vec
    // collection + a `parse_prop_key` (three String allocations) for
    // every prop key — the dominant cost of building a node's style,
    // paid dozens of times per node per layout pass.
    if !node.has_variant_prop_keys() {
        return None;
    }
    let candidate_keys: Vec<&str> = node.props.keys().map(String::as_str).collect();
    hypen_engine::portable::pick_variant_base(name, &candidate_keys, viewport_w, active_states)
}

/// Read a string prop honouring Tailwind breakpoints + interaction
/// states. Picks the winning variant-decorated base via the shared
/// resolver, then defers to [`prop_str`] for the actual value read +
/// fallback chain. The non-breakpoint variant ([`prop_str`]) is the
/// right call for paths that don't have a viewport handy (e.g.
/// accessibility serialisation).
pub fn prop_str_with<'a>(node: &'a Node, name: &str, vs: &VariantState) -> Option<&'a str> {
    if let Some(decorated) = pick_base(node, name, vs.viewport.w, &vs.active_states) {
        if decorated != name {
            // A variant-decorated key won — read its `.0` value
            // directly. `prop_str` appends `.0` and also tries the bare
            // key, so this resolves `backgroundColor@md:hover.0` etc.
            if let Some(v) = prop_str(node, &decorated) {
                return Some(v);
            }
        }
    }
    // Responsive *value-map* form: `.gridColumns({default: 2, md: 3})`
    // lands as a single JSON object prop (not `name@md.0` suffix keys),
    // so the variant resolver above won't see it. Honour it here.
    if let Some(v) = lookup_responsive_object(node, name, vs.viewport.w).and_then(Value::as_str) {
        return Some(v);
    }
    prop_str(node, name)
}

/// Tailwind-style breakpoint thresholds (px), largest-first. Matches the
/// defaults the engine's `hypen-tailwind-parse` emits in `name@bp` keys.
/// Used by [`lookup_responsive_object`] to pick the largest active band
/// in a value-map (`.gridColumns({default: 2, md: 3})`). Suffix-keyed
/// breakpoint props (`padding@md.0`) instead resolve through the shared
/// `pick_variant_base` resolver.
const BREAKPOINTS_DESC: &[(&str, f32)] = &[
    ("2xl", 1536.0),
    ("xl", 1280.0),
    ("lg", 1024.0),
    ("md", 768.0),
    ("sm", 640.0),
];

/// Resolve a *responsive-object* prop value: `.gridColumns({default: 2,
/// md: 3, lg: 4})` (and any other applicator passed an object keyed by
/// breakpoint) lands as a single JSON object prop, not the `name@md`
/// suffix keys that tailwind classes produce. Pick the value for the
/// largest active breakpoint, falling back to `default` / `base`.
/// Returns `None` when the prop is absent or isn't an object.
fn lookup_responsive_object<'a>(
    node: &'a Node,
    name: &str,
    viewport_w: f32,
) -> Option<&'a Value> {
    let raw = node
        .props
        .get(name)
        .or_else(|| node.props.get(&format!("{name}.0")))?;
    let obj = raw.as_object()?;
    for (bp, threshold) in BREAKPOINTS_DESC {
        if viewport_w >= *threshold {
            if let Some(v) = obj.get(*bp) {
                return Some(v);
            }
        }
    }
    obj.get("default").or_else(|| obj.get("base"))
}

/// Numeric counterpart of [`prop_str_with`].
pub fn prop_f32_with(node: &Node, name: &str, vs: &VariantState) -> Option<f32> {
    let viewport = Some(vs.viewport);
    if let Some(decorated) = pick_base(node, name, vs.viewport.w, &vs.active_states) {
        if decorated != name {
            if let Some(v) = prop_f32_in(node, &decorated, viewport) {
                return Some(v);
            }
        }
    }
    // Responsive *value-map* form (`.gridColumns({default: 2, md: 3})`).
    if let Some(v) =
        lookup_responsive_object(node, name, vs.viewport.w).and_then(|v| value_to_f32(v, viewport))
    {
        return Some(v);
    }
    // `_in`, not the bare `prop_f32`: this is the fallthrough every
    // plain `height: "100vh"` takes, and dropping the viewport here
    // would undo the whole resolution chain above it.
    prop_f32_in(node, name, viewport)
}

/// Colour counterpart of [`prop_str_with`] — runs the result through
/// [`parse_color`].
pub fn prop_color_with(node: &Node, name: &str, vs: &VariantState) -> Option<Rgba> {
    prop_str_with(node, name, vs).and_then(parse_color)
}

/// Read a string prop honouring Tailwind breakpoints (layout-time, no
/// interaction states). Thin wrapper over [`prop_str_with`].
pub fn prop_str_at<'a>(node: &'a Node, name: &str, viewport: Viewport) -> Option<&'a str> {
    prop_str_with(node, name, &VariantState::layout(viewport))
}

/// Numeric counterpart of [`prop_str_at`].
pub fn prop_f32_at(node: &Node, name: &str, viewport: Viewport) -> Option<f32> {
    prop_f32_with(node, name, &VariantState::layout(viewport))
}

/// Colour counterpart of [`prop_str_at`] — same fallback chain, then
/// runs the result through [`parse_color`].
pub fn prop_color_at(node: &Node, name: &str, viewport: Viewport) -> Option<Rgba> {
    prop_color_with(node, name, &VariantState::layout(viewport))
}

/// Read a colour prop and parse it. Accepts CSS hex (`#rgb`, `#rgba`,
/// `#rrggbb`, `#rrggbbaa`) and a small set of named colours.
pub fn prop_color(node: &Node, name: &str) -> Option<Rgba> {
    prop_str(node, name).and_then(parse_color)
}

/// Resolve `.padding(...)` plus the directional shorthand variants into
/// a single Padding. Order of precedence (per side):
/// 1. `.paddingTop(N)` → `paddingTop.0`
/// 2. `.padding(top: N)` → `padding.top`
/// 3. `.paddingVertical(N)` → `paddingVertical.0` (top + bottom)
///    / `.paddingHorizontal(N)` → `paddingHorizontal.0` (left + right)
/// 4. `.padding(N)` → `padding.0` (all sides)
pub fn padding(node: &Node) -> Padding {
    read_box_props(node, &PADDING_KEYS)
}

/// Margin counterpart of [`padding`] — same precedence and key
/// conventions, just with a `margin` prefix.
pub fn margin(node: &Node) -> Padding {
    read_box_props(node, &MARGIN_KEYS)
}

/// Viewport-aware [`padding`] — honours `padding@md` etc. tw classes.
pub fn padding_at(node: &Node, viewport: Viewport) -> Padding {
    read_box_props_at(node, &PADDING_KEYS, &VariantState::layout(viewport))
}

/// Viewport-aware [`margin`].
pub fn margin_at(node: &Node, viewport: Viewport) -> Padding {
    read_box_props_at(node, &MARGIN_KEYS, &VariantState::layout(viewport))
}

/// Variant-aware [`padding`] — honours both `padding@md` breakpoints and
/// interaction-state variants (`padding:hover`) per the active states in
/// `vs`. The layout pass uses this so layout-affecting state variants
/// reach Taffy.
pub fn padding_with(node: &Node, vs: &VariantState) -> Padding {
    read_box_props_at(node, &PADDING_KEYS, vs)
}

/// Variant-aware [`margin`] — see [`padding_with`].
pub fn margin_with(node: &Node, vs: &VariantState) -> Padding {
    read_box_props_at(node, &MARGIN_KEYS, vs)
}

/// Pre-built key set for one box-model prefix (`padding` / `margin`).
/// The readers below run for every node on every style build — formatting
/// `"{prefix}Top"` etc. on each call allocated ~12 short Strings per read,
/// and the prefix only ever names one of two applicator families.
struct BoxPropKeys {
    base: &'static str,
    horizontal: &'static str,
    vertical: &'static str,
    top: &'static str,
    bottom: &'static str,
    left: &'static str,
    right: &'static str,
    dot_top: &'static str,
    dot_right: &'static str,
    dot_bottom: &'static str,
    dot_left: &'static str,
}

static PADDING_KEYS: BoxPropKeys = BoxPropKeys {
    base: "padding",
    horizontal: "paddingHorizontal",
    vertical: "paddingVertical",
    top: "paddingTop",
    bottom: "paddingBottom",
    left: "paddingLeft",
    right: "paddingRight",
    dot_top: "padding.top",
    dot_right: "padding.right",
    dot_bottom: "padding.bottom",
    dot_left: "padding.left",
};

static MARGIN_KEYS: BoxPropKeys = BoxPropKeys {
    base: "margin",
    horizontal: "marginHorizontal",
    vertical: "marginVertical",
    top: "marginTop",
    bottom: "marginBottom",
    left: "marginLeft",
    right: "marginRight",
    dot_top: "margin.top",
    dot_right: "margin.right",
    dot_bottom: "margin.bottom",
    dot_left: "margin.left",
};

/// Shared box-model reader for `padding` / `margin`. The Hypen DSL gives
/// both shorthand and per-side applicators that all collapse to the same
/// 4-edge `Padding` shape; the precedence ordering matches `padding`'s
/// doc-comment.
/// Viewport-aware variant of [`read_box_props`]. Mirrors the same
/// precedence chain but every `prop_f32` lookup goes through the
/// breakpoint-aware [`prop_f32_at`].
/// Whether the node DECLARES any padding, regardless of its value.
///
/// [`padding_with`] resolves to a `Padding` whose unset edges are `0.0`, so
/// callers that fall back to a default when they see zero cannot tell "no
/// padding specified" from "padding explicitly set to zero". Buttons do
/// exactly that, which made `.tw("p-0")` a no-op: the launcher's dock icons
/// each kept the 16pt default and grew from 56pt to 88pt, so four of them
/// overflowed the dock's `max-w-[260px]` container.
///
/// Checks the same key space as [`read_box_props_at`].
pub fn declares_padding(node: &Node, vs: &VariantState) -> bool {
    let viewport = Some(vs.viewport);
    let k = &PADDING_KEYS;
    if [
        k.base,
        k.horizontal,
        k.vertical,
        k.top,
        k.bottom,
        k.left,
        k.right,
    ]
    .iter()
    .any(|name| prop_f32_with(node, name, vs).is_some())
    {
        return true;
    }
    [k.dot_top, k.dot_right, k.dot_bottom, k.dot_left]
        .iter()
        .any(|key| {
            node.props
                .get(*key)
                .and_then(|v| value_to_f32(v, viewport))
                .is_some()
        })
}

fn read_box_props_at(node: &Node, keys: &BoxPropKeys, vs: &VariantState) -> Padding {
    let viewport = Some(vs.viewport);
    let mut p = Padding::default();
    if let Some(v) = prop_f32_with(node, keys.base, vs) {
        p = Padding::uniform(v);
    }
    if let Some(v) = prop_f32_with(node, keys.horizontal, vs) {
        p.left = v;
        p.right = v;
    }
    if let Some(v) = prop_f32_with(node, keys.vertical, vs) {
        p.top = v;
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_top)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.top = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_right)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.right = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_bottom)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_left)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.left = v;
    }
    if let Some(v) = prop_f32_with(node, keys.top, vs) {
        p.top = v;
    }
    if let Some(v) = prop_f32_with(node, keys.bottom, vs) {
        p.bottom = v;
    }
    if let Some(v) = prop_f32_with(node, keys.left, vs) {
        p.left = v;
    }
    if let Some(v) = prop_f32_with(node, keys.right, vs) {
        p.right = v;
    }
    p
}

fn read_box_props(node: &Node, keys: &BoxPropKeys) -> Padding {
    let viewport: Option<Viewport> = None;
    let mut p = Padding::default();

    if let Some(v) = prop_f32(node, keys.base) {
        p = Padding::uniform(v);
    }
    if let Some(v) = prop_f32(node, keys.horizontal) {
        p.left = v;
        p.right = v;
    }
    if let Some(v) = prop_f32(node, keys.vertical) {
        p.top = v;
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_top)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.top = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_right)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.right = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_bottom)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(keys.dot_left)
        .and_then(|v| value_to_f32(v, viewport))
    {
        p.left = v;
    }
    if let Some(v) = prop_f32(node, keys.top) {
        p.top = v;
    }
    if let Some(v) = prop_f32(node, keys.bottom) {
        p.bottom = v;
    }
    if let Some(v) = prop_f32(node, keys.left) {
        p.left = v;
    }
    if let Some(v) = prop_f32(node, keys.right) {
        p.right = v;
    }

    p
}

/// Per-side bitmask: 1=top, 2=right, 4=bottom, 8=left.
pub const BORDER_SIDE_TOP: u8 = 1;
pub const BORDER_SIDE_RIGHT: u8 = 2;
pub const BORDER_SIDE_BOTTOM: u8 = 4;
pub const BORDER_SIDE_LEFT: u8 = 8;
pub const BORDER_SIDES_ALL: u8 =
    BORDER_SIDE_TOP | BORDER_SIDE_RIGHT | BORDER_SIDE_BOTTOM | BORDER_SIDE_LEFT;

/// Resolved border style for a node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Border {
    pub width: f32,
    pub color: Rgba,
    pub radius: f32,
    /// Bitmask of which sides this border draws on. `BORDER_SIDES_ALL`
    /// (the default) is the standard "stroke the full rounded rect"
    /// path. A subset means tw `border-b` / `border-t` etc. — those
    /// expand to per-side keys (`border-bottom-width: 1px`) which
    /// the layout reads here, then the painter strokes only the set
    /// sides as thin un-rounded fill rects.
    pub sides: u8,
}

impl Default for Border {
    fn default() -> Self {
        Self {
            width: 0.0,
            color: Rgba::TRANSPARENT,
            radius: 0.0,
            sides: BORDER_SIDES_ALL,
        }
    }
}

impl Border {
    pub fn is_visible(&self) -> bool {
        self.width > 0.0 && self.color.3 > 0 && self.sides != 0
    }

    /// True when only some of the four sides are flagged. Painter
    /// uses this to fall back from `stroke_rect` (which draws all
    /// four edges of the rounded rect) to a per-side fill_rect path.
    pub fn is_partial(&self) -> bool {
        self.sides != 0 && self.sides != BORDER_SIDES_ALL
    }
}

/// Resolve border / borderWidth / borderColor / borderRadius / cornerRadius.
///
/// Precedence (per attribute):
/// 1. `.borderWidth(N)` / `.borderColor(...)` / `.borderRadius(N)` /
///    `.cornerRadius(N)` (highest — explicit per-attribute setter).
/// 2. `.border(width: N, color: ..., radius: N)` (named-object form).
/// 3. `.border(N)` (single positional → width only).
pub fn border(node: &Node) -> Border {
    let viewport: Option<Viewport> = None;
    let mut width = 0.0_f32;
    let mut radius = 0.0_f32;
    // Track colour explicitly so an opaque-black default only kicks in
    // when no `.borderColor(...)` / `.border(color: ...)` was set —
    // otherwise an explicit `.borderColor("transparent")` would be
    // silently rewritten to black (Rgba::TRANSPARENT == Rgba::default()).
    let mut color: Option<Rgba> = None;

    if let Some(v) = prop_f32(node, "border") {
        width = v;
    }
    if let Some(v) = node
        .props
        .get("border.width")
        .and_then(|v| value_to_f32(v, viewport))
    {
        width = v;
    }
    if let Some(v) = node
        .props
        .get("border.color")
        .and_then(Value::as_str)
        .and_then(parse_color)
    {
        color = Some(v);
    }
    if let Some(v) = node
        .props
        .get("border.radius")
        .and_then(|v| value_to_f32(v, viewport))
    {
        radius = v;
    }
    if let Some(v) = prop_f32(node, "borderWidth") {
        width = v;
    }
    if let Some(v) = prop_color(node, "borderColor") {
        color = Some(v);
    }
    if let Some(v) = prop_f32(node, "borderRadius") {
        radius = v;
    }
    // Compose-flavoured alias for borderRadius.
    if let Some(v) = prop_f32(node, "cornerRadius") {
        radius = v;
    }

    Border {
        width,
        // A width without an explicit colour falls back to opaque black —
        // matches the DOM applicator's "default solid black" behaviour.
        color: color.unwrap_or(if width > 0.0 {
            Rgba::BLACK
        } else {
            Rgba::TRANSPARENT
        }),
        radius,
        sides: BORDER_SIDES_ALL,
    }
}

/// Viewport-aware [`border`] — honours `borderWidth@md` etc.
pub fn border_at(node: &Node, viewport: Viewport) -> Border {
    border_with(node, &VariantState::layout(viewport))
}

/// Variant-aware [`border`] — honours both breakpoints and interaction-
/// state variants on the geometry-affecting border-width props. Border
/// colour state variants are still handled by the painter via
/// [`StateVariants`]; this resolves the *width* (and radius / sides)
/// which feed Taffy.
pub fn border_with(node: &Node, vs: &VariantState) -> Border {
    let viewport = vs.viewport;
    let viewport_opt = Some(viewport);
    let mut width = 0.0_f32;
    let mut radius = 0.0_f32;
    let mut color: Option<Rgba> = None;
    let mut uniform_set = false;
    // Per-side widths feed `sides` and the eventual stroke width
    // — set when tw `border-b` / `border-t` / etc. emits a directional
    // key (e.g. `border-bottom-width: 1px`).
    let mut top: Option<f32> = None;
    let mut right: Option<f32> = None;
    let mut bottom: Option<f32> = None;
    let mut left: Option<f32> = None;

    if let Some(v) = prop_f32_with(node, "border", vs) {
        width = v;
        uniform_set = true;
    }
    // CSS `border` shorthand: `.border("1px solid #333")`. Not a bare
    // length, so the numeric read above rejects it and the border was
    // simply not drawn — todo's task rows lost their outline entirely
    // while rendering correctly on web, where this is just CSS.
    if let Some(sh) = prop_str_with(node, "border", vs).and_then(parse_border_shorthand) {
        if let Some(w) = sh.0 {
            width = w;
            uniform_set = true;
        }
        if let Some(c) = sh.1 {
            color = Some(c);
        }
    }
    if let Some(v) = node
        .props
        .get("border.width")
        .and_then(|v| value_to_f32(v, viewport_opt))
    {
        width = v;
        uniform_set = true;
    }
    if let Some(v) = node
        .props
        .get("border.color")
        .and_then(Value::as_str)
        .and_then(parse_color)
    {
        color = Some(v);
    }
    if let Some(v) = node
        .props
        .get("border.radius")
        .and_then(|v| value_to_f32(v, viewport_opt))
    {
        radius = v;
    }
    if let Some(v) = prop_f32_with(node, "borderWidth", vs) {
        width = v;
        uniform_set = true;
    }
    if let Some(v) = prop_color_at(node, "borderColor", viewport) {
        color = Some(v);
    }
    if let Some(v) = prop_f32_at(node, "borderRadius", viewport) {
        radius = v;
    }
    if let Some(v) = prop_f32_at(node, "cornerRadius", viewport) {
        radius = v;
    }
    // Per-side: tw `border-b` → `border-bottom-width: 1px`. We accept
    // both camelCase + kebab via the standard `prop_f32_with` chain
    // (variant-aware so `borderBottomWidth:hover` reaches layout).
    top = prop_f32_with(node, "borderTopWidth", vs);
    right = prop_f32_with(node, "borderRightWidth", vs);
    bottom = prop_f32_with(node, "borderBottomWidth", vs);
    left = prop_f32_with(node, "borderLeftWidth", vs);

    let sides = if uniform_set {
        BORDER_SIDES_ALL
    } else if top.is_some() || right.is_some() || bottom.is_some() || left.is_some() {
        // Only the explicitly-set sides draw. Width is the max of the
        // per-side widths (uniform stroke per visible side).
        let mut s = 0u8;
        if top.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_TOP;
        }
        if right.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_RIGHT;
        }
        if bottom.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_BOTTOM;
        }
        if left.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_LEFT;
        }
        width = [top, right, bottom, left]
            .iter()
            .filter_map(|v| *v)
            .fold(0.0_f32, |a, b| a.max(b));
        s
    } else {
        BORDER_SIDES_ALL
    };

    Border {
        width,
        color: color.unwrap_or(if width > 0.0 {
            Rgba::BLACK
        } else {
            Rgba::TRANSPARENT
        }),
        radius,
        sides,
    }
}

/// True if the user supplied any border-* prop on this node — even
/// if it resolved to `width: 0` (e.g. `.tw("border-0")`). Used by
/// Input's default frame logic to distinguish "user opted out" from
/// "user didn't say anything".
pub fn has_explicit_border(node: &Node) -> bool {
    const KEYS: &[&str] = &[
        "border",
        "border.0",
        "border.width",
        "border.color",
        "border.radius",
        "borderWidth",
        "borderWidth.0",
        "border-width",
        "borderColor",
        "borderColor.0",
        "border-color",
        "borderRadius",
        "borderRadius.0",
        "border-radius",
        "cornerRadius",
        "cornerRadius.0",
    ];
    KEYS.iter().any(|k| node.props.contains_key(*k))
}

/// `viewport: None` means no viewport basis is in scope at this call
/// site. Viewport units then read as *absent* rather than silently
/// collapsing to zero — a dropped prop is recoverable, a confidently
/// wrong `0` is not.
fn value_to_f32(v: &Value, viewport: Option<Viewport>) -> Option<f32> {
    match v {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) => parse_length(s, viewport),
        _ => None,
    }
}

/// Parse a CSS-ish length. `%` is *not* handled here — it is a
/// container-relative unit, so it resolves in [`parse_percent`] /
/// [`Dim::Percent`] where taffy can apply it against the real parent.
///
/// Accepts:
/// - `"16"`, `"16.5"` — bare numbers (treated as px).
/// - `"16px"` — explicit px.
/// - `"1rem"`, `"1.5rem"` — root-em, treated as 16px per rem (CSS
///   default; Hypen doesn't expose a custom root font size yet).
/// - `"1em"`, `"1.25em"` — same conversion as `rem` for now (we don't
///   track parent font-size during layout build).
/// - `"100vh"`, `"50vw"`, `"10vmin"`, `"10vmax"` — viewport units,
///   resolved against `viewport` (logical px) and returned in logical
///   px, matching every other length this function yields.
///
/// The viewport family matters more than its rarity suggests: Tailwind
/// lowers `h-screen` to `height: "100vh"`, so before these suffixes were
/// understood the parse failed and the height prop was dropped in
/// silence rather than erroring.
fn parse_length(s: &str, viewport: Option<Viewport>) -> Option<f32> {
    let trimmed = s.trim();
    // Order matters: `vmin`/`vmax` must be tried before `vw`/`vh`, whose
    // suffixes they do not share but whose *prefixes* they do — and `rem`
    // before `em` for the same reason. A `None` viewport means the unit
    // is unresolvable here, so fall through to `None` rather than 0.
    if let Some(vp) = viewport {
        for (suffix, basis) in [
            ("vmin", vp.vmin()),
            ("vmax", vp.vmax()),
            ("vw", vp.w),
            ("vh", vp.h),
        ] {
            if let Some(num) = trimmed.strip_suffix(suffix) {
                return num.trim().parse::<f32>().ok().map(|v| v * basis * 0.01);
            }
        }
    }
    // With `viewport: None` a viewport-unit string falls through to the
    // bare-number parse below and fails there, which is the intended
    // "unresolvable" answer.
    if let Some(num) = trimmed.strip_suffix("rem") {
        return num.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    if let Some(num) = trimmed.strip_suffix("em") {
        return num.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    let stripped = trimmed.strip_suffix("px").unwrap_or(trimmed);
    stripped.trim().parse::<f32>().ok()
}

/// Parse a dimension prop that may carry a `%` unit. Returns the
/// numeric portion in [0, 1] for percent; `None` for length-only or
/// unparseable. Callers should fall through to `parse_length` /
/// `prop_f32_at` when this returns `None`.
pub(crate) fn parse_percent(s: &str) -> Option<f32> {
    let trimmed = s.trim();
    let num = trimmed.strip_suffix('%')?;
    num.trim().parse::<f32>().ok().map(|v| v * 0.01)
}

/// Parse a CSS-style aspect-ratio value: `"1 / 1"`, `"16 / 9"`, or a
/// bare `"1.5"`. Returns the numeric ratio (`width / height`). Tailwind
/// `aspect-square` expands to `aspect-ratio: "1 / 1"`, which
/// `parse_length` can't handle (the slash trips it up) — so without
/// this helper every `aspect-square` Image silently dropped its
/// aspect-ratio and fell back to the default 60px square.
pub fn parse_aspect_ratio(s: &str) -> Option<f32> {
    let s = s.trim();
    if let Some((num, den)) = s.split_once('/') {
        let num = num.trim().parse::<f32>().ok()?;
        let den = den.trim().parse::<f32>().ok()?;
        if den > 0.0 {
            return Some(num / den);
        }
        return None;
    }
    s.parse::<f32>().ok()
}

/// Read an aspect-ratio prop the same way `prop_f32_at` reads other
/// numerics, but with the CSS slash form (`"1 / 1"`) accepted on
/// strings. Falls back to the bare-number reader so explicit
/// `.aspectRatio(1.5)` still works.
pub fn prop_aspect_ratio_at(node: &Node, name: &str, viewport: Viewport) -> Option<f32> {
    prop_aspect_ratio_with(node, name, &VariantState::layout(viewport))
}

/// Variant-aware [`prop_aspect_ratio_at`].
pub fn prop_aspect_ratio_with(node: &Node, name: &str, vs: &VariantState) -> Option<f32> {
    // String form (the kebab path that tw emits) — try every key
    // variant `prop_str_with` would check, but route through
    // `parse_aspect_ratio` so `"X / Y"` resolves.
    if let Some(s) = prop_str_with(node, name, vs) {
        if let Some(v) = parse_aspect_ratio(s) {
            return Some(v);
        }
    }
    prop_f32_with(node, name, vs)
}

// ---------------------------------------------------------------------------
// Linear gradient parser
//
// The Tailwind parser emits `background-image: linear-gradient(<dir>, var(--tw-
// gradient-stops))` plus three CSS custom properties — `--tw-gradient-from`,
// `--tw-gradient-via` (optional), `--tw-gradient-to` — that hold the stop
// colours. This module substitutes the `var()` chain and parses the
// resulting CSS gradient string into a `LinearGradient` the painter can
// hand to Vello.
// ---------------------------------------------------------------------------

/// A single stop in a linear gradient: a colour and an optional offset
/// in the range `0.0..=1.0`. Stops without an explicit offset get
/// auto-distributed by the painter (or by the test that hits
/// `LinearGradient::resolved_offsets`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradientStop {
    pub color: Rgba,
    pub offset: Option<f32>,
}

/// CSS-style direction for a linear gradient. Either a cardinal-ish
/// keyword (`to right`, `to bottom right`, …) or an angle in degrees
/// where `0deg` points up and rotation is clockwise — matching the CSS
/// spec.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GradientDirection {
    ToTop,
    ToTopRight,
    ToRight,
    ToBottomRight,
    ToBottom,
    ToBottomLeft,
    ToLeft,
    ToTopLeft,
    /// CSS-degrees: 0 = up, 90 = right, 180 = down, 270 = left.
    Angle(f32),
}

impl GradientDirection {
    /// Compute the linear-gradient axis endpoints `(start, end)` in
    /// the rect's coordinate space. For keyword directions this maps
    /// to the rect's corners / mid-edges; for `Angle(θ)` it projects
    /// the diagonal that crosses the rect along the direction the
    /// CSS spec defines (perpendicular to the gradient line, passing
    /// through the rect centre, intersecting the two edges).
    pub fn axis(&self, x: f32, y: f32, w: f32, h: f32) -> ((f32, f32), (f32, f32)) {
        let cx = x + w * 0.5;
        let cy = y + h * 0.5;
        match self {
            GradientDirection::ToTop => ((cx, y + h), (cx, y)),
            GradientDirection::ToBottom => ((cx, y), (cx, y + h)),
            GradientDirection::ToRight => ((x, cy), (x + w, cy)),
            GradientDirection::ToLeft => ((x + w, cy), (x, cy)),
            GradientDirection::ToTopRight => ((x, y + h), (x + w, y)),
            GradientDirection::ToBottomRight => ((x, y), (x + w, y + h)),
            GradientDirection::ToBottomLeft => ((x + w, y), (x, y + h)),
            GradientDirection::ToTopLeft => ((x + w, y + h), (x, y)),
            GradientDirection::Angle(deg) => {
                // CSS: 0deg = up, clockwise. The axis goes through
                // the centre; its length is set so the endpoints
                // land on the projection of the rect's bbox onto
                // the gradient line — that's what makes the visible
                // colour transition span the rect exactly once
                // regardless of the angle.
                let rad = deg.to_radians();
                let dx = rad.sin();
                let dy = -rad.cos();
                let half_w = w * 0.5;
                let half_h = h * 0.5;
                let len = (dx.abs() * half_w) + (dy.abs() * half_h);
                let sx = cx - dx * len;
                let sy = cy - dy * len;
                let ex = cx + dx * len;
                let ey = cy + dy * len;
                ((sx, sy), (ex, ey))
            }
        }
    }
}

/// Resolved linear gradient ready for the painter.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearGradient {
    pub direction: GradientDirection,
    pub stops: Vec<GradientStop>,
}

impl LinearGradient {
    /// Return `stops` with any `None` offsets distributed evenly
    /// between the first/last fixed stops, falling back to the CSS
    /// default of (0, 1) for the bare two-stop case and even spacing
    /// otherwise. Used by the painter when handing stops to Vello,
    /// which requires explicit offsets.
    pub fn resolved_offsets(&self) -> Vec<(f32, Rgba)> {
        resolve_stop_offsets(&self.stops)
    }
}

/// Shared stop-offset resolution for linear AND radial gradients,
/// following the CSS rules: an unspecified first/last stop defaults to
/// 0/1, a specified offset below the running maximum is raised to it,
/// and each RUN of unspecified stops is distributed evenly between its
/// neighbouring specified stops — not across the whole gradient, which
/// would collapse e.g. `red 50%, blue, green` into a hard edge at 50%
/// instead of CSS's blue-at-75%.
fn resolve_stop_offsets(stops: &[GradientStop]) -> Vec<(f32, Rgba)> {
    let n = stops.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        // CSS treats a single stop as a flat fill — emit it at
        // 0 and 1 so Vello has a valid gradient.
        let s = stops[0];
        let off = s.offset.unwrap_or(0.0);
        return vec![(off, s.color), (1.0, s.color)];
    }
    let mut offs: Vec<Option<f32>> = stops.iter().map(|s| s.offset).collect();
    if offs[0].is_none() {
        offs[0] = Some(0.0);
    }
    if offs[n - 1].is_none() {
        offs[n - 1] = Some(1.0);
    }
    // Specified offsets are clamped non-decreasing first (CSS raises
    // any position below the previous maximum), so the interpolation
    // below always works with ordered anchors.
    let mut max = offs[0].unwrap();
    for off in offs.iter_mut().skip(1).flatten() {
        if *off < max {
            *off = max;
        }
        max = *off;
    }
    // Fill each run of unspecified stops evenly between its anchors.
    let mut i = 1;
    while i < n {
        if offs[i].is_none() {
            let start = offs[i - 1].unwrap();
            let mut j = i;
            while offs[j].is_none() {
                j += 1;
            }
            let end = offs[j].unwrap();
            let span = (j - i + 1) as f32;
            for (k, slot) in offs[i..j].iter_mut().enumerate() {
                *slot = Some(start + (end - start) * ((k + 1) as f32) / span);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    offs.into_iter()
        .map(Option::unwrap)
        .zip(stops.iter().map(|s| s.color))
        .collect()
}

/// Parse a CSS `linear-gradient(<direction>, <stop>, <stop>, ...)` value.
/// Returns `None` for any other CSS value (radial-gradient, plain colour,
/// `url()`, malformed input). Whitespace-tolerant, case-insensitive on
/// the `linear-gradient` keyword.
pub fn parse_linear_gradient(s: &str) -> Option<LinearGradient> {
    let s = gradient_body(s, "linear-gradient(")?;

    let parts = split_top_level_commas(s);
    if parts.is_empty() {
        return None;
    }
    let first = parts[0].trim();
    let (direction, stops_start) = if let Some(dir) = parse_direction(first) {
        (dir, 1)
    } else {
        // CSS defaults to `to bottom` when no direction is given —
        // the first comma-separated chunk is then a stop.
        (GradientDirection::ToBottom, 0)
    };

    let stops: Vec<GradientStop> = parts[stops_start..]
        .iter()
        .filter_map(|p| parse_stop(p.trim()))
        .collect();
    if stops.len() < 1 {
        return None;
    }
    Some(LinearGradient { direction, stops })
}

/// Extract the argument body of a `<prefix>(...)` gradient call:
/// case-insensitive on the prefix, and the closing paren must be the
/// MATCHING one with nothing but whitespace after it. A bare
/// `strip_suffix(')')` here mis-parsed a multi-layer value
/// (`linear-gradient(a, b), linear-gradient(c, d)`) into one garbage
/// gradient built from the first and last stops — a whole-value parser
/// must reject layer lists and leave them to `parse_background_value`.
fn gradient_body<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let s = s.trim();
    if s.len() < prefix.len() || !s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    let start = prefix.len();
    let mut depth = 1usize;
    for (i, ch) in s[start..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + i;
                    if !s[end + 1..].trim().is_empty() {
                        return None;
                    }
                    return Some(&s[start..end]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Split `s` on commas at depth-0 only, so commas inside nested
/// `rgb(... , ... , ...)` / `var(...)` don't terminate a stop.
fn split_top_level_commas(s: &str) -> Vec<String> {
    let mut depth: i32 = 0;
    let mut current = String::new();
    let mut out: Vec<String> = Vec::new();
    for c in s.chars() {
        match c {
            '(' => {
                depth += 1;
                current.push(c);
            }
            ')' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

fn parse_direction(s: &str) -> Option<GradientDirection> {
    let lower = s.to_ascii_lowercase();
    match lower.as_str() {
        "to top" => Some(GradientDirection::ToTop),
        "to top right" | "to right top" => Some(GradientDirection::ToTopRight),
        "to right" => Some(GradientDirection::ToRight),
        "to bottom right" | "to right bottom" => Some(GradientDirection::ToBottomRight),
        "to bottom" => Some(GradientDirection::ToBottom),
        "to bottom left" | "to left bottom" => Some(GradientDirection::ToBottomLeft),
        "to left" => Some(GradientDirection::ToLeft),
        "to top left" | "to left top" => Some(GradientDirection::ToTopLeft),
        _ => {
            // Angle form: `<number>deg` (also accept rad/grad/turn).
            if let Some(num) = lower.strip_suffix("deg") {
                num.trim().parse::<f32>().ok().map(GradientDirection::Angle)
            } else if let Some(num) = lower.strip_suffix("turn") {
                num.trim()
                    .parse::<f32>()
                    .ok()
                    .map(|t| GradientDirection::Angle(t * 360.0))
            } else if let Some(num) = lower.strip_suffix("rad") {
                num.trim()
                    .parse::<f32>()
                    .ok()
                    .map(|r| GradientDirection::Angle(r.to_degrees()))
            } else {
                None
            }
        }
    }
}

fn parse_stop(s: &str) -> Option<GradientStop> {
    // Stop syntax: `<color>` or `<color> <position>` where position
    // is a percent (`50%`) or a length (we treat as 0..=1 fraction
    // by interpreting bare numbers as fractions in 0..1 — Tailwind
    // doesn't emit lengths here, only colours and percents).
    //
    // Splitting on whitespace is tricky because `rgb(255, 0, 0)`
    // contains spaces inside parens. Find the last whitespace at
    // depth 0; if the trailing token parses as a percent that's our
    // offset, otherwise treat the whole thing as a colour.
    let (color_part, offset_part) = split_color_offset(s);
    let color = parse_color(color_part.trim())?;
    let offset = offset_part.and_then(|o| {
        let trimmed = o.trim();
        if let Some(p) = trimmed.strip_suffix('%') {
            p.trim().parse::<f32>().ok().map(|v| v * 0.01)
        } else {
            trimmed.parse::<f32>().ok()
        }
    });
    Some(GradientStop { color, offset })
}

fn split_color_offset(s: &str) -> (&str, Option<&str>) {
    let mut depth: i32 = 0;
    let mut last_ws_at_zero: Option<usize> = None;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if depth == 0 && c.is_whitespace() => last_ws_at_zero = Some(i),
            _ => {}
        }
    }
    match last_ws_at_zero {
        Some(idx) => {
            let head = s[..idx].trim_end();
            let tail = s[idx..].trim_start();
            // Verify the tail looks like an offset — a percent OR a
            // bare number. Without this, multi-word colour values
            // (just hypothetical here — `rgb(...)` has parens, not
            // spaces, but defence-in-depth) would lose their
            // trailing token.
            if tail.ends_with('%') || tail.parse::<f32>().is_ok() {
                (head, Some(tail))
            } else {
                (s, None)
            }
        }
        None => (s, None),
    }
}

/// Read a node's gradient background. Two paths, in priority order:
///
/// 1. The first-class `.linearGradient(direction, colors)` applicator —
///    a direct DSL hook that bypasses Tailwind's `var(--tw-…)`
///    indirection entirely. The engine flattens applicators into
///    namespaced props (single-positional → `.0`; named →
///    `.<key>`), so we accept either form. The colors argument is a
///    list literal; each entry is parsed via `parse_color`.
///
/// 2. The Tailwind path: `background-image: linear-gradient(...)` with
///    `var(--tw-gradient-stops/from/via/to)` references. Resolved by
///    `substitute_tw_gradient_vars`, then parsed.
///
/// Returns `None` when neither path produces a gradient.
pub fn prop_linear_gradient(node: &Node, viewport: Viewport) -> Option<LinearGradient> {
    let _ = viewport; // gradients aren't viewport-keyed (yet)
    if let Some(g) = read_linear_gradient_applicator(node) {
        return Some(g);
    }
    // `prop_str` rather than a raw `props.get`: the engine flattens
    // applicator args, so the wire key is `backgroundImage.0`, not
    // `backgroundImage`. Reading the bare names missed every Tailwind
    // `bg-gradient-to-*` tile — they arrived as
    // `backgroundImage.0 = linear-gradient(...)` and rendered flat.
    let raw = prop_str(node, "backgroundImage")?;
    let resolved = substitute_tw_gradient_vars(node, raw);
    parse_linear_gradient(&resolved)
}

/// Extract a background IMAGE source from a node.
///
/// Reads the CSS `background` shorthand as well as `background-image`,
/// because a layered value puts both in one prop:
///
/// ```text
/// background: linear-gradient(...), url('data:image/png;base64,...') center / cover no-repeat
/// ```
///
/// Only the `url(...)` layer is returned — the gradient layer is handled by
/// [`prop_linear_gradient`], and the trailing position/size/repeat keywords
/// aren't expressible here (`cover` is what the painter does anyway).
///
/// Splitting is paren- and quote-aware: a layer list is comma-separated, but
/// so are `rgba(3, 7, 18, 0.6)` and a gradient's colour stops, and a base64
/// payload can contain anything. A naive `split(',')` shreds all three.
pub fn prop_background_image_url(node: &Node) -> Option<String> {
    for name in ["background", "backgroundImage"] {
        let Some(raw) = prop_str(node, name) else {
            continue;
        };
        for layer in split_top_level(raw) {
            if let Some(url) = extract_url(layer.trim()) {
                return Some(url);
            }
        }
    }
    None
}

/// Split on commas that are not nested inside parentheses or quotes.
fn split_top_level(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    for ch in value.chars() {
        match quote {
            Some(q) => {
                current.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => match ch {
                '\'' | '"' => {
                    current.push(ch);
                    quote = Some(ch);
                }
                '(' => {
                    depth += 1;
                    current.push(ch);
                }
                ')' => {
                    depth = depth.saturating_sub(1);
                    current.push(ch);
                }
                ',' if depth == 0 => {
                    parts.push(std::mem::take(&mut current));
                }
                _ => current.push(ch),
            },
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// `url('...')` / `url(...)` anywhere in a layer -> the bare URI.
fn extract_url(layer: &str) -> Option<String> {
    extract_url_span(layer).map(|(_, _, uri)| uri)
}

/// Locate the `url(...)` call in a layer: returns the byte range of the
/// whole call (`url(` through the matching `)` inclusive) plus the bare
/// URI, so callers can also inspect what surrounds the call — the CSS
/// shorthand allows `<color> url(...) center / cover` in ONE layer.
fn extract_url_span(layer: &str) -> Option<(usize, usize, String)> {
    let lower = layer.to_ascii_lowercase();
    let call_start = lower.find("url(")?;
    let start = call_start + 4;
    let mut depth = 1usize;
    let mut end = start;
    for (i, ch) in layer[start..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    let uri = layer[start..end].trim().trim_matches(['\'', '"']).trim();
    if uri.is_empty() {
        None
    } else {
        Some((call_start, end + 1, uri.to_string()))
    }
}

/// Split on whitespace at paren depth 0, so `rgba(3, 7, 18, 0.6)`
/// survives as one token. Used to fish a colour out of the non-`url`
/// remainder of a shorthand layer.
fn split_top_level_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            c if c.is_whitespace() && depth == 0 => {
                if let Some(st) = start.take() {
                    out.push(&s[st..i]);
                }
                continue;
            }
            _ => {}
        }
        if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(st) = start {
        out.push(&s[st..]);
    }
    out
}

/// Parse the CSS `border` shorthand — `1px solid #333`, `2px #f00`,
/// `solid red`. Returns `(width, colour)`, either of which may be
/// absent; the line style is deliberately dropped, since the painter
/// only strokes solid.
///
/// Order-independent per CSS: whichever token parses as a length is the
/// width, whichever parses as a colour is the colour, and the style
/// keyword is ignored. Returns `None` when nothing usable was found, so
/// callers can distinguish "not a shorthand" from "shorthand with
/// defaults".
fn parse_border_shorthand(s: &str) -> Option<(Option<f32>, Option<Rgba>)> {
    const STYLES: &[&str] = &[
        "none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset",
        "outset",
    ];
    let mut width = None;
    let mut color = None;
    for tok in s.split_whitespace() {
        if STYLES.contains(&tok.to_ascii_lowercase().as_str()) {
            continue;
        }
        if width.is_none() {
            // No viewport: a viewport-relative border width is vanishingly
            // rare and resolving it here would need threading one in.
            if let Some(w) = parse_length(tok, None) {
                width = Some(w);
                continue;
            }
        }
        if color.is_none() {
            if let Some(c) = parse_color(tok) {
                color = Some(c);
            }
        }
    }
    if width.is_none() && color.is_none() {
        return None;
    }
    Some((width, color))
}

/// First-class applicator path: read `.linearGradient(..)` props off
/// the node. The engine flattens applicators to `linearGradient.0` /
/// `linearGradient.1` (positional) or `linearGradient.direction` /
/// `linearGradient.colors` (named). Three forms are accepted:
///
/// - `.linearGradient(direction, [colors])` — two args, stops as a list.
/// - `.linearGradient(direction: .., colors: ..)` — the same, named.
/// - `.linearGradient("135deg, #EC4899 0%, #F472B6 100%")` — one arg
///   holding the whole CSS gradient *body*, which is what the DOM
///   renderer lowers to `linear-gradient(<body>)` and what
///   movie-discovery's featured card and search button actually use.
///
/// The single-argument form used to fall through to `None` here (no
/// `.1` prop) and then miss again on `backgroundImage`, so those
/// surfaces painted no gradient at all on desktop while rendering
/// correctly on web.
fn read_linear_gradient_applicator(node: &Node) -> Option<LinearGradient> {
    let dir_str = node
        .props
        .get("linearGradient.direction")
        .or_else(|| node.props.get("linearGradient.0"))
        .and_then(|v| v.as_str())?;
    let Some(colors_val) = node
        .props
        .get("linearGradient.colors")
        .or_else(|| node.props.get("linearGradient.1"))
    else {
        // One-argument form: hand the body to the CSS parser, which
        // already understands angles, `to <side>`, and per-stop offsets.
        return parse_linear_gradient(&format!("linear-gradient({})", dir_str.trim()));
    };
    let direction = parse_direction(dir_str.trim())?;
    let colors = colors_val.as_array()?;
    let stops: Vec<GradientStop> = colors
        .iter()
        .filter_map(|c| {
            let s = c.as_str()?;
            Some(GradientStop {
                color: parse_color(s)?,
                offset: None,
            })
        })
        .collect();
    if stops.is_empty() {
        return None;
    }
    Some(LinearGradient { direction, stops })
}

/// Lex-substitute `var(--tw-gradient-stops)`, then
/// `var(--tw-gradient-from)`, `var(--tw-gradient-via)`,
/// `var(--tw-gradient-to)` references using the node's props. Two
/// passes — `--tw-gradient-stops` itself expands to a list that
/// then contains the per-colour vars — so we just loop until no
/// more `var(--tw-` substring remains or the substitution count
/// hits a sanity cap. Lex substitution is fine because the
/// Tailwind output is grammar-free (string interpolation only).
pub fn substitute_tw_gradient_vars(node: &Node, raw: &str) -> String {
    fn read_var(node: &Node, name: &str) -> Option<String> {
        node.props
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
    let mut s = raw.to_string();
    for _ in 0..4 {
        // Each loop replaces one `var(--tw-gradient-…)`. The
        // capped count guards against pathological recursion that
        // a buggy emitter could produce; in practice 2 iterations
        // suffice (stops → from/via/to).
        let mut replaced = false;
        for name in &[
            "--tw-gradient-stops",
            "--tw-gradient-from",
            "--tw-gradient-via",
            "--tw-gradient-to",
        ] {
            let needle = format!("var({})", name);
            if let Some(idx) = s.find(&needle) {
                let value = read_var(node, name).unwrap_or_default();
                s.replace_range(idx..idx + needle.len(), &value);
                replaced = true;
                break;
            }
        }
        if !replaced {
            break;
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Radial gradients + layered `background` shorthand
//
// Mirrors the layer model of `CssBackground.kt` / `CssBackground.swift`
// in the mobile renderers: a `background` value is a comma-separated
// stack of layers (gradients, `url(...)` images, at most one solid
// colour), declared top-first. The home-screen icon tiles are exactly
// this shape — `radial-gradient(<sheen>), linear-gradient(<brand>)` —
// and used to paint nothing on desktop because only a lone
// `linear-gradient` in `backgroundImage` was understood.
// ---------------------------------------------------------------------------

/// A radius component of an explicit radial-gradient size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RadialLen {
    /// Logical pixels.
    Px(f32),
    /// Fraction of the box axis (percent / 100): `rx` resolves against
    /// the width, `ry` against the height, per CSS.
    Pct(f32),
}

impl RadialLen {
    fn resolve(self, basis: f32) -> f32 {
        match self {
            RadialLen::Px(v) => v,
            RadialLen::Pct(f) => f * basis,
        }
    }
}

/// The size of a radial gradient's ending shape.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RadialExtent {
    ClosestSide,
    FarthestSide,
    ClosestCorner,
    /// The CSS default.
    FarthestCorner,
    /// Explicit radii: `radial-gradient(85% 60% at ..)` or a single
    /// length for a circle.
    Explicit {
        rx: RadialLen,
        ry: RadialLen,
    },
}

/// Parsed CSS `radial-gradient(...)`, resolved against a rect at paint
/// time (the extent keywords and percent radii all need the box size).
#[derive(Debug, Clone, PartialEq)]
pub struct RadialGradient {
    /// `circle` forces equal radii; `ellipse` (the CSS default) lets
    /// them differ.
    pub circle: bool,
    pub extent: RadialExtent,
    /// Centre as fractions of the box (`at 24% 14%` → `(0.24, 0.14)`).
    /// Defaults to `(0.5, 0.5)`.
    pub center: (f32, f32),
    pub stops: Vec<GradientStop>,
}

impl RadialGradient {
    /// Stops with explicit offsets, ready for Vello (see
    /// [`LinearGradient::resolved_offsets`]).
    pub fn resolved_offsets(&self) -> Vec<(f32, Rgba)> {
        resolve_stop_offsets(&self.stops)
    }

    /// Resolve the ending-shape radii `(rx, ry)` for a `w`×`h` box in
    /// the box's own (physical-pixel) space; `scale` is the display
    /// scale factor, applied to explicit `Px` radii only — percent
    /// radii and the extent keywords already resolve against the
    /// physical box. Implements the CSS extent keywords; the corner
    /// keywords use the spec's rule for ellipses (the same-closeness
    /// side ellipse scaled by √2 so it passes through the corner).
    pub fn resolve_radii(&self, w: f32, h: f32, scale: f32) -> (f32, f32) {
        let cx = self.center.0 * w;
        let cy = self.center.1 * h;
        let (near_x, far_x) = (cx.min(w - cx).abs(), cx.max(w - cx).abs());
        let (near_y, far_y) = (cy.min(h - cy).abs(), cy.max(h - cy).abs());
        let (mut rx, mut ry) = match self.extent {
            RadialExtent::Explicit { rx, ry } => {
                let px_scale = |len: RadialLen, basis: f32| match len {
                    RadialLen::Px(v) => v * scale,
                    RadialLen::Pct(_) => len.resolve(basis),
                };
                (px_scale(rx, w), px_scale(ry, h))
            }
            RadialExtent::ClosestSide => (near_x, near_y),
            RadialExtent::FarthestSide => (far_x, far_y),
            RadialExtent::ClosestCorner => {
                let side = (near_x, near_y);
                (
                    side.0 * std::f32::consts::SQRT_2,
                    side.1 * std::f32::consts::SQRT_2,
                )
            }
            RadialExtent::FarthestCorner => {
                let side = (far_x, far_y);
                (
                    side.0 * std::f32::consts::SQRT_2,
                    side.1 * std::f32::consts::SQRT_2,
                )
            }
        };
        if self.circle && !matches!(self.extent, RadialExtent::Explicit { .. }) {
            // A circle's keyword extents measure straight-line
            // distances, not per-axis ones.
            let r = match self.extent {
                RadialExtent::ClosestSide => near_x.min(near_y),
                RadialExtent::FarthestSide => far_x.max(far_y),
                RadialExtent::ClosestCorner => near_x.hypot(near_y),
                RadialExtent::FarthestCorner => far_x.hypot(far_y),
                RadialExtent::Explicit { .. } => unreachable!(),
            };
            rx = r;
            ry = r;
        }
        (rx.max(0.0), ry.max(0.0))
    }
}

/// Parse a CSS `radial-gradient(<shape/size/position>?, <stop>, ...)`
/// value. Returns `None` for any other CSS value. Prelude support:
/// `circle` / `ellipse`, the four extent keywords, explicit radii
/// (`<len|pct>{1,2}`), and `at <position>` with percent or keyword
/// components. A prelude it can't make sense of degrades to the CSS
/// defaults (ellipse, farthest-corner, centred) rather than dropping
/// the gradient.
pub fn parse_radial_gradient(s: &str) -> Option<RadialGradient> {
    let inner = gradient_body(s, "radial-gradient(")?;

    let parts = split_top_level_commas(inner);
    if parts.is_empty() {
        return None;
    }

    let mut circle = false;
    let mut extent = RadialExtent::FarthestCorner;
    let mut center = (0.5f32, 0.5f32);
    let first = parts[0].trim();
    // A chunk that parses as a colour stop is never a prelude
    // (`rgba(...)`, `red 10%`); anything else gets a prelude attempt.
    let stops_start = if parse_stop(first).is_none() {
        if let Some((c, e, ctr)) = parse_radial_prelude(first) {
            circle = c;
            extent = e;
            center = ctr;
        }
        1
    } else {
        0
    };

    let stops: Vec<GradientStop> = parts[stops_start..]
        .iter()
        .filter_map(|p| parse_stop(p.trim()))
        .collect();
    if stops.is_empty() {
        return None;
    }
    Some(RadialGradient {
        circle,
        extent,
        center,
        stops,
    })
}

/// `circle at 24% 14%` / `85% 60% at 50% 38%` / `closest-side` →
/// `(circle, extent, center)`. Returns `None` when nothing in the
/// chunk is recognisable, letting the caller fall back to defaults.
fn parse_radial_prelude(s: &str) -> Option<(bool, RadialExtent, (f32, f32))> {
    let lower = s.to_ascii_lowercase();
    let (shape_part, pos_part) = match lower.split_once(" at ") {
        Some((a, b)) => (a.trim(), Some(b.trim())),
        None => match lower.strip_prefix("at ") {
            Some(rest) => ("", Some(rest.trim())),
            None => (lower.as_str(), None),
        },
    };

    let mut circle = false;
    let mut ellipse = false;
    let mut extent: Option<RadialExtent> = None;
    let mut radii: Vec<RadialLen> = Vec::new();
    let mut recognised = pos_part.is_some();
    for tok in shape_part.split_whitespace() {
        match tok {
            "circle" => {
                circle = true;
                recognised = true;
            }
            "ellipse" => {
                ellipse = true;
                recognised = true;
            }
            "closest-side" => {
                extent = Some(RadialExtent::ClosestSide);
                recognised = true;
            }
            "farthest-side" => {
                extent = Some(RadialExtent::FarthestSide);
                recognised = true;
            }
            "closest-corner" => {
                extent = Some(RadialExtent::ClosestCorner);
                recognised = true;
            }
            "farthest-corner" => {
                extent = Some(RadialExtent::FarthestCorner);
                recognised = true;
            }
            _ => {
                if let Some(len) = parse_radial_len(tok) {
                    radii.push(len);
                    recognised = true;
                } else {
                    return None;
                }
            }
        }
    }
    if !recognised {
        return None;
    }

    let extent = match (extent, radii.as_slice()) {
        (Some(e), _) => e,
        (None, [r]) => RadialExtent::Explicit { rx: *r, ry: *r },
        (None, [rx, ry, ..]) => RadialExtent::Explicit { rx: *rx, ry: *ry },
        (None, []) => RadialExtent::FarthestCorner,
    };
    // One radius means a circle unless `ellipse` was explicit; two
    // radii force an ellipse per CSS.
    let circle = if radii.len() >= 2 {
        false
    } else {
        circle || (radii.len() == 1 && !ellipse)
    };

    let mut center = (0.5f32, 0.5f32);
    if let Some(pos) = pos_part {
        let pct = |tok: &str| {
            tok.strip_suffix('%')
                .and_then(|p| p.trim().parse::<f32>().ok())
                .map(|v| v * 0.01)
        };
        let toks: Vec<&str> = pos.split_whitespace().collect();
        let mut x: Option<f32> = None;
        let mut y: Option<f32> = None;
        let mut i = 0;
        while i < toks.len() {
            // CSS 4-value syntax pairs an edge keyword with an offset
            // FROM that edge (`right 20%` → x = 1 − 0.2); a keyword
            // alone is the edge itself; a bare percent fills the next
            // positional axis (x, then y).
            let offset = toks.get(i + 1).copied().and_then(pct);
            let step = if offset.is_some() { 2 } else { 1 };
            match toks[i] {
                "left" => {
                    x = Some(offset.unwrap_or(0.0));
                    i += step;
                }
                "right" => {
                    x = Some(1.0 - offset.unwrap_or(0.0));
                    i += step;
                }
                "top" => {
                    y = Some(offset.unwrap_or(0.0));
                    i += step;
                }
                "bottom" => {
                    y = Some(1.0 - offset.unwrap_or(0.0));
                    i += step;
                }
                "center" => {
                    // Consumes a positional slot: `at center 30%` puts
                    // the 30% on the y axis.
                    if x.is_none() {
                        x = Some(0.5);
                    } else if y.is_none() {
                        y = Some(0.5);
                    }
                    i += 1;
                }
                tok => {
                    if let Some(f) = pct(tok) {
                        if x.is_none() {
                            x = Some(f);
                        } else if y.is_none() {
                            y = Some(f);
                        }
                    }
                    i += 1;
                }
            }
        }
        center = (x.unwrap_or(0.5), y.unwrap_or(0.5));
    }
    Some((circle, extent, center))
}

/// `85%` → `Pct(0.85)`, `120px` / `120` → `Px(120)`.
fn parse_radial_len(tok: &str) -> Option<RadialLen> {
    if let Some(p) = tok.strip_suffix('%') {
        return p
            .trim()
            .parse::<f32>()
            .ok()
            .map(|v| RadialLen::Pct(v * 0.01));
    }
    let num = tok.strip_suffix("px").unwrap_or(tok);
    num.trim().parse::<f32>().ok().map(RadialLen::Px)
}

/// One paintable layer of a CSS `background` value.
#[derive(Debug, Clone, PartialEq)]
pub enum BackgroundLayer {
    /// `url(...)` — a `data:` or remote image URI, painted
    /// `center / cover` like the shorthand's position/size keywords ask.
    Image(String),
    Linear(LinearGradient),
    Radial(RadialGradient),
}

/// A parsed CSS `background` shorthand, decomposed for the painter.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedBackground {
    /// Solid colour layer — CSS paints it bottom-most.
    pub color: Option<Rgba>,
    /// Image/gradient layers in PAINT order (bottom first) — CSS
    /// declaration order reversed. Kept as one interleaved list because
    /// `url(…), linear-gradient(…)` and `linear-gradient(…), url(…)`
    /// stack in opposite orders.
    pub layers: Vec<BackgroundLayer>,
}

impl ParsedBackground {
    pub fn is_empty(&self) -> bool {
        self.color.is_none() && self.layers.is_empty()
    }
}

/// Parse a full CSS `background` / `background-image` value into its
/// layer stack. Unsupported layers (e.g. `conic-gradient`) are dropped
/// individually rather than failing the whole value; returns `None`
/// when nothing in it is expressible.
pub fn parse_background_value(value: &str) -> Option<ParsedBackground> {
    let mut out = ParsedBackground::default();
    let mut declared: Vec<BackgroundLayer> = Vec::new();
    for raw in split_top_level(value) {
        let layer = raw.trim();
        if layer.is_empty() {
            continue;
        }
        let lower = layer.to_ascii_lowercase();
        if lower.contains("url(") {
            // `url('…') center / cover no-repeat` — the trailing
            // position/size/repeat keywords aren't expressible;
            // `cover` is what the painter does anyway. The classic
            // single-layer shorthand also puts the colour here
            // (`background: #030712 url(...) center / cover`), so scan
            // the non-url remainder for one — it must not vanish just
            // because it shares a layer with the image.
            if let Some((call_start, call_end, uri)) = extract_url_span(layer) {
                declared.push(BackgroundLayer::Image(uri));
                if out.color.is_none() {
                    let rest = format!("{} {}", &layer[..call_start], &layer[call_end..]);
                    out.color = split_top_level_ws(&rest).into_iter().find_map(parse_color);
                }
            }
        } else if lower.starts_with("linear-gradient(") {
            if let Some(g) = parse_linear_gradient(layer) {
                declared.push(BackgroundLayer::Linear(g));
            }
        } else if lower.starts_with("radial-gradient(") {
            if let Some(g) = parse_radial_gradient(layer) {
                declared.push(BackgroundLayer::Radial(g));
            }
        } else if lower == "none" {
            continue;
        } else if out.color.is_none() {
            out.color = parse_color(layer);
        }
    }
    declared.reverse();
    out.layers = declared;
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Read a node's layered background, the paths the single-gradient
/// reader ([`prop_linear_gradient`]) can't express:
///
/// 1. The CSS `background` shorthand — `.background("radial-…, linear-…")`
///    from the DSL. The whole stack is returned, colour included.
/// 2. The first-class `.radialGradient("<body>")` applicator, mirroring
///    the DOM renderer's lowering to `radial-gradient(<body>)`.
/// 3. `backgroundImage` values the legacy path would drop: a
///    `radial-gradient(...)` or a multi-layer list. A lone
///    `linear-gradient(...)` (incl. the Tailwind `var(--tw-…)` form) and
///    a lone `url(...)` stay `None` here so those tested paths keep
///    handling them.
///
/// Returns `None` for the common solid-colour node so the painter's
/// existing fast paths are undisturbed.
pub fn prop_background_layers(node: &Node) -> Option<ParsedBackground> {
    if let Some(raw) = prop_str(node, "background") {
        if let Some(parsed) = parse_background_value(raw) {
            return Some(parsed);
        }
    }
    if let Some(body) = prop_str(node, "radialGradient") {
        if let Some(g) = parse_radial_gradient(&format!("radial-gradient({})", body.trim())) {
            return Some(ParsedBackground {
                color: None,
                layers: vec![BackgroundLayer::Radial(g)],
            });
        }
    }
    if let Some(raw) = prop_str(node, "backgroundImage") {
        let resolved = substitute_tw_gradient_vars(node, raw);
        if let Some(parsed) = parse_background_value(&resolved) {
            let radial = parsed
                .layers
                .iter()
                .any(|l| matches!(l, BackgroundLayer::Radial(_)));
            if radial || parsed.layers.len() >= 2 {
                return Some(parsed);
            }
        }
    }
    None
}

/// Read `name` (with viewport-aware tw breakpoint resolution) as a
/// `Dim`. Strings carrying `%` resolve to `Dim::Percent`; everything
/// else (numbers, `"16px"`, `"1rem"`) resolves to `Dim::Length`.
/// Returns `None` when the prop is absent or unparseable.
pub fn prop_dim_at(node: &Node, name: &str, viewport: Viewport) -> Option<Dim> {
    prop_dim_with(node, name, &VariantState::layout(viewport))
}

/// Variant-aware [`prop_dim_at`] — resolves percent strings off the
/// winning variant-decorated key (so `width:hover` / `width@md:hover`
/// participate in layout), falling back to the bare / dotted / kebab
/// percent reads and finally the numeric length chain.
pub fn prop_dim_with(node: &Node, name: &str, vs: &VariantState) -> Option<Dim> {
    // If a variant-decorated key wins, prefer its percent value first so
    // `width:hover.0 = "50%"` resolves as a percent rather than falling
    // through to the length chain.
    if let Some(decorated) = pick_base(node, name, vs.viewport.w, &vs.active_states) {
        if decorated != name {
            if let Some(s) = prop_str(node, &decorated) {
                if let Some(pct) = parse_percent(s) {
                    return Some(Dim::Percent(pct));
                }
            }
        }
    }
    // Percent strings are only meaningful as raw values; check the
    // bare prop and the dotted positional first. If neither is a
    // string with `%`, fall through to the standard `prop_f32_with`
    // chain (which honours camelCase + dotted + kebab + tw
    // breakpoints + states) as a length.
    if let Some(s) = node.props.get(name).and_then(|v| v.as_str()) {
        if let Some(pct) = parse_percent(s) {
            return Some(Dim::Percent(pct));
        }
    }
    let dotted = format!("{name}.0");
    if let Some(s) = node.props.get(&dotted).and_then(|v| v.as_str()) {
        if let Some(pct) = parse_percent(s) {
            return Some(Dim::Percent(pct));
        }
    }
    // Kebab-case fallback: tw("w-1/2") emits `width: "50%"` and the
    // engine flattens that under the kebab key for CSS-style props.
    // Without this branch, percent dimensions from Tailwind silently
    // fell through to prop_f32_at → parse_length, which rejects `%`,
    // and the width/height was dropped.
    let kebab_name = camel_to_kebab(name);
    if kebab_name != name {
        if let Some(s) = node.props.get(&kebab_name).and_then(|v| v.as_str()) {
            if let Some(pct) = parse_percent(s) {
                return Some(Dim::Percent(pct));
            }
        }
    }
    prop_f32_with(node, name, vs).map(Dim::Length)
}

/// Test-only viewport constructor. Breakpoint tests key off width
/// alone, so the height is a fixed stand-in; anything exercising `vh`
/// builds its own [`Viewport`] with a meaningful height.
#[cfg(test)]
pub(crate) fn vp(w: f32) -> Viewport {
    Viewport::new(w, 800.0)
}

/// Length / percent / auto resolution for sizing props on Image and
/// future percent-aware containers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dim {
    Length(f32),
    Percent(f32),
}

/// Best-effort CSS-ish colour parser.
pub fn parse_color(s: &str) -> Option<Rgba> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex);
    }
    let lower = s.to_ascii_lowercase();
    // `rgb()` / `rgba()` — what every Tailwind alpha-slash utility lowers to
    // (`bg-black/25` -> `rgba(0, 0, 0, 0.25)`). Without this the whole family
    // parsed to None and was dropped, so translucent surfaces like the
    // home-screen dock's `bg-black/25` panel and its `border-white/15`
    // hairline simply did not paint — desktop looked flatter than web and iOS.
    if lower.starts_with("rgb(") || lower.starts_with("rgba(") {
        return parse_rgb_func(&lower);
    }
    Some(match lower.as_str() {
        "transparent" => Rgba::TRANSPARENT,
        "black" => Rgba(0, 0, 0, 0xff),
        "white" => Rgba(0xff, 0xff, 0xff, 0xff),
        "red" => Rgba(0xff, 0, 0, 0xff),
        "green" => Rgba(0, 0x80, 0, 0xff),
        "blue" => Rgba(0, 0, 0xff, 0xff),
        "gray" | "grey" => Rgba(0x80, 0x80, 0x80, 0xff),
        "lightgray" | "lightgrey" => Rgba(0xd3, 0xd3, 0xd3, 0xff),
        "darkgray" | "darkgrey" => Rgba(0xa9, 0xa9, 0xa9, 0xff),
        "yellow" => Rgba(0xff, 0xff, 0, 0xff),
        "orange" => Rgba(0xff, 0xa5, 0, 0xff),
        "purple" => Rgba(0x80, 0, 0x80, 0xff),
        "pink" => Rgba(0xff, 0xc0, 0xcb, 0xff),
        "cyan" | "aqua" => Rgba(0, 0xff, 0xff, 0xff),
        "magenta" | "fuchsia" => Rgba(0xff, 0, 0xff, 0xff),
        _ => return None,
    })
}

/// Parse `rgb(r, g, b)` / `rgba(r, g, b, a)`.
///
/// Channels are 0-255 (or percentages); alpha is 0..=1, matching what the
/// Tailwind parser and the examples' CSS emit. Comma- or space-separated.
fn parse_rgb_func(s: &str) -> Option<Rgba> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    if close <= open {
        return None;
    }
    let parts: Vec<&str> = s[open + 1..close]
        .split(|c| c == ',' || c == '/' || c == ' ')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 3 {
        return None;
    }
    let channel = |p: &str| -> Option<u8> {
        let v = if let Some(pct) = p.strip_suffix('%') {
            pct.trim().parse::<f32>().ok()? * 2.55
        } else {
            p.parse::<f32>().ok()?
        };
        Some(v.round().clamp(0.0, 255.0) as u8)
    };
    let r = channel(parts[0])?;
    let g = channel(parts[1])?;
    let b = channel(parts[2])?;
    let a = match parts.get(3) {
        Some(p) => {
            let v = if let Some(pct) = p.strip_suffix('%') {
                pct.trim().parse::<f32>().ok()? / 100.0
            } else {
                p.parse::<f32>().ok()?
            };
            (v.clamp(0.0, 1.0) * 255.0).round() as u8
        }
        None => 0xff,
    };
    Some(Rgba(r, g, b, a))
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let bytes: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<Vec<_>>>()?;
    Some(match bytes.len() {
        3 => Rgba(bytes[0] * 0x11, bytes[1] * 0x11, bytes[2] * 0x11, 0xff),
        4 => Rgba(
            bytes[0] * 0x11,
            bytes[1] * 0x11,
            bytes[2] * 0x11,
            bytes[3] * 0x11,
        ),
        6 => Rgba(
            bytes[0] * 16 + bytes[1],
            bytes[2] * 16 + bytes[3],
            bytes[4] * 16 + bytes[5],
            0xff,
        ),
        8 => Rgba(
            bytes[0] * 16 + bytes[1],
            bytes[2] * 16 + bytes[3],
            bytes[4] * 16 + bytes[5],
            bytes[6] * 16 + bytes[7],
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn node_with(props: &[(&str, Value)]) -> Node {
        let mut map = HashMap::new();
        for (k, v) in props {
            map.insert((*k).to_string(), v.clone());
        }
        Node {
            id: "test".into(),
            element_type: "Container".into(),
            props: map,
            semantics: None,
        }
    }

    // ----------------------------------------------------------------
    // Linear gradient parser + Tailwind var resolution
    // ----------------------------------------------------------------

    #[test]
    fn parse_linear_gradient_to_right_two_stops() {
        let g =
            parse_linear_gradient("linear-gradient(to right, #ff0000, #0000ff)").expect("parses");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0, 0, 0xff, 0xff));
        // No explicit offsets — `resolved_offsets` distributes 0..1.
        let res = g.resolved_offsets();
        assert_eq!(res[0].0, 0.0);
        assert_eq!(res[1].0, 1.0);
    }

    #[test]
    fn parse_linear_gradient_to_bottom_right_three_stops() {
        let g =
            parse_linear_gradient("linear-gradient(to bottom right, #ff0000, #00ff00, #0000ff)")
                .expect("parses");
        assert_eq!(g.direction, GradientDirection::ToBottomRight);
        assert_eq!(g.stops.len(), 3);
        let res = g.resolved_offsets();
        assert_eq!(res[0].0, 0.0);
        assert!((res[1].0 - 0.5).abs() < 1e-4);
        assert_eq!(res[2].0, 1.0);
    }

    #[test]
    fn parse_linear_gradient_with_explicit_percent_offsets() {
        let g = parse_linear_gradient("linear-gradient(to right, #ff0000 10%, #0000ff 80%)")
            .expect("parses");
        let res = g.resolved_offsets();
        assert!((res[0].0 - 0.10).abs() < 1e-4);
        assert!((res[1].0 - 0.80).abs() < 1e-4);
    }

    #[test]
    fn parse_linear_gradient_angle_form() {
        let g = parse_linear_gradient("linear-gradient(45deg, #fff, #000)").expect("parses");
        match g.direction {
            GradientDirection::Angle(a) => assert!((a - 45.0).abs() < 1e-4),
            _ => panic!("expected angle"),
        }
    }

    #[test]
    fn parse_linear_gradient_no_direction_defaults_to_bottom() {
        // CSS spec: default direction is `to bottom` when no
        // direction prefix is given. The first comma chunk is then
        // a stop, not a direction.
        let g = parse_linear_gradient("linear-gradient(#fff, #000)").expect("parses");
        assert_eq!(g.direction, GradientDirection::ToBottom);
        assert_eq!(g.stops.len(), 2);
    }

    #[test]
    fn parse_linear_gradient_rejects_non_linear() {
        assert!(parse_linear_gradient("radial-gradient(#fff, #000)").is_none());
        assert!(parse_linear_gradient("#ff0000").is_none());
        assert!(parse_linear_gradient("").is_none());
    }

    #[test]
    fn parse_linear_gradient_case_insensitive_keyword() {
        let g =
            parse_linear_gradient("LINEAR-GRADIENT(TO RIGHT, #ff0000, #0000ff)").expect("parses");
        assert_eq!(g.direction, GradientDirection::ToRight);
    }

    #[test]
    fn gradient_axis_to_right_spans_horizontal_midline() {
        let dir = GradientDirection::ToRight;
        let ((sx, sy), (ex, ey)) = dir.axis(10.0, 20.0, 200.0, 100.0);
        assert_eq!((sx, sy), (10.0, 70.0));
        assert_eq!((ex, ey), (210.0, 70.0));
    }

    #[test]
    fn gradient_axis_to_bottom_spans_vertical_midline() {
        let dir = GradientDirection::ToBottom;
        let ((sx, sy), (ex, ey)) = dir.axis(0.0, 0.0, 100.0, 50.0);
        assert_eq!((sx, sy), (50.0, 0.0));
        assert_eq!((ex, ey), (50.0, 50.0));
    }

    #[test]
    fn gradient_axis_angle_0_points_up() {
        // 0deg = up in CSS — start at bottom-centre, end at top-centre.
        let dir = GradientDirection::Angle(0.0);
        let ((sx, sy), (ex, ey)) = dir.axis(0.0, 0.0, 100.0, 200.0);
        // Centre is (50, 100); axis half-length on a w=100,h=200
        // rect with dx=0, dy=-1 is |0|·50 + |-1|·100 = 100.
        assert!((sx - 50.0).abs() < 1e-3);
        assert!((sy - 200.0).abs() < 1e-3);
        assert!((ex - 50.0).abs() < 1e-3);
        assert!((sy - 200.0).abs() < 1e-3);
        let _ = ey; // already covered by sy assertion symmetry
    }

    #[test]
    fn prop_linear_gradient_resolves_tailwind_var_chain() {
        // Exact shape `tailwind-parse` produces for
        // `.tw("bg-gradient-to-r from-blue-500 to-pink-500")`. The
        // engine flattens these onto the renderer node as kebab-case
        // CSS-custom-property keys; `prop_linear_gradient` is the
        // gate that resolves the `var()` indirection.
        let node = node_with(&[
            (
                "background-image",
                Value::String("linear-gradient(to right, var(--tw-gradient-stops))".into()),
            ),
            (
                "--tw-gradient-stops",
                Value::String("var(--tw-gradient-from), var(--tw-gradient-to)".into()),
            ),
            ("--tw-gradient-from", Value::String("#3b82f6".into())),
            ("--tw-gradient-to", Value::String("#ec4899".into())),
        ]);
        let g = prop_linear_gradient(&node, vp(800.0)).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_resolves_three_stop_via_chain() {
        // `.tw("bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500")`.
        // The `via-*` utility replaces the `--tw-gradient-stops` var
        // with a three-colour list that itself uses
        // `var(--tw-gradient-from)` / `var(--tw-gradient-to)` — our
        // substitution loop must handle the nested case.
        let node = node_with(&[
            (
                "background-image",
                Value::String("linear-gradient(to bottom right, var(--tw-gradient-stops))".into()),
            ),
            (
                "--tw-gradient-stops",
                Value::String("var(--tw-gradient-from), #a855f7, var(--tw-gradient-to)".into()),
            ),
            ("--tw-gradient-from", Value::String("#3b82f6".into())),
            ("--tw-gradient-to", Value::String("#ec4899".into())),
        ]);
        let g = prop_linear_gradient(&node, vp(800.0)).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToBottomRight);
        assert_eq!(g.stops.len(), 3);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xa8, 0x55, 0xf7, 0xff));
        assert_eq!(g.stops[2].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_returns_none_without_background_image() {
        // Solid-colour node — gradient path is opt-in.
        let node = node_with(&[("background-color", Value::String("#ffffff".into()))]);
        assert!(prop_linear_gradient(&node, vp(800.0)).is_none());
    }

    // ----------------------------------------------------------------
    // Radial gradients + layered `background` shorthand
    // ----------------------------------------------------------------

    #[test]
    fn parse_radial_gradient_circle_at_position() {
        // The home-screen icon tiles' sheen layer.
        let g = parse_radial_gradient(
            "radial-gradient(circle at 24% 14%, rgba(255,255,255,0.48), transparent 29%)",
        )
        .expect("parses");
        assert!(g.circle);
        assert_eq!(g.extent, RadialExtent::FarthestCorner);
        assert!((g.center.0 - 0.24).abs() < 1e-6);
        assert!((g.center.1 - 0.14).abs() < 1e-6);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[1].color, Rgba::TRANSPARENT);
        assert_eq!(g.stops[1].offset, Some(0.29));
    }

    #[test]
    fn parse_radial_gradient_explicit_ellipse() {
        // The app-splash glow: explicit percent radii + centre.
        let g = parse_radial_gradient(
            "radial-gradient(85% 60% at 50% 38%, rgba(79, 70, 229, 0.48) 0%, rgba(3, 7, 18, 0) 70%)",
        )
        .expect("parses");
        assert!(!g.circle);
        match g.extent {
            RadialExtent::Explicit {
                rx: RadialLen::Pct(rx),
                ry: RadialLen::Pct(ry),
            } => {
                assert!((rx - 0.85).abs() < 1e-6);
                assert!((ry - 0.60).abs() < 1e-6);
            }
            other => panic!("expected explicit percent radii, got {other:?}"),
        }
        assert!((g.center.0 - 0.5).abs() < 1e-6);
        assert!((g.center.1 - 0.38).abs() < 1e-6);
        // Explicit radii resolve against the box axes.
        let (rx, ry) = g.resolve_radii(200.0, 100.0, 1.0);
        assert!((rx - 170.0).abs() < 1e-3);
        assert!((ry - 60.0).abs() < 1e-3);
    }

    #[test]
    fn parse_radial_gradient_defaults_without_prelude() {
        let g = parse_radial_gradient("radial-gradient(#ffffff, #000000)").expect("parses");
        assert!(!g.circle);
        assert_eq!(g.extent, RadialExtent::FarthestCorner);
        assert_eq!(g.center, (0.5, 0.5));
        assert_eq!(g.stops.len(), 2);
        // Centred farthest-corner circle radius in a square box is the
        // half-diagonal; the default ellipse's radii are the √2-scaled
        // half-sides, which coincide with it there.
        let (rx, ry) = g.resolve_radii(100.0, 100.0, 1.0);
        assert!((rx - 70.7107).abs() < 1e-2);
        assert!((ry - 70.7107).abs() < 1e-2);
    }

    #[test]
    fn parse_radial_gradient_rejects_non_radial() {
        assert!(parse_radial_gradient("linear-gradient(#fff, #000)").is_none());
        assert!(parse_radial_gradient("#ff0000").is_none());
    }

    #[test]
    fn parse_background_value_icon_tile_stack() {
        // The launcher's icon tile: sheen radial OVER brand linear.
        let pb = parse_background_value(
            "radial-gradient(circle at 24% 14%, rgba(255,255,255,0.48), transparent 29%), \
             linear-gradient(145deg, #38BDF8 0%, #4F46E5 52%, #312E81 100%)",
        )
        .expect("parses");
        assert!(pb.color.is_none());
        assert_eq!(pb.layers.len(), 2);
        // Layers are stored bottom-first: the linear paints first, the
        // radial sheen on top — CSS declaration order reversed.
        assert!(matches!(pb.layers[0], BackgroundLayer::Linear(_)));
        assert!(matches!(pb.layers[1], BackgroundLayer::Radial(_)));
    }

    #[test]
    fn parse_background_value_wallpaper_stack() {
        // Scrim gradient over a photo: image at the bottom, gradient on
        // top, trailing position/size/repeat keywords ignored.
        let pb = parse_background_value(
            "linear-gradient(180deg, rgba(3, 7, 18, 0.08), rgba(3, 7, 18, 0.6)), \
             url('data:image/jpeg;base64,AAAA') center / cover no-repeat",
        )
        .expect("parses");
        assert_eq!(pb.layers.len(), 2);
        match &pb.layers[0] {
            BackgroundLayer::Image(uri) => assert_eq!(uri, "data:image/jpeg;base64,AAAA"),
            other => panic!("expected image bottom-most, got {other:?}"),
        }
        assert!(matches!(pb.layers[1], BackgroundLayer::Linear(_)));
    }

    #[test]
    fn resolved_offsets_interpolate_between_specified_neighbours() {
        // CSS distributes unspecified stops between their neighbouring
        // SPECIFIED stops, not across the whole gradient: in
        // `red 50%, blue, green`, blue sits at 75% (midpoint of the
        // 50%–100% span). Even whole-gradient distribution put blue at
        // 0.5 — coincident with red — collapsing the ramp to an edge.
        let g = parse_radial_gradient("radial-gradient(red 50%, blue, green)").expect("parses");
        let res = g.resolved_offsets();
        assert_eq!(res[0].0, 0.5);
        assert_eq!(res[1].0, 0.75);
        assert_eq!(res[2].0, 1.0);
    }

    #[test]
    fn parse_radial_gradient_four_value_position() {
        // CSS 4-value syntax: an edge keyword plus an offset FROM that
        // edge — `right 20%` is x = 0.8, `bottom 10%` is y = 0.9.
        let g =
            parse_radial_gradient("radial-gradient(circle at right 20% bottom 10%, #fff, #000)")
                .expect("parses");
        assert!((g.center.0 - 0.8).abs() < 1e-6);
        assert!((g.center.1 - 0.9).abs() < 1e-6);
        // `center <pct>` consumes the horizontal slot.
        let g =
            parse_radial_gradient("radial-gradient(at center 30%, #fff, #000)").expect("parses");
        assert!((g.center.0 - 0.5).abs() < 1e-6);
        assert!((g.center.1 - 0.3).abs() < 1e-6);
    }

    #[test]
    fn explicit_px_radii_scale_with_the_display_factor() {
        // item rects are physical pixels, so a `120px` radius must be
        // multiplied by the scale factor on HiDPI; percent radii
        // already resolve against the physical box and must NOT be.
        let g =
            parse_radial_gradient("radial-gradient(120px at 50% 50%, red, blue)").expect("parses");
        let (rx, ry) = g.resolve_radii(400.0, 400.0, 2.0);
        assert_eq!((rx, ry), (240.0, 240.0));
        let g =
            parse_radial_gradient("radial-gradient(50% 50% at center, red, blue)").expect("parses");
        let (rx, ry) = g.resolve_radii(400.0, 200.0, 2.0);
        assert_eq!((rx, ry), (200.0, 100.0));
    }

    #[test]
    fn closest_side_on_the_edge_resolves_to_zero_radius() {
        // Centre sitting ON a box edge: the resolved radius is 0 and
        // the painter degrades to a flat fill of the last stop (CSS's
        // vanishingly-small ending shape), rather than painting
        // nothing.
        let g = parse_radial_gradient(
            "radial-gradient(circle closest-side at left center, red, #4F46E5)",
        )
        .expect("parses");
        let (rx, _) = g.resolve_radii(100.0, 100.0, 1.0);
        assert_eq!(rx, 0.0);
    }

    #[test]
    fn parse_linear_gradient_rejects_layer_lists() {
        // A multi-layer value must not mis-parse as one garbage
        // gradient assembled from the first and last stops; the layer
        // list belongs to `parse_background_value`.
        let layered = "linear-gradient(#111111, #222222), linear-gradient(#333333, #444444)";
        assert!(parse_linear_gradient(layered).is_none());
        let pb = parse_background_value(layered).expect("parses as layers");
        assert_eq!(pb.layers.len(), 2);
        assert!(pb
            .layers
            .iter()
            .all(|l| matches!(l, BackgroundLayer::Linear(_))));
    }

    #[test]
    fn single_layer_color_and_url_keeps_both() {
        // The classic shorthand puts colour and image in ONE layer:
        // `background: #030712 url(...) center / cover no-repeat`.
        let pb = parse_background_value(
            "#030712 url('data:image/png;base64,AA') center / cover no-repeat",
        )
        .expect("parses");
        assert_eq!(pb.color, Some(Rgba(0x03, 0x07, 0x12, 0xff)));
        assert_eq!(pb.layers.len(), 1);
        assert!(matches!(pb.layers[0], BackgroundLayer::Image(_)));
    }

    #[test]
    fn parse_background_value_solid_color_only() {
        let pb = parse_background_value("#123456").expect("parses");
        assert_eq!(pb.color, Some(Rgba(0x12, 0x34, 0x56, 0xff)));
        assert!(pb.layers.is_empty());
    }

    #[test]
    fn prop_background_layers_reads_background_shorthand() {
        // `.background("...")` flattens to `background.0` on the wire.
        let node = node_with(&[(
            "background.0",
            Value::String(
                "radial-gradient(circle at 24% 14%, rgba(255,255,255,0.48), transparent 29%), \
                 linear-gradient(145deg, #38BDF8 0%, #4F46E5 52%, #312E81 100%)"
                    .into(),
            ),
        )]);
        let pb = prop_background_layers(&node).expect("resolves");
        assert_eq!(pb.layers.len(), 2);
    }

    #[test]
    fn prop_background_layers_reads_radial_gradient_applicator() {
        // `.radialGradient("<body>")` — the DOM renderer lowers this to
        // `radial-gradient(<body>)`; desktop reads the flattened prop.
        let node = node_with(&[(
            "radialGradient.0",
            Value::String("circle, #ffffff, #000000".into()),
        )]);
        let pb = prop_background_layers(&node).expect("resolves");
        assert_eq!(pb.layers.len(), 1);
        assert!(matches!(pb.layers[0], BackgroundLayer::Radial(_)));
    }

    #[test]
    fn prop_background_layers_leaves_single_linear_to_legacy_path() {
        // A lone linear-gradient in `backgroundImage` keeps flowing
        // through `prop_linear_gradient` (incl. the tw var form), so
        // the layered path must decline it.
        let node = node_with(&[(
            "backgroundImage.0",
            Value::String("linear-gradient(to right, #fff, #000)".into()),
        )]);
        assert!(prop_background_layers(&node).is_none());
        assert!(prop_linear_gradient(&node, vp(800.0)).is_some());
    }

    #[test]
    fn prop_background_layers_takes_radial_background_image() {
        // A radial in `backgroundImage` has no legacy path — the
        // layered reader picks it up.
        let node = node_with(&[(
            "backgroundImage.0",
            Value::String("radial-gradient(circle, #fff, #000)".into()),
        )]);
        let pb = prop_background_layers(&node).expect("resolves");
        assert!(matches!(pb.layers[0], BackgroundLayer::Radial(_)));
    }

    #[test]
    fn prop_linear_gradient_reads_applicator_positional() {
        // `.linearGradient("to right", ["#3b82f6", "#ec4899"])` —
        // engine flattens the two positional args to
        // `linearGradient.0` (direction) + `linearGradient.1` (colors).
        let node = node_with(&[
            ("linearGradient.0", Value::String("to right".into())),
            (
                "linearGradient.1",
                serde_json::json!(["#3b82f6", "#ec4899"]),
            ),
        ]);
        let g = prop_linear_gradient(&node, vp(800.0)).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_reads_applicator_named() {
        // `.linearGradient(direction: "45deg", colors: [...])` —
        // engine flattens named args under the key name directly.
        let node = node_with(&[
            ("linearGradient.direction", Value::String("45deg".into())),
            (
                "linearGradient.colors",
                serde_json::json!(["#ff0000", "#00ff00", "#0000ff"]),
            ),
        ]);
        let g = prop_linear_gradient(&node, vp(800.0)).expect("resolves");
        match g.direction {
            GradientDirection::Angle(a) => assert!((a - 45.0).abs() < 1e-4),
            _ => panic!("expected angle"),
        }
        assert_eq!(g.stops.len(), 3);
    }

    #[test]
    fn prop_linear_gradient_applicator_beats_tailwind_path() {
        // If both an explicit `.linearGradient(...)` AND tw classes
        // are on the same node, the applicator wins. (Predictable
        // override semantics — easier to reason about than mixing.)
        let node = node_with(&[
            ("linearGradient.0", Value::String("to bottom".into())),
            (
                "linearGradient.1",
                serde_json::json!(["#000000", "#ffffff"]),
            ),
            (
                "background-image",
                Value::String("linear-gradient(to right, var(--tw-gradient-stops))".into()),
            ),
            (
                "--tw-gradient-stops",
                Value::String("#ff0000, #0000ff".into()),
            ),
        ]);
        let g = prop_linear_gradient(&node, vp(800.0)).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToBottom);
        assert_eq!(g.stops[0].color, Rgba(0, 0, 0, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xff, 0xff, 0xff, 0xff));
    }

    #[test]
    fn parse_linear_gradient_single_stop_extends_to_full_range() {
        // CSS treats a single-stop gradient as a flat fill; we
        // duplicate the stop at offset 0 and 1 so Vello has a valid
        // two-point ramp. Without this, Vello rejects the gradient.
        let g = parse_linear_gradient("linear-gradient(to right, #ff0000)").expect("parses");
        let res = g.resolved_offsets();
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].1, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(res[1].1, Rgba(0xff, 0, 0, 0xff));
    }

    #[test]
    fn padding_uniform_from_padding_zero() {
        let node = node_with(&[("padding.0", serde_json::json!(16))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_uniform_from_padding_directional_object() {
        let node = node_with(&[
            ("padding.top", serde_json::json!(8)),
            ("padding.right", serde_json::json!(4)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 8.0);
        assert_eq!(p.right, 4.0);
        assert_eq!(p.bottom, 0.0);
        assert_eq!(p.left, 0.0);
    }

    #[test]
    fn padding_horizontal_overrides_uniform_on_left_right() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("paddingHorizontal.0", serde_json::json!(8)),
        ]);
        let p = padding(&node);
        assert_eq!(p.left, 8.0);
        assert_eq!(p.right, 8.0);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.bottom, 16.0);
    }

    #[test]
    fn padding_vertical_overrides_uniform_on_top_bottom() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("paddingVertical.0", serde_json::json!(8)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 8.0);
        assert_eq!(p.bottom, 8.0);
        assert_eq!(p.left, 16.0);
        assert_eq!(p.right, 16.0);
    }

    #[test]
    fn padding_top_named_overrides_uniform() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("padding.top", serde_json::json!(4)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 4.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_top_applicator_overrides_named() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("padding.top", serde_json::json!(4)),
            ("paddingTop.0", serde_json::json!(1)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 1.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_zero_when_no_props() {
        let node = node_with(&[]);
        let p = padding(&node);
        assert_eq!(p.top, 0.0);
        assert_eq!(p.right, 0.0);
        assert_eq!(p.bottom, 0.0);
        assert_eq!(p.left, 0.0);
    }

    #[test]
    fn padding_accepts_string_with_px() {
        let node = node_with(&[("padding.0", serde_json::json!("16px"))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn prop_color_reads_dotted_or_direct() {
        let dotted = node_with(&[("color.0", serde_json::json!("red"))]);
        assert_eq!(prop_color(&dotted, "color"), Some(Rgba(0xff, 0, 0, 0xff)));

        let direct = node_with(&[("color", serde_json::json!("blue"))]);
        assert_eq!(prop_color(&direct, "color"), Some(Rgba(0, 0, 0xff, 0xff)));
    }

    #[test]
    fn prop_f32_reads_dotted_or_direct_for_numbers() {
        let dotted = node_with(&[("fontSize.0", serde_json::json!(18))]);
        assert_eq!(prop_f32(&dotted, "fontSize"), Some(18.0));

        let direct = node_with(&[("fontSize", serde_json::json!(24))]);
        assert_eq!(prop_f32(&direct, "fontSize"), Some(24.0));
    }

    #[test]
    fn parses_named_and_hex_colors() {
        assert_eq!(parse_color("red"), Some(Rgba(0xff, 0, 0, 0xff)));
        assert_eq!(parse_color("#fff"), Some(Rgba(0xff, 0xff, 0xff, 0xff)));
        assert_eq!(parse_color("#1a2b3c"), Some(Rgba(0x1a, 0x2b, 0x3c, 0xff)));
        assert_eq!(parse_color("#1a2b3c80"), Some(Rgba(0x1a, 0x2b, 0x3c, 0x80)));
        assert_eq!(parse_color("not-a-color"), None);
    }

    #[test]
    fn parses_lengths_with_px_suffix() {
        assert_eq!(parse_length("16", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("16px", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("  20px  ", Some(vp(1000.0))), Some(20.0));
    }

    #[test]
    fn premultiplies_alpha_correctly() {
        // Fully transparent → all zero
        assert_eq!(Rgba(0xff, 0xff, 0xff, 0).premultiplied(), [0, 0, 0, 0]);
        // Opaque white → unchanged
        assert_eq!(
            Rgba(0xff, 0xff, 0xff, 0xff).premultiplied(),
            [0xff, 0xff, 0xff, 0xff]
        );
        // 50% red ≈ (128,0,0,128)
        let p = Rgba(0xff, 0, 0, 0x80).premultiplied();
        assert!((p[0] as i32 - 0x80).abs() <= 1);
        assert_eq!(p[3], 0x80);
    }

    // ---------------------------------------------------------------
    // margin: mirrors the padding precedence tests above.
    // ---------------------------------------------------------------

    #[test]
    fn margin_uniform_from_margin_zero() {
        let node = node_with(&[("margin.0", serde_json::json!(12))]);
        let m = margin(&node);
        assert_eq!(m.top, 12.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_horizontal_overrides_uniform() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("marginHorizontal.0", serde_json::json!(4)),
        ]);
        let m = margin(&node);
        assert_eq!(m.left, 4.0);
        assert_eq!(m.right, 4.0);
        assert_eq!(m.top, 12.0);
        assert_eq!(m.bottom, 12.0);
    }

    #[test]
    fn margin_top_named_overrides_uniform() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("margin.top", serde_json::json!(2)),
        ]);
        let m = margin(&node);
        assert_eq!(m.top, 2.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_top_applicator_overrides_named() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("margin.top", serde_json::json!(2)),
            ("marginTop.0", serde_json::json!(1)),
        ]);
        let m = margin(&node);
        assert_eq!(m.top, 1.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_zero_when_no_props() {
        let node = node_with(&[]);
        let m = margin(&node);
        assert_eq!(m.top, 0.0);
        assert_eq!(m.right, 0.0);
        assert_eq!(m.bottom, 0.0);
        assert_eq!(m.left, 0.0);
    }

    // ---------------------------------------------------------------
    // border: width/colour/radius resolution + visibility gate.
    // ---------------------------------------------------------------

    #[test]
    fn border_width_only() {
        let node = node_with(&[("border.0", serde_json::json!(2))]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color, Rgba::BLACK);
        assert_eq!(b.radius, 0.0);
        assert!(b.is_visible());
    }

    #[test]
    fn border_named_object_form() {
        let node = node_with(&[
            ("border.width", serde_json::json!(2)),
            ("border.color", serde_json::json!("red")),
            ("border.radius", serde_json::json!(6)),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(b.radius, 6.0);
    }

    #[test]
    fn border_width_color_radius_setters_override_object() {
        let node = node_with(&[
            ("border.width", serde_json::json!(1)),
            ("border.color", serde_json::json!("red")),
            ("border.radius", serde_json::json!(4)),
            ("borderWidth.0", serde_json::json!(3)),
            ("borderColor.0", serde_json::json!("blue")),
            ("borderRadius.0", serde_json::json!(8)),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 3.0);
        assert_eq!(b.color, Rgba(0, 0, 0xff, 0xff));
        assert_eq!(b.radius, 8.0);
    }

    #[test]
    fn border_corner_radius_alias() {
        let node = node_with(&[("cornerRadius.0", serde_json::json!(12))]);
        let b = border(&node);
        assert_eq!(b.radius, 12.0);
    }

    #[test]
    fn border_zero_width_is_not_visible() {
        let node = node_with(&[]);
        let b = border(&node);
        assert!(!b.is_visible());
    }

    #[test]
    fn border_with_transparent_colour_is_not_visible() {
        // Regression: `Rgba::TRANSPARENT == Rgba::default()`, so the
        // earlier "default to black when colour unset" branch couldn't
        // tell `borderColor("transparent")` from "no colour set". Fixed
        // by tracking an `Option<Rgba>` during resolution.
        let node = node_with(&[
            ("border.0", serde_json::json!(2)),
            ("border.color", serde_json::json!("transparent")),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color.3, 0);
        assert!(!b.is_visible());
    }

    // -----------------------------------------------------------------
    // Phase 12: kebab-case + rem fallbacks (tw-class compatibility)
    // -----------------------------------------------------------------

    #[test]
    fn camel_to_kebab_handles_common_css_names() {
        assert_eq!(camel_to_kebab("backgroundColor"), "background-color");
        assert_eq!(camel_to_kebab("borderColor"), "border-color");
        assert_eq!(camel_to_kebab("fontSize"), "font-size");
        assert_eq!(camel_to_kebab("borderRadius"), "border-radius");
        // No-op when there's no uppercase.
        assert_eq!(camel_to_kebab("color"), "color");
        assert_eq!(camel_to_kebab(""), "");
    }

    #[test]
    fn prop_color_falls_back_to_kebab_for_tw_classes() {
        // .tw("bg-white") expands to `background-color: "#ffffff"` —
        // a kebab-case prop with no `.0` suffix. The renderer must
        // pick it up so cards from tw classes get filled.
        let node = node_with(&[("background-color", serde_json::json!("#ffffff"))]);
        assert_eq!(
            prop_color(&node, "backgroundColor"),
            Some(Rgba(0xff, 0xff, 0xff, 0xff))
        );
    }

    #[test]
    fn explicit_applicator_wins_over_kebab_fallback() {
        // .backgroundColor(red) AND a stale tw-emitted background-color
        // — the explicit applicator's value should win.
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("red")),
            ("background-color", serde_json::json!("blue")),
        ]);
        assert_eq!(
            prop_color(&node, "backgroundColor"),
            Some(Rgba(0xff, 0, 0, 0xff))
        );
    }

    #[test]
    fn prop_f32_reads_kebab_font_size_from_tw() {
        // tw `text-lg` → `font-size: "1.125rem"`. The renderer reads
        // it through the kebab fallback and parse_length resolves rem.
        let node = node_with(&[("font-size", serde_json::json!("1.125rem"))]);
        assert!((prop_f32(&node, "fontSize").unwrap() - 18.0).abs() < 0.01);
    }

    #[test]
    fn parse_length_accepts_rem_units() {
        assert_eq!(parse_length("1rem", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("1.5rem", Some(vp(1000.0))), Some(24.0));
        assert_eq!(parse_length("0.5rem", Some(vp(1000.0))), Some(8.0));
        assert_eq!(parse_length(" 2rem ", Some(vp(1000.0))), Some(32.0));
    }

    #[test]
    fn parse_length_accepts_em_units() {
        assert_eq!(parse_length("1em", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("1.25em", Some(vp(1000.0))), Some(20.0));
    }

    #[test]
    fn parse_length_accepts_bare_and_px() {
        assert_eq!(parse_length("16", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("16px", Some(vp(1000.0))), Some(16.0));
        assert_eq!(parse_length("16.5", Some(vp(1000.0))), Some(16.5));
    }

    #[test]
    fn parse_length_rejects_unknown_units() {
        // `%` is container-relative, so it is deliberately not a length:
        // it resolves as `Dim::Percent` where taffy can apply it against
        // the real parent. `ch` is genuinely unsupported.
        assert_eq!(parse_length("50%", Some(vp(1000.0))), None);
        assert_eq!(parse_length("4ch", Some(vp(1000.0))), None);
    }

    #[test]
    fn parse_length_resolves_viewport_units() {
        // vp(w) is 800 tall. Tailwind lowers `h-screen` to `100vh`,
        // which used to fail this parse and drop the height in silence.
        let v = Some(Viewport::new(1000.0, 800.0));
        assert_eq!(parse_length("100vh", v), Some(800.0));
        assert_eq!(parse_length("50vh", v), Some(400.0));
        assert_eq!(parse_length("100vw", v), Some(1000.0));
        assert_eq!(parse_length("10vw", v), Some(100.0));
        // vmin/vmax key off the smaller/larger axis, not width/height.
        assert_eq!(parse_length("100vmin", v), Some(800.0));
        assert_eq!(parse_length("100vmax", v), Some(1000.0));
        assert_eq!(parse_length(" 25vh ", v), Some(200.0));
    }

    #[test]
    fn viewport_units_read_as_absent_without_a_viewport() {
        // A dropped prop is recoverable; a confident `0` is not. Call
        // sites with no viewport in scope must not silently collapse.
        assert_eq!(parse_length("100vh", None), None);
        assert_eq!(parse_length("50vw", None), None);
        assert_eq!(parse_length("10vmin", None), None);
        // Absolute units still resolve without a viewport.
        assert_eq!(parse_length("16px", None), Some(16.0));
        assert_eq!(parse_length("1rem", None), Some(16.0));
    }

    #[test]
    fn h_screen_reaches_the_dim_resolver_as_a_length() {
        // End-to-end for the actual Tailwind path: `h-screen` arrives as
        // `height: "100vh"` and must survive all the way to `Dim`.
        let node = node_with(&[("height", serde_json::json!("100vh"))]);
        assert_eq!(
            prop_dim_at(&node, "height", Viewport::new(1440.0, 900.0)),
            Some(Dim::Length(900.0))
        );
    }

    #[test]
    fn padding_picks_up_tw_kebab_with_rem() {
        // .tw("p-4") → padding: "1rem". Whole-padding shorthand via
        // kebab + rem resolves to 16px on every side.
        let node = node_with(&[("padding", serde_json::json!("1rem"))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    // -----------------------------------------------------------------
    // Phase 15: tw breakpoint resolution
    // -----------------------------------------------------------------

    #[test]
    fn breakpoint_at_returns_base_when_no_bp_keys_present() {
        let node = node_with(&[("padding.0", serde_json::json!(8))]);
        // Any viewport — without any `padding@x` overlays, falls back
        // to the existing chain (returns base 8).
        assert_eq!(prop_f32_at(&node, "padding", vp(320.0)), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1920.0)), Some(8.0));
    }

    #[test]
    fn breakpoint_md_kicks_in_at_768_and_above() {
        // Base 8, override at md (≥768) → 16.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", vp(320.0)), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(767.0)), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(768.0)), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1024.0)), Some(16.0));
    }

    #[test]
    fn breakpoint_largest_active_wins() {
        // Base 8, md 16, lg 32, xl 64. At 1024px viewport (≥lg, <xl)
        // we want lg=32 — not md, not xl.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
            ("padding@lg", serde_json::json!(32)),
            ("padding@xl", serde_json::json!(64)),
            ("padding@2xl", serde_json::json!(128)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", vp(320.0)), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(768.0)), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1024.0)), Some(32.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1280.0)), Some(64.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1536.0)), Some(128.0));
    }

    #[test]
    fn breakpoint_skips_intermediate_when_only_md_set() {
        // Base 8, only md set. lg / xl viewports still see md=16,
        // not the base 8 (largest-active fallback).
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", vp(1024.0)), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1920.0)), Some(16.0));
    }

    #[test]
    fn breakpoint_str_resolves_color_at_breakpoint() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("backgroundColor@md", serde_json::json!("blue")),
        ]);
        assert_eq!(
            prop_color_at(&node, "backgroundColor", vp(320.0)),
            Some(Rgba(0xff, 0xff, 0xff, 0xff))
        );
        assert_eq!(
            prop_color_at(&node, "backgroundColor", vp(800.0)),
            Some(Rgba(0x00, 0x00, 0xff, 0xff))
        );
    }

    #[test]
    fn breakpoint_padding_at_routes_through_resolver() {
        // .tw("p-4 md:p-8") → padding=1rem, padding@md=2rem.
        // At md+ viewport, padding_at picks up the 32px breakpoint
        // value and the kebab+rem decode lands as 32.0.
        let node = node_with(&[
            ("padding", serde_json::json!("1rem")),
            ("padding@md", serde_json::json!("2rem")),
        ]);
        let small = padding_at(&node, vp(400.0));
        assert_eq!(small.top, 16.0);
        let medium = padding_at(&node, vp(800.0));
        assert_eq!(medium.top, 32.0);
    }

    // -----------------------------------------------------------------
    // Variant phase: the `.0` breakpoint-key mismatch fix.
    //
    // The engine emits responsive applicator values with the variant
    // marker BETWEEN the base and the `.0` arg suffix, e.g.
    // `padding@md.0`. The old hand-rolled `lookup_breakpoint` built
    // `padding@md` and raw-`get`'d it, so it never found the real
    // `padding@md.0` key. These tests pin the canonical engine key
    // format and prove the shared resolver now reads it.
    // -----------------------------------------------------------------

    #[test]
    fn breakpoint_resolves_canonical_dot_zero_key_at_wide_viewport() {
        // Canonical engine output: `padding.0` (base) + `padding@md.0`
        // (md override). The `.0` sits AFTER the `@md` marker.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md.0", serde_json::json!(16)),
        ]);
        // Narrow: base wins.
        assert_eq!(prop_f32_at(&node, "padding", vp(320.0)), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(767.0)), Some(8.0));
        // Wide (>= md): the `@md.0` override wins. This is the exact
        // case the old `.0`-forgetting lookup missed.
        assert_eq!(prop_f32_at(&node, "padding", vp(768.0)), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", vp(1280.0)), Some(16.0));
    }

    #[test]
    fn breakpoint_color_resolves_canonical_dot_zero_key() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("backgroundColor@md.0", serde_json::json!("blue")),
        ]);
        assert_eq!(
            prop_color_at(&node, "backgroundColor", vp(320.0)),
            Some(Rgba(0xff, 0xff, 0xff, 0xff))
        );
        assert_eq!(
            prop_color_at(&node, "backgroundColor", vp(800.0)),
            Some(Rgba(0x00, 0x00, 0xff, 0xff))
        );
    }

    #[test]
    fn padding_at_resolves_canonical_dot_zero_breakpoint_key() {
        // End-to-end through `padding_at` (the layout consumer).
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md.0", serde_json::json!(24)),
        ]);
        assert_eq!(padding_at(&node, vp(400.0)).top, 8.0);
        assert_eq!(padding_at(&node, vp(900.0)).top, 24.0);
    }

    // -----------------------------------------------------------------
    // Variant phase: paint-time state variants (hover/focus/active/
    // disabled), resolved via the shared precedence rules.
    // -----------------------------------------------------------------

    #[test]
    fn state_variant_hover_selected_only_when_hover_active() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("backgroundColor:hover.0", serde_json::json!("blue")),
        ]);
        let sv = state_variants(&node, vp(800.0));
        assert!(!sv.is_empty());
        // No interaction → no override (base white is used by painter).
        assert_eq!(sv.background_color_for(&[]), None);
        // Hover active → blue wins.
        assert_eq!(
            sv.background_color_for(&["hover"]),
            Some(Rgba(0x00, 0x00, 0xff, 0xff))
        );
        // Some other state alone (focus) → hover variant does NOT apply.
        assert_eq!(sv.background_color_for(&["focus"]), None);
    }

    #[test]
    fn state_variant_precedence_active_beats_hover_beats_base() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("#000000")),
            ("backgroundColor:hover.0", serde_json::json!("#ff0000")),
            ("backgroundColor:active.0", serde_json::json!("#00ff00")),
        ]);
        let sv = state_variants(&node, vp(800.0));
        // Hover only → red.
        assert_eq!(
            sv.background_color_for(&["hover"]),
            Some(Rgba(0xff, 0, 0, 0xff))
        );
        // Both hover + active (pointer down over the element) → active
        // wins per precedence (base < hover < active).
        assert_eq!(
            sv.background_color_for(&["hover", "active"]),
            Some(Rgba(0, 0xff, 0, 0xff))
        );
    }

    #[test]
    fn state_variant_combined_breakpoint_and_state_needs_both() {
        // `backgroundColor@md:hover.0` only wins when BOTH md is active
        // (viewport >= 768) AND hover is active.
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("#000000")),
            ("backgroundColor:hover.0", serde_json::json!("#ff0000")),
            ("backgroundColor@md:hover.0", serde_json::json!("#0000ff")),
        ]);

        // Narrow viewport + hover: only the plain `:hover` qualifies
        // (the `@md` half fails), so red.
        let sv_narrow = state_variants(&node, vp(400.0));
        assert_eq!(
            sv_narrow.background_color_for(&["hover"]),
            Some(Rgba(0xff, 0, 0, 0xff))
        );

        // Wide viewport + hover: the combined `@md:hover` wins over the
        // plain `:hover` (breakpoint min-width tiebreak among equal
        // state rank), so blue.
        let sv_wide = state_variants(&node, vp(900.0));
        assert_eq!(
            sv_wide.background_color_for(&["hover"]),
            Some(Rgba(0, 0, 0xff, 0xff))
        );

        // Wide viewport but NO hover: neither hover variant qualifies →
        // fall back to base (None override).
        assert_eq!(sv_wide.background_color_for(&[]), None);
    }

    #[test]
    fn state_variant_disabled_folds_into_active_states() {
        // `enabled: false` should surface `"disabled"` in the live
        // state set, selecting `backgroundColor:disabled.0`.
        let node = node_with(&[
            ("enabled", serde_json::json!(false)),
            ("backgroundColor.0", serde_json::json!("#ffffff")),
            ("backgroundColor:disabled.0", serde_json::json!("#888888")),
        ]);
        let sv = state_variants(&node, vp(800.0));
        assert!(sv.disabled);
        let states = sv.active_states(false, false, false);
        assert!(states.contains(&"disabled"));
        assert_eq!(
            sv.background_color_for(&states),
            Some(Rgba(0x88, 0x88, 0x88, 0xff))
        );
    }

    #[test]
    fn state_variant_color_and_border_channels_resolve_independently() {
        let node = node_with(&[
            ("color.0", serde_json::json!("#000000")),
            ("color:hover.0", serde_json::json!("#ffffff")),
            ("borderColor.0", serde_json::json!("#cccccc")),
            ("borderColor:hover.0", serde_json::json!("#0000ff")),
        ]);
        let sv = state_variants(&node, vp(800.0));
        assert_eq!(sv.color_for(&["hover"]), Some(Rgba(0xff, 0xff, 0xff, 0xff)));
        assert_eq!(
            sv.border_color_for(&["hover"]),
            Some(Rgba(0, 0, 0xff, 0xff))
        );
        // No hover → both fall back to base (None override).
        assert_eq!(sv.color_for(&[]), None);
        assert_eq!(sv.border_color_for(&[]), None);
    }

    #[test]
    fn no_variants_yields_empty_state_variants() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("padding.0", serde_json::json!(8)),
        ]);
        let sv = state_variants(&node, vp(800.0));
        assert!(sv.is_empty());
        assert_eq!(sv.background_color_for(&["hover"]), None);
    }

    // -----------------------------------------------------------------
    // Layout-affecting interaction-state variants: detection + the
    // variant-aware layout readers (`padding_with`, etc.).
    // -----------------------------------------------------------------

    #[test]
    fn layout_state_variant_detection_only_for_layout_props() {
        // `padding:hover` IS layout-affecting → detected.
        let pad = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding:hover.0", serde_json::json!(16)),
        ]);
        assert!(node_has_layout_state_variant(&pad));

        // `backgroundColor:hover` is a paint-only state variant → NOT
        // detected (the painter handles it without relayout).
        let bg = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("backgroundColor:hover.0", serde_json::json!("blue")),
        ]);
        assert!(!node_has_layout_state_variant(&bg));

        // A breakpoint-only variant on a layout prop is NOT a *state*
        // variant → NOT detected (it already resolves at layout time
        // without interaction input).
        let bp = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md.0", serde_json::json!(16)),
        ]);
        assert!(!node_has_layout_state_variant(&bp));

        // Plain node → not detected.
        let plain = node_with(&[("padding.0", serde_json::json!(8))]);
        assert!(!node_has_layout_state_variant(&plain));
    }

    #[test]
    fn padding_with_resolves_hover_only_when_active() {
        // (a) `padding:hover` resolves to the larger padding in the
        // layout read when hover is active, and the base padding when
        // not.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding:hover.0", serde_json::json!(16)),
        ]);
        // No active states → base 8 on every side.
        let base = padding_with(&node, &VariantState::layout(vp(800.0)));
        assert_eq!(base.top, 8.0);
        assert_eq!(base.left, 8.0);
        // Hover active → 16 on every side.
        let hovered = padding_with(&node, &VariantState::paint(vp(800.0), vec!["hover"]));
        assert_eq!(hovered.top, 16.0);
        assert_eq!(hovered.right, 16.0);
        assert_eq!(hovered.bottom, 16.0);
        assert_eq!(hovered.left, 16.0);
        // Some other state (focus) alone → hover variant does NOT win.
        let focused = padding_with(&node, &VariantState::paint(vp(800.0), vec!["focus"]));
        assert_eq!(focused.top, 8.0);
    }

    #[test]
    fn padding_with_combined_breakpoint_and_state_needs_both() {
        // (b) `padding@md:hover` needs BOTH md (viewport >= 768) AND
        // hover active to win.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding:hover.0", serde_json::json!(16)),
            ("padding@md:hover.0", serde_json::json!(32)),
        ]);

        // Narrow + hover: only plain `:hover` qualifies → 16.
        let narrow_hover = padding_with(&node, &VariantState::paint(vp(400.0), vec!["hover"]));
        assert_eq!(narrow_hover.top, 16.0);

        // Wide + hover: combined `@md:hover` wins over plain `:hover`
        // (breakpoint min-width tiebreak among equal state rank) → 32.
        let wide_hover = padding_with(&node, &VariantState::paint(vp(900.0), vec!["hover"]));
        assert_eq!(wide_hover.top, 32.0);

        // Wide but NO hover: neither hover variant qualifies → base 8.
        let wide_no_hover = padding_with(&node, &VariantState::layout(vp(900.0)));
        assert_eq!(wide_no_hover.top, 8.0);
    }

    #[test]
    fn border_width_with_resolves_state_variant() {
        // border width is layout-affecting; its state variant should
        // reach the resolved `Border` used by Taffy.
        let node = node_with(&[
            ("borderWidth.0", serde_json::json!(1)),
            ("borderWidth:hover.0", serde_json::json!(4)),
        ]);
        let base = border_with(&node, &VariantState::layout(vp(800.0)));
        assert_eq!(base.width, 1.0);
        let hovered = border_with(&node, &VariantState::paint(vp(800.0), vec!["hover"]));
        assert_eq!(hovered.width, 4.0);
    }

    #[test]
    fn dim_with_resolves_width_state_variant() {
        let node = node_with(&[
            ("width.0", serde_json::json!(100)),
            ("width:focus.0", serde_json::json!(200)),
        ]);
        assert_eq!(
            prop_dim_with(&node, "width", &VariantState::layout(vp(800.0))),
            Some(Dim::Length(100.0))
        );
        assert_eq!(
            prop_dim_with(&node, "width", &VariantState::paint(vp(800.0), vec!["focus"])),
            Some(Dim::Length(200.0))
        );
    }
}

#[cfg(test)]
mod rgb_color_tests {
    use super::*;

    #[test]
    fn parses_rgba_with_fractional_alpha() {
        // What `bg-black/25` and `border-white/15` lower to.
        assert_eq!(parse_color("rgba(0, 0, 0, 0.25)"), Some(Rgba(0, 0, 0, 64)));
        assert_eq!(
            parse_color("rgba(255, 255, 255, 0.15)"),
            Some(Rgba(255, 255, 255, 38))
        );
    }

    #[test]
    fn parses_rgb_without_alpha_as_opaque() {
        assert_eq!(parse_color("rgb(1, 2, 3)"), Some(Rgba(1, 2, 3, 0xff)));
    }

    #[test]
    fn tolerates_spacing_and_case() {
        assert_eq!(
            parse_color("  RGBA( 10 , 20 , 30 , 1 )  "),
            Some(Rgba(10, 20, 30, 255))
        );
    }

    #[test]
    fn clamps_out_of_range_channels_and_alpha() {
        assert_eq!(parse_color("rgba(300, 0, 0, 2)"), Some(Rgba(255, 0, 0, 255)));
    }

    #[test]
    fn rejects_malformed_rather_than_guessing() {
        assert_eq!(parse_color("rgb(1, 2)"), None);
        assert_eq!(parse_color("rgba(a, b, c, d)"), None);
    }

    #[test]
    fn hex_and_named_colors_still_work() {
        assert_eq!(parse_color("#ff0000"), Some(Rgba(255, 0, 0, 255)));
        assert_eq!(parse_color("transparent"), Some(Rgba::TRANSPARENT));
    }
}
