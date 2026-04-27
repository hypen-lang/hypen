# Hypen Go SDK

A complete Go implementation of the Hypen reactive UI framework SDK.

## Installation

```bash
go get github.com/hypen-space/core
```

Requires Go 1.21+.

## Quick Start

Define module state as a Go struct and mutate it directly in action handlers —
no `any` casts, no string-keyed Get/Set, typos caught at compile time.

```go
package main

import (
    "fmt"
    "log"

    core "github.com/hypen-space/core"
)

// State is a plain Go struct. json tags match the names referenced from
// the Hypen DSL template (@{state.count}, @{state.message}).
type CounterState struct {
    Count   int    `json:"count"`
    Message string `json:"message"`
}

func main() {
    // Define the module — .Name(...).Build() auto-registers on the
    // package-level core.App singleton, so RemoteServer discovers it
    // (and any other modules you define) when you serve.
    counter := core.NewApp(CounterState{Count: 0, Message: "Ready"}).
        Name("Counter").
        OnCreated(func(state *CounterState, _ core.GlobalContext) {
            fmt.Println("Counter module created!")
        }).
        OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
            ctx.State.Count++ // direct field mutation — type-safe
        }).
        OnAction("decrement", func(ctx core.TypedActionContext[CounterState]) {
            ctx.State.Count--
        }).
        UI(`
            Column {
                Text("@{state.count}").fontSize(48)
                Text("@{state.message}")
                Row {
                    Button("@actions.decrement") { Text("-") }
                    Button("@actions.increment") { Text("+") }
                }
            }
        `).
        Build()

    // Serve the whole app. WithDefinition sets the primary module; any
    // other modules built with a .Name(...) are picked up automatically
    // from core.App as nested modules.
    server := remote.NewRemoteServer().WithDefinition(counter)
    if err := server.Listen(3000); err != nil {
        log.Fatal(err)
    }
}
```

Mutations made to `ctx.State` are diffed against a pre-handler snapshot when
the handler returns; only the changed top-level keys are committed to the
underlying `ObservableState`, so the engine still sees minimal deltas.

> **Single-module demo?** The lower-level `RemoteServer.WithState("Name", map[string]any{...}).OnAction(...).UI(...).Listen(port)` form skips the typed builder for quick experiments. Prefer the `core.NewApp[T]...Build()` + `WithDefinition` flow above for real code.

> **Untyped API.** The lower-level `NewAppBuilder(map[string]any{...}, nil)`
> API is still supported for dynamic state shapes and remains the foundation
> that `NewApp[T]` wraps. Prefer `NewApp[T]` for all new code.

## Features

### State Management

Observable state with automatic change tracking:

```go
state := core.NewObservableState(map[string]any{
    "user": map[string]any{
        "name": "Alice",
        "age":  30,
    },
}, &core.StateObserverOptions{
    OnChange: func(change core.StateChange) {
        fmt.Printf("Changed paths: %v\n", change.Paths)
    },
})

state.Set("user.name", "Bob")  // Triggers OnChange with paths: ["user.name"]
```

### Event System

Type-safe pub/sub event emitter:

```go
emitter := core.CreateEventEmitter()

// Subscribe
unsub := emitter.On("userLoggedIn", func(payload any) {
    user := payload.(map[string]any)
    fmt.Printf("Welcome, %s!\n", user["name"])
})

// Emit
emitter.Emit("userLoggedIn", map[string]any{"name": "Alice"})

// Unsubscribe
unsub()
```

### Routing

Pattern-based router with parameter extraction:

```go
router := core.NewHypenRouter("/")

router.OnNavigate(func(path string) {
    fmt.Printf("Navigated to: %s\n", path)
})

router.Push("/users/123?tab=profile")

match, params := router.MatchPath("/users/:id")
// match: true, params: {"id": "123"}

query := router.GetQuery()
// query: {"tab": "profile"}
```

### Remote UI (WebSocket)

Stream Hypen apps over WebSocket:

**Server (typed module):**
```go
import (
    core "github.com/hypen-space/core"
    "github.com/hypen-space/core/remote"
)

type CounterState struct {
    Count int `json:"count"`
}

// Define every module with .Name(...).Build() — each one auto-registers
// onto the core.App singleton. WithDefinition picks the primary module;
// nested modules are discovered from the registry at serve time.
feed := core.NewApp(FeedState{}).
    Name("Feed").
    OnAction("refresh", func(ctx core.TypedActionContext[FeedState]) { /* ... */ }).
    Build()

counter := core.NewApp(CounterState{}).
    Name("Counter").
    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count++
    }).
    UI(`Column { Text("Count: @{state.count}") Button("@actions.increment") { Text("+") } }`).
    Build()

_ = feed // registered; referenced via @{feed.items} from the parent template

server := remote.NewRemoteServer().
    WithDefinition(counter).
    Config(remote.ServerConfig{Port: 3000}).
    OnConnection(func(client *remote.Client) {
        fmt.Printf("Client connected: %s\n", client.ID)
    })

server.Listen()
defer server.Stop()
```

> **Single-module demo.** The lower-level `WithState("Name", map[string]any{...}).OnAction(func(action, payload, state))` form skips the typed builder and the registry. Fine for one-off experiments; prefer `NewApp[T]...Name(...).Build()` + `WithDefinition` for real apps.

