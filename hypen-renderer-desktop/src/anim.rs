//! Desktop animation runtime for the `__anim.*` prop channel.
//!
//! The DOM renderer plays this channel with CSS transitions/animations and
//! the Canvas renderer with a numeric ticker (`packages/web/src/canvas/
//! anim.ts` — the reference implementation of tick-based semantics). This
//! module is the desktop twin of the canvas animator: every frame it
//! advances in-flight animations and writes the interpolated values into
//! the REAL renderer [`Tree`] props — the same props Taffy layout, item
//! emission, and hit-testing read — never a paint-only presentation layer
//! (design constraint #5: pixels must not move without their hit targets).
//!
//! The engine never ticks (design constraint #1); the window's own
//! demand-driven redraw loop is the clock. While anything is in flight the
//! window re-requests a redraw at the end of `RedrawRequested` (wgpu's Fifo
//! present mode paces that at vsync); when the last animation settles,
//! [`DesktopAnimator::has_active`] goes false and the loop stands down —
//! no runaway redraws.
//!
//! ## Desktop capability matrix (honest as of the transform stage)
//!
//! What the desktop paint/layout stack actually consumes decides what can
//! animate honestly. The Vello painter now composes per-item affine
//! transforms (`translateX`/`translateY`/`scale`/`rotate` — static props
//! and animator writes through ONE resolution path, the layout transform
//! post-pass), and every hit surface (pointer `hit_*`, wheel targeting,
//! AccessKit bounds, caret mapping) reads the same cumulative affine — so
//! transform motion is honest under constraint #5. Anything below marked
//! "snap" or "no-op" is the spec-sanctioned degradation for what still
//! cannot be expressed, applied silently (the same rule the canvas
//! renderer applies to `cornerRadius` and `shimmer`):
//!
//! - `.transition` — NUMERIC layout-feeding props (`width`, `height`,
//!   `gap`, `fontSize`, `padding*`, `margin*`) interpolate and mark the
//!   node for a Taffy restyle every tick so geometry — and with it
//!   hit-testing — follows the animated value; `cornerRadius` interpolates
//!   (desktop border-radius reads it, unlike canvas); `opacity`
//!   interpolates (per-item alpha layer in the Vello painter); COLOR props
//!   (`color`, `backgroundColor`, `borderColor`) interpolate in RGBA and
//!   are written as `#rrggbbaa` hex (the desktop color parser's format);
//!   `translateX`/`translateY`/`scale`/`rotate` interpolate as paint/hit
//!   transforms (no Taffy restyle — transforms never move layout, only
//!   the painted+hittable presentation). Mid-flight retargets continue
//!   from the last interpolated value.
//! - `.enter` — `fade` (opacity hidden → base), `slide` (translateX/Y
//!   ±24px → base, direction-aware incl. RTL via `dir` props, canvas
//!   parity), and `scale` (0.95× → base) all play for nodes
//!   created-and-inserted in the same batch; the first-ever batch is
//!   suppressed and a cached Router `Attach` never enter-animates (same
//!   contract as DOM/canvas).
//! - `.exit` — a `Remove` flagged `transition: true` whose root carries an
//!   exit spec defers teardown: the subtree stays in the tree (still
//!   painted and laid out), is excluded from hit-testing immediately,
//!   plays the inverse of its presets (fade AND slide/scale now that
//!   transforms paint), and finalizes on tick-clock settle — with a
//!   `duration + delay + 80ms` overdue backbone the patch-flush path runs
//!   in case the redraw ticker stalls (occluded window). Descendant plain
//!   Removes arriving while the root exits (flagged-root-first wire
//!   ordering) defer with it. The all-presets-unpaintable snap guard
//!   remains as a defensive path but no engine-emitted preset triggers it
//!   anymore.
//! - `.layout` (FLIP on moves AND removal-sibling shift) — plays: the
//!   window snapshots First rects off the pre-batch layout for `Move`
//!   patches whose nodes carry a `.layout` spec
//!   ([`DesktopAnimator::prepare_moves`]), and — #146 parity with the
//!   DOM's `collectRemovalSiblingFlips` — also for the `.layout` siblings
//!   sharing a parent with any `Remove` in the batch (those siblings
//!   reflow but get no `Move` patch of their own). After the post-batch
//!   layout lands, [`DesktopAnimator::play_pending_flips`] measures Last
//!   from the fresh Taffy geometry, inverts via `translateX`/`translateY`
//!   writes, and plays back to base — DOM `playFlip` semantics:
//!   sub-half-pixel deltas skip, exit wins over FLIP, reduced motion skips
//!   (per-node `.motion(essential)` exempts). For a flagged/exit remove
//!   the sibling holds flow until the exit settles, so its FLIP runs at
//!   exit finalize (`finalize_exit` records the candidate;
//!   [`DesktopAnimator::queue_removal_sibling_flips`] resolves it off the
//!   still-current pre-teardown layout), mirroring the DOM's finalizeExit.
//!   NARROWING vs the DOM: the exit-finalize sibling FLIP needs the cached
//!   pre-teardown layout to measure First. The DOM's exit settle is a
//!   decoupled timer with a live DOM always available; on desktop, when an
//!   exit finalizes in the SAME redraw as a non-empty patch batch (the
//!   batch already dropped the cached layout — see `window.rs` `flush`),
//!   First is unavailable and those siblings snap instead of sliding. The
//!   dominant path — an exit settling on idle animation frames with no
//!   concurrent batch — keeps the cached layout and FLIPs correctly.
//! - `.animate` — `pulse` (opacity 1 → 0.5 → 1), `spin` (rotate
//!   0 → 360deg), and `shake` (translateX keyframes ±6/±4px, DOM
//!   `hypen-shake` shape) play as looping/finite timelines; finite
//!   repeats never replay after exhausting. `shimmer` stays a no-op — it
//!   is a DOM gradient-overlay effect with no honest desktop equivalent
//!   (no gradient-overlay machinery in the painter; recorded narrowing,
//!   same as canvas).
//! - `batchAnimation` prelude — honored at batch head only (index 0), the
//!   normative position; it is the interpolation spec for every
//!   whitelisted prop change in the batch (transaction > node
//!   `.transition` > snap), same-batch-created nodes are excluded (their
//!   queued enter owns the first motion) and exiting nodes snap; cleared
//!   at the end of every batch.
//! - `.states` — pose flips arrive as ordinary SetProps and glide through
//!   the `.transition` channel (the `.states`-synthesized spec or an
//!   explicit one) per the matrix above; snapping props still switch.
//! - `.sharedElement` (`__anim.sharedKey`/`__anim.shared`) — cross-route
//!   FLIP over the Router Detach/Attach seam. When a batch has navigation
//!   shape (a `Detach` AND an `Attach`/`Insert`), a pre-pass snapshots the
//!   `visual_rect` of every keyed node at-or-under a detach root (outgoing
//!   subtrees only — a persistent shell node sharing a key never sources
//!   or shadows a FLIP), BEFORE the batch mutates the tree; after the
//!   post-batch layout lands, each incoming node whose key matches
//!   inverts (translate+scale) from the source rect via
//!   `translateX`/`translateY`/`scale` writes and plays back to base on
//!   its `__anim.shared` timing, its own `.enter` suppressed. Unmatched /
//!   unmeasurable / no-timing / self-snapshot keys degrade to plain
//!   navigation (one-sided keys warn once); zero-delta matches suppress
//!   enter and play nothing. Interruption retargets for free — a second
//!   navigation snapshots the live `visual_rect`, which reflects the
//!   in-flight transform. NARROWINGS vs the DOM v1 (all sanctioned, same
//!   family as the canvas `cornerRadius`/`shimmer` cuts): transform-only
//!   continuity — no corner-radius or content crossfade, no overlay proxy
//!   (the detached source is not resurrected); the scale is UNIFORM
//!   (desktop's `Affine2` has one scale factor, so the DOM's independent
//!   (sx, sy) collapses to their average — exact when aspect is
//!   preserved); and FLIPs are GLOBALLY skipped under reduced motion
//!   (cross-route continuity is decorative — no `.motion(essential)`
//!   exemption). A `{animation:"sharedElement"}` completion fires on the
//!   natural FLIP settle (and immediately on the zero-delta match).
//! - `.scrub`/`.settle` (`__anim.scrub*`) — SUPPORTED (the last channel to
//!   join). [`DesktopScrubber`] is the renderer-resident source: the winit
//!   pointer/wheel events the window already receives drive a per-frame loop
//!   that interpolates the materialized pose endpoints straight into the same
//!   real [`Tree`] props everything else reads (so pixels and hit targets
//!   never disagree — constraint #5), with ZERO engine traffic during the
//!   gesture. GESTURE: pointerdown opens a pending drag, claimed only past a
//!   6px axis slop (a below-slop release is a total no-op — the child click
//!   passes through); progress is RELATIVE, seeded from the node's
//!   `__anim.states` label; release velocity (samples within the last 100ms)
//!   projects `p + v·150ms` to pick the target, the settle rides the shared
//!   tick machinery, and the winning LABEL is written back through the exact
//!   `.bind` channel (`__hypen_bind`). SCROLL: maps an ancestor scroll
//!   container's offset through `over`, rest-debounced endpoint writes, with
//!   quiescence-bounded deferral. Engine writes to scrubbed props defer while
//!   a gesture/scroll owns the node and apply at cleanup; the settled styles
//!   hold until the matching `__anim.states` label lands (or a 500ms
//!   fallback). Precedence (scrub > playbacks > transaction > `.transition`)
//!   is enforced by syncing the scrubber's owned ids into the animator each
//!   flush ([`DesktopAnimator::set_scrub_active`]) — a scrub-active node is
//!   excluded from transaction application, `.states` glides, and
//!   enter/FLIP/shared participation. Reduced motion: dragging is exempt
//!   (direct manipulation), the release settle snaps (with the per-node
//!   `.motion(essential)` exemption). NARROWINGS vs the DOM v1 (all
//!   sanctioned): winit has no per-element pointer capture, so a claimed drag
//!   routes every move to the single OS cursor until release (the desktop
//!   equivalent of `setPointerCapture`); multi-touch is moot — one cursor, so
//!   the "ignore other pointerIds" rule holds by construction; and only
//!   numeric + color pose endpoints interpolate (a non-interpolable pose pair
//!   snaps, the same cut `.transition` takes). Base-transform composition is
//!   automatic: a static `rotate(45)` is a separate prop the translateY scrub
//!   never touches, so no explicit prefix bookkeeping is needed.
//! - `.onAnimationComplete` — SUPPORTED. Natural settles push resolved
//!   `{action, payload}` completions into a buffer the window drains through
//!   the module's action channel. Fires on enter (`{animation:"enter"}`),
//!   exit-before-finalize (`"exit"`), finite preset completion
//!   (`{animation:"<preset>"}`), `.states` transition settle
//!   (`{animation:"states", state:"<label>"}`), and shared-element FLIP settle
//!   (`"sharedElement"`, incl. zero-delta). Never on interrupt/supersede,
//!   reduced-motion skips, looping presets, `.layout` move FLIPs, or nodes
//!   without the prop — DOM payload parity.
//!
//! ## Reduced motion
//!
//! There is no reliable cross-platform reduced-motion query in this stack
//! (winit exposes none), so the gate is renderer configuration: the
//! `HYPEN_REDUCED_MOTION` environment variable (`1`/`true`/`yes`/`on`,
//! read once at construction) plus the programmatic
//! [`DesktopAnimator::set_reduced_motion`] setter, default off. This is a
//! recorded narrowing against the DOM/canvas OS-query behavior. Reduced
//! motion snaps everything — transitions write the target directly,
//! enters are skipped, `.animate` never starts, and a flagged remove
//! finalizes immediately — and the live toggle mirrors canvas: toggling
//! ON snaps all in-flight work, toggling OFF restarts `.animate` specs
//! (exhausted finite presets never replay). The per-node
//! `.motion(essential)` opt-out (`__anim.motion` = `{essential: true}`)
//! exempts a node from every one of those shortcuts, and removing the
//! flag while the preference is on snaps that node's in-flight work.
//!
//! ## Vocabulary source of truth
//!
//! Curves/presets/directions/whitelist are reused directly from
//! `hypen_engine::ir::anim` (the workspace dependency), so the desktop
//! animator cannot drift from the engine's lowering. The cubic-bezier
//! control points and the per-preset `.animate` defaults are mirrored
//! from `hypen-web/packages/core/src/animation.ts`
//! (`CURVE_BEZIER_POINTS`, `ANIMATE_PRESETS`) — the normative TS map —
//! with the values pinned by tests below.

use crate::tree::Tree;
use hypen_engine::ir::anim::{ANIMATABLE_PROPS, ANIMATE_PRESETS, CURVES, PRESETS};
use hypen_engine::Patch;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Grace added to `duration + delay` before the overdue backbone finalizes
/// an exit whose redraw ticker never reached settle (matches the DOM and
/// canvas renderers' `EXIT_SETTLE_GRACE_MS`).
pub const EXIT_SETTLE_GRACE_MS: f64 = 80.0;

/// How far `slide` offsets a node in its hidden position (normative:
/// `SLIDE_OFFSET_PX` in `@hypen-space/core/animation`).
pub const SLIDE_OFFSET_PX: f64 = 24.0;

/// The `scale` preset's hidden factor (normative: `SCALE_HIDDEN_FACTOR`).
pub const SCALE_HIDDEN_FACTOR: f64 = 0.95;

// ---------------------------------------------------------------------------
// Cubic-bezier easing (mirrors core/src/animation.ts `cubicBezier` exactly)
// ---------------------------------------------------------------------------

const NEWTON_ITERATIONS: usize = 8;
const NEWTON_EPSILON: f64 = 1e-7;
const BISECTION_EPSILON: f64 = 1e-7;
const BISECTION_MAX_ITERATIONS: usize = 64;

/// Curve token → cubic-bezier control points `[x1, y1, x2, y2]`. Mirrors
/// the normative `CURVE_BEZIER_POINTS` map in
/// `hypen-web/packages/core/src/animation.ts` — the CSS `ease-in` /
/// `ease-out` / `ease-in-out` keywords' fixed beziers plus the `spring`
/// overshoot preset `cubic-bezier(0.34, 1.56, 0.64, 1)`.
pub const CURVE_BEZIER_POINTS: &[(&str, [f64; 4])] = &[
    ("linear", [0.0, 0.0, 1.0, 1.0]),
    ("easeIn", [0.42, 0.0, 1.0, 1.0]),
    ("easeOut", [0.0, 0.0, 0.58, 1.0]),
    ("easeInOut", [0.42, 0.0, 0.58, 1.0]),
    ("spring", [0.34, 1.56, 0.64, 1.0]),
];

/// A numeric easing function: `eval(0) == 0`, `eval(1) == 1` exactly;
/// overshoot curves (`spring`) may exceed `1` mid-range, so consumers
/// interpolating clamped quantities (opacity, color channels) clamp the
/// *result of interpolation*, not `t`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Easing {
    /// Identity (short-circuits `linear`, and the defensive fallback for
    /// unknown tokens — the parser's snap-don't-throw contract).
    Linear,
    Bezier(Bezier),
}

impl Easing {
    pub fn eval(self, t: f64) -> f64 {
        match self {
            Easing::Linear => t.clamp(0.0, 1.0),
            Easing::Bezier(b) => b.eval(t),
        }
    }
}

/// Solved cubic-bezier evaluator (WebKit `UnitBezier` approach, matching
/// the shared TS implementation: Newton-Raphson with a bisection
/// fallback over the monotone `x(t)` polynomial).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bezier {
    ax: f64,
    bx: f64,
    cx: f64,
    ay: f64,
    by: f64,
    cy: f64,
}

impl Bezier {
    pub fn new(x1: f64, y1: f64, x2: f64, y2: f64) -> Self {
        // CSS clamps the x control points into [0,1] so x(t) is monotone
        // and invertible; y1/y2 stay unclamped (how `spring` overshoots).
        let cx1 = x1.clamp(0.0, 1.0);
        let cx2 = x2.clamp(0.0, 1.0);
        let cx = 3.0 * cx1;
        let bx = 3.0 * (cx2 - cx1) - cx;
        let ax = 1.0 - cx - bx;
        let cy = 3.0 * y1;
        let by = 3.0 * (y2 - y1) - cy;
        let ay = 1.0 - cy - by;
        Self {
            ax,
            bx,
            cx,
            ay,
            by,
            cy,
        }
    }

    fn sample_x(&self, t: f64) -> f64 {
        ((self.ax * t + self.bx) * t + self.cx) * t
    }

    fn sample_y(&self, t: f64) -> f64 {
        ((self.ay * t + self.by) * t + self.cy) * t
    }

    fn sample_derivative_x(&self, t: f64) -> f64 {
        (3.0 * self.ax * t + 2.0 * self.bx) * t + self.cx
    }

    fn solve_t(&self, x: f64) -> f64 {
        let mut t = x;
        for _ in 0..NEWTON_ITERATIONS {
            let error = self.sample_x(t) - x;
            if error.abs() < NEWTON_EPSILON {
                return t;
            }
            let derivative = self.sample_derivative_x(t);
            if derivative.abs() < 1e-6 {
                break; // too flat — Newton would blow up
            }
            t -= error / derivative;
        }
        // Bisection fallback: x(t) is monotone on [0,1], always lands.
        let mut lo = 0.0_f64;
        let mut hi = 1.0_f64;
        t = x;
        let mut i = 0;
        while i < BISECTION_MAX_ITERATIONS && hi - lo > BISECTION_EPSILON {
            t = (lo + hi) / 2.0;
            if self.sample_x(t) < x {
                lo = t;
            } else {
                hi = t;
            }
            i += 1;
        }
        t
    }

    pub fn eval(&self, t: f64) -> f64 {
        // Exact endpoints (and clamped out-of-range input) — settle logic
        // relies on eval(1) == 1 to finalize without a residual epsilon.
        if t <= 0.0 {
            return 0.0;
        }
        if t >= 1.0 {
            return 1.0;
        }
        self.sample_y(self.solve_t(t))
    }
}

/// Curve token → easing evaluator. Unknown tokens degrade to linear
/// (defensive; the engine never emits one).
pub fn curve_easing(curve: &str) -> Easing {
    if curve == "linear" {
        return Easing::Linear;
    }
    for (name, [x1, y1, x2, y2]) in CURVE_BEZIER_POINTS {
        if *name == curve {
            return Easing::Bezier(Bezier::new(*x1, *y1, *x2, *y2));
        }
    }
    Easing::Linear
}

// ---------------------------------------------------------------------------
// Channel specs + defensive parsing (mirrors core/animation.ts parsers)
// ---------------------------------------------------------------------------

/// `.animate` iteration count: forever, or a finite positive count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repeat {
    Loop,
    Count(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransitionSpec {
    pub duration: f64,
    pub curve: Easing,
    pub delay: f64,
    /// Scoped base-prop list (whitelist-filtered). `None` = every
    /// animatable prop transitions.
    pub props: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnterExitSpec {
    pub presets: Vec<String>,
    pub duration: f64,
    pub curve: Easing,
    pub delay: f64,
    /// `from` on enter, `to` on exit. Unused for motion on desktop (slide
    /// is unpaintable) but parsed for spec fidelity.
    pub direction: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnimateSpec {
    pub preset: String,
    pub duration: f64,
    pub delay: f64,
    pub repeat: Repeat,
    pub curve: Easing,
}

/// `.layout(...)` — FLIP intent for `Move` patches: timing only
/// (mirrors `parseLayout` in `@hypen-space/core/animation`).
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutSpec {
    pub duration: f64,
    pub curve: Easing,
    pub delay: f64,
}

/// `.sharedElement(...)` timing spec (Option H). The identity KEY rides
/// its own prop (`__anim.sharedKey`, binding-capable) and is tracked
/// separately in [`SharedEntry`]; this is only the `{duration, curve}`
/// timing object (`delay` is not part of the shared channel). Mirrors
/// `parseSharedSpec` in `@hypen-space/core/animation`.
#[derive(Debug, Clone, PartialEq)]
pub struct SharedSpec {
    pub duration: f64,
    pub curve: Easing,
}

/// A node's shared-element identity + timing (Option H). Mirrors the
/// DOM animator's per-node `SharedEntry`: the `key` is what navigation
/// matching runs on and re-resolves as an ordinary SetProp when its
/// driving state changes; the `spec` supplies the FLIP timing. An entry
/// exists while the node carries either half; when both are gone it is
/// dropped.
#[derive(Debug, Default, Clone)]
struct SharedEntry {
    key: Option<String>,
    spec: Option<SharedSpec>,
}

/// Which half of a [`SharedEntry`] a SetProp updates.
enum SharedField {
    Key(Option<String>),
    Spec(Option<SharedSpec>),
}

/// A measured shared-element frame — position AND size, so the FLIP can
/// scale as well as translate. Physical pixels, the coordinate space the
/// layout's `visual_rect` (the desktop equivalent of the DOM's
/// `getBoundingClientRect`) reports.
#[derive(Debug, Clone, Copy)]
struct SharedRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// Parsed channels for one node. `None` = absent or malformed — either
/// way the renderer snaps (the spec-sanctioned degradation).
#[derive(Debug, Default, Clone)]
struct NodeSpecs {
    transition: Option<TransitionSpec>,
    enter: Option<EnterExitSpec>,
    exit: Option<EnterExitSpec>,
    animate: Option<AnimateSpec>,
    layout: Option<LayoutSpec>,
}

/// A channel value normally arrives as a JSON object; a stringified
/// object is tolerated for hosts that pass raw JSON through (Remote UI).
fn channel_object(value: &Value) -> Option<serde_json::Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map.clone()),
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        },
        _ => None,
    }
}

