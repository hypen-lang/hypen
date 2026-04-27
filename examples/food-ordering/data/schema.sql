CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    avatar_url TEXT NOT NULL,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cuisine TEXT NOT NULL,
    image_url TEXT NOT NULL,
    rating REAL DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    delivery_time_min INTEGER DEFAULT 20,
    delivery_time_max INTEGER DEFAULT 35,
    delivery_fee REAL DEFAULT 0,
    distance_km REAL DEFAULT 1.0,
    is_open INTEGER DEFAULT 1,
    description TEXT DEFAULT '',
    category_id TEXT REFERENCES categories(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    image_url TEXT NOT NULL,
    price REAL NOT NULL,
    is_vegetarian INTEGER DEFAULT 0,
    is_popular INTEGER DEFAULT 0,
    section TEXT DEFAULT 'Mains'
);

CREATE TABLE IF NOT EXISTS cart_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, menu_item_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    status TEXT NOT NULL DEFAULT 'placed',
    subtotal REAL NOT NULL DEFAULT 0,
    delivery_fee REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    address TEXT NOT NULL,
    placed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restaurants_category ON restaurants(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_user ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