**Client:**
```go
import "github.com/hypen-space/core/remote"

client := remote.NewRemoteEngine("ws://localhost:3000/ws", nil).
    OnConnect(func() {
        fmt.Println("Connected!")
    }).
    OnPatches(func(patches []remote.Patch) {
        for _, p := range patches {
            fmt.Printf("Patch: %+v\n", p)
        }
    }).
    OnStateUpdate(func(state any) {
        fmt.Printf("State: %v\n", state)
    })

client.Connect()
defer client.Disconnect()

client.DispatchAction("increment", nil)
```

### Session Lifecycle

When a client disconnects, Hypen can suspend the session and resume it on reconnect within a TTL. Register hooks on the typed `NewApp[T]` builder — context types carry a `*T` state pointer so handlers mutate fields directly, no string-keyed casts required:

```go
type CounterState struct {
    Count int `json:"count"`
}

def := core.NewApp(CounterState{Count: 0}).
    OnDisconnect(func(ctx core.TypedDisconnectContext[CounterState]) {
        fmt.Printf("session %s disconnected, count=%d\n",
            ctx.Session.ID(), ctx.State.Count)
    }).
    OnReconnect(func(ctx core.TypedReconnectContext[CounterState]) {
        // Restore pushes a typed value back into live state.
        ctx.Restore(CounterState{Count: 0})
    }).
    OnExpire(func(ctx core.ExpireContext) {
        fmt.Printf("session %s expired\n", ctx.Session.ID())
    }).
    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count++
    }).
    UI(`Column { Text("Count: @{state.count}") }`)
```

For manual session management (custom transports), use `SessionManager`:

```go
mgr := core.NewSessionManager(&core.SessionConfig{TTL: time.Hour})
session := mgr.CreateSession(nil)
mgr.TrackConnection(session.ID(), connKey)

// on socket close:
mgr.SuspendSession(session.ID(), currentState, func() {
    // called when TTL elapses without a reconnect
})

// on reconnect:
pending, saved := mgr.ResumeSession(session.ID())
```

### Nested Modules

Compose a parent module from several independently stateful child modules. Each nested module registers under its lowercase name in the shared `HypenGlobalContext`, so `@{feed.items}` and `@actions.feed.refresh` resolve correctly from parent templates:

```go
app := core.NewHypenApp()
app.Module("Feed").DefineState(FeedState{}).
    OnAction("refresh", func(ctx core.TypedActionContext[FeedState]) {
        ctx.State.Reload()
    }).
    Build()

globalCtx := core.NewHypenGlobalContext()
nested := core.CreateNestedModuleInstances(engine, app, globalCtx, nil)
feedInstance := nested["feed"]
```

Inside a single module file you can also construct a nested instance directly:

```go
core.NewModuleInstance(engine, feedDef, core.AsNested())
```

### Global Context

Cross-module communication:

```go
ctx := core.NewHypenGlobalContext()

// Register modules
ctx.RegisterModule("counter", counter)
ctx.RegisterModule("logger", logger)

// Subscribe to global events
ctx.On("countChanged", func(payload any) {
    fmt.Printf("Count is now: %v\n", payload)
})

// Emit from any module
ctx.Emit("countChanged", 42)

// Access other modules
ref := ctx.GetModule("counter")
state := ref.GetState()
```

### Component Loader

Load and manage component templates:

```go
loader := core.NewComponentLoader()

loader.Register(&core.ComponentDefinition{
    Name:     "Button",
    Template: `Button(@actions.click) { Text("@{props.label}") }`,
})

// Load from filesystem
loader.LoadFromDirectory("/path/to/components")

// Get component
btn := loader.Get("Button")
fmt.Println(btn.Template)
```

## API Reference

### Core Package

| Type | Description |
|------|-------------|
| `ObservableState` | Reactive state container with change tracking |
| `TypedEventEmitter` | Type-safe pub/sub event system |
| `HypenGlobalContext` | Cross-module communication hub |
| `NewApp[T]` / `TypedAppBuilder[T]` | Generic, type-safe module builder with struct-backed state (recommended) |
| `AppBuilder` | Low-level fluent builder with `map[string]any` state |
| `TypedActionContext[T]` | Typed action context — mutate `ctx.State` directly |
| `ModuleInstance` | Running module with state and lifecycle |
| `HypenRouter` | URL-based navigation with pattern matching |
| `ComponentLoader` | Template/module registration and loading |
| `BaseRenderer` | Abstract renderer for platform implementations |
| `TestRenderer` | Recording renderer for testing |
| `SessionManager` | TTL-based session persistence with reconnect/expire |
| `CreateNestedModuleInstances` | Instantiate nested modules under a shared global context |
| `DisconnectContext` / `ReconnectContext` / `ExpireContext` | Session-hook payloads for `OnDisconnect` / `OnReconnect` / `OnExpire` |

### Remote Package

| Type | Description |
|------|-------------|
| `RemoteEngine` | WebSocket client for remote UI |
| `RemoteServer` | WebSocket server for streaming apps |
| `Patch` | DOM operation (create, update, remove) |
| `Message` | Protocol message types |

## Testing

Run all tests:

```bash
go test ./...
```

Run with verbose output:

```bash
go test ./... -v
```

## License

MIT
