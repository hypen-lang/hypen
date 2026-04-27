# Hypen Tooling Guide

This document explains the development tooling for building Hypen applications. The tooling provides a zero-config developer experience while maintaining flexibility for advanced use cases.

## Overview

The Hypen tooling consists of:

1. **Bun Plugin** (`src/plugin.ts`) - Auto-pairs `.hypen` and `.ts` files during import
2. **Component Discovery** (`src/discovery.ts`) - Automatically finds components in directories
3. **Dev Server & Build** (`src/dev.ts`) - Zero-config development server and production builds
4. **CLI** (`bin/hypen.ts`) - Command-line interface for common tasks

## File-Based Component Architecture

Hypen separates UI templates from business logic:

```
components/
├── Counter/
│   ├── component.ts       # State & actions (TypeScript)
│   └── component.hypen    # UI template (Hypen DSL)
├── Header/
│   ├── component.ts
│   └── component.hypen
└── Footer/
    └── component.hypen    # Stateless (no .ts file needed)
```

### Supported Naming Conventions

| Pattern | Structure | Use Case |
|---------|-----------|----------|
| **Folder** | `Name/component.ts` + `Name/component.hypen` | Recommended for most components |
| **Sibling** | `Name.ts` + `Name.hypen` | Simple single-file components |
| **Index** | `Name/index.ts` + `Name/index.hypen` | Alternative folder pattern |

## Component Files

### TypeScript Module (`component.ts`)

Defines state and actions using the `app` builder:

```typescript
import { app } from "@hypen-space/core";

type CounterState = {
  count: number;
};

export default app
  .defineState<CounterState>({ count: 0 })
  .onCreated((state) => {
    console.log("Counter created");
  })
  .onAction("increment", ({ state }) => {
    state.count++;
  })
  .onAction("decrement", ({ state }) => {
    state.count--;
  })
  .build();
```

### Hypen Template (`component.hypen`)

Defines the UI structure with declarative syntax:

```hypen
module Counter {
  Column {
    Text("Count: @{state.count}")
      .fontSize(32)
      .fontWeight("bold")

    Row {
      Button { Text("-") }
        .onClick("@actions.decrement")

      Button { Text("+") }
        .onClick("@actions.increment")
    }
    .gap(16)
  }
  .padding(24)
  .horizontalAlignment("center")
}
```

## CLI Commands

### Initialize a New Project

```bash
hypen init my-app
cd my-app
bun install
bun run dev
```

This creates:
- `hypen.json` - Configuration file
- `src/components/App/` - Starter component
- `package.json` - With dev/build scripts
- `tsconfig.json` - TypeScript configuration

### Development Server

```bash
hypen dev
# or with options
hypen dev --port 3000 --debug
```

Features:
- Auto-discovers components from configured directory
- Hot module reloading
- On-the-fly TypeScript transpilation
- Generates component imports automatically

### Production Build

```bash
hypen build
# or with options
hypen build --outDir dist --minify --sourcemap
```

Outputs:
- `dist/main.js` - Bundled application
- `dist/index.html` - HTML entry point

### Generate Component Imports

```bash
hypen generate
```

Creates `.hypen/components.generated.ts` with all component imports.

## Configuration

### `hypen.json`

```json
{
  "components": "./src/components",
  "entry": "App",
  "port": 3000,
  "outDir": "dist"
}
```

## Programmatic API

### Component Discovery

```typescript
import { discoverComponents, loadDiscoveredComponents } from "@hypen-space/core";

// Discover all components
const discovered = await discoverComponents("./src/components", {
  patterns: ["folder", "sibling", "index"],
  recursive: false,
  debug: false,
});

console.log(`Found ${discovered.length} components`);

// Load them for use
const components = await loadDiscoveredComponents(discovered);
```

### Watch for Changes

```typescript
import { watchComponents } from "@hypen-space/core";

const watcher = watchComponents("./src/components", {
  onChange: (components) => {
    console.log("Components changed:", components.map(c => c.name));
  },
  onAdd: (component) => {
    console.log("Added:", component.name);
  },
  onRemove: (name) => {
    console.log("Removed:", name);
  },
});

// Later: stop watching
watcher.stop();
```

### Dev Server API

```typescript
import { hypen } from "@hypen-space/core";

// Start dev server
const { url, stop } = await hypen.dev({
  components: "./src/components",
  entry: "App",
  port: 3000,
  hot: true,
  debug: false,
  onStart: (url) => console.log(`Server at ${url}`),
});

// Build for production
await hypen.build({
  components: "./src/components",
  entry: "App",
  outDir: "dist",
  minify: true,
});
```

## Bun Plugin

For advanced use cases, you can use the Bun plugin directly:

### Preload File

Add to `bunfig.toml`:

```toml
[run]
preload = ["@hypen-space/core/preload"]
```

Or use CLI flag:

```bash
bun --preload @hypen-space/core/preload ./src/main.ts
```

### Manual Plugin Registration

```typescript
import { registerHypenPlugin } from "@hypen-space/core";

registerHypenPlugin({
  debug: true,
  patterns: ["folder", "sibling"],
});
```

### Direct Import

With the plugin registered, you can import `.hypen` files directly:

```typescript
// Auto-bundles Counter.ts + Counter.hypen
import Counter from "./components/Counter.hypen";

// Counter = { module, template, name: "Counter" }
```

## Migration from Manual Build

If you're migrating from the manual `build-components.ts` approach:

### Before (Manual)

```typescript
// build-components.ts runs before dev
// Generates components.generated.ts
import { App, Header, Footer } from "./components.generated.js";

renderWithComponents({ App, Header, Footer }, "App", "#app");
```

### After (Discovery-Based)

```typescript
import { discoverComponents, loadDiscoveredComponents, renderWithComponents } from "@hypen-space/core";

const discovered = await discoverComponents("./src/components");
const componentsMap = await loadDiscoveredComponents(discovered);

const components = Object.fromEntries(componentsMap);
renderWithComponents(components, "App", "#app");
```

## Directory Structure Examples

### Simple App

```
my-app/
├── hypen.json
├── src/
│   └── components/
│       └── App/
│           ├── component.ts
│           └── component.hypen
└── package.json
```

### Full Application

```
my-app/
├── hypen.json
├── src/
│   ├── components/
│   │   ├── App/
│   │   │   ├── component.ts
│   │   │   └── component.hypen
│   │   ├── Header/
│   │   │   ├── component.ts
│   │   │   └── component.hypen
│   │   ├── Footer/
│   │   │   └── component.hypen      # Stateless
│   │   ├── HomePage/
│   │   │   ├── component.ts
│   │   │   └── component.hypen
│   │   └── ProductCard/
│   │       ├── component.ts
│   │       └── component.hypen
│   └── index.html
├── package.json
└── tsconfig.json
```

## Stateless Components

If a component has no state or actions, you can omit the `.ts` file:

```
components/
└── Footer/
    └── component.hypen    # Just the template
```

The tooling will automatically create a stateless module wrapper.

## Debugging

Enable debug mode for verbose logging:

```bash
# CLI
hypen dev --debug

# Environment variable
HYPEN_DEBUG=true bun run dev

# Programmatic
hypen.dev({ debug: true });
discoverComponents("./components", { debug: true });
```

## Best Practices

1. **Use folder-based structure** for components with state/actions
2. **Use stateless pattern** (no `.ts` file) for pure presentational components
3. **Keep templates focused** - split large UIs into smaller components
4. **Leverage discovery** - let the tooling find your components automatically
5. **Use `hypen.json`** for project-wide configuration
