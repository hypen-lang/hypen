import { app } from "@hypen-space/core";

type Item = { name: string; priceCents: number; qty: number };

type CartState = {
  items: Item[];
  /** Total quantity. Pricing subscribes to this to follow the cart. */
  count: number;
  /** Set by Pricing (the Rust module) through the `applyDiscount` action. */
  discountPercent: number;
  discountNote: string;
};

function add(state: CartState, name: string, priceCents: number): void {
  const existing = state.items.find((item) => item.name === name);
  if (existing) existing.qty += 1;
  else state.items.push({ name, priceCents, qty: 1 });
  state.count += 1;
}

export default app
  .module("Cart")
  .defineState<CartState>({ items: [], count: 0, discountPercent: 0, discountNote: "No discount yet." })
  .onAction("addCoffee", ({ state }) => add(state, "Coffee", 450))
  .onAction("addGrinder", ({ state }) => add(state, "Grinder", 4800))
  .onAction("clear", ({ state }) => {
    state.items = [];
    state.count = 0;
  })
  // TypeScript -> Rust: dispatch an action to the hosted module. `Pricing`
  // is reached like any other module; the reference defers the call, so it
  // is safe from inside a handler.
  .onAction("requestQuote", async ({ context }) => {
    await context.getModule("pricing").dispatch("quote");
  })
  // Rust -> TypeScript: Pricing dispatches this (it holds a `dispatches`
  // grant on Cart in hypen.json). It arrives as an ordinary action;
  // `action.sender` names the module that sent it.
  .onAction<{ percent: number }>("applyDiscount", ({ action, state }) => {
    const percent = Number(action.payload?.percent ?? 0);
    state.discountPercent = percent;
    state.discountNote =
      percent > 0
        ? `${percent}% off, decided by the "${action.sender}" module.`
        : `Discount removed by the "${action.sender}" module.`;
  })
  .build();
