# Hypen Kotlin SDK

A Kotlin implementation of the Hypen SDK for building stateful UI modules. This SDK provides the same API as the TypeScript and Go SDKs, enabling cross-platform module development.

## Features

- **Typed Kotlin DSL** — idiomatic typed state + `HypenAction` sealed-interface dispatch
- **Fluent Builder API** — create modules with a clean, chainable API
- **Observable State** — reactive state management with automatic change tracking
- **Full Type Safety** — typed state classes, typed action payloads, null safety
- **Lifecycle Hooks** — `onCreated`, `onDestroyed`
- **Session Hooks** — `onDisconnect`, `onReconnect`, `onExpire` with TTL-based `SessionManager`
- **Nested Modules** — compose a parent module from independently stateful child modules
- **Router** — built-in routing with pattern matching
- **Global Context** — cross-module communication and events
- **HypenServer** — WebSocket server for streaming UI to iOS / Android / Web clients

## Installation

Add to your `build.gradle.kts`:

```kotlin
dependencies {
    implementation("space.hypen:hypen-kotlin:0.5.0")
}
```

## Quick Start

### Typed DSL (recommended)

Model state as a `@Serializable` data class and actions as a `sealed interface` extending `HypenAction`. Handlers mutate `state` directly — no string-keyed `get`/`set`, no casts.

```kotlin
import kotlinx.serialization.Serializable
import space.hypen.core.*

@Serializable
data class CounterState(var count: Int = 0)

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
    @Serializable data class Add(val amount: Int) : CounterAction
}

val counterDef = hypen(CounterState(count = 0)) {
    name("Counter")

    onCreated { state, _ ->
        println("Counter created with count=${state.count}")
    }

    onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
    onAction<CounterAction.Decrement> { _, state, _ -> state.count -= 1 }
    onAction<CounterAction.Add> { action, state, _ ->
        state.count += action.amount
    }

    onDestroyed { state, _ ->
        println("Counter destroyed at count=${state.count}")
    }

    ui("""
        Column {
            Text("Count: @{state.count}")
            Row {
                Button("@actions.decrement") { Text("-") }
                Button("@actions.increment") { Text("+") }
            }
        }
    """.trimIndent())
}

// Serve with the HypenServer DSL — register every module on the server, add
// routes if you have multiple, then install on your Ktor application.
val server = HypenServer {
    module("Counter", counterDef)
    // module("Feed", feedDef)
    // route("/counter", "Counter")
}
// server.install(ktorApplication)
```

Modules built with `name("…")` also auto-register on the global `HypenApp` singleton, so `ManagedRouter` and `ComponentResolver` find them without extra wiring. For a one-off unit test you can still create a standalone instance with `counterDef.createInstance(engine)`.

### Fluent Builder API

The same surface is available as a builder for dynamic shapes:

```kotlin
import space.hypen.core.*

@Serializable
data class UserState(
    var name: String = "",
    var email: String = "",
    var isLoggedIn: Boolean = false,
)

val userModule = AppBuilder.defineState(UserState())
    .onCreated { state, _ -> println("User module created") }
    .onAction<String>("login") { payload, state, _ ->
        state.isLoggedIn = true
        state.name = payload ?: "User"
    }
    .onAction("logout") { _, state, _ ->
        state.isLoggedIn = false
        state.name = ""
    }
    .onDestroyed { state, _ -> println("User module destroyed") }
    .build()
```

An untyped `defineState(mapOf(...))` variant is still available for fully dynamic state; prefer the typed form for new code.

## Core API

### Types

```kotlin
// Patch for DOM operations
data class Patch(
    val type: String,           // "create", "setProp", "insert", etc.
    val id: String?,
    val elementType: String?,
    val props: Map<String, JsonElement>?,
    val name: String?,
    val value: JsonElement?,
    val parentId: String?,
    val beforeId: String?
)

// Action for dispatch
data class Action(
    val name: String,
    val payload: JsonElement?,
    val sender: String?
)

// State change notification
data class StateChange(
    val paths: List<String>,
    val newValues: Map<String, Any?>
)
```

### ObservableState

