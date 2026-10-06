/**
 * axe-core conformance harness for the DOM renderer.
 *
 * The attribute-level unit tests (dom.semantics.test.ts) assert that patches
 * produce the intended ARIA attributes; this suite closes the loop with a real
 * accessibility engine: representative patch trees are rendered through
 * DOMRenderer into a jsdom document and audited with `axe.run()`, asserting
 * zero WCAG A/AA violations. A deliberately-broken tree (an unlabeled
 * icon-only button) must FAIL the audit, proving the harness actually detects
 * violations rather than vacuously passing.
 *
 * jsdom constraints: axe-core resolves `window`/`document` from the globals
 * present when its module loads, so the jsdom globals are installed before the
 * dynamic import below. Rules needing layout/paint (color-contrast) are
 * disabled — jsdom does no layout.
 */

import { describe, expect, test, afterEach, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";

// Globals other test files may have installed (fake-dom force-sets its own on
// every ensureFakeDomGlobals() call, but restore anyway to stay order-proof).
const originalGlobals: Record<string, unknown> = {};
const GLOBAL_KEYS = ["window", "document", "HTMLElement", "Node", "Element", "getComputedStyle"];
for (const key of GLOBAL_KEYS) {
  originalGlobals[key] = (globalThis as any)[key];
}

const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head></head><body></body></html>', {
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// axe-core captures window/document at module-load time — import only after
// the jsdom globals are in place.
const axe = (await import("axe-core")).default;

afterAll(() => {
  for (const key of GLOBAL_KEYS) {
    (globalThis as any)[key] = originalGlobals[key];
  }
});

afterEach(() => {
  document.body.innerHTML = "";
});

class StubEngine {
  dispatchAction(): void {}
}

/** Render a patch tree into a container attached to the jsdom document. */
const render = (patches: Patch[]): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  renderer.applyPatches(patches);
  return container;
};

/**
 * WCAG A/AA only (excludes axe "best-practice" page-structure rules like
 * `region`, which are about whole-page landmarking, not these fragments).
 * color-contrast needs real layout/paint, which jsdom does not do.
 */
const AXE_OPTIONS = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  rules: { "color-contrast": { enabled: false } },
} as const;

