/**
 * Shopping App Server for Android Renderer
 * Complete shopping experience with all pages from example-bun
 *
 * Run with: bun run shop-server.ts
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";
import { RemoteServer } from "../../hypen-web/packages/server/src/index.ts";

// ============================================================================
// Types
// ============================================================================

type Product = {
  id: number;
  title: string;
  price: number;
  description: string;
  image: string;
  category: string;
};

type CartItem = {
  id: number;
  title: string;
  price: number;
  image: string;
  quantity: number;
  itemTotal: string;
};

type ShopState = {
  currentPage: string;
  products: Product[];
  cart: CartItem[];
  cartCount: number;
  cartTotal: string;
  counter: number;
  message: string;

  // Product displays (4 products)
  product1Title: string; product1Price: string; product1Image: string; product1Category: string;
  product2Title: string; product2Price: string; product2Image: string; product2Category: string;
  product3Title: string; product3Price: string; product3Image: string; product3Category: string;
  product4Title: string; product4Price: string; product4Image: string; product4Category: string;

  // Cart displays (up to 3 items)
  cartItem1Title: string; cartItem1Price: string; cartItem1Qty: string; cartItem1Total: string; cartItem1Visible: boolean; cartItem1Image: string;
  cartItem2Title: string; cartItem2Price: string; cartItem2Qty: string; cartItem2Total: string; cartItem2Visible: boolean; cartItem2Image: string;
  cartItem3Title: string; cartItem3Price: string; cartItem3Qty: string; cartItem3Total: string; cartItem3Visible: boolean; cartItem3Image: string;

  // Page visibility
  showHome: boolean;
  showProducts: boolean;
  showCart: boolean;
  showAbout: boolean;
  showEmptyCart: boolean;
  showCartItems: boolean;
};

// ============================================================================
// Sample Products
// ============================================================================

const sampleProducts: Product[] = [
  {
    id: 1,
    title: "Wireless Headphones",
    price: 79.99,
    description: "Premium sound quality with noise cancellation",
    image: "https://i.imgur.com/ZANVnHE.jpeg",
    category: "Electronics"
  },
  {
    id: 2,
    title: "Smart Watch",
    price: 199.99,
    description: "Track your fitness and stay connected",
    image: "https://i.imgur.com/Ro5z6Hy.jpeg",
    category: "Electronics"
  },
  {
    id: 3,
    title: "Running Shoes",
    price: 89.99,
    description: "Lightweight comfort for every run",
    image: "https://i.imgur.com/qNOjJje.jpeg",
    category: "Sports"
  },
  {
    id: 4,
    title: "Backpack",
    price: 49.99,
    description: "Durable and spacious for daily use",
    image: "https://i.imgur.com/BG8J0Fj.jpeg",
    category: "Accessories"
  }
];

// ============================================================================
// Helper Functions
// ============================================================================

function updateCartDisplay(state: ShopState) {
  state.cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  state.cartTotal = `$${total.toFixed(2)}`;

  state.showEmptyCart = state.cart.length === 0;
  state.showCartItems = state.cart.length > 0;

  for (let i = 0; i < 3; i++) {
    const item = state.cart[i];
    const n = i + 1;

    if (item) {
      (state as any)[`cartItem${n}Title`] = item.title;
      (state as any)[`cartItem${n}Price`] = `$${item.price.toFixed(2)}`;
      (state as any)[`cartItem${n}Qty`] = item.quantity.toString();
      (state as any)[`cartItem${n}Total`] = `$${(item.price * item.quantity).toFixed(2)}`;
      (state as any)[`cartItem${n}Image`] = item.image;
      (state as any)[`cartItem${n}Visible`] = true;
    } else {
      (state as any)[`cartItem${n}Title`] = "";
      (state as any)[`cartItem${n}Price`] = "";
      (state as any)[`cartItem${n}Qty`] = "0";
      (state as any)[`cartItem${n}Total`] = "";
      (state as any)[`cartItem${n}Image`] = "";
      (state as any)[`cartItem${n}Visible`] = false;
    }
  }
}

function updateProductDisplay(state: ShopState) {
  for (let i = 0; i < 4; i++) {
    const product = sampleProducts[i];
    const n = i + 1;
    (state as any)[`product${n}Title`] = product.title;
    (state as any)[`product${n}Price`] = `$${product.price.toFixed(2)}`;
    (state as any)[`product${n}Image`] = product.image;
    (state as any)[`product${n}Category`] = product.category;
  }
}

function setPage(state: ShopState, page: string) {
  state.currentPage = page;
  state.showHome = page === "home";
  state.showProducts = page === "products";
  state.showCart = page === "cart";
  state.showAbout = page === "about";
}

function addToCart(state: ShopState, product: Product) {
  const existing = state.cart.find(item => item.id === product.id);

  if (existing) {
    state.cart = state.cart.map(item =>
      item.id === product.id
        ? { ...item, quantity: item.quantity + 1, itemTotal: `$${((item.quantity + 1) * item.price).toFixed(2)}` }
        : item
    );
  } else {
    state.cart = [...state.cart, {
      id: product.id,
      title: product.title,
      price: product.price,
      image: product.image,
      quantity: 1,
      itemTotal: `$${product.price.toFixed(2)}`
    }];
  }

  updateCartDisplay(state);
  console.log(`🛒 Added: ${product.title}`);
}

function removeFromCart(state: ShopState, id: number) {
  state.cart = state.cart.filter(item => item.id !== id);
  updateCartDisplay(state);
}

function changeQuantity(state: ShopState, id: number, delta: number) {
  const item = state.cart.find(i => i.id === id);
  if (!item) return;

  if (item.quantity + delta <= 0) {
    removeFromCart(state, id);
  } else {
    state.cart = state.cart.map(i =>
      i.id === id
        ? { ...i, quantity: i.quantity + delta, itemTotal: `$${((i.quantity + delta) * i.price).toFixed(2)}` }
        : i
    );
    updateCartDisplay(state);
  }
}

// ============================================================================
// Shop Module
// ============================================================================

const shopModule = app
  .defineState<ShopState>({
    currentPage: "home",
    products: sampleProducts,
    cart: [],
    cartCount: 0,
    cartTotal: "$0.00",
    counter: 0,
    message: "Try the buttons!",

    product1Title: "", product1Price: "", product1Image: "", product1Category: "",
    product2Title: "", product2Price: "", product2Image: "", product2Category: "",
    product3Title: "", product3Price: "", product3Image: "", product3Category: "",
    product4Title: "", product4Price: "", product4Image: "", product4Category: "",

    cartItem1Title: "", cartItem1Price: "", cartItem1Qty: "0", cartItem1Total: "", cartItem1Visible: false, cartItem1Image: "",
    cartItem2Title: "", cartItem2Price: "", cartItem2Qty: "0", cartItem2Total: "", cartItem2Visible: false, cartItem2Image: "",
    cartItem3Title: "", cartItem3Price: "", cartItem3Qty: "0", cartItem3Total: "", cartItem3Visible: false, cartItem3Image: "",

    showHome: true,
    showProducts: false,
    showCart: false,
    showAbout: false,
    showEmptyCart: true,
    showCartItems: false
  })
  .onCreated(async (state) => {
    console.log("✓ Shop module created");
    updateProductDisplay(state);
    updateCartDisplay(state);
  })
  // Navigation
  .onAction("navigateHome", async ({ state }) => { setPage(state, "home"); })
  .onAction("navigateProducts", async ({ state }) => { setPage(state, "products"); })
  .onAction("navigateCart", async ({ state }) => { setPage(state, "cart"); })
  .onAction("navigateAbout", async ({ state }) => { setPage(state, "about"); })
  // Counter
  .onAction("increment", async ({ state }) => {
    state.counter += 1;
    state.message = state.counter > 10 ? "Amazing!" : state.counter > 5 ? "Keep going!" : "Nice!";
  })
  .onAction("decrement", async ({ state }) => {
    state.counter -= 1;
    state.message = state.counter < 0 ? "Going negative!" : state.counter === 0 ? "Reset!" : "Counting down...";
  })
  .onAction("reset", async ({ state }) => {
    state.counter = 0;
    state.message = "Counter reset!";
  })
  // Cart - Add products
  .onAction("addProduct1", async ({ state }) => { addToCart(state, sampleProducts[0]); })
  .onAction("addProduct2", async ({ state }) => { addToCart(state, sampleProducts[1]); })
  .onAction("addProduct3", async ({ state }) => { addToCart(state, sampleProducts[2]); })
  .onAction("addProduct4", async ({ state }) => { addToCart(state, sampleProducts[3]); })
  // Cart - Remove
  .onAction("removeCartItem1", async ({ state }) => { if (state.cart[0]) removeFromCart(state, state.cart[0].id); })
  .onAction("removeCartItem2", async ({ state }) => { if (state.cart[1]) removeFromCart(state, state.cart[1].id); })
  .onAction("removeCartItem3", async ({ state }) => { if (state.cart[2]) removeFromCart(state, state.cart[2].id); })
  // Cart - Quantity
  .onAction("incrementCartItem1", async ({ state }) => { if (state.cart[0]) changeQuantity(state, state.cart[0].id, 1); })
  .onAction("incrementCartItem2", async ({ state }) => { if (state.cart[1]) changeQuantity(state, state.cart[1].id, 1); })
  .onAction("incrementCartItem3", async ({ state }) => { if (state.cart[2]) changeQuantity(state, state.cart[2].id, 1); })
  .onAction("decrementCartItem1", async ({ state }) => { if (state.cart[0]) changeQuantity(state, state.cart[0].id, -1); })
  .onAction("decrementCartItem2", async ({ state }) => { if (state.cart[1]) changeQuantity(state, state.cart[1].id, -1); })
  .onAction("decrementCartItem3", async ({ state }) => { if (state.cart[2]) changeQuantity(state, state.cart[2].id, -1); })
  // Cart - Clear
  .onAction("clearCart", async ({ state }) => {
    state.cart = [];
    updateCartDisplay(state);
  })
  .onAction("checkout", async ({ state }) => {
    console.log("🎉 Checkout! Total:", state.cartTotal);
    state.cart = [];
    updateCartDisplay(state);
    setPage(state, "home");
  })
  .build();

// ============================================================================
// UI Template
// ============================================================================

const shopUI = `
Column {
  Row {
    Text("HYPEN")
      .fontSize(18)
      .fontWeight("bold")
      .color("#00ff88")
      .padding(8)

    Button {
      Text("Home")
        .color("#e0e0e0")
        .fontSize(12)
    }
      .onClick("@actions.navigateHome")
      .padding(8)
      .backgroundColor("#1a1a1a")
      .borderRadius(4)

    Button {
      Text("Products")
        .color("#e0e0e0")
        .fontSize(12)
    }
      .onClick("@actions.navigateProducts")
      .padding(8)
      .backgroundColor("#1a1a1a")
      .borderRadius(4)

    Button {
      Text("About")
        .color("#e0e0e0")
        .fontSize(12)
    }
      .onClick("@actions.navigateAbout")
      .padding(8)
      .backgroundColor("#1a1a1a")
      .borderRadius(4)

    Button {
      Text("Cart (@{state.cartCount})")
        .color("#0a0a0a")
        .fontSize(12)
    }
      .onClick("@actions.navigateCart")
      .padding(8)
      .backgroundColor("#00ff88")
      .borderRadius(4)
  }
  .padding(8)
  .backgroundColor("#0a0a0a")
  .scrollable(true)

  Column {
    Column {
      Text("Premium Products")
        .fontSize(32)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(8)

      Text("Discover our curated collection of quality items")
        .fontSize(16)
        .color("#888888")
        .padding(8)

      Row {
        Button {
          Text("Shop Now")
            .color("#0a0a0a")
            .fontWeight("bold")
        }
          .onClick("@actions.navigateProducts")
          .padding(16)
          .backgroundColor("#00ff88")
          .margin(8)

        Button {
          Text("Learn More")
            .color("#e0e0e0")
            .fontWeight("bold")
        }
          .onClick("@actions.navigateAbout")
          .padding(16)
          .backgroundColor("#2a2a2a")
          .margin(8)
      }
      .padding(16)
    }
    .padding(32)
    .backgroundColor("#0a0a0a")

    Text("Why Shop With Us")
      .fontSize(24)
      .fontWeight("bold")
      .color("#e0e0e0")
      .padding(16)

    Row {
      Column {
        Text("Fast")
          .fontSize(32)
          .color("#00ff88")
          .padding(8)

        Text("Fast Delivery")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("Quick shipping on all orders")
          .fontSize(12)
          .color("#888888")
          .padding(4)
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .weight(1)

      Column {
        Text("100%")
          .fontSize(32)
          .color("#00ff88")
          .padding(8)

        Text("Quality Guaranteed")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("100% authentic products")
          .fontSize(12)
          .color("#888888")
          .padding(4)
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .weight(1)

      Column {
        Text("30d")
          .fontSize(32)
          .color("#00ff88")
          .padding(8)

        Text("Easy Returns")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("30-day return policy")
          .fontSize(12)
          .color("#888888")
          .padding(4)
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .weight(1)
    }
    .padding(8)

    Column {
      Text("Interactive Demo")
        .fontSize(20)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(8)

      Text("Counter: @{state.counter}")
        .fontSize(32)
        .fontWeight("bold")
        .color("#00ff88")
        .padding(16)

      Row {
        Button {
          Text("-")
            .fontSize(20)
            .color("#e0e0e0")
        }
          .onClick("@actions.decrement")
          .padding(16)
          .backgroundColor("#2a2a2a")
          .margin(4)

        Button {
          Text("Reset")
            .color("#e0e0e0")
        }
          .onClick("@actions.reset")
          .padding(16)
          .backgroundColor("#2a2a2a")
          .margin(4)

        Button {
          Text("+")
            .fontSize(20)
            .color("#0a0a0a")
        }
          .onClick("@actions.increment")
          .padding(16)
          .backgroundColor("#00ff88")
          .margin(4)
      }
      .padding(8)

      Text("@{state.message}")
        .fontSize(14)
        .color("#888888")
        .padding(8)
    }
    .padding(24)
    .backgroundColor("#1a1a1a")
    .margin(16)

    Column {
      Text("Ready to Start Shopping?")
        .fontSize(22)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(8)

      Text("Browse our full collection")
        .fontSize(14)
        .color("#888888")
        .padding(8)

      Button {
        Text("View All Products")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.navigateProducts")
        .padding(16)
        .backgroundColor("#00ff88")
        .margin(16)
    }
    .padding(32)
    .backgroundColor("#0f0f0f")
    .margin(16)
  }
  .fillMaxSize(true)
  .visible("@{state.showHome}")
  .scrollable(true)

  Column {
    Text("Products")
      .fontSize(28)
      .fontWeight("bold")
      .color("#00ff88")
      .padding(16)

    Column {
      Image("@{state.product1Image}")
        .width(120)
        .height(120)
        .objectFit(cover)

      Text("@{state.product1Title}")
        .fontSize(16)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(4)

      Text("@{state.product1Category}")
        .fontSize(12)
        .color("#888888")
        .padding(2)

      Text("@{state.product1Price}")
        .fontSize(18)
        .fontWeight("bold")
        .color("#00ff88")
        .padding(4)

      Button {
        Text("Add to Cart")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.addProduct1")
        .padding(12)
        .backgroundColor("#00ff88")
        .margin(8)
    }
    .padding(16)
    .backgroundColor("#1a1a1a")
    .margin(8)

    Column {
      Image("@{state.product2Image}")
        .width(120)
        .height(120)
        .objectFit(cover)

      Text("@{state.product2Title}")
        .fontSize(16)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(4)

      Text("@{state.product2Category}")
        .fontSize(12)
        .color("#888888")
        .padding(2)

      Text("@{state.product2Price}")
        .fontSize(18)
        .fontWeight("bold")
        .color("#00ff88")
        .padding(4)

      Button {
        Text("Add to Cart")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.addProduct2")
        .padding(12)
        .backgroundColor("#00ff88")
        .margin(8)
    }
    .padding(16)
    .backgroundColor("#1a1a1a")
    .margin(8)

    Column {
      Image("@{state.product3Image}")
        .width(120)
        .height(120)
        .objectFit(cover)

      Text("@{state.product3Title}")
        .fontSize(16)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(4)

      Text("@{state.product3Category}")
        .fontSize(12)
        .color("#888888")
        .padding(2)

      Text("@{state.product3Price}")
        .fontSize(18)
        .fontWeight("bold")
        .color("#00ff88")
        .padding(4)

      Button {
        Text("Add to Cart")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.addProduct3")
        .padding(12)
        .backgroundColor("#00ff88")
        .margin(8)
    }
    .padding(16)
    .backgroundColor("#1a1a1a")
    .margin(8)

    Column {
      Image("@{state.product4Image}")
        .width(120)
        .height(120)
        .objectFit(cover)

      Text("@{state.product4Title}")
        .fontSize(16)
        .fontWeight("bold")
        .color("#e0e0e0")
        .padding(4)

      Text("@{state.product4Category}")
        .fontSize(12)
        .color("#888888")
        .padding(2)

      Text("@{state.product4Price}")
        .fontSize(18)
        .fontWeight("bold")
        .color("#00ff88")
        .padding(4)

      Button {
        Text("Add to Cart")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.addProduct4")
        .padding(12)
        .backgroundColor("#00ff88")
        .margin(8)
    }
    .padding(16)
    .backgroundColor("#1a1a1a")
    .margin(8)
  }
  .fillMaxSize(true)
  .visible("@{state.showProducts}")
  .scrollable(true)

  Column {
    Text("Shopping Cart")
      .fontSize(28)
      .fontWeight("bold")
      .color("#00ff88")
      .padding(16)

    Column {
      Text("Your cart is empty")
        .fontSize(16)
        .color("#888888")
        .padding(32)

      Button {
        Text("Continue Shopping")
          .color("#0a0a0a")
          .fontWeight("bold")
      }
        .onClick("@actions.navigateProducts")
        .padding(16)
        .backgroundColor("#00ff88")
        .margin(16)
    }
    .visible("@{state.showEmptyCart}")

    Column {
      Row {
        Image("@{state.cartItem1Image}")
          .width(80)
          .height(80)
          .objectFit(cover)

        Column {
          Text("@{state.cartItem1Title}")
            .fontSize(16)
            .fontWeight("bold")
            .color("#e0e0e0")
            .padding(4)

          Text("@{state.cartItem1Price}")
            .fontSize(14)
            .color("#00ff88")
            .padding(2)

          Row {
            Button {
              Text("-")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.decrementCartItem1")
              .padding(8)
              .backgroundColor("#ff006e")

            Text("@{state.cartItem1Qty}")
              .fontSize(16)
              .fontWeight("bold")
              .color("#e0e0e0")
              .padding(12)

            Button {
              Text("+")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.incrementCartItem1")
              .padding(8)
              .backgroundColor("#00ff88")
          }
        }
        .padding(8)
        .weight(1)

        Column {
          Text("@{state.cartItem1Total}")
            .fontSize(18)
            .fontWeight("bold")
            .color("#00ff88")
            .padding(4)

          Button {
            Text("Remove")
              .color("#e0e0e0")
          }
            .onClick("@actions.removeCartItem1")
            .padding(8)
            .backgroundColor("#2a2a2a")
        }
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .visible("@{state.cartItem1Visible}")

      Row {
        Image("@{state.cartItem2Image}")
          .width(80)
          .height(80)
          .objectFit(cover)

        Column {
          Text("@{state.cartItem2Title}")
            .fontSize(16)
            .fontWeight("bold")
            .color("#e0e0e0")
            .padding(4)

          Text("@{state.cartItem2Price}")
            .fontSize(14)
            .color("#00ff88")
            .padding(2)

          Row {
            Button {
              Text("-")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.decrementCartItem2")
              .padding(8)
              .backgroundColor("#ff006e")

            Text("@{state.cartItem2Qty}")
              .fontSize(16)
              .fontWeight("bold")
              .color("#e0e0e0")
              .padding(12)

            Button {
              Text("+")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.incrementCartItem2")
              .padding(8)
              .backgroundColor("#00ff88")
          }
        }
        .padding(8)
        .weight(1)

        Column {
          Text("@{state.cartItem2Total}")
            .fontSize(18)
            .fontWeight("bold")
            .color("#00ff88")
            .padding(4)

          Button {
            Text("Remove")
              .color("#e0e0e0")
          }
            .onClick("@actions.removeCartItem2")
            .padding(8)
            .backgroundColor("#2a2a2a")
        }
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .visible("@{state.cartItem2Visible}")

      Row {
        Image("@{state.cartItem3Image}")
          .width(80)
          .height(80)
          .objectFit(cover)

        Column {
          Text("@{state.cartItem3Title}")
            .fontSize(16)
            .fontWeight("bold")
            .color("#e0e0e0")
            .padding(4)

          Text("@{state.cartItem3Price}")
            .fontSize(14)
            .color("#00ff88")
            .padding(2)

          Row {
            Button {
              Text("-")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.decrementCartItem3")
              .padding(8)
              .backgroundColor("#ff006e")

            Text("@{state.cartItem3Qty}")
              .fontSize(16)
              .fontWeight("bold")
              .color("#e0e0e0")
              .padding(12)

            Button {
              Text("+")
                .color("#0a0a0a")
                .fontWeight("bold")
            }
              .onClick("@actions.incrementCartItem3")
              .padding(8)
              .backgroundColor("#00ff88")
          }
        }
        .padding(8)
        .weight(1)

        Column {
          Text("@{state.cartItem3Total}")
            .fontSize(18)
            .fontWeight("bold")
            .color("#00ff88")
            .padding(4)

          Button {
            Text("Remove")
              .color("#e0e0e0")
          }
            .onClick("@actions.removeCartItem3")
            .padding(8)
            .backgroundColor("#2a2a2a")
        }
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
      .visible("@{state.cartItem3Visible}")

      Column {
        Row {
          Text("Total:")
            .fontSize(20)
            .fontWeight("bold")
            .color("#e0e0e0")

          Spacer()
            .weight(1)

          Text("@{state.cartTotal}")
            .fontSize(24)
            .fontWeight("bold")
            .color("#00ff88")
        }
        .padding(16)

        Row {
          Button {
            Text("Clear Cart")
              .color("#e0e0e0")
              .fontWeight("bold")
          }
            .onClick("@actions.clearCart")
            .padding(16)
            .backgroundColor("#2a2a2a")
            .margin(8)
            .weight(1)

          Button {
            Text("Checkout")
              .color("#0a0a0a")
              .fontWeight("bold")
          }
            .onClick("@actions.checkout")
            .padding(16)
            .backgroundColor("#00ff88")
            .margin(8)
            .weight(1)
        }
      }
      .padding(16)
      .backgroundColor("#1a1a1a")
      .margin(8)
    }
    .visible("@{state.showCartItems}")
  }
  .fillMaxSize(true)
  .visible("@{state.showCart}")
  .scrollable(true)

  Column {
    Text("About Hypen Shop")
      .fontSize(28)
      .fontWeight("bold")
      .color("#00ff88")
      .padding(16)

    Column {
      Text("What is Hypen?")
        .fontSize(20)
        .fontWeight("bold")
        .color("#00e5ff")
        .padding(8)

      Text("Hypen is a modern declarative UI language designed for cross-platform application development. It combines the simplicity of declarative syntax with the power of native performance.")
        .fontSize(14)
        .color("#e0e0e0")
        .padding(8)

      Text("Key Technologies")
        .fontSize(20)
        .fontWeight("bold")
        .color("#00e5ff")
        .padding(8)

      Column {
        Text("Rust Parser")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("Blazing-fast parser written in Rust, compiled to WebAssembly")
          .fontSize(12)
          .color("#888888")
          .padding(4)

        Text("Bun Runtime")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("Ultra-fast JavaScript runtime with native TypeScript support")
          .fontSize(12)
          .color("#888888")
          .padding(4)

        Text("Reactive State")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("Proxy-based reactive state management for real-time UI updates")
          .fontSize(12)
          .color("#888888")
          .padding(4)

        Text("Jetpack Compose")
          .fontSize(16)
          .fontWeight("bold")
          .color("#e0e0e0")
          .padding(4)

        Text("Native Android rendering with Jetpack Compose")
          .fontSize(12)
          .color("#888888")
          .padding(4)
      }
      .padding(8)
    }
    .padding(24)
    .backgroundColor("#1a1a1a")
    .margin(16)

    Button {
      Text("Back to Home")
        .color("#0a0a0a")
        .fontWeight("bold")
    }
      .onClick("@actions.navigateHome")
      .padding(16)
      .backgroundColor("#00ff88")
      .margin(16)
  }
  .fillMaxSize(true)
  .visible("@{state.showAbout}")
  .scrollable(true)

  Column {
    Text("HYPEN")
      .fontSize(18)
      .fontWeight("bold")
      .color("#00ff88")
      .padding(8)

    Text("Built with Hypen + Bun + WebAssembly")
      .fontSize(12)
      .color("#888888")
      .padding(4)

    Text("2025 Hypen Shop")
      .fontSize(10)
      .color("#666666")
      .padding(4)
  }
  .padding(24)
  .backgroundColor("#0a0a0a")
}
.fillMaxSize(true)
.backgroundColor("#0a0a0a")
`;

// ============================================================================
// Server Setup
// ============================================================================

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

new RemoteServer()
  .module("Shop", shopModule)
  .ui(shopUI)
  .onConnection((client) => console.log(`✓ Client connected: ${client.id}`))
  .onDisconnection((client) => console.log(`✗ Client disconnected: ${client.id}`))
  .listen(PORT);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Hypen Shop - Android Server                     ║
╠═══════════════════════════════════════════════════════════╣
║  WebSocket URL: ws://localhost:${PORT}                       ║
║                                                           ║
║  For Android emulator use: ws://10.0.2.2:${PORT}             ║
║  For physical device use your machine's IP address        ║
║                                                           ║
║  Pages: Home | Products | Cart | About                    ║
║                                                           ║
║  Press Ctrl+C to stop                                     ║
╚═══════════════════════════════════════════════════════════╝
`);