```kotlin
val state = ObservableState(mapOf("count" to 0)) { change ->
    println("State changed: ${change.paths}")
}

// Get/set values
state.set("count", 1)
val count = state.get("count")

// Batch updates
state.batch {
    state.set("count", 10)
    state.set("name", "Updated")
}

// Get snapshot
val snapshot = state.getAll()
```

### Router

```kotlin
val router = router("/")

router.push("/users")
router.push("/users/123")

val params = router.getParams()  // from pattern matching
val query = router.getQuery()    // from URL query string

router.onNavigate { from, to ->
    println("Navigated from $from to $to")
}

// Pattern matching
val match = router.matchPath("/users/:id", "/users/123")
// match.params["id"] == "123"
```

### Session Lifecycle

When a client disconnects, Hypen suspends the session and resumes it on reconnect within a TTL. Hook into the transitions to persist/restore state:

```kotlin
val counterDef = hypen(CounterState()) {
    name("counter")

    onDisconnect { state, session ->
        println("session ${session.id} disconnected, count=${state.count}")
    }
    onReconnect { state, session, saved ->
        (saved["count"] as? Int)?.let { state.count = it }
        println("session ${session.id} reconnected")
    }
    onExpire { session ->
        println("session ${session.id} expired")
    }
}
```

For manual session management (custom transports), use `SessionManager`:

```kotlin
val manager = SessionManager(SessionConfig(ttl = 300)) // seconds
val session = manager.createSession()
manager.trackConnection(session.id, connKey)

// on socket close:
manager.suspendSession(session.id, currentState) {
    // TTL elapsed without a reconnect
}

// on reconnect:
val pending = manager.resumeSession(session.id)
```

### Nested Modules

Compose a parent module from several independently stateful child modules. Each nested module registers under its lowercase name in the shared `GlobalContext`, so `@{feed.items}` and `@actions.feed.refresh` resolve from the parent template:

```kotlin
val feedDef = AppBuilder.defineState(
    FeedState(),
    ModuleOptions(name = "Feed"),
)
    .onAction("refresh") { _, state, _ -> state.reload() }
    .build()

val feed = NestedModuleInstance(engine, feedDef) // registers under "feed" in the engine
```

`NamedStateRegistry` holds the merged state tree; `GlobalContext` routes dispatches to the right nested instance.

### GlobalContext

```kotlin
val context = globalContext()

// Register modules
context.registerModule("counter", counterInstance)
context.registerModule("user", userInstance)

// Cross-module communication
val counterRef = context.getModule<MutableMap<String, Any?>>("counter")
counterRef?.setState(mapOf("count" to 10))

// Events
context.on("custom:event") { payload ->
    println("Event received: $payload")
}
context.emit("custom:event", mapOf("data" to "value"))
```

## Compatibility Tests

This SDK is verified against the shared compatibility test suite to ensure consistent behavior with TypeScript and Go implementations.

Run tests:
```bash
./gradlew test
```

## Building

```bash
# Build the library
./gradlew build

# Run tests
./gradlew test

# Generate documentation
./gradlew dokkaHtml
```

## Architecture

```
space.hypen.core/
├── Types.kt                # Core types (Patch, Action, StateChange, HypenAction)
├── Engine.kt               # IEngine interface
├── NativeEngine.kt         # WASM-backed engine via JNA
├── ObservableState.kt      # Reactive state container
├── AppBuilder.kt           # Typed + untyped fluent module builder
├── ModuleInstance.kt       # Runtime module management
├── NestedModuleInstance.kt # Child modules sharing a parent context
├── Session.kt              # SessionManager (TTL, reconnect, expire)
├── GlobalContext.kt        # Cross-module communication
├── Router.kt / ManagedRouter.kt # Navigation and route-driven lifecycle
├── HypenServer.kt          # WebSocket server for remote UI
├── ComponentLoader.kt      # Template/module registry
├── ComponentResolver.kt    # Import resolution
├── ComponentWatcher.kt     # Filesystem watcher for hot reload
├── Dsl.kt                  # Kotlin DSL (`hypen { ... }`)
└── Utils.kt                # JSON and utility functions
```

## License

MIT