fn as_duration(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    if n.is_finite() && n >= 0.0 {
        Some(n)
    } else {
        None
    }
}

fn as_curve(v: Option<&Value>) -> Option<(&'static str, Easing)> {
    let s = v?.as_str()?;
    CURVES
        .iter()
        .find(|c| **c == s)
        .map(|c| (*c, curve_easing(c)))
}

/// Shared duration/curve/delay core. The engine always emits duration +
/// curve (defaults filled at lowering), so a missing or invalid one marks
/// the whole channel malformed.
fn parse_timing(obj: &serde_json::Map<String, Value>) -> Option<(f64, Easing, f64)> {
    let duration = as_duration(obj.get("duration"))?;
    let (_, curve) = as_curve(obj.get("curve"))?;
    let delay = as_duration(obj.get("delay")).unwrap_or(0.0);
    Some((duration, curve, delay))
}

fn parse_presets(v: Option<&Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    let presets: Vec<String> = arr
        .iter()
        .filter_map(|p| p.as_str())
        .filter(|p| PRESETS.contains(p))
        .map(str::to_string)
        .collect();
    if presets.is_empty() {
        None
    } else {
        Some(presets)
    }
}

pub(crate) fn parse_transition(value: &Value) -> Option<TransitionSpec> {
    let obj = channel_object(value)?;
    let (duration, curve, delay) = parse_timing(&obj)?;
    let props = match obj.get("props") {
        None => None,
        Some(Value::Array(arr)) => {
            let filtered: Vec<String> = arr
                .iter()
                .filter_map(|p| p.as_str())
                .filter(|p| ANIMATABLE_PROPS.contains(p))
                .map(str::to_string)
                .collect();
            // A scope that filters to nothing animates nothing — same as
            // no channel (mirrors the TS parser).
            if filtered.is_empty() {
                return None;
            }
            Some(filtered)
        }
        Some(_) => return None,
    };
    Some(TransitionSpec {
        duration,
        curve,
        delay,
        props,
    })
}

pub(crate) fn parse_layout_spec(value: &Value) -> Option<LayoutSpec> {
    let obj = channel_object(value)?;
    let (duration, curve, delay) = parse_timing(&obj)?;
    Some(LayoutSpec {
        duration,
        curve,
        delay,
    })
}

fn parse_enter_exit(value: &Value, direction_key: &str) -> Option<EnterExitSpec> {
    let obj = channel_object(value)?;
    let (duration, curve, delay) = parse_timing(&obj)?;
    let presets = parse_presets(obj.get("presets"))?;
    let direction = obj
        .get(direction_key)
        .and_then(Value::as_str)
        .filter(|d| hypen_engine::ir::anim::DIRECTIONS.contains(d))
        .map(str::to_string);
    Some(EnterExitSpec {
        presets,
        duration,
        curve,
        delay,
        direction,
    })
}

pub(crate) fn parse_animate(value: &Value) -> Option<AnimateSpec> {
    let obj = channel_object(value)?;
    let preset = obj.get("preset")?.as_str()?;
    if !ANIMATE_PRESETS.contains(&preset) {
        return None;
    }
    let (duration, curve, delay) = parse_timing(&obj)?;
    let repeat = match obj.get("repeat") {
        Some(Value::String(s)) if s == "loop" => Repeat::Loop,
        Some(Value::Number(n)) => {
            let f = n.as_f64()?;
            if f.fract() == 0.0 && f >= 1.0 {
                Repeat::Count(f as u64)
            } else {
                return None;
            }
        }
        _ => return None,
    };
    Some(AnimateSpec {
        preset: preset.to_string(),
        duration,
        delay,
        repeat,
        curve,
    })
}

/// `__anim.motion` → the `.motion(essential)` flag. Only an object whose
/// `essential` field is exactly `true` opts the node out of reduced
/// motion; anything else degrades to `false` (default snap behavior).
pub(crate) fn parse_motion_essential(value: &Value) -> bool {
    channel_object(value)
        .and_then(|obj| obj.get("essential").cloned())
        .map(|v| v == Value::Bool(true))
        .unwrap_or(false)
}

/// `__anim.sharedKey` → the shared-element identity key. Alone among
/// animation arguments the key is allowed to bind, so it arrives as a
/// resolved string SetProp; a non-string or empty value is no identity.
/// Mirrors `parseSharedKey` in `@hypen-space/core/animation`.
pub(crate) fn parse_shared_key(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `__anim.shared` → the shared-element FLIP timing (`{duration, curve}`).
/// The engine always emits both (defaults filled at lowering), so a
/// missing/invalid one marks the channel malformed (snap). Mirrors
/// `parseSharedSpec` in `@hypen-space/core/animation`.
pub(crate) fn parse_shared_spec(value: &Value) -> Option<SharedSpec> {
    let obj = channel_object(value)?;
    let duration = as_duration(obj.get("duration"))?;
    let (_, curve) = as_curve(obj.get("curve"))?;
    Some(SharedSpec { duration, curve })
}

/// Resolve an engine prop key (`"width.0"`, `"backgroundColor"`) to its
/// animatable base prop, or `None` when it is variant-scoped
/// (`"width@md.0"`, `"color:hover"`) or off the whitelist. Mirrors
/// `animatableBaseProp` in `@hypen-space/core/animation`.
///
/// Recorded v1 narrowing: variant-decorated keys are invisible to the
/// animator on BOTH sides. A decorated SetProp never starts a
/// transition (this function returns `None`), and the animator's base
/// reads ([`DesktopAnimator::playback_targets`], ambient originals) use
/// the plain `prop_f32` chain — while paint resolves opacity
/// variant-aware (`prop_f32_at` via `effective_opacity`). A node whose
/// opacity comes from an ACTIVE decorated key (`opacity@md.0` at a wide
/// viewport) therefore fades against the base value, and the paint-side
/// variant resolution shadows the animator's plain/`.0` writes — the
/// fade degrades to a snap for that node. Fixing this needs viewport +
/// interaction state plumbed into the animator's read/write key
/// selection; until then the degradation is sanctioned (snap, never a
/// wrong steady state: decorated keys are engine-owned and the animator
/// never writes them).
pub(crate) fn animatable_base_prop(name: &str) -> Option<&str> {
    let base = match name.find('.') {
        Some(dot) => &name[..dot],
        None => name,
    };
    if base.contains('@') || base.contains(':') {
        return None;
    }
    if ANIMATABLE_PROPS.contains(&base) {
        Some(base)
    } else {
        None
    }
}

/// Resolve the props key a playback/ambient write for `base` should
/// target on `node`: the key the node already carries — plain base
/// first, then the `.0` single-arg form, matching the style fallback
/// chain's precedence — else the plain base for a node with no current
/// value. Writing the node's REAL key keeps the animator on the same
/// key the engine subsequently patches, so an engine SetProp lands on
/// the playback's own write instead of a shadowed sibling key
/// (`prop_f32` prefers `"opacity"` over `"opacity.0"`; a stale plain
/// write would mask the engine's value forever).
fn base_write_key(node: &crate::tree::Node, base: &str) -> String {
    if node.props.contains_key(base) {
        return base.to_string();
    }
    let dotted = format!("{base}.0");
    if node.props.contains_key(&dotted) {
        return dotted;
    }
    base.to_string()
}

// ---------------------------------------------------------------------------
// Value parsing / interpolation
// ---------------------------------------------------------------------------

/// Whitelist props whose values are colors (interpolated in RGBA space).
const COLOR_PROPS: &[&str] = &["color", "backgroundColor", "borderColor"];

// Transform props (`translateX`/`translateY`/`scale`/`rotate`)
// interpolate like any other numeric prop but are consumed by the
// paint/hit transform post-pass (`crate::layout::compute_item_transforms`)
// instead of Taffy — they move the painted+hittable presentation, never
// layout geometry, so `affects_layout` stays false for them.

/// Props each supported `.animate` preset writes on desktop. Empty =
/// unsupported → sanctioned no-op (see the module docs' matrix —
/// `shimmer` is the one remaining no-op).
fn ambient_preset_props(preset: &str) -> &'static [&'static str] {
    match preset {
        "pulse" => &["opacity"],
        "spin" => &["rotate"],
        "shake" => &["translateX"],
        // shimmer: DOM-only gradient overlay, no honest equivalent.
        _ => &[],
    }
}

/// Mirrors the DOM `@keyframes hypen-pulse` shape (opacity 1 → 0.5 → 1),
/// identical to the canvas animator's `PULSE_STOPS`.
const PULSE_STOPS: &[(f64, f64)] = &[(0.0, 1.0), (0.5, 0.5), (1.0, 1.0)];

/// Mirrors the DOM `@keyframes hypen-shake` translateX offsets,
/// identical to the canvas animator's `SHAKE_STOPS`.
const SHAKE_STOPS: &[(f64, f64)] = &[
    (0.0, 0.0),
    (0.2, -6.0),
    (0.4, 6.0),
    (0.6, -4.0),
    (0.8, 4.0),
    (1.0, 0.0),
];

/// Piecewise-linear keyframe evaluation over eased iteration progress.
fn piecewise(stops: &[(f64, f64)], p: f64) -> f64 {
    if p <= stops[0].0 {
        return stops[0].1;
    }
    for i in 1..stops.len() {
        let (t1, v1) = stops[i];
        if p <= t1 {
            let (t0, v0) = stops[i - 1];
            let span = t1 - t0;
            return if span > 0.0 {
                v0 + ((p - t0) / span) * (v1 - v0)
            } else {
                v1
            };
        }
    }
    stops[stops.len() - 1].1
}

/// Coerce a prop value to a finite number (bare numbers and `"16px"`).
fn parse_numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let trimmed = s.trim();
            let stripped = trimmed.strip_suffix("px").unwrap_or(trimmed);
            let n: f64 = stripped.parse().ok()?;
            if n.is_finite() {
                Some(n)
            } else {
                None
            }
        }
        _ => None,
    }
}

type RgbaF = [f64; 4];

/// Parse a color prop value through the desktop style color parser (hex
/// 3/4/6/8-digit + basic named colors — `rgb()` is not in the desktop
/// vocabulary). Unparseable colors snap, the sanctioned degradation.
fn parse_color_value(value: &Value) -> Option<RgbaF> {
    let s = value.as_str()?;
    let c = crate::style::parse_color(s)?;
    Some([c.0 as f64, c.1 as f64, c.2 as f64, c.3 as f64])
}

/// Format an interpolated color as `#rrggbbaa` — the desktop
/// `style::parse_color` round-trips this exactly. Channels clamped
/// (spring may overshoot: clamp the interpolation RESULT, not `t`).
fn format_color(c: RgbaF) -> String {
    let q = |v: f64| (v.round().clamp(0.0, 255.0)) as u8;
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        q(c[0]),
        q(c[1]),
        q(c[2]),
        q(c[3])
    )
}

#[derive(Debug, Clone, PartialEq)]
enum Interp {
    Number { from: f64, to: f64 },
    Color { from: RgbaF, to: RgbaF },
}

fn make_interp(base: &str, from: &Value, to: &Value) -> Option<Interp> {
    if COLOR_PROPS.contains(&base) {
        let f = parse_color_value(from)?;
        let t = parse_color_value(to)?;
        return Some(Interp::Color { from: f, to: t });
    }
    let f = parse_numeric(from)?;
    let t = parse_numeric(to)?;
    Some(Interp::Number { from: f, to: t })
}

fn interp_is_noop(interp: &Interp) -> bool {
    match interp {
        Interp::Number { from, to } => from == to,
        Interp::Color { from, to } => from == to,
    }
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

/// A captured pre-playback prop value: restore exactly (delete if it was
/// absent) when the playback settles.
#[derive(Debug, Clone)]
struct Stored {
    present: bool,
    value: Value,
}

#[derive(Debug, Clone)]
struct PropAnim {
    /// The exact props key written each tick (`"width.0"`, `"opacity"`) —
    /// the key layout/paint read through the style fallback chain.
    write_key: String,
    start: f64,
    delay: f64,
    duration: f64,
    ease: Easing,
    interp: Interp,
    /// Exact value written at settle when no `restore` is set — the raw
    /// target a plain (non-animated) SetProp would have left in place.
    target_raw: Value,
    /// Enter playbacks restore the pre-playback prop exactly. Refreshed
    /// when the engine writes the same prop mid-flight — the engine's
    /// value is the new ground truth to land on.
    restore: Option<Stored>,
    /// Clamp interpolation results to [0,1] (opacity under overshoot).
    clamp_unit: bool,
    /// Taffy restyle needed every tick (geometry follows the value).
    affects_layout: bool,
    /// Delay-phase hold value has been written (write once, not per frame).
    hold_written: bool,
    /// `Some(node_id)`: member of that node's enter playback group —
    /// the ambient preset suspended for the enter resumes when the last
    /// member finishes.
    enter_of: Option<String>,
}

#[derive(Debug, Clone)]
struct Ambient {
    spec: AnimateSpec,
    start: f64,
    props: &'static [&'static str],
    /// Captured pre-playback values, keyed by the WRITE KEY actually
    /// used for each base prop (see `write_keys`) so restore lands on
    /// the key the ticks wrote.
    originals: HashMap<String, Stored>,
    /// Base prop → the props key this ambient's ticks write
    /// (`"opacity"` or `"opacity.0"`, whichever the node/engine owns).
    /// Migrated to the engine's key when an engine write arrives on a
    /// different key — the engine's key wins (see
    /// [`DesktopAnimator::reconcile_engine_write`]).
    write_keys: HashMap<String, String>,
    /// Base opacity (pulse multiplies it). Refreshed on engine writes.
    base_opacity: f64,
    /// Suspended while a conflicting enter/exit playback owns the props.
    suspended: bool,
}

/// One resolved preset target for an enter/exit playback (see
/// [`DesktopAnimator::playback_targets`]).
#[derive(Debug, Clone)]
struct PlaybackTarget {
    /// Base prop keying the anims map / ambient conflict checks.
    base: String,
    /// The props key the ticks actually write (plain vs `.0`).
    write_key: String,
    from: f64,
    to: f64,
    /// Clamp interpolation results to [0,1] (opacity under overshoot).
    clamp_unit: bool,
}

/// Walk `dir` props up the tree to resolve the layout direction —
/// canvas parity (`isRtl` in canvas/anim.ts; desktop has no DOM `dir`
/// attribute either).
fn is_rtl(tree: &Tree, id: &str) -> bool {
    let mut current = Some(id);
    while let Some(cur) = current {
        if let Some(node) = tree.get(cur) {
            let dir = node
                .props
                .get("dir")
                .or_else(|| node.props.get("dir.0"))
                .and_then(Value::as_str);
            match dir {
                Some("rtl") => return true,
                Some("ltr") => return false,
                _ => {}
            }
        }
        current = tree.parent_of(cur);
    }
    false
}

/// Resolve the slide preset's axis + hidden offset from the direction
/// token (`from` on enter / `to` on exit) — mirrors `slideAxis` in the
/// canvas animator.
fn slide_axis(direction: Option<&str>, rtl: bool) -> (&'static str, f64) {
    match direction.unwrap_or("leading") {
        "top" => ("translateY", -SLIDE_OFFSET_PX),
        "bottom" => ("translateY", SLIDE_OFFSET_PX),
        "trailing" => (
            "translateX",
            if rtl {
                -SLIDE_OFFSET_PX
            } else {
                SLIDE_OFFSET_PX
            },
        ),
        // "leading" and the defensive default.
        _ => (
            "translateX",
            if rtl {
                SLIDE_OFFSET_PX
            } else {
                -SLIDE_OFFSET_PX
            },
        ),
    }
}

/// A pending `.states` transition-settle window (Option F). When the tick
/// clock reaches `settle_at` and the node is still live, fire
/// `{ animation: "states", state: label }`. A superseding label change (or
/// teardown) removes the entry BEFORE it fires — natural settles only,
/// mirroring the DOM `scheduleStateSettle` timer.
#[derive(Debug, Clone)]
struct StateSettle {
    /// The pose label that was active when the window opened.
    label: String,
    /// Tick-clock fire time (`duration + delay` of the node's transition).
    settle_at: f64,
}

#[derive(Debug, Clone)]
struct ExitRecord {
    /// The withheld removal patches: the flagged root Remove first, then
    /// any descendant plain Removes that arrived while the root was
    /// exiting. Applied to the tree (and mirrored to Taffy by the
    /// caller) at finalize.
    patches: Vec<Patch>,
    /// Tick-clock settle time (duration + delay).
    settle_at: f64,
    /// Overdue backbone (settle + grace) — the patch-flush path
    /// finalizes past this even when the redraw ticker stalled.
    overdue_at: f64,
}

/// What a [`DesktopAnimator::tick`] (or snap/finalize path) did, so the
/// window can keep its caches coherent.
#[derive(Debug, Default)]
pub struct TickOutcome {
    /// At least one prop was written into the tree — the layout items
    /// must re-emit (bump the patch epoch / layout cache key, invalidate
    /// the painter's subtree cache, mark full damage).
    pub wrote: bool,
    /// Node ids whose LAYOUT-AFFECTING props were animated this tick —
    /// the retained Taffy styles for these must be recomputed so Taffy
    /// re-solves and hit-testing follows the animated geometry.
    pub restyle: Vec<String>,
    /// Deferred removal patches finalized this tick. Already applied to
    /// the renderer tree; the caller MUST mirror them into Taffy.
    pub finalized: Vec<Patch>,
}

impl TickOutcome {
    pub fn is_empty(&self) -> bool {
        !self.wrote && self.restyle.is_empty() && self.finalized.is_empty()
    }

    fn merge(&mut self, other: TickOutcome) {
        self.wrote |= other.wrote;
        self.restyle.extend(other.restyle);
        self.finalized.extend(other.finalized);
    }
}

/// What one [`DesktopAnimator::ingest`] batch did, so the window can
/// keep its retained Taffy mirror coherent.
#[derive(Debug, Default)]
pub struct IngestOutcome {
    /// The patches actually applied to the renderer tree, in
    /// application order — the caller mirrors exactly these into
    /// Taffy. Includes removal patches for exits finalized during the
    /// batch (defensive re-Create finalize, end-of-batch
    /// `.motion(essential)` snaps), which arrive after the patches
    /// that triggered them.
    pub forwarded: Vec<Patch>,
    /// Node ids whose LAYOUT-AFFECTING props were written by
    /// end-of-batch work (queued essential snaps landing their
    /// targets): the caller must restyle these in the retained Taffy
    /// state, exactly like [`TickOutcome::restyle`]. Without it Taffy
    /// keeps the mid-flight geometry until an unrelated restyle.
    pub restyle: Vec<String>,
    /// End-of-batch work FINALIZED at least one in-flight exit — a
    /// subtree left the tree even though the input batch may have
    /// carried no structural patch at all (e.g. a paint-classified
    /// `RemoveProp` of `__anim.motion` lifting the essential
    /// exemption). The window's paint-only classifier must treat the
    /// batch as structural: the finalized removals appear only in
    /// `forwarded`, never in the input patches it inspects.
    pub finalized_any: bool,
}

/// A naturally-settled animation's `.onAnimationComplete` dispatch,
/// already resolved to the action name and the merged payload
/// (`{ ...customArgs, animation, state? }`, completion fields written
/// last so they can't be shadowed). Surfaced through
/// [`DesktopAnimator::take_completions`] for the window to route to
/// `module.dispatch_action`, exactly like a click/hover action.
///
/// Only NATURAL settles emit one, and only on nodes carrying an
/// `.onAnimationComplete` action prop — interrupted, superseded, and
/// reduced-motion-skipped playbacks (and looping presets, and nodes
/// without the prop) push nothing. Mirrors the DOM
/// `dispatchAnimationComplete` contract (Option F / Shipped v1).
#[derive(Debug, Clone, PartialEq)]
pub struct AnimationCompletion {
    pub action: String,
    pub payload: serde_json::Value,
}

enum Clock {
    Real(std::time::Instant),
    Manual(f64),
}

