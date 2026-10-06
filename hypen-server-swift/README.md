# HypenServer — Swift SDK

Server-driven UI module system for Swift. Build reactive, cross-platform UIs with the [Hypen](https://github.com/hypen-lang/hypen) DSL and stream them to any renderer (DOM, Canvas, iOS, Android) over WebSocket.

> **Note:** This package lives in the main Hypen monorepo. Please open issues and PRs on the main repo: [hypen-lang/hypen](https://github.com/hypen-lang/hypen).

## Installation

### Swift Package Manager

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/hypen-lang/hypen-server-swift.git", from: "0.4.42"),
]
```

Then add to your target:

```swift
.target(
    name: "MyApp",
    dependencies: [
        .product(name: "HypenServer", package: "hypen-server-swift"),
    ]
)
```

## Quick Start

Define your state as a `Codable` struct with `var` fields. Chain actions fluently — mutate state directly in handlers.

```swift
import HypenServer

struct CounterState: Codable {
    var count: Int = 0
}

// Define a HypenApp registry, then attach modules with .name(...).app(myApp).
let myApp = HypenApp()

let _ = hypen(CounterState())
    .name("Counter")
    .app(myApp)
    .onAction("increment") { state in state.count += 1 }
    .onAction("decrement") { state in state.count -= 1 }
    .ui("""
        Column {
            Text("Count: @{state.count}")
            Button("@actions.increment") { Text("+") }
            Button("@actions.decrement") { Text("-") }
        }
    """)
    .build()

// Serve the whole app — any module registered on `myApp` is streamed.
let server = RemoteServer().app(myApp)
try server.listen(3000)
```

> **Single-module demo?** `RemoteServer(moduleDefinition: counter, config: ServerConfig(port: 3000))` is a shortcut that skips the registry — fine for one-off experiments. Prefer the `HypenApp` + `.app(myApp)` form for real apps.

## Typed Actions

Define actions as a `CaseIterable` enum for full type safety with exhaustive `switch`:

```swift
enum CounterAction: String, HypenAction, Codable, CaseIterable {
    case increment
    case decrement
    case reset
}

let counter = hypen(CounterState())
    .onAction(CounterAction.self) { state, action in
        switch action {
        case .increment: state.count += 1
        case .decrement: state.count -= 1
        case .reset: state.count = 0
        }
    }
    .ui("""
        Column {
            Text("Count: @{state.count}")
            Button("@actions.increment") { Text("+") }
            Button("@actions.reset") { Text("Reset") }
        }
    """)
```

## Typed Payloads

Action payloads are automatically deserialized from JSON into `Codable` types:

```swift
struct AddPayload: Codable {
    let amount: Int
}

let counter = hypen(CounterState())
    .onAction("increment") { state in
        state.count += 1
    }
    .onAction("add", payload: AddPayload.self) { state, payload in
        state.count += payload.amount
    }
    .build()
```

When the client sends `{"amount": 5}` with the `add` action, the handler receives a fully typed `AddPayload` instance.

## Async Actions

```swift
struct FetchState: Codable {
    var data: [String: String]? = nil
    var loading: Bool = false
}

let module = hypen(FetchState())
    .onActionAsync("fetchData") { state in
        state.loading = true
        // ... async work ...
        state.data = ["name": "Alice"]
        state.loading = false
    }
    .build()
```

## Lifecycle Hooks

```swift
let counter = hypen(CounterState())
    .onCreated { state, context in
        print("Started with count: \(state.count)")
    }
    .onAction("increment") { state in
        state.count += 1
    }
    .onDestroyed { state, context in
        print("Ended at count: \(state.count)")
    }
    .build()
```

## Routing

```swift
let router = HypenRouter()
let app = HypenApp()
let ctx = HypenGlobalContext(router: router)

struct HomeState: Codable { var page: String = "home" }

// Register modules
let _ = hypen(HomeState(), name: "HomePage", app: app).build()
let _ = hypen(CounterState(), name: "Counter", app: app)
    .onAction("increment") { state in state.count += 1 }
    .build()

// Set up route-driven module lifecycle
let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
    .addRoute(RouteDefinition(path: "/", component: "HomePage"))
    .addRoute(RouteDefinition(path: "/counter", component: "Counter"))

managed.start()
router.push("/counter") // auto-mounts Counter, unmounts HomePage
```

## Session Management

```swift
let sessionManager = SessionManager(config: SessionConfig(
    ttl: 300,  // 5 minutes
    concurrent: .kickOld
))

let module = hypen(CounterState())
    .onAction("increment") { state in
        state.count += 1
    }
    .onDisconnect { state, session in
        print("Client \(session.id) disconnected, count was \(state.count)")
    }
    .onReconnect { session, restore in
        print("Client \(session.id) reconnected")
        restore(["count": 42])
    }
    .onExpire { session in
        print("Session \(session.id) expired")
    }
    .build()
```

## Nested Modules

Compose a parent module from several independently stateful child modules. Each nested module registers under its lowercase name in the shared `HypenGlobalContext`, so `@{feed.items}` and `@actions.feed.refresh` resolve from the parent template:

```swift
struct CounterState: Codable { var count: Int = 0 }
struct FeedState: Codable { var items: [String] = [] }

let app = HypenApp()

_ = app.module("Counter")
    .defineState(CounterState())
    .onAction("increment") { state in
        state.count += 1
    }
    .build()

_ = app.module("Feed")
    .defineState(FeedState())
    .onAction("refresh") { state in
        state.items = []
    }
    .build()

let globalContext = HypenGlobalContext()
let instances = createNestedModuleInstances(app: app, globalContext: globalContext)
// instances["counter"], instances["feed"]

let merged = getMergedState(
    primaryInstance: instances["counter"]!,
    nestedInstances: instances,
)

// Tear down together when the parent unmounts:
destroyNestedModuleInstances(instances, globalContext: globalContext)
```

The typed `defineState<S: Codable>(_:)` overload returns a
`TypedModuleBuilder<S>` pre-registered with the module name, so each
handler receives a `var`-bound `S` instead of an untyped state bag.
Use the untyped `defineState([String: Any])` overload only when the
state shape is genuinely dynamic.

## Events

```swift
let emitter = TypedEventEmitter()

// Subscribe to framework events
emitter.on(HypenEvents.moduleCreated) { event in
    print("Module created: \(event.moduleId)")
}

emitter.on(HypenEvents.routeChanged) { event in
    print("Route: \(event.from ?? "/") -> \(event.to)")
}

// Custom events
let myEvent = EventKey<String>("chat:message")
let unsub = emitter.on(myEvent) { message in
    print("Received: \(message)")
}
emitter.emit(myEvent, payload: "Hello!")
unsub() // Unsubscribe
```

## Cross-Module Communication

```swift
let ctx = HypenGlobalContext()

// Register modules
ctx.registerModule("counter", instance: counterInstance)
ctx.registerModule("profile", instance: profileInstance)

// Access from action handlers
let counterRef = ctx.getModule("counter")!
counterRef.dispatchAction("increment")
let state = counterRef.getState() // ["count": 1]

// Global state snapshot
let globalState = ctx.getGlobalState()
// { "counter": { "count": 1 }, "profile": { "name": "Alice" } }
```

## Component Discovery

Auto-discover `.hypen` components from the filesystem:

```swift
// Scan a directory
let components = try discoverComponents("./components", options: DiscoveryOptions(
    patterns: [.folder, .sibling, .index],
    recursive: true
))

// Load into the component loader
loadDiscoveredComponents(components, into: componentLoader)

// Watch for changes (hot reload)
let watcher = ComponentWatcher(baseDir: "./components", options: WatchOptions(
    pollInterval: 1.0,
    onAdd: { print("Added: \($0.name)") },
    onRemove: { print("Removed: \($0)") },
    onUpdate: { print("Updated: \($0.name)") }
))
watcher.start()
```

### Import Resolution

```swift
let resolver = ComponentResolver(options: ResolverOptions(
    baseDir: "./components",
    app: myApp  // Check registry first
))

// Parse and resolve imports from Hypen DSL
let imports = parseImports("""
    import { Button, Card } from "./ui"
    import HomePage from "https://cdn.example.com/home"
""")

for stmt in imports {
    let resolved = try resolver.resolve(stmt)
    // resolved["Button"] -> ResolvedComponent(module, template)
}
```

## Agent Surface (Attach Mode)

Callers that are not the rendered UI — an MCP server, an operator route, an
LLM agent — reach a session through the engine's **guarded** external surface
(`NativeEngine.dispatchExternal`, never `dispatchAction`): only declared
`.onAction()` names, `Router { Route }` targets and `.bind()` fields are
dispatchable, and only the state paths the template renders are readable.
`RemoteServer.attach(_:)` binds such a caller to a **live user session**, so the
dispatch runs on that user's engine and the user's own transport receives the
result:

```swift
// From a request handler that has already authenticated the caller for
// sessionID — attach(_:) does no authorization of its own and has no HTTP
// route; whoever calls it is the authorizer.
guard let handle = server.attach(sessionID) else {
    return // unknown id, hello not yet completed, or destroyed — indistinguishable
}

let actions = try handle.listActions()                       // declared surface only
try handle.dispatch("addToCart", payload: ["sku": "A1"])     // user's transport re-renders
let total = try handle.getState(module: "Cart", path: "total") // bounded to rendered paths
let revision = try handle.revision
let manifest = try handle.manifest()                         // MCP manifest JSON, verbatim
```

A successful `dispatch` emits on the user's transport exactly what a click
does: `patch` at revision N+1, then `stateUpdate` at N+2. A guard refusal
throws the engine's `HypenError.ActionError` before anything is queued —
no traffic, no revision bump. The handle holds the session weakly and
**never owns it**: it cannot destroy, suspend or close the session, and once
the user's session is gone `isAlive` is `false` and every member throws
`AgentHandleError.sessionGone`. `attach` returns `nil` until the session has
completed hello → initialTree (`RemoteSession.isReady`), because before the
initial render the engine's declaration tables are empty.

Attach requires a typed module (`module(_:_:)` with a `ModuleDefinition`,
or `.app(myApp)`). The legacy `withState` + `onAction` shim never registers
engine handlers or declares actions, so under it the guard refuses every
attached dispatch.

## Device Capabilities (RFC 001, provisional)

Module handlers can use the connected client's device — permissions, photo/file
pickers, camera, microphone, Bluetooth, file downloads — through `ctx.device`.
The protocol itself (request ids, leases, credit, blob verification, scheduling)
runs in the Rust device broker shared by every Hypen server SDK; the Swift
server adds the handshake and an async API. The device plane is **on by
default**: any client whose `hello` offers `device` gets one, with no call.

```swift
let app = HypenApp.shared.module("App").defineState(["status": ""])
    .onActionAsync("checkCamera") { ctx in
        switch await ctx.device.permissions.query(.camera) {      // typed Permission enum
        case .success(let v): ctx.state.set("status", v.status.rawValue)
        case .failure(let e): ctx.state.set("status", e.code.rawValue) // denied, unsupported, …
        }
    }
    .onActionAsync("upload") { ctx in
        if case .success(let picked) = await ctx.device.gallery.pick([.photo]) {
            store(picked.items[0].bytes)                            // sha256-verified bytes
        }
    }
    .onActionAsync("scan") { ctx in
        for await device in ctx.device.bluetooth.scan() {           // AsyncSequence, credit-paced
            if device.rssi > -50 { break }                          // leaving the loop cancels
        }
    }
    .onActionAsync("export") { ctx in
        _ = await ctx.device.files.save(reportData, name: "report.csv", contentType: "text/csv")
    }
    .build()

RemoteServer()
    .module("App", app)
    .ui(ui)
    .config(ServerConfig(                                           // recommended in production
        allowedOrigins: ["https://app.example.com"],                // browsers
        authenticate: { req in req.header("Authorization") == "Bearer …" } // every client
    ))
    .listen(3000)
```

Every call returns `Result<DeviceValue<T>, DeviceError>` and never throws;
cancelling the calling `Task` cancels the request on the device. Requests are
owned by the module's current activation: navigating away cancels them.
Replayed or broadcast dispatches (`broadcastAction`) cannot start device work.

- **Options**: `configureDevice(DeviceServerOptions(...), processRetainedBytes:)`
  changes limits, budgets, the clock or revision overrides (defaults otherwise);
  options the broker refuses make `prepare()` throw `invalidDeviceOptions`.
- **Opt out**: `disableDevice()` makes the server UI-only.
- **Admission**: `allowedOrigins` and `authenticate` are enforced exactly when
  configured (native clients send no `Origin`, so they need `authenticate`).
  With neither, every client is admitted and one startup warning is logged.
- **Incompatible settings** never stop the server: `RemoteServer(sessionConfig:
  SessionConfig(concurrent: .allowMultiple))` runs with the device plane off and
  one startup warning.
- **Legacy clients**: a hello grace (`createSession(transport:helloGraceMs:)`)
  still auto-initialises clients that never send `hello` (without a device
  plane). Every `sessionAck` carries a `resumeToken`; it is required to resume a
  session that had a device plane, while a UI-only session resumes by id.

Work that should outlive navigation uses the `background` lifetime, which a
revision must allow — configure it with
`configureDevice(DeviceServerOptions(revisionOverrides: [DeviceRevisionOverride(capability:
"bluetooth.scan", version: 1, lifetimes: [.activation, .background])]))`. It is
owned by the module instance (swept when it is destroyed), and at most
`maxBackgroundOwners` modules (default 2) per connection may hold it; a further
module's request fails `throttled`. For capability names only known at runtime,
`ctx.device.requestUntyped("permission.query", paramsJSON: #"{"permission":"camera"}"#)`
returns the validated result as JSON (`.resultJSON`, `.decode(_:)`).

## Connecting Clients

### iOS (HypenSwift)

```swift
import HypenSwift

struct ContentView: View {
    var body: some View {
        HypenView(url: "ws://localhost:3000/ws")
    }
}
```

### Android (hypen-renderer-android)

```kotlin
HypenView(url = "ws://10.0.2.2:3000/ws")
```

### Web

```typescript
import { RemoteEngine } from "@hypen-space/core";

const engine = new RemoteEngine("ws://localhost:3000/ws");
engine.connect();
```

## Architecture

| Component | Description |
|-----------|-------------|
| `TypedModuleBuilder` | Fluent chainable API with typed state, actions, and payloads |
| `HypenAction` | Protocol for type-safe action enums |
| `ObservableState` | Reactive state with path-based change tracking |
| `ModuleInstance` | Runtime module with error handling and session lifecycle |
| `TypedEventEmitter` | Type-safe event system with `EventKey<T>` |
| `HypenRouter` | URL routing with path params, wildcards, query parsing |
| `ManagedRouter` | Route-driven module mount/unmount orchestration |
| `SessionManager` | TTL-based session persistence with concurrent policies |
| `createNestedModuleInstances` | Instantiate child modules under a shared global context |
| `GlobalContext` | Cross-module communication hub |
| `ComponentLoader` | Register and load components by name |
| `ComponentDiscovery` | Filesystem scanning for `.hypen` files |
| `ComponentResolver` | Import resolution from local files and URLs |
| `RemoteServer` | WebSocket server streaming state/patches to clients |
| `AgentHandle` | Attach mode: guarded, non-owning agent view of one live session (`RemoteServer.attach(_:)`) |
| `RemoteEngine` | WebSocket client with auto-reconnect |

## WebSocket Protocol

Same message protocol as all Hypen SDKs (Go, Kotlin, TypeScript, Rust):

**Server -> Client:**
```json
{ "type": "initialTree", "module": "Counter", "state": { "count": 0 }, "patches": [], "revision": 0 }
{ "type": "stateUpdate", "module": "Counter", "state": { "count": 1 }, "revision": 1 }
```

**Client -> Server:**
```json
{ "type": "dispatchAction", "module": "Counter", "action": "increment", "payload": null }
```

### Compression (`permessage-deflate`)

**Not supported by the Swift server.** Other Hypen SDKs negotiate RFC 7692
`permessage-deflate` by default (with a `compression` opt-out); the Swift
server does not, and there is no `compression` option on `ServerConfig`
because there is nothing to turn off.

Why: `RemoteServer` upgrades connections with SwiftNIO's
`NIOWebSocketServerUpgrader` and runs frames through WebSocketKit. Neither
implements RFC 7692 — NIO's upgrader never reads or echoes
`Sec-WebSocket-Extensions`, and [vapor/websocket-kit#55][wsk55] has been open
since 2020. The maintained Swift implementation, `WSCompression` in
[hummingbird-project/swift-websocket][swift-websocket], is tied to that
package's own `WSCore` handler and upgrade path and cannot be dropped into a
WebSocketKit pipeline, so adopting it would mean replacing this transport
outright.

**This is safe, not broken.** Compression is negotiated per-connection. A
client that offers `permessage-deflate` receives a 101 response that does not
accept it and, per RFC 7692 §5.1, falls back to uncompressed frames. So:

- Hypen web/Go/Kotlin/Rust **clients** talk to this server fine — uncompressed.
- The iOS renderer (`hypen-renderer-swift`) *does* offer the extension —
  `URLSessionWebSocketTask` does so automatically and with no opt-out — and
  falls back cleanly when this server declines. That client gets real
  compression against the other Hypen server SDKs.

One rule if you ever change the handshake: **never accept the extension
without implementing it.** Apple's client validates the 101 response against
what it offered and hard-fails the connection on an extension it did not
negotiate, and NIO's frame decoder likewise rejects RSV1-flagged frames when no
extension is in play.

Practical impact: Hypen's wire traffic is JSON patches, which deflate well
(often 5-10x on large `initialTree` messages). If bandwidth matters for your
deployment, terminate WebSockets behind a proxy that handles compression, or
use one of the other server SDKs.

[wsk55]: https://github.com/vapor/websocket-kit/issues/55
[swift-websocket]: https://github.com/hummingbird-project/swift-websocket

## Logging

Hypen logs to `print` by default: debug lines only in DEBUG builds,
info/warn/error always. Change that with the global log level:

```swift
setLogLevel(.warn)    // or setDebugMode(true) / setLogLevel(.none)
```

### Routing logs into your own logger

Install a handler to send the same messages anywhere — `os.Logger`,
swift-log, a structured JSON sink, an aggregator. The SDK still does the
level filtering and formatting; the handler just receives the final tag
and message:

```swift
import Logging   // swift-log

let appLogger = Logger(label: "com.example.app.hypen")

setLogHandler { level, tag, message in
    switch level {
    case .debug: appLogger.debug("[\(tag)] \(message)")
    case .info:  appLogger.info("[\(tag)] \(message)")
    case .warn:  appLogger.warning("[\(tag)] \(message)")
    default:     appLogger.error("[\(tag)] \(message)")
    }
}
```

Or conform a type to `HypenLogHandler` for full control:

```swift
struct MyLogHandler: HypenLogHandler {
    func debug(tag: String, message: String) { /* ... */ }
    func info(tag: String, message: String)  { /* ... */ }
    func warn(tag: String, message: String)  { /* ... */ }
    func error(tag: String, message: String) { /* ... */ }
}

setLogHandler(MyLogHandler())
setLogHandler(nil)   // back to print
```

Set the handler (and the level) **once at startup**, before `listen()` —
`HypenLoggerConfig.shared` is unsynchronised global configuration, so
mutating it while the server is serving is a data race.

## Requirements

- Swift 6.0+
- macOS 13+ / iOS 16+
- [WebSocketKit](https://github.com/vapor/websocket-kit) (SwiftNIO-based)

## Related Packages

| Package | Language | Description |
|---------|----------|-------------|
| `hypen-golang` | Go | Go server SDK |
| `hypen-kotlin` | Kotlin | Kotlin/JVM server SDK |
| `hypen-web` | TypeScript | Web SDK (server + client) |
| `hypen-sdk-rs` | Rust | Rust server SDK |
| `hypen-renderer-swift` | Swift | iOS/SwiftUI client renderer |

## License

MIT
