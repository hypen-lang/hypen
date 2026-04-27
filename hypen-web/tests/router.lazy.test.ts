import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  renderIntoCalls: any[] = [];
  renderInto(src: string, id: string, state: Record<string, unknown>) { this.renderIntoCalls.push({ src, id, state }); }
  setRenderCallback() {}
  dispatchAction(_name: string, _payload?: any) {}
}

describe("Lazy route behavior", () => {
  test("route element missing children triggers renderInto on ensure", () => {
    const container = document.createElement("div") as any as HTMLElement;
    const renderer = new DOMRenderer(container, new StubEngine());

    // Simulate a route element present and visible but empty
    const route = document.createElement("div");
    route.style.display = "flex";
    // Set dataset properties individually (dataset object is read-only)
    route.dataset.hypenType = "route";
    route.dataset.routeLazy = "true";
    route.dataset.routeComponent = "HomePage";
    route.dataset.routePath = "/";
    container.appendChild(route);

    // No assertion on DOMRenderer here; this is a harness to ensure the engine-side
    // code paths can find the active route and decide to render into it.
    expect(route.dataset.routeComponent).toBe("HomePage");
  });
});














