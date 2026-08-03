/**
 * DOM a11y polish: the `.aria(key, value)` escape hatch sets `aria-*`
 * attributes directly, and the global a11y stylesheet (reduced-motion +
 * focus-visible) is injected idempotently.
 *
 * `.aria` is web-only / non-portable — see `dom/applicators/aria.ts`.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { ApplicatorRegistry } from "../packages/web/src/dom/applicators";
import { ensureA11yStyles } from "../packages/web/src/dom/a11y-styles";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

describe(".aria applicator", () => {
  let registry: ApplicatorRegistry;
  let element: FakeElement;

  beforeEach(() => {
    registry = new ApplicatorRegistry();
    element = document.createElement("div") as unknown as FakeElement;
  });

  test("two-arg .aria(key, value) sets aria-<key>", () => {
    // `.aria("expanded", "true")` arrives grouped as { "0": key, "1": value }.
    registry.apply(element as unknown as HTMLElement, "aria", { "0": "expanded", "1": "true" });
    expect(element.attributes["aria-expanded"]).toBe("true");
  });

  test("non-string values are stringified", () => {
    registry.apply(element as unknown as HTMLElement, "aria", { "0": "level", "1": 2 });
    expect(element.attributes["aria-level"]).toBe("2");
  });

  test("single positional arg sets the attribute with an empty value", () => {
    registry.apply(element as unknown as HTMLElement, "aria", "busy");
    expect(element.attributes["aria-busy"]).toBe("");
  });

  test("missing key is a no-op", () => {
    registry.apply(element as unknown as HTMLElement, "aria", { "1": "true" });
    expect("aria-undefined" in element.attributes).toBe(false);
  });
});

describe("ensureA11yStyles", () => {
  test("runs without throwing and injects a single guarded <style>", () => {
    ensureFakeDomGlobals();
    const head = document.head as unknown as FakeElement;

    const before = head.children.length;
    ensureA11yStyles();
    const afterFirst = head.children.length;

    // A style node was appended.
    expect(afterFirst).toBe(before + 1);
    const styleNode = head.children[head.children.length - 1];
    expect(styleNode.tagName.toUpperCase()).toBe("STYLE");
    expect(styleNode.id).toBe("hypen-a11y-styles");

    // Idempotent: a second call does not add another node.
    ensureA11yStyles();
    expect(head.children.length).toBe(afterFirst);
  });

  test("no-ops when document is unavailable", () => {
    const globalObj = globalThis as any;
    const savedDoc = globalObj.document;
    globalObj.document = undefined;
    try {
      expect(() => ensureA11yStyles()).not.toThrow();
    } finally {
      globalObj.document = savedDoc;
    }
  });
});
