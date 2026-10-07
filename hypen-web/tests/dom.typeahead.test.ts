import { semanticAction } from "./helpers";
/**
 * Typeahead (first-character navigation) for composite widgets: typing a
 * printable character inside a tablist/listbox roves focus to the next item
 * whose accessible text starts with the accumulated query (case-insensitive,
 * wrapping, reset after a 500ms pause).
 */

import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import {
  nextTypeaheadFocus,
  makeRovingTablist,
  makeRovingListbox,
} from "../packages/web/src/dom/operability";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

afterEach(() => {
  // Restore real time after tests that advance the typeahead-reset clock.
  setSystemTime();
});

describe("typeahead (nextTypeaheadFocus)", () => {
  const items = ["Apple", "Ant", "Banana", "Cherry"];
  const textOf = (item: string) => item;

  test("moves to the next item starting with the query", () => {
    expect(nextTypeaheadFocus(items, "Apple", "b", textOf)).toBe("Banana");
  });

  test("searches from the item after active and wraps past the end", () => {
    expect(nextTypeaheadFocus(items, "Cherry", "a", textOf)).toBe("Apple");
  });

  test("cycles among items sharing a first letter", () => {
    expect(nextTypeaheadFocus(items, "Apple", "a", textOf)).toBe("Ant");
    expect(nextTypeaheadFocus(items, "Ant", "a", textOf)).toBe("Apple");
  });

  test("active itself is the last candidate (sole match keeps focus)", () => {
    expect(nextTypeaheadFocus(items, "Banana", "b", textOf)).toBe("Banana");
  });

  test("matching is case-insensitive both ways", () => {
    expect(nextTypeaheadFocus(items, null, "APP", textOf)).toBe("Apple");
    expect(nextTypeaheadFocus(["lower", "Upper"], null, "u", textOf)).toBe("Upper");
  });

  test("a multi-char query refines past shorter matches", () => {
    expect(nextTypeaheadFocus(items, null, "an", textOf)).toBe("Ant");
    expect(nextTypeaheadFocus(items, "Apple", "ap", textOf)).toBe("Apple");
  });

  test("no match returns null", () => {
    expect(nextTypeaheadFocus(items, "Apple", "z", textOf)).toBeNull();
    expect(nextTypeaheadFocus(items, null, "apx", textOf)).toBeNull();
  });

  test("empty query and empty list return null", () => {
    expect(nextTypeaheadFocus(items, "Apple", "", textOf)).toBeNull();
    expect(nextTypeaheadFocus([], null, "a", textOf)).toBeNull();
  });

  test("no active item starts the search from the first item", () => {
    expect(nextTypeaheadFocus(items, null, "a", textOf)).toBe("Apple");
  });

  test("surrounding whitespace in item text is ignored", () => {
    expect(nextTypeaheadFocus(["  Padded  "], null, "p", textOf)).toBe("  Padded  ");
  });
});

/**
 * Keydown-level harness: FakeElement has no querySelectorAll, so the widget
 * container gets one stubbed to return its role-bearing children — the same
 * shape the real DOM query would produce.
 */
const makeWidget = (labels: string[], install: (el: HTMLElement) => void) => {
  const doc = (globalThis as any).document;
  doc.activeElement = null;
  const container = doc.createElement("div") as FakeElement;
  const items = labels.map((label) => {
    const item = doc.createElement("button") as FakeElement;
    item.textContent = label;
    container.appendChild(item);
    return item;
  });
  (container as any).querySelectorAll = () => items;
  install(container as unknown as HTMLElement);
  const press = (key: string, init: Record<string, unknown> = {}) => {
    let prevented = false;
    container.dispatchEvent("keydown", {
      key,
      preventDefault: () => {
        prevented = true;
      },
      ...init,
    });
    return prevented;
  };
  return { container, items, press, doc };
};

