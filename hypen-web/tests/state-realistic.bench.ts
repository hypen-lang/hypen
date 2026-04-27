/**
 * Realistic state size benchmark
 *
 * Measures actual state sizes for common app scenarios
 */

import { describe, test, expect } from "bun:test";
import { WasmEngine } from "../../hypen-engine-rs/pkg/nodejs/hypen_engine.js";

// Realistic product object
function createProduct(id: number) {
  return {
    id: `prod_${id}`,
    name: `Product ${id} - Premium Quality Item with Long Name`,
    description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
    price: 99.99 + id,
    originalPrice: 129.99 + id,
    currency: "USD",
    inStock: id % 3 !== 0,
    stockCount: Math.floor(Math.random() * 100),
    rating: 4.5,
    reviewCount: Math.floor(Math.random() * 1000),
    category: ["Electronics", "Computers", "Accessories"][id % 3],
    subcategory: "Subcategory " + (id % 10),
    brand: "Brand " + (id % 20),
    sku: `SKU-${id.toString().padStart(6, '0')}`,
    images: [
      `https://example.com/products/${id}/image1.jpg`,
      `https://example.com/products/${id}/image2.jpg`,
      `https://example.com/products/${id}/image3.jpg`,
    ],
    thumbnail: `https://example.com/products/${id}/thumb.jpg`,
    tags: ["featured", "sale", "new-arrival"].slice(0, (id % 3) + 1),
    attributes: {
      color: ["Red", "Blue", "Green", "Black"][id % 4],
      size: ["S", "M", "L", "XL"][id % 4],
      weight: `${(id % 10) + 1}kg`,
      dimensions: { width: 10, height: 20, depth: 5 },
    },
    shipping: {
      free: id % 2 === 0,
      estimatedDays: 3 + (id % 5),
      weight: 1.5,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Realistic user profile
function createUserProfile() {
  return {
    id: "user_12345",
    email: "user@example.com",
    firstName: "John",
    lastName: "Doe",
    displayName: "JohnD",
    avatar: "https://example.com/avatars/user_12345.jpg",
    bio: "Software developer passionate about building great products. Lorem ipsum dolor sit amet.",
    location: {
      city: "San Francisco",
      state: "CA",
      country: "USA",
      timezone: "America/Los_Angeles",
    },
    preferences: {
      theme: "dark",
      language: "en",
      currency: "USD",
      notifications: {
        email: true,
        push: true,
        sms: false,
        marketing: false,
      },
      privacy: {
        profileVisible: true,
        showEmail: false,
        showActivity: true,
      },
    },
    subscription: {
      plan: "premium",
      startDate: "2024-01-01",
      endDate: "2025-01-01",
      autoRenew: true,
      paymentMethod: {
        type: "card",
        last4: "4242",
        brand: "visa",
      },
    },
    stats: {
      ordersCount: 42,
      totalSpent: 1234.56,
      reviewsWritten: 15,
      wishlistItems: 8,
      loyaltyPoints: 5000,
    },
    addresses: [
      {
        id: "addr_1",
        type: "shipping",
        name: "John Doe",
        street: "123 Main Street",
        apt: "Apt 4B",
        city: "San Francisco",
        state: "CA",
        zip: "94102",
        country: "USA",
        isDefault: true,
      },
      {
        id: "addr_2",
        type: "billing",
        name: "John Doe",
        street: "456 Oak Avenue",
        city: "San Francisco",
        state: "CA",
        zip: "94103",
        country: "USA",
        isDefault: false,
      },
    ],
    recentlyViewed: Array.from({ length: 10 }, (_, i) => `prod_${i + 100}`),
    createdAt: "2023-01-15T10:30:00Z",
    lastLoginAt: new Date().toISOString(),
  };
}

// Cart item
function createCartItem(productId: number) {
  return {
    productId: `prod_${productId}`,
    name: `Product ${productId}`,
    price: 99.99,
    quantity: Math.floor(Math.random() * 3) + 1,
    thumbnail: `https://example.com/products/${productId}/thumb.jpg`,
    selectedOptions: {
      color: "Blue",
      size: "M",
    },
  };
}

// UI state
function createUIState() {
  return {
    isLoading: false,
    isSidebarOpen: false,
    isModalOpen: false,
    modalType: null,
    activeTab: "products",
    searchQuery: "",
    filters: {
      category: null,
      priceRange: { min: 0, max: 1000 },
      inStockOnly: false,
      rating: 0,
      sortBy: "relevance",
      sortOrder: "desc",
    },
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: 300,
      totalPages: 15,
    },
    selectedProductId: null,
    compareList: [],
    toast: null,
    errors: {},
  };
}

function measureStateSize(state: any): number {
  return JSON.stringify(state).length;
}

describe("Realistic State Size Analysis", () => {

  test("measure typical e-commerce app state sizes", () => {
    console.log("\n📊 Realistic E-commerce App State Sizes:\n");

    // Small app - just browsing
    const smallAppState = {
      user: null,
      ui: createUIState(),
      products: Array.from({ length: 20 }, (_, i) => createProduct(i)),
      cart: { items: [], total: 0 },
    };
    console.log(`   Small app (20 products, no user): ${(measureStateSize(smallAppState) / 1024).toFixed(1)}KB`);

    // Medium app - logged in user with cart
    const mediumAppState = {
      user: createUserProfile(),
      ui: createUIState(),
      products: Array.from({ length: 50 }, (_, i) => createProduct(i)),
      cart: {
        items: Array.from({ length: 5 }, (_, i) => createCartItem(i)),
        total: 499.95,
      },
    };
    console.log(`   Medium app (50 products, user, cart): ${(measureStateSize(mediumAppState) / 1024).toFixed(1)}KB`);

    // Large app - full catalog page
    const largeAppState = {
      user: createUserProfile(),
      ui: createUIState(),
      products: Array.from({ length: 100 }, (_, i) => createProduct(i)),
      cart: {
        items: Array.from({ length: 10 }, (_, i) => createCartItem(i)),
        total: 999.90,
      },
      categories: Array.from({ length: 50 }, (_, i) => ({
        id: `cat_${i}`,
        name: `Category ${i}`,
        productCount: Math.floor(Math.random() * 100),
      })),
    };
    console.log(`   Large app (100 products, categories): ${(measureStateSize(largeAppState) / 1024).toFixed(1)}KB`);

    // Very large app - 300 products
    const veryLargeAppState = {
      user: createUserProfile(),
      ui: createUIState(),
      products: Array.from({ length: 300 }, (_, i) => createProduct(i)),
      cart: {
        items: Array.from({ length: 15 }, (_, i) => createCartItem(i)),
        total: 1499.85,
      },
      categories: Array.from({ length: 100 }, (_, i) => ({
        id: `cat_${i}`,
        name: `Category ${i}`,
        description: "Category description with some text",
        productCount: Math.floor(Math.random() * 100),
        image: `https://example.com/categories/${i}.jpg`,
      })),
      recommendations: Array.from({ length: 20 }, (_, i) => createProduct(i + 1000)),
    };
    console.log(`   Very large app (300 products + extras): ${(measureStateSize(veryLargeAppState) / 1024).toFixed(1)}KB`);

    // Individual object sizes
    console.log("\n   Individual object sizes:");
    console.log(`   - Single product: ${measureStateSize(createProduct(1))} bytes`);
    console.log(`   - User profile: ${(measureStateSize(createUserProfile()) / 1024).toFixed(1)}KB`);
    console.log(`   - UI state: ${measureStateSize(createUIState())} bytes`);
    console.log(`   - Cart item: ${measureStateSize(createCartItem(1))} bytes`);
  });

  test("benchmark realistic 300-product app", () => {
    const engine = new WasmEngine();
    engine.setRenderCallback(() => {});

    const state = {
      user: createUserProfile(),
      ui: createUIState(),
      products: Array.from({ length: 300 }, (_, i) => createProduct(i)),
      cart: {
        items: Array.from({ length: 10 }, (_, i) => createCartItem(i)),
        total: 999.90,
      },
      counter: 0, // For testing updates
    };

    const stateSize = measureStateSize(state);
    console.log(`\n📊 300-Product App Benchmark (${(stateSize / 1024).toFixed(1)}KB):`);

    engine.setModule("test", [], Object.keys(state), state);
    engine.renderSource('Column { Text("Cart: @{state.cart.total}") }');

    // Simulate typical updates
    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      state.counter = i;
      state.ui.isLoading = i % 2 === 0;
      engine.updateState(state);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`   ${iterations} full state updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(2)}ms per update`);
    console.log(`   ${(1000 / 60).toFixed(2)}ms budget per frame @ 60fps`);
    console.log(`   Can maintain 60fps: ${(elapsed / iterations) < (1000 / 60) ? '✅ YES' : '❌ NO'}`);
  });

  test("benchmark with incremental updates (what we could optimize to)", () => {
    const engine = new WasmEngine();
    engine.setRenderCallback(() => {});

    // Start with minimal state for incremental approach
    const minimalState = {
      cartTotal: 999.90,
      isLoading: false,
      counter: 0,
    };

    engine.setModule("test", [], Object.keys(minimalState), minimalState);
    engine.renderSource('Column { Text("Cart: @{state.cartTotal}") }');

    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      minimalState.counter = i;
      minimalState.isLoading = i % 2 === 0;
      engine.updateState(minimalState);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`\n📊 Incremental Update Simulation (only bound values):`);
    console.log(`   State size: ${measureStateSize(minimalState)} bytes`);
    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);
  });
});
