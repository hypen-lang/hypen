use rusqlite::{params, Connection};

use crate::db::format_placed_at;
use crate::types::{
    CartItem, Category, MenuItem, OrderDetail, OrderLineItem, OrderSummary, Restaurant, User,
};

pub fn get_user(conn: &Connection, id: &str) -> User {
    conn.query_row(
        "SELECT id, name, email, avatar_url, address, phone FROM users WHERE id = ?1",
        params![id],
        |row| {
            Ok(User {
                id: row.get(0)?,
                name: row.get(1)?,
                email: row.get(2)?,
                avatar_url: row.get(3)?,
                address: row.get(4)?,
                phone: row.get(5)?,
            })
        },
    )
    .expect("User not found")
}

pub fn get_categories(conn: &Connection) -> Vec<Category> {
    let mut stmt = conn
        .prepare("SELECT id, name, icon FROM categories ORDER BY rowid")
        .unwrap();

    stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            icon: row.get(2)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

fn map_restaurant_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Restaurant> {
    let is_open_int: i32 = row.get(10)?;
    Ok(Restaurant {
        id: row.get(0)?,
        name: row.get(1)?,
        cuisine: row.get(2)?,
        image_url: row.get(3)?,
        rating: row.get(4)?,
        rating_count: row.get(5)?,
        delivery_time_min: row.get(6)?,
        delivery_time_max: row.get(7)?,
        delivery_fee: row.get(8)?,
        distance_km: row.get(9)?,
        is_open: is_open_int == 1,
        description: row.get::<_, String>(11).unwrap_or_default(),
        category_id: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
    })
}

pub fn get_restaurants(conn: &Connection, category_id: &str) -> Vec<Restaurant> {
    let sql = "SELECT id, name, cuisine, image_url, rating, rating_count,
                      delivery_time_min, delivery_time_max, delivery_fee, distance_km,
                      is_open, description, category_id
               FROM restaurants
               ORDER BY rating DESC";

    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map([], map_restaurant_row)
        .unwrap()
        .filter_map(|r| r.ok())
        .filter(|r| {
            category_id.is_empty()
                || category_id == "cat_all"
                || r.category_id == category_id
        })
        .collect()
}

pub fn get_restaurant(conn: &Connection, id: &str) -> Option<Restaurant> {
    let sql = "SELECT id, name, cuisine, image_url, rating, rating_count,
                      delivery_time_min, delivery_time_max, delivery_fee, distance_km,
                      is_open, description, category_id
               FROM restaurants WHERE id = ?1";

    conn.query_row(sql, params![id], map_restaurant_row).ok()
}

pub fn get_menu_items(conn: &Connection, restaurant_id: &str) -> Vec<MenuItem> {
    let mut stmt = conn
        .prepare(
            "SELECT id, restaurant_id, name, description, image_url, price,
                    is_vegetarian, is_popular, section
             FROM menu_items
             WHERE restaurant_id = ?1
             ORDER BY is_popular DESC, rowid",
        )
        .unwrap();

    stmt.query_map(params![restaurant_id], |row| {
        let is_veg: i32 = row.get(6)?;
        let is_pop: i32 = row.get(7)?;
        Ok(MenuItem {
            id: row.get(0)?,
            restaurant_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get::<_, String>(3).unwrap_or_default(),
            image_url: row.get(4)?,
            price: row.get(5)?,
            is_vegetarian: is_veg == 1,
            is_popular: is_pop == 1,
            section: row.get::<_, String>(8).unwrap_or_else(|_| "Mains".into()),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn search_restaurants(conn: &Connection, query: &str) -> Vec<Restaurant> {
    let q = format!("%{}%", query.to_lowercase());
    let sql = "SELECT DISTINCT r.id, r.name, r.cuisine, r.image_url, r.rating, r.rating_count,
                              r.delivery_time_min, r.delivery_time_max, r.delivery_fee,
                              r.distance_km, r.is_open, r.description, r.category_id
               FROM restaurants r
               LEFT JOIN menu_items m ON m.restaurant_id = r.id
               WHERE LOWER(r.name) LIKE ?1
                  OR LOWER(r.cuisine) LIKE ?1
                  OR LOWER(m.name) LIKE ?1
               ORDER BY r.rating DESC";

    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map(params![q], map_restaurant_row)
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
}

// -- Cart -----------------------------------------------------------------

pub fn get_cart_items(conn: &Connection, user_id: &str) -> Vec<CartItem> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, m.id, m.restaurant_id, m.name, m.image_url, m.price, c.quantity
             FROM cart_items c JOIN menu_items m ON c.menu_item_id = m.id
             WHERE c.user_id = ?1
             ORDER BY c.added_at ASC",
        )
        .unwrap();

    stmt.query_map(params![user_id], |row| {
        let price: f64 = row.get(5)?;
        let qty: i32 = row.get(6)?;
        Ok(CartItem {
            id: row.get(0)?,
            menu_item_id: row.get(1)?,
            restaurant_id: row.get(2)?,
            name: row.get(3)?,
            image_url: row.get(4)?,
            price,
            quantity: qty,
            line_total: round2(price * qty as f64),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

/// Add a menu item to the cart, or bump its quantity by one if it's
/// already there. Mirrors a typical "add to cart" UX.
pub fn add_to_cart(conn: &Connection, user_id: &str, menu_item_id: &str) {
    let id = format!("ci_{}", epoch_millis());
    conn.execute(
        "INSERT INTO cart_items (id, user_id, menu_item_id, quantity)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(user_id, menu_item_id) DO UPDATE SET quantity = quantity + 1",
        params![id, user_id, menu_item_id],
    )
    .ok();
}

pub fn set_cart_quantity(conn: &Connection, user_id: &str, cart_item_id: &str, delta: i32) {
    let current: Option<i32> = conn
        .query_row(
            "SELECT quantity FROM cart_items WHERE id = ?1 AND user_id = ?2",
            params![cart_item_id, user_id],
            |row| row.get(0),
        )
        .ok();

    let Some(qty) = current else {
        return;
    };
    let new_qty = qty + delta;
    if new_qty <= 0 {
        conn.execute(
            "DELETE FROM cart_items WHERE id = ?1 AND user_id = ?2",
            params![cart_item_id, user_id],
        )
        .ok();
    } else {
        conn.execute(
            "UPDATE cart_items SET quantity = ?1 WHERE id = ?2 AND user_id = ?3",
            params![new_qty, cart_item_id, user_id],
        )
        .ok();
    }
}

pub fn remove_cart_item(conn: &Connection, user_id: &str, cart_item_id: &str) {
    conn.execute(
        "DELETE FROM cart_items WHERE id = ?1 AND user_id = ?2",
        params![cart_item_id, user_id],
    )
    .ok();
}

pub fn clear_cart(conn: &Connection, user_id: &str) {
    conn.execute("DELETE FROM cart_items WHERE user_id = ?1", params![user_id])
        .ok();
}

pub fn cart_subtotal_for_restaurant(conn: &Connection, user_id: &str, restaurant_id: &str) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(m.price * c.quantity), 0)
         FROM cart_items c JOIN menu_items m ON c.menu_item_id = m.id
         WHERE c.user_id = ?1 AND m.restaurant_id = ?2",
        params![user_id, restaurant_id],
        |row| row.get::<_, f64>(0),
    )
    .map(round2)
    .unwrap_or(0.0)
}

pub fn cart_count_for_restaurant(conn: &Connection, user_id: &str, restaurant_id: &str) -> i32 {
    conn.query_row(
        "SELECT COALESCE(SUM(c.quantity), 0)
         FROM cart_items c JOIN menu_items m ON c.menu_item_id = m.id
         WHERE c.user_id = ?1 AND m.restaurant_id = ?2",
        params![user_id, restaurant_id],
        |row| row.get::<_, i32>(0),
    )
    .unwrap_or(0)
}

pub fn cart_count_total(conn: &Connection, user_id: &str) -> i32 {
    conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM cart_items WHERE user_id = ?1",
        params![user_id],
        |row| row.get::<_, i32>(0),
    )
    .unwrap_or(0)
}

/// First (oldest) restaurant present in the user's cart, if any. Used to
/// label the cart and look up the delivery fee — we model the cart as
/// single-restaurant for simplicity.
pub fn cart_restaurant(conn: &Connection, user_id: &str) -> Option<Restaurant> {
    let restaurant_id: Option<String> = conn
        .query_row(
            "SELECT m.restaurant_id FROM cart_items c
             JOIN menu_items m ON c.menu_item_id = m.id
             WHERE c.user_id = ?1
             ORDER BY c.added_at ASC LIMIT 1",
            params![user_id],
            |row| row.get(0),
        )
        .ok();

    restaurant_id.and_then(|id| get_restaurant(conn, &id))
}

// -- Orders ---------------------------------------------------------------

pub fn place_order(conn: &Connection, user_id: &str, address: &str) -> Option<String> {
    let cart = get_cart_items(conn, user_id);
    if cart.is_empty() {
        return None;
    }

    let restaurant = cart_restaurant(conn, user_id)?;
    let subtotal: f64 = round2(cart.iter().map(|c| c.line_total).sum());
    let delivery_fee = restaurant.delivery_fee;
    let total = round2(subtotal + delivery_fee);
    let order_id = format!("o_{}", epoch_millis());

    conn.execute(
        "INSERT INTO orders (id, user_id, restaurant_id, status, subtotal, delivery_fee, total, address)
         VALUES (?1, ?2, ?3, 'placed', ?4, ?5, ?6, ?7)",
        params![order_id, user_id, restaurant.id, subtotal, delivery_fee, total, address],
    )
    .ok();

    for item in &cart {
        let oi_id = format!("oi_{}_{}", order_id, item.menu_item_id);
        conn.execute(
            "INSERT INTO order_items (id, order_id, menu_item_id, name, image_url, price, quantity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![oi_id, order_id, item.menu_item_id, item.name, item.image_url, item.price, item.quantity],
        )
        .ok();
    }

    clear_cart(conn, user_id);
    Some(order_id)
}

pub fn get_orders(conn: &Connection, user_id: &str) -> Vec<OrderSummary> {
    let mut stmt = conn
        .prepare(
            "SELECT o.id, r.name, o.status, o.total, o.placed_at
             FROM orders o JOIN restaurants r ON o.restaurant_id = r.id
             WHERE o.user_id = ?1
             ORDER BY o.placed_at DESC",
        )
        .unwrap();

    let rows: Vec<(String, String, String, f64, String)> = stmt
        .query_map(params![user_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    rows.into_iter()
        .map(|(id, restaurant_name, status, total, placed_at)| {
            let items_summary = order_items_summary(conn, &id);
            OrderSummary {
                id,
                restaurant_name,
                status_label: status_label(&status).to_string(),
                status,
                total: round2(total),
                items_summary,
                placed_at: format_placed_at(&placed_at),
            }
        })
        .collect()
}

fn order_items_summary(conn: &Connection, order_id: &str) -> String {
    let mut stmt = conn
        .prepare("SELECT name, quantity FROM order_items WHERE order_id = ?1 ORDER BY rowid")
        .unwrap();

    let parts: Vec<String> = stmt
        .query_map(params![order_id], |row| {
            let name: String = row.get(0)?;
            let qty: i32 = row.get(1)?;
            Ok(format!("{}x {}", qty, name))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    parts.join(", ")
}

pub fn get_order_detail(conn: &Connection, order_id: &str) -> Option<OrderDetail> {
    let row = conn
        .query_row(
            "SELECT o.id, o.restaurant_id, r.name, o.status, o.subtotal, o.delivery_fee, o.total,
                    o.address, o.placed_at
             FROM orders o JOIN restaurants r ON o.restaurant_id = r.id
             WHERE o.id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, f64>(5)?,
                    row.get::<_, f64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .ok()?;

    let (id, restaurant_id, restaurant_name, status, subtotal, delivery_fee, total, address, placed_at) =
        row;

    let mut stmt = conn
        .prepare(
            "SELECT id, menu_item_id, name, image_url, price, quantity
             FROM order_items WHERE order_id = ?1 ORDER BY rowid",
        )
        .unwrap();

    let items: Vec<OrderLineItem> = stmt
        .query_map(params![id], |row| {
            let price: f64 = row.get(4)?;
            let qty: i32 = row.get(5)?;
            Ok(OrderLineItem {
                id: row.get(0)?,
                menu_item_id: row.get(1)?,
                name: row.get(2)?,
                image_url: row.get(3)?,
                price,
                quantity: qty,
                line_total: round2(price * qty as f64),
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    Some(OrderDetail {
        id,
        restaurant_id,
        restaurant_name,
        status_label: status_label(&status).to_string(),
        status_description: status_description(&status).to_string(),
        status,
        subtotal: round2(subtotal),
        delivery_fee: round2(delivery_fee),
        total: round2(total),
        address,
        placed_at: format_placed_at(&placed_at),
        items,
    })
}

pub fn user_total_orders(conn: &Connection, user_id: &str) -> u32 {
    conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE user_id = ?1",
        params![user_id],
        |row| row.get::<_, u32>(0),
    )
    .unwrap_or(0)
}

pub fn user_total_spent(conn: &Connection, user_id: &str) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = ?1",
        params![user_id],
        |row| row.get::<_, f64>(0),
    )
    .map(round2)
    .unwrap_or(0.0)
}

// -- Helpers --------------------------------------------------------------

fn status_label(status: &str) -> &'static str {
    match status {
        "delivered" => "Delivered",
        "on_the_way" => "On the way",
        "preparing" => "Preparing",
        _ => "Placed",
    }
}

fn status_description(status: &str) -> &'static str {
    match status {
        "delivered" => "Hope you enjoyed your meal!",
        "on_the_way" => "Your courier is on the way",
        "preparing" => "The restaurant is preparing your food",
        _ => "We've sent your order to the restaurant",
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
