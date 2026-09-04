/**
 * Named-key resolution shared by the padding and margin applicators.
 *
 * `.padding(horizontal: 16, vertical: 8)` is documented
 * (hypen-docs/content/docs/hypen/applicators.mdx) and both native renderers
 * resolve it, but the web renderers used to test only top/right/bottom/left.
 * An object carrying just `horizontal`/`vertical` therefore fell through to
 * the positional branch, which finds no "0" key and applies nothing at all —
 * a silent no-op rather than a partial result.
 *
 * The logical keys (`start`/`end`, `leading`/`trailing`) map to CSS's own
 * inline properties rather than being flattened to left/right, so they stay
 * direction-aware under `dir="rtl"`.
 */

/** Every key this resolver understands, for the "is this the named form?" test. */
export const SPACING_NAMED_KEYS = [
  "top",
  "bottom",
  "left",
  "right",
  "horizontal",
  "vertical",
  "start",
  "end",
  "leading",
  "trailing",
] as const;

export interface ResolvedSpacing {
  top?: any;
  bottom?: any;
  left?: any;
  right?: any;
  /** Direction-aware; emitted as `*-inline-start`. */
  inlineStart?: any;
  /** Direction-aware; emitted as `*-inline-end`. */
  inlineEnd?: any;
}

export const hasSpacingNamedKey = (value: Record<string, any>): boolean =>
  SPACING_NAMED_KEYS.some((k) => value[k] !== undefined);

/**
 * Resolve the named form to concrete edges.
 *
 * Axis keys are the fallback for their edges, matching Swift
 * (`SpacingApplicators.swift`): an explicit `top` beats `vertical`.
 */
export function resolveSpacingKeys(value: Record<string, any>): ResolvedSpacing {
  const pick = (...keys: string[]): any => {
    for (const k of keys) {
      if (value[k] !== undefined) return value[k];
    }
    return undefined;
  };

  return {
    top: pick("top", "vertical"),
    bottom: pick("bottom", "vertical"),
    left: pick("left", "horizontal"),
    right: pick("right", "horizontal"),
    inlineStart: pick("leading", "start"),
    inlineEnd: pick("trailing", "end"),
  };
}