fn env_reduced_motion() -> bool {
    match std::env::var("HYPEN_REDUCED_MOTION") {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Animator
// ---------------------------------------------------------------------------

pub struct DesktopAnimator {
    clock: Clock,
    reduced_motion: bool,
    /// Ids the [`DesktopScrubber`] currently owns (drag/settle/held, or an
    /// engaged scroll source under active input). Synced by the window at
    /// the head of every patch flush ([`DesktopAnimator::set_scrub_active`]).
    /// Option G precedence — scrub > structural playbacks > transaction >
    /// node `.transition`: a scrub-active node is excluded from transaction
    /// application, `.states` pose glides, and enter/FLIP/shared
    /// participation, mirroring the DOM animator's `scrubActive` guard.
    scrub_active: HashSet<String>,
    /// Parsed channel specs per node id.
    specs: HashMap<String, NodeSpecs>,
    /// Ids carrying `.motion(essential)` — exempt from reduced motion.
    motion_essential: HashSet<String>,
    /// In-flight prop animations keyed `(node_id, base_prop)`.
    anims: HashMap<(String, String), PropAnim>,
    /// Ambient `.animate` timelines keyed by node id.
    ambients: HashMap<String, Ambient>,
    /// Ids whose finite-repeat preset already exhausted (never replays).
    finished_ambients: HashSet<String>,
    /// Outstanding enter-group member counts per node id (ambient
    /// resume runs when the count reaches zero).
    enter_groups: HashMap<String, usize>,
    /// Exit-animating subtree ROOTS awaiting finalize.
    exits: HashMap<String, ExitRecord>,
    /// Nodes inserted this batch whose enter should play at batch end.
    pending_enters: Vec<String>,
    /// `.layout` FLIP First-rect snapshots for `Move`d nodes, keyed by
    /// id, in the coordinate space of the pre-batch layout. Recorded by
    /// [`DesktopAnimator::prepare_moves`] BEFORE the batch mutates the
    /// tree; played by [`DesktopAnimator::play_pending_flips`] once the
    /// post-batch layout provides the Last rects.
    pending_flips: HashMap<String, (f32, f32)>,
    /// `.layout` siblings of an exiting root, recorded at exit finalize
    /// (#146 sibling-shift for flagged/exit removes). A flagged remove
    /// holds its node in flow for the whole exit, so its siblings reflow
    /// only at teardown — later than `prepare_moves` can observe. These
    /// ids are captured (before teardown unlinks the root) here, then the
    /// window measures their First rects off the still-current
    /// pre-teardown layout and moves them into `pending_flips` via
    /// [`DesktopAnimator::queue_removal_sibling_flips`]. Mirrors the DOM's
    /// finalizeExit → collectRemovalSiblingFlips path (anim.ts:1695).
    removal_flip_candidates: Vec<String>,
    /// Ids created this batch WITH an enter spec.
    created_this_batch: HashSet<String>,
    /// EVERY id created this batch — a same-batch SetProp on a fresh
    /// node never starts a transition (its enter owns the first motion;
    /// nodes without an enter snap too, DOM parity).
    created_nodes_this_batch: HashSet<String>,
    /// The first-ever batch never enter-animates (no initial cascade).
    first_batch_done: bool,
    /// Transaction-scoped animation spec for the CURRENT batch (Option D
    /// cheap subset), set by a batch-head `BatchAnimation` patch and
    /// cleared at the end of every batch.
    transaction: Option<TransitionSpec>,
    /// `.animate` spec changes seen mid-batch. The stop-and-restore (and
    /// possible restart) needs `&mut Tree`, which the `__anim.*` SetProp
    /// route doesn't hold — applied in `flush_batch`.
    pending_ambient_restarts: Vec<(String, Option<AnimateSpec>)>,
    /// `.motion(essential)` flags removed while reduced motion is active:
    /// those nodes' in-flight work snaps at the end of the batch (the
    /// per-node form of the live toggle-on snap).
    pending_essential_snaps: Vec<String>,
    /// Per-node shared-element identity/timing (Option H). Populated from
    /// `__anim.sharedKey`/`__anim.shared` on Create and SetProp; the key
    /// is what navigation matching runs on.
    shared: HashMap<String, SharedEntry>,
    /// Source-side snapshots for the CURRENT navigation batch: shared key
    /// → `(source visual rect in physical px, owning id)`, measured in
    /// [`DesktopAnimator::prepare_shared`] off the PRE-batch layout,
    /// BEFORE the batch mutates the tree. Scoped to the leaving (detach)
    /// subtree(s). Cleared at the start of every `prepare_shared` and the
    /// end of every `play_shared_flips`.
    shared_snapshots: HashMap<String, (SharedRect, String)>,
    /// Ids created THIS batch that carry a shared key — the created kind
    /// of incoming FLIP candidate. Survives `flush_batch` (unlike
    /// `created_this_batch`) so the redraw's `play_shared_flips` can read
    /// it; cleared with the rest of the per-batch shared state.
    shared_created_this_batch: HashSet<String>,
    /// Roots re-attached this batch (Router cache): nodes at-or-under one
    /// are the other kind of incoming shared-element candidate.
    attached_roots_this_batch: Vec<String>,
    /// Whether the current batch has navigation shape (a `Detach` AND an
    /// `Attach`/`Insert`). Only navigation batches snapshot and FLIP.
    navigation_batch: bool,
    /// Shared-element dev-warning dedup (kind-prefixed keys): a persistent
    /// authoring mistake (one-sided key) warns on the first navigation
    /// that exposes it, not on every one.
    warned_shared: HashSet<String>,
    /// `.onAnimationComplete` dispatches accumulated since the last
    /// [`DesktopAnimator::take_completions`] drain. Pushed at each NATURAL
    /// settle point (enter/exit/finite-preset/states/sharedElement);
    /// interrupt/supersede/reduced-motion paths push nothing.
    pending_completions: Vec<AnimationCompletion>,
    /// For a node whose enter/shared-FLIP playback GROUP settles naturally,
    /// the `animation` name to report ("enter" or "sharedElement"). A
    /// `.layout` FLIP group has NO entry — it fires nothing (DOM parity).
    /// Cleared when the group completes (natural OR superseded) or the node
    /// is forgotten.
    group_completion: HashMap<String, &'static str>,
    /// Current `.states` pose label per node id (non-default only; the
    /// default pose is absent). Drives the changed-label check that opens a
    /// settle window.
    state_labels: HashMap<String, String>,
    /// Pending `.states` settle windows keyed by node id (see
    /// [`StateSettle`]).
    state_settles: HashMap<String, StateSettle>,
}

impl Default for DesktopAnimator {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopAnimator {
    pub fn new() -> Self {
        Self {
            clock: Clock::Real(std::time::Instant::now()),
            reduced_motion: env_reduced_motion(),
            scrub_active: HashSet::new(),
            specs: HashMap::new(),
            motion_essential: HashSet::new(),
            anims: HashMap::new(),
            ambients: HashMap::new(),
            finished_ambients: HashSet::new(),
            enter_groups: HashMap::new(),
            exits: HashMap::new(),
            pending_enters: Vec::new(),
            pending_flips: HashMap::new(),
            removal_flip_candidates: Vec::new(),
            created_this_batch: HashSet::new(),
            created_nodes_this_batch: HashSet::new(),
            first_batch_done: false,
            transaction: None,
            pending_ambient_restarts: Vec::new(),
            pending_essential_snaps: Vec::new(),
            shared: HashMap::new(),
            shared_snapshots: HashMap::new(),
            shared_created_this_batch: HashSet::new(),
            attached_roots_this_batch: Vec::new(),
            navigation_batch: false,
            warned_shared: HashSet::new(),
            pending_completions: Vec::new(),
            group_completion: HashMap::new(),
            state_labels: HashMap::new(),
            state_settles: HashMap::new(),
        }
    }

    /// Replace the set of scrub-owned node ids (Option G precedence). The
    /// window syncs this from [`DesktopScrubber::owned_ids`] at the head of
    /// every flush, before `prepare_moves`/`prepare_shared`/`ingest` run, so
    /// the batch's transaction/pose/FLIP/shared paths all see a consistent
    /// ownership snapshot. A scrub-active node's non-scrubbed prop changes
    /// snap (no transaction glide), its `.states` pose switches snap, and it
    /// never sources or receives a FLIP/shared playback.
    pub fn set_scrub_active(&mut self, ids: HashSet<String>) {
        self.scrub_active = ids;
    }

    /// Drain the `.onAnimationComplete` dispatches accumulated since the
    /// last call. The window forwards each to `module.dispatch_action`.
    /// Called after every animator entry point that can settle a playback
    /// (tick / ingest / finalize_overdue / play_shared_flips); empty in the
    /// overwhelmingly common case.
    pub fn take_completions(&mut self) -> Vec<AnimationCompletion> {
        std::mem::take(&mut self.pending_completions)
    }

    /// Resolve `id`'s `.onAnimationComplete` action off the tree and queue
    /// a completion dispatch with `{ ...customArgs, animation, state? }`.
    /// No-op — and ZERO overhead beyond the prop lookup — when the node
    /// carries no `.onAnimationComplete` prop. Callers MUST gate this on a
    /// natural settle; the fields are written last so custom args can never
    /// shadow `animation`/`state` (DOM `dispatchAnimationComplete` parity).
    fn queue_completion(&mut self, tree: &Tree, id: &str, animation: &str, state: Option<&str>) {
        let Some(node) = tree.get(id) else {
            return;
        };
        let Some((action, mut payload)) =
            crate::layout::resolve_named_event_action(node, "onAnimationComplete")
        else {
            return; // no completion action wired — nothing to dispatch
        };
        if let Value::Object(ref mut obj) = payload {
            obj.insert(
                "animation".to_string(),
                Value::String(animation.to_string()),
            );
            if let Some(s) = state {
                obj.insert("state".to_string(), Value::String(s.to_string()));
            }
        }
        self.pending_completions
            .push(AnimationCompletion { action, payload });
    }

    /// Current animator clock in milliseconds.
    fn now(&self) -> f64 {
        match &self.clock {
            Clock::Real(start) => start.elapsed().as_secs_f64() * 1000.0,
            Clock::Manual(t) => *t,
        }
    }

    /// Test hook / host override: drive the clock manually. Subsequent
    /// `tick` calls advance to the given time in milliseconds.
    pub fn set_manual_time_ms(&mut self, t: f64) {
        self.clock = Clock::Manual(t);
    }

    pub fn reduced_motion(&self) -> bool {
        self.reduced_motion
    }

    /// Programmatic reduced-motion toggle (the env var seeds the initial
    /// value). Toggling ON snaps every in-flight animation except
    /// `.motion(essential)` nodes; toggling OFF restarts `.animate`
    /// specs registered while it was on (exhausted finite presets never
    /// replay). Returns what changed so the caller can invalidate caches
    /// and mirror finalized removals into Taffy.
    pub fn set_reduced_motion(&mut self, on: bool, tree: &mut Tree) -> TickOutcome {
        if self.reduced_motion == on {
            return TickOutcome::default();
        }
        self.reduced_motion = on;
        if on {
            let essential = self.motion_essential.clone();
            self.snap_subset(tree, |id| !essential.contains(id))
        } else {
            self.restart_ambients(tree);
            TickOutcome::default()
        }
    }

    fn specs_mut(&mut self, id: &str) -> &mut NodeSpecs {
        self.specs.entry(id.to_string()).or_default()
    }

    /// May `id` play motion right now? True unless reduced motion is on
    /// AND the node lacks the `.motion(essential)` opt-out.
    fn motion_allowed(&self, id: &str) -> bool {
        !self.reduced_motion || self.motion_essential.contains(id)
    }

    /// Whether anything needs further frames (keeps the redraw loop
    /// armed). Ambients only count while they can actually run: a
    /// Router-detached subtree's looping preset must not re-arm redraws
    /// forever for a node that is never painted.
    pub fn has_active(&self, tree: &Tree) -> bool {
        if !self.anims.is_empty()
            || !self.exits.is_empty()
            || !self.pending_enters.is_empty()
            || !self.pending_flips.is_empty()
            // A pending `.states` settle window keeps the ticker armed even
            // when no prop is animating (the pose props may have snapped),
            // so the completion fires when the window elapses.
            || !self.state_settles.is_empty()
        {
            return true;
        }
        self.ambients
            .iter()
            .any(|(id, a)| !a.suspended && is_attached(tree, id))
    }

    /// Is `id` at-or-under an exit-animating subtree root? Exiting
    /// subtrees are engine-side dead the moment the flagged Remove was
    /// emitted — the window excludes them from hit-testing immediately.
    pub fn is_exit_excluded(&self, tree: &Tree, id: &str) -> bool {
        if self.exits.is_empty() {
            return false;
        }
        let mut current = Some(id);
        while let Some(cur) = current {
            if self.exits.contains_key(cur) {
                return true;
            }
            current = tree.parent_of(cur);
        }
        false
    }

    // -----------------------------------------------------------------
    // Patch ingestion (replaces `Tree::apply_batch` in the window)
    // -----------------------------------------------------------------

    /// Route one patch batch through the animator into the tree.
    ///
    /// Returns the patches actually applied to the renderer tree, for
    /// the caller to mirror into Taffy: a leading `BatchAnimation`
    /// prelude is consumed here (batch-head only, per the wire
    /// contract), and removal patches withheld for a deferred exit are
    /// excluded until their exit finalizes (they resurface through
    /// [`TickOutcome::finalized`] / [`DesktopAnimator::finalize_overdue`]).
    /// Everything else is forwarded verbatim — a batch with no animation
    /// content behaves exactly like the pre-animator pipeline.
    pub fn ingest(&mut self, patches: &[Patch], tree: &mut Tree) -> IngestOutcome {
        let mut forwarded: Vec<Patch> = Vec::with_capacity(patches.len());
        for (idx, patch) in patches.iter().enumerate() {
            match patch {
                Patch::BatchAnimation { spec } => {
                    // First-patch-only is normative on both ends: a
                    // prelude anywhere else is not a stamp for this
                    // batch (accumulated/concatenated batches must not
                    // over-scope). Never forwarded — it addresses no
                    // node and Taffy has nothing to mirror.
                    if idx == 0 {
                        self.transaction = parse_transition(spec);
                    }
                }
                Patch::Create { id, props, .. } => {
                    // Defensive: a Create for an id that is still
                    // exit-animating finalizes the old subtree first so
                    // the corpse can't shadow the new node.
                    if self.exits.contains_key(id.as_ref()) {
                        // Supersede: a new node replaces the exiting one.
                        // Interruption, not a settle — fires no completion.
                        forwarded.extend(self.finalize_exit(id.to_string(), tree, false));
                    }
                    tree.apply(patch);
                    forwarded.push(patch.clone());
                    self.register_create(id, props.as_ref());
                }
                Patch::SetProp { id, name, value } => {
                    if name.starts_with("__anim.") {
                        tree.apply(patch);
                        forwarded.push(patch.clone());
                        self.set_anim_prop(tree, id, name, Some(value));
                    } else if let Some(base) = animatable_base_prop(name).map(str::to_string) {
                        let previous = tree
                            .get(id)
                            .and_then(|n| n.props.get(name.as_str()).cloned());
                        tree.apply(patch);
                        forwarded.push(patch.clone());
                        self.note_prop_set(tree, id, name, &base, previous);
                    } else {
                        tree.apply(patch);
                        forwarded.push(patch.clone());
                    }
                }
                Patch::RemoveProp { id, name } => {
                    tree.apply(patch);
                    forwarded.push(patch.clone());
                    if name.starts_with("__anim.") {
                        self.set_anim_prop(tree, id, name, None);
                    } else if let Some(base) = animatable_base_prop(name).map(str::to_string) {
                        self.note_prop_removed(tree, id, name, &base);
                    }
                }
                Patch::Insert { id, .. } => {
                    tree.apply(patch);
                    forwarded.push(patch.clone());
                    // Enter is queued only for same-batch creations, so
                    // a cached Router `Attach` (a different patch type
                    // altogether) never enter-animates.
                    if self.created_this_batch.contains(id.as_ref()) {
                        self.pending_enters.push(id.to_string());
                    }
                }
                Patch::Remove { id, transition } => {
                    if let Some(record) = self.exits.get_mut(id.as_ref()) {
                        // Duplicate remove for an already-exiting id
                        // (defensive): fold into the pending teardown.
                        record.patches.push(patch.clone());
                    } else if *transition && self.begin_exit(tree, id, patch) {
                        // Withheld: teardown deferred until settle.
                    } else if self.defer_to_exiting_ancestor(tree, id, patch) {
                        // Descendant plain remove under an exiting root
                        // (flagged-root-first wire ordering): defers
                        // with it so the subtree stays intact.
                    } else {
                        self.forget(id);
                        tree.apply(patch);
                        forwarded.push(patch.clone());
                    }
                }
                Patch::Attach { id, .. } => {
                    // Router cache re-entry: nodes at-or-under this root are
                    // incoming shared-element candidates for this batch.
                    tree.apply(patch);
                    forwarded.push(patch.clone());
                    self.attached_roots_this_batch.push(id.to_string());
                }
                _ => {
                    // Move / Detach / SetText / SetSemantics: structural
                    // passthrough.
                    tree.apply(patch);
                    forwarded.push(patch.clone());
                }
            }
        }
        let mut flushed = self.flush_batch(tree);
        // End-of-batch snaps can finalize exits: their removal patches
        // reached the tree just now, after everything above — append
        // in that order so the caller's Taffy mirror replays exactly
        // what the tree saw.
        let finalized_any = !flushed.finalized.is_empty();
        forwarded.append(&mut flushed.finalized);
        IngestOutcome {
            forwarded,
            restyle: flushed.restyle,
            finalized_any,
        }
    }

    /// Parse and cache a freshly-created node's `__anim.*` props, mark
    /// it enter-eligible for this batch, start any `.animate` preset.
    fn register_create(&mut self, id: &str, props: &indexmap::IndexMap<String, Value>) {
        let mut specs = NodeSpecs::default();
        self.created_nodes_this_batch.insert(id.to_string());
        if let Some(v) = props.get("__anim.motion") {
            // Before start_ambient — an essential preset must start even
            // under reduced motion.
            self.note_motion_essential(id, parse_motion_essential(v));
        }
        if let Some(v) = props.get("__anim.transition") {
            specs.transition = parse_transition(v);
        }
        if let Some(v) = props.get("__anim.enter") {
            specs.enter = parse_enter_exit(v, "from");
        }
        if let Some(v) = props.get("__anim.exit") {
            specs.exit = parse_enter_exit(v, "to");
        }
        if let Some(v) = props.get("__anim.animate") {
            specs.animate = parse_animate(v);
        }
        if let Some(v) = props.get("__anim.layout") {
            specs.layout = parse_layout_spec(v);
        }
        // Shared-element identity/timing (Option H). A created node
        // carrying a key is an incoming FLIP candidate for this batch.
        let shared_key = props.get("__anim.sharedKey").and_then(parse_shared_key);
        let shared_spec = props.get("__anim.shared").and_then(parse_shared_spec);
        if shared_key.is_some() || shared_spec.is_some() {
            if shared_key.is_some() {
                self.shared_created_this_batch.insert(id.to_string());
            }
            self.shared.insert(
                id.to_string(),
                SharedEntry {
                    key: shared_key,
                    spec: shared_spec,
                },
            );
        }
        if specs.enter.is_some() {
            self.created_this_batch.insert(id.to_string());
        }
        let animate = specs.animate.clone();
        self.specs.insert(id.to_string(), specs);
        if let Some(spec) = animate {
            self.start_ambient(id, spec);
        }
    }

    /// Route a SetProp/RemoveProp for one `__anim.*` channel. `value` of
    /// `None` means the prop was removed. `__anim.sharedKey`/`shared`
    /// update the node's shared-element entry (Option H); `__anim.states`
    /// opens a completion-settle window (Option F). `__anim.scrub*` is NOT
    /// handled here — the window routes it to [`DesktopScrubber`] (a separate
    /// renderer-resident source) before this animator ingests the batch.
    fn set_anim_prop(&mut self, tree: &Tree, id: &str, name: &str, value: Option<&Value>) {
        match name {
            "__anim.states" => {
                // The engine lowers the active label as `{"label": "<label>"}`
                // (a `StateSwitch` object), NOT a bare string — read through
                // `parse_states_label` so the object shape real apps emit
                // actually opens the settle window (a bare string stays
                // tolerated for Remote-UI passthrough).
                let label = value.and_then(parse_states_label);
                self.note_states_label(tree, id, label.as_deref());
            }
            "__anim.transition" => {
                self.specs_mut(id).transition = value.and_then(parse_transition);
            }
            "__anim.layout" => {
                self.specs_mut(id).layout = value.and_then(parse_layout_spec);
            }
            "__anim.enter" => {
                self.specs_mut(id).enter = value.and_then(|v| parse_enter_exit(v, "from"));
            }
            "__anim.exit" => {
                self.specs_mut(id).exit = value.and_then(|v| parse_enter_exit(v, "to"));
            }
            "__anim.animate" => {
                // A changed spec restarts playback from the beginning;
                // a cleared one stops it and restores the touched props
                // (DOM/canvas parity). We can't write restores here
                // (no &mut Tree in this path) — restores flow through
                // stop writes at the ingest call sites below.
                let parsed = value.and_then(parse_animate);
                self.specs_mut(id).animate = parsed.clone();
                self.finished_ambients.remove(id); // a new spec may replay
                self.pending_ambient_restarts.push((id.to_string(), parsed));
            }
            "__anim.motion" => {
                let essential = value.map(parse_motion_essential).unwrap_or(false);
                self.note_motion_essential(id, essential);
            }
            // Shared-element identity re-resolves as an ordinary SetProp
            // when its driving state changes (the key is allowed to bind).
            "__anim.sharedKey" => {
                self.set_shared_field(id, SharedField::Key(value.and_then(parse_shared_key)));
            }
            "__anim.shared" => {
                self.set_shared_field(id, SharedField::Spec(value.and_then(parse_shared_spec)));
            }
            _ => {}
        }
    }

    /// `.states` pose label changed (`__anim.states`, Option F). A CHANGE
    /// means the engine switched poses and the node's `.transition` (the
    /// `.states`-synthesized one, or an explicit `.transition`) is now
    /// gliding the overridden props — open a settle window that fires
    /// `{ animation: "states", state: label }` when it elapses. Mirrors the
    /// DOM `noteStatesLabel`: fires nothing when the label did not change,
    /// the new pose is the default (`None`), reduced motion snaps, the node
    /// is exiting / detached, an enter/exit/FLIP/shared playback owns it (the
    /// pose props SNAP), or there is no transition spec. A superseding label
    /// change cancels the pending window — natural settles only.
    fn note_states_label(&mut self, tree: &Tree, id: &str, label: Option<&str>) {
        let previous = self.state_labels.get(id).cloned();
        match label {
            Some(l) => {
                self.state_labels.insert(id.to_string(), l.to_string());
            }
            None => {
                self.state_labels.remove(id);
            }
        }
        if previous.as_deref() == label {
            return; // re-resolve to the same pose: nothing switched
        }
        // Any change stands down the previous window (fires nothing).
        self.state_settles.remove(id);
        let Some(label) = label else {
            return; // switch to the default pose: no label to report
        };
        if !self.motion_allowed(id) {
            return; // reduced motion: the pose switch snaps
        }
        if self.is_exit_excluded(tree, id) || !is_attached(tree, id) {
            return; // exiting (engine-dead) or Router-detached: snaps
        }
        if self.exits.contains_key(id) || self.enter_groups.contains_key(id) {
            return; // an enter/exit/FLIP/shared playback owns the props → snap
        }
        if self.scrub_active.contains(id) {
            return; // scrub owns the node's props (Option G precedence) → snap
        }
        let Some(spec) = self.specs.get(id).and_then(|s| s.transition.clone()) else {
            return; // no transition spec: non-animated pose switch snaps
        };
        if spec.duration <= 0.0 {
            return;
        }
        let settle_at = self.now() + spec.duration + spec.delay;
        self.state_settles.insert(
            id.to_string(),
            StateSettle {
                label: label.to_string(),
                settle_at,
            },
        );
    }

    /// Update one half of a node's shared-element entry. When both halves
    /// are gone the entry is dropped entirely (mirrors the DOM
    /// `setSharedField`).
    fn set_shared_field(&mut self, id: &str, field: SharedField) {
        let entry = self.shared.entry(id.to_string()).or_default();
        match field {
            SharedField::Key(key) => entry.key = key,
            SharedField::Spec(spec) => entry.spec = spec,
        }
        if entry.key.is_none() && entry.spec.is_none() {
            self.shared.remove(id);
        }
    }

    /// Track a node's `.motion(essential)` flag. Removing the flag while
    /// reduced motion is active queues a snap of that node's in-flight
    /// work (applied at the end of the batch).
    fn note_motion_essential(&mut self, id: &str, essential: bool) {
        if essential {
            self.motion_essential.insert(id.to_string());
            return;
        }
        let was = self.motion_essential.remove(id);
        if was && self.reduced_motion {
            self.pending_essential_snaps.push(id.to_string());
        }
    }

    /// `.transition` channel: an engine SetProp landed on a whitelisted
    /// prop. `previous` is the value before the patch — for a mid-flight
    /// retarget that is the last interpolated value we wrote, so the new
    /// animation continues from it seamlessly.
    fn note_prop_set(
        &mut self,
        tree: &mut Tree,
        id: &str,
        write_key: &str,
        base: &str,
        previous: Option<Value>,
    ) {
        let current = tree.get(id).and_then(|n| n.props.get(write_key).cloned());
        // An engine write is the new ground truth for any playback that
        // owns this prop: refresh restore/originals so a later settle
        // lands the engine's value, never a stale snapshot. When the
        // engine's key differs from the playback's write key this also
        // migrates the playback (undoing its old-key write) so a
        // retired playback can never leave a plain-key value shadowing
        // the engine's `.0` key through the style fallback chain.
        self.reconcile_engine_write(
            tree,
            id,
            base,
            write_key,
            Stored {
                present: current.is_some(),
                value: current.clone().unwrap_or(Value::Null),
            },
        );
        // A node created THIS batch never starts a transition off a
        // same-batch SetProp: its enter (queued for flush) owns the
        // node's first motion, and nodes without an enter snap too.
        if self.created_nodes_this_batch.contains(id) {
            return;
        }
        // Transaction-scoped animation (Option D): a stamped batch's
        // spec overrides the node's own `.transition` and animates
        // nodes that have none (transaction > node `.transition` > snap).
        let spec = self
            .transaction
            .clone()
            .or_else(|| self.specs.get(id).and_then(|s| s.transition.clone()));
        let Some(spec) = spec else { return };
        if let Some(props) = &spec.props {
            if !props.iter().any(|p| p == base) {
                return;
            }
        }
        let key = (id.to_string(), base.to_string());
        if !self.motion_allowed(id)
            || spec.duration <= 0.0
            || self.exits.contains_key(id)
            // Scrub owns the node (Option G precedence): even a non-scrubbed
            // prop change snaps rather than gliding under a transaction spec.
            || self.scrub_active.contains(id)
        {
            self.cancel_anim(&key);
            return; // snap: the target is already in the tree
        }
        let Some(previous) = previous else {
            self.cancel_anim(&key);
            return; // no previous value → nothing to glide from
        };
        let Some(target) = current else {
            self.cancel_anim(&key);
            return;
        };
        let Some(interp) = make_interp(base, &previous, &target) else {
            self.cancel_anim(&key);
            return; // non-interpolable: sanctioned snap
        };
        if interp_is_noop(&interp) {
            self.cancel_anim(&key);
            return;
        }
        // Paint must keep showing the previous value until the first
        // tick — rewind the freshly-patched prop to it.
        tree.set_prop_raw(id, write_key, previous);
        self.set_anim(
            key,
            PropAnim {
                write_key: write_key.to_string(),
                start: self.now(),
                delay: spec.delay,
                duration: spec.duration,
                ease: spec.curve,
                interp,
                target_raw: target,
                restore: None,
                clamp_unit: base == "opacity",
                affects_layout: crate::layout::is_layout_prop(base),
                hold_written: false,
                enter_of: None,
            },
        );
    }

    /// A whitelisted prop was removed: any in-flight animation on it
    /// snaps, and an owning playback must restore "absent".
    fn note_prop_removed(&mut self, tree: &mut Tree, id: &str, engine_key: &str, base: &str) {
        self.reconcile_engine_write(
            tree,
            id,
            base,
            engine_key,
            Stored {
                present: false,
                value: Value::Null,
            },
        );
        self.cancel_anim(&(id.to_string(), base.to_string()));
    }

    /// Fold an engine write (SetProp / RemoveProp) on `engine_key` into
    /// the in-flight state for `(id, base)`.
    ///
    /// Same-key case: refresh the playback's restore / the ambient's
    /// originals so a later settle lands the engine's value.
    ///
    /// Key-mismatch case (engine `"opacity.0"` vs a playback/ambient
    /// writing plain `"opacity"` because the node carried no opacity
    /// key when the playback started): the style fallback chain prefers
    /// the plain key, so leaving the old write behind would shadow the
    /// engine's value forever — the node would strand at the last
    /// interpolated mid-fade value. Undo the write under the old key
    /// (restore its captured original) and migrate onto the engine's
    /// key: the engine's key wins. Playbacks without a captured
    /// original (exit fades) are left alone — their node is mid-teardown
    /// and every key dies with it at finalize.
    fn reconcile_engine_write(
        &mut self,
        tree: &mut Tree,
        id: &str,
        base: &str,
        engine_key: &str,
        stored: Stored,
    ) {
        if let Some(anim) = self.anims.get_mut(&(id.to_string(), base.to_string())) {
            if anim.restore.is_some() {
                if anim.write_key != engine_key {
                    let old_key = anim.write_key.clone();
                    if let Some(old_stored) = anim.restore.clone() {
                        apply_stored(tree, id, &old_key, &old_stored);
                    }
                    anim.write_key = engine_key.to_string();
                }
                if stored.present {
                    // Converge toward the engine's value (a mid-flight
                    // engine write retargets the playback's end pose).
                    anim.target_raw = stored.value.clone();
                    if let (Some(n), Interp::Number { to, .. }) =
                        (parse_numeric(&stored.value), &mut anim.interp)
                    {
                        *to = n;
                    }
                }
                anim.restore = Some(stored.clone());
            }
        }
        if let Some(ambient) = self.ambients.get_mut(id) {
            if ambient.props.contains(&base) {
                if let Some(old_key) = ambient.write_keys.get(base).cloned() {
                    if old_key != engine_key {
                        // Same migration rule as playbacks: undo the
                        // ambient's write under its old key so it can't
                        // shadow the engine's, then follow the engine.
                        if let Some(old_stored) = ambient.originals.remove(&old_key) {
                            apply_stored(tree, id, &old_key, &old_stored);
                        }
                    }
                }
                ambient
                    .write_keys
                    .insert(base.to_string(), engine_key.to_string());
                if base == "opacity" {
                    ambient.base_opacity = if stored.present {
                        parse_numeric(&stored.value).unwrap_or(1.0)
                    } else {
                        1.0
                    };
                }
                ambient.originals.insert(engine_key.to_string(), stored);
            }
        }
    }

    /// Begin a deferred remove for a flagged root. Returns `true` when
    /// teardown is deferred — the tick clock (or the overdue backbone)
    /// finalizes it. Returns `false` for snap: no exit spec, reduced
    /// motion, or no paintable preset (deferring a subtree that cannot
    /// visibly animate would freeze a corpse on screen — see the module
    /// docs' matrix).
    fn begin_exit(&mut self, tree: &mut Tree, id: &str, patch: &Patch) -> bool {
        let Some(spec) = self.specs.get(id).and_then(|s| s.exit.clone()) else {
            return false;
        };
        if !self.motion_allowed(id) {
            return false;
        }
        let targets = self.playback_targets(tree, id, &spec, "exit");
        if targets.is_empty() {
            // Defensive: no engine-emitted preset resolves to nothing
            // anymore (fade/slide/scale all paint), but a spec that
            // somehow yields no targets must snap rather than freeze a
            // motionless corpse on screen.
            return false;
        }
        // A pending enter for this id is superseded by the exit — and
        // so is a pending FLIP (exit wins, DOM parity).
        self.pending_enters.retain(|p| p != id);
        self.pending_flips.remove(id);
        // A preset animating the same props would mask the exit motion;
        // the node is dying, so the suspension is never lifted.
        let touched: Vec<String> = targets.iter().map(|t| t.base.clone()).collect();
        self.suspend_conflicting_ambient(id, &touched);
        let now = self.now();
        for target in targets {
            self.set_anim(
                (id.to_string(), target.base),
                PropAnim {
                    write_key: target.write_key,
                    start: now,
                    delay: spec.delay,
                    duration: spec.duration,
                    ease: spec.curve,
                    interp: Interp::Number {
                        from: target.from,
                        to: target.to,
                    },
                    target_raw: Value::from(target.to),
                    restore: None,
                    clamp_unit: target.clamp_unit,
                    affects_layout: false,
                    hold_written: false,
                    enter_of: None,
                },
            );
        }
        let total = spec.duration + spec.delay;
        self.exits.insert(
            id.to_string(),
            ExitRecord {
                patches: vec![patch.clone()],
                settle_at: now + total,
                overdue_at: now + total + EXIT_SETTLE_GRACE_MS,
            },
        );
        true
    }

    /// Defer a plain remove whose node sits under an exiting root: queue
    /// it on that root so the subtree stays intact until the exit
    /// settles. Returns `false` when no exiting ancestor exists.
    fn defer_to_exiting_ancestor(&mut self, tree: &Tree, id: &str, patch: &Patch) -> bool {
        if self.exits.is_empty() {
            return false;
        }
        let mut current = tree.parent_of(id).map(str::to_string);
        while let Some(cur) = current {
            if let Some(record) = self.exits.get_mut(&cur) {
                record.patches.push(patch.clone());
                return true;
            }
            current = tree.parent_of(&cur).map(str::to_string);
        }
        false
    }

    /// Resolve fade/slide/scale preset targets for one playback —
    /// mirrors `playbackTargets` in the canvas animator (`packages/web/
    /// src/canvas/anim.ts`), the reference tick-based semantics: fade →
    /// `opacity` (hidden 0), slide → `translateX`/`translateY` (hidden
    /// = base ± 24px, direction-aware incl. RTL via `dir` props), scale
    /// → `scale` (hidden = base × 0.95). `base` keys the anims map (and
    /// ambient conflict checks); `write_key` is the props key the ticks
    /// write. Base reads are the plain `prop_f32` chain —
    /// variant-decorated keys are a recorded narrowing (see
    /// `animatable_base_prop`'s docs).
    fn playback_targets(
        &self,
        tree: &Tree,
        id: &str,
        spec: &EnterExitSpec,
        phase: &str,
    ) -> Vec<PlaybackTarget> {
        let Some(node) = tree.get(id) else {
            return Vec::new();
        };
        let rtl = is_rtl(tree, id);
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for preset in &spec.presets {
            let (base, hidden, base_value): (&str, f64, f64) = match preset.as_str() {
                "fade" => {
                    let b = crate::style::prop_f32(node, "opacity")
                        .map(f64::from)
                        .unwrap_or(1.0);
                    ("opacity", 0.0, b)
                }
                "slide" => {
                    let (prop, offset) = slide_axis(spec.direction.as_deref(), rtl);
                    let b = crate::style::prop_f32(node, prop)
                        .map(f64::from)
                        .unwrap_or(0.0);
                    (prop, b + offset, b)
                }
                "scale" => {
                    let b = crate::style::prop_f32(node, "scale")
                        .map(f64::from)
                        .unwrap_or(1.0);
                    ("scale", b * SCALE_HIDDEN_FACTOR, b)
                }
                _ => continue,
            };
            if !seen.insert(base) {
                continue;
            }
            // Write to the key the node actually carries so engine
            // patches land on the playback's own key (see
            // `base_write_key`).
            let write_key = base_write_key(node, base);
            let (from, to) = if phase == "enter" {
                (hidden, base_value)
            } else {
                (base_value, hidden)
            };
            out.push(PlaybackTarget {
                base: base.to_string(),
                write_key,
                from,
                to,
                clamp_unit: base == "opacity",
            });
        }
        out
    }

    /// Post-batch hook: play queued enters, apply queued ambient
    /// restarts/essential snaps, reset per-batch state. The first-ever
    /// batch (initial render) suppresses enter playback. Returns the
    /// merged [`TickOutcome`] of the end-of-batch essential snaps —
    /// their restyles and finalized removals must reach the caller's
    /// Taffy mirror exactly like a tick's (dropping them left Taffy on
    /// mid-flight geometry until an unrelated restyle).
    fn flush_batch(&mut self, tree: &mut Tree) -> TickOutcome {
        let mut out = TickOutcome::default();
        // Queued `.animate` spec changes (stop + restore, maybe restart).
        let restarts = std::mem::take(&mut self.pending_ambient_restarts);
        for (id, spec) in restarts {
            if let Some(ambient) = self.ambients.remove(&id) {
                self.restore_ambient(tree, &id, ambient);
            }
            if let Some(spec) = spec {
                self.start_ambient(&id, spec);
            }
        }
        // Queued `.motion(essential)` removals under reduced motion snap
        // that node's in-flight work now (tree access available here).
        let snaps = std::mem::take(&mut self.pending_essential_snaps);
        for id in snaps {
            let snap = self.snap_subset(tree, |other| other == id);
            out.merge(snap);
        }

        let enters = std::mem::take(&mut self.pending_enters);
        let suppress = !self.first_batch_done;
        self.first_batch_done = true;
        self.created_this_batch.clear();
        self.created_nodes_this_batch.clear();
        // The transaction stamp is strictly batch-scoped: the batch's
        // SetProps have all been seen by now (in-flight interpolations
        // keep ticking; only the spec-selection window closes).
        self.transaction = None;
        if suppress {
            return out;
        }
        for id in enters {
            if !self.motion_allowed(&id) {
                continue; // reduced motion is a per-node decision (#149)
            }
            // A shared-element match owns this node's arrival: the element
            // visually persisted across the navigation, so its own enter
            // is suppressed (one motion, not two — DOM `collectSharedFlips`
            // parity). The FLIP itself is played later, once the fresh
            // layout provides the Last rect (see `play_shared_flips`); the
            // snapshot it will match was already taken by `prepare_shared`
            // before this batch, so the decision is knowable now.
            if self.shared_match_key(&id).is_some() {
                continue;
            }
            self.play_enter(tree, &id);
        }
        out
    }

    fn play_enter(&mut self, tree: &mut Tree, id: &str) {
        let Some(spec) = self.specs.get(id).and_then(|s| s.enter.clone()) else {
            return;
        };
        if self.exits.contains_key(id) {
            return;
        }
        let targets = self.playback_targets(tree, id, &spec, "enter");
        if targets.is_empty() {
            return; // defensive: no engine preset resolves to nothing
        }
        let touched: Vec<String> = targets.iter().map(|t| t.base.clone()).collect();
        self.suspend_conflicting_ambient(id, &touched);
        self.enter_groups.insert(id.to_string(), targets.len());
        // The group's natural settle fires `{ animation: "enter" }`.
        self.group_completion.insert(id.to_string(), "enter");
        let now = self.now();
        for target in targets {
            let original = tree
                .get(id)
                .and_then(|n| n.props.get(target.write_key.as_str()).cloned());
            // Hidden pose lands NOW so the batch's first paint shows it.
            tree.set_prop_raw(id, &target.write_key, Value::from(target.from));
            self.set_anim(
                (id.to_string(), target.base),
                PropAnim {
                    write_key: target.write_key,
                    start: now,
                    delay: spec.delay,
                    duration: spec.duration,
                    ease: spec.curve,
                    interp: Interp::Number {
                        from: target.from,
                        to: target.to,
                    },
                    target_raw: Value::from(target.to),
                    restore: Some(Stored {
                        present: original.is_some(),
                        value: original.unwrap_or(Value::Null),
                    }),
                    clamp_unit: target.clamp_unit,
                    affects_layout: false,
                    hold_written: false,
                    enter_of: Some(id.to_string()),
                },
            );
        }
    }

    /// FLIP pre-pass (DOM `prepareMoves` parity, `Move`-patch scope):
    /// called by the window BEFORE [`DesktopAnimator::ingest`] mutates
    /// the tree, with a resolver over the PRE-batch layout. Snapshots
    /// the First rect origin of every `Move`d node that carries a
    /// `.layout` spec. Exit-animating roots are skipped (exit wins);
    /// an existing snapshot for the same id is kept (the earliest
    /// First is the pre-batch truth).
    pub fn prepare_moves(
        &mut self,
        tree: &Tree,
        patches: &[Patch],
        first_rect: impl Fn(&str) -> Option<(f32, f32)>,
    ) {
        for patch in patches {
            match patch {
                Patch::Move { id, .. } => {
                    let layout_spec = self.specs.get(id.as_ref()).and_then(|s| s.layout.as_ref());
                    if layout_spec.is_none() {
                        continue;
                    }
                    if self.exits.contains_key(id.as_ref()) {
                        continue; // exit wins over FLIP
                    }
                    if self.scrub_active.contains(id.as_ref()) {
                        continue; // scrub wins over FLIP (Option G precedence)
                    }
                    if self.pending_flips.contains_key(id.as_ref()) {
                        continue;
                    }
                    if let Some(first) = first_rect(id) {
                        self.pending_flips.insert(id.to_string(), first);
                    }
                }
                // #146 sibling-shift: a removed node's same-parent
                // `.layout` siblings reflow but get no `Move` patch of
                // their own — snapshot their First here so they FLIP
                // instead of snapping. DOM `prepareMoves` remove branch
                // (anim.ts:800). For a flagged (exit) remove the node
                // stays in flow this batch, so these snapshots measure a
                // zero delta at play time and skip; the real sibling FLIP
                // for those runs at exit finalize (see
                // `queue_removal_sibling_flips`).
                Patch::Remove { id, .. } => {
                    self.snapshot_removal_siblings(tree, id, &first_rect);
                }
                _ => {}
            }
        }
    }

    /// Snapshot First rects of the `.layout` siblings sharing `removed`'s
    /// parent — the nodes a removal reflows but that receive no `Move`
    /// patch of their own (#146). Called from `prepare_moves` off the
    /// PRE-batch layout. Mirrors DOM `collectRemovalSiblingFlips`
    /// (anim.ts:821).
    fn snapshot_removal_siblings(
        &mut self,
        tree: &Tree,
        removed: &str,
        first_rect: &impl Fn(&str) -> Option<(f32, f32)>,
    ) {
        // A removed node with no on-screen First (culled, or inside a
        // Router-detached subtree) reflows nothing visible — skip, the
        // desktop analogue of the DOM's `isDisconnected(removed)` guard.
        if first_rect(removed).is_none() {
            return;
        }
        let Some(parent) = tree.parent_of(removed).map(str::to_string) else {
            return;
        };
        for sibling in tree.children_of(&parent) {
            if sibling == removed {
                continue;
            }
            if self
                .specs
                .get(sibling)
                .and_then(|s| s.layout.as_ref())
                .is_none()
            {
                continue;
            }
            if self.exits.contains_key(sibling) {
                continue; // exit wins over FLIP
            }
            if self.pending_flips.contains_key(sibling) {
                continue; // earliest First (a Move's, or an earlier remove's) wins
            }
            if let Some(first) = first_rect(sibling) {
                self.pending_flips.insert(sibling.clone(), first);
            }
        }
    }

    /// Record the `.layout` siblings of an exiting root as removal-sibling
    /// FLIP candidates (#146). A flagged/exit remove holds its node in
    /// flow for the whole exit, so the siblings reflow only at teardown —
    /// too late for `prepare_moves` to have caught a usable delta.
    /// Captured here (before teardown unlinks the root) so the window can
    /// measure their First off the still-current pre-teardown layout and
    /// FLIP them once the post-teardown layout lands. Mirrors DOM
    /// finalizeExit (anim.ts:1695).
    fn record_removal_flip_candidates(&mut self, tree: &Tree, removed: &str) {
        let Some(parent) = tree.parent_of(removed).map(str::to_string) else {
            return;
        };
        for sibling in tree.children_of(&parent) {
            if sibling == removed {
                continue;
            }
            if self
                .specs
                .get(sibling)
                .and_then(|s| s.layout.as_ref())
                .is_none()
            {
                continue;
            }
            if self.exits.contains_key(sibling) {
                continue; // exit wins over FLIP
            }
            if !self.removal_flip_candidates.iter().any(|c| c == sibling) {
                self.removal_flip_candidates.push(sibling.clone());
            }
        }
    }

    /// Resolve and queue the removal-sibling FLIP candidates recorded at
    /// exit finalize (#146). Called by the window right AFTER an exit
    /// finalizes and BEFORE it drops the cached layout, so `first_rect`
    /// reads the pre-teardown layout (each sibling still at its old
    /// position); `play_pending_flips` then supplies Last off the fresh
    /// post-teardown layout. No-op when nothing was recorded. Mirrors the
    /// DOM playing `collectRemovalSiblingFlips` at finalizeExit
    /// (anim.ts:1707).
    pub fn queue_removal_sibling_flips(&mut self, first_rect: impl Fn(&str) -> Option<(f32, f32)>) {
        if self.removal_flip_candidates.is_empty() {
            return;
        }
        for id in std::mem::take(&mut self.removal_flip_candidates) {
            if self.exits.contains_key(&id) {
                continue; // began exiting since it was recorded — exit wins
            }
            if self.pending_flips.contains_key(&id) {
                continue;
            }
            if self
                .specs
                .get(&id)
                .and_then(|s| s.layout.as_ref())
                .is_none()
            {
                continue;
            }
            if let Some(first) = first_rect(&id) {
                self.pending_flips.insert(id, first);
            }
        }
    }

    /// Whether any FLIP snapshots await their Last measurement.
    pub fn has_pending_flips(&self) -> bool {
        !self.pending_flips.is_empty()
    }

    /// Play the queued `.layout` FLIPs (DOM `playFlip` semantics):
    /// called by the window AFTER the post-batch layout has been
    /// computed, with a resolver over the FRESH layout (Last from Taffy
    /// geometry). For each snapshot: measure Last, invert
    /// (`First − Last`) via `translateX`/`translateY` prop writes — the
    /// invert pose lands immediately so this same frame paints (and
    /// hit-tests, via the transform post-pass refresh) the node at its
    /// First position — then play back to base on the spec's timing.
    /// Sub-half-pixel deltas skip; exit wins; reduced motion skips
    /// (per-node `.motion(essential)` exempts). `scale` converts the
    /// physical-px rect deltas into the logical-px prop channel.
    /// Returns whether any playback started (the caller must then
    /// refresh item transforms, invalidate paint caches, and re-arm
    /// the ticker).
    pub fn play_pending_flips(
        &mut self,
        tree: &mut Tree,
        scale: f32,
        last_rect: impl Fn(&str) -> Option<(f32, f32)>,
    ) -> bool {
        if self.pending_flips.is_empty() {
            return false;
        }
        let flips: Vec<(String, (f32, f32))> = self.pending_flips.drain().collect();
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let mut played = false;
        let now = self.now();
        for (id, first) in flips {
            let Some(spec) = self.specs.get(&id).and_then(|s| s.layout.clone()) else {
                continue;
            };
            if self.is_exit_excluded(tree, &id) {
                continue; // exit wins over FLIP
            }
            if !self.motion_allowed(&id) {
                continue;
            }
            let Some(last) = last_rect(&id) else {
                continue;
            };
            let dx = (first.0 - last.0) / scale;
            let dy = (first.1 - last.1) / scale;
            if dx.abs() < 0.5 && dy.abs() < 0.5 {
                continue; // zero-delta skip (DOM parity)
            }
            let Some(node) = tree.get(&id) else {
                continue;
            };
            // Resolve per-axis targets against the node's CURRENT base
            // transform props — the playback returns to base, restoring
            // the pre-flip prop exactly on settle (delete if absent).
            let mut targets: Vec<(String, String, f64, f64, Stored)> = Vec::new();
            for (base, delta) in [("translateX", dx as f64), ("translateY", dy as f64)] {
                if delta.abs() < 0.01 {
                    continue; // untouched axis keeps its prop untouched
                }
                let base_val = crate::style::prop_f32(node, base)
                    .map(f64::from)
                    .unwrap_or(0.0);
                let write_key = base_write_key(node, base);
                let original = node.props.get(write_key.as_str()).cloned();
                targets.push((
                    base.to_string(),
                    write_key,
                    base_val + delta,
                    base_val,
                    Stored {
                        present: original.is_some(),
                        value: original.unwrap_or(Value::Null),
                    },
                ));
            }
            if targets.is_empty() {
                continue;
            }
            // A transform-keyframing preset (spin/shake) would mask the
            // invert — suspend it; the playback-group countdown resumes
            // it when the last member settles (shared with enters).
            let touched: Vec<String> = targets.iter().map(|t| t.0.clone()).collect();
            self.suspend_conflicting_ambient(&id, &touched);
            *self.enter_groups.entry(id.clone()).or_insert(0) += targets.len();
            for (base, write_key, from, to, restore) in targets {
                // Invert pose lands NOW: this frame paints at First.
                tree.set_prop_raw(&id, &write_key, Value::from(from));
                self.set_anim(
                    (id.clone(), base),
                    PropAnim {
                        write_key,
                        start: now,
                        delay: spec.delay,
                        duration: spec.duration,
                        ease: spec.curve,
                        interp: Interp::Number { from, to },
                        target_raw: Value::from(to),
                        restore: Some(restore),
                        clamp_unit: false,
                        affects_layout: false,
                        hold_written: false,
                        enter_of: Some(id.clone()),
                    },
                );
                played = true;
            }
        }
        played
    }

    // -----------------------------------------------------------------
    // Shared-element transitions (Option H, over the Router Detach/Attach
    // seam). Mirrors the DOM reference (`dom/anim.ts` prepareShared /
    // collectSharedFlips / playSharedFlip); the five normative steps are
    // spread across `prepare_shared` (step 1, in `flush_patches` before
    // the tree mutates), `flush_batch`'s enter loop (step 3's enter
    // suppression), and `play_shared_flips` (steps 3/4, in `redraw` once
    // the fresh layout provides the Last rect). Interruption retargeting
    // (step 5) falls out for free: `prepare_shared` re-measures the live
    // `visual_rect`, which reflects any in-flight transform.
    // -----------------------------------------------------------------

    /// Whether the current batch has navigation shape and its shared
    /// snapshots still await resolution — the window's gate for calling
    /// [`DesktopAnimator::play_shared_flips`] after the fresh layout.
    pub fn has_pending_shared(&self) -> bool {
        self.navigation_batch
    }

    /// The shared key `id` would FLIP on this batch, if any: a tracked
    /// key with a non-self snapshot in a navigation batch. Drives both
    /// enter suppression (step 3) and match resolution.
    fn shared_match_key(&self, id: &str) -> Option<String> {
        if !self.navigation_batch {
            return None;
        }
        let key = self.shared.get(id)?.key.as_ref()?;
        let (_, source_id) = self.shared_snapshots.get(key)?;
        if source_id == id {
            return None; // self-snapshot: the node persisted, no FLIP
        }
        Some(key.clone())
    }

    /// Clear the per-batch shared state — snapshots, incoming candidate
    /// sets, and the navigation flag. Run at the start of every
    /// `prepare_shared` (so a flush that never redraws can't leak a stale
    /// snapshot forward) and the end of every `play_shared_flips`.
    fn clear_shared_batch(&mut self) {
        self.shared_snapshots.clear();
        self.shared_created_this_batch.clear();
        self.attached_roots_this_batch.clear();
        self.navigation_batch = false;
    }

    /// Emit a shared-element dev diagnostic once per kind-prefixed key
    /// (deduplicated for the animator's lifetime, DOM `warnSharedOnce`
    /// parity). A persistent authoring mistake warns on the first
    /// navigation that exposes it, not on every one.
    fn warn_shared_once(&mut self, kind: &str, keys: &[String]) {
        for key in keys {
            if self.warned_shared.insert(format!("{kind}:{key}")) {
                log::warn!(
                    "shared-element {kind}: key '{key}' present on only one side \
                     of a navigation (or duplicated); FLIP skipped for it"
                );
            }
        }
    }

    /// Shared-element pre-pass (protocol step 1): when the batch has
    /// navigation shape — a `Detach` (route leaving) AND an
    /// `Attach`/`Insert` (route arriving) — snapshot the on-screen
    /// `visual_rect` of every tracked keyed node that sits at-or-under
    /// one of the batch's detach roots, keyed by that key, BEFORE the
    /// batch mutates the tree. Sources are restricted to the leaving
    /// subtree(s): a persistent app-shell node sharing a key stays
    /// visible after the navigation, so it must neither source a FLIP out
    /// of a still-on-screen element nor shadow the real outgoing source
    /// via the first-wins guard. Called by the window in `flush_patches`
    /// with a resolver over the PRE-batch layout. Under reduced motion no
    /// snapshot is taken — no FLIP will play (globally decorative).
    pub fn prepare_shared(
        &mut self,
        tree: &Tree,
        patches: &[Patch],
        rect_of: impl Fn(&str) -> Option<(f32, f32, f32, f32)>,
    ) {
        self.clear_shared_batch();
        if self.reduced_motion {
            return;
        }
        let mut detach_roots: Vec<String> = Vec::new();
        let mut has_incoming = false;
        for patch in patches {
            match patch {
                Patch::Detach { id } => detach_roots.push(id.to_string()),
                Patch::Attach { .. } | Patch::Insert { .. } => has_incoming = true,
                _ => {}
            }
        }
        if detach_roots.is_empty() || !has_incoming {
            return; // not a navigation batch — nothing to snapshot
        }
        self.navigation_batch = true;

        let mut duplicates: Vec<String> = Vec::new();
        for (id, entry) in &self.shared {
            let Some(key) = entry.key.as_ref() else {
                continue;
            };
            // Detach-root scoping: outgoing sources only.
            if !is_at_or_under(tree, id, &detach_roots) {
                continue;
            }
            if self.scrub_active.contains(id) {
                continue; // scrub owns the node (Option G precedence)
            }
            let Some((x, y, w, h)) = rect_of(id) else {
                continue; // unmeasurable (culled / detached already) — skip
            };
            if w <= 0.0 || h <= 0.0 || !x.is_finite() || !y.is_finite() {
                continue;
            }
            if self.shared_snapshots.contains_key(key) {
                duplicates.push(key.clone());
                continue; // first wins
            }
            self.shared_snapshots
                .insert(key.clone(), (SharedRect { x, y, w, h }, id.clone()));
        }
        self.warn_shared_once("duplicate-source", &duplicates);
    }

    /// Decide and play this batch's shared-element FLIPs (protocol steps
    /// 3/4). Incoming candidates — created this batch with a key, or
    /// at-or-under a re-attached (Router cache) root — whose key matches a
    /// pre-pass snapshot become FLIP targets: measure the fresh Last rect,
    /// invert (translate+scale) from the source rect via `translateX` /
    /// `translateY` / `scale` prop writes — the invert pose lands
    /// immediately so this frame paints the node over the source — then
    /// play back to base on the node's `__anim.shared` timing. Unmatched,
    /// unmeasurable, no-timing, and self-snapshot cases degrade to plain
    /// navigation; one-sided keys warn once. Zero-delta matches play
    /// nothing (enter was already suppressed) but STILL settle immediately,
    /// firing `{ animation: "sharedElement" }` on the spot (Option F).
    /// Called by the window in `redraw`
    /// with a resolver over the FRESH layout; returns whether any playback
    /// started (the caller then refreshes item transforms, invalidates
    /// paint caches, and re-arms the ticker, exactly like a `.layout`
    /// FLIP).
    pub fn play_shared_flips(
        &mut self,
        tree: &mut Tree,
        scale: f32,
        rect_of: impl Fn(&str) -> Option<(f32, f32, f32, f32)>,
    ) -> bool {
        if !self.navigation_batch {
            self.clear_shared_batch();
            return false;
        }
        let scale = if scale > 0.0 { scale } else { 1.0 } as f64;

        struct SharedPlay {
            id: String,
            spec: SharedSpec,
            first: SharedRect,
            last: SharedRect,
        }
        let mut plays: Vec<SharedPlay> = Vec::new();
        let mut matched_keys: HashSet<String> = HashSet::new();
        let mut unreportable: HashSet<String> = HashSet::new();
        let mut target_only: Vec<String> = Vec::new();
        for (id, entry) in &self.shared {
            let Some(key) = entry.key.as_ref() else {
                continue;
            };
            let incoming = self.shared_created_this_batch.contains(id)
                || is_at_or_under(tree, id, &self.attached_roots_this_batch);
            if !incoming {
                continue;
            }
            if self.is_exit_excluded(tree, id) {
                continue; // exit wins (defensive; incoming nodes are fresh)
            }
            if self.scrub_active.contains(id) {
                continue; // scrub owns the node (Option G precedence)
            }
            let Some((first, source_id)) = self.shared_snapshots.get(key) else {
                target_only.push(key.clone());
                continue;
            };
            if source_id == id {
                unreportable.insert(key.clone()); // node persisted, not a typo
                continue;
            }
            if matched_keys.contains(key) {
                continue; // first match wins (duplicate target)
            }
            let Some(spec) = entry.spec.clone() else {
                unreportable.insert(key.clone()); // matched but no timing → snap
                continue;
            };
            let Some((lx, ly, lw, lh)) = rect_of(id) else {
                continue; // unmeasurable target → plain navigation
            };
            if lw <= 0.0 || lh <= 0.0 {
                continue;
            }
            matched_keys.insert(key.clone());
            plays.push(SharedPlay {
                id: id.clone(),
                spec,
                first: *first,
                last: SharedRect {
                    x: lx,
                    y: ly,
                    w: lw,
                    h: lh,
                },
            });
        }

        let now = self.now();
        let mut played = false;
        for play in plays {
            let f = play.first;
            let l = play.last;
            // Uniform-scale NARROWING vs the DOM: desktop's transform
            // vocabulary has ONE scale factor (`Affine2::scale`), not the
            // DOM's independent (sx, sy). Average the axis ratios — exact
            // when aspect is preserved (the dominant hero-image case),
            // approximate otherwise (recorded in the capability matrix).
            let s = ((f.w / l.w) as f64 + (f.h / l.h) as f64) / 2.0;
            // Scale is center-origin (`node_local_transform`), so the
            // repositioning translate uses CENTER deltas, in logical px.
            let dx = (((f.x + f.w * 0.5) - (l.x + l.w * 0.5)) as f64) / scale;
            let dy = (((f.y + f.h * 0.5) - (l.y + l.h * 0.5)) as f64) / scale;
            if dx.abs() < 0.5 && dy.abs() < 0.5 && (s - 1.0).abs() < 0.005 {
                // Zero delta: already in place, no playback — but the shared
                // element DID settle (immediately, this frame), so fire its
                // completion now (DOM parity: zero-delta `collectSharedFlips`
                // still dispatches `{ animation: "sharedElement" }`).
                self.queue_completion(tree, &play.id, "sharedElement", None);
                continue; // enter was already suppressed
            }
            // Resolve invert-pose targets against the node's CURRENT base
            // transform props (identity for a fresh incoming node — the
            // common navigation case; a non-identity base is the same v1
            // approximation the DOM notes for non-translate bases). Each
            // plays back to base, restoring the pre-flip prop exactly.
            let mut targets: Vec<(String, String, f64, f64, Stored)> = Vec::new();
            {
                let Some(node) = tree.get(&play.id) else {
                    continue;
                };
                let base_tx = crate::style::prop_f32(node, "translateX")
                    .map(f64::from)
                    .unwrap_or(0.0);
                let base_ty = crate::style::prop_f32(node, "translateY")
                    .map(f64::from)
                    .unwrap_or(0.0);
                let base_s = crate::style::prop_f32(node, "scale")
                    .map(f64::from)
                    .unwrap_or(1.0);
                for (base, from, to, thresh) in [
                    ("translateX", base_tx + dx, base_tx, 0.01),
                    ("translateY", base_ty + dy, base_ty, 0.01),
                    ("scale", base_s * s, base_s, 0.005),
                ] {
                    if (from - to).abs() < thresh {
                        continue; // untouched axis keeps its prop untouched
                    }
                    let write_key = base_write_key(node, base);
                    let original = node.props.get(write_key.as_str()).cloned();
                    targets.push((
                        base.to_string(),
                        write_key,
                        from,
                        to,
                        Stored {
                            present: original.is_some(),
                            value: original.unwrap_or(Value::Null),
                        },
                    ));
                }
            }
            if targets.is_empty() {
                continue;
            }
            // A transform-keyframing preset (spin/shake) would mask the
            // invert — suspend it; the group countdown resumes it when the
            // last member settles (shared with enters/FLIPs).
            let touched: Vec<String> = targets.iter().map(|t| t.0.clone()).collect();
            self.suspend_conflicting_ambient(&play.id, &touched);
            *self.enter_groups.entry(play.id.clone()).or_insert(0) += targets.len();
            // The group's natural settle fires `{ animation: "sharedElement" }`.
            self.group_completion
                .insert(play.id.clone(), "sharedElement");
            for (base, write_key, from, to, restore) in targets {
                tree.set_prop_raw(&play.id, &write_key, Value::from(from));
                self.set_anim(
                    (play.id.clone(), base),
                    PropAnim {
                        write_key,
                        start: now,
                        delay: 0.0,
                        duration: play.spec.duration,
                        ease: play.spec.curve,
                        interp: Interp::Number { from, to },
                        target_raw: Value::from(to),
                        restore: Some(restore),
                        clamp_unit: false,
                        affects_layout: false,
                        hold_written: false,
                        enter_of: Some(play.id.clone()),
                    },
                );
                played = true;
            }
        }

        // One-sided keys warn once (a key present as a source but with no
        // incoming target, or as a target with no source). Self-snapshots
        // and no-timing matches are present on both sides — excluded.
        let mut one_sided: Vec<String> = self
            .shared_snapshots
            .keys()
            .filter(|k| !matched_keys.contains(*k) && !unreportable.contains(*k))
            .cloned()
            .collect();
        for key in target_only {
            if !matched_keys.contains(&key) && !unreportable.contains(&key) {
                one_sided.push(key);
            }
        }
        self.warn_shared_once("unmatched", &one_sided);
        self.clear_shared_batch();
        played
    }

    fn start_ambient(&mut self, id: &str, spec: AnimateSpec) {
        if !self.motion_allowed(id) {
            return;
        }
        let props = ambient_preset_props(&spec.preset);
        if props.is_empty() {
            return; // spin/shake/shimmer: sanctioned no-op on desktop
        }
        // Originals snapshot: the props as they stand now. (The values
        // are read lazily on first tick via `reconcile_engine_write`
        // updates; a missing entry restores "absent".)
        self.ambients.insert(
            id.to_string(),
            Ambient {
                spec,
                start: self.now(),
                props,
                originals: HashMap::new(),
                write_keys: HashMap::new(),
                base_opacity: 1.0,
                suspended: false,
            },
        );
    }

    /// Capture an ambient's original prop values from the tree the first
    /// time it writes (start_ambient has no tree access from Create
    /// registration; capturing lazily also picks up same-batch SetProps).
    fn ensure_ambient_originals(ambient: &mut Ambient, tree: &Tree, id: &str) {
        if !ambient.originals.is_empty() {
            return;
        }
        let node = tree.get(id);
        for prop in ambient.props {
            // Write the key the node actually carries (plain vs `.0`)
            // so engine patches land on the ambient's own key — see
            // `base_write_key`.
            let write_key = node
                .map(|n| base_write_key(n, prop))
                .unwrap_or_else(|| (*prop).to_string());
            let value = node.and_then(|n| n.props.get(write_key.as_str()).cloned());
            if *prop == "opacity" {
                ambient.base_opacity = node
                    .and_then(|n| crate::style::prop_f32(n, "opacity"))
                    .map(f64::from)
                    .unwrap_or(1.0);
            }
            ambient
                .write_keys
                .insert((*prop).to_string(), write_key.clone());
            ambient.originals.insert(
                write_key,
                Stored {
                    present: value.is_some(),
                    value: value.unwrap_or(Value::Null),
                },
            );
        }
    }

    /// Reduced motion toggled OFF: start every cached `.animate` spec
    /// that is not already playing. Exhausted finite presets never
    /// replay (mirrors "a cached attach never replays a finite preset").
    fn restart_ambients(&mut self, tree: &Tree) {
        let candidates: Vec<(String, AnimateSpec)> = self
            .specs
            .iter()
            .filter(|(id, s)| {
                s.animate.is_some()
                    && !self.ambients.contains_key(*id)
                    && !self.finished_ambients.contains(*id)
                    && tree.get(id).is_some()
            })
            .map(|(id, s)| (id.clone(), s.animate.clone().unwrap()))
            .collect();
        for (id, spec) in candidates {
            self.start_ambient(&id, spec);
        }
    }

    fn restore_ambient(&mut self, tree: &mut Tree, id: &str, ambient: Ambient) {
        for (prop, stored) in ambient.originals {
            apply_stored(tree, id, &prop, &stored);
        }
    }

    fn suspend_conflicting_ambient(&mut self, id: &str, touched: &[String]) {
        if let Some(ambient) = self.ambients.get_mut(id) {
            if !ambient.suspended && ambient.props.iter().any(|p| touched.iter().any(|t| t == p)) {
                ambient.suspended = true;
            }
        }
    }

    fn resume_ambient(&mut self, id: &str) {
        if let Some(ambient) = self.ambients.get_mut(id) {
            ambient.suspended = false;
        }
    }

    /// Install an animation, retiring any it replaces (a superseded
    /// enter member still counts out of its group). A supersede that empties
    /// the group fires NO completion — the playback was interrupted, not
    /// settled — so the group's completion label is dropped silently.
    fn set_anim(&mut self, key: (String, String), anim: PropAnim) {
        if let Some(existing) = self.anims.insert(key, anim) {
            if self.enter_member_done(&existing) {
                if let Some(id) = &existing.enter_of {
                    self.group_completion.remove(id.as_str());
                }
            }
        }
    }

    fn cancel_anim(&mut self, key: &(String, String)) {
        if let Some(existing) = self.anims.remove(key) {
            if self.enter_member_done(&existing) {
                if let Some(id) = &existing.enter_of {
                    self.group_completion.remove(id.as_str());
                }
            }
        }
    }

    /// Count one member animation out of its enter/FLIP/shared playback
    /// group; when the last member leaves, the suspended ambient resumes.
    /// Returns `true` when this call emptied the group — the caller decides
    /// whether that is a NATURAL settle (tick) that fires a completion or a
    /// supersede (`set_anim`/`cancel_anim`) that fires nothing.
    fn enter_member_done(&mut self, anim: &PropAnim) -> bool {
        let Some(id) = &anim.enter_of else {
            return false;
        };
        let done = {
            let Some(remaining) = self.enter_groups.get_mut(id) else {
                return false;
            };
            *remaining = remaining.saturating_sub(1);
            *remaining == 0
        };
        if done {
            let id = id.clone();
            self.enter_groups.remove(&id);
            self.resume_ambient(&id);
        }
        done
    }

    // -----------------------------------------------------------------
    // Ticking
    // -----------------------------------------------------------------

    /// Advance every in-flight animation to the current clock and write
    /// the interpolated values into the real tree props. The window
    /// calls this at the top of each redraw — BEFORE layout — so
    /// animated geometry reaches Taffy and hit-testing this frame.
    pub fn tick(&mut self, tree: &mut Tree) -> TickOutcome {
        let mut out = TickOutcome::default();
        if self.anims.is_empty()
            && self.ambients.is_empty()
            && self.exits.is_empty()
            && self.state_settles.is_empty()
        {
            return out;
        }
        let now = self.now();
        let mut restyle: HashSet<String> = HashSet::new();

        // Prop animations (transitions + enter/exit playbacks).
        if !self.anims.is_empty() {
            let keys: Vec<(String, String)> = self.anims.keys().cloned().collect();
            let mut finished: Vec<(String, String)> = Vec::new();
            for key in keys {
                let Some(anim) = self.anims.get_mut(&key) else {
                    continue;
                };
                let t = if anim.duration > 0.0 {
                    (now - anim.start - anim.delay) / anim.duration
                } else {
                    1.0
                };
                if t < 0.0 {
                    // Delay phase: hold the from-value, written ONCE.
                    if !anim.hold_written {
                        anim.hold_written = true;
                        let v = value_for(anim, 0.0);
                        tree.set_prop_raw(&key.0, &anim.write_key.clone(), v);
                        out.wrote = true;
                        if anim.affects_layout {
                            restyle.insert(key.0.clone());
                        }
                    }
                    continue;
                }
                if anim.affects_layout {
                    restyle.insert(key.0.clone());
                }
                out.wrote = true;
                if t >= 1.0 {
                    let (write_key, restore, target) = (
                        anim.write_key.clone(),
                        anim.restore.clone(),
                        anim.target_raw.clone(),
                    );
                    match restore {
                        Some(stored) => apply_stored(tree, &key.0, &write_key, &stored),
                        None => tree.set_prop_raw(&key.0, &write_key, target),
                    }
                    finished.push(key);
                } else {
                    let eased = anim.ease.eval(t);
                    let v = value_for(anim, eased);
                    let write_key = anim.write_key.clone();
                    tree.set_prop_raw(&key.0, &write_key, v);
                }
            }
            for key in finished {
                if let Some(anim) = self.anims.remove(&key) {
                    if self.enter_member_done(&anim) {
                        // The node's playback group just settled NATURALLY.
                        // Fire its completion ("enter" or "sharedElement"); a
                        // `.layout` FLIP group has no label and fires nothing.
                        if let Some(id) = anim.enter_of.clone() {
                            if let Some(kind) = self.group_completion.remove(id.as_str()) {
                                // An enter superseded by an exit leaves the
                                // node in `exits`; a leftover member reaching
                                // settle here must still fire nothing.
                                if !(kind == "enter" && self.exits.contains_key(&id)) {
                                    self.queue_completion(tree, &id, kind, None);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Ambient presets run after playbacks so a looping preset owns
        // its props for the frame. All desktop ambient props (opacity)
        // are paint-only — no restyle.
        let ambient_ids: Vec<String> = self.ambients.keys().cloned().collect();
        for id in ambient_ids {
            let Some(ambient) = self.ambients.get_mut(&id) else {
                continue;
            };
            if ambient.suspended {
                continue;
            }
            // A Router-detached subtree is not painted: hold the
            // ambient until an `Attach` brings it back.
            if !is_attached(tree, &id) {
                continue;
            }
            Self::ensure_ambient_originals(ambient, tree, &id);
            let elapsed = now - ambient.start - ambient.spec.delay;
            if elapsed < 0.0 {
                continue;
            }
            let duration = ambient.spec.duration;
            let iterations: f64 = match ambient.spec.repeat {
                Repeat::Loop => f64::INFINITY,
                Repeat::Count(n) => n as f64,
            };
            let iteration = if duration > 0.0 {
                (elapsed / duration).floor()
            } else {
                f64::INFINITY
            };
            if iteration >= iterations {
                // A finite preset exhausting its iterations settles
                // NATURALLY: restore the originals, fire
                // `{ animation: "<presetName>" }`, and never replay. Looping
                // presets have `iterations == INFINITY` and never reach here
                // — they never fire (DOM parity).
                self.finished_ambients.insert(id.clone());
                if let Some(ambient) = self.ambients.remove(&id) {
                    let preset = ambient.spec.preset.clone();
                    self.restore_ambient(tree, &id, ambient);
                    self.queue_completion(tree, &id, &preset, None);
                }
                out.wrote = true;
                continue;
            }
            let p = if duration > 0.0 {
                (elapsed % duration) / duration
            } else {
                0.0
            };
            let eased = ambient.spec.curve.eval(p);
            // Preset frame shapes mirror the canvas animator's
            // `applyAmbientFrame` (which mirrors the DOM keyframes).
            // `shimmer` never starts (`ambient_preset_props` is empty
            // for it), so this match covers every running preset.
            let write = |ambient: &Ambient, base: &'static str, v: f64| -> (String, Value) {
                let write_key = ambient
                    .write_keys
                    .get(base)
                    .cloned()
                    .unwrap_or_else(|| base.to_string());
                (write_key, Value::from(v))
            };
            let frame = match ambient.spec.preset.as_str() {
                "pulse" => {
                    let factor = piecewise(PULSE_STOPS, eased);
                    let v = (ambient.base_opacity * factor).clamp(0.0, 1.0);
                    Some(write(ambient, "opacity", v))
                }
                "spin" => Some(write(ambient, "rotate", 360.0 * eased)),
                "shake" => Some(write(ambient, "translateX", piecewise(SHAKE_STOPS, eased))),
                _ => None,
            };
            if let Some((write_key, v)) = frame {
                tree.set_prop_raw(&id, &write_key, v);
                out.wrote = true;
            }
        }

        // Deferred exits: tick-clock settle (NATURAL — fires the exit
        // completion just before teardown, inside `finalize_exit`).
        let due: Vec<String> = self
            .exits
            .iter()
            .filter(|(_, r)| now >= r.settle_at)
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            out.finalized.extend(self.finalize_exit(id, tree, true));
            out.wrote = true;
        }

        // `.states` transition settles: fire `{ animation: "states", state }`
        // when a pose-switch window elapses. Natural settles only — a
        // superseding label change (or teardown) already removed the entry.
        if !self.state_settles.is_empty() {
            let due: Vec<(String, String)> = self
                .state_settles
                .iter()
                .filter(|(_, s)| now >= s.settle_at)
                .map(|(id, s)| (id.clone(), s.label.clone()))
                .collect();
            for (id, label) in due {
                self.state_settles.remove(&id);
                // Re-check at fire time (DOM parity): an ancestor's exit or a
                // Router detach can begin mid-window without cancelling this
                // node's own timer, and both must fire nothing.
                if self.is_exit_excluded(tree, &id) || !is_attached(tree, &id) {
                    continue;
                }
                self.queue_completion(tree, &id, "states", Some(&label));
            }
        }

        out.restyle = restyle.into_iter().collect();
        out
    }

    /// Overdue backbone: finalize exits past `settle + grace` even when
    /// the redraw ticker stalled (occluded window). Called from the
    /// patch-flush path; returns removal patches already applied to the
    /// tree for the caller to mirror into Taffy.
    pub fn finalize_overdue(&mut self, tree: &mut Tree) -> Vec<Patch> {
        if self.exits.is_empty() {
            return Vec::new();
        }
        let now = self.now();
        let due: Vec<String> = self
            .exits
            .iter()
            .filter(|(_, r)| now >= r.overdue_at)
            .map(|(id, _)| id.clone())
            .collect();
        let mut finalized = Vec::new();
        for id in due {
            // The grace window elapsed — the exit WOULD have settled on the
            // tick clock had the ticker not stalled, so this is a natural
            // settle and fires the exit completion.
            finalized.extend(self.finalize_exit(id, tree, true));
        }
        finalized
    }

    /// Tear down a deferred exit: apply the withheld removal patches to
    /// the tree (root first — its subtree cascade makes the descendant
    /// removes tree-level no-ops, but Taffy needs every one), drop all
    /// animator state for the removed ids, and hand the patches back for
    /// the Taffy mirror.
    fn finalize_exit(&mut self, id: String, tree: &mut Tree, natural: bool) -> Vec<Patch> {
        let Some(record) = self.exits.remove(&id) else {
            return Vec::new();
        };
        // Exit completion fires JUST BEFORE teardown (the node is still in
        // the tree here), on NATURAL settle only — the tick clock and the
        // overdue backbone. The defensive Create-supersede finalize passes
        // `natural = false`: a new node replacing the exiting one is an
        // interruption, not a settle, and fires nothing.
        if natural {
            self.queue_completion(tree, &id, "exit", None);
        }
        // #146 sibling-shift: capture the exiting root's `.layout`
        // siblings BEFORE teardown unlinks it — they hold their
        // pre-reflow position until now. The window resolves these to
        // First rects off the still-current layout and plays the FLIP
        // once the post-teardown layout lands (see
        // `queue_removal_sibling_flips`).
        self.record_removal_flip_candidates(tree, &id);
        // Drop this root's own exit prop animations before teardown.
        self.anims.retain(|(anim_id, _), _| *anim_id != id);
        for patch in &record.patches {
            if let Patch::Remove { id: rid, .. } = patch {
                self.forget(rid);
            }
            tree.apply(patch);
        }
        record.patches
    }

    /// Drop all animator state for a torn-down id. Also the eviction
    /// hook for the window's detached-subtree backstop
    /// (`evict_detached_backstop`): ids torn out of the tree must not
    /// leave specs/ambients accumulating for the process lifetime.
    pub(crate) fn forget(&mut self, id: &str) {
        self.specs.remove(id);
        self.motion_essential.remove(id);
        self.created_this_batch.remove(id);
        self.created_nodes_this_batch.remove(id);
        self.pending_enters.retain(|p| p != id);
        self.pending_flips.remove(id);
        self.removal_flip_candidates.retain(|c| c != id);
        self.ambients.remove(id); // no restore — the node is going away
        self.finished_ambients.remove(id);
        self.enter_groups.remove(id);
        self.anims.retain(|(anim_id, _), _| anim_id != id);
        self.exits.remove(id);
        self.pending_ambient_restarts.retain(|(p, _)| p != id);
        self.pending_essential_snaps.retain(|p| p != id);
        self.shared.remove(id);
        self.shared_created_this_batch.remove(id);
        self.group_completion.remove(id);
        self.state_labels.remove(id);
        self.state_settles.remove(id);
    }

    /// Test hook: total per-id records held across every internal map,
    /// so leak regression tests can assert that `forget` (and the
    /// window's eviction backstop calling it) fully drops a node.
    #[cfg(test)]
    pub(crate) fn tracked_record_count(&self) -> usize {
        self.specs.len()
            + self.motion_essential.len()
            + self.anims.len()
            + self.ambients.len()
            + self.finished_ambients.len()
            + self.enter_groups.len()
            + self.exits.len()
            + self.pending_enters.len()
            + self.pending_flips.len()
            + self.removal_flip_candidates.len()
            + self.created_this_batch.len()
            + self.created_nodes_this_batch.len()
            + self.pending_ambient_restarts.len()
            + self.pending_essential_snaps.len()
            + self.shared.len()
            + self.shared_created_this_batch.len()
            + self.shared_snapshots.len()
            + self.attached_roots_this_batch.len()
            + self.group_completion.len()
            + self.state_labels.len()
            + self.state_settles.len()
    }

    /// Test hook: count of distinct shared-element warnings emitted so
    /// far (deduplicated for the animator's lifetime) — lets the
    /// one-sided-key tests assert "warned once".
    #[cfg(test)]
    pub(crate) fn shared_warned_count(&self) -> usize {
        self.warned_shared.len()
    }

    /// Settle the in-flight work of every id `should_snap` selects at
    /// its FINAL value right now — the sanctioned snap. Transitions land
    /// their targets, enter playbacks restore, ambients stop and
    /// restore, exits finalize, pending enters are dropped.
    fn snap_subset(&mut self, tree: &mut Tree, should_snap: impl Fn(&str) -> bool) -> TickOutcome {
        let mut out = TickOutcome::default();
        let keys: Vec<(String, String)> = self
            .anims
            .keys()
            .filter(|(id, _)| should_snap(id))
            .cloned()
            .collect();
        for key in keys {
            if let Some(anim) = self.anims.remove(&key) {
                match &anim.restore {
                    Some(stored) => apply_stored(tree, &key.0, &anim.write_key, stored),
                    None => tree.set_prop_raw(&key.0, &anim.write_key, anim.target_raw.clone()),
                }
                out.wrote = true;
                if anim.affects_layout {
                    out.restyle.push(key.0.clone());
                }
                self.enter_member_done(&anim);
            }
        }
        let ambient_ids: Vec<String> = self
            .ambients
            .keys()
            .filter(|id| should_snap(id))
            .cloned()
            .collect();
        for id in ambient_ids {
            if let Some(ambient) = self.ambients.remove(&id) {
                self.restore_ambient(tree, &id, ambient);
                out.wrote = true;
            }
        }
        let exit_ids: Vec<String> = self
            .exits
            .keys()
            .filter(|id| should_snap(id))
            .cloned()
            .collect();
        for id in exit_ids {
            // Reduced-motion / essential-toggle SNAP: an interruption, not a
            // natural settle — fires no exit completion.
            out.finalized.extend(self.finalize_exit(id, tree, false));
            out.wrote = true;
        }
        self.pending_enters.retain(|id| !should_snap(id));
        self.pending_flips.retain(|id, _| !should_snap(id));
        out
    }
}

fn value_for(anim: &PropAnim, eased: f64) -> Value {
    interp_at(&anim.interp, eased, anim.clamp_unit)
}

/// Interpolate one [`Interp`] lane at eased progress `eased`, formatting
/// the result as the [`Value`] layout/paint read. Shared by the
/// transition ticker ([`value_for`]) and the scrub source
/// ([`DesktopScrubber`]) so drag, settle, and transition are numerically
/// identical. Overshoot curves (spring) may pass `eased` outside `[0,1]`;
/// unit props (opacity) clamp the interpolation RESULT, never the input.
fn interp_at(interp: &Interp, eased: f64, clamp_unit: bool) -> Value {
    match interp {
        Interp::Number { from, to } => {
            let v = from + (to - from) * eased;
            let v = if clamp_unit { v.clamp(0.0, 1.0) } else { v };
            Value::from(v)
        }
        Interp::Color { from, to } => {
            let mix = |i: usize| from[i] + (to[i] - from[i]) * eased;
            Value::String(format_color([mix(0), mix(1), mix(2), mix(3)]))
        }
    }
}

/// Restore a captured original prop exactly (delete when it was absent).
fn apply_stored(tree: &mut Tree, id: &str, key: &str, stored: &Stored) {
    if stored.present {
        tree.set_prop_raw(id, key, stored.value.clone());
    } else {
        tree.remove_prop_raw(id, key);
    }
}

/// Is `id` at-or-under any of `roots` (walking the parent index)? Used
/// for shared-element detach-root scoping (source side) and re-attached
/// root membership (incoming side).
fn is_at_or_under(tree: &Tree, id: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    let mut current = Some(id);
    while let Some(cur) = current {
        if roots.iter().any(|r| r == cur) {
            return true;
        }
        current = tree.parent_of(cur);
    }
    false
}

/// Is `id` reachable from the live root (i.e. not inside a
/// Router-detached subtree)? Walks the parent index up to the synthetic
/// root.
fn is_attached(tree: &Tree, id: &str) -> bool {
    let mut current = id;
    loop {
        match tree.parent_of(current) {
            Some(parent) if parent == crate::tree::ROOT_ID => return true,
            Some(parent) => current = parent,
            None => return false,
        }
    }
}

// ===========================================================================
// Scrub bindings (Option G) — renderer-resident gesture/scroll source
// ===========================================================================
//
// The engine lowers a valid `.scrub`/`.settle` pair into four static props
// (`__anim.scrub`, `__anim.scrubSettle`, `__anim.scrubBind`,
// `__anim.scrubPoses`; see `hypen_engine::ir::anim`). [`DesktopScrubber`] is
// the desktop consumer — the renderer-resident per-frame source that NEVER
// touches the engine while a gesture/scroll is live: raw high-frequency input
// stays local, and only the settle write (meaning) crosses the boundary as a
// `__hypen_bind` dispatch. It is the twin of the DOM's `DomScrubber`
// (`hypen-web/packages/web/src/dom/scrub.ts`), ported to the desktop model:
//
//   * Poses are interpolated straight into the REAL [`Tree`] props (the same
//     `translateY.0`/`opacity.0`/`backgroundColor.0` keys layout, paint, and
//     hit-testing read via [`interp_at`]) — never a paint-only layer. A
//     scrubbed transform key rides the same stage-1 transform post-pass a
//     `.transition` uses, so a static `rotate(45)` on a `translateY` scrub
//     survives the drag for free (separate prop, untouched).
//   * There are no OS/JS timers: the settle, the no-flash cleanup window, the
//     scroll rest-debounce, and the scroll-quiescence release are all
//     DEADLINES checked against the injectable clock in [`DesktopScrubber::tick`]
//     — the same demand-driven redraw ticker the animator rides
//     ([`DesktopScrubber::has_active`] keeps it armed).
//   * The bind write is not dispatched inline; it is queued and drained by the
//     window ([`DesktopScrubber::take_binds`]) into the exact `.bind` channel
//     (`module.dispatch_action("__hypen_bind", {path, value})`), mirroring the
//     completion-drain seam.
//
// NARROWINGS vs the DOM v1 (all sanctioned, recorded in the capability
// matrix): winit has no per-element pointer capture, so a claimed drag is
// tracked to a single OS cursor and every move routes to it until button
// release (the window's equivalent of `setPointerCapture`); multi-touch is
// moot (one cursor — the "ignore other pointerIds" rule is satisfied by
// construction); and only numeric + color pose endpoints interpolate
// (non-interpolable pose pairs snap, the same cut as `.transition`).

/// Axis travel (px) below which a gesture is a tap, not a drag claim.
const SCRUB_SLOP_PX: f64 = 6.0;
/// Milliseconds of velocity projection applied to the release progress.
const SCRUB_PROJECTION_MS: f64 = 150.0;
/// Pointer samples kept for the velocity estimate.
const SCRUB_VELOCITY_SAMPLES: usize = 5;
/// Samples older than this at release are stale — never projected.
const SCRUB_VELOCITY_WINDOW_MS: f64 = 100.0;
/// Default no-flash cleanup fallback window after the settle write.
const SCRUB_DEFAULT_CLEANUP_MS: f64 = 500.0;
/// Default scroll-source endpoint rest debounce / quiescence window.
const SCRUB_DEFAULT_REST_DEBOUNCE_MS: f64 = 150.0;

/// A queued settle write: the winning pose LABEL bound to a dotted state
/// path, drained by the window into the `__hypen_bind` channel.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrubBind {
    pub path: String,
    pub value: String,
}

/// Result of a pointer release: `Claimed` means the gesture owned the
/// pointer (the window must suppress the click — a drag is not a tap);
/// `NoOp` means a below-slop tap passed through untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrubPointerUp {
    Claimed,
    NoOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScrubSource {
    Gesture,
    Scroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScrubAxis {
    X,
    Y,
}

/// Parsed `__anim.scrub` source spec (desktop re-parse of the wire JSON;
/// the engine's `ScrubSpec` is `pub(crate)` to the engine crate, so the
/// desktop side re-parses the object like every other `__anim.*` channel).
#[derive(Debug, Clone)]
struct ScrubSourceSpec {
    from: String,
    to: String,
    source: ScrubSource,
    axis: ScrubAxis,
    /// Directed input range `[inputAtProgress0, inputAtProgress1]`.
    over: (f64, f64),
    rubber_band: f64,
    of: Option<String>,
}

/// Parsed `__anim.scrubSettle` timing.
#[derive(Debug, Clone)]
struct ScrubSettle {
    ease: Easing,
    duration: f64,
}

/// One interpolation lane derived from a `__anim.scrubPoses` entry.
#[derive(Debug, Clone)]
struct ScrubPlan {
    /// Exact props key written each frame (`"translateY.0"`) — the key the
    /// engine subsequently patches, so a deferred write lands on the same
    /// key.
    write_key: String,
    interp: Interp,
    clamp_unit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScrubPhase {
    Idle,
    Dragging,
    Settling,
    AwaitingCleanup,
}

#[derive(Debug, Clone)]
struct ScrubDrag {
    /// Axis coordinate at pointerdown (relative-mapping origin).
    start_pos: f64,
    /// Clock reading at pointerdown — the velocity window's seed sample uses
    /// it (a drag, hold, release must project off the RECENT motion, not the
    /// claim instant).
    down_t: f64,
    /// Progress anchor the relative mapping drags FROM (live at claim).
    p_at_grab: f64,
    /// Slop exceeded — the gesture owns the pointer.
    claimed: bool,
    /// `(clock_ms, progress)` samples for the release velocity estimate.
    samples: Vec<(f64, f64)>,
}

#[derive(Debug, Clone)]
struct ScrubEntry {
    spec: Option<ScrubSourceSpec>,
    settle: Option<ScrubSettle>,
    bind: Option<String>,
    plans: Vec<ScrubPlan>,
    scrubbed_keys: HashSet<String>,

    phase: ScrubPhase,
    /// Scrub values are written into the tree and not yet cleaned up.
    engaged: bool,
    /// Scroll-source quiescence: engaged but the scroll has rested
    /// mid-range, so ownership + deferral released until the next event.
    quiescent: bool,
    progress: f64,
    drag: Option<ScrubDrag>,

    /// Captured pre-scrub prop values, restored (or deleted) at cleanup.
    originals: HashMap<String, Stored>,
    /// Latest deferred engine writes per scrubbed key, applied at cleanup.
    deferred: HashMap<String, Value>,

    // Settle (gesture release / scroll rest reuse the awaitingCleanup path).
    settle_from: f64,
    settle_target: f64,
    settle_start: f64,
    settle_label: Option<String>,
    // AwaitingCleanup.
    pending_label: Option<String>,
    cleanup_deadline: Option<f64>,
    // Scroll source.
    rest_endpoint: Option<u8>,
    rest_deadline: Option<f64>,
    last_scroll_write: Option<String>,
    quiescence_deadline: Option<f64>,
    of_warned: bool,
}

impl ScrubEntry {
    fn new() -> Self {
        Self {
            spec: None,
            settle: None,
            bind: None,
            plans: Vec::new(),
            scrubbed_keys: HashSet::new(),
            phase: ScrubPhase::Idle,
            engaged: false,
            quiescent: false,
            progress: 0.0,
            drag: None,
            originals: HashMap::new(),
            deferred: HashMap::new(),
            settle_from: 0.0,
            settle_target: 0.0,
            settle_start: 0.0,
            settle_label: None,
            pending_label: None,
            cleanup_deadline: None,
            rest_endpoint: None,
            rest_deadline: None,
            last_scroll_write: None,
            quiescence_deadline: None,
            of_warned: false,
        }
    }

    /// All four channels present and valid — the scrub is armable.
    fn complete(&self) -> bool {
        self.spec.is_some()
            && self.settle.is_some()
            && self.bind.is_some()
            && !self.plans.is_empty()
    }

    /// Does an active drag/settle/held window (or an engaged scroll source
    /// under live input) own the node? A quiescent scroll entry does not.
    fn owning(&self) -> bool {
        if self.phase != ScrubPhase::Idle {
            return true;
        }
        self.engaged && !self.quiescent
    }

    /// Has this entry a live deadline that must keep the ticker armed?
    fn has_active(&self) -> bool {
        self.phase == ScrubPhase::Settling
            || self.cleanup_deadline.is_some()
            || self.rest_deadline.is_some()
            || self.quiescence_deadline.is_some()
    }
}

/// Rubber-band a progress RESULT beyond `[0, 1]` (`p' = bound + (p - bound)
/// * rubberBand`), matching the DOM/core `scrubProgress`.
fn scrub_rubber_band(raw: f64, rubber_band: f64) -> f64 {
    if raw < 0.0 {
        raw * rubber_band
    } else if raw > 1.0 {
        1.0 + (raw - 1.0) * rubber_band
    } else {
        raw
    }
}

fn parse_scrub_source(value: &Value) -> Option<ScrubSourceSpec> {
    let obj = value.as_object()?;
    let from = obj
        .get("from")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let to = obj
        .get("to")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let source = match obj.get("source")?.as_str()? {
        "gesture" => ScrubSource::Gesture,
        "scroll" => ScrubSource::Scroll,
        _ => return None,
    };
    let axis = match obj.get("axis")?.as_str()? {
        "x" => ScrubAxis::X,
        "y" => ScrubAxis::Y,
        _ => return None,
    };
    let over_arr = obj.get("over")?.as_array()?;
    if over_arr.len() != 2 {
        return None;
    }
    let a = over_arr[0].as_f64().filter(|f| f.is_finite())?;
    let b = over_arr[1].as_f64().filter(|f| f.is_finite())?;
    if a == b {
        return None;
    }
    let rubber_band = obj
        .get("rubberBand")
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .map(|f| f.clamp(0.0, 1.0))
        .unwrap_or(0.4);
    let of = if source == ScrubSource::Scroll {
        obj.get("of")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    Some(ScrubSourceSpec {
        from,
        to,
        source,
        axis,
        over: (a, b),
        rubber_band,
        of,
    })
}

fn parse_scrub_settle(value: &Value) -> Option<ScrubSettle> {
    let obj = value.as_object()?;
    let duration = obj
        .get("duration")?
        .as_f64()
        .filter(|f| f.is_finite() && *f >= 0.0)?;
    let curve = obj.get("curve")?.as_str()?;
    Some(ScrubSettle {
        ease: curve_easing(curve),
        duration,
    })
}

fn parse_scrub_bind(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// Build interpolation lanes from a `__anim.scrubPoses` object. Keys resolve
/// through the animatable whitelist (variant-scoped / off-whitelist keys are
/// skipped); numeric + color endpoints interpolate, anything else snaps
/// (skipped — the sanctioned degradation).
fn build_scrub_plans(value: &Value) -> (Vec<ScrubPlan>, HashSet<String>) {
    let mut plans = Vec::new();
    let mut keys = HashSet::new();
    let Some(obj) = value.as_object() else {
        return (plans, keys);
    };
    for (key, pair) in obj {
        let Some(base) = animatable_base_prop(key) else {
            continue;
        };
        let Some(arr) = pair.as_array() else {
            continue;
        };
        if arr.len() != 2 {
            continue;
        }
        let Some(interp) = make_interp(base, &arr[0], &arr[1]) else {
            continue; // non-interpolable endpoints snap
        };
        let clamp_unit = base == "opacity";
        keys.insert(key.clone());
        plans.push(ScrubPlan {
            write_key: key.clone(),
            interp,
            clamp_unit,
        });
    }
    (plans, keys)
}

/// Write the interpolated pose props for progress `p` into the tree,
/// capturing the pre-scrub originals on the first engaged frame.
fn scrub_apply_progress(entry: &mut ScrubEntry, id: &str, tree: &mut Tree, p: f64) {
    if entry.plans.is_empty() {
        return;
    }
    if !entry.engaged {
        entry.engaged = true;
        entry.originals.clear();
        for plan in &entry.plans {
            let stored = match tree.get(id).and_then(|n| n.props.get(&plan.write_key)) {
                Some(v) => Stored {
                    present: true,
                    value: v.clone(),
                },
                None => Stored {
                    present: false,
                    value: Value::Null,
                },
            };
            entry.originals.insert(plan.write_key.clone(), stored);
        }
    }
    entry.progress = p;
    for plan in &entry.plans {
        let mut v = interp_at(&plan.interp, p, plan.clamp_unit);
        // Trim interpolation noise to 3 decimals — sub-pixel on any display,
        // and the DOM reference rounds identically so the wire values match.
        if let Value::Number(n) = &v {
            if let Some(f) = n.as_f64() {
                v = Value::from((f * 1000.0).round() / 1000.0);
            }
        }
        tree.set_prop_raw(id, &plan.write_key, v);
    }
}

/// Settle arrival: queue the winning pose LABEL through the `.bind` channel,
/// hold the settled props, and open the no-flash cleanup window.
fn scrub_arrive(
    entry: &mut ScrubEntry,
    label: String,
    now: f64,
    cleanup_ms: f64,
) -> Option<ScrubBind> {
    entry.phase = ScrubPhase::AwaitingCleanup;
    entry.pending_label = Some(label.clone());
    entry.cleanup_deadline = Some(now + cleanup_ms);
    entry
        .bind
        .clone()
        .map(|path| ScrubBind { path, value: label })
}

/// Hand the node back to the engine: apply deferred engine writes (else
/// restore the captured originals) and release ownership. `allow_rederive`
/// (label-arrival / timeout) keeps a scroll source resting MID-RANGE engaged
/// — it re-derives from live progress instead of snapping to a pose.
fn scrub_cleanup(
    entry: &mut ScrubEntry,
    id: &str,
    tree: &mut Tree,
    allow_rederive: bool,
    now: f64,
    rest_ms: f64,
) {
    let rederive = allow_rederive
        && entry.spec.as_ref().map(|s| s.source) == Some(ScrubSource::Scroll)
        && entry.progress > 0.0
        && entry.progress < 1.0;
    entry.phase = ScrubPhase::Idle;
    entry.pending_label = None;
    entry.cleanup_deadline = None;
    entry.quiescent = false;

    if entry.engaged {
        for plan in &entry.plans {
            if let Some(v) = entry.deferred.remove(&plan.write_key) {
                tree.set_prop_raw(id, &plan.write_key, v);
            } else if let Some(stored) = entry.originals.get(&plan.write_key) {
                apply_stored(tree, id, &plan.write_key, stored);
            }
        }
        entry.engaged = false;
    }
    // Any deferred writes to non-plan keys (defensive) still flush.
    let leftover: Vec<(String, Value)> = entry.deferred.drain().collect();
    for (k, v) in leftover {
        tree.set_prop_raw(id, &k, v);
    }
    entry.originals.clear();

    if rederive {
        scrub_apply_progress(entry, id, tree, entry.progress);
        entry.quiescence_deadline = Some(now + rest_ms);
    }
}

/// Cancel any live interaction and restore the node's props (a detach / a
/// channel going away / a remove). Never dispatches a bind write.
fn scrub_cancel(entry: &mut ScrubEntry, id: &str, tree: &mut Tree) {
    entry.drag = None;
    if entry.engaged || entry.phase != ScrubPhase::Idle {
        scrub_cleanup(entry, id, tree, false, 0.0, 0.0);
    }
    entry.phase = ScrubPhase::Idle;
    entry.rest_endpoint = None;
    entry.rest_deadline = None;
    entry.quiescence_deadline = None;
    entry.last_scroll_write = None;
}

/// The renderer-resident scrub source: one [`ScrubEntry`] per node carrying
/// the `__anim.scrub*` channels. See the module section header.
pub struct DesktopScrubber {
    entries: HashMap<String, ScrubEntry>,
    clock: Clock,
    reduced_motion: bool,
    motion_essential: HashSet<String>,
    pending_binds: Vec<ScrubBind>,
    /// Node id owning the current pointer gesture (pending or claimed) —
    /// the winit equivalent of pointer capture. `Some` between pointerdown
    /// and release; a second pointerdown while set is ignored (one cursor).
    active_pointer: Option<String>,
    cleanup_timeout_ms: f64,
    rest_debounce_ms: f64,
}

impl Default for DesktopScrubber {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopScrubber {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            clock: Clock::Real(std::time::Instant::now()),
            reduced_motion: env_reduced_motion(),
            motion_essential: HashSet::new(),
            pending_binds: Vec::new(),
            active_pointer: None,
            cleanup_timeout_ms: SCRUB_DEFAULT_CLEANUP_MS,
            rest_debounce_ms: SCRUB_DEFAULT_REST_DEBOUNCE_MS,
        }
    }

    /// Current clock reading in ms (real elapsed, or the injected value).
    fn now(&self) -> f64 {
        match self.clock {
            Clock::Real(start) => start.elapsed().as_secs_f64() * 1000.0,
            Clock::Manual(t) => t,
        }
    }

    /// Inject an absolute clock value (tests): mirrors
    /// [`DesktopAnimator::set_manual_time_ms`].
    pub fn set_manual_time_ms(&mut self, t: f64) {
        self.clock = Clock::Manual(t);
    }

    pub fn set_reduced_motion(&mut self, on: bool) {
        self.reduced_motion = on;
    }

    /// Drain the queued settle writes (the window forwards each to
    /// `module.dispatch_action("__hypen_bind", {path, value})`).
    pub fn take_binds(&mut self) -> Vec<ScrubBind> {
        std::mem::take(&mut self.pending_binds)
    }

    /// Is `id` scrub-active (owned)? Consulted by the window for exit/hover
    /// interplay and mirrored into the animator via [`Self::owned_ids`].
    pub fn owns_node(&self, id: &str) -> bool {
        self.entries.get(id).is_some_and(ScrubEntry::owning)
    }

    /// The set of currently-owned node ids — synced into the animator each
    /// flush for Option G precedence.
    pub fn owned_ids(&self) -> HashSet<String> {
        self.entries
            .iter()
            .filter(|(_, e)| e.owning())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Any entry with a live deadline (settle / cleanup / rest / quiescence)
    /// — keeps the demand-driven redraw ticker armed.
    pub fn has_active(&self) -> bool {
        self.entries.values().any(ScrubEntry::has_active)
    }

    // ---------------------------------------------------------------------
    // Batch observation (runs BEFORE `DesktopAnimator::ingest`)
    // ---------------------------------------------------------------------

    /// Observe a patch batch: register scrub channels off Creates, route
    /// `__anim.scrub*`/`__anim.states`/`__anim.motion` set-props, cancel on
    /// remove/detach, and — the gesture-wins deferral — swallow engine
    /// SetProps to a scrub-owned node's scrubbed keys (removing them from
    /// `patches` so neither the tree nor the animator applies them; the
    /// latest value is replayed at cleanup). Runs before the animator
    /// ingests the (possibly shortened) batch.
    pub fn pre_ingest(&mut self, patches: &mut Vec<Patch>, tree: &mut Tree) {
        let now = self.now();
        let cleanup_ms = self.cleanup_timeout_ms;
        let rest_ms = self.rest_debounce_ms;
        let mut kept: Vec<Patch> = Vec::with_capacity(patches.len());
        for patch in patches.drain(..) {
            match &patch {
                Patch::Create { id, props, .. } => {
                    self.register_create(id, props.as_ref());
                    kept.push(patch);
                }
                Patch::SetProp { id, name, value } => {
                    if name == "__anim.motion" {
                        self.note_motion_essential(id, parse_motion_essential(value));
                        kept.push(patch);
                    } else if name == "__anim.states" {
                        let label = parse_states_label(value);
                        self.note_states_label(
                            id,
                            label.as_deref(),
                            tree,
                            now,
                            cleanup_ms,
                            rest_ms,
                        );
                        kept.push(patch);
                    } else if is_scrub_channel(name) {
                        self.set_scrub_channel(id, name, Some(value), tree);
                        kept.push(patch);
                    } else if self.defer_engine_prop(id, name, value) {
                        // Swallowed: the drag/settle owns this scrubbed key.
                    } else {
                        kept.push(patch);
                    }
                }
                Patch::RemoveProp { id, name } => {
                    if name == "__anim.motion" {
                        self.note_motion_essential(id, false);
                    } else if is_scrub_channel(name) {
                        self.set_scrub_channel(id, name, None, tree);
                    }
                    kept.push(patch);
                }
                Patch::Remove { id, .. } => {
                    self.cancel_subtree(id, tree);
                    self.forget_subtree(id, tree);
                    kept.push(patch);
                }
                Patch::Detach { id } => {
                    self.cancel_subtree(id, tree);
                    kept.push(patch);
                }
                _ => kept.push(patch),
            }
        }
        *patches = kept;
    }

    fn register_create(&mut self, id: &str, props: &indexmap::IndexMap<String, Value>) {
        if let Some(v) = props.get("__anim.motion") {
            self.note_motion_essential(id, parse_motion_essential(v));
        }
        let has_scrub = props.contains_key("__anim.scrub")
            || props.contains_key("__anim.scrubSettle")
            || props.contains_key("__anim.scrubBind")
            || props.contains_key("__anim.scrubPoses");
        if !has_scrub {
            return;
        }
        let entry = self
            .entries
            .entry(id.to_string())
            .or_insert_with(ScrubEntry::new);
        if let Some(v) = props.get("__anim.scrub") {
            entry.spec = parse_scrub_source(v);
        }
        if let Some(v) = props.get("__anim.scrubSettle") {
            entry.settle = parse_scrub_settle(v);
        }
        if let Some(v) = props.get("__anim.scrubBind") {
            entry.bind = parse_scrub_bind(v);
        }
        if let Some(v) = props.get("__anim.scrubPoses") {
            let (plans, keys) = build_scrub_plans(v);
            entry.plans = plans;
            entry.scrubbed_keys = keys;
        }
        // Seed the drag anchor from the node's initial pose label: a node
        // created in its `to` pose drags FROM progress 1.
        let label = props.get("__anim.states").and_then(parse_states_label);
        Self::seed_progress(entry, label.as_deref());
    }

    fn set_scrub_channel(&mut self, id: &str, name: &str, value: Option<&Value>, tree: &mut Tree) {
        let entry = self
            .entries
            .entry(id.to_string())
            .or_insert_with(ScrubEntry::new);
        match name {
            "__anim.scrub" => entry.spec = value.and_then(parse_scrub_source),
            "__anim.scrubSettle" => entry.settle = value.and_then(parse_scrub_settle),
            "__anim.scrubBind" => entry.bind = value.and_then(parse_scrub_bind),
            "__anim.scrubPoses" => {
                let (plans, keys) = value.map(build_scrub_plans).unwrap_or_default();
                entry.plans = plans;
                entry.scrubbed_keys = keys;
            }
            _ => {}
        }
        // A channel going away mid-interaction runs the full cleanup a cancel
        // does — engaged props, deferred writes, and ownership must not leak
        // past the spec that authorized them.
        if !entry.complete() {
            if self.active_pointer.as_deref() == Some(id) {
                self.active_pointer = None;
            }
            if let Some(entry) = self.entries.get_mut(id) {
                scrub_cancel(entry, id, tree);
            }
        }
    }

    /// Gesture-wins deferral gate: while a drag/settle/cleanup window (or an
    /// engaged scroll source under active input) owns a scrubbed key, the
    /// engine SetProp is swallowed here (latest value stored, replayed at
    /// cleanup). Returns `true` when deferred.
    fn defer_engine_prop(&mut self, id: &str, name: &str, value: &Value) -> bool {
        let Some(entry) = self.entries.get_mut(id) else {
            return false;
        };
        if !entry.scrubbed_keys.contains(name) || !entry.owning() {
            return false;
        }
        entry.deferred.insert(name.to_string(), value.clone());
        true
    }

    fn note_motion_essential(&mut self, id: &str, essential: bool) {
        if essential {
            self.motion_essential.insert(id.to_string());
        } else {
            self.motion_essential.remove(id);
        }
    }

    /// `__anim.states` feed: during `awaitingCleanup` ANY label proves the
    /// engine re-render landed → clean up now (a raced non-matching label
    /// must not hold stale visuals). A label while idle re-seeds the anchor.
    fn note_states_label(
        &mut self,
        id: &str,
        label: Option<&str>,
        tree: &mut Tree,
        now: f64,
        cleanup_ms: f64,
        rest_ms: f64,
    ) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        let _ = cleanup_ms;
        if entry.phase == ScrubPhase::AwaitingCleanup && label.is_some() {
            scrub_cleanup(entry, id, tree, true, now, rest_ms);
            return;
        }
        if entry.phase == ScrubPhase::Idle && !entry.engaged {
            Self::seed_progress(entry, label);
        }
    }

    fn seed_progress(entry: &mut ScrubEntry, label: Option<&str>) {
        let (Some(label), Some(spec)) = (label, entry.spec.as_ref()) else {
            return;
        };
        if label == spec.from {
            entry.progress = 0.0;
        } else if label == spec.to {
            entry.progress = 1.0;
        }
    }

    /// Cancel every scrub entry at-or-under `root` (a detaching subtree /
    /// removal names only the root; a descendant's scroll source would keep
    /// scrubbing via a persistent ancestor scroller).
    fn cancel_subtree(&mut self, root: &str, tree: &mut Tree) {
        let ids: Vec<String> = self
            .entries
            .keys()
            .filter(|id| {
                id.as_str() == root
                    || is_at_or_under(tree, id, std::slice::from_ref(&root.to_string()))
            })
            .cloned()
            .collect();
        for id in ids {
            if self.active_pointer.as_deref() == Some(&id) {
                self.active_pointer = None;
            }
            if let Some(entry) = self.entries.get_mut(&id) {
                scrub_cancel(entry, &id, tree);
            }
        }
    }

    /// Drop every scrub entry at-or-under `root` (a removed subtree). Its
    /// nodes are leaving the arena, so their entries go with them.
    fn forget_subtree(&mut self, root: &str, tree: &Tree) {
        let ids: Vec<String> = self
            .entries
            .keys()
            .filter(|id| {
                id.as_str() == root
                    || is_at_or_under(tree, id, std::slice::from_ref(&root.to_string()))
            })
            .cloned()
            .collect();
        for id in ids {
            self.forget(&id);
        }
    }

    /// Drop all state for `id` (a removed node).
    pub fn forget(&mut self, id: &str) {
        self.motion_essential.remove(id);
        self.entries.remove(id);
        if self.active_pointer.as_deref() == Some(id) {
            self.active_pointer = None;
        }
    }

    /// Cancel all in-flight work and drop all caches (renderer clear).
    pub fn reset(&mut self) {
        self.entries.clear();
        self.motion_essential.clear();
        self.pending_binds.clear();
        self.active_pointer = None;
    }

    // ---------------------------------------------------------------------
    // Gesture source (winit pointer)
    // ---------------------------------------------------------------------

    /// A pointer press inside a gesture-scrub node's bounds opens a PENDING
    /// drag; a mid-settle catch claims immediately. Bounds (not a specific
    /// hit id) so a press on a CHILD of the scrub node still opens the drag —
    /// the DOM's pointerdown bubbles to the element; here the press is inside
    /// the element's box. A below-slop release is a total no-op, so the
    /// child's click survives. Returns `true` when a drag opened.
    pub fn pointer_down(&mut self, layout: &crate::layout::LayoutPass, x: f64, y: f64) -> bool {
        if self.active_pointer.is_some() {
            return false; // one cursor, one drag
        }
        let now = self.now();
        let Some(target) = self.gesture_target(layout, x, y) else {
            return false;
        };
        let entry = self
            .entries
            .get_mut(&target)
            .expect("gesture_target checked");
        let axis = entry.spec.as_ref().expect("complete").axis;
        let start_pos = if axis == ScrubAxis::X { x } else { y };
        entry.drag = Some(ScrubDrag {
            start_pos,
            down_t: now,
            p_at_grab: entry.progress,
            claimed: false,
            samples: Vec::new(),
        });
        self.active_pointer = Some(target.clone());
        // Catching a moving (settling) element claims immediately — the
        // settle must stop fighting the finger.
        if entry.phase == ScrubPhase::Settling {
            Self::claim_drag(entry);
        }
        true
    }

    /// Drive the active drag. Returns `true` when it wrote to the tree
    /// (the window must invalidate layout + request a redraw).
    pub fn pointer_move(&mut self, tree: &mut Tree, x: f64, y: f64) -> bool {
        let Some(id) = self.active_pointer.clone() else {
            return false;
        };
        let now = self.now();
        let Some(entry) = self.entries.get_mut(&id) else {
            self.active_pointer = None;
            return false;
        };
        let (Some(spec), Some(drag)) = (entry.spec.as_ref(), entry.drag.as_ref()) else {
            return false;
        };
        let (over0, over1, rubber_band, axis) =
            (spec.over.0, spec.over.1, spec.rubber_band, spec.axis);
        let coord = if axis == ScrubAxis::X { x } else { y };
        let travel = coord - drag.start_pos;
        if !drag.claimed {
            if travel.abs() < SCRUB_SLOP_PX {
                return false;
            }
            Self::claim_drag(entry);
        }
        if entry.phase != ScrubPhase::Dragging {
            return false;
        }
        let p_at_grab = entry
            .drag
            .as_ref()
            .map(|d| d.p_at_grab)
            .unwrap_or(entry.progress);
        let raw = p_at_grab + travel / (over1 - over0);
        let p = scrub_rubber_band(raw, rubber_band);
        scrub_apply_progress(entry, &id, tree, p);
        if let Some(drag) = entry.drag.as_mut() {
            drag.samples.push((now, p));
            if drag.samples.len() > SCRUB_VELOCITY_SAMPLES {
                let excess = drag.samples.len() - SCRUB_VELOCITY_SAMPLES;
                drag.samples.drain(0..excess);
            }
        }
        true
    }

    /// A pointer release: a below-slop tap is a total no-op (the click
    /// passes through to children); a claimed drag projects its release
    /// velocity and begins the settle toward the winning pose.
    pub fn pointer_up(&mut self, tree: &mut Tree) -> ScrubPointerUp {
        let Some(id) = self.active_pointer.take() else {
            return ScrubPointerUp::NoOp;
        };
        let now = self.now();
        let essential = self.motion_essential.contains(&id);
        let reduced = self.reduced_motion;
        let cleanup_ms = self.cleanup_timeout_ms;
        let mut bind = None;
        let mut result = ScrubPointerUp::NoOp;
        if let Some(entry) = self.entries.get_mut(&id) {
            if let Some(drag) = entry.drag.take() {
                if drag.claimed {
                    result = ScrubPointerUp::Claimed;
                    if entry.phase == ScrubPhase::Dragging {
                        let velocity = release_velocity(&drag.samples, now);
                        let projected = entry.progress + velocity * SCRUB_PROJECTION_MS;
                        let target = if projected >= 0.5 { 1.0 } else { 0.0 };
                        bind = Self::begin_settle(
                            entry, &id, tree, target, now, reduced, essential, cleanup_ms,
                        );
                    }
                }
            }
        }
        if let Some(b) = bind {
            self.pending_binds.push(b);
        }
        result
    }

    /// Slop exceeded (or a mid-settle catch): the gesture claims the node —
    /// stop any settle, anchor the relative mapping + velocity window at the
    /// LIVE progress.
    fn claim_drag(entry: &mut ScrubEntry) {
        entry.phase = ScrubPhase::Dragging;
        entry.quiescent = false;
        entry.cleanup_deadline = None;
        entry.pending_label = None;
        let progress = entry.progress;
        if let Some(drag) = entry.drag.as_mut() {
            drag.claimed = true;
            drag.p_at_grab = progress;
            // Seed the velocity window at the pointerdown instant, not the
            // claim instant (a slow drag past slop still projects correctly).
            drag.samples = vec![(drag.down_t, progress)];
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_settle(
        entry: &mut ScrubEntry,
        id: &str,
        tree: &mut Tree,
        target: f64,
        now: f64,
        reduced: bool,
        essential: bool,
        cleanup_ms: f64,
    ) -> Option<ScrubBind> {
        let spec = entry.spec.as_ref().expect("complete");
        let label = if target >= 0.5 {
            spec.to.clone()
        } else {
            spec.from.clone()
        };
        let duration = entry.settle.as_ref().map(|s| s.duration).unwrap_or(0.0);
        // Reduced motion: direct manipulation was exempt, the release is not
        // — settle INSTANTLY, then write. A `.motion(essential)` node
        // animates normally.
        if (reduced && !essential) || duration <= 0.0 {
            scrub_apply_progress(entry, id, tree, target);
            return scrub_arrive(entry, label, now, cleanup_ms);
        }
        entry.phase = ScrubPhase::Settling;
        entry.settle_from = entry.progress;
        entry.settle_target = target;
        entry.settle_start = now;
        entry.settle_label = Some(label);
        None
    }

    /// Test-only: open a pending drag directly on a named entry, bypassing
    /// the layout hit-test (the DOM tests dispatch `pointerdown` on the
    /// element the same way). The real hit path is exercised by
    /// [`Self::gesture_target`] in its own test.
    #[cfg(test)]
    pub(crate) fn pointer_down_on(&mut self, id: &str, x: f64, y: f64) -> bool {
        if self.active_pointer.is_some() {
            return false;
        }
        let now = self.now();
        let Some(entry) = self.entries.get_mut(id) else {
            return false;
        };
        if !entry.complete() || entry.spec.as_ref().map(|s| s.source) != Some(ScrubSource::Gesture)
        {
            return false;
        }
        let axis = entry.spec.as_ref().unwrap().axis;
        let start_pos = if axis == ScrubAxis::X { x } else { y };
        entry.drag = Some(ScrubDrag {
            start_pos,
            down_t: now,
            p_at_grab: entry.progress,
            claimed: false,
            samples: Vec::new(),
        });
        self.active_pointer = Some(id.to_string());
        if entry.phase == ScrubPhase::Settling {
            Self::claim_drag(entry);
        }
        true
    }

    /// The topmost complete gesture-scrub node whose laid-out bounds contain
    /// `(x, y)`. Paint order (item index) breaks ties so a nested/overlapping
    /// scrub wins like the visually-topmost element would.
    fn gesture_target(&self, layout: &crate::layout::LayoutPass, x: f64, y: f64) -> Option<String> {
        let (px, py) = (x as f32, y as f32);
        let mut best: Option<(usize, String)> = None;
        for (idx, item) in layout.items.iter().enumerate() {
            let Some(entry) = self.entries.get(&item.node_id) else {
                continue;
            };
            if !entry.complete()
                || entry.spec.as_ref().map(|s| s.source) != Some(ScrubSource::Gesture)
            {
                continue;
            }
            if item.hit_contains(px, py) {
                best = Some((idx, item.node_id.clone()));
            }
        }
        best.map(|(_, id)| id)
    }

    // ---------------------------------------------------------------------
    // Scroll source (winit wheel)
    // ---------------------------------------------------------------------

    /// A scroll event: re-derive every scroll-source entry's progress from
    /// its resolved container's current offset (absolute mapping). Returns
    /// `true` when any entry wrote to the tree. The bind write fires only
    /// once progress crosses AND RESTS at an endpoint (rest debounce, in
    /// [`Self::tick`]).
    pub fn on_scroll(
        &mut self,
        tree: &mut Tree,
        layout: &crate::layout::LayoutPass,
        scrollables: &HashMap<String, f32>,
    ) -> bool {
        let now = self.now();
        let rest_ms = self.rest_debounce_ms;
        let mut dirty = false;
        for (id, entry) in self.entries.iter_mut() {
            let Some(spec) = entry.spec.as_ref() else {
                continue;
            };
            if spec.source != ScrubSource::Scroll || !entry.complete() {
                continue;
            }
            let Some(container) = resolve_scroll_container(entry, id, &*tree, layout) else {
                continue;
            };
            entry.quiescent = false; // active input re-claims ownership
            let offset = scrollables.get(&container).copied().unwrap_or(0.0) as f64;
            let (over0, over1, rubber_band) = {
                let s = entry.spec.as_ref().unwrap();
                (s.over.0, s.over.1, s.rubber_band)
            };
            let raw_lin = (offset - over0) / (over1 - over0);
            let p = scrub_rubber_band(raw_lin, rubber_band);
            scrub_apply_progress(entry, id, tree, p);
            dirty = true;
            if entry.phase == ScrubPhase::Idle && entry.engaged {
                entry.quiescence_deadline = Some(now + rest_ms);
            }
            let endpoint = if raw_lin <= 0.0 {
                Some(0u8)
            } else if raw_lin >= 1.0 {
                Some(1u8)
            } else {
                None
            };
            match endpoint {
                None => {
                    entry.rest_deadline = None;
                    entry.rest_endpoint = None;
                    entry.last_scroll_write = None;
                }
                Some(ep) => {
                    let spec = entry.spec.as_ref().unwrap();
                    let label = if ep == 1 {
                        spec.to.clone()
                    } else {
                        spec.from.clone()
                    };
                    let already = entry.last_scroll_write.as_deref() == Some(label.as_str());
                    let running = entry.rest_endpoint == Some(ep) && entry.rest_deadline.is_some();
                    if !already && !running {
                        entry.rest_endpoint = Some(ep);
                        entry.rest_deadline = Some(now + rest_ms);
                    }
                }
            }
        }
        dirty
    }

    // ---------------------------------------------------------------------
    // Frame tick (settle / cleanup / rest / quiescence deadlines)
    // ---------------------------------------------------------------------

    /// Advance settles and fire elapsed deadlines. Returns `true` when it
    /// wrote to the tree (the window invalidates layout on a dirty frame).
    /// Queued bind writes are drained via [`Self::take_binds`].
    pub fn tick(&mut self, tree: &mut Tree) -> bool {
        if !self.has_active() {
            return false;
        }
        let now = self.now();
        let cleanup_ms = self.cleanup_timeout_ms;
        let rest_ms = self.rest_debounce_ms;
        let mut dirty = false;
        let mut binds: Vec<ScrubBind> = Vec::new();
        for (id, entry) in self.entries.iter_mut() {
            match entry.phase {
                ScrubPhase::Settling => {
                    let duration = entry.settle.as_ref().map(|s| s.duration).unwrap_or(0.0);
                    let ease = entry
                        .settle
                        .as_ref()
                        .map(|s| s.ease)
                        .unwrap_or(Easing::Linear);
                    let t = if duration > 0.0 {
                        ((now - entry.settle_start) / duration).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    let eased = ease.eval(t);
                    let p = entry.settle_from + (entry.settle_target - entry.settle_from) * eased;
                    scrub_apply_progress(entry, id, tree, p);
                    dirty = true;
                    if t >= 1.0 {
                        let label = entry.settle_label.clone().unwrap_or_default();
                        if let Some(b) = scrub_arrive(entry, label, now, cleanup_ms) {
                            binds.push(b);
                        }
                    }
                }
                ScrubPhase::AwaitingCleanup => {
                    if let Some(dl) = entry.cleanup_deadline {
                        if now >= dl {
                            scrub_cleanup(entry, id, tree, true, now, rest_ms);
                            dirty = true;
                        }
                    }
                }
                _ => {}
            }
            // Scroll endpoint rest debounce → the settle write.
            if let Some(dl) = entry.rest_deadline {
                if now >= dl {
                    entry.rest_deadline = None;
                    let ep = entry.rest_endpoint.take();
                    if let Some(spec) = entry.spec.as_ref() {
                        let label = if ep == Some(1) {
                            spec.to.clone()
                        } else {
                            spec.from.clone()
                        };
                        entry.last_scroll_write = Some(label.clone());
                        if let Some(b) = scrub_arrive(entry, label, now, cleanup_ms) {
                            binds.push(b);
                        }
                        dirty = true;
                    }
                }
            }
            // Scroll quiescence: mid-range rest releases ownership + deferral.
            if let Some(dl) = entry.quiescence_deadline {
                if now >= dl {
                    entry.quiescence_deadline = None;
                    if entry.phase == ScrubPhase::Idle && entry.engaged && !entry.quiescent {
                        entry.quiescent = true;
                        let leftover: Vec<(String, Value)> = entry.deferred.drain().collect();
                        for (k, v) in leftover {
                            tree.set_prop_raw(id, &k, v);
                            dirty = true;
                        }
                    }
                }
            }
        }
        self.pending_binds.append(&mut binds);
        dirty
    }
}

/// Progress velocity (progress/ms) over the samples within the recent
/// window; an empty window (drag-hold-release) projects zero.
fn release_velocity(samples: &[(f64, f64)], now: f64) -> f64 {
    let recent: Vec<(f64, f64)> = samples
        .iter()
        .copied()
        .filter(|(t, _)| now - t <= SCRUB_VELOCITY_WINDOW_MS)
        .collect();
    if recent.len() < 2 {
        return 0.0;
    }
    let first = recent[0];
    let last = recent[recent.len() - 1];
    let dt = last.0 - first.0;
    if dt > 0.0 {
        (last.1 - first.1) / dt
    } else {
        0.0
    }
}

/// `__anim.states` label value. The engine lowers the active-pose label as a
/// JSON OBJECT `{"label": "<label>"}` (see `hypen_engine::ir::expand`'s
/// `StateSwitch` synthesis), so that is the shape real apps emit; a BARE
/// string is tolerated for hosts that pass the label through directly (Remote
/// UI) — mirroring the DOM/core `parseStatesLabel` JSON-string-or-object
/// tolerance. Both the animator's settle-window path and the scrubber's
/// label feed read through here so neither can assume the wrong shape.
fn parse_states_label(value: &Value) -> Option<String> {
    if let Some(obj) = value.as_object() {
        return obj.get("label").and_then(Value::as_str).map(str::to_string);
    }
    value.as_str().map(str::to_string)
}

fn is_scrub_channel(name: &str) -> bool {
    matches!(
        name,
        "__anim.scrub" | "__anim.scrubSettle" | "__anim.scrubBind" | "__anim.scrubPoses"
    )
}

/// Resolve a scroll-source entry's container: `of:` matches the nearest
/// ancestor whose `id` prop equals the string (one-time dev warn + nearest
/// scrollable fallback on no match); otherwise the nearest scrollable
/// ancestor. Returns the container's renderer node id (the `scrollables`
/// map key).
fn resolve_scroll_container(
    entry: &mut ScrubEntry,
    id: &str,
    tree: &Tree,
    layout: &crate::layout::LayoutPass,
) -> Option<String> {
    let of = entry.spec.as_ref().and_then(|s| s.of.clone());
    if let Some(of) = of.as_deref() {
        let mut current = tree.parent_of(id);
        while let Some(cur) = current {
            if let Some(node) = tree.get(cur) {
                let matches = node.props.get("id").and_then(Value::as_str) == Some(of)
                    || node.props.get("id.0").and_then(Value::as_str) == Some(of);
                if matches {
                    return Some(cur.to_string());
                }
            }
            current = tree.parent_of(cur);
        }
        if !entry.of_warned {
            entry.of_warned = true;
            log::warn!(
                "scrub of: \"{of}\" matched no ancestor of node {id}; \
                 falling back to the nearest scrollable ancestor"
            );
        }
    }
    let mut current = tree.parent_of(id);
    while let Some(cur) = current {
        if layout
            .item_by_id(cur)
            .is_some_and(|it| it.scrollable.is_some())
        {
            return Some(cur.to_string());
        }
        current = tree.parent_of(cur);
    }
    None
}

#[cfg(test)]
#[path = "anim_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "scrub_tests.rs"]
mod scrub_tests;