const auditViolations = async (container: HTMLElement): Promise<string[]> => {
  const results = await axe.run(container, AXE_OPTIONS as any);
  // Surface the full node/summary detail on failure, not just rule ids.
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.failureSummary).join(" | ")}`,
  );
};

describe("axe-core conformance (DOM renderer output)", () => {
  test("a labelled form (explicit aria-label + id/labelledby pair) has no violations", async () => {
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      // The .id anchor half of the pair: a visible Text acting as the label.
      {
        type: "create",
        id: "lbl",
        elementType: "Text",
        props: { "0": "Email address" },
        semantics: { id: "email-label" },
      },
      // labelledby → the anchor above.
      {
        type: "create",
        id: "in1",
        elementType: "Input",
        props: { placeholder: "you@example.com" },
        semantics: { role: "textbox", labelledby: "email-label" },
      },
      // Explicit author label → aria-label.
      {
        type: "create",
        id: "in2",
        elementType: "Input",
        props: { placeholder: "Search…" },
        semantics: { role: "textbox", name: "Search", nameExplicit: true },
      },
      { type: "insert", parentId: "root", id: "lbl" },
      { type: "insert", parentId: "root", id: "in1" },
      { type: "insert", parentId: "root", id: "in2" },
    ] as Patch[]);

    expect(await auditViolations(container)).toEqual([]);
  });

  test("an image with alt text has no violations", async () => {
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      // Engine derives the img name from the alt prop (derived, not explicit);
      // the DOM carries it natively via the alt attribute.
      {
        type: "create",
        id: "img",
        elementType: "Image",
        props: { "0": "sunset.png", alt: "A sunset over the sea" },
        semantics: { role: "img", name: "A sunset over the sea" },
      },
      { type: "insert", parentId: "root", id: "img" },
    ] as Patch[]);

    expect(await auditViolations(container)).toEqual([]);
  });

  test("a Tabs widget with the engine's minted id graph has no violations", async () => {
    // The id graph mirrors wire_tablist's output for a tablist with
    // `.id("settings")` and two tab/panel pairs: minted ids
    // `settings-tab-<i>` / `settings-panel-<i>`, tab.controls → panel.id,
    // panel.labelledby → tab.id, author-driven selection. Tab renders a
    // native <button> (role=tab overrides), TabPanel a tabindex=0 region,
    // and the tablist gets the roving-tabindex contract. Structure here is
    // the docs' canonical hand-wired shape — panels as *siblings* of the
    // tablist, the ARIA-required shape (only role=tab children inside a
    // tablist); the engine's auto-wired mixed shape is covered below.
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      {
        type: "create",
        id: "tl",
        elementType: "Tabs",
        props: {},
        semantics: { role: "tablist", id: "settings" },
      },
      {
        type: "create",
        id: "t0",
        elementType: "Tab",
        props: { "0": "Profile" },
        semantics: {
          role: "tab",
          name: "Profile",
          id: "settings-tab-0",
          controls: "settings-panel-0",
          selected: true,
        },
      },
      {
        type: "create",
        id: "t1",
        elementType: "Tab",
        props: { "0": "Security" },
        semantics: {
          role: "tab",
          name: "Security",
          id: "settings-tab-1",
          controls: "settings-panel-1",
          selected: false,
        },
      },
      {
        type: "create",
        id: "p0",
        elementType: "TabPanel",
        props: {},
        semantics: { role: "tabpanel", id: "settings-panel-0", labelledby: "settings-tab-0" },
      },
      {
        type: "create",
        id: "p1",
        elementType: "TabPanel",
        props: {},
        semantics: { role: "tabpanel", id: "settings-panel-1", labelledby: "settings-tab-1" },
      },
      { type: "create", id: "p0t", elementType: "Text", props: { "0": "Profile settings" } },
      { type: "create", id: "p1t", elementType: "Text", props: { "0": "Security settings" } },
      { type: "insert", parentId: "root", id: "tl" },
      { type: "insert", parentId: "tl", id: "t0" },
      { type: "insert", parentId: "tl", id: "t1" },
      { type: "insert", parentId: "root", id: "p0" },
      { type: "insert", parentId: "root", id: "p1" },
      { type: "insert", parentId: "p0", id: "p0t" },
      { type: "insert", parentId: "p1", id: "p1t" },
    ] as Patch[]);

    expect(await auditViolations(container)).toEqual([]);
  });

  test("the engine's auto-wired mixed Tabs shape has no violations", async () => {
    // Mirrors wire_tablist's restructured output for
    // `Tabs { Tab("Profile") TabPanel { … } }.id("s")` — pinned as the
    // engine-output contract by tabs_mixed_children_restructure_into_
    // tab_only_tablist in hypen-engine-rs/tests/test_a11y_conformance.rs.
    // The outer Tabs becomes a plain group keeping the author id; a
    // synthetic inner Tabs carries role=tablist and ONLY the tab children
    // (ARIA allows nothing else inside a tablist); the panel stays a direct
    // child of the outer container.
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      {
        type: "create",
        id: "outer",
        elementType: "Tabs",
        props: {},
        semantics: { id: "s" },
      },
      {
        type: "create",
        id: "tl",
        elementType: "Tabs",
        props: {},
        semantics: { role: "tablist" },
      },
      {
        type: "create",
        id: "t0",
        elementType: "Tab",
        props: { "0": "Profile" },
        semantics: { role: "tab", name: "Profile", id: "s-tab-0", controls: "s-panel-0", selected: true },
      },
      {
        type: "create",
        id: "p0",
        elementType: "TabPanel",
        props: {},
        semantics: { role: "tabpanel", id: "s-panel-0", labelledby: "s-tab-0" },
      },
      { type: "create", id: "p0t", elementType: "Text", props: { "0": "Profile settings" } },
      { type: "insert", parentId: "root", id: "outer" },
      { type: "insert", parentId: "outer", id: "tl" },
      { type: "insert", parentId: "tl", id: "t0" },
      { type: "insert", parentId: "outer", id: "p0" },
      { type: "insert", parentId: "p0", id: "p0t" },
    ] as Patch[]);

    expect(await auditViolations(container)).toEqual([]);

    // The roving-tabindex contract landed on the synthetic inner tablist —
    // the renderer keys it off role=tablist at create.
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.dataset.hypenRoving).toBe("1");
  });

  test("a dialog with a focus trap and an explicit name has no violations", async () => {
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      // role=dialog triggers makeFocusTrap in the renderer; the explicit
      // label satisfies axe's aria-dialog-name.
      {
        type: "create",
        id: "dlg",
        elementType: "Column",
        props: {},
        semantics: { role: "dialog", name: "Confirm deletion", nameExplicit: true },
      },
      { type: "create", id: "msg", elementType: "Text", props: { "0": "Delete this item?" } },
      { type: "create", id: "ok", elementType: "Button", props: {}, semantics: { role: "button", name: "Delete" } },
      { type: "create", id: "okt", elementType: "Text", props: { "0": "Delete" } },
      { type: "create", id: "no", elementType: "Button", props: {}, semantics: { role: "button", name: "Cancel" } },
      { type: "create", id: "not", elementType: "Text", props: { "0": "Cancel" } },
      { type: "insert", parentId: "root", id: "dlg" },
      { type: "insert", parentId: "dlg", id: "msg" },
      { type: "insert", parentId: "dlg", id: "ok" },
      { type: "insert", parentId: "ok", id: "okt" },
      { type: "insert", parentId: "dlg", id: "no" },
      { type: "insert", parentId: "no", id: "not" },
    ] as Patch[]);

    expect(await auditViolations(container)).toEqual([]);

    // The trap actually got installed (renderer wiring, not just clean ARIA).
    const dlg = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.dataset.hypenTrap).toBe("1");
  });

  test("NEGATIVE: an unlabeled icon-only button IS flagged (harness is live)", async () => {
    const container = render([
      { type: "create", id: "root", elementType: "Column", props: {} },
      // The icon is decorative (aria-hidden) and the button has no label —
      // exactly the nameMissing case the engine's conformance checker flags.
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {},
        semantics: { role: "button", nameMissing: true },
      },
      {
        type: "create",
        id: "ico",
        elementType: "Icon",
        props: { "0": "trash" },
        semantics: { hidden: true, role: "img" },
      },
      { type: "insert", parentId: "root", id: "btn" },
      { type: "insert", parentId: "btn", id: "ico" },
    ] as Patch[]);

    const results = await axe.run(container, AXE_OPTIONS as any);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toContain("button-name");
  });
});
