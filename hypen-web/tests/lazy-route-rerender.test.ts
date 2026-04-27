/**
 * Tests for lazy route re-rendering on navigation
 * Ensures that lazy routes pick up state changes when navigated to
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { updateRouteVisibility } from "../packages/core/src/components/builtin";

describe("Lazy Route Re-rendering", () => {
  let dom: JSDOM;
  let document: Document;
  let window: Window & typeof globalThis;

  beforeEach(() => {
    // Setup fresh DOM for each test
    dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="app"></div>
        </body>
      </html>
    `, {
      url: "http://localhost",
      runScripts: "dangerously",
      resources: "usable",
    });

    document = dom.window.document;
    window = dom.window as any;

    // Setup global objects
    (global as any).window = window;
    (global as any).document = document;
    (global as any).HTMLElement = window.HTMLElement;
    (global as any).Element = window.Element;
  });

  test("lazy route re-renders when navigated to after state change", async () => {
    // Create mock route elements with correct data attributes
    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";  // Required for querySelector
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    cartRoute.style.display = "none";

    const productsRoute = document.createElement("div");
    productsRoute.dataset.hypenType = "route";  // Required for querySelector
    productsRoute.dataset.routePath = "/products";
    productsRoute.dataset.routeComponent = "ProductsPage";
    productsRoute.dataset.routeLazy = "true";
    productsRoute.style.display = "none";

    document.body.appendChild(cartRoute);
    document.body.appendChild(productsRoute);

    // Mock hypen engine with render tracking
    let renderCalls: Array<{ path: string; component: string; element: HTMLElement }> = [];
    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        renderCalls.push({ path, component, element });

        // Simulate rendering cart content
        if (component === "CartPage") {
          const itemCount = mockEngine.getState().cart?.length || 0;
          element.innerHTML = `<div class="cart-items">Items: ${itemCount}</div>`;
        } else if (component === "ProductsPage") {
          element.innerHTML = `<div class="products">Products list</div>`;
        }
      },
      getState: () => mockState,
    };

    let mockState = { cart: [] };

    // Import the router update function
    // updateRouteVisibility imported at top level

    // Navigate to cart (initial render, empty cart)
    renderCalls = [];
    await updateRouteVisibility("/cart", mockEngine as any);

    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].component).toBe("CartPage");
    expect(cartRoute.style.display).toBe("flex");
    expect(cartRoute.innerHTML).toContain("Items: 0");

    // Navigate away to products
    renderCalls = [];
    await updateRouteVisibility("/products", mockEngine as any);

    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].component).toBe("ProductsPage");
    expect(productsRoute.style.display).toBe("flex");
    expect(cartRoute.style.display).toBe("none");

    // Simulate state change (add items to cart)
    mockState = { cart: [{ id: 1, name: "Item 1" }, { id: 2, name: "Item 2" }] };

    // Navigate back to cart - should re-render with new state
    renderCalls = [];
    await updateRouteVisibility("/cart", mockEngine as any);

    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].component).toBe("CartPage");
    expect(cartRoute.style.display).toBe("flex");
    expect(cartRoute.innerHTML).toContain("Items: 2");
  });

  test("lazy route re-renders EVERY time it's navigated to", async () => {
    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    cartRoute.innerHTML = "<div>Old content</div>";
    document.body.appendChild(cartRoute);

    const homeRoute = document.createElement("div");
    homeRoute.dataset.hypenType = "route";
    homeRoute.dataset.routePath = "/";
    homeRoute.dataset.routeComponent = "HomePage";
    homeRoute.dataset.routeLazy = "true";
    document.body.appendChild(homeRoute);

    let renderCount = 0;
    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        renderCount++;
        element.innerHTML = `<div>Render #${renderCount}</div>`;
      },
      getState: () => ({}),
    };

    // updateRouteVisibility imported at top level

    // Navigate to cart first time
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(1);
    expect(cartRoute.innerHTML).toContain("Render #1");

    // Navigate away
    await updateRouteVisibility("/", mockEngine as any);
    expect(renderCount).toBe(2); // Home also renders

    // Navigate back to cart - should re-render again
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(3);
    expect(cartRoute.innerHTML).toContain("Render #3");

    // Navigate away and back again
    await updateRouteVisibility("/", mockEngine as any);
    expect(renderCount).toBe(4);

    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(5);
    expect(cartRoute.innerHTML).toContain("Render #5");
  });

  test("non-lazy routes do NOT re-render if they have content", async () => {
    const staticRoute = document.createElement("div");
    staticRoute.dataset.hypenType = "route";
    staticRoute.dataset.routePath = "/static";
    staticRoute.dataset.routeComponent = "StaticPage";
    staticRoute.dataset.routeLazy = "false";
    staticRoute.innerHTML = "<div>Static content</div>";
    document.body.appendChild(staticRoute);

    const homeRoute = document.createElement("div");
    homeRoute.dataset.hypenType = "route";
    homeRoute.dataset.routePath = "/";
    homeRoute.dataset.routeComponent = "HomePage";
    homeRoute.dataset.routeLazy = "false";
    homeRoute.innerHTML = "<div>Home content</div>";
    document.body.appendChild(homeRoute);

    let renderCount = 0;
    const mockEngine = {
      renderLazyRoute: async () => {
        renderCount++;
      },
      getState: () => ({}),
    };

    // updateRouteVisibility imported at top level

    // Navigate to static route
    await updateRouteVisibility("/static", mockEngine as any);
    expect(renderCount).toBe(0); // Should NOT render (has content)
    expect(staticRoute.innerHTML).toContain("Static content");

    // Navigate away and back
    await updateRouteVisibility("/", mockEngine as any);
    await updateRouteVisibility("/static", mockEngine as any);

    expect(renderCount).toBe(0); // Still should not render
    expect(staticRoute.innerHTML).toContain("Static content");
  });

  test("non-lazy routes DO re-render if content is cleared", async () => {
    const route = document.createElement("div");
    route.dataset.hypenType = "route";
    route.dataset.routePath = "/page";
    route.dataset.routeComponent = "Page";
    route.dataset.routeLazy = "false";
    document.body.appendChild(route);

    let renderCount = 0;
    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        renderCount++;
        element.innerHTML = `<div>Rendered ${renderCount}</div>`;
      },
      getState: () => ({}),
    };

    // updateRouteVisibility imported at top level

    // Navigate to page - no content, should render
    await updateRouteVisibility("/page", mockEngine as any);
    expect(renderCount).toBe(1);
    expect(route.innerHTML).toContain("Rendered 1");

    // Clear content manually
    route.innerHTML = "";

    // Navigate to page again - should re-render because content is missing
    await updateRouteVisibility("/page", mockEngine as any);
    expect(renderCount).toBe(2);
    expect(route.innerHTML).toContain("Rendered 2");
  });
});
