/**
 * `.liveRegion(...)` → `aria-live` on both web renderers.
 *
 * The engine validates the token ("polite" | "assertive") and ships it as
 * `Semantics.live`; the DOM renderer applies it in `applySemantics`'s managed
 * attribute list (so a reactive `setSemantics` that drops the field clears
 * the attribute), and the Canvas shadow tree mirrors it in
 * `applyShadowSemantics`.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { applyShadowSemantics } from "../packages/web/src/canvas/accessibility";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const makeRenderer = () => {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  return { container, renderer };
};

const attrs = (node: unknown): Record<string, string> =>
  (node as { attributes?: Record<string, string> }).attributes ?? {};

describe("DOM renderer live regions", () => {
  test("semantics.live applies aria-live on a generic host", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "s1",
        elementType: "Column",
        props: {},
        semantics: { live: "polite" },
      } as Patch,
    ]);

    expect(attrs(renderer.getNode("s1"))["aria-live"]).toBe("polite");
  });

  test("assertive travels unchanged", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "s2",
        elementType: "Column",
        props: {},
        semantics: { live: "assertive" },
      } as Patch,
    ]);

    expect(attrs(renderer.getNode("s2"))["aria-live"]).toBe("assertive");
  });

  test("a setSemantics that drops live clears the attribute", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "s3",
        elementType: "Column",
        props: {},
        semantics: { live: "polite" },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("s3"))["aria-live"]).toBe("polite");

    renderer.applyPatches([
      { type: "setSemantics", id: "s3", semantics: {} } as Patch,
    ]);
    expect("aria-live" in attrs(renderer.getNode("s3"))).toBe(false);
  });

  test("live composes with the rest of the block", () => {
    const { renderer } = makeRenderer();

    // A status region (Spinner-style) still gets its role and busy alongside.
    renderer.applyPatches([
      {
        type: "create",
        id: "s4",
        elementType: "Column",
        props: {},
        semantics: { role: "status", busy: true, live: "polite" },
      } as Patch,
    ]);

    const a = attrs(renderer.getNode("s4"));
    expect(a.role).toBe("status");
    expect(a["aria-busy"]).toBe("true");
    expect(a["aria-live"]).toBe("polite");
  });

  test("the synthetic __a11yName prop is dropped, not rendered", () => {
    const { renderer } = makeRenderer();

    // Current engines strip the child-template name carrier before emission;
    // defence-in-depth for older engines that still send it as an unknown
    // prop — renderers must treat it as inert (no attribute, no style).
    renderer.applyPatches([
      {
        type: "create",
        id: "b1",
        elementType: "Button",
        props: { __a11yName: "Save 3" },
        semantics: { role: "button", name: "Save 3" },
      } as Patch,
    ]);

    const a = attrs(renderer.getNode("b1"));
    expect(a["__a11yName"]).toBeUndefined();
    // Derived (non-explicit) name: no aria-label either — visible text wins.
    expect(a["aria-label"]).toBeUndefined();
  });
});

describe("Canvas shadow tree live regions", () => {
  test("applyShadowSemantics sets and clears aria-live", () => {
    const el = document.createElement("div") as unknown as HTMLElement;

    applyShadowSemantics(el, { live: "assertive" });
    expect(attrs(el)["aria-live"]).toBe("assertive");

    applyShadowSemantics(el, {});
    expect("aria-live" in attrs(el)).toBe(false);
  });
});
