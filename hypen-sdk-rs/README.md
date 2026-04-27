# hypen-server

Rust server SDK for building [Hypen](https://hypen.space) applications.

Hypen is a declarative UI language and reactive runtime for building cross-platform applications. This SDK provides a type-safe, idiomatic Rust API for defining stateful modules, handling actions, managing routing, and discovering components.

## Installation

```toml
# Cargo.toml
[dependencies]
hypen-server = "0.4"
serde = { version = "1", features = ["derive"] }
```

The crate is named `hypen-server` (the repository directory is `hypen-sdk-rs/`).

## Quick Start

Define modules with `HypenApp::module::<S>(name)`, then register them on `HypenApp::builder()` routes and serve the whole app via your web framework (Axum / Actix / etc.):

```rust
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Counter { count: i32 }

#[derive(Deserialize)]
struct AddPayload { amount: i32 }

let counter = HypenApp::module::<Counter>("Counter")
    .state(Counter::default())
    .on_action::<()>("increment", |state, _, _ctx| { state.count += 1; })
    .on_action::<AddPayload>("add", |state, payload, _ctx| {
        state.count += payload.amount;
    })
    .ui(r#"
        Column {
            Text("Count: @{state.count}")
            Button("@actions.increment") { Text("+") }
        }
    "#)
    .build();

let app = HypenApp::builder()
    .route("/", counter)
    .build();

// Plug `app` into your HTTP server's WebSocket route (see "Framework Integration" below).
```

`HypenApp::module::<S>(name)` is the canonical entry point and is equivalent to `ModuleBuilder::<S>::new(name)`. For a quick single-module sanity test you can use the built module directly without wrapping it in a `HypenApp` — but real apps should route through `HypenApp::builder()`.

## Action Handling

Actions always take a type parameter for the payload and a string name. Use `()` for actions with no payload.

```rust
// No payload
.on_action::<()>("increment", |state, _, _ctx| {
    state.count += 1;
})

// Typed payload (just needs #[derive(Deserialize)])
#[derive(Deserialize)]
struct SetValue { value: i32 }

.on_action::<SetValue>("set_value", |state, payload, _ctx| {
    state.count = payload.value;
})

// Raw JSON access
.on_action::<serde_json::Value>("raw", |state, raw, _ctx| {
    if let Some(n) = raw.as_i64() { state.count = n as i32; }
})
```

## Routing

```rust
let app = HypenApp::builder()
    .route("/", home_module)
    .route("/counter", counter_module)
    .components_dir("./components")
    .build();

app.navigate("/counter");
```

## Lifecycle Hooks

```rust
let module = HypenApp::module::<Counter>("Counter")
    .state(Counter { count: 0 })
    .on_created(|state, _ctx| {
        println!("Counter started with count = {}", state.count);
    })
    .on_destroyed(|state, _ctx| {
        println!("Counter finalized at {}", state.count);
    })
    .build();
```

## Session Lifecycle

When a client disconnects, Hypen can suspend the session and resume it on reconnect (within a TTL). Hook into the transitions to persist, restore, or clean up state:

```rust
let module = HypenApp::module::<Counter>("Counter")
    .state(Counter { count: 0 })
    .on_disconnect(|state, session| {
        println!("session {} disconnected with count {}", session.id, state.count);
    })
    .on_reconnect(|state, session, saved| {
        if let Some(count) = saved.get("count").and_then(|v| v.as_i64()) {
            state.count = count as i32;
        }
        println!("session {} reconnected", session.id);
    })
    .on_expire(|session| {
        println!("session {} expired", session.id);
    })
    .build();
```

For manual session management (e.g. in a custom transport), use `SessionManager`:

```rust
use hypen_server::remote::SessionManager;

let manager = SessionManager::new(Default::default());
let session = manager.create_session(Default::default());
manager.track_connection(&session.id, conn_id);

// on socket close:
if manager.connection_count(&session.id) == 0 {
    manager.suspend_session(&session.id, current_state, || {
        // called when TTL elapses without a reconnect
    });
}
```

## Nested Modules

Complex screens can compose several independently stateful modules. Each nested module registers under its lowercase name in the shared `GlobalContext`, so `@{feed.items}` / `@actions.feed.refresh` etc. work from the parent template:

```rust
use std::sync::Arc;
use hypen_server::prelude::*;
use hypen_server::module::create_nested_instance;

let feed_def = Arc::new(
    HypenApp::module::<FeedState>("Feed")
        .state(FeedState::default())
        .on_action::<()>("refresh", |state, _, _| { state.reload(); })
        .build(),
);

let ctx = Arc::new(GlobalContext::new());
let feed = create_nested_instance(feed_def, ctx.clone())?;
assert!(ctx.has_module("feed"));
```

At the app level, `HypenApp::instantiate_nested(def)` does the same thing using the app's own context.

## Features

- **Typed state** with automatic JSON diffing and path-based change detection
- **Typed action payloads** via `serde::Deserialize` (no custom traits needed)
- **Lifecycle hooks**: `on_created`, `on_destroyed`
- **Session hooks**: `on_disconnect`, `on_reconnect`, `on_expire` with TTL-based `SessionManager`
- **Nested modules** — compose multiple stateful modules under a shared `GlobalContext`
- **URL router** with pattern matching and parameter extraction
- **Component discovery** from `.hypen` files on the filesystem
- **Cross-module communication** via `GlobalContext` and `EventEmitter`
- **Patch-based rendering** compatible with all Hypen renderers (DOM, Canvas, iOS, Android)

## License

MIT
