/**
 * Helpers shared by the renderer-resident gesture runtimes (`scrub.ts`,
 * `dnd.ts`): transform-string surgery, subtree tests that survive fake-dom
 * and detached subtrees, pointer-capture wrappers, and the Map→plain
 * normalization the core parsers expect. Pure functions, no state.
 */

/** The pointer-event surface the gesture runtimes read (fake-dom friendly). */
export interface PointerEventLike {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
  button?: number;
  target?: unknown;
  preventDefault?: () => void;
}

/** Match one `fn(args)` term of a CSS transform string. */
const TRANSFORM_TERM = /[a-zA-Z][a-zA-Z0-9]*\([^)]*\)/g;

/**
 * Remove the transform functions named in `fns` from a CSS transform
 * string, keeping everything else in order. Used to compose a gesture's
 * transform lanes with the element's static base transform (the base minus
 * the gesture-owned kinds is prepended), and to restore the base minus the
 * kinds a deferred engine write is about to re-append.
 */
export function stripTransformFns(transform: string, fns: ReadonlySet<string>): string {
  if (!transform || fns.size === 0) return transform;
  const parts = transform.match(TRANSFORM_TERM);
  if (!parts) return transform;
  return parts.filter((part) => !fns.has(part.slice(0, part.indexOf("(")))).join(" ");
}

/**
 * Replace the `fn(...)` term of a transform string IN PLACE (first
 * occurrence; later duplicates are dropped), or append it when absent.
 * This is the re-resolution contract for the transform applicators: a
 * `translateX.0` SetProp that follows a create-time `translateX.0` must
 * update the existing term, not accumulate a second one, and must keep the
 * author's function order (`translateX(…) rotate(…)` stays that way).
 */
export function composeTransformFn(transform: string, fn: string, term: string): string {
  const parts = transform ? transform.match(TRANSFORM_TERM) : null;
  if (!parts) {
    // No function terms to compose with: `""`/`none` are replaced outright.
    return transform && transform.trim() !== "none" ? `${transform} ${term}` : term;
  }
  let replaced = false;
  const next: string[] = [];
  for (const part of parts) {
    if (part.slice(0, part.indexOf("(")) === fn) {
      if (!replaced) {
        next.push(term);
        replaced = true;
      }
      continue;
    }
    next.push(part);
  }
  if (!replaced) next.push(term);
  return next.join(" ");
}

/**
 * Is `element` a strict descendant of `root`? Walks `parentNode` links —
 * fake-dom (tests) has no `closest`, and detached subtrees keep their
 * internal links.
 */
export function isWithinSubtree(element: HTMLElement, root: HTMLElement): boolean {
  let node: unknown = (element as { parentNode?: unknown }).parentNode ?? null;
  while (node) {
    if (node === root) return true;
    node = (node as { parentNode?: unknown }).parentNode ?? null;
  }
  return false;
}

/** Number of `parentNode` hops from `element` to the top of its tree. */
export function subtreeDepth(element: HTMLElement): number {
  let depth = 0;
  let node: unknown = (element as { parentNode?: unknown }).parentNode ?? null;
  while (node) {
    depth += 1;
    node = (node as { parentNode?: unknown }).parentNode ?? null;
  }
  return depth;
}

/** Best-effort `setPointerCapture` (the pointer may already be gone). */
export function capturePointer(element: HTMLElement, pointerId: number | null): void {
  const el = element as HTMLElement & { setPointerCapture?: (pointerId: number) => void };
  if (pointerId === null || typeof el.setPointerCapture !== "function") return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Capture is best-effort.
  }
}

/** Best-effort `releasePointerCapture` (already released, or off-document). */
export function releasePointer(element: HTMLElement, pointerId: number | null): void {
  const el = element as HTMLElement & { releasePointerCapture?: (pointerId: number) => void };
  if (pointerId === null || typeof el.releasePointerCapture !== "function") return;
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // Already released (e.g. the element left the document).
  }
}

/** Trim interpolation noise: 3 decimal places is sub-pixel on any display. */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * WASM patches deliver nested prop values as Maps; the core parsers expect
 * plain objects. Normalize before parsing (DomAnimator parity).
 */
export function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      obj[String(key)] = toPlain(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  return value;
}
