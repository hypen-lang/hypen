# Execution plan: Session lifecycle hooks for Go and Rust

## Context

This is followups item #1 from `/tmp/hypen-followups-from-kotlin-read.md`
(deleted earlier in this session — content preserved here). Items #2 and #3
are already done (Go IEngine collapse + Kotlin handler-pair collapse).

**Status:** Kotlin and possibly Swift have these hooks. Go and Rust do not.
This is a real feature gap, not just an API divergence.

## What this is

Three lifecycle hooks the user can register on a module definition that
fire when WebSocket-connected clients disconnect, reconnect, or have their
session expire:

- `onDisconnect(state, session)` — called when the last connection for a
  session drops. Module gets to do cleanup, but state is preserved.
- `onReconnect(session, restore)` — called when a client reconnects to a
  suspended session. Receives a `restore` callback the handler can call
  with `(savedState) → ()` to push the saved state back into the live
  observable state.
- `onExpire(session)` — called after the suspended-session TTL elapses.
  Module is then destroyed.

The full reference shape lives in `hypen-kotlin/src/main/kotlin/space/hypen/core/BaseModuleInstance.kt:235-282`
and the handler-firing call sites in `hypen-kotlin/src/main/kotlin/space/hypen/core/HypenServer.kt:355-390`.

## Why this matters

For real-world apps with intermittent network conditions (mobile clients
on flaky wifi), losing module state on every brief disconnect produces a
poor UX. The user opens an app, scrolls a feed, drops a tunnel, the
client reconnects 2 seconds later and finds the entire feed reset to
empty. Bad.

Kotlin already gets this right. Swift may already have it (file scaffolding
exists — see `Sources/HypenServer/Session.swift`, `SessionManager.swift`).
Go and Rust do not.

## Architectural reference (from Kotlin)

### Three concepts

1. **`Session`** — durable identity that survives a connection drop.
   Has an `id`, `createdAt`, `lastConnectedAt`, `props`, optionally `savedState`,
   and a TTL after which it expires. A session can have zero (suspended) or
   more (active) connections attached.

2. **`SessionManager`** — owns the session lifecycle. Methods:
   - `createSession(props) → Session` — fresh session
   - `getActiveSession(id) → Session?` — lookup
   - `trackConnection(sessionId, connectionId)` — attach a connection
   - `untrackConnection(sessionId, connectionId)` — detach. May trigger suspend.
   - `getConnectionCount(sessionId) → Int`
   - `suspendSession(id, savedState, onExpire)` — start TTL countdown.
     `onExpire` is a callback fired after TTL.
   - `resumeSession(id) → Session?` — pull from suspended back to active
   - Internal: a TTL timer (Kotlin uses a coroutine; Go would use `time.AfterFunc`)

3. **`BaseModuleInstance.handle*` methods** — the hooks, fired by the server.

### Connection flow (Kotlin reference)

```
client connects (WebSocket)
  → server sends sessionAck (isNew=true) OR (isRestored=true if hello had sessionId)
  → if isRestored: call moduleInstance.handleReconnect(session, savedState)
  → server sends initialTree
client interacts (dispatchAction, navigate, etc.)
  → server fires handlers as usual
client disconnects
  → server calls sessionManager.untrackConnection(sessionId, connectionId)
  → if connectionCount == 0:
      → snapshot state from moduleInstance
      → moduleInstance.handleDisconnect(session)
      → sessionManager.suspendSession(sessionId, savedState, onExpire)
        → starts TTL timer
TTL elapses (no reconnect within window)
  → onExpire fires:
      → moduleInstance.handleExpire(session)
      → moduleInstance.destroy()
      → engine.close()
client reconnects within TTL window
  → client sends hello { sessionId: "<previous-id>" }
  → server calls sessionManager.resumeSession(sessionId)
  → if found: cancel TTL timer, mark active, isRestored=true
  → server fires the normal connect flow with isRestored=true
```

### Wire protocol additions

The `hello` message gains an optional `sessionId` field for resume:

