import { app } from "@hypen-space/core";

export default app
  .defineState({})
  .onAction("incrementQuantity", ({ action, context }) => {
    if (!context) return;
    const { id } = action.payload as any;
    console.log("🔼 [CartPage] incrementQuantity called with id:", id);
    // Get current item quantity from parent App state
    context.emit("updateQuantity", { id, delta: 1 });
  })
  .onAction("decrementQuantity", ({ action, context }) => {
    if (!context) return;
    const { id } = action.payload as any;
    console.log("🔽 [CartPage] decrementQuantity called with id:", id);
    context.emit("updateQuantity", { id, delta: -1 });
  })
  .onAction("removeFromCart", ({ action, context }) => {
    if (!context) return;
    const { id } = action.payload as any;
    console.log("🗑️ [CartPage] removeFromCart called with id:", id);
    context.emit("removeFromCart", { id });
  })
  .onAction("clearCart", ({ context }) => {
    if (!context) return;
    console.log("🧹 [CartPage] clearCart called");
    context.emit("clearCart", {});
  })
  .onAction("checkout", () => {
    // For now, just show an alert
    alert("Checkout functionality coming soon!");
    console.log("💳 Checkout initiated");
  })
  .build();

