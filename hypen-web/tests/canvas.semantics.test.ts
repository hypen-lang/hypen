/**
 * Canvas accessibility: the off-screen shadow tree is driven by the
 * engine-derived Semantics block (the same block the DOM renderer consumes),
 * not by ad-hoc prop sniffing.
 *
 * Canvas has no native accessibility tree, so unlike the DOM renderer it must
 * apply *every* derived name (the painted text is invisible to AT).
 */

import { describe, expect, test } from "bun:test";
import { applyShadowSemantics } from "../packages/web/src/canvas/accessibility";
import type { Semantics } from "../packages/core/src/types";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

const el = (tag: string) => document.createElement(tag);
const attrs = (e: { attributes?: Record<string, string> }) => e.attributes ?? {};

describe("canvas applyShadowSemantics", () => {
  test("applies a derived name as aria-label (canvas text is invisible to AT)", () => {
    const button = el("button");
    applyShadowSemantics(button as any, { role: "button", name: "Save" } as Semantics);
    // Note: unlike the DOM renderer, a *derived* name IS applied here.
    expect(attrs(button)["aria-label"]).toBe("Save");
  });

  test("applies an explicit name too", () => {
    const button = el("button");
    applyShadowSemantics(button as any, {
      role: "button",
      name: "Delete",
      nameExplicit: true,
    } as Semantics);
    expect(attrs(button)["aria-label"]).toBe("Delete");
  });

  test("sets a role only on generic shadow hosts, not native tags", () => {
    const div = el("div");
    applyShadowSemantics(div as any, { role: "status", busy: true } as Semantics);
    expect(attrs(div).role).toBe("status");
    expect(attrs(div)["aria-busy"]).toBe("true");

    const button = el("button");
    applyShadowSemantics(button as any, { role: "button" } as Semantics);
    expect("role" in attrs(button)).toBe(false);
  });

  test("applies a description as aria-description", () => {
    const div = el("div");
    applyShadowSemantics(div as any, {
      role: "status",
      description: "Loading results",
    } as Semantics);
    expect(attrs(div)["aria-description"]).toBe("Loading results");
  });

  test("applies a bound checked state as aria-checked", () => {
    const checked = el("div");
    applyShadowSemantics(checked as any, { role: "checkbox", checked: true } as Semantics);
    expect(attrs(checked)["aria-checked"]).toBe("true");

    const unchecked = el("div");
    applyShadowSemantics(unchecked as any, { role: "switch", checked: false } as Semantics);
    expect(attrs(unchecked)["aria-checked"]).toBe("false");
  });

  test("no semantics is a no-op", () => {
    const div = el("div");
    applyShadowSemantics(div as any, undefined);
    expect(Object.keys(attrs(div)).length).toBe(0);
  });
});

describe("canvas reactive semantics re-apply", () => {
  test("re-applying with a changed name updates aria-label", () => {
    const button = el("button");
    applyShadowSemantics(button as any, { role: "button", name: "Save" } as Semantics);
    expect(attrs(button)["aria-label"]).toBe("Save");

    applyShadowSemantics(button as any, { role: "button", name: "Submit" } as Semantics);
    expect(attrs(button)["aria-label"]).toBe("Submit");
  });

  test("a dropped field removes its attribute (clearing path)", () => {
    const div = el("div");
    applyShadowSemantics(div as any, {
      role: "button",
      name: "Menu",
      expanded: true,
    } as Semantics);
    expect(attrs(div)["aria-expanded"]).toBe("true");

    applyShadowSemantics(div as any, { role: "button", name: "Menu" } as Semantics);
    expect("aria-expanded" in attrs(div)).toBe(false);
    expect(attrs(div)["aria-label"]).toBe("Menu");
  });

  test("clearing the whole block removes every applied attribute", () => {
    const div = el("div");
    applyShadowSemantics(div as any, { role: "status", busy: true } as Semantics);
    expect(attrs(div).role).toBe("status");

    applyShadowSemantics(div as any, undefined);
    expect("role" in attrs(div)).toBe(false);
    expect("aria-busy" in attrs(div)).toBe(false);
  });
});