```json
{ "type": "hello", "sessionId": "abc-123", "props": { ... } }
```

The `sessionAck` response gains two flags:

```json
{ "type": "sessionAck", "sessionId": "abc-123", "isNew": false, "isRestored": true }
```

`sessionExpired` is a new server-to-client message sent when a session is
forcibly kicked or expired (Kotlin uses `kickSession` for this — see
`HypenServer.kt:584-595`):

```json
{ "type": "sessionExpired", "sessionId": "abc-123", "reason": "kicked" }
```

## Files to touch

### Go SDK

| File | What to add |
|---|---|
| `hypen-golang/session.go` | New file. `Session`, `SessionManager`, `SessionInfo`, `SessionConfig` (TTL, etc.). Mirrors `hypen-kotlin/src/main/kotlin/space/hypen/core/Session.kt`. |
| `hypen-golang/app.go` (`ModuleDefinition.Handlers` struct) | Add `OnDisconnect`, `OnReconnect`, `OnExpire` handler fields. Add corresponding `OnDisconnect()`, `OnReconnect()`, `OnExpire()` builder methods on `ModuleBuilder`. |
| `hypen-golang/app.go` (`ModuleInstance`) | Add `HandleDisconnect`, `HandleReconnect`, `HandleExpire` methods that fire the registered handlers if present. |
| `hypen-golang/remote/server.go` | Add `*SessionManager` field on `RemoteServer`. Wire `handleHello` to consult it (resume vs new). Wire `handleClose` to call `sessionManager.UntrackConnection` and `SuspendSession` with the expire callback. Add `kickSession` for explicit termination. |
| `hypen-golang/remote/types.go` (or wherever wire types live) | Add `SessionExpiredMessage`. |

### Rust SDK

| File | What to add |
|---|---|
| `hypen-sdk-rs/src/remote/session_manager.rs` | New file. `Session`, `SessionManager`, `SessionInfo`. Use `tokio::time::sleep` (or `std::thread::spawn` if no tokio) for the TTL timer. |
| `hypen-sdk-rs/src/module.rs` (`ModuleDefinition`) | Add `on_disconnect`, `on_reconnect`, `on_expire` fields. Builder methods on `ModuleBuilder`. |
| `hypen-sdk-rs/src/module.rs` (`ModuleInstance`) | Add `handle_disconnect`, `handle_reconnect`, `handle_expire` methods. |
| `hypen-sdk-rs/src/remote/session.rs` | Add `SessionManager` to `RemoteSession` (or a parent struct). Change `handle_hello` to consult it. The framework-agnostic shape of `RemoteSession` makes this slightly awkward — see "Open question A" below. |
| `hypen-sdk-rs/src/remote/types.rs` | Add `SessionExpiredMessage` to `RemoteMessage` enum. |
| `hypen-sdk-rs/src/lib.rs` / `prelude.rs` | Export the new types. |

## Open questions to resolve before coding

### A. Where does `SessionManager` live in Rust?

Kotlin's `SessionManager` is owned by `HypenServer` (the WebSocket server),
not by a per-client `RemoteSession`. Rust's current architecture is the
opposite: there's no `HypenServer` equivalent — `RemoteSession` is
framework-agnostic and the user wires it into their own WebSocket
framework (Axum, Actix, etc.).

Two options:

**A1.** Add a new `RemoteServer` struct in `hypen-sdk-rs/src/remote/server.rs`
that owns the `SessionManager` and lifecycle, and is framework-agnostic
(takes a closure for sending messages, a closure for accepting connections).
`RemoteSession` becomes the per-connection slot; `RemoteServer` becomes the
session-lifecycle owner.

**A2.** Keep `RemoteSession` framework-agnostic but expose `SessionManager`
as a separate type the user constructs and threads through manually. The
user's WebSocket integration code is responsible for wiring `SessionManager`
to their connection lifecycle events.

**Recommendation: A1.** A2 pushes too much glue work onto the user. The
"framework-agnostic" property is preserved by making `RemoteServer` itself
agnostic — it just exposes `on_message`, `on_connect`, `on_disconnect`
hooks that the framework integration calls.

