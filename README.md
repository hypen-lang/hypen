<p align="center">
  <a href="https://hypen.space">
    <img alt="Hypen" src="./.github/hypen-logo.svg" height="80">
  </a>
</p>

<p align="center">
  <a href="https://docs.hypen.space/docs">
    <img alt="Docs" src="https://img.shields.io/badge/docs-hypen.space-FFA7E1?style=flat-square&labelColor=161616" />
  </a>
  <a href="https://github.com/hypen-lang/hypen/blob/main/LICENSE">
    <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-FFECA7?style=flat-square&labelColor=161616" />
  </a>
</p>

<p align="center">
  An open-source cross-platform language and engine for building universal software that runs natively on all platforms via UI streaming. Fastest dev experience ever with out of the box reactivity, routing, hot reload, preview studio, Tailwind shorthands and all kinds of niceties.
</p>

## Why Hypen?
- **Native UI Streaming and portable (coming soon)** - Hypen supports native UI streaming from different languages - Rust, TS, Go, Kotlin, Swift and more coming soon
- **Crossplatform native rendering** - Render hypen in web, canvas, iOS or Android, all native.
- **Declarative and familiar** — Hypen is a declarative language that will be familiar to both developers and machines.
- **Highly portable** — Hypen clients are thin layers over native UI, enabling you to automatically support any platform that Hypen supports.
- **Reactivity, Tailwind, routing, hot reload** — All of your favorite features, out of the box. Develop faster than ever with Hypen.
- **Modular and expressive** — Use Hypen to build live components, screens, apps or mini-apps, and stream them anywhere with 1 line of code.
- **Developer and LLM friendly** — Hypen was designed to be easy to learn and use for both humans and machines, allowing your LLM to easily learn to build and use Hypen apps.


## Documentation

Learn more about using Hypen here:

