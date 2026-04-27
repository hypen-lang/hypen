# Hypen Language Reference

Hypen is a declarative UI language. Templates (`.hypen`) define UI, host-language modules define state and actions.

## Syntax Basics

```hypen
// Component with positional arg
Text("Hello")

// Component with named args
Input(placeholder: "Name", disabled: false)

// Component with children
Column {
    Text("Child 1")
    Text("Child 2")
}

// Applicators (styling) — chained with dots
Text("Styled")
    .fontSize(18)
    .fontWeight("bold")
    .color("#333")

// State binding
Text("Count: @{state.count}")
Text("@{state.user.name}")

// Action via applicator (cross-platform)
Button { Text("Save") }
    .onClick(@actions.save)

// Action with payload
Button { Text("Delete") }
    .onClick(@actions.delete, itemId: "@{state.id}")

// Two-way binding
Input(placeholder: "Name").bind(@state.name)

// Resource reference
Icon(@resources.heart).size(24).color("red")

// Module declaration (stateful component)
module Counter {
    Column {
        Text("@{state.count}")
        Button { Text("+") }.onClick(@actions.increment)
    }
}

// Comments
// Line comment
/* Block comment — /* nesting supported */ */
```

## Strings

```hypen
// Double-quoted
Text("Hello \"world\"")

// Single-quoted — convenient for embedding double quotes
Text('Embed "double quotes" freely')

// Template strings with state interpolation
Text("Welcome, @{state.user.name}!")
Text("@{state.count} items (@{state.count == 1 ? 'item' : 'items'})")
```

## Arguments

```hypen
// Positional
Text("Hello")

// Named
Image(src: "photo.jpg", alt: "A photo")

// Mixed
Input("email", placeholder: "you@example.com")

// Value types: strings, numbers, booleans, lists, maps, references
Button(text: "Go", enabled: true, tags: ["primary"], size: 48)

// References (unquoted, prefixed with @)
Icon(@resources.star)                    // Resource reference
ForEach(items: @state.users, key: "id") // State binding reference
Text(@spacetime.messages)               // Data source reference
```

## Components

### Layout
| Component | Description |
|-----------|-------------|
| `Column { }` | Vertical stack |
| `Row { }` | Horizontal stack |
| `Box { }` / `Container { }` | Z-axis stacking (overlay) |
| `Center { }` | Centers content |
| `Stack { }` | Z-axis overlay |
| `Grid { }` | Grid layout (use `.gridColumns(n)`) |
| `List { }` | Virtualized scrollable list |
| `Spacer()` | Flexible space |
| `Divider()` | Separator line |

### Content
| Component | Description |
|-----------|-------------|
| `Text("content")` | Text display |
| `Heading("title")` | Heading text |
| `Paragraph("text")` | Paragraph text |
| `Image(src: "url")` | Image |
| `Icon(@resources.name)` | SVG icon from registered resources |
| `Avatar("url")` | Circular image |
| `Badge("label")` | Small label |
| `Card { }` | Elevated container |
| `Spinner()` | Loading indicator |
| `ProgressBar(value: 0.5)` | Progress bar |

### Input
| Component | Description |
|-----------|-------------|
| `Button { }` | Tappable container. Use `.onClick(@actions.x)` for actions |
| `Input()` | Text input. Use `.bind(@state.field)` for two-way binding |
| `Textarea()` | Multi-line text. Use `.bind(@state.field)` |
| `Checkbox()` | Boolean toggle. Use `.bind(@state.field)` (binds `checked`) |
| `Switch()` | On/off toggle. Use `.bind(@state.field)` (binds `on`) |
| `Select()` | Dropdown picker. Use `.bind(@state.field)` |
| `Slider()` | Range input. Use `.bind(@state.field)` |

### Navigation
| Component | Description |
|-----------|-------------|
| `Router { }` | Router container |
| `Route(path: "/") { }` | Route definition |
| `Link(href: "/path") { }` | Navigation link |

### Media
| Component | Description |
|-----------|-------------|
| `Video(src: "url")` | Video player (Web, iOS, Android) |
| `Audio(src: "url")` | Audio player (Web, iOS, Android) |

## Control Flow

### ForEach — iterate over lists

