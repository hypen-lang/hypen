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
- **Crossplatform native rendering** - Render Hypen on the web (DOM or canvas), Android, desktop and iOS, all native. (iOS is in preview: it runs through the `hypen run ios` Simulator runner, and the Swift renderer package isn't published yet.)
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

The CLI runs on [Bun](https://bun.sh) 1.2 or newer (Node.js alone can't run it).

```bash
# Create a new project (no global install needed)
bunx @hypen-space/cli init my-app
cd my-app

# Start developing: web preview with hot reload at http://localhost:3000
bun run dev
```

Prefer an IDE? Run `bun run studio` instead of `bun run dev`. Hypen Studio starts the dev server for you and opens an editor with a live preview, state inspector and time-travel debugging at `http://localhost:5173`. You don't need both.

To preview on a device, run `bunx hypen run android` or `bunx hypen run ios` (Simulator) while the project is open. You can also install the CLI globally with `bun add -g @hypen-space/cli`; from the next CLI release on, a global `hypen` hands project commands to the project's own CLI, so `hypen dev` and `bun run dev` behave the same.

See the [Getting Started guide](https://docs.hypen.space/docs/getting-started/installation) for the full walkthrough.

## What It Looks Like

Define modules on a `HypenApp` registry, then serve the whole app from the root module.
Define your state, actions to change it and write your normal backend code, Hypen does the rest.
View your app in any Hypen client, the Hypen gallery app, preview it in Hypen studio or create your own client - the choice is yours.


<details open>
<summary><b>TypeScript</b> — <code>@hypen-space/core</code> + <code>@hypen-space/server</code></summary>

```typescript
// server.ts — run with `bun server.ts`
import { HypenApp } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server/remote";

const myApp = new HypenApp();

myApp.module("Counter")
  .defineState<{ count: number }>({ count: 0 })
  .onAction("increment", ({ state }) => { state.count += 1; })
  .onAction<{ amount: number }>("add", ({ action, state }) => {
    state.count += action.payload?.amount ?? 0;
  })
  .ui(`
    Column {
      Text("Count: @{state.count}")
      Button { Text("+") }.onClick(@actions.increment)
      Button { Text("+5") }.onClick(@actions.add, amount: 5)
    }
  `);

new RemoteServer().app(myApp).listen(3000);
```

Open `http://localhost:3000`: the server ships a built-in web client. Native clients connect to `ws://localhost:3000`.

> `new RemoteServer().app(myApp)` (no `.module()` call) and named modules as the entry need a `@hypen-space/server` release newer than 0.6.6. On 0.6.6, define the module with `app.defineState(...)` and serve it with `new RemoteServer().module("Counter", def).ui(template).listen(3000)`.

To render in your own page instead, write a small client and let Bun bundle it (browsers can't load bare package imports or TypeScript directly):

```typescript
// client.ts
import { RemoteEngine } from "@hypen-space/core";
import { DOMRenderer } from "@hypen-space/web";

const container = document.getElementById("app")!;
const engine = new RemoteEngine("ws://localhost:3000");

// Pass the engine so the renderer can send clicks back to the server.
const renderer = new DOMRenderer(container, engine);

// Each (re)connection streams a complete tree, so start from a clean slate.
engine.onSessionEstablished(() => renderer.clear());
engine.onPatches((patches) => renderer.applyPatches(patches));

await engine.connect();
```

```html
<!-- index.html -->
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Same base styles as the built-in client -->
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: system-ui, -apple-system, sans-serif; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./client.ts"></script>
  </body>
</html>
```

```bash
bun add @hypen-space/web
bun --port=8080 ./index.html   # then open http://localhost:8080
```

`client.ts` uses `document`, so type-checking it needs the browser libs. The `tsconfig.json` that `bun init` writes has `"lib": ["ESNext"]`, which gives `TS2584: Cannot find name 'document'` in the editor or `bunx tsc`; change it to:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  }
}
```

(only the `lib` line changes; keep the other options). Bun runs and bundles the page either way.

Or render to a web canvas, with the same setup:

```typescript
// canvas.ts — load it from <canvas id="app" width="800" height="600"></canvas>
//             plus <script type="module" src="./canvas.ts"></script>
import { RemoteEngine } from "@hypen-space/core";
import { CanvasRenderer } from "@hypen-space/web/canvas";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const engine = new RemoteEngine("ws://localhost:3000");
const renderer = new CanvasRenderer(canvas, engine);

engine.onSessionEstablished(() => renderer.clear());
engine.onPatches((patches) => renderer.applyPatches(patches));

await engine.connect();
```

The canvas renderer fetches its layout engine from `/taffy_wasm_bg.wasm` on the page's origin. `bun ./canvas.html` answers that path with HTML, so the browser warns that `WebAssembly.instantiateStreaming` got the wrong MIME type and the renderer falls back to a CDN copy. To serve it locally, run the page from `Bun.serve` with a route for the file: `"/taffy_wasm_bg.wasm": Bun.file("node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm")` next to `"/": page` (where `import page from "./canvas.html"`). The [remote app guide](https://docs.hypen.space/docs/getting-started/remote-app) has the full script.

</details>

<details>
<summary><b>Go</b> — <code>github.com/hypen-space/core</code></summary>

Go auto-registers every named module onto the package-level `core.App` singleton. Serve the entry module with `RemoteServer.WithDefinition(...)`; nested modules are discovered from the registry. Requires Go 1.25+ (on older toolchains, `GOTOOLCHAIN=go1.25.0`).

```go
// main.go — run with `go run .`
package main

import (
	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/remote"
)

type CounterState struct {
	Count int `json:"count"`
}

func main() {
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
                    Button { Text("-") }.onClick(@actions.decrement)
                    Button { Text("+") }.onClick(@actions.increment)
                }
            }
        `)

	// Blocks until stopped. Open http://localhost:3000 for the built-in web client.
	remote.NewRemoteServer().WithDefinition(counter).Listen(3000)
}
```

> **Not on a Go module proxy yet:** `go get github.com/hypen-space/core` doesn't resolve today, and the snippet above needs the unreleased SDK in `hypen-golang/`. Point the import path at a checkout of this repository:
>
> ```bash
> go mod edit -require=github.com/hypen-space/core@v0.0.0 \
>             -replace=github.com/hypen-space/core=/path/to/hypen/hypen-golang
> go mod tidy
> ```

</details>

<details>
<summary><b>Rust</b> — crate <code>hypen-server</code></summary>

Rust uses `HypenApp::builder()` with route-based module registration. Add `hypen-server = "0.6"` and `serde = { version = "1", features = ["derive"] }` to `Cargo.toml`.

```rust
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Counter {
    count: i32,
}

#[derive(Deserialize)]
struct AddPayload {
    amount: i32,
}

fn main() {
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
                    Button { Text("+") }.onClick(@actions.increment)
                }
            "#)
            .build())
        .build();

    // `app` holds the routes and modules. Serve it from your HTTP framework's
    // WebSocket route (see the hypen-server README, "Framework Integration").
    let _ = app;
}
```

The crate is transport-agnostic: it doesn't open a socket itself. You plug its `RemoteSession` into your own WebSocket server (Axum, Actix, ...). See [Framework Integration](hypen-sdk-rs/README.md#framework-integration), and `examples/social/rust` for a complete Axum server.

</details>

<details>
<summary><b>Swift</b> — <code>HypenServer</code></summary>

> The Swift server SDK isn't published as a Swift package yet. Use the `hypen-server-swift/` directory of this repository as a local package (`.package(path: "../hypen/hypen-server-swift")`).

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

The SDK is on Maven Central as `space.hypen:hypen-kotlin` (`implementation("space.hypen:hypen-kotlin:0.4.952")`). 0.4.952 is the newest published version and predates the code in this repository (0.6.x), so some recent features are missing from it.

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

> **Just one module for a demo?** Every SDK also accepts a single-module shortcut (TS: `new RemoteServer().module(name, def)`, where `def` comes from `app.defineState(...).ui(template)`; Swift: `RemoteServer(moduleDefinition:)`, etc.). Prefer the `HypenApp` registry once you have more than one module or want routing/nesting.

## How It Works

```
Hypen DSL → Parser (AST) → Engine (IR) → Reconciler → Patches → Native Renderer
                                ↑
                          State / Actions
```

1. You write UI in Hypen's declarative DSL.
2. The **parser** (Rust) turns it into an AST.
3. The **engine** (Rust, compiled to WASM) expands the AST into an intermediate representation, tracks reactive dependencies, and diffs against the previous tree.
4. Minimal **patches** are sent to the platform renderer — DOM, Canvas, Compose, SwiftUI or the native desktop renderer.

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
| `hypen-renderer-desktop/` | Native desktop renderer | Rust |
| `hypen-browser/` | Hypen Browser: native desktop shell and `hypen run desktop` runner | Rust |
| `hypen-ios-streamer/` | Stream and control iOS Simulators over HTTP (macOS) | TypeScript |
| `hypen-server-swift/` | Swift server SDK (`HypenServer`) | Swift |
| `hypen-kotlin/` | Kotlin/JVM SDK with Kotlin DSL | Kotlin |
| `hypen-golang/` | Go SDK (module system) | Go |
| `hypen-lsp/` | Language Server Protocol implementation | TypeScript |
| `tailwind-parse/` | Tailwind CSS class parser | Rust |
| `hypen-docs/` | Documentation site (Fumadocs) | Markdown |
| `engine-compatibility-tests/` | Cross-SDK compatibility test suite | Multi |
| `examples/` | Example apps | Multi |
| `component-gallery-server/` | Server for x-platform screenshot tests | TypeScript |

## Platform SDKs

Hypen has SDKs for multiple platforms, all driven by the same engine:

### UI Renderers

- **iOS/macOS** (`hypen-renderer-swift`) — SwiftUI native renderer (preview; not yet published as a Swift package)
- **Android** (`hypen-renderer-android`) — Jetpack Compose native renderer (`space.hypen:hypen-renderer` on Maven Central)
- **Desktop** (`hypen-renderer-desktop`, `hypen-browser`) — native desktop renderer and shell (no prebuilt binaries yet; build with `cargo build --release -p hypen-browser`)
- **Web** (`@hypen-space/web`) — DOM and Canvas renderers for the browser

### Server SDKs

All server SDKs share the same module system (typed state, typed actions, lifecycle hooks, nested modules, session persistence) and speak the same WebSocket patch protocol.

- **Node.js / Bun** (`@hypen-space/server` + `@hypen-space/core`) — [README](hypen-web/packages/server/README.md)
- **Go** (`github.com/hypen-space/core`, not fetchable with `go get` yet) — [README](hypen-golang/README.md)
- **Rust** (crate: `hypen-server`) — [README](hypen-sdk-rs/README.md)
- **Swift** (`HypenServer`, use as a local package for now) — [README](hypen-server-swift/README.md)
- **Kotlin / JVM** (`space.hypen:hypen-kotlin`, latest published 0.4.952) — [README](hypen-kotlin/README.md)

### Browser client

- **Web client** (`@hypen-space/web-engine`) — Browser WASM engine. For shipping a browser app, use `hypen build`, which bundles the engine and your modules into a static site.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development workflows and guidelines. To rebuild the engine WASM, run `bun run build:wasm` from the repository root. It needs `wasm-pack` and the `wasm32-wasip1` target, and exits with install instructions if they are missing (pass `--install-tools` to `hypen-engine-rs/build-wasm.sh` to install them automatically).

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
