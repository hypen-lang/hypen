use serde::{Deserialize, Serialize};

// -- Domain types ---------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub avatar_url: String,
    pub address: String,
    pub phone: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub icon: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restaurant {
    pub id: String,
    pub name: String,
    pub cuisine: String,
    pub image_url: String,
    pub rating: f64,
    pub rating_count: u32,
    pub delivery_time_min: u32,
    pub delivery_time_max: u32,
    pub delivery_fee: f64,
    pub distance_km: f64,
    pub is_open: bool,
    pub description: String,
    pub category_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItem {
    pub id: String,
    pub restaurant_id: String,
    pub name: String,
    pub description: String,
    pub image_url: String,
    pub price: f64,
    pub is_vegetarian: bool,
    pub is_popular: bool,
    pub section: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartItem {
    pub id: String,
    pub menu_item_id: String,
    pub restaurant_id: String,
    pub name: String,
    pub image_url: String,
    pub price: f64,
    pub quantity: i32,
    pub line_total: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSummary {
    pub id: String,
    pub restaurant_name: String,
    pub status: String,
    pub status_label: String,
    pub total: f64,
    pub items_summary: String,
    pub placed_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderLineItem {
    pub id: String,
    pub menu_item_id: String,
    pub name: String,
    pub image_url: String,
    pub price: f64,
    pub quantity: i32,
    pub line_total: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDetail {
    pub id: String,
    pub restaurant_id: String,
    pub restaurant_name: String,
    pub status: String,
    pub status_label: String,
    pub status_description: String,
    pub subtotal: f64,
    pub delivery_fee: f64,
    pub total: f64,
    pub address: String,
    pub placed_at: String,
    pub items: Vec<OrderLineItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub name: String,
}

// -- App state -----------------------------------------------------------
//
// The Food Ordering app keeps a single primary `App` module that owns
// every piece of state surfaced by the UI. Sub-pages (HomePage,
// RestaurantDetail, Cart, Orders, OrderDetail, Profile, Search) are
// non-module components that read from this shared state. This makes
// cart-related cross-screen updates trivial — every action handler can
// freely mutate any field — at the cost of carrying a slightly larger
// state object.

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    // Auth + nav
    pub current_user: User,
    pub location: String,

    // BottomNav badge / header
    pub cart_count: i32,

    // HomePage
    pub categories: Vec<Category>,
    pub selected_category: String,
    pub restaurants: Vec<Restaurant>,

    // RestaurantDetail (route /restaurant/:id)
    pub restaurant: Restaurant,
    pub menu_items: Vec<MenuItem>,
    pub is_favorite: bool,
    /// Items count for *this restaurant* — drives the floating cart bar.
    pub cart_subtotal: f64,

    // Cart (route /cart)
    pub cart_items: Vec<CartItem>,
    pub cart_restaurant_name: String,
    pub cart_delivery_fee: f64,
    pub cart_total: f64,

    // Orders (route /orders)
    pub orders: Vec<OrderSummary>,

    // OrderDetail (route /order/:id)
    pub order: OrderDetail,

    // Profile
    pub total_orders: u32,
    pub total_spent: f64,
    pub favorite_count: u32,

    // Search
    pub search_query: String,
    pub suggestions: Vec<Suggestion>,
    pub search_results: Vec<Restaurant>,
}

// -- Action payloads ------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryIdPayload {
    pub category_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemIdPayload {
    pub item_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPayload {
    pub query: String,
}