### B. TTL and timer mechanism

Kotlin uses a coroutine with `delay(ttl)` then a callback. Go would use
`time.AfterFunc(ttl, func)`. Rust:

- With `feature = "async"`: `tokio::spawn` + `tokio::time::sleep`
- Without async: `std::thread::spawn` + `std::thread::sleep` (and a stop
  channel for cancellation if reconnect happens)

Both Go and Rust need cancellation: when a client reconnects within the
TTL window, the timer must be cancelled. In Go: store the `*time.Timer`
on the session and call `.Stop()`. In Rust: store an `Arc<Notify>` (tokio)
or a stop channel.

### C. State serialization shape across the suspend boundary

Kotlin's `SessionManager.suspendSession(id, savedState, onExpire)` takes
the saved state as a `Map<String, Any?>`. Both Go and Rust use JSON-shaped
state already, so saved state is `map[string]any` / `serde_json::Value`.
No new serialization machinery needed.

### D. `ModuleInstance` state restoration semantics on reconnect

The Kotlin `handleReconnect` signature:
```kotlin
fun handleReconnect(session: SessionInfo, savedState: Map<String, Any?>) {
    if (definition.onReconnect != null) {
        var didRestore = false
        definition.onReconnect.invoke(ReconnectContext(session) { restoredState ->
            didRestore = true
            observableState.update(restoredState)
        })
        if (!didRestore) {
            observableState.update(savedState)
        }
    } else {
        observableState.update(savedState)
    }
}
```

The handler is given a `restore` callback it can call with whatever state
it wants. If the handler doesn't call `restore`, the saved state is
applied automatically. This gives the handler the option to *not* restore
(e.g., if the saved state is now stale because hours have passed).

Both Go and Rust should preserve this semantics.

### E. Default TTL?

Kotlin defaults to 60 seconds. Configurable via `SessionConfig(ttl = ...)`.
Go and Rust should match: 60s default, configurable via the
`RemoteServer` builder method.

## Step-by-step (Go first, then Rust)

### Step 1 — Go: write `session.go`

Mirror `hypen-kotlin/src/main/kotlin/space/hypen/core/Session.kt`. Key
types:

```go
// SessionInfo is the read-only snapshot passed to lifecycle handlers.
type SessionInfo struct {
    ID              string
    CreatedAt       time.Time
    LastConnectedAt time.Time
    Props           map[string]any
}

// Session is the live mutable state owned by SessionManager.
type Session struct {
    Info         SessionInfo
    Connections  map[any]bool      // connection-key set
    SavedState   map[string]any    // populated when suspended
    ExpireTimer  *time.Timer       // nil when active
    expireCallback func()
}

type SessionConfig struct {
    TTL time.Duration  // default 60s
}

type SessionManager struct {
    mu       sync.Mutex
    config   SessionConfig
    active   map[string]*Session  // active (has ≥1 connection)
    suspended map[string]*Session // 0 connections, TTL ticking
}

func (sm *SessionManager) CreateSession(props map[string]any) *SessionInfo
func (sm *SessionManager) GetActiveSession(id string) *Session
func (sm *SessionManager) TrackConnection(sessionID string, connKey any)
func (sm *SessionManager) UntrackConnection(sessionID string, connKey any)
func (sm *SessionManager) GetConnectionCount(sessionID string) int
func (sm *SessionManager) SuspendSession(sessionID string, savedState map[string]any, onExpire func())
func (sm *SessionManager) ResumeSession(sessionID string) *Session  // returns nil if expired/unknown
```

### Step 2 — Go: extend `ModuleDefinition` and the builder

Add fields to `ModuleHandlers`:

