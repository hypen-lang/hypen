/**
 * `getEngine` resolves through mounted ancestors: template-instantiated
 * rows carry no engine entry of their own (a WeakMap write per node was
 * ~17k per 1,000-row create), so a listener on a cloned Button must still
 * reach the engine the renderer registered on the tree above it.
 */

import { describe, expect, test } from "bun:test";
import { getEngine, setEngine, type IEngine } from "../packages/web/src/dom/element-data";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

const engineA: IEngine = { dispatchAction() {} };
const engineB: IEngine = { dispatchAction() {} };

function el(parent?: FakeElement): FakeElement {
  const e = document.createElement("div") as unknown as FakeElement;
  if (parent) parent.appendChild(e);
  return e;
}

describe("getEngine", () => {
  test("returns the element's own engine first", () => {
    const root = el();
    const child = el(root);
    setEngine(root as unknown as HTMLElement, engineA);
    setEngine(child as unknown as HTMLElement, engineB);
    expect(getEngine(child as unknown as HTMLElement)).toBe(engineB);
  });

  test("falls back to the nearest ancestor's engine", () => {
    const root = el();
    const mid = el(root);
    const leaf = el(mid);
    setEngine(root as unknown as HTMLElement, engineA);
    expect(getEngine(leaf as unknown as HTMLElement)).toBe(engineA);
    expect(getEngine(mid as unknown as HTMLElement)).toBe(engineA);
  });

  test("is undefined for a detached element with no engine above it", () => {
    const root = el();
    const leaf = el(root);
    expect(getEngine(leaf as unknown as HTMLElement)).toBeUndefined();
  });
});
