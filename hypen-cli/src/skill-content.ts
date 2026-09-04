export const SKILL_CONTENT = `---
name: hypen-ui
description: Build cross-platform UI with the Hypen declarative language. Covers all components, applicators, modules, state, actions, control flow, and styling.
---

# Building UI with Hypen

You are an expert in writing Hypen DSL templates and TypeScript module logic. Hypen is a declarative UI language where templates (\`.hypen\` files) define structure and styling, while modules (\`.ts\` files) manage state and business logic. The engine produces platform-agnostic patches that renderers (DOM, Canvas, iOS, Android) apply.

## File Structure

Hypen projects organize components as paired files:

\`\`\`
src/components/
  ComponentName/
    component.hypen    # UI template
    component.ts       # State & logic (module)
\`\`\`

## Hypen DSL Syntax

### Components

Components are the building blocks. They accept arguments (positional or named), can have children in \`{}\`, and are styled with applicators (\`.method()\`).

\`\`\`hypen
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
\`\`\`

### Value Types

\`\`\`hypen
// Strings (double or single quotes, escapes supported)
Text("Hello \\"world\\"")
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
"@{state.foods.length}"                             // Array length
"@{state.foods.length == 0 ? 'empty' : 'has items'}"   // Array empty check
"@{state.tags.includes('admin') ? 'yes' : 'no'}"       // Array membership
\`\`\`

**Supported inside \`@{…}\`:** literals, identifier paths (\`state.x\`, \`item.y\`, data-source names), numeric/boolean/string operators (\`+\`, \`-\`, \`*\`, \`/\`, \`%\`, \`==\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`&&\`, \`||\`, \`!\`), ternary (\`cond ? a : b\`), the \`.length\` property on arrays, and the \`.includes(x)\` method on arrays. Reactivity tracks the root path (\`state.foods\`) so mutating the array re-evaluates the expression automatically — no need to expose a derived \`isEmpty\` boolean on state.

**Not supported:** other array/string methods (\`.map\`, \`.filter\`, \`.find\`, \`.first\`, \`.last\`, \`.at\`, \`.indexOf\`, \`.slice\`, \`.join\`, …), bracket indexing (\`foo[0]\`), function calls, spread/rest, object/array literals, optional chaining (\`?.\`), nullish coalescing (\`??\`), exponent (\`**\`), \`typeof\`, \`Math.*\`. When you need any of those, compute the value in the module (\`@actions.*\` handler) and store the result in state.

### Comments

\`\`\`hypen
// Single-line comment
/* Block comment */
\`\`\`

### Imports

\`\`\`hypen
import { Button, Card } from "./components/ui"
import HomePage from "./pages/HomePage"
\`\`\`

## Built-in Components

### Layout Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Column\` | Vertical flex container | gap, align | Yes |
| \`Row\` | Horizontal flex container | gap, align | Yes |
| \`Box\` / \`Container\` | Generic container with z-stacking | - | Yes |
| \`Center\` | Centers children both axes | - | Yes |
| \`Stack\` | Z-axis stacking for overlapping | - | Yes |
| \`Grid\` | CSS Grid layout | columns | Yes |
| \`List\` | Scrollable container | items (binding) | Yes |
| \`Spacer\` | Flexible empty space | width, height | No |
| \`Divider\` | Visual separator line | - | No |

### Content Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Text\` | Display text | text/"0" (positional) | No |
| \`Heading\` | Heading text | text/"0" | No |
| \`Paragraph\` | Paragraph text | text/"0" | No |
| \`Image\` | Display image | src, alt | No |

### Interactive Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Button\` | Clickable button | onClick | Yes (label content) |
| \`Input\` | Single-line text input | placeholder, type, value | No |
| \`Textarea\` | Multi-line text input | placeholder, value | No |
| \`Checkbox\` | Toggle checkbox | checked | No |
| \`Switch\` | Toggle switch | on | No |
| \`Select\` | Dropdown selector | value, options | No |
| \`Slider\` | Range slider | min, max, value | No |
| \`Link\` | Navigation link | href | Yes |

### Display Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Card\` | Elevated container | - | Yes |
| \`Badge\` | Small label indicator | text, color | No |
| \`Avatar\` | User avatar | src, size | No |
| \`Spinner\` | Loading indicator | - | No |
| \`ProgressBar\` | Progress indicator | value | No |

### Media Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Video\` | Video player (single src or playlist with auto-advance) | src, playlist, poster, controls, title, onEnded, onError | No |
| \`Audio\` | Audio player | src | No |

### Navigation Components

| Component | Description | Key Props | Has Children |
|-----------|-------------|-----------|-------------|
| \`Router\` | Routing container | initialRoute | Yes (Route children) |
| \`Route\` | Route definition | path | Yes |
| \`HypenApp\` | Embed remote Hypen app | - | No |

## Control Flow

### ForEach - Iterate Over Lists

\`\`\`hypen
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
\`\`\`

**Important:** Always provide \`key\` for dynamic lists (a unique identifier field). \`@item\` references the current iteration element. Inside ForEach, use \`@{item.fieldName}\` to access item properties.

### If - Boolean Conditionals

\`\`\`hypen
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
\`\`\`

### When/Case - Pattern Matching

\`\`\`hypen
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
\`\`\`

## Applicators Reference

Applicators are chained with dot notation after components. Any unrecognized applicator name is applied as a CSS property (camelCase auto-converts to kebab-case). Numeric values get \`px\` units automatically (except unitless properties like opacity, z-index, flex, font-weight, line-height).

### Spacing

\`\`\`hypen
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
\`\`\`

### Size

\`\`\`hypen
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
\`\`\`

### Typography

\`\`\`hypen
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
\`\`\`

### Colors

\`\`\`hypen
.color("#333")                   // Text color
.color("rgb(100, 150, 200)")
.backgroundColor("#F3F4F6")
.backgroundColor("rgba(0,0,0,0.5)")
.opacity(0.8)
\`\`\`

### Borders

\`\`\`hypen
.border("1px solid #E5E7EB")    // CSS shorthand
.borderWidth(1)
.borderColor("#D1D5DB")
.borderStyle("dashed")          // solid, dashed, dotted
.borderRadius(8)
.borderRadius("8px 8px 0 0")   // Per-corner
.borderTop(1)
.borderBottom(1)
.cornerRadius(12)               // Alias for borderRadius
\`\`\`

### Layout

\`\`\`hypen
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
\`\`\`

### Grid

\`\`\`hypen
.gridColumns(3)
.gridTemplateColumns("1fr 2fr 1fr")
.gridColumn("span 2")
\`\`\`

### Effects

\`\`\`hypen
.boxShadow("0 4px 12px rgba(0, 0, 0, 0.1)")
.shadow(blur: 10, spread: 2, color: "rgba(0,0,0,0.15)")
.blur(4)
.filter("brightness(1.2)")
.backdropFilter("blur(10px)")
.transform("rotate(45deg)")
.transition("all 0.2s ease")
.cursor("pointer")
\`\`\`

### Events

\`\`\`hypen
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
\`\`\`

### Two-Way Binding

\`.bind()\` creates automatic two-way sync between a form element and state. No action handler needed.

\`\`\`hypen
Input(placeholder: "Name").bind(@state.name)
Textarea(placeholder: "Bio").bind(@state.bio)
Checkbox {}.bind(@state.agreed)
Switch {}.bind(@state.darkMode)
Select {}.bind(@state.country)
\`\`\`

### Tailwind CSS Support

\`\`\`hypen
.tw("p-4 text-blue-500 rounded-xl bg-white")
.tw("flex items-center justify-center gap-4")
.tw("text-sm md:text-base lg:text-lg")              // Responsive
.tw("bg-blue-500 hover:bg-blue-600")                // State variants
\`\`\`

### Responsive & State Variants

Any applicator accepts a map for responsive breakpoints or interaction states:

\`\`\`hypen
// Responsive breakpoints: default (0px), sm (640px), md (768px), lg (1024px), xl (1280px), 2xl (1536px)
.fontSize({default: 14, md: 18, lg: 24})
.padding({default: 8, md: 16, lg: 32})
.width({default: "100%", md: "50%", lg: "33%"})

// Interaction states: hover, focus, active, disabled, focus-visible, focus-within
.backgroundColor({default: "#3B82F6", hover: "#2563EB", active: "#1D4ED8"})
.borderColor({default: "#D1D5DB", focus: "#3B82F6"})
\`\`\`

## Module System (TypeScript)

Modules manage state and handle actions. They pair with \`.hypen\` template files.

\`\`\`typescript
import { app } from "@hypen-space/core";

// Define state type
interface AppState {
  count: number;
  items: { id: string; text: string; done: boolean }[];
  input: string;
  isLoading: boolean;
}

export default app
  // Define initial state shape and values
  .defineState<AppState>({
    count: 0,
    items: [],
    input: "",
    isLoading: false,
  })

  // Lifecycle: runs once when module mounts
  .onCreated(async (state, context?) => {
    // Fetch initial data, set defaults
    state.items = await fetchItems();
  })

  // Action handlers: respond to UI events
  .onAction("increment", async ({ state }) => {
    state.count++;  // Proxy auto-tracks mutations
  })

  // Typed payload from UI events
  .onAction<{ id: string }>("removeItem", async ({ action, state }) => {
    const id = action.payload!.id;
    state.items = state.items.filter(item => item.id !== id);
  })

  // Async actions
  .onAction("loadData", async ({ state }) => {
    state.isLoading = true;
    try {
      const data = await fetch("/api/data").then(r => r.json());
      state.items = data;
    } finally {
      state.isLoading = false;
    }
  })

  // Lifecycle: runs when module unmounts
  .onDestroyed((state, context?) => {
    // Cleanup timers, connections
  })

  .build();
\`\`\`

### Key Rules

- **State mutations are auto-tracked** via Proxy. Just assign values directly - no \`setState()\` or sync callback needed.
- **Actions are async** - use \`async/await\` freely for API calls.
- **Action payloads** come from UI event arguments: \`.onClick(@actions.remove, id: "@{item.id}")\` delivers \`action.payload.id\`.
- **\`context.router\`** provides \`HypenRouter\` for programmatic navigation.
- **\`context.getModule<T>("name")\`** for cross-module communication.

## Complete Examples

### Counter

**component.hypen:**
\`\`\`hypen
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
\`\`\`

**component.ts:**
\`\`\`typescript
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
\`\`\`

### Todo List

**component.hypen:**
\`\`\`hypen
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
\`\`\`

**component.ts:**
\`\`\`typescript
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
\`\`\`

### Chat App with API

**component.hypen:**
\`\`\`hypen
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
\`\`\`

### Routing

**component.hypen:**
\`\`\`hypen
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
\`\`\`

## Common Patterns

### Loading states
\`\`\`hypen
When(value: @state.status) {
  Case(match: "loading") { Center { Spinner() } }
  Case(match: "error") { Text("Error: @{state.errorMessage}").color("#EF4444") }
  Case(match: "loaded") { ContentView() }
}
\`\`\`

### Conditional styling (prefer expressions over If)
\`\`\`hypen
Text("@{item.text}")
  .color("@{item.active ? '#3B82F6' : '#6B7280'}")
  .fontWeight("@{item.active ? 'bold' : 'normal'}")
\`\`\`

### Action payloads
\`\`\`hypen
// Pass data with action
Button { Text("Delete") }
  .onClick(@actions.delete, id: "@{item.id}", name: "@{item.name}")

// Receive in handler
.onAction<{ id: string; name: string }>("delete", async ({ action, state }) => {
  const { id, name } = action.payload!;
})
\`\`\`

### Mixing Tailwind + applicators
\`\`\`hypen
Column {
  Text("Hello")
    .tw("text-xl font-bold text-gray-900")  // Tailwind for utility classes
    .marginBottom(16)                         // Applicators for precise values
}
.tw("p-6 bg-white rounded-xl shadow-lg")
\`\`\`

## Rules & Gotchas

1. **Component names are case-insensitive** in the renderer (Text = text), but use PascalCase by convention.
2. **Applicators go after children**, not before: \`Column { children }.padding(16)\` is correct.
3. **Bare numbers become px** in CSS properties, except unitless ones (opacity, z-index, flex, font-weight, line-height, flex-grow, flex-shrink, order).
4. **Any unknown applicator** falls through to CSS: \`.wordBreak("break-word")\`, \`.cursor("pointer")\` just work.
5. **\`@{state.xxx}\`** resolves against the active module's state. Cross-module state requires explicit prop passing or context.
6. **Always use \`key\` in ForEach** for lists that change dynamically.
7. **\`.bind()\` only works with \`@state.*\`**, not \`@item.*\`. Use it on Input, Textarea, Checkbox, Switch, Select.
8. **Action payloads** are passed as additional named arguments on event applicators, not wrapped in \`{payload: ...}\`.
9. **Trailing commas are allowed** in argument lists: \`Component(a: 1, b: 2,)\`.
10. **Single and double quotes** both work for strings. Single quotes allow embedding double quotes without escaping.
`;