```go
type ModuleHandlers struct {
    OnCreated    LifecycleHandler
    OnAction     map[string]ActionHandler
    OnDestroyed  LifecycleHandler
    OnError      ErrorHandler
    OnDisconnect DisconnectHandler  // NEW
    OnReconnect  ReconnectHandler   // NEW
    OnExpire     ExpireHandler      // NEW
}

type DisconnectContext struct {
    State   *ObservableState
    Session SessionInfo
}
type DisconnectHandler func(ctx DisconnectContext)

type ReconnectContext struct {
    Session SessionInfo
    Restore func(map[string]any) // call with saved state to restore
}
type ReconnectHandler func(ctx ReconnectContext)

type ExpireContext struct {
    Session SessionInfo
}
type ExpireHandler func(ctx ExpireContext)
```

Builder methods on `AppBuilder` (and `app_typed.go`):

```go
func (b *AppBuilder[S]) OnDisconnect(handler DisconnectHandler) *AppBuilder[S]
func (b *AppBuilder[S]) OnReconnect(handler ReconnectHandler) *AppBuilder[S]
func (b *AppBuilder[S]) OnExpire(handler ExpireHandler) *AppBuilder[S]
```

### Step 3 — Go: add `ModuleInstance.HandleDisconnect/HandleReconnect/HandleExpire`

Mirror `BaseModuleInstance.kt:235-282`. Each method checks `isDestroyed`,
looks up the registered handler, calls it, routes errors through
`handleError` for graceful degradation.

### Step 4 — Go: wire `SessionManager` into `RemoteServer`

In `hypen-golang/remote/server.go`:

1. Add `sessionManager *core.SessionManager` field to `RemoteServer`. Initialize
   in `NewRemoteServer()` with default config.

2. In `handleConnect` (the WebSocket open handler): parse the incoming
   `hello` message. If it has `sessionId`, call
   `sessionManager.ResumeSession(sessionId)`. If it returns a session,
   restore it: cancel the TTL timer, attach this connection, fire
   `moduleInstance.HandleReconnect(session.Info, session.SavedState)`,
   send `sessionAck { isNew: false, isRestored: true }`.

3. If no `sessionId` or resume returned nil, create a new session and
   send `sessionAck { isNew: true, isRestored: false }`.

4. In `handleClose`: call `sessionManager.UntrackConnection`. If the
   session has 0 connections, snapshot state, fire `HandleDisconnect`,
   then call `SuspendSession` with an `onExpire` callback that fires
   `HandleExpire`, destroys the module, and closes the engine.

5. Add a `KickSession(id string, reason string)` method on
   `RemoteServer` that sends `sessionExpired` to all connections for
   the session and force-removes it.

### Step 5 — Go: wire-format additions

In `hypen-golang/remote/types.go` (or wherever the message types live):

```go
type SessionExpiredMessage struct {
    Type      string `json:"type"`      // "sessionExpired"
    SessionID string `json:"sessionId"`
    Reason    string `json:"reason"`    // "kicked", "expired", etc.
}
```

The `HelloMessage` should already accept an optional `sessionId` field —
verify and add if missing.

### Step 6 — Go: tests

Add to `hypen-golang/session_test.go` (new file):

- `TestSessionManager_CreateAndResume` — create, suspend, resume within TTL.
- `TestSessionManager_ExpireAfterTTL` — create, suspend, wait past TTL,
  verify `onExpire` fired and session is gone.
- `TestSessionManager_TrackUntrackConnection` — track 2 conns, untrack 1,
  verify session stays active. Untrack the second, verify session goes to
  suspended.
- `TestSessionManager_ResumeAfterReconnect` — suspend, resume, verify TTL
  timer is cancelled.

Add to `hypen-golang/remote/remote_test.go`:

- `TestRemoteServer_DisconnectFiresHandler` — open ws, dispatch action,
  close ws, verify `OnDisconnect` was called with the saved state.
- `TestRemoteServer_ReconnectRestoresState` — open ws, dispatch action,
  close ws, reopen with same `sessionId`, verify state was restored and
  `OnReconnect` was called.
- `TestRemoteServer_ExpireDestroysModule` — open ws, close ws, wait past
  TTL, verify `OnExpire` fired and module is destroyed.

