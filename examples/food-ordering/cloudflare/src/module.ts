import { app } from "@hypen-space/core/app";

type Category = { id: string; name: string; icon: string };
type Restaurant = {
  id: string;
  name: string;
  cuisine: string;
  imageUrl: string;
  rating: number;
  ratingCount: number;
  deliveryTimeMin: number;
  deliveryTimeMax: number;
  deliveryFee: number;
  distanceKm: number;
  isOpen: boolean;
  description: string;
  categoryId: string;
};
type MenuItem = {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  imageUrl: string;
  price: number;
  isVegetarian: boolean;
  isPopular: boolean;
  section: string;
  cartQuantity: number;
};
type CartItem = {
  id: string;
  menuItemId: string;
  restaurantId: string;
  name: string;
  imageUrl: string;
  price: number;
  quantity: number;
  lineTotal: number;
};
type OrderSummary = {
  id: string;
  restaurantName: string;
  status: string;
  statusLabel: string;
  total: number;
  itemsSummary: string;
  placedAt: string;
};
type OrderDetail = {
  id: string;
  restaurantId: string;
  restaurantName: string;
  status: string;
  statusLabel: string;
  statusDescription: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  address: string;
  placedAt: string;
  items: Array<{
    id: string;
    menuItemId: string;
    name: string;
    imageUrl: string;
    price: number;
    quantity: number;
    lineTotal: number;
  }>;
};

export type AppState = {
  currentUser: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string;
    address: string;
    phone: string;
  };
  location: string;
  locationKind: "home" | "search" | "cart" | "orders" | "profile" | "restaurant" | "order";
  selectedRestaurantId: string;
  selectedOrderId: string;
  cartCount: number;
  categories: Category[];
  selectedCategory: string;
  restaurants: Restaurant[];
  restaurant: Restaurant;
  menuItems: MenuItem[];
  isFavorite: boolean;
  cartSubtotal: number;
  cartItems: CartItem[];
  cartRestaurantName: string;
  cartDeliveryFee: number;
  cartTotal: number;
  orders: OrderSummary[];
  order: OrderDetail;
  totalOrders: number;
  totalSpent: number;
  favoriteCount: number;
  searchQuery: string;
  suggestions: { id: string; name: string }[];
  searchResults: Restaurant[];
};

const categories: Category[] = [
  { id: "cat_all", name: "All", icon: "utensils" },
  { id: "cat_pizza", name: "Pizza", icon: "pizza" },
  { id: "cat_burger", name: "Burgers", icon: "burger" },
  { id: "cat_sushi", name: "Sushi", icon: "fish" },
  { id: "cat_asian", name: "Asian", icon: "noodles" },
  { id: "cat_mex", name: "Mexican", icon: "taco" },
  { id: "cat_coffee", name: "Coffee", icon: "coffee" },
];

