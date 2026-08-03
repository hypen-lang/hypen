/**
 * Shared animation vocabulary for the `__anim.*` prop channel.
 *
 * The engine lowers the `.transition` / `.enter` / `.exit` / `.layout` /
 * `.animate` applicators into five reserved props — one JSON object per
 * channel — carried on `create` patches (and kept live via `setProp`). This
 * module is
 * the renderer-agnostic half of that contract: channel keys, spec types, the
 * animatable-prop whitelist, the curve/preset/direction vocabulary, and a
 * defensive parser. DOM, Canvas, and native renderers all consume these;
 * nothing here touches the DOM.
 *
 * The vocabulary (curves, presets, directions, animate-preset defaults) and
 * the ANIMATABLE_PROPS whitelist keys are normative — the Rust mirror in
 * `hypen-engine-rs/src/ir/anim.rs` must match them exactly, pinned by a
 * conformance fixture in `engine-compatibility-tests/`.
 */

// ============================================================================
// CHANNEL KEYS
// ============================================================================

/**
 * Prefix shared by every animation channel prop. Renderer routing is a
 * single `name.startsWith(ANIM_PROP_PREFIX)` check; renderers that don't
 * understand `__anim.*` ignore the props and snap (sanctioned degradation).
 */
export const ANIM_PROP_PREFIX = "__anim.";

/** `.transition(...)` → `{ duration, curve, delay?, props? }`. */
export const ANIM_TRANSITION_PROP = "__anim.transition";
/** `.enter(...)` → `{ presets, duration, curve, delay?, from? }`. */
export const ANIM_ENTER_PROP = "__anim.enter";
/** `.exit(...)` → `{ presets, duration, curve, delay?, to? }`. */
export const ANIM_EXIT_PROP = "__anim.exit";
/** `.layout(...)` → `{ duration, curve, delay? }` (FLIP intent on moves). */
export const ANIM_LAYOUT_PROP = "__anim.layout";
/** `.animate(preset, ...)` → `{ preset, duration, repeat, curve, delay? }`. */
export const ANIM_PROP_ANIMATE = "__anim.animate";

// ============================================================================
// VOCABULARY
// ============================================================================

export type AnimCurve = "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring";
export type AnimPreset = "fade" | "slide" | "scale";
export type AnimDirection = "top" | "bottom" | "leading" | "trailing";
/** Iteration count for `.animate`: `"loop"` (forever) or a positive integer. */
export type AnimRepeat = "loop" | number;
/** Built-in `.animate` timeline presets (Option E, presets-only). */
export type AnimatePreset = "pulse" | "spin" | "shimmer" | "shake";

export const ANIM_CURVES: readonly AnimCurve[] = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
  "spring",
];

export const ANIM_PRESETS: readonly AnimPreset[] = ["fade", "slide", "scale"];

export const ANIM_DIRECTIONS: readonly AnimDirection[] = [
  "top",
  "bottom",
  "leading",
  "trailing",
];

/**
 * Curve token → CSS `transition-timing-function` value. `spring` is a fixed
 * overshoot bezier in v1 (parameterized springs are deferred).
 */
export const CURVE_TO_CSS: Record<AnimCurve, string> = {
  linear: "linear",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",
  spring: "cubic-bezier(0.34,1.56,0.64,1)",
};

// ============================================================================
// NUMERIC EASING (shared curve evaluation for non-CSS renderers)
// ============================================================================

/**
 * A numeric easing function: normalized time `t` in `[0,1]` → eased progress.
 * `f(0) === 0` and `f(1) === 1` exactly; overshoot curves (`spring`) may
 * exceed `1` mid-range, so consumers interpolating clamped quantities
 * (opacity, colors) must clamp the *result of interpolation*, not `t`.
 */
export type EasingFunction = (t: number) => number;

/**
 * Curve token → cubic-bezier control points `[x1, y1, x2, y2]`. These are the
 * exact beziers behind {@link CURVE_TO_CSS}: the CSS `ease-in` / `ease-out` /
 * `ease-in-out` keywords are defined by the CSS Easing spec as fixed cubic
 * beziers, pinned here so a Canvas or native ticker eases identically to the
 * DOM renderer's CSS transitions. `linear` is included for uniformity but
 * {@link curveFunction} short-circuits it to the identity.
 */
export const CURVE_BEZIER_POINTS: Record<
  AnimCurve,
  readonly [number, number, number, number]
> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  spring: [0.34, 1.56, 0.64, 1],
};

// Newton-Raphson iterations before falling back to bisection, and the
// x-accuracy target — the standard approach (WebKit's UnitBezier and every
// derivative of it) for inverting the monotone x(t) polynomial.
const NEWTON_ITERATIONS = 8;
const NEWTON_EPSILON = 1e-7;
const BISECTION_EPSILON = 1e-7;
const BISECTION_MAX_ITERATIONS = 64;

/**
 * Build a numeric easing function from CSS cubic-bezier control points
 * (`cubic-bezier(x1, y1, x2, y2)` semantics: implicit anchors at `(0,0)` and
 * `(1,1)`; `x1`/`x2` are clamped to `[0,1]` as the CSS spec requires so
 * `x(t)` is monotone and invertible; `y1`/`y2` are unclamped, which is how
 * overshoot curves like `spring` exceed `1`).
 *
 * Dependency-free and renderer-agnostic: solves `x(t) = x` with a few Newton
 * steps, falling back to bisection when the derivative is too flat, then
 * evaluates `y` at the solved parameter. Inputs outside `[0,1]` clamp to the
 * endpoints, and the endpoints themselves are exact by construction.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): EasingFunction {
  // CSS clamps the x control points into [0,1]; without this x(t) need not be
  // monotone and the inversion below would be meaningless.
  const cx1 = Math.min(1, Math.max(0, x1));
  const cx2 = Math.min(1, Math.max(0, x2));

  // Horner-form polynomial coefficients for B(t) with P0=(0,0), P3=(1,1):
  // B(t) = ((a*t + b)*t + c)*t.
  const cX = 3 * cx1;
  const bX = 3 * (cx2 - cx1) - cX;
  const aX = 1 - cX - bX;
  const cY = 3 * y1;
  const bY = 3 * (y2 - y1) - cY;
  const aY = 1 - cY - bY;

  const sampleX = (t: number): number => ((aX * t + bX) * t + cX) * t;
  const sampleY = (t: number): number => ((aY * t + bY) * t + cY) * t;
  const sampleDerivativeX = (t: number): number =>
    (3 * aX * t + 2 * bX) * t + cX;

  const solveT = (x: number): number => {
    // Newton-Raphson from a decent seed — converges in a few steps almost
    // everywhere on these curves.
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < NEWTON_EPSILON) return t;
      const derivative = sampleDerivativeX(t);
      if (Math.abs(derivative) < 1e-6) break; // too flat — Newton would blow up
      t -= error / derivative;
    }
    // Bisection fallback: x(t) is monotone on [0,1], so this always lands.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < BISECTION_MAX_ITERATIONS && hi - lo > BISECTION_EPSILON; i++) {
      t = (lo + hi) / 2;
      if (sampleX(t) < x) lo = t;
      else hi = t;
    }
    return t;
  };

  return (t: number): number => {
    // Exact endpoints (and clamped out-of-range input) — renderers rely on
    // f(1) === 1 to finalize without a residual epsilon.
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveT(t));
  };
}

const identityEasing: EasingFunction = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t;

// Evaluators are built once per curve token, not per call — solving the
// bezier allocates nothing, so a ticker can call these every frame.
const CURVE_FUNCTIONS: Record<AnimCurve, EasingFunction> = {
  linear: identityEasing,
  easeIn: cubicBezier(...CURVE_BEZIER_POINTS.easeIn),
  easeOut: cubicBezier(...CURVE_BEZIER_POINTS.easeOut),
  easeInOut: cubicBezier(...CURVE_BEZIER_POINTS.easeInOut),
  spring: cubicBezier(...CURVE_BEZIER_POINTS.spring),
};

/**
 * Curve token → numeric easing function, the non-CSS twin of
 * {@link CURVE_TO_CSS}. Cached per token — safe to call in a render/tick
 * loop. An unrecognized token (defensively, from untyped callers) degrades
 * to `linear`, mirroring the parser's snap-don't-throw contract.
 */
export function curveFunction(curve: AnimCurve): EasingFunction {
  return CURVE_FUNCTIONS[curve] ?? identityEasing;
}

// ============================================================================
// ANIMATABLE-PROP WHITELIST
// ============================================================================

