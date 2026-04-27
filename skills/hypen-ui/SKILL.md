---
name: hypen-ui
description: Build cross-platform UI with the Hypen declarative language. Covers all components, applicators, modules, state, typed actions, control flow, and styling across TypeScript, Kotlin, Go, Swift, and Rust SDKs.
---

# Building UI with Hypen

You are an expert in writing Hypen DSL templates and module logic. Hypen is a declarative UI language where templates (`.hypen` files) define structure and styling, while modules manage state and business logic. Modules can be written in **TypeScript**, **Kotlin**, **Go**, **Swift**, or **Rust**. The engine produces platform-agnostic patches that renderers (DOM, Canvas, iOS, Android) apply.

## File Structure

Hypen projects organize components as `.hypen` template files paired with a module file in the host language, OR as a single host-language file using the inline `.ui(\`...\`)` form (see "Inline UI" below). Templates in paired form are always `.hypen`; the module file extension depends on the SDK:

| SDK | Module file | Example |
|-----|------------|---------|
| TypeScript | `.ts` | `component.ts` |
| Kotlin | `.kt` | `component.kt` |
| Go | `.go` | `component.go` |
| Swift | `.swift` | `component.swift` |
| Rust | `.rs` | `component.rs` |

Components are discovered via three naming patterns (all SDKs):

```
# Folder-based (recommended)
src/components/
  Counter/
    component.hypen    # UI template
    component.ts       # Module (or .kt, .go, .swift)

# Index-based
  Counter/
    index.hypen
    index.ts

# Sibling-based
  Counter.hypen
  Counter.ts
```

Templates without a paired module file are treated as **stateless components** — they render UI but have no state or action handlers.

## Hypen DSL Syntax

### Components

Components are the building blocks. They accept arguments (positional or named), can have children in `{}`, and are styled with applicators (`.method()`).

```hypen
// Positional argument
Text("Hello World")

// Named arguments
Text(text: "Hello", color: red)

// Children
Column {
  Text("First")
  Text("Second")
}

// Applicators (styling)
Text("Styled")
  .fontSize(18)
  .color("#333")
  .padding(16)

// Module declaration (stateful component)
module App {
  Column {
    Text("Count: @{state.count}")
    Button { Text("+") }
      .onClick(@actions.increment)
  }
}

// Custom component declaration
component MyCard(title, subtitle) {
  Column {
    Text("@{title}")
      .fontSize(20)
      .fontWeight("bold")
    Text("@{subtitle}")
      .fontSize(14)
      .color("#666")
  }
  .padding(16)
  .borderRadius(12)
  .backgroundColor("white")
}
```

### Value Types

```hypen
// Strings (double or single quotes, escapes supported)
Text("Hello \"world\"")
Text('Embed "quotes" freely')

// Numbers
.fontSize(18)
.opacity(0.5)

// Booleans
.disabled(true)
.fillMaxWidth(false)

// References
@state.username        // State binding
@actions.login         // Action dispatch
@item                  // Current ForEach item

// Lists
Component(tags: ["primary", "featured"])

// Maps
Component(config: {width: 100, height: 200})
.backgroundColor({default: "#3B82F6", hover: "#2563EB"})  // Responsive/state variants

// Expression bindings
"@{state.count}"                                    // Simple interpolation
"@{state.active ? 'green' : 'gray'}"              // Ternary
"@{item.role == 'user' ? '#FFFFFF' : '#111827'}"   // Equality check
"Count: @{state.count}"                            // Mixed text + binding
```

### Comments

```hypen
// Single-line comment
/* Block comment */
```

### Imports

```hypen
import { Button, Card } from "./components/ui"
import HomePage from "./pages/HomePage"
```

## Built-in Components

### Layout Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Column` | Vertical flex container | gap, align | Yes |
| `Row` | Horizontal flex container | gap, align | Yes |
| `Box` / `Container` | Generic container with z-stacking | - | Yes |
| `Center` | Centers children both axes | - | Yes |
| `Stack` | Z-axis stacking for overlapping | - | Yes |
| `Grid` | CSS Grid layout | columns | Yes |
| `List` | Scrollable container | items (binding) | Yes |
| `Spacer` | Flexible empty space | width, height | No |
| `Divider` | Visual separator line | - | No |

### Content Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Text` | Display text | text/"0" (positional) | No |
| `Heading` | Heading text | text/"0" | No |
| `Paragraph` | Paragraph text | text/"0" | No |
| `Image` | Display image | src, alt | No |
| `Icon` | SVG icon (engine-resolved) | name/"0", size | No |

### Interactive Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Button` | Clickable button | onClick | Yes (label content) |
| `Input` | Single-line text input | placeholder, type, value | No |
| `Textarea` | Multi-line text input | placeholder, value | No |
| `Checkbox` | Toggle checkbox | checked | No |
| `Switch` | Toggle switch | on | No |
| `Select` | Dropdown selector | value, options | No |
| `Slider` | Range slider | min, max, value | No |
| `Link` | Navigation link | href | Yes |

### Display Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Card` | Elevated container | - | Yes |
| `Badge` | Small label indicator | text, color | No |
| `Avatar` | User avatar | src, size | No |
| `Spinner` | Loading indicator | - | No |
| `ProgressBar` | Progress indicator | value | No |

### Media Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Video` | Video player | src | No |
| `Audio` | Audio player | src | No |

