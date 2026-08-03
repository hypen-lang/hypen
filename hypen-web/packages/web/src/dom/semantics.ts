/**
 * Accessibility semantics → DOM.
 *
 * The engine derives a platform-neutral {@link Semantics} block (role, heading
 * level, busy, and in later phases name/state/hidden/…) and ships it on
 * `create` patches. This module is the DOM translation: it maps that block
 * onto ARIA / native HTML.
 *
 * Guiding rule: **let native HTML do the work; never emit a redundant or
 * misplaced role.** Most Hypen components render a semantic native element
 * whose tag already conveys the correct role (`<button>`, `<a>`, `<p>`,
 * `<img>`, `<input>`, `<select>`, `<textarea>`, `<h1>`–`<h6>`). Some render a
 * wrapper around the real control (`Checkbox`/`Switch` are a `<label>` around a
 * nested `<input>`), where putting the role on the wrapper would be flat wrong.
 *
 * So we only apply an explicit `role` when the host is a *generic* container
 * (`<div>`/`<span>`) that conveys nothing on its own — which is exactly the
 * handful of cases that need it (`Spinner`, `ProgressBar`). Everywhere else the
 * native element is already correct, and the {@link Semantics} block still
 * travels to the non-DOM renderers (Canvas shadow, iOS, Android) that lack
 * native semantics.
 */

import type { Semantics } from "@hypen-space/core/types";

/**
 * The implicit ARIA role each native host tag already conveys. An engine
 * role equal to the implicit one is never applied (redundant-role smell:
 * `role="button"` on `<button>`), but a *different* engine role is an
 * intentional override and IS applied — `role="tab"` on a `<button>` host,
 * `role="combobox"` on an `<input>` (the ARIA 1.2 combobox pattern).
 *
 * `LABEL` is special-cased below: it never takes a role at all, because
 * Checkbox/Switch render a `<label>` *wrapper* whose role belongs to the
 * nested `<input>` — putting it on the wrapper would be flat wrong.
 */
const IMPLICIT_ROLE: Record<string, string> = {
  A: "link",
  P: "paragraph",
  IMG: "img",
  INPUT: "textbox",
  TEXTAREA: "textbox",
  SELECT: "listbox",
  BUTTON: "button",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
};

/**
 * Attributes this module set on an element on its previous pass, so a
 * re-apply (a reactive `setSemantics` patch) can clear exactly what it — and
 * only it — owns. Tracking per element instead of blanket-removing every
 * possible ARIA attribute keeps the `.aria()` escape hatch's attributes (and
 * anything else outside this module) untouched.
 */
const appliedAttrs = new WeakMap<HTMLElement, string[]>();

/**
 * Apply derived accessibility semantics to a DOM element.
 *
 * Called at create (first paint) and again on every `setSemantics` patch
 * with the node's complete re-resolved block. Idempotent, and **clearing**:
 * an attribute this module set on a previous pass that the new block no
 * longer produces is removed (a name reverting from explicit to derived
 * must drop its stale `aria-label`, a cleared `.expanded` its
 * `aria-expanded`). No-op when `semantics` was never present, so
 * non-semantic nodes pay nothing.
 */
export function applySemantics(element: HTMLElement, semantics?: Semantics): void {
  if (!semantics && !appliedAttrs.has(element)) return;

  // Everything this pass wants set, collected first so the diff against the
  // previous pass is a plain list comparison.
  const next: Array<[string, string]> = [];

  if (semantics) {
    if (semantics.hidden) {
      // Decorative: remove from the accessibility tree entirely. Nothing
      // else applies once hidden.
      next.push(["aria-hidden", "true"]);
    } else {
      // tagName is uppercase in real DOM; normalize so the lookup is robust
      // against test doubles that preserve the as-created case.
      const tag = element.tagName?.toUpperCase();

      if (
        semantics.role &&
        tag !== "LABEL" &&
        IMPLICIT_ROLE[tag] !== semantics.role
      ) {
        // Applied when the host conveys nothing (div/span) or when the
        // engine role intentionally overrides the tag's implicit role
        // (`role="tab"` on a <button>). Skipped when redundant, and always
        // skipped on <label> wrappers (the role belongs to the nested input).
        next.push(["role", semantics.role]);
      }

      // An explicit author label overrides visible content, so it is applied
      // as aria-label even on native elements. A *derived* name is
      // deliberately not applied — the browser already exposes it from the
      // visible content.
      if (semantics.nameExplicit && semantics.name) {
        next.push(["aria-label", semantics.name]);
      }

      if (semantics.description) {
        next.push(["aria-description", semantics.description]);
      }

      // Self-state relationship attributes.
      if (semantics.expanded !== undefined) {
        next.push(["aria-expanded", String(semantics.expanded)]);
      }
      if (semantics.pressed !== undefined) {
        next.push(["aria-pressed", String(semantics.pressed)]);
      }
      if (semantics.selected !== undefined) {
        next.push(["aria-selected", String(semantics.selected)]);
      }
      if (semantics.current) {
        next.push(["aria-current", semantics.current]);
      }
      if (semantics.checked !== undefined) {
        next.push(["aria-checked", String(semantics.checked)]);
      }
      if (semantics.invalid !== undefined) {
        // Reactive form validity — kept live via `setSemantics` re-emits;
        // clearing (block drops the field) removes the attribute below.
        next.push(["aria-invalid", String(semantics.invalid)]);
      }

      // Cross-node relationships by author-supplied id. DOM-only /
      // web-leaning: these id-reference relationships have no equivalent in
      // the string-hint native accessibility APIs, so they do not travel to
      // Canvas / iOS / Android. See the guide's "Platform support" section
      // (hypen-docs/content/docs/guide/accessibility.mdx).
      if (semantics.id) {
        // The anchor the references below resolve against — a real DOM id.
        next.push(["id", semantics.id]);
      }
      if (semantics.dir) {
        // Base text direction → the native HTML dir attribute (not ARIA).
        // Managed like `id`: cleared when a later block drops it.
        next.push(["dir", semantics.dir]);
      }
      if (semantics.controls) {
        next.push(["aria-controls", semantics.controls]);
      }
      if (semantics.describedby) {
        next.push(["aria-describedby", semantics.describedby]);
      }
      if (semantics.labelledby) {
        next.push(["aria-labelledby", semantics.labelledby]);
      }
      if (semantics.activeDescendant) {
        // Reactive roving-focus pointer — arrives initially on `create` and
        // stays live via `setSemantics` re-emits as the bound state changes.
        next.push(["aria-activedescendant", semantics.activeDescendant]);
      }
      if (semantics.owns) {
        next.push(["aria-owns", semantics.owns]);
      }

      if (semantics.busy) {
        next.push(["aria-busy", "true"]);
      }

      if (semantics.live) {
        // Live-region politeness — engine-validated ("polite" | "assertive").
        next.push(["aria-live", semantics.live]);
      }
    }
  }

  // Clear what the previous pass set but this one doesn't.
  const previous = appliedAttrs.get(element);
  if (previous) {
    const keep = new Set(next.map(([name]) => name));
    for (const name of previous) {
      if (!keep.has(name)) {
        element.removeAttribute(name);
      }
    }
  }

  for (const [name, value] of next) {
    element.setAttribute(name, value);
  }

  if (next.length > 0) {
    appliedAttrs.set(element, next.map(([name]) => name));
  } else {
    appliedAttrs.delete(element);
  }
}
