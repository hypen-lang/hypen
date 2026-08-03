/**
 * Phase 0 accessibility: the DOM renderer applies engine-derived semantics
 * from `create` patches, and does so without emitting redundant ARIA roles.
 *
 * See `hypen-docs/content/docs/guide/accessibility.mdx`.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
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

describe("DOMRenderer accessibility semantics", () => {
  test("native <button> does not get a redundant role attribute", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "b1",
        elementType: "Button",
        props: {},
        semantics: { role: "button" },
      } as Patch,
    ]);

    const node = renderer.getNode("b1");
    expect(node).toBeDefined();
    // Button renders a native <button>, whose implicit role is already
    // "button" — applying role="button" would be a redundant-role smell.
    expect("role" in attrs(node)).toBe(false);
  });

  test("role is set explicitly when the host tag does not imply it", () => {
    const { renderer } = makeRenderer();

    // An unknown element type falls back to a <div>, which has no implicit
    // role, so an engine-derived role must be applied explicitly.
    renderer.applyPatches([
      {
        type: "create",
        id: "c1",
        elementType: "CustomThing",
        props: {},
        semantics: { role: "button" },
      } as Patch,
    ]);

    const node = renderer.getNode("c1");
    expect(attrs(node).role).toBe("button");
  });

  test("no semantics block means no role attribute", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "d1", elementType: "Column", props: {} } as Patch,
    ]);

    const node = renderer.getNode("d1");
    expect("role" in attrs(node)).toBe(false);
  });

  test("native semantic elements never get a redundant role", () => {
    const { renderer } = makeRenderer();

    // Link renders an <a>, whose native role is already "link". The engine
    // still carries the role for non-DOM renderers, but DOM must not set it.
    renderer.applyPatches([
      {
        type: "create",
        id: "lnk",
        elementType: "Link",
        props: {},
        semantics: { role: "link" },
      } as Patch,
    ]);

    expect("role" in attrs(renderer.getNode("lnk"))).toBe(false);
  });

  test("an explicit label is applied as aria-label, even on a native button", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "b2",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Delete", nameExplicit: true },
      } as Patch,
    ]);

    expect(attrs(renderer.getNode("b2"))["aria-label"]).toBe("Delete");
  });

  test("a derived (non-explicit) name is not applied as aria-label", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "b3",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Save" },
      } as Patch,
    ]);

    expect("aria-label" in attrs(renderer.getNode("b3"))).toBe(false);
  });

  test("a description is applied as aria-description", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "d2",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Delete", nameExplicit: true, description: "Permanent" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("d2"));
    expect(a["aria-label"]).toBe("Delete");
    expect(a["aria-description"]).toBe("Permanent");
  });

  test("VisuallyHidden renders an sr-only span (off-screen but in the tree)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "vh", elementType: "VisuallyHidden", props: {} } as Patch,
    ]);
    const node = renderer.getNode("vh") as unknown as {
      tagName: string;
      style: Record<string, string>;
    };
    expect(node.tagName.toUpperCase()).toBe("SPAN");
    // Clipped to a 1px box and removed from layout — the standard sr-only recipe.
    expect(node.style.position).toBe("absolute");
    expect(node.style.width).toBe("1px");
  });

  test("self-state attributes (expanded/pressed/selected/current) are applied", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "disc",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Menu", nameExplicit: true, expanded: false, current: "page" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("disc"));
    expect(a["aria-expanded"]).toBe("false");
    expect(a["aria-current"]).toBe("page");
    // pressed/selected absent → no attribute
    expect("aria-pressed" in a).toBe(false);
  });

  test("a bound checkbox/switch checked state is applied as aria-checked", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "cb",
        elementType: "CustomThing",
        props: {},
        semantics: { role: "checkbox", checked: true },
      } as Patch,
      {
        type: "create",
        id: "sw",
        elementType: "CustomThing",
        props: {},
        semantics: { role: "switch", checked: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("cb"))["aria-checked"]).toBe("true");
    expect(attrs(renderer.getNode("sw"))["aria-checked"]).toBe("false");
  });

  test("cross-node relationships are applied as aria-controls / aria-describedby", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "tab",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Tab", nameExplicit: true, controls: "panel", describedby: "hint" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("tab"));
    expect(a["aria-controls"]).toBe("panel");
    expect(a["aria-describedby"]).toBe("hint");
  });

  test("a bound self-state change updates its ARIA attribute via setSemantics", () => {
    const { renderer } = makeRenderer();
    // Initial render: the resolved self-state arrives in the semantics block.
    renderer.applyPatches([
      {
        type: "create",
        id: "disc",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Menu", nameExplicit: true, expanded: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("disc"))["aria-expanded"]).toBe("false");

    // State change: the engine re-resolves the block and emits setSemantics
    // alongside the bound prop's SetProp — the attribute must go live.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "disc",
        semantics: { role: "button", name: "Menu", nameExplicit: true, expanded: true },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("disc"))["aria-expanded"]).toBe("true");

    // aria-current carries a string token.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "disc",
        semantics: {
          role: "button",
          name: "Menu",
          nameExplicit: true,
          expanded: true,
          current: "page",
        },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("disc"))["aria-current"]).toBe("page");
  });

  test("a hidden element is removed from the a11y tree and nothing else applies", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "h1",
        elementType: "Icon",
        props: {},
        semantics: { hidden: true, role: "img" },
      } as Patch,
    ]);

    const a = attrs(renderer.getNode("h1"));
    expect(a["aria-hidden"]).toBe("true");
    expect("role" in a).toBe(false);
  });

  test("a landmark role lands on a generic container", () => {
    const { renderer } = makeRenderer();

    // A Column renders a <div>, so an opt-in landmark role applies (the
    // existing generic-host role plumbing carries it — no special-casing).
    renderer.applyPatches([
      {
        type: "create",
        id: "nav",
        elementType: "Column",
        props: {},
        semantics: { role: "navigation" },
      } as Patch,
    ]);

    expect(attrs(renderer.getNode("nav")).role).toBe("navigation");
  });

  test("a generic div host gets an explicit role and aria-busy", () => {
    const { renderer } = makeRenderer();

    // Spinner-style semantics on a bare <div> host (here via the unknown-type
    // div fallback, which mirrors what Spinner/ProgressBar render): the div
    // conveys nothing natively, so the status role and busy state are applied
    // explicitly.
    renderer.applyPatches([
      {
        type: "create",
        id: "sp",
        elementType: "Loader",
        props: {},
        semantics: { role: "status", busy: true },
      } as Patch,
    ]);

    const node = renderer.getNode("sp");
    expect(attrs(node).role).toBe("status");
    expect(attrs(node)["aria-busy"]).toBe("true");
  });
});

describe("DOMRenderer reactive setSemantics", () => {
  test("re-applies the block to the live element", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "m1",
        elementType: "Button",
        props: {},
        semantics: { role: "button", expanded: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("m1"))["aria-expanded"]).toBe("false");

    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "m1",
        semantics: { role: "button", expanded: true },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("m1"))["aria-expanded"]).toBe("true");
  });

  test("clears attributes the new block no longer produces", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "m2",
        elementType: "Button",
        props: {},
        semantics: {
          role: "button",
          name: "Delete",
          nameExplicit: true,
          expanded: true,
        },
      } as Patch,
    ]);
    const before = attrs(renderer.getNode("m2"));
    expect(before["aria-label"]).toBe("Delete");
    expect(before["aria-expanded"]).toBe("true");

    // The name reverts to derived (no aria-label) and expanded is dropped:
    // both stale attributes must be removed, not left behind.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "m2",
        semantics: { role: "button", name: "Delete" },
      } as Patch,
    ]);
    const after = attrs(renderer.getNode("m2"));
    expect("aria-label" in after).toBe(false);
    expect("aria-expanded" in after).toBe(false);
  });

  test("setSemantics without a block clears everything this module set", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "m3",
        elementType: "CustomThing",
        props: {},
        semantics: { role: "status", busy: true },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("m3")).role).toBe("status");

    renderer.applyPatches([
      { type: "setSemantics", id: "m3" } as Patch,
    ]);
    const after = attrs(renderer.getNode("m3"));
    expect("role" in after).toBe(false);
    expect("aria-busy" in after).toBe(false);
  });

  test("is the sole ARIA writer for self-state (SetProp no longer writes ARIA)", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "m4",
        elementType: "Button",
        props: { "expanded.0": true },
        semantics: { role: "button", expanded: true },
      } as Patch,
    ]);

    // A bare SetProp for a bound self-state prop must not touch ARIA —
    // the retired SELF_STATE_ARIA shim would have flipped it here.
    renderer.applyPatches([
      { type: "setProp", id: "m4", name: "expanded.0", value: false } as Patch,
    ]);
    expect(attrs(renderer.getNode("m4"))["aria-expanded"]).toBe("true");

    // The engine always emits setSemantics alongside that SetProp; only it
    // drives the attribute.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "m4",
        semantics: { role: "button", expanded: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("m4"))["aria-expanded"]).toBe("false");
  });
});

describe("DOMRenderer cross-node relationships (item #3 slice)", () => {
  test("semantics.id becomes the DOM id attribute (the reference anchor)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "p1",
        elementType: "Column",
        props: {},
        semantics: { id: "details-panel" },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("p1")).id).toBe("details-panel");
  });

  test("labelledby maps to aria-labelledby", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "p2",
        elementType: "Column",
        props: {},
        semantics: { role: "region", id: "panel-1", labelledby: "tab-1" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("p2"));
    expect(a["aria-labelledby"]).toBe("tab-1");
    expect(a.id).toBe("panel-1");
  });

  test("activeDescendant maps to aria-activedescendant and tracks setSemantics", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "lb",
        elementType: "Column",
        props: {},
        semantics: { role: "list", activeDescendant: "opt-1" },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("lb"))["aria-activedescendant"]).toBe("opt-1");

    // Arrow-key state change → the reactive re-emit moves the pointer.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "lb",
        semantics: { role: "list", activeDescendant: "opt-2" },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("lb"))["aria-activedescendant"]).toBe("opt-2");

    // Pointer cleared (focus left the widget) → attribute removed.
    renderer.applyPatches([
      { type: "setSemantics", id: "lb", semantics: { role: "list" } } as Patch,
    ]);
    expect("aria-activedescendant" in attrs(renderer.getNode("lb"))).toBe(false);
  });
});

describe("DOMRenderer aria-owns", () => {
  test("owns maps to aria-owns (portaled popup ownership)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "cb",
        elementType: "Combobox",
        props: {},
        semantics: { role: "combobox", owns: "popup-1", expanded: false },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("cb"));
    expect(a["aria-owns"]).toBe("popup-1");
    expect(a["aria-expanded"]).toBe("false");
  });
});

describe("role overrides on native hosts", () => {
  test("role=tab is applied to a <button> host (intentional override)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "t1",
        elementType: "Tab",
        props: { "0": "Overview" },
        semantics: { role: "tab", name: "Overview", id: "s-tab-0", controls: "s-panel-0" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("t1"));
    // Tab renders a native <button>; role=tab must override, not be skipped.
    expect(a.role).toBe("tab");
    expect(a.id).toBe("s-tab-0");
    expect(a["aria-controls"]).toBe("s-panel-0");
  });

  test("redundant implicit roles are still skipped", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "b1x",
        elementType: "Button",
        props: {},
        semantics: { role: "button", name: "Save" },
      } as Patch,
    ]);
    expect("role" in attrs(renderer.getNode("b1x"))).toBe(false);
  });

  test("role=combobox is applied to an <input> host (ARIA 1.2 pattern)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "cbx",
        elementType: "Input",
        props: {},
        semantics: { role: "combobox", expanded: false, controls: "popup-1" },
      } as Patch,
    ]);
    const a = attrs(renderer.getNode("cbx"));
    expect(a.role).toBe("combobox");
    expect(a["aria-expanded"]).toBe("false");
    expect(a["aria-controls"]).toBe("popup-1");
  });
});