describe("tablist typeahead keydown handling", () => {
  test("a printable character roves focus to the matching tab", () => {
    const { items, press, doc } = makeWidget(["Alpha", "Beta", "Charlie"], makeRovingTablist);
    const prevented = press("b");
    expect(prevented).toBe(true);
    expect(doc.activeElement).toBe(items[1]);
    expect(items[1]!.tabIndex).toBe(0);
    expect(items[0]!.tabIndex).toBe(-1);
    expect(items[2]!.tabIndex).toBe(-1);
  });

  test("quick keystrokes accumulate into a multi-char query", () => {
    const { items, press, doc } = makeWidget(["Beta", "Bravo", "Charlie"], makeRovingTablist);
    press("b");
    expect(doc.activeElement).toBe(items[0]);
    // Within the 500ms window the buffer is "br", refining onto Bravo.
    press("r");
    expect(doc.activeElement).toBe(items[1]);
  });

  test("the query resets after a 500ms pause", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { items, press, doc } = makeWidget(["Beta", "Bravo", "Charlie"], makeRovingTablist);
    press("b");
    expect(doc.activeElement).toBe(items[0]);
    setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    // A fresh buffer ("c", not "bc") lands on Charlie.
    press("c");
    expect(doc.activeElement).toBe(items[2]);
  });

  test("repeating a letter after the pause cycles same-letter items", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { items, press, doc } = makeWidget(["Beta", "Bravo", "Charlie"], makeRovingTablist);
    press("b");
    expect(doc.activeElement).toBe(items[0]);
    setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    press("b");
    expect(doc.activeElement).toBe(items[1]);
  });

  test("modified keys, Space, and non-matches leave focus alone", () => {
    const { press, doc } = makeWidget(["Alpha", "Beta"], makeRovingTablist);
    expect(press("b", { ctrlKey: true })).toBe(false);
    expect(press("b", { metaKey: true })).toBe(false);
    expect(press("b", { altKey: true })).toBe(false);
    expect(press(" ")).toBe(false);
    expect(press("z")).toBe(false);
    expect(doc.activeElement).toBeNull();
  });

  test("arrow roving still works alongside typeahead", () => {
    const { items, press, doc } = makeWidget(["Alpha", "Beta", "Charlie"], makeRovingTablist);
    press("ArrowRight");
    expect(doc.activeElement).toBe(items[0]);
    press("ArrowRight");
    expect(doc.activeElement).toBe(items[1]);
  });
});

describe("listbox typeahead keydown handling", () => {
  test("a printable character roves focus to the matching option", () => {
    const { items, press, doc } = makeWidget(["Croatia", "Canada", "Denmark"], makeRovingListbox);
    press("c");
    expect(doc.activeElement).toBe(items[0]);
    press("a");
    // Buffer "ca" skips Croatia and lands on Canada.
    expect(doc.activeElement).toBe(items[1]);
  });
});

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

describe("listbox wiring", () => {
  test("a role=listbox container is wired for roving via the renderer", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "lb",
        elementType: "Column",
        props: {},
        semantics: { role: "listbox" },
      } as Patch,
    ]);
    const node = renderer.getNode("lb") as any;
    expect(node.dataset.hypenRoving).toBe("1");
    expect(attrs(node).role).toBe("listbox");
  });

  test("a native Select is left to the browser (no roving install)", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "sel",
        elementType: "Select",
        props: {},
        semantics: { role: "listbox" },
      } as Patch,
    ]);
    const node = renderer.getNode("sel") as any;
    expect(node.tagName).toBe("SELECT");
    expect("hypenRoving" in node.dataset).toBe(false);
  });

  test("makeRovingListbox is idempotent", () => {
    const el = new FakeElement("DIV");
    makeRovingListbox(el as unknown as HTMLElement);
    expect(el.dataset.hypenRoving).toBe("1");
    makeRovingListbox(el as unknown as HTMLElement);
    expect(el.dataset.hypenRoving).toBe("1");
  });
});
