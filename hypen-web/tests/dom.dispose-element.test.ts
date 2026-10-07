/**
 * `disposeHypenElement` runs for every node of a removed subtree. It must
 * not manufacture a DisposableStack on elements that never registered one
 * — the previous implementation called `getElementDisposables` (which
 * creates on miss) just to dispose it empty, one allocation per swept node,
 * and left the empty stack attached to the corpse.
 */

import { describe, expect, test } from "bun:test";
import {
  getElementDisposables,
  hasElementDisposables,
} from "../packages/core/src/disposable";
import { disposeHypenElement, getHypenData, hasHypenData } from "../packages/web/src/dom/element-data";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

describe("disposeHypenElement", () => {
  test("does not create a disposable stack on an element that has none", () => {
    const el = document.createElement("div") as unknown as HTMLElement;
    expect(hasElementDisposables(el)).toBe(false);
    disposeHypenElement(el);
    expect(hasElementDisposables(el)).toBe(false);
  });

  test("still disposes and detaches a stack that exists", () => {
    const el = document.createElement("div") as unknown as HTMLElement;
    let disposed = 0;
    getElementDisposables(el).add({ dispose: () => void disposed++ });
    expect(hasElementDisposables(el)).toBe(true);
    disposeHypenElement(el);
    expect(disposed).toBe(1);
    expect(hasElementDisposables(el)).toBe(false);
  });

  test("clears the element's Hypen data", () => {
    const el = document.createElement("div") as unknown as HTMLElement;
    getHypenData(el).keyTarget = "Enter";
    expect(hasHypenData(el)).toBe(true);
    disposeHypenElement(el);
    expect(hasHypenData(el)).toBe(false);
  });
});
