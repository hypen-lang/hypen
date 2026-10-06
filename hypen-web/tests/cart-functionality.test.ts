/**
 * Tests for cart functionality
 * Ensures add/remove operations work and state updates properly
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import { createObservableState } from "../packages/core/src/state";

type CartItem = {
  id: number;
  title: string;
  price: number;
  quantity: number;
  itemTotal?: number;
};

type CartState = {
  cart: CartItem[];
  cartCount: number;
  cartTotal: number;
  cartTotalFormatted: string;
};

describe("Cart Functionality", () => {
  // Helper function to calculate cart totals
  function updateCartTotals(state: CartState) {
    state.cart.forEach((item: CartItem) => {
      item.itemTotal = item.price * item.quantity;
    });
    state.cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    state.cartTotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    state.cartTotalFormatted = `$${state.cartTotal.toFixed(2)}`;
  }

  test("add item to empty cart", () => {
    const state: CartState = {
      cart: [],
      cartCount: 0,
      cartTotal: 0,
      cartTotalFormatted: "$0.00",
    };

    // Add item
    const newItem = { id: 143, title: "Test Item", price: 79, quantity: 1 };
    state.cart.push(newItem);
    updateCartTotals(state);

    expect(state.cart.length).toBe(1);
    expect(state.cart[0].id).toBe(143);
    expect(state.cartCount).toBe(1);
    expect(state.cartTotal).toBe(79);
    expect(state.cartTotalFormatted).toBe("$79.00");
  });

  test("add existing item increases quantity", () => {
    const state: CartState = {
      cart: [{ id: 143, title: "Test Item", price: 79, quantity: 1 }],
      cartCount: 1,
      cartTotal: 79,
      cartTotalFormatted: "$79.00",
    };

    // Add same item again
    const existingItem = state.cart.find((item) => item.id === 143);
    if (existingItem) {
      existingItem.quantity += 1;
    }
    updateCartTotals(state);

    expect(state.cart.length).toBe(1);
    expect(state.cart[0].quantity).toBe(2);
    expect(state.cartCount).toBe(2);
    expect(state.cartTotal).toBe(158);
    expect(state.cartTotalFormatted).toBe("$158.00");
  });

  test("remove item from cart", () => {
    const state: CartState = {
      cart: [
        { id: 143, title: "Item 1", price: 79, quantity: 2 },
        { id: 141, title: "Item 2", price: 69, quantity: 1 },
      ],
      cartCount: 3,
      cartTotal: 227,
      cartTotalFormatted: "$227.00",
    };

    // Remove item
    const idToRemove = 143;
    state.cart = state.cart.filter((item) => item.id !== idToRemove);
    updateCartTotals(state);

    expect(state.cart.length).toBe(1);
    expect(state.cart[0].id).toBe(141);
    expect(state.cartCount).toBe(1);
    expect(state.cartTotal).toBe(69);
    expect(state.cartTotalFormatted).toBe("$69.00");
  });

  test("remove all items leaves empty cart", () => {
    const state: CartState = {
      cart: [{ id: 143, title: "Item 1", price: 79, quantity: 1 }],
      cartCount: 1,
      cartTotal: 79,
      cartTotalFormatted: "$79.00",
    };

    // Remove item
    state.cart = state.cart.filter((item) => item.id !== 143);
    updateCartTotals(state);

    expect(state.cart.length).toBe(0);
    expect(state.cartCount).toBe(0);
    expect(state.cartTotal).toBe(0);
    expect(state.cartTotalFormatted).toBe("$0.00");
  });

  test("clear cart empties everything", () => {
    const state: CartState = {
      cart: [
        { id: 143, title: "Item 1", price: 79, quantity: 2 },
        { id: 141, title: "Item 2", price: 69, quantity: 3 },
        { id: 146, title: "Item 3", price: 35, quantity: 1 },
      ],
      cartCount: 6,
      cartTotal: 332,
      cartTotalFormatted: "$332.00",
    };

    // Clear cart
    state.cart = [];
    updateCartTotals(state);

    expect(state.cart.length).toBe(0);
    expect(state.cartCount).toBe(0);
    expect(state.cartTotal).toBe(0);
    expect(state.cartTotalFormatted).toBe("$0.00");
  });

  test("update quantity increases item total", () => {
    const state: CartState = {
      cart: [{ id: 143, title: "Item 1", price: 79, quantity: 1 }],
      cartCount: 1,
      cartTotal: 79,
      cartTotalFormatted: "$79.00",
    };

    // Update quantity
    const item = state.cart.find((i) => i.id === 143);
    if (item) {
      item.quantity = 5;
    }
    updateCartTotals(state);

    expect(state.cart[0].quantity).toBe(5);
    expect(state.cart[0].itemTotal).toBe(395);
    expect(state.cartCount).toBe(5);
    expect(state.cartTotal).toBe(395);
    expect(state.cartTotalFormatted).toBe("$395.00");
  });

  test("update quantity to 0 removes item", () => {
    const state: CartState = {
      cart: [{ id: 143, title: "Item 1", price: 79, quantity: 1 }],
      cartCount: 1,
      cartTotal: 79,
      cartTotalFormatted: "$79.00",
    };

    // Update quantity to 0
    const item = state.cart.find((i) => i.id === 143);
    if (item) {
      item.quantity = 0;
    }

    // Remove items with 0 quantity
    if (item && item.quantity === 0) {
      state.cart = state.cart.filter((i) => i.id !== 143);
    }
    updateCartTotals(state);

    expect(state.cart.length).toBe(0);
    expect(state.cartCount).toBe(0);
    expect(state.cartTotal).toBe(0);
  });

  test("multiple operations maintain correct totals", () => {
    const state: CartState = {
      cart: [],
      cartCount: 0,
      cartTotal: 0,
      cartTotalFormatted: "$0.00",
    };

    // Add first item
    state.cart.push({ id: 143, title: "Item 1", price: 79, quantity: 1 });
    updateCartTotals(state);
    expect(state.cartTotal).toBe(79);

    // Add second item
    state.cart.push({ id: 141, title: "Item 2", price: 69, quantity: 1 });
    updateCartTotals(state);
    expect(state.cartTotal).toBe(148);

    // Increase quantity of first item
    const item1 = state.cart.find((i) => i.id === 143);
    if (item1) item1.quantity = 2;
    updateCartTotals(state);
    expect(state.cartTotal).toBe(227);

    // Add third item
    state.cart.push({ id: 146, title: "Item 3", price: 35, quantity: 3 });
    updateCartTotals(state);
    expect(state.cartTotal).toBe(332);

    // Remove second item
    state.cart = state.cart.filter((item) => item.id !== 141);
    updateCartTotals(state);
    expect(state.cartTotal).toBe(263);

    // Clear cart
    state.cart = [];
    updateCartTotals(state);
    expect(state.cartTotal).toBe(0);
    expect(state.cartCount).toBe(0);
  });
});

describe("Cart State Reactivity", () => {
  test("observable state detects cart additions", async () => {
    let changeCount = 0;
    let lastChange: any = null;

    const state = createObservableState(
      {
        cart: [] as CartItem[],
        cartCount: 0,
      },
      {
        onChange: (change) => {
          changeCount++;
          lastChange = change;
        },
      }
    );

    // Add item to cart
    state.cart.push({ id: 143, title: "Test", price: 79, quantity: 1 });

    // Wait for microtask
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(changeCount).toBeGreaterThan(0);
    // Engine canonical: array-length changes emit per-index paths.
    expect(lastChange.paths).toContain("cart.0");
  });

  test("observable state detects cart removals", async () => {
    let changeCount = 0;

    const state = createObservableState(
      {
        cart: [{ id: 143, title: "Test", price: 79, quantity: 1 }] as CartItem[],
      },
      {
        onChange: () => {
          changeCount++;
        },
      }
    );

    // Remove item
    state.cart = state.cart.filter((item) => item.id !== 143);

    // Wait for microtask
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(changeCount).toBeGreaterThan(0);
  });

  test("observable state detects quantity changes", async () => {
    let changeCount = 0;
    let lastChange: any = null;

    const state = createObservableState(
      {
        cart: [{ id: 143, title: "Test", price: 79, quantity: 1 }] as CartItem[],
      },
      {
        onChange: (change) => {
          changeCount++;
          lastChange = change;
        },
      }
    );

    // Update quantity
    state.cart[0].quantity = 5;

    // Wait for microtask
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(changeCount).toBeGreaterThan(0);
    expect(lastChange.paths.some((p: string) => p.includes("quantity"))).toBe(true);
  });

  test("observable state batches multiple changes", async () => {
    let changeCount = 0;

    const state = createObservableState(
      {
        cart: [] as CartItem[],
        cartCount: 0,
        cartTotal: 0,
      },
      {
        onChange: () => {
          changeCount++;
        },
      }
    );

    // Make multiple synchronous changes
    state.cart.push({ id: 143, title: "Test", price: 79, quantity: 1 });
    state.cartCount = 1;
    state.cartTotal = 79;

    // Wait for microtask (batching)
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Should batch into single onChange call
    expect(changeCount).toBe(1);
  });
});

describe("Cart Integration with Module System", () => {
  test("cart module action handlers update state", async () => {
    let stateChanges: any[] = [];
    const actionHandlers = new Map<string, (action: any) => void | Promise<void>>();

    // Create mock engine
    const mockEngine = {
      setModule: () => {},
      onAction: (name: string, handler: (action: any) => void | Promise<void>) => {
        actionHandlers.set(name, handler);
      },
      // Now receives sparse changedValues instead of full state
      updateStateSparse: (paths: string[], changedValues: Record<string, any>) => {
        stateChanges.push({ paths, changedValues });
      },
    };

    // Build cart module definition
    const cartModuleDef = app
      .defineState({
        cart: [] as CartItem[],
        cartCount: 0,
        cartTotal: 0,
        cartTotalFormatted: "$0.00",
      })
      .onAction("addToCart", ({ action, state }) => {
        const { id, title, price } = action.payload as any;
        const existingItem = state.cart.find((item) => item.id === id);

        if (existingItem) {
          existingItem.quantity += 1;
        } else {
          state.cart.push({ id, title, price, quantity: 1 });
        }

        // Update totals
        state.cart.forEach((item) => {
          item.itemTotal = item.price * item.quantity;
        });
        state.cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
        state.cartTotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        state.cartTotalFormatted = `$${state.cartTotal.toFixed(2)}`;
      })
      .onAction("removeFromCart", ({ action, state }) => {
        const { id } = action.payload as any;
        state.cart = state.cart.filter((item) => item.id !== id);

        // Update totals
        state.cart.forEach((item) => {
          item.itemTotal = item.price * item.quantity;
        });
        state.cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
        state.cartTotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        state.cartTotalFormatted = `$${state.cartTotal.toFixed(2)}`;
      })
      .build();

    // Create module instance
    const instance = new HypenModuleInstance(mockEngine as any, cartModuleDef);

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Dispatch addToCart action to trigger state changes
    const addToCartHandler = actionHandlers.get("__hypen_scoped::addToCart");
    expect(addToCartHandler).toBeDefined();

    await addToCartHandler!({
      name: "addToCart",
      payload: { id: 1, title: "Test Item", price: 99.99 }
    });

    // Wait for state change notification
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify state change was notified (sparse updates)
    expect(stateChanges.length).toBeGreaterThan(0);

    // Verify the module state was updated correctly
    const state = instance.getState() as any;
    expect(state.cart.length).toBe(1);
    expect(state.cartCount).toBe(1);
  });
});
