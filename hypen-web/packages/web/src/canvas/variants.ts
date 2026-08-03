/**
 * Canvas variant application.
 *
 * The Canvas renderer reads winning values directly off `node.props.<base>`
 * (e.g. `props.padding`, `props.backgroundColor`) in both layout.ts and
 * paint.ts. To support responsive breakpoints and interaction-state variants
 * WITHOUT rewriting every call site, we resolve variant keys once per frame
 * (just before layout) and stamp the winning value onto the base key.
 *
 * Resolution itself is delegated to the shared, renderer-agnostic helper in
 * `../variants.ts`, so breakpoint pixels, state names, and precedence stay
 * byte-compatible with the DOM renderer.
 *
 * Per-node bookkeeping (`variantBases`, `variantOriginals`) lives on the
 * VirtualNode so each frame:
 *   1. restores the original (variant-free) base value, then
 *   2. re-applies the current winner for the present width + active states.
 * This makes the pass idempotent and reversible — when a hover ends or the
 * canvas shrinks below a breakpoint, the base value comes back automatically.
 */

import type { VirtualNode } from "./types.js";
import {
  resolveVariantProps,
  parseVariantKey,
  type ActiveStates,
} from "../variants.js";

/**
 * Lazily compute (and cache) the set of applicator base names on this node that
 * carry at least one variant key. Returns the cached set on subsequent calls.
 *
 * The cache is invalidated by `invalidateVariantCache`, called from the
 * renderer whenever a SetProp/RemoveProp changes the node's prop keys.
 */
function getVariantBases(node: VirtualNode): Set<string> {
  if (node.variantBases != null) return node.variantBases;
  const bases = new Set<string>();
  for (const key of Object.keys(node.props)) {
    const parsed = parseVariantKey(key);
    if (parsed.breakpoint || parsed.state) bases.add(parsed.base);
  }
  node.variantBases = bases;
  return bases;
}

/**
 * Drop the cached variant state so it is recomputed on the next frame.
 * Call after any prop mutation that may add/remove variant keys.
 *
 * Also drops the `variantOriginals` snapshot: a SetProp can change the *base*
 * value of a base that carries a variant (e.g. `padding.0` updated while
 * `padding@md.0` exists). The snapshot was taken from the previous frame's
 * props, so restoring it would clobber the engine's new base value with the
 * stale one whenever the variant isn't currently active. Clearing it forces the
 * next frame to re-snapshot from the current (post-SetProp) props.
 */
export function invalidateVariantCache(node: VirtualNode): void {
  node.variantBases = null;
  node.variantOriginals = undefined;
}

/**
 * Derive the active interaction states for a node from its tracked flags and
 * props, mirroring the DOM/CSS pseudo-class semantics:
 *   - hover    : pointer is over the node (or a child resolved to it)
 *   - focus    : node holds canvas focus
 *   - active   : pointer is currently pressed on the node
 *   - disabled : node opts out via `disabled`/`enabled:false`
 */
function activeStatesFor(node: VirtualNode): ActiveStates {
  const disabled =
    node.props.disabled === true ||
    node.props.disabled === "true" ||
    node.props.enabled === false ||
    node.props.enabled === "false";
  return {
    hover: !!node.hovered,
    focus: !!node.focused,
    active: !!node.pressed,
    disabled,
  };
}

/**
 * Resolve and apply variant overrides for a single node, in place.
 *
 * No-op for nodes without any variant keys (the common case), so the per-frame
 * cost on a plain tree is one cached set lookup per node.
 */
function applyVariantsToNode(node: VirtualNode, width: number): void {
  const bases = getVariantBases(node);
  if (bases.size === 0) return;

  // Restore originals from the previous frame so we resolve from a clean base.
  if (node.variantOriginals) {
    for (const base of bases) {
      const orig = node.variantOriginals[base];
      if (orig === undefined) {
        // The base had no plain value originally — remove any override we wrote.
        delete node.props[base];
      } else {
        node.props[base] = orig;
      }
    }
  }

  const resolved = resolveVariantProps(
    node.props as Record<string, unknown>,
    width,
    activeStatesFor(node),
  );

  // Capture originals (once we know which bases are involved) and apply winners.
  const originals: Record<string, unknown> = {};
  for (const base of bases) {
    originals[base] = node.props[base];
  }
  node.variantOriginals = originals;

  for (const base of bases) {
    if (base in resolved) {
      node.props[base] = resolved[base];
    }
  }
}

/**
 * Walk the tree from `root` and apply variant overrides to every node using
 * `width` (the canvas/content width) as the viewport for breakpoint matching.
 * Called once per frame before layout.
 */
export function applyVariants(root: VirtualNode, width: number): void {
  applyVariantsToNode(root, width);
  for (const child of root.children) {
    applyVariants(child, width);
  }
}

/**
 * Re-derive a node's cached computed fields (`visible`, `opacity`) from its
 * current `props`. These are read on the hot paint/hit-test path, so they are
 * cached on the node — but {@link applyVariants} can rewrite the underlying
 * props (`visible@md`, `opacity:disabled`) after the create/setProp caches were
 * set, so this must run after every variant pass or the cache goes stale.
 * Single source of truth so the create / setProp / post-variant sites can't
 * drift apart.
 */
export function deriveNodeComputed(node: VirtualNode): void {
  const o = parseFloat(node.props.opacity as string);
  node.opacity = Number.isFinite(o) ? o : 1;
  node.visible = node.props.visible === undefined ? true : !!node.props.visible;
}