```hypen
ForEach(items: @state.users, key: "id") {
    Row {
        Avatar("@{item.avatarUrl}").size(40)
        Text("@{item.name}").fontWeight("bold")
    }
}

// With custom item variable name
ForEach(items: @state.messages, as: "msg", key: "id") {
    Text("@{msg.text}")
}
```

### If — boolean conditional

```hypen
If(condition: "@{state.isLoggedIn}") {
    Text("Welcome back!")
}

// With else branch
If(condition: "@{state.items.length > 0}") {
    ForEach(items: @state.items, key: "id") {
        Text("@{item.name}")
    }
    Else {
        Text("No items yet")
    }
}
```

### When — pattern matching

```hypen
When(value: "@{state.status}") {
    Case(match: "loading") {
        Spinner()
    }
    Case(match: "error") {
        Text("Something went wrong").color("red")
    }
    Case(match: "success") {
        Text("Done!")
    }
    Else {
        Text("Unknown state")
    }
}
```

## List & Grid

`List` and `Grid` work like `ForEach` but produce virtualized containers — native renderers use `LazyColumn`/`LazyVStack` for efficient scrolling.

### List

```hypen
// Scrollable list with item template
List(items: @state.posts, key: "id") {
    Card {
        Text("@{item.title}").fontWeight("bold")
        Text("@{item.body}").color("#666")
    }
    .padding(12)
}
.flex(1)

// With custom item variable
List(items: @state.messages, as: "msg", key: "id") {
    Text("@{msg.text}")
}
```

### Grid

```hypen
// Photo grid
Grid(items: @state.photos, key: "id") {
    Image(src: "@{item.url}")
        .aspectRatio("1")
        .objectFit("cover")
}
.gridColumns(3)
.gap(2)
```

Both accept the same arguments as `ForEach`: `items` (array binding), `key` (reconciliation key), `as` (item variable name, default `"item"`). Applicators on `List`/`Grid` style the container; child template styles each item.

## Events

Events are attached via applicators. The action reference (`@actions.name`) dispatches to the module's `onAction` handler.

| Applicator | Triggers |
|------------|----------|
| `.onClick(@actions.x)` | Click/tap |
| `.onPress(@actions.x)` | Alias for onClick |
| `.onLongClick(@actions.x)` | Long press (~500ms) |
| `.onLongPress(@actions.x)` | Alias for onLongClick |
| `.onInput(@actions.x)` | Every keystroke (payload: `value`) |
| `.onChange(@actions.x)` | Value committed |
| `.onFocus(@actions.x)` | Focus gained |
| `.onBlur(@actions.x)` | Focus lost |
| `.onKey(@actions.x)` | Enter key press |
| `.onScroll(@actions.x)` | Scroll (payload: `scrollTop`, `atBottom`) |
| `.onMouseEnter(@actions.x)` | Hover start (Web only) |
| `.onMouseLeave(@actions.x)` | Hover end (Web only) |

### Event payloads

```hypen
// Additional named args become payload fields
Button { Text("Like") }
    .onClick(@actions.toggleLike, postId: "@{item.id}")

// The module receives: action.name = "toggleLike", action.payload = { postId: "p1" }
```

## Two-Way Binding

`.bind(@state.path)` syncs a form element's value with state automatically. The engine handles both directions — state changes update the UI, user input updates state.

```hypen
Input(placeholder: "Email").bind(@state.email)
Textarea(placeholder: "Bio").bind(@state.bio)
Checkbox { Text("Agree") }.bind(@state.agreed)       // binds checked
Switch { Text("Dark mode") }.bind(@state.darkMode)    // binds on
Select { /* options */ }.bind(@state.country)          // binds value
Slider(min: 0, max: 100).bind(@state.volume)          // binds value
```

When you need custom logic on input (validation, debounce), use manual event handlers instead:

```hypen
Input(placeholder: "Email")
    .value("@{state.email}")
    .onInput(@actions.validateEmail)
```

## Resources

Resources are external assets (SVG icons, images) registered with the engine at startup. Reference them with `@resources.name`:

```hypen
Icon(@resources.heart).size(24).color("red")
Icon(@resources.arrow-left).size(20)
```

