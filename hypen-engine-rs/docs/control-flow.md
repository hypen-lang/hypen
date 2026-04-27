# Control Flow Components

Hypen provides first-class control flow constructs for iteration, conditional rendering, and pattern matching. Unlike regular components, these are part of the IR type system and receive special treatment during reconciliation.

## Table of Contents

- [ForEach](#foreach)
- [When](#when)
- [If](#if)
- [Map (Proposed)](#map-proposed)
- [Performance Tips](#performance-tips)

---

## ForEach

Iterates over an array from state and renders template children for each item.

### Syntax

```hypen
ForEach(items: @{state.todos}, as: "todo", key: "id") {
    Text(@{item.name})
}
```

### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `items` / `in` | Binding | Yes | — | Array binding from state (e.g., `@{state.todos}`) |
| `as` | String | No | `"item"` | Variable name for accessing each item |
| `key` | String | No | index | Property path used as stable key for reconciliation |

The first positional argument is treated as the `items` source if no named `items` or `in` argument is present.

Any additional props and applicators (e.g., `.padding()`, `.tw()`) are applied to the logical container.

### Item Access

Inside a ForEach, each item is accessible via bindings:

```hypen
// Default: use @{item.xxx} or @item.xxx
ForEach(items: @{state.users}) {
    Text(@{item.name})
    Text(text: @item.email)
}

// Custom variable name: use @{todo.xxx} in template strings
// but @item.xxx in reference syntax
ForEach(items: @{state.todos}, as: "todo") {
    Text("@{todo.name}: @{todo.status}")
    Text(text: @item.description)
}

// Access the whole item object
ForEach(items: @{state.items}) {
    MyComponent(data: @item)
}
```

### Keyed vs. Unkeyed

Providing a `key` prop enables stable identity across re-renders. Without a key, items are matched by index which can cause incorrect reuse when the array is reordered.

```hypen
// GOOD: Keyed — items tracked by unique ID
ForEach(items: @{state.todos}, key: "id") {
    TodoRow(todo: @{item})
}

// BAD: Unkeyed — index-based matching, broken on reorder
ForEach(items: @{state.todos}) {
    TodoRow(todo: @{item})
}
```

### How It Works

1. The engine evaluates the `items` binding against module state to get the array.
2. A transparent control flow node (`__ForEach`) is created as a logical parent. This node does not produce a DOM element.
3. For each array element:
   - A stable key is generated using `key_path` (or defaults to `{item_name}-{index}`).
   - `@{item.*}` bindings in template children are replaced with the actual item data.
   - Children are created with the ForEach's grandparent as their render target.
4. On state change, the array is re-evaluated. Items are matched by key, and the engine reconciles, creates, or removes children as needed using the keyed diffing algorithm.

### Real-World Example

```hypen
// Messenger app — rendering a list of messages
Column {
    ForEach(items: @{state.messages}, key: "id") {
        MessageBubble(
            message: @{item},
            isOwn: "@{item.sender_id == currentUser.id}"
        )
    }
}
.padding(16)
.gap(4)
```

---

## When

Pattern-matching conditional that renders the branch whose `Case` matches the provided value.

### Syntax

```hypen
When(value: @{state.status}) {
    Case(match: "loading") { Spinner() }
    Case(match: "error") { ErrorBanner(message: @{state.error}) }
    Case(match: "success") { ContentView() }
    Else { Text("Unknown status") }
}
```

### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `value` / `condition` | Value | Yes | — | The value to match against (binding or static) |

The first positional argument is used as the value if no named argument is present.

### Children

When expects `Case` and (optionally) `Else` children:

| Child | Props | Description |
|-------|-------|-------------|
| `Case` | `match: <pattern>` | Rendered if the pattern matches the value |
| `Else` | — | Fallback rendered if no Case matches |

The `match` prop can be a string, number, boolean, or list of values for OR-matching.

### Pattern Types

```hypen
// String matching
When(value: @{state.status}) {
    Case(match: "loading") { Spinner() }
    Case(match: "error") { ErrorBanner() }
    Else { ContentView() }
}

// Multi-value matching (OR)
When(value: @{state.httpCode}) {
    Case(match: [200, 201, 204]) { Text("Success") }
    Case(match: [400, 401, 403, 404]) { Text("Client Error") }
    Case(match: [500, 502, 503]) { Text("Server Error") }
}

// Expression matching
When(value: @{state.score}) {
    Case(match: "@{value >= 90}") { Text("Grade A") }
    Case(match: "@{value >= 80}") { Text("Grade B") }
    Else { Text("Needs Improvement") }
}

// Wildcard
When(value: @{state.value}) {
    Case(match: "specific") { Text("Matched specific") }
    Case(match: "_") { Text("Matched anything else") }
}
```

### How It Works

1. The engine evaluates the condition `value` against state.
2. A transparent `__Conditional` control flow node is created.
3. The value is compared against each `Case` pattern in order.
4. The first matching branch's children are rendered.
5. If no branch matches and an `Else` is present, the fallback is rendered.
6. On state change, the condition is re-evaluated. If the matching branch changes, old branch children are removed and new branch children are created.

### Real-World Example

```hypen
// Show different UI based on loading state
Column {
    When(condition: @{state.isLoading}) {
        Column {
            Spinner()
            Text("Loading messages...")
                .color("#65676b")
        }
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }
    Otherwise {
        ForEach(items: @{state.messages}, key: "id") {
            MessageBubble(message: @{item})
        }
    }
}
```

> **Note:** `Otherwise` is an alias for `Else` in some contexts.

---

## If

Boolean conditional rendering. Syntactic sugar over `When` for the common case of true/false branching.

### Syntax

```hypen
If(condition: @{state.isLoggedIn}) {
    ProfileCard(user: @{state.user})
    Else {
        SignInPrompt()
    }
}
```

### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `condition` / `when` | Value | Yes | — | Boolean binding or expression |

The first positional argument is used as the condition if no named argument is present.

### Children

- **Then-block**: All direct children except `Else` are rendered when the condition is truthy.
- **Else-block**: The `Else` child (if present) is rendered when the condition is falsy.

### Examples

```hypen
// Simple boolean
If(condition: @{state.isLoggedIn}) {
    Text("Welcome back!")
    Else {
        Text("Please sign in")
    }
}

// With binding expression
If(condition: "@{state.items.length > 0}") {
    ForEach(items: @{state.items}, key: "id") {
        ItemRow(item: @{item})
    }
    Else {
        Text("No items yet")
    }
}

// Without Else
If(condition: @{state.showBanner}) {
    Banner(text: "New feature available!")
}

// Conditional send button
When(condition: "@{state.messageInput.trim().length > 0}") {
    Button {
        Text("Send")
    }
    .onClick("@actions.sendMessage")
}
Otherwise {
    Button {
        Text("👍")
    }
    .onClick("@actions.sendLike")
}
```

### How It Works

`If` is converted to `IRNode::Conditional` with a single branch matching `true`. The else children become the fallback. This means `If` and `When` share the same reconciliation logic.

---

## Map (Proposed)

> **Status:** Proposed — not yet implemented. See [ANALYSIS.md](../../ANALYSIS.md) for the design proposal.

Map is envisioned as a transformation layer over collections before rendering. It would execute a transformation function (referenced by name) over a source array before passing results to child templates.

### Proposed Syntax

```hypen
Map(source: @{state.items}, select: "@actions.groupByCategory", as: "group") {
    CategorySection(group: @{group})
}
```

### Proposed Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `source` | Binding | Yes | Array binding to transform |
| `select` | Action ref | Yes | Transformation function (module action or SDK helper) |
| `as` | String | No | Variable name for transformed results |

### Workaround

Until Map is implemented, you can perform transformations in your module logic before setting state:

```typescript
// In your module
.onAction("loadItems", async ({ state }) => {
    const items = await fetchItems();
    state.groupedItems = groupByCategory(items);
})
```

```hypen
// In your template
ForEach(items: @{state.groupedItems}, key: "category") {
    CategorySection(group: @{item})
}
```

---

## Performance Tips

### Always Use Keys for Dynamic Lists

Keys enable the LIS (Longest Increasing Subsequence) algorithm to minimize DOM moves during reconciliation. Without keys, the engine falls back to index-based matching which causes full re-renders on reorder.

```hypen
// O(n+m) with keys — minimal patches
ForEach(items: @{state.items}, key: "id") {
    ItemRow(item: @{item})
}

// O(n×m) without keys — many unnecessary patches
ForEach(items: @{state.items}) {
    ItemRow(item: @{item})
}
```

### Keep State Paths Shallow

The dependency graph tracks bindings by string path. Deeply nested paths generate more prefix-index entries and slow down affected-node lookups.

```hypen
// Prefer flat paths
Text(@{state.userName})

// Avoid deep nesting when possible
Text(@{state.user.profile.settings.display.name})
```

### Control Flow Nodes Are Transparent

ForEach and When/If nodes don't create DOM elements. Their children render directly into the parent container. This means you can nest control flow without adding extra wrapper elements to the DOM.
