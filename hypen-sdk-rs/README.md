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

## Framework Integration

This SDK is **transport-agnostic**. It does not open sockets or bind ports. You
get a `RemoteSession` (see `hypen_server::remote`) that turns inbound protocol
frames into outbound ones — both plain `String`s — and you wire it into whatever
async server you already run (Axum, Actix, Warp, tungstenite, …):

```rust
use hypen_server::remote::{RemoteSession, SessionConfig};

// Inside your framework's WebSocket handler:
async fn ws_handler(ws: WebSocket, session: RemoteSession) {
    let (mut sender, mut receiver) = ws.split();

    for msg in session.handle_hello(None) {
        sender.send(Message::Text(msg)).await.unwrap();
    }

    while let Some(Ok(msg)) = receiver.next().await {
        for resp in session.handle_message(msg.to_text().unwrap()) {
            sender.send(Message::Text(resp)).await.unwrap();
        }
    }
}
```

### WebSocket compression (`permessage-deflate`)

Hypen enables `permessage-deflate` by default across its SDKs, and the patch
stream compresses well. Because this crate owns no socket, **compression is not
configurable here** — it is negotiated by your transport during the HTTP upgrade.

**Ecosystem status (verified 2026-07): you cannot enable it on an Axum or Actix
Hypen server today.**

