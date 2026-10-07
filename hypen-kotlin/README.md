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
- **HypenServer** — WebSocket server for streaming UI to iOS / Android / Web clients, with device access (RFC 001) and per-message permessage-deflate both on by default (see Compression)
- **Attach mode** — `HypenServer.attach(sessionId)` hands an agent a guarded, non-owning `AgentHandle` over a live user session

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
// routes if you have multiple, then wire it into your Ktor application.
val server = HypenServer {
    module("Counter", counterDef)
    // module("Feed", feedDef)
    // route("/counter", "Counter")
}
```

See [WebSocket transport](#websocket-transport) for the Ktor wiring.

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

## WebSocket transport

`HypenServer` is transport-agnostic: it exposes `admit` / `openConnection` /
`handleMessage` / `handleBinary` / `handleDisconnect` and leaves the socket itself to
your application. On Ktor that means **your app installs the `WebSockets` plugin**,
not the SDK.

### Wiring a connection

1. **Admit the upgrade before accepting the socket.** `server.admit(UpgradeRequest(...))`
   returns `Admission.Admitted` or `Admission.Rejected(status = 403, …)`; answer the
   status instead of upgrading when it refuses. Each check applies exactly when you
   configure it: with `allowedOrigins(...)`, a browser `Origin` must be in the list and a
   request without one (a native client) is admitted only by your `authenticate { }` hook;
   a configured authenticator runs for every request. With neither configured every
   upgrade is admitted and the server logs a startup warning — set them in production.
2. **Open a hello-driven connection.** `openConnection(key, transport)` sends nothing
   until the client's `hello`, which creates or resumes the session. Feed text frames to
   `handleMessage`, binary frames to `handleBinary`, and call `handleDisconnect` when the
   socket closes. Every write goes through one ordered queue over your `HypenTransport`.
   `handleMessage` never throws for a bad client message: a malformed text, a UI action
   the engine refuses (e.g. on a node a re-render just removed) or a failing handler is
   logged and dropped, so one message cannot end your read loop and the connection.

The UI messages match the TypeScript server member for member — `initialTree`
`{type, module, state, patches, revision}` (plus `routes`) and `patch`
`{type, module, patches, revision}` — which the Android (Moshi) and native desktop
(serde) clients require; `RemoteWireConformanceTest` pins the shapes. These plus
`sessionAck` and `sessionExpired` are the only UI message types the server sends:
a route-table `navigate` answers with a `patch` that replaces the screen, and a
`watchComponents` hot reload closes hello-driven sockets with 1012 so the client
reconnects into the new sources (as the TypeScript server does).

```kotlin
routing {
    route("/ws") {
        install(HypenAdmission)   // 403 unless server.admit(...) admits the upgrade
        webSocket {
            val key = this
            server.openConnection(key, object : HypenTransport {
                override suspend fun sendText(text: String) = send(Frame.Text(text))
                override suspend fun sendBinary(bytes: ByteArray) = send(Frame.Binary(true, bytes))
                override suspend fun close(code: Int, reason: String) = close(CloseReason(code.toShort(), reason))
            }, webSocketExtensions = extensionOrNull(HypenDeflate)?.negotiated ?: "")  // see Compression
            try {
                for (frame in incoming) when (frame) {
                    is Frame.Text -> server.handleMessage(key, frame.readText()) {}
                    is Frame.Binary -> server.handleBinary(key, frame.readBytes())
                    else -> {}
                }
            } finally {
                server.handleDisconnect(key)
            }
        }
    }
}
```

`HypenAdmission` is a small route-scoped plugin that builds the `UpgradeRequest` from
the call and responds 403; the example server defines it.

**Device access (RFC 001) is on by default.** A client whose `hello` offers `device`
gets a device plane (`sessionAck.device`) with no server call needed; a client that
offers none gets an ordinary UI session. Tune limits and budgets with
`configureDevice { … }` (e.g. `maxBackgroundOwners`, `revisionOverride(…)`,
`helloTimeoutMs`), or opt out entirely with `disableDevice()` (the server then behaves
exactly like a UI-only server). Every `sessionAck` carries a rotating `resumeToken`.
Resuming a session that had a device plane, or taking it over under
`ConcurrentPolicy.KICK_OLD`, requires that token — the public session id alone starts a
new session; a UI-only session still resumes by id. The legacy hello-less
`handleConnect` (session ack + initial tree sent right away) works on every server; its
sessions have no device plane, and a device session's id there starts a new session.

Incoming text is bounded before any parsing: device messages over 1 MiB, and any
message nested deeper than 256 containers, are never handed to the JSON parser.
Device-typed ones count as connection-level violations in the device broker (whose
strict decoder allows at most 32 levels).

### Compression

Hypen streams JSON patch batches, which deflate very well, so `server.compression`
(WebSocket permessage-deflate, RFC 7692) is `true` by default — with or without the
device plane. Compression is negotiated per connection, so clients that don't
advertise the extension keep receiving raw frames and nothing breaks.

Device data (RFC 001) may only be compressed **one message at a time**: the
negotiated extension must carry both `server_no_context_takeover` and
`client_no_context_takeover`, so every message is compressed on its own and device
data never shares a compression history with other messages (the cross-message
context CRIME/BREACH-style attacks rely on). Hypen clients keep a socket that
negotiated context takeover in either direction UI-only (no device plane), and so
does `openConnection` when you pass it the negotiated `Sec-WebSocket-Extensions`
(`webSocketExtensions`; `null` means you don't report it and vouch for the
configuration yourself).

Because the SDK never installs the plugin, read the flag where you do — and
negotiate no context takeover in both directions:

```kotlin
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import java.util.zip.Deflater
import kotlin.time.Duration.Companion.seconds

