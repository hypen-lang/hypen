/**
 * Integration tests for cart with lazy routing
 * Tests the full flow: add items, navigate, verify cart updates
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { updateRouteVisibility } from "../packages/core/src/components/builtin";

describe("Cart + Lazy Route Integration", () => {
  let dom: JSDOM;
  let document: Document;
  let window: Window & typeof globalThis;

  beforeEach(() => {
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

    (global as any).window = window;
    (global as any).document = document;
    (global as any).HTMLElement = window.HTMLElement;
    (global as any).Element = window.Element;
  });

  test("cart shows updated items after adding and navigating", async () => {
    // Setup routes
    const productsRoute = document.createElement("div");
    productsRoute.dataset.hypenType = "route";
    productsRoute.dataset.routePath = "/products";
    productsRoute.dataset.routeComponent = "ProductsPage";
    productsRoute.dataset.routeLazy = "true";
    document.body.appendChild(productsRoute);

    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    document.body.appendChild(cartRoute);

    // Mock cart state
    const cartState = {
      cart: [] as Array<{ id: number; title: string; price: number; quantity: number }>,
      cartCount: 0,
      cartTotal: 0,
    };

    // Mock engine that renders based on cart state
    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        if (component === "CartPage") {
          if (cartState.cart.length === 0) {
            element.innerHTML = `
              <div class="cart">
                <div class="empty">Your cart is empty</div>
                <div class="total">$0.00</div>
              </div>
            `;
          } else {
            const items = cartState.cart
              .map(
                (item) => `
              <div class="cart-item" data-id="${item.id}">
                <span>${item.title}</span>
                <span>Qty: ${item.quantity}</span>
                <span>$${item.price * item.quantity}</span>
                <button class="remove" data-id="${item.id}">Remove</button>
              </div>
            `
              )
              .join("");
            element.innerHTML = `
              <div class="cart">
                <div class="items">${items}</div>
                <div class="total">$${cartState.cartTotal.toFixed(2)}</div>
              </div>
            `;
          }
        } else if (component === "ProductsPage") {
          element.innerHTML = `
            <div class="products">
              <button class="add-to-cart" data-id="143" data-title="Item 1" data-price="79">Add Item 1</button>
              <button class="add-to-cart" data-id="141" data-title="Item 2" data-price="69">Add Item 2</button>
            </div>
          `;
        }
      },
      getState: () => cartState,
    };

    // updateRouteVisibility imported at top level

    // Step 1: Navigate to cart (initially empty)
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Your cart is empty");
    expect(cartRoute.innerHTML).toContain("$0.00");

    // Step 2: Navigate to products
    await updateRouteVisibility("/products", mockEngine as any);
    expect(productsRoute.style.display).toBe("flex");
    expect(cartRoute.style.display).toBe("none");

    // Step 3: Add items to cart (simulate user action)
    cartState.cart.push({ id: 143, title: "Item 1", price: 79, quantity: 2 });
    cartState.cart.push({ id: 141, title: "Item 2", price: 69, quantity: 1 });
    cartState.cartCount = 3;
    cartState.cartTotal = 227;

    // Step 4: Navigate back to cart
    await updateRouteVisibility("/cart", mockEngine as any);

    // Verify cart shows updated state
    expect(cartRoute.innerHTML).toContain("Item 1");
    expect(cartRoute.innerHTML).toContain("Item 2");
    expect(cartRoute.innerHTML).toContain("Qty: 2");
    expect(cartRoute.innerHTML).toContain("Qty: 1");
    expect(cartRoute.innerHTML).toContain("$227.00");
    expect(cartRoute.innerHTML).not.toContain("Your cart is empty");
  });

  test("remove from cart and re-navigate shows updated cart", async () => {
    const productsRoute = document.createElement("div");
    productsRoute.dataset.hypenType = "route";
    productsRoute.dataset.routePath = "/products";
    productsRoute.dataset.routeComponent = "ProductsPage";
    productsRoute.dataset.routeLazy = "true";
    document.body.appendChild(productsRoute);

    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    document.body.appendChild(cartRoute);

    // Start with items in cart
    const cartState = {
      cart: [
        { id: 143, title: "Item 1", price: 79, quantity: 2 },
        { id: 141, title: "Item 2", price: 69, quantity: 1 },
      ],
      cartCount: 3,
      cartTotal: 227,
    };

    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        if (component === "CartPage") {
          const items = cartState.cart
            .map(
              (item) => `
            <div class="cart-item" data-id="${item.id}">
              <span>${item.title}</span>
              <button class="remove" data-id="${item.id}">Remove</button>
            </div>
          `
            )
            .join("");
          element.innerHTML = `
            <div class="cart">
              <div class="items">${items}</div>
              <div class="count">Items: ${cartState.cartCount}</div>
              <div class="total">$${cartState.cartTotal.toFixed(2)}</div>
            </div>
          `;
        } else if (component === "ProductsPage") {
          element.innerHTML = `<div class="products">Products</div>`;
        }
      },
      getState: () => cartState,
    };

    // updateRouteVisibility imported at top level

    // Navigate to cart - shows 2 items
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Item 1");
    expect(cartRoute.innerHTML).toContain("Item 2");
    expect(cartRoute.innerHTML).toContain("Items: 3");
    expect(cartRoute.innerHTML).toContain("$227.00");

    // Navigate away
    await updateRouteVisibility("/products", mockEngine as any);

    // Remove item from cart
    cartState.cart = cartState.cart.filter((item) => item.id !== 143);
    cartState.cartCount = 1;
    cartState.cartTotal = 69;

    // Navigate back to cart - should show updated state
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).not.toContain("Item 1");
    expect(cartRoute.innerHTML).toContain("Item 2");
    expect(cartRoute.innerHTML).toContain("Items: 1");
    expect(cartRoute.innerHTML).toContain("$69.00");
  });

  test("multiple add/remove cycles maintain correct state", async () => {
    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    document.body.appendChild(cartRoute);

    const homeRoute = document.createElement("div");
    homeRoute.dataset.hypenType = "route";
    homeRoute.dataset.routePath = "/";
    homeRoute.dataset.routeComponent = "HomePage";
    homeRoute.dataset.routeLazy = "true";
    document.body.appendChild(homeRoute);

    const cartState = {
      cart: [] as Array<{ id: number; title: string }>,
    };

    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        if (component === "CartPage") {
          element.innerHTML = `<div>Cart items: ${cartState.cart.length}</div>`;
        } else {
          element.innerHTML = `<div>Home</div>`;
        }
      },
      getState: () => cartState,
    };

    // updateRouteVisibility imported at top level

    // Cycle 1: Empty cart
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Cart items: 0");

    // Add item, navigate away and back
    await updateRouteVisibility("/", mockEngine as any);
    cartState.cart.push({ id: 1, title: "Item 1" });
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Cart items: 1");

    // Add another item, navigate away and back
    await updateRouteVisibility("/", mockEngine as any);
    cartState.cart.push({ id: 2, title: "Item 2" });
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Cart items: 2");

    // Remove item, navigate away and back
    await updateRouteVisibility("/", mockEngine as any);
    cartState.cart = cartState.cart.filter((item) => item.id !== 1);
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Cart items: 1");

    // Clear cart, navigate away and back
    await updateRouteVisibility("/", mockEngine as any);
    cartState.cart = [];
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(cartRoute.innerHTML).toContain("Cart items: 0");
  });

  test("cart re-renders even when navigating directly (no intermediate route)", async () => {
    const cartRoute = document.createElement("div");
    cartRoute.dataset.hypenType = "route";
    cartRoute.dataset.routePath = "/cart";
    cartRoute.dataset.routeComponent = "CartPage";
    cartRoute.dataset.routeLazy = "true";
    document.body.appendChild(cartRoute);

    let renderCount = 0;
    const cartState = { items: 0 };

    const mockEngine = {
      renderLazyRoute: async (path: string, component: string, element: HTMLElement) => {
        renderCount++;
        element.innerHTML = `<div>Render #${renderCount}, Items: ${cartState.items}</div>`;
      },
      getState: () => cartState,
    };

    // updateRouteVisibility imported at top level

    // First visit
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(1);
    expect(cartRoute.innerHTML).toContain("Render #1, Items: 0");

    // Update state and visit again (no intermediate navigation)
    cartState.items = 5;
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(2);
    expect(cartRoute.innerHTML).toContain("Render #2, Items: 5");

    // Update state again and visit
    cartState.items = 10;
    await updateRouteVisibility("/cart", mockEngine as any);
    expect(renderCount).toBe(3);
    expect(cartRoute.innerHTML).toContain("Render #3, Items: 10");
  });
});