- `tungstenite` / `tokio-tungstenite` publish **no** `deflate` or compression
  feature in any release up to and including 0.30.0. The `tungstenite` README
  still reads: *"There is no support for permessage-deflate at the moment, but
  the PRs are welcome"*. Tracking issue
  [snapview/tungstenite-rs#2](https://github.com/snapview/tungstenite-rs/issues/2)
  has been open since 2017; an implementation was merged
  ([#328](https://github.com/snapview/tungstenite-rs/pull/328)) then reverted,
  and the re-land ([#426](https://github.com/snapview/tungstenite-rs/pull/426))
  is still unmerged.
- **Axum** builds `WebSocketUpgrade` on `tokio-tungstenite`, so it inherits the
  gap. `WebSocketUpgrade` offers `read_buffer_size`, `write_buffer_size`,
  `max_write_buffer_size`, `max_message_size`, `max_frame_size`,
  `accept_unmasked_frames` and subprotocol selection — **there is no compression
  or extension setting**, at any axum 0.8.x version.
- **Actix Web** likewise has no WebSocket `permessage-deflate`. (`actix-http`
  depends on `flate2`, but that serves HTTP body compression, not the WS
  extension.)

**This is safe, just not optimal.** `permessage-deflate` is negotiated per
connection and optional per RFC 7692: the client offers it, and a server that
doesn't support it omits the header from the `101` response, after which both
peers speak plain frames. Browser and Android/OkHttp clients offer compression,
have their offer declined, and transparently run uncompressed. The Hypen desktop
renderer offers no compression at all and interoperates with compression-enabled
servers unchanged. The cost is bandwidth, not correctness.

If you need compression now:

- Put a **reverse proxy / CDN edge** that terminates `permessage-deflate` in
  front of the Rust process and forward plain frames upstream. Least invasive.
- Serve from the **TypeScript/Node or Cloudflare Workers Hypen SDK**, which
  negotiate `permessage-deflate` natively.
- Use **[`soketto`](https://crates.io/crates/soketto)** with its `deflate`
  feature — the one maintained pure-Rust WebSocket crate with a real
  `permessage-deflate` implementation. `RemoteSession` is transport-agnostic, so
  driving it from `soketto` needs no changes to your module code.

Re-check when bumping `tokio-tungstenite`: if
[#426](https://github.com/snapview/tungstenite-rs/pull/426) merges, a `deflate`
feature becomes available and Axum can plausibly expose it.

## Attach mode (agent surface)

Callers that are not the rendered UI — an MCP server, a REST route, a CLI — reach a session through the engine's **guarded** external surface (`RemoteSession::dispatch_external`, never the renderer's permissive path): only declared `on_action` names, `Router { Route }` targets and `.bind()` fields are dispatchable, and only the state paths the template renders are readable. Because this crate owns no socket, attach mode is a small registry you wire into your transport: keep each `RemoteSession` in an `Arc`, register it with an `OutboundSink` that feeds that connection's writer, and hand out `AgentHandle`s from wherever you authorise the caller.

```rust
use std::sync::Arc;
use hypen_server::remote::{OutboundSink, RemoteSession, SessionRegistry};

// One per server, shared across connection tasks.
let registry = Arc::new(SessionRegistry::new());

// Per connection: one unbounded channel, one writer task draining it onto the
// socket. The session's own replies go through the same channel via
// `handle_message_with` — queued while the session lock is held, so revisions
// reach the socket in the order they were assigned.
let session = Arc::new(RemoteSession::new(config));
let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
let sink: OutboundSink = { let tx = tx.clone(); Arc::new(move |m| { let _ = tx.send(m); }) };
let mut registered: Option<String> = None;

// In the socket loop, for every inbound text frame:
session.handle_message_with(&text, |m| { let _ = tx.send(m.to_string()); });
if registered.as_deref() != session.acked_session_id().as_deref() {
    match registry.register(&session, Arc::clone(&sink)) {
        Ok(id) => registered = id,                 // `None` until hello completes; retry next frame
        Err(e) => eprintln!("not attachable: {e}"), // SessionIdTaken: a live peer holds the id
    }
}
// ... on exit:
registry.unregister(&session);                     // drops this session's record only

// Elsewhere, after *you* have authorised the caller for `id` — `attach` does
// no authorization of its own:
if let Some(agent) = registry.attach(&id) {
    let actions = agent.list_actions()?;                     // declared surface only
    let sent = agent.dispatch("addToCart", Some(&payload))?; // wire messages pushed through the sink
    let total = agent.get_state(Some("Cart"), Some("total"))?;
    let manifest = agent.manifest()?;
}
```

A permitted `dispatch` pushes through the sink exactly the bytes a renderer `dispatchAction` produces — `patch`, and `stateUpdate` if subscribed, at the next revision — and returns them. A guard refusal is `Err(SdkError::Engine)` with zero sink calls and no revision bump. The registry and every handle hold only `Weak` references, so a handle **never owns the session**: it cannot destroy, suspend or close it, and once the host drops its `Arc` every call returns `SdkError::SessionGone`. A session id is client-chosen (that is how resume works), so `register` refuses with `SdkError::SessionIdTaken` to displace a different live session holding the same id, and `unregister` removes only the caller's own record. The sink runs under the session lock: keep it cheap, non-blocking, and never call back into the session from it. `examples/social/rust` is the complete wiring.

## Device capabilities (RFC 001)

A handler can ask the connected client — a browser with `@hypen-space/device-web`,
the iOS / Android renderers, the Hypen desktop renderer — to pick or save a
file, pick a photo, capture from the camera, record audio, find a Bluetooth
device or check a permission, and gets the verified result back. The protocol
state machine is the engine's sans-IO `hypen_engine::device::DeviceBroker`,
the same broker the TypeScript, Go, Kotlin and Swift servers run; this crate
links it directly (no WASM) and adds admission, the handshake, resume tokens,
the socket pump, timers, the replay firewall and the handler API
(`hypen_server::device`). Spec: `rfcs/001-device-capability-protocol.md`;
user docs: `hypen-docs/content/docs/device/`.

**Handlers.** Remote handlers receive the session's `GlobalContext`, whose
`device()` is scoped to the invocation (module instance, activation, dispatch
provenance). Handlers are synchronous and run with the session locked, so
device calls never block one: a call returns `Err(DeviceError)` when refused
locally (nothing sent) or a `DeviceCall` that settles later.

```rust
use hypen_server::device::{MediaType, StreamItem};

.on_action::<()>("changePhoto", |state, _, ctx| {
    match ctx.expect("remote handler").device().gallery_pick(&[MediaType::Photo], 1) {
        // Applied to this module's state when it settles; patches ship like an action's.
        Ok(call) => call.then(|s: &mut Profile, res| match res {
            Ok(items) => s.avatar = upload(&items[0].bytes),     // SHA-256 verified by the broker
            Err(e) => s.error = e.code_str().into(),             // denied, cancelled, … are values
        }),
        Err(e) => state.error = e.code_str().into(),             // unsupported, unavailable, invalidParams
    }
})
```

- `supports(name)`, `selected_version(name)`, `capabilities()` — the live
  negotiated selection (follows the client's `core.capabilities` snapshots).
- `request(name, json)` / `request_with(.., RequestOptions)` plus typed
  helpers: `gallery_pick`, `file_pick`, `save`, `camera_capture`,
  `bluetooth_select`, `permission_query`, `permission_request` → `DeviceCall<T>`
  consumed with `then::<S>` (apply to module state), `on_settled` (callback) or
  `wait` (blocking; refused with `unavailable`/`wait-in-handler` inside a
  handler). A call dropped unconsumed is **cancelled** (no orphaned blobs).
- `stream`, `mic_record`, `bluetooth_scan` → `DeviceStream` consumed with
  `for_each::<S>` / `on_item`: `StreamItem::Event` / `Data` in order (credit
  replenished as your callback returns), then exactly one `End`.
- Errors carry the protocol codes (`DeviceErrorCode`: `unsupported`,
  `unavailable`, `denied`, `revoked`, `cancelled`, `timeout`, `throttled`,
  `connectionLost`, `invalidParams`, `internal`) and the platform detail.
- `Delivered<T>` derefs to the value and says whether a fake host produced it
  (`simulated`).
- Lifetimes: requests are owned by the module's current activation.
  Navigation moves it with the screen: leaving a route whose body shows a
  registered module (through `@router.*`, or the host driving
  `session.router()`, e.g. a ManagedRouter) cancels that module's
  activation-owned work, and entering a route starts a new activation.
  `session.deactivate_module(..)` / `activate_module(..)` do the same by hand,
  `unregister_module(..)` destroys the module and sweeps everything; agent
  dispatches (`dispatch_external`) can never open device work (`unavailable`,
  `syncActions.replay`).
- In-process `ModuleInstance`s (and UI-only connections) get
  `Device::disabled()`: every call is `unavailable` (`device-disabled`).

**Serving it: on by default.** Build each connection's session with the
connection's transport — that is the whole setup, there is no enable call:

```rust
use hypen_server::device::{Admission, DeviceOptions, DeviceServer, DeviceServerConfig, DeviceTransport, SessionTransport};

// Per connection, after the upgrade:
let session = RemoteSession::connect(def, components, Arc::new(my_transport));
// Text frames → session.handle_message_with(..), binary frames → session.handle_binary(..),
// socket end → session.handle_close().
```

`my_transport` implements `DeviceTransport` (`send_text`, `send_binary`,
`close`) and `SessionTransport::send_ui` (patches produced when a device
result settles outside `handle_message`). Feed all of it — and the replies
`handle_message_with` emits — into **one** ordered socket writer.

Server-wide settings live on a `DeviceServer`; sessions use
`DeviceServer::shared()` unless given one (`.with_device_server(&server)`):

```rust
let server = DeviceServer::new(
    DeviceServerConfig::default()
        .allow_origin("https://app.example.com")                         // browsers: foreign Origin → 403
        .authenticate(|req| valid_token(req.header("authorization"))),   // every upgrade
); // never fails; with neither configured every client is admitted + one startup warning
server.configure_device(DeviceOptions { max_item_bytes: Some(50 << 20), ..Default::default() });
// server.disable_device();       // the one opt-out (per connection: session.disable_device())

// In the upgrade callback (admission is the app's connection policy, not a device switch):
if let Admission::Rejected { status, .. } = server.admit(&upgrade_request) {
    return reject(status); // 403
}
let session = RemoteSession::connect(def, components, transport).with_device_server(&server);
```

The session then: negotiates from the exact `hello.device` text (a client
that offers no `device` stays UI-only, exactly as before); acks with `device`
and a rotating 256-bit `resumeToken` (always issued; required only to resume a
session that negotiated a device plane — a UI-only session keeps id-only
resume; gate `SessionManager` resumes on `DeviceServer::resume_target(&hello_text)`);
drops dispatches before the hello; opens `core.capabilities` first; runs
leases and deadlines on a per-connection timer thread; and resets the socket
(1012) when the broker closes the plane after repeated protocol abuse. Legacy
clients that never send `hello` are initialised by the host
(`handle_hello(None)` after its grace period) and have no device plane.
Options (`DeviceOptions`): `max_retained_bytes` (128 MiB per connection),
`aggregate_retained_bytes` (1 GiB per server), `max_item_bytes`. Device
endpoints are uncompressed, as the protocol requires (see the compression
note above). A session built without a transport (`from_definition`,
`new` with `transport: None`) is the UI-only, in-process form.

Tests: `src/device/tests.rs` drives a real `RemoteSession` with a scripted
client (handshake, `selection.json` and the `messages.json` corpus, uploads,
downloads, streams, deadlines, sweeps, navigation, replay firewall, resume,
opt-out, abuse); `hypen-renderer-desktop/tests/device_rust_server.rs` runs this SDK
against the desktop client over a real WebSocket.

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
- **Attach mode** — `SessionRegistry` + `AgentHandle` give agents a guarded, non-owning view of a live user session
- **Device capabilities** (RFC 001) — `ctx.device()` on the shared Rust device broker, with admission and resume tokens
- **Patch-based rendering** compatible with all Hypen renderers (DOM, Canvas, iOS, Android)

## License

MIT