/**
 * Hypen prop → CSS properties it animates. The KEYS are the normative
 * whitelist the engine filters `.transition(props: [...])` against (Rust
 * mirror in `ir/anim.rs`); the VALUES are the DOM mapping used to build
 * `transition-property` lists. Multiple Hypen props may share a CSS property
 * (all transform-ish props collapse onto `transform`) and directional
 * shorthands expand to both sides — consumers dedupe via
 * {@link cssPropertiesFor}.
 */
export const ANIMATABLE_PROPS: Record<string, readonly string[]> = {
  opacity: ["opacity"],
  translateX: ["transform"],
  translateY: ["transform"],
  scale: ["transform"],
  rotate: ["transform"],
  color: ["color"],
  backgroundColor: ["background-color"],
  borderColor: ["border-color"],
  cornerRadius: ["border-radius"],
  padding: ["padding"],
  paddingTop: ["padding-top"],
  paddingBottom: ["padding-bottom"],
  paddingLeft: ["padding-left"],
  paddingRight: ["padding-right"],
  paddingHorizontal: ["padding-left", "padding-right"],
  paddingVertical: ["padding-top", "padding-bottom"],
  margin: ["margin"],
  marginTop: ["margin-top"],
  marginBottom: ["margin-bottom"],
  marginLeft: ["margin-left"],
  marginRight: ["margin-right"],
  marginHorizontal: ["margin-left", "margin-right"],
  marginVertical: ["margin-top", "margin-bottom"],
  width: ["width"],
  height: ["height"],
  gap: ["gap"],
  fontSize: ["font-size"],
};

/**
 * Resolve a (possibly scoped) Hypen prop list to a deduped, order-preserving
 * CSS property list for `transition-property`. Omitting `props` resolves the
 * full whitelist; unknown Hypen props are ignored.
 */
export function cssPropertiesFor(props?: readonly string[]): string[] {
  const source = props ?? Object.keys(ANIMATABLE_PROPS);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const prop of source) {
    const cssProps = ANIMATABLE_PROPS[prop];
    if (!cssProps) continue;
    for (const css of cssProps) {
      if (seen.has(css)) continue;
      seen.add(css);
      out.push(css);
    }
  }
  return out;
}

// ============================================================================
// ENTER/EXIT PRESETS
// ============================================================================

/** How far `slide` offsets a node in its hidden position. */
export const SLIDE_OFFSET_PX = 24;
/** The `scale` preset's hidden scale factor. */
export const SCALE_HIDDEN_FACTOR = 0.95;

/**
 * A preset's contribution to a node's HIDDEN style — where an entering node
 * starts and an exiting node ends. Transforms from composed presets are
 * space-joined; opacity is last-writer-wins (only `fade` sets it).
 */
export type PresetHiddenStyle = {
  opacity?: string;
  transform?: string;
};

const slideTransform = (direction: AnimDirection, rtl: boolean): string => {
  switch (direction) {
    case "top":
      return `translateY(-${SLIDE_OFFSET_PX}px)`;
    case "bottom":
      return `translateY(${SLIDE_OFFSET_PX}px)`;
    case "leading":
      return rtl
        ? `translateX(${SLIDE_OFFSET_PX}px)`
        : `translateX(-${SLIDE_OFFSET_PX}px)`;
    case "trailing":
      return rtl
        ? `translateX(-${SLIDE_OFFSET_PX}px)`
        : `translateX(${SLIDE_OFFSET_PX}px)`;
  }
};

/**
 * Preset → hidden-style contribution. `slide` is direction-dependent and
 * RTL-aware: `leading`/`trailing` resolve against the layout direction
 * (leading = left in LTR, right in RTL); an absent direction defaults to
 * `leading`.
 */
export const ENTER_EXIT_PRESETS: Record<
  AnimPreset,
  (direction: AnimDirection | undefined, rtl: boolean) => PresetHiddenStyle
> = {
  fade: () => ({ opacity: "0" }),
  slide: (direction, rtl) => ({
    transform: slideTransform(direction ?? "leading", rtl),
  }),
  scale: () => ({ transform: `scale(${SCALE_HIDDEN_FACTOR})` }),
};

/**
 * Combine composed presets (`.enter(slide, fade)`) into one hidden style:
 * the enter start / exit end for the node. `direction` is the spec's
 * `from`/`to`; `rtl` is the resolved layout direction.
 */
