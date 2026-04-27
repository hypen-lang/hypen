import { app } from "@hypen-space/core";

type CartItem = {
  id: number;
  title: string;
  price: number;
  image: string;
  quantity: number;
  itemTotal?: number; // Pre-calculated total for this item
};

export default app
  .defineState({
    currentPage: "home",
    cart: [] as CartItem[],
    cartCount: 0,
    cartTotal: 0,
    cartTotalFormatted: "$0.00", // Pre-formatted for display
  })
  .onCreated((state, context) => {
    // Initialize from URL hash
    const hash = window.location.hash.slice(1) || "/";
    state.currentPage = hash;

    // Listen for hash changes
    window.addEventListener("hashchange", () => {
      const newHash = window.location.hash.slice(1) || "/";
      state.currentPage = newHash;
      console.log("📍 Navigated to:", newHash);
    });

    // Load cart from localStorage
    const savedCart = localStorage.getItem("hypen-shop-cart");
    if (savedCart) {
      try {
        state.cart = JSON.parse(savedCart);
        updateCartTotals(state);
      } catch (e) {
        console.error("Failed to load cart from localStorage", e);
      }
    }

    // Listen for addToCart events from other modules (e.g., ProductsPage)
    if (context) {
      context.on("addToCart", (payload: any) => {
        const { id, title, price, image } = payload;

        // Check if item already in cart
        const existingItem = state.cart.find((item) => item.id === id);

        if (existingItem) {
          // Replace cart array to trigger reconciliation
          state.cart = state.cart.map((item) =>
            item.id === id
              ? { ...item, quantity: item.quantity + 1 }
              : item
          );
        } else {
          // Add new item - creates new array reference
          state.cart = [...state.cart, { id, title, price, image, quantity: 1 }];
        }

        updateCartTotals(state);
        saveCart(state.cart);
        console.log("🛒 Added to cart via event:", title);
      });

      context.on("updateQuantity", (payload: any) => {
        if (!payload || payload.id === undefined) {
          console.warn("⚠️ updateQuantity event missing id", payload);
          return;
        }

        const item = state.cart.find((entry) => entry.id === payload.id);
        if (!item) {
          return;
        }

        // Update quantity
        let newQuantity = item.quantity;
        if (payload.delta !== undefined) {
          newQuantity = Math.max(0, item.quantity + payload.delta);
        } else if (payload.quantity !== undefined) {
          newQuantity = Math.max(0, payload.quantity);
        }

        // Replace the entire cart array to trigger reconciliation
        // Mutating properties in place doesn't trigger list re-renders
        if (newQuantity === 0) {
          state.cart = state.cart.filter((entry) => entry.id !== payload.id);
        } else {
          state.cart = state.cart.map((entry) =>
            entry.id === payload.id
              ? { ...entry, quantity: newQuantity }
              : entry
          );
        }

        updateCartTotals(state);
        saveCart(state.cart);
      });

      context.on("removeFromCart", (payload: any) => {
        if (!payload || payload.id === undefined) {
          console.warn("⚠️ removeFromCart event missing id", payload);
          return;
        }

        state.cart = state.cart.filter((item) => item.id !== payload.id);
        updateCartTotals(state);
        saveCart(state.cart);
      });

      context.on("clearCart", () => {
        state.cart = [];
        updateCartTotals(state);
        saveCart(state.cart);
        console.log("🗑️ Cart cleared via event listener");
      });
    }
  })
  .onAction("addToCart", ({ action, state }) => {
    const { id, title, price, image } = action.payload as any;

    // Check if item already in cart
    const existingItem = state.cart.find((item) => item.id === id);

    if (existingItem) {
      // Replace cart array to trigger reconciliation
      state.cart = state.cart.map((item) =>
        item.id === id
          ? { ...item, quantity: item.quantity + 1 }
          : item
      );
    } else {
      // Add new item - creates new array reference
      state.cart = [...state.cart, { id, title, price, image, quantity: 1 }];
    }

    updateCartTotals(state);
    saveCart(state.cart);
    console.log("🛒 Added to cart:", title);
  })
  .onAction("removeFromCart", ({ action, state }) => {
    const { id } = action.payload as any;
    state.cart = state.cart.filter((item) => item.id !== id);
    updateCartTotals(state);
    saveCart(state.cart);
    console.log("🗑️ Removed from cart:", id);
  })
  .onAction("updateQuantity", ({ action, state }) => {
    const payload = action.payload as any;
    const item = state.cart.find((item) => item.id === payload.id);
    if (item) {
      // Calculate new quantity
      let newQuantity = item.quantity;
      if (payload.delta !== undefined) {
        newQuantity = Math.max(0, item.quantity + payload.delta);
      } else if (payload.quantity !== undefined) {
        newQuantity = Math.max(0, payload.quantity);
      }

      // Replace cart array to trigger reconciliation
      if (newQuantity === 0) {
        state.cart = state.cart.filter((item) => item.id !== payload.id);
      } else {
        state.cart = state.cart.map((item) =>
          item.id === payload.id
            ? { ...item, quantity: newQuantity }
            : item
        );
      }
    }
    updateCartTotals(state);
    saveCart(state.cart);
  })
  .onAction("clearCart", ({ state }) => {
    state.cart = [];
    updateCartTotals(state);
    saveCart(state.cart);
    console.log("🗑️ Cart cleared");
  })
  .build();

function updateCartTotals(state: any) {
  // Calculate item totals
  state.cart.forEach((item: CartItem) => {
    item.itemTotal = item.price * item.quantity;
  });

  state.cartCount = state.cart.reduce((sum: number, item: CartItem) => sum + item.quantity, 0);
  state.cartTotal = state.cart.reduce((sum: number, item: CartItem) => sum + (item.price * item.quantity), 0);
  state.cartTotalFormatted = `$${state.cartTotal.toFixed(2)}`;
}

function saveCart(cart: CartItem[]) {
  localStorage.setItem("hypen-shop-cart", JSON.stringify(cart));
}