Server SDKs register resource directories:
```swift
server.resourcesDir("./resources")   // Swift
```
```kotlin
resourcesDir("./resources")          // Kotlin
```

## Applicators

### Spacing
`.padding(16)` `.padding(horizontal: 16, vertical: 8)` `.padding(top: 8, right: 8, bottom: 8, left: 8)`
`.margin(16)` `.gap(12)` `.rowGap(16)` `.columnGap(8)`

### Size
`.width(200)` `.height(100)` `.size(48)` `.minWidth(100)` `.maxWidth(500)` `.minHeight(50)` `.maxHeight(300)`
`.fillMaxWidth(true)` `.fillMaxHeight(true)` `.fillMaxSize(true)` `.aspectRatio("16/9")`

### Colors
`.color("#hex")` `.backgroundColor("#hex")` `.borderColor("#hex")` `.opacity(0.5)`

### Typography
`.fontSize(16)` `.fontWeight("bold")` `.fontFamily("sans-serif")` `.fontStyle("italic")`
`.textAlign("center")` `.textDecoration("underline")` `.textTransform("uppercase")`
`.lineHeight(1.6)` `.letterSpacing(2)` `.maxLines(2)` `.textOverflow("ellipsis")`

### Borders
`.border(1)` `.border(width: 2, color: "#hex", style: "solid", radius: 8)`
`.borderWidth(2)` `.borderColor("#hex")` `.borderStyle("solid"|"dashed"|"dotted"|"double")`
`.borderRadius(8)` `.borderRadius(topLeft: 8, topRight: 8, bottomLeft: 0, bottomRight: 0)`
`.borderTop("1px solid #ccc")` `.borderBottom("1px solid #ccc")`

### Layout
`.horizontalAlignment("start"|"center"|"end"|"space-between"|"space-around")`
`.verticalAlignment("start"|"center"|"end"|"space-between"|"space-around")`
`.weight(1)` `.flex(1)` `.flexDirection("row"|"column")` `.flexWrap("wrap")`
`.overflow("hidden"|"scroll"|"auto")` `.scrollable(true)`
`.gridColumns(3)` `.gridTemplateColumns("1fr 2fr 1fr")`

### Positioning
`.position("absolute"|"relative"|"fixed"|"sticky")`
`.offset(x: 10, y: 20)`

### Effects
`.boxShadow("0 4px 6px rgba(0,0,0,0.1)")` `.elevation(4)` `.blur(4)` `.clipToBounds(true)`
`.filter("grayscale(100%)")` `.backdropFilter("blur(10px)")`

### Transforms
`.rotate(45)` `.scale(1.5)` `.scaleX(2)` `.scaleY(2)`
`.translateX(20)` `.translateY(-10)` `.transform("rotate(45deg) scale(1.2)")`

### Gradients
`.linearGradient("to right, #3B82F6, #8B5CF6")` `.radialGradient("circle, #fff, #000")` `.conicGradient("from 0deg, #f00, #0f0, #00f")`

### Background Images
`.backgroundImage("url")` `.backgroundSize("cover"|"contain")` `.backgroundPosition("center")`

### Animation (Web only)
`.transition("all 0.2s ease")` `.cursor("pointer")`

### Responsive Breakpoints
```hypen
Text("Hello")
    .fontSize(14)
    .fontSize@md(18)     // >= 768px
    .fontSize@lg(24)     // >= 1024px
```

### State Variants
```hypen
Button { Text("Hover me") }
    .backgroundColor("#eee")
    .backgroundColor:hover("#ddd")
    .backgroundColor:active("#ccc")
```

### Tailwind CSS
```hypen
Column {
    Text("Styled with Tailwind")
}.tw("flex-1 p-4 bg-white rounded-lg shadow-md")
```

## Module (TypeScript)

```typescript
import { app } from "@hypen-space/core";

interface State {
  count: number;
  user: { name: string } | null;
}

export default app
  .defineState<State>({ count: 0, user: null })

  .onCreated(async (state, context) => {
    // Runs once on mount. State changes auto-sync via Proxy.
  })

  .onAction("increment", async ({ state }) => {
    state.count++;
  })

  .onAction("updateName", async ({ action, state }) => {
    state.user = { name: action.payload.value };
  })

  .onDestroyed((state, context) => {
    // Cleanup
  });
```

