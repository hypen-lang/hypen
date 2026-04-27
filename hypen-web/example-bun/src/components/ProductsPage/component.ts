import { app } from "@hypen-space/core";

type Product = {
  id: number;
  title: string;
  price: number;
  description: string;
  images: string[];
  category: {
    id: number;
    name: string;
    image: string;
  };
};

export default app
  .defineState({
    products: [] as Product[],
    loading: true,
    error: null as string | null,
    page: 0,
    hasMore: true,
    loadingMore: false,
  })
  .onCreated(async (state) => {
    console.log("📦 Fetching initial products from API...");
    try {
      const response = await fetch(`https://api.escuelajs.co/api/v1/products?offset=0&limit=12`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      state.products = data;
      state.loading = false;
      state.page = 1;
      state.hasMore = data.length === 12;
      console.log(`✅ Loaded ${data.length} products`);
    } catch (e: any) {
      state.error = e.message || "Failed to load products";
      state.loading = false;
      console.error("❌ Failed to fetch products:", e);
    }
  })
  .onAction("loadMore", async ({ action, state }) => {
    const { nearBottom } = action.payload as any;

    // Only load more if near bottom, not already loading, and has more items
    if (!nearBottom || state.loadingMore || !state.hasMore || state.loading) {
      return;
    }

    console.log("📦 Loading more products...");
    state.loadingMore = true;

    try {
      const offset = state.page * 12;
      const response = await fetch(`https://api.escuelajs.co/api/v1/products?offset=${offset}&limit=12`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      if (data.length > 0) {
        state.products = [...state.products, ...data];
        state.page += 1;
        state.hasMore = data.length === 12;
        console.log(`✅ Loaded ${data.length} more products (total: ${state.products.length})`);
      } else {
        state.hasMore = false;
        console.log("✅ No more products to load");
      }
    } catch (e: any) {
      console.error("❌ Failed to load more products:", e);
    } finally {
      state.loadingMore = false;
    }
  })
  .onAction("addToCart", ({ action, context }) => {
    if (!context) return;

    // Get the product data from the action payload
    const { id, title, price, image } = action.payload as any;

    // Get the App module to trigger its addToCart action
    const appModule = context.getModule("App");
    if (appModule) {
      // Directly call the App's addToCart via global emit
      context.emit("addToCart", { id, title, price, image });
    }

    console.log("🛒 Adding to cart:", title);
  })
  .build();