export function presetHiddenStyles(
  presets: readonly AnimPreset[],
  direction?: AnimDirection,
  rtl = false
): PresetHiddenStyle {
  const out: PresetHiddenStyle = {};
  const transforms: string[] = [];
  for (const preset of presets) {
    const contribute = ENTER_EXIT_PRESETS[preset];
    if (!contribute) continue;
    const style = contribute(direction, rtl);
    if (style.opacity !== undefined) out.opacity = style.opacity;
    if (style.transform !== undefined) transforms.push(style.transform);
  }
  if (transforms.length > 0) out.transform = transforms.join(" ");
  return out;
}

// ============================================================================
// ANIMATE PRESETS (Option E — presets-only)
// ============================================================================

/** Per-preset defaults the engine fills when `.animate(...)` omits an arg. */
export type AnimatePresetDefaults = {
  duration: number;
  repeat: AnimRepeat;
  curve: AnimCurve;
};

/**
 * The built-in timeline presets and their normative defaults. The KEYS are
 * the closed preset vocabulary the engine validates `.animate(<name>)`
 * against (unknown preset → warn + omit the channel, Rust mirror in
 * `ir/anim.rs`); the VALUES are the defaults it fills into the wire object,
 * which renderers also use as `var()` fallbacks. Keyframe *shapes* are
 * renderer-owned (CSS `@keyframes` on DOM, ticker curves on Canvas, native
 * facilities elsewhere) — only the names and timing defaults are shared.
 */
export const ANIMATE_PRESETS: Record<AnimatePreset, AnimatePresetDefaults> = {
  pulse: { duration: 1200, repeat: "loop", curve: "easeInOut" },
  spin: { duration: 800, repeat: "loop", curve: "linear" },
  shimmer: { duration: 1500, repeat: "loop", curve: "linear" },
  shake: { duration: 400, repeat: 1, curve: "easeInOut" },
};

// ============================================================================
// CHANNEL SPECS
// ============================================================================

/** `__anim.transition` — implicit prop-change animation (Option A). */
export type TransitionSpec = {
  duration: number;
  curve: AnimCurve;
  delay?: number;
  /**
   * Scoped Hypen prop list (whitelist-filtered). Absent = every animatable
   * prop transitions.
   */
  props?: string[];
};

/** `__anim.enter` — played when the node is inserted (Option B). */
export type EnterSpec = {
  presets: AnimPreset[];
  duration: number;
  curve: AnimCurve;
  delay?: number;
  from?: AnimDirection;
};

/** `__anim.exit` — played before the deferred remove finalizes (Option B). */
export type ExitSpec = {
  presets: AnimPreset[];
  duration: number;
  curve: AnimCurve;
  delay?: number;
  to?: AnimDirection;
};

/** `__anim.layout` — FLIP intent for `move` patches (Option B). */
export type LayoutSpec = {
  duration: number;
  curve: AnimCurve;
  delay?: number;
};

/** `__anim.animate` — ambient preset timeline playback (Option E). */
export type AnimateSpec = {
  preset: AnimatePreset;
  duration: number;
  repeat: AnimRepeat;
  curve: AnimCurve;
  delay?: number;
};

/**
 * All five channels for one node, parsed from its props. A `null` channel
 * means "absent or malformed" — either way the renderer snaps, which is the
 * spec-sanctioned degradation.
 */
export type NodeAnimSpecs = {
  transition: TransitionSpec | null;
  enter: EnterSpec | null;
  exit: ExitSpec | null;
  layout: LayoutSpec | null;
  animate: AnimateSpec | null;
};

// ============================================================================
// DEFENSIVE PARSING
// ============================================================================

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A channel value normally arrives as an object (WASM patches deserialize
// props to plain JS values), but a stringified object is tolerated for
// hosts that pass raw JSON through (e.g. the Remote UI wire).
const channelObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
};

const isDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isCurve = (value: unknown): value is AnimCurve =>
  typeof value === "string" && (ANIM_CURVES as readonly string[]).includes(value);

const isDirection = (value: unknown): value is AnimDirection =>
  typeof value === "string" &&
  (ANIM_DIRECTIONS as readonly string[]).includes(value);

// Shared duration/curve/delay core of every channel. The engine always
// emits duration + curve (defaults filled at lowering), so a missing or
// invalid one marks the whole channel malformed.
const parseTiming = (
  obj: Record<string, unknown>
): { duration: number; curve: AnimCurve; delay?: number } | null => {
  if (!isDuration(obj.duration) || !isCurve(obj.curve)) return null;
  const timing: { duration: number; curve: AnimCurve; delay?: number } = {
    duration: obj.duration,
    curve: obj.curve,
  };
  if (isDuration(obj.delay)) timing.delay = obj.delay;
  return timing;
};