## Module (Kotlin)

```kotlin
import space.hypen.core.*

// Typed actions with sealed interface
sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction { override val _actionName = "increment" }
}

val counter = hypen(CounterState(count = 0)) {
    name("Counter")
    onAction<CounterAction.Increment> { _, state, _ ->
        state.count += 1
    }
    ui(template)
}

// Or untyped
val counter = hypen {
    state { "count" to 0 }
    onAction("increment") { ctx ->
        ctx.state.set("count", (ctx.state.get("count") as Int) + 1)
    }
    ui(template)
}
```

## Module (Swift)

```swift
import HypenServer

struct CounterState: Codable { var count: Int = 0 }

let myApp = HypenApp()

let _ = hypen(CounterState())
    .name("Counter")
    .app(myApp)
    .onAction("increment") { state in state.count += 1 }
    .ui(template)
    .build()

try RemoteServer().app(myApp).listen(3000)
```

## Module (Go)

```go
import (
    core "github.com/hypen-space/core"
    "github.com/hypen-space/core/remote"
)

type CounterState struct { Count int `json:"count"` }

counter := core.NewApp(CounterState{}).
    Name("Counter").
    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
        ctx.State.Count++
    }).
    UI(template).
    Build()

remote.NewRemoteServer().WithDefinition(counter).Listen(3000)
```

## Platform Support

| Feature | Web | Android | iOS |
|---------|-----|---------|-----|
| All layout/content/input components | Yes | Yes | Yes |
| Icon (SVG resources) | Yes | Yes | Yes |
| Video, Audio | Yes | Yes | Yes |
| ForEach, If, When | Yes | Yes | Yes |
| List (virtualized) | Yes (scroll) | LazyColumn | LazyVStack |
| Grid | Yes (CSS Grid) | LazyGrid | LazyVGrid |
| `.bind()` two-way binding | Yes | Yes | Yes |
| Router / Route / Link | Yes | Yes | Yes |
| position (absolute/fixed) | Yes | Partial | Partial |
| filter, backdropFilter | Yes | No | No |
| transition, cursor | Yes | No | No |
| Responsive breakpoints | Yes | Yes | Yes |
| State variants (:hover) | Yes | Partial | Partial |
| Tailwind CSS (.tw) | Yes | Yes | Yes |

## Quick Examples

### Counter
```hypen
module Counter {
    Column {
        Text("@{state.count}").fontSize(48)
        Row {
            Button { Text("-") }.onClick(@actions.dec)
            Button { Text("+") }.onClick(@actions.inc)
        }.gap(16)
    }.padding(32).horizontalAlignment("center")
}
```

### Form with Binding
```hypen
Column {
    Input(placeholder: "Email").bind(@state.email)
        .padding(12).borderRadius(8).borderWidth(1)
    Input(placeholder: "Password").bind(@state.password)
        .padding(12).borderRadius(8).borderWidth(1)
    Button { Text("Submit") }
        .onClick(@actions.submit)
        .backgroundColor("#3B82F6").padding(12).borderRadius(8)
}.gap(16).padding(24)
```

### Card List
```hypen
List(items: @state.users, key: "id") {
    Card {
        Row {
            Avatar("@{item.avatar}").size(48)
            Column {
                Text("@{item.name}").fontWeight("bold")
                Text("@{item.email}").fontSize(12).color("#666")
            }.gap(4)
        }.gap(12).padding(16)
    }
}
```

### Conditional UI
```hypen
module Dashboard {
    Column {
        When(value: "@{state.status}") {
            Case(match: "loading") { Spinner() }
            Case(match: "error") {
                Text("@{state.errorMessage}").color("red")
                Button { Text("Retry") }.onClick(@actions.retry)
            }
            Case(match: "ready") {
                ForEach(items: @state.items, key: "id") {
                    Row {
                        Text("@{item.title}").flex(1)
                        Button { Icon(@resources.trash).size(16) }
                            .onClick(@actions.deleteItem, itemId: "@{item.id}")
                    }.padding(8)
                }
            }
        }
    }
}
```
