/**
 * Shared variant (responsive breakpoint + interaction state) support.
 *
 * The engine emits applicator props using the canonical key format:
 *
 *   <camelBase><variant?><argSuffix>
 *
 *   - camelBase:  camelCase applicator name, e.g. "padding", "backgroundColor"
 *   - variant?:   "@<bp>" and/or ":<state>", in that order if combined.
 *                   bp    in { sm, md, lg, xl, 2xl }
 *                   state in { hover, focus, active, disabled,
 *                              focus-visible, focus-within }
 *                 combined example: "backgroundColor@md:hover" (BOTH md AND hover)
 *   - argSuffix:  ".<index>" (almost always ".0") or ".<name>" for named args.
 *
 * Examples emitted by the engine:
 *   "padding.0", "padding@md.0", "backgroundColor:hover.0",
 *   "backgroundColor@md:hover.0".
 *
 * IMPORTANT: the variant marker sits BETWEEN the base name and the ".0" arg
 * suffix. A lookup that forgets the ".0" (e.g. building just "padding@md")
 * MISSES the real key. Always parse the variant out of the full key.
 *
 * Both the DOM applicator path and the Canvas renderer import this module so
 * breakpoint pixels, state names, and precedence stay byte-compatible across
 * renderers. The DOM renderer leans on the CSS engine for actual resolution
 * (media queries + pseudo-classes), so it only needs PARSE_* here; Canvas does
 * its own paint/layout and therefore also uses the runtime resolver.
 */

/**
 * Tailwind breakpoint min-widths (px). Order matters: ascending min-width.
 * Mirrors the DOM `BREAKPOINTS` table and the iOS reference.
 */
export const BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** Breakpoint names in ascending min-width order (sm < md < lg < xl < 2xl). */
export const BREAKPOINT_ORDER: readonly string[] = ["sm", "md", "lg", "xl", "2xl"];

/** Interaction-state names recognised in variant keys (same set as the DOM). */
export const VALID_STATES: readonly string[] = [
  "hover",
  "focus",
  "active",
  "disabled",
  "focus-visible",
  "focus-within",
];
const VALID_STATE_SET = new Set(VALID_STATES);

/** Parsed shape of a single prop key. */
export interface ParsedVariantKey {
  /** camelCase base applicator name, e.g. "backgroundColor". */
  base: string;
  /** Breakpoint name (sm/md/lg/xl/2xl) or null if none. */
  breakpoint: string | null;
  /** Interaction state name or null if none. */
  state: string | null;
  /** Arg suffix without the leading dot (e.g. "0", "to"), or null if none. */
  arg: string | null;
}

/**
 * Parse a prop key into `{ base, breakpoint, state, arg }`.
 *
 * Splits the arg suffix first (the LAST `.<token>`), then peels the variant
 * markers (`@bp` and/or `:state`) off the remainder. An unknown breakpoint or
 * state is left as part of the base name (caller decides what to do); this
 * matches the DOM behaviour where an invalid `@invalid` / `:invalid` simply
 * never matches a real variant.
 *
 * Examples:
 *   "padding.0"                  -> { base:"padding", breakpoint:null, state:null, arg:"0" }
 *   "padding@md.0"               -> { base:"padding", breakpoint:"md", state:null, arg:"0" }
 *   "backgroundColor:hover.0"    -> { base:"backgroundColor", breakpoint:null, state:"hover", arg:"0" }
 *   "backgroundColor@md:hover.0" -> { base:"backgroundColor", breakpoint:"md", state:"hover", arg:"0" }
 *   "backgroundColor@md:hover"   -> { base:"backgroundColor", breakpoint:"md", state:"hover", arg:null }
 */
export function parseVariantKey(key: string): ParsedVariantKey {
  let work = key;
  let arg: string | null = null;

  // Peel the arg suffix: the segment after the LAST dot, but only if that dot
  // comes AFTER any variant markers (so we never split inside "focus-within"
  // — that has no dot — and never treat "padding" alone as having an arg).
  const lastDot = work.lastIndexOf(".");
  if (lastDot > 0) {
    arg = work.slice(lastDot + 1);
    work = work.slice(0, lastDot);
  }

  // Peel the state marker (":state") off the end of the remainder.
  let state: string | null = null;
  const colon = work.indexOf(":");
  if (colon !== -1) {
    const candidate = work.slice(colon + 1);
    if (VALID_STATE_SET.has(candidate)) {
      state = candidate;
      work = work.slice(0, colon);
    }
  }

  // Peel the breakpoint marker ("@bp").
  let breakpoint: string | null = null;
  const at = work.indexOf("@");
  if (at !== -1) {
    const candidate = work.slice(at + 1);
    if (candidate in BREAKPOINTS) {
      breakpoint = candidate;
      work = work.slice(0, at);
    }
  }

  return { base: work, breakpoint, state, arg };
}