fun Application.configureSockets() {
    install(WebSockets) {
        pingPeriod = 15.seconds
        timeout = 15.seconds

        if (hypenServer.compression) {
            extensions {
                // WebSocketDeflateExtension with clientNoContextTakeOver = true and
                // serverNoContextTakeOver = true, negotiated as such (see below).
                install(HypenDeflate) {
                    compressionLevel = Deflater.DEFAULT_COMPRESSION
                    compressIfBiggerThan(bytes = 1024)
                }
            }
        }
    }

    routing {
        route("/ws") {
            install(HypenAdmission)
            webSocket {
                // … openConnection(key, transport,
                //       webSocketExtensions = extensionOrNull(HypenDeflate)?.negotiated ?: "")
            }
        }
    }
}
```

Why not plain `WebSocketDeflateExtension { clientNoContextTakeOver = true;
serverNoContextTakeOver = true }`? In Ktor 3.1.1 those two settings only shape Ktor's
own *client* offer: as a server it answers just the no-context-takeover parameters
the client offered — and browsers (`permessage-deflate; client_max_window_bits`) and
OkHttp (`permessage-deflate`) offer none, so every socket would negotiate context
takeover and run UI-only. Ktor also writes negotiated parameters comma-separated
(`permessage-deflate , a,b`), which clients reject. `HypenDeflate`
([`example-server/src/main/kotlin/HypenDeflate.kt`](example-server/src/main/kotlin/HypenDeflate.kt),
a small wrapper — copy it into your app) wraps `WebSocketDeflateExtension` with both settings
on, adds both parameters to the client's offer, and answers
`permessage-deflate; server_no_context_takeover; client_no_context_takeover`.
`HypenDeflateTest` checks it against a real Ktor/Netty server, including that each
message inflates on its own. `compressIfBiggerThan` skips tiny frames (session acks,
single `setProp` patches) where deflate framing overhead outweighs the saving.

Opt out for raw-wire debugging — a deflated payload is opaque to `tcpdump` and to
most WebSocket frame inspectors:

```kotlin
val server = HypenServer {
    module("Counter", counterDef)
    compression = false
}
```

A complete, runnable wiring lives in
[`example-server/src/main/kotlin/Sockets.kt`](example-server/src/main/kotlin/Sockets.kt).

## Attach mode (agent surface)

Callers that are not the rendered UI — an MCP server, an operator route, an
LLM agent — reach a session through the engine's **guarded** external surface:
only declared `onAction` names, `Router { Route }` targets and `.bind()` fields
are dispatchable, and only the state paths the template renders are readable.
`HypenServer.attach(sessionId)` binds such a caller to a **live user session**,
so the dispatch runs on that user's engine and the user's own WebSocket
receives the result. The client learns its id from `sessionAck` (the bundled
web client exposes it as `window.__hypen.getSessionId()`) and hands it to your
backend; it is a resume token, so accept it only over a channel you trust.

```kotlin
// From a route that has already authenticated the caller for sessionId —
// attach() does no authorization of its own; whoever calls it is the authorizer.
val handle = hypenServer.attach(sessionId)
    ?: return@post call.respond(HttpStatusCode.NotFound) // unknown, mid-handshake, disconnected or kicked

handle.listActions()                                   // declared surface only
handle.dispatch("addToCart", mapOf("sku" to "A1"))    // suspend; the user's socket gets one `patch`
handle.getState(path = "cart.total")                   // JsonElement?, bounded to rendered paths
handle.revision()
handle.manifest()                                      // MCP manifest JSON, verbatim from the engine
```

A successful `dispatch` puts exactly one `{"type":"patch","module":…,"patches":[...],"revision":N}`
frame on the user's socket — the same frame a renderer click produces — and
emits `HypenEvents.actionDispatched`. A guard refusal throws
`EngineError.ActionNotFound` before anything reaches the wire: nothing is sent
and the revision does not move. The handle **never owns the session**: it
cannot destroy, suspend or close it; once the client disconnects, is kicked, or
the server shuts down, `isAlive` is `false` and every member throws
`AgentSessionGoneException`. Under `ConcurrentPolicy.ALLOW_MULTIPLE` the first
ready connection with that id wins.

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
├── AgentHandle.kt          # Attach mode: guarded agent view of one live session
├── ComponentLoader.kt      # Template/module registry
├── ComponentResolver.kt    # Import resolution
├── ComponentWatcher.kt     # Filesystem watcher for hot reload
├── Dsl.kt                  # Kotlin DSL (`hypen { ... }`)
└── Utils.kt                # JSON and utility functions
```

## License

MIT
