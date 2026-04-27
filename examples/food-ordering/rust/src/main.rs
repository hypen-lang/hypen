//! Food Ordering example, Rust SDK port.
//!
//! Architecture: a single primary `App` module owns every piece of state
//! the UI cares about (cart, current restaurant, menu, orders, search,
//! profile, …). All sub-pages are plain components that read from this
//! shared state, so cart-related cross-screen updates ("Cart" badge in
//! the BottomNav, "View cart" bar on RestaurantDetail) just fall out of
//! mutating fields on `AppState`.
//!
//! Per-route data is loaded via `session.on_route_enter(pattern, …)` —
//! exactly the same pattern as `examples/social/rust`. Every navigation
//! refreshes everything the destination route needs.

mod db;
mod queries;
mod types;

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use hypen_server::app::HypenApp;
use hypen_server::discovery::ComponentRegistry;
use hypen_server::remote::RemoteSession;
use rusqlite::Connection;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use db::init_database;
use queries::{
    add_to_cart, cart_count_for_restaurant, cart_count_total, cart_restaurant,
    cart_subtotal_for_restaurant, get_cart_items, get_categories, get_menu_items,
    get_order_detail, get_orders, get_restaurant, get_restaurants, get_user,
    place_order, remove_cart_item, search_restaurants, set_cart_quantity,
    user_total_orders, user_total_spent,
};
use types::{
    AppState, CategoryIdPayload, ItemIdPayload, QueryPayload, Restaurant, Suggestion, User,
};

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
//
// Loaded once per WebSocket connection. Per-route data (menu items,
// orders, order detail, …) is filled in on navigation by
// `on_route_enter` hooks below — no need to pre-load every screen here.

fn build_initial_state(db: &Connection, current_user: User) -> AppState {
    let categories = get_categories(db);
    let restaurants = get_restaurants(db, "cat_all");
    let suggestions = vec![
        Suggestion { id: "s1".into(), name: "Pizza".into() },
        Suggestion { id: "s2".into(), name: "Burgers".into() },
        Suggestion { id: "s3".into(), name: "Sushi".into() },
        Suggestion { id: "s4".into(), name: "Pad Thai".into() },
        Suggestion { id: "s5".into(), name: "Coffee".into() },
        Suggestion { id: "s6".into(), name: "Ice Cream".into() },
    ];

    AppState {
        cart_count: cart_count_total(db, &current_user.id),
        location: "/".into(),
        selected_category: "cat_all".into(),
        categories,
        restaurants: restaurants.clone(),
        suggestions,
        search_results: restaurants,
        current_user,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

fn build_app_module(
    db: Arc<Mutex<Connection>>,
    user_id: String,
) -> Arc<hypen_server::module::ModuleDefinition<AppState>> {
    Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState::default()) // overridden per-session below
            .ui_file("../components/App/component.hypen")
            .resources_dir("../resources")
            .on_action::<CategoryIdPayload>("selectCategory", {
                let db = db.clone();
                move |state, payload, _| {
                    state.selected_category = payload.category_id.clone();
                    let conn = db.lock().unwrap();
                    state.restaurants = get_restaurants(&conn, &payload.category_id);
                }
            })
            .on_action::<()>("toggleFavorite", |state, _, _| {
                state.is_favorite = !state.is_favorite;
            })
            .on_action::<ItemIdPayload>("addToCart", {
                let db = db.clone();
                let user_id = user_id.clone();
                move |state, payload, _| {
                    let conn = db.lock().unwrap();
                    add_to_cart(&conn, &user_id, &payload.item_id);
                    refresh_cart_for_restaurant(&conn, &user_id, state);
                }
            })
            .on_action::<ItemIdPayload>("incrementItem", {
                let db = db.clone();
                let user_id = user_id.clone();
                move |state, payload, _| {
                    let conn = db.lock().unwrap();
                    set_cart_quantity(&conn, &user_id, &payload.item_id, 1);
                    refresh_full_cart(&conn, &user_id, state);
                }
            })
            .on_action::<ItemIdPayload>("decrementItem", {
                let db = db.clone();
                let user_id = user_id.clone();
                move |state, payload, _| {
                    let conn = db.lock().unwrap();
                    set_cart_quantity(&conn, &user_id, &payload.item_id, -1);
                    refresh_full_cart(&conn, &user_id, state);
                }
            })
            .on_action::<ItemIdPayload>("removeItem", {
                let db = db.clone();
                let user_id = user_id.clone();
                move |state, payload, _| {
                    let conn = db.lock().unwrap();
                    remove_cart_item(&conn, &user_id, &payload.item_id);
                    refresh_full_cart(&conn, &user_id, state);
                }
            })
            .on_action::<()>("placeOrder", {
                let db = db.clone();
                let user_id = user_id.clone();
                move |state, _, _| {
                    let conn = db.lock().unwrap();
                    let address = state.current_user.address.clone();
                    if place_order(&conn, &user_id, &address).is_some() {
                        // Cart was cleared by `place_order`; re-snapshot.
                        refresh_full_cart(&conn, &user_id, state);
                        // Refresh orders summary list so the user sees the
                        // new order if they navigate to /orders next.
                        state.orders = get_orders(&conn, &user_id);
                    }
                }
            })
            .on_action::<()>("editAddress", |_state, _, _| {
                // Placeholder — wire to a modal flow in a real app.
            })
            .on_action::<()>("openFavorites", |_state, _, _| {
                // Placeholder — wire to a favorites screen in a real app.
            })
            .on_action::<QueryPayload>("applySuggestion", {
                let db = db.clone();
                move |state, payload, _| {
                    state.search_query = payload.query.clone();
                    let conn = db.lock().unwrap();
                    state.search_results = search_restaurants(&conn, &payload.query);
                }
            })
            .build(),
    )
}

