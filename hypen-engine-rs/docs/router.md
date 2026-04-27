# Router Component

The Router provides declarative, module-driven navigation for Hypen applications. Route matching and history management are handled at the host/module level, while the engine treats Router and Route as passthrough components.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [DSL Syntax](#dsl-syntax)
- [Module Integration](#module-integration)
- [Navigation Actions](#navigation-actions)
- [Route Guards](#route-guards)
- [Nested Routing](#nested-routing)
- [Platform Adapters](#platform-adapters)

---

## Overview

The Hypen router follows a **declarative route table** pattern. Routes are declared in the DSL, while navigation state and transitions are managed by the module system. This keeps the engine renderer-agnostic — the same route definitions work on web (browser history), mobile (native stacks), and remote UI.

**Key design decisions:**
- Router/Route are **passthrough components** in the engine — props are preserved but no template expansion occurs
- Navigation state lives in the module (`state.location`, `state.params`)
- Route matching, guards, and transitions are host-level concerns
- The engine emits the route tree; the platform renderer resolves which route to display

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Hypen DSL                                          │
│  Router(initialRoute: "/home") {                    │
│    Route(path: "/home") { HomeScreen() }            │
│    Route(path: "/users/:id") { UserProfile() }      │
│  }                                                  │
└──────────────┬──────────────────────────────────────┘
               │ Passthrough expansion
               ▼
┌─────────────────────────────────────────────────────┐
│  Engine IR                                          │
│  Router element with Route children preserved       │
│  Props: initialRoute, path, guard, etc.             │
└──────────────┬──────────────────────────────────────┘
               │ Patches
               ▼
┌─────────────────────────────────────────────────────┐
│  Platform Renderer                                  │
│  Matches state.location against Route paths          │
│  Renders matching Route's children                  │
│  Manages history (pushState, native stack, etc.)    │
└─────────────────────────────────────────────────────┘
```

## DSL Syntax

### Basic Route Table

```hypen
module AppShell() {
    Router(initialRoute: "/home") {
        Route(path: "/home") {
            HomeScreen()
        }

        Route(path: "/users/:id", guard: "@actions.ensureAuth") {
            UserLayout {
                UserProfile(userId: @{state.params.id})
            }
        }

        Route(path: "/settings") {
            SettingsPage()
        }

        Route.fallback {
            NotFoundScreen()
        }
    }
}
```

### Route Props

| Prop | Type | Description |
|------|------|-------------|
| `path` | String | URL pattern with optional `:param` segments |
| `guard` | Action ref | Async guard action called before entering the route |
| `exact` | Boolean | If true, only match the exact path (no prefix matching) |

### Router Props

| Prop | Type | Description |
|------|------|-------------|
| `initialRoute` | String | Default route on mount |

## Module Integration

The router is driven by module state. Your module defines the navigation state shape and action handlers for navigation.

### State Shape

```typescript
type RouterState = {
    location: string;
    params: Record<string, string>;
    query: Record<string, string>;
    historyLength: number;
};
```

### Module Definition

```typescript
import { app } from "@hypen-space/core";

type AppState = {
    location: string;
    params: Record<string, string>;
    historyLength: number;
    // ... your other state
};

export default app
    .defineState<AppState>(
        { location: "/home", params: {}, historyLength: 1 },
        { name: "AppShell", persist: true }
    )
    .onCreated((state) => {
        console.info("[router] mounted at", state.location);
    })
    .onAction("navigateToUser", ({ action, state }) => {
        state.location = `/users/${action.payload.id}`;
    })
    .onAction("back", ({ state }) => {
        // Platform adapter handles actual history.back()
        // State reflects the new location
    })
    .build();
```

### Accessing Route Params in DSL

Route parameters extracted from the URL pattern (e.g., `:id` in `/users/:id`) are available via `@{state.params}`:

```hypen
Route(path: "/users/:id") {
    Text("User ID: @{state.params.id}")
    UserProfile(userId: @{state.params.id})
}
```

## Navigation Actions

Navigation is triggered from the UI via standard action dispatch:

```hypen
// Navigate via action dispatch
Button("@actions.navigate", payload: { to: "/settings" }) {
    Text("Settings")
}

// Navigate with parameters
Button("@actions.navigateToUser", payload: { id: @{item.id} }) {
    Text(@{item.name})
}

// Go back
Button("@actions.back") {
    Text("Back")
}
```

The module handles these actions and updates `state.location`. The platform renderer then matches the new location against the route table and renders the appropriate children.

## Route Guards

Guards are async actions that run before a route is entered. They can allow, redirect, or block navigation.

```hypen
Route(path: "/admin", guard: "@actions.ensureAdmin") {
    AdminDashboard()
}
```

```typescript
.onAction("ensureAdmin", async ({ state }) => {
    const isAdmin = await checkAdminStatus();
    if (!isAdmin) {
        state.location = "/login"; // Redirect
    }
    // If no redirect, the route is allowed
})
```

## Nested Routing

Routes can contain child routers for tabbed or nested navigation:

```hypen
Route(path: "/settings") {
    SettingsRouter()
}
```

Where `SettingsRouter` is itself a module with its own route table:

```hypen
module SettingsRouter() {
    Column {
        // Tab bar
        Row {
            Button("@actions.navigate", payload: { to: "/settings/profile" }) {
                Text("Profile")
            }
            Button("@actions.navigate", payload: { to: "/settings/security" }) {
                Text("Security")
            }
        }

        // Nested routes
        Router {
            Route(path: "/settings/profile") { ProfileSettings() }
            Route(path: "/settings/security") { SecuritySettings() }
        }
    }
}
```

## Platform Adapters

The router is designed to work across platforms via pluggable adapters:

| Platform | Adapter | History Mechanism |
|----------|---------|-------------------|
| Web | Browser History | `window.history.pushState` |
| iOS | Native Stack | `UINavigationController` |
| Android | Native Stack | Jetpack Navigation / Activity stack |
| Remote UI | Server-side | State-driven, no client history |

Each adapter translates `state.location` changes into the appropriate platform navigation calls and synchronizes platform-initiated navigation (e.g., browser back button) back to the module state.

## Engine Internals

In the engine, Router and Route are registered as **passthrough components**:

```rust
Component::new("Router", |props| { /* ... */ })
    .with_passthrough(true)
```

This means:
- The engine preserves all Router/Route props in the IR
- Children are fully expanded (so child components like `HomeScreen()` are resolved)
- No template transformation occurs on the Router/Route themselves
- The reconciler treats them as regular nodes, passing props through to the renderer

The actual route matching and view switching is the renderer's responsibility, using the module's `state.location` to determine which Route children to display.
