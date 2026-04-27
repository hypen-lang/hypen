# Advanced SDK Usage

This guide covers advanced topics for SDK authors and developers integrating the Hypen Engine into custom platforms.

## Table of Contents

- [Custom Renderers](#custom-renderers)
- [Component Resolvers](#component-resolvers)
- [Custom Applicators](#custom-applicators)
- [Extending the Engine](#extending-the-engine)
- [Remote UI Integration](#remote-ui-integration)
- [Lifecycle Hooks](#lifecycle-hooks)

---

## Custom Renderers

The engine is renderer-agnostic. All renderers receive the same `Patch` stream and translate it into platform-specific operations.

### Implementing a Renderer

A renderer must handle nine patch types:

```typescript
function applyPatch(patch: Patch) {
    switch (patch.type) {
        case "create":
            // Create a platform element
            // patch.id, patch.elementType, patch.props
            const element = createPlatformElement(patch.elementType);
            setElementProps(element, patch.props);
            nodeMap.set(patch.id, element);
            break;

        case "setProp":
            // Update a single property
            // patch.id, patch.name, patch.value
            const node = nodeMap.get(patch.id);
            setProperty(node, patch.name, patch.value);
            break;

        case "removeProp":
            // Revert a property to its default
            // patch.id, patch.name
            removeProperty(nodeMap.get(patch.id), patch.name);
            break;

        case "setText":
            // Update text content
            // patch.id, patch.text
            // Reserved for future use — the engine currently emits text
            // updates as `setProp` with `name: "0"` (the positional text
            // slot). Renderers must still handle this branch for forward
            // compatibility.
            nodeMap.get(patch.id).textContent = patch.text;
            break;

        case "insert":
            // Insert node into parent
            // patch.parentId, patch.id, patch.beforeId
            const parent = patch.parentId === "root"
                ? rootContainer
                : nodeMap.get(patch.parentId);
            const child = nodeMap.get(patch.id);
            const before = patch.beforeId ? nodeMap.get(patch.beforeId) : null;
            parent.insertBefore(child, before);
            break;

        case "move":
            // Move node to new position (same as insert)
            // patch.parentId, patch.id, patch.beforeId
            const moveParent = nodeMap.get(patch.parentId);
            const moveChild = nodeMap.get(patch.id);
            const moveBefore = patch.beforeId ? nodeMap.get(patch.beforeId) : null;
            moveParent.insertBefore(moveChild, moveBefore);
            break;

        case "remove":
            // Remove node from tree and clean up
            // patch.id
            const removed = nodeMap.get(patch.id);
            removed.parentNode?.removeChild(removed);
            nodeMap.delete(patch.id);
            break;

        case "detach":
            // Unlink a subtree from its parent but keep the native element
            // alive. Used by the ManagedRouter subtree cache — a later
            // `attach` reinserts the same node under the same id, so event
            // listeners, scroll position, and DOM form state are preserved.
            // Simple renderers may treat this as `remove` at the cost of
            // losing the route-cache optimization.
            // patch.id
            const detached = nodeMap.get(patch.id);
            detached.parentNode?.removeChild(detached);
            // Do NOT delete from nodeMap — the element will be reattached.
            break;

        case "attach":
            // Reinsert a previously-detached subtree under the same id.
            // patch.parentId, patch.id, patch.beforeId
            const attachParent = patch.parentId === "root"
                ? rootContainer
                : nodeMap.get(patch.parentId);
            const attachChild = nodeMap.get(patch.id);
            const attachBefore = patch.beforeId ? nodeMap.get(patch.beforeId) : null;
            attachParent.insertBefore(attachChild, attachBefore);
            break;
    }
}
```

### Event Handling

Events are handled at the renderer level, not in the engine. When creating elements, inspect props for action references and attach event listeners:

```typescript
function setElementProps(element: PlatformElement, props: Record<string, any>) {
    for (const [key, value] of Object.entries(props)) {
        if (key.startsWith("on") && typeof value === "string" && value.startsWith("@actions.")) {
            // This is an event handler prop
            const actionName = value.replace("@actions.", "");
            const eventName = key.slice(2).toLowerCase(); // onClick → click
            element.addEventListener(eventName, (event) => {
                engine.dispatchAction(actionName, { event });
            });
        } else {
            // Regular prop
            applyProperty(element, key, value);
        }
    }
}
```

### Renderer Registration

Connect your renderer to the engine via the render callback:

```typescript
// WASM
const engine = new WasmEngine();
engine.setRenderCallback((patchesJson: string) => {
    const patches = JSON.parse(patchesJson);
    for (const patch of patches) {
        applyPatch(patch);
    }
});

// Rust
let mut engine = Engine::new();
engine.set_render_callback(|patches| {
    for patch in patches {
        apply_patch(&patch);
    }
});
```

### Existing Renderers

| Renderer | Location | Platform |
|----------|----------|----------|
| DOM | `hypen-web/packages/web/src/dom/` | Browser (HTML elements) |
| Canvas | `hypen-web/packages/web/src/canvas/` | Browser (Canvas 2D) |
| Android | `hypen-renderer-android/` | Android (Kotlin/Compose) |
| iOS | `hypen-renderer-swift/` | iOS (SwiftUI views) |

---

## Component Resolvers

Component resolvers enable dynamic, file-based component discovery. When the engine encounters a component name it doesn't recognize, it calls the resolver.

### Setting a Resolver

```typescript
engine.setComponentResolver((name: string, context?: string) => {
    // name: component name (e.g., "ProfileCard")
    // context: path of the file referencing this component

    const filePath = resolveComponentPath(name, context);
    if (!filePath) return null;

    const source = readFileSync(filePath, "utf-8");
    return {
        source,                    // Hypen DSL source code
        path: filePath,            // Absolute path (used for resolving nested components)
        passthrough: false,        // If true, skip template expansion
        lazy: false,               // If true, defer child expansion
    };
});
```

### Resolution Order

1. Check built-in primitives (Text, Column, Row, etc.)
2. Check registered components (`engine.register_component()`)
3. Call the component resolver callback
4. If still unresolved, treat as a primitive (pass through to renderer)

### Passthrough Components

Mark components as passthrough when the engine should preserve their structure without template expansion. This is used for platform-specific components (Router, Route) and host-managed components:

```typescript
return {
    source: "",
    path: filePath,
    passthrough: true,
    lazy: false,
};
```

### Lazy Components

Lazy components defer child expansion until explicitly requested. This enables code splitting:

```typescript
return {
    source,
    path: filePath,
    passthrough: false,
    lazy: true,    // Children not expanded until renderLazyComponent() is called
};
```

To render lazy children later:

```typescript
engine.renderLazyComponent(lazyComponentSource);
```

---

## Custom Applicators

Applicators are the `.method(value)` chained calls on components. They are converted to props during IR expansion.

### How Applicators Become Props

```hypen
Text("Hello")
    .fontSize(18)
    .color("blue")
    .padding(16, 8)
```

Becomes these props:

```json
{
    "0": "Hello",
    "fontSize.0": 18,
    "color.0": "blue",
    "padding.0": 16,
    "padding.1": 8
}
```

The naming convention is `{applicatorName}.{argIndex}` for positional arguments and `{applicatorName}.{argName}` for named arguments.

### Tailwind Applicator

The `.tw()` applicator receives special handling. Instead of becoming a prop, it is expanded into individual CSS properties:

```hypen
Text("Hello").tw("p-4 text-blue-500 md:p-8 hover:bg-white")
```

Expands to:

```json
{
    "padding": "1rem",
    "color": "#3b82f6",
    "padding@md": "2rem",
    "background-color:hover": "#ffffff"
}
```

Variant notation:
- `@` suffix for responsive breakpoints: `padding@md`, `padding@lg`
- `:` suffix for state variants: `background-color:hover`, `color:focus`

### Handling Applicators in Renderers

Your renderer maps applicator props to platform-specific styling:

```typescript
function applyProperty(element: HTMLElement, key: string, value: any) {
    // Check for variant suffix
    if (key.includes("@")) {
        const [prop, breakpoint] = key.split("@");
        addResponsiveStyle(element, breakpoint, prop, value);
    } else if (key.includes(":")) {
        const [prop, state] = key.split(":");
        addStateStyle(element, state, prop, value);
    } else if (key.includes(".")) {
        const [applicator, arg] = key.split(".");
        applyApplicator(element, applicator, arg, value);
    } else {
        element.style[key] = value;
    }
}
```

---

## Extending the Engine

### Registering Components (Rust)

```rust
use hypen_engine::ir::{Component, Element, Value};

let component = Component::new("Badge", |props| {
    let text = props.get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("badge");

    Element::new("Text")
        .with_prop("text".to_string(), Value::Static(serde_json::json!(text)))
        .with_prop("backgroundColor".to_string(), Value::Static(serde_json::json!("#eee")))
        .with_prop("padding".to_string(), Value::Static(serde_json::json!("4px 8px")))
        .with_prop("borderRadius".to_string(), Value::Static(serde_json::json!("12px")))
});

engine.register_component(component);
```

### Registering Primitives (WASM)

Primitives are element types the engine should pass through without resolution:

```typescript
engine.registerPrimitive("div");
engine.registerPrimitive("span");
engine.registerPrimitive("canvas");
```

### Action Handlers

Register handlers for actions dispatched from the UI:

```typescript
engine.onAction("increment", (action) => {
    const current = getState().count;
    engine.updateState({ count: current + 1 });
});

engine.onAction("fetchUser", async (action) => {
    const user = await api.getUser(action.payload.id);
    engine.updateState({ user });
});
```

### Render Into (Sub-tree Rendering)

Render a component into a specific node in the existing tree:

```typescript
engine.renderInto(source, parentNodeId, state);
```

This is useful for portals, overlays, or dynamically loaded sections.

---

## Remote UI Integration

The engine supports a client-server streaming protocol for Remote UI scenarios where the engine runs on a server and the renderer runs on a client.

### Protocol Messages

| Direction | Type | Description |
|-----------|------|-------------|
| Server → Client | `initialTree` | Full tree serialization on connect |
| Server → Client | `stateUpdate` | State patch |
| Server → Client | `patch` | Incremental DOM patches |
| Client → Server | `dispatchAction` | Action dispatch from user interaction |

### Message Format

```json
// Server → Client: Initial tree
{
    "type": "initialTree",
    "module": "ProfilePage",
    "state": { "user": null },
    "patches": [...],
    "revision": 0
}

// Server → Client: Incremental update
{
    "type": "patch",
    "module": "ProfilePage",
    "patches": [
        { "type": "setProp", "id": "n1", "name": "text", "value": "Alice" }
    ],
    "revision": 42
}

// Client → Server: User action
{
    "type": "dispatchAction",
    "module": "ProfilePage",
    "action": "signIn",
    "payload": { "provider": "google" }
}
```

### Revision Tracking

Each patch message includes a monotonically increasing revision number. Clients should:
1. Track the last applied revision
2. Apply patches in order
3. Request a full tree refresh if revisions are out of sync

```typescript
let lastRevision = 0;

function handlePatch(message) {
    if (message.revision !== lastRevision + 1) {
        requestFullRefresh();
        return;
    }
    applyPatches(message.patches);
    lastRevision = message.revision;
}
```

### WebSocket Integration Example

```typescript
const ws = new WebSocket("wss://app.example.com/ui");

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
        case "initialTree":
            initializeTree(message.patches);
            break;
        case "patch":
            applyPatches(message.patches);
            break;
        case "stateUpdate":
            updateLocalState(message.state);
            break;
    }
};

// Forward user actions to server
function dispatchAction(name: string, payload: any) {
    ws.send(JSON.stringify({
        type: "dispatchAction",
        module: currentModule,
        action: name,
        payload,
    }));
}
```

---

## Lifecycle Hooks

### Module Lifecycle

| Hook | Trigger | Signature |
|------|---------|-----------|
| `onCreated` | Module instance created | `(state, context?) => void` |
| `onDestroyed` | Module instance destroyed | `(state, context?) => void` |
| `onAction` | Action dispatched | `({ action, state, next, context }) => void` |

```typescript
import { app } from "@hypen-space/core";

export default app
    .defineState({ count: 0 })
    .onCreated((state) => {
        // Initialize: fetch data, set up subscriptions
    })
    .onAction("increment", ({ state }) => {
        state.count += 1;
        // State mutations are auto-tracked via Proxy
    })
    .onDestroyed((state) => {
        // Cleanup: cancel subscriptions, save state
    })
    .build();
```

### Component Lifecycle

Components follow a mount/unmount lifecycle tied to the instance tree:

- **Mount**: When a `Create` + `Insert` patch pair is generated
- **Unmount**: When a `Remove` patch is generated
- **Update**: When `SetProp` or `SetText` patches are generated

The engine tracks these transitions internally. Renderers can use the patch stream to run platform-specific lifecycle callbacks (e.g., animation on mount/unmount).

### Resource Cache

The engine includes a resource cache for shared assets:

```rust
// Access the cache
let resources = engine.resources();
let image = resources.get("avatar_url");

// Or mutably
let resources = engine.resources_mut();
resources.insert("avatar_url", image_data);
```

This is used for images, fonts, and other assets that should be shared across component instances.
