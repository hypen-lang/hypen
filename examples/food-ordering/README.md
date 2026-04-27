# Food Ordering — Hypen Example

A DoorDash/Uber-Eats style food ordering app, demonstrating Hypen's
declarative UI with a Rust backend.

## Structure

```
food-ordering/
├── components/              # Shared Hypen UI components
│   ├── App/                 # Root layout + Router
│   ├── BottomNav/           # Bottom tab bar (Home / Search / Cart / Orders / Profile)
│   ├── HomePage/            # Restaurant browser with categories
│   ├── CategoryChip/        # Pill-style category filter
│   ├── RestaurantCard/      # Restaurant tile in lists
│   ├── RestaurantDetail/    # Restaurant page with menu and "View cart" bar
│   ├── MenuItem/            # Menu line item with "Add" button
│   ├── Cart/                # Shopping cart with totals
│   ├── CartItem/            # Quantity stepper + remove
│   ├── Orders/              # Order history list
│   ├── OrderDetail/         # Order receipt
│   ├── Profile/             # User profile with stats
│   └── Search/              # Restaurant + dish search
├── data/                    # SQLite schema + seed
├── resources/               # SVG icons used by the UI
└── rust/                    # Rust server (Tokio + Tungstenite)
```

## Architecture

A single primary `App` module owns every piece of state the UI cares
about — current user, location, cart, restaurants, menu, orders,
search results, profile stats. Sub-pages are plain (non-module)
components that read from this shared state, so cart-related
cross-screen updates ("Cart" badge in BottomNav, floating "View cart"
bar on RestaurantDetail) just fall out of mutating fields on
`AppState`.

Per-route data is loaded via `session.on_route_enter(pattern, …)` —
the same pattern as `examples/social/rust`. Every navigation refreshes
exactly what the destination route needs.

## Running

```bash
cd rust
cargo run                            # Server on ws://localhost:3000
PORT=4000 cargo run                  # …or pick a port
```

You can connect using any of the Hypen web clients (e.g. the social
example's `typescript/web` setup, pointed at the food ordering
WebSocket port).

## Routes

| Path                   | Screen           | Loads on entry                                |
| ---------------------- | ---------------- | --------------------------------------------- |
| `/`                    | HomePage         | Restaurants for the selected category         |
| `/search`              | Search           | Suggested searches; restaurants on query      |
| `/cart`                | Cart             | Cart line items, totals, restaurant label     |
| `/orders`              | Orders           | Order history list                            |
| `/profile`             | Profile          | Total orders, total spent, favorites count    |
| `/restaurant/:id`      | RestaurantDetail | Restaurant + menu + cart subtotal for it      |
| `/order/:id`           | OrderDetail      | Order receipt                                 |

## Actions

- `selectCategory({ categoryId })` — filter restaurants on home
- `toggleFavorite` — heart icon on RestaurantDetail
- `addToCart({ itemId })` — add a menu item to cart (bumps qty if dup)
- `incrementItem({ itemId })` / `decrementItem({ itemId })` — cart stepper
- `removeItem({ itemId })` — trash a cart line
- `placeOrder` — convert cart to order, clear cart, refresh order list
- `applySuggestion({ query })` — set search query and re-run search
- `editAddress` / `openFavorites` — placeholders for future UI flows

## Data

`data/schema.sql` defines `users`, `categories`, `restaurants`,
`menu_items`, `cart_items`, `orders`, `order_items`. `data/seed.sql`
ships 10 restaurants with menu items spanning Pizza, Burgers, Sushi,
Asian, Mexican, Dessert, and Coffee — enough variety to exercise
search and category filtering.
