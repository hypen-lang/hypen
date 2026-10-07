import { semanticAction } from "./helpers";
/**
 * Keyboard operability: actionable elements that render a non-native host
 * (e.g. Card → <div>) are made focusable, given a button role, and activated
 * by Enter/Space — reusing the same action dispatch as a click.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { nextTrapFocus, nextRovingFocus, makeRovingTablist } from "../packages/web/src/dom/operability";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class RecordingEngine {
  actions: Array<{ name: string; payload?: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.actions.push(semanticAction(name, payload));
  }
}

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { container, renderer, engine };
};

const attrs = (node: unknown): Record<string, string> =>
  (node as { attributes?: Record<string, string> }).attributes ?? {};

describe("DOM keyboard operability", () => {
  test("an actionable Card (div) becomes a focusable button activated by Enter", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "card",
        elementType: "Card",
        props: { action: "@actions.open" },
      } as Patch,
    ]);

    const node = renderer.getNode("card") as any;
    expect(attrs(node).role).toBe("button");
    expect(node.tabIndex).toBe(0);

    node.dispatchEvent("keydown", { key: "Enter", preventDefault() {} });
    expect(engine.actions).toEqual([{ name: "open", payload: {} }]);
  });

  test("Space also activates", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "c2", elementType: "Card", props: { action: "@actions.go" } } as Patch,
    ]);
    const node = renderer.getNode("c2") as any;
    node.dispatchEvent("keydown", { key: " ", preventDefault() {} });
    expect(engine.actions).toEqual([{ name: "go", payload: {} }]);
  });

  test("an unrelated key does not activate", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "c3", elementType: "Card", props: { action: "@actions.x" } } as Patch,
    ]);
    const node = renderer.getNode("c3") as any;
    node.dispatchEvent("keydown", { key: "a", preventDefault() {} });
    expect(engine.actions).toEqual([]);
  });

  test("a native Button is left to the browser (no synthetic role / tabindex)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "b", elementType: "Button", props: { action: "@actions.save" } } as Patch,
    ]);
    const node = renderer.getNode("b") as any;
    // Native <button> handles Enter/Space itself — we don't add a role.
    expect("role" in attrs(node)).toBe(false);
  });
});

describe("focus trap (nextTrapFocus)", () => {
  // The fake DOM has no querySelectorAll on elements, so the wrap behaviour is
  // exercised through the pure focusable-list function the trap delegates to.
  const focusable = ["a", "b", "c"];

  test("Tab from the last focusable wraps to the first", () => {
    expect(nextTrapFocus(focusable, "c", false)).toBe("a");
  });

  test("Shift+Tab from the first focusable wraps to the last", () => {
    expect(nextTrapFocus(focusable, "a", true)).toBe("c");
  });

  test("Tab/Shift+Tab in the middle move by one", () => {
    expect(nextTrapFocus(focusable, "a", false)).toBe("b");
    expect(nextTrapFocus(focusable, "c", true)).toBe("b");
  });

  test("focus outside the set lands on the first (Tab) or last (Shift+Tab)", () => {
    expect(nextTrapFocus(focusable, null, false)).toBe("a");
    expect(nextTrapFocus(focusable, null, true)).toBe("c");
  });

  test("an empty container has nothing to focus", () => {
    expect(nextTrapFocus([], null, false)).toBeNull();
  });
});

describe("DOM dialog focus trap wiring", () => {
  test("a .role(\"dialog\") container is wired with a focus trap (idempotent)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "dlg",
        elementType: "Column",
        props: {},
        semantics: { role: "dialog" },
      } as Patch,
    ]);
    const node = renderer.getNode("dlg") as any;
    // The trap installs its dataset guard so it is wired only once.
    expect(node.dataset.hypenTrap).toBe("1");
    expect(attrs(node).role).toBe("dialog");
  });
});

describe("roving tabindex (nextRovingFocus)", () => {
  const tabs = ["t1", "t2", "t3"];

  test("ArrowRight/ArrowDown move forward and wrap", () => {
    expect(nextRovingFocus(tabs, "t1", "ArrowRight")).toBe("t2");
    expect(nextRovingFocus(tabs, "t3", "ArrowRight")).toBe("t1");
    expect(nextRovingFocus(tabs, "t2", "ArrowDown")).toBe("t3");
  });

  test("ArrowLeft/ArrowUp move backward and wrap", () => {
    expect(nextRovingFocus(tabs, "t2", "ArrowLeft")).toBe("t1");
    expect(nextRovingFocus(tabs, "t1", "ArrowLeft")).toBe("t3");
    expect(nextRovingFocus(tabs, "t3", "ArrowUp")).toBe("t2");
  });

  test("Home and End jump to the ends", () => {
    expect(nextRovingFocus(tabs, "t2", "Home")).toBe("t1");
    expect(nextRovingFocus(tabs, "t2", "End")).toBe("t3");
  });

  test("other keys and empty lists leave focus alone", () => {
    expect(nextRovingFocus(tabs, "t2", "Tab")).toBe(null);
    expect(nextRovingFocus(tabs, "t2", "a")).toBe(null);
    expect(nextRovingFocus([], null, "ArrowRight")).toBe(null);
  });

  test("focus from outside the set lands on the first tab", () => {
    expect(nextRovingFocus(tabs, null, "ArrowRight")).toBe("t1");
  });
});

describe("tablist wiring", () => {
  test("a role=tablist Tabs container is wired for roving via the renderer", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "tl",
        elementType: "Tabs",
        props: {},
        semantics: { role: "tablist", id: "settings" },
      } as Patch,
    ]);
    const node = renderer.getNode("tl") as any;
    expect(node.dataset.hypenRoving).toBe("1");
    expect(attrs(node).role).toBe("tablist");
    expect(attrs(node).id).toBe("settings");
  });

  test("makeRovingTablist is idempotent", () => {
    const el = new FakeElement("DIV");
    makeRovingTablist(el as unknown as HTMLElement);
    expect(el.dataset.hypenRoving).toBe("1");
    // Re-wiring is a no-op (guarded by the dataset flag).
    makeRovingTablist(el as unknown as HTMLElement);
    expect(el.dataset.hypenRoving).toBe("1");
  });
});