### Navigation Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| `Router` | Routing container (reactive path) | — (routes via `Route` children) | Yes (Route children) |
| `Route` | Route definition | path (positional) | Yes |
| `HypenApp` | Embed remote Hypen app | url | No |

> **Router semantics:** `Router` is engine-native with per-route subtree caching (`Attach`/`Detach` patches reuse previously-visited subtrees). There is **no `initialRoute` prop** in the DSL — initial route, path persistence, and module lifecycle are governed by the SDK-side `ManagedRouter` (in `@hypen-space/core` and equivalents). See the Module System section.

> **List shorthand:** `List(@state.items) { ... }` auto-expands to `ForEach(items: @state.items, key: "id")`. The positional argument is the binding source — there is no separate `items` prop shorthand.

> **Grid:** `Grid { ... }` is a layout container. Apply `.gridColumns(3)` (shorthand for `repeat(3, 1fr)`) or `.gridTemplateColumns("1fr 2fr 1fr")`. Any prop passed is applied as CSS.

## Control Flow

### ForEach - Iterate Over Lists

```hypen
// Basic list rendering
ForEach(items: @state.todos, key: "id") {
  Row {
    Text("@{item.text}")
    Text("@{item.done ? 'Done' : 'Pending'}")
  }
}

// With custom item name
ForEach(items: @state.messages, key: "id", as: "msg") {
  Text("@{msg.content}")
}

// Shorthand with List component
List(@state.tasks) {
  Text("@{item.name}")
}
```

**Important:** Always provide `key` for dynamic lists (a unique identifier field). `@item` references the current iteration element. Inside ForEach, use `@{item.fieldName}` to access item properties.

**Known iteration limits (current engine):**

- **`List(@state.x) { ... }` shorthand only accepts module-state bindings.** Writing `List(@item.entries)` — an item-scoped source inside an outer iteration — does not resolve. Use an explicit `ForEach(items: @item.entries, key: "id")` if you need that shape.
- **Nested `ForEach` against an outer iteration's item** (e.g. an inner `ForEach(items: @item.entries, ...)`) **parses but does not resolve at runtime** — the inner scope doesn't reliably see the outer item. Workaround: pre-flatten into per-group top-level state arrays (`state.breakfastEntries`, `state.lunchEntries`, …) and emit one outer ForEach per group.
- **`as: "alias"` is parsed but the runtime iteration variable stays as `item`.** Templates that write `@{alias.x}` bindings render as literal text. Stick with the default `item` name. The property is documented as planned; don't rely on it until the engine wires alias resolution through.

### If - Boolean Conditionals

```hypen
If(condition: @state.isLoggedIn) {
  Text("Welcome back!")
  Else {
    Text("Please log in")
  }
}

// Without else
If(condition: @state.isLoading) {
  Spinner()
}
```

### When/Case - Pattern Matching

```hypen
When(value: @state.status) {
  Case(match: "loading") {
    Center { Spinner() }
  }
  Case(match: "error") {
    Text("Something went wrong")
      .color("#EF4444")
  }
  Case(match: "success") {
    ContentView()
  }
  Else {
    Text("Unknown state")
  }
}

// Expression matching
When(value: @state.score) {
  Case(match: "@{value >= 90}") { Text("A") }
  Case(match: "@{value >= 80}") { Text("B") }
  Else { Text("C") }
}

// Wildcard
Case(match: "_") { Text("Default") }
```

## Applicators Reference

Applicators are chained with dot notation after components. Any unrecognized applicator name is applied as a CSS property (camelCase auto-converts to kebab-case). Numeric values get `px` units automatically (except unitless properties like opacity, z-index, flex, font-weight, line-height).

### Spacing

```hypen
.padding(16)                               // All sides
.padding(horizontal: 16, vertical: 12)     // Axis-based
.paddingTop(8)
.paddingBottom(8)
.paddingLeft(16)
.paddingRight(16)
.paddingHorizontal(16)
.paddingVertical(12)
.margin(16)
.marginTop(8)
.marginBottom(8)
.marginLeft(16)
.marginRight(16)
.marginHorizontal(16)
.marginVertical(12)
.gap(12)                                   // Child spacing in flex containers
.rowGap(8)
.columnGap(8)
```

### Size

```hypen
.width(200)               // Fixed px
.width("50%")             // Percentage
.width("100vw")           // Viewport
.height(100)
.minWidth(200)
.maxWidth(600)
.minHeight(100)
.maxHeight("50vh")
.fillMaxWidth(true)       // width: 100%
.fillMaxHeight(true)      // height: 100%
.aspectRatio(1.5)
```

### Typography

```hypen
.fontSize(18)
.fontWeight("bold")        // or numeric: 100-900
.fontWeight(700)
.fontFamily("Inter, sans-serif")
.fontStyle("italic")
.textAlign("center")       // left, center, right, justify
.lineHeight(1.5)
.letterSpacing(0.5)
.textDecoration("underline")   // underline, line-through, none
.textTransform("uppercase")    // uppercase, lowercase, capitalize
.maxLines(2)
.textOverflow("ellipsis")
```

### Colors

```hypen
.color("#333")                   // Text color
.color("rgb(100, 150, 200)")
.backgroundColor("#F3F4F6")
.backgroundColor("rgba(0,0,0,0.5)")
.opacity(0.8)
```

### Borders