[ [Docs](https://docs.hypen.space/docs) ] [ [TS Server SDK](https://docs.hypen.space/docs/servers/typescript) ] [ [Go Server SDK](https://docs.hypen.space/docs/servers/golang) ] [ [Swift Server SDK](https://docs.hypen.space/docs/servers/swift) ] [ [Kotlin Server SDK](https://docs.hypen.space/docs/servers/kotlin) ] [ [Rust Server SDK](https://docs.hypen.space/docs/servers/rust) ] [ [Language references](https://docs.hypen.space/docs/hypen/basics) ]

> **Warning:** After the 1.0 version stabilizes, all server and renderer SDKs will move into their own repositories.

## Quick Start

```bash
# Install the CLI
bun add -g @hypen-space/cli

# Create a new project
hypen init my-app
cd my-app

# Start developing
hypen dev

# open studio for preview
hypen studio
```

This gives you a running app at `http://localhost:3000` with hot reload.

## What It Looks Like

Define modules on a `HypenApp` registry, then serve the whole app from the root module.
Define your state, actions to change it and write your normal backend code, Hypen does the rest.
View your app in any Hypen client, the Hypen gallery app, preview it in Hypen studio or create your own client - the choice is yours.


<details open>
<summary><b>TypeScript</b> — <code>@hypen-space/core</code> + <code>@hypen-space/server</code></summary>

```typescript
import { HypenApp } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server/remote";

const myApp = new HypenApp();

myApp.module("Counter")
  .defineState<{ count: number }>({ count: 0 })
  .onAction("increment", ({ state }) => { state.count += 1; })
  .onAction<{ amount: number }>("add", ({ action, state }) => {
    state.count += action.payload.amount;
  })
  .ui(`
    Column {
      Text("Count: @{state.count}")
      Button("@actions.increment") { Text("+") }
    }
  `)
  .build();

new RemoteServer().app(myApp).listen(3000);
```

And create a simple DOM client that will connect to the server:

```html
<div id="app"></div>

<script type="module">
  import { RemoteEngine } from "@hypen-space/core";
  import { DOMRenderer } from "@hypen-space/web";

  const app = document.getElementById("app");
  const renderer = new DOMRenderer(app);

  const remote = new RemoteEngine("ws://localhost:3000");

  remote.onPatches((patches) => {
    renderer.applyPatches(patches);
  });

  await remote.connect();
</script>

```
Or attach it to a web canvas:

```html
<canvas id="app" width="800" height="600"></canvas>
<script>
import { RemoteEngine } from "@hypen-space/core";
import { CanvasRenderer } from "@hypen-space/web/canvas";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

const engine = new RemoteEngine("ws://localhost:3000");

engine.onPatches((patches) => renderer.applyPatches(patches));
await engine.connect();
</script>

```
</details>

<details>
<summary><b>Go</b> — <code>github.com/hypen-space/core</code></summary>

Go auto-registers every named module onto the package-level `core.App` singleton at `.Build()` time. Serve the primary with `RemoteServer.WithDefinition(...)`; nested modules are discovered from the registry.

```go
counter := core.NewApp(CounterState{Count: 0}).
    Name("Counter").
    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count++
    }).
    OnAction("decrement", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count--
    }).
    UI(`
        Column {
            Text("@{state.count}").fontSize(48)
            Row {
                Button("@actions.decrement") { Text("-") }
                Button("@actions.increment") { Text("+") }
            }
        }
    `).
    Build() // auto-registers "Counter" on core.App

remote.NewRemoteServer().WithDefinition(counter).Listen(3000)
```

</details>

<details>
<summary><b>Rust</b> — crate <code>hypen-server</code></summary>

Rust uses `HypenApp::builder()` with route-based module registration.

```rust
use hypen_server::prelude::*;

let app = HypenApp::builder()
    .route("/", HypenApp::module::<Counter>("Counter")
        .state(Counter { count: 0 })
        .on_action::<()>("increment", |state, _, _| { state.count += 1; })
        .on_action::<AddPayload>("add", |state, payload, _| {
            state.count += payload.amount;
        })
        .ui(r#"
            Column {
                Text("Count: @{state.count}")
                Button("@actions.increment") { Text("+") }
            }
        "#)
        .build())
    .build();

// Plug `app` into your Axum/Actix/etc. server via the framework integration.
```

</details>

<details>
<summary><b>Swift</b> — <code>HypenServer</code></summary>

```swift
struct CounterState: Codable { var count: Int = 0 }
struct AddPayload: Codable { let amount: Int }

let myApp = HypenApp()

let _ = hypen(CounterState())
    .name("Counter")
    .app(myApp)
    .onAction("increment") { state in state.count += 1 }
    .onAction("add", payload: AddPayload.self) { state, payload in
        state.count += payload.amount
    }
    .ui("""
        Column {
            Text("Count: @{state.count}")
            Button("@actions.increment") { Text("+") }
        }
    """)
    .build()

let server = RemoteServer().app(myApp)
try server.listen(3000)
```

</details>

<details>
<summary><b>Kotlin</b> — <code>space.hypen:hypen-kotlin</code></summary>

Kotlin uses a `HypenServer { ... }` DSL to register modules. Modules built with `name(...)` also auto-register on the global `HypenApp` singleton.

```kotlin
@Serializable
data class CounterState(var count: Int = 0)

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
}

val counterDef = hypen(CounterState()) {
    name("Counter")
    onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
    onAction<CounterAction.Decrement> { _, state, _ -> state.count -= 1 }
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

val server = HypenServer {
    module("Counter", counterDef)
}
// server.install(ktorApplication)
```

</details>

> **Just one module for a demo?** Every SDK also accepts a single-module shortcut (TS: `new RemoteServer().module(name, def).ui(template)`, Swift: `RemoteServer(moduleDefinition:)`, etc.). Prefer the `HypenApp` registry once you have more than one module or want routing/nesting.

## How It Works

```
Hypen DSL → Parser (AST) → Engine (IR) → Reconciler → Patches → Native Renderer
                                ↑
                          State / Actions
```

1. You write UI in Hypen's declarative DSL.
2. The **parser** (Rust) turns it into an AST.
3. The **engine** (Rust, compiled to WASM) expands the AST into an intermediate representation, tracks reactive dependencies, and diffs against the previous tree.
4. Minimal **patches** are sent to the platform renderer — DOM, SwiftUI, Compose, or Canvas.

The engine is renderer-agnostic. All platforms receive the same patch format.

## Repository Structure

| Directory | What it does | Language |
|-----------|-------------|----------|
| `parser/` | Hypen DSL parser (Chumsky combinators) | Rust |
| `hypen-sdk-rs/` | Rust server SDK (crate: `hypen-server`) | Rust |
| `hypen-engine-rs/` | Core reactive engine, reconciler, WASM build | Rust |
| `hypen-web/` | Web SDK — @hypen-space/core (runtime), @hypen-space/web (DOM & Canvas), @hypen-space/web-engine (browser WASM), @hypen-space/server (Node.js WASM) | TypeScript |
| `hypen-cli/` | CLI tools (`init`, `dev`, `build`, `studio`) | TypeScript |
| `hypen-renderer-swift/` | iOS/macOS native renderer | Swift |
| `hypen-renderer-android/` | Android native renderer | Kotlin |
| `hypen-server-swift/` | Swift server SDK (`HypenServer`) | Swift |
| `hypen-kotlin/` | Kotlin/JVM SDK with Kotlin DSL | Kotlin |
| `hypen-golang/` | Go SDK (module system) | Go |
| `hypen-lsp/` | Language Server Protocol implementation | TypeScript |
| `tailwind-parse/` | Tailwind CSS class parser | Rust |
| `hypen-landing/` | Landing page | TypeScript |
| `hypen-docs/` | Documentation site (Fumadocs) | Markdown |
| `engine-compatibility-tests/` | Cross-SDK compatibility test suite | Multi |
| `examples/` | Example apps | Multi |
| `component-gallery-server/` | Server for x-platform screenshot tests | TypeScript |

## Platform SDKs

Hypen has SDKs for multiple platforms, all driven by the same engine:

### UI Renderers

- **iOS/macOS** (`hypen-renderer-swift`) — SwiftUI native renderer
- **Android** (`hypen-renderer-android`) — Jetpack Compose native renderer
- **Web** (`@hypen-space/web`) — DOM and Canvas renderers for the browser

### Server SDKs

All server SDKs share the same module system (typed state, typed actions, lifecycle hooks, nested modules, session persistence) and speak the same WebSocket patch protocol.

- **Node.js / Bun** (`@hypen-space/server` + `@hypen-space/core`) — [README](hypen-web/packages/server/README.md)
- **Go** (`github.com/hypen-space/core`) — [README](hypen-golang/README.md)
- **Rust** (crate: `hypen-server`) — [README](hypen-sdk-rs/README.md)
- **Swift** (`HypenServer`) — [README](hypen-server-swift/README.md)
- **Kotlin / JVM** (`space.hypen:hypen-kotlin`) — [README](hypen-kotlin/README.md)

### Browser client

- **Web client** (`@hypen-space/web-engine`) — Browser WASM engine, Hypen orchestrator

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development workflows and guidelines.

## Documentation

- [SPEC.md](SPEC.md) — RFC-0001: Stateful module system specification
- [Parser README](parser/README.md) — Parser architecture and usage
- [Engine README](hypen-engine-rs/README.md) — Engine architecture and API
- [CLI README](hypen-cli/README.md) — CLI commands and project structure
- [Core SDK README](hypen-web/packages/core/README.md) — TypeScript SDK documentation
- [Node Server SDK README](hypen-web/packages/server/README.md)
- [Go Server SDK README](hypen-golang/README.md)
- [Rust Server SDK README](hypen-sdk-rs/README.md)
- [Swift Server SDK README](hypen-server-swift/README.md)
- [Kotlin Server SDK README](hypen-kotlin/README.md)

## License

MIT