/** The set of interaction states currently active on a node. */
export interface ActiveStates {
  hover?: boolean;
  focus?: boolean;
  active?: boolean;
  disabled?: boolean;
  "focus-visible"?: boolean;
  "focus-within"?: boolean;
}

/**
 * Precedence rank for a parsed variant (higher wins). Combines the breakpoint
 * tier and the state tier into a single sortable number.
 *
 * Precedence (low -> high), later overrides earlier:
 *   base
 *     < breakpoints ascending (sm < md < lg < xl < 2xl)
 *     < disabled < hover < focus < active
 *
 * State always outranks any breakpoint (a `:hover` override beats a `@2xl`
 * sizing override on the same prop), matching the iOS reference where state
 * overrides are merged AFTER the responsive base. Within the same state tier,
 * a higher breakpoint still breaks the tie so `@md:hover` beats `:hover`.
 */
const STATE_RANK: Record<string, number> = {
  disabled: 1,
  hover: 2,
  // focus-visible / focus-within are focus-flavoured states: they share the
  // `focus` precedence slot (NOT base/0) so they outrank hover and lose to
  // active, matching the engine's `state_rank` in portable/variant.rs.
  focus: 3,
  "focus-visible": 3,
  "focus-within": 3,
  active: 4,
};

// State tier must be weighted by a value strictly greater than the largest
// possible breakpoint tier so the bp tiebreak can never leak across state
// bands (mirrors the engine's STATE_STEP > max-breakpoint invariant). Derived
// from BREAKPOINT_ORDER.length so adding breakpoints can't silently break it.
const STATE_WEIGHT = BREAKPOINT_ORDER.length + 1;

function variantRank(breakpoint: string | null, state: string | null): number {
  const bpTier = breakpoint ? BREAKPOINT_ORDER.indexOf(breakpoint) + 1 : 0; // 0..len
  const stateTier = state ? STATE_RANK[state] ?? 0 : 0; // 0..4
  // State tier dominates; breakpoint tier breaks ties within a state tier.
  return stateTier * STATE_WEIGHT + bpTier;
}

/**
 * Is a parsed variant currently applicable, given the viewport width and the
 * active interaction states? A combined key requires BOTH conditions.
 */
function variantApplies(
  parsed: ParsedVariantKey,
  width: number,
  states: ActiveStates,
): boolean {
  if (parsed.breakpoint) {
    const minWidth = BREAKPOINTS[parsed.breakpoint];
    if (minWidth === undefined || width < minWidth) return false;
  }
  if (parsed.state) {
    if (!states[parsed.state as keyof ActiveStates]) return false;
  }
  return true;
}

/**
 * Resolve variant-bearing props against the current viewport width and active
 * interaction states, producing a flat map of `base -> winning value`.
 *
 * Input keys are the already-normalised flat applicator keys (variant markers
 * present, arg suffix already stripped by the applicator-grouping pass), e.g.
 * `{ padding: 8, "padding@md": 16, "backgroundColor:hover": "red" }`.
 *
 * Only bases that actually have at least one applicable variant appear in the
 * result with an overridden value; a base with only its plain entry resolves to
 * that plain value. The caller merges the result over the node's base props.
 */
export function resolveVariantProps(
  props: Record<string, unknown>,
  width: number,
  states: ActiveStates,
): Record<string, unknown> {
  // base -> { value, rank }
  const winners = new Map<string, { value: unknown; rank: number }>();

  for (const key of Object.keys(props)) {
    const parsed = parseVariantKey(key);
    // Only consider entries that carry a variant marker. Plain keys (no bp/state)
    // are the base and are handled implicitly via rank 0 below so a base with a
    // single applicable variant still falls back to base when the variant is off.
    if (!parsed.breakpoint && !parsed.state) {
      // Seed the base value at rank 0 so variant lookups have a fallback and so
      // a base that ALSO has variants resolves correctly when none apply.
      const existing = winners.get(parsed.base);
      if (!existing || existing.rank === 0) {
        winners.set(parsed.base, { value: props[key], rank: 0 });
      }
      continue;
    }

    if (!variantApplies(parsed, width, states)) continue;

    const rank = variantRank(parsed.breakpoint, parsed.state);
    const existing = winners.get(parsed.base);
    if (!existing || rank >= existing.rank) {
      winners.set(parsed.base, { value: props[key], rank });
    }
  }

  const out: Record<string, unknown> = {};
  for (const [base, win] of winners) {
    out[base] = win.value;
  }
  return out;
}

/** True if any key in `props` carries a variant marker (`@bp` or `:state`). */
export function hasVariantProps(props: Record<string, unknown>): boolean {
  for (const key of Object.keys(props)) {
    const parsed = parseVariantKey(key);
    if (parsed.breakpoint || parsed.state) return true;
  }
  return false;
}
