# HypenServer — Swift SDK

Server-driven UI module system for Swift. Build reactive, cross-platform UIs with the [Hypen](https://github.com/hypen-lang/hypen) DSL and stream them to any renderer (DOM, Canvas, iOS, Android) over WebSocket.

> **Note:** This package lives in the main Hypen monorepo. Please open issues and PRs on the main repo: [hypen-lang/hypen](https://github.com/hypen-lang/hypen).

## Installation

### Swift Package Manager

```swift
// Package.swift
// Clone https://github.com/hypen-lang/hypen
dependencies: [
    .package(path: "../hypen/hypen-server-swift"),
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
