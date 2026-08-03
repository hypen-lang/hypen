/**
 * RTL/direction + forced-colors accessibility hooks in the DOM renderer:
 *
 *  - `Semantics.dir` (from the `.dir("rtl"|"ltr"|"auto")` applicator) maps to
 *    the native HTML `dir` attribute, managed like `id` (cleared when a later
 *    `setSemantics` block drops it); and
 *  - the global a11y stylesheet carries a `forced-colors: active` block that
 *    pins the focus indicator to outline (box-shadow is stripped in forced
 *    colors) and a `prefers-contrast: more` block that strengthens it.
 */

import { describe, expect, test } from "bun:test";
import { applySemantics } from "../packages/web/src/dom/semantics";
import { ensureA11yStyles } from "../packages/web/src/dom/a11y-styles";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

const el = (tag = "div"): FakeElement =>
  document.createElement(tag) as unknown as FakeElement;

describe("Semantics.dir → HTML dir attribute", () => {
  test("dir is applied as the native dir attribute", () => {
    const node = el();
    applySemantics(node as unknown as HTMLElement, { dir: "rtl" });
    expect(node.attributes["dir"]).toBe("rtl");
  });

  test("dir travels alongside other semantics", () => {
    const node = el();
    applySemantics(node as unknown as HTMLElement, {
      role: "navigation",
      dir: "rtl",
    });
    expect(node.attributes["role"]).toBe("navigation");
    expect(node.attributes["dir"]).toBe("rtl");
  });

  test("a re-apply that drops dir clears the attribute (managed)", () => {
    const node = el();
    applySemantics(node as unknown as HTMLElement, { dir: "rtl" });
    expect(node.attributes["dir"]).toBe("rtl");

    // The next resolved block no longer carries dir — the renderer must
    // clear exactly what it set, like the other managed attributes.
    applySemantics(node as unknown as HTMLElement, {});
    expect("dir" in node.attributes).toBe(false);
  });

  test("dir updates in place on a re-apply", () => {
    const node = el();
    applySemantics(node as unknown as HTMLElement, { dir: "rtl" });
    applySemantics(node as unknown as HTMLElement, { dir: "ltr" });
    expect(node.attributes["dir"]).toBe("ltr");
  });
});

describe("a11y stylesheet forced-colors / contrast blocks", () => {
  /** The injected stylesheet's CSS, regardless of which test injected it
   *  first (ensureA11yStyles is idempotent across the shared fake DOM). */
  const injectedCss = (): string => {
    ensureA11yStyles();
    const head = document.head as unknown as FakeElement;
    const style = head.children.find((c) => c.id === "hypen-a11y-styles");
    expect(style).toBeDefined();
    return style!.textContent ?? "";
  };

  test("forced-colors block keeps focus on outline, not box-shadow", () => {
    const css = injectedCss();
    const block = css.split("@media (forced-colors: active)")[1];
    expect(block).toBeDefined();
    // Outline survives forced colors; box-shadow does not — the focus
    // indicator must be outline-based there.
    expect(block).toContain(":focus-visible");
    expect(block).toContain("outline: 2px solid Highlight");
    expect(block).toContain("box-shadow: none");
  });

  test("prefers-contrast: more strengthens the focus outline", () => {
    const css = injectedCss();
    const block = css.split("@media (prefers-contrast: more)")[1];
    expect(block).toBeDefined();
    expect(block).toContain(":focus-visible");
    expect(block).toContain("outline-width: 3px");
  });
});