// ---------------------------------------------------------------------------
// Cart helpers — used by both action handlers and route hooks.
// ---------------------------------------------------------------------------

/// Refresh the slice of cart state shown on RestaurantDetail and the
/// global cart badge. Called after `addToCart` so the floating "View
/// cart" bar appears without waiting for a navigation.
fn refresh_cart_for_restaurant(conn: &Connection, user_id: &str, state: &mut AppState) {
    let restaurant_id = &state.restaurant.id;
    state.cart_subtotal = cart_subtotal_for_restaurant(conn, user_id, restaurant_id);
    state.cart_count = cart_count_for_restaurant(conn, user_id, restaurant_id);
}

/// Refresh the entire cart screen state (line items, totals, restaurant
/// label) plus the BottomNav badge. Used after every cart-mutating
/// action that fires from the Cart screen.
fn refresh_full_cart(conn: &Connection, user_id: &str, state: &mut AppState) {
    let items = get_cart_items(conn, user_id);
    let subtotal: f64 = (items.iter().map(|i| i.line_total).sum::<f64>() * 100.0).round() / 100.0;

    let (restaurant_name, delivery_fee) = match cart_restaurant(conn, user_id) {
        Some(r) => (r.name, r.delivery_fee),
        None => (String::new(), 0.0),
    };
    let total = ((subtotal + delivery_fee) * 100.0).round() / 100.0;

    state.cart_count = items.iter().map(|i| i.quantity).sum::<i32>();
    state.cart_items = items;
    state.cart_subtotal = subtotal;
    state.cart_restaurant_name = restaurant_name;
    state.cart_delivery_fee = delivery_fee;
    state.cart_total = total;
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

fn build_session(
    db: Arc<Mutex<Connection>>,
    components: ComponentRegistry,
    current_user: User,
) -> RemoteSession {
    let initial_state = {
        let conn = db.lock().unwrap();
        build_initial_state(&conn, current_user.clone())
    };
    let app = build_app_module(db.clone(), current_user.id.clone());

    let session = RemoteSession::from_definition_with_state(
        app,
        components,
        initial_state,
        vec![],
    );

    // ---- Route hooks ----
    //
    // Each hook fires whenever the session's router lands on the given
    // pattern. They mutate the primary state slot (key `""`) so the
    // diff/flush dance in `RemoteSession::handle_action` will push the
    // changes back to the engine and ship a patch in the same
    // round-trip.
    //
    // We always update `cartCount` so the BottomNav badge stays in sync
    // across navigations.

    session.on_route_enter("/", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            if let Some(slot) = primary_slot(state) {
                let selected = slot
                    .get("selectedCategory")
                    .and_then(|v| v.as_str())
                    .unwrap_or("cat_all")
                    .to_string();
                let restaurants = get_restaurants(&conn, &selected);
                slot.insert("restaurants".into(), to_json(&restaurants));
                slot.insert("cartCount".into(), Value::from(cart_count_total(&conn, &user_id)));
            }
        }
    });

    session.on_route_enter("/search", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            if let Some(slot) = primary_slot(state) {
                let query = slot
                    .get("searchQuery")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let results = if query.trim().is_empty() {
                    get_restaurants(&conn, "cat_all")
                } else {
                    search_restaurants(&conn, &query)
                };
                slot.insert("searchResults".into(), to_json(&results));
                slot.insert("cartCount".into(), Value::from(cart_count_total(&conn, &user_id)));
            }
        }
    });

    session.on_route_enter("/cart", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            if let Some(slot) = primary_slot(state) {
                let items = get_cart_items(&conn, &user_id);
                let subtotal: f64 =
                    (items.iter().map(|i| i.line_total).sum::<f64>() * 100.0).round() / 100.0;
                let (name, fee) = match cart_restaurant(&conn, &user_id) {
                    Some(r) => (r.name, r.delivery_fee),
                    None => (String::new(), 0.0),
                };
                let total = ((subtotal + fee) * 100.0).round() / 100.0;
                let count = items.iter().map(|i| i.quantity).sum::<i32>();

                slot.insert("cartItems".into(), to_json(&items));
                slot.insert("cartSubtotal".into(), Value::from(subtotal));
                slot.insert("cartRestaurantName".into(), Value::String(name));
                slot.insert("cartDeliveryFee".into(), Value::from(fee));
                slot.insert("cartTotal".into(), Value::from(total));
                slot.insert("cartCount".into(), Value::from(count));
            }
        }
    });

    session.on_route_enter("/orders", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            if let Some(slot) = primary_slot(state) {
                slot.insert("orders".into(), to_json(&get_orders(&conn, &user_id)));
                slot.insert("cartCount".into(), Value::from(cart_count_total(&conn, &user_id)));
            }
        }
    });

    session.on_route_enter("/order/:id", {
        let db = db.clone();
        move |params, state, _ctx| {
            let id = params.get("id").cloned().unwrap_or_default();
            if id.is_empty() {
                return;
            }
            let conn = db.lock().unwrap();
            let order = get_order_detail(&conn, &id).unwrap_or_default();
            if let Some(slot) = primary_slot(state) {
                slot.insert("order".into(), to_json(&order));
            }
        }
    });

    session.on_route_enter("/profile", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            if let Some(slot) = primary_slot(state) {
                slot.insert(
                    "totalOrders".into(),
                    Value::from(user_total_orders(&conn, &user_id)),
                );
                slot.insert(
                    "totalSpent".into(),
                    Value::from(user_total_spent(&conn, &user_id)),
                );
                slot.insert("favoriteCount".into(), Value::from(0u32));
                slot.insert(
                    "cartCount".into(),
                    Value::from(cart_count_total(&conn, &user_id)),
                );
            }
        }
    });

    session.on_route_enter("/restaurant/:id", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |params, state, _ctx| {
            let id = params.get("id").cloned().unwrap_or_default();
            if id.is_empty() {
                return;
            }
            let conn = db.lock().unwrap();
            let restaurant = get_restaurant(&conn, &id).unwrap_or_else(Restaurant::default);
            let menu = get_menu_items(&conn, &id);
            let cart_subtotal = cart_subtotal_for_restaurant(&conn, &user_id, &id);
            let cart_count_here = cart_count_for_restaurant(&conn, &user_id, &id);

            if let Some(slot) = primary_slot(state) {
                slot.insert("restaurant".into(), to_json(&restaurant));
                slot.insert("menuItems".into(), to_json(&menu));
                slot.insert("cartSubtotal".into(), Value::from(cart_subtotal));
                slot.insert("cartCount".into(), Value::from(cart_count_here));
                slot.insert("isFavorite".into(), Value::Bool(false));
            }
        }
    });

    session
}

/// Borrow the primary module's state slot from the route-enter
/// `state: &mut HashMap<String, Value>`. The primary slot is keyed by
/// the empty string (nested modules use their lowercase name).
fn primary_slot(
    state: &mut std::collections::HashMap<String, Value>,
) -> Option<&mut serde_json::Map<String, Value>> {
    state.get_mut("").and_then(|v| v.as_object_mut())
}

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let db = Arc::new(Mutex::new(init_database()));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind {addr}: {e}"));

    println!("Food Ordering server (Rust) running on ws://localhost:{port}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("Accept failed: {e}");
                continue;
            }
        };

        let db = db.clone();

        tokio::spawn(async move {
            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("WebSocket handshake failed from {peer}: {e}");
                    return;
                }
            };

            let current_user = {
                let conn = db.lock().unwrap();
                get_user(&conn, "u1")
            };

            let mut components = ComponentRegistry::new();
            if let Err(e) = components.load_dir("../components") {
                eprintln!("Failed to load components for client {peer}: {e}");
                return;
            }

            let session = build_session(db, components, current_user);

            let (mut sender, mut receiver) = ws_stream.split();
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Text(text) => {
                        for resp in session.handle_message(&text) {
                            if sender.send(Message::Text(resp)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
    }
}