// Filter a presets array to the known vocabulary; a non-array, or nothing
// recognizable, voids the channel (playing "no presets" is a no-op anyway).
const parsePresets = (value: unknown): AnimPreset[] | null => {
  if (!Array.isArray(value)) return null;
  const presets = value.filter((p): p is AnimPreset =>
    typeof p === "string" && (ANIM_PRESETS as readonly string[]).includes(p)
  );
  return presets.length > 0 ? presets : null;
};

const parseTransition = (value: unknown): TransitionSpec | null => {
  const obj = channelObject(value);
  if (!obj) return null;
  const timing = parseTiming(obj);
  if (!timing) return null;
  const spec: TransitionSpec = timing;
  if (obj.props !== undefined) {
    if (!Array.isArray(obj.props)) return null;
    const props = obj.props.filter(
      (p): p is string => typeof p === "string" && p in ANIMATABLE_PROPS
    );
    // A scope that filters to nothing animates nothing — same as no channel.
    if (props.length === 0) return null;
    spec.props = props;
  }
  return spec;
};

// Shared timing + presets core of enter/exit; the direction key differs
// (`from` on enter, `to` on exit) and an invalid direction is dropped, not
// channel-voiding — the presets still play without an axis override.
const parseEnterExitBase = (
  value: unknown,
  directionKey: "from" | "to"
): {
  base: { presets: AnimPreset[]; duration: number; curve: AnimCurve; delay?: number };
  direction: AnimDirection | undefined;
} | null => {
  const obj = channelObject(value);
  if (!obj) return null;
  const timing = parseTiming(obj);
  if (!timing) return null;
  const presets = parsePresets(obj.presets);
  if (!presets) return null;
  const direction = obj[directionKey];
  return {
    base: { ...timing, presets },
    direction: isDirection(direction) ? direction : undefined,
  };
};

const parseEnter = (value: unknown): EnterSpec | null => {
  const parsed = parseEnterExitBase(value, "from");
  if (!parsed) return null;
  const spec: EnterSpec = parsed.base;
  if (parsed.direction) spec.from = parsed.direction;
  return spec;
};

const parseExit = (value: unknown): ExitSpec | null => {
  const parsed = parseEnterExitBase(value, "to");
  if (!parsed) return null;
  const spec: ExitSpec = parsed.base;
  if (parsed.direction) spec.to = parsed.direction;
  return spec;
};

const parseLayout = (value: unknown): LayoutSpec | null => {
  const obj = channelObject(value);
  if (!obj) return null;
  return parseTiming(obj);
};

const isAnimatePreset = (value: unknown): value is AnimatePreset =>
  typeof value === "string" && value in ANIMATE_PRESETS;

const isRepeat = (value: unknown): value is AnimRepeat =>
  value === "loop" ||
  (typeof value === "number" && Number.isInteger(value) && value >= 1);

// The engine always emits preset + duration + repeat + curve (per-preset
// defaults filled at lowering; unknown presets never reach the wire), so —
// as with the other channels — a missing or invalid required field marks the
// whole channel malformed.
const parseAnimate = (value: unknown): AnimateSpec | null => {
  const obj = channelObject(value);
  if (!obj) return null;
  if (!isAnimatePreset(obj.preset)) return null;
  const timing = parseTiming(obj);
  if (!timing) return null;
  if (!isRepeat(obj.repeat)) return null;
  return { preset: obj.preset, ...timing, repeat: obj.repeat };
};

/**
 * Parse a node's `__anim.*` props into typed channel specs. Defensive by
 * contract: malformed input never throws — each channel validates
 * independently and degrades to `null` (snap), so one bad channel can't
 * poison the others.
 */
export function parseAnimProps(
  props: Record<string, unknown> | null | undefined
): NodeAnimSpecs {
  if (!props) {
    return { transition: null, enter: null, exit: null, layout: null, animate: null };
  }
  return {
    transition: parseTransition(props[ANIM_TRANSITION_PROP]),
    enter: parseEnter(props[ANIM_ENTER_PROP]),
    exit: parseExit(props[ANIM_EXIT_PROP]),
    layout: parseLayout(props[ANIM_LAYOUT_PROP]),
    animate: parseAnimate(props[ANIM_PROP_ANIMATE]),
  };
}