```hypen
.border("1px solid #E5E7EB")    // CSS shorthand
.borderWidth(1)
.borderColor("#D1D5DB")
.borderStyle("dashed")          // solid, dashed, dotted
.borderRadius(8)
.borderRadius("8px 8px 0 0")   // Per-corner
.borderTop(1)
.borderBottom(1)
.cornerRadius(12)               // Alias for borderRadius
```

### Layout

```hypen
.horizontalAlignment("center")    // start, center, end, space-between, space-around
.verticalAlignment("center")
.alignSelf("center")
.weight(1)                        // Flex grow factor
.flex(1)
.flexGrow(1)
.flexShrink(0)
.flexDirection("row")             // row, column
.display("flex")
.position("absolute")
.top(0)
.left(0)
.right(0)
.bottom(0)
.zIndex(10)
.overflow("hidden")
```

### Grid

```hypen
.gridColumns(3)
.gridTemplateColumns("1fr 2fr 1fr")
.gridColumn("span 2")
```

### Effects

```hypen
.boxShadow("0 4px 12px rgba(0, 0, 0, 0.1)")
.shadow(blur: 10, spread: 2, color: "rgba(0,0,0,0.15)")
.blur(4)
.filter("brightness(1.2)")
.backdropFilter("blur(10px)")
.transform("rotate(45deg)")
.transition("all 0.2s ease")
.cursor("pointer")
```

### Events

```hypen
// Click/press
.onClick(@actions.handleClick)
.onClick(@actions.doSomething, id: "@{item.id}")   // With payload
.onPress(@actions.handlePress)                      // Alias

// Form events
.onInput(@actions.handleInput)      // Fires on each keystroke
.onChange(@actions.handleChange)     // Fires on value change
.onSubmit(@actions.handleSubmit)

// Keyboard
.onKey(@actions.send)               // Fires on Enter key by default

// Focus
.onFocus(@actions.handleFocus)
.onBlur(@actions.handleBlur)

// Mouse
.onMouseEnter(@actions.handleHover)
.onMouseLeave(@actions.handleLeave)

// Scroll
.onScroll(@actions.handleScroll)    // Throttled 100ms

// Long press
.onLongClick(@actions.handleLong)
.onLongPress(@actions.handleLong)   // Alias

// Disable interaction
.disabled(true)
.disabled(@{state.isLoading})
```

### Two-Way Binding

`.bind()` creates automatic two-way sync between a form element and state. No action handler needed.

```hypen
Input(placeholder: "Name").bind(@state.name)
Textarea(placeholder: "Bio").bind(@state.bio)
Checkbox {}.bind(@state.agreed)
Switch {}.bind(@state.darkMode)
Select {}.bind(@state.country)
Slider(min: 0, max: 100).bind(@state.volume)
```

**`.bind()` syncs, it doesn't *react*.** The binding keeps `@state.x` updated as the user types/toggles — no handler needed for the sync itself. When you want the server to *do something* on each change (re-run a query, validate, filter a list), combine `.bind()` with the matching event:

```hypen
Input(placeholder: "Search")
  .bind(@state.query)            // state.query updates on every keystroke
  .onInput(@actions.search)       // and the server re-runs the query
```

Same shape for `Checkbox { }.bind(@state.agreed).onChange(@actions.submit)`, etc.

### Tailwind CSS Support

```hypen
.tw("p-4 text-blue-500 rounded-xl bg-white")
.tw("flex items-center justify-center gap-4")
.tw("text-sm md:text-base lg:text-lg")              // Responsive
.tw("bg-blue-500 hover:bg-blue-600")                // State variants
```

### Responsive & State Variants

Any applicator accepts a map for responsive breakpoints or interaction states:

```hypen
// Responsive breakpoints: default (0px), sm (640px), md (768px), lg (1024px), xl (1280px), 2xl (1536px)
.fontSize({default: 14, md: 18, lg: 24})
.padding({default: 8, md: 16, lg: 32})
.width({default: "100%", md: "50%", lg: "33%"})

// Interaction states: hover, focus, active, disabled, focus-visible, focus-within
.backgroundColor({default: "#3B82F6", hover: "#2563EB", active: "#1D4ED8"})
.borderColor({default: "#D1D5DB", focus: "#3B82F6"})
```

## Module System

Modules manage state and handle actions. They pair with `.hypen` template files OR inline their UI via `.ui(\`...\`)`. Every SDK follows the same pattern: define state, register action handlers, add lifecycle hooks.

### Lifecycle (all SDKs)

Every module supports a **4-phase lifecycle**:

| Hook | Fires | Typical use |
|------|-------|-------------|
| `onCreated` | **Once** per module instance | Initial fetch, open connections |
| `onActivated` | **Every time** the module becomes the active route target | Reload/refresh, resubscribe |
| `onDeactivated` | **Every time** the module stops being the active route target | Pause timers, unsubscribe |
| `onDestroyed` | Once, when the instance is torn down | Cleanup, close connections |

Under `ManagedRouter`, module-backed routes **persist across navigations by default** — navigating away and back reuses the same module instance (and its state). Opt out with `{ persist: false }` on the route/module definition. The persist cache is a bounded LRU (default 10, configurable via `maxPersistedModules`).

### Inline UI vs. paired file

Each SDK exposes `.ui(\`...\`)` to define the template inline in the same file as the module; use `.build()` instead when pairing with a `.hypen` file.

