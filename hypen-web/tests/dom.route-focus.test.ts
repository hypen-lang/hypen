/**
 * Route-change focus management (route-focus.ts + DOMRenderer wiring).
 *
 * The contract under test (design Open Question #4):
 * - navigation (detach + incoming subtree) moves focus to the new route's
 *   first heading / main landmark / subtree root;
 * - re-attaching a cached route restores the focus it had when detached;
 * - a removed (LRU-evicted) subtree's focus memory is dropped — restore
 *   never targets an evicted NodeId;
 * - initial renders (no detach) never steal focus.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { findRouteFocusTarget } from "../packages/web/src/dom/route-focus";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

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

const active = (): unknown => (document as any).activeElement;

/** Build a route subtree: root Column containing the given children. */
const buildRoute = (rootId: string, children: Array<{ id: string; type: string; props?: any }>): Patch[] => {
  const patches: Patch[] = [
    { type: "create", id: rootId, elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: rootId } as Patch,
  ];
  for (const c of children) {
    patches.push({ type: "create", id: c.id, elementType: c.type, props: c.props ?? {} } as Patch);
    patches.push({ type: "insert", parentId: rootId, id: c.id } as Patch);
  }
  return patches;
};

describe("findRouteFocusTarget", () => {
  test("prefers the first heading, then main, then the root", () => {
    const root = new FakeElement("DIV");
    const section = new FakeElement("SECTION");
    const h2 = new FakeElement("H2");
    section.appendChild(h2);
    root.appendChild(section);
    expect(findRouteFocusTarget(root as unknown as HTMLElement)).toBe(h2 as any);

    const noHeading = new FakeElement("DIV");
    const main = new FakeElement("MAIN");
    noHeading.appendChild(main);
    expect(findRouteFocusTarget(noHeading as unknown as HTMLElement)).toBe(main as any);

    const bare = new FakeElement("DIV");
    expect(findRouteFocusTarget(bare as unknown as HTMLElement)).toBe(bare as any);
  });

  test("role=heading counts as a heading host", () => {
    const root = new FakeElement("DIV");
    const div = new FakeElement("DIV");
    div.setAttribute("role", "heading");
    root.appendChild(div);
    expect(findRouteFocusTarget(root as unknown as HTMLElement)).toBe(div as any);
  });
});

describe("DOMRenderer route-change focus", () => {
  test("initial render never steals focus", () => {
    (document as any).activeElement = null;
    const { renderer } = makeRenderer();
    renderer.applyPatches(buildRoute("home", [{ id: "h", type: "Heading", props: { "0": "Home" } }]));
    expect(active()).toBe(null);
  });

  test("navigation moves focus to the new route's heading", () => {
    (document as any).activeElement = null;
    const { renderer } = makeRenderer();
    renderer.applyPatches(buildRoute("home", [{ id: "hh", type: "Heading", props: { "0": "Home" } }]));

    // Navigate: detach home, build the profile route fresh.
    renderer.applyPatches([
      { type: "detach", id: "home" } as Patch,
      ...buildRoute("profile", [{ id: "ph", type: "Heading", props: { "0": "Profile" } }]),
    ]);

    const heading = renderer.getNode("ph") as any;
    expect(active()).toBe(heading);
    // Programmatic-only focus: landing point, not a new tab stop.
    expect(attrs(heading).tabindex).toBe("-1");
  });

  test("re-attaching a cached route restores its remembered focus", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches(
      buildRoute("home", [{ id: "btn", type: "Button", props: { "0": "Go" } }]),
    );
    // The user had focused the button before navigating away.
    (renderer.getNode("btn") as any).focus();

    renderer.applyPatches([
      { type: "detach", id: "home" } as Patch,
      ...buildRoute("about", [{ id: "ah", type: "Heading", props: { "0": "About" } }]),
    ]);
    expect(active()).toBe(renderer.getNode("ah"));

    // Navigate back: cached route re-attaches; focus returns to the button.
    renderer.applyPatches([
      { type: "detach", id: "about" } as Patch,
      { type: "attach", parentId: "root", id: "home" } as Patch,
    ]);
    expect(active()).toBe(renderer.getNode("btn"));
  });

  test("an evicted route's focus memory is dropped (never target an evicted NodeId)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches(
      buildRoute("home", [{ id: "btn2", type: "Button", props: { "0": "Go" } }]),
    );
    (renderer.getNode("btn2") as any).focus();

    renderer.applyPatches([
      { type: "detach", id: "home" } as Patch,
      ...buildRoute("about2", [{ id: "a2h", type: "Heading", props: { "0": "About" } }]),
    ]);

    // Router LRU evicts the cached home route.
    renderer.applyPatches([
      { type: "remove", id: "btn2" } as Patch,
      { type: "remove", id: "home" } as Patch,
    ]);

    // A (hypothetical) re-build of home is a fresh subtree: focus falls back
    // to the heading rule, not the evicted button.
    renderer.applyPatches([
      { type: "detach", id: "about2" } as Patch,
      ...buildRoute("home", [{ id: "hh2", type: "Heading", props: { "0": "Home" } }]),
    ]);
    expect(active()).toBe(renderer.getNode("hh2"));
  });

  test("a route with no heading or main lands on the subtree root", () => {
    (document as any).activeElement = null;
    const { renderer } = makeRenderer();
    renderer.applyPatches(buildRoute("r1", [{ id: "t1", type: "Text", props: { "0": "hi" } }]));
    renderer.applyPatches([
      { type: "detach", id: "r1" } as Patch,
      ...buildRoute("r2", [{ id: "t2", type: "Text", props: { "0": "there" } }]),
    ]);
    const root = renderer.getNode("r2") as any;
    expect(active()).toBe(root);
    expect(attrs(root).tabindex).toBe("-1");
  });
});