const restaurants: Restaurant[] = [
  { id: "r1", name: "Napoli Pizzeria", cuisine: "Italian", imageUrl: "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&h=600&fit=crop", rating: 4.8, ratingCount: 2043, deliveryTimeMin: 20, deliveryTimeMax: 30, deliveryFee: 2.99, distanceKm: 1.2, isOpen: true, description: "Wood-fired Neapolitan pizza with San Marzano tomatoes.", categoryId: "cat_pizza" },
  { id: "r2", name: "Smash & Stack", cuisine: "American", imageUrl: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&h=600&fit=crop", rating: 4.6, ratingCount: 1580, deliveryTimeMin: 15, deliveryTimeMax: 25, deliveryFee: 1.99, distanceKm: 0.8, isOpen: true, description: "Smash burgers with hand-cut fries and milkshakes.", categoryId: "cat_burger" },
  { id: "r3", name: "Sakura Sushi Bar", cuisine: "Japanese", imageUrl: "https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800&h=600&fit=crop", rating: 4.9, ratingCount: 3120, deliveryTimeMin: 25, deliveryTimeMax: 40, deliveryFee: 3.99, distanceKm: 2.1, isOpen: true, description: "Omakase-grade sushi delivered straight to your door.", categoryId: "cat_sushi" },
  { id: "r4", name: "Bangkok Wok", cuisine: "Thai", imageUrl: "https://images.unsplash.com/photo-1559314809-0d155014e29e?w=800&h=600&fit=crop", rating: 4.5, ratingCount: 910, deliveryTimeMin: 20, deliveryTimeMax: 35, deliveryFee: 2.49, distanceKm: 1.7, isOpen: true, description: "Thai street food with bold, bright flavor.", categoryId: "cat_asian" },
  { id: "r5", name: "El Jefe Taqueria", cuisine: "Mexican", imageUrl: "https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=800&h=600&fit=crop", rating: 4.7, ratingCount: 1340, deliveryTimeMin: 15, deliveryTimeMax: 25, deliveryFee: 1.49, distanceKm: 0.9, isOpen: true, description: "Tacos al pastor, burritos, and handmade salsas.", categoryId: "cat_mex" },
  { id: "r7", name: "Daily Grind Cafe", cuisine: "Coffee & Bakery", imageUrl: "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=800&h=600&fit=crop", rating: 4.6, ratingCount: 890, deliveryTimeMin: 10, deliveryTimeMax: 20, deliveryFee: 1.49, distanceKm: 0.7, isOpen: true, description: "Specialty coffee, pastries, and all-day brunch.", categoryId: "cat_coffee" },
];

const menuItems: MenuItem[] = [
  { id: "m101", restaurantId: "r1", name: "Margherita", description: "Tomato, fresh mozzarella, basil, olive oil.", imageUrl: "https://images.unsplash.com/photo-1604068549290-dea0e4a305ca?w=600&h=600&fit=crop", price: 14.5, isVegetarian: true, isPopular: true, section: "Pizzas", cartQuantity: 0 },
  { id: "m102", restaurantId: "r1", name: "Pepperoni", description: "Tomato, mozzarella, spicy pepperoni.", imageUrl: "https://images.unsplash.com/photo-1628840042765-356cda07504e?w=600&h=600&fit=crop", price: 16, isVegetarian: false, isPopular: true, section: "Pizzas", cartQuantity: 0 },
  { id: "m201", restaurantId: "r2", name: "Classic Smash", description: "Double smashed patty, cheese, pickles, house sauce.", imageUrl: "https://images.unsplash.com/photo-1550317138-10000687a72b?w=600&h=600&fit=crop", price: 12, isVegetarian: false, isPopular: true, section: "Burgers", cartQuantity: 0 },
  { id: "m202", restaurantId: "r2", name: "Bacon Smash", description: "Bacon, aged cheddar, caramelized onion.", imageUrl: "https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=600&h=600&fit=crop", price: 14.5, isVegetarian: false, isPopular: true, section: "Burgers", cartQuantity: 0 },
  { id: "m301", restaurantId: "r3", name: "Salmon Nigiri", description: "Fresh salmon over seasoned rice.", imageUrl: "https://images.unsplash.com/photo-1553621042-f6e147245754?w=600&h=600&fit=crop", price: 15, isVegetarian: false, isPopular: true, section: "Nigiri", cartQuantity: 0 },
  { id: "m302", restaurantId: "r3", name: "Dragon Roll", description: "Eel, avocado, cucumber, unagi glaze.", imageUrl: "https://images.unsplash.com/photo-1617196034796-73dfa7b1fd56?w=600&h=600&fit=crop", price: 18, isVegetarian: false, isPopular: false, section: "Rolls", cartQuantity: 0 },
  { id: "m401", restaurantId: "r4", name: "Pad Thai", description: "Rice noodles, tofu, egg, tamarind, peanuts.", imageUrl: "https://images.unsplash.com/photo-1559314809-0d155014e29e?w=600&h=600&fit=crop", price: 13.5, isVegetarian: false, isPopular: true, section: "Mains", cartQuantity: 0 },
  { id: "m402", restaurantId: "r4", name: "Green Curry", description: "Coconut green curry with chicken and Thai basil.", imageUrl: "https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=600&h=600&fit=crop", price: 14.5, isVegetarian: false, isPopular: true, section: "Mains", cartQuantity: 0 },
  { id: "m501", restaurantId: "r5", name: "Tacos al Pastor", description: "Marinated pork, pineapple, cilantro, onion.", imageUrl: "https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&h=600&fit=crop", price: 11, isVegetarian: false, isPopular: true, section: "Tacos", cartQuantity: 0 },
  { id: "m502", restaurantId: "r5", name: "Chicken Burrito", description: "Chicken, rice, beans, salsa, cheese, guacamole.", imageUrl: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&h=600&fit=crop", price: 12.5, isVegetarian: false, isPopular: true, section: "Burritos", cartQuantity: 0 },
  { id: "m701", restaurantId: "r7", name: "Cappuccino", description: "Espresso with velvety steamed milk foam.", imageUrl: "https://images.unsplash.com/photo-1534778101976-62847782c213?w=600&h=600&fit=crop", price: 4.5, isVegetarian: true, isPopular: true, section: "Coffee", cartQuantity: 0 },
  { id: "m703", restaurantId: "r7", name: "Avocado Toast", description: "Sourdough, avocado, chili flakes, lemon.", imageUrl: "https://images.unsplash.com/photo-1525351484163-7529414344d8?w=600&h=600&fit=crop", price: 8.5, isVegetarian: true, isPopular: true, section: "Food", cartQuantity: 0 },
];

const emptyRestaurant = restaurants[0];
const emptyOrder: OrderDetail = {
  id: "",
  restaurantId: "",
  restaurantName: "",
  status: "preparing",
  statusLabel: "Preparing",
  statusDescription: "The kitchen is getting everything ready.",
  subtotal: 0,
  deliveryFee: 0,
  total: 0,
  address: "",
  placedAt: "",
  items: [],
};

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function restaurantsForCategory(categoryId: string) {
  return restaurants
    .filter((restaurant) => categoryId === "cat_all" || restaurant.categoryId === categoryId)
    .sort((a, b) => b.rating - a.rating);
}

function searchRestaurants(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return restaurantsForCategory("cat_all");
  return restaurants.filter((restaurant) => {
    const restaurantMenu = menuItems.filter((item) => item.restaurantId === restaurant.id);
    return (
      restaurant.name.toLowerCase().includes(q) ||
      restaurant.cuisine.toLowerCase().includes(q) ||
      restaurantMenu.some((item) => item.name.toLowerCase().includes(q))
    );
  });
}

function refreshCart(state: AppState) {
  state.cartCount = state.cartItems.reduce((sum, item) => sum + item.quantity, 0);
  state.cartSubtotal = round2(state.cartItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const first = state.cartItems[0];
  const restaurant = first ? restaurants.find((r) => r.id === first.restaurantId) : null;
  state.cartRestaurantName = restaurant?.name ?? "";
  state.cartDeliveryFee = restaurant ? restaurant.deliveryFee : 0;
  state.cartTotal = round2(state.cartSubtotal + state.cartDeliveryFee);
  refreshMenuItemQuantities(state);
}

function itemsForRestaurant(state: AppState, restaurantId: string) {
  return menuItems
    .filter((item) => item.restaurantId === restaurantId)
    .map((item) => ({
      ...item,
      cartQuantity: state.cartItems.find((cartItem) => cartItem.menuItemId === item.id)?.quantity ?? 0,
    }));
}

function refreshMenuItemQuantities(state: AppState) {
  state.menuItems = itemsForRestaurant(state, state.selectedRestaurantId);
}

function setRestaurant(state: AppState, id: string) {
  const restaurant = restaurants.find((item) => item.id === id) ?? restaurants[0];
  state.selectedRestaurantId = restaurant.id;
  state.restaurant = restaurant;
  state.menuItems = itemsForRestaurant(state, restaurant.id);
  state.cartSubtotal = round2(
    state.cartItems
      .filter((item) => item.restaurantId === restaurant.id)
      .reduce((sum, item) => sum + item.lineTotal, 0),
  );
  state.cartCount = state.cartItems
    .filter((item) => item.restaurantId === restaurant.id)
    .reduce((sum, item) => sum + item.quantity, 0);
}

function summarizeItems(items: CartItem[]) {
  return items.map((item) => `${item.quantity}x ${item.name}`).join(", ");
}

function createOrder(state: AppState): OrderDetail | null {
  if (state.cartItems.length === 0) return null;
  const first = state.cartItems[0];
  const restaurant = restaurants.find((item) => item.id === first.restaurantId) ?? restaurants[0];
  const orderId = `o${state.orders.length + 3}`;
  return {
    id: orderId,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    status: "on_the_way",
    statusLabel: "On the way",
    statusDescription: "Your courier is heading toward you now.",
    subtotal: state.cartSubtotal,
    deliveryFee: state.cartDeliveryFee,
    total: state.cartTotal,
    address: state.currentUser.address,
    placedAt: "Just now",
    items: state.cartItems.map((item) => ({
      id: `ol_${item.id}`,
      menuItemId: item.menuItemId,
      name: item.name,
      imageUrl: item.imageUrl,
      price: item.price,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
  };
}

function setOrder(state: AppState, id: string) {
  const existing = orderDetails.find((item) => item.id === id);
  state.selectedOrderId = id;
  state.order = existing ?? state.order ?? emptyOrder;
}

const orderDetails: OrderDetail[] = [
  {
    id: "o1",
    restaurantId: "r3",
    restaurantName: "Sakura Sushi Bar",
    status: "delivered",
    statusLabel: "Delivered",
    statusDescription: "Delivered to your door.",
    subtotal: 33,
    deliveryFee: 3.99,
    total: 36.99,
    address: "221B Baker Street, Apt 4, Brooklyn, NY 11201",
    placedAt: "Yesterday",
    items: [
      { id: "ol1", menuItemId: "m301", name: "Salmon Nigiri", imageUrl: menuItems[4].imageUrl, price: 15, quantity: 1, lineTotal: 15 },
      { id: "ol2", menuItemId: "m302", name: "Dragon Roll", imageUrl: menuItems[5].imageUrl, price: 18, quantity: 1, lineTotal: 18 },
    ],
  },
  {
    id: "o2",
    restaurantId: "r7",
    restaurantName: "Daily Grind Cafe",
    status: "delivered",
    statusLabel: "Delivered",
    statusDescription: "Delivered to your door.",
    subtotal: 13,
    deliveryFee: 1.49,
    total: 14.49,
    address: "221B Baker Street, Apt 4, Brooklyn, NY 11201",
    placedAt: "Apr 22",
    items: [
      { id: "ol3", menuItemId: "m701", name: "Cappuccino", imageUrl: menuItems[10].imageUrl, price: 4.5, quantity: 1, lineTotal: 4.5 },
      { id: "ol4", menuItemId: "m703", name: "Avocado Toast", imageUrl: menuItems[11].imageUrl, price: 8.5, quantity: 1, lineTotal: 8.5 },
    ],
  },
];

const initialOrders: OrderSummary[] = orderDetails.map((order) => ({
  id: order.id,
  restaurantName: order.restaurantName,
  status: order.status,
  statusLabel: order.statusLabel,
  total: order.total,
  itemsSummary: order.items.map((item) => item.name).join(", "),
  placedAt: order.placedAt,
}));

function initialState(): AppState {
  return {
    currentUser: {
      id: "u1",
      name: "Alex Morgan",
      email: "alex@example.com",
      avatarUrl: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&h=150&fit=crop",
      address: "221B Baker Street, Apt 4, Brooklyn, NY 11201",
      phone: "+1 (555) 123-4567",
    },
    location: "/",
    locationKind: "home",
    selectedRestaurantId: "r1",
    selectedOrderId: "o1",
    cartCount: 0,
    categories,
    selectedCategory: "cat_all",
    restaurants: restaurantsForCategory("cat_all"),
    restaurant: emptyRestaurant,
    menuItems: menuItems.filter((item) => item.restaurantId === "r1"),
    isFavorite: false,
    cartSubtotal: 0,
    cartItems: [],
    cartRestaurantName: "",
    cartDeliveryFee: 0,
    cartTotal: 0,
    orders: initialOrders,
    order: orderDetails[0],
    totalOrders: initialOrders.length,
    totalSpent: round2(initialOrders.reduce((sum, order) => sum + order.total, 0)),
    favoriteCount: 3,
    searchQuery: "",
    suggestions: [
      { id: "s1", name: "Pizza" },
      { id: "s2", name: "Burgers" },
      { id: "s3", name: "Sushi" },
      { id: "s4", name: "Pad Thai" },
      { id: "s5", name: "Coffee" },
    ],
    searchResults: restaurantsForCategory("cat_all"),
  };
}

export function navigateState(state: AppState, to: string) {
  state.location = to;
  if (to === "/") {
    state.locationKind = "home";
    state.restaurants = restaurantsForCategory(state.selectedCategory);
    refreshCart(state);
    return;
  }
  if (to === "/search") {
    state.locationKind = "search";
    state.searchResults = searchRestaurants(state.searchQuery);
    refreshCart(state);
    return;
  }
  if (to === "/cart") {
    state.locationKind = "cart";
    refreshCart(state);
    return;
  }
  if (to === "/orders") {
    state.locationKind = "orders";
    refreshCart(state);
    return;
  }
  if (to === "/profile") {
    state.locationKind = "profile";
    state.totalOrders = state.orders.length;
    state.totalSpent = round2(state.orders.reduce((sum, order) => sum + order.total, 0));
    refreshCart(state);
    return;
  }
  if (to.startsWith("/restaurant/")) {
    state.locationKind = "restaurant";
    setRestaurant(state, to.split("/").pop() || "r1");
    return;
  }
  if (to.startsWith("/order/")) {
    state.locationKind = "order";
    setOrder(state, to.split("/").pop() || "o1");
  }
}

export const appModule = app
  .defineState<AppState>(initialState())
  .onAction<{ categoryId: string }>("selectCategory", ({ state, action }) => {
    state.selectedCategory = action.payload?.categoryId ?? "cat_all";
    state.restaurants = restaurantsForCategory(state.selectedCategory);
  })
  .onAction("toggleFavorite", ({ state }) => {
    state.isFavorite = !state.isFavorite;
    state.favoriteCount = Math.max(0, state.favoriteCount + (state.isFavorite ? 1 : -1));
  })
  .onAction<{ itemId: string }>("addToCart", ({ state, action }) => {
    const menuItem = menuItems.find((item) => item.id === action.payload?.itemId);
    if (!menuItem) return;
    let existing = state.cartItems.find((item) => item.menuItemId === menuItem.id);
    if (!existing) {
      existing = {
        id: `ci_${menuItem.id}`,
        menuItemId: menuItem.id,
        restaurantId: menuItem.restaurantId,
        name: menuItem.name,
        imageUrl: menuItem.imageUrl,
        price: menuItem.price,
        quantity: 0,
        lineTotal: 0,
      };
      state.cartItems.push(existing);
    }
    existing.quantity += 1;
    existing.lineTotal = round2(existing.price * existing.quantity);
    setRestaurant(state, menuItem.restaurantId);
    refreshCart(state);
  })
  .onAction<{ itemId: string }>("incrementItem", ({ state, action }) => {
    const item = state.cartItems.find((cartItem) => cartItem.id === action.payload?.itemId);
    if (!item) return;
    item.quantity += 1;
    item.lineTotal = round2(item.price * item.quantity);
    refreshCart(state);
  })
  .onAction<{ itemId: string }>("decrementItem", ({ state, action }) => {
    const item = state.cartItems.find((cartItem) => cartItem.id === action.payload?.itemId);
    if (!item) return;
    item.quantity -= 1;
    if (item.quantity <= 0) {
      state.cartItems = state.cartItems.filter((cartItem) => cartItem.id !== item.id);
    } else {
      item.lineTotal = round2(item.price * item.quantity);
    }
    refreshCart(state);
  })
  .onAction<{ itemId: string }>("removeItem", ({ state, action }) => {
    state.cartItems = state.cartItems.filter((item) => item.id !== action.payload?.itemId);
    refreshCart(state);
  })
  .onAction("placeOrder", ({ state }) => {
    refreshCart(state);
    const order = createOrder(state);
    if (!order) return;
    orderDetails.unshift(order);
    state.orders.unshift({
      id: order.id,
      restaurantName: order.restaurantName,
      status: order.status,
      statusLabel: order.statusLabel,
      total: order.total,
      itemsSummary: summarizeItems(state.cartItems),
      placedAt: order.placedAt,
    });
    state.cartItems = [];
    refreshCart(state);
    navigateState(state, "/orders");
  })
  .onAction<{ query: string }>("applySuggestion", ({ state, action }) => {
    state.searchQuery = action.payload?.query ?? "";
    state.searchResults = searchRestaurants(state.searchQuery);
  })
  .onAction<{ to: string }>("router.push", ({ state, action }) => {
    navigateState(state, action.payload?.to ?? "/");
  })
  .onAction("router.back", ({ state }) => {
    navigateState(state, "/");
  })
  .onAction("navigateBack", ({ state }) => {
    navigateState(state, "/");
  })
  .onAction("editAddress", () => {})
  .onAction("openFavorites", () => {})
  .build();