**Nested modules need an explicit `module Name { ... }` wrapper in the inline template.** When a module is registered under a name (`app.module("Home").defineState(...).ui(...)` in TS, and equivalents in other SDKs) and served as a nested route target, its inline template must wrap its root in `module Home { ... }`. Without it, `@{state.x}` inside the template resolves against the **primary** module's state scope (usually App), not Home's, and the bindings silently render blank.

```typescript
// ✅ Correct — bindings resolve against Home's own state slot.
app.module("Home")
  .defineState({ items: [] })
  .ui(`
    module Home {
      Column {
        List(@state.items) { Text("@{item.name}") }
      }
    }
  `);

// ❌ Without the wrapper @state.items resolves against the App
// primary module, which has no `items`, so the list renders empty.
app.module("Home")
  .defineState({ items: [] })
  .ui(`
    Column {
      List(@state.items) { Text("@{item.name}") }
    }
  `);
```

The **anonymous primary** module — `app.defineState(...)` with no `.module(name)` call — does **not** need the wrapper (though it's fine to include one, e.g. `module App { ... }`). It owns the engine's primary state slot, which is the default binding scope.

#### Gotcha: backticks inside inline `.ui(\`...\`)`

JavaScript / TypeScript template literals terminate on any unescaped backtick — **including backticks inside comments in your template text**. Writing `// uses \`List\` for iteration` inside the template silently truncates the string; the parser then reports `Unexpected :` or `Unexpected )` deep in the DSL. Use plain quotes in comments instead: `// uses "List" for iteration`.

### Arguments on module / component invocations

The DSL lets you declare args on both components and modules (`component Card(title, subtitle) { ... }`, `module Page(userId) { ... }`) and pass them at the call site (`Card(title: "Hi")`, `Page(userId: @state.currentUserId)`).

**Args become element-level props, not state.** Concretely:

- Passed values land in the `Props` map on the invocation's Element node. Primitive-ish targets read them directly — e.g. `Icon(name: "star")` hands `name` straight to the renderer.
- Args do **not** merge into the nested module's `state`. A template body that writes `@{state.userId}` will not find a `userId` you passed as an arg — it looks up `state.userId` on the module's own state.
- TS / Kotlin / Go / Swift / Rust handlers (`onActivated`, `onAction`, lifecycle hooks) receive only the module's own state, context, and action payload. They never see the incoming args.

If you need to thread data from a parent module into a nested module's logic, use one of:

- **URL route params** (`Route(path: "/profile/:id") { Profile() }`) read inside the module via `context.router.matchPath(...)` — usually the cleanest, since the URL becomes the source of truth.
- **Cross-module state access** from a handler: `context.getModule<AppState>("app").setState({ ... })` / `.getState()` (see "Accessing sibling modules" below).
- **A direct DB / data-source read** inside `onActivated`, when the datum is really backend-owned (e.g. current user, feature flags).

### Serving multi-module apps

Production apps register every module on an app registry and serve the whole thing — not one module per server:

| SDK | Register modules on | Serve with |
|-----|---------------------|-----------|
| TypeScript | `new HypenApp()` + `myApp.module("Name")...build()` | `new RemoteServer().app(myApp).listen(port)` |
| Swift | `HypenApp()` + `hypen(State()).name("Name").app(myApp)...build()` | `RemoteServer().app(myApp).listen(port)` |
| Kotlin | `hypen(State()) { name("Name"); ... }` (auto-registers on `HypenApp`) | `HypenServer { module("Name", def) }.install(app)` |
| Go | `core.NewApp(State{}).Name("Name")...Build()` (auto-registers on `core.App`) | `remote.NewRemoteServer().WithDefinition(primary).Listen(port)` |
| Rust | `HypenApp::builder().route("/path", module)` | Framework integration (Axum, Actix, etc.) |

Single-module shortcuts (TS `.module(name, def).ui(template)`, Swift `RemoteServer(moduleDefinition:)`, Go `.WithState(...)`) still exist for demos but skip the registry.

#### TypeScript wiring — concrete recipe

The three wiring surfaces on `RemoteServer` interact in ways that aren't obvious at first read:

```typescript
import { app } from "@hypen-space/core/app";
import { RemoteServer } from "@hypen-space/server/remote";
import appModule from "./components/App";
// Side-effect imports: each component file self-registers under its
// name on the shared `app` registry via `app.module("X").defineState(...).ui(...)`.
import "./components/Home";
import "./components/AddFood";
import "./components/Stats";

new RemoteServer()
  .app(app)                                // share the app registry with the server
  .module("App", appModule)                // the *primary* module (engine's main state slot)
  .ui(appModule.template ?? "")            // primary template — usually contains the Router
  .source(resolve(__dirname, "./components")) // discovery source for nested screens
  .listen(3000);
```

What each method does:

- **`.app(appInstance)`** — tells the server about the shared `HypenApp` registry. On each session, `RemoteSession.registerNestedModules` walks `app.components` and registers every named module with the engine.
- **`.module("App", appModule)`** — sets the engine's *primary* module (the one whose state lives under the unnamed/primary slot). The primary name is stored separately from the app registry; named modules registered under the same key are skipped on nested registration to avoid collision.
- **`.ui(dsl)`** — the primary template. This is what `renderSource` runs through the engine on session start.
- **`.source(dir)`** — discovery. Walks `.ts` files exporting a `.ui(...)` default, imports them (which triggers their side-effect registration in the `app` registry), and stuffs the template into the component resolver. This is what lets `Router { Route { Home() } }` resolve the `Home()` reference at render time.

Auto-skip of empty nested modules: a definition with **no initial state keys AND no action handlers** is skipped by `registerNestedModules` — a useful escape hatch for stateless UI components (e.g. a `BottomNav` whose `@state.location` should fall through to the App primary scope). Achieve it by writing `app.defineState({}).ui(...)` with no `.module(name)` call — that definition also doesn't auto-register in the app registry, so discovery picks the template up from the filesystem but no scope is claimed.

### TypeScript

```typescript
import { app } from "@hypen-space/core";

interface AppState {
  count: number;
  items: { id: string; text: string; done: boolean }[];
  input: string;
  isLoading: boolean;
}

export default app
  .defineState<AppState>({ count: 0, items: [], input: "", isLoading: false })
  .onCreated(async (state, context) => { state.items = await fetchItems(); })
  .onActivated(async (state) => { /* resubscribe */ })
  .onAction("increment", async ({ state }) => {
    state.count++;  // Proxy auto-tracks mutations
  })
  .onAction<{ id: string }>("removeItem", async ({ action, state }) => {
    state.items = state.items.filter(item => item.id !== action.payload!.id);
  })
  .onDeactivated((state) => { /* pause */ })
  .onDestroyed((state, context) => { /* cleanup */ })
  .build();  // or .ui(`Column { ... }`) for inline template
```

### Kotlin

Kotlin offers both a **typed DSL** (recommended) with `@Serializable` data classes and an **untyped DSL** with map-based state:

```kotlin
@Serializable
data class AppState(var count: Int = 0, var items: List<Item> = emptyList())

val module = hypen(AppState()) {
    name("app")

    onCreated { state, context -> state.items = fetchItems() }
    onActivated { state, context -> /* resubscribe */ }
    onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
    onDeactivated { state, context -> }
    onDestroyed { state, context -> }

    ui("""Column { Text("@{state.count}") }""")  // or omit for paired .hypen file
}
```

### Go

Go's typed builder `NewApp[T]` types the **state** via `TypedActionContext[T]`. Action **payloads remain `any`** (no per-action payload generic) — type-assert `ctx.Action.Payload` when needed.

```go
type CounterState struct {
    Count int `json:"count"`
}

module := core.NewApp(CounterState{Count: 0}).
    OnCreated(func(state *CounterState, _ core.GlobalContext) { /* init */ }).
    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count++
    }).
    OnAction("add", func(ctx core.TypedActionContext[CounterState]) {
        if p, ok := ctx.Action.Payload.(map[string]any); ok {
            if amt, ok := p["amount"].(float64); ok {
                ctx.State.Count += int(amt)
            }
        }
    }).
    UI(`Column { Text("@{state.count}") }`)
```

### Swift

Swift supports two typed-action forms: **enum-based** (one handler, switch over cases) and **per-action generic payload**.

```swift
struct CounterState: Codable {
    var count: Int = 0
}

struct AddPayload: Codable { let amount: Int }

let counter = hypen(CounterState())
    .onCreated { state, context in /* init */ }
    .onActivated { state, context in /* resubscribe */ }
    .onAction("increment") { state in state.count += 1 }
    .onAction("add", payload: AddPayload.self) { state, payload in
        state.count += payload.amount
    }
    .onDestroyed { state, context in /* cleanup */ }
    .ui("""
        Column { Text("Count: @{state.count}") }
    """)
    .build()
```

### Rust

Rust uses per-action generic payload typing via `on_action::<P>`.

```rust
use hypen_server::HypenApp;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
struct Counter { count: i64 }

#[derive(Deserialize)]
struct AddPayload { amount: i64 }

let module = HypenApp::module::<Counter>("Counter")
    .state(Counter { count: 0 })
    .on_action::<()>("increment", |state, _, _ctx| { state.count += 1; })
    .on_action::<AddPayload>("add", |state, payload, _ctx| {
        state.count += payload.amount;
    })
    .ui(r#"Column { Text("@{state.count}") }"#)
    .build();
```

### Typed nested modules

All five SDKs support typed, nested modules — register child modules under a parent via each SDK's nested-module API (e.g. `.nested("Search", searchModule)` in TS, the equivalent nested builder hook in Kotlin/Go/Swift/Rust). Nested modules share the engine instance and each own their namespaced state slice; the parent can access children through `context.getModule("name")` / `GlobalContext`.

### Accessing sibling modules (TypeScript)

`context.getModule<T>(id)` returns a `ModuleReference<T>`:

```typescript
type ModuleReference<T> = {
  state: T;                               // live proxy — direct mutation tracked
  setState: (patch: Partial<T>) => void;  // merge-update (NOT `updateState`)
  getState: () => T;                      // deep snapshot, mutations not tracked
};
```

Typical use from a handler:

```typescript
.onAction("shareFromHome", async ({ context }) => {
  if (!context.hasModule("app")) return;
  context.getModule<AppState>("app").setState({ activeTab: "share" });
});
```

Note: the mutator on the returned reference is `setState`, not `updateState`. (`HypenModuleInstance` internally has `updateState`, but you don't interact with that directly.)

### Router API (TypeScript)

`context.router` is a `HypenRouter` exposing:

- `push(path: string)` — navigate; updates the engine-side `state.location` mirror.
- `getCurrentPath()` — current URL-mirrored path.
- `matchPath(pattern: string, path: string)` — returns `{ params: Record<string, string> } | null`. Handles `exact`, `:param`, and `/*` trailing patterns.

Param-driven screen idiom:

```typescript
.onActivated(async (state, context) => {
  const path = context?.router?.getCurrentPath() ?? "/";
  const match = context?.router?.matchPath("/user/:id", path);
  const id = match?.params.id ?? "me";
  state.user = await loadUser(id);
})
```

Dynamic navigation targets work in the DSL via binding interpolation:

```hypen
Button { Text("@{item.name}") }
  .onClick(@router.push, to: "/user/@{item.id}")
```

### Key Rules

- **State mutations are auto-tracked** — TypeScript uses Proxy, Kotlin syncs `var` fields back after handlers, Go/Rust/Swift diff a typed struct against a pre-handler snapshot and commit only changed keys.
- **Actions can be async** — TypeScript/Kotlin (suspend) and Swift (`onActionAsync`) support async natively. Rust/Go handlers are sync.
- **Action payloads** come from UI event arguments: `.onClick(@actions.remove, id: "@{item.id}")` delivers `action.payload.id` in the SDKs that type the payload.
- **`context.router`** provides `HypenRouter` for programmatic navigation.
- **`context.getModule("name")`** / `GlobalContext` for cross-module communication.

## Typed Actions

Typed actions provide compile-time safety for action names and payloads. Each SDK's typed-action ergonomics differ:

| SDK | Typed state | Typed payload | Style |
|-----|------------|---------------|-------|
| TypeScript | ✅ | ✅ per-action generic | `.onAction<P>("name", ...)` |
| Rust | ✅ | ✅ per-action generic | `.on_action::<P>("name", ...)` |
| Swift | ✅ | ✅ per-action generic **or** enum-based | `.onAction("name", payload: P.self, ...)` or `.onAction(Enum.self)` |
| Kotlin | ✅ | ✅ via sealed interface | `.onAction<MyAction.Variant>(...)` |
| Go | ✅ | ❌ payload is `any` (type-assert) | `.OnAction("name", TypedActionContext[T])` |

### TypeScript

```typescript
.onAction<{ id: string; name: string }>("deleteItem", async ({ action, state }) => {
  const { id, name } = action.payload!;  // fully typed
  state.items = state.items.filter(item => item.id !== id);
})

// Without a type parameter, payload is unknown
.onAction("simple", async ({ state }) => { state.count++; })
```

### Rust

```rust
#[derive(Deserialize)]
struct DeletePayload { id: String }

.on_action::<DeletePayload>("deleteItem", |state, payload, _ctx| {
    state.items.retain(|i| i.id != payload.id);
})
.on_action::<()>("simple", |state, _, _ctx| { state.count += 1; })
```

### Swift — two forms

```swift
// Form A: per-action generic payload (matches TS / Rust)
struct DeletePayload: Codable { let id: String }

.onAction("deleteItem", payload: DeletePayload.self) { state, payload in
    state.items.removeAll { $0.id == payload.id }
}

// Form B: enum-based — one handler, switch over cases
enum CounterAction: String, Codable { case increment, decrement, reset }

.onAction(CounterAction.self) { state, action in
    switch action {
    case .increment: state.count += 1
    case .decrement: state.count -= 1
    case .reset:     state.count = 0
    }
}
```

### Kotlin — Sealed Interface Actions

Kotlin's typed actions use sealed interfaces. Each variant is a distinct type with its own payload fields, and the action name derives from the class name by default.

```kotlin
sealed interface TodoAction : HypenAction {
    data object Add : TodoAction                              // No payload
    data object Clear : TodoAction                            // No payload
    @Serializable
    data class Remove(val id: String) : TodoAction            // Typed payload
    @Serializable
    data class SetPriority(val id: String, val level: Int) : TodoAction {
        override val _actionName: String get() = "setPriority"  // Custom action name
    }
}

val module = hypen(TodoState()) {
    onAction<TodoAction.Add> { _, state, _ -> state.items += Item(id = uuid(), text = state.input) }
    onAction<TodoAction.Remove> { action, state, _ ->
        state.items = state.items.filter { it.id != action.id }  // Direct field access
    }
    onAction<TodoAction.SetPriority> { action, state, _ ->
        // Dispatched as "setPriority" (custom name), not "SetPriority"
        state.items = state.items.map {
            if (it.id == action.id) it.copy(priority = action.level) else it
        }
    }
    onActionAsync<TodoAction.Clear> { _, state, _ ->
        delay(100)
        state.items = emptyList()
    }
}
```

**Kotlin action-name mapping (Kotlin-specific):**
- `data object Increment` → dispatched by `@actions.Increment`
- `data class Remove(val id: String)` → `@actions.Remove` with payload
- Override `_actionName` for a custom name.
- Payload deserialization is automatic from the UI-dispatched named args.

### Go — typed state only

Go types the **state** through `TypedActionContext[T]` but does **not** type the payload — `ctx.Action.Payload` is `any`. For typed payloads, type-assert inside the handler:

```go
.OnAction("delete", func(ctx core.TypedActionContext[TodoState]) {
    if p, ok := ctx.Action.Payload.(map[string]any); ok {
        if id, _ := p["id"].(string); id != "" {
            // mutate ctx.State with id
        }
    }
})
```

## Complete Examples

### Counter

**component.hypen:**
```hypen
module App {
  Column {
    Text("Count: @{state.count}")
      .fontSize(48)
      .fontWeight("bold")
      .color("#007bff")

    Row {
      Button {
        Text("-")
          .fontSize(24)
          .color("#fff")
      }
      .onClick(@actions.decrement)
      .padding(16)
      .paddingHorizontal(24)
      .backgroundColor("#dc3545")
      .borderRadius(8)

      Button {
        Text("+")
          .fontSize(24)
          .color("#fff")
      }
      .onClick(@actions.increment)
      .padding(16)
      .paddingHorizontal(24)
      .backgroundColor("#28a745")
      .borderRadius(8)
    }
    .gap(16)
  }
  .padding(32)
  .gap(24)
  .horizontalAlignment("center")
  .verticalAlignment("center")
}
```

**component.ts (TypeScript):**
```typescript
import { app } from "@hypen-space/core";

type CounterState = { count: number };

export default app
  .defineState<CounterState>({ count: 0 })
  .onAction("increment", async ({ state }) => {
    state.count++;
  })
  .onAction("decrement", async ({ state }) => {
    state.count--;
  })
  .build();
```

**component.kt (Kotlin — typed actions):**
```kotlin
@Serializable
data class CounterState(var count: Int = 0)

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
}

val counterModule = hypen(CounterState()) {
    name("counter")
    onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
    onAction<CounterAction.Decrement> { _, state, _ -> state.count -= 1 }
}
```

> **Note:** The `.hypen` template references `@actions.increment` / `@actions.decrement` in TypeScript (lowercase convention), but `@actions.Increment` / `@actions.Decrement` in Kotlin (derived from sealed class names). Use `override val _actionName` to customize.

### Todo List

**component.hypen:**
```hypen
module App {
  Column {
    Text("My Tasks")
      .fontSize(24)
      .fontWeight("bold")

    Row {
      Input(placeholder: "Add a task...")
        .bind(@state.newTask)
        .onKey(@actions.addTask)
        .flex(1)
        .padding(12)
        .borderWidth(1)
        .borderColor("#D1D5DB")
        .borderRadius(8)

      Button {
        Text("Add")
          .color("#fff")
          .fontWeight("bold")
      }
      .onClick(@actions.addTask)
      .backgroundColor("#3B82F6")
      .padding(12)
      .borderRadius(8)
    }
    .gap(8)

    List(@state.tasks) {
      Row {
        Checkbox {}.bind(@state.tasks[@{item.index}].done)

        Text("@{item.text}")
          .color("@{item.done ? '#9CA3AF' : '#111827'}")
          .textDecoration("@{item.done ? 'line-through' : 'none'}")
          .flex(1)

        Button {
          Text("Remove")
            .fontSize(12)
            .color("#EF4444")
        }
        .onClick(@actions.removeTask, id: "@{item.id}")
        .backgroundColor("transparent")
      }
      .padding(12)
      .borderRadius(8)
      .borderWidth(1)
      .borderColor("#E5E7EB")
      .verticalAlignment("center")
      .gap(12)
    }
    .gap(8)
  }
  .padding(24)
  .gap(16)
  .maxWidth(600)
}
```

**component.ts:**
```typescript
import { app } from "@hypen-space/core";

type Task = { id: string; text: string; done: boolean };
type TodoState = { tasks: Task[]; newTask: string };

export default app
  .defineState<TodoState>({ tasks: [], newTask: "" })
  .onCreated(async (state) => {
    state.tasks = [
      { id: "1", text: "Learn Hypen", done: true },
      { id: "2", text: "Build an app", done: false },
    ];
  })
  .onAction("addTask", async ({ state }) => {
    const text = state.newTask.trim();
    if (!text) return;
    state.tasks.unshift({ id: Date.now().toString(), text, done: false });
    state.newTask = "";
  })
  .onAction<{ id: string }>("removeTask", async ({ action, state }) => {
    state.tasks = state.tasks.filter(t => t.id !== action.payload!.id);
  })
  .build();
```

### Chat App with API

**component.hypen:**
```hypen
module App {
  Column {
    // Header
    Row {
      Text("Chat")
        .fontSize(20)
        .fontWeight("bold")
      Spacer()
      Button {
        Text("Clear")
          .color("#6B7280")
          .fontSize(14)
      }
      .onClick(@actions.clearChat)
      .backgroundColor("transparent")
      .borderWidth(1)
      .borderColor("#E5E7EB")
      .borderRadius(6)
      .padding(horizontal: 12, vertical: 6)
    }
    .padding(16)
    .borderBottom(1)
    .borderColor("#E5E7EB")
    .verticalAlignment("center")

    // Messages
    List {
      ForEach(items: @state.messages, key: "id") {
        Row {
          Column {
            Text("@{item.content}")
              .color("@{item.role == 'user' ? '#FFFFFF' : '#111827'}")
              .fontSize(15)
          }
          .backgroundColor("@{item.role == 'user' ? '#3B82F6' : '#F3F4F6'}")
          .padding(12)
          .borderRadius(12)
          .maxWidth("75%")
        }
        .horizontalAlignment("@{item.role == 'user' ? 'end' : 'start'}")
        .fillMaxWidth(true)
      }

      If(condition: @state.isLoading) {
        Row {
          Text("Thinking...")
            .color("#6B7280")
            .fontSize(14)
        }
      }
    }
    .padding(16)
    .weight(1)
    .gap(8)

    // Input
    Row {
      Input(placeholder: "Type a message...")
        .bind(@state.input)
        .onKey(@actions.send)
        .flex(1)
        .padding(12)
        .borderWidth(1)
        .borderColor("#D1D5DB")
        .borderRadius(8)

      Button {
        Text("@{state.isLoading ? '...' : 'Send'}")
          .color("#FFFFFF")
          .fontWeight("bold")
      }
      .onClick(@actions.send)
      .backgroundColor("@{state.isLoading ? '#93C5FD' : '#3B82F6'}")
      .padding(horizontal: 16, vertical: 12)
      .borderRadius(8)
    }
    .gap(8)
    .padding(16)
    .borderTop(1)
    .borderColor("#E5E7EB")
  }
  .height("100vh")
  .backgroundColor("#FFFFFF")
}
```

### Routing

**component.hypen:**
```hypen
Column {
  Header

  Router {
    Route("/") {
      HomePage
    }
    Route("/products") {
      ProductsPage
    }
    Route("/about") {
      AboutPage
    }
  }
  .flex(1)

  Footer
}
.width("100%")
.minHeight("100vh")
```

## Common Patterns

### Loading states
```hypen
When(value: @state.status) {
  Case(match: "loading") { Center { Spinner() } }
  Case(match: "error") { Text("Error: @{state.errorMessage}").color("#EF4444") }
  Case(match: "loaded") { ContentView() }
}
```

### Conditional styling (prefer expressions over If)
```hypen
Text("@{item.text}")
  .color("@{item.active ? '#3B82F6' : '#6B7280'}")
  .fontWeight("@{item.active ? 'bold' : 'normal'}")
```

### Action payloads
```hypen
// Pass data with action (same DSL syntax for all SDKs)
Button { Text("Delete") }
  .onClick(@actions.delete, id: "@{item.id}", name: "@{item.name}")
```

```typescript
// TypeScript — generic payload type
.onAction<{ id: string; name: string }>("delete", async ({ action, state }) => {
  const { id, name } = action.payload!;
})
```

```kotlin
// Kotlin — sealed interface with data class payload
@Serializable
data class Delete(val id: String, val name: String) : MyAction
// ...
onAction<MyAction.Delete> { action, state, _ ->
  // action.id and action.name are directly typed
}
```

### Mixing Tailwind + applicators
```hypen
Column {
  Text("Hello")
    .tw("text-xl font-bold text-gray-900")  // Tailwind for utility classes
    .marginBottom(16)                         // Applicators for precise values
}
.tw("p-6 bg-white rounded-xl shadow-lg")
```

## Rules & Gotchas

1. **Component names are case-insensitive** in the renderer (Text = text), but use PascalCase by convention.
2. **Applicators go after children**, not before: `Column { children }.padding(16)` is correct.
3. **Bare numbers become px** in CSS properties, except unitless ones (opacity, z-index, flex, font-weight, line-height, flex-grow, flex-shrink, order).
4. **Any unknown applicator** falls through to CSS: `.wordBreak("break-word")`, `.cursor("pointer")` just work.
5. **`@{state.xxx}`** resolves against the active module's state. Cross-module state requires explicit prop passing or context.
6. **Always use `key` in ForEach** for lists that change dynamically.
7. **`.bind()` only works with `@state.*`**, not `@item.*`. Use it on Input, Textarea, Checkbox, Switch, Select.
8. **Action payloads** are passed as additional named arguments on event applicators, not wrapped in `{payload: ...}`.
9. **Typed actions (Kotlin)** derive action names from class names by default. Use `override val _actionName` to customize the name that maps to `@actions.xxx` in the DSL.
10. **Trailing commas are allowed** in argument lists: `Component(a: 1, b: 2,)`.
11. **Single and double quotes** both work for strings. Single quotes allow embedding double quotes without escaping.
12. **Module files are optional** — a `.hypen` file without a paired module file is a stateless component. Conversely, a module file using `.ui(\`...\`)` needs no `.hypen` file.
13. **Lifecycle is 4-phase** — `onCreated` (once) / `onActivated` (per-navigation) / `onDeactivated` (per-navigation) / `onDestroyed` (once). Under `ManagedRouter`, module-backed routes persist across navigations by default; opt out with `{ persist: false }`.
14. **`initialRoute` is NOT a DSL prop** — initial route is configured on `ManagedRouter` in the host SDK, not on `<Router>` in the template.
15. **Payload typing varies by SDK** — TS/Rust/Swift have per-action generic payloads; Kotlin uses sealed-interface variants; Go types state only (payload is `any`).
16. **Inline `.ui(\`...\`)` template literal gotcha** — backticks inside the template string (including inside DSL comments) terminate the JS template literal. Use plain quotes in comments inside inline templates.
17. **Nested modules need `module Name { ... }` wrapping** in their inline templates so bindings resolve to the right state scope. The anonymous primary module (`app.defineState(...)` with no `.module(name)`) doesn't need the wrapper.
18. **Args on module / component invocations become element props, not state** — they're attached to the call-site node and don't merge into the nested module's `state`, nor are they visible to TS/Kotlin/Go/Swift/Rust handlers. Use route params, `context.getModule(...)`, or a direct data-source read for cross-module data.
