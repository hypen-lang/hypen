/**
 * Safe area insets — shared between the DOM and Canvas renderers.
 *
 * The `SafeArea` component (a primitive in the engine's `DEFAULT_PRIMITIVES`)
 * is a full-size vertical container that pads its content by the platform's
 * safe-area inset on each selected edge, so content clears notches, rounded
 * corners, home indicators and browser UI.
 *
 * Two renderers, two ways of getting at the same numbers:
 *   - DOM   → hands the browser `env(safe-area-inset-*, 0px)` as padding, so
 *             the value stays live across rotation/keyboard/UI changes.
 *   - Canvas → paints its own pixels, so it needs the resolved NUMBER; it
 *             probes `env(safe-area-inset-*)` once through a throwaway
 *             element (see {@link probeSafeAreaInsets}).
 *
 * Both accept the same embedder override: a per-edge partial that merges over
 * the platform default (`{ bottom: 0 }` zeroes only the bottom edge).
 */

/** The four edges a `SafeArea` can pad. */
export type SafeAreaEdge = "top" | "right" | "bottom" | "left";

/** Canonical, fully-resolved insets in CSS pixels. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Embedder-supplied override. Every edge is optional and merges OVER the
 * platform default. The DOM renderer additionally accepts any CSS length
 * string (`"1rem"`, `"env(safe-area-inset-top)"`), since it hands the value
 * straight to CSS; the Canvas renderer resolves strings numerically and so
 * only understands plain px-ish values.
 */
export type SafeAreaInsetOverrides = Partial<Record<SafeAreaEdge, number | string>>;

/** Iteration order for the edges — also the default edge set. */
export const SAFE_AREA_EDGES: readonly SafeAreaEdge[] = ["top", "right", "bottom", "left"];

const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Normalise the `edges` prop into the set of edges to pad.
 *
 * Missing / empty / unparseable → all four edges. Unknown entries are
 * ignored, so `edges: ["top", "diagonal"]` pads the top only — and an
 * explicit non-empty list is honored literally, so a list naming only
 * unknown edges pads nothing rather than silently widening back to all four
 * (same contract as the Swift, Android, and desktop renderers). Accepts a
 * real array (the usual channel for a DSL list prop), a JSON array string,
 * or a comma/space separated string — renderers see whichever of those the
 * host serialisation produced.
 */
export function resolveSafeAreaEdges(value: unknown): Set<SafeAreaEdge> {
  const all = new Set<SafeAreaEdge>(SAFE_AREA_EDGES);
  if (value === undefined || value === null) return all;

  let list: unknown[] | null = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return all;
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = null;
      }
    }
    if (list === null) list = trimmed.split(/[,\s]+/);
  }
  if (list === null) return all;

  const edges = new Set<SafeAreaEdge>();
  let candidates = false;
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const edge = entry.trim().toLowerCase();
    if (edge === "") continue;
    candidates = true;
    if ((SAFE_AREA_EDGES as readonly string[]).includes(edge)) {
      edges.add(edge as SafeAreaEdge);
    }
  }
  return candidates ? edges : all;
}

/** The CSS the DOM renderer uses for an edge's platform default. */
export function safeAreaEnvValue(edge: SafeAreaEdge): string {
  return `env(safe-area-inset-${edge}, 0px)`;
}

/**
 * The CSS length for one edge: the embedder's override when it supplied one
 * for that edge, otherwise the browser's own `env()` value.
 */
export function safeAreaCssValue(
  edge: SafeAreaEdge,
  overrides?: SafeAreaInsetOverrides | null,
): string {
  const custom = overrides?.[edge];
  if (custom === undefined || custom === null) return safeAreaEnvValue(edge);
  return typeof custom === "number" ? `${custom}px` : String(custom);
}

let probedInsets: SafeAreaInsets | null = null;

/**
 * Measure `env(safe-area-inset-*)` once, by parking a hidden element with
 * those values as padding and reading the computed style back. Returns zeros
 * outside a browser (test runners, SSR) and on any browser that doesn't
 * understand `env()` — an unsupported `env()` without a fallback simply makes
 * the declaration invalid, which computes to `0px`.
 */
export function probeSafeAreaInsets(): SafeAreaInsets {
  if (probedInsets) return probedInsets;

  probedInsets = { ...ZERO_INSETS };
  try {
    if (
      typeof document === "undefined" ||
      typeof globalThis.getComputedStyle !== "function" ||
      !document.body
    ) {
      return probedInsets;
    }

    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.top = "0";
    probe.style.left = "0";
    probe.style.width = "0";
    probe.style.height = "0";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    for (const edge of SAFE_AREA_EDGES) {
      probe.style.setProperty(`padding-${edge}`, safeAreaEnvValue(edge));
    }

    document.body.appendChild(probe);
    const computed = globalThis.getComputedStyle(probe);
    const measured: SafeAreaInsets = { ...ZERO_INSETS };
    for (const edge of SAFE_AREA_EDGES) {
      const raw = parseFloat(computed.getPropertyValue(`padding-${edge}`));
      measured[edge] = Number.isFinite(raw) ? raw : 0;
    }
    probe.remove();
    probedInsets = measured;
  } catch {
    // Any DOM shim that can't service the probe leaves the zeros in place.
    probedInsets = { ...ZERO_INSETS };
  }
  return probedInsets;
}

/** Test seam: forget the cached probe so the next read measures again. */
export function resetSafeAreaProbe(): void {
  probedInsets = null;
}

let insetOverrides: SafeAreaInsetOverrides | null = null;

/**
 * Publish the embedder's per-edge overrides for the numeric (Canvas) path.
 *
 * Module-level like `setCssViewport`: the Canvas layout functions are free
 * functions, and the renderer re-stamps this immediately before every layout
 * pass, so two canvases with different overrides on one page each lay out
 * against their own values.
 */
export function setSafeAreaInsetOverrides(overrides?: SafeAreaInsetOverrides | null): void {
  insetOverrides = overrides ?? null;
}

/** Coerce an override value to px; unparseable values fall back to the default. */
function overrideToPx(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Resolved insets for the numeric (Canvas) path: the embedder's overrides
 * merged over the probed platform defaults, per edge.
 */
export function getEffectiveSafeAreaInsets(): SafeAreaInsets {
  const defaults = probeSafeAreaInsets();
  if (!insetOverrides) return defaults;
  return {
    top: overrideToPx(insetOverrides.top, defaults.top),
    right: overrideToPx(insetOverrides.right, defaults.right),
    bottom: overrideToPx(insetOverrides.bottom, defaults.bottom),
    left: overrideToPx(insetOverrides.left, defaults.left),
  };
}