### Step 7 — Rust: same shape, smaller surface

Mirror Steps 1-6 in `hypen-sdk-rs/`:

1. New file `session_manager.rs` with `Session`, `SessionManager`,
   `SessionInfo`, `SessionConfig`.
2. Add `OnDisconnect`/`OnReconnect`/`OnExpire` handler types and fields
   to `ModuleDefinition` in `module.rs`.
3. Add `handle_disconnect`/`handle_reconnect`/`handle_expire` methods on
   `ModuleInstance`.
4. **Resolve open question A first.** If A1: create
   `hypen-sdk-rs/src/remote/server.rs` with a framework-agnostic
   `RemoteServer` that owns the `SessionManager`. If A2: expose
   `SessionManager` as standalone and document the wiring pattern.
5. Wire-format additions to `RemoteMessage` enum.
6. Tests in `hypen-sdk-rs/tests/integration.rs` mirroring the Go tests.

### Step 8 — Rust: TTL timer

Use `tokio::spawn` + `tokio::time::sleep` if `feature = "async"` is
enabled (which it usually is for `RemoteSession`). For the no-async path,
use a `std::thread::spawn` + `std::sync::mpsc::Receiver::recv_timeout`
pattern so the timer can be cancelled by sending on a channel.

### Step 9 — Run cross-SDK compatibility tests

```bash
cd engine-compatibility-tests/runners/golang && go test ./...
cd ../typescript && bun test
```

The cross-SDK tests don't currently cover session lifecycle (the wire
protocol additions are net-new). Consider adding a fixture for this in
`engine-compatibility-tests/fixtures/lifecycle/` so future SDKs are
tested for the same behavior.

## What "done" looks like

- Both Go and Rust have `SessionManager`, `Session`, `SessionInfo` types
- Both expose `OnDisconnect`/`OnReconnect`/`OnExpire` builder methods
- Both `ModuleInstance` types have the corresponding `handle*` methods
- `RemoteServer` (Go) and the new `RemoteServer` (Rust, per A1) own a
  `SessionManager` and call the hooks at the right phases
- `sessionAck` response includes `isNew`/`isRestored` flags
- `hello` request accepts an optional `sessionId` for resume
- `sessionExpired` message exists and is sent on kick/expire
- New tests pass: at least 4 unit tests on `SessionManager` and 3
  integration tests on `RemoteServer` per SDK
- Cross-SDK runner still passes (no regressions)
- Default TTL is 60s, configurable via builder

## What NOT to do

- **Do not** start by writing the Rust code first. Go has the simpler
  concurrency model and will surface design issues faster. Get Go
  working end-to-end with tests, then mirror in Rust.
- **Do not** try to share `SessionManager` between Go and Rust by adding
  it to the engine. Each SDK owns its own session management; the engine
  knows nothing about sessions.
- **Do not** make session restoration automatic. The `onReconnect`
  handler must be given the option to NOT restore, in case the saved
  state is stale (hours-old reconnects).
- **Do not** hold the `SessionManager` mutex while invoking user
  handlers — fetch + release the lock, then call the handler.
- **Do not** persist sessions across server restarts in v1. That's a
  separate feature (see "Future work" below).

## Future work (out of scope for this plan)

- **Persistence across server restarts.** Save suspended sessions to
  disk/Redis/Postgres so a server restart doesn't drop everyone's state.
  Significant API design work — needs its own plan.
- **Cross-server session sync.** For horizontally scaled deployments
  where the reconnect might land on a different server instance.
- **Per-module TTL.** Currently TTL is server-wide. Some modules may
  want a longer TTL than others.
- **Quota / DoS protection.** Cap the number of suspended sessions per
  client IP / origin.

## Reporting back

When done, report:

1. Number of files added (per SDK) and number of files modified
2. LOC delta (net + and -)
3. Test counts before and after for each SDK
4. Whether the cross-SDK runner passed
5. Any deviations from this plan and why
6. Whether question A was resolved as A1 or A2 for Rust

Keep the report under 300 words.
